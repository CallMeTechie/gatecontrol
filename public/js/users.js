'use strict';

// Users page (redesign): list + detail panel (Übersicht, Geräte & Zugänge,
// "Was sieht …?", Anmeldung & Sicherheit, Aktivität), role comparison,
// create user, the access wizard (device = setup code that creates and
// assigns a peer, script = token code or the key shown once), edit access,
// new password, change role, delete, invite to "Mein Bereich", owner-less
// accesses. Strings: #us-i18n (us.*, users.mb.*, error.*, enrollment.*,
// common.*). No innerHTML — every node is built with el()/textContent.
// Dialogs keep typed input: Escape, × and the backdrop ask before throwing
// away a changed form.
(function () {
  const doc = document;
  const D = window.GCDialog;
  const page = doc.getElementById('us-page');
  if (!page) return;

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
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
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
    home: 'M3 12l9-8 9 8M5 10v10h14V10',
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
  const state = {
    users: [], filter: 'all', q: '', selId: null, tab: 'overview',
    detail: null, vis: null, sessions: null, activity: null, orphans: [], mb: { licensed: false, mode: 'off' },
    self: Number(CTX.self) || null,
  };
  const TABS = ['overview', 'access', 'see', 'security', 'activity'];

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

  function avatar(u, lg) {
    return el('span', { class: 'us-avatar us-tone-' + roleTone(u.role) + (lg ? ' us-avatar-lg' : '') + (u.enabled === 1 ? '' : ' us-avatar-off'), 'aria-hidden': 'true' }, initials(u));
  }
  function roleChips(u) {
    return [el('span', { class: 'us-chip us-chip-' + roleTone(u.role) }, roleLabel(u.role)),
      u.enabled === 1 ? null : el('span', { class: 'us-chip us-chip-crit' }, T('us.disabled'))];
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
      const open = () => openUser(u.id, null);
      const isSel = u.id === state.selId;
      const who = el('button', { type: 'button', class: 'us-who', on: { click: open } }, [
        avatar(u),
        el('span', { class: 'us-who-text' }, [
          el('span', { class: 'us-who-name' }, [nameOf(u), u.id === state.self ? el('span', { class: 'us-you' }, T('us.you')) : null]),
          el('span', { class: 'us-who-sub' }, subLine(u)),
        ]),
      ]);
      const last = lastActive(u);
      tbody.appendChild(el('tr', { class: 'us-row' + (isSel ? ' is-selected' : '') + (u.enabled === 1 ? '' : ' is-off'), 'data-user-id': String(u.id), 'aria-current': isSel ? 'true' : null }, [
        el('td', { class: 'us-col-user' }, who),
        el('td', { class: 'us-col-role' }, roleChips(u)),
        el('td', { class: 'us-col-auth' }, el('span', { class: 'us-auth' }, [el('span', { class: 'us-dot ' + (a.ok ? 'us-dot-good' : 'us-dot-warn'), 'aria-hidden': 'true' }), a.text])),
        el('td', { class: 'us-col-dev' }, devicesText(u.peer_count)),
        el('td', { class: 'us-col-last us-muted' }, last ? rel(last) : T('us.never_active')),
        el('td', { class: 'us-col-act' }, el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', on: { click: open }, 'aria-label': T('us.open_user', { name: nameOf(u) }) }, T('us.open'))),
      ]));
      cards.appendChild(el('li', { class: 'us-card' + (isSel ? ' is-selected' : '') + (u.enabled === 1 ? '' : ' is-off'), 'data-user-id': String(u.id) }, [
        el('button', { type: 'button', class: 'us-card-btn', on: { click: open } }, [
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

  async function loadUsers() {
    try {
      const data = await call('GET', '/api/v1/users');
      state.users = data.users || [];
      if (data.current_user_id) state.self = data.current_user_id;
      renderList();
    } catch (err) {
      const tbody = clear($('us-tbody'));
      tbody.appendChild(el('tr', null, el('td', { colspan: '6', class: 'us-muted us-center' }, T('error.users.list'))));
    }
  }

  // ── Owner-less accesses ────────────────────────────────────────────
  async function loadOrphans() {
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
          if (state.selId) refreshDetail();
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
  $('us-orphans-assign').addEventListener('click', () => { renderOrphanDialog(); openDlg('us-dlg-orphans'); });

  // ── Detail ─────────────────────────────────────────────────────────
  function writeUrl() {
    try {
      const u = new URL(window.location.href);
      if (state.selId) { u.searchParams.set('user', String(state.selId)); u.searchParams.set('tab', state.tab); }
      else { u.searchParams.delete('user'); u.searchParams.delete('tab'); }
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (_) { /* old browser */ }
  }

  async function openUser(id, tab, opts) {
    const changed = state.selId !== id;
    state.selId = id;
    if (tab && TABS.indexOf(tab) >= 0) state.tab = tab;
    else if (changed && !(opts && opts.keepTab)) state.tab = 'overview';
    if (changed) { state.detail = null; state.vis = null; state.sessions = null; state.activity = null; }
    writeUrl();
    renderList();
    const aside = $('us-detail');
    aside.hidden = false;
    $('us-layout').classList.add('has-detail');
    await refreshDetail();
    if (changed && window.matchMedia && window.matchMedia('(max-width: 1279px)').matches) {
      try { aside.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { aside.scrollIntoView(); }
    }
  }
  function closeDetail() {
    state.selId = null;
    state.detail = null;
    $('us-detail').hidden = true;
    $('us-layout').classList.remove('has-detail');
    writeUrl();
    renderList();
  }
  $('us-d-close').addEventListener('click', closeDetail);

  async function refreshDetail() {
    const id = state.selId;
    if (!id) return;
    try {
      const [detail, vis] = await Promise.all([
        call('GET', '/api/v1/users/' + id),
        call('GET', '/api/v1/users/' + id + '/visibility').catch(() => null),
      ]);
      if (state.selId !== id) return;
      state.detail = detail;
      state.vis = vis;
      if (detail.machine_binding) state.mb = detail.machine_binding;
      renderDetail();
    } catch (err) {
      if (state.selId !== id) return;
      closeDetail();
      D.alert({ message: T('error.users.get') + ': ' + errMsg(err), danger: true });
    }
  }

  function renderDetail() {
    const d = state.detail;
    if (!d) return;
    const u = d.user;
    const av = $('us-d-avatar');
    av.className = 'us-avatar us-avatar-lg us-tone-' + roleTone(u.role) + (u.enabled === 1 ? '' : ' us-avatar-off');
    av.textContent = initials(u);
    $('us-d-name').textContent = nameOf(u);
    const chip = $('us-d-role');
    chip.className = 'us-chip us-chip-' + roleTone(u.role);
    chip.textContent = roleLabel(u.role);
    show($('us-d-off'), u.enabled !== 1);
    $('us-d-sub').textContent = subLine(u) + ' · ' + T('us.detail.created', { date: fmtDate(u.created_at) });
    TABS.forEach((t) => {
      const b = $('us-tab-' + t);
      if (t === 'see') b.textContent = T('us.tab.see', { name: firstName(u) });
      const on = t === state.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
      $('us-panel-' + t).hidden = !on;
    });
    renderPanel();
  }

  function renderPanel() {
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
    renderDetail();
    if (focus) $('us-tab-' + t).focus();
  }
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
  function renderOverview(panel) {
    const d = state.detail;
    const u = d.user;
    const isAdmin = u.role === 'admin';
    const devices = d.tokens.filter(isDevice);
    const apis = d.tokens.filter((t) => !isDevice(t));
    const online = devices.filter((t) => t.peer && t.peer.online).length;
    const lastTok = d.tokens.reduce((m, t) => newer(m, t.last_used_at), null);
    const vis = state.vis;
    const tiles = [
      [T('us.tile.devices'), String(devices.length), T('us.tile.devices_hint', { count: online })],
      [T('us.tile.apis'), String(apis.length), T('us.tile.apis_hint')],
      isAdmin
        ? [T('us.tile.last_login'), u.last_login_at ? rel(u.last_login_at) : T('us.never'), T('us.tile.last_login_hint')]
        : [T('us.tile.last_active'), lastTok ? rel(lastTok) : T('us.never'), T('us.tile.last_active_hint')],
      [T('us.tile.services'), vis ? String(vis.services.visible.length) : '…', vis ? T('us.tile.services_hint', { total: vis.services.total }) : ''],
    ];
    panel.appendChild(el('div', { class: 'us-tiles' }, tiles.map((t) => el('div', { class: 'us-tile' }, [
      el('div', { class: 'us-tile-label' }, t[0]), el('div', { class: 'us-tile-value' }, t[1]), el('div', { class: 'us-tile-hint' }, t[2]),
    ]))));

    const lock = lockReason(d);
    const roleBtn = el('button', { type: 'button', class: 'btn btn-sm us-btn-chip', disabled: !!lock, on: { click: () => openRole() } }, T('us.role.change'));
    const roleText = isAdmin ? T('us.role.admin_long') : (u.self_service_enabled ? T('us.role.member_self_long') : T('us.role.member_long'));
    panel.appendChild(el('div', { class: 'us-box us-rolebox' }, [
      el('div', { class: 'us-rolebox-head' }, [el('b', null, T('us.role.current', { role: roleLabel(u.role) })), roleBtn]),
      el('div', { class: 'us-muted us-small' }, roleText),
      lock ? el('div', { class: 'us-hint' }, lock) : null,
    ]));

    // Display name + e-mail
    const dn = el('input', { type: 'text', class: 'form-input', maxlength: '100', value: u.display_name || '', id: 'us-o-display' });
    const em = el('input', { type: 'email', class: 'form-input', maxlength: '255', value: u.email || '', id: 'us-o-email' });
    const save = el('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, T('common.save'));
    const err = el('div', { class: 'us-error', role: 'alert', hidden: true });
    const form = el('form', { class: 'us-profile', novalidate: true }, [
      el('div', { class: 'us-grid2' }, [
        el('label', { class: 'us-field', for: 'us-o-display' }, [el('span', { class: 'us-label' }, T('us.display_name')), dn]),
        el('label', { class: 'us-field', for: 'us-o-email' }, [el('span', { class: 'us-label' }, T('us.email')), em]),
      ]),
      el('div', { class: 'us-profile-foot' }, [err, save]),
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      window.btnLoading(save);
      try {
        await call('PATCH', '/api/v1/users/' + u.id, { displayName: dn.value.trim(), email: em.value.trim() || null });
        toast(T('us.saved'));
        await loadUsers();
        await refreshDetail();
      } catch (ex) { err.textContent = errMsg(ex); err.hidden = false; window.btnReset(save); }
    });
    panel.appendChild(form);

    // Danger zone
    const off = u.enabled !== 1;
    const toggleBtn = el('button', { type: 'button', class: 'btn btn-ghost', disabled: !!lock, on: { click: () => toggleUser(u) } }, off ? T('us.enable') : T('us.disable'));
    const delBtn = el('button', { type: 'button', class: 'btn btn-danger', disabled: !!lock, on: { click: () => openDelete(u) } }, T('us.delete'));
    panel.appendChild(el('div', { class: 'us-danger' }, [
      el('div', { class: 'us-danger-title' }, T('us.danger')),
      el('div', { class: 'us-danger-row' }, [toggleBtn, delBtn, lock ? el('span', { class: 'us-hint' }, lock) : null]),
    ]));
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
  }

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
    const names = (e.names || []).length ? e.names.join(', ') : firstName(user);
    return { why: 'pick', reason: T('us.see.why_picked', { names }) };
  }
  function renderSee(panel) {
    const v = state.vis;
    const u = state.detail.user;
    if (!v) { panel.appendChild(el('div', { class: 'us-muted' }, T('error.users.get'))); return; }
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
    // Portal
    const kindLabel = { midea: T('us.see.kind_midea'), smarthome: T('us.see.kind_smarthome'), skoda: T('us.see.kind_skoda') };
    const kindHref = { midea: '/midea', smarthome: '/smarthome', skoda: '/skoda' };
    const portalItems = v.portal.map((p) => ({ name: p.name, detail: kindLabel[p.kind], why: 'own', reason: T('us.see.why_owner', { name: firstName(u) }) }));
    const firstKind = v.portal.length ? v.portal[0].kind : 'smarthome';
    if (!portalItems.length) portalItems.push({ name: isAdmin ? T('us.see.portal_admin') : T('us.see.portal_none'), tone: isAdmin ? 'us-dot-good' : 'us-dot-off', why: isAdmin ? 'own' : 'all', reason: isAdmin ? T('us.see.why_admin') : '' });
    panel.appendChild(seeGroup(T('us.see.portal'), v.portal.length ? P('us.see.portal_count', v.portal.length) : '', ICON.home,
      { label: T('us.see.link_owner'), href: kindHref[firstKind] }, portalItems));
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
    } catch (err) { clear(list).appendChild(el('li', { class: 'us-error' }, errMsg(err))); }
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
      el('div', { class: 'us-switchrow-text' }, [el('b', null, T('us.sec.self_enroll')), el('div', { class: 'us-hint' }, T('us.sec.self_enroll_text', { name }))]),
      sw,
    ]));
  }

  async function reset2fa(u) {
    const ok = await D.confirm({ title: T('us.sec.reset_title'), message: T('us.sec.reset_text', { name: nameOf(u) }), okLabel: T('us.sec.reset_ok'), danger: true });
    if (!ok) return;
    try { await call('DELETE', '/api/v1/users/' + u.id + '/2fa'); toast(T('us.sec.reset_done')); await afterChange(); } catch (err) { D.alert({ message: errMsg(err), danger: true }); }
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
    } catch (err) { clear(list).appendChild(el('li', { class: 'us-error' }, errMsg(err))); }
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
  const ed = { token: null, owner: null, ownerId: null, st: null, stChanged: false, stEditor: null };

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
    setError('us-ed-error', '');
    openDlg('us-dlg-edit');
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
      const portal = im.portal.midea + im.portal.smarthome + im.portal.skoda;
      if (portal) list.appendChild(effect('us-dot-warn', T('us.del.portal_title'), P('us.del.portal_text', portal)));
      if (!im.tokens.length && !im.peers.length && !vis.length && !portal) list.appendChild(effect('us-dot-off', T('us.del.nothing'), ''));
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
      if (state.selId === delUser.id) closeDetail();
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
  function openInvite(u, preset) {
    invUser = u;
    const name = firstName(u);
    $('us-inv-title').textContent = T('us.inv.title', { name });
    $('us-inv-text').textContent = u.has_password && u.self_service_enabled ? T('us.inv.text_reset', { name }) : T('us.inv.text', { name });
    show($('us-inv-result'), false);
    setError('us-inv-error', '');
    $('us-inv-create').hidden = false;
    $('us-inv-close').textContent = T('common.cancel');
    const ov = openDlg('us-dlg-invite');
    ov._onClose = () => afterChange();
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
    await openUser(created.id, setup ? 'access' : 'overview');
    const showInv = () => { if (invite) openInvite(userById(created.id) || created, invite); };
    if (setup) {
      $('us-wz-name').value = '';
      await openWizard({ ownerId: created.id, kind: 'device', after: showInv });
      $('us-wz-name').value = T('us.wz.name_first_device', { name: firstName(created) });
      await wzCreate();
    } else showInv();
  });

  // ── Page wiring ────────────────────────────────────────────────────
  $('us-btn-add').addEventListener('click', openCreate);
  $('us-btn-roles').addEventListener('click', () => openDlg('us-dlg-roles'));
  $('us-search').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });
  $('us-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.getAttribute('data-filter');
    renderList();
  });

  async function init() {
    await Promise.all([loadUsers(), loadOrphans()]);
    let id = null;
    let tab = null;
    try {
      const sp = new URL(window.location.href).searchParams;
      id = Number.parseInt(sp.get('user'), 10);
      tab = sp.get('tab');
    } catch (_) { id = null; }
    if (id && userById(id)) await openUser(id, TABS.indexOf(tab) >= 0 ? tab : 'overview');
  }
  init();
})();
