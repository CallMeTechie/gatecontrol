'use strict';

// Minimal semver (2.0.0) for plugin versions and the `gatecontrol` range of
// plugin.json — no dependency. Ranges: comparators (>=, <=, >, <, =), caret
// (^1.2.3), tilde (~1.2.3), x-ranges (1.x, 1.2.*, *), separated by spaces
// (AND) and `||` (OR).

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parse(v) {
  if (typeof v !== 'string' || v.length > 64) return null;
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function valid(v) { return parse(v) !== null; }

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;   // 1.0.0 > 1.0.0-rc
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb) { const d = Number(a[i]) - Number(b[i]); if (d) return d < 0 ? -1 : 1; continue; }
    if (na) return -1;
    if (nb) return 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** -1, 0, 1; throws on an invalid version. */
function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;
  if (!x || !y) throw new Error('invalid version');
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

const PARTIAL_RE = /^(\d{1,9}|[xX*])(?:\.(\d{1,9}|[xX*]))?(?:\.(\d{1,9}|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/;

function partial(s) {
  const m = PARTIAL_RE.exec(s);
  if (!m) return null;
  const wild = (p) => p === undefined || /^[xX*]$/.test(p);
  return {
    major: wild(m[1]) ? null : Number(m[1]),
    minor: wild(m[2]) ? null : Number(m[2]),
    patch: wild(m[3]) ? null : Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

const v = (major, minor, patch, pre) => ({ major, minor, patch, pre: pre || [] });

/** One comparator token → list of [op, version] (all must hold). */
function comparatorSet(tok) {
  if (tok === '*' || tok === '' || /^[xX]$/.test(tok)) return [];
  let m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(tok);
  let op = m[1] || '';
  let rest = m[2];
  if (!op && (rest[0] === '^' || rest[0] === '~')) { op = rest[0]; rest = rest.slice(1); }
  const p = partial(rest);
  if (!p) return null;
  const lo = v(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.pre);
  if (op === '^') {
    if (p.major === null) return [];
    if (p.major > 0 || p.minor === null) return [['>=', lo], ['<', v(p.major + 1, 0, 0)]];
    if (p.minor > 0 || p.patch === null) return [['>=', lo], ['<', v(0, p.minor + 1, 0)]];
    return [['>=', lo], ['<', v(0, 0, p.patch + 1)]];
  }
  if (op === '~') {
    if (p.major === null) return [];
    if (p.minor === null) return [['>=', lo], ['<', v(p.major + 1, 0, 0)]];
    return [['>=', lo], ['<', v(p.major, p.minor + 1, 0)]];
  }
  if (op === '' || op === '=') {
    if (p.major === null) return [];
    if (p.minor === null) return [['>=', lo], ['<', v(p.major + 1, 0, 0)]];
    if (p.patch === null) return [['>=', lo], ['<', v(p.major, p.minor + 1, 0)]];
    return [['=', lo]];
  }
  if (p.major === null) return op === '<' || op === '>' ? null : [];
  if (op === '>') {
    if (p.minor === null) return [['>=', v(p.major + 1, 0, 0)]];
    if (p.patch === null) return [['>=', v(p.major, p.minor + 1, 0)]];
    return [['>', lo]];
  }
  if (op === '<=') {
    if (p.minor === null) return [['<', v(p.major + 1, 0, 0)]];
    if (p.patch === null) return [['<', v(p.major, p.minor + 1, 0)]];
    return [['<=', lo]];
  }
  return [[op, lo]]; // >= and < with partial versions: missing parts are 0
}

/** Parsed range: array of AND-sets, or null when the range is invalid. */
function parseRange(range) {
  if (typeof range !== 'string' || range.length > 200) return null;
  const out = [];
  for (const alt of range.split('||')) {
    // "1.2 - 1.4" hyphen ranges are not supported; ">= 1.2" with a space is.
    const toks = alt.trim().replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const set = [];
    for (const t of toks.length ? toks : ['*']) {
      const c = comparatorSet(t);
      if (c === null) return null;
      set.push(...c);
    }
    out.push(set);
  }
  return out;
}

function validRange(range) { return parseRange(range) !== null; }

function test(op, ver, c) {
  const d = compare(ver, c);
  switch (op) {
    case '>=': return d >= 0;
    case '<=': return d <= 0;
    case '>': return d > 0;
    case '<': return d < 0;
    default: return d === 0;
  }
}

function satisfies(version, range) {
  const ver = parse(version);
  const r = parseRange(range);
  if (!ver || !r) return false;
  return r.some((set) => set.every(([op, c]) => test(op, ver, c)));
}

module.exports = { parse, valid, compare, parseRange, validRange, satisfies };
