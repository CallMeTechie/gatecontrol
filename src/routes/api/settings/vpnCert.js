'use strict';

// "Zertifikat für die Namen" (Einstellungen › VPN & Netzwerk): wildcard
// certificate of the VPN zone via ACME DNS-01 (services/vpnCert.js).
// No answer ever carries a credential value — only which fields are set and
// when they were saved.

const { Router } = require('express');
const vpnCert = require('../../../services/vpnCert');
const logger = require('../../../utils/logger');

const router = Router();

const ERROR_CODES = new Set([
  'provider_unknown', 'field_required', 'field_invalid', 'delegate_required', 'delegate_invalid',
  'delay_invalid', 'no_zone', 'not_configured', 'renew_not_needed', 'preflight_failed', 'test_running',
]);

function fail(req, res, err, what) {
  if (err && err.code === 'feature_not_available') {
    return res.status(403).json({ ok: false, error: req.t('error.license.feature_not_available'), feature: vpnCert.FEATURE });
  }
  if (err && ERROR_CODES.has(err.code)) {
    const error = req.t('st.vpncert.err.' + err.code, { field: err.field || '' });
    const body = { ok: false, code: err.code, error };
    if (err.field) body.fields = { [err.field]: error };
    if (err.result) body.preflight = err.result;
    return res.status(err.statusCode || 400).json(body);
  }
  logger.warn({ err: vpnCert.redact(err && err.message) }, `${what} failed`);
  return res.status(500).json({ ok: false, error: req.t('common.error') });
}

function input(body) {
  const b = body || {};
  return {
    provider: b.provider,
    credentials: b.credentials && typeof b.credentials === 'object' && !Array.isArray(b.credentials) ? b.credentials : {},
    delegate: b.delegate,
    propagation_delay: b.propagation_delay,
  };
}

/** GET /api/v1/settings/vpn-cert — state, provider, catalog, suggestion (no values) */
router.get('/vpn-cert', async (req, res) => {
  try {
    const data = vpnCert.view();
    data.detected = null;
    if (data.zone && data.licensed) {
      try { data.detected = await vpnCert.detect(); } catch { data.detected = null; }
    }
    data.test = vpnCert.testView();
    res.json({ ok: true, data });
  } catch (err) { fail(req, res, err, 'GET /vpn-cert'); }
});

/**
 * PUT /api/v1/settings/vpn-cert { provider, credentials: { field: value },
 * delegate, propagation_delay } — empty fields keep the stored value (same
 * provider). Requests the certificate at once (Caddy sync).
 */
router.put('/vpn-cert', async (req, res) => {
  try {
    const data = await vpnCert.save(input(req.body), { ip: req.ip });
    res.json({ ok: true, data });
  } catch (err) { fail(req, res, err, 'PUT /vpn-cert'); }
});

/** DELETE /api/v1/settings/vpn-cert — switch off: credentials, files and the policy go */
router.delete('/vpn-cert', async (req, res) => {
  try {
    res.json({ ok: true, data: await vpnCert.disable({ ip: req.ip }) });
  } catch (err) { fail(req, res, err, 'DELETE /vpn-cert'); }
});

/**
 * POST /api/v1/settings/vpn-cert/test { provider?, credentials?, delegate? } —
 * starts the connection test (caddy gc-dnstest): 202 with the test; its steps
 * via GET …/test. Saves nothing but the outcome.
 */
router.post('/vpn-cert/test', (req, res) => {
  try {
    res.status(202).json({ ok: true, data: vpnCert.startTest(input(req.body), { ip: req.ip }) });
  } catch (err) { fail(req, res, err, 'POST /vpn-cert/test'); }
});

/** GET /api/v1/settings/vpn-cert/test — the running or last test of this server process */
router.get('/vpn-cert/test', (req, res) => {
  try {
    res.json({ ok: true, data: vpnCert.testView() });
  } catch (err) { fail(req, res, err, 'GET /vpn-cert/test'); }
});

/** POST /api/v1/settings/vpn-cert/renew — "Jetzt erneuern" / "Erneut versuchen" */
router.post('/vpn-cert/renew', async (req, res) => {
  try {
    res.json({ ok: true, data: await vpnCert.renew({ ip: req.ip }) });
  } catch (err) { fail(req, res, err, 'POST /vpn-cert/renew'); }
});

module.exports = router;
