'use strict';

// Plugin platform — lifecycle facade (docs/plugins.md).
//
//   inspect(buffer)              upload → verify → checks (nothing written yet)
//   install(token, opts)         confirmed install or update of an inspected package
//   enable / disable / uninstall
//   setAllowUnsigned(on, confirm)
//   reconcile()                  start what may run, stop what may not
//   list / view / navEntries / portalTabs   for the UI
//   request / render             forward HTTP to a plugin process

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('./package');
const signature = require('./signature');
const manifestLib = require('./manifest');
const semver = require('./semver');
const registry = require('./registry');
const runtime = require('./runtime');
const storage = require('./storage');
const licensing = require('./licensing');
const { LIMITS, TIMEOUTS, pluginsRoot, codeDir, dataDir } = require('./constants');
const logger = require('../../utils/logger');

const K_ALLOW_UNSIGNED = 'plugins.allow_unsigned';
const CONFIRM_WORDS = new Set(['ERLAUBEN', 'ALLOW']);
const staging = new Map();
let timers = [];

class PluginError extends Error {
  constructor(code, message, extra) { super(message || code); this.code = code; Object.assign(this, extra || {}); }
}

function settings() { return require('../settings'); }
function activity() { return require('../activity'); }

function serverVersion() { return require('../../../package.json').version; }

function allowUnsigned() {
  try { return settings().get(K_ALLOW_UNSIGNED, '0') === '1'; } catch { return false; }
}

function loc(text, lang) { return manifestLib.loc(text, lang); }

// ─── Package checks ─────────────────────────────

function readManifest(files) {
  const buf = files.get('plugin.json');
  if (!buf) return { ok: false, errors: ['plugin.json: missing'] };
  if (buf.length > LIMITS.manifestBytes) return { ok: false, errors: ['plugin.json: too large'] };
  let raw;
  try { raw = JSON.parse(buf.toString('utf8')); } catch { return { ok: false, errors: ['plugin.json: not valid JSON'] }; }
  return manifestLib.validate(raw, { files: new Set(files.keys()) });
}

/**
 * Everything the install dialog shows, computed from a decoded package.
 * @returns {{manifest, sig, migrations, checks, blockers, existing}}
 */
function analyse(files) {
  const checks = [];
  const add = (key, status, code, params) => checks.push({ key, status, code, params: params || {} });
  const sig = signature.verify(files);
  const mres = readManifest(files);
  const manifest = mres.ok ? mres.manifest : null;

  if (sig.status === 'invalid') add('signature', 'fail', 'tampered');
  else if (sig.status === 'trusted') {
    add('signature', 'ok', 'trusted', { publisher: manifest ? manifest.publisher : '' });
    add('integrity', 'ok', 'unchanged');
  } else add('signature', allowUnsigned() ? 'warn' : 'fail', sig.status === 'untrusted' ? 'untrusted' : 'unsigned',
    { publisher: manifest ? manifest.publisher : '' });

  if (!manifest) {
    add('manifest', 'fail', 'invalid', { errors: mres.errors.slice(0, 10).join(', ') });
    return { manifest: null, sig, migrations: [], checks, blockers: checks.filter((c) => c.status === 'fail'), existing: null };
  }
  if (sig.status === 'trusted') manifest.license.server = null; // first-party licences come from the GateControl licence server
  else if (manifest.license.required && !manifest.license.server) add('license', 'fail', 'server_missing');

  let migrations = [];
  try {
    migrations = manifestLib.migrationsOf(manifest, files);
    if (migrations.some((m) => Buffer.byteLength(m.sql) > LIMITS.migrationBytes)) throw new Error('migration too large');
    const { checkSql } = require('./sqlGuard');
    const bad = migrations.find((m) => checkSql(m.sql));
    if (bad) throw new Error(`migration ${bad.version}_${bad.name}: ${checkSql(bad.sql)}`);
    if (migrations.length && !manifest.permissions.storage) throw new Error('migrations need permissions.storage');
  } catch (e) {
    add('migrations', 'fail', 'invalid', { error: e.message });
  }

  const ver = serverVersion();
  add('compatibility', semver.satisfies(ver, manifest.gatecontrol) ? 'ok' : 'fail', semver.satisfies(ver, manifest.gatecontrol) ? 'compatible' : 'incompatible',
    { required: manifest.gatecontrol, installed: ver });

  const existing = registry.get(manifest.id);
  if (!existing) add('existing', 'ok', 'new', { name: manifest.name.de });
  else if (existing.signature === 'trusted' && sig.status !== 'trusted') add('existing', 'fail', 'signed_to_unsigned', { version: existing.version });
  else {
    let cmp = 0;
    try { cmp = semver.compare(manifest.version, existing.version); } catch { cmp = 0; }
    add('existing', cmp < 0 ? 'warn' : 'ok', cmp > 0 ? 'update' : (cmp < 0 ? 'downgrade' : 'reinstall'), { from: existing.version, to: manifest.version });
  }
  if (!existing && fs.existsSync(dataDir(manifest.id))) add('data', 'ok', 'kept_data');

  return { manifest, sig, migrations, checks, blockers: checks.filter((c) => c.status === 'fail'), existing };
}

