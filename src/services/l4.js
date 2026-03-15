'use strict';

const { parsePortRange, isPortBlocked } = require('../utils/validate');

function buildL4Servers(routes) {
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
      routes: groupRoutes.map(function(r) { return buildL4Route(r, l4_tls_mode); }),
    };

    servers[serverName] = server;
  }

  return servers;
}

function buildL4Route(route, tlsMode) {
  const target = route.target_ip + ':' + route.target_port;
  const proxyHandler = {
    handler: 'proxy',
    upstreams: [{ dial: target }],
  };

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

module.exports = { buildL4Servers, buildL4Route, validatePortConflicts };
