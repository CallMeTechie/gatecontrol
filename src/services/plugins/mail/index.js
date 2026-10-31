'use strict';

// gc.mail (plugin.json `permissions.mail`, docs/plugins.md "Mail", since
// 1.216.0): IMAP sessions held by the host for a plugin process, SMTP sending,
// writing and reading MIME, cleaning mail HTML and finding a provider's
// servers. The plugin process never gets a socket: it holds a proxy of the
// session (child/bootstrap.js MailSession), every command comes over the IPC
// and is checked here; the session's events (exists, expunge, flags, close,
// error) go back to that process as { t: 'mail', id, ev, data }.
//
// Sessions belong to the plugin process that opened them: they all end when
// the process ends (runtime.js onExit → hostApi.closeSockets → closeAll), at
// most permissions.mail.maxConnections at the same time (ERR_MAIL_LIMIT), and
// the host closes a session nobody used for IDLE_UNUSED_MS without IDLE.
// One command at a time per session; IDLE (s.idle()) is broken by the next
// command and started again after it, as long as the plugin wants it.
// Attachments and raw mails go straight into the plugin's media (unclaimed,
// removed after 24 h unless claimed — media.js).
// Since 1.219.0 also CalDAV/CardDAV requests (`permissions.mail.dav`,
// gc.mail.dav.request — dav.js) and the calendar parts of mails (iMIP, mime.js).

const crypto = require('node:crypto');
const net = require('./net');
const mime = require('./mime');

const { MailError, fail, need } = net;

const CONNECT_TIMEOUT_DEFAULT_MS = 30000;
const CONNECT_TIMEOUT_MAX_MS = 60000;
const MESSAGE_MAX_DEFAULT = 25 * 1024 * 1024;
const MESSAGE_MAX = 50 * 1024 * 1024;
const FETCH_MAX = 500;
const IDLE_UNUSED_MS = 30 * 60 * 1000;    // a session without IDLE and without commands this long is closed
const IDLE_RESTART_MS = 10 * 60 * 1000;   // IDLE is renewed this often (servers drop it after ~30 min)
const IDLE_RETRY_MS = 30 * 1000;          // after a failed IDLE
const SMTP_PARALLEL = 4;                  // sends and verifies per plugin at the same time (more wait)
const SMTP_VERIFY_SOCKET_MS = 60 * 1000;  // smtp.verify: the server's answers after connecting
const AUTOCONFIG_PER_HOUR = 120;
const SEARCH_KEYS = new Set(['all', 'seen', 'unseen', 'flagged', 'unflagged', 'answered', 'unanswered', 'deleted', 'undeleted', 'draft',
  'undraft', 'new', 'old', 'recent', 'from', 'to', 'cc', 'bcc', 'subject', 'body', 'text', 'since', 'before', 'on', 'sentSince',
  'sentBefore', 'sentOn', 'larger', 'smaller', 'header', 'or', 'not', 'uid', 'keyword', 'unKeyword', 'modseq', 'emailId', 'threadId', 'gmraw']);
const DATE_KEYS = new Set(['since', 'before', 'on', 'sentSince', 'sentBefore', 'sentOn']);
const FLAG_RE = /^\\?[A-Za-z0-9$_.\-[\]]{1,64}$/;
const RANGE_RE = /^(?:\d{1,10}|\*)(?::(?:\d{1,10}|\*))?(?:,(?:\d{1,10}|\*)(?::(?:\d{1,10}|\*))?)*$/;
const PART_RE = /^\d{1,4}(?:\.\d{1,4}){0,15}$/;

const plugins = new Map(); // plugin id → { sessions: Map<id, session>, connecting }
const smtpSlots = new Map(); // plugin id → { running, waiting: [resolve] }
const autoconfigWindow = new Map(); // plugin id → [timestamps]
let sweepTimer = null;

// test seams (NODE_ENV=test): stand-ins for DNS SRV/MX and the autoconfig HTTP requests
const seams = { resolver: null, fetchXml: null };

function permOf(plugin) {
  const p = plugin && plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.mail;
  return p && typeof p === 'object' ? p : null;
}

function needMail(plugin) {
  const p = permOf(plugin);
  need(p, 'ERR_MAIL_DENIED', 'this plugin has no mail permission');
  return p;
}

/** permissions.mail.dav (since 1.219.0): CalDAV/CardDAV through gc.mail.dav.request. */
function needDav(plugin) {
  const p = needMail(plugin);
  need(p.dav && typeof p.dav === 'object', 'ERR_MAIL_DENIED', 'this plugin has no mail.dav permission');
  return p;
}

function bucketOf(id) {
  let b = plugins.get(id);
  if (!b) { b = { sessions: new Map(), connecting: 0 }; plugins.set(id, b); }
  return b;
}

