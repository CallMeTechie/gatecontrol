'use strict';

const { Router } = require('express');
const config = require('../../config/default');
const { i18nMiddleware } = require('../middleware/i18n');
const { routeAuthLoginLimiter, routeAuthCodeLimiter, shareRedeemLimiter, routeAppRedeemLimiter } = require('../middleware/rateLimit');
const shareLinks = require('../services/shareLinks');
const routeAppTickets = require('../services/routeAppTickets');
const activity = require('../services/activity');
const {
  getAuthByDomain,
  verifySession,
  createSession,
  getSession,
  completeTwoFactor,
  deleteSession,
  verifyPassword,
  sendOtpInBackground,
  verifyOtp,
  verifyTotp,
  maskEmail,
} = require('../services/routeAuth');
const { isSmtpConfigured } = require('../services/email');
const { decrypt } = require('../utils/crypto');
const lockout = require('../services/lockout');
const ipFilter = require('../services/ipFilter');
const { safeLocalPath } = require('../utils/safePath');

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
// Shares the checks with the admin login's safeReturnTo (utils/safePath):
// protocol-relative '//host', backslash tricks ('/\\host') and control
// characters (browsers drop tab/CR/LF, turning '/\t/host' into '//host')
// all fall back to '/'.
function safeRedirect(url) {
  return safeLocalPath(url) || '/';
}

// Recover the full redirect target from the raw request URL. Caddy's
// forward-auth 302 appends the original request URI verbatim as the LAST query
// parameter (…&redirect=/page?a=1&b=2). Its own '&' separators make Express
// parse req.query.redirect as only the first segment ("/page?a=1"), dropping
// the rest. Slice everything after the first 'redirect=' marker instead so the
// whole URI survives. Falls back to the parsed value for direct navigations
// that carry no such marker. safeRedirect() still validates the result.
function extractRedirect(req) {
  const raw = req.originalUrl || '';
  const marker = raw.indexOf('redirect=');
  if (marker !== -1) return raw.slice(marker + 'redirect='.length);
  return req.query.redirect;
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
    // Lax, not Strict: the session cookie must survive navigations that follow a
    // CROSS-SITE arrival — exactly the share-link guest flow (link opened from an
    // email/chat app) and proxied upstreams that bounce through their own login
    // pages. Strict withholds the cookie on those navigations → forward_auth then
    // 302s the user back to /route-auth/login mid-session. Lax is sent on same-site
    // requests and top-level GET navigations, which covers both. CSRF is unaffected:
    // the state-changing POST endpoints use their own HMAC-signed CSRF tokens
    // (verifySignedCsrf), not the cookie's SameSite attribute.
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_SID);
}

// ─── No enumeration of the route's address ─────────────────────────────
// A route with the e-mail code login has ONE address. Asking for a code
// answers the same for every address — same status, same body, at least
// SEND_CODE_MIN_MS — and the mail goes out in the background, so neither
// the text nor the time tells whether the address has access. An address
// without access counts for the IP block with the weight of "Unbekannte
// Benutzernamen" (services/ipBlock.js unknown_user_weight), like an unknown
// name at the GateControl login; the code step then fails like a wrong code.
const SEND_CODE_MIN_MS = 300;

/** Lower-case, trimmed e-mail address, or '' when it is no plausible address. */
function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim().toLowerCase();
  if (v.length < 3 || v.length > 254 || /[\s\x00-\x1f\x7f]/.test(v)) return '';
  const at = v.lastIndexOf('@');
  if (at < 1 || at === v.length - 1) return '';
  return v;
}

function waitUntil(startedAt, ms) {
  const left = ms - (Date.now() - startedAt);
  return left > 0 ? new Promise((resolve) => setTimeout(resolve, left)) : Promise.resolve();
}

/** Pending 2FA session of THIS route (password step done), else null. */
function pendingSessionFor(req, authConfig) {
  const sessionId = req.cookies && req.cookies[COOKIE_SID];
  const s = sessionId ? getSession(sessionId) : null;
  return s && s.two_factor_pending && s.route_id === authConfig.route_id ? s : null;
}

/**
 * Activity entry of a failed route login (Logs & Monitoring): route, masked
 * address, IP and the step. Only for the admin — the requester's answer is
 * the same either way. Never contains a password or code.
 */
