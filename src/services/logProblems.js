'use strict';

// Problems (Logs & Monitoring › Probleme): errors and warnings of every
// source grouped into problems — independent of the source, so the same
// "storage timeout" of five plugins is one problem.
//
// Key: a known or recognised error code ("c:<code>", logEvents.codeOf), else
// the normalised message ("m:<text>": numbers, ids, addresses, quoted parts
// and paths replaced). HTTP 5xx of the access log group per status and host.
//
// The state of a problem lives in log_problems (migration 121): open, watch
// (beobachten), resolved (erledigt; it is "returned" when it occurs again
// afterwards), muted until a time. With notify_on_return a returned problem
// is reported once through the activity log (event log_problem_returned →
// notification centre rules, webhooks), checked every 5 minutes.

const { getDb } = require('../db/connection');
const logEvents = require('./logEvents');
const logger = require('../utils/logger');

const STATUSES = ['open', 'watch', 'resolved', 'muted'];
const MUTE_MS = 7 * 86400e3;
const QUIET_MS = 3 * 86400e3;
const NEW_MS = 86400e3;
const MAX_TIMES = 5000;
const MAX_PROBLEMS = 500;
const CORRELATION_MS = 2000;
const SPARK_BUCKETS = 14;
const CHECK_MS = 5 * 60e3;

