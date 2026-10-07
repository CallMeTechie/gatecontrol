'use strict';

// The host API a plugin process calls over IPC (gc.* in child/bootstrap.js).
// Every call is checked against the plugin's plugin.json permissions here —
// the plugin process itself is never trusted.

const netPolicy = require('./netPolicy');
const storage = require('./storage');
const pluginSettings = require('./pluginSettings');
const licensing = require('./licensing');
const { LIMITS, TIMEOUTS } = require('./constants');

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const NOTIFY_PER_HOUR = 30;
const notifyWindow = new Map();

class HostApiError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function need(cond, code, msg) { if (!cond) throw new HostApiError(code, msg); }

function keyOf(args) {
  const k = args && args.key;
  need(typeof k === 'string' && k.length >= 1 && k.length <= 200, 'ERR_INVALID', 'invalid key');
  return k;
}

function policyOf(plugin) {
  return netPolicy.compile(plugin.manifest.permissions || {});
}

function netOpts() {
  const o = {};
  if (module.exports._lookup) o.lookup = module.exports._lookup;
  return o;
}

const targets = require('./targets');

function encodeBody(o) {
  if (typeof o.bodyBase64 === 'string') return { body: Buffer.from(o.bodyBase64, 'base64') };
  if (o.form && typeof o.form === 'object') {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(o.form)) sp.append(k, v == null ? '' : String(v));
    return { body: sp.toString(), type: 'application/x-www-form-urlencoded' };
  }
  if (o.json !== undefined) return { body: JSON.stringify(o.json), type: 'application/json' };
  if (o.body != null) return { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body), type: typeof o.body === 'string' ? null : 'application/json' };
  return { body: null };
}

function fetchOptions(o) {
  const method = String(o.method || 'GET').toUpperCase();
  need(METHODS.has(method), 'ERR_INVALID', 'invalid method');
  const { body, type } = encodeBody(o);
  need(body == null || Buffer.byteLength(body) <= LIMITS.fetchRequestBytes, 'ERR_INVALID', 'request body too large');
  const headers = { ...(o.headers && typeof o.headers === 'object' ? o.headers : {}) };
  if (type && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = type;
  const timeoutMs = Math.max(1000, Math.min(60000, Number(o.timeoutMs) || 15000));
  return { method, headers, body, timeoutMs, maxBytes: LIMITS.fetchResponseBytes, redirect: o.redirect === 'follow' ? 'follow' : 'manual' };
}

function fetchResult(res, o) {
  // Header names lower-case; set-cookie stays a list (login flows keep their own cookie jar).
  const outHeaders = {};
  for (const [k, v] of Object.entries(res.headers || {})) outHeaders[k] = k === 'set-cookie' ? [].concat(v) : (Array.isArray(v) ? v.join(', ') : String(v));
  const base = { status: res.status, headers: outHeaders, url: res.url, redirects: res.redirects };
  return o.binary ? { ...base, bodyBase64: res.body.toString('base64') } : { ...base, body: res.body.toString('utf8') };
}

function netError(e) {
  const denied = e && (e.code === 'ERR_NET_DENIED' || e instanceof targets.TargetError);
  return new HostApiError(denied ? 'ERR_NET_DENIED' : 'ERR_NET', String((e && e.message) || e).slice(0, 200));
}

/** gc.http.fetch: internet hosts of plugin.json only, public addresses only. */
async function httpFetch(plugin, args) {
  const url = args && args.url;
  need(typeof url === 'string' && url.length <= 8192, 'ERR_INVALID', 'invalid url');
  const o = (args && args.opts) || {};
  let res;
  try {
    res = await netPolicy.fetchWithPolicy(policyOf(plugin), url, { ...fetchOptions(o), ...netOpts() });
  } catch (e) { throw netError(e); }
  return fetchResult(res, o);
}

function targetArgs(args) {
  const id = args && args.target;
  need(typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id), 'ERR_INVALID', 'invalid target id');
  const index = args.index == null ? 0 : Number(args.index);
  need(Number.isInteger(index) && index >= 0 && index < 32, 'ERR_INVALID', 'invalid target index');
  return { id, index };
}

/** gc.net.fetchTarget(id, path, opts): an administrator-assigned home target. */
async function targetFetch(plugin, args) {
  const { id, index } = targetArgs(args);
  const path = String((args && args.path) || '/');
  need(path.startsWith('/') && path.length <= 4096 && !/[\s\\]/.test(path), 'ERR_INVALID', 'path must start with /');
  const o = (args && args.opts) || {};
  let ep;
  try { ep = await targets.resolve(plugin, id, index, 'http', netOpts()); } catch (e) { throw netError(e); }
  const hostPart = ep.host.includes(':') ? `[${ep.host}]` : ep.host;
  const base = new URL(`${ep.scheme}://${hostPart}:${ep.port}`);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new HostApiError('ERR_INVALID', 'path leaves the target');
  const opts = fetchOptions(o);
  // the route's headers (gateway domain) win over the plugin's
  for (const k of Object.keys(opts.headers)) if (ep.headers[k.toLowerCase()] !== undefined) delete opts.headers[k];
  Object.assign(opts.headers, ep.headers);
  const check = async (u) => {
    const next = new URL(u);
    if (next.origin !== base.origin) return { ok: false, reason: 'redirect_off_target' };
    return { ok: true, url: next, port: ep.port, address: ep.address, family: ep.family };
  };
  let res;
  try { res = await netPolicy.fetchWithPolicy(null, url.href, { ...opts, check }); } catch (e) { throw netError(e); }
  return fetchResult(res, o);
}

