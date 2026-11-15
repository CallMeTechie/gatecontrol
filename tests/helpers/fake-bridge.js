'use strict';

// A stand-in for a bridge (mautrix bridgev2) for tests: the provisioning API
// v3 on a Unix socket, as far as GateControl uses it — whoami, login flows,
// the two WhatsApp ways in (pairing code by phone number, QR code), cancel
// and logout. No WhatsApp, no Matrix: the "phone" is the test, which confirms
// a waiting step with bridge.confirm(processId).
//
//   const bridge = await startFakeBridge({ socket, secret });
//   bridge.requests   every request { method, path, userId, auth, body }
//   bridge.logins     Map userId → [{ id, name, state_event, timestamp }]
//   bridge.confirm(processId)        the person confirmed on the phone
//   bridge.expire(processId)         the code ran out
//   bridge.logOut(userId, loginId)   the service dropped the linked device (BAD_CREDENTIALS)
//   bridge.oddStep = 'webauthn'      the next login starts with a step GateControl does not offer
//   bridge.numbers   Map '+49…' → { name, room } — who is "on WhatsApp" (resolve_identifier / create_dm, stage 4)
//   bridge.contacts  [{ number, name, lid?, avatar?, room?, chatRoom? }] — the contact store of the bridge (stage 4c:
//                    GET contacts, POST search_users; create_dm with a ghost's Matrix id). `room`: the room a chat
//                    with it gets; `chatRoom`: the room it has already (dm_room_mxid in the list)
//   await bridge.close()

const fs = require('node:fs');
const http = require('node:http');

const FLOWS = [
  { id: 'qr', name: 'QR', description: 'Scan a QR code from the app' },
  { id: 'phone', name: 'Pairing code', description: 'Enter a pairing code in the app' },
];

