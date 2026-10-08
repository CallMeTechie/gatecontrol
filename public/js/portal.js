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
    'data-goto', 'data-section', 'data-tone', 'data-on', 'alt', 'loading', 'maxlength', 'for', 'datetime', 'width', 'height'];
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
  function validTab(id) { return tabs().some(function (t) { return t.getAttribute('data-tab') === id; }); }
  function activate(id, opts) {
    var o = opts || {};
    if (!validTab(id)) id = 'start';
    tabs().forEach(function (t) {
      var on = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
      if (on && t.scrollIntoView && tabList && tabList.scrollWidth > tabList.clientWidth) {
        try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) { /* old browsers */ }
      }
      if (on && o.focus) t.focus();
    });
    doc.querySelectorAll('.pt-panel').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== id; });
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

  // ─── Boot ───────────────────────────────────────────────────────────────
  activate(location.hash.slice(1) || 'start');
  loadDevice();
  loadTraffic();
  loadPihole('device', true);
  loadServices();
  loadDevices();
  loadPluginStart();
})();
