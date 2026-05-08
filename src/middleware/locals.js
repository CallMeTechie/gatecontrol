'use strict';

const config = require('../../config/default');
const { getDb } = require('../db/connection');
const settings = require('../services/settings');

function getDefaultTheme() {
  const dbTheme = settings.get('default_theme');
  return (dbTheme === 'default' || dbTheme === 'pro') ? dbTheme : config.theme.defaultTheme;
}

function injectLocals(req, res, next) {
  // App config available in all templates
  res.locals.appName = config.app.name;
  res.locals.appVersion = require('../../package.json').version;
  res.locals.baseUrl = config.app.baseUrl;
  res.locals.wgHost = config.wireguard.host;
  res.locals.wgPort = config.wireguard.port;
  res.locals.wgSubnet = config.wireguard.subnet;
  res.locals.wgGatewayIp = config.wireguard.gatewayIp;
  res.locals.wgInterface = config.wireguard.interface;
  res.locals.wgDns = config.wireguard.dns.join(',');
  res.locals.currentPath = req.path;
  res.locals.theme = getDefaultTheme();

  // User info and sidebar badge counts if authenticated
  if (req.session && req.session.userId) {
    const db = getDb();
    const user = db.prepare('SELECT id, username, display_name, role, language, theme FROM users WHERE id = ?')
      .get(req.session.userId);
    if (user) {
      res.locals.user = user;
      res.locals.theme = user.theme || getDefaultTheme();
      if (user.language) {
        req.session.language = user.language;
      }
    }

    try {
      const peerRow = db.prepare('SELECT COUNT(*) as c FROM peers WHERE enabled = 1').get();
      const routeRow = db.prepare('SELECT COUNT(*) as c FROM routes WHERE enabled = 1').get();
      const httpRouteRow = db.prepare("SELECT COUNT(*) as c FROM routes WHERE enabled = 1 AND (route_type = 'http' OR route_type IS NULL)").get();
      const l4RouteRow = db.prepare("SELECT COUNT(*) as c FROM routes WHERE enabled = 1 AND route_type = 'l4'").get();
      res.locals.peerCount = peerRow ? peerRow.c : 0;
      res.locals.routeCount = routeRow ? routeRow.c : 0;
      res.locals.httpRouteCount = httpRouteRow ? httpRouteRow.c : 0;
      res.locals.l4RouteCount = l4RouteRow ? l4RouteRow.c : 0;

      const groupRow = db.prepare('SELECT COUNT(*) as c FROM peer_groups').get();
      res.locals.peerGroupCount = groupRow ? groupRow.c : 0;
    } catch {
      res.locals.peerCount = 0;
      res.locals.routeCount = 0;
      res.locals.httpRouteCount = 0;
      res.locals.l4RouteCount = 0;
      res.locals.peerGroupCount = 0;
    }
  }

  // Flash messages — only mutate the session when there's actually
  // something to consume. The previous unconditional
  // `req.session.flash = {}` modified every session object on every
  // request, which defeats `saveUninitialized: false` and turned every
  // anon bot probe into a 24h sessions-table row (~11.5k anon rows in
  // 24 h observed). Pair this with the lazy-mint behaviour in
  // injectCsrfToken so an anon visitor's session is only persisted
  // when something genuinely needs to live across requests.
  if (req.session) {
    if (req.session.flash) {
      res.locals.flash = req.session.flash;
      req.session.flash = {};
    } else {
      res.locals.flash = {};
    }
  }

  next();
}

function setFlash(req, type, message) {
  if (!req.session.flash) req.session.flash = {};
  req.session.flash[type] = message;
}

module.exports = { injectLocals, setFlash };
