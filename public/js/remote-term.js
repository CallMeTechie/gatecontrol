/* The SSH terminal page of gc.remote (templates/aurora/pages/remote-term.njk, stage 3):
   xterm.js on the WebSocket /api/v1/remote/ssh-tunnel, protocol gc-term.v1 (services/remote/term.js).
   A recorded session shows its hint first and a red dot while it runs; the first connection to a
   device asks for the host key; a lost connection reconnects (tmux keeps the session on the device). */
(function () {
  'use strict';
  var K = window.GCTermKit;
  var cfg = JSON.parse(document.getElementById('rterm-cfg').textContent);
  var i18n = JSON.parse(document.getElementById('rterm-i18n').textContent);
  var ref = typeof cfg.ref === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cfg.ref) ? cfg.ref : null;
  var view = cfg.mode === 'view';
  var $ = function (id) { return document.getElementById(id); };
  var T = function (k) { return i18n[k] != null ? String(i18n[k]) : k; };

  var term = new window.Terminal({
    cursorBlink: !view, disableStdin: view, scrollback: 5000, convertEol: false, allowProposedApi: false,
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 14,
    theme: { background: '#0d1117', foreground: '#d7dde4', cursor: '#6ee7b7' },
  });
  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('rterm-host'));
  try { fit.fit(); } catch (e) { /* hidden */ }

  var PILL = { connecting: 'rdp-pill--connecting', connected: 'rdp-pill--connected', reconnecting: 'rdp-pill--reconnect', disconnected: 'rdp-pill--disconnect', error: 'rdp-pill--error' };
  function state(s, text) {
    $('rterm-pill').className = 'rdp-pill ' + (PILL[s] || PILL.disconnected);
    $('rterm-status').textContent = text || T(s);
    $('rterm-pill-dot').className = s === 'reconnecting' ? 'rdp-spin' : 'rdp-dot';
  }
  function show(id, on) { $(id).style.display = on ? 'flex' : 'none'; }

  var ws = null;
  var attempt = 0;
  var stopped = false;
  var exited = false;
  var retryTimer = null;
  var pingTimer = null;
  var enc = new TextEncoder();

  function fail(code) {
    stopped = true;
    clearTimeout(retryTimer);
    show('rterm-reconnect', false);
    show('rterm-hostkey', false);
    state('error');
    $('rterm-error-cause').textContent = code || 'failed';
    $('rterm-error-text').textContent = T(K.errorKey(code));
    show('rterm-error', true);
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

  function sendJson(o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) { /* closed */ } }

  function connect() {
    if (!ref) { fail('not_found'); return; }
    stopped = false;
    exited = false;
    show('rterm-error', false);
    state(attempt ? 'reconnecting' : 'connecting');
    mint().then(function (tk) {
      if (stopped) return;
      var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + tk.wsPath;
      ws = new WebSocket(url, [K.PROTOCOL, 'token.' + tk.token]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () {
        try { fit.fit(); } catch (e) { /* hidden */ }
        sendJson({ t: 'hello', cols: term.cols, rows: term.rows, term: 'xterm-256color' });
        clearInterval(pingTimer);
        pingTimer = setInterval(function () { sendJson({ t: 'ping' }); }, 25000);
      };
      ws.onmessage = function (ev) {
        if (typeof ev.data !== 'string') { term.write(new Uint8Array(ev.data)); return; }
        var m = K.parseFrame(ev.data);
        if (!m) return;
        if (m.t === 'hostkey') {
          $('rterm-fp').textContent = K.fingerprintText(m.hostKey);
          show('rterm-reconnect', false);
          show('rterm-hostkey', true);
          $('rterm-trust').focus();
        } else if (m.t === 'ready') {
          attempt = 0;
          show('rterm-reconnect', false);
          show('rterm-hostkey', false);
          state('connected');
          var note = [];
          if (m.tmux && m.tmux.session) note.push(T('tmux_on').split('{{name}}').join(m.tmux.session));
          else if (m.tmux && m.tmux.available === false) note.push(T('no_tmux'));
          if (view) note.push(T('view_only'));
          $('rterm-note').textContent = note.join(' · ');
          $('rterm-note').title = note.join(' · ');
          if (!view) term.focus();
        } else if (m.t === 'exit') {
          exited = true;
          state('disconnected', T('exited'));
        } else if (m.t === 'error') {
          if (K.isFinal(m.code)) fail(m.code);
          else $('rterm-reconnect-sub').textContent = m.code;
        }
      };
      ws.onclose = function () {
        clearInterval(pingTimer);
        ws = null;
        if (stopped) return;
        if (exited) { show('rterm-error', false); return; }
        var wait = K.backoff(attempt++);
        if (wait == null) { fail('failed'); return; }
        state('reconnecting');
        show('rterm-reconnect', true);
        retryTimer = setTimeout(connect, wait);
      };
    }).catch(function (e) {
      if (K.isFinal(e.code) || e.status === 404 || e.status === 403) { fail(e.code); return; }
      var wait = K.backoff(attempt++);
      if (wait == null) { fail(e.code); return; }
      state('reconnecting');
      show('rterm-reconnect', true);
      retryTimer = setTimeout(connect, wait);
    });
  }

  term.onData(function (d) { if (!view && ws && ws.readyState === 1) ws.send(enc.encode(d)); });
  term.onBinary(function (d) {
    if (view || !ws || ws.readyState !== 1) return;
    var b = new Uint8Array(d.length);
    for (var i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 255;
    ws.send(b);
  });
  term.onResize(function (s) { sendJson({ t: 'resize', cols: s.cols, rows: s.rows }); });
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { try { fit.fit(); } catch (e) { /* hidden */ } }, 80); });

  $('rterm-trust').addEventListener('click', function () { show('rterm-hostkey', false); sendJson({ t: 'trust' }); });
  $('rterm-distrust').addEventListener('click', function () { show('rterm-hostkey', false); sendJson({ t: 'distrust' }); });
  $('rterm-retry').addEventListener('click', function () { attempt = 0; connect(); });
  /* fixed addresses only — never one taken from the page */
  $('rterm-back').addEventListener('click', function () { location.href = '/portal'; });
  $('rterm-btn-fullscreen').addEventListener('click', function () {
    var el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen();
  });
  var paste = $('rterm-btn-paste');
  if (paste) {
    paste.addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { $('rterm-clip-warn').textContent = T('clipboard_unavailable'); $('rterm-clip-warn').style.display = ''; return; }
      navigator.clipboard.readText().then(function (txt) { if (txt) term.paste(txt); term.focus(); }).catch(function () {
        $('rterm-clip-warn').textContent = T('clipboard_unavailable');
        $('rterm-clip-warn').style.display = '';
      });
    });
  }
  $('rterm-btn-disconnect').addEventListener('click', function () {
    stopped = true;
    clearTimeout(retryTimer);
    if (ws && ws.readyState === 1) sendJson({ t: 'bye' }); else state('disconnected');
  });
  window.addEventListener('beforeunload', function () { stopped = true; if (ws) { try { ws.close(); } catch (e) { /* closed */ } } });

  if (cfg.record) {
    show('rterm-recnote', true);
    $('rterm-recnote-ok').focus();
    $('rterm-recnote-ok').addEventListener('click', function () { show('rterm-recnote', false); connect(); });
    $('rterm-recnote-back').addEventListener('click', function () { location.href = '/portal'; });
  } else {
    connect();
  }
})();
