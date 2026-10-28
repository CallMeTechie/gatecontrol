'use strict';

const { getDb } = require('../db/connection');
const { decrypt, encrypt } = require('../utils/crypto');
const peersService = require('./peers');
const routesService = require('./routes');
const { validatePeerName, validateDomain, validatePort, validateIp } = require('../utils/validate');
const { validateWebhookUrl } = require('./webhook');
const logger = require('../utils/logger');

// 5: + data.plugins (docs/plugins.md "Backup") and data.builtin_integrations
// (tables of the former built-in Smart Home / Klimaanlage / Fahrzeuge,
// services/builtinBackup.js); 2–4 still restore (no plugin data).
const BACKUP_VERSION = 5;
const SUPPORTED_VERSIONS = [2, 3, 4, 5];
// Settings never taken from a backup: the "unsigned plugins" switch needs a
// typed confirmation on this server (a restore must not turn it on).
const RESTORE_SKIP_SETTINGS = new Set(['plugins.allow_unsigned']);

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
    // Groups released for the route (route_group_acl); group ids are kept.
    try {
      entry.group_refs = db.prepare('SELECT group_id FROM route_group_acl WHERE route_id = ? ORDER BY group_id').all(r.id).map(g => g.group_id);
    } catch { entry.group_refs = []; }
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

  // ── service_bundles (optional feature table) ────────────────
  // bundle_ref keeps the original id so routes' bundle_id can be
  // re-mapped on restore (route rows themselves are exported id-less).
  let serviceBundles = [];
  try {
    const sbCols = columnsOf(db, 'service_bundles');
    if (sbCols.length > 0) {
      serviceBundles = db.prepare('SELECT * FROM service_bundles').all().map(sb => {
        const entry = pickColumns(sb, sbCols);
        entry.bundle_ref = sb.id;
        delete entry.id;
        return entry;
      });
    }
  } catch { /* table may not exist in pre-v50 DBs */ }

  // ── users ───────────────────────────────────────────────────
  let users = [];
  try {
    const userCols = columnsOf(db, 'users');
    const rawUsers = db.prepare('SELECT * FROM users').all();
    users = rawUsers.map(u => {
      const entry = pickColumns(u, userCols);
      // user_ref: the id is restored as it was, so user ids stored elsewhere
      // (routes/rdp_routes.user_ids, plugin data) keep pointing at the person.
      entry.user_ref = u.id;
      delete entry.id;
      return entry;
    });
  } catch (err) { logger.warn({ err: err.message }, 'backup export: users skipped'); }

  // ── user_avatars (profile pictures, docs/feature-avatars.md) ─
  // Owner by username, the picture as base64; avatar_id is kept so the
  // picture URLs stay the same after a restore.
  let userAvatars = [];
  try {
    userAvatars = db.prepare(`SELECT u.username AS user_name, a.avatar_id, a.mime, a.data, a.updated_at
      FROM user_avatars a JOIN users u ON u.id = a.user_id ORDER BY a.user_id`).all()
      .map(a => ({ user_name: a.user_name, avatar_id: a.avatar_id, mime: a.mime, data: Buffer.from(a.data).toString('base64'), updated_at: a.updated_at }));
  } catch (err) { logger.warn({ err: err.message }, 'backup export: user_avatars skipped'); }

  // ── person groups (docs/groups.md) ──────────────────────────
  // Group ids are kept (group_ref) — rdp_routes.group_ids, route group_refs
  // and plugin data refer to them. Members and invitation creators by
  // username; invitations as their SHA-256 hashes only.
  const groupsData = exportGroups(db);

  // ── directory sync (docs/groups.md "Verzeichnis-Abgleich") ──
  // Connections with their id (groups' source 'directory:<id>' names it)
  // and the secret exactly as stored (encrypted with GC_ENCRYPTION_KEY);
  // links and conflicts with user_ref + username. The run log is not
  // exported.
  const directoryData = exportDirectories(db, peerNameById);

  // ── storage targets (docs/storage-targets.md) ──
  // With their id (plugin media areas name it) and the secret exactly as
  // stored; an SMB target through a peer / L4 route names it by peer name /
  // route domain (both get new ids on restore). The files on a target are
  // never part of the backup.
  const storageTargets = exportStorageTargets(db, peerNameById);

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
  } catch (err) { logger.warn({ err: err.message }, 'backup export: api_tokens skipped'); }

  // ── tags registry ───────────────────────────────────────────
  let tags = [];
  try {
    const tagCols = columnsOf(db, 'tags');
    const rawTags = db.prepare('SELECT * FROM tags').all();
    tags = rawTags.map(t => { const e = pickColumns(t, tagCols); delete e.id; return e; });
  } catch (err) { logger.warn({ err: err.message }, 'backup export: tags skipped'); }

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
  } catch (err) { logger.warn({ err: err.message }, 'backup export: gateway_meta skipped'); }

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
      app_login: ra.app_login ? 1 : 0,
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
      service_bundles: serviceBundles,
      users,
      user_avatars: userAvatars,
      groups: groupsData.groups,
      group_members: groupsData.members,
      group_invites: groupsData.invites,
      directories: directoryData.directories,
      directory_links: directoryData.links,
      directory_conflicts: directoryData.conflicts,
      storage_targets: storageTargets,
      api_tokens: apiTokens,
      tags,
      gateway_meta: gatewayMeta,
      settings,
      webhooks,
      route_auth: routeAuth,
      plugins: exportPlugins(),
      builtin_integrations: exportBuiltin(db),
    },
  };
}

