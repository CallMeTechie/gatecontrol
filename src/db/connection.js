'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { precreatePrivateFile, restrictDbFiles } = require('../utils/fileModes');

let db = null;
let checkpointer = null;

// the worker starts this long after the database opened: a process that ends right after its start (a
// CLI script, a test file) must never exit while the worker is still loading better-sqlite3 — Node ends
// with "FATAL ERROR: Error::New napi_get_last_error_info" then (seen in CI, Node 24)
const CHECKPOINT_START_MS = 5000;
let checkpointTimer = null;

/** off: GC_DB_CHECKPOINT=main; in tests only with GC_DB_CHECKPOINT=worker (then at once). */
function checkpointMode() {
  const v = String(process.env.GC_DB_CHECKPOINT || '').toLowerCase();
  if (v === 'main') return null;
  if (v === 'worker') return 'now';
  return process.env.NODE_ENV === 'test' ? null : 'later';
}

/**
 * WAL checkpoints off the main thread (db/checkpointWorker.js): the main
 * connection stops checkpointing itself (wal_autocheckpoint = 0) once the
 * worker runs; should the worker fail, SQLite's automatic checkpoint is back.
 * GC_DB_CHECKPOINT=main keeps it on the main thread.
 */
function scheduleCheckpointer(conn, dbPath) {
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return;
  const mode = checkpointMode();
  if (!mode) return;
  if (mode === 'now') return startCheckpointer(conn, dbPath);
  checkpointTimer = setTimeout(() => { checkpointTimer = null; if (db === conn && conn.open) startCheckpointer(conn, dbPath); }, CHECKPOINT_START_MS);
  checkpointTimer.unref();
}

function startCheckpointer(conn, dbPath) {
  let w;
  try {
    const { Worker } = require('node:worker_threads');
    w = new Worker(path.join(__dirname, 'checkpointWorker.js'), { workerData: { file: dbPath } });
  } catch (err) {
    logger.warn({ err: err.message }, 'WAL checkpoint worker not started — checkpoints stay on the main thread');
    return;
  }
  const back = (why) => {
    if (checkpointer !== w) return;
    checkpointer = null;
    try { if (db === conn && conn.open) conn.pragma('wal_autocheckpoint = 1000'); } catch { /* closed */ }
    if (why) logger.warn({ err: why }, 'WAL checkpoint worker ended — checkpoints on the main thread again');
  };
  w.on('message', (m) => {
    if (!m) return;
    if (m.t === 'ready' && checkpointer === w) { try { conn.pragma('wal_autocheckpoint = 0'); } catch { /* closed */ } }
    if (m.t === 'failed') back(m.error);
  });
  w.on('error', (err) => back(err && err.message));
  w.on('exit', () => back(null));
  w.unref();
  checkpointer = w;
}

function stopCheckpointer() {
  if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
  const w = checkpointer;
  checkpointer = null;
  if (w) { try { w.postMessage({ t: 'stop' }); } catch { /* gone */ } w.terminate().catch(() => {}); }
}

function getDb() {
  if (db) return db;

  const dbPath = config.app.dbPath;
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Owner-only modes (0600) for the DB, its -wal/-shm and copies of it: it
  // holds password/token hashes and sessions and lives on a host bind mount.
  // A fresh DB is pre-created with 0600 (SQLite would use 0644), existing
  // files from older versions are tightened; SQLite then creates -wal/-shm
  // with the DB file's mode. Best-effort — never blocks opening the DB.
  if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    try {
      precreatePrivateFile(dbPath);
      const changed = restrictDbFiles(dbPath);
      if (changed.length) logger.info({ files: changed }, 'Restricted database file permissions to owner-only');
    } catch (err) {
      logger.warn({ err: err.message }, 'Could not restrict database file permissions');
    }
  }

  db = new Database(dbPath);

  // Performance & safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  scheduleCheckpointer(db, dbPath);

  logger.info({ path: dbPath }, 'Database connected');

  return db;
}

function closeDb() {
  if (db) {
    stopCheckpointer();
    // Flush WAL into the main DB file so a later restore/copy sees a
    // consistent snapshot without needing SQLite to replay a leftover
    // -wal/-shm pair. TRUNCATE shrinks the WAL file back to zero,
    // which matters for backup tooling that copies /data verbatim.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (err) {
      logger.warn({ err: err.message }, 'wal_checkpoint failed on shutdown');
    }
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

module.exports = { getDb, closeDb, _checkpointer: () => checkpointer };
