'use strict';

// Users list (/users) and user profile (/users/:id), one script for both.
// List: role cards, owner-less accesses, search + filters, table / cards; a
// row leads to the profile. Profile ("profile mode"): header with the
// actions (edit, add device, disable, more: password, role, invitation,
// delete) and five tabs (Übersicht, Geräte & Zugänge, "Was sieht …?",
// Anmeldung & Sicherheit, Aktivität; ?tab= in the address). Dialogs on both
// pages (partials/users-dialogs.njk): role comparison, create user, the
// access wizard (device = setup code that creates and assigns a peer,
// script = token code or the key shown once), edit access, edit profile,
// new password, change role, delete, invite to "Mein Bereich", owner-less
// accesses. Strings: #us-i18n (us.*, up.*, users.mb.*, error.*,
// enrollment.*, common.*). No innerHTML — every node is built with
// el()/textContent. Dialogs keep typed input: Escape, × and the backdrop ask
// before throwing away a changed form.
(function () {
  const doc = document;
  const D = window.GCDialog;
  const listPage = doc.getElementById('us-page');
  const profilePage = doc.getElementById('up-page');
  const page = listPage || profilePage;
  if (!page) return;
  // Profile mode: the page belongs to one user, the tabs live on the page.
  const PROFILE = !listPage;

  function readJson(id) {
    try { return JSON.parse((doc.getElementById(id) || {}).textContent || '{}') || {}; } catch (_) { return {}; }
  }
  const I18N = readJson('us-i18n');
  const CTX = readJson('us-ctx');
  const LANG = CTX.lang || doc.documentElement.lang || 'de';

  function T(key, params) {
    let s = I18N[key];
    if (s == null && window.GC && window.GC.t) s = window.GC.t[key];
    if (s == null) s = key;
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function P(base, n, params) {
    return T(base + (n === 1 ? '_one' : '_other'), Object.assign({ count: n }, params || {}));
  }

  // ── DOM helpers ────────────────────────────────────────────────────
  const SVGNS = 'http://www.w3.org/2000/svg';
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
      else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected' || k === 'hidden' || k === 'type') n[k] = v;
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
  function icon(d, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.9'], ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['width', String(size || 17)], ['height', String(size || 17)]]
      .forEach((a) => svg.setAttribute(a[0], a[1]));
    const path = doc.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }
  const ICON = {
    phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
    pc: 'M3 5h18v11H3zM8 20h8M12 16v4',
    code: 'M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14',
    web: 'M3 5h18v14H3zM3 9h18',
    list: 'M4 6h16M4 12h16M4 18h10',
    shield: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5',
  };
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function $(id) { return doc.getElementById(id); }
  function show(n, on) { if (n) n.hidden = !on; }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  function errMsg(err) { return (err && err.message) || T('common.error'); }

  // ── Time ───────────────────────────────────────────────────────────
  // SQLite datetime('now') is UTC without a zone ("2026-10-06 12:34:56").
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  let rtf = null;
  try { rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' }); } catch (_) { rtf = null; }
  function rel(v) {
    const d = toDate(v);
    if (!d) return '';
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(sec);
    if (abs < 45) return T('us.time.now');
    if (!rtf) return fmtDate(d);
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 45) return rtf.format(Math.round(sec / 86400), 'day');
    if (abs < 86400 * 365) return rtf.format(Math.round(sec / (86400 * 30)), 'month');
    return rtf.format(Math.round(sec / (86400 * 365)), 'year');
  }
  function fmtDate(v) {
    const d = v instanceof Date ? v : toDate(v);
    if (!d) return '';
    try { return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); }
  }
  function fmtDateTime(v) {
    const d = toDate(v);
    if (!d) return '';
    try { return d.toLocaleString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
  }
  function newer(a, b) {
    const da = toDate(a);
    const db = toDate(b);
    if (!da) return db ? b : null;
    if (!db) return a;
    return da >= db ? a : b;
  }

  // ── Names, roles, rights ───────────────────────────────────────────
  function nameOf(u) { return (u && (u.display_name || u.username)) || ''; }
  function firstName(u) { return nameOf(u).split(/\s+/)[0]; }
  function initials(u) {
    const words = nameOf(u).trim().split(/[\s._-]+/).filter(Boolean);
    if (!words.length) return '?';
    const chars = words.length > 1 ? [Array.from(words[0])[0], Array.from(words[1])[0]] : Array.from(words[0]).slice(0, 2);
    return chars.join('').toUpperCase();
  }
  function roleLabel(role) { return role === 'admin' ? T('us.role.admin') : T('us.role.member'); }
  function roleTone(role) { return role === 'admin' ? 'admin' : 'member'; }

  const CLIENT_SCOPES = ['client', 'client:services', 'client:rdp', 'client:traffic', 'client:dns'];
  const APP_PRESET = ['client', 'client:services', 'client:rdp', 'client:traffic', 'client:dns'];
  const ADMIN_SCOPES = ['read-only', 'peers', 'routes', 'settings', 'webhooks', 'logs', 'system'];
  const MEMBER_CAP = ['client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp', 'pihole'];
  const RIGHT_KEY = {
    'client': 'client', 'client:services': 'services', 'client:rdp': 'rdp', 'client:traffic': 'traffic', 'client:dns': 'dns',
    'pihole': 'pihole', 'pihole:control': 'pihole_control', 'full-access': 'full', 'read-only': 'read', 'peers': 'peers',
    'routes': 'routes', 'settings': 'settings', 'webhooks': 'webhooks', 'logs': 'logs', 'system': 'system', 'gateway': 'gateway', 'backup': 'backup',
  };
  function rightLabel(scope) { return RIGHT_KEY[scope] ? T('us.right.' + RIGHT_KEY[scope]) : scope; }
  function rightText(scope) { return RIGHT_KEY[scope] ? T('us.right.' + RIGHT_KEY[scope] + '_d') : ''; }
  function allowedFor(role, scope) { return role === 'admin' || role == null || MEMBER_CAP.indexOf(scope) >= 0; }
  function sameSet(a, b) { return a.length === b.length && a.every((x) => b.indexOf(x) >= 0); }
  function presetOf(scopes, device) {
    const s = (scopes || []).filter((x) => x !== 'pihole');
    if (scopes.indexOf('full-access') >= 0) return 'full';
    if (sameSet(scopes, ['read-only'])) return 'read';
    if (sameSet(s, APP_PRESET)) return 'app';
    if (sameSet(s, ['client'])) return 'vpn';
    return device ? 'custom' : 'custom';
  }
  function presetLabel(p) { return T('us.preset.' + p); }
  function isDevice(t) { return t.peer_id != null || t.enrolled === true || t.enrolled === 1; }

  // ── API ────────────────────────────────────────────────────────────
  async function call(method, url, body) {
    const fn = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'del' }[method];
    const res = method === 'GET' || method === 'DELETE' ? await window.api[fn](url) : await window.api[fn](url, body || {});
    if (res && res.ok === false) throw new Error(res.error || T('common.error'));
    return res;
  }

  // ── State ──────────────────────────────────────────────────────────
  const TABS = ['overview', 'access', 'see', 'security', 'activity'];
  function tabFromUrl() {
    try {
      const t = new URL(window.location.href).searchParams.get('tab');
      return TABS.indexOf(t) >= 0 ? t : 'overview';
    } catch (_) { return 'overview'; }
  }
  const state = {
    users: [], filter: 'all', q: '', selId: PROFILE ? Number(CTX.profile) || null : null, tab: PROFILE ? tabFromUrl() : 'overview',
    detail: null, vis: null, devices: null, loc: null, loginMethod: null, orphans: [], mb: { licensed: false, mode: 'off' },
    self: Number(CTX.self) || null,
  };
  function profileHref(id, tab) { return '/users/' + id + (tab && tab !== 'overview' ? '?tab=' + tab : ''); }

  function userById(id) { return state.users.find((u) => u.id === id) || null; }

  // ── Dialog manager ─────────────────────────────────────────────────
  const stack = [];
  function snapshot(ov) {
    const parts = [];
    ov.querySelectorAll('input, select, textarea').forEach((i) => {
      if (i.type === 'checkbox' || i.type === 'radio') parts.push(i.checked ? '1' : '0');
      else parts.push(i.value);
    });
    ov.querySelectorAll('[aria-pressed]').forEach((b) => parts.push(b.getAttribute('aria-pressed')));
    return parts.join('\u0001');
  }
  function openDlg(id) {
    const ov = $(id);
    if (!ov) return null;
    ov.style.display = 'flex';
    doc.body.style.overflow = 'hidden';
    ov._prevFocus = doc.activeElement;
    if (stack.indexOf(id) < 0) stack.push(id);
    ov._dirtyForce = false;
    ov._snap = snapshot(ov);
    const first = ov.querySelector('[data-autofocus]:not([disabled])') || ov.querySelector('.modal input:not([disabled]):not([type=hidden]):not([readonly]), .modal select:not([disabled]), .modal button:not([disabled]):not(.modal-close)');
    setTimeout(() => { try { (first || ov.querySelector('.modal-close')).focus(); } catch (_) { /* gone */ } }, 30);
    return ov;
  }
  function closeDlg(id) {
    const ov = $(id);
    if (!ov) return;
    ov.style.display = 'none';
    const i = stack.indexOf(id);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length) doc.body.style.overflow = '';
    if (ov._onClose) { const f = ov._onClose; ov._onClose = null; f(); }
    if (ov._prevFocus && doc.contains(ov._prevFocus)) { try { ov._prevFocus.focus(); } catch (_) { /* gone */ } }
  }
  function isDirty(ov) {
    if (ov._dirtyForce) return true;
    if (!ov.hasAttribute('data-us-dirty')) return false;
    return snapshot(ov) !== ov._snap;
  }
  async function requestClose(id) {
    const ov = $(id);
    if (!ov || ov.style.display === 'none') return;
    if (isDirty(ov)) {
      const ok = await D.confirm({ title: T('us.dirty.title'), message: T('us.dirty.text'), okLabel: T('us.dirty.discard'), danger: true });
      if (!ok) return;
    }
    closeDlg(id);
  }
  // Capture phase: app.js closes every .modal-overlay on Escape — ours ask
  // first. A GCDialog on top handles its own Escape.
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !stack.length) return;
    if (doc.querySelector('.gcd-dialog')) return;
    e.stopPropagation();
    e.preventDefault();
    requestClose(stack[stack.length - 1]);
  }, true);
  doc.querySelectorAll('[data-us-dialog]').forEach((ov) => {
    // Out of .app (its own stacking context) so the dialogs cover the mobile
    // bottom navigation and the quick-add button.
    doc.body.appendChild(ov);
    ov.addEventListener('mousedown', (e) => { ov._downOnBackdrop = e.target === ov; });
    ov.addEventListener('click', (e) => {
      if (e.target === ov && ov._downOnBackdrop) requestClose(ov.id);
      const c = e.target.closest('[data-us-close]');
      if (c && ov.contains(c)) { e.preventDefault(); requestClose(ov.id); }
    });
  });
  // Copy buttons: data-copy="#selector"
  doc.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b || !(page.contains(b) || b.closest('[data-us-dialog]'))) return;
    const src = doc.querySelector(b.getAttribute('data-copy'));
    if (!src) return;
    const text = src.value != null && src.tagName !== 'CODE' && src.tagName !== 'PRE' ? src.value : src.textContent;
    if (!text) return;
    const done = () => toast(T('us.copied'));
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => {});
  });

  function setError(id, msg) {
    const n = $(id);
    if (!n) return;
    n.textContent = msg || '';
    n.hidden = !msg;
  }

  // Random password: 4 groups of 4 from an alphabet without look-alikes;
  // each group gets an upper-case letter and a digit (complexity rules).
  function genPassword() {
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digit = '23456789';
    const all = lower + upper + digit;
    const rnd = (n) => { const a = new Uint32Array(1); window.crypto.getRandomValues(a); return a[0] % n; };
    const groups = [];
    for (let g = 0; g < 4; g++) {
      const chars = [upper[rnd(upper.length)], digit[rnd(digit.length)], lower[rnd(lower.length)], all[rnd(all.length)]];
      for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = chars[i]; chars[i] = chars[j]; chars[j] = t; }
      groups.push(chars.join(''));
    }
    return groups.join('-');
  }

  // ── List ───────────────────────────────────────────────────────────
  function authInfo(u) {
    if (u.role === 'admin') {
      if (!u.has_password) return { text: T('us.auth.no_password'), ok: false };
      const parts = [];
      if (u.totp_enabled) parts.push('2fa');
      if (u.passkey_count > 0) parts.push('passkey');
      const key = parts.length === 2 ? 'us.auth.pw_2fa_passkey' : parts[0] === '2fa' ? 'us.auth.pw_2fa' : parts[0] === 'passkey' ? 'us.auth.pw_passkey' : 'us.auth.pw_only';
      return { text: T(key), ok: parts.length > 0 };
    }
    if (u.self_service_enabled) {
      if (!u.has_password) return { text: T('us.auth.invited'), ok: true };
      return { text: T('us.auth.self_service'), ok: true };
    }
    return { text: T('us.auth.devices_only'), ok: u.enabled === 1 };
  }
  function devicesText(n) { return n ? P('us.devices', n) : '–'; }
  function lastActive(u) { return newer(u.last_login_at, u.last_token_use); }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return state.users.filter((u) => {
      if (state.filter === 'admin' && u.role !== 'admin') return false;
      if (state.filter === 'member' && u.role === 'admin') return false;
      if (state.filter === 'off' && u.enabled === 1) return false;
      if (!q) return true;
      return [u.username, u.display_name, u.email].some((v) => v && String(v).toLowerCase().indexOf(q) >= 0);
    });
  }

  // Profile picture or initials on the favourite colour (docs/feature-avatars.md);
  // the role tone only when the server sent no colour.
  function paintLook(n, u) {
    if (!u.color) n.classList.add('us-tone-' + roleTone(u.role));
    if (window.GCAvatar) window.GCAvatar.paint(n, { avatarUrl: u.avatarUrl, color: u.color, initials: initials(u) });
    else n.textContent = initials(u);
    return n;
  }
  function avatar(u, lg) {
    return paintLook(el('span', { class: 'us-avatar' + (lg ? ' us-avatar-lg' : '') + (u.enabled === 1 ? '' : ' us-avatar-off'), 'aria-hidden': 'true' }), u);
  }
  function roleChips(u) {
    return [el('span', { class: 'us-chip us-chip-' + roleTone(u.role) }, roleLabel(u.role)),
      u.enabled === 1 ? null : el('span', { class: 'us-chip us-chip-crit', title: u.disabled_reason === 'directory' ? T('up.disabled_directory') : null }, T('us.disabled'))];
  }
  function subLine(u) { return '@' + u.username + (u.email ? ' · ' + u.email : ''); }

  function renderList() {
    const counts = {
      all: state.users.length,
      admin: state.users.filter((u) => u.role === 'admin').length,
      member: state.users.filter((u) => u.role !== 'admin').length,
      off: state.users.filter((u) => u.enabled !== 1).length,
    };
    page.querySelectorAll('[data-count]').forEach((n) => { n.textContent = String(counts[n.getAttribute('data-count')]); });
    page.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', b.getAttribute('data-filter') === state.filter ? 'true' : 'false'));
    const rows = filtered();
    const tbody = clear($('us-tbody'));
    const cards = clear($('us-cards'));
    if (!rows.length) {
      const msg = state.users.length ? T('us.empty_filter') : T('us.empty');
      tbody.appendChild(el('tr', null, el('td', { colspan: '6', class: 'us-muted us-center' }, msg)));
      cards.appendChild(el('li', { class: 'us-muted us-center us-card-empty' }, msg));
      return;
    }
    rows.forEach((u) => {
      const a = authInfo(u);
      // Every way into a user is a real link to the profile (new tab, copy link).
      const href = profileHref(u.id);
      const who = el('a', { class: 'us-who', href }, [
        avatar(u),
        el('span', { class: 'us-who-text' }, [
          el('span', { class: 'us-who-name' }, [nameOf(u), u.id === state.self ? el('span', { class: 'us-you' }, T('us.you')) : null]),
          el('span', { class: 'us-who-sub' }, subLine(u)),
        ]),
      ]);
      const last = lastActive(u);
      const row = el('tr', { class: 'us-row' + (u.enabled === 1 ? '' : ' is-off'), 'data-user-id': String(u.id) }, [
        el('td', { class: 'us-col-user' }, who),
        el('td', { class: 'us-col-role' }, roleChips(u)),
        el('td', { class: 'us-col-auth' }, el('span', { class: 'us-auth' }, [el('span', { class: 'us-dot ' + (a.ok ? 'us-dot-good' : 'us-dot-warn'), 'aria-hidden': 'true' }), a.text])),
        el('td', { class: 'us-col-dev' }, devicesText(u.peer_count)),
        el('td', { class: 'us-col-last us-muted' }, last ? rel(last) : T('us.never_active')),
        el('td', { class: 'us-col-act' }, el('a', { class: 'btn btn-sm us-btn-chip us-open', href, 'aria-label': T('us.open_user', { name: nameOf(u) }) }, T('us.open'))),
      ]);
      // A click anywhere on the row opens the profile (the links keep their
      // own behaviour: middle click, Ctrl+click, keyboard).
      row.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.target.closest('a, button, input, select, textarea')) return;
        if (window.getSelection && String(window.getSelection())) return;
        window.location.assign(href);
      });
      tbody.appendChild(row);
      cards.appendChild(el('li', { class: 'us-card' + (u.enabled === 1 ? '' : ' is-off'), 'data-user-id': String(u.id) }, [
        el('a', { class: 'us-card-btn', href }, [
          avatar(u),
          el('span', { class: 'us-who-text' }, [
            el('span', { class: 'us-who-name' }, [nameOf(u), u.id === state.self ? el('span', { class: 'us-you' }, T('us.you')) : null]),
            el('span', { class: 'us-who-sub' }, subLine(u)),
            el('span', { class: 'us-card-chips' }, roleChips(u)),
            el('span', { class: 'us-card-meta' }, [
              el('span', { class: 'us-auth' }, [el('span', { class: 'us-dot ' + (a.ok ? 'us-dot-good' : 'us-dot-warn'), 'aria-hidden': 'true' }), a.text]),
              el('span', null, devicesText(u.peer_count)),
              el('span', { class: 'us-muted' }, last ? rel(last) : T('us.never_active')),
            ]),
          ]),
          el('span', { class: 'us-card-go', 'aria-hidden': 'true' }, '›'),
        ]),
      ]));
    });
  }

  // The list feeds the table (list page) and the owner pickers of the
  // dialogs (both pages).
  async function loadUsers() {
    try {
      const data = await call('GET', '/api/v1/users');
      state.users = data.users || [];
      if (data.current_user_id) state.self = data.current_user_id;
      if (!PROFILE) renderList();
    } catch (err) {
      if (PROFILE) return;
      const tbody = clear($('us-tbody'));
      tbody.appendChild(el('tr', null, el('td', { colspan: '6', class: 'us-muted us-center', text: T('error.users.list') })));
    }
  }

  // ── Owner-less accesses ────────────────────────────────────────────
  async function loadOrphans() {
    if (PROFILE) return;
    try {
      const data = await call('GET', '/api/v1/users/unassigned-tokens');
      state.orphans = data.tokens || [];
      if (data.machine_binding) state.mb = data.machine_binding;
    } catch (_) { state.orphans = []; }
    const box = $('us-orphans');
    const n = state.orphans.length;
    show(box, n > 0);
    if (!n) return;
    $('us-orphans-title').textContent = P('us.orphans.title', n);
    const names = state.orphans.slice(0, 3).map((t) => '„' + t.name + '“').join(', ') + (n > 3 ? ' …' : '');
    $('us-orphans-names').textContent = P('us.orphans.text', n, { names });
    if ($('us-dlg-orphans').style.display === 'flex') renderOrphanDialog();
  }
  function renderOrphanDialog() {
    const list = clear($('us-orph-list'));
    if (!state.orphans.length) { list.appendChild(el('li', { class: 'us-muted' }, T('us.assign.empty'))); return; }
    state.orphans.forEach((t) => {
      const sel = el('select', { class: 'form-input', 'aria-label': T('us.assign.owner_for', { name: t.name }) },
        [el('option', { value: '' }, T('us.assign.pick'))].concat(state.users.filter((u) => u.enabled === 1)
          .map((u) => el('option', { value: String(u.id) }, nameOf(u) + ' (' + roleLabel(u.role) + ')'))));
      const assign = el('button', { type: 'button', class: 'btn btn-sm btn-primary' }, T('us.assign.save'));
      const revoke = el('button', { type: 'button', class: 'btn btn-sm us-btn-danger' }, T('us.revoke'));
      assign.addEventListener('click', async () => {
        if (!sel.value) { sel.focus(); return; }
        window.btnLoading(assign);
        try {
          const res = await call('PATCH', '/api/v1/tokens/' + t.id, { user_id: Number(sel.value) });
          toast(res.dropped && res.dropped.length ? T('us.assign.done_capped', { rights: res.dropped.map(rightLabel).join(', ') }) : T('us.assign.done'));
          await Promise.all([loadOrphans(), loadUsers()]);
        } catch (err) { window.btnReset(assign); D.alert({ message: errMsg(err), danger: true }); }
      });
      revoke.addEventListener('click', () => revokeToken(t, async () => { await loadOrphans(); }));
      list.appendChild(el('li', { class: 'us-orph' }, [
        el('div', { class: 'us-orph-info' }, [
          el('b', null, t.name),
          el('div', { class: 'us-hint' }, (t.scopes || []).map(rightLabel).join(' · ') + (t.last_used_at ? ' · ' + T('us.used_when', { when: rel(t.last_used_at) }) : '')),
        ]),
        el('div', { class: 'us-orph-ctl' }, [sel, assign, revoke]),
      ]));
    });
  }
  if ($('us-orphans-assign')) $('us-orphans-assign').addEventListener('click', () => { renderOrphanDialog(); openDlg('us-dlg-orphans'); });

  // ── Profile: address, data, header ─────────────────────────────────
  // ?tab= follows the tab (Übersicht without it), so every tab can be linked.
  function writeUrl() {
    if (!PROFILE) return;
    try {
      const u = new URL(window.location.href);
      if (state.tab === 'overview') u.searchParams.delete('tab'); else u.searchParams.set('tab', state.tab);
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (_) { /* old browser */ }
  }

  async function refreshDetail() {
    const id = state.selId;
    if (!id) return;
    try {
      const [detail, vis, devs] = await Promise.all([
        call('GET', '/api/v1/users/' + id),
        call('GET', '/api/v1/users/' + id + '/visibility').catch(() => null),
        call('GET', '/api/v1/users/' + id + '/devices').catch(() => null),
      ]);
      state.detail = detail;
      state.vis = vis;
      state.devices = devs ? (devs.devices || []) : null;
      if (devs && devs.location) state.loc = devs.location;
      if (detail.machine_binding) state.mb = detail.machine_binding;
      renderDetail();
      loadLoginMethod(detail.user);
    } catch (err) {
      const panel = clear($('us-panel-' + state.tab));
      panel.appendChild(el('p', { class: 'us-error', role: 'alert' }, T('error.users.get') + ': ' + errMsg(err)));
    }
  }

  // "letzte Anmeldung … (Passkey)": the method of the newest browser session.
  async function loadLoginMethod(u) {
    if (!(u.role === 'admin' || u.self_service_enabled) || !u.last_login_at) return;
    try {
      const res = await call('GET', '/api/v1/users/' + u.id + '/sessions');
      const s = (res.sessions || [])[0];
      const last = toDate(u.last_login_at);
      // Only when that session is the last sign-in (sessions also expire).
      const method = s && s.method && s.since && last && Math.abs(s.since - last.getTime()) < 120000 ? s.method : null;
      if (method !== state.loginMethod) { state.loginMethod = method; if (state.detail) renderHead(state.detail); }
    } catch (_) { /* the line stays without the method */ }
  }

  function renderDetail() {
    const d = state.detail;
    if (!d) return;
    renderHead(d);
    renderTabs();
    renderPanel();
  }

  function renderHead(d) {
    const u = d.user;
    const off = u.enabled !== 1;
    const av = $('up-avatar');
    av.className = 'up-avatar' + (off ? ' us-avatar-off' : '');
    paintLook(av, u);
    $('up-name').textContent = nameOf(u);
    $('up-crumb-name').textContent = nameOf(u);
    clear($('up-head-chips')).append(
      el('span', { class: 'us-chip us-chip-' + roleTone(u.role) }, roleLabel(u.role)),
      el('span', { class: 'us-chip ' + (off ? 'us-chip-crit' : 'us-chip-good') }, off ? T('up.disabled') : T('up.active')),
    );
    $('up-sub').textContent = ['@' + u.username, u.email, u.language ? T('up.lang_' + (u.language === 'en' ? 'en' : 'de')) : null]
      .filter(Boolean).join(' · ');
    let login = T('up.never_logged_in');
    if (u.last_login_at) {
      login = state.loginMethod
        ? T('up.last_login_method', { when: rel(u.last_login_at), method: T('us.sec.method_' + state.loginMethod) })
        : T('up.last_login', { when: rel(u.last_login_at) });
    }
    $('up-sub2').textContent = [T('up.created', { date: fmtDate(u.created_at) }), login].join(' · ');

    // Actions: the same rules as before in the side panel — the own account
    // and the last enabled admin cannot be disabled, deleted or re-roled.
    const lock = lockReason(d);
    const webLogin = u.role === 'admin' || !!u.self_service_enabled;
    $('up-edit').disabled = false;
    const add = $('up-add-device');
    add.disabled = off;
    add.title = off ? T('us.dev.disabled_hint') : '';
    const tg = $('up-toggle');
    tg.textContent = off ? T('us.enable') : T('us.disable');
    tg.disabled = !!lock;
    $('up-more').disabled = false;
    show($('up-act-password'), webLogin && !d.is_self);
    show($('up-act-own'), webLogin && d.is_self);
    $('up-act-role').disabled = !!lock;
    const inv = $('up-act-invite');
    show(inv, u.role !== 'admin');
    inv.textContent = !u.self_service_enabled ? T('us.sec.invite') : (u.has_password ? T('us.sec.reinvite_reset') : T('us.sec.reinvite'));
    inv.disabled = !u.self_service_enabled && off;
    $('up-act-delete').disabled = !!lock;
    const lk = $('up-lock');
    lk.textContent = lock || '';
    show(lk, !!lock);
  }

  function renderTabs() {
    const u = state.detail ? state.detail.user : null;
    TABS.forEach((t) => {
      const b = $('us-tab-' + t);
      if (t === 'see' && u) b.textContent = T('us.tab.see', { name: firstName(u) });
      const on = t === state.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
      $('us-panel-' + t).hidden = !on;
    });
    if (state.detail) $('up-tab-count').textContent = '(' + state.detail.tokens.length + ')';
    // Phones: the tab bar scrolls sideways — keep the active tab in view
    // (scrollLeft only, the page itself stays where it is).
    const bar = $('us-tabs');
    const cur = $('us-tab-' + state.tab);
    if (bar && cur && bar.scrollWidth > bar.clientWidth) {
      const l = cur.offsetLeft - bar.offsetLeft;
      if (l < bar.scrollLeft) bar.scrollLeft = l - 8;
      else if (l + cur.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = l + cur.offsetWidth - bar.clientWidth + 8;
    }
  }

  function renderPanel() {
    if (!state.detail) return;
    const panel = clear($('us-panel-' + state.tab));
    if (state.tab === 'overview') renderOverview(panel);
    else if (state.tab === 'access') renderAccess(panel);
    else if (state.tab === 'see') renderSee(panel);
    else if (state.tab === 'security') renderSecurity(panel);
    else renderActivity(panel);
  }

  function selectTab(t, focus) {
    if (TABS.indexOf(t) < 0) return;
    state.tab = t;
    writeUrl();
    renderTabs();
    renderPanel();
    if (focus) $('us-tab-' + t).focus();
  }
  // A link to another tab of this profile: switches in place (a modified
  // click still opens it in a new tab).
  function tabLink(label, tab, cls) {
    return el('a', { class: cls || 'up-link', href: profileHref(state.selId, tab), on: { click: (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault();
      selectTab(tab);
      const bar = $('us-tabs');
      if (bar && bar.getBoundingClientRect().top < 0) { try { bar.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { bar.scrollIntoView(); } }
    } } }, label);
  }

  function sectionHead(title, sub, actions) {
    return el('div', { class: 'us-sec-head' }, [
      el('div', { class: 'us-sec-headtext' }, [el('h3', { class: 'us-sec-title' }, title), sub ? el('div', { class: 'us-hint' }, sub) : null]),
    ].concat(actions || []));
  }

  // Why a danger-zone / role action is not available (own account, last admin).
  function lockReason(d) {
    if (d.is_self) return T('us.self_locked');
    if (d.last_admin) return T('us.last_admin_locked');
    return null;
  }

  // ── Tab: Übersicht ─────────────────────────────────────────────────
  // Devices with the last shared location, latest activity, cards for
  // access, security and location sharing.
  const DEV_ICON = {
    laptop: 'M4 5h16v10H4zM2 19h20',
    router: 'M3 14h18v6H3zM7 17h.01M11 17h.01M8 10a6 6 0 0 1 8 0M5 7a10 10 0 0 1 14 0',
    satellite: 'M13 7L9 3 5 7l4 4M17 11l4 4-4 4-4-4M8 12l4 4 6-6-4-4ZM16 8l3-3M9 21a6 6 0 0 0-6-6',
    chevron: 'M9 6l6 6-6 6',
  };
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function fmtTime(d) {
    try { return d.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString().slice(11, 16); }
  }
  /** "heute 08:42", "gestern 19:05", else "10.10. 14:22". */
  function fmtWhen(v) {
    const d = toDate(v);
    if (!d) return '';
    const now = new Date();
    if (sameDay(d, now)) return T('up.time.today', { time: fmtTime(d) });
    if (sameDay(d, new Date(now.getTime() - 86400000))) return T('up.time.yesterday', { time: fmtTime(d) });
    try { return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' }) + ' ' + fmtTime(d); } catch (_) { return fmtDateTime(d); }
  }
  function platformLabel(p) {
    if (!p) return null;
    if (p.platform === 'android') return 'Android';
    if (p.platform === 'windows') return 'Windows';
    return null;
  }
  function clientLabel(p) {
    if (!p || !p.client_version) return null;
    const prod = p.product === 'pro' ? 'GateControl Pro' : (p.product === 'community' ? 'GateControl Community' : 'GateControl');
    return prod + ' ' + p.client_version;
  }
  function deviceSub(dv) {
    const p = dv.peer;
    if (!p) return T('up.dev.not_registered');
    if (!dv.app) return [T('up.dev.no_app_kind'), p.ip].filter(Boolean).join(' · ');
    return [platformLabel(p), clientLabel(p), p.ip].filter(Boolean).join(' · ');
  }
  function statusLine(p) {
    const dot = (tone) => el('span', { class: 'us-dot ' + tone, 'aria-hidden': 'true' });
    if (!p) return el('span', { class: 'up-status' }, [dot('us-dot-off'), T('up.dev.waiting')]);
    if (!p.enabled) return el('span', { class: 'up-status' }, [dot('us-dot-crit'), T('up.dev.disabled')]);
    if (p.online) return el('span', { class: 'up-status up-status-on' }, [dot('us-dot-good'), T('up.dev.online')]);
    if (p.last_handshake) {
      return el('span', { class: 'up-status' }, [dot('us-dot-off'), el('span', { title: fmtDateTime(p.last_handshake) }, T('up.dev.last_seen', { when: rel(p.last_handshake) }))]);
    }
    return el('span', { class: 'up-status' }, [dot('us-dot-off'), T('up.dev.never')]);
  }
  function locationChip(dv, allowed) {
    if (!dv.app) return el('span', { class: 'up-loc up-loc-none' }, T('up.dev.loc_no_app'));
    if (dv.location) {
      const at = toDate(dv.location.at);
      return el('span', { class: 'up-loc up-loc-on', title: fmtDateTime(dv.location.at) }, [icon(DEV_ICON.satellite, 14),
        T('up.dev.loc_at', { time: at && sameDay(at, new Date()) ? fmtTime(at) : fmtWhen(dv.location.at) })]);
    }
    return el('span', { class: 'up-loc up-loc-none' }, allowed ? T('up.dev.loc_never') : T('up.dev.loc_not_allowed'));
  }
  function upCard(title, extras, body) {
    return el('section', { class: 'card up-card' }, [
      el('div', { class: 'up-card-head' }, [el('h2', { class: 'up-card-title' }, title)].concat(extras || [])),
    ].concat(body));
  }
  function facts(rows) {
    const dl = el('dl', { class: 'up-facts' });
    rows.forEach((r) => { if (r) { dl.appendChild(el('dt', null, r[0])); dl.appendChild(el('dd', null, r[1])); } });
    return dl;
  }

  function renderOverview(panel) {
    const d = state.detail;
    const u = d.user;
    const loc = state.loc || { allowed: false, keep: 20, retention_days: 30 };

    // Devices
    const devList = el('ul', { class: 'up-devices', 'aria-live': 'polite' });
    const devices = state.devices;
    if (!devices) devList.appendChild(el('li', { class: 'up-error' }, T('error.users.get')));
    else if (!devices.length) devList.appendChild(el('li', { class: 'up-muted up-empty' }, T('up.dev.empty')));
    (devices || []).forEach((dv) => {
      const inner = [
        el('span', { class: 'up-dev-ic' + (dv.peer && dv.peer.online ? ' is-on' : ''), 'aria-hidden': 'true' },
          icon(!dv.app ? DEV_ICON.router : (dv.peer && dv.peer.platform === 'windows' ? DEV_ICON.laptop : ICON.phone), 20)),
        el('span', { class: 'up-dev-text' }, [
          el('span', { class: 'up-dev-name' }, (dv.peer && dv.peer.name) || (dv.token && dv.token.name) || '—'),
          el('span', { class: 'up-dev-sub' }, deviceSub(dv)),
          el('span', { class: 'up-dev-meta' }, [statusLine(dv.peer), locationChip(dv, loc.allowed)]),
        ]),
      ];
      if (dv.peer) {
        inner.push(el('span', { class: 'up-dev-go', 'aria-hidden': 'true' }, icon(DEV_ICON.chevron, 18)));
        devList.appendChild(el('li', null, el('a', { class: 'up-dev', href: '/users/' + u.id + '/devices/' + dv.peer.id }, inner)));
      } else {
        devList.appendChild(el('li', null, el('div', { class: 'up-dev is-static' }, inner)));
      }
    });
    const main = el('div', { class: 'up-main' }, [
      upCard(T('up.devices'), [el('span', { class: 'up-count' }, devices ? P('up.dev.count', devices.length) : ''), tabLink(T('up.manage'), 'access')], [devList]),
    ]);

    // Latest activity (the tab "Aktivität" has more)
    const act = el('ol', { class: 'up-activity' }, el('li', { class: 'up-muted' }, T('common.loading')));
    main.appendChild(upCard(T('up.activity'), [tabLink(T('up.activity_all'), 'activity')], [act]));
    call('GET', '/api/v1/users/' + u.id + '/activity?limit=8').then((res) => {
      clear(act);
      const entries = res.entries || [];
      if (!entries.length) act.appendChild(el('li', { class: 'up-muted' }, T('up.act.empty')));
      entries.forEach((e) => {
        const tone = e.severity === 'warning' || e.severity === 'error' ? 'us-dot-warn' : (e.severity === 'success' ? 'us-dot-good' : 'us-dot-accent');
        act.appendChild(el('li', { class: 'up-act' + (String(e.event_type).indexOf('location') >= 0 ? ' is-loc' : '') }, [
          el('time', { class: 'up-act-time', datetime: e.created_at, title: fmtDateTime(e.created_at) }, fmtWhen(e.created_at)),
          el('span', { class: 'us-dot ' + tone, 'aria-hidden': 'true' }),
          el('span', { class: 'up-act-text' }, e.message),
        ]));
      });
    }).catch((err) => { clear(act).appendChild(el('li', { class: 'up-error' }, errMsg(err))); });

    // Access, security, location sharing
    const v = state.vis;
    // Source of the account and why it is disabled (docs/groups.md "Verzeichnis-Abgleich").
    const dirInfo = d.directory;
    const sourceText = dirInfo
      ? T('up.acc.source_directory', { name: dirInfo.name }) + (dirInfo.loginName ? ' · ' + dirInfo.loginName : '')
      : T('up.acc.source_local');
    const disabledText = u.enabled === 1 ? null
      : (u.disabled_reason === 'directory' ? T('up.disabled_directory') : T('up.acc.disabled_admin'));
    const access = upCard(T('up.access'), [tabLink(T('up.details'), 'see')], [facts([
      [T('up.acc.role'), roleLabel(u.role)],
      [T('up.acc.source'), dirInfo ? el('a', { href: '/directory?id=' + dirInfo.id }, sourceText) : sourceText],
      disabledText ? [T('up.acc.disabled'), disabledText] : null,
      v ? [T('up.acc.services'), String(v.services && v.services.visible ? v.services.visible.length : 0)] : null,
      v && (CTX.rdp || (v.rdp && v.rdp.total)) ? [T('up.acc.rdp'), String(v.rdp && v.rdp.visible ? v.rdp.visible.length : 0)] : null,
      v ? [T('up.acc.web'), T('up.acc.web_' + (v.web === 'all' || v.web === 'self_service' ? v.web : 'none'))] : null,
    ])]);
    const security = upCard(T('up.security'), [tabLink(T('up.details'), 'security')], [facts([
      [T('up.sec.passkeys'), String((d.passkeys || []).length)],
      [T('up.sec.totp'), u.totp_enabled ? T('up.on') : T('up.off')],
      [T('up.sec.tokens'), String(d.tokens.length)],
      u.role === 'admin' ? null : [T('up.sec.self_service'), u.self_service_enabled ? T('up.on') : T('up.off')],
    ])]);
    const sw = el('button', { type: 'button', class: 'st-switch us-switch', role: 'switch', id: 'up-loc-switch', 'aria-checked': loc.allowed ? 'true' : 'false', 'aria-label': T('up.loc.allow') },
      el('span', { class: 'st-knob', 'aria-hidden': 'true' }));
    sw.addEventListener('click', async () => {
      const want = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      try {
        await call('PUT', '/api/v1/users/' + u.id + '/location-sharing', { enabled: want });
        state.loc = Object.assign({}, loc, { allowed: want });
        toast(want ? T('up.loc.toast_on') : T('up.loc.toast_off'));
        await refreshDetail();
      } catch (err) { sw.disabled = false; D.alert({ message: errMsg(err), danger: true }); }
    });
    const locCard = upCard(T('up.loc.title'), null, [
      el('p', { class: 'up-muted' }, loc.allowed ? T('up.loc.allowed_text', { days: loc.retention_days, keep: loc.keep }) : T('up.loc.denied_text')),
      el('div', { class: 'up-switchrow' }, [el('span', { class: 'up-switchrow-label' }, T('up.loc.allow')), sw]),
    ]);
    panel.appendChild(el('div', { class: 'up-grid' }, [main, el('div', { class: 'up-side' }, [lookCard(d), access, groupsCard(d), security, locCard])]));
  }

  // "Gruppen" (docs/groups.md): the person's groups with role; a group the
  // person only belongs to through a subgroup is marked as inherited.
  function groupsCard(d) {
    const list = d.groups || [];
    const body = el('ul', { class: 'up-groups' });
    if (!list.length) body.appendChild(el('li', { class: 'up-muted' }, T('up.groups.empty')));
    list.forEach((g) => {
      body.appendChild(el('li', null, [
        el('span', { class: 'grp-dot grp-kind-' + g.kind, 'aria-hidden': 'true' }),
        el('a', { href: '/groups?id=' + g.id, title: g.path }, g.path),
        el('span', { class: 'us-chip' + (g.direct ? ' us-chip-member' : ' us-chip-dashed') }, g.direct ? T('up.groups.role.' + g.role) : T('up.groups.inherited')),
      ]));
    });
    return upCard(T('up.groups.title'), [el('a', { class: 'up-link', href: '/groups' }, T('up.groups.manage'))], [body]);
  }

  // "Profilbild & Farbe" (docs/feature-avatars.md): picture (cropped and
  // scaled down in the browser) and favourite colour of this user.
  function lookCard(d) {
    const u = d.user;
    const host = el('div', { class: 'up-look' });
    const card = upCard(T('avatar.title'), null, [host]);
    if (!window.GCAvatar) { card.hidden = true; return card; }
    const ed = window.GCAvatar.editor(host, {
      urls: { avatar: '/api/v1/users/' + u.id + '/avatar', color: '/api/v1/users/' + u.id + '/color' },
      csrf: () => (window.GC && window.GC.csrfToken) || '',
      T,
      toast: (text) => toast(text),
      confirm: (text) => D.confirm({ title: T('avatar.remove'), message: text, okLabel: T('avatar.remove'), danger: true }),
      help: d.is_self ? 'avatar.color_help' : 'avatar.color_help_other',
      buttonClass: 'btn btn-sm us-btn-chip',
      ghostClass: 'btn btn-sm btn-ghost',
      onChange: (look) => {
        if (!look || !state.detail || state.detail.user.id !== u.id) return;
        Object.assign(state.detail.user, { avatarUrl: look.avatarUrl, color: look.color, colorHex: look.colorHex });
        renderHead(state.detail);
      },
    });
    ed.set({ avatarUrl: u.avatarUrl, color: u.color, colorHex: u.colorHex, initials: initials(u) });
    return card;
  }

  async function toggleUser(u) {
    const off = u.enabled !== 1;
    const name = nameOf(u);
    let text;
    if (off) text = u.role === 'admin' ? T('us.confirm.enable_admin', { name }) : T('us.confirm.enable_member', { name });
    else text = T('us.confirm.disable_text', { name }) + (u.role !== 'admin' && u.self_service_enabled ? ' ' + T('us.confirm.disable_self', { name }) : '');
    const ok = await D.confirm({
      title: off ? T('us.confirm.enable_title', { name }) : T('us.confirm.disable_title', { name }),
      message: text,
      okLabel: off ? T('us.enable') : T('us.confirm.disable_ok'),
      danger: !off,
    });
    if (!ok) return false;
    try {
      await call('PUT', '/api/v1/users/' + u.id + '/toggle');
      toast(off ? T('us.toast.enabled', { name }) : T('us.toast.disabled', { name }));
      await loadUsers();
      if (state.selId === u.id) await refreshDetail();
      return true;
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); return false; }
  }

  // ── Tab: Geräte & Zugänge ──────────────────────────────────────────
  function bindingText(t) {
    const mb = state.mb || {};
    if (!mb.licensed || !t.machine_binding_active) {
      return t.machine_fingerprint ? T('us.bind.off_stored', { fp: t.machine_fingerprint }) : T('us.bind.off');
    }
    if (!t.machine_fingerprint) return T('us.bind.pending');
    const since = fmtDate(t.machine_bound_at);
    return since ? T('us.bind.bound_since', { fp: t.machine_fingerprint, date: since }) : T('us.bind.bound', { fp: t.machine_fingerprint });
  }
  function platformIcon(t) {
    const p = String((t.peer && (t.peer.platform || t.peer.product)) || t.name || '').toLowerCase();
    return /win|desktop|pc|laptop|mac|linux/.test(p) ? ICON.pc : ICON.phone;
  }
  function clientText(peer) {
    if (!peer) return '';
    const p = String(peer.platform || '').toLowerCase();
    const kind = p === 'android' ? T('us.dev.android') : /^win/.test(p) ? T('us.dev.windows') : (peer.platform ? peer.platform : '');
    return [kind, peer.client_version ? peer.client_version : null].filter(Boolean).join(' ');
  }

  function renderAccess(panel) {
    const d = state.detail;
    const u = d.user;
    const devices = d.tokens.filter(isDevice);
    const apis = d.tokens.filter((t) => !isDevice(t));
    const disabled = u.enabled !== 1;
    const addDev = el('button', { type: 'button', class: 'btn btn-sm btn-primary', disabled, on: { click: () => openWizard({ ownerId: u.id, kind: 'device' }) } }, T('us.dev.add'));
    panel.appendChild(sectionHead(T('us.dev.title'), T('us.dev.sub'), [addDev]));
    if (disabled) panel.appendChild(el('div', { class: 'us-hint us-mb' }, T('us.dev.disabled_hint')));
    const list = el('div', { class: 'us-stack' });
    if (!devices.length) list.appendChild(el('div', { class: 'us-emptybox' }, T('us.dev.empty')));
    devices.forEach((t) => {
      const peer = t.peer;
      const stateTxt = peer ? (peer.online ? T('us.dev.online') : T('us.dev.offline')) : T('us.dev.no_peer');
      const meta = [clientText(peer), peer ? T('us.dev.peer', { name: peer.name }) : null, peer ? peer.ip : null].filter(Boolean).join(' · ');
      list.appendChild(el('div', { class: 'us-item', 'data-token-id': String(t.id) }, [
        el('div', { class: 'us-item-row' }, [
          el('span', { class: 'us-item-ic' }, icon(platformIcon(t))),
          el('div', { class: 'us-item-main' }, [
            el('div', { class: 'us-item-name' }, [t.name, el('span', { class: 'us-dot ' + (peer && peer.online ? 'us-dot-good' : 'us-dot-off'), 'aria-hidden': 'true' }), el('span', { class: 'us-item-state' }, stateTxt)]),
            meta ? el('div', { class: 'us-hint' }, meta) : null,
          ]),
          peer ? el('a', { class: 'btn btn-sm btn-ghost us-dev-open', href: '/users/' + u.id + '/devices/' + peer.id }, T('us.dev.open_device')) : null,
          el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', on: { click: () => openEdit(t, u) } }, T('us.edit')),
          el('button', { type: 'button', class: 'btn btn-sm us-btn-danger', on: { click: () => revokeToken(t, afterChange) } }, T('us.revoke')),
        ]),
        el('div', { class: 'us-rightchips' }, (t.scopes || []).map((s) => el('span', { class: 'us-rightchip' }, rightLabel(s)))),
        el('div', { class: 'us-item-facts' }, [
          el('span', null, [T('us.dev.binding') + ': ', el('b', null, bindingText(t))]),
          el('span', null, [T('us.dev.expiry') + ': ', el('b', null, t.expires_at ? fmtDate(t.expires_at) : T('us.never'))]),
          el('span', null, [T('us.dev.used') + ': ', el('b', null, t.last_used_at ? rel(t.last_used_at) : T('us.not_yet'))]),
        ]),
      ]));
    });
    panel.appendChild(list);

    const addApi = el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', disabled, on: { click: () => openWizard({ ownerId: u.id, kind: 'token' }) } }, T('us.api.add'));
    panel.appendChild(sectionHead(T('us.api.title'), T('us.api.sub'), [addApi]));
    const alist = el('div', { class: 'us-stack' });
    if (!apis.length) alist.appendChild(el('div', { class: 'us-muted us-small' }, T('us.api.empty')));
    apis.forEach((t) => {
      alist.appendChild(el('div', { class: 'us-item us-item-api', 'data-token-id': String(t.id) }, [
        el('div', { class: 'us-item-row' }, [
          el('span', { class: 'us-item-ic' }, icon(ICON.code)),
          el('div', { class: 'us-item-main' }, [
            el('div', { class: 'us-item-name' }, t.name),
            el('div', { class: 'us-hint' }, [T('us.api.created', { date: fmtDate(t.created_at) }), t.last_used_at ? T('us.used_when', { when: rel(t.last_used_at) }) : T('us.api.unused'),
              t.expires_at ? T('us.api.expires', { date: fmtDate(t.expires_at) }) : null].filter(Boolean).join(' · ')),
          ]),
          el('span', { class: 'us-presetchip' }, presetLabel(presetOf(t.scopes || [], false))),
          el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', on: { click: () => openEdit(t, u) } }, T('us.edit')),
          el('button', { type: 'button', class: 'btn btn-sm us-btn-danger', on: { click: () => revokeToken(t, afterChange) } }, T('us.revoke')),
        ]),
      ]));
    });
    panel.appendChild(alist);
    if (PROFILE) renderKiosk(panel, u);
  }

  // ── Kiosk devices (docs/feature-kiosk-devices.md) ─────────────────
  // Wall tablets that stay signed in to the portal as this user. Only for
  // users a plugin marks as kiosk users; admins never. Devices of a user who
  // is no longer eligible stay listed (paused) so they can be revoked.
  async function renderKiosk(panel, u) {
    const box = el('div', { class: 'us-kiosk', id: 'up-kiosk' });
    panel.appendChild(box);
    let res;
    try { res = await call('GET', '/api/v1/users/' + u.id + '/kiosk'); } catch (err) {
      box.appendChild(el('div', { class: 'us-error', text: errMsg(err) }));
      return;
    }
    if (state.selId !== u.id || state.tab !== 'access' || !box.isConnected) return;
    const devices = res.devices || [];
    if (!res.eligible && !devices.length && res.reason === 'admin') { box.remove(); return; }
    const pair = res.eligible
      ? el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', id: 'up-kiosk-pair', on: { click: () => openKiosk(u, devices) } }, T('up.kiosk.pair'))
      : null;
    box.appendChild(sectionHead(T('up.kiosk.title'), T('up.kiosk.sub', { name: firstName(u) }), pair ? [pair] : []));
    if (res.eligible && res.plugins && res.plugins.length) box.appendChild(el('div', { class: 'us-hint us-mb' }, T('up.kiosk.via', { plugins: res.plugins.join(', ') })));
    if (!res.eligible) {
      const why = { admin: 'up.kiosk.off_admin', disabled: 'up.kiosk.off_disabled' }[res.reason] || 'up.kiosk.off_plugin';
      box.appendChild(el('div', { class: 'us-hint us-mb', id: 'up-kiosk-off' }, T(why)));
    }
    const list = el('div', { class: 'us-stack' });
    if (!devices.length && res.eligible) list.appendChild(el('div', { class: 'us-muted us-small' }, T('up.kiosk.empty')));
    devices.forEach((dv) => {
      list.appendChild(el('div', { class: 'us-item us-item-api', 'data-kiosk-id': String(dv.id) }, [
        el('div', { class: 'us-item-row' }, [
          el('span', { class: 'us-item-ic' }, icon(ICON_KIOSK)),
          el('div', { class: 'us-item-main' }, [
            el('div', { class: 'us-item-name' }, [dv.name, dv.expired ? el('span', { class: 'us-chip us-chip-off' }, T('up.kiosk.expired')) : null]),
            el('div', { class: 'us-hint' }, [
              T('up.kiosk.paired') + ' ' + fmtDate(dv.created_at),
              T('up.kiosk.last_seen') + ' ' + (dv.last_seen_at ? rel(dv.last_seen_at) : '–'),
              T('up.kiosk.last_ip') + ' ' + (dv.last_ip || '–'),
              T('up.kiosk.expires') + ' ' + fmtDate(dv.expires_at),
            ].join(' · ')),
          ]),
          el('button', { type: 'button', class: 'btn btn-sm us-btn-danger', on: { click: () => revokeKiosk(u, dv) } }, T('up.kiosk.revoke')),
        ]),
      ]));
    });
    box.appendChild(list);
  }
  const ICON_KIOSK = 'M4 4h16v12H4zM9 20h6M12 16v4';

  async function revokeKiosk(u, dv) {
    const ok = await D.confirm({ title: T('up.kiosk.revoke_title', { name: dv.name }), message: T('up.kiosk.revoke_text'), okLabel: T('up.kiosk.revoke_ok'), danger: true });
    if (!ok) return;
    try { await call('DELETE', '/api/v1/users/' + u.id + '/kiosk/' + dv.id); toast(T('up.kiosk.revoked')); renderPanel(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }

  // Pairing dialog: name → one-time code (QR + 8 characters, 10 minutes).
  // While a code is shown the dialog looks every 5 s whether a new device
  // appeared, and says so.
  const ki = { user: null, known: [], timer: null, poll: null, expiresAt: 0 };
  function kioskStop() {
    if (ki.timer) { clearInterval(ki.timer); ki.timer = null; }
    if (ki.poll) { clearInterval(ki.poll); ki.poll = null; }
  }
  function openKiosk(u, devices) {
    kioskStop();
    ki.user = u;
    ki.known = (devices || []).map((d) => d.id);
    $('us-ki-for').textContent = T('up.kiosk.dlg_for', { name: nameOf(u) });
    $('us-ki-name').value = T('up.kiosk.dlg_name_default');
    $('us-ki-name').readOnly = false;
    show($('us-ki-result'), false);
    show($('us-ki-paired'), false);
    setError('us-ki-error', '');
    $('us-ki-create').textContent = T('up.kiosk.dlg_create');
    const ov = openDlg('us-dlg-kiosk');
    if (ov) ov._onClose = () => { kioskStop(); if (state.tab === 'access') renderPanel(); };
  }
  async function kioskPoll() {
    if (!ki.user) return;
    try {
      const res = await call('GET', '/api/v1/users/' + ki.user.id + '/kiosk');
      const fresh = (res.devices || []).filter((d) => ki.known.indexOf(d.id) < 0);
      if (!fresh.length) return;
      ki.known = ki.known.concat(fresh.map((d) => d.id));
      const p = $('us-ki-paired');
      p.textContent = T('up.kiosk.dlg_paired', { name: fresh[0].name });
      show(p, true);
      kioskStop();
      $('us-ki-countdown').textContent = '';
    } catch (_) { /* next round */ }
  }
  $('us-ki-create').addEventListener('click', async () => {
    if (!ki.user) return;
    const btn = $('us-ki-create');
    setError('us-ki-error', '');
    window.btnLoading(btn);
    let created = false;
    try {
      const res = await call('POST', '/api/v1/users/' + ki.user.id + '/kiosk/pair', { name: $('us-ki-name').value });
      kioskStop();
      $('us-ki-name').readOnly = true;
      $('us-ki-qr').src = res.qr || '';
      $('us-ki-qr').classList.remove('is-expired');
      $('us-ki-code').textContent = res.code || '';
      $('us-ki-code').classList.remove('is-expired');
      $('us-ki-help').textContent = T('up.kiosk.dlg_help', { url: String(res.url || '').split('?')[0] });
      show($('us-ki-result'), true);
      show($('us-ki-paired'), false);
      created = true;
      const cd = $('us-ki-countdown');
      const tick = () => {
        const left = Math.max(0, Math.floor((res.expiresAt - Date.now()) / 1000));
        if (!left) {
          kioskStop();
          cd.textContent = T('up.kiosk.dlg_expired');
          $('us-ki-qr').classList.add('is-expired');
          $('us-ki-code').classList.add('is-expired');
          return;
        }
        cd.textContent = T('up.kiosk.dlg_valid', { time: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') });
      };
      tick();
      ki.timer = setInterval(tick, 1000);
      ki.poll = setInterval(kioskPoll, 5000);
    } catch (err) {
      setError('us-ki-error', errMsg(err));
    } finally {
      window.btnReset(btn);
      if (created) btn.textContent = T('up.kiosk.dlg_new');
    }
  });

  async function afterChange() {
    await Promise.all([loadUsers(), loadOrphans()]);
    if (state.selId) await refreshDetail();
  }

  async function revokeToken(t, after) {
    const ok = await D.confirm({
      title: T('us.confirm.revoke_title', { name: t.name }),
      message: isDevice(t) ? T('us.confirm.revoke_device') : T('us.confirm.revoke_api'),
      okLabel: T('us.confirm.revoke_ok'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await call('DELETE', '/api/v1/tokens/' + t.id);
      toast(T('us.toast.revoked', { name: t.name }));
      if (after) await after();
      return true;
    } catch (err) { D.alert({ message: errMsg(err), danger: true }); return false; }
  }

  // ── Tab: Was sieht …? ──────────────────────────────────────────────
  function seeGroup(title, count, iconPath, link, items) {
    return el('div', { class: 'us-see-group' }, [
      el('div', { class: 'us-see-head' }, [icon(iconPath, 16), el('b', null, title), count ? el('span', { class: 'us-hint' }, count) : null,
        link ? el('a', { class: 'us-see-link', href: link.href, on: link.click ? { click: link.click } : null }, link.label) : null]),
      el('ul', { class: 'us-see-list' }, items.map((i) => el('li', { class: 'us-see-item' }, [
        el('span', { class: 'us-dot ' + (i.tone || 'us-dot-good'), 'aria-hidden': 'true' }),
        el('span', { class: 'us-see-name' }, i.name),
        i.detail && i.detail !== i.name ? el('span', { class: 'us-see-detail' }, i.detail) : null,
        el('span', { class: 'us-see-why us-why-' + (i.why || 'all') }, i.reason || ''),
      ]))),
    ]);
  }
  function reasonOf(e, user) {
    if (e.reason === 'all') return { why: 'all', reason: T('us.see.why_all') };
    if (e.reason === 'token') return { why: 'pick', reason: T('us.see.why_token') };
    if (e.reason === 'group') return { why: 'pick', reason: T('us.see.why_group', { groups: (e.groups || []).join(', ') }) };
    const names = (e.names || []).length ? e.names.join(', ') : firstName(user);
    return { why: 'pick', reason: T('us.see.why_picked', { names }) };
  }
  function renderSee(panel) {
    const v = state.vis;
    const u = state.detail.user;
    if (!v) { panel.appendChild(el('div', { class: 'us-muted', text: T('error.users.get') })); return; }
    const isAdmin = u.role === 'admin';
    panel.appendChild(el('div', { class: 'us-intro' }, isAdmin ? T('us.see.intro_admin') : T('us.see.intro_member', { name: firstName(u) })));
    // Web UI
    const web = v.web === 'all'
      ? { count: T('us.see.web_all'), item: { name: T('us.see.web_all_item'), why: 'own', reason: T('us.see.why_admin') } }
      : v.web === 'self_service'
        ? { count: T('us.see.web_self'), item: { name: T('us.see.web_self_item'), why: 'own', reason: T('us.see.why_self') } }
        : { count: T('us.see.web_none'), item: { name: T('us.see.web_none_item'), tone: 'us-dot-off', why: 'all', reason: T('us.see.why_member') } };
    panel.appendChild(seeGroup(T('us.see.web'), web.count, ICON.web, isAdmin ? null : { label: T('us.see.link_security'), href: '#', click: (e) => { e.preventDefault(); selectTab('security'); } }, [web.item]));
    // Services
    const svcItems = v.services.visible.map((e) => Object.assign({ name: e.name, detail: e.host }, reasonOf(e, u)));
    if (v.services.hidden) svcItems.push({ name: P('us.see.hidden', v.services.hidden), tone: 'us-dot-off', why: 'all', reason: T('us.see.why_hidden') });
    if (!svcItems.length) svcItems.push({ name: T('us.see.none'), tone: 'us-dot-off', why: 'all', reason: '' });
    panel.appendChild(seeGroup(T('us.see.services'), T('us.see.count', { n: v.services.visible.length, total: v.services.total }), ICON.list,
      { label: T('us.see.link_shares'), href: '/routes' }, svcItems));
    // RDP
    if (CTX.rdp || v.rdp.total) {
      const rdpItems = v.rdp.visible.map((e) => Object.assign({ name: e.name, detail: e.host }, reasonOf(e, u)));
      if (v.rdp.hidden) rdpItems.push({ name: P('us.see.hidden', v.rdp.hidden), tone: 'us-dot-off', why: 'all', reason: T('us.see.why_hidden') });
      if (!rdpItems.length) rdpItems.push({ name: T('us.see.none'), tone: 'us-dot-off', why: 'all', reason: '' });
      panel.appendChild(seeGroup(T('us.see.rdp'), T('us.see.count', { n: v.rdp.visible.length, total: v.rdp.total }), ICON.pc,
        { label: T('us.see.link_shares'), href: '/rdp' }, rdpItems));
    }
    // Pi-hole
    let piItems;
    if (!v.pihole.licensed) piItems = [{ name: T('us.see.pihole_unlicensed'), tone: 'us-dot-off', why: 'all', reason: '' }];
    else if (!v.pihole.devices.length) piItems = [{ name: T('us.see.pihole_no_devices'), tone: 'us-dot-off', why: 'all', reason: '' }];
    else piItems = v.pihole.devices.map((x) => ({ name: x.name, detail: x.on ? T('us.see.pihole_on') : T('us.see.pihole_off'), tone: x.on ? 'us-dot-good' : 'us-dot-warn', why: 'pick', reason: T('us.see.why_device') }));
    panel.appendChild(seeGroup(T('us.see.pihole'), '', ICON.shield,
      { label: T('us.see.link_change'), href: '#', click: (e) => { e.preventDefault(); selectTab('access'); } }, piItems));
  }

  // ── Tab: Anmeldung & Sicherheit ────────────────────────────────────
  function secRow(title, chipText, chipTone, hint, actions) {
    return el('div', { class: 'us-secrow' }, [
      el('div', { class: 'us-secrow-text' }, [
        el('div', { class: 'us-secrow-title' }, [title, chipText ? el('span', { class: 'us-chip us-chip-' + chipTone }, chipText) : null]),
        hint ? el('div', { class: 'us-hint' }, hint) : null,
      ]),
    ].concat(actions || []));
  }

  async function renderSecurity(panel) {
    const d = state.detail;
    const u = d.user;
    const webLogin = u.role === 'admin' || u.self_service_enabled;
    if (u.role !== 'admin') renderMemberAccess(panel, d);

    // Portal PIN (shared devices, "Wer bist du?"): set by the person
    // (invitation or Konto & Sicherheit), the admin can only remove it.
    const pinOn = !!u.has_portal_pin;
    const pinBtn = el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', id: 'us-pin-reset', disabled: !pinOn, on: { click: () => resetPin(u) } }, T('us.sec.pin_reset'));
    panel.appendChild(secRow(T('us.sec.pin'), pinOn ? T('us.sec.pin_on') : T('us.sec.pin_off'), pinOn ? 'good' : 'off',
      pinOn ? T('us.sec.pin_hint_on') : (u.role === 'admin' || u.self_service_enabled ? T('us.sec.pin_hint_off') : T('us.sec.pin_hint_invite')), [pinBtn]));

    if (!webLogin) return;

    // Password
    const pwHint = u.must_change_password ? T('us.sec.pw_must')
      : (u.password_changed_at ? T('us.sec.pw_changed', { date: fmtDate(u.password_changed_at) }) : T('us.sec.pw_unknown'));
    const pwBtn = d.is_self
      ? el('a', { class: 'btn btn-sm us-btn-chip', href: '/profile' }, T('us.sec.own_profile'))
      : el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', on: { click: () => openPassword(u) } }, T('us.sec.pw_new'));
    panel.appendChild(secRow(T('us.sec.password'), u.has_password ? T('us.sec.pw_set') : T('us.sec.pw_missing'), u.has_password ? 'good' : 'warn',
      u.has_password ? pwHint : (u.role === 'admin' ? T('us.sec.pw_missing_hint') : T('us.sec.pw_invite_hint')), [pwBtn]));

    // 2FA
    const tfOn = !!u.totp_enabled;
    const tfBtn = el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', disabled: !tfOn || d.is_self, on: { click: () => reset2fa(u) } }, T('us.sec.reset'));
    panel.appendChild(secRow(T('us.sec.totp'), tfOn ? T('us.sec.on') : T('us.sec.off'), tfOn ? 'good' : (u.role === 'admin' ? 'warn' : 'off'),
      tfOn ? (u.totp_confirmed_at ? T('us.sec.totp_since', { date: fmtDate(u.totp_confirmed_at) }) : '') : (u.role === 'admin' ? T('us.sec.totp_hint') : T('us.sec.totp_member')),
      [tfBtn]));

    // Passkeys
    const pks = d.passkeys || [];
    panel.appendChild(secRow(T('us.sec.passkeys'), pks.length ? String(pks.length) : T('us.sec.passkeys_none'), pks.length ? 'good' : 'off',
      pks.length ? '' : T('us.sec.passkeys_hint'), []));
    if (pks.length) {
      panel.appendChild(el('ul', { class: 'us-sublist' }, pks.map((k) => el('li', { class: 'us-subitem' }, [
        el('span', { class: 'us-subitem-text' }, [el('b', null, k.name), el('span', { class: 'us-hint' }, ' · ' + T('us.sec.passkey_added', { date: fmtDate(k.created_at) })
          + (k.last_used_at ? ' · ' + T('us.used_when', { when: rel(k.last_used_at) }) : ''))]),
        d.is_self ? null : el('button', { type: 'button', class: 'btn btn-sm us-btn-danger', on: { click: () => removePasskey(u, k) } }, T('us.sec.passkey_remove')),
      ]))));
    }

    // Sessions
    const head = el('div', { class: 'us-sec-head us-sessions-head' }, [el('h3', { class: 'us-sec-title' }, T('us.sec.sessions'))]);
    panel.appendChild(head);
    const list = el('ul', { class: 'us-sublist' }, el('li', { class: 'us-muted us-small' }, T('common.loading')));
    panel.appendChild(list);
    try {
      const res = await call('GET', '/api/v1/users/' + u.id + '/sessions');
      if (state.selId !== u.id || state.tab !== 'security') return;
      clear(list);
      const sessions = res.sessions || [];
      if (!sessions.length) list.appendChild(el('li', { class: 'us-muted us-small' }, T('us.sec.sessions_none')));
      const others = sessions.filter((s) => !s.current);
      if (others.length > 1 || (others.length && !d.is_self)) {
        head.appendChild(el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', on: { click: () => signOutAll(u, d.is_self) } }, d.is_self ? T('us.sec.sign_out_others') : T('us.sec.sign_out_all')));
      }
      sessions.forEach((s) => {
        const client = s.browser ? (s.os ? T('us.sec.browser_on', { browser: s.browser, os: s.os }) : s.browser) : T('us.sec.unknown_browser');
        const method = s.method ? T('us.sec.method_' + s.method) : '';
        list.appendChild(el('li', { class: 'us-subitem' }, [
          el('span', { class: 'us-subitem-text' }, [el('b', null, client), el('span', { class: 'us-hint' }, [s.ip ? ' · ' + s.ip : '', method ? ' · ' + method : ''].join(''))]),
          el('span', { class: 'us-hint' }, s.since ? T('us.sec.since', { when: rel(s.since) }) : ''),
          s.current ? el('span', { class: 'us-this' }, T('us.sec.session_this'))
            : el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', on: { click: () => signOut(u, s) } }, T('us.sec.sign_out')),
        ]));
      });
    } catch (err) { clear(list).appendChild(el('li', { class: 'us-error', text: errMsg(err) })); }
  }

  function renderMemberAccess(panel, d) {
    const u = d.user;
    const name = firstName(u);
    if (!u.self_service_enabled) {
      panel.appendChild(el('div', { class: 'us-box' }, [
        el('div', { class: 'us-box-title' }, T('us.sec.no_web')),
        el('div', { class: 'us-muted us-small' }, T('us.sec.no_web_text')),
      ]));
      panel.appendChild(el('div', { class: 'us-invitebox' }, [
        el('div', { class: 'us-invitebox-text' }, [
          el('div', { class: 'us-secrow-title' }, [T('us.sec.allow'), el('span', { class: 'us-new' }, T('us.new'))]),
          el('div', { class: 'us-hint' }, T('us.sec.allow_text')),
        ]),
        el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', disabled: u.enabled !== 1, on: { click: () => openInvite(u) } }, T('us.sec.invite')),
      ]));
      return;
    }
    const invite = d.invite;
    panel.appendChild(el('div', { class: 'us-box' }, [
      el('div', { class: 'us-box-title' }, [T('us.sec.self_on'), ' ', el('span', { class: 'us-chip us-chip-good' }, T('us.auth.self_service'))]),
      el('div', { class: 'us-muted us-small' }, T('us.sec.self_on_text', { name })),
      invite && !u.has_password ? el('div', { class: 'us-hint' }, T('us.sec.self_invited', { date: fmtDateTime(invite.expiresAt) })) : null,
      el('div', { class: 'us-btnrow' }, [
        el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', on: { click: () => openInvite(u) } }, u.has_password ? T('us.sec.reinvite_reset') : T('us.sec.reinvite')),
        el('button', { type: 'button', class: 'btn btn-sm us-btn-danger', on: { click: () => disableSelf(u) } }, T('us.sec.self_off')),
      ]),
    ]));
    const sw = el('button', { type: 'button', class: 'st-switch us-switch', role: 'switch', 'aria-checked': u.self_enroll_enabled ? 'true' : 'false', 'aria-label': T('us.sec.self_enroll') }, el('span', { class: 'st-knob', 'aria-hidden': 'true' }));
    sw.addEventListener('click', async () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      try {
        await call('PUT', '/api/v1/users/' + u.id + '/self-enroll', { enabled: next });
        toast(next ? T('us.sec.self_enroll_on') : T('us.sec.self_enroll_off'));
        await refreshDetail();
      } catch (err) { sw.disabled = false; D.alert({ message: errMsg(err), danger: true }); }
    });
    panel.appendChild(el('div', { class: 'us-box us-switchrow' }, [
      el('div', { class: 'us-switchrow-text' }, [
        el('b', null, T('us.sec.self_enroll')),
        el('div', { class: 'us-hint' }, T('us.sec.self_enroll_text', { name })),
        // The account's directory may allow it for all its accounts (users.mayEnroll).
        d.directory && d.directory.selfEnroll ? el('div', { class: 'us-hint' }, T('us.sec.self_enroll_dir', { name: d.directory.name })) : null,
      ]),
      sw,
    ]));
  }

  async function reset2fa(u) {
    const ok = await D.confirm({ title: T('us.sec.reset_title'), message: T('us.sec.reset_text', { name: nameOf(u) }), okLabel: T('us.sec.reset_ok'), danger: true });
    if (!ok) return;
    try { await call('DELETE', '/api/v1/users/' + u.id + '/2fa'); toast(T('us.sec.reset_done')); await afterChange(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }
  async function resetPin(u) {
    const ok = await D.confirm({ title: T('us.sec.pin_reset_title', { name: nameOf(u) }), message: T('us.sec.pin_reset_text', { name: firstName(u) }), okLabel: T('us.sec.pin_reset_ok'), danger: true });
    if (!ok) return;
    try { await call('DELETE', '/api/v1/users/' + u.id + '/portal-pin'); toast(T('us.sec.pin_reset_done')); await afterChange(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }
  async function removePasskey(u, k) {
    const ok = await D.confirm({ title: T('us.sec.passkey_remove_title'), message: T('us.sec.passkey_remove_text', { name: k.name, user: nameOf(u) }), okLabel: T('us.sec.passkey_remove_ok'), danger: true });
    if (!ok) return;
    try { await call('DELETE', '/api/v1/users/' + u.id + '/passkeys/' + k.id); toast(T('us.sec.passkey_removed')); await afterChange(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }
  async function signOut(u, s) {
    try { await call('DELETE', '/api/v1/users/' + u.id + '/sessions/' + s.ref); toast(T('us.sec.signed_out')); renderPanel(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }
  async function signOutAll(u, self) {
    const ok = await D.confirm({ title: self ? T('us.sec.sign_out_others') : T('us.sec.sign_out_all'), message: self ? T('us.sec.sign_out_others_text') : T('us.sec.sign_out_all_text', { name: nameOf(u) }), okLabel: T('us.sec.sign_out'), danger: true });
    if (!ok) return;
    try { await call('DELETE', '/api/v1/users/' + u.id + '/sessions'); toast(T('us.sec.signed_out')); renderPanel(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }
  async function disableSelf(u) {
    const name = nameOf(u);
    const ok = await D.confirm({ title: T('us.confirm.self_off_title', { name }), message: T('us.confirm.self_off_text', { name }), okLabel: T('us.confirm.self_off_ok'), danger: true });
    if (!ok) return;
    try { await call('DELETE', '/api/v1/users/' + u.id + '/self-service'); toast(T('us.toast.self_off', { name })); await afterChange(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
  }

  // ── Tab: Aktivität ─────────────────────────────────────────────────
  async function renderActivity(panel) {
    const u = state.detail.user;
    const list = el('ol', { class: 'us-log' }, el('li', { class: 'us-muted us-small' }, T('common.loading')));
    panel.appendChild(list);
    panel.appendChild(el('a', { class: 'us-see-link us-log-all', href: '/logs' }, T('us.act.all')));
    try {
      const res = await call('GET', '/api/v1/users/' + u.id + '/activity?limit=25');
      if (state.selId !== u.id || state.tab !== 'activity') return;
      clear(list);
      const entries = res.entries || [];
      if (!entries.length) list.appendChild(el('li', { class: 'us-muted us-small' }, T('us.act.empty')));
      entries.forEach((e) => {
        const tone = e.severity === 'warning' || e.severity === 'error' ? 'us-dot-warn' : (e.severity === 'success' ? 'us-dot-good' : 'us-dot-accent');
        list.appendChild(el('li', { class: 'us-log-item' }, [
          el('span', { class: 'us-dot ' + tone, 'aria-hidden': 'true' }),
          el('span', { class: 'us-log-text' }, e.message),
          el('time', { class: 'us-hint', datetime: e.created_at, title: fmtDateTime(e.created_at) }, rel(e.created_at)),
        ]));
      });
    } catch (err) { clear(list).appendChild(el('li', { class: 'us-error', text: errMsg(err) })); }
  }

  // ── Split-tunnel editor (wizard + edit dialog) ─────────────────────
  const PRIVATE_NETS = [{ cidr: '10.0.0.0/8', label: 'Private 10.x' }, { cidr: '172.16.0.0/12', label: 'Private 172.x' }, { cidr: '192.168.0.0/16', label: 'Private 192.x' }];
  const LINKLOCAL = { cidr: '169.254.0.0/16', label: 'Link-local' };
  function stEditor(host, preset) {
    clear(host);
    const p = preset || { mode: 'exclude', networks: PRIVATE_NETS.slice(), locked: false };
    const nets = (p.networks || []).map((n) => n.cidr);
    const isPriv = PRIVATE_NETS.every((n) => nets.indexOf(n.cidr) >= 0);
    const isLl = nets.indexOf(LINKLOCAL.cidr) >= 0;
    const extra = nets.filter((c) => c !== LINKLOCAL.cidr && !PRIVATE_NETS.some((n) => n.cidr === c));
    const mode = el('select', { class: 'form-input' }, [
      el('option', { value: 'exclude', selected: p.mode !== 'include' }, T('us.st.exclude')),
      el('option', { value: 'include', selected: p.mode === 'include' }, T('us.st.include')),
    ]);
    const priv = el('input', { type: 'checkbox', checked: isPriv });
    const ll = el('input', { type: 'checkbox', checked: isLl });
    const more = el('textarea', { class: 'form-input us-mono', rows: '2', placeholder: '192.0.2.0/24', spellcheck: 'false' });
    more.value = extra.join('\n');
    const locked = el('input', { type: 'checkbox', checked: !!p.locked });
    host.appendChild(el('div', { class: 'us-st-grid' }, [
      el('label', { class: 'us-field' }, [el('span', { class: 'us-label' }, T('us.st.mode')), mode]),
      el('div', { class: 'us-field' }, [el('span', { class: 'us-label' }, T('us.st.networks')),
        el('label', { class: 'us-check' }, [priv, T('us.st.private')]),
        el('label', { class: 'us-check' }, [ll, T('us.st.linklocal')])]),
      el('label', { class: 'us-field us-span2' }, [el('span', { class: 'us-label' }, T('us.st.more')), more]),
      el('label', { class: 'us-check us-span2' }, [locked, T('us.st.locked')]),
    ]));
    return {
      value() {
        const networks = [];
        if (priv.checked) PRIVATE_NETS.forEach((n) => networks.push(n));
        if (ll.checked) networks.push(LINKLOCAL);
        more.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).forEach((c) => networks.push({ cidr: c, label: c }));
        return { mode: mode.value, networks, locked: locked.checked };
      },
    };
  }
  function stSummary(json) {
    if (!json) return T('us.ed.st_default');
    let p;
    try { p = typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return T('us.ed.st_default'); }
    const nets = (p.networks || []).map((n) => n.cidr).join(', ') || '–';
    return T(p.mode === 'include' ? 'us.ed.st_include' : 'us.ed.st_exclude', { nets }) + (p.locked ? ' · ' + T('us.ed.st_locked') : '');
  }

  // ── Wizard ─────────────────────────────────────────────────────────
  const wz = { step: 1, kind: 'device', ownerId: null, preset: 'app', scopes: [], pihole: false, binding: false, peers: [], result: null, timer: null, st: null, lastBody: null, after: null, fixedOwner: false };

  function ownerOf(id) { return id == null || id === '' ? null : userById(Number(id)); }
  function wzRole() { const o = ownerOf(wz.ownerId); return o ? o.role : null; }

  async function openWizard(opts) {
    const o = opts || {};
    // The owner picker needs the list (the profile loads it next to the user).
    if (!state.users.length) await loadUsers();
    wz.step = 1;
    wz.kind = o.kind || 'device';
    wz.ownerId = o.ownerId != null ? o.ownerId : null;
    wz.result = null;
    wz.after = o.after || null;
    wz.lastBody = null;
    stopTimer();
    $('us-wz-name').value = '';
    $('us-wz-expiry').value = '';
    $('us-wz-date').value = '';
    $('us-wz-classic').checked = false;
    $('us-wz-st').open = false;
    wz.st = stEditor(page.ownerDocument.querySelector('[data-st-editor="wz"]'), null);
    setError('us-wz-error', '');
    fillOwners();
    applyKind(true);
    await loadOwnerPeers();
    renderWizard();
    const ov = openDlg('us-dlg-wizard');
    ov._onClose = () => { stopTimer(); const f = wz.after; wz.after = null; afterChange(); if (f) f(); };
  }

  function fillOwners() {
    const sel = clear($('us-wz-owner'));
    if (wz.kind === 'token') sel.appendChild(el('option', { value: '' }, T('us.wz.owner_none')));
    state.users.forEach((u) => {
      const off = u.enabled !== 1;
      sel.appendChild(el('option', { value: String(u.id), disabled: off, selected: wz.ownerId === u.id },
        off ? T('us.wz.owner_disabled', { name: nameOf(u) }) : nameOf(u) + ' (' + roleLabel(u.role) + ')'));
    });
    if (wz.ownerId == null && wz.kind === 'device') {
      const first = state.users.find((u) => u.enabled === 1);
      wz.ownerId = first ? first.id : null;
    }
    sel.value = wz.ownerId == null ? '' : String(wz.ownerId);
  }

  function defaultPreset() {
    const role = wzRole();
    if (wz.kind === 'device') return 'app';
    return role === 'user' ? 'custom' : 'read';
  }
  function applyKind(reset) {
    page.ownerDocument.querySelectorAll('#us-dlg-wizard [data-kind]').forEach((b) => b.setAttribute('aria-pressed', b.getAttribute('data-kind') === wz.kind ? 'true' : 'false'));
    $('us-wz-name').placeholder = wz.kind === 'device' ? T('us.wz.name_ph_device') : T('us.wz.name_ph_api');
    $('us-wz-name-hint').textContent = wz.kind === 'device' ? T('us.wz.name_hint_device') : T('us.wz.name_hint_api');
    if (reset) {
      wz.preset = defaultPreset();
      wz.scopes = wz.kind === 'device' ? APP_PRESET.slice() : (wzRole() === 'user' ? CLIENT_SCOPES.slice() : ['read-only']);
      wz.pihole = wz.kind === 'device' && wzRole() === 'admin';
      wz.binding = wz.kind === 'device';
    }
    show($('us-wz-classic-wrap'), wz.kind === 'token');
  }

  async function loadOwnerPeers() {
    wz.peers = [];
    if (wz.ownerId != null) {
      try { const d = await call('GET', '/api/v1/users/' + wz.ownerId); wz.peers = d.peers || []; if (d.machine_binding) state.mb = d.machine_binding; } catch (_) { wz.peers = []; }
    }
    const sel = clear($('us-wz-peer'));
    const owner = ownerOf(wz.ownerId);
    if (wz.kind === 'device') {
      sel.appendChild(el('option', { value: 'new' }, T('us.wz.peer_new')));
    } else {
      sel.appendChild(el('option', { value: '' }, T('us.wz.peer_none')));
    }
    wz.peers.forEach((p) => sel.appendChild(el('option', { value: String(p.id) }, T('us.wz.peer_existing', { name: p.name }) + ' · ' + p.ip)));
    sel.value = wz.kind === 'device' ? 'new' : '';
    updatePeerHint(owner);
  }
  function updatePeerHint(owner) {
    const v = $('us-wz-peer').value;
    let hint = '';
    if (wz.kind === 'device') hint = v === 'new' ? T('us.wz.peer_hint_new', { name: owner ? firstName(owner) : '' }) : T('us.wz.peer_hint_existing');
    else hint = v ? T('us.wz.peer_hint_api') : '';
    $('us-wz-peer-hint').textContent = hint;
  }

  function scopeCatalog() {
    if (wz.kind === 'device') {
      return [
        { title: null, scopes: CLIENT_SCOPES.concat(CTX.pihole ? ['pihole', 'pihole:control'] : []) },
      ];
    }
    return [
      { title: T('us.wz.g_app'), scopes: CLIENT_SCOPES.slice() },
      CTX.pihole ? { title: T('us.wz.g_pihole'), scopes: ['pihole', 'pihole:control'] } : null,
      { title: T('us.wz.g_admin'), scopes: ADMIN_SCOPES.slice() },
    ].filter(Boolean);
  }

  function presetDefs() {
    const role = wzRole();
    const member = role === 'user';
    if (wz.kind === 'device') {
      return [
        { id: 'app', title: T('us.wz.p_app'), text: T('us.wz.p_app_text') },
        { id: 'vpn', title: T('us.wz.p_vpn'), text: T('us.wz.p_vpn_text') },
        { id: 'custom', title: T('us.wz.p_custom'), text: T('us.wz.p_custom_device') },
      ];
    }
    return [
      { id: 'read', title: T('us.wz.p_read'), text: T('us.wz.p_read_text'), locked: member },
      { id: 'full', title: T('us.wz.p_full'), text: T('us.wz.p_full_text'), locked: member },
      { id: 'custom', title: T('us.wz.p_custom'), text: T('us.wz.p_custom_api') },
    ];
  }
  function presetScopes(id) {
    if (id === 'app') return APP_PRESET.slice();
    if (id === 'vpn') return ['client'];
    if (id === 'read') return ['read-only'];
    if (id === 'full') return ['full-access'];
    return wz.scopes.slice();
  }
  function wzScopes() {
    const role = wzRole();
    let s = wz.preset === 'custom' ? wz.scopes.slice() : presetScopes(wz.preset);
    if (wz.kind === 'device' && wz.preset !== 'custom' && wz.pihole && CTX.pihole) s.push('pihole');
    s = s.filter((x, i) => s.indexOf(x) === i && allowedFor(role, x));
    return s;
  }

  function renderPresets() {
    const host = clear($('us-wz-presets'));
    const role = wzRole();
    presetDefs().forEach((p) => {
      const on = wz.preset === p.id;
      const b = el('button', { type: 'button', class: 'us-preset' + (p.locked ? ' is-locked' : ''), 'aria-pressed': on ? 'true' : 'false', disabled: !!p.locked }, [
        el('span', { class: 'us-radio', 'aria-hidden': 'true' }),
        el('span', { class: 'us-preset-text' }, [el('b', null, p.title), el('span', { class: 'us-hint' }, p.text)]),
        p.locked ? el('span', { class: 'us-hint' }, T('us.wz.admin_only')) : null,
      ]);
      b.addEventListener('click', () => {
        if (p.id === 'custom' && wz.preset !== 'custom') wz.scopes = presetScopes(wz.preset).concat(wz.kind === 'device' && wz.pihole ? ['pihole'] : []);
        wz.preset = p.id;
        renderPresets();
      });
      host.appendChild(b);
    });
    // Pi-hole statistics as a right of the device (app/vpn presets)
    if (wz.kind === 'device' && CTX.pihole && wz.preset !== 'custom') {
      const cb = el('input', { type: 'checkbox', checked: wz.pihole, on: { change: (e) => { wz.pihole = e.target.checked; } } });
      host.appendChild(el('label', { class: 'us-check us-check-top us-pihole-opt' }, [cb, el('span', null, [el('b', null, T('us.right.pihole')),
        el('span', { class: 'us-hint' }, role === 'admin' ? T('us.wz.pihole_admin') : T('us.wz.pihole_member'))])]));
    }
    const sc = clear($('us-wz-scopes'));
    sc.hidden = wz.preset !== 'custom';
    if (wz.preset !== 'custom') return;
    scopeCatalog().forEach((g) => {
      if (g.title) sc.appendChild(el('div', { class: 'us-scope-group' }, g.title));
      const grid = el('div', { class: 'us-scope-grid' });
      g.scopes.forEach((s) => {
        const locked = !allowedFor(role, s);
        const cb = el('input', { type: 'checkbox', value: s, checked: wz.scopes.indexOf(s) >= 0 && !locked, disabled: locked });
        cb.addEventListener('change', () => {
          if (cb.checked && wz.scopes.indexOf(s) < 0) wz.scopes.push(s);
          if (!cb.checked) wz.scopes = wz.scopes.filter((x) => x !== s);
        });
        grid.appendChild(el('label', { class: 'us-scope' + (locked ? ' is-locked' : '') }, [cb, el('span', null, [el('b', null, rightLabel(s)),
          el('span', { class: 'us-hint' }, locked ? T('us.wz.admin_only') : rightText(s))])]));
      });
      sc.appendChild(grid);
    });
  }

  function renderBinding() {
    const mb = state.mb || { licensed: false, mode: 'off' };
    const sw = $('us-wz-binding-sw');
    let text = T('us.wz.binding_text');
    let on = wz.binding;
    let editable = true;
    if (!mb.licensed) { text = T('users.mb.locked'); editable = false; on = false; }
    else if (mb.mode === 'off') { text += ' ' + T('us.wz.binding_mode_off'); editable = false; on = false; }
    else if (mb.mode === 'global') { text += ' ' + T('us.wz.binding_mode_global'); editable = false; on = true; }
    else text += ' ' + T('us.wz.binding_mode_individual');
    $('us-wz-binding-text').textContent = text;
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.disabled = !editable;
  }
  $('us-wz-binding-sw').addEventListener('click', () => { wz.binding = !wz.binding; renderBinding(); });

  function renderWizard() {
    const owner = ownerOf(wz.ownerId);
    $('us-wz-for').textContent = owner ? T('us.wz.for', { name: nameOf(owner), role: roleLabel(owner.role) }) : T('us.wz.for_none');
    page.ownerDocument.querySelectorAll('#us-wz-steps [data-step]').forEach((b) => {
      const n = Number(b.getAttribute('data-step'));
      const cur = n === wz.step;
      const done = n < wz.step;
      b.classList.toggle('is-current', cur);
      b.classList.toggle('is-done', done);
      if (cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.querySelector('.us-step-num').textContent = done ? '✓' : String(n);
      b.disabled = !!wz.result || n > wz.step;
    });
    page.ownerDocument.querySelectorAll('#us-dlg-wizard [data-page]').forEach((p) => { p.hidden = Number(p.getAttribute('data-page')) !== wz.step; });
    if (wz.step === 2) renderPresets();
    if (wz.step === 3) { renderBinding(); show($('us-wz-date-wrap'), $('us-wz-expiry').value === 'date'); show($('us-wz-classic-wrap'), wz.kind === 'token'); }
    $('us-wz-back').hidden = wz.step === 1 || !!wz.result;
    $('us-wz-cancel').textContent = wz.result ? T('common.close') : T('common.cancel');
    const next = $('us-wz-next');
    next.textContent = wz.step === 3 ? (wz.kind === 'token' && $('us-wz-classic').checked ? T('us.wz.create_key') : T('us.wz.create')) : (wz.step === 4 ? T('common.done') : T('common.next'));
  }

  page.ownerDocument.querySelectorAll('#us-dlg-wizard [data-kind]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.getAttribute('data-kind');
    if (k === wz.kind) return;
    wz.kind = k;
    fillOwners();
    applyKind(true);
    await loadOwnerPeers();
    renderWizard();
  }));
  $('us-wz-owner').addEventListener('change', async (e) => {
    wz.ownerId = e.target.value === '' ? null : Number(e.target.value);
    applyKind(true);
    await loadOwnerPeers();
    renderWizard();
  });
  $('us-wz-peer').addEventListener('change', () => updatePeerHint(ownerOf(wz.ownerId)));
  $('us-wz-expiry').addEventListener('change', () => show($('us-wz-date-wrap'), $('us-wz-expiry').value === 'date'));
  $('us-wz-classic').addEventListener('change', renderWizard);
  $('us-wz-steps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b || b.disabled) return;
    const n = Number(b.getAttribute('data-step'));
    if (n < wz.step) { wz.step = n; setError('us-wz-error', ''); renderWizard(); }
  });
  $('us-wz-back').addEventListener('click', () => { if (wz.step > 1 && !wz.result) { wz.step -= 1; setError('us-wz-error', ''); renderWizard(); } });
  $('us-wz-next').addEventListener('click', async () => {
    setError('us-wz-error', '');
    if (wz.step === 1) {
      if (!$('us-wz-name').value.trim()) { setError('us-wz-error', T('us.wz.err_name')); $('us-wz-name').focus(); return; }
      if (wz.kind === 'device' && wz.ownerId == null) { setError('us-wz-error', T('us.wz.err_owner')); return; }
      wz.step = 2; renderWizard(); return;
    }
    if (wz.step === 2) {
      if (!wzScopes().length) { setError('us-wz-error', T('us.wz.err_rights')); return; }
      wz.step = 3; renderWizard(); return;
    }
    if (wz.step === 3) { await wzCreate(); return; }
    closeDlg('us-dlg-wizard');
  });

  function expiryIso(sel, dateInput) {
    const v = sel.value;
    if (!v) return { ok: true, value: null };
    if (v === 'date') {
      if (!dateInput.value) return { ok: false };
      const d = new Date(dateInput.value + 'T23:59:59');
      if (isNaN(d.getTime()) || d <= new Date()) return { ok: false };
      return { ok: true, value: d.toISOString() };
    }
    if (v === 'keep') return { ok: true, keep: true };
    const d = new Date();
    d.setDate(d.getDate() + Number(v));
    return { ok: true, value: d.toISOString() };
  }

  async function wzCreate() {
    const exp = expiryIso($('us-wz-expiry'), $('us-wz-date'));
    if (!exp.ok) { setError('us-wz-error', T('us.wz.err_date')); return; }
    const scopes = wzScopes();
    const name = $('us-wz-name').value.trim() || T('us.wz.name_default');
    const peerVal = $('us-wz-peer').value;
    const st = $('us-wz-st').open ? wz.st.value() : null;
    const mb = state.mb || {};
    const binding = mb.licensed && (mb.mode === 'global' || (mb.mode === 'individual' && wz.binding));
    const classic = wz.kind === 'token' && $('us-wz-classic').checked;
    let url;
    let body;
    if (wz.kind === 'device') {
      url = '/api/v1/enrollment';
      body = { userId: wz.ownerId, scopes, machineBinding: binding, name, expires_at: exp.value || null, split_tunnel_override: st };
      if (peerVal && peerVal !== 'new') body.peerId = Number(peerVal);
    } else if (classic) {
      url = wz.ownerId != null ? '/api/v1/users/' + wz.ownerId + '/tokens' : '/api/v1/tokens';
      body = { name, scopes, expires_at: exp.value || null, machine_binding_enabled: binding, split_tunnel_override: st };
      if (peerVal) body.peer_id = Number(peerVal);
    } else {
      url = '/api/v1/enrollment';
      body = { kind: 'token', name, scopes, userId: wz.ownerId, expires_at: exp.value || null, machine_binding_enabled: binding, split_tunnel_override: st };
      if (peerVal) body.peer_id = Number(peerVal);
    }
    const btn = $('us-wz-next');
    window.btnLoading(btn);
    try {
      const res = await call('POST', url, body);
      wz.lastBody = { url, body, classic };
      wz.result = res;
      wz.step = 4;
      renderResult(res, { name, scopes, exp: exp.value, binding, classic, peerVal });
    } catch (err) {
      setError('us-wz-error', errMsg(err));
    } finally {
      window.btnReset(btn);
      renderWizard();
    }
  }

  function summaryRows(host, info) {
    const owner = ownerOf(wz.ownerId);
    const peerSel = $('us-wz-peer');
    const peerTxt = peerSel.options[peerSel.selectedIndex] ? peerSel.options[peerSel.selectedIndex].textContent : '';
    const rights = presetOf(info.scopes, wz.kind === 'device') !== 'custom' && wz.preset !== 'custom'
      ? presetLabel(wz.preset) + (info.scopes.indexOf('pihole') >= 0 && wz.kind === 'device' ? ' + ' + rightLabel('pihole') : '')
      : info.scopes.map(rightLabel).join(', ');
    const rows = [
      [T('us.wz.sum_name'), info.name],
      [T('us.wz.sum_owner'), owner ? nameOf(owner) : T('us.wz.owner_none')],
      [T('us.wz.sum_rights'), rights],
      [T('us.wz.sum_expiry'), info.exp ? fmtDate(info.exp) : T('us.never')],
      [T('us.wz.sum_binding'), info.binding ? T('us.on') : T('us.off')],
      [T('us.wz.sum_peer'), peerTxt],
    ];
    clear(host);
    rows.forEach((r) => { host.appendChild(el('dt', null, r[0])); host.appendChild(el('dd', null, r[1])); });
  }

  function stopTimer() { if (wz.timer) { clearInterval(wz.timer); wz.timer = null; } }
  function renderResult(res, info) {
    stopTimer();
    show($('us-wz-code'), !info.classic);
    show($('us-wz-key'), !!info.classic);
    if (info.classic) {
      $('us-wz-key-value').textContent = res.token || '';
      summaryRows($('us-wz-summary-key'), info);
      return;
    }
    $('us-wz-qr').src = res.qr || '';
    $('us-wz-qr').classList.remove('is-expired');
    $('us-wz-code-value').textContent = res.code || '';
    $('us-wz-code-value').classList.remove('is-expired');
    summaryRows($('us-wz-summary'), info);
    $('us-wz-help').textContent = wz.kind === 'device' ? T('us.wz.help_device') : T('us.wz.help_api');
    const curl = $('us-wz-curl');
    const showCurl = wz.kind === 'token';
    curl.hidden = !showCurl;
    $('us-wz-curl-copy').hidden = !showCurl;
    if (showCurl) curl.textContent = 'curl -s -X POST ' + res.url + '/api/v1/client/enroll -H "Content-Type: application/json" -d \'{"code":"' + res.code + '"}\'';
    const cd = $('us-wz-countdown');
    const tick = () => {
      const left = Math.max(0, Math.floor((res.expiresAt - Date.now()) / 1000));
      if (!left) {
        stopTimer();
        cd.textContent = T('enrollment.expired');
        $('us-wz-qr').classList.add('is-expired');
        $('us-wz-code-value').classList.add('is-expired');
        return;
      }
      cd.textContent = T('us.wz.valid', { time: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') });
    };
    tick();
    wz.timer = setInterval(tick, 1000);
  }
  $('us-wz-regen').addEventListener('click', async () => {
    if (!wz.lastBody) return;
    const btn = $('us-wz-regen');
    window.btnLoading(btn);
    try {
      const res = await call('POST', wz.lastBody.url, wz.lastBody.body);
      wz.result = res;
      const b = wz.lastBody.body;
      renderResult(res, { name: b.name, scopes: b.scopes, exp: b.expires_at, binding: !!(b.machineBinding || b.machine_binding_enabled), classic: false });
    } catch (err) { setError('us-wz-error', errMsg(err)); } finally { window.btnReset(btn); }
  });

  // ── Edit access ────────────────────────────────────────────────────
  const ed = { token: null, owner: null, ownerId: null, st: null, stChanged: false, stEditor: null, usage: 'single', usageUsers: [] };

  function openEdit(t, owner) {
    ed.token = t;
    ed.owner = owner || null;
    ed.ownerId = t.user_id;
    ed.stChanged = false;
    ed.stEditor = null;
    const device = isDevice(t);
    const ic = clear($('us-ed-ic'));
    ic.appendChild(icon(device ? platformIcon(t) : ICON.code, 18));
    $('us-ed-title').textContent = t.name;
    const ownerName = owner ? nameOf(owner) : T('us.ed.no_owner');
    $('us-ed-sub').textContent = [
      device ? T('us.ed.device_of', { owner: ownerName }) : T('us.ed.api_of', { owner: ownerName }),
      T(device ? 'us.ed.set_up' : 'us.ed.created', { date: fmtDate(t.created_at) }),
      t.last_used_at ? T('us.used_when', { when: rel(t.last_used_at) }) : T('us.api.unused'),
    ].join(' · ');
    $('us-ed-name').value = t.name;
    const exp = clear($('us-ed-expiry'));
    exp.appendChild(el('option', { value: '' }, T('us.wz.exp_never')));
    if (t.expires_at) exp.appendChild(el('option', { value: 'keep' }, fmtDate(t.expires_at)));
    [['30', 'us.wz.exp_30'], ['90', 'us.wz.exp_90'], ['365', 'us.wz.exp_365'], ['date', 'us.wz.exp_date']].forEach((o) => exp.appendChild(el('option', { value: o[0] }, T(o[1]))));
    exp.value = t.expires_at ? 'keep' : '';
    $('us-ed-date').value = '';
    show($('us-ed-date-wrap'), false);
    renderEditRights();
    renderEditFacts();
    ed.usage = t.device_usage === 'multi' ? 'multi' : 'single';
    ed.usageUsers = (t.device_users || []).slice();
    renderEditUsage();
    setError('us-ed-error', '');
    openDlg('us-dlg-edit');
  }

  // ── "Wer nutzt dieses Gerät?" (portal; AdminGeraet.dc.html) ──────────
  // single: the portal shows the owner right away when the device connects.
  // multi:  shared device — "Wer bist du?" + portal PIN; the owner is always
  //         allowed, the admin ticks who else may pick themselves.
  function pinState(u) {
    if (u.has_portal_pin) return { text: T('us.usage.pin_set'), tone: 'good' };
    return { text: u.role === 'admin' ? T('us.usage.pin_missing_admin') : T('us.usage.pin_missing'), tone: 'warn' };
  }
  function renderEditUsage() {
    const t = ed.token;
    const box = $('us-ed-usage');
    show(box, isDevice(t));
    if (!isDevice(t)) return;
    const owner = ownerOf(ed.ownerId);
    const modes = clear($('us-ed-usage-modes'));
    [['single', 'us.usage.single', 'us.usage.single_text'], ['multi', 'us.usage.multi', 'us.usage.multi_text']].forEach((m) => {
      const on = ed.usage === m[0];
      modes.appendChild(el('button', { type: 'button', class: 'us-usage-mode' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', 'data-scope': m[0],
        on: { click: () => { if (ed.usage === m[0]) return; ed.usage = m[0]; $('us-dlg-edit')._dirtyForce = true; renderEditUsage(); } } },
      [el('b', null, T(m[1])), el('span', { class: 'us-hint' }, T(m[2]))]));
    });
    const detail = clear($('us-ed-usage-detail'));
    if (ed.usage === 'single') {
      detail.appendChild(el('div', { class: 'us-usage-note' }, owner
        ? [T('us.usage.single_note_pre'), el('b', null, nameOf(owner)), T('us.usage.single_note_post')]
        : T('us.usage.single_no_owner')));
      return;
    }
    const list = el('div', { class: 'us-usage-people' });
    if (owner) {
      const p = pinState(owner);
      list.appendChild(el('label', { class: 'us-usage-person' }, [
        el('input', { type: 'checkbox', checked: true, disabled: true }),
        el('span', { class: 'us-grow' }, T('us.usage.owner', { name: nameOf(owner) })),
        el('span', { class: 'us-usage-pin is-' + p.tone }, p.text),
      ]));
    }
    state.users.filter((u) => u.enabled === 1 && u.id !== ed.ownerId).forEach((u) => {
      const p = pinState(u);
      const cb = el('input', { type: 'checkbox', checked: ed.usageUsers.indexOf(u.id) >= 0, 'data-user-id': String(u.id) });
      cb.addEventListener('change', () => {
        ed.usageUsers = ed.usageUsers.filter((x) => x !== u.id);
        if (cb.checked) ed.usageUsers.push(u.id);
        $('us-dlg-edit')._dirtyForce = true;
      });
      list.appendChild(el('label', { class: 'us-usage-person' }, [cb, el('span', { class: 'us-grow' }, nameOf(u)), el('span', { class: 'us-usage-pin is-' + p.tone }, p.text)]));
    });
    detail.appendChild(el('div', { class: 'us-usage-box' }, [
      el('div', { class: 'us-usage-box-title' }, T('us.usage.people')),
      list,
      el('div', { class: 'us-hint' }, T('us.usage.pin_hint')),
    ]));
  }
  $('us-ed-expiry').addEventListener('change', () => show($('us-ed-date-wrap'), $('us-ed-expiry').value === 'date'));

  function renderEditRights() {
    const t = ed.token;
    const device = isDevice(t);
    const owner = ownerOf(ed.ownerId);
    const role = owner ? owner.role : null;
    $('us-ed-rights-q').textContent = device ? T('us.ed.rights_q_device') : T('us.ed.rights_q_api');
    const host = clear($('us-ed-rights'));
    let list = device ? CLIENT_SCOPES.concat(CTX.pihole ? ['pihole', 'pihole:control'] : [])
      : ['full-access'].concat(CLIENT_SCOPES, CTX.pihole ? ['pihole', 'pihole:control'] : [], ADMIN_SCOPES);
    (t.scopes || []).forEach((s) => { if (list.indexOf(s) < 0) list = list.concat([s]); });
    list.forEach((s) => {
      const locked = !allowedFor(role, s);
      const fixed = device && s === 'client';
      const cb = el('input', { type: 'checkbox', value: s, checked: (t.scopes || []).indexOf(s) >= 0, disabled: locked || fixed, 'data-scope': s });
      host.appendChild(el('label', { class: 'us-right' + (locked ? ' is-locked' : ''), title: fixed ? T('us.ed.client_fixed') : null }, [cb, el('span', null, [rightLabel(s),
        locked ? el('span', { class: 'us-hint' }, ' · ' + T('us.wz.admin_only')) : null])]));
    });
  }
  function editScopes() {
    const out = [];
    $('us-ed-rights').querySelectorAll('input[data-scope]').forEach((cb) => { if (cb.checked && !cb.disabled) out.push(cb.value); else if (cb.checked && cb.value === 'client') out.push('client'); });
    return out;
  }

  function fact(title, value, actions, extra) {
    return el('div', { class: 'us-fact' }, [
      el('div', { class: 'us-fact-text' }, [el('div', { class: 'us-fact-title' }, title), value != null ? el('div', { class: 'us-hint' }, value) : null]),
    ].concat(actions || [], extra ? [extra] : []));
  }

  function renderEditFacts() {
    const t = ed.token;
    const host = clear($('us-ed-facts'));
    const device = isDevice(t);
    // Peer
    if (device || t.peer) {
      const p = t.peer;
      host.appendChild(fact(T('us.ed.peer'), p ? T('us.ed.peer_value', { name: p.name, ip: p.ip, state: p.online ? T('us.dev.online') : T('us.dev.offline') }) : T('us.ed.peer_none'),
        p ? [el('a', { class: 'btn btn-sm us-btn-chip', href: '/peers?q=' + encodeURIComponent(p.name) }, T('us.ed.peer_open'))] : []));
    }
    // Machine binding (v1.142 block)
    if (mbApplies(t)) host.appendChild(el('div', { class: 'us-fact us-fact-mb' }, renderMachineBinding(t)));
    // Split tunnel
    const stBox = el('div', { class: 'us-st', hidden: true });
    const stValue = el('div', { class: 'us-hint' }, stSummary(t.split_tunnel_override));
    const stBtn = el('button', { type: 'button', class: 'btn btn-sm us-btn-chip' }, T('us.ed.st_set'));
    const stReset = t.split_tunnel_override ? el('button', { type: 'button', class: 'btn btn-sm us-btn-chip' }, T('us.ed.st_reset')) : null;
    stBtn.addEventListener('click', () => {
      let preset = null;
      try { preset = t.split_tunnel_override ? JSON.parse(t.split_tunnel_override) : null; } catch (_) { preset = null; }
      ed.stEditor = stEditor(stBox, preset);
      ed.stChanged = true;
      stBox.hidden = false;
      stBtn.hidden = true;
      $('us-dlg-edit')._dirtyForce = true;
    });
    if (stReset) stReset.addEventListener('click', () => { ed.stEditor = null; ed.stChanged = true; stValue.textContent = T('us.ed.st_default_pending'); stReset.hidden = true; stBox.hidden = true; $('us-dlg-edit')._dirtyForce = true; });
    host.appendChild(el('div', { class: 'us-fact us-fact-col' }, [
      el('div', { class: 'us-fact-row' }, [el('div', { class: 'us-fact-text' }, [el('div', { class: 'us-fact-title' }, T('us.ed.st')), stValue]), stBtn, stReset]),
      stBox,
    ]));
    // Owner
    const owner = ownerOf(ed.ownerId);
    const ownerVal = el('div', { class: 'us-hint' }, owner ? T('us.ed.owner_value', { name: nameOf(owner), role: roleLabel(owner.role) }) : T('us.ed.no_owner'));
    const ownerSel = el('select', { class: 'form-input', hidden: true, 'aria-label': T('us.ed.owner') },
      state.users.filter((u) => u.enabled === 1 || u.id === ed.ownerId).map((u) => el('option', { value: String(u.id), selected: u.id === ed.ownerId }, nameOf(u) + ' (' + roleLabel(u.role) + ')')));
    const ownerBtn = el('button', { type: 'button', class: 'btn btn-sm us-btn-chip' }, T('us.ed.owner_change'));
    ownerBtn.addEventListener('click', () => { ownerSel.hidden = false; ownerBtn.hidden = true; ownerSel.focus(); });
    ownerSel.addEventListener('change', () => {
      ed.ownerId = Number(ownerSel.value);
      const o = ownerOf(ed.ownerId);
      ownerVal.textContent = o ? T('us.ed.owner_value', { name: nameOf(o), role: roleLabel(o.role) }) : '';
      const keep = editScopes();
      renderEditRights();
      $('us-ed-rights').querySelectorAll('input[data-scope]').forEach((cb) => { if (!cb.disabled) cb.checked = keep.indexOf(cb.value) >= 0; });
      $('us-dlg-edit')._dirtyForce = true;
      renderEditUsage();
    });
    host.appendChild(el('div', { class: 'us-fact us-fact-col' }, [
      el('div', { class: 'us-fact-row' }, [el('div', { class: 'us-fact-text' }, [el('div', { class: 'us-fact-title' }, T('us.ed.owner')), ownerVal]), ownerBtn]),
      ownerSel,
    ]));
  }

  $('us-ed-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = ed.token;
    setError('us-ed-error', '');
    const name = $('us-ed-name').value.trim();
    if (!name) { setError('us-ed-error', T('us.wz.err_name')); return; }
    const exp = expiryIso($('us-ed-expiry'), $('us-ed-date'));
    if (!exp.ok) { setError('us-ed-error', T('us.wz.err_date')); return; }
    const scopes = editScopes();
    if (!scopes.length) { setError('us-ed-error', T('us.wz.err_rights')); return; }
    const body = {};
    if (name !== t.name) body.name = name;
    if (!exp.keep) { if (exp.value || t.expires_at) body.expires_at = exp.value || null; }
    if (!sameSet(scopes, t.scopes || [])) body.scopes = scopes;
    if (ed.ownerId !== t.user_id) body.user_id = ed.ownerId;
    if (ed.stChanged) body.split_tunnel_override = ed.stEditor ? ed.stEditor.value() : null;
    if (isDevice(t)) {
      if (ed.usage !== (t.device_usage === 'multi' ? 'multi' : 'single')) body.device_usage = ed.usage;
      const users = ed.usage === 'multi' ? ed.usageUsers.filter((id) => id !== ed.ownerId) : (t.device_users || []);
      if (!sameSet(users, t.device_users || [])) body.device_users = users;
    }
    const btn = $('us-ed-save');
    if (!Object.keys(body).length) { closeDlg('us-dlg-edit'); return; }
    window.btnLoading(btn);
    try {
      const res = await call('PATCH', '/api/v1/tokens/' + t.id, body);
      window.btnReset(btn);
      closeDlg('us-dlg-edit');
      toast(res.dropped && res.dropped.length ? T('us.ed.saved_capped', { rights: res.dropped.map(rightLabel).join(', ') }) : T('us.ed.saved'));
      await afterChange();
    } catch (err) { window.btnReset(btn); setError('us-ed-error', errMsg(err)); }
  });
  $('us-ed-revoke').addEventListener('click', async () => {
    const t = ed.token;
    if (await revokeToken(t, null)) { closeDlg('us-dlg-edit'); await afterChange(); }
  });

  // ── Machine binding block (v1.142, users.mb.*) ─────────────────────
  function mbT(k, params) { return T('users.mb.' + k, params); }
  function mbApplies(tk) {
    if (tk.machine_fingerprint) return true;
    return (tk.scopes || []).some((s) => s === 'full-access' || s === 'client' || s.indexOf('client:') === 0);
  }
  function mbLockIcon() {
    const svg = doc.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', '12'], ['height', '12'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    const r = doc.createElementNS(SVGNS, 'rect');
    [['x', '3'], ['y', '11'], ['width', '18'], ['height', '11'], ['rx', '2']].forEach((a) => r.setAttribute(a[0], a[1]));
    const p = doc.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M7 11V7a5 5 0 0110 0v4');
    svg.appendChild(r);
    svg.appendChild(p);
    return svg;
  }
  function renderMachineBinding(tk) {
    const st = state.mb || { licensed: false, mode: 'off' };
    const licensed = !!st.licensed;
    const mode = st.mode || 'off';
    const active = licensed && !!tk.machine_binding_active;
    const fp = tk.machine_fingerprint || '';
    const box = el('div', { class: 'mb-area' + (licensed ? '' : ' mb-locked'), 'data-mb-state': !licensed ? 'locked' : (active ? (fp ? 'bound' : 'pending') : 'inactive'), 'data-mb-mode': mode });
    const head = el('div', { class: 'mb-head' }, el('span', { class: 'mb-title' }, mbT('title')));
    if (!licensed) head.appendChild(el('span', { class: 'mb-pro', title: mbT('locked') }, mbT('pro')));
    if (licensed && mode === 'global') head.appendChild(el('span', { class: 'mb-eff mb-eff-global' }, mbT('global')));
    else if (licensed && mode === 'individual' && active) head.appendChild(el('span', { class: 'mb-eff' }, mbT('active')));
    box.appendChild(head);
    const status = el('div', { class: 'mb-status' }, el('span', { class: 'mb-dot', 'aria-hidden': 'true' }));
    const text = el('span', { class: 'mb-status-text' });
    if (active && fp) {
      status.classList.add('mb-status-bound');
      text.appendChild(doc.createTextNode(mbT('bound') + ' '));
      text.appendChild(el('code', { class: 'mb-fp' }, fp + '…'));
      const since = fmtDate(tk.machine_bound_at);
      if (since) text.appendChild(doc.createTextNode(' ' + mbT('since', { date: since })));
    } else if (active) {
      status.classList.add('mb-status-pending');
      text.textContent = mbT('pending');
    } else {
      status.classList.add('mb-status-off');
      text.textContent = mbT('inactive');
      if (fp) { text.appendChild(doc.createTextNode(' · ' + mbT('stored') + ' ')); text.appendChild(el('code', { class: 'mb-fp' }, fp + '…')); }
    }
    status.appendChild(text);
    box.appendChild(status);
    const ctl = el('div', { class: 'mb-ctl' });
    const sw = el('button', { type: 'button', class: 'st-switch mb-switch', role: 'switch', id: 'mb-switch-' + tk.id, 'aria-checked': (mode === 'global' ? true : !!tk.machine_binding_enabled) ? 'true' : 'false' }, el('span', { class: 'st-knob', 'aria-hidden': 'true' }));
    const editable = licensed && mode === 'individual';
    sw.disabled = !editable;
    if (editable) sw.addEventListener('click', () => toggleMachineBinding(tk, sw));
    ctl.appendChild(sw);
    ctl.appendChild(el('label', { class: 'mb-switch-label', for: sw.id }, mbT('toggle')));
    if (licensed && fp) {
      const reset = el('button', { type: 'button', class: 'btn btn-ghost tf-btn-sm mb-reset' }, mbT('reset'));
      reset.addEventListener('click', () => resetMachineBinding(tk, reset));
      ctl.appendChild(reset);
    }
    box.appendChild(ctl);
    let hint = null;
    if (!licensed) { hint = el('div', { class: 'mb-hint mb-hint-lock' }, [mbLockIcon(), mbT('locked')]); }
    else if (mode === 'global') hint = el('div', { class: 'mb-hint' }, mbT('hint_global'));
    else if (mode === 'off') hint = el('div', { class: 'mb-hint' }, [mbT('hint_off') + ' ', el('a', { class: 'mb-link', href: '/settings#geraete' }, mbT('settings_link'))]);
    if (hint) { hint.id = 'mb-hint-' + tk.id; sw.setAttribute('aria-describedby', hint.id); box.appendChild(hint); }
    return box;
  }
  async function toggleMachineBinding(tk, sw) {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.disabled = true;
    try {
      await call('PUT', '/api/v1/tokens/' + tk.id + '/binding', { enabled: next });
      toast(mbT(next ? 'saved_on' : 'saved_off'));
      await reloadEditToken(tk.id);
    } catch (err) { sw.disabled = false; D.alert({ message: mbT('failed') + ': ' + errMsg(err), danger: true }); }
  }
  async function resetMachineBinding(tk, btn) {
    const ok = await D.confirm({ title: mbT('reset_title'), message: mbT('reset_confirm', { name: tk.name, fp: tk.machine_fingerprint || '' }), okLabel: mbT('reset_ok'), danger: true });
    if (!ok) return;
    window.btnLoading(btn);
    try {
      await call('DELETE', '/api/v1/tokens/' + tk.id + '/binding');
      toast(mbT('reset_done'));
      await reloadEditToken(tk.id);
    } catch (err) { window.btnReset(btn); D.alert({ message: mbT('failed') + ': ' + errMsg(err), danger: true }); }
  }
  async function reloadEditToken(id) {
    await refreshDetail();
    const fresh = state.detail && state.detail.tokens.find((x) => x.id === id);
    if (fresh && ed.token && ed.token.id === id) { ed.token = fresh; renderEditFacts(); }
  }

  // ── New password ───────────────────────────────────────────────────
  let pwUser = null;
  function openPassword(u) {
    pwUser = u;
    $('us-pw-title').textContent = T('us.pw.title', { name: firstName(u) });
    $('us-pw-text').textContent = T('us.pw.text', { name: firstName(u) });
    page.ownerDocument.querySelector('input[name="us-pw-mode"][value="generate"]').checked = true;
    $('us-pw-value').value = genPassword();
    $('us-pw-value').readOnly = true;
    $('us-pw-must').checked = true;
    setError('us-pw-error', '');
    openDlg('us-dlg-password');
  }
  page.ownerDocument.querySelectorAll('input[name="us-pw-mode"]').forEach((r) => r.addEventListener('change', () => {
    const manual = r.value === 'manual' && r.checked;
    const gen = r.value === 'generate' && r.checked;
    if (manual) { $('us-pw-value').readOnly = false; $('us-pw-value').value = ''; $('us-pw-value').focus(); }
    if (gen) { $('us-pw-value').readOnly = true; $('us-pw-value').value = genPassword(); }
  }));
  $('us-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('us-pw-value').value;
    if (!pw) { setError('us-pw-error', T('error.users.password_required')); return; }
    const btn = $('us-pw-save');
    window.btnLoading(btn);
    try {
      await call('POST', '/api/v1/users/' + pwUser.id + '/password', { password: pw, mustChangePassword: $('us-pw-must').checked });
      window.btnReset(btn);
      closeDlg('us-dlg-password');
      toast(T('us.pw.done', { name: firstName(pwUser) }));
      await afterChange();
    } catch (err) { window.btnReset(btn); setError('us-pw-error', errMsg(err)); }
  });

  // ── Change role ────────────────────────────────────────────────────
  function openRole() {
    const d = state.detail;
    const u = d.user;
    const promote = u.role !== 'admin';
    const name = firstName(u);
    $('us-ro-title').textContent = promote ? T('us.ro.promote_title', { name }) : T('us.ro.demote_title', { name });
    $('us-ro-from').textContent = roleLabel(u.role);
    $('us-ro-from-text').textContent = promote ? T('us.ro.member_short') : T('us.ro.admin_short');
    $('us-ro-to').textContent = roleLabel(promote ? 'admin' : 'user');
    $('us-ro-to-text').textContent = promote ? T('us.ro.admin_short') : T('us.ro.member_short');
    const list = clear($('us-ro-list'));
    (promote ? ['us.ro.p1', 'us.ro.p2', 'us.ro.p3'] : ['us.ro.d1', 'us.ro.d2', 'us.ro.d3']).forEach((k) => list.appendChild(el('li', null, T(k, { name }))));
    show($('us-ro-pw'), promote);
    $('us-ro-password').value = promote ? genPassword() : '';
    $('us-ro-must').checked = true;
    const lock = lockReason(d);
    setError('us-ro-error', lock || '');
    $('us-ro-save').disabled = !!lock;
    openDlg('us-dlg-role');
  }
  $('us-ro-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = state.detail.user;
    const promote = u.role !== 'admin';
    const body = { role: promote ? 'admin' : 'user' };
    if (promote) { body.password = $('us-ro-password').value; body.mustChangePassword = $('us-ro-must').checked; }
    const btn = $('us-ro-save');
    window.btnLoading(btn);
    try {
      await call('POST', '/api/v1/users/' + u.id + '/role', body);
      window.btnReset(btn);
      closeDlg('us-dlg-role');
      toast(T('us.ro.done', { name: firstName(u), role: roleLabel(body.role) }));
      await afterChange();
    } catch (err) { window.btnReset(btn); setError('us-ro-error', errMsg(err)); }
  });

  // ── Delete ─────────────────────────────────────────────────────────
  let delUser = null;
  function effect(tone, title, text) {
    return el('li', { class: 'us-effect' }, [el('span', { class: 'us-dot ' + tone, 'aria-hidden': 'true' }), el('span', null, [el('b', null, title), text ? el('span', { class: 'us-effect-text' }, text) : null])]);
  }
  async function openDelete(u) {
    delUser = u;
    const name = nameOf(u);
    $('us-del-title').textContent = T('us.del.title', { name });
    $('us-del-confirm-label').textContent = T('us.del.confirm_label', { username: u.username });
    $('us-del-confirm').value = '';
    $('us-del-ok').disabled = true;
    $('us-del-disable').hidden = u.enabled !== 1;
    setError('us-del-error', '');
    const list = clear($('us-del-effects'));
    list.appendChild(el('li', { class: 'us-muted' }, T('common.loading')));
    openDlg('us-dlg-delete');
    try {
      const res = await call('GET', '/api/v1/users/' + u.id + '/delete-impact');
      const im = res.impact;
      clear(list);
      const devs = im.tokens.filter((t) => t.device);
      const apis = im.tokens.filter((t) => !t.device);
      const q = (arr) => arr.map((x) => '„' + x.name + '“').join(', ');
      if (devs.length) list.appendChild(effect('us-dot-crit', P('us.del.dev', devs.length), T('us.del.dev_text', { names: q(devs) })));
      if (apis.length) list.appendChild(effect('us-dot-crit', P('us.del.api', apis.length), T('us.del.api_text', { names: q(apis) })));
      if (im.peers.length) list.appendChild(effect('us-dot-warn', P('us.del.peer', im.peers.length), T('us.del.peer_text', { names: im.peers.map((p) => '„' + p.name + '“ (' + p.ip + ')').join(', ') })));
      const vis = im.routes.concat(im.rdp);
      const removed = vis.filter((r) => !r.onlyThisUser);
      const hidden = vis.filter((r) => r.onlyThisUser);
      if (removed.length) list.appendChild(effect('us-dot-warn', T('us.del.vis_title'), P('us.del.vis_text', removed.length, { name: firstName(u) })));
      if (hidden.length) list.appendChild(effect('us-dot-warn', T('us.del.hidden_title'), T('us.del.hidden_text', { name: firstName(u), names: q(hidden) })));
      if (!im.tokens.length && !im.peers.length && !vis.length) list.appendChild(effect('us-dot-off', T('us.del.nothing'), ''));
      list.appendChild(effect('us-dot-off', T('us.del.logs_title'), T('us.del.logs_text')));
    } catch (err) { clear(list); setError('us-del-error', errMsg(err)); }
  }
  $('us-del-confirm').addEventListener('input', () => { $('us-del-ok').disabled = !delUser || $('us-del-confirm').value.trim() !== delUser.username; });
  $('us-del-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!delUser || $('us-del-confirm').value.trim() !== delUser.username) return;
    const btn = $('us-del-ok');
    window.btnLoading(btn);
    try {
      await call('DELETE', '/api/v1/users/' + delUser.id);
      window.btnReset(btn);
      closeDlg('us-dlg-delete');
      toast(T('us.del.done', { name: nameOf(delUser) }));
      // The profile of a deleted user is gone: back to the list.
      if (PROFILE && state.selId === delUser.id) { window.location.assign('/users'); return; }
      await Promise.all([loadUsers(), loadOrphans()]);
    } catch (err) { window.btnReset(btn); btn.disabled = false; setError('us-del-error', errMsg(err)); }
  });
  $('us-del-disable').addEventListener('click', async () => {
    const u = delUser;
    closeDlg('us-dlg-delete');
    if (u) await toggleUser(u);
  });

  // ── Invite ─────────────────────────────────────────────────────────
  let invUser = null;
  function openInvite(u, preset, after) {
    invUser = u;
    const name = firstName(u);
    $('us-inv-title').textContent = T('us.inv.title', { name });
    $('us-inv-text').textContent = u.has_password && u.self_service_enabled ? T('us.inv.text_reset', { name }) : T('us.inv.text', { name });
    show($('us-inv-result'), false);
    setError('us-inv-error', '');
    $('us-inv-create').hidden = false;
    $('us-inv-close').textContent = T('common.cancel');
    const ov = openDlg('us-dlg-invite');
    ov._onClose = () => { afterChange(); if (after) after(); };
    if (preset) showInvite(preset);
  }
  function showInvite(res) {
    $('us-inv-link').value = res.link;
    $('us-inv-valid').textContent = T('us.inv.valid', { date: fmtDateTime(res.expiresAt) }) + ' ' + T('us.inv.once');
    $('us-inv-mail').textContent = res.emailed ? T('us.inv.mailed', { email: (res.user && res.user.email) || '' }) : T('us.inv.not_mailed');
    show($('us-inv-result'), true);
    $('us-inv-create').hidden = true;
    $('us-inv-close').textContent = T('common.done');
  }
  $('us-inv-create').addEventListener('click', async () => {
    const btn = $('us-inv-create');
    window.btnLoading(btn);
    try {
      const res = await call('POST', '/api/v1/users/' + invUser.id + '/invite', {});
      window.btnReset(btn);
      showInvite(res);
    } catch (err) { window.btnReset(btn); setError('us-inv-error', errMsg(err)); }
  });

  // ── Create user ────────────────────────────────────────────────────
  let cRole = 'user';
  function applyCreateRole() {
    page.ownerDocument.querySelectorAll('#us-dlg-create [data-role-pick]').forEach((b) => b.setAttribute('aria-pressed', b.getAttribute('data-role-pick') === cRole ? 'true' : 'false'));
    show($('us-c-admin'), cRole === 'admin');
    show($('us-c-member'), cRole === 'user');
    $('us-c-save').textContent = cRole === 'user' && $('us-c-setup').checked ? T('us.create.save_setup') : T('us.create.save');
  }
  function openCreate() {
    cRole = 'user';
    $('us-c-username').value = '';
    $('us-c-display').value = '';
    $('us-c-email').value = '';
    $('us-c-password').value = genPassword();
    $('us-c-mustchange').checked = true;
    $('us-c-setup').checked = true;
    $('us-c-self').checked = false;
    setError('us-c-error', '');
    applyCreateRole();
    openDlg('us-dlg-create');
  }
  page.ownerDocument.querySelectorAll('#us-dlg-create [data-role-pick]').forEach((b) => b.addEventListener('click', () => { cRole = b.getAttribute('data-role-pick'); applyCreateRole(); }));
  $('us-c-setup').addEventListener('change', applyCreateRole);
  $('us-c-pw-regen').addEventListener('click', () => { $('us-c-password').value = genPassword(); });
  $('us-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('us-c-error', '');
    const username = $('us-c-username').value.trim();
    if (!username) { setError('us-c-error', T('error.users.username_required')); $('us-c-username').focus(); return; }
    const body = { username, displayName: $('us-c-display').value.trim() || null, email: $('us-c-email').value.trim() || null, role: cRole };
    if (cRole === 'admin') { body.password = $('us-c-password').value; body.mustChangePassword = $('us-c-mustchange').checked; }
    const setup = cRole === 'user' && $('us-c-setup').checked;
    const self = cRole === 'user' && $('us-c-self').checked;
    const btn = $('us-c-save');
    window.btnLoading(btn);
    let created;
    try {
      created = (await call('POST', '/api/v1/users', body)).user;
    } catch (err) { window.btnReset(btn); applyCreateRole(); setError('us-c-error', errMsg(err)); return; }
    window.btnReset(btn);
    closeDlg('us-dlg-create');
    toast(T('us.create.done', { name: nameOf(created) }));
    await loadUsers();
    let invite = null;
    if (self) {
      try { invite = await call('POST', '/api/v1/users/' + created.id + '/invite', {}); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
    }
    // Setup code and invitation as before, then on to the new profile.
    const go = () => window.location.assign(profileHref(created.id, setup ? 'access' : 'overview'));
    const showInv = () => { if (invite) openInvite(userById(created.id) || created, invite, go); else go(); };
    if (setup) {
      $('us-wz-name').value = '';
      await openWizard({ ownerId: created.id, kind: 'device', after: showInv });
      $('us-wz-name').value = T('us.wz.name_first_device', { name: firstName(created) });
      await wzCreate();
    } else showInv();
  });

  // ── Edit profile (display name, e-mail, language) ──────────────────
  let pfUser = null;
  let pfLang = null;
  function openProfileEdit(u) {
    pfUser = u;
    $('us-pf-title').textContent = T('us.pf.title', { name: nameOf(u) });
    $('us-pf-text').textContent = T('us.pf.text', { username: u.username });
    $('us-pf-display').value = u.display_name || '';
    $('us-pf-email').value = u.email || '';
    $('us-pf-language').value = u.language === 'en' ? 'en' : 'de';
    pfLang = $('us-pf-language').value;
    setError('us-pf-error', '');
    openDlg('us-dlg-profile');
  }
  $('us-pf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('us-pf-error', '');
    const body = { displayName: $('us-pf-display').value.trim(), email: $('us-pf-email').value.trim() || null };
    if ($('us-pf-language').value !== pfLang) body.language = $('us-pf-language').value;
    const btn = $('us-pf-save');
    window.btnLoading(btn);
    try {
      await call('PATCH', '/api/v1/users/' + pfUser.id, body);
      window.btnReset(btn);
      closeDlg('us-dlg-profile');
      toast(T('us.saved'));
      await afterChange();
    } catch (err) { window.btnReset(btn); setError('us-pf-error', errMsg(err)); }
  });

  // ── Page wiring ────────────────────────────────────────────────────
  function bindList() {
    $('us-btn-add').addEventListener('click', openCreate);
    $('us-btn-roles').addEventListener('click', () => openDlg('us-dlg-roles'));
    $('us-search').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });
    $('us-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      state.filter = b.getAttribute('data-filter');
      renderList();
    });
  }

  function bindProfile() {
    const user = () => state.detail && state.detail.user;
    $('up-edit').addEventListener('click', () => { if (user()) openProfileEdit(user()); });
    $('up-add-device').addEventListener('click', () => { if (user()) openWizard({ ownerId: user().id, kind: 'device' }); });
    $('up-toggle').addEventListener('click', () => { if (user()) toggleUser(user()); });

    // "Mehr": password, role, invitation, delete
    const more = $('up-more');
    const menu = $('up-menu');
    const items = () => Array.from(menu.querySelectorAll('.up-menu-item')).filter((i) => !i.hidden && !i.disabled);
    function setMenu(open, focusFirst) {
      menu.hidden = !open;
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && focusFirst) { const f = items()[0]; if (f) f.focus(); }
    }
    more.addEventListener('click', () => setMenu(menu.hidden, false));
    more.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu(true, true); }
    });
    doc.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.up-more')) setMenu(false); });
    menu.parentNode.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(false); more.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(doc.activeElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
    });
    const ACTIONS = {
      'up-act-password': (u) => openPassword(u),
      'up-act-role': () => openRole(),
      'up-act-invite': (u) => openInvite(u),
      'up-act-delete': (u) => openDelete(u),
    };
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.up-menu-item');
      if (!item) return;
      // The dialog gives the focus back to "Mehr", not to the hidden item.
      setMenu(false);
      more.focus();
      const run = ACTIONS[item.id];
      if (run && user() && !item.disabled) run(user());
    });

    $('us-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.getAttribute('data-tab')); });
    $('us-tabs').addEventListener('keydown', (e) => {
      const i = TABS.indexOf(state.tab);
      let n = null;
      if (e.key === 'ArrowRight') n = TABS[(i + 1) % TABS.length];
      else if (e.key === 'ArrowLeft') n = TABS[(i + TABS.length - 1) % TABS.length];
      else if (e.key === 'Home') n = TABS[0];
      else if (e.key === 'End') n = TABS[TABS.length - 1];
      if (n) { e.preventDefault(); selectTab(n, true); }
    });
  }

  async function init() {
    if (PROFILE) {
      bindProfile();
      writeUrl();
      renderTabs();
      await Promise.all([loadUsers(), refreshDetail()]);
      return;
    }
    bindList();
    await Promise.all([loadUsers(), loadOrphans()]);
  }
  init();
})();
