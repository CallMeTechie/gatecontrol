'use strict';

const { tableExists } = require('./migrationHelpers');
const { migrations } = require('./migrationList');

function bootstrapMigrationHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT
    );
  `);
}

/**
 * For databases created before migration_history existed, detect which
 * migrations are already applied by inspecting the schema. Returns a
 * Set of version numbers to mark as applied.
 */
function detectAppliedLegacyMigrations(db) {
  const applied = new Set();

  for (const migration of migrations) {
    if (migration.detect) {
      if (migration.detect(db)) {
        applied.add(migration.version);
      }
    } else {
      const tableMatches = [
        ...migration.sql.matchAll(
          /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi
        ),
      ];
      const indexMatches = [
        ...migration.sql.matchAll(
          /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi
        ),
      ];

      let allExist = true;
      const foundAny = tableMatches.length > 0 || indexMatches.length > 0;

      for (const match of tableMatches) {
        if (!tableExists(db, match[1])) {
          allExist = false;
          break;
        }
      }

      if (allExist) {
        for (const match of indexMatches) {
          const idx = db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
            )
            .get(match[1]);
          if (!idx) {
            allExist = false;
            break;
          }
        }
      }

      if (foundAny && allExist) {
        applied.add(migration.version);
      }
    }
  }

  return applied;
}

module.exports = { bootstrapMigrationHistory, detectAppliedLegacyMigrations };
