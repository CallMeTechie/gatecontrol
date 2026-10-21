'use strict';

// Portal side of plugins with the `portal` permission (docs/plugins.md):
//   *  /api/v1/portal/plugins/:id/api/<path>   forwarded to the plugin
//   GET /api/v1/portal/plugins/start           Start-tab tiles of all plugins
//   GET /api/v1/portal/plugins/search?q=       search results of all plugins
//   PUT /api/v1/portal/plugins/:id/media       an upload of the plugin's frame
//                                              (GC.upload, plugin.json `media`) — a
//                                              portal or web login, CSRF; a part of a
//                                              resumable upload with ?uploadId= (1.193.0)
//   GET /api/v1/portal/plugins/:id/media/uploads/:uploadId   where it stands (HEAD too)
//   GET /api/v1/portal/plugins/:id/events      SSE: the plugin's realtime events for
//                                              the viewer (permissions.events) — a
//                                              portal or web login (or a kiosk device)
// Mounted inside the portal API router (routes/api/portal.js): the portal
// gate, portalIdentity/portalOwner and the CSRF check of signed-in viewers
// have run. The plugin sees the portal viewer as the acting user — reads
// need an identified owner, changes a portal or web login (like the
// built-in portal widgets: device trust is read-only). `user.loggedIn` tells
// the plugin whether the viewer signed in (true) or is only recognised by
// device trust (false) — sensitive data (e.g. a vehicle's position) only for
// a real login. A kiosk device (wall tablet) comes with `loggedIn: true` and
// `kiosk: true`.

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
  const user = { id: u.id, name: u.display_name || u.username, role: u.role, portal: true, loggedIn: !!req.portalLoggedIn };
  // A kiosk device (docs/feature-kiosk-devices.md): signed in as this user,
  // `kiosk: true` in addition to `loggedIn: true`.
  if (req.portalOwnerSource === 'kiosk' && req.portalKiosk) user.kiosk = true;
  return user;
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

/** A running portal plugin with this id (may run, running), or null. */
function runningPortalPlugin(req) {
  const id = String(req.params.id || '');
  const p = ID_RE.test(id) ? plugins.get(id) : null;
  if (!p || !p.manifest || !p.manifest.permissions || !p.manifest.permissions.portal) return null;
  return plugins.evaluate(p).run && require('../../services/plugins/runtime').info(p.id).state === 'running' ? p : null;
}

// ─── Media upload of a frame (GC.upload → public/js/plugin-bridge.js) ────
const media = require('../../services/plugins/media');

router.put('/:id/media', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const p = runningPortalPlugin(req);
  if (!p || !media.declOf(p)) return res.status(404).json({ ok: false, code: 'not_found' });
  const user = portalUser(req); // a change: portal or web login only
  if (!user) return res.status(403).json({ ok: false, code: 'login_required' });
  try {
    return res.json({ ok: true, ...(await media.upload(p, user.id, req)) });
  } catch (e) { return media.failure(res, e); }
});

// where a resumable upload of this viewer stands (media.resumable, since 1.193.0; HEAD: headers only)
router.get('/:id/media/uploads/:uploadId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const p = runningPortalPlugin(req);
  if (!p || !media.declOf(p)) return res.status(404).json({ ok: false, code: 'not_found' });
  const user = portalUser(req);
  if (!user || !user.loggedIn) return res.status(403).json({ ok: false, code: 'login_required' });
  return require('./client/plugins').uploadStatus(res, media.uploadStatus(p, user.id, String(req.params.uploadId || '')));
});

// ─── Realtime events of the plugin (services/plugins/events.js) ────
// Pushed by the core without asking the plugin, so for signed-in viewers
// only (device trust alone is not enough for live private data).
router.get('/:id/events', (req, res) => {
  const p = runningPortalPlugin(req);
  if (!p || !p.manifest.permissions.events) return res.status(404).json({ ok: false, code: 'not_found' });
  const user = portalUser(req);
  if (!user || !user.loggedIn) return res.status(403).json({ ok: false, code: 'login_required' });
  return require('../../services/plugins/events').openStream(req, res, p.id, user.id);
});

router.all('/:id/api/*', (req, res, next) => {
  const id = String(req.params.id || '');
  const p = ID_RE.test(id) ? plugins.get(id) : null;
  if (!p || !p.manifest || !p.manifest.permissions || !p.manifest.permissions.portal) return res.status(404).json({ ok: false, code: 'not_found' });
  next();
}, forwarder(portalUser));

module.exports = router;
