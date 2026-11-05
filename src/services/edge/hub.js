'use strict';

// The server end of the edge channel (docs/plugins.md "Edge part" ›
// "Protocol", protocol gc-edge.v1): one WebSocket per gateway, opened by the
// gateway's edge container at
//   GET /api/v1/gateway/edge/ws   Authorization: Bearer <apiToken of the gateway>
//                                 Sec-WebSocket-Protocol: gc-edge.v1
// JSON text frames of at most 64 KB. The server pings every 20 s and drops a
// connection silent for 60 s; a newer connection of the same gateway replaces
// the older one (close 4000).
//
// Gateway → server: hello, status, result, event, log
// Server → gateway: state (after hello and on every change), ack, call, configure
//
// Events of an edge part reach the plugin process (gc.edge.on) one after
// another per gateway × plugin; the `ack` goes back only after the plugin
// process took the event (its handlers ran). A delivery that fails stalls that
// queue: later events are neither delivered nor acknowledged until the gateway
// sends the unacknowledged ones again (it keeps them, contract §2).

const crypto = require('node:crypto');
const url = require('node:url');
const WebSocket = require('ws');
const store = require('./store');
const stateLib = require('./state');
const logger = require('../../utils/logger');

const PATH = '/api/v1/gateway/edge/ws';
const PROTOCOL = 'gc-edge.v1';
const FRAME_MAX = 64 * 1024;
const LIMITS = Object.freeze({
  pingMs: 20000,
  deadMs: 60000,
  helloMs: 10000,
  callTimeoutMs: 30000,         // longest call (and the default)
  openCallsPerPlugin: 32,
  eventsPerSecond: 50,          // per gateway × plugin; more are dropped (`throttled`)
  logsPerSecond: 20,            // per gateway × plugin
  framesPerSecond: 1000,        // per connection, all frames together; more closes it (1008)
  deliverTimeoutMs: 15000,      // the plugin process takes one event
  statusPlugins: 64,
  statusAccounts: 500,
  authFailuresPerWindow: 30,    // per IP and 5 minutes
});
let limits = { ...LIMITS };
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const NOTE_EVERY_MS = 10 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PLUGIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATES = new Set(['starting', 'running', 'crashed', 'stopped', 'denied', 'update_pending']);

class EdgeError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const conns = new Map();        // peerId → Conn
const openCalls = new Map();    // pluginId → number of calls waiting for a result
const authFailures = new Map(); // ip → { start, n }
const notes = new Map();        // `${kind}|${peer}|${plugin}` → last activity entry (ms)
let wss = null;
let refreshTimer = null;

function activity() { return require('../activity'); }
function runtime() { return require('../plugins/runtime'); }

/** Hand an event to the plugin process (replaceable in tests). */
function defaultDeliver(pluginId, payload) {
  return runtime().call(pluginId, 'edgeEvent', payload, limits.deliverTimeoutMs);
}
let deliver = defaultDeliver;

function gatewayName(peerId) {
  const g = store.gatewayPeer(peerId);
  return g ? g.name : `gateway ${peerId}`;
}

/** At most one activity entry per kind × gateway × plugin in NOTE_EVERY_MS. */
function notable(kind, peerId, pluginId) {
  const k = `${kind}|${peerId}|${pluginId || ''}`;
  const now = Date.now();
  const last = notes.get(k) || 0;
  if (now - last < NOTE_EVERY_MS) return false;
  notes.set(k, now);
  return true;
}

function windowCount(map, key, perSecond) {
  const now = Date.now();
  let w = map.get(key);
  if (!w || now - w.start >= 1000) { w = { start: now, n: 0, dropped: 0 }; map.set(key, w); }
  w.n++;
  if (w.n > perSecond) { w.dropped++; return false; }
  return true;
}

