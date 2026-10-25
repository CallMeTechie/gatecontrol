'use strict';

// The document a plugin page or portal tab is shown in (docs/plugins.md
// "Oberfläche"). Plugin HTML is untrusted, so it never becomes part of a
// GateControl page: it is served on its own URL with
//   * CSP `sandbox allow-scripts allow-forms` (+ the iframe's sandbox
//     attribute): an opaque origin — no cookies, no storage, no access to
//     the GateControl page or its session, even when the URL is opened
//     directly in a tab;
//   * connect-src 'none', form-action 'none': the frame cannot talk to any
//     server; it asks the parent page instead (window.GC.call → postMessage),
//     and the parent (public/js/plugin-bridge.js) calls this plugin's own
//     API with the user's session, CSRF token and rate limit.
// The host adds a small base stylesheet (aurora colours for light and dark)
// and the bridge client below; the plugin's fragment goes into <body>.
//
// Maps (plugin.json `ui.maps: true`, docs/plugins.md "Maps"), for those
// plugins' frames only:
//   * img-src <origin>/plugins/_shared/tiles/ — OpenStreetMap tiles through
//     this server (tiles.js), the frame finds the URL template in
//     window.GC.tiles. Loaded directly, OpenStreetMap answers 403: the frame
//     has an opaque origin, and Chromium sends no Referer from one, whatever
//     the Referrer-Policy says;
//   * img-src https://tile.openstreetmap.org — still allowed for plugins
//     that load the tiles directly;
//   * the host's vendored Leaflet (public/vendor/leaflet) from
//     /plugins/_shared/leaflet/{leaflet.js, leaflet.css, images/} — exactly
//     these URLs of this server's origin are allowed (script-src / style-src
//     / img-src with a path; 'self' would mean every script of the server);
//   * Referrer-Policy strict-origin-when-cross-origin: never the frame URL
//     (Chromium sends none at all from the opaque origin, see above);
//   * sandbox + allow-popups allow-popups-to-escape-sandbox: a plain
//     <a href="https://www.openstreetmap.org/…" target="_blank" rel="noopener">
//     opens in a new tab as a normal page.
//
// Profile pictures (docs/feature-avatars.md): gc.users hands out avatarUrl
// (/avatars/<id>.<ext>); every plugin frame (admin page, portal tab, wall)
// may show them — img-src <origin>/avatars/ (this origin, this path only;
// nothing else of the server). The pictures need no cookie.
//
// Media (plugin.json `media`, docs/plugins.md "Media"), for those plugins'
// frames only: img-src and media-src <origin>/plugin-media/ — the signed
// capability URLs of gc.media.url (pictures, voice messages; no cookie).
// window.GC.upload(file) hands a file to the parent page, which uploads it
// with the session (public/js/plugin-bridge.js); the parent's <iframe> gets
// allow="microphone *" for such plugins (voice recording in the portal).
// Their sandbox (CSP and <iframe> attribute alike) adds allow-downloads: a
// file that is no picture, audio or video is answered as a download
// (Content-Disposition: attachment), which a sandbox without that flag
// silently drops. Nothing else of the sandbox changes.
//
// Realtime events (permissions.events): window.GC.on('event', fn) — the
// parent page holds the plugin's event stream and passes each event on.
//
// Location (plugin.json `ui.geolocation`): the parent's <iframe> gets
// allow="geolocation *", so navigator.geolocation works in the frame — the
// browser still asks the person (for GateControl's origin). Nothing in the
// CSP or the sandbox changes; without the flag the Permissions Policy keeps
// the frame from asking at all.
//
// Camera (plugin.json `ui.camera`, since 1.188.0): the parent's <iframe> gets
// allow="camera *" (after microphone / geolocation). Chromium (Chrome, Edge,
// Android) still refuses getUserMedia in the sandboxed frame ("SecurityError:
// Invalid security origin" — the frame's origin is opaque), so the flag also
// grants GC.scanQr (below) since 1.196.0.
//
// QR codes (plugin.json `ui.scanQr`, or `ui.camera`; since 1.196.0):
// window.GC.scanQr({ hint, accept, timeout }) → { text, code }. The frame never
// gets the camera: it asks the parent page (gc-scan), and GateControl's own
// page (its origin, a secure context) opens its camera dialog
// (public/js/qr-scan.js), reads the code there and answers only the text.
// The frame document has GC.scanQr only for such plugins (scanQrOf), and the
// parent only takes the request from an <iframe data-plugin-scanqr> — an
// attribute the server renders, which the frame cannot set.
//
// Inbox (plugin.json `ui.inbox`, portal frames only): window.GC.inbox.on(fn)
// gets { available, unread, latest: { title, createdAt, priority } | null }
// of the viewer's own notification inbox — the portal page's own state
// (public/js/portal.js), handed on by the parent (plugin-bridge.js): never
// another person's inbox, never bodies or data of the notifications, and no
// way to change anything there. GC.inbox.open() asks the portal to show its
// own inbox (#mitteilungen). Frames of other plugins, the admin pages and a
// portal without the notification center get { available: false }.

