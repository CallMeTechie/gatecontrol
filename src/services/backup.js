'use strict';

const { getDb } = require('../db/connection');
const { decrypt, encrypt } = require('../utils/crypto');
const peersService = require('./peers');
const routesService = require('./routes');
const { validatePeerName, validateDomain, validatePort, validateIp } = require('../utils/validate');
const { validateWebhookUrl } = require('./webhook');
const logger = require('../utils/logger');

const BACKUP_VERSION = 3;

/**
 * Create a full backup as JSON object
 */
function createBackup() {
  const db = getDb();

  // Peer groups
  const rawPeerGroups = db.prepare('SELECT * FROM peer_groups').all();
  const peerGroups = rawPeerGroups.map(g => ({
    name: g.name,
    color: g.color,
    description: g.description,
    created_at: g.created_at,
  }));

  // Peers — export encrypted keys (never plaintext)
  const rawPeers = db.prepare('SELECT * FROM peers').all();
  const peers = rawPeers.map(p => ({
    name: p.name,
    description: p.description,
    public_key: p.public_key,
    private_key_encrypted: p.private_key_encrypted || null,
    preshared_key_encrypted: p.preshared_key_encrypted || null,
    allowed_ips: p.allowed_ips,
    dns: p.dns,
    persistent_keepalive: p.persistent_keepalive,
    enabled: p.enabled,
    tags: p.tags || '',
    expires_at: p.expires_at || null,
    group_name: p.group_id ? (db.prepare('SELECT name FROM peer_groups WHERE id = ?').get(p.group_id)?.name || null) : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));

  // Routes
  const rawRoutes = db.prepare('SELECT * FROM routes').all();
  const routes = rawRoutes.map(r => {
    // Gather ACL peer names for portability
    const aclPeerRows = db.prepare(`
      SELECT p.name FROM route_peer_acl rpa
      JOIN peers p ON p.id = rpa.peer_id
      WHERE rpa.route_id = ?
    `).all(r.id);
    return {
      domain: r.domain,
      target_ip: r.target_ip,
      target_port: r.target_port,
      description: r.description,
      peer_name: r.peer_id ? db.prepare('SELECT name FROM peers WHERE id = ?').get(r.peer_id)?.name || null : null,
      https_enabled: r.https_enabled,
      backend_https: r.backend_https,
      basic_auth_enabled: r.basic_auth_enabled,
      basic_auth_user: r.basic_auth_user,
      basic_auth_password_hash: r.basic_auth_password_hash,
      enabled: r.enabled,
      route_type: r.route_type || 'http',
      l4_protocol: r.l4_protocol,
      l4_listen_port: r.l4_listen_port,
      l4_tls_mode: r.l4_tls_mode,
      acl_enabled: r.acl_enabled || 0,
      compress_enabled: r.compress_enabled || 0,
      acl_peer_names: aclPeerRows.map(p => p.name),
      custom_headers: r.custom_headers || null,
      rate_limit_enabled: r.rate_limit_enabled || 0,
      rate_limit_requests: r.rate_limit_requests || 100,
      rate_limit_window: r.rate_limit_window || '1m',
      retry_enabled: r.retry_enabled || 0,
      retry_count: r.retry_count || 3,
      retry_match_status: r.retry_match_status || '502,503,504',
      backends: r.backends || null,
      sticky_enabled: r.sticky_enabled || 0,
      sticky_cookie_name: r.sticky_cookie_name || 'gc_sticky',
      sticky_cookie_ttl: r.sticky_cookie_ttl || '3600',
      circuit_breaker_enabled: r.circuit_breaker_enabled || 0,
      circuit_breaker_threshold: r.circuit_breaker_threshold || 5,
      circuit_breaker_timeout: r.circuit_breaker_timeout || 30,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  // Settings
  const settings = db.prepare('SELECT key, value FROM settings').all();

  // Webhooks
  const rawWebhooks = db.prepare('SELECT * FROM webhooks').all();
  const webhooks = rawWebhooks.map(w => ({
    url: w.url,
    events: w.events,
    description: w.description,
    enabled: w.enabled,
  }));

  // Route Auth configs
  const rawRouteAuth = db.prepare('SELECT * FROM route_auth').all();
  const routeAuth = rawRouteAuth.map(ra => {
    // Resolve route_id to domain for portability
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
  }).filter(ra => ra.route_domain); // Only include auth for routes that exist

  return {
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    data: {
      peer_groups: peerGroups,
      peers,
      routes,
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
  if (backup.version !== BACKUP_VERSION && backup.version !== 2) {
    errors.push(`Unsupported backup version: ${backup.version} (expected ${BACKUP_VERSION})`);
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

  // Validate peer entries
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

  // Validate route entries
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

  // Validate webhook entries
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
  const d = backup.data;
  return {
    version: backup.version,
    created_at: backup.created_at,
    peer_groups: (d.peer_groups || []).length,
    peers: d.peers.length,
    routes: d.routes.length,
    settings: d.settings.length,
    webhooks: d.webhooks.length,
    route_auth: (d.route_auth || []).length,
  };
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
  const { peer_groups: peerGroups, peers, routes, settings, webhooks, route_auth: routeAuth } = backup.data;

  // Validate that encrypted keys can be decrypted with the current encryption key (#13)
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

  // Run everything in a transaction for atomicity
  const restore = db.transaction(() => {
    // Clear existing data (route_auth, sessions, OTPs cascade via FK on routes)
    db.prepare('DELETE FROM route_peer_acl').run();
    db.prepare('DELETE FROM route_auth_otp').run();
    db.prepare('DELETE FROM route_auth_sessions').run();
    db.prepare('DELETE FROM route_auth').run();
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM peers').run();
    db.prepare('DELETE FROM peer_groups').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM webhooks').run();

    // Restore peer groups
    const groupIdMap = new Map(); // name → new id
    if (Array.isArray(peerGroups) && peerGroups.length > 0) {
      const insertGroup = db.prepare(
        `INSERT INTO peer_groups (name, color, description, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))`
      );
      for (const g of peerGroups) {
        const result = insertGroup.run(g.name, g.color || '#6b7280', g.description || null, g.created_at || null);
        groupIdMap.set(g.name, result.lastInsertRowid);
      }
    }

    // Restore peers
    const insertPeer = db.prepare(`
      INSERT INTO peers (name, description, public_key, private_key_encrypted, preshared_key_encrypted,
                         allowed_ips, dns, persistent_keepalive, enabled, tags, expires_at, group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    `);

    const peerIdMap = new Map(); // name → new id
    for (const p of peers) {
      // Support both encrypted (v2+) and legacy plaintext backups
      const privKeyEnc = p.private_key_encrypted || (p.private_key ? encrypt(p.private_key) : null);
      const pskEnc = p.preshared_key_encrypted || (p.preshared_key ? encrypt(p.preshared_key) : null);
      const groupId = p.group_name ? (groupIdMap.get(p.group_name) || null) : null;
      const result = insertPeer.run(
        p.name,
        p.description || null,
        p.public_key,
        privKeyEnc,
        pskEnc,
        p.allowed_ips,
        p.dns || null,
        p.persistent_keepalive || 25,
        p.enabled !== undefined ? (p.enabled ? 1 : 0) : 1,
        p.tags || '',
        p.expires_at || null,
        groupId,
        p.created_at || null,
        p.updated_at || null,
      );
      peerIdMap.set(p.name, result.lastInsertRowid);
    }

    // Restore routes — resolve peer_name back to peer_id
    const insertRoute = db.prepare(`
      INSERT INTO routes (domain, target_ip, target_port, description, peer_id,
                          https_enabled, backend_https, basic_auth_enabled,
                          basic_auth_user, basic_auth_password_hash, enabled,
                          route_type, l4_protocol, l4_listen_port, l4_tls_mode,
                          acl_enabled, compress_enabled,
                          custom_headers, rate_limit_enabled, rate_limit_requests, rate_limit_window,
                          retry_enabled, retry_count, retry_match_status,
                          backends, sticky_enabled, sticky_cookie_name, sticky_cookie_ttl,
                          circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout, circuit_breaker_status,
                          created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed', COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    `);

    const insertAcl = db.prepare('INSERT OR IGNORE INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)');

    for (const r of routes) {
      const peerId = r.peer_name ? (peerIdMap.get(r.peer_name) || null) : null;
      const result = insertRoute.run(
        r.domain,
        r.target_ip || null,
        r.target_port || null,
        r.description || null,
        peerId,
        r.https_enabled ? 1 : 0,
        r.backend_https ? 1 : 0,
        r.basic_auth_enabled ? 1 : 0,
        r.basic_auth_user || null,
        r.basic_auth_password_hash || null,
        r.enabled !== undefined ? (r.enabled ? 1 : 0) : 1,
        r.route_type || 'http',
        r.l4_protocol || null,
        r.l4_listen_port || null,
        r.l4_tls_mode || null,
        r.acl_enabled ? 1 : 0,
        r.compress_enabled ? 1 : 0,
        r.custom_headers || null,
        r.rate_limit_enabled ? 1 : 0,
        r.rate_limit_requests || 100,
        r.rate_limit_window || '1m',
        r.retry_enabled ? 1 : 0,
        r.retry_count || 3,
        r.retry_match_status || '502,503,504',
        r.backends || null,
        r.sticky_enabled ? 1 : 0,
        r.sticky_cookie_name || 'gc_sticky',
        r.sticky_cookie_ttl || '3600',
        r.circuit_breaker_enabled ? 1 : 0,
        r.circuit_breaker_threshold || 5,
        r.circuit_breaker_timeout || 30,
        r.created_at || null,
        r.updated_at || null,
      );
      // Restore ACL peer associations
      if (Array.isArray(r.acl_peer_names) && r.acl_peer_names.length > 0) {
        const routeId = result.lastInsertRowid;
        for (const peerName of r.acl_peer_names) {
          const aclPeerId = peerIdMap.get(peerName);
          if (aclPeerId) insertAcl.run(routeId, aclPeerId);
        }
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

    // Restore route auth configs (#12) — resolve domain back to route_id
    if (Array.isArray(routeAuth) && routeAuth.length > 0) {
      const insertRouteAuth = db.prepare(`
        INSERT INTO route_auth (route_id, auth_type, email, password_hash, totp_secret_encrypted,
                                two_factor_enabled, two_factor_method, session_max_age)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ra of routeAuth) {
        if (!ra.route_domain) continue;
        const route = db.prepare('SELECT id FROM routes WHERE domain = ?').get(ra.route_domain);
        if (!route) continue;
        insertRouteAuth.run(
          route.id,
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
    settings: settings.length,
    webhooks: webhooks.length,
  }, 'Backup restored');

  // Rebuild WireGuard config from restored peers
  await peersService.rewriteWgConfig();

  // Sync routes to Caddy
  try {
    await routesService.syncToCaddy();
  } catch (err) {
    logger.warn({ error: err.message }, 'Could not sync routes to Caddy after restore (will retry on next change)');
  }

  return {
    peer_groups: (peerGroups || []).length,
    peers: peers.length,
    routes: routes.length,
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
