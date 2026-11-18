'use strict';

// The address search of "Meine Orte" (docs/feature-user-profile.md "Adresssuche"): one search for the portal and
// both apps — GET …/places/search?q=&near=lat,lon. Before 1.298 it lived in the plugin Notizen; the logic is the
// same, the server asks now.
//
//   Setting (Benutzer → Einstellungen, profile.place_search): 'osm' (the default), 'own' (a Nominatim of one's own,
//   profile.place_search_url) or 'off'.
//     osm   the public service nominatim.openstreetmap.org — its usage policy applies
//           (https://operations.osmfoundation.org/policies/nominatim/): at most one request a second for the whole
//           server, a User-Agent naming the application, results cached, no auto-complete (the apps and the portal
//           search on an explicit "Suchen" only), no systematic queries. This module keeps to it: one request at a
//           time with PAUSE_MS between two starts, a cache, a limit per person, a bounded queue.
//     own   the administrator's Nominatim (http/https URL; the server's network rules of utils/outboundGuard: no
//           loopback, link-local or metadata address — a private address in the home network is allowed). The
//           policy above does not bind there; the limits stay, the pause is shorter.
//
//   Privacy: the position is rounded HERE to two decimals (about 1.1 km north–south, 0.7 km east–west at 50° north)
//   before anything else happens with it — whatever the device sent. The search service gets the search words and a
//   box around that cell, never a name, a device or a user id. Nothing of it is written to the database or the log;
//   the cache lives in memory, keyed by words and cell — not by person.
//
// Outbound requests go through utils/outboundGuard (DNS pinned, no redirects, bounded answer).

const settings = require('./settings');
const logger = require('../utils/logger');
const { version } = require('../../package.json');

const MODES = Object.freeze(['off', 'osm', 'own']);
const OSM_URL = 'https://nominatim.openstreetmap.org';
const ATTRIBUTION = '© OpenStreetMap';
const ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
const USER_AGENT = `GateControl/${version} (self-hosted; address search on request of a person; +https://github.com/CallMeTechie/gatecontrol)`;
const DECIMALS = 2;             // the rounding of a position (≈ 1 km)
const BOX_KM = 50;              // half the side of the box a search prefers (not bounded: farther hits still come)
const LIMIT = 8;                // hits asked of the service and answered
const Q_MIN = 3;
const Q_MAX = 120;
const PAUSE_MS = { osm: 1100, own: 250 }; // between the starts of two requests (the public service: at most one a second)
const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const QUEUE_MAX = 8;            // searches waiting for their turn; more → busy
const CACHE_MS = 7 * 86400000;
const CACHE_EMPTY_MS = 6 * 3600000;
const CACHE_MAX = 500;
const DOWN_MS = 60000;          // after a failure the service is left alone for this long
const PER_HOUR = 30;            // searches of one person that really go out (cached ones do not count)

class SearchError extends Error {
  constructor(code, message, extra) { super(message || code); this.code = code; Object.assign(this, extra || {}); }
}
// the texts of the endpoints (routes/api/profileApi.js): myprofile.places.err.<code> / invalid_<field>
SearchError.prototype.i18nPrefix = 'myprofile.places.err.';

const state = { chain: Promise.resolve(), waiting: 0, last: 0, downUntil: 0, cache: new Map(), people: new Map(), pauseMs: null };

/** The transport (replaced in tests): (url, opts) → { status, body: Buffer | string }. */
let transport = (url, opts) => require('../utils/outboundGuard').safeRequest(url, opts);

// ─── Settings ────────────────────────────────────────────────────

function mode() {
  const m = settings.get('profile.place_search', 'osm');
  return MODES.includes(m) ? m : 'osm';
}
function ownUrl() { return settings.get('profile.place_search_url', '') || ''; }
/** Can a search go out: 'osm' | 'own' | 'off' ('own' without a URL counts as 'off'). */
function available() {
  const m = mode();
  if (m === 'own' && !ownUrl()) return 'off';
  return m;
}

