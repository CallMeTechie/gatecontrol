'use strict';

const { Router } = require('express');
const config = require('../../../../config/default');
const peers = require('../../../services/peers');
const routes = require('../../../services/routes');
const settings = require('../../../services/settings');
const logger = require('../../../utils/logger');
const { requirePeerOwnership, verifyMachineBinding, routeAuthSummary, routeStatus } = require('./helpers');
const { getDb } = require('../../../db/connection');

const router = Router();

router.get('/traffic', (req, res) => {
  try {
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
    if (!peer) {
      return res.status(404).json({ ok: false, error: 'Peer not found' });
    }

    const db = getDb();

    // Total from peers table
    const totalRx = peer.total_rx || 0;
    const totalTx = peer.total_tx || 0;

    // Aggregated from snapshots for time periods
    const periods = [
      { key: 'last24h', interval: '-24 hours' },
      { key: 'last7d', interval: '-7 days' },
      { key: 'last30d', interval: '-30 days' },
    ];

    const traffic = {
      total: { rx: totalRx, tx: totalTx },
    };

    for (const { key, interval } of periods) {
      const row = db.prepare(`
        SELECT COALESCE(SUM(download_bytes), 0) as rx, COALESCE(SUM(upload_bytes), 0) as tx
        FROM peer_traffic_snapshots
        WHERE peer_id = ? AND recorded_at >= datetime('now', ?)
      `).get(Number(peerId), interval);
      traffic[key] = { rx: row.rx, tx: row.tx };
    }

    res.json({ ok: true, traffic });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get traffic stats');
    res.status(500).json({ ok: false, error: 'Failed to get traffic stats' });
  }
});

// ── Erreichbare Dienste ─────────────────────────────────────

/**
 * GET /api/v1/client/services
 * Returns list of configured HTTP routes (services) the client can access.
 *
 *   status    'up' | 'down' | null  (monitoring off / no verdict yet)
 *   auth      'route' | 'basic' | 'none'
 *   appLogin  true → POST /services/:id/open answers a one-time auto-login
 *             URL (route_auth.app_login, "Anmeldung aus den
 *             GateControl-Apps erlauben")
 */
router.get('/services', (req, res) => {
  try {
    const userId = req.tokenUserId || null;
    const filtered = routes.getForUser(userId);
    // One query for all route_auth rows instead of one per route.
    const authRows = new Map(getDb().prepare('SELECT route_id, app_login FROM route_auth').all()
      .map((row) => [row.route_id, row]));

    const services = filtered.map(r => ({
      id: r.id,
      name: r.name || r.domain,
      domain: r.domain,
      url: `https://${r.domain}`,
      hasAuth: r.route_auth_enabled === 1,
      tls: r.tls_mode || 'auto',
      status: routeStatus(r),
      ...routeAuthSummary(r, authRows.get(r.id)),
    }));

    res.json({ ok: true, services });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list services');
    res.status(500).json({ ok: false, error: 'Failed to list services' });
  }
});

/**
 * GET /api/v1/client/dns-check
 * Returns VPN DNS config so the client can verify DNS goes through VPN
 */
router.get('/dns-check', (req, res) => {
  const customDns = settings.get('custom_dns');
  const vpnDns = customDns || config.wireguard.dns.join(',');

  res.json({
    ok: true,
    vpnSubnet: config.wireguard.subnet,
    vpnDns,
    gatewayIp: config.wireguard.gatewayIp,
  });
});

// -- RDP (Remote Desktop) ---------------------------------------

/**
 * GET /api/v1/client/rdp
 * Returns RDP routes available for the current token
 */

module.exports = router;
