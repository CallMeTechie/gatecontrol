'use strict';

// Official plugin catalogue (docs/plugins.md "Official plugin catalogue").
//
// The first-party repository CallMeTechie/gatecontrol-plugins publishes
// catalog.json as an asset of its rolling release "catalog". GateControl
// reads it to list the official plugins in Settings → Plugins and to install
// or update one with a click. Nothing in the catalogue is trusted beyond
// "where to download which file, and its sha256":
//
//   fetch      https only; the catalogue URL and every redirect must be on
//              ALLOWED hosts (github.com and GitHub's release-asset CDN, plus
//              the host of an operator-set GC_PLUGIN_CATALOG_URL); size cap,
//              overall timeout; cached in memory (CACHE_TTL_MS).
//   validate   strict: schema 1, plugin ids by the plugin id rule, semver
//              versions, valid `gatecontrol` ranges, sha256 hex, sizes within
//              the package limit, package urls https on the allowed hosts.
//              One malformed entry rejects the whole catalogue.
//   pick       per plugin the newest non-prerelease version whose
//              `gatecontrol` range the running GateControl satisfies.
//   download   server-side, same transport rules, ≤ entry.size and
//              ≤ LIMITS.packageBytes, then sha256 against the catalogue.
//
// The downloaded bytes go into the SAME inspect() as an uploaded file: the
// package signature is verified there against the trusted publisher keys —
// the catalogue's signature/public_key fields are informational and never
// used. inspect() also refuses a package whose plugin.json names another id
// or version than the one requested (and an unsigned/untrusted one).

const crypto = require('node:crypto');
const https = require('node:https');
const semver = require('./semver');
const { ID_RE, LIMITS } = require('./constants');

const DEFAULT_URL = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases/download/catalog/catalog.json';
// github.com answers release downloads with a 302 to one of these CDN hosts.
const GITHUB_HOSTS = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 90000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const MAX_PLUGINS = 500;
const MAX_VERSIONS = 200;
const OFF_WORDS = new Set(['off', '0', 'false', 'no', 'disabled']);

class CatalogError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ─── Configuration ──────────────────────────────

/** GC_PLUGIN_CATALOG=off switches the catalogue off completely. */
function enabled() {
  return !OFF_WORDS.has(String(process.env.GC_PLUGIN_CATALOG || '').trim().toLowerCase());
}

/** The catalogue URL (GC_PLUGIN_CATALOG_URL or the default) — https only. */
function catalogUrl() {
  const raw = String(process.env.GC_PLUGIN_CATALOG_URL || '').trim() || DEFAULT_URL;
  let u;
  try { u = new URL(raw); } catch { throw new CatalogError('catalog_config', 'GC_PLUGIN_CATALOG_URL is not a URL'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new CatalogError('catalog_config', 'GC_PLUGIN_CATALOG_URL must be an https URL without credentials');
  return u;
}

/** host[:port] values a catalogue, package or redirect URL may point to. */
function allowedHosts() {
  const out = new Set(GITHUB_HOSTS);
  try { out.add(catalogUrl().host.toLowerCase()); } catch { /* reported by catalogUrl() itself */ }
  return out;
}

/** A URL string → URL when it is https, without credentials, on an allowed host; else null. */
function allowedUrl(raw, hosts) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return (hosts || allowedHosts()).has(u.host.toLowerCase()) ? u : null;
}

// ─── Transport ──────────────────────────────────

let agent = null;          // tests: an https.Agent trusting a test CA
let transportOverride = null;

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * One GET without following redirects: { status, location, body }.
 * The body is read only for 200 and never beyond `maxBytes`.
 */
function getOnce(url, { maxBytes, deadline }) {
  if (transportOverride) return transportOverride(url, { maxBytes, deadline });
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // a test run never reaches the internet (a local test server only)
    if (process.env.NODE_ENV === 'test' && !isLoopback(u.hostname)) return reject(new CatalogError('catalog_unreachable', 'no network in tests'));
    const left = deadline - Date.now();
    if (left <= 0) return reject(new CatalogError('catalog_timeout', 'timeout'));
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const req = https.get(u, {
      agent: agent || undefined,
      headers: { 'User-Agent': 'GateControl-plugin-catalog', Accept: 'application/octet-stream, application/json' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(resolve, { status, location: typeof res.headers.location === 'string' ? res.headers.location : null, body: null });
      }
      if (status !== 200) { res.resume(); return finish(resolve, { status, location: null, body: null }); }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        finish(reject, new CatalogError('catalog_too_large', 'response too large'));
        return res.destroy();
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > maxBytes) { finish(reject, new CatalogError('catalog_too_large', 'response too large')); res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status, location: null, body: Buffer.concat(chunks, size) }));
      res.on('error', (e) => finish(reject, new CatalogError('catalog_unreachable', e.message)));
      res.on('aborted', () => finish(reject, new CatalogError('catalog_unreachable', 'aborted')));
    });
    const timer = setTimeout(() => { finish(reject, new CatalogError('catalog_timeout', 'timeout')); req.destroy(); }, left);
    timer.unref();
    req.on('error', (e) => finish(reject, new CatalogError('catalog_unreachable', e.message)));
  });
}

