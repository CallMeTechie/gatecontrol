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
// wait for or block the writers) every EVERY_MS. The main thread never fsyncs
// the database file then.

const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');

const EVERY_MS = workerData.everyMs || 2000;

let db = null;
try {
  db = new Database(workerData.file, { fileMustExist: true });
  db.pragma('busy_timeout = 1000');
} catch (e) {
  parentPort.postMessage({ t: 'failed', error: e.message });
  process.exit(0);
}

let busy = false;
function checkpoint() {
  if (busy) return;
  busy = true;
  try {
    // → [{ busy, log, checkpointed }]
    const r = db.pragma('wal_checkpoint(PASSIVE)')[0] || {};
    parentPort.postMessage({ t: 'checkpoint', log: r.log, checkpointed: r.checkpointed, busy: r.busy });
  } catch (e) {
    parentPort.postMessage({ t: 'error', error: e.message });
  } finally {
    busy = false;
  }
}

setInterval(checkpoint, EVERY_MS);
parentPort.on('message', (m) => {
  if (m && m.t === 'now') checkpoint();
  if (m && m.t === 'stop') {
    try { db.close(); } catch { /* closing anyway */ }
    process.exit(0);
  }
});
parentPort.postMessage({ t: 'ready' });
