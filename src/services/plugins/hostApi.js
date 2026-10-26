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
const { NOTIFY_PER_HOUR_DEFAULT, NOTIFY_PER_HOUR_MAX } = require('./manifest');
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

/** Close every socket and WebSocket of a plugin (process ended, stopped, uninstalled). */
function closeSockets(id) {
  const m = sockets.get(id);
  if (m) {
    for (const s of m.values()) s.destroy();
    sockets.delete(id);
  }
  const w = websockets.get(id);
  if (w) {
    for (const ws of w.values()) ws.terminate();
    websockets.delete(id);
  }
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

// ─── WebSocket (proxied; internet hosts of plugin.json) ──

const MAX_WEBSOCKETS = 8;
const WS_MAX_MESSAGE = 1024 * 1024;        // a message from the server (larger → closed, 1009)
const WS_MAX_SEND = 256 * 1024;            // a message from the plugin
const WS_MAX_BUFFER = 1024 * 1024;         // unsent data before send answers ERR_BUSY
const WS_MAX_PER_SECOND = 200;             // messages from the server per second (more → closed, 1008)
const WS_PROTOCOL_RE = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/i;
const websockets = new Map(); // plugin id → Map<wsId, WebSocket>

function websocketsOf(id) {
  let m = websockets.get(id);
  if (!m) { m = new Map(); websockets.set(id, m); }
  return m;
}

/**
 * gc.http.websocket(url, { headers, protocols, timeoutMs }): a ws:/wss: URL
 * checked like http.fetch (internet hosts of plugin.json, public addresses
 * only, pinned). Messages travel as events { t: 'ws', id, ev }.
 */
async function wsConnect(plugin, args, ctx) {
  need(ctx && typeof ctx.emit === 'function', 'ERR_INVALID', 'no event channel');
  const m = websocketsOf(plugin.id);
  need(m.size < MAX_WEBSOCKETS, 'ERR_BUSY', 'too many open websockets');
  const url = args && args.url;
  need(typeof url === 'string' && url.length <= 8192, 'ERR_INVALID', 'invalid url');
  const o = (args && args.opts) || {};
  const protocols = o.protocols == null ? [] : [].concat(o.protocols);
  need(protocols.length <= 8 && protocols.every((p) => typeof p === 'string' && WS_PROTOCOL_RE.test(p)) && new Set(protocols).size === protocols.length, 'ERR_INVALID', 'invalid protocols');
  const headers = {};
  for (const [k, v] of Object.entries(o.headers && typeof o.headers === 'object' ? o.headers : {})) {
    if (!/^sec-websocket-/i.test(k)) headers[k] = v;
  }
  const timeoutMs = Math.max(1000, Math.min(30000, Number(o.timeoutMs) || 10000));
  let ws;
  try {
    const target = await netPolicy.checkWebSocket(url, policyOf(plugin), netOpts());
    if (!target.ok) throw Object.assign(new Error('connection refused by the plugin policy: ' + target.reason), { code: 'ERR_NET_DENIED' });
    // the check is async: the limit again, so parallel connects cannot pass it together
    need(m.size < MAX_WEBSOCKETS, 'ERR_BUSY', 'too many open websockets');
    ws = await netPolicy.wsConnect(target, { headers, protocols, timeoutMs, maxPayload: WS_MAX_MESSAGE });
  } catch (e) { throw e instanceof HostApiError ? e : netError(e); }
  // the plugin stopped while connecting (closeSockets dropped its map) → nobody to deliver to
  if (websockets.get(plugin.id) !== m) { ws.terminate(); throw new HostApiError('ERR_NET', 'plugin stopped'); }
  if (m.size >= MAX_WEBSOCKETS) { ws.terminate(); throw new HostApiError('ERR_BUSY', 'too many open websockets'); }
  const id = ++socketSeq;
  m.set(id, ws);
  let windowAt = Date.now();
  let count = 0;
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - windowAt >= 1000) { windowAt = now; count = 0; }
    if (++count > WS_MAX_PER_SECOND) { ws.close(1008, 'too many messages'); return; }
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data));
    if (isBinary) ctx.emit({ t: 'ws', id, ev: 'message', b64: buf.toString('base64') });
    else ctx.emit({ t: 'ws', id, ev: 'message', text: buf.toString('utf8') });
  });
  ws.on('error', (e) => ctx.emit({ t: 'ws', id, ev: 'error', error: String((e && e.message) || e).slice(0, 200) }));
  ws.on('close', (code, reason) => {
    m.delete(id);
    ctx.emit({ t: 'ws', id, ev: 'close', code: Number(code) || 1006, reason: String(reason || '').slice(0, 123) });
  });
  return { id, protocol: ws.protocol || '' };
}

function wsOf(plugin, args) {
  const ws = websocketsOf(plugin.id).get(Number(args && args.id));
  need(ws, 'ERR_INVALID', 'unknown websocket');
  return ws;
}

function wsSend(plugin, args) {
  const ws = wsOf(plugin, args);
  const binary = typeof args.b64 === 'string';
  need(binary || typeof args.text === 'string', 'ERR_INVALID', 'invalid data');
  const data = binary ? Buffer.from(args.b64, 'base64') : args.text;
  need(Buffer.byteLength(data) <= WS_MAX_SEND, 'ERR_INVALID', 'message too large');
  need(ws.readyState === ws.OPEN, 'ERR_NET', 'websocket is not open');
  need(ws.bufferedAmount <= WS_MAX_BUFFER, 'ERR_BUSY', 'websocket send buffer full');
  return new Promise((resolve, reject) => {
    ws.send(data, { binary }, (e) => (e ? reject(new HostApiError('ERR_NET', e.message)) : resolve(null)));
  });
}

function wsClose(plugin, args) {
  const ws = websocketsOf(plugin.id).get(Number(args && args.id));
  if (!ws) return null;
  const code = Number(args.code);
  const valid = code === 1000 || (code >= 3000 && code <= 4999);
  ws.close(valid ? code : 1000, typeof args.reason === 'string' ? args.reason.slice(0, 123) : undefined);
  return null;
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

// gc.users.list / get: { id, name, role, avatarUrl, color, colorHex, initials }
// (docs/feature-avatars.md) — avatarUrl is the path /avatars/<id>.<ext> (or
// null), served on this server's every host; color is the favourite colour's
// palette key (never null), colorHex its #RRGGBB.
const USER_COLS = 'id, username, display_name, role, avatar_color';
function userView(u, look) {
  if (!u) return null;
  const f = look || require('../avatars').infoMany([u]).get(u.id);
  return { id: u.id, name: u.display_name || u.username, role: u.role, avatarUrl: f.avatarUrl, color: f.color, colorHex: f.colorHex, initials: f.initials };
}

const NOTIFY_PRIORITIES = ['info', 'normal', 'high', 'critical'];
const SEVERITY_PRIORITY = { info: 'info', success: 'info', warning: 'normal', error: 'normal' };

/** The plugin's budget per hour: permissions.notify { perHour } (1…120), else 30. */
function notifyPerHour(plugin) {
  const n = plugin.manifest.permissions && plugin.manifest.permissions.notifyPerHour;
  return Number.isInteger(n) && n >= 1 && n <= NOTIFY_PER_HOUR_MAX ? n : NOTIFY_PER_HOUR_DEFAULT;
}

// Silent data pushes (gc.notify silent: true, since 1.193.0): a budget of their own per plugin and hour.
const DATA_PER_HOUR = 600;
const dataWindow = new Map();

function dataBudget(plugin) {
  const w = recent(dataWindow, plugin.id, Date.now());
  need(w.length < DATA_PER_HOUR, 'ERR_RATE_LIMIT', `too many silent pushes (${DATA_PER_HOUR} per hour)`);
  w.push(Date.now());
}

/** Count one message against the plugin's budget per hour. */
function notifyBudget(plugin) {
  const now = Date.now();
  const w = (notifyWindow.get(plugin.id) || []).filter((t) => now - t < 3600000);
  need(w.length < notifyPerHour(plugin), 'ERR_RATE_LIMIT', 'too many notifications');
  w.push(now);
  notifyWindow.set(plugin.id, w);
}

/**
 * data.actions[] entries of type quick_action (docs/plugins.md
 * "Notifications"): { type: 'quick_action', label (1…24), plugin (the
 * calling plugin's own id), id (a quick action id — format only, the run
 * goes through the normal quick action path and its checks), confirm?:
 * boolean, auth?: 'device' }. Anything else → ERR_INVALID (other action
 * types are cleaned by notify/sanitize as before).
 */
function checkQuickActions(plugin, actions) {
  const { ACTION_ID_RE } = require('./quickActions');
  const { line } = require('../notify/sanitize');
  const { LIMITS: LIMITS_NOTIFY } = require('../notify/constants');
  for (const a of actions) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || a.type !== 'quick_action') continue;
    need(a.plugin === plugin.id, 'ERR_INVALID', "quick_action: plugin must be the plugin's own id");
    need(typeof a.id === 'string' && ACTION_ID_RE.test(a.id), 'ERR_INVALID', 'quick_action: invalid id');
    const label = typeof a.label === 'string' ? line(a.label, 1000) : '';
    need(label.length >= 1 && label.length <= LIMITS_NOTIFY.quickActionLabel, 'ERR_INVALID', 'quick_action: label must be 1…24 characters');
    need(a.confirm === undefined || a.confirm === null || typeof a.confirm === 'boolean', 'ERR_INVALID', 'quick_action: confirm must be a boolean');
    need(a.auth === undefined || a.auth === null || a.auth === 'device', 'ERR_INVALID', "quick_action: auth must be 'device'");
  }
}

/**
 * data.actions[] entries of type callback (docs/plugins.md "Callback
 * buttons"): { type: 'callback', id ([a-z0-9_-]{1,32}, unique among the
 * push's callbacks), label (1…24) } — pressed, the app acks the push with
 * that id and the host calls this plugin's notifyAction hook once
 * (notifyActions.js). Anything else → ERR_INVALID.
 */
