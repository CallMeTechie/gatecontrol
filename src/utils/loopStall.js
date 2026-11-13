'use strict';

// Logs when the main thread did not get to its timers for a while: every
// timer of the host — plugin storage, plugin calls, polls — fires late then,
// and a log line with the time says which errors of that moment came from a
// blocked host rather than from what they name (synchronous file I/O under
// heavy load, a large backup, …). Costs one timer per second.
//
// Task markers: the known heavy background jobs run inside withTask(name, fn)
// (two clock reads and an entry in a small ring — no profiler). The log line
// of a stall names the marked jobs that ran in the blocked time, with the
// time each spent in it (`tasks`), so the next report says what blocked.
//
// Synchronous pieces (measure(name, fn)): request handlers up to their first
// await, res.json / res.send (a huge answer is serialised in one go), the
// messages of plugin processes and the answers sent to them. Only a piece
// that took MEASURE_MIN_MS or more is kept — its time is exactly the time it
// held the thread, so `tasks` names it even when no timer job ran.
//
// Database statements (instrumentDb): a statement of the host database that
// took DB_MIN_MS or more is in `tasks` as `db <statement without values>` —
// the thread waited in it (the disk, a lock held by another process).
//
// Requests (httpMiddleware, beginRequest/endRequest): what was open in the
// blocked time is listed as `requests` (route with ids masked, time in the
// window) — candidates for a stall no marker explains (their async part).
//
// The plugin watchdog (services/plugins/runtime.js) asks blockedSince(): a
// plugin that seems silent only because the host itself did not run gets
// another round instead of a SIGKILL.

const { performance } = require('node:perf_hooks');
const logger = require('./logger');

const EVERY_MS = 1000;
const WARN_MS = 2000;
// stalls kept for blockedSince() (wall clock), and from what length
const RECORD_MS = 500;
const STALLS_MAX = 64;
// finished task spans kept for the report of a stall
const SPANS_MAX = 256;
const TASKS_IN_LOG = 6;
// a synchronous piece (measure) shorter than this is not kept
const MEASURE_MIN_MS = 20;
// requests: finished ones kept from this length on, at most REQ_MAX of them
const REQ_KEEP_MS = 200;
const REQ_MAX = 128;
const REQ_OPEN_MAX = 2000;
const REQ_IN_LOG = 6;
// a request open longer than this (an event stream, a long poll) is no candidate
const REQ_STALE_MS = 10 * 60 * 1000;

let timer = null;
let lastTick = null;
let everyMsNow = EVERY_MS;
let lastUse = null;

// What the process did in a blocked time (two system calls a second): the main thread's own CPU time
// (process.threadCpuUsage, Node ≥ 23.9) and the whole process's (worker threads included), the major page faults
// (memory read back from disk: swap) and the blocks read from disk. Main-thread CPU near the blocked time: this
// thread computed (JavaScript, a synchronous statement on the host database, GC); far below it: it waited —
// synchronous I/O, the disk, a lock, swap, or no CPU free for it.
function usageNow() {
  try {
    const r = process.resourceUsage();
    const t = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
    return { main: t ? (t.user + t.system) / 1000 : null, proc: (r.userCPUTime + r.systemCPUTime) / 1000, faults: r.majorPageFault, reads: r.fsRead };
  } catch { return null; }
}

/** The usage between two samples for a stall of `ms` → fields of the log line. */
function usageFields(a, b, ms) {
  if (!a || !b) return {};
  const out = { processCpuMs: Math.round(b.proc - a.proc), majorFaults: b.faults - a.faults, diskReads: b.reads - a.reads };
  if (a.main != null && b.main != null) {
    out.mainCpuMs = Math.round(b.main - a.main);
    out.blockedBy = out.mainCpuMs >= ms * 0.6 ? 'cpu' : 'waiting';
  }
  return out;
}

function diskSyncMs() {
  try { return require('../services/diskHealth').lastMs(); } catch { return null; }
}

const stalls = []; // { end, ms } — end: Date.now() when the stall was seen
const active = new Map(); // id → { name, at } (performance.now())
const spans = []; // { name, at, end } finished
let seq = 0;

