'use strict';

/**
 * Pairing of GateControl TV with a signed-in phone (services/clientPairing.js).
 * Mounted before requireAuth in routes/index.js: start and poll are public
 * like POST /api/v1/client/enroll (the TV has no token yet); approve needs
 * the phone app's device token (scope `client`, an account that may set up
 * own devices). JSON only, no session, no CSRF token (start/poll carry no
 * ambient credential; approve is token-only — a browser session uses
 * POST /api/v1/me/pair/approve or /api/v1/portal/me/pair/approve, which are
 * CSRF-protected).
 *
 *   POST /api/v1/client/pair/start { name?, platform?, clientVersion? }
 *        → 201 { ok, pairingId, pollSecret, code, expiresAt, interval, url, link }
 *          link = gatecontrol://tv-pair?url=<server>&id=<pairingId> (for the QR code;
 *          never the code or the poll secret)
 *        503 busy · 429 rate_limited
 *   POST /api/v1/client/pair/poll { pairingId, pollSecret }
 *        → 200 { ok, status: 'pending', interval, expiresAt }
 *        → 200 { ok, status: 'approved', code, expiresAt, name } — once; then POST /api/v1/client/enroll
 *        400 invalid_or_expired · 429 slow_down (+ interval) | rate_limited
 *        403 enroll_not_allowed | user_disabled | limit_reached
 *   POST /api/v1/client/pair/approve { code, pairingId?, name? }   (Authorization: Bearer <device token>)
 *        → 200 { ok, name, platform, clientVersion }
 *        400 invalid_code · 401 · 403 token_required | enroll_not_allowed | user_disabled
 *        429 locked (+ retryAfter) | rate_limited
 */

const { Router } = require('express');
const pairing = require('../../../services/clientPairing');
const users = require('../../../services/users');
const logger = require('../../../utils/logger');
const { appBaseUrl } = require('../../../utils/appBaseUrl');
const { requireAuth } = require('../../../middleware/auth');
const { clientPairStartLimiter, clientPairPollLimiter, clientPairApproveLimiter } = require('../../../middleware/rateLimit');

const router = Router();

const STATUS = {
  busy: 503,
  invalid_or_expired: 400,
  invalid_code: 400,
  slow_down: 429,
  locked: 429,
  enroll_not_allowed: 403,
  user_disabled: 403,
  limit_reached: 403,
  token_required: 403,
};

function noStore(res) { res.set('Cache-Control', 'no-store'); }

/** The answer of a failed step (shared with routes/api/me.js). */
function failed(res, err, where) {
  const status = STATUS[err && err.code];
  if (!status) {
    logger.error({ err: err && err.message }, `TV pairing (${where}) failed`);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
  const body = { ok: false, error: err.code };
  if (err.code === 'locked') {
    body.retryAfter = err.retryAfter;
    res.set('Retry-After', String(err.retryAfter));
  }
  if (err.code === 'slow_down') body.interval = err.interval;
  return res.status(status).json(body);
}

const str = (v) => (typeof v === 'string' ? v : undefined);

router.post('/start', clientPairStartLimiter, (req, res) => {
  noStore(res);
  const b = req.body || {};
  try {
    const out = pairing.start({ name: str(b.name), platform: str(b.platform), clientVersion: str(b.clientVersion) }, req.ip);
    const url = appBaseUrl(req);
    const link = `gatecontrol://tv-pair?url=${encodeURIComponent(url)}&id=${out.pairingId}`;
    return res.status(201).json({ ok: true, ...out, url, link });
  } catch (err) {
    return failed(res, err, 'start');
  }
});

router.post('/poll', clientPairPollLimiter, (req, res) => {
  noStore(res);
  const b = req.body || {};
  try {
    return res.json({ ok: true, ...pairing.poll({ pairingId: b.pairingId, pollSecret: b.pollSecret }, req.ip) });
  } catch (err) {
    return failed(res, err, 'poll');
  }
});

/** The approve of a signed-in account (phone app here, sessions in routes/api/me.js). */
function approveAs(user, req, res, via) {
  noStore(res);
  const b = req.body || {};
  try {
    const out = pairing.approve(user, {
      code: str(b.code), pairingId: b.pairingId === undefined ? undefined : str(b.pairingId) || '', name: str(b.name),
      via, tokenId: req.tokenAuth ? req.tokenId : null,
    }, req.ip);
    return res.json({ ok: true, name: out.name, platform: out.platform, clientVersion: out.clientVersion });
  } catch (err) {
    return failed(res, err, 'approve');
  }
}

// requireAuth: the token's scope (`client`, services/tokens.js SCOPE_MAP), machine binding and the account's state
router.post('/approve', requireAuth, (req, res, next) => {
  if (!req.tokenAuth) return failed(res, Object.assign(new Error('token_required'), { code: 'token_required' }), 'approve');
  return next();
}, clientPairApproveLimiter, (req, res) => {
  const user = req.tokenUserId ? users.getById(req.tokenUserId) : null;
  // a token without an account (scripts, old hand-made tokens) has nobody to own the TV
  if (!user) return failed(res, Object.assign(new Error('enroll_not_allowed'), { code: 'enroll_not_allowed' }), 'approve');
  return approveAs(user, req, res, 'app');
});

module.exports = router;
module.exports.approveAs = approveAs;