function exportGroups(db) {
  const out = { groups: [], members: [], invites: [] };
  try {
    const userName = new Map(db.prepare('SELECT id, username FROM users').all().map(u => [u.id, u.username]));
    const gCols = columnsOf(db, 'groups');
    out.groups = db.prepare('SELECT * FROM groups ORDER BY id').all().map(g => {
      const e = pickColumns(g, gCols);
      e.group_ref = g.id;
      e.parent_ref = g.parent_id == null ? null : g.parent_id;
      delete e.id;
      delete e.parent_id;
      return e;
    });
    out.members = db.prepare('SELECT * FROM group_members ORDER BY group_id, user_id').all().map(m => ({
      group_ref: m.group_id, user_name: userName.get(m.user_id) || null, role: m.role, source: m.source,
      added_by_name: m.added_by != null ? (userName.get(m.added_by) || null) : null, added_at: m.added_at,
    })).filter(m => m.user_name);
    out.invites = db.prepare('SELECT * FROM group_invites ORDER BY created_at').all().map(i => ({
      token_hash: i.token_hash, group_ref: i.group_id, role: i.role,
      created_by_name: i.created_by != null ? (userName.get(i.created_by) || null) : null,
      created_at: i.created_at, expires_at: i.expires_at, max_uses: i.max_uses, uses: i.uses,
    }));
  } catch (err) { logger.warn({ err: err.message }, 'backup export: groups skipped'); }
  return out;
}

/**
 * Restore person groups (inside the restore transaction): group ids as they
 * were, parents before children; members / invitation creators by username.
 * Returns the set of restored group ids.
 */
