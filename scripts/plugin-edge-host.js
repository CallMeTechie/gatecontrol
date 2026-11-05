#!/usr/bin/env node
'use strict';

// Test edge host (docs/plugins.md "Edge part" › "Testing"): a fake gateway
// edge container that speaks the edge protocol gc-edge.v1 with a GateControl
// server — so the server part of a plugin (gc.edge.*) can be tried without a
// real gateway, and the server's tests can drive the channel.
//
// In a test (same process as the server, or any server you can reach):
//
//   const { createEdgeHost } = require('<gatecontrol>/scripts/plugin-edge-host');
//   const host = await createEdgeHost({ serverUrl: 'http://127.0.0.1:3000', apiToken: 'gc_gw_…' });
//   host.handle('my-plugin', 'devices.list', async (params, ctx) => [{ id: 'lamp' }]);
//   await host.waitForState((s) => s.plugins.some((p) => p.id === 'my-plugin' && p.enabled));
//   const seq = host.emit('my-plugin', 'device.found', { id: 'lamp' });
//   await host.waitForAck('my-plugin', seq);
//   host.configOf('my-plugin');            // the last gc.edge.configure(...) data
//   await host.close();
//
// From the command line, against a development server (the token is the
// gateway's apiToken from its gateway.env):
//
//   node scripts/plugin-edge-host.js --server http://localhost:3000 --token gc_gw_… [--handlers ./edge-fake.js]
//
// --handlers names a module exporting { '<plugin id>': { '<method>': async (params, ctx) => result } };
// ctx.emit(name, data) sends an event, ctx.config() returns the last configuration.
// Without it every call answers { echo: params }. The host reports every
// plugin of the state as "running" (autoStatus) and prints the frames it gets.

const WebSocket = require('ws');

const PROTOCOL = 'gc-edge.v1';
const PATH = '/api/v1/gateway/edge/ws';
// a handler returning this leaves the call unanswered (a gateway that hangs)
const NO_REPLY = Symbol('no reply');