/** Mark the start of a task; → id for endTask(). */
function beginTask(name) {
  const id = ++seq;
  active.set(id, { name: String(name), at: performance.now() });
  return id;
}

function pushSpan(span) {
  spans.push(span);
  if (spans.length > SPANS_MAX) spans.splice(0, spans.length - SPANS_MAX);
}

function endTask(id, { async = false } = {}) {
  const t = active.get(id);
  if (!t) return;
  active.delete(id);
  pushSpan({ name: t.name, at: t.at, end: performance.now(), async: async || !!t.async });
}

let measuring = 0;
/**
 * Run the synchronous `fn` and keep its time as the task `name` (a string or
 * a function → string, asked afterwards) when it took `minMs` or more.
 * Nested measures count for the outermost one only. → what fn returns.
 */
function measure(name, fn, minMs = MEASURE_MIN_MS) {
  if (measuring) return fn();
  measuring++;
  const at = performance.now();
  try {
    return fn();
  } finally {
    measuring--;
    const end = performance.now();
    if (end - at >= minMs) {
      let n;
      try { n = typeof name === 'function' ? name() : name; } catch { n = 'unknown'; }
      pushSpan({ name: String(n), at, end });
    }
  }
}

// ─── Requests ───────────────────────────────────

const openReqs = new Map(); // id → { name, at }
const doneReqs = []; // { name, at, end }
let reqSeq = 0;

/**
 * A request (or another awaited operation) starts; → id for endRequest().
 * `res`: its response — an event stream that runs for hours is no candidate.
 */
function beginRequest(name, res = null) {
  if (openReqs.size >= REQ_OPEN_MAX) return 0;
  const id = ++reqSeq;
  openReqs.set(id, { name: String(name), at: performance.now(), res });
  return id;
}

function streaming(res) {
  try { return !!res && res.headersSent && /event-stream/i.test(String(res.getHeader('content-type') || '')); } catch { return false; }
}

/** It ended; `name` replaces the one given at the start (the route is known now). */
function endRequest(id, name) {
  const r = openReqs.get(id);
  if (!r) return;
  openReqs.delete(id);
  const end = performance.now();
  if (end - r.at < REQ_KEEP_MS) return;
  doneReqs.push({ name: name == null ? r.name : String(name), at: r.at, end });
  if (doneReqs.length > REQ_MAX) doneReqs.splice(0, doneReqs.length - REQ_MAX);
}

/** Requests open between `from` and `to`: [{ name, ms (in the window), open }], longest first. */
function requestsBetween(from, to) {
  const out = [];
  const add = (name, at, end, open) => {
    const ms = Math.min(end, to) - Math.max(at, from);
    if (ms >= 0) out.push({ name, ms, open });
  };
  for (const r of doneReqs) if (r.end >= from && r.at <= to) add(r.name, r.at, r.end, false);
  for (const r of openReqs.values()) if (r.at <= to && to - r.at < REQ_STALE_MS && !streaming(r.res)) add(r.name, r.at, to, true);
  return out.sort((a, b) => b.ms - a.ms);
}

const ID_SEG_RE = /^(?:\d+|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{32,})$/i;

/** "GET /api/v1/gateway/cache/blob/<sha>?x" → "GET /api/v1/gateway/cache/blob/:id" (ids and tokens masked, ≤ 100 chars). */
function routeLabel(method, url) {
  const p = String(url || '').split('?')[0].split('/').map((seg) => (ID_SEG_RE.test(seg) ? ':id' : seg)).join('/');
  return `${method || 'GET'} ${p.slice(0, 100)}`;
}

/**
 * Express middleware (first in app.js): the request is open until its answer
 * is done; the synchronous part of the handlers that run from here and the
 * serialisation of res.json / res.send are measured. measureNext (right
 * before the routes) measures the handlers again after the body was read.
 */
function httpMiddleware(req, res, next) {
  const label = () => routeLabel(req.method, req.originalUrl || req.url);
  const id = beginRequest(label(), res);
  let ended = false;
  const done = () => { if (ended) return; ended = true; endRequest(id); };
  res.once('finish', done);
  res.once('close', done);
  const json = res.json;
  const send = res.send;
  res.json = function measuredJson(...a) { return measure(() => `${label()} (json)`, () => json.apply(this, a)); };
  res.send = function measuredSend(...a) { return measure(() => `${label()} (send)`, () => send.apply(this, a)); };
  measure(label, () => next());
}