function checkCallbacks(actions) {
  const { line, CALLBACK_ID_RE } = require('../notify/sanitize');
  const { LIMITS: LIMITS_NOTIFY } = require('../notify/constants');
  const seen = new Set();
  for (const a of actions) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || a.type !== 'callback') continue;
    need(typeof a.id === 'string' && CALLBACK_ID_RE.test(a.id), 'ERR_INVALID', 'callback: id must be [a-z0-9_-]{1,32}');
    need(!seen.has(a.id), 'ERR_INVALID', 'callback: duplicate id');
    seen.add(a.id);
    const label = typeof a.label === 'string' ? line(a.label, 1000) : '';
    need(label.length >= 1 && label.length <= LIMITS_NOTIFY.quickActionLabel, 'ERR_INVALID', 'callback: label must be 1…24 characters');
  }
}

const CARD_TEXT_MAX = 4000;
const CARD_LINK_LABEL_MAX = 40;

/**
 * `card` of gc.notify (docs/plugins.md "Notifications in chats", since
 * 1.191.0): how the notification looks in a chat when a person routes its
 * topic there — { text (≤ 4000, newlines kept), link?: { label (≤ 40),
 * route (an app route like data.route) }, actions?: [like data.actions] }.
 * Text and label are cut to their limits; a card that is not an object, an
 * empty text, a link without label or with a bad route, actions that are not
 * a list or a bad quick_action / callback → ERR_INVALID. Actions are cleaned
 * like data.actions (unknown types dropped, at most 4). → card or null.
 */
function notifyCard(plugin, raw) {
  if (raw == null) return null;
  const sanitize = require('../notify/sanitize');
  const { APP_ROUTE_RE, LIMITS: LIMITS_NOTIFY } = require('../notify/constants');
  need(typeof raw === 'object' && !Array.isArray(raw), 'ERR_INVALID', 'invalid card');
  need(typeof raw.text === 'string', 'ERR_INVALID', 'card.text required');
  const cardText = sanitize.text(raw.text, CARD_TEXT_MAX);
  need(cardText, 'ERR_INVALID', 'card.text empty');
  const out = { text: cardText };
  if (raw.link != null) {
    const l = raw.link;
    need(typeof l === 'object' && !Array.isArray(l), 'ERR_INVALID', 'invalid card.link');
    const label = typeof l.label === 'string' ? sanitize.line(l.label, CARD_LINK_LABEL_MAX) : '';
    need(label, 'ERR_INVALID', 'card.link.label required');
    need(typeof l.route === 'string' && APP_ROUTE_RE.test(l.route), 'ERR_INVALID', 'card.link.route must be an app route');
    out.link = { label, route: l.route };
  }
  if (raw.actions != null) {
    need(Array.isArray(raw.actions), 'ERR_INVALID', 'invalid card.actions');
    checkQuickActions(plugin, raw.actions);
    checkCallbacks(raw.actions);
    const appTab = !!(plugin.manifest.ui && plugin.manifest.ui.app);
    const list = raw.actions.slice(0, LIMITS_NOTIFY.actions).map((a) => sanitize.action(a, { plugin: plugin.id })).filter(Boolean)
      .map((a) => (!appTab && a.type === 'open_app_route' && a.target === `plg-${plugin.id}` ? { ...a, type: 'open_portal', target: `/portal#plg-${plugin.id}` } : a));
    if (list.length) out.actions = list;
  }
  return out;
}

/**
 * gc.notify — two forms (docs/plugins.md "Notifications"):
 *   gc.notify(message, { severity })   activity row + webhooks as before, and
 *                                      a push on topic plugin:<id>:default
 *                                      (priority info, warning/error → normal)
 *   gc.notify({ topic, title, body, priority, users, collapseKey, ttl, data, image, card })
 *                                      push on a topic declared in
 *                                      plugin.json notifyTopics (+ activity row,
 *                                      never with the image)
 * `groups: [id]` (permissions.groups, any topic): the groups' enabled
 * members (subgroups included) at send time, merged with `users` — groups
 * without anybody send nothing ({ pushed: false, recipients: 0 }).
 * Push needs the email_alerts licence; priority is capped at `high`, except
 * on a topic declared with `allowCritical` (critical bypasses quiet hours
 * like the core's critical events). Budget: permissions.notify — true = 30
 * per hour, { perHour: n } = n (1…120).
 */
function notify(plugin, args) {
  need(plugin.manifest.permissions && plugin.manifest.permissions.notify, 'ERR_NOTIFY_DENIED', 'this plugin has no notify permission');
  const sanitize = require('../notify/sanitize');
  const hub = require('../notify/hub');
  const n = args && args.notification;
  if (n && typeof n === 'object' && !Array.isArray(n)) {
    const topic = n.topic == null ? 'default' : String(n.topic);
    const declared = Array.isArray(plugin.manifest.notifyTopics) ? plugin.manifest.notifyTopics : [];
    const decl = declared.find((t) => t && t.id === topic) || null;
    need(topic === 'default' || decl, 'ERR_INVALID', 'topic not declared in notifyTopics');
    if (decl && decl.chat === true) {
      need(n.devices == null && n.silent == null, 'ERR_INVALID', 'devices / silent are not for chat topics');
      return notifyChat(plugin, topic, n);
    }
    // since 1.193.0 (permissions.devices): `devices` — only these app devices of `users`;
    // `silent: true` — a data push (no banner, no sound, not in the inbox, title optional)
    need(n.silent == null || typeof n.silent === 'boolean', 'ERR_INVALID', 'silent must be a boolean');
    const silent = n.silent === true;
    if (silent || n.devices != null) need(plugin.manifest.permissions && plugin.manifest.permissions.devices === true, 'ERR_DEVICES_DENIED', 'devices / silent need permissions.devices');
    const title = sanitize.title(n.title) || (silent ? sanitize.title(plugin.name) : '');
    need(title, 'ERR_INVALID', 'empty title');
    const body = sanitize.body(n.body);
    let priority = n.priority == null ? 'normal' : n.priority;
    need(NOTIFY_PRIORITIES.includes(priority), 'ERR_INVALID', 'invalid priority');
    const allowCritical = topic !== 'default' && !!(decl && decl.allowCritical === true);
    if (priority === 'critical' && !allowCritical) priority = 'high';
    let users = null;
    if (n.users != null) {
      need(Array.isArray(n.users) && n.users.length <= 100 && n.users.every((u) => Number.isSafeInteger(u) && u > 0), 'ERR_INVALID', 'invalid users');
      users = [...new Set(n.users)];
    }
    // groups (permissions.groups): their enabled members, subgroups included, resolved now and merged with users
    const byGroups = n.groups != null;
    if (byGroups) users = require('./groups').recipients(plugin, n.groups, users);
    let devices = null;
    if (n.devices != null) {
      need(Array.isArray(n.devices) && n.devices.length >= 1 && n.devices.length <= 100, 'ERR_INVALID', 'invalid devices');
      const D = require('./devices');
      const ids = n.devices.map(D.idOf);
      need(ids.every((x) => x !== null), 'ERR_INVALID', 'invalid device id');
      need(users && users.length, 'ERR_INVALID', 'devices need users (their owners)');
      const own = D.ownedBy(users, [...new Set(ids)]);
      need(ids.every((x) => own.has(x)), 'ERR_INVALID', "a device is not an app device of the listed users");
      devices = [...new Set(ids)];
    }
    need(!(silent && n.image != null), 'ERR_INVALID', 'a silent push carries no image');
    let collapseKey = null;
    if (n.collapseKey != null) {
      collapseKey = sanitize.collapseKey(n.collapseKey);
      need(collapseKey, 'ERR_INVALID', 'invalid collapseKey');
    }
    let ttl = null;
    if (n.ttl != null) {
      need(Number.isSafeInteger(n.ttl) && n.ttl >= 60 && n.ttl <= 30 * 86400, 'ERR_INVALID', 'invalid ttl');
      ttl = n.ttl;
    }
    need(n.data == null || (typeof n.data === 'object' && !Array.isArray(n.data)), 'ERR_INVALID', 'invalid data');
    if (n.data != null && Array.isArray(n.data.actions)) { checkQuickActions(plugin, n.data.actions); checkCallbacks(n.data.actions); }
    let image = null;
    if (n.image != null) {
      try { image = require('../notify/media').validate(n.image); } catch (e) {
        throw new HostApiError('ERR_INVALID', e && e.code === 'ERR_INVALID' ? e.message : 'invalid image');
      }
    }
    const d = sanitize.data(n.data == null ? { route: `plg-${plugin.id}` } : { route: `plg-${plugin.id}`, ...n.data }, { plugin: plugin.id });
    need(d.ok, 'ERR_INVALID', 'data too large (max 4 KB)');
    const card = notifyCard(plugin, n.card);
    // A plugin without its own app tab (ui.app) has no screen in the apps: an
    // action opening the plugin's app route opens the plugin in the portal
    // instead (its own tab, or the GateControl tab holding its sections —
    // portal "#plg-<id>"). With ui.app the app route stays.
    const appTab = !!(plugin.manifest.ui && plugin.manifest.ui.app);
    if (!appTab && d.data && Array.isArray(d.data.actions)) {
      d.data.actions = d.data.actions.map((a) => (a.type === 'open_app_route' && a.target === `plg-${plugin.id}`
        ? { ...a, type: 'open_portal', target: `/portal#plg-${plugin.id}` }
        : a));
    }
    // groups without anybody (empty, archived, only disabled accounts): nobody to tell — never the topic's
    // subscribers, which an empty list would mean
    if (byGroups && !users.length) return { pushed: false, id: null, recipients: 0 };
    const extra = byGroups ? { recipients: users.length } : {};
    if (silent) {
      // own budget, no activity row: data pushes are machine traffic (e.g. "device X: fetch transfer Y")
      dataBudget(plugin);
      const r = hub.emitPlugin(plugin.id, { topic, title, body, priority, users, devices, silent: true, collapseKey, ttl, data: d.data, allowCritical: false, image: null, card: null });
      return { pushed: r.pushed, id: r.id || null, ...extra };
    }
    notifyBudget(plugin);
    require('../activity').log('plugin_notice', `${plugin.name}: ${title}`, { source: 'plugin', severity: 'info',
      details: { plugin: plugin.id, topic, ...(byGroups ? { groups: [...new Set(n.groups)], recipients: users.length } : {}) } });
    const r = hub.emitPlugin(plugin.id, { topic, title, body, priority, users, devices, collapseKey, ttl, data: d.data, allowCritical, image, card });
    return { pushed: r.pushed, id: r.id || null, ...extra };
  }
  const msg = String((args && args.message) || '').replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 300);
  need(msg, 'ERR_INVALID', 'empty message');
  notifyBudget(plugin);
  const sev = args && args.opts && ['info', 'success', 'warning', 'error'].includes(args.opts.severity) ? args.opts.severity : 'info';
  require('../activity').log('plugin_notice', `${plugin.name}: ${msg}`, { source: 'plugin', severity: sev, details: { plugin: plugin.id } });
  try {
    hub.emitPlugin(plugin.id, {
      topic: 'default', title: sanitize.title(plugin.name), body: sanitize.body(msg), priority: SEVERITY_PRIORITY[sev],
      users: null, collapseKey: null, ttl: null, data: { route: `plg-${plugin.id}` },
    });
  } catch { /* the activity row is written; push is best-effort */ }
  return {};
}

