'use strict';

/**
 * Sign-in in the apps with the own account (docs/groups.md "Anmeldung in den
 * Apps"). The Android and Windows apps set themselves up without a setup code
 * from an administrator: the person signs in — local GateControl password,
 * directory account with the Windows / LDAP password, or "Mit Microsoft
 * anmelden" (Entra OIDC in the system browser, routes/oidc.js) — and, when the
 * account may set up own devices (users.mayEnroll, the rule of POST
 * /api/v1/me/enrollment), gets an ordinary one-shot setup code
 * (clientEnrollment.createCode, app scopes, the role cap). The app redeems it
 * with the unchanged POST /api/v1/client/enroll.
 *
 *   methods(t) → { password: { enabled, hint }, microsoft: [{ id, label }] }
 *   async passwordSignIn({ username, password, totp, ip }) → { user, method }
 *       the checks of the web login (routes/auth.js): lockout per typed name
 *       and per account, directory password by LDAP bind, argon2 against a
 *       dummy hash for unknown names, GateControl's TOTP. Throws err.code
 *       invalid_credentials | totp_required | totp_invalid | user_disabled |
 *       locked (err.retryAfter) | directory_unavailable |
 *       password_change_required.
 *   issueCode(user, { ip, method, directoryId, platform }) → { code, expiresAt (ISO) }
 *       throws enroll_not_allowed | user_disabled | limit_reached
 *   checkRedirectUri(raw) → the redirect URI | null — exactly
 *       gatecontrol://signin, http://127.0.0.1:<port>/signin or
 *       http://localhost:<port>/signin (RFC 8252 loopback)
 *   validState(s) / validChallenge(s) / validVerifier(s)
 *   mintHandoff({ userId, challenge, directoryId }) → one-time value; only its
 *       SHA-256 is kept (memory), 2 minutes, single use, bound to the app's
 *       PKCE challenge
 *   redeemHandoff(raw, verifier) → { userId, directoryId }; throws
 *       invalid_or_expired (unknown, used, expired or wrong verifier alike —
 *       the handoff is spent by the first attempt)
 *   returnUrl(redirectUri, params) → `<redirect_uri>?<params>`
 *   createPending / getPending / dropPending — the GateControl TOTP step
 *       after Microsoft (5 minutes, memory, routes/oidc.js /auth/app/2fa)
 *
 * Passwords, TOTP codes, setup codes and handoffs are never logged.
 */

const crypto = require('node:crypto');
const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const lockout = require('./lockout');
const activity = require('./activity');
const users = require('./users');
const twoFactor = require('./adminTwoFactor');
const directoryAuth = require('./directory/auth');
const logger = require('../utils/logger');

const HANDOFF_TTL_MS = 2 * 60 * 1000;
const MAX_HANDOFFS = 2000;
const MAX_LOGIN = 256;
const MAX_PASSWORD = 1024;

const STATE_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(sha256(verifier))
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636
const HANDOFF_RE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/signin$/;
const APP_SCHEME_URI = 'gatecontrol://signin';

// Same dummy argon2id hash as the web login (routes/auth.js): an unknown name
// costs the same as a wrong password, so the timing tells nothing.
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$Wm10dWh5V1VmMFI0b3V0Yg$qQ9zSuE6kG5lcGDBPa4htcoOPRkMiPwCfvV1Cq3pCI0';

const handoffs = new Map(); // sha256(handoff) → { userId, challenge, directoryId, at }

