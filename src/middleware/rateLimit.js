'use strict';

const rateLimit = require('express-rate-limit');
// Every key built from the client address goes through ipKeyGenerator
// (express-rate-limit 8): IPv6 clients count per /56 prefix (one household
// or customer allocation), so rotating through the own prefix no longer
// yields a fresh budget per address; IPv4-mapped IPv6 becomes plain IPv4.
// A keyGenerator reading req.ip without it is logged as ERR_ERL_KEY_GEN_IPV6.
const { ipKeyGenerator } = rateLimit;
const config = require('../../config/default');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.auth.rateLimitLogin,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => {
    res.status(429).json({ error: req.t('error.rate_limit.login') });
  },
});

// Profile 2FA setup/confirm: a wrong confirmation code is a guess against
// the pending secret, so budget it like the login form (2x the login cap,
// per session user — the caller already holds a full session).
const twoFactorSetupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Math.max(1, config.auth.rateLimitLogin) * 2,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `2fa:${(req.session && req.session.userId) || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.login') });
  },
});

// Passkey login (options + verify, POST /login/passkey*). Own bucket per IP so
// a passkey ceremony (two requests) does not eat the password form's budget
// and vice versa. A passkey cannot be guessed, so this is anti-noise/anti-DoS;
// failed attempts count (no skipFailedRequests).
const passkeyLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Math.max(1, config.auth.rateLimitLogin) * 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `passkey-login:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.login') });
  },
});

// Profile passkey management (add/remove). The re-auth password check rides
// on these requests, so budget them like the 2FA setup, per session user.
const passkeyManageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Math.max(1, config.auth.rateLimitLogin) * 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `passkey-manage:${(req.session && req.session.userId) || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.login') });
  },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => (req.session && req.session.userId)
    ? config.auth.rateLimitApi * 10
    : config.auth.rateLimitApi,
  standardHeaders: true,
  legacyHeaders: true,
  // Don't count failed (4xx/5xx) responses toward the limit. This breaks the
  // feedback loop where, once the window is exhausted, the dashboard's continued
  // polling keeps getting 429s that themselves pin the counter — so the window
  // never recovers until the process restarts. With this, only successful
  // requests count and an exhausted window self-recovers within windowMs.
  // Intentionally NOT applied to the login / route-auth limiters, where failed
  // attempts MUST count (brute-force protection).
  skipFailedRequests: true,
  keyGenerator: (req) => req.tokenAuth ? `token:${req.tokenId}` : ipKeyGenerator(req.ip),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.api') });
  },
});

const routeAuthLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.route_auth_login') || 'Too many login attempts. Try again later.' });
  },
});

const routeAuthCodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.route_auth_code') || 'Too many code requests. Try again later.' });
  },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.tokenAuth ? `upload:${req.tokenId}` : `upload:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many uploads. Try again later.' });
  },
});

// Peer hostname reporter: a compromised agent token must not be able to
// flood the hosts-file rebuild. 3 reports per minute per token is ample
// for legitimate boot/reconnect flows.
const hostnameReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.tokenAuth ? `hostname:${req.tokenId}` : `hostname:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t ? req.t('error.rate_limit.hostname') : 'Too many hostname reports.' });
  },
});

// Authenticated gateway API (heartbeat, config check, status, discovery).
// Mounted AFTER requireGateway and keyed by peer, so every gateway gets its
// own budget. Gateways used to share the per-IP apiLimiter bucket with the
// admin's browser behind the same NAT: dashboard use spent the gateways'
// (lower, session-less) budget, heartbeats got 429, and the gateway was
// declared offline → 502 on all its routes.
const gatewayApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => config.auth.rateLimitGateway,
  standardHeaders: true,
  legacyHeaders: true,
  // Same reasoning as apiLimiter: a 429 streak must not pin the window.
  skipFailedRequests: true,
  keyGenerator: (req) => `gw:${req.gateway.peer_id}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many gateway API requests. Try again later.' });
  },
});

