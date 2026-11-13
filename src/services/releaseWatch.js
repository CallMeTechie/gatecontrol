'use strict';

// The newest release of GateControl itself and of the apps (Android, Windows
// Pro, Windows Community; per update channel) — for the "Updates" card of the
// dashboard and the "App veraltet" filter of the peers list.
//
// Same pattern as services/gatewayRelease.js: the answer always comes from the
// cache (memory, and a small file that survives a restart); a stale entry is
// refreshed in the background, never on the caller's time. One hour between
// checks, after a failure 30 s doubling up to 30 min. The fetch itself is the
// one the client update routes use (routes/api/client/update.js
// fetchReleaseResult: ETag, rate limit, redirects on GitHub's hosts) — no
// second GitHub client here.
//
// There is no timer: refresh() is called by the readers (the dashboard card,
// once after the start by init()). Entries are fetched one after another.
//
// Disk: latest-releases.json next to the database, written only when a
// version changed (and at most once a day to keep "last checked" roughly
// right across a restart) — asynchronously, never in a request.

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');
const { compareSemver } = require('../utils/version');

const PRODUCTS = Object.freeze(['server', 'android', 'pro', 'community']);
const CHANNELS = Object.freeze(['stable', 'beta']);
const CACHE_TTL = 60 * 60 * 1000;
const BACKOFF_MIN_MS = 30 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
// "Erneut prüfen": at most one forced attempt per entry in this time
const FORCE_MIN_MS = 60 * 1000;
// an unchanged version is written again after this time (keeps checked_at of the file recent)
const PERSIST_REFRESH_MS = 24 * 60 * 60 * 1000;
const INIT_DELAY_MS = Number(process.env.GC_LATEST_RELEASES_INIT_MS) || 75 * 1000;

const PERSIST_FILE = process.env.GC_LATEST_RELEASES_CACHE
  || path.join(path.dirname(process.env.GC_DB_PATH || path.join(__dirname, '..', '..', 'data', 'gatecontrol.db')), 'latest-releases.json');

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;

function keyOf(product, channel = 'stable') { return `${product}:${channel}`; }

function validKey(key) {
  const [product, channel, rest] = String(key).split(':');
  if (rest !== undefined || !PRODUCTS.includes(product) || !CHANNELS.includes(channel)) return false;
  return product !== 'server' || channel === 'stable';
}

/** 'v1.2.3' → '1.2.3' (pre-release kept, build metadata dropped), or null. */
function normalizeTag(tag) {
  if (typeof tag !== 'string') return null;
  const v = tag.trim().replace(/^v/i, '').replace(/\+.*$/, '');
  return VERSION_RE.test(v) ? v : null;
}

/** Only a link to a release page on github.com is handed to the browser. */
function releaseUrl(u) {
  return typeof u === 'string' && u.length <= 300 && /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/releases\/tag\/[A-Za-z0-9_.+-]{1,80}$/.test(u) ? u : null;
}

function blank() {
  return { version: null, url: null, checkedAt: 0, fetchedAt: 0, attemptAt: 0, failedAt: 0, reason: null, failures: 0, backoffMs: 0, nextTryAt: 0 };
}

const entries = new Map(); // key → entry
let persisted = new Map(); // key → { version, url, checkedAt } as in the file
let fetchOverride = null;  // tests: (product, channel) => Promise<{ ok, data, reason }>
let writes = 0;

function entry(key) {
  if (!entries.has(key)) entries.set(key, blank());
  return entries.get(key);
}

function loadPersisted(now = Date.now()) {
  entries.clear();
  persisted = new Map();
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8')); } catch { doc = null; }
  const list = doc && typeof doc === 'object' && doc.releases && typeof doc.releases === 'object' ? doc.releases : {};
  for (const [key, r] of Object.entries(list)) {
    if (!validKey(key) || !r || typeof r !== 'object') continue;
    const version = normalizeTag(r.version);
    if (!version) continue;
    const checkedAt = Number.isFinite(r.checkedAt) && r.checkedAt > 0 && r.checkedAt <= now ? r.checkedAt : 0;
    const e = entry(key);
    e.version = version;
    e.url = releaseUrl(r.url);
    e.checkedAt = checkedAt;
    persisted.set(key, { version, url: e.url, checkedAt });
  }
}

