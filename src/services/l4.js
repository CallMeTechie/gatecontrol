'use strict';

const { parsePortRange, isPortBlocked } = require('../utils/validate');

// Lazy: keeps requiring this module free of config/db side effects (it is
// also consumed by pure-validation unit tests without an app environment).
function getDb() {
  return require('../db/connection').getDb();
}

function buildL4Servers(routes, internalOnlyRanges) {
  if (!routes || routes.length === 0) return {};

  const groups = {};
  for (const route of routes) {
    const key = route.l4_protocol + '|' + route.l4_listen_port + '|' + route.l4_tls_mode;
    if (!groups[key]) groups[key] = [];
    groups[key].push(route);
  }

  const servers = {};
  for (const [key, groupRoutes] of Object.entries(groups)) {
    const { l4_protocol, l4_listen_port, l4_tls_mode } = groupRoutes[0];
    const useTls = l4_tls_mode !== 'none';
    const portLabel = l4_listen_port;
    const serverName = useTls
      ? 'l4-tls-' + portLabel
      : 'l4-' + l4_protocol + '-' + portLabel;

    const listenPrefix = l4_protocol === 'udp' ? 'udp' : 'tcp';
    const server = {
      listen: [listenPrefix + '/:' + l4_listen_port],
      routes: groupRoutes.map(function(r) { return buildL4Route(r, l4_tls_mode, internalOnlyRanges); }),
    };

    servers[serverName] = server;
  }

  return servers;
}

// caddy-l4's proxy handler accepts multiple upstreams + a load_balancing
// block similar to (but smaller than) http/reverse_proxy. Supported policies:
// `random`, `round_robin`, `least_conn`, `first`, `ip_hash`. We map the
// HTTP-side names through directly — the pool's lb_policy strings
// (`round_robin` / `least_conn` / `ip_hash`) are all valid here.
function buildL4Route(route, tlsMode, internalOnlyRanges) {
  const target = route.target_ip + ':' + route.target_port;
  const upstreams = (Array.isArray(route._poolUpstreams) && route._poolUpstreams.length > 0)
    ? route._poolUpstreams.map(addr => ({ dial: [addr] }))
    : [{ dial: [target] }];

  const proxyHandler = { handler: 'proxy', upstreams };
  if (route._poolLbPolicy && upstreams.length > 1) {
    proxyHandler.load_balancing = {
      selection_policy: { policy: route._poolLbPolicy },
    };
    // Health checks: caddy-l4 supports passive 'unhealthy' tracking via
    // fail_duration + max_fails on the proxy handler. Same intent as
    // http/health_checks/passive — drop a backend after N consecutive
    // dial failures, retry it after fail_duration.
    proxyHandler.health_checks = {
      passive: {
        fail_duration: '30s',
        max_fails: 3,
      },
    };
  }

  const caddyRoute = {};

  if (tlsMode === 'none') {
    caddyRoute.handle = [proxyHandler];
  } else if (tlsMode === 'passthrough') {
    caddyRoute.match = [{ tls: { sni: [route.domain] } }];
    caddyRoute.handle = [proxyHandler];
  } else if (tlsMode === 'terminate') {
    caddyRoute.match = [{ tls: { sni: [route.domain] } }];
    caddyRoute.handle = [
      { handler: 'tls' },
      proxyHandler,
    ];
  }

  // External-exposure gate (L4): an internal-only route (external_enabled=0)
  // is served ONLY to VPN source IPs. Fold remote_ip into the route's match
  // set (AND with any tls.sni). remote_ip = real connection IP, never
  // client_ip — not header-spoofable. caddy-l4 drops a non-matching
  // connection (no handler runs). Mirrors the HTTP gate. Ranges are passed in
  // (l4.js stays config-free for pure-validation tests).
  if (!route.external_enabled && Array.isArray(internalOnlyRanges) && internalOnlyRanges.length > 0) {
    if (!caddyRoute.match) caddyRoute.match = [{}];
    caddyRoute.match[0].remote_ip = { ranges: internalOnlyRanges };
  }

  return caddyRoute;
}

