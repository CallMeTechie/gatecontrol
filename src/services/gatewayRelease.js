'use strict';
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const logger = require('../utils/logger');

const REPO = process.env.GC_GATEWAY_REPO || 'CallMeTechie/gatecontrol-gateway';
const TOKEN = process.env.GC_CLIENT_GITHUB_TOKEN || '';
const CACHE_TTL = 60 * 60 * 1000;
const MAX_BODY = 200 * 1024;

const PERSIST_FILE = process.env.GC_GATEWAY_LATEST_CACHE
  || path.join(path.dirname(process.env.GC_DB_PATH || path.join(__dirname, '..', '..', 'data', 'gatecontrol.db')), 'gateway-latest-version.json');

function _loadPersisted() {
  try { const v = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8')).version; if (v && typeof v === 'string') return v; } catch (_e) { /* none */ }
  return null;
}

function _persist(v) {
  try { fs.writeFileSync(PERSIST_FILE, JSON.stringify({ version: v, savedAt: Date.now() })); }
  catch (err) { logger.warn({ err: err.message }, 'gateway release persist failed'); }
}

let cache = { version: _loadPersisted(), fetchedAt: 0 };
let inFlight = false;
let fetchCalls = 0;

function _normalizeTag(tag) { return tag ? String(tag).trim().replace(/^v/i, '') : null; }

function _fetchLatest() {
  fetchCalls += 1;
  if (inFlight || process.env.NODE_ENV === 'test') return; // never fire a real request in tests
  inFlight = true;
  const headers = { 'User-Agent': 'GateControl', Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const req = https.get(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, timeout: 5000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); inFlight = false; logger.warn({ status: res.statusCode }, 'gateway release fetch non-200'); return; }
    let body = '';
    res.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    res.on('end', () => {
      inFlight = false;
      try {
        const v = _normalizeTag(JSON.parse(body).tag_name);
        if (v) { cache = { version: v, fetchedAt: Date.now() }; _persist(v); }
      }
      catch (err) { logger.warn({ err: err.message }, 'gateway release parse failed'); }
    });
  });
  req.on('error', (err) => { inFlight = false; logger.warn({ err: err.message }, 'gateway release fetch failed'); });
  req.on('timeout', () => { req.destroy(); inFlight = false; });
}

// Immediate: cached/last-known version (or null); triggers a background refresh
// when stale. NEVER blocks the caller on a live fetch.
function getLatestVersion() {
  if (Date.now() - cache.fetchedAt > CACHE_TTL) _fetchLatest();
  return cache.version;
}

// Warm-start: fetch immediately, then retry a few times on a delay if the
// fetch hasn't succeeded yet (cache.fetchedAt still 0). Survives a transient
// boot-time network blip (e.g. "socket hang up") so the persisted cache is
// populated without waiting for the first dashboard request. Timers are
// unref'd so they never keep the process (or test runner) alive.
const INIT_RETRY_DELAY = Number(process.env.GC_GATEWAY_LATEST_RETRY_MS) || 30000;
const INIT_MAX_RETRIES = 3;

function init(retriesLeft = INIT_MAX_RETRIES) {
  _fetchLatest();
  if (retriesLeft <= 0) return;
  const t = setTimeout(() => {
    if (cache.fetchedAt === 0) init(retriesLeft - 1); // only retry while still unwarmed
  }, INIT_RETRY_DELAY);
  if (t && typeof t.unref === 'function') t.unref();
}

module.exports = {
  getLatestVersion,
  _normalizeTag,
  _fetchLatest,
  _setCache: (v) => { cache = { version: v, fetchedAt: Date.now() }; _persist(v); },
  init,
  _loadPersisted,
  _persist,
  _fetchCallCount: () => fetchCalls,
};
