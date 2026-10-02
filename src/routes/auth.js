'use strict';

const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const { setFlash } = require('../middleware/locals');
const { ensureCsrfToken } = require('../middleware/csrf');
const config = require('../../config/default');
const logger = require('../utils/logger');
const lockout = require('../services/lockout');
const { safeReturnTo } = require('../middleware/auth');
const twoFactor = require('../services/adminTwoFactor');
const passkeys = require('../services/adminPasskeys');

// A password-verified login that still awaits the second factor lives in
// req.session.pending2fa = { userId, at, returnTo } for at most this long.
const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

function getPending2fa(req) {
  const p = req.session && req.session.pending2fa;
  if (!p || !p.userId || typeof p.at !== 'number') return null;
  if (Date.now() - p.at > PENDING_2FA_TTL_MS) {
    delete req.session.pending2fa;
    return null;
  }
  return p;
}

function lockoutId(userId) {
  return `admin_2fa:${userId}`;
}

/**
 * Final step shared by the password-only, the 2FA and the passkey path:
 * last_login, activity log, session regeneration (fixation), userId +
 * language + how/when the session was authenticated. `done(err)` runs after
 * the regenerated session is populated.
 *
 * method: 'password' | 'totp' | 'passkey'. A 'passkey' session counts as
 * multi-factor (phishing-resistant, user verification required) for the
 * security.require_2fa policy; `authAt` drives the "recent login" re-auth
 * window of the passkey management endpoints.
 */
function establishSession(req, user, { method, passkeyName } = {}, done) {
  const db = getDb();
  lockout.clearAttempts(user.username);
  lockout.clearAttempts(lockoutId(user.id));

  db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(user.id);
  if (method === 'passkey') {
    db.prepare(`
      INSERT INTO activity_log (event_type, message, source, ip_address, severity)
      VALUES ('passkey_login', ?, 'system', ?, 'info')
    `).run(`User ${user.username} logged in with passkey "${passkeyName || ''}"`, req.ip);
  } else {
    db.prepare(`
      INSERT INTO activity_log (event_type, message, source, ip_address, severity)
      VALUES ('login', ?, 'system', ?, 'info')
    `).run(`User ${user.username} logged in`, req.ip);
  }

  const language = user.language || config.i18n.defaultLanguage;
  req.session.regenerate((err) => {
    if (err) {
      logger.error({ err }, 'Session regeneration failed');
      return done(err);
    }
    req.session.userId = user.id;
    req.session.language = language;
    req.session.authMethod = method || 'password';
    req.session.authAt = Date.now();

    logger.info({ username: user.username, ip: req.ip, twoFactor: user.totp_enabled === 1, method: method || 'password' }, 'Successful login');
    return done(null);
  });
}

function completeLogin(req, res, user, returnTo, method) {
  establishSession(req, user, { method: method || 'password' }, (err) => {
    if (err) {
      setFlash(req, 'error', res.locals.t('auth.error_generic'));
      return res.redirect('/login');
    }
    return res.redirect(returnTo || '/dashboard');
  });
}

function renderTwoFactorPage(req, res, pending) {
  ensureCsrfToken(req, res);
  const remaining = Math.max(0, PENDING_2FA_TTL_MS - (Date.now() - pending.at));
  res.render(`${res.locals.theme}/pages/login-2fa.njk`, {
    title: res.locals.t('two_fa.login_title'),
    layout: false,
    useRecovery: req.query && req.query.recovery === '1',
    remainingSeconds: Math.ceil(remaining / 1000),
    remainingText: res.locals.t('two_fa.time_remaining').replace('{{minutes}}', String(Math.max(1, Math.ceil(remaining / 60000)))),
  });
}

