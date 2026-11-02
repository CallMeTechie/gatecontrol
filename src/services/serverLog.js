'use strict';

// Reader of the server log file (utils/serverLogFile.js) for
// GET /api/v1/logs/server and its export (routes/api/logs.js).
//
// Only the files of the rotation are read — server.log, server.log.1 … in
// the configured directory; no path ever comes from a request. Files are read
// in chunks with async I/O (the main thread is never held for the whole
// 25 MB), all handles are opened before reading, so a rotation during a
// request neither loses nor repeats lines. Lines are pino JSON; a line that
// is not (a crash in the middle of a write) is skipped.
//
// Level groups as in the support bundle viewer: error (error, fatal), warn,
// info, debug (debug, trace).

const fsp = require('node:fs/promises');
const path = require('node:path');
const serverLogFile = require('../utils/serverLogFile');
const { QueryError, list, parseTime, shortString } = require('../utils/logQuery');

const LEVELS = ['error', 'warn', 'info', 'debug'];
const LEVEL_NAMES = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const CHUNK = 256 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_ENTRY_RAW = 32 * 1024;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
const MAX_Q = 200;
const MAX_FIELDS = 5;
const MAX_EXPORT_LINES = 200000;
const MAX_BUCKETS = 500;
// Keys of a pino line that are not "fields" of the entry.
const BASE_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const LEVEL_RE = /"level":(\d{1,3})/;
const TIME_RE = /"time":(\d{10,16})/;

function levelGroup(n) {
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  return 'debug';
}

function levelName(n) {
  return LEVEL_NAMES[n] || levelGroup(n);
}

/**
 * Query parameters → filter. Throws QueryError (→ 400) on anything invalid.
 *   level   error,warn,info,debug (comma list or repeated; empty = all)
 *   q       text in msg or any field (case-insensitive, ≤ 200 chars)
 *   from/to epoch ms or ISO date/time (inclusive)
 *   plugin, module   exact value of that field
 *   msg     text in msg only
 *   field   key:value, exact value of a top-level field (≤ 5)
 */
function parseFilter(query = {}) {
  const lv = list(query.level);
  if (lv === null || lv.some((l) => !LEVELS.includes(l))) throw new QueryError('level');
  const levels = lv.length && lv.length < LEVELS.length ? new Set(lv) : null;
  const from = parseTime(query.from, 'from');
  const to = parseTime(query.to, 'to');
  if (from != null && to != null && from > to) throw new QueryError('to');
  const fields = [];
  for (const key of ['plugin', 'module']) {
    const v = shortString(query[key], key, 200);
    if (v) fields.push([key, v]);
  }
  const extra = list(query.field);
  if (extra === null || extra.length > MAX_FIELDS) throw new QueryError('field');
  for (const f of extra) {
    const i = f.indexOf(':');
    const key = i > 0 ? f.slice(0, i) : '';
    if (!FIELD_KEY_RE.test(key) || BASE_KEYS.has(key) || f.length > 300) throw new QueryError('field');
    fields.push([key, f.slice(i + 1)]);
  }
  return {
    levels,
    q: shortString(query.q, 'q', MAX_Q).trim().toLowerCase(),
    msg: shortString(query.msg, 'msg', MAX_Q).trim().toLowerCase(),
    from,
    to,
    fields,
  };
}

/** Cursor "ts-skip" of the previous page (null when none). */
function parseCursor(v) {
  if (v === undefined || v === '') return null;
  const m = typeof v === 'string' ? /^(\d{10,16})(?:-(\d{1,7}))?$/.exec(v) : null;
  if (!m) throw new QueryError('before');
  return { ts: Number(m[1]), skip: m[2] ? Number(m[2]) : 0 };
}

function parseLimit(v) {
  if (v === undefined || v === '') return DEFAULT_LIMIT;
  if (typeof v !== 'string' || !/^\d{1,4}$/.test(v)) throw new QueryError('limit');
  const n = Number(v);
  if (n < 1 || n > MAX_LIMIT) throw new QueryError('limit');
  return n;
}

// ─── Files ───────────────────────────────────────────────────────────────────

function options() {
  return serverLogFile.resolveOptions();
}

/**
 * The files of the rotation, opened, newest first: [{ fh, name, size, mtime }].
 * Opened first and measured through the handle — a rotation in between
 * neither loses nor repeats lines, and no path is checked before it is used.
 */
async function openRotation(opts = options()) {
  const out = [];
  for (const p of serverLogFile.rotationFiles(opts.file, opts.files)) {
    let fh = null;
    try {
      fh = await fsp.open(p, 'r');
      const st = await fh.stat();
      if (!st.isFile()) { await fh.close(); continue; }
      out.push({ fh, name: path.basename(p), size: st.size, mtime: st.mtime.toISOString() });
    } catch {
      if (fh) await fh.close().catch(() => {});
    }
  }
  return out;
}

