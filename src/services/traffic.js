'use strict';

const { getDb } = require('../db/connection');
const wireguard = require('./wireguard');
const logger = require('../utils/logger');

let collectorInterval = null;
let previousTotals = null;

/**
 * Take a traffic snapshot and store it
 */
async function takeSnapshot() {
  try {
    const totals = await wireguard.getTransferTotals();
    const db = getDb();

    db.prepare(`
      INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count)
      VALUES (?, ?, ?)
    `).run(totals.totalTx, totals.totalRx, totals.peerCount);

    previousTotals = totals;
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to take traffic snapshot');
  }
}

/**
 * Get current transfer rates (bytes/sec since last snapshot)
 */
async function getCurrentRates() {
  const totals = await wireguard.getTransferTotals();

  if (!previousTotals) {
    previousTotals = totals;
    return { uploadRate: 0, downloadRate: 0 };
  }

  const interval = 60; // seconds between snapshots
  const uploadRate = Math.max(0, Math.round((totals.totalTx - previousTotals.totalTx) / interval));
  const downloadRate = Math.max(0, Math.round((totals.totalRx - previousTotals.totalRx) / interval));

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
      MAX(upload_bytes) - MIN(upload_bytes) as upload_delta,
      MAX(download_bytes) - MIN(download_bytes) as download_delta,
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
      COALESCE(MAX(upload_bytes) - MIN(upload_bytes), 0) as upload_today,
      COALESCE(MAX(download_bytes) - MIN(download_bytes), 0) as download_today
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
 * Cleanup old snapshots (keep last N days)
 */
function cleanup(daysToKeep = 30) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM traffic_snapshots
    WHERE recorded_at < datetime('now', '-' || ? || ' days')
  `).run(daysToKeep);
  return result.changes;
}

module.exports = {
  takeSnapshot,
  getCurrentRates,
  getChartData,
  getTodayTotals,
  startCollector,
  stopCollector,
  cleanup,
};
