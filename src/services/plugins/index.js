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
const K_HISTORY = 'plugins.history';
const HISTORY_MAX = 100;
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
  // plugin.json `replaces` (first-party only): this package takes over an installed plugin under a new id
  const replaced = require('./replace').candidate(manifest, sig.status);
  if (replaced) add('replaces', 'ok', 'takeover', { name: replaced.name, id: replaced.id, version: replaced.version });
  if (!existing && !replaced && fs.existsSync(dataDir(manifest.id))) add('data', 'ok', 'kept_data');

  return { manifest, sig, migrations, checks, blockers: checks.filter((c) => c.status === 'fail'), existing, replaced };
}

function permissionSummary(m, lang) {
  const p = m.permissions;
  return {
    network: require('./netPolicy').describe(p, lang),
    storage: p.storage, portal: p.portal, users: p.users, notify: p.notify,
    // push budget per hour (permissions.notify { perHour }), topics allowed to send critical
    notifyPerHour: p.notify ? (p.notifyPerHour || manifestLib.NOTIFY_PER_HOUR_DEFAULT) : null,
    criticalTopics: p.notify ? (m.notifyTopics || []).filter((t) => t.allowCritical === true).map((t) => loc(t.label, lang)) : [],
    app: !!p.app,
    kiosk: !!p.kiosk,
    actions: !!p.actions,
    actionsInteractive: !!(p.actions && p.actionsInteractive),
    appTab: m.ui.app ? loc(m.ui.app.label, lang) : null,
    maps: !!m.ui.maps,
    geolocation: !!m.ui.geolocation,
    camera: !!m.ui.camera,
    // since 1.196.0: GC.scanQr — GateControl reads QR codes with its own camera dialog, the plugin gets the text
    scanQr: require('./frame').scanQrOf(m),
    inbox: !!m.ui.inbox,
    background: p.background ? p.background.intervalSeconds : null,
    pages: m.ui.pages.map((x) => loc(x.title, lang)), settings: m.ui.settings.length,
    portalTab: m.ui.portal && m.ui.portal.label ? loc(m.ui.portal.label, lang) : null,
    portalSections: m.ui.portal && m.ui.portal.sections ? m.ui.portal.sections.map((s) => ({ tab: s.tab, title: loc(s.title, lang) })) : [],
    // messenger foundations (docs/plugins.md "Media", "Realtime events", "Chat notifications", "Services")
    media: m.media ? { maxBytes: m.media.maxBytes, types: m.media.types, quotaDefault: m.media.quotaDefault, uploads: m.media.uploads !== false, ...(m.media.areas ? { areas: true } : {}), ...(m.media.previews ? { previews: true } : {}) } : null,
    events: !!p.events,
    // delivers notifications into chats (docs/plugins.md "Notifications in chats")
    notifySink: !!p.notifySink,
    chatTopics: p.notify ? (m.notifyTopics || []).filter((t) => t.chat === true).map((t) => loc(t.label, lang)) : [],
    services: Array.isArray(p.services) ? p.services : [],
    // since 1.193.0: download links without sign-in (only while an administrator allows them), the people's devices
    publicLinks: !!p.publicLinks,
    // since 1.211.0: requests without a session under /plugin-public/<id>/ with the plugin's tokens (e.g. an office server)
    publicEndpoints: !!p.publicEndpoints,
    devices: !!p.devices,
    // person groups (docs/plugins.md "Groups"): 'read' | 'manage' | null
    groups: p.groups === 'read' || p.groups === 'manage' ? p.groups : null,
    // Google Drive / OneDrive of a person (gc.cloud) and what for
    cloudImport: p.cloudImport ? { purpose: loc(p.cloudImport.purpose, lang) } : null,
    servicesProvided: m.services && m.services.provides ? Object.values(m.services.provides).map((x) => loc(x.label, lang)) : [],
  };
}

function existingPermissions(p, lang) {
  try { return p.manifest && p.manifest.permissions && p.manifest.ui ? permissionSummary(p.manifest, lang) : null; } catch { return null; }
}

function cleanStaging() {
  const now = Date.now();
  for (const [k, v] of staging) if (now - v.at > LIMITS.stagingTtlMs) staging.delete(k);
  while (staging.size >= LIMITS.stagingMax) staging.delete(staging.keys().next().value);
}

