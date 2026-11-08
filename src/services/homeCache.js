'use strict';

// Home cache of a gateway (phase 3b, contract §2): frequently used files lie
// on the gateway as well; apps in the home network load them from there at
// LAN speed instead of through the server in the internet. The server still
// decides who may load what — the gateway only hands out a file against a
// short-lived signature the server gave to that client (lanHint).
//
//   settings (gateway_cache, migration 129)
//     enabled, maxBytes, kinds { drive, photos, updates, vault } and a
//     secret per gateway
//     (encrypted at rest, only in the config pull, never in the UI). The
//     folder is always the gateway's volume /cache (gateway side 14): where
//     it lies on the host is set at the gateway (Docker GC_CACHE_DIR, Pi
//     settings.txt CACHE_DIR=) — the tab only explains it
//   the stock ("Vorrat", home_cache_blobs): content-addressed (sha256) —
//     app updates the server delivers (Android app, Windows clients: kept in
//     <data>/home-cache/updates, refreshUpdates), files plugins offer
//     (gc.homeCache.offer: their media, plugins/media.js) and, since 1.249.0,
//     GateControl's previews of those files (offer({ preview: 'small' |
//     'large' }), source 'preview': the plaintext JPEG of
//     plugins/mediaPreviews.js, content-addressed like everything else)
//   what a gateway holds (home_cache_have) and its counters (cache_stats_day)
//
//   GET  /api/v1/gateway/cache/want           want(peerId)  → the stock for this gateway
//   GET  /api/v1/gateway/cache/blob/<sha256>  sendBlob()    → bytes (Range), only of its stock
//   POST /api/v1/gateway/cache                report()      → have / gone, counters
//
// lan hint for a client in the home network (homeNetwork.check → site of a
// gateway that holds the blob): { url, sha256, tlsSha256, exp } with
// sig = HMAC-SHA256(secret, sha256 + "\n" + exp) as lowercase hex, the key
// being the secret as UTF-8 text (contract server side 9).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { Readable } = require('node:stream');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const KINDS = ['drive', 'photos', 'updates', 'vault'];
const SHA_RE = /^[0-9a-f]{64}$/;
const GB = 1024 * 1024 * 1024;
const MIN_BYTES = 1 * GB;
const MAX_BYTES = 4096 * GB;
const SIZES_GB = [5, 10, 20, 50, 100, 200, 500];
// the gateway takes up to 20 000 (fetcher MAX_WANT_ITEMS); previews are many and small
const WANT_MAX = 20000;
const LIST_MAX = 5000;
const BLOB_PARALLEL = 2;
const HINT_TTL_S = 600;
const HINTS_MAX = 500;
const PREVIEW_SIZES = ['small', 'large'];
// the stock of a gateway for its blob requests (a sync of thousands of previews asks once a blob)
const STOCK_MEMO_MS = 15000;
const UPDATE_MAX_BYTES = 1024 * 1024 * 1024;
const UPDATE_KEEP_MS = 7 * 24 * 3600 * 1000;
// the folder inside the gateway container (its volume; anything else: state path_not_allowed)
const CACHE_PATH = '/cache';
const STATES = ['running', 'starting', 'port_busy', 'no_address', 'path_unwritable', 'path_not_allowed', 'no_secret', 'error', 'off'];

const DEFAULTS = Object.freeze({ enabled: false, maxBytes: 20 * GB, kinds: Object.freeze({ drive: true, photos: true, updates: true, vault: false }) });

class CacheError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function bool(v, d) { return typeof v === 'boolean' ? v : d; }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }

/** Stored settings (any shape) → the complete, valid settings. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const k = r.kinds && typeof r.kinds === 'object' ? r.kinds : {};
  const max = Number.isSafeInteger(r.maxBytes) && r.maxBytes >= MIN_BYTES && r.maxBytes <= MAX_BYTES ? r.maxBytes : DEFAULTS.maxBytes;
  return {
    enabled: bool(r.enabled, false),
    maxBytes: max,
    kinds: { drive: bool(k.drive, true), photos: bool(k.photos, true), updates: bool(k.updates, true), vault: bool(k.vault, false) },
  };
}

function row(peerId) { return db().prepare('SELECT * FROM gateway_cache WHERE peer_id = ?').get(peerId) || null; }

function get(peerId) {
  const r = row(peerId);
  return normalize(r ? json(r.settings) : null);
}

function needGateway(peerId) {
  try { return require('./gatewayFeatures').needGateway(peerId); } catch (e) {
    if (e && e.code === 'not_found') throw new CacheError('not_found', 'gateway not found');
    throw e;
  }
}

/** The gateway's secret (made on first use; encrypted at rest). */
function secretOf(peerId, create = true) {
  const { encrypt, decrypt } = require('../utils/crypto');
  const r = row(peerId);
  if (r && r.secret_enc) {
    try { return decrypt(r.secret_enc); } catch (e) { logger.warn({ err: e.message, peerId }, 'home cache secret unreadable — a new one is made'); }
  }
  if (!create) return null;
  const s = crypto.randomBytes(32).toString('hex');
  db().prepare(`INSERT INTO gateway_cache (peer_id, settings, secret_enc, updated_at) VALUES (?, '{}', ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET secret_enc = excluded.secret_enc`).run(peerId, encrypt(s), Date.now());
  return s;
}

