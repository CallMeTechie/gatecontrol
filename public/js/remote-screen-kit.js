/* Shared logic of the screen viewer of gc.remote (stage 5, templates/aurora/pages/remote-screen.njk):
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

  return { PROTOCOL: PROTOCOL, HEADER: HEADER, errorKey: errorKey, isFinal: isFinal, endKey: endKey, parseFrame: parseFrame, parseMedia: parseMedia,
    decoderConfig: decoderConfig, backoff: backoff, fit: fit };
}));