/** A BigInt / number of imapflow → number when safe, else its decimal string; null when missing. */
function num(v) {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ms(d) {
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.getTime();
  return null;
}

function mediaError(e) {
  const map = { quota_exceeded: 'ERR_MEDIA_QUOTA', too_large: 'ERR_MEDIA_TOO_LARGE', no_media: 'ERR_MEDIA_DENIED', empty: 'ERR_MEDIA_EMPTY' };
  const M = require('../media');
  if (e instanceof M.MediaError) return new MailError(map[e.code] || 'ERR_INVALID', e.code);
  return null;
}

function needMediaDecl(plugin) {
  need(require('../media').declOf(plugin), 'ERR_MEDIA_DENIED', 'plugin.json declares no media');
}

// ─── Arguments ──────────────────────────────────

function authOf(a) {
  need(a && typeof a === 'object' && !Array.isArray(a), 'ERR_INVALID', 'auth required');
  need(typeof a.user === 'string' && a.user.length >= 1 && a.user.length <= 320 && !/[\r\n\0]/.test(a.user), 'ERR_INVALID', 'invalid auth.user');
  const hasPass = a.pass != null;
  const hasToken = a.accessToken != null;
  need(hasPass !== hasToken, 'ERR_INVALID', 'auth needs pass or accessToken');
  if (hasPass) {
    need(typeof a.pass === 'string' && a.pass.length >= 1 && a.pass.length <= 1024 && !/[\r\n\0]/.test(a.pass), 'ERR_INVALID', 'invalid auth.pass');
    return { user: a.user, pass: a.pass };
  }
  need(typeof a.accessToken === 'string' && a.accessToken.length >= 1 && a.accessToken.length <= 16384 && !/[\s\0]/.test(a.accessToken), 'ERR_INVALID', 'invalid auth.accessToken');
  return { user: a.user, accessToken: a.accessToken };
}

function secretsOf(auth) { return [auth.pass, auth.accessToken, auth.user].filter(Boolean); }

function timeoutOf(v, def, max) {
  if (v == null) return def;
  need(Number.isFinite(v), 'ERR_INVALID', 'invalid timeoutMs');
  return Math.max(1000, Math.min(max, Math.round(v)));
}

/** A UID range: '1:*', '5,7,9' or [5, 7, 9]. */
function rangeOf(r) {
  if (Array.isArray(r)) {
    need(r.length >= 1 && r.length <= 10000 && r.every((x) => Number.isSafeInteger(x) && x >= 1 && x <= 4294967295), 'ERR_INVALID', 'invalid range');
    return r.join(',');
  }
  if (Number.isSafeInteger(r) && r >= 1) return String(r);
  need(typeof r === 'string' && r.length <= 8192 && RANGE_RE.test(r), 'ERR_INVALID', 'invalid range');
  return r;
}

function pathOf(p) {
  need(typeof p === 'string' && p.length >= 1 && p.length <= 1000 && !/[\r\n\0]/.test(p), 'ERR_INVALID', 'invalid mailbox path');
  return p;
}

function uidOf(u) {
  need(Number.isSafeInteger(u) && u >= 1 && u <= 4294967295, 'ERR_INVALID', 'invalid uid');
  return u;
}

function flagsOf(list, what) {
  if (list == null) return [];
  need(Array.isArray(list) && list.length <= 32 && list.every((f) => typeof f === 'string' && FLAG_RE.test(f)), 'ERR_INVALID', `invalid ${what}`);
  return list;
}

function maxBytesOf(v, def, max) {
  if (v == null) return def;
  need(Number.isSafeInteger(v) && v >= 1, 'ERR_INVALID', 'invalid maxBytes');
  return Math.min(v, max);
}

function dateOf(v, key) {
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
  need(!Number.isNaN(d.getTime()), 'ERR_INVALID', `invalid search date ${key}`);
  return d;
}

/** imapflow's search query (checked, ≤ 16 KB, ≤ 6 levels deep). */
function searchOf(q, depth = 0) {
  need(depth <= 6, 'ERR_INVALID', 'search query too deep');
  need(q && typeof q === 'object' && !Array.isArray(q), 'ERR_INVALID', 'invalid search query');
  if (depth === 0) {
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(q)); } catch { size = Infinity; }
    need(size <= 16384, 'ERR_INVALID', 'search query too large');
  }
  const out = {};
  for (const [k, v] of Object.entries(q)) {
    need(SEARCH_KEYS.has(k), 'ERR_INVALID', `unknown search key ${String(k).slice(0, 40)}`);
    if (k === 'or') {
      need(Array.isArray(v) && v.length >= 2 && v.length <= 32, 'ERR_INVALID', 'invalid search or');
      out.or = v.map((x) => searchOf(x, depth + 1));
    } else if (k === 'not') out.not = searchOf(v, depth + 1);
    else if (k === 'header') {
      need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 8, 'ERR_INVALID', 'invalid search header');
      out.header = {};
      for (const [hk, hv] of Object.entries(v)) {
        need(/^[A-Za-z0-9-]{1,64}$/.test(hk) && (typeof hv === 'string' || hv === true), 'ERR_INVALID', 'invalid search header');
        out.header[hk] = hv;
      }
    } else if (DATE_KEYS.has(k)) out[k] = dateOf(v, k);
    else if (k === 'uid') out.uid = rangeOf(v);
    else if (k === 'modseq') {
      need((Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,20}$/.test(v)), 'ERR_INVALID', 'invalid search modseq');
      out.modseq = BigInt(v);
    } else {
      need(typeof v === 'boolean' || (typeof v === 'string' && v.length <= 1000) || (Number.isSafeInteger(v) && v >= 0), 'ERR_INVALID', `invalid search ${k}`);
      out[k] = v;
    }
  }
  return out;
}

