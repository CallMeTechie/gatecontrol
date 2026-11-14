'use strict';

// The provisioning API of a bridge (mautrix bridgev2, "Megabridge provisioning"
// v3: /_matrix/provision/v3/…), spoken over the bridge's Unix socket in
// /data/bridges/run/<network>.sock. Authentication: the shared secret as a
// bearer token, the person as ?user_id=<their internal Matrix id>.
//
// Nothing of what the bridge answers is passed on as it is: steps, logins and
// errors are reduced to the fields of docs/feature-messenger-bridges.md, with
// lengths and charsets checked. Raw error texts of the bridge stay in the log.

const http = require('node:http');
const path = require('node:path');

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 20000;
// display_and_wait answers when the person scanned the code — or after the bridge's own timeout
const WAIT_TIMEOUT_MS = 180000;
const ID_RE = /^[A-Za-z0-9._:=+-]{1,128}$/;
const STEP_TYPES = ['display_and_wait', 'user_input', 'complete'];
const FIELD_TYPES = ['username', 'phone_number', 'email', 'password', '2fa_code', 'token', 'url', 'domain', 'select'];
const DISPLAY_TYPES = ['qr', 'emoji', 'code', 'nothing'];
const STATES = { CONNECTED: 'connected', CONNECTING: 'connecting', TRANSIENT_DISCONNECT: 'connecting', BAD_CREDENTIALS: 'logged_out', UNKNOWN_ERROR: 'error' };

class BridgeError extends Error {
  constructor(code, message, reason) { super(message || code); this.code = code; if (reason) this.reason = reason; }
}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
/** A reason as the plugin runtime passes it on: [a-z][a-z0-9_]{0,39} (FI.MAU.WHATSAPP.LOGIN_TIMEOUT → fi_mau_whatsapp_login_timeout). */
function reasonWord(v) {
  const w = String(v || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  return /^[a-z]/.test(w) ? w : 'bridge_error';
}
function word(v) { return typeof v === 'string' ? v.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) : ''; }

/**
 * One request to a bridge. → the parsed JSON answer.
 * @param {{socket:string, secret:string}} target
 * @param {{method:string, path:string, mxid:string, body?:object, timeoutMs?:number}} req
 */
