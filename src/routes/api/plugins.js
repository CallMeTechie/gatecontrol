'use strict';

// Admin API of the plugin platform (docs/plugins.md), mounted at
// /api/v1/plugins behind requireAuth + apiLimiter + CSRF + requireAdmin
// (routes/api/index.js). Session only: an API token cannot install code.
//
//   GET    /                       installed plugins + policy
//   PUT    /policy                 { allowUnsigned, confirm: 'ERLAUBEN' }
//   POST   /inspect                the .gcplugin (application/octet-stream) → checks + token
//   POST   /install                { token, accept: true, licenseKey? }
//   GET    /:id                    one plugin (+ storage size)
//   GET    /:id/logs
//   GET    /:id/settings           declared settings + values (secrets only as set/unset)
//   PUT    /:id/settings           { values }
//   POST   /:id/enable | /:id/disable
//   POST   /:id/uninstall          { mode: 'keep'|'wipe', confirm: <name> for wipe }
//   PUT    /:id/license            { key }
//   GET    /:id/targets            declared home targets, assignments, route/peer choices
//   PUT    /:id/targets/:target    { assigned: [{ kind: route|peer|host, … }] }
//   PUT    /:id/discovery          { granted } (localDiscovery)
//   POST   /:id/license/check
//   *      /:id/api/<path>         forwarded to the plugin (its own admin API)

const express = require('express');
const { Router } = express;
const plugins = require('../../services/plugins');
const pluginSettings = require('../../services/plugins/pluginSettings');
const { loc } = require('../../services/plugins/manifest');
const { ID_RE, LIMITS } = require('../../services/plugins/constants');
const { pluginApiLimiter, uploadLimiter } = require('../../middleware/rateLimit');
const logger = require('../../utils/logger');

const router = Router();

router.use(pluginApiLimiter);
router.use((req, res, next) => {
  if (req.tokenAuth || !req.session || !req.session.userId) return res.status(403).json({ ok: false, error: 'session_required' });
  next();
});

const STATUS = { not_found: 404, staging_expired: 410, blocked: 409, confirm_mismatch: 400, accept_required: 400, invalid_mode: 400 };

function lang(req) { return req.language === 'en' ? 'en' : 'de'; }

function tr(req, key, fallback) {
  const s = req.t ? req.t(key) : key;
  return s && s !== key ? s : fallback;
}

function fail(req, res, err) {
  const code = (err && err.code) || 'internal';
  if (!err || !err.code) logger.error({ err: err && err.message }, 'plugin API failed');
  const status = STATUS[code] || (/^package_/.test(code) ? 400 : (code === 'internal' || code === 'install_failed' ? 500 : 400));
  const body = { ok: false, code, error: tr(req, 'plugins.err.' + code, tr(req, 'plugins.err.generic', 'Plugin action failed')) };
  if (err && err.checks) body.checks = err.checks;
  return res.status(status).json(body);
}

function pluginParam(req, res) {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id) || id.length > 64) { res.status(404).json({ ok: false, code: 'not_found', error: tr(req, 'plugins.err.not_found', 'Plugin not found') }); return null; }
  const p = plugins.get(id);
  if (!p) { res.status(404).json({ ok: false, code: 'not_found', error: tr(req, 'plugins.err.not_found', 'Plugin not found') }); return null; }
  return p;
}

function currentUser(req) {
  const u = require('../../services/users').getById(req.session.userId);
  return u ? { id: u.id, name: u.display_name || u.username, role: u.role } : null;
}

router.get('/', (req, res) => {
  try {
    res.json({ ok: true, allowUnsigned: plugins.allowUnsigned(), serverVersion: plugins.serverVersion(), plugins: plugins.list(lang(req)) });
  } catch (e) { fail(req, res, e); }
});

router.put('/policy', async (req, res) => {
  const on = req.body && req.body.allowUnsigned;
  if (typeof on !== 'boolean') return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
  try {
    await plugins.setAllowUnsigned(on, { confirm: req.body.confirm, ip: req.ip });
    res.json({ ok: true, allowUnsigned: plugins.allowUnsigned(), plugins: plugins.list(lang(req)) });
  } catch (e) { fail(req, res, e); }
});

const rawPackage = express.raw({ type: 'application/octet-stream', limit: LIMITS.packageBytes });