/**
 * Step 1 of an install: read and check an uploaded package. Nothing is written.
 * @param {Buffer} buf
 * @param {string} lang
 * @param {{expect?: {id:string, version:string}, origin?: 'upload'|'catalog'}} [opts]
 *   expect: the package must be exactly this plugin id and version and carry a
 *   TRUSTED signature (an install from the official catalogue) — otherwise it
 *   is refused before a staging token exists.
 */
function inspect(buf, lang, opts = {}) {
  if (!Buffer.isBuffer(buf)) throw new PluginError('package_not_a_package', 'not a .gcplugin file');
  let files;
  try { files = pkg.decode(buf); } catch (e) {
    throw new PluginError(e.code ? 'package_' + e.code : 'package_corrupt', e.message);
  }
  const a = analyse(files);
  if (opts.expect) {
    if (a.manifest && (a.manifest.id !== opts.expect.id || a.manifest.version !== opts.expect.version)) {
      throw new PluginError('catalog_mismatch', 'the package is not the plugin version that was requested');
    }
    if (a.sig.status !== 'trusted') throw new PluginError('catalog_untrusted', 'the package is not signed by a trusted publisher');
  }
  cleanStaging();
  const token = crypto.randomBytes(16).toString('hex');
  if (a.manifest) staging.set(token, { buf, at: Date.now(), origin: opts.origin === 'catalog' ? 'catalog' : 'upload' });
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
    existing: a.existing ? {
      version: a.existing.version, enabled: a.existing.enabled,
      // what the installed version may do — the update dialog shows the difference
      permissions: existingPermissions(a.existing, lang),
    } : null,
    origin: opts.origin === 'catalog' ? 'catalog' : 'upload',
  };
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

/** Write the package files below `dir` (fresh folder; traversal-safe). */
function extract(files, dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const [rel, data] of files) {
    // the signature file is kept: backups carry it and a restore verifies it again
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
  // a replaced plugin (plugin.json `replaces`): stop it and move its folders to the new id first
  const replace = require('./replace');
  const replaced = a.replaced;
  let undoMove = null;
  try {
    if (replaced) {
      await replace.detach(replaced.id);
      undoMove = replace.moveFolders(replaced.id, m.id);
    }
    extract(files, tmpDir);
    fs.mkdirSync(dataDir(m.id), { recursive: true, mode: 0o700 });
    // the database limit of this version (plugin.json storage.maxMB) — also for its migrations
    await storage.setLimit(m.id, m.storage ? m.storage.maxBytes : LIMITS.dbMaxBytes);
    if (a.migrations.length) {
      await storage.forPlugin(m.id).call('migrate', { list: a.migrations.map(({ version, name, sql }) => ({ version, name, sql })) }, TIMEOUTS.db * 6);
    }
    if (fs.existsSync(finalDir)) rmrf(finalDir);
    fs.renameSync(tmpDir, finalDir);
  } catch (e) {
    rmrf(tmpDir);
    if (undoMove) { await storage.close(m.id); undoMove(); }
    if (existing || replaced) await reconcile();
    throw e instanceof PluginError ? e : new PluginError(e.code === 'replace_conflict' ? 'replace_conflict' : 'install_failed', e.message);
  }
  if (replaced) {
    replace.moveRecords(replaced.id, m.id);
    replace.removeOld(replaced.id);
  }

  const plugin = registry.upsert({
    manifest: m,
    signature: a.sig.status === 'trusted' ? 'trusted' : (a.sig.status === 'untrusted' ? 'untrusted' : 'none'),
    signerKey: a.sig.publicKey || null,
    enabled: existing ? existing.enabled : (replaced ? replaced.enabled : true),
  });
  if (existing && existing.version !== m.version) rmrf(codeDir(m.id, existing.version));
  staging.delete(token);

  const verb = existing ? 'updated' : 'installed';
  const auto = opts.by === 'auto';
  registry.addLog(m.id, 'info', (existing ? `updated ${existing.version} → ${m.version}` : `installed v${m.version}`) + (auto ? ' (automatic update)' : ''));
  activity().log(`plugin_${verb}`, existing
    ? `Plugin "${plugin.name}" updated from ${existing.version} to ${m.version}${auto ? ' (automatic update)' : ''}`
    : `Plugin "${plugin.name}" ${m.version} installed`, {
    source: auto ? 'system' : 'admin', ipAddress: opts.ip, severity: 'info',
    details: { plugin: m.id, version: m.version, verified: plugin.signature === 'trusted', source: st.origin || 'upload', ...(auto ? { auto: true } : {}) },
  });
  addHistory({ action: existing ? 'update' : 'install', id: m.id, name: plugin.name, from: existing ? existing.version : null, to: m.version,
    by: auto ? 'auto' : 'admin', user: auto ? null : (opts.user || null), source: st.origin || 'upload' });
  if (replaced) {
    registry.addLog(m.id, 'info', `took over ${replaced.id} ${replaced.version} (data, settings, assignments)`);
    activity().log('plugin_replaced', `Plugin "${replaced.name}" ${replaced.version} replaced by "${plugin.name}" ${m.version} (data taken over)`, {
      source: auto ? 'system' : 'admin', ipAddress: opts.ip, severity: 'info', details: { plugin: m.id, replaced: replaced.id, from: replaced.version, version: m.version },
    });
    addHistory({ action: 'replace', id: replaced.id, name: replaced.name, from: replaced.version, to: null, by: auto ? 'auto' : 'admin', user: auto ? null : (opts.user || null), source: m.id, replacedBy: plugin.name });
  }
  if (!auto) require('./updates').forgetApproval(m.id);

  let licenseError = null;
  if (opts.licenseKey && m.license.required) {
    try { await licensing.setKey(plugin, opts.licenseKey); } catch (e) { licenseError = e.code || 'license_failed'; }
  }
  await reconcile();
  if (!opts.licenseKey) await revalidateAfterInstall(plugin, existing ? 'update' : 'install');
  return { plugin: registry.get(m.id), licenseError };
}