// ─── Where notifications appear (sink plugins only) ────
//
// gc.notify.routes.get({ userId, lang }) / .set({ userId, topic, dest })
// (docs/plugins.md "Notifications in chats", since 1.191.0): the sink shows
// the page "Wo Mitteilungen erscheinen" in its own frame — the same answer
// and the same rules as GET / PUT /api/v1/me/notify/routes for that person
// (services/notify/chatRoutes.js). Only for permissions.notifySink
// (ERR_NOTIFY_SINK_DENIED). Refusals of the PUT become HostApiError codes,
// the message is the API's error code:
//   ERR_INVALID    invalid_user (not an enabled account), invalid_topic, invalid_dest
//   ERR_NOT_FOUND  unknown_topic (not one of that person's routable topics)
//   ERR_CONFLICT   locked, no_sink
//   ERR_FORBIDDEN  family_not_allowed

const ROUTE_ERRORS = {
  invalid_topic: 'ERR_INVALID', invalid_dest: 'ERR_INVALID', unknown_topic: 'ERR_NOT_FOUND',
  locked: 'ERR_CONFLICT', no_sink: 'ERR_CONFLICT', family_not_allowed: 'ERR_FORBIDDEN',
};

async function notifyRoutes(plugin, op, args) {
  need(plugin.manifest.permissions && plugin.manifest.permissions.notifySink === true, 'ERR_NOTIFY_SINK_DENIED', 'this plugin is no notification sink (permissions.notifySink)');
  const a = args && typeof args === 'object' ? args : {};
  const uid = a.userId;
  need(Number.isSafeInteger(uid) && uid > 0, 'ERR_INVALID', 'invalid_user');
  const u = require('../../db/connection').getDb().prepare('SELECT id, language FROM users WHERE id = ? AND enabled = 1').get(uid);
  need(u, 'ERR_INVALID', 'invalid_user');
  const chatRoutes = require('../notify/chatRoutes');
  const text = require('../notify/text');
  const lang = a.lang === 'de' || a.lang === 'en' ? a.lang : text.userLang(uid);
  if (op === 'set') {
    const r = await chatRoutes.setRoute(uid, a.topic, a.dest);
    if (r.status !== 200) throw new HostApiError(ROUTE_ERRORS[r.error] || 'ERR_INVALID', r.error);
    return { ...(await chatRoutes.view(uid, lang)), chat: r.chat || null };
  }
  return chatRoutes.view(uid, lang);
}

// ─── Push pictures from the plugin's media (image: { mediaId }) ────
//
// gc.notify({ …, image: { mediaId } }) — on any topic, chat topics included:
// instead of sending the bytes, a plugin declaring `media` names one of its
// own files (e.g. the small preview the apps upload next to a photo). The
// host reads it and hands it on as { data, mime }, so it goes through the
// very same checks as a sent picture (notify/media.validate: PNG / JPEG /
// WebP, ≤ 300 KB, 32…2560 px a side, no animation) and is copied into
// notify_media like one — the push's imageUrl is /notify-media/<id>.<ext>,
// living as long as the push, independent of the media file afterwards.

const MEDIA_ID_RE = /^[0-9a-f]{32}$/;

async function notifyImageFromMedia(plugin, args) {
  const n = args && args.notification;
  const im = n && typeof n === 'object' && !Array.isArray(n) ? n.image : null;
  if (!im || typeof im !== 'object' || Array.isArray(im) || !Object.prototype.hasOwnProperty.call(im, 'mediaId')) return args;
  need(plugin.manifest.permissions && plugin.manifest.permissions.notify, 'ERR_NOTIFY_DENIED', 'this plugin has no notify permission');
  need(Object.keys(im).length === 1, 'ERR_INVALID', 'invalid image: mediaId cannot be combined with data or mime');
  need(typeof im.mediaId === 'string' && MEDIA_ID_RE.test(im.mediaId), 'ERR_INVALID', 'invalid image: invalid media id');
  const media = needMedia(plugin);
  const notifyMedia = require('../notify/media');
  const r = media.row(plugin.id, im.mediaId);
  need(r, 'ERR_INVALID', 'invalid image: unknown media id');
  need(Object.prototype.hasOwnProperty.call(notifyMedia.TYPES, r.mime), 'ERR_INVALID', 'invalid image: mime');
  need(r.bytes <= notifyMedia.MAX_BYTES, 'ERR_INVALID', 'invalid image: too_large');
  const parts = [];
  try {
    for await (const part of media.readRange(r, 0, r.bytes - 1)) parts.push(part);
  } catch {
    throw new HostApiError('ERR_INVALID', 'invalid image: media file unreadable');
  }
  return { ...args, notification: { ...n, image: { data: Buffer.concat(parts).toString('base64'), mime: r.mime } } };
}

// ─── Chat notifications (notifyTopics[].chat) ────
//
// gc.notify({ topic: <chat topic>, title, body, users, conversation, sender,
// priority?, collapseKey?, ttl?, data?, image? }) — docs/plugins.md "Chat
// notifications". A message from one person to others: `users` (1…100) is
// required, `conversation` { id, title?, isGroup? } and `sender` { id, name,
// avatarUrl? } become data.conversation / data.sender (the apps group the
// notifications per conversation, Android MessagingStyle). data.actions may
// carry `reply` and `mark_read` { label, path, body? } — `path` a path of the
// plugin's own client API (needs permissions.app), where the app POSTs the
// reply / the read mark. Own budget (CHAT_PER_HOUR per plugin, CHAT_PER_USER_HOUR
// per recipient — a recipient over it is skipped and listed in `skipped`),
// never the e-mail channel, never bundled or held back, no activity row with
// the text: an hourly neutral line with the count (flushChatSummary).

const CHAT_PER_HOUR = 1200;
const CHAT_PER_USER_HOUR = 120;
const chatWindow = new Map();     // plugin id → [timestamps]
const chatUserWindow = new Map(); // `${plugin}:${user}` → [timestamps]
const chatCounts = new Map();     // plugin id → chat notifications since the last summary
const CONV_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SENDER_ID_RE = /^[A-Za-z0-9_.:@-]{1,64}$/;
// a picture of this server: a profile picture or a plugin media URL
const AVATAR_URL_RE = /^\/(?:avatars|plugin-media)\/[A-Za-z0-9._-]{1,200}$/;

function recent(map, key, now) {
  const w = (map.get(key) || []).filter((t) => now - t < 3600000);
  map.set(key, w);
  return w;
}

function chatParts(n, plugin) {
  const { line } = require('../notify/sanitize');
  const c = n.conversation;
  need(c && typeof c === 'object' && !Array.isArray(c), 'ERR_INVALID', 'conversation required on a chat topic');
  const convId = typeof c.id === 'number' && Number.isSafeInteger(c.id) ? String(c.id) : c.id;
  need(typeof convId === 'string' && CONV_ID_RE.test(convId), 'ERR_INVALID', 'invalid conversation.id');
  need(c.title == null || typeof c.title === 'string', 'ERR_INVALID', 'invalid conversation.title');
  need(c.isGroup == null || typeof c.isGroup === 'boolean', 'ERR_INVALID', 'invalid conversation.isGroup');
  const conversation = { id: convId, title: c.title == null ? null : (line(c.title, 80) || null), isGroup: c.isGroup === true };
  const sd = n.sender;
  need(sd && typeof sd === 'object' && !Array.isArray(sd), 'ERR_INVALID', 'sender required on a chat topic');
  const sid = typeof sd.id === 'number' && Number.isSafeInteger(sd.id) ? sd.id : (typeof sd.id === 'string' && SENDER_ID_RE.test(sd.id) ? sd.id : null);
  need(sid !== null, 'ERR_INVALID', 'invalid sender.id');
  const name = typeof sd.name === 'string' ? line(sd.name, 80) : '';
  need(name, 'ERR_INVALID', 'sender.name required');
  need(sd.avatarUrl == null || (typeof sd.avatarUrl === 'string' && AVATAR_URL_RE.test(sd.avatarUrl)), 'ERR_INVALID', 'sender.avatarUrl must be a /avatars/ or /plugin-media/ path');
  const sender = { id: sid, name, avatarUrl: sd.avatarUrl == null ? null : sd.avatarUrl };
  // reply / mark_read: strict here (sanitize drops what does not fit)
  const actions = n.data && Array.isArray(n.data.actions) ? n.data.actions : [];
  const { pluginPath, CHAT_ACTIONS, CHAT_BODY_BYTES } = require('../notify/sanitize');
  for (const a of actions) {
    if (!a || typeof a !== 'object' || !CHAT_ACTIONS.has(a.type)) continue;
    need(plugin.manifest.permissions && plugin.manifest.permissions.app, 'ERR_INVALID', `${a.type}: needs permissions.app (the app posts to the plugin's client API)`);
    need(pluginPath(a.path), 'ERR_INVALID', `${a.type}: invalid path`);
    const label = typeof a.label === 'string' ? line(a.label, 1000) : '';
    need(label.length >= 1 && label.length <= 24, 'ERR_INVALID', `${a.type}: label must be 1…24 characters`);
    let size = 0;
    try { size = a.body == null ? 0 : Buffer.byteLength(JSON.stringify(a.body)); } catch { size = Infinity; }
    need(a.body == null || (typeof a.body === 'object' && !Array.isArray(a.body) && size <= CHAT_BODY_BYTES), 'ERR_INVALID', `${a.type}: body must be an object ≤ 1 KB`);
  }
  return { conversation, sender };
}