/** PUT …/cache { enabled?, maxBytes?, kinds? } → settings */
function set(peerId, patch, { ip, user } = {}) {
  const g = needGateway(peerId);
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) throw new CacheError('invalid', 'invalid body');
  const before = get(g.id);
  const out = JSON.parse(JSON.stringify(before));
  let any = false;
  for (const [k, v] of Object.entries(p)) {
    any = true;
    if (k === 'enabled') {
      if (typeof v !== 'boolean') throw new CacheError('invalid', 'enabled must be true or false');
      out.enabled = v;
    } else if (k === 'maxBytes') {
      if (!Number.isSafeInteger(v) || v < MIN_BYTES || v > MAX_BYTES) throw new CacheError('invalid', 'maxBytes: 1 GB … 4 TB');
      out.maxBytes = v;
    } else if (k === 'kinds') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CacheError('invalid', 'kinds: object');
      for (const [f, val] of Object.entries(v)) {
        if (!KINDS.includes(f)) throw new CacheError('invalid', `kinds.${f}: unknown`);
        if (typeof val !== 'boolean') throw new CacheError('invalid', `kinds.${f} must be true or false`);
        out.kinds[f] = val;
      }
    } else throw new CacheError('invalid', `${k}: unknown`);
  }
  if (!any) throw new CacheError('invalid', 'nothing to change');
  const after = normalize(out);
  if (JSON.stringify(before) === JSON.stringify(after)) return after;
  db().prepare(`INSERT INTO gateway_cache (peer_id, settings, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`).run(g.id, JSON.stringify(after), Date.now());
  if (after.enabled) secretOf(g.id, true);
  const changed = ['enabled', 'maxBytes', 'kinds'].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  try {
    require('./activity').log('gateway_cache_changed', `Home cache settings changed on "${g.name}" (${changed.join(', ')})`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, ...(user ? { user } : {}), changed, settings: after },
    });
  } catch { /* best-effort */ }
  require('./gatewayFeatures').notifyGateway(g.id);
  // switched on with app updates: fetch them soon (not in this request)
  if (after.enabled && after.kinds.updates && process.env.NODE_ENV !== 'test') setTimeout(() => { refreshUpdates().catch(() => {}); }, 2000).unref();
  return after;
}

/** `features.cache` of the config pull (off: only { enabled: false }, no secret). */
function configPayload(peerId) {
  const s = get(peerId);
  if (!s.enabled) return { enabled: false };
  return { enabled: true, path: CACHE_PATH, maxBytes: s.maxBytes, kinds: { ...s.kinds }, secret: secretOf(peerId, true) };
}

// ─── The stock ─────────────────────────────────────────────────────────

/**
 * People with devices in this gateway's home network (network watch owners on
 * any gateway of it — homeNetwork.gatewayHomes()) — whose files it may keep.
 * A failover gateway that has not scanned a person's phone yet keeps their
 * files as well.
 */
function peopleAt(peerId) {
  let ids;
  try { ids = require('./homeNetwork').homeOf(peerId); } catch { ids = [Number(peerId)]; }
  return new Set(db().prepare(`SELECT DISTINCT owner_user_id FROM netwatch_devices WHERE owner_user_id IS NOT NULL AND peer_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids).map((r) => r.owner_user_id));
}

function blobFits(b, s, people) {
  if (!s.kinds[b.kind]) return false;
  const users = json(b.user_ids);
  if (Array.isArray(users) && users.length && !users.some((u) => people.has(u))) return false;
  return true;
}

/** The stock of one gateway: [{ sha256, size, kind, priority }] (priority first, within maxBytes). */
function stockOf(peerId, s = get(peerId)) {
  if (!s.enabled) return [];
  const people = peopleAt(peerId);
  const rows = db().prepare('SELECT * FROM home_cache_blobs ORDER BY priority DESC, updated_at DESC, sha256').all();
  const out = [];
  let sum = 0;
  for (const b of rows) {
    if (!blobFits(b, s, people)) continue;
    if (sum + b.size > s.maxBytes) continue;
    sum += b.size;
    out.push(b);
    if (out.length >= WANT_MAX) break;
  }
  return out;
}

const stockMemo = new Map(); // peerId → { at, key, shas }

/** The sha256 values of a gateway's stock, remembered a few seconds (blob requests of one sync). */
function stockShas(peerId, s) {
  const key = JSON.stringify(s);
  const m = stockMemo.get(peerId);
  if (m && m.key === key && Date.now() - m.at < STOCK_MEMO_MS) return m.shas;
  const shas = new Set(stockOf(peerId, s).map((b) => b.sha256));
  if (stockMemo.size > 1000) stockMemo.clear();
  stockMemo.set(peerId, { at: Date.now(), key, shas });
  return shas;
}

/** The stock changed (an offer, a withdrawal, the clean-up). */
function stockChanged() { stockMemo.clear(); }

/** GET /cache/want → { maxBytes, items, etag } */
function want(peerId) {
  const s = get(peerId);
  const items = stockOf(peerId, s).map((b) => ({ sha256: b.sha256, size: b.size, kind: b.kind, priority: b.priority }));
  const etag = '"' + crypto.createHash('sha256').update(JSON.stringify([s.enabled, s.maxBytes, items])).digest('hex').slice(0, 32) + '"';
  return { maxBytes: s.maxBytes, items, etag };
}

const inflight = new Map(); // peerId → open blob streams

/** The plaintext of a preview blob, checked against its sha256 (a device preview sent again is other content). */
async function previewBytes(b) {
  const r = require('./plugins/media').row(b.plugin_id, b.media_id);
  const buf = r ? await require('./plugins/mediaPreviews').plain(r, b.label) : null;
  if (!buf || buf.length !== b.size || crypto.createHash('sha256').update(buf).digest('hex') !== b.sha256) {
    throw new CacheError('not_found', 'the preview is gone or changed');
  }
  return buf;
}

function blobSource(b, start, end, bytes) {
  if (b.source === 'update') {
    return fs.createReadStream(b.file, { start, end });
  }
  if (b.source === 'preview') return Readable.from([bytes.subarray(start, end + 1)]);
  const media = require('./plugins/media');
  const r = media.row(b.plugin_id, b.media_id);
  if (!r) throw new CacheError('not_found', 'the file is gone');
  return Readable.from(media.readRange(r, start, end));
}

/**
 * GET /cache/blob/<sha256>: the bytes of a blob in this gateway's stock,
 * streamed (Range → 206). Never a blob of another gateway's stock.
 */
async function sendBlob(peerId, sha, req, res) {
  const id = String(sha || '').toLowerCase();
  if (!SHA_RE.test(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  const s = get(peerId);
  const b = s.enabled ? db().prepare('SELECT * FROM home_cache_blobs WHERE sha256 = ?').get(id) : null;
  if (!b || !blobFits(b, s, peopleAt(peerId)) || !stockShas(peerId, s).has(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  if (b.source === 'update' && !(b.file && fs.existsSync(b.file))) return res.status(404).json({ ok: false, error: 'not_found' });
  // a preview is small: read (and checked) before the answer starts
  let bytes = null;
  if (b.source === 'preview') {
    try { bytes = await previewBytes(b); } catch { return res.status(404).json({ ok: false, error: 'not_found' }); }
  }
  const media = require('./plugins/media');
  const range = media.parseRange(req.headers.range, b.size);
  if (range === false) {
    res.set('Content-Range', `bytes */${b.size}`);
    return res.status(416).end();
  }
  const n = inflight.get(peerId) || 0;
  if (n >= BLOB_PARALLEL) return res.status(429).json({ ok: false, error: 'busy' });
  const start = range ? range.start : 0;
  const end = range ? range.end : b.size - 1;
  let src;
  try { src = b.size ? blobSource(b, start, end, bytes) : Readable.from([]); } catch (e) {
    return res.status(e && e.code === 'not_found' ? 404 : 500).json({ ok: false, error: e && e.code === 'not_found' ? 'not_found' : 'internal' });
  }
  inflight.set(peerId, n + 1);
  let done = false;
  const release = () => { if (done) return; done = true; const m = (inflight.get(peerId) || 1) - 1; if (m > 0) inflight.set(peerId, m); else inflight.delete(peerId); };
  res.on('close', release);
  res.status(range ? 206 : 200);
  res.set({
    'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Content-Length': String(b.size ? end - start + 1 : 0), 'X-Content-SHA256': b.sha256,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${b.size}` } : {}),
  });
  if (req.method === 'HEAD') { src.destroy(); release(); return res.end(); }
  pipeline(src, res, (err) => {
    release();
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.warn({ err: err.message, peerId, sha: id }, 'home cache blob stream failed');
  });
  return undefined;
}

