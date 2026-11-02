'use strict';

// Query parameters shared by the log endpoints of Logs & Monitoring
// (routes/api/logs.js): lists, time range, histogram buckets. Anything
// invalid throws QueryError, which the routes answer with 400.

const BUCKETS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '6h': 6 * 3600e3, '1d': 86400e3 };

class QueryError extends Error {
  constructor(param) {
    super(`invalid ${param}`);
    this.code = 'INVALID_QUERY';
    this.param = param;
  }
}

// ─── Parameters ──────────────────────────────────────────────────────────────

function list(v) {
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    if (typeof x !== 'string') return null;
    for (const p of x.split(',')) if (p.trim()) out.push(p.trim());
  }
  return out;
}

function parseTime(v, name) {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new QueryError(name);
  if (/^\d{10,16}$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw new QueryError(name);
  return ms;
}

function shortString(v, name, max) {
  if (v === undefined || v === '') return '';
  if (typeof v !== 'string' || v.length > max) throw new QueryError(name);
  return v;
}

/**
 * Histogram bucket (ms) from `bucket`: 1m, 5m, 15m, 1h, 6h, 1d, or auto —
 * the smallest that gives at most 120 buckets for from…to (1h without from).
 */
function parseBucket(v, from, to) {
  if (v === undefined || v === '' || v === 'auto') {
    if (from == null) return BUCKETS['1h'];
    const span = (to == null ? Date.now() : to) - from;
    const ms = Object.values(BUCKETS).find((b) => span / b <= 120);
    return ms || BUCKETS['1d'];
  }
  if (!Object.prototype.hasOwnProperty.call(BUCKETS, v)) throw new QueryError('bucket');
  return BUCKETS[v];
}

module.exports = { BUCKETS, QueryError, list, parseTime, shortString, parseBucket };
