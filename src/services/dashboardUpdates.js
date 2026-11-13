'use strict';

// The "Updates" card of the dashboard: GateControl itself, the plugins, the
// gateways and the apps in one answer (GET /api/v1/dashboard/updates).
//
// Everything here comes from what the server already holds:
//   server    the running version, the newest release (services/releaseWatch.js)
//             and the auto-update state (services/autoUpdate.js getStatus — the
//             same source as the Server card)
//   plugins   the cached catalogue (services/plugins/catalog.js cached()) and
//             services/plugins/updates.js available()
//   gateways  the version each gateway reported and the newest gateway
//             release (services/gatewayRelease.js) — the same comparison as
//             GET /api/v1/gateways
//   apps      the version each device reported (services/clientUpdates.js)
//             against the newest release of its app and channel
//
// summary() never waits for the network and never writes: it answers from the
// caches and, at most, starts a refresh in the background (refreshInBackground).
//
// State of a field: 'update' (something to install), 'current', 'unknown'
// (cannot be compared: never checked or the check failed and nothing is known),
// 'none' (nothing there: no plugin, no gateway, no device with an app),
// 'off' (plugin catalogue switched off). `check_failed` says that the newest
// check did not get an answer — the field then shows the last known state.

const logger = require('../utils/logger');
const { compareVersions, compareSemver } = require('../utils/version');
const releaseWatch = require('./releaseWatch');
const pkg = require('../../package.json');

const APP_PRODUCTS = Object.freeze(['android', 'pro', 'community']);
// the plugin catalogue is asked again from here when its copy is older than this
const CATALOG_AGE_MS = 60 * 60 * 1000;
const FORCE_MIN_MS = 60 * 1000;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const ms = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : 0; };

// ─── Server ─────────────────────────────────────

function serverField() {
  const rel = releaseWatch.get('server', 'stable');
  const running = pkg.version;
  let au = null;
  try { au = require('./autoUpdate').getStatus(); }
  catch (err) { logger.debug({ err: err.message }, 'updates card: auto-update state unavailable'); }
  const win = (au && au.window) || {};
  const waiting = !!au && au.last_action === 'waiting_window';
  const newer = !!rel.version && compareVersions(rel.version, running) > 0;
  let state = 'current';
  if (newer || waiting) state = 'update';
  else if (!rel.version) state = 'unknown';
  return {
    state,
    running_version: running,
    latest_version: rel.version || null,
    update_available: newer,
    release_url: newer ? rel.url : null,
    checked_at: iso(rel.checked_at),
    check_failed: rel.failed,
    failed_at: iso(rel.failed_at),
    auto: au ? {
      status: au.status,
      mode: au.mode,
      age_s: au.age_s,
      last_action: au.last_action || null,
      mode_mismatch: !!au.mode_mismatch,
      window: { enabled: !!win.enabled, start: win.start || null, end: win.end || null },
      // "Jetzt aktualisieren": the same rule as the Server card and POST /system/auto-update/trigger
      can_trigger: au.mode === 'manual' || !!win.enabled,
    } : null,
  };
}

// ─── Plugins ────────────────────────────────────

function pluginsField(lang) {
  const catalog = require('./plugins/catalog');
  const registry = require('./plugins/registry');
  let installed = 0;
  try { installed = registry.list().length; } catch { installed = 0; }
  const base = { installed, updates: [], checked_at: null, check_failed: false, failed_at: null, error_code: null };
  if (!installed) return { state: 'none', ...base };
  if (!catalog.enabled()) return { state: 'off', ...base };
  const err = catalog.lastError();
  const cat = catalog.cached();
  const failed = { check_failed: !!err, failed_at: err ? err.at : null, error_code: err ? err.code : null };
  if (!cat) return { state: 'unknown', ...base, ...failed };
  let ups = [];
  try {
    ups = require('./plugins/updates').available(cat, lang).map((u) => ({ id: u.id, name: u.name, from: u.from, to: u.to }));
  } catch (e) {
    logger.debug({ err: e.message }, 'updates card: plugin updates unavailable');
    return { state: 'unknown', ...base, ...failed, checked_at: catalog.fetchedAt() };
  }
  return { state: ups.length ? 'update' : 'current', ...base, ...failed, updates: ups, checked_at: catalog.fetchedAt() };
}

