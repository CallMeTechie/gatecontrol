'use strict';

// TLS guard (docs/feature-tls-guard.md): DNS/CAA preflight before a public
// hostname enters ACME automation, per-host certificate status fed by Caddy's
// tls.log and the certificate storage, and an attempt cap that pauses a host
// before Let's Encrypt locks the account for it.
//
//   preflight(host)        pure check, no side effect
//   guardHost(host)        preflight + recordPreflight — called by the write
//                          paths BEFORE their Caddy sync (never inside a
//                          transaction: the DNS lookups happen first, then the
//                          DB write)
//   pauseHost / retryHost  state changes with their own withCaddySync
//   startWatcher / inventory / listStatus / statusFor / pausedHosts

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const logger = require('../utils/logger');
const settings = require('./settings');
const domains = require('./domains');
const eventBus = require('./eventBus');
const { withCaddySync } = require('./routesSync');
const { isPublicDomain } = require('./caddyTlsAutomation');

const WATCH_INTERVAL_MS = 5000;
const INVENTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_ERROR_LEN = 2000;
const EXPIRING_DAYS = 14;
const DEFAULT_MAX_ATTEMPTS = 3;
const WATCH_STATE_KEY = 'tls.watch_state';

let _enabledForTest = null; // null = automatic (test env without an injected resolver → preflight skipped)

function _setEnabledForTest(v) { if (process.env.NODE_ENV === 'test') _enabledForTest = v; }

function syncToCaddy() { return require('./caddyConfig').syncToCaddy(); }
function nowIso() { return new Date().toISOString(); }
function normHost(h) { return String(h || '').trim().toLowerCase().replace(/\.$/, ''); }
function publish(host, row) {
  try {
    eventBus.publish('tls', {
      host,
      state: row ? row.state : 'pending',
      paused_reason: row ? row.paused_reason || null : null,
      last_error_code: row ? row.last_error_code || null : null,
    });
  } catch { /* best-effort */ }
}
function activityLog(type, message, severity, details) {
  try { require('./activity').log(type, message, { source: 'system', severity, details }); }
  catch { /* best-effort */ }
}

// ─── Settings ───────────────────────────────────────────

function maxAttempts() {
  const n = parseInt(settings.get('tls.max_attempts', String(DEFAULT_MAX_ATTEMPTS)), 10);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(n, 10);
}

function setMaxAttempts(value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10 || String(value).trim() !== String(n)) {
    const err = new Error('max_attempts must be an integer between 0 and 10');
    err.statusCode = 400;
    throw err;
  }
  settings.set('tls.max_attempts', String(n));
  return n;
}

// ─── Preflight ──────────────────────────────────────────

// Hostnames of the CAs that may issue for us: letsencrypt.org, plus the host of
// a configured ACME directory (GC_CADDY_ACME_CA).
function allowedCaaIssuers() {
  const out = new Set(['letsencrypt.org']);
  try {
    const ca = String((config.caddy && config.caddy.acmeCa) || '').trim();
    if (ca) out.add(new URL(ca).hostname.toLowerCase());
  } catch { /* not a URL */ }
  return out;
}

function caaPermits(value, allowed) {
  const v = String(value || '').split(';')[0].trim().toLowerCase();
  if (!v) return false; // "issue ;" = nobody may issue
  for (const a of allowed) {
    if (v === a || a.endsWith('.' + v) || v.endsWith('.' + a)) return true;
  }
  return false;
}

// RFC 8659: the CAA set of a name is its own set, else the set of the closest
// parent that has one. We stop at the two-label base domain.
async function effectiveCaa(host) {
  const labels = host.split('.').filter(Boolean);
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    const set = await domains.resolveCaa(name);
    if (set === null) continue; // resolver error at this level: keep walking
    if (set.length > 0) return set;
  }
  return [];
}

/**
 * The preflight rules, shared with domains.verify() (which passes
 * skipPublicCheck so private TLDs are checked like any other name).
 */