/** Files of the rotation that exist, newest first: [{ name, size, mtime }]. */
async function listFiles(opts) {
  const handles = await openRotation(opts);
  await closeAll(handles);
  return handles.map(({ name, size, mtime }) => ({ name, size, mtime }));
}

async function closeAll(handles) {
  await Promise.all(handles.map((h) => h.fh.close().catch(() => {})));
}

/** Lines of one file from the end to the start (Buffer slices, no newline). */
async function* linesBackward(fh, size) {
  let pos = size;
  let carry = Buffer.alloc(0);
  let skipping = false;
  while (pos > 0) {
    const len = Math.min(CHUNK, pos);
    pos -= len;
    const chunk = Buffer.alloc(len);
    await fh.read(chunk, 0, len, pos);
    let buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    let end = buf.length;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] !== 10) continue;
      if (skipping) skipping = false;
      else if (end - i > 1) yield buf.subarray(i + 1, end);
      end = i;
    }
    carry = buf.subarray(0, end);
    if (carry.length > MAX_LINE) {
      carry = Buffer.alloc(0);
      skipping = true;
    }
    buf = null;
  }
  if (carry.length && !skipping) yield carry;
}

/** Lines of one file from the start to the end. */
async function* linesForward(fh, size) {
  let pos = 0;
  let carry = Buffer.alloc(0);
  let skipping = false;
  while (pos < size) {
    const len = Math.min(CHUNK, size - pos);
    const chunk = Buffer.alloc(len);
    const { bytesRead } = await fh.read(chunk, 0, len, pos);
    if (!bytesRead) break;
    pos += bytesRead;
    const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 10) continue;
      if (skipping) skipping = false;
      else if (i > start) yield buf.subarray(start, i);
      start = i + 1;
    }
    carry = buf.subarray(start);
    if (carry.length > MAX_LINE) {
      carry = Buffer.alloc(0);
      skipping = true;
    }
  }
  // A last line without newline is still being written: leave it out.
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** Cheap head of a raw line: { ts, level } or null when it is no pino line. */
function head(raw) {
  const s = raw.length > 256 ? raw.slice(0, 256) : raw;
  const t = TIME_RE.exec(s);
  const l = LEVEL_RE.exec(s);
  if (!t || !l) return null;
  return { ts: Number(t[1]), level: Number(l[1]) };
}

function needsParse(filter) {
  return !!(filter.q || filter.msg || filter.fields.length);
}

// Search text of a parsed line: the message plus every field (JSON).
function searchText(obj) {
  const rest = {};
  for (const k of Object.keys(obj)) if (!BASE_KEYS.has(k)) rest[k] = obj[k];
  return (String(obj.msg == null ? '' : obj.msg) + ' ' + JSON.stringify(rest)).toLowerCase();
}

/**
 * Everything but the level and the time range: q, msg, fields. Takes the raw
 * text (for a cheap pre-check) and returns the parsed object, or null.
 */
