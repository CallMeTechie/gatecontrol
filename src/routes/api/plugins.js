'use strict';

// Admin API of the plugin platform (docs/plugins.md), mounted at
// /api/v1/plugins behind requireAuth + apiLimiter + CSRF + requireAdmin
// (routes/api/index.js). Session only: an API token cannot install code.
//
//   GET    /                       installed plugins + policy (allowUnsigned, backupMedia, autoUpdate, catalogCheck)
//   PUT    /policy                 { allowUnsigned, confirm: 'ERLAUBEN' } and/or { backupMedia } and/or
//                                  { autoUpdate: 'off'|'patch'|'all' } and/or { catalogCheck }
//   GET    /history                the last installs, updates and uninstalls
//   GET    /contributions          per plugin: quick actions and widgets it lists for this administrator
//   POST   /license-key            { key } a first-party key without naming the plugin
//   POST   /inspect                the .gcplugin (application/octet-stream) → checks + token
//   POST   /install                { token, accept: true, licenseKey? }
//   GET    /:id                    one plugin (+ storage size)
//   GET    /:id/logs
//   GET    /:id/settings           declared settings + values (secrets only as set/unset)
//   PUT    /:id/settings           { values }
//   POST   /:id/enable | /:id/disable | /:id/restart
//   POST   /:id/uninstall          { mode: 'keep'|'wipe', confirm: <name> for wipe }
//   PUT    /:id/license            { key }
//   GET    /:id/targets            declared home targets, assignments, route/peer choices
//   PUT    /:id/targets/:target    { assigned: [{ kind: route|peer|host, … }] }
//   PUT    /:id/discovery          { granted } (localDiscovery)
//   POST   /:id/license/check
//   GET    /:id/legacy             built-in data this plugin may import (null if none)
//   POST   /:id/legacy/import      { confirm: true } hand the built-in data over to the plugin
//   GET    /:id/media/settings     plugin.json `media`: limits, quota, usage
//   PUT    /:id/media/settings     { quotaBytes } (null = the declared default)
//   PUT    /:id/media              an upload of the plugin's admin frame (GC.upload, raw body)
//   GET    /:id/events             SSE: the plugin's realtime events for this administrator
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

const media = require('../../services/plugins/media');

function policy() {
  return { allowUnsigned: plugins.allowUnsigned(), backupMedia: media.backupEnabled(), autoUpdate: plugins.autoUpdateMode(), catalogCheck: plugins.catalogCheck() };
}

router.get('/', (req, res) => {
  try {
    res.json({ ok: true, ...policy(), serverVersion: plugins.serverVersion(), plugins: plugins.list(lang(req)) });
  } catch (e) { fail(req, res, e); }
});

router.get('/history', (req, res) => {
  res.json({ ok: true, history: plugins.history() });
});

// What the plugins add to the apps right now (the plugin area's "Was … hinzufügt"):
// the quick actions each plugin lists for this administrator, those with a widget.
router.get('/contributions', async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(403).json({ ok: false, code: 'login_required' });
  try {
    const all = await require('../../services/plugins/quickActions').list({ ...u, portal: true, loggedIn: true, app: true }, lang(req));
    const counts = {};
    for (const a of all) {
      const c = counts[a.plugin] || (counts[a.plugin] = { actions: 0, widgets: 0 });
      c.actions += 1;
      if (a.widget) c.widgets += 1;
    }
    res.json({ ok: true, counts });
  } catch (e) { fail(req, res, e); }
});

router.post('/license-key', async (req, res) => {
  const key = req.body && req.body.key;
  if (typeof key !== 'string') return res.status(400).json({ ok: false, code: 'invalid_key', error: tr(req, 'plugins.err.invalid_key', 'Invalid licence key') });
  try {
    const r = await plugins.assignLicenseKey(key, { ip: req.ip });
    res.json({ ok: true, ...r, plugins: plugins.list(lang(req)) });
  } catch (e) { fail(req, res, e); }
});

