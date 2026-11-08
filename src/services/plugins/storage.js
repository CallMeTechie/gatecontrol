'use strict';

// Host side of a plugin's storage: one SQLite file per plugin at
// <data>/plugin-data/<id>/db/plugin.db, served by a worker thread
// (dbWorker.js). Chosen over "tables prefixed plg_<id>_ in the main DB":
//   * no SQL parsing is needed to keep a plugin away from GateControl's own
//     tables — the main database is simply not open in that connection
//     (ATTACH & co. are refused by sqlGuard);
//   * "Alles löschen" is deleting one folder, "Daten behalten" is leaving it;
//   * the file has a size cap (max_page_count) and a runaway query only
//     blocks the worker, which is terminated after TIMEOUTS.db.
// The plugin process cannot write this folder (its --allow-fs-write is the
// sibling files/ folder), so it cannot swap the database file under the host.
//
// The time limit is the one of the statement in the worker, not the time the
// host's main thread needs to see its answer: the worker marks in shared
// memory which call it runs since when, and answers on its own MessagePort.
// When a call's timer fires, the answers that already arrived are taken
// first (receiveMessageOnPort — after the main thread was blocked, the timer
// fires before the 'message' event); then only a statement running longer
// than its limit — or a worker idle that long with work waiting — ends the
// worker. A call waiting behind another statement is not timed out for that
// one's time; starting the worker and opening the file (cold start) has its
// own limit, TIMEOUTS.dbOpen. (A terminated worker ends once SQLite gives
// control back to JavaScript — a statement never ends half-way.)

const fs = require('node:fs');
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { dbDir, LIMITS, TIMEOUTS } = require('./constants');
const logger = require('../../utils/logger');
const { fingerprint } = require('./sqlGuard');

const IDLE_MS = 5 * 60 * 1000;
const instances = new Map();

// A slow statement of a plugin (its time in the worker, from SLOW_MS on) is logged with the plugin, the statement
// without its values (sqlGuard.fingerprint), the rows and the times — at most once per SLOW_EVERY_MS and
// statement of a plugin; the line says how often it was slow since the last one.
const SLOW_MS = 200;
const SLOW_EVERY_MS = 60 * 1000;
const SLOW_KEYS_MAX = 200;

/** The largest size of a plugin's database: plugin.json storage.maxMB (since 1.206.0), else LIMITS.dbMaxBytes. */
function maxBytesOf(id) {
  try {
    const p = require('./registry').get(id);
    const v = p && p.manifest && p.manifest.storage && p.manifest.storage.maxBytes;
    return Number.isSafeInteger(v) && v > 0 ? v : LIMITS.dbMaxBytes;
  } catch { return LIMITS.dbMaxBytes; }
}

// the worker's state in shared memory: Int32 [open (0 while starting), id of the running call (0: none)],
// Float64 at 8: when that state last changed (Date.now())
const ST_OPEN = 0;
const ST_RUNNING = 1;
const STATE_BYTES = 16;
const REARM_MIN_MS = 10;

class PluginDb {
  constructor(id) {
    this.id = id;
    this.maxBytes = null; // set by setLimit (install / update), else maxBytesOf(id)
    this.worker = null;
    this.port = null;
    this.state = null;
    this.since = null;
    this.startedAt = 0;
    this.seq = 0;
    this.pending = new Map();
    this.idle = null;
    this.slow = new Map(); // fingerprint → { at, n, maxMs } (slow statements since the last log line)
  }