function notifyChat(plugin, topic, n) {
  const sanitize = require('../notify/sanitize');
  const hub = require('../notify/hub');
  const title = sanitize.title(n.title);
  need(title, 'ERR_INVALID', 'empty title');
  const body = sanitize.body(n.body);
  let priority = n.priority == null ? 'normal' : n.priority;
  need(NOTIFY_PRIORITIES.includes(priority), 'ERR_INVALID', 'invalid priority');
  if (priority === 'critical') priority = 'high';
  // users (1…100 ids) and/or groups (permissions.groups: their enabled members, resolved now)
  const byGroups = n.groups != null;
  if (!byGroups || n.users != null) {
    need(Array.isArray(n.users) && n.users.length >= (byGroups ? 0 : 1) && n.users.length <= 100 && n.users.every((u) => Number.isSafeInteger(u) && u > 0), 'ERR_INVALID', 'users (1…100 ids) required on a chat topic');
  }
  const wanted = byGroups ? require('./groups').recipients(plugin, n.groups, n.users || []) : n.users;
  const { conversation, sender } = chatParts(n, plugin);
  let collapseKey = sanitize.collapseKey(`chat:${conversation.id}`);
  if (n.collapseKey != null) {
    collapseKey = sanitize.collapseKey(n.collapseKey);
    need(collapseKey, 'ERR_INVALID', 'invalid collapseKey');
  }
  let ttl = null;
  if (n.ttl != null) {
    need(Number.isSafeInteger(n.ttl) && n.ttl >= 60 && n.ttl <= 30 * 86400, 'ERR_INVALID', 'invalid ttl');
    ttl = n.ttl;
  }
  need(n.data == null || (typeof n.data === 'object' && !Array.isArray(n.data)), 'ERR_INVALID', 'invalid data');
  if (n.data != null && Array.isArray(n.data.actions)) { checkQuickActions(plugin, n.data.actions); checkCallbacks(n.data.actions); }
  let image = null;
  if (n.image != null) {
    try { image = require('../notify/media').validate(n.image); } catch (e) {
      throw new HostApiError('ERR_INVALID', e && e.code === 'ERR_INVALID' ? e.message : 'invalid image');
    }
  }
  const d = sanitize.data({ route: `plg-${plugin.id}`, ...(n.data || {}), conversation, sender }, { plugin: plugin.id, chat: true });
  need(d.ok, 'ERR_INVALID', 'data too large (max 4 KB)');
  if (!wanted.length) return { pushed: false, id: null, skipped: [], recipients: 0 };
  // budgets: the plugin's (refused when used up), each recipient's (skipped)
  const now = Date.now();
  const w = recent(chatWindow, plugin.id, now);
  need(w.length < CHAT_PER_HOUR, 'ERR_RATE_LIMIT', `too many chat notifications (${CHAT_PER_HOUR} per hour)`);
  const users = [];
  const skipped = [];
  for (const u of [...new Set(wanted)]) {
    if (recent(chatUserWindow, `${plugin.id}:${u}`, now).length >= CHAT_PER_USER_HOUR) skipped.push(u); else users.push(u);
  }
  need(users.length, 'ERR_RATE_LIMIT', `too many chat notifications for these recipients (${CHAT_PER_USER_HOUR} per hour each)`);
  w.push(now);
  for (const u of users) chatUserWindow.get(`${plugin.id}:${u}`).push(now);
  chatCounts.set(plugin.id, (chatCounts.get(plugin.id) || 0) + 1);
  const r = hub.emitPlugin(plugin.id, { topic, title, body, priority, users, collapseKey, ttl, data: d.data, allowCritical: false, image, chat: true });
  return { pushed: r.pushed, id: r.id || null, skipped, ...(byGroups ? { recipients: wanted.length } : {}) };
}

/**
 * Hourly (plugins/index.js): one neutral activity row per plugin that sent
 * chat notifications — the count only, never a title, text or person.
 */
function flushChatSummary() {
  for (const [id, count] of chatCounts) {
    if (!count) continue;
    let name = id;
    try { const p = require('./registry').get(id); if (p) name = p.name; } catch { /* keep the id */ }
    try {
      require('../activity').log('plugin_notice', `${name}: ${count} chat notification${count === 1 ? '' : 's'} sent`, {
        source: 'plugin', severity: 'info', details: { plugin: id, chat: true, count },
      });
    } catch { /* best-effort */ }
  }
  chatCounts.clear();
}

// ─── Media (plugin.json `media`, services/plugins/media.js) ────
//
// gc.media.info(id) / claim(id) / delete(id) / usage() / url(id, { user, ttlS }) /
// fetch(url, opts): the files the plugin's users uploaded or the plugin
// fetched (docs/plugins.md "Media").

function needMedia(plugin) {
  need(require('./media').declOf(plugin), 'ERR_MEDIA_DENIED', 'plugin.json declares no media');
  return require('./media');
}

function mediaId(args) {
  const id = args && args.id;
  need(typeof id === 'string' && /^[0-9a-f]{32}$/.test(id), 'ERR_INVALID', 'invalid media id');
  return id;
}

const MEDIA_FETCH_TIMEOUT_DEFAULT = 30000;
const MEDIA_ERRORS = { unsupported_type: 'ERR_MEDIA_TYPE', too_large: 'ERR_MEDIA_TOO_LARGE', quota_exceeded: 'ERR_MEDIA_QUOTA', empty: 'ERR_MEDIA_EMPTY' };

/**
 * gc.media.fetch(url, { headers, timeoutMs, mime, name, maxBytes }) → { mediaId, mime, bytes, name }:
 * one file from the internet straight into the plugin's media — checked like
 * http.fetch (permissions.network.internet, public addresses only, DNS
 * pinned, every redirect hop again), GET only, redirects followed. The file
 * is unclaimed and has no owner (gc.media.claim, hook mediaAccess). All hops
 * together end within the host call's time (TIMEOUTS.hostCall).
 */
async function mediaFetch(plugin, args) {
  const media = needMedia(plugin);
  const decl = media.declOf(plugin);
  const url = args && args.url;
  need(typeof url === 'string' && url.length <= 8192, 'ERR_INVALID', 'invalid url');
  const o = args && args.opts != null ? args.opts : {};
  need(typeof o === 'object' && !Array.isArray(o), 'ERR_INVALID', 'invalid options');
  need(o.headers == null || (typeof o.headers === 'object' && !Array.isArray(o.headers)), 'ERR_INVALID', 'invalid headers');
  need(o.mime == null || (typeof o.mime === 'string' && o.mime.length <= 200), 'ERR_INVALID', 'invalid mime');
  need(o.name == null || (typeof o.name === 'string' && o.name.length <= 4096), 'ERR_INVALID', 'invalid name');
  need(o.maxBytes == null || (Number.isSafeInteger(o.maxBytes) && o.maxBytes >= 1), 'ERR_INVALID', 'invalid maxBytes');
  need(o.timeoutMs == null || Number.isFinite(o.timeoutMs), 'ERR_INVALID', 'invalid timeoutMs');
  const forced = o.mime == null || o.mime === '' ? null : media.baseType(o.mime);
  if (forced !== null) need(media.typeAllowed(decl, forced), 'ERR_MEDIA_TYPE', `type ${forced} is not declared in media.types`);
  const limit = Math.min(o.maxBytes == null ? decl.maxBytes : o.maxBytes, decl.maxBytes);
  need(media.usage(plugin.id).bytes < media.quotaOf(plugin), 'ERR_MEDIA_QUOTA', 'media quota exhausted');
  const timeoutMs = Math.max(1000, Math.min(60000, o.timeoutMs == null ? MEDIA_FETCH_TIMEOUT_DEFAULT : o.timeoutMs));
  const deadline = Date.now() + Math.min(timeoutMs, TIMEOUTS.hostCall - 1000);
  let res;
  try {
    res = await netPolicy.fetchWithPolicy(policyOf(plugin), url, { method: 'GET', headers: { ...(o.headers || {}) }, body: null,
      timeoutMs, maxBytes: limit, redirect: 'follow', deadline, ...netOpts() });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg === 'response_too_large') throw new HostApiError('ERR_MEDIA_TOO_LARGE', `the file is larger than ${limit} bytes`);
    if ((e && e.code === 'ERR_TIMEOUT') || msg === 'timeout') throw new HostApiError('ERR_TIMEOUT', 'the download did not finish in time');
    throw netError(e);
  }
  if (res.status < 200 || res.status > 299) throw Object.assign(new HostApiError('ERR_HTTP', `HTTP ${res.status}`), { status: res.status });
  const mime = forced !== null ? forced : media.baseType(res.headers['content-type']);
  need(media.typeAllowed(decl, mime), 'ERR_MEDIA_TYPE', `type ${mime || '(none)'} is not declared in media.types`);
  try {
    return await media.storeBuffer(plugin, res.body, { mime, name: o.name == null ? null : o.name, owner: null });
  } catch (e) {
    if (e instanceof media.MediaError && MEDIA_ERRORS[e.code]) throw new HostApiError(MEDIA_ERRORS[e.code], e.code === 'empty' ? 'the response is empty' : e.code);
    throw e;
  }
}