/**
 * GET with redirects followed only to allowed hosts (https). Returns the body.
 * @param {string} url
 * @param {{maxBytes:number, timeoutMs:number, hosts?:Set<string>}} o
 */
async function fetchAllowed(url, o) {
  const hosts = o.hosts || allowedHosts();
  let u = allowedUrl(url, hosts);
  if (!u) throw new CatalogError('catalog_bad_url', 'URL not allowed');
  const deadline = Date.now() + o.timeoutMs;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await getOnce(u.href, { maxBytes: o.maxBytes, deadline });
    if (r.status >= 300 && r.status < 400) {
      let next = null;
      try { next = r.location ? new URL(r.location, u) : null; } catch { next = null; }
      const ok = next ? allowedUrl(next.href, hosts) : null;
      if (!ok) throw new CatalogError('catalog_redirect', 'redirect to a host that is not allowed');
      u = ok;
      continue;
    }
    if (r.status !== 200 || !Buffer.isBuffer(r.body)) throw new CatalogError('catalog_unreachable', 'HTTP ' + r.status);
    if (r.body.length > o.maxBytes) throw new CatalogError('catalog_too_large', 'response too large');
    return r.body;
  }
  throw new CatalogError('catalog_redirect', 'too many redirects');
}

// ─── Validation ─────────────────────────────────

const SHA256_RE = /^[0-9a-f]{64}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

function validId(id) {
  return typeof id === 'string' && id.length >= 2 && id.length <= 64 && ID_RE.test(id);
}

/** { de, en } (a plain string counts for both). */
function texts(v, max, where) {
  if (typeof v === 'string' && v.length <= max) return { de: v, en: v };
  if (!isObj(v)) throw new CatalogError('catalog_invalid', where + ': not a text');
  const de = typeof v.de === 'string' ? v.de : null;
  const en = typeof v.en === 'string' ? v.en : null;
  if ((de === null && en === null) || (de && de.length > max) || (en && en.length > max)) throw new CatalogError('catalog_invalid', where + ': invalid text');
  return { de: de ?? en, en: en ?? de };
}

function entry(e, id, where, hosts) {
  const bad = (what) => new CatalogError('catalog_invalid', `${where}: ${what}`);
  if (!isObj(e)) throw bad('not an object');
  if (e.schema !== 1) throw bad('schema');
  if (e.id !== id) throw bad('id');
  if (!semver.valid(e.version)) throw bad('version');
  if (typeof e.prerelease !== 'boolean') throw bad('prerelease');
  if (!str(e.gatecontrol, 200) || !semver.validRange(e.gatecontrol)) throw bad('gatecontrol');
  if (typeof e.license_required !== 'boolean') throw bad('license_required');
  if (!Number.isSafeInteger(e.size) || e.size < 20 || e.size > LIMITS.packageBytes) throw bad('size');
  if (typeof e.sha256 !== 'string' || !SHA256_RE.test(e.sha256)) throw bad('sha256');
  const url = allowedUrl(e.url, hosts);
  if (!url) throw bad('url');
  if (e.file != null && !str(e.file, 200)) throw bad('file');
  if (e.published_at != null && !str(e.published_at, 40)) throw bad('published_at');
  const releaseUrl = e.release_url == null ? null : allowedUrl(e.release_url, hosts);
  if (e.release_url != null && !releaseUrl) throw bad('release_url');
  return Object.freeze({
    version: e.version,
    // a semver pre-release ("1.2.0-rc.1") is a pre-release whatever the flag says
    prerelease: e.prerelease || semver.parse(e.version).pre.length > 0,
    gatecontrol: e.gatecontrol,
    licenseRequired: e.license_required,
    size: e.size,
    sha256: e.sha256,
    url: url.href,
    releaseUrl: releaseUrl ? releaseUrl.href : null,
    publishedAt: e.published_at || null,
  });
}

