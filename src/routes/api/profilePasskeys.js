'use strict';

// Own-account passkey management (docs/feature-admin-passkeys.md), mounted at
// /api/v1/profile/passkeys behind profile.js's session-only guard; CSRF via
// the /api/v1 aggregator.
//
// Adding and removing a passkey needs a fresh authentication: either the
// session was established less than REAUTH_WINDOW_MS ago, or the request
// carries the current password (which then refreshes the window).

const { Router } = require('express');
const argon2 = require('argon2');
const { getDb } = require('../../db/connection');
const passkeys = require('../../services/adminPasskeys');
const { passkeyManageLimiter } = require('../../middleware/rateLimit');
const logger = require('../../utils/logger');

const REAUTH_WINDOW_MS = 5 * 60 * 1000;

const router = Router();

async function passwordMatches(userId, password) {
  if (typeof password !== 'string' || !password) return false;
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!row || !row.password_hash || row.password_hash === '!') return false;
  try { return await argon2.verify(row.password_hash, password); } catch { return false; }
}

function recentlyAuthenticated(req) {
  const at = Math.max(Number(req.session.authAt) || 0, Number(req.session.reauthAt) || 0);
  return at > 0 && Date.now() - at <= REAUTH_WINDOW_MS;
}

/**
 * Re-auth gate. Resolves true when the caller may proceed; otherwise the
 * 403 REAUTH_REQUIRED / 400 PASSWORD_INVALID answer has been sent.
 */
async function requireReauth(req, res) {
  const password = req.body && req.body.password;
  if (typeof password === 'string' && password) {
    if (await passwordMatches(req.session.userId, password)) {
      req.session.reauthAt = Date.now();
      return true;
    }
    res.status(400).json({ ok: false, error: req.t('error.settings.password_incorrect'), code: 'PASSWORD_INVALID' });
    return false;
  }
  if (recentlyAuthenticated(req)) return true;
  res.status(403).json({ ok: false, error: req.t('passkey.error_reauth'), code: 'REAUTH_REQUIRED' });
  return false;
}

function fail(res, err, req) {
  const map = { NOT_FOUND: 404, LIMIT: 409, DUPLICATE: 409, UNAVAILABLE: 503, NO_CHALLENGE: 400, VERIFY_FAILED: 400, INVALID: 400 };
  const keys = {
    NOT_FOUND: 'passkey.error_not_found',
    LIMIT: 'passkey.error_limit',
    DUPLICATE: 'passkey.error_duplicate',
    UNAVAILABLE: 'passkey.error_unavailable',
    NO_CHALLENGE: 'passkey.error_expired',
    VERIFY_FAILED: 'passkey.error_verify',
    INVALID: 'passkey.error_verify',
  };
  const status = map[err && err.code] || 500;
  if (status === 500) logger.error({ err: err && err.message }, 'Profile passkey handler failed');
  return res.status(status).json({ ok: false, error: req.t(keys[err && err.code] || 'common.error'), code: (err && err.code) || 'ERROR' });
}

/** GET /api/v1/profile/passkeys — list + whether add/remove needs the password */
router.get('/', (req, res) => {
  const rp = passkeys.getRelyingParty();
  res.json({
    ok: true,
    data: {
      available: !!rp,
      origin: rp ? rp.origin : null,
      reauth_required: !recentlyAuthenticated(req),
      max: passkeys.MAX_PASSKEYS_PER_USER,
      passkeys: passkeys.list(req.session.userId),
    },
  });
});

/** POST /api/v1/profile/passkeys/register/options { password? } → PublicKeyCredentialCreationOptionsJSON */
router.post('/register/options', passkeyManageLimiter, async (req, res) => {
  try {
    if (!(await requireReauth(req, res))) return;
    const { options, challenge } = await passkeys.beginRegistration(req.session.userId);
    req.session.passkeyRegistration = { challenge, at: Date.now(), userId: req.session.userId };
    res.json({ ok: true, data: options });
  } catch (err) {
    fail(res, err, req);
  }
});

/** POST /api/v1/profile/passkeys/register { name, response } → stored passkey */
router.post('/register', passkeyManageLimiter, async (req, res) => {
  const pending = req.session.passkeyRegistration;
  delete req.session.passkeyRegistration; // single use, also on failure
  try {
    const valid = pending && pending.userId === req.session.userId && typeof pending.at === 'number'
      && Date.now() - pending.at <= passkeys.CHALLENGE_TTL_MS;
    if (!valid) return fail(res, { code: 'NO_CHALLENGE' }, req);
    const body = req.body || {};
    const passkey = await passkeys.finishRegistration(req.session.userId, {
      response: body.response,
      expectedChallenge: pending.challenge,
      name: body.name,
      ip: req.ip,
    });
    res.json({ ok: true, data: passkey });
  } catch (err) {
    fail(res, err, req);
  }
});

/** POST /api/v1/profile/passkeys/:id/delete { password? } */
router.post('/:id/delete', passkeyManageLimiter, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return fail(res, { code: 'NOT_FOUND' }, req);
    if (!(await requireReauth(req, res))) return;
    passkeys.remove(req.session.userId, id, req.ip);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, req);
  }
});

module.exports = router;
module.exports.REAUTH_WINDOW_MS = REAUTH_WINDOW_MS;
