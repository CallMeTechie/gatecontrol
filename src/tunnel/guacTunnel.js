'use strict';

// guacamole-lite WS tunnel for browser RDP/VNC/SSH (Phase 2a).
//
// Wiring strategy (verified live in the Task 0 spike against guacd 1.6.0 +
// guacamole-lite@1.2.0, see docs/superpowers/plans/_phase2a-spike-findings.md):
//
//   * guacamole-lite's own `processConnectionSettings` reject hook is UNUSABLE
//     as an auth gate: mergeConnectionOptions() strips jti/exp/meta before it
//     runs, and Server.newConnection still calls connect(guacd) even after a
//     cb(err). So we verify the token + run admission OURSELVES on the HTTP
//     `upgrade` event, BEFORE guacamole-lite ever touches guacd.
//   * guacamole-lite@1.2.0 has no clean `noServer`; ws only accepts noServer
//     when the wsOptions key `server` EXISTS — hence `{ server: undefined,
//     noServer: true, path }`.
//   * GC has no other WS/upgrade consumer (verified), so owning the upgrade
//     event for our PATH is safe; non-matching paths are left untouched.
//   * guacd target is ALWAYS the local sidecar 127.0.0.1:4822; the ROUTE
//     target lives inside the encrypted token settings (Task 6 resolver).

const url = require('node:url');
const GuacamoleLite = require('guacamole-lite');
const config = require('../../config/default');
const guacToken = require('../services/guacToken');
const { admitSession } = require('../services/guacSessions');
const rdpSessions = require('../services/rdpSessions');
const logger = require('../utils/logger');

const PATH = '/api/v1/client/rdp/guac-tunnel';

// Pure, unit-testable slice: verify token (jti/exp/nonce, single-use) + run
// admission. Returns { ok, connection } or { ok:false, reason }.
function evaluateConnection(tokenStr, { admit }) {
  const verified = guacToken.verifyAndConsume(tokenStr);
  if (!verified) return { ok: false, reason: 'invalid_token' };
  const decision = admit(verified.connection);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  return { ok: true, connection: verified.connection };
}

// A session is stale when its last heartbeat is older than the full
// heartbeat budget (heartbeatMs * heartbeatMisses). SQLite stores UTC as
// 'YYYY-MM-DD HH:MM:SS' (no tz), so we append 'Z' before parsing.
function isStale(session) {
  if (!session.last_heartbeat) return false;
  const last = Date.parse(session.last_heartbeat + 'Z');
  return Date.now() - last > config.guac.heartbeatMs * config.guac.heartbeatMisses;
}

function attachGuacTunnel(httpServer) {
  const guac = new GuacamoleLite(
    // 'server' key must EXIST (undefined ok) so ws accepts noServer; path is
    // passed through to ws but we route upgrades ourselves below.
    { server: undefined, noServer: true, path: PATH },
    { host: '127.0.0.1', port: 4822 },
    {
      crypt: { cypher: 'AES-256-CBC', key: guacToken.deriveKey() },
      log: { level: 'ERRORS' },
      // guacamole-lite's internal idle watchdog defaults to 10s — far too low
      // for an interactive browser session. Lift it to the configured idle TTL.
      maxInactivityTime: config.guac.idleTimeoutMs,
    }
  );

  // Authoritative admission at the tunnel: routeId/tokenId/peerId were embedded
  // in the encrypted token by the mint endpoint (Task 8); they live on the
  // connection (NOT in settings → guacd never sees them).
  const admit = (conn) => admitSession({
    routeId: conn.rdpRouteId,
    tokenId: conn.tokenId,
    peerId: conn.peerId,
    isStale,
  });

  // Intercept the HTTP upgrade ourselves so token verify + admission run
  // BEFORE guacamole-lite connects to guacd.
  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== PATH) return; // not ours — let any other consumer handle it

    const result = evaluateConnection(query.token, { admit });
    if (!result.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    guac.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      // Bridge the verified meta to the 'open' event (verified: cc.webSocket is
      // this same ws). clientIp is captured for session auditing.
      ws._guacMeta = { ...result.connection, clientIp: req.socket.remoteAddress };
      // Hand off to guacamole-lite's newConnection → guacd.
      guac.webSocketServer.emit('connection', ws, req);
    });
  });

  // Session lifecycle + WS heartbeat. The GuacamoleLite instance (extends
  // EventEmitter) emits open/close/error with the ClientConnection; cc.webSocket
  // is the ws we stashed meta on.
  guac.on('open', (cc) => {
    const m = (cc.webSocket && cc.webSocket._guacMeta) || {};
    const session = rdpSessions.startSession(m.rdpRouteId, {
      via: 'browser',
      protocol: m.protocol || (m.type === 'rdp' ? 'rdp' : m.type),
      tokenId: m.tokenId,
      tokenName: m.tokenName,
      peerId: m.peerId,
      clientIp: m.clientIp,
    });
    const ws = cc.webSocket;
    ws._guacSessionId = session.id;
    ws._missedPongs = 0;

    // Primary drop detector (spike C4): server pings; the browser ws auto-pongs;
    // a missing pong for `heartbeatMisses` cycles tears the session down.
    const hb = setInterval(() => {
      if (ws._missedPongs >= config.guac.heartbeatMisses) {
        try { cc.close(); } catch { /* already closing */ }
        try { ws.terminate(); } catch { /* already gone */ }
        return;
      }
      ws._missedPongs++;
      try { ws.ping(); } catch { /* socket gone — next close handler cleans up */ }
    }, config.guac.heartbeatMs);
    ws._guacHb = hb;

    ws.on('pong', () => {
      ws._missedPongs = 0;
      try { rdpSessions.heartbeatSession(session.id); } catch { /* ended already */ }
    });
  });

  guac.on('close', (cc) => {
    if (cc.webSocket && cc.webSocket._guacHb) clearInterval(cc.webSocket._guacHb);
    const sid = cc.webSocket && cc.webSocket._guacSessionId;
    if (sid) {
      try { rdpSessions.endSession(sid, 'normal'); } catch { /* already ended */ }
    }
  });

  guac.on('error', (cc, err) => logger.error({ err }, 'guac tunnel error'));

  logger.info({ path: PATH }, 'guac WS tunnel attached');
  return guac;
}

module.exports = { attachGuacTunnel, evaluateConnection, isStale };