/**
 * Strict check of a parsed catalog.json.
 * @returns {{generatedAt:string|null, plugins: Map<string, {id, name, description, publisher, versions: object[]}>}}
 */
function validate(doc, hosts = allowedHosts()) {
  if (!isObj(doc) || doc.schema !== 1) throw new CatalogError('catalog_invalid', 'schema');
  if (!isObj(doc.plugins)) throw new CatalogError('catalog_invalid', 'plugins');
  const list = Object.entries(doc.plugins);
  if (list.length > MAX_PLUGINS) throw new CatalogError('catalog_invalid', 'too many plugins');
  const plugins = new Map();
  for (const [key, p] of list) {
    if (!validId(key)) throw new CatalogError('catalog_invalid', 'invalid plugin id');
    if (!isObj(p) || p.id !== key) throw new CatalogError('catalog_invalid', `${key}: id`);
    if (!str(p.publisher, 100)) throw new CatalogError('catalog_invalid', `${key}: publisher`);
    if (!Array.isArray(p.versions) || !p.versions.length || p.versions.length > MAX_VERSIONS) throw new CatalogError('catalog_invalid', `${key}: versions`);
    const versions = p.versions.map((e, i) => entry(e, key, `${key}.versions[${i}]`, hosts));
    if (p.latest != null) entry(p.latest, key, `${key}.latest`, hosts); // checked like the others, not used
    const seen = new Set();
    for (const v of versions) {
      if (seen.has(v.version)) throw new CatalogError('catalog_invalid', `${key}: duplicate version ${v.version}`);
      seen.add(v.version);
    }
    versions.sort((a, b) => semver.compare(b.version, a.version)); // newest first, whatever the file says
    plugins.set(key, Object.freeze({
      id: key,
      name: texts(p.name, 200, `${key}.name`),
      description: p.description == null ? { de: '', en: '' } : texts(p.description, 2000, `${key}.description`),
      publisher: p.publisher,
      versions: Object.freeze(versions),
    }));
  }
  return { generatedAt: str(doc.generated_at, 40) ? doc.generated_at : null, plugins };
}

// ─── Choice and state ───────────────────────────

/** Newest non-prerelease version compatible with `gcVersion` (null if none). */
function pick(plugin, gcVersion) {
  return plugin.versions.find((v) => !v.prerelease && semver.satisfies(gcVersion, v.gatecontrol)) || null;
}

/** Newest non-prerelease version at all (to say "needs GateControl ≥ …"). */
function newestStable(plugin) {
  return plugin.versions.find((v) => !v.prerelease) || null;
}

/**
 * What Settings → Plugins shows for one catalogue plugin.
 * state: not_installed | installed | update | incompatible
 * @param {{version:string}|null} installedPlugin  registry row (or null)
 */
function stateOf(plugin, installedPlugin, gcVersion) {
  const latest = pick(plugin, gcVersion);
  const newest = newestStable(plugin);
  const iv = installedPlugin && semver.valid(installedPlugin.version) ? installedPlugin.version : null;
  let state;
  if (!installedPlugin) state = latest ? 'not_installed' : 'incompatible';
  else if (latest && iv && semver.compare(iv, latest.version) < 0) state = 'update';
  else state = 'installed';
  // a newer release exists that needs a newer GateControl
  const blocked = newest && (!latest || semver.compare(newest.version, latest.version) > 0)
    && (!iv || semver.compare(newest.version, iv) > 0) ? { version: newest.version, gatecontrol: newest.gatecontrol } : null;
  return { state, latest, installedVersion: installedPlugin ? installedPlugin.version : null, blocked };
}