// In front of the gateway token check (requireGateway): only FAILED requests
// count (skipSuccessfulRequests), so working gateways behind one NAT never
// share a budget — it only slows down guessing gateway tokens per address.
const gatewayAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `gw-auth:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many failed gateway requests. Try again later.' });
  },
});

// Public gateway-pairing redemption: 64-bit codes with 10-min TTL plus
// one-shot semantics already make brute-force impractical, but a tight
// per-IP limit (10 per 5 min) keeps log noise down and discourages
// scanning. Endpoint is unauthenticated by design.
const gatewayPairLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => `pair:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many pairing attempts. Try again later.' });
  },
});

// Android app setup-code redeem (POST /api/v1/client/enroll). Public, so
// keyed by IP; the 64-bit code plus 10-min TTL defeats guessing, this caps
// noise. Same budget as gateway pairing.
const clientEnrollLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: () => config.auth.rateLimitEnroll,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => `enroll:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// Guest share-link redeem. Generous (the 256-bit token defeats brute force;
// this is anti-noise/anti-DoS) and SEPARATE from the 5/15-min login limiter so
// legitimate guests behind one NAT don't 429 each other. req.ip is the real
// client IP (trust proxy 'loopback' + Caddy X-Forwarded-For).
const shareRedeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
});

// Admin SSE stream (/api/v1/events): connects and reconnects only; a stream
// stays open for minutes, so this never limits a working dashboard.
const eventStreamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `events:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// Portal API (/api/v1/portal/*). Mounted after portalIdentity: an identified
// device gets its own bucket (a household behind one NAT does not share one),
// everything else is keyed by IP. A portal page load makes about ten reads.
const portalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => config.auth.rateLimitApi * 10,
  standardHeaders: true,
  legacyHeaders: true,
  skipFailedRequests: true,
  keyGenerator: (req) => (req.portalPeerId != null ? `portal:peer:${req.portalPeerId}` : `portal:ip:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.api') });
  },
});

// Portal pages (/portal, /auto, the picker and its small POST forms).
const portalPageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => config.auth.rateLimitApi * 2,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `portal-page:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).type('text/plain').send(req.t('error.rate_limit.api'));
  },
});

// "Wer bist du?" PIN check. The per-person lockout (services/portalPin, 5
// wrong PINs → 15 min) is the real brute-force guard; this caps the attempts
// per address across all people of a device.
const portalPinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `portal-pin:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).type('text/plain').send(req.t('error.rate_limit.login'));
  },
});

// POST /api/v1/client/portal-link — one request per connect; per token.
const portalLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth ? `portal-link:${req.tokenId}` : `portal-link:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// POST /api/v1/client/services/:id/open — the apps open a route (optionally
// with a one-time auto-login ticket); one request per tap, 30 per minute and
// device.
const serviceOpenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth ? `service-open:${req.tokenId}` : `service-open:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// GET /route-auth/app/:ticket — redeem of the ticket above on the route's own
// domain. A ticket is 256 bits and lives 60 s, so this is anti-noise only;
// more generous than shareRedeemLimiter because one device opens several
// routes in a row.
const routeAppRedeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `route-app:${ipKeyGenerator(req.ip)}`,
});

// GET /api/v1/client/home-network — the apps ask on network changes
// (trusted-network detection); 30 per minute and device.
const homeNetworkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth ? `home-net:${req.tokenId}` : `home-net:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// Push stream of the apps (GET /api/v1/client/push, notification center):
// connects and reconnects only. Mounted AFTER token authentication and keyed
// by the authenticated token id (requests without a valid token never get
// here — requireAuth answers them); a session request falls back to the
// address. A stream lives for up to an hour; the apps reconnect with backoff.
const pushStreamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth && req.tokenId != null ? `push:tok:${req.tokenId}` : `push-ip:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// POST /api/v1/client/push/test — 5 per minute and device.
const pushTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth ? `push-test:${req.tokenId}` : `push-test:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// Test messages and manual sends of the admin / the portal: per account.
const notifySendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // req.meUserId: the portal session's person (/api/v1/portal/me/notify/test)
  keyGenerator: (req) => `notify-send:${req.meUserId || (req.session && req.session.userId) || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});

// Own portal PIN (profile) and the admin reset: per signed-in account.
const portalPinSetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Math.max(1, config.auth.rateLimitLogin) * 2,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `pin-set:${(req.session && req.session.userId) || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.login') });
  },
});

