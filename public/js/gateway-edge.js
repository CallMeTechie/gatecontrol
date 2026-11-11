'use strict';

// Gateway detail › tabs "Edge-Plugins" and "MQTT" (docs/plugins.md "Edge part"
// › "Administration"). gateways.js builds the detail view and asks this module
// for the tab bar and the two panels; the data comes from the admin API
// /api/v1/edge/gateways/:id (session + CSRF, routes/api/edge.js).
//
//   window.GCGatewayEdge.tabs(g, tab)            → the tab bar (role=tablist)
//   window.GCGatewayEdge.mount(box, g, tab, ctx) → fills `box` with the panel of `tab`
//   window.GCGatewayEdge.prefetch(g)             → loads the data for the tab badges
//
// Pure rules (states, MQTT names/topics, the memory hint) live in
// gateway-edge-kit.js. Dialogs are window.GCDialog frames; nothing here uses
// innerHTML, and a password shown once lives only in the dialog that shows it.
(function () {
  const K = window.GCGatewayEdgeKit;
  const D = window.GCDialog;
  if (!K || !D) return;
  const h = D.el;
  let ISLAND = {};
  try { ISLAND = JSON.parse((document.getElementById('gwiz-i18n') || {}).textContent || '{}') || {}; } catch (e) { ISLAND = {}; }
  const LANG = (window.GC && window.GC.language) === 'en' ? 'en' : 'de';
  const GW_RELEASES = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';
  const API = '/api/v1/edge/gateways/';

  function t(key, params) {
    const dict = (window.GC && window.GC.t) || {};
    let s = dict[key] != null ? dict[key] : (ISLAND[key] != null ? ISLAND[key] : key);
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function csrf() { return (window.GC && window.GC.csrfToken) || ''; }
  function toast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type || 'success'); }

  // ─── API ──────────────────────────────────────────────────────────────
  function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') opts.headers['X-CSRF-Token'] = csrf();
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then((r) => r.json().catch(() => ({})).then((j) => {
      if (!r.ok || (j && j.ok === false)) {
        const e = new Error((j && j.error) || ('HTTP ' + r.status));
        e.code = (j && (j.code || (j.error === 'session_required' ? 'session_required' : null))) || null;
        e.status = r.status;
        e.body = j || {};
        throw e;
      }
      return j;
    }), () => { const e = new Error('network'); e.code = 'network'; throw e; });
  }
  function errText(e) { return t(K.errorKey(e && e.code, e && e.status)); }
  function gwUrl(id, rest) { return API + encodeURIComponent(String(id)) + (rest || ''); }

  // ─── Icons (DOM-built SVG) ────────────────────────────────────────────
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    check: [['path', { d: 'm5 12 5 5 9-10' }]],
    info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 8v5M12 16h.01' }]],
    warn: [['path', { d: 'M12 3 3 20h18z' }], ['path', { d: 'M12 10v4M12 17h.01' }]],
    x: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'm9 9 6 6M15 9l-6 6' }]],
    plug: [['path', { d: 'M9 3v5M15 3v5' }], ['path', { d: 'M6 8h12v3a6 6 0 0 1-12 0z' }], ['path', { d: 'M12 17v4' }]],
    key: [['circle', { cx: 7.5, cy: 15.5, r: 4.5 }], ['path', { d: 'm10.7 12.3 9.8-9.8M16 7l3 3M19 4l2 2' }]],
    lock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
    unlock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 7.5-2' }]],
    trash: [['path', { d: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6' }]],
    shield: [['path', { d: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z' }]],
    list: [['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]],
    up: [['path', { d: 'M12 19V5M5 12l7-7 7 7' }]],
    power: [['path', { d: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0' }]],
    radio: [['circle', { cx: 12, cy: 12, r: 2 }], ['path', { d: 'M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  };
  function icon(name, size) {
    const s = document.createElementNS(SVG_NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', String(size || 16)], ['height', String(size || 16)], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['focusable', 'false']]
      .forEach((a) => s.setAttribute(a[0], a[1]));
    (ICONS[name] || []).forEach((p) => {
      const n = document.createElementNS(SVG_NS, p[0]);
      Object.keys(p[1]).forEach((k) => n.setAttribute(k, String(p[1][k])));
      s.appendChild(n);
    });
    return s;
  }

  // ─── Small building blocks ────────────────────────────────────────────
  function tag(tone, text, dot) { return h('span', { class: 'tag tag-' + tone + (dot ? ' tag-dot' : ''), text }); }
  function card(title, right, opts) {
    const o = opts || {};
    const id = 'gwe-h-' + (o.id || Math.random().toString(36).slice(2, 8));
    const top = h('div', { class: 'top gwe-top' }, [h('h3', { id, text: title }), right || null]);
    const body = h('div', { class: 'body gwe-body' });
    const c = h('section', { class: 'gw gwe-card' + (o.full ? ' full' : '') + (o.cls ? ' ' + o.cls : ''), 'aria-labelledby': id }, [top, body]);
    return { card: c, top, body };
  }
  function note(tone, children, ic) {
    return h('div', { class: 'gwe-note gwe-note-' + tone }, [icon(ic || (tone === 'warn' || tone === 'crit' ? 'warn' : 'info'), 18), h('div', { class: 'gwe-note-t' }, children)]);
  }
  // help topic → heading of the handbook inside the app (the page's island, services/gatewayHandbook.js topicAnchors)
  let HB_TOPICS = {};
  try { HB_TOPICS = JSON.parse((document.getElementById('gw-handbook-topics') || {}).textContent || '{}') || {}; } catch (_) { HB_TOPICS = {}; }
  let guideGw = null; // the gateway whose tab is open (mount): "Anleitung" opens its handbook

  // Where "Anleitung" leads: the handbook of the Gateways page at the heading of the topic
  // (#gw/<id>/handbook/<anchor>, gateway-docs.js) — in a new tab, so the tab or dialog it was
  // asked from stays as it is. A topic that is not part of it: the user guide (public/js/handbook.js).
  function guideUrl(topic) {
    const DK = window.GCGatewayDocsKit;
    const hash = DK && DK.topicHash ? DK.topicHash(guideGw, topic, HB_TOPICS) : null;
    if (hash) return location.pathname + hash;
    return window.GCHandbook ? window.GCHandbook.url(topic, LANG) : null;
  }
  // A quiet "Anleitung" link; null for an unknown topic.
  function guide(topic, cls) {
    const url = guideUrl(topic);
    return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls || null, 'data-guide': topic, text: t('gwe.reason.guide') }) : null;
  }
  function chip(tone, text, ic) { return h('span', { class: 'gwe-chip' + (tone ? ' gwe-chip-' + tone : '') }, [ic ? icon(ic, 14) : null, text]); }
  function switchBtn(on, label, fk, onClick, disabled) {
    return h('button', {
      type: 'button', class: 'st-switch gwe-switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label,
      'data-fk': fk, disabled: !!disabled, on: onClick ? { click: onClick } : null,
    }, h('span', { class: 'st-knob', 'aria-hidden': 'true' }));
  }
  function fmtTime(iso, withSeconds) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const sameDay = new Date().toDateString() === d.toDateString();
    const time = d.toLocaleTimeString(LANG === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined });
    return sameDay ? time : d.toLocaleDateString(LANG === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + time;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(LANG === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function copyText(text, btn) {
    const done = () => {
      if (!btn) return;
      const old = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', old);
      btn.textContent = t('gwe.copied');
      setTimeout(() => { btn.textContent = old; }, 1600);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* not possible */ }
      ta.value = '';
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  function copyBtn(getText, label) {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm gwe-copy', 'aria-label': label || null, text: t('gwe.copy') });
    b.addEventListener('click', () => copyText(getText(), b));
    return b;
  }
  // Tab stays inside an open dialog (GCDialog brings Escape and focus return).
  function trapFocus(d) {
    d.box.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...d.box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  function openDialog(opts) {
    const d = D.dialog(opts);
    d.box.classList.add('gwe-dlg');
    if (opts.cls) d.box.classList.add(opts.cls);
    trapFocus(d);
    // the panel may have been drawn anew meanwhile: back to the same control there
    if (opts.returnFk) {
      d.promise.then(() => setTimeout(() => {
        if (cur && (!document.activeElement || document.activeElement === document.body)) restoreFocus(cur.box, opts.returnFk);
      }, 0));
    }
    return d;
  }
  function errorBox() { const n = h('div', { class: 'gwe-err', role: 'alert' }); n.hidden = true; return n; }
  function showErr(box, msg) { box.textContent = msg || ''; box.hidden = !msg; }

  // ─── "Nur docker-compose.yml herunterladen" ───────────────────────────
  // The assistant's compose for this gateway (POST /api/v1/gateways/:id/compose, gateway-kit.js
  // buildCompose): no new keys, no gateway.env — the gateway stays connected. Renews an old compose
  // without edge/mqtt/cache. Opened from the edge card (edge_missing) and the gateway page head
  // (gateways.js, window.GCGatewayCompose).
  const COMPOSE_PLATFORM = { synology: 'synology', linux: 'linux', proxmox: 'linux' };
  function composePlatform(g) {
    if (COMPOSE_PLATFORM[g.platform]) return COMPOSE_PLATFORM[g.platform];
    // older gateway without a stored platform: DSM kernels end in "+" (4.4.302+) — only a preselection
    const rel = String(((g.health && g.health.telemetry) || {}).os_release || '');
    return /\+$/.test(rel) ? 'synology' : 'linux';
  }
  const COMPOSE_LINUX_CMD = 'cd /opt/gatecontrol-gateway\nsudo cp docker-compose.yml docker-compose.yml.bak\n'
    + 'sudo mv ~/docker-compose.yml .\nsudo mkdir -p gateway-state gateway-cache\nsudo docker compose up -d';
  function composeSteps(platform) {
    if (platform === 'synology') {
      return h('ol', { class: 'gwz-st' }, [1, 2, 3, 4].map((n) => h('li', null, [h('p', { text: t('gwe.compose.syn_' + n) })])));
    }
    return h('ol', { class: 'gwz-st' }, [
      h('li', null, [h('p', { text: t('gwe.compose.lin_1') })]),
      h('li', null, [h('p', { text: t('gwe.compose.lin_2') }), h('pre', { class: 'gwz-code gwz-pre', text: COMPOSE_LINUX_CMD })]),
    ]);
  }
  function downloadCompose(g, body) {
    return fetch('/api/v1/gateways/' + encodeURIComponent(String(g.peer_id)) + '/compose', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify(body),
    }).then((r) => {
      if (r.ok) return r.blob();
      return r.json().catch(() => ({})).then((j) => {
        const e = new Error((j && j.error) || ('HTTP ' + r.status));
        e.status = r.status;
        e.code = j && j.error === 'session_required' ? 'session_required' : null;
        throw e;
      });
    }, () => { const e = new Error('network'); e.code = 'network'; throw e; }).then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: 'docker-compose.yml', hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  function openComposeDialog(g, returnFk) {
    const dlg = openDialog({ title: t('gwe.compose.title'), wide: true, cls: 'gwe-compose', returnFk: returnFk || null });
    function choice(name, value, label, hint, checked) {
      const id = 'gwe-compose-' + name + '-' + value;
      const r = h('input', { type: 'radio', name: 'gwe-compose-' + name, id, value });
      r.checked = !!checked;
      return h('label', { class: 'gwe-check', for: id }, [r, h('span', null, [h('strong', { text: label }), hint ? h('span', { class: 'gwe-d', text: ' – ' + hint }) : null])]);
    }
    const p0 = composePlatform(g);
    const plat = h('fieldset', { class: 'gwe-fieldset' }, [h('legend', { text: t('gwe.compose.platform') }),
      choice('platform', 'synology', t('gwe.compose.p_synology'), null, p0 === 'synology'),
      choice('platform', 'linux', t('gwe.compose.p_linux'), null, p0 === 'linux')]);
    const net = h('fieldset', { class: 'gwe-fieldset' }, [h('legend', { text: t('gwe.compose.network') }),
      choice('network', 'host', t('gwe.compose.n_host'), null, true),
      choice('network', 'bridge', t('gwe.compose.n_bridge'), t('gwe.compose.n_bridge_d'), false)]);
    const stepsBox = h('div', { class: 'gwe-compose-steps' });
    const err = errorBox();
    const value = (name) => { const r = dlg.box.querySelector('input[name="gwe-compose-' + name + '"]:checked'); return r ? r.value : null; };
    // steps + the matching chapter of the user guide (handbook.js topics update.synology / update.linux)
    const drawSteps = () => stepsBox.replaceChildren(
      h('p', { class: 'gwe-label' }, [h('strong', { text: t('gwe.compose.steps') }), ' ', guide('update.' + value('platform'))]),
      composeSteps(value('platform')));
    dlg.body.append(h('p', { class: 'gwe-intro', text: t('gwe.compose.intro') }), plat, net, stepsBox, err);
    drawSteps();
    plat.addEventListener('change', drawSteps);
    const ok = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwe-compose-dl', text: t('gwe.compose.download') });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.close'), on: { click: () => dlg.close(null) } }), ok);
    ok.addEventListener('click', () => {
      ok.disabled = true;
      showErr(err, '');
      downloadCompose(g, { platform: value('platform'), network: value('network') })
        .then(() => toast(t('gwe.compose.done')), (e) => showErr(err, errText(e)))
        .finally(() => { ok.disabled = false; });
    });
    ok.focus();
    return dlg;
  }
  // the edge card's way out of edge_missing: the current compose without new keys (not for the Pi image)
  function composeHelp(g) {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwe-compose', text: t('gwe.compose.button') });
    b.addEventListener('click', () => openComposeDialog(g, 'gwe-compose'));
    return h('div', { class: 'gwe-compose-help' }, [h('p', { class: 'gwe-d' }, [t('gwe.compose.help'), ' ', guide('update.' + composePlatform(g))]), b]);
  }
  window.GCGatewayCompose = { open: openComposeDialog, help: composeHelp, platformOf: composePlatform };

  // ─── Data cache + drawing ─────────────────────────────────────────────
  const cache = {};   // gateway id → { data, err, at, inflight }
  let cur = null;     // { box, g, tab }

  function entry(id) { const k = String(id); if (!cache[k]) cache[k] = { data: null, err: null, at: 0, inflight: null }; return cache[k]; }

  function load(id, force) {
    const e = entry(id);
    if (e.inflight) return e.inflight;
    if (!force && e.data && Date.now() - e.at < 8000) return Promise.resolve(e.data);
    e.inflight = api('GET', gwUrl(id)).then((j) => {
      e.data = j.gateway; e.err = null; e.at = Date.now(); e.inflight = null;
      return e.data;
    }, (err) => { e.err = err; e.inflight = null; throw err; });
    return e.inflight;
  }

  function reload(id) {
    return load(id, true).then(() => { redraw(); updateBadges(); }, () => { redraw(); });
  }

  function focusKey() {
    const a = document.activeElement;
    const n = a && a.closest ? a.closest('[data-fk]') : null;
    return n ? n.getAttribute('data-fk') : null;
  }
  function restoreFocus(root, fk) {
    if (!fk || !root) return;
    const n = root.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(fk) : fk) + '"]');
    if (n && !n.disabled) n.focus({ preventScroll: true });
  }

  function redraw() {
    if (!cur || !cur.box.isConnected) return;
    const fk = cur.box.contains(document.activeElement) ? focusKey() : null;
    draw();
    restoreFocus(cur.box, fk);
  }

  function draw() {
    const box = cur.box;
    const e = entry(cur.g.peer_id);
    const nodes = [];
    if (!e.data) {
      if (e.err) nodes.push(errorPanel(e.err));
      else nodes.push(h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
    } else if (cur.tab === 'mqtt') nodes.push(...mqttPanel(cur.g, e.data));
    else nodes.push(...edgePanel(cur.g, e.data));
    if (e.data && e.err) nodes.unshift(note('warn', [errText(e.err)]));
    box.replaceChildren(...nodes);
  }

  function errorPanel(err) {
    const retry = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('gwe.retry'), 'data-fk': 'retry', on: { click: () => reload(cur.g.peer_id) } });
    return h('div', { class: 'gw gwe-card' }, h('div', { class: 'body gwe-body' }, [note('crit', [h('strong', { text: t('gwe.load_failed') }), ' ', errText(err)]), h('div', null, retry)]));
  }

  // ─── Tab bar ──────────────────────────────────────────────────────────
  function tabs(g, tab) {
    const bar = h('div', { class: 'gwe-tabs', role: 'tablist', 'aria-label': t('gwe.tabs.label') });
    K.TABS.forEach((id) => {
      const sel = id === tab;
      const b = h('button', {
        type: 'button', class: 'gwe-tab', role: 'tab', id: 'gwe-tab-' + id, 'aria-selected': sel ? 'true' : 'false',
        'aria-controls': 'gwe-tabpanel', tabIndex: sel ? 0 : -1, 'data-fk': 'tab:' + id, 'data-tab': id,
      }, [t('gwe.tabs.' + id), h('span', { class: 'gwe-tab-off', 'data-gwe-off': id, hidden: true, text: ' · ' + t('gwe.tabs.off') }),
        id !== 'overview' ? h('span', { class: 'gwe-tab-badge', 'data-gwe-badge': id }) : null]);
      b.addEventListener('click', () => { if (!sel) location.hash = K.hashFor(g.peer_id, id); });
      bar.appendChild(b);
    });
    bar.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const i = K.TABS.indexOf(tab);
      const n = keys[e.key] === 'first' ? 0 : keys[e.key] === 'last' ? K.TABS.length - 1 : (i + keys[e.key] + K.TABS.length) % K.TABS.length;
      // focus first: the view is drawn anew for the new tab and keeps the focused control
      const next = bar.querySelector('[data-tab="' + K.TABS[n] + '"]');
      if (next) next.focus();
      location.hash = K.hashFor(g.peer_id, K.TABS[n]);
    });
    fillBadges(bar, g.peer_id);
    return bar;
  }

  function fillBadges(root, id) {
    const e = entry(id);
    const d = e.data;
    // a tab whose function is switched off: muted, "· aus" (still opens, its off-note inside)
    root.querySelectorAll('[data-gwe-off]').forEach((n) => {
      const off = !!(window.GCGatewayNet && window.GCGatewayNet.tabOff(id, n.getAttribute('data-gwe-off')));
      n.hidden = !off;
      const tabBtn = n.closest('.gwe-tab');
      if (tabBtn) tabBtn.classList.toggle('gwe-tab-is-off', off);
    });
    root.querySelectorAll('[data-gwe-badge]').forEach((b) => {
      // tabs "Funktionen" / "Netzwerk" / "Internet": their own data (gateway-net.js)
      const which = b.getAttribute('data-gwe-badge');
      if (which === 'net' || which === 'inet' || which === 'features') { if (window.GCGatewayNet) window.GCGatewayNet.badge(b, id, which); return; }
      // tabs "DNS-Filter" / "Zwischenspeicher" (phase 3b, gateway-home.js)
      if (which === 'dns' || which === 'cache') { if (window.GCGatewayHome) window.GCGatewayHome.badge(b, id, which); return; }
      // tab "Funk" (phase 3c, step 2, gateway-radio.js) — from the features overview
      if (which === 'radio') { if (window.GCGatewayRadio && window.GCGatewayNet) window.GCGatewayRadio.badge(b, id, window.GCGatewayNet.features(id)); return; }
      b.replaceChildren();
      b.className = 'gwe-tab-badge';
      if (!d) return;
      if (b.getAttribute('data-gwe-badge') === 'edge') {
        if (!d.settings.edgeEnabled) return;
        const s = K.summary(d.plugins, d.settings);
        if (s.attention) { b.className = 'gwe-tab-badge tag tag-amber'; b.textContent = t('gwe.tabs.attention', { n: s.attention }); }
        else if (s.running) { b.className = 'gwe-tab-badge tag tag-green'; b.textContent = t('gwe.tabs.running', { n: s.running }); }
      } else if (b.getAttribute('data-gwe-badge') === 'mqtt') {
        const st = d.mqtt && d.mqtt.status;
        if (d.settings.mqttEnabled && d.settings.edgeEnabled && st && st.running) {
          b.className = 'gwe-tab-badge tag tag-green';
          b.textContent = t(st.clients === 1 ? 'gwe.tabs.client' : 'gwe.tabs.clients', { n: st.clients || 0 });
        }
      }
    });
  }
  function updateBadges() { if (cur) fillBadges(document, cur.g.peer_id); }

  // ─── Shared: gateway too old / edge off ───────────────────────────────
  function bigNote(tone, ic, title, text, actions) {
    const id = 'gwe-big-' + Math.random().toString(36).slice(2, 8);
    return h('section', { class: 'gw gwe-card gwe-big gwe-big-' + tone, 'aria-labelledby': id }, [
      h('span', { class: 'gwe-big-ic' }, icon(ic, 22)),
      h('div', { class: 'gwe-big-t' }, [h('h3', { id, text: title }), h('p', { class: 'gwe-d', text }), actions && actions.length ? h('div', { class: 'gwe-actions' }, actions) : null]),
    ]);
  }

  // "Was ist neu?" of a "too old" note: "Versionen" of the gateway (gateway-docs.js), else the releases on GitHub
  function whatsNew(g) {
    const D = window.GCGatewayDocs;
    return D && g ? h('a', { class: 'btn btn-ghost', href: D.versionsHref(g), 'data-act': 'whats-new', text: t('gwe.old.whats_new') })
      : h('a', { class: 'btn btn-ghost', href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwe.old.whats_new') });
  }

  function tooOld(g, d, ctx) {
    const sup = d.support || {};
    const actions = [];
    if (g.update_available && ctx.latest) {
      const migrated = !!(g.health && g.health.telemetry && g.health.telemetry.state_dir_writable);
      // the page's own update action (gateways.js, [data-act="update"])
      const up = h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'update', 'data-id': String(g.peer_id), 'data-fk': 'gwe-update' },
        [icon('up', 16), t('gwe.old.update', { version: ctx.latest })]);
      if (!migrated) { up.disabled = true; up.title = t('gateways.update_not_migrated'); }
      if (g.update_state === 'updating') up.disabled = true;
      actions.push(up);
    }
    actions.push(whatsNew(g));
    return bigNote('warn', 'up', t('gwe.old.title', { min: sup.edgeMinGateway || '—' }),
      t('gwe.old.text', { version: sup.gatewayVersion || '—' }), actions);
  }

  // ─── Switches of the gateway ──────────────────────────────────────────
  function putSettings(g, patch, okMsg) {
    return api('PUT', gwUrl(g.peer_id, '/settings'), patch).then(() => {
      if (okMsg) toast(okMsg);
      return reload(g.peer_id);
    });
  }
  function toggleSetting(g, btn, key, next, okMsg) {
    btn.disabled = true;
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    return putSettings(g, { [key]: next }, okMsg).catch((e) => {
      btn.disabled = false;
      btn.setAttribute('aria-checked', next ? 'false' : 'true');
      D.alert({ message: errText(e), danger: true });
    });
  }
  async function setEdge(g, btn, next) {
    if (!next && !await D.confirm({ title: t('gwe.edge.off_title'), message: t('gwe.edge.off_msg'), okLabel: t('gwe.edge.off_ok'), danger: true })) return;
    if (btn) return toggleSetting(g, btn, 'edgeEnabled', next, t(next ? 'gwe.edge.on_done' : 'gwe.edge.off_done'));
    return putSettings(g, { edgeEnabled: next }, t(next ? 'gwe.edge.on_done' : 'gwe.edge.off_done')).catch((e) => D.alert({ message: errText(e), danger: true }));
  }

  // ─── Tab "Edge-Plugins" ───────────────────────────────────────────────
  function edgePanel(g, d) {
    const ctx = cur.ctx || {};
    if (d.support && d.support.edgeSupported === false) return [tooOld(g, d, ctx)];
    if (!d.settings.edgeEnabled) {
      const names = (d.plugins || []).map((p) => p.name);
      const text = names.length ? t(names.length === 1 ? 'gwe.off.text_one' : 'gwe.off.text', { n: names.length, names: names.join(', ') }) : t('gwe.off.text_none');
      const on = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwe-edge-on' }, [icon('power', 16), t('gwe.off.enable')]);
      on.addEventListener('click', () => { on.disabled = true; setEdge(g, null, true).finally(() => { on.disabled = false; }); });
      return [bigNote('grey', 'power', t('gwe.off.title'), text, [on])].concat(K.nativeGateway(g) ? [nativeNote()] : []);
    }
    const top = h('div', { class: 'gwe-grid2' }, [edgeCard(g, d), unsignedCard(g, d)]);
    return [top, pluginsCard(g, d)];
  }

  function edgeCard(g, d) {
    const sw = switchBtn(true, t('gwe.edge.title'), 'gwe-edge-sw', () => setEdge(g, sw, sw.getAttribute('aria-checked') !== 'true'));
    const c = card(t('gwe.edge.title'), sw, { id: 'edge' });
    c.body.appendChild(h('p', { class: 'gwe-d' }, [t('gwe.edge.text'), ' ', guide('edge')]));
    const chips = h('div', { class: 'gwe-chips' });
    const hello = d.gateway;
    // isolated (no network, gateway >= 1.23.0) / network fence (older compose) / compose outdated
    const bound = K.boundaryState(hello);
    chips.appendChild(chip(bound.tone, t(bound.key, { backend: bound.backend || '' }), bound.tone === 'ok' ? 'check' : bound.tone === 'bad' ? 'warn' : 'shield'));
    const conn = d.connection || {};
    const why = !conn.online && K.REASONS.indexOf(conn.reason) >= 0 ? conn.reason : null;
    if (conn.online) chips.appendChild(chip('ok', t('gwe.edge.connected_since', { time: fmtTime(conn.connectedAt) }), 'check'));
    else if (why) chips.appendChild(chip(why === 'gateway_offline' ? '' : 'bad', t('gwe.state.' + why), why === 'gateway_offline' ? 'x' : 'warn'));
    else chips.appendChild(chip('', conn.lastSeen ? t('gwe.edge.offline_since', { time: fmtTime(conn.lastSeen) }) : t('gwe.edge.offline'), 'x'));
    if (hello && hello.edgeHost) chips.appendChild(chip('', t('gwe.edge.host', { version: hello.edgeHost })));
    c.body.appendChild(chips);
    // a gateway without Docker (Proxmox LXC): no edge container there — said once, instead of asking for a compose file
    const native = K.nativeGateway(g);
    if (native) c.body.appendChild(nativeNote());
    // why the channel is down — here unless a plugin row below already says it (or the note above does)
    if (why && !(native && why === 'edge_missing') && !(d.plugins || []).some((p) => K.pluginState(p, d.settings).state === why)) {
      c.body.appendChild(note(why === 'gateway_offline' ? 'info' : 'warn', [h('strong', { text: t('gwe.state.' + why) }), ' '].concat(reasonText(g, d, why))));
    }
    if ((why === 'edge_missing' || why === 'compose_outdated') && g.platform !== 'rpi' && !native) c.body.appendChild(composeHelp(g));
    // connected, but the edge container still runs in the host network without a fence: the current compose file
    // (no network for edge, no kernel module) is the way out — the plugin rows show 'denied' meanwhile
    if (!why && bound.composeOutdated) {
      c.body.appendChild(note('warn', [h('strong', { text: t('gwe.edge.compose_outdated') }), ' ', t('gwe.edge.compose_outdated_text'), ' ', guide('edge.compose_outdated')]));
      if (g.platform !== 'rpi') c.body.appendChild(composeHelp(g));
    }
    // connected, no fence, and the edge container is older than gateway 1.23.0 (it cannot report the compose file):
    // update the gateway, then the current compose file — same way out, no kernel module, no SSH
    if (!why && bound.updateFirst) {
      c.body.appendChild(note('warn', [h('strong', { text: t('gwe.edge.update_first') }), ' ', t('gwe.edge.update_first_text'), ' ', guide('edge.compose_outdated')]));
      if (g.platform !== 'rpi') c.body.appendChild(composeHelp(g));
    }
    const tel = (g.health && g.health.telemetry) || {};
    const memTotal = (hello && hello.hardware && hello.hardware.mem_total) || (tel.hardware && tel.hardware.mem_total) || tel.mem_total;
    const mh = K.memoryHint(memTotal, K.summary(d.plugins, d.settings).enabled);
    if (mh) {
      let rest;
      if (mh.max === 0) rest = t('gwe.mem.none');
      else if (mh.tight) rest = t('gwe.mem.tight', { n: mh.plugins, max: mh.max });
      else if (mh.plugins === 0) rest = t('gwe.mem.room', { max: mh.max });
      else rest = t('gwe.mem.ok', { n: mh.plugins, max: mh.max });
      c.body.appendChild(note(mh.tight || mh.memMb <= 1100 ? 'warn' : 'info',
        [h('strong', { text: t('gwe.mem.ram', { ram: K.ramLabel(mh.memMb) }) }), ' ', t('gwe.mem.base'), ' ', rest]));
    }
    const logBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm gwe-self', 'data-fk': 'gwe-gwlog' }, [icon('list', 15), t('gwe.edge.gw_log')]);
    logBtn.addEventListener('click', () => logDialog(g, d, null));
    c.body.appendChild(logBtn);
    return c.card;
  }

  // "Kein Edge-Container auf diesem Gateway" (Proxmox LXC without Docker): a hint — the switches stay usable
  function nativeNote() {
    return h('div', { 'data-native': '' }, note('info', [h('strong', { text: t('gwe.native.title') }), ' ', t('gwe.native.text'), ' ', guide('gw.proxmox')]));
  }

  function unsignedCard(g, d) {
    const allowed = !!d.settings.allowUnsignedEdge;
    const c = card(t('gwe.uns.title'), tag(allowed ? 'amber' : 'grey', t(allowed ? 'gwe.uns.allowed' : 'gwe.uns.blocked')), { id: 'uns' });
    c.body.appendChild(h('p', { class: 'gwe-d', text: t(allowed ? 'gwe.uns.text_allowed' : 'gwe.uns.text_blocked') }));
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm gwe-self', 'data-fk': 'gwe-uns', text: t(allowed ? 'gwe.uns.block' : 'gwe.uns.allow') });
    b.addEventListener('click', () => {
      if (!allowed) { unsignedDialog(g, d); return; }
      b.disabled = true;
      putSettings(g, { allowUnsignedEdge: false }, t('gwe.uns.blocked_done')).catch((e) => { b.disabled = false; D.alert({ message: errText(e), danger: true }); });
    });
    c.body.appendChild(b);
    return c.card;
  }

  // the explanation of a reason (gwe.state_d.<reason>), the user guide (handbook.js) and the gateway's own error text
  function reasonText(g, d, reason) {
    // no edge service on a gateway without Docker: there is no compose file to renew
    const native = reason === 'edge_missing' && K.nativeGateway(g);
    const kids = [t(native ? 'gwe.state_d.edge_missing_native' : 'gwe.state_d.' + reason)];
    const topic = K.reasonTopic(reason, native ? 'proxmox' : g.platform);
    const url = topic ? guideUrl(topic) : null;
    if (url) kids.push(' ', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', 'data-guide': 'reason', text: t('gwe.reason.guide') }));
    const msg = d.connection && d.connection.reason === reason ? d.connection.detail : null;
    if (msg) kids.push(' · ' + t('gwe.reason.gw_says') + ' ', h('code', { class: 'gwe-mono', text: msg }));
    return kids;
  }

  function pluginsCard(g, d) {
    const list = d.plugins || [];
    const s = K.summary(list, d.settings);
    const parts = [t('gwe.pl.installed', { n: s.installed }), t('gwe.pl.running', { n: s.running })];
    if (s.attention) parts.push(t(s.attention === 1 ? 'gwe.pl.attention_one' : 'gwe.pl.attention', { n: s.attention }));
    const c = card(t('gwe.pl.title'), list.length ? h('span', { class: 'gwe-sum', text: parts.join(' · ') }) : null, { id: 'pl', full: true, cls: 'gwe-plugins' });
    if (!list.length) {
      c.body.appendChild(h('p', { class: 'gwe-empty' }, [t('gwe.pl.empty'), ' ', h('a', { href: '/settings/plugins/catalog', text: t('gwe.pl.catalog') })]));
      return c.card;
    }
    list.forEach((p) => c.body.appendChild(pluginRow(g, d, p)));
    return c.card;
  }

  function pluginRow(g, d, p) {
    const st = K.pluginState(p, d.settings);
    const a = p.assignment;
    const status = a && a.status;
    const head = h('div', { class: 'gwe-prow-h' }, [
      h('strong', { class: 'gwe-pname', text: p.name }),
      h('span', { class: 'gwe-d', text: p.version + ' · ' + t(p.verified ? 'gwe.pl.signed' : 'gwe.pl.unsigned') }),
      tag(st.tone, t(st.key), true),
    ]);
    const main = h('div', { class: 'gwe-prow-m' }, [head]);
    // what the state means
    let detail = null;
    if (st.state === 'update_pending') {
      const fresh = (a.newCapabilities || []).map((c) => c.text).join(', ');
      detail = h('p', { class: 'gwe-d' }, [t('gwe.pl.update_wants', { version: p.version }), ' ', h('strong', { class: 'gwe-strong', text: fresh }), '. ', t('gwe.pl.update_off')]);
    } else if (st.state === 'gateway_too_old') {
      detail = h('p', { class: 'gwe-d', text: t('gwe.state_d.gateway_too_old', { min: p.edge.minGateway || '—', version: (d.support && d.support.gatewayVersion) || '—' }) });
    } else if (K.REASONS.indexOf(st.state) >= 0) {
      detail = h('p', { class: 'gwe-d' }, reasonText(g, d, st.state));
    } else if (['denied', 'unsigned', 'plugin_off', 'offline', 'pending', 'not_set_up', 'disabled', 'stopped'].indexOf(st.state) >= 0) {
      detail = h('p', { class: 'gwe-d', text: t('gwe.state_d.' + st.state) });
    }
    if (detail) main.appendChild(detail);
    if (K.needsMqtt(p, d.settings)) main.appendChild(mqttOffNote(g, p));
    const caps = (p.edge && p.edge.capabilities) || [];
    if (caps.length && st.state !== 'update_pending') {
      main.appendChild(h('div', { class: 'gwe-chips' }, caps.map((c) => chip(c.warning ? 'bad' : '', c.text, c.warning ? 'warn' : null))));
    }
    // memory, restarts, last error
    const meta = [];
    if (status && status.rssMb != null) meta.push(t('gwe.pl.memory', { used: status.rssMb, max: p.edge.memoryMb }));
    else meta.push(t('gwe.pl.memory_max', { max: p.edge.memoryMb }));
    if (status && status.restarts) meta.push(t(status.restarts === 1 ? 'gwe.pl.restart_one' : 'gwe.pl.restarts', { n: status.restarts }));
    if (status && status.throttled) meta.push(t('gwe.pl.throttled'));
    if (status && status.buffered) meta.push(t('gwe.pl.buffered', { n: status.buffered }));
    const metaLine = h('p', { class: 'gwe-d gwe-meta', text: meta.join(' · ') });
    if (status && status.lastError) metaLine.append(' · ' + t('gwe.pl.last_error') + ' ', h('code', { class: 'gwe-mono', text: status.lastError }));
    main.appendChild(metaLine);

    const acts = h('div', { class: 'gwe-prow-a' });
    if (a) {
      const lb = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'log:' + p.id, 'aria-label': t('gwe.pl.log_of', { plugin: p.name }), text: t('gwe.pl.log') });
      lb.addEventListener('click', () => logDialog(g, d, p));
      acts.appendChild(lb);
    }
    const ctl = K.pluginControl(p, d.settings);
    if (ctl === 'review') {
      const rb = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-fk': 'review:' + p.id, text: t('gwe.pl.review') });
      rb.addEventListener('click', () => capsDialog(g, p.id));
      acts.appendChild(rb);
    } else {
      const on = !!(a && a.enabled);
      const sw = switchBtn(on, t('gwe.pl.switch', { plugin: p.name }), 'sw:' + p.id, null, ctl === 'blocked');
      if (ctl === 'blocked') sw.title = t('gwe.state_d.unsigned');
      sw.addEventListener('click', () => {
        if (sw.getAttribute('aria-checked') !== 'true') { capsDialog(g, p.id); return; }
        sw.disabled = true;
        sw.setAttribute('aria-checked', 'false');
        api('POST', gwUrl(g.peer_id, '/plugins/' + encodeURIComponent(p.id) + '/disable'))
          .then(() => { toast(t('gwe.pl.disabled_done', { plugin: p.name })); return reload(g.peer_id); })
          .catch((e) => { sw.disabled = false; sw.setAttribute('aria-checked', 'true'); D.alert({ message: errText(e), danger: true }); });
      });
      acts.appendChild(sw);
    }
    return h('div', { class: 'gwe-prow', 'data-plugin': p.id, 'data-state': st.state }, [
      h('span', { class: 'gwe-pic gwe-tone-' + st.tone }, icon('plug', 20)), main, acts,
    ]);
  }

  // ─── Dialog: confirm the capabilities and switch on ───────────────────
  function capsDialog(g, pluginId) {
    const d0 = entry(g.peer_id).data;
    let p = d0 && (d0.plugins || []).find((x) => x.id === pluginId);
    if (!p) return;
    const dlg = openDialog({ title: t('gwe.caps.title', { plugin: p.name, gateway: d0.name || g.name }), wide: true, cls: 'gwe-caps', returnFk: 'sw:' + p.id });
    const sub = h('p', { class: 'gwe-d gwe-sub' });
    const intro = h('p', { class: 'gwe-intro', text: t('gwe.caps.intro') });
    const changed = h('div', { role: 'status', class: 'gwe-status' });
    const list = h('ul', { class: 'gwe-caps-list', 'aria-label': t('gwe.caps.list') });
    const unsigned = note('warn', [t('gwe.caps.unsigned')]);
    const cb = h('input', { type: 'checkbox', id: 'gwe-caps-read' });
    const read = h('label', { class: 'gwe-check', for: 'gwe-caps-read' }, [cb, h('span', { text: t('gwe.caps.read') })]);
    const err = errorBox();
    dlg.body.append(sub, intro, unsigned, changed, list, read, err);
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwe.caps.ok'), disabled: true });
    dlg.foot.append(cancel, ok);
    let rows = [];
    function fill() {
      rows = K.capabilityRows(p);
      sub.textContent = [t('gwe.caps.version', { version: p.version }), t(p.verified ? 'gwe.pl.signed' : 'gwe.pl.unsigned'), t('gwe.caps.memory', { max: p.edge.memoryMb })].join(' · ');
      unsigned.hidden = !!p.verified;
      list.replaceChildren(...(rows.length ? rows.map((r) => h('li', { class: 'gwe-cap' + (r.warning ? ' gwe-cap-warn' : ''), 'data-key': r.key }, [
        h('span', { class: 'gwe-cap-ic' }, icon(r.warning ? 'warn' : 'check', 16)),
        h('span', { class: 'gwe-cap-t' }, [h('strong', { text: r.text }), r.warning ? h('span', { class: 'gwe-cap-w', text: t('gwe.caps.warning') }) : null]),
        r.mark ? tag(r.mark === 'new' ? 'amber' : 'grey', t(r.mark === 'new' ? 'gwe.caps.new' : 'gwe.caps.prior')) : null,
      ])) : [h('li', { class: 'gwe-cap gwe-cap-none', text: t('gwe.caps.none') })]));
      cb.checked = false;
      ok.disabled = true;
    }
    fill();
    cb.addEventListener('change', () => { ok.disabled = !cb.checked; });
    ok.addEventListener('click', () => {
      ok.disabled = true;
      showErr(err, '');
      api('POST', gwUrl(g.peer_id, '/plugins/' + encodeURIComponent(p.id) + '/enable'), { capabilities: rows.map((r) => r.key) })
        .then(() => { dlg.close(true); toast(t('gwe.caps.done', { plugin: p.name })); reload(g.peer_id); })
        .catch((e) => {
          if (e.code === 'caps_mismatch') {
            // the plugin changed meanwhile: show the current list and ask again
            return load(g.peer_id, true).then((fresh) => {
              const np = (fresh.plugins || []).find((x) => x.id === pluginId);
              if (!np) { dlg.close(null); reload(g.peer_id); return; }
              p = np;
              fill();
              changed.textContent = t('gwe.caps.changed');
              cb.focus();
              redraw();
            }).catch((e2) => { showErr(err, errText(e2)); });
          }
          showErr(err, errText(e));
          ok.disabled = !cb.checked;
        });
    });
    cb.focus();
  }

  // ─── Dialog: allow unsigned edge parts (type ERLAUBEN) ────────────────
  function unsignedDialog(g, d) {
    const word = t('gwe.uns.word');
    const dlg = openDialog({ title: t('gwe.uns.dlg_title', { gateway: d.name || g.name }), wide: true, cls: 'gwe-uns' });
    const input = h('input', { type: 'text', id: 'gwe-uns-word', class: 'form-input gwe-mono', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'gwe-uns-hint' });
    const err = errorBox();
    dlg.body.append(
      h('p', { class: 'gwe-intro', text: t('gwe.uns.dlg_1') }),
      note('crit', [t('gwe.uns.dlg_2')], 'warn'),
      h('p', { class: 'gwe-d', text: t('gwe.uns.dlg_3') }),
      h('label', { class: 'form-label gwe-label', for: 'gwe-uns-word' }, [t('gwe.uns.type_pre'), ' ', h('code', { class: 'gwe-word', text: word }), ' ', t('gwe.uns.type_post')]),
      input,
      h('span', { class: 'form-hint', id: 'gwe-uns-hint', text: t('gwe.uns.type_hint') }),
      err);
    const ok = h('button', { type: 'button', class: 'btn btn-danger', text: t('gwe.uns.ok'), disabled: true });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), ok);
    input.addEventListener('input', () => { ok.disabled = input.value.trim() !== word; });
    const submit = () => {
      if (ok.disabled) return;
      ok.disabled = true;
      api('PUT', gwUrl(g.peer_id, '/settings'), { allowUnsignedEdge: true, confirm: input.value.trim() })
        .then(() => { dlg.close(true); toast(t('gwe.uns.allowed_done')); reload(g.peer_id); })
        .catch((e) => { showErr(err, errText(e)); ok.disabled = input.value.trim() !== word; });
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    input.focus();
  }

  // the edge part needs MQTT, the broker is off: say so in plain words, with a button that switches it on
  function mqttOffNote(g, p) {
    const b = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-fk': 'mqtt-on:' + p.id, text: t('gwe.pl.mqtt_on') });
    b.addEventListener('click', () => {
      b.disabled = true;
      putSettings(g, { mqttEnabled: true }, t('gwe.mqtt.on_done')).catch((e) => { b.disabled = false; D.alert({ message: errText(e), danger: true }); });
    });
    return note('warn', [h('strong', { text: t('gwe.pl.mqtt_off') }), ' ', t('gwe.pl.mqtt_off_text', { plugin: p.name }), ' ', b]);
  }

  // ─── Dialog: log of an edge part (or the gateway's own notes) ─────────
  function logDialog(g, d, p) {
    const title = p ? t('gwe.log.title', { plugin: p.name }) : t('gwe.log.title_gw');
    const dlg = openDialog({ title, wide: true, cls: 'gwe-logdlg' });
    let filter = 'all';
    let oldest = null;
    const PAGE = 100;
    const seg = h('div', { class: 'gwe-seg', role: 'group', 'aria-label': t('gwe.log.filter') });
    const list = h('ol', { class: 'gwe-log', 'aria-label': title });
    const empty = h('p', { class: 'gwe-empty', text: t('gwe.log.empty') });
    const more = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('gwe.log.older') });
    const err = errorBox();
    empty.hidden = true; more.hidden = true;
    K.LOG_FILTERS.forEach((f) => {
      const b = h('button', { type: 'button', class: 'gwe-seg-b', 'aria-pressed': f.id === filter ? 'true' : 'false', 'data-filter': f.id, text: t('gwe.log.f.' + f.id) });
      b.addEventListener('click', () => {
        filter = f.id;
        seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        fetchPage(true);
      });
      seg.appendChild(b);
    });
    dlg.body.append(h('p', { class: 'gwe-d gwe-sub', text: t('gwe.log.sub', { gateway: d.name || g.name }) }), seg, err, list, empty, h('div', { class: 'gwe-more' }, more));
    // the warning in the log ("MQTT broker … is off") explained above it, with the way out
    if (p && K.needsMqtt(p, d.settings)) dlg.body.insertBefore(mqttOffNote(g, p), seg);
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-primary', text: t('common.close'), on: { click: () => dlg.close(null) } }));
    function line(x) {
      const tone = x.level === 'error' ? 'bad' : x.level === 'warn' ? 'warn' : '';
      return h('li', { class: 'gwe-ln' + (tone ? ' gwe-ln-' + tone : ''), 'data-kind': x.kind }, [
        h('time', { class: 'gwe-ln-t', datetime: x.at, text: fmtTime(x.at, true) }),
        h('span', { class: 'gwe-ln-k', text: t(K.logLabel(x)) }),
        h('span', { class: 'gwe-ln-m', text: x.message }),
      ]);
    }
    function fetchPage(reset) {
      if (reset) { oldest = null; list.replaceChildren(); }
      const f = K.LOG_FILTERS.find((x) => x.id === filter);
      const q = new URLSearchParams({ plugin: p ? p.id : '', limit: String(PAGE) });
      if (f.kind) q.set('kind', f.kind);
      if (oldest) q.set('before', String(oldest));
      more.disabled = true;
      showErr(err, '');
      return api('GET', gwUrl(g.peer_id, '/logs?' + q.toString())).then((j) => {
        const entries = j.entries || [];
        entries.forEach((x) => list.appendChild(line(x)));
        if (entries.length) oldest = entries[entries.length - 1].id;
        empty.hidden = list.children.length > 0;
        more.hidden = entries.length < PAGE;
        more.disabled = false;
      }).catch((e) => { showErr(err, errText(e)); more.disabled = false; });
    }
    more.addEventListener('click', () => fetchPage(false));
    fetchPage(true);
    seg.querySelector('button').focus();
  }

  // ─── Tab "MQTT" ───────────────────────────────────────────────────────
  function lanIp(g) { const t0 = (g.health && g.health.telemetry) || {}; return typeof t0.lan_ip === 'string' && t0.lan_ip ? t0.lan_ip : null; }
  function mdnsName(g, d) { return K.mdnsName(d.gateway, g.health && g.health.telemetry); }

  function mqttPanel(g, d) {
    const ctx = cur.ctx || {};
    if (d.support && d.support.edgeSupported === false) return [tooOld(g, d, ctx)];
    return [h('div', { class: 'gwe-grid2' }, [brokerCard(g, d), tlsCard(g, d)]), accountsCard(g, d)];
  }

  function kv(k, v) { return h('div', { class: 'gwe-kv' }, [h('span', { class: 'gwe-k', text: k }), h('span', { class: 'gwe-v' }, v)]); }

  function brokerCard(g, d) {
    const s = d.settings;
    const sw = switchBtn(!!s.mqttEnabled, t('gwe.mqtt.broker'), 'gwe-mqtt-sw', () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      toggleSetting(g, sw, 'mqttEnabled', next, t(next ? 'gwe.mqtt.on_done' : 'gwe.mqtt.off_done'));
    });
    const c = card(t('gwe.mqtt.broker'), sw, { id: 'broker' });
    c.body.appendChild(h('p', { class: 'gwe-d' }, [t('gwe.mqtt.text'), ' ', guide('mqtt')]));
    if (s.mqttEnabled && !s.edgeEnabled) {
      const on = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwe-mqtt-edge', text: t('gwe.off.enable') });
      on.addEventListener('click', () => { on.disabled = true; setEdge(g, null, true).finally(() => { on.disabled = false; }); });
      c.body.appendChild(note('warn', [t('gwe.mqtt.needs_edge'), ' ', on]));
    }
    if (d.gateway && !d.gateway.mqttAvailable) c.body.appendChild(note('warn', [t('gwe.mqtt.not_available')]));
    // without Docker (Proxmox LXC) there is no mqtt container either — unless the reason below already says so
    const native = K.nativeGateway(g);
    const st = K.brokerStatus(s, d.mqtt && d.mqtt.status, d.connection && d.connection.online, d.connection && d.connection.reason);
    const status = [tag(st.tone, st.reason ? t('gwe.state.' + st.reason) : t('gwe.mqtt.status.' + st.key), true)];
    if (st.key === 'running') {
      const n = d.mqtt.status.clients || 0;
      status.push(' ', t(n === 1 ? 'gwe.mqtt.client' : 'gwe.mqtt.clients', { n }));
    }
    const rows = h('div', { class: 'gwe-kvs' }, [kv(t('gwe.mqtt.k_status'), status)]);
    const ip = lanIp(g);
    const addr = K.brokerAddress(ip, false);
    rows.appendChild(kv(t('gwe.mqtt.k_address'), addr
      ? [h('code', { class: 'gwe-mono', text: addr }), copyBtn(() => addr, t('gwe.mqtt.copy_address'))]
      : [h('span', { class: 'gwe-muted', text: t('gwe.mqtt.address_unknown') })]));
    const md = mdnsName(g, d);
    if (md) rows.appendChild(kv(t('gwe.mqtt.k_mdns'), [h('code', { class: 'gwe-mono', text: md }), ' ', h('span', { class: 'gwe-muted', text: '(mDNS)' })]));
    c.body.appendChild(rows);
    if (st.reason) c.body.appendChild(note(st.reason === 'gateway_offline' ? 'info' : 'warn', reasonText(g, d, st.reason)));
    if (native && st.reason !== 'edge_missing') c.body.appendChild(nativeNote());
    return c.card;
  }

  function tlsCard(g, d) {
    const s = d.settings;
    const sw = switchBtn(!!s.mqttTls, t('gwe.tls.switch'), 'gwe-tls-sw', () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      toggleSetting(g, sw, 'mqttTls', next, t(next ? 'gwe.tls.on_done' : 'gwe.tls.off_done'));
    });
    const c = card(t('gwe.tls.title'), sw, { id: 'tls' });
    c.body.appendChild(h('p', { class: 'gwe-d', text: t('gwe.tls.text') }));
    const tls = d.mqtt && d.mqtt.status ? d.mqtt.status.tls : null;
    if (s.mqttTls && tls === 'missing_cert') c.body.appendChild(note('warn', [h('strong', { text: t('gwe.tls.missing_cert') }), ' ', t('gwe.tls.missing_cert_d')]));
    else if (s.mqttTls && tls === 'on') {
      const addr = K.brokerAddress(lanIp(g), true);
      c.body.appendChild(h('div', { class: 'gwe-kvs' }, [kv(t('gwe.tls.k_port'), [tag('green', t('gwe.tls.active'), true), addr ? ' ' : null, addr ? h('code', { class: 'gwe-mono', text: addr }) : null])]));
    } else c.body.appendChild(note('info', [t('gwe.tls.cert_note')]));
    return c.card;
  }

  function accountsCard(g, d) {
    const accounts = (d.mqtt && d.mqtt.accounts) || [];
    const full = accounts.length >= K.ACCOUNTS_MAX;
    const add = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-fk': 'gwe-acc-new', disabled: full }, [icon('plus', 15), t('gwe.mqtt.new.open')]);
    if (full) add.title = t('gwe.err.limit');
    add.addEventListener('click', () => accountDialog(g, d));
    const head = h('div', { class: 'gwe-acc-head' }, [h('span', { class: 'gwe-sum', text: t('gwe.mqtt.count', { n: accounts.length, max: K.ACCOUNTS_MAX }) }), add]);
    const c = card(t('gwe.mqtt.accounts'), head, { id: 'acc', full: true, cls: 'gwe-accounts' });
    c.body.appendChild(h('p', { class: 'gwe-d', text: t('gwe.mqtt.accounts_d') }));
    if (!accounts.length) {
      c.body.appendChild(h('p', { class: 'gwe-empty', text: t('gwe.mqtt.no_accounts') }));
      return c.card;
    }
    const plugins = new Map((d.plugins || []).map((p) => [p.id, p.name]));
    const status = d.mqtt && d.mqtt.status;
    const thead = h('thead', null, h('tr', null, [
      h('th', { scope: 'col', text: t('gwe.mqtt.col_user') }), h('th', { scope: 'col', text: t('gwe.mqtt.col_label') }),
      h('th', { scope: 'col', text: t('gwe.mqtt.col_topics') }), h('th', { scope: 'col', text: t('gwe.mqtt.col_by') }),
      h('th', { scope: 'col', text: t('gwe.mqtt.col_status') }), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: t('gwe.mqtt.col_actions') })),
    ]));
    const tbody = h('tbody');
    accounts.forEach((acc) => {
      const st = K.accountStatus(acc, status);
      const by = acc.pluginId
        ? t('gwe.mqtt.by_plugin', { plugin: plugins.get(acc.pluginId) || acc.pluginId })
        : t('gwe.mqtt.by_admin', { date: fmtDate(acc.createdAt) });
      const topics = h('td', { class: 'gwe-mono gwe-topics' }, acc.acl.map((x) => h('div', null, [x.topic, x.access !== 'readwrite' ? h('span', { class: 'gwe-muted', text: ' (' + t('gwe.mqtt.access.' + x.access) + ')' }) : null])));
      const actions = h('div', { class: 'gwe-row-actions' }, [
        iconBtn('key', t('gwe.mqtt.pw_for', { user: acc.username }), 'pw:' + acc.id, () => newPassword(g, d, acc)),
        iconBtn(acc.locked ? 'unlock' : 'lock', t(acc.locked ? 'gwe.mqtt.unlock_for' : 'gwe.mqtt.lock_for', { user: acc.username }), 'lock:' + acc.id, () => setLocked(g, acc, !acc.locked)),
        iconBtn('trash', t('gwe.mqtt.delete_for', { user: acc.username }), 'del:' + acc.id, () => removeAccount(g, d, acc), true),
      ]);
      tbody.appendChild(h('tr', { 'data-account': acc.username }, [
        h('td', { class: 'gwe-mono gwe-user', text: acc.username }),
        h('td', { text: acc.label || '—' }),
        topics,
        h('td', { title: acc.createdBy || null, text: by }),
        h('td', null, tag(st.tone, t('gwe.mqtt.acc.' + st.key), true)),
        h('td', { class: 'gwe-actions-cell' }, actions),
      ]));
    });
    c.body.appendChild(h('div', { class: 'gwe-table-wrap', tabIndex: 0, role: 'region', 'aria-label': t('gwe.mqtt.accounts') },
      h('table', { class: 'gwe-table' }, [thead, tbody])));
    c.body.appendChild(h('p', { class: 'gwe-d gwe-foot', text: t('gwe.mqtt.plugin_note') }));
    return c.card;
  }

  function iconBtn(ic, label, fk, onClick, danger) {
    const b = h('button', { type: 'button', class: 'icon-action' + (danger ? ' danger' : ''), 'aria-label': label, title: label, 'data-fk': fk }, icon(ic, 15));
    b.addEventListener('click', onClick);
    return b;
  }

  async function setLocked(g, acc, locked) {
    if (locked && !await D.confirm({ title: t('gwe.mqtt.lock_title', { user: acc.username }), message: t('gwe.mqtt.lock_msg'), okLabel: t('gwe.mqtt.lock') })) return;
    api('PUT', gwUrl(g.peer_id, '/mqtt/accounts/' + encodeURIComponent(acc.id)), { locked })
      .then(() => { toast(t(locked ? 'gwe.mqtt.locked_done' : 'gwe.mqtt.unlocked_done', { user: acc.username })); return reload(g.peer_id); })
      .catch((e) => D.alert({ message: errText(e), danger: true }));
  }

  async function removeAccount(g, d, acc) {
    const plugin = acc.pluginId ? ((d.plugins || []).find((p) => p.id === acc.pluginId) || {}).name || acc.pluginId : null;
    const ok = await D.confirm({
      title: t('gwe.mqtt.delete_title', { user: acc.username }),
      message: t('gwe.mqtt.delete_msg'),
      detail: plugin ? t('gwe.mqtt.delete_plugin', { plugin }) : null,
      okLabel: t('common.delete'), danger: true,
    });
    if (!ok) return;
    api('DELETE', gwUrl(g.peer_id, '/mqtt/accounts/' + encodeURIComponent(acc.id)))
      .then(() => { toast(t('gwe.mqtt.deleted_done', { user: acc.username })); return reload(g.peer_id); })
      .catch((e) => D.alert({ message: errText(e), danger: true }));
  }

  async function newPassword(g, d, acc) {
    const ok = await D.confirm({ title: t('gwe.mqtt.pw_title', { user: acc.username }), message: t('gwe.mqtt.pw_msg'), okLabel: t('gwe.mqtt.pw_ok'), danger: true });
    if (!ok) return;
    api('POST', gwUrl(g.peer_id, '/mqtt/accounts/' + encodeURIComponent(acc.id) + '/password'))
      .then((j) => { passwordDialog(g, d, j.account, j.password, 'reset'); reload(g.peer_id); })
      .catch((e) => D.alert({ message: errText(e), danger: true }));
  }

  // ─── Dialog: new account ──────────────────────────────────────────────
  function accountDialog(g, d) {
    const dlg = openDialog({ title: t('gwe.mqtt.new.title', { gateway: d.name || g.name }), wide: true, cls: 'gwe-newacc' });
    const extra = [];
    const field = (id, label, control, hint, errId) => h('div', { class: 'gwe-field' }, [
      h('label', { class: 'form-label', for: id, text: label }), control,
      hint ? h('span', { class: 'form-hint', id: id + '-hint', text: hint }) : null,
      errId ? h('span', { class: 'gwe-ferr', id: errId, role: 'alert', hidden: true }) : null,
    ]);
    const tpl = h('select', { id: 'gwe-acc-tpl', class: 'form-select', 'aria-describedby': 'gwe-acc-tpl-hint' },
      K.TEMPLATES.map((x) => h('option', { value: x.id, text: t('gwe.mqtt.tpl.' + x.id) })));
    const user = h('input', { type: 'text', id: 'gwe-acc-user', class: 'form-input mono', autocomplete: 'off', spellcheck: 'false', maxLength: 48,
      'aria-describedby': 'gwe-acc-user-hint gwe-acc-user-err' });
    const label = h('input', { type: 'text', id: 'gwe-acc-label', class: 'form-input', autocomplete: 'off', maxLength: 80, 'aria-describedby': 'gwe-acc-label-hint' });
    const tplHint = h('p', { class: 'form-hint gwe-tpl-note' });
    const topics = h('ul', { class: 'gwe-topic-list' });
    const newTopic = h('input', { type: 'text', id: 'gwe-acc-topic', class: 'form-input mono', autocomplete: 'off', spellcheck: 'false', maxLength: 128,
      placeholder: t('gwe.mqtt.new.topic_ph'), 'aria-describedby': 'gwe-acc-topic-err' });
    const access = h('select', { id: 'gwe-acc-access', class: 'form-select' }, K.ACCESS.map((x) => h('option', { value: x, text: t('gwe.mqtt.access.' + x) })));
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('gwe.mqtt.new.add') });
    const err = errorBox();
    dlg.body.append(
      field('gwe-acc-tpl', t('gwe.mqtt.new.device'), tpl, t('gwe.mqtt.new.device_hint')),
      tplHint,
      h('div', { class: 'gwe-grid2 gwe-grid2-tight' }, [
        field('gwe-acc-user', t('gwe.mqtt.new.user'), user, t('gwe.mqtt.new.user_hint'), 'gwe-acc-user-err'),
        field('gwe-acc-label', t('gwe.mqtt.new.label'), label, t('gwe.mqtt.new.label_hint')),
      ]),
      h('fieldset', { class: 'gwe-fieldset' }, [
        h('legend', { text: t('gwe.mqtt.new.topics') }),
        topics,
        h('div', { class: 'gwe-topic-add' }, [
          h('div', { class: 'gwe-field gwe-grow' }, [h('label', { class: 'form-label', for: 'gwe-acc-topic', text: t('gwe.mqtt.new.topic') }), newTopic]),
          h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: 'gwe-acc-access', text: t('gwe.mqtt.new.access') }), access]),
          addBtn,
        ]),
        h('span', { class: 'gwe-ferr', id: 'gwe-acc-topic-err', role: 'alert', hidden: true }),
        h('span', { class: 'form-hint', text: t('gwe.mqtt.new.topics_hint') }),
      ]),
      note('info', [t('gwe.mqtt.new.pw_note')], 'key'),
      err);
    const create = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwe.mqtt.new.create') });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), create);

    const userErr = dlg.body.querySelector('#gwe-acc-user-err');
    const topicErr = dlg.body.querySelector('#gwe-acc-topic-err');
    function fieldErr(input, node, msg) { node.textContent = msg || ''; node.hidden = !msg; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); }
    function drawTopics() {
      const planned = K.plannedTopics(tpl.value, user.value.trim(), extra);
      topics.replaceChildren(...planned.map((x) => {
        const li = h('li', { class: 'gwe-topic' }, [h('code', { class: 'gwe-mono', text: x.topic }),
          h('span', { class: 'gwe-muted', text: x.source === 'extra' ? t('gwe.mqtt.access.' + x.access) : t('gwe.mqtt.new.src_' + x.source) })]);
        if (x.source === 'extra') {
          const rm = h('button', { type: 'button', class: 'icon-action danger', 'aria-label': t('gwe.mqtt.new.remove', { topic: x.topic }), title: t('gwe.mqtt.new.remove', { topic: x.topic }) }, icon('trash', 14));
          rm.addEventListener('click', () => { const i = extra.findIndex((y) => y.topic === x.topic); if (i >= 0) extra.splice(i, 1); drawTopics(); newTopic.focus(); });
          li.appendChild(rm);
        }
        return li;
      }));
      tplHint.textContent = t('gwe.mqtt.tpl_d.' + tpl.value);
    }
    tpl.addEventListener('change', drawTopics);
    user.addEventListener('input', () => { fieldErr(user, userErr, ''); drawTopics(); });
    function addTopic() {
      const v = newTopic.value.trim();
      if (!v) return;
      if (!K.topicOk(v)) { fieldErr(newTopic, topicErr, t('gwe.mqtt.new.topic_invalid')); newTopic.focus(); return; }
      if (K.plannedTopics(tpl.value, user.value.trim(), extra).some((x) => x.topic === v)) { fieldErr(newTopic, topicErr, t('gwe.mqtt.new.topic_dup')); return; }
      if (K.plannedTopics(tpl.value, user.value.trim(), extra).length >= K.TOPICS_MAX) { fieldErr(newTopic, topicErr, t('gwe.mqtt.new.topic_max', { max: K.TOPICS_MAX })); return; }
      extra.push({ topic: v, access: access.value });
      newTopic.value = '';
      fieldErr(newTopic, topicErr, '');
      drawTopics();
      newTopic.focus();
    }
    addBtn.addEventListener('click', addTopic);
    newTopic.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTopic(); } });
    newTopic.addEventListener('input', () => fieldErr(newTopic, topicErr, ''));
    drawTopics();

    create.addEventListener('click', () => {
      const u = user.value.trim();
      const bad = K.usernameProblem(u);
      if (bad) { fieldErr(user, userErr, t(bad)); user.focus(); return; }
      if (newTopic.value.trim()) { addTopic(); if (!topicErr.hidden) return; }
      create.disabled = true;
      showErr(err, '');
      api('POST', gwUrl(g.peer_id, '/mqtt/accounts'), K.accountBody(tpl.value, u, label.value.trim(), extra))
        .then((j) => { dlg.close(true); passwordDialog(g, d, j.account, j.password, 'new'); reload(g.peer_id); })
        .catch((e) => {
          create.disabled = false;
          if (e.code === 'exists') { fieldErr(user, userErr, t('gwe.err.exists')); user.focus(); return; }
          showErr(err, errText(e));
        });
    });
    tpl.focus();
  }

  // ─── Dialog: the password, exactly once ───────────────────────────────
  function passwordDialog(g, d, account, password, mode) {
    const dlg = openDialog({ title: t(mode === 'new' ? 'gwe.pw.title_new' : 'gwe.pw.title_reset', { user: account.username }), wide: true, cls: 'gwe-pwdlg',
      returnFk: mode === 'new' ? 'gwe-acc-new' : 'pw:' + account.id });
    let secret = password;
    const tls = !!(d.settings && d.settings.mqttTls);
    const server = K.brokerAddress(lanIp(g), false);
    const prefix = K.topicPrefix(account);
    const pwNode = h('code', { class: 'gwe-mono gwe-v gwe-secret', text: secret });
    const row = (k, valueNode, getText, label) => h('div', { class: 'gwe-pw-row' }, [h('span', { class: 'gwe-k', text: k }), valueNode, getText ? copyBtn(getText, label) : null]);
    dlg.body.append(
      h('p', { class: 'gwe-intro', text: t('gwe.pw.intro') }),
      h('div', { class: 'gwe-pw-rows' }, [
        row(t('gwe.pw.server'), server ? h('code', { class: 'gwe-mono gwe-v', text: server }) : h('span', { class: 'gwe-v gwe-muted', text: t('gwe.mqtt.address_unknown') }),
          server ? () => server : null, t('gwe.pw.copy_server')),
        row(t('gwe.pw.user'), h('code', { class: 'gwe-mono gwe-v', text: account.username }), () => account.username, t('gwe.pw.copy_user')),
        row(t('gwe.pw.password'), pwNode, () => secret || '', t('gwe.pw.copy_password')),
        row(t('gwe.pw.prefix'), h('code', { class: 'gwe-mono gwe-v', text: prefix }), () => prefix, t('gwe.pw.copy_prefix')),
      ]),
      ...(tls ? [h('p', { class: 'form-hint', text: t('gwe.pw.tls', { port: 8883 }) })] : []));
    const done = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwe.pw.done'), on: { click: () => dlg.close(true) } });
    dlg.foot.append(done);
    // closing (button, ×, Escape) forgets the password: node emptied, overlay removed by GCDialog
    dlg.promise.then(() => { pwNode.textContent = ''; secret = null; });
    done.focus();
  }

  // ─── Public ───────────────────────────────────────────────────────────
  function mount(box, g, tab, ctx) {
    guideGw = g.peer_id;
    // tabs "Funktionen", "Netzwerk" and "Internet" (phase 3a) live in gateway-net.js
    if ((tab === 'features' || tab === 'net' || tab === 'inet') && window.GCGatewayNet) {
      cur = null;
      if (window.GCGatewayHome) window.GCGatewayHome.unmount();
      window.GCGatewayNet.mount(box, g, tab, ctx || {});
      load(g.peer_id, false).then(() => fillBadges(document, g.peer_id), () => {});
      return;
    }
    // tabs "DNS-Filter" and "Zwischenspeicher" (phase 3b) live in gateway-home.js
    // tab "Funk" (phase 3c, step 2) lives in gateway-radio.js
    if (tab === 'radio' && window.GCGatewayRadio) {
      cur = null;
      if (window.GCGatewayNet) window.GCGatewayNet.unmount();
      if (window.GCGatewayHome) window.GCGatewayHome.unmount();
      window.GCGatewayRadio.mount(box, g, tab, ctx || {});
      if (window.GCGatewayNet) window.GCGatewayNet.prefetch(g);
      load(g.peer_id, false).then(() => fillBadges(document, g.peer_id), () => {});
      return;
    }
    if (window.GCGatewayRadio) window.GCGatewayRadio.unmount();
    if ((tab === 'dns' || tab === 'cache') && window.GCGatewayHome) {
      cur = null;
      if (window.GCGatewayNet) window.GCGatewayNet.unmount();
      window.GCGatewayHome.mount(box, g, tab, ctx || {});
      load(g.peer_id, false).then(() => fillBadges(document, g.peer_id), () => {});
      return;
    }
    if (window.GCGatewayNet) window.GCGatewayNet.unmount();
    if (window.GCGatewayHome) window.GCGatewayHome.unmount();
    cur = { box, g, tab, ctx: ctx || {} };
    box.classList.add('gwe-panel');
    draw();
    load(g.peer_id, false).then(() => { redraw(); updateBadges(); }, () => redraw());
  }
  function prefetch(g) {
    load(g.peer_id, false).then(() => fillBadges(document, g.peer_id), () => {});
    if (window.GCGatewayNet) window.GCGatewayNet.prefetch(g);
    if (window.GCGatewayHome) window.GCGatewayHome.prefetch(g);
  }
  function unmount() { cur = null; if (window.GCGatewayNet) window.GCGatewayNet.unmount(); if (window.GCGatewayHome) window.GCGatewayHome.unmount(); if (window.GCGatewayRadio) window.GCGatewayRadio.unmount(); }

  // Building blocks shared with the tabs "Netzwerk" / "Internet" (gateway-net.js)
  const ui = { t, api, errText, icon, tag, card, note, guide, chip, switchBtn, fmtTime, fmtDate, openDialog, errorBox, showErr, bigNote, whatsNew, restoreFocus, focusKey, toast, LANG };

  window.GCGatewayEdge = { tabs, mount, prefetch, unmount, fillBadges, ui, _cache: cache };
})();
