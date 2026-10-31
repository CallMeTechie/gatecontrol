'use strict';

// Plugin licences (docs/plugins.md "Lizenzen").
//
// first-party  (signed by a trusted CallMeTechie key): the entitlement of the
//              GateControl licence server — license.getPluginEntitlements(),
//              matched on slug === plugin id. The key is one of the plugin
//              keys sent with every v2 validation (license.setPluginKeys).
// third-party  (unsigned or signed by another key): the plugin's own licence
//              server from plugin.json (license.server, HTTPS only), contract
//              of callmetechie.de docs/api/plugin-license-protocol.md:
//                POST <server>  { license_key, plugin_id, server_id }
//                200            { valid: boolean, expires_at: ISO-8601|null }
//              server_id is an anonymous, stable id of this install for that
//              licence server (HMAC of a random install secret and the server
//              origin — not the hardware fingerprint, and different for every
//              licence server, so two vendors cannot correlate installs).
//              Checked on entry and daily; a server that cannot be reached
//              keeps the last good answer for GRACE_MS (14 days, as the
//              GateControl licence itself). A check that failed for a
//              network error, timeout, 5xx or 429 is retried after 5 min,
//              15 min, 1 h, then hourly until it succeeds (utils/checkBackoff.js,
//              as the GateControl licence); a 4xx waits for the daily check.
//
// The GateControl licence (and with it the first-party entitlements) is
// validated once a day. A first-party plugin released after the last
// validation is therefore "missing" although the licence server already
// includes it (lifetime licence, plan) — revalidateIfMissing() revalidates
// once when such a plugin is installed or updated (throttled, only with a
// GateControl licence key).

const crypto = require('node:crypto');
const registry = require('./registry');
const netPolicy = require('./netPolicy');
const logger = require('../../utils/logger');
const { backoffDelay, parseRetryAfter, retryableStatus, networkReason } = require('../../utils/checkBackoff');

const DAY = 24 * 60 * 60 * 1000;
const GRACE_MS = 14 * DAY;
const EXPIRING_MS = 14 * DAY;
const CHECK_TIMEOUT_MS = 15000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;

const LICENSED_STATES = new Set(['valid', 'expiring', 'unreachable', 'not_required']);

// one automatic revalidation per process per 10 minutes at most —
// independent of the cooldown of POST /api/v1/license/refresh
const AUTO_REFRESH_GAP_MS = 10 * 60 * 1000;

let transport = null; // test seam
// third-party retries after a failed check: plugin id → { timer, at }
const retries = new Map();
let retriesOn = false; // startRetries() ran (plugins/index.js start)
let refreshFn = null; // test seam
let lastAutoRefresh = 0;

function kindOf(plugin) {
  return plugin.signature === 'trusted' ? 'first_party' : 'third_party';
}

function mask(key) {
  const k = String(key || '');
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '-••••-' + k.slice(-4);
}

function settings() { return require('../settings'); }

function installSecret() {
  let s = settings().get('plugins.install_secret', null);
  if (!s || !/^[0-9a-f]{64}$/.test(s)) {
    s = crypto.randomBytes(32).toString('hex');
    settings().set('plugins.install_secret', s);
  }
  return s;
}

/** Anonymous id of this install for one licence server. */
function serverId(licenseServerUrl) {
  let origin;
  try { origin = new URL(licenseServerUrl).origin; } catch { origin = String(licenseServerUrl); }
  return crypto.createHmac('sha256', installSecret()).update('gc-plugin-server-id:' + origin).digest('hex');
}

function expiryState(expiresAt, now) {
  if (!expiresAt) return 'valid';
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 'valid';
  if (t <= now) return 'expired';
  return t - now <= EXPIRING_MS ? 'expiring' : 'valid';
}

// A plugin key that is not needed: the plugin is already included in the
// GateControl plan or covered by a lifetime licence (licence server error).
const COVERED = new Map([['covered_by_plan', 'plan'], ['covered_by_lifetime', 'lifetime']]);