// Plugins (docs/plugins.md): the management API plus every request forwarded
// to a plugin (/api/v1/plugins/…, /api/v1/portal/plugins/…), per signed-in
// account (portal: per device), like the admin API budget.
const pluginApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => config.auth.rateLimitApi * 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) => {
    if (req.session && req.session.userId) return `plugins:u:${req.session.userId}`;
    if (req.portalPeerId != null) return `plugins:peer:${req.portalPeerId}`;
    return `plugins:ip:${ipKeyGenerator(req.ip)}`;
  },
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t ? req.t('error.rate_limit.api') : 'rate_limited' });
  },
});

// Plugin pages and their sandboxed frames (/plugins/<id>…, /portal/plugins/<id>/frame).
const pluginPageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => config.auth.rateLimitApi * 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `plugin-page:${(req.session && req.session.userId) || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).type('text/plain').send(req.t ? req.t('error.rate_limit.api') : 'rate_limited');
  },
});

module.exports = { pluginApiLimiter, pluginPageLimiter, loginLimiter, twoFactorSetupLimiter, passkeyLoginLimiter, passkeyManageLimiter, apiLimiter, routeAuthLoginLimiter, routeAuthCodeLimiter, uploadLimiter, hostnameReportLimiter, gatewayApiLimiter, gatewayAuthLimiter, gatewayPairLimiter, clientEnrollLimiter, shareRedeemLimiter,
  eventStreamLimiter, portalApiLimiter, portalPageLimiter, portalPinLimiter, portalLinkLimiter, portalPinSetLimiter, homeNetworkLimiter, serviceOpenLimiter, routeAppRedeemLimiter,
  pushStreamLimiter, pushTestLimiter, notifySendLimiter };

// POST /api/v1/client/actions/:plugin/:id — plugin quick actions of the apps
// (shortcuts, Quick Settings tiles, widget): 30 runs per minute and device.
const clientActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth ? `client-action:${req.tokenId}` : `client-action:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});
module.exports.clientActionLimiter = clientActionLimiter;

// POST/DELETE /api/v1/client/location — location sharing on tap: 10 per
// minute and device (a person tapping, not a tracker).
const clientLocationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth ? `client-location:${req.tokenId}` : `client-location:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});
module.exports.clientLocationLimiter = clientLocationLimiter;

// GET/POST /api/v1/client/speedtest* — speed test of the apps' diagnosis
// screen (docs/feature-client-diagnosis.md). One run is three or four
// requests moving up to 25 MiB each, so the budget is per token and small:
// GC_SPEEDTEST_RATE_LIMIT (30) requests per 10 minutes. Failed requests
// count too (a 413 upload still moved bytes).
const speedtestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: () => Math.max(1, config.speedtest.rateLimit),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth && req.tokenId != null ? `speedtest:${req.tokenId}` : `speedtest-ip:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
});
module.exports.speedtestLimiter = speedtestLimiter;

// /api/v1/client/plugins* — the apps' plugin API (docs/plugins.md "App"):
// 240 requests per minute and device token (an app syncing a shopping list
// or answering a locate request, not a scraper). Mounted before the general
// apiLimiter, which would cap an app at GC_RATE_LIMIT_API per 15 minutes.
// Failed requests count too.
const clientPluginApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth && req.tokenId != null ? `client-plugins:${req.tokenId}` : `client-plugins-ip:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, code: 'rate_limited', error: req.t ? req.t('error.rate_limit.api') : 'rate_limited' });
  },
});
module.exports.clientPluginApiLimiter = clientPluginApiLimiter;

// /plugins/_shared/leaflet/* — the vendored Leaflet for map frames of ui.maps
// plugins (docs/plugins.md "Maps"). Public static files (a sandboxed frame
// sends no cookies), so per address and generous: one map frame loads up to
// five files. Own bucket, so map assets never eat the plugin page budget.
const pluginAssetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => config.auth.rateLimitApi * 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `plugin-asset:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).type('text/plain').send('rate_limited');
  },
});
module.exports.pluginAssetLimiter = pluginAssetLimiter;

