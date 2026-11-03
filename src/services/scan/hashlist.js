'use strict';

// Local list of known malware by SHA-256 (MalwareBazaar, abuse.ch).
//
// Only checksums travel, and only one way: GateControl downloads the export
// of recent additions (last 48 h, CSV) and keeps the SHA-256 with the
// signature name in scan_hashes; a file is looked up locally by the checksum
// it gets while it is stored. No file and no checksum of a user ever leaves
// the server. abuse.ch hands the data out under its terms of use (fair use,
// free Auth-Key: https://auth.abuse.ch/); without a key the list stays off.
// Entries older than KEEP_DAYS are dropped — the list grows by a few
// thousand checksums a day.

const settings = require('../settings');
const logger = require('../../utils/logger');

const EXPORT_URL = (key) => `https://mb-api.abuse.ch/v2/files/exports/${encodeURIComponent(key)}/recent.csv`;
const MAX_BYTES = 32 * 1024 * 1024;
const KEEP_DAYS = 365;
const MIN_GAP_MS = 3600e3;
const K_STATE = 'scan.hashlist_state';
const K_KEY = 'scan.abusech_key_encrypted';

let _fetch = null;

function db() { return require('../../db/connection').getDb(); }

function getKey() {
  const enc = settings.get(K_KEY, '');
  if (!enc) return '';
  try { return require('../../utils/crypto').decrypt(enc); } catch { return ''; }
}

function setKey(key) {
  if (key == null || key === '') { settings.set(K_KEY, ''); return; }
  const k = String(key).trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(k)) throw Object.assign(new Error('the Auth-Key looks wrong'), { statusCode: 400, code: 'invalid', field: 'abusech_key' });
  settings.set(K_KEY, require('../../utils/crypto').encrypt(k));
}

function state() {
  try { return JSON.parse(settings.get(K_STATE, '{}')) || {}; } catch { return {}; }
}

function setState(patch) { settings.set(K_STATE, JSON.stringify({ ...state(), ...patch })); }

/** Pure: MalwareBazaar CSV → [{ sha256, signature, firstSeen }]. */
function parseCsv(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = [];
    const re = /\s*("(?:[^"]|"")*"|[^,]*)\s*(?:,|$)/g;
    let m;
    while ((m = re.exec(line)) && cols.length < 16) {
      cols.push(m[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim());
      if (m.index + m[0].length >= line.length) break;
    }
    const sha = cols.find((c) => /^[0-9a-f]{64}$/i.test(c));
    if (!sha) continue;
    const sig = (cols[8] && cols[8] !== 'n/a' ? cols[8] : '') || '';
    const t = Date.parse((cols[0] || '').replace(' ', 'T') + 'Z');
    out.push({ sha256: sha.toLowerCase(), signature: sig.slice(0, 120) || null, firstSeen: Number.isFinite(t) ? t : Date.now() });
  }
  return out;
}

async function download(url) {
  const f = _fetch || globalThis.fetch;
  const res = await f(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'GateControl Virenscan' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body || typeof res.body.getReader !== 'function') return String(await res.text()).slice(0, MAX_BYTES);
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('export too large'); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Download the recent additions and merge them. → { ok, added?, total?, error?, skipped? } */
async function refresh({ force = false } = {}) {
  const key = getKey();
  if (!key) return { ok: false, error: 'no_key' };
  const st = state();
  if (!force && st.tried_at && Date.now() - st.tried_at < MIN_GAP_MS) return { ok: true, skipped: true, total: count() };
  setState({ tried_at: Date.now() });
  try {
    const rows = parseCsv(await download(EXPORT_URL(key)));
    if (!rows.length) throw new Error('empty export');
    const ins = db().prepare('INSERT OR IGNORE INTO scan_hashes (sha256, signature, first_seen) VALUES (?, ?, ?)');
    let added = 0;
    db().transaction(() => { for (const r of rows) added += ins.run(r.sha256, r.signature, r.firstSeen).changes; })();
    db().prepare('DELETE FROM scan_hashes WHERE first_seen < ?').run(Date.now() - KEEP_DAYS * 86400e3);
    setState({ updated_at: Date.now(), error: null });
    return { ok: true, added, total: count() };
  } catch (err) {
    const msg = String(err && err.message || err).replace(key, '…').slice(0, 200);
    setState({ error: msg });
    logger.warn({ err: msg }, 'virus scan: malware list not updated');
    return { ok: false, error: msg };
  }
}

function count() {
  try { return db().prepare('SELECT COUNT(*) AS n FROM scan_hashes').get().n; } catch { return 0; }
}

/** → { signature } or null. */
function lookup(sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) return null;
  const r = db().prepare('SELECT signature FROM scan_hashes WHERE sha256 = ?').get(sha256);
  return r ? { signature: r.signature } : null;
}

function info() {
  const st = state();
  return { keySet: !!settings.get(K_KEY, ''), count: count(), updatedAt: st.updated_at ? new Date(st.updated_at).toISOString() : null, error: st.error || null };
}

function _setFetchForTest(f) { _fetch = f; }

module.exports = { parseCsv, refresh, lookup, info, setKey, getKey, count, EXPORT_URL, K_KEY, _setFetchForTest };
