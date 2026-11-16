'use strict';

// The WebSocket of the SSH terminal of gc.remote (stage 3, services/remote/term.js):
// /api/v1/remote/ssh-tunnel, protocol gc-term.v1. The token comes in the
// Sec-WebSocket-Protocol header ("gc-term.v1, token.<token>") — never in the
// address, so it lands in no access log. It is single-use and 60 s; the ticket
// behind it must still live and its plugin run with a licence. Registered with
// the shared upgrade dispatcher (tunnel/upgrade.js) like the other endpoints.

const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

const PATH = '/api/v1/remote/ssh-tunnel';

function refuse(socket, status) {
  try { socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  try { socket.destroy(); } catch { /* gone */ }
}

function attachTermTunnel(httpServer) {
  const term = require('../services/remote/term');
  const sessions = require('../services/remote/sessions');
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(term.PROTOCOL) ? term.PROTOCOL : false),
  });

  const onUpgrade = (req, socket, head) => {
    const entry = term.takeToken(term.tokenOfProtocols(req.headers['sec-websocket-protocol']));
    if (!entry) return refuse(socket, 401);
    const adm = sessions.admitTerm(entry);
    if (!adm.ok) return refuse(socket, adm.reason === 'plugin_unavailable' ? 503 : 401);
    wss.handleUpgrade(req, socket, head, (ws) => {
      term.run(ws, adm.ticket, { via: entry.via, clientIp: req.socket.remoteAddress || null }).catch((e) => {
        logger.warn({ err: e && e.message }, 'remote terminal session failed');
      });
    });
    return undefined;
  };
  require('./upgrade').register(httpServer, PATH, onUpgrade);
  logger.info({ path: PATH }, 'remote terminal WS attached');
  return wss;
}

module.exports = { attachTermTunnel, PATH };
