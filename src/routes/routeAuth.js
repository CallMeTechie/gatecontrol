'use strict';

const { Router } = require('express');
const config = require('../../config/default');
const { i18nMiddleware } = require('../middleware/i18n');
const { routeAuthLoginLimiter, routeAuthCodeLimiter } = require('../middleware/rateLimit');
const {
  getAuthByDomain,
  verifySession,
  createSession,
  getSession,
  completeTwoFactor,
  deleteSession,
  verifyPassword,
  createAndSendOtp,
  verifyOtp,
  verifyTotp,
  generateCsrfToken,
  verifyCsrfToken,
} = require('../services/routeAuth');
const { isSmtpConfigured } = require('../services/email');
const { decrypt } = require('../utils/crypto');

const router = Router();

// Apply i18n middleware to all route auth public routes
router.use(i18nMiddleware);

const COOKIE_SID = 'gc.route.sid';
const COOKIE_CSRF = 'gc.route.csrf';

function setCsrfCookie(res, token) {
  res.cookie(COOKIE_CSRF, token, {
    httpOnly: false, // Must be readable by JS for double-submit pattern
    secure: config.app.baseUrl.startsWith('https'),
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000,
  });
}

function setSessionCookie(res, sessionId, maxAge) {
  res.cookie(COOKIE_SID, sessionId, {
    httpOnly: true,
    secure: config.app.baseUrl.startsWith('https'),
    sameSite: 'strict',
    maxAge,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_SID);
  res.clearCookie(COOKIE_CSRF);
}

// GET /route-auth/verify — Caddy forward_auth endpoint
router.get('/verify', (req, res) => {
  (async () => {
    const domain = req.headers['x-route-domain'];
    if (!domain) return res.sendStatus(200);

    const authConfig = getAuthByDomain(domain);
    if (!authConfig) return res.sendStatus(200);

    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    if (!sessionId) return res.sendStatus(401);

    const session = verifySession(sessionId, authConfig.route_id);
    if (!session) return res.sendStatus(401);

    return res.sendStatus(200);
  })().catch(() => res.sendStatus(500));
});

// GET /route-auth/login — render login page
router.get('/login', (req, res) => {
  (async () => {
    const domain = req.query.route || req.headers['x-forwarded-host'] || req.headers.host;
    const redirectTo = req.query.redirect || '/';

    const authConfig = domain ? getAuthByDomain(domain) : null;

    // Check if already authenticated
    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    if (sessionId && authConfig) {
      const session = verifySession(sessionId, authConfig.route_id);
      if (session) {
        return res.redirect(redirectTo);
      }
    }

    // Check for pending 2FA session
    let twoFactorPending = false;
    if (sessionId) {
      const pendingSession = getSession(sessionId);
      if (pendingSession && pendingSession.two_factor_pending) {
        twoFactorPending = true;
      }
    }

    // Set CSRF double-submit cookie
    const csrfToken = generateCsrfToken();
    setCsrfCookie(res, csrfToken);

    res.render(`${config.theme.defaultTheme}/pages/route-auth-login.njk`, {
      domain,
      redirectTo,
      authConfig: authConfig
        ? {
            auth_type: authConfig.auth_type,
            two_factor_enabled: authConfig.two_factor_enabled,
            two_factor_method: authConfig.two_factor_method,
          }
        : null,
      twoFactorPending,
      csrfToken,
    });
  })().catch((err) => res.status(500).send(err.message));
});

// POST /route-auth/login — email & password login
router.post('/login', routeAuthLoginLimiter, (req, res) => {
  (async () => {
    const { email, password, _csrf, redirect } = req.body;
    const redirectTo = redirect || '/';

    // CSRF double-submit check
    const cookieCsrf = req.cookies && req.cookies[COOKIE_CSRF];
    if (!verifyCsrfToken(cookieCsrf, _csrf)) {
      return res.status(403).json({ ok: false, error: req.t('error.csrf_invalid') });
    }

    const domain = req.body.domain || req.headers['x-forwarded-host'] || req.headers.host;
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // Verify password
    const valid = await verifyPassword(authConfig, email, password);
    if (!valid) {
      return res.status(401).json({ ok: false, error: req.t('route_auth.invalid_credentials') });
    }

    // Check if 2FA required
    if (authConfig.two_factor_enabled) {
      // Create pending session (5 minutes)
      const { id: sessionId } = createSession(
        authConfig.route_id,
        email,
        req.ip,
        5 * 60 * 1000,
        true // twoFactorPending
      );
      setSessionCookie(res, sessionId, 5 * 60 * 1000);

      // Send OTP if email_code 2FA
      if (authConfig.two_factor_method === 'email_code') {
        await createAndSendOtp(authConfig.route_id, email, domain, req.language);
      }

      return res.json({ ok: true, twoFactorRequired: true });
    }

    // Single factor — create full session
    const maxAge = authConfig.session_max_age || 86400000;
    const { id: sessionId } = createSession(authConfig.route_id, email, req.ip, maxAge, false);
    setSessionCookie(res, sessionId, maxAge);

    return res.json({ ok: true, redirect: redirectTo });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// POST /route-auth/send-code — request a new OTP code
router.post('/send-code', routeAuthCodeLimiter, (req, res) => {
  (async () => {
    const { email, domain: bodyDomain, _csrf } = req.body;

    // CSRF check
    const cookieCsrf = req.cookies && req.cookies[COOKIE_CSRF];
    if (!verifyCsrfToken(cookieCsrf, _csrf)) {
      return res.status(403).json({ ok: false, error: req.t('error.csrf_invalid') });
    }

    const domain = bodyDomain || req.headers['x-forwarded-host'] || req.headers.host;
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // Verify email matches config
    if (authConfig.email !== email) {
      return res.status(400).json({ ok: false, error: req.t('route_auth.email_mismatch') });
    }

    await createAndSendOtp(authConfig.route_id, email, domain, req.language);
    res.json({ ok: true });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// POST /route-auth/verify-code — verify OTP or TOTP code
router.post('/verify-code', routeAuthLoginLimiter, (req, res) => {
  (async () => {
    const { code, domain: bodyDomain, _csrf, redirect } = req.body;
    const redirectTo = redirect || '/';

    // CSRF check
    const cookieCsrf = req.cookies && req.cookies[COOKIE_CSRF];
    if (!verifyCsrfToken(cookieCsrf, _csrf)) {
      return res.status(403).json({ ok: false, error: req.t('error.csrf_invalid') });
    }

    const domain = bodyDomain || req.headers['x-forwarded-host'] || req.headers.host;
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // Get current session (pending or full)
    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    const existingSession = sessionId ? getSession(sessionId) : null;
    const isTwoFactor = existingSession && existingSession.two_factor_pending;

    const email = (existingSession && existingSession.email) || req.body.email;

    // Determine verification method
    let isValid = false;
    const method = isTwoFactor
      ? authConfig.two_factor_method
      : authConfig.auth_type; // for email_code single-factor

    if (method === 'totp') {
      if (!authConfig.totp_secret_encrypted) {
        return res.status(400).json({ ok: false, error: req.t('route_auth.totp_not_configured') });
      }
      isValid = verifyTotp(authConfig.totp_secret_encrypted, code);
    } else {
      // email OTP
      isValid = verifyOtp(authConfig.route_id, email, code);
    }

    if (!isValid) {
      return res.status(401).json({ ok: false, error: req.t('route_auth.invalid_code') });
    }

    if (isTwoFactor) {
      // Complete the 2FA — extend session to full duration
      const completed = completeTwoFactor(sessionId);
      if (!completed) {
        return res.status(401).json({ ok: false, error: req.t('route_auth.session_expired') });
      }
      const maxAge = completed.session_max_age || 86400000;
      setSessionCookie(res, sessionId, maxAge);
    } else {
      // Single factor email_code — create full session
      const maxAge = authConfig.session_max_age || 86400000;
      const { id: newSessionId } = createSession(
        authConfig.route_id,
        email,
        req.ip,
        maxAge,
        false
      );
      setSessionCookie(res, newSessionId, maxAge);
    }

    return res.json({ ok: true, redirect: redirectTo });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// POST /route-auth/logout — delete session and clear cookies
router.post('/logout', (req, res) => {
  (async () => {
    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    if (sessionId) {
      deleteSession(sessionId);
    }
    clearSessionCookie(res);
    const redirectTo = req.body.redirect || req.query.redirect || '/';
    res.redirect(redirectTo);
  })().catch((err) => res.status(500).send(err.message));
});

module.exports = router;
