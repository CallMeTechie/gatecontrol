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
 *
 * Sign-in in the apps (docs/groups.md "Anmeldung in den Apps"):
 *   GET /auth/oidc/:directoryId/start?client=app&redirect_uri=&state=&challenge=
 *       redirect_uri exactly gatecontrol://signin or
 *       http://127.0.0.1|localhost:<port>/signin, the app's state and its PKCE
 *       challenge (base64url(sha256(verifier))) — anything else is a 400
 *       page. They stay in the server-side transaction. The web session is
 *       neither required nor touched.
 *   callback → account linked, enabled, not locked and allowed to set up
 *       own devices (users.mayEnroll) → with GateControl 2FA the TOTP step
 *       (/auth/app/2fa, cookie gc.app2fa) → a single-use handoff (2 min,
 *       bound to the challenge, services/appSignin.js) and back to the app:
 *       <redirect_uri>?handoff=…&state=…, on failure ?error=<code>&state=…
 *       (access_denied | not_linked | enroll_not_allowed | user_disabled |
 *       failed). The page links to the app („Zurück zur App“) and moves on by
 *       itself (meta refresh) — a custom scheme needs a page, not a 302.
 */

const { setFlash } = require('../middleware/locals');
const { safeReturnTo } = require('../middleware/auth');
const config = require('../../config/default');
const logger = require('../utils/logger');
const activity = require('../services/activity');
const lockout = require('../services/lockout');
const usersService = require('../services/users');
const oidc = require('../services/directory/oidc');
const appSignin = require('../services/appSignin');
const twoFactor = require('../services/adminTwoFactor');
const { ensureCsrfToken } = require('../middleware/csrf');
const authRoutes = require('./auth');

const COOKIE = 'gc.oidc';
const COOKIE_PATH = '/auth/oidc';
// The pending TOTP step of the app flow (services/appSignin.js createPending).
const APP_COOKIE = 'gc.app2fa';
const APP_COOKIE_PATH = '/auth/app';

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

// ─── Sign-in in the apps ──────────────────────────────────────────────────

/** guestOnly for the web flow; the app flow may start from a signed-in browser. */
function guestOrApp(guestOnly) {
  return (req, res, next) => (req.query && req.query.client === 'app' ? next() : guestOnly(req, res, next));
}

const APP_ERRORS = ['access_denied', 'not_linked', 'enroll_not_allowed', 'user_disabled', 'failed'];

/** The page that hands over to the app (link + meta refresh to redirect_uri). */
function toApp(res, app, params, { ok = false } = {}) {
  const target = appSignin.returnUrl(app.redirectUri, { ...params, state: app.state });
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.render(`${res.locals.theme}/pages/app-signin.njk`, {
    layout: false, title: res.locals.t('app_signin.title'), mode: ok ? 'done' : 'error', target,
    message: ok ? res.locals.t('app_signin.done_text') : res.locals.t(`app_signin.error.${params.error}`),
  });
}

function appFail(req, res, app, code, extra) {
  const error = APP_ERRORS.includes(code) ? code : 'failed';
  logger.warn({ directoryId: directoryId(req), code: error, ip: req.ip, ...(extra || {}) }, 'App sign-in with Microsoft refused');
  try {
    activity.log('app_signin_failed', `Failed app sign-in with Microsoft (${error})`, {
      source: 'system', ipAddress: req.ip, severity: 'warning', details: { method: 'microsoft', directoryId: directoryId(req), reason: error, ...(extra || {}) },
    });
  } catch { /* logging must not break the answer */ }
  return toApp(res, app, { error });
}

function appDone(req, res, app, user, dirId) {
  let handoff;
  try { handoff = appSignin.mintHandoff({ userId: user.id, challenge: app.challenge, directoryId: dirId }); } catch {
    return appFail(req, res, app, 'failed');
  }
  logger.info({ userId: user.id, directoryId: dirId }, 'App sign-in with Microsoft: handoff issued');
  return toApp(res, app, { handoff }, { ok: true });
}

function badAppRequest(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(400).render(`${res.locals.theme}/pages/app-signin.njk`, {
    layout: false, title: res.locals.t('app_signin.title'), mode: 'invalid', target: null, message: res.locals.t('app_signin.invalid_text'),
  });
}

function appCookieOpts() {
  return { httpOnly: true, secure: config.app.baseUrl.startsWith('https'), sameSite: 'lax', path: APP_COOKIE_PATH, maxAge: appSignin.PENDING_TTL_MS };
}

async function startApp(req, res) {
  const id = directoryId(req);
  const q = req.query || {};
  const redirectUri = appSignin.checkRedirectUri(q.redirect_uri);
  if (!id || !redirectUri || !appSignin.validState(q.state) || !appSignin.validChallenge(q.challenge)) {
    logger.warn({ directoryId: id, ip: req.ip }, 'App sign-in: invalid start request');
    return badAppRequest(res);
  }
  const app = { redirectUri, state: q.state, challenge: q.challenge };
  try {
    const { txnId, url } = await oidc.begin(id, { app });
    res.cookie(COOKIE, txnId, cookieOpts());
    res.set('Cache-Control', 'no-store');
    return res.redirect(url);
  } catch (err) {
    logger.warn({ directoryId: id, code: err.code, err: err.message }, 'App sign-in: OIDC start failed');
    return appFail(req, res, app, 'failed', { code: err.code || 'ERROR' });
  }
}