function restoreGroups(db, { groups, members, invites }, userIdByName) {
  // Leaves first (parent_id is ON DELETE RESTRICT); members, invitations and
  // route_group_acl go with their group (FK cascade).
  try {
    const delLeaves = db.prepare('DELETE FROM groups WHERE id NOT IN (SELECT parent_id FROM groups WHERE parent_id IS NOT NULL)');
    for (let i = 0; i < 10 && delLeaves.run().changes > 0; i++) { /* next level */ }
  } catch (err) { logger.warn({ err: err.message }, 'backup restore: clearing groups failed'); return new Set(); }
  const restored = new Set();
  const pending = (groups || []).filter(g => g && Number.isSafeInteger(g.group_ref) && g.group_ref > 0 && g.name && g.kind);
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const g = pending[i];
      const parent = g.parent_ref == null ? null : g.parent_ref;
      if (parent != null && !restored.has(parent) && pending.some(p => p.group_ref === parent)) continue;
      pending.splice(i--, 1);
      progress = true;
      try {
        const row = { ...g, parent_id: parent != null && restored.has(parent) ? parent : null };
        const cols = columnsOf(db, 'groups').filter(c => c !== 'id');
        db.prepare(`INSERT INTO groups (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
          .run(g.group_ref, ...cols.map(c => (row[c] === undefined ? null : row[c])));
        restored.add(g.group_ref);
      } catch (e) { logger.warn({ err: e.message, group: g.name }, 'group restore skipped'); }
    }
  }
  const insMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, source, added_by, added_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime(\'now\')))');
  for (const m of members || []) {
    const uid = m && userIdByName.get(m.user_name);
    if (!uid || !restored.has(m.group_ref)) continue;
    try {
      insMember.run(m.group_ref, uid, m.role || 'member', m.source || 'local',
        m.added_by_name ? (userIdByName.get(m.added_by_name) || null) : null, m.added_at || null);
    } catch (e) { logger.warn({ err: e.message }, 'group member restore skipped'); }
  }
  const insInvite = db.prepare(`INSERT OR IGNORE INTO group_invites (token_hash, group_id, role, created_by, created_at, expires_at, max_uses, uses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const i of invites || []) {
    if (!i || typeof i.token_hash !== 'string' || !/^[0-9a-f]{64}$/.test(i.token_hash) || !restored.has(i.group_ref)) continue;
    try {
      insInvite.run(i.token_hash, i.group_ref, i.role || 'member', i.created_by_name ? (userIdByName.get(i.created_by_name) || null) : null,
        i.created_at || new Date().toISOString(), i.expires_at || new Date().toISOString(), i.max_uses == null ? null : i.max_uses, i.uses || 0);
    } catch (e) { logger.warn({ err: e.message }, 'group invite restore skipped'); }
  }
  return restored;
}

function exportDirectories(db, peerNameById) {
  const out = { directories: [], links: [], conflicts: [] };
  try {
    if (!columnsOf(db, 'directories').length) return out;
    const userName = new Map(db.prepare('SELECT id, username FROM users').all().map(u => [u.id, u.username]));
    const dCols = columnsOf(db, 'directories');
    out.directories = db.prepare('SELECT * FROM directories ORDER BY id').all().map(d => {
      const e = pickColumns(d, dCols);
      e.directory_ref = d.id;
      delete e.id;
      return e;
    });
    const lCols = columnsOf(db, 'directory_links');
    out.links = db.prepare('SELECT * FROM directory_links ORDER BY user_id').all().map(l => {
      const e = pickColumns(l, lCols);
      e.user_ref = l.user_id;
      e.user_name = userName.get(l.user_id) || null;
      e.directory_ref = l.directory_id;
      // the peers the sync disabled, by name (peers get new ids on restore)
      let peerIds = [];
      try { peerIds = JSON.parse(l.disabled_peer_ids || '[]'); } catch { peerIds = []; }
      e.disabled_peer_names = Array.isArray(peerIds) ? peerIds.map(id => peerNameById.get(Number(id))).filter(Boolean) : [];
      delete e.user_id;
      delete e.directory_id;
      delete e.disabled_peer_ids;
      return e;
    }).filter(l => l.user_name);
    const cCols = columnsOf(db, 'directory_conflicts');
    out.conflicts = db.prepare('SELECT * FROM directory_conflicts ORDER BY id').all().map(c => {
      const e = pickColumns(c, cCols);
      e.directory_ref = c.directory_id;
      e.user_ref = c.user_id == null ? null : c.user_id;
      e.user_name = c.user_id == null ? null : (userName.get(c.user_id) || null);
      e.resolved_by_name = c.resolved_by == null ? null : (userName.get(c.resolved_by) || null);
      delete e.id;
      delete e.directory_id;
      delete e.user_id;
      delete e.resolved_by;
      return e;
    });
  } catch (err) { logger.warn({ err: err.message }, 'backup export: directories skipped'); }
  return out;
}

function exportStorageTargets(db, peerNameById) {
  try {
    if (!columnsOf(db, 'storage_targets').length) return [];
    const routeDomain = new Map(db.prepare('SELECT id, domain FROM routes').all().map(r => [r.id, r.domain]));
    return db.prepare('SELECT * FROM storage_targets ORDER BY id').all().map(t => {
      let config = {};
      try { config = JSON.parse(t.config_json || '{}'); } catch { config = {}; }
      if (config.via && config.via.kind === 'peer') config.via = { kind: 'peer', peer_name: peerNameById.get(config.via.peerId) || null, port: config.via.port || null };
      else if (config.via && config.via.kind === 'route') config.via = { kind: 'route', route_domain: routeDomain.get(config.via.routeId) || null };
      return { target_ref: t.id, kind: t.kind, label: t.label, config, secret_enc: t.secret_enc || null, created_at: t.created_at, updated_at: t.updated_at };
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'backup export: storage targets skipped');
    return [];
  }
}

/**
 * Restore the storage targets (inside the restore transaction, after peers
 * and routes): ids as they were (plugin media areas name them), peer / route
 * of an SMB target found again by name / domain (missing → the target stays,
 * unreachable until edited). A secret from another GC_ENCRYPTION_KEY is kept
 * as it is: the target shows "Passwort neu eingeben". Returns the count.
 */
function restoreStorageTargets(db, rows, { peerIdMap, routeIdByDomain }) {
  if (!columnsOf(db, 'storage_targets').length) return 0;
  try { db.prepare('DELETE FROM storage_targets').run(); } catch (err) { logger.warn({ err: err.message }, 'backup restore: clearing storage targets failed'); return 0; }
  const ins = db.prepare(`INSERT INTO storage_targets (id, kind, label, config_json, secret_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`);
  let n = 0;
  for (const t of rows || []) {
    if (!t || !Number.isSafeInteger(t.target_ref) || t.target_ref < 1 || !['local', 'smb', 'webdav', 's3', 'gdrive', 'onedrive'].includes(t.kind) || typeof t.label !== 'string') continue;
    const config = t.config && typeof t.config === 'object' ? { ...t.config } : {};
    if (config.via && config.via.kind === 'peer') config.via = { kind: 'peer', peerId: (config.via.peer_name && peerIdMap.get(config.via.peer_name)) || 0, port: config.via.port || 445 };
    else if (config.via && config.via.kind === 'route') config.via = { kind: 'route', routeId: (config.via.route_domain && routeIdByDomain.get(config.via.route_domain)) || 0 };
    try {
      ins.run(t.target_ref, t.kind, t.label.slice(0, 60), JSON.stringify(config), typeof t.secret_enc === 'string' ? t.secret_enc : null,
        t.created_at || null, t.updated_at || null);
      n++;
    } catch (err) { logger.warn({ err: err.message }, 'storage target restore skipped'); }
  }
  return n;
}

/**
 * Restore the directory connections (inside the restore transaction, after
 * users and groups): ids as they were, the secret as stored. A secret this
 * server cannot decrypt (backup from a server with another GC_ENCRYPTION_KEY)
 * is dropped — the connection stays, is marked as needing the secret again
 * (`needsSecret`) and does not sync until an admin enters it. Links and
 * conflicts find their account by the restored id (user_ref), else by
 * username. Returns { count, secretReentry: [name] }.
 */
function restoreDirectories(db, { directories, links, conflicts }, { userIdMap, userIdByName, peerIdMap }) {
  const result = { count: 0, secretReentry: [] };
  const dCols = columnsOf(db, 'directories');
  if (!dCols.length) return result;
  try {
    // The delta position of the sync is not saved: after a restore the first
    // run of every directory reads everything (sync.js "Delta").
    if (columnsOf(db, 'directory_sync_state').length) db.prepare('DELETE FROM directory_sync_state').run();
    db.prepare('DELETE FROM directory_runs').run();
    db.prepare('DELETE FROM directory_conflicts').run();
    db.prepare('DELETE FROM directory_links').run();
    db.prepare('DELETE FROM directories').run();
  } catch (err) { logger.warn({ err: err.message }, 'backup restore: clearing directories failed'); return result; }
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const userOf = (ref, name) => {
    const byRef = Number.isSafeInteger(ref) && userIdMap.has(ref) ? userIdMap.get(ref) : null;
    const id = byRef || (name ? userIdByName.get(name) : null) || null;
    return id && userExists.get(id) ? id : null;
  };
  const groupExists = db.prepare('SELECT 1 FROM groups WHERE id = ?');
  const restored = new Set();
  const cols = dCols.filter(c => c !== 'id');
  const ins = db.prepare(`INSERT INTO directories (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`);
  for (const d of directories || []) {
    if (!d || !Number.isSafeInteger(d.directory_ref) || d.directory_ref < 1 || !d.kind || !d.name) continue;
    const row = { ...d };
    if (row.secret_enc) {
      try { decrypt(String(row.secret_enc)); } catch {
        row.secret_enc = null;
        result.secretReentry.push(d.name);
      }
    }
    if (row.parent_group_id != null && !groupExists.get(row.parent_group_id)) row.parent_group_id = null;
    // a stopped run waits in directory_runs, which is not restored
    if (row.last_status === 'pending') row.last_status = null;
    try {
      ins.run(d.directory_ref, ...cols.map(c => (row[c] === undefined ? null : row[c])));
      restored.add(d.directory_ref);
      result.count++;
    } catch (e) { logger.warn({ err: e.message, directory: d.name }, 'directory restore skipped'); }
  }
  const lCols = columnsOf(db, 'directory_links').filter(c => !['user_id', 'directory_id', 'disabled_peer_ids'].includes(c));
  const insLink = db.prepare(`INSERT OR IGNORE INTO directory_links (user_id, directory_id, disabled_peer_ids, ${lCols.join(', ')})
    VALUES (?, ?, ?, ${lCols.map(() => '?').join(', ')})`);
  for (const l of links || []) {
    if (!l || !restored.has(l.directory_ref) || !l.external_id) continue;
    const uid = userOf(l.user_ref, l.user_name);
    if (!uid) continue;
    const peers = Array.isArray(l.disabled_peer_names) ? l.disabled_peer_names.map(n => peerIdMap.get(n)).filter(Boolean) : [];
    try {
      insLink.run(uid, l.directory_ref, peers.length ? JSON.stringify(peers.map(Number)) : null, ...lCols.map(c => (l[c] === undefined ? null : l[c])));
    } catch (e) { logger.warn({ err: e.message }, 'directory link restore skipped'); }
  }
  const cCols = columnsOf(db, 'directory_conflicts').filter(c => !['id', 'directory_id', 'user_id', 'resolved_by'].includes(c));
  const insConflict = db.prepare(`INSERT OR IGNORE INTO directory_conflicts (directory_id, user_id, resolved_by, ${cCols.join(', ')})
    VALUES (?, ?, ?, ${cCols.map(() => '?').join(', ')})`);
  for (const c of conflicts || []) {
    if (!c || !restored.has(c.directory_ref) || !c.external_id) continue;
    const uid = c.user_ref == null && !c.user_name ? null : userOf(c.user_ref, c.user_name);
    // an open conflict about an account that is not there is moot
    if (!uid && c.status === 'open') continue;
    try {
      insConflict.run(c.directory_ref, uid, c.resolved_by_name ? (userIdByName.get(c.resolved_by_name) || null) : null,
        ...cCols.map(k => (c[k] === undefined ? null : c[k])));
    } catch (e) { logger.warn({ err: e.message }, 'directory conflict restore skipped'); }
  }
  return result;
}

// user_ids / group_ids JSON of a restored row, re-mapped. Ids the map does
// not know become 0 (NOBODY) so the entry stays closed and never names a
// different person (services/groupAccess.js).
function remapIdList(json, map) {
  if (!map || json == null || json === '') return json;
  let v;
  try { v = JSON.parse(json); } catch { return json; }
  if (!Array.isArray(v) || !v.length) return json;
  const out = [...new Set(v.map(x => (map.has(Number(x)) ? map.get(Number(x)) : 0)))];
  return JSON.stringify(out);
}

function exportBuiltin(db) {
  try { return require('./builtinBackup').exportAll(db); } catch (err) {
    logger.warn({ err: err.message }, 'backup export: built-in integration tables skipped');
    return {};
  }
}

function exportPlugins() {
  try { return require('./plugins/backup').exportAll(); } catch (err) {
    logger.warn({ err: err.message }, 'backup export: plugins skipped');
    return [];
  }
}

/**
 * Validate backup data structure
 */
function validateBackup(backup) {
  const errors = [];

  if (!backup || typeof backup !== 'object') {
    return ['Invalid backup: not a JSON object'];
  }
  if (!SUPPORTED_VERSIONS.includes(backup.version)) {
    errors.push(`Unsupported backup version: ${backup.version} (expected ${SUPPORTED_VERSIONS.join(', ')})`);
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

  errors.push(...require('./plugins/backup').validate(backup.data.plugins));
  errors.push(...require('./builtinBackup').validate(backup.data.builtin_integrations));

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
    service_bundles: (d.service_bundles || []).length,
    users: (d.users || []).length,
    user_avatars: (d.user_avatars || []).length,
    groups: (d.groups || []).length,
    group_members: (d.group_members || []).length,
    directories: (d.directories || []).length,
    storage_targets: (d.storage_targets || []).length,
    api_tokens: (d.api_tokens || []).length,
    tags: (d.tags || []).length,
    gateway_meta: (d.gateway_meta || []).length,
    settings: (d.settings || []).length,
    webhooks: (d.webhooks || []).length,
    route_auth: (d.route_auth || []).length,
    plugins: Array.isArray(d.plugins) ? d.plugins.length : 0,
    // format 5 restores the complete plugin state (plugins not in it are removed)
    plugin_aware: backup.version >= 5 && Array.isArray(d.plugins),
  };
}

// Verify every encrypted field in settings/route_auth/rdp_routes can be
// decrypted under the current GC_ENCRYPTION_KEY. Without this check, a
// restore from a mismatched backup would leave silent-null credentials
// that only surface when SMTP/TOTP/RDP actually gets exercised.
const ENCRYPTED_SETTINGS_KEYS = new Set([
  'smtp_password_encrypted',
  'license_signing_key_encrypted',
  // OAuth apps of the cloud accounts (docs/cloud-accounts.md)
  'cloud.google.client_secret_encrypted',
  'cloud.microsoft.client_secret_encrypted',
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
  const pl = Array.isArray(data.plugins) ? data.plugins : [];
  for (const p of pl) {
    const enc = [];
    if (p && p.license && p.license.key_encrypted) enc.push(['licence key', p.license.key_encrypted]);
    if (p && p.secret_settings && typeof p.secret_settings === 'object') for (const [k, v] of Object.entries(p.secret_settings)) enc.push([`setting ${k}`, v]);
    if (p && Array.isArray(p.media)) p.media.forEach((f, i) => { if (f && f.key) enc.push([`media #${i + 1}`, f.key]); });
    if (p && p.media_areas && Array.isArray(p.media_areas.files)) p.media_areas.files.forEach((f, i) => { if (f && f.key) enc.push([`media area file #${i + 1}`, f.key]); });
    for (const [what, v] of enc) {
      try { decrypt(String(v)); } catch { errors.push(`plugin "${p.id}" ${what}: cannot decrypt`); }
    }
  }
  const builtin = data.builtin_integrations && typeof data.builtin_integrations === 'object' ? data.builtin_integrations : {};
  for (const [table, rows] of Object.entries(builtin)) {
    if (!Array.isArray(rows)) continue;
    rows.forEach((row, i) => {
      for (const [col, v] of Object.entries(row || {})) {
        if (!col.endsWith('_enc') || !v) continue;
        try { decrypt(String(v)); } catch { errors.push(`${table} #${i + 1} ${col}: cannot decrypt`); }
      }
    });
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
    service_bundles: serviceBundles = [],
    users = [],
    user_avatars: userAvatars = [],
    groups: groupRows,
    group_members: groupMembers = [],
    group_invites: groupInvites = [],
    directories: directoryRows,
    directory_links: directoryLinks = [],
    directory_conflicts: directoryConflicts = [],
    storage_targets: storageTargetRows,
    api_tokens: apiTokens = [],
    tags = [],
    gateway_meta: gatewayMeta = [],
    settings,
    webhooks,
    route_auth: routeAuth,
    builtin_integrations: builtinIntegrations,
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

  let builtinRows = 0;
  let directoryResult = { count: 0, secretReentry: [] };
  let storageTargetCount = 0;
  const restore = db.transaction(() => {
    // Clear existing data in dependency order
    db.prepare('DELETE FROM route_peer_acl').run();
    db.prepare('DELETE FROM route_auth_otp').run();
    db.prepare('DELETE FROM route_auth_sessions').run();
    db.prepare('DELETE FROM route_auth').run();
    try { db.prepare('DELETE FROM rdp_sessions').run(); } catch (err) { logger.debug({ err: err.message }, 'backup restore: clearing rdp_sessions failed (table may be absent)'); }
    try { db.prepare('DELETE FROM rdp_routes').run(); } catch (err) { logger.debug({ err: err.message }, 'backup restore: clearing rdp_routes failed (table may be absent)'); }
    try { db.prepare('DELETE FROM service_bundles').run(); } catch (err) { logger.debug({ err: err.message }, 'backup restore: clearing service_bundles failed (table may be absent)'); }
    try { db.prepare('DELETE FROM api_tokens').run(); } catch (err) { logger.debug({ err: err.message }, 'backup restore: clearing api_tokens failed (table may be absent)'); }
    try { db.prepare('DELETE FROM gateway_meta').run(); } catch (err) { logger.debug({ err: err.message }, 'backup restore: clearing gateway_meta failed (table may be absent)'); }
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM peers').run();
    db.prepare('DELETE FROM peer_groups').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM webhooks').run();
    try { db.prepare('DELETE FROM tags').run(); } catch (err) { logger.debug({ err: err.message }, 'backup restore: clearing tags failed (table may be absent)'); }
    // users: keep the admin if no users in backup so the operator
    // never locks themselves out. If the backup DOES include users,
    // replace the full set.
    if (Array.isArray(users) && users.length > 0) {
      try { db.prepare('DELETE FROM users').run(); } catch (err) { logger.warn({ err: err.message }, 'backup restore: clearing users failed'); }
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

    // Restore users — with their original id when the backup has it
    // (user_ref), so user ids stored in routes, RDP entries, groups and
    // plugin data still name the same person. userIdMap: old id → new id.
    const userIdMap = new Map();
    let userRefs = false;
    if (Array.isArray(users) && users.length > 0) {
      for (const u of users) {
        if (!u.username || !u.password_hash) continue;
        const ref = Number.isSafeInteger(u.user_ref) && u.user_ref > 0 ? u.user_ref : null;
        let result;
        if (ref) {
          userRefs = true;
          const cols = columnsOf(db, 'users').filter(c => c !== 'id');
          try {
            result = db.prepare(`INSERT INTO users (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
              .run(ref, ...cols.map(c => (u[c] === undefined ? null : u[c])));
          } catch { result = null; }
        }
        if (!result) result = dynamicInsert(db, 'users', [], u);
        if (ref) userIdMap.set(ref, Number(result.lastInsertRowid));
      }
    }
    const userIdByName = new Map(
      (function () {
        try { return db.prepare('SELECT id, username FROM users').all().map(u => [u.username, u.id]); }
        catch { return []; }
      })()
    );

    // Person groups (docs/groups.md) — replaced only when the backup has them
    // (older backups: the groups stay; memberships of replaced accounts went
    // with them).
    if (Array.isArray(groupRows)) {
      restoreGroups(db, { groups: groupRows, members: groupMembers, invites: groupInvites }, userIdByName);
    }
    const remapUsers = userRefs ? userIdMap : null;

    // Directory connections, links and conflicts — replaced only when the
    // backup has them (older backups: the connections stay).
    if (Array.isArray(directoryRows)) {
      directoryResult = restoreDirectories(db,
        { directories: directoryRows, links: directoryLinks, conflicts: directoryConflicts },
        { userIdMap, userIdByName, peerIdMap });
    }

    // Restore profile pictures — only together with the users they belong
    // to (the user rows were replaced, their old pictures went with them).
    // Each picture is checked again like an upload; a bad one is skipped.
    if (Array.isArray(users) && users.length > 0 && Array.isArray(userAvatars)) {
      const avatars = require('./avatars');
      const insertAvatar = db.prepare(`INSERT OR REPLACE INTO user_avatars (user_id, avatar_id, mime, data, updated_at)
        VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`);
      for (const a of userAvatars) {
        try {
          const uid = a && userIdByName.get(a.user_name);
          if (!uid || typeof a.data !== 'string' || typeof a.avatar_id !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(a.avatar_id)) continue;
          const buf = Buffer.from(a.data, 'base64');
          const img = avatars.validateImage(buf);
          insertAvatar.run(uid, a.avatar_id, img.mime, buf, typeof a.updated_at === 'string' ? a.updated_at : null);
        } catch (e) { logger.warn({ err: e.message }, 'user avatar restore skipped'); }
      }
    }

    // Restore tags registry
    for (const t of tags) {
      if (!t.name) continue;
      try { dynamicInsert(db, 'tags', [], t); } catch (e) { logger.warn({ err: e.message, tag: t.name }, 'tag restore skipped'); }
    }

    // Restore service_bundles, mapping the exported bundle_ref → new id
    const bundleIdMap = new Map();
    for (const sb of serviceBundles) {
      try {
        const row = { ...sb };
        const result = dynamicInsert(db, 'service_bundles', ['bundle_ref'], row);
        if (sb.bundle_ref != null) bundleIdMap.set(sb.bundle_ref, result.lastInsertRowid);
      } catch (e) {
        logger.warn({ err: e.message, name: sb.name }, 'service_bundle restore skipped');
      }
    }

    // Restore routes (dynamic columns), re-mapping peer_id/target_peer_id
    const routeIdByDomain = new Map();
    const insertAcl = db.prepare('INSERT OR IGNORE INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)');
    for (const r of routes) {
      const row = { ...r };
      row.peer_id = r.peer_name ? (peerIdMap.get(r.peer_name) || null) : null;
      row.target_peer_id = r.target_peer_name ? (peerIdMap.get(r.target_peer_name) || null) : null;
      if (row.bundle_id != null) row.bundle_id = bundleIdMap.get(row.bundle_id) || null;
      if (row.enabled === undefined) row.enabled = 1;
      row.circuit_breaker_status = 'closed';
      // acl_people (docs/groups.md "Zugriff per Gruppe"): a backup from before
      // the switch gets the rule of migration 111 (ACL on + persons → 0, only
      // the listed devices pass), so restoring it never widens access.
      row.acl_people = r.acl_people === undefined || r.acl_people === null
        ? require('./groupAccess').legacyAclPeople(r)
        : (r.acl_people === 0 || r.acl_people === false || r.acl_people === '0' ? 0 : 1);
      row.user_ids = remapIdList(row.user_ids, remapUsers);
      const excluded = ['peer_name', 'target_peer_name', 'acl_peer_names', 'group_refs'];
      const result = dynamicInsert(db, 'routes', excluded, row);
      if (Array.isArray(r.group_refs) && r.group_refs.length) {
        const insGroupAcl = db.prepare('INSERT OR IGNORE INTO route_group_acl (route_id, group_id) VALUES (?, ?)');
        const groupExists = db.prepare('SELECT 1 FROM groups WHERE id = ?');
        let kept = 0;
        for (const gid of r.group_refs) {
          if (Number.isSafeInteger(gid) && groupExists.get(gid)) { insGroupAcl.run(result.lastInsertRowid, gid); kept++; }
        }
        // Released for groups that are not there: closed, not open for all.
        if (!kept && !(row.user_ids && row.user_ids !== '[]' && row.user_ids !== 'null')) {
          db.prepare("UPDATE routes SET user_ids = '[0]' WHERE id = ?").run(result.lastInsertRowid);
        }
      }
      if (r.domain) routeIdByDomain.set(r.domain, result.lastInsertRowid);
      if (Array.isArray(r.acl_peer_names)) {
        for (const peerName of r.acl_peer_names) {
          const aclPeerId = peerIdMap.get(peerName);
          if (aclPeerId) insertAcl.run(result.lastInsertRowid, aclPeerId);
        }
      }
    }

    // Storage targets — replaced only when the backup has them (older
    // backups: the targets stay).
    if (Array.isArray(storageTargetRows)) storageTargetCount = restoreStorageTargets(db, storageTargetRows, { peerIdMap, routeIdByDomain });

    // Restore rdp_routes (re-map gateway_peer_id)
    for (const rr of rdpRoutes) {
      try {
        const row = { ...rr };
        row.gateway_peer_id = rr.gateway_peer_name ? (peerIdMap.get(rr.gateway_peer_name) || null) : null;
        row.user_ids = remapIdList(row.user_ids, remapUsers);
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
      if (RESTORE_SKIP_SETTINGS.has(s.key)) continue;
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
                                two_factor_enabled, two_factor_method, session_max_age, app_login)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          ra.app_login ? 1 : 0,
        );
      }
    }

    // Tables of the former built-in integrations (kept until imported into
    // their plugins): replaced only when the backup carries them.
    builtinRows = require('./builtinBackup').restoreAll(db, builtinIntegrations, { userIdByName });
  });

  restore();

  logger.info({
    peer_groups: (peerGroups || []).length,
    peers: peers.length,
    routes: routes.length,
    rdp_routes: rdpRoutes.length,
    service_bundles: serviceBundles.length,
    users: users.length,
    groups: Array.isArray(groupRows) ? groupRows.length : 0,
    directories: directoryResult.count,
    directories_secret_reentry: directoryResult.secretReentry.length,
    api_tokens: apiTokens.length,
    tags: tags.length,
    gateway_meta: gatewayMeta.length,
    settings: settings.length,
    webhooks: webhooks.length,
    builtin_integrations: builtinRows,
  }, 'Backup restored');
  if (directoryResult.secretReentry.length) {
    logger.warn({ directories: directoryResult.secretReentry }, 'backup restore: directory secrets from another GC_ENCRYPTION_KEY — enter them again');
  }

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

  // Plugins (backup v5): after peers/routes so access targets re-map to the
  // restored ids. A v5 backup is the complete plugin state (plugins not in it
  // are removed); older backups have no plugin data — installed plugins stay.
  let pluginResult = { restored: 0, skipped: [], removed: [] };
  if (backup.version >= 5 && Array.isArray(backup.data.plugins)) {
    try { pluginResult = await require('./plugins/backup').restoreAll(backup.data.plugins, { removeOthers: true }); } catch (err) {
      logger.warn({ error: err.message }, 'plugin restore failed');
    }
  }

  // Everything a device fetches may differ now — tell the open app streams.
  try {
    const control = require('./notify/control');
    control.configChanged({ all: true });
    control.policyChanged({ all: true });
  } catch (err) { logger.debug({ err: err.message }, 'push control events after restore not sent'); }

  return {
    peer_groups: (peerGroups || []).length,
    peers: peers.length,
    routes: routes.length,
    rdp_routes: rdpRoutes.length,
    service_bundles: serviceBundles.length,
    users: users.length,
    groups: Array.isArray(groupRows) ? groupRows.length : 0,
    group_members: Array.isArray(groupRows) ? groupMembers.length : 0,
    directories: directoryResult.count,
    directories_secret_reentry: directoryResult.secretReentry,
    storage_targets: storageTargetCount,
    api_tokens: apiTokens.length,
    tags: tags.length,
    gateway_meta: gatewayMeta.length,
    settings: settings.length,
    webhooks: webhooks.length,
    plugins: pluginResult.restored,
    plugins_skipped: pluginResult.skipped,
    plugins_removed: pluginResult.removed,
  };
}

module.exports = {
  createBackup,
  validateBackup,
  getBackupSummary,
  restoreBackup,
  BACKUP_VERSION,
};
