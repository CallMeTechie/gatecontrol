'use strict';

const config = require('../../config/default');
const { getDb } = require('../db/connection');

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
  res.locals.currentPath = req.path;
  res.locals.theme = config.theme.defaultTheme;

  // User info if authenticated
  if (req.session && req.session.userId) {
    const db = getDb();
    const user = db.prepare('SELECT id, username, display_name, role, language, theme FROM users WHERE id = ?')
      .get(req.session.userId);
    if (user) {
      res.locals.user = user;
      res.locals.theme = user.theme || config.theme.defaultTheme;
      if (user.language) {
        req.session.language = user.language;
      }
    }
  }

  // Flash messages
  if (req.session) {
    res.locals.flash = req.session.flash || {};
    req.session.flash = {};
  }

  next();
}

function setFlash(req, type, message) {
  if (!req.session.flash) req.session.flash = {};
  req.session.flash[type] = message;
}

module.exports = { injectLocals, setFlash };
