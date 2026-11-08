'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { precreatePrivateFile, restrictDbFiles } = require('../utils/fileModes');

let db = null;
let checkpointer = null;

/**
 * WAL checkpoints off the main thread (db/checkpointWorker.js): the main
 * connection stops checkpointing itself (wal_autocheckpoint = 0) once the
 * worker runs; should the worker fail, SQLite's automatic checkpoint is back.
 * GC_DB_CHECKPOINT=main keeps it on the main thread.
 */
function startCheckpointer(conn, dbPath) {
  if (dbPath === ':memory:' || dbPath.startsWith('file:') || String(process.env.GC_DB_CHECKPOINT || '').toLowerCase() === 'main') return;
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
  startCheckpointer(db, dbPath);

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
