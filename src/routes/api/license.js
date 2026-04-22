'use strict';

const { Router } = require('express');
const license = require('../../services/license');
const settings = require('../../services/settings');
const { encrypt } = require('../../utils/crypto');
const activity = require('../../services/activity');
const config = require('../../../config/default');
const router = Router();

// Per-identity cooldowns (keyed by session user or req.ip fallback). A
// global cooldown used to let one admin DoS another admin's license
// refresh. Map entry is pruned on access.
const _activateCooldown = new Map();
const _refreshCooldown = new Map();
const COOLDOWN = 60000;
function _cooldownKey(req) {
  return `u:${req.session?.userId || req.ip}`;
}

router.get('/', (req, res) => {
  res.json({ ok: true, ...license.getLicenseInfo() });
});

router.post('/activate', async (req, res) => {
  const now = Date.now();
  const key = _cooldownKey(req);
  if (now - (_activateCooldown.get(key) || 0) < COOLDOWN) {
    return res.status(429).json({
      ok: false,
      error: req.t ? req.t('error.license.rate_limited') : 'Please wait before trying again',
    });
  }
  _activateCooldown.set(key, now);

  const { license_key, signing_key } = req.body;
  if (!license_key || typeof license_key !== 'string' || license_key.length > 4096) {
    return res.status(400).json({ ok: false, error: req.t ? req.t('error.license.key_required') : 'License key is required' });
  }
  if (!signing_key || typeof signing_key !== 'string' || signing_key.length > 4096) {
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
  const key = _cooldownKey(req);
  if (now - (_refreshCooldown.get(key) || 0) < COOLDOWN) {
    return res.status(429).json({
      ok: false,
      error: req.t ? req.t('error.license.rate_limited') : 'Please wait before trying again',
    });
  }
  _refreshCooldown.set(key, now);

  try {
    await license.refreshLicenseInBackground();
    activity.log('license_refresh_success', `License refreshed — Plan: ${license.getPlan()}`);
    res.json({ ok: true, ...license.getLicenseInfo() });
  } catch (err) {
    activity.log('license_refresh_failed', `License refresh failed: ${err.message}`, { severity: 'warning' });
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.delete('/', async (req, res) => {
  await license.removeLicense();
  activity.log('license_removed', 'License removed — reverted to Community mode');
  res.json({ ok: true, ...license.getLicenseInfo() });
});

module.exports = router;
