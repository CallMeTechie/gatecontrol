'use strict';

// gc.mail.dav.request (plugin.json `permissions.mail.dav`, docs/plugins.md
// "Mail › CalDAV/CardDAV", since 1.219.0): one WebDAV request of the mail
// plugin to the calendar and address book servers people enter themselves
// (GMX, Web.de, their own domain, Nextcloud). The protocol (discovery, sync,
// conflicts) stays in the plugin; the host only makes the request and reads
// a 207 Multi-Status.
//
//   * https only, ports 443 and 8443 (else ERR_NETWORK_DENIED). Every resolved
//     address must be public — the check of gc.mail (netPolicy.checkInternet
//     with an anyPublic policy); the connection goes to the checked address
//     (DNS pinned), TLS names the host (SNI) and always checks its
//     certificate, at least TLS 1.2. There is no switch.
//   * Methods GET HEAD OPTIONS PROPFIND REPORT PUT DELETE; request headers
//     only from HEADERS. The host sets User-Agent and Authorization itself:
//     credentials come only as `auth` (Basic or Bearer), never as a header
//     or in the URL. No cookies (none sent, Set-Cookie dropped), no Referer.
//   * Redirects within the same origin (scheme, host, port) are followed —
//     at most 5, each checked again, with `auth`. A redirect to another
//     origin is never followed: the 3xx comes back with `headers.location`
//     and the plugin decides (credentials never go to a host it did not ask).
//   * Limits: request body ≤ 2 MB, the answer ≤ maxBytes (default 5 MB, at
//     most 20 MB, also after decompression) → ERR_MAIL_LIMIT; the whole
//     request with its redirects within timeoutMs (1 … 60 s) → ERR_MAIL_NET;
//     8 requests per plugin at a time (more wait, at most 100 and 2 minutes).
//   * XML: saxes, namespace-exact; a DTD (and so any entity of its own) →
//     ERR_DAV_XML instead of an expansion; depth ≤ 64, ≤ 10 000 responses.
//   * HTTP status codes (401, 404, 412, 5xx …) are no errors: they come back
//     as `status`.

const https = require('node:https');
const zlib = require('node:zlib');
const netPolicy = require('../netPolicy');
const net = require('./net');

const { MailError, fail, need } = net;

const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT', 'PUT', 'DELETE']);
const HEADERS = new Set(['depth', 'content-type', 'if-match', 'if-none-match', 'prefer', 'brief', 'accept', 'if-modified-since']);
const RESPONSE_HEADERS = ['etag', 'content-type', 'location', 'dav', 'allow', 'retry-after', 'last-modified', 'content-length'];
const PORTS = Object.freeze([[443, 443], [8443, 8443]]);
const USER_AGENT = 'GateControl-Mail';
const URL_MAX = 8192;
const HEADER_VALUE_MAX = 8192;
const RESPONSE_HEADER_MAX = 4096;
const BODY_MAX = 2 * 1024 * 1024;
const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_DEFAULT_MS = 30000;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 60000;
const REDIRECTS_MAX = 5;
const PARALLEL = 8;
const WAITING_MAX = 100;
const WAIT_MAX_MS = 2 * 60 * 1000;
const XML_DEPTH_MAX = 64;
const XML_RESPONSES_MAX = 10000;
const XML_ELEMENTS_MAX = 250000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const XML_TYPE_RE = /^(?:application|text)\/(?:[a-z0-9.-]+\+)?xml$/;
const BEARER_RE = /^[A-Za-z0-9\-._~+/]+=*$/;
const CTRL_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const HEADER_VALUE_RE = /^[\t\u0020-\u007e]*$/; // printable ASCII and tab: no line breaks, nothing a server reads differently

const slots = new Map(); // plugin id → { running, waiting: [{ resolve, reject, timer }], active: Set<ClientRequest> }

/** Set an own property, also for a name like "__proto__" (props and attributes are named by the server). */
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