  ensure() {
    if (this.worker) return this.worker;
    const dir = dbDir(this.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sab = new SharedArrayBuffer(STATE_BYTES);
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(path.join(__dirname, 'dbWorker.js'), {
      workerData: { file: path.join(dir, 'plugin.db'), maxBytes: this.maxBytes || maxBytesOf(this.id), state: sab, port: port2 },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      env: {},
    });
    w.unref();
    port1.on('message', (m) => this.onAnswer(m));
    port1.unref();
    const fail = (err) => {
      if (this.worker !== w) return;
      this.worker = null;
      this.port = null;
      port1.close();
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    };
    w.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', () => fail(new Error('storage closed')));
    this.worker = w;
    this.port = port1;
    this.state = new Int32Array(sab, 0, 2);
    this.since = new Float64Array(sab, 8, 1);
    this.startedAt = Date.now();
    return w;
  }

  onAnswer(m) {
    const p = m && this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (typeof m.ms === 'number' && m.ms >= SLOW_MS) this.noteSlow(p, m);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
  }

  /** A statement that ran SLOW_MS or longer in the worker: logged (throttled per statement). */
  noteSlow(p, m, now = Date.now()) {
    const sql = p.args && typeof p.args.sql === 'string' ? fingerprint(p.args.sql) : null;
    const key = sql || p.op;
    let e = this.slow.get(key);
    if (!e) {
      if (this.slow.size >= SLOW_KEYS_MAX) this.slow.delete(this.slow.keys().next().value);
      e = { at: 0, n: 0, maxMs: 0 };
      this.slow.set(key, e);
    }
    e.n++;
    e.maxMs = Math.max(e.maxMs, m.ms);
    if (now - e.at < SLOW_EVERY_MS) return;
    logger.warn({
      plugin: this.id, op: p.op, ...(p.args && p.args.mode ? { mode: p.args.mode } : {}), ...(sql ? { sql } : {}),
      ...(Number.isInteger(m.rows) ? { rows: m.rows } : {}), ...(m.ok ? {} : { failed: true }),
      ms: Math.round(m.ms),
      // the rest of the time until the answer was taken: waiting behind other statements, and for this thread
      waitMs: Math.max(0, Math.round(now - p.sentAt - m.ms)),
      ...(e.n > 1 ? { times: e.n, maxMs: Math.round(e.maxMs) } : {}),
    }, 'slow plugin database statement');
    e.at = now;
    e.n = 0;
    e.maxMs = 0;
  }

  call(op, args, timeoutMs = TIMEOUTS.db) {
    this.ensure();
    const id = ++this.seq;
    this.touch();
    return new Promise((resolve, reject) => {
      const p = { op, args, resolve, reject, timeoutMs, sentAt: Date.now(), timer: null };
      p.timer = setTimeout(() => this.check(id), timeoutMs);
      this.pending.set(id, p);
      this.port.postMessage({ id, op, args });
    });
  }

  /**
   * The timer of call `id` fired: is the worker really stuck? The state is
   * read before the arrived answers are taken, so an answer posted after the
   * read is among them. Not stuck yet → the timer is set to the moment it would be.
   */
  check(id) {
    const p = this.pending.get(id);
    if (!p || !this.worker) return;
    const w = this.worker;
    let open; let running; let since; let taken;
    do { // answers taken = the worker went on: look again
      open = Atomics.load(this.state, ST_OPEN);
      running = Atomics.load(this.state, ST_RUNNING);
      since = this.since[0];
      taken = 0;
      for (let m = receiveMessageOnPort(this.port); m; m = receiveMessageOnPort(this.port)) { this.onAnswer(m.message); taken++; }
      if (!this.pending.has(id)) return;
    } while (taken);
    const busy = running && this.pending.get(running);
    let deadline;
    if (!open) deadline = this.startedAt + TIMEOUTS.dbOpen;
    else if (busy) deadline = since + busy.timeoutMs;
    else deadline = Math.max(since, p.sentAt) + p.timeoutMs; // idle that long while this call waits
    const now = Date.now();
    if (now < deadline) {
      p.timer = setTimeout(() => this.check(id), Math.max(REARM_MIN_MS, deadline - now));
      return;
    }
    logger.warn({ plugin: this.id, op: busy ? busy.op : p.op, phase: !open ? 'open' : (busy ? 'statement' : 'idle'), ms: now - (open ? since : this.startedAt) },
      'plugin storage timed out — worker restarted');
    // a statement that runs this long blocks every later one: start over (the calls waiting
    // behind it end too — the next call opens a new worker)
    this.worker = null;
    this.port.close();
    this.port = null;
    for (const q of this.pending.values()) { clearTimeout(q.timer); q.reject(new Error('storage timeout')); }
    this.pending.clear();
    w.terminate().catch(() => {});
  }

  touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.pending.size) this.close(); }, IDLE_MS);
    this.idle.unref();
  }

  async close() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    if (this.port) { this.port.close(); this.port = null; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('storage closed')); }
    this.pending.clear();
    await w.terminate().catch(() => {});
  }
}

function forPlugin(id) {
  let db = instances.get(id);
  if (!db) { db = new PluginDb(id); instances.set(id, db); }
  return db;
}

async function close(id) {
  const db = instances.get(id);
  instances.delete(id);
  if (db) await db.close();
}

/**
 * The size limit of a plugin's database (install / update with plugin.json
 * storage.maxMB): an open connection with another limit closes, the next
 * call opens it with the new one (SQLite never shrinks below what is used).
 */
async function setLimit(id, maxBytes) {
  const db = forPlugin(id);
  if (db.maxBytes === maxBytes) return;
  db.maxBytes = maxBytes;
  await db.close();
}

async function closeAll() {
  await Promise.all([...instances.keys()].map(close));
}

/** Bytes used by a plugin's data folder (database + files). */
function usage(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 20) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(dir, 0);
  return total;
}

module.exports = { forPlugin, close, closeAll, usage, setLimit, maxBytesOf, SLOW_MS, SLOW_EVERY_MS };
