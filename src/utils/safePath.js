'use strict';

// Shared validation for post-login redirect targets (admin login returnTo,
// route-auth redirect). Only same-origin absolute paths pass:
//   * must start with exactly one '/' (no protocol-relative '//host'),
//   * no backslash anywhere — browsers treat '/\host' like '//host',
//   * no ASCII control characters or whitespace-like C0/DEL bytes — browsers
//     strip tab/CR/LF from URLs, so '/\t/host' would collapse to '//host'.
// Returns the path unchanged when safe, otherwise null.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function safeLocalPath(v) {
  if (typeof v !== 'string' || v.length === 0) return null;
  if (v[0] !== '/') return null;
  if (v.length > 1 && (v[1] === '/' || v[1] === '\\')) return null;
  if (v.includes('\\')) return null;
  if (CONTROL_CHARS.test(v)) return null;
  return v;
}

module.exports = { safeLocalPath };
