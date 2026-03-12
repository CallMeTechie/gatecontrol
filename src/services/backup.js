'use strict';

const { getDb } = require('../db/connection');
const { decrypt, encrypt } = require('../utils/crypto');
const peersService = require('./peers');
const routesService = require('./routes');
const logger = require('../utils/logger');

const BACKUP_VERSION = 1;

/**
 * Create a full backup as JSON object
 */
function createBackup() {
  const db = getDb();

  // Peers — decrypt keys for portability
  const rawPeers = db.prepare('SELECT * FROM peers').all();
  const peers = rawPeers.map(p => ({
    name: p.name,
    description: p.description,
    public_key: p.public_key,
    private_key: p.private_key_encrypted ? decrypt(p.private_key_encrypted) : null,
    preshared_key: p.preshared_key_encrypted ? decrypt(p.preshared_key_encrypted) : null,
    allowed_ips: p.allowed_ips,
    dns: p.dns,
    persistent_keepalive: p.persistent_keepalive,
    enabled: p.enabled,
    tags: p.tags || '',
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));

  // Routes
  const rawRoutes = db.prepare('SELECT * FROM routes').all();
  const routes = rawRoutes.map(r => ({
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
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

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

  return {
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    data: {
      peers,
      routes,
      settings,
      webhooks,
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
  if (backup.version !== BACKUP_VERSION) {
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
    if (!p.public_key) errors.push(`Peer #${i + 1}: missing public_key`);
    if (!p.allowed_ips) errors.push(`Peer #${i + 1}: missing allowed_ips`);
  }

  // Validate route entries
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (!r.domain) errors.push(`Route #${i + 1}: missing domain`);
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
    peers: d.peers.length,
    routes: d.routes.length,
    settings: d.settings.length,
    webhooks: d.webhooks.length,
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
  const { peers, routes, settings, webhooks } = backup.data;

  // Run everything in a transaction for atomicity
  const restore = db.transaction(() => {
    // Clear existing data
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM peers').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM webhooks').run();

    // Restore peers
    const insertPeer = db.prepare(`
      INSERT INTO peers (name, description, public_key, private_key_encrypted, preshared_key_encrypted,
                         allowed_ips, dns, persistent_keepalive, enabled, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    `);

    const peerIdMap = new Map(); // name → new id
    for (const p of peers) {
      const result = insertPeer.run(
        p.name,
        p.description || null,
        p.public_key,
        p.private_key ? encrypt(p.private_key) : null,
        p.preshared_key ? encrypt(p.preshared_key) : null,
        p.allowed_ips,
        p.dns || null,
        p.persistent_keepalive || 25,
        p.enabled !== undefined ? (p.enabled ? 1 : 0) : 1,
        p.tags || '',
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
                          created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    `);

    for (const r of routes) {
      const peerId = r.peer_name ? (peerIdMap.get(r.peer_name) || null) : null;
      insertRoute.run(
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
        r.created_at || null,
        r.updated_at || null,
      );
    }

    // Restore settings
    const insertSetting = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    for (const s of settings) {
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
  });

  restore();

  logger.info({
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