/** A Nominatim base URL of the administrator → its normalised form (http/https, no query, no credentials) or throws. */
function normalizeUrl(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 300) throw new SearchError('ERR_INVALID', 'invalid URL', { field: 'placeSearchUrl' });
  let u;
  try {
    u = require('../utils/outboundGuard').validateUrlSyntax(v.trim(), { allowPrivate: true });
  } catch { throw new SearchError('ERR_INVALID', 'invalid URL', { field: 'placeSearchUrl' }); }
  if (u.username || u.password || u.search || u.hash) throw new SearchError('ERR_INVALID', 'invalid URL', { field: 'placeSearchUrl' });
  return u.toString().replace(/\/+$/, '');
}

// ─── Values ──────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.length <= 24 && /^-?[0-9.]+$/.test(v.trim()) ? Number(v.trim()) : NaN);
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const round = (v) => Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS;

/** 'lat,lon' (or { lat, lon }) as a device sent it → the cell it lies in ({ lat, lon } rounded to DECIMALS) — or null. */
function cellOf(near) {
  let lat; let lon;
  if (typeof near === 'string') {
    const parts = near.split(',');
    if (parts.length !== 2) return null;
    lat = num(parts[0]); lon = num(parts[1]);
  } else if (near && typeof near === 'object') { lat = num(near.lat); lon = num(near.lon); } else return null;
  if (!validCoord(lat, lon) || (lat === 0 && lon === 0)) return null;
  return { lat: round(lat), lon: round(lon) };
}

/** Metres between two points (haversine). */
function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** left,top,right,bottom of the box of `km` around a cell (Nominatim's viewbox). */
function boxOf(cell, km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.1, Math.cos(cell.lat * Math.PI / 180)));
  const f = (v) => String(Math.round(v * 1000) / 1000);
  return [f(Math.max(-180, cell.lon - dLon)), f(Math.min(90, cell.lat + dLat)), f(Math.min(180, cell.lon + dLon)), f(Math.max(-90, cell.lat - dLat))].join(',');
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** One hit of the service → { name, address, lat, lon, source: 'osm' } | null. */
function hitOf(x) {
  if (!x || typeof x !== 'object') return null;
  const lat = num(x.lat);
  const lon = num(x.lon);
  if (!validCoord(lat, lon) || (lat === 0 && lon === 0)) return null;
  const a = x.address && typeof x.address === 'object' ? x.address : {};
  const street = [clean(a.road || a.pedestrian || a.footway || a.square || '', 80), clean(a.house_number || '', 12)].filter(Boolean).join(' ');
  const town = clean(a.city || a.town || a.village || a.municipality || a.suburb || '', 60);
  const address = [street, [clean(a.postcode || '', 12), town].filter(Boolean).join(' ')].filter(Boolean).join(', ') || clean(x.display_name, 200);
  const name = clean(x.name, 60) || street || clean(x.display_name, 60);
  if (!name) return null;
  return { name, address: address.slice(0, 200), lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, source: 'osm' };
}

// ─── Cache, queue, limits ────────────────────────────────────────

function remember(key, hits) {
  if (state.cache.size >= CACHE_MAX) state.cache.delete(state.cache.keys().next().value);
  state.cache.set(key, { at: Date.now(), hits });
}
function cached(key) {
  const c = state.cache.get(key);
  if (!c) return null;
  const age = Date.now() - c.at;
  if (age < 0 || age > (c.hits.length ? CACHE_MS : CACHE_EMPTY_MS)) { state.cache.delete(key); return null; }
  return c.hits;
}

/** May this person send one more search to the service now? (counted per hour; throws ERR_RATE_LIMIT) */
function spend(userId, dry) {
  const now = Date.now();
  const list = (state.people.get(userId) || []).filter((t) => now - t < 3600000 && t <= now);
  if (list.length >= PER_HOUR) throw new SearchError('ERR_RATE_LIMIT', 'too many searches', { retryAfter: Math.max(1, Math.ceil((list[0] + 3600000 - now) / 1000)) });
  if (!dry) { list.push(now); state.people.set(userId, list); }
}

/** One request at a time, the mode's pause between two starts; more than QUEUE_MAX waiting → busy. */
function queued(m, fn) {
  if (state.waiting >= QUEUE_MAX) throw new SearchError('ERR_RATE_LIMIT', 'the search is busy', { retryAfter: Math.ceil((state.waiting * 1100) / 1000) });
  state.waiting++;
  const pause = state.pauseMs != null ? state.pauseMs : PAUSE_MS[m];
  const run = async () => {
    try {
      const wait = state.last + pause - Date.now();
      if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
      state.last = Date.now();
      return await fn();
    } finally { state.waiting--; }
  };
  const p = state.chain.then(run, run);
  state.chain = p.catch(() => {});
  return p;
}

