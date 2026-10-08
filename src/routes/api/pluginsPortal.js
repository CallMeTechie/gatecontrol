'use strict';

// Portal side of plugins with the `portal` permission (docs/plugins.md):
//   *  /api/v1/portal/plugins/:id/api/<path>   forwarded to the plugin
//   GET /api/v1/portal/plugins/start           Start-tab tiles of all plugins
//   GET /api/v1/portal/plugins/search?q=       search results of all plugins
// Mounted inside the portal API router (routes/api/portal.js): the portal
// gate, portalIdentity/portalOwner and the CSRF check of signed-in viewers
// have run. The plugin sees the portal viewer as the acting user — reads
// need an identified owner, changes a portal or web login (like the
// built-in portal widgets: device trust is read-only). `user.loggedIn` tells
// the plugin whether the viewer signed in (true) or is only recognised by
// device trust (false) — sensitive data (e.g. a vehicle's position) only for
// a real login.

const { Router } = require('express');
const plugins = require('../../services/plugins');
const { forwarder } = require('./plugins');
const { ID_RE } = require('../../services/plugins/constants');
const { pluginApiLimiter } = require('../../middleware/rateLimit');

const router = Router();
router.use(pluginApiLimiter);

function portalUser(req) {
  if (req.portalOwnerId == null) return null;
  if (req.method !== 'GET' && !req.portalLoggedIn) return null;
  const u = require('../../services/users').getById(req.portalOwnerId);
  if (!u || u.enabled !== 1) return null;
  return { id: u.id, name: u.display_name || u.username, role: u.role, portal: true, loggedIn: !!req.portalLoggedIn };
}

// Start tiles and search of the plugins (src/services/plugins/portal.js):
// declarative data for the identified viewer, every plugin with a timeout.
const portalContrib = require('../../services/plugins/portal');

function lang(req) { return req.language === 'en' ? 'en' : 'de'; }

router.get('/start', async (req, res) => {
  const user = req.portalOwnerId == null ? null : portalUser(req);
  res.set('Cache-Control', 'no-store');
  if (!user) return res.json({ ok: true, tiles: [] });
  try {
    res.json({ ok: true, tiles: await portalContrib.tiles(user, lang(req)) });
  } catch {
    res.json({ ok: true, tiles: [] });
  }
});

router.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const user = req.portalOwnerId == null ? null : portalUser(req);
  res.set('Cache-Control', 'no-store');
  if (!user || q.length > 200) return res.json({ ok: true, results: [] });
  try {
    res.json({ ok: true, results: await portalContrib.search(user, lang(req), q) });
  } catch {
    res.json({ ok: true, results: [] });
  }
});

router.all('/:id/api/*', (req, res, next) => {
  const id = String(req.params.id || '');
  const p = ID_RE.test(id) ? plugins.get(id) : null;
  if (!p || !p.manifest || !p.manifest.permissions || !p.manifest.permissions.portal) return res.status(404).json({ ok: false, code: 'not_found' });
  next();
}, forwarder(portalUser));

module.exports = router;