function permissionSummary(m, lang) {
  const p = m.permissions;
  return {
    network: require('./netPolicy').describe(p, lang),
    storage: p.storage, portal: p.portal, users: p.users, notify: p.notify,
    background: p.background ? p.background.intervalSeconds : null,
    pages: m.ui.pages.map((x) => loc(x.title, lang)), settings: m.ui.settings.length, portalTab: m.ui.portal ? loc(m.ui.portal.label, lang) : null,
  };
}

function cleanStaging() {
  const now = Date.now();
  for (const [k, v] of staging) if (now - v.at > LIMITS.stagingTtlMs) staging.delete(k);
  while (staging.size >= LIMITS.stagingMax) staging.delete(staging.keys().next().value);
}

/**
 * Step 1 of an install: read and check an uploaded package. Nothing is written.
 */
function inspect(buf, lang) {
  if (!Buffer.isBuffer(buf)) throw new PluginError('package_not_a_package', 'not a .gcplugin file');
  let files;
  try { files = pkg.decode(buf); } catch (e) {
    throw new PluginError(e.code ? 'package_' + e.code : 'package_corrupt', e.message);
  }
  const a = analyse(files);
  cleanStaging();
  const token = crypto.randomBytes(16).toString('hex');
  if (a.manifest) staging.set(token, { buf, at: Date.now() });
  const m = a.manifest;
  return {
    token: m && !a.blockers.length ? token : null,
    canInstall: !!m && !a.blockers.length,
    checks: a.checks,
    size: buf.byteLength,
    plugin: m ? {
      id: m.id, name: loc(m.name, lang), version: m.version, publisher: m.publisher, description: loc(m.description, lang),
      verified: a.sig.status === 'trusted', signature: a.sig.status,
      license: { required: m.license.required, kind: a.sig.status === 'trusted' ? 'first_party' : 'third_party', server: m.license.server },
      permissions: permissionSummary(m, lang),
      migrations: a.migrations.length,
    } : null,
    existing: a.existing ? { version: a.existing.version, enabled: a.existing.enabled } : null,
  };
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

/** Write the package files below `dir` (fresh folder; traversal-safe). */
function extract(files, dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const [rel, data] of files) {
    if (rel === signature.SIGNATURE_FILE) continue;
    pkg.checkPath(rel);
    const target = path.resolve(root, ...rel.split('/'));
    if (!target.startsWith(root + path.sep)) throw new PluginError('package_bad_path', 'path outside the plugin folder');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o644 });
  }
}

/**
 * Step 2: install (or update) a package inspected before.
 * @param {string} token   from inspect()
 * @param {{accept:boolean, licenseKey?:string, ip?:string}} opts
 */
