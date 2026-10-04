'use strict';

const { Router } = require('express');
const wireguard = require('../../services/wireguard');
const traffic = require('../../services/traffic');
const logger = require('../../utils/logger');
const { getDb } = require('../../db/connection');

const router = Router();

/**
 * Split the WireGuard peers into clients and gateways. Both counts come from
 * the SAME source (`wg show` handshakes) — the dashboard used to subtract
 * the gateways' state-machine status from the handshake count, two sources
 * that disagree for up to a probe interval. Keys the database does not know
 * count as clients.
 */
function splitPeers(db, wgPeers) {
  const gatewayKeys = new Set(db.prepare("SELECT public_key FROM peers WHERE peer_type = 'gateway'").all().map((r) => r.public_key));
  const out = { clients: { total: 0, online: 0 }, gateways: { total: 0, online: 0 } };
  for (const p of wgPeers) {
    const bucket = gatewayKeys.has(p.publicKey) ? out.gateways : out.clients;
    bucket.total += 1;
    if (p.isOnline) bucket.online += 1;
  }
  return out;
}

/**
 * GET /api/dashboard/stats
 * Headline numbers: peers (all / clients / gateways by handshake), active
 * routes, monitoring, traffic today + current rates, WireGuard state.
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();
    const wgStatus = await wireguard.getStatus();

    // Peer counts
    const totalPeers = wgStatus.peers.length;
    const onlinePeers = wgStatus.peers.filter(p => p.isOnline).length;
    const split = splitPeers(db, wgStatus.peers);

    // Route counts
    const routeRow = db.prepare('SELECT COUNT(*) as count FROM routes WHERE enabled = 1').get();
    const activeRoutes = routeRow ? routeRow.count : 0;

    // Traffic today
    const todayTraffic = traffic.getTodayTotals();

    // Current rates
    const rates = await traffic.getCurrentRates();

    // Average latency (ping online peers)
    const avgLatency = await wireguard.getAverageLatency();

    // Monitoring summary
    const { getSummary: getMonitoringSummary } = require('../../services/monitor');
    const monitoring = getMonitoringSummary();

    res.json({
      ok: true,
      peers: {
        total: totalPeers,
        online: onlinePeers,
        clients: split.clients,
        gateways: split.gateways,
      },
      routes: {
        active: activeRoutes,
      },
      monitoring,
      traffic: {
        today: todayTraffic.total,
        todayUpload: todayTraffic.upload,
        todayDownload: todayTraffic.download,
        uploadRate: rates.uploadRate,
        downloadRate: rates.downloadRate,
      },
      wireguard: {
        running: wgStatus.running,
      },
      latency: avgLatency,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.dashboard.stats') });
  }
});

/**
 * GET /api/dashboard/problems
 * Everything that currently needs attention, assembled from existing data
 * (docs/feature-next-package.md S3 §1): offline gateways, entries whose LAN
 * target does not answer, certificates, update, off-site backups, WAF module.
 */
router.get('/problems', async (req, res) => {
  try {
    const problems = require('../../services/dashboardProblems');
    const data = await problems.list();
    res.json({ ok: true, ...data });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to assemble dashboard problems');
    res.status(500).json({ ok: false, error: req.t('error.dashboard.problems') });
  }
});

/**
 * GET /api/dashboard/traffic?period=1h|24h|7d|30d
 * The most recent buckets of the period, oldest first, the current (partial)
 * bucket last, gaps filled with 0 (services/traffic.js getChartData).
 * → { period, unit: 'minute'|'hour'|'day', data: [{ time, upload, download, peers }] }
 */
router.get('/traffic', (req, res) => {
  try {
    const period = Object.prototype.hasOwnProperty.call(traffic.PERIODS, req.query.period)
      ? req.query.period
      : '1h';

    const data = traffic.getChartData(period);
    res.json({ ok: true, period, unit: traffic.chartUnit(period), data });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.dashboard.traffic') });
  }
});

/**
 * GET /api/dashboard/top-peers?period=today|24h&limit=1..20 (default today, 5)
 * Peers with the most traffic in the window, aggregated in SQL over
 * peer_traffic_snapshots, plus the client counts of the peers card.
 * `online` uses the handshake the status poller stores (peers.latest_handshake)
 * with the same timeout as `wg show` (data.peer_online_timeout).
 * → { period, peers: [{ peer_id, name, peer_type, upload, download, total, online }],
 *     clients: { below_min, unreported } }
 */
router.get('/top-peers', (req, res) => {
  try {
    const period = req.query.period === '24h' ? '24h' : 'today';
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
    let timeoutS = 180;
    try { timeoutS = parseInt(require('../../services/settings').get('data.peer_online_timeout', '180'), 10) || 180; } catch { /* default */ }
    const nowS = Date.now() / 1000;
    const peers = traffic.getTopPeers({ period, limit }).map((p) => ({
      peer_id: p.peer_id,
      name: p.name,
      peer_type: p.peer_type,
      upload: p.upload,
      download: p.download,
      total: p.total,
      online: !!p.enabled && p.latest_handshake > 0 && nowS - p.latest_handshake < timeoutS,
    }));
    let belowMin = 0;
    let unreported = 0;
    try {
      const overview = require('../../services/clientUpdates').getOverview();
      belowMin = overview.products.reduce((n, p) => n + (p.below_min || 0), 0);
      unreported = overview.unreported || 0;
    } catch (err) { logger.debug({ err: err.message }, 'client versions unavailable'); }
    res.json({ ok: true, period, peers, clients: { below_min: belowMin, unreported } });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load top peers');
    res.status(500).json({ ok: false, error: req.t('error.dashboard.traffic') });
  }
});

/**
 * GET /api/dashboard/security-summary
 * The "Sicherheit (24 h)" card in one cached read
 * (services/dashboardSecurity.js): WAF (licence `waf`), failed logins,
 * bot blocker total (licence `bot_blocking`), Pi-hole (licence
 * `pihole_integration`), security check summary. Unlicensed parts are null.
 */
router.get('/security-summary', async (req, res) => {
  try {
    const userId = !req.tokenAuth && req.session && req.session.userId != null ? req.session.userId : null;
    const data = await require('../../services/dashboardSecurity').summary({ userId, lang: req.language || '', t: req.t });
    res.json({ ok: true, ...data });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to assemble the security summary');
    res.status(500).json({ ok: false, error: req.t('error.dashboard.stats') });
  }
});

module.exports = router;
