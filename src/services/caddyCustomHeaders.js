'use strict';

const { isValidHeaderName, isValidHeaderValue, isHeaderDeletion, expandHeaderValue } = require('./caddyValidators');

/**
 * Filter a [{ name, value }] list down to validated entries and shape
 * them into Caddy's `headers.set` map: `{ <name>: [<value>] }`.
 * Returns null when nothing valid survives the filter — callers can
 * short-circuit instead of pushing an empty handler.
 *
 * Names with a leading '-' are removals (see buildHeaderDeleteList) and never
 * end up here. Allowed short placeholders ({host}, {remote_host}, {scheme})
 * are written in their long JSON form; any other {...} drops the header.
 */
function buildHeaderSetMap(headerList) {
  if (!Array.isArray(headerList) || headerList.length === 0) return null;
  const set = {};
  for (const h of headerList) {
    if (!h || typeof h.name !== 'string' || h.name.startsWith('-')) continue;
    if (h.name && h.value && isValidHeaderName(h.name) && isValidHeaderValue(h.value)) {
      set[h.name] = [expandHeaderValue(h.value)];
    }
  }
  return Object.keys(set).length > 0 ? set : null;
}

/**
 * Header names to remove: entries named '-Name' (Caddyfile `header -Name`).
 * The value is ignored. Returns null when there is nothing to remove.
 */
function buildHeaderDeleteList(headerList) {
  if (!Array.isArray(headerList) || headerList.length === 0) return null;
  const out = [];
  for (const h of headerList) {
    if (!h || !isHeaderDeletion(h.name)) continue;
    const name = h.name.slice(1);
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.length > 0 ? out : null;
}

/**
 * Build a Caddy `headers` handler for request headers (set and remove).
 * Returns null when there is nothing to do; callers should skip pushing
 * in that case to keep the handler chain free of no-ops.
 */
function buildRequestHeadersHandler(headerList) {
  const set = buildHeaderSetMap(headerList);
  const del = buildHeaderDeleteList(headerList);
  if (!set && !del) return null;
  const request = {};
  if (set) request.set = set;
  if (del) request.delete = del;
  return { handler: 'headers', request };
}

/**
 * Response header removals as their own deferred `headers` handler, placed
 * before reverse_proxy: deferred operations run when the response is
 * written, so they also catch headers Caddy adds itself (Server) and the
 * ones the backend sends (X-Powered-By). null when nothing is removed.
 */
function buildResponseDeleteHandler(headerList) {
  const del = buildHeaderDeleteList(headerList);
  if (!del) return null;
  return { handler: 'headers', response: { delete: del, deferred: true } };
}

/**
 * Every custom-header handler that goes in front of reverse_proxy, in order:
 * request headers, then response removals. `customHeaders` is the parsed
 * route.custom_headers object ({ request, response }).
 */
function buildCustomHeaderHandlers(customHeaders) {
  if (!customHeaders || typeof customHeaders !== 'object') return [];
  return [
    buildRequestHeadersHandler(customHeaders.request),
    buildResponseDeleteHandler(customHeaders.response),
  ].filter(Boolean);
}

/**
 * Mutate a Caddy reverse_proxy handler in place to attach response
 * headers. MERGES into any existing `reverseProxy.headers` so a
 * gateway-routing block (which writes `headers.request.delete` and
 * `headers.request.set`) is preserved. The pre-fix version assigned
 * a fresh `{ response: { set } }` object, which clobbered that
 * request block whenever a route had both gateway routing and
 * response headers configured.
 *
 * Also merges into an existing `headers.response.set` (later calls win
 * per header name) so the HSTS switch can be applied after the custom
 * headers without dropping them (docs/feature-hsts.md).
 */
function applyResponseHeaders(reverseProxy, headerList) {
  const set = buildHeaderSetMap(headerList);
  if (!set) return;
  reverseProxy.headers = reverseProxy.headers || {};
  reverseProxy.headers.response = reverseProxy.headers.response || {};
  reverseProxy.headers.response.set = { ...(reverseProxy.headers.response.set || {}), ...set };
}

module.exports = {
  buildHeaderSetMap,
  buildHeaderDeleteList,
  buildRequestHeadersHandler,
  buildResponseDeleteHandler,
  buildCustomHeaderHandlers,
  applyResponseHeaders,
};