function wsUrl(serverUrl) {
  const u = new URL(PATH, serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

/**
 * @param {object} o
 * @param {string} o.serverUrl     base URL of the GateControl server
 * @param {string} o.apiToken      the gateway's apiToken (gc_gw_…)
 * @param {string} [o.version]     gateway version in the hello (default 1.20.0)
 * @param {string} [o.edgeHost]    edge host version in the hello
 * @param {boolean} [o.mqtt]       mqtt.available in the hello (default true)
 * @param {object} [o.hardware]    hello hardware
 * @param {boolean} [o.autoStatus] answer every state with a status frame: switched-on plugins "running" (default true)
 * @param {boolean} [o.hello]      send the hello right away (default true)
 * @param {(frame:object)=>void} [o.onFrame]
 * @returns {Promise<EdgeHost>}    resolves once the connection is open (and the first state arrived when hello is sent)
 */
async function createEdgeHost(o) {
  const host = new EdgeHost(o);
  await host.connect();
  return host;
}

class EdgeHost {
  constructor(o) {
    this.o = { version: '1.20.0', edgeHost: '1.0.0', mqtt: true, hardware: null, autoStatus: true, hello: true, ...o };
    this.ws = null;
    this.frames = [];          // every frame received, in order
    this.state = null;         // the last state
    this.handlers = new Map(); // `${plugin}|${method}` → fn
    this.configs = new Map();  // plugin → last configure data
    this.acks = new Map();     // plugin → highest acknowledged seq
    this.seqs = new Map();     // plugin → last seq used
    this.unacked = new Map();  // plugin → [event frames]
    this.waiters = [];
    this.closed = null;        // { code, reason } once closed
    this.restarts = new Map(); // plugin → restarts reported
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.o.serverUrl), PROTOCOL, { headers: { Authorization: 'Bearer ' + this.o.apiToken } });
      this.ws = ws;
      let opened = false;
      ws.on('unexpected-response', (_req, res) => {
        const e = Object.assign(new Error('edge channel refused: HTTP ' + res.statusCode), { status: res.statusCode });
        res.resume();
        reject(e);
      });
      ws.on('error', (e) => { if (!opened) reject(e); });
      ws.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() };
        this.notify();
      });
      ws.on('message', (data) => this.onMessage(data));
      ws.on('open', () => {
        opened = true;
        if (!this.o.hello) { resolve(this); return; }
        this.sendHello();
        this.waitForState(() => true).then(() => resolve(this), reject);
      });
    });
  }

  sendHello(extra) {
    this.send({ t: 'hello', v: 1, gw: { version: this.o.version, edgeHost: this.o.edgeHost, mqtt: { available: this.o.mqtt }, hardware: this.o.hardware, ...(extra || {}) } });
  }

  send(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    return true;
  }

  onMessage(data) {
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    this.frames.push(m);
    if (this.o.onFrame) { try { this.o.onFrame(m); } catch { /* a test's callback */ } }
    if (m.t === 'state') {
      this.state = m;
      if (this.o.autoStatus) this.reportStatus();
    } else if (m.t === 'ack') {
      const prev = this.acks.get(m.plugin);
      if (prev === undefined || m.seq > prev) this.acks.set(m.plugin, m.seq);
      const list = this.unacked.get(m.plugin) || [];
      this.unacked.set(m.plugin, list.filter((e) => e.seq > m.seq));
    } else if (m.t === 'configure') {
      this.configs.set(m.plugin, m.data);
    } else if (m.t === 'call') {
      this.onCall(m);
    }
    this.notify();
  }

  enabled(pluginId) {
    return !!(this.state && this.state.edgeEnabled && this.state.plugins.some((p) => p.id === pluginId && p.enabled));
  }

  async onCall(m) {
    const reply = (r) => this.send({ t: 'result', id: m.id, ...r });
    if (!this.enabled(m.plugin)) { reply({ ok: false, error: { code: 'not_enabled', message: 'not running on this gateway' } }); return; }
    const fn = this.handlers.get(`${m.plugin}|${m.method}`) || this.handlers.get(`${m.plugin}|*`)
      || (this.o.echo !== false && !this.handlers.size ? (params) => ({ echo: params }) : null);
    if (!fn) { reply({ ok: false, error: { code: 'unknown_method', message: 'no handler for ' + m.method } }); return; }
    const ctx = { plugin: m.plugin, method: m.method, emit: (name, data) => this.emit(m.plugin, name, data), config: () => this.configOf(m.plugin) };
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), Math.min(30000, m.timeoutMs || 30000)); });
    try {
      const r = await Promise.race([Promise.resolve().then(() => fn(m.params, ctx)).then((v) => ({ v })), limit]);
      if (r.timeout) reply({ ok: false, error: { code: 'timeout', message: 'the edge part did not answer in time' } });
      else if (r.v === NO_REPLY) { /* stays unanswered */ } else reply({ ok: true, result: r.v === undefined ? null : r.v });
    } catch (e) {
      reply({ ok: false, error: { code: e && e.code ? String(e.code) : 'error', message: String((e && e.message) || e) } });
    } finally { clearTimeout(timer); }
  }

  /** A handler of `method` for `pluginId` ('*': every method) — like gc.handle in the edge part. */
  handle(pluginId, method, fn) { this.handlers.set(`${pluginId}|${method}`, fn); return this; }

  /** Send an event of `pluginId` → its seq. Kept until acknowledged (resend() sends them again). */
  emit(pluginId, name, data, { at = new Date().toISOString(), seq } = {}) {
    const s = seq != null ? seq : (this.seqs.get(pluginId) || 0) + 1;
    this.seqs.set(pluginId, Math.max(s, this.seqs.get(pluginId) || 0));
    const frame = { t: 'event', plugin: pluginId, name, data: data === undefined ? null : data, at, seq: s };
    const list = this.unacked.get(pluginId) || [];
    list.push(frame);
    this.unacked.set(pluginId, list);
    this.send(frame);
    return s;
  }

  /** Send the unacknowledged events of `pluginId` again (what a gateway does after a while / a reconnect). */
  resend(pluginId) {
    for (const f of this.unacked.get(pluginId) || []) this.send(f);
  }

  log(pluginId, level, line) { return this.send({ t: 'log', plugin: pluginId, level, line }); }

  /**
   * A status frame. Without `plugins`: every plugin of the last state, switched-on ones "running".
   * @param {{plugins?: object[], mqtt?: object}} [s]
   */
  reportStatus(s = {}) {
    const plugins = s.plugins || (this.state ? this.state.plugins.map((p) => ({
      id: p.id, version: p.version, state: p.enabled && this.state.edgeEnabled ? 'running' : 'stopped', rssMb: 20, restarts: this.restarts.get(p.id) || 0, lastError: null,
    })) : []);
    const mqtt = s.mqtt || { running: !!(this.state && this.state.mqtt && this.state.mqtt.enabled), clients: 0, accounts: [] };
    return this.send({ t: 'status', plugins, mqtt });
  }

  configOf(pluginId) { return this.configs.has(pluginId) ? this.configs.get(pluginId) : null; }

  notify() {
    const left = [];
    for (const w of this.waiters) { if (w.check()) w.done(); else left.push(w); }
    this.waiters = left;
  }

  /** Wait until `check()` is true (re-checked on every frame), or reject after `timeoutMs`. */
  waitUntil(check, timeoutMs = 5000, what = 'condition') {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== entry); reject(new Error('timed out waiting for ' + what)); }, timeoutMs);
      const entry = { check, done: () => { clearTimeout(t); resolve(); } };
      this.waiters.push(entry);
    });
  }

  /** The next state for which `pred(state)` holds (the current one counts). */
  async waitForState(pred, timeoutMs) {
    await this.waitUntil(() => !!this.state && pred(this.state), timeoutMs, 'state');
    return this.state;
  }

  waitForAck(pluginId, seq, timeoutMs) {
    return this.waitUntil(() => (this.acks.get(pluginId) ?? -1) >= seq, timeoutMs, `ack ${pluginId} #${seq}`);
  }

  waitForConfig(pluginId, timeoutMs) {
    return this.waitUntil(() => this.configs.has(pluginId), timeoutMs, 'configure ' + pluginId).then(() => this.configOf(pluginId));
  }

  waitForClose(timeoutMs) { return this.waitUntil(() => !!this.closed, timeoutMs, 'close').then(() => this.closed); }

  close() {
    if (!this.ws || this.closed) return Promise.resolve(this.closed);
    const p = this.waitForClose(3000).catch(() => null);
    try { this.ws.close(1000, 'bye'); } catch { /* gone */ }
    return p;
  }
}