/** After Microsoft: the checks of the app flow, then TOTP or the handoff. */
function finishApp(req, res, result) {
  const { user, app } = result;
  const dirId = result.directory ? result.directory.id : directoryId(req);
  if (lockout.isLocked(user.username).locked) return appFail(req, res, app, 'failed', { reason: 'locked', userId: user.id });
  if (user.enabled !== 1) return appFail(req, res, app, 'user_disabled', { userId: user.id });
  if (!usersService.mayEnroll(user)) return appFail(req, res, app, 'enroll_not_allowed', { userId: user.id });
  if (user.totp_enabled === 1) {
    const pid = appSignin.createPending({ userId: user.id, app, directoryId: dirId });
    res.cookie(APP_COOKIE, pid, appCookieOpts());
    return bounce(res, '/auth/app/2fa');
  }
  return appDone(req, res, app, user, dirId);
}

function appIdpCode(err) {
  if (err.code === 'NOT_LINKED') return 'not_linked';
  if (err.code === 'ACCOUNT_DISABLED') return 'user_disabled';
  if (err.code === 'IDP_ERROR' && err.idpError === 'access_denied') return 'access_denied';
  return 'failed';
}

function pendingOf(req) {
  const pid = req.cookies ? req.cookies[APP_COOKIE] : null;
  const p = appSignin.getPending(pid);
  return p ? { pid, p } : null;
}

function renderAppTwoFactor(req, res, p, error) {
  ensureCsrfToken(req, res);
  res.set('Cache-Control', 'no-store');
  const remaining = Math.max(0, appSignin.PENDING_TTL_MS - (Date.now() - p.at));
  return res.render(`${res.locals.theme}/pages/login-2fa.njk`, {
    title: res.locals.t('two_fa.login_title'),
    layout: false,
    formAction: '/auth/app/2fa',
    appFlow: true,
    appError: error || null,
    useRecovery: req.query && req.query.recovery === '1',
    remainingSeconds: Math.ceil(remaining / 1000),
    remainingText: res.locals.t('two_fa.time_remaining').replace('{{minutes}}', String(Math.max(1, Math.ceil(remaining / 60000)))),
  });
}

function appTwoFactorPage(req, res) {
  const hit = pendingOf(req);
  if (!hit) return badAppRequest(res);
  return renderAppTwoFactor(req, res, hit.p);
}

async function appTwoFactor(req, res) {
  const hit = pendingOf(req);
  if (!hit) return badAppRequest(res);
  const { pid, p } = hit;
  const tfId = `admin_2fa:${p.userId}`;
  const user = require('../db/connection').getDb().prepare('SELECT * FROM users WHERE id = ?').get(p.userId);
  const end = (code, extra) => {
    appSignin.dropPending(pid);
    res.clearCookie(APP_COOKIE, { path: APP_COOKIE_PATH });
    return appFail(req, res, p.app, code, extra);
  };
  if (!user || user.enabled !== 1) return end('user_disabled', { userId: p.userId });
  if (user.totp_enabled !== 1) return end('failed', { userId: p.userId, reason: 'totp_off' });
  if (lockout.isLocked(tfId).locked) return end('failed', { userId: p.userId, reason: 'locked' });
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const recovery = typeof req.body.recovery_code === 'string' ? req.body.recovery_code.trim() : '';
  let ok = false;
  if (recovery) ok = await twoFactor.verifyRecoveryCode(user.id, recovery);
  else if (code) ok = twoFactor.verifyCode(user.id, code);
  if (!ok) {
    // The code itself is never logged.
    lockout.recordFailedAttempt(tfId, 'admin_2fa', req.ip);
    try {
      activity.log('app_signin_failed', `Failed second factor in app sign-in for user: ${user.username}`, {
        source: 'system', ipAddress: req.ip, severity: 'warning', details: { method: 'microsoft', userId: user.id, reason: 'totp' },
      });
    } catch { /* logging must not break the answer */ }
    if (lockout.isLocked(tfId).locked) return end('failed', { userId: user.id, reason: 'locked' });
    return renderAppTwoFactor(req, res, p, res.locals.t(recovery ? 'two_fa.error_recovery_invalid' : 'two_fa.error_code_invalid'));
  }
  lockout.clearAttempts(tfId);
  appSignin.dropPending(pid);
  res.clearCookie(APP_COOKIE, { path: APP_COOKIE_PATH });
  if (!usersService.mayEnroll(user)) return appFail(req, res, p.app, 'enroll_not_allowed', { userId: user.id });
  return appDone(req, res, p.app, user, p.directoryId);
}

// ─── Web sign-in ──────────────────────────────────────────────────────────

async function start(req, res) {
  if (req.query && req.query.client === 'app') return startApp(req, res);
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
    if (err.app) return appFail(req, res, err.app, appIdpCode(err), { code: err.code || 'ERROR', ...(err.reason ? { reason: err.reason } : {}) });
    return fail(err.code || 'ERROR', err.reason ? { reason: err.reason } : null);
  }
  if (result.app) return finishApp(req, res, result);
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

module.exports = { start, callback, guestOrApp, appTwoFactorPage, appTwoFactor, COOKIE, APP_COOKIE };
