'use strict';

// Logs & Monitoring (FEATURES.md "Logs & Monitoring"): every log source of
// the host as one stream of entries.
//
//   server    the host's own log file (utils/serverLogFile.js)   admins only
//   plugins   plugin_logs (gc.log of every plugin)                admins only
//   activity  activity_log                                         `logs` right
//   access    Caddy's access.log (services/accessLog.js)          `logs` right
//   sessions  rdp_sessions (remote desktop sessions)               `logs` right
//
// One entry: { id, source, ts, time, level, msg, ctx, plugin, pluginName,
// code, fields, raw }. level is one of error, warn, info, debug. Ids say
// where an entry lives ("s.<ts>.<hash>", "p.<rowid>", "a.<id>",
// "h.<ts>.<hash>", "r.<id>"), so a link to an entry stays valid.
//
// Sources are read newest first (or oldest first for exports) in small
// batches / file chunks, merged by time, and filtered here: no source ever
// loads everything at once, and the main thread gets a turn between batches.

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const serverLog = require('./serverLog');
const accessLog = require('./accessLog');
const { QueryError, list, parseTime, shortString } = require('../utils/logQuery');

const SOURCES = ['server', 'plugins', 'activity', 'access', 'sessions'];
const ADMIN_SOURCES = new Set(['server', 'plugins']);
const LEVELS = ['error', 'warn', 'info', 'debug'];
const ACTIVITY_LEVEL = { error: 'error', warning: 'warn', success: 'info', info: 'info' };
const BATCH = 500;
const MAX_LIMIT = 500;
const MAX_IDS = 300;

// ─── Known error codes ───────────────────────────────────────────────────────
// Recognised in message and fields: the problem key (logProblems.js) and the
// "Was bedeutet das?" text of the entry (i18n lg.code.<code>.*). Order
// matters — the first match wins.
const CODES = [
  { code: 'storage_worker_restarted', re: /plugin storage timed out/i },
  { code: 'storage_timeout', re: /storage time(?:d)?[ -]?out/i },
  { code: 'event_loop_blocked', re: /event loop was blocked/i },
  { code: 'plugin_start_timeout', re: /did not start in time/i },
  { code: 'no_right', re: /\bno_right\b/i },
  { code: 'lock_unreachable', re: /\block_unreachable\b/i },
  { code: 'login_failed', re: /^(?:failed login|failed second-factor)/i },
];
const ERR_CODE_RE = /\b(ERR_[A-Z0-9_]{2,40}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EACCES|ENOSPC|EPIPE|EADDRINUSE)\b/;
const KNOWN_CODES = new Set(CODES.map((c) => c.code));

