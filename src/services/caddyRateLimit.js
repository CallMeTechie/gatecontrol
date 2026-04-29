'use strict';

const { sanitizeRateWindow } = require('./caddyValidators');

/**
 * Build the Caddy rate_limit handler config from a route row. Returned
 * as a plain object so callers can decide which handler chain to push
 * it into — buildCaddyConfig uses this twice: once for the public route
 * handlers and once inside the forward-auth subroute, with identical
 * shape.
 */
function buildRateLimitHandler(route) {
  return {
    handler: 'rate_limit',
    rate_limits: {
      static: {
        key: '{http.request.remote.host}',
        window: sanitizeRateWindow(route.rate_limit_window),
        max_events: route.rate_limit_requests || 100,
      },
    },
  };
}

module.exports = { buildRateLimitHandler };
