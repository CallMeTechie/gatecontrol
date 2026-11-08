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
//              overall timeout; cached in memory (CACHE_TTL_MS). A release
//              download on github.com that answers 5xx or not in time is
//              fetched over the API instead (utils/githubRelease.js:
//              api.github.com → the asset CDN, asset id and ETag kept, the
//              rate limit respected) — never for another catalogue URL.
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
const gh = require('../../utils/githubRelease');
const warnOnce = require('../../utils/warnOnce');
const { trackPhases, describe: describePhase } = require('../../utils/httpPhase');
const { ID_RE, LIMITS } = require('./constants');

const DEFAULT_URL = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases/download/catalog/catalog.json';
// github.com answers release downloads with a 302 to one of these CDN hosts.
const GITHUB_HOSTS = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
// the whole fetch of the catalogue, both ways together (the download path and the API route)
const CATALOG_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 90000;
// the download path of github.com: no answer (headers) in this time → the API route
const TIMEOUTS = { catalogHeaders: 4000, downloadHeaders: 8000 };
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 15 * 60 * 1000; // a new release shows within 15 min (before 1.186.3: 1 h)
const ERROR_TTL_MS = 60 * 1000;
const CACHED_MAX_MS = 24 * 60 * 60 * 1000; // cached(): the last catalogue without a fetch, up to a day old
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
function getOnce(url, { maxBytes, deadline, headers = null, headerMs = null }) {
  if (transportOverride) return transportOverride(url, { maxBytes, deadline, headers, headerMs });
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // a test run never reaches the internet (a local test server only)
    if (process.env.NODE_ENV === 'test' && !isLoopback(u.hostname)) return reject(new CatalogError('catalog_unreachable', 'no network in tests'));
    const left = deadline - Date.now();
    if (left <= 0) return reject(new CatalogError('catalog_timeout', 'timeout'));
    let done = false;
    let headerTimer = null;
    let phase = null;
    // an error says where the request was (dns, connect, tls, first byte) and what the name resolved to
    const where = (e) => Object.assign(e, { host: u.host, phase: phase ? phase() : null });
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(headerTimer); fn(v instanceof Error ? where(v) : v); };
    const req = https.get(u, {
      agent: agent || undefined,
      headers: { 'User-Agent': 'GateControl-plugin-catalog', Accept: 'application/octet-stream, application/json', ...(headers || {}) },
    }, (res) => {
      clearTimeout(headerTimer);
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(resolve, { status, headers: res.headers, location: typeof res.headers.location === 'string' ? res.headers.location : null, body: null });
      }
      if (status !== 200) { res.resume(); return finish(resolve, { status, headers: res.headers, location: null, body: null }); }
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
      res.on('end', () => finish(resolve, { status, headers: res.headers, location: null, body: Buffer.concat(chunks, size) }));
      res.on('error', (e) => finish(reject, new CatalogError('catalog_unreachable', e.message)));
      res.on('aborted', () => finish(reject, new CatalogError('catalog_unreachable', 'aborted')));
    });
    phase = trackPhases(req);
    const timer = setTimeout(() => { finish(reject, new CatalogError('catalog_timeout', 'timeout')); req.destroy(); }, left);
    timer.unref();
    if (headerMs && headerMs < left) {
      headerTimer = setTimeout(() => { finish(reject, new CatalogError('catalog_timeout', 'no answer')); req.destroy(); }, headerMs);
      headerTimer.unref();
    }
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
  const deadline = o.deadline || Date.now() + o.timeoutMs;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // the request headers (the API's Accept) only to the first host; the CDN gets none
    const r = await getOnce(u.href, { maxBytes: o.maxBytes, deadline, headers: hop === 0 ? o.headers || null : null, headerMs: o.headerMs || null });
    if (o.onAnswer) o.onAnswer(r, hop);
    if (r.status >= 300 && r.status < 400) {
      let next = null;
      try { next = r.location ? new URL(r.location, u) : null; } catch { next = null; }
      const ok = next ? allowedUrl(next.href, hosts) : null;
      if (!ok) throw new CatalogError('catalog_redirect', 'redirect to a host that is not allowed');
      u = ok;
      continue;
    }
    if (r.status !== 200 || !Buffer.isBuffer(r.body)) throw Object.assign(new CatalogError('catalog_unreachable', 'HTTP ' + r.status), { status: r.status });
    if (r.body.length > o.maxBytes) throw new CatalogError('catalog_too_large', 'response too large');
    return r.body;
  }
  throw new CatalogError('catalog_redirect', 'too many redirects');
}