// ─── Reports of the gateway ────────────────────────────────────────────

function shaList(v, what) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > LIST_MAX) throw new CacheError('invalid', `${what}: up to ${LIST_MAX} sha256 values`);
  const out = new Set();
  for (const x of v) {
    const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (!SHA_RE.test(s)) throw new CacheError('invalid', `${what}: sha256 as 64 hex characters`);
    out.add(s);
  }
  return [...out];
}

function num(v, what) {
  if (v == null) return 0;
  if (!Number.isFinite(v) || v < 0 || v > 1e15) throw new CacheError('invalid', `${what}: a number ≥ 0`);
  return Math.round(v);
}

/** POST /cache { have, gone?, full?, usedBytes, hits, misses, bytesServed, bytesFetched } */
function report(peerId, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw new CacheError('invalid', 'object expected');
  const have = shaList(b.have, 'have');
  const gone = shaList(b.gone, 'gone');
  const full = b.full === true;
  const used = b.usedBytes == null ? null : num(b.usedBytes, 'usedBytes');
  const c = { hits: num(b.hits, 'hits'), misses: num(b.misses, 'misses'), served: num(b.bytesServed, 'bytesServed'), fetched: num(b.bytesFetched, 'bytesFetched') };
  const now = Date.now();
  const day = require('./homeDns').dayKey(now);
  db().transaction(() => {
    if (full) db().prepare('DELETE FROM home_cache_have WHERE peer_id = ?').run(peerId);
    const ins = db().prepare('INSERT INTO home_cache_have (peer_id, sha256, at) VALUES (?, ?, ?) ON CONFLICT(peer_id, sha256) DO UPDATE SET at = excluded.at');
    for (const s of have) ins.run(peerId, s, now);
    const del = db().prepare('DELETE FROM home_cache_have WHERE peer_id = ? AND sha256 = ?');
    for (const s of gone) del.run(peerId, s);
    if (c.hits || c.misses || c.served || c.fetched) {
      db().prepare(`INSERT INTO cache_stats_day (peer_id, day, hits, misses, bytes_served, bytes_fetched) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, day) DO UPDATE SET hits = hits + excluded.hits, misses = misses + excluded.misses,
          bytes_served = bytes_served + excluded.bytes_served, bytes_fetched = bytes_fetched + excluded.bytes_fetched`)
        .run(peerId, day, c.hits, c.misses, c.served, c.fetched);
    }
    db().prepare(`INSERT INTO gateway_cache (peer_id, settings, used_bytes, report_at) VALUES (?, '{}', ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET used_bytes = COALESCE(excluded.used_bytes, gateway_cache.used_bytes), report_at = excluded.report_at`)
      .run(peerId, used, now);
  })();
  return { have: have.length, gone: gone.length };
}

// ─── Telemetry, lan hint ───────────────────────────────────────────────

/** The cache part of the telemetry (contract server side 5) — or null. */
function telemetryCache(tel) {
  const t = tel && typeof tel === 'object' ? tel : {};
  const f = t.features && t.features.cache && typeof t.features.cache === 'object' ? t.features.cache : null;
  const x = t.cache && typeof t.cache === 'object' && !Array.isArray(t.cache) ? t.cache : null;
  if (!f && !x) return null;
  const c = { ...(x || {}), ...(f || {}) };
  const pick = (k) => (f && f[k] != null ? f[k] : (x ? x[k] : undefined));
  const fp = typeof c.tlsSha256 === 'string' ? c.tlsSha256.replace(/:/g, '').toLowerCase() : null;
  const port = Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : 8443;
  const { isPrivateIpv4 } = require('../utils/validate');
  let url = null;
  const cands = [pick('url'), ...(Array.isArray(pick('urls')) ? pick('urls') : [])].filter((v) => typeof v === 'string');
  for (const cand of cands) {
    try {
      const u = new URL(cand);
      if (u.protocol === 'https:' && isPrivateIpv4(u.hostname) && !u.username) { url = `https://${u.hostname}:${u.port || 443}`; break; }
    } catch { /* next */ }
  }
  if (!url && cands.length === 0 && typeof t.lan_ip === 'string' && isPrivateIpv4(t.lan_ip)) url = `https://${t.lan_ip}:${port}`;
  const state = STATES.includes(c.state) ? c.state : (c.running === true ? 'running' : null);
  const errOf = (e) => (typeof e === 'string' ? e : (e && typeof e === 'object' ? (typeof e.message === 'string' ? e.message : (typeof e.code === 'string' ? e.code : null)) : null));
  const err = errOf(c.error) || errOf(c.lastError);
  return {
    state, running: state === 'running' || (state == null && c.running === true), port, url, tlsSha256: fp && SHA_RE.test(fp) ? fp : null,
    usedBytes: Number.isFinite(c.usedBytes) ? c.usedBytes : null,
    freeBytes: Number.isFinite(c.freeBytes) ? c.freeBytes : null,
    error: err ? String(err).slice(0, 160) : null,
  };
}

