'use strict';

// Checkpoints of the plugin databases in one worker thread of the host
// (checkpointService.js), one database after the other.
//
// Before, every plugin database checkpointed in its own storage thread
// (dbWorker.js): when its log held 1000 pages — inside the COMMIT that reached
// them — and after 30 s without a call. On a disk with slow syncs (protocol of
// 13. 11.: 38 ms per sync, 26 a second) that showed as "slow plugin database
// statements" for one-row writes:
//   * the write that reached the 1000 pages paid two syncs and the copying;
//   * the first write after every checkpoint paid one (SQLite starts the log
//     anew and syncs its header) — measured: every time, 40 ms at 38 ms per sync;
//   * a call arriving during the quiet-time checkpoint waited for it;
//   * plugins written in the same tick checkpointed in the same moment: with
//     17 of them a read waited ~1 s, the next write of each 350–650 ms.
//
// Here a second connection per database runs PASSIVE checkpoints (never
// waiting for or blocking the plugin's statements). A database is due once
// its oldest change not yet in plugin.db is MAX_AGE_MS old, or at once when
// its log grew GROW_BYTES. Changes are seen in shared memory (the storage
// thread counts its writes there) — no statement, no I/O. After a complete
// checkpoint the storage thread is told (`checkpointed`): it starts the log
// anew itself between two calls (dbWorker.js restartLog), so the sync of the
// new header is not paid by the plugin's next write either.
//
// What a power cut can lose: before, the transactions since the last
// checkpoint — 30 s after the LAST write, with a plugin that never rests
// until its log held 1000 pages; now at most EVERY_MS + MAX_AGE_MS (27 s)
// after the FIRST write not yet in plugin.db, plus the checkpoints queued
// before it (or the 1000 pages, as before). Never a corrupt file.

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const gate = require('../../db/checkpointGate');

const EVERY_MS = workerData.everyMs || 2000;
const MAX_AGE_MS = workerData.maxAgeMs || 25 * 1000;
const GROW_BYTES = workerData.growBytes || 4 * 1024 * 1024;
// how long a checkpoint waits for a running one of another database before it runs anyway
const GATE_WAIT_MS = workerData.gateWaitMs || 5000;
const JOURNAL_SIZE_LIMIT = 4 * 1024 * 1024;

const dbs = new Map(); // id → { id, file, db, writes (Int32Array, shared), seen, changedAt, sizeAt }

function walBytes(file) {
  try { return fs.statSync(file + '-wal').size; } catch { return 0; }
}

function close(e) {
  try { if (e.db) e.db.close(); } catch { /* closing anyway */ }
  e.db = null;
}

function add({ id, file, state }) {
  const old = dbs.get(id);
  if (old) { close(old); dbs.delete(id); }
  let db = null;
  try {
    // timeout 0: this connection never waits for the plugin's statements
    db = new Database(file, { fileMustExist: true, timeout: 0 });
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') throw new Error('not in WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 0');
    db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
  } catch (err) {
    try { if (db) db.close(); } catch { /* ignore */ }
    parentPort.postMessage({ t: 'added', id, ok: false, error: String((err && err.message) || err) });
    return;
  }
  const writes = new Int32Array(state, 16, 1);
  const size = walBytes(file);
  dbs.set(id, {
    id, file, db, writes,
    // a log left from before (written while this thread did not serve the file): checkpointed once
    seen: size > 0 ? null : Atomics.load(writes, 0),
    changedAt: size > 0 ? Date.now() - MAX_AGE_MS : null,
    sizeAt: size,
  });
  parentPort.postMessage({ t: 'added', id, ok: true });
}

function checkpoint(e, held) {
  if (!e.db) return; // closed while it waited for the gate
  const began = Date.now();
  const seq = Atomics.load(e.writes, 0);
  let complete = false;
  try {
    // → [{ busy, log, checkpointed }]
    const r = e.db.pragma('wal_checkpoint(PASSIVE)')[0] || {};
    complete = r.busy === 0 && r.checkpointed === r.log;
    const size = walBytes(e.file);
    // as in db/checkpointWorker.js: a checkpoint that found no frame does not move the size a growth counts from
    e.sizeAt = r.log > 0 ? size : Math.min(e.sizeAt, size);
    if (complete) {
      e.seen = seq;
      // written while it ran: not in this checkpoint for sure — due again, counted from its start
      e.changedAt = Atomics.load(e.writes, 0) === seq ? null : began;
    }
    parentPort.postMessage({ t: 'checkpointed', id: e.id, seq, complete, log: r.log, at: began, ms: Date.now() - began });
  } catch (err) {
    parentPort.postMessage({ t: 'error', id: e.id, error: String((err && err.message) || err) });
  } finally {
    if (held) gate.release(workerData.gate, gate.PLUGINS);
  }
}

/**
 * Checkpoint `e` once the gate is free (one checkpoint at a time, db/checkpointGate.js), after GATE_WAIT_MS without
 * it. Waiting is a timer, not a blocked thread: a database that closes meanwhile is closed at once. `then()` after.
 */
function gated(e, then) {
  const end = Date.now() + GATE_WAIT_MS;
  const attempt = () => {
    const held = !!workerData.gate && gate.tryAcquire(workerData.gate, gate.PLUGINS);
    if (!held && workerData.gate && e.db && Date.now() < end) { setTimeout(attempt, 20); return; }
    try { checkpoint(e, held); } finally { then(); }
  };
  attempt();
}

function due(e, now) {
  if (!e.db) return false;
  if (e.changedAt === null && Atomics.load(e.writes, 0) !== e.seen) e.changedAt = now;
  if (e.changedAt === null) return false;
  return now - e.changedAt >= MAX_AGE_MS || walBytes(e.file) > e.sizeAt + GROW_BYTES;
}

// one database per turn of the loop, the oldest change first: a message (a database closing) is taken in between
let pumping = false;
function pump() {
  const now = Date.now();
  let next = null;
  for (const e of dbs.values()) if (due(e, now) && (!next || e.changedAt < next.changedAt)) next = e;
  if (!next) { pumping = false; return; }
  pumping = true;
  // not complete (the plugin holds a transaction open): again at the next tick, not in this round
  const before = next.changedAt;
  gated(next, () => {
    if (next.changedAt !== null && next.changedAt === before) next.changedAt = Math.max(before, Date.now() - MAX_AGE_MS + EVERY_MS);
    setImmediate(pump);
  });
}

setInterval(() => { if (!pumping) pump(); }, EVERY_MS);

parentPort.on('message', (m) => {
  if (!m) return;
  if (m.t === 'add') add(m);
  else if (m.t === 'remove') {
    const e = dbs.get(m.id);
    if (e) { close(e); dbs.delete(m.id); }
    parentPort.postMessage({ t: 'removed', id: m.id, n: m.n });
  } else if (m.t === 'now') { // tests: this database (or every one) at once
    for (const e of dbs.values()) if (e.db && (m.id == null || m.id === e.id)) checkpoint(e, false);
  } else if (m.t === 'crash') { // tests: the thread ends with an error
    throw new Error('crash (test)');
  } else if (m.t === 'stop') {
    for (const e of dbs.values()) close(e);
    process.exit(0);
  }
});
parentPort.postMessage({ t: 'ready' });
