'use strict';

const { isValidHeaderName, isValidHeaderValue } = require('./caddyValidators');

/**
 * Filter a [{ name, value }] list down to validated entries and shape
 * them into Caddy's `headers.set` map: `{ <name>: [<value>] }`.
 * Returns null when nothing valid survives the filter — callers can
 * short-circuit instead of pushing an empty handler.
 */
function buildHeaderSetMap(headerList) {
  if (!Array.isArray(headerList) || headerList.length === 0) return null;
  const set = {};
  for (const h of headerList) {
    if (h.name && h.value && isValidHeaderName(h.name) && isValidHeaderValue(h.value)) {
      set[h.name] = [h.value];
    }
  }
  return Object.keys(set).length > 0 ? set : null;
}

/**
 * Build a Caddy `headers` handler for request headers. Returns null
 * when there are no valid headers to set; callers should skip pushing
 * in that case to keep the handler chain free of no-ops.
 */
function buildRequestHeadersHandler(headerList) {
  const set = buildHeaderSetMap(headerList);
  if (!set) return null;
  return {
    handler: 'headers',
    request: { set },
  };
}

/**
 * Mutate a Caddy reverse_proxy handler in place to attach response
 * headers. MERGES into any existing `reverseProxy.headers` so a
 * gateway-routing block (which writes `headers.request.delete` and
 * `headers.request.set`) is preserved. The pre-fix version assigned
 * a fresh `{ response: { set } }` object, which clobbered that
 * request block whenever a route had both gateway routing and
 * response headers configured.
 */
function applyResponseHeaders(reverseProxy, headerList) {
  const set = buildHeaderSetMap(headerList);
  if (!set) return;
  reverseProxy.headers = reverseProxy.headers || {};
  reverseProxy.headers.response = reverseProxy.headers.response || {};
  reverseProxy.headers.response.set = set;
}

module.exports = {
  buildHeaderSetMap,
  buildRequestHeadersHandler,
  applyResponseHeaders,
};
