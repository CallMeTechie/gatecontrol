'use strict';

// What changed in each gateway release — the "Versionen" of the Gateways page
// (public/js/gateway-docs.js, GET /api/v1/gateways/releases). The source is the
// one the version check already uses (services/gatewayRelease.js): the GitHub
// releases of the gateway repository; every merge there is a release whose
// notes list the merged changes ("## What's Changed" + "* <title> by @… in …/pull/N").
//
// Offline-safe: the list is kept in memory and in a file next to the database
// (gateway-releases.json) and shown from there when GitHub cannot be reached
// (`stale`: the last check failed; `available: false`: never loaded). A check
// at most every 6 h (ETag → a 304 costs nothing of the API limit), a manual
// "Neu laden" at most once a minute. The notes are untrusted text: only the
// Markdown string goes to the page, which renders it as text
// (public/js/plugins-ui.js noteLines, like the release notes of the plugins).

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');
const { compareVersions } = require('../utils/version');

const REPO = process.env.GC_GATEWAY_REPO || 'CallMeTechie/gatecontrol-gateway';
const TOKEN = process.env.GC_CLIENT_GITHUB_TOKEN || '';
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=60`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const TTL = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAIL = 10 * 60 * 1000;
const MANUAL_MIN = 60 * 1000;
const TIMEOUT = 8000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_VERSIONS = 60;
const NOTES_MAX = 8000;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

const PERSIST_FILE = process.env.GC_GATEWAY_RELEASES_CACHE
  || path.join(path.dirname(process.env.GC_DB_PATH || path.join(__dirname, '..', '..', 'data', 'gatecontrol.db')), 'gateway-releases.json');

let transportOverride = null; // tests: (url, headers) → Promise<{ status, headers, body }>

class ReleaseNotesError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ─── Notes ─────────────────────────────────────────────

const CC_PREFIX = /^(?:feat|fix|perf|refactor|docs|test|tests|chore|ci|build|style|revert)(?:\([^)]{0,60}\))?!?: /i;
// the end of a line GitHub writes: " by @user in https://github.com/<owner>/<repo>/pull/N"
const BY_PR = /^ by @[A-Za-z0-9][\w-]{0,38}(?:\[bot\])? in https:\/\/github\.com\/[\w.-]{1,100}\/[\w.-]{1,100}\/pull\/(\d{1,7})$/;

/** "<title> by @user in <pull URL>" → "<title> (#N)"; the conventional-commit prefix dropped. */
function itemText(text) {
  let out = text;
  const k = out.lastIndexOf(' by @');
  if (k !== -1) {
    const m = BY_PR.exec(out.slice(k));
    if (m) out = out.slice(0, k).trimEnd() + ' (#' + m[1] + ')';
  }
  return out.replace(CC_PREFIX, '');
}

/**
 * A release body as GitHub writes it → the plain list of changes (Markdown):
 * no "What's Changed" heading, no "by @user in <pull URL>" (→ "(#N)"), no
 * conventional-commit prefix ("feat(radio): "), no "Full Changelog" and
 * "New Contributors". Anything else stays as written (rendered as text).
 */
function cleanNotes(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').replace(/\0/g, '').split('\n');
  const out = [];
  let skip = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const head = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (head) {
      skip = /^new contributors$/i.test(head[1].trim());
      if (!skip && !/^what'?s changed$/i.test(head[1].trim())) out.push(line);
      continue;
    }
    if (skip) continue;
    if (/^\s*\*\*full changelog\*\*/i.test(line)) continue;
    const tl = line.trim();
    if (tl.startsWith('<!--') && tl.endsWith('-->')) continue;
    const li = /^( *)[-*+] (.*)$/.exec(line);
    if (li) {
      out.push(li[1] + '- ' + itemText(li[2].trim()));
      continue;
    }
    out.push(line);
  }
  // no empty lines at the start or end, at most one in a row
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > NOTES_MAX ? text.slice(0, NOTES_MAX).replace(/\n[^\n]*$/, '') : text;
}

/** One release of the API → { version, published_at, notes, url } or null (draft, pre-release, no version). */
function releaseOf(r) {
  if (!r || typeof r !== 'object' || r.draft || r.prerelease) return null;
  const version = String(r.tag_name || '').trim().replace(/^v/i, '');
  if (!VERSION_RE.test(version)) return null;
  const at = typeof r.published_at === 'string' && !Number.isNaN(Date.parse(r.published_at)) ? new Date(r.published_at).toISOString() : null;
  const page = `${RELEASES_URL}/tag/`;
  const url = typeof r.html_url === 'string' && r.html_url.startsWith(page) && !/[\s"'<>\\]/.test(r.html_url) && r.html_url.length < 300
    ? r.html_url : `${page}v${version}`;
  const notes = typeof r.body === 'string' ? cleanNotes(r.body) : '';
  return { version, published_at: at, notes: notes || null, url };
}

/** The API answer → the versions, newest first (one entry per version). */
function parse(list) {
  if (!Array.isArray(list)) throw new ReleaseNotesError('releases_invalid', 'not a list');
  const seen = new Set();
  return list.map(releaseOf).filter((v) => v && !seen.has(v.version) && seen.add(v.version))
    .sort((a, b) => compareVersions(b.version, a.version)).slice(0, MAX_VERSIONS);
}

// ─── Cache ─────────────────────────────────────────────

function validStored(s) {
  if (!s || !Array.isArray(s.versions)) return null;
  const versions = s.versions.filter((v) => v && VERSION_RE.test(String(v.version))
    && (v.notes === null || typeof v.notes === 'string') && typeof v.url === 'string' && v.url.startsWith(RELEASES_URL + '/'))
    .map((v) => ({ version: v.version, published_at: typeof v.published_at === 'string' ? v.published_at : null, notes: v.notes ? v.notes.slice(0, NOTES_MAX) : null, url: v.url }))
    .slice(0, MAX_VERSIONS);
  return { versions, fetchedAt: Number(s.fetchedAt) || 0, etag: typeof s.etag === 'string' ? s.etag.slice(0, 200) : null };
}

function load() {
  try { return validStored(JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'))); } catch { return null; }
}

function persist() {
  try { fs.writeFileSync(PERSIST_FILE, JSON.stringify({ versions: state.versions, fetchedAt: state.fetchedAt, etag: state.etag })); }
  catch (err) { logger.warn({ err: err.message }, 'gateway release notes persist failed'); }
}

const stored = load();
const state = {
  versions: stored ? stored.versions : [],
  fetchedAt: stored ? stored.fetchedAt : 0, // last good answer (200 or 304)
  etag: stored ? stored.etag : null,
  attemptAt: 0,                              // last try (good or not)
  error: null,                               // code of the last failed try
};
let inFlight = null;

// ─── Fetch ─────────────────────────────────────────────

function get(url, headers) {
  if (transportOverride) return transportOverride(url, headers);
  // a test run never reaches the internet
  if (process.env.NODE_ENV === 'test') return Promise.reject(new ReleaseNotesError('releases_unreachable', 'no network in tests'));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode || 0;
      if (status !== 200) { res.resume(); return finish(resolve, { status, headers: res.headers, body: null }); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { finish(reject, new ReleaseNotesError('releases_too_large', 'answer too large')); res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks, size).toString('utf8') }));
      res.on('error', (e) => finish(reject, new ReleaseNotesError('releases_unreachable', e.message)));
    });
    const timer = setTimeout(() => { finish(reject, new ReleaseNotesError('releases_unreachable', 'timeout')); req.destroy(); }, TIMEOUT);
    if (timer.unref) timer.unref();
    req.on('error', (e) => finish(reject, new ReleaseNotesError('releases_unreachable', e.message)));
  });
}

async function fetchNow() {
  state.attemptAt = Date.now();
  const headers = { 'User-Agent': 'GateControl', Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (state.etag && state.versions.length) headers['If-None-Match'] = state.etag;
  try {
    const r = await get(API_URL, headers);
    if (r.status === 304) { state.fetchedAt = Date.now(); state.error = null; persist(); return; }
    if (r.status !== 200 || typeof r.body !== 'string') throw new ReleaseNotesError('releases_unreachable', 'HTTP ' + r.status);
    let json;
    try { json = JSON.parse(r.body); } catch { throw new ReleaseNotesError('releases_invalid', 'no JSON'); }
    state.versions = parse(json);
    state.fetchedAt = Date.now();
    const etag = r.headers && r.headers.etag;
    state.etag = typeof etag === 'string' && etag.length < 200 ? etag : null;
    state.error = null;
    persist();
  } catch (e) {
    state.error = e && e.code ? e.code : 'releases_unreachable';
    logger.warn({ err: e && e.message }, 'gateway release notes fetch failed');
  }
}

/**
 * The versions, newest first, from the cache — checked again when it is old
 * (or `refresh`, at most once a minute). Never throws: without GitHub the last
 * known list (stale) or none (available: false).
 * @returns {Promise<{ available:boolean, stale:boolean, fetched_at:number|null, error:string|null, versions:object[] }>}
 */
async function list({ refresh = false } = {}) {
  const now = Date.now();
  const old = now - state.fetchedAt > TTL;
  const mayTry = now - state.attemptAt > (refresh ? MANUAL_MIN : RETRY_AFTER_FAIL) || (old && !state.error);
  if ((old || refresh) && mayTry && !inFlight) inFlight = fetchNow().finally(() => { inFlight = null; });
  // a list in hand answers at once (the check runs on in the background); without one, or for
  // "Neu laden", the answer waits for the check
  if (inFlight && (refresh || !state.versions.length)) await inFlight;
  return view();
}

function view() {
  return {
    available: state.fetchedAt > 0 || state.versions.length > 0,
    stale: !!state.error,
    fetched_at: state.fetchedAt || null,
    error: state.error,
    versions: state.versions.slice(),
  };
}

/** The versions after `from` up to and including `to` (newest first) — what an update brings. */
function between(versions, from, to) {
  if (!VERSION_RE.test(String(from || ''))) return [];
  return (versions || []).filter((v) => compareVersions(v.version, from) > 0
    && (!VERSION_RE.test(String(to || '')) || compareVersions(v.version, to) <= 0));
}

module.exports = {
  list, between, cleanNotes, parse, RELEASES_URL, VERSION_RE, ReleaseNotesError,
  _setTransport: (fn) => { transportOverride = fn; },
  _reset: (s = {}) => { state.versions = s.versions || []; state.fetchedAt = s.fetchedAt || 0; state.etag = s.etag || null; state.attemptAt = s.attemptAt || 0; state.error = s.error || null; inFlight = null; },
  _load: load,
  PERSIST_FILE,
};
