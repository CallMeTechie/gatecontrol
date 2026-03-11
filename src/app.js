'use strict';

const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const session = require('express-session');
const nunjucks = require('nunjucks');
const config = require('../config/default');
const SQLiteStore = require('./middleware/sessionStore');
const { i18nMiddleware, loadLocales } = require('./middleware/i18n');
const { injectLocals } = require('./middleware/locals');
const { injectCsrfToken } = require('./middleware/csrf');
const logger = require('./utils/logger');

function createApp() {
  const app = express();

  // ─── Trust proxy (behind Caddy) ───────────────────
  app.set('trust proxy', 1);

  // ─── Security headers ────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // ─── Body parsing ────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ─── Static files (webroot) ──────────────────────
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, {
    dotfiles: 'deny',
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  }));

  // ─── Sessions ────────────────────────────────────
  const store = new SQLiteStore();
  app.use(session({
    store,
    secret: config.app.secret,
    name: 'gc.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.app.baseUrl.startsWith('https'),
      sameSite: 'strict',
      maxAge: config.auth.sessionMaxAge,
    },
  }));

  // ─── i18n ────────────────────────────────────────
  loadLocales();
  app.use(i18nMiddleware);

  // ─── Template locals ─────────────────────────────
  app.use(injectLocals);

  // ─── CSRF token injection ────────────────────────
  app.use(injectCsrfToken);

  // ─── Nunjucks template engine ────────────────────
  const templateDir = path.join(__dirname, '..', 'templates');
  const nunjucksEnv = nunjucks.configure(templateDir, {
    autoescape: true,
    express: app,
    noCache: process.env.NODE_ENV !== 'production',
  });

  // Custom filters
  nunjucksEnv.addFilter('bytes', (val) => {
    if (val === null || val === undefined) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(val);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  });

  nunjucksEnv.addFilter('reltime', (val) => {
    if (!val) return '—';
    const now = Date.now();
    const ts = typeof val === 'number' ? val * 1000 : new Date(val).getTime();
    const diff = Math.floor((now - ts) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  });

  nunjucksEnv.addFilter('truncate', (str, len) => {
    if (!str) return '';
    if (str.length <= len) return str;
    return str.substring(0, len) + '...';
  });

  app.set('view engine', 'njk');

  // ─── Routes ──────────────────────────────────────
  const routes = require('./routes');
  app.use(routes);

  // ─── 404 ─────────────────────────────────────────
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).render(`${config.theme.defaultTheme}/pages/404.njk`, {
      title: '404',
    });
  });

  // ─── Error handler ───────────────────────────────
  app.use((err, req, res, _next) => {
    logger.error({ err, path: req.path }, 'Unhandled error');

    if (err.code === 'EBADCSRFTOKEN') {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
      }
      return res.status(403).render(`${config.theme.defaultTheme}/pages/error.njk`, {
        title: 'Forbidden',
        message: 'Invalid security token. Please refresh and try again.',
      });
    }

    const status = err.status || 500;
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ error: 'Internal server error' });
    }
    res.status(status).render(`${config.theme.defaultTheme}/pages/error.njk`, {
      title: 'Error',
      message: process.env.NODE_ENV === 'production'
        ? 'Something went wrong'
        : err.message,
    });
  });

  return app;
}

module.exports = { createApp };
