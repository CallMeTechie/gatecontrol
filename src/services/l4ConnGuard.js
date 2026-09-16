'use strict';

// Connection rate per source IP for TCP/UDP entries
// (docs/feature-next-package.md §S1.3).
//
// caddy-l4 cannot rate limit by itself — it has no equivalent of the HTTP
// rate_limit handler. What it does have is a log: every accepted connection
// produces one line on the `layer4` logger at DEBUG level
//
//   {"level":"debug","ts":1789564839.63,"logger":"layer4",
//    "msg":"started handling connection","network":"tcp",
//    "local":"10.0.0.2:2023","remote":"203.0.113.7:42613"}
//
// so the generator points a dedicated Caddy log at a file (logConfig below)
// and this watcher counts those lines per source IP. More than N connections
// within M seconds → the address goes into the existing ban list (waf_bans,
// reason `l4_rate`), which the L4 generator turns into a `close` route.
//
// Deliberate limits:
//   * The log line names the LISTENER (`local` = ip:port), not the entry. A
//     plain port forward is alone on its port (validatePortConflicts), so the
//     attribution is exact; on a TLS listener several entries share the port
//     and the strictest of their limits applies to all of them.
//   * The counting happens after the fact — a burst is not prevented, the
//     next one is. Same trade-off as the WAF scanner ban.
//   * The log only exists while at least one entry has a limit; without one
//     the Caddy config carries no extra logger at all.

const fs = require('fs');
const path = require('path');
const config = require('../../config/default');
const logger = require('../utils/logger');

const LOG_NAME = 'l4conn.log';
const POLL_INTERVAL_MS = 5000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
// Upper bounds for the per-entry settings (API validation uses the same).
const LIMIT_RANGE = [1, 100000];
const WINDOW_RANGE = [1, 3600];
// Memory guard: at most this many (ip, port) counters; the oldest go first.
const MAX_KEYS = 20000;
const CONNECT_MSG = 'started handling connection';

function logPath() {
  return path.join(config.caddy.dataDir || '/data/caddy', LOG_NAME);
}

/** Does this entry have a connection-rate limit? */
function isArmed(route) {
  if (!route || route.route_type !== 'l4') return false;
  const limit = Number(route.l4_conn_limit);
  const win = Number(route.l4_conn_window_s);
  return Number.isInteger(limit) && limit >= LIMIT_RANGE[0]
    && Number.isInteger(win) && win >= WINDOW_RANGE[0];
}

/**
 * The Caddy log that carries the connection lines. Its own file (rolled by
 * Caddy), DEBUG level and `include: ['layer4']` — the default log stays at
 * INFO, so the container log does NOT see the debug lines.
 */
function logConfig() {
  return {
    writer: { output: 'file', filename: logPath(), roll_size_mb: 5, roll_keep: 2 },
    encoder: { format: 'json' },
    level: 'DEBUG',
    include: ['layer4'],
  };
}

/**
 * listen port → the strictest limit of the entries on it: the smallest
 * connection count together with the longest window (bans soonest).
 * Ranges (`2000-2010`) are skipped — the log names a single port, and a range
 * listener is not the port-forward case this protects.
 */
function limitsByPort(routes) {
  const out = new Map();
  for (const r of routes || []) {
    if (!isArmed(r) || !r.enabled) continue;
    const port = String(r.l4_listen_port == null ? '' : r.l4_listen_port).trim();
    if (!/^\d+$/.test(port)) continue;
    const limit = Number(r.l4_conn_limit);
    const windowS = Math.min(Number(r.l4_conn_window_s), WINDOW_RANGE[1]);
    const cur = out.get(port);
    if (!cur) out.set(port, { limit, windowS });
    else out.set(port, { limit: Math.min(cur.limit, limit), windowS: Math.max(cur.windowS, windowS) });
  }
  return out;
}

