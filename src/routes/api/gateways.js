'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const gatewaySetup = require('../../services/gatewaySetup');

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
      g.discovery = require('../../services/gateways').getDiscoverySettings(g.peer_id) || { enabled: 0, active_scan: 0 };
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

// Read a gateway's reported LAN subnets + capability flag from last_health.
function _gatewayTelemetry(id) {
  const db = getDb();
  const row = db.prepare(`SELECT p.peer_type, p.enabled, gm.last_health FROM peers p JOIN gateway_meta gm ON gm.peer_id=p.id WHERE p.id=?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) return null;
  let tel = {};
  try { tel = (JSON.parse(row.last_health || '{}').telemetry) || {}; } catch { tel = {}; }
  return tel;
}

router.put('/:id/discovery-settings', require('../../middleware/license').requireFeature('gateway_lan_discovery'), (req, res) => {
  const id = Number(req.params.id);
  const tel = _gatewayTelemetry(id);
  if (!tel) return res.status(404).json({ ok: false, error: 'not_found' });
  const reported = Array.isArray(tel.lan_subnets) ? tel.lan_subnets : [];
  const reportedCidrs = new Set(reported.map(s => s.cidr));
  const primaryCidr = (reported.find(s => s.primary) || reported[0] || {}).cidr;
  const reportedCats = new Set((tel.lan_discovery_categories || []).map(c => c.key));

  const { enabled, active_scan, subnets, category_mode, categories } = req.body || {};
  const subs = Array.isArray(subnets) ? subnets : [];
  for (const c of subs) if (!reportedCidrs.has(c)) return res.status(400).json({ ok: false, error: 'subnet_not_reported', cidr: c });
  const license = require('../../services/license');
  const isMulti = subs.length > 1 || (subs.length === 1 && subs[0] !== primaryCidr);
  if (isMulti && !license.hasFeature('gateway_lan_discovery_multi_subnet')) {
    return res.status(403).json({ ok: false, error: 'gateway_lan_discovery_multi_subnet not licensed' });
  }
  if (category_mode !== undefined && !['include', 'exclude'].includes(category_mode)) return res.status(400).json({ ok: false, error: 'bad_category_mode' });
  const cats = Array.isArray(categories) ? categories.filter(k => reportedCats.has(k)) : [];

  require('../../services/gateways').setDiscoverySettings(id, {
    enabled: enabled === true || enabled === 1, active_scan: active_scan === true || active_scan === 1,
    subnets: subs, category_mode, categories: cats,
  });
  res.json({ ok: true });
});

router.post('/:id/discover', require('../../middleware/license').requireFeature('gateway_lan_discovery'), async (req, res) => {
  const id = Number(req.params.id);
  const tel = _gatewayTelemetry(id);
  if (!tel) return res.status(404).json({ ok: false, error: 'not_found' });
  if (tel.lan_discovery !== true) return res.status(409).json({ ok: false, error: 'capability_unavailable' }); // gateway too old / Phase 1-only

  const gateways = require('../../services/gateways');
  const settings = gateways.getDiscoverySettings(id);
  if (!settings || !settings.enabled) return res.status(409).json({ ok: false, error: 'discovery_disabled' });

  const discoveryCache = require('../../services/discoveryCache');
  const force = req.body && req.body.force === true;
  if (discoveryCache.inFlight(id) && !force) return res.status(409).json({ ok: false, error: 'scan_in_progress' });
  if (force) discoveryCache.cancel(id);

  // Resolve subnets: clamp to the primary unless multi-subnet is licensed.
  const license = require('../../services/license');
  const reported = Array.isArray(tel.lan_subnets) ? tel.lan_subnets : [];
  const primaryCidr = (reported.find(s => s.primary) || reported[0] || {}).cidr;
  let subnets = (settings.subnets && settings.subnets.length) ? settings.subnets : (primaryCidr ? [primaryCidr] : []);
  if (!license.hasFeature('gateway_lan_discovery_multi_subnet')) subnets = primaryCidr ? [primaryCidr] : [];
  if (subnets.length === 0) return res.status(409).json({ ok: false, error: 'no_subnet' });

  const SCAN_TIMEOUT_MS = 45000;            // sent to the gateway (matches its default GC_DISCOVERY_TIMEOUT_MS)
  const graceMs = SCAN_TIMEOUT_MS + 15000;  // §5.4: declare orphaned after timeout + 15s
  const requestId = require('node:crypto').randomUUID();
  discoveryCache.begin(id, requestId, graceMs);
  const r = await gateways.notifyLanScan(id, {
    request_id: requestId, subnets, category_mode: settings.category_mode, categories: settings.categories,
    active_scan: !!settings.active_scan, timeout_ms: SCAN_TIMEOUT_MS,
  });
  if (!r || r.accepted !== true) { discoveryCache.cancel(id); return res.status(502).json({ ok: false, error: 'gateway_unreachable' }); }

  // §10 audit log.
  require('../../services/activity').log('gateway_scan_triggered',
    `Gateway ${id} LAN scan requested (${subnets.join(', ')})`,
    { source: 'admin', severity: 'info', details: { peer_id: id, request_id: requestId, subnets, active_scan: !!settings.active_scan } });

  // §5.4 terminal SSE event if the gateway never reports `done` within the grace —
  // so the admin UI spinner never hangs. get() lazily marks done+timed_out once past grace.
  setTimeout(() => {
    const snap = discoveryCache.get(id);
    if (snap && snap.request_id === requestId && snap.timed_out) {
      require('../../services/eventBus').publish('gateway_discovery',
        { peer_id: id, request_id: requestId, devices: snap.devices, done: true, timed_out: true });
    }
  }, graceMs + 250).unref();

  res.status(202).json({ ok: true, request_id: requestId, subnets_scanned: subnets });
});

router.get('/:id/discovered', require('../../middleware/license').requireFeature('gateway_lan_discovery'), (req, res) => {
  const id = Number(req.params.id);
  if (!_gatewayTelemetry(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  const snap = require('../../services/discoveryCache').get(id);
  res.json({ ok: true, devices: snap ? snap.devices : [], in_flight: snap ? snap.in_flight : false, done: snap ? snap.done : false, timed_out: snap ? snap.timed_out : false, updated_at: snap ? snap.updated_at : null });
});

function _setupGatewayOr4xx(req, res) {
  const id = Number(req.params.id);
  const row = getDb().prepare(`SELECT p.id, p.peer_type, p.enabled
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id WHERE p.id = ?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  if (!require('../../services/license').hasFeature('gateway_fleet')) { res.status(403).json({ ok: false, error: 'gateway_fleet not licensed' }); return null; }
  return { id: row.id };
}

// Serve the generic gateway update.sh for the "set up auto-update" guide (the host drops it next
// to its compose and runs it via a 1-minute trigger). No tailoring — the script is generic.
router.get('/:id/update-sh', (req, res) => {
  if (!_setupGatewayOr4xx(req, res)) return;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="update.sh"');
  res.set('Cache-Control', 'no-store');
  res.send(gatewaySetup.readUpdateSh());
});

module.exports = router;
