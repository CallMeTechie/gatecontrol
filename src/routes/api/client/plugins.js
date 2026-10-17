'use strict';

/**
 * Plugins in the GateControl apps (docs/plugins.md "App"), mounted at
 * /api/v1/client/plugins in routes/index.js — after requireAuth, before the
 * general apiLimiter (own budget: clientPluginApiLimiter, 240 per minute and
 * token).
 *
 *   GET /api/v1/client/plugins
 *     200 { ok: true, plugins: [{ id, name, version, tab: { label, icon } | null }] }
 *   ALL /api/v1/client/plugins/:id/api/<path>     forwarded to the plugin's request()
 *     <the plugin's answer>
 *     404 { ok: false, code: 'not_found' }     unknown, not usable or no permissions.app
 *     403 { ok: false, code: 'no_user' }       token without an owner
 *     413 { ok: false, code: 'too_large' }     JSON body over 64 KB
 *     429 { ok: false, code: 'rate_limited' }
 *     502/503/504 like the admin and portal forwarders (plugin_error, not_running, timeout)
 *   PUT /api/v1/client/plugins/:id/media           raw body (plugin.json `media`, docs/plugins.md "Media")
 *     200 { ok: true, mediaId, mime, bytes }
 *     404 not_found / no_media · 411 length_required · 413 too_large · 415 unsupported_type
 *     507 quota_exceeded · 400 aborted / length_mismatch
 *   GET|HEAD /api/v1/client/plugins/:id/media/:mediaId
 *     the file (Range → 206, unsatisfiable → 416) when the plugin's hook
 *     mediaAccess allows the token's owner (no hook: the uploader only), else 404
 *
 * Token only (scope `client` or `full-access`), machine binding — the guard
 * of the quick actions (helpers.requireClientToken). The plugin sees the
 * token's owner as `req.user = { id, name, role, portal: true, loggedIn:
 * true, app: true }` and decides itself what an app user may do. Language:
 * ?lang=de|en, else the owner's language setting, else Accept-Language, else 'de'.
 */

const { Router } = require('express');
const appPlugins = require('../../../services/plugins/app');
const { forwarder } = require('../plugins');
const { clientPluginApiLimiter } = require('../../../middleware/rateLimit');
const { requireClientToken, tokenViewer, viewerLang } = require('./helpers');
const logger = require('../../../utils/logger');

// JSON bodies of the apps' plugin requests (also checked by Content-Length
// in app.js before the body parser runs).
const MAX_BODY_BYTES = 64 * 1024;

const router = Router();
router.use(clientPluginApiLimiter);

router.get('/', async (req, res) => {
  if (!requireClientToken(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const v = tokenViewer(req);
  if (!v) return res.json({ ok: true, plugins: [] });
  try {
    return res.json({ ok: true, plugins: await appPlugins.list(v.user, viewerLang(req, v)) });
  } catch (err) {
    logger.warn({ tokenId: req.tokenId, err: err.message }, 'client plugins: listing failed');
    return res.json({ ok: true, plugins: [] });
  }
});

function bodyBytes(body) {
  if (body == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(body), 'utf8'); } catch { return Infinity; }
}

const forward = forwarder((req) => req.appViewer.user, (req) => req.params.id, { langOf: (req) => viewerLang(req, req.appViewer) });

// ─── Media (plugin.json `media`, services/plugins/media.js) ─────
// The body is the file itself (Content-Type from the plugin's `types`,
// Content-Length ≤ its `maxBytes`) — never JSON, never through a body parser.

const media = require('../../../services/plugins/media');

/** Token, a usable plugin declaring media, an owner → { p, v } or null (answered). */
function mediaGuard(req, res) {
  if (!requireClientToken(req, res)) return null;
  res.set('Cache-Control', 'no-store');
  const p = appPlugins.pluginById(String(req.params.id || ''));
  if (!p || !media.declOf(p)) { res.status(404).json({ ok: false, code: 'not_found' }); return null; }
  const v = tokenViewer(req);
  if (!v) { res.status(403).json({ ok: false, code: 'no_user' }); return null; }
  return { p, v };
}

router.put('/:id/media', async (req, res) => {
  const g = mediaGuard(req, res);
  if (!g) return undefined;
  try {
    return res.json({ ok: true, ...(await media.store(g.p, g.v.user.id, req)) });
  } catch (e) { return media.failure(res, e); }
});

async function mediaGet(req, res) {
  const g = mediaGuard(req, res);
  if (!g) return undefined;
  const r = media.row(g.p.id, String(req.params.mediaId || ''));
  if (!r || !(await media.mayRead(g.p.id, g.v.user, r))) return res.status(404).json({ ok: false, code: 'not_found' });
  return media.send(req, res, r, 'private, max-age=86400, immutable');
}
router.get('/:id/media/:mediaId', mediaGet); // HEAD too (Express answers it with the GET route)

router.all('/:id/api/*', (req, res, next) => {
  if (!requireClientToken(req, res)) return undefined;
  res.set('Cache-Control', 'no-store');
  if (!appPlugins.pluginById(String(req.params.id || ''))) return res.status(404).json({ ok: false, code: 'not_found' });
  const v = tokenViewer(req);
  if (!v) return res.status(403).json({ ok: false, code: 'no_user' });
  if (bodyBytes(req.body) > MAX_BODY_BYTES) return res.status(413).json({ ok: false, code: 'too_large' });
  req.appViewer = v;
  return next();
}, forward);

module.exports = router;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
