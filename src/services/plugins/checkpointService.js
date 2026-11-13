'use strict';

// Host side of the checkpoints of the plugin databases: one worker thread
// (checkpointWorker.js) for all of them, see there for the why.
//
//   add(id, file, state)  the storage of a plugin is open: serve its file (state: the storage thread's shared
//                         memory with its write counter). `onAdded(id, ok)` follows.
//   remove(id)            → Promise: the worker's connection to the file is closed (before the storage closes:
//                         SQLite removes plugin.db-wal only when the last connection goes)
//   stop()                → Promise: the thread ended
//
// storage.js is told through the handlers (set by it): onAdded, onCheckpointed(id, seq) after a complete
// checkpoint, onLost() when the thread ended on its own — the storage threads then checkpoint themselves again
// (dbWorker.js, as before), and the next add() starts a new thread (not more often than RESTART_MS).
//
// Off with GC_PLUGIN_CHECKPOINT=inline; under NODE_ENV=test only with GC_PLUGIN_CHECKPOINT=worker (a test process
// that ends while the thread still loads better-sqlite3 crashes Node, see db/connection.js).

const path = require('node:path');
const logger = require('../../utils/logger');
const gate = require('../../db/checkpointGate');

// closing a database: how long the thread may take to answer (it is in a checkpoint of another one meanwhile)
const REMOVE_MS = 5000;
const RESTART_MS = 60 * 1000;

let worker = null;
let lostAt = 0;
let seq = 0;
let options = {};
const waiting = new Map(); // n → resolve (remove)
const handlers = { onAdded: null, onCheckpointed: null, onCheckpoint: null, onLost: null };

function enabled() {
  const v = String(process.env.GC_PLUGIN_CHECKPOINT || '').toLowerCase();
  if (v === 'inline') return false;
  if (v === 'worker') return true;
  return process.env.NODE_ENV !== 'test';
}

function call(fn, ...args) {
  try { if (fn) fn(...args); } catch (err) { logger.debug({ err: err && err.message }, 'plugin checkpoints: handler failed'); }
}

function ended(w, why) {
  if (worker !== w) return;
  worker = null;
  lostAt = Date.now();
  gate.clear(gate.PLUGINS);
  for (const resolve of waiting.values()) resolve(false);
  waiting.clear();
  if (why) logger.warn({ err: why }, 'plugin checkpoint thread ended — the plugin databases checkpoint themselves again');
  call(handlers.onLost);
}

function ensure() {
  if (worker) return worker;
  if (!enabled() || Date.now() - lostAt < RESTART_MS) return null;
  let w;
  try {
    const { Worker } = require('node:worker_threads');
    w = new Worker(path.join(__dirname, 'checkpointWorker.js'), {
      workerData: { gate: gate.shared(), ...options },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      env: {},
    });
  } catch (err) {
    lostAt = Date.now();
    logger.warn({ err: err.message }, 'plugin checkpoint thread not started — the plugin databases checkpoint themselves');
    return null;
  }
  w.on('message', (m) => {
    if (!m || worker !== w) return;
    if (m.t === 'added') call(handlers.onAdded, m.id, !!m.ok);
    else if (m.t === 'checkpointed') { if (m.complete) call(handlers.onCheckpointed, m.id, m.seq); call(handlers.onCheckpoint, m); }
    else if (m.t === 'removed') { const r = waiting.get(m.n); if (r) { waiting.delete(m.n); r(true); } }
    else if (m.t === 'error') logger.debug({ plugin: m.id, err: m.error }, 'plugin checkpoint failed');
  });
  w.on('error', (err) => ended(w, (err && err.message) || 'error'));
  w.on('exit', () => ended(w, null));
  w.unref();
  worker = w;
  return w;
}

/** → true: asked the thread to serve the file (onAdded tells whether it does). */
function add(id, file, state) {
  const w = ensure();
  if (!w) return false;
  try { w.postMessage({ t: 'add', id, file, state }); } catch { return false; }
  return true;
}

/** The thread's connection to the file of `id` is closed (or the thread is gone) when this resolves. */
async function remove(id) {
  const w = worker;
  if (!w) return;
  const n = ++seq;
  const done = new Promise((resolve) => { waiting.set(n, resolve); });
  try { w.postMessage({ t: 'remove', id, n }); } catch { waiting.delete(n); return; }
  let timer;
  const ok = await Promise.race([done, new Promise((resolve) => { timer = setTimeout(() => resolve(null), REMOVE_MS); })]);
  clearTimeout(timer);
  if (ok === null && worker === w) {
    // busy with a checkpoint on a disk that does not answer: end it rather than keep a connection to a file
    // that is closed, replaced or deleted next (it ends once SQLite gives control back)
    waiting.delete(n);
    ended(w, 'no answer while closing a database');
    await w.terminate().catch(() => {});
  }
}

async function stop() {
  const w = worker;
  if (!w) return;
  worker = null;
  gate.clear(gate.PLUGINS);
  for (const resolve of waiting.values()) resolve(false);
  waiting.clear();
  const exited = new Promise((resolve) => { w.once('exit', resolve); });
  try { w.postMessage({ t: 'stop' }); } catch { /* gone */ }
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]);
  clearTimeout(timer);
  await w.terminate().catch(() => {});
}

module.exports = {
  enabled, add, remove, stop, handlers,
  running: () => !!worker,
  /** Tests: the thread's timing ({ everyMs, maxAgeMs, growBytes, gateWaitMs }), a checkpoint at once, no restart pause. */
  _setOptionsForTest: (o) => { options = o || {}; lostAt = 0; },
  _nowForTest: (id) => { if (worker) worker.postMessage({ t: 'now', id }); },
  _crashForTest: () => { if (worker) worker.postMessage({ t: 'crash' }); },
};
