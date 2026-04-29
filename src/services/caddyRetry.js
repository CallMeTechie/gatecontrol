'use strict';

const { parseStatusCodes } = require('./caddyValidators');

/**
 * Mutate a Caddy reverse_proxy handler in-place to wire up the retry
 * configuration from a route row. No-op when retry_enabled is falsy.
 *
 * Caddy retries only within `try_duration` AND only for responses
 * matching `retry_match` (or connect errors by default). An earlier
 * version set `retries` alone, which Caddy silently ignored — so this
 * helper always sets all three fields (or skips entirely).
 *
 * try_duration scales with retry_count so that a slow upstream cannot
 * burn the whole budget in a few attempts: `max(5, retry_count*2)` s.
 */
function applyRetryConfig(reverseProxy, route) {
  if (!route.retry_enabled) return;
  if (!reverseProxy.load_balancing) reverseProxy.load_balancing = {};

  const retryCount = route.retry_count || 3;
  reverseProxy.load_balancing.retries = retryCount;
  reverseProxy.load_balancing.try_duration = `${Math.max(5, retryCount * 2)}s`;

  const codes = parseStatusCodes(route.retry_match_status);
  if (codes.length > 0) {
    reverseProxy.load_balancing.retry_match = [{ status_code: codes }];
  }
}

module.exports = { applyRetryConfig };