function str(v, max) { return typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').slice(0, max) : null; }

function boundedJson(v, max) {
  try { const s = JSON.stringify(v); return s && s.length <= max ? JSON.parse(s) : null; } catch { return null; }
}

class Conn {
  constructor(ws, gw, ip) {
    this.ws = ws;
    this.peerId = gw.peer_id;
    this.tokenHash = gw.token_hash;
    this.ip = ip;
    this.ready = false;
    this.connectedAt = Date.now();
    this.lastSeen = Date.now();
    this.lastState = null;
    this.pending = new Map();   // call id → { resolve, reject, timer, pluginId }
    this.queues = new Map();    // pluginId → { items, busy, acked, stalled, stalledAt }
    this.eventRate = new Map();
    this.logRate = new Map();
    this.frameRate = { start: 0, n: 0 };
    this.prevStatus = new Map(); // pluginId → last status of this connection
    this.helloTimer = setTimeout(() => this.close(1008, 'hello expected'), limits.helloMs);
    this.helloTimer.unref();
    this.pingTimer = setInterval(() => this.pingTick(), limits.pingMs);
    this.pingTimer.unref();
  }

  send(obj) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const s = JSON.stringify(obj);
    if (Buffer.byteLength(s) > FRAME_MAX) return false;
    try { this.ws.send(s); return true; } catch { return false; }
  }

  close(code, reason) {
    try { this.ws.close(code, reason); } catch { /* gone */ }
    const t = setTimeout(() => { try { this.ws.terminate(); } catch { /* gone */ } }, 2000);
    t.unref();
  }

  pingTick() {
    if (Date.now() - this.lastSeen > limits.deadMs) {
      logger.info({ peerId: this.peerId }, 'edge channel silent — closing');
      try { this.ws.terminate(); } catch { /* gone */ }
      return;
    }
    // the gateway may have been disabled or its token rotated since it connected
    const row = require('../../db/connection').getDb().prepare(`SELECT gm.api_token_hash AS h FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
      WHERE gm.peer_id = ? AND p.peer_type = 'gateway' AND p.enabled = 1`).get(this.peerId);
    if (!row || row.h !== this.tokenHash) { this.close(4001, 'credentials changed'); return; }
    try { this.ws.ping(); } catch { /* exit follows */ }
  }

  onFrame(data, isBinary) {
    this.lastSeen = Date.now();
    const now = Date.now();
    if (now - this.frameRate.start >= 1000) this.frameRate = { start: now, n: 0 };
    if (++this.frameRate.n > limits.framesPerSecond) { this.close(1008, 'too many frames'); return; }
    if (isBinary) { this.close(1003, 'text frames only'); return; }
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { this.close(1007, 'invalid JSON'); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') { this.close(1007, 'invalid frame'); return; }
    if (!this.ready && m.t !== 'hello') { this.close(1008, 'hello expected'); return; }
    try {
      switch (m.t) {
        case 'hello': this.onHello(m); break;
        case 'status': this.onStatus(m); break;
        case 'result': this.onResult(m); break;
        case 'event': this.onEvent(m); break;
        case 'log': this.onLog(m); break;
        default: // unknown frames are ignored (newer gateways)
      }
    } catch (e) {
      logger.warn({ peerId: this.peerId, frame: m.t, err: e.message }, 'edge frame failed');
    }
  }

  onHello(m) {
    const gw = m.gw && typeof m.gw === 'object' ? m.gw : null;
    if (m.v !== 1 || !gw || typeof gw.version !== 'string' || !gw.version) { this.close(1008, 'invalid hello'); return; }
    clearTimeout(this.helloTimer);
    const hello = {
      version: str(gw.version, 32),
      edgeHost: str(gw.edgeHost, 32),
      mqtt: { available: !!(gw.mqtt && gw.mqtt.available === true) },
      // the gateway's network fence for edge parts ({ active, backend }) — without it no edge part starts there
      fence: gw.fence && typeof gw.fence === 'object' ? { active: gw.fence.active === true, backend: str(gw.fence.backend, 32) } : null,
      hardware: boundedJson(gw.hardware, 4096),
    };
    store.setHello(this.peerId, hello);
    const first = !this.ready;
    this.ready = true;
    this.lastState = null;
    for (const q of this.queues.values()) { q.stalled = false; q.acked = -1; }
    this.pushState();
    if (first) {
      store.addLog(this.peerId, null, 'system', 'info', `connected (gateway ${hello.version}${hello.edgeHost ? ', edge host ' + hello.edgeHost : ''})`);
      this.broadcast('$online', {});
    }
  }

  pushState() {
    if (!this.ready) return;
    let st;
    try { st = stateLib.compute(this.peerId); } catch (e) { logger.warn({ peerId: this.peerId, err: e.message }, 'edge state not computed'); return; }
    const s = JSON.stringify(st);
    if (s === this.lastState) return;
    if (Buffer.byteLength(s) > FRAME_MAX) {
      logger.error({ peerId: this.peerId, bytes: Buffer.byteLength(s) }, 'edge state larger than a frame — not sent');
      return;
    }
    this.lastState = s;
    try { this.ws.send(s); } catch { /* close follows */ }
  }

  /** Built-in events ($online, $offline, $started) to the plugins switched on for this gateway — no ack. */
  broadcast(name, data, onlyPlugin) {
    let list;
    try { list = store.assignmentsOfGateway(this.peerId).filter((a) => a.enabled && (!onlyPlugin || a.pluginId === onlyPlugin)); } catch { return; }
    for (const a of list) {
      if (!stateLib.effective(a.pluginId, this.peerId).ok) continue;
      Promise.resolve()
        .then(() => deliver(a.pluginId, { gatewayId: this.peerId, name, data, at: new Date().toISOString(), seq: null }))
        .catch(() => { /* not running: it learns the state from gc.edge.gateways() */ });
    }
  }

  onStatus(m) {
    const list = Array.isArray(m.plugins) ? m.plugins.slice(0, limits.statusPlugins) : [];
    for (const p of list) {
      if (!p || typeof p.id !== 'string' || !PLUGIN_RE.test(p.id)) continue;
      const a = store.assignment(p.id, this.peerId);
      if (!a) continue;
      const st = {
        state: STATES.has(p.state) ? p.state : 'stopped',
        version: str(p.version, 32),
        rssMb: Number.isFinite(p.rssMb) ? Math.max(0, Math.round(p.rssMb * 10) / 10) : null,
        restarts: Number.isSafeInteger(p.restarts) && p.restarts >= 0 ? p.restarts : 0,
        lastError: str(p.lastError, 300),
        throttled: p.throttled === true || (Number.isFinite(p.throttled) && p.throttled > 0),
        at: new Date().toISOString(),
      };
      const prev = this.prevStatus.has(p.id) ? this.prevStatus.get(p.id) : a.status;
      this.prevStatus.set(p.id, st);
      const changed = !prev || prev.state !== st.state || prev.restarts !== st.restarts || prev.lastError !== st.lastError
        || prev.throttled !== st.throttled || prev.version !== st.version || prev.rssMb !== st.rssMb;
      if (changed) store.setAssignmentStatus(p.id, this.peerId, st);
      const crashed = (st.state === 'crashed' && (!prev || prev.state !== 'crashed')) || (prev && st.restarts > prev.restarts);
      if (crashed) this.crashed(p.id, st);
      if (st.throttled && (!prev || !prev.throttled)) this.throttled(p.id, 'gateway');
      if (st.state === 'running' && (!prev || prev.state !== 'running')) this.broadcast('$started', { version: st.version }, p.id);
      if (prev && prev.state !== st.state) store.addLog(this.peerId, p.id, 'system', st.state === 'crashed' ? 'error' : 'info', `state ${prev.state || '-'} → ${st.state}`);
    }
    if (m.mqtt && typeof m.mqtt === 'object') {
      const accounts = Array.isArray(m.mqtt.accounts) ? m.mqtt.accounts.slice(0, limits.statusAccounts) : [];
      store.setMqttStatus(this.peerId, {
        running: m.mqtt.running === true,
        clients: Number.isSafeInteger(m.mqtt.clients) && m.mqtt.clients >= 0 ? m.mqtt.clients : 0,
        accounts: accounts.filter((x) => x && typeof x.user === 'string').map((x) => ({
          user: str(x.user, 64), connected: x.connected === true, lastSeen: str(x.lastSeen, 40),
        })),
      });
    }
  }

  crashed(pluginId, st) {
    store.addLog(this.peerId, pluginId, 'system', 'error', `crashed (restarts: ${st.restarts})${st.lastError ? ': ' + st.lastError : ''}`);
    if (!notable('crash', this.peerId, pluginId)) return;
    try {
      activity().log('gateway_edge_plugin_crashed', `Edge part of plugin "${pluginId}" crashed on gateway "${gatewayName(this.peerId)}"`, {
        source: 'system', severity: 'warning', details: { peer_id: this.peerId, plugin: pluginId, restarts: st.restarts, error: st.lastError },
      });
    } catch { /* activity log unavailable */ }
  }

  throttled(pluginId, by) {
    if (!notable('throttle', this.peerId, pluginId)) return;
    store.addLog(this.peerId, pluginId, 'system', 'warn', by === 'gateway' ? 'throttled on the gateway' : `throttled: more than ${limits.eventsPerSecond} events/s — dropped`);
    try {
      activity().log('gateway_edge_plugin_throttled', `Edge part of plugin "${pluginId}" on gateway "${gatewayName(this.peerId)}" was throttled`, {
        source: 'system', severity: 'warning', details: { peer_id: this.peerId, plugin: pluginId, by },
      });
    } catch { /* activity log unavailable */ }
  }

  onResult(m) {
    const p = typeof m.id === 'string' ? this.pending.get(m.id) : null;
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    p.done();
    if (m.ok === true) { p.resolve(m.result === undefined ? null : m.result); return; }
    const e = m.error && typeof m.error === 'object' ? m.error : {};
    const code = ['denied', 'not_enabled', 'timeout'].includes(e.code) ? e.code : 'edge_error';
    p.reject(new EdgeError(code, str(e.message, 300) || code));
  }

  queueOf(pluginId) {
    let q = this.queues.get(pluginId);
    if (!q) { q = { items: [], busy: false, acked: -1, stalled: false, stalledAt: null }; this.queues.set(pluginId, q); }
    return q;
  }

  onEvent(m) {
    const pluginId = typeof m.plugin === 'string' && PLUGIN_RE.test(m.plugin) ? m.plugin : null;
    if (!pluginId || typeof m.name !== 'string' || !NAME_RE.test(m.name) || m.name.startsWith('$') || !Number.isSafeInteger(m.seq) || m.seq < 0) return;
    if (!stateLib.effective(pluginId, this.peerId).ok) return; // not switched on here: never handed to the plugin
    const q = this.queueOf(pluginId);
    if (m.seq <= q.acked) { this.send({ t: 'ack', plugin: pluginId, seq: q.acked }); return; } // delivered before
    if (q.stalled) {
      if (m.seq > q.stalledAt) return; // waits for the gateway to send the unacknowledged ones again
      q.stalled = false;
      q.stalledAt = null;
    }
    if (!windowCount(this.eventRate, pluginId, limits.eventsPerSecond)) { this.throttled(pluginId, 'server'); return; }
    if (q.items.length && q.items[q.items.length - 1].seq >= m.seq) return; // out of order duplicate
    q.items.push({ name: m.name, data: m.data === undefined ? null : m.data, at: str(m.at, 40) || new Date().toISOString(), seq: m.seq });
    this.pump(pluginId, q);
  }

  async pump(pluginId, q) {
    if (q.busy) return;
    q.busy = true;
    try {
      while (q.items.length && this.ws.readyState === WebSocket.OPEN) {
        const ev = q.items.shift();
        if (ev.seq <= q.acked) continue;
        try {
          await deliver(pluginId, { gatewayId: this.peerId, name: ev.name, data: ev.data, at: ev.at, seq: ev.seq });
        } catch (e) {
          q.stalled = true;
          q.stalledAt = ev.seq;
          q.items = [];
          store.addLog(this.peerId, pluginId, 'system', 'warn', `event ${ev.name} #${ev.seq} not delivered (${e && e.code ? e.code : 'error'}) — waits for the gateway`);
          break;
        }
        q.acked = ev.seq;
        this.send({ t: 'ack', plugin: pluginId, seq: ev.seq });
        store.addLog(this.peerId, pluginId, 'event', 'info', `${ev.name} #${ev.seq}`);
      }
    } finally { q.busy = false; }
  }

  onLog(m) {
    const pluginId = typeof m.plugin === 'string' && PLUGIN_RE.test(m.plugin) ? m.plugin : null;
    if (!pluginId || !store.assignment(pluginId, this.peerId)) return;
    if (!windowCount(this.logRate, pluginId, limits.logsPerSecond)) return;
    const level = ['info', 'warn', 'error'].includes(m.level) ? m.level : 'info';
    store.addLog(this.peerId, pluginId, 'log', level, typeof m.line === 'string' ? m.line : '');
  }

  call(pluginId, method, params, timeoutMs) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const n = openCalls.get(pluginId) || 0;
      if (n >= limits.openCallsPerPlugin) { reject(new EdgeError('busy', `more than ${limits.openCallsPerPlugin} open calls`)); return; }
      const frame = { t: 'call', id, plugin: pluginId, method, params: params === undefined ? null : params, timeoutMs };
      if (Buffer.byteLength(JSON.stringify(frame)) > FRAME_MAX) { reject(new EdgeError('too_large', 'call larger than 64 KB')); return; }
      openCalls.set(pluginId, n + 1);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        const left = (openCalls.get(pluginId) || 1) - 1;
        if (left > 0) openCalls.set(pluginId, left); else openCalls.delete(pluginId);
      };
      // the gateway ends the call itself after timeoutMs; a little more for the way back
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done();
        reject(new EdgeError('timeout', 'the gateway did not answer in time'));
      }, timeoutMs + 2000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, pluginId, done });
      if (!this.send(frame)) {
        clearTimeout(timer);
        this.pending.delete(id);
        done();
        reject(new EdgeError('gateway_offline', 'the gateway is not connected'));
      }
    });
  }

  onClose() {
    clearTimeout(this.helloTimer);
    clearInterval(this.pingTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.done();
      p.reject(new EdgeError('gateway_offline', 'the gateway disconnected'));
    }
    this.pending.clear();
    if (conns.get(this.peerId) === this) {
      conns.delete(this.peerId);
      if (this.ready) {
        try { store.addLog(this.peerId, null, 'system', 'info', 'disconnected'); } catch { /* db closed */ }
        this.broadcast('$offline', {});
      }
    }
  }
}

