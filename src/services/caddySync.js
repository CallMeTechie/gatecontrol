'use strict';

// Coalesce rapid syncToCaddy() calls from parallel callers (monitor check
// cycles, the access reconciler, etc.). Without this a flapping upstream
// would trigger one Caddy admin-API POST /load per circuit-breaker state
// transition, and a batchSize=10 parallel check could push 10 syncs at once
// that racily overwrite each other's config. Shared so the reconciler +
// monitor + any future caller funnel through one coalesced entry point.
let pendingSync = null;
async function requestCaddySync() {
  if (pendingSync) return pendingSync;
  pendingSync = (async () => {
    // One tick to let a burst of near-simultaneous state changes land
    // before we actually POST /load once for all of them.
    await new Promise(r => setImmediate(r));
    try {
      const { syncToCaddy } = require('./routes');
      await syncToCaddy();
    } finally {
      pendingSync = null;
    }
  })();
  return pendingSync;
}

module.exports = { requestCaddySync };
