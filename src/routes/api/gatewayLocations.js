'use strict';

// Gateway-Standorte (services/gatewayLocations.js, docs/feature-gateway-locations.md).
//
//   GET    /api/v1/gateway-locations           → { ok, locations: [{ id, name, street, postal_code, city, country,
//                                                  gateway_count, gateways: [{ peer_id, name }] }] }
//   POST   /api/v1/gateway-locations           { name, street?, postal_code?, city?, country? } → 201 { ok, location }
//   PUT    /api/v1/gateway-locations/:id       same body (all fields replaced) → { ok, location }
//   DELETE /api/v1/gateway-locations/:id       → { ok, released: [{ peer_id, name }] } — its gateways stay, without a location
//   PUT    /api/v1/gateways/:id/location       { location_id | null, also?: [peer ids] } → { ok, changed: [...] }
//                                              `also`: further gateways that get the same location (the pool partner)
//
// Admin only (the /api/v1 router: admin session + CSRF; tokens need `gateway`
// or `full-access`). No licence feature: Community too.

const { Router } = require('express');
const logger = require('../../utils/logger');
const svc = require('../../services/gatewayLocations');
const activity = require('../../services/activity');

const router = Router();
const gatewayRouter = Router();

const STATUS = { invalid: 400, name_taken: 409, not_found: 404, gateway_not_found: 404 };

function fail(req, res, err, fallbackKey) {
  if (err instanceof svc.LocationError) {
    const fields = {};
    for (const [k, code] of Object.entries(err.fields || {})) fields[k] = req.t('error.gateway_locations.' + code);
    const first = Object.values(fields)[0];
    return res.status(STATUS[err.code] || 400).json({
      ok: false, code: err.code, error: first || req.t('error.gateway_locations.' + err.code), fields: err.fields ? fields : undefined,
    });
  }
  logger.error({ err: err.message }, 'gateway locations request failed');
  return res.status(500).json({ ok: false, error: req.t(fallbackKey) });
}

router.get('/', (req, res) => {
  try {
    res.json({ ok: true, locations: svc.list() });
  } catch (err) { fail(req, res, err, 'error.gateway_locations.list'); }
});

router.post('/', (req, res) => {
  try {
    const loc = svc.create(req.body);
    activity.log('gateway_location_created', `Gateway location "${loc.name}" created`,
      { source: 'admin', severity: 'info', details: { id: loc.id, name: loc.name } });
    res.status(201).json({ ok: true, location: loc });
  } catch (err) { fail(req, res, err, 'error.gateway_locations.save'); }
});

router.put('/:id', (req, res) => {
  try {
    const { before, after } = svc.update(req.params.id, req.body);
    activity.log('gateway_location_updated', before.name === after.name
      ? `Gateway location "${after.name}" changed`
      : `Gateway location "${before.name}" renamed to "${after.name}"`,
    { source: 'admin', severity: 'info', details: { id: after.id, name: after.name, previous_name: before.name } });
    res.json({ ok: true, location: after });
  } catch (err) { fail(req, res, err, 'error.gateway_locations.save'); }
});

router.delete('/:id', (req, res) => {
  try {
    const r = svc.remove(req.params.id);
    activity.log('gateway_location_deleted', `Gateway location "${r.location.name}" deleted`
      + (r.released.length ? ` (${r.released.length} gateway(s) now without a location)` : ''),
    { source: 'admin', severity: 'info', details: { id: r.location.id, name: r.location.name, gateways: r.released.map((g) => g.name) } });
    res.json({ ok: true, released: r.released });
  } catch (err) { fail(req, res, err, 'error.gateway_locations.delete'); }
});

gatewayRouter.put('/:id/location', (req, res) => {
  try {
    const body = req.body || {};
    const also = Array.isArray(body.also) ? body.also.slice(0, 16) : [];
    const changed = svc.setForGateways([req.params.id, ...also], body.location_id);
    const loc = changed.length && changed[0].to ? svc.get(changed[0].to) : null;
    for (const c of changed) {
      activity.log('gateway_location_changed', loc
        ? `Location of gateway "${c.name}" set to "${loc.name}"`
        : `Location of gateway "${c.name}" removed`,
      { source: 'admin', severity: 'info', details: { peer_id: c.peer_id, from: c.from, to: c.to, location: loc ? loc.name : null } });
    }
    res.json({ ok: true, changed });
  } catch (err) { fail(req, res, err, 'error.gateway_locations.save'); }
});

module.exports = router;
module.exports.gatewayRouter = gatewayRouter;