router.post('/inspect', uploadLimiter, (req, res, next) => {
  rawPackage(req, res, (err) => {
    if (err) {
      const code = err.type === 'entity.too.large' ? 'package_too_large' : 'package_corrupt';
      return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ ok: false, code, error: tr(req, 'plugins.err.' + code, 'Invalid package') });
    }
    next();
  });
}, (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, code: 'package_not_a_package', error: tr(req, 'plugins.err.package_not_a_package', 'Not a plugin package') });
  try {
    res.json({ ok: true, ...plugins.inspect(req.body, lang(req)) });
  } catch (e) { fail(req, res, e); }
});

router.post('/install', async (req, res) => {
  const b = req.body || {};
  if (typeof b.token !== 'string' || !/^[0-9a-f]{32}$/.test(b.token)) return res.status(400).json({ ok: false, code: 'staging_expired', error: tr(req, 'plugins.err.staging_expired', 'Upload expired') });
  if (b.licenseKey != null && typeof b.licenseKey !== 'string') return res.status(400).json({ ok: false, code: 'invalid_key', error: tr(req, 'plugins.err.invalid_key', 'Invalid licence key') });
  try {
    const r = await plugins.install(b.token, { accept: b.accept === true, licenseKey: b.licenseKey ? b.licenseKey.trim() : null, ip: req.ip });
    res.json({ ok: true, plugin: plugins.view(r.plugin, lang(req)), licenseError: r.licenseError });
  } catch (e) { fail(req, res, e); }
});

router.get('/:id', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  res.json({ ok: true, plugin: { ...plugins.view(p, lang(req)), storageBytes: plugins.storageBytes(p.id) } });
});

router.get('/:id/logs', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  res.json({ ok: true, logs: require('../../services/plugins/registry').logs(p.id, 200) });
});

router.get('/:id/settings', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    const l = lang(req);
    const defs = pluginSettings.defsOf(p).map((d) => ({
      key: d.key, type: d.type, label: loc(d.label, l), help: d.help ? loc(d.help, l) : '', min: d.min ?? null, max: d.max ?? null,
      options: d.options ? d.options.map((o) => ({ value: o.value, label: loc(o.label, l) })) : null,
    }));
    res.json({ ok: true, defs, values: defs.length ? await pluginSettings.forUi(p) : {} });
  } catch (e) { fail(req, res, e); }
});

router.put('/:id/settings', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    const r = await pluginSettings.save(p, req.body && req.body.values);
    if (!r.ok) return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request'), fields: r.fields });
    require('../../services/plugins/registry').addLog(p.id, 'info', 'settings changed by an administrator');
    plugins.settingsChanged(p.id).catch(() => {});
    res.json({ ok: true, values: await pluginSettings.forUi(p) });
  } catch (e) { fail(req, res, e); }
});

for (const [action, on] of [['enable', true], ['disable', false]]) {
  router.post(`/:id/${action}`, async (req, res) => {
    const p = pluginParam(req, res);
    if (!p) return;
    try {
      const after = await plugins.setEnabled(p.id, on, { ip: req.ip });
      res.json({ ok: true, plugin: plugins.view(after, lang(req)) });
    } catch (e) { fail(req, res, e); }
  });
}

router.post('/:id/uninstall', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    await plugins.uninstall(p.id, { mode: req.body && req.body.mode, confirm: req.body && req.body.confirm, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { fail(req, res, e); }
});

router.put('/:id/license', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  const key = req.body && req.body.key;
  if (typeof key !== 'string') return res.status(400).json({ ok: false, code: 'invalid_key', error: tr(req, 'plugins.err.invalid_key', 'Invalid licence key') });
  try {
    const st = await plugins.setLicenseKey(p.id, key);
    res.json({ ok: true, license: st, plugin: plugins.view(plugins.get(p.id), lang(req)) });
  } catch (e) { fail(req, res, e); }
});

router.post('/:id/license/check', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    const st = await plugins.checkLicense(p.id);
    res.json({ ok: true, license: st, plugin: plugins.view(plugins.get(p.id), lang(req)) });
  } catch (e) { fail(req, res, e); }
});

// ─── Home-network targets (Zugriffsziele) ───────

const targets = require('../../services/plugins/targets');

