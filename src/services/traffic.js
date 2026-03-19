'use strict';

const { getDb } = require('../db/connection');
const wireguard = require('./wireguard');
const logger = require('../utils/logger');

let collectorInterval = null;
let previousTotals = null;
let previousTimestamp = null;
let previousPeerTransfers = new Map(); // publicKey → { rx, tx }

/**
 * Take a traffic snapshot and store it
 */
async function takeSnapshot() {
  try {
    const status = await wireguard.getStatus();
    const db = getDb();

    // Calculate aggregate totals
    let totalTx = 0, totalRx = 0;
    for (const p of status.peers) {
      totalTx += p.transferTx;
      totalRx += p.transferRx;
    }
    const totals = { totalTx, totalRx, peerCount: status.peers.length };

    // Store aggregate delta
    let uploadDelta = 0;
    let downloadDelta = 0;
    if (previousTotals) {
      const txDiff = totals.totalTx - previousTotals.totalTx;
      const rxDiff = totals.totalRx - previousTotals.totalRx;
      uploadDelta = txDiff >= 0 ? txDiff : 0;
      downloadDelta = rxDiff >= 0 ? rxDiff : 0;
    }

    db.prepare(`
      INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count)
      VALUES (?, ?, ?)
    `).run(uploadDelta, downloadDelta, totals.peerCount);

    // Store per-peer deltas and accumulate totals
    const peerByKey = new Map();
    const dbPeers = db.prepare('SELECT id, public_key FROM peers').all();
    for (const p of dbPeers) peerByKey.set(p.public_key, p.id);

    const insertPeerSnapshot = db.prepare(`
      INSERT INTO peer_traffic_snapshots (peer_id, upload_bytes, download_bytes)
      VALUES (?, ?, ?)
    `);
    const updatePeerTotals = db.prepare(`
      UPDATE peers SET total_tx = total_tx + ?, total_rx = total_rx + ? WHERE id = ?
    `);

    const savePeerDeltas = db.transaction(() => {
      for (const peer of status.peers) {
        const peerId = peerByKey.get(peer.publicKey);
        if (!peerId) continue;

        const prev = previousPeerTransfers.get(peer.publicKey);
        let peerTxDelta = 0, peerRxDelta = 0;
        if (prev) {
          const txDiff = peer.transferTx - prev.tx;
          const rxDiff = peer.transferRx - prev.rx;
          peerTxDelta = txDiff >= 0 ? txDiff : 0;
          peerRxDelta = rxDiff >= 0 ? rxDiff : 0;
        }

        if (peerTxDelta > 0 || peerRxDelta > 0) {
          insertPeerSnapshot.run(peerId, peerTxDelta, peerRxDelta);
          updatePeerTotals.run(peerTxDelta, peerRxDelta, peerId);
        }
      }
    });
    savePeerDeltas();

    // Update previous state
    const newPeerTransfers = new Map();
    for (const peer of status.peers) {
      newPeerTransfers.set(peer.publicKey, { tx: peer.transferTx, rx: peer.transferRx });
    }
    previousPeerTransfers = newPeerTransfers;
    previousTotals = totals;
    previousTimestamp = Date.now();
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to take traffic snapshot');
  }
}

/**
 * Get current transfer rates (bytes/sec since last snapshot)
 */
async function getCurrentRates() {
  const totals = await wireguard.getTransferTotals();

  if (!previousTotals || !previousTimestamp) {
    previousTotals = totals;
    previousTimestamp = Date.now();
    return { uploadRate: 0, downloadRate: 0 };
  }

  const elapsedSec = Math.max(1, (Date.now() - previousTimestamp) / 1000);
  const txDelta = totals.totalTx - previousTotals.totalTx;
  const rxDelta = totals.totalRx - previousTotals.totalRx;

  // Detect counter reset (WireGuard interface restart) — skip negative deltas
  const uploadRate = txDelta >= 0 ? Math.round(txDelta / elapsedSec) : 0;
  const downloadRate = rxDelta >= 0 ? Math.round(rxDelta / elapsedSec) : 0;

  return { uploadRate, downloadRate };
}