// ─── Gateways ───────────────────────────────────

function gatewaysField() {
  const { getDb } = require('../db/connection');
  const rows = getDb().prepare(`
    SELECT p.id, p.name, gm.last_health
      FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
     WHERE p.peer_type = 'gateway' AND p.enabled = 1
     ORDER BY p.name COLLATE NOCASE`).all();
  const st = require('./gatewayRelease').getStatus();
  const items = rows.map((r) => {
    let version = null;
    try {
      const h = r.last_health ? JSON.parse(r.last_health) : null;
      const v = h && h.telemetry ? h.telemetry.gateway_version : null;
      version = typeof v === 'string' && v.length <= 48 ? v : null;
    } catch { version = null; }
    return { id: r.id, name: r.name, version, update_available: !!(st.version && version && compareVersions(st.version, version) > 0) };
  });
  const outdated = items.filter((g) => g.update_available).length;
  const unreported = items.filter((g) => !g.version).length;
  let state = 'current';
  if (!items.length) state = 'none';
  else if (outdated) state = 'update';
  else if (!st.version) state = 'unknown';
  return {
    state, total: items.length, outdated, unreported,
    latest_version: st.version,
    checked_at: iso(st.checked_at), check_failed: st.failed, failed_at: iso(st.failed_at),
    items,
  };
}

// ─── Apps ───────────────────────────────────────

function appGroups() {
  try { return require('./clientUpdates').getVersionGroups(); }
  catch (err) { logger.debug({ err: err.message }, 'updates card: client versions unavailable'); return { groups: [], unreported: 0 }; }
}

/**
 * Compare the reported versions with the newest releases.
 * `groups`: [{ product, channel, version, count }] (clientUpdates.getVersionGroups),
 * `latestOf(product, channel)` → { version, checked_at, failed, failed_at }.
 * A device counts as outdated only when its version is known to be older;
 * devices without a product, with an unreadable version or of an app whose
 * newest release is not known count as `unknown`, never as outdated.
 */
function compareApps(groups, unreported, latestOf) {
  const byKey = new Map();
  let total = 0;
  let outdated = 0;
  let unknown = 0;
  let noProduct = 0;
  for (const g of groups) {
    if (!APP_PRODUCTS.includes(g.product)) { noProduct += g.count; continue; }
    const key = `${g.product}:${g.channel}`;
    if (!byKey.has(key)) {
      const rel = latestOf(g.product, g.channel);
      byKey.set(key, {
        product: g.product, channel: g.channel, latest_version: rel.version || null,
        checked_at: iso(rel.checked_at), check_failed: !!rel.failed, failed_at: iso(rel.failed_at),
        total: 0, outdated: 0, unknown: 0, versions: [],
      });
    }
    const p = byKey.get(key);
    const c = p.latest_version ? compareSemver(g.version, p.latest_version) : null;
    p.total += g.count;
    total += g.count;
    if (c === null) { p.unknown += g.count; unknown += g.count; }
    else if (c < 0) { p.outdated += g.count; outdated += g.count; p.versions.push({ version: g.version, count: g.count }); }
  }
  const order = (p) => APP_PRODUCTS.indexOf(p.product) * 2 + (p.channel === 'beta' ? 1 : 0);
  const products = [...byKey.values()].sort((a, b) => order(a) - order(b));
  for (const p of products) p.versions.sort((a, b) => b.count - a.count || a.version.localeCompare(b.version));
  let state = 'current';
  if (!total) state = 'none';
  else if (outdated) state = 'update';
  else if (unknown) state = 'unknown';
  const checked = products.map((p) => ms(p.checked_at)).filter(Boolean);
  const failedAt = products.map((p) => ms(p.failed_at)).filter(Boolean);
  return {
    state, total, outdated, unknown,
    // no version at all, or a version without the app's name: "ohne Angabe"
    unreported: (unreported || 0) + noProduct,
    checked_at: iso(checked.length ? Math.min(...checked) : 0),
    check_failed: products.some((p) => p.check_failed),
    failed_at: iso(failedAt.length ? Math.max(...failedAt) : 0),
    products,
  };
}

