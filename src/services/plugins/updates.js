'use strict';

// Plugin updates (docs/plugins.md "Updates"): what the official catalogue
// offers for the installed plugins, the regular check that tells the
// administrators about new versions, and the optional automatic update.
//
//   available(cat)       installed plugins with a newer compatible catalogue
//                        version: kind (patch | minor | major) and the release
//                        notes of every version in between
//   checkCatalog()       every CHECK_EVERY_MS (setting plugins.catalog_check,
//                        default on): fetch the catalogue, log
//                        plugin_update_available once per new version
//   autoUpdateTick(now)  setting plugins.auto_update (off | patch | all):
//                        once a night between 03:00 and 05:00 (server time)
//                        install the updates of signed first-party plugins —
//                        never one that asks for new or other permissions
//                        (plugin_update_needs_approval, once per version)
//
// An automatic update runs exactly like a click on "Aktualisieren": catalogue
// download, sha256, inspect() with the trusted-signature requirement, install().

const catalog = require('./catalog');
const registry = require('./registry');
const semver = require('./semver');
const { loc } = require('./manifest');
const logger = require('../../utils/logger');

const K_NOTIFIED = 'plugins.update_notified';      // { <id>: <version> } already reported
const K_APPROVAL = 'plugins.update_approval';      // { <id>: <version> } waiting for an administrator
const K_AUTO_DAY = 'plugins.auto_update_day';      // local date of the last nightly run
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 15 * 60 * 1000;
const NIGHT_FROM = 3;
const NIGHT_TO = 5;

let timers = [];

function plugins() { return require('./index'); }
function settings() { return require('../settings'); }
function activity() { return require('../activity'); }

