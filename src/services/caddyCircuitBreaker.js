'use strict';

/**
 * Build the Caddy static_response handler that fronts a route while its
 * circuit-breaker is open. Returns a 503 with a Retry-After header that
 * mirrors the configured timeout (defaulting to 30s when unset).
 */
function buildCircuitBreakerOpenHandler(timeoutSeconds) {
  return {
    handler: 'static_response',
    status_code: '503',
    body: 'Service temporarily unavailable',
    headers: { 'Retry-After': [String(timeoutSeconds || 30)] },
  };
}

module.exports = { buildCircuitBreakerOpenHandler };