function appsField() {
  const { groups, unreported } = appGroups();
  return compareApps(groups, unreported, (product, channel) => releaseWatch.get(product, channel));
}

// ─── The four fields together ───────────────────

function safe(name, fn) {
  try { return fn(); } catch (err) {
    logger.warn({ err: err.message, field: name }, 'updates card: field unavailable');
    return { state: 'unknown', checked_at: null, check_failed: true, failed_at: new Date().toISOString(), error: true };
  }
}

/**
 * → { state: 'ok' | 'updates' | 'unknown', updates, checked_at, failed_at,
 *     server, plugins, gateways, apps }
 * 'unknown' wins over 'updates': a field that could not be checked is said
 * openly, the card then shows every field with its last known state.
 */
function summary({ lang = 'de' } = {}) {
  const fields = {
    server: safe('server', serverField),
    plugins: safe('plugins', () => pluginsField(lang)),
    gateways: safe('gateways', gatewaysField),
    apps: safe('apps', appsField),
  };
  const list = Object.values(fields);
  const updates = list.filter((f) => f.state === 'update').length;
  const unchecked = list.some((f) => f.state === 'unknown' || f.check_failed);
  // "geprüft vor …": the oldest of the checks that are shown as current
  const checked = list.map((f) => ms(f.checked_at)).filter(Boolean);
  const failed = list.map((f) => ms(f.failed_at)).filter(Boolean);
  return {
    state: unchecked ? 'unknown' : (updates ? 'updates' : 'ok'),
    updates,
    checked_at: iso(checked.length ? Math.min(...checked) : 0),
    failed_at: iso(failed.length ? Math.max(...failed) : 0),
    ...fields,
  };
}

/** The releases the card needs: the server, and every app and channel a device reported. */
function wantedKeys() {
  const keys = new Set([releaseWatch.keyOf('server', 'stable')]);
  for (const g of appGroups().groups) {
    if (APP_PRODUCTS.includes(g.product)) keys.add(releaseWatch.keyOf(g.product, g.channel));
  }
  return [...keys];
}

let lastForcedAt = 0;
let catalogBusy = false;

/**
 * Start whatever is due — the callers never wait for it. `force` ("Erneut
 * prüfen") asks again whatever the age, at most once a minute.
 * Server and apps: services/releaseWatch.js (an hour between checks, back-off).
 * Gateways: services/gatewayRelease.js refreshes itself when read (same rule).
 * Plugins: the catalogue is asked when its copy is older than an hour — only
 * while the regular catalogue check is switched on (Einstellungen → Plugins).
 */
function refreshInBackground({ force = false } = {}) {
  const now = Date.now();
  if (force) {
    if (now - lastForcedAt < FORCE_MIN_MS) force = false;
    else lastForcedAt = now;
  }
  try { releaseWatch.refresh(wantedKeys(), { force }); }
  catch (err) { logger.debug({ err: err.message }, 'updates card: release refresh not started'); }
  try {
    const rel = require('./gatewayRelease');
    if (force) rel._fetchLatest(); else rel.getLatestVersion();
  } catch (err) { logger.debug({ err: err.message }, 'updates card: gateway release refresh not started'); }
  if (process.env.NODE_ENV === 'test' && !module.exports._catalogInTest) return;
  try {
    const catalog = require('./plugins/catalog');
    const plugins = require('./plugins');
    if (catalogBusy || !catalog.enabled() || !require('./plugins/registry').list().length) return;
    if (!force && !plugins.catalogCheck()) return;
    const at = ms(catalog.fetchedAt());
    if (!force && at && now - at < CATALOG_AGE_MS) return;
    catalogBusy = true;
    // get() keeps its own error pause (a minute) and folds parallel callers into one fetch
    catalog.get({ refresh: force }).catch(() => {}).finally(() => { catalogBusy = false; });
  } catch (err) { logger.debug({ err: err.message }, 'updates card: catalogue refresh not started'); }
}

module.exports = {
  summary, refreshInBackground, wantedKeys, compareApps, serverField, pluginsField, gatewaysField, appsField,
  APP_PRODUCTS, FORCE_MIN_MS,
  _catalogInTest: false,
  _resetForTest: () => { lastForcedAt = 0; catalogBusy = false; },
};