function firstPartyStatus(plugin, now) {
  const license = require('../license');
  // a plugin that replaced others (plugin.json `replaces`) keeps their entitlements (the licence server knows the old slug)
  const slugs = new Set([plugin.id, ...(Array.isArray(plugin.manifest && plugin.manifest.replaces) ? plugin.manifest.replaces : [])]);
  const all = license.getPluginEntitlements().filter((e) => slugs.has(e.slug));
  // a redundant key ("covered_by_…") never decides the state — the entry that covers it does
  const isCovered = (e) => !e.valid && COVERED.has(String(e.error || ''));
  const covered = all.find(isCovered);
  const real = all.filter((e) => !isCovered(e));
  const ent = real.find((e) => e.valid) || real[0] || null;
  const coveredBy = covered ? COVERED.get(String(covered.error)) : null;
  const base = { kind: 'first_party', required: true, server: null, keyMasked: ent ? ent.key_masked || null : null,
    ...(coveredBy ? { coveredBy, redundantKeyMasked: covered.key_masked || null } : {}) };
  if (!ent) return { ...base, state: 'missing' };
  if (ent.valid) {
    let state = expiryState(ent.expires_at, now);
    const info = license.getLicenseInfo() || {};
    const offline = info.verification === 'signed_offline';
    if (state !== 'expired' && offline) state = 'unreachable';
    // why the licence server counts as unreachable, and when it is asked again
    const check = state === 'unreachable' && info.lastCheck && !info.lastCheck.ok
      ? { lastCheck: { ...info.lastCheck }, nextCheckAt: info.nextCheckAt || null } : {};
    return { ...base, state, expiresAt: ent.expires_at || null, updatesUntil: ent.updates_until || null, source: ent.source,
      ...(ent.tier ? { tier: ent.tier, seats: ent.seats || null } : {}), ...check };
  }
  const err = String(ent.error || '');
  let state = 'invalid';
  if (ent.source) base.source = ent.source;
  if (err === 'expired') state = 'expired';
  else if (/activation|bound|limit|in_use/.test(err)) state = 'bound_elsewhere';
  else if (/wrong|product|mismatch/.test(err)) state = 'wrong_plugin';
  return { ...base, state, error: err || null, expiresAt: ent.expires_at || null };
}

function thirdPartyStatus(plugin, now) {
  const server = plugin.manifest && plugin.manifest.license ? plugin.manifest.license.server : null;
  const rec = registry.getLicense(plugin.id);
  const base = { kind: 'third_party', required: true, server };
  if (!rec || !rec.keyEncrypted) return { ...base, state: 'missing' };
  let keyMasked = null;
  try { keyMasked = mask(require('../../utils/crypto').decrypt(rec.keyEncrypted)); } catch { keyMasked = '••••'; }
  const st = rec.state || {};
  const out = { ...base, keyMasked, checkedAt: st.checked_at || null, lastOkAt: st.last_ok_at || null, expiresAt: st.expires_at || null };
  if (st.error === 'unreachable') {
    const r = retries.get(plugin.id);
    out.lastCheck = { at: st.checked_at || null, ok: false, reason: st.reason || null };
    out.nextCheckAt = r ? new Date(r.at).toISOString() : null;
  }
  if (st.valid !== true) {
    if (st.error === 'invalid') return { ...out, state: 'invalid' };
    if (st.error === 'unreachable') return { ...out, state: 'unreachable_new' };
    return { ...out, state: 'missing' };
  }
  const exp = expiryState(st.expires_at, now);
  if (exp === 'expired') return { ...out, state: 'expired' };
  if (st.error === 'unreachable') {
    const lastOk = Date.parse(st.last_ok_at || '') || 0;
    return { ...out, state: now - lastOk > GRACE_MS ? 'grace_over' : 'unreachable' };
  }
  return { ...out, state: exp };
}

/**
 * Licence state of an installed plugin.
 * @returns {{kind, required, state, licensed, keyMasked?, expiresAt?, server?, ...}}
 */
function status(plugin, now = Date.now()) {
  const m = plugin.manifest || {};
  const kind = kindOf(plugin);
  if (!m.license || !m.license.required) return { kind, required: false, state: 'not_required', licensed: true };
  const s = kind === 'first_party' ? firstPartyStatus(plugin, now) : thirdPartyStatus(plugin, now);
  return { ...s, licensed: LICENSED_STATES.has(s.state) };
}

