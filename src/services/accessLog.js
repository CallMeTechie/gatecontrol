'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const config = require('../../config/default');

const LOG_FILE = path.join(config.caddy.dataDir, 'access.log');

/** Every parsed line of access.log, newest first. */
async function readAll() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = [];
  const stream = fs.createReadStream(LOG_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return lines.reverse();
}

/** `status`: one value or a comma list; each ≥ 100 selects its class (404 → 4xx). */
function statusClasses(status) {
  const out = new Set();
  for (const p of String(status || '').split(',')) {
    const s = parseInt(p, 10);
    if (s >= 100) out.add(Math.floor(s / 100));
  }
  return out;
}

/**
 * Filters (all optional): domain (part of the host), status (see
 * statusClasses), method, from/to (epoch ms, inclusive), q (text in host,
 * path, client IP or user agent). `skipStatus` leaves the status filter out
 * (counts per class).
 */
function applyFilters(lines, filters = {}, { skipStatus = false } = {}) {
  let filtered = lines;

  if (filters.domain) {
    const d = filters.domain.toLowerCase();
    filtered = filtered.filter(e => e.request && e.request.host && e.request.host.toLowerCase().includes(d));
  }

  if (filters.status && !skipStatus) {
    const classes = statusClasses(filters.status);
    if (classes.size) filtered = filtered.filter(e => classes.has(Math.floor(e.status / 100)));
  }

  if (filters.method) {
    const m = filters.method.toUpperCase();
    filtered = filtered.filter(e => e.request && e.request.method === m);
  }

  if (filters.from != null) filtered = filtered.filter(e => typeof e.ts === 'number' && e.ts * 1000 >= filters.from);
  if (filters.to != null) filtered = filtered.filter(e => typeof e.ts === 'number' && e.ts * 1000 <= filters.to);

  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    filtered = filtered.filter((e) => {
      const r = e.request || {};
      const ua = r.headers ? (r.headers['User-Agent'] || [''])[0] : '';
      return [r.host, r.uri, r.remote_ip, ua].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
    });
  }
  return filtered;
}

function toEntry(e) {
  return {
    timestamp: e.ts ? new Date(e.ts * 1000).toISOString() : null,
    method: e.request ? e.request.method : '',
    host: e.request ? e.request.host : '',
    uri: e.request ? e.request.uri : '',
    status: e.status || 0,
    duration: e.duration != null ? Math.round(e.duration * 1000) : 0, // ms
    size: e.size || 0,
    remote_ip: e.request ? e.request.remote_ip : '',
    proto: e.request ? e.request.proto : '',
    user_agent: e.request && e.request.headers ? (e.request.headers['User-Agent'] || [''])[0] : '',
  };
}

/** Requests per status class (filters without status) and per time bucket. */
function countsOf(lines, filters, bucketMs) {
  const base = applyFilters(lines, filters, { skipStatus: true });
  const counts = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, total: base.length };
  const map = bucketMs ? new Map() : null;
  for (const e of base) {
    const cls = `${Math.floor((e.status || 0) / 100)}xx`;
    if (Object.prototype.hasOwnProperty.call(counts, cls)) counts[cls] += 1;
    if (map && typeof e.ts === 'number') {
      const t = Math.floor((e.ts * 1000) / bucketMs) * bucketMs;
      let row = map.get(t);
      if (!row) {
        if (map.size >= 1000) continue;
        row = { t, time: new Date(t).toISOString(), '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
        map.set(t, row);
      }
      if (Object.prototype.hasOwnProperty.call(row, cls)) row[cls] += 1;
    }
  }
  const out = { counts };
  if (map) out.histogram = { bucketMs, buckets: [...map.values()].sort((a, b) => a.t - b.t) };
  return out;
}

/**
 * Read the last N access log entries from Caddy's JSON log file. With
 * opts.counts also { counts, histogram? } (opts.bucketMs).
 */
async function getRecent(limit = 50, filters = {}, opts = {}) {
  if (!fs.existsSync(LOG_FILE)) {
    const empty = { entries: [], total: 0 };
    if (opts.counts) Object.assign(empty, countsOf([], filters, opts.bucketMs));
    return empty;
  }
  const lines = await readAll();
  const filtered = applyFilters(lines, filters);

  const total = filtered.length;
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const offset = (page - 1) * limit;
  const paged = filtered.slice(offset, offset + limit);

  const out = {
    entries: paged.map(toEntry),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
  if (opts.counts) Object.assign(out, countsOf(lines, filters, opts.bucketMs));
  return out;
}

/**
 * Get all access log entries matching filters (for export, no pagination)
 */
async function getAllFiltered(filters = {}) {
  return applyFilters(await readAll(), filters).map(toEntry);
}

// ─── Cached, normalised entries (Logs & Monitoring, services/logEvents.js) ───
// access.log only grows between Caddy's rolls: the cache keeps the parsed
// entries and reads just the bytes appended since; a new file (inode) or a
// shorter one is read again from the start.

let cache = { ino: null, size: 0, entries: [], partial: '' };

/** Short stable hash of a line (id of the entry). */
function lineHash(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (Math.imul(h2, 31) + c) | 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0').slice(0, 4);
}

function normalise(e, raw) {
  const r = e.request || {};
  const ua = r.headers ? (r.headers['User-Agent'] || [''])[0] : '';
  return {
    ts: typeof e.ts === 'number' ? Math.round(e.ts * 1000) : 0,
    status: e.status || 0,
    method: r.method || '',
    host: r.host || '',
    uri: r.uri || '',
    remote_ip: r.remote_ip || '',
    proto: r.proto || '',
    user_agent: typeof ua === 'string' ? ua : '',
    duration: e.duration != null ? Math.round(e.duration * 1000) : 0,
    size: e.size || 0,
    hash: lineHash(raw),
  };
}

function parseInto(text, out) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(normalise(JSON.parse(line), line)); } catch { /* skip malformed lines */ }
  }
}

/** Every entry of access.log, oldest first (normalised, cached). */
async function entries() {
  // Open first, then stat the open file: what is read is what was measured.
  let fh;
  try { fh = await fs.promises.open(LOG_FILE, 'r'); } catch { cache = { ino: null, size: 0, entries: [], partial: '' }; return []; }
  try {
    const st = await fh.stat();
    if (cache.ino !== st.ino || st.size < cache.size) cache = { ino: st.ino, size: 0, entries: [], partial: '' };
    if (st.size > cache.size) {
      const len = st.size - cache.size;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, cache.size);
      let text = cache.partial + buf.subarray(0, bytesRead).toString('utf8');
      const cut = text.lastIndexOf('\n');
      const partial = cut === -1 ? text : text.slice(cut + 1);
      text = cut === -1 ? '' : text.slice(0, cut);
      const next = cache.entries.slice();
      parseInto(text, next);
      cache = { ino: st.ino, size: cache.size + bytesRead, entries: next, partial };
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return cache.entries;
}

module.exports = { getRecent, getAllFiltered, applyFilters, statusClasses, entries, lineHash, LOG_FILE };
