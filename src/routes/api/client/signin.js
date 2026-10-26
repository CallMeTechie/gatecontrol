'use strict';

/**
 * Sign-in in the apps with the own account (docs/groups.md "Anmeldung in den
 * Apps", services/appSignin.js) — public like POST /api/v1/client/enroll: the
 * app has no token yet. Mounted before requireAuth in routes/index.js, every
 * endpoint rate-limited per address; JSON only, no session, no CSRF token.
 *
 *   GET  /api/v1/client/signin
 *        → { ok, version: 1, password: { enabled, hint }, microsoft: [{ id, label }] }
 *   POST /api/v1/client/signin/password { username, password, totp?, hostname?, platform? }
 *        → { ok, code, expiresAt } — an ordinary setup code for POST /api/v1/client/enroll
 *        401 invalid_credentials | totp_required | totp_invalid
 *        403 enroll_not_allowed | user_disabled | limit_reached | password_change_required
 *        429 rate_limited | locked (+ retryAfter in seconds)
 *        503 directory_unavailable
 *   POST /api/v1/client/signin/handoff { handoff, verifier }
 *        → { ok, code, expiresAt } — after "Mit Microsoft anmelden" in the
 *        browser (routes/oidc.js, ?client=app); sha256(verifier) must match
 *        the challenge the app sent to /auth/oidc/:id/start
 *        400 invalid_or_expired · 403 enroll_not_allowed | user_disabled | limit_reached
 *
 * An unknown account, a wrong password and a passkey-only account get the
 * same answer; the account's state (disabled, own devices not allowed, 2FA)
 * is only named after the password was right. Passwords, TOTP codes, setup
 * codes and handoffs are never logged.
 */

const { Router } = require('express');
const appSignin = require('../../../services/appSignin');
const { getDb } = require('../../../db/connection');
const logger = require('../../../utils/logger');
const { appSigninInfoLimiter, appSigninLimiter, appHandoffLimiter } = require('../../../middleware/rateLimit');

const router = Router();

const STATUS = {
  invalid_credentials: 401,
  totp_required: 401,
  totp_invalid: 401,
  enroll_not_allowed: 403,
  user_disabled: 403,
  limit_reached: 403,
  password_change_required: 403,
  locked: 429,
  invalid_or_expired: 400,
  directory_unavailable: 503,
};

function noStore(res) { res.set('Cache-Control', 'no-store'); }

function failed(res, err, where) {
  const status = STATUS[err && err.code];
  if (!status) {
    logger.error({ err: err && err.message }, `app sign-in (${where}) failed`);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
  const body = { ok: false, error: err.code };
  if (err.code === 'locked') {
    body.retryAfter = err.retryAfter;
    res.set('Retry-After', String(err.retryAfter));
  }
  return res.status(status).json(body);
}

router.get('/', appSigninInfoLimiter, (req, res) => {
  noStore(res);
  res.json({ ok: true, version: 1, ...appSignin.methods(req.t) });
});

router.post('/password', appSigninLimiter, async (req, res) => {
  noStore(res);
  const b = req.body || {};
  try {
    const { user, method, directoryId } = await appSignin.passwordSignIn({ username: b.username, password: b.password, totp: b.totp, ip: req.ip });
    const out = appSignin.issueCode(user, { ip: req.ip, method, directoryId, platform: b.platform });
    return res.json({ ok: true, code: out.code, expiresAt: out.expiresAt });
  } catch (err) {
    return failed(res, err, 'password');
  }
});

router.post('/handoff', appHandoffLimiter, (req, res) => {
  noStore(res);
  const b = req.body || {};
  try {
    const h = appSignin.redeemHandoff(b.handoff, b.verifier);
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(h.userId);
    const out = appSignin.issueCode(user, { ip: req.ip, method: 'microsoft', directoryId: h.directoryId });
    return res.json({ ok: true, code: out.code, expiresAt: out.expiresAt });
  } catch (err) {
    if (err.code === 'invalid_or_expired') {
      try {
        require('../../../services/activity').log('app_signin_failed', 'App sign-in: handoff unknown, used, expired or with a wrong verifier', {
          source: 'system', ipAddress: req.ip, severity: 'warning', details: { method: 'microsoft', reason: 'handoff' },
        });
      } catch { /* logging must not break the answer */ }
    }
    return failed(res, err, 'handoff');
  }
});

module.exports = router;
