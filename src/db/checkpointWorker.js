'use strict';

// WAL checkpoints of the host database in a worker thread (db/connection.js).
//
// SQLite copies the write-ahead log back into the database file when it
// holds 1000 pages (auto-checkpoint) — inside the COMMIT of whichever write
// comes then, with an fsync of the database file. On the main thread that is
// a pause of the event loop nobody can name: on a NAS with hard disks the
// fsync of a database of a few hundred MB takes seconds, and it happens in an
// ordinary request or job (seen: 360 ms for one UPDATE on an SSD).
//
// The main connection runs with wal_autocheckpoint = 0; this thread opens a
// second connection to the same file and runs PASSIVE checkpoints (they never
// wait for or block the writers). The main thread never fsyncs the database
// file then.
//
// When (since 1.254.0): every EVERY_MS it looks whether another connection
// committed (PRAGMA data_version, no I/O) and checkpoints once the oldest
// change not yet in the database file is MAX_AGE_MS old, or at once when the
// log grew GROW_BYTES past its size at the last checkpoint. Before, it
// checkpointed every 2 s — two fsyncs every 2 s on a server whose heartbeats
// write all the time, competing on a slow disk with every other write. With
// synchronous = NORMAL the log reaches the disk at a checkpoint: a power cut
// can lose up to MAX_AGE_MS of changes (the file stays consistent; a crash of
// the process loses nothing).

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');

const EVERY_MS = workerData.everyMs || 2000;
const MAX_AGE_MS = workerData.maxAgeMs || 30 * 1000;
const GROW_BYTES = 8 * 1024 * 1024;

let db = null;
try {
  db = new Database(workerData.file, { fileMustExist: true });
  db.pragma('busy_timeout = 1000');
} catch (e) {
  parentPort.postMessage({ t: 'failed', error: e.message });
  process.exit(0);
}

const walFile = workerData.file + '-wal';
function walBytes() {
  try { return fs.statSync(walFile).size; } catch { return 0; }
}

let busy = false;
let version = null;
let changedAt = null; // the oldest commit not yet checkpointed (Date.now()), null: none
let sizeAt = walBytes();

function checkpoint() {
  if (busy) return;
  busy = true;
  try {
    // → [{ busy, log, checkpointed }]
    const r = db.pragma('wal_checkpoint(PASSIVE)')[0] || {};
    // all of the log in the database file: nothing waits; else (a reader on an old snapshot) the next tick again
    if (r.checkpointed === r.log) changedAt = null;
    sizeAt = walBytes();
    parentPort.postMessage({ t: 'checkpoint', log: r.log, checkpointed: r.checkpointed, busy: r.busy });
  } catch (e) {
    parentPort.postMessage({ t: 'error', error: e.message });
  } finally {
    busy = false;
  }
}

function tick() {
  try {
    const v = db.pragma('data_version', { simple: true });
    if (version !== null && v !== version && changedAt === null) changedAt = Date.now();
    version = v;
  } catch (e) {
    parentPort.postMessage({ t: 'error', error: e.message });
    return;
  }
  if (changedAt === null) return;
  if (Date.now() - changedAt >= MAX_AGE_MS || walBytes() > sizeAt + GROW_BYTES) checkpoint();
}

// a log left from before this start (or written while the worker was loading) is checkpointed once
changedAt = walBytes() > 0 ? Date.now() - MAX_AGE_MS : null;
setInterval(tick, EVERY_MS);
parentPort.on('message', (m) => {
  if (m && m.t === 'now') checkpoint();
  if (m && m.t === 'stop') {
    try { db.close(); } catch { /* closing anyway */ }
    process.exit(0);
  }
});
parentPort.postMessage({ t: 'ready' });
