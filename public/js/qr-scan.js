'use strict';

// GateControl's QR code dialog for plugin frames (GC.scanQr, docs/plugins.md
// "QR codes", since 1.196.0).
//
// A plugin frame is sandboxed without allow-same-origin: an opaque origin.
// Chromium (Chrome, Edge, Android) refuses getUserMedia there — "SecurityError:
// Invalid security origin", whatever <iframe allow="camera"> says. So the
// frame never gets the camera: it asks the parent page (plugin-bridge.js,
// message gc-scan), and this page — GateControl's own origin, a secure context
// on HTTPS or localhost — shows this dialog: the camera preview with a frame,
// a camera switch when there are several, "Abbrechen" and the plugin's hint.
// It reads QR codes with the browser's BarcodeDetector where there is one,
// else with the vendored jsQR (public/vendor/jsqr, Apache-2.0, loaded only
// then), and answers only the text: the picture never leaves this page, the
// camera stops the moment there is a result, a cancel, a timeout, or the page
// is hidden.
//
//   GCQrScan.open({ name, hint, accept, timeoutMs, gesture, visible })
//     → { promise: Promise<{ text, code }>, cancel(code) }
//   text: the code's content (a string) or null; code: null on success, else
//   cancelled | timeout | hidden | denied | no_camera | camera_error |
//   insecure | unsupported | decoder_error | busy
//   `accept`: prefixes (case-insensitive) — other codes keep the dialog open
//   with a hint. `gesture`: false when the frame's call came without a click
//   (no transient user activation) — then the camera only starts after the
//   person presses "Kamera starten" in the dialog. `visible()`: is the frame
//   still shown (its portal tab, the page) — checked while scanning.
//
// Admin pages: the shared dialog (gc-dialog.js, .modal-overlay.zn-dialog);
// the portal: its own .pt-overlay/.pt-dialog. Texts German/English by
// <html lang>. No innerHTML anywhere.
(function (root) {
  const doc = root && root.document;

  const STR = {
    de: {
      title: 'QR-Code scannen',
      for: 'für {name}',
      starting: 'Kamera wird gestartet …',
      looking: 'Halte den QR-Code in den Rahmen.',
      wrong: 'Dieser QR-Code passt hier nicht – bitte den richtigen Code scannen.',
      ask: '{name} möchte einen QR-Code lesen. Die Kamera startet erst, wenn du es erlaubst.',
      start: 'Kamera starten',
      insecure: 'Die Kamera geht nur über eine sichere Verbindung. Öffne GateControl über seine https://-Adresse.',
      unsupported: 'Dieser Browser kann hier keine Kamera verwenden.',
      denied: 'Kein Zugriff auf die Kamera. Erlaube sie für diese Seite in den Einstellungen des Browsers und versuche es noch einmal.',
      no_camera: 'Keine Kamera gefunden.',
      camera_error: 'Die Kamera ließ sich nicht starten – vielleicht verwendet sie gerade eine andere App.',
      decoder_error: 'Der QR-Code-Leser ließ sich nicht laden.',
      switch: 'Kamera wechseln',
      cancel: 'Abbrechen',
      close: 'Schließen',
      privacy: 'Das Bild bleibt in GateControl – {name} bekommt nur den gelesenen Text.',
    },
    en: {
      title: 'Scan QR code',
      for: 'for {name}',
      starting: 'Starting the camera …',
      looking: 'Hold the QR code inside the frame.',
      wrong: 'This QR code does not fit here – please scan the right one.',
      ask: '{name} would like to read a QR code. The camera only starts once you allow it.',
      start: 'Start camera',
      insecure: 'The camera needs a secure connection. Open GateControl at its https:// address.',
      unsupported: 'This browser cannot use a camera here.',
      denied: 'No access to the camera. Allow it for this page in the browser\'s settings and try again.',
      no_camera: 'No camera found.',
      camera_error: 'The camera could not be started – another app may be using it.',
      decoder_error: 'The QR code reader could not be loaded.',
      switch: 'Switch camera',
      cancel: 'Cancel',
      close: 'Close',
      privacy: 'The picture stays in GateControl – {name} only gets the text that was read.',
    },
  };
  const MAX_TEXT = 4096;
  const MAX_HINT = 200;
  const MAX_ACCEPT = 8;
  const MAX_PREFIX = 100;
  const MAX_NAME = 80;
  const TIMEOUT_DEFAULT_S = 120;
  const TIMEOUT_MIN_S = 10;
  const TIMEOUT_MAX_S = 600;
  const JSQR_SRC = '/vendor/jsqr/jsQR.js';

  function lang() {
    const l = doc && doc.documentElement ? String(doc.documentElement.getAttribute('lang') || doc.documentElement.lang || '') : '';
    return /^en/i.test(l) ? 'en' : 'de';
  }
  function t(key, params) {
    let s = STR[lang()][key] || STR.de[key] || key;
    if (params) Object.keys(params).forEach((k) => { s = s.split('{' + k + '}').join(String(params[k])); });
    return s;
  }
  // Text from a plugin: no control characters, trimmed, capped.
  function clean(v, max) {
    return typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '';
  }

  /**
   * The request of a frame (gc-scan) → { ok, hint, accept, timeoutMs } or
   * { ok: false } (accept not a list of ≤ 8 prefixes of 1…100 characters).
   */
  function normalize(m) {
    const o = m && typeof m === 'object' ? m : {};
    const raw = o.accept == null ? [] : o.accept;
    if (!Array.isArray(raw) || raw.length > MAX_ACCEPT) return { ok: false };
    const accept = [];
    for (const a of raw) {
      if (typeof a !== 'string' || !a.length || a.length > MAX_PREFIX || /[\0-\x1f\x7f]/.test(a)) return { ok: false };
      accept.push(a.toLowerCase());
    }
    const s = Number(o.timeout);
    const secs = Number.isFinite(s) && s > 0 ? Math.min(TIMEOUT_MAX_S, Math.max(TIMEOUT_MIN_S, Math.round(s))) : TIMEOUT_DEFAULT_S;
    return { ok: true, hint: clean(o.hint, MAX_HINT), accept, timeoutMs: secs * 1000 };
  }

  /** Does a code's text pass the plugin's prefixes (none = any)? Never more than 4096 characters. */
  function matches(text, accept) {
    if (typeof text !== 'string' || !text.length || text.length > MAX_TEXT) return false;
    if (!accept || !accept.length) return true;
    const low = text.toLowerCase();
    return accept.some((p) => low.startsWith(p));
  }

  // ── reading ──────────────────────────────────────────────────────────────
  let detectorP = null;
  function detector() {
    if (!detectorP) {
      detectorP = Promise.resolve().then(() => {
        const BD = root.BarcodeDetector;
        if (typeof BD !== 'function') return null;
        const fmts = typeof BD.getSupportedFormats === 'function' ? BD.getSupportedFormats() : Promise.resolve(['qr_code']);
        return Promise.resolve(fmts).then((f) => (Array.isArray(f) && f.indexOf('qr_code') >= 0 ? new BD({ formats: ['qr_code'] }) : null));
      }).catch(() => null);
    }
    return detectorP;
  }
  let jsqrP = null;
  function jsqr() {
    if (typeof root.jsQR === 'function') return Promise.resolve(root.jsQR);
    if (!jsqrP) {
      jsqrP = new Promise((resolve, reject) => {
        const s = doc.createElement('script');
        s.src = JSQR_SRC;
        s.async = true;
        s.onload = () => (typeof root.jsQR === 'function' ? resolve(root.jsQR) : reject(new Error('decoder')));
        s.onerror = () => reject(new Error('decoder'));
        doc.head.appendChild(s);
      }).catch((e) => { jsqrP = null; throw e; });
    }
    return jsqrP;
  }
  let canvas = null;
  /** One video frame → the QR code's text or null. */
  function readFrame(video) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return Promise.resolve(null);
    return detector().then((d) => {
      if (d) return d.detect(video).then((codes) => (codes && codes.length ? String(codes[0].rawValue || '') : null));
      return jsqr().then((decode) => {
        const scale = Math.min(1, 800 / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        if (!canvas) canvas = doc.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(video, 0, 0, cw, ch);
        const img = g.getImageData(0, 0, cw, ch);
        const code = decode(img.data, cw, ch, { inversionAttempts: 'attemptBoth' });
        g.clearRect(0, 0, cw, ch);
        return code ? String(code.data || '') : null;
      });
    });
  }

  // ── the dialog ───────────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    const n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach((c) => { if (c) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  }

  /** The shell: admin (GCDialog) or portal (.pt-dialog). → { body, foot, overlay, close(), onClose(fn), btn(kind) } */
  function shell(title, sub) {
    const G = root.GCDialog;
    if (G && typeof G.dialog === 'function' && !doc.querySelector('body.pt-body')) {
      const d = G.dialog({ title });
      d.overlay.classList.add('gc-qr-overlay');
      d.box.classList.add('gc-qr-box');
      if (sub) {
        const head = d.box.querySelector('.modal-title');
        if (head) head.appendChild(el('small', { text: sub }));
      }
      return {
        body: d.body, foot: d.foot, overlay: d.overlay,
        close: () => d.close(true),
        onClose: (fn) => { d.promise.then((r) => fn(r === true ? 'closed' : 'cancelled')); },
        btn: (kind) => 'btn ' + (kind === 'primary' ? 'btn-primary' : 'btn-ghost'),
      };
    }
    const titleId = 'gc-qr-t-' + Date.now();
    const body = el('div', { class: 'gc-qr-body' });
    const foot = el('div', { class: 'pt-dialog-foot' });
    const box = el('div', { class: 'pt-dialog gc-qr-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'gc-qr-head' }, [el('h2', { class: 'pt-h2', id: titleId, text: title }), sub ? el('p', { class: 'pt-small pt-muted gc-qr-sub', text: sub }) : null]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'pt-overlay gc-qr-overlay' }, [box]);
    const prev = doc.activeElement;
    let closeFn = null;
    let closed = false;
    function close(how) {
      if (closed) return;
      closed = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prev && prev.focus && doc.contains(prev)) { try { prev.focus(); } catch (_) { /* gone */ } }
      if (closeFn) closeFn(how);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close('cancelled'); }
    }
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    return {
      body, foot, overlay,
      close: () => close('closed'),
      onClose: (fn) => { closeFn = fn; },
      btn: (kind) => 'pt-btn' + (kind === 'primary' ? ' pt-btn-primary' : ''),
    };
  }

  let current = null;

  function open(opts) {
    const o = opts || {};
    if (current) return { promise: Promise.resolve({ text: null, code: 'busy' }), cancel() {} };
    const name = clean(o.name, MAX_NAME) || 'Plugin';
    const accept = Array.isArray(o.accept) ? o.accept : [];
    const visible = typeof o.visible === 'function' ? o.visible : () => true;
    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });
    const st = { done: false, stream: null, timer: null, tick: null, devices: [], deviceIdx: -1, lastWrong: '', reading: false };
    const self = { promise, cancel: (code) => finish(null, code || 'cancelled') };
    current = self;

    const ui = shell(t('title'), t('for', { name }));
    ui.overlay.style.zIndex = '2147483600'; // above the dimming of an open plugin dialog (plugin-bridge.js)
    const video = el('video', { class: 'gc-qr-video', playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' });
    video.muted = true;
    video.playsInline = true;
    const view = el('div', { class: 'gc-qr-view' }, [video, el('span', { class: 'gc-qr-frame', 'aria-hidden': 'true' })]);
    const status = el('p', { class: 'gc-qr-status', role: 'status', 'aria-live': 'polite' });
    const hint = o.hint ? el('p', { class: 'gc-qr-hint', text: o.hint }) : null;
    const privacy = el('p', { class: 'gc-qr-privacy', text: t('privacy', { name }) });
    const switchBtn = el('button', { type: 'button', class: ui.btn() + ' gc-qr-switch', text: t('switch') });
    switchBtn.hidden = true;
    const cancelBtn = el('button', { type: 'button', class: ui.btn() + ' gc-qr-cancel', text: t('cancel') });
    ui.foot.appendChild(switchBtn);
    ui.foot.appendChild(cancelBtn);

    function say(text, tone) {
      status.textContent = text || '';
      if (tone) status.setAttribute('data-tone', tone); else status.removeAttribute('data-tone');
    }
    function stopCamera() {
      if (st.tick) { clearTimeout(st.tick); st.tick = null; }
      if (st.stream) {
        st.stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (_) { /* gone */ } });
        st.stream = null;
      }
      try { video.pause(); } catch (_) { /* not playing */ }
      video.srcObject = null;
    }
    function finish(text, code) {
      if (st.done) return;
      st.done = true;
      stopCamera();
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      doc.removeEventListener('visibilitychange', onVisibility);
      if (current === self) current = null;
      resolveFn({ text: typeof text === 'string' ? text : null, code: typeof text === 'string' ? null : (code || 'cancelled') });
      ui.close();
    }
    /** An error: the camera stops, the dialog stays with the message until it is closed. */
    let failCode = null;
    function fail(code) {
      stopCamera();
      failCode = code;
      view.hidden = true;
      switchBtn.hidden = true;
      say(t(code), 'error');
      cancelBtn.textContent = t('close');
      try { cancelBtn.focus(); } catch (_) { /* cosmetic */ }
    }
    function onVisibility() { if (doc.visibilityState === 'hidden') finish(null, 'hidden'); }

    function scanLoop() {
      if (st.done || !st.stream) return;
      if (!visible()) { finish(null, 'hidden'); return; }
      if (st.reading || video.readyState < 2) { st.tick = setTimeout(scanLoop, 150); return; }
      st.reading = true;
      readFrame(video).then((text) => {
        st.reading = false;
        if (st.done || !st.stream) return;
        if (text) {
          if (matches(text, accept)) { finish(text, null); return; }
          if (text !== st.lastWrong) { st.lastWrong = text; say(t('wrong'), 'warn'); }
        }
        st.tick = setTimeout(scanLoop, 200);
      }).catch((e) => {
        st.reading = false;
        if (st.done) return;
        if (e && e.message === 'decoder') { fail('decoder_error'); return; }
        st.tick = setTimeout(scanLoop, 500);
      });
    }

    function constraints() {
      const d = st.deviceIdx >= 0 ? st.devices[st.deviceIdx] : null;
      return { audio: false, video: d ? { deviceId: { exact: d.deviceId } } : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } };
    }
    function startCamera() {
      say(t('starting'));
      view.hidden = false;
      navigator.mediaDevices.getUserMedia(constraints()).then((stream) => {
        if (st.done) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        st.stream = stream;
        video.srcObject = stream;
        const p = video.play();
        if (p && p.catch) p.catch(() => { /* autoplay: muted + playsinline */ });
        say(t('looking'));
        // which camera is on, and are there others (labels only exist after the permission)
        const track = stream.getVideoTracks()[0];
        const id = track && track.getSettings ? track.getSettings().deviceId : null;
        const list = navigator.mediaDevices.enumerateDevices ? navigator.mediaDevices.enumerateDevices() : Promise.resolve([]);
        list.then((all) => {
          if (st.done) return;
          st.devices = (all || []).filter((x) => x.kind === 'videoinput' && x.deviceId);
          if (id) st.deviceIdx = st.devices.findIndex((x) => x.deviceId === id);
          switchBtn.hidden = st.devices.length < 2;
        }).catch(() => { /* no list: no switch */ });
        st.tick = setTimeout(scanLoop, 300);
      }).catch((e) => {
        if (st.done) return;
        const n = e && e.name;
        fail(n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' ? 'denied'
          : (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError' ? 'no_camera' : 'camera_error'));
      });
    }

    switchBtn.addEventListener('click', () => {
      if (st.done || st.devices.length < 2) return;
      stopCamera();
      st.deviceIdx = (st.deviceIdx + 1) % st.devices.length;
      st.lastWrong = '';
      startCamera();
    });
    cancelBtn.addEventListener('click', () => finish(null, failCode || 'cancelled'));
    ui.onClose(() => finish(null, failCode || 'cancelled')); // Escape, the dialog's ×
    doc.addEventListener('visibilitychange', onVisibility);
    st.timer = setTimeout(() => finish(null, 'timeout'), Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : TIMEOUT_DEFAULT_S * 1000);

    ui.body.appendChild(view);
    if (hint) ui.body.appendChild(hint);
    ui.body.appendChild(status);
    ui.body.appendChild(privacy);

    if (root.isSecureContext === false) fail('insecure');
    else if (!root.navigator || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') fail('unsupported');
    else if (o.gesture === false) {
      // no click behind the call: the person starts the camera here
      view.hidden = true;
      say(t('ask', { name }));
      const start = el('button', { type: 'button', class: ui.btn('primary') + ' gc-qr-start', text: t('start') });
      start.addEventListener('click', () => { start.remove(); startCamera(); });
      ui.foot.appendChild(start);
      try { start.focus(); } catch (_) { /* cosmetic */ }
    } else {
      startCamera();
      try { cancelBtn.focus(); } catch (_) { /* cosmetic */ }
    }
    return self;
  }

  const api = { open, normalize, matches, active: () => !!current, MAX_TEXT, STR };
  if (root && root.document) root.GCQrScan = Object.freeze(api);
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : this));
