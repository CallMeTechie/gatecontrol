'use strict';

const { Router } = require('express');
const { requireAuth, guestOnly } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const { loginLimiter, apiLimiter } = require('../middleware/rateLimit');
const config = require('../../config/default');

const express = require('express');
const router = Router();

// ─── Branding assets (public, no auth) ─────────────
router.use('/branding', express.static('/data/branding', { maxAge: '1d' }));

// ─── Prometheus metrics (token auth or session) ────
router.get('/metrics', async (req, res) => {
  const settings = require('../services/settings');

  // Check if metrics are enabled
  if (settings.get('metrics_enabled', 'false') !== 'true') {
    return res.status(404).json({ ok: false, error: 'Not found' });
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

// ─── Health check (public, no auth) ────────────────
router.get('/health', async (req, res) => {
  const checks = { db: false, wireguard: false };
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

  if (!checks.db || !checks.wireguard) status = 503;
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (isLocalhost) {
    res.status(status).json({ ok: status === 200, ...checks });
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
  { path: '/config', template: 'config', titleKey: 'nav.wg_config' },
  { path: '/caddy-config', template: 'caddy-config', titleKey: 'nav.caddy_config' },
  { path: '/certificates', template: 'certificates', titleKey: 'nav.certificates' },
  { path: '/logs', template: 'logs', titleKey: 'nav.logs' },
  { path: '/profile', template: 'profile', titleKey: 'profile.title' },
  { path: '/settings', template: 'settings', titleKey: 'nav.settings' },
];

pages.forEach(({ path, template, titleKey }) => {
  router.get(path, requireAuth, (req, res) => {
    res.render(`${config.theme.defaultTheme}/pages/${template}.njk`, {
      title: res.locals.t(titleKey),
      activeNav: template,
    });
  });
});

// ─── API routes ────────────────────────────────────
router.use('/api/v1', requireAuth, apiLimiter, require('./api'));

module.exports = router;