/** "no answer (api.github.com, phase tls, 140.82.121.6 (IPv4), 4001 ms)" — an error with where it hung, for the log. */
function errText(e) {
  if (!e) return null;
  const msg = String(e.message || e.code || 'failed');
  return e.phase ? `${msg} (${e.host ? e.host + ', ' : ''}${describePhase(e.phase)})` : (e.host ? `${msg} (${e.host})` : msg);
}

/** A failure the API route may get round: 5xx, no answer in time, no connection — not 4xx, a refused redirect or a size cap. */
function worthFallback(e) {
  if (!(e instanceof CatalogError)) return false;
  if (e.code === 'catalog_timeout') return true;
  return e.code === 'catalog_unreachable' && gh.worthFallback(e.status == null ? null : e.status);
}

/** The bytes of a release asset over the API (utils/githubRelease.js), with the same caps; hosts: the API and the asset CDN. */
async function viaApi(ref, { maxBytes, deadline, headerMs = null }) {
  const hosts = new Set([gh.API_HOST, ...gh.ASSET_HOSTS]);
  // the API gets the same time to answer as the download path (a hanging API must leave time for the other way)
  const get = async (url, headers) => getOnce(url, { maxBytes: gh.RELEASE_MAX_BYTES, deadline, headers, headerMs });
  for (let attempt = 0; attempt < 2; attempt++) {
    let asset;
    try { asset = await gh.assetOf(ref, get); } catch (e) {
      if (e instanceof CatalogError) throw e;
      throw Object.assign(new CatalogError(e.code === 'rate_limited' ? 'catalog_rate_limited' : 'catalog_unreachable', e.message), { status: e.status });
    }
    if (asset.size != null && asset.size > maxBytes) throw new CatalogError('catalog_too_large', 'response too large');
    try {
      return await fetchAllowed(gh.assetUrl(ref, asset.id), {
        maxBytes, deadline, hosts, headers: { Accept: 'application/octet-stream' }, headerMs,
        onAnswer: (r, hop) => { if (hop === 0 && gh.noteRateLimit(r.status, r.headers)) throw new CatalogError('catalog_rate_limited', 'GitHub API rate limit reached'); },
      });
    } catch (e) {
      // the file was replaced (rolling release): a new asset id
      if (attempt === 0 && e instanceof CatalogError && e.status === 404) { gh.forget(ref); continue; }
      throw e;
    }
  }
  throw new CatalogError('catalog_unreachable', 'asset not found');
}

/**
 * fetchAllowed for a catalogue or package URL. A release download on
 * github.com that answers 5xx or no headers within `headerMs` takes the API
 * route (after such a failure for API_FIRST_MS at once); any other URL and
 * any other failure stays as it is.
 */
