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
  // verifyCsrfToken not needed - using HMAC-signed tokens
  maskEmail,
} = require('../services/routeAuth');
const { isSmtpConfigured } = require('../services/email');
const { decrypt } = require('../utils/crypto');
const lockout = require('../services/lockout');
const ipFilter = require('../services/ipFilter');

const router = Router();

// Apply i18n middleware to all route auth public routes
router.use(i18nMiddleware);

const crypto = require('crypto');

const COOKIE_SID = 'gc.route.sid';
const CSRF_SECRET = crypto.createHmac('sha256', config.app.secret).update('csrf-route-auth').digest('hex');
const CSRF_MAX_AGE = 15 * 60 * 1000; // 15 min

/**
 * Validate that a redirect target is a safe relative path (no open redirect)
 */
function safeRedirect(url) {
  if (!url || typeof url !== 'string') return '/';
  if (url.startsWith('//') || /^[a-zA-Z][a-zA-Z\d+\-.]*:/i.test(url)) return '/';
  return url.startsWith('/') ? url : '/';
}

function generateSignedCsrf(domain) {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(16).toString('hex');
  // Use | as separator since domains can contain dots
  const payload = `${timestamp}|${random}|${domain || ''}`;
  const sig = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  return `${payload}|${sig}`;
}

function verifySignedCsrf(token, domain) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('|');
  if (parts.length !== 4) return false;
  const [timestamp, random, tokenDomain, sig] = parts;
  // Verify domain binding
  if ((tokenDomain || '') !== (domain || '')) return false;
  // Timing-safe signature comparison
  const expected = crypto.createHmac('sha256', CSRF_SECRET).update(`${timestamp}|${random}|${tokenDomain}`).digest('hex');
  try {
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  } catch { return false; }
  // Check expiry
  const ts = parseInt(timestamp, 36);
  if (isNaN(ts) || Date.now() - ts > CSRF_MAX_AGE) return false;
  return true;
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
}

// GET /route-auth/verify — Caddy forward_auth endpoint
router.get('/verify', (req, res) => {
  (async () => {
    const domain = req.headers['x-route-domain'];
    if (!domain) return res.sendStatus(401);

    // IP filter check (works for all routes with ip_filter_enabled, even without route auth)
    const { getDb } = require('../db/connection');
    const db = getDb();
    const route = db.prepare('SELECT id, ip_filter_enabled FROM routes WHERE domain = ? AND enabled = 1').get(domain);
    if (route && route.ip_filter_enabled) {
      const clientIp = req.ip;
      const access = await ipFilter.checkAccess(route.id, clientIp);
      if (!access.allowed) return res.sendStatus(403);
    }

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
    const redirectTo = safeRedirect(req.query.redirect);

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

    // Set CSRF double-submit cookie (bound to domain)
    const csrfToken = generateSignedCsrf(domain);

    // Load branding for this route
    const { getDb } = require('../db/connection');
    const db = getDb();
    const routeData = domain ? db.prepare('SELECT branding_title, branding_text, branding_logo, branding_color, branding_bg, branding_bg_image FROM routes WHERE domain = ? AND enabled = 1').get(domain) : null;

    res.render(`${config.theme.defaultTheme}/pages/route-auth-login.njk`, {
      domain,
      redirect: redirectTo || '/',
      authType: authConfig ? authConfig.auth_type : null,
      twoFactorEnabled: !!authConfig?.two_factor_enabled,
      twoFactorMethod: authConfig?.two_factor_method || null,
      is2faStep2: twoFactorPending,
      maskedEmail: authConfig ? maskEmail(authConfig.email) : '',
      routeCsrfToken: csrfToken,
      branding: routeData ? {
        title: routeData.branding_title,
        text: routeData.branding_text,
        logo: routeData.branding_logo,
        color: routeData.branding_color,
        bg: routeData.branding_bg,
        bg_image: routeData.branding_bg_image,
      } : null,
    });
  })().catch((err) => res.status(500).send(err.message));
});

