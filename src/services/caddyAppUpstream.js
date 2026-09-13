'use strict';

/**
 * Upstream block for every reverse_proxy that targets the local Node app
 * (management UI, portal, route-auth pages, forward-auth subrequest).
 *
 * On a container (re)start — every update — Caddy is listening a few seconds
 * before Node is. Requests in that window used to fail at once with
 * "dial tcp 127.0.0.1:3000: connect: connection refused" → 502. With a
 * try_duration Caddy keeps re-dialing the app for up to APP_TRY_DURATION and
 * the request simply waits.
 *
 * Safe for every method: Caddy always retries when the CONNECTION failed
 * (nothing was sent yet). Once connected, retries are limited to GET (no
 * retry_match set), so a POST is never sent twice.
 */

const APP_TRY_DURATION = '10s';
const APP_TRY_INTERVAL = '250ms';

function appUpstream(port = 3000) {
  return {
    upstreams: [{ dial: `127.0.0.1:${port}` }],
    load_balancing: { try_duration: APP_TRY_DURATION, try_interval: APP_TRY_INTERVAL },
  };
}

module.exports = { appUpstream, APP_TRY_DURATION, APP_TRY_INTERVAL };
