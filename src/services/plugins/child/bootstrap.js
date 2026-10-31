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

// `timeoutMs`: longer for the calls moving big files (the host allows them as long, hostApi.callTimeout)
function hostCall(api, args, timeoutMs = HOST_TIMEOUT_MS) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`host call ${api} timed out`)); }, Math.max(HOST_TIMEOUT_MS, timeoutMs));
    pending.set(id, { resolve, reject, timer });
    send({ t: 'host', id, api, args: args === undefined ? {} : args });
  });
}

// gc.ai.extract / generate: the host allows twice the request's time limit (+ 15 s), so does the child
function aiTimeout(opts) {
  const t = opts && Number.isFinite(opts.timeoutMs) ? Math.max(1000, Math.min(180000, opts.timeoutMs)) : 60000;
  return 2 * t + 20000;
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

// Proxied WebSockets (gc.http.websocket): the host holds the real connection.
const websockets = new Map();

class PluginWebSocket extends EventEmitter {
  constructor(id, info) {
    super();
    this.id = id;
    this.protocol = info.protocol || '';
    this.closed = false;
  }
  /** send(string | Buffer): text frames for strings, binary frames for Buffers */
  send(data) {
    if (Buffer.isBuffer(data)) return hostCall('ws.send', { id: this.id, b64: data.toString('base64') });
    return hostCall('ws.send', { id: this.id, text: String(data) });
  }
  close(code, reason) { return hostCall('ws.close', { id: this.id, code, reason }).catch(() => null); }
}

function onWebSocketEvent(m) {
  const w = websockets.get(m.id);
  if (!w) return;
  if (m.ev === 'message') w.emit('message', typeof m.b64 === 'string' ? Buffer.from(m.b64, 'base64') : String(m.text || ''));
  else if (m.ev === 'error') w.emit('error', Object.assign(new Error(m.error || 'websocket error'), { code: 'ERR_NET' }));
  else if (m.ev === 'close') { w.closed = true; websockets.delete(m.id); w.emit('close', m.code, m.reason || ''); }
}

// IMAP sessions of gc.mail (since 1.216.0): the host holds the connection,
// this is its proxy. Every method is one host call; events of the session
// (exists, expunge, flags, close, error) arrive as { t: 'mail', id, ev, data }.
const mailSessions = new Map();
const MAIL_LONG_MS = 11 * 60 * 1000;

class MailSession extends EventEmitter {
  constructor(r) {
    super();
    this.id = r.id;
    this.capabilities = Array.isArray(r.capabilities) ? r.capabilities.slice() : [];
    this.serverInfo = r.serverInfo || null;
    this.closed = false;
  }
  _call(op, args, long) { return hostCall('mail.imap.call', { id: this.id, op, args }, long ? MAIL_LONG_MS : 3 * 60 * 1000); }
  list() { return this._call('list', []); }
  status(path, query) { return this._call('status', [path, query == null ? null : query]); }
  open(path, opts) { return this._call('open', [path, opts == null ? {} : opts]); }
  fetch(range, query) { return this._call('fetch', [range, query == null ? {} : query], true); }
  message(uid, opts) { return this._call('message', [uid, opts == null ? {} : opts], true); }
  download(uid, partId, opts) { return this._call('download', [uid, partId, opts == null ? {} : opts], true); }
  search(query) { return this._call('search', [query], true); }
  flags(range, opts) { return this._call('flags', [range, opts == null ? {} : opts]); }
  move(range, path) { return this._call('move', [range, path], true); }
  copy(range, path) { return this._call('copy', [range, path], true); }
  expunge(range) { return this._call('expunge', [range], true); }
  append(path, mediaId, opts) { return this._call('append', [path, mediaId, opts == null ? {} : opts], true); }
  idle() { return this._call('idle', []); }
  noop() { return this._call('noop', []); }
  close() {
    if (this.closed) return Promise.resolve(null);
    this.closed = true;
    mailSessions.delete(this.id);
    return hostCall('mail.imap.close', { id: this.id }).catch(() => null);
  }
}

function onMailEvent(m) {
  const s = mailSessions.get(m.id);
  if (!s) return;
  if (m.ev === 'close') { s.closed = true; mailSessions.delete(m.id); s.emit('close'); return; }
  if (m.ev === 'error') {
    const d = m.data || {};
    // without a listener an 'error' event would end the plugin process
    if (s.listenerCount('error')) s.emit('error', Object.assign(new Error(d.message || 'mail session error'), { code: d.code || 'ERR_MAIL_PROTOCOL' }));
    return;
  }
  if (m.ev === 'exists' || m.ev === 'expunge' || m.ev === 'flags') s.emit(m.ev, m.data || {});
}

/** gc.mail — only for plugins with permissions.mail (else undefined); gc.mail.dav only with permissions.mail.dav. */
function makeMail(features) {
  return Object.freeze({
    imap: Object.freeze({
      /**
       * connect({ host, port, security: 'tls' | 'starttls', auth: { user, pass } | { user, accessToken }, timeoutMs })
       *   → session (EventEmitter: exists, expunge, flags, close, error; list, status, open, fetch, message, download,
       *   search, flags, move, copy, expunge, append, idle, noop, close)
       */
      connect: async (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        const t = Number.isFinite(o.timeoutMs) ? Math.min(60000, o.timeoutMs) : 30000;
        const r = await hostCall('mail.imap.connect', { host: o.host, port: o.port, security: o.security, auth: o.auth, timeoutMs: o.timeoutMs }, t + 15000);
        const s = new MailSession(r);
        mailSessions.set(r.id, s);
        return s;
      },
    }),
    smtp: Object.freeze({
      /** send({ host, port, security, auth, message, appendCopy, timeoutMs }) → { messageId, accepted, rejected, raw } */
      send: (opts) => hostCall('mail.smtp.send', opts && typeof opts === 'object' ? opts : {}, MAIL_LONG_MS),
      /** verify({ host, port, security, auth, timeoutMs }) → { ok: true } — log in without sending (since 1.217.0) */
      verify: (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        const t = Number.isFinite(o.timeoutMs) ? Math.min(60000, o.timeoutMs) : 30000;
        return hostCall('mail.smtp.verify', { host: o.host, port: o.port, security: o.security, auth: o.auth, timeoutMs: o.timeoutMs }, t + 4 * 60 * 1000);
      },
    }),
    /** compose(message) → { mediaId, bytes, messageId } (RFC 822, unclaimed media) */
    compose: (message) => hostCall('mail.compose', { message }, 3 * 60 * 1000),
    /** parse(mediaId, { attachments: 'meta' | 'media', maxBytes }) → like session.message */
    parse: (mediaId, opts) => hostCall('mail.parse', { mediaId, opts: opts == null ? {} : opts }, 3 * 60 * 1000),
    /** sanitize(html, { images: 'placeholder' }) → { html, images: [url], trackers } */
    sanitize: (html, opts) => hostCall('mail.sanitize', { html, opts: opts == null ? {} : opts }, 3 * 60 * 1000),
    /** autoconfig(email) → { imap, smtp, caldav, carddav, source } */
    autoconfig: (email) => hostCall('mail.autoconfig', { email }, 45000),
    // since 1.219.0 (permissions.mail.dav): CalDAV/CardDAV to the servers people enter
    ...(features.dav ? {
      dav: Object.freeze({
        /**
         * request({ url, method, headers, body, auth: { user, pass } | { bearer }, timeoutMs, maxBytes, parse: 'auto' | 'none' })
         *   → { status, url, headers, body, multistatus: { responses, syncToken } | null }
         */
        request: (opts) => {
          const o = opts && typeof opts === 'object' ? opts : {};
          const t = Number.isFinite(o.timeoutMs) ? Math.min(60000, o.timeoutMs) : 30000;
          return hostCall('mail.dav.request', { url: o.url, method: o.method, headers: o.headers, body: o.body, auth: o.auth, timeoutMs: o.timeoutMs,
            maxBytes: o.maxBytes, parse: o.parse }, t + 3 * 60 * 1000);
        },
      }),
    } : {}),
  });
}

function makeGc(info) {
  const log = (level) => (...a) => send({ t: 'log', level, message: fmt(a) });
  const features = info.features && typeof info.features === 'object' ? info.features : {};
  /**
   * fetchImage(url, { maxBytes (≤ 5 MB, default 2 MB), timeoutMs (≤ 15000) }) → { status, mime, bytes (Buffer) } —
   * since 1.216.0, permissions.network.images: a picture of any public host, loaded by the host
   */
  const fetchImage = async (url, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const r = await hostCall('http.fetchImage', { url: String(url), opts: { maxBytes: o.maxBytes, timeoutMs: o.timeoutMs } }, 30000);
    return { status: r.status, mime: r.mime, bytes: Buffer.from(String(r.bytesBase64 || ''), 'base64') };
  };
  return Object.freeze({
    // permissions.mail (since 1.216.0, docs/plugins.md "Mail"): IMAP sessions, SMTP, MIME, HTML cleaning, autoconfig
    ...(features.mail ? { mail: makeMail(features) } : {}),
    plugin: Object.freeze({ id: info.id, version: info.version, filesDir: info.filesDir }), // filesDir: the one writable folder
    log: Object.freeze({ debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }),
    http: Object.freeze({
      /**
       * fetch(url, { method, headers, body | json | form | bodyBase64, binary, timeoutMs, redirect: 'manual'|'follow' })
       *   → { status, headers (set-cookie as a list), body | bodyBase64, url, redirects }
       * since 1.217.0 also bodyMedia: { mediaId, start, end, encoding: 'base64' } — a media file of the plugin as
       *   the body, streamed by the host (base64 into the one `json` value MEDIA_BASE64); waits up to timeoutMs (≤ 30 min)
       */
      fetch: (url, opts) => {
        const o = opts || {};
        const long = o.bodyMedia != null ? (Number.isFinite(o.timeoutMs) ? Math.max(1000, Math.min(30 * 60 * 1000, o.timeoutMs)) : 10 * 60 * 1000) + 15000 : undefined;
        return hostCall('http.fetch', { url: String(url), opts: o }, long);
      },
      /** the `json` value http.fetch replaces with the bodyMedia file in base64 (since 1.217.0; the feature test) */
      MEDIA_BASE64: '{{gc:media:base64}}',
      /**
       * websocket(url, { headers, protocols, timeoutMs }) → an open WebSocket to an internet host of
       * plugin.json (EventEmitter: message (string | Buffer), close (code, reason), error; send, close)
       */
      websocket: async (url, opts) => {
        const o = opts || {};
        const r = await hostCall('ws.connect', { url: String(url), opts: { headers: o.headers, protocols: o.protocols, timeoutMs: o.timeoutMs } });
        const w = new PluginWebSocket(r.id, r);
        websockets.set(r.id, w);
        return w;
      },
      ...(features.images ? { fetchImage } : {}),
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
      /**
       * uploadTarget(id, '/path', { index, method: 'POST'|'PUT', query, headers, form: { fields, file: { field, mediaId, name, mime } },
       *   mediaFrom: { plugin, mediaId }, timeoutMs (≤ 30 min), binary }) — since 1.193.0: a multipart/form-data upload of a media
       *   file to an assigned target, streamed by the host → like fetchTarget
       */
      uploadTarget: (id, path, opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        const t = Number.isFinite(o.timeoutMs) ? Math.min(o.timeoutMs, 30 * 60 * 1000) : 10 * 60 * 1000;
        return hostCall('target.upload', { target: String(id), index: o.index, path: String(path || '/'), opts: o }, t + 10000);
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
      /** setSecret(key, string|null): a value of the plugin's own, stored encrypted with the server key (never shown in the UI) */
      setSecret: (key, value) => hostCall('settings.setSecret', { key, value: value == null ? null : String(value) }),
    }),
    users: Object.freeze({
      list: () => hostCall('users.list', {}),
      get: (id) => hostCall('users.get', { id }),
    }),
    /** permissions.kiosk: allow(userId, true|false) marks a user as a kiosk user; list() → [userId] */
    kiosk: Object.freeze({
      allow: (userId, allowed) => hostCall('kiosk.allow', { userId, allowed }),
      list: () => hostCall('kiosk.list', {}),
    }),
    /**
     * permissions.actions: quick actions of the other plugins for one user —
     * list({ userId, lang, interactive?, withWidget? }) → [{ actionId: '<plugin>/<id>', plugin, pluginName, id, label, title, subtitle, icon,
     *   kind, state, needsConfirm, confirmWhen, verbs, targets, device, widget? }]
     *   (widget { value, unit, label, badge, readings, state, status } | null only with withWidget: true);
     * get({ userId, actionId | plugin + id, lang, interactive?, withWidget? }) → one such entry or null (asks only that plugin);
     * run({ userId, actionId | plugin + id, params?: { state }, lang, state?, via?, interactive? })
     *   → { ok, message, state, unchanged, result?, code?, error? } (runs as that user;
     * state 'on'|'off': the state a toggle should end in; interactive: true — a person pressed
     * the button for this action in this plugin just now, needs permissions.actions { interactive: true })
     */
    actions: Object.freeze({
      list: (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('actions.list', { userId: o.userId, lang: o.lang, interactive: o.interactive, withWidget: o.withWidget });
      },
      get: (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('actions.get', { userId: o.userId, actionId: o.actionId, plugin: o.plugin, id: o.id, lang: o.lang, interactive: o.interactive, withWidget: o.withWidget });
      },
      run: (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('actions.run', { userId: o.userId, actionId: o.actionId, plugin: o.plugin, id: o.id, params: o.params, lang: o.lang, state: o.state, via: o.via, interactive: o.interactive });
      },
    }),
    /**
     * notify(message, { severity }) or notify({ topic, title, body, priority, users, devices, silent, collapseKey, ttl, data, image })
     * — image { data, mime } or { mediaId }; devices / silent (since 1.193.0, permissions.devices)
     */
    notify: Object.freeze(Object.assign((message, opts) => (message && typeof message === 'object' && !Array.isArray(message)
      ? hostCall('notify', { notification: message })
      : hostCall('notify', { message: String(message), opts: opts || {} })), {
      /**
       * permissions.notifySink (since 1.191.0): where a person's notifications appear —
       * get({ userId, lang }) → like GET /api/v1/me/notify/routes; set({ userId, topic, dest }) → like the PUT
       */
      routes: Object.freeze({
        get: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('notify.routes.get', { userId: o.userId, lang: o.lang }); },
        set: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('notify.routes.set', { userId: o.userId, topic: o.topic, dest: o.dest }); },
      }),
    })),
    // status() → { required, licensed, state, expiresAt }; since 1.206.0 info() → { required, valid, state,
    // expiresAt, source, tier, seats: { total, family, business, included, extra } | null } and refresh()
    // (fetch the licence now, e.g. after "Personen hinzubuchen"; at most once a minute) → { refreshed, …info }
    license: Object.freeze({
      status: () => hostCall('license.status', {}),
      info: () => hostCall('license.info', {}),
      refresh: () => hostCall('license.refresh', {}),
    }),
    /**
     * plugin.json `media`: files the users uploaded (PUT …/plugins/<id>/media, GC.upload) or the
     * plugin fetched — info(id) → { mediaId, mime, bytes, sha256, owner, createdAt, claimed, name } | null;
     * claim(id) keeps a new file (else removed after 24 h); delete(id) → boolean; usage() → { bytes,
     * count, quota, maxBytes, types, uploads }; url(id, { user, ttlS }) → '/plugin-media/<token>' for
     * frames; fetch(url, { headers, timeoutMs, mime, name, maxBytes }) → { mediaId, mime, bytes, name }
     * (since 1.190.0: a file from the internet, checked like http.fetch, unclaimed, no owner)
     */
    media: Object.freeze({
      info: (id) => hostCall('media.info', { id }),
      // since 1.204.0: claim(id, { area, path }) for plugins with media.areas
      claim: (id, opts) => hostCall('media.claim', opts == null ? { id } : { id, opts }),
      // since 1.204.1 (media.areas): move(id, { path, area }) → info; version(id) keeps the file as a version of its path → info;
      // since 1.207.0 move(versionId, { path }) restores a version, move(id, { path: null }) takes a file off its path
      move: (id, opts) => hostCall('media.move', { id, opts: opts == null ? {} : opts }),
      version: (id) => hostCall('media.version', { id }),
      areas: Object.freeze({
        ensure: (area, opts) => hostCall('media.areas.ensure', { area, opts: opts == null ? {} : opts }),
        info: (area) => hostCall('media.areas.info', { area }),
        list: () => hostCall('media.areas.list', {}),
        remove: (area) => hostCall('media.areas.remove', { area }),
        // since 1.204.1: scan(area) looks for changes made on the target now; changes(area, { since, limit }) reads the journal
        scan: (area) => hostCall('media.areas.scan', { area }),
        changes: (area, opts) => hostCall('media.areas.changes', { area, opts: opts == null ? {} : opts }),
      }),
      delete: (id) => hostCall('media.delete', { id }),
      usage: () => hostCall('media.usage', {}),
      url: (id, opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('media.url', { id, user: o.user, ttlS: o.ttlS }); },
      // since 1.208.0 (media.previews): previews(ids, { user, ttlS }) → { <id>: null | { ready, source, url, appUrl } };
      // since 1.210.0 { previewOnly: true }: URLs that open the preview only, never the file
      previews: (ids, opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('media.previews', { ids: Array.isArray(ids) ? ids : [], user: o.user, ttlS: o.ttlS, previewOnly: o.previewOnly });
      },
      fetch: (url, opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('media.fetch', { url: String(url), opts: { headers: o.headers, timeoutMs: o.timeoutMs, mime: o.mime, name: o.name, maxBytes: o.maxBytes } });
      },
      /**
       * handOver(id, { toPlugin, user }) → { mediaId, mime, bytes, name } — since 1.193.0: a new, unclaimed file of another
       * plugin (it must list one of that plugin's services in permissions.services)
       */
      handOver: (id, opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('media.handOver', { id, toPlugin: o.toPlugin, user: o.user }, 11 * 60 * 1000);
      },
      /**
       * copy(id, { area, path, claim, user }) → { id, mediaId, size, bytes, sha256, mime, name, area, path, claimed, method } —
       * since 1.215.0: a new, independent file of this plugin with the same bytes, copied on the server (on the storage
       * target itself where it can); unclaimed unless claim: true
       */
      copy: (id, opts) => hostCall('media.copy', { id, opts: opts == null ? {} : opts }, 32 * 60 * 1000),
    }),
    /**
     * permissions.publicLinks (since 1.193.0, only while an administrator allows them):
     * create({ title, note, files: [{ mediaId, name }], expiresAt, maxDownloads, pin, ownerUserId }) → { token, url, expiresAt };
     * list({ ownerUserId }) → [link]; get(token) → link | null; revoke(token) → boolean.
     * Since 1.205.0 create also takes kind ('files' | 'folder' | 'upload'), mode ('view' | 'download'),
     * area + path (folder / upload), expiresAt null (when allowed), maxFiles / maxBytes / types (upload);
     * events(token, { limit, before }) → the log; uploads(token) → the files that came in
     */
    publicLinks: Object.freeze({
      create: (opts) => hostCall('publicLinks.create', opts && typeof opts === 'object' ? opts : {}),
      list: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('publicLinks.list', { ownerUserId: o.ownerUserId }); },
      get: (token) => hostCall('publicLinks.get', { token }),
      revoke: (token) => hostCall('publicLinks.revoke', { token }),
      events: (token, opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('publicLinks.events', { token, limit: o.limit, before: o.before }); },
      uploads: (token) => hostCall('publicLinks.uploads', { token }),
    }),
    /**
     * permissions.ai (since 1.214.0, docs/plugins.md "AI requests"): the AI provider set up in GateControl.
     * available({ capability }) → boolean (asks no provider); status() → { available, mediaAllowed, capabilities, budgetLeftCents };
     * extract({ task, user, instructions, input: [{ type: 'text', label, text } | { type: 'media', mediaId }], schema,
     * maxOutputTokens, timeoutMs }) → { ok, data, provider, model, usage: { inputTokens, outputTokens, costCents }, fallback };
     * generate({ task, user, instructions, input, maxOutputTokens, timeoutMs }) → { ok, text, provider, model, usage, fallback }
     */
    ai: Object.freeze({
      available: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('ai.available', { capability: o.capability }); },
      status: () => hostCall('ai.status', {}),
      extract: (opts) => hostCall('ai.extract', opts && typeof opts === 'object' ? opts : {}, aiTimeout(opts)),
      generate: (opts) => hostCall('ai.generate', opts && typeof opts === 'object' ? opts : {}, aiTimeout(opts)),
    }),
    /**
     * permissions.publicEndpoints (since 1.211.0): requests without a session under /plugin-public/<id>/…, each with
     * a token of token({ user, path, ttlS, data }) → { token, url, expiresAt }; base() → { url } of the prefix
     * (null without GC_BASE_URL). The hook publicRequest answers them.
     */
    publicEndpoints: Object.freeze({
      token: (opts) => hostCall('publicEndpoints.token', opts && typeof opts === 'object' ? opts : {}),
      base: () => hostCall('publicEndpoints.base', {}),
    }),
    /** permissions.devices (since 1.193.0): list({ userId }) → [{ id, name, platform, clientType, appVersion, online, lastSeen, via }] */
    devices: Object.freeze({
      list: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('devices.list', { userId: o.userId }); },
    }),
    /**
     * permissions.cloudImport: Google Drive / OneDrive of a person (docs/plugins.md "Cloud import") —
     * available() → { google, microsoft }; connectUrl({ user, provider, returnTo }) → { url };
     * connections({ user }) → [{ id, provider, account, connectedAt }]; disconnect({ user, connection }) → boolean;
     * list({ user, connection, folderId, cursor }) → { items: [{ id, name, isDir, size, mime, modifiedAt }], next };
     * import({ user, connection, fileId }) → { mediaId, name, size, mime, modifiedAt } (unclaimed, like gc.media.fetch)
     */
    cloud: Object.freeze({
      available: () => hostCall('cloud.available', {}),
      connectUrl: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('cloud.connectUrl', { user: o.user, provider: o.provider, returnTo: o.returnTo }); },
      connections: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('cloud.connections', { user: o.user }); },
      disconnect: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('cloud.disconnect', { user: o.user, connection: o.connection }); },
      list: (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('cloud.list', { user: o.user, connection: o.connection, folderId: o.folderId, cursor: o.cursor });
      },
      import: (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('cloud.import', { user: o.user, connection: o.connection, fileId: o.fileId }, 32 * 60 * 1000);
      },
    }),
    /**
     * permissions.groups ("read" | "manage"): person groups of GateControl —
     * list({ userId, kind, includeInherited, includeArchived }) → [{ id, name, path, kind, role?, direct?, source, archived, … }];
     * get(id) → group | null; members(id, { nested, roles }) → [{ userId, name, role, direct, source, groupId, enabled }];
     * isMember(userId, groupId, { nested }) → boolean; leadersOf(userId, { groupId }) → [{ userId, name, role, groupId }];
     * "manage" only: ensure({ key, name, kind, parentKey, members: [{ userId, role }] }) → the plugin's own group
     * (+ created, added, removed, changed); remove(key) → boolean
     */
    groups: Object.freeze({
      list: (opts) => {
        const o = opts && typeof opts === 'object' ? opts : {};
        return hostCall('groups.list', { userId: o.userId, kind: o.kind, includeInherited: o.includeInherited, includeArchived: o.includeArchived });
      },
      get: (id) => hostCall('groups.get', { id }),
      members: (id, opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('groups.members', { id, nested: o.nested, roles: o.roles }); },
      isMember: (userId, groupId, opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('groups.isMember', { userId, groupId, nested: o.nested }); },
      leadersOf: (userId, opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('groups.leadersOf', { userId, groupId: o.groupId }); },
      ensure: (spec) => {
        const o = spec && typeof spec === 'object' ? spec : {};
        return hostCall('groups.ensure', { key: o.key, name: o.name, kind: o.kind, parentKey: o.parentKey, members: o.members });
      },
      remove: (key) => hostCall('groups.remove', { key }, 50000),
    }),
    /** permissions.events: emit({ users: [ids], type, data }) → { delivered } — realtime, not stored */
    events: Object.freeze({
      emit: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('events.emit', { users: o.users, type: o.type, data: o.data }); },
    }),
    /**
     * permissions.services: call({ plugin, service, userId, payload }) → the providing plugin's answer;
     * available(plugin, service) (or ({ plugin, service })) → boolean: would call() reach the provider
     * now — not run, not counted in the budget
     */
    services: Object.freeze({
      call: (opts) => { const o = opts && typeof opts === 'object' ? opts : {}; return hostCall('services.call', { plugin: o.plugin, service: o.service, userId: o.userId, payload: o.payload }); },
      available: (pluginId, service) => {
        const o = pluginId && typeof pluginId === 'object' ? pluginId : { plugin: pluginId, service };
        return hostCall('services.available', { plugin: o.plugin, service: o.service });
      },
    }),
  });
}