async function install(token, opts = {}) {
  const st = typeof token === 'string' ? staging.get(token) : null;
  if (!st || Date.now() - st.at > LIMITS.stagingTtlMs) throw new PluginError('staging_expired', 'upload expired — upload the file again');
  if (opts.accept !== true) throw new PluginError('accept_required', 'the permissions must be accepted');
  const files = pkg.decode(st.buf);
  const a = analyse(files);
  if (!a.manifest || a.blockers.length) throw new PluginError('blocked', 'package can no longer be installed', { checks: a.checks });
  const m = a.manifest;
  const existing = a.existing;
  const finalDir = codeDir(m.id, m.version);
  const tmpDir = path.join(pluginsRoot(), m.id, `.tmp-${crypto.randomBytes(6).toString('hex')}`);

  if (existing) await runtime.ensureStopped(m.id);
  try {
    extract(files, tmpDir);
    fs.mkdirSync(dataDir(m.id), { recursive: true, mode: 0o700 });
    if (a.migrations.length) {
      await storage.forPlugin(m.id).call('migrate', { list: a.migrations.map(({ version, name, sql }) => ({ version, name, sql })) }, TIMEOUTS.db * 6);
    }
    if (fs.existsSync(finalDir)) rmrf(finalDir);
    fs.renameSync(tmpDir, finalDir);
  } catch (e) {
    rmrf(tmpDir);
    if (existing) await reconcile();
    throw e instanceof PluginError ? e : new PluginError('install_failed', e.message);
  }

  const plugin = registry.upsert({
    manifest: m,
    signature: a.sig.status === 'trusted' ? 'trusted' : (a.sig.status === 'untrusted' ? 'untrusted' : 'none'),
    signerKey: a.sig.publicKey || null,
    enabled: existing ? existing.enabled : true,
  });
  if (existing && existing.version !== m.version) rmrf(codeDir(m.id, existing.version));
  staging.delete(token);

  const verb = existing ? 'updated' : 'installed';
  registry.addLog(m.id, 'info', existing ? `updated ${existing.version} → ${m.version}` : `installed v${m.version}`);
  activity().log(`plugin_${verb}`, existing
    ? `Plugin "${plugin.name}" updated from ${existing.version} to ${m.version}`
    : `Plugin "${plugin.name}" ${m.version} installed`, {
    source: 'admin', ipAddress: opts.ip, severity: 'info',
    details: { plugin: m.id, version: m.version, verified: plugin.signature === 'trusted' },
  });

  let licenseError = null;
  if (opts.licenseKey && m.license.required) {
    try { await licensing.setKey(plugin, opts.licenseKey); } catch (e) { licenseError = e.code || 'license_failed'; }
  }
  await reconcile();
  return { plugin: registry.get(m.id), licenseError };
}

// ─── Running state ──────────────────────────────

/** Should this plugin run, and if not, why? */
function evaluate(plugin) {
  if (!plugin.manifest) return { run: false, reason: 'broken' };
  if (!plugin.enabled) return { run: false, reason: 'disabled' };
  if (!semver.satisfies(serverVersion(), plugin.manifest.gatecontrol)) return { run: false, reason: 'incompatible' };
  if (plugin.signature !== 'trusted' && !allowUnsigned()) return { run: false, reason: 'unsigned' };
  if (!fs.existsSync(path.join(codeDir(plugin.id, plugin.version), plugin.manifest.entry))) return { run: false, reason: 'files_missing' };
  const lic = licensing.status(plugin);
  if (!lic.licensed) return { run: false, reason: 'license', license: lic.state };
  return { run: true, reason: null };
}

let reconciling = Promise.resolve();

/** Start what may run, stop what may not. Serialised. */
function reconcile() {
  const run = async () => {
    let list;
    try { list = registry.list(); } catch { return; }
    for (const p of list) {
      const ev = evaluate(p);
      if (ev.reason !== p.statusReason) {
        registry.setStatusReason(p.id, ev.reason);
        if (p.enabled && ['license', 'unsigned', 'incompatible'].includes(ev.reason)) {
          registry.addLog(p.id, 'warn', `stopped: ${ev.reason}${ev.license ? ' (' + ev.license + ')' : ''}`);
          activity().log('plugin_suspended', `Plugin "${p.name}" is off: ${ev.reason}`, { source: 'system', severity: 'warning', details: { plugin: p.id, reason: ev.reason } });
        }
      }
      try {
        if (ev.run) await runtime.ensureRunning(p);
        else await runtime.ensureStopped(p.id);
      } catch (e) {
        logger.warn({ plugin: p.id, err: e.message }, 'plugin reconcile failed');
      }
    }
  };
  reconciling = reconciling.then(run, run);
  return reconciling;
}

async function setEnabled(id, on, { ip } = {}) {
  const p = registry.get(id);
  if (!p) throw new PluginError('not_found', 'plugin not installed');
  registry.setEnabled(id, on);
  activity().log(on ? 'plugin_enabled' : 'plugin_disabled', `Plugin "${p.name}" ${on ? 'enabled' : 'disabled'}`, {
    source: 'admin', ipAddress: ip, severity: on ? 'info' : 'warning', details: { plugin: id },
  });
  registry.addLog(id, 'info', on ? 'enabled by an administrator' : 'disabled by an administrator');
  await reconcile();
  return registry.get(id);
}