async function evaluatePreflight(hostIn, { skipPublicCheck = false } = {}) {
  const host = normHost(hostIn);
  const result = {
    ok: false, code: 'other', detail: null,
    records: { a: [], aaaa: [], caa: [] },
    server: { v4: null, v6: null },
    checked_at: nowIso(),
  };
  const done = (code, detail = null, ok = false) => Object.assign(result, { ok, code, detail });

  if (!skipPublicCheck && !isPublicDomain(host)) return done('not_public', null, true);

  const ips = await domains.getServerPublicIps();
  result.server = { v4: ips.v4 || null, v6: ips.v6 || null };
  if (!ips.v4) return done('server_ip_unknown', 'no public IPv4 address of this server is known');

  let resolved;
  try { resolved = await domains.resolveHost(host); }
  catch { return done('resolver_unreachable', 'DNS resolver did not answer'); }
  result.records.a = resolved.v4 || [];
  result.records.aaaa = resolved.v6 || [];
  if (result.records.a.length === 0 && result.records.aaaa.length === 0) return done('no_records', 'no A or AAAA record');

  const want4 = domains.canonIp(ips.v4);
  const badA = result.records.a.find(a => domains.canonIp(a) !== want4);
  if (badA) return done('a_mismatch', `A ${badA} ≠ ${ips.v4}`);

  if (result.records.aaaa.length > 0) {
    if (!ips.v6) return done('aaaa_without_ipv6', `AAAA ${result.records.aaaa[0]} but this server has no IPv6 address`);
    const want6 = domains.canonIp(ips.v6);
    const bad6 = result.records.aaaa.find(a => domains.canonIp(a) !== want6);
    if (bad6) return done('aaaa_mismatch', `AAAA ${bad6} ≠ ${ips.v6}`);
  }

  let caa = [];
  try { caa = await effectiveCaa(host); } catch { caa = []; }
  result.records.caa = caa;
  const issue = caa.filter(r => r.tag === 'issue' || r.tag === 'issuewild');
  if (issue.length > 0) {
    const allowed = allowedCaaIssuers();
    if (!issue.some(r => caaPermits(r.value, allowed))) {
      return done('caa_blocks', `CAA ${issue.map(r => `${r.tag} "${r.value}"`).join(', ')} does not allow ${[...allowed][0]}`);
    }
  }
  return done('ok', null, true);
}

// In the test environment without an injected resolver the preflight would
// hit real public DNS for every route a test creates — skipped unless a test
// injects a resolver (domains._setResolverForTest) or enables it explicitly.
function preflightActive() {
  if (process.env.NODE_ENV !== 'test') return true;
  if (_enabledForTest !== null) return _enabledForTest;
  return domains._isResolverInjected();
}

/** DNS/CAA preflight of one hostname; no side effect. */
async function preflight(hostIn) {
  const host = normHost(hostIn);
  if (!isPublicDomain(host)) {
    return {
      ok: true, code: 'not_public', detail: null,
      records: { a: [], aaaa: [], caa: [] }, server: { v4: null, v6: null }, checked_at: nowIso(),
    };
  }
  if (!preflightActive()) {
    return {
      ok: true, code: 'ok', detail: 'skipped (test environment without resolver)',
      records: { a: [], aaaa: [], caa: [] }, server: { v4: null, v6: null }, checked_at: nowIso(),
    };
  }
  return evaluatePreflight(host);
}

// ─── Status rows ────────────────────────────────────────

const COLS = ['state', 'attempts', 'last_error', 'last_error_code', 'last_attempt_at', 'next_retry_at',
  'paused_at', 'paused_reason', 'preflight_json', 'not_after', 'issuer'];

function getRow(host) {
  return getDb().prepare('SELECT * FROM tls_status WHERE host = ?').get(normHost(host)) || null;
}

/** Upsert a status row; only the given columns change. Returns the row. */
function writeRow(host, patch) {
  const db = getDb();
  const h = normHost(host);
  const keys = Object.keys(patch).filter(k => COLS.includes(k));
  db.prepare("INSERT OR IGNORE INTO tls_status (host, state) VALUES (?, 'pending')").run(h);
  if (keys.length > 0) {
    db.prepare(`UPDATE tls_status SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE host = @host`)
      .run({ ...Object.fromEntries(keys.map(k => [k, patch[k] === undefined ? null : patch[k]])), host: h });
  }
  return getRow(h);
}