// ─── Arguments ──────────────────────────────────

function urlOf(v, what = 'url') {
  need(typeof v === 'string' && v.length >= 1 && v.length <= URL_MAX, 'ERR_INVALID', `invalid ${what}`);
  let u;
  try { u = new URL(v); } catch { fail('ERR_INVALID', `invalid ${what}`); }
  need(!u.username && !u.password, 'ERR_INVALID', 'credentials only through auth, never in the url');
  u.hash = '';
  return u;
}

function headersOf(h) {
  const out = {};
  if (h == null) return out;
  need(typeof h === 'object' && !Array.isArray(h), 'ERR_INVALID', 'invalid headers');
  for (const [k, v] of Object.entries(h)) {
    const key = String(k).toLowerCase();
    need(HEADERS.has(key), 'ERR_INVALID', `header ${String(k).slice(0, 40)} not allowed (${[...HEADERS].join(', ')})`);
    need(!has(out, key), 'ERR_INVALID', `header ${key} given twice`);
    need(typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)), 'ERR_INVALID', `invalid header ${key}`);
    const val = String(v);
    need(val.length <= HEADER_VALUE_MAX && HEADER_VALUE_RE.test(val), 'ERR_INVALID', `invalid header ${key}`);
    out[key] = val;
  }
  return out;
}

/** auth: { user, pass } (Basic) | { bearer } | null → { header, secrets } */
function authOf(a) {
  if (a == null) return { header: null, secrets: [] };
  need(typeof a === 'object' && !Array.isArray(a), 'ERR_INVALID', 'invalid auth');
  const keys = Object.keys(a);
  if (has(a, 'bearer')) {
    need(keys.length === 1, 'ERR_INVALID', 'auth is { user, pass } or { bearer }');
    need(typeof a.bearer === 'string' && a.bearer.length <= 16384 && BEARER_RE.test(a.bearer), 'ERR_INVALID', 'invalid auth.bearer');
    return { header: `Bearer ${a.bearer}`, secrets: [a.bearer] };
  }
  need(keys.every((k) => k === 'user' || k === 'pass'), 'ERR_INVALID', 'auth is { user, pass } or { bearer }');
  need(typeof a.user === 'string' && a.user.length >= 1 && a.user.length <= 320 && !a.user.includes(':') && !CTRL_RE.test(a.user) && !a.user.includes('\t'),
    'ERR_INVALID', 'invalid auth.user');
  need(typeof a.pass === 'string' && a.pass.length >= 1 && a.pass.length <= 1024 && !CTRL_RE.test(a.pass), 'ERR_INVALID', 'invalid auth.pass');
  const token = Buffer.from(`${a.user}:${a.pass}`, 'utf8').toString('base64');
  return { header: `Basic ${token}`, secrets: [a.pass, token, a.user] };
}

function optionsOf(args) {
  need(args && typeof args === 'object' && !Array.isArray(args), 'ERR_INVALID', 'invalid options');
  const url = urlOf(args.url);
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : (args.method == null ? 'GET' : '');
  need(METHODS.has(method), 'ERR_INVALID', `method must be one of ${[...METHODS].join(' ')}`);
  const headers = headersOf(args.headers);
  let body = null;
  if (args.body != null) {
    need(typeof args.body === 'string', 'ERR_INVALID', 'body must be a string');
    need(method !== 'GET' && method !== 'HEAD', 'ERR_INVALID', `${method} has no body`);
    body = Buffer.from(args.body, 'utf8');
    need(body.length <= BODY_MAX, 'ERR_MAIL_LIMIT', 'the body is larger than 2 MB');
  }
  const auth = authOf(args.auth);
  let timeoutMs = TIMEOUT_DEFAULT_MS;
  if (args.timeoutMs != null) {
    need(Number.isFinite(args.timeoutMs), 'ERR_INVALID', 'invalid timeoutMs');
    timeoutMs = Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, Math.round(args.timeoutMs)));
  }
  let maxBytes = MAX_BYTES_DEFAULT;
  if (args.maxBytes != null) {
    need(Number.isSafeInteger(args.maxBytes) && args.maxBytes >= 1, 'ERR_INVALID', 'invalid maxBytes');
    maxBytes = Math.min(MAX_BYTES, args.maxBytes);
  }
  const parse = args.parse == null ? 'auto' : args.parse;
  need(parse === 'auto' || parse === 'none', 'ERR_INVALID', "parse must be 'auto' or 'none'");
  return { url, method, headers, body, auth, timeoutMs, maxBytes, parse };
}

