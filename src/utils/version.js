'use strict';

// Numeric semver compare. Strips a leading "v" and any "-prerelease" suffix.
// Returns 1 if a>b, -1 if a<b, 0 if equal OR either side is unparseable
// (callers treat 0 as "no drift badge").
function compareVersions(a, b) {
  const parse = (v) => String(v == null ? '' : v).trim().replace(/^v/i, '').split('-')[0].split('.');
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i] ?? '0', 10);
    const y = parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// Full semver order, pre-releases included: 1.2.3-beta.1 < 1.2.3-beta.2 < 1.2.3
// (a release is newer than its own pre-releases; build metadata "+…" is ignored).
// Accepts a leading "v". Returns 1 / -1 / 0, or null when either side is not x.y.z.
const SEMVER_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;
function parseSemver(v) {
  const m = typeof v === 'string' ? SEMVER_RE.exec(v.trim()) : null;
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null } : null;
}
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  if (!pa.pre || !pb.pre) return pa.pre ? -1 : (pb.pre ? 1 : 0);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer identifiers = older
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1; continue; }
    if (nx !== ny) return nx ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

module.exports = { compareVersions, compareSemver, parseSemver };