function coded(code, extra) {
  const err = new Error(code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function sha256b64url(s) { return crypto.createHash('sha256').update(s).digest('base64url'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function validState(s) { return typeof s === 'string' && STATE_RE.test(s); }
function validChallenge(s) { return typeof s === 'string' && CHALLENGE_RE.test(s); }
function validVerifier(s) { return typeof s === 'string' && VERIFIER_RE.test(s); }

function checkRedirectUri(raw) {
  if (typeof raw !== 'string') return null;
  if (raw === APP_SCHEME_URI) return APP_SCHEME_URI;
  const m = LOOPBACK_RE.exec(raw);
  const port = m ? Number(m[2]) : 0;
  if (!m || port > 65535) return null;
  // Rebuilt from constants and the number — the request text never becomes the target.
  return `http://${m[1] === 'localhost' ? 'localhost' : '127.0.0.1'}:${port}/signin`;
}

function returnUrl(redirectUri, params) {
  return `${redirectUri}?${new URLSearchParams(params).toString()}`;
}

// ─── What the app offers ────────────────────────────────────────────────

function methods(t) {
  const tr = typeof t === 'function' ? t : (k) => k;
  let rows = [];
  try {
    rows = getDb().prepare('SELECT id, kind, name FROM directories WHERE enabled = 1 AND login_enabled = 1 ORDER BY id').all();
  } catch { rows = []; }
  const entra = rows.filter((r) => r.kind === 'entra');
  const pw = rows.filter((r) => r.kind === 'ad' || r.kind === 'ldap');
  let hint = null;
  if (pw.length) {
    const names = pw.map((r) => r.name).join(', ');
    hint = tr(pw.every((r) => r.kind === 'ad') ? 'app_signin.hint_ad' : 'app_signin.hint_ldap').split('{{name}}').join(names);
  }
  const button = tr('auth.oidc.button');
  return {
    password: { enabled: true, hint },
    microsoft: entra.map((r) => ({ id: r.id, label: entra.length > 1 ? `${button} · ${r.name}` : button })),
  };
}

// ─── Password ───────────────────────────────────────────────────────────

function lockedError(status) {
  return coded('locked', { retryAfter: Math.max(1, Math.ceil(status.remainingSeconds || 0)) });
}

function logFailed(message, ip, details) {
  try {
    activity.log('app_signin_failed', message, { source: 'system', ipAddress: ip || null, severity: 'warning', details: details || {} });
  } catch (err) { logger.warn({ err: err.message }, 'activity log write failed (app_signin_failed)'); }
}

async function passwordSignIn({ username, password, totp, ip } = {}) {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name || name.length > MAX_LOGIN || typeof password !== 'string' || !password || password.length > MAX_PASSWORD) {
    throw coded('invalid_credentials');
  }
  const typed = lockout.isLocked(name);
  if (typed.locked) throw lockedError(typed);

  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  if (!user) {
    try { user = directoryAuth.resolveLogin(name) || undefined; } catch (err) {
      logger.warn({ err: err.message }, 'app sign-in: directory login lookup failed');
    }
  }
  if (user && user.username !== name) {
    const acc = lockout.isLocked(user.username);
    if (acc.locked) throw lockedError(acc);
  }

  // Directory accounts (role 'user', directory with sign-in on): LDAP bind,
  // never stored. Administrators always use their local password.
  let route = null;
  try { route = user ? directoryAuth.loginRoute(user) : null; } catch (err) {
    logger.warn({ err: err.message }, 'app sign-in: directory route failed');
    route = null;
  }
  let passwordOk = false;
  if (route) {
    const outcome = await directoryAuth.verifyPassword(user, password);
    if (outcome === 'unavailable') throw coded('directory_unavailable');
    passwordOk = outcome === 'ok';
  } else {
    try { passwordOk = await argon2.verify(user ? user.password_hash : DUMMY_PASSWORD_HASH, password); } catch { passwordOk = false; }
  }

  if (!user || !passwordOk) {
    lockout.recordFailedAttempt(name, 'admin', ip);
    if (user && user.username !== name) lockout.recordFailedAttempt(user.username, 'admin', ip);
    logFailed(`Failed app sign-in for user: ${name}`, ip, { method: 'password' });
    throw coded('invalid_credentials');
  }
  // From here on the password was right: the answers may name the account's state.
  if (user.enabled !== 1) {
    logFailed(`App sign-in of disabled account: ${user.username}`, ip, { method: 'password', userId: user.id, reason: 'disabled' });
    throw coded('user_disabled');
  }
  if (!route && user.must_change_password === 1) {
    logFailed(`App sign-in needs a new password first: ${user.username}`, ip, { method: 'password', userId: user.id, reason: 'password_change' });
    throw coded('password_change_required');
  }
  lockout.clearAttempts(name);
  lockout.clearAttempts(user.username);

  // security.require_2fa: an admin without 2FA is confined to the 2FA setup
  // on the web (middleware/twoFactorPolicy.js) — no device with the password alone.
  if (user.role === 'admin' && user.totp_enabled !== 1 && require('../middleware/twoFactorPolicy').isRequired()) {
    logFailed(`App sign-in of "${user.username}": two-factor login required but not set up`, ip, { method: 'password', userId: user.id, reason: 'require_2fa' });
    throw coded('enroll_not_allowed');
  }

  if (user.totp_enabled === 1) {
    const tfId = `admin_2fa:${user.id}`;
    const st = lockout.isLocked(tfId);
    if (st.locked) throw lockedError(st);
    const code = typeof totp === 'string' || typeof totp === 'number' ? String(totp).replace(/\s+/g, '') : '';
    if (!code) throw coded('totp_required');
    if (!twoFactor.verifyCode(user.id, code)) {
      lockout.recordFailedAttempt(tfId, 'admin_2fa', ip);
      logFailed(`Failed second factor in app sign-in for user: ${user.username}`, ip, { method: 'password', userId: user.id, reason: 'totp' });
      const now = lockout.isLocked(tfId);
      if (now.locked) throw lockedError(now);
      throw coded('totp_invalid');
    }
    lockout.clearAttempts(tfId);
  }
  return { user, method: route ? 'directory' : 'password', directoryId: route ? route.directory.id : null };
}

// ─── The setup code ─────────────────────────────────────────────────────

function issueCode(user, { ip = null, method = 'password', directoryId = null, platform = null } = {}) {
  const fresh = user ? getDb().prepare('SELECT * FROM users WHERE id = ?').get(user.id) : null;
  if (!fresh) throw coded('enroll_not_allowed');
  if (fresh.enabled !== 1) throw coded('user_disabled');
  const rule = users.enrollRule(fresh);
  if (!rule.allowed) {
    logFailed(`App sign-in of "${fresh.username}": own devices not allowed`, ip, { method, userId: fresh.id, reason: 'enroll_not_allowed' });
    throw coded('enroll_not_allowed');
  }
  // The device is created when the code is redeemed; refuse early when the
  // licence has no room for another one (the redeem checks again).
  const license = require('./license');
  const peers = getDb().prepare('SELECT COUNT(*) AS c FROM peers').get().c;
  if (!license.isWithinLimit('vpn_peers', peers)) throw coded('limit_reached');
  const enrollment = require('./clientEnrollment');
  let result;
  try {
    result = enrollment.createCode({ userId: fresh.id, scopes: [...enrollment.DEFAULT_SCOPES] });
  } catch (err) {
    if (err.code === 'user_disabled') throw coded('user_disabled');
    if (err.code === 'limit_reached') throw coded('limit_reached');
    if (err.code === 'no_valid_scopes') throw coded('enroll_not_allowed');
    throw err;
  }
  activity.log('app_signin', `User "${fresh.username}" signed in in the app (${method}) and got a setup code`, {
    source: 'user', ipAddress: ip, severity: 'info',
    details: {
      userId: fresh.id, method, directoryId: directoryId || null, via: rule.via, scopes: result.scopes,
      platform: typeof platform === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(platform) ? platform : null,
    },
  });
  logger.info({ userId: fresh.id, method }, 'App sign-in: setup code created');
  return { code: result.code, expiresAt: new Date(result.expiresAt).toISOString() };
}

// ─── Handoff (Microsoft in the browser → app) ───────────────────────────

function purge(now = Date.now()) {
  for (const [k, h] of handoffs) if (now - h.at > HANDOFF_TTL_MS) handoffs.delete(k);
  while (handoffs.size > MAX_HANDOFFS) handoffs.delete(handoffs.keys().next().value);
}

function mintHandoff({ userId, challenge, directoryId = null }) {
  if (!validChallenge(challenge)) throw coded('invalid_challenge');
  purge();
  const raw = crypto.randomBytes(32).toString('base64url');
  handoffs.set(sha256hex(raw), { userId, challenge, directoryId, at: Date.now() });
  return raw;
}

function redeemHandoff(raw, verifier, { now = Date.now() } = {}) {
  if (typeof raw !== 'string' || !HANDOFF_RE.test(raw)) throw coded('invalid_or_expired');
  const key = sha256hex(raw);
  const h = handoffs.get(key);
  handoffs.delete(key); // single use, successful or not
  if (!h || now - h.at > HANDOFF_TTL_MS) throw coded('invalid_or_expired');
  if (!validVerifier(verifier) || !safeEqual(sha256b64url(verifier), h.challenge)) throw coded('invalid_or_expired');
  return { userId: h.userId, directoryId: h.directoryId };
}

// ─── GateControl TOTP step of the browser flow ──────────────────────────
// After "Mit Microsoft anmelden" an account with 2FA confirms its code in the
// browser before the app gets the handoff. The pending step lives here (not
// in the web session, which is never touched by the app flow), reached with
// the cookie gc.app2fa (routes/oidc.js).

const PENDING_TTL_MS = 5 * 60 * 1000;
const pending = new Map(); // id → { userId, app, directoryId, at }

function createPending({ userId, app, directoryId = null }) {
  for (const [k, p] of pending) if (Date.now() - p.at > PENDING_TTL_MS) pending.delete(k);
  while (pending.size > MAX_HANDOFFS) pending.delete(pending.keys().next().value);
  const id = crypto.randomBytes(24).toString('base64url');
  pending.set(id, { userId, app, directoryId, at: Date.now() });
  return id;
}

function getPending(id) {
  const p = typeof id === 'string' ? pending.get(id) : null;
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) { pending.delete(id); return null; }
  return p;
}

function dropPending(id) { if (typeof id === 'string') pending.delete(id); }

function _reset() { handoffs.clear(); pending.clear(); }

module.exports = {
  methods, passwordSignIn, issueCode, checkRedirectUri, returnUrl,
  validState, validChallenge, validVerifier, mintHandoff, redeemHandoff,
  createPending, getPending, dropPending,
  HANDOFF_TTL_MS, PENDING_TTL_MS, APP_SCHEME_URI, _reset, _handoffs: handoffs, _pending: pending,
};
