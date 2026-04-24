'use strict';

/**
 * Periodic reconciliation between the DB's view of enabled HTTP routes
 * and Caddy's live config. The existing syncToCaddy path is atomic
 * (load+verify+rollback), but a handful of failure modes can still
 * leave the two diverged over time:
 *
 *   - POST /load succeeded but the server crashed before the app DB
 *     transaction committed (window: ~microseconds — but possible)
 *   - A manual operator edit via the Caddy admin API
 *   - An earlier migration that fell over with Caddy in a partial
 *     state, and the sync-on-success path was skipped
 *
 * Undetected divergence causes ghost routes ("enabled in DB, not
 * served by Caddy") or zombie routes ("served by Caddy, not in DB") —
 * both are silent until a user reports the symptom.
 *
 * This module compares the set of route @id markers:
 *   - Expected (from DB): "gc_route_<id>" for every enabled HTTP route
 *   - Actual (from Caddy): every @id attached to a route in the live
 *     srv0.routes array
 *
 * @id is the most robust comparison key — Caddy is free to reorder
 * JSON keys on each /load, but the @id values round-trip verbatim.
 *
 * Default posture: detection-only, logs a WARN on divergence. Auto
 * repair is opt-in via GC_CADDY_AUTO_RECONCILE=1. When enabled, the
 * reconciler calls syncToCaddy() to restore parity. Auto-repair is
 * risky — it will race a concurrent user edit — so it is off by
 * default and only intended for unattended production deployments
 * where ghost routes are more expensive than a rare race.
 */

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;  // every 5 minutes

let pollerInterval = null;

/**
 * Pure: given two Sets of route-ID strings, return the divergence
 * report. Exposed for direct unit testing.
 */
function detectDivergence(expected, actual) {
  const missingInCaddy = [];
  const extraInCaddy = [];
  for (const id of expected) {
    if (!actual.has(id)) missingInCaddy.push(id);
  }
  for (const id of actual) {
    if (!expected.has(id)) extraInCaddy.push(id);
  }
  return {
    diverged: missingInCaddy.length > 0 || extraInCaddy.length > 0,
    missingInCaddy,
    extraInCaddy,
  };
}

/**
 * Extract every route @id from Caddy's live /config/ response.
 * Caddy wraps routes under apps.http.servers[*].routes[].@id.
 * Null-safe against missing intermediate keys (fresh boot, empty
 * config, etc.).
 */
function extractCaddyRouteIds(caddyConfig) {
  const ids = new Set();
  const servers = caddyConfig && caddyConfig.apps
    && caddyConfig.apps.http && caddyConfig.apps.http.servers;
  if (!servers) return ids;
  for (const name of Object.keys(servers)) {
    const srv = servers[name];
    const routes = Array.isArray(srv.routes) ? srv.routes : [];
    for (const r of routes) {
      if (r['@id'] && typeof r['@id'] === 'string') ids.add(r['@id']);
    }
  }
  return ids;
}

/**
 * Run a single reconciliation cycle. Dependency-injected for tests.
 * @param {object} deps
 *   listDbRouteIds(): Set<string>              expected route @ids from DB
 *   getCaddyConfig(): Promise<object|null>     live Caddy /config/ or null
 *   syncToCaddy(): Promise<void>               recovery action
 *   autoRepair: boolean                        when true, runs syncToCaddy on divergence
 *   logger
 */
async function runReconciliationCycle(deps) {
  const { listDbRouteIds, getCaddyConfig, syncToCaddy, autoRepair, logger } = deps;

  const expected = listDbRouteIds();
  const caddyConfig = await getCaddyConfig();

  // Caddy unreachable — not a divergence, just skip this cycle.
  if (caddyConfig == null) {
    if (logger) logger.debug('Caddy admin API not reachable — skipping reconcile cycle');
    return { skipped: true };
  }

  const actual = extractCaddyRouteIds(caddyConfig);
  const divergence = detectDivergence(expected, actual);

  if (!divergence.diverged) {
    return { diverged: false, expected: expected.size, actual: actual.size };
  }

  if (logger) {
    logger.warn(
      {
        expected_count: expected.size,
        actual_count: actual.size,
        missing_in_caddy: divergence.missingInCaddy,
        extra_in_caddy: divergence.extraInCaddy,
        auto_repair: !!autoRepair,
      },
      'Caddy config diverged from DB'
    );
  }

  if (autoRepair && typeof syncToCaddy === 'function') {
    try {
      await syncToCaddy();
      if (logger) logger.info('Reconciler re-synced Caddy from DB');
      return { diverged: true, repaired: true, ...divergence };
    } catch (err) {
      if (logger) logger.error({ err: err.message }, 'Reconciler auto-repair failed');
      return { diverged: true, repaired: false, repairError: err.message, ...divergence };
    }
  }

  return { diverged: true, repaired: false, ...divergence };
}

function startReconciler(deps) {
  if (pollerInterval) return;
  const intervalMs = deps.intervalMs || RECONCILE_INTERVAL_MS;
  if (deps.logger) deps.logger.info({ intervalMs, autoRepair: !!deps.autoRepair }, 'Starting Caddy reconciler');
  pollerInterval = setInterval(() => {
    runReconciliationCycle(deps).catch(err => {
      if (deps.logger) deps.logger.error({ err: err.message }, 'Caddy reconciler cycle failed');
    });
  }, intervalMs);
  if (typeof pollerInterval.unref === 'function') pollerInterval.unref();
}

function stopReconciler() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}

module.exports = {
  detectDivergence,
  extractCaddyRouteIds,
  runReconciliationCycle,
  startReconciler,
  stopReconciler,
  RECONCILE_INTERVAL_MS,
};
