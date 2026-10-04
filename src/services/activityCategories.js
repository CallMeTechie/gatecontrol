'use strict';

// Categories of the dashboard's activity feed (filter chips "Anmeldungen",
// "Peers & Gateways", "Weiterleitungen", "Sicherheit"). A category is an
// allow-listed set of activity_log.event_type PREFIXES — the API never takes
// a prefix from the request, only one of these names.
//
// The browser classifies live events (SSE `activity`) with the same table:
// public/js/dashboard-ui.js carries a copy, tests/dashboard_ui.test.js keeps
// the two identical.

const CATEGORIES = Object.freeze({
  login: Object.freeze(['login', 'logout', 'passkey_login', 'account_']),
  peer: Object.freeze(['peer_', 'gateway_', 'client_', 'pool_', 'wg_']),
  route: Object.freeze(['route_', 'routes_', 'host_', 'service_bundle_', 'domain_', 'rdp_route_', 'share_', 'circuit_breaker_']),
  security: Object.freeze(['waf_', 'tls_', 'security_', 'passkey_added', 'passkey_removed', 'password_changed',
    'user_2fa_', 'token_', 'machine_binding_']),
});

const NAMES = Object.freeze(Object.keys(CATEGORIES));

/** event_type → category name, or 'system' when no prefix matches. */
function categoryOf(eventType) {
  const t = String(eventType || '');
  for (const name of NAMES) {
    if (CATEGORIES[name].some((p) => t.startsWith(p))) return name;
  }
  return 'system';
}

function isCategory(name) { return NAMES.includes(name); }

/** LIKE pattern for a prefix: `_` and `%` are literal (ESCAPE '\'). */
function likePrefix(prefix) {
  return prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/**
 * SQL condition + args selecting one category, e.g.
 * { sql: "(event_type LIKE ? ESCAPE '\\' OR …)", args: ['login%', …] }.
 * Throws on an unknown name — callers validate with isCategory() first.
 */
function sqlFilter(name) {
  if (!isCategory(name)) throw new Error('unknown activity category');
  const prefixes = CATEGORIES[name];
  return {
    sql: '(' + prefixes.map(() => "event_type LIKE ? ESCAPE '\\'").join(' OR ') + ')',
    args: prefixes.map(likePrefix),
  };
}

module.exports = { CATEGORIES, NAMES, categoryOf, isCategory, sqlFilter, likePrefix };