function nameMatches(p, confirm) {
  const c = typeof confirm === 'string' ? confirm.trim() : '';
  const n = p.manifest && p.manifest.name ? p.manifest.name : { de: p.name, en: p.name };
  return !!c && (c === n.de || c === n.en || c === p.name);
}

/**
 * @param {'keep'|'wipe'} mode  keep: data stays for a reinstall; wipe: data, settings and licence are deleted
 * @param {string} confirm      for 'wipe': the plugin's name, typed by the administrator
 */
async function uninstall(id, { mode, confirm, ip } = {}) {
  const p = registry.get(id);
  if (!p) throw new PluginError('not_found', 'plugin not installed');
  if (mode !== 'keep' && mode !== 'wipe') throw new PluginError('invalid_mode', 'mode must be keep or wipe');
  if (mode === 'wipe' && !nameMatches(p, confirm)) throw new PluginError('confirm_mismatch', 'type the plugin name to confirm');
  await runtime.ensureStopped(id);
  await storage.close(id);
  rmrf(path.join(pluginsRoot(), id));
  registry.remove(id);
  if (mode === 'wipe') {
    rmrf(dataDir(id));
    registry.removeLicense(id);
    require('./targets').removeAll(id);
  }
  activity().log('plugin_uninstalled', `Plugin "${p.name}" uninstalled (${mode === 'wipe' ? 'data deleted' : 'data kept'})`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { plugin: id, mode },
  });
}

async function setAllowUnsigned(on, { confirm, ip } = {}) {
  if (on && !CONFIRM_WORDS.has(typeof confirm === 'string' ? confirm.trim() : '')) throw new PluginError('confirm_mismatch', 'type ERLAUBEN to confirm');
  settings().set(K_ALLOW_UNSIGNED, on ? '1' : '0');
  activity().log(on ? 'plugin_unsigned_allowed' : 'plugin_unsigned_blocked',
    on ? 'Unsigned plugins allowed' : 'Unsigned plugins no longer allowed — unsigned plugins are switched off', {
      source: 'admin', ipAddress: ip, severity: on ? 'warning' : 'info',
    });
  await reconcile();
}

async function setLicenseKey(id, key) {
  const p = registry.get(id);
  if (!p) throw new PluginError('not_found', 'plugin not installed');
  let st;
  try { st = await licensing.setKey(p, key); } catch (e) { throw new PluginError(e.code || 'license_failed', e.message); }
  registry.addLog(id, 'info', `licence entered: ${st.state}`);
  await reconcile();
  return st;
}

async function checkLicense(id) {
  const p = registry.get(id);
  if (!p) throw new PluginError('not_found', 'plugin not installed');
  let st;
  if (licensing.kindOf(p) === 'third_party') st = await licensing.checkThirdParty(p);
  else {
    await Promise.race([Promise.resolve(require('../license').refreshLicenseInBackground()).catch(() => {}), new Promise((r) => { const t = setTimeout(r, 20000); t.unref(); })]);
    st = licensing.status(p);
  }
  registry.addLog(id, 'info', `licence checked: ${st.state}`);
  await reconcile();
  return st;
}

// ─── Views ──────────────────────────────────────

function statusOf(p, ev, proc) {
  if (ev.run) {
    if (proc.state === 'running') return 'running';
    if (proc.state === 'crashed') return 'crashed';
    return 'starting';
  }
  return ev.reason === 'disabled' ? 'disabled' : 'blocked';
}

function view(p, lang) {
  const m = p.manifest || { name: { de: p.name, en: p.name }, description: {}, permissions: {}, ui: { pages: [], settings: [] }, license: {} };
  const ev = evaluate(p);
  const proc = runtime.info(p.id);
  return {
    id: p.id,
    name: loc(m.name, lang) || p.name,
    names: m.name,
    version: p.version,
    publisher: p.publisher,
    description: loc(m.description, lang),
    verified: p.signature === 'trusted',
    signature: p.signature,
    enabled: p.enabled,
    status: statusOf(p, ev, proc),
    reason: ev.reason,
    process: proc,
    license: licensing.status(p),
    requires: m.gatecontrol,
    compatible: !!m.gatecontrol && semver.satisfies(serverVersion(), m.gatecontrol),
    permissions: m.permissions ? permissionSummary(m, lang) : null,
    nav: m.ui && m.ui.nav ? { label: loc(m.ui.nav.label, lang), icon: m.ui.nav.icon } : null,
    pages: (m.ui && m.ui.pages ? m.ui.pages : []).map((x) => ({ id: x.id, title: loc(x.title, lang) })),
    portal: m.ui && m.ui.portal ? { label: loc(m.ui.portal.label, lang) } : null,
    settingsCount: m.ui && m.ui.settings ? m.ui.settings.length : 0,
    installedAt: p.installedAt,
    updatedAt: p.updatedAt,
  };
}

