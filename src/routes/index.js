'use strict';

const { Router } = require('express');
const { requireAuth, requireAdmin, guestOnly } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const { loginLimiter, passkeyLoginLimiter, apiLimiter } = require('../middleware/rateLimit');
const config = require('../../config/default');
const { hasFeature } = require('../services/license');
const { stringsWithPrefix } = require('../middleware/i18n');

const express = require('express');
const router = Router();

// ─── Branding assets (public, no auth) ─────────────
// Only serves whitelisted image extensions to prevent stored-XSS if a file slips past upload validation.
const path = require('node:path');
const logger = require('../utils/logger');
const BRANDING_ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
router.use('/branding', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (!BRANDING_ALLOWED_EXT.has(ext)) return res.status(404).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
  next();
}, express.static('/data/branding', {
  maxAge: '1d',
  dotfiles: 'deny',
  index: false,
  fallthrough: false,
}));

// ─── Prometheus metrics (token auth or session) ────
// Per-identity rate limit so a stolen `read-only`/`system` token can't
// loop-scrape the endpoint at kilohertz speeds. 60/min/identity is well
// above any sane Prometheus scrape config (default 15s).
const _metricsWindow = new Map();
function _metricsRateLimit(req, res) {
  const key = req.session?.userId
    ? `s:${req.session.userId}`
    : (req.headers.authorization || req.headers['x-api-token'] || req.ip).slice(0, 80);
  const now = Date.now();
  const entry = _metricsWindow.get(key) || { start: now, count: 0 };
  if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
  entry.count++;
  _metricsWindow.set(key, entry);
  if (entry.count > 60) {
    res.status(429).json({ ok: false, error: 'rate_limited' });
    return true;
  }
  return false;
}

router.get('/metrics', async (req, res) => {
  const settings = require('../services/settings');

  // Check if metrics are enabled
  if (settings.get('metrics_enabled', 'false') !== 'true') {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  if (_metricsRateLimit(req, res)) return;

  if (!hasFeature('prometheus_metrics')) {
    return res.status(403).json({ ok: false, error: 'Prometheus metrics requires a Pro or Lifetime license' });
  }

  // Authenticate: session, Bearer token, or ?token= query param
  let authenticated = false;

  // 1. Session auth — only an existing, enabled admin account
  if (req.session && req.session.userId) {
    const u = require('../services/users').getById(req.session.userId);
    if (u && u.enabled === 1 && u.role === 'admin') authenticated = true;
  }

  // 2. Bearer / X-API-Token header
  if (!authenticated) {
    const tokens = require('../services/tokens');
    let rawToken = null;

    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (t.startsWith('gc_')) rawToken = t;
    }
    if (!rawToken) {
      const apiToken = req.headers['x-api-token'];
      if (apiToken && apiToken.startsWith('gc_')) rawToken = apiToken;
    }

    if (rawToken) {
      const tokenRecord = tokens.authenticate(rawToken);
      if (tokenRecord) {
        let scopes = tokenRecord.scopes;
        // Same owner checks as requireAuth: a disabled owner's token is dead,
        // and the owner's role caps the scopes.
        if (tokenRecord.user_id) {
          const users = require('../services/users');
          const owner = users.getById(tokenRecord.user_id);
          scopes = owner && owner.enabled === 1 ? users.filterScopesForRole(scopes, owner.role) : [];
        }
        if (scopes.includes('system') || scopes.includes('read-only') || scopes.includes('full-access')) {
          authenticated = true;
        }
      }
    }
  }

  if (!authenticated) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const metrics = require('../services/metrics');
    const output = await metrics.collect();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(output);
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to collect metrics' });
  }
});