// ─── TCP (proxied sockets) and UDP discovery ────

const MAX_SOCKETS = 16;
const MAX_WRITE_BUFFER = 1024 * 1024;
const sockets = new Map(); // plugin id → Map<socketId, net.Socket>
let socketSeq = 0;

function socketsOf(id) {
  let m = sockets.get(id);
  if (!m) { m = new Map(); sockets.set(id, m); }
  return m;
}

/** Close every socket of a plugin (process ended, stopped, uninstalled). */
function closeSockets(id) {
  const m = sockets.get(id);
  if (!m) return;
  for (const s of m.values()) s.destroy();
  sockets.delete(id);
}

async function tcpConnect(plugin, args, ctx) {
  need(ctx && typeof ctx.emit === 'function', 'ERR_INVALID', 'no event channel');
  const m = socketsOf(plugin.id);
  need(m.size < MAX_SOCKETS, 'ERR_BUSY', 'too many open sockets');
  const { id: tid, index } = targetArgs(args);
  const timeoutMs = Math.max(500, Math.min(30000, Number(args.timeoutMs) || 10000));
  let sock;
  try {
    const ep = await targets.resolve(plugin, tid, index, 'tcp', { ...netOpts(), port: args.port });
    sock = await netPolicy.tcpConnect(ep, { timeoutMs });
  } catch (e) { throw netError(e); }
  const id = ++socketSeq;
  m.set(id, sock);
  sock.setTimeout(120000);
  sock.on('data', (d) => ctx.emit({ t: 'sock', id, ev: 'data', b64: d.toString('base64') }));
  sock.on('timeout', () => ctx.emit({ t: 'sock', id, ev: 'timeout' }));
  sock.on('error', (e) => ctx.emit({ t: 'sock', id, ev: 'error', error: String(e.message).slice(0, 200) }));
  sock.on('close', () => { m.delete(id); ctx.emit({ t: 'sock', id, ev: 'close' }); });
  return { id, remoteAddress: sock.remoteAddress, remotePort: sock.remotePort };
}

function sockOf(plugin, args) {
  const s = socketsOf(plugin.id).get(Number(args && args.id));
  need(s, 'ERR_INVALID', 'unknown socket');
  return s;
}

function tcpWrite(plugin, args) {
  const s = sockOf(plugin, args);
  need(typeof args.b64 === 'string' && args.b64.length <= 2 * 1024 * 1024, 'ERR_INVALID', 'invalid data');
  need(s.writableLength <= MAX_WRITE_BUFFER, 'ERR_BUSY', 'socket write buffer full');
  return new Promise((resolve, reject) => {
    s.write(Buffer.from(args.b64, 'base64'), (e) => (e ? reject(new HostApiError('ERR_NET', e.message)) : resolve(null)));
  });
}

function datagram(args) {
  need(typeof args.dataBase64 === 'string' && args.dataBase64.length <= 8192, 'ERR_INVALID', 'invalid datagram');
  return {
    data: Buffer.from(args.dataBase64, 'base64'), timeoutMs: Number(args.timeoutMs) || 3000,
    maxResponses: Math.max(1, Math.min(256, Number(args.maxResponses) || 64)), repeat: Number(args.repeat) || 1,
  };
}

function wrapFound(found) {
  return found.map((f) => ({ address: f.address, port: f.port, dataBase64: f.data.toString('base64') }));
}

/** gc.net.discover: UDP broadcast in the server's local networks — declared ports, granted by an administrator. */
async function discover(plugin, args) {
  const decl = targets.discoveryDecl(plugin);
  need(decl, 'ERR_NET_DENIED', 'plugin.json declares no localDiscovery');
  need(targets.discoveryGranted(plugin.id), 'ERR_NET_DENIED', 'local discovery is not granted by an administrator');
  const ports = Array.isArray(args && args.ports) ? args.ports.map(Number) : [];
  try {
    return wrapFound(await netPolicy.udpExchange(netPolicy.parsePorts(decl.udp), { ports, ...datagram(args), targets: module.exports._udpTargets || undefined }));
  } catch (e) { throw netError(e); }
}

/** gc.net.udpTarget: datagram to an assigned home target, answers from it only. */
async function udpTarget(plugin, args) {
  const { id, index } = targetArgs(args);
  try {
    const ep = await targets.resolve(plugin, id, index, 'udp', { ...netOpts(), port: args.port });
    return wrapFound(await netPolicy.udpExchange([[ep.port, ep.port]], { ports: [ep.port], ...datagram(args), targets: [ep.address], acceptFrom: (ip) => ip === ep.address }));
  } catch (e) { throw netError(e); }
}