// POST /route-auth/login — email & password login
router.post('/login', routeAuthLoginLimiter, (req, res) => {
  (async () => {
    const { email, password, _csrf, redirect } = req.body || {};
    const redirectTo = safeRedirect(redirect);
    const domain = req.body.domain || req.headers['x-forwarded-host'] || req.headers.host;

    // CSRF: verify HMAC-signed token from body or header (bound to domain)
    const csrfToken = _csrf || req.headers['x-csrf-token'];
    if (!verifySignedCsrf(csrfToken, domain)) {
      const logger = require('../utils/logger');
      logger.warn({ hasBody: !!req.body, csrfLen: csrfToken?.length, csrfStart: csrfToken?.substring(0, 12) }, 'CSRF failed');
      return res.status(403).json({ ok: false, error: 'CSRF validation failed' });
    }
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // Check account lockout
    const lockoutId = `${email}:${authConfig.route_id}`;
    const lockoutStatus = lockout.isLocked(lockoutId);
    if (lockoutStatus.locked) {
      const mins = Math.ceil(lockoutStatus.remainingSeconds / 60);
      return res.status(429).json({ ok: false, error: req.t('route_auth.account_locked').replace('{{minutes}}', String(mins)) });
    }

    // Verify password
    const valid = await verifyPassword(authConfig, email, password);
    if (!valid) {
      lockout.recordFailedAttempt(lockoutId, 'route_auth', req.ip);
      return res.status(401).json({ ok: false, error: req.t('route_auth.invalid_credentials') });
    }

    // Clear lockout on successful login
    lockout.clearAttempts(lockoutId);

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
    const domain = bodyDomain || req.headers['x-forwarded-host'] || req.headers.host;

    // CSRF check (bound to domain)
    const csrfToken = _csrf || req.headers['x-csrf-token'];
    if (!verifySignedCsrf(csrfToken, domain)) {
      return res.status(403).json({ ok: false, error: 'CSRF validation failed' });
    }
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // Verify pending 2FA session exists before allowing code resend
    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    const pendingSession = sessionId ? getSession(sessionId) : null;
    if (!pendingSession || !pendingSession.two_factor_pending) {
      return res.status(403).json({ ok: false, error: req.t('route_auth.session_expired') });
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
    const redirectTo = safeRedirect(redirect);
    const domain = bodyDomain || req.headers['x-forwarded-host'] || req.headers.host;

    // CSRF check (bound to domain)
    const csrfToken = _csrf || req.headers['x-csrf-token'];
    if (!verifySignedCsrf(csrfToken, domain)) {
      return res.status(403).json({ ok: false, error: 'CSRF validation failed' });
    }
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // Get current session (pending or full)
    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    const existingSession = sessionId ? getSession(sessionId) : null;
    const isTwoFactor = existingSession && existingSession.two_factor_pending;

    const email = (existingSession && existingSession.email) || req.body.email || authConfig.email || 'anonymous';

    // Check account lockout for code verification
    const lockoutId = `${email}:${authConfig.route_id}`;
    const lockoutStatus = lockout.isLocked(lockoutId);
    if (lockoutStatus.locked) {
      const mins = Math.ceil(lockoutStatus.remainingSeconds / 60);
      return res.status(429).json({ ok: false, error: req.t('route_auth.account_locked').replace('{{minutes}}', String(mins)) });
    }

    // Determine verification method
    let isValid = false;
    const method = isTwoFactor
      ? authConfig.two_factor_method
      : authConfig.auth_type; // for email_code single-factor

    if (method === 'totp') {
      if (!authConfig.totp_secret_encrypted) {
        return res.status(400).json({ ok: false, error: req.t('route_auth.totp_not_configured') });
      }
      isValid = verifyTotp(authConfig.totp_secret_encrypted, code, authConfig.route_id);
    } else {
      // email OTP
      isValid = verifyOtp(authConfig.route_id, email, code);
    }

    if (!isValid) {
      lockout.recordFailedAttempt(lockoutId, 'route_auth', req.ip);
      return res.status(401).json({ ok: false, error: req.t('route_auth.invalid_code') });
    }

    // Clear lockout on successful verification
    lockout.clearAttempts(lockoutId);

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
    const redirectTo = safeRedirect(req.body.redirect || req.query.redirect);
    res.redirect(redirectTo);
  })().catch((err) => res.status(500).send(err.message));
});

module.exports = router;
