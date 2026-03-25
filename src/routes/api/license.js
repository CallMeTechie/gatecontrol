'use strict';

const { Router } = require('express');
const license = require('../../services/license');
const settings = require('../../services/settings');
const { encrypt } = require('../../utils/crypto');
const activity = require('../../services/activity');
const config = require('../../../config/default');
const router = Router();

let lastActivateCall = 0;
let lastRefreshCall = 0;
const COOLDOWN = 60000;

router.get('/', (req, res) => {
  res.json({ ok: true, ...license.getLicenseInfo() });
});

router.post('/activate', async (req, res) => {
  const now = Date.now();
  if (now - lastActivateCall < COOLDOWN) {
    return res.status(429).json({
      ok: false,
      error: req.t ? req.t('error.license.rate_limited') : 'Please wait before trying again',
    });
  }
  lastActivateCall = now;

  const { license_key, signing_key } = req.body;
  if (!license_key) {
    return res.status(400).json({ ok: false, error: req.t ? req.t('error.license.key_required') : 'License key is required' });
  }
  if (!signing_key) {
    return res.status(400).json({ ok: false, error: req.t ? req.t('error.license.signing_key_required') : 'Signing key is required' });
  }

  settings.set('license_key', license_key);
  settings.set('license_signing_key_encrypted', encrypt(signing_key));

  config.license.key = license_key;
  config.license.signingKey = signing_key;

  try {
    await license.validateLicense();
    activity.log('license_activated', `License activated — Plan: ${license.getPlan()}`);
    license.startLicenseRefresh();
    res.json({ ok: true, ...license.getLicenseInfo() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/refresh', async (req, res) => {
  const now = Date.now();
  if (now - lastRefreshCall < COOLDOWN) {
    return res.status(429).json({
      ok: false,
      error: req.t ? req.t('error.license.rate_limited') : 'Please wait before trying again',
    });
  }
  lastRefreshCall = now;

  try {
    await license.refreshLicenseInBackground();
    activity.log('license_refresh_success', `License refreshed — Plan: ${license.getPlan()}`);
    res.json({ ok: true, ...license.getLicenseInfo() });
  } catch (err) {
    activity.log('license_refresh_failed', `License refresh failed: ${err.message}`, { severity: 'warning' });
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/', async (req, res) => {
  await license.removeLicense();
  activity.log('license_removed', 'License removed — reverted to Community mode');
  res.json({ ok: true, ...license.getLicenseInfo() });
});

module.exports = router;