function codeOf(text, fields) {
  for (const c of CODES) if (c.re.test(text)) return c.code;
  const f = fields || {};
  const candidates = [f.code, f.err && f.err.code, f.error && f.error.code];
  for (const v of candidates) if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{2,48}$/.test(v)) return v;
  const m = ERR_CODE_RE.exec(text);
  return m ? m[1] : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function iso(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

/** A few primitive fields as "key value · key value" (list context line). */
function ctxOf(fields, skip = []) {
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (skip.includes(k) || v == null || typeof v === 'object') continue;
    const s = String(v);
    if (!s || s.length > 80) continue;
    parts.push(`${k} ${s}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

function sqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
function fromSqlTime(v) {
  const s = String(v || '');
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isFinite(ms) ? ms : 0;
}

let pluginNameCache = { at: 0, map: new Map() };
/** plugin id → { name, version } (installed plugins, 30 s cache). */
function pluginNames() {
  if (Date.now() - pluginNameCache.at < 30000) return pluginNameCache.map;
  const map = new Map();
  try {
    for (const p of require('./plugins/registry').list()) {
      const n = p.manifest && p.manifest.name;
      const name = typeof n === 'string' ? n : (n && (n.de || n.en)) || p.name || p.id;
      map.set(p.id, { name, nameEn: (n && typeof n === 'object' && n.en) || name, version: p.version || null });
    }
  } catch { /* no plugin tables (tests without migrations) */ }
  pluginNameCache = { at: Date.now(), map };
  return map;
}
function resetCaches() { pluginNameCache = { at: 0, map: new Map() }; }

// ─── Entries per source ──────────────────────────────────────────────────────

function fromServer(obj, text) {
  const n = Number(obj.level) || 30;
  const ts = Number(obj.time) || 0;
  const fields = {};
  for (const k of Object.keys(obj)) if (!serverLog.BASE_KEYS.has(k)) fields[k] = obj[k];
  const msg = obj.msg == null ? '' : String(obj.msg);
  const plugin = typeof fields.plugin === 'string' ? fields.plugin : (typeof fields.pluginId === 'string' ? fields.pluginId : null);
  const p = plugin ? pluginNames().get(plugin) : null;
  return {
    id: `s.${ts}.${hash(text)}`,
    source: 'server',
    ts,
    time: iso(ts),
    level: serverLog.levelGroup(n),
    levelName: serverLog.levelName(n),
    msg,
    ctx: ctxOf(fields),
    plugin,
    pluginName: p ? p.name : null,
    code: codeOf(msg, fields),
    fields,
    raw: obj,
  };
}

function fromPlugin(row) {
  const p = pluginNames().get(row.plugin_id);
  const level = LEVELS.includes(row.level) ? row.level : 'info';
  const msg = String(row.message || '');
  return {
    id: `p.${row.id}`,
    source: 'plugins',
    ts: row.created_at,
    time: iso(row.created_at),
    level,
    levelName: level,
    msg,
    ctx: p && p.version ? `${p.name} ${p.version}` : (p ? p.name : row.plugin_id),
    plugin: row.plugin_id,
    pluginName: p ? p.name : row.plugin_id,
    code: codeOf(msg, null),
    fields: { plugin: row.plugin_id, version: p ? p.version : null },
    raw: { id: row.id, plugin: row.plugin_id, level: row.level, message: row.message, created_at: row.created_at },
  };
}

function fromActivity(row) {
  let details = null;
  if (row.details) { try { details = JSON.parse(row.details); } catch { details = null; } }
  const ts = fromSqlTime(row.created_at);
  const fields = { event: row.event_type, source: row.source || null, ip: row.ip_address || null, severity: row.severity };
  if (details && typeof details === 'object') fields.details = details;
  const msg = String(row.message || '');
  return {
    id: `a.${row.id}`,
    source: 'activity',
    ts,
    time: iso(ts),
    level: ACTIVITY_LEVEL[row.severity] || 'info',
    levelName: row.severity || 'info',
    msg,
    ctx: [row.event_type, row.source, row.ip_address].filter(Boolean).join(' · '),
    plugin: details && typeof details.plugin === 'string' ? details.plugin : null,
    pluginName: null,
    code: codeOf(msg, null) || row.event_type,
    fields,
    raw: { ...row, details },
  };
}

function accessLevel(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

function fromAccess(e) {
  const fields = {
    status: e.status, method: e.method, host: e.host, uri: e.uri, ip: e.remote_ip,
    duration_ms: e.duration, size: e.size, proto: e.proto, user_agent: e.user_agent,
  };
  return {
    id: `h.${e.ts}.${e.hash}`,
    source: 'access',
    ts: e.ts,
    time: iso(e.ts),
    level: accessLevel(e.status),
    levelName: String(e.status),
    msg: `${e.method} ${e.host}${e.uri} → ${e.status}`,
    ctx: [e.remote_ip, `${e.duration} ms`, e.user_agent].filter(Boolean).join(' · '),
    plugin: null,
    pluginName: null,
    code: e.status >= 500 ? `http_${e.status}` : null,
    fields,
    raw: fields,
  };
}

function fromSession(row) {
  const ts = fromSqlTime(row.started_at);
  const warn = row.end_reason === 'timeout' || row.end_reason === 'reclaimed';
  const fields = {
    route: row.route_name || null, status: row.status, end_reason: row.end_reason || null,
    duration_s: row.duration_seconds, peer: row.peer_name || null, user: row.user_display_name || row.token_name || null,
    ip: row.client_ip || null, ended_at: row.ended_at || null,
  };
  return {
    id: `r.${row.id}`,
    source: 'sessions',
    ts,
    time: iso(ts),
    level: warn ? 'warn' : 'info',
    levelName: warn ? 'warn' : 'info',
    msg: `${row.route_name || 'RDP'}: ${row.status}${row.end_reason ? ` (${row.end_reason})` : ''}`,
    ctx: [fields.user, fields.peer, row.duration_seconds != null ? `${row.duration_seconds} s` : null, row.client_ip].filter(Boolean).join(' · '),
    plugin: null,
    pluginName: null,
    code: null,
    fields,
    raw: row,
  };
}

// ─── Iterators (desc = newest first, asc = oldest first) ─────────────────────
// Range: from/to inclusive (epoch ms, null = open). Each yields entries.

async function* iterServer({ from, to, desc }) {
  const files = await serverLog.listFiles();
  const handles = await serverLog.openAll(desc ? files : files.slice().reverse());
  try {
    for (const h of handles) {
      const lines = desc ? serverLog.linesBackward(h.fh, h.size) : serverLog.linesForward(h.fh, h.size);
      for await (const buf of lines) {
        const text = buf.toString('utf8');
        const hd = serverLog.head(text);
        if (!hd) continue;
        if (desc) {
          if (to != null && hd.ts > to) continue;
          if (from != null && hd.ts < from) return;
        } else {
          if (from != null && hd.ts < from) continue;
          if (to != null && hd.ts > to) return;
        }
        const obj = serverLog.parseLine(text);
        if (obj) yield fromServer(obj, text);
      }
    }
  } finally {
    await serverLog.closeAll(handles);
  }
}

/** Keyset pages over an SQL table: rows by (ts, id) in one direction. */
async function* iterSql({ sql, args, tsCol, idCol = 'id', map, from, to, desc, toDb = (v) => v }) {
  const db = getDb();
  const dir = desc ? 'DESC' : 'ASC';
  const cmp = desc ? '<' : '>';
  let last = null;
  for (;;) {
    const where = [];
    const a = [...args];
    if (from != null) { where.push(`${tsCol} >= ?`); a.push(toDb(from)); }
    if (to != null) { where.push(`${tsCol} <= ?`); a.push(toDb(to)); }
    if (last) { where.push(`(${tsCol} ${cmp} ? OR (${tsCol} = ? AND ${idCol} ${cmp} ?))`); a.push(last.ts, last.ts, last.id); }
    const rows = db.prepare(`${sql} ${where.length ? (sql.includes(' WHERE ') ? ' AND ' : ' WHERE ') + where.join(' AND ') : ''}
      ORDER BY ${tsCol} ${dir}, ${idCol} ${dir} LIMIT ${BATCH}`).all(...a);
    for (const r of rows) yield map(r);
    if (rows.length < BATCH) return;
    const r = rows[rows.length - 1];
    last = { ts: r[tsCol.split('.').pop()], id: r.id };
    await new Promise((res) => setImmediate(res));
  }
}

function iterPlugins(o) {
  const args = [];
  let sql = 'SELECT id, plugin_id, level, message, created_at FROM plugin_logs';
  if (o.plugins && o.plugins.length) {
    sql += ` WHERE plugin_id IN (${o.plugins.map(() => '?').join(',')})`;
    args.push(...o.plugins);
  }
  return iterSql({ ...o, sql, args, tsCol: 'created_at', map: fromPlugin });
}

function iterActivity(o) {
  return iterSql({ ...o, sql: 'SELECT * FROM activity_log', args: [], tsCol: 'created_at', map: fromActivity, toDb: sqlTime });
}

function iterSessions(o) {
  const sql = `SELECT s.*, r.name AS route_name, p.name AS peer_name, u.display_name AS user_display_name
    FROM rdp_sessions s LEFT JOIN rdp_routes r ON r.id = s.rdp_route_id LEFT JOIN peers p ON s.peer_id = p.id
    LEFT JOIN api_tokens t ON s.token_id = t.id LEFT JOIN users u ON t.user_id = u.id`;
  // Keyset over s.started_at / s.id: the generic helper names the columns.
  return iterSql({ ...o, sql, args: [], tsCol: 's.started_at', idCol: 's.id', map: fromSession, toDb: sqlTime });
}

async function* iterAccess({ from, to, desc }) {
  const all = await accessLog.entries();
  let n = 0;
  if (desc) {
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i];
      if (to != null && e.ts > to) continue;
      if (from != null && e.ts < from) return;
      yield fromAccess(e);
      if (++n % 2000 === 0) await new Promise((res) => setImmediate(res));
    }
  } else {
    for (const e of all) {
      if (from != null && e.ts < from) continue;
      if (to != null && e.ts > to) return;
      yield fromAccess(e);
      if (++n % 2000 === 0) await new Promise((res) => setImmediate(res));
    }
  }
}

const ITER = { server: iterServer, plugins: iterPlugins, activity: iterActivity, access: iterAccess, sessions: iterSessions };

function safeIter(source, o) {
  // A source that fails (missing table, unreadable file) ends quietly: the
  // other sources still answer.
  const it = ITER[source](o);
  return (async function* () {
    try {
      for await (const e of it) yield e;
    } catch { /* source unavailable */ }
  })();
}

/**
 * Entries of several sources, merged by time (ties: source order, then the
 * order within the source). desc = newest first.
 */
async function* merged(sources, o) {
  const its = sources.map((s) => safeIter(s, o));
  const heads = await Promise.all(its.map((it) => it.next()));
  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].done) continue;
      if (best === -1) { best = i; continue; }
      const a = heads[i].value.ts;
      const b = heads[best].value.ts;
      if (o.desc ? a > b : a < b) best = i;
    }
    if (best === -1) return;
    yield heads[best].value;
    heads[best] = await its[best].next();
  }
}

// ─── Filters ─────────────────────────────────────────────────────────────────

const KEYED = new Set(['plugin', 'source', 'level', 'code', 'event', 'status', 'ip', 'host']);

/**
 * Search text → { words, phrases, not, keyed: [{ key, value, neg }], notLevels }.
 * Syntax: plain words (all must appear), "exact text", -word (must not),
 * key:value for plugin, source, level, code, event, status, ip, host (also
 * negated: -plugin:mail). -debug / -info … leave out that level.
 */
function parseSearch(q) {
  const out = { words: [], phrases: [], not: [], keyed: [], notLevels: [] };
  const s = String(q || '');
  const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  let m;
  while ((m = re.exec(s))) {
    const neg = m[1] === '-';
    const key = m[2] ? m[2].toLowerCase() : null;
    const value = (m[3] != null ? m[3] : m[4] || '').toLowerCase();
    if (!value) continue;
    if (key && KEYED.has(key)) {
      out.keyed.push({ key, value, neg });
    } else if (key) {
      // unknown key: the whole token is text
      const text = `${key}:${value}`;
      (neg ? out.not : out.words).push(text);
    } else if (neg && LEVELS.includes(value)) {
      out.notLevels.push(value);
    } else if (m[3] != null) {
      (neg ? out.not : out.phrases).push(value);
    } else {
      (neg ? out.not : out.words).push(value);
    }
  }
  return out;
}

function haystack(e) {
  if (e._hay == null) {
    let f = '';
    try { f = JSON.stringify(e.fields); } catch { f = ''; }
    e._hay = `${e.msg} ${e.ctx} ${f} ${e.source} ${e.pluginName || ''} ${e.code || ''}`.toLowerCase();
  }
  return e._hay;
}

function keyedMatch(e, { key, value }) {
  const has = (v) => v != null && String(v).toLowerCase().includes(value);
  switch (key) {
    case 'plugin': return has(e.plugin) || has(e.pluginName);
    case 'source': return has(e.source);
    case 'level': return e.level === value || has(e.levelName);
    case 'code': return has(e.code);
    case 'event': return has(e.fields && e.fields.event);
    case 'status': return has(e.fields && e.fields.status);
    case 'ip': return has(e.fields && e.fields.ip);
    case 'host': return has(e.fields && e.fields.host);
    default: return false;
  }
}

function matchSearch(e, s) {
  if (!s) return true;
  if (s.notLevels.length && s.notLevels.includes(e.level)) return false;
  for (const k of s.keyed) if (keyedMatch(e, k) === k.neg) return false;
  if (!s.words.length && !s.phrases.length && !s.not.length) return true;
  const h = haystack(e);
  for (const w of s.words) if (!h.includes(w)) return false;
  for (const p of s.phrases) if (!h.includes(p)) return false;
  for (const n of s.not) if (h.includes(n)) return false;
  return true;
}

/**
 * Query → filter. Throws QueryError on invalid input.
 *   level    comma list of error, warn, info, debug (empty = all)
 *   source   comma list of SOURCES (empty = every allowed one)
 *   plugin   comma list of plugin ids
 *   q        search text (parseSearch), ≤ 300 characters
 *   from/to  epoch ms or ISO
 *   problem  a problem key (logProblems.js)
 */
function parseFilter(query = {}, { allowed = SOURCES } = {}) {
  const levels = list(query.level);
  if (levels === null || levels.some((l) => !LEVELS.includes(l))) throw new QueryError('level');
  const sources = list(query.source);
  if (sources === null || sources.some((s) => !SOURCES.includes(s))) throw new QueryError('source');
  const plugins = list(query.plugin);
  if (plugins === null || plugins.length > 50 || plugins.some((p) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(p))) throw new QueryError('plugin');
  const from = parseTime(query.from, 'from');
  const to = parseTime(query.to, 'to');
  if (from != null && to != null && from > to) throw new QueryError('to');
  const q = shortString(query.q, 'q', 300).trim();
  const problem = shortString(query.problem, 'problem', 300);
  return {
    levels: levels.length && levels.length < LEVELS.length ? new Set(levels) : null,
    sources: sources.length ? sources : null,
    allowed,
    plugins: plugins.length ? new Set(plugins) : null,
    q,
    search: q ? parseSearch(q) : null,
    from,
    to,
    problem: problem || null,
  };
}

/** The sources a filter reads: requested ∩ allowed (all allowed when none requested). */
function sourcesOf(filter) {
  const req = filter.sources || SOURCES;
  return SOURCES.filter((s) => req.includes(s) && filter.allowed.includes(s));
}

function problemKeyOf(e) {
  return require('./logProblems').keyOf(e);
}

/** Everything but level, source and plugin (those are the facets). */
function matchBase(e, filter) {
  if (!matchSearch(e, filter.search)) return false;
  if (filter.problem && problemKeyOf(e) !== filter.problem) return false;
  return true;
}
function matchLevel(e, filter) { return !filter.levels || filter.levels.has(e.level); }
function matchPlugin(e, filter) { return !filter.plugins || (e.plugin != null && filter.plugins.has(e.plugin)); }
function matches(e, filter) { return matchLevel(e, filter) && matchPlugin(e, filter) && matchBase(e, filter); }

// ─── Queries ─────────────────────────────────────────────────────────────────

function parseCursor(v) {
  if (v === undefined || v === '') return null;
  const m = typeof v === 'string' ? /^(\d{1,16})-(\d{1,7})$/.exec(v) : null;
  if (!m) throw new QueryError('before');
  return { ts: Number(m[1]), skip: Number(m[2]) };
}

function parseLimit(v, def = 100) {
  if (v === undefined || v === '') return def;
  if (typeof v !== 'string' || !/^\d{1,4}$/.test(v)) throw new QueryError('limit');
  const n = Number(v);
  if (n < 1 || n > MAX_LIMIT) throw new QueryError('limit');
  return n;
}

function pushDown(filter) {
  return { plugins: filter.plugins ? [...filter.plugins] : null };
}

/** Public shape of an entry (no internal caches; raw only on request). */
function view(e, { raw = false } = {}) {
  const out = {
    id: e.id, source: e.source, ts: e.ts, time: e.time, level: e.level, levelName: e.levelName,
    msg: e.msg.length > 2000 ? e.msg.slice(0, 2000) + '…' : e.msg,
    ctx: e.ctx, plugin: e.plugin, pluginName: e.pluginName, code: e.code,
  };
  if (raw) {
    out.fields = e.fields;
    out.raw = e.raw;
  }
  return out;
}

/**
 * One page, newest first. → { entries, next, more }
 * `before` "<ts>-<skip>": entries at or before ts, skipping the first `skip`
 * entries at exactly ts (they were on the previous page).
 */
async function page(filter, { before = null, limit = 100 } = {}) {
  const sources = sourcesOf(filter);
  const to = before ? (filter.to != null ? Math.min(filter.to, before.ts) : before.ts) : filter.to;
  const entries = [];
  let skip = before ? before.skip : 0;
  for await (const e of merged(sources, { from: filter.from, to, desc: true, ...pushDown(filter) })) {
    if (!matches(e, filter)) continue;
    if (before && e.ts === before.ts && skip > 0) { skip -= 1; continue; }
    entries.push(e);
    if (entries.length >= limit) break;
  }
  let next = null;
  if (entries.length >= limit) {
    const last = entries[entries.length - 1].ts;
    let same = 0;
    for (let i = entries.length - 1; i >= 0 && entries[i].ts === last; i--) same += 1;
    if (before && before.ts === last) same += before.skip;
    next = `${last}-${same}`;
  }
  return { entries, next, more: next !== null };
}

/** Every matching entry in time order (exports); stops when fn returns false. */
async function each(filter, fn, { desc = false, max = 500000 } = {}) {
  let n = 0;
  for await (const e of merged(sourcesOf(filter), { from: filter.from, to: filter.to, desc, ...pushDown(filter) })) {
    if (!matches(e, filter)) continue;
    if (n >= max) return { count: n, capped: true };
    n += 1;
    if ((await fn(e)) === false) break;
  }
  return { count: n, capped: false };
}

/** Entries by id (selection export), newest first; unknown ids are skipped. */
async function byIds(ids, allowed) {
  const out = [];
  for (const id of ids.slice(0, MAX_IDS)) {
    const e = await get(id, allowed);
    if (e) out.push(e);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

const ID_RE = /^(?:([sh])\.(\d{1,16})\.([0-9a-f]{10,12})|([par])\.(\d{1,12}))$/;
const ID_SOURCE = { s: 'server', h: 'access', p: 'plugins', a: 'activity', r: 'sessions' };

/** One entry by id (null when gone or not allowed). */
async function get(id, allowed = SOURCES) {
  const m = ID_RE.exec(String(id || ''));
  if (!m) return null;
  const source = ID_SOURCE[m[1] || m[4]];
  if (!allowed.includes(source)) return null;
  try {
    if (m[1]) {
      const ts = Number(m[2]);
      for await (const e of safeIter(source, { from: ts, to: ts, desc: true })) if (e.id === id) return e;
      return null;
    }
    const rowId = Number(m[5]);
    const db = getDb();
    if (source === 'plugins') {
      const r = db.prepare('SELECT id, plugin_id, level, message, created_at FROM plugin_logs WHERE id = ?').get(rowId);
      return r ? fromPlugin(r) : null;
    }
    if (source === 'activity') {
      const r = db.prepare('SELECT * FROM activity_log WHERE id = ?').get(rowId);
      return r ? fromActivity(r) : null;
    }
    const r = db.prepare(`SELECT s.*, r.name AS route_name, p.name AS peer_name, u.display_name AS user_display_name
      FROM rdp_sessions s LEFT JOIN rdp_routes r ON r.id = s.rdp_route_id LEFT JOIN peers p ON s.peer_id = p.id
      LEFT JOIN api_tokens t ON s.token_id = t.id LEFT JOIN users u ON t.user_id = u.id WHERE s.id = ?`).get(rowId);
    return r ? fromSession(r) : null;
  } catch {
    return null;
  }
}

function parseIds(v) {
  const ids = list(v);
  if (ids === null || ids.length > MAX_IDS || ids.some((id) => !ID_RE.test(id))) throw new QueryError('ids');
  return ids;
}

// ─── Statistics: facets, histogram, KPI tiles ────────────────────────────────

function emptyLevels() { return { error: 0, warn: 0, info: 0, debug: 0 }; }

/**
 * Numbers for the page head and the filter column, one pass over the range.
 *   counts.levels   per level (filter without its level)
 *   counts.sources  per source (filter without its source)
 *   counts.plugins  per plugin id (filter without its plugin)
 *   total           entries that match the whole filter
 *   histogram       { bucketMs, buckets[{ t, time, error, warn, info, debug }] } of the whole filter
 *   kpi             the range without any filter: errors (+ the same span before),
 *                   warnings (+ most frequent code), server blocked (count, longest),
 *                   HTTP 5xx of all requests, plugins with errors
 */
async function stats(filter, { bucketMs }) {
  const sources = filter.allowed.slice();
  const wanted = new Set(sourcesOf(filter));
  const levels = emptyLevels();
  const srcCounts = Object.fromEntries(SOURCES.filter((s) => filter.allowed.includes(s)).map((s) => [s, 0]));
  const plugins = {};
  const buckets = new Map();
  let total = 0;
  const kpi = {
    errors: 0, errorsBefore: null, warnings: 0, topWarning: null,
    blocked: { count: 0, maxMs: 0, at: null }, http: { total: 0, errors: 0 },
    plugins: { withErrors: [], installed: pluginNames().size },
  };
  const warnCodes = new Map();
  const pluginErr = new Map();
  for await (const e of merged(sources, { from: filter.from, to: filter.to, desc: true })) {
    // KPIs: everything in the range
    if (e.level === 'error') kpi.errors += 1;
    if (e.level === 'warn') {
      kpi.warnings += 1;
      if (e.code) warnCodes.set(e.code, (warnCodes.get(e.code) || 0) + 1);
    }
    if (e.source === 'server' && e.code === 'event_loop_blocked') {
      kpi.blocked.count += 1;
      const ms = Number(e.fields && e.fields.blockedMs) || 0;
      if (ms > kpi.blocked.maxMs) { kpi.blocked.maxMs = ms; kpi.blocked.at = e.time; }
    }
    if (e.source === 'access') {
      kpi.http.total += 1;
      if (e.fields.status >= 500) kpi.http.errors += 1;
    }
    if (e.plugin && (e.level === 'error' || e.level === 'warn')) pluginErr.set(e.plugin, (pluginErr.get(e.plugin) || 0) + 1);

    if (!matchBase(e, filter)) continue;
    const inSource = wanted.has(e.source);
    const inLevel = matchLevel(e, filter);
    const inPlugin = matchPlugin(e, filter);
    if (inSource && inPlugin) levels[e.level] += 1;
    if (inLevel && inPlugin) srcCounts[e.source] += 1;
    if (inSource && inLevel && e.plugin) plugins[e.plugin] = (plugins[e.plugin] || 0) + 1;
    if (inSource && inLevel && inPlugin) {
      total += 1;
      if (bucketMs) {
        const t = Math.floor(e.ts / bucketMs) * bucketMs;
        let row = buckets.get(t);
        if (!row) {
          if (buckets.size >= 1000) continue;
          row = { t, time: iso(t), ...emptyLevels() };
          buckets.set(t, row);
        }
        row[e.level] += 1;
      }
    }
  }
  if (warnCodes.size) {
    const [code, count] = [...warnCodes.entries()].sort((a, b) => b[1] - a[1])[0];
    kpi.topWarning = { code, count };
  }
  const names = pluginNames();
  kpi.plugins.withErrors = [...pluginErr.entries()].sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, name: names.has(id) ? names.get(id).name : id, count }));
  // Errors in the same span right before (the tile compares)
  if (filter.from != null) {
    const span = (filter.to != null ? filter.to : Date.now()) - filter.from;
    let before = 0;
    for await (const e of merged(sources, { from: filter.from - span, to: filter.from - 1, desc: true })) {
      if (e.level === 'error') before += 1;
    }
    kpi.errorsBefore = before;
  }
  const pluginList = Object.entries(plugins).sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, name: names.has(id) ? names.get(id).name : id, count }));
  return {
    total,
    counts: { levels, sources: srcCounts, plugins: pluginList },
    histogram: bucketMs ? { bucketMs, buckets: [...buckets.values()].sort((a, b) => a.t - b.t) } : null,
    kpi,
  };
}

module.exports = {
  SOURCES,
  ADMIN_SOURCES,
  LEVELS,
  KNOWN_CODES,
  MAX_IDS,
  codeOf,
  parseSearch,
  matchSearch,
  parseFilter,
  parseCursor,
  parseLimit,
  parseIds,
  sourcesOf,
  matches,
  merged,
  page,
  each,
  get,
  byIds,
  stats,
  view,
  pluginNames,
  resetCaches,
};
