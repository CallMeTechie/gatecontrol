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

let timer = null;
let lastTick = null;
let everyMsNow = EVERY_MS;

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

function endTask(id) {
  const t = active.get(id);
  if (!t) return;
  active.delete(id);
  spans.push({ name: t.name, at: t.at, end: performance.now() });
  if (spans.length > SPANS_MAX) spans.splice(0, spans.length - SPANS_MAX);
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
  const add = (name, at, end, running) => {
    const ms = Math.min(end, to) - Math.max(at, from);
    if (ms < 0) return;
    const e = by.get(name) || { name, ms: 0, n: 0, running: false };
    e.ms += ms;
    e.n += 1;
    e.running = e.running || running;
    by.set(name, e);
  };
  for (const s of spans) if (s.end >= from && s.at <= to) add(s.name, s.at, s.end, false);
  for (const t of active.values()) if (t.at <= to) add(t.name, t.at, to, true);
  return [...by.values()].sort((a, b) => b.ms - a.ms);
}

function describeTasks(list) {
  return list.slice(0, TASKS_IN_LOG).map((t) => `${t.name}${t.n > 1 ? ` ×${t.n}` : ''}: ${Math.round(t.ms)} ms${t.running ? ' (still running)' : ''}`);
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

/** Start watching (idempotent). `onStall(ms, tasks)` for tests. */
function start({ everyMs = EVERY_MS, warnMs = WARN_MS, onStall = null } = {}) {
  if (timer) return;
  everyMsNow = everyMs;
  lastTick = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const prev = lastTick;
    const late = Math.round(now - prev - everyMs);
    lastTick = now;
    if (late >= RECORD_MS) noteStall(late);
    if (late < warnMs) return;
    const tasks = tasksBetween(prev, now);
    const fields = { blockedMs: late };
    if (tasks.length) fields.tasks = describeTasks(tasks);
    logger.warn(fields, 'event loop was blocked');
    if (onStall) onStall(late, tasks);
  }, everyMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  lastTick = null;
}

function _resetForTest() {
  stop();
  stalls.length = 0;
  spans.length = 0;
  active.clear();
}

module.exports = {
  start, stop, withTask, beginTask, endTask, tasksBetween, blockedSince,
  EVERY_MS, WARN_MS, RECORD_MS, _noteStallForTest: noteStall, _resetForTest,
};
