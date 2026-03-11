'use strict';

const { getDb } = require('../db/connection');
const wireguard = require('./wireguard');
const activity = require('./activity');
const logger = require('../utils/logger');

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

    for (const wgPeer of status.peers) {
      const peer = db.prepare('SELECT id, name, public_key FROM peers WHERE public_key = ?')
        .get(wgPeer.publicKey);

      if (!peer) continue;

      // Update transfer stats in DB
      db.prepare(`
        UPDATE peers
        SET transfer_rx = ?, transfer_tx = ?, latest_handshake = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(wgPeer.transferRx, wgPeer.transferTx, wgPeer.latestHandshake, peer.id);

      // Detect state changes
      const wasOnline = previousState.get(wgPeer.publicKey);
      if (wasOnline !== undefined && wasOnline !== wgPeer.isOnline) {
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
      }

      previousState.set(wgPeer.publicKey, wgPeer.isOnline);
    }
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
  pollInterval = setInterval(pollPeerStatus, intervalMs);
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
