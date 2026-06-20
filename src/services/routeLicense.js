// src/services/routeLicense.js
'use strict';
const { getDb } = require('../db/connection');
const { hasFeature, getFeatureLimit } = require('./license');

const httpRouteCount = () => getDb().prepare("SELECT COUNT(*) c FROM routes WHERE route_type = 'http' OR route_type IS NULL").get().c;
const l4RouteCount = () => getDb().prepare("SELECT COUNT(*) c FROM routes WHERE route_type = 'l4'").get().c;

// Pure verdict — no res writes. Both the bundle endpoint and the printer-preset
// endpoint build the descriptor from their own body and map the verdict.
function evaluateRouteLicense({ httpCount = 0, l4Count = 0, targetKind = 'peer', wol = false, scanEgress = false } = {}) {
  if (httpCount > 0) {
    const limit = getFeatureLimit('http_routes');
    if (limit === 0) return { ok: false, key: 'error.license.feature_not_available', extra: { feature: 'http_routes' } };
    if (limit !== -1 && httpRouteCount() + httpCount > limit) return { ok: false, key: 'error.license.limit_reached', extra: { feature: 'http_routes', current: httpRouteCount(), limit } };
  }
  if (l4Count > 0) {
    const limit = getFeatureLimit('l4_routes');
    if (limit === 0) return { ok: false, key: 'error.license.feature_not_available', extra: { feature: 'l4_routes' } };
    if (limit !== -1 && l4RouteCount() + l4Count > limit) return { ok: false, key: 'error.license.limit_reached', extra: { feature: 'l4_routes', current: l4RouteCount(), limit } };
    if (targetKind === 'gateway' && !hasFeature('gateway_tcp_routing')) return { ok: false, key: 'error.license.feature_not_available', extra: { feature: 'gateway_tcp_routing' } };
  }
  if (wol && !hasFeature('gateway_wol')) return { ok: false, key: 'error.license.feature_not_available', extra: { feature: 'gateway_wol' } };
  if (scanEgress && !hasFeature('gateway_scan_egress')) return { ok: false, key: 'error.license.feature_not_available', extra: { feature: 'gateway_scan_egress' } };
  return { ok: true };
}

module.exports = { evaluateRouteLicense };
