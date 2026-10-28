'use strict';

// Parent side of a plugin frame (docs/plugins.md "Oberfläche"). The frame is
// sandboxed (opaque origin, connect-src 'none'); it asks this page to call
// its plugin's API (window.GC.call inside the frame → postMessage). Only
// messages from the frame's own window are taken, only relative paths below
// that plugin's API base are called, with this page's session and CSRF token.
// Used by the admin plugin page (plugin.njk), the portal (portal.njk) and the
// plugin area (plugins.njk: a plugin's settings page in its settings tab,
// attached later with window.GCPluginBridge.attach).
//
// Downloads (GC.saveFile, since 1.186.0): the frame posts a Blob and a name,
// this page checks type (csv, pdf, txt, json, png, jpeg, ics) and size
// (≤ 20 MB, one per 1.5 s), cleans the name and offers the file as a download
// from its own (not sandboxed) document — any plugin, no `media` needed.
//
// Uploads (GC.upload, plugin.json `media`): the frame posts the File/Blob,
// this page PUTs it raw to the plugin's media endpoint (…/plugins/<id>/media)
// with the session and CSRF token, reports progress and answers
// { mediaId, mime, bytes }. Realtime events (GC.on('event'), frames with
// data-plugin-events): one EventSource per plugin and page
// (…/plugins/<id>/events), opened when the first frame subscribes, each
// event passed to the subscribed frames of that plugin.
//
// Inbox (GC.inbox, frames with data-plugin-inbox = plugin.json `ui.inbox`,
// portal frames only): this page's own inbox state, never fetched here. The
// portal (public/js/portal.js) announces it as a `gc:inbox` DOM event
// ({ unread, latest }); a frame's gc-inbox-subscribe asks it with
// `gc:inbox-request` (the portal sets detail.handled and announces its state,
// polling first when it has none), gc-inbox-open with `gc:inbox-open` (the
// portal shows #mitteilungen). Only the unread count and the newest item's
// title, time and priority reach the frame; a page without the notification
// center, the admin pages and frames without the attribute get
// { available: false }.
//
// QR codes (GC.scanQr, frames with data-plugin-scanqr = plugin.json
// `ui.scanQr` or `ui.camera`, since 1.196.0): the frame cannot use the camera
// (opaque origin), so this page reads the code in its own dialog
// (public/js/qr-scan.js) and answers only { text, code }. One scan at a time
// on the page, only while the page and the frame are shown, at most one start
// per 1.5 s per frame. A call that comes with a click in the frame (the
// click's transient user activation reaches this page too) starts the camera
// at once; one without asks the person to press "Kamera starten" first, and
// is refused (no_gesture) when it repeats within 10 s. A new document in the
// frame (gc-hello) ends its scan.
//
// People and groups (GC.pickPrincipals, frames with data-plugin-groups =
// plugin.json `permissions.groups`): the frame gets no list of people. This
// page opens GateControl's own picker (public/js/principal-picker.js) with
// what the viewer may see — admin pages every group and person, the portal
// the groups by name and the viewer — and answers only the chosen entries
// [{ type: 'group'|'user', id, label }], or null when cancelled. One picker
// at a time on the page; a new document in the frame (gc-hello) closes its own.
//
// Viewport (since 1.199.0): every frame learns the height it can take
// without the page scrolling — the window's height minus what stands above
// the frame and below it on the page (gc-viewport { height, width }; in the
// frame window.GC.viewport, the CSS variable --gc-viewport-height on its
// root and a `gc:viewport` event). Sent on load, a new document, a resize of
// the window, and when the page around the frame changes (a banner, the
// frame shown in another tab); only when the value changes. A frame that
// does not use it still grows with its content as before.
(function () {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const MAX_UPLOAD = 100 * 1024 * 1024;
  // GC.saveFile (since 1.186.0): the types a frame may hand over as a download, with their extension
  const SAVE_TYPES = {
    'text/csv': 'csv', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/json': 'json',
    'image/png': 'png', 'image/jpeg': 'jpg', 'text/calendar': 'ics',
  };
  const MAX_SAVE = 20 * 1024 * 1024;
  const SAVE_GAP_MS = 1500;

  /** A safe download name: letters, digits, space, . _ ( ) - (umlauts kept), ≤ 100, with the type's extension. */
  function saveName(raw, ext) {
    let n = String(raw || '').split(/[\\/]/).pop().normalize('NFC')
      .replace(/[^\p{L}\p{N} ._()-]+/gu, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 100);
    if (!n) n = 'download';
    if (!n.toLowerCase().endsWith('.' + ext)) n = n.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.' + ext;
    return n;
  }
  // GC.keys (since 1.211.0): WebCrypto keys of the frames in this page's IndexedDB "gc-plugin-keys" (store "keys",
  // key "<plugin id>/<name>"), ≤ KEYS_MAX per plugin. Only CryptoKey objects travel — a secret or private key only
  // when it is not extractable — so nobody can read the key's bytes, neither this page nor the frame.
  const KEY_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
  const KEYS_MAX = 32;
  const isKey = (k) => typeof CryptoKey !== 'undefined' && k instanceof CryptoKey && (k.type === 'public' || k.extractable === false);
  function storableKey(v) {
    if (isKey(v)) return true;
    return !!v && typeof v === 'object' && Object.keys(v).length === 2 && isKey(v.publicKey) && isKey(v.privateKey)
      && v.publicKey.type === 'public' && v.privateKey.type === 'private';
  }
  let keyDb = null;
  function openKeyDb() {
    if (keyDb) return keyDb;
    keyDb = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('gc-plugin-keys', 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore('keys'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('storage unavailable'));
    });
    keyDb.catch(() => { keyDb = null; });
    return keyDb;
  }
  async function keyStore(op, key, value) {
    const db = await openKeyDb();
    const run = (mode, fn) => new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode);
      const r = fn(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(r ? r.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('storage unavailable'));
      tx.onabort = () => reject(tx.error || new Error('storage unavailable'));
    });
    if (op === 'get') { const v = await run('readonly', (s) => s.get(key)); return v === undefined ? null : v; }
    if (op === 'remove') {
      const had = await run('readonly', (s) => s.count(key));
      await run('readwrite', (s) => s.delete(key));
      return had > 0;
    }
    const prefix = key.slice(0, key.indexOf('/') + 1);
    const count = await run('readonly', (s) => s.count(IDBKeyRange.bound(prefix, prefix + '\uffff')));
    const exists = await run('readonly', (s) => s.count(key));
    if (!exists && count >= KEYS_MAX) throw Object.assign(new Error('too many keys'), { status: 429 });
    await run('readwrite', (s) => s.put(value, key));
    return true;
  }
  // GC.mediaBytes (since 1.211.0): the plugin's own media URLs, ≤ 16 MiB a call
  const MEDIA_PATH_RE = /^\/plugin-media\/[0-9a-f]{32}\.\d{1,12}\.\d{1,12}\.[A-Za-z0-9_-]{22}$/;
  const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
  // GC.scanQr: one start per 1.5 s per frame; without a click, one per 10 s
  const SCAN_GAP_MS = 1500;
  const SCAN_NO_GESTURE_GAP_MS = 10000;
  const streams = {}; // plugin id → { es, frames: Set<reply fn> }

  function subscribe(pluginId, url, sink) {
    let s = streams[pluginId];
    if (!s) {
      s = { es: null, frames: new Set() };
      streams[pluginId] = s;
      try {
        s.es = new EventSource(url, { withCredentials: true });
        s.es.addEventListener('plugin', (ev) => {
          let data = null;
          try { data = JSON.parse(ev.data); } catch (_) { return; }
          s.frames.forEach((fn) => fn({ type: 'gc-event', event: data }));
        });
      } catch (_) { s.es = null; }
    }
    s.frames.add(sink);
  }

  function unsubscribe(pluginId, sink) {
    const s = streams[pluginId];
    if (!s) return;
    s.frames.delete(sink);
    if (!s.frames.size) {
      if (s.es) s.es.close();
      delete streams[pluginId];
    }
  }
  // ── inbox (portal) ──
  const inboxSinks = new Set(); // reply fns of the frames subscribed to the inbox
  const INBOX_OFF = { available: false, unread: 0, latest: null };
  const PRIORITIES = ['info', 'normal', 'high', 'critical'];
  function cleanInbox(d) {
    if (!d || typeof d !== 'object') return null;
    const unread = Math.max(0, Math.min(1000000, Math.floor(Number(d.unread) || 0)));
    const l = d.latest && typeof d.latest === 'object' ? d.latest : null;
    const latest = l && typeof l.title === 'string' ? {
      title: l.title.slice(0, 200),
      createdAt: typeof l.createdAt === 'string' ? l.createdAt.slice(0, 40) : null,
      priority: PRIORITIES.indexOf(l.priority) >= 0 ? l.priority : 'normal',
    } : null;
    return { available: true, unread, latest };
  }
  /** Ask the page (portal.js) — true when it took the request. */
  function askPage(type) {
    if (typeof CustomEvent !== 'function' || !document.dispatchEvent) return false;
    const ev = new CustomEvent(type, { detail: { handled: false } });
    document.dispatchEvent(ev);
    return !!(ev.detail && ev.detail.handled === true);
  }
  if (document.addEventListener) {
    document.addEventListener('gc:inbox', (e) => {
      const st = cleanInbox(e && e.detail);
      if (st) inboxSinks.forEach((fn) => fn({ type: 'gc-inbox', inbox: st }));
    });
  }

  const PATH_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;

  function csrf() {
    if (window.GC && window.GC.csrfToken) return window.GC.csrfToken;
    try {
      const ctx = document.getElementById('portal-ctx');
      return ctx ? (JSON.parse(ctx.textContent || '{}').csrf || '') : '';
    } catch (_) { return ''; }
  }

  function theme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function attach(frame) {
    if (!frame || frame.__gcBridge) return;
    frame.__gcBridge = true;
    const base = frame.getAttribute('data-plugin-api') || '';
    const pluginId = frame.getAttribute('data-plugin-id') || '';
    let pages = [];
    try { pages = JSON.parse(frame.getAttribute('data-plugin-pages') || '[]'); } catch (_) { pages = []; }
    if (!/^\/api\/v1\/(portal\/)?plugins\/[a-z0-9-]+\/api\/$/.test(base)) return;

    function reply(msg) {
      // The frame has an opaque origin ("null"): '*' is the only target that
      // reaches it; the receiver is pinned by contentWindow.
      if (frame.contentWindow) frame.contentWindow.postMessage(msg, '*');
    }
    const mediaUrl = base.replace(/api\/$/, 'media');
    const eventsUrl = base.replace(/api\/$/, 'events');
    const eventsOn = frame.getAttribute('data-plugin-events') != null;
    let subscribed = false;
    function setSubscribed(on) {
      if (!eventsOn || on === subscribed) return;
      subscribed = on;
      if (on) subscribe(pluginId, eventsUrl, reply); else unsubscribe(pluginId, reply);
    }

    // GC.inbox: portal frames of plugins with ui.inbox only
    const inboxOn = frame.getAttribute('data-plugin-inbox') != null && base.indexOf('/api/v1/portal/') === 0;
    let inboxSub = false;
    function setInbox(on) {
      if (!on) { inboxSub = false; inboxSinks.delete(reply); return; }
      if (inboxSub) return;
      if (!inboxOn) { reply({ type: 'gc-inbox', inbox: INBOX_OFF }); return; }
      inboxSub = true;
      inboxSinks.add(reply);
      if (!askPage('gc:inbox-request')) { setInbox(false); reply({ type: 'gc-inbox', inbox: INBOX_OFF }); }
    }

    function upload(m) {
      const file = m.file;
      if (typeof Blob === 'undefined' || !(file instanceof Blob) || !file.size || file.size > MAX_UPLOAD) {
        reply({ type: 'gc-result', id: m.id, ok: false, status: 400, error: 'invalid file' });
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', mediaUrl);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-CSRF-Token', csrf());
      xhr.setRequestHeader('Content-Type', String(file.type || m.mime || 'application/octet-stream'));
      if (m.progress) {
        xhr.upload.onprogress = (e) => reply({ type: 'gc-upload-progress', id: m.id, loaded: e.loaded, total: e.lengthComputable ? e.total : file.size });
      }
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_) { data = null; }
        const ok = xhr.status >= 200 && xhr.status < 300 && !!data && data.ok === true;
        const out = ok ? { mediaId: data.mediaId, mime: data.mime, bytes: data.bytes } : data;
        reply({ type: 'gc-result', id: m.id, ok, status: xhr.status, data: out, error: ok ? null : ((data && (data.code || data.error)) || ('HTTP ' + xhr.status)) });
      };
      xhr.onerror = () => reply({ type: 'gc-result', id: m.id, ok: false, status: 0, error: 'network error' });
      xhr.send(file);
    }

    // GC.saveFile: a Blob of an allowed type, offered as a download by this page (not sandboxed)
    let lastSave = 0;
    function save(m) {
      const file = m.file;
      const type = file && typeof file.type === 'string' ? file.type.split(';')[0].trim().toLowerCase() : '';
      const ext = SAVE_TYPES[type];
      if (typeof Blob === 'undefined' || !(file instanceof Blob) || !file.size || file.size > MAX_SAVE || !ext) {
        reply({ type: 'gc-result', id: m.id, ok: false, status: 400, error: 'invalid file' });
        return;
      }
      const now = Date.now();
      if (now - lastSave < SAVE_GAP_MS) {
        reply({ type: 'gc-result', id: m.id, ok: false, status: 429, error: 'too many downloads' });
        return;
      }
      lastSave = now;
      const url = URL.createObjectURL(new Blob([file], { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = saveName(m.name, ext);
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      reply({ type: 'gc-result', id: m.id, ok: true, status: 200, data: { ok: true, name: a.download } });
    }

    // GC.keys (since 1.211.0): WebCrypto keys of the frame in this page's IndexedDB, per plugin and name
    function keys(m) {
      const fail = (status, error) => reply({ type: 'gc-result', id: m.id, ok: false, status, error });
      const name = typeof m.name === 'string' ? m.name : '';
      if (!KEY_NAME_RE.test(name) || ['get', 'put', 'remove'].indexOf(m.op) < 0) { fail(400, 'invalid request'); return; }
      if (m.op === 'put' && !storableKey(m.value)) { fail(400, 'invalid key'); return; }
      keyStore(m.op, pluginId + '/' + name, m.value).then(
        (data) => reply({ type: 'gc-result', id: m.id, ok: true, status: 200, data }),
        (e) => fail(e && e.status ? e.status : 500, (e && e.message) || 'storage unavailable'));
    }

    // GC.mediaBytes (since 1.211.0): one of the plugin's media URLs, fetched here, the bytes handed over
    let mediaBusy = 0;
    async function mediaBytes(m) {
      const fail = (status, error) => reply({ type: 'gc-result', id: m.id, ok: false, status, error });
      let u = null;
      try { u = new URL(String(m.url || ''), window.location.href); } catch (_) { u = null; }
      const start = m.start == null ? null : m.start;
      const end = m.end == null ? null : m.end;
      const ranged = start != null || end != null;
      if (!u || u.origin !== window.location.origin || !MEDIA_PATH_RE.test(u.pathname) || u.search || u.hash
        || (ranged && !(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end - start < MAX_MEDIA_BYTES))) {
        fail(400, 'invalid request');
        return;
      }
      if (mediaBusy >= 4) { fail(429, 'busy'); return; }
      mediaBusy++;
      try {
        const res = await fetch(u.pathname, { credentials: 'omit', cache: 'no-store', headers: ranged ? { Range: 'bytes=' + start + '-' + end } : {} });
        if (!res.ok) { fail(res.status, 'HTTP ' + res.status); return; }
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len) && len > MAX_MEDIA_BYTES) { fail(413, 'too large'); return; }
        const data = await res.arrayBuffer();
        if (data.byteLength > MAX_MEDIA_BYTES) { fail(413, 'too large'); return; }
        const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
        const out = cr ? { data, start: Number(cr[1]), end: Number(cr[2]), total: Number(cr[3]) } : { data, start: 0, end: data.byteLength - 1, total: data.byteLength };
        if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'gc-result', id: m.id, ok: true, status: res.status, data: out }, '*', [data]);
      } catch (_) {
        fail(0, 'network error');
      } finally { mediaBusy--; }
    }

    // GC.openTab (since 1.211.0): one of the plugin's public endpoints in a new tab, during a click only
    function openTab(m) {
      const answer = (data) => reply({ type: 'gc-result', id: m.id, ok: true, status: 200, data });
      let u = null;
      try { u = new URL(String(m.url || ''), window.location.href); } catch (_) { u = null; }
      if (!u || u.origin !== window.location.origin || u.pathname.indexOf('/plugin-public/' + pluginId + '/') !== 0 || u.username || u.password) { answer({ ok: false, code: 'invalid' }); return; }
      const ua = navigator.userActivation;
      if (ua && ua.isActive !== true) { answer({ ok: false, code: 'no_gesture' }); return; }
      // with noopener the browser answers null even when it opened the tab: no way to tell a blocked one
      window.open(u.href, '_blank', 'noopener,noreferrer');
      answer({ ok: true });
    }

    // GC.scanQr: the page's own camera dialog, the frame gets the text only
    const scanOn = frame.getAttribute('data-plugin-scanqr') != null;
    let lastScan = 0;
    let lastAsk = 0;
    let myScan = null;
    function frameShown() {
      if (document.visibilityState && document.visibilityState !== 'visible') return false;
      if (frame.isConnected === false) return false;
      if (typeof frame.checkVisibility === 'function') return frame.checkVisibility();
      return !!(frame.getClientRects && frame.getClientRects().length);
    }
    function scan(m) {
      const answer = (text, code) => reply({ type: 'gc-result', id: m.id, ok: true, status: 200, data: { text: typeof text === 'string' ? text : null, code: code || null } });
      const Q = window.GCQrScan;
      if (!scanOn) { answer(null, 'not_allowed'); return; }
      if (!Q || typeof Q.open !== 'function') { answer(null, 'unsupported'); return; }
      const o = Q.normalize(m);
      if (!o.ok) { answer(null, 'invalid'); return; }
      if (!frameShown()) { answer(null, 'hidden'); return; }
      if (Q.active()) { answer(null, 'busy'); return; }
      const now = Date.now();
      if (now - lastScan < SCAN_GAP_MS) { answer(null, 'rate_limited'); return; }
      const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
      const gesture = !ua || ua.isActive === true; // a browser without the API: the dialog is the check
      if (!gesture && now - lastAsk < SCAN_NO_GESTURE_GAP_MS) { answer(null, 'no_gesture'); return; }
      lastScan = now;
      if (!gesture) lastAsk = now;
      const name = (frame.getAttribute('data-plugin-name') || pluginId).slice(0, 80);
      const run = Q.open({ name, hint: o.hint, accept: o.accept, timeoutMs: o.timeoutMs, gesture, visible: frameShown });
      myScan = run;
      run.promise.then((r) => {
        if (myScan === run) myScan = null;
        const text = r && typeof r.text === 'string' && r.text.length <= Q.MAX_TEXT ? r.text : null;
        answer(text, text ? null : ((r && r.code) || 'cancelled'));
      });
    }
    function endScan() { if (myScan) myScan.cancel('cancelled'); }

    // GC.pickPrincipals: the page's picker for groups and people, the frame gets the chosen entries only
    const pickOn = frame.getAttribute('data-plugin-groups') != null;
    let myPick = null;
    function pick(m) {
      const answer = (list) => reply({ type: 'gc-result', id: m.id, ok: true, status: 200, data: Array.isArray(list) ? list : null });
      const P = window.GCPrincipalPicker;
      if (!pickOn || !P || typeof P.open !== 'function' || !frameShown()) { answer(null); return; }
      const run = P.open({
        name: (frame.getAttribute('data-plugin-name') || pluginId).slice(0, 80),
        title: typeof m.title === 'string' ? m.title : '',
        groups: m.groups !== false, users: m.users === true, multiple: m.multiple === true,
        portal: base.indexOf('/api/v1/portal/') === 0,
      });
      myPick = run;
      run.promise.then((list) => { if (myPick === run) myPick = null; answer(list); }, () => { if (myPick === run) myPick = null; answer(null); });
    }
    function endPick() { if (myPick) { myPick.cancel(); myPick = null; } }

    function sendTheme() { reply({ type: 'gc-theme', theme: theme() }); }

    // GC.viewport: the height this frame can take without the page scrolling.
    // The end of the page's content (viewport coordinates): the lowest of
    // body's children with their bottom margins, plus body's own padding and
    // margin — not scrollHeight, which a body with min-height: 100vh (the
    // portal) never lets go below the window.
    function contentBottom() {
      const body = document.body;
      if (!body) return 0;
      let end = body.getBoundingClientRect().top;
      for (const el of body.children) {
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue;
        end = Math.max(end, el.getBoundingClientRect().bottom + (parseFloat(cs.marginBottom) || 0));
      }
      const bs = getComputedStyle(body);
      return end + (parseFloat(bs.paddingBottom) || 0) + (parseFloat(bs.borderBottomWidth) || 0) + (parseFloat(bs.marginBottom) || 0);
    }
    let lastView = '';
    function sendViewport(force) {
      if (!frame.isConnected || !frame.offsetParent) return; // not shown (another tab): later
      const r = frame.getBoundingClientRect();
      const top = r.top + window.scrollY;
      const below = Math.max(0, contentBottom() - r.bottom);
      const height = Math.max(200, Math.min(20000, Math.floor(window.innerHeight - top - below)));
      const width = Math.max(0, Math.floor(r.width));
      const key = height + 'x' + width;
      if (!force && key === lastView) return;
      lastView = key;
      reply({ type: 'gc-viewport', height, width });
    }
    let viewQueued = false;
    function viewSoon() {
      if (viewQueued) return;
      viewQueued = true;
      (window.requestAnimationFrame || setTimeout)(() => { viewQueued = false; sendViewport(false); });
    }
    window.addEventListener('resize', viewSoon);
    if (window.ResizeObserver) {
      // the frame itself (shown in another tab, its width) and what stands around it: body's children (a
      // banner above, a list below) — body alone would not do with min-height: 100vh
      const ro = new ResizeObserver(viewSoon);
      ro.observe(frame);
      if (document.body) {
        ro.observe(document.body);
        for (const el of document.body.children) ro.observe(el);
        new MutationObserver(() => { for (const el of document.body.children) ro.observe(el); viewSoon(); }).observe(document.body, { childList: true });
      }
    }

    // A dialog open in the frame (gc-modal): dim this page around the frame
    // the way the plugin dims its own frame, so the dialog reads as a dialog
    // of the whole page. A shadow of an element laid over the frame, above
    // everything and click-through, so the frame stays usable.
    let dim = null;
    function placeDim() {
      if (!dim) return;
      const r = frame.getBoundingClientRect();
      dim.style.top = r.top + 'px';
      dim.style.left = r.left + 'px';
      dim.style.width = r.width + 'px';
      dim.style.height = r.height + 'px';
    }
    function setModal(open) {
      if (open && !dim) {
        dim = document.createElement('div');
        dim.className = 'plugin-frame-dim';
        dim.setAttribute('aria-hidden', 'true');
        Object.assign(dim.style, {
          position: 'fixed', zIndex: '2147483000', pointerEvents: 'none',
          borderRadius: getComputedStyle(frame).borderRadius,
          boxShadow: '0 0 0 200vmax rgba(5, 8, 12, 0.55)',
        });
        document.body.appendChild(dim);
        placeDim();
        window.addEventListener('scroll', placeDim, true);
        window.addEventListener('resize', placeDim);
      } else if (!open && dim) {
        dim.remove();
        dim = null;
        window.removeEventListener('scroll', placeDim, true);
        window.removeEventListener('resize', placeDim);
      }
    }

    async function call(m) {
      const method = METHODS.indexOf(String(m.method)) >= 0 ? String(m.method) : null;
      const path = String(m.path || '').replace(/^\/+/, '');
      if (!method || path.length > 1000 || !PATH_RE.test(path) || path.split('/').indexOf('..') >= 0) {
        reply({ type: 'gc-result', id: m.id, ok: false, status: 400, error: 'invalid request' });
        return;
      }
      const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
      if (method !== 'GET') {
        opts.headers['X-CSRF-Token'] = csrf();
        // Only objects/arrays travel as JSON: the host's JSON parser is strict
        // and rejects a bare null, which a call without a body used to send.
        if (m.body && typeof m.body === 'object') {
          opts.headers['Content-Type'] = 'application/json';
          opts.body = JSON.stringify(m.body);
        }
      }
      try {
        const res = await fetch(base + path, opts);
        let data = null;
        try { data = await res.json(); } catch (_) { data = null; }
        reply({ type: 'gc-result', id: m.id, ok: res.ok, status: res.status, data, error: res.ok ? null : ((data && data.error) || ('HTTP ' + res.status)) });
      } catch (_) {
        reply({ type: 'gc-result', id: m.id, ok: false, status: 0, error: 'network error' });
      }
    }

    window.addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow || e.origin !== 'null') return;
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'gc-call' && Number.isInteger(m.id)) call(m);
      else if (m.type === 'gc-upload' && Number.isInteger(m.id)) upload(m);
      else if (m.type === 'gc-save' && Number.isInteger(m.id)) save(m);
      else if (m.type === 'gc-scan' && Number.isInteger(m.id)) scan(m);
      else if (m.type === 'gc-pick' && Number.isInteger(m.id)) pick(m);
      else if (m.type === 'gc-keys' && Number.isInteger(m.id)) keys(m);
      else if (m.type === 'gc-media-bytes' && Number.isInteger(m.id)) mediaBytes(m);
      else if (m.type === 'gc-open-tab' && Number.isInteger(m.id)) openTab(m);
      else if (m.type === 'gc-subscribe') setSubscribed(true);
      else if (m.type === 'gc-unsubscribe') setSubscribed(false);
      else if (m.type === 'gc-inbox-subscribe') setInbox(true);
      else if (m.type === 'gc-inbox-unsubscribe') setInbox(false);
      else if (m.type === 'gc-inbox-open') { if (inboxOn) askPage('gc:inbox-open'); }
      else if (m.type === 'gc-resize') {
        const h = Math.max(120, Math.min(20000, Number(m.height) || 0));
        frame.style.height = h + 'px';
        placeDim();
      } else if (m.type === 'gc-modal') setModal(m.open === true);
      else if (m.type === 'gc-hello') {
        // a new document in the frame (first load, reload): it subscribes again when it wants events
        setSubscribed(false);
        setInbox(false);
        endScan();
        endPick();
        sendTheme();
        sendViewport(true);
      }
      else if (m.type === 'gc-settings') {
        if (pluginId && !base.includes('/portal/')) window.location.assign('/settings/plugins/manage/' + encodeURIComponent(pluginId) + '?tab=settings');
      }
      else if (m.type === 'gc-nav') {
        const target = pages.find((p) => p === m.page);
        if (target && pluginId && !base.includes('/portal/')) window.location.assign('/plugins/' + encodeURIComponent(pluginId) + '/' + encodeURIComponent(target));
      }
    });
    frame.addEventListener('load', () => { setModal(false); sendTheme(); sendViewport(true); });
    new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function init() { document.querySelectorAll('iframe[data-plugin-frame]').forEach(attach); }
  // a frame a page adds later (the settings tab's ui.settingsPage frame, public/js/plugins-page.js)
  window.GCPluginBridge = Object.freeze({ attach });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