async function fetchRelease(url, o) {
  const ref = gh.parseDownloadUrl(url);
  if (!ref) return fetchAllowed(url, o);
  const what = o.what || 'download';
  const deadline = Date.now() + o.timeoutMs;
  let first = null;
  if (!gh.apiFirst()) {
    try { return await fetchAllowed(url, { ...o, deadline, headerMs: o.headerMs }); } catch (e) {
      if (!worthFallback(e)) throw e;
      first = e;
      gh.noteDegraded();
    }
  }
  try {
    const body = await viaApi(ref, { maxBytes: o.maxBytes, deadline, headerMs: o.headerMs });
    // one line per outage and way, not one per request
    const back = warnOnce.recovered(`catalog-fallback:${what}`);
    warnOnce.throttled(`catalog-fallback-ok:${what}`, { reason: first ? errText(first) : 'download path failed before', ...(back ? { failedForMs: back.sinceMs } : {}) },
      `plugin ${what} via api fallback: ok`, { level: 'info', everyMs: gh.API_FIRST_MS });
    return body;
  } catch (e) {
    const fail = (download) => warnOnce.throttled(`catalog-fallback:${what}`, { download, api: e.code === 'catalog_rate_limited' ? 'rate_limited' : errText(e) },
      `plugin ${what} via api fallback: failed`);
    // a refused redirect or a size cap on the API way: that answer counts
    if (e.code === 'catalog_redirect' || e.code === 'catalog_bad_url' || e.code === 'catalog_too_large') { fail(first ? errText(first) : null); throw e; }
    // the API way was the only try (download path failed a while ago): the download path once more
    if (!first && Date.now() < deadline) {
      try {
        const body = await fetchAllowed(url, { ...o, deadline });
        warnOnce.recovered(`catalog-fallback:${what}`);
        return body;
      } catch (e2) { fail(errText(e2)); throw Object.assign(e2, { viaApi: errText(e) }); }
    }
    fail(first ? errText(first) : null);
    // both failed: the download path's answer (HTTP 504, timeout), marked when the API refused for its rate limit
    if (first) throw Object.assign(first, { viaApi: e.code === 'catalog_rate_limited' ? 'rate_limited' : errText(e) });
    throw e;
  }
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
  // release notes (the CHANGELOG section): optional, informational — a bad value is dropped
  const notes = typeof e.notes === 'string' && e.notes.trim() ? e.notes.trim().slice(0, NOTES_MAX) : null;
  // plugins this one replaces (plugin.json `replaces`): optional, a bad value is dropped
  const replaces = Array.isArray(e.replaces) ? [...new Set(e.replaces.filter((r) => validId(r) && r !== id))].slice(0, 3) : [];
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
    notes,
    replaces: Object.freeze(replaces),
  });
}

// ─── Store metadata (catalog-meta.json of the plugins repository) ───────
// Optional and lenient: an unknown or malformed value is dropped, never the
// catalogue (older GateControls ignore these fields altogether).

const CATEGORIES = new Set(['family', 'home', 'work', 'mobility', 'infrastructure', 'other']);
const ICONS = new Set(['family', 'chat', 'calendar', 'door', 'bulb', 'snowflake', 'car', 'server', 'nas', 'puzzle', 'cloud', 'mail']);
// symbols of the detail page's lists ("Was … hinzufügt", "Das darf das Plugin")
const DETAIL_ICONS = new Set(['page', 'app', 'portal', 'widget', 'tile', 'action', 'bell', 'clock', 'data', 'network', 'chat', 'key',
  'location', 'users', 'door', 'calendar', 'camera', 'car', 'bulb', 'server', 'shield', 'link', 'mail', 'cloud', 'ai']);
// wireframes of "So sieht es bei dir aus"
const SHOW_KINDS = new Set(['tile', 'list', 'widget']);
const LANGS = new Set(['de', 'en']);
const NOTES_MAX = 8000;

/** { de, en } of at most `max` characters each, or null. */
function optTexts(v, max) {
  try {
    const t = texts(v, max, 'meta');
    return t.de || t.en ? t : null;
  } catch { return null; }
}