const OSM_TILES = 'https://tile.openstreetmap.org';
const SHARED_LEAFLET = '/plugins/_shared/leaflet/';
const SHARED_TILES = '/plugins/_shared/tiles/';
const AVATARS = '/avatars/';
const PLUGIN_MEDIA = '/plugin-media/';
const SANDBOX = 'sandbox allow-scripts allow-forms';
const SANDBOX_MAPS = SANDBOX + ' allow-popups allow-popups-to-escape-sandbox';
const SANDBOX_DOWNLOADS = ' allow-downloads';

/** The CSP sandbox directive: the base flags, + popups for maps, + downloads for media. */
function sandboxOf(maps, media) { return (maps ? SANDBOX_MAPS : SANDBOX) + (media ? SANDBOX_DOWNLOADS : ''); }

function directives({ script = [], style = [], img = [], media = [], sandbox = SANDBOX } = {}) {
  return [
    "default-src 'none'",
    ["script-src 'unsafe-inline'", ...script].join(' '),
    ["style-src 'unsafe-inline'", ...style].join(' '),
    ['img-src data:', ...img].join(' '),
    ...(media.length ? [['media-src', ...media].join(' ')] : []),
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    sandbox,
  ].join('; ');
}

const CSP = directives();

// "https://gc.example.com[:port]" of the request that loads the frame, or
// null when the Host header is not a plain host[:port] (then the frame gets
// the direct tiles but no shared Leaflet and no tile relay). The value goes
// into a header: nothing but host characters passes.
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
function originOf(req) {
  const proto = req && (req.protocol === 'https' ? 'https' : (req.protocol === 'http' ? 'http' : null));
  const host = req && typeof req.get === 'function' ? req.get('host') : null;
  return proto && typeof host === 'string' && host.length <= 260 && HOST_RE.test(host) ? `${proto}://${host.toLowerCase()}` : null;
}

/**
 * The frame CSP: the base one, with maps for a `ui.maps` plugin, with the
 * profile pictures of this origin (`avatars` + a known `origin`), with the
 * plugin media of this origin (`media` + a known `origin`).
 */
function cspFor({ maps = false, origin = null, avatars = false, media = false } = {}) {
  const mediaSrc = media && origin ? [origin + PLUGIN_MEDIA] : [];
  const pics = [...(avatars && origin ? [origin + AVATARS] : []), ...mediaSrc];
  if (!maps) return pics.length || media ? directives({ img: pics, media: mediaSrc, sandbox: sandboxOf(false, media) }) : CSP;
  const base = origin ? origin + SHARED_LEAFLET : null;
  return directives({
    script: base ? [base + 'leaflet.js'] : [],
    style: base ? [base + 'leaflet.css'] : [],
    img: [OSM_TILES, ...(base ? [base + 'images/', origin + SHARED_TILES] : []), ...pics],
    media: mediaSrc,
    sandbox: sandboxOf(true, media),
  });
}

/**
 * The allow attribute of the <iframe> showing a plugin frame: microphone for a
 * `media` plugin, geolocation for `ui.geolocation`, camera for `ui.camera`
 * ('' when none — then the iframe gets no allow attribute).
 */