router.put('/policy', async (req, res) => {
  const b = req.body || {};
  const on = b.allowUnsigned;
  const bm = b.backupMedia;
  const au = b.autoUpdate;
  const cc = b.catalogCheck;
  if ((on !== undefined && typeof on !== 'boolean') || (bm !== undefined && typeof bm !== 'boolean')
    || (au !== undefined && !['off', 'patch', 'all'].includes(au)) || (cc !== undefined && typeof cc !== 'boolean')
    || (on === undefined && bm === undefined && au === undefined && cc === undefined)) {
    return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
  }
  try {
    if (au !== undefined) plugins.setAutoUpdate(au, { ip: req.ip });
    if (cc !== undefined) plugins.setCatalogCheck(cc, { ip: req.ip });
    if (on !== undefined) await plugins.setAllowUnsigned(on, { confirm: b.confirm, ip: req.ip });
    // "Plugin-Medien im Backup" (docs/plugins.md "Backup"): off by default
    if (bm !== undefined && bm !== media.backupEnabled()) {
      media.setBackupEnabled(bm);
      require('../../services/activity').log('plugin_media_backup', bm ? 'Plugin media are included in backups' : 'Plugin media are no longer included in backups', {
        source: 'admin', ipAddress: req.ip, severity: 'info', details: { backupMedia: bm },
      });
    }
    res.json({ ok: true, ...policy(), plugins: plugins.list(lang(req)) });
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
  if (!Buffer.isBuffer(req.body) || !req.body.byteLength) return res.status(400).json({ ok: false, code: 'package_not_a_package', error: tr(req, 'plugins.err.package_not_a_package', 'Not a plugin package') });
  try {
    res.json({ ok: true, ...plugins.inspect(req.body, lang(req)) });
  } catch (e) { fail(req, res, e); }
});

router.post('/install', async (req, res) => {
  const b = req.body || {};
  if (typeof b.token !== 'string' || !/^[0-9a-f]{32}$/.test(b.token)) return res.status(400).json({ ok: false, code: 'staging_expired', error: tr(req, 'plugins.err.staging_expired', 'Upload expired') });
  if (b.licenseKey != null && typeof b.licenseKey !== 'string') return res.status(400).json({ ok: false, code: 'invalid_key', error: tr(req, 'plugins.err.invalid_key', 'Invalid licence key') });
  try {
    const u = currentUser(req);
    const r = await plugins.install(b.token, { accept: b.accept === true, licenseKey: b.licenseKey ? b.licenseKey.trim() : null, ip: req.ip, user: u ? u.name : null });
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
      key: d.key, type: d.type, label: loc(d.label, l), help: d.help ? loc(d.help, l) : '', min: d.min ?? null, max: d.max ?? null, group: d.group || null,
      options: d.options ? d.options.map((o) => ({ value: o.value, label: loc(o.label, l) })) : null,
    }));
    const groups = ((p.manifest.ui && p.manifest.ui.settingsGroups) || []).map((g) => ({ id: g.id, label: loc(g.label, l), help: g.help ? loc(g.help, l) : '' }));
    res.json({ ok: true, defs, groups, values: defs.length ? await pluginSettings.forUi(p) : {}, status: await plugins.settingsStatus(p.id, l) });
  } catch (e) { fail(req, res, e); }
});

router.put('/:id/settings', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    const r = await pluginSettings.save(p, req.body && req.body.values);
    if (!r.ok) return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request'), fields: r.fields });
    require('../../services/plugins/registry').addLog(p.id, 'info', 'settings changed by an administrator');
    // wait (up to 20 s) so the status lines show the outcome — e.g. the sign-in to an account
    await plugins.settingsChanged(p.id, { timeoutMs: 20000 }).catch(() => {});
    res.json({ ok: true, values: await pluginSettings.forUi(p), status: await plugins.settingsStatus(p.id, lang(req)) });
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

router.post('/:id/restart', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    const after = await plugins.restart(p.id, { ip: req.ip });
    res.json({ ok: true, plugin: plugins.view(after, lang(req)) });
  } catch (e) { fail(req, res, e); }
});

router.post('/:id/uninstall', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    const u = currentUser(req);
    await plugins.uninstall(p.id, { mode: req.body && req.body.mode, confirm: req.body && req.body.confirm, ip: req.ip, user: u ? u.name : null });
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

// ─── Public links (permissions.publicLinks, services/plugins/publicLinks.js, since 1.193.0) ─
// The administrator's switch per plugin (default off), shown on the plugin's
// Berechtigungen tab: { allowed, publicUrl (the base links are built on, or
// null), active (links that work now) }.

const publicLinks = require('../../services/plugins/publicLinks');

function publicLinksView(p) {
  return { allowed: publicLinks.allowed(p.id), publicUrl: publicLinks.publicBase(), active: publicLinks.activeCount(p.id) };
}

router.get('/:id/public-links', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  if (!publicLinks.declared(p)) return res.status(404).json({ ok: false, code: 'not_declared', error: tr(req, 'plugins.err.not_found', 'Plugin not found') });
  res.json({ ok: true, publicLinks: publicLinksView(p) });
});

router.put('/:id/public-links', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  const on = req.body && req.body.allowed;
  if (!publicLinks.declared(p) || typeof on !== 'boolean') return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
  publicLinks.setAllowed(p.id, on);
  require('../../services/plugins/registry').addLog(p.id, 'info', `public links ${on ? 'allowed' : 'switched off'} by an administrator`);
  require('../../services/activity').log('plugin_public_links', `Plugin "${p.name}": public links ${on ? 'allowed' : 'switched off'}`, {
    source: 'admin', ipAddress: req.ip, severity: on ? 'warning' : 'info', details: { plugin: p.id, allowed: on },
  });
  res.json({ ok: true, publicLinks: publicLinksView(p) });
});

// ─── Built-in data import (first-party plugins of former built-in features) ─

const legacy = require('../../services/plugins/legacy');

router.get('/:id/legacy', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  try {
    res.json({ ok: true, legacy: legacy.status(p) });
  } catch (e) { fail(req, res, e); }
});

