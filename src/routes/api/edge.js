'use strict';

// Admin API of the edge parts and the gateways' MQTT brokers (docs/plugins.md
// "Edge part" › "Administration"), mounted at /api/v1/edge behind
// requireAuth + apiLimiter + CSRF + requireAdmin (routes/api/index.js).
// Session only: an API token cannot switch code on a gateway.
//
//   GET    /gateways                                   every gateway: switches, connection, counts
//   GET    /gateways/:id                               one gateway: switches, connection, hello, plugins with an edge part, MQTT
//   PUT    /gateways/:id/settings                      { edgeEnabled?, mqttEnabled?, mqttTls?, allowUnsignedEdge?, confirm: 'ERLAUBEN' }
//   POST   /gateways/:id/plugins/:pluginId/enable      { capabilities: [keys exactly as shown] }
//   POST   /gateways/:id/plugins/:pluginId/disable
//   GET    /gateways/:id/logs?plugin=&kind=&limit=&before=   ring buffer (plugin= empty: the gateway's own notes)
//   GET    /gateways/:id/mqtt/accounts
//   POST   /gateways/:id/mqtt/accounts                 { username, label, topics: [{ topic, access }], vendorPrefix } → password once
//   PUT    /gateways/:id/mqtt/accounts/:accountId      { locked }
//   POST   /gateways/:id/mqtt/accounts/:accountId/password   → a new password, once
//   DELETE /gateways/:id/mqtt/accounts/:accountId
//   GET    /plugins/:pluginId                          a plugin's edge part on every gateway

const { Router } = require('express');
const edge = require('../../services/edge');
const { ID_RE } = require('../../services/plugins/constants');
const logger = require('../../utils/logger');

const router = Router();

router.use((req, res, next) => {
  if (req.tokenAuth || !req.session || !req.session.userId) return res.status(403).json({ ok: false, error: 'session_required' });
  next();
});

const STATUS = {
  not_found: 404, plugin_not_found: 404, account_not_found: 404, not_assigned: 404, no_edge: 409,
  caps_mismatch: 409, unsigned_blocked: 409, exists: 409, limit: 409, confirm_mismatch: 400, invalid: 400,
};

function lang(req) { return req.language === 'en' ? 'en' : 'de'; }

function who(req) {
  try {
    const u = require('../../services/users').getById(req.session.userId);
    return u ? u.username : null;
  } catch { return null; }
}

function fail(res, err) {
  const code = (err && err.code) || 'internal';
  if (!STATUS[code]) logger.error({ err: err && err.message }, 'edge admin API failed');
  const body = { ok: false, code, error: STATUS[code] ? err.message : 'internal error' };
  if (err && Array.isArray(err.capabilities)) body.capabilities = err.capabilities;
  return res.status(STATUS[code] || 500).json(body);
}

function gatewayId(req) { return Number(req.params.id); }

function pluginId(req) {
  const id = String(req.params.pluginId || '');
  return ID_RE.test(id) && id.length <= 64 ? id : null;
}

const handle = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) { fail(res, e); }
};

router.get('/gateways', handle((req, res) => res.json({ ok: true, gateways: edge.gateways() })));

router.get('/gateways/:id', handle((req, res) => res.json({ ok: true, gateway: edge.overview(gatewayId(req), lang(req)) })));

router.put('/gateways/:id/settings', handle((req, res) => {
  const b = req.body || {};
  const settings = edge.setSettings(gatewayId(req), {
    edgeEnabled: b.edgeEnabled, mqttEnabled: b.mqttEnabled, mqttTls: b.mqttTls, allowUnsignedEdge: b.allowUnsignedEdge,
  }, { confirm: b.confirm, ip: req.ip, user: who(req) });
  res.json({ ok: true, settings });
}));

router.post('/gateways/:id/plugins/:pluginId/enable', handle((req, res) => {
  const id = pluginId(req);
  if (!id) return res.status(404).json({ ok: false, code: 'plugin_not_found', error: 'plugin not installed' });
  const b = req.body || {};
  res.json({ ok: true, assignment: edge.enablePlugin(gatewayId(req), id, { capabilities: b.capabilities, ip: req.ip, user: who(req), lang: lang(req) }) });
}));

router.post('/gateways/:id/plugins/:pluginId/disable', handle((req, res) => {
  const id = pluginId(req);
  if (!id) return res.status(404).json({ ok: false, code: 'not_assigned', error: 'the plugin is not set up for this gateway' });
  res.json({ ok: true, assignment: edge.disablePlugin(gatewayId(req), id, { ip: req.ip, user: who(req), lang: lang(req) }) });
}));

router.get('/gateways/:id/logs', handle((req, res) => {
  const q = req.query || {};
  const plugin = q.plugin === undefined ? undefined : String(q.plugin);
  if (plugin && (!ID_RE.test(plugin) || plugin.length > 64)) return res.status(400).json({ ok: false, code: 'invalid', error: 'invalid plugin id' });
  res.json({ ok: true, entries: edge.logs(gatewayId(req), { plugin, kind: q.kind ? String(q.kind) : null, limit: q.limit, before: q.before }) });
}));

router.get('/gateways/:id/mqtt/accounts', handle((req, res) => res.json({ ok: true, accounts: edge.mqttAccounts(gatewayId(req)) })));

router.post('/gateways/:id/mqtt/accounts', handle((req, res) => {
  const r = edge.mqttCreate(gatewayId(req), req.body || {}, { ip: req.ip, user: who(req) });
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ ok: true, account: r.account, password: r.password });
}));

router.put('/gateways/:id/mqtt/accounts/:accountId', handle((req, res) => {
  const b = req.body || {};
  res.json({ ok: true, account: edge.mqttSetLocked(gatewayId(req), req.params.accountId, b.locked, { ip: req.ip }) });
}));

router.post('/gateways/:id/mqtt/accounts/:accountId/password', handle((req, res) => {
  const r = edge.mqttResetPassword(gatewayId(req), req.params.accountId, { ip: req.ip });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, account: r.account, password: r.password });
}));

router.delete('/gateways/:id/mqtt/accounts/:accountId', handle((req, res) => {
  edge.mqttRemove(gatewayId(req), req.params.accountId, { ip: req.ip });
  res.json({ ok: true });
}));

router.get('/plugins/:pluginId', handle((req, res) => {
  const id = pluginId(req);
  if (!id) return res.status(404).json({ ok: false, code: 'plugin_not_found', error: 'plugin not installed' });
  res.json({ ok: true, plugin: edge.pluginOverview(id, lang(req)) });
}));

module.exports = router;
