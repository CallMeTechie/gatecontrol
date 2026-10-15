'use strict';

// Plugin pages (docs/plugins.md "Oberfläche").
//
//   GET /plugins/:id[/:page]          aurora page: header + sandboxed iframe
//                                     (or "derzeit deaktiviert" for a plugin
//                                     that is installed but not running)
//   GET /plugins/:id/frame/:page      the frame document (plugin HTML, sandboxed)
//   GET /portal/plugins/:id/frame     the frame of a plugin's portal tab
//                                     (?section=<id>: one of its sections in Zuhause/Fahrzeug)
//   GET /plugins/_shared/leaflet/…    the vendored Leaflet for frames of plugins
//                                     with ui.maps (leaflet.js, leaflet.css, images/*.png)
//
// Admin pages are for administrators like every other admin page (members
// are sent to /profile). The frame is rendered by the plugin process for the
// requesting user; its HTML never enters a GateControl page (frame.js).

const fs = require('node:fs');
const path = require('node:path');
const { Router } = require('express');
const plugins = require('../services/plugins');
const runtime = require('../services/plugins/runtime');
const frame = require('../services/plugins/frame');
const { loc } = require('../services/plugins/manifest');
const { ID_RE } = require('../services/plugins/constants');
const { requireAuth } = require('../middleware/auth');
const { pluginPageLimiter, pluginAssetLimiter } = require('../middleware/rateLimit');

const router = Router();

// ─── Shared Leaflet for map frames (ui.maps, docs/plugins.md "Maps") ─────
// Public like /vendor (a sandboxed frame has an opaque origin and sends no
// cookies). Cross-Origin-Resource-Policy cross-origin: helmet's same-origin
// would block the frame (opaque origin) from loading them. The stylesheet is
// the Leaflet section of public/css/app.css (the admin pages' only
// stylesheet carries it), with its image URLs relative to this folder.

const LEAFLET_DIR = path.join(__dirname, '..', '..', 'public', 'vendor', 'leaflet');
const LEAFLET_IMAGES = new Set(['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']);
const LEAFLET_CSS_START = '/* ---- Leaflet 1.9.4';
const LEAFLET_CSS_END = '/* ====';
let leafletCss = null;

/** The Leaflet stylesheet (from app.css), '' when the section cannot be found. */
function leafletStylesheet() {
  if (leafletCss !== null) return leafletCss;
  let css = '';
  try {
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'app.css'), 'utf8');
    const a = app.indexOf(LEAFLET_CSS_START);
    const b = a < 0 ? -1 : app.indexOf(LEAFLET_CSS_END, a);
    if (a >= 0) {
      const section = app.slice(a, b < 0 ? app.length : b);
      css = '/* Leaflet 1.9.4 (BSD-2-Clause, public/vendor/leaflet) for plugin map frames — docs/plugins.md "Maps" */\n'
        + section.slice(section.indexOf('*/') + 2).replace(/url\(\/vendor\/leaflet\/images\//g, 'url(images/').trim() + '\n';
    }
  } catch { css = ''; }
  leafletCss = css;
  return css;
}

function sharedHeaders(res) {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', process.env.NODE_ENV === 'production' ? 'public, max-age=86400' : 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
}

router.get('/plugins/_shared/leaflet/leaflet.js', pluginAssetLimiter, (req, res) => {
  sharedHeaders(res);
  res.type('application/javascript');
  return res.sendFile(path.join(LEAFLET_DIR, 'leaflet.js'));
});

router.get('/plugins/_shared/leaflet/leaflet.css', pluginAssetLimiter, (req, res) => {
  const css = leafletStylesheet();
  if (!css) return res.sendStatus(404);
  sharedHeaders(res);
  res.type('text/css');
  return res.send(css);
});

router.get('/plugins/_shared/leaflet/images/:file', pluginAssetLimiter, (req, res) => {
  const f = String(req.params.file || '');
  if (!LEAFLET_IMAGES.has(f)) return res.sendStatus(404);
  sharedHeaders(res);
  res.type('image/png');
  return res.sendFile(path.join(LEAFLET_DIR, 'images', f));
});

function mapsOf(p) { return !!(p && p.manifest && p.manifest.ui && p.manifest.ui.maps); }

/**
 * Frame headers for plugin `p` (maps → the relaxed CSP for this request's
 * origin; every frame may show the profile pictures of this origin).
 */
function frameHeaders(req, res, p) {
  const maps = mapsOf(p);
  frame.headers(res, { maps, avatars: true, origin: frame.originOf(req) });
  return maps;
}

function lang(req, res) { return (req.language || res.locals.language) === 'en' ? 'en' : 'de'; }

function isAdmin(res) { return !!(res.locals.user && res.locals.user.role === 'admin'); }

function findPlugin(id) {
  const s = String(id || '');
  return ID_RE.test(s) && s.length <= 64 ? plugins.get(s) : null;
}

function pageOf(p, pageId) {
  const pages = (p.manifest && p.manifest.ui && p.manifest.ui.pages) || [];
  if (!pages.length) return null;
  if (pageId == null) return pages[0];
  return pages.find((x) => x.id === pageId) || null;
}