/** HMAC-SHA256(secret, sha256 + "\n" + exp) as lowercase hex (the gateway checks the same). */
function signature(secret, sha256, exp) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(`${sha256}\n${exp}`, 'utf8').digest('hex');
}

/**
 * The lan hint for a blob on one gateway: { url, sha256, tlsSha256, exp } —
 * only when its cache is on and running, it holds the blob (last report),
 * the blob may be kept there and (with userId) belongs to that person.
 */
function hintFor(peerId, sha256, { userId = null, now = Date.now() } = {}) {
  const h = hinter(peerId, { userId, now });
  return h ? h(sha256) : null;
}

/**
 * The lan hints of one gateway: sha256 → hint | null (hintFor), the gateway's
 * part (settings, people, telemetry, secret) looked up once — null when that
 * gateway gives none at all (cache off or not running).
 */
function hinter(peerId, { userId = null, now = Date.now() } = {}) {
  const s = get(peerId);
  if (!s.enabled) return null;
  const g = require('./gatewayFeatures').gatewayPeer(peerId);
  if (!g) return null;
  const tc = telemetryCache(require('./gatewayFeatures').telemetryOf(g));
  if (!tc || !tc.running || !tc.url || !tc.tlsSha256) return null;
  const secret = secretOf(peerId, false);
  if (!secret) return null;
  const people = peopleAt(peerId);
  const exp = Math.floor(now / 1000) + HINT_TTL_S;
  const blob = db().prepare('SELECT * FROM home_cache_blobs WHERE sha256 = ?');
  const held = db().prepare('SELECT 1 FROM home_cache_have WHERE peer_id = ? AND sha256 = ?');
  return (sha256) => {
    const id = String(sha256 || '').toLowerCase();
    if (!SHA_RE.test(id)) return null;
    const b = blob.get(id);
    if (!b || !blobFits(b, s, people)) return null;
    if (userId != null) {
      const users = json(b.user_ids);
      if (Array.isArray(users) && users.length && !users.includes(userId)) return null;
    }
    if (!held.get(peerId, id)) return null;
    return { url: `${tc.url}/blob/${id}?exp=${exp}&sig=${signature(secret, id, exp)}`, sha256: id, tlsSha256: tc.tlsSha256, exp };
  };
}

/**
 * The lan hint for a request: the client must be at the site of a gateway
 * (homeNetwork.check: same public address, a `local` address in its LAN).
 * `ctx` = { ip, peerId, local, userId }. → hint | null, never throws.
 */
async function lanFor(ctx, sha256) {
  try {
    if (!ctx || !SHA_RE.test(String(sha256 || '').toLowerCase())) return null;
    const r = await require('./homeNetwork').check(ctx.ip, ctx.peerId == null ? null : ctx.peerId, { local: ctx.local });
    if (!r || !r.same_lan || !r.site || r.site.type !== 'gateway') return null;
    return hintFor(r.site.gatewayId, sha256, { userId: ctx.userId == null ? null : ctx.userId });
  } catch (e) {
    logger.debug({ err: e.message }, 'home cache lan hint failed');
    return null;
  }
}

/**
 * lanFor for many blobs at once (gc.homeCache.lanHints): one home-network
 * check, then a hint (or null) per sha256, in order. Never throws.
 */
async function lanForMany(ctx, shas) {
  const list = Array.isArray(shas) ? shas : [];
  const none = list.map(() => null);
  try {
    if (!ctx || !list.some((x) => SHA_RE.test(String(x || '').toLowerCase()))) return none;
    const r = await require('./homeNetwork').check(ctx.ip, ctx.peerId == null ? null : ctx.peerId, { local: ctx.local });
    if (!r || !r.same_lan || !r.site || r.site.type !== 'gateway') return none;
    const h = hinter(r.site.gatewayId, { userId: ctx.userId == null ? null : ctx.userId });
    return h ? list.map((x) => (x ? h(x) : null)) : none;
  } catch (e) {
    logger.debug({ err: e.message }, 'home cache lan hints failed');
    return none;
  }
}

/** The device's own LAN addresses of a request: ?local=… or the header X-GC-Local. */
function localOf(req) {
  const q = req.query && typeof req.query.local === 'string' ? req.query.local : null;
  const h = typeof req.get === 'function' ? req.get('x-gc-local') : null;
  return q || (typeof h === 'string' ? h : null);
}

// ─── Plugin offers (gc.homeCache) ──────────────────────────────────────

const PLUGIN_KINDS = ['drive', 'photos', 'vault'];

function usersArg(v) {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > 256 || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw new CacheError('ERR_INVALID', 'userIds: up to 256 user ids');
  return [...new Set(v)].sort((x, y) => x - y);
}

function priorityArg(v) {
  const prio = v == null ? 50 : v;
  if (!Number.isInteger(prio) || prio < 0 || prio > 100) throw new CacheError('ERR_INVALID', 'priority: 0…100');
  return prio;
}

/**
 * gc.homeCache.offer({ mediaId, kind, userIds?, priority?, sha256?, preview? })
 * — `plugin` (the registry entry) is needed for a preview only.
 */