// ─── Upgrade ────────────────────────────────────

function reject(socket, status, error) {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 429: 'Too Many Requests' }[status] || 'Error';
  const body = JSON.stringify({ error });
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } catch { /* gone */ }
  socket.destroy();
}

function authLimited(ip) {
  const w = authFailures.get(ip);
  return !!w && Date.now() - w.start < AUTH_WINDOW_MS && w.n >= limits.authFailuresPerWindow;
}

function authFailed(ip) {
  const now = Date.now();
  let w = authFailures.get(ip);
  if (!w || now - w.start >= AUTH_WINDOW_MS) { w = { start: now, n: 0 }; authFailures.set(ip, w); }
  w.n++;
  if (authFailures.size > 10000) authFailures.clear();
}

function server() {
  if (!wss) {
    wss = new WebSocket.Server({
      noServer: true,
      maxPayload: FRAME_MAX,
      perMessageDeflate: false,
      handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    });
  }
  return wss;
}

/** Handle an HTTP upgrade for PATH; false when it is not ours. */
function handleUpgrade(req, socket, head) {
  let pathname;
  try { pathname = url.parse(req.url).pathname; } catch { return false; }
  if (pathname !== PATH) return false;
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (authLimited(ip)) { reject(socket, 429, 'too_many_requests'); return true; }
  const auth = require('../../middleware/gatewayAuth').authenticate(req.headers.authorization, ip);
  if (!auth.ok) { authFailed(ip); reject(socket, auth.status, auth.error); return true; }
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  if (!offered.includes(PROTOCOL)) { reject(socket, 400, 'subprotocol_required'); return true; }
  server().handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth.gateway, ip));
  return true;
}