function logRouteAuthFailure(req, authConfig, domain, step, email, { unknownUser = false } = {}) {
  try {
    // Typed by the visitor: no control characters, bounded, then masked.
    const masked = maskEmail(typeof email === 'string' ? email.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 254) : '');
    const what = {
      password: 'wrong e-mail or password',
      code_request: 'code requested for an address without access',
      code: 'wrong or expired code',
    }[step] || step;
    activity.log('route_auth_failed', `Failed route login for ${domain}: ${what} (${masked})`, {
      details: { routeId: authConfig.route_id, domain, step, email: masked, ...(unknownUser ? { unknownUser: true } : {}) },
      source: 'system',
      ipAddress: req.ip,
      severity: 'warning',
    });
  } catch { /* best-effort */ }
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

    // Sessions of the automatic login from the apps belong to a person (or a
    // device token): checked again on every request, so leaving a group,
    // being taken off the route or a disabled account end access at once
    // (docs/groups.md "Zugriff per Gruppe"). Password/e-mail sessions are
    // route credentials, not GateControl accounts.
    const who = String(session.email || '');
    if (who.startsWith('app:')) {
      const m = /^app:user:(\d+)$/.exec(who);
      const uid = m ? Number(m[1]) : null;
      if (uid != null && !require('../services/users').isEnabled(uid)) return res.sendStatus(401);
      const row = db.prepare('SELECT id, user_ids FROM routes WHERE id = ?').get(authConfig.route_id);
      if (!require('../services/groupAccess').canSeeRoute(row, uid)) return res.sendStatus(401);
    }

    return res.sendStatus(200);
  })().catch(() => res.sendStatus(500));
});

// Generic invalid/expired view of the token redeems (share link, app
// ticket) — the same page for every failure, no enumeration signal.
function renderRedeemInvalid(req, res) {
  return res.status(200).render(`${res.locals.theme}/pages/route-auth-login.njk`, {
    domain: req.query.route || req.headers['x-forwarded-host'] || req.headers.host || '',
    redirect: '/', authType: 'share', shareInvalid: true,
    twoFactorEnabled: false, twoFactorMethod: null, is2faStep2: false,
    maskedEmail: '', routeCsrfToken: '', branding: null,
  });
}

// Host of the request as the browser sent it (Caddy sets X-Forwarded-Host),
// lower-case, without port.
function requestHost(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(0, colon);
}

// GET /route-auth/app/:ticket — automatic login from the apps
// (POST /api/v1/client/services/:id/open, route_auth.app_login). The ticket
// IS the credential; it is single use and lives 60 s. Reached via the Caddy
// /route-auth/* sibling proxy on the route's own domain, so the session
// cookie lands on that domain. Never logs the ticket.
router.get('/app/:ticket', routeAppRedeemLimiter, (req, res) => {
  try {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    const t = routeAppTickets.consume(req.params.ticket);
    if (!t) return renderRedeemInvalid(req, res);

    // Re-check at redeem time: the admin may have switched app login off,
    // disabled the route, enabled Basic Auth, restricted it, revoked the
    // device or disabled its owner in the meantime.
    const { getDb } = require('../db/connection');
    const db = getDb();
    const route = db.prepare('SELECT id, domain, enabled, basic_auth_enabled FROM routes WHERE id = ?').get(t.routeId);
    const authConfig = route ? db.prepare('SELECT * FROM route_auth WHERE route_id = ?').get(route.id) : null;
    const tokenOk = (t.tokenId == null || !!db.prepare('SELECT 1 FROM api_tokens WHERE id = ?').get(t.tokenId))
      && (t.userId == null || require('../services/users').isEnabled(t.userId));
    const visible = !!route && require('../services/routes').getForUser(t.userId || null).some((r) => r.id === route.id);
    if (!route || !route.enabled || route.basic_auth_enabled || !authConfig || authConfig.app_login !== 1
        || !tokenOk || !visible || String(route.domain).toLowerCase() !== requestHost(req)) {
      return renderRedeemInvalid(req, res);
    }

    const who = t.userId != null ? `app:user:${t.userId}` : `app:token:${t.tokenId}`;
    const maxAge = authConfig.session_max_age || 86400000;
    const { id: sessionId } = createSession(route.id, who, req.ip, maxAge, false);
    setSessionCookie(res, sessionId, maxAge);
    activity.log('route_app_login', `Route ${route.id} opened from the app (automatic login)`, {
      details: { routeId: route.id, tokenId: t.tokenId, userId: t.userId },
      source: 'client',
      ipAddress: req.ip,
      severity: 'info',
    });
    return res.redirect('/');
  } catch {
    return res.sendStatus(500);
  }
});