async function offer(pluginId, args, { plugin = null } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  if (typeof a.mediaId !== 'string') throw new CacheError('ERR_INVALID', 'mediaId: a media id of this plugin');
  if (a.preview != null) return offerPreview(pluginId, plugin, a);
  if (!PLUGIN_KINDS.includes(a.kind)) throw new CacheError('ERR_INVALID', 'kind: drive, photos or vault');
  const media = require('./plugins/media');
  const r = media.row(pluginId, a.mediaId);
  if (!r) throw new CacheError('ERR_NOT_FOUND', 'no such media of this plugin');
  if (a.sha256 != null && String(a.sha256).toLowerCase() !== String(r.sha256).toLowerCase()) throw new CacheError('ERR_INVALID', 'sha256 does not match the stored file');
  if (a.size != null && a.size !== r.bytes) throw new CacheError('ERR_INVALID', 'size does not match the stored file');
  const sha = String(r.sha256 || '').toLowerCase();
  if (!SHA_RE.test(sha)) throw new CacheError('ERR_INVALID', 'the file has no sha256');
  const users = usersArg(a.userIds);
  const prio = priorityArg(a.priority);
  const now = Date.now();
  const cur = db().prepare('SELECT source, plugin_id FROM home_cache_blobs WHERE sha256 = ?').get(sha);
  if (cur && (cur.source !== 'plugin' || cur.plugin_id !== pluginId)) {
    // the same content is offered already (an app update or another plugin): nothing to add
    return { sha256: sha, size: r.bytes, offered: false };
  }
  db().prepare(`INSERT INTO home_cache_blobs (sha256, size, kind, source, ref, plugin_id, media_id, user_ids, priority, created_at, updated_at)
    VALUES (?, ?, ?, 'plugin', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET size = excluded.size, kind = excluded.kind, media_id = excluded.media_id, ref = excluded.ref,
      user_ids = excluded.user_ids, priority = excluded.priority, updated_at = excluded.updated_at`)
    .run(sha, r.bytes, a.kind, a.mediaId, pluginId, a.mediaId, users ? JSON.stringify(users) : null, prio, now, now);
  stockChanged();
  return { sha256: sha, size: r.bytes, offered: true };
}

/**
 * offer({ mediaId, preview: 'small' | 'large', kind: 'drive' | 'photos', … }):
 * GateControl's preview of the file (media.previews, "Previews") instead of
 * the file — its plaintext JPEG, content-addressed by its own sha256. A
 * preview not made yet is made now in the background: ERR_PREVIEW_PENDING,
 * offer again later. No preview possible: ERR_NOT_FOUND. Never a vault's
 * file (the server has only its ciphertext).
 */
async function offerPreview(pluginId, plugin, a) {
  if (!PREVIEW_SIZES.includes(a.preview)) throw new CacheError('ERR_INVALID', 'preview: small or large');
  if (a.kind !== 'drive' && a.kind !== 'photos') throw new CacheError('ERR_INVALID', 'kind of a preview: drive or photos');
  if (a.sha256 != null || a.size != null) throw new CacheError('ERR_INVALID', 'sha256 / size: not for a preview');
  const previews = require('./plugins/mediaPreviews');
  if (!plugin || !previews.declared(plugin)) throw new CacheError('ERR_MEDIA_DENIED', 'plugin.json declares no media.previews');
  const users = usersArg(a.userIds);
  const prio = priorityArg(a.priority);
  const r = require('./plugins/media').row(pluginId, a.mediaId);
  if (!r) throw new CacheError('ERR_NOT_FOUND', 'no such media of this plugin');
  const st = previews.state(plugin, r);
  if (!st) throw new CacheError('ERR_NOT_FOUND', 'this file has no preview and none is possible');
  if (!st.ready) {
    previews.warm(plugin, r);
    throw new CacheError('ERR_PREVIEW_PENDING', 'the preview is being made — offer it again later');
  }
  const buf = await previews.plain(r, a.preview);
  if (!buf || !buf.length) throw new CacheError('ERR_NOT_FOUND', 'the preview is not readable');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const now = Date.now();
  const cur = db().prepare('SELECT source, plugin_id FROM home_cache_blobs WHERE sha256 = ?').get(sha);
  // an older preview of this file (a device sent another one) goes
  db().prepare("DELETE FROM home_cache_blobs WHERE source = 'preview' AND plugin_id = ? AND media_id = ? AND label = ? AND sha256 <> ?")
    .run(pluginId, a.mediaId, a.preview, sha);
  if (cur && (cur.source !== 'preview' || cur.plugin_id !== pluginId)) {
    stockChanged();
    return { sha256: sha, size: buf.length, offered: false, preview: a.preview };
  }
  db().prepare(`INSERT INTO home_cache_blobs (sha256, size, kind, source, ref, plugin_id, media_id, user_ids, priority, label, created_at, updated_at)
    VALUES (?, ?, ?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256) DO UPDATE SET size = excluded.size, kind = excluded.kind, media_id = excluded.media_id, ref = excluded.ref,
      user_ids = excluded.user_ids, priority = excluded.priority, label = excluded.label, updated_at = excluded.updated_at`)
    .run(sha, buf.length, a.kind, `${a.mediaId}/${a.preview}`, pluginId, a.mediaId, users ? JSON.stringify(users) : null, prio, a.preview, now, now);
  previewShaMemo.set(`${pluginId}:${a.mediaId}:${a.preview}`, { stamp: JSON.stringify(previews.stamp(r, a.preview)), sha });
  stockChanged();
  return { sha256: sha, size: buf.length, offered: true, preview: a.preview };
}

const previewShaMemo = new Map(); // plugin:media:size → { stamp, sha }

/**
 * The sha256 of the preview `size` of a plugin's media as it is stored now
 * (for lanHint({ mediaId, preview })) — or null (no such file, no preview).
 * Remembered per stored preview file (its mtime and size).
 */
async function previewSha(pluginId, mediaId, size) {
  if (!PREVIEW_SIZES.includes(size) || typeof mediaId !== 'string') return null;
  const r = require('./plugins/media').row(pluginId, mediaId);
  if (!r) return null;
  const previews = require('./plugins/mediaPreviews');
  const st = previews.stamp(r, size);
  if (!st) return null;
  const key = `${pluginId}:${mediaId}:${size}`;
  const m = previewShaMemo.get(key);
  if (m && m.stamp === JSON.stringify(st)) return m.sha;
  const buf = await previews.plain(r, size);
  if (!buf) return null;
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (previewShaMemo.size > 20000) previewShaMemo.clear();
  previewShaMemo.set(key, { stamp: JSON.stringify(st), sha });
  return sha;
}

/**
 * gc.homeCache.withdraw(mediaId, { preview? }) — the plugin no longer wants
 * it kept: the file (no `preview`), or that preview of it.
 */