// ─── Converting imapflow's answers ──────────────

function decodeWords(s) {
  return String(s).replace(/=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]*)\?=(?:\s+(?==\?))?/g, (m, cs, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(cs.split('*')[0].toLowerCase(), { fatal: false }).decode(bytes);
    } catch { return m; }
  });
}

/** Raw header lines (a Buffer of imapflow) → { name: value } (lower-case names, the first of each, unfolded and decoded). */
function headersOf(buf) {
  const out = {};
  if (!buf) return out;
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(name) || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = decodeWords(line.slice(i + 1).trim()).slice(0, 4000);
  }
  return out;
}

function addrList(list) {
  return (Array.isArray(list) ? list : []).map((a) => ({ name: String((a && a.name) || ''), address: String((a && a.address) || '') }));
}

function envelopeOf(e) {
  if (!e) return null;
  return {
    date: ms(e.date), subject: e.subject == null ? '' : String(e.subject),
    from: addrList(e.from), sender: addrList(e.sender), replyTo: addrList(e.replyTo),
    to: addrList(e.to), cc: addrList(e.cc), bcc: addrList(e.bcc),
    inReplyTo: e.inReplyTo || null, messageId: e.messageId || null,
  };
}

/** JSON-safe copy of a body structure (no BigInt, dates as ms). */
function plain(v, depth = 0) {
  if (depth > 40) return null;
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return num(v);
  if (v instanceof Date) return ms(v);
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x, depth + 1)]));
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = plain(x, depth + 1);
    return o;
  }
  return v;
}

function fetchEntry(msg, q) {
  const out = { uid: msg.uid };
  if (q.flags) out.flags = msg.flags ? [...msg.flags] : [];
  if (q.size) out.size = Number(msg.size) || 0;
  if (q.internalDate) out.internalDate = ms(msg.internalDate);
  if (q.envelope) out.envelope = envelopeOf(msg.envelope);
  if (q.headers) out.headers = headersOf(msg.headers);
  if (q.bodyStructure) out.bodyStructure = plain(msg.bodyStructure);
  if (msg.modseq !== undefined) out.modseq = num(msg.modseq);
  return out;
}

// ─── Sessions ───────────────────────────────────

function sweep() {
  const now = Date.now();
  for (const b of plugins.values()) {
    for (const s of b.sessions.values()) {
      const idleOk = s.wantIdle && s.client.mailbox;
      if (!idleOk && s.pending === 0 && now - s.lastUsed > IDLE_UNUSED_MS) closeSession(s, true);
    }
  }
  if (![...plugins.values()].some((b) => b.sessions.size)) { clearInterval(sweepTimer); sweepTimer = null; }
}

function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, 60000);
  sweepTimer.unref();
}

function emit(s, ev, data) {
  if (s.muted) return;
  try { s.ctx.emit({ t: 'mail', id: s.id, ev, data: data === undefined ? null : data }); } catch { /* process gone */ }
}

function closeSession(s, notify) {
  if (s.closed) return;
  s.closed = true;
  s.wantIdle = false;
  const b = plugins.get(s.pluginId);
  if (b) b.sessions.delete(s.id);
  if (!notify) s.muted = true;
  const client = s.client;
  const t = setTimeout(() => { try { client.close(); } catch { /* closed */ } }, 3000);
  t.unref();
  Promise.resolve().then(() => client.logout()).catch(() => null).finally(() => { clearTimeout(t); try { client.close(); } catch { /* closed */ } });
  if (notify) emit(s, 'close', null);
  s.muted = true;
}

