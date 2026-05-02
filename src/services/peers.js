'use strict';

const fs = require('node:fs');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const { generateKeyPair, generatePresharedKey, encrypt, decrypt } = require('../utils/crypto');
const { getNextAvailableIp } = require('../utils/ip');
const { validatePeerName, validateDescription, sanitize } = require('../utils/validate');
const wireguard = require('./wireguard');
const activity = require('./activity');
const logger = require('../utils/logger');
const dns = require('./dns');

/**
 * Get all peers with live status from WireGuard
 */
async function getAll({ limit = 250, offset = 0 } = {}) {
  const db = getDb();
  const peers = db.prepare('SELECT * FROM peers ORDER BY created_at ASC LIMIT ? OFFSET ?').all(limit, offset);

  // Merge with live WG status
  const wgStatus = await wireguard.getStatus();
  const wgPeers = new Map();
  for (const p of wgStatus.peers) {
    wgPeers.set(p.publicKey, p);
  }

  return peers.map(peer => {
    const wgPeer = wgPeers.get(peer.public_key);
    return {
      ...peer,
      isOnline: wgPeer ? wgPeer.isOnline : false,
      latestHandshake: wgPeer ? wgPeer.latestHandshake : peer.latest_handshake,
      transferRx: wgPeer ? wgPeer.transferRx : peer.transfer_rx,
      transferTx: wgPeer ? wgPeer.transferTx : peer.transfer_tx,
      endpoint: wgPeer ? wgPeer.endpoint : peer.endpoint,
    };
  });
}

/**
 * Get a single peer by ID
 */
function getById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM peers WHERE id = ?').get(id);
}

/**
 * Create a new peer
 */