function view(cat, lang, installedOf, gcVersion) {
  const l = lang === 'en' ? 'en' : 'de';
  const out = [];
  for (const p of cat.plugins.values()) {
    const s = stateOf(p, installedOf(p.id), gcVersion);
    out.push({
      id: p.id,
      name: (l === 'en' ? p.name.en : p.name.de) || p.id,
      description: (l === 'en' ? p.description.en : p.description.de) || '',
      publisher: p.publisher,
      state: s.state,
      installedVersion: s.installedVersion,
      latest: s.latest ? { version: s.latest.version, gatecontrol: s.latest.gatecontrol, licenseRequired: s.latest.licenseRequired,
        size: s.latest.size, releaseUrl: s.latest.releaseUrl, publishedAt: s.latest.publishedAt } : null,
      requiresNewer: s.blocked,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, l));
}

// ─── Fetch + cache ──────────────────────────────

let cache = null;      // { at, cat } | { at, error }
let inFlight = null;

async function load() {
  const url = catalogUrl();
  const hosts = allowedHosts();
  const body = await fetchAllowed(url.href, { maxBytes: CATALOG_MAX_BYTES, timeoutMs: CATALOG_TIMEOUT_MS, hosts });
  let doc;
  try { doc = JSON.parse(body.toString('utf8')); } catch { throw new CatalogError('catalog_invalid', 'not JSON'); }
  return validate(doc, hosts);
}

/**
 * The validated catalogue (cached; `refresh` fetches again). Throws
 * CatalogError catalog_disabled / catalog_unreachable / catalog_invalid / ….
 */
async function get({ refresh = false } = {}) {
  if (!enabled()) throw new CatalogError('catalog_disabled', 'the plugin catalogue is switched off');
  const now = Date.now();
  if (!refresh && cache) {
    if (cache.cat && now - cache.at < CACHE_TTL_MS) return cache.cat;
    if (cache.error && now - cache.at < ERROR_TTL_MS) throw cache.error;
  }
  if (!inFlight) {
    inFlight = load().then((cat) => {
      cache = { at: Date.now(), cat };
      return cat;
    }, (e) => {
      const err = e instanceof CatalogError ? e : new CatalogError('catalog_unreachable', e && e.message);
      cache = { at: Date.now(), error: err };
      throw err;
    }).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** When the catalogue was fetched last (null if never / not cached). */
function fetchedAt() {
  return cache && cache.cat ? new Date(cache.at).toISOString() : null;
}

/**
 * The catalogue entry an administrator may install: listed, not a
 * pre-release, compatible with this GateControl.
 */
function installable(cat, id, version, gcVersion) {
  if (!validId(id) || !semver.valid(version)) throw new CatalogError('catalog_unknown', 'not in the catalogue');
  const p = cat.plugins.get(id);
  const e = p ? p.versions.find((v) => v.version === version) : null;
  if (!e || e.prerelease) throw new CatalogError('catalog_unknown', 'not in the catalogue');
  if (!semver.satisfies(gcVersion, e.gatecontrol)) throw new CatalogError('catalog_incompatible', 'needs another GateControl version');
  return e;
}

/**
 * Download one catalogue version: the package bytes, sha256-checked.
 * @returns {Promise<{buf: Buffer, entry: object}>}
 */
async function download(id, version, gcVersion, { refresh = false } = {}) {
  const cat = await get({ refresh });
  const e = installable(cat, id, version, gcVersion);
  const max = Math.min(e.size, LIMITS.packageBytes);
  let buf;
  try {
    buf = await fetchAllowed(e.url, { maxBytes: max, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof CatalogError && err.code === 'catalog_unreachable') throw new CatalogError('catalog_download_failed', err.message);
    throw err;
  }
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (digest !== e.sha256) throw new CatalogError('catalog_hash_mismatch', 'the download does not match the catalogue');
  return { buf, entry: e };
}

module.exports = {
  CatalogError, DEFAULT_URL, GITHUB_HOSTS, CACHE_TTL_MS,
  enabled, catalogUrl, allowedHosts, allowedUrl, validate, pick, stateOf, view, get, fetchedAt, installable, download, fetchAllowed,
  _setTransport(fn) { transportOverride = fn || null; },
  _setAgent(a) { agent = a || null; },
  _reset() { cache = null; inFlight = null; transportOverride = null; agent = null; },
};
