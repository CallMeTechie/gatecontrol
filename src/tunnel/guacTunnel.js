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
//     noServer: true }`. NO `path`: ws checks it in handleUpgrade
//     (shouldHandle) and aborts every other path with a bare 400 — no log, no
//     guacd — which broke every session of gc.remote on REMOTE_PATH. The
//     dispatcher below already routes by exact pathname.
//   * GC has more than one WebSocket endpoint (this tunnel, the sessions of
//     gc.remote on REMOTE_PATH, the edge channel of the gateways in
//     services/edge/hub.js). Each registers its path with the shared upgrade
//     dispatcher (tunnel/upgrade.js), which hands an upgrade to exactly one
//     handler by pathname; other paths are left untouched.
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
// Sessions of gc.remote (services/remote/sessions.js) — the same guacamole-lite
// server and token format; the token carries remoteRef instead of rdpRouteId.
const REMOTE_PATH = '/api/v1/remote/guac-tunnel';

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

// The image types guacd may send: guacamole-lite announces only png + jpeg, guacd 1.6 (its image
// is built with libwebp) encodes WebP too — smaller than PNG at the same picture, decoded by every
// current browser through Guacamole.Client's <img>. A guacd without libwebp ignores the type.
const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
const connectionDefaultSettings = Object.fromEntries(
  ['rdp', 'vnc', 'ssh', 'telnet', 'join'].map((t) => [t, { image: [...IMAGE_TYPES] }])
);

// Once guacd is connected: (1) no Nagle on the socket to guacd — mouse and key events are tiny
// writes and would otherwise wait for the ACK of the previous one (up to the delayed-ACK time);
// (2) one WebSocket message per batch of instructions instead of one per instruction — guacamole-
// lite forwards every parsed instruction on its own (img, blob, end, sync … of a single frame).
// The batch is what one read from guacd held: it goes out in the microtask after the read, so
// nothing waits. Guacamole.WebSocketTunnel reads any number of whole instructions per message.
function tuneConnection(cc) {
  const g = cc && cc.guacdClient;
  if (!g) return;
  const sock = g.guacdConnection;
  if (sock && typeof sock.setNoDelay === 'function') { try { sock.setNoDelay(true); } catch { /* closed */ } }
  if (typeof cc.send !== 'function' || typeof g.on !== 'function') return;
  g.removeAllListeners('data');
  let pending = '';
  g.on('data', (data) => {
    if (pending === '') {
      queueMicrotask(() => { const out = pending; pending = ''; if (out) cc.send(out); });
    }
    pending += data;
  });
}

