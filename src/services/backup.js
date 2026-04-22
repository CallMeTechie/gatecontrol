'use strict';

const { getDb } = require('../db/connection');
const { decrypt, encrypt } = require('../utils/crypto');
const peersService = require('./peers');
const routesService = require('./routes');
const { validatePeerName, validateDomain, validatePort, validateIp } = require('../utils/validate');
const { validateWebhookUrl } = require('./webhook');
const logger = require('../utils/logger');

const BACKUP_VERSION = 4;

// Tables intentionally skipped in backup: they are ephemeral (sessions,
// activity_log, login_attempts, traffic_snapshots, peer_traffic_snapshots,
// rdp_sessions, route_auth_sessions, route_auth_otp) or derived
// (migration_history). Everything else is exported so a restore can
// rebuild a working system without silent data loss.

// Return every column name of a table, preserving declaration order.
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

// Dynamic row copy: pick only known columns from a source row, coerce
// undefined to null for positional binds.
function pickColumns(row, cols) {
  const out = {};
  for (const c of cols) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

/**
 * Create a full backup as JSON object
 */
function createBackup() {
  const db = getDb();

  // ── peer_groups ─────────────────────────────────────────────
  const rawPeerGroups = db.prepare('SELECT * FROM peer_groups').all();
  const peerGroups = rawPeerGroups.map(g => ({
    name: g.name,
    color: g.color,
    description: g.description,
    created_at: g.created_at,
  }));

  // ── peers (all columns; resolve group_id → group_name) ──────
  const peerCols = columnsOf(db, 'peers');
  const rawPeers = db.prepare('SELECT * FROM peers').all();
  const peers = rawPeers.map(p => {
    const entry = pickColumns(p, peerCols);
    entry.group_name = p.group_id
      ? (db.prepare('SELECT name FROM peer_groups WHERE id = ?').get(p.group_id)?.name || null)
      : null;
    delete entry.id;
    delete entry.group_id;
    return entry;
  });

  // ── routes (all columns; resolve peer_id/target_peer_id → names, ACLs) ─
  const routeCols = columnsOf(db, 'routes');
  const rawRoutes = db.prepare('SELECT * FROM routes').all();
  const peerNameById = new Map(rawPeers.map(p => [p.id, p.name]));
  const routes = rawRoutes.map(r => {
    const entry = pickColumns(r, routeCols);
    entry.peer_name = r.peer_id ? (peerNameById.get(r.peer_id) || null) : null;
    entry.target_peer_name = r.target_peer_id ? (peerNameById.get(r.target_peer_id) || null) : null;
    const aclPeerRows = db.prepare(`
      SELECT p.name FROM route_peer_acl rpa
      JOIN peers p ON p.id = rpa.peer_id
      WHERE rpa.route_id = ?
    `).all(r.id);
    entry.acl_peer_names = aclPeerRows.map(p => p.name);
    delete entry.id;
    delete entry.peer_id;
    delete entry.target_peer_id;
    // Runtime-only state (rebuilt by monitor / circuit breaker)
    delete entry.circuit_breaker_status;
    delete entry.cb_failure_count;
    delete entry.cb_opened_at;
    return entry;
  });

  // ── rdp_routes (optional feature table) ─────────────────────
  let rdpRoutes = [];
  try {
    const rdpCols = columnsOf(db, 'rdp_routes');
    if (rdpCols.length > 0) {
      const rawRdp = db.prepare('SELECT * FROM rdp_routes').all();
      rdpRoutes = rawRdp.map(rr => {
        const entry = pickColumns(rr, rdpCols);
        entry.gateway_peer_name = rr.gateway_peer_id ? (peerNameById.get(rr.gateway_peer_id) || null) : null;
        delete entry.id;
        delete entry.gateway_peer_id;
        // L4-link is re-created by the service layer on sync — don't persist the fk
        delete entry.gateway_l4_route_id;
        return entry;
      });
    }
  } catch { /* table may not exist in very old DBs */ }

  // ── users ───────────────────────────────────────────────────
  let users = [];
  try {
    const userCols = columnsOf(db, 'users');
    const rawUsers = db.prepare('SELECT * FROM users').all();
    users = rawUsers.map(u => {
      const entry = pickColumns(u, userCols);
      delete entry.id;
      return entry;
    });
  } catch {}

  // ── api_tokens (resolve peer_id/user_id via names) ──────────
  let apiTokens = [];
  try {
    const tokenCols = columnsOf(db, 'api_tokens');
    const rawTokens = db.prepare('SELECT * FROM api_tokens').all();
    const userNameById = new Map((users.length ? db.prepare('SELECT id, username FROM users').all() : []).map(u => [u.id, u.username]));
    apiTokens = rawTokens.map(t => {
      const entry = pickColumns(t, tokenCols);
      entry.peer_name = t.peer_id ? (peerNameById.get(t.peer_id) || null) : null;
      entry.user_name = t.user_id ? (userNameById.get(t.user_id) || null) : null;
      delete entry.id;
      delete entry.peer_id;
      delete entry.user_id;
      return entry;
    });
  } catch {}

  // ── tags registry ───────────────────────────────────────────
  let tags = [];
  try {
    const tagCols = columnsOf(db, 'tags');
    const rawTags = db.prepare('SELECT * FROM tags').all();
    tags = rawTags.map(t => { const e = pickColumns(t, tagCols); delete e.id; return e; });
  } catch {}

  // ── gateway_meta (resolve peer_id → peer_name) ──────────────
  let gatewayMeta = [];
  try {
    const gmCols = columnsOf(db, 'gateway_meta');
    const rawGm = db.prepare('SELECT * FROM gateway_meta').all();
    gatewayMeta = rawGm.map(g => {
      const entry = pickColumns(g, gmCols);
      entry.peer_name = peerNameById.get(g.peer_id) || null;
      delete entry.peer_id;
      return entry;
    });
  } catch {}

  // ── settings / webhooks / route_auth (unchanged) ────────────
  const settings = db.prepare('SELECT key, value FROM settings').all();

  const rawWebhooks = db.prepare('SELECT * FROM webhooks').all();
  const webhooks = rawWebhooks.map(w => ({
    url: w.url,
    events: w.events,
    description: w.description,
    enabled: w.enabled,
  }));

  const rawRouteAuth = db.prepare('SELECT * FROM route_auth').all();
  const routeAuth = rawRouteAuth.map(ra => {
    const route = db.prepare('SELECT domain FROM routes WHERE id = ?').get(ra.route_id);
    return {
      route_domain: route ? route.domain : null,
      auth_type: ra.auth_type,
      email: ra.email,
      password_hash: ra.password_hash,
      totp_secret_encrypted: ra.totp_secret_encrypted || null,
      two_factor_enabled: ra.two_factor_enabled,
      two_factor_method: ra.two_factor_method,
      session_max_age: ra.session_max_age,
      created_at: ra.created_at,
      updated_at: ra.updated_at,
    };
  }).filter(ra => ra.route_domain);

  return {
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    data: {
      peer_groups: peerGroups,
      peers,
      routes,
      rdp_routes: rdpRoutes,
      users,
      api_tokens: apiTokens,
      tags,
      gateway_meta: gatewayMeta,
      settings,
      webhooks,
      route_auth: routeAuth,
    },
  };
}

/**
 * Validate backup data structure
 */
function validateBackup(backup) {
  const errors = [];

  if (!backup || typeof backup !== 'object') {
    return ['Invalid backup: not a JSON object'];
  }
  if (![2, 3, 4].includes(backup.version)) {
    errors.push(`Unsupported backup version: ${backup.version} (expected 2, 3, or ${BACKUP_VERSION})`);
  }
  if (!backup.data || typeof backup.data !== 'object') {
    errors.push('Invalid backup: missing data section');
  }
  if (errors.length > 0) return errors;

  const { peers, routes, settings, webhooks } = backup.data;

  if (!Array.isArray(peers)) errors.push('Invalid backup: peers must be an array');
  if (!Array.isArray(routes)) errors.push('Invalid backup: routes must be an array');
  if (!Array.isArray(settings)) errors.push('Invalid backup: settings must be an array');
  if (!Array.isArray(webhooks)) errors.push('Invalid backup: webhooks must be an array');

  if (errors.length > 0) return errors;

  for (let i = 0; i < peers.length; i++) {
    const p = peers[i];
    if (!p.name) errors.push(`Peer #${i + 1}: missing name`);
    else {
      const nameErr = validatePeerName(p.name);
      if (nameErr) errors.push(`Peer #${i + 1}: ${nameErr}`);
    }
    if (!p.public_key) errors.push(`Peer #${i + 1}: missing public_key`);
    if (!p.allowed_ips) errors.push(`Peer #${i + 1}: missing allowed_ips`);
  }

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (!r.domain && r.route_type !== 'l4') {
      errors.push(`Route #${i + 1}: missing domain`);
    } else if (r.domain) {
      const domErr = validateDomain(r.domain);
      if (domErr) errors.push(`Route #${i + 1}: ${domErr}`);
    }
    if (r.target_port) {
      const portErr = validatePort(r.target_port);
      if (portErr) errors.push(`Route #${i + 1}: ${portErr}`);
    }
    if (r.target_ip) {
      const ipErr = validateIp(r.target_ip);
      if (ipErr) errors.push(`Route #${i + 1}: ${ipErr}`);
    }
  }

  if (webhooks) {
    for (let i = 0; i < webhooks.length; i++) {
      const w = webhooks[i];
      if (w.url) {
        try { validateWebhookUrl(w.url); } catch (e) {
          errors.push(`Webhook #${i + 1}: ${e.message}`);
        }
      }
    }
  }

  return errors;
}

