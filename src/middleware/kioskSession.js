'use strict';

/**
 * Kiosk device session (docs/feature-kiosk-devices.md).
 *
 * Mounted in front of everything under /portal and /api/v1/portal — the only
 * paths the kiosk cookie is sent to (Path=/portal and Path=/api/v1/portal,
 * host-only on the portal host). With a valid gc_kiosk cookie of an eligible
 * user the request becomes a kiosk request: req.portalKiosk =
 * { deviceId, userId, name }; portalOwner then signs the viewer in as that
 * user (req.portalLoggedIn, source 'kiosk').
 *
 * A kiosk request may only reach what KIOSK_ALLOW lists (method + exact
 * path pattern): the portal page, its read-only widget data, the plugin
 * frames and plugin API, pairing and "Abmelden". Everything else under these
 * paths — "Meine Geräte" (device and token management, setup codes),
 * notification settings, the person picker, anything added later — is
 * refused (API: 403 kiosk_forbidden, page: redirect to /portal). The admin UI
 * and admin API never see the cookie and need a web session (requireAuth)
 * anyway.
 *
 * A web session (password/passkey login) on the same browser wins: the
 * request is that account's, the kiosk cookie is ignored.
 */

const kiosk = require('../services/kiosk');
const { effectivePortalHost } = require('../services/portalConfig');
const logger = require('../utils/logger');

const COOKIE = 'gc_kiosk';
// The portal pages (/portal…) and the portal API (/api/v1/portal…) — never "/".
const COOKIE_PATHS = ['/portal', '/api/v1/portal'];
// Hint for the bare portal address: Caddy rewrites "/" to /portal on the
// portal host, so the browser does not send the Path=/portal cookie there.
// The hint (no credential, value "1") lets GET /portal redirect once to
// /portal?kiosk=1 where the real cookie arrives.
const HINT_COOKIE = 'gc_kiosk_hint';

const PLUGIN_ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
const KIOSK_ALLOW = [
  // Portal pages
  { methods: ['GET', 'HEAD'], re: /^\/portal\/?$/ },
  { methods: ['GET', 'HEAD'], re: new RegExp(`^/portal/plugins/${PLUGIN_ID}/frame$`) },
  { methods: ['GET', 'HEAD', 'POST'], re: /^\/portal\/kiosk$/ },
  { methods: ['POST'], re: /^\/portal\/kiosk\/logout$/ },
  // Read-only data of the built-in portal widgets
  { methods: ['GET', 'HEAD'], re: /^\/api\/v1\/portal\/(?:device|traffic|services|pihole|pihole\/owner|pihole\/household)$/ },
  // Plugins: Start tiles, search, and the plugin API of portal plugins (any method; CSRF like every signed-in viewer)
  { methods: ['GET', 'HEAD'], re: /^\/api\/v1\/portal\/plugins\/(?:start|search)$/ },
  { methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], re: new RegExp(`^/api/v1/portal/plugins/${PLUGIN_ID}/api/[^?#]*$`) },
];

/** Path of the request without the query (the raw path express routes on). */
function requestPath(req) {
  const u = String(req.originalUrl || req.url || '');
  const q = u.indexOf('?');
  return q >= 0 ? u.slice(0, q) : u;
}

function kioskAllowed(method, path) {
  if (typeof path !== 'string' || path.length > 2048 || path.includes('..') || path.includes('//') || path.includes('\\')) return false;
  return KIOSK_ALLOW.some((r) => r.methods.includes(method) && r.re.test(path));
}

function cookieBase(req, maxAge) {
  return { httpOnly: true, secure: !!req.secure, sameSite: 'lax', maxAge };
}

/** Set the kiosk cookie (both paths) and the hint for the bare address. */
function setKioskCookies(req, res, token) {
  for (const path of COOKIE_PATHS) res.cookie(COOKIE, token, { ...cookieBase(req, kiosk.DEVICE_TTL_MS), path });
  res.cookie(HINT_COOKIE, '1', { ...cookieBase(req, kiosk.DEVICE_TTL_MS), path: '/' });
}

function clearKioskCookies(req, res) {
  for (const path of COOKIE_PATHS) res.clearCookie(COOKIE, { httpOnly: true, secure: !!req.secure, sameSite: 'lax', path });
  res.clearCookie(HINT_COOKIE, { httpOnly: true, secure: !!req.secure, sameSite: 'lax', path: '/' });
}

function onPortalHost(req) {
  try { return req.hostname === effectivePortalHost().host; } catch { return false; }
}

function webSessionActive(req) {
  if (!req.session || !req.session.userId) return false;
  try { return require('../services/users').isEnabled(req.session.userId); } catch { return false; }
}

function deny(req, res) {
  if (requestPath(req).startsWith('/api/')) {
    return res.status(403).json({ ok: false, code: 'kiosk_forbidden', error: req.t ? req.t('portal.kiosk.forbidden') : 'Not available on a kiosk device' });
  }
  return res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 302 : 303, '/portal');
}

function kioskSession(req, res, next) {
  req.portalKiosk = null;
  req.portalKioskPaused = false;
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return next();
  // Host-only cookie of the portal host; anywhere else it means nothing.
  if (!onPortalHost(req)) return next();
  if (webSessionActive(req)) return next();
  let device;
  try { device = kiosk.resolve(raw); } catch (e) {
    logger.warn({ err: e.message }, 'kiosk: device lookup failed');
    return next();
  }
  if (!device) {
    // Unknown, revoked or expired: the cookie is useless — remove it.
    clearKioskCookies(req, res);
    return next();
  }
  if (!kiosk.isEligible(device.user_id)) {
    // Eligibility ended (plugin, account): the device stops working until it
    // comes back; it is neither rolled nor revoked.
    req.portalKioskPaused = true;
    return next();
  }
  req.portalKiosk = { deviceId: device.id, userId: device.user_id, name: device.name };
  if (!kioskAllowed(req.method, requestPath(req))) return deny(req, res);
  try {
    if (kiosk.touch(device, { ip: req.ip })) {
      setKioskCookies(req, res, raw);
      // Keep the browser session (CSRF token of the open page) alive as long
      // as the device is used: a modified session re-issues its cookie.
      if (req.session && req.session.csrfToken) req.session.kioskSeenAt = Date.now();
    }
  } catch (e) { logger.warn({ err: e.message }, 'kiosk: rolling expiry failed'); }
  return next();
}

module.exports = kioskSession;
module.exports.kioskAllowed = kioskAllowed;
module.exports.setKioskCookies = setKioskCookies;
module.exports.clearKioskCookies = clearKioskCookies;
module.exports.onPortalHost = onPortalHost;
module.exports.COOKIE = COOKIE;
module.exports.HINT_COOKIE = HINT_COOKIE;
module.exports.COOKIE_PATHS = COOKIE_PATHS;
module.exports.KIOSK_ALLOW = KIOSK_ALLOW;