function meta(p, key) {
  const out = {};
  if (CATEGORIES.has(p.category)) out.category = p.category;
  if (ICONS.has(p.icon)) out.icon = p.icon;
  const summary = optTexts(p.summary, 300);
  if (summary) out.summary = summary;
  if (p.audience === 'all' || p.audience === 'admins') out.audience = p.audience;
  if (Array.isArray(p.keywords)) {
    const kw = p.keywords.filter((k) => typeof k === 'string' && k.length > 0 && k.length <= 40).slice(0, 20).map((k) => k.toLowerCase());
    if (kw.length) out.keywords = kw;
  }
  if (Array.isArray(p.related)) {
    const rel = p.related.filter((r) => validId(r) && r !== key).slice(0, 6);
    if (rel.length) out.related = rel;
  }
  const h = p.highlight;
  if (isObj(h) && semver.valid(h.version)) {
    const title = optTexts(h.title, 120);
    const text = optTexts(h.text, 400);
    // the hero's tags: "text" or { icon, text }
    const tags = Array.isArray(h.tags) ? h.tags.map((x) => {
      const text = optTexts(isObj(x) && !('de' in x) && !('en' in x) ? x.text : x, 40);
      return text ? { icon: isObj(x) && DETAIL_ICONS.has(x.icon) ? x.icon : null, text } : null;
    }).filter(Boolean).slice(0, 4) : [];
    if (title) out.highlight = { version: h.version, title, text: text || { de: '', en: '' }, tags };
  }
  // detail page: what the plugin adds, what it may do, how it looks, what it needs
  const rows = (list, max, textMax) => (Array.isArray(list) ? list : []).map((x) => {
    if (!isObj(x)) return null;
    const title = optTexts(x.title, 80);
    if (!title) return null;
    return { icon: DETAIL_ICONS.has(x.icon) ? x.icon : null, title, text: optTexts(x.text, textMax), tag: optTexts(x.tag, 24) };
  }).filter(Boolean).slice(0, max);
  const adds = rows(p.adds, 8, 120);
  if (adds.length) out.adds = adds.map(({ icon, title, text }) => ({ icon, title, text }));
  const perms = rows(p.permissions, 10, 200);
  if (perms.length) out.permissions = perms;
  const shows = (Array.isArray(p.shows) ? p.shows : []).map((x) => {
    if (!isObj(x) || !SHOW_KINDS.has(x.kind)) return null;
    const caption = optTexts(x.caption, 60);
    if (!caption) return null;
    return { kind: x.kind, caption, value: typeof x.value === 'string' && x.value.length <= 12 ? x.value : null };
  }).filter(Boolean).slice(0, 3);
  if (shows.length) out.shows = shows;
  const needs = optTexts(p.needs, 80);
  if (needs) out.needs = needs;
  if (Array.isArray(p.languages)) {
    const langs = [...new Set(p.languages.filter((x) => LANGS.has(x)))];
    if (langs.length) out.languages = langs;
  }
  return out;
}

function validateHead(doc) {
  if (!isObj(doc) || doc.schema !== 1) throw new CatalogError('catalog_invalid', 'schema');
  if (!isObj(doc.plugins)) throw new CatalogError('catalog_invalid', 'plugins');
  const list = Object.entries(doc.plugins);
  if (list.length > MAX_PLUGINS) throw new CatalogError('catalog_invalid', 'too many plugins');
  return list;
}

function validatePlugin(key, p, hosts) {
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
  return Object.freeze({
    id: key,
    name: texts(p.name, 200, `${key}.name`),
    description: p.description == null ? { de: '', en: '' } : texts(p.description, 2000, `${key}.description`),
    publisher: p.publisher,
    versions: Object.freeze(versions),
    // what the newest release replaces (an installed one moves over on install)
    replaces: (versions.find((v) => !v.prerelease) || versions[0]).replaces,
    meta: Object.freeze(meta(p, key)),
  });
}

/**
 * Strict check of a parsed catalog.json.
 * @returns {{generatedAt:string|null, plugins: Map<string, {id, name, description, publisher, versions: object[]}>}}
 */
function validate(doc, hosts = allowedHosts()) {
  const plugins = new Map();
  for (const [key, p] of validateHead(doc)) plugins.set(key, validatePlugin(key, p, hosts));
  return { generatedAt: str(doc.generated_at, 40) ? doc.generated_at : null, plugins };
}

const SLICE_MS = 10;

