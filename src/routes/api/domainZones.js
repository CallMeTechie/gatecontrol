'use strict';

// Domain zones API (docs/feature-domain-zones.md), mounted under /api/v1:
//   GET  /zones                      PUT /zones/ui-mode
//   PUT  /domains/:id/gateway        PUT /domains/:id/defaults
//   POST /domains/:id/hosts
//   PUT/DELETE /hosts/:id            PUT /hosts/:id/toggle
//   PUT  /hosts/:id/gateway-override POST /hosts/:id/entries
//   POST /hosts/:id/scan-to-folder   GET /host-templates
//
// License limits are enforced HERE (and only here): services/hosts.js and
// services/domainZones.js check none, exactly like the route and bundle APIs.

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const domainZones = require('../../services/domainZones');
const hosts = require('../../services/hosts');
const hostTemplates = require('../../services/hostTemplates');
const settings = require('../../services/settings');
const license = require('../../services/license');
const { evaluateRouteLicense } = require('../../services/routeLicense');
const { requireLimit } = require('../../middleware/license');

const router = Router();

const UPGRADE_URL = 'https://callmetechie.de/products/gatecontrol/pricing';

const httpRouteCountFn = () => getDb().prepare("SELECT COUNT(*) as count FROM routes WHERE route_type = 'http' OR route_type IS NULL").get().count;
const l4RouteCountFn = () => getDb().prepare("SELECT COUNT(*) as count FROM routes WHERE route_type = 'l4'").get().count;

function deny(req, res, key, extra = {}) {
  return res.status(403).json({
    ok: false,
    error: req.t ? req.t(key) : key,
    upgrade_url: UPGRADE_URL,
    ...extra,
  });
}

function denyFeature(req, res, feature) {
  return deny(req, res, 'error.license.feature_not_available', { feature });
}

// Plain service errors (routes.create validation) → 400; see routes API.
const VALIDATION_RE = /is reserved|invalid|must be|required|tls |tls$|port range|conflicting_target|target_pool|not found|disabled|too long/i;