function onConnection(ws, gw, ip) {
  const old = conns.get(gw.peer_id);
  const c = new Conn(ws, gw, ip);
  conns.set(gw.peer_id, c);
  if (old) old.close(4000, 'replaced');
  ws.on('message', (data, isBinary) => c.onFrame(data, isBinary));
  ws.on('pong', () => { c.lastSeen = Date.now(); });
  ws.on('close', () => c.onClose());
  ws.on('error', (e) => logger.debug({ peerId: gw.peer_id, err: e.message }, 'edge channel error'));
}

/** Wire the endpoint into the HTTP server (server.js; tests). */
function attach(httpServer) {
  httpServer.on('upgrade', (req, socket, head) => {
    try { handleUpgrade(req, socket, head); } catch (e) {
      logger.warn({ err: e.message }, 'edge upgrade failed');
      try { socket.destroy(); } catch { /* gone */ }
    }
  });
}

// ─── For the rest of the server ─────────────────

function connection(peerId) {
  const c = conns.get(Number(peerId));
  return c && c.ready ? c : null;
}

function online(peerId) { return !!connection(peerId); }

function connectionInfo(peerId) {
  const c = conns.get(Number(peerId));
  if (!c) return { online: false, connectedAt: null, lastSeen: null };
  return { online: c.ready, connectedAt: new Date(c.connectedAt).toISOString(), lastSeen: new Date(c.lastSeen).toISOString() };
}