/** "203.0.113.7:42613" / "[2001:db8::1]:42613" → "203.0.113.7" / "2001:db8::1". */
function hostOf(hostPort) {
  const s = String(hostPort == null ? '' : hostPort);
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end > 0 ? s.slice(1, end) : '';
  }
  const idx = s.lastIndexOf(':');
  return idx > 0 ? s.slice(0, idx) : '';
}

/** "203.0.113.7:42613" → "42613". */
function portOf(hostPort) {
  const s = String(hostPort == null ? '' : hostPort);
  const idx = s.lastIndexOf(':');
  return idx >= 0 ? s.slice(idx + 1) : '';
}

/**
 * One line of the layer4 log → { ts, ip, port } (ts in ms, port = the
 * LISTEN port) or null for everything that is not a new connection.
 */
function parseLine(line) {
  const s = String(line || '').trim();
  if (!s || s[0] !== '{' || s.indexOf(CONNECT_MSG) < 0) return null;
  let o;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || o.msg !== CONNECT_MSG) return null;
  if (o.logger !== 'layer4') return null;
  const ip = hostOf(o.remote);
  const port = portOf(o.local);
  if (!ip || !/^\d+$/.test(port)) return null;
  const ts = typeof o.ts === 'number' && Number.isFinite(o.ts) ? Math.round(o.ts * 1000) : Date.now();
  return { ts, ip, port };
}

// ─── Counters ───────────────────────────────────────────

// key `ip|port` → sorted array of connection timestamps (ms)
const _counts = new Map();

function resetCounters() { _counts.clear(); }

function forgetIp(ip) {
  for (const key of [..._counts.keys()]) {
    if (key.slice(0, key.lastIndexOf('|')) === ip) _counts.delete(key);
  }
}

/**
 * Feed parsed connection events; returns the addresses that crossed their
 * limit. `limits` is the map from limitsByPort. Pure apart from the module's
 * counter map — the watcher does the banning.
 */
function record(events, limits) {
  const offenders = [];
  for (const ev of events || []) {
    if (!ev) continue;
    const rule = limits.get(ev.port);
    if (!rule) continue;                       // no limit on this listener
    const key = ev.ip + '|' + ev.port;
    let arr = _counts.get(key);
    if (!arr) {
      if (_counts.size >= MAX_KEYS) {
        const oldest = _counts.keys().next().value;
        _counts.delete(oldest);
      }
      arr = [];
      _counts.set(key, arr);
    }
    arr.push(ev.ts);
    const from = ev.ts - rule.windowS * 1000;
    while (arr.length > 0 && arr[0] < from) arr.shift();
    if (arr.length > rule.limit) {
      offenders.push({ ip: ev.ip, port: ev.port, hits: arr.length, window_s: rule.windowS, limit: rule.limit, first_seen: new Date(arr[0]).toISOString() });
      // Counting starts over so a still-running scan produces at most one
      // ban attempt per full window instead of one per connection.
      forgetIp(ev.ip);
    }
  }
  return offenders;
}

/** Drop counters whose newest entry is older than the longest window. */
function prune(limits, now = Date.now()) {
  let maxWindow = 0;
  for (const rule of limits.values()) maxWindow = Math.max(maxWindow, rule.windowS);
  if (maxWindow === 0) { _counts.clear(); return; }
  const cutoff = now - maxWindow * 1000;
  for (const [key, arr] of _counts) {
    if (arr.length === 0 || arr[arr.length - 1] < cutoff) _counts.delete(key);
  }
}

// ─── Watcher ────────────────────────────────────────────

const _watch = { timer: null, file: null, offset: 0, ino: null, partial: '', busy: false };

function armedRoutes() {
  const { getDb } = require('../db/connection');
  return getDb().prepare(
    "SELECT id, enabled, route_type, l4_listen_port, l4_conn_limit, l4_conn_window_s FROM routes WHERE route_type = 'l4' AND enabled = 1"
  ).all();
}

