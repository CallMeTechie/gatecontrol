'use strict';

// Entry point of a plugin process (docs/plugins.md "Isolation").
//
// Started by runtime.js with child_process.fork and Node's permission model:
//   --permission, --allow-fs-read=<this file>,<plugin code>,<plugin files>,
//   --allow-fs-write=<plugin files>, no child processes, no workers, no
//   addons, no inspector, no WASI; --no-experimental-sqlite (node:sqlite does
//   not honour the permission model); a small heap; an empty environment.
//
// What the permission model does NOT cover is closed here in JavaScript,
// before any plugin code runs (defence in depth, not a security boundary
// on its own): signals to other processes (process.kill, _debugProcess —
// SIGUSR1 would open the HOST's inspector), process.binding and friends,
// a deny list of built-in modules, and the network APIs (net, tls, dgram,
// http, https, http2, fetch, WebSocket). Network access goes through the
// host (gc.http.fetch), which enforces the plugin's allowlist.
//
// Must stay dependency-free: only this file is readable for the process.

const Module = require('node:module');

// Whole modules a plugin cannot load. net/tls/http/… stay loadable (libraries
// use helpers like net.isIP), only their connecting functions are replaced.
const DENIED_MODULES = new Set(['child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'repl',
  'wasi', 'sqlite', 'trace_events', 'v8', 'dns', 'dns/promises']);

function denied(what) {
  return function deniedApi() {
    const e = new Error(`${what} is not available to plugins (docs/plugins.md)`);
    e.code = 'ERR_PLUGIN_DENIED';
    throw e;
  };
}

function bare(name) { return String(name).replace(/^node:/, ''); }

function lockdown() {
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const tls = require('node:tls');
  const dgram = require('node:dgram');
  const http2 = require('node:http2');
  for (const [obj, names, label] of [
    [net, ['connect', 'createConnection', 'createServer'], 'net'],
    [net.Socket.prototype, ['connect'], 'net.Socket'],
    [net.Server.prototype, ['listen'], 'net.Server'],
    [tls, ['connect', 'createServer'], 'tls'],
    [dgram, ['createSocket'], 'dgram'],
    [http, ['request', 'get', 'createServer'], 'http'],
    [https, ['request', 'get', 'createServer'], 'https'],
    [http2, ['connect', 'createServer', 'createSecureServer'], 'http2'],
  ]) {
    for (const n of names) {
      try { Object.defineProperty(obj, n, { value: denied(`${label}.${n}`), writable: false, configurable: false }); } catch { /* keep going */ }
    }
  }
  for (const g of ['fetch', 'WebSocket', 'EventSource']) {
    try { Object.defineProperty(globalThis, g, { value: denied(g), writable: false, configurable: false }); } catch { /* keep going */ }
  }

  const self = process.pid;
  const origKill = process.kill.bind(process);
  const lock = (name, value) => {
    try { Object.defineProperty(process, name, { value, writable: false, configurable: false }); } catch { /* keep going */ }
  };
  lock('kill', function kill(pid, sig) {
    if (Number(pid) !== self) throw Object.assign(new Error('signals to other processes are not available to plugins'), { code: 'ERR_PLUGIN_DENIED' });
    return origKill(pid, sig);
  });
  for (const n of ['_kill', '_debugProcess', '_debugEnd', 'binding', '_linkedBinding', 'dlopen', 'execve',
    'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups', '_startProfilerIdleNotifier', '_stopProfilerIdleNotifier']) {
    if (n in process) lock(n, denied('process.' + n));
  }

  const origGet = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule.bind(process) : null;
  if (origGet) {
    lock('getBuiltinModule', function getBuiltinModule(id) {
      if (DENIED_MODULES.has(bare(id))) denied(bare(id))();
      return origGet(id);
    });
  }
  const origLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (typeof request === 'string' && DENIED_MODULES.has(bare(request))) denied(bare(request))();
    return origLoad.call(this, request, parent, isMain);
  };
  Object.defineProperty(Module, '_load', { writable: false, configurable: false });
  if (typeof Module.registerHooks === 'function') {
    try {
      Module.registerHooks({
        resolve(specifier, context, nextResolve) {
          if (DENIED_MODULES.has(bare(specifier)) && (specifier.startsWith('node:') || Module.isBuiltin(specifier))) denied(bare(specifier))();
          return nextResolve(specifier, context);
        },
      });
    } catch { /* older Node: Module._load covers require() */ }
  }
  try { Module.syncBuiltinESMExports(); } catch { /* best effort */ }
}

