'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto');
const license = require('./license');
const peers = require('./peers');
const logger = require('../utils/logger');
const {
  computeConfigHash: libComputeConfigHash,
  CONFIG_HASH_VERSION,
} = require('@callmetechie/gatecontrol-config-hash');

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

/**
 * Build the gateway-config payload sent to a Gateway on poll.
 * Includes all HTTP + L4 routes with target_peer_id=peerId.
 */
function getGatewayConfig(peerId) {
  const db = getDb();

  const httpRoutes = db.prepare(`
    SELECT id, domain, target_kind, target_lan_host, target_lan_port,
           COALESCE(l4_protocol, 'http') AS protocol, wol_enabled, wol_mac
    FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      AND (route_type = 'http' OR route_type IS NULL)
    ORDER BY id
  `).all(peerId);

  const l4Routes = db.prepare(`
    SELECT id, l4_listen_port AS listen_port, target_lan_host, target_lan_port,
           wol_enabled, wol_mac
    FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      AND route_type = 'l4'
    ORDER BY id
  `).all(peerId);

  return {
    config_hash_version: CONFIG_HASH_VERSION,
    peer_id: peerId,
    routes: httpRoutes.map(r => ({
      id: r.id,
      domain: r.domain,
      target_kind: r.target_kind,
      target_lan_host: r.target_lan_host,
      target_lan_port: r.target_lan_port,
      protocol: r.protocol,
      wol_enabled: !!r.wol_enabled,
      ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
    })),
    l4_routes: l4Routes.map(r => ({
      id: r.id,
      listen_port: r.listen_port,
      target_lan_host: r.target_lan_host,
      target_lan_port: r.target_lan_port,
      wol_enabled: !!r.wol_enabled,
      ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
    })),
  };
}

/**
 * Compute SHA-256 hash of the gateway config for a peer. Delegates to the
 * shared library for byte-identical results with the Gateway side.
 */
function computeConfigHash(peerId) {
  const cfg = getGatewayConfig(peerId);
  return libComputeConfigHash(cfg);
}

/**
 * Record a heartbeat from a Gateway. Updates last_seen_at and last_health.
 * Feeds into monitoring state machine (Task 16).
 */
function handleHeartbeat(peerId, health) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE gateway_meta
    SET last_seen_at = ?, last_health = ?
    WHERE peer_id = ?
  `).run(now, JSON.stringify(health || {}), peerId);
  // Status-Transition-Logik wird in Task 16 hinzugefügt
}

/**
 * Record traffic counters reported by a Gateway. Stores latest snapshot in
 * gateway_meta.last_health JSON. Historisierung erfolgt später über peerStatus.
 */
function recordTrafficSnapshot(peerId, { rx_bytes, tx_bytes, active_connections }) {
  const db = getDb();
  const existing = db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id=?').get(peerId);
  const health = existing && existing.last_health ? JSON.parse(existing.last_health) : {};
  health.rx_bytes = rx_bytes;
  health.tx_bytes = tx_bytes;
  health.active_connections = active_connections;
  health.traffic_updated_at = Date.now();
  db.prepare('UPDATE gateway_meta SET last_health=? WHERE peer_id=?').run(JSON.stringify(health), peerId);
}

module.exports = { createGateway, getGatewayConfig, computeConfigHash, handleHeartbeat, recordTrafficSnapshot };
