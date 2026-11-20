'use strict';

// TLS guard API (docs/feature-tls-guard.md): certificate status per host,
// DNS/CAA preflight, manual retry. Admin session or token scope `routes`;
// no feature gate.

const { Router } = require('express');
const tlsGuard = require('../../services/tlsGuard');
const logger = require('../../utils/logger');

const router = Router();

const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
// the wildcard of the VPN zone (services/vpnCert.js) is listed like a host
function validHost(host) { return HOST_RE.test(host.startsWith('*.') ? host.slice(2) : host); }

function hostParam(req, res) {
  const host = String(req.params.host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!validHost(host)) {
    res.status(400).json({ ok: false, error: 'Invalid hostname', code: 'INVALID_HOST' });
    return null;
  }
  return host;
}

router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, ...tlsGuard.listStatus() });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /tls/status failed');
    res.status(500).json({ ok: false, error: 'Could not load certificate status' });
  }
});

router.get('/preflight/:host', async (req, res) => {
  const host = hostParam(req, res);
  if (!host) return;
  try {
    res.json({ ok: true, result: await tlsGuard.preflight(host) });
  } catch (err) {
    logger.warn({ err: err.message, host }, 'GET /tls/preflight failed');
    res.status(500).json({ ok: false, error: 'Preflight failed' });
  }
});

router.post('/:host/retry', async (req, res) => {
  const host = hostParam(req, res);
  if (!host) return;
  try {
    const status = await tlsGuard.retryHost(host);
    res.json({ ok: true, status });
  } catch (err) {
    if (err && err.code === 'PREFLIGHT_FAILED') {
      return res.status(409).json({ ok: false, code: 'PREFLIGHT_FAILED', error: err.message, result: err.result });
    }
    if (err && err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({ ok: false, code: err.code || null, error: req.t('feature_not_available' === err.code ? 'error.license.feature_not_available' : 'st.vpncert.err.' + err.code) });
    }
    logger.warn({ err: err.message, host }, 'POST /tls/:host/retry failed');
    res.status(500).json({ ok: false, error: 'Retry failed: ' + err.message });
  }
});

module.exports = router;
