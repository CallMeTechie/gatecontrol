'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const config = require('../../config/default');
const logger = require('../utils/logger');
const { precreatePrivateFile, restrictDbFiles } = require('../utils/fileModes');

let db = null;

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

  logger.info({ path: dbPath }, 'Database connected');

  return db;
}

function closeDb() {
  if (db) {
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

module.exports = { getDb, closeDb };