/** One request to the service → the parsed JSON array (throws on anything else). */
async function ask(m, params) {
  const base = m === 'own' ? normalizeUrl(ownUrl()) : OSM_URL;
  const qs = new URLSearchParams(params).toString();
  const res = await transport(`${base}/search?${qs}`, {
    method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES,
    allowPrivate: m === 'own',
  });
  if (!res || res.status !== 200 || res.truncated) throw new Error('status');
  const json = JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body));
  if (!Array.isArray(json)) throw new Error('shape');
  return json;
}

/**
 * search({ q, near, lang, userId }) → { results: [{ name, address, lat, lon, source: 'osm', distanceM? }], cached,
 * attribution } — q 3…120 characters; near 'lat,lon' (optional, rounded to the cell before anything else).
 * @throws {SearchError} ERR_INVALID (field q | near) | ERR_SEARCH_OFF | ERR_RATE_LIMIT (retryAfter) | ERR_UNAVAILABLE
 */
async function search({ q, near, lang, userId } = {}) {
  const m = available();
  if (m === 'off') throw new SearchError('ERR_SEARCH_OFF', 'the address search is switched off');
  const words = clean(q, Q_MAX + 1);
  if (Array.from(words).length < Q_MIN || Array.from(words).length > Q_MAX) throw new SearchError('ERR_INVALID', 'q: 3…120 characters', { field: 'q' });
  let cell = null;
  if (near != null && near !== '') {
    cell = cellOf(near);
    if (!cell) throw new SearchError('ERR_INVALID', 'near: lat,lon', { field: 'near' });
  }
  const l = lang === 'en' ? 'en' : 'de';
  const key = `${m}|${l}|${words.toLowerCase()}|${cell ? `${cell.lat},${cell.lon}` : '-'}`;
  let hits = cached(key);
  let fromCache = !!hits;
  if (!hits) {
    if (Date.now() < state.downUntil) throw new SearchError('ERR_UNAVAILABLE', 'the search service does not answer');
    spend(userId, true);
    hits = await queued(m, async () => {
      // the same search asked twice at once: the second one finds the first one's answer
      const again = cached(key);
      if (again) { fromCache = true; return again; }
      spend(userId);
      let rows;
      try {
        rows = await ask(m, {
          q: words, format: 'jsonv2', addressdetails: '1', limit: String(LIMIT), 'accept-language': l,
          ...(cell ? { viewbox: boxOf(cell, BOX_KM) } : {}),
        });
      } catch (e) {
        state.downUntil = Date.now() + DOWN_MS;
        // never the words or the position: only that it failed
        logger.warn({ mode: m, reason: (e && e.code) || 'error' }, 'place search: the service failed');
        throw new SearchError('ERR_UNAVAILABLE', 'the search service does not answer');
      }
      const out = [];
      const seen = new Set();
      for (const x of rows) {
        const h = hitOf(x);
        if (!h) continue;
        const k = `${h.lat},${h.lon}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h);
      }
      remember(key, out);
      return out;
    });
  }
  const results = hits.slice(0, LIMIT).map((h) => (cell ? { ...h, distanceM: distance(cell, h) } : { ...h }));
  return { results, cached: fromCache, attribution: { text: ATTRIBUTION, url: ATTRIBUTION_URL } };
}

function _reset({ pauseMs = null } = {}) {
  state.chain = Promise.resolve(); state.waiting = 0; state.last = 0; state.downUntil = 0; state.cache.clear(); state.people.clear(); state.pauseMs = pauseMs;
}
function _setTransport(fn) { transport = fn || ((url, opts) => require('../utils/outboundGuard').safeRequest(url, opts)); }

module.exports = {
  MODES, OSM_URL, USER_AGENT, DECIMALS, PER_HOUR, PAUSE_MS, LIMIT, Q_MIN, Q_MAX, ATTRIBUTION, ATTRIBUTION_URL, SearchError,
  mode, ownUrl, available, normalizeUrl, cellOf, distance, boxOf, hitOf, search,
  _reset, _setTransport,
};
