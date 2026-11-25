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
  // The signing key only serves the legacy v1 licence server (HS256). v2
  // tokens are verified with the server's public keys, so it is optional;
  // when omitted, a previously stored one is kept for the v1 fallback.
  if (signing_key !== undefined && signing_key !== null && signing_key !== ''
    && (typeof signing_key !== 'string' || signing_key.length > 4096)) {
    return res.status(400).json({ ok: false, error: req.t ? req.t('error.license.signing_key_required') : 'Signing key is required' });
  }

  // Replacing a key: free the old activation slot (best effort, never blocks).
  const previousKey = config.license.key;
  if (previousKey && previousKey !== license_key) await license.deactivateLicense(previousKey);

  settings.set('license_key', license_key);
  config.license.key = license_key;
  if (signing_key) {
    settings.set('license_signing_key_encrypted', encrypt(signing_key));
    config.license.signingKey = signing_key;
  }

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
    // a published end-of-life file is looked for now, not only at the next daily check
    await require('../../services/licenseEol').maybeFetch({ force: true }).catch(() => false);
    await license.refreshLicenseInBackground();
    // plugin entitlements may have changed (e.g. a newly released plugin):
    // start/stop plugins now instead of at the next 5-minute reconcile
    try { await require('../../services/plugins').reconcile(); } catch { /* plugins keep their state */ }
    activity.log('license_refresh_success', `License refreshed — Plan: ${license.getPlan()}`);
    res.json({ ok: true, ...license.getLicenseInfo() });
  } catch (err) {
    activity.log('license_refresh_failed', `License refresh failed: ${err.message}`, { severity: 'warning' });
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── End of life (docs/feature-license-eol.md) ───
// The signed eol.json, uploaded as text: { content: "<file content>" }.
// Only a file that verifies against the licence server's keys is stored.
const EOL_REASONS = new Set(['malformed', 'alg', 'kid', 'signature', 'iss', 'kind', 'version', 'product', 'scope', 'iat', 'message']);
router.post('/eol', async (req, res) => {
  const eol = require('../../services/licenseEol');
  const content = req.body && req.body.content;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > eol.MAX_FILE_BYTES) {
    return res.status(400).json({ ok: false, error: req.t ? req.t('error.license.eol_invalid') : 'Not a valid end-of-life file', reason: 'malformed' });
  }
  const r = await eol.importText(content, 'upload');
  if (!r.ok) {
    const reason = EOL_REASONS.has(r.reason) ? r.reason : 'malformed';
    activity.log('license_eol_rejected', `End-of-life file rejected (${reason})`, { severity: 'warning' });
    return res.status(400).json({ ok: false, error: req.t ? req.t('error.license.eol_invalid') : 'Not a valid end-of-life file', reason });
  }
  activity.log('license_eol_imported', `End-of-life file imported (scope ${r.eol.scope}, issued ${r.eol.issued_at})`, { severity: 'warning' });
  try { await license.validateLicense(); } catch { /* the licence keeps its state */ }
  try { await require('../../services/plugins').reconcile(); } catch { /* plugins keep their state */ }
  res.json({ ok: true, ...license.getLicenseInfo() });
});

router.delete('/eol', async (req, res) => {
  const eol = require('../../services/licenseEol');
  await eol.remove();
  activity.log('license_eol_removed', 'End-of-life file removed');
  try { await license.validateLicense(); } catch { /* the licence keeps its state */ }
  try { await require('../../services/plugins').reconcile(); } catch { /* plugins keep their state */ }
  res.json({ ok: true, ...license.getLicenseInfo() });
});

router.delete('/', async (req, res) => {
  await license.removeLicense();
  activity.log('license_removed', 'License removed — reverted to Community mode');
  res.json({ ok: true, ...license.getLicenseInfo() });
});

module.exports = router;
