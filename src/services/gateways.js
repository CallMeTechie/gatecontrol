'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const license = require('./license');
const peers = require('./peers');
const logger = require('../utils/logger');

const DEFAULT_API_PORT = 9876;

/**
 * Generate cryptographically-random tokens and hashes.
 */
function generateTokens() {
  const apiTokenRaw = crypto.randomBytes(32).toString('hex');
  const apiToken = `gc_gw_${apiTokenRaw}`;
  const apiTokenHash = 'sha256:' + crypto.createHash('sha256').update(apiToken).digest('hex');

  const pushToken = crypto.randomBytes(32).toString('hex');
  const pushTokenEncrypted = encrypt(pushToken);

  return { apiToken, apiTokenHash, pushToken, pushTokenEncrypted };
}

/**
 * Create a Gateway-Peer with its metadata. Enforces license limit gateway_peers.
 * Returns { peer, apiToken, pushToken } (plaintext tokens only shown ONCE at creation
 * for inclusion in gateway.env file).
 *
 * ASYNC because peers.create() generates WireGuard keys asynchronously.
 */
async function createGateway({ name, apiPort = DEFAULT_API_PORT }) {
  const db = getDb();

  const limit = license.getFeatureLimit('gateway_peers');
  const current = db.prepare("SELECT COUNT(*) AS n FROM peers WHERE peer_type='gateway'").get().n;
  if (limit !== -1 && current >= limit) {
    throw new Error(`License limit reached: gateway_peers=${limit} (current=${current})`);
  }

  // peers.create() is the existing async factory — we extend its param list to accept peerType
  const peer = await peers.create({ name, peerType: 'gateway' });

  const { apiToken, apiTokenHash, pushToken, pushTokenEncrypted } = generateTokens();

  db.prepare(`
    INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(peer.id, apiPort, apiTokenHash, pushTokenEncrypted, Date.now());

  logger.info({ peerId: peer.id, peerName: name, apiPort }, 'Gateway created');

  return { peer, apiToken, pushToken };
}

module.exports = { createGateway };