/** Send a call and wait for its result (codes: gateway_offline, timeout, edge_error, denied, not_enabled, busy, too_large). */
function call(pluginId, peerId, method, params, timeoutMs = limits.callTimeoutMs) {
  const c = connection(peerId);
  if (!c) return Promise.reject(new EdgeError('gateway_offline', 'the gateway is not connected'));
  const t = Math.max(100, Math.min(limits.callTimeoutMs, Number(timeoutMs) || limits.callTimeoutMs));
  return c.call(pluginId, method, params, t);
}

/** Hand configuration to the edge part — held in its memory only, never written anywhere. */
function configure(pluginId, peerId, data) {
  const c = connection(peerId);
  if (!c) throw new EdgeError('gateway_offline', 'the gateway is not connected');
  if (!c.send({ t: 'configure', plugin: pluginId, data: data === undefined ? null : data })) {
    throw new EdgeError('too_large', 'configuration larger than 64 KB (or the connection is closing)');
  }
}

/** Recompute and send the state of every connected gateway (or one) — soon, at most once per tick. */
function refresh(peerId) {
  if (peerId != null) { const c = connection(peerId); if (c) c.pushState(); return; }
  for (const c of conns.values()) c.pushState();
}

function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; try { refresh(); } catch (e) { logger.warn({ err: e.message }, 'edge state refresh failed'); } }, 100);
  refreshTimer.unref();
}

function closeAll() {
  for (const c of conns.values()) c.close(1001, 'server stopping');
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

function _setForTest({ deliver: d, limits: l } = {}) {
  if (process.env.NODE_ENV !== 'test') return;
  if (d !== undefined) deliver = d || defaultDeliver;
  if (l !== undefined) limits = l ? { ...LIMITS, ...l } : { ...LIMITS };
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  for (const c of conns.values()) { try { c.ws.terminate(); } catch { /* gone */ } }
  conns.clear();
  openCalls.clear();
  authFailures.clear();
  notes.clear();
}

module.exports = {
  attach, handleUpgrade, call, configure, refresh, refreshSoon, online, connectionInfo, closeAll, EdgeError,
  PATH, PROTOCOL, FRAME_MAX, LIMITS, _setForTest, _resetForTest,
};
