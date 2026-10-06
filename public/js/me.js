'use strict';

// "Mein Bereich" — the member self-service area (/me). Everything comes from
// /api/v1/me/*, which is scoped to the signed-in account on the server; this
// script never sends a user id. No innerHTML.
(function () {
  const doc = document;
  const D = window.GCDialog;
  const root = doc.getElementById('me-page');
  if (!root) return;
  // Dialog out of .app (own stacking context): above the mobile navigation.
  const dlg = doc.getElementById('me-dlg-enroll');
  if (dlg) doc.body.appendChild(dlg);
  let I18N = {};
  try { I18N = JSON.parse(doc.getElementById('me-i18n').textContent || '{}') || {}; } catch (_) { I18N = {}; }
  const LANG = doc.documentElement.lang || 'de';
  function T(key, params) {
    let s = I18N[key];
    if (s == null && window.GC && window.GC.t) s = window.GC.t[key];
    if (s == null) s = key;
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  // Attributes the DOM helper may set: a fixed list of literal names, so no
  // text (server or exception text) can ever become an event handler, a
  // script URL or markup. href only for same-origin paths or https URLs.
  function safeHref(v) {
    const s = String(v == null ? '' : v);
    if (/^\/(?![/\\])/.test(s) && s.indexOf('\\') < 0) return s;
    if (/^#[\w-]*$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.protocol === 'https:') return u.href;
    } catch (_) { /* not a URL */ }
    return '#';
  }
  function setAttr(n, k, v) {
    const s = v === true ? '' : String(v);
    switch (k) {
      case 'id': n.id = s; break;
      case 'title': n.title = s; break;
      case 'role': n.setAttribute('role', s); break;
      case 'for': n.htmlFor = s; break;
      case 'href': n.setAttribute('href', safeHref(v)); break;
      case 'target': if (s === '_blank') n.target = '_blank'; break;
      case 'rel': n.rel = s; break;
      case 'colspan': n.setAttribute('colspan', String(Number(v) || 1)); break;
      case 'rows': n.setAttribute('rows', String(Number(v) || 1)); break;
      case 'maxlength': n.setAttribute('maxlength', String(Number(v) || 0)); break;
      case 'placeholder': n.placeholder = s; break;
      case 'spellcheck': n.spellcheck = s !== 'false'; break;
      case 'novalidate': n.noValidate = true; break;
      case 'datetime': n.setAttribute('datetime', s); break;
      case 'aria-hidden': n.setAttribute('aria-hidden', s); break;
      case 'aria-label': n.setAttribute('aria-label', s); break;
      case 'aria-checked': n.setAttribute('aria-checked', s); break;
      case 'aria-pressed': n.setAttribute('aria-pressed', s); break;
      case 'aria-current': n.setAttribute('aria-current', s); break;
      case 'data-user-id': n.dataset.userId = s; break;
      case 'data-token-id': n.dataset.tokenId = s; break;
      case 'data-device-id': n.dataset.deviceId = s; break;
      case 'data-scope': n.dataset.scope = s; break;
      case 'data-mb-state': n.dataset.mbState = s; break;
      case 'data-mb-mode': n.dataset.mbMode = s; break;
      default: break; // anything else is dropped on purpose
    }
  }
  function el(tag, props, children) {
    const n = doc.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else setAttr(n, k, v);
    });
    // Children: DOM nodes as they are, everything else only ever as text.
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      // ParentNode.append() inserts a string as a Text node, never as markup.
      n.append(c instanceof window.Node ? c : String(c));
    });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function $(id) { return doc.getElementById(id); }
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  let rtf = null;
  try { rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' }); } catch (_) { rtf = null; }
  function fmtDate(v) { const d = toDate(v); if (!d) return ''; try { return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); } }
  function rel(v) {
    const d = toDate(v);
    if (!d) return '';
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(sec);
    if (abs < 45) return T('me.now');
    if (!rtf) return fmtDate(d);
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 45) return rtf.format(Math.round(sec / 86400), 'day');
    return rtf.format(Math.round(sec / (86400 * 30)), 'month');
  }
  async function call(method, url, body) {
    const fn = { GET: 'get', POST: 'post', DELETE: 'del' }[method];
    const res = method === 'POST' ? await window.api[fn](url, body || {}) : await window.api[fn](url);
    if (res && res.ok === false) throw new Error(res.error || T('common.error'));
    return res;
  }

  let admins = [];
  function adminNames() { return admins.length ? admins.join(', ') : T('me.admin_fallback'); }

  async function loadMe() {
    try {
      const res = await call('GET', '/api/v1/me');
      admins = res.admins || [];
      $('me-intro').textContent = T('me.intro', { admins: adminNames() });
      $('me-note').textContent = T('me.footer', { admins: adminNames() });
      $('me-enroll').hidden = !res.can_enroll;
      $('me-lost').textContent = res.can_enroll ? T('me.lost') : T('me.lost_admin', { admins: adminNames() });
    } catch (_) { /* keep the server-rendered text */ }
  }

  function deviceMeta(d) {
    const parts = [];
    const p = d.peer;
    if (p && p.online) parts.push(T('me.online'));
    else parts.push(T('me.offline') + (d.last_used_at ? ' · ' + T('me.last_seen', { when: rel(d.last_used_at) }) : ''));
    if (p && p.platform) parts.push((String(p.platform).toLowerCase() === 'android' ? T('me.android') : /^win/i.test(p.platform) ? T('me.windows') : p.platform) + (p.client_version ? ' ' + p.client_version : ''));
    if (d.expires_at) parts.push(T('me.expires', { date: fmtDate(d.expires_at) }));
    return parts.join(' · ');
  }

  async function loadDevices() {
    const list = $('me-devices');
    try {
      const res = await call('GET', '/api/v1/me/devices');
      clear(list);
      const devices = res.devices || [];
      if (!devices.length) list.appendChild(el('li', { class: 'me-empty' }, T('me.devices_empty')));
      devices.forEach((d) => {
        const lock = el('button', { type: 'button', class: 'btn btn-sm me-btn-danger' }, T('me.lock'));
        lock.addEventListener('click', () => lockDevice(d));
        list.appendChild(el('li', { class: 'me-item', 'data-device-id': String(d.id) }, [
          el('span', { class: 'me-dot' + (d.peer && d.peer.online ? ' is-on' : ''), 'aria-hidden': 'true' }),
          el('div', { class: 'me-item-text' }, [el('b', null, d.name), el('div', { class: 'me-sub' }, deviceMeta(d))]),
          lock,
        ]));
      });
    } catch (err) { clear(list).appendChild(el('li', { class: 'me-error', text: err.message })); }
  }

  async function lockDevice(d) {
    const ok = await D.confirm({ title: T('me.lock_title', { name: d.name }), message: T('me.lock_text'), okLabel: T('me.lock_ok'), danger: true });
    if (!ok) return;
    try {
      await call('DELETE', '/api/v1/me/devices/' + d.id);
      if (window.showToast) window.showToast(T('me.locked'), 'success');
      loadDevices();
    } catch (err) { D.alert({ message: err.message, danger: true }); }
  }

  async function loadServices() {
    const list = $('me-services');
    try {
      const res = await call('GET', '/api/v1/me/services');
      clear(list);
      const svc = res.services || [];
      if (!svc.length) list.appendChild(el('li', { class: 'me-empty' }, T('me.services_empty')));
      svc.forEach((s) => {
        const inner = [
          el('span', { class: 'me-letter', 'aria-hidden': 'true' }, (Array.from(s.name || '?')[0] || '?').toUpperCase()),
          el('span', { class: 'me-item-text' }, [el('b', null, s.name), el('span', { class: 'me-host' }, s.host)]),
          el('span', { class: 'me-kind' }, s.kind === 'rdp' ? T('me.kind_rdp') : T('me.kind_http')),
        ];
        list.appendChild(el('li', { class: 'me-item me-svc' }, s.url
          ? el('a', { class: 'me-svc-link', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, inner)
          : el('div', { class: 'me-svc-link' }, inner)));
      });
    } catch (err) { clear(list).appendChild(el('li', { class: 'me-error', text: err.message })); }
  }

  // ── Own device setup ──
  let timer = null;
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  $('me-enroll').addEventListener('click', () => {
    stop();
    $('me-enroll-ask').hidden = false;
    $('me-enroll-code').hidden = true;
    $('me-enroll-error').hidden = true;
    $('me-enroll-pihole').checked = false;
    $('me-enroll-create').hidden = false;
    $('me-enroll-create').textContent = T('me.enroll_create');
    window.openModal('me-dlg-enroll');
  });
  $('me-enroll-create').addEventListener('click', async () => {
    const btn = $('me-enroll-create');
    window.btnLoading(btn);
    try {
      const res = await call('POST', '/api/v1/me/enrollment', { pihole: $('me-enroll-pihole').checked });
      window.btnReset(btn);
      $('me-enroll-ask').hidden = true;
      $('me-enroll-code').hidden = false;
      $('me-enroll-qr').src = res.qr;
      $('me-enroll-value').textContent = res.code;
      btn.textContent = T('me.enroll_again');
      stop();
      const cd = $('me-enroll-countdown');
      const tick = () => {
        const left = Math.max(0, Math.floor((res.expiresAt - Date.now()) / 1000));
        if (!left) { stop(); cd.textContent = T('enrollment.expired'); $('me-enroll-qr').classList.add('is-expired'); return; }
        $('me-enroll-qr').classList.remove('is-expired');
        cd.textContent = T('me.valid', { time: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') });
      };
      tick();
      timer = setInterval(tick, 1000);
      loadDevices();
    } catch (err) {
      window.btnReset(btn);
      $('me-enroll-error').textContent = err.message;
      $('me-enroll-error').hidden = false;
    }
  });

  loadMe();
  loadDevices();
  loadServices();
})();