async function create(data) {
  const nameErr = validatePeerName(data.name);
  if (nameErr) throw new Error(nameErr);

  const descErr = validateDescription(data.description);
  if (descErr) throw new Error(descErr);

  const db = getDb();

  // Generate keys (async, before transaction)
  const { privateKey, publicKey } = await generateKeyPair();
  const presharedKey = await generatePresharedKey();

  const peerDns = data.dns || config.wireguard.dns.join(',');
  const keepalive = data.persistentKeepalive || config.wireguard.persistentKeepalive;

  // Wrap IP allocation + INSERT in a transaction to prevent race conditions
  const insertPeer = db.transaction(() => {
    // Check for duplicate name
    const existing = db.prepare('SELECT id FROM peers WHERE name = ?').get(sanitize(data.name));
    if (existing) throw new Error('A peer with this name already exists');

    // Allocate IP inside transaction to prevent two peers getting the same IP
    const ip = getNextAvailableIp();
    if (!ip) throw new Error('No available IP addresses in subnet');

    const allowedIps = `${ip}/32`;

    const result = db.prepare(`
      INSERT INTO peers (name, description, public_key, private_key_encrypted, preshared_key_encrypted,
                         allowed_ips, dns, persistent_keepalive, enabled, tags, expires_at, group_id, peer_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      sanitize(data.name),
      sanitize(data.description) || null,
      publicKey,
      encrypt(privateKey),
      encrypt(presharedKey),
      allowedIps,
      peerDns,
      keepalive,
      sanitize(data.tags) || '',
      data.expiresAt || null,
      data.groupId || null,
      data.peerType || 'regular'
    );

    return { peerId: result.lastInsertRowid, ip, allowedIps };
  });

  const { peerId, ip, allowedIps } = insertPeer();

  // Update WireGuard config and sync
  await rewriteWgConfig();

  // Promote newly-typed tag tokens into the registry so the Tags admin
  // card shows them as first-class entries rather than "nicht registriert".
  try {
    if (data.tags) require('./tags').ensureRegistered(data.tags);
  } catch (err) { logger.debug({ err: err.message }, 'tags.ensureRegistered (create)'); }

  // Log activity
  activity.log('peer_created', `Peer "${sanitize(data.name)}" created (${allowedIps})`, {
    source: 'admin',
    severity: 'success',
    details: { peerId, ip, publicKey: publicKey.substring(0, 8) + '...' },
  });

  logger.info({ peerId, name: data.name, ip }, 'Peer created');

  dns.scheduleRebuild();

  return {
    id: peerId,
    name: sanitize(data.name),
    publicKey,
    privateKey,
    presharedKey,
    allowedIps,
    ip,
    ip_address: ip,
    peer_type: data.peerType || 'regular',
    expires_at: data.expiresAt || null,
  };
}

/**
 * Update a peer
 */
async function update(id, data) {
  const db = getDb();
  const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(id);
  if (!peer) throw new Error('Peer not found');

  if (data.name !== undefined) {
    const nameErr = validatePeerName(data.name);
    if (nameErr) throw new Error(nameErr);

    const dup = db.prepare('SELECT id FROM peers WHERE name = ? AND id != ?').get(sanitize(data.name), id);
    if (dup) throw new Error('A peer with this name already exists');
  }

  if (data.description !== undefined) {
    const descErr = validateDescription(data.description);
    if (descErr) throw new Error(descErr);
  }

  // Validate dns — must be comma-separated valid IPs, no newlines
  if (data.dns !== undefined && data.dns) {
    if (/[\r\n]/.test(data.dns)) {
      throw new Error('DNS must not contain newline characters');
    }
    const dnsEntries = data.dns.split(',').map(s => s.trim());
    for (const entry of dnsEntries) {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(entry)) {
        throw new Error('Invalid DNS server IP: ' + entry);
      }
    }
  }

  // Validate persistentKeepalive — must be integer 0-65535, no newlines
  if (data.persistentKeepalive !== undefined && data.persistentKeepalive !== null) {
    if (typeof data.persistentKeepalive === 'string' && /[\r\n]/.test(data.persistentKeepalive)) {
      throw new Error('PersistentKeepalive must not contain newline characters');
    }
    const pk = parseInt(data.persistentKeepalive, 10);
    if (isNaN(pk) || pk < 0 || pk > 65535) {
      throw new Error('PersistentKeepalive must be 0-65535');
    }
    data.persistentKeepalive = pk;
  }

  // Handle expires_at: explicit null clears expiry, undefined means no change
  const expiresAtValue = data.expiresAt !== undefined
    ? (data.expiresAt || null)
    : undefined;

  // Handle group_id: explicit null clears group, undefined means no change
  const groupIdValue = data.groupId !== undefined ? (data.groupId || null) : undefined;

  db.prepare(`
    UPDATE peers SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      dns = COALESCE(?, dns),
      persistent_keepalive = COALESCE(?, persistent_keepalive),
      enabled = COALESCE(?, enabled),
      tags = COALESCE(?, tags),
      expires_at = CASE WHEN ? = 1 THEN ? ELSE expires_at END,
      group_id = CASE WHEN ? = 1 THEN ? ELSE group_id END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.name !== undefined ? sanitize(data.name) : null,
    data.description !== undefined ? sanitize(data.description) : null,
    data.dns || null,
    data.persistentKeepalive || null,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : null,
    data.tags !== undefined ? sanitize(data.tags) : null,
    expiresAtValue !== undefined ? 1 : 0,
    expiresAtValue !== undefined ? expiresAtValue : null,
    groupIdValue !== undefined ? 1 : 0,
    groupIdValue !== undefined ? groupIdValue : null,
    id
  );

  await rewriteWgConfig();

  // See peers.create: promote typed tag tokens into the registry.
  try {
    if (data.tags !== undefined && data.tags) require('./tags').ensureRegistered(data.tags);
  } catch (err) { logger.debug({ err: err.message }, 'tags.ensureRegistered (update)'); }

  activity.log('peer_updated', `Peer "${peer.name}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { peerId: id },
  });

  dns.scheduleRebuild();

  return getById(id);
}

/**
 * Delete a peer
 */
async function remove(id) {
  const db = getDb();
  const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(id);
  if (!peer) throw new Error('Peer not found');

  const publicKey = peer.public_key;
  db.prepare('DELETE FROM peers WHERE id = ?').run(id);

  // Unlink routes pointing to this peer
  db.prepare('UPDATE routes SET peer_id = NULL WHERE peer_id = ?').run(id);
  // target_peer_id has no FK (SQLite ALTER TABLE ADD COLUMN drops the
  // REFERENCES clause), so manually disable and unlink gateway-routed
  // targets that pointed at this peer. Leaving them enabled would
  // produce broken Caddy config (empty upstream) after sync.
  db.prepare("UPDATE routes SET target_peer_id = NULL, enabled = 0 WHERE target_peer_id = ? AND target_kind = 'gateway'").run(id);
  // Same situation for rdp_routes.gateway_peer_id: FK declared via ALTER
  // TABLE is silently ignored by older SQLite, so a deleted gateway peer
  // would leave dangling rdp_routes pointing at a non-existent id. Null
  // out the pointer and flip access_mode back to internal so the UI
  // shows a clear "not configured" state instead of a broken gateway.
  try {
    db.prepare("UPDATE rdp_routes SET gateway_peer_id = NULL, access_mode = 'internal' WHERE gateway_peer_id = ?").run(id);
  } catch {}
  // Drop state-machine cache for this gateway so a later peer reusing
  // the id (unlikely but possible) doesn't start with stale transitions.
  try {
    const gw = require('./gateways');
    if (gw && gw._smCache && typeof gw._smCache.delete === 'function') gw._smCache.delete(id);
  } catch {}

  await rewriteWgConfig();

  // Explicitly remove from running interface (syncconf doesn't remove peers)
  if (publicKey) {
    try { await wireguard.removePeer(publicKey); } catch {}
  }

  // Push the disabled-route state to Caddy so requests to those domains
  // stop being proxied to a now-non-existent gateway. Late-require to
  // avoid the routes ↔ peers circular import.
  try {
    const routesSvc = require('./routes');
    if (typeof routesSvc.syncToCaddy === 'function') {
      await routesSvc.syncToCaddy();
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Caddy sync after peer delete failed');
  }

  activity.log('peer_deleted', `Peer "${peer.name}" deleted`, {
    source: 'admin',
    severity: 'warning',
    details: { peerId: id, ip: peer.allowed_ips },
  });

  logger.info({ peerId: id, name: peer.name }, 'Peer deleted');

  dns.scheduleRebuild();
}

/**
 * Toggle peer enabled/disabled
 */
async function toggle(id) {
  const db = getDb();
  const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(id);
  if (!peer) throw new Error('Peer not found');

  const newState = peer.enabled ? 0 : 1;
  db.prepare('UPDATE peers SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newState, id);

  await rewriteWgConfig();

  // wg syncconf does not remove peers that were deleted from the config —
  // it only adds/updates. Explicitly remove the peer from the running
  // interface so the client is disconnected immediately.
  if (!newState && peer.public_key) {
    try {
      await wireguard.removePeer(peer.public_key);
    } catch (err) {
      logger.warn({ peerId: id, error: err.message }, 'Failed to remove peer from running interface');
    }
  }

  activity.log(
    newState ? 'peer_enabled' : 'peer_disabled',
    `Peer "${peer.name}" ${newState ? 'enabled' : 'disabled'}`,
    { source: 'admin', severity: 'info', details: { peerId: id } }
  );

  dns.scheduleRebuild();

  return { ...peer, enabled: newState };
}

/**
 * Set or clear the internal DNS hostname for a peer.
 *
 * Policy:
 *  - source='admin': always wins. Overwrites any prior hostname.
 *  - source='agent': only writes if the peer currently has no hostname
 *    OR the existing hostname_source is 'agent' or 'stale'. Sticky-admin
 *    means agent auto-reports don't clobber an admin-curated value.
 *  - On hostname collision, auto-appends -2, -3, … inside a transaction
 *    so concurrent agents can't both claim the same suffix.
 *  - Logs an activity event on change (old → new) for incident response.
 *  - Triggers a debounced DNS rebuild.
 *
 * @param {number} peerId
 * @param {string|null} rawHostname Null clears the hostname
 * @param {'admin'|'agent'} source
 * @returns {{ peer:object, assigned:string|null, changed:boolean }}
 */
function setHostname(peerId, rawHostname, source) {
  if (source !== 'admin' && source !== 'agent') {
    throw new Error('invalid hostname source');
  }

  const db = getDb();
  const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(peerId);
  if (!peer) throw new Error('Peer not found');

  const previous = peer.hostname || null;
  const previousSource = peer.hostname_source || null;

  // Explicit clear
  if (rawHostname === null || rawHostname === '') {
    if (source === 'agent' && previousSource === 'admin') {
      return { peer, assigned: previous, changed: false };
    }
    db.prepare(`
      UPDATE peers SET hostname = NULL, hostname_source = NULL,
        hostname_reported_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(peerId);
    if (previous) {
      activity.log('peer_hostname_changed',
        `Peer "${peer.name}" hostname cleared (was "${previous}")`,
        { source: source === 'admin' ? 'admin' : 'api', severity: 'info',
          details: { peerId, previous, assigned: null, source } });
    }
    dns.scheduleRebuild();
    return { peer: { ...peer, hostname: null }, assigned: null, changed: !!previous };
  }

  // Sticky-admin: agent cannot overwrite an admin value.
  if (source === 'agent' && previousSource === 'admin') {
    logger.debug({ peerId, previous, attempt: rawHostname },
      'Hostname report ignored: sticky admin source');
    return { peer, assigned: previous, changed: false };
  }

  const normalized = dns.normalizeHostname(rawHostname);
  dns.strictHostnameAssert(normalized);

  // No-op if unchanged
  if (previous && previous.toLowerCase() === normalized) {
    return { peer, assigned: previous, changed: false };
  }

  const assigned = dns.reserveUniqueHostname(normalized, peerId, (finalHostname) => {
    db.prepare(`
      UPDATE peers SET hostname = ?, hostname_source = ?,
        hostname_reported_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(finalHostname, source, peerId);
  });

  activity.log('peer_hostname_changed',
    `Peer "${peer.name}" hostname "${previous || '∅'}" → "${assigned}"`,
    { source: source === 'admin' ? 'admin' : 'api', severity: 'info',
      details: { peerId, previous, assigned, source } });

  dns.scheduleRebuild();

  return { peer: { ...peer, hostname: assigned, hostname_source: source },
    assigned, changed: true };
}

/**
 * Mark all agent-reported hostnames as 'stale' after a backup restore.
 * Returns the number of rows affected. Called from services/backup.js.
 */
function markHostnamesStale() {
  const db = getDb();
  const result = db.prepare(`
    UPDATE peers
    SET hostname_source = 'stale', hostname_reported_at = NULL
    WHERE hostname_source IN ('agent', 'stale') AND hostname IS NOT NULL
  `).run();
  if (result.changes > 0) {
    logger.info({ changes: result.changes }, 'Post-restore: marked agent hostnames as stale');
    dns.scheduleRebuild();
  }
  return result.changes;
}

/**
 * Generate client WireGuard config for a peer
 */
async function getClientConfig(id) {
  const db = getDb();
  const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(id);
  if (!peer) throw new Error('Peer not found');

  const privateKey = peer.private_key_encrypted ? decrypt(peer.private_key_encrypted) : '<PRIVATE_KEY>';
  const presharedKey = peer.preshared_key_encrypted ? decrypt(peer.preshared_key_encrypted) : null;

  // Derive server public key from server private key in wg config
  let serverPublicKey = '<SERVER_PUBLIC_KEY>';
  try {
    const wgConf = fs.readFileSync(config.wireguard.configPath, 'utf-8');
    const privKeyMatch = wgConf.match(/PrivateKey\s*=\s*(.+)/);
    if (privKeyMatch) {
      const { derivePublicKey } = require('../utils/crypto');
      serverPublicKey = await derivePublicKey(privKeyMatch[1].trim());
    }
  } catch {}

  const ip = peer.allowed_ips.split('/')[0];
  const settings = require('./settings');
  const customDns = settings.get('custom_dns');
  const dns = peer.dns || customDns || config.wireguard.dns.join(',');

  let conf = `[Interface]
PrivateKey = ${privateKey}
Address = ${ip}/32
DNS = ${dns}
`;

  if (config.wireguard.mtu) {
    conf += `MTU = ${config.wireguard.mtu}\n`;
  }

  conf += `
[Peer]
PublicKey = ${serverPublicKey}
`;

  if (presharedKey) {
    conf += `PresharedKey = ${presharedKey}\n`;
  }

  conf += `Endpoint = ${config.wireguard.host}:${config.wireguard.port}
AllowedIPs = ${config.wireguard.allowedIps}
PersistentKeepalive = ${peer.persistent_keepalive || 25}
`;

  return conf;
}

/**
 * Serialize rewriteWgConfig() so two concurrent peer mutations can't race
 * each other between the SELECT, writeFile, and wg syncconf — a late
 * second writer could otherwise clobber the first's state or install a
 * DB-inconsistent wg0.conf. Callers chain onto the in-flight promise.
 */
let _wgRewriteChain = Promise.resolve();

async function rewriteWgConfig() {
  const task = _wgRewriteChain.then(() => _rewriteWgConfigInner()).catch(() => _rewriteWgConfigInner());
  _wgRewriteChain = task;
  return task;
}

async function _rewriteWgConfigInner() {
  const db = getDb();
  const peers = db.prepare('SELECT * FROM peers WHERE enabled = 1').all();

  try {
    // Read existing config to preserve Interface section
    let existingConf = '';
    try {
      existingConf = fs.readFileSync(config.wireguard.configPath, 'utf-8');
    } catch {
      logger.warn('No existing WG config found, cannot rewrite');
      return;
    }

    // Extract Interface section by splitting on [Peer] or # Peer: markers
    // Use split instead of lazy regex to correctly capture the full Interface body
    // even when no [Peer] blocks exist
    const peerSplit = existingConf.split(/\n(?=\[Peer\]|\#\s*Peer:)/);
    const ifaceSection = peerSplit[0];
    if (!ifaceSection || !ifaceSection.includes('[Interface]')) {
      logger.error('Could not parse Interface section from WG config');
      return;
    }

    let newConf = ifaceSection.trimEnd() + '\n';

    // Add peers
    for (const peer of peers) {
      newConf += `\n# Peer: ${peer.name}\n`;
      newConf += `[Peer]\n`;
      newConf += `PublicKey = ${peer.public_key}\n`;

      if (peer.preshared_key_encrypted) {
        const psk = decrypt(peer.preshared_key_encrypted);
        newConf += `PresharedKey = ${psk}\n`;
      }

      newConf += `AllowedIPs = ${peer.allowed_ips}\n`;

      if (peer.persistent_keepalive) {
        newConf += `PersistentKeepalive = ${peer.persistent_keepalive}\n`;
      }
    }

    // Atomic write: write to temp file, then rename (rename is atomic on POSIX).
    // Resolve symlinks first — entrypoint.sh creates /etc/wireguard/wg0.conf as
    // a symlink to /data/wireguard/wg0.conf so the WG config persists across
    // container restarts. fs.renameSync() replaces the symlink target with a
    // regular file at the link path, leaving /data/wireguard/wg0.conf empty
    // forever — every restart then boots WG with 0 peers until this code runs
    // again. Resolving realpath first means we replace the persistent file
    // and keep the symlink intact.
    let realPath;
    try {
      realPath = fs.realpathSync(config.wireguard.configPath);
    } catch {
      realPath = config.wireguard.configPath;
    }
    const tmpPath = realPath + '.tmp';
    fs.writeFileSync(tmpPath, newConf, { mode: 0o600 });
    fs.renameSync(tmpPath, realPath);
    logger.info({ peerCount: peers.length, path: realPath }, 'WireGuard config rewritten');

    // Sync with running interface
    await wireguard.syncConfig();
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to rewrite WG config');
  }
}

/**
 * Check for expired peers and disable them.
 * Called periodically from the background task in server.js.
 */
async function checkExpiredPeers() {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db.prepare(
    `SELECT * FROM peers WHERE expires_at IS NOT NULL AND expires_at < ? AND enabled = 1`
  ).all(now);

  if (expired.length === 0) return;

  let needSync = false;
  for (const peer of expired) {
    db.prepare('UPDATE peers SET enabled = 0, updated_at = datetime(\'now\') WHERE id = ?').run(peer.id);

    activity.log('peer_expired', `Peer "${peer.name}" expired and was disabled`, {
      source: 'system',
      severity: 'warning',
      details: { peerId: peer.id, expiresAt: peer.expires_at },
    });

    logger.info({ peerId: peer.id, name: peer.name, expiresAt: peer.expires_at }, 'Peer expired and disabled');
    needSync = true;
  }

  if (needSync) {
    await rewriteWgConfig();
    // Remove expired peers from running interface
    for (const peer of expired) {
      if (peer.public_key) {
        try { await wireguard.removePeer(peer.public_key); } catch {}
      }
    }
  }
}

/**
 * Batch enable, disable, or delete peers.
 * Returns the count of affected peers.
 */
async function batch(action, ids) {
  if (!['enable', 'disable', 'delete'].includes(action)) {
    throw new Error('Invalid batch action');
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('No IDs provided');
  }

  const db = getDb();

  // Validate all IDs exist
  const placeholders = ids.map(() => '?').join(',');
  const existing = db.prepare(`SELECT id, name FROM peers WHERE id IN (${placeholders})`).all(...ids);
  if (existing.length !== ids.length) {
    const found = new Set(existing.map(p => p.id));
    const missing = ids.filter(id => !found.has(id));
    throw new Error(`Peers not found: ${missing.join(', ')}`);
  }

  const names = existing.map(p => p.name);
  // Collect public keys before deletion for explicit removal from running interface
  const pubKeys = (action === 'disable' || action === 'delete')
    ? db.prepare(`SELECT public_key FROM peers WHERE id IN (${placeholders})`).all(...ids).map(p => p.public_key).filter(Boolean)
    : [];

  if (action === 'enable') {
    db.prepare(`UPDATE peers SET enabled = 1, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else if (action === 'disable') {
    db.prepare(`UPDATE peers SET enabled = 0, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else if (action === 'delete') {
    db.prepare(`DELETE FROM peers WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(`UPDATE routes SET peer_id = NULL WHERE peer_id IN (${placeholders})`).run(...ids);
  }

  await rewriteWgConfig();

  // Explicitly remove peers from running interface (syncconf doesn't remove)
  for (const pk of pubKeys) {
    try { await wireguard.removePeer(pk); } catch {}
  }

  const actionPast = action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'deleted';
  activity.log(
    `batch_peers_${actionPast}`,
    `Batch ${actionPast} ${ids.length} peer(s): ${names.join(', ')}`,
    {
      source: 'admin',
      severity: action === 'delete' ? 'warning' : 'info',
      details: { peerIds: ids, action },
    }
  );

  logger.info({ action, peerIds: ids, count: ids.length }, `Batch ${actionPast} peers`);

  return ids.length;
}

module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
  toggle,
  getClientConfig,
  rewriteWgConfig,
  checkExpiredPeers,
  batch,
  setHostname,
  markHostnamesStale,
};
