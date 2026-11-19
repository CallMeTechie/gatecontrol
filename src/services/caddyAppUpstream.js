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

/**
 * How long the Node app keeps an idle keep-alive connection open
 * (server.keepAliveTimeout, set in server.js).
 *
 * Node's default is 5 s (+ keepAliveTimeoutBuffer 1 s). Caddy keeps idle
 * connections to an upstream for 2 minutes (reverse_proxy http transport,
 * keep_alive idle_timeout, default 2m), Playwright's request context
 * (page.request in the browser tests) without any limit. When Node closes an
 * idle connection in the very moment the client sends the next request on
 * it — likely when the server's event loop is busy and its idle timer fires
 * before it reads the waiting request — the client gets ECONNRESET /
 * "socket hang up"; Caddy retries that only for GET, a POST ends in 502.
 * The side that closes idle connections has to be the client: Node waits
 * longer than Caddy's 2 minutes.
 */
const APP_KEEP_ALIVE_MS = 130 * 1000;
const CADDY_UPSTREAM_IDLE_MS = 120 * 1000;
const APP_TRY_INTERVAL = '250ms';

function appUpstream(port = 3000) {
  return {
    upstreams: [{ dial: `127.0.0.1:${port}` }],
    load_balancing: { try_duration: APP_TRY_DURATION, try_interval: APP_TRY_INTERVAL },
  };
}

module.exports = { appUpstream, APP_TRY_DURATION, APP_TRY_INTERVAL, APP_KEEP_ALIVE_MS, CADDY_UPSTREAM_IDLE_MS };
