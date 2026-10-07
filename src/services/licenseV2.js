'use strict';

// Client for the licence server's v2 API (callmetechie.de).
//
// v1 signs its tokens with HS256 and a key every customer holds — anyone can
// mint a token. v2 signs with Ed25519 (JWS alg "EdDSA"); this module only ever
// holds PUBLIC keys, fetched from the server's JWKS endpoint or pinned via
// GC_LICENSE_PUBKEYS. Nothing that arrives on this path is accepted unless its
// signature verifies against one of those keys.
//
// This module is transport + crypto + persistence only. The decision what a
// result means for the running plan (revocation, grace, v1 fallback) lives in
// services/license.js.

const crypto = require('crypto');
const config = require('../../config/default');
const logger = require('../utils/logger');

const ISSUER = 'callmetechie.de';
const JWKS_REFETCH_MS = 60 * 60 * 1000;      // unknown kid → refetch at most hourly
const REQUEST_TIMEOUT_MS = 15000;
const DEACTIVATE_TIMEOUT_MS = 5000;
const MAX_PLUGIN_KEYS = 50;
const MAX_KEY_LENGTH = 200;

// settings-table keys (none of them is in settings.PUBLIC_KEYS → never leave the server)
const K = {
  active: 'license.v2.active',          // '1' once a v2 validation succeeded on this install
  token: 'license.v2.token',            // JSON { token, key_hash, last_ok_at, activations, max_activations }
  plugins: 'license.v2.plugins',        // JSON [ plugin entries of the last successful validation ]
  jwks: 'license.v2.jwks',              // JSON { keys, fetched_at }
  pluginKeys: 'license.plugin_keys_encrypted',
};

// ─── Small persistent store (settings table, in-memory fallback) ────

const memStore = new Map();

function kvGet(key) {
  try {
    return require('./settings').get(key, null);
  } catch {
    return memStore.has(key) ? memStore.get(key) : null;
  }
}

function kvSet(key, value) {
  try {
    require('./settings').set(key, value);
  } catch {
    memStore.set(key, String(value));
  }
}

