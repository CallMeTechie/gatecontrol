// src/routes/api/portal.js
'use strict';
const { Router } = require('express');
const peers = require('../../services/peers');
const routesSvc = require('../../services/routes');
const caddyAcl = require('../../services/caddyAcl');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');

const router = Router();

function unidentified(res) {
  return res.json({ ok: true, data: null, reason: 'unidentified' });
}

// Convert JS Date to 'YYYY-MM-DD HH:MM:SS' (UTC, no ms) for comparison
// with SQLite's datetime('now') output format.
function toSQLite(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

router.get('/device', async (req, res) => {
  try {
    if (req.portalPeerId == null) return unidentified(res);
    const all = await peers.getAll(); // async — merges live wg status
    const p = all.find(x => x.id === req.portalPeerId);
    if (!p) return unidentified(res);
    res.json({ ok: true, data: {
      id: p.id,
      name: p.name,
      isOnline: p.isOnline,
      latestHandshake: p.latestHandshake,
      transferRx: p.transferRx,
      transferTx: p.transferTx,
      allowed_ips: p.allowed_ips,
      dns: p.dns,
    } });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /device failed');
    return unidentified(res);
  }
});

router.get('/traffic', (req, res) => {
  try {
    if (req.portalPeerId == null) return unidentified(res);
    const p = peers.getById(req.portalPeerId); // sync
    if (!p) return unidentified(res);
    const db = getDb();
    const peerId = Number(req.portalPeerId);

    // Period totals (back-compat)
    const periods = [
      ['last24h', '-24 hours'],
      ['last7d', '-7 days'],
      ['last30d', '-30 days'],
    ];
    const traffic = { total: { rx: p.total_rx || 0, tx: p.total_tx || 0 } };
    for (const [key, interval] of periods) {
      const row = db.prepare(`
        SELECT COALESCE(SUM(download_bytes),0) rx, COALESCE(SUM(upload_bytes),0) tx
        FROM peer_traffic_snapshots WHERE peer_id = ? AND recorded_at >= datetime('now', ?)
      `).get(peerId, interval);
      traffic[key] = { rx: row.rx, tx: row.tx };
    }

    // Time-series buckets — stable counts regardless of data density.
    // Shape: { t: ISO-string (bucket start), rx: number, tx: number }
    // Buckets with no data → rx:0, tx:0 (axis stability).
    //
    // Prepare once; called 8 + 7 + 5 = 20 times — all parameterised.
    const bucketStmt = db.prepare(`
      SELECT COALESCE(SUM(download_bytes), 0) rx, COALESCE(SUM(upload_bytes), 0) tx
      FROM peer_traffic_snapshots
      WHERE peer_id = ? AND recorded_at >= ? AND recorded_at < ?
    `);
    function buildSeries(startMs, count, widthMs) {
      return Array.from({ length: count }, (_, i) => {
        const s = new Date(startMs + i * widthMs);
        const e = new Date(startMs + (i + 1) * widthMs);
        const row = bucketStmt.get(peerId, toSQLite(s), toSQLite(e));
        return { t: s.toISOString(), rx: row.rx, tx: row.tx };
      });
    }
    const nowMs = Date.now();
    const H = 3600000;   // 1 h in ms
    const D = 86400000;  // 1 d in ms
    traffic.series = {
      '24h': buildSeries(nowMs - 24 * H, 8, 3 * H),  // 8 x 3 h
      '7d':  buildSeries(nowMs - 7 * D,  7, D),       // 7 x 1 d
      '30d': buildSeries(nowMs - 30 * D, 5, 6 * D),   // 5 x 6 d
    };

    res.json({ ok: true, data: traffic });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /traffic failed');
    return unidentified(res);
  }
});

router.get('/services', (req, res) => {
  try {
    if (req.portalPeerId == null) return unidentified(res);
    const all = routesSvc.getAll().filter(r => r.enabled && r.route_type === 'http');
    const visible = all.filter(r => {
      if (!r.acl_enabled) return true; // open route — always reachable
      const aclPeers = caddyAcl.getAclPeers(r.id) || [];
      return aclPeers.some(p => p.peer_id === req.portalPeerId);
    }).map(r => ({
      id: r.id,
      name: r.description || r.domain,
      domain: r.domain,
      kind: 'http',
    }));
    res.json({ ok: true, data: visible });
  } catch (err) {
    logger.error({ error: err.message }, 'portal /services failed');
    return unidentified(res);
  }
});

module.exports = router;