function matchRest(text, filter) {
  // Quick reject on the raw JSON line: q/msg must appear there, unless it
  // holds characters JSON escapes (quote, backslash, control characters).
  const low = text.toLowerCase();
  for (const t of [filter.q, filter.msg]) {
    if (t && !/["\\\u0000-\u001f]/.test(t) && !low.includes(t)) return null;
  }
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (filter.msg && !String(obj.msg == null ? '' : obj.msg).toLowerCase().includes(filter.msg)) return null;
  for (const [k, v] of filter.fields) {
    const val = obj[k];
    if (val == null || typeof val === 'object' || String(val).toLowerCase() !== v.toLowerCase()) return null;
  }
  if (filter.q && !searchText(obj).includes(filter.q)) return null;
  return obj;
}

function parseLine(text) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

/** Parsed pino line → entry of the API. */
function toEntry(obj, rawLength) {
  const n = Number(obj.level) || 30;
  const ts = Number(obj.time) || 0;
  const fields = {};
  if (rawLength > MAX_ENTRY_RAW) {
    fields.truncated = true;
    fields.bytes = rawLength;
  } else {
    for (const k of Object.keys(obj)) if (!BASE_KEYS.has(k)) fields[k] = obj[k];
  }
  let msg = obj.msg == null ? '' : String(obj.msg);
  if (msg.length > 4096) msg = msg.slice(0, 4096) + '…';
  return { ts, time: new Date(ts).toISOString(), level: levelGroup(n), levelName: levelName(n), msg, fields };
}

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * One page, newest first.
 * @returns {Promise<{ entries, next, more, counts?, histogram?, files }>}
 *   next   cursor for `before` (null when the page is not full)
 *   counts entries per level group for the filter without its level
 *          (with counts: true), histogram the same per time bucket
 */
async function query(filter, { before = null, limit = DEFAULT_LIMIT, counts = false, bucketMs = null } = {}) {
  const handles = await openRotation();
  const files = handles.map(({ name, size, mtime }) => ({ name, size, mtime }));
  const entries = [];
  const tally = counts ? { error: 0, warn: 0, info: 0, debug: 0, total: 0 } : null;
  const buckets = counts && bucketMs ? new Map() : null;
  let skip = before ? before.skip : 0;
  const parse = needsParse(filter);
  try {
    outer:
    for (const h of handles) {
      for await (const buf of linesBackward(h.fh, h.size)) {
        const text = buf.toString('utf8');
        const hd = head(text);
        if (!hd) continue;
        if (filter.to != null && hd.ts > filter.to) continue;
        if (filter.from != null && hd.ts < filter.from) break outer; // older from here on
        let obj = null;
        if (parse) {
          obj = matchRest(text, filter);
          if (!obj) continue;
        }
        const group = levelGroup(hd.level);
        if (tally) {
          tally[group] += 1;
          tally.total += 1;
          if (buckets) {
            const b = Math.floor(hd.ts / bucketMs) * bucketMs;
            let row = buckets.get(b);
            if (!row) {
              if (buckets.size >= MAX_BUCKETS) { buckets.overflow = true; row = null; } else {
                row = { t: b, error: 0, warn: 0, info: 0, debug: 0 };
                buckets.set(b, row);
              }
            }
            if (row) row[group] += 1;
          }
        }
        if (entries.length >= limit) {
          if (!tally) break outer;
          continue;
        }
        if (filter.levels && !filter.levels.has(group)) continue;
        if (before) {
          if (hd.ts > before.ts) continue;
          if (hd.ts === before.ts && skip > 0) { skip -= 1; continue; }
        }
        if (!obj) obj = parseLine(text);
        if (!obj) continue;
        entries.push(toEntry(obj, buf.length));
      }
    }
  } finally {
    await closeAll(handles);
  }
  let next = null;
  if (entries.length >= limit) {
    const last = entries[entries.length - 1].ts;
    let same = 0;
    for (let i = entries.length - 1; i >= 0 && entries[i].ts === last; i--) same += 1;
    if (before && before.ts === last) same += before.skip;
    next = `${last}-${same}`;
  }
  const out = {
    entries,
    next,
    more: next !== null,
    files: files.map(({ name, size, mtime }) => ({ name, size, mtime })),
  };
  if (tally) out.counts = tally;
  if (buckets) {
    out.histogram = {
      bucketMs,
      buckets: [...buckets.values()].sort((a, b) => a.t - b.t).map((r) => ({ ...r, time: new Date(r.t).toISOString() })),
      truncated: !!buckets.overflow,
    };
  }
  return out;
}

/**
 * Every matching line, oldest first, for the export; calls onLine(obj, text)
 * (awaited — backpressure of the response). Stops after MAX_EXPORT_LINES or
 * when onLine returns false. → { lines, capped }
 */
async function each(filter, onLine, { max = MAX_EXPORT_LINES } = {}) {
  const handles = (await openRotation()).reverse();
  let lines = 0;
  let capped = false;
  const parse = needsParse(filter);
  try {
    outer:
    for (const h of handles) {
      for await (const buf of linesForward(h.fh, h.size)) {
        const text = buf.toString('utf8');
        const hd = head(text);
        if (!hd) continue;
        if (filter.from != null && hd.ts < filter.from) continue;
        if (filter.to != null && hd.ts > filter.to) break outer;
        if (filter.levels && !filter.levels.has(levelGroup(hd.level))) continue;
        const obj = parse ? matchRest(text, filter) : parseLine(text);
        if (!obj) continue;
        if (lines >= max) { capped = true; break outer; }
        lines += 1;
        if ((await onLine(obj, text)) === false) break outer;
      }
    }
  } finally {
    await closeAll(handles);
  }
  return { lines, capped };
}

/** One parsed line as a text line: "<ISO time> <LEVEL> <msg> <fields JSON>". */
function textLine(obj) {
  const n = Number(obj.level) || 30;
  const ts = Number(obj.time);
  const rest = {};
  for (const k of Object.keys(obj)) if (!BASE_KEYS.has(k)) rest[k] = obj[k];
  const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
  const time = Number.isFinite(ts) ? new Date(ts).toISOString() : '-';
  const msg = String(obj.msg == null ? '' : obj.msg).replace(/\r?\n/g, ' ⏎ ');
  return `${time} ${levelName(n).toUpperCase().padEnd(5)} ${msg}${extra}`;
}

/** Fields of a parsed line apart from msg/level/time (for CSV "details"). */
function restOf(obj) {
  const rest = {};
  for (const k of Object.keys(obj)) if (!BASE_KEYS.has(k)) rest[k] = obj[k];
  return rest;
}

module.exports = {
  LEVELS,
  MAX_LIMIT,
  MAX_EXPORT_LINES,
  QueryError,
  levelGroup,
  levelName,
  parseFilter,
  parseCursor,
  parseLimit,
  options,
  listFiles,
  query,
  each,
  textLine,
  restOf,
  linesBackward,
  linesForward,
  openRotation,
  closeAll,
  head,
  parseLine,
  BASE_KEYS,
};
