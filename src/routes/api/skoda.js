'use strict';

const { Router } = require('express');
const { requireFeature } = require('../../middleware/license');
const users = require('../../services/users');
const skoda = require('../../services/skoda');
const accounts = require('../../services/skoda/skodaAccounts');
const owners = require('../../services/skoda/skodaOwners');
const settings = require('../../services/settings');
const control = require('../../services/skoda/skodaControl');
const details = require('../../services/skoda/skodaDetails');

const router = Router();

router.use((req, res, next) => {
  if (req.tokenAuth) return res.status(403).json({ ok: false, error: req.t('error.users.session_required') });
  if (!req.session || !req.session.userId) return res.status(401).json({ ok: false, error: req.t('error.users.unauthorized') });
  const user = users.getById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ ok: false, error: req.t('error.users.admin_required') });
  next();
});
router.use(requireFeature('skoda_integration'));

const STATUS_BY_CODE = {
  SKODA_VALIDATION: 400,
  SKODA_OWNER_UNKNOWN_USER: 400,
  SKODA_UNKNOWN_COMMAND: 400,
  SKODA_ACCOUNT_EXISTS: 409,
  SKODA_SPIN_REQUIRED: 409,
  SKODA_NO_SESSION: 409,
  SKODA_TIMER_READONLY: 409,
  SKODA_REFRESH_COOLDOWN: 429,
  SKODA_RATE_LIMITED: 429,
  SKODA_COMMAND_RATE_LIMIT: 429,
  SKODA_VEHICLE_NOT_FOUND: 404,
  SKODA_TIMER_NOT_FOUND: 404,
  SKODA_ACCOUNT_NOT_FOUND: 404,
};

function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); } catch (e) {
      const status = STATUS_BY_CODE[e.code] || (/not found/i.test(e.message) ? 404 : 502);
      res.status(status).json({ ok: false, error: e.message, code: e.code || null });
    }
  };
}

router.get('/', wrap(async (req, res) => {
  res.json({ ok: true, ...skoda.getStatus(), poll_interval_min: skoda.pollIntervalMs() / 60000 });
}));

// Lazy read-only enrichment (loaded when the card's details block is opened).
router.get('/vehicles/:id/details', wrap(async (req, res) => {
  const d = await details.getDetails(Number(req.params.id), { forAdmin: true });
  res.json({ ok: true, details: d });
}));

router.post('/accounts', wrap(async (req, res) => {
  // No implicit sync here: the UI calls POST /accounts/:id/sync afterwards.
  // Keeps unit tests free of real network login attempts.
  const acc = accounts.createAccount({ email: req.body.email, password: req.body.password });
  const { password, password_enc, session_enc, ...safe } = acc || {};
  res.status(201).json({ ok: true, account: safe });
}));

router.post('/accounts/:id/sync', wrap(async (req, res) => {
  const result = await skoda.syncAccount(Number(req.params.id));
  res.json({ ok: true, result });
}));

router.put('/accounts/:id', wrap(async (req, res) => {
  accounts.updatePassword(Number(req.params.id), req.body.password);
  res.json({ ok: true });
}));

router.delete('/accounts/:id', wrap(async (req, res) => {
  await skoda.removeAccount(Number(req.params.id)); // account lock: waits for in-flight sync
  res.json({ ok: true });
}));

router.post('/vehicles/:id/refresh', wrap(async (req, res) => {
  await skoda.refreshVehicle(Number(req.params.id));
  res.json({ ok: true });
}));

router.put('/vehicles/:id/owners', wrap(async (req, res) => {
  const rawIds = req.body && req.body.user_ids;
  if (!Array.isArray(rawIds)) {
    return res.status(400).json({ ok: false, error: 'user_ids must be an array', code: 'SKODA_VALIDATION' });
  }
  owners.setOwners(Number(req.params.id), rawIds);
  res.json({ ok: true, owners: owners.ownersOf(Number(req.params.id)) });
}));

router.get('/vehicles/:id/image', wrap(async (req, res) => {
  const img = skoda.getVehicleImage(Number(req.params.id));
  if (!img) return res.status(404).json({ ok: false, error: 'no image', code: null });
  res.set('content-type', 'image/png').set('cache-control', 'private, max-age=86400').send(img.image);
}));

router.put('/settings', wrap(async (req, res) => {
  const val = Number(req.body.poll_interval_min);
  if (!Number.isInteger(val) || val < 5 || val > 1440) {
    return res.status(400).json({ ok: false, error: 'poll_interval_min must be 5..1440', code: 'SKODA_VALIDATION' });
  }
  settings.set('skoda_poll_interval_min', String(val));
  skoda.stopPolling();
  skoda.startPolling({ immediate: false });
  res.json({ ok: true });
}));

router.post('/vehicles/:id/command', wrap(async (req, res) => {
  await control.runCommand(Number(req.params.id), req.body.action, req.body.args || {});
  res.json({ ok: true });
}));

router.put('/accounts/:id/spin', wrap(async (req, res) => {
  accounts.setSpin(Number(req.params.id), req.body.spin);
  res.json({ ok: true });
}));

module.exports = router;
