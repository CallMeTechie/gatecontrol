/* The screen viewer of gc.remote (templates/aurora/pages/remote-screen.njk, stage 5): the WebSocket
   /api/v1/remote/screen-relay, protocol gc-screen.v1 (services/remote/screen.js). The phone sends H.264
   (Annex B, SPS/PPS before every key frame); the browser decodes it with WebCodecs onto a canvas — nothing
   is transcoded anywhere. A lost connection reconnects.
   Stage 6: while the relay says mode control (the person at the phone allowed it, the phone can do it), mouse,
   touch and keyboard on the picture go to the phone as {t:'input'} — click = tap, hold = long press, drag =
   swipe, wheel = scroll, right button = back, typing = text into the field selected on the phone — and the
   toolbar shows „Du steuerst“. The phone can go down to view at any time; then input stops at once.
   Stage 7: a Windows PC (the relay says input 'desktop'): the mouse moves, its buttons and wheel and the physical keys
   go as they are (move, button, wheel, kbd) — shortcuts included —, pasting is text; every key and button still held
   is let go when control ends, the window loses the focus or the session ends. With more than one display the
   toolbar offers the choice. */
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
  var mode = 'view';
  var toastTimer = null;
  // stage 7: what sends (a PC takes mouse and keyboard), the keys and buttons held now
  var sender = K.senderInfo(null);
  var desk = false;
  var held = { keys: new Set(), buttons: new Set(), at: null };

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

  // ─── Stage 6: control ───

  function toast(text) {
    var el = $('rscreen-toast');
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
    clearTimeout(toastTimer);
    if (text) toastTimer = setTimeout(function () { el.style.display = 'none'; }, 4000);
  }

  function setMode(m, reason, announce) {
    var was = mode;
    mode = m === 'control' ? 'control' : 'view';
    var on = mode === 'control';
    $('rscreen-control').style.display = on ? 'inline-flex' : 'none';
    $('rscreen-keys').style.display = on ? 'inline-flex' : 'none';
    canvas.classList.toggle('rscreen-canvas--control', on);
    if (!on) { releaseHeld(true); showText(false); pointer = null; }
    note(on ? '' : T('view_only'));
    if (!on && (announce || was === 'control') && reason && reason !== 'viewer_only') toast(T(K.modeKey(reason)));
  }

  function input(frame) { if (mode === 'control' && frame) sendJson(frame); }

  // ─── Stage 7: a PC ───

  /** Let go of every key and button held (also after control ended: a release is always safe). */
  function releaseHeld(force) {
    K.releaseAll(Array.from(held.keys), Array.from(held.buttons), held.at).forEach(function (f) { if (force || mode === 'control') sendJson(f); });
    held.keys.clear();
    held.buttons.clear();
  }

  /** The relay told what sends: a PC gets mouse and keyboard, the phone keys go, the display choice shows. */
  function setSender(m) {
    sender = K.senderInfo(m);
    var was = desk;
    desk = sender.input === 'desktop';
    if (was && !desk) releaseHeld(true);
    canvas.classList.toggle('rscreen-canvas--desktop', desk);
    ['rscreen-key-back', 'rscreen-key-home', 'rscreen-key-recents'].forEach(function (id) { $(id).style.display = desk ? 'none' : ''; });
    $('rscreen-control').title = desk ? T('control_hint_desktop') : T('control_hint');
    var sel = $('rscreen-display-select');
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    sender.displays.forEach(function (d, n) {
      var o = document.createElement('option');
      o.value = String(d.i);
      o.textContent = T('display_n').replace('%s', String(n + 1)) + (d.primary ? ' · ' + T('display_primary') : '') + ' · ' + d.w + '×' + d.h;
      sel.appendChild(o);
    });
    sel.value = sender.display == null ? '' : String(sender.display);
    $('rscreen-display').style.display = sender.displays.length > 1 ? 'inline-flex' : 'none';
  }
  $('rscreen-display-select').addEventListener('change', function () {
    var i = Number($('rscreen-display-select').value);
    if (Number.isInteger(i)) { releaseHeld(false); sendJson({ t: 'display', i: i }); }
  });

  var lastMove = 0;
  canvas.addEventListener('pointermove', function (ev) {
    if (!desk || mode !== 'control') return;
    // about 20 moves a second, 30 while a button is held (dragging)
    if (ev.timeStamp - lastMove < (held.buttons.size ? 33 : 50)) return;
    var u = unitOf(ev);
    if (!u) return;
    lastMove = ev.timeStamp;
    held.at = u;
    input(K.moveInput(u));
  });
  canvas.addEventListener('pointerdown', function (ev) {
    if (!desk || mode !== 'control') return;
    ev.preventDefault();
    canvas.focus();
    var b = K.buttonName(ev.button);
    var u = unitOf(ev);
    if (!b || !u) return;
    held.at = u;
    held.buttons.add(b);
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* gone */ }
    input(K.buttonInput(b, true, u));
  });
  function deskUp(ev) {
    if (!desk) return;
    var b = K.buttonName(ev.button);
    if (!b || !held.buttons.has(b)) return;
    held.buttons.delete(b);
    var u = unitOf(ev) || held.at;
    if (u) { held.at = u; sendJson(K.buttonInput(b, false, u)); }
  }
  canvas.addEventListener('pointerup', deskUp);
  canvas.addEventListener('pointercancel', function () { if (desk) releaseHeld(true); });

  var deskWheel = null;
  canvas.addEventListener('wheel', function (ev) {
    if (!desk || mode !== 'control') return;
    ev.preventDefault();
    var u = unitOf(ev);
    if (!u) return;
    var px = ev.deltaMode === 1 ? 40 : (ev.deltaMode === 2 ? canvas.getBoundingClientRect().height : 1);
    if (!deskWheel) {
      deskWheel = { at: u, dx: 0, dy: 0 };
      setTimeout(function () { var w = deskWheel; deskWheel = null; input(K.wheelInput(w.at, w.dx, w.dy)); }, 50);
    }
    deskWheel.dx += ev.deltaX * px;
    deskWheel.dy += ev.deltaY * px;
  }, { passive: false });

  canvas.addEventListener('keydown', function (ev) {
    if (!desk || mode !== 'control') return;
    var f = K.kbdInput(ev.code, true);
    if (!f) return;
    ev.preventDefault();
    if (held.keys.size >= 16 && !held.keys.has(ev.code)) return;
    held.keys.add(ev.code);
    input(f);
  });
  canvas.addEventListener('keyup', function (ev) {
    if (!desk || !held.keys.has(ev.code)) return;
    ev.preventDefault();
    held.keys.delete(ev.code);
    sendJson(K.kbdInput(ev.code, false));
  });
  // the window loses the keyboard (Alt+Tab of the helper, another tab): nothing stays pressed on the PC
  canvas.addEventListener('blur', function () { if (desk) releaseHeld(true); });
  document.addEventListener('visibilitychange', function () { if (desk && document.hidden) releaseHeld(true); });

  var pointer = null;
  function unitOf(ev) { return K.toUnit(ev.clientX, ev.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height); }

  canvas.addEventListener('pointerdown', function (ev) {
    if (mode !== 'control' || desk) return;
    ev.preventDefault();
    canvas.focus();
    if (ev.button === 2) { input(K.keyInput('back')); return; }
    if (ev.button !== 0) return;
    var u = unitOf(ev);
    if (!u) return;
    pointer = { id: ev.pointerId, pts: [{ x: u.x, y: u.y, t: ev.timeStamp }], last: ev.timeStamp };
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* gone */ }
  });
  canvas.addEventListener('pointermove', function (ev) {
    if (!pointer || ev.pointerId !== pointer.id || ev.timeStamp - pointer.last < 16) return;
    var r = canvas.getBoundingClientRect();
    var f = K.fit(canvas.width, canvas.height, r.width, r.height);
    // keep moving at the edge of the picture: clamp instead of dropping the point
    var x = Math.min(r.left + (r.width + f.width) / 2, Math.max(r.left + (r.width - f.width) / 2, ev.clientX));
    var y = Math.min(r.top + (r.height + f.height) / 2, Math.max(r.top + (r.height - f.height) / 2, ev.clientY));
    var u = K.toUnit(x, y, r, canvas.width, canvas.height);
    if (!u) return;
    pointer.last = ev.timeStamp;
    if (pointer.pts.length < 400) pointer.pts.push({ x: u.x, y: u.y, t: ev.timeStamp });
  });
  function pointerEnd(ev) {
    if (!pointer || ev.pointerId !== pointer.id) return;
    var p = pointer;
    pointer = null;
    var u = unitOf(ev);
    if (u) p.pts.push({ x: u.x, y: u.y, t: ev.timeStamp });
    else p.pts.push({ x: p.pts[p.pts.length - 1].x, y: p.pts[p.pts.length - 1].y, t: ev.timeStamp });
    if (ev.type === 'pointerup') input(K.gesture(p.pts));
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);
  canvas.addEventListener('contextmenu', function (ev) { if (mode === 'control') ev.preventDefault(); });

  var wheel = null;
  canvas.addEventListener('wheel', function (ev) {
    if (mode !== 'control' || desk) return;
    ev.preventDefault();
    var u = unitOf(ev);
    if (!u) return;
    var px = ev.deltaMode === 1 ? 40 : (ev.deltaMode === 2 ? canvas.getBoundingClientRect().height : 1);
    if (!wheel) {
      wheel = { at: u, dx: 0, dy: 0 };
      setTimeout(function () {
        var w = wheel;
        wheel = null;
        var r = canvas.getBoundingClientRect();
        input(K.scroll(w.at, w.dx, w.dy, r.width, r.height));
      }, 120);
    }
    wheel.dx += ev.deltaX * px;
    wheel.dy += ev.deltaY * px;
  }, { passive: false });

  // typing on the picture: text into the field selected on the phone (gathered for a moment), Enter and Backspace as keys
  var typed = '';
  var typedTimer = null;
  function flushTyped() { clearTimeout(typedTimer); if (typed) input(K.textInput(typed)); typed = ''; }
  canvas.addEventListener('keydown', function (ev) {
    if (mode !== 'control' || desk || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Enter' || ev.key === 'Backspace') { ev.preventDefault(); flushTyped(); input(K.keyInput(ev.key === 'Enter' ? 'enter' : 'backspace')); return; }
    if (ev.key && Array.from(ev.key).length === 1) {
      ev.preventDefault();
      typed += ev.key;
      clearTimeout(typedTimer);
      if (Array.from(typed).length >= 200) flushTyped(); else typedTimer = setTimeout(flushTyped, 300);
    }
  });
  canvas.addEventListener('paste', function (ev) {
    if (mode !== 'control') return;
    ev.preventDefault();
    flushTyped();
    input(K.textInput(ev.clipboardData ? ev.clipboardData.getData('text') : ''));
  });

  function showText(on) {
    $('rscreen-textbar').style.display = on ? 'flex' : 'none';
    if (on) $('rscreen-text').focus(); else $('rscreen-text').value = '';
  }
  [['rscreen-key-back', 'back'], ['rscreen-key-home', 'home'], ['rscreen-key-recents', 'recents']].forEach(function (b) {
    $(b[0]).addEventListener('click', function () { input(K.keyInput(b[1])); });
  });
  $('rscreen-key-text').addEventListener('click', function () { showText($('rscreen-textbar').style.display !== 'flex'); });
  $('rscreen-textbar').addEventListener('submit', function (ev) {
    ev.preventDefault();
    input(K.textInput($('rscreen-text').value));
    $('rscreen-text').value = '';
  });
  $('rscreen-text-close').addEventListener('click', function () { showText(false); });

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
          if (m.sender) setSender(m.sender);
          setMode(m.mode, m.modeReason, false);
        } else if (m.t === 'sender') {
          setSender(m);
        } else if (m.t === 'waiting') {
          veil(m.reason === 'sender_lost' ? T('sender_lost') : T('waiting'));
        } else if (m.t === 'config') {
          veil(null);
          configure(m);
        } else if (m.t === 'state') {
          if (m.paused && desk) releaseHeld(true);
          veil(m.paused ? T(m.reason === 'secure' && desk ? 'paused_secure' : 'paused') : null);
        } else if (m.t === 'mode') {
          setMode(m.mode, m.reason, true);
        } else if (m.t === 'input_fail') {
          toast(T(K.failKey(m.reason)));
        } else if (m.t === 'notice') {
          if (K.noticeKey(m.code)) toast(T(K.noticeKey(m.code)));
        } else if (m.t === 'end') {
          ended = true;
          stopped = true;
          setMode('view');
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
        // the PC lets go of everything itself when the viewer is gone
        held.keys.clear();
        held.buttons.clear();
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
    releaseHeld(true);
    stopped = true;
    clearTimeout(retryTimer);
    if (ws && ws.readyState === 1) sendJson({ t: 'bye' }); else state('disconnected');
  });
  window.addEventListener('beforeunload', function () { releaseHeld(true); stopped = true; if (ws) { try { ws.close(); } catch (e) { /* closed */ } } });

  veil(T('waiting'));
  connect();
})();