/** End every session of a plugin (its process ended, it was stopped or uninstalled). */
function closeAll(pluginId) {
  const b = plugins.get(pluginId);
  plugins.delete(pluginId);
  if (b) for (const s of b.sessions.values()) closeSession(s, false);
  smtpSlots.delete(pluginId);
  require('./dav').closeAll(pluginId);
}

function maybeIdle(s) {
  if (s.closed || !s.wantIdle || s.pending > 0 || s.idling || !s.client.mailbox || !s.client.usable) return;
  if (s.idleRetryAt && Date.now() < s.idleRetryAt) return;
  s.idling = true;
  s.client.idle().then((r) => {
    s.idleRetryAt = r === false ? Date.now() + IDLE_RETRY_MS : 0;
  }, () => { s.idleRetryAt = Date.now() + IDLE_RETRY_MS; }).finally(() => {
    s.idling = false;
    if (s.closed || !s.wantIdle) return;
    const wait = s.idleRetryAt ? IDLE_RETRY_MS : 0;
    setTimeout(() => maybeIdle(s), wait).unref();
  });
}

/** One command of a session, after the ones before it; IDLE starts again afterwards. */
function run(s, fn) {
  need(!s.closed, 'ERR_MAIL_NET', 'the session is closed');
  s.pending++;
  s.lastUsed = Date.now();
  const p = s.queue.then(() => {
    need(!s.closed && s.client.usable, 'ERR_MAIL_NET', 'the session is closed');
    return fn();
  }).catch((e) => { throw mediaError(e) || (e instanceof MailError ? e : net.mapError(e, s.secrets)); })
    .finally(() => { s.pending--; s.lastUsed = Date.now(); maybeIdle(s); });
  s.queue = p.catch(() => null);
  return p;
}

function sessionOf(plugin, args) {
  const b = plugins.get(plugin.id);
  const s = b && b.sessions.get(String(args && args.id));
  need(s, 'ERR_INVALID', 'unknown mail session');
  return s;
}

/**
 * gc.mail.imap.connect({ host, port, security, auth: { user, pass } | { user, accessToken }, timeoutMs })
 * → { id, capabilities, serverInfo }
 */
async function imapConnect(plugin, args, ctx, opts = {}) {
  const perm = needMail(plugin);
  need(ctx && typeof ctx.emit === 'function', 'ERR_INVALID', 'no event channel');
  const a = args && typeof args === 'object' ? args : {};
  const auth = authOf(a.auth);
  const timeoutMs = timeoutOf(a.timeoutMs, CONNECT_TIMEOUT_DEFAULT_MS, CONNECT_TIMEOUT_MAX_MS);
  const b = bucketOf(plugin.id);
  const max = perm.maxConnections || 50;
  need(b.sessions.size + b.connecting < max, 'ERR_MAIL_LIMIT', `at most ${max} open IMAP sessions`);
  b.connecting++;
  let client = null;
  try {
    const ep = await net.endpoint('imap', a, opts);
    const { ImapFlow } = require('imapflow');
    client = new ImapFlow({
      host: ep.address,
      port: ep.connectPort,
      secure: ep.security === 'tls',
      ...(ep.security === 'starttls' ? { doSTARTTLS: true } : {}),
      ...(require('../netPolicy').isIpLiteral(ep.host) ? {} : { servername: ep.host }),
      tls: net.tlsOptions(ep.host),
      auth: auth.pass != null ? { user: auth.user, pass: auth.pass } : { user: auth.user, accessToken: auth.accessToken },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      maxIdleTime: IDLE_RESTART_MS,
      connectionTimeout: timeoutMs,
      greetingTimeout: Math.min(timeoutMs, 16000),
      clientInfo: { name: 'GateControl' },
    });
    client.on('error', () => { /* reported through the command or the close event */ });
    await client.connect();
  } catch (e) {
    if (client) { try { client.close(); } catch { /* closed */ } }
    throw e instanceof MailError ? e : net.mapError(e, secretsOf(auth));
  } finally { b.connecting--; }
  // the plugin stopped while connecting (closeAll dropped its bucket) → nobody to deliver to
  if (plugins.get(plugin.id) !== b) { try { client.close(); } catch { /* closed */ } fail('ERR_MAIL_NET', 'plugin stopped'); }
  const s = {
    id: crypto.randomBytes(12).toString('hex'), pluginId: plugin.id, client, ctx, secrets: secretsOf(auth),
    queue: Promise.resolve(), pending: 0, lastUsed: Date.now(), wantIdle: false, idling: false, idleRetryAt: 0, closed: false, muted: false,
  };
  b.sessions.set(s.id, s);
  ensureSweep();
  client.on('exists', (d) => emit(s, 'exists', { path: d.path, count: Number(d.count) || 0, prevCount: Number(d.prevCount) || 0 }));
  client.on('expunge', (d) => emit(s, 'expunge', { path: d.path, seq: d.seq == null ? null : Number(d.seq), uid: d.uid == null ? null : Number(d.uid), vanished: !!d.vanished }));
  client.on('flags', (d) => emit(s, 'flags', { path: d.path, seq: d.seq == null ? null : Number(d.seq), uid: d.uid == null ? null : Number(d.uid), modseq: num(d.modseq), flags: d.flags ? [...d.flags] : [] }));
  client.on('error', (e) => emit(s, 'error', { code: net.mapError(e, s.secrets).code, message: net.serverText((e && e.message) || 'error', s.secrets) }));
  client.on('close', () => { if (!s.closed) closeSession(s, true); });
  const si = client.serverInfo;
  return {
    id: s.id,
    capabilities: client.capabilities ? [...client.capabilities.keys()].map(String) : [],
    serverInfo: si && (si.name || si.vendor) ? { name: si.name ? String(si.name) : null, vendor: si.vendor ? String(si.vendor) : null } : null,
  };
}

