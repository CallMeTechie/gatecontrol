'use strict';

// Pure rules of "Versionen" and "Handbuch" of a gateway (no DOM) —
// public/js/gateway-docs.js uses them in the browser, tests/gateway_docs.test.js
// in node. Addresses: #gw/<id>/versions, #gw/<id>/handbook and
// #gw/<id>/handbook/<anchor> (a heading of the handbook).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayDocsKit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

  /** "#gw/7/versions" → { id: '7', view: 'versions' }, "#gw/7/handbook/x" → { id, view: 'handbook', target: 'x' }; else null. */
  function parseHash(hash) {
    const m = /^#gw\/([^/?#]+)\/(versions|handbook)(?:\/([^/?#]*))?$/.exec(String(hash || ''));
    if (!m) return null;
    let id;
    try { id = decodeURIComponent(m[1]); } catch (_) { return null; }
    if (m[2] === 'versions') return m[3] === undefined ? { id, view: 'versions', target: null } : null;
    const x = m[3] || '';
    return { id, view: 'handbook', target: SLUG_RE.test(x) ? x : null };
  }

  function base(id) { return '#gw/' + encodeURIComponent(String(id)); }
  function versionsHash(id) { return base(id) + '/versions'; }
  function handbookHash(id, anchor) { return base(id) + '/handbook' + (anchor && SLUG_RE.test(anchor) ? '/' + anchor : ''); }

  /** "v1.34.0" / "1.34.0" → "1.34.0"; anything else → null. */
  function cleanVersion(v) {
    const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
    return VERSION_RE.test(s) ? s : null;
  }

  /** Numeric compare of X.Y.Z: < 0, 0, > 0. */
  function compare(a, b) {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /**
   * How a version relates to the one the gateway runs: 'installed' (it runs
   * it), 'newer' (an update brings it), 'older', or 'unknown' (no version).
   */
  function stateOf(version, installed) {
    const i = cleanVersion(installed);
    if (!i || !cleanVersion(version)) return 'unknown';
    const c = compare(version, i);
    return c === 0 ? 'installed' : (c > 0 ? 'newer' : 'older');
  }

  /**
   * The facts of the head of "Versionen": the installed version, how many listed
   * versions are newer, whether the installed one is in the list at all.
   * @param {{version:string}[]} versions newest first
   */
  function summary(versions, installed) {
    const list = Array.isArray(versions) ? versions : [];
    const i = cleanVersion(installed);
    const newer = i ? list.filter((v) => stateOf(v.version, i) === 'newer').length : 0;
    const listed = !!i && list.some((v) => v.version === i);
    return { installed: i, newer, listed };
  }

  return { VERSION_RE, SLUG_RE, parseHash, versionsHash, handbookHash, cleanVersion, compare, stateOf, summary };
});
