'use strict';

/**
 * POST /api/v1/client/enroll — public, unauthenticated. The app trades a
 * one-shot setup code (issued via POST /api/v1/enrollment) for an API token
 * bound to its peer plus the WireGuard config. Mounted before requireAuth
 * in routes/index.js, rate-limited per IP.
 *
 * Body: { code, hostname, platform, clientVersion }
 * Header: X-Machine-Fingerprint (bound when machine binding is active)
 * 200: { ok, token, peerId, peerName, config, hash, scopes }
 * 400: { ok:false, error:'invalid_or_expired' } — unknown/expired/used alike
 */

const { Router } = require('express');
const enrollment = require('../../../services/clientEnrollment');
const logger = require('../../../utils/logger');

const router = Router();

const ERROR_STATUS = {
  invalid_or_expired: 400,
  fingerprint_required: 400,
  invalid_hostname: 400,
  user_disabled: 403,
  user_not_found: 403,
  limit_reached: 403,
  no_valid_scopes: 403,
  peer_not_found: 404,
};

router.post('/', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await enrollment.redeemCode(body.code, {
      hostname: typeof body.hostname === 'string' ? body.hostname : '',
      platform: typeof body.platform === 'string' ? body.platform : '',
      clientVersion: typeof body.clientVersion === 'string' ? body.clientVersion : '',
      fingerprint: req.headers['x-machine-fingerprint'],
    }, req.ip);
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = ERROR_STATUS[err.code];
    if (status) return res.status(status).json({ ok: false, error: err.code });
    logger.error({ error: err.message }, 'Client enrollment redeem failed');
    res.status(500).json({ ok: false, error: 'enroll_failed' });
  }
});

module.exports = router;