function withdraw(pluginId, mediaId, { preview = null } = {}) {
  if (typeof mediaId !== 'string') throw new CacheError('ERR_INVALID', 'mediaId expected');
  if (preview != null && !PREVIEW_SIZES.includes(preview)) throw new CacheError('ERR_INVALID', 'preview: small or large');
  const n = preview == null
    ? db().prepare("DELETE FROM home_cache_blobs WHERE source = 'plugin' AND plugin_id = ? AND media_id = ?").run(pluginId, mediaId).changes
    : db().prepare("DELETE FROM home_cache_blobs WHERE source = 'preview' AND plugin_id = ? AND media_id = ? AND label = ?").run(pluginId, mediaId, preview).changes;
  if (n) stockChanged();
  return { removed: n > 0 };
}

/** Offers whose media is gone (deleted by the plugin, the plugin removed) — files and previews. */
function dropStaleOffers() {
  const rows = db().prepare("SELECT sha256, plugin_id, media_id FROM home_cache_blobs WHERE source IN ('plugin', 'preview')").all();
  const media = require('./plugins/media');
  let n = 0;
  for (const r of rows) {
    let ok = false;
    try { ok = !!media.row(r.plugin_id, r.media_id); } catch { ok = false; }
    if (!ok) { db().prepare('DELETE FROM home_cache_blobs WHERE sha256 = ?').run(r.sha256); n++; }
  }
  if (n) stockChanged();
  return n;
}

/**
 * Preview offers whose preview is gone or other content now (a device sent
 * another one): the stock takes the preview as it is now, under its new
 * sha256 (same people, priority and kind). Hourly, after dropStaleOffers.
 */
