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

    function sendTheme() { reply({ type: 'gc-theme', theme: theme() }); }

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
        sendTheme();
      }
      else if (m.type === 'gc-settings') {
        if (pluginId && !base.includes('/portal/')) window.location.assign('/settings/plugins/manage/' + encodeURIComponent(pluginId) + '?tab=settings');
      }
      else if (m.type === 'gc-nav') {
        const target = pages.find((p) => p === m.page);
        if (target && pluginId && !base.includes('/portal/')) window.location.assign('/plugins/' + encodeURIComponent(pluginId) + '/' + encodeURIComponent(target));
      }
    });
    frame.addEventListener('load', () => { setModal(false); sendTheme(); });
    new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function init() { document.querySelectorAll('iframe[data-plugin-frame]').forEach(attach); }
  // a frame a page adds later (the settings tab's ui.settingsPage frame, public/js/plugins-page.js)
  window.GCPluginBridge = Object.freeze({ attach });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