// Precomputed dummy argon2id hash used when the username does not exist,
// so verify() runs against a real hash and attackers cannot enumerate
// usernames by timing the short-circuit.
// Computed at module load and frozen: value never needs to validate any
// real password — `argon2.verify` returns false on mismatch.
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$Wm10dWh5V1VmMFI0b3V0Yg$qQ9zSuE6kG5lcGDBPa4htcoOPRkMiPwCfvV1Cq3pCI0';

const authRoutes = {
  loginPage(req, res) {
    // Mint a CSRF token explicitly: injectCsrfToken no longer
    // pre-generates for anon visitors (anti session-pollution), but
    // the login form needs a real token for the POST roundtrip.
    ensureCsrfToken(req, res);
    res.render(`${res.locals.theme}/pages/login.njk`, {
      title: res.locals.t('auth.login'),
      layout: false,
      // Carry a validated portal returnTo through the form so the POST can
      // send the user back to the portal after login (empty = admin default).
      returnTo: safeReturnTo(req.query && req.query.returnTo) || '',
      // Passkey button only when GC_BASE_URL allows WebAuthn at all; the
      // page script additionally hides it when the browser is on another
      // origin (the RP ID is pinned to GC_BASE_URL).
      passkeyOrigin: (passkeys.getRelyingParty() || {}).origin || '',
    });
  },

  async login(req, res) {
    const { username, password } = req.body;
    // Validated internal-only redirect target (portal path); null → /dashboard.
    const returnTo = safeReturnTo(req.body && req.body.returnTo);

    if (!username || !password) {
      setFlash(req, 'error', res.locals.t('auth.error_required'));
      return res.redirect('/login');
    }

    try {
      const db = getDb();

      // Check account lockout
      const lockoutStatus = lockout.isLocked(username);
      if (lockoutStatus.locked) {
        const mins = Math.ceil(lockoutStatus.remainingSeconds / 60);
        logger.warn({ username, ip: req.ip, remainingSeconds: lockoutStatus.remainingSeconds }, 'Login blocked by lockout');
        setFlash(req, 'error', res.locals.t('auth.error_locked').replace('{{minutes}}', String(mins)));
        return res.redirect('/login');
      }

      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

      // Constant-time path: always run argon2.verify, even when the
      // username doesn't exist, so the short-circuit timing no longer
      // leaks "this user exists".
      const hashToCheck = user ? user.password_hash : DUMMY_PASSWORD_HASH;
      let passwordOk = false;
      try { passwordOk = await argon2.verify(hashToCheck, password); } catch { passwordOk = false; }
      // A disabled account is refused exactly like a wrong password (same
      // flash, same lockout accounting, argon2 already ran) so the response
      // does not reveal whether the account exists or is disabled.
      if (!user || !passwordOk || user.enabled !== 1) {
        logger.warn({ username, ip: req.ip }, 'Failed login attempt');

        // Record failed attempt for lockout
        lockout.recordFailedAttempt(username, 'admin', req.ip);

        // Log failed attempt
        db.prepare(`
          INSERT INTO activity_log (event_type, message, source, ip_address, severity)
          VALUES ('login_failed', ?, 'system', ?, 'warning')
        `).run(`Failed login for user: ${username}`, req.ip);

        setFlash(req, 'error', res.locals.t('auth.error_invalid'));
        return res.redirect('/login');
      }

      // Password ok. With 2FA active the session stays unauthenticated
      // (no userId) until /login/2fa completes; only a short-lived marker
      // is stored. The password lockout counter is reset here — the 2FA
      // step has its own (admin_2fa:<userId>).
      if (user.totp_enabled === 1) {
        lockout.clearAttempts(username);
        delete req.session.userId;
        req.session.pending2fa = { userId: user.id, at: Date.now(), returnTo: returnTo || '' };
        logger.info({ username, ip: req.ip }, 'Password accepted, awaiting second factor');
        return res.redirect('/login/2fa');
      }

      return completeLogin(req, res, user, returnTo);
    } catch (err) {
      logger.error({ err }, 'Login error');
      setFlash(req, 'error', res.locals.t('auth.error_generic'));
      return res.redirect('/login');
    }
  },

  // ─── Second factor ───────────────────────────────────────────────────

  twoFactorPage(req, res) {
    const pending = getPending2fa(req);
    if (!pending) {
      setFlash(req, 'error', res.locals.t('two_fa.error_expired'));
      return res.redirect('/login');
    }
    const status = lockout.isLocked(lockoutId(pending.userId));
    if (status.locked) {
      delete req.session.pending2fa;
      setFlash(req, 'error', res.locals.t('auth.error_locked').replace('{{minutes}}', String(Math.ceil(status.remainingSeconds / 60))));
      return res.redirect('/login');
    }
    return renderTwoFactorPage(req, res, pending);
  },

  async twoFactor(req, res) {
    const pending = getPending2fa(req);
    if (!pending) {
      setFlash(req, 'error', res.locals.t('two_fa.error_expired'));
      return res.redirect('/login');
    }
    const userId = pending.userId;
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const recoveryCode = typeof req.body.recovery_code === 'string' ? req.body.recovery_code.trim() : '';
    const backTo = recoveryCode ? '/login/2fa?recovery=1' : '/login/2fa';

    try {
      const status = lockout.isLocked(lockoutId(userId));
      if (status.locked) {
        delete req.session.pending2fa;
        logger.warn({ userId, ip: req.ip, remainingSeconds: status.remainingSeconds }, '2FA blocked by lockout');
        setFlash(req, 'error', res.locals.t('auth.error_locked').replace('{{minutes}}', String(Math.ceil(status.remainingSeconds / 60))));
        return res.redirect('/login');
      }

      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND enabled = 1').get(userId);
      if (!user || user.totp_enabled !== 1) {
        // 2FA was reset/disabled meanwhile (or the account vanished): back
        // to the password form, nothing to verify against.
        delete req.session.pending2fa;
        setFlash(req, 'error', res.locals.t('two_fa.error_expired'));
        return res.redirect('/login');
      }

      if (!code && !recoveryCode) {
        setFlash(req, 'error', res.locals.t('two_fa.error_code_required'));
        return res.redirect(backTo);
      }

      let ok = false;
      let via = 'totp';
      if (recoveryCode) {
        via = 'recovery';
        ok = await twoFactor.verifyRecoveryCode(userId, recoveryCode);
      } else {
        ok = twoFactor.verifyCode(userId, code);
      }

      if (!ok) {
        // The code itself is never logged.
        logger.warn({ userId, username: user.username, ip: req.ip, via }, 'Failed second-factor attempt');
        lockout.recordFailedAttempt(lockoutId(userId), 'admin_2fa', req.ip);
        db.prepare(`
          INSERT INTO activity_log (event_type, message, source, ip_address, severity)
          VALUES ('login_2fa_failed', ?, 'system', ?, 'warning')
        `).run(`Failed second-factor attempt for user: ${user.username}`, req.ip);

        const now = lockout.isLocked(lockoutId(userId));
        if (now.locked) {
          // Failure limit reached: the password step must be repeated.
          delete req.session.pending2fa;
          setFlash(req, 'error', res.locals.t('auth.error_locked').replace('{{minutes}}', String(Math.ceil(now.remainingSeconds / 60))));
          return res.redirect('/login');
        }
        setFlash(req, 'error', res.locals.t(via === 'recovery' ? 'two_fa.error_recovery_invalid' : 'two_fa.error_code_invalid'));
        return res.redirect(backTo);
      }

      const returnTo = safeReturnTo(pending.returnTo);
      delete req.session.pending2fa;
      return completeLogin(req, res, user, returnTo, 'totp');
    } catch (err) {
      logger.error({ err }, '2FA login error');
      setFlash(req, 'error', res.locals.t('auth.error_generic'));
      return res.redirect('/login');
    }
  },

  // ─── Passkey (WebAuthn) ──────────────────────────────────────────────
  // Usernameless: options carry no allowCredentials; the authenticator
  // picks the account. The challenge sits in the (anonymous) session,
  // expires after CHALLENGE_TTL_MS and is consumed by the first verify
  // attempt, successful or not.

  async passkeyOptions(req, res) {
    try {
      const { options, challenge } = await passkeys.beginAuthentication();
      // A login ceremony starts on a fresh session id (fixation): a session
      // id planted before this point never carries the challenge. The
      // anonymous CSRF token is carried over so the login page's forms (and
      // the verify call) keep working; it is no authentication secret, and
      // establishSession() regenerates once more on success.
      const csrfToken = req.session.csrfToken;
      return req.session.regenerate((regenErr) => {
        if (regenErr) {
          logger.error({ err: regenErr.message }, 'Session regeneration failed (passkey options)');
          return res.status(500).json({ ok: false, error: res.locals.t('auth.error_generic') });
        }
        if (csrfToken) req.session.csrfToken = csrfToken;
        req.session.passkeyLogin = { challenge, at: Date.now() };
        return res.json({ ok: true, data: options });
      });
    } catch (err) {
      if (err.code === 'UNAVAILABLE') {
        return res.status(503).json({ ok: false, error: res.locals.t('passkey.error_unavailable'), code: 'UNAVAILABLE' });
      }
      logger.error({ err: err.message }, 'Passkey login options failed');
      return res.status(500).json({ ok: false, error: res.locals.t('auth.error_generic') });
    }
  },

  async passkeyLogin(req, res) {
    const pending = req.session.passkeyLogin;
    delete req.session.passkeyLogin; // single use
    const expectedChallenge = pending && typeof pending.at === 'number'
      && Date.now() - pending.at <= passkeys.CHALLENGE_TTL_MS ? pending.challenge : null;
    const returnTo = safeReturnTo(req.body && req.body.returnTo);
    const fail = (status, key, code) => res.status(status).json({ ok: false, error: res.locals.t(key), code });

    if (!expectedChallenge) return fail(400, 'passkey.error_expired', 'NO_CHALLENGE');

    let result;
    try {
      result = await passkeys.finishAuthentication({ response: req.body && req.body.response, expectedChallenge });
    } catch (err) {
      if (err.code === 'UNAVAILABLE') return fail(503, 'passkey.error_unavailable', 'UNAVAILABLE');
      if (!err.code) {
        logger.error({ err: err.message }, 'Passkey login error');
        return fail(500, 'auth.error_generic', 'ERROR');
      }
      // One generic answer for every failure: unknown credential, bad
      // signature, counter regression and disabled account look the same.
      logger.warn({ ip: req.ip, code: err.code }, 'Failed passkey login');
      try {
        getDb().prepare(`
          INSERT INTO activity_log (event_type, message, source, ip_address, severity)
          VALUES ('passkey_login_failed', ?, 'system', ?, 'warning')
        `).run(`Failed passkey login (${err.code})`, req.ip);
      } catch (e) { logger.warn({ err: e.message }, 'Could not log failed passkey login'); }
      return fail(400, 'passkey.error_login_failed', 'LOGIN_FAILED');
    }

    delete req.session.pending2fa;
    return establishSession(req, result.user, { method: 'passkey', passkeyName: result.passkey.name }, (err) => {
      if (err) return fail(500, 'auth.error_generic', 'ERROR');
      return res.json({ ok: true, redirect: returnTo || '/dashboard' });
    });
  },

  logout(req, res) {
    const username = res.locals.user ? res.locals.user.username : 'unknown';
    req.session.destroy((err) => {
      if (err) {
        logger.error({ err }, 'Session destroy error');
      }
      logger.info({ username }, 'User logged out');
      res.redirect('/login');
    });
  },
};

module.exports = authRoutes;
module.exports.PENDING_2FA_TTL_MS = PENDING_2FA_TTL_MS;