function mediaCall(plugin, op, args) {
  const media = needMedia(plugin);
  switch (op) {
    case 'info': return media.info(media.row(plugin.id, mediaId(args)));
    case 'claim': {
      const out = media.claim(plugin.id, mediaId(args));
      need(out, 'ERR_INVALID', 'unknown media id');
      return out;
    }
    case 'delete': return media.remove(plugin.id, mediaId(args));
    case 'usage': {
      const decl = media.declOf(plugin);
      return { ...media.usage(plugin.id), quota: media.quotaOf(plugin), maxBytes: decl.maxBytes, types: decl.types, uploads: decl.uploads !== false,
        resumable: decl.resumable === true, handOverMaxBytes: decl.handOverMaxBytes || decl.maxBytes };
    }
    case 'url': {
      const id = mediaId(args);
      need(media.row(plugin.id, id), 'ERR_INVALID', 'unknown media id');
      const user = args.user == null ? null : args.user;
      need(user === null || (Number.isSafeInteger(user) && user > 0), 'ERR_INVALID', 'invalid user id');
      const ttlS = args.ttlS == null ? null : args.ttlS;
      need(ttlS === null || (Number.isSafeInteger(ttlS) && ttlS >= media.URL_TTL_MIN_S && ttlS <= media.URL_TTL_MAX_S), 'ERR_INVALID', 'ttlS must be 60…86400');
      return media.url(plugin.id, id, { user, ttlS });
    }
    default: throw new HostApiError('ERR_UNKNOWN_API', 'unknown host API');
  }
}

// ─── Realtime events (permissions.events, services/plugins/events.js) ────

function eventsEmit(plugin, args) {
  need(plugin.manifest.permissions && plugin.manifest.permissions.events, 'ERR_EVENTS_DENIED', 'this plugin has no events permission');
  try {
    return require('./events').emit(plugin.id, args);
  } catch (e) {
    if (e && (e.code === 'ERR_INVALID' || e.code === 'ERR_RATE_LIMIT')) throw new HostApiError(e.code, e.message);
    throw e;
  }
}

// ─── Services between plugins (services.provides / permissions.services) ────
//
// gc.services.call({ plugin, service, userId?, payload? }) → the provider's
// answer: its hook service({ name, caller, user, payload }) runs in the
// providing plugin. The caller must list "<plugin>:<service>" in
// permissions.services, the provider must declare the service in
// services.provides and be usable (may run, running). `user` is the account
// the call is about ({ id, name, role } of an enabled user, or null without
// userId). Payload ≤ 512 KB and answer ≤ 16 KB of JSON, SERVICE_TIMEOUT_MS, 60 calls per
// hour per calling plugin, an activity row `plugin_service` per call (ids
// and ok only).
//
// gc.services.available(plugin, service) → boolean: would a call reach the
// provider right now — listed in the caller's permissions.services, not the
// caller itself, provider installed, may run, running and declaring the
// service. Asks nobody (the provider's hook is not run), not counted in the
// budget, no activity row. Malformed ids/names → ERR_INVALID like call().

const SERVICES_PER_HOUR = 60;
const SERVICE_JSON_MAX = 16 * 1024;
// Payloads may carry a small image (e.g. a doorbell snapshot as base64).
const SERVICE_PAYLOAD_MAX = 512 * 1024;
const SERVICE_TIMEOUT_MS = 15000;
const servicesWindow = new Map();

function jsonBounded(v, what) {
  let s;
  try { s = JSON.stringify(v === undefined ? null : v); } catch { s = undefined; }
  const max = what === 'payload' ? SERVICE_PAYLOAD_MAX : SERVICE_JSON_MAX;
  need(s !== undefined && Buffer.byteLength(s, 'utf8') <= max, what === 'payload' ? 'ERR_INVALID' : 'ERR_SERVICE_FAILED', `${what} must be JSON ≤ ${max / 1024} KB`);
  return JSON.parse(s);
}

/** The { plugin, service } of a services.* call (format checked) → the args object. */
function serviceRef(args) {
  const { ID_RE } = require('./constants');
  const { SERVICE_NAME_RE } = require('./manifest');
  const a = args && typeof args === 'object' ? args : {};
  need(typeof a.plugin === 'string' && a.plugin.length >= 2 && a.plugin.length <= 64 && ID_RE.test(a.plugin), 'ERR_INVALID', 'invalid plugin id');
  need(typeof a.service === 'string' && SERVICE_NAME_RE.test(a.service), 'ERR_INVALID', 'invalid service name');
  return a;
}

/** Does the caller list "<plugin>:<service>" in permissions.services? */
function serviceAllowed(plugin, a) {
  const allowed = plugin.manifest.permissions && Array.isArray(plugin.manifest.permissions.services) ? plugin.manifest.permissions.services : [];
  return allowed.includes(`${a.plugin}:${a.service}`);
}

/** Is the provider installed, allowed to run, running and declaring the service? Never asks the provider. */
function serviceProvided(a) {
  let provider = null;
  try { provider = require('./registry').resolve(a.plugin); } catch { provider = null; } // also the plugin that replaced it
  const provides = provider && provider.manifest && provider.manifest.services && provider.manifest.services.provides ? provider.manifest.services.provides : {};
  return !!provider && Object.prototype.hasOwnProperty.call(provides, a.service) && !!require('./index').evaluate(provider).run
    && require('./runtime').info(provider.id).state === 'running';
}

/** gc.services.available(plugin, service) → boolean (see above). */
function servicesAvailable(plugin, args) {
  const a = serviceRef(args);
  return a.plugin !== plugin.id && serviceAllowed(plugin, a) && serviceProvided(a);
}

async function servicesCall(plugin, args) {
  const a = serviceRef(args);
  need(serviceAllowed(plugin, a), 'ERR_SERVICES_DENIED', 'service not listed in permissions.services');
  need(a.plugin !== plugin.id, 'ERR_INVALID', 'a plugin cannot call its own services');
  let user = null;
  if (a.userId != null) {
    need(Number.isSafeInteger(a.userId) && a.userId > 0, 'ERR_INVALID', 'invalid user id');
    const u = db().prepare('SELECT id, username, display_name, role, enabled FROM users WHERE id = ?').get(a.userId);
    need(u && u.enabled === 1, 'ERR_INVALID', 'unknown or disabled user');
    user = { id: u.id, name: u.display_name || u.username, role: u.role };
  }
  const payload = jsonBounded(a.payload, 'payload');
  const runtime = require('./runtime');
  need(serviceProvided(a), 'ERR_SERVICE_UNAVAILABLE', 'the providing plugin or service is not available');
  need(require('./registry').resolve(a.plugin).id !== plugin.id, 'ERR_INVALID', 'a plugin cannot call its own services');
  const now = Date.now();
  const w = recent(servicesWindow, plugin.id, now);
  need(w.length < SERVICES_PER_HOUR, 'ERR_RATE_LIMIT', `too many service calls (${SERVICES_PER_HOUR} per hour)`);
  w.push(now);
  let out;
  let error = null;
  try {
    out = await runtime.call(require('./registry').resolve(a.plugin).id, 'service', { name: a.service, caller: plugin.id, user, payload }, module.exports._serviceTimeoutMs || SERVICE_TIMEOUT_MS);
  } catch (e) {
    error = e && e.code === 'ERR_TIMEOUT' ? new HostApiError('ERR_TIMEOUT', 'the service did not answer in time')
      : new HostApiError('ERR_SERVICE_FAILED', String((e && e.message) || 'service failed').slice(0, 200));
  }
  let result = null;
  if (!error) {
    try { result = jsonBounded(out && out.result, 'result'); } catch (e) { error = e; }
  }
  try {
    require('../activity').log('plugin_service', `Plugin "${plugin.id}" called service "${a.service}" of plugin "${a.plugin}" (${error ? 'failed' : 'ok'})`, {
      source: 'plugin', severity: error ? 'warning' : 'info',
      details: { plugin: plugin.id, target: a.plugin, service: a.service, userId: user ? user.id : null, ok: !error, ...(error ? { error: error.code } : {}) },
    });
  } catch { /* the call happened; the log is best-effort */ }
  if (error) throw error;
  return result;
}


// ─── Hand-over of media between plugins (gc.media.handOver, since 1.193.0) ────
//
// gc.media.handOver(mediaId, { toPlugin, user }) → { mediaId, mime, bytes,
// name } — the id of a new, unclaimed file (24 h) of plugin `toPlugin`
// (owner `user` or none), e.g. GateDrop handing a file to the messenger
// before calling its service send_file. Allowed like a service call: the
// caller lists one of the target's services ("<toPlugin>:<service>" that the
// target provides) in permissions.services; the target is installed, may
// run and declares media taking the type and the size (handOverMaxBytes,
// default maxBytes), with room in its quota (the file counts there). The
// sealed file is hard-linked (copied on another file system), never
// decrypted. 600 per hour per calling plugin; an activity row
// plugin_media_handover (ids only).

const HANDOVER_PER_HOUR = 600;
const HANDOVER_TIMEOUT_MS = 10 * 60 * 1000;
const handOverWindow = new Map();
const MEDIA_HOST_ERRORS = { ...MEDIA_ERRORS, not_found: 'ERR_INVALID', no_media: 'ERR_MEDIA_DENIED' };

/** The target plugin of a hand-over from `from` to `toId`, or a HostApiError. */
function handOverTarget(from, toId) {
  const { ID_RE } = require('./constants');
  need(typeof toId === 'string' && toId.length >= 2 && toId.length <= 64 && ID_RE.test(toId), 'ERR_INVALID', 'invalid toPlugin');
  let target = null;
  try { target = require('./registry').resolve(toId); } catch { target = null; }
  need(target, 'ERR_SERVICE_UNAVAILABLE', 'the target plugin is not installed');
  need(target.id !== from.id && toId !== from.id, 'ERR_INVALID', 'a plugin cannot hand files over to itself');
  need(handOverAllowed(from, target, toId), 'ERR_SERVICES_DENIED', "none of the target plugin's services is listed in permissions.services");
  need(require('./index').evaluate(target).run, 'ERR_SERVICE_UNAVAILABLE', 'the target plugin is not available');
  need(require('./media').declOf(target), 'ERR_MEDIA_DENIED', 'the target plugin declares no media');
  return target;
}

/** Does `from` list a service the target provides ("<id>:<service>", by the target's id or the id asked for)? */
function handOverAllowed(from, target, askedId = target.id) {
  const listed = from.manifest.permissions && Array.isArray(from.manifest.permissions.services) ? from.manifest.permissions.services : [];
  const provides = target.manifest && target.manifest.services && target.manifest.services.provides ? target.manifest.services.provides : {};
  return listed.some((ref) => {
    const i = ref.indexOf(':');
    const p = ref.slice(0, i);
    return (p === target.id || p === askedId) && Object.prototype.hasOwnProperty.call(provides, ref.slice(i + 1));
  });
}

