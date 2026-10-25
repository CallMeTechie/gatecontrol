'use strict';

/**
 * "Mit Microsoft anmelden" (docs/groups.md "Verzeichnis-Abgleich und
 * Anmeldung", services/directory/oidc.js).
 *
 *   GET /auth/oidc/:directoryId/start[?returnTo=/portal…]
 *       starts the authorization code flow (state, nonce, PKCE) and sends
 *       the browser to Microsoft. The transaction id is kept in the cookie
 *       gc.oidc (HttpOnly, SameSite=Lax, path /auth/oidc, 10 minutes).
 *   GET /auth/oidc/:directoryId/callback
 *       validates everything, maps the Microsoft account to the linked
 *       GateControl account (object id) and creates the session exactly like
 *       the password login (routes/auth.js establishSession); with
 *       GateControl 2FA switched on, the TOTP step follows.
 *
 * The session cookie is SameSite=Strict: on the cross-site redirect from
 * Microsoft it is neither sent nor would a cookie set here be sent on a
 * redirect that continues this navigation. The callback therefore answers
 * with a small page that moves on with a same-site navigation (meta
 * refresh) to the target — always one of our own paths.
 */

const { setFlash } = require('../middleware/locals');
const { safeReturnTo } = require('../middleware/auth');
const config = require('../../config/default');
const logger = require('../utils/logger');
const activity = require('../services/activity');
const lockout = require('../services/lockout');
const usersService = require('../services/users');
const oidc = require('../services/directory/oidc');
const authRoutes = require('./auth');

const COOKIE = 'gc.oidc';
const COOKIE_PATH = '/auth/oidc';

function cookieOpts() {
  return {
    httpOnly: true,
    secure: config.app.baseUrl.startsWith('https'),
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: oidc.TXN_TTL_MS,
  };
}

function directoryId(req) {
  const n = Number.parseInt(req.params.directoryId, 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === req.params.directoryId ? n : null;
}

/** Same-site hop to one of our own paths (see the header). */
function bounce(res, target) {
  const to = typeof target === 'string' && /^\/(?![/\\])[A-Za-z0-9/_?=&%.#-]*$/.test(target) ? target : '/login';
  res.set('Cache-Control', 'no-store');
  return res.render(`${res.locals.theme}/pages/login-bounce.njk`, { layout: false, target: to, title: res.locals.t('auth.login') });
}

const MESSAGES = {
  OIDC_DISABLED: 'auth.oidc.error_disabled',
  STATE_MISMATCH: 'auth.oidc.error_state',
  TXN_EXPIRED: 'auth.oidc.error_expired',
  IDP_ERROR: 'auth.oidc.error_idp',
  TOKEN_EXCHANGE: 'auth.oidc.error_generic',
  BAD_TOKEN: 'auth.oidc.error_generic',
  NOT_LINKED: 'auth.oidc.error_not_linked',
  ACCOUNT_DISABLED: 'auth.oidc.error_not_linked',
};

async function start(req, res) {
  const id = directoryId(req);
  try {
    if (!id) throw Object.assign(new Error('bad id'), { code: 'OIDC_DISABLED' });
    const { txnId, url } = await oidc.begin(id, { returnTo: safeReturnTo(req.query && req.query.returnTo) || '' });
    res.cookie(COOKIE, txnId, cookieOpts());
    res.set('Cache-Control', 'no-store');
    return res.redirect(url);
  } catch (err) {
    logger.warn({ directoryId: id, code: err.code, err: err.message }, 'OIDC start failed');
    setFlash(req, 'error', res.locals.t(MESSAGES[err.code] || 'auth.oidc.error_generic'));
    return res.redirect('/login');
  }
}

async function callback(req, res) {
  const id = directoryId(req);
  const txnId = req.cookies ? req.cookies[COOKIE] : null;
  res.clearCookie(COOKIE, { path: COOKIE_PATH });
  const fail = (code, extra) => {
    logger.warn({ directoryId: id, code, ip: req.ip, ...(extra || {}) }, 'OIDC login refused');
    try {
      activity.log('login_failed', `Failed sign-in with Microsoft (${code})`, { source: 'system', ipAddress: req.ip, severity: 'warning', details: { directoryId: id, code } });
    } catch { /* logging must not break the answer */ }
    setFlash(req, 'error', res.locals.t(MESSAGES[code] || 'auth.oidc.error_generic'));
    return bounce(res, '/login');
  };
  let result;
  try {
    result = await oidc.complete(typeof txnId === 'string' ? txnId : null, req.query || {}, { directoryId: id });
  } catch (err) {
    if (!err.code) logger.error({ err: err.message }, 'OIDC callback error');
    return fail(err.code || 'ERROR', err.reason ? { reason: err.reason } : null);
  }
  const user = result.user;
  const locked = lockout.isLocked(user.username);
  if (locked.locked) {
    setFlash(req, 'error', res.locals.t('auth.error_locked').replace('{{minutes}}', String(Math.ceil(locked.remainingSeconds / 60))));
    return bounce(res, '/login');
  }
  if (!usersService.canWebLogin(user)) return fail('NOT_LINKED');
  const returnTo = safeReturnTo(result.returnTo) || '';
  // GateControl's own second factor, when the person switched it on.
  if (user.totp_enabled === 1) {
    return req.session.regenerate((err) => {
      if (err) return fail('ERROR');
      req.session.pending2fa = { userId: user.id, at: Date.now(), returnTo };
      return bounce(res, '/login/2fa');
    });
  }
  return authRoutes.establishSession(req, { ...user, must_change_password: 0 }, { method: 'oidc' }, (err) => {
    if (err) return fail('ERROR');
    return bounce(res, authRoutes.postLoginTarget(returnTo, user));
  });
}

module.exports = { start, callback, COOKIE };
