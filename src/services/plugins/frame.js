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
//   * img-src https://tile.openstreetmap.org — OpenStreetMap tiles;
//   * the host's vendored Leaflet (public/vendor/leaflet) from
//     /plugins/_shared/leaflet/{leaflet.js, leaflet.css, images/} — exactly
//     these URLs of this server's origin are allowed (script-src / style-src
//     / img-src with a path; 'self' would mean every script of the server);
//   * Referrer-Policy strict-origin-when-cross-origin: the tiles get the
//     origin only (OpenStreetMap's tile policy wants a referrer), never the
//     frame URL;
//   * sandbox + allow-popups allow-popups-to-escape-sandbox: a plain
//     <a href="https://www.openstreetmap.org/…" target="_blank" rel="noopener">
//     opens in a new tab as a normal page.
//
// Profile pictures (docs/feature-avatars.md): gc.users hands out avatarUrl
// (/avatars/<id>.<ext>); every plugin frame (admin page, portal tab, wall)
// may show them — img-src <origin>/avatars/ (this origin, this path only;
// nothing else of the server). The pictures need no cookie.

const OSM_TILES = 'https://tile.openstreetmap.org';
const SHARED_LEAFLET = '/plugins/_shared/leaflet/';
const AVATARS = '/avatars/';
const SANDBOX = 'sandbox allow-scripts allow-forms';
const SANDBOX_MAPS = SANDBOX + ' allow-popups allow-popups-to-escape-sandbox';

function directives({ script = [], style = [], img = [], sandbox = SANDBOX } = {}) {
  return [
    "default-src 'none'",
    ["script-src 'unsafe-inline'", ...script].join(' '),
    ["style-src 'unsafe-inline'", ...style].join(' '),
    ['img-src data:', ...img].join(' '),
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
// the tiles but no shared Leaflet). The value goes into a header: nothing
// but host characters passes.
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
function originOf(req) {
  const proto = req && (req.protocol === 'https' ? 'https' : (req.protocol === 'http' ? 'http' : null));
  const host = req && typeof req.get === 'function' ? req.get('host') : null;
  return proto && typeof host === 'string' && host.length <= 260 && HOST_RE.test(host) ? `${proto}://${host.toLowerCase()}` : null;
}

/**
 * The frame CSP: the base one, with maps for a `ui.maps` plugin, with the
 * profile pictures of this origin (`avatars` + a known `origin`).
 */
function cspFor({ maps = false, origin = null, avatars = false } = {}) {
  const pics = avatars && origin ? [origin + AVATARS] : [];
  if (!maps) return pics.length ? directives({ img: pics }) : CSP;
  const base = origin ? origin + SHARED_LEAFLET : null;
  return directives({
    script: base ? [base + 'leaflet.js'] : [],
    style: base ? [base + 'leaflet.css'] : [],
    img: [OSM_TILES, ...(base ? [base + 'images/'] : []), ...pics],
    sandbox: SANDBOX_MAPS,
  });
}

/** sandbox attribute of the <iframe> showing a plugin frame. */
function sandboxAttr(maps) { return (maps ? SANDBOX_MAPS : SANDBOX).replace(/^sandbox /, ''); }

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
  var seq = 0, pending = {};
  function post(msg){ try { window.parent.postMessage(msg, '*'); } catch (e) { /* no parent */ } }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'gc-result' && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.ok) p.resolve(m.data); else p.reject(Object.assign(new Error(m.error || 'request failed'), { status: m.status, data: m.data }));
    } else if (m.type === 'gc-theme') {
      document.documentElement.setAttribute('data-theme', m.theme === 'light' ? 'light' : 'dark');
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
  window.GC = Object.freeze({
    call: call,
    get: function (p) { return call('GET', p); },
    post: function (p, b) { return call('POST', p, b); },
    put: function (p, b) { return call('PUT', p, b); },
    del: function (p) { return call('DELETE', p); },
    navigate: function (page) { post({ type: 'gc-nav', page: String(page || '') }); },
    lang: document.documentElement.lang || 'de'
  });
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

/** The full frame document around a plugin fragment. */
function document({ html, lang, maps = false }) {
  const l = lang === 'en' ? 'en' : 'de';
  return '<!doctype html>\n<html lang="' + escAttr(l) + '" data-theme="dark"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="' + (maps ? REFERRER_MAPS : REFERRER) + '">'
    + '<style>' + BASE_CSS + '</style><script>' + BRIDGE_CLIENT + '</script></head><body>'
    + String(html || '') + '</body></html>';
}

/**
 * Headers of a frame response. `opts.maps` (plugin with ui.maps) with
 * `opts.origin` (originOf(req)) relaxes the CSP for the map, `opts.avatars`
 * with `opts.origin` allows the profile pictures, see above.
 */
function headers(res, opts = {}) {
  res.set('Content-Security-Policy', cspFor(opts));
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', opts.maps ? REFERRER_MAPS : REFERRER);
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html');
}

module.exports = { CSP, cspFor, originOf, sandboxAttr, document, headers, escAttr, OSM_TILES, SHARED_LEAFLET, AVATARS };