async function mediaHandOver(plugin, args) {
  const media = needMedia(plugin);
  const id = mediaId(args);
  const target = handOverTarget(plugin, args && args.toPlugin);
  let owner = null;
  if (args.user != null) {
    need(Number.isSafeInteger(args.user) && args.user > 0, 'ERR_INVALID', 'invalid user id');
    need(db().prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(args.user), 'ERR_INVALID', 'unknown or disabled user');
    owner = args.user;
  }
  need(media.row(plugin.id, id), 'ERR_INVALID', 'unknown media id');
  const w = recent(handOverWindow, plugin.id, Date.now());
  need(w.length < HANDOVER_PER_HOUR, 'ERR_RATE_LIMIT', `too many hand-overs (${HANDOVER_PER_HOUR} per hour)`);
  w.push(Date.now());
  let out;
  try {
    out = await media.handOver(plugin, id, target, { owner });
  } catch (e) {
    if (e instanceof media.MediaError && MEDIA_HOST_ERRORS[e.code]) throw new HostApiError(MEDIA_HOST_ERRORS[e.code], e.code);
    throw e;
  }
  try {
    require('../activity').log('plugin_media_handover', `Plugin "${plugin.id}" handed a file over to plugin "${target.id}"`, {
      source: 'plugin', severity: 'info', details: { plugin: plugin.id, target: target.id, bytes: out.bytes, userId: owner },
    });
  } catch { /* the file is there; the log is best-effort */ }
  return out;
}

// ─── Public links (permissions.publicLinks, publicLinks.js, since 1.193.0) ────

async function publicLinksCall(plugin, op, args) {
  const links = require('./publicLinks');
  try {
    switch (op) {
      case 'create': return await links.create(plugin, args);
      case 'list': return links.list(plugin, args);
      case 'get': return links.get(plugin, args);
      case 'revoke': return links.revoke(plugin, args);
      default: throw new HostApiError('ERR_UNKNOWN_API', 'unknown host API');
    }
  } catch (e) {
    if (e instanceof links.LinkError) throw new HostApiError(e.code, e.message);
    throw e;
  }
}

// ─── Devices (permissions.devices, devices.js, since 1.193.0) ────

function devicesList(plugin, args) {
  need(plugin.manifest.permissions && plugin.manifest.permissions.devices === true, 'ERR_DEVICES_DENIED', 'this plugin has no devices permission');
  const uid = args && args.userId;
  need(Number.isSafeInteger(uid) && uid > 0, 'ERR_INVALID', 'invalid user id');
  need(db().prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(uid), 'ERR_INVALID', 'unknown or disabled user');
  return require('./devices').list(uid);
}

// ─── Uploads to a home target (gc.net.uploadTarget → target.upload, since 1.193.0) ────
//
// gc.net.uploadTarget(id, path, { index, method, query, headers, form: {
// fields, file: { field, mediaId, name, mime } }, mediaFrom: { plugin,
// mediaId }, timeoutMs, binary }) — a multipart/form-data request (POST,
// or PUT) to an assigned home target like fetchTarget (same target and
// protocol checks, the route's headers win, no redirects), the file streamed
// from the media store: the plugin's own file (form.file.mediaId), or
// `mediaFrom` — a file of another plugin that could hand it over to this one
// (it lists one of this plugin's services). Answer like fetchTarget (≤ 5 MB).

const UPLOAD_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;
const UPLOAD_TIMEOUT_MAX_MS = 30 * 60 * 1000;
const FORM_FIELDS_MAX = 50;
const FORM_FIELDS_BYTES = 64 * 1024;
const FORM_NAME_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/; // printable ASCII without " and \
const MIME_SHAPE_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,99}$/;