/** Restore a snapshot (null = no row existed). Used by the sync rollbacks. */
function restoreRow(host, snapshot) {
  const db = getDb();
  const h = normHost(host);
  if (!snapshot) { db.prepare('DELETE FROM tls_status WHERE host = ?').run(h); return; }
  const patch = Object.fromEntries(COLS.map(k => [k, snapshot[k] === undefined ? null : snapshot[k]]));
  db.prepare("INSERT OR IGNORE INTO tls_status (host, state) VALUES (?, 'pending')").run(h);
  db.prepare(`UPDATE tls_status SET ${COLS.map(k => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE host = @host`)
    .run({ ...patch, updated_at: snapshot.updated_at || nowIso(), host: h });
}

/** Hosts currently paused — the extra automatic_https.skip entries (one query). */
function pausedHosts() {
  try {
    return getDb().prepare("SELECT host FROM tls_status WHERE state = 'paused' ORDER BY host").all().map(r => r.host);
  } catch (err) {
    logger.warn({ err: err.message }, 'tls: pausedHosts query failed');
    return [];
  }
}

// Set the paused state (DB + activity + event) WITHOUT a Caddy sync — the
// caller either runs its own sync (write paths via guardHost) or wraps it
// (pauseHost).
function setPaused(host, reason, { code, detail, preflightJson } = {}) {
  const before = getRow(host);
  const patch = { state: 'paused', paused_at: nowIso(), paused_reason: reason };
  if (code !== undefined) patch.last_error_code = code;
  if (detail !== undefined && reason === 'preflight') patch.last_error = detail;
  if (preflightJson !== undefined) patch.preflight_json = preflightJson;
  const row = writeRow(host, patch);
  const changed = !before || before.state !== 'paused' || before.paused_reason !== reason || (code !== undefined && before.last_error_code !== code);
  if (changed) {
    const why = reason === 'preflight'
      ? `preflight failed (${code || 'unknown'}${detail ? ': ' + detail : ''})`
      : `${row.attempts} failed certificate attempts (limit ${maxAttempts()})`;
    activityLog('tls_paused', `Certificate requests for ${normHost(host)} paused: ${why}`, 'warning',
      { host: normHost(host), reason, code: row.last_error_code, detail: detail || null });
    publish(normHost(host), row);
  }
  return { row, before };
}

/**
 * Store a preflight result. A failed check of a public host pauses it
 * (paused_reason 'preflight'); a passed check releases a host that was paused
 * for a preflight reason (its DNS is fine again).
 */
function recordPreflight(hostIn, result) {
  const host = normHost(hostIn);
  const json = JSON.stringify(result);
  if (result.code === 'not_public') {
    const before = getRow(host);
    const patch = { preflight_json: json };
    if (!before || before.state === 'pending') patch.state = 'internal';
    return writeRow(host, patch);
  }
  if (!result.ok) {
    return setPaused(host, 'preflight', { code: 'preflight:' + result.code, detail: result.detail, preflightJson: json }).row;
  }
  const before = getRow(host);
  const patch = { preflight_json: json };
  if (before && before.state === 'paused' && before.paused_reason === 'preflight') {
    Object.assign(patch, { state: 'pending', attempts: 0, last_error: null, last_error_code: null, next_retry_at: null, paused_at: null, paused_reason: null });
  } else if (before && before.state === 'internal') {
    patch.state = 'pending';
  }
  const row = writeRow(host, patch);
  if (before && before.state !== row.state) publish(host, row);
  return row;
}

/**
 * Preflight + recordPreflight for a hostname that is about to get HTTPS.
 * Never throws; returns { state, code, detail, preflight }.
 */
async function guardHost(hostIn) {
  const host = normHost(hostIn);
  try {
    const result = await preflight(host);
    const row = recordPreflight(host, result);
    return { state: row ? row.state : 'pending', code: result.code, detail: result.detail, preflight: result };
  } catch (err) {
    logger.warn({ err: err.message, host }, 'tls: guardHost failed');
    return { state: 'pending', code: 'other', detail: err.message, preflight: null };
  }
}

/** Pause a host (attempt cap) and push the new skip list to Caddy. */
async function pauseHost(hostIn, reason = 'attempts') {
  const host = normHost(hostIn);
  const { row, before } = setPaused(host, reason);
  await withCaddySync(syncToCaddy, () => { restoreRow(host, before); publish(host, before); }, 'tls pause');
  return row;
}

