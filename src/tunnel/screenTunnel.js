'use strict';

// The WebSocket of the screen relay of gc.remote (stage 5, services/remote/screen.js):
// /api/v1/remote/screen-relay, protocol gc-screen.v1. The token comes in the
// Sec-WebSocket-Protocol header ("gc-screen.v1, token.<token>") — never in the
// address, so it lands in no access log. It is single-use and 60 s and names
// its side (sender: the phone, viewer: the helper); the ticket behind it must
// still live and its plugin run with a licence. Registered with the shared
// upgrade dispatcher (tunnel/upgrade.js) like the other endpoints.

const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

const PATH = '/api/v1/remote/screen-relay';

function refuse(socket, status) {
  let text = 'Unauthorized';
  if (status === 429) text = 'Too Many Requests';
  else if (status === 503) text = 'Service Unavailable';
  try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  try { socket.destroy(); } catch { /* gone */ }
}

function attachScreenTunnel(httpServer) {
  const screen = require('../services/remote/screen');
  const sessions = require('../services/remote/sessions');
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: screen.MAX_FRAME,
    perMessageDeflate: false, // H.264 does not shrink; deflate would only cost the server CPU
    handleProtocols: (protocols) => (protocols.has(screen.PROTOCOL) ? screen.PROTOCOL : false),
  });

  const onUpgrade = (req, socket, head) => {
    const entry = screen.takeToken(screen.tokenOfProtocols(req.headers['sec-websocket-protocol']));
    if (!entry) return refuse(socket, 401);
    const adm = sessions.admitScreen(entry);
    if (!adm.ok) return refuse(socket, adm.reason === 'plugin_unavailable' ? 503 : (adm.reason === 'ticket_gone' ? 401 : 429));
    wss.handleUpgrade(req, socket, head, (ws) => {
      screen.run(ws, adm.ticket, entry, { clientIp: req.socket.remoteAddress || null }).catch((e) => {
        logger.warn({ err: e && e.message }, 'remote screen session failed');
      });
    });
    return undefined;
  };
  require('./upgrade').register(httpServer, PATH, onUpgrade);
  logger.info({ path: PATH }, 'remote screen relay WS attached');
  return wss;
}

module.exports = { attachScreenTunnel, PATH };
