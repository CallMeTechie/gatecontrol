'use strict';

// One `upgrade` listener per HTTP server that hands each WebSocket upgrade to
// the handler of its path (exact pathname match). GateControl has more than
// one WebSocket endpoint:
//   * /api/v1/client/rdp/guac-tunnel  browser RDP/VNC/SSH (tunnel/guacTunnel.js)
//   * /api/v1/remote/guac-tunnel      sessions of gc.remote (same guacamole-lite server)
//   * /api/v1/gateway/edge/ws         edge channel of the gateways (services/edge/hub.js)
//   * /api/v1/remote/ssh-tunnel       the SSH terminal of gc.remote (tunnel/termTunnel.js, stage 3)
//   * /api/v1/remote/screen-relay     the screen relay of gc.remote (tunnel/screenTunnel.js, stage 5)
// Before this module each of them added its own `upgrade` listener and
// filtered by path; the behaviour is the same: a path nobody registered is
// left untouched (as before — no listener answered it), a handler that throws
// gets its socket destroyed and a log line.

const url = require('node:url');
const logger = require('../utils/logger');

const servers = new WeakMap(); // http.Server → Map<pathname, handler>

function pathnameOf(req) {
  try { return url.parse(req.url || '').pathname; } catch { return null; }
}

/**
 * Register `handler(req, socket, head)` for upgrades to exactly `pathname` on
 * `httpServer`. A second registration of the same path replaces the first
 * (an attach called twice, as tests do, must not answer twice).
 */
function register(httpServer, pathname, handler) {
  if (!httpServer || typeof httpServer.on !== 'function') throw new TypeError('upgrade.register: http server required');
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) throw new TypeError('upgrade.register: path required');
  if (typeof handler !== 'function') throw new TypeError('upgrade.register: handler required');
  let routes = servers.get(httpServer);
  if (!routes) {
    routes = new Map();
    servers.set(httpServer, routes);
    httpServer.on('upgrade', (req, socket, head) => dispatch(routes, req, socket, head));
  }
  routes.set(pathname, handler);
}

function dispatch(routes, req, socket, head) {
  const handler = routes.get(pathnameOf(req));
  if (!handler) return; // not ours — unchanged behaviour
  try {
    handler(req, socket, head);
  } catch (e) {
    logger.warn({ err: e && e.message, path: pathnameOf(req) }, 'websocket upgrade failed');
    try { socket.destroy(); } catch { /* gone */ }
  }
}

/** The registered paths of a server (tests, diagnostics). */
function paths(httpServer) {
  const routes = servers.get(httpServer);
  return routes ? [...routes.keys()] : [];
}

module.exports = { register, paths, pathnameOf };