function kvJson(key) {
  const raw = kvGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function isActive() {
  return kvGet(K.active) === '1';
}

function markActive() {
  kvSet(K.active, '1');
}

function keyHash(licenseKey) {
  return crypto.createHash('sha256').update(String(licenseKey || '')).digest('hex');
}

/** Persist the app token of a successful validation, bound to the key it was issued for. */
function saveState(licenseKey, { token, activations, max_activations, plugins, now }) {
  kvSet(K.token, JSON.stringify({
    token,
    key_hash: keyHash(licenseKey),
    last_ok_at: now,
    activations: activations ?? null,
    max_activations: max_activations ?? null,
  }));
  kvSet(K.plugins, JSON.stringify(Array.isArray(plugins) ? plugins : []));
}

/** The stored app token record, or null when none exists for this key. */
function loadState(licenseKey) {
  const rec = kvJson(K.token);
  if (!rec || typeof rec.token !== 'string' || rec.key_hash !== keyHash(licenseKey)) return null;
  const plugins = kvJson(K.plugins);
  return { ...rec, plugins: Array.isArray(plugins) ? plugins : [] };
}

function clearState() {
  kvSet(K.token, '');
  kvSet(K.plugins, '');
}

// ─── Plugin licence keys ────────────────────────

/**
 * Store the plugin licence keys (GCSK-…, GCMD-…) sent along with every v2
 * validation. Encrypted at rest like the other licence secrets.
 * @param {string[]} keys
 * @returns {string[]} the normalised list that was stored
 */
function setPluginKeys(keys) {
  if (!Array.isArray(keys)) throw new Error('plugin keys must be an array');
  const out = [];
  for (const k of keys) {
    if (typeof k !== 'string') throw new Error('plugin key must be a string');
    const v = k.trim();
    if (!v) continue;
    if (v.length > MAX_KEY_LENGTH) throw new Error('plugin key too long');
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_PLUGIN_KEYS) throw new Error('too many plugin keys');
  const { encrypt } = require('../utils/crypto');
  kvSet(K.pluginKeys, out.length ? encrypt(JSON.stringify(out)) : '');
  return out;
}

/** @returns {string[]} */
function getPluginKeys() {
  const raw = kvGet(K.pluginKeys);
  if (!raw) return [];
  try {
    const { decrypt } = require('../utils/crypto');
    const list = JSON.parse(decrypt(raw));
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

// ─── JWKS ───────────────────────────────────────

let lastJwksFetch = 0;

function isEd25519Jwk(k) {
  return !!k && typeof k === 'object' && k.kty === 'OKP' && k.crv === 'Ed25519'
    && typeof k.kid === 'string' && k.kid.length > 0
    && typeof k.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k.x)
    && (k.alg === undefined || k.alg === 'EdDSA')
    && (k.use === undefined || k.use === 'sig');
}

function parseJwks(json) {
  const list = Array.isArray(json) ? json : (json && Array.isArray(json.keys) ? json.keys : []);
  return list.filter(isEd25519Jwk).map(({ kty, crv, kid, x }) => ({ kty, crv, kid, x }));
}

/**
 * Keys pinned via GC_LICENSE_PUBKEYS (a JSON JWKS). When set they are the ONLY
 * keys accepted and the JWKS endpoint is never asked. A value that does not
 * parse pins nothing — every token is rejected rather than silently trusting
 * the network.
 * @returns {object[]|null} null when no pin is configured
 */
function pinnedKeys() {
  const raw = config.license.pubkeys;
  if (!raw || !String(raw).trim()) return null;
  try {
    return parseJwks(JSON.parse(raw));
  } catch {
    logger.error('GC_LICENSE_PUBKEYS is not valid JSON — no licence token will be accepted');
    return [];
  }
}

async function fetchJwks() {
  lastJwksFetch = Date.now();
  const res = await fetch(config.license.jwksUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const keys = parseJwks(await res.json());
  if (keys.length === 0) throw new Error('JWKS contains no Ed25519 key');
  kvSet(K.jwks, JSON.stringify({ keys, fetched_at: lastJwksFetch }));
  return keys;
}

/**
 * The public key for `kid`. Looks in the pin, else the DB cache; an unknown
 * kid triggers a JWKS refetch at most once per hour.
 * @returns {Promise<object|null>} the JWK or null
 */
async function getKey(kid) {
  const pinned = pinnedKeys();
  if (pinned) return pinned.find((k) => k.kid === kid) || null;

  const cache = kvJson(K.jwks);
  const cached = cache ? parseJwks(cache) : [];
  const hit = cached.find((k) => k.kid === kid);
  if (hit) return hit;

  const last = Math.max(lastJwksFetch, Number(cache?.fetched_at) || 0);
  if (cached.length > 0 && Date.now() - last < JWKS_REFETCH_MS) return null;
  if (cached.length === 0 && Date.now() - lastJwksFetch < 60 * 1000) return null; // no hammering on a dead endpoint
  try {
    const keys = await fetchJwks();
    return keys.find((k) => k.kid === kid) || null;
  } catch (err) {
    logger.warn('License JWKS fetch failed: ' + err.message);
    return null;
  }
}

// ─── Token verification ─────────────────────────

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Verify an EdDSA licence token.
 * @param {string} token
 * @param {object} opts
 * @param {string} opts.fingerprint  this install's hardware fingerprint
 * @param {'app'|'plugin'} opts.kind
 * @param {boolean} [opts.allowExpired]  accept a passed `exp` (grace period)
 * @returns {Promise<{ok:true, payload:object}|{ok:false, reason:string}>}
 */
async function verifyToken(token, { fingerprint, kind, allowExpired = false }) {
  if (typeof token !== 'string' || token.length > 16384) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return { ok: false, reason: 'malformed' };

  let header;
  let payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  // Strictly EdDSA: never HS256 (forgeable with the shared v1 key), never "none".
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'alg' };
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'kid' };

  const jwk = await getKey(header.kid);
  if (!jwk) return { ok: false, reason: 'kid' };

  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    const sig = Buffer.from(parts[2], 'base64url');
    valid = sig.length === 64 && crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature' };

  if (payload.iss !== ISSUER) return { ok: false, reason: 'iss' };
  if (payload.kind !== kind) return { ok: false, reason: 'kind' };
  if (typeof payload.fp !== 'string' || payload.fp !== fingerprint) return { ok: false, reason: 'fp' };
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'exp' };
  if (!allowExpired && payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  if (kind === 'app' && (typeof payload.plan !== 'string' || !payload.features || typeof payload.features !== 'object')) {
    return { ok: false, reason: 'claims' };
  }
  return { ok: true, payload };
}

// ─── HTTP ───────────────────────────────────────

function deviceName() {
  try { return new URL(config.app.baseUrl).hostname; } catch { return require('os').hostname(); }
}

/**
 * POST /api/v2/licenses/validate.
 * @returns {Promise<{status:'ok', data:object}
 *   | {status:'invalid', message:string}
 *   | {status:'unavailable', http:number}
 *   | {status:'transient', reason:string}>}
 *   invalid     403 license_invalid — the server rejects the app licence
 *   unavailable 404/503 — v2 not deployed (or no signing key yet)
 *   transient   network error, 429, other 4xx/5xx, malformed body
 */
async function validate({ licenseKey, fingerprint, pluginKeys, productSlug }) {
  let res;
  try {
    res = await fetch(config.license.serverV2.replace(/\/+$/, '') + '/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        hardware_fingerprint: fingerprint,
        device_name: deviceName(),
        product_slug: productSlug,
        license_key: licenseKey,
        plugin_keys: Array.isArray(pluginKeys) ? pluginKeys : [],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: 'transient', reason: 'network: ' + (err && err.message) };
  }

  const body = await res.json().catch(() => null);
  if (res.status === 200) {
    if (!body || body.valid !== true || typeof body.token !== 'string' || !body.license || typeof body.license !== 'object') {
      return { status: 'transient', reason: 'malformed response' };
    }
    return { status: 'ok', data: body };
  }
  if (res.status === 403 && body && body.error === 'license_invalid') {
    return { status: 'invalid', message: typeof body.message === 'string' ? body.message : 'license_invalid' };
  }
  if (res.status === 404 || res.status === 503) return { status: 'unavailable', http: res.status };
  return { status: 'transient', reason: `HTTP ${res.status}` };
}

/**
 * POST /api/v2/licenses/deactivate — frees this install's activation slot.
 * Best effort: never throws, gives up after a few seconds.
 * @returns {Promise<{ok:boolean, status:number|null}>}
 */
async function deactivate({ licenseKey, fingerprint }) {
  try {
    const res = await fetch(config.license.serverV2.replace(/\/+$/, '') + '/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, hardware_fingerprint: fingerprint }),
      signal: AbortSignal.timeout(DEACTIVATE_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    return { ok: res.status === 200 && !!body && body.success === true, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  lastJwksFetch = 0;
  memStore.clear();
  for (const key of Object.values(K)) kvSet(key, '');
}

module.exports = {
  ISSUER,
  JWKS_REFETCH_MS,
  isActive,
  markActive,
  saveState,
  loadState,
  clearState,
  setPluginKeys,
  getPluginKeys,
  verifyToken,
  validate,
  deactivate,
  fetchJwks,
  _resetForTest,
};
