// public/js/portal.js — GateControl portal (redesign "variant A": tabs).
//
// Start · Dienste · Zuhause · Fahrzeug · Netzwerk · Meine Geräte. The tabs
// are URL-addressable (#start, #dienste, #zuhause, #fahrzeug, #netzwerk,
// #geraete) and a WAI-ARIA tablist (arrow keys, Home/End). Every area that
// is unlicensed or has no data is hidden (tab, panel and start card).
//
// Data: /api/v1/portal/* (device, traffic, services, pihole + owner/household,
// midea, smarthome, skoda + image/details/command, me/devices, me/enrollment).
// Controlling devices needs a portal or web session (ctx.loggedIn); the
// server checks again. Vehicle unlock and "Gerät sperren" ask first.
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
    'data-goto', 'data-tone', 'data-on', 'alt', 'loading', 'maxlength', 'for', 'datetime', 'width', 'height'];
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
  function temp(v, digits) { return fmtNum(v, digits == null ? 1 : digits) + ' °C'; }

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
  function loginHint() {
    return el('span', { class: 'pt-login-hint' }, [T('portal.control.login_hint'), ' ', el('a', { href: '/login?returnTo=/portal' }, T('portal.login'))]);
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

  // ═══ Zuhause: Klima (Midea) ═════════════════════════════════════════════
  var midea = [];
  var MIDEA_MODES = ['auto', 'cool', 'heat', 'dry', 'fan'];
  var FAN_STEPS = [1, 20, 40, 60, 80, 100]; // percent steps like the Midea app; Auto = 102
  var mideaTimers = {};
  var homeState = { midea: TABS.midea ? 'pending' : 'off', smarthome: TABS.smarthome ? 'pending' : 'off' };
  var shDevices = [];
  var shSensors = [];
  function homeSettled(part, ok) {
    homeState[part] = ok ? 'ok' : 'none';
    var keys = Object.keys(homeState);
    if (keys.some(function (k) { return homeState[k] === 'pending'; })) return;
    if (!keys.some(function (k) { return homeState[k] === 'ok'; })) { hideArea('home', 'zuhause'); return; }
    renderStartHome();
    if (!CTX.loggedIn) { var h = clear($('pt-home-hint')); if (h) { h.appendChild(loginHint()); h.hidden = false; } }
  }
  function fanIndex(v) { return FAN_STEPS.reduce(function (b, val, i, a) { return Math.abs(val - v) < Math.abs(a[b] - v) ? i : b; }, 0); }
  function mideaById(id) { for (var i = 0; i < midea.length; i++) if (midea[i].id === id) return midea[i]; return null; }
  function mideaInfo(d) {
    var st = d.state || {};
    var offline = !d.state || !!st.offline;
    return { st: st, offline: offline, powered: !offline && !!st.power, canControl: !!CTX.loggedIn && !offline };
  }
  function modeLabel(m) { return T('portal.midea.mode_' + m); }
  function switchBtn(on, label, disabled, onClick) {
    return el('button', { type: 'button', class: 'pt-switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: disabled,
      on: { click: onClick } }, el('span', { class: 'pt-knob', 'aria-hidden': 'true' }));
  }
  function mideaLine(d) {
    var i = mideaInfo(d);
    if (i.offline) return T('portal.midea.offline');
    var parts = [i.powered ? modeLabel(MIDEA_MODES.indexOf(i.st.mode) >= 0 ? i.st.mode : 'auto') : T('portal.midea.power_off')];
    if (i.st.indoorTemp != null && isFinite(Number(i.st.indoorTemp))) parts.push(T('portal.midea.now', { temp: temp(i.st.indoorTemp) }));
    return parts.join(' · ');
  }
  function stepper(d, big) {
    var i = mideaInfo(d);
    var tgt = Number(i.st.targetTemp);
    var has = !i.offline && i.st.targetTemp != null && isFinite(tgt);
    var val = el('span', { class: 'pt-target' + (big ? ' is-lg' : ''), 'aria-live': 'polite' }, has ? fmtNum(tgt, 1) + (big ? '°' : ' °C') : '–');
    var dis = !i.canControl || !has;
    return el('div', { class: 'pt-stepper' + (big ? ' is-lg' : '') }, [
      el('button', { type: 'button', class: 'pt-round' + (big ? ' is-lg' : ''), 'data-act': 'down', 'aria-label': T('portal.midea.cooler_name', { name: d.name }), disabled: dis,
        on: { click: function () { mideaStep(d.id, -1); } } }, '−'),
      val,
      el('button', { type: 'button', class: 'pt-round' + (big ? ' is-lg' : ''), 'data-act': 'up', 'aria-label': T('portal.midea.warmer_name', { name: d.name }), disabled: dis,
        on: { click: function () { mideaStep(d.id, 1); } } }, '+'),
    ]);
  }
  function renderMideaMini(d) {
    var i = mideaInfo(d);
    return el('div', { class: 'pt-ac-mini', 'data-id': String(d.id) }, [
      el('div', { class: 'pt-ac-mini-text' }, [el('b', null, d.name), el('div', { class: 'pt-small pt-muted' }, mideaLine(d))]),
      stepper(d, false),
      switchBtn(i.powered, T('portal.midea.power_name', { name: d.name }), !i.canControl, function () { mideaControl(d.id, { power: !i.powered }); }),
    ]);
  }
  function renderMideaCard(d) {
    var i = mideaInfo(d);
    var st = i.st;
    var dis = !i.canControl;
    var status = i.offline ? T('portal.midea.offline') : (i.powered ? T('portal.midea.power_on') : T('portal.midea.power_off'));
    var sub = [T('portal.midea.target')];
    if (!i.offline && st.indoorTemp != null && isFinite(Number(st.indoorTemp))) sub.push(T('portal.midea.now', { temp: fmtNum(st.indoorTemp, 1) + '°' }));
    if (!i.offline && st.outdoorTemp != null && isFinite(Number(st.outdoorTemp))) sub.push(T('portal.midea.outside', { temp: fmtNum(st.outdoorTemp, 0) + '°' }));
    var modes = el('div', { class: 'pt-seg pt-seg-wrap', role: 'group', 'aria-label': T('portal.midea.mode') }, MIDEA_MODES.map(function (m) {
      var on = !i.offline && st.mode === m;
      return el('button', { type: 'button', 'data-mode': m, 'aria-pressed': on ? 'true' : 'false', disabled: dis, class: on && m === 'heat' ? 'is-heat' : null,
        on: { click: function () { mideaControl(d.id, { mode: m }); } } }, modeLabel(m));
    }));
    var isAuto = !i.offline && st.fanSpeed === 102;
    var idx = (i.offline || st.fanSpeed == null || !isFinite(Number(st.fanSpeed))) ? 3 : fanIndex(Number(st.fanSpeed));
    var fanVal = el('span', { class: 'pt-fan-val' }, isAuto ? T('portal.midea.fan_auto') : FAN_STEPS[idx] + ' %');
    var slider = el('input', { type: 'range', min: '0', max: '5', step: '1', value: String(idx), 'data-act': 'fan', disabled: dis,
      'aria-label': T('portal.midea.fan'), 'aria-valuetext': isAuto ? T('portal.midea.fan_auto') : FAN_STEPS[idx] + ' %' });
    slider.addEventListener('input', function () { fanVal.textContent = FAN_STEPS[Number(slider.value)] + ' %'; });
    slider.addEventListener('change', function () { mideaControl(d.id, { fanSpeed: FAN_STEPS[Number(slider.value)] }); });
    var toggles = el('div', { class: 'pt-chip-row' }, [
      el('button', { type: 'button', class: 'pt-chip', 'data-act': 'fan-auto', 'aria-pressed': isAuto ? 'true' : 'false', disabled: dis,
        on: { click: function () { mideaControl(d.id, { fanSpeed: 102 }); } } }, T('portal.midea.fan_auto_btn')),
      el('button', { type: 'button', class: 'pt-chip', 'data-act': 'turbo', 'aria-pressed': (!i.offline && st.turbo) ? 'true' : 'false', disabled: dis,
        on: { click: function () { mideaControl(d.id, { turbo: !st.turbo }); } } }, T('portal.midea.turbo')),
      el('button', { type: 'button', class: 'pt-chip', 'data-act': 'eco', 'aria-pressed': (!i.offline && st.eco) ? 'true' : 'false', disabled: dis,
        on: { click: function () { mideaControl(d.id, { eco: !st.eco }); } } }, T('portal.midea.eco')),
    ]);
    return el('section', { class: 'pt-card pt-pad pt-ac' + (i.offline ? ' is-offline' : ''), 'data-id': String(d.id), 'aria-label': d.name }, [
      el('div', { class: 'pt-card-row' }, [
        el('span', { class: 'pt-ic' }, icon(ICON.ac, 18)),
        el('h2', { class: 'pt-h2' }, d.name),
        el('span', { class: 'pt-pill', 'data-tone': i.offline ? 'muted' : (i.powered ? 'good' : 'muted') }, status),
        switchBtn(i.powered, T('portal.midea.power_name', { name: d.name }), dis, function () { mideaControl(d.id, { power: !i.powered }); }),
      ]),
      el('div', { class: 'pt-ac-climate' }, [stepper(d, true), el('div', { class: 'pt-ac-sub pt-muted' }, sub.join(' · '))]),
      modes,
      el('div', { class: 'pt-fan' }, [
        el('div', { class: 'pt-fan-head' }, [el('span', { class: 'pt-overline' }, T('portal.midea.fan')), fanVal]),
        slider,
        el('div', { class: 'pt-fan-ticks', 'aria-hidden': 'true' }, FAN_STEPS.map(function (v) { return el('span', null, v + '%'); })),
      ]),
      toggles,
      d.transport ? el('div', { class: 'pt-foot' }, d.transport === 'cloud' ? T('portal.midea.cloud') : T('portal.midea.lan')) : null,
    ]);
  }
  // Re-render one device in both places, keeping keyboard focus on the same control.
  function focusKey(node) {
    if (!node || !node.getAttribute) return null;
    if (node.getAttribute('role') === 'switch') return '[role="switch"]';
    if (node.getAttribute('data-mode')) return '[data-mode="' + node.getAttribute('data-mode') + '"]';
    if (node.getAttribute('data-act')) return '[data-act="' + node.getAttribute('data-act') + '"]';
    return null;
  }
  function mideaRefresh(id, confirmed) {
    var d = mideaById(id);
    if (!d) return;
    var active = doc.activeElement;
    var holder = active && active.closest ? active.closest('[data-id="' + id + '"]') : null;
    var key = holder ? focusKey(active) : null;
    var inMini = !!(holder && holder.classList.contains('pt-ac-mini'));
    var card = doc.querySelector('.pt-ac[data-id="' + id + '"]');
    var fresh = renderMideaCard(d);
    if (card) card.replaceWith(fresh);
    var mini = doc.querySelector('.pt-ac-mini[data-id="' + id + '"]');
    var freshMini = mini ? renderMideaMini(d) : null;
    if (mini) mini.replaceWith(freshMini);
    if (confirmed) [fresh, freshMini].forEach(function (n) { var s = n && n.querySelector('.pt-stepper'); if (s) s.classList.add('is-confirmed'); });
    if (key) {
      var root = inMini ? freshMini : fresh;
      var target = root && root.querySelector(key);
      if (target && !target.disabled) target.focus();
    }
  }
  function mideaError() { message('pt-home-msg', T('portal.midea.error')); toast(T('portal.midea.error'), 'error'); }
  function mideaControl(id, patch) {
    if (!CTX.loggedIn) return;
    send('POST', '/api/v1/portal/midea/' + Number(id) + '/state', { patch: patch }).then(function (res) {
      var b = res.body;
      if (b && b.ok && b.data && b.data.state) { var d = mideaById(id); if (d) d.state = b.data.state; mideaRefresh(id, false); message('pt-home-msg', ''); }
      else mideaError();
    }).catch(mideaError);
  }
  // Target temperature: whole degrees, optimistic, debounced (rapid +/- clicks
  // coalesce into one command); the device's confirmed value turns it green.
  function mideaStep(id, delta) {
    var d = mideaById(id);
    if (!d || !d.state) return;
    var cur = Number(d.state.targetTemp);
    if (!isFinite(cur)) return;
    var next = Math.min(30, Math.max(16, Math.round(cur) + delta));
    d.state = Object.assign({}, d.state, { targetTemp: next });
    doc.querySelectorAll('[data-id="' + id + '"] .pt-target').forEach(function (n) { n.textContent = fmtNum(next, 1) + (n.classList.contains('is-lg') ? '°' : ' °C'); });
    doc.querySelectorAll('[data-id="' + id + '"] .pt-stepper').forEach(function (s) { s.classList.add('is-pending'); s.classList.remove('is-confirmed'); });
    clearTimeout(mideaTimers[id]);
    mideaTimers[id] = setTimeout(function () {
      delete mideaTimers[id];
      send('POST', '/api/v1/portal/midea/' + Number(id) + '/state', { patch: { targetTemp: next } }).then(function (res) {
        var b = res.body;
        if (b && b.ok && b.data && b.data.state) { d.state = b.data.state; mideaRefresh(id, true); return; }
        doc.querySelectorAll('[data-id="' + id + '"] .pt-stepper').forEach(function (s) { s.classList.remove('is-pending'); });
        mideaError();
      }).catch(mideaError);
    }, 500);
  }
  function loadMidea() {
    if (!TABS.midea) return;
    getJson('/api/v1/portal/midea').then(function (res) {
      if (!okData(res) || !(res.body.data.devices || []).length) { hideArea('midea'); homeSettled('midea', false); return; }
      midea = res.body.data.devices;
      var list = clear($('pt-midea'));
      if (list) midea.forEach(function (d) { list.appendChild(renderMideaCard(d)); });
      homeSettled('midea', true);
      startMideaPoll();
    }).catch(function () { homeSettled('midea', false); });
  }
  var mideaPoll = null;
  function startMideaPoll() {
    if (mideaPoll || !midea.length) return;
    mideaPoll = setInterval(function () {
      if (doc.hidden || navigator.onLine === false) return;
      midea.forEach(function (d) {
        // Never re-render while the fan slider of this device is in use or a
        // target change is still on its way.
        var a = doc.activeElement;
        if (a && a.getAttribute && a.getAttribute('data-act') === 'fan' && a.closest('[data-id="' + d.id + '"]')) return;
        if (mideaTimers[d.id]) return;
        getJson('/api/v1/portal/midea/' + Number(d.id) + '/state').then(function (res) {
          if (res.status === 429) { clearInterval(mideaPoll); mideaPoll = null; return; }
          var b = res.body;
          if (b && b.ok && b.data && b.data.state) { d.state = b.data.state; mideaRefresh(d.id, false); }
        }).catch(function () { /* a failed tick is retried on the next one */ });
      });
    }, 120000);
  }

  // ═══ Zuhause: Smart Home ════════════════════════════════════════════════
  function shStatus(d) {
    if (d.kind === 'scene') return T('portal.smarthome.activate');
    var st = d.state || {};
    var on = st.on ? T('portal.smarthome.on') : T('portal.smarthome.off');
    if (st.on && d.capabilities && d.capabilities.bri && st.bri != null) return on + ' · ' + fmtNum(st.bri) + ' %';
    return on;
  }
  function shControl(id, patch) {
    if (!CTX.loggedIn) return Promise.resolve(false);
    return send('POST', '/api/v1/portal/smarthome/' + Number(id) + '/state', { patch: patch }).then(function (res) {
      var b = res.body;
      if (!b || !b.ok || b.reason) { toast(T('portal.smarthome.error'), 'error'); return false; }
      return true;
    }).catch(function () { toast(T('portal.smarthome.error'), 'error'); return false; });
  }
  function syncShTiles(d) {
    doc.querySelectorAll('.pt-shtile[data-id="' + d.id + '"]').forEach(function (t) {
      var on = !!(d.state && d.state.on);
      t.classList.toggle('is-on', on);
      var b = t.querySelector('.pt-shtile-main');
      if (b && d.kind !== 'scene') b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var s = t.querySelector('.pt-small');
      if (s) s.textContent = shStatus(d);
    });
  }
  function shTile(d, compact) {
    var st = d.state || {};
    var scene = d.kind === 'scene';
    var main = el('button', { type: 'button', class: 'pt-shtile-main', 'aria-pressed': scene ? null : (st.on ? 'true' : 'false'), disabled: !CTX.loggedIn },
      [el('b', null, scene ? T('portal.smarthome.scene', { name: d.name }) : d.name), el('span', { class: 'pt-small' }, shStatus(d))]);
    var tile = el('div', { class: 'pt-shtile' + (st.on && !scene ? ' is-on' : ''), 'data-id': String(d.id) }, main);
    main.addEventListener('click', function () {
      if (scene) { shControl(d.id, {}).then(function (ok) { if (ok) toast(T('portal.smarthome.scene_done', { name: d.name })); }); return; }
      var next = !(d.state && d.state.on);
      d.state = Object.assign({}, d.state || {}, { on: next });
      syncShTiles(d);
      shControl(d.id, { on: next }).then(function (ok) { if (!ok) { d.state.on = !next; syncShTiles(d); } });
    });
    if (!compact && !scene && d.capabilities && d.capabilities.bri) {
      var range = el('input', { type: 'range', min: '0', max: '100', value: String(st.bri != null ? st.bri : 0), disabled: !CTX.loggedIn,
        'aria-label': T('portal.smarthome.brightness_of', { name: d.name }) });
      range.addEventListener('change', function () {
        d.state = Object.assign({}, d.state || {}, { bri: Number(range.value) });
        syncShTiles(d);
        shControl(d.id, { bri: Number(range.value) });
      });
      tile.appendChild(range);
    }
    return tile;
  }
  // Sensor types exactly as sensorReading() in src/services/smarthome emits them.
  function sensorValue(s) {
    var st = s.state || {};
    var v = st.value;
    if (v === null || v === undefined || v === '') return { text: '–', tone: null };
    switch (st.type) {
      case 'temperature': return { text: temp(v), tone: null };
      case 'humidity': return { text: fmtNum(v) + ' %', tone: null };
      case 'lightlevel': return { text: fmtNum(v) + ' lx', tone: null };
      case 'open': return { text: v ? T('portal.smarthome.open') : T('portal.smarthome.closed'), tone: v ? 'warn' : 'good' };
      case 'presence': return { text: v ? T('portal.smarthome.motion') : T('portal.smarthome.no_motion'), tone: null };
      case 'water': return { text: v ? T('portal.smarthome.wet') : T('portal.smarthome.dry'), tone: v ? 'warn' : 'good' };
      default: return { text: '–', tone: null };
    }
  }
  function loadSmarthome() {
    if (!TABS.smarthome) return;
    getJson('/api/v1/portal/smarthome').then(function (res) {
      if (!okData(res)) { hideArea('smarthome'); homeSettled('smarthome', false); return; }
      shDevices = res.body.data.devices || [];
      shSensors = res.body.data.sensors || [];
      var tiles = clear($('pt-sh-tiles'));
      if (tiles) {
        shDevices.forEach(function (d) { tiles.appendChild(shTile(d, false)); });
        tiles.hidden = !shDevices.length;
      }
      var list = clear($('pt-sh-sensor-list'));
      if (list) {
        shSensors.forEach(function (s) {
          var v = sensorValue(s);
          list.appendChild(el('li', null, [el('span', null, s.name), el('b', { 'data-tone': v.tone }, v.text)]));
        });
      }
      show($('pt-sh-sensors'), shSensors.length > 0);
      homeSettled('smarthome', true);
    }).catch(function () { homeSettled('smarthome', false); });
  }
  function renderStartHome() {
    var host = clear($('pt-start-home'));
    if (!host) return;
    if (midea.length) host.appendChild(renderMideaMini(midea[0]));
    var tiles = shDevices.filter(function (d) { return d.kind !== 'scene'; }).slice(0, 4);
    if (tiles.length) host.appendChild(el('div', { class: 'pt-sh-tiles pt-sh-mini' }, tiles.map(function (d) { return shTile(d, true); })));
    if (shSensors.length) {
      host.appendChild(el('div', { class: 'pt-small pt-muted' }, shSensors.slice(0, 3).map(function (s) { return s.name + ' ' + sensorValue(s).text; }).join(' · ')));
    }
    if (!CTX.loggedIn) host.appendChild(el('div', { class: 'pt-small' }, loginHint()));
  }

  // ═══ Fahrzeug (Skoda) ═══════════════════════════════════════════════════
  var vehicles = [];
  var carLoggedIn = false;
  var skodaDetails = {};
  var dirtyTimers = false;
  function up(x) { return String(x || '').toUpperCase(); }
  function carState(v) {
    var s = v.state || {};
    var ch = s.charging || {};
    var cl = s.climate || {};
    return { s: s, ch: ch, cl: cl, hl: s.health || {}, mt: s.maintenance || {}, dt: s.detail || {},
      charging: up(ch.state) === 'CHARGING', climateOn: cl.state != null && up(cl.state) !== 'OFF' };
  }
  function carLine(v) {
    var c = carState(v);
    var parts = [];
    if (c.s.locked === true) parts.push(T('portal.car.locked'));
    else if (c.s.locked === false) parts.push(T('portal.car.unlocked'));
    if (c.s.doorsOpen === false && c.s.windowsOpen === false) parts.push(T('portal.car.all_closed'));
    else if (c.s.doorsOpen || c.s.windowsOpen) parts.push(T('portal.car.something_open'));
    if (c.charging) parts.push(T('portal.car.charging'));
    if (v.fetched_at) parts.push(T('portal.car.as_of', { when: rel(v.fetched_at) }));
    return parts.join(' · ');
  }
  function carCommand(v, action, args, btn) {
    if (!carLoggedIn) return Promise.resolve();
    // Sensitive: unlocking asks first (the server checks login + owner again).
    var go = action === 'unlock'
      ? portalConfirm({ title: T('portal.car.confirm_unlock_title', { name: v.name || v.model || '' }), message: T('portal.car.confirm_unlock'), okLabel: T('portal.car.unlock_ok'), danger: true })
      : Promise.resolve(true);
    return go.then(function (ok) {
      if (!ok || (btn && btn.disabled)) return null;
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
      return send('POST', '/api/v1/portal/skoda/vehicles/' + Number(v.id) + '/command', { action: action, args: args || {} }).then(function (res) {
        var b = res.body;
        if (!b || !b.ok || b.reason) { message('pt-car-msg', T('portal.car.cmd_failed')); toast(T('portal.car.cmd_failed'), 'error'); return; }
        message('pt-car-msg', '');
        toast(T('portal.car.cmd_sent'));
        setTimeout(function () { loadSkoda(true); }, 3000);
      }).catch(function () { toast(T('portal.car.cmd_failed'), 'error'); }).then(function () {
        if (btn) setTimeout(function () { btn.disabled = false; btn.removeAttribute('aria-busy'); }, 3000);
      });
    });
  }
  function actionBtn(v, title, sub, action, args, cls) {
    var b = el('button', { type: 'button', class: 'pt-action' + (cls ? ' ' + cls : ''), 'data-cmd': action }, [el('b', null, title), sub ? el('span', { class: 'pt-small pt-muted' }, sub) : null]);
    b.addEventListener('click', function () { carCommand(v, action, typeof args === 'function' ? args() : args, b); });
    return b;
  }
  function battery(v, compact) {
    var c = carState(v);
    var soc = Number(c.s.soc);
    var has = c.s.soc != null && isFinite(soc);
    var fill = el('span');
    fill.style.setProperty('--w', (has ? Math.max(0, Math.min(100, soc)) : 0) + '%');
    var bar = el('div', { class: 'pt-progress' + (c.charging ? ' is-charging' : '') + (has && soc <= 15 ? ' is-low' : ''), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': has ? String(soc) : null, 'aria-label': T('portal.car.battery') }, fill);
    if (compact) return bar;
    return el('div', { class: 'pt-batt' }, [bar, c.charging ? el('div', { class: 'pt-small pt-muted' }, T('portal.car.charging_detail', {
      power: fmtNum(c.ch.powerKw, 1), minutes: fmtNum(c.ch.remainingMin), target: fmtNum(c.ch.targetPercent) })) : null]);
  }
  function carTags(v) {
    var c = carState(v);
    var list = [[T('portal.car.doors'), c.s.doorsOpen === true], [T('portal.car.windows'), c.s.windowsOpen === true],
      [T('portal.car.bonnet'), up(c.dt.bonnet) === 'OPEN'], [T('portal.car.trunk'), up(c.dt.trunk) === 'OPEN']];
    if (c.dt.sunroof != null && up(c.dt.sunroof) !== 'UNSUPPORTED') list.push([T('portal.car.sunroof'), up(c.dt.sunroof) === 'OPEN']);
    if (c.s.lightsOn === true) list.push([T('portal.car.lights_on'), true]);
    if (c.ch.cableConnected) list.push([T('portal.car.cable'), false]);
    return el('div', { class: 'pt-chip-row' }, list.map(function (x) {
      return el('span', { class: 'pt-tag' + (x[1] ? ' is-open' : '') }, x[1] ? T('portal.car.open_item', { item: x[0] }) : x[0]);
    }));
  }
  function renderCarMini(v) {
    var c = carState(v);
    var row = el('div', { class: 'pt-car-mini' }, [
      el('div', { class: 'pt-car-mini-head' }, [
        el('div', { class: 'pt-grow' }, [el('b', { class: 'pt-car-name' }, v.name || v.model || ''), el('div', { class: 'pt-small pt-muted' }, carLine(v))]),
        el('div', { class: 'pt-right' }, [el('div', { class: 'pt-big' }, c.s.soc != null ? fmtNum(c.s.soc) + ' %' : '–'),
          el('div', { class: 'pt-small pt-muted' }, c.s.rangeKm != null ? fmtNum(c.s.rangeKm) + ' km' : '')]),
      ]),
      battery(v, true),
    ]);
    if (carLoggedIn) {
      row.appendChild(el('div', { class: 'pt-btn-row' }, [
        c.climateOn ? actionBtn(v, T('portal.car.climate_off'), null, 'ac_stop', {}, 'is-sm') : actionBtn(v, T('portal.car.climate_on'), null, 'ac_start', { temp: 21 }, 'is-sm'),
        c.charging ? actionBtn(v, T('portal.car.charge_stop'), null, 'charge_stop', {}, 'is-sm') : actionBtn(v, T('portal.car.charge_start'), null, 'charge_start', {}, 'is-sm'),
        c.s.locked === false ? actionBtn(v, T('portal.car.lock'), null, 'lock', {}, 'is-sm') : actionBtn(v, T('portal.car.unlock'), null, 'unlock', {}, 'is-sm is-danger'),
      ]));
    } else {
      row.appendChild(el('div', { class: 'pt-small' }, loginHint()));
    }
    return row;
  }
  function detailsNode(d) {
    var meta = d.meta || {};
    var rows = [];
    function row(label, value) { if (value != null && value !== '') rows.push(el('div', null, [el('dt', null, label), el('dd', null, String(value))])); }
    row(T('portal.car.d_model'), meta.title || meta.model);
    row(T('portal.car.d_year'), meta.modelYear);
    row(T('portal.car.d_made'), meta.manufacturingDate);
    row(T('portal.car.d_body'), meta.body);
    row(T('portal.car.d_trim'), meta.trimLevel);
    row(T('portal.car.d_power'), meta.powerKw != null ? fmtNum(meta.powerKw) + ' kW' : null);
    row(T('portal.car.d_battery'), meta.batteryKwh != null ? fmtNum(meta.batteryKwh, 1) + ' kWh' : null);
    row(T('portal.car.d_max_charging'), meta.maxChargingKw != null ? fmtNum(meta.maxChargingKw) + ' kW' : null);
    row(T('portal.car.d_vin'), meta.vin);
    var conn = d.connection;
    if (conn) {
      var parts = [];
      if (conn.online != null) parts.push(conn.online ? T('portal.car.d_online') : T('portal.car.d_offline'));
      if (conn.ignitionOn != null) parts.push(conn.ignitionOn ? T('portal.car.d_ignition_on') : T('portal.car.d_ignition_off'));
      if (conn.inMotion) parts.push(T('portal.car.d_in_motion'));
      row(T('portal.car.d_connection'), parts.join(', '));
    }
    var score = d.drivingScore;
    if (score) {
      var sp = [];
      if (score.weekly != null) sp.push(T('portal.car.d_score_week', { value: fmtNum(score.weekly) }));
      if (score.monthly != null) sp.push(T('portal.car.d_score_month', { value: fmtNum(score.monthly) }));
      if (score.lastCalculationDate != null) sp.push(T('portal.car.d_score_as_of', { date: String(score.lastCalculationDate) }));
      row(T('portal.car.d_score'), sp.join(' · '));
    }
    var out = el('div', null, el('dl', { class: 'pt-facts' }, rows));
    var eq = Array.isArray(d.equipment) ? d.equipment : [];
    if (eq.length) out.appendChild(el('div', { class: 'pt-chip-row' }, eq.map(function (e) { return el('span', { class: 'pt-tag' }, String(e)); })));
    return out;
  }
  function detailsBlock(v) {
    var body = el('div', { class: 'pt-details-body' }, el('div', { class: 'pt-small pt-muted' }, T('portal.loading')));
    var det = el('details', { class: 'pt-details' }, [el('summary', null, T('portal.car.details')), body]);
    det.addEventListener('toggle', function () {
      if (!det.open) return;
      if (skodaDetails[v.id]) { clear(body).appendChild(skodaDetails[v.id].cloneNode(true)); return; }
      getJson('/api/v1/portal/skoda/vehicles/' + Number(v.id) + '/details').then(function (res) {
        var b = res.body;
        if (b && b.ok && b.data === null) { clear(body).appendChild(el('div', { class: 'pt-small pt-muted' }, T('portal.car.details_none'))); return; }
        if (!b || !b.ok || !b.data) { clear(body).appendChild(el('div', { class: 'pt-small', 'data-tone': 'warn' }, res.status === 429 ? T('portal.car.details_busy') : T('portal.car.details_error'))); return; }
        var node = detailsNode(b.data);
        skodaDetails[v.id] = node;
        clear(body).appendChild(node.cloneNode(true));
      }).catch(function () { clear(body).appendChild(el('div', { class: 'pt-small', 'data-tone': 'warn' }, T('portal.car.details_error'))); });
    });
    return det;
  }
  var DAYS = [['MONDAY', 'mon'], ['TUESDAY', 'tue'], ['WEDNESDAY', 'wed'], ['THURSDAY', 'thu'], ['FRIDAY', 'fri'], ['SATURDAY', 'sat'], ['SUNDAY', 'sun']];
  var TIMER_ERRORS = { SKODA_TIMER_NOT_FOUND: 'portal.car.timer_not_found', SKODA_TIMER_READONLY: 'portal.car.timer_readonly', SKODA_VALIDATION: 'portal.car.timer_invalid' };
  function timerRow(v, t) {
    var days = Array.isArray(t.days) ? t.days : [];
    var editable = t.type === 'RECURRING';
    var msg = el('span', { class: 'pt-small', 'aria-live': 'polite' }, t.type === 'ONE_OFF' ? T('portal.car.timer_readonly') : '');
    var enabled = el('input', { type: 'checkbox', checked: !!t.enabled, disabled: !editable });
    var time = el('input', { type: 'time', class: 'pt-input pt-input-sm', value: String(t.time || ''), disabled: !editable, 'aria-label': T('portal.car.timer_time') });
    var dayRow = el('div', { class: 'pt-chip-row', role: 'group', 'aria-label': T('portal.car.timer_days') }, DAYS.map(function (d) {
      var b = el('button', { type: 'button', class: 'pt-chip', 'data-day': d[0], 'aria-pressed': days.indexOf(d[0]) >= 0 ? 'true' : 'false', disabled: !editable }, T('portal.car.day_' + d[1]));
      b.addEventListener('click', function () { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); dirtyTimers = true; });
      return b;
    }));
    [enabled, time].forEach(function (n) { n.addEventListener('change', function () { dirtyTimers = true; }); });
    var save = editable ? el('button', { type: 'button', class: 'pt-btn pt-btn-sm' }, T('portal.car.timer_save')) : null;
    if (save) {
      save.addEventListener('click', function () {
        var picked = Array.prototype.slice.call(dayRow.querySelectorAll('[aria-pressed="true"]')).map(function (c) { return c.getAttribute('data-day'); });
        if (!time.value || !picked.length) { msg.textContent = T('portal.car.timer_invalid'); return; }
        save.disabled = true;
        msg.textContent = '';
        send('POST', '/api/v1/portal/skoda/vehicles/' + Number(v.id) + '/command', { action: 'timer_set', args: { id: Number(t.id), enabled: enabled.checked, time: time.value, days: picked } })
          .then(function (res) {
            var b = res.body || {};
            if (!b.ok || b.reason) {
              var key = Object.prototype.hasOwnProperty.call(TIMER_ERRORS, b.error) ? TIMER_ERRORS[b.error] : 'portal.car.timer_failed';
              msg.textContent = T(key);
              return;
            }
            dirtyTimers = false;
            msg.textContent = T('portal.car.timer_saved');
          }).catch(function () { msg.textContent = T('portal.car.timer_failed'); })
          .then(function () { save.disabled = false; });
      });
    }
    return el('div', { class: 'pt-timer' }, [
      el('div', { class: 'pt-timer-head' }, [el('b', null, T('portal.car.timer_n', { n: t.id })),
        el('label', { class: 'pt-check' }, [enabled, T('portal.car.timer_active')]), time]),
      dayRow,
      el('div', { class: 'pt-timer-foot' }, [save, msg]),
    ]);
  }
  function renderCarCard(v) {
    var c = carState(v);
    var name = v.name || v.model || '';
    var tempInput = el('input', { type: 'number', min: '15.5', max: '30', step: '0.5', value: c.cl.targetC != null ? String(c.cl.targetC) : '21',
      class: 'pt-input pt-input-sm', 'aria-label': T('portal.car.target_temp') });
    function wantTemp() { var n = Number(tempInput.value); return { temp: isFinite(n) && n ? n : 21 }; }
    var head = el('div', { class: 'pt-car-head' }, [
      v.has_image ? el('img', { class: 'pt-car-img', src: '/api/v1/portal/skoda/vehicles/' + encodeURIComponent(v.id) + '/image', alt: '', loading: 'lazy' })
        : el('span', { class: 'pt-car-ic' }, icon(ICON.car, 28)),
      el('div', { class: 'pt-grow' }, [el('h2', { class: 'pt-h2 pt-h2-lg' }, name), el('div', { class: 'pt-small pt-muted' }, carLine(v))]),
      el('div', { class: 'pt-car-stats' }, [
        el('div', null, [el('div', { class: 'pt-small pt-muted' }, T('portal.car.battery')), el('div', { class: 'pt-big' }, c.s.soc != null ? fmtNum(c.s.soc) + ' %' : '–')]),
        el('div', null, [el('div', { class: 'pt-small pt-muted' }, T('portal.car.range')), el('div', { class: 'pt-big' }, c.s.rangeKm != null ? fmtNum(c.s.rangeKm) + ' km' : '–')]),
      ]),
    ]);
    var card = el('section', { class: 'pt-card pt-pad pt-car', 'data-id': String(v.id), 'aria-label': name }, [head, battery(v, false), carTags(v)]);
    var limitText = c.ch.targetPercent != null ? T('portal.car.limit', { pct: fmtNum(c.ch.targetPercent) }) : null;
    if (carLoggedIn) {
      card.appendChild(el('div', { class: 'pt-actions' }, [
        c.climateOn ? actionBtn(v, T('portal.car.climate_off'), T('portal.car.climate_running'), 'ac_stop', {})
          : actionBtn(v, T('portal.car.climatize'), T('portal.car.to_temp', { temp: fmtNum(c.cl.targetC != null ? c.cl.targetC : 21, 1) }), 'ac_start', wantTemp),
        c.charging ? actionBtn(v, T('portal.car.charge_stop'), limitText, 'charge_stop', {}) : actionBtn(v, T('portal.car.charge_start'), limitText, 'charge_start', {}),
        c.cl.windowHeating === true ? actionBtn(v, T('portal.car.window_heat'), T('portal.car.on'), 'window_heat_stop', {})
          : actionBtn(v, T('portal.car.window_heat'), T('portal.car.off'), 'window_heat_start', {}),
        c.s.locked === false ? actionBtn(v, T('portal.car.lock'), T('portal.car.unlocked'), 'lock', {})
          : actionBtn(v, T('portal.car.unlock'), T('portal.car.with_confirm'), 'unlock', {}, 'is-danger'),
      ]));
      var limit = el('select', { class: 'pt-input pt-input-sm', 'aria-label': T('portal.car.charge_limit') }, [50, 60, 70, 80, 90, 100].map(function (p) {
        return el('option', { value: String(p), selected: Number(c.ch.targetPercent) === p }, p + ' %');
      }));
      limit.addEventListener('change', function () { carCommand(v, 'charge_limit', { limit: Number(limit.value) }, limit); });
      var setTemp = el('button', { type: 'button', class: 'pt-btn pt-btn-sm' }, T('portal.car.apply'));
      setTemp.addEventListener('click', function () { carCommand(v, 'ac_temp', wantTemp(), setTemp); });
      card.appendChild(el('div', { class: 'pt-car-settings' }, [
        el('div', { class: 'pt-inline-field' }, [el('span', { class: 'pt-small pt-muted' }, T('portal.car.target_temp')), tempInput, setTemp]),
        el('div', { class: 'pt-inline-field' }, [el('span', { class: 'pt-small pt-muted' }, T('portal.car.charge_limit')), limit]),
      ]));
    }
    var facts = [];
    function fact(label, value) { if (value != null && value !== '') facts.push(el('div', null, [el('dt', null, label), el('dd', null, value)])); }
    fact(T('portal.car.mileage'), c.hl.mileageKm != null ? fmtNum(c.hl.mileageKm) + ' km' : null);
    fact(T('portal.car.inspection'), c.mt.dueInDays != null ? T('portal.car.in_days', { days: fmtNum(c.mt.dueInDays) }) + (c.mt.dueInKm != null ? ' · ' + fmtNum(c.mt.dueInKm) + ' km' : '') : null);
    fact(T('portal.car.partner'), c.mt.partner || null);
    fact(T('portal.car.climate'), c.cl.state == null ? null : (c.climateOn ? T('portal.car.on') : T('portal.car.off'))
      + (c.cl.targetC != null ? ' · ' + temp(c.cl.targetC) : '') + (c.cl.remainingMin != null ? ' · ' + T('portal.car.minutes_left', { minutes: fmtNum(c.cl.remainingMin) }) : ''));
    var activeTimers = (c.cl.timers || []).filter(function (t) { return t.enabled && t.time; });
    if (activeTimers.length) fact(T('portal.car.timers'), activeTimers.map(function (t) { return t.time; }).join(', '));
    if (c.hl.warnings && c.hl.warnings.length) fact(T('portal.car.warnings'), c.hl.warnings.join(', '));
    var pos = c.s.position;
    if (pos) {
      var lat = Number(pos.lat);
      var lon = Number(pos.lon);
      var okPos = pos.lat != null && pos.lon != null && isFinite(lat) && isFinite(lon);
      var label = pos.address || (okPos ? lat.toFixed(4) + ', ' + lon.toFixed(4) : '');
      if (label) {
        facts.push(el('div', null, [el('dt', null, T('portal.car.position')), el('dd', null, okPos
          ? el('a', { href: 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon, target: '_blank', rel: 'noopener noreferrer' }, label)
          : label)]));
      }
    }
    if (facts.length) card.appendChild(el('dl', { class: 'pt-facts' }, facts));
    card.appendChild(detailsBlock(v));
    if (carLoggedIn) {
      var all = c.cl.timers || [];
      card.appendChild(el('details', { class: 'pt-details pt-timers' }, [el('summary', null, T('portal.car.timers_edit')),
        el('div', { class: 'pt-details-body' }, all.length ? all.map(function (t) { return timerRow(v, t); }) : el('div', { class: 'pt-small pt-muted' }, T('portal.car.timers_none')))]));
    }
    return card;
  }
  function renderSkoda() {
    // An unsaved timer edit wins over a refresh.
    if (dirtyTimers) return;
    var list = $('pt-skoda');
    if (list) {
      var open = {};
      list.querySelectorAll('.pt-car').forEach(function (c) {
        open[c.getAttribute('data-id')] = Array.prototype.map.call(c.querySelectorAll('details'), function (d) { return d.open; });
      });
      clear(list);
      vehicles.forEach(function (v) {
        var card = renderCarCard(v);
        var prev = open[String(v.id)];
        if (prev) card.querySelectorAll('details').forEach(function (d, i) { if (prev[i]) d.open = true; });
        list.appendChild(card);
      });
    }
    var start = clear($('pt-start-car'));
    if (start) vehicles.slice(0, 1).forEach(function (v) { start.appendChild(renderCarMini(v)); });
  }
  function loadSkoda(refresh) {
    if (!TABS.car) return;
    getJson('/api/v1/portal/skoda').then(function (res) {
      if (!okData(res) || !(res.body.data.vehicles || []).length) { if (!refresh) hideArea('car', 'fahrzeug'); return; }
      vehicles = res.body.data.vehicles;
      carLoggedIn = !!res.body.data.loggedIn && !!CTX.loggedIn;
      renderSkoda();
      if (!carLoggedIn) { var h = clear($('pt-car-hint')); if (h) { h.appendChild(loginHint()); h.hidden = false; } }
      if (!refresh) startSkodaPoll();
    }).catch(function () { if (!refresh) hideArea('car', 'fahrzeug'); });
  }
  var skodaPoll = null;
  function startSkodaPoll() {
    if (skodaPoll) return;
    skodaPoll = setInterval(function () { if (!doc.hidden) loadSkoda(true); }, 120000);
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

  // ═══ Search (start) ═════════════════════════════════════════════════════
  (function wireSearch() {
    var input = $('pt-search');
    var box = $('pt-results');
    if (!input || !box) return;
    function hit(label, sub, href, goto, extra) {
      return el('a', { class: 'pt-result', href: href, 'data-goto': goto || null, target: goto ? null : '_blank', rel: goto ? null : 'noopener noreferrer',
        on: extra ? { click: extra } : null }, [el('b', null, label), el('span', { class: 'pt-small pt-muted' }, sub)]);
    }
    function run() {
      var q = input.value.trim().toLowerCase();
      clear(box);
      if (!q) { box.hidden = true; return; }
      var hits = [];
      var match = function (s) { return String(s || '').toLowerCase().indexOf(q) >= 0; };
      services.forEach(function (s) {
        if (!match(s.name) && !match(s.domain) && !match(s.host)) return;
        if (s.kind === 'rdp') hits.push(hit(s.name, s.host, '#dienste', 'dienste'));
        else hits.push(hit(s.name, s.domain, validHost(s.domain) ? 'https://' + s.domain : '#', null, function () { remember('http:' + s.id); }));
      });
      devices.forEach(function (d) { if (match(d.name)) hits.push(hit(d.name, T('portal.tab.devices'), '#geraete', 'geraete')); });
      midea.concat(shDevices).forEach(function (d) { if (match(d.name)) hits.push(hit(d.name, T('portal.tab.home'), '#zuhause', 'zuhause')); });
      vehicles.forEach(function (v) { var n = v.name || v.model || ''; if (match(n)) hits.push(hit(n, T('portal.tab.car'), '#fahrzeug', 'fahrzeug')); });
      if (!hits.length) hits.push(empty(T('portal.search_none')));
      hits.slice(0, 12).forEach(function (h) { box.appendChild(h); });
      box.hidden = false;
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
  loadMidea();
  loadSmarthome();
  loadSkoda(false);
  loadDevices();
})();