/**
 * Get summary of backup contents
 */
function getBackupSummary(backup) {
  const d = backup.data || {};
  return {
    version: backup.version,
    created_at: backup.created_at,
    peer_groups: (d.peer_groups || []).length,
    peers: (d.peers || []).length,
    routes: (d.routes || []).length,
    rdp_routes: (d.rdp_routes || []).length,
    users: (d.users || []).length,
    api_tokens: (d.api_tokens || []).length,
    tags: (d.tags || []).length,
    gateway_meta: (d.gateway_meta || []).length,
    settings: (d.settings || []).length,
    webhooks: (d.webhooks || []).length,
    route_auth: (d.route_auth || []).length,
  };
}

// Verify every encrypted field in settings/route_auth/rdp_routes can be
// decrypted under the current GC_ENCRYPTION_KEY. Without this check, a
// restore from a mismatched backup would leave silent-null credentials
// that only surface when SMTP/TOTP/RDP actually gets exercised.
const ENCRYPTED_SETTINGS_KEYS = new Set([
  'smtp_password_encrypted',
  'license_signing_key_encrypted',
]);

function validateEncryptedFields(data) {
  const errors = [];
  const settings = data.settings || [];
  for (const s of settings) {
    if (!ENCRYPTED_SETTINGS_KEYS.has(s.key) || !s.value) continue;
    try { decrypt(s.value); }
    catch { errors.push(`Setting "${s.key}": cannot decrypt — backup was created with a different GC_ENCRYPTION_KEY`); }
  }
  const ra = data.route_auth || [];
  for (let i = 0; i < ra.length; i++) {
    if (!ra[i].totp_secret_encrypted) continue;
    try { decrypt(ra[i].totp_secret_encrypted); }
    catch { errors.push(`route_auth #${i + 1}: cannot decrypt totp secret`); }
  }
  const rdp = data.rdp_routes || [];
  for (let i = 0; i < rdp.length; i++) {
    for (const key of ['username_encrypted', 'password_encrypted']) {
      if (!rdp[i][key]) continue;
      try { decrypt(rdp[i][key]); }
      catch { errors.push(`rdp_routes #${i + 1} ${key}: cannot decrypt`); }
    }
  }
  return errors;
}