// ─── IPC ────────────────────────────────────────

let seq = 0;
const pending = new Map();
const HOST_TIMEOUT_MS = 60000;

function send(msg) {
  try { process.send(msg); } catch { /* host gone */ }
}

function hostCall(api, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`host call ${api} timed out`)); }, HOST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    send({ t: 'host', id, api, args: args === undefined ? {} : args });
  });
}

function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, 1000);
}

// Proxied TCP sockets (gc.net.tcp.connect): the host holds the real socket.
const EventEmitter = require('node:events');
const sockets = new Map();

class PluginSocket extends EventEmitter {
  constructor(id, info) {
    super();
    this.id = id;
    this.remoteAddress = info.remoteAddress;
    this.remotePort = info.remotePort;
    this.closed = false;
  }
  write(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return hostCall('tcp.write', { id: this.id, b64: buf.toString('base64') });
  }
  end() { return hostCall('tcp.end', { id: this.id }).catch(() => null); }
  destroy() { return hostCall('tcp.destroy', { id: this.id }).catch(() => null); }
  setTimeout(ms) { return hostCall('tcp.setTimeout', { id: this.id, ms }); }
}

function onSocketEvent(m) {
  const s = sockets.get(m.id);
  if (!s) return;
  if (m.ev === 'data') s.emit('data', Buffer.from(String(m.b64 || ''), 'base64'));
  else if (m.ev === 'timeout') s.emit('timeout');
  else if (m.ev === 'error') s.emit('error', Object.assign(new Error(m.error || 'socket error'), { code: 'ERR_NET' }));
  else if (m.ev === 'close') { s.closed = true; sockets.delete(m.id); s.emit('close'); }
}

function makeGc(info) {
  const log = (level) => (...a) => send({ t: 'log', level, message: fmt(a) });
  return Object.freeze({
    plugin: Object.freeze({ id: info.id, version: info.version }),
    log: Object.freeze({ debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }),
    http: Object.freeze({
      /**
       * fetch(url, { method, headers, body | json | form | bodyBase64, binary, timeoutMs, redirect: 'manual'|'follow' })
       *   → { status, headers (set-cookie as a list), body | bodyBase64, url, redirects }
       */
      fetch: (url, opts) => hostCall('http.fetch', { url: String(url), opts: opts || {} }),
    }),
    net: Object.freeze({
      /** Home-network targets an administrator assigned: [{ id, protocols, assigned: [{ index, label }] }] */
      targets: () => hostCall('targets.list', {}),
      /** fetchTarget(id, '/path', { index, method, headers, body | json | form, binary, timeoutMs, redirect }) — HTTP to an assigned target */
      fetchTarget: (id, path, opts) => hostCall('target.fetch', { target: String(id), index: opts && opts.index, path: String(path || '/'), opts: opts || {} }),
      /** tcpTarget(id, { index, port, timeoutMs }) → socket (EventEmitter: data, close, error, timeout; write/end/destroy/setTimeout) */
      tcpTarget: async (id, opts) => {
        const o = opts || {};
        const r = await hostCall('target.tcp', { target: String(id), index: o.index, port: o.port, timeoutMs: o.timeoutMs });
        const sock = new PluginSocket(r.id, r);
        sockets.set(r.id, sock);
        return sock;
      },
      /** udpTarget(id, Buffer, { index, port, timeoutMs }) → [{ address, port, data }] answers of that target */
      udpTarget: async (id, data, opts) => {
        const o = opts || {};
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const list = await hostCall('target.udp', { target: String(id), index: o.index, port: o.port, dataBase64: buf.toString('base64'), timeoutMs: o.timeoutMs });
        return list.map((x) => ({ address: x.address, port: x.port, data: Buffer.from(x.dataBase64, 'base64') }));
      },
      /** discover(Buffer, { ports, timeoutMs, maxResponses, repeat }) → [{ address, port, data }] (localDiscovery, granted by an administrator) */
      discover: async (data, opts) => {
        const o = opts || {};
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const list = await hostCall('discover', { dataBase64: buf.toString('base64'), ports: o.ports, timeoutMs: o.timeoutMs, maxResponses: o.maxResponses, repeat: o.repeat });
        return list.map((x) => ({ address: x.address, port: x.port, data: Buffer.from(x.dataBase64, 'base64') }));
      },
    }),
    storage: Object.freeze({
      get: (key) => hostCall('storage.get', { key }),
      set: (key, value) => hostCall('storage.set', { key, value }),
      delete: (key) => hostCall('storage.delete', { key }),
      list: (prefix) => hostCall('storage.list', { prefix }),
    }),
    db: Object.freeze({
      query: (sql, params) => hostCall('db.query', { sql, params, mode: 'all' }),
      get: (sql, params) => hostCall('db.query', { sql, params, mode: 'get' }),
      run: (sql, params) => hostCall('db.query', { sql, params, mode: 'run' }),
      exec: (sql) => hostCall('db.exec', { sql }),
    }),
    settings: Object.freeze({
      get: (key) => hostCall('settings.get', { key }),
      all: () => hostCall('settings.all', {}),
      set: (key, value) => hostCall('settings.set', { key, value }),
    }),
    users: Object.freeze({
      list: () => hostCall('users.list', {}),
      get: (id) => hostCall('users.get', { id }),
    }),
    notify: (message, opts) => hostCall('notify', { message: String(message), opts: opts || {} }),
    license: Object.freeze({ status: () => hostCall('license.status', {}) }),
  });
}