function normalise(msg) {
  return String(msg || '').toLowerCase()
    .replace(/"[^"]*"|'[^']*'|„[^“]*“/g, '"…"')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<id>')
    .replace(/(?:\/[\w.@%+-]+){2,}/g, '<path>')
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Problem key of an entry (null for entries that are no problem). */
function keyOf(e) {
  if (e.source === 'access') {
    return e.fields && e.fields.status >= 500 ? `h:${e.fields.status}:${String(e.fields.host || '').toLowerCase()}` : null;
  }
  if (e.code) return `c:${e.code}`;
  return `m:${normalise(e.msg)}`;
}

function isProblem(e) {
  return (e.level === 'error' || e.level === 'warn') && keyOf(e) !== null;
}

function states() {
  try {
    return new Map(getDb().prepare('SELECT * FROM log_problems').all().map((r) => [r.key, r]));
  } catch { return new Map(); }
}

/**
 * Problems of a range (default 7 days) for the allowed sources.
 * → [{ key, code, title, level, count, first, last, sources{}, plugins{}, kinds,
 *      samples[], spark[], state, status, flags{ new, returned, quiet } }]
 * `times` (occurrence times) stays internal (correlation).
 */
async function collect({ from, to, allowed }) {
  const now = Date.now();
  const end = to != null ? to : now;
  const start = from != null ? from : end - 7 * 86400e3;
  const map = new Map();
  const sources = allowed.filter((s) => s !== 'sessions');
  for await (const e of logEvents.merged(sources, { from: start, to: end, desc: true })) {
    if (!isProblem(e)) continue;
    const key = keyOf(e);
    let p = map.get(key);
    if (!p) {
      if (map.size >= MAX_PROBLEMS) continue;
      p = {
        key, code: key.startsWith('c:') ? key.slice(2) : (key.startsWith('h:') ? `http_${key.split(':')[1]}` : null),
        title: e.msg, level: e.level, count: 0, first: e.ts, last: e.ts,
        sources: {}, plugins: {}, kinds: new Set(), samples: [], times: [],
      };
      map.set(key, p);
    }
    p.count += 1;
    if (e.level === 'error') p.level = 'error';
    if (e.ts < p.first) p.first = e.ts;
    if (e.ts > p.last) p.last = e.ts;
    const src = e.source === 'plugins' && e.pluginName ? e.pluginName : e.source;
    p.sources[src] = (p.sources[src] || 0) + 1;
    if (e.plugin) p.plugins[e.plugin] = (p.plugins[e.plugin] || 0) + 1;
    if (p.kinds.size < 50) p.kinds.add(normalise(e.msg));
    if (p.samples.length < 5) p.samples.push(logEvents.view(e));
    if (p.times.length < MAX_TIMES) p.times.push(e.ts);
  }
  const st = states();
  const span = Math.max(1, end - start);
  const out = [];
  for (const p of map.values()) {
    const s = st.get(p.key) || null;
    let status = s ? s.status : 'open';
    if (status === 'muted' && !(s.muted_until > now)) status = 'open';
    const returned = !!(s && s.status === 'resolved' && s.resolved_at && p.last > s.resolved_at);
    if (returned) status = 'open';
    const spark = new Array(SPARK_BUCKETS).fill(0);
    for (const t of p.times) {
      const i = Math.min(SPARK_BUCKETS - 1, Math.max(0, Math.floor(((t - start) / span) * SPARK_BUCKETS)));
      spark[i] += 1;
    }
    out.push({
      key: p.key,
      code: p.code,
      known: !!(p.code && logEvents.KNOWN_CODES.has(p.code)),
      title: p.title,
      level: p.level,
      count: p.count,
      first: new Date(p.first).toISOString(),
      last: new Date(p.last).toISOString(),
      firstTs: p.first,
      lastTs: p.last,
      sources: p.sources,
      plugins: p.plugins,
      kinds: p.kinds.size,
      samples: p.samples,
      spark,
      status,
      mutedUntil: s && s.status === 'muted' && s.muted_until > now ? new Date(s.muted_until).toISOString() : null,
      notifyOnReturn: !!(s && s.notify_on_return),
      flags: {
        new: !s && now - p.first < NEW_MS,
        returned,
        quiet: now - p.last > QUIET_MS,
      },
      times: p.times,
    });
  }
  return out;
}

const SORTS = {
  last: (a, b) => b.lastTs - a.lastTs,
  count: (a, b) => b.count - a.count || b.lastTs - a.lastTs,
  severity: (a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1) || b.count - a.count,
};

function strip(p) {
  const { times, ...rest } = p;
  return rest;
}

/** List for the tab: counts per status and the problems of one status. */
async function listProblems({ from, to, allowed, status = 'open', sort = 'last' }) {
  const all = await collect({ from, to, allowed });
  const counts = { open: 0, watch: 0, resolved: 0, muted: 0 };
  for (const p of all) counts[p.status] += 1;
  const problems = all.filter((p) => p.status === status).sort(SORTS[sort] || SORTS.last).map(strip);
  return { counts, problems };
}

/**
 * Problems whose occurrences fall together with `p`'s: another problem within
 * ±2 s at at least half of p's occurrences (and at least twice).
 */
function correlations(p, all) {
  const out = [];
  const mine = p.times.slice().sort((a, b) => a - b);
  if (mine.length < 2) return out;
  for (const q of all) {
    if (q.key === p.key) continue;
    const other = q.times.slice().sort((a, b) => a - b);
    let j = 0;
    let hits = 0;
    for (const t of mine) {
      while (j < other.length && other[j] < t - CORRELATION_MS) j += 1;
      if (j < other.length && other[j] <= t + CORRELATION_MS) hits += 1;
    }
    if (hits >= 2 && hits * 2 >= mine.length) {
      out.push({ key: q.key, code: q.code, known: q.known, title: q.title, hits, of: mine.length });
    }
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, 3);
}

/** One problem with correlations (null when it did not occur in the range). */
async function getProblem(key, { from, to, allowed }) {
  const all = await collect({ from, to, allowed });
  const p = all.find((x) => x.key === key);
  if (!p) return null;
  return { ...strip(p), correlations: correlations(p, all) };
}

/**
 * Change the state: status open|watch|resolved|muted (muted: 7 days),
 * notifyOnReturn. → the stored row.
 */
function setState(key, { status, notifyOnReturn, title }, userId) {
  const db = getDb();
  const now = Date.now();
  const cur = db.prepare('SELECT * FROM log_problems WHERE key = ?').get(key);
  const next = {
    status: cur ? cur.status : 'open',
    muted_until: cur ? cur.muted_until : null,
    resolved_at: cur ? cur.resolved_at : null,
    notify_on_return: cur ? cur.notify_on_return : 0,
    notified_at: cur ? cur.notified_at : null,
    title: title ? String(title).slice(0, 300) : (cur ? cur.title : null),
  };
  if (status !== undefined) {
    next.status = status;
    next.muted_until = status === 'muted' ? now + MUTE_MS : null;
    next.resolved_at = status === 'resolved' ? now : null;
    if (status === 'resolved') next.notified_at = null;
  }
  if (notifyOnReturn !== undefined) next.notify_on_return = notifyOnReturn ? 1 : 0;
  db.prepare(`INSERT INTO log_problems (key, status, muted_until, resolved_at, notify_on_return, notified_at, title, updated_at, updated_by)
    VALUES (@key, @status, @muted_until, @resolved_at, @notify_on_return, @notified_at, @title, @now, @user)
    ON CONFLICT(key) DO UPDATE SET status = @status, muted_until = @muted_until, resolved_at = @resolved_at,
      notify_on_return = @notify_on_return, notified_at = @notified_at, title = @title, updated_at = @now, updated_by = @user`)
    .run({ key, ...next, now, user: userId || null });
  return db.prepare('SELECT * FROM log_problems WHERE key = ?').get(key);
}

/** Resolved problems with notify_on_return that occurred again: one activity entry each. */
async function checkReturns() {
  let rows;
  try {
    rows = getDb().prepare(`SELECT * FROM log_problems WHERE status = 'resolved' AND notify_on_return = 1
      AND (notified_at IS NULL OR notified_at < resolved_at)`).all();
  } catch { return 0; }
  if (!rows.length) return 0;
  const since = Math.min(...rows.map((r) => r.resolved_at || Date.now()));
  const all = await collect({ from: since, to: Date.now(), allowed: logEvents.SOURCES });
  const byKey = new Map(all.map((p) => [p.key, p]));
  const activity = require('./activity');
  let n = 0;
  for (const r of rows) {
    const p = byKey.get(r.key);
    if (!p || !(p.lastTs > r.resolved_at)) continue;
    const after = p.times.filter((t) => t > r.resolved_at).length;
    getDb().prepare('UPDATE log_problems SET notified_at = ? WHERE key = ?').run(Date.now(), r.key);
    activity.log('log_problem_returned', `Problem returned: ${r.title || p.title}`, {
      severity: 'warning', source: 'system', details: { key: r.key, code: p.code, count: after, last: p.last },
    });
    n += 1;
  }
  return n;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    checkReturns().catch((err) => logger.warn({ err: err.message }, 'log problem check failed'));
  }, CHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  STATUSES,
  normalise,
  keyOf,
  isProblem,
  collect,
  listProblems,
  getProblem,
  correlations,
  setState,
  checkReturns,
  start,
  stop,
};