function needOpen(s) {
  need(s.client.mailbox, 'ERR_INVALID', 'no mailbox open (s.open first)');
}

const IMAP_OPS = {
  async list(plugin, s) {
    const list = await s.client.list();
    return (list || []).map((x) => ({
      path: x.path, name: x.name, delimiter: x.delimiter || null, parent: x.parentPath || null,
      specialUse: x.specialUse || null, flags: x.flags ? [...x.flags] : [], subscribed: !!x.subscribed,
    }));
  },
  async status(plugin, s, [path, query]) {
    const q = query && typeof query === 'object' ? query : { messages: true, unseen: true, uidNext: true, uidValidity: true };
    const ask = {};
    for (const k of ['messages', 'unseen', 'uidNext', 'uidValidity', 'highestModseq', 'recent']) if (q[k]) ask[k] = true;
    const r = await s.client.status(pathOf(path), ask);
    const out = { path: r.path };
    for (const k of Object.keys(ask)) out[k] = num(r[k]);
    return out;
  },
  async open(plugin, s, [path, o]) {
    const readOnly = !!(o && o.readOnly);
    const r = await s.client.mailboxOpen(pathOf(path), { readOnly });
    return { path: r.path, uidValidity: num(r.uidValidity), uidNext: num(r.uidNext), exists: num(r.exists) || 0, highestModseq: num(r.highestModseq) };
  },
  async fetch(plugin, s, [range, o]) {
    needOpen(s);
    const r = rangeOf(range);
    const q = o && typeof o === 'object' ? o : {};
    const query = { uid: true };
    for (const k of ['envelope', 'flags', 'size', 'internalDate', 'bodyStructure']) if (q[k]) query[k] = true;
    if (q.headers === true) query.headers = true;
    else if (Array.isArray(q.headers)) {
      need(q.headers.length <= 32 && q.headers.every((h) => typeof h === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(h)), 'ERR_INVALID', 'invalid headers');
      if (q.headers.length) query.headers = q.headers.map((h) => h.toLowerCase());
    } else need(q.headers == null || q.headers === false, 'ERR_INVALID', 'invalid headers');
    let changedSince = null;
    if (q.changedSince != null) {
      need((Number.isSafeInteger(q.changedSince) && q.changedSince >= 0) || (typeof q.changedSince === 'string' && /^\d{1,20}$/.test(q.changedSince)), 'ERR_INVALID', 'invalid changedSince');
      changedSince = BigInt(q.changedSince);
    }
    // more than FETCH_MAX messages → ERR_INVALID, before anything is fetched
    const uids = await s.client.search(changedSince !== null ? { uid: r, modseq: changedSince + 1n } : { uid: r }, { uid: true });
    const list = Array.isArray(uids) ? uids : [];
    need(list.length <= FETCH_MAX, 'ERR_INVALID', `more than ${FETCH_MAX} messages in the range`);
    if (!list.length) return [];
    const out = [];
    for await (const msg of s.client.fetch(list.join(','), query, { uid: true, ...(changedSince !== null ? { changedSince } : {}) })) {
      out.push(fetchEntry(msg, q));
    }
    return out.sort((x, y) => x.uid - y.uid);
  },
  async message(plugin, s, [uid, o]) {
    needOpen(s);
    const u = uidOf(uid);
    const opt = o && typeof o === 'object' ? o : {};
    const mode = opt.attachments == null ? 'meta' : opt.attachments;
    need(mode === 'meta' || mode === 'media', 'ERR_INVALID', "attachments must be 'meta' or 'media'");
    if (mode === 'media') needMediaDecl(plugin);
    const maxBytes = maxBytesOf(opt.maxBytes, MESSAGE_MAX_DEFAULT, MESSAGE_MAX);
    const meta = await s.client.fetchOne(String(u), { size: true }, { uid: true });
    need(meta && meta.uid, 'ERR_INVALID', 'unknown message');
    need((Number(meta.size) || 0) <= maxBytes, 'ERR_MAIL_LIMIT', `the message is larger than maxBytes (${maxBytes})`);
    const dl = await s.client.download(String(u), undefined, { uid: true, maxBytes });
    need(dl && dl.content, 'ERR_INVALID', 'unknown message');
    return mime.parse(dl.content, { plugin, mode, maxAttachment: maxBytes });
  },
  async download(plugin, s, [uid, partId, o]) {
    needOpen(s);
    needMediaDecl(plugin);
    const u = uidOf(uid);
    need(typeof partId === 'string' && PART_RE.test(partId), 'ERR_INVALID', 'invalid partId');
    const opt = o && typeof o === 'object' ? o : {};
    const maxBytes = maxBytesOf(opt.maxBytes, MESSAGE_MAX_DEFAULT, MESSAGE_MAX);
    need(opt.name == null || (typeof opt.name === 'string' && opt.name.length <= 255), 'ERR_INVALID', 'invalid name');
    const dl = await s.client.download(String(u), partId, { uid: true, maxBytes });
    need(dl && dl.content, 'ERR_INVALID', 'unknown message or part');
    const m = dl.meta || {};
    const r = await require('../media').storeHostStream(plugin, dl.content, { mime: m.contentType || 'application/octet-stream', name: opt.name || m.filename || null, max: maxBytes });
    return { mediaId: r.mediaId, bytes: r.bytes, mime: r.mime, name: r.name };
  },
  async search(plugin, s, [query]) {
    needOpen(s);
    const r = await s.client.search(searchOf(query), { uid: true });
    return Array.isArray(r) ? r : [];
  },
  async flags(plugin, s, [range, o]) {
    needOpen(s);
    const r = rangeOf(range);
    const add = flagsOf(o && o.add, 'flags.add');
    const remove = flagsOf(o && o.remove, 'flags.remove');
    need(add.length || remove.length, 'ERR_INVALID', 'flags needs add or remove');
    if (add.length) await s.client.messageFlagsAdd(r, add, { uid: true });
    if (remove.length) await s.client.messageFlagsRemove(r, remove, { uid: true });
    return true;
  },
  async move(plugin, s, [range, path]) {
    needOpen(s);
    const r = await s.client.messageMove(rangeOf(range), pathOf(path), { uid: true });
    return { uidMap: r && r.uidMap ? Object.fromEntries([...r.uidMap].map(([k, v]) => [String(k), Number(v)])) : null };
  },
  async copy(plugin, s, [range, path]) {
    needOpen(s);
    const r = await s.client.messageCopy(rangeOf(range), pathOf(path), { uid: true });
    return { uidMap: r && r.uidMap ? Object.fromEntries([...r.uidMap].map(([k, v]) => [String(k), Number(v)])) : null };
  },
  async expunge(plugin, s, [range]) {
    needOpen(s);
    return !!(await s.client.messageDelete(rangeOf(range), { uid: true }));
  },
  async append(plugin, s, [path, mediaId, o]) {
    const p = pathOf(path);
    const row = mime.ownMedia(plugin, mediaId);
    need(row.bytes <= MESSAGE_MAX, 'ERR_MAIL_LIMIT', 'the message is larger than 50 MB');
    const opt = o && typeof o === 'object' ? o : {};
    const flags = flagsOf(opt.flags, 'flags');
    const date = opt.date == null ? undefined : dateOf(opt.date, 'date');
    const parts = [];
    for await (const part of mime.mediaReadable(row)) parts.push(part);
    const r = await s.client.append(p, Buffer.concat(parts), flags, date);
    return { uid: r && r.uid ? Number(r.uid) : null };
  },
  async noop(plugin, s) { await s.client.noop(); return true; },
};

