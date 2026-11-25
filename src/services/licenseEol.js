'use strict';

// End of life of GateControl (docs/feature-license-eol.md).
//
// When the vendor stops the product, it publishes ONE signed file, eol.json.
// It carries no install, key or fingerprint — it says "this product is
// discontinued" for everybody, and is signed with a key of the licence
// server's JWKS (the same keys as the licence tokens, services/licenseV2.js
// verifyJws). A file that does not verify against those keys is never
// accepted; nothing here can be built without the vendor's private key.
//
// What an accepted file changes is decided in services/license.js:
//   scope "lifetime"  licences without an end (token lat = 0) — the server
//                     licence and plugins — stay valid without the licence
//                     server, for good
//   scope "all"       in addition, every other licence runs until its own
//                     paid end (lat) without the licence server
//
// Sources, first match wins:
//   1. the file at config.license.eolFile (GC_LICENSE_EOL_FILE, default
//      /data/eol.json) — read at start
//   2. a file imported in Einstellungen → Lizenz, or fetched automatically
//      (stored in settings `license.eol`, verified again at every start)
// Fetched from config.license.eolUrl (GC_LICENSE_EOL_URL, comma separated)
// at most every FETCH_GAP_MS (with the daily licence check) while a licence
// key is configured and no EOL is in force; 404 = none published. The
// request carries nothing about the install.
//
// The format (wrapper JSON or the bare token; website docs/api/eol-format.md):
//   { "format": "gatecontrol-eol", "v": 1, "product": "gatecontrol", "token": "<JWS EdDSA>" }
//   token header  { "alg": "EdDSA", "kid": "<kid of the JWKS>", "typ": "gc-eol+jwt" }
//   token payload { "iss": "callmetechie.de", "typ": "eol" (or "kind": "eol"), "v": 1,
//                   "kid": "<= header kid>" (optional), "jti": "…" (ignored),
//                   "product": "gatecontrol", "scope": "lifetime"|"all",
//                   "iat": <unix seconds>,
//                   "message": "…" | { "de": "…", "en": "…" } (optional) }
// Only the token counts; the wrapper's other fields are informational.

const fs = require('fs');
const config = require('../../config/default');
const logger = require('../utils/logger');
const v2 = require('./licenseV2');

const PRODUCT = 'gatecontrol';
const KIND = 'eol';
const VERSION = 1;
const SCOPES = new Set(['lifetime', 'all']);
const MAX_FILE_BYTES = 32 * 1024;
const MAX_MESSAGE = 1000;
const FUTURE_SKEW_S = 24 * 60 * 60;          // a clock a day off still accepts it
const FETCH_GAP_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const SETTING = 'license.eol';

let current = null;   // { issued_at, scope, message, kid, source, imported_at } of the verified file
let lastFetch = 0;

function settings() { return require('./settings'); }

/** The JWS of a file: the wrapper's `token`, or the bare token. */
function extractToken(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return null;
  const s = text.replace(/^﻿/, '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    let j;
    try { j = JSON.parse(s); } catch { return null; }
    return j && typeof j === 'object' && !Array.isArray(j) && typeof j.token === 'string' ? j.token.trim() : null;
  }
  return s;
}

function cleanText(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return s && s.length <= MAX_MESSAGE ? s : null;
}

/** { de, en } of the message claim — a plain string serves both; undefined → null. */
function messageOf(m) {
  if (m === undefined || m === null) return { ok: true, value: null };
  if (typeof m === 'string') {
    const s = cleanText(m);
    return s ? { ok: true, value: { de: s, en: s } } : { ok: false };
  }
  if (typeof m !== 'object' || Array.isArray(m)) return { ok: false };
  const de = m.de === undefined ? null : cleanText(m.de);
  const en = m.en === undefined ? null : cleanText(m.en);
  if ((m.de !== undefined && !de) || (m.en !== undefined && !en) || (!de && !en)) return { ok: false };
  return { ok: true, value: { de: de || en, en: en || de } };
}

/**
 * Verify an EOL file.
 * @param {string} text  content of eol.json (wrapper JSON or bare token)
 * @returns {Promise<{ok:true, token:string, eol:{issued_at:string, scope:string, message:object|null, kid:string}}|{ok:false, reason:string}>}
 */
async function verify(text) {
  const token = extractToken(text);
  if (!token) return { ok: false, reason: 'malformed' };
  const v = await v2.verifyJws(token, { maxLength: MAX_FILE_BYTES });
  if (!v.ok) return { ok: false, reason: v.reason };
  const p = v.payload;
  if (p.iss !== v2.ISSUER) return { ok: false, reason: 'iss' };
  // `kind: "eol"` or — the website's format — `typ: "eol"` without a kind; never an app/plugin token
  if (!(p.kind === KIND || (p.kind === undefined && p.typ === KIND))) return { ok: false, reason: 'kind' };
  if (v.header.typ !== undefined && v.header.typ !== 'JWT' && v.header.typ !== 'gc-eol+jwt') return { ok: false, reason: 'typ' };
  if (p.kid !== undefined && p.kid !== v.header.kid) return { ok: false, reason: 'kid' };
  if (p.v !== VERSION) return { ok: false, reason: 'version' };
  if (p.product !== PRODUCT) return { ok: false, reason: 'product' };
  if (!SCOPES.has(p.scope)) return { ok: false, reason: 'scope' };
  if (!Number.isSafeInteger(p.iat) || p.iat <= 0 || p.iat > Math.floor(Date.now() / 1000) + FUTURE_SKEW_S) {
    return { ok: false, reason: 'iat' };
  }
  const msg = messageOf(p.message);
  if (!msg.ok) return { ok: false, reason: 'message' };
  return {
    ok: true,
    token,
    eol: { issued_at: new Date(p.iat * 1000).toISOString(), scope: p.scope, message: msg.value, kid: v.header.kid },
  };
}