/**
 * Get traffic data points for charting
 * @param {string} period - '1h', '24h', '7d'
 */
function getChartData(period = '1h') {
  const db = getDb();

  let interval;
  let groupBy;
  let limit;

  switch (period) {
    case '24h':
      interval = '-24 hours';
      groupBy = '%Y-%m-%d %H:00';
      limit = 24;
      break;
    case '7d':
      interval = '-7 days';
      groupBy = '%Y-%m-%d';
      limit = 7;
      break;
    default: // 1h
      interval = '-1 hours';
      groupBy = '%Y-%m-%d %H:%M';
      limit = 60;
      break;
  }

  const rows = db.prepare(`
    SELECT
      strftime(?, recorded_at) as bucket,
      SUM(upload_bytes) as upload_delta,
      SUM(download_bytes) as download_delta,
      AVG(peer_count) as avg_peers
    FROM traffic_snapshots
    WHERE recorded_at >= datetime('now', ?)
    GROUP BY bucket
    ORDER BY bucket ASC
    LIMIT ?
  `).all(groupBy, interval, limit);

  return rows.map(r => ({
    time: r.bucket,
    upload: r.upload_delta || 0,
    download: r.download_delta || 0,
    peers: Math.round(r.avg_peers || 0),
  }));
}

/**
 * Get traffic totals for today
 */
function getTodayTotals() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(upload_bytes), 0) as upload_today,
      COALESCE(SUM(download_bytes), 0) as download_today
    FROM traffic_snapshots
    WHERE recorded_at >= datetime('now', 'start of day')
  `).get();

  return {
    upload: row ? row.upload_today : 0,
    download: row ? row.download_today : 0,
    total: row ? row.upload_today + row.download_today : 0,
  };
}

/**
 * Start periodic traffic collection
 */
function startCollector(intervalMs = 60000) {
  if (collectorInterval) return;
  logger.info({ intervalMs }, 'Starting traffic collector');
  takeSnapshot(); // Initial snapshot
  collectorInterval = setInterval(takeSnapshot, intervalMs);
}

/**
 * Stop periodic traffic collection
 */
function stopCollector() {
  if (collectorInterval) {
    clearInterval(collectorInterval);
    collectorInterval = null;
    logger.info('Traffic collector stopped');
  }
}

/**
 * Get per-peer traffic chart data
 * @param {number} peerId
 * @param {string} period - '24h', '7d', '30d'
 */
function getPeerChartData(peerId, period = '24h') {
  const db = getDb();

  let interval, groupBy, limit;
  switch (period) {
    case '7d':
      interval = '-7 days';
      groupBy = '%Y-%m-%d';
      limit = 7;
      break;
    case '30d':
      interval = '-30 days';
      groupBy = '%Y-%m-%d';
      limit = 30;
      break;
    default: // 24h
      interval = '-24 hours';
      groupBy = '%Y-%m-%d %H:00';
      limit = 24;
      break;
  }

  const rows = db.prepare(`
    SELECT
      strftime(?, recorded_at) as bucket,
      SUM(upload_bytes) as upload_delta,
      SUM(download_bytes) as download_delta
    FROM peer_traffic_snapshots
    WHERE peer_id = ? AND recorded_at >= datetime('now', ?)
    GROUP BY bucket
    ORDER BY bucket ASC
    LIMIT ?
  `).all(groupBy, peerId, interval, limit);

  return rows.map(r => ({
    time: r.bucket,
    upload: r.upload_delta || 0,
    download: r.download_delta || 0,
  }));
}

/**
 * Cleanup old snapshots (keep last N days)
 */
function cleanup(daysToKeep = 30) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM traffic_snapshots
    WHERE recorded_at < datetime('now', '-' || ? || ' days')
  `).run(daysToKeep);
  const peerResult = db.prepare(`
    DELETE FROM peer_traffic_snapshots
    WHERE recorded_at < datetime('now', '-' || ? || ' days')
  `).run(daysToKeep);
  return result.changes + peerResult.changes;
}

module.exports = {
  takeSnapshot,
  getCurrentRates,
  getChartData,
  getPeerChartData,
  getTodayTotals,
  startCollector,
  stopCollector,
  cleanup,
};