function errorFrame(res, status, text, l) {
  frame.headers(res);
  return res.status(status).send(frame.document({ html: '<p class="muted">' + frame.escAttr(text) + '</p>', lang: l }));
}

const REASON_KEYS = new Set(['disabled', 'license', 'unsigned', 'incompatible', 'files_missing', 'broken', 'crashed', 'starting']);

router.get('/plugins/:id/frame/:page', pluginPageLimiter, requireAuth, async (req, res) => {
  const l = lang(req, res);
  if (!isAdmin(res)) return errorFrame(res, 403, res.locals.t('plugins.page.forbidden'), l);
  const p = findPlugin(req.params.id);
  const page = p && pageOf(p, req.params.page);
  if (!p || !page) return errorFrame(res, 404, res.locals.t('plugins.page.not_found'), l);
  const u = res.locals.user;
  try {
    const out = await plugins.render(p.id, { view: 'page', page: page.id, lang: l, user: { id: u.id, name: u.display_name || u.username, role: u.role } });
    const maps = frameHeaders(req, res, p);
    return res.send(frame.document({ html: out.html, lang: l, maps }));
  } catch (e) {
    return errorFrame(res, 503, res.locals.t(e && e.code === 'ERR_NOT_RUNNING' ? 'plugins.page.not_running' : 'plugins.page.error'), l);
  }
});

router.get('/plugins/:id/:page?', pluginPageLimiter, requireAuth, (req, res) => {
  if (!isAdmin(res)) return res.redirect('/profile');
  const p = findPlugin(req.params.id);
  const l = lang(req, res);
  const page = p && pageOf(p, req.params.page);
  if (!p || (req.params.page && !page)) {
    return res.status(404).render(`${res.locals.theme}/pages/404.njk`, { title: '404' });
  }
  const view = plugins.view(p, l);
  const ev = plugins.evaluate(p);
  const running = ev.run && runtime.info(p.id).state === 'running';
  const reason = ev.run ? (runtime.info(p.id).state === 'crashed' ? 'crashed' : 'starting') : ev.reason;
  res.render(`${res.locals.theme}/pages/plugin.njk`, {
    title: view.nav ? view.nav.label : view.name,
    activeNav: 'plugin:' + p.id,
    plugin: view,
    page: page ? { id: page.id, title: loc(page.title, l) } : null,
    running: running && !!page,
    reason: REASON_KEYS.has(reason) ? reason : 'disabled',
    pagesJson: JSON.stringify(view.pages.map((x) => x.id)),
  });
});

// ─── Portal tab frame ───────────────────────────

const portalConfig = require('../services/portalConfig');
const portalIdentity = require('../middleware/portalIdentity');
const portalOwner = require('../middleware/portalOwner');

router.get('/portal/plugins/:id/frame', pluginPageLimiter, (req, res, next) => {
  if (!portalConfig().enabled) return res.sendStatus(404);
  next();
}, portalIdentity, portalOwner, async (req, res) => {
  const l = lang(req, res);
  const p = findPlugin(req.params.id);
  if (!p || !p.manifest.permissions.portal || !p.manifest.ui.portal) return errorFrame(res, 404, res.locals.t('plugins.page.not_found'), l);
  // ?section=<id>: one of the plugin's sections in a GateControl portal tab; none = its own tab
  const sq = req.query.section;
  const section = typeof sq === 'string' ? (p.manifest.ui.portal.sections || []).find((s) => s.id === sq) : null;
  if (sq !== undefined && !section) return errorFrame(res, 404, res.locals.t('plugins.page.not_found'), l);
  if (!section && !p.manifest.ui.portal.label) return errorFrame(res, 404, res.locals.t('plugins.page.not_found'), l);
  if (req.portalOwnerId == null) return errorFrame(res, 403, res.locals.t('plugins.page.forbidden'), l);
  const u = require('../services/users').getById(req.portalOwnerId);
  if (!u || u.enabled !== 1) return errorFrame(res, 403, res.locals.t('plugins.page.forbidden'), l);
  try {
    const viewer = { id: u.id, name: u.display_name || u.username, role: u.role, portal: true, loggedIn: !!req.portalLoggedIn };
    if (req.portalOwnerSource === 'kiosk' && req.portalKiosk) viewer.kiosk = true; // kiosk device (docs/feature-kiosk-devices.md)
    const out = await plugins.render(p.id, { view: 'portal', page: null, section: section ? section.id : null, lang: l, user: viewer, loggedIn: !!req.portalLoggedIn });
    const maps = frameHeaders(req, res, p);
    return res.send(frame.document({ html: out.html, lang: l, maps }));
  } catch (e) {
    return errorFrame(res, 503, res.locals.t(e && e.code === 'ERR_NOT_RUNNING' ? 'plugins.page.not_running' : 'plugins.page.error'), l);
  }
});

module.exports = router;
module.exports._leafletStylesheet = leafletStylesheet;
