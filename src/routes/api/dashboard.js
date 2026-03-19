'use strict';

const { Router } = require('express');
const wireguard = require('../../services/wireguard');
const traffic = require('../../services/traffic');
const { getDb } = require('../../db/connection');

const router = Router();

/**
 * GET /api/dashboard/stats
 * Returns the 4 stat card values
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();
    const wgStatus = await wireguard.getStatus();

    // Peer counts
    const totalPeers = wgStatus.peers.length;
    const onlinePeers = wgStatus.peers.filter(p => p.isOnline).length;

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
 * GET /api/dashboard/traffic?period=1h|24h|7d
 * Returns chart data points
 */
router.get('/traffic', (req, res) => {
  try {
    const period = ['1h', '24h', '7d'].includes(req.query.period)
      ? req.query.period
      : '1h';

    const data = traffic.getChartData(period);
    res.json({ ok: true, period, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.dashboard.traffic') });
  }
});

module.exports = router;
