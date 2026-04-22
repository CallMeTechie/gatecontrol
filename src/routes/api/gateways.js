'use strict';

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');

const router = Router();

/**
 * GET /api/v1/gateways — consolidated list of every enabled gateway peer
 * with its last-health snapshot (telemetry), state-machine status, api
 * port, and the routes that target it. One call renders the whole
 * "Home Gateways" section on the /peers page so the client doesn't have
 * to fan out N+1 /gateway-info fetches.
 *
 * Shape per gateway:
 *   {
 *     peer_id, name, hostname, ip, api_port,
 *     status,                       // "online" | "offline" | "degraded"
 *     last_seen_at,                 // epoch ms
 *     health: { … full last_health body, includes telemetry },
 *     routes: [{ id, domain, route_type, target_lan_host, target_lan_port,
 *                l4_listen_port, l4_protocol }],
 *   }
 */
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT p.id, p.name, p.hostname, p.allowed_ips,
             gm.api_port, gm.last_seen_at, gm.last_health
      FROM peers p
      JOIN gateway_meta gm ON gm.peer_id = p.id
      WHERE p.peer_type = 'gateway' AND p.enabled = 1
      ORDER BY p.name COLLATE NOCASE
    `).all();

    const gatewaysSvc = require('../../services/gateways');
    const routeStmt = db.prepare(`
      SELECT id, domain, route_type, target_lan_host, target_lan_port,
             l4_listen_port, l4_protocol
      FROM routes
      WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      ORDER BY domain
    `);

    const gateways = rows.map((row) => {
      let health = {};
      if (row.last_health) {
        try { health = JSON.parse(row.last_health); } catch (_) { /* ignore */ }
      }
      return {
        peer_id: row.id,
        name: row.name,
        hostname: row.hostname,
        ip: row.allowed_ips ? row.allowed_ips.split('/')[0] : null,
        api_port: row.api_port,
        status: gatewaysSvc.getHealthStatus(row.id),
        last_seen_at: row.last_seen_at,
        health,
        routes: routeStmt.all(row.id),
      };
    });

    res.json({ ok: true, gateways });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list gateways');
    res.status(500).json({ ok: false, error: req.t ? req.t('common.error') : 'Error' });
  }
});

module.exports = router;