function allowAttr({ media = false, geolocation = false, camera = false } = {}) {
  return [media && 'microphone *', geolocation && 'geolocation *', camera && 'camera *'].filter(Boolean).join('; ');
}

/** May the plugin's frames read QR codes through the page (GC.scanQr)? `ui.scanQr`, or the older `ui.camera`. */
function scanQrOf(manifest) {
  const ui = manifest && manifest.ui;
  return !!(ui && (ui.scanQr === true || ui.camera === true));
}

/** sandbox attribute of the <iframe> showing a plugin frame (`media`: a plugin declaring media). */
function sandboxAttr(maps, media = false) { return sandboxOf(maps, media).replace(/^sandbox /, ''); }

const BASE_CSS = `
:root{color-scheme:dark;--bg:#0a0e14;--surface:#111a24;--surface-2:#0f1720;--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.14);
--text:#e9eff6;--muted:#9aaabb;--accent:#34dcc6;--accent-soft:rgba(52,220,198,.12);--good:#4ade80;--warn:#f5c451;--crit:#ff8585;
--btn-bg:linear-gradient(145deg,#34dcc6,#1f9c8e);--btn-text:#04201d;--radius:14px;
--font:"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,monospace}
:root[data-theme="light"]{color-scheme:light;--bg:#f3efe6;--surface:#fffdf8;--surface-2:#f6f1e7;--line:rgba(60,45,25,.10);--line-2:rgba(60,45,25,.18);
--text:#2c2720;--muted:#6e6456;--accent:#0b7d70;--accent-soft:rgba(14,155,138,.10);--good:#0f7a41;--warn:#8a5f10;--crit:#b52f2f;
--btn-bg:#0b7d70;--btn-text:#fff}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--text);font:14px/1.5 var(--font)}
a{color:var(--accent)}
h1,h2,h3{margin:0 0 .5em;line-height:1.2}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px}
.muted{color:var(--muted)}
button,.btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--line-2);
background:transparent;color:var(--text);font:600 13px var(--font);cursor:pointer}
button.primary,.btn.primary{background:var(--btn-bg);color:var(--btn-text);border:0}
input,select,textarea{min-height:38px;padding:0 10px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);font:14px var(--font)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line)}
`;