router.post('/:id/legacy/import', async (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
  try {
    const out = await legacy.runImport(p.id, { ip: req.ip });
    res.json({ ok: true, counts: out.counts, targetsAdded: out.targetsAdded, legacy: legacy.status(plugins.get(p.id)) });
  } catch (e) {
    if (e instanceof legacy.LegacyError) {
      const status = e.code === 'not_found' ? 404 : (e.code === 'legacy_failed' ? 502 : 409);
      return res.status(status).json({ ok: false, code: e.code, error: tr(req, 'plugins.err.' + e.code, tr(req, 'plugins.err.generic', 'Plugin action failed')) });
    }
    fail(req, res, e);
  }
});

// ─── Media (plugin.json `media`, services/plugins/media.js) ─────

function mediaView(p) {
  const decl = media.declOf(p);
  return { maxBytes: decl.maxBytes, types: decl.types, quotaDefault: decl.quotaDefault, quota: media.quotaOf(p), usage: media.usage(p.id) };
}

router.get('/:id/media/settings', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  if (!media.declOf(p)) return res.status(404).json({ ok: false, code: 'no_media', error: tr(req, 'plugins.err.not_found', 'Plugin not found') });
  res.json({ ok: true, media: mediaView(p) });
});

router.put('/:id/media/settings', (req, res) => {
  const p = pluginParam(req, res);
  if (!p) return;
  if (!media.declOf(p)) return res.status(404).json({ ok: false, code: 'no_media', error: tr(req, 'plugins.err.not_found', 'Plugin not found') });
  const q = req.body ? req.body.quotaBytes : undefined;
  try {
    media.setQuota(p, q === undefined ? NaN : q);
  } catch {
    return res.status(400).json({ ok: false, code: 'invalid', error: tr(req, 'plugins.err.invalid', 'Invalid request') });
  }
  const view = mediaView(p);
  require('../../services/plugins/registry').addLog(p.id, 'info', `media quota set by an administrator: ${q === null ? 'default' : view.quota + ' bytes'}`);
  require('../../services/activity').log('plugin_media_quota', `Plugin "${p.name}": media quota ${q === null ? 'reset to the default' : 'changed'}`, {
    source: 'admin', ipAddress: req.ip, severity: 'info', details: { plugin: p.id, quota: view.quota },
  });
  res.json({ ok: true, media: view });
});

/** The plugin of an admin frame request: installed, may run, running. */
function runningPlugin(req, res) {
  const p = pluginParam(req, res);
  if (!p) return null;
  if (!plugins.evaluate(p).run || require('../../services/plugins/runtime').info(p.id).state !== 'running') {
    res.status(503).json({ ok: false, code: 'not_running', error: tr(req, 'plugins.err.not_running', 'Plugin unavailable') });
    return null;
  }
  return p;
}

router.put('/:id/media', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const p = runningPlugin(req, res);
  if (!p) return undefined;
  if (!media.declOf(p)) return res.status(404).json({ ok: false, code: 'not_found', error: tr(req, 'plugins.err.not_found', 'Plugin not found') });
  const user = currentUser(req);
  if (!user) return res.status(403).json({ ok: false, code: 'login_required' });
  try {
    return res.json({ ok: true, ...(await media.upload(p, user.id, req)) });
  } catch (e) { return media.failure(res, e); }
});

// ─── Realtime events (permissions.events, services/plugins/events.js) ────
router.get('/:id/events', (req, res) => {
  const p = runningPlugin(req, res);
  if (!p) return undefined;
  if (!p.manifest.permissions || !p.manifest.permissions.events) return res.status(404).json({ ok: false, code: 'not_found' });
  return require('../../services/plugins/events').openStream(req, res, p.id, req.session.userId);
});

// ─── Forwarded to the plugin ────────────────────

const FORWARD_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Query string as a small plain object of strings. */
const QUERY_KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function plainQuery(q) {
  const out = new Map();
  let n = 0;
  for (const [k, v] of Object.entries(q || {})) {
    if (typeof k !== 'string' || !QUERY_KEY_RE.test(k) || FORBIDDEN_KEYS.has(k)) continue;
    if (typeof v !== 'string' || v.length > 2000) continue;
    out.set(k, v);
    if (++n >= 50) break;
  }
  return Object.fromEntries(out);
}

function forwardPath(raw) {
  const p = '/' + String(raw || '').replace(/^\/+/, '');
  if (p.length > 1000 || !/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(p) || p.split('/').some((s) => s === '..')) return null;
  return p;
}

/**
 * Express handler factory: forward to a plugin's own API. `userOf(req)`
 * returns the acting user ({ id, name, role, portal }) or null (→ 403).
 * `opts.langOf(req)` picks the language handed to the plugin (default: the
 * request's UI language).
 */
function forwarder(userOf, idOf = (req) => req.params.id, opts = {}) {
  const langOf = typeof opts.langOf === 'function' ? opts.langOf : lang;
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
      const out = await plugins.request(p.id, { method: req.method, path, query: plainQuery(req.query), body, user, lang: langOf(req) });
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
