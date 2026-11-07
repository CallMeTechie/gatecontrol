'use strict';

// Admin API of the tab "Funk" of a gateway (phase 3c, step 2 — services/homeRadio.js),
// mounted at /api/v1/gateways next to routes/api/gateways.js behind requireAuth +
// apiLimiter + CSRF + requireAdmin (routes/api/index.js). Admin SESSION only.
//
//   GET    /:id/radio                     switches, sticks, Zigbee, Bluetooth, Thread, sensors (live from the gateway)
//   POST   /:id/radio/zigbee/pair         { seconds? } "Anlernen starten" (3 minutes)
//   POST   /:id/radio/zigbee/retry        get deCONZ's API key again
//   PUT    /:id/radio/sensors/:mac        { accepted?, name?, key? } "Übernehmen" / rename / key of an encrypted sensor
//   DELETE /:id/radio/sensors/:mac        forget a sensor
//   POST   /:id/radio/zigbee/remove       { ieee } a zigbee2mqtt device leaves the network
//   POST   /:id/radio/thread/form         { name? } a new Thread network
//   POST   /:id/radio/thread/join         { dataset } join the network of another border router (TLV hex, never stored)
//   POST   /:id/radio/thread/dataset      the active dataset for a Matter controller (audited, never stored)
// The switches themselves go through PUT /:id/features { radio: { zigbee, ble } }.

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const radio = require('../../services/homeRadio');
const features = require('../../services/gatewayFeatures');
const logger = require('../../utils/logger');

const router = Router();

const STATUS = {
  not_found: 404, invalid: 400, invalid_key: 400, invalid_dataset: 400, gateway_unsupported: 409, unavailable: 409, not_running: 409, key_needed: 409,
  has_network: 409, no_network: 409, gateway_unreachable: 502, gateway_error: 502, deconz_failed: 502, otbr_failed: 502,
};

function fail(res, err) {
  const code = (err && err.code) || 'internal';
  if (!STATUS[code]) logger.error({ err: err && err.message }, 'gateway radio admin API failed');
  return res.status(STATUS[code] || 500).json({ ok: false, code, error: STATUS[code] ? err.message : 'internal error' });
}

const handle = (fn) => async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const out = await fn(req, res);
    if (!res.headersSent) res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
};

function gw(req) { return features.needGateway(req.params.id); }

function audit(req, g, event, text, details) {
  try {
    let user = null;
    try { const u = require('../../services/users').getById(req.session.userId); user = u ? u.username : null; } catch { user = null; }
    require('../../services/activity').log(event, text, { source: 'admin', ipAddress: req.ip, severity: 'info', details: { peer_id: g.id, ...(user ? { user } : {}), ...details } });
  } catch { /* best-effort */ }
}

router.get('/:id/radio', requireAdminSession, handle(async (req) => ({ radio: await radio.view(gw(req).id) })));

router.post('/:id/radio/zigbee/pair', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  const s = req.body && req.body.seconds;
  if (s !== undefined && !(Number.isInteger(s) && s >= 60 && s <= 254)) throw Object.assign(new Error('seconds: 60…254'), { code: 'invalid' });
  const r = await radio.pair(g.id, s);
  audit(req, g, 'gateway_zigbee_pairing', `Zigbee pairing started on gateway "${g.name}"`, {});
  return r;
}));

router.post('/:id/radio/zigbee/retry', requireAdminSession, handle(async (req) => radio.retry(gw(req).id)));

router.put('/:id/radio/sensors/:mac', requireAdminSession, handle((req) => {
  const g = gw(req);
  const s = radio.setSensor(g.id, req.params.mac, req.body);
  if (req.body && req.body.accepted === true) audit(req, g, 'gateway_ble_sensor_accepted', `Bluetooth sensor ${s.mac} taken over on gateway "${g.name}"`, { mac: s.mac });
  // never the key itself
  if (req.body && 'key' in req.body) audit(req, g, s.hasKey ? 'gateway_ble_sensor_key_set' : 'gateway_ble_sensor_key_removed', `Key of Bluetooth sensor ${s.mac} ${s.hasKey ? 'set' : 'removed'} on gateway "${g.name}"`, { mac: s.mac });
  return { sensor: s };
}));

router.post('/:id/radio/zigbee/remove', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  const ieee = req.body && req.body.ieee;
  const r = await radio.removeZigbee(g.id, ieee);
  audit(req, g, 'gateway_zigbee_device_removed', `Zigbee device ${String(ieee).toLowerCase()} removed on gateway "${g.name}"`, { ieee: String(ieee).toLowerCase() });
  return r;
}));

router.post('/:id/radio/thread/form', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  const r = await radio.threadForm(g.id, req.body && req.body.name);
  audit(req, g, 'gateway_thread_formed', `Thread network formed on gateway "${g.name}"`, {});
  return r;
}));

router.post('/:id/radio/thread/join', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  const r = await radio.threadJoin(g.id, req.body && req.body.dataset);
  audit(req, g, 'gateway_thread_joined', `Thread network of another border router taken over on gateway "${g.name}"`, {});
  return r;
}));

router.post('/:id/radio/thread/dataset', requireAdminSession, handle(async (req) => {
  const g = gw(req);
  const r = await radio.threadDataset(g.id);
  audit(req, g, 'gateway_thread_dataset_shown', `Thread dataset shown for gateway "${g.name}"`, {});
  return r;
}));

router.delete('/:id/radio/sensors/:mac', requireAdminSession, handle((req) => radio.removeSensor(gw(req).id, req.params.mac)));

module.exports = router;
