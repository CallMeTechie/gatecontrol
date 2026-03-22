'use strict';

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

// In-memory consecutive failure counters per route
const failureCounters = new Map();

// Track when circuit was opened (for timeout/half-open logic)
const circuitOpenedAt = new Map();

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
      failureCounters.set(routeId, 0);
    } else {
      const count = (failureCounters.get(routeId) || 0) + 1;
      failureCounters.set(routeId, count);
      if (count >= threshold) {
        newStatus = 'open';
        statusChanged = true;
        circuitOpenedAt.set(routeId, Date.now());
        failureCounters.set(routeId, 0);
        logger.warn({ routeId, failures: count, threshold }, 'Circuit breaker opened');
      }
    }
  } else if (currentStatus === 'open') {
    // Check if timeout has elapsed -> transition to half-open
    const openedAt = circuitOpenedAt.get(routeId) || 0;
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
      failureCounters.set(routeId, 0);
      circuitOpenedAt.delete(routeId);
      logger.info({ routeId }, 'Circuit breaker closed (recovered)');
    } else {
      newStatus = 'open';
      statusChanged = true;
      circuitOpenedAt.set(routeId, Date.now());
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
  failureCounters.delete(routeId);
  circuitOpenedAt.delete(routeId);
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
    const openedAt = circuitOpenedAt.get(route.id);
    if (!openedAt) {
      // No record of when it was opened (e.g. after restart), set to now
      circuitOpenedAt.set(route.id, Date.now());
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
