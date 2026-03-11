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

router.get('/dashboard', requireAuth, (req, res) => {
  res.render(`${config.theme.defaultTheme}/pages/dashboard.njk`, {
    title: res.locals.t('nav.dashboard'),
    activeNav: 'dashboard',
  });
});

router.get('/peers', requireAuth, (req, res) => {
  res.render(`${config.theme.defaultTheme}/pages/peers.njk`, {
    title: res.locals.t('nav.peers'),
    activeNav: 'peers',
  });
});

router.get('/routes', requireAuth, (req, res) => {
  res.render(`${config.theme.defaultTheme}/pages/routes.njk`, {
    title: res.locals.t('nav.routes'),
    activeNav: 'routes',
  });
});

router.get('/config', requireAuth, (req, res) => {
  res.render(`${config.theme.defaultTheme}/pages/config.njk`, {
    title: res.locals.t('nav.wg_config'),
    activeNav: 'config',
  });
});

router.get('/certificates', requireAuth, (req, res) => {
  res.render(`${config.theme.defaultTheme}/pages/certificates.njk`, {
    title: res.locals.t('nav.certificates'),
    activeNav: 'certificates',
  });
});

router.get('/logs', requireAuth, (req, res) => {
  res.render(`${config.theme.defaultTheme}/pages/logs.njk`, {
    title: res.locals.t('nav.logs'),
    activeNav: 'logs',
  });
});

router.get('/settings', requireAuth, (req, res) => {
  res.render(`${config.theme.defaultTheme}/pages/settings.njk`, {
    title: res.locals.t('nav.settings'),
    activeNav: 'settings',
  });
});

// ─── API routes ────────────────────────────────────
router.use('/api', requireAuth, apiLimiter, require('./api'));

module.exports = router;