function list(lang) {
  return registry.list().map((p) => view(p, lang));
}

function get(id) { return registry.get(id); }

function storageBytes(id) { return storage.usage(dataDir(id)); }

/** Sidebar entries: every installed plugin with a nav entry; `on` = running. */
function navEntries(lang) {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return rows.filter((p) => p.manifest && p.manifest.ui && p.manifest.ui.nav).map((p) => {
    const ev = evaluate(p);
    return { id: p.id, label: loc(p.manifest.ui.nav.label, lang), icon: p.manifest.ui.nav.icon, href: '/plugins/' + p.id, on: ev.run };
  });
}

/** Portal tabs of running plugins with the portal permission. */
function portalTabs(lang) {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return rows.filter((p) => p.manifest && p.manifest.permissions && p.manifest.permissions.portal && p.manifest.ui && p.manifest.ui.portal)
    .filter((p) => evaluate(p).run && runtime.info(p.id).state === 'running')
    .map((p) => ({ id: p.id, key: 'plg-' + p.id, label: loc(p.manifest.ui.portal.label, lang), icon: p.manifest.ui.portal.icon }));
}

function boundJson(v) {
  let s;
  try { s = JSON.stringify(v === undefined ? null : v); } catch { return { ok: false }; }
  if (s.length > LIMITS.responseBytes) return { ok: false };
  return { ok: true, value: JSON.parse(s) };
}

/**
 * Forward one API request to a plugin. `req` is a plain object built by the
 * route after the host's own auth/CSRF/rate limiting.
 * @returns {Promise<{status:number, json:any}>}
 */
async function request(id, req) {
  const out = await runtime.call(id, 'request', req, TIMEOUTS.request);
  const status = out && Number.isInteger(out.status) && out.status >= 200 && out.status <= 599 ? out.status : 200;
  const body = boundJson(out && out.json !== undefined ? out.json : null);
  if (!body.ok) throw new PluginError('response_too_large', 'plugin answer too large');
  return { status, json: body.value };
}

/** Render a page/portal fragment: { html } (untrusted — served sandboxed only). */
async function render(id, viewReq) {
  const out = await runtime.call(id, 'render', viewReq, TIMEOUTS.request);
  const html = out && typeof out.html === 'string' ? out.html : '';
  if (Buffer.byteLength(html) > LIMITS.responseBytes) throw new PluginError('response_too_large', 'plugin page too large');
  return { html };
}

async function settingsChanged(id) {
  const p = registry.get(id);
  if (!p || runtime.info(id).state !== 'running') return;
  try { await runtime.call(id, 'settingsChanged', await require('./pluginSettings').forPlugin(p), TIMEOUTS.request); } catch { /* plugin may not care */ }
}

// ─── Boot / shutdown ────────────────────────────

async function checkThirdPartyLicences() {
  for (const p of registry.list()) {
    if (p.manifest && p.manifest.license && p.manifest.license.required && licensing.kindOf(p) === 'third_party') {
      try { await licensing.checkThirdParty(p); } catch { /* recorded as unreachable */ }
    }
  }
  await reconcile();
}

function start() {
  if (timers.length) return;
  fs.mkdirSync(pluginsRoot(), { recursive: true });
  reconcile().catch((e) => logger.warn({ err: e.message }, 'plugin start failed'));
  // licence states change in the background (daily licence refresh, expiry): look every 5 minutes
  timers.push(setInterval(() => reconcile().catch(() => {}), 5 * 60 * 1000));
  timers.push(setInterval(() => checkThirdPartyLicences().catch(() => {}), 24 * 60 * 60 * 1000));
  setTimeout(() => checkThirdPartyLicences().catch(() => {}), 60 * 1000).unref();
  for (const t of timers) t.unref();
}

async function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  await runtime.stopAll();
  await storage.closeAll();
}

module.exports = {
  PluginError, inspect, install, evaluate, reconcile, setEnabled, uninstall, setAllowUnsigned, allowUnsigned,
  setLicenseKey, checkLicense, list, view, get, navEntries, portalTabs, request, render, settingsChanged, storageBytes,
  serverVersion, start, stop, extract,
  _staging: staging,
};
