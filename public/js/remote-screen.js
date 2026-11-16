/* The screen viewer of gc.remote (templates/aurora/pages/remote-screen.njk, stage 5): the WebSocket
   /api/v1/remote/screen-relay, protocol gc-screen.v1 (services/remote/screen.js). The phone sends H.264
   (Annex B, SPS/PPS before every key frame); the browser decodes it with WebCodecs onto a canvas — nothing
   is transcoded anywhere. Only watching: no input goes to the phone. A lost connection reconnects. */
(function () {
  'use strict';
  var K = window.GCScreenKit;
  var cfg = JSON.parse(document.getElementById('rscreen-cfg').textContent);
  var i18n = JSON.parse(document.getElementById('rscreen-i18n').textContent);
  var ref = typeof cfg.ref === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cfg.ref) ? cfg.ref : null;
  var $ = function (id) { return document.getElementById(id); };
  var texts = new Map(Object.entries(i18n).map(function (e) { return [e[0], String(e[1])]; }));
  var T = function (k) { return texts.has(k) ? texts.get(k) : k; };
  var canvas = $('rscreen-canvas');
  var ctx = canvas.getContext('2d');

  var PILL = new Map([['connecting', 'rdp-pill--connecting'], ['connected', 'rdp-pill--connected'], ['reconnecting', 'rdp-pill--reconnect'],
    ['disconnected', 'rdp-pill--disconnect'], ['error', 'rdp-pill--error']]);
  function state(s, text) {
    $('rscreen-pill').className = 'rdp-pill ' + (PILL.get(s) || PILL.get('disconnected'));
    $('rscreen-status').textContent = text || T(s);
    $('rscreen-pill-dot').className = s === 'reconnecting' ? 'rdp-spin' : 'rdp-dot';
  }
  function show(id, on) { $(id).style.display = on ? 'flex' : 'none'; }
  function note(text) { $('rscreen-note').textContent = text || ''; $('rscreen-note').title = text || ''; }
  function veil(text) { $('rscreen-wait-text').textContent = text || ''; show('rscreen-wait', !!text); }

  var ws = null;
  var attempt = 0;
  var stopped = false;
  var ended = false;
  var retryTimer = null;
  var pingTimer = null;
  var decoder = null;
  var configured = null;
  var needKey = true;

  function fail(code) {
    stopped = true;
    clearTimeout(retryTimer);
    show('rscreen-reconnect', false);
    veil(null);
    state('error');
    $('rscreen-error-cause').textContent = code || 'failed';
    $('rscreen-error-text').textContent = T(K.errorKey(code));
    show('rscreen-error', true);
  }

  function sendJson(o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) { /* closed */ } }

  function closeDecoder() {
    if (decoder) { try { decoder.close(); } catch (e) { /* closed */ } }
    decoder = null;
    configured = null;
    needKey = true;
  }

  function draw(frame) {
    try {
      var w = frame.displayWidth;
      var h = frame.displayHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(frame, 0, 0, w, h);
    } finally { frame.close(); }
  }

  function configure(m) {
    var c = K.decoderConfig(m);
    if (!c) return;
    var key = c.codec + ' ' + c.codedWidth + 'x' + c.codedHeight;
    if (configured === key && decoder && decoder.state === 'configured') { needKey = true; return; }
    closeDecoder();
    decoder = new window.VideoDecoder({
      output: draw,
      error: function () { closeDecoder(); sendJson({ t: 'keyframe' }); },
    });
    var go = function () {
      try { decoder.configure(c); configured = key; needKey = true; } catch (e) { fail('codec_unsupported'); }
    };
    if (window.VideoDecoder.isConfigSupported) {
      window.VideoDecoder.isConfigSupported(c).then(function (r) { if (r && r.supported) go(); else fail('codec_unsupported'); }, go);
    } else go();
  }

  function frame(buf) {
    var f = K.parseMedia(buf);
    if (!f || !decoder || decoder.state !== 'configured') return;
    if (needKey && !f.key) return;
    needKey = false;
    // a decoder that falls behind: drop until the next key frame and ask for one
    if (decoder.decodeQueueSize > 30 && !f.key) { needKey = true; sendJson({ t: 'keyframe' }); return; }
    try {
      decoder.decode(new window.EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.ts, data: f.data }));
    } catch (e) { needKey = true; sendJson({ t: 'keyframe' }); }
  }

  function mint() {
    return fetch('/remote/session/' + ref + '/token', { method: 'POST', headers: { 'X-CSRF-Token': cfg.csrf }, credentials: 'same-origin' })
      .then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok || !b.ok) { var e = new Error(b.error || 'mint failed'); e.code = b.error || (r.status === 429 ? 'limit_reached' : 'failed'); e.status = r.status; throw e; }
          return b;
        });
      });
  }

  function retry() {
    var wait = K.backoff(attempt++);
    if (wait == null) { fail('failed'); return; }
    state('reconnecting');
    show('rscreen-reconnect', true);
    retryTimer = setTimeout(connect, wait);
  }

  function connect() {
    if (!ref) { fail('not_found'); return; }
    if (typeof window.VideoDecoder !== 'function' || typeof window.EncodedVideoChunk !== 'function') { fail('no_webcodecs'); return; }
    stopped = false;
    show('rscreen-error', false);
    state(attempt ? 'reconnecting' : 'connecting');
    mint().then(function (tk) {
      if (stopped) return;
      var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + tk.wsPath;
      ws = new WebSocket(url, [K.PROTOCOL, 'token.' + tk.token]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () {
        sendJson({ t: 'hello', role: 'viewer', codecs: ['avc1'] });
        clearInterval(pingTimer);
        pingTimer = setInterval(function () { sendJson({ t: 'ping' }); }, 25000);
      };
      ws.onmessage = function (ev) {
        if (typeof ev.data !== 'string') { frame(ev.data); return; }
        var m = K.parseFrame(ev.data);
        if (!m) return;
        if (m.t === 'ready') {
          attempt = 0;
          show('rscreen-reconnect', false);
          state('connected');
          note(T('view_only'));
        } else if (m.t === 'waiting') {
          veil(m.reason === 'sender_lost' ? T('sender_lost') : T('waiting'));
        } else if (m.t === 'config') {
          veil(null);
          configure(m);
        } else if (m.t === 'state') {
          veil(m.paused ? T('paused') : null);
        } else if (m.t === 'end') {
          ended = true;
          stopped = true;
          closeDecoder();
          veil(null);
          state('disconnected', T('ended'));
          $('rscreen-end-text').textContent = T(K.endKey(m.reason));
          show('rscreen-end', true);
        } else if (m.t === 'error') {
          if (K.isFinal(m.code)) fail(m.code);
          else $('rscreen-reconnect-sub').textContent = m.code;
        }
      };
      ws.onclose = function () {
        clearInterval(pingTimer);
        ws = null;
        if (stopped || ended) return;
        closeDecoder();
        retry();
      };
    }).catch(function (e) {
      if (K.isFinal(e.code) || e.status === 404 || e.status === 403) { fail(e.code); return; }
      retry();
    });
  }

  $('rscreen-retry').addEventListener('click', function () { attempt = 0; connect(); });
  /* fixed addresses only — never one taken from the page */
  $('rscreen-back').addEventListener('click', function () { location.href = '/portal'; });
  $('rscreen-end-back').addEventListener('click', function () { location.href = '/portal'; });
  $('rscreen-btn-fullscreen').addEventListener('click', function () {
    var el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen();
  });
  $('rscreen-btn-disconnect').addEventListener('click', function () {
    stopped = true;
    clearTimeout(retryTimer);
    if (ws && ws.readyState === 1) sendJson({ t: 'bye' }); else state('disconnected');
  });
  window.addEventListener('beforeunload', function () { stopped = true; if (ws) { try { ws.close(); } catch (e) { /* closed */ } } });

  veil(T('waiting'));
  connect();
})();