// Helper: dynamically build INSERT for dynamic-column tables. Skips the
// `id` primary key so SQLite assigns fresh ids and returns the row's new
// rowid so we can rebuild FK maps.
function dynamicInsert(db, table, excludeCols, row) {
  const cols = columnsOf(db, table).filter(c => c !== 'id' && !excludeCols.includes(c));
  const values = cols.map(c => (row[c] === undefined ? null : row[c]));
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return db.prepare(sql).run(...values);
}

/**
 * Restore from backup data — replaces all existing data
 */
async function restoreBackup(backup) {
  const errors = validateBackup(backup);
  if (errors.length > 0) {
    throw new Error('Backup validation failed:\n  - ' + errors.join('\n  - '));
  }

  const db = getDb();
  const {
    peer_groups: peerGroups,
    peers,
    routes,
    rdp_routes: rdpRoutes = [],
    users = [],
    api_tokens: apiTokens = [],
    tags = [],
    gateway_meta: gatewayMeta = [],
    settings,
    webhooks,
    route_auth: routeAuth,
  } = backup.data;

  // Decrypt-check for all encrypted fields, not just peer keys
  for (let i = 0; i < peers.length; i++) {
    const p = peers[i];
    if (p.private_key_encrypted) {
      try { decrypt(p.private_key_encrypted); } catch {
        throw new Error(`Peer "${p.name}": cannot decrypt private key — the backup was created with a different GC_ENCRYPTION_KEY`);
      }
    }
    if (p.preshared_key_encrypted) {
      try { decrypt(p.preshared_key_encrypted); } catch {
        throw new Error(`Peer "${p.name}": cannot decrypt preshared key — the backup was created with a different GC_ENCRYPTION_KEY`);
      }
    }
  }
  const encErrors = validateEncryptedFields(backup.data);
  if (encErrors.length > 0) {
    throw new Error('Backup validation failed:\n  - ' + encErrors.join('\n  - '));
  }

  const restore = db.transaction(() => {
    // Clear existing data in dependency order
    db.prepare('DELETE FROM route_peer_acl').run();
    db.prepare('DELETE FROM route_auth_otp').run();
    db.prepare('DELETE FROM route_auth_sessions').run();
    db.prepare('DELETE FROM route_auth').run();
    try { db.prepare('DELETE FROM rdp_sessions').run(); } catch {}
    try { db.prepare('DELETE FROM rdp_routes').run(); } catch {}
    try { db.prepare('DELETE FROM api_tokens').run(); } catch {}
    try { db.prepare('DELETE FROM gateway_meta').run(); } catch {}
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM peers').run();
    db.prepare('DELETE FROM peer_groups').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM webhooks').run();
    try { db.prepare('DELETE FROM tags').run(); } catch {}
    // users: keep the admin if no users in backup so the operator
    // never locks themselves out. If the backup DOES include users,
    // replace the full set.
    if (Array.isArray(users) && users.length > 0) {
      try { db.prepare('DELETE FROM users').run(); } catch {}
    }

    // Restore peer_groups
    const groupIdMap = new Map();
    if (Array.isArray(peerGroups) && peerGroups.length > 0) {
      const insertGroup = db.prepare(
        `INSERT INTO peer_groups (name, color, description, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))`
      );
      for (const g of peerGroups) {
        const result = insertGroup.run(g.name, g.color || '#6b7280', g.description || null, g.created_at || null);
        groupIdMap.set(g.name, result.lastInsertRowid);
      }
    }

    // Restore peers (dynamic columns)
    const peerIdMap = new Map();
    for (const p of peers) {
      const row = { ...p };
      // legacy plaintext-key backups
      if (!row.private_key_encrypted && p.private_key) row.private_key_encrypted = encrypt(p.private_key);
      if (!row.preshared_key_encrypted && p.preshared_key) row.preshared_key_encrypted = encrypt(p.preshared_key);
      row.group_id = p.group_name ? (groupIdMap.get(p.group_name) || null) : null;
      if (row.enabled === undefined) row.enabled = 1;
      const result = dynamicInsert(db, 'peers', ['group_name', 'private_key', 'preshared_key'], row);
      peerIdMap.set(p.name, result.lastInsertRowid);
    }

    // Restore users
    if (Array.isArray(users) && users.length > 0) {
      for (const u of users) {
        if (!u.username || !u.password_hash) continue;
        dynamicInsert(db, 'users', [], u);
      }
    }
    const userIdByName = new Map(
      (function () {
        try { return db.prepare('SELECT id, username FROM users').all().map(u => [u.username, u.id]); }
        catch { return []; }
      })()
    );

    // Restore tags registry
    for (const t of tags) {
      if (!t.name) continue;
      try { dynamicInsert(db, 'tags', [], t); } catch (e) { logger.warn({ err: e.message, tag: t.name }, 'tag restore skipped'); }
    }

    // Restore routes (dynamic columns), re-mapping peer_id/target_peer_id
    const routeIdByDomain = new Map();
    const insertAcl = db.prepare('INSERT OR IGNORE INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)');
    for (const r of routes) {
      const row = { ...r };
      row.peer_id = r.peer_name ? (peerIdMap.get(r.peer_name) || null) : null;
      row.target_peer_id = r.target_peer_name ? (peerIdMap.get(r.target_peer_name) || null) : null;
      if (row.enabled === undefined) row.enabled = 1;
      row.circuit_breaker_status = 'closed';
      const excluded = ['peer_name', 'target_peer_name', 'acl_peer_names'];
      const result = dynamicInsert(db, 'routes', excluded, row);
      if (r.domain) routeIdByDomain.set(r.domain, result.lastInsertRowid);
      if (Array.isArray(r.acl_peer_names)) {
        for (const peerName of r.acl_peer_names) {
          const aclPeerId = peerIdMap.get(peerName);
          if (aclPeerId) insertAcl.run(result.lastInsertRowid, aclPeerId);
        }
      }
    }

    // Restore rdp_routes (re-map gateway_peer_id)
    for (const rr of rdpRoutes) {
      try {
        const row = { ...rr };
        row.gateway_peer_id = rr.gateway_peer_name ? (peerIdMap.get(rr.gateway_peer_name) || null) : null;
        dynamicInsert(db, 'rdp_routes', ['gateway_peer_name'], row);
      } catch (e) {
        logger.warn({ err: e.message, name: rr.name }, 'rdp_route restore skipped');
      }
    }

    // Restore api_tokens (re-map peer_id, user_id)
    for (const t of apiTokens) {
      try {
        const row = { ...t };
        row.peer_id = t.peer_name ? (peerIdMap.get(t.peer_name) || null) : null;
        row.user_id = t.user_name ? (userIdByName.get(t.user_name) || null) : null;
        dynamicInsert(db, 'api_tokens', ['peer_name', 'user_name'], row);
      } catch (e) {
        logger.warn({ err: e.message, name: t.name }, 'api_token restore skipped');
      }
    }

    // Restore gateway_meta (re-map peer_id)
    for (const gm of gatewayMeta) {
      try {
        const pid = gm.peer_name ? peerIdMap.get(gm.peer_name) : null;
        if (!pid) continue;
        const row = { ...gm, peer_id: pid };
        dynamicInsert(db, 'gateway_meta', ['peer_name'], row);
      } catch (e) {
        logger.warn({ err: e.message, peer: gm.peer_name }, 'gateway_meta restore skipped');
      }
    }

    // Restore settings
    const SAFE_KEY_RE = /^[a-zA-Z0-9_.\-]+$/;
    const insertSetting = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    for (const s of settings) {
      if (!s.key || !SAFE_KEY_RE.test(s.key)) {
        logger.warn({ key: s.key }, 'Skipping invalid settings key during restore');
        continue;
      }
      insertSetting.run(s.key, s.value);
    }

    // Restore webhooks
    const insertWebhook = db.prepare(`
      INSERT INTO webhooks (url, events, description, enabled)
      VALUES (?, ?, ?, ?)
    `);
    for (const w of webhooks) {
      insertWebhook.run(
        w.url,
        w.events || '*',
        w.description || null,
        w.enabled !== undefined ? (w.enabled ? 1 : 0) : 1,
      );
    }

    // Restore route_auth configs — resolve domain back to route_id
    if (Array.isArray(routeAuth) && routeAuth.length > 0) {
      const insertRouteAuth = db.prepare(`
        INSERT INTO route_auth (route_id, auth_type, email, password_hash, totp_secret_encrypted,
                                two_factor_enabled, two_factor_method, session_max_age)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ra of routeAuth) {
        if (!ra.route_domain) continue;
        const routeId = routeIdByDomain.get(ra.route_domain);
        if (!routeId) continue;
        insertRouteAuth.run(
          routeId,
          ra.auth_type || 'password',
          ra.email || null,
          ra.password_hash || null,
          ra.totp_secret_encrypted || null,
          ra.two_factor_enabled ? 1 : 0,
          ra.two_factor_method || null,
          ra.session_max_age !== undefined ? ra.session_max_age : 86400000,
        );
      }
    }
  });

  restore();

  logger.info({
    peer_groups: (peerGroups || []).length,
    peers: peers.length,
    routes: routes.length,
    rdp_routes: rdpRoutes.length,
    users: users.length,
    api_tokens: apiTokens.length,
    tags: tags.length,
    gateway_meta: gatewayMeta.length,
    settings: settings.length,
    webhooks: webhooks.length,
  }, 'Backup restored');

  await peersService.rewriteWgConfig();

  try {
    peersService.markHostnamesStale();
  } catch (err) {
    logger.warn({ error: err.message }, 'Could not mark hostnames stale after restore');
  }

  try {
    await routesService.syncToCaddy();
  } catch (err) {
    logger.warn({ error: err.message }, 'Could not sync routes to Caddy after restore (will retry on next change)');
  }

  return {
    peer_groups: (peerGroups || []).length,
    peers: peers.length,
    routes: routes.length,
    rdp_routes: rdpRoutes.length,
    users: users.length,
    api_tokens: apiTokens.length,
    tags: tags.length,
    gateway_meta: gatewayMeta.length,
    settings: settings.length,
    webhooks: webhooks.length,
  };
}

module.exports = {
  createBackup,
  validateBackup,
  getBackupSummary,
  restoreBackup,
  BACKUP_VERSION,
};
