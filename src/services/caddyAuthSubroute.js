'use strict';

const { buildDefenderConfig } = require('./caddyValidators');
const { buildRequestHeadersHandler } = require('./caddyCustomHeaders');
const { buildRateLimitHandler } = require('./caddyRateLimit');
const { buildMirrorHandler } = require('./caddyMirror');

/**
 * Auth-subroute helpers for routes that delegate access checks to
 * GateControl's own /route-auth/verify endpoint (forward-auth pattern).
 *
 * Three building blocks:
 *
 *   1. buildRouteAuthProxy() — a sibling Caddy route that intercepts
 *      /route-auth/* URLs (login page + its static assets) and proxies
 *      them to the local Node app on 127.0.0.1:3000. Sibling, NOT a
 *      handler in the main chain — so the legacy upstream's own /css,
 *      /js, /fonts, /branding paths stay untouched and aren't 404'd
 *      by Node after login (Speedport, TR-064, old Synology panels).
 *
 *   2. buildForwardAuthSubrequest(domain) — the reverse_proxy handler
 *      that calls /route-auth/verify with X-Route-Domain etc., then
 *      either passes through (2xx via `vars` no-op) or 302-redirects
 *      to the login page (anything else).
 *
 *   3. buildAuthHandlerChain({ route, reverseProxy, customHeaders,
 *      mirrorTargets }) — assembles the full handler array for the
 *      auth-protected route in the documented order:
 *
 *        bot_blocker (unshift) → trace (unshift) → forward_auth →
 *        custom request headers → rate_limit → mirror → encode →
 *        reverseProxy
 */

function buildRouteAuthProxy() {
  return {
    match: [{ path: ['/route-auth/*'] }],
    handle: [{
      handler: 'reverse_proxy',
      upstreams: [{ dial: '127.0.0.1:3000' }],
    }],
  };
}

function buildForwardAuthSubrequest(domain) {
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial: '127.0.0.1:3000' }],
    rewrite: { method: 'GET', uri: '/route-auth/verify' },
    headers: {
      request: {
        set: {
          'X-Route-Domain': [domain],
          'X-Forwarded-Method': ['{http.request.method}'],
          'X-Forwarded-Uri': ['{http.request.uri}'],
        },
      },
    },
    handle_response: [
      {
        match: { status_code: [2] },
        routes: [{ handle: [{ handler: 'vars' }] }],
      },
      {
        routes: [{
          handle: [{
            handler: 'static_response',
            status_code: 302,
            headers: {
              'Location': [`/route-auth/login?route=${domain}&redirect={http.request.uri}`],
            },
          }],
        }],
      },
    ],
  };
}

function buildAuthHandlerChain({ route, reverseProxy, customHeaders, mirrorTargets }) {
  const handlers = [buildForwardAuthSubrequest(route.domain)];

  if (route.debug_enabled) {
    handlers.unshift({
      handler: 'trace',
      tag: `route-${route.id}`,
      response_debug_enabled: true,
    });
  }
  if (route.bot_blocker_enabled) {
    handlers.unshift(buildDefenderConfig(route));
  }
  if (customHeaders) {
    const reqHeaders = buildRequestHeadersHandler(customHeaders.request);
    if (reqHeaders) handlers.push(reqHeaders);
  }
  if (route.rate_limit_enabled) {
    handlers.push(buildRateLimitHandler(route));
  }
  if (mirrorTargets && Array.isArray(mirrorTargets) && mirrorTargets.length > 0) {
    handlers.push(buildMirrorHandler(mirrorTargets));
  }
  if (route.compress_enabled) {
    handlers.push({ handler: 'encode', encodings: { zstd: {}, brotli: {}, gzip: {} } });
  }

  handlers.push(reverseProxy);
  return handlers;
}

module.exports = {
  buildRouteAuthProxy,
  buildForwardAuthSubrequest,
  buildAuthHandlerChain,
};
