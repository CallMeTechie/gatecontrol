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

// ─── Chart buckets ──────────────────────────────────────
//
// A chart period is a fixed number of buckets that ENDS with the bucket that
// contains `now` (the current, still filling one included). Buckets without
// snapshots are returned as 0 so the time axis is continuous. recorded_at is
// UTC ('YYYY-MM-DD HH:MM:SS', datetime('now')); minute/hour buckets are
// reported as ISO UTC instants (the browser renders them in local time), day
// buckets as plain UTC dates ('YYYY-MM-DD').
const PERIODS = {
  '1h': { unit: 'minute', count: 60, fmt: '%Y-%m-%d %H:%M' },
  '24h': { unit: 'hour', count: 24, fmt: '%Y-%m-%d %H:00' },
  '7d': { unit: 'day', count: 7, fmt: '%Y-%m-%d' },
  '30d': { unit: 'day', count: 30, fmt: '%Y-%m-%d' },
};
const UNIT_MS = { minute: 60000, hour: 3600000, day: 86400000 };

const pad2 = (n) => String(n).padStart(2, '0');
function sqlKey(d, unit) {
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (unit === 'day') return day;
  if (unit === 'hour') return `${day} ${pad2(d.getUTCHours())}:00`;
  return `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
function floorTo(ms, unit) { return Math.floor(ms / UNIT_MS[unit]) * UNIT_MS[unit]; }

/**
 * The bucket frame of a period: { unit, keys: [sqlKey…] oldest → newest,
 * times: [label…], from: 'YYYY-MM-DD HH:MM:SS' (start of the oldest bucket) }.
 */
function bucketFrame(period, now = Date.now()) {
  const p = PERIODS[period] || PERIODS['1h'];
  const last = floorTo(now, p.unit);
  const keys = [];
  const times = [];
  for (let i = p.count - 1; i >= 0; i--) {
    const d = new Date(last - i * UNIT_MS[p.unit]);
    keys.push(sqlKey(d, p.unit));
    times.push(p.unit === 'day' ? sqlKey(d, 'day') : d.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }
  const first = new Date(last - (p.count - 1) * UNIT_MS[p.unit]);
  const from = first.toISOString().slice(0, 19).replace('T', ' ');
  return { unit: p.unit, fmt: p.fmt, keys, times, from };
}

function fillFrame(frame, rows, map) {
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return frame.keys.map((k, i) => map(byKey.get(k) || null, frame.times[i]));
}

/**
 * Traffic data points for the dashboard chart: the most recent N buckets in
 * ascending order, including the current partial bucket, gaps filled with 0.
 * @param {string} period - '1h' (60 × 1 min), '24h' (24 × 1 h), '7d' / '30d' (days)
 * @param {{now?: number}} [opts]
 */
function getChartData(period = '1h', { now = Date.now() } = {}) {
  const frame = bucketFrame(PERIODS[period] ? period : '1h', now);
  const rows = getDb().prepare(`
    SELECT
      strftime(?, recorded_at) as bucket,
      SUM(upload_bytes) as upload_delta,
      SUM(download_bytes) as download_delta,
      AVG(peer_count) as avg_peers
    FROM traffic_snapshots
    WHERE recorded_at >= ?
    GROUP BY bucket
  `).all(frame.fmt, frame.from);

  return fillFrame(frame, rows, (r, time) => ({
    time,
    upload: (r && r.upload_delta) || 0,
    download: (r && r.download_delta) || 0,
    peers: Math.round((r && r.avg_peers) || 0),
  }));
}

/** Unit of a chart period's buckets ('minute' | 'hour' | 'day'). */
function chartUnit(period) { return (PERIODS[period] || PERIODS['1h']).unit; }

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
 * Get per-peer traffic chart data (same bucket frame as getChartData).
 * @param {number} peerId
 * @param {string} period - '24h', '7d', '30d'
 */
function getPeerChartData(peerId, period = '24h', { now = Date.now() } = {}) {
  const frame = bucketFrame(['7d', '30d'].includes(period) ? period : '24h', now);
  const rows = getDb().prepare(`
    SELECT
      strftime(?, recorded_at) as bucket,
      SUM(upload_bytes) as upload_delta,
      SUM(download_bytes) as download_delta
    FROM peer_traffic_snapshots
    WHERE peer_id = ? AND recorded_at >= ?
    GROUP BY bucket
  `).all(frame.fmt, peerId, frame.from);

  return fillFrame(frame, rows, (r, time) => ({
    time,
    upload: (r && r.upload_delta) || 0,
    download: (r && r.download_delta) || 0,
  }));
}

/**
 * Top peers by traffic since the start of the current UTC day (`today`) or
 * over the last 24 hours (`24h`), aggregated in SQL over
 * peer_traffic_snapshots (indexed by recorded_at). Peers without traffic in
 * the window are not listed.
 * → [{ peer_id, name, peer_type, upload, download, total, latest_handshake }]
 */
function getTopPeers({ period = 'today', limit = 5, now = Date.now() } = {}) {
  const lim = Math.min(20, Math.max(1, parseInt(limit, 10) || 5));
  const d = new Date(now);
  const from = period === '24h'
    ? new Date(now - 86400000).toISOString().slice(0, 19).replace('T', ' ')
    : `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} 00:00:00`;
  return getDb().prepare(`
    SELECT p.id AS peer_id, p.name, COALESCE(p.peer_type, 'regular') AS peer_type,
           p.latest_handshake, p.enabled,
           t.upload, t.download, t.upload + t.download AS total
    FROM (
      SELECT peer_id, SUM(upload_bytes) AS upload, SUM(download_bytes) AS download
      FROM peer_traffic_snapshots
      WHERE recorded_at >= ?
      GROUP BY peer_id
    ) t
    JOIN peers p ON p.id = t.peer_id
    WHERE t.upload + t.download > 0
    ORDER BY total DESC, p.name COLLATE NOCASE
    LIMIT ?
  `).all(from, lim).map((r) => ({
    peer_id: r.peer_id,
    name: r.name,
    peer_type: r.peer_type,
    enabled: !!r.enabled,
    upload: r.upload || 0,
    download: r.download || 0,
    total: r.total || 0,
    latest_handshake: r.latest_handshake || 0,
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
  getTopPeers,
  bucketFrame,
  chartUnit,
  PERIODS,
  getTodayTotals,
  startCollector,
  stopCollector,
  cleanup,
};