let plugin = null;
let gc = null;

async function handleCall(method, payload) {
  if (!plugin) throw new Error('plugin not loaded');
  switch (method) {
    case 'request':
      if (typeof plugin.request !== 'function') return { status: 404, json: { ok: false, error: 'not_found' } };
      return plugin.request(payload, gc);
    case 'render':
      if (typeof plugin.render !== 'function') return { html: '' };
      return plugin.render(payload, gc);
    case 'tick':
      if (typeof plugin.tick === 'function') await plugin.tick(gc);
      return {};
    case 'settingsChanged':
      if (typeof plugin.settingsChanged === 'function') await plugin.settingsChanged(payload, gc);
      return {};
    default:
      throw new Error('unknown method');
  }
}

function safeValue(v) {
  // only plain JSON crosses the channel
  try { return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch { return null; }
}

async function init(info) {
  lockdown();
  gc = makeGc(info);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    // eslint-disable-next-line no-console
    console[level] = (...a) => send({ t: 'log', level: level === 'log' ? 'info' : level, message: fmt(a) });
  }
  let mod = require(info.entry);
  if (mod && mod.__esModule && mod.default) mod = mod.default;
  if (typeof mod === 'function') mod = await mod(gc);
  plugin = mod && typeof mod === 'object' ? mod : {};
  if (typeof plugin.start === 'function') await plugin.start(gc);
  send({ t: 'ready' });
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'init') {
    init(msg.plugin).catch((e) => {
      send({ t: 'fatal', error: String((e && (e.stack || e.message)) || e).slice(0, 2000) });
      setTimeout(() => process.exit(1), 50);
    });
    return;
  }
  if (msg.t === 'hostResult') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value); else p.reject(Object.assign(new Error(msg.error || 'host call failed'), { code: msg.code || undefined }));
    return;
  }
  if (msg.t === 'call') {
    Promise.resolve()
      .then(() => handleCall(msg.method, msg.payload))
      .then((v) => send({ t: 'result', id: msg.id, ok: true, value: safeValue(v) }),
        (e) => send({ t: 'result', id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 500) }));
    return;
  }
  if (msg.t === 'sock') { onSocketEvent(msg); return; }
  if (msg.t === 'ping') { send({ t: 'pong', id: msg.id }); return; }
  if (msg.t === 'stop') {
    Promise.resolve()
      .then(() => (plugin && typeof plugin.stop === 'function' ? plugin.stop(gc) : null))
      .catch(() => {})
      .then(() => process.exit(0));
  }
});

process.on('uncaughtException', (e) => {
  send({ t: 'log', level: 'error', message: 'uncaught: ' + String((e && (e.stack || e.message)) || e).slice(0, 900) });
  setTimeout(() => process.exit(1), 20);
});
process.on('unhandledRejection', (e) => {
  send({ t: 'log', level: 'error', message: 'unhandled rejection: ' + String((e && (e.stack || e.message)) || e).slice(0, 900) });
});
process.on('disconnect', () => process.exit(0));