// ─── Network ────────────────────────────────────

/** A pause of at most `ms`, then `onTimeout` (a DNS lookup cannot be cancelled). */
function within(p, ms, onTimeout) {
  let t;
  return Promise.race([p, new Promise((resolve, reject) => { t = setTimeout(() => reject(onTimeout()), Math.max(0, ms)); t.unref(); })])
    .finally(() => clearTimeout(t));
}

/** https on 443 / 8443 to public addresses only → the checked target. */
async function targetOf(u, deadline, opts) {
  if (u.protocol !== 'https:') fail('ERR_NETWORK_DENIED', 'https only');
  const port = u.port ? Number(u.port) : 443;
  if (port !== 443 && port !== 8443) fail('ERR_NETWORK_DENIED', 'only ports 443 and 8443');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  need(host, 'ERR_INVALID', 'invalid url');
  const r = await within(netPolicy.checkInternet(netPolicy.anyPublic(PORTS), host, port, { lookup: opts.lookup, reserved: opts.reserved }),
    deadline - Date.now(), () => new MailError('ERR_MAIL_NET', 'timeout'));
  if (!r.ok) {
    if (r.reason === 'dns') fail('ERR_MAIL_NET', `the server ${host} was not found`);
    if (r.reason === 'invalid_host' || r.reason === 'invalid_port') fail('ERR_INVALID', 'invalid url');
    fail('ERR_NETWORK_DENIED', `connection refused by the mail policy: ${r.reason}`);
  }
  return { host, port, address: r.address, family: r.family };
}

/** An error of the connection → ERR_MAIL_NET (never with the credentials). */
function netFail(e, secrets) {
  if (e instanceof MailError) return e;
  const msg = String((e && e.message) || (e && e.code) || 'error');
  if (msg === 'timeout') return new MailError('ERR_MAIL_NET', 'timeout');
  const text = net.isTlsError(e) ? `TLS: ${msg}` : msg;
  return new MailError('ERR_MAIL_NET', net.serverText(text, secrets) || 'the server is not reachable');
}

/**
 * One request to the checked target. Resolves with the response once its
 * headers are there; the caller reads (readBody) or drops it. The request
 * ends at `deadline` at the latest.
 */
function send(ctx, u, target, method, headers, body, deadline) {
  return new Promise((resolve, reject) => {
    const isIp = netPolicy.isIpLiteral(target.host);
    const hdrs = { ...headers, host: u.host, 'user-agent': USER_AGENT, 'accept-encoding': 'identity', connection: 'close' };
    if (ctx.auth.header) hdrs.authorization = ctx.auth.header;
    if (body) hdrs['content-length'] = String(body.length);
    else if (method === 'PUT' || method === 'PROPFIND' || method === 'REPORT') hdrs['content-length'] = '0';
    let req;
    try {
      req = https.request({
        ...net.tlsOptions(target.host),
        hostname: target.host,
        port: net.connectPort(target.port),
        path: u.pathname + u.search,
        method,
        headers: hdrs,
        agent: false,
        ...(isIp ? {} : { servername: target.host }),
        // pinned: the connection goes to the address checked above, no second lookup
        lookup: (_h, o, cb) => {
          if (o && o.all) return cb(null, [{ address: target.address, family: target.family }]);
          return cb(null, target.address, target.family);
        },
      });
    } catch (e) { reject(netFail(e, ctx.auth.secrets)); return; }
    ctx.active.add(req);
    const timer = setTimeout(() => req.destroy(new Error('timeout')), Math.max(0, deadline - Date.now()));
    timer.unref();
    req.on('close', () => { clearTimeout(timer); ctx.active.delete(req); });
    req.on('error', (e) => reject(e && e.code === 'ERR_MAIL_LIMIT' ? e : netFail(e, ctx.auth.secrets)));
    req.on('response', (res) => resolve({ req, res }));
    if (body) req.write(body);
    req.end();
  });
}

