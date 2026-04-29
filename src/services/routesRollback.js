'use strict';

/**
 * Rollback helpers for the routes service.
 *
 * routes CRUD operations follow a "DB write → syncToCaddy → if-sync-failed,
 * restore-DB-state" pattern. These helpers turn a captured row-snapshot back
 * into the live `routes` table after a sync failure, regardless of whether
 * the route was UPDATEd in place (restoreRow) or DELETEd (reinsertRow).
 *
 * The implementation reads the live `routes` schema via PRAGMA so a column
 * added by a future migration is preserved automatically — no need to keep
 * a column list in sync with the migrations folder.
 */

function getRouteColumns(db) {
  return db.prepare('PRAGMA table_info(routes)').all().map(c => c.name);
}

/**
 * Restore an UPDATEd route row from a snapshot (existing id stays valid).
 */
function restoreRouteRow(db, id, snapshot) {
  const cols = getRouteColumns(db).filter(c => c !== 'id');
  const sets = cols.map(c => `${c} = ?`).join(', ');
  const values = cols.map(c => snapshot[c] === undefined ? null : snapshot[c]);
  db.prepare(`UPDATE routes SET ${sets} WHERE id = ?`).run(...values, id);
}

/**
 * Re-insert a DELETEd route row, preserving its original id (the snapshot
 * captured the row BEFORE the DELETE).
 */
function reinsertRouteRow(db, row) {
  const cols = getRouteColumns(db);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(c => row[c] === undefined ? null : row[c]);
  db.prepare(`INSERT INTO routes (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
}

module.exports = {
  getRouteColumns,
  restoreRouteRow,
  reinsertRouteRow,
};
