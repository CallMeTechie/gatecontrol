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

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts allow-forms',
].join('; ');

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
  function size() { post({ type: 'gc-resize', height: Math.ceil(document.documentElement.scrollHeight) }); }
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
  window.addEventListener('load', size);
  post({ type: 'gc-hello' });
})();`;

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The full frame document around a plugin fragment. */
function document({ html, lang }) {
  const l = lang === 'en' ? 'en' : 'de';
  return '<!doctype html>\n<html lang="' + escAttr(l) + '" data-theme="dark"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">'
    + '<style>' + BASE_CSS + '</style><script>' + BRIDGE_CLIENT + '</script></head><body>'
    + String(html || '') + '</body></html>';
}

/** Headers of a frame response. */
function headers(res) {
  res.set('Content-Security-Policy', CSP);
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html');
}

module.exports = { CSP, document, headers, escAttr };