function handleError(req, res, err) {
  if (err.statusCode === 409 && err.conflict) {
    const c = err.conflict;
    const msg = c.suggestedPort
      ? req.t('error.bundles.port_conflict', { port: c.port, suggested: c.suggestedPort })
      : req.t('error.bundles.port_conflict_no_free', { port: c.port });
    return res.status(409).json({ ok: false, error: msg, code: err.code || 'BUNDLE_PORT_CONFLICT', conflict: c });
  }
  if (err.statusCode) {
    return res.status(err.statusCode).json({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  const msg = err.message || '';
  if (msg.includes('Caddy')) {
    return res.status(502).json({ ok: false, error: req.t('error.routes.caddy_unreachable') });
  }
  if (/already exists/i.test(msg)) {
    return res.status(409).json({ ok: false, error: msg, code: 'DOMAIN_CONFLICT' });
  }
  if (VALIDATION_RE.test(msg)) {
    return res.status(400).json({ ok: false, error: msg });
  }
  logger.error({ error: msg }, 'Domain zones operation failed');
  return res.status(500).json({ ok: false, error: 'Operation failed' });
}

function zoneRow(id) {
  const n = parseInt(id, 10);
  return Number.isInteger(n) ? getDb().prepare('SELECT * FROM domains WHERE id = ?').get(n) : null;
}

function hostRow(id) {
  const n = parseInt(id, 10);
  return Number.isInteger(n) ? getDb().prepare('SELECT * FROM service_bundles WHERE id = ?').get(n) : null;
}

const notFound = (res, what) => res.status(404).json({ ok: false, error: `${what} not found`, code: 'NOT_FOUND' });

// gateway_http_targets: same limit routes.js applies to HTTP routes pinned
// to a gateway peer. `adding` = HTTP routes this request moves onto it.
function gatewayHttpTargetsOk(req, res, peerId, adding) {
  if (!peerId || adding <= 0) return true;
  const limit = license.getFeatureLimit('gateway_http_targets');
  if (limit === -1) return true;
  const count = getDb().prepare(
    "SELECT COUNT(*) AS n FROM routes WHERE target_peer_id = ? AND target_kind = 'gateway' AND route_type = 'http'"
  ).get(Number(peerId)).n;
  if (count + adding > limit) {
    res.status(403).json({ ok: false, error: 'gateway_http_targets limit reached' });
    return false;
  }
  return true;
}

// License checks for moving existing entries onto `target` (zone gateway
// change, clearing an override). Mirrors the per-route gates of routes.js:
// pools need gateway_pool_failover, L4 behind a gateway needs
// gateway_tcp_routing, HTTP behind a gateway peer counts against
// gateway_http_targets.
function retargetLicenseOk(req, res, target, rows) {
  if (target.kind === 'pool' && !license.hasFeature('gateway_pool_failover')) {
    denyFeature(req, res, 'gateway_pool_failover');
    return false;
  }
  if (target.kind !== 'peer' && rows.some((r) => r.route_type === 'l4') && !license.hasFeature('gateway_tcp_routing')) {
    res.status(403).json({ ok: false, error: 'gateway_tcp_routing not licensed' });
    return false;
  }
  if (target.kind === 'gateway') {
    const adding = rows.filter((r) => r.route_type !== 'l4'
      && !(r.target_kind === 'gateway' && Number(r.target_peer_id) === Number(target.peer_id))).length;
    if (!gatewayHttpTargetsOk(req, res, target.peer_id, adding)) return false;
  }
  return true;
}

// ─── Zones ──────────────────────────────────────────────

router.get('/zones', (req, res) => {
  try {
    res.json({ ok: true, ...domainZones.listZones() });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.put('/zones/ui-mode', (req, res) => {
  const mode = req.body && req.body.mode;
  if (mode !== 'zones' && mode !== 'legacy') {
    return res.status(400).json({ ok: false, error: "mode must be 'zones' or 'legacy'" });
  }
  try {
    settings.set('ui_zones_page', mode === 'zones' ? 'true' : 'false');
    res.json({ ok: true, mode });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.put('/domains/:id/gateway', async (req, res) => {
  try {
    const zone = zoneRow(req.params.id);
    if (!zone) return notFound(res, 'Domain');
    const target = domainZones.validateTarget(req.body || {});
    const rows = getDb().prepare(`
      SELECT r.* FROM routes r JOIN service_bundles sb ON sb.id = r.bundle_id
      WHERE sb.domain_id = ? AND sb.gateway_override = 0
    `).all(zone.id);
    if (!retargetLicenseOk(req, res, target, rows)) return;
    const result = await domainZones.applyGateway(zone.id, target);
    res.json({ ok: true, zone: result });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.put('/domains/:id/defaults', (req, res) => {
  try {
    const zone = domainZones.updateDefaults(req.params.id, req.body || {});
    res.json({ ok: true, zone });
  } catch (err) {
    handleError(req, res, err);
  }
});

// Combined check before anything is inserted (like POST /service-bundles):
// the per-route requireLimit middleware can't see how many rows one host adds.
router.post('/domains/:id/hosts', async (req, res) => {
  try {
    const zone = zoneRow(req.params.id);
    if (!zone) return notFound(res, 'Domain');
    const body = req.body || {};
    const { http, l4 } = hosts.toBundleExposures(hosts.resolveEntries(body));
    const kind = zone.gateway_kind;
    if (kind === 'pool' && !license.hasFeature('gateway_pool_failover')) return denyFeature(req, res, 'gateway_pool_failover');
    const verdict = evaluateRouteLicense({
      httpCount: http ? 1 : 0,
      l4Count: l4.length,
      targetKind: kind === 'peer' ? 'peer' : 'gateway',
      wol: false,
      scanEgress: false,
    });
    if (!verdict.ok) return deny(req, res, verdict.key, verdict.extra);
    if (kind === 'gateway' && !gatewayHttpTargetsOk(req, res, zone.gateway_peer_id, http ? 1 : 0)) return;
    const host = await hosts.create(zone.id, body);
    res.status(201).json({ ok: true, host });
  } catch (err) {
    handleError(req, res, err);
  }
});

// ─── Hosts ──────────────────────────────────────────────

router.put('/hosts/:id', async (req, res) => {
  try {
    if (!hostRow(req.params.id)) return notFound(res, 'Host');
    const body = req.body || {};
    const patch = {};
    for (const k of ['description', 'subdomain', 'lan_host']) if (body[k] !== undefined) patch[k] = body[k];
    const host = await hosts.update(req.params.id, patch);
    res.json({ ok: true, host });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.delete('/hosts/:id', async (req, res) => {
  try {
    if (!hostRow(req.params.id)) return notFound(res, 'Host');
    await hosts.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.put('/hosts/:id/toggle', async (req, res) => {
  try {
    if (!hostRow(req.params.id)) return notFound(res, 'Host');
    const body = req.body || {};
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled (boolean) required' });
    const host = await hosts.toggle(req.params.id, body.enabled);
    res.json({ ok: true, host });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.put('/hosts/:id/gateway-override', async (req, res) => {
  try {
    const row = hostRow(req.params.id);
    if (!row) return notFound(res, 'Host');
    if (!req.body || req.body.override !== false) {
      return res.status(400).json({ ok: false, error: 'Only { override: false } is supported' });
    }
    const zone = row.domain_id != null ? zoneRow(row.domain_id) : null;
    const target = zone ? domainZones.zoneTarget(zone) : null;
    if (target && row.gateway_override) {
      const rows = hosts.membersOf(row.id);
      if (!retargetLicenseOk(req, res, target, rows)) return;
    }
    const host = await hosts.clearOverride(row.id);
    res.json({ ok: true, host });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.post('/hosts/:id/entries',
  (req, res, next) => {
    if (!hostRow(req.params.id)) return notFound(res, 'Host');
    const type = req.body && req.body.type;
    if (type === 'tcp' || type === 'udp') return requireLimit('l4_routes', l4RouteCountFn)(req, res, next);
    return requireLimit('http_routes', httpRouteCountFn)(req, res, next);
  },
  async (req, res) => {
    try {
      const body = req.body || {};
      const isL4 = body.type === 'tcp' || body.type === 'udp';
      const target = hosts.effectiveTarget(req.params.id);
      if (target) {
        if (target.kind === 'pool' && !license.hasFeature('gateway_pool_failover')) return denyFeature(req, res, 'gateway_pool_failover');
        if (isL4 && target.kind !== 'peer' && !license.hasFeature('gateway_tcp_routing')) {
          return res.status(403).json({ ok: false, error: 'gateway_tcp_routing not licensed' });
        }
        if (!isL4 && target.kind === 'gateway' && !gatewayHttpTargetsOk(req, res, target.peer_id, 1)) return;
      }
      const entry = await hosts.addEntry(req.params.id, body);
      res.status(201).json({ ok: true, entry });
    } catch (err) {
      handleError(req, res, err);
    }
  });

router.post('/hosts/:id/scan-to-folder', async (req, res) => {
  try {
    if (!hostRow(req.params.id)) return notFound(res, 'Host');
    const body = req.body || {};
    const isNew = !!(body.target && body.target.mode === 'new');
    // Same combined gate as POST /printer-presets for the scan step.
    const verdict = evaluateRouteLicense({ httpCount: 0, l4Count: isNew ? 1 : 0, targetKind: 'gateway', scanEgress: true });
    if (!verdict.ok) return deny(req, res, verdict.key, verdict.extra);
    const result = await hosts.setupScanToFolder(req.params.id, body);
    res.json({ ok: true, ...result });
  } catch (err) {
    handleError(req, res, err);
  }
});

router.get('/host-templates', (req, res) => {
  try {
    res.json({ ok: true, templates: hostTemplates.list() });
  } catch (err) {
    handleError(req, res, err);
  }
});

module.exports = router;
