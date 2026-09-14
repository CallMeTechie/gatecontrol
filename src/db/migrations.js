'use strict';

const { getDb } = require('./connection');
const logger = require('../utils/logger');
const { tableExists, computeChecksum } = require('./migrationHelpers');
const { migrations } = require('./migrationList');
const { bootstrapMigrationHistory, detectAppliedLegacyMigrations } = require('./migrationLegacy');
const { snapshotBeforeMigrations } = require('./preMigrationBackup');

function runMigrations() {
  const db = getDb();

  bootstrapMigrationHistory(db);

  const recorded = new Set(
    db
      .prepare('SELECT version FROM migration_history ORDER BY version')
      .all()
      .map((r) => r.version)
  );

  // Legacy DB (no migration_history but schema present): record what
  // was already applied before switching to this system.
  const isLegacyDb = recorded.size === 0 && tableExists(db, 'users');
  const isFreshDb = recorded.size === 0 && !isLegacyDb;

  let legacyApplied = new Set();
  if (isLegacyDb) {
    logger.info(
      'Detected existing database without migration history, scanning schema...'
    );
    legacyApplied = detectAppliedLegacyMigrations(db); // read-only
  }

  const pending = migrations
    .filter((m) => !recorded.has(m.version) && !legacyApplied.has(m.version))
    .sort((a, b) => a.version - b.version);

  // Pre-migration snapshot (docs/feature-release-b.md §4) BEFORE the first
  // write (legacy bookkeeping included). A fresh, empty database has nothing
  // to protect. Throws — and thereby aborts the start — when the copy fails.
  if (pending.length > 0 && !isFreshDb) {
    const known = [...recorded, ...legacyApplied];
    snapshotBeforeMigrations(db, {
      dbPath: db.name,
      fromVersion: known.length ? Math.max(...known) : 0,
      toVersion: pending[pending.length - 1].version,
      logger,
    });
  }

  if (isLegacyDb) {
    if (legacyApplied.size > 0) {
      const insert = db.prepare(
        'INSERT INTO migration_history (version, name, checksum) VALUES (?, ?, ?)'
      );
      const recordLegacy = db.transaction(() => {
        for (const migration of migrations) {
          if (legacyApplied.has(migration.version)) {
            insert.run(
              migration.version,
              migration.name,
              computeChecksum(migration.sql)
            );
          }
        }
      });
      recordLegacy();
      logger.info(
        { count: legacyApplied.size },
        'Recorded pre-existing migrations in migration_history'
      );
      for (const v of legacyApplied) {
        recorded.add(v);
      }
    }
  }

  if (pending.length === 0) {
    logger.info('All database migrations are up to date');
    return;
  }

  // Each migration runs in its OWN transaction. A combined transaction
  // made debugging impossible: any failure rolled back all prior
  // migrations, so the admin saw the DB revert to pre-upgrade and
  // rerunning hit the same failing step without partial progress.
  // Per-step commit preserves progress up to failure.
  logger.info({ count: pending.length }, 'Running pending database migrations');

  const insert = db.prepare(
    'INSERT INTO migration_history (version, name, checksum) VALUES (?, ?, ?)'
  );
  const runSql = (sql) => db.exec(sql);

  let applied = 0;
  for (const migration of pending) {
    logger.info(
      { version: migration.version, name: migration.name },
      'Applying migration'
    );
    const apply = db.transaction(() => {
      runSql(migration.sql);
      insert.run(
        migration.version,
        migration.name,
        computeChecksum(migration.sql)
      );
    });
    try {
      apply();
      applied++;
    } catch (err) {
      logger.error(
        { version: migration.version, name: migration.name, err: err.message },
        'Migration failed — stopping at this version'
      );
      throw err;
    }
  }

  logger.info({ applied }, 'Database migrations completed');
}

module.exports = { runMigrations };
