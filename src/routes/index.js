'use strict';

const { Router } = require('express');
const { requireAuth, guestOnly } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const { loginLimiter, apiLimiter } = require('../middleware/rateLimit');
const config = require('../../config/default');
const { hasFeature } = require('../services/license');

const express = require('express');
const router = Router();

// ─── Branding assets (public, no auth) ─────────────
// Only serves whitelisted image extensions to prevent stored-XSS if a file slips past upload validation.
const path = require('node:path');
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

  // 1. Session auth
  if (req.session && req.session.userId) {
    authenticated = true;
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
        const scopes = tokenRecord.scopes;
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
router.post('/logout', requireAuth, csrfProtection, authRoutes.logout);

// ─── Protected page routes ─────────────────────────
router.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

const pages = [
  { path: '/dashboard', template: 'dashboard', titleKey: 'nav.dashboard' },
  { path: '/peers', template: 'peers', titleKey: 'nav.peers' },
  { path: '/routes', template: 'routes', titleKey: 'nav.routes' },
  { path: '/certificates', template: 'certificates', titleKey: 'nav.certificates' },
  { path: '/logs', template: 'logs', titleKey: 'nav.logs' },
  { path: '/profile', template: 'profile', titleKey: 'profile.title' },
  { path: '/settings', template: 'settings', titleKey: 'nav.settings' },
  { path: '/rdp', template: 'rdp', titleKey: 'nav.rdp' },
  { path: '/users', template: 'users', titleKey: 'nav.users' },
  { path: '/dns', template: 'dns', titleKey: 'nav.dns' },
  { path: '/pihole', template: 'pihole', titleKey: 'pihole.title' },
  { path: '/midea', template: 'midea', titleKey: 'midea.title' },
  { path: '/smarthome', template: 'smarthome', titleKey: 'smarthome.title' },
  { path: '/smarthome/rules', template: 'smarthome-rules', titleKey: 'smarthome.rules.title' },
  { path: '/gateway-pools', template: 'gateway-pools', titleKey: 'gateway_pools.title' },
  { path: '/gateways', template: 'gateways', titleKey: 'nav.gateways' },
];

pages.forEach(({ path, template, titleKey }) => {
  router.get(path, requireAuth, (req, res) => {
    const extraLocals = {};

    // Inject RDP route count for sidebar badge (all pages)
    try {
      const rdpService = require('../services/rdp');
      const counts = rdpService.getCount();
      extraLocals.rdpRouteCount = counts.total;
    } catch {}

    if (template === 'routes') {
      try {
        extraLocals.gatewayPools = require('../services/gatewayPool').listPools();
      } catch { extraLocals.gatewayPools = []; }
      try {
        extraLocals.l4BlockedPorts = require('../../config/default').l4.blockedPorts;
      } catch { extraLocals.l4BlockedPorts = []; }
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

    // Settings page: gw-down-threshold is the only server-rendered settings
    // value (template reads `settings.gateway_down_threshold_s`). The `settings`
    // template var is otherwise never injected, so the slider always showed the
    // hardcoded default 90. Inject just that one key (not getAll(), to avoid
    // exposing secrets) so the slider reflects the persisted value.
    if (template === 'settings') {
      try {
        extraLocals.settings = {
          gateway_down_threshold_s: require('../services/settings').get('gateway_down_threshold_s'),
        };
      } catch { extraLocals.settings = {}; }
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
    }

    res.render(`${res.locals.theme}/pages/${template}.njk`, {
      title: res.locals.t(titleKey),
      activeNav: template,
      ...extraLocals,
    });
  });
});

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
  if (!actorUser || actorUser.role !== 'admin') return res.redirect('/dashboard');
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

// ─── Gateway API (uses own Bearer-token auth, not admin/session auth) ──
router.use('/api/v1/gateway', apiLimiter, require('./api/gateway'));

// ─── Real-time event stream (SSE) — session-authed, bypasses apiLimiter ──
router.get('/api/v1/events', requireAuth, require('./api/events'));

// ─── Portal API (source-IP identity, no session auth) ──────────
const portalIdentity = require('../middleware/portalIdentity');
const portalOwner = require('../middleware/portalOwner');
router.use('/api/v1/portal', apiLimiter, portalIdentity, portalOwner, require('./api/portal'));

// ─── Portal page (source-IP identity, no session auth) ─────────
const portalConfig = require('../services/portalConfig');
router.get('/portal', portalIdentity, (req, res) => {
  const cfg = portalConfig();
  if (!cfg.enabled) return res.sendStatus(404);
  res.render('portal/portal.njk', {
    widgets: cfg.widgets,
    deviceName: req.portalPeerName,   // null → generic welcome
    identified: req.portalPeerId != null,
    // Reflect the (host-scoped) session so the header shows Login vs Logout.
    // csrfToken for the logout form is already a res.local (injectCsrfToken).
    loggedIn: !!(req.session && req.session.userId),
  });
});

// ─── API routes ────────────────────────────────────
router.use('/api/v1', requireAuth, apiLimiter, require('./api'));

module.exports = router;
