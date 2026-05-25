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

module.exports = { compareVersions };
