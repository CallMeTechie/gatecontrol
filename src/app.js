'use strict';

const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const helmet = require('helmet');
const session = require('express-session');
const nunjucks = require('nunjucks');
const config = require('../config/default');
const SQLiteStore = require('./middleware/sessionStore');
const { i18nMiddleware, loadLocales } = require('./middleware/i18n');
const { injectLocals, THEME } = require('./middleware/locals');
const { injectCsrfToken } = require('./middleware/csrf');
const logger = require('./utils/logger');

function createApp() {
  const app = express();

  // ─── Trust proxy (behind Caddy) ───────────────────
  app.set('trust proxy', 'loopback');

  // ─── Event-loop watch (utils/loopStall.js): a request whose synchronous
  // part or answer (res.json / res.send) holds the thread is named in the
  // "event loop was blocked" line, open requests of that moment too ──
  const loopStall = require('./utils/loopStall');
  app.use(loopStall.httpMiddleware);

  // ─── CSP nonce generation ───────────────────────
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  // ─── IP block (services/ipBlock.js): a blocked address reaches nothing ──
  app.use(require('./services/ipBlock').middleware);

  // ─── Security headers ────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrcElem: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "https://fonts.googleapis.com"],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // ─── Request bodies: 5 min each, media uploads longer (middleware/requestDeadline.js) ──
  app.use(require('./middleware/requestDeadline').requestDeadline);

  // ─── Body parsing ────────────────────────────────
  // Gateway companion endpoints must stay small: heartbeats, probe
  // results, etc. Reject oversized bodies BEFORE express.json runs,
  // because body-parser sets req._body=true after the first parse,
  // so a per-router express.json({ limit: '16kb' }) would be a no-op.
  // The apps' plugin API (docs/plugins.md "App") takes JSON up to 64 KB.
  app.use((req, res, next) => {
    if (!/^\/api\/v1\/client\/plugins\/[^/]+\/api\//i.test(req.path)) return next();
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > 64 * 1024) return res.status(413).json({ ok: false, code: 'too_large' });
    next();
  });
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/v1/gateway/')) return next();
    const len = parseInt(req.headers['content-length'] || '0', 10);
    // phase 3a: the network watch report (≤ 1024 devices), the internet quality
    // buffer (≤ 48 h), presence events; the speed test upload streams and checks
    // its own limit (services/inetq.js speedUp — never parsed, never buffered)
    if (req.path === '/api/v1/gateway/speedtest/up') return next();
    // phase 3c: a scanned page (raw, ≤ 50 MB, never parsed — services/homePrint.js storePage checks it)
    if (req.method === 'PUT' && /^\/api\/v1\/gateway\/print\/scans\/[A-Za-z0-9_-]{8,64}\/pages\/\d{1,3}$/.test(req.path)) {
      return len > 50 * 1024 * 1024 ? res.status(413).json({ ok: false, error: 'Payload too large' }) : next();
    }
    // phase 3b: the DNS filter statistics (5 minutes), the home cache report (≤ 5000 sha256 per list)
    const GATEWAY_BODY_MAX = { '/api/v1/gateway/discovery': 512 * 1024, '/api/v1/gateway/netwatch': 1024 * 1024, '/api/v1/gateway/inetq': 512 * 1024, '/api/v1/gateway/presence': 64 * 1024,
      '/api/v1/gateway/dns': 256 * 1024, '/api/v1/gateway/cache': 1024 * 1024, '/api/v1/gateway/print/devices': 256 * 1024,
      // phase 3c, step 2: up to 64 Bluetooth sensors
      '/api/v1/gateway/radio/ble': 64 * 1024 };
    const MAX_GATEWAY_BODY = GATEWAY_BODY_MAX[req.path] || 16 * 1024;
    if (len > MAX_GATEWAY_BODY) {
      return res.status(413).json({ ok: false, error: 'Payload too large' });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // ─── Static files (webroot) ──────────────────────
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, {
    dotfiles: 'deny',
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  }));
  // Same files under /route-auth/static/* so the route-auth login page
  // can load its CSS/JS assets via a unique prefix that Caddy can
  // safely intercept on proxied domains (speedport.foo etc.) without
  // colliding with the upstream application's own /css, /js paths.
  app.use('/route-auth/static', express.static(publicDir, {
    dotfiles: 'deny',
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  }));

  // ─── Route Auth (public, before session/csrf) ──────
  // Must be mounted before session middleware to avoid admin CSRF token
  // conflicts with route-auth CSRF. The admin-side injectLocals runs
  // AFTER session; here route-auth gets its own lean middleware stack
  // (i18n + theme) so /route-auth/login can render its Nunjucks template
  // without `res.locals.theme` being undefined (which produced a 500
  // on every unauthenticated visit to a protected route).
  loadLocales();
  // Aurora is the only theme; no settings/session lookup needed here.
  const routeAuthLocals = (req, res, next) => {
    res.locals.theme = THEME;
    res.locals.appVersion = require('../package.json').version; // ?v= cache-buster on the CSS links
    next();
  };
  const routeAuthRoutes = require('./routes/routeAuth');
  app.use('/route-auth', i18nMiddleware, routeAuthLocals, routeAuthRoutes);

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
  // (reads the user and the sidebar counts: one generous budget per session user)
  app.use(require('./middleware/rateLimit').sessionLocalsLimiter, injectLocals);

  // ─── License locals ──────────────────────────────
  const { injectLicense } = require('./middleware/license');
  app.use(injectLicense);

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
  // the handlers once more after the body was read (body parsers continue asynchronously)
  app.use(loopStall.measureNext);
  app.use(routes);

  // ─── 404 ─────────────────────────────────────────
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).render(`${THEME}/pages/404.njk`, {
      title: '404',
    });
  });

  // ─── Error handler ───────────────────────────────
  app.use((err, req, res, _next) => {
    if (err.code === 'EBADCSRFTOKEN') {
      // a form left open past its session (the login page of yesterday): an
      // expected answer, not a fault of the server — a short warning, no stack
      logger.warn({ path: req.path, method: req.method }, 'invalid csrf token');
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
      }
      return res.status(403).render(`${THEME}/pages/error.njk`, {
        title: 'Forbidden',
        message: 'Invalid security token. Please refresh and try again.',
      });
    }

    logger.error({ err, path: req.path }, 'Unhandled error');

    // Body parser rejections are client errors, not server errors.
    if (err.type === 'entity.parse.failed' && req.path.startsWith('/api/')) {
      return res.status(400).json({ ok: false, code: 'invalid_json', error: 'Invalid JSON body' });
    }
    if (err.type === 'entity.too.large' && req.path.startsWith('/api/')) {
      return res.status(413).json({ ok: false, code: 'payload_too_large', error: 'Payload too large' });
    }

    const status = err.status || 500;
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ error: 'Internal server error' });
    }
    res.status(status).render(`${THEME}/pages/error.njk`, {
      title: 'Error',
      message: process.env.NODE_ENV === 'production'
        ? 'Something went wrong'
        : err.message,
    });
  });

  return app;
}

module.exports = { createApp };