router.get('/:id/targets', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  const l = lang(req);
  const as = targets.assignments(p.id);
  const decl = targets.discoveryDecl(p);
  res.json({
    ok: true,
    declared: targets.declared(p).map((t) => ({ id: t.id, label: loc(t.label, l), protocols: t.protocols, multiple: t.multiple,
      assigned: (as[t.id] || []).map((a) => ({ ...a, display: targets.display(a) })) })),
    discovery: decl ? { udp: decl.udp, granted: targets.discoveryGranted(p.id) } : null,
    choices: targets.choices(),
  });
});

router.put('/:id/targets/:target', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  const list = req.body && req.body.assigned;
  try {
    const out = targets.assign(p, String(req.params.target), list);
    const reg = require('../../services/plugins/registry');
    reg.addLog(p.id, 'info', `access target "${req.params.target}" set by an administrator: ${out.map(targets.display).join(', ') || '—'}`);
    require('../../services/activity').log('plugin_target_changed', `Plugin "${p.name}": access target "${req.params.target}" ${out.length ? 'assigned' : 'removed'}`, {
      source: 'admin', ipAddress: req.ip, severity: 'info', details: { plugin: p.id, target: req.params.target, assigned: out },
    });
    res.json({ ok: true, assigned: out.map((a) => ({ ...a, display: targets.display(a) })) });
  } catch (e) {
    if (e instanceof targets.TargetError) return res.status(400).json({ ok: false, code: e.code, error: tr(req, 'plugins.err.target_' + e.code, tr(req, 'plugins.err.invalid', 'Invalid request')) });
    fail(req, res, e);
  }
});

router.put('/:id/discovery', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  const on = req.body && req.body.granted;
  if (typeof on !== 'boolean' || !targets.discoveryDecl(p)) return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
  targets.setDiscovery(p.id, on);
  require('../../services/activity').log('plugin_target_changed', `Plugin "${p.name}": local discovery ${on ? 'granted' : 'revoked'}`, {
    source: 'admin', ipAddress: req.ip, severity: on ? 'warning' : 'info', details: { plugin: p.id, discovery: on },
  });
  res.json({ ok: true, granted: on });
});

// ─── Forwarded to the plugin ────────────────────

const FORWARD_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Query string as a small plain object of strings. */
function plainQuery(q) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(q || {})) {
    if (typeof v !== 'string' || k.length > 100 || v.length > 2000) continue;
    out[k] = v;
    if (++n >= 50) break;
  }
  return out;
}

function forwardPath(raw) {
  const p = '/' + String(raw || '').replace(/^\/+/, '');
  if (p.length > 1000 || !/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(p) || p.split('/').some((s) => s === '..')) return null;
  return p;
}

/**
 * Express handler factory: forward to a plugin's own API. `userOf(req)`
 * returns the acting user ({ id, name, role, portal }) or null (→ 403).
 */
function forwarder(userOf, idOf = (req) => req.params.id) {
  return async (req, res) => {
    const id = String(idOf(req) || '');
    const p = ID_RE.test(id) ? plugins.get(id) : null;
    if (!p) return res.status(404).json({ ok: false, code: 'not_found', error: tr(req, 'plugins.err.not_found', 'Plugin not found') });
    if (!FORWARD_METHODS.has(req.method)) return res.status(405).json({ ok: false, code: 'method' });
    const path = forwardPath(req.params[0]);
    if (!path) return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
    const user = userOf(req);
    if (!user) return res.status(403).json({ ok: false, code: 'login_required', error: tr(req, 'plugins.err.login_required', 'Sign in first') });
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null;
    try {
      const out = await plugins.request(p.id, { method: req.method, path, query: plainQuery(req.query), body, user, lang: lang(req) });
      res.set('Cache-Control', 'no-store');
      return res.status(out.status).json(out.json);
    } catch (e) {
      const code = e && e.code === 'ERR_NOT_RUNNING' ? 'not_running' : (e && e.code === 'ERR_TIMEOUT' ? 'timeout' : 'plugin_error');
      return res.status(code === 'not_running' ? 503 : 502).json({ ok: false, code, error: tr(req, 'plugins.err.' + code, 'Plugin unavailable') });
    }
  };
}

router.all('/:id/api/*', forwarder((req) => currentUser(req)));

module.exports = router;
module.exports.forwarder = forwarder;