function request(target, req) {
  return new Promise((resolve, reject) => {
    const body = req.body === undefined ? null : Buffer.from(JSON.stringify(req.body));
    const r = http.request({
      socketPath: target.socket,
      agent: false, // one connection per request: a restarted bridge must not meet a kept-alive socket
      method: req.method,
      path: `/_matrix/provision/v3/${req.path}?user_id=${encodeURIComponent(req.mxid)}`,
      headers: {
        Authorization: `Bearer ${target.secret}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
      },
      timeout: req.timeoutMs || TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { r.destroy(new BridgeError('ERR_BRIDGE', 'answer of the bridge too large', 'too_large')); return; }
        chunks.push(c);
      });
      res.on('error', (e) => reject(new BridgeError('ERR_BRIDGE_UNREACHABLE', e.message)));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (json === null || typeof json !== 'object') return reject(new BridgeError('ERR_BRIDGE', 'answer of the bridge is not JSON', 'bad_answer'));
          return resolve(json);
        }
        // the bridge's errcode (M_NOT_FOUND, FI.MAU.…) as the reason, its text only as this error's message (log)
        const errcode = json && word(json.errcode);
        const reason = res.statusCode === 404 ? 'not_found' : (res.statusCode === 401 || res.statusCode === 403 ? 'refused' : (errcode || `http_${res.statusCode}`));
        reject(new BridgeError('ERR_BRIDGE', `bridge answered ${res.statusCode}${json && json.error ? ': ' + str(json.error, 200) : ''}`, reasonWord(reason)));
      });
    });
    r.on('timeout', () => r.destroy(new BridgeError('ERR_BRIDGE_UNREACHABLE', 'the bridge did not answer in time', 'timeout')));
    r.on('error', (e) => reject(e instanceof BridgeError ? e : new BridgeError('ERR_BRIDGE_UNREACHABLE', e.message, e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not_running' : 'unreachable')));
    if (body) r.write(body);
    r.end();
  });
}

/** A login step of the bridge → { processId, step } with only the kinds a GateControl client can show. */
function stepOut(s) {
  if (!s || typeof s !== 'object' || !ID_RE.test(String(s.login_id || '')) || !ID_RE.test(String(s.step_id || ''))) {
    throw new BridgeError('ERR_BRIDGE', 'login step without ids', 'bad_answer');
  }
  // cookies / client_http / webauthn need a browser the bridge drives — not offered through GateControl
  if (!STEP_TYPES.includes(s.type)) throw new BridgeError('ERR_BRIDGE', `login step ${word(s.type)} is not supported`, 'unsupported_step');
  const step = { id: s.step_id, type: s.type, instructions: str(s.instructions, 500) };
  if (s.type === 'user_input') {
    const ui = s.user_input && typeof s.user_input === 'object' ? s.user_input : {};
    step.fields = (Array.isArray(ui.fields) ? ui.fields : []).slice(0, 8)
      .filter((f) => f && ID_RE.test(String(f.id || '')) && FIELD_TYPES.includes(f.type))
      .map((f) => ({ id: f.id, type: f.type, name: str(f.name, 80), description: str(f.description, 300), optional: f.optional === true }));
  } else if (s.type === 'display_and_wait') {
    const d = s.display_and_wait && typeof s.display_and_wait === 'object' ? s.display_and_wait : {};
    if (!DISPLAY_TYPES.includes(d.type)) throw new BridgeError('ERR_BRIDGE', 'unknown display type', 'bad_answer');
    // image_url is never passed on: the code is drawn from `data` by the client
    step.display = { type: d.type, data: str(d.data, 4096) };
  } else {
    const c = s.complete && typeof s.complete === 'object' ? s.complete : {};
    step.loginId = ID_RE.test(String(c.user_login_id || '')) ? c.user_login_id : null;
  }
  return { processId: s.login_id, step };
}

/** whoami → the person's logins [{ id, name, state, since, error }] and the bridge's flows. */
function whoamiOut(w) {
  const logins = (w && Array.isArray(w.logins) ? w.logins : []).slice(0, 16)
    .filter((l) => l && ID_RE.test(String(l.id || '')))
    .map((l) => {
      const st = l.state && typeof l.state === 'object' ? l.state : {};
      const ts = Number(st.timestamp);
      return {
        id: l.id,
        name: str(l.name, 80),
        state: STATES[st.state_event] || 'unknown',
        // seconds or milliseconds, depending on the bridge version
        since: Number.isFinite(ts) && ts > 0 ? new Date(ts < 1e11 ? ts * 1000 : ts).toISOString() : null,
        error: word(st.error).toLowerCase() || null,
      };
    });
  return { logins, flows: flowsOut(w && w.login_flows) };
}

function flowsOut(list) {
  return (Array.isArray(list) ? list : []).slice(0, 8)
    .filter((f) => f && ID_RE.test(String(f.id || '')))
    .map((f) => ({ id: f.id, name: str(f.name, 80), description: str(f.description, 300) }));
}

function client(target, mxid) {
  const call = (method, p, body, timeoutMs) => request(target, { method, path: p, mxid, body, timeoutMs });
  const seg = (v) => { if (!ID_RE.test(String(v || ''))) throw new BridgeError('ERR_INVALID', 'invalid id'); return encodeURIComponent(v); };
  return {
    whoami: async () => whoamiOut(await call('GET', 'whoami')),
    flows: async () => flowsOut((await call('GET', 'login/flows')).flows),
    start: async (flowId) => stepOut(await call('POST', `login/start/${seg(flowId)}`, {})),
    /** kind: 'user_input' (input: { fieldId: text }) | 'display_and_wait' (answers when the person confirmed on the phone) */
    step: async (processId, stepId, kind, input) => {
      if (kind !== 'user_input' && kind !== 'display_and_wait') throw new BridgeError('ERR_INVALID', 'invalid step kind');
      const body = {};
      if (kind === 'user_input') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('ERR_INVALID', 'input: an object');
        const keys = Object.keys(input);
        if (!keys.length || keys.length > 8) throw new BridgeError('ERR_INVALID', 'input: 1…8 fields');
        for (const k of keys) {
          if (!ID_RE.test(k) || typeof input[k] !== 'string' || input[k].length > 500) throw new BridgeError('ERR_INVALID', 'input: invalid field');
          body[k] = input[k];
        }
      }
      return stepOut(await call('POST', `login/step/${seg(processId)}/${seg(stepId)}/${kind}`, body, kind === 'display_and_wait' ? WAIT_TIMEOUT_MS : TIMEOUT_MS));
    },
    cancel: async (processId) => { await call('POST', `login/cancel/${seg(processId)}`, {}); return { ok: true }; },
    logout: async (loginId) => { await call('POST', `logout/${seg(loginId)}`, {}); return { ok: true }; },
  };
}

function socketOf(dir, network) { return path.join(dir, 'run', `${network}.sock`); }

module.exports = { client, request, stepOut, whoamiOut, flowsOut, socketOf, BridgeError, ID_RE, WAIT_TIMEOUT_MS };
