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

  // Check for duplicate name
  const existing = db.prepare('SELECT id FROM peers WHERE name = ?').get(sanitize(data.name));
  if (existing) throw new Error('A peer with this name already exists');

  // Generate keys
  const { privateKey, publicKey } = await generateKeyPair();
  const presharedKey = await generatePresharedKey();

  // Allocate IP
  const ip = getNextAvailableIp();
  if (!ip) throw new Error('No available IP addresses in subnet');

  const allowedIps = `${ip}/32`;
  const dns = data.dns || config.wireguard.dns.join(',');
  const keepalive = data.persistentKeepalive || config.wireguard.persistentKeepalive;

  // Store peer in DB
  const result = db.prepare(`
    INSERT INTO peers (name, description, public_key, private_key_encrypted, preshared_key_encrypted,
                       allowed_ips, dns, persistent_keepalive, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    sanitize(data.name),
    sanitize(data.description) || null,
    publicKey,
    encrypt(privateKey),
    encrypt(presharedKey),
    allowedIps,
    dns,
    keepalive
  );

  const peerId = result.lastInsertRowid;

  // Update WireGuard config and sync
  await rewriteWgConfig();

  // Log activity
  activity.log('peer_created', `Peer "${sanitize(data.name)}" created (${allowedIps})`, {
    source: 'admin',
    severity: 'success',
    details: { peerId, ip, publicKey: publicKey.substring(0, 8) + '...' },
  });

  logger.info({ peerId, name: data.name, ip }, 'Peer created');

  return {
    id: peerId,
    name: sanitize(data.name),
    publicKey,
    privateKey,
    presharedKey,
    allowedIps,
    ip,
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

  db.prepare(`
    UPDATE peers SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      dns = COALESCE(?, dns),
      persistent_keepalive = COALESCE(?, persistent_keepalive),
      enabled = COALESCE(?, enabled),
      tags = COALESCE(?, tags),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.name !== undefined ? sanitize(data.name) : null,
    data.description !== undefined ? sanitize(data.description) : null,
    data.dns || null,
    data.persistentKeepalive || null,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : null,
    data.tags !== undefined ? sanitize(data.tags) : null,
    id
  );

  await rewriteWgConfig();

  activity.log('peer_updated', `Peer "${peer.name}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { peerId: id },
  });

  return getById(id);
}

/**
 * Delete a peer
 */
async function remove(id) {
  const db = getDb();
  const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(id);
  if (!peer) throw new Error('Peer not found');

  db.prepare('DELETE FROM peers WHERE id = ?').run(id);

  // Unlink routes pointing to this peer
  db.prepare('UPDATE routes SET peer_id = NULL WHERE peer_id = ?').run(id);

  await rewriteWgConfig();

  activity.log('peer_deleted', `Peer "${peer.name}" deleted`, {
    source: 'admin',
    severity: 'warning',
    details: { peerId: id, ip: peer.allowed_ips },
  });

  logger.info({ peerId: id, name: peer.name }, 'Peer deleted');
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

  activity.log(
    newState ? 'peer_enabled' : 'peer_disabled',
    `Peer "${peer.name}" ${newState ? 'enabled' : 'disabled'}`,
    { source: 'admin', severity: 'info', details: { peerId: id } }
  );

  return { ...peer, enabled: newState };
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
  const dns = peer.dns || config.wireguard.dns.join(',');

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
 * Rewrite wg0.conf from database and sync with running interface
 */
async function rewriteWgConfig() {
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

    // Extract Interface section
    const ifaceMatch = existingConf.match(/\[Interface\][\s\S]*?(?=\n\[Peer\]|\n#\s*Peer:|$)/);
    if (!ifaceMatch) {
      logger.error('Could not parse Interface section from WG config');
      return;
    }

    let newConf = ifaceMatch[0].trimEnd() + '\n';

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

    fs.writeFileSync(config.wireguard.configPath, newConf, { mode: 0o600 });
    logger.info({ peerCount: peers.length }, 'WireGuard config rewritten');

    // Sync with running interface
    await wireguard.syncConfig();
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to rewrite WG config');
  }
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
};