function readMap(key) {
  try {
    const v = JSON.parse(settings().get(key, '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeMap(key, map) { settings().set(key, JSON.stringify(map)); }

/** 'major' | 'minor' | 'patch' — how far `to` is from `from`. */
function kindOf(from, to) {
  try {
    const a = semver.parse(from);
    const b = semver.parse(to);
    if (a.major !== b.major) return 'major';
    if (a.minor !== b.minor) return 'minor';
    return 'patch';
  } catch { return 'major'; }
}

/**
 * Updates the catalogue offers for the installed plugins.
 * @returns {{id, name, from, to, kind, gatecontrol, size, verified, needsApproval, notes: {version, publishedAt, notes}[]}[]}
 */
function available(cat, lang = 'de') {
  const gc = plugins().serverVersion();
  const approvals = readMap(K_APPROVAL);
  const out = [];
  for (const p of registry.list()) {
    const entry = cat.plugins.get(p.id);
    if (!entry) continue;
    const s = catalog.stateOf(entry, p, gc);
    if (s.state !== 'update' || !s.latest) continue;
    out.push({
      id: p.id,
      name: (p.manifest && loc(p.manifest.name, lang)) || p.name,
      from: p.version,
      to: s.latest.version,
      kind: kindOf(p.version, s.latest.version),
      gatecontrol: s.latest.gatecontrol,
      size: s.latest.size,
      verified: p.signature === 'trusted',
      needsApproval: approvals[p.id] === s.latest.version,
      notes: catalog.notesBetween(cat, p.id, p.version, s.latest.version),
    });
  }
  // a catalogue plugin under a new id that replaces an installed one: offered
  // in place of the old plugin's own updates, installed by hand only
  for (const q of cat.plugins.values()) {
    const old = catalog.replacing(q, (id) => registry.get(id));
    const latest = old && catalog.pick(q, gc);
    if (!latest) continue;
    const i = out.findIndex((u) => u.id === old.id);
    if (i >= 0) out.splice(i, 1);
    out.push({
      id: q.id,
      name: (lang === 'en' ? q.name.en : q.name.de) || q.id,
      from: old.version,
      to: latest.version,
      kind: 'replace',
      replaces: { id: old.id, name: (old.manifest && loc(old.manifest.name, lang)) || old.name },
      gatecontrol: latest.gatecontrol,
      size: latest.size,
      verified: old.signature === 'trusted',
      needsApproval: false,
      notes: catalog.notesBetween(cat, q.id, null, latest.version).slice(0, 1),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, lang));
}

/** Updates in the cached catalogue only (no fetch) — the sidebar badge. */
function cachedCount() {
  const cat = catalog.cached();
  if (!cat) return 0;
  try { return available(cat).length; } catch { return 0; }
}

/** Do the inspected update and the installed version ask for the same permissions? */
function samePermissions(info) {
  if (!info || !info.plugin || !info.existing || !info.existing.permissions) return false;
  return JSON.stringify(info.plugin.permissions) === JSON.stringify(info.existing.permissions);
}

/**
 * Fetch the catalogue and report new versions (once per version).
 * @returns {Promise<object[]|null>} the available updates, null when not checked
 */
async function checkCatalog() {
  if (!catalog.enabled() || !plugins().catalogCheck()) return null;
  let cat;
  try { cat = await catalog.get({ refresh: true }); } catch (e) {
    logger.warn({ code: e.code, err: e.message }, 'plugin update check: catalogue not available');
    return null;
  }
  const ups = available(cat);
  const notified = readMap(K_NOTIFIED);
  const fresh = ups.filter((u) => notified[u.id] !== u.to);
  if (fresh.length) {
    activity().log('plugin_update_available', `Plugin updates available: ${fresh.map((u) => `${u.name} ${u.to}`).join(', ')}`, {
      source: 'system', severity: 'info', details: { updates: fresh.map(({ id, from, to, kind }) => ({ id, from, to, kind })) },
    });
  }
  writeMap(K_NOTIFIED, Object.fromEntries(ups.map((u) => [u.id, u.to])));
  return ups;
}

function localDay(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inNightWindow(now) {
  const h = new Date(now).getHours();
  return h >= NIGHT_FROM && h < NIGHT_TO;
}

/**
 * Install the updates the mode allows. Signed first-party plugins only.
 * @param {'patch'|'all'} mode
 * @returns {Promise<{id, result: 'updated'|'needs_approval'|'blocked'|'failed', from?, to?, error?}[]>}
 */
async function runAutoUpdate(mode) {
  let cat;
  try { cat = await catalog.get({ refresh: true }); } catch (e) {
    logger.warn({ code: e.code, err: e.message }, 'automatic plugin update: catalogue not available');
    return [];
  }
  const gc = plugins().serverVersion();
  const results = [];
  const approvals = readMap(K_APPROVAL);
  for (const u of available(cat)) {
    if (u.replaces) continue; // a plugin under a new id: an administrator decides
    const p = registry.get(u.id);
    if (!p || p.signature !== 'trusted') continue;
    if (mode === 'patch' && u.kind !== 'patch') continue;
    try {
      const { buf } = await catalog.download(u.id, u.to, gc);
      const info = plugins().inspect(buf, 'de', { expect: { id: u.id, version: u.to }, origin: 'catalog' });
      if (!info.canInstall) {
        registry.addLog(u.id, 'warn', `automatic update to ${u.to} not possible: a check failed`);
        results.push({ id: u.id, result: 'blocked', from: u.from, to: u.to });
        continue;
      }
      if (!samePermissions(info)) {
        if (approvals[u.id] !== u.to) {
          approvals[u.id] = u.to;
          registry.addLog(u.id, 'info', `update to ${u.to} asks for other permissions — waiting for an administrator`);
          activity().log('plugin_update_needs_approval', `Plugin "${u.name}" ${u.to} asks for other permissions — update it by hand`, {
            source: 'system', severity: 'warning', details: { plugin: u.id, from: u.from, to: u.to },
          });
        }
        results.push({ id: u.id, result: 'needs_approval', from: u.from, to: u.to });
        continue;
      }
      await plugins().install(info.token, { accept: true, by: 'auto' });
      delete approvals[u.id];
      results.push({ id: u.id, result: 'updated', from: u.from, to: u.to, name: u.name });
    } catch (e) {
      registry.addLog(u.id, 'warn', `automatic update to ${u.to} failed: ${e.code || e.message}`);
      results.push({ id: u.id, result: 'failed', from: u.from, to: u.to, error: e.code || 'failed' });
    }
  }
  writeMap(K_APPROVAL, approvals);
  const done = results.filter((r) => r.result === 'updated');
  if (done.length) {
    activity().log('plugin_auto_updated', `Plugins updated automatically: ${done.map((r) => `${r.name} ${r.to}`).join(', ')}`, {
      source: 'system', severity: 'info', details: { updates: done.map(({ id, from, to }) => ({ id, from, to })) },
    });
  }
  return results;
}

/**
 * The nightly automatic update: runs once per local day inside the window.
 * `force` skips the window and the once-a-day rule (tests).
 */
async function autoUpdateTick(now = Date.now(), { force = false } = {}) {
  const mode = plugins().autoUpdateMode();
  if (mode === 'off' || !catalog.enabled()) return [];
  if (!force) {
    if (!inNightWindow(now)) return [];
    if (settings().get(K_AUTO_DAY, '') === localDay(now)) return [];
  }
  settings().set(K_AUTO_DAY, localDay(now));
  return runAutoUpdate(mode);
}

/** An administrator updated or uninstalled the plugin: its pending approval is gone. */
function forgetApproval(id) {
  const approvals = readMap(K_APPROVAL);
  if (!(id in approvals)) return;
  delete approvals[id];
  writeMap(K_APPROVAL, approvals);
}

function start() {
  if (timers.length) return;
  timers.push(setInterval(() => { checkCatalog().catch(() => {}); }, CHECK_EVERY_MS));
  timers.push(setInterval(() => { autoUpdateTick().catch((e) => logger.warn({ err: e.message }, 'automatic plugin update failed')); }, TICK_MS));
  timers.push(setTimeout(() => { checkCatalog().catch(() => {}); }, 2 * 60 * 1000));
  for (const t of timers) t.unref();
}

function stop() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers = [];
}

module.exports = {
  available, cachedCount, checkCatalog, autoUpdateTick, runAutoUpdate, samePermissions, kindOf, forgetApproval, start, stop,
  inNightWindow, localDay, CHECK_EVERY_MS,
};
