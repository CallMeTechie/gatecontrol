'use strict';

// A stand-in for the internal homeserver (Matrix client-server API v3 on a Unix
// socket, as far as GateControl uses it) and for its application-service
// sender: hs.push(…) delivers a transaction to the server's own socket the way
// Tuwunel does (PUT /_matrix/app/v1/transactions/{txnId}, hs_token as bearer
// AND as ?access_token=), through no relay.
//
//   const hs = await startFakeHomeserver({ socket, asToken, coreSocket, hsToken });
//   hs.requests                       every request { method, path, userId, auth, body }
//   hs.room(roomId, { state, timeline })   what GET …/state and …/messages answer
//   hs.down = true                    answers nothing (the socket is closed at once)
//   hs.refuseJoin = 'M_FORBIDDEN'     the next joins are refused
//   await hs.push(txnId, { events, ephemeral }, { token }) → { status, json }
//   await hs.close()

const fs = require('node:fs');
const http = require('node:http');

function startFakeHomeserver({ socket, asToken, coreSocket, hsToken }) {
  const state = { requests: [], rooms: new Map(), users: new Set(), down: false, refuseJoin: null, seq: 0, sent: [] };
  const send = (res, status, json) => { const b = JSON.stringify(json); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };

  const server = http.createServer((req, res) => {
    if (state.down) { req.socket.destroy(); return; }
    const url = new URL(req.url, 'http://hs');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      const userId = url.searchParams.get('user_id');
      const auth = req.headers.authorization || '';
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, userId, auth, body });
      if (auth !== `Bearer ${asToken}`) return send(res, 401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown access token' });
      if (!url.pathname.startsWith('/_matrix/client/v3/')) return send(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'no such endpoint' });
      const seg = url.pathname.slice('/_matrix/client/v3/'.length).split('/').map(decodeURIComponent);
      const m = req.method;
      if (m === 'POST' && seg[0] === 'register') {
        if (state.users.has(body.username)) return send(res, 400, { errcode: 'M_USER_IN_USE', error: 'taken' });
        state.users.add(body.username);
        return send(res, 200, { user_id: `@${body.username}:gc.internal` });
      }
      if (seg[0] !== 'rooms' || !seg[1]) return send(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'no such endpoint' });
      if (!/^@gc_\d+:gc\.internal$/.test(String(userId))) return send(res, 403, { errcode: 'M_EXCLUSIVE', error: 'User is not in namespace.' });
      const room = state.rooms.get(seg[1]);
      if (m === 'POST' && seg[2] === 'join') {
        if (state.refuseJoin) return send(res, 403, { errcode: state.refuseJoin, error: 'no' });
        if (!room) return send(res, 404, { errcode: 'M_NOT_FOUND', error: 'unknown room' });
        room.members.add(userId);
        return send(res, 200, { room_id: seg[1] });
      }
      if (!room || !room.members.has(userId)) return send(res, 403, { errcode: 'M_FORBIDDEN', error: 'not in the room' });
      if (m === 'GET' && seg[2] === 'state') return send(res, 200, room.state);
      if (m === 'GET' && seg[2] === 'messages') {
        const n = Number(url.searchParams.get('limit')) || 10;
        return send(res, 200, { chunk: room.timeline.slice(-n).reverse(), start: 't1', end: 't0' });
      }
      if (m === 'PUT' && seg[2] === 'send') {
        const key = `${userId}|${seg[4]}`;
        let id = room.txns.get(key);
        if (!id) { id = `$sent${++state.seq}`; room.txns.set(key, id); state.sent.push({ roomId: seg[1], userId, type: seg[3], txnId: seg[4], content: body, eventId: id }); }
        return send(res, 200, { event_id: id });
      }
      if (m === 'PUT' && seg[2] === 'redact') { state.sent.push({ roomId: seg[1], userId, type: 'redact', target: seg[3], txnId: seg[4] }); return send(res, 200, { event_id: `$red${++state.seq}` }); }
      if (m === 'POST' && seg[2] === 'receipt') { state.sent.push({ roomId: seg[1], userId, type: 'receipt', kind: seg[3], target: seg[4] }); return send(res, 200, {}); }
      if (m === 'PUT' && seg[2] === 'typing') { state.sent.push({ roomId: seg[1], userId, type: 'typing', who: seg[3], content: body }); return send(res, 200, {}); }
      return send(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'no such endpoint' });
    });
  });

  /** Deliver a transaction to the server, as the homeserver's sender does. */
  function push(txnId, body, { token = hsToken, method = 'PUT', path: p = null } = {}) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body || {}));
      const r = http.request({
        socketPath: coreSocket, agent: false, method,
        path: p || `/_matrix/app/v1/transactions/${encodeURIComponent(txnId)}?access_token=${encodeURIComponent(token || '')}`,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'Content-Length': data.length },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } resolve({ status: res.statusCode, json }); });
      });
      r.on('error', reject);
      r.end(data);
    });
  }

  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(socket); } catch { /* none */ }
    server.on('error', reject);
    server.listen(socket, () => resolve({
      requests: state.requests,
      sent: state.sent,
      rooms: state.rooms,
      set down(v) { state.down = !!v; },
      set refuseJoin(v) { state.refuseJoin = v; },
      room(roomId, { state: st = [], timeline = [], members = [] } = {}) {
        const r = { state: st, timeline, members: new Set(members), txns: new Map() };
        state.rooms.set(roomId, r);
        return r;
      },
      push,
      close: () => new Promise((done) => { server.close(() => done()); if (server.closeAllConnections) server.closeAllConnections(); }),
    }));
  });
}

module.exports = { startFakeHomeserver };