/** The body of `res`, decompressed when the server compressed it anyway, at most `max` bytes (else ERR_MAIL_LIMIT). */
function readBody(ctx, req, res, method, max) {
  return new Promise((resolve, reject) => {
    const enc = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
    let stream = res;
    if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
    else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    else if (enc !== 'identity' && enc !== '') { req.destroy(); reject(new MailError('ERR_MAIL_NET', `unsupported content-encoding ${enc.slice(0, 40)}`)); return; }
    const tooLarge = () => {
      const e = new MailError('ERR_MAIL_LIMIT', `the answer is larger than maxBytes (${max})`);
      reject(e);
      req.destroy(e);
      if (stream !== res) stream.destroy();
    };
    // a declared length beyond the limit is refused before a byte is read (HEAD has no body)
    const declared = Number(res.headers['content-length']);
    if (method !== 'HEAD' && stream === res && Number.isFinite(declared) && declared > max) { tooLarge(); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    stream.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { done = true; tooLarge(); return; }
      chunks.push(c);
    });
    stream.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    const failed = (e) => { if (!done) { done = true; reject(e && e.code === 'ERR_MAIL_LIMIT' ? e : netFail(e, ctx.auth.secrets)); } };
    stream.on('error', failed);
    res.on('error', failed);
    res.on('aborted', () => failed(new Error('the connection was cut off')));
    req.on('error', failed);
  });
}

function responseHeaders(h, url) {
  const out = {};
  for (const k of RESPONSE_HEADERS) {
    let v = h[k];
    if (v == null) continue;
    if (Array.isArray(v)) v = v.join(', ');
    v = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, RESPONSE_HEADER_MAX);
    if (k === 'location') {
      try { const l = new URL(v, url); l.username = ''; l.password = ''; v = l.href; } catch { /* the plugin gets it as it came */ }
    }
    out[k] = v;
  }
  return out;
}

// ─── Concurrency ────────────────────────────────

function slotOf(pluginId) {
  let st = slots.get(pluginId);
  if (!st) { st = { running: 0, waiting: [], active: new Set() }; slots.set(pluginId, st); }
  return st;
}

async function acquire(st) {
  if (st.running >= PARALLEL) {
    need(st.waiting.length < WAITING_MAX, 'ERR_MAIL_LIMIT', `too many CalDAV/CardDAV requests waiting (${WAITING_MAX})`);
    await new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = st.waiting.indexOf(w);
        if (i >= 0) st.waiting.splice(i, 1);
        reject(new MailError('ERR_MAIL_LIMIT', `no free slot for the request within ${WAIT_MAX_MS / 1000} s (${PARALLEL} at a time)`));
      }, WAIT_MAX_MS);
      w.timer.unref();
      st.waiting.push(w);
    });
  }
  st.running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    st.running--;
    const next = st.waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
  };
}

/** End the plugin's requests (its process ended, it was stopped or uninstalled). */
function closeAll(pluginId) {
  const st = slots.get(pluginId);
  slots.delete(pluginId);
  if (!st) return;
  for (const w of st.waiting.splice(0)) { clearTimeout(w.timer); w.reject(new MailError('ERR_MAIL_NET', 'plugin stopped')); }
  for (const req of st.active) req.destroy(new MailError('ERR_MAIL_NET', 'plugin stopped'));
}