async function defaultTransport(url, body) {
  const target = await netPolicy.checkTarget(url, { network: [new URL(url).host], lan: false });
  if (!target.ok) throw new Error('license server address refused: ' + target.reason);
  const res = await netPolicy.pinnedRequest({
    target, method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'GateControl-plugin-license' },
    timeoutMs: CHECK_TIMEOUT_MS, maxBytes: 64 * 1024,
  });
  let json = null;
  try { json = JSON.parse(res.body.toString('utf8')); } catch { json = null; }
  return { status: res.status, json, headers: res.headers || {} };
}

/**
 * Ask a third-party plugin's licence server (and store the answer).
 * @returns {Promise<object>} status() afterwards
 */
async function checkThirdParty(plugin, now = Date.now()) {
  const server = plugin.manifest && plugin.manifest.license && plugin.manifest.license.server;
  const rec = registry.getLicense(plugin.id);
  if (!server || !rec || !rec.keyEncrypted) return status(plugin, now);
  let key;
  try { key = require('../../utils/crypto').decrypt(rec.keyEncrypted); } catch { return status(plugin, now); }
  const prev = rec.state || {};
  const nowIso = new Date(now).toISOString();
  let next;
  // a failed check: short reason (no URL, key or body), retry soon or not
  let fail = null;
  try {
    if (new URL(server).protocol !== 'https:') {
      fail = { reason: 'https required', retry: false };
      throw new Error('license server must use https');
    }
    const res = await (transport || defaultTransport)(server, { license_key: key, plugin_id: plugin.id, server_id: serverId(server) });
    const j = res && res.json;
    if (res && res.status === 200 && j && typeof j.valid === 'boolean') {
      const expires = typeof j.expires_at === 'string' && Number.isFinite(Date.parse(j.expires_at)) ? new Date(Date.parse(j.expires_at)).toISOString() : null;
      next = j.valid
        ? { valid: true, expires_at: expires, checked_at: nowIso, last_ok_at: nowIso, error: null }
        : { valid: false, expires_at: expires, checked_at: nowIso, last_ok_at: prev.last_ok_at || null, error: 'invalid' };
    } else if (res && res.status >= 400 && res.status < 500 && j && j.valid === false) {
      next = { valid: false, expires_at: null, checked_at: nowIso, last_ok_at: prev.last_ok_at || null, error: 'invalid' };
    } else {
      const code = res && Number.isInteger(res.status) ? res.status : null;
      fail = code === null || code === 200
        ? { reason: 'malformed response', retry: true }
        : { reason: `HTTP ${code}`, retry: retryableStatus(code), retryAfterMs: parseRetryAfter(res.headers && res.headers['retry-after'], now) };
      throw new Error('unexpected answer');
    }
  } catch (err) {
    if (!fail) {
      fail = /address refused/.test(String(err && err.message))
        ? { reason: 'address refused', retry: true }
        : { reason: networkReason(err), retry: true };
    }
    next = { valid: prev.valid === true, expires_at: prev.expires_at || null, checked_at: nowIso, last_ok_at: prev.last_ok_at || null, error: 'unreachable',
      reason: fail.reason, fails: (prev.error === 'unreachable' ? Number(prev.fails) || 0 : 0) + 1 };
  }
  registry.setLicense(plugin.id, { state: next });
  // one warning per outage, one info when the server answers again
  if (next.error === 'unreachable' && prev.error !== 'unreachable') {
    logger.warn({ plugin: plugin.id, reason: next.reason }, 'plugin licence server unreachable');
  } else if (next.error !== 'unreachable' && prev.error === 'unreachable') {
    logger.info({ plugin: plugin.id }, 'plugin licence server reachable again');
  }
  planRetry(plugin.id, next.error === 'unreachable' && fail.retry ? backoffDelay(next.fails, fail.retryAfterMs) : null, now);
  return status(plugin, now);
}