/** gc.mail session commands: { id, op, args: [...] } */
async function imapCall(plugin, args) {
  needMail(plugin);
  const s = sessionOf(plugin, args);
  const op = String(args.op || '');
  const list = Array.isArray(args.args) ? args.args : [];
  if (op === 'idle') {
    s.wantIdle = true;
    s.lastUsed = Date.now();
    maybeIdle(s);
    return true;
  }
  need(Object.prototype.hasOwnProperty.call(IMAP_OPS, op), 'ERR_INVALID', 'unknown mail session command');
  return run(s, () => IMAP_OPS[op](plugin, s, list));
}

function imapClose(plugin, args) {
  needMail(plugin);
  const b = plugins.get(plugin.id);
  const s = b && b.sessions.get(String(args && args.id));
  if (s) closeSession(s, false);
  return null;
}

// ─── SMTP, compose, parse ───────────────────────

async function smtpSlot(pluginId) {
  let st = smtpSlots.get(pluginId);
  if (!st) { st = { running: 0, waiting: [] }; smtpSlots.set(pluginId, st); }
  if (st.running >= SMTP_PARALLEL) await new Promise((resolve) => st.waiting.push(resolve));
  st.running++;
  return () => { st.running--; const next = st.waiting.shift(); if (next) next(); };
}

