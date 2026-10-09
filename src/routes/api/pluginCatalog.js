'use strict';

// Official plugin catalogue (docs/plugins.md "Official plugin catalogue"),
// mounted at /api/v1/plugin-catalog behind requireAuth + apiLimiter + CSRF +
// requireAdmin (routes/api/index.js). Session only, like /api/v1/plugins: an
// API token cannot install code.
//
//   GET  /            catalogue plugins with their state (?refresh=1 fetches again)
//   POST /install     { id, version } → download, sha256, inspect — the same
//                     answer as POST /api/v1/plugins/inspect (checks + token);
//                     the administrator confirms with POST /api/v1/plugins/install

const { Router } = require('express');
const plugins = require('../../services/plugins');
const catalog = require('../../services/plugins/catalog');
const registry = require('../../services/plugins/registry');
const semver = require('../../services/plugins/semver');
const { ID_RE } = require('../../services/plugins/constants');
const { pluginApiLimiter, uploadLimiter } = require('../../middleware/rateLimit');
const logger = require('../../utils/logger');

const router = Router();

router.use(pluginApiLimiter);
router.use((req, res, next) => {
  if (req.tokenAuth || !req.session || !req.session.userId) return res.status(403).json({ ok: false, error: 'session_required' });
  next();
});

const STATUS = new Map([
  ['catalog_disabled', 404], ['catalog_unknown', 404], ['catalog_incompatible', 409], ['catalog_mismatch', 409], ['catalog_untrusted', 409],
  ['catalog_config', 500],
]);

function lang(req) { return req.language === 'en' ? 'en' : 'de'; }

function tr(req, key, fallback) {
  const s = req.t ? req.t(key) : key;
  return s && s !== key ? s : fallback;
}

function fail(req, res, err) {
  const code = (err && err.code) || 'internal';
  if (!err || !err.code) logger.error({ err: err && err.message }, 'plugin catalogue API failed');
  else if (/^catalog_/.test(code)) logger.warn({ code, err: err.message }, 'plugin catalogue');
  let status = STATUS.get(code);
  if (!status) status = /^catalog_/.test(code) ? 502 : (/^package_/.test(code) ? 400 : 500);
  return res.status(status).json({ ok: false, code, error: tr(req, 'plugins.err.' + code, tr(req, 'plugins.err.generic', 'Plugin action failed')) });
}

function installedOf(id) {
  try { return registry.get(id); } catch { return null; }
}

/** ?refresh=1 reaches GitHub — budgeted like an upload. */
function refreshLimit(req, res, next) {
  if (req.query && req.query.refresh === '1') return uploadLimiter(req, res, next);
  next();
}

router.get('/', refreshLimit, async (req, res) => {
  const base = { ok: true, enabled: catalog.enabled(), serverVersion: plugins.serverVersion() };
  if (!base.enabled) return res.json({ ...base, available: false, plugins: [] });
  try {
    const cat = await catalog.get({ refresh: req.query.refresh === '1' });
    res.set('Cache-Control', 'no-store');
    res.json({ ...base, available: true, fetchedAt: catalog.fetchedAt(), plugins: catalog.view(cat, lang(req), installedOf, base.serverVersion) });
  } catch (e) {
    // GitHub not reachable / catalogue unusable is a state of the card, not a failed request
    if (!(e instanceof catalog.CatalogError)) return fail(req, res, e);
    logger.warn({ code: e.code, err: e.message }, 'plugin catalogue not available');
    res.set('Cache-Control', 'no-store');
    res.json({ ...base, available: false, code: e.code, error: tr(req, 'plugins.err.' + e.code, tr(req, 'plugins.err.generic', 'Plugin action failed')), plugins: [] });
  }
});

router.post('/install', uploadLimiter, async (req, res) => {
  const b = req.body || {};
  const id = typeof b.id === 'string' ? b.id : '';
  const version = typeof b.version === 'string' ? b.version : '';
  if (!ID_RE.test(id) || id.length < 2 || id.length > 64 || !semver.valid(version)) {
    return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
  }
  if (!catalog.enabled()) return fail(req, res, new catalog.CatalogError('catalog_disabled'));
  try {
    const { buf } = await catalog.download(id, version, plugins.serverVersion());
    // the same checks as an uploaded file — plus: exactly this id and version, trusted signature
    res.json({ ok: true, ...plugins.inspect(buf, lang(req), { expect: { id, version }, origin: 'catalog' }) });
  } catch (e) { fail(req, res, e); }
});

module.exports = router;