function startFakeBridge({ socket, secret }) {
  const state = { requests: [], logins: new Map(), processes: new Map(), oddStep: null, seq: 0, numbers: new Map(), contacts: [] };
  const send = (res, status, json) => { const b = JSON.stringify(json); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  const notFound = (res) => send(res, 404, { errcode: 'M_NOT_FOUND', error: 'Login process not found (internal detail)' });

  function complete(p) {
    const id = `login-${++state.seq}`;
    const list = state.logins.get(p.userId) || [];
    list.push({ id, name: p.phone || '+490000000', state_event: 'CONNECTED', timestamp: Date.now() });
    state.logins.set(p.userId, list);
    state.processes.delete(p.id);
    return { login_id: p.id, type: 'complete', step_id: 'fi.mau.whatsapp.login.complete', instructions: 'Successfully logged in', complete: { user_login_id: id } };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://bridge');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      const userId = url.searchParams.get('user_id');
      const auth = req.headers.authorization || '';
      state.requests.push({ method: req.method, path: url.pathname, userId, auth, body });
      if (auth !== `Bearer ${secret}`) return send(res, 401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid auth token' });
      if (!url.pathname.startsWith('/_matrix/provision/v3/')) return send(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'no such endpoint' });
      const seg = url.pathname.slice('/_matrix/provision/v3/'.length).split('/').map(decodeURIComponent);
      const m = req.method;

      if (m === 'GET' && seg.join('/') === 'whoami') {
        return send(res, 200, {
          network: { displayname: 'WhatsApp', network_id: 'whatsapp' }, login_flows: FLOWS, homeserver: 'gc.internal', bridge_bot: '@whatsappbot:gc.internal',
          management_room: '!secret:gc.internal',
          logins: (state.logins.get(userId) || []).map((l) => ({ id: l.id, name: l.name, profile: { phone: l.name }, space_room: '!space:gc.internal', state: { state_event: l.state_event, timestamp: l.timestamp, ...(l.error ? { error: l.error } : {}) } })),
        });
      }
      if (m === 'GET' && seg.join('/') === 'login/flows') return send(res, 200, { flows: FLOWS });
      // stage 4c: the contact store (startchat.go getContactList, provisionutil listcontacts.go) — as the real bridge
      // answers: the WhatsApp id, the number in identifiers, the ghost, the room of a chat that exists
      const contactOut = (c) => {
        const id = c.lid ? `lid-${c.lid}` : c.number.slice(1);
        return { id, name: c.name, ...(c.avatar ? { avatar_url: c.avatar } : {}), identifiers: [`tel:${c.number}`], mxid: `@whatsapp_${id}:gc.internal`, ...(c.chatRoom ? { dm_room_mxid: c.chatRoom } : {}) };
      };
      if (m === 'GET' && seg.join('/') === 'contacts') {
        if (!(state.logins.get(userId) || []).length) return send(res, 403, { errcode: 'M_FORBIDDEN', error: 'You must be logged in to list contacts' });
        return send(res, 200, { contacts: state.contacts.map(contactOut) });
      }
      if (m === 'POST' && seg.join('/') === 'search_users') {
        if (!(state.logins.get(userId) || []).length) return send(res, 403, { errcode: 'M_FORBIDDEN', error: 'You must be logged in to list contacts' });
        const q = String((body && body.query) || '').toLowerCase();
        return send(res, 200, { results: state.contacts.filter((c) => c.name.toLowerCase().includes(q) || c.number.includes(q)).map(contactOut) });
      }
      if (m === 'POST' && seg[0] === 'create_dm' && seg[1] && seg[1].startsWith('@whatsapp_')) {
        if (!(state.logins.get(userId) || []).length) return send(res, 400, { errcode: 'FI.MAU.NOT_LOGGED_IN', error: "You're not logged in" });
        const c = state.contacts.find((x) => contactOut(x).mxid === seg[1]);
        if (!c) return send(res, 404, { errcode: 'M_NOT_FOUND', error: 'Identifier not found' });
        const out = contactOut(c);
        return send(res, 201, { ...out, dm_room_mxid: c.chatRoom || c.room });
      }
      if ((m === 'GET' && seg[0] === 'resolve_identifier') || (m === 'POST' && seg[0] === 'create_dm')) {
        if (!(state.logins.get(userId) || []).length) return send(res, 400, { errcode: 'FI.MAU.NOT_LOGGED_IN', error: "You're not logged in" });
        const who = state.numbers.get(seg[1]);
        // the text of the real bridge names the number (startchat.go validateIdentifer)
        if (!who) return send(res, 404, { errcode: 'M_NOT_FOUND', error: `the server said ${seg[1]} is not on WhatsApp` });
        const jid = `${seg[1].slice(1)}@s.whatsapp.net`;
        return send(res, m === 'POST' ? 201 : 200, { id: jid, name: who.name, avatar_url: 'mxc://gc.internal/avatar', identifiers: [`tel:${seg[1]}`], mxid: `@whatsapp_${seg[1].slice(1)}:gc.internal`,
          ...(m === 'POST' ? { dm_room_mxid: who.room } : {}) });
      }
      if (m === 'POST' && seg[0] === 'login' && seg[1] === 'start' && seg.length === 3) {
        if (!FLOWS.some((f) => f.id === seg[2])) return send(res, 404, { errcode: 'M_NOT_FOUND', error: 'Unknown login flow' });
        const p = { id: `proc-${++state.seq}`, userId, flow: seg[2], phone: null, waiter: null };
        state.processes.set(p.id, p);
        if (state.oddStep) { const type = state.oddStep; state.oddStep = null; return send(res, 200, { login_id: p.id, type, step_id: 'fi.mau.whatsapp.login.' + type, [type]: {} }); }
        if (p.flow === 'phone') {
          return send(res, 200, { login_id: p.id, type: 'user_input', step_id: 'fi.mau.whatsapp.login.phone', instructions: 'Enter your phone number',
            user_input: { fields: [{ type: 'phone_number', id: 'phone_number', name: 'Phone number', description: 'Include the country code with a +', pattern: '^\\+[0-9]+$' }] } });
        }
        return send(res, 200, { login_id: p.id, type: 'display_and_wait', step_id: 'fi.mau.whatsapp.login.qr', instructions: 'Scan the QR code',
          display_and_wait: { type: 'qr', data: '2@fake-qr-payload,one,two,three', image_url: 'mxc://gc.internal/qr' } });
      }
      if (m === 'POST' && seg[0] === 'login' && seg[1] === 'step' && seg.length === 5) {
        const p = state.processes.get(seg[2]);
        if (!p || p.userId !== userId) return notFound(res);
        if (seg[4] === 'user_input') {
          if (!body || !/^\+[0-9]{6,15}$/.test(String(body.phone_number || ''))) return send(res, 400, { errcode: 'M_BAD_JSON', error: 'Invalid phone number +4915… (echoed input)' });
          p.phone = body.phone_number;
          return send(res, 200, { login_id: p.id, type: 'display_and_wait', step_id: 'fi.mau.whatsapp.login.pairing_code', instructions: 'Enter the code in the app',
            display_and_wait: { type: 'code', data: 'K7P2-M4X9' } });
        }
        if (seg[4] === 'display_and_wait') {
          // answers when the "phone" confirmed (bridge.confirm) or the code ran out (bridge.expire)
          p.waiter = (how) => {
            p.waiter = null;
            if (how === 'expire') { state.processes.delete(p.id); return send(res, 500, { errcode: 'FI.MAU.WHATSAPP.LOGIN_TIMEOUT', error: 'Entering code or scanning QR timed out' }); }
            return send(res, 200, complete(p));
          };
          if (p.early) { const how = p.early; p.early = null; p.waiter(how); }
          return undefined;
        }
        return send(res, 400, { errcode: 'M_BAD_JSON', error: 'Wrong step type' });
      }
      if (m === 'POST' && seg[0] === 'login' && seg[1] === 'cancel' && seg.length === 3) {
        const p = state.processes.get(seg[2]);
        if (!p || p.userId !== userId) return notFound(res);
        state.processes.delete(p.id);
        return send(res, 200, {});
      }
      if (m === 'POST' && seg[0] === 'logout' && seg.length === 2) {
        const list = state.logins.get(userId) || [];
        if (!list.some((l) => l.id === seg[1])) return send(res, 404, { errcode: 'M_NOT_FOUND', error: 'Login not found' });
        state.logins.set(userId, list.filter((l) => l.id !== seg[1]));
        return send(res, 200, {});
      }
      return send(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'no such endpoint' });
    });
  });

  const settle = (processId, how) => {
    const p = state.processes.get(processId);
    if (!p) throw new Error('fake bridge: unknown process ' + processId);
    if (p.waiter) p.waiter(how); else p.early = how;
  };

  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(socket); } catch { /* none yet */ }
    server.once('error', reject);
    server.listen(socket, () => resolve({
      requests: state.requests,
      logins: state.logins,
      processes: state.processes,
      numbers: state.numbers,
      get contacts() { return state.contacts; },
      set contacts(v) { state.contacts = v; },
      set oddStep(v) { state.oddStep = v; },
      confirm: (processId) => settle(processId, 'confirm'),
      expire: (processId) => settle(processId, 'expire'),
      logOut(userId, loginId) { const l = (state.logins.get(userId) || []).find((x) => x.id === loginId); if (l) { l.state_event = 'BAD_CREDENTIALS'; l.error = 'wa-logged-out'; l.timestamp = Date.now(); } },
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => { try { fs.unlinkSync(socket); } catch { /* gone */ } r(); }); }),
    }));
  });
}

module.exports = { startFakeBridge, FLOWS };