function banOffender(o) {
  const reason = `l4_rate: ${o.hits} connections in ${o.window_s} s on port ${o.port} (limit ${o.limit})`;
  const ban = require('./wafBans').autoBan({ ip: o.ip, reason, hits: o.hits, first_seen: o.first_seen });
  if (!ban) return false;
  logger.warn({ ip: o.ip, port: o.port, hits: o.hits, window_s: o.window_s }, 'layer4: connection rate exceeded — IP banned');
  try {
    require('./activity').log('waf_ip_banned', `IP ${o.ip} banned (${o.hits} connections in ${o.window_s} s on port ${o.port})`, {
      source: 'system', severity: 'warning',
      details: { ip: o.ip, port: o.port, hits: o.hits, window_s: o.window_s, reason: 'l4_rate', manual: false },
    });
  } catch { /* best-effort */ }
  return true;
}

/** One poll: read what is new in the log, count it, ban what crossed. */
function pollOnce() {
  if (_watch.busy) return 0;
  _watch.busy = true;
  try {
    const limits = limitsByPort(armedRoutes());
    if (limits.size === 0) { resetCounters(); return 0; }

    const file = _watch.file || logPath();
    let st;
    try { st = fs.statSync(file); }
    catch { _watch.ino = null; _watch.offset = 0; _watch.partial = ''; return 0; }

    // New file (Caddy rolled it) or truncated → start from the top.
    if (_watch.ino !== null && (st.ino !== _watch.ino || st.size < _watch.offset)) {
      _watch.offset = 0; _watch.partial = '';
    }
    _watch.ino = st.ino;
    if (st.size <= _watch.offset) { prune(limits); return 0; }

    const to = Math.min(st.size, _watch.offset + MAX_READ_BYTES);
    const len = to - _watch.offset;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    let fd;
    try { fd = fs.openSync(file, 'r'); }
    catch { return 0; }
    try { read = fs.readSync(fd, buf, 0, len, _watch.offset); }
    finally { fs.closeSync(fd); }
    _watch.offset += read;

    const text = _watch.partial + buf.slice(0, read).toString('utf8');
    const lines = text.split('\n');
    _watch.partial = lines.pop() || '';
    // A single line can never be this long — a lost sync must not grow forever.
    if (_watch.partial.length > 64 * 1024) _watch.partial = '';

    const events = [];
    for (const line of lines) {
      const ev = parseLine(line);
      if (ev) events.push(ev);
    }
    const offenders = record(events, limits);
    prune(limits);
    let banned = 0;
    const seen = new Set();
    for (const o of offenders) {
      if (seen.has(o.ip)) continue;
      seen.add(o.ip);
      if (banOffender(o)) banned++;
    }
    return banned;
  } catch (err) {
    logger.warn({ err: err.message }, 'layer4: connection guard tick failed');
    return 0;
  } finally {
    _watch.busy = false;
  }
}

function start({ file, intervalMs = POLL_INTERVAL_MS, immediate = false } = {}) {
  if (_watch.timer) return;
  _watch.file = file || logPath();
  _watch.offset = 0; _watch.ino = null; _watch.partial = '';
  resetCounters();
  // Only what is appended from now on counts — a backlog from before the
  // restart would ban for traffic that is long over.
  try { const st = fs.statSync(_watch.file); _watch.offset = st.size; _watch.ino = st.ino; } catch { /* no log yet */ }
  _watch.timer = setInterval(pollOnce, intervalMs);
  if (_watch.timer.unref) _watch.timer.unref();
  if (immediate) pollOnce();
  logger.info({ file: _watch.file }, 'layer4 connection guard started');
}

function stop() {
  if (_watch.timer) { clearInterval(_watch.timer); _watch.timer = null; }
  resetCounters();
}

module.exports = {
  LOG_NAME,
  LIMIT_RANGE,
  WINDOW_RANGE,
  logPath,
  logConfig,
  isArmed,
  limitsByPort,
  parseLine,
  record,
  prune,
  resetCounters,
  pollOnce,
  start,
  stop,
  _watch,
};