// ─── Command line ───────────────────────────────

function argv(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const serverUrl = argv('--server');
  const apiToken = argv('--token') || process.env.GC_GATEWAY_TOKEN;
  if (!serverUrl || !apiToken) {
    process.stderr.write('usage: node scripts/plugin-edge-host.js --server <url> --token <gateway apiToken> [--handlers <module>]\n');
    process.exit(2);
  }
  const handlersFile = argv('--handlers');
  const host = await createEdgeHost({
    serverUrl, apiToken, version: argv('--version') || '1.20.0',
    onFrame: (m) => process.stdout.write(JSON.stringify(m.t === 'state' ? { ...m, mqtt: { ...m.mqtt, accounts: (m.mqtt.accounts || []).map((a) => ({ user: a.user, acl: a.acl })) } } : m) + '\n'),
  });
  if (handlersFile) {
    const mod = require(require('node:path').resolve(handlersFile));
    for (const [plugin, methods] of Object.entries(mod || {})) {
      for (const [method, fn] of Object.entries(methods || {})) if (typeof fn === 'function') host.handle(plugin, method, fn);
    }
  }
  process.stdout.write(`edge host connected to ${serverUrl} (frames below, Ctrl+C ends)\n`);
  host.ws.on('close', (code) => { process.stdout.write(`closed (${code})\n`); process.exit(code === 1000 ? 0 : 1); });
  process.on('SIGINT', () => host.close().then(() => process.exit(0)));
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(String(e.message || e) + '\n'); process.exit(1); });
}

module.exports = { createEdgeHost, EdgeHost, PROTOCOL, PATH, NO_REPLY };
