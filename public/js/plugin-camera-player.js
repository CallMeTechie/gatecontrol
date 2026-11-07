/* GateControl — live player for the cameras in the home network (plugin frames with permissions.cameras).
 *
 * Served to plugin frames as /plugins/_shared/camera-player/camera-player.js (routes/plugins.js, the frame CSP
 * allows exactly this script, connect-src and media-src <origin>/camera-media/ and blob:). The live answer of
 * gc.cameras.live (services/homeCameras.js) carries `hls` (fMP4 HLS), `mp4` (the same ring as one continuous
 * fragmented MP4) and `codec` (the browser codec string of the stream).
 *
 *   const p = GCCameraPlayer.play(video, live, { onError, onPlaying });   // → { mode, stop() }
 *
 *   mode 'hls'  the browser plays HLS itself (Safari, iOS, Android WebView)
 *   mode 'mse'  Media Source Extensions: live.mp4 fetched as a stream and appended (Firefox, Chrome and Edge on
 *               the PC — they have no HLS of their own); the buffer is trimmed to the last 30 s and playback
 *               stays near the live edge; a stream that ends (the gateway closes it after a few minutes) is
 *               fetched again in "sequence" mode while the token is valid
 *   mode 'mp4'  neither: <video src=live.mp4> (plays where fMP4 progressive works); also the fallback when
 *               MSE refuses the stream — only when that fails too, onError tells the caller (stills)
 *
 * No library, no CDN. The token in the URL is the permission (no cookie: the frame has an opaque origin, the
 * server answers Access-Control-Allow-Origin: *).
 */