// GET /route-auth/share/:token — redeem a share link (the token IS the
// credential; no login). Reached via the Caddy /route-auth/* sibling proxy
// (bypasses forward_auth), so it works even when the route is share-gated.
router.get('/share/:token', shareRedeemLimiter, (req, res) => {
  (async () => {
    res.set('Referrer-Policy', 'no-referrer');
    const result = shareLinks.redeemShareLink(req.params.token, req.ip);
    if (!result) {
      // Generic invalid/expired view — no enumeration signal.
      return renderRedeemInvalid(req, res);
    }
    const maxAge = new Date(result.expiresAt).getTime() - Date.now();
    setSessionCookie(res, result.sessionId, maxAge > 0 ? maxAge : 1000);
    return res.redirect('/');
  })().catch(() => res.sendStatus(500));
});

// GET /route-auth/login — render login page
router.get('/login', (req, res) => {
  (async () => {
    const domain = req.query.route || req.headers['x-forwarded-host'] || req.headers.host;
    const redirectTo = safeRedirect(extractRedirect(req));

    const authConfig = domain ? getAuthByDomain(domain) : null;

    // Check if already authenticated
    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    if (sessionId && authConfig) {
      const session = verifySession(sessionId, authConfig.route_id);
      if (session) {
        return res.redirect(redirectTo);
      }
    }

    // Check for pending 2FA session (of this route: the password step was
    // done here — a pending session of another route shows nothing)
    const pendingSession = authConfig ? pendingSessionFor(req, authConfig) : null;
    const twoFactorPending = !!pendingSession;

    // Set CSRF double-submit cookie (bound to domain)
    const csrfToken = generateSignedCsrf(domain);

    // Load branding for this route
    const { getDb } = require('../db/connection');
    const db = getDb();
    const routeData = domain ? db.prepare('SELECT branding_title, branding_text, branding_logo, branding_color, branding_bg, branding_bg_image FROM routes WHERE domain = ? AND enabled = 1').get(domain) : null;

    res.render(`${res.locals.theme}/pages/route-auth-login.njk`, {
      domain,
      redirect: redirectTo || '/',
      authType: authConfig ? authConfig.auth_type : null,
      twoFactorEnabled: !!authConfig?.two_factor_enabled,
      twoFactorMethod: authConfig?.two_factor_method || null,
      is2faStep2: twoFactorPending,
      maskedEmail: pendingSession ? maskEmail(pendingSession.email) : '',
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
  })().catch(() => res.sendStatus(500));
});

// POST /route-auth/login — email & password login
router.post('/login', routeAuthLoginLimiter, (req, res) => {
  (async () => {
    const { email, password, _csrf, redirect } = req.body || {};
    const redirectTo = safeRedirect(redirect);
    const domain = req.body.domain || req.headers['x-forwarded-host'] || req.headers.host;

    // Resolve authConfig early so share-route guard can fire before CSRF check.
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    if (authConfig.auth_type === 'share') {
      // Share routes have no password/OTP/TOTP flow — only token redeem.
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // CSRF: verify HMAC-signed token from body or header (bound to domain)
    const csrfToken = _csrf || req.headers['x-csrf-token'];
    if (!verifySignedCsrf(csrfToken, domain)) {
      const logger = require('../utils/logger');
      logger.warn({ hasBody: !!req.body, csrfLen: csrfToken?.length, csrfStart: csrfToken?.substring(0, 12) }, 'CSRF failed');
      return res.status(403).json({ ok: false, error: 'CSRF validation failed' });
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
      // A route has one account: an e-mail address other than its own
      // matches no account and counts with the weight of "Unbekannte
      // Benutzernamen" for the IP block (verifyPassword ran argon2 anyway;
      // the answer below is the same).
      const unknownUser = !authConfig.email || authConfig.email !== email;
      lockout.recordFailedAttempt(lockoutId, 'route_auth', req.ip, { unknownUser });
      logRouteAuthFailure(req, authConfig, domain, 'password', email, { unknownUser });
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

      // Send OTP if email_code 2FA (in the background: the step answer does
      // not wait for the mail server; a failed delivery is logged)
      if (authConfig.two_factor_method === 'email_code') {
        sendOtpInBackground(authConfig.route_id, email, domain, req.language, { ip: req.ip });
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

// POST /route-auth/send-code — request a (new) e-mail code
//   • e-mail code login (auth type email_code): for the typed address. The
//     answer is the same for every address (see SEND_CODE_MIN_MS above);
//     only the route's own address gets a code.
//   • second factor by e-mail ("Code erneut senden" after the password
//     step): to the address of the pending session; the typed one is ignored.
router.post('/send-code', routeAuthCodeLimiter, (req, res) => {
  (async () => {
    const startedAt = Date.now();
    const body = req.body || {};
    const domain = body.domain || req.headers['x-forwarded-host'] || req.headers.host;

    // CSRF check (bound to domain)
    const csrfToken = body._csrf || req.headers['x-csrf-token'];
    if (!verifySignedCsrf(csrfToken, domain)) {
      return res.status(403).json({ ok: false, error: 'CSRF validation failed' });
    }
    const authConfig = domain ? getAuthByDomain(domain) : null;

    if (!authConfig) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    if (authConfig.auth_type === 'share') {
      // Share routes have no password/OTP/TOTP flow — only token redeem.
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    const pending = pendingSessionFor(req, authConfig);
    if (pending) {
      // Resend of the second factor: the password step proved the address.
      if (!authConfig.two_factor_enabled || authConfig.two_factor_method !== 'email_code') {
        return res.status(403).json({ ok: false, error: req.t('route_auth.session_expired') });
      }
      if (!isSmtpConfigured()) {
        return res.status(503).json({ ok: false, error: req.t('route_auth.code_unavailable') });
      }
      sendOtpInBackground(authConfig.route_id, pending.email, domain, req.language, { ip: req.ip });
      return res.json({ ok: true, message: req.t('route_auth.code_sent') });
    }

    if (authConfig.auth_type !== 'email_code') {
      // Password route without a pending second factor (expired / never logged in).
      return res.status(403).json({ ok: false, error: req.t('route_auth.session_expired') });
    }

    // Checks that do not depend on WHICH address was typed come first.
    const typed = normalizeEmail(body.email);
    if (!typed) {
      return res.status(400).json({ ok: false, error: req.t('route_auth.email_invalid') });
    }
    if (!isSmtpConfigured()) {
      return res.status(503).json({ ok: false, error: req.t('route_auth.code_unavailable') });
    }

    try {
      if (authConfig.email && normalizeEmail(authConfig.email) === typed) {
        // To the stored address (the typed one may differ in case).
        sendOtpInBackground(authConfig.route_id, authConfig.email, domain, req.language, { ip: req.ip });
      } else {
        lockout.recordFailedAttempt(`${typed}:${authConfig.route_id}`, 'route_auth', req.ip, { unknownUser: true });
        logRouteAuthFailure(req, authConfig, domain, 'code_request', typed, { unknownUser: true });
      }
    } catch (err) {
      require('../utils/logger').warn({ err: err && err.message, routeId: authConfig.route_id }, 'route auth: code request failed');
    }

    await waitUntil(startedAt, SEND_CODE_MIN_MS);
    return res.json({ ok: true, message: req.t('route_auth.code_sent_generic') });
  })().catch(() => res.status(500).json({ ok: false, error: req.t('route_auth.code_unavailable') }));
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

    if (authConfig.auth_type === 'share') {
      // Share routes have no password/OTP/TOTP flow — only token redeem.
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }

    // Second factor: the pending session of THIS route (password step done).
    // Single factor (email_code / totp): always the route's own account — the
    // address typed when asking for the code does not matter here, so a
    // wrong code and "no code was ever sent to that address" fail alike
    // (same answer, same lockout counter).
    const sessionId = req.cookies && req.cookies[COOKIE_SID];
    const pending = pendingSessionFor(req, authConfig);
    const isTwoFactor = !!pending;
    if (isTwoFactor ? !authConfig.two_factor_enabled : !['email_code', 'totp'].includes(authConfig.auth_type)) {
      return res.status(403).json({ ok: false, error: req.t('route_auth.session_expired') });
    }

    const email = (pending && pending.email) || authConfig.email || 'anonymous';

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
      isValid = verifyOtp(authConfig.route_id, email, String(code == null ? '' : code));
    }

    if (!isValid) {
      // Counts once for the IP block (the account exists); a wrong address
      // already counted with the "unknown names" weight when it asked.
      lockout.recordFailedAttempt(lockoutId, 'route_auth', req.ip);
      logRouteAuthFailure(req, authConfig, domain, 'code', email === 'anonymous' ? '' : email);
      return res.status(401).json({ ok: false, error: req.t(method === 'totp' ? 'route_auth.invalid_code' : 'route_auth.invalid_email_code') });
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
  })().catch(() => res.sendStatus(500));
});

module.exports = router;
// Exposed for unit testing; does not affect router mounting.
module.exports.extractRedirect = extractRedirect;
module.exports.safeRedirect = safeRedirect;