function attachGuacTunnel(httpServer) {
  const guac = new GuacamoleLite(
    // 'server' key must EXIST (undefined ok) so ws accepts noServer; no path
    // (see above): we route upgrades ourselves below, for PATH and REMOTE_PATH.
    { server: undefined, noServer: true },
    { host: '127.0.0.1', port: 4822 },
    {
      crypt: { cypher: 'AES-256-CBC', key: guacToken.deriveKey() },
      log: { level: 'ERRORS' },
      // guacamole-lite's internal idle watchdog defaults to 10s — far too low
      // for an interactive browser session. Lift it to the configured idle TTL.
      maxInactivityTime: config.guac.idleTimeoutMs,
      connectionDefaultSettings, // + image/webp (IMAGE_TYPES)
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
  // A token of a gc.remote session only opens REMOTE_PATH, an old one only PATH.
  const remoteSessions = () => require('../services/remote/sessions');
  const admitRemote = (conn) => remoteSessions().admitTunnel(conn);

  // Intercept the HTTP upgrade ourselves so token verify + admission run
  // BEFORE guacamole-lite connects to guacd.
  const onUpgrade = (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    const remote = pathname === REMOTE_PATH;
    if (pathname !== PATH && !remote) return; // not ours — let any other consumer handle it

    const result = evaluateConnection(query.token, {
      admit: (conn) => {
        if (remote !== (typeof conn.remoteRef === 'string')) return { ok: false, reason: 'wrong_path' };
        return remote ? admitRemote(conn) : admit(conn);
      },
    });
    if (!result.ok) {
      // the browser only sees a closed WebSocket (and reconnects): the reason is in the log — never the token or the ref
      logger.warn({ reason: result.reason, path: remote ? 'remote' : 'rdp' }, 'guac tunnel refused');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // ws answers a handshake it cannot accept (wrong path, bad headers) with a
    // bare 4xx and destroys the socket without a word: log it — never the
    // token or the ref — so a refusal of ws is never silent again.
    const where = remote ? 'remote' : 'rdp';
    if (!guac.webSocketServer.shouldHandle(req)) {
      logger.warn({ path: where, reason: 'path_not_handled' }, 'guac tunnel handshake aborted');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    let handedOver = false;
    socket.once('close', () => {
      if (!handedOver) logger.warn({ path: where, reason: 'handshake_failed' }, 'guac tunnel handshake aborted');
    });
    guac.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      handedOver = true;
      // Bridge the verified meta to the 'open' event (verified: cc.webSocket is
      // this same ws). clientIp is captured for session auditing.
      ws._guacMeta = { ...result.connection, clientIp: req.socket.remoteAddress };
      // Hand off to guacamole-lite's newConnection → guacd.
      guac.webSocketServer.emit('connection', ws, req);
    });
  };
  const upgrade = require('./upgrade');
  upgrade.register(httpServer, PATH, onUpgrade);
  upgrade.register(httpServer, REMOTE_PATH, onUpgrade);

  // Session lifecycle + WS heartbeat. The GuacamoleLite instance (extends
  // EventEmitter) emits open/close/error with the ClientConnection; cc.webSocket
  // is the ws we stashed meta on.
  guac.on('open', (cc) => {
    tuneConnection(cc);
    const m = (cc.webSocket && cc.webSocket._guacMeta) || {};
    if (typeof m.remoteRef === 'string') { openRemote(cc, m); return; }
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
        clearInterval(hb);
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

  // A gc.remote session: a row of remote_sessions, the same heartbeat; the
  // plugin can end it (gc.remote.end), its hook `remoteSession` hears of it.
  function openRemote(cc, m) {
    const ws = cc.webSocket;
    let sid;
    try {
      sid = remoteSessions().opened(m, {
        clientIp: m.clientIp,
        close: () => { ws._remoteEnded = true; try { cc.close(); } catch { /* closing */ } try { ws.terminate(); } catch { /* gone */ } },
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'remote session could not start');
      try { cc.close(); } catch { /* closing */ }
      return;
    }
    ws._remoteSessionId = sid;
    ws._missedPongs = 0;
    const hb = setInterval(() => {
      if (ws._missedPongs >= config.guac.heartbeatMisses) {
        ws._remoteDropped = true;
        try { cc.close(); } catch { /* already closing */ }
        try { ws.terminate(); } catch { /* already gone */ }
        clearInterval(hb);
        return;
      }
      ws._missedPongs++;
      try { ws.ping(); } catch { /* socket gone */ }
    }, config.guac.heartbeatMs);
    ws._guacHb = hb;
    ws.on('pong', () => { ws._missedPongs = 0; remoteSessions().heartbeat(sid); });
  }

  guac.on('close', (cc, err) => {
    if (cc.webSocket && cc.webSocket._guacHb) clearInterval(cc.webSocket._guacHb);
    // guacd not reachable / refused before the session opened: guacamole-lite only writes to stdout
    if (err && !(cc.webSocket && (cc.webSocket._remoteSessionId || cc.webSocket._guacSessionId))) {
      logger.warn({ err: String(err.message || err).slice(0, 200), code: err.code || null }, 'guac tunnel closed before guacd connected');
    }
    const rid = cc.webSocket && cc.webSocket._remoteSessionId;
    if (rid) {
      // ended by the plugin: already recorded; a lost heartbeat is an abort
      if (!cc.webSocket._remoteEnded) { try { remoteSessions().end(rid, cc.webSocket._remoteDropped ? 'heartbeat' : 'normal'); } catch { /* ended */ } }
      return;
    }
    const sid = cc.webSocket && cc.webSocket._guacSessionId;
    if (sid) {
      try { rdpSessions.endSession(sid, 'normal'); } catch { /* already ended */ }
    }
  });

  guac.on('error', (cc, err) => logger.error({ err }, 'guac tunnel error'));

  logger.info({ path: PATH, remotePath: REMOTE_PATH }, 'guac WS tunnel attached');
  return guac;
}

module.exports = { attachGuacTunnel, evaluateConnection, isStale, tuneConnection, IMAGE_TYPES, PATH, REMOTE_PATH };
