'use strict';

const { Router } = require('express');
const { requireAuth, guestOnly } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const { loginLimiter, apiLimiter } = require('../middleware/rateLimit');
const config = require('../../config/default');

const router = Router();

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
  res.status(status).json({ ok: status === 200, ...checks });
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
const apiRoutes = require('./api');
router.use('/api/v1', requireAuth, apiLimiter, apiRoutes);
router.use('/api', requireAuth, apiLimiter, apiRoutes); // Backward-compatible alias

module.exports = router;