function validatePortConflicts(routes) {
  const errors = [];

  // Check blocked ports
  for (const route of routes) {
    const range = parsePortRange(route.l4_listen_port);
    if (!range) continue;
    for (let p = range.start; p <= range.end; p++) {
      if (isPortBlocked(p)) {
        errors.push('Port ' + p + ' is reserved (route ID ' + route.id + ')');
      }
    }
  }

  // Group by protocol
  const byProtocol = {};
  for (const route of routes) {
    const proto = route.l4_protocol;
    if (!byProtocol[proto]) byProtocol[proto] = [];
    byProtocol[proto].push(route);
  }

  for (const [proto, protoRoutes] of Object.entries(byProtocol)) {
    // Check duplicate no-TLS routes on same port
    const noTlsPorts = {};
    for (const route of protoRoutes) {
      if (route.l4_tls_mode !== 'none') continue;
      const key = route.l4_listen_port;
      if (noTlsPorts[key]) {
        errors.push('Duplicate ' + proto + ' port ' + key + ' without TLS (routes ' + noTlsPorts[key] + ' and ' + route.id + ')');
      } else {
        noTlsPorts[key] = route.id;
      }
    }

    // Check overlapping ranges
    const ranges = protoRoutes
      .map(r => {
        const parsed = parsePortRange(r.l4_listen_port);
        return parsed ? { id: r.id, start: parsed.start, end: parsed.end, tlsMode: r.l4_tls_mode, listenPort: r.l4_listen_port } : null;
      })
      .filter(Boolean);

    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i];
        const b = ranges[j];
        if (a.listenPort === b.listenPort && a.tlsMode !== 'none' && b.tlsMode !== 'none') continue;
        if (a.start <= b.end && b.start <= a.end) {
          if (a.listenPort !== b.listenPort) {
            errors.push('Overlapping ' + proto + ' port ranges: ' + a.listenPort + ' and ' + b.listenPort + ' (routes ' + a.id + ' and ' + b.id + ')');
          }
        }
      }
    }
  }

  return errors;
}

// Returns the id of an *enabled* L4 route already occupying the given listen
// port without TLS — the only conflict class for plain port-forwards (TLS
// routes multiplex via SNI, see validatePortConflicts). null = free.
// excludeRouteIds lets an update ignore the caller's own L4 rows.
function findListenPortConflict(listenPort, { protocol = 'tcp', excludeRouteIds = [] } = {}) {
  const db = getDb();
  const exclude = excludeRouteIds.filter((id) => id != null);
  const placeholders = exclude.length ? exclude.map(() => '?').join(',') : '-1';
  const row = db.prepare(
    `SELECT id FROM routes
       WHERE route_type = 'l4'
         AND l4_protocol = ?
         AND l4_tls_mode = 'none'
         AND l4_listen_port = ?
         AND enabled = 1
         AND id NOT IN (${placeholders})`
  ).get(protocol, String(listenPort), ...(exclude.length ? exclude : []));
  return row ? row.id : null;
}

// Next free listen port above startPort not used by an enabled no-TLS L4
// route of the same protocol and not reserved. null if none within a sane
// window. Single ports only — for ranges callers get no suggestion.
function suggestFreeListenPort(startPort, { protocol = 'tcp', excludeRouteIds = [] } = {}) {
  const db = getDb();
  const exclude = excludeRouteIds.filter((id) => id != null);
  const placeholders = exclude.length ? exclude.map(() => '?').join(',') : '-1';
  const used = new Set(
    db.prepare(
      `SELECT l4_listen_port FROM routes
         WHERE route_type = 'l4' AND l4_protocol = ? AND l4_tls_mode = 'none'
           AND enabled = 1 AND id NOT IN (${placeholders})`
    ).all(protocol, ...(exclude.length ? exclude : []))
      .map(r => parseInt(r.l4_listen_port, 10))
  );
  const begin = Math.max(1, parseInt(startPort, 10) || 3389);
  for (let p = begin + 1; p <= 65535 && p <= begin + 2000; p++) {
    if (!used.has(p) && !isPortBlocked(p)) return p;
  }
  return null;
}

// Throw a structured 409 if a no-TLS listen port collides with an existing
// enabled L4 listener. Centralised so all orchestrators (RDP links, service
// bundles) surface the same machine-readable shape to the route layer.
function assertListenPortFree(listenPort, { protocol = 'tcp', excludeRouteIds = [], code = 'GATEWAY_PORT_CONFLICT' } = {}) {
  const conflictRouteId = findListenPortConflict(listenPort, { protocol, excludeRouteIds });
  if (conflictRouteId == null) return;
  const suggestedPort = suggestFreeListenPort(listenPort, { protocol, excludeRouteIds });
  const err = new Error(
    `Listen port ${listenPort} is already in use by another route`
    + (suggestedPort ? ` — next free port: ${suggestedPort}` : '')
  );
  err.code = code;
  err.statusCode = 409;
  err.conflict = { port: parseInt(listenPort, 10), conflictRouteId, suggestedPort };
  throw err;
}

module.exports = {
  buildL4Servers,
  buildL4Route,
  validatePortConflicts,
  findListenPortConflict,
  suggestFreeListenPort,
  assertListenPortFree,
};