(function (root) {
  'use strict';

  var HLS = 'application/vnd.apple.mpegurl';
  var DEFAULT_CODEC = 'avc1.640028';
  var KEEP_S = 30;
  var MAX_BUFFER_S = 60;
  var BEHIND_S = 4;
  var RETRIES = 3;

  /** The MIME type for MediaSource: the codec string of the live answer (only plain codec characters). */
  function mimeOf(codec) {
    var c = typeof codec === 'string' && /^[A-Za-z0-9., ]{1,80}$/.test(codec) ? codec.replace(/\s+/g, '') : DEFAULT_CODEC;
    return 'video/mp4; codecs="' + c + '"';
  }

  /** Which way plays this answer in this browser (pure, for the tests): 'hls' | 'mse' | 'mp4' | null. */
  function choose(env, live) {
    if (!live || live.mode !== 'live') return null;
    if (live.hls && env.canPlayHls) return 'hls';
    if (live.mp4 && env.mse && env.fetchStreams && env.isTypeSupported(mimeOf(live.codec))) return 'mse';
    if (live.mp4) return 'mp4';
    return live.hls ? 'hls' : null;
  }

  function envOf(video) {
    var MS = root.MediaSource || root.ManagedMediaSource;
    return {
      canPlayHls: !!(video && video.canPlayType && video.canPlayType(HLS)),
      mse: !!MS,
      fetchStreams: typeof root.fetch === 'function' && typeof root.ReadableStream === 'function',
      isTypeSupported: function (m) { try { return !!(MS && MS.isTypeSupported(m)); } catch (e) { return false; } },
    };
  }

  function playMse(video, live, opts) {
    var MS = root.MediaSource || root.ManagedMediaSource;
    var ms = new MS();
    var url = URL.createObjectURL(ms);
    var stopped = false;
    var ctrl = null;
    var sb = null;
    var queue = [];
    var tries = 0;
    var playingSent = false;

    function fail(e) {
      if (stopped) return;
      stop();
      if (opts.onError) opts.onError(e || new Error('mse'));
    }

    function edge() {
      if (!sb || sb.updating || !sb.buffered.length) return;
      var end = sb.buffered.end(sb.buffered.length - 1);
      var start = sb.buffered.start(0);
      // stay near the live edge (a tab in the background falls behind)
      if (!video.paused && end - video.currentTime > BEHIND_S) video.currentTime = Math.max(start, end - 1);
      if (video.paused && video.currentTime < start) video.currentTime = start;
      if (end - start > MAX_BUFFER_S && video.currentTime - start > KEEP_S) {
        try { sb.remove(start, Math.min(video.currentTime, end) - KEEP_S); } catch (e) { /* next round */ }
      }
    }

    function pump() {
      if (stopped || !sb || sb.updating || !queue.length) return;
      try { sb.appendBuffer(queue.shift()); } catch (e) {
        // QuotaExceeded: drop the oldest part and try again with the next chunk
        if (e && e.name === 'QuotaExceededError' && sb.buffered.length) {
          try { sb.remove(sb.buffered.start(0), Math.max(sb.buffered.start(0) + 1, video.currentTime - 5)); } catch (e2) { fail(e2); }
        } else fail(e);
      }
    }

    function read() {
      if (stopped) return;
      ctrl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      root.fetch(live.mp4, { cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
        if (!res.ok || !res.body) throw new Error('http ' + res.status);
        var reader = res.body.getReader();
        function step() {
          return reader.read().then(function (r) {
            if (stopped) return null;
            if (r.done) {
              // the gateway ends the stream after a few minutes: fetch it again while the token holds
              tries = 0;
              if (live.expiresAt && Date.parse(live.expiresAt) - Date.now() < 15000) { if (opts.onEnded) opts.onEnded(); return null; }
              read();
              return null;
            }
            tries = 0;
            queue.push(r.value);
            pump();
            return step();
          });
        }
        return step();
      }).catch(function (e) {
        if (stopped || (e && e.name === 'AbortError')) return;
        tries += 1;
        if (tries > RETRIES) { fail(e); return; }
        setTimeout(read, 1000 * tries);
      });
    }

    ms.addEventListener('sourceopen', function () {
      if (stopped) return;
      try {
        sb = ms.addSourceBuffer(mimeOf(live.codec));
        // every new stream starts at 0: append it after the one before
        try { sb.mode = 'sequence'; } catch (e) { /* older browsers: segments */ }
      } catch (e) { fail(e); return; }
      sb.addEventListener('updateend', function () { edge(); pump(); });
      sb.addEventListener('error', function () { fail(new Error('sourcebuffer')); });
      read();
    }, { once: true });

    function onPlaying() { if (!playingSent && opts.onPlaying) { playingSent = true; opts.onPlaying(); } }
    video.addEventListener('playing', onPlaying);
    video.src = url;
    var p = video.play && video.play();
    if (p && p.catch) p.catch(function () { /* autoplay needs muted; the caller sets it */ });

    function stop() {
      if (stopped) return;
      stopped = true;
      video.removeEventListener('playing', onPlaying);
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* gone */ } }
      try { if (ms.readyState === 'open') ms.endOfStream(); } catch (e) { /* closed */ }
      try { video.removeAttribute('src'); video.load(); } catch (e) { /* detached */ }
      URL.revokeObjectURL(url);
    }
    return { mode: 'mse', stop: stop };
  }

  function playSrc(video, src, mode, opts) {
    var stopped = false;
    function onErr() { if (!stopped && opts.onError) opts.onError(new Error(mode)); }
    function onPlaying() { if (!stopped && opts.onPlaying) opts.onPlaying(); }
    video.addEventListener('error', onErr);
    video.addEventListener('playing', onPlaying, { once: true });
    video.src = src;
    var p = video.play && video.play();
    if (p && p.catch) p.catch(function () { /* autoplay needs muted */ });
    return {
      mode: mode,
      stop: function () {
        if (stopped) return;
        stopped = true;
        video.removeEventListener('error', onErr);
        video.removeEventListener('playing', onPlaying);
        try { video.removeAttribute('src'); video.load(); } catch (e) { /* detached */ }
      },
    };
  }

  /** Play the live answer in <video>; → { mode, stop } or null (nothing to play). */
  function play(video, live, opts) {
    var o = opts || {};
    var mode = choose(envOf(video), live);
    if (mode === 'mse') {
      // MSE refused the stream (an unexpected codec, an append error): the plain <video src=live.mp4> next —
      // only when that fails as well does the caller hear onError (and shows stills)
      var h = { mode: 'mse', stop: null };
      var inner = null;
      var toMp4 = function () { h.mode = 'mp4'; inner = playSrc(video, live.mp4, 'mp4', o); };
      try { inner = playMse(video, live, { onPlaying: o.onPlaying, onEnded: o.onEnded, onError: toMp4 }); } catch (e) { toMp4(); }
      h.stop = function () { if (inner) inner.stop(); };
      return h;
    }
    if (mode === 'hls') return playSrc(video, live.hls, 'hls', o);
    if (mode === 'mp4') return playSrc(video, live.mp4, 'mp4', o);
    return null;
  }

  var api = { play: play, choose: choose, mimeOf: mimeOf, version: 1 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GCCameraPlayer = api;
})(typeof self !== 'undefined' ? self : this);
