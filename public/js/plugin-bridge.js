'use strict';

// Parent side of a plugin frame (docs/plugins.md "Oberfläche"). The frame is
// sandboxed (opaque origin, connect-src 'none'); it asks this page to call
// its plugin's API (window.GC.call inside the frame → postMessage). Only
// messages from the frame's own window are taken, only relative paths below
// that plugin's API base are called, with this page's session and CSRF token.
// Used by the admin plugin page (plugin.njk) and the portal (portal.njk).
(function () {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
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

    function sendTheme() { reply({ type: 'gc-theme', theme: theme() }); }

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
      else if (m.type === 'gc-resize') {
        const h = Math.max(120, Math.min(20000, Number(m.height) || 0));
        frame.style.height = h + 'px';
      } else if (m.type === 'gc-hello') sendTheme();
      else if (m.type === 'gc-nav') {
        const target = pages.find((p) => p === m.page);
        if (target && pluginId && !base.includes('/portal/')) window.location.assign('/plugins/' + encodeURIComponent(pluginId) + '/' + encodeURIComponent(target));
      }
    });
    frame.addEventListener('load', sendTheme);
    new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function init() { document.querySelectorAll('iframe[data-plugin-frame]').forEach(attach); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