/** validate() with the event loop running between the plugins (every SLICE_MS) — a catalogue of up to 2 MB. */
async function validateAsync(doc, hosts = allowedHosts()) {
  const plugins = new Map();
  let start = Date.now();
  for (const [key, p] of validateHead(doc)) {
    plugins.set(key, validatePlugin(key, p, hosts));
    if (Date.now() - start >= SLICE_MS) { await new Promise((r) => setImmediate(r)); start = Date.now(); }
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

function pickText(t, l) { return t ? ((l === 'en' ? t.en : t.de) || '') : ''; }

/** Store metadata of one catalogue plugin in one language. */
function metaView(p, l) {
  const m = p.meta || {};
  return {
    category: m.category || 'other',
    icon: m.icon || null,
    summary: pickText(m.summary, l),
    audience: m.audience || 'all',
    keywords: m.keywords || [],
    related: m.related || [],
    highlight: m.highlight ? { version: m.highlight.version, title: pickText(m.highlight.title, l), text: pickText(m.highlight.text, l),
      tags: (m.highlight.tags || []).map((x) => ({ icon: x.icon, text: pickText(x.text, l) })) } : null,
    adds: (m.adds || []).map((x) => ({ icon: x.icon, title: pickText(x.title, l), text: x.text ? pickText(x.text, l) : '' })),
    permissions: (m.permissions || []).map((x) => ({ icon: x.icon, title: pickText(x.title, l), text: x.text ? pickText(x.text, l) : '', tag: x.tag ? pickText(x.tag, l) : null })),
    shows: (m.shows || []).map((x) => ({ kind: x.kind, caption: pickText(x.caption, l), value: x.value })),
    needs: m.needs ? pickText(m.needs, l) : null,
    languages: m.languages || [],
  };
}

function versionView(v, gcVersion) {
  return { version: v.version, gatecontrol: v.gatecontrol, compatible: semver.satisfies(gcVersion, v.gatecontrol), prerelease: v.prerelease,
    licenseRequired: v.licenseRequired, size: v.size, releaseUrl: v.releaseUrl, publishedAt: v.publishedAt, notes: v.notes || null };
}

/**
 * The installed plugin a catalogue plugin would replace (it is not installed
 * itself and lists the installed one under `replaces`), or null.
 */
function replacing(p, installedOf) {
  if (!p.replaces || !p.replaces.length || installedOf(p.id)) return null;
  for (const id of p.replaces) {
    const old = installedOf(id);
    if (old) return old;
  }
  return null;
}

/** Ids a listed catalogue plugin replaces — left out of the list (the new one stands for them). */
function replacedIds(cat) {
  const out = new Set();
  for (const p of cat.plugins.values()) for (const id of p.replaces || []) out.add(id);
  return out;
}

function itemView(p, l, installedOf, gcVersion) {
  const old = replacing(p, installedOf);
  const s = stateOf(p, installedOf(p.id) || old, gcVersion);
  return {
    id: p.id,
    name: (l === 'en' ? p.name.en : p.name.de) || p.id,
    description: (l === 'en' ? p.description.en : p.description.de) || '',
    publisher: p.publisher,
    ...metaView(p, l),
    // taking over an earlier id is offered like an update, whatever the version numbers say
    state: old && s.latest ? 'update' : s.state,
    installedVersion: s.installedVersion,
    latest: s.latest ? versionView(s.latest, gcVersion) : null,
    requiresNewer: s.blocked,
    // installed under an earlier id: installing this one takes it over ("update")
    replaces: old ? { id: old.id, name: old.name || old.id, version: old.version } : null,
  };
}

function view(cat, lang, installedOf, gcVersion) {
  const l = lang === 'en' ? 'en' : 'de';
  const out = [];
  const replaced = replacedIds(cat);
  for (const p of cat.plugins.values()) if (!replaced.has(p.id)) out.push(itemView(p, l, installedOf, gcVersion));
  return out.sort((a, b) => a.name.localeCompare(b.name, l));
}

/**
 * One catalogue plugin with its version history (newest first, at most
 * `max`, pre-releases left out) — the "Versionen" tab and the update notes.
 * null when the catalogue does not list it.
 */
function detail(cat, id, lang, installedOf, gcVersion, max = 20) {
  const p = validId(id) ? cat.plugins.get(id) : null;
  if (!p) return null;
  const l = lang === 'en' ? 'en' : 'de';
  return { ...itemView(p, l, installedOf, gcVersion),
    versions: p.versions.filter((v) => !v.prerelease).slice(0, max).map((v) => versionView(v, gcVersion)) };
}

/**
 * Release notes of the versions after `from` up to and including `to`
 * (newest first) — what an update brings. [] when not in the catalogue.
 */
function notesBetween(cat, id, from, to) {
  const p = validId(id) ? cat.plugins.get(id) : null;
  if (!p || !semver.valid(to)) return [];
  return p.versions.filter((v) => !v.prerelease && semver.compare(v.version, to) <= 0
    && (!semver.valid(from) || semver.compare(v.version, from) > 0))
    .map((v) => ({ version: v.version, publishedAt: v.publishedAt, notes: v.notes || null }));
}

/** The catalogue in the cache — no fetch (null when there is none). */
function cached() {
  const c = cache && cache.cat ? cache : good;
  return c && Date.now() - c.at < CACHED_MAX_MS ? c.cat : null;
}

// ─── Fetch + cache ──────────────────────────────

let cache = null;      // { at, cat } | { at, error }
let good = null;       // { at, cat }: the last catalogue that loaded — served (stale) while a fetch fails, up to CACHED_MAX_MS
let inFlight = null;

async function load() {
  const url = catalogUrl();
  const hosts = allowedHosts();
  const body = await fetchRelease(url.href, { maxBytes: CATALOG_MAX_BYTES, timeoutMs: CATALOG_TIMEOUT_MS, headerMs: TIMEOUTS.catalogHeaders, hosts, what: 'catalogue' });
  let doc;
  try { doc = JSON.parse(body.toString('utf8')); } catch { throw new CatalogError('catalog_invalid', 'not JSON'); }
  return validateAsync(doc, hosts);
}

function staleOr(err, now = Date.now()) {
  if (good && now - good.at < CACHED_MAX_MS) return good.cat;
  throw err;
}

/**
 * The validated catalogue (cached; `refresh` fetches again). When a fetch
 * fails, the last catalogue that loaded (up to a day old) is answered instead
 * — stale() says so. Throws CatalogError catalog_disabled /
 * catalog_unreachable / catalog_invalid / … when there is none.
 */
async function get({ refresh = false } = {}) {
  if (!enabled()) throw new CatalogError('catalog_disabled', 'the plugin catalogue is switched off');
  const now = Date.now();
  if (!refresh && cache) {
    if (cache.cat && now - cache.at < CACHE_TTL_MS) return cache.cat;
    if (cache.error && now - cache.at < ERROR_TTL_MS) return staleOr(cache.error, now);
  }
  if (!inFlight) {
    inFlight = load().then((cat) => {
      cache = { at: Date.now(), cat };
      good = { at: cache.at, cat };
      return cat;
    }, (e) => {
      const err = e instanceof CatalogError ? e : new CatalogError('catalog_unreachable', e && e.message);
      cache = { at: Date.now(), error: err };
      throw err;
    }).finally(() => { inFlight = null; });
  }
  try { return await inFlight; } catch (e) { return staleOr(e); }
}

/** When the catalogue in use was fetched (null if never / not cached). */
function fetchedAt() {
  const c = cache && cache.cat ? cache : good;
  return c ? new Date(c.at).toISOString() : null;
}

/** The catalogue in use is an older one because the last fetch failed: { code, since } — else null. */
function stale() {
  return cache && cache.error && good && Date.now() - good.at < CACHED_MAX_MS ? { code: cache.error.code, since: new Date(cache.at).toISOString() } : null;
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
    buf = await fetchRelease(e.url, { maxBytes: max, timeoutMs: DOWNLOAD_TIMEOUT_MS, headerMs: TIMEOUTS.downloadHeaders, what: 'package' });
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
  enabled, catalogUrl, allowedHosts, allowedUrl, validate, validateAsync, pick, stateOf, replacing, view, detail, notesBetween, cached, get, fetchedAt, stale, errText, installable, download, fetchAllowed, fetchRelease,
  TIMEOUTS,
  CATEGORIES, ICONS,
  _setTransport(fn) { transportOverride = fn || null; },
  _setAgent(a) { agent = a || null; },
  _reset() { cache = null; good = null; inFlight = null; transportOverride = null; agent = null; gh._resetForTest(); warnOnce._resetForTest(); },
};
