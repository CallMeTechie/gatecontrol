'use strict';

const logger = require('../utils/logger');

/**
 * Run an async sync action (typically syncToCaddy) and revert the DB
 * to a known-good state if it fails.
 *
 * The five route-mutation paths (create, update, remove, toggle, batch)
 * all follow the same shape:
 *
 *   1. mutate the DB (insert / update / delete / set enabled flag)
 *   2. await syncToCaddy() — push the new config to the local Caddy
 *   3. on failure: run a path-specific rollback that puts the DB row
 *      back the way it was, then re-throw the original sync error so
 *      the API caller sees "sync failed", not "rollback succeeded".
 *
 * Rollback failures are LOGGED but do NOT replace the sync error in
 * the propagation chain — the caller cares about the sync failure;
 * the rollback failure is a secondary inconsistency for ops to
 * investigate.
 *
 * `syncFn` is passed as an argument (rather than imported from
 * ./caddyConfig directly) to keep this helper trivially testable
 * with fake functions and no module mocking.
 */
async function withCaddySync(syncFn, rollback, label = 'route mutation') {
  try {
    await syncFn();
  } catch (err) {
    try {
      await rollback(err);
    } catch (rbErr) {
      logger.error(
        { err: rbErr.message, label, syncErr: err.message },
        'Rollback failed after Caddy sync error — DB may be inconsistent with Caddy',
      );
    }
    throw err;
  }
}

module.exports = { withCaddySync };
