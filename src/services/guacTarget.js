'use strict';
const config = require('../../config/default');

function hubWgIp() {
  return (config.wireguard && config.wireguard.gatewayIp) || '10.8.0.1';
}

// Server-side guacd target (NOT resolveConnectEndpoint, which returns the public
// address for browser clients). guacd is a raw-TCP client (no TLS).
function resolveGuacTarget(route) {
  const mode = route.access_mode || 'internal';
  if (mode === 'external' && route.external_hostname) {
    return { host: route.external_hostname, port: route.external_port || route.port };
  }
  if (mode === 'gateway') {
    // Hit the existing raw-TCP L4 listener via the WG hub IP (passes the
    // internalOnlyRanges gate; 127.0.0.1 would be dropped — see spec §3).
    return { host: hubWgIp(), port: route.gateway_listen_port || route.port };
  }
  // internal / both → direct
  return { host: route.host, port: route.port };
}

module.exports = { resolveGuacTarget };