/** (Re)plan the retry of a third-party check — `delay` null drops it. Never two timers for one plugin. */
function planRetry(id, delay, now = Date.now()) {
  const cur = retries.get(id);
  if (cur) { clearTimeout(cur.timer); retries.delete(id); }
  if (delay == null || !retriesOn) return;
  const timer = setTimeout(() => {
    retries.delete(id);
    const p = registry.get(id);
    if (!p) return; // uninstalled meanwhile
    checkThirdParty(p)
      .then(() => require('./index').reconcile())
      .catch(() => { /* recorded as unreachable */ });
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  retries.set(id, { timer, at: now + delay });
}

/** Retries of third-party checks on (plugins/index.js start) / off (stop). */
function startRetries() { retriesOn = true; }
function stopRetries() {
  retriesOn = false;
  for (const r of retries.values()) clearTimeout(r.timer);
  retries.clear();
}

/**
 * Does a masked key ("GCP-7HQ2-••••-K2M8") of the licence server belong to
 * `key`? The visible start and end must match (case-insensitive) and show
 * at least four letters or digits together; without a mask the keys must be equal.
 */
function maskMatches(masked, key) {
  if (typeof masked !== 'string' || typeof key !== 'string') return false;
  const m = masked.trim().toUpperCase();
  const k = key.trim().toUpperCase();
  if (!m || !k) return false;
  const bullets = /[•*…·]+|x{3,}/i;
  const parts = m.split(bullets);
  if (parts.length === 1) return m === k;
  const head = parts[0];
  const tail = parts[parts.length - 1];
  if ((head + tail).replace(/[^A-Z0-9]/g, '').length < 4) return false;
  return k.startsWith(head) && k.endsWith(tail) && k.length >= head.length + tail.length;
}

function validKey(key) {
  return typeof key === 'string' && KEY_RE.test(key.trim());
}

/**
 * Enter a licence key for a plugin. First-party: added to the plugin keys of
 * the GateControl licence and a licence refresh runs. Third-party: stored
 * encrypted and checked against the plugin's licence server.
 */
async function setKey(plugin, key, { refreshTimeoutMs = 20000 } = {}) {
  if (!validKey(key)) throw Object.assign(new Error('invalid licence key'), { code: 'invalid_key' });
  const k = key.trim();
  if (kindOf(plugin) === 'first_party') {
    const license = require('../license');
    const keys = license.getPluginKeys();
    if (!keys.includes(k)) license.setPluginKeys([...keys, k]);
    await Promise.race([
      Promise.resolve(license.refreshLicenseInBackground()).catch(() => {}),
      new Promise((r) => { const t = setTimeout(r, refreshTimeoutMs); t.unref(); }),
    ]);
    return status(plugin);
  }
  if (!plugin.manifest.license || !plugin.manifest.license.server) throw Object.assign(new Error('plugin has no licence server'), { code: 'no_license_server' });
  registry.setLicense(plugin.id, { keyEncrypted: require('../../utils/crypto').encrypt(k), state: null });
  return checkThirdParty(plugin);
}

/**
 * After the install or update of a first-party plugin that needs a licence:
 * no entitlement in the last validation, but a GateControl licence key is
 * configured → revalidate the licence once in the background (the plugin may
 * be newer than the last daily validation). Throttled to one run per
 * AUTO_REFRESH_GAP_MS; never for third-party plugins or without a key.
 * @returns {Promise<object>|null} status() after the revalidation, or null when none runs
 */
function revalidateIfMissing(plugin, now = Date.now()) {
  const m = plugin && plugin.manifest;
  if (!m || !m.license || !m.license.required || kindOf(plugin) !== 'first_party') return null;
  const license = require('../license');
  if (!license.hasLicenseKey()) return null;
  if (firstPartyStatus(plugin, now).state !== 'missing') return null;
  if (lastAutoRefresh && now - lastAutoRefresh < AUTO_REFRESH_GAP_MS) return null;
  lastAutoRefresh = now;
  return Promise.resolve()
    .then(() => (refreshFn || license.refreshLicenseInBackground)())
    .catch(() => {})
    .then(() => status(plugin));
}

// ─── Tier and seats (gc.license.info, since 1.206.0) ────
//
// A first-party licence token may name a tier — 'family', 'business' or
// 'combo' (both) — and seats: { included, family, business } (the people in
// the base price and the people booked on top, per kind). info() turns them
// into the most people of each kind the plugin may switch on:
//   family    family = included + extra family; business 0
//   business  business = included + extra business; family 0
//   combo     total = included + both extras; family ≤ included + extra family,
//             business ≤ included + extra business (the included ones are shared)
// The plugin counts its people itself; GateControl only says how many it may.

/** { total, family, business, included, extra: { family, business } } of a tier and its seats. */
function seatLimits(tier, seats) {
  const inc = seats ? seats.included : 0;
  const f = seats ? seats.family : 0;
  const b = seats ? seats.business : 0;
  if (tier === 'family') return { total: inc + f, family: inc + f, business: 0, included: inc, extra: { family: f, business: 0 } };
  if (tier === 'business') return { total: inc + b, family: 0, business: inc + b, included: inc, extra: { family: 0, business: b } };
  return { total: inc + f + b, family: inc + f, business: inc + b, included: inc, extra: { family: f, business: b } };
}

/**
 * gc.license.info() → { required, valid, state, expiresAt, source, tier, seats }.
 * tier / seats null: the licence names none (third-party, a plan or lifetime
 * entitlement, an older licence server, no licence needed) — the plugin
 * decides what that means for it.
 */
function info(plugin, now = Date.now()) {
  const s = status(plugin, now);
  const tier = s.licensed && s.tier ? s.tier : null;
  return {
    required: s.required, valid: s.licensed, state: s.state, expiresAt: s.expiresAt || null, source: s.source || null,
    tier, seats: tier ? seatLimits(tier, s.seats) : null,
  };
}

// gc.license.refresh(): after a purchase ("Personen hinzubuchen") the plugin
// asks for the new licence at once instead of at the next daily validation —
// at most once a minute (all plugins together), only with a GateControl
// licence key (first-party) or a stored key (third-party).
const REFRESH_GAP_MS = 60 * 1000;
let lastRefresh = 0;

/** → { refreshed: boolean, ...info() } */
async function refresh(plugin, { now = Date.now(), timeoutMs = 20000 } = {}) {
  const m = plugin && plugin.manifest;
  const needed = !!(m && m.license && m.license.required);
  if (!needed || (lastRefresh && now - lastRefresh < REFRESH_GAP_MS)) return { refreshed: false, ...info(plugin) };
  if (kindOf(plugin) === 'first_party') {
    const license = require('../license');
    if (!license.hasLicenseKey()) return { refreshed: false, ...info(plugin) };
    lastRefresh = now;
    let done = false;
    await Promise.race([
      Promise.resolve().then(() => (refreshFn || license.refreshLicenseInBackground)()).then(() => { done = true; }, () => {}),
      new Promise((r) => { const t = setTimeout(r, timeoutMs); t.unref(); }),
    ]);
    // entitlements may have changed: start / stop plugins now, not at the next reconcile
    if (done) { try { await require('./index').reconcile(); } catch { /* plugins keep their state */ } }
    return { refreshed: done, ...info(plugin) };
  }
  const rec = registry.getLicense(plugin.id);
  if (!rec || !rec.keyEncrypted) return { refreshed: false, ...info(plugin) };
  lastRefresh = now;
  await checkThirdParty(plugin);
  return { refreshed: true, ...info(plugin) };
}

function _setRefreshForTest(fn) {
  if (process.env.NODE_ENV !== 'test') return;
  refreshFn = fn;
  lastAutoRefresh = 0;
  lastRefresh = 0;
}

function _setTransportForTest(fn) {
  if (process.env.NODE_ENV === 'test') transport = fn;
}

module.exports = {
  status, info, refresh, seatLimits, checkThirdParty, setKey, revalidateIfMissing, serverId, REFRESH_GAP_MS, kindOf, mask, maskMatches, validKey, GRACE_MS, LICENSED_STATES, AUTO_REFRESH_GAP_MS,
  startRetries, stopRetries,
  _setTransportForTest, _setRefreshForTest,
};