let plugin = null;
let gc = null;
let tickRunning = false; // a background tick is running (see call "tick")

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
      // one tick at a time: a tick the host gave up on (timeout) may still be
      // running here — the next one is skipped until it ends
      if (typeof plugin.tick !== 'function') return {};
      if (tickRunning) return { skipped: true };
      tickRunning = true;
      try { await plugin.tick(gc); } finally { tickRunning = false; }
      return {};
    case 'settingsChanged':
      if (typeof plugin.settingsChanged === 'function') await plugin.settingsChanged(payload, gc);
      return {};
    case 'settingsStatus':
      // optional (since 1.185.0): status lines of the settings form, e.g. an account's sign-in
      return typeof plugin.settingsStatus === 'function' ? plugin.settingsStatus(payload, gc) : [];
    case 'portalVisible':
      // optional: hide the portal tab / a section (payload.section) for viewers with nothing to see
      if (typeof plugin.portalVisible !== 'function') return { visible: true };
      return { visible: (await plugin.portalVisible(payload, gc)) !== false };
    case 'appVisible':
      // optional: hide the app tab (ui.app) for a viewer; payload = the viewer itself
      if (typeof plugin.appVisible !== 'function') return { visible: true };
      return { visible: (await plugin.appVisible(payload, gc)) !== false };
    case 'portalTiles':
      // optional: declarative Start-tab tiles for the viewer (rendered by the host)
      return typeof plugin.portalTiles === 'function' ? plugin.portalTiles(payload, gc) : [];
    case 'portalSearch':
      // optional: declarative portal search results for the viewer
      return typeof plugin.portalSearch === 'function' ? plugin.portalSearch(payload, gc) : [];
    case 'quickActions':
      // optional: declarative quick actions of the apps for the viewer (shortcuts, tiles, widget)
      return typeof plugin.quickActions === 'function' ? plugin.quickActions(payload, gc) : [];
    case 'runQuickAction':
      // runs one of the actions quickActions listed for that viewer (the host checked the id)
      if (typeof plugin.runQuickAction !== 'function') throw new Error('this plugin has no quick actions');
      return plugin.runQuickAction(payload, gc);
    case 'notifyAction':
      // optional: a person pressed a `callback` button of one of this plugin's pushes
      // ({ userId, notificationId, action, data }); called once per push and button, the answer is ignored
      if (typeof plugin.notifyAction === 'function') await plugin.notifyAction(payload, gc);
      return {};
    case 'mediaAccess':
      // optional (plugin.json `media`): may payload.user see media payload.mediaId? No hook → null
      // (the host then allows the uploader only)
      if (typeof plugin.mediaAccess !== 'function') return { allowed: null };
      return { allowed: (await plugin.mediaAccess(payload, gc)) === true };
    case 'deliverNotice':
      // optional (permissions.notifySink, since 1.191.0): notifications people route into chats
      // → { covered: [userIds] } (who got it in a chat; everyone else gets the inbox delivery)
      if (typeof plugin.deliverNotice !== 'function') return { covered: [] };
      return plugin.deliverNotice(payload, gc);
    case 'ensureNoticeChat':
      // optional (permissions.notifySink, since 1.192.0): a person chose "own chat" for a topic — the chat
      // of that source now ({ user, source, sourceLabel, lang }) → { conversationId, created } (null: none)
      if (typeof plugin.ensureNoticeChat !== 'function') return { chat: null };
      return { chat: (await plugin.ensureNoticeChat(payload, gc)) || null };
    case 'mayRouteToFamily':
      // optional (permissions.notifySink): may payload.user send topics to the family chat? No hook → no
      if (typeof plugin.mayRouteToFamily !== 'function') return { allowed: false };
      return { allowed: (await plugin.mayRouteToFamily(payload, gc)) === true };
    case 'publicLinkEvent':
      // optional (permissions.publicLinks, since 1.193.0): { token, event: 'download'|'locked'|'expired', … }; the answer is ignored
      if (typeof plugin.publicLinkEvent === 'function') await plugin.publicLinkEvent(payload, gc);
      return {};
    case 'publicRequest':
      // optional (permissions.publicEndpoints, since 1.211.0): a request with one of the plugin's tokens —
      // { method, path, query, headers, user, token, body, url, originalUrl } → { status, headers, json | text | media | form }
      if (typeof plugin.publicRequest !== 'function') return { status: 404, text: 'not found' };
      return plugin.publicRequest(payload, gc);
    case 'mediaChanged':
      // optional (media.areas, since 1.204.1): files changed on a storage target were taken in —
      // { area, seq, count }; read them with gc.media.areas.changes(area, { since }). Answer ignored
      if (typeof plugin.mediaChanged === 'function') await plugin.mediaChanged(payload, gc);
      return {};
    case 'groupsChanged':
      // optional (permissions.groups): { changes: [{ type, groupId, userId?, role?, reason? }] }, batched ≤ 1×/s; answer ignored
      if (typeof plugin.groupsChanged === 'function') await plugin.groupsChanged(payload, gc);
      return {};
    case 'groupUsage':
      // optional (permissions.groups): what the plugin keeps for payload.groupId → [{ kind, label, onDelete }]
      return typeof plugin.groupUsage === 'function' ? plugin.groupUsage(payload, gc) : [];
    case 'groupDeleting':
      // optional (permissions.groups): { groupId, successorUserId } — clean up before the group goes (≤ 30 s)
      if (typeof plugin.groupDeleting === 'function') await plugin.groupDeleting(payload, gc);
      return {};
    case 'service':
      // a service of services.provides called by another plugin (gc.services.call): { name, caller, user, payload }
      if (typeof plugin.service !== 'function') throw new Error('this plugin offers no services');
      return { result: await plugin.service(payload, gc) };
    case 'legacyImport':
      // built-in data handed over once by the host (first-party plugins only, src/services/plugins/legacy.js)
      if (typeof plugin.legacyImport !== 'function') throw new Error('this plugin cannot import built-in data');
      return plugin.legacyImport(payload, gc);
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
    if (msg.ok) p.resolve(msg.value);
    else {
      p.reject(Object.assign(new Error(msg.error || 'host call failed'), { code: msg.code || undefined }, Number.isInteger(msg.status) ? { status: msg.status } : {},
        typeof msg.serverText === 'string' ? { serverText: msg.serverText } : {}));
    }
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
  if (msg.t === 'ws') { onWebSocketEvent(msg); return; }
  if (msg.t === 'mail') { onMailEvent(msg); return; }
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
