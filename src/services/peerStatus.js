'use strict';

const { getDb } = require('../db/connection');
const wireguard = require('./wireguard');
const activity = require('./activity');
const logger = require('../utils/logger');
const eventBus = require('./eventBus');

let pollInterval = null;
const previousState = new Map(); // pubkey -> isOnline

/**
 * Poll WireGuard for peer status changes and log them
 */
async function pollPeerStatus() {
  try {
    const status = await wireguard.getStatus();
    if (!status.running) return;

    const db = getDb();
    const byKey = new Map();
    const find = db.prepare('SELECT id, name, public_key, transfer_rx, transfer_tx, latest_handshake FROM peers WHERE public_key = ?');
    const update = db.prepare(`
      UPDATE peers
      SET transfer_rx = ?, transfer_tx = ?, latest_handshake = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const changes = [];
    // the counters of every peer in one transaction (one commit, not one per peer), only what changed
    db.transaction(() => {
      for (const wgPeer of status.peers) {
        const peer = find.get(wgPeer.publicKey);
        if (!peer) continue;
        byKey.set(wgPeer.publicKey, peer);
        if (peer.transfer_rx !== wgPeer.transferRx || peer.transfer_tx !== wgPeer.transferTx || peer.latest_handshake !== wgPeer.latestHandshake) {
          update.run(wgPeer.transferRx, wgPeer.transferTx, wgPeer.latestHandshake, peer.id);
        }
        const wasOnline = previousState.get(wgPeer.publicKey);
        if (wasOnline !== undefined && wasOnline !== wgPeer.isOnline) changes.push({ peer, wgPeer });
        previousState.set(wgPeer.publicKey, wgPeer.isOnline);
      }
    })();

    // Detect state changes (activity log, notifications, live events) — after the commit
    for (const { peer, wgPeer } of changes) {
      if (wgPeer.isOnline) {
        activity.log('peer_connected', `${peer.name} connected`, {
          source: 'wireguard',
          severity: 'success',
          details: { peerId: peer.id, ip: wgPeer.allowedIps },
        });
        logger.info({ peer: peer.name }, 'Peer connected');
      } else {
        activity.log('peer_disconnected', `${peer.name} disconnected (timeout)`, {
          source: 'wireguard',
          severity: 'warning',
          details: { peerId: peer.id },
        });
        logger.info({ peer: peer.name }, 'Peer disconnected');
      }
      eventBus.publish('peer', { peerId: peer.id, name: peer.name, connected: wgPeer.isOnline });
    }

    // VPN misuse (services/vpnGuard.js): one key at two places, a new country.
    await require('./vpnGuard').observe(status.peers, byKey);
  } catch (err) {
    logger.error({ error: err.message }, 'Peer status poll failed');
  }
}

/**
 * Start periodic peer status polling
 */
function startPoller(intervalMs = 30000) {
  if (pollInterval) return;
  logger.info({ intervalMs }, 'Starting peer status poller');
  pollPeerStatus();
  pollInterval = setInterval(require('../utils/loopStall').task('peers.status', pollPeerStatus), intervalMs);
}

/**
 * Stop peer status polling
 */
function stopPoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info('Peer status poller stopped');
  }
}

module.exports = {
  pollPeerStatus,
  startPoller,
  stopPoller,
};
