// public/js/portal.js — GateControl portal (redesign "variant A": tabs).
//
// Start · Dienste · Zuhause · Fahrzeug · Netzwerk · Meine Geräte. The tabs
// are URL-addressable (#start, #dienste, #zuhause, #fahrzeug, #netzwerk,
// #geraete) and a WAI-ARIA tablist (arrow keys, Home/End). Every area that
// is unlicensed or has no data is hidden (tab, panel and start card).
//
// Data: /api/v1/portal/* (device, traffic, services, pihole + owner/household,
// me/devices, me/enrollment, plugins/start + search). "Zuhause" and
// "Fahrzeug" hold plugin sections only (sandboxed frames, docs/plugins.md
// "Portal"). Managing devices needs a portal or web session (ctx.loggedIn);
// the server checks again. "Gerät sperren" asks first.
//
// Rendering: DOM nodes and textContent only — never innerHTML. Strings come
// from the #portal-i18n island (every portal.* key), context from #portal-ctx.
'use strict';
(function () {
  var doc = document;

  function readJson(id) {
    try { return JSON.parse((doc.getElementById(id) || {}).textContent || '{}') || {}; } catch (_) { return {}; }
  }
  var I18N = readJson('portal-i18n');
  var CTX = readJson('portal-ctx');
  var TABS = CTX.tabs || {};
  var LANG = (doc.documentElement.lang || 'de').slice(0, 2).toLowerCase();
  var noMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function T(key, params) {
    var s = Object.prototype.hasOwnProperty.call(I18N, key) ? String(I18N[key]) : key;
    if (params) {
      Object.keys(params).forEach(function (k) {
        s = s.split('{{' + k + '}}').join(String(params[k]));
      });
    }
    return s;
  }

  // ─── DOM helpers ────────────────────────────────────────────────────────
  // Attributes el() may set: a fixed list of literal names, so no text
  // (server, cloud or exception text) can become an event handler, a script
  // URL or markup. href/src only for same-origin paths, #hash, https URLs
  // (src additionally data:image/png;base64 for the setup QR code).
  var SVGNS = 'http://www.w3.org/2000/svg';
  function safeUrl(v, allowDataPng) {
    var s = String(v == null ? '' : v);
    if (/^\/(?![/\\])/.test(s) && s.indexOf('\\') < 0) return s;
    if (/^#[\w-]*$/.test(s)) return s;
    if (allowDataPng && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s)) return s;
    try {
      var u = new URL(s);
      if (u.protocol === 'https:') return u.href;
    } catch (_) { /* not a URL */ }
    return '#';
  }
  var PLAIN_ATTRS = ['id', 'title', 'role', 'name', 'placeholder', 'inputmode', 'autocomplete', 'min', 'max', 'step', 'pattern',
    'aria-label', 'aria-hidden', 'aria-pressed', 'aria-checked', 'aria-expanded', 'aria-controls', 'aria-live', 'aria-modal',
    'aria-labelledby', 'aria-describedby', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-busy', 'tabindex',
    'data-id', 'data-act', 'data-mode', 'data-step', 'data-cmd', 'data-day', 'data-veh', 'data-timer', 'data-scope', 'data-range',
    'data-goto', 'data-section', 'data-tone', 'data-on', 'data-state', 'data-topic', 'alt', 'loading', 'maxlength', 'for', 'datetime', 'width', 'height'];
  function setAttr(n, k, v) {
    var s = v === true ? '' : String(v);
    if (k === 'href') { n.setAttribute('href', safeUrl(v, false)); return; }
    if (k === 'src') { n.setAttribute('src', safeUrl(v, true)); return; }
    if (k === 'target') { if (s === '_blank') n.target = '_blank'; return; }
    if (k === 'rel') { n.rel = s; return; }
    if (PLAIN_ATTRS.indexOf(k) >= 0) n.setAttribute(k, s);
  }
  function el(tag, props, children) {
    var n = doc.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected' || k === 'hidden' || k === 'type' || k === 'open') n[k] = v;
      else setAttr(n, k, v);
    });
    [].concat(children == null ? [] : children).forEach(function (c) {
      if (c == null || c === false) return;
      // A string becomes a Text node — never markup.
      n.append(c instanceof window.Node ? c : String(c));
    });
    return n;
  }
  function icon(d, size) {
    var svg = doc.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.9'], ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['width', String(size || 18)], ['height', String(size || 18)]]
      .forEach(function (a) { svg.setAttribute(a[0], a[1]); });
    var path = doc.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }
  var ICON = {
    ac: 'M2 4h20v10H2zM6 18v1M10 18v2M14 18v2M18 18v1',
    pc: 'M3 5h18v11H3zM8 20h8M12 16v4',
    car: 'M5 16l1.5-5h11L19 16M4 16h16v3H4zM7 19v2M17 19v2',
  };
  function $(id) { return doc.getElementById(id); }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function show(n, on) { if (n) n.hidden = !on; }
  function setText(id, text) { var n = $(id); if (n) n.textContent = text; }

  // ─── Formatting ─────────────────────────────────────────────────────────
  var BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  function fmtBytes(bytes) {
    var v = Number(bytes);
    if (!isFinite(v) || v <= 0) return '0 B';
    var i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
    var num = i === 0 ? String(Math.round(v)) : new Intl.NumberFormat(LANG, { maximumFractionDigits: 1 }).format(v);
    return num + ' ' + BYTE_UNITS[i];
  }
  function fmtNum(v, digits) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return '–';
    return new Intl.NumberFormat(LANG, { maximumFractionDigits: digits == null ? 0 : digits }).format(n);
  }
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    var s = String(v);
    var d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  var rtf = null;
  try { rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' }); } catch (_) { rtf = null; }
  function rel(v) {
    var d = toDate(v);
    if (!d) return '–';
    var sec = Math.round((d.getTime() - Date.now()) / 1000);
    var abs = Math.abs(sec);
    if (abs < 45) return T('portal.time.now');
    if (!rtf) return d.toLocaleString(LANG);
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 45) return rtf.format(Math.round(sec / 86400), 'day');
    return rtf.format(Math.round(sec / (86400 * 30)), 'month');
  }
  function fmtDate(v) {
    var d = toDate(v);
    if (!d) return '';
    try { return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); }
  }

  // ─── Network ────────────────────────────────────────────────────────────
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (body) { return { status: r.status, body: body }; }); });
  }
  function send(method, url, body) {
    var headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': CTX.csrf || '' };
    return fetch(url, { method: method, credentials: 'same-origin', headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, body: b }; }); });
  }
  function okData(res) { return !!(res && res.status === 200 && res.body && res.body.ok && res.body.data != null); }

  // ─── Small UI pieces ────────────────────────────────────────────────────
  var toastBox = null;
  var toastTimer = null;
  function toast(text, tone) {
    if (!toastBox) { toastBox = el('div', { class: 'pt-toast', role: 'status', 'aria-live': 'polite' }); doc.body.appendChild(toastBox); }
    clear(toastBox).appendChild(el('div', { class: 'pt-toast-item' + (tone === 'error' ? ' is-error' : '') }, text));
    toastBox.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastBox.classList.remove('is-on'); }, 3200);
  }
  function message(id, text) {
    var n = $(id);
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
  }
  function empty(text) { return el('div', { class: 'pt-empty' }, text); }

  // In-app confirmation (no window.confirm). Promise<boolean>; Escape, the
  // backdrop and "Abbrechen" answer false; focus returns to the opener.
  function portalConfirm(o) {
    return new Promise(function (resolve) {
      var prev = doc.activeElement;
      var titleId = 'pt-dlg-t-' + Date.now();
      var cancel = el('button', { type: 'button', class: 'pt-btn' }, T('portal.cancel'));
      var ok = el('button', { type: 'button', class: 'pt-btn ' + (o.danger ? 'pt-btn-danger-solid' : 'pt-btn-primary') }, o.okLabel || T('portal.ok'));
      var box = el('div', { class: 'pt-dialog', role: o.danger ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
        el('h2', { class: 'pt-h2', id: titleId }, o.title || ''),
        o.message ? el('p', { class: 'pt-dialog-text' }, o.message) : null,
        el('div', { class: 'pt-dialog-foot' }, [cancel, ok]),
      ]);
      var overlay = el('div', { class: 'pt-overlay' }, box);
      var done = false;
      function close(v) {
        if (done) return;
        done = true;
        doc.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (prev && prev.focus && doc.contains(prev)) { try { prev.focus(); } catch (_) { /* cosmetic */ } }
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
        if (e.key === 'Tab') { // keep focus inside the two buttons
          e.preventDefault();
          (doc.activeElement === ok ? cancel : ok).focus();
        }
      }
      cancel.addEventListener('click', function () { close(false); });
      ok.addEventListener('click', function () { close(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
      doc.addEventListener('keydown', onKey, true);
      doc.body.appendChild(overlay);
      (o.danger ? cancel : ok).focus();
    });
  }

  // ─── Theme ──────────────────────────────────────────────────────────────
  (function initTheme() {
    var html = doc.documentElement;
    function stored() { try { return localStorage.getItem('gc-portal-theme'); } catch (_) { return null; } }
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        if (!stored()) html.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      });
    }
    var btn = $('themeBtn');
    if (btn) btn.addEventListener('click', function () {
      var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      try { localStorage.setItem('gc-portal-theme', next); } catch (_) { /* storage unavailable — theme just won't persist */ }
    });
  })();

  // ─── Greeting ───────────────────────────────────────────────────────────
  (function greet() {
    var h = $('pt-greeting');
    if (!h || !CTX.person || !CTX.firstName) return;
    var hour = new Date().getHours();
    var key = hour < 11 ? 'portal.greet.morning' : (hour < 18 ? 'portal.greet.day' : 'portal.greet.evening');
    h.textContent = T(key, { name: CTX.firstName });
  })();

  // ─── Tabs ───────────────────────────────────────────────────────────────
  var tabList = doc.querySelector('.pt-tablist');
  function tabs() { return Array.prototype.slice.call(doc.querySelectorAll('.pt-tab')).filter(function (t) { return !t.hidden; }); }
  // Pages without a tab of their own (data-extra: #mitteilungen,
  // #benachrichtigungen) are addressed the same way; no tab is selected then.
  function extraPanels() { return Array.prototype.slice.call(doc.querySelectorAll('.pt-panel[data-extra]')).filter(function (p) { return !p.hasAttribute('data-off'); }); }
  function isExtra(id) { return extraPanels().some(function (p) { return p.getAttribute('data-panel') === id; }); }
  function validTab(id) { return tabs().some(function (t) { return t.getAttribute('data-tab') === id; }) || isExtra(id); }
  var panelListeners = [];
  function onPanel(fn) { panelListeners.push(fn); }
  function activate(id, opts) {
    var o = opts || {};
    if (!validTab(id)) id = 'start';
    var extra = isExtra(id);
    var list = tabs();
    list.forEach(function (t, i) {
      var on = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      // keep one tab reachable with the keyboard while a page without a tab is open
      t.setAttribute('tabindex', on || (extra && i === 0) ? '0' : '-1');
      if (on && t.scrollIntoView && tabList && tabList.scrollWidth > tabList.clientWidth) {
        try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) { /* old browsers */ }
      }
      if (on && o.focus) t.focus();
    });
    doc.querySelectorAll('.pt-panel').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== id; });
    panelListeners.forEach(function (fn) { try { fn(id); } catch (_) { /* a page's own problem */ } });
    if (o.push && location.hash !== '#' + id) {
      try { history.pushState(null, '', '#' + id); } catch (_) { location.hash = id; }
    }
    if (o.scroll) window.scrollTo(0, 0);
    // Redraw the traffic chart once its tab is visible (fixed id, no lookup by name).
    if (id === 'netzwerk' && traffic) renderTraffic();
  }
  if (tabList) {
    tabList.addEventListener('click', function (e) {
      var t = e.target.closest('.pt-tab');
      if (!t) return;
      e.preventDefault();
      activate(t.getAttribute('data-tab'), { push: true });
    });
    tabList.addEventListener('keydown', function (e) {
      var list = tabs();
      var i = list.indexOf(doc.activeElement);
      if (i < 0) return;
      var next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = list[(i + 1) % list.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
      else if (e.key === 'Home') next = list[0];
      else if (e.key === 'End') next = list[list.length - 1];
      if (!next) return;
      e.preventDefault();
      activate(next.getAttribute('data-tab'), { focus: true, push: true });
    });
  }
  doc.addEventListener('click', function (e) {
    var a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    var id = a.getAttribute('data-goto');
    activate(id, { push: true, scroll: true });
    var panel = $('panel-' + id);
    if (panel && !panel.hidden) panel.focus({ preventScroll: true });
    // a plugin section inside the tab (Start tiles, search results)
    var sec = a.getAttribute('data-section') ? $(a.getAttribute('data-section')) : null;
    if (sec && sec.scrollIntoView && panel && !panel.hidden) { try { sec.scrollIntoView({ block: 'start', behavior: noMotion ? 'auto' : 'smooth' }); } catch (_) { /* old browsers */ } }
  });
  window.addEventListener('popstate', function () { activate(location.hash.slice(1)); });
  window.addEventListener('hashchange', function () { activate(location.hash.slice(1)); });

  // Hide an area that has nothing to show: its start card(s), tab and panel.
  function hideArea(area, tab) {
    doc.querySelectorAll('[data-area="' + area + '"]').forEach(function (c) { c.hidden = true; });
    if (!tab) return;
    var t = $('tab-' + tab);
    var p = $('panel-' + tab);
    if (t) t.hidden = true;
    if (p) p.hidden = true;
    if (location.hash.slice(1) === tab) activate('start');
  }

  // ═══ Device + traffic + Pi-hole (status strip, Netzwerk) ═══════════════
  var traffic = null;
  var trafficRange = '7d';
  var netState = { device: TABS.device ? 'pending' : 'off', traffic: TABS.traffic ? 'pending' : 'off', pihole: TABS.pihole ? 'pending' : 'off' };
  function netSettled(part, ok) {
    netState[part] = ok ? 'ok' : 'none';
    var keys = Object.keys(netState);
    if (keys.some(function (k) { return netState[k] === 'pending'; })) return;
    if (!keys.some(function (k) { return netState[k] === 'ok'; })) hideArea('net', 'netzwerk');
  }

  function loadDevice() {
    if (!TABS.device) return;
    getJson('/api/v1/portal/device').then(function (res) {
      if (!okData(res)) { hideArea('device'); netSettled('device', false); return; }
      var d = res.body.data;
      var ip = String(d.allowed_ips || '').split(',')[0].split('/')[0];
      var strip = $('pt-strip-state');
      if (strip) strip.classList.toggle('is-off', !d.isOnline);
      setText('pt-strip-state-text', d.isOnline ? T('portal.strip.active') : T('portal.strip.inactive'));
      setText('pt-strip-device', d.name || '');
      setText('pt-strip-ip', ip || '–');
      setText('pt-strip-hs', rel(d.latestHandshake));
      var st = $('pt-d-status');
      if (st) { st.textContent = d.isOnline ? T('portal.device.online') : T('portal.device.offline'); st.setAttribute('data-tone', d.isOnline ? 'good' : 'muted'); }
      setText('pt-d-ip', ip || '–');
      setText('pt-d-dns', d.dns || '–');
      setText('pt-d-hs', rel(d.latestHandshake));
      setText('pt-d-xfer', '↓ ' + fmtBytes(d.transferRx) + ' · ↑ ' + fmtBytes(d.transferTx));
      netSettled('device', true);
    }).catch(function () { netSettled('device', false); });
  }

  var weekday = null;
  try { weekday = new Intl.DateTimeFormat(LANG, { weekday: 'short' }); } catch (_) { weekday = null; }
  function bucketLabel(iso, range, i) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(i + 1);
    if (range === '24h') return String(d.getHours()).padStart(2, '0');
    if (range === '30d') return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' });
    return weekday ? weekday.format(d) : String(i + 1);
  }
  function renderBars(host, series, opts) {
    if (!host) return;
    clear(host);
    var o = opts || {};
    var max = Math.max.apply(null, series.map(function (b) { return o.split ? Math.max(b.rx || 0, b.tx || 0) : (b.rx || 0) + (b.tx || 0); }).concat([1]));
    series.forEach(function (b, i) {
      var col = el('div', { class: 'pt-bar-col' });
      if (o.split) {
        var rx = el('span', { class: 'pt-bar is-rx' });
        var tx = el('span', { class: 'pt-bar is-tx' });
        rx.style.setProperty('--h', Math.max(2, Math.round((b.rx || 0) / max * 100)) + '%');
        tx.style.setProperty('--h', Math.max(2, Math.round((b.tx || 0) / max * 100)) + '%');
        col.appendChild(el('div', { class: 'pt-bar-pair' }, [rx, tx]));
      } else {
        var bar = el('span', { class: 'pt-bar' });
        bar.style.setProperty('--h', Math.max(3, Math.round(((b.rx || 0) + (b.tx || 0)) / max * 100)) + '%');
        col.appendChild(bar);
      }
      if (o.labels) col.appendChild(el('span', { class: 'pt-bar-label' }, o.labels(b, i)));
      host.appendChild(col);
    });
    if (!noMotion) host.classList.add('is-anim');
  }
  function renderTraffic() {
    if (!traffic || !traffic.series) return;
    var series = traffic.series[trafficRange] || [];
    renderBars($('pt-chart'), series, { split: true, labels: function (b, i) { return bucketLabel(b.t, trafficRange, i); } });
    var total = series.reduce(function (s, b) { return s + (b.rx || 0) + (b.tx || 0); }, 0);
    var days = trafficRange === '24h' ? 1 : (trafficRange === '7d' ? 7 : 30);
    var peakIdx = -1;
    var peakVal = -1;
    series.forEach(function (b, i) { var v = (b.rx || 0) + (b.tx || 0); if (v > peakVal) { peakVal = v; peakIdx = i; } });
    setText('pt-t-total', fmtBytes(total));
    setText('pt-t-avg', fmtBytes(Math.round(total / days)));
    setText('pt-t-peak', peakIdx >= 0 && peakVal > 0 ? fmtBytes(peakVal) + ' (' + bucketLabel(series[peakIdx].t, trafficRange, peakIdx) + ')' : '–');
    setText('pt-chart-sr', T('portal.traffic.sr', { total: fmtBytes(total) }));
    var seg = $('pt-traffic-seg');
    if (seg) seg.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-range') === trafficRange ? 'true' : 'false'); });
  }
  function loadTraffic() {
    if (!TABS.traffic) return;
    var seg = $('pt-traffic-seg');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-range]');
        if (!b) return;
        trafficRange = b.getAttribute('data-range');
        renderTraffic();
      });
    }
    getJson('/api/v1/portal/traffic').then(function (res) {
      if (!okData(res)) {
        hideArea('traffic');
        var bars = $('pt-start-bars');
        if (bars && bars.parentNode) bars.parentNode.hidden = true;
        netSettled('traffic', false);
        return;
      }
      traffic = res.body.data;
      renderTraffic();
      var week = (traffic.series && traffic.series['7d']) || [];
      renderBars($('pt-start-bars'), week, {});
      var axis = clear($('pt-start-bars-axis'));
      if (axis && week.length) {
        axis.appendChild(el('span', null, bucketLabel(week[0].t, '7d', 0)));
        axis.appendChild(el('span', null, bucketLabel(week[week.length - 1].t, '7d', week.length - 1)));
      }
      var weekTotal = week.reduce(function (s, b) { return s + (b.rx || 0) + (b.tx || 0); }, 0);
      setText('pt-start-bars-sr', T('portal.traffic.sr', { total: fmtBytes(weekTotal) }));
      if (traffic.last24h) {
        setText('pt-strip-today', '↓ ' + fmtBytes(traffic.last24h.rx) + ' · ↑ ' + fmtBytes(traffic.last24h.tx));
        show($('pt-strip-today-wrap'), true);
      }
      netSettled('traffic', true);
    }).catch(function () { netSettled('traffic', false); });
  }

  var PI_URL = { device: '/api/v1/portal/pihole', owner: '/api/v1/portal/pihole/owner', household: '/api/v1/portal/pihole/household' };
  function setDonut(node, pct) {
    if (!node) return;
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    node.style.setProperty('--p', p + '%');
  }
  function renderPiReason(reason) {
    show($('pt-pi-body'), false);
    show($('pt-pi-foot'), false);
    var box = $('pt-pi-msg');
    if (!box) return;
    clear(box);
    var key = { no_owner: 'portal.pihole.no_owner', login_required: 'portal.pihole.login_required', collapsed: 'portal.pihole.collapsed',
      no_data: 'portal.pihole.no_data', unidentified: 'portal.pihole.unidentified' }[reason] || 'portal.pihole.unavailable';
    box.appendChild(el('span', null, T(key)));
    if (reason === 'no_owner' || reason === 'login_required') {
      box.appendChild(doc.createTextNode(' '));
      box.appendChild(el('a', { href: '/login?returnTo=/portal' }, T('portal.login')));
    }
    box.hidden = false;
  }
  function loadPihole(scope, first) {
    if (!TABS.pihole) return;
    var url = Object.prototype.hasOwnProperty.call(PI_URL, scope) ? PI_URL[scope] : PI_URL.device;
    getJson(url).then(function (res) {
      var body = res.body || {};
      if (!okData(res)) {
        if (first && scope === 'device' && body.reason === 'unavailable') { hideArea('pihole'); netSettled('pihole', false); return; }
        renderPiReason(body.reason);
        if (first) netSettled('pihole', true);
        return;
      }
      var d = body.data;
      show($('pt-pi-body'), true);
      show($('pt-pi-foot'), true);
      setDonut($('pt-pi-donut'), d.blockedPct);
      setText('pt-pi-pct', fmtNum(d.blockedPct) + ' %');
      setText('pt-pi-total', fmtNum(d.total));
      setText('pt-pi-blocked', fmtNum(d.blocked));
      var household = scope === 'household';
      show($('pt-pi-allowed-l'), !household);
      show($('pt-pi-allowed'), !household);
      setText('pt-pi-allowed', fmtNum(d.allowed));
      if (scope === 'owner') { setText('pt-pi-extra-l', T('portal.pihole.devices')); setText('pt-pi-extra', fmtNum(d.deviceCount)); }
      if (household) { setText('pt-pi-extra-l', T('portal.pihole.active_clients')); setText('pt-pi-extra', fmtNum(d.activeClients || 0)); }
      show($('pt-pi-extra-l'), scope !== 'device');
      show($('pt-pi-extra'), scope !== 'device');
      message('pt-pi-msg', d.total === 0 ? T('portal.pihole.zero_queries') : '');
      if (scope === 'device') {
        setDonut($('pt-start-donut'), d.blockedPct);
        setText('pt-start-donut-v', fmtNum(d.blockedPct) + ' %');
        show($('pt-start-pi'), true);
        setText('pt-strip-pi', T('portal.strip.adblock_value', { pct: fmtNum(d.blockedPct) }));
        show($('pt-strip-pi-wrap'), true);
      }
      if (first) netSettled('pihole', true);
    }).catch(function () { if (first) netSettled('pihole', false); });
  }
  (function wirePiSeg() {
    var seg = $('pt-pi-seg');
    if (!seg) return;
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-scope]');
      if (!b) return;
      seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      message('pt-pi-msg', '');
      loadPihole(b.getAttribute('data-scope'), false);
    });
  })();

  // ═══ Services ═══════════════════════════════════════════════════════════
  var services = [];
  var PALETTE = 5;
  var RECENT_KEY = 'gc-portal-recent';
  function recentIds() {
    try { var v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.slice(0, 10) : []; } catch (_) { return []; }
  }
  function remember(id) {
    try {
      var list = recentIds().filter(function (x) { return x !== id; });
      list.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
    } catch (_) { /* storage unavailable */ }
  }
  function letter(name) { return (Array.from(String(name || '?').trim())[0] || '?').toUpperCase(); }
  function validHost(h) { return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(String(h || '')); }
  function serviceTile(s, idx, large) {
    var badge = el('span', { class: 'pt-badge pt-badge-c' + (idx % PALETTE) + (large ? ' is-lg' : ''), 'aria-hidden': 'true' }, letter(s.name));
    var text = el('span', { class: 'pt-tile-text' }, [
      el('b', { class: 'pt-tile-name' }, s.name),
      el('span', { class: 'pt-tile-host' }, s.domain),
      large ? el('span', { class: 'pt-tile-state' }, T('portal.services.web')) : null,
    ]);
    var href = validHost(s.domain) ? 'https://' + s.domain : '#';
    return el('a', { class: large ? 'pt-svc' : 'pt-tile', href: href, target: '_blank', rel: 'noopener noreferrer',
      on: { click: function () { remember('http:' + s.id); } } }, [badge, text]);
  }
  function copyText(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = T('portal.services.copied');
      setTimeout(function () { btn.textContent = old; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast(text); });
    else toast(text);
  }
  function renderServices() {
    var http = services.filter(function (s) { return s.kind !== 'rdp'; });
    var rdp = services.filter(function (s) { return s.kind === 'rdp'; });
    var grid = $('pt-services');
    if (grid) {
      clear(grid);
      if (!http.length) grid.appendChild(empty(T('portal.services.none')));
      http.forEach(function (s, i) { grid.appendChild(serviceTile(s, i, true)); });
    }
    var rdpHost = $('pt-rdp');
    if (rdpHost) {
      clear(rdpHost);
      rdp.forEach(function (r) {
        var btn = el('button', { type: 'button', class: 'pt-btn pt-btn-sm' }, T('portal.services.copy'));
        btn.addEventListener('click', function () { copyText(r.host, btn); });
        rdpHost.appendChild(el('div', { class: 'pt-rdp' }, [
          el('span', { class: 'pt-rdp-ic' }, icon(ICON.pc, 18)),
          el('span', { class: 'pt-tile-text' }, [el('b', { class: 'pt-tile-name' }, r.name), el('span', { class: 'pt-tile-host' }, r.host)]),
          btn,
        ]));
      });
      show($('pt-rdp-wrap'), rdp.length > 0);
    }
    var start = $('pt-start-services');
    if (start) {
      clear(start);
      var rec = recentIds();
      var rank = function (s) { var i = rec.indexOf('http:' + s.id); return i < 0 ? 99 : i; };
      var byRecent = http.slice().sort(function (a, b) { return rank(a) - rank(b); });
      show($('pt-services-sub'), http.some(function (s) { return rank(s) < 99; }));
      byRecent.slice(0, 5).forEach(function (s) { start.appendChild(serviceTile(s, http.indexOf(s), false)); });
      if (!http.length && rdp.length) start.appendChild(empty(T('portal.services.only_rdp')));
    }
    setText('pt-services-all', services.length === 1 ? T('portal.services.all_one') : T('portal.services.all', { count: services.length }));
  }
  function loadServices() {
    if (!TABS.services) return;
    getJson('/api/v1/portal/services').then(function (res) {
      if (!okData(res) || !Array.isArray(res.body.data) || !res.body.data.length) { hideArea('services', 'dienste'); return; }
      services = res.body.data;
      renderServices();
    }).catch(function () { hideArea('services', 'dienste'); });
  }

  // ═══ Meine Geräte ═══════════════════════════════════════════════════════
  var devices = [];
  function platformText(p) {
    if (!p || !p.platform) return '';
    var pl = String(p.platform).toLowerCase();
    var name = pl === 'android' ? T('portal.devices.android') : (/^win/.test(pl) ? T('portal.devices.windows') : String(p.platform));
    return name + (p.client_version ? ' ' + p.client_version : '');
  }
  function deviceMeta(d) {
    var p = d.peer;
    var parts = [];
    var plat = platformText(p);
    if (plat) parts.push(plat);
    if (p && p.online) parts.push(T('portal.devices.connected', { when: rel(p.last_handshake) }));
    else if (d.last_used_at) parts.push(T('portal.devices.last_seen', { when: rel(d.last_used_at) }));
    if (d.expires_at) parts.push(T('portal.devices.expires', { date: fmtDate(d.expires_at) }));
    return parts.join(' · ');
  }
  function lockDevice(d) {
    // Sensitive: locking an own device asks first.
    portalConfirm({ title: T('portal.devices.lock_title', { name: d.name }), message: T('portal.devices.lock_text'), okLabel: T('portal.devices.lock_ok'), danger: true })
      .then(function (ok) {
        if (!ok) return;
        send('DELETE', '/api/v1/portal/me/devices/' + Number(d.id)).then(function (res) {
          if (res.body && res.body.ok) { toast(T('portal.devices.locked', { name: d.name })); loadDevices(); return; }
          toast(T('portal.devices.lock_failed'), 'error');
        }).catch(function () { toast(T('portal.devices.lock_failed'), 'error'); });
      });
  }
  function renderDevices() {
    var list = $('pt-devices');
    if (list) {
      clear(list);
      if (!devices.length) list.appendChild(el('li', { class: 'pt-empty' }, T('portal.devices.none')));
      devices.forEach(function (d) {
        var on = !!(d.peer && d.peer.online);
        list.appendChild(el('li', { class: 'pt-dev', 'data-id': String(d.id) }, [
          el('span', { class: 'pt-dot' + (on ? '' : ' is-off'), 'aria-hidden': 'true' }),
          el('div', { class: 'pt-grow' }, [
            el('div', null, [el('b', null, d.name), el('span', { class: 'pt-small pt-muted' }, ' · ' + (on ? T('portal.devices.online') : T('portal.devices.offline')))]),
            el('div', { class: 'pt-small pt-muted' }, deviceMeta(d)),
          ]),
          el('span', { class: 'pt-small pt-muted pt-dev-usage' }, d.usage === 'multi' ? T('portal.devices.usage_multi') : T('portal.devices.usage_single')),
          el('button', { type: 'button', class: 'pt-btn pt-btn-sm pt-btn-danger', 'data-act': 'lock', on: { click: function () { lockDevice(d); } } }, T('portal.devices.lock')),
        ]));
      });
    }
    var mini = $('pt-start-devices');
    if (mini) {
      clear(mini);
      if (!devices.length) mini.appendChild(el('li', { class: 'pt-empty' }, T('portal.devices.none')));
      devices.slice(0, 4).forEach(function (d) {
        var on = !!(d.peer && d.peer.online);
        mini.appendChild(el('li', { class: 'pt-dev' }, [el('span', { class: 'pt-dot' + (on ? '' : ' is-off'), 'aria-hidden': 'true' }), el('b', { class: 'pt-grow' }, d.name),
          el('span', { class: 'pt-small pt-muted' }, on ? T('portal.devices.online') : T('portal.devices.offline'))]));
      });
    }
  }
  function loadDevices() {
    if (!TABS.devices) return;
    getJson('/api/v1/portal/me/devices').then(function (res) {
      if (!res.body || !res.body.ok) { hideArea('devices', 'geraete'); return; }
      devices = res.body.devices || [];
      var canEnroll = !!res.body.can_enroll;
      show($('pt-enroll'), canEnroll);
      setText('pt-devices-foot', canEnroll ? T('portal.devices.lost_self') : T('portal.devices.lost_admin'));
      renderDevices();
    }).catch(function () { hideArea('devices', 'geraete'); });
  }
  (function wireEnroll() {
    var btn = $('pt-enroll');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var prev = doc.activeElement;
      var titleId = 'pt-enroll-t';
      var pihole = TABS.pihole ? el('input', { type: 'checkbox' }) : null;
      var err = el('div', { class: 'pt-alert', role: 'alert', hidden: true });
      var codeBox = el('div', { class: 'pt-code', hidden: true });
      var create = el('button', { type: 'button', class: 'pt-btn pt-btn-primary' }, T('portal.devices.enroll_create'));
      var closeBtn = el('button', { type: 'button', class: 'pt-btn' }, T('portal.close'));
      var timer = null;
      var box = el('div', { class: 'pt-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
        el('h2', { class: 'pt-h2', id: titleId }, T('portal.devices.new')),
        el('p', { class: 'pt-dialog-text' }, T('portal.devices.enroll_text')),
        pihole ? el('label', { class: 'pt-check' }, [pihole, T('portal.devices.enroll_pihole')]) : null,
        codeBox, err,
        el('div', { class: 'pt-dialog-foot' }, [closeBtn, create]),
      ]);
      var overlay = el('div', { class: 'pt-overlay' }, box);
      function close() {
        if (timer) clearInterval(timer);
        doc.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (prev && prev.focus) prev.focus();
      }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
      closeBtn.addEventListener('click', close);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      doc.addEventListener('keydown', onKey, true);
      create.addEventListener('click', function () {
        create.disabled = true;
        err.hidden = true;
        send('POST', '/api/v1/portal/me/enrollment', { pihole: !!(pihole && pihole.checked) }).then(function (res) {
          create.disabled = false;
          var b = res.body || {};
          if (res.status !== 201 || !b.ok) { err.textContent = T('portal.devices.enroll_failed'); err.hidden = false; return; }
          clear(codeBox);
          var count = el('div', { class: 'pt-small pt-muted', 'aria-live': 'polite' });
          codeBox.appendChild(el('img', { class: 'pt-qr', src: b.qr, alt: T('portal.devices.qr'), width: '200', height: '200' }));
          codeBox.appendChild(el('div', { class: 'pt-code-value' }, String(b.code || '')));
          codeBox.appendChild(count);
          codeBox.appendChild(el('p', { class: 'pt-small pt-muted' }, T('portal.devices.enroll_help')));
          codeBox.hidden = false;
          create.textContent = T('portal.devices.enroll_again');
          if (timer) clearInterval(timer);
          var tick = function () {
            var left = Math.max(0, Math.floor((Number(b.expiresAt) - Date.now()) / 1000));
            count.textContent = left ? T('portal.devices.valid', { time: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') }) : T('portal.devices.expired');
            if (!left && timer) { clearInterval(timer); timer = null; }
          };
          tick();
          timer = setInterval(tick, 1000);
          loadDevices();
        }).catch(function () { create.disabled = false; err.textContent = T('portal.devices.enroll_failed'); err.hidden = false; });
      });
      doc.body.appendChild(overlay);
      create.focus();
    });
  })();

  // ═══ Plugins: Start tiles (declarative data, rendered here) ═════════════
  // GET /api/v1/portal/plugins/start → [{ title, value, unit, state, icon, goto, anchor }]
  // goto = the portal tab (zuhause, fahrzeug, plg-<id>), anchor = the plugin's section in it.
  var TILE_STATES = ['on', 'off', 'good', 'warn', 'crit'];
  function pluginTile(t) {
    var tone = TILE_STATES.indexOf(t.state) >= 0 ? t.state : null;
    var value = t.value == null ? '' : String(t.value) + (t.unit ? ' ' + t.unit : '');
    return el('a', { class: 'pt-plg-tile', href: '#' + t.goto, 'data-goto': t.goto, 'data-section': t.anchor || null, 'data-tone': tone }, [
      t.icon ? icon(t.icon, 16) : null,
      el('span', { class: 'pt-plg-tile-t' }, t.title),
      value ? el('b', null, value) : null,
    ]);
  }
  function loadPluginStart() {
    if (!TABS.plugins) return;
    getJson('/api/v1/portal/plugins/start').then(function (res) {
      var list = res && res.status === 200 && res.body && Array.isArray(res.body.tiles) ? res.body.tiles : [];
      var by = {};
      list.forEach(function (t) {
        if (!t || typeof t.goto !== 'string' || !/^[a-z0-9-]{1,80}$/.test(t.goto)) return;
        (by[t.goto] = by[t.goto] || []).push(t);
      });
      Object.keys(by).forEach(function (goto) {
        var box = $('pt-start-tiles-' + goto);
        if (!box) return;
        clear(box);
        by[goto].forEach(function (t) { box.appendChild(pluginTile(t)); });
        box.hidden = false;
        var card = $('pt-start-card-' + goto);
        if (card) card.hidden = false;
      });
    }).catch(function () { /* tiles are optional */ });
  }

  // ═══ Search (start) ═════════════════════════════════════════════════════
  (function wireSearch() {
    var input = $('pt-search');
    var box = $('pt-results');
    if (!input || !box) return;
    function hit(label, sub, href, goto, extra) {
      return el('a', { class: 'pt-result', href: href, 'data-goto': goto || null, target: goto ? null : '_blank', rel: goto ? null : 'noopener noreferrer',
        on: extra ? { click: extra } : null }, [el('b', null, label), el('span', { class: 'pt-small pt-muted' }, sub)]);
    }
    // Plugins answer through the server (each with a timeout); results come after the local ones.
    var pluginTimer = null;
    var pluginSeq = 0;
    function pluginSearch(raw, hits) {
      clearTimeout(pluginTimer);
      var seq = ++pluginSeq;
      if (!TABS.plugins || raw.length < 2) return;
      pluginTimer = setTimeout(function () {
        getJson('/api/v1/portal/plugins/search?q=' + encodeURIComponent(raw)).then(function (res) {
          if (seq !== pluginSeq) return; // the query changed meanwhile
          var list = res && res.status === 200 && res.body && Array.isArray(res.body.results) ? res.body.results : [];
          var add = [];
          list.forEach(function (r) {
            if (!r || typeof r.goto !== 'string' || !/^[a-z0-9-]{1,80}$/.test(r.goto)) return;
            add.push(el('a', { class: 'pt-result', href: '#' + r.goto, 'data-goto': r.goto, 'data-section': r.anchor || null },
              [el('b', null, r.title), el('span', { class: 'pt-small pt-muted' }, r.subtitle || '')]));
          });
          if (!add.length) return;
          if (!hits) clear(box);
          add.slice(0, 12).forEach(function (h) { box.appendChild(h); });
          box.hidden = false;
        }).catch(function () { /* search of plugins is optional */ });
      }, 250);
    }
    function run() {
      var raw = input.value.trim();
      var q = raw.toLowerCase();
      clear(box);
      if (!q) { box.hidden = true; pluginSearch(''); return; }
      var hits = [];
      var match = function (s) { return String(s || '').toLowerCase().indexOf(q) >= 0; };
      services.forEach(function (s) {
        if (!match(s.name) && !match(s.domain) && !match(s.host)) return;
        if (s.kind === 'rdp') hits.push(hit(s.name, s.host, '#dienste', 'dienste'));
        else hits.push(hit(s.name, s.domain, validHost(s.domain) ? 'https://' + s.domain : '#', null, function () { remember('http:' + s.id); }));
      });
      devices.forEach(function (d) { if (match(d.name)) hits.push(hit(d.name, T('portal.tab.devices'), '#geraete', 'geraete')); });
      var found = hits.length;
      if (!hits.length) hits.push(empty(T('portal.search_none')));
      hits.slice(0, 12).forEach(function (h) { box.appendChild(h); });
      box.hidden = false;
      pluginSearch(raw, found);
    }
    input.addEventListener('input', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { input.value = ''; run(); } });
  })();

  // ═══ Notifications: bell, Mitteilungen, Meine Benachrichtigungen ════════
  // docs/feature-notification-center.md "Portal". Data: /api/v1/portal/me/notify/*
  //   GET prefs → { topics:[{id,label,enabled,locked}], quiet_from, quiet_to, tz,
  //                 critical_bypass, devices:[{token_id,name,state,queued}] }
  //   PUT prefs (partial), GET inbox?limit&before → { items, unread },
  //   POST read { ids } | { all:true }, POST test { token_id? }.
  // Live: the bell polls the inbox every POLL_MS while the page is visible
  // (and once when it becomes visible again) — no stream from the portal.
  var NOTIFY_API = '/api/v1/portal/me/notify';
  var POLL_MS = 60000;
  var PAGE = 30;
  var RECENT = 5;
  var nf = { prefs: null, prefsReq: null, items: [], recent: [], unread: 0, more: false, loaded: false, failed: false, lastPoll: 0, timer: null };
  var TOPIC_ICON = {
    security: 'M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z',
    devices: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
    services: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    system: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
    admin_notice: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    plugin: 'M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z',
  };
  function plural(base, n) { return T(base + (n === 1 ? '_one' : '_other'), { count: n }); }
  function browserTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } }
  function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
  function panelOpen(id) { var p = $('panel-' + id); return !!(p && !p.hidden); }
  function topicLabel(id) {
    var list = nf.prefs && Array.isArray(nf.prefs.topics) ? nf.prefs.topics : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return String(list[i].label || '');
    return '';
  }

  // ── Bell ──
  function setUnread(n) {
    nf.unread = Math.max(0, Number(n) || 0);
    var bell = $('pt-bell');
    if (bell) {
      var label = nf.unread ? T('portal.notify.unread_label', { count: nf.unread }) : T('portal.notify.inbox');
      bell.setAttribute('aria-label', label);
      bell.setAttribute('title', label);
      bell.classList.toggle('has-unread', nf.unread > 0);
    }
    var c = $('pt-bell-count');
    if (c) { c.textContent = nf.unread > 99 ? '99+' : String(nf.unread); c.hidden = !nf.unread; }
    var all = $('pt-inbox-readall');
    if (all) all.disabled = !nf.unread;
    show($('pt-np-readall'), nf.unread > 0);
  }

  // ── Inbox items ──
  function factsList(it) {
    var facts = isObj(it.data) && Array.isArray(it.data.facts) ? it.data.facts.filter(function (f) { return isObj(f) && f.label != null && f.value != null; }) : [];
    if (!facts.length) return null;
    var dl = el('dl', { class: 'pt-facts' });
    facts.slice(0, 6).forEach(function (f) { dl.appendChild(el('dt', null, String(f.label))); dl.appendChild(el('dd', null, String(f.value))); });
    return dl;
  }
  function inboxItem(it, mini) {
    var unread = it.state !== 'read';
    var label = topicLabel(it.topic);
    var prio = it.priority === 'critical' || it.priority === 'high'
      ? el('span', { class: 'pt-prio', 'data-tone': it.priority === 'critical' ? 'crit' : 'warn' }, T('portal.notify.prio.' + it.priority)) : null;
    var meta = el('div', { class: 'pt-small pt-muted pt-inbox-meta' }, [
      label ? label + ' · ' : null,
      el('time', { datetime: String(it.created_at || '') }, rel(it.created_at)),
      it.silent ? ' · ' + T('portal.notify.silent') : null,
    ]);
    var readBtn = unread && !mini ? el('button', { type: 'button', class: 'pt-btn pt-btn-sm', 'data-act': 'read',
      'aria-label': T('portal.notify.mark_read_label', { title: it.title }), on: { click: function () { markRead([it.id]); } } }, T('portal.notify.mark_read')) : null;
    return el('li', { class: 'pt-inbox-item' + (unread ? ' is-unread' : ''), 'data-id': String(it.id), 'data-state': unread ? 'unread' : 'read' }, [
      el('span', { class: 'pt-unread-dot', 'aria-hidden': 'true' }),
      el('div', { class: 'pt-grow' }, [
        el('div', { class: 'pt-inbox-title' }, [unread ? el('span', { class: 'pt-sr' }, T('portal.notify.unread') + ': ') : null, el('b', null, String(it.title || '')), prio]),
        !mini && it.body ? el('p', { class: 'pt-inbox-body' }, String(it.body)) : null,
        !mini ? factsList(it) : null,
        meta,
      ]),
      readBtn,
    ]);
  }
  function renderInbox() {
    var list = $('pt-inbox');
    if (list) {
      clear(list);
      if (nf.failed && !nf.items.length) {
        list.appendChild(el('li', { class: 'pt-empty' }, [T('portal.notify.load_failed') + ' ',
          el('button', { type: 'button', class: 'pt-linkbtn', on: { click: function () { loadInbox(false); } } }, T('portal.notify.retry'))]));
      } else if (!nf.items.length) {
        list.appendChild(el('li', { class: 'pt-empty pt-inbox-empty' }, T('portal.notify.empty')));
      }
      nf.items.forEach(function (it) { list.appendChild(inboxItem(it, false)); });
    }
    show($('pt-inbox-more-wrap'), nf.more);
  }
  function renderRecent() {
    var list = $('pt-np-recent');
    if (!list) return;
    clear(list);
    if (!nf.recent.length) list.appendChild(el('li', { class: 'pt-empty' }, nf.failed ? T('portal.notify.load_failed') : T('portal.notify.empty')));
    nf.recent.forEach(function (it) { list.appendChild(inboxItem(it, true)); });
  }
  function validItems(body) { return body && Array.isArray(body.items) ? body.items.filter(function (it) { return isObj(it) && it.id != null; }) : []; }

  /** Full page for #mitteilungen (more = the next older page). */
  function loadInbox(more) {
    var last = nf.items.length ? nf.items[nf.items.length - 1].id : null;
    var url = NOTIFY_API + '/inbox?limit=' + PAGE + (more && last != null ? '&before=' + encodeURIComponent(String(last)) : '');
    var btn = $('pt-inbox-more');
    if (btn) btn.disabled = true;
    return getJson(url).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status !== 200 || !res.body || !res.body.ok) { nf.failed = true; renderInbox(); return; }
      var items = validItems(res.body);
      nf.failed = false;
      nf.loaded = true;
      nf.items = more ? nf.items.concat(items) : items;
      nf.more = items.length >= PAGE;
      if (!more) nf.recent = items.slice(0, RECENT);
      setUnread(res.body.unread);
      renderInbox();
      renderRecent();
    }).catch(function () { if (btn) btn.disabled = false; nf.failed = true; renderInbox(); });
  }
  /** Bell count + "Zuletzt" (small); the full page refreshes itself while open (first page only). */
  function poll() {
    nf.lastPoll = Date.now();
    if (panelOpen('mitteilungen') && nf.items.length <= PAGE) return loadInbox(false);
    return getJson(NOTIFY_API + '/inbox?limit=' + RECENT).then(function (res) {
      if (res.status !== 200 || !res.body || !res.body.ok) {
        if (res.status === 401 || res.status === 403) stopPolling(); // signed out meanwhile
        nf.failed = !nf.recent.length;
        renderRecent();
        return;
      }
      nf.failed = false;
      nf.recent = validItems(res.body).slice(0, RECENT);
      setUnread(res.body.unread);
      renderRecent();
      if (panelOpen('benachrichtigungen')) refreshDevices();
    }).catch(function () { /* next round */ });
  }
  function stopPolling() { if (nf.timer) { clearInterval(nf.timer); nf.timer = null; } }
  function startPolling() {
    stopPolling();
    nf.timer = setInterval(function () { if (!doc.hidden) poll(); }, POLL_MS);
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden && nf.timer && Date.now() - nf.lastPoll > POLL_MS) poll();
    });
  }
  function markRead(ids) {
    var body = ids ? { ids: ids } : { all: true };
    return send('POST', NOTIFY_API + '/read', body).then(function (res) {
      if (!res.body || !res.body.ok) { toast(T('portal.notify.save_failed'), 'error'); return; }
      var hit = function (it) { return !ids || ids.indexOf(it.id) >= 0; };
      nf.items.forEach(function (it) { if (hit(it)) it.state = 'read'; });
      nf.recent.forEach(function (it) { if (hit(it)) it.state = 'read'; });
      setUnread(ids ? nf.unread - (Number(res.body.updated) || 0) : 0);
      renderInbox();
      renderRecent();
      if (!ids) toast(T('portal.notify.marked_all'));
      poll(); // exact count from the server
    }).catch(function () { toast(T('portal.notify.save_failed'), 'error'); });
  }

  // ── Meine Benachrichtigungen ──
  function loadPrefs(force) {
    if (nf.prefsReq && !force) return nf.prefsReq;
    nf.prefsReq = getJson(NOTIFY_API + '/prefs').then(function (res) {
      if (res.status !== 200 || !res.body || !res.body.ok) {
        nf.prefsReq = null;
        prefsFailed();
        return null;
      }
      nf.prefs = res.body;
      message('pt-np-msg', '');
      show($('pt-np-grid'), true);
      renderPrefs();
      return nf.prefs;
    }).catch(function () { nf.prefsReq = null; prefsFailed(); return null; });
    return nf.prefsReq;
  }
  function prefsFailed() {
    var box = $('pt-np-msg');
    if (!box) return;
    clear(box);
    box.appendChild(doc.createTextNode(T('portal.notify.prefs_failed') + ' '));
    box.appendChild(el('button', { type: 'button', class: 'pt-linkbtn', on: { click: function () { loadPrefs(true); } } }, T('portal.notify.retry')));
    box.hidden = false;
    show($('pt-np-grid'), !!nf.prefs);
  }
  function savePrefs(patch) {
    return send('PUT', NOTIFY_API + '/prefs', patch).then(function (res) {
      if (res.status === 200 && res.body && res.body.ok) { nf.prefs = res.body; toast(T('portal.notify.saved')); return true; }
      toast(T('portal.notify.save_failed'), 'error');
      return false;
    }).catch(function () { toast(T('portal.notify.save_failed'), 'error'); return false; });
  }
  function topicRow(t, i) {
    var id = 'pt-np-topic-' + i;
    var plugin = /^plugin:/.test(String(t.id));
    var desc = plugin ? T('portal.notify.topic_desc.plugin') : T('portal.notify.topic_desc.' + t.id);
    if (t.locked) desc += ' · ' + T('portal.notify.locked');
    var input = el('input', { type: 'checkbox', class: 'pt-switch', role: 'switch', id: id, checked: !!t.enabled, disabled: !!t.locked, 'aria-describedby': id + '-d' });
    input.addEventListener('change', function () {
      var want = input.checked;
      input.disabled = true;
      savePrefs({ topics: [{ id: t.id, enabled: want }] }).then(function (ok) {
        input.disabled = false;
        if (!ok) input.checked = !want;
      });
    });
    return el('li', { class: 'pt-topic' + (t.locked ? ' is-locked' : ''), 'data-topic': String(t.id) }, [
      el('span', { class: 'pt-topic-ic', 'aria-hidden': 'true' }, icon(TOPIC_ICON[plugin ? 'plugin' : t.id] || TOPIC_ICON.plugin, 18)),
      el('label', { class: 'pt-grow pt-topic-text', for: id }, [el('b', null, String(t.label || t.id)), el('span', { class: 'pt-small pt-muted pt-block', id: id + '-d' }, desc)]),
      input,
    ]);
  }
  function renderTopics() {
    var list = $('pt-np-topics');
    if (!list) return;
    clear(list);
    (nf.prefs.topics || []).filter(isObj).forEach(function (t, i) { list.appendChild(topicRow(t, i)); });
  }
  var DEVICE_STATES = ['connected', 'restricted', 'offline', 'unsupported'];
  function testDevice(d, btn) {
    btn.disabled = true;
    send('POST', NOTIFY_API + '/test', { token_id: Number(d.token_id) }).then(function (res) {
      btn.disabled = false;
      if (res.status === 200 && res.body && res.body.ok) {
        toast(T(d.state === 'connected' || d.state === 'restricted' ? 'portal.notify.test_sent' : 'portal.notify.test_later', { name: d.name }));
        setTimeout(function () { refreshDevices(); poll(); }, 1500);
        return;
      }
      toast(res.status === 429 ? T('portal.notify.rate_limited') : T('portal.notify.test_failed'), 'error');
    }).catch(function () { btn.disabled = false; toast(T('portal.notify.test_failed'), 'error'); });
  }
  function deviceRow(d) {
    var state = DEVICE_STATES.indexOf(d.state) >= 0 ? d.state : 'offline';
    var parts = [T('portal.notify.state.' + state)];
    var queued = Number(d.queued) || 0;
    if (queued > 0) parts.push(plural('portal.notify.queued', queued));
    var tone = state === 'connected' ? 'good' : (state === 'restricted' ? 'warn' : 'muted');
    var btn = null;
    if (state !== 'unsupported') {
      btn = el('button', { type: 'button', class: 'pt-btn pt-btn-sm', 'data-act': 'test', 'aria-label': T('portal.notify.test_label', { name: d.name }) }, T('portal.notify.test'));
      btn.addEventListener('click', function () { testDevice(d, btn); });
    }
    return el('li', { class: 'pt-recv-item', 'data-id': String(d.token_id), 'data-state': state }, [
      el('span', { class: 'pt-dot' + (state === 'connected' ? '' : (state === 'restricted' ? ' is-warn' : ' is-off')), 'aria-hidden': 'true' }),
      el('div', { class: 'pt-grow' }, [el('b', { class: 'pt-recv-name' }, String(d.name || '')), el('div', { class: 'pt-small', 'data-tone': tone }, parts.join(' · '))]),
      btn,
    ]);
  }
  function renderNpDevices() {
    var list = $('pt-np-devices');
    if (!list || !nf.prefs) return;
    clear(list);
    var devs = (nf.prefs.devices || []).filter(isObj);
    if (!devs.some(function (d) { return d.state !== 'unsupported'; })) list.appendChild(el('li', { class: 'pt-empty' }, T('portal.notify.no_devices')));
    devs.forEach(function (d) { list.appendChild(deviceRow(d)); });
  }
  function refreshDevices() {
    getJson(NOTIFY_API + '/prefs').then(function (res) {
      if (res.status !== 200 || !res.body || !res.body.ok || !nf.prefs) return;
      nf.prefs.devices = res.body.devices;
      renderNpDevices();
    }).catch(function () { /* next round */ });
  }
  function quietOn() { return !!(nf.prefs && nf.prefs.quiet_from && nf.prefs.quiet_to); }
  function renderQuiet() {
    var on = quietOn();
    var sw = $('pt-np-quiet-on');
    var from = $('pt-np-from');
    var to = $('pt-np-to');
    if (sw) sw.checked = on;
    if (from) { from.disabled = !on; if (on) from.value = nf.prefs.quiet_from; }
    if (to) { to.disabled = !on; if (to && on) to.value = nf.prefs.quiet_to; }
    show($('pt-np-quiet-fields'), on);
    var crit = $('pt-np-critical');
    if (crit) crit.checked = nf.prefs.critical_bypass !== false;
    var tz = clear($('pt-np-tz'));
    if (!tz) return;
    var mine = browserTz();
    if (!on) { tz.appendChild(doc.createTextNode(T('portal.notify.quiet_off'))); return; }
    if (!mine || !nf.prefs.tz || nf.prefs.tz === mine) { tz.appendChild(doc.createTextNode(T('portal.notify.tz', { tz: nf.prefs.tz || mine }))); return; }
    tz.appendChild(doc.createTextNode(T('portal.notify.tz_other', { tz: nf.prefs.tz, browser: mine }) + ' '));
    tz.appendChild(el('button', { type: 'button', class: 'pt-linkbtn', id: 'pt-np-tz-use', on: { click: function () {
      savePrefs({ tz: mine }).then(renderQuiet);
    } } }, T('portal.notify.tz_use', { tz: mine })));
  }
  var HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
  function saveQuietTimes() {
    var from = ($('pt-np-from') || {}).value || '';
    var to = ($('pt-np-to') || {}).value || '';
    if (!HHMM.test(from) || !HHMM.test(to) || from === to) { toast(T('portal.notify.quiet_invalid'), 'error'); return; }
    var patch = { quiet_from: from, quiet_to: to };
    var tz = browserTz();
    if (tz && !(nf.prefs && nf.prefs.tz && quietOn())) patch.tz = tz; // first time: this browser's zone
    savePrefs(patch).then(renderQuiet);
  }
  (function wireQuiet() {
    var sw = $('pt-np-quiet-on');
    if (!sw) return;
    sw.addEventListener('change', function () {
      if (sw.checked) {
        var from = $('pt-np-from');
        var to = $('pt-np-to');
        if (from && !HHMM.test(from.value)) from.value = '22:00';
        if (to && !HHMM.test(to.value)) to.value = '07:00';
        var patch = { quiet_from: from ? from.value : '22:00', quiet_to: to ? to.value : '07:00' };
        var tz = browserTz();
        if (tz) patch.tz = tz;
        savePrefs(patch).then(renderQuiet);
      } else {
        savePrefs({ quiet_from: null, quiet_to: null }).then(renderQuiet);
      }
    });
    ['pt-np-from', 'pt-np-to'].forEach(function (id) { var n = $(id); if (n) n.addEventListener('change', saveQuietTimes); });
    var crit = $('pt-np-critical');
    if (crit) crit.addEventListener('change', function () {
      var want = crit.checked;
      savePrefs({ critical_bypass: want }).then(function (ok) { if (!ok) crit.checked = !want; });
    });
  })();
  function renderPrefs() {
    if (!nf.prefs) return;
    renderTopics();
    renderNpDevices();
    renderQuiet();
    renderRecent();
    if (nf.items.length) renderInbox(); // topic labels for the full list
  }
  (function wireNotify() {
    if (!TABS.notify) return;
    var all = $('pt-inbox-readall');
    if (all) all.addEventListener('click', function () { markRead(null); });
    var all2 = $('pt-np-readall');
    if (all2) all2.addEventListener('click', function () { markRead(null); });
    var more = $('pt-inbox-more');
    if (more) more.addEventListener('click', function () { loadInbox(true); });
    onPanel(function (id) {
      if (id === 'mitteilungen') { loadPrefs(false); loadInbox(false); }
      if (id === 'benachrichtigungen') { loadPrefs(false); poll(); }
    });
  })();
  function bootNotify() {
    if (!TABS.notify) return;
    if (!panelOpen('mitteilungen') && !panelOpen('benachrichtigungen')) poll();
    startPolling();
  }

  // ─── Boot ───────────────────────────────────────────────────────────────
  activate(location.hash.slice(1) || 'start');
  loadDevice();
  loadTraffic();
  loadPihole('device', true);
  loadServices();
  loadDevices();
  loadPluginStart();
  bootNotify();
})();
