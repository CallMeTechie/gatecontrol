'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const config = require('../../config/default');
const logger = require('../utils/logger');

let db = null;

function getDb() {
  if (db) return db;

  const dbPath = config.app.dbPath;
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
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