/**
 * Manual retry: preflight first; on failure the host stays paused and an error
 * with code PREFLIGHT_FAILED (statusCode 409, .result) is thrown. On success
 * the counters reset, the host leaves the skip list and Caddy is synced.
 */
async function retryHost(hostIn) {
  const host = normHost(hostIn);
  const result = await preflight(host);
  if (!result.ok) {
    recordPreflight(host, result);
    const err = new Error('Preflight failed: ' + result.code + (result.detail ? ' (' + result.detail + ')' : ''));
    err.code = 'PREFLIGHT_FAILED';
    err.statusCode = 409;
    err.result = result;
    throw err;
  }
  const before = getRow(host);
  const row = writeRow(host, {
    state: result.code === 'not_public' ? 'internal' : 'pending',
    attempts: 0, last_error: null, last_error_code: null, next_retry_at: null,
    paused_at: null, paused_reason: null, preflight_json: JSON.stringify(result),
  });
  await withCaddySync(syncToCaddy, () => restoreRow(host, before), 'tls retry');
  activityLog('tls_retry', `Certificate request for ${host} re-enabled`, 'info', { host });
  publish(host, row);
  return statusFor([host])[0];
}

// ─── Caddy tls.log ──────────────────────────────────────

function classifyError(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return 'other';
  if (/too many|ratelimited|rate ?limit/.test(s)) return 'rate_limited';
  if (/\bcaa\b/.test(s)) return 'caa';
  if (/account|contact|e-?mail/.test(s)) return 'account';
  if (/no valid a records|no valid aaaa|connection refused|timeout|timed out|dns problem|nxdomain|no such host|invalid response|could not connect|unreachable|network is/.test(s)) return 'dns';
  return 'other';
}

// zap encodes durations as seconds in Caddy's JSON logs; tolerate Go strings.
function parseDurationSeconds(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0; let matched = false;
  const re = /(\d+(?:\.\d+)?)(h|m|s|ms)/g;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : m[2] === 'ms' ? n / 1000 : n;
  }
  return matched ? total : null;
}

