'use strict';

// Tile relay for the map frames of ui.maps plugins (docs/plugins.md "Maps").
//
// A plugin frame is sandboxed without allow-same-origin: its document has an
// opaque origin, and Chromium sends no Referer at all from such a document,
// whatever the Referrer-Policy says. OpenStreetMap refuses referrer-less tile
// requests (403 "App is not following the tile usage policy"), so a frame
// loading https://tile.openstreetmap.org directly shows nothing but error
// tiles. The frame loads them from this server instead:
//
//   GET /plugins/_shared/tiles/<token>/<z>/<x>/<y>.png
//
//   * no session (the frame sends no cookies); the token is the permission:
//     `<exp>.<sig>`, exp = unix seconds of the next full hour + 24 h (the URL
//     stays the same for an hour, so the browser cache works), sig = HMAC-
//     SHA256 over `plugin-tiles:<exp>` with the server secret (GC_SECRET,
//     persisted by the entrypoint), base64url, SIG_LEN characters. Valid
//     while now < exp <= now + 26 h — a URL copied out of a frame stops
//     working after a day, nobody can mint one without the secret;
//   * upstream with a User-Agent naming GateControl (OSM's tile policy: the
//     application identifies itself), at most MAX_ACTIVE requests at a time
//     (the rest waits in a bounded queue), one fetch per tile however many
//     frames ask for it at once;
//   * cached in memory (LRU, CACHE_MAX_BYTES) for the upstream max-age,
//     clamped to [1 day, 7 days]; when the upstream fails, a stale copy is
//     served if there is one. Only 200 image/png is kept.

const crypto = require('node:crypto');
const config = require('../../../config/default');
const logger = require('../../utils/logger');
const { version } = require('../../../package.json');

const UPSTREAM = 'https://tile.openstreetmap.org';
const PREFIX = '/plugins/_shared/tiles/';
const USER_AGENT = `GateControl/${version} (+https://github.com/CallMeTechie/gatecontrol)`;
const SIG_LEN = 22;
const TOKEN_MAX_AHEAD_S = 26 * 3600;
const MAX_ZOOM = 19;
const TIMEOUT_MS = 10 * 1000;
const MAX_ACTIVE = 2;
const MAX_QUEUE = 256;
const MAX_TILE_BYTES = 512 * 1024;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MIN_TTL_MS = 24 * 3600 * 1000;
const MAX_TTL_MS = 7 * 24 * 3600 * 1000;
const LOG_EVERY_MS = 60 * 1000;
const TOKEN_RE = /^(\d{1,12})\.([A-Za-z0-9_-]+)$/;
const NUM_RE = /^\d{1,7}$/;

function sign(exp) {
  return crypto.createHmac('sha256', String(config.app.secret)).update(`plugin-tiles:${exp}`).digest('base64url').slice(0, SIG_LEN);
}

/** `<exp>.<sig>` valid until the next full hour + 24 h. */
function token(now = Date.now()) {
  const exp = (Math.floor(now / 3600000) + 1) * 3600 + 24 * 3600;
  return `${exp}.${sign(exp)}`;
}

function verify(tok, now = Date.now()) {
  const m = TOKEN_RE.exec(String(tok || ''));
  if (!m || m[2].length !== SIG_LEN) return false;
  const exp = Number(m[1]);
  const s = Math.floor(now / 1000);
  if (!(s < exp && exp <= s + TOKEN_MAX_AHEAD_S)) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(exp)));
}

/** The Leaflet URL template a map frame gets as window.GC.tiles. */
function template(now = Date.now()) { return `${PREFIX}${token(now)}/{z}/{x}/{y}.png`; }

/** { z, x, y } as numbers, or null outside 0 ≤ z ≤ 19, 0 ≤ x, y < 2^z. */
function coords(z, x, y) {
  if (![z, x, y].every((v) => NUM_RE.test(String(v)))) return null;
  const c = { z: Number(z), x: Number(x), y: Number(y) };
  const n = 2 ** c.z;
  return c.z <= MAX_ZOOM && c.x < n && c.y < n ? c : null;
}

// ─── cache (LRU by bytes; Map order = use order) ──

const cache = new Map();
let cacheBytes = 0;

function remember(key, body, ttlMs) {
  const old = cache.get(key);
  if (old) { cacheBytes -= old.body.length; cache.delete(key); }
  cache.set(key, { body, expires: Date.now() + ttlMs });
  cacheBytes += body.length;
  for (const [k, e] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    cacheBytes -= e.body.length;
  }
}

function lookup(key) {
  const e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); }
  return e || null;
}

function ttlOf(cacheControl) {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(String(cacheControl || ''));
  const ms = m ? Number(m[1]) * 1000 : 0;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ms));
}

// ─── upstream (MAX_ACTIVE at a time, one fetch per tile) ──

let active = 0;
const queue = [];
const inflight = new Map();
let lastLog = 0;

function logFailure(key, reason) {
  const now = Date.now();
  if (now - lastLog < LOG_EVERY_MS) return;
  lastLog = now;
  logger.warn({ tile: key, reason }, 'plugin tiles: upstream request failed');
}

function slot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < MAX_ACTIVE) run();
    else if (queue.length < MAX_QUEUE) queue.push(run);
    else reject(new Error('queue full'));
  });
}

class UpstreamError extends Error {
  constructor(reason, status) { super(reason); this.status = status || 0; }
}

async function download(c) {
  const res = await globalThis.fetch(`${UPSTREAM}/${c.z}/${c.x}/${c.y}.png`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/png' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new UpstreamError(`status ${res.status}`, res.status);
  }
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'image/png' || Number(res.headers.get('content-length') || 0) > MAX_TILE_BYTES) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new UpstreamError(type !== 'image/png' ? `content-type ${type || '-'}` : 'too large');
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_TILE_BYTES) throw new UpstreamError('too large');
  return { body, ttl: ttlOf(res.headers.get('cache-control')) };
}

/**
 * The tile z/x/y (validated by coords()): { status: 200, body } fresh or
 * from the cache (also stale when the upstream fails), { status: 404 } when
 * the upstream has none, { status: 502 } otherwise.
 */
async function get(c) {
  const key = `${c.z}/${c.x}/${c.y}`;
  const hit = lookup(key);
  if (hit && hit.expires > Date.now()) return { status: 200, body: hit.body };
  let p = inflight.get(key);
  if (!p) {
    p = slot(() => download(c))
      .then((r) => { remember(key, r.body, r.ttl); return r.body; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    return { status: 200, body: await p };
  } catch (e) {
    if (e && e.status === 404) return { status: 404 };
    logFailure(key, (e && e.name === 'TimeoutError') ? 'timeout' : String((e && e.message) || e));
    const stale = cache.get(key);
    return stale ? { status: 200, body: stale.body, stale: true } : { status: 502 };
  }
}

/** Tests: forget the cache, the queue and the log throttle. */
function _reset() {
  cache.clear();
  cacheBytes = 0;
  inflight.clear();
  queue.length = 0;
  lastLog = 0;
}

function _stats() { return { entries: cache.size, bytes: cacheBytes, active, queued: queue.length }; }

module.exports = { PREFIX, UPSTREAM, USER_AGENT, SIG_LEN, MAX_ACTIVE, CACHE_MAX_BYTES, token, verify, template, coords, get, ttlOf, _reset, _stats };
