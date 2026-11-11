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

  // "Alle Versionen" opens with the newest ones; the rest folds behind "Ältere anzeigen".
  const VERSIONS_FIRST = 5;

  /**
   * How many rows of the list (newest first) show at once: the newest `limit`
   * — and, when the gateway runs an older version of the list, everything
   * down to it, so what an update brings ("Neuer") and "Installiert" never
   * hide. A single row left over is shown too (a fold for one row is no gain).
   * @param {{version:string}[]} versions newest first
   */
  function visibleCount(versions, installed, limit) {
    const list = Array.isArray(versions) ? versions : [];
    const max = limit > 0 ? limit : VERSIONS_FIRST;
    const i = cleanVersion(installed);
    const at = i ? list.findIndex((v) => v && v.version === i) : -1;
    const n = Math.max(max, at + 1);
    return list.length - n <= 1 ? list.length : n;
  }

  /**
   * The handbook address of a help topic (public/js/handbook.js TOPICS) inside
   * the app: #gw/<id>/handbook/<anchor>. `anchors` maps topic → heading of the
   * in-app handbook (the page's island #gw-handbook-topics, made by
   * services/gatewayHandbook.js topicAnchors); '' is its first page.
   * null: the topic is not part of it (or no gateway) — the caller links to the guide outside.
   */
  function topicHash(id, topic, anchors) {
    if (id == null || id === '' || !anchors || typeof anchors !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(anchors, topic)) return null;
    const a = anchors[topic];
    if (a !== '' && !(typeof a === 'string' && SLUG_RE.test(a))) return null;
    return handbookHash(id, a);
  }

  return { VERSION_RE, SLUG_RE, VERSIONS_FIRST, parseHash, versionsHash, handbookHash, topicHash, cleanVersion, compare, stateOf, summary, visibleCount };
});