// Runs inside the sandboxed frame. Talks to window.parent only.
const BRIDGE_CLIENT = `(function(){
  var seq = 0, pending = {}, listeners = [], inboxListeners = [], inboxLast = null, viewport = null;
  function post(msg){ try { window.parent.postMessage(msg, '*'); } catch (e) { /* no parent */ } }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'gc-result' && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (p.timer) clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data); else p.reject(Object.assign(new Error(m.error || 'request failed'), { status: m.status, data: m.data }));
    } else if (m.type === 'gc-upload-progress' && pending[m.id] && pending[m.id].progress) {
      try { pending[m.id].progress({ loaded: Number(m.loaded) || 0, total: Number(m.total) || 0 }); } catch (e) { /* the plugin's callback */ }
    } else if (m.type === 'gc-event' && m.event && typeof m.event === 'object') {
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](m.event); } catch (e) { /* the plugin's listener */ } }
    } else if (m.type === 'gc-inbox' && m.inbox && typeof m.inbox === 'object') {
      inboxLast = m.inbox;
      var ls = inboxListeners.slice();
      for (var k = 0; k < ls.length; k++) { try { ls[k](m.inbox); } catch (e) { /* the plugin's listener */ } }
    } else if (m.type === 'gc-theme') {
      document.documentElement.setAttribute('data-theme', m.theme === 'light' ? 'light' : 'dark');
    } else if (m.type === 'gc-viewport') {
      // since 1.199.0: the height this frame can take without the page scrolling
      var vh = Math.floor(Number(m.height)), vw = Math.floor(Number(m.width));
      if (!(vh >= 200 && vh <= 20000)) return;
      viewport = Object.freeze({ height: vh, width: vw >= 0 && vw <= 20000 ? vw : 0 });
      document.documentElement.style.setProperty('--gc-viewport-height', vh + 'px');
      try { window.dispatchEvent(new CustomEvent('gc:viewport', { detail: viewport })); } catch (e) { /* old browsers */ }
    }
  });
  function call(method, path, body) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      post({ type: 'gc-call', id: id, method: String(method || 'GET').toUpperCase(), path: String(path || ''), body: body === undefined ? null : body });
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, 60000);
    });
  }
  // plugin.json media: the parent page uploads the file with the session → { mediaId, mime, bytes }
  function upload(file, opts) {
    return new Promise(function (resolve, reject) {
      if (typeof Blob === 'undefined' || !(file instanceof Blob)) { reject(new Error('GC.upload needs a File or Blob')); return; }
      var id = ++seq;
      var progress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
      pending[id] = { resolve: resolve, reject: reject, progress: progress };
      pending[id].timer = setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, 15 * 60000);
      post({ type: 'gc-upload', id: id, file: file, mime: String(file.type || ''), progress: !!progress });
    });
  }
  // since 1.186.0: hand a file (Blob) to the page, which offers it as a download → { ok: true }
  function saveFile(file, name) {
    return new Promise(function (resolve, reject) {
      if (typeof Blob === 'undefined' || !(file instanceof Blob)) { reject(new Error('GC.saveFile needs a Blob')); return; }
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      pending[id].timer = setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, 60000);
      post({ type: 'gc-save', id: id, file: file, name: String(name == null ? '' : name) });
    });
  }
  // ui.scanQr (since 1.196.0): GateControl's page reads a QR code with its camera → { text, code }.
  // Never rejects: text is the code's content, or null with a code (cancelled, timeout, denied, …).
  function scanQr(opts) {
    return new Promise(function (resolve) {
      var o = opts && typeof opts === 'object' ? opts : {};
      var accept = o.accept == null ? [] : (Array.isArray(o.accept) ? o.accept : [o.accept]);
      var id = ++seq;
      var done = function (d) { resolve({ text: d && typeof d.text === 'string' ? d.text : null, code: d && d.code ? String(d.code) : (d && typeof d.text === 'string' ? null : 'failed') }); };
      pending[id] = { resolve: done, reject: function (e) { done({ code: (e && e.data && e.data.code) || 'failed' }); } };
      pending[id].timer = setTimeout(function () { if (pending[id]) { delete pending[id]; done({ code: 'timeout' }); } }, 11 * 60000);
      post({ type: 'gc-scan', id: id, hint: o.hint == null ? '' : String(o.hint), accept: accept.map(function (a) { return String(a); }), timeout: Number(o.timeout) || 0 });
    });
  }
  // permissions.events: realtime events of the plugin ({ plugin, type, data })
  function on(name, fn) {
    if (name !== 'event' || typeof fn !== 'function') return;
    if (listeners.indexOf(fn) < 0) listeners.push(fn);
    if (listeners.length === 1) post({ type: 'gc-subscribe' });
  }
  function off(name, fn) {
    var i = listeners.indexOf(fn);
    if (name === 'event' && i >= 0) listeners.splice(i, 1);
    if (name === 'event' && i >= 0 && !listeners.length) post({ type: 'gc-unsubscribe' });
  }
  // ui.inbox: the viewer's inbox summary ({ available, unread, latest }) and a way to open it
  var inbox = Object.freeze({
    on: function (fn) {
      if (typeof fn !== 'function' || inboxListeners.indexOf(fn) >= 0) return;
      inboxListeners.push(fn);
      if (inboxListeners.length === 1) post({ type: 'gc-inbox-subscribe' });
      else if (inboxLast) { var last = inboxLast; setTimeout(function () { try { fn(last); } catch (e) { /* the plugin's listener */ } }, 0); }
    },
    off: function (fn) {
      var i = inboxListeners.indexOf(fn);
      if (i < 0) return;
      inboxListeners.splice(i, 1);
      if (!inboxListeners.length) { inboxLast = null; post({ type: 'gc-inbox-unsubscribe' }); }
    },
    open: function () { post({ type: 'gc-inbox-open' }); }
  });
  // Height of the frame content: the document's own height (scrollHeight is
  // never below the frame's current height, so the frame could not shrink
  // again), plus fixed elements (a plugin's own dialogs), which count towards
  // neither: an open dialog taller than the page would be cut off by the frame.
  // A visible fixed element covering the frame is a dialog backdrop: the
  // parent then dims its own page around the frame (gc-modal).
  var modal = false;
  function height() {
    var h = document.documentElement.offsetHeight;
    var m = false;
    var all = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i], cs = window.getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      h = Math.max(h, Math.max(0, r.top) + el.scrollHeight);
      if (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9) m = true;
    }
    modal = m;
    return Math.ceil(h);
  }
  var queued = false, last = -1, lastModal = false;
  function size() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () {
      queued = false;
      var h = height();
      if (h !== last) { last = h; post({ type: 'gc-resize', height: h }); }
      if (modal !== lastModal) { lastModal = modal; post({ type: 'gc-modal', open: modal }); }
    });
  }
  var api = {
    call: call,
    get: function (p) { return call('GET', p); },
    post: function (p, b) { return call('POST', p, b); },
    put: function (p, b) { return call('PUT', p, b); },
    del: function (p) { return call('DELETE', p); },
    navigate: function (page) { post({ type: 'gc-nav', page: String(page || '') }); },
    // since 1.185.0: the plugin's settings (Einstellungen › Plugins › <plugin> › Einstellungen); admin pages only
    openSettings: function () { post({ type: 'gc-settings' }); },
    upload: upload,
    saveFile: saveFile,
    on: on,
    off: off,
    inbox: inbox,
    lang: document.documentElement.lang || 'de',
    // since 1.199.0: { height, width } — what the frame can take without the page scrolling (null until known)
    get viewport() { return viewport; },
    tiles: /*GC_TILES*/null
  };
  if (/*GC_SCANQR*/false) api.scanQr = scanQr;
  window.GC = Object.freeze(api);
  if (window.ResizeObserver) new ResizeObserver(size).observe(document.documentElement);
  // a dialog shown or hidden changes no document size: watch the DOM as well
  if (window.MutationObserver) new MutationObserver(size).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open'] });
  window.addEventListener('load', size);
  post({ type: 'gc-hello' });
})();`;

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const REFERRER = 'no-referrer';
const REFERRER_MAPS = 'strict-origin-when-cross-origin';

