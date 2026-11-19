'use strict';

// A gateway on the SAME host as the server (docker-compose: both in
// network_mode: host, e.g. on one NAS).
//
// The TCP/UDP route of a gateway normally runs: Caddy (layer4) listens on
// `:<listen port>` (all addresses of the host) and dials
// `<gateway tunnel IP>:<listen port>`, where the gateway's TcpProxyManager
// listens and forwards to the LAN target. On a shared host that cannot work:
//
//   * the gateway's WireGuard interface (gatecontrol0) lives in the host's
//     network namespace, so its tunnel IP is an address of THIS host — the
//     packet never enters the tunnel, it is delivered locally;
//   * Caddy's wildcard listener already holds that port on every address, the
//     tunnel IP included. Caddy would dial ITSELF (a connection loop), and the
//     gateway's own bind on <tunnel IP>:<listen port> fails with EADDRINUSE
//     (the gateway page shows "port in use" — and any other listen port fails
//     the same way). Should the gateway win the race instead (Caddy restarts
//     after it), Caddy cannot load its config at all.
//
// The server shares the host network with that gateway, so it reaches the
// gateway's LAN target itself. For such a gateway Caddy dials the LAN target
// directly (caddyConfig) and the gateway gets no listener for these routes
// (gateways.getGatewayConfig).
//
// Recognised by the gateway's tunnel IP being an address of this host — only
// the gateway's own WireGuard interface carries it, so this does not match a
// gateway elsewhere (the server's wg0 holds only the server's tunnel IP). It
// is checked when the config is built (Caddy sync, config pull); while the
// gateway is down its interface is gone and the route is built the usual way.

const os = require('node:os');
const { isLoopbackHost } = require('../utils/validate');

// The server's own loopback-only services on this host: the app (GC_PORT, bound
// to 127.0.0.1 so only Caddy reaches it), Caddy's admin API, guacd and clamd
// (docker-compose.yml). A route never reaches them past Caddy.
function serverLoopbackPorts() {
  const config = require('../../config/default');
  const ports = new Set([2019, 3310, 4822]);
  const app = Number(config.app && config.app.port);
  if (Number.isInteger(app)) ports.add(app);
  try {
    const admin = new URL((config.caddy && config.caddy.adminUrl) || 'http://127.0.0.1:2019');
    if (admin.port) ports.add(Number(admin.port));
  } catch { /* invalid admin URL — 2019 stays */ }
  return ports;
}

// Injectable seam for the interface scan (os.networkInterfaces()), like
// services/homeNetwork.js.
let _interfaces = () => os.networkInterfaces();
function _setInterfacesForTest(fn) {
  if (process.env.NODE_ENV === 'test') _interfaces = fn || (() => os.networkInterfaces());
}

/** The addresses of this host's interfaces, lower-case (an empty set when the scan fails). */
function localAddresses() {
  const out = new Set();
  let ifs = {};
  try { ifs = _interfaces() || {}; } catch { return out; }
  for (const list of Object.values(ifs)) {
    for (const a of Array.isArray(list) ? list : []) {
      if (a && a.address) out.add(String(a.address).toLowerCase());
    }
  }
  return out;
}

/** "10.8.0.5/32" or "10.8.0.5" → "10.8.0.5" ('' when empty). */
function tunnelIpOf(allowedIps) {
  return String(allowedIps || '').split(',')[0].split('/')[0].trim().toLowerCase();
}

/**
 * Is a gateway with this tunnel IP (or allowed_ips) running on this host?
 * `addrs` lets a caller that checks several gateways scan the interfaces once.
 */
function isColocatedTunnelIp(ipOrAllowedIps, addrs) {
  const ip = tunnelIpOf(ipOrAllowedIps);
  if (!ip || isLoopbackHost(ip)) return false;
  return (addrs || localAddresses()).has(ip);
}

/**
 * Where Caddy dials a gateway's TCP/UDP route itself when that gateway
 * (`servingPeerId`) shares the host with the server: "<host>:<port>" of the
 * route's LAN target, or null when there is none to dial (the caller then
 * leaves the listener out — fail closed, never a self-dial).
 *
 * A loopback target means the host of the route's HOME gateway
 * (original_peer_id, else target_peer_id) — on this host only when the serving
 * gateway is the home; else the home gateway's LAN IP (`home_lan_ip`, joined
 * via original_peer_id), as in gateways.getGatewayConfig. A loopback target on
 * a port of a loopback-only service of the server (the app, Caddy's admin
 * API, guacd, clamd — serverLoopbackPorts) is never dialled from here.
 */
function directL4Target(route, servingPeerId) {
  if (!route) return null;
  const port = Number(route.target_lan_port || route.target_port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let host = String(route.target_lan_host || '').trim().replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (isLoopbackHost(host)) {
    const home = route.original_peer_id != null ? route.original_peer_id : route.target_peer_id;
    if (home != null && servingPeerId != null && Number(home) !== Number(servingPeerId)) {
      host = route.original_peer_id != null && route.home_lan_ip ? String(route.home_lan_ip).trim() : '';
      if (!host) return null;
    } else {
      if (serverLoopbackPorts().has(port)) return null;
      if (host.toLowerCase() === 'localhost') host = '127.0.0.1';
    }
  }
  return (host.includes(':') ? `[${host}]` : host) + ':' + port;
}

// What the last Caddy config built from the database assumed, per tunnel IP of
// a gateway with an active TCP/UDP route: on this host or not. The gateway's
// interface comes and goes with its container (server started first, gateway
// restarted) — its heartbeat then asks for a new Caddy config
// (gateways.handleHeartbeat → changedSinceBuild), so Caddy never keeps dialling
// its own listener.
let _built = new Map();
function noteBuilt(map) {
  _built = map instanceof Map ? map : new Map();
}
function changedSinceBuild(allowedIps) {
  const ip = tunnelIpOf(allowedIps);
  if (!ip || !_built.has(ip)) return false;
  return _built.get(ip) !== isColocatedTunnelIp(ip);
}

module.exports = {
  localAddresses,
  isColocatedTunnelIp,
  noteBuilt,
  changedSinceBuild,
  directL4Target,
  _setInterfacesForTest,
};
