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
//   await bridge.close()

const fs = require('node:fs');
const http = require('node:http');

const FLOWS = [
  { id: 'qr', name: 'QR', description: 'Scan a QR code from the app' },
  { id: 'phone', name: 'Pairing code', description: 'Enter a pairing code in the app' },
];

function startFakeBridge({ socket, secret }) {
  const state = { requests: [], logins: new Map(), processes: new Map(), oddStep: null, seq: 0 };
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
      set oddStep(v) { state.oddStep = v; },
      confirm: (processId) => settle(processId, 'confirm'),
      expire: (processId) => settle(processId, 'expire'),
      logOut(userId, loginId) { const l = (state.logins.get(userId) || []).find((x) => x.id === loginId); if (l) { l.state_event = 'BAD_CREDENTIALS'; l.error = 'wa-logged-out'; l.timestamp = Date.now(); } },
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => { try { fs.unlinkSync(socket); } catch { /* gone */ } r(); }); }),
    }));
  });
}

module.exports = { startFakeBridge, FLOWS };
