'use strict';

const { Router } = require('express');
const { requireFeature } = require('../../middleware/license');
const users = require('../../services/users');
const smarthome = require('../../services/smarthome');
const smarthomeOwners = require('../../services/smarthome/smarthomeOwners');
const smarthomeRules = require('../../services/smarthome/smarthomeRules');
const deconzCaps = require('../../services/smarthome/deconzCapabilities');

const router = Router();

// Admin-only: reject token auth, require an admin session.
router.use((req, res, next) => {
  if (req.tokenAuth) return res.status(403).json({ ok: false, error: req.t('error.users.session_required') });
  if (!req.session || !req.session.userId) return res.status(401).json({ ok: false, error: req.t('error.users.unauthorized') });
  const user = users.getById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ ok: false, error: req.t('error.users.admin_required') });
  next();
});

router.use(requireFeature('smarthome'));

function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      const status =
        err.code === 'DECONZ_LINK_BUTTON_NOT_PRESSED' ? 409 :
        err.code === 'SMARTHOME_NO_ROUTE' ? 400 :
        err.code === 'SMARTHOME_NO_API_KEY' ? 409 :
        err.code === 'SMARTHOME_GATEWAY_NOT_FOUND' ? 404 :
        err.code === 'SMARTHOME_RULE_INVALID' ? 400 :
        err.code === 'DECONZ_RULE_LIMIT_REACHED' ? 409 :
        err.code === 'SMARTHOME_RULE_NOT_FOUND' ? 404 :
        /not found/i.test(err.message) ? 404 : 502;
      res.status(status).json({ ok: false, error: err.message, code: err.code || null });
    }
  };
}

router.get('/gateways', wrap(async (req, res) => {
  res.json({ gateways: smarthome.listGateways().map((g) => ({ id: g.id, name: g.name, route_id: g.route_id, enabled: g.enabled, last_seen_at: g.last_seen_at })) });
}));

router.post('/gateways', wrap(async (req, res) => {
  const { name, route_id, apiKey } = req.body || {};
  const gw = await smarthome.connectGateway({ name, route_id, apiKey });
  res.json({ gateway: { id: gw.id, name: gw.name, route_id: gw.route_id, enabled: gw.enabled } });
}));

router.put('/gateways/:id', wrap(async (req, res) => {
  const g = smarthome.updateGateway(Number(req.params.id), req.body || {});
  res.json({ gateway: { id: g.id, name: g.name, route_id: g.route_id, enabled: g.enabled, last_seen_at: g.last_seen_at } });
}));

router.delete('/gateways/:id', wrap(async (req, res) => {
  res.json(smarthome.removeGateway(Number(req.params.id)));
}));

router.post('/gateways/:id/sync', wrap(async (req, res) => {
  res.json(await smarthome.syncGateway(Number(req.params.id)));
}));

router.post('/gateways/:id/test', wrap(async (req, res) => {
  res.json(await smarthome.testGateway(Number(req.params.id)));
}));

router.get('/resources', wrap(async (req, res) => {
  const gatewayId = req.query.gateway_id ? Number(req.query.gateway_id) : undefined;
  const resources = (await smarthome.getResources(gatewayId)).map((r) => ({
    ...r,
    owners: r.kind === 'scene' ? smarthomeOwners.inheritedOwnersOf(r) : smarthomeOwners.ownersOf(r.id),
  }));
  res.json({ resources });
}));

router.put('/resources/:id/owners', wrap(async (req, res) => {
  const rawIds = req.body && req.body.userIds;
  if (!Array.isArray(rawIds)) {
    return res.status(400).json({ ok: false, error: req.t('error.smarthome.user_ids_required'), code: 'SMARTHOME_USER_IDS_REQUIRED' });
  }
  try {
    const owners = smarthomeOwners.setOwners(Number(req.params.id), rawIds);
    res.json({ resource_id: Number(req.params.id), owners });
  } catch (e) {
    if (e.code === 'SMARTHOME_OWNER_UNKNOWN_USER') return res.status(400).json({ ok: false, error: req.t('error.smarthome.owner_unknown_user'), code: e.code });
    if (e.code === 'SMARTHOME_NOT_ASSIGNABLE') return res.status(400).json({ ok: false, error: req.t('error.smarthome.not_assignable'), code: e.code });
    if (e.code === 'SMARTHOME_RESOURCE_NOT_FOUND') return res.status(404).json({ ok: false, error: req.t('error.smarthome.resource_not_found'), code: e.code });
    throw e;
  }
}));

router.post('/resources/:id/state', wrap(async (req, res) => {
  const patch = (req.body && req.body.patch) || req.body || {};
  await smarthome.setResourceState(Number(req.params.id), patch);
  res.json({ ok: true });
}));

function reqGatewayId(req) { const id = Number(req.query.gateway_id); if (!Number.isInteger(id) || id < 1) { const e = new Error('missing gateway_id'); e.code = 'SMARTHOME_RULE_INVALID'; throw e; } return id; }

router.get('/rules', wrap(async (req, res) => {
  const gatewayId = reqGatewayId(req);
  const list = smarthomeRules.list(gatewayId);
  res.json({
    rules: list,
    gc_rule_count: list.length,
    limit_warn: smarthomeRules.limitWarn(list.length),
    cancelSupported: deconzCaps.cancelSupported,
  });
}));

router.get('/rules/gateway-count', wrap(async (req, res) => {
  res.json(await smarthomeRules.gatewayRuleCount(reqGatewayId(req)));
}));

router.post('/rules', wrap(async (req, res) => {
  const { gateway_id, name, definition } = req.body || {};
  if (!gateway_id || !name || !definition) { const e = new Error('missing fields'); e.code = 'SMARTHOME_RULE_INVALID'; throw e; }
  res.json({ rule: await smarthomeRules.create(Number(gateway_id), String(name), definition) });
}));

router.put('/rules/:id', wrap(async (req, res) => {
  const { name, definition } = req.body || {};
  res.json({ rule: await smarthomeRules.update(Number(req.params.id), String(name), definition) });
}));

router.delete('/rules/:id', wrap(async (req, res) => {
  await smarthomeRules.remove(Number(req.params.id));
  res.json({ ok: true });
}));

router.post('/rules/:id/enabled', wrap(async (req, res) => {
  res.json({ rule: await smarthomeRules.setEnabled(Number(req.params.id), !!(req.body && req.body.enabled)) });
}));

module.exports = router;