function tsToIso(ts) {
  if (typeof ts === 'number' && ts > 1e9) return new Date(ts * 1000).toISOString();
  if (typeof ts === 'string') { const d = new Date(ts); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return nowIso();
}

function extractError(obj) {
  const e = obj.error !== undefined ? obj.error : (obj.err !== undefined ? obj.err : obj.problem);
  if (e == null) return null;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function extractHost(obj) {
  const cand = obj.identifier || obj.name || obj.domain || obj.host
    || (Array.isArray(obj.identifiers) ? obj.identifiers[0] : null)
    || (Array.isArray(obj.names) ? obj.names[0] : null);
  if (!cand) return null;
  const h = typeof cand === 'object' ? (cand.value || cand.name) : cand;
  return h ? normHost(h) : null;
}

/**
 * One JSON line of Caddy's tls.log → { kind: 'error'|'success', host, error,
 * attempt, retrying_in, max_duration, at, logger, msg } or null (irrelevant).
 */
function parseTlsLogLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const msg = String(obj.msg || '').toLowerCase();
  const host = extractHost(obj);
  if (!host) return null;
  const base = { host, at: tsToIso(obj.ts), logger: obj.logger || null, msg: obj.msg || '' };
  if (/certificate obtained successfully|certificate renewed successfully|certificate renewed/.test(msg)) {
    return { kind: 'success', ...base };
  }
  if (/could not get certificate|will retry/.test(msg)) {
    const attempt = Number.isFinite(Number(obj.attempt)) && obj.attempt !== null && obj.attempt !== undefined ? Number(obj.attempt) : null;
    return {
      kind: 'error', ...base,
      error: extractError(obj),
      attempt,
      retrying_in: parseDurationSeconds(obj.retrying_in),
      max_duration: parseDurationSeconds(obj.max_duration),
    };
  }
  return null;
}

/** Apply one parsed log event to tls_status. Returns the row or null. */
async function applyLogEvent(evt) {
  if (!evt) return null;
  const host = evt.host;
  if (evt.kind === 'success') {
    const before = getRow(host);
    const row = writeRow(host, {
      state: 'issued', attempts: 0, last_error: null, last_error_code: null, next_retry_at: null,
      last_attempt_at: evt.at,
    });
    if (before && before.state === 'paused') {
      // Caddy got the certificate anyway (sync raced) — the pause is moot.
      writeRow(host, { paused_at: null, paused_reason: null });
    }
    try { inventoryHost(host); } catch (err) { logger.warn({ err: err.message, host }, 'tls: inventory after success failed'); }
    publish(host, getRow(host));
    return getRow(host);
  }
  const before = getRow(host);
  const attempts = evt.attempt != null ? evt.attempt : ((before ? before.attempts : 0) + 1);
  const patch = {
    attempts,
    last_attempt_at: evt.at,
  };
  if (evt.error) {
    patch.last_error = String(evt.error).slice(0, MAX_ERROR_LEN);
    patch.last_error_code = classifyError(evt.error);
  }
  if (evt.retrying_in != null) {
    patch.next_retry_at = new Date(new Date(evt.at).getTime() + evt.retrying_in * 1000).toISOString();
  }
  const paused = before && before.state === 'paused';
  if (!paused) patch.state = 'failed';
  let row = writeRow(host, patch);
  const limit = maxAttempts();
  if (!paused && limit > 0 && row.attempts >= limit) {
    try { row = await pauseHost(host, 'attempts'); }
    catch (err) { logger.warn({ err: err.message, host }, 'tls: pausing host after attempt cap failed'); row = getRow(host); }
  } else if (!paused) {
    publish(host, row);
  }
  return row;
}

// Watcher state — persisted so a restart neither replays the whole file nor
// misses lines written while GateControl was down. `head` fingerprints the
// first bytes: a rotated file that reuses the inode and happens to have the
// same size is still recognised as new.
const HEAD_LEN = 64;
const _watch = { timer: null, file: null, ino: null, offset: 0, head: '', partial: '', busy: false };

function loadWatchState() {
  try {
    const raw = settings.get(WATCH_STATE_KEY, '');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && s.file === _watch.file) { _watch.ino = s.ino ?? null; _watch.offset = Number(s.offset) || 0; _watch.head = s.head || ''; }
  } catch { /* fresh start */ }
}
function saveWatchState() {
  try { settings.set(WATCH_STATE_KEY, JSON.stringify({ file: _watch.file, ino: _watch.ino, offset: _watch.offset, head: _watch.head })); }
  catch { /* best-effort */ }
}
function readHead(fd, size) {
  const len = Math.min(HEAD_LEN, size);
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, 0);
  return buf.subarray(0, n).toString('latin1');
}

function tlsLogPath(dataDir) {
  return path.join(dataDir || config.caddy.dataDir || '/data/caddy', 'tls.log');
}

/** Read new lines since the last offset and apply them. Tolerates a missing file and rotation. */
async function pollOnce() {
  if (_watch.busy) return 0;
  _watch.busy = true;
  try {
    let st;
    try { st = fs.statSync(_watch.file); }
    catch { _watch.ino = null; _watch.offset = 0; _watch.head = ''; _watch.partial = ''; return 0; }
    let fd;
    try { fd = fs.openSync(_watch.file, 'r'); }
    catch { return 0; }
    let chunk;
    try {
      const head = readHead(fd, st.size);
      const known = _watch.head.length > 0 ? head.slice(0, _watch.head.length) : '';
      const rotated = _watch.ino !== null && (st.ino !== _watch.ino || st.size < _watch.offset || (known && known !== _watch.head));
      if (rotated) { _watch.offset = 0; _watch.partial = ''; }   // rotated or truncated → from the top
      _watch.ino = st.ino;
      if (_watch.offset === 0) _watch.head = head;
      if (st.size === _watch.offset) return 0;
      const len = st.size - _watch.offset;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, _watch.offset);
      chunk = buf.subarray(0, n).toString('utf8');
      _watch.offset += n;
      if (_watch.head.length < HEAD_LEN) _watch.head = readHead(fd, st.size);
    } finally { fs.closeSync(fd); }
    const text = _watch.partial + chunk;
    const lines = text.split('\n');
    _watch.partial = lines.pop() || '';
    let applied = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const evt = parseTlsLogLine(t);
        if (evt) { await applyLogEvent(evt); applied++; }
      } catch (err) {
        logger.warn({ err: err.message }, 'tls: log line failed');
      }
    }
    saveWatchState();
    return applied;
  } finally {
    _watch.busy = false;
  }
}

