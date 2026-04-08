'use strict';

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

// Ensure persistence columns exist (migration-safe)
try {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(routes)").all().map(c => c.name);
  if (!cols.includes('cb_failure_count')) {
    db.prepare('ALTER TABLE routes ADD COLUMN cb_failure_count INTEGER DEFAULT 0').run();
  }
  if (!cols.includes('cb_opened_at')) {
    db.prepare('ALTER TABLE routes ADD COLUMN cb_opened_at TEXT DEFAULT NULL').run();
  }
} catch { /* table may not exist yet during initial migration */ }

function getFailureCount(routeId) {
  try {
    const row = getDb().prepare('SELECT cb_failure_count FROM routes WHERE id = ?').get(routeId);
    return row?.cb_failure_count || 0;
  } catch { return 0; }
}

function setFailureCount(routeId, count) {
  try {
    getDb().prepare('UPDATE routes SET cb_failure_count = ? WHERE id = ?').run(count, routeId);
  } catch { /* ignore */ }
}

function getOpenedAt(routeId) {
  try {
    const row = getDb().prepare('SELECT cb_opened_at FROM routes WHERE id = ?').get(routeId);
    return row?.cb_opened_at ? new Date(row.cb_opened_at).getTime() : 0;
  } catch { return 0; }
}

function setOpenedAt(routeId, timestamp) {
  try {
    const val = timestamp ? new Date(timestamp).toISOString() : null;
    getDb().prepare('UPDATE routes SET cb_opened_at = ? WHERE id = ?').run(val, routeId);
  } catch { /* ignore */ }
}

/**
 * Called by monitoring service after each health check.
 * Implements circuit breaker state machine:
 *   closed  -> open      (after threshold consecutive failures)
 *   open    -> half-open  (after timeout expires)
 *   half-open -> closed   (on success)
 *   half-open -> open     (on failure)
 *
 * @param {number} routeId
 * @param {boolean} isHealthy - result of health check
 * @returns {{ statusChanged: boolean, newStatus: string }} or null if CB not enabled
 */
function checkAndUpdate(routeId, isHealthy) {
  const db = getDb();
  const route = db.prepare(
    'SELECT circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout, circuit_breaker_status FROM routes WHERE id = ?'
  ).get(routeId);

  if (!route || !route.circuit_breaker_enabled) return null;

  const threshold = route.circuit_breaker_threshold || 5;
  const timeout = route.circuit_breaker_timeout || 30;
  const currentStatus = route.circuit_breaker_status || 'closed';

  let newStatus = currentStatus;
  let statusChanged = false;

  if (currentStatus === 'closed') {
    if (isHealthy) {
      // Reset failure counter on success
      setFailureCount(routeId, 0);
    } else {
      const count = getFailureCount(routeId) + 1;
      setFailureCount(routeId, count);
      if (count >= threshold) {
        newStatus = 'open';
        statusChanged = true;
        setOpenedAt(routeId, Date.now());
        setFailureCount(routeId, 0);
        logger.warn({ routeId, failures: count, threshold }, 'Circuit breaker opened');
      }
    }
  } else if (currentStatus === 'open') {
    // Check if timeout has elapsed -> transition to half-open
    const openedAt = getOpenedAt(routeId);
    const elapsed = (Date.now() - openedAt) / 1000;
    if (elapsed >= timeout) {
      newStatus = 'half-open';
      statusChanged = true;
      logger.info({ routeId, elapsed, timeout }, 'Circuit breaker half-open');
    }
    // While open, ignore health check results (will be rechecked next cycle)
  } else if (currentStatus === 'half-open') {
    if (isHealthy) {
      newStatus = 'closed';
      statusChanged = true;
      setFailureCount(routeId, 0);
      setOpenedAt(routeId, null);
      logger.info({ routeId }, 'Circuit breaker closed (recovered)');
    } else {
      newStatus = 'open';
      statusChanged = true;
      setOpenedAt(routeId, Date.now());
      logger.warn({ routeId }, 'Circuit breaker re-opened from half-open');
    }
  }

  if (statusChanged) {
    db.prepare(
      "UPDATE routes SET circuit_breaker_status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(newStatus, routeId);
  }

  return { statusChanged, newStatus };
}

/**
 * Get current circuit breaker status for a route.
 */
function getStatus(routeId) {
  const db = getDb();
  const route = db.prepare(
    'SELECT circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout, circuit_breaker_status FROM routes WHERE id = ?'
  ).get(routeId);
  if (!route) return null;
  return {
    enabled: !!route.circuit_breaker_enabled,
    threshold: route.circuit_breaker_threshold,
    timeout: route.circuit_breaker_timeout,
    status: route.circuit_breaker_status || 'closed',
  };
}

/**
 * Reset circuit breaker status to 'closed' for a route.
 */
function resetStatus(routeId) {
  const db = getDb();
  db.prepare(
    "UPDATE routes SET circuit_breaker_status = 'closed', updated_at = datetime('now') WHERE id = ?"
  ).run(routeId);
  setFailureCount(routeId, 0);
  setOpenedAt(routeId, null);
}

/**
 * Check all open circuits for timeout -> half-open transitions.
 * Called periodically by the monitor.
 */
function checkTimeouts() {
  const db = getDb();
  const openRoutes = db.prepare(
    "SELECT id, circuit_breaker_timeout FROM routes WHERE circuit_breaker_enabled = 1 AND circuit_breaker_status = 'open'"
  ).all();

  for (const route of openRoutes) {
    const openedAt = getOpenedAt(route.id);
    if (!openedAt) {
      // No record of when it was opened (e.g. after restart), set to now
      setOpenedAt(route.id, Date.now());
      continue;
    }
    const elapsed = (Date.now() - openedAt) / 1000;
    const timeout = route.circuit_breaker_timeout || 30;
    if (elapsed >= timeout) {
      db.prepare(
        "UPDATE routes SET circuit_breaker_status = 'half-open', updated_at = datetime('now') WHERE id = ?"
      ).run(route.id);
      logger.info({ routeId: route.id }, 'Circuit breaker transitioned to half-open (timeout)');
    }
  }
}

module.exports = {
  checkAndUpdate,
  getStatus,
  resetStatus,
  checkTimeouts,
};
