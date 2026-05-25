'use strict';
const https = require('node:https');
const logger = require('../utils/logger');

const REPO = process.env.GC_GATEWAY_REPO || 'CallMeTechie/gatecontrol-gateway';
const TOKEN = process.env.GC_CLIENT_GITHUB_TOKEN || '';
const CACHE_TTL = 60 * 60 * 1000;
const MAX_BODY = 200 * 1024;

let cache = { version: null, fetchedAt: 0 };
let inFlight = false;

function _normalizeTag(tag) { return tag ? String(tag).trim().replace(/^v/i, '') : null; }

function _fetchLatest() {
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
      try { const v = _normalizeTag(JSON.parse(body).tag_name); if (v) cache = { version: v, fetchedAt: Date.now() }; }
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

module.exports = { getLatestVersion, _normalizeTag, _fetchLatest, _setCache: (v) => { cache = { version: v, fetchedAt: Date.now() }; } };