/** A nodemailer transport to the checked SMTP server: TLS verified, STARTTLS required on 587, no files or URLs. */
function smtpTransport(ep, auth, timeoutMs, socketTimeoutMs) {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: ep.address,
    port: ep.connectPort,
    secure: ep.security === 'tls',
    requireTLS: ep.security === 'starttls',
    ...(require('../netPolicy').isIpLiteral(ep.host) ? {} : { servername: ep.host }),
    tls: net.tlsOptions(ep.host),
    auth: auth.pass != null ? { user: auth.user, pass: auth.pass } : { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken },
    connectionTimeout: timeoutMs,
    greetingTimeout: Math.min(timeoutMs, 30000),
    socketTimeout: socketTimeoutMs,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/**
 * gc.mail.smtp.send({ host, port, security, auth, message, appendCopy, timeoutMs })
 * → { messageId, accepted, rejected, raw: { mediaId, bytes } | null }
 */
async function smtpSend(plugin, args, opts = {}) {
  needMail(plugin);
  const a = args && typeof args === 'object' ? args : {};
  const auth = authOf(a.auth);
  need(a.appendCopy == null || typeof a.appendCopy === 'boolean', 'ERR_INVALID', 'invalid appendCopy');
  if (a.appendCopy) needMediaDecl(plugin);
  const timeoutMs = timeoutOf(a.timeoutMs, CONNECT_TIMEOUT_DEFAULT_MS, CONNECT_TIMEOUT_MAX_MS);
  const ep = await net.endpoint('smtp', a, opts);
  const { raw, messageId, envelope } = await mime.compose(plugin, a.message);
  need(envelope.to.length, 'ERR_INVALID', 'the message has no recipient');
  const release = await smtpSlot(plugin.id);
  const transport = smtpTransport(ep, auth, timeoutMs, 5 * 60 * 1000);
  let info;
  try {
    info = await transport.sendMail({ envelope, raw });
  } catch (e) {
    throw net.mapError(e, secretsOf(auth));
  } finally {
    try { transport.close(); } catch { /* closed */ }
    release();
  }
  const accepted = (info.accepted || []).map(String);
  const rejected = (info.rejected || []).map(String);
  if (!accepted.length) fail('ERR_MAIL_REJECTED', 'the server refused every recipient', { serverText: net.serverText(info.response, secretsOf(auth)) });
  let copy = null;
  if (a.appendCopy) {
    try {
      const r = await require('../media').storeHostStream(plugin, [raw], { mime: 'message/rfc822', name: 'message.eml' });
      copy = { mediaId: r.mediaId, bytes: r.bytes };
    } catch (e) { throw mediaError(e) || e; }
  }
  return { messageId, accepted, rejected, raw: copy };
}

/**
 * gc.mail.smtp.verify({ host, port, security, auth, timeoutMs }) → { ok: true } (since 1.217.0):
 * connect, (STARTTLS,) log in and QUIT without sending — the same checks, errors and parallel
 * limit as smtp.send, e.g. before an account is saved.
 */
async function smtpVerify(plugin, args, opts = {}) {
  needMail(plugin);
  const a = args && typeof args === 'object' ? args : {};
  const auth = authOf(a.auth);
  const timeoutMs = timeoutOf(a.timeoutMs, CONNECT_TIMEOUT_DEFAULT_MS, CONNECT_TIMEOUT_MAX_MS);
  const ep = await net.endpoint('smtp', a, opts);
  const release = await smtpSlot(plugin.id);
  const transport = smtpTransport(ep, auth, timeoutMs, SMTP_VERIFY_SOCKET_MS);
  try {
    await transport.verify();
  } catch (e) {
    throw net.mapError(e, secretsOf(auth));
  } finally {
    try { transport.close(); } catch { /* closed */ }
    release();
  }
  return { ok: true };
}

/** gc.mail.compose(message) → { mediaId, bytes, messageId } — RFC 822 as an unclaimed media file. */
async function compose(plugin, args) {
  needMail(plugin);
  needMediaDecl(plugin);
  const { raw, messageId } = await mime.compose(plugin, args && args.message);
  try {
    const r = await require('../media').storeHostStream(plugin, [raw], { mime: 'message/rfc822', name: 'message.eml' });
    return { mediaId: r.mediaId, bytes: r.bytes, messageId };
  } catch (e) { throw mediaError(e) || e; }
}

/** gc.mail.parse(mediaId, { attachments, maxBytes }) → like s.message */
async function parse(plugin, args) {
  needMail(plugin);
  needMediaDecl(plugin);
  const row = mime.ownMedia(plugin, args && args.mediaId);
  const o = args && args.opts && typeof args.opts === 'object' ? args.opts : {};
  const mode = o.attachments == null ? 'meta' : o.attachments;
  need(mode === 'meta' || mode === 'media', 'ERR_INVALID', "attachments must be 'meta' or 'media'");
  const maxBytes = maxBytesOf(o.maxBytes, MESSAGE_MAX_DEFAULT, MESSAGE_MAX);
  need(row.bytes <= maxBytes, 'ERR_MAIL_LIMIT', `the message is larger than maxBytes (${maxBytes})`);
  try {
    return await mime.parse(mime.mediaReadable(row), { plugin, mode, maxAttachment: maxBytes });
  } catch (e) { throw mediaError(e) || (e instanceof MailError ? e : new MailError('ERR_INVALID', 'the message could not be read')); }
}

function sanitizeCall(plugin, args) {
  needMail(plugin);
  const html = args && args.html;
  need(html == null || typeof html === 'string', 'ERR_INVALID', 'invalid html');
  try { return require('./sanitize').sanitize(html || '', args && args.opts); } catch (e) {
    if (e && e.code === 'ERR_INVALID') throw new MailError('ERR_INVALID', e.message);
    throw e;
  }
}

async function autoconfigCall(plugin, args, opts = {}) {
  needMail(plugin);
  const now = Date.now();
  const w = (autoconfigWindow.get(plugin.id) || []).filter((t) => now - t < 3600000);
  need(w.length < AUTOCONFIG_PER_HOUR, 'ERR_RATE_LIMIT', `too many lookups (${AUTOCONFIG_PER_HOUR} per hour)`);
  w.push(now);
  autoconfigWindow.set(plugin.id, w);
  return require('./autoconfig').autoconfig(args && args.email, { lookup: opts.lookup, reserved: opts.reserved, resolver: seams.resolver, fetchXml: seams.fetchXml });
}

/**
 * gc.mail.dav.request({ url, method, headers, body, auth, timeoutMs, maxBytes, parse }) (since 1.219.0)
 * → { status, url, headers, body, multistatus } — dav.js
 */
async function davRequest(plugin, args, opts = {}) {
  needDav(plugin);
  return require('./dav').request(plugin, args, { lookup: opts.lookup, reserved: opts.reserved });
}

/** How long the host waits for one gc.mail call (hostApi.callTimeout). */
function callTimeout(api, args) {
  const t = args && Number.isFinite(args.timeoutMs) ? Math.min(CONNECT_TIMEOUT_MAX_MS, args.timeoutMs) : CONNECT_TIMEOUT_DEFAULT_MS;
  if (api === 'mail.imap.connect') return t + 10000;
  if (api === 'mail.smtp.send') return 10 * 60 * 1000;
  // connect (≤ timeoutMs), greeting, STARTTLS, AUTH, QUIT (≤ 60 s each) — and maybe a wait for a free SMTP slot
  if (api === 'mail.smtp.verify') return t + 3 * 60 * 1000;
  if (api === 'mail.imap.call') return ['message', 'download', 'append', 'fetch', 'search', 'move', 'copy', 'expunge'].includes(args && args.op) ? 10 * 60 * 1000 : 2 * 60 * 1000;
  if (api === 'mail.autoconfig') return 40000;
  if (api === 'mail.dav.request') return require('./dav').callTimeout(args);
  return 2 * 60 * 1000;
}

function stats(pluginId) {
  const b = plugins.get(pluginId);
  return { sessions: b ? b.sessions.size : 0, connecting: b ? b.connecting : 0 };
}

function _setSeams(o) {
  if (process.env.NODE_ENV !== 'test') return;
  seams.resolver = (o && o.resolver) || null;
  seams.fetchXml = (o && o.fetchXml) || null;
  net._setTestSeams(o && o.net);
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  for (const id of [...plugins.keys()]) closeAll(id);
  autoconfigWindow.clear();
  smtpSlots.clear();
  require('./dav')._resetForTest();
}

module.exports = {
  imapConnect, imapCall, imapClose, smtpSend, smtpVerify, compose, parse, sanitize: sanitizeCall, autoconfig: autoconfigCall, davRequest, closeAll, callTimeout, stats,
  permOf, MailError, FETCH_MAX, MESSAGE_MAX, IDLE_UNUSED_MS, _setSeams, _resetForTest, _sweep: sweep,
};