/** Content of a regular file of at most MAX_FILE_BYTES — checked and read through one descriptor (no stat/read race). */
function readFileSafe(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return n > MAX_FILE_BYTES ? null : buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function storedRecord() {
  let raw = null;
  try { raw = settings().get(SETTING, null); } catch { return null; }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j && typeof j.token === 'string' ? j : null;
  } catch {
    return null;
  }
}

/**
 * (Re)load the EOL state: the file at config.license.eolFile, else the
 * stored import. Both are verified again — nothing is trusted from storage.
 * @returns {Promise<object|null>} state()
 */
async function load() {
  const prev = current;
  current = null;
  const file = config.license.eolFile;
  const text = file ? readFileSafe(file) : null;
  if (text !== null) {
    const r = await verify(text);
    if (r.ok) current = { ...r.eol, source: 'file', imported_at: null };
    else logger.warn(`EOL file ${file} rejected (${r.reason})`);
  }
  if (!current) {
    const rec = storedRecord();
    if (rec) {
      const r = await verify(rec.token);
      if (r.ok) current = { ...r.eol, source: rec.source === 'fetch' ? 'fetch' : 'upload', imported_at: rec.imported_at || null };
      else logger.warn(`Stored EOL file rejected (${r.reason})`);
    }
  }
  if (current && !prev) logger.warn(`GateControl end of life in force (scope ${current.scope}, issued ${current.issued_at}) — licences without an end need no licence server`);
  return state();
}

/**
 * Import an EOL file (upload or fetch). Stored only when it verifies.
 * @param {string} text
 * @param {'upload'|'fetch'} source
 * @returns {Promise<{ok:true, eol:object}|{ok:false, reason:string}>}
 */
async function importText(text, source = 'upload') {
  const r = await verify(text);
  if (!r.ok) return r;
  const rec = { token: r.token, source: source === 'fetch' ? 'fetch' : 'upload', imported_at: new Date().toISOString() };
  settings().set(SETTING, JSON.stringify(rec));
  await load();
  return { ok: true, eol: state() };
}

/** Remove the imported file (a file at GC_LICENSE_EOL_FILE stays in force). */
async function remove() {
  try { settings().set(SETTING, ''); } catch { /* settings not ready */ }
  lastFetch = Date.now(); // do not fetch it straight back
  return load();
}

/** @returns {{issued_at, scope, message, kid, source, imported_at}|null} */
function state() {
  return current ? { ...current, message: current.message ? { ...current.message } : null } : null;
}

function isActive() { return !!current; }

/**
 * Does the EOL cover a licence token? Licences without an end (lat 0)
 * always; with scope "all" also one whose paid end (lat) is still ahead.
 * @param {object} payload  verified token payload
 */
function covers(payload, nowMs = Date.now()) {
  if (!current || !payload) return false;
  const lat = Number(payload.lat) || 0;
  if (lat <= 0) return true;
  return current.scope === 'all' && lat * 1000 > nowMs;
}

async function readCapped(res) {
  const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(len) && len > MAX_FILE_BYTES) return null;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return Buffer.byteLength(t, 'utf8') > MAX_FILE_BYTES ? null : t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function eolUrls() {
  return String(config.license.eolUrl || '').split(',').map((u) => u.trim()).filter((u) => /^https:\/\//i.test(u));
}

/**
 * Look for a published EOL file. Only with a licence key, only while none is
 * in force, at most every FETCH_GAP_MS (force: a manual licence refresh).
 * @returns {Promise<boolean>} true when an EOL file was newly put in force
 */
async function maybeFetch({ force = false, now = Date.now() } = {}) {
  if (!config.license.key || current) return false;
  if (!force && lastFetch && now - lastFetch < FETCH_GAP_MS) return false;
  lastFetch = now;
  for (const url of eolUrls()) {
    let text = null;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.status !== 200) continue; // 404: none published
      text = await readCapped(res);
    } catch {
      continue;
    }
    if (text === null) continue;
    const r = await importText(text, 'fetch');
    if (r.ok) return true;
    logger.warn(`Published EOL file rejected (${r.reason})`);
  }
  return false;
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  current = null;
  lastFetch = 0;
  try { settings().set(SETTING, ''); } catch { /* settings not ready */ }
}

module.exports = {
  PRODUCT,
  SCOPES,
  MAX_FILE_BYTES,
  FETCH_GAP_MS,
  verify,
  load,
  importText,
  remove,
  state,
  isActive,
  covers,
  maybeFetch,
  _resetForTest,
};
