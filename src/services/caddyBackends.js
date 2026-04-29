'use strict';

/**
 * Resolve a route's load-balanced backends from the JSON column
 * `route.backends` ([{ peer_id, port, weight? }, ...]) into the runtime
 * shape buildCaddyConfig wants ([{ ip, port, weight }, ...]).
 *
 * Returns:
 *   - `null` when route.backends is unset / invalid JSON / non-array
 *   - `[]` when every entry was rejected (no peer_id, peer missing
 *     from DB, or peer disabled)
 *   - the resolved array otherwise, preserving caller-supplied order
 *
 * `db` is a better-sqlite3 handle. The query is intentionally per-row
 * rather than batched; backend lists are tiny (low single digits in
 * practice) and N+1 prepared-statement calls are still fast on the
 * embedded DB.
 */
function resolveBackends(db, route) {
  if (!route.backends) return null;
  let raw;
  try {
    raw = JSON.parse(route.backends);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  return raw.map(b => {
    if (!b.peer_id) return null;
    const peer = db.prepare('SELECT allowed_ips, enabled FROM peers WHERE id = ?').get(b.peer_id);
    if (!peer || !peer.enabled) return null;
    return {
      ip: peer.allowed_ips.split('/')[0],
      port: b.port,
      weight: b.weight || 1,
    };
  }).filter(Boolean);
}

module.exports = { resolveBackends };
