'use strict';

// Plugin pages (docs/plugins.md "Oberfläche").
//
//   GET /plugins/:id[/:page]          aurora page: header + sandboxed iframe
//                                     (or "derzeit deaktiviert" for a plugin
//                                     that is installed but not running)
//   GET /plugins/:id/frame/:page      the frame document (plugin HTML, sandboxed)
//   GET /portal/plugins/:id/frame     the frame of a plugin's portal tab
//                                     (?section=<id>: one of its sections in Zuhause/Fahrzeug)
//
// Admin pages are for administrators like every other admin page (members
// are sent to /profile). The frame is rendered by the plugin process for the
// requesting user; its HTML never enters a GateControl page (frame.js).

const { Router } = require('express');
const plugins = require('../services/plugins');
const runtime = require('../services/plugins/runtime');
const frame = require('../services/plugins/frame');
const { loc } = require('../services/plugins/manifest');
const { ID_RE } = require('../services/plugins/constants');
const { requireAuth } = require('../middleware/auth');
const { pluginPageLimiter } = require('../middleware/rateLimit');

const router = Router();

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
    frame.headers(res);
    return res.send(frame.document({ html: out.html, lang: l }));
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
    const out = await plugins.render(p.id, { view: 'portal', page: null, section: section ? section.id : null, lang: l, user: { id: u.id, name: u.display_name || u.username, role: u.role, portal: true, loggedIn: !!req.portalLoggedIn }, loggedIn: !!req.portalLoggedIn });
    frame.headers(res);
    return res.send(frame.document({ html: out.html, lang: l }));
  } catch (e) {
    return errorFrame(res, 503, res.locals.t(e && e.code === 'ERR_NOT_RUNNING' ? 'plugins.page.not_running' : 'plugins.page.error'), l);
  }
});

module.exports = router;