// TCP-probe Caddy's admin API on 127.0.0.1:2019 — if it answers, Caddy
// is alive. Fast, no HTTP round-trip. NODE_ENV=test returns true by
// design (see PR #38): the container uses network_mode:host, so a real
// TCP probe from a host-side test process would hit the LIVE production
// Caddy. Returning true keeps the check inert in tests without
// weakening the real-world behaviour.
function checkCaddyLiveness(timeoutMs = 500) {
  if (process.env.NODE_ENV === 'test') return Promise.resolve(true);
  return new Promise((resolve) => {
    const net = require('node:net');
    const sock = net.connect({ host: '127.0.0.1', port: 2019 });
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

// ─── Health check (public, no auth) ────────────────
router.get('/health', async (req, res) => {
  const checks = { db: false, wireguard: false, caddy: false };
  let status = 200;

  // Check database connectivity
  try {
    const { getDb } = require('../db/connection');
    const db = getDb();
    const row = db.prepare('SELECT 1 as ok').get();
    checks.db = !!(row && row.ok);
  } catch { checks.db = false; }

  // Check WireGuard interface exists via /sys/class/net (no root needed)
  try {
    const fs = require('node:fs');
    const wgInterface = require('../../config/default').wireguard.interface;
    checks.wireguard = fs.existsSync(`/sys/class/net/${wgInterface}`);
  } catch { checks.wireguard = false; }

  // Check Caddy admin API is reachable — predicts user-visible health
  checks.caddy = await checkCaddyLiveness();

  if (!checks.db || !checks.wireguard || !checks.caddy) status = 503;
  // Show full detail to localhost callers (internal monitoring, docker
  // exec) and to authenticated admin sessions (browser-accessible
  // version/uptime/health view without SSH). Anonymous external
  // callers still get only { ok } so automated HTTP monitors can
  // check up/down without exposing internal state publicly.
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const isAdmin = !!(req.session && req.session.userId);
  if (isLocalhost || isAdmin) {
    res.status(status).json({
      ok: status === 200,
      version: require('../../package.json').version,
      uptime: Math.floor(process.uptime()),
      ...checks,
    });
  } else {
    res.status(status).json({ ok: status === 200 });
  }
});

// ─── Auth routes (public) ──────────────────────────
const authRoutes = require('./auth');
router.get('/login', guestOnly, authRoutes.loginPage);
router.post('/login', guestOnly, loginLimiter, csrfProtection, authRoutes.login);
// Second factor: only reachable with a valid req.session.pending2fa (set by
// POST /login after the password check); requireAuth itself is untouched.
router.get('/login/2fa', guestOnly, authRoutes.twoFactorPage);
router.post('/login/2fa', guestOnly, loginLimiter, csrfProtection, authRoutes.twoFactor);
// Passkey (WebAuthn) login — JSON endpoints driven by /js/login-passkey.js.
router.post('/login/passkey/options', guestOnly, passkeyLoginLimiter, csrfProtection, authRoutes.passkeyOptions);
router.post('/login/passkey', guestOnly, passkeyLoginLimiter, csrfProtection, authRoutes.passkeyLogin);
router.post('/logout', requireAuth, csrfProtection, authRoutes.logout);
// Own password after an administrator set one with "change on next login":
// only reachable with req.session.pendingPwChange (set by the login steps).
router.get('/login/change-password', guestOnly, apiLimiter, authRoutes.changePasswordPage);
router.post('/login/change-password', guestOnly, loginLimiter, csrfProtection, authRoutes.changePassword);

// ─── Invitation to "Mein Bereich" (public, one-time link) ──
const invitePages = require('./invite');
router.get('/invite/:token', apiLimiter, invitePages.page);
router.post('/invite/:token', loginLimiter, csrfProtection, invitePages.accept);

// security.require_2fa: admins without 2FA are confined to the profile setup.
router.use(require('../middleware/twoFactorPolicy').twoFactorPolicy);

// ─── Protected page routes ─────────────────────────
router.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

// Plugin pages, their sandboxed frames and the portal tab frames (docs/plugins.md).
router.use(require('./plugins'));

// Profile page locals: identity header (initials, e-mail) and security rail.
// The session tile shows the CURRENT session — how and when it was
// established (establishSession in routes/auth.js) — not a "last login".
function profileInitials(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0]).slice(0, 2);
  return chars.join('').toUpperCase();
}

// No database access here: the page handler is not rate-limited, so the
// e-mail, passkey count and recovery-code count come from the existing
// (rate-limited) APIs that profile.js / profile-passkeys.js / profile-2fa.js
// already call; `user` (initials, 2FA flag) is loaded by injectLocals.
function profileLocals(req, res) {
  const session = req.session || {};
  const user = res.locals.user || {};
  return {
    profileInitials: profileInitials(user.display_name || user.username),
    sessionAuthMethod: ['password', 'totp', 'passkey'].includes(session.authMethod) ? session.authMethod : null,
    sessionAuthAt: Number(session.authAt) || null,
  };
}

// String prefixes the settings page hands to its scripts (settings.njk island
// data-prefixes must list the same ones).
const SETTINGS_I18N_PREFIXES = ['st.', 'settings.', 'offsite.', 'premig.', 'autoupdate.', 'autobackup.', 'updatesh.', 'client_policy.',
  'client_updates.', 'pihole.cfg.', 'tags.', 'peer_groups.', 'license.', 'common.', 'security.lockout.', 'error.settings.',
  'error.webhooks.', 'error.peer_groups.', 'error.client_policy.', 'error.client_updates.', 'error.wireguard.', 'plugins.'];

const pages = [
  { path: '/dashboard', template: 'dashboard', titleKey: 'nav.dashboard' },
  { path: '/peers', template: 'peers', titleKey: 'nav.peers' },
  // Domain zones page (docs/feature-domain-zones.md); the sidebar item stays 'routes'.
  { path: '/routes', template: 'zones', nav: 'routes', titleKey: 'nav.routes' },
  { path: '/certificates', template: 'certificates', titleKey: 'nav.certificates' },
  // Web Application Firewall (docs/feature-waf.md); licensed only — the sidebar
  // item needs license.features.waf, the page renders a locked notice without it.
  { path: '/waf', template: 'waf', titleKey: 'nav.waf' },
  // Sicherheits-Check + "Was ist öffentlich?" (docs/feature-release-b.md §1/§10),
  // no licence gate; the sidebar item (activeNav 'security') comes from strand B4.
  { path: '/security', template: 'security', titleKey: 'security.page_title' },
  { path: '/logs', template: 'logs', titleKey: 'nav.logs' },
  { path: '/profile', template: 'profile', titleKey: 'profile.title', member: true },
  { path: '/settings', template: 'settings', titleKey: 'nav.settings' },
  { path: '/rdp', template: 'rdp', titleKey: 'nav.rdp' },
  { path: '/users', template: 'users', titleKey: 'nav.users' },
  { path: '/dns', template: 'dns', titleKey: 'nav.dns' },
  { path: '/pihole', template: 'pihole', titleKey: 'pihole.title' },
  { path: '/gateway-pools', template: 'gateway-pools', titleKey: 'gateway_pools.title' },
  { path: '/gateways', template: 'gateways', titleKey: 'nav.gateways' },
];

// Former built-in pages, now first-party plugins (docs/plugins.md "Built-in
// data import"): old bookmarks lead to the plugin's page when it is
// installed, otherwise to Settings → Plugins (legacy.movedPage).
const MOVED_PAGES = [
  ['/smarthome', 'gatecontrol-smarthome', ''],
  ['/smarthome/rules', 'gatecontrol-smarthome', '/rules'],
  ['/midea', 'gatecontrol-midea', ''],
  ['/skoda', 'gatecontrol-skoda', ''],
];
// apiLimiter like /me: the handler checks the role and reads the plugin registry.
for (const [path, pluginId, sub] of MOVED_PAGES) {
  router.get(path, apiLimiter, requireAuth, (req, res) => {
    if (!res.locals.user || res.locals.user.role !== 'admin') return res.redirect('/profile');
    res.redirect(require('../services/plugins/legacy').movedPage(pluginId, sub));
  });
}

// Strings the users page hands to its script (JSON island, like the
// settings page).
const USERS_I18N_PREFIXES = ['us.', 'users.mb.', 'error.users.', 'error.tokens.', 'error.enrollment.', 'enrollment.', 'common.', 'passkey.error_not_found'];

/** The portal link of the member navigation (null when the portal is off). */
function portalLink() {
  try {
    const portalConfig = require('../services/portalConfig');
    if (!portalConfig().enabled) return null;
    return `https://${portalConfig.effectivePortalHost().host}`;
  } catch { return null; }
}

pages.forEach(({ path, template, nav, titleKey, member }) => {
  router.get(path, requireAuth, (req, res) => {
    const activeNav = nav || template;
    const extraLocals = {};
    const isAdmin = !!(res.locals.user && res.locals.user.role === 'admin');

    // Every admin page is made of admin API reads only (each /api/v1 call of
    // a session without the admin role answers 403): a member gets "Konto &
    // Sicherheit" instead of a shell of failing requests (their own area is
    // the portal). The role comes from injectLocals (res.locals.user).
    if (!member && !isAdmin) {
      return res.redirect('/profile');
    }
    // Upgrade notice (dashboard, Settings → Plugins): built-in data of a
    // former integration whose plugin is not installed yet.
    if (template === 'dashboard' || template === 'settings') {
      try { extraLocals.builtinMoved = require('../services/plugins/legacy').pendingMoves(); } catch { extraLocals.builtinMoved = []; }
    }
    // Settings → Plugins: the "Offizielle Plugins" card (GC_PLUGIN_CATALOG=off hides it)
    if (template === 'settings') {
      try { extraLocals.pluginCatalog = require('../services/plugins/catalog').enabled(); } catch { extraLocals.pluginCatalog = false; }
    }
    if (!isAdmin) extraLocals.portalUrl = portalLink();

    // Inject RDP route count for sidebar badge (all pages)
    try {
      const rdpService = require('../services/rdp');
      const counts = rdpService.getCount();
      extraLocals.rdpRouteCount = counts.total;
    } catch (err) { logger.debug({ err: err.message }, 'rdp route count for sidebar unavailable'); }

    // Peers: retention of support bundles for the hint in the edit modal.
    if (template === 'peers') {
      extraLocals.supportRetention = {
        days: config.supportBundles.maxAgeDays,
        keep: config.supportBundles.keepPerPeer,
      };
    }

    if (template === 'zones') {
      try {
        extraLocals.gatewayPools = require('../services/gatewayPool').listPools();
      } catch { extraLocals.gatewayPools = []; }
      try {
        extraLocals.l4BlockedPorts = require('../../config/default').l4.blockedPorts;
      } catch { extraLocals.l4BlockedPorts = []; }
    }

    if (template === 'users') {
      extraLocals.usersI18n = JSON.stringify(stringsWithPrefix(req.language || res.locals.language, USERS_I18N_PREFIXES))
        .replace(/</g, '\\u003c');
    }

    // Profile: `?setup2fa=1` is where the require_2fa policy sends admins
    // without a second factor — the 2FA card opens its setup right away.
    if (template === 'profile') {
      extraLocals.setup2fa = req.query && req.query.setup2fa === '1';
      // Portal PIN section (profile-pin.js): its strings as one JSON island.
      extraLocals.pfPinI18n = JSON.stringify(stringsWithPrefix(req.language || res.locals.language, ['profile.pin.', 'common.error']))
        .replace(/</g, '\\u003c');
      Object.assign(extraLocals, profileLocals(req, res));
    }

    if (template === 'gateway-pools') {
      try {
        extraLocals.pools = require('../services/gatewayPool').listPools();
        for (const p of extraLocals.pools) {
          p.members = require('../services/gatewayPool').listMembers(p.id);
        }
        extraLocals.gatewayPeers = require('../db/connection').getDb()
          .prepare("SELECT id, name FROM peers WHERE peer_type = 'gateway' AND enabled = 1 ORDER BY name").all();
      } catch { extraLocals.pools = []; extraLocals.gatewayPeers = []; }
    }

    // Settings page: every value comes from the settings APIs (no DB read
    // here). Server-rendered: the notification event catalogue (static, for
    // the event matrix and the webhook dialog) and the page's strings as one
    // JSON island (st.* plus the prefixes its helper scripts read).
    if (template === 'settings') {
      extraLocals.notifyCatalogue = JSON.stringify(require('../services/notifications').CATALOGUE.map((g) => ({
        id: g.id, events: g.events.map((e) => ({ id: e.id, types: e.types, free: !!e.free })),
      }))).replace(/</g, '\\u003c');
      extraLocals.settingsI18n = JSON.stringify(stringsWithPrefix(req.language || res.locals.language, SETTINGS_I18N_PREFIXES))
        .replace(/</g, '\\u003c');
    }

    // Dashboard-only: gateways that need re-pairing after master-key rotation
    if (template === 'dashboard') {
      try {
        const { getDb } = require('../db/connection');
        extraLocals.needs_repair_gateways = getDb().prepare(`
          SELECT p.id, p.name FROM peers p JOIN gateway_meta gm ON gm.peer_id=p.id
          WHERE gm.needs_repair=1 AND p.enabled=1
        `).all();
      } catch { extraLocals.needs_repair_gateways = []; }
      // All dashboard.* / problems.* strings for dashboard.js as one JSON
      // island (strings from the locale files only; `<` escaped so the
      // island can never close its <script> element).
      extraLocals.dashI18n = JSON.stringify(stringsWithPrefix(req.language || res.locals.language, ['dashboard.', 'problems.']))
        .replace(/</g, '\\u003c');
    }

    res.render(`${res.locals.theme}/pages/${template}.njk`, {
      title: res.locals.t(titleKey),
      activeNav,
      ...extraLocals,
    });
  });
});

// "Mein Bereich" moved into the portal (tab "Meine Geräte"): /me sends a
// signed-in account there, or to "Konto & Sicherheit" when the portal is off.
// The target is the configured portal host — never request data.
router.get('/me', apiLimiter, requireAuth, (req, res) => res.redirect(portalLink() || '/profile'));

// ─── Browser RDP session player page (admin-only, feature-gated) ──────────
// apiLimiter: this page performs an explicit privileged role lookup (unlike the
// declarative page routes which only gate on session presence), so rate-limit it
// as defence-in-depth against session/id enumeration.
router.get('/rdp/:id/session', requireAuth, apiLimiter, (req, res) => {
  const rdpService = require('../services/rdp');
  const users = require('../services/users');
  const { hasFeature } = require('../services/license');
  // Chain3-C1: admin-role gate (requireAuth only checks session presence).
  const actorUser = users.getById(req.session?.userId);
  if (!actorUser || actorUser.role !== 'admin') return res.redirect('/profile');
  const id = parseInt(req.params.id, 10);
  const route = rdpService.getById(id, false, { credFlags: true });
  if (!route || !route.browser_enabled || !hasFeature('browser_sessions')) {
    return res.redirect('/rdp');
  }
  res.render(`${res.locals.theme}/pages/rdp-session.njk`, {
    title: res.locals.t('rdp.session.title'),
    route,
    guac: require('../../config/default').guac,
  });
});

// ─── Public API routes (no auth required) ─────────
// Update check returns only public release info (version, download URL)
// and must work without a token so clients can discover updates before
// registering or when their token is invalid/expired.
const clientRoutes = require('./api/client');
router.use('/api/v1/client/update', apiLimiter, clientRoutes.updateRouter || Router());

// App setup-code redeem — public like the update check: the app has no token
// yet, the one-shot code is the credential. Must stay before requireAuth.
const { clientEnrollLimiter } = require('../middleware/rateLimit');
router.use('/api/v1/client/enroll', clientEnrollLimiter, require('./api/client/enroll'));

// ─── Gateway API (uses own Bearer-token auth, not admin/session auth) ──
// No apiLimiter here: it is keyed by IP and would make gateways behind the
// admin's NAT share the dashboard's bucket. The router applies its own
// per-gateway limiter after auth (and gatewayPairLimiter on /pair).
router.use('/api/v1/gateway', require('./api/gateway'));

// ─── Real-time event stream (SSE) — session-authed, bypasses apiLimiter ──
// Admin event feed: same role gate as the admin API below. Own generous
// budget for (re)connects only — one stream lives for minutes.
const { eventStreamLimiter } = require('../middleware/rateLimit');
router.get('/api/v1/events', eventStreamLimiter, requireAuth, requireAdmin, require('./api/events'));

// ─── Push stream of the apps (notification center) — token-authed SSE ──
// Like /api/v1/events before the apiLimiter (one stream lives up to an hour);
// own limiter for (re)connects after authentication, keyed by the token id.
// Token, scope `client`, machine binding and "push on" are checked by the handler.
const { pushStreamLimiter } = require('../middleware/rateLimit');
router.get('/api/v1/client/push', requireAuth, pushStreamLimiter, require('./api/client/push').stream);

// ─── Portal API (source-IP identity + portal/web session) ───────
const portalIdentity = require('../middleware/portalIdentity');
const portalOwner = require('../middleware/portalOwner');
const { portalApiLimiter } = require('../middleware/rateLimit');
router.use('/api/v1/portal', portalIdentity, portalApiLimiter, portalOwner, require('./api/portal'));

// ─── Portal pages: /portal, /auto (login link of the apps), "Wer bist du?" ──
router.use(require('./portal'));

// ─── API routes ────────────────────────────────────
router.use('/api/v1', requireAuth, apiLimiter, require('./api'));

module.exports = router;