function startWatcher({ file, intervalMs = WATCH_INTERVAL_MS, immediate = true } = {}) {
  if (_watch.timer) return;
  _watch.file = file || tlsLogPath();
  _watch.ino = null; _watch.offset = 0; _watch.partial = '';
  loadWatchState();
  const tick = () => pollOnce().catch(err => logger.warn({ err: err.message }, 'tls: watcher tick failed'));
  _watch.timer = setInterval(tick, intervalMs);
  if (_watch.timer.unref) _watch.timer.unref();
  if (immediate) tick();
  logger.info({ file: _watch.file }, 'TLS log watcher started');
}

function stopWatcher() {
  if (_watch.timer) { clearInterval(_watch.timer); _watch.timer = null; }
}

// ─── Certificate inventory ──────────────────────────────

function issuerName(cert) {
  const fields = {};
  for (const line of String(cert.issuer || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields.O || fields.CN || fields.OU || null;
}

function dirToHost(name) {
  return normHost(name.replace(/^wildcard_\./, '*.'));
}

function certDirs(dataDir) {
  const base = dataDir || config.caddy.dataDir || '/data/caddy';
  return [path.join(base, 'caddy', 'certificates'), path.join(base, 'certificates')];
}

/**
 * Scan Caddy's certificate storage → Map<host, { host, ca, issuer, not_before, not_after, file }>.
 * With several certificates per host the one valid longest wins.
 */
function scanCertificates(dataDir, onlyHost = null) {
  const found = new Map();
  for (const root of certDirs(dataDir)) {
    let cas;
    try { cas = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const ca of cas) {
      if (!ca.isDirectory()) continue;
      const caDir = path.join(root, ca.name);
      let hosts;
      try { hosts = fs.readdirSync(caDir, { withFileTypes: true }); } catch { continue; }
      for (const h of hosts) {
        if (!h.isDirectory()) continue;
        const host = dirToHost(h.name);
        if (onlyHost && host !== onlyHost) continue;
        const file = path.join(caDir, h.name, h.name + '.crt');
        let cert;
        try { cert = new crypto.X509Certificate(fs.readFileSync(file)); }
        catch { continue; }
        const entry = {
          host, ca: ca.name, issuer: issuerName(cert),
          not_before: new Date(cert.validFrom).toISOString(),
          not_after: new Date(cert.validTo).toISOString(),
          file,
        };
        const prev = found.get(host);
        if (!prev || prev.not_after < entry.not_after) found.set(host, entry);
      }
    }
  }
  return found;
}

function applyInventoryEntry(entry) {
  const before = getRow(entry.host);
  const patch = { not_after: entry.not_after, issuer: entry.issuer };
  const errorNewer = before && (
    (before.last_attempt_at && before.last_attempt_at > entry.not_before)
    || (before.paused_reason === 'preflight' && before.paused_at && before.paused_at > entry.not_before)
  );
  const internal = /^local$/i.test(entry.ca);
  if (!errorNewer) {
    patch.state = internal ? 'internal' : 'issued';
    patch.attempts = 0;
    patch.last_error = null; patch.last_error_code = null; patch.next_retry_at = null;
    patch.paused_at = null; patch.paused_reason = null;
  }
  const row = writeRow(entry.host, patch);
  const released = before && before.state === 'paused' && row.state !== 'paused';
  if (!before || before.state !== row.state) publish(entry.host, row);
  return released;
}

/** Inventory of every certificate in storage. Returns { hosts, released }. */
function inventory({ dataDir } = {}) {
  const certs = scanCertificates(dataDir);
  let released = 0;
  for (const entry of certs.values()) {
    try { if (applyInventoryEntry(entry)) released++; }
    catch (err) { logger.warn({ err: err.message, host: entry.host }, 'tls: inventory write failed'); }
  }
  if (released > 0) {
    // A paused host turned out to hold a newer certificate — let it leave the skip list.
    syncToCaddy().catch(err => logger.warn({ err: err.message }, 'tls: sync after inventory failed'));
  }
  return { hosts: certs.size, released, entries: [...certs.values()] };
}

function inventoryHost(host, { dataDir } = {}) {
  const certs = scanCertificates(dataDir, normHost(host));
  const entry = certs.get(normHost(host));
  if (entry) applyInventoryEntry(entry);
  return entry || null;
}

let _inventoryTimer = null;
function startInventory({ dataDir, intervalMs = INVENTORY_INTERVAL_MS } = {}) {
  const run = () => {
    try {
      const r = inventory({ dataDir });
      logger.info({ hosts: r.hosts, released: r.released }, 'TLS certificate inventory done');
    } catch (err) { logger.warn({ err: err.message }, 'TLS certificate inventory failed'); }
  };
  run();
  if (!_inventoryTimer) {
    _inventoryTimer = setInterval(run, intervalMs);
    if (_inventoryTimer.unref) _inventoryTimer.unref();
  }
}
function stopInventory() {
  if (_inventoryTimer) { clearInterval(_inventoryTimer); _inventoryTimer = null; }
}

// ─── Status view ────────────────────────────────────────

function acmeEmailMissing() {
  try { return !require('./caddyConfig').effectiveAcmeEmail(); } catch { return true; }
}

function daysLeft(notAfter) {
  if (!notAfter) return null;
  const t = new Date(notAfter).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

/** Certificate kind of ONE route row: 'acme' | 'internal' | 'none'. */
function kindOfRoute(r, { forcedInternal = new Set() } = {}) {
  if (!r || !r.domain) return 'none';
  const tls = r.route_type === 'l4' ? (!!r.l4_tls_mode && r.l4_tls_mode !== 'none') : !!r.https_enabled;
  if (!tls) return 'none';
  const host = normHost(r.domain);
  return isPublicDomain(host) && !forcedInternal.has(host) ? 'acme' : 'internal';
}

function combineKinds(kinds) {
  if (kinds.includes('acme')) return 'acme';
  if (kinds.includes('internal')) return 'internal';
  return 'none';
}

/** Effective state of a host given its status row and kind. */
function deriveState(row, kind) {
  if (kind === 'none') return 'none';
  if (kind === 'internal') return 'internal';
  if (!row) return 'pending';
  if (row.state === 'internal') return 'pending';
  return row.state || 'pending';
}

function parseJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

function toTlsHost(host, meta, row, kind, limit) {
  const state = deriveState(row, kind);
  const r = row || {};
  return {
    host,
    route_id: meta.route_id ?? null,
    host_id: meta.host_id ?? null,
    domain_id: meta.domain_id ?? null,
    kind,
    state,
    attempts: Number(r.attempts) || 0,
    max_attempts: limit,
    last_error: r.last_error || null,
    last_error_code: r.last_error_code || null,
    last_attempt_at: r.last_attempt_at || null,
    next_retry_at: r.next_retry_at || null,
    paused_at: r.paused_at || null,
    paused_reason: r.paused_reason || null,
    preflight: parseJson(r.preflight_json),
    not_after: r.not_after || null,
    days_left: daysLeft(r.not_after),
    issuer: r.issuer || null,
  };
}

// The host universe: one query over routes + hosts, plus the management and
// (public) portal hosts, which get certificates without being routes.
function loadUniverse() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT r.id, r.domain, r.route_type, r.https_enabled, r.l4_tls_mode, r.enabled, r.bundle_id, sb.domain_id
    FROM routes r LEFT JOIN service_bundles sb ON sb.id = r.bundle_id
    WHERE r.domain IS NOT NULL AND r.domain != ''
    ORDER BY (CASE WHEN r.route_type = 'l4' THEN 1 ELSE 0 END), r.id`).all();
  let portal = { host: null, public: false };
  try { portal = require('./portalConfig').effectivePortalHost(); } catch { /* ignore */ }
  const forcedInternal = new Set(portal.host && !portal.public ? [normHost(portal.host)] : []);
  const map = new Map();
  for (const r of rows) {
    const host = normHost(r.domain);
    const kind = r.enabled ? kindOfRoute(r, { forcedInternal }) : 'none';
    const cur = map.get(host) || { kinds: [], route_id: null, host_id: null, domain_id: null };
    cur.kinds.push(kind);
    if (cur.route_id == null) cur.route_id = r.id;
    if (cur.host_id == null && r.bundle_id != null) cur.host_id = r.bundle_id;
    if (cur.domain_id == null && r.domain_id != null) cur.domain_id = r.domain_id;
    map.set(host, cur);
  }
  const extra = [];
  try { extra.push(new URL(config.app.baseUrl || '').hostname); } catch { /* unset */ }
  if (portal.public && portal.host) extra.push(portal.host);
  for (const h of extra.map(normHost).filter(Boolean)) {
    if (!isPublicDomain(h) || map.has(h)) continue;
    map.set(h, { kinds: ['acme'], route_id: null, host_id: null, domain_id: null });
  }
  return map;
}

function loadRows() {
  return new Map(getDb().prepare('SELECT * FROM tls_status').all().map(r => [r.host, r]));
}

/** TlsHost[] for the given hostnames (unknown names → kind 'none'). */
function statusFor(hosts) {
  const universe = loadUniverse();
  const rows = loadRows();
  const limit = maxAttempts();
  return hosts.map(normHost).map(h => {
    const meta = universe.get(h) || { kinds: [], route_id: null, host_id: null, domain_id: null };
    return toTlsHost(h, meta, rows.get(h) || null, combineKinds(meta.kinds), limit);
  });
}

/** { hosts: TlsHost[], summary, settings } — one query on tls_status, one on routes/hosts. */
function listStatus() {
  const universe = loadUniverse();
  const rows = loadRows();
  const limit = maxAttempts();
  const hosts = [...universe.entries()]
    .map(([h, meta]) => toTlsHost(h, meta, rows.get(h) || null, combineKinds(meta.kinds), limit))
    .sort((a, b) => a.host.localeCompare(b.host));
  const summary = {
    total: hosts.length,
    issued: hosts.filter(h => h.state === 'issued').length,
    expiring: hosts.filter(h => h.state === 'issued' && h.days_left != null && h.days_left < EXPIRING_DAYS).length,
    failed: hosts.filter(h => h.state === 'failed').length,
    paused: hosts.filter(h => h.state === 'paused').length,
    pending: hosts.filter(h => h.state === 'pending').length,
    acme_email_missing: acmeEmailMissing(),
  };
  return { hosts, summary, settings: { max_attempts: limit } };
}

/**
 * Compact per-entry view for GET /zones: { state, last_error_code, not_after, days_left }.
 * `rows` is the tls_status map (loadRows()) so the zones page needs one query.
 */
function entryTls(routeRow, rows, opts) {
  const kind = routeRow.enabled ? kindOfRoute(routeRow, opts) : 'none';
  const row = routeRow.domain ? rows.get(normHost(routeRow.domain)) || null : null;
  return {
    state: deriveState(row, kind),
    last_error_code: row ? row.last_error_code || null : null,
    not_after: row ? row.not_after || null : null,
    days_left: row ? daysLeft(row.not_after) : null,
  };
}

// ─── Lifecycle ──────────────────────────────────────────

function start({ watcher = true } = {}) {
  if (acmeEmailMissing()) {
    logger.warn('No ACME contact e-mail configured (caddy.acme_email / GC_CADDY_EMAIL) — Let\'s Encrypt cannot send expiry notices');
  }
  if (watcher) {
    try { startWatcher(); } catch (err) { logger.warn({ err: err.message }, 'TLS log watcher not started'); }
  }
}

function stop() {
  stopWatcher();
  stopInventory();
}

module.exports = {
  preflight, evaluatePreflight, recordPreflight, guardHost,
  pauseHost, retryHost, pausedHosts,
  startWatcher, stopWatcher, pollOnce, parseTlsLogLine, classifyError, parseDurationSeconds, applyLogEvent,
  inventory, inventoryHost, scanCertificates, startInventory, stopInventory,
  statusFor, listStatus, entryTls, kindOfRoute, deriveState, loadRows,
  maxAttempts, setMaxAttempts, acmeEmailMissing,
  start, stop,
  getRow, writeRow,
  _setEnabledForTest,
};
