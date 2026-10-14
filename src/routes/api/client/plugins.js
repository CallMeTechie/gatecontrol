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