/** Write the file when a version changed or the stored check time is a day old. Async, never throws. */
async function persistIfChanged(now = Date.now()) {
  let dirty = false;
  const next = new Map();
  for (const [key, e] of entries) {
    if (!e.version) continue;
    next.set(key, { version: e.version, url: e.url, checkedAt: e.checkedAt });
    const old = persisted.get(key);
    if (!old || old.version !== e.version || old.url !== e.url || now - (old.checkedAt || 0) > PERSIST_REFRESH_MS) dirty = true;
  }
  if (!dirty) return false;
  const tmp = `${PERSIST_FILE}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify({ releases: Object.fromEntries(next) }));
    await fs.promises.rename(tmp, PERSIST_FILE);
    persisted = next;
    writes += 1;
    return true;
  } catch (err) {
    fs.promises.unlink(tmp).catch(() => {});
    logger.warn({ err: err.message }, 'latest releases: cache file not written');
    return false;
  }
}

function fetcher() {
  if (fetchOverride) return fetchOverride;
  if (process.env.NODE_ENV === 'test') return null; // never a real request in tests
  return require('../routes/api/client/update')._internals.fetchReleaseResult;
}

function due(e, now, force) {
  if (force) return now - e.attemptAt >= FORCE_MIN_MS;
  return now - e.fetchedAt > CACHE_TTL && now >= e.nextTryAt;
}

function noteFailure(e, reason, now) {
  e.failures += 1;
  e.failedAt = now;
  e.reason = reason || 'unreachable';
  e.backoffMs = Math.min(BACKOFF_MAX_MS, e.backoffMs ? e.backoffMs * 2 : BACKOFF_MIN_MS);
  e.nextTryAt = now + e.backoffMs;
}

async function fetchOne(key, fn) {
  const e = entry(key);
  const [product, channel] = key.split(':');
  e.attemptAt = Date.now();
  let r;
  try { r = await fn(product, channel); } catch (err) { r = { ok: false, data: null, reason: 'unreachable', err: err && err.message }; }
  const now = Date.now();
  if (!r || !r.ok) return noteFailure(e, r && r.reason, now);
  // GitHub answered: a repository without a (readable) release keeps the version it had
  const version = r.data ? normalizeTag(r.data.tag_name) : null;
  if (version) { e.version = version; e.url = releaseUrl(r.data.html_url); }
  e.fetchedAt = now;
  e.checkedAt = now;
  e.failedAt = 0; e.reason = null; e.failures = 0; e.backoffMs = 0; e.nextTryAt = 0;
  return undefined;
}

const queue = new Set();
let current = null; // the key being fetched right now — not queued a second time
let draining = null;
let fetchCalls = 0;

async function drain(fn) {
  try {
    while (queue.size) {
      const key = queue.values().next().value;
      queue.delete(key);
      fetchCalls += 1;
      current = key;
      await fetchOne(key, fn);
      current = null;
    }
    await persistIfChanged();
  } catch (err) {
    logger.warn({ err: err.message }, 'latest releases: refresh failed');
  } finally {
    current = null;
    draining = null;
  }
}

/**
 * Refresh the entries of `keys` that are due (older than an hour and not in a
 * back-off; `force`: at most one attempt a minute, whatever the age) — in the
 * background. Returns at once; the promise is for tests.
 */
function refresh(keys, { force = false } = {}) {
  const fn = fetcher();
  if (!fn) return Promise.resolve(false);
  const now = Date.now();
  for (const key of keys || []) {
    if (validKey(key) && key !== current && due(entry(key), now, force)) queue.add(key);
  }
  if (!queue.size) return draining || Promise.resolve(false);
  if (!draining) draining = drain(fn);
  return draining;
}

/**
 * What is known about a release — no fetch, no side effect.
 * → { version, url, checked_at, failed, failed_at, reason } (times in ms or null)
 */
function get(product, channel = 'stable') {
  const e = entries.get(keyOf(product, channel));
  if (!e) return { version: null, url: null, checked_at: null, failed: false, failed_at: null, reason: null };
  return {
    version: e.version, url: e.url, checked_at: e.checkedAt || null,
    failed: e.failures > 0, failed_at: e.failures > 0 ? e.failedAt : null, reason: e.failures > 0 ? e.reason : null,
  };
}

/** The newest known version of an app for a channel, or null. */
function latestVersion(product, channel = 'stable') {
  const e = entries.get(keyOf(product, channel));
  return e ? e.version : null;
}

/**
 * true: `version` is older than the newest known release of the product and
 * channel; false: it is that release or newer; null: not comparable (nothing
 * known, or a version that is not x.y.z).
 */
function isOutdated(product, channel, version) {
  const latest = latestVersion(product, channel);
  if (!latest || !version) return null;
  const c = compareSemver(version, latest);
  return c === null ? null : c < 0;
}

// Once after the start, so the first dashboard view already has an answer.
// `wanted` → the keys in use (services/dashboardUpdates.js wantedKeys).
function init(wanted) {
  const t = setTimeout(() => {
    try { refresh(typeof wanted === 'function' ? wanted() : wanted); }
    catch (err) { logger.debug({ err: err.message }, 'latest releases: first check not started'); }
  }, INIT_DELAY_MS);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

loadPersisted();

module.exports = {
  PRODUCTS, CHANNELS, CACHE_TTL, BACKOFF_MIN_MS, BACKOFF_MAX_MS, FORCE_MIN_MS, PERSIST_FILE,
  keyOf, normalizeTag, get, latestVersion, isOutdated, refresh, init,
  _setFetch: (fn) => { fetchOverride = fn || null; },
  _fetchCallCount: () => fetchCalls,
  _writeCount: () => writes,
  _entry: (key) => entry(key),
  _persistIfChanged: persistIfChanged,
  _reload: () => { queue.clear(); loadPersisted(); },
  _resetForTest: () => { entries.clear(); persisted = new Map(); queue.clear(); draining = null; current = null; fetchOverride = null; fetchCalls = 0; writes = 0; },
};
