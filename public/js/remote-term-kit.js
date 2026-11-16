/* Shared logic of the SSH terminal page and the recording player of gc.remote (stage 3):
   the gc-term.v1 client and the asciicast v2 reader. No DOM here — tests require this file.
   Browser: window.GCTermKit; Node: module.exports. */
(function (root, factory) {
  'use strict';
  var kit = factory();
  if (typeof module === 'object' && module.exports) module.exports = kit;
  else root.GCTermKit = kit;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL = 'gc-term.v1';
  var ERRORS = ['host_key_mismatch', 'host_key_rejected', 'host_key_unpinned', 'auth_failed', 'key_unreadable', 'unreachable', 'timeout',
    'credential_required', 'credential_unreadable', 'recording_unavailable', 'limit_reached', 'not_found'];
  // codes after which a reconnect cannot help — the page shows the error and stops
  var FINAL = ['host_key_mismatch', 'host_key_rejected', 'host_key_unpinned', 'auth_failed', 'key_unreadable', 'credential_required',
    'credential_unreadable', 'recording_unavailable', 'not_found', 'plugin_unavailable', 'unlicensed'];

  /** The i18n key of an error code (unknown → remote.term.err.failed). */
  function errorKey(code) {
    return 'remote.term.err.' + (ERRORS.indexOf(code) >= 0 ? code : 'failed');
  }
  function isFinal(code) { return FINAL.indexOf(code) >= 0; }

  /** A server text frame → the message object, or null. */
  function parseFrame(text) {
    var m;
    try { m = JSON.parse(String(text)); } catch (e) { return null; }
    return m && typeof m === 'object' && typeof m.t === 'string' ? m : null;
  }

  /** "SHA256:…" as ssh-keygen shows it, from { alg, sha256 }. */
  function fingerprintText(k) {
    if (!k || typeof k.sha256 !== 'string') return '';
    return (typeof k.alg === 'string' ? k.alg + ' ' : '') + 'SHA256:' + k.sha256;
  }

  /** Backoff of the reconnects: 1 s, 2 s, 4 s, 8 s, 15 s; null after the last try. */
  function backoff(attempt) {
    var steps = [1000, 2000, 4000, 8000, 15000];
    return attempt >= 0 && attempt < steps.length ? steps[attempt] : null;
  }

  /**
   * asciicast v2 (one JSON header line, then [time, code, data] lines) →
   * { header: { width, height }, events: [[t, code, data]], duration }. Only codes o and r are kept.
   */
  function parseCast(text) {
    var lines = String(text || '').split('\n');
    var header = null;
    var events = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l) continue;
      var v;
      try { v = JSON.parse(l); } catch (e) { continue; }
      if (!header) {
        if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== 2) return null;
        header = { width: clampInt(v.width, 10, 500, 80), height: clampInt(v.height, 5, 200, 24) };
        continue;
      }
      if (!Array.isArray(v) || v.length < 3 || typeof v[0] !== 'number' || !isFinite(v[0]) || typeof v[2] !== 'string') continue;
      if (v[1] !== 'o' && v[1] !== 'r') continue;
      events.push([Math.max(0, v[0]), v[1], v[2]]);
    }
    if (!header) return null;
    events.sort(function (a, b) { return a[0] - b[0]; });
    return { header: header, events: events, duration: events.length ? events[events.length - 1][0] : 0 };
  }

  function clampInt(v, lo, hi, d) {
    var n = Number(v);
    return isFinite(n) && Math.floor(n) === n ? Math.max(lo, Math.min(hi, n)) : d;
  }

  /** "120x40" of a resize event → { cols, rows } | null */
  function parseSize(s) {
    var m = /^(\d{1,3})x(\d{1,3})$/.exec(String(s));
    return m ? { cols: clampInt(Number(m[1]), 10, 500, 80), rows: clampInt(Number(m[2]), 5, 200, 24) } : null;
  }

  /** Index of the first event after time t (seconds). */
  function indexAt(events, t) {
    var lo = 0;
    var hi = events.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (events[mid][0] <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** "1:05" / "1:02:03" */
  function clock(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
  }

  return { PROTOCOL: PROTOCOL, errorKey: errorKey, isFinal: isFinal, parseFrame: parseFrame, fingerprintText: fingerprintText, backoff: backoff, parseCast: parseCast, parseSize: parseSize, indexAt: indexAt, clock: clock };
}));
