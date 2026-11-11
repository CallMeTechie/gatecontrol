'use strict';

// Admin API of phase 3a of the gateways (tabs "Netzwerk" and "Internet", card
// "Funktionen dieses Gateways"), mounted at /api/v1/gateways next to
// routes/api/gateways.js behind requireAuth + apiLimiter + CSRF + requireAdmin
// (routes/api/index.js). Every route here also needs an admin SESSION:
// API tokens are refused (requireAdminSession).
//
//   GET    /:id/features                    switches + hardware hints + RAM estimate
//   PUT    /:id/features                    { netwatch?, inetq?, presence?, ups?, notify?, lanDiscovery? }
//   GET    /:id/netwatch?q=&filter=         devices, KPIs, last scan
//   PUT    /:id/netwatch/devices/:deviceId  { name?, ownerUserId?, status?: known|watch, presence? }
//   DELETE /:id/netwatch/devices/:deviceId  forget the device
//   POST   /:id/netwatch/scan               "Jetzt scannen" (gateway management API)
//   GET    /:id/inetq?range=24h|7d|30d      now, speed, UPS, history, outages
//   POST   /:id/inetq/speedtest             "Jetzt messen" (gateway management API)
//   POST   /:id/print/discover              "Neu suchen" of Drucken & Scannen (gateway management API)

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const features = require('../../services/gatewayFeatures');
const logger = require('../../utils/logger');

const router = Router();

const STATUS = {
  not_found: 404, invalid: 400, invalid_host: 400, ups_host_ipv6: 400, invalid_owner: 400, ups_host_required: 400, ERR_INVALID: 400,
  gateway_unreachable: 502, gateway_error: 502, gateway_unsupported: 409, not_licensed: 403, unavailable: 409,
};

function fail(res, err) {
  const code = (err && err.code) || 'internal';
  if (!STATUS[code]) logger.error({ err: err && err.message }, 'gateway phase 3a admin API failed');
  return res.status(STATUS[code] || 500).json({ ok: false, code, error: STATUS[code] ? err.message : 'internal error' });
}

function who(req) {
  try {
    const u = require('../../services/users').getById(req.session.userId);
    return u ? u.username : null;
  } catch { return null; }
}

function gw(req) { return features.needGateway(req.params.id); }

const handle = (fn) => async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const out = await fn(req, res);
    if (!res.headersSent) res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
};

router.get('/:id/features', requireAdminSession, handle((req) => ({ gateway: features.overview(gw(req).id) })));

router.put('/:id/features', requireAdminSession, handle((req) => {
  const g = gw(req);
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { lanDiscovery, ...rest } = b;
  if (lanDiscovery !== undefined) {
    // the existing LAN discovery for route suggestions (gateways.discovery-settings), only its switch
    if (typeof lanDiscovery !== 'boolean') throw Object.assign(new Error('lanDiscovery must be true or false'), { code: 'invalid' });
    if (!require('../../services/license').hasFeature('gateway_lan_discovery')) throw Object.assign(new Error('gateway_lan_discovery not licensed'), { code: 'not_licensed' });
    const gws = require('../../services/gateways');
    const cur = gws.getDiscoverySettings(g.id) || {};
    gws.setDiscoverySettings(g.id, { enabled: lanDiscovery, active_scan: !!cur.active_scan, subnets: cur.subnets || [], category_mode: cur.category_mode, categories: cur.categories || [] });
  }
  if (Object.keys(rest).length) features.set(g.id, rest, { ip: req.ip, user: who(req) });
  else if (lanDiscovery === undefined) throw Object.assign(new Error('nothing to change'), { code: 'invalid' });
  return { gateway: features.overview(g.id) };
}));

router.get('/:id/netwatch', requireAdminSession, handle((req) => {
  const g = gw(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
  const tel = features.telemetryOf(g);
  return { gateway: { id: g.id, name: g.name, features: features.get(g.id), support: features.support(tel) }, ...require('../../services/netwatch').list(g.id, { q, filter }) };
}));

router.put('/:id/netwatch/devices/:deviceId', requireAdminSession, handle((req) => {
  const g = gw(req);
  return { device: require('../../services/netwatch').update(g.id, Number(req.params.deviceId), req.body, { ip: req.ip, user: who(req) }) };
}));

router.delete('/:id/netwatch/devices/:deviceId', requireAdminSession, handle((req) => {
  const g = gw(req);
  return require('../../services/netwatch').remove(g.id, Number(req.params.deviceId));
}));

router.post('/:id/netwatch/scan', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  if (!features.get(g.id).netwatch.enabled) throw Object.assign(new Error('the network watch is switched off'), { code: 'unavailable' });
  const r = await require('../../services/netwatch').scan(g.id);
  try {
    require('../../services/activity').log('netwatch_scan_requested', `Network scan requested on gateway "${g.name}"`, {
      source: 'admin', ipAddress: req.ip, severity: 'info', details: { peer_id: g.id, user: who(req) },
    });
  } catch { /* best-effort */ }
  return r;
}));

router.post('/:id/print/discover', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  const r = await require('../../services/homePrint').discoverOne(g.id);
  try {
    require('../../services/activity').log('print_discover_requested', `Printer search requested on gateway "${g.name}"`, {
      source: 'admin', ipAddress: req.ip, severity: 'info', details: { peer_id: g.id, user: who(req) },
    });
  } catch { /* best-effort */ }
  return r;
}));

router.get('/:id/inetq', requireAdminSession, handle((req) => {
  const g = gw(req);
  const tel = features.telemetryOf(g);
  const range = typeof req.query.range === 'string' ? req.query.range : '24h';
  return { gateway: { id: g.id, name: g.name, features: features.get(g.id), support: features.support(tel), speedLimit: features.speedLimit(features.boardOf(tel.hardware && tel.hardware.model)) },
    ...require('../../services/inetq').view(g.id, range, tel) };
}));

router.post('/:id/inetq/speedtest', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  if (!features.get(g.id).inetq.enabled) throw Object.assign(new Error('the internet quality is switched off'), { code: 'unavailable' });
  const r = await require('../../services/inetq').speedtest(g.id);
  try {
    require('../../services/activity').log('inet_speedtest_requested', `Speed test requested on gateway "${g.name}"`, {
      source: 'admin', ipAddress: req.ip, severity: 'info', details: { peer_id: g.id, user: who(req) },
    });
  } catch { /* best-effort */ }
  return r;
}));

module.exports = router;