function measureNext(req, res, next) {
  measure(() => routeLabel(req.method, req.originalUrl || req.url), () => next());
}

/**
 * Run `fn` as the task `name` (sync or async — a promise is marked until it
 * settles). → what fn returns.
 */
function withTask(name, fn) {
  const id = beginTask(name);
  let r;
  try { r = fn(); } catch (e) { endTask(id); throw e; }
  if (r && typeof r.then === 'function') {
    // an async task: its time in a stall is the time it was under way — partly waiting (I/O, a child process), not its own work
    const t = active.get(id);
    if (t) t.async = true;
    return r.then((v) => { endTask(id); return v; }, (e) => { endTask(id); throw e; });
  }
  endTask(id);
  return r;
}

/**
 * The marked tasks that ran between `from` and `to` (performance.now()),
 * per name: time inside the window, how often, still running. Longest first.
 */
function tasksBetween(from, to) {
  const by = new Map();
  const add = (name, at, end, running, async) => {
    const ms = Math.min(end, to) - Math.max(at, from);
    if (ms < 0) return;
    const e = by.get(name) || { name, ms: 0, n: 0, running: false, async: false };
    e.ms += ms;
    e.n += 1;
    e.running = e.running || running;
    e.async = e.async || !!async;
    by.set(name, e);
  };
  for (const s of spans) if (s.end >= from && s.at <= to) add(s.name, s.at, s.end, false, s.async);
  for (const t of active.values()) if (t.at <= to) add(t.name, t.at, to, true, true);
  return [...by.values()].sort((a, b) => b.ms - a.ms);
}

function describeTasks(list) {
  // own work first: a synchronous task's time is exactly the time it held the thread; an async one was
  // only under way (it may just have waited for its I/O while something else blocked)
  const sorted = [...list].sort((a, b) => (a.async === b.async ? b.ms - a.ms : (a.async ? 1 : -1)));
  return sorted.slice(0, TASKS_IN_LOG).map((t) => `${t.name}${t.n > 1 ? ` ×${t.n}` : ''}: ${Math.round(t.ms)} ms${t.running ? ' (still running)' : (t.async ? ' (async)' : '')}`);
}

function describeRequests(list) {
  return list.slice(0, REQ_IN_LOG).map((r) => `${r.name}: ${Math.round(r.ms)} ms${r.open ? ' (open)' : ''}`);
}

/**
 * How long the main thread was blocked (ms, sum of the stalls seen) since the
 * wall-clock time `since` — including a stall that is going on right now
 * (this timer has not run yet). 0 while the watch is off.
 */
function blockedSince(since, now = Date.now()) {
  let ms = 0;
  for (const s of stalls) {
    if (s.end <= since) continue;
    ms += Math.min(s.ms, s.end - since);
  }
  if (timer && lastTick != null) {
    const late = performance.now() - lastTick - everyMsNow;
    if (late >= RECORD_MS) ms += Math.min(late, Math.max(0, now - since));
  }
  return Math.max(0, Math.round(ms));
}

function noteStall(ms, end = Date.now()) {
  stalls.push({ end, ms });
  if (stalls.length > STALLS_MAX) stalls.splice(0, stalls.length - STALLS_MAX);
}

const SPAWN_MIN_MS = 20;
let spawnMinMs = SPAWN_MIN_MS;
let spawnPatched = false;

/**
 * Starting a child process is synchronous on this thread (fork + exec; slow
 * when the server's memory is large or under pressure): every spawn of
 * SPAWN_MIN_MS or more is kept as `spawn <program>`.
 */
function instrumentSpawn() {
  if (spawnPatched) return;
  spawnPatched = true;
  const { ChildProcess } = require('node:child_process');
  const orig = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function measuredSpawn(options) {
    return measure(() => `spawn ${String((options && options.file) || '?').split('/').pop().slice(0, 40)}`, () => orig.call(this, options), spawnMinMs);
  };
}

const DB_MIN_MS = 20;
let dbMinMs = DB_MIN_MS;
let dbPatched = false;

