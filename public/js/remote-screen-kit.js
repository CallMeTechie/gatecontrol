/* Shared logic of the screen viewer of gc.remote (stage 5, input stage 6, templates/aurora/pages/remote-screen.njk):
   the gc-screen.v1 client without the DOM — tests require this file.
   Browser: window.GCScreenKit; Node: module.exports. */
(function (root, factory) {
  'use strict';
  var kit = factory();
  if (typeof module === 'object' && module.exports) module.exports = kit;
  else root.GCScreenKit = kit;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL = 'gc-screen.v1';
  var HEADER = 12;
  var CODEC_RE = /^avc1\.[0-9A-Fa-f]{6}$/;
  var ERRORS = ['not_found', 'limit_reached', 'plugin_unavailable', 'unlicensed', 'no_webcodecs', 'codec_unsupported', 'decode_failed', 'replaced'];
  // codes after which a reconnect cannot help — the page shows the error and stops
  var FINAL = ['not_found', 'plugin_unavailable', 'unlicensed', 'role_mismatch', 'codec_unsupported', 'no_webcodecs', 'replaced', 'bad_frame',
    'rate_exceeded', 'ticket_gone'];
  var ENDS = ['sender', 'viewer', 'ended_by_plugin', 'sender_lost', 'viewer_lost', 'max_duration', 'peer_timeout', 'plugin_stopped'];

  /** The i18n key of an error code (unknown → remote.screen.err.failed). */
  function errorKey(code) { return 'remote.screen.err.' + (ERRORS.indexOf(code) >= 0 ? code : 'failed'); }
  function isFinal(code) { return FINAL.indexOf(code) >= 0; }
  /** The i18n key of an end reason (unknown → remote.screen.end.other). */
  function endKey(reason) { return 'remote.screen.end.' + (ENDS.indexOf(reason) >= 0 ? reason : 'other'); }

  /** A server text frame → the message object, or null. */
  function parseFrame(text) {
    var m;
    try { m = JSON.parse(String(text)); } catch (e) { return null; }
    return m && typeof m === 'object' && typeof m.t === 'string' ? m : null;
  }

  /** A binary frame (ArrayBuffer or Uint8Array) → { key, ts (µs, Number), data: Uint8Array } | null */
  function parseMedia(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u.length <= HEADER) return null;
    var dv = new DataView(u.buffer, u.byteOffset, HEADER);
    if (dv.getUint8(0) !== 1) return null;
    return { key: (dv.getUint8(1) & 1) === 1, ts: dv.getUint32(4) * 4294967296 + dv.getUint32(8), data: u.subarray(HEADER) };
  }

  /** {t:'config'} → the VideoDecoder configuration (Annex B: no description) or null. */
  function decoderConfig(m) {
    if (!m || typeof m.codec !== 'string' || !CODEC_RE.test(m.codec)) return null;
    var w = Number(m.width);
    var h = Number(m.height);
    if (!(w > 0 && h > 0)) return null;
    return { codec: m.codec, codedWidth: w, codedHeight: h, optimizeForLatency: true, hardwareAcceleration: 'no-preference' };
  }

  /** The wait before the next attempt (1, 2, 4, 8 s), null after the fourth. */
  function backoff(attempt) {
    return attempt >= 0 && attempt < 4 ? 1000 * Math.pow(2, attempt) : null;
  }

  /** The largest size of a w×h picture that fits into a box (contain). */
  function fit(w, h, boxW, boxH) {
    if (!(w > 0 && h > 0 && boxW > 0 && boxH > 0)) return { width: 0, height: 0 };
    var s = Math.min(boxW / w, boxH / h);
    return { width: Math.floor(w * s), height: Math.floor(h * s) };
  }

  // ─── Stage 6: input in mode control (coordinates 0…1 of the picture) ───

  var TAP_MOVE = 0.012;      // less movement than this (of the picture) is a tap or a long press
  var LONG_MS = 500;
  var MAX_PATH = 32;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function r4(v) { return Math.round(v * 10000) / 10000; }

  /**
   * A point on the element (client coordinates) → { x, y } 0…1 of the picture drawn with object-fit: contain,
   * or null outside of it. `rect` = getBoundingClientRect() of the canvas, w × h = its picture.
   */
  function toUnit(cx, cy, rect, w, h) {
    var f = fit(w, h, rect.width, rect.height);
    if (!(f.width > 0 && f.height > 0)) return null;
    var ox = rect.left + (rect.width - f.width) / 2;
    var oy = rect.top + (rect.height - f.height) / 2;
    var x = (cx - ox) / f.width;
    var y = (cy - oy) / f.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: r4(x), y: r4(y) };
  }

  /** At most `max` points of a path: the first, the last and evenly spread ones between. */
  function thin(pts, max) {
    if (pts.length <= max) return pts.slice();
    var out = [];
    for (var i = 0; i < max; i++) out.push(pts[Math.round(i * (pts.length - 1) / (max - 1))]);
    return out;
  }

  /**
   * A finished pointer gesture ([{ x, y, t }] in 0…1 and ms) → the input frame: tap, long press or a swipe along the
   * path (dragging included). null for nothing usable.
   */
  function gesture(points) {
    if (!points || !points.length) return null;
    var a = points[0];
    var z = points[points.length - 1];
    var ms = Math.max(0, z.t - a.t);
    var far = 0;
    for (var i = 1; i < points.length; i++) far = Math.max(far, Math.hypot(points[i].x - a.x, points[i].y - a.y));
    if (far < TAP_MOVE) {
      if (ms >= LONG_MS) return { t: 'input', k: 'long', x: a.x, y: a.y, ms: clamp(Math.round(ms), 400, 3000) };
      return { t: 'input', k: 'tap', x: a.x, y: a.y };
    }
    var pts = thin(points, MAX_PATH).map(function (p) { return [r4(clamp(p.x, 0, 1)), r4(clamp(p.y, 0, 1))]; });
    return { t: 'input', k: 'swipe', pts: pts, ms: clamp(Math.round(ms), 50, 5000) };
  }

  /** Wheel deltas (pixels) at a point → a scroll frame (a share of the picture, at most a third per frame) or null. */
  function scroll(at, dxPx, dyPx, boxW, boxH) {
    if (!at || !(boxW > 0 && boxH > 0)) return null;
    var dx = r4(clamp(dxPx / boxW, -0.33, 0.33));
    var dy = r4(clamp(dyPx / boxH, -0.33, 0.33));
    if (dx === 0 && dy === 0) return null;
    return { t: 'input', k: 'scroll', x: at.x, y: at.y, dx: dx, dy: dy };
  }

  /** Text typed into the page → a text frame (1…500 characters, no control characters) or null. */
  function textInput(text) {
    var s = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
    var chars = Array.from(s);
    if (!chars.length) return null;
    return { t: 'input', k: 'text', text: chars.slice(0, 500).join('') };
  }

  /** The keys of the bar and the keyboard. */
  var KEYS = ['back', 'home', 'recents', 'enter', 'backspace'];
  function keyInput(key) { return KEYS.indexOf(key) >= 0 ? { t: 'input', k: 'key', key: key } : null; }

  /** The i18n key of a mode reason, a notice or a failed input (unknown → a general one). */
  var MODE_REASONS = ['sender', 'service_off', 'locked', 'sender_no_control', 'app_scope'];
  function modeKey(reason) { return 'remote.screen.mode_view.' + (MODE_REASONS.indexOf(reason) >= 0 ? reason : 'sender'); }
  var FAILS = ['no_field', 'blocked', 'locked', 'secure'];
  function failKey(reason) { return 'remote.screen.fail.' + (FAILS.indexOf(reason) >= 0 ? reason : 'blocked'); }
  var NOTICES = ['view_only', 'input_rate'];
  function noticeKey(code) { return NOTICES.indexOf(code) >= 0 ? 'remote.screen.notice.' + code : null; }

  return { PROTOCOL: PROTOCOL, HEADER: HEADER, errorKey: errorKey, isFinal: isFinal, endKey: endKey, parseFrame: parseFrame, parseMedia: parseMedia,
    decoderConfig: decoderConfig, backoff: backoff, fit: fit, toUnit: toUnit, gesture: gesture, scroll: scroll, textInput: textInput, keyInput: keyInput,
    modeKey: modeKey, failKey: failKey, noticeKey: noticeKey };
}));