// /plugins/_shared/tiles/* — the map tile relay for the frames of ui.maps
// plugins (docs/plugins.md "Maps"). No session either; one map view loads
// 20–60 tiles and panning loads more, so 600 per minute and address, in a
// bucket of its own (the tiles never eat the Leaflet or plugin page budget).
const pluginTileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `plugin-tile:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).type('text/plain').send('rate_limited');
  },
});
module.exports.pluginTileLimiter = pluginTileLimiter;

// Kiosk devices (docs/feature-kiosk-devices.md).
// The kiosk cookie check in front of /portal and /api/v1/portal: counts only
// requests that carry the cookie, per address, well above what a wall tablet
// polling its plugin view needs (the routes behind keep their own limits).
const kioskSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => config.auth.rateLimitApi * 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !(req.cookies && req.cookies.gc_kiosk),
  keyGenerator: (req) => `kiosk-session:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/')) return res.status(429).json({ ok: false, error: req.t ? req.t('error.rate_limit.api') : 'rate_limited' });
    return res.status(429).type('text/plain').send(req.t ? req.t('error.rate_limit.api') : 'rate_limited');
  },
});

// POST /portal/kiosk (pairing code): 10 attempts per 15 minutes and address,
// successful ones included. services/kiosk.js adds a global lock after 50
// wrong codes.
const kioskPairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `kiosk-pair:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).type('text/plain').send(req.t ? req.t('portal.kiosk.err_rate') : 'rate_limited');
  },
});

// POST /api/v1/users/:id/kiosk/pair (administrator): per admin session,
// 6x the login cap (30 with the default GC_RATE_LIMIT_LOGIN=5).
const kioskCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Math.max(1, config.auth.rateLimitLogin) * 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `kiosk-code:${(req.session && req.session.userId) || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, code: 'rate_limited', error: req.t ? req.t('error.rate_limit.api') : 'rate_limited' });
  },
});
module.exports.kioskSessionLimiter = kioskSessionLimiter;
module.exports.kioskPairLimiter = kioskPairLimiter;
module.exports.kioskCodeLimiter = kioskCodeLimiter;

// Profile picture / favourite colour (docs/feature-avatars.md).
// PUT/DELETE /api/v1/client/me/avatar, PUT /api/v1/client/me/color: 30
// changes per hour and device token.
const clientAvatarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.tokenAuth ? `client-avatar:${req.tokenId}` : `client-avatar:${ipKeyGenerator(req.ip)}`),
  handler: (req, res) => {
    res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: req.t ? req.t('avatar.err.rate_limited') : 'rate_limited' });
  },
});

// The same changes from a browser (administrator, own profile, portal): 60
// per 15 minutes and signed-in account (portal session: its person).
const avatarWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const s = req.session || {};
    if (s.userId) return `avatar:u:${s.userId}`;
    if (s.portalUserId) return `avatar:u:${s.portalUserId}`;
    return `avatar:ip:${ipKeyGenerator(req.ip)}`;
  },
  handler: (req, res) => {
    res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: req.t ? req.t('avatar.err.rate_limited') : 'rate_limited' });
  },
});

// GET /avatars/<id>.<ext> — public capability URLs (cached forever by the
// browsers and apps): per address, generous (a wall tablet shows a family).
const avatarFileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `avatar-file:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => { res.status(429).end(); },
});

// GET /notify-media/<id>.<ext> — pictures of plugin pushes (capability URLs,
// docs/plugins.md "Notifications"): per address; a doorbell picture is
// fetched once per device and push.
const notifyMediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `notify-media:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => { res.status(429).end(); },
});
module.exports.notifyMediaLimiter = notifyMediaLimiter;
module.exports.clientAvatarLimiter = clientAvatarLimiter;
module.exports.avatarWriteLimiter = avatarWriteLimiter;
module.exports.avatarFileLimiter = avatarFileLimiter;