/**
 * Statements of a database opened on this thread (the host database) are
 * synchronous: a write appends to the write-ahead log — and the first one
 * after a checkpoint syncs the log's new header (an fsync on this thread,
 * db/checkpointWorker.js) —, a read may fetch pages from the disk, and a
 * write waits up to busy_timeout while another process holds the database.
 * Every statement of DB_MIN_MS or more is kept as `db <statement without its
 * values>` — also inside a measured piece (a request, a plugin call), so a
 * stall names the statement the thread waited in. Two clock reads per
 * statement.
 */
function instrumentDb() {
  if (dbPatched) return;
  dbPatched = true;
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
    probe.close();
    const keep = (sql, at) => {
      const end = performance.now();
      if (end - at < dbMinMs) return;
      let name;
      try { name = `db ${require('../services/plugins/sqlGuard').fingerprint(sql, 100)}`; } catch { name = 'db'; }
      pushSpan({ name, at, end });
    };
    const wrap = (orig) => function measuredStatement(...a) {
      const at = performance.now();
      try { return orig.apply(this, a); } finally { keep(this.source, at); }
    };
    proto.run = wrap(proto.run);
    proto.get = wrap(proto.get);
    proto.all = wrap(proto.all);
    const exec = Database.prototype.exec;
    Database.prototype.exec = function measuredExec(sql) {
      const at = performance.now();
      try { return exec.call(this, sql); } finally { keep(sql, at); }
    };
  } catch (err) {
    logger.debug({ err: err && err.message }, 'database statements not measured');
  }
}

/** Start watching (idempotent). `onStall(ms, tasks)` for tests. */
function start({ everyMs = EVERY_MS, warnMs = WARN_MS, onStall = null } = {}) {
  if (timer) return;
  instrumentSpawn();
  instrumentDb();
  everyMsNow = everyMs;
  lastTick = performance.now();
  lastUse = usageNow();
  timer = setInterval(() => {
    const now = performance.now();
    const prev = lastTick;
    const late = Math.round(now - prev - everyMs);
    lastTick = now;
    const prevUse = lastUse;
    lastUse = usageNow();
    if (late >= RECORD_MS) noteStall(late);
    if (late < warnMs) return;
    const tasks = tasksBetween(prev, now);
    const reqs = requestsBetween(prev + everyMs, now);
    const fields = { blockedMs: late, ...usageFields(prevUse, lastUse, late) };
    // the latest write probe of the data disk (services/diskHealth.js): "waiting" with a slow disk is the disk
    const sync = diskSyncMs();
    if (sync != null) fields.diskSyncMs = sync;
    if (tasks.length) fields.tasks = describeTasks(tasks);
    if (reqs.length) fields.requests = describeRequests(reqs);
    logger.warn(fields, 'event loop was blocked');
    if (onStall) onStall(late, tasks, reqs);
  }, everyMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  lastTick = null;
}

/** setInterval/setTimeout callback that runs `fn` as the task `name` (errors logged, never thrown). */
function task(name, fn) {
  return (...args) => {
    let r;
    try { r = withTask(name, () => fn(...args)); } catch (e) { logger.warn({ task: name, err: e && e.message }, 'background task failed'); return undefined; }
    if (r && typeof r.catch === 'function') r.catch((e) => logger.warn({ task: name, err: e && e.message }, 'background task failed'));
    return r;
  };
}

function _resetForTest() {
  stop();
  lastUse = null;
  stalls.length = 0;
  spans.length = 0;
  active.clear();
  openReqs.clear();
  doneReqs.length = 0;
  measuring = 0;
}

module.exports = {
  start, stop, withTask, beginTask, endTask, tasksBetween, blockedSince, measure, task,
  beginRequest, endRequest, requestsBetween, routeLabel, httpMiddleware, measureNext, instrumentSpawn, instrumentDb,
  _setDbMinMsForTest: (ms) => { dbMinMs = ms == null ? DB_MIN_MS : ms; },
  _setSpawnMinMsForTest: (ms) => { spawnMinMs = ms == null ? SPAWN_MIN_MS : ms; },
  EVERY_MS, WARN_MS, RECORD_MS, MEASURE_MIN_MS, _noteStallForTest: noteStall, _resetForTest, _usageFieldsForTest: usageFields,
};