// window.GC.tiles of a maps frame: the tile relay's URL template (tiles.js
// template(): a path of this server). Nothing but path characters passes, so
// it is safe inside the script.
const TILES_RE = /^\/plugins\/_shared\/tiles\/[A-Za-z0-9._-]+\/\{z\}\/\{x\}\/\{y\}\.png$/;

/**
 * The full frame document around a plugin fragment. `tiles` (maps frames
 * only) becomes window.GC.tiles, otherwise GC.tiles is null; `scanQr`
 * (scanQrOf the plugin) gives the frame window.GC.scanQr.
 */
function document({ html, lang, maps = false, tiles = null, scanQr = false }) {
  const l = lang === 'en' ? 'en' : 'de';
  const t = maps && typeof tiles === 'string' && TILES_RE.test(tiles) ? JSON.stringify(tiles) : 'null';
  const client = BRIDGE_CLIENT.replace('/*GC_TILES*/null', () => t).replace('/*GC_SCANQR*/false', scanQr === true ? 'true' : 'false');
  return '<!doctype html>\n<html lang="' + escAttr(l) + '" data-theme="dark"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="' + (maps ? REFERRER_MAPS : REFERRER) + '">'
    + '<style>' + BASE_CSS + '</style><script>' + client + '</script></head><body>'
    + String(html || '') + '</body></html>';
}

/**
 * Headers of a frame response. `opts.maps` (plugin with ui.maps) with
 * `opts.origin` (originOf(req)) relaxes the CSP for the map, `opts.avatars`
 * with `opts.origin` allows the profile pictures, `opts.media` with
 * `opts.origin` the plugin's media URLs, see above.
 */
function headers(res, opts = {}) {
  res.set('Content-Security-Policy', cspFor(opts));
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', opts.maps ? REFERRER_MAPS : REFERRER);
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html');
}

module.exports = { CSP, cspFor, originOf, sandboxAttr, allowAttr, scanQrOf, document, headers, escAttr, OSM_TILES, SHARED_LEAFLET, SHARED_TILES, AVATARS, PLUGIN_MEDIA };