// ─── Multi-Status ───────────────────────────────

function nameOf(uri, local) { return uri ? `{${uri}}${local}` : local; }

/**
 * An XML document → its root element as nodes { name, text, attrs?, children? }.
 * Namespace-exact (saxes); a DTD, an unknown entity, a depth over 64 or more
 * than XML_ELEMENTS_MAX elements → ERR_DAV_XML.
 */
function xmlTree(xml, { responseName = null, responsesMax = Infinity } = {}) {
  const { SaxesParser } = require('saxes');
  const parser = new SaxesParser({ xmlns: true, position: true });
  const bad = (msg) => { throw new MailError('ERR_DAV_XML', `invalid XML: ${String(msg).slice(0, 160)}`); };
  const stack = [];
  let root = null;
  let elements = 0;
  let responses = 0;
  parser.on('error', (e) => bad(e && e.message));
  parser.on('doctype', () => bad('a DTD is not allowed'));
  parser.on('opentag', (tag) => {
    if (++elements > XML_ELEMENTS_MAX) bad(`more than ${XML_ELEMENTS_MAX} elements`);
    if (stack.length >= XML_DEPTH_MAX) bad(`deeper than ${XML_DEPTH_MAX} levels`);
    const node = { name: nameOf(tag.uri, tag.local), text: null };
    for (const a of Object.values(tag.attributes || {})) {
      if (a.prefix === 'xmlns' || a.name === 'xmlns') continue;
      if (!node.attrs) node.attrs = {};
      put(node.attrs, nameOf(a.uri, a.local), String(a.value));
    }
    if (stack.length === 1 && responseName && node.name === responseName && ++responses > responsesMax) bad(`more than ${responsesMax} responses`);
    const parent = stack[stack.length - 1];
    if (parent) (parent.node.children || (parent.node.children = [])).push(node);
    else root = node;
    stack.push({ node, text: [] });
  });
  const addText = (t) => { const top = stack[stack.length - 1]; if (top) top.text.push(t); };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => {
    const { node, text } = stack.pop();
    const s = text.join('');
    node.text = s === '' || (node.children && !s.trim()) ? null : s;
  });
  try {
    parser.write(xml).close();
  } catch (e) {
    if (e instanceof MailError) throw e;
    bad(e && e.message);
  }
  if (!root) bad('no root element');
  return root;
}

function statusOf(node) {
  const s = node && (node.children || []).find((c) => c.name === '{DAV:}status');
  const m = s && s.text ? /^\s*HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(s.text) : null;
  return m ? Number(m[1]) : null;
}

/** A node without its name (the value of a property). */
function valueOf(node) {
  const out = { text: node.text };
  if (node.attrs) out.attrs = node.attrs;
  if (node.children) out.children = node.children;
  return out;
}

/**
 * A 207 Multi-Status → { responses: [{ href (absolute), status, propstat: [{ status, props }], error }], syncToken }.
 * Props are named '{namespace}local'; a response with several hrefs (and one status) counts once per href.
 */
function parseMultistatus(xml, baseUrl) {
  const root = xmlTree(xml, { responseName: '{DAV:}response', responsesMax: XML_RESPONSES_MAX });
  if (root.name !== '{DAV:}multistatus') throw new MailError('ERR_DAV_XML', 'not a DAV:multistatus');
  const responses = [];
  let syncToken = null;
  for (const child of root.children || []) {
    if (child.name === '{DAV:}sync-token') { syncToken = child.text ? child.text.trim() || null : null; continue; }
    if (child.name !== '{DAV:}response') continue;
    const kids = child.children || [];
    const propstat = kids.filter((k) => k.name === '{DAV:}propstat').map((ps) => {
      const props = {};
      for (const prop of (ps.children || []).filter((k) => k.name === '{DAV:}prop')) {
        for (const p of prop.children || []) if (!has(props, p.name)) put(props, p.name, valueOf(p));
      }
      return { status: statusOf(ps), props };
    });
    const err = kids.find((k) => k.name === '{DAV:}error');
    const status = statusOf(child);
    for (const h of kids.filter((k) => k.name === '{DAV:}href')) {
      const raw = (h.text || '').trim();
      if (!raw) continue;
      let href = raw;
      try { href = new URL(raw, baseUrl).href; } catch { /* kept as it came */ }
      responses.push({ href, status, propstat, error: err ? valueOf(err) : null });
    }
  }
  return { responses, syncToken };
}

