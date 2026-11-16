/* The playback of a gc.remote recording (templates/aurora/pages/remote-recording.njk, stage 3).
   asciicast (SSH in the terminal of the core): xterm.js writes the output at its times; guacd's
   recordings (.guac): Guacamole.SessionRecording. The file comes decrypted from
   /remote/session/<ref>/recording — nothing is converted on the server. */
(function () {
  'use strict';
  var K = window.GCTermKit;
  var cfg = JSON.parse(document.getElementById('rrec-cfg').textContent);
  var i18n = JSON.parse(document.getElementById('rrec-i18n').textContent);
  var ref = typeof cfg.ref === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cfg.ref) ? cfg.ref : null;
  var $ = function (id) { return document.getElementById(id); };
  var seek = $('rrec-seek');
  var playBtn = $('rrec-play');
  var speedSel = $('rrec-speed');
  var dragging = false;

  function failed() {
    $('rrec-pill').className = 'rdp-pill rdp-pill--error';
    $('rrec-status').textContent = i18n.failed;
    $('rrec-error').style.display = 'flex';
  }
  function ready() {
    $('rrec-pill').className = 'rdp-pill rdp-pill--connected';
    $('rrec-status').textContent = i18n.ready;
    playBtn.disabled = false;
    seek.disabled = false;
  }
  function label(playing) { $('rrec-play-label').textContent = playing ? i18n.pause : i18n.play; }
  function time(pos, dur) { $('rrec-time').textContent = K.clock(pos) + ' / ' + K.clock(dur); if (!dragging) seek.value = String(dur ? Math.round(pos / dur * 1000) : 0); }

  $('rrec-btn-fullscreen').addEventListener('click', function () {
    var el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen();
  });
  seek.addEventListener('pointerdown', function () { dragging = true; });
  seek.addEventListener('pointerup', function () { dragging = false; });

  if (!ref) { failed(); return; }
  var src = '/remote/session/' + ref + '/recording';

  // ─── asciicast ───
  function playCast(text) {
    var cast = K.parseCast(text);
    if (!cast) { failed(); return; }
    var term = new window.Terminal({ disableStdin: true, scrollback: 5000, cols: cast.header.width, rows: cast.header.height,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 14,
      theme: { background: '#0d1117', foreground: '#d7dde4' } });
    term.open($('rrec-host'));
    var ev = cast.events;
    var dur = cast.duration;
    var idx = 0;
    var pos = 0;
    var playing = false;
    var last = 0;
    var timer = null;
    function apply(e) {
      if (e[1] === 'o') term.write(e[2]);
      else { var s = K.parseSize(e[2]); if (s) term.resize(s.cols, s.rows); }
    }
    function to(t) {
      term.reset();
      term.resize(cast.header.width, cast.header.height);
      var end = K.indexAt(ev, t);
      for (var i = 0; i < end; i++) apply(ev[i]);
      idx = end;
      pos = t;
      time(pos, dur);
    }
    function tick() {
      if (!playing) return;
      var now = performance.now();
      pos += (now - last) / 1000 * Number(speedSel.value || 1);
      last = now;
      while (idx < ev.length && ev[idx][0] <= pos) apply(ev[idx++]);
      if (idx >= ev.length) { pos = dur; playing = false; label(false); }
      time(pos, dur);
      if (playing) timer = requestAnimationFrame(tick);
    }
    playBtn.addEventListener('click', function () {
      if (playing) { playing = false; cancelAnimationFrame(timer); label(false); return; }
      if (idx >= ev.length) to(0);
      playing = true;
      last = performance.now();
      label(true);
      timer = requestAnimationFrame(tick);
    });
    seek.addEventListener('change', function () { to(dur * Number(seek.value) / 1000); dragging = false; });
    ready();
    time(0, dur);
  }

  // ─── guacd (.guac) ───
  function playGuac(blob) {
    var G = window.Guacamole;
    if (!G || !G.SessionRecording) { failed(); return; }
    var rec = new G.SessionRecording(blob);
    var display = rec.getDisplay();
    var host = $('rrec-host');
    host.className = 'rterm-guac';
    host.appendChild(display.getElement());
    function scale() {
      var w = display.getWidth();
      var h = display.getHeight();
      if (w && h) display.scale(Math.min(host.clientWidth / w, host.clientHeight / h, 1));
    }
    display.onresize = scale;
    window.addEventListener('resize', scale);
    rec.onload = function () { ready(); time(0, rec.getDuration() / 1000); };
    rec.onerror = failed;
    rec.onplay = function () { label(true); };
    rec.onpause = function () { label(false); };
    rec.onprogress = function (d) { time(rec.getPosition() / 1000, d / 1000); };
    setInterval(function () { if (rec.isPlaying()) time(rec.getPosition() / 1000, rec.getDuration() / 1000); }, 250);
    playBtn.addEventListener('click', function () { if (rec.isPlaying()) rec.pause(); else rec.play(); });
    seek.addEventListener('change', function () { rec.seek(rec.getDuration() * Number(seek.value) / 1000); dragging = false; });
    // guacd recordings play at their own speed
    speedSel.disabled = true;
    rec.connect();
  }

  fetch(src, { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) throw new Error('http ' + r.status);
    return cfg.format === 'guac' ? r.blob().then(playGuac) : r.text().then(playCast);
  }).catch(failed);
})();