const REVALIDATE_WAIT_MS = 15000;

/**
 * A first-party plugin released after the last daily licence validation has
 * no entitlement yet ("missing"), although the licence server may already
 * include it (lifetime licence, plan). Revalidate once in the background
 * (licensing.revalidateIfMissing: throttled, only with a licence key) and
 * reconcile afterwards — the way the 5-minute reconcile picks up the daily
 * refresh — so a plugin that is licensed now starts without a restart. The
 * install answer waits for it at most REVALIDATE_WAIT_MS.
 */
async function revalidateAfterInstall(plugin, verb) {
  const reval = licensing.revalidateIfMissing(plugin);
  if (!reval) return;
  const done = reval.then(async (lic) => {
    registry.addLog(plugin.id, 'info', `licence revalidated after the ${verb}: ${lic.state}`);
    await reconcile();
  }).catch((e) => logger.warn({ plugin: plugin.id, err: e.message }, 'plugin licence revalidation failed'));
  await Promise.race([done, new Promise((r) => { const t = setTimeout(r, REVALIDATE_WAIT_MS); t.unref(); })]);
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
    // Kiosk eligibility depends on which plugins may run (docs/feature-kiosk-devices.md).
    try { require('../kiosk').invalidate(); } catch { /* not loaded */ }
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

/** Stop and start a plugin again (e.g. after a crash; resets the restart back-off). */
async function restart(id, { ip } = {}) {
  const p = registry.get(id);
  if (!p) throw new PluginError('not_found', 'plugin not installed');
  await runtime.ensureStopped(id);
  registry.addLog(id, 'info', 'restarted by an administrator');
  activity().log('plugin_restarted', `Plugin "${p.name}" restarted`, { source: 'admin', ipAddress: ip, severity: 'info', details: { plugin: id } });
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
async function uninstall(id, opts = {}) {
  const { mode, confirm, ip } = opts;
  const p = registry.get(id);
  if (!p) throw new PluginError('not_found', 'plugin not installed');
  if (mode !== 'keep' && mode !== 'wipe') throw new PluginError('invalid_mode', 'mode must be keep or wipe');
  if (mode === 'wipe' && !nameMatches(p, confirm)) throw new PluginError('confirm_mismatch', 'type the plugin name to confirm');
  await removeInstalled(p, mode);
  addHistory({ action: 'uninstall', id, name: p.name, from: p.version, to: null, by: 'admin', user: opts.user || null, mode });
  require('./updates').forgetApproval(id);
  activity().log('plugin_uninstalled', `Plugin "${p.name}" uninstalled (${mode === 'wipe' ? 'data deleted' : 'data kept'})`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { plugin: id, mode },
  });
}

async function removeInstalled(p, mode) {
  const id = p.id;
  await runtime.ensureStopped(id);
  await storage.close(id);
  require('./events').closeStreams(id);
  // its public links end with the plugin, whatever happens to its data
  require('./publicLinks').removeAll(id);
  require('../cloudAccounts').removePlugin(id);
  rmrf(path.join(pluginsRoot(), id));
  registry.remove(id);
  if (mode === 'wipe') {
    rmrf(dataDir(id));
    require('./media').removeAll(id);
    registry.removeLicense(id);
    require('./targets').removeAll(id);
    require('./legacy').forget(id);
    require('../kiosk').forgetPlugin(id);
  }
  // An uninstalled plugin marks nobody as a kiosk user any more.
  require('../kiosk').invalidate();
}

/**
 * Restore of a plugin-aware backup (format 5): plugins installed here but
 * not in the backup are removed completely, like "Alles löschen".
 * @param {Set<string>} keepIds  plugin ids contained in the backup
 * @returns {Promise<string[]>} removed ids
 */
async function removeNotIn(keepIds) {
  const removed = [];
  for (const p of registry.list()) {
    if (keepIds.has(p.id)) continue;
    await removeInstalled(p, 'wipe');
    activity().log('plugin_uninstalled', `Plugin "${p.name}" removed by a backup restore (not in the backup, data deleted)`, {
      source: 'system', severity: 'warning', details: { plugin: p.id, mode: 'wipe', reason: 'restore' },
    });
    removed.push(p.id);
  }
  return removed;
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

/**
 * Plugins › Lizenzen "Schlüssel eingeben": a first-party plugin key without
 * naming the plugin. The key joins the plugin keys of the GateControl licence,
 * the licence is validated, and the licence server's answer says which plugin
 * it belongs to (entitlement slug, matched by the masked key). A key the
 * licence server reports as unknown or invalid is not kept.
 * @returns {Promise<{pluginId, name, installed, valid, error, license}>}
 */
async function assignLicenseKey(key, { ip } = {}) {
  if (!licensing.validKey(key)) throw new PluginError('invalid_key', 'invalid licence key');
  const k = key.trim();
  const license = require('../license');
  const before = license.getPluginKeys();
  const had = before.includes(k);
  if (!had) {
    try { license.setPluginKeys([...before, k]); } catch (e) { throw new PluginError('invalid_key', e.message); }
  }
  await Promise.race([
    Promise.resolve(license.refreshLicenseInBackground()).catch(() => {}),
    new Promise((r) => { const t = setTimeout(r, 20000); t.unref(); }),
  ]);
  const hits = license.getPluginEntitlements().filter((e) => licensing.maskMatches(e.key_masked, k));
  const ent = hits.find((e) => e.valid) || hits[0] || null;
  if (!ent) throw new PluginError('license_pending', 'the licence server has not answered for this key yet');
  if (!ent.valid && !had && /invalid|not_found|unknown/.test(String(ent.error || ''))) {
    license.setPluginKeys(license.getPluginKeys().filter((x) => x !== k));
  }
  const p = registry.get(ent.slug);
  if (p) {
    registry.addLog(p.id, 'info', `licence key entered: ${licensing.status(p).state}`);
    await reconcile();
  }
  activity().log('plugin_license_key', `Plugin licence key entered for "${p ? p.name : ent.name || ent.slug}" (${ent.valid ? 'valid' : ent.error || 'invalid'})`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { plugin: ent.slug, valid: !!ent.valid, installed: !!p },
  });
  const now = p ? registry.get(p.id) : null;
  return { pluginId: ent.slug, name: p ? p.name : (ent.name || ent.slug), installed: !!p, valid: !!ent.valid, error: ent.valid ? null : (ent.error || 'invalid'),
    license: now ? licensing.status(now) : null };
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

// ─── History (Plugins › Updates "Zuletzt aktualisiert") ─────────
// The last HISTORY_MAX installs, updates and uninstalls, newest first:
// { at, action, id, name, from, to, by: 'admin'|'auto', user, source?, mode? }.

function history() {
  let list;
  try { list = JSON.parse(settings().get(K_HISTORY, '[]')); } catch { list = []; }
  return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
}

function addHistory(entry) {
  try {
    const user = typeof entry.user === 'string' ? entry.user.slice(0, 100) : null;
    const next = [{ at: new Date().toISOString(), ...entry, user }, ...history()].slice(0, HISTORY_MAX);
    settings().set(K_HISTORY, JSON.stringify(next));
  } catch (e) { logger.warn({ err: e.message }, 'plugin history not written'); }
}

// ─── Policy: automatic updates, catalogue checks ────────────
// plugins.auto_update  off | patch (bug-fix releases only) | all — first-party
//                      plugins from the official catalogue, nightly, never
//                      when an update asks for new permissions (updates.js)
// plugins.catalog_check  1 (default) | 0 — look for updates every 6 hours
//                      and tell the administrators once per new version

const K_AUTO_UPDATE = 'plugins.auto_update';
const K_CATALOG_CHECK = 'plugins.catalog_check';
const AUTO_UPDATE_MODES = new Set(['off', 'patch', 'all']);

function autoUpdateMode() {
  let v = 'off';
  try { v = settings().get(K_AUTO_UPDATE, 'off'); } catch { v = 'off'; }
  return AUTO_UPDATE_MODES.has(v) ? v : 'off';
}

function catalogCheck() {
  try { return settings().get(K_CATALOG_CHECK, '1') !== '0'; } catch { return true; }
}

function setAutoUpdate(mode, { ip } = {}) {
  if (!AUTO_UPDATE_MODES.has(mode)) throw new PluginError('invalid', 'auto update mode must be off, patch or all');
  if (mode === autoUpdateMode()) return;
  settings().set(K_AUTO_UPDATE, mode);
  activity().log('plugin_auto_update', `Automatic plugin updates: ${mode}`, { source: 'admin', ipAddress: ip, severity: 'info', details: { mode } });
}

function setCatalogCheck(on, { ip } = {}) {
  if (on === catalogCheck()) return;
  settings().set(K_CATALOG_CHECK, on ? '1' : '0');
  activity().log('plugin_catalog_check', `Regular plugin update checks ${on ? 'on' : 'off'}`, { source: 'admin', ipAddress: ip, severity: 'info', details: { on } });
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
    // the settings page (ui.settingsPage) is shown in the settings tab, not as a page tab
    pages: (m.ui && m.ui.pages ? m.ui.pages : []).filter((x) => !(m.ui.settingsPage && x.id === m.ui.settingsPage)).map((x) => ({ id: x.id, title: loc(x.title, lang) })),
    settingsPage: m.ui && m.ui.settingsPage ? { id: m.ui.settingsPage, title: loc((m.ui.pages.find((x) => x.id === m.ui.settingsPage) || {}).title, lang) } : null,
    portal: m.ui && m.ui.portal ? { label: m.ui.portal.label ? loc(m.ui.portal.label, lang) : null,
      sections: (m.ui.portal.sections || []).map((s) => ({ tab: s.tab, title: loc(s.title, lang) })) } : null,
    app: m.ui && m.ui.app ? { label: loc(m.ui.app.label, lang), icon: m.ui.app.icon } : null,
    maps: !!(m.ui && m.ui.maps),
    geolocation: !!(m.ui && m.ui.geolocation),
    camera: !!(m.ui && m.ui.camera),
    // GC.scanQr in the plugin's frames: the <iframe data-plugin-scanqr> (plugin-bridge.js)
    scanQr: require('./frame').scanQrOf(m),
    // GC.pickPrincipals in the plugin's frames (permissions.groups): the <iframe data-plugin-groups>
    pickPrincipals: require('./frame').pickPrincipalsOf(m),
    // GC.openUrl in the plugin's frames (permissions.cloudImport): the <iframe data-plugin-cloud>
    cloud: require('./frame').openUrlOf(m),
    // the <iframe allow="…"> of the plugin's frames (frame.allowAttr)
    allow: require('./frame').allowAttr({ media: !!m.media, geolocation: !!(m.ui && m.ui.geolocation), camera: !!(m.ui && m.ui.camera) }),
    media: m.media ? { maxBytes: m.media.maxBytes, types: m.media.types, quotaDefault: m.media.quotaDefault, uploads: m.media.uploads !== false, ...(m.media.areas ? { areas: true } : {}), ...(m.media.previews ? { previews: true } : {}) } : null,
    events: !!(m.permissions && m.permissions.events),
    settingsCount: m.ui && m.ui.settings ? m.ui.settings.length : 0,
    installedAt: p.installedAt,
    updatedAt: p.updatedAt,
    errors7d: registry.countLogs(p.id, 'error', Date.now() - 7 * 24 * 60 * 60 * 1000),
    events24h: registry.countLogs(p.id, null, Date.now() - 24 * 60 * 60 * 1000),
    // services: "<provider id>:<service>" used, service names provided (docs/plugins.md "Services")
    uses: [...new Set((m.permissions && Array.isArray(m.permissions.services) ? m.permissions.services : [])
      .map((x) => String(x).split(':')[0]).filter((x) => x && x !== p.id))],
    provides: m.services && m.services.provides ? Object.keys(m.services.provides) : [],
  };
}

/** Every installed plugin; `usedBy`: the installed plugins that use one of its services. */
function list(lang) {
  const out = registry.list().map((p) => view(p, lang));
  for (const v of out) v.usedBy = out.filter((o) => o.id !== v.id && o.uses.includes(v.id)).map((o) => o.id);
  return out;
}

function get(id) { return registry.get(id); }

function storageBytes(id) { return storage.usage(dataDir(id)); }

/** Sidebar entries: every installed plugin with a nav entry; `on` = running. */
// The former built-in integrations keep their old place in the sidebar
// (Klimaanlage, Fahrzeuge, Smart Home), every other plugin follows by name.
const NAV_FIRST = ['gatecontrol-midea', 'gatecontrol-skoda', 'gatecontrol-smarthome'];
function navRank(id) {
  const i = NAV_FIRST.indexOf(id);
  return i < 0 ? NAV_FIRST.length : i;
}

function navEntries(lang) {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return rows.filter((p) => p.manifest && p.manifest.ui && p.manifest.ui.nav).map((p) => {
    const ev = evaluate(p);
    return { id: p.id, label: loc(p.manifest.ui.nav.label, lang), icon: p.manifest.ui.nav.icon, href: '/plugins/' + p.id, on: ev.run };
  }).sort((a, b) => navRank(a.id) - navRank(b.id)); // stable: the rest stays sorted by name
}

/**
 * The badge of the sidebar item "Plugins": installed plugins that should run
 * but do not (crashed, licence, unsigned, incompatible, files missing) plus
 * the updates of the cached catalogue.
 */
function attentionCount() {
  let n = 0;
  try {
    for (const p of registry.list()) {
      const ev = evaluate(p);
      if (ev.run ? runtime.info(p.id).state === 'crashed' : ev.reason !== 'disabled') n++;
    }
  } catch { /* registry not ready */ }
  try { n += require('./updates').cachedCount(); } catch { /* no catalogue */ }
  return n;
}

/** Portal tabs of running plugins with the portal permission. */
function portalTabs(lang) {
  let rows;
  try { rows = registry.list(); } catch { return []; }
  return rows.filter((p) => p.manifest && p.manifest.permissions && p.manifest.permissions.portal && p.manifest.ui && p.manifest.ui.portal && p.manifest.ui.portal.label)
    .filter((p) => evaluate(p).run && runtime.info(p.id).state === 'running')
    .map((p) => ({ id: p.id, key: 'plg-' + p.id, label: loc(p.manifest.ui.portal.label, lang), icon: p.manifest.ui.portal.icon }));
}

/**
 * Portal tabs for one viewer: like portalTabs(), without the tabs whose
 * plugin answers portalVisible with false (src/services/plugins/portal.js
 * has the sections, Start tiles and search as well).
 * @param {{id, name, role, portal: true}} user
 */
async function portalTabsFor(user, lang) {
  return (await require('./portal').contributions(user, lang)).tabs;
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

/**
 * A request of a public endpoint (routes/pluginPublic.js, publicEndpoints.js, since 1.211.0) → the hook
 * publicRequest's raw answer (checked by the route); the answer's size like request().
 */
async function publicRequest(id, req) {
  const out = await runtime.call(id, 'publicRequest', req, TIMEOUTS.request);
  const body = boundJson(out === undefined ? null : out);
  if (!body.ok) throw new PluginError('response_too_large', 'plugin answer too large');
  return body.value;
}

/** Render a page/portal fragment: { html } (untrusted — served sandboxed only). */
async function render(id, viewReq) {
  const out = await runtime.call(id, 'render', viewReq, TIMEOUTS.request);
  const html = out && typeof out.html === 'string' ? out.html : '';
  if (Buffer.byteLength(html) > LIMITS.responseBytes) throw new PluginError('response_too_large', 'plugin page too large');
  return { html };
}

async function settingsChanged(id, { timeoutMs = TIMEOUTS.request } = {}) {
  const p = registry.get(id);
  if (!p || runtime.info(id).state !== 'running') return;
  try { await runtime.call(id, 'settingsChanged', await require('./pluginSettings').forPlugin(p), timeoutMs); } catch { /* plugin may not care */ }
}

const STATUS_TONES = new Set(['ok', 'info', 'warn', 'error']);
const STATUS_MS = 3000;

/**
 * The plugin's status lines for its settings form (hook settingsStatus, since
 * 1.185.0): [{ group, tone, text }] — group one of ui.settingsGroups or null
 * (above the form), at most 10, text ≤ 200 characters, no markup. A plugin
 * that is not running, has no hook, fails or takes longer than 3 s → [].
 */
async function settingsStatus(id, lang) {
  const p = registry.get(id);
  if (!p || runtime.info(id).state !== 'running') return [];
  let out;
  try { out = await runtime.call(id, 'settingsStatus', { lang: lang === 'en' ? 'en' : 'de' }, STATUS_MS); } catch { return []; }
  if (!Array.isArray(out)) return [];
  const groups = new Set(((p.manifest.ui && p.manifest.ui.settingsGroups) || []).map((g) => g.id));
  const lines = [];
  for (const x of out.slice(0, 10)) {
    if (!x || typeof x !== 'object' || typeof x.text !== 'string') continue;
    const text = x.text.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 200);
    if (!text) continue;
    lines.push({ group: typeof x.group === 'string' && groups.has(x.group) ? x.group : null, tone: STATUS_TONES.has(x.tone) ? x.tone : 'info', text });
  }
  return lines;
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

function hourly() {
  try {
    const n = require('./media').cleanup();
    if (n) logger.info({ removed: n }, 'plugin media clean-up');
  } catch (e) { logger.warn({ err: e.message }, 'plugin media clean-up failed'); }
  try { require('./hostApi').flushChatSummary(); } catch { /* best-effort */ }
  // public links: the plugin hears of expiries, ended links go after 30 days
  try { require('./publicLinks').sweep(); } catch (e) { logger.warn({ err: e.message }, 'public link sweep failed'); }
}

function start() {
  if (timers.length) return;
  fs.mkdirSync(pluginsRoot(), { recursive: true });
  reconcile().catch((e) => logger.warn({ err: e.message }, 'plugin start failed'));
  // licence states change in the background (daily licence refresh, expiry): look every 5 minutes
  timers.push(setInterval(() => reconcile().catch(() => {}), 5 * 60 * 1000));
  timers.push(setInterval(() => checkThirdPartyLicences().catch(() => {}), 24 * 60 * 60 * 1000));
  // hourly: unclaimed plugin media older than 24 h, the neutral line of chat notifications sent
  timers.push(setInterval(hourly, 60 * 60 * 1000));
  setTimeout(() => checkThirdPartyLicences().catch(() => {}), 60 * 1000).unref();
  for (const t of timers) t.unref();
  // update check every 6 hours, nightly automatic update (updates.js)
  require('./updates').start();
  // media areas: copies to storage targets, the cache, deletions (mediaAreas.js)
  require('./mediaAreas').start();
  // person groups: groupsChanged / groupUsage / groupDeleting of plugins with permissions.groups
  try { require('./groups').init(); } catch (e) { logger.warn({ err: e.message }, 'plugin group hooks not wired'); }
}

async function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  require('./updates').stop();
  require('./mediaAreas').stop();
  try { require('./groups').shutdown(); } catch { /* best-effort */ }
  try { require('./hostApi').flushChatSummary(); } catch { /* best-effort */ }
  require('./events').closeStreams();
  await runtime.stopAll();
  await storage.closeAll();
}

module.exports = {
  PluginError, inspect, install, evaluate, reconcile, setEnabled, restart, uninstall, setAllowUnsigned, allowUnsigned,
  setLicenseKey, assignLicenseKey, checkLicense, attentionCount, list, view, get, navEntries, history, addHistory, autoUpdateMode, setAutoUpdate, catalogCheck, setCatalogCheck, portalTabs, portalTabsFor, request, publicRequest, render, settingsChanged, settingsStatus, storageBytes,
  serverVersion, start, stop, extract, readManifest, removeNotIn,
  _staging: staging,
};