async function refreshPreviewOffers() {
  const rows = db().prepare("SELECT * FROM home_cache_blobs WHERE source = 'preview'").all();
  const media = require('./plugins/media');
  const previews = require('./plugins/mediaPreviews');
  let n = 0;
  for (const b of rows) {
    const r = media.row(b.plugin_id, b.media_id);
    let buf = null;
    try { buf = r ? await previews.plain(r, b.label) : null; } catch { buf = null; }
    const sha = buf ? crypto.createHash('sha256').update(buf).digest('hex') : null;
    if (sha === b.sha256) continue;
    db().transaction(() => {
      db().prepare('DELETE FROM home_cache_blobs WHERE sha256 = ?').run(b.sha256);
      if (sha && !db().prepare('SELECT 1 FROM home_cache_blobs WHERE sha256 = ?').get(sha)) {
        db().prepare(`INSERT INTO home_cache_blobs (sha256, size, kind, source, ref, plugin_id, media_id, user_ids, priority, label, created_at, updated_at)
          VALUES (?, ?, ?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha, buf.length, b.kind, b.ref, b.plugin_id, b.media_id, b.user_ids, b.priority, b.label, b.created_at, Date.now());
      }
    })();
    n++;
  }
  if (n) stockChanged();
  return n;
}

// ─── App updates in the stock ──────────────────────────────────────────

function updatesDir() {
  const root = process.env.GC_DATA_DIR || process.env.GC_DATA_PATH || '/data';
  return path.join(root, 'home-cache', 'updates');
}

function updatesWanted() {
  return db().prepare(`SELECT c.peer_id, c.settings FROM gateway_cache c JOIN peers p ON p.id = c.peer_id WHERE p.enabled = 1 AND p.peer_type = 'gateway'`).all()
    .some((r) => { const s = normalize(json(r.settings)); return s.enabled && s.kinds.updates; });
}

/** (product, channel) pairs the clients of this server use. */
function productsInUse() {
  const cu = require('./clientUpdates');
  const policy = cu.getPolicy();
  const rows = db().prepare("SELECT client_product, update_channel FROM peers WHERE client_product IN ('android', 'pro', 'community')").all();
  const set = new Map();
  for (const r of rows) {
    const ch = cu.effectiveChannel({ update_channel: r.update_channel }, policy);
    set.set(r.client_product + ':' + ch, { product: r.client_product, channel: ch });
  }
  return [...set.values()];
}

/**
 * Stream a release asset to a file, hashing on the way (https, redirects, ≤ 1 GB).
 * `viaApi`: the API URL of the asset without a token (github.com's download
 * path failed — utils/githubRelease.js).
 */
function downloadTo(asset, dest, { token = '', viaApi = false } = {}) {
  const https = require('node:https');
  const start = token || viaApi ? asset.url : asset.browser_download_url;
  return new Promise((resolve, reject) => {
    const get = (u, hops) => {
      let parsed;
      try { parsed = new URL(u); } catch { return reject(new Error('bad url')); }
      if (parsed.protocol !== 'https:' || hops > 5) return reject(new Error('bad redirect'));
      const headers = { 'User-Agent': 'GateControl-Server', Accept: 'application/octet-stream' };
      if (token && hops === 0) headers.Authorization = `Bearer ${token}`;
      const req = https.get(u, { headers, timeout: 30000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
        const hash = crypto.createHash('sha256');
        let size = 0;
        const out = fs.createWriteStream(dest, { mode: 0o600 });
        res.on('data', (c) => {
          size += c.length;
          if (size > UPDATE_MAX_BYTES) { res.destroy(new Error('too large')); return; }
          hash.update(c);
        });
        pipeline(res, out, (err) => {
          if (err) return reject(err);
          return resolve({ sha256: hash.digest('hex'), size });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    get(start, 0);
  });
}

/**
 * downloadTo over the browser download; when that answers 5xx, times out or
 * drops the connection, the same asset over the API (not while GitHub's rate
 * limit is used up). With a token the API is the first way anyway.
 */
async function downloadWithFallback(asset, dest, token) {
  const gh = require('../utils/githubRelease');
  try { return await downloadTo(asset, dest, { token }); } catch (e) {
    const msg = String((e && e.message) || '');
    const worth = /^http 5\d\d$/.test(msg) || msg === 'timeout' || (e && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(e.code)) || msg === 'socket hang up';
    if (token || !worth || !gh.parseAssetApiUrl(asset.url) || gh.rateLimited()) throw e;
    try { fs.unlinkSync(dest); } catch { /* not written */ }
    logger.info({ asset: asset.name, err: msg }, 'home cache: update fetched over the GitHub API');
    return downloadTo(asset, dest, { viaApi: true });
  }
}

let refreshing = null;

/**
 * Put the current installers of the apps in use into the stock (only while a
 * gateway keeps app updates). The server itself never stores updates
 * otherwise — it links or proxies GitHub (routes/api/client/update.js) — so
 * for the cache it downloads each new installer once. `deps` for tests.
 */
function refreshUpdates(deps = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!updatesWanted()) return { fetched: 0, skipped: 'off' };
    const upd = require('../routes/api/client/update');
    const fetchRelease = deps.fetchRelease || upd._internals.fetchLatestRelease;
    const signedOf = deps.signedOf || upd._internals.fetchSignedManifest;
    const pick = upd._internals.pickInstallerAsset;
    const download = deps.download || ((asset, dest) => downloadWithFallback(asset, dest, process.env.GC_CLIENT_GITHUB_TOKEN || ''));
    const dir = updatesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const current = new Set();
    let fetched = 0;
    for (const { product, channel } of productsInUse()) {
      try {
        const rel = await fetchRelease(product, channel);
        if (!rel || !rel.tag_name) continue;
        const signed = product === 'android' ? null : await signedOf(product, rel, channel);
        const asset = pick(product, rel, signed);
        if (!asset || !asset.name) continue;
        const ref = `${product}:${asset.id || asset.name}:${asset.updated_at || ''}`;
        const have = db().prepare("SELECT sha256 FROM home_cache_blobs WHERE source = 'update' AND ref = ?").get(ref);
        if (have) { current.add(have.sha256); db().prepare('UPDATE home_cache_blobs SET updated_at = ? WHERE sha256 = ?').run(Date.now(), have.sha256); continue; }
        if (Number.isSafeInteger(asset.size) && asset.size > UPDATE_MAX_BYTES) continue;
        const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
        let got;
        try { got = await download(asset, tmp); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* none */ } throw e; }
        const digest = typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null;
        if ((digest && digest !== got.sha256) || (Number.isSafeInteger(asset.size) && asset.size !== got.size)) {
          fs.unlinkSync(tmp);
          logger.warn({ product, asset: asset.name }, 'home cache: downloaded update does not match the release');
          continue;
        }
        const file = path.join(dir, got.sha256);
        fs.renameSync(tmp, file);
        const now = Date.now();
        const version = String(rel.tag_name).replace(/^v/, '').slice(0, 40);
        db().prepare(`INSERT INTO home_cache_blobs (sha256, size, kind, source, ref, file, priority, label, created_at, updated_at)
          VALUES (?, ?, 'updates', 'update', ?, ?, 80, ?, ?, ?)
          ON CONFLICT(sha256) DO UPDATE SET ref = excluded.ref, file = excluded.file, source = 'update', kind = 'updates', label = excluded.label, updated_at = excluded.updated_at`)
          .run(got.sha256, got.size, ref, file, `${product} ${version}`, now, now);
        current.add(got.sha256);
        fetched++;
      } catch (e) {
        logger.warn({ err: e.message, product, channel }, 'home cache: update not fetched');
      }
    }
    // updates no client needs any more go after a week
    const old = db().prepare("SELECT sha256, file, updated_at FROM home_cache_blobs WHERE source = 'update'").all()
      .filter((r) => !current.has(r.sha256) && Date.now() - r.updated_at > UPDATE_KEEP_MS);
    for (const r of old) {
      db().prepare('DELETE FROM home_cache_blobs WHERE sha256 = ?').run(r.sha256);
      try { if (r.file) fs.unlinkSync(r.file); } catch { /* gone */ }
    }
    return { fetched, removed: old.length };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * The lan hint for an update download (GET /api/v1/client/update/check):
 * the installer `asset` of `product` must be in the stock (refreshUpdates).
 */
async function lanForUpdate(req, product, asset, peer) {
  if (!asset) return null;
  // exactly this upload of the asset (a replaced file has another updated_at), or its published digest
  const digest = typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : '';
  const b = db().prepare("SELECT sha256 FROM home_cache_blobs WHERE source = 'update' AND (ref = ? OR sha256 = ?)")
    .get(`${product}:${asset.id || asset.name}:${asset.updated_at || ''}`, digest);
  if (!b) return null;
  return lanFor({ ip: req.ip, peerId: peer ? peer.id : null, local: localOf(req), userId: null }, b.sha256);
}

// ─── Admin view (tab "Zwischenspeicher") ───────────────────────────────

/** Where to keep it: the telemetry's storage list (contract §3) → suggestions. */
function storageOf(tel) {
  const list = Array.isArray(tel.storage) ? tel.storage : [];
  return list.filter((x) => x && typeof x === 'object' && typeof x.mount === 'string' && x.mount.startsWith('/')).slice(0, 12).map((x) => ({
    mount: x.mount.slice(0, 200), fs: typeof x.fs === 'string' ? x.fs.slice(0, 24) : null,
    sizeBytes: Number.isFinite(x.sizeBytes) ? x.sizeBytes : null, freeBytes: Number.isFinite(x.freeBytes) ? x.freeBytes : null, removable: x.removable === true,
    // gateway side 19: 'container' = a mount the gateway container sees (e.g. /cache), 'host' = a drive of the host (Pi)
    origin: x.origin === 'container' || x.origin === 'host' ? x.origin : null,
  }));
}

/**
 * Where the cache folder could lie on the host (the gateway only ever uses
 * its volume /cache): the drive with the most free space — on a Pi only a
 * removable one (USB) — and the setting to put it there: Pi settings.txt
 * CACHE_DIR=, Docker/NAS the Compose variable GC_CACHE_DIR.
 */
function suggestion(storage, board) {
  const pi = /^pi/.test(board || '');
  const usable = storage.filter((x) => x.origin !== 'container' && x.mount !== CACHE_PATH && x.freeBytes != null && x.freeBytes > MIN_BYTES);
  const pickFrom = pi ? usable.filter((x) => x.removable) : usable;
  const best = pickFrom.sort((a, b) => b.freeBytes - a.freeBytes)[0] || null;
  if (!best) return null;
  return { mount: best.mount, hostDir: best.mount.replace(/\/+$/, '') + '/gatecontrol-cache', freeBytes: best.freeBytes, removable: best.removable, setting: pi ? 'CACHE_DIR' : 'GC_CACHE_DIR' };
}

function sumSince(peerId, fromDay) {
  return db().prepare(`SELECT COALESCE(SUM(hits), 0) AS hits, COALESCE(SUM(misses), 0) AS misses, COALESCE(SUM(bytes_served), 0) AS served,
    COALESCE(SUM(bytes_fetched), 0) AS fetched FROM cache_stats_day WHERE peer_id = ? AND day >= ?`).get(peerId, fromDay);
}

/** Everything the tab "Zwischenspeicher" shows (never the secret). */
function view(peerId, now = Date.now()) {
  const gf = require('./gatewayFeatures');
  const g = needGateway(peerId);
  const tel = gf.telemetryOf(g);
  const s = get(g.id);
  const r = row(g.id) || {};
  const dns = require('./homeDns');
  const today = sumSince(g.id, dns.dayKey(now));
  const month = sumSince(g.id, dns.dayKey(now - 29 * 24 * 3600 * 1000));
  const stock = stockOf(g.id, s);
  const have = new Set(db().prepare('SELECT sha256 FROM home_cache_have WHERE peer_id = ?').all(g.id).map((x) => x.sha256));
  const kinds = {};
  for (const k of KINDS) kinds[k] = { bytes: 0, count: 0, wanted: 0 };
  for (const b of stock) {
    kinds[b.kind].wanted++;
    if (have.has(b.sha256)) { kinds[b.kind].bytes += b.size; kinds[b.kind].count++; }
  }
  const hw = tel.hardware && typeof tel.hardware === 'object' ? tel.hardware : {};
  const board = gf.boardOf(hw.model);
  const storage = storageOf(tel);
  const tc = telemetryCache(tel);
  // how much faster than the internet: the LAN of the board against the last measured download
  let speedup = null;
  try {
    const st = db().prepare('SELECT down_mbps FROM inetq_speedtests WHERE peer_id = ? AND down_mbps IS NOT NULL ORDER BY at DESC LIMIT 1').get(g.id);
    const lim = gf.speedLimit(board);
    const lan = lim && lim.mbps ? lim.mbps : (board === 'pi_zero' ? null : 940);
    if (st && st.down_mbps > 0 && lan) speedup = Math.max(1, Math.round((lan / st.down_mbps) * 10) / 10);
  } catch { speedup = null; }
  // free space of the cache volume: the gateway's own number, else its /cache mount
  const vol = storage.find((x) => x.mount === CACHE_PATH);
  const free = tc && tc.freeBytes != null ? tc.freeBytes : (vol ? vol.freeBytes : null);
  return {
    gateway: { id: g.id, name: g.name, support: gf.support(tel), board, model: typeof hw.model === 'string' ? hw.model : null, platform: typeof hw.platform === 'string' ? hw.platform : null },
    settings: s,
    sizes: SIZES_GB.map((x) => x * GB),
    state: tc ? { state: tc.state, running: tc.running, port: tc.port, reachable: !!tc.url, pinned: !!tc.tlsSha256, error: tc.error } : null,
    usage: { usedBytes: r.used_bytes != null ? r.used_bytes : (tc ? tc.usedBytes : null), maxBytes: s.maxBytes, reportAt: iso(r.report_at) },
    today: { hits: today.hits, misses: today.misses, hitPct: today.hits + today.misses ? Math.round((today.hits / (today.hits + today.misses)) * 1000) / 10 : null, bytesServed: today.served, bytesFetched: today.fetched },
    month: { bytesServed: month.served },
    speedup,
    kinds,
    stock: { items: stock.length, have: stock.filter((b) => have.has(b.sha256)).length },
    storage,
    suggestion: suggestion(storage, board),
    freeBytes: free,
    pi: /^pi/.test(board),
    // where the folder lies on the host is set at the gateway (gateway side 14)
    hostSetting: /^pi/.test(board) ? 'CACHE_DIR' : 'GC_CACHE_DIR',
  };
}

/** "Zwischenspeicher leeren": gateway management API; the server forgets what it held. */
async function clear(peerId, { ip, user } = {}) {
  const g = needGateway(peerId);
  const r = await require('./gateways').mgmtCall(g.id, '/api/cache/clear', {});
  if (!r) throw new CacheError('gateway_unreachable', 'gateway not reachable');
  if (r.status === 404) throw new CacheError('gateway_unsupported', 'the gateway does not know this command yet');
  if (r.status === 503) throw new CacheError('unavailable', 'the home cache is not running on the gateway');
  if (r.status < 200 || r.status >= 300) throw new CacheError('gateway_error', 'gateway answered ' + r.status);
  db().prepare('DELETE FROM home_cache_have WHERE peer_id = ?').run(g.id);
  db().prepare('UPDATE gateway_cache SET used_bytes = 0 WHERE peer_id = ?').run(g.id);
  try {
    require('./activity').log('gateway_cache_cleared', `Home cache cleared on "${g.name}"`, { source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, ...(user ? { user } : {}) } });
  } catch { /* best-effort */ }
  return { ok: true };
}

/** Retention: daily counters a year. */
function retention(now = Date.now()) {
  const old = require('./homeDns').dayKey(now - 366 * 24 * 3600 * 1000);
  return db().prepare('DELETE FROM cache_stats_day WHERE day < ?').run(old).changes;
}

function _resetForTest() { inflight.clear(); refreshing = null; stockMemo.clear(); previewShaMemo.clear(); }

module.exports = {
  CacheError, KINDS, DEFAULTS, CACHE_PATH, STATES, GB, SIZES_GB, HINT_TTL_S, HINTS_MAX, MIN_BYTES, MAX_BYTES, PREVIEW_SIZES, WANT_MAX,
  normalize, get, set, secretOf, configPayload, want, stockOf, sendBlob, report, telemetryCache, signature, hintFor, lanFor, lanForMany, localOf,
  offer, withdraw, previewSha, dropStaleOffers, refreshPreviewOffers, refreshUpdates, lanForUpdate, view, clear, retention, updatesDir, _resetForTest,
  _downloadWithFallback: downloadWithFallback,
};
