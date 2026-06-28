'use strict';

const { Router } = require('express');
const { requireFeature } = require('../../middleware/license');
const users = require('../../services/users');
const midea = require('../../services/midea');
const mideaOwners = require('../../services/midea/mideaOwners');
const mideaDevices = require('../../services/midea/mideaDevices');

const router = Router();

// Admin-only (Spec §9): reject token auth, require an admin session.
// Guard order: admin check FIRST, then requireFeature — mirrors routes/api/users.js lines 35-50.
router.use((req, res, next) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.users.session_required') });
  }

  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: req.t('error.users.unauthorized') });
  }

  const user = users.getById(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: req.t('error.users.admin_required') });
  }

  next();
});

router.use(requireFeature('midea_integration'));

// Async error mapper: maps typed error codes and messages to HTTP status codes.
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status =
        err.code === 'MIDEA_CLOUD_2FA_REQUIRED' ? 409
        : err.code === 'MIDEA_DEVICE_EXISTS' ? 409
        : err.code === 'MIDEA_CLOUD_RATE_LIMITED' ? 429
        : /not found/i.test(err.message) ? 404
        : 502;
      res.status(status).json({ ok: false, error: err.message, code: err.code || null });
    }
  };
}

// POST /cloud/connect — authenticate with Midea cloud
router.post('/cloud/connect', wrap(async (req, res) => {
  const { email, password, app } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: req.t('error.midea.email_password_required') });
  }
  res.json(await midea.connectCloud(email, password, app || 'msmarthome'));
}));

// GET /cloud/devices — list devices from cloud account
router.get('/cloud/devices', wrap(async (req, res) => {
  res.json({ devices: await midea.listCloudDevices() });
}));

// POST /discover — LAN discovery scan
router.post('/discover', wrap(async (req, res) => {
  res.json({ devices: await midea.discoverLan({}) });
}));

// POST /devices — add a device (sn or ip required for LAN; cloud_appliance_id for cloud)
router.post('/devices', wrap(async (req, res) => {
  const { sn, name, ip, transport, cloud_appliance_id } = req.body || {};
  if (transport === 'cloud') {
    if (!cloud_appliance_id) {
      return res.status(400).json({ ok: false, error: req.t('error.midea.cloud_appliance_id_required') });
    }
  } else if (!sn && !ip) {
    return res.status(400).json({ ok: false, error: req.t('error.midea.sn_or_ip_required') });
  }
  res.json({ device: await midea.addDevice({ sn, name, ip, transport, cloud_appliance_id }) });
}));

// GET /devices — list all devices (redacted) + owners
router.get('/devices', wrap(async (req, res) => {
  const devs = midea.getDevices().map((d) => ({ ...d, owners: mideaOwners.ownersOf(d.id) }));
  res.json({ devices: devs });
}));

// PUT /devices/:id/owners — replace the owner set (admin-only, license-gated by router)
router.put('/devices/:id/owners', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!mideaDevices.getDevice(id)) {
    return res.status(404).json({ ok: false, error: req.t('error.midea.device_not_found') });
  }
  const rawIds = req.body && req.body.user_ids;
  if (!Array.isArray(rawIds)) {
    return res.status(400).json({ ok: false, error: req.t('error.midea.user_ids_required') });
  }
  try {
    const owners = mideaOwners.setOwners(id, rawIds);
    res.json({ device_id: id, owners });
  } catch (e) {
    if (e.code === 'MIDEA_OWNER_UNKNOWN_USER') {
      return res.status(400).json({ ok: false, error: req.t('error.midea.owner_unknown_user'), code: e.code });
    }
    throw e;
  }
}));

// GET /devices/:id/state — fetch live state from device
router.get('/devices/:id/state', wrap(async (req, res) => {
  res.json({ state: await midea.getState(Number(req.params.id)) });
}));

// POST /devices/:id/state — push state patch to device
router.post('/devices/:id/state', wrap(async (req, res) => {
  const patch = (req.body && req.body.patch) || req.body || {};
  res.json({ state: await midea.setState(Number(req.params.id), patch) });
}));

// POST /devices/:id/test — connectivity test
router.post('/devices/:id/test', wrap(async (req, res) => {
  res.json(await midea.testConnection(Number(req.params.id)));
}));

// DELETE /devices/:id — remove device
router.delete('/devices/:id', wrap(async (req, res) => {
  res.json(midea.removeDevice(Number(req.params.id)));
}));

// GET /status — orchestrator status (all devices + lastPollAt)
router.get('/status', wrap(async (req, res) => {
  res.json(midea.getStatus());
}));

module.exports = router;
