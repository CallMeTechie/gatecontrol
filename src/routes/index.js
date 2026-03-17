'use strict';

const { Router } = require('express');
const { requireAuth, guestOnly } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const { loginLimiter, apiLimiter } = require('../middleware/rateLimit');
const config = require('../../config/default');

const router = Router();

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
router.use('/api', requireAuth, apiLimiter, require('./api'));

module.exports = router;