// ─── The request ────────────────────────────────

/**
 * gc.mail.dav.request({ url, method, headers, body, auth, timeoutMs, maxBytes, parse })
 * → { status, url, headers, body: string | null, multistatus: { responses, syncToken } | null }
 */
async function request(plugin, args, opts = {}) {
  const o = optionsOf(args);
  const st = slotOf(plugin.id);
  const release = await acquire(st);
  const ctx = { auth: o.auth, active: st.active };
  const deadline = Date.now() + o.timeoutMs;
  try {
    let current = o.url;
    let method = o.method;
    let body = o.body;
    const headers = { ...o.headers };
    for (let hop = 0; ; hop++) {
      if (Date.now() >= deadline) fail('ERR_MAIL_NET', 'timeout');
      const target = await targetOf(current, deadline, opts);
      const { req, res } = await send(ctx, current, target, method, headers, body, deadline);
      const loc = res.headers.location;
      let next = null;
      if (REDIRECT_STATUS.has(res.statusCode) && typeof loc === 'string') {
        try { next = new URL(loc, current); } catch { next = null; }
      }
      // only within the same origin (scheme, host, port), never to http
      if (next && next.origin === current.origin && next.protocol === 'https:') {
        res.on('error', () => { /* dropped on purpose */ });
        res.resume();
        req.destroy();
        if (hop >= REDIRECTS_MAX) fail('ERR_MAIL_NET', `more than ${REDIRECTS_MAX} redirects`);
        next.username = '';
        next.password = '';
        next.hash = '';
        if (res.statusCode === 303 && method !== 'HEAD') { method = 'GET'; body = null; delete headers['content-type']; }
        current = next;
        continue;
      }
      const raw = await readBody(ctx, req, res, method, o.maxBytes);
      const text = new TextDecoder('utf-8').decode(raw);
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const out = { status: res.statusCode, url: current.href, headers: responseHeaders(res.headers, current), body: text, multistatus: null };
      if (o.parse === 'auto' && res.statusCode === 207 && (XML_TYPE_RE.test(type) || type === '')) {
        out.multistatus = parseMultistatus(text, current.href);
        out.body = null;
      }
      return out;
    }
  } catch (e) {
    throw netFail(e, o.auth.secrets);
  } finally {
    release();
  }
}

/** How long the host waits for one request (a free slot, then timeoutMs). */
function callTimeout(args) {
  const t = args && Number.isFinite(args.timeoutMs) ? Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, args.timeoutMs)) : TIMEOUT_DEFAULT_MS;
  return WAIT_MAX_MS + t + 15000;
}

function stats(pluginId) {
  const st = slots.get(pluginId);
  return { running: st ? st.running : 0, waiting: st ? st.waiting.length : 0, active: st ? st.active.size : 0 };
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  for (const id of [...slots.keys()]) closeAll(id);
}

module.exports = {
  request, parseMultistatus, xmlTree, closeAll, callTimeout, stats, _resetForTest,
  METHODS, HEADERS, PORTS, USER_AGENT, BODY_MAX, MAX_BYTES, MAX_BYTES_DEFAULT, TIMEOUT_MAX_MS, REDIRECTS_MAX, PARALLEL,
  XML_DEPTH_MAX, XML_RESPONSES_MAX,
};