function needStorage(plugin) {
  need(plugin.manifest.permissions && plugin.manifest.permissions.storage, 'ERR_STORAGE_DENIED', 'this plugin has no storage permission');
  return storage.forPlugin(plugin.id);
}

function db() { return require('../../db/connection').getDb(); }

function userView(u) {
  return u ? { id: u.id, name: u.display_name || u.username, role: u.role } : null;
}

function notify(plugin, args) {
  need(plugin.manifest.permissions && plugin.manifest.permissions.notify, 'ERR_NOTIFY_DENIED', 'this plugin has no notify permission');
  const msg = String((args && args.message) || '').replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 300);
  need(msg, 'ERR_INVALID', 'empty message');
  const now = Date.now();
  const w = (notifyWindow.get(plugin.id) || []).filter((t) => now - t < 3600000);
  need(w.length < NOTIFY_PER_HOUR, 'ERR_RATE_LIMIT', 'too many notifications');
  w.push(now);
  notifyWindow.set(plugin.id, w);
  const sev = args && args.opts && ['info', 'success', 'warning', 'error'].includes(args.opts.severity) ? args.opts.severity : 'info';
  require('../activity').log('plugin_notice', `${plugin.name}: ${msg}`, { source: 'plugin', severity: sev, details: { plugin: plugin.id } });
  return {};
}

/**
 * @param {object} plugin  registry entry (with manifest)
 * @param {string} api
 * @param {object} args
 */
async function handle(plugin, api, args, ctx) {
  switch (api) {
    case 'http.fetch': return httpFetch(plugin, args);
    case 'target.tcp': return tcpConnect(plugin, args, ctx);
    case 'tcp.write': return tcpWrite(plugin, args);
    case 'tcp.end': sockOf(plugin, args).end(); return null;
    case 'tcp.destroy': sockOf(plugin, args).destroy(); return null;
    case 'tcp.setTimeout': sockOf(plugin, args).setTimeout(Math.max(0, Math.min(3600000, Number(args.ms) || 0))); return null;
    case 'target.fetch': return targetFetch(plugin, args);
    case 'target.udp': return udpTarget(plugin, args);
    case 'targets.list': return targets.listFor(plugin);
    case 'discover': return discover(plugin, args);
    case 'storage.get': return (await needStorage(plugin).call('kv.get', { key: keyOf(args) })).value;
    case 'storage.set': await needStorage(plugin).call('kv.set', { key: keyOf(args), value: args.value }); return null;
    case 'storage.delete': return (await needStorage(plugin).call('kv.delete', { key: keyOf(args) })).deleted > 0;
    case 'storage.list': return (await needStorage(plugin).call('kv.list', { prefix: typeof args.prefix === 'string' ? args.prefix.slice(0, 200) : '' })).keys;
    case 'db.query': {
      const mode = ['all', 'get', 'run'].includes(args.mode) ? args.mode : 'all';
      return needStorage(plugin).call('query', { sql: args.sql, params: args.params, mode }, TIMEOUTS.db);
    }
    case 'db.exec': await needStorage(plugin).call('exec', { sql: args.sql }, TIMEOUTS.db); return null;
    case 'settings.all': return pluginSettings.forPlugin(plugin);
    case 'settings.get': { const all = await pluginSettings.forPlugin(plugin); const k = keyOf(args); return all[k] === undefined ? null : all[k]; }
    case 'settings.set': {
      const r = await pluginSettings.save(plugin, { [keyOf(args)]: args.value === undefined ? null : args.value }, { fromPlugin: true });
      if (!r.ok) throw new HostApiError('ERR_INVALID', 'invalid setting');
      return null;
    }
    case 'users.list':
      need(plugin.manifest.permissions && plugin.manifest.permissions.users, 'ERR_USERS_DENIED', 'this plugin has no users permission');
      return db().prepare('SELECT id, username, display_name, role FROM users WHERE enabled = 1 ORDER BY id LIMIT 5000').all().map(userView);
    case 'users.get': {
      need(plugin.manifest.permissions && plugin.manifest.permissions.users, 'ERR_USERS_DENIED', 'this plugin has no users permission');
      const id = Number(args && args.id);
      need(Number.isInteger(id) && id > 0, 'ERR_INVALID', 'invalid user id');
      return userView(db().prepare('SELECT id, username, display_name, role FROM users WHERE id = ? AND enabled = 1').get(id));
    }
    case 'notify': return notify(plugin, args);
    case 'license.status': {
      const s = licensing.status(plugin);
      return { required: s.required, licensed: s.licensed, state: s.state, expiresAt: s.expiresAt || null };
    }
    default:
      throw new HostApiError('ERR_UNKNOWN_API', 'unknown host API');
  }
}

module.exports = { handle, closeSockets, HostApiError, _lookup: null, _udpTargets: null };
