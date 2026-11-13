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
const checkpoints = require('./checkpointService');

const IDLE_MS = 5 * 60 * 1000;
// closing a worker: how long SQLite may take for its last checkpoint before the worker is terminated
const CLOSE_MS = 3000;
// a checkpoint after this long without a call (dbWorker.js; null: its default) — shorter in tests only
let checkpointIdleMs = null;
// the upper limit of a log while the checkpoint thread serves the file (dbWorker.js; null: its default) — tests only
let walCapPages = null;
const instances = new Map();

// A slow statement of a plugin (its time in the worker, from SLOW_MS on) is counted per plugin; one line per
// plugin and SLOW_WINDOW_MS says how many there were (`slow`, of them `writes`), the longest time (`maxMs`), the
// longest wait beside it (`waitMs`) and the SLOW_TOP statements by count — each without its values
// (sqlGuard.fingerprint), with its count, longest time and the rows of its last run. Before 1.255.0: a line per
// statement and minute — 500 lines an hour on a slow disk.
const SLOW_MS = 200;
const SLOW_WINDOW_MS = 5 * 60 * 1000;
const SLOW_TOP = 5;
const SLOW_KEYS_MAX = 200;
// a write: what syncs the disk at a commit (before WAL: every one of these), or what changed rows
const WRITE_OPS = new Set(['exec', 'migrate', 'kv.set', 'kv.delete', 'settings.set']);
const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'COMMIT', 'END', 'BEGIN', 'CREATE', 'DROP', 'ALTER', 'SAVEPOINT', 'RELEASE']);
/** The first word of a statement (fingerprint) is one of WRITE_WORDS. */
function writeSql(sql) {
  const m = /^\s*([A-Za-z]{1,10})/.exec(sql);
  return !!m && WRITE_WORDS.has(m[1].toUpperCase());
}

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
// + Int32 at 16: the calls that wrote, counted by the storage thread — how the checkpoint thread sees a change
const STATE_BYTES = 24;
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
    this.slow = null; // { from, n, writes, maxMs, waitMs, by: Map(fingerprint → { op, sql, n, maxMs, rows }) } of this window
    this.slowTimer = null;
    this.sab = null;
    this.served = null;
  }

  ensure() {
    if (this.worker) return this.worker;
    const dir = dbDir(this.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sab = new SharedArrayBuffer(STATE_BYTES);
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(path.join(__dirname, 'dbWorker.js'), {
      workerData: { file: path.join(dir, 'plugin.db'), maxBytes: this.maxBytes || maxBytesOf(this.id), state: sab, port: port2, checkpointIdleMs, walCapPages },
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
    this.sab = sab;
    this.served = null; // null: not asked yet; 'asked' | true | false — by the host's checkpoint thread (checkpointService.js)
    this.state = new Int32Array(sab, 0, 2);
    this.since = new Float64Array(sab, 8, 1);
    this.startedAt = Date.now();
    return w;
  }

  onAnswer(m) {
    // the first answer: the file exists and is in WAL — from now on the checkpoint thread can serve it
    if (this.served === null && this.worker) {
      this.served = checkpoints.add(this.id, path.join(dbDir(this.id), 'plugin.db'), this.sab) ? 'asked' : false;
    }
    const p = m && this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (typeof m.ms === 'number' && m.ms >= SLOW_MS) this.noteSlow(p, m);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
  }

  /** A statement that ran SLOW_MS or longer in the worker: counted, the window's line follows (flushSlow). */
  noteSlow(p, m, now = Date.now()) {
    const sql = p.args && typeof p.args.sql === 'string' ? fingerprint(p.args.sql) : null;
    const key = sql || p.op;
    let w = this.slow;
    if (!w) {
      w = { from: now, n: 0, writes: 0, failed: 0, maxMs: 0, waitMs: 0, by: new Map() };
      this.slow = w;
      this.slowTimer = setTimeout(() => this.flushSlow(), SLOW_WINDOW_MS);
      this.slowTimer.unref();
    }
    let e = w.by.get(key);
    if (!e) {
      if (w.by.size >= SLOW_KEYS_MAX) w.by.delete(w.by.keys().next().value);
      e = { op: p.op, sql, n: 0, maxMs: 0, rows: null };
      w.by.set(key, e);
    }
    const ms = Math.round(m.ms);
    w.n++;
    e.n++;
    if (WRITE_OPS.has(p.op) || (sql && writeSql(sql))) w.writes++;
    if (!m.ok) w.failed++;
    w.maxMs = Math.max(w.maxMs, ms);
    e.maxMs = Math.max(e.maxMs, ms);
    if (Number.isInteger(m.rows)) e.rows = m.rows;
    // the rest of the time until the answer was taken: waiting behind other statements, and for this thread
    w.waitMs = Math.max(w.waitMs, Math.max(0, Math.round(now - p.sentAt - m.ms)));
  }

  /** The line of the window of slow statements (at its end, when the storage closes). */
  flushSlow(now = Date.now()) {
    if (this.slowTimer) { clearTimeout(this.slowTimer); this.slowTimer = null; }
    const w = this.slow;
    this.slow = null;
    if (!w || !w.n) return;
    const top = [...w.by.values()].sort((a, b) => b.n - a.n || b.maxMs - a.maxMs).slice(0, SLOW_TOP)
      .map((e) => ({ op: e.op, ...(e.sql ? { sql: e.sql } : {}), n: e.n, maxMs: e.maxMs, ...(e.rows != null ? { rows: e.rows } : {}) }));
    let diskSyncMs = null;
    try { diskSyncMs = require('../diskHealth').lastMs(); } catch { /* none */ }
    logger.warn({
      plugin: this.id,
      slow: w.n,
      writes: w.writes,
      ...(w.failed ? { failed: w.failed } : {}),
      maxMs: w.maxMs,
      waitMs: w.waitMs,
      windowS: Math.max(1, Math.round((now - w.from) / 1000)),
      statements: top,
      ...(w.by.size > top.length ? { others: w.by.size - top.length } : {}),
      ...(diskSyncMs != null ? { diskSyncMs } : {}),
    }, 'slow plugin database statements');
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
    this.served = null; // the checkpoint thread keeps serving the file; the next worker registers its own counter
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
    this.flushSlow();
    const w = this.worker;
    const port = this.port;
    const state = this.state;
    this.worker = null;
    this.port = null;
    this.served = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('storage closed')); }
    this.pending.clear();
    // first the checkpoint thread's connection (also the one left by a storage thread that was terminated): SQLite
    // copies the log back and removes plugin.db-wal only when the last connection closes, and the folder may be
    // replaced or deleted right after
    await checkpoints.remove(this.id);
    if (!w) return;
    // closed by SQLite (the write-ahead log goes into plugin.db, plugin.db-wal is removed) — a worker still busy
    // with a statement, or one that does not end in CLOSE_MS, is terminated (the log stays, the next open replays it)
    const busy = state && Atomics.load(state, ST_RUNNING);
    if (port && !busy) {
      const exited = new Promise((resolve) => { w.once('exit', resolve); });
      try { port.postMessage({ op: 'close' }); } catch { /* gone */ }
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_MS); })]);
      clearTimeout(timer);
    }
    if (port) port.close();
    await w.terminate().catch(() => {});
  }
}