/** A name in a multipart header the way browsers write it (HTML: ", CR, LF percent-encoded). */
function formQuoted(v) { return String(v).replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A'); }

function uploadOptions(plugin, args) {
  const o = args && args.opts != null ? args.opts : {};
  need(typeof o === 'object' && !Array.isArray(o), 'ERR_INVALID', 'invalid options');
  need(o.method == null || o.method === 'POST' || o.method === 'PUT', 'ERR_INVALID', 'method must be POST or PUT');
  need(o.headers == null || (typeof o.headers === 'object' && !Array.isArray(o.headers)), 'ERR_INVALID', 'invalid headers');
  need(o.query == null || (typeof o.query === 'object' && !Array.isArray(o.query)), 'ERR_INVALID', 'invalid query');
  need(o.timeoutMs == null || Number.isFinite(o.timeoutMs), 'ERR_INVALID', 'invalid timeoutMs');
  const form = o.form;
  need(form && typeof form === 'object' && !Array.isArray(form), 'ERR_INVALID', 'form required');
  const fields = [];
  let size = 0;
  if (form.fields != null) {
    need(typeof form.fields === 'object' && !Array.isArray(form.fields), 'ERR_INVALID', 'invalid form.fields');
    for (const [k, v] of Object.entries(form.fields)) {
      need(FORM_NAME_RE.test(k), 'ERR_INVALID', 'invalid form field name');
      need(['string', 'number', 'boolean'].includes(typeof v), 'ERR_INVALID', 'form field values must be strings, numbers or booleans');
      fields.push([k, String(v)]);
      size += k.length + Buffer.byteLength(String(v));
    }
  }
  need(fields.length <= FORM_FIELDS_MAX && size <= FORM_FIELDS_BYTES, 'ERR_INVALID', 'form fields too large');
  const file = form.file;
  need(file && typeof file === 'object' && !Array.isArray(file), 'ERR_INVALID', 'form.file required');
  need(typeof file.field === 'string' && FORM_NAME_RE.test(file.field), 'ERR_INVALID', 'invalid form.file.field');
  need(file.name == null || (typeof file.name === 'string' && file.name.length <= 4096), 'ERR_INVALID', 'invalid form.file.name');
  need(file.mime == null || (typeof file.mime === 'string' && MIME_SHAPE_RE.test(file.mime.toLowerCase())), 'ERR_INVALID', 'invalid form.file.mime');
  const media = require('./media');
  let row;
  if (o.mediaFrom != null) {
    const mf = o.mediaFrom;
    need(file.mediaId == null, 'ERR_INVALID', 'form.file.mediaId or mediaFrom, not both');
    need(mf && typeof mf === 'object' && typeof mf.mediaId === 'string' && media.ID_RE.test(mf.mediaId), 'ERR_INVALID', 'invalid mediaFrom');
    const { ID_RE } = require('./constants');
    need(typeof mf.plugin === 'string' && ID_RE.test(mf.plugin), 'ERR_INVALID', 'invalid mediaFrom.plugin');
    let source = null;
    try { source = require('./registry').resolve(mf.plugin); } catch { source = null; }
    need(source && source.id !== plugin.id && handOverAllowed(source, plugin), 'ERR_MEDIA_DENIED', 'that plugin cannot hand files over to this one');
    row = media.row(source.id, mf.mediaId);
  } else {
    needMedia(plugin);
    need(typeof file.mediaId === 'string' && media.ID_RE.test(file.mediaId), 'ERR_INVALID', 'invalid form.file.mediaId');
    row = media.row(plugin.id, file.mediaId);
  }
  need(row, 'ERR_INVALID', 'unknown media id');
  const timeoutMs = Math.max(1000, Math.min(UPLOAD_TIMEOUT_MAX_MS, o.timeoutMs == null ? UPLOAD_TIMEOUT_DEFAULT_MS : o.timeoutMs));
  return {
    o, fields, row, timeoutMs, method: o.method || 'POST',
    field: file.field, name: media.cleanName(file.name) || row.name || row.id, mime: file.mime ? file.mime.toLowerCase() : row.mime,
  };
}

async function targetUpload(plugin, args) {
  const { id, index } = targetArgs(args);
  const path = String((args && args.path) || '/');
  need(path.startsWith('/') && path.length <= 4096 && !/[\s\\]/.test(path), 'ERR_INVALID', 'path must start with /');
  const u = uploadOptions(plugin, args);
  let ep;
  try { ep = await targets.resolve(plugin, id, index, 'http', netOpts()); } catch (e) { throw netError(e); }
  const hostPart = ep.host.includes(':') ? `[${ep.host}]` : ep.host;
  const base = new URL(`${ep.scheme}://${hostPart}:${ep.port}`);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new HostApiError('ERR_INVALID', 'path leaves the target');
  for (const [k, v] of Object.entries(u.o.query || {})) {
    need(typeof k === 'string' && k.length <= 200 && ['string', 'number', 'boolean'].includes(typeof v), 'ERR_INVALID', 'invalid query');
    url.searchParams.append(k, String(v));
  }
  need(url.href.length <= 8192, 'ERR_INVALID', 'url too long');
  const boundary = `----GateControl${require('node:crypto').randomBytes(16).toString('hex')}`;
  const head = Buffer.from(u.fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
    + `--${boundary}\r\nContent-Disposition: form-data; name="${u.field}"; filename="${formQuoted(u.name)}"\r\nContent-Type: ${u.mime}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const media = require('./media');
  const row = u.row;
  async function* body() {
    yield head;
    for await (const part of media.readRange(row, 0, row.bytes - 1)) yield part;
    yield tail;
  }
  const headers = {};
  for (const [k, v] of Object.entries(u.o.headers || {})) if (k.toLowerCase() !== 'content-type') headers[k] = v;
  for (const k of Object.keys(headers)) if (ep.headers[k.toLowerCase()] !== undefined) delete headers[k];
  Object.assign(headers, ep.headers, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  const check = async (next) => {
    const nu = new URL(next);
    if (nu.origin !== base.origin) return { ok: false, reason: 'redirect_off_target' };
    return { ok: true, url: nu, port: ep.port, address: ep.address, family: ep.family };
  };
  let res;
  try {
    res = await netPolicy.fetchWithPolicy(null, url.href, {
      method: u.method, headers, bodyStream: { length: head.length + row.bytes + tail.length, read: body },
      timeoutMs: u.timeoutMs, maxBytes: LIMITS.fetchResponseBytes, redirect: 'manual', check,
    });
  } catch (e) {
    if (String((e && e.message) || e) === 'timeout') throw new HostApiError('ERR_TIMEOUT', 'the upload did not finish in time');
    throw netError(e);
  }
  return fetchResult(res, u.o);
}

/**
 * How long the host waits for one call (runtime.js): TIMEOUTS.hostCall,
 * longer for the calls moving big files (since 1.193.0).
 */
function callTimeout(api, args) {
  if (api === 'target.upload') {
    const o = args && args.opts;
    const t = o && Number.isFinite(o.timeoutMs) ? o.timeoutMs : UPLOAD_TIMEOUT_DEFAULT_MS;
    return Math.max(1000, Math.min(UPLOAD_TIMEOUT_MAX_MS, t)) + 5000;
  }
  if (api === 'media.handOver') return HANDOVER_TIMEOUT_MS;
  // the other plugins' groupDeleting hooks run first (≤ 30 s in total)
  if (api === 'groups.remove') return 45000;
  return TIMEOUTS.hostCall;
}

function _resetBudgetsForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  chatWindow.clear();
  chatUserWindow.clear();
  chatCounts.clear();
  servicesWindow.clear();
  notifyWindow.clear();
  dataWindow.clear();
  handOverWindow.clear();
}

// ─── Plugin-to-plugin actions (permissions.actions) ────
//
// gc.actions.list({ userId, lang, interactive?, withWidget? }) / gc.actions.get({ userId, actionId | plugin + id, lang, interactive?, withWidget? }) /
// gc.actions.run({ userId, actionId | plugin + id, params?, lang, state?, via?, interactive? }):
// the quick actions (quickActions.js) other plugins offer to one user, run as
// that user like the apps do — the target plugin gets the viewer
// { id, name, role, portal: true, loggedIn: true, automation: true, via: '<caller id>' }
// and decides itself. The user must exist and be enabled; the caller is never
// asked or run itself. Only plugins that may run (enabled, licensed,
// compatible, signed) and are running are asked (quickActions.eligible).
// `actionId` is the listed '<plugin>/<id>' (neither may contain '/');
// `params.state` / `state` ('on'|'off') is the state a toggle should end
// in, handled by quickActions.run like for the apps (`target` / the host's
// fallback, `unchanged`); `via`, when given, must be the caller's own id (the
// host always names the caller). `interactive: true` (needs
// permissions.actions { interactive: true }): a person pressed a button for
// exactly this action in the caller's UI just now — the target plugin then
// sees { ..., automation: false, interactive: true, via: '<caller id>' } and
// treats it like that person's tap in the apps. 60 runs per minute per
// calling plugin, an activity row `plugin_automation` per run naming the user
// and the caller (ids, the account's name and ok only — no text of either plugin).
// `withWidget: true` (list / get, since 1.181.0) adds each action's widget
// values (widgetView) — what a rule needs to compare a device value; `get`
// asks only the named plugin's hook and answers that one action or null.

const ACTIONS_PER_MINUTE = 60;
const ACTIONS_WINDOW_MS = 60000;
const actionsWindow = new Map();
const LANGS = new Set(['de', 'en']);
const RUN_PARAMS = new Set(['state']);
// what quickActions.run answers when the action did not run → `code`
const RUN_CODES = new Map([
  ['not_found', 'ERR_NOT_FOUND'], ['invalid_state', 'ERR_INVALID_STATE'], ['state_unknown', 'ERR_STATE_UNKNOWN'],
  ['plugin_error', 'ERR_PLUGIN_FAILED'], ['timeout', 'ERR_TIMEOUT'],
]);

function needActions(plugin) {
  need(plugin.manifest.permissions && plugin.manifest.permissions.actions, 'ERR_ACTIONS_DENIED', 'this plugin has no actions permission');
}

/**
 * `interactive` of a call: true (a person pressed the button in the caller's
 * UI) only with permissions.actions { interactive: true }; absent / null /
 * false = an automation run.
 */
function interactiveOf(plugin, args) {
  const v = args && args.interactive;
  if (v === undefined || v === null || v === false) return false;
  need(v === true, 'ERR_INVALID', 'interactive must be a boolean');
  need(plugin.manifest.permissions.actionsInteractive === true, 'ERR_ACTIONS_DENIED', 'this plugin may not run actions interactively (permissions.actions { interactive: true })');
  return true;
}

/**
 * The user an action runs for: an existing, enabled account → { user (viewer), lang }.
 * An automation run: { automation: true, via }; an interactive one:
 * { automation: false, interactive: true, via } — like that person's tap.
 */
function automationViewer(plugin, args, interactive = false) {
  const userId = args && args.userId;
  need(Number.isSafeInteger(userId) && userId > 0, 'ERR_INVALID', 'invalid user id');
  const lang = args.lang;
  need(lang == null || (typeof lang === 'string' && LANGS.has(lang)), 'ERR_INVALID', "lang must be 'de' or 'en'");
  const u = db().prepare('SELECT id, username, display_name, role, enabled, language FROM users WHERE id = ?').get(userId);
  need(u && u.enabled === 1, 'ERR_INVALID', 'unknown or disabled user');
  const own = typeof u.language === 'string' ? u.language.slice(0, 2).toLowerCase() : '';
  return {
    user: {
      id: u.id, name: u.display_name || u.username, role: u.role, portal: true, loggedIn: true,
      automation: !interactive, ...(interactive ? { interactive: true } : {}), via: plugin.id,
    },
    lang: lang || (LANGS.has(own) ? own : 'de'),
  };
}

/** Count one run against the calling plugin's budget per minute. */
function actionsBudget(plugin) {
  const now = Date.now();
  const w = (actionsWindow.get(plugin.id) || []).filter((t) => now - t < ACTIONS_WINDOW_MS);
  need(w.length < ACTIONS_PER_MINUTE, 'ERR_RATE_LIMIT', `too many quick action runs (${ACTIONS_PER_MINUTE} per minute)`);
  w.push(now);
  actionsWindow.set(plugin.id, w);
}

/**
 * Should the person be asked before the plain run (a press of the button)?
 * `confirm`, or a toggle whose run switches into its `confirmWhen` state —
 * a plain run flips, so the state it ends in is the other one; a toggle
 * without a listed state could end in either, so it asks as well.
 */
function needsConfirm(a) {
  if (a.confirm === true) return true;
  if (a.kind !== 'toggle' || !a.confirmWhen) return false;
  if (a.state === null) return true;
  return (a.state === 'on' ? 'off' : 'on') === a.confirmWhen;
}

/** `withWidget` of a list / get call: true, or false when absent / null / false. */
function withWidgetOf(args) {
  const v = args && args.withWidget;
  if (v === undefined || v === null || v === false) return false;
  need(v === true, 'ERR_INVALID', 'withWidget must be a boolean');
  return true;
}

/**
 * The values of a (sanitised) widget another plugin gets with withWidget —
 * { value, unit, label, badge: { value, unit, label, state } | null,
 *   readings: [{ id, label, value, unit }], state, status } or null. No
 * controls, icons or power: reading values, not drawing the card.
 */
function widgetView(w) {
  if (!w) return null;
  return {
    value: w.value, unit: w.unit, label: w.label,
    badge: w.badge ? { value: w.badge.value, unit: w.badge.unit, label: w.badge.label, state: w.badge.state } : null,
    readings: w.readings.map((r) => ({ id: r.id, label: r.label, value: r.value, unit: r.unit })),
    state: w.state, status: w.status,
  };
}

/** One listed action as gc.actions.list / get answer it (+ widget with withWidget). */
function actionView(a, withWidget) {
  return {
    actionId: `${a.plugin}/${a.id}`, plugin: a.plugin, pluginName: a.pluginName, id: a.id, label: a.title, title: a.title,
    subtitle: a.subtitle, icon: a.icon, kind: a.kind, state: a.state, needsConfirm: needsConfirm(a), confirmWhen: a.confirmWhen,
    verbs: a.verbs, targets: a.targets, device: a.device,
    ...(withWidget ? { widget: widgetView(a.widget) } : {}),
  };
}

/**
 * gc.actions.list → [{ actionId, plugin, pluginName, id, label, title, subtitle, icon, kind, state,
 * needsConfirm, confirmWhen, verbs, targets, device, widget? }] of every other plugin
 * (widget only with withWidget: true).
 */
async function actionsList(plugin, args) {
  needActions(plugin);
  const interactive = interactiveOf(plugin, args);
  const withWidget = withWidgetOf(args);
  const { user, lang } = automationViewer(plugin, args, interactive);
  const all = await require('./quickActions').list(user, lang, { exclude: plugin.id });
  return all.map((a) => actionView(a, withWidget));
}

/** The action a run names: `actionId` '<plugin>/<id>', or `plugin` + `id` → { target, actionId }. */
function runTarget(plugin, args, ACTION_ID_RE) {
  const { ID_RE } = require('./constants');
  let target;
  let actionId;
  if (args.actionId !== undefined && args.actionId !== null) {
    need(args.plugin == null && args.id == null, 'ERR_INVALID', 'actionId or plugin + id, not both');
    const ref = args.actionId;
    need(typeof ref === 'string' && ref.length <= 129, 'ERR_INVALID', "actionId must be '<plugin>/<id>'");
    const slash = ref.indexOf('/');
    need(slash > 0, 'ERR_INVALID', "actionId must be '<plugin>/<id>'");
    target = ref.slice(0, slash);
    actionId = ref.slice(slash + 1);
  } else {
    target = args.plugin;
    actionId = args.id;
  }
  need(typeof target === 'string' && target.length >= 2 && target.length <= 64 && ID_RE.test(target), 'ERR_INVALID', 'invalid plugin id');
  let resolved = null;
  try { resolved = require('./registry').resolve(target); } catch { resolved = null; }
  need(target !== plugin.id && (!resolved || resolved.id !== plugin.id), 'ERR_INVALID', 'a plugin cannot use its own quick actions through gc.actions');
  need(typeof actionId === 'string' && ACTION_ID_RE.test(actionId), 'ERR_INVALID', 'invalid action id');
  return { target, actionId };
}

/** The state a run asks for: `params.state` or `state` (not both) — validated by quickActions.run. */
function runState(args) {
  const params = args.params;
  if (params === undefined || params === null) return args.state;
  need(typeof params === 'object' && !Array.isArray(params), 'ERR_INVALID', 'params must be an object');
  for (const k of Object.keys(params)) need(RUN_PARAMS.has(k), 'ERR_INVALID', `unknown param ${String(k).slice(0, 32)}`);
  if (params.state === undefined || params.state === null) return args.state;
  need(args.state === undefined || args.state === null, 'ERR_INVALID', 'state or params.state, not both');
  return params.state;
}

/**
 * gc.actions.get → one action of another plugin, exactly as list() would
 * answer it for that user (widget only with withWidget: true), or null when
 * that plugin does not offer it to the user (unknown, not eligible, not
 * listed, the hook failed). Only the named plugin's hook is asked; not
 * counted in the run budget.
 */
async function actionsGet(plugin, args) {
  needActions(plugin);
  const quickActions = require('./quickActions');
  need(args && typeof args === 'object', 'ERR_INVALID', 'invalid arguments');
  const { target, actionId } = runTarget(plugin, args, quickActions.ACTION_ID_RE);
  const withWidget = withWidgetOf(args);
  const interactive = interactiveOf(plugin, args);
  const { user, lang } = automationViewer(plugin, args, interactive);
  const found = (await quickActions.listOf(target, user, lang)).find((a) => a.id === actionId);
  return found ? actionView(found, withWidget) : null;
}

/**
 * gc.actions.run → { ok, message, state, unchanged, result?, code?, error? }:
 * result { message, state, unchanged } when the target plugin answered (or
 * the host skipped an unchanged toggle); ok false → code ERR_NOT_FOUND |
 * ERR_INVALID_STATE | ERR_STATE_UNKNOWN | ERR_PLUGIN_FAILED | ERR_TIMEOUT
 * (did not run; + error 'not_found'|'invalid_state'|'state_unknown'|
 * 'plugin_error'|'timeout') or ERR_ACTION_FAILED (ran, the plugin said no).
 */
async function actionsRun(plugin, args) {
  needActions(plugin);
  const quickActions = require('./quickActions');
  need(args && typeof args === 'object', 'ERR_INVALID', 'invalid arguments');
  const { target, actionId } = runTarget(plugin, args, quickActions.ACTION_ID_RE);
  need(args.via === undefined || args.via === null || args.via === plugin.id, 'ERR_INVALID', "via must be the calling plugin's own id");
  const want = runState(args);
  const interactive = interactiveOf(plugin, args);
  const { user, lang } = automationViewer(plugin, args, interactive);
  actionsBudget(plugin);
  let r;
  try { r = await quickActions.run(target, actionId, user, lang, { state: want }); } catch { r = { status: 502, body: { ok: false, error: 'plugin_error' } }; }
  const ok = r.status === 200 && r.body.ok === true;
  let out;
  if (r.status === 200) {
    const result = { message: r.body.message, state: r.body.state, unchanged: r.body.unchanged === true };
    out = { ok: r.body.ok, ...result, result, ...(ok ? {} : { code: 'ERR_ACTION_FAILED' }) };
  } else {
    const error = r.body.error;
    out = { ok: false, message: null, state: null, unchanged: false, error, code: RUN_CODES.get(error) || 'ERR_PLUGIN_FAILED' };
  }
  try {
    require('../activity').log('plugin_automation', `Quick action "${actionId}" of plugin "${target}" run for user "${user.name}" via plugin "${plugin.id}"${interactive ? ' (interactive)' : ''} (${ok ? 'ok' : 'failed'})`, {
      source: 'plugin', severity: ok ? 'info' : 'warning',
      details: {
        plugin: plugin.id, via: plugin.id, target, action: actionId, userId: user.id, ok,
        ...(interactive ? { interactive: true } : {}),
        ...(quickActions.TOGGLE_STATES.has(want) ? { state: want } : {}),
        ...(out.unchanged ? { unchanged: true } : {}),
        ...(out.error ? { error: out.error } : {}),
      },
    });
  } catch { /* the run happened; the log is best-effort */ }
  return out;
}

function _resetActionsBudgetForTest() {
  if (process.env.NODE_ENV === 'test') actionsWindow.clear();
}

/**
 * @param {object} plugin  registry entry (with manifest)
 * @param {string} api
 * @param {object} args
 */
async function handle(plugin, api, args, ctx) {
  switch (api) {
    case 'http.fetch': return httpFetch(plugin, args);
    case 'ws.connect': return wsConnect(plugin, args, ctx);
    case 'ws.send': return wsSend(plugin, args);
    case 'ws.close': return wsClose(plugin, args);
    case 'target.tcp': return tcpConnect(plugin, args, ctx);
    case 'tcp.write': return tcpWrite(plugin, args);
    case 'tcp.end': sockOf(plugin, args).end(); return null;
    case 'tcp.destroy': sockOf(plugin, args).destroy(); return null;
    case 'tcp.setTimeout': sockOf(plugin, args).setTimeout(Math.max(0, Math.min(3600000, Number(args.ms) || 0))); return null;
    case 'target.fetch': return targetFetch(plugin, args);
    case 'target.upload': return targetUpload(plugin, args);
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
    case 'settings.setSecret': {
      const v = args && args.value;
      need(v === null || v === undefined || (typeof v === 'string' && v.length <= 4000), 'ERR_INVALID', 'invalid secret');
      const r = await pluginSettings.saveSecret(plugin, keyOf(args), v == null || v === '' ? null : v);
      if (!r.ok) throw new HostApiError('ERR_INVALID', 'invalid setting');
      return null;
    }
    case 'users.list': {
      need(plugin.manifest.permissions && plugin.manifest.permissions.users, 'ERR_USERS_DENIED', 'this plugin has no users permission');
      const rows = db().prepare(`SELECT ${USER_COLS} FROM users WHERE enabled = 1 ORDER BY id LIMIT 5000`).all();
      const looks = require('../avatars').infoMany(rows);
      return rows.map((u) => userView(u, looks.get(u.id)));
    }
    case 'users.get': {
      need(plugin.manifest.permissions && plugin.manifest.permissions.users, 'ERR_USERS_DENIED', 'this plugin has no users permission');
      const id = Number(args && args.id);
      need(Number.isInteger(id) && id > 0, 'ERR_INVALID', 'invalid user id');
      return userView(db().prepare(`SELECT ${USER_COLS} FROM users WHERE id = ? AND enabled = 1`).get(id));
    }
    case 'kiosk.allow': {
      // docs/feature-kiosk-devices.md: mark/unmark a user as a kiosk user (never an admin or a disabled account)
      need(plugin.manifest.permissions && plugin.manifest.permissions.kiosk, 'ERR_KIOSK_DENIED', 'this plugin has no kiosk permission');
      const id = Number(args && args.userId);
      need(Number.isSafeInteger(id) && id > 0, 'ERR_INVALID', 'invalid user id');
      need(typeof (args && args.allowed) === 'boolean', 'ERR_INVALID', 'allowed must be true or false');
      try {
        require('../kiosk').allow(plugin, id, args.allowed);
      } catch (e) {
        if (e && e.code === 'ERR_INVALID') throw new HostApiError('ERR_INVALID', e.message);
        throw e;
      }
      return null;
    }
    case 'kiosk.list':
      need(plugin.manifest.permissions && plugin.manifest.permissions.kiosk, 'ERR_KIOSK_DENIED', 'this plugin has no kiosk permission');
      return require('../kiosk').listAllowed(plugin.id);
    case 'actions.list': return actionsList(plugin, args);
    case 'actions.get': return actionsGet(plugin, args);
    case 'actions.run': return actionsRun(plugin, args);
    case 'notify': return notify(plugin, await notifyImageFromMedia(plugin, args));
    case 'notify.routes.get': return notifyRoutes(plugin, 'get', args);
    case 'notify.routes.set': return notifyRoutes(plugin, 'set', args);
    case 'media.info': return mediaCall(plugin, 'info', args);
    case 'media.claim': return mediaCall(plugin, 'claim', args);
    case 'media.delete': return mediaCall(plugin, 'delete', args);
    case 'media.usage': return mediaCall(plugin, 'usage', args);
    case 'media.url': return mediaCall(plugin, 'url', args);
    case 'media.fetch': return mediaFetch(plugin, args);
    case 'media.handOver': return mediaHandOver(plugin, args);
    case 'publicLinks.create': return publicLinksCall(plugin, 'create', args);
    case 'publicLinks.list': return publicLinksCall(plugin, 'list', args);
    case 'publicLinks.get': return publicLinksCall(plugin, 'get', args);
    case 'publicLinks.revoke': return publicLinksCall(plugin, 'revoke', args);
    case 'devices.list': return devicesList(plugin, args);
    // person groups (permissions.groups, groups.js): read; ensure / remove need "manage"
    case 'groups.list': return require('./groups').call(plugin, 'list', args);
    case 'groups.get': return require('./groups').call(plugin, 'get', args);
    case 'groups.members': return require('./groups').call(plugin, 'members', args);
    case 'groups.isMember': return require('./groups').call(plugin, 'isMember', args);
    case 'groups.leadersOf': return require('./groups').call(plugin, 'leadersOf', args);
    case 'groups.ensure': return require('./groups').call(plugin, 'ensure', args);
    case 'groups.remove': return require('./groups').call(plugin, 'remove', args);
    case 'events.emit': return eventsEmit(plugin, args);
    case 'services.call': return servicesCall(plugin, args);
    case 'services.available': return servicesAvailable(plugin, args);
    case 'license.status': {
      const s = licensing.status(plugin);
      return { required: s.required, licensed: s.licensed, state: s.state, expiresAt: s.expiresAt || null };
    }
    default:
      throw new HostApiError('ERR_UNKNOWN_API', 'unknown host API');
  }
}

module.exports = {
  handle, closeSockets, HostApiError, ACTIONS_PER_MINUTE, CHAT_PER_HOUR, CHAT_PER_USER_HOUR, SERVICES_PER_HOUR, SERVICE_JSON_MAX, SERVICE_PAYLOAD_MAX,
  DATA_PER_HOUR, HANDOVER_PER_HOUR, callTimeout, handOverAllowed,
  flushChatSummary, _resetActionsBudgetForTest, _resetBudgetsForTest, _lookup: null, _udpTargets: null, _serviceTimeoutMs: null,
};
