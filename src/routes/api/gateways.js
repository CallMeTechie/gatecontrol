'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const gatewaySetup = require('../../services/gatewaySetup');
const { createZip } = require('../../utils/zip');

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
 *                l4_listen_port, l4_protocol, wol_enabled, wol_mac }],
 *   }
 */
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT p.id, p.name, p.hostname, p.allowed_ips,
             gm.api_port, gm.last_seen_at, gm.last_health,
             gm.update_request_id, gm.update_requested_at, gm.update_target_version
      FROM peers p
      JOIN gateway_meta gm ON gm.peer_id = p.id
      WHERE p.peer_type = 'gateway' AND p.enabled = 1
      ORDER BY p.name COLLATE NOCASE
    `).all();

    const gatewaysSvc = require('../../services/gateways');
    const routeStmt = db.prepare(`
      SELECT id, domain, route_type, target_lan_host, target_lan_port,
             l4_listen_port, l4_protocol, wol_enabled, wol_mac
      FROM routes
      WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      ORDER BY domain
    `);

    const gateways = rows.map((row) => {
      let health = {};
      if (row.last_health) {
        try { health = JSON.parse(row.last_health); } catch (_) { /* ignore */ }
      }
      const status = gatewaysSvc.getHealthStatus(row.id);

      // When the gateway is offline, the last cached `route_reachability`
      // is stale by definition — anything behind a down gateway can't be
      // reachable. Force-mark it so UI dots don't lie. Also expose the
      // `stale` flag so clients can distinguish "freshly observed offline"
      // from "we have no idea anymore".
      if (status === 'offline' && Array.isArray(health.route_reachability) && health.route_reachability.length > 0) {
        health = {
          ...health,
          stale: true,
          route_reachability: health.route_reachability.map((r) => ({ ...r, reachable: false })),
        };
      }

      const _ust = gatewaysSvc._deriveUpdateState(row, health.telemetry || {});

      return {
        peer_id: row.id,
        name: row.name,
        hostname: row.hostname,
        ip: row.allowed_ips ? row.allowed_ips.split('/')[0] : null,
        api_port: row.api_port,
        status,
        last_seen_at: row.last_seen_at,
        health,
        routes: routeStmt.all(row.id),
        update_state: _ust.state,
        update_target_version: row.update_target_version || null,
        update_requested_at: row.update_requested_at || null,
      };
    });

    const latestVersion = require('../../services/gatewayRelease').getLatestVersion();
    const { compareVersions } = require('../../utils/version');
    for (const g of gateways) {
      const cur = g.health && g.health.telemetry ? g.health.telemetry.gateway_version : null;
      g.update_available = !!(latestVersion && cur && compareVersions(latestVersion, cur) > 0);
      // Terminal lifecycle states are surfaced once, then cleared so the
      // tracking columns don't pin a stale done/failed forever.
      if (g.update_state === 'done' || g.update_state === 'failed') {
        gatewaysSvc._clearUpdateTracking(g.peer_id);
      }
    }
    res.json({ ok: true, gateways, latest_version: latestVersion });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list gateways');
    res.status(500).json({ ok: false, error: req.t ? req.t('common.error') : 'Error' });
  }
});

// On-demand fresh-health re-check (session-authed; /api/v1 CSRF middleware guards
// this POST for session callers; token-auth exempt). Update action = 2b, not here.
router.post('/:id/probe', async (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  const result = await require('../../services/gateways').refreshHealth(peerId);
  if (result === null) return res.status(404).json({ ok: false, error: 'not a gateway' });
  res.json({ ok: true, reachable: result.reachable });
});

// Trigger a gateway self-update (#2b). Session-authed; CSRF-guarded by the
// /api/v1 middleware. Pushes a request_id-tagged self-update notification to
// the gateway's local API; only marks the request as pending in gateway_meta
// once the gateway accepts it (so a cooldown/unreachable push leaves the
// tracking columns NULL and the action remains retryable).
router.post('/:id/update', async (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const row = db.prepare(`SELECT p.id, p.peer_type, p.enabled, gm.last_health
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id WHERE p.id = ?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  const license = require('../../services/license');
  if (!license.hasFeature('gateway_fleet')) {
    return res.status(403).json({ ok: false, error: 'gateway_fleet not licensed' });
  }
  let health = {}; try { health = row.last_health ? JSON.parse(row.last_health) : {}; } catch { /* ignore */ }
  const tel = health.telemetry || {};
  if (!tel.state_dir_writable) {
    return res.status(409).json({ ok: false, error: 'not_migrated' });
  }
  const gateways = require('../../services/gateways');
  const requestId = crypto.randomUUID();
  const target = gateways._normalizeTargetVersion(require('../../services/gatewayRelease').getLatestVersion());
  const r = await gateways.notifySelfUpdate(id, { request_id: requestId, target_version: target });
  if (r && r.skipped === 'cooldown') {
    return res.json({ ok: true, queued: false, reason: 'cooldown' });
  }
  if (!r || r.ok === false) {
    // The push failed synchronously — we KNOW it didn't reach the gateway, so do
    // NOT set tracking columns (that would show a misleading "updating" banner for
    // the full timeout). Surface unreachable immediately; the admin retries.
    return res.json({ ok: true, queued: false, reason: 'unreachable' });
  }
  gateways.markUpdateRequested(id, requestId, target);
  require('../../services/activity').log('gateway_update_requested',
    `Gateway ${id} update requested (target ${target || 'latest'})`,
    { source: 'admin', severity: 'info', details: { peer_id: id, target, request_id: requestId } });
  res.json({ ok: true, queued: true });
});

function _setupGatewayOr4xx(req, res) {
  const id = Number(req.params.id);
  const row = getDb().prepare(`SELECT p.id, p.name, p.peer_type, p.enabled
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id WHERE p.id = ?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  if (!require('../../services/license').hasFeature('gateway_fleet')) { res.status(403).json({ ok: false, error: 'gateway_fleet not licensed' }); return null; }
  return { id: row.id, name: row.name };
}

router.get('/:id/setup-script', (req, res) => {
  const gw = _setupGatewayOr4xx(req, res); if (!gw) return;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="gatecontrol-gateway-setup-${gatewaySetup.slug(gw)}.sh"`);
  res.set('Cache-Control', 'no-store');
  res.send(gatewaySetup.renderScript(gw));
});

router.get('/:id/setup-bundle.zip', (req, res) => {
  const gw = _setupGatewayOr4xx(req, res); if (!gw) return;
  const zip = createZip(gatewaySetup.buildBundleFiles(gw));
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="gatecontrol-gateway-setup-${gatewaySetup.slug(gw)}.zip"`);
  res.set('Cache-Control', 'no-store');
  res.send(zip);
});

module.exports = router;