// the checkpoint thread serves a file / copied its whole log / ended: told to the storage thread of that plugin
function tell(id, msg) {
  const db = instances.get(id);
  if (!db || !db.port) return null;
  try { db.port.postMessage(msg); } catch { /* closing */ }
  return db;
}
checkpoints.handlers.onAdded = (id, ok) => {
  const db = instances.get(id);
  if (!db || db.served !== 'asked') return;
  db.served = ok;
  if (ok) tell(id, { op: 'checkpoints', by: 'service' });
};
checkpoints.handlers.onCheckpointed = (id, seq) => {
  const db = instances.get(id);
  if (db && db.served === true) tell(id, { op: 'restartLog', seq });
};
checkpoints.handlers.onLost = () => {
  for (const [id, db] of instances) {
    if (db.served) tell(id, { op: 'checkpoints', by: 'self' });
    if (db.worker) db.served = false;
  }
};

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
  await checkpoints.stop();
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

module.exports = {
  forPlugin, close, closeAll, usage, setLimit, maxBytesOf, SLOW_MS, SLOW_WINDOW_MS, SLOW_TOP,
  _setCheckpointIdleMsForTest: (ms) => { checkpointIdleMs = ms || null; },
  _setWalCapPagesForTest: (n) => { walCapPages = n || null; },
};
