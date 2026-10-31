'use strict';

// The plugin area under Einstellungen › Plugins (templates/aurora/pages/plugins.njk,
// docs/plugins.md "Plugin area"; layout, wording and order follow the
// artboards of the mockup "Plugins – UI & UX Konzept"). One script for every
// view of /settings/plugins:
//
//   installed    Meine Plugins: state tiles, "Braucht deine Aufmerksamkeit",
//                search / filter / list or tiles grouped by area, "Passt zu
//                deinem Server"; without plugins: the first-run page
//   catalog      the catalogue as a store: areas and filters in the side
//                column, search, sort, highlight, "Noch nicht bei dir", cards
//   catalogItem  one catalogue plugin: what it adds, what it may do, versions,
//                install panel
//   manage       one installed plugin: overview, settings, permissions,
//                licence, log, versions; restart, switch, update, uninstall
//   updates      updates with release notes, "Alle aktualisieren", automatic
//                updates, recently updated
//   licenses     licence key without naming the plugin, all licences
//   security     upload with preview, the rules, catalogue source
//   storage      storage targets: folder, NAS (SMB, WebDAV), S3, Google Drive, OneDrive — add, check, edit
//   cloud        Cloud-Konten: the OAuth apps for Google and Microsoft, the people's connections
//   log          installs, updates and uninstalls
//
// Installing and updating — from the catalogue or an uploaded file — is one
// dialog: Prüfen (checks, permissions, licence key) → Installieren → fertig.
// DOM is built with GCDialog.el / textContent only — no HTML strings.
(function () {
  const root = document.getElementById('pgx');
  if (!root) return;
  const P = window.GCPluginsUI;
  const D = window.GCDialog;
  const el = D.el;
  const lang = (window.GC && window.GC.language) === 'en' ? 'en' : 'de';
  const API = '/api/v1/plugins';
  const CAT_API = '/api/v1/plugin-catalog';
  const VIEW = root.getAttribute('data-view') || 'installed';
  const TARGET = root.getAttribute('data-target') || '';
  const CATALOG_ON = root.getAttribute('data-catalog') === '1';
  // the area's address (src/routes/plugins.js AREA_BASE) — fixed, never read from the page
  const B = '/settings/plugins';
  const SHOP_URL = 'https://callmetechie.de/products/gatecontrol/pricing';
  const enc = encodeURIComponent;
  const U = {
    mine: B, catalog: B + '/catalog', updates: B + '/updates', licenses: B + '/licenses', security: B + '/security', storage: B + '/storage', cloud: B + '/cloud', log: B + '/log',
    item: (id, q) => B + '/catalog/' + enc(id) + (q ? '?' + q : ''),
    manage: (id, tab) => B + '/manage/' + enc(id) + (tab ? '?tab=' + enc(tab) : ''),
    cat: (c) => B + '/catalog?cat=' + enc(c),
  };

  let STR = {};
  try { STR = JSON.parse(document.getElementById('pgx-i18n').textContent || '{}'); } catch (_) { STR = {}; }
  function t(key, params) {
    let s = STR[key] != null ? STR[key] : ((window.GC && window.GC.t && window.GC.t[key] != null) ? window.GC.t[key] : key);
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  const $ = (id) => document.getElementById(id);
  const main = $('pgx-view');
  const busy = $('pgx-main');
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  const query = new URLSearchParams(location.search);

  const NS = 'http://www.w3.org/2000/svg';
  const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/;
  /** An inline 24×24 stroke icon: a path, or the name of a detail symbol. */
  function icon(d, size, width) {
    const svg = document.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', String(size || 20)], ['height', String(size || 20)], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', String(width || 2)], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    const p = document.createElementNS(NS, 'path');
    const named = d && Object.prototype.hasOwnProperty.call(P.DETAIL_ICON_PATHS, d) ? P.DETAIL_ICON_PATHS[d] : d;
    p.setAttribute('d', PATH_RE.test(named || '') ? named : P.ICON_PATHS.puzzle);
    svg.appendChild(p);
    return svg;
  }
  const I = {
    check: 'M5 12l5 5 9-10', x: 'M6 6l12 12M18 6L6 18', back: 'M15 18l-6-6 6-6', next: 'M9 6l6 6-6 6', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
    upload: 'M12 20V9M7 13l5-5 5 5M5 4h14', download: 'M12 4v11M7 10l5 5 5-5M5 20h14', plus: 'M12 5v14M5 12h14', refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
    shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', shieldOk: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4',
    key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 12l9-9M16 7l3 3',
    alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16.5h.01', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', more: 'M12 5h.01M12 12h.01M12 19h.01',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4', bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2', perms: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  };

  async function req(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      opts.headers['X-CSRF-Token'] = window.GC.csrfToken;
      if (body instanceof ArrayBuffer) { opts.headers['Content-Type'] = 'application/octet-stream'; opts.body = body; } else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    }
    try {
      const res = await fetch(url, opts);
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (data && data.csrfToken && window.GC) window.GC.csrfToken = data.csrfToken;
      return data || { ok: false, error: t('plugins.err.generic') };
    } catch (_) {
      return { ok: false, error: t('plugins.err.generic') };
    }
  }

  // ── State ──
  let inst = { loaded: false, plugins: [], allowUnsigned: false, backupMedia: false, autoUpdate: 'off', catalogCheck: true, serverVersion: '' };
  let cat = { loaded: false, available: false, plugins: [], error: '', fetchedAt: null, source: null, serverVersion: '' };
  let contrib = {};
  // an installed plugin a catalogue plugin replaces (new id) maps to that one
  function catItem(id) { return cat.plugins.find((x) => x.id === id) || cat.plugins.find((x) => x.replaces && x.replaces.id === id) || null; }
  function installedOf(id) { return inst.plugins.find((x) => x.id === id) || null; }
  function metaOf(id) { return catItem(id) || { category: 'other', icon: null, summary: '', keywords: [], related: [] }; }

  async function loadInstalled() {
    const r = await req('GET', API);
    if (!r.ok) { showError(r.error); return false; }
    inst = { loaded: true, plugins: r.plugins || [], allowUnsigned: !!r.allowUnsigned, backupMedia: !!r.backupMedia, autoUpdate: r.autoUpdate || 'off',
      catalogCheck: r.catalogCheck !== false, serverVersion: r.serverVersion || '' };
    return true;
  }

  async function loadCatalog(refresh) {
    if (!CATALOG_ON) { cat = { loaded: true, available: false, plugins: [], error: '', fetchedAt: null, source: null, disabled: true }; return; }
    const r = await req('GET', CAT_API + (refresh ? '?refresh=1' : ''));
    if (r.ok && r.enabled && r.available) {
      cat = { loaded: true, available: true, plugins: r.plugins || [], error: '', fetchedAt: r.fetchedAt || null, source: r.source || null, serverVersion: r.serverVersion || '' };
    } else {
      const code = r.code || '';
      cat = { loaded: true, available: false, plugins: [], fetchedAt: null, source: r.source || null, disabled: r.ok && r.enabled === false,
        error: code === 'catalog_invalid' ? t('plugins.cat.invalid') : (r.error && !code ? r.error : t('plugins.cat.unreachable')) };
    }
  }

  /** Quick actions and widgets per plugin (asks the running plugins — after the first paint). */
  async function loadContrib() {
    const r = await req('GET', API + '/contributions');
    contrib = r.ok && r.counts ? r.counts : {};
    return contrib;
  }

  function showError(msg) {
    const e = $('pgx-err');
    e.textContent = msg || t('plugins.err.generic');
    e.hidden = false;
  }

  // ── Building blocks (mockup classes, pgx- prefixed) ──
  const TONES = { good: 'good', warn: 'warn', crit: 'crit', info: 'blue', blue: 'blue', off: 'mute', mute: 'mute', new: 'new' };
  function pill(text, tone, dot, attrs) {
    return el('span', Object.assign({ class: 'pgx-pill', 'data-tone': TONES[tone] || 'mute' }, attrs || {}), [dot ? el('span', { class: 'pgx-d', 'aria-hidden': 'true' }) : null, text]);
  }
  const ICON_SIZE = { sm: 18, md: 22, md48: 24, lg: 28, xl: 34, xxl: 44, hero: 56 };
  function plugIcon(id, installed, size) {
    const meta = metaOf(id);
    return el('span', { class: 'pgx-ic', 'data-size': size || 'md', 'data-cat': P.categoryOf(meta), 'aria-hidden': 'true' }, [icon(P.iconPath(meta, installed), ICON_SIZE[size || 'md'])]);
  }
  function sic(name, cat) { return el('span', { class: 'pgx-sic', 'data-cat': cat || null, 'aria-hidden': 'true' }, [icon(name || 'page', 17)]); }
  function btn(text, o) {
    const opt = o || {};
    const cls = 'pgx-btn' + (opt.primary ? ' pgx-btn-pri' : '') + (opt.danger ? ' pgx-btn-danger' : '') + (opt.small ? ' pgx-btn-sm' : '') + (opt.large ? ' pgx-btn-lg' : '')
      + (opt.ghost ? ' pgx-btn-ghost' : '') + (opt.cls ? ' ' + opt.cls : '');
    const kids = [opt.icon ? icon(opt.icon, opt.small ? 16 : 17) : null, text];
    if (opt.href) return el('a', { class: cls, href: opt.href, id: opt.id || null, target: opt.external ? '_blank' : null, rel: opt.external ? 'noopener noreferrer' : null, 'aria-label': opt.label || null }, kids);
    return el('button', { type: 'button', class: cls, id: opt.id || null, disabled: !!opt.disabled, 'data-action': opt.action || null, 'aria-label': opt.label || null, on: opt.onClick ? { click: opt.onClick } : null }, kids);
  }
  function sw(on, label, onClick, id) {
    return el('button', { type: 'button', class: 'pgx-sw', role: 'switch', id: id || null, 'aria-checked': on ? 'true' : 'false', 'aria-label': label, on: { click: onClick } },
      [el('span', { 'aria-hidden': 'true' })]);
  }
  function card(kids, attrs, cls) { return el('section', Object.assign({ class: 'pgx-card' + (cls ? ' ' + cls : '') }, attrs || {}), kids); }
  function h2(text, id, cls) { return el('h2', { class: 'pgx-h2' + (cls ? ' ' + cls : ''), id: id || null, text }); }
  function lbl(text, attrs) { return el('span', Object.assign({ class: 'pgx-lbl' }, attrs || {}), [text]); }
  function link(text, href, attrs) { return el('a', Object.assign({ class: 'pgx-a', href }, attrs || {}), [text]); }
  function linkBtn(text, onClick, attrs) { return el('button', Object.assign({ type: 'button', class: 'pgx-a', on: { click: onClick } }, attrs || {}), [text]); }
  /** Page title (h2 styled as the mockup's h1 — the topbar holds the page's h1). */
  function pageHead(title, sub, actions, eyebrow) {
    return el('div', { class: 'pgx-ph' }, [
      el('div', { class: 'pgx-ph-t' }, [eyebrow ? lbl(eyebrow, { class: 'pgx-lbl pgx-eyebrow' }) : null, el('h2', { class: 'pgx-h1', id: 'pgx-title', text: title }),
        sub ? el('p', { class: 'pgx-sub' }, Array.isArray(sub) ? sub : [sub]) : null]),
      actions && actions.filter(Boolean).length ? el('div', { class: 'pgx-ph-a' }, actions.filter(Boolean)) : null,
    ]);
  }
  function kv(rows) {
    return el('div', { class: 'pgx-kvs' }, rows.filter(Boolean).map((r) => el('div', { class: 'pgx-kv' }, [el('span', { text: r[0] }),
      el('span', { class: r[2] ? 'pgx-mono' : null }, Array.isArray(r[1]) ? r[1] : [r[1] == null || r[1] === '' ? '—' : String(r[1])])])));
  }
  function catName(c) { return t('plugins.x.cat.' + c); }
  /** A GateControl version range for people: ">=1.154.0" → "≥ 1.154". */
  function rng(r) { return String(r || '').replace(/>=\s*/g, '≥ ').replace(/(\d+\.\d+)\.0\b/g, '$1'); }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(typeof iso === 'number' ? iso : String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso)) || String(iso).includes('T') ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
  }
  function fmtTime(ms) {
    try { return new Date(ms).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function fmtDay(iso) {
    const d = new Date(String(iso || '').replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit' }) + (lang === 'en' ? '' : '.'); } catch (_) { return ''; }
  }
  function ago(iso) {
    const ms = Date.now() - (Date.parse(iso || '') || 0);
    if (!iso || ms < 0) return '';
    const min = Math.round(ms / 60000);
    if (min < 1) return t('plugins.x.ago_now');
    if (min < 60) return t('plugins.x.ago_min', { n: min });
    const h = Math.round(min / 60);
    if (h < 48) return t('plugins.x.ago_h', { n: h });
    return t('plugins.x.ago_d', { n: Math.round(h / 24) });
  }
  /** Release notes as a list (CHANGELOG markdown, plugins-ui.js noteLines). */
  function notesBlock(md, max) {
    const lines = P.noteLines(md, max);
    const box = el('div', { class: 'pgx-notes' });
    let list = null;
    lines.forEach((ln) => {
      if (ln.kind === 'li') {
        if (!list) { list = el('ul'); box.appendChild(list); }
        list.appendChild(el('li', { 'data-level': String(ln.level), text: ln.text }));
      } else { list = null; box.appendChild(el('p', { text: ln.text })); }
    });
    if (!lines.length) box.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.x.no_notes') }));
    return box;
  }
  function summaryOf(p) {
    const m = catItem(p.id);
    return (m && m.summary) || p.description || '';
  }
  function noteOf(p) {
    if (p.status === 'crashed') return t('plugins.x.crashed_short', { error: (p.process && p.process.lastError) || t('plugins.reason.crashed') });
    if (p.status === 'blocked') return t('plugins.reason.' + (p.reason || 'broken'));
    return summaryOf(p);
  }

  function updateNav() {
    const set = (id, n, tone) => {
      [$('pgx-count-' + id), $('pgx-mcount-' + id)].forEach((e) => {
        if (!e) return;
        e.hidden = !n;
        e.textContent = n ? String(n) : '';
        e.setAttribute('data-tone', tone || 'mute');
      });
    };
    set('installed', inst.loaded ? inst.plugins.length : 0, 'plain');
    if (cat.available) set('catalog', cat.plugins.length, 'plain');
    set('updates', cat.plugins.filter((x) => x.state === 'update').length, 'blue');
    set('licenses', inst.plugins.filter((p) => p.license && p.license.required && !['valid', 'not_required'].includes(p.license.state)).length, 'warn');
  }

  function done() { busy.setAttribute('aria-busy', 'false'); updateNav(); }

  // ── Actions ──
  async function setEnabled(p, on) {
    const r = await req('POST', API + '/' + enc(p.id) + (on ? '/enable' : '/disable'), {});
    if (!r.ok) { toast(r.error, 'error'); return false; }
    toast(t(on ? 'plugins.toast.enabled' : 'plugins.toast.disabled', { name: p.name }));
    return true;
  }

  async function restart(p) {
    const r = await req('POST', API + '/' + enc(p.id) + '/restart', {});
    if (!r.ok) { toast(r.error, 'error'); return false; }
    toast(t('plugins.x.restarted', { name: p.name }));
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // Install / update dialog (catalogue or uploaded file)
  // ════════════════════════════════════════════════════════════

  /** A GCDialog in the mockup's look: own header in the body, the × top right. */
  function dlg(title, width) {
    const d = D.dialog({ title, wide: true });
    const box = d.overlay.firstChild;
    box.classList.add('pgx-dlg');
    if (width) box.setAttribute('data-w', width);
    return d;
  }

  /** Catalogue: the server downloads, checks the sha256 and inspects; then the dialog. */
  async function installFromCatalog(item, button) {
    if (!item || !item.latest) return null;
    const label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = t('plugins.cat.downloading'); }
    const r = await req('POST', CAT_API + '/install', { id: item.id, version: item.latest.version });
    if (button) { button.disabled = false; button.textContent = label; }
    if (!r.ok && !r.checks) { toast(r.error || t('plugins.err.generic'), 'error'); return null; }
    return installDialog(r, { name: item.id + '-' + item.latest.version + '.gcplugin', size: r.size || item.latest.size }, item);
  }

  async function uploadFile(file) {
    if (!file) return null;
    if (file.size > P.MAX_PACKAGE_BYTES) { toast(t('plugins.err.package_too_large'), 'error'); return null; }
    const r = await req('POST', API + '/inspect', await file.arrayBuffer());
    if (!r.ok && !r.checks) { toast(r.error || t('plugins.err.generic'), 'error'); return null; }
    return { info: r, file: { name: file.name, size: file.size } };
  }

  /**
   * "Das Plugin darf": the sensitive permissions one by one (amber), the
   * usual ones in one line that opens to the full list. With `existing`
   * (an update): what changed against the installed version.
   */
  function permRowsBox(perm, existing) {
    const sensKeys = P.sensitivePerms(perm);
    const sens = sensKeys.map((k) => t(k));
    const box = el('div', { class: 'pgx-prs' });
    const row = (r, s, change) => el('div', { class: 'pgx-pr' + (s ? ' pgx-pr-s' : ''), 'data-change': change || null, 'data-sensitive': s ? '1' : null }, [
      icon(s ? I.shield : I.perms, 19), el('span', { class: 'pgx-t' }, [el('b', null, [r.label, change ? ' ' : null, change ? pill(t('plugins.perm.diff_' + change), change === 'removed' ? 'good' : 'warn') : null]),
        el('small', { class: change === 'removed' ? 'pgx-gone' : null, text: r.value }), r.old ? el('small', { text: t('plugins.perm.diff_before', { value: r.old }) }) : null]),
    ]);
    if (existing && existing.permissions) {
      const diff = P.permDiff(perm, existing.permissions, t);
      box.appendChild(el('p', { class: 'pgx-note' + (diff.changed ? ' pgx-note-warn' : ''), role: 'note', id: 'pgx-perm-diff', 'data-changed': String(diff.changed),
        text: diff.changed ? t('plugins.in.perms_changed', { from: existing.version, n: diff.changed }) : t('plugins.in.perms_same', { from: existing.version }) }));
      diff.rows.filter((r) => r.change).forEach((r) => box.appendChild(row(r, sens.indexOf(r.label) >= 0, r.change)));
      diff.removed.forEach((r) => box.appendChild(row(r, false, 'removed')));
      const same = diff.rows.filter((r) => !r.change);
      if (same.length) box.appendChild(usualRow(same));
      return box;
    }
    const rows = P.permRows(perm, t);
    rows.filter((r) => sens.indexOf(r.label) >= 0).forEach((r) => box.appendChild(row(r, true)));
    const usual = rows.filter((r) => sens.indexOf(r.label) < 0);
    if (usual.length) box.appendChild(usualRow(usual));
    return box;
    function usualRow(list) {
      const more = el('div', { class: 'pgx-pr-more', hidden: true }, list.map((r) => el('div', { class: 'pgx-kv' }, [el('span', { text: r.label }), el('span', { text: r.value })])));
      const open = linkBtn(t('plugins.x.perm_each'), () => { more.hidden = !more.hidden; open.setAttribute('aria-expanded', String(!more.hidden)); }, { 'aria-expanded': 'false' });
      return el('div', { class: 'pgx-pr' }, [icon(I.perms, 19), el('span', { class: 'pgx-t' }, [
        el('b', { text: list.map((r) => r.label).join(', ') }), el('small', null, [t('plugins.x.perm_usual') + ' · ', open]), more])]);
    }
  }

  function steps(phase) {
    return el('ol', { class: 'pgx-steps', 'aria-label': t('plugins.in.steps') }, [['check', 1], ['install', 2]].map(([k, n], i) => {
      const doneStep = (k === 'check' && phase !== 'check') || phase === 'done';
      const on = phase === k || (k === 'install' && phase === 'done');
      return el('li', { 'aria-current': on && !doneStep ? 'step' : 'false', 'data-done': doneStep ? '1' : '0' },
        [i ? el('span', { class: 'pgx-steps-sep', 'aria-hidden': 'true', text: '—' }) : null, el('span', { class: 'pgx-steps-n', text: doneStep ? '✓' : String(n) }), t('plugins.x.step_' + k)]);
    }));
  }

  /**
   * The install dialog. Resolves with the installed plugin view (or null).
   * @param info  answer of /inspect or /plugin-catalog/install
   * @param file  { name, size }
   * @param item  catalogue item (or null for an upload)
   */
  function installDialog(info, file, item) {
    const plugin = info.plugin;
    const isUpdate = !!info.existing;
    const title = plugin ? t(isUpdate ? 'plugins.x.dlg_update' : 'plugins.x.dlg_install', { name: plugin.name }) : file.name;
    const d = dlg(title);
    const body = el('div', { class: 'pgx-in' });
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(body);
    d.body.appendChild(err);
    const cancel = el('button', { type: 'button', class: 'pgx-btn', text: t('common.cancel'), on: { click: () => d.close(null) } });
    const go = el('button', { type: 'button', class: 'pgx-btn pgx-btn-pri', id: 'pgx-in-go' });
    d.foot.appendChild(cancel);
    d.foot.appendChild(go);
    const keyIn = el('input', { type: 'text', class: 'pgx-key', id: 'pgx-in-key', placeholder: t('plugins.lic.placeholder'), maxLength: 200, autocomplete: 'off', spellcheck: 'false' });
    const setup = el('input', { type: 'checkbox', id: 'pgx-in-setup' });
    setup.checked = true;
    let phase = 'check';
    let installed = null;
    let result = null;
    const started = Date.now();

    function head(text, sub, done) {
      const id = plugin ? plugin.id : '';
      const ic = plugin ? plugIcon(id, installedOf(id), 'lg') : el('span', { class: 'pgx-ic', 'data-size': 'lg', 'data-cat': 'other' }, [icon(I.file, 28)]);
      if (done) ic.appendChild(el('span', { class: 'pgx-ic-ok', 'aria-hidden': 'true' }, [icon(I.check, 12, 3.5)]));
      return el('div', { class: 'pgx-in-head' }, [ic, el('div', { class: 'pgx-in-title' }, [el('h3', { class: 'pgx-dh', text }), sub ? el('span', { class: 'pgx-muted', text: sub }) : null])]);
    }
    function metaLine() {
      const compat = (info.checks || []).find((c) => c.key === 'compatibility');
      return [plugin ? t('plugins.x.version_v', { version: plugin.version }) : '', P.fmtBytes(file.size),
        plugin ? (plugin.verified ? t('plugins.x.signed') : t('plugins.badge.unverified')) : '',
        compat && compat.status === 'ok' ? t('plugins.x.fits_gc', { version: inst.serverVersion || (compat.params && compat.params.installed) || '' }) : ''].filter(Boolean).join(' · ');
    }

    function render() {
      clear(body);
      err.hidden = true;
      body.appendChild(steps(phase));
      if (phase === 'check') {
        body.appendChild(head(title, metaLine()));
        const failed = (info.checks || []).filter((c) => c.status !== 'ok');
        if (failed.length) {
          body.appendChild(el('ul', { class: 'pgx-checks', id: 'pgx-checks' }, info.checks.map((c) => {
            const k = P.checkKeys(c);
            const params = Object.assign({}, c.params || {});
            return el('li', { 'data-state': c.status, 'data-check': c.key + '.' + c.code }, [el('span', { class: 'pgx-check-ic', 'aria-hidden': 'true', text: P.checkSymbol(c.status) }),
              el('span', null, [el('b', { text: t(k.title, params) }), el('small', { text: t(k.detail, params) })])]);
          })));
        }
        if (!info.canInstall) {
          err.textContent = t('plugins.in.blocked');
          err.hidden = false;
          go.textContent = t('plugins.in.install');
          go.disabled = true;
          return;
        }
        body.appendChild(lbl(t('plugins.x.may')));
        body.appendChild(permRowsBox(plugin.permissions, info.existing));
        const licensed = item && installedOf(item.id) && installedOf(item.id).license && installedOf(item.id).license.licensed;
        if (plugin.license.required && !licensed) {
          body.appendChild(el('label', { class: 'pgx-lbl', for: 'pgx-in-key', text: t('plugins.lic.key') }));
          body.appendChild(el('div', { class: 'pgx-keyfld' }, [icon(I.key, 18), keyIn]));
          body.appendChild(el('p', { class: 'pgx-hint' }, [t('plugins.x.key_later') + ' ', el('a', { class: 'pgx-a', href: SHOP_URL, target: '_blank', rel: 'noopener noreferrer', text: t('plugins.x.no_key_shop') })]));
        }
        if (!isUpdate) body.appendChild(el('label', { class: 'pgx-check-line' }, [setup, t('plugins.x.setup_after')]));
        go.textContent = t(isUpdate ? 'plugins.x.accept_update' : 'plugins.x.accept_install');
        go.disabled = false;
      } else if (phase === 'install') {
        body.appendChild(el('div', { class: 'pgx-in-title pgx-in-pad' }, [el('h3', { class: 'pgx-dh', text: t(isUpdate ? 'plugins.x.updating_t' : 'plugins.x.installing_t', { name: plugin.name }) }),
          el('span', { class: 'pgx-muted', text: t('plugins.x.prog_bg') })]));
        const rows = [['download', 'done', P.fmtBytes(file.size)], ['verify', 'done', 'sha256 ✓'], ['install', 'run', '…'], ['start', 'wait', '']];
        body.appendChild(el('ol', { class: 'pgx-progress' }, rows.map(([k, st, small]) => el('li', { 'data-state': st }, [
          el('span', { class: 'pgx-prog-ic', 'aria-hidden': 'true' }, st === 'done' ? [icon(I.check, 14, 3)] : []), el('span', { class: 'pgx-grow', text: t('plugins.x.prog_' + k) }),
          small ? el('small', { text: small }) : null]))));
        body.appendChild(el('div', { class: 'pgx-bar', 'aria-hidden': 'true' }, [el('span')]));
        go.textContent = t('plugins.x.installing');
        go.disabled = true;
      } else {
        const p = installed;
        const running = p && p.status === 'running';
        const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
        body.appendChild(head(t(isUpdate ? 'plugins.in.done_update' : 'plugins.in.done', { name: plugin.name }),
          [p && p.license && p.license.required ? t('plugins.lic.state.' + p.license.state) : null, running ? t('plugins.x.done_running_short') : t('plugins.reason.' + ((p && p.reason) || 'starting')),
            t('plugins.x.done_in', { n: secs })].filter(Boolean).join(' · '), true));
        if (result && result.licenseError) body.appendChild(el('p', { class: 'pgx-note pgx-note-warn', text: t('plugins.err.' + result.licenseError) }));
        if (!isUpdate && p && p.settingsCount) {
          body.appendChild(lbl(t('plugins.x.next_step')));
          body.appendChild(el('div', { class: 'pgx-nx pgx-nx-on' }, [icon('link', 20), el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.x.next_setup', { name: plugin.name }) }), el('small', { text: t('plugins.x.next_setup_d', { n: p.settingsCount }) })])]));
        }
        const adds = p ? P.addRows(p, null, t) : [];
        if (!isUpdate && adds.length) {
          body.appendChild(lbl(t('plugins.x.new_for_you')));
          adds.slice(0, 4).forEach((a) => body.appendChild(el('div', { class: 'pgx-nx' }, [icon(a.icon, 20), el('span', { class: 'pgx-t' }, [el('b', { text: a.title }), el('small', { text: a.text })])])));
        }
        cancel.textContent = t('plugins.x.later');
        cancel.hidden = false;
        go.disabled = false;
        go.textContent = t(p && p.settingsCount && !isUpdate ? 'plugins.x.set_up' : 'plugins.x.show_plugin');
      }
    }

    go.addEventListener('click', async () => {
      if (phase === 'done') { d.close(installed); location.href = U.manage(installed.id, (installed.settingsCount || installed.settingsPage) && !isUpdate ? 'settings' : null); return; }
      if (phase !== 'check') return;
      phase = 'install';
      cancel.hidden = true;
      render();
      const r = await req('POST', API + '/install', { token: info.token, accept: true, licenseKey: keyIn.value.trim() || null });
      if (!r.ok) { phase = 'check'; cancel.hidden = false; render(); err.textContent = r.error; err.hidden = false; return; }
      installed = r.plugin;
      result = r;
      if (!isUpdate && setup.checked && installed.settingsCount) {
        d.close(installed);
        location.href = U.manage(installed.id, 'settings');
        return;
      }
      phase = 'done';
      render();
    });
    render();
    return d.promise.then((v) => v || installed);
  }

  /** "Alle aktualisieren": inspect each, one consent for all, then install one after the other. */
  async function updateAll(items, after) {
    const list = (items || []).filter((x) => x && x.latest);
    if (!list.length) return;
    const d = dlg(t('plugins.x.update_all_title', { n: list.length }));
    const box = el('div', { class: 'pgx-in' });
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(box);
    d.body.appendChild(err);
    const cancel = el('button', { type: 'button', class: 'pgx-btn', text: t('common.cancel'), on: { click: () => d.close(null) } });
    const go = el('button', { type: 'button', class: 'pgx-btn pgx-btn-pri', id: 'pgx-ua-go', text: t('plugins.x.prepare'), disabled: true });
    d.foot.appendChild(cancel);
    d.foot.appendChild(go);
    const rows = list.map((it) => ({ it, state: 'wait', info: null, error: null }));
    let phase = 'prepare';
    function samePerm(info) { return JSON.stringify(info.plugin.permissions) === JSON.stringify(info.existing.permissions); }
    function render() {
      clear(box);
      box.appendChild(el('div', { class: 'pgx-in-title' }, [el('h3', { class: 'pgx-dh', text: t('plugins.x.update_all_title', { n: list.length }) }),
        el('span', { class: 'pgx-muted', text: t('plugins.x.update_all_d') })]));
      box.appendChild(el('ul', { class: 'pgx-ua' }, rows.map((r) => {
        const changed = r.info && r.info.existing && !samePerm(r.info);
        return el('li', { 'data-state': r.state }, [
          plugIcon(r.it.id, installedOf(r.it.id), 'sm'),
          el('span', { class: 'pgx-t' }, [el('b', { text: r.it.name }), el('small', { class: 'pgx-mono', text: (r.it.installedVersion || '') + ' → ' + r.it.latest.version })]),
          changed ? pill(t('plugins.x.perm_changes'), 'warn') : null,
          el('span', { class: 'pgx-ua-state', text: t('plugins.x.ua_' + r.state) + (r.error ? ': ' + r.error : '') }),
        ]);
      })));
      if (phase === 'confirm') {
        rows.filter((r) => r.info && r.info.existing && !samePerm(r.info)).forEach((r) => { box.appendChild(lbl(r.it.name)); box.appendChild(permRowsBox(r.info.plugin.permissions, r.info.existing)); });
        go.textContent = t('plugins.x.update_n', { n: rows.filter((r) => r.state === 'ready').length });
        go.disabled = !rows.some((r) => r.state === 'ready');
      }
    }
    render();
    for (const r of rows) {
      r.state = 'loading';
      render();
      const res = await req('POST', CAT_API + '/install', { id: r.it.id, version: r.it.latest.version });
      if (res.ok && res.canInstall) { r.info = res; r.state = 'ready'; } else { r.state = 'failed'; r.error = res.error || t('plugins.in.blocked'); }
      render();
    }
    phase = 'confirm';
    render();
    go.addEventListener('click', async () => {
      if (phase === 'finished') { d.close(true); return; }
      if (phase !== 'confirm') return;
      phase = 'running';
      go.disabled = true;
      cancel.hidden = true;
      for (const r of rows.filter((x) => x.state === 'ready')) {
        r.state = 'updating';
        render();
        const res = await req('POST', API + '/install', { token: r.info.token, accept: true });
        if (res.ok) r.state = 'updated'; else { r.state = 'failed'; r.error = res.error; }
        render();
      }
      phase = 'finished';
      go.disabled = false;
      go.textContent = t('plugins.x.close');
      toast(t('plugins.x.ua_done', { n: rows.filter((r) => r.state === 'updated').length }));
    });
    await d.promise;
    if (after) await after();
  }

  function uninstallDialog(p) {
    const d = dlg(t('plugins.un.title', { name: p.name }), 'sm');
    let mode = 'keep';
    d.body.appendChild(el('div', { class: 'pgx-in-head' }, [plugIcon(p.id, p, 'lg'), el('div', { class: 'pgx-in-title' }, [
      el('h3', { class: 'pgx-dh', text: t('plugins.x.un_title', { name: p.name }) }), el('span', { class: 'pgx-muted', text: t('plugins.x.un_intro') })])]));
    const lost = P.addRows(p, contrib[p.id], t).map((a) => a.title);
    if (lost.length) {
      d.body.appendChild(lbl(t('plugins.x.un_lost')));
      d.body.appendChild(el('ul', { class: 'pgx-lost' }, lost.map((x) => el('li', null, [icon(I.x, 16), x]))));
    }
    const users = (p.usedBy || []).map((id) => installedOf(id)).filter(Boolean);
    if (users.length) d.body.appendChild(el('p', { class: 'pgx-note pgx-note-warn', id: 'pgx-un-used', role: 'note' }, [icon(I.alert, 18), el('span', { text: t('plugins.x.un_used_by', { names: users.map((u) => u.name).join(', ') }) })]));
    const opts = el('div', { class: 'pgx-opts', role: 'radiogroup', 'aria-label': t('plugins.un.data') });
    const confirmIn = el('input', { type: 'text', class: 'pgx-fld-in', id: 'pg-un-confirm', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('plugins.un.type', { name: p.name }) });
    const confirmWrap = el('label', { class: 'pgx-confirm', hidden: true }, [el('span', { class: 'pgx-hint', text: t('plugins.un.type', { name: p.name }) }), confirmIn]);
    const go = el('button', { type: 'button', class: 'pgx-btn pgx-btn-crit', id: 'pg-un-go' });
    const sync = () => {
      opts.querySelectorAll('.pgx-opt').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === mode ? 'true' : 'false'));
      confirmWrap.hidden = mode !== 'wipe';
      clear(go);
      go.appendChild(icon(I.trash, 17));
      go.appendChild(document.createTextNode(t(mode === 'wipe' ? 'plugins.un.go_wipe' : 'plugins.un.go')));
      go.disabled = mode === 'wipe' && !P.wipeConfirmed(p, confirmIn.value);
    };
    for (const m of ['keep', 'wipe']) {
      opts.appendChild(el('button', { type: 'button', class: 'pgx-opt', role: 'radio', 'data-mode': m, on: { click: () => { mode = m; sync(); } } }, [
        el('span', { class: 'pgx-opt-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.un.' + m) }),
          el('small', { text: t('plugins.un.' + m + '_d') })]),
      ]));
    }
    confirmIn.addEventListener('input', sync);
    d.body.appendChild(lbl(t('plugins.un.data')));
    d.body.appendChild(opts);
    d.body.appendChild(confirmWrap);
    if (p.license && p.license.required) d.body.appendChild(el('p', { class: 'pgx-hint pgx-hint-ic' }, [icon(I.key, 16), t('plugins.un.license_note')]));
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(err);
    d.foot.appendChild(el('button', { type: 'button', class: 'pgx-btn', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    go.addEventListener('click', async () => {
      const r = await req('POST', API + '/' + enc(p.id) + '/uninstall', { mode, confirm: confirmIn.value });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      d.close(true);
      toast(t('plugins.toast.uninstalled', { name: p.name }));
      location.href = U.mine;
    });
    d.foot.appendChild(go);
    sync();
  }

  // ════════════════════════════════════════════════════════════
  // Meine Plugins
  // ════════════════════════════════════════════════════════════
  const ui = { q: '', filter: ['all', 'active', 'problems', 'off'].indexOf(query.get('filter')) >= 0 ? query.get('filter') : 'all', layout: 'list' };
  try { ui.layout = localStorage.getItem('gc.plugins.layout') === 'grid' ? 'grid' : 'list'; } catch (_) { ui.layout = 'list'; }
  let fillList = null;

  async function viewInstalled() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderInstalled();
    done();
    if (inst.plugins.length) { await loadContrib(); if (fillList) fillList(); }
  }

  /** The licence that ends first among the plugins that need one: { p, days } or null. */
  function soonestExpiry(ps) {
    let best = null;
    ps.forEach((p) => {
      const L = p.license || {};
      if (!L.required || !L.expiresAt || !P.licenseExpiring(p)) return;
      const days = P.daysUntil(L.expiresAt);
      if (days != null && (!best || days < best.days)) best = { p, days };
    });
    return best;
  }

  function renderInstalled() {
    clear(main);
    fillList = null;
    if (!inst.loaded) return;
    if (!inst.plugins.length) { renderFirstRun(); return; }
    root.classList.remove('pgx-first-mode');
    const ps = inst.plugins;
    const running = ps.filter((p) => p.status === 'running').length;
    const probs = ps.filter((p) => P.isProblem(p));
    const ups = cat.plugins.filter((x) => x.state === 'update');
    const licWarn = ps.filter((p) => P.licenseExpiring(p) || (p.status === 'blocked' && p.reason === 'license'));
    const soon = soonestExpiry(ps);

    main.appendChild(pageHead(t('plugins.area.mine'), [t('plugins.x.n_installed', { n: ps.length }), t('plugins.x.local'),
      cat.fetchedAt ? t('plugins.x.checked_last', { ago: ago(cat.fetchedAt) }) : null].filter(Boolean).join(' · '), [
      btn(t('plugins.x.upload'), { href: U.security, icon: I.upload, cls: 'pgx-hide-m' }),
      CATALOG_ON ? btn(t('plugins.x.discover'), { href: U.catalog, primary: true, icon: I.plus, cls: 'pgx-hide-m' }) : null,
    ]));

    const stat = (tone, label, value, of, sub, mobile, o) => el(o.href ? 'a' : 'button', {
      class: 'pgx-card pgx-stat' + (o.cls ? ' ' + o.cls : ''), 'data-tone': tone, href: o.href || null, type: o.href ? null : 'button',
      'aria-pressed': o.filter ? String(ui.filter === o.filter) : null,
      on: o.filter ? { click: () => { ui.filter = ui.filter === o.filter ? 'all' : o.filter; renderInstalled(); } } : null,
    }, [lbl(label), el('b', null, [String(value), of != null ? el('small', { text: ' / ' + of }) : null]), el('span', { class: 'pgx-stat-d', text: sub }), el('small', { class: 'pgx-stat-m', text: mobile })]);
    main.appendChild(el('div', { class: 'pgx-stats' }, [
      stat('good', t('plugins.x.stat_running'), running, ps.length, t('plugins.x.stat_running_d'), t('plugins.x.stat_running_m'), { filter: 'active' }),
      stat('crit', t('plugins.x.stat_problems'), probs.length, null, probs.length ? probs.map((p) => p.name).join(', ') : t('plugins.x.stat_none'), t('plugins.x.stat_problems_m'),
        { filter: 'problems', cls: probs.length ? 'pgx-stat-hot' : null }),
      stat('blue', t('plugins.x.stat_updates'), ups.length, null, ups.length ? t('plugins.x.stat_updates_d') : t('plugins.x.stat_uptodate'), '', { href: U.updates, cls: 'pgx-hide-m' }),
      stat('warn', t('plugins.x.stat_licenses'), licWarn.length, null, soon ? t('plugins.x.stat_lic_days', { n: Math.max(0, soon.days) }) : (licWarn.length ? t('plugins.x.stat_lic_d') : t('plugins.x.stat_lic_ok')),
        t('plugins.x.stat_licenses'), { href: U.licenses, cls: licWarn.length ? 'pgx-stat-hot' : null }),
    ]));

    const att = P.attention(ps, cat.plugins);
    if (att.length) main.appendChild(attentionCard(att));

    const search = el('input', { type: 'search', id: 'pgx-q', placeholder: t('plugins.x.search_installed'), 'aria-label': t('plugins.x.search_installed'), value: ui.q });
    const seg = el('div', { class: 'pgx-seg', role: 'group', 'aria-label': t('plugins.x.filter') }, ['all', 'active', 'problems', 'off'].map((f) => el('button', {
      type: 'button', 'aria-pressed': String(ui.filter === f), 'data-filter': f, on: { click: () => { ui.filter = f; renderInstalled(); } },
    }, [t('plugins.x.f_' + f), el('em', { text: String(P.filterInstalled(ps, f).length) })])));
    const layoutSeg = el('div', { class: 'pgx-seg', role: 'group', 'aria-label': t('plugins.x.layout') }, [['list', I.list], ['grid', I.grid]].map(([k, ic]) => el('button', {
      type: 'button', 'aria-pressed': String(ui.layout === k), 'aria-label': t('plugins.x.layout_' + k), title: t('plugins.x.layout_' + k),
      on: { click: () => { ui.layout = k; try { localStorage.setItem('gc.plugins.layout', k); } catch (_) { /* private mode */ } renderInstalled(); } },
    }, [icon(ic, 17)])));
    main.appendChild(el('div', { class: 'pgx-toolbar pgx-hide-m' }, [el('label', { class: 'pgx-fld' }, [icon(I.search, 17), search]), seg, layoutSeg]));

    const listBox = el('div', { id: 'pgx-list' });
    main.appendChild(listBox);
    fillList = () => {
      clear(listBox);
      const shown = P.filterInstalled(ps, ui.filter).filter((p) => P.matches(Object.assign({}, metaOf(p.id), p), ui.q));
      if (!shown.length) { listBox.appendChild(card([el('p', { class: 'pgx-empty', text: t('plugins.x.none_match') })])); return; }
      const groups = P.groupByCategory(shown, (p) => metaOf(p.id));
      const grid = ui.layout === 'grid';
      const wrap = el('div', { class: grid ? 'pgx-tiles' : 'pgx-lists' });
      if (grid) {
        groups.forEach((g) => {
          wrap.appendChild(el('div', { class: 'pgx-grp pgx-span' }, [lbl(catName(g.category)), el('span', { class: 'pgx-ver', text: String(g.items.length) })]));
          g.items.forEach((p) => wrap.appendChild(pluginTile(p)));
        });
      } else {
        // desktop: one card with group headings; phone: one card per group (mockup)
        const one = card([], { 'aria-label': t('plugins.x.installed_list') }, 'pgx-list');
        groups.forEach((g) => {
          one.appendChild(el('div', { class: 'pgx-grp' }, [lbl(catName(g.category)), el('span', { class: 'pgx-ver', text: String(g.items.length) })]));
          const box = el('div', { class: 'pgx-grp-rows' });
          g.items.forEach((p) => box.appendChild(pluginRow(p)));
          one.appendChild(box);
        });
        wrap.appendChild(one);
      }
      listBox.appendChild(wrap);
    };
    search.addEventListener('input', () => { ui.q = search.value; fillList(); });
    fillList();

    const sugg = cat.plugins.filter((x) => x.state === 'not_installed').slice(0, 2);
    if (sugg.length) {
      main.appendChild(el('section', { class: 'pgx-sec pgx-hide-m', 'aria-labelledby': 'pgx-sugg-h' }, [
        el('div', { class: 'pgx-sec-h' }, [h2(t('plugins.x.suggestions'), 'pgx-sugg-h'), link(t('plugins.x.whole_catalog'), U.catalog, { class: 'pgx-a pgx-push' })]),
        el('div', { class: 'pgx-minis' }, sugg.map((x) => el('a', { class: 'pgx-card pgx-mini', href: U.item(x.id) }, [
          plugIcon(x.id, null), el('span', { class: 'pgx-t' }, [el('b', { text: x.name }), el('small', { text: [x.summary || x.description, x.audience === 'admins' ? t('plugins.x.admins_only') : null].filter(Boolean).join(' · ') })]),
          el('span', { class: 'pgx-btn pgx-btn-sm', text: t('plugins.x.view') }),
        ]))),
      ]));
    }
  }

  function enabledSwitch(p, after) {
    return sw(p.enabled, t('plugins.x.active_of', { name: p.name }), async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      if (await setEnabled(p, !p.enabled)) { await loadInstalled(); if (after) after(); else renderInstalled(); updateNav(); } else b.disabled = false;
    });
  }

  /** The state of a row: update › problem › expiring licence › running / off. */
  function rowState(p) {
    const c = catItem(p.id);
    if (P.isProblem(p)) {
      const s = P.statusChip(p);
      return { pill: pill(p.status === 'crashed' ? t('plugins.x.disturbed') : t(s.key), s.tone, true), dot: s.tone === 'warn' ? 'warn' : 'crit', crit: s.tone !== 'warn' };
    }
    if (c && c.state === 'update' && c.latest) return { pill: pill(t('plugins.x.update_to', { version: c.latest.version }), 'blue'), badge: t('plugins.x.update_badge'), mobile: t('plugins.x.update_to_m', { version: c.latest.version }) };
    // a newer version that needs a newer GateControl: say so instead of showing nothing
    if (c && c.state === 'installed' && c.requiresNewer) return { pill: pill(t('plugins.x.update_needs_gc', { version: c.requiresNewer.version, range: rng(c.requiresNewer.gatecontrol) }), 'warn'), mobile: t('plugins.x.update_needs_gc_m', { version: c.requiresNewer.version }) };
    if (P.licenseExpiring(p)) {
      const days = P.daysUntil(p.license.expiresAt);
      return { pill: pill(t('plugins.x.lic_days_short', { n: Math.max(0, days || 0) }), 'warn', true), dot: 'warn' };
    }
    const s = P.statusChip(p);
    return { pill: pill(t(s.key), s.tone, true), dot: s.tone === 'good' ? 'good' : (s.tone === 'info' ? 'blue' : 'mute') };
  }

  function pluginRow(p) {
    const st = rowState(p);
    const chips = P.addChips(p, contrib[p.id], t, 4);
    const mobileLine = [p.version, st.mobile || chips.slice(0, 3).join(', ') || summaryOf(p)].filter(Boolean).join(' · ');
    return el('div', { class: 'pgx-row' + (st.crit ? ' pgx-row-crit' : ''), 'data-plugin': p.id, 'data-status': p.status }, [
      plugIcon(p.id, p),
      el('span', { class: 'pgx-nm' }, [
        el('a', { class: 'pgx-row-link', href: U.manage(p.id) }, [el('b', null, [p.name, ' ', el('span', { class: 'pgx-ver', text: p.version })])]),
        el('small', { class: 'pgx-nm-d', 'data-tone': st.crit ? 'crit' : null, text: noteOf(p) }),
        el('small', { class: 'pgx-nm-m', text: mobileLine }),
      ]),
      el('span', { class: 'pgx-adds' }, chips.map((x) => el('span', { class: 'pgx-add', text: x }))),
      el('span', { class: 'pgx-row-st' }, [st.pill]),
      st.badge ? el('span', { class: 'pgx-mbadge', text: st.badge }) : el('span', { class: 'pgx-mdot', 'data-tone': st.dot || 'mute', role: 'img', 'aria-label': t(P.statusChip(p).key) }),
      el('span', { class: 'pgx-row-sw' }, [enabledSwitch(p)]),
    ]);
  }

  function pluginTile(p) {
    const st = rowState(p);
    return el('article', { class: 'pgx-card pgx-pc', 'data-plugin': p.id, 'data-status': p.status }, [
      el('div', { class: 'pgx-pc-top' }, [plugIcon(p.id, p), el('span', { class: 'pgx-nm' }, [
        el('a', { class: 'pgx-row-link', href: U.manage(p.id) }, [el('b', { text: p.name })]), el('small', { text: catName(P.categoryOf(metaOf(p.id))) })]),
      el('span', { class: 'pgx-row-sw' }, [enabledSwitch(p)])]),
      el('p', { class: 'pgx-pc-p', text: noteOf(p) }),
      el('div', { class: 'pgx-pc-ft' }, [el('span', { class: 'pgx-ver', text: p.version }), el('span', { class: 'pgx-push' }, [st.pill])]),
    ]);
  }

  function attentionCard(items) {
    const rows = items.map((a) => {
      if (a.kind === 'updates') {
        const list = a.ids.map((id) => catItem(id)).filter(Boolean);
        return el('div', { class: 'pgx-att', 'data-kind': 'updates' }, [
          el('span', { class: 'pgx-ic', 'data-cat': 'update', 'aria-hidden': 'true' }, [icon(I.refresh, 22)]),
          el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.x.att_updates', { n: list.length }) }),
            el('small', { text: list.map((x) => x.name + ' ' + x.installedVersion + ' → ' + x.latest.version).join(' · ') + (inst.serverVersion ? ' · ' + t('plugins.x.all_fit', { version: inst.serverVersion.split('.').slice(0, 2).join('.') }) : '') })]),
          btn(t('plugins.x.whats_new'), { href: U.updates, small: true }),
          btn(t('plugins.x.update_all'), { small: true, primary: true, id: 'pgx-att-update-all', onClick: () => updateAll(list, reloadInstalled) }),
        ]);
      }
      const p = installedOf(a.id);
      const actions = [];
      let tone = 'crit';
      let pillText = t(P.statusChip(p).key);
      if (a.kind === 'crashed') {
        pillText = t('plugins.x.disturbed');
        actions.push(btn(t('plugins.tab.log'), { href: U.manage(p.id, 'log'), small: true }));
        actions.push(btn(t('plugins.x.restart'), { small: true, primary: true, onClick: async (e) => { e.currentTarget.disabled = true; await restart(p); await reloadInstalled(); } }));
      } else if (a.kind === 'license' || a.kind === 'expiring') {
        if (a.kind === 'expiring') { tone = 'warn'; pillText = t('plugins.x.days_n', { n: Math.max(0, P.daysUntil(p.license.expiresAt) || 0) }); }
        actions.push(btn(t(a.kind === 'expiring' ? 'plugins.x.renew' : 'plugins.banner.license_action'), { href: a.kind === 'expiring' ? U.licenses : U.manage(p.id, 'license'), small: true, primary: a.kind === 'license' }));
      } else if (a.kind === 'unsigned') {
        tone = 'warn';
        actions.push(btn(t('plugins.banner.unsigned_action'), { href: U.security, small: true }));
      } else if (a.kind === 'incompatible') {
        const c = catItem(p.id);
        if (c && c.state === 'update') actions.push(btn(t('plugins.cat.update'), { small: true, primary: true, onClick: (e) => installFromCatalog(c, e.currentTarget).then(reloadInstalled) }));
      } else actions.push(btn(t('plugins.x.details'), { href: U.manage(p.id), small: true }));
      const crashes = (p.process && p.process.crashes) || 0;
      const text = a.kind === 'crashed' ? [(p.process && p.process.lastError) || t('plugins.reason.crashed'), crashes ? t('plugins.x.restarts_n', { n: crashes }) : null].filter(Boolean).join(' · ')
        : (a.kind === 'expiring' ? t('plugins.x.att_expiring_d', { date: P.fmtDate(p.license.expiresAt, lang) })
          : (a.kind === 'license' ? t('plugins.lic.state.' + ((p.license && p.license.state) || 'missing')) + ' · ' + t('plugins.reason.license') : t('plugins.reason.' + (a.kind === 'broken' ? (p.reason || 'broken') : a.kind))));
      return el('div', { class: 'pgx-att', 'data-kind': a.kind, 'data-tone': tone }, [
        plugIcon(p.id, p),
        el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.x.att_' + a.kind, { name: p.name, date: p.license && p.license.expiresAt ? fmtDay(p.license.expiresAt) : '' }) }), el('small', { text })]),
        pill(pillText, tone, true),
      ].concat(actions));
    });
    return card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.attention'), 'pgx-att-h'), pill(String(items.length), 'mute')])].concat(rows),
      { 'aria-labelledby': 'pgx-att-h', id: 'pgx-attention' }, 'pgx-att-card');
  }

  async function reloadInstalled() { await Promise.all([loadInstalled(), loadCatalog(false)]); renderInstalled(); updateNav(); }

  /** No plugin yet (mockup "Leerer Zustand"): what plugins are, combinations, how it works. */
  function renderFirstRun() {
    root.classList.add('pgx-first-mode');
    if (cat.loaded && !cat.available && !cat.disabled) {
      main.appendChild(el('div', { class: 'pgx-banner', 'data-tone': 'warn', role: 'status' }, [icon(I.alert, 18), el('span', { class: 'pgx-grow', text: t('plugins.x.offline') }),
        btn(t('plugins.x.retry'), { small: true, onClick: async () => { await loadCatalog(true); renderInstalled(); updateNav(); } })]));
    }
    main.appendChild(el('div', { class: 'pgx-first' }, [
      lbl(t('plugins.area.title'), { class: 'pgx-lbl pgx-eyebrow' }),
      el('h2', { class: 'pgx-h1 pgx-h1-xl', id: 'pgx-title', text: t('plugins.x.first_title') }),
      el('p', { class: 'pgx-lead', text: t('plugins.x.first_text') }),
      el('div', { class: 'pgx-acts' }, [CATALOG_ON ? btn(t('plugins.x.open_catalog'), { href: U.catalog, primary: true, large: true }) : null, btn(t('plugins.x.upload'), { href: U.security, large: true })]),
    ]));
    const groups = P.groupByCategory(cat.plugins, (x) => x).filter((g) => g.category !== 'other' && g.category !== 'mobility');
    if (groups.length) {
      main.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-bundles-h' }, [
        h2(t('plugins.x.bundles'), 'pgx-bundles-h'),
        el('div', { class: 'pgx-bnds' }, groups.map((g) => el('a', { class: 'pgx-card pgx-bnd', href: U.cat(g.category) }, [
          el('span', { class: 'pgx-stack' }, g.items.slice(0, 4).map((x) => plugIcon(x.id, null, 'sm'))),
          el('b', { class: 'pgx-bnd-t', text: t('plugins.x.bundle.' + g.category) }),
          el('p', { text: t('plugins.x.bundle_d.' + g.category) }),
          el('span', { class: 'pgx-a', text: t('plugins.x.n_view', { n: g.items.length }) }),
        ]))),
      ]));
    }
    main.appendChild(card([h2(t('plugins.x.how'), 'pgx-how-h'), el('ol', { class: 'pgx-hows' }, [1, 2, 3].map((n) => el('li', { class: 'pgx-how' }, [
      el('span', { class: 'pgx-how-n', text: String(n) }), el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.x.how' + n) }), el('small', { text: t('plugins.x.how' + n + '_d') })]),
    ])))], { 'aria-labelledby': 'pgx-how-h' }, 'pgx-how-card'));
  }

  // ════════════════════════════════════════════════════════════
  // Katalog
  // ════════════════════════════════════════════════════════════
  const cf = { q: query.get('q') || '', cat: query.get('cat') || 'all', sort: 'recommended', installed: true, notInstalled: true, updatesOnly: false, compatibleOnly: true };
  if (cf.cat !== 'all' && P.CATEGORIES.indexOf(cf.cat) < 0) cf.cat = 'all';

  async function viewCatalog() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderCatalog();
    done();
  }

  /** The action of a catalogue card / panel. */
  function catalogAction(x, small, large) {
    const a = P.catalogAction(x);
    if (a === 'install') return btn(t('plugins.cat.install'), { primary: true, small, large, icon: large ? I.download : null, cls: 'pgx-raise', action: 'install', onClick: (e) => installFromCatalog(x, e.currentTarget).then(afterCatalogInstall) });
    if (a === 'update') return btn(t('plugins.cat.update'), { small, large, cls: 'pgx-raise pgx-btn-upd', action: 'update', onClick: (e) => installFromCatalog(x, e.currentTarget).then(afterCatalogInstall) });
    if (x.state === 'installed') {
      const p = installedOf(x.id);
      if (p && P.isProblem(p)) return el('a', { class: 'pgx-pill pgx-raise', 'data-tone': 'crit', href: U.manage(x.id) }, [t('plugins.x.installed_problem')]);
      return el('a', { class: 'pgx-btn pgx-btn-done pgx-raise' + (small ? ' pgx-btn-sm' : ''), href: U.manage(x.id) }, [icon(I.check, 16), t('plugins.cat.state.installed')]);
    }
    if (x.state === 'incompatible' && x.requiresNewer) return pill(t('plugins.x.needs_gc', { range: rng(x.requiresNewer.gatecontrol) }), 'warn');
    return null;
  }

  async function afterCatalogInstall(p) {
    if (!p) return;
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    if (VIEW === 'catalog') renderCatalog(); else if (VIEW === 'catalogItem') await viewCatalogItem();
    updateNav();
  }

  function syncUrl() {
    const u = new URLSearchParams();
    if (cf.cat !== 'all') u.set('cat', cf.cat);
    if (cf.q) u.set('q', cf.q);
    try { history.replaceState(null, '', location.pathname + (u.toString() ? '?' + u.toString() : '')); } catch (_) { /* ignore */ }
  }

  /** The side column of the catalogue: back to Meine Plugins, areas, filters, source. */
  function renderCatalogSide(counts, refresh) {
    const side = $('pgx-side');
    if (!side) return;
    clear(side);
    side.setAttribute('aria-label', t('plugins.x.filters'));
    side.appendChild(el('a', { class: 'pgx-sl pgx-sl-back', href: U.mine }, [icon(I.back, 17), t('plugins.area.mine')]));
    side.appendChild(lbl(t('plugins.x.areas')));
    [['all', cat.plugins.length]].concat(P.CATEGORIES.filter((c) => counts[c]).map((c) => [c, counts[c]])).forEach(([c, n]) => side.appendChild(el('button', {
      type: 'button', class: 'pgx-sl', 'aria-pressed': String(cf.cat === c), 'data-cat': c, on: { click: () => { cf.cat = c; refresh(); } },
    }, [c === 'all' ? icon(I.bag, 19) : el('span', { class: 'pgx-dot', 'data-cat': c, 'aria-hidden': 'true' }), el('span', { class: 'pgx-grow', text: c === 'all' ? t('plugins.x.all') : catName(c) }), el('span', { class: 'pgx-cnt', text: String(n) })])));
    side.appendChild(lbl(t('plugins.x.show')));
    [['installed', 'show_installed'], ['notInstalled', 'show_not_installed'], ['updatesOnly', 'show_updates'], ['compatibleOnly', 'show_compatible']].forEach(([k, key]) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!cf[k];
      cb.addEventListener('change', () => { cf[k] = cb.checked; refresh(true); });
      side.appendChild(el('label', { class: 'pgx-chk' }, [cb, el('span', { text: t('plugins.x.' + key, { version: (cat.serverVersion || inst.serverVersion || '').split('.').slice(0, 2).join('.') }) })]));
    });
    side.appendChild(lbl(t('plugins.x.source')));
    side.appendChild(el('p', { class: 'pgx-side-p' }, [
      cat.source && !cat.source.official ? t('plugins.x.source_custom', { host: cat.source.host }) : t('plugins.x.source_official'), el('br'),
      cat.fetchedAt ? t('plugins.x.checked_at', { when: fmtDateTime(cat.fetchedAt) }) + ' · ' : '',
      linkBtn(t('plugins.x.check_now'), async (e) => {
        e.currentTarget.disabled = true;
        await loadCatalog(true);
        toast(cat.available ? t('plugins.cat.refreshed') : (cat.error || t('plugins.cat.unreachable')), cat.available ? undefined : 'error');
        renderCatalog();
        updateNav();
      }, { id: 'pgx-cat-refresh' }),
    ]));
  }

  function renderCatalog() {
    clear(main);
    if (!cat.available) {
      main.appendChild(pageHead(t('plugins.x.cat_title'), cat.error || t('plugins.cat.unreachable'), null, t('plugins.area.page_catalog')));
      main.appendChild(card([el('div', { class: 'pgx-row-note' }, [icon(I.alert, 20), el('span', { class: 'pgx-grow', text: cat.error || t('plugins.cat.unreachable') })]),
        el('div', { class: 'pgx-acts' }, [btn(t('plugins.x.retry'), { primary: true, onClick: async (e) => { e.currentTarget.disabled = true; await loadCatalog(true); renderCatalog(); updateNav(); } }),
          btn(t('plugins.x.upload'), { href: U.security, icon: I.upload })])], null, 'pgx-pad'));
      return;
    }
    const counts = {};
    cat.plugins.forEach((x) => { const c = P.categoryOf(x); counts[c] = (counts[c] || 0) + 1; });
    const results = el('div', { class: 'pgx-results', id: 'pgx-results' });
    const refresh = (keepSide) => { syncUrl(); if (!keepSide) renderCatalogSide(counts, refresh); renderResults(); };

    const pubs = [...new Set(cat.plugins.map((x) => x.publisher).filter(Boolean))];
    main.appendChild(pageHead(t('plugins.x.cat_title'), t('plugins.x.cat_sub', { n: cat.plugins.length, publisher: pubs.length === 1 ? pubs[0] : t('plugins.x.publishers', { n: pubs.length }) }), null, t('plugins.area.page_catalog')));
    const search = el('input', { type: 'search', id: 'pgx-cq', placeholder: t('plugins.x.search_catalog'), 'aria-label': t('plugins.x.search_catalog'), value: cf.q });
    search.addEventListener('input', () => { cf.q = search.value; syncUrl(); renderResults(); });
    const sort = el('select', { class: 'pgx-sel', 'aria-label': t('plugins.x.sort') }, ['recommended', 'recent', 'name'].map((k) => {
      const o = el('option', { value: k, text: t('plugins.x.sort_' + k) });
      if (cf.sort === k) o.selected = true;
      return o;
    }));
    sort.addEventListener('change', () => { cf.sort = sort.value; renderResults(); });
    main.appendChild(el('div', { class: 'pgx-srow' }, [el('label', { class: 'pgx-srch' }, [icon(I.search, 19), search]), sort]));
    // phone: the areas as chips (mockup "Katalog mobil")
    const chips = el('div', { class: 'pgx-chips-m', role: 'group', 'aria-label': t('plugins.x.areas') });
    main.appendChild(chips);
    main.appendChild(results);

    function renderChips() {
      clear(chips);
      [['all', cat.plugins.length]].concat(P.CATEGORIES.filter((c) => counts[c]).map((c) => [c, counts[c]])).forEach(([c, n]) => chips.appendChild(el('button', {
        type: 'button', class: 'pgx-chip', 'aria-pressed': String(cf.cat === c), on: { click: () => { cf.cat = c; refresh(); } },
      }, [c === 'all' ? null : el('i', { class: 'pgx-dot', 'data-cat': c, 'aria-hidden': 'true' }), c === 'all' ? t('plugins.x.all_n', { n }) : t('plugins.x.cat_short.' + c)])));
    }

    function renderResults() {
      clear(results);
      renderChips();
      const filtered = cf.cat !== 'all' || !!cf.q.trim() || cf.updatesOnly || !cf.installed || !cf.notInstalled;
      let list = cat.plugins.filter((x) => (cf.cat === 'all' || P.categoryOf(x) === cf.cat) && P.matches(x, cf.q));
      list = list.filter((x) => {
        if (cf.updatesOnly && x.state !== 'update') return false;
        if (!cf.installed && (x.state === 'installed' || x.state === 'update')) return false;
        if (!cf.notInstalled && (x.state === 'not_installed' || x.state === 'incompatible')) return false;
        if (cf.compatibleOnly && x.state === 'incompatible') return false;
        return true;
      });
      list = P.sortCatalog(list, cf.sort, lang);
      const desk = el('div', { class: 'pgx-results-d' });
      if (!filtered) {
        const hl = cat.plugins.filter((x) => x.highlight && x.highlight.title).sort((a, b) => (Date.parse((b.latest && b.latest.publishedAt) || '') || 0) - (Date.parse((a.latest && a.latest.publishedAt) || '') || 0))[0];
        if (hl) desk.appendChild(heroCard(hl));
        const fresh = cat.plugins.filter((x) => x.state === 'not_installed');
        if (fresh.length) {
          desk.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-fresh-h' }, [
            el('div', { class: 'pgx-sec-h' }, [h2(t('plugins.x.not_yours'), 'pgx-fresh-h'), el('span', { class: 'pgx-sec-s', text: t('plugins.x.fits') })]),
            el('div', { class: 'pgx-feats' }, fresh.slice(0, 4).map((x) => featureCard(x))),
          ]));
        }
      }
      desk.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-all-h' }, [
        el('div', { class: 'pgx-sec-h' }, [h2(cf.cat === 'all' ? t('plugins.x.all_plugins') : catName(cf.cat), 'pgx-all-h'), el('span', { class: 'pgx-ver', text: String(list.length) })]),
        list.length ? el('div', { class: 'pgx-grid', id: 'pgx-cat-grid' }, list.map((x) => catalogCard(x))) : emptyResult(),
      ]));
      desk.appendChild(card([sic(I.upload), el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.x.own_plugin') }), el('small', { text: t('plugins.x.own_plugin_d') })]),
        btn(t('plugins.x.upload'), { href: U.security })], null, 'pgx-teaser'));
      results.appendChild(desk);

      // phone: "Noch nicht bei dir" / "Installiert" as lists
      const mob = el('div', { class: 'pgx-results-m' });
      const fresh = list.filter((x) => x.state === 'not_installed' || x.state === 'incompatible');
      const mine = list.filter((x) => x.state === 'installed' || x.state === 'update');
      if (fresh.length) { mob.appendChild(lbl(t('plugins.x.not_yours'))); mob.appendChild(el('div', { class: 'pgx-card pgx-mlist' }, fresh.map((x) => mobileItem(x)))); }
      if (mine.length) { mob.appendChild(lbl(t('plugins.x.installed_lbl'))); mob.appendChild(el('div', { class: 'pgx-card pgx-mlist' }, mine.map((x) => mobileItem(x)))); }
      if (!list.length) mob.appendChild(emptyResult());
      results.appendChild(mob);
    }
    function emptyResult() {
      return el('div', { class: 'pgx-empty' }, [t('plugins.x.none_found'), ' ', linkBtn(t('plugins.x.reset_filters'), () => {
        Object.assign(cf, { q: '', cat: 'all', installed: true, notInstalled: true, updatesOnly: false, compatibleOnly: true });
        search.value = '';
        refresh();
      })]);
    }
    refresh();
  }

  function heroCard(x) {
    const h = x.highlight;
    const inst0 = x.state === 'installed' || x.state === 'update';
    const tags = (h.tags || []).filter((g) => g && g.text);
    return el('section', { class: 'pgx-card pgx-hero', 'aria-labelledby': 'pgx-hero-h', id: 'pgx-hero' }, [
      el('div', { class: 'pgx-hero-t' }, [
        pill(t('plugins.x.new_in', { name: x.name, version: h.version.split('.').slice(0, 2).join('.') }), 'new'),
        el('h2', { class: 'pgx-hero-h', id: 'pgx-hero-h', text: h.title }),
        h.text ? el('p', { text: h.text }) : null,
        el('div', { class: 'pgx-acts' }, [btn(t('plugins.x.view'), { href: inst0 ? U.manage(x.id) : U.item(x.id), primary: true }),
          inst0 ? el('span', { class: 'pgx-btn pgx-btn-done' }, [icon(I.check, 16), t('plugins.x.installed_here_cap')]) : catalogAction(x)]),
      ]),
      tags.length ? el('div', { class: 'pgx-hero-tags', 'aria-hidden': 'true' }, tags.map((g, i) => el('span', { class: 'pgx-tg' + (i === tags.length - 1 ? ' pgx-tg-on' : ''), style: 'margin-left:' + (i * 28) + 'px' },
        [icon(g.icon || ['clock', 'car', 'calendar', 'bell'][i % 4], 16), g.text])))
        : el('div', { class: 'pgx-hero-art', 'aria-hidden': 'true' }, [plugIcon(x.id, installedOf(x.id), 'hero')]),
    ]);
  }

  function chipsOf(x) {
    return [catName(P.categoryOf(x)), x.audience === 'admins' ? t('plugins.x.admins_only') : null, x.latest && x.latest.licenseRequired ? t('plugins.x.license') : t('plugins.cat.license_free')].filter(Boolean)
      .map((c) => pill(c, 'mute'));
  }

  function featureCard(x) {
    return el('article', { class: 'pgx-card pgx-feat', 'data-cat-plugin': x.id }, [
      plugIcon(x.id, null, 'lg'),
      el('span', { class: 'pgx-t' }, [
        el('a', { class: 'pgx-row-link', href: U.item(x.id) }, [el('b', { text: x.name })]),
        el('p', { text: x.summary || x.description }),
        el('span', { class: 'pgx-pills' }, chipsOf(x)),
      ]),
      catalogAction(x, true),
    ]);
  }

  function isNewItem(x) {
    return !!(x.highlight && x.latest && x.highlight.version && x.latest.version.split('.').slice(0, 2).join('.') === x.highlight.version.split('.').slice(0, 2).join('.'));
  }

  function catalogCard(x) {
    const p = installedOf(x.id);
    const href = p ? U.manage(x.id) : U.item(x.id);
    return el('article', { class: 'pgx-card pgx-pc', 'data-cat-plugin': x.id, 'data-cat-state': x.state }, [
      el('div', { class: 'pgx-pc-top' }, [plugIcon(x.id, p), el('span', { class: 'pgx-nm' }, [
        el('a', { class: 'pgx-row-link', href }, [el('b', { text: x.name })]),
        el('small', { text: catName(P.categoryOf(x)) }),
      ]), isNewItem(x) ? pill(t('plugins.x.new_v', { version: x.highlight.version.split('.').slice(0, 2).join('.') }), 'new') : null]),
      el('p', { class: 'pgx-pc-p', text: x.summary || x.description }),
      el('div', { class: 'pgx-pc-ft' }, [
        el('span', { class: 'pgx-ver', text: x.state === 'update' ? x.installedVersion + ' → ' + x.latest.version : ((x.latest ? x.latest.version : '') + (x.latest ? ' · ' + P.fmtBytes(x.latest.size) : '')) }),
        el('span', { class: 'pgx-push' }, [catalogAction(x, true)]),
      ]),
    ]);
  }

  function mobileItem(x) {
    const a = P.catalogAction(x);
    let end;
    if (a === 'install') end = el('span', { class: 'pgx-get', text: t('plugins.x.get') });
    else if (a === 'update') end = el('span', { class: 'pgx-mupd', text: x.latest.version });
    else if (x.state === 'installed') end = el('span', { class: 'pgx-has', text: '✓ ' + t('plugins.x.current') });
    else end = null;
    return el('a', { class: 'pgx-mit', href: installedOf(x.id) ? U.manage(x.id) : U.item(x.id) }, [plugIcon(x.id, installedOf(x.id)),
      el('span', { class: 'pgx-t' }, [el('b', { text: x.name }), el('small', { text: [x.summary || x.description, x.audience === 'admins' ? t('plugins.x.admins_only') : null].filter(Boolean).join(' · ') })]), end]);
  }

  // ── One catalogue plugin ──
  async function viewCatalogItem() {
    const [, , r] = await Promise.all([loadInstalled(), loadCatalog(false), req('GET', CAT_API + '/' + enc(TARGET))]);
    clear(main);
    if (!r.ok || !r.plugin) {
      main.appendChild(card([el('p', { text: r.error || t('plugins.err.catalog_unknown') }), btn(t('plugins.x.back_catalog'), { href: U.catalog, icon: I.back })], null, 'pgx-pad'));
      done();
      return;
    }
    const x = r.plugin;
    if (!catItem(x.id)) cat.plugins.push(x);
    const p = installedOf(x.id);
    const category = P.categoryOf(x);
    main.appendChild(el('nav', { class: 'pgx-crumb', 'aria-label': t('plugins.x.path') }, [link(t('plugins.area.catalog'), U.catalog), el('span', { 'aria-hidden': 'true', text: '›' }),
      link(catName(category), U.cat(category)), el('span', { 'aria-hidden': 'true', text: '›' }), el('span', { 'aria-current': 'page', text: x.name })]));
    const left = el('div', { class: 'pgx-colm' });
    const aside = el('aside', { class: 'pgx-aside', 'aria-label': t('plugins.x.install_panel') });
    main.appendChild(el('div', { class: 'pgx-cols' }, [left, aside]));

    left.appendChild(el('div', { class: 'pgx-dhero' }, [plugIcon(x.id, p, 'xxl'), el('div', { class: 'pgx-dhero-t' }, [
      el('h2', { class: 'pgx-h1 pgx-h1-lg', id: 'pgx-title', text: x.name }),
      el('p', { class: 'pgx-dhero-s', text: x.summary || x.description || '' }),
      el('span', { class: 'pgx-pills' }, [pill(catName(category), 'mute'), x.audience === 'admins' ? pill(t('plugins.x.admins_long'), 'mute') : null, pill(x.publisher, 'mute')]),
    ])]));
    if ((x.shows || []).length) left.appendChild(showsBlock(x));

    const perms = x.permissions || [];
    const tabs = [['overview', t('plugins.tab.overview'), null], ['perms', t('plugins.tab.perms'), perms.length || (p ? P.permRows(p.permissions, t).length : null)], ['versions', t('plugins.x.tab_versions'), (x.versions || []).length]];
    let tab = ['perms', 'versions'].indexOf(query.get('tab')) >= 0 ? query.get('tab') : 'overview';
    const tl = el('div', { class: 'pgx-tabs', role: 'tablist', 'aria-label': t('plugins.detail.tabs') });
    const panel = el('div', { class: 'pgx-panel', role: 'tabpanel', id: 'pgx-panel' });
    left.appendChild(tl);
    left.appendChild(panel);
    const renderTab = () => {
      clear(tl);
      tabs.forEach(([id, text, n]) => tl.appendChild(el('button', { type: 'button', class: 'pgx-tab', role: 'tab', 'aria-selected': String(tab === id), id: 'pgx-tab-' + id,
        on: { click: () => { tab = id; renderTab(); } } }, [text, n ? el('em', { text: String(n) }) : null])));
      panel.setAttribute('aria-labelledby', 'pgx-tab-' + tab);
      clear(panel);
      if (tab === 'versions') { panel.appendChild(versionsCard(x.versions || [], p ? p.version : null, null)); return; }
      if (tab === 'perms') { panel.appendChild(catalogPermsCard(x, p)); return; }
      const adds = (x.adds || []).length ? x.adds : (p ? P.addRows(p, contrib[p.id], t) : []);
      if (adds.length) {
        panel.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-give-h' }, [h2(t('plugins.x.adds_to', { name: x.name }), 'pgx-give-h'),
          el('div', { class: 'pgx-gives' }, adds.map((a) => el('div', { class: 'pgx-give' }, [sic(a.icon, category), el('span', { class: 'pgx-t' }, [el('b', { text: a.title }), a.text ? el('small', { text: a.text }) : null])])))]));
      } else if (x.description && x.description !== x.summary) {
        panel.appendChild(el('p', { class: 'pgx-desc', text: x.description }));
      }
      panel.appendChild(catalogPermsCard(x, p));
      if ((x.versions || []).length) panel.appendChild(versionsCard(x.versions.slice(0, 2), p ? p.version : null, t('plugins.x.new_in_version', { version: x.versions[0].version })));
    };
    renderTab();

    // install panel
    const lines = [];
    if (x.latest) {
      lines.push(el('div', { class: 'pgx-line', 'data-tone': x.latest.compatible === false ? 'warn' : 'good' }, [icon(x.latest.compatible === false ? I.alert : I.check, 18),
        el('span', null, [t(x.latest.compatible === false ? 'plugins.x.not_fitting' : 'plugins.x.fitting'), ' ', el('span', { class: 'pgx-muted', text: t('plugins.x.gc_needs', { installed: (r.serverVersion || '').split('.').slice(0, 2).join('.'), range: rng(x.latest.gatecontrol) }) })])]));
    } else if (x.requiresNewer) {
      lines.push(el('div', { class: 'pgx-line', 'data-tone': 'warn' }, [icon(I.alert, 18), el('span', { text: t('plugins.cat.requires', { range: x.requiresNewer.gatecontrol, installed: r.serverVersion }) })]));
    }
    lines.push(el('div', { class: 'pgx-line', 'data-tone': 'good' }, [icon(I.shieldOk, 18), el('span', null, [t('plugins.x.signed_by', { publisher: x.publisher }), ' ', el('span', { class: 'pgx-muted', text: '· ' + t('plugins.x.sha_checked') })])]));
    if (x.latest && x.latest.licenseRequired && !(p && p.license && p.license.licensed)) {
      lines.push(el('div', { class: 'pgx-line pgx-line-box', 'data-tone': 'warn' }, [icon(I.key, 18), el('span', null, [t('plugins.x.license_needed'), ' ',
        el('a', { href: SHOP_URL, target: '_blank', rel: 'noopener noreferrer', class: 'pgx-a-inherit', text: t('plugins.x.shop') + ' ›' })])]));
    }
    const act = catalogAction(x, false, true);
    aside.appendChild(card([act ? el('div', { class: 'pgx-install-act' }, [act]) : null].concat(lines), null, 'pgx-install'));
    aside.appendChild(card([lbl(t('plugins.x.details')), kv([
      [t('plugins.tile.version'), x.latest ? x.latest.version : (x.versions && x.versions[0] ? x.versions[0].version : ''), true],
      p ? [t('plugins.x.installed_v'), p.version, true] : null,
      [t('plugins.x.size'), x.latest ? P.fmtBytes(x.latest.size) : ''],
      [t('plugins.x.publisher'), x.publisher],
      [t('plugins.x.for'), x.audience === 'admins' ? t('plugins.x.admins') : t('plugins.x.everyone')],
      x.needs ? [t('plugins.x.needs_what'), x.needs] : [t('plugins.x.needs'), x.latest ? 'GateControl ' + rng(x.latest.gatecontrol) : ''],
      (x.languages || []).length ? [t('plugins.x.languages'), x.languages.map((l) => t('plugins.x.lang_' + l)).join(', ')] : null,
    ])], null, 'pgx-pad'));
    const rel = (x.related || []).map((id) => catItem(id)).filter(Boolean);
    if (rel.length) {
      aside.appendChild(card([lbl(t('plugins.x.related'))].concat(rel.map((y) => el('a', { class: 'pgx-rel', href: installedOf(y.id) ? U.manage(y.id) : U.item(y.id) }, [
        plugIcon(y.id, installedOf(y.id), 'sm'), el('span', { class: 'pgx-t' }, [el('b', { text: y.name }), el('small', { text: y.summary || catName(P.categoryOf(y)) })]),
        icon(I.next, 16)]))), null, 'pgx-pad pgx-stack-card'));
    }
    if (p) aside.appendChild(btn(t('plugins.x.manage'), { href: U.manage(p.id), icon: 'key' }));
    done();
  }

  /** "So sieht es bei dir aus": wireframes of what the plugin shows (catalogue `shows`). */
  function showsBlock(x) {
    const cat0 = P.categoryOf(x);
    const bar = (w, extra) => el('div', { class: 'pgx-bar' + (extra ? ' ' + extra : ''), style: 'width:' + w });
    const frame = (s) => {
      if (s.kind === 'tile') {
        return el('div', { class: 'pgx-shot-f', 'aria-hidden': 'true' }, [
          el('div', { class: 'pgx-shot-r' }, [el('span', { class: 'pgx-sic pgx-sic-xs', 'data-cat': cat0 }), bar('90px', 'pgx-bar-text'), pill(s.value || '3/3', 'good', false, { class: 'pgx-pill pgx-pill-xs' })]),
          el('div', { class: 'pgx-shot-g' }, [el('span'), el('span'), el('span')]), bar('70%'), bar('50%')]);
      }
      if (s.kind === 'list') {
        return el('div', { class: 'pgx-shot-f', 'aria-hidden': 'true' }, [
          el('div', { class: 'pgx-shot-r' }, [bar('60px', 'pgx-bar-acc'), bar('40px'), bar('40px')]),
          ...['good', 'good', 'warn', 'mute'].map((tone) => el('div', { class: 'pgx-shot-r' }, [el('span', { class: 'pgx-shot-dot', 'data-tone': tone }), bar('auto', 'pgx-grow'), bar('30px')]))]);
      }
      return el('div', { class: 'pgx-shot-f pgx-shot-w', 'aria-hidden': 'true' }, [el('div', { class: 'pgx-shot-wd' }, [bar('60%'), el('b', { text: s.value || '12 / 14' }), bar('80%', 'pgx-bar-acc')])]);
    };
    return el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-shots-h', 'data-cat': cat0 }, [
      el('h2', { class: 'pgx-lbl', id: 'pgx-shots-h', text: t('plugins.x.looks_like') }),
      el('div', { class: 'pgx-shots' }, x.shows.map((s) => el('figure', { class: 'pgx-shot' }, [frame(s), el('figcaption', { text: s.caption })]))),
    ]);
  }

  /** "Das darf das Plugin" of a catalogue plugin: the catalogue's list, else (installed) the manifest's. */
  function catalogPermsCard(x, p) {
    const rows = [];
    (x.permissions || []).forEach((r) => rows.push(el('div', { class: 'pgx-perm' }, [icon(r.icon || 'shield', 19), el('span', { class: 'pgx-t' }, [el('b', { text: r.title }), r.text ? el('small', { text: r.text }) : null]),
      r.tag ? pill(r.tag, 'warn') : null])));
    if (!rows.length && p) {
      const sens = P.sensitivePerms(p.permissions).map((k) => t(k));
      P.permRows(p.permissions, t).forEach((r) => rows.push(el('div', { class: 'pgx-perm' }, [icon(sens.indexOf(r.label) >= 0 ? I.shield : I.perms, 19), el('span', { class: 'pgx-t' }, [el('b', { text: r.label }), el('small', { text: r.value })]),
        sens.indexOf(r.label) >= 0 ? pill(t('plugins.x.sensitive'), 'warn') : null])));
    }
    if (!rows.length) rows.push(el('p', { class: 'pgx-note pgx-in-pad', role: 'note' }, [icon(I.shield, 16), el('span', { text: t('plugins.x.perms_before') })]));
    return card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.may_title'), 'pgx-perm-h'), el('span', { class: 'pgx-sec-s', text: t('plugins.x.may_confirm') })])].concat(rows),
      { 'aria-labelledby': 'pgx-perm-h', id: 'pgx-perms' }, 'pgx-flush');
  }

  /** Versions with their notes (newest first). */
  function versionsCard(versions, installedVersion, title) {
    const rows = versions.map((v, i) => el('div', { class: 'pgx-vr', 'data-version': v.version }, [
      el('span', { class: 'pgx-vr-v' + (i === 0 ? ' pgx-vr-new' : ''), text: v.version }),
      el('span', { class: 'pgx-t' }, [
        el('span', { class: 'pgx-vr-m' }, [v.version === installedVersion ? pill(t('plugins.x.installed_here'), 'good') : null,
          v.compatible === false ? pill(t('plugins.x.needs_gc', { range: rng(v.gatecontrol) }), 'warn') : null, el('small', { text: P.fmtDate(v.publishedAt, lang) })]),
        v.notes ? notesBlock(v.notes) : el('small', { text: t('plugins.x.no_notes') }),
      ]),
    ]));
    if (!rows.length) rows.push(el('p', { class: 'pgx-empty', text: t('plugins.x.no_versions') }));
    return card([el('div', { class: 'pgx-card-h' }, [h2(title || t('plugins.x.tab_versions'), 'pgx-ver-h')])].concat(rows), { 'aria-labelledby': 'pgx-ver-h', id: 'pgx-versions' }, 'pgx-flush');
  }

  // ════════════════════════════════════════════════════════════
  // One installed plugin (manage/<id>)
  // ════════════════════════════════════════════════════════════
  const TABS = ['overview', 'settings', 'perms', 'license', 'log', 'versions'];
  let mtab = TABS.indexOf(query.get('tab')) >= 0 ? query.get('tab') : 'overview';

  async function viewManage() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderManage();
    done();
    if (installedOf(TARGET)) {
      await loadContrib();
      if (mtab === 'overview') renderManage();
    }
  }

  function setTab(id) {
    mtab = id;
    try { history.replaceState(null, '', location.pathname + (id === 'overview' ? '' : '?tab=' + id)); } catch (_) { /* ignore */ }
    renderManage();
  }

  function sinceText(p) {
    const proc = p.process || {};
    if (p.status === 'running' && proc.startedAt) return t('plugins.x.running_since', { ago: ago(new Date(proc.startedAt).toISOString()).replace(/^vor /, '') });
    return t(P.statusChip(p).key);
  }

  function renderManage() {
    clear(main);
    const p = installedOf(TARGET);
    if (!p) { main.appendChild(card([el('p', { text: t('plugins.err.not_found') }), btn(t('plugins.x.back_mine'), { href: U.mine, icon: I.back })], null, 'pgx-pad')); return; }
    const c = catItem(p.id);
    main.appendChild(el('nav', { class: 'pgx-crumb', 'aria-label': t('plugins.x.path') }, [link(t('plugins.area.title'), U.mine), el('span', { 'aria-hidden': 'true', text: '›' }),
      link(t('plugins.area.mine'), U.mine), el('span', { 'aria-hidden': 'true', text: '›' }), el('span', { 'aria-current': 'page', text: p.name })]));

    const menu = el('details', { class: 'pgx-menu' }, [
      el('summary', { class: 'pgx-ib', 'aria-label': t('plugins.x.more_actions'), title: t('plugins.x.more_actions') }, [icon(I.more, 18)]),
      el('div', { class: 'pgx-menu-pop', role: 'menu' }, [
        el('button', { type: 'button', role: 'menuitem', text: t('plugins.x.check_license'), on: { click: () => setTab('license') } }),
        c ? el('a', { role: 'menuitem', href: U.item(p.id), text: t('plugins.x.in_catalog') }) : null,
        el('button', { type: 'button', role: 'menuitem', 'data-tone': 'crit', id: 'pgx-uninstall-menu', text: t('plugins.detail.uninstall'), on: { click: () => uninstallDialog(p) } }),
      ]),
    ]);
    const open = p.status === 'running' && (p.portal || p.nav)
      ? btn(t(p.nav ? 'plugins.detail.open' : 'plugins.x.open_portal'), { href: p.nav ? '/plugins/' + enc(p.id) : '/portal', icon: I.ext, external: !p.nav }) : null;
    main.appendChild(card([
      plugIcon(p.id, p, 'xl'),
      el('div', { class: 'pgx-mh-t' }, [
        el('div', { class: 'pgx-mh-r' }, [el('h2', { class: 'pgx-h1', id: 'pgx-dtitle', text: p.name }), pill(sinceText(p), P.statusChip(p).tone, true)]),
        el('span', { class: 'pgx-mh-s', text: summaryOf(p) }),
        el('span', { class: 'pgx-mh-m' }, [el('span', { class: 'pgx-mono', text: 'v' + p.version }), el('span', { text: p.publisher }),
          el('span', { class: 'pgx-mh-sig', 'data-tone': p.verified ? 'good' : 'warn' }, [icon(I.shieldOk, 15), t(p.verified ? 'plugins.x.signed' : 'plugins.badge.unverified')]),
          el('span', { text: catName(P.categoryOf(metaOf(p.id))) })]),
      ]),
      el('div', { class: 'pgx-mh-a' }, [
        open,
        btn(t('plugins.x.restart'), { icon: I.refresh, id: 'pgx-restart', disabled: !p.enabled, onClick: async (e) => { e.currentTarget.disabled = true; await restart(p); await loadInstalled(); renderManage(); } }),
        el('span', { class: 'pgx-swbox' }, [el('span', { text: t(p.enabled ? 'plugins.detail.active' : 'plugins.detail.inactive') }),
          sw(p.enabled, t('plugins.x.active_of', { name: p.name }), async () => { if (await setEnabled(p, !p.enabled)) { await loadInstalled(); renderManage(); updateNav(); } }, 'pgx-toggle')]),
        menu,
      ]),
    ], { 'aria-labelledby': 'pgx-dtitle' }, 'pgx-mhero'));

    if (c && c.state === 'update' && c.latest) {
      main.appendChild(el('div', { class: 'pgx-banner', 'data-tone': 'info', role: 'status' }, [icon(I.refresh, 18),
        el('span', { class: 'pgx-grow' }, [el('b', { text: t('plugins.x.update_available', { version: c.latest.version }) }), ' ', el('span', { class: 'pgx-muted', text: c.replaces ? t('plugins.x.replaced_by', { name: c.name }) : t('plugins.x.update_kind.' + P.updateKind(p.version, c.latest.version)) })]),
        linkBtn(t('plugins.x.whats_new'), () => setTab('versions')),
        btn(t('plugins.cat.update'), { primary: true, small: true, id: 'pgx-update', onClick: (e) => installFromCatalog(c, e.currentTarget).then(async (r) => {
          if (!r) return;
          // taken over under a new id: this page's plugin is gone
          if (c.replaces) { window.location.assign(U.manage(c.id)); return; }
          await Promise.all([loadInstalled(), loadCatalog(false)]); renderManage(); updateNav();
        }) })]));
    }
    if (c && c.state === 'installed' && c.requiresNewer) {
      main.appendChild(el('div', { class: 'pgx-banner', 'data-tone': 'warn', role: 'status', id: 'pgx-update-blocked' }, [icon(I.alert, 18),
        el('span', { class: 'pgx-grow', text: t('plugins.x.blocked_line', { version: c.requiresNewer.version, range: rng(c.requiresNewer.gatecontrol), installed: inst.serverVersion || '' }) }),
        linkBtn(t('plugins.x.whats_new'), () => setTab('versions'))]));
    }
    const banner = problemBanner(p);
    if (banner) main.appendChild(banner);
    const legacySlot = el('div', { id: 'pg-legacy-slot' });
    main.appendChild(legacySlot);
    renderLegacy(p, legacySlot);

    const tl = el('div', { class: 'pgx-tabs', role: 'tablist', 'aria-label': t('plugins.detail.tabs') });
    TABS.forEach((id) => {
      if (id === 'versions' && !c) return;
      const n = id === 'perms' ? P.permRows(p.permissions, t).length : null;
      tl.appendChild(el('button', { type: 'button', class: 'pgx-tab', role: 'tab', id: 'pg-tab-' + id, 'aria-selected': String(mtab === id), 'aria-controls': 'pg-panel', 'data-tab': id,
        on: { click: () => setTab(id) } }, [id === 'versions' ? t('plugins.x.tab_versions') : t('plugins.tab.' + id), n ? el('em', { text: String(n) }) : null]));
    });
    main.appendChild(tl);
    const panel = el('div', { class: 'pgx-colm pgx-panel', id: 'pg-panel', role: 'tabpanel', 'aria-labelledby': 'pg-tab-' + mtab });
    const aside = el('aside', { class: 'pgx-aside', 'aria-label': t('plugins.x.details') });
    main.appendChild(el('div', { class: 'pgx-cols' }, [panel, aside]));
    const PANELS = new Map([['overview', panelOverview], ['settings', panelSettings], ['license', panelLicense], ['perms', panelPerms], ['log', panelLog], ['versions', panelVersions]]);
    const render = PANELS.get(mtab);
    if (typeof render === 'function') render(p, panel, c);
    manageAside(p, c, aside);
  }

  function problemBanner(p) {
    if (!P.isProblem(p)) return null;
    let action = null;
    if (p.reason === 'license') action = btn(t('plugins.banner.license_action'), { small: true, onClick: () => setTab('license') });
    else if (p.reason === 'unsigned') action = btn(t('plugins.banner.unsigned_action'), { small: true, href: U.security });
    else if (p.status === 'crashed') action = btn(t('plugins.x.restart'), { small: true, primary: true, onClick: async () => { await restart(p); await loadInstalled(); renderManage(); } });
    const title = p.status === 'crashed' ? t('plugins.state.crashed') : t(P.statusChip(p).key);
    return el('div', { class: 'pgx-banner', role: 'status', 'data-tone': p.reason === 'unsigned' ? 'warn' : 'crit' }, [icon(I.alert, 18),
      el('span', { class: 'pgx-grow' }, [el('b', { text: title + '. ' }), (p.status === 'crashed' ? t('plugins.note.crashed', { error: (p.process && p.process.lastError) || '' }) : t('plugins.reason.' + (p.reason || 'broken'))) + ' ' + t('plugins.banner.data_kept')]),
      action]);
  }

  function licenseHeadline(L) {
    if (L.source === 'plan' || L.source === 'lifetime') return t('plugins.lic.source_' + L.source);
    if (L.expiresAt) return t('plugins.x.until', { date: P.fmtDate(L.expiresAt, lang) });
    return L.state === 'valid' ? t('plugins.lic.unlimited') : t('plugins.lic.state.' + L.state);
  }

  function manageAside(p, c, aside) {
    const L = p.license || {};
    if (L.required) {
      aside.appendChild(card([
        el('div', { class: 'pgx-card-r' }, [lbl(t('plugins.tab.license')), el('span', { class: 'pgx-push' }, [pill(t('plugins.lic.state.' + L.state), P.licenseTone(L.state), true)])]),
        el('b', { class: 'pgx-big-v', text: licenseHeadline(L) }),
        el('small', { class: 'pgx-muted' }, [t('plugins.x.bound_here') + (L.keyMasked ? ' · ' + t('plugins.lic.key') + ' ' : ''), L.keyMasked ? el('span', { class: 'pgx-mono', text: L.keyMasked }) : null]),
        linkBtn(t('plugins.x.manage_license'), () => setTab('license')),
      ], null, 'pgx-pad pgx-stack-card'));
    }
    const pkgSize = c && c.latest && c.latest.version === p.version ? P.fmtBytes(c.latest.size) : null;
    aside.appendChild(card([lbl(t('plugins.x.details')), kv([
      [t('plugins.tile.version'), p.version + (c && c.state === 'update' && c.latest ? ' → ' + c.latest.version : (c ? ' · ' + t('plugins.x.current') : '')), true],
      [t('plugins.tile.installed'), P.fmtDate(p.installedAt, lang)],
      [t('plugins.x.updated'), P.fmtDate(p.updatedAt, lang)],
      pkgSize ? [t('plugins.x.size'), pkgSize] : null,
      [t('plugins.x.needs'), ['GateControl ' + rng(p.requires) + ' ', p.compatible ? el('span', { class: 'pgx-ok', text: '✓' }) : null]],
      [t('plugins.x.publisher'), p.publisher],
      [t('plugins.x.origin'), c ? t('plugins.x.source_official_short') : t('plugins.x.origin_upload')],
    ])], null, 'pgx-pad'));
    const sens = P.sensitivePerms(p.permissions);
    aside.appendChild(card([lbl(t('plugins.tab.perms')),
      el('span', { class: 'pgx-muted pgx-small', text: t('plugins.x.perms_granted', { n: P.permRows(p.permissions, t).length, s: sens.length }) }),
      sens.length ? el('span', { class: 'pgx-pills' }, sens.map((k) => pill(t(k), 'warn'))) : null,
      linkBtn(t('plugins.x.view_all'), () => setTab('perms'))], null, 'pgx-pad pgx-stack-card'));
    aside.appendChild(btn(t('plugins.detail.uninstall'), { danger: true, icon: I.trash, id: 'pg-uninstall', onClick: () => uninstallDialog(p) }));
  }

  async function panelOverview(p, panel, c) {
    const proc = p.process || {};
    const tile = (label, value, sub, tone, id, cls) => el('div', { class: 'pgx-card pgx-tile' + (cls ? ' ' + cls : '') }, [lbl(label), el('b', { id: id || null, 'data-tone': tone || null, text: value }), sub ? el('small', { text: sub }) : null]);
    const L = p.license || {};
    panel.appendChild(el('div', { class: 'pgx-tiles4' }, [
      tile(t('plugins.tile.status'), t(P.statusChip(p).key), p.status === 'running' && proc.startedAt ? t('plugins.x.since', { date: fmtDateTime(proc.startedAt) }) : '', P.statusChip(p).tone, null, 'pgx-hide-m'),
      L.required ? tile(t('plugins.tab.license'), licenseHeadline(L), null, P.licenseTone(L.state), null, 'pgx-only-m') : null,
      tile(t('plugins.x.data'), '…', t('plugins.x.data_d'), null, 'pg-storage'),
      tile(t('plugins.x.events24h'), String(p.events24h || 0), t('plugins.x.events24h_d')),
      tile(t('plugins.x.errors7d'), String(p.errors7d || 0), proc.crashes ? t('plugins.x.crashes', { n: proc.crashes }) : t('plugins.x.no_crashes'), p.errors7d ? 'warn' : null),
    ]));
    const adds = P.addRows(p, contrib[p.id], t);
    if (adds.length) {
      panel.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.adds_to', { name: p.name }), 'pgx-adds-h')])].concat(adds.map((a) => {
        let act = null;
        if (a.kind === 'page' && p.status === 'running') act = btn(t('plugins.x.open'), { href: '/plugins/' + enc(p.id), small: true });
        else if (a.kind === 'portal' && p.status === 'running') act = btn(t('plugins.x.open'), { href: '/portal', small: true, external: true });
        else if (a.kind === 'settings') act = btn(t('plugins.x.to_settings'), { small: true, onClick: () => setTab('settings') });
        return el('div', { class: 'pgx-sfc' }, [sic(a.icon), el('span', { class: 'pgx-t' }, [el('b', { text: a.title }), el('small', { text: a.text })]), act]);
      })), { 'aria-labelledby': 'pgx-adds-h' }, 'pgx-flush'));
    }
    const peers = [];
    (p.uses || []).forEach((id) => peers.push({ id, rel: 'uses' }));
    (p.usedBy || []).forEach((id) => { if (!peers.some((x) => x.id === id)) peers.push({ id, rel: 'used_by' }); });
    ((c && c.related) || []).forEach((id) => { if (!peers.some((x) => x.id === id)) peers.push({ id, rel: 'related' }); });
    if (peers.length) {
      panel.appendChild(card([el('div', { class: 'pgx-card-h pgx-card-h0' }, [h2(t('plugins.x.works_with'), 'pgx-dep-h'), el('span', { class: 'pgx-sec-s', text: t('plugins.x.works_with_d') })]),
        el('div', { class: 'pgx-deps' }, peers.map((d) => {
          const o = installedOf(d.id);
          const ci = catItem(d.id);
          const name = (o && o.name) || (ci && ci.name) || d.id;
          return el('a', { class: 'pgx-dep', href: o ? U.manage(d.id) : U.item(d.id), 'data-installed': o ? '1' : '0' }, [
            plugIcon(d.id, o, 'sm'),
            el('span', { class: 'pgx-t' }, [el('b', { text: name }), el('small', { text: (ci && ci.summary) ? ci.summary : t('plugins.x.rel_' + d.rel) })]),
            o ? el('span', { class: 'pgx-ok', 'aria-label': t('plugins.cat.state.installed') }, [icon(I.check, 16)]) : el('small', { class: 'pgx-muted', text: t('plugins.x.not_installed') }),
          ]);
        }))], { 'aria-labelledby': 'pgx-dep-h' }, 'pgx-pad pgx-stack-card'));
    }
    const logs = await req('GET', API + '/' + enc(p.id) + '/logs');
    if (logs.ok && logs.logs.length) {
      panel.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.recent'), 'pgx-log-h'), linkBtn(t('plugins.x.whole_log'), () => setTab('log'), { class: 'pgx-a pgx-push' })]),
        el('div', { class: 'pgx-mlog' }, logs.logs.slice(0, 5).map((e) => el('div', { 'data-level': e.level }, [el('b', { text: fmtTime(e.created_at) }), '  ' + e.message])))],
      { 'aria-labelledby': 'pgx-log-h' }, 'pgx-flush pgx-hide-m'));
    }
    const r = await req('GET', API + '/' + enc(p.id));
    const s = $('pg-storage');
    if (s && r.ok) {
      s.textContent = P.fmtBytes(r.plugin.storageBytes);
      // the database may grow up to this (plugin.json storage.maxMB, since 1.206.0)
      const sub = s.parentNode && s.parentNode.querySelector('small');
      if (sub && r.plugin.storageDbMaxBytes) sub.textContent = t('plugins.x.data_db_max', { max: P.fmtBytes(r.plugin.storageDbMaxBytes) });
    }
    if (p.media) await renderMedia(p, panel);
    if (p.media && p.media.areas) await renderAreas(p, panel);
  }

  function logList(entries) {
    const list = el('ol', { class: 'pg-log pgx-log', id: 'pg-log' });
    entries.forEach((e) => {
      let ts = '';
      try { ts = new Date(e.created_at).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { ts = ''; }
      list.appendChild(el('li', null, [el('span', { class: 'pg-log-t', text: ts }), el('span', { class: 'pg-log-l', 'data-level': e.level, text: e.level.toUpperCase() }), el('span', { class: 'pg-log-m', text: e.message })]));
    });
    if (!list.firstChild) list.appendChild(el('li', { class: 'pgx-muted', text: t('plugins.log.empty') }));
    return list;
  }

  async function panelLog(p, panel) {
    const r = await req('GET', API + '/' + enc(p.id) + '/logs');
    panel.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.tab.log'), 'pgx-plog-h')]), logList(r.ok ? r.logs : [])], { 'aria-labelledby': 'pgx-plog-h' }, 'pgx-flush'));
  }

  function panelPerms(p, panel) {
    const sens = P.sensitivePerms(p.permissions).map((k) => t(k));
    panel.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.tab.perms'), 'pgx-pp-h'), el('span', { class: 'pgx-sec-s', text: t('plugins.perm.intro') })])]
      .concat(P.permRows(p.permissions, t).map((r) => el('div', { class: 'pgx-perm', 'data-sensitive': sens.indexOf(r.label) >= 0 ? '1' : null }, [
        icon(sens.indexOf(r.label) >= 0 ? I.shield : I.perms, 19), el('span', { class: 'pgx-t' }, [el('b', { text: r.label }), el('small', { text: r.value })]),
        sens.indexOf(r.label) >= 0 ? pill(t('plugins.x.sensitive'), 'warn') : null]))), { 'aria-labelledby': 'pgx-pp-h' }, 'pgx-flush'));
    if (p.permissions && p.permissions.publicLinks) renderPublicLinks(p, panel);
  }

  // ── Öffentliche Links (permissions.publicLinks, since 1.193.0): the administrator's switch, default off ──
  async function renderPublicLinks(p, panel) {
    const r = await req('GET', API + '/' + enc(p.id) + '/public-links');
    if (!r.ok || !r.publicLinks) return;
    const L = r.publicLinks;
    const old = $('pg-public-links');
    if (old) old.remove();
    const box = el('section', { class: 'pgx-card pgx-pad pgx-stack-card', id: 'pg-public-links', 'aria-labelledby': 'pg-pl-title' });
    box.appendChild(h2(t('plugins.pl.title'), 'pg-pl-title'));
    const psw = sw(L.allowed, t('plugins.pl.switch'), async () => {
      const on = psw.getAttribute('aria-checked') !== 'true';
      const res = await req('PUT', API + '/' + enc(p.id) + '/public-links', { allowed: on });
      if (!res.ok) { toast(res.error, 'error'); return; }
      psw.setAttribute('aria-checked', on ? 'true' : 'false');
      toast(t(on ? 'plugins.pl.on' : 'plugins.pl.off'));
    }, 'pg-public-links-sw');
    box.appendChild(el('div', { class: 'st-row' }, [
      el('div', { class: 'st-row-text' }, [el('label', { class: 'st-label', for: 'pg-public-links-sw', text: t('plugins.pl.switch') }),
        el('span', { class: 'st-hint', text: t('plugins.pl.hint') })]),
      el('div', { class: 'st-row-ctl' }, [psw]),
    ]));
    // since 1.205.0: links without an end date, only with this second switch (default off)
    const usw = sw(L.unlimited, t('plugins.pl.unlimited'), async () => {
      const on = usw.getAttribute('aria-checked') !== 'true';
      const res = await req('PUT', API + '/' + enc(p.id) + '/public-links', { unlimited: on });
      if (!res.ok) { toast(res.error, 'error'); return; }
      usw.setAttribute('aria-checked', on ? 'true' : 'false');
      toast(t(on ? 'plugins.pl.unlimited_on' : 'plugins.pl.unlimited_off'));
    }, 'pg-public-links-unl');
    box.appendChild(el('div', { class: 'st-row' }, [
      el('div', { class: 'st-row-text' }, [el('label', { class: 'st-label', for: 'pg-public-links-unl', text: t('plugins.pl.unlimited') }),
        el('span', { class: 'st-hint', text: t('plugins.pl.unlimited_hint') })]),
      el('div', { class: 'st-row-ctl' }, [usw]),
    ]));
    if (!L.publicUrl) box.appendChild(el('p', { class: 'pgx-muted', id: 'pg-public-links-nourl', text: t('plugins.pl.no_url') }));
    box.appendChild(el('p', { class: 'pgx-muted pgx-small', text: t('plugins.pl.active', { n: L.active }) }));
    panel.appendChild(box);
  }

  async function panelVersions(p, panel) {
    const r = await req('GET', CAT_API + '/' + enc(p.id));
    if (!r.ok) { panel.appendChild(el('p', { class: 'pgx-muted', text: r.error })); return; }
    panel.appendChild(versionsCard(r.plugin.versions || [], p.version, null));
  }

  // ── Built-in data import (first-party plugin of a former built-in feature) ──
  function datasetName(ds) {
    const k = 'plugins.legacy.dataset.' + ds;
    const s = t(k);
    return s === k ? ds : s;
  }
  function legacySummary(counts) {
    return Object.keys(counts || {}).filter((k) => counts[k] > 0).map((k) => counts[k] + ' ' + t('plugins.legacy.count.' + k)).join(', ');
  }
  async function renderLegacy(p, slot) {
    const r = await req('GET', API + '/' + enc(p.id) + '/legacy');
    if (!r.ok || !r.legacy) return;
    const L = r.legacy;
    if (!L.available && !L.imported) return;
    const box = el('section', { class: 'pgx-banner pg-legacy', id: 'pg-legacy', role: 'region', 'aria-labelledby': 'pg-legacy-title', 'data-tone': L.imported ? 'good' : 'warn' });
    const text = el('span', { class: 'pgx-grow' }, [el('b', { id: 'pg-legacy-title', text: t('plugins.legacy.title') + '. ' })]);
    box.appendChild(text);
    if (L.imported) text.appendChild(document.createTextNode(t('plugins.legacy.done', { date: P.fmtDate(L.imported.at, lang), summary: legacySummary(L.imported.counts) }) + ' '));
    else text.appendChild(document.createTextNode(t('plugins.legacy.offer', { dataset: datasetName(L.dataset), summary: legacySummary(L.counts) }) + ' '));
    let blocked = null;
    if (!L.eligible) blocked = t('plugins.legacy.unsigned');
    else if (L.available && !L.running) blocked = t('plugins.legacy.not_running');
    if (blocked) text.appendChild(el('span', { class: 'pgx-muted', text: blocked }));
    if (L.eligible && L.available && L.running) {
      if (L.imported) text.appendChild(el('span', { class: 'pgx-muted', text: t('plugins.legacy.rerun_hint') + ' ' }));
      box.appendChild(el('button', { type: 'button', class: 'st-btn st-btn-sm' + (L.imported ? '' : ' st-btn-primary'), id: 'pg-legacy-go',
        text: t(L.imported ? 'plugins.legacy.rerun' : 'plugins.legacy.go'), on: { click: async (e) => {
          if (!(await D.confirm({ title: t('plugins.legacy.confirm_title'), message: t('plugins.legacy.confirm_text'), okLabel: t('plugins.legacy.go') }))) return;
          const b = e.target;
          b.disabled = true;
          const res = await req('POST', API + '/' + enc(p.id) + '/legacy/import', { confirm: true });
          b.disabled = false;
          if (!res.ok) { toast(res.error, 'error'); return; }
          toast(t('plugins.legacy.ok', { summary: legacySummary(res.counts) }));
          renderManage();
        } } }));
    }
    clear(slot);
    slot.appendChild(box);
  }

  // ── Medien (plugin.json `media`): usage and the quota an administrator sets ──
  async function renderMedia(p, panel) {
    const r = await req('GET', API + '/' + enc(p.id) + '/media/settings');
    if (!r.ok || !r.media) return;
    const m = r.media;
    const old = $('pg-media');
    if (old) old.remove();
    const box = el('section', { class: 'pgx-card pgx-pad pgx-stack-card', id: 'pg-media', 'aria-labelledby': 'pg-media-title' });
    box.appendChild(h2(t('plugins.media.title'), 'pg-media-title'));
    box.appendChild(el('p', { class: 'pgx-muted', id: 'pg-media-usage', text: t('plugins.media.usage', { used: P.fmtBytes(m.usage.bytes), quota: P.fmtBytes(m.quota), count: m.usage.count }) }));
    box.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.media.limits', { max: P.fmtBytes(m.maxBytes), types: P.mediaTypes(m.types) }) }));
    const gb = el('input', { type: 'number', class: 'st-input st-input-num', id: 'pg-media-quota', min: 0.001, max: m.areas ? 1048576 : 1024, step: 'any',
      value: String(Math.round((m.quota / (1024 * 1024 * 1024)) * 1000) / 1000) });
    const save = async (quotaBytes) => {
      const res = await req('PUT', API + '/' + enc(p.id) + '/media/settings', { quotaBytes });
      if (!res.ok) { toast(res.error, 'error'); return; }
      toast(t('plugins.media.saved'));
      await renderMedia(p, panel);
    };
    box.appendChild(el('div', { class: 'pgx-inline' }, [
      el('label', { class: 'st-label', for: 'pg-media-quota', text: t('plugins.media.quota') }), gb,
      el('button', { type: 'button', class: 'st-btn st-btn-primary st-btn-sm', text: t('plugins.media.save'), on: { click: () => save(Math.round(Number(gb.value) * 1024 * 1024 * 1024)) } }),
      el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('plugins.media.reset', { quota: P.fmtBytes(m.quotaDefault) }), on: { click: () => save(null) } }),
    ]));
    panel.appendChild(box);
  }

  // ── Speicherorte (plugin.json media.areas): where each area of the plugin keeps its files ──
  const GB = 1024 * 1024 * 1024;
  function areaState(a) {
    if (a.state === 'unreachable') return pill(t('plugins.areas.st_unreachable'), 'crit', true);
    if (a.state === 'moving') return pill(t('plugins.areas.st_moving', { done: a.moving.done, total: a.moving.total }), 'blue', true);
    if (a.state === 'pending') return pill(t('plugins.areas.st_pending', { count: a.pending.count }), 'warn', true);
    return pill(t(a.target.id == null ? 'plugins.areas.st_server' : 'plugins.areas.st_ok'), 'good', true);
  }

  /** Readable areas: the last look for changes on the NAS, "Jetzt abgleichen", the mass-removal guard. */
  function scanLine(p, a, rerender) {
    const sc = a.scan;
    const st = sc.stats;
    const txt = sc.at ? t('plugins.areas.scan_at', { at: fmtDateTime(sc.at), files: st ? st.files : 0, added: st ? st.added : 0, changed: st ? st.changed : 0, removed: st ? st.removed : 0 })
      : t('plugins.areas.scan_never');
    const base = API + '/' + enc(p.id) + '/media/areas/' + enc(a.area);
    const run = async (e, url, okKey) => {
      const b = e.currentTarget;
      b.disabled = true;
      const res = await req('POST', url, {});
      b.disabled = false;
      if (!res.ok) { toast(res.error, 'error'); return; }
      toast(t(okKey));
      await rerender();
    };
    const kids = [el('small', { class: 'pgx-muted', text: txt }),
      btn(t('plugins.areas.scan_now'), { small: true, ghost: true, icon: I.refresh, action: 'scan', onClick: (e) => run(e, base + '/scan', 'plugins.areas.scan_done') })];
    const out = [el('div', { class: 'pgx-inline pgx-area-scan' }, kids)];
    if (sc.error === 'mass_missing') {
      out.push(el('div', { class: 'pgx-area-warn', role: 'alert' }, [
        el('p', { text: t('plugins.areas.mass_missing', { count: st ? st.missing : 0 }) }),
        btn(t('plugins.areas.mass_confirm'), { small: true, danger: true, action: 'confirm-removals', onClick: async (e) => {
          const target = e.currentTarget;
          if (!(await D.confirm({ title: t('plugins.areas.mass_title', { name: a.label }), message: t('plugins.areas.mass_text', { count: st ? st.missing : 0 }), okLabel: t('plugins.areas.mass_confirm'), danger: true }))) return;
          await run({ currentTarget: target }, base + '/confirm-removals', 'plugins.areas.scan_done');
        } }),
      ]));
    } else if (sc.error) {
      out.push(el('p', { class: 'pgx-stg-err', text: stgErrorText(sc.error) }));
    }
    return el('div', { class: 'pgx-area-scanbox' }, out);
  }

  async function renderAreas(p, panel) {
    const r = await req('GET', API + '/' + enc(p.id) + '/media/areas');
    if (!r.ok) return;
    const old = $('pg-areas');
    const box = el('section', { class: 'pgx-card pgx-pad pgx-stack-card', id: 'pg-areas', 'aria-labelledby': 'pg-areas-title' });
    box.appendChild(h2(t('plugins.areas.title'), 'pg-areas-title'));
    box.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.areas.intro') }));
    const rerender = () => renderAreas(p, panel);
    const put = async (area, body, okText) => {
      const res = await req('PUT', API + '/' + enc(p.id) + '/media/areas/' + enc(area), body);
      if (!res.ok) { toast(res.error, 'error'); return; }
      toast(okText);
      await rerender();
    };
    if (!r.areas.length) box.appendChild(el('p', { class: 'pgx-muted', id: 'pg-areas-empty', text: t('plugins.areas.empty') }));
    const list = el('div', { class: 'pgx-area-list', id: 'pg-areas-list' });
    for (const a of r.areas) {
      const cur = a.moving ? a.moving.to.id : a.target.id;
      const sel = el('select', { class: 'st-select', 'aria-label': t('plugins.areas.where_l', { name: a.label }), 'data-area': a.area },
        [el('option', { value: '', text: t('plugins.areas.server') })].concat(r.targets.map((tg) => el('option', { value: String(tg.id), text: tg.label + ' · ' + t('plugins.stg.kind_' + tg.kind) }))));
      sel.value = cur == null ? '' : String(cur);
      sel.addEventListener('change', async () => {
        const targetId = sel.value === '' ? null : Number(sel.value);
        if (a.count && !(await D.confirm({ title: t('plugins.areas.move_title', { name: a.label }), message: t('plugins.areas.move_text', { count: a.count, size: P.fmtBytes(a.bytes) }), okLabel: t('plugins.areas.move_ok') }))) {
          sel.value = cur == null ? '' : String(cur);
          return;
        }
        await put(a.area, { targetId }, t(a.count ? 'plugins.areas.moving_started' : 'plugins.areas.saved'));
      });
      const quota = el('input', { type: 'number', class: 'st-input st-input-num', min: 0.001, max: 1048576, step: 'any', 'aria-label': t('plugins.areas.quota_l', { name: a.label }),
        value: a.quota == null ? '' : String(Math.round((a.quota / GB) * 1000) / 1000), placeholder: t('plugins.areas.quota_none') });
      const used = t('plugins.areas.usage', { size: P.fmtBytes(a.bytes), count: a.count }) + (a.quota != null ? ' · ' + t('plugins.areas.of_quota', { quota: P.fmtBytes(a.quota) }) : '')
        + (a.free != null ? ' · ' + t('plugins.areas.free', { free: P.fmtBytes(a.free) }) : '');
      // the form (since 1.204.1): readable files or sealed blocks — only on a folder / NAS
      const curTarget = r.targets.find((tg) => tg.id === cur);
      const form = el('select', { class: 'st-select', 'aria-label': t('plugins.areas.form_l', { name: a.label }), 'data-form': a.area, hidden: !(curTarget && curTarget.files) },
        ['files', 'blocks'].map((f) => el('option', { value: f, text: t('plugins.areas.form_' + f) })));
      form.value = a.form;
      form.addEventListener('change', async () => {
        if (a.count && !(await D.confirm({ title: t('plugins.areas.form_title', { name: a.label }), message: t('plugins.areas.form_text_' + form.value, { count: a.count }), okLabel: t('plugins.areas.move_ok') }))) {
          form.value = a.form;
          return;
        }
        await put(a.area, { form: form.value }, t(a.count ? 'plugins.areas.moving_started' : 'plugins.areas.saved'));
      });
      const scanBox = a.scan ? scanLine(p, a, rerender) : null;
      list.appendChild(el('div', { class: 'pgx-area', 'data-area': a.area, 'data-state': a.state }, [
        el('div', { class: 'pgx-area-head' }, [
          el('span', { class: 'pgx-t pgx-grow' }, [el('b', { text: a.label }), el('small', { class: 'pgx-muted', text: used })]),
          el('span', { class: 'pgx-stg-state' }, [areaState(a), a.encrypted ? pill(t('plugins.stg.encrypted'), 'blue') : pill(t('plugins.areas.readable'), 'mute')]),
        ]),
        a.state === 'unreachable' && a.error ? el('p', { class: 'pgx-stg-err', text: stgErrorText(a.error) }) : null,
        scanBox,
        el('div', { class: 'pgx-inline pgx-area-ctl' }, [
          el('label', { class: 'st-label', text: t('plugins.areas.where') }), sel, form,
          el('label', { class: 'st-label', text: t('plugins.areas.quota') }), quota,
          btn(t('plugins.media.save'), { small: true, primary: true, action: 'quota', onClick: () => {
            const v = quota.value.trim();
            put(a.area, { quotaBytes: v === '' ? null : Math.round(Number(v) * GB) }, t('plugins.areas.quota_saved'));
          } }),
        ]),
      ]));
    }
    if (r.areas.length) box.appendChild(list);
    const c = r.cache;
    box.appendChild(el('p', { class: 'pgx-hint', id: 'pg-areas-cache', text: t('plugins.areas.cache', { cached: P.fmtBytes(c.cached), limit: P.fmtBytes(c.limit), pending: P.fmtBytes(c.pending) }) }));
    box.appendChild(el('div', { class: 'pgx-inline' }, [
      btn(t('plugins.stg.add'), { small: true, icon: I.plus, id: 'pg-areas-add', onClick: async () => { if (await targetDialog(null)) await rerender(); } }),
      btn(t('plugins.areas.manage'), { small: true, ghost: true, href: U.storage }),
    ]));
    if (old) old.replaceWith(box); else panel.appendChild(box);
  }

  // ── Zugriffsziele (home-network targets the plugin declared) ──
  async function renderTargets(p, panel) {
    const r = await req('GET', API + '/' + enc(p.id) + '/targets');
    if (!r.ok || (!r.declared.length && !r.discovery)) return;
    const box = el('section', { class: 'pgx-card pgx-pad pgx-stack-card', id: 'pg-targets', 'aria-labelledby': 'pg-tg-title' });
    box.appendChild(h2(t('plugins.tg.title'), 'pg-tg-title'));
    box.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.tg.intro') }));
    for (const d of r.declared) {
      const isHttp = d.protocols.indexOf('http') >= 0;
      const row = el('div', { class: 'pg-target', 'data-target': d.id });
      row.appendChild(el('div', { class: 'pg-target-head' }, [el('b', { text: d.label }), el('span', { class: 'pgx-muted', text: ' ' + d.protocols.map(P.protoText).join(' · ') })]));
      const list = el('ul', { class: 'pg-target-list' });
      const save = async (assigned) => {
        const res = await req('PUT', API + '/' + enc(p.id) + '/targets/' + enc(d.id), { assigned });
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast(t('plugins.tg.saved'));
        clear(panel);
        await panelSettings(p, panel);
      };
      const strip = (a) => { const o = Object.assign({}, a); delete o.display; return o; };
      if (!d.assigned.length) list.appendChild(el('li', { class: 'pgx-muted', text: t('plugins.tg.none') }));
      d.assigned.forEach((a, i) => list.appendChild(el('li', null, [
        pill(t('plugins.tg.kind_' + a.kind), 'off'), el('span', { class: 'st-mono', text: a.display }),
        el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('plugins.tg.remove'), on: { click: () => save(d.assigned.filter((_, j) => j !== i).map(strip)) } }),
      ])));
      row.appendChild(list);
      const kind = el('select', { class: 'st-select', 'aria-label': t('plugins.tg.title') }, ['route', 'peer', 'host'].map((k) => el('option', { value: k, text: t('plugins.tg.kind_' + k) })));
      const routes = r.choices.routes.filter((x) => (isHttp ? x.type === 'http' : x.type === 'l4'));
      const routeSel = el('select', { class: 'st-select' }, routes.map((x) => el('option', { value: String(x.id), text: x.label + (x.internal ? ' · ' + t('plugins.tg.internal') : '') })));
      const peerSel = el('select', { class: 'st-select' }, r.choices.peers.map((x) => el('option', { value: String(x.id), text: x.label + ' (' + x.ip + ')' })));
      const hostIn = el('input', { type: 'text', class: 'st-input st-mono', placeholder: t('plugins.tg.host_ph'), maxLength: 253, spellcheck: 'false', autocomplete: 'off' });
      const portIn = el('input', { type: 'number', class: 'st-input st-input-num', placeholder: t('plugins.tg.port'), min: 1, max: 65535 });
      const schemeSel = el('select', { class: 'st-select' }, ['http', 'https'].map((k) => el('option', { value: k, text: k.toUpperCase() })));
      const sync = () => { routeSel.hidden = kind.value !== 'route'; peerSel.hidden = kind.value !== 'peer'; hostIn.hidden = kind.value !== 'host'; portIn.hidden = kind.value === 'route'; schemeSel.hidden = !isHttp || kind.value === 'route'; };
      kind.addEventListener('change', sync);
      sync();
      const add = el('button', { type: 'button', class: 'st-btn st-btn-primary st-btn-sm', text: t('plugins.tg.add'), on: { click: () => {
        let a;
        if (kind.value === 'route') a = { kind: 'route', routeId: Number(routeSel.value) };
        else if (kind.value === 'peer') a = { kind: 'peer', peerId: Number(peerSel.value), port: portIn.value || null, scheme: schemeSel.value };
        else a = { kind: 'host', host: hostIn.value.trim(), port: portIn.value || null, scheme: schemeSel.value };
        save((d.multiple ? d.assigned.map(strip) : []).concat([a]));
      } } });
      row.appendChild(el('div', { class: 'pgx-inline' }, [kind, routeSel, peerSel, hostIn, portIn, schemeSel, add]));
      box.appendChild(row);
    }
    if (r.discovery) {
      const dsw = sw(r.discovery.granted, t('plugins.tg.discovery'), async () => {
        const on = dsw.getAttribute('aria-checked') !== 'true';
        const res = await req('PUT', API + '/' + enc(p.id) + '/discovery', { granted: on });
        if (!res.ok) { toast(res.error, 'error'); return; }
        dsw.setAttribute('aria-checked', on ? 'true' : 'false');
      }, 'pg-discovery');
      box.appendChild(el('div', { class: 'st-row pg-target' }, [
        el('div', { class: 'st-row-text' }, [el('label', { class: 'st-label', for: 'pg-discovery', text: t('plugins.tg.discovery') }),
          el('span', { class: 'st-hint', text: t('plugins.tg.discovery_hint', { ports: r.discovery.udp.join(', ') }) })]),
        el('div', { class: 'st-row-ctl' }, [dsw]),
      ]));
    }
    panel.appendChild(box);
  }

  /**
   * The plugin's own settings page (plugin.json ui.settingsPage, since 1.188.0): its sandboxed
   * frame like on the plugin's page (public/js/plugin-bridge.js forwards its API calls), above
   * the declared settings — only while the plugin runs.
   */
  function settingsFrame(p) {
    const f = document.createElement('iframe');
    const attrs = {
      class: 'pg-frame pgx-set-frame', id: 'pg-settings-frame', title: p.settingsPage.title || p.name,
      src: '/plugins/' + enc(p.id) + '/frame/' + enc(p.settingsPage.id),
      sandbox: 'allow-scripts allow-forms' + (p.maps ? ' allow-popups allow-popups-to-escape-sandbox' : '') + (p.media ? ' allow-downloads' : ''),
      referrerpolicy: 'no-referrer', 'data-plugin-frame': '', 'data-plugin-id': p.id, 'data-plugin-api': '/api/v1/plugins/' + p.id + '/api/',
      'data-plugin-pages': JSON.stringify((p.pages || []).map((x) => x.id)),
    };
    if (p.allow) attrs.allow = p.allow;
    if (p.events) attrs['data-plugin-events'] = '';
    if (p.scanQr) { attrs['data-plugin-scanqr'] = ''; attrs['data-plugin-name'] = p.name || p.id; }
    // GC.pickPrincipals (permissions.groups): GateControl's picker for groups and people
    if (p.pickPrincipals) { attrs['data-plugin-groups'] = ''; attrs['data-plugin-name'] = p.name || p.id; }
    Object.keys(attrs).forEach((k) => f.setAttribute(k, attrs[k]));
    if (window.GCPluginBridge && typeof window.GCPluginBridge.attach === 'function') window.GCPluginBridge.attach(f);
    return card([f], { 'aria-label': p.settingsPage.title || p.name }, 'pgx-set-frame-card');
  }

  async function panelSettings(p, panel) {
    await renderTargets(p, panel);
    if (p.settingsPage && p.status === 'running') panel.appendChild(settingsFrame(p));
    const box = card([h2(t('plugins.tab.settings'), 'pgx-set-h'), el('p', { class: 'pgx-muted', text: t('plugins.settings.hint') })], { 'aria-labelledby': 'pgx-set-h' }, 'pgx-pad pgx-stack-card');
    panel.appendChild(box);
    const r = await req('GET', API + '/' + enc(p.id) + '/settings');
    if (!r.ok) { box.appendChild(el('p', { class: 'st-err-block', text: r.error })); return; }
    if (!r.defs.length) {
      if (p.settingsPage) box.remove(); // the plugin's own settings page is all there is
      else box.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.settings.none') }));
      return;
    }
    const form = el('form', { class: 'pg-form', id: 'pg-settings-form', novalidate: true, autocomplete: 'off' });
    const inputs = {};
    // status lines of the plugin (hook settingsStatus): above the form or under a group heading
    const TONES = { ok: 'good', info: 'blue', warn: 'warn', error: 'crit' };
    const statusSlots = new Map();
    const statusSlot = (gid) => {
      const slot = el('div', { class: 'pgx-set-st', 'data-group': gid || '', role: 'status', 'aria-live': 'polite' });
      statusSlots.set(gid || '', slot);
      return slot;
    };
    const showStatus = (lines) => {
      for (const [gid, slot] of statusSlots) {
        slot.replaceChildren(...(lines || []).filter((x) => (x.group || '') === gid).map((x) => el('p', { class: 'pgx-set-line', 'data-tone': TONES[x.tone] || 'blue', text: x.text })));
      }
    };
    form.appendChild(statusSlot(null));
    const groups = r.groups || [];
    const sections = [{ id: null, defs: r.defs.filter((d) => !d.group || !groups.some((g) => g.id === d.group)) }]
      .concat(groups.map((g) => ({ id: g.id, g, defs: r.defs.filter((d) => d.group === g.id) })));
    for (const sec of sections) {
      if (sec.g) {
        form.appendChild(el('div', { class: 'pgx-set-group' }, [
          el('h3', { class: 'pgx-set-gh', text: sec.g.label }),
          sec.g.help ? el('p', { class: 'pgx-muted pgx-set-gd', text: sec.g.help }) : null,
          statusSlot(sec.id),
        ]));
      }
      for (const d of sec.defs) {
      const id = 'pg-set-' + d.key.replace(/[^a-z0-9_-]/g, '_');
      const v = r.values[d.key];
      let ctl;
      if (d.type === 'boolean') {
        ctl = el('button', { type: 'button', class: 'st-switch', role: 'switch', id, 'aria-checked': v ? 'true' : 'false', on: { click: () => ctl.setAttribute('aria-checked', ctl.getAttribute('aria-checked') === 'true' ? 'false' : 'true') } }, [el('span', { class: 'st-knob', 'aria-hidden': 'true' })]);
      } else if (d.type === 'select') {
        ctl = el('select', { class: 'st-select', id }, (d.options || []).map((o) => { const op = el('option', { value: o.value, text: o.label }); if (o.value === v) op.selected = true; return op; }));
      } else if (d.type === 'secret') {
        ctl = el('input', { type: 'password', class: 'st-input', id, autocomplete: 'new-password', placeholder: v && v.set ? t('plugins.settings.secret_set') : '' });
      } else {
        ctl = el('input', { type: d.type === 'number' ? 'number' : 'text', class: 'st-input', id, value: v == null ? '' : String(v), maxLength: 1000 });
        if (d.min != null) ctl.min = d.min;
        if (d.max != null) ctl.max = d.max;
      }
      inputs[d.key] = { d, ctl };
      form.appendChild(el('div', { class: 'st-row' }, [
        el('div', { class: 'st-row-text' }, [el('label', { class: 'st-label', for: id, text: d.label }), d.help ? el('span', { class: 'st-hint', text: d.help }) : null,
          el('span', { class: 'st-err', id: id + '-err', role: 'alert', hidden: true })]),
        el('div', { class: 'st-row-ctl' }, [ctl]),
      ]));
      }
    }
    showStatus(r.status);
    const msg = el('span', { class: 'st-foot-msg', role: 'status' });
    form.appendChild(el('div', { class: 'pg-formfoot' }, [msg, el('button', { type: 'submit', class: 'st-btn st-btn-primary', id: 'pg-settings-save', text: t('plugins.settings.save') })]));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      for (const [k, { d, ctl }] of Object.entries(inputs)) {
        if (d.type === 'boolean') values[k] = ctl.getAttribute('aria-checked') === 'true';
        else if (d.type === 'number') values[k] = ctl.value === '' ? null : Number(ctl.value);
        else if (d.type === 'secret') { if (ctl.value) values[k] = ctl.value; }
        else values[k] = ctl.value === '' ? null : ctl.value;
      }
      const save = $('pg-settings-save');
      save.disabled = true;
      msg.textContent = t('plugins.settings.saving');
      const res = await req('PUT', API + '/' + enc(p.id) + '/settings', { values });
      save.disabled = false;
      form.querySelectorAll('.st-err').forEach((n) => { n.textContent = ''; n.hidden = true; });
      if (res.ok) {
        msg.textContent = '';
        // secrets are never shown again: empty the fields, the placeholder says one is set
        for (const { d, ctl } of Object.values(inputs)) {
          if (d.type === 'secret') { const set = res.values && res.values[d.key] && res.values[d.key].set; ctl.value = ''; ctl.placeholder = set ? t('plugins.settings.secret_set') : ''; }
        }
        showStatus(res.status);
        toast(t('plugins.settings.saved'));
        return;
      }
      if (res.fields) {
        for (const k of Object.keys(res.fields)) {
          const n = inputs[k] && $(inputs[k].ctl.id + '-err');
          if (n) { n.textContent = t('plugins.settings.invalid'); n.hidden = false; }
        }
      }
      msg.textContent = res.error || t('plugins.err.generic');
    });
    box.appendChild(form);
  }

  function panelLicense(p, panel) {
    const L = p.license || {};
    const box = card([h2(t('plugins.tab.license'), 'pgx-lic-h')], { 'aria-labelledby': 'pgx-lic-h' }, 'pgx-pad pgx-stack-card');
    panel.appendChild(box);
    if (!L.required) { box.appendChild(el('p', { class: 'pgx-muted', id: 'pg-lic-none', text: t('plugins.lic.not_required') })); return; }
    const dl = el('dl', { class: 'pg-dl' });
    const row = (k, v, tone) => { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { 'data-state': tone || null, text: v || '—' })); };
    row(t('plugins.lic.status'), t('plugins.lic.state.' + L.state), P.licenseTone(L.state));
    if (L.source === 'plan' || L.source === 'lifetime') row(t('plugins.lic.kind'), t('plugins.lic.source_' + L.source), 'good');
    row(t('plugins.lic.key'), L.keyMasked || (L.source === 'plan' ? t('plugins.lic.no_key_needed') : ''));
    row(t('plugins.lic.valid_until'), L.expiresAt ? P.fmtDate(L.expiresAt, lang) : (L.state === 'valid' ? t('plugins.lic.unlimited') : ''));
    if (L.updatesUntil) row(t('plugins.lic.updates_until'), P.fmtDate(L.updatesUntil, lang));
    // tier and people of the licence (since 1.206.0, e.g. GateControl Drive)
    if (L.tier) {
      row(t('plugins.lic.tier'), t('plugins.lic.tier_' + L.tier));
      const S = L.seats || { included: 0, family: 0, business: 0 };
      const extra = L.tier === 'family' ? S.family : (L.tier === 'business' ? S.business : S.family + S.business);
      row(t('plugins.lic.seats'), extra ? t('plugins.lic.seats_extra', { n: S.included + extra, included: S.included, extra }) : t('plugins.lic.seats_n', { n: S.included }));
    }
    row(t('plugins.lic.source'), L.kind === 'first_party' ? t('plugins.lic.source_gc') : (L.server || ''));
    const input = el('input', { type: 'text', class: 'st-input st-mono', id: 'pg-lic-key', placeholder: t('plugins.lic.placeholder'), maxLength: 200, autocomplete: 'off', spellcheck: 'false' });
    const msg = el('p', { class: 'pgx-muted', id: 'pg-lic-msg', role: 'status' });
    const after = async () => { await loadInstalled(); renderManage(); updateNav(); };
    const save = el('button', { type: 'button', class: 'st-btn st-btn-primary st-btn-sm', id: 'pg-lic-save', text: t('plugins.lic.save'), on: { click: async () => {
      const r = await req('PUT', API + '/' + enc(p.id) + '/license', { key: input.value });
      if (!r.ok) { msg.textContent = r.error; return; }
      if (r.license.coveredBy) toast(t('plugins.lic.covered_' + r.license.coveredBy));
      else toast(t('plugins.lic.state.' + r.license.state));
      await after();
    } } });
    const check = el('button', { type: 'button', class: 'st-btn st-btn-sm', id: 'pg-lic-check', text: t('plugins.lic.check'), on: { click: async () => {
      const r = await req('POST', API + '/' + enc(p.id) + '/license/check', {});
      if (!r.ok) { msg.textContent = r.error; return; }
      toast(t('plugins.lic.state.' + r.license.state));
      await after();
    } } });
    // first-party, no entitlement: the plugin may be newer than the last daily
    // validation of the GateControl licence → revalidate it now
    // (POST /api/v1/license/refresh; its cooldown answers 429 with a message)
    let refreshBox = null;
    if (L.kind === 'first_party' && L.state === 'missing') {
      const refresh = el('button', { type: 'button', class: 'st-btn st-btn-primary st-btn-sm', id: 'pg-lic-refresh', text: t('plugins.lic.refresh'), on: { click: async () => {
        msg.textContent = '';
        refresh.disabled = true;
        const r = await req('POST', '/api/v1/license/refresh', {});
        refresh.disabled = false;
        if (!r.ok) { msg.textContent = r.error || t('plugins.err.generic'); return; }
        await loadInstalled();
        const now = installedOf(p.id);
        const st = now && now.license ? now.license.state : 'missing';
        renderManage();
        const m = $('pg-lic-msg');
        if (st === 'missing') { if (m) m.textContent = t('plugins.lic.refresh_still_missing'); } else toast(t('plugins.lic.state.' + st));
      } } });
      refreshBox = el('div', { class: 'pg-lic-refresh', id: 'pg-lic-refresh-box' }, [el('p', { class: 'pgx-muted', role: 'note', text: t('plugins.lic.refresh_hint') }), el('div', { class: 'st-btnrow' }, [refresh])]);
    }
    box.appendChild(el('div', { class: 'pg-lic' }, [dl, el('div', { class: 'pg-lic-form' }, [
      refreshBox,
      el('label', { class: 'st-label', for: 'pg-lic-key', text: t('plugins.lic.enter') }), input,
      el('div', { class: 'st-btnrow pgx-mt' }, [save, check]),
      el('p', { class: 'pgx-muted', text: L.kind === 'first_party' ? t(L.source === 'plan' ? 'plugins.lic.hint_plan' : 'plugins.lic.hint_gc') : t('plugins.lic.hint_third', { server: L.server || '' }) }),
      L.coveredBy ? el('p', { class: 'pgx-muted', id: 'pg-lic-covered', role: 'note', text: t('plugins.lic.covered_' + L.coveredBy) }) : null,
      msg,
    ])]));
  }


  // ════════════════════════════════════════════════════════════
  // Updates
  // ════════════════════════════════════════════════════════════
  async function viewUpdates() {
    const [, r] = await Promise.all([loadInstalled(), req('GET', CAT_API + '/updates')]);
    await loadCatalog(false);
    renderUpdates(r);
    done();
  }

  const KIND_TONE = { patch: 'good', minor: 'blue', major: 'warn', replace: 'blue' };

  function historyRow(h) {
    return el('div', { class: 'pgx-hist', 'data-action': h.action }, [
      el('span', { class: 'pgx-mono pgx-hist-d', text: fmtDay(h.at) }),
      el('span', { class: 'pgx-t pgx-t-row' }, [el('b', { text: h.name || h.id }), ' ', el('span', { class: 'pgx-mono pgx-muted', text: h.action === 'uninstall' ? t('plugins.x.h_uninstalled') : (h.action === 'replace' ? t('plugins.x.h_replaced', { name: h.replacedBy || h.source || '' }) : (h.from ? h.from + ' → ' + h.to : h.to)) })]),
      pill(h.by === 'auto' ? t('plugins.x.h_auto') : (h.user ? t('plugins.x.h_by', { name: h.user }) : t('plugins.x.h_admin')), 'mute'),
      h.action !== 'uninstall' && h.action !== 'replace' && catItem(h.id) ? link(t('plugins.x.notes'), U.item(h.id, 'tab=versions'), { class: 'pgx-a pgx-small' }) : null,
    ]);
  }

  function renderUpdates(r) {
    clear(main);
    const ups = (r && r.updates) || [];
    main.appendChild(pageHead(t('plugins.area.updates'), [
      ups.length ? t('plugins.x.n_ready', { n: ups.length }) : t('plugins.x.all_current'),
      cat.fetchedAt ? ' · ' + t('plugins.x.checked_ago', { ago: ago(cat.fetchedAt) }) + ' · ' : ' · ',
      linkBtn(t('plugins.x.check_now'), async (e) => {
        e.currentTarget.disabled = true;
        const nr = await req('GET', CAT_API + '/updates?refresh=1');
        // a refused check (rate limit, unreachable) says so — never „all current“ from an error
        if (!nr.ok) { e.currentTarget.disabled = false; toast(nr.error || t('plugins.cat.unreachable'), 'error'); return; }
        await loadCatalog(false);
        renderUpdates(nr);
        updateNav();
        toast(t('plugins.cat.refreshed'));
      }, { id: 'pgx-up-refresh' }),
    ], [ups.length ? btn(t('plugins.x.update_all_n', { n: ups.length }), { primary: true, icon: I.refresh, id: 'pgx-update-all', onClick: () => updateAll(ups.map((u) => catItem(u.id)).filter(Boolean), reloadUpdates) }) : null]));
    if (r && r.enabled !== false && r.available === false) main.appendChild(el('p', { class: 'pgx-note pgx-note-warn', role: 'status', text: r.error || t('plugins.cat.unreachable') }));

    const au = el('div', { class: 'pgx-seg', role: 'group', 'aria-label': t('plugins.x.auto_title'), id: 'pgx-auto' }, ['off', 'patch', 'all'].map((m) => el('button', {
      type: 'button', 'aria-pressed': String(inst.autoUpdate === m), 'data-mode': m, on: { click: async () => {
        const res = await req('PUT', API + '/policy', { autoUpdate: m });
        if (!res.ok) { toast(res.error, 'error'); return; }
        inst.autoUpdate = res.autoUpdate;
        au.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === res.autoUpdate)));
        toast(t('plugins.x.auto_saved'));
      } },
    }, [t('plugins.x.auto_' + m)])));
    main.appendChild(card([
      el('div', { class: 'pgx-t pgx-grow' }, [el('div', { class: 'pgx-card-r' }, [h2(t('plugins.x.auto_title'), 'pgx-auto-h', 'pgx-h2-sm'), pill(t('plugins.x.new'), 'new')]),
        el('small', { text: t('plugins.x.auto_d') })]), au,
    ], { 'aria-labelledby': 'pgx-auto-h' }, 'pgx-auto-card'));

    // updates that wait for a newer GateControl (the catalogue lists them, the server cannot install them yet)
    const blocked = (cat.plugins || []).filter((x) => x.state === 'installed' && x.requiresNewer && !ups.some((u) => u.id === x.id));
    if (blocked.length) {
      main.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.blocked_title'), 'pgx-blocked-h', 'pgx-h2-sm')]),
        el('p', { class: 'pgx-muted pgx-small', text: t('plugins.x.blocked_d', { installed: inst.serverVersion || '' }) })]
        .concat(blocked.map((x) => el('div', { class: 'pgx-hist', 'data-blocked': x.id }, [
          plugIcon(x.id, installedOf(x.id), 'md'),
          el('span', { class: 'pgx-t pgx-t-row' }, [el('b', { text: x.name }), ' ', el('span', { class: 'pgx-mono pgx-muted', text: (x.installedVersion || '') + ' → ' + x.requiresNewer.version })]),
          pill(t('plugins.x.needs_gc', { range: rng(x.requiresNewer.gatecontrol) }), 'warn'),
          link(t('plugins.x.notes'), U.item(x.id, 'tab=versions'), { class: 'pgx-a pgx-small' }),
        ]))), { 'aria-labelledby': 'pgx-blocked-h', id: 'pgx-blocked' }, 'pgx-flush'));
    }
    if (!ups.length) {
      main.appendChild(card([el('span', { class: 'pgx-okbig', 'aria-hidden': 'true' }, [icon(I.check, 22)]),
        el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.x.all_current') }), el('small', { text: t('plugins.x.all_current_d') })])], null, 'pgx-uptodate'));
    }
    ups.forEach((u) => {
      const item = catItem(u.id);
      main.appendChild(card([
        el('div', { class: 'pgx-uc-h' }, [
          plugIcon(u.id, installedOf(u.id), 'md48'),
          el('span', { class: 'pgx-t' }, [el('b', { class: 'pgx-uc-n', text: u.name }), el('span', { class: 'pgx-vv' }, [el('s', { text: u.from }), el('span', { 'aria-hidden': 'true', class: 'pgx-vv-a', text: ' → ' }), el('span', { class: 'pgx-vv-to', text: u.to })])]),
          pill(t('plugins.x.update_kind.' + u.kind), KIND_TONE[u.kind] || 'blue'),
          item ? btn(t('plugins.cat.update'), { primary: true, small: true, action: 'update', onClick: (e) => installFromCatalog(item, e.currentTarget).then(async (res) => { if (res) await reloadUpdates(); }) }) : null,
        ]),
        el('div', { class: 'pgx-uc-b' }, (u.replaces ? [el('p', { class: 'pgx-note', role: 'note', text: t('plugins.x.replaces_note', { old: u.replaces.name, name: u.name }) })] : []).concat(u.notes.length ? u.notes.map((n) => el('div', { class: 'pgx-uc-notes' }, [u.notes.length > 1 ? el('b', { class: 'pgx-mono pgx-small', text: n.version }) : null, notesBlock(n.notes, 12)]))
          : [el('p', { class: 'pgx-muted', text: t('plugins.x.no_notes') })]).concat([
          u.needsApproval ? el('p', { class: 'pgx-note pgx-note-warn', role: 'note' }, [icon(I.shield, 18), el('span', null, [el('b', { text: t('plugins.x.new_perm') + ' ' }), t('plugins.x.needs_approval_short')])]) : null,
          el('p', { class: 'pgx-okline' }, [icon(I.check, 16), el('span', null, [t('plugins.x.up_fits', { installed: (inst.serverVersion || '').split('.').slice(0, 2).join('.'), range: rng(u.gatecontrol), size: P.fmtBytes(u.size) }),
            u.needsApproval ? null : ' · ' + t('plugins.x.no_new_perms'), ' · ', link(t('plugins.x.all_notes'), U.item(u.id, 'tab=versions'))])]),
        ])),
      ], { 'data-update': u.id, 'aria-label': u.name + ' ' + u.to }, 'pgx-uc'));
    });

    const hist = ((r && r.history) || []).filter((h) => h.action !== 'uninstall').slice(0, 8);
    if (hist.length) {
      main.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.recently_updated'), 'pgx-hist-h'), link(t('plugins.area.log') + ' ›', U.log, { class: 'pgx-a pgx-push pgx-small' })])].concat(hist.map(historyRow)),
        { 'aria-labelledby': 'pgx-hist-h' }, 'pgx-flush'));
    }
  }

  async function reloadUpdates() {
    const [, r] = await Promise.all([loadInstalled(), req('GET', CAT_API + '/updates')]);
    await loadCatalog(false);
    renderUpdates(r);
    updateNav();
  }

  // ════════════════════════════════════════════════════════════
  // Lizenzen
  // ════════════════════════════════════════════════════════════
  async function viewLicenses() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderLicenses();
    done();
  }

  function licenseKind(L) {
    if (L.source === 'plan' || L.source === 'lifetime') return [t('plugins.lic.source_' + L.source), null];
    if (L.kind !== 'first_party') return [t('plugins.x.lic_third'), L.server || null];
    if (L.expiresAt) return [t('plugins.x.lic_key_kind'), t(L.state === 'expiring' || L.state === 'expired' ? 'plugins.x.lic_ends' : 'plugins.x.lic_renews', { date: P.fmtDate(L.expiresAt, lang) })];
    return [t('plugins.x.lic_key_kind'), null];
  }

  function renderLicenses(resultMsg) {
    clear(main);
    const need = inst.plugins.filter((p) => p.license && p.license.required);
    const ok = need.filter((p) => p.license.licensed && p.license.state !== 'expiring').length;
    const soon = need.filter((p) => p.license.state === 'expiring').length;
    main.appendChild(pageHead(t('plugins.area.licenses'), [t('plugins.x.n_plugins', { n: need.length }), t('plugins.x.n_valid', { n: ok }),
      soon ? t('plugins.x.n_expiring', { n: soon }) : null, need.length - ok - soon > 0 ? t('plugins.x.n_problem', { n: need.length - ok - soon }) : null].filter(Boolean).join(' · '),
    [btn(t('plugins.x.to_shop'), { href: SHOP_URL, external: true, icon: I.ext })]));

    const keyIn = el('input', { type: 'text', id: 'pgx-lic-key', placeholder: t('plugins.lic.placeholder'), maxLength: 200, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('plugins.lic.key') });
    const msg = el('p', { class: 'pgx-hint', id: 'pgx-lic-msg', role: 'status' });
    if (resultMsg) { msg.textContent = resultMsg.text; msg.setAttribute('data-tone', resultMsg.tone); }
    const go = btn(t('plugins.x.key_assign'), { primary: true, id: 'pgx-lic-go', cls: 'pgx-btn-tall', onClick: async (e) => {
      const b = e.currentTarget;
      if (!keyIn.value.trim()) return;
      b.disabled = true;
      msg.textContent = t('plugins.x.key_checking');
      const r = await req('POST', API + '/license-key', { key: keyIn.value });
      b.disabled = false;
      if (!r.ok) { msg.textContent = r.error; msg.setAttribute('data-tone', 'crit'); return; }
      inst.plugins = r.plugins || inst.plugins;
      let text;
      if (!r.valid) text = t('plugins.x.key_invalid', { name: r.name, error: t('plugins.x.key_err.' + (r.error || 'invalid')) });
      else if (!r.installed) text = t('plugins.x.key_not_installed', { name: r.name });
      else text = t('plugins.x.key_ok', { name: r.name });
      renderLicenses({ text, tone: r.valid ? 'good' : 'crit' });
      updateNav();
      if (r.valid && !r.installed && catItem(r.pluginId)) $('pgx-lic-msg').appendChild(link(' ' + t('plugins.x.to_catalog_item'), U.item(r.pluginId)));
    } });
    main.appendChild(card([h2(t('plugins.x.key_title'), 'pgx-key-h', 'pgx-h2-sm'),
      el('div', { class: 'pgx-inline' }, [el('label', { class: 'pgx-keyfld pgx-grow' }, [icon(I.key, 18), keyIn]), go]),
      resultMsg ? msg : el('p', { class: 'pgx-hint', text: t('plugins.x.key_d') }), resultMsg ? null : msg], { 'aria-labelledby': 'pgx-key-h' }, 'pgx-pad pgx-stack-card'));

    const rows = need.slice().sort((a, b) => Number(a.license.licensed && a.license.state !== 'expiring') - Number(b.license.licensed && b.license.state !== 'expiring') || a.name.localeCompare(b.name));
    const tbl = el('table', { class: 'pgx-table', id: 'pgx-lic-table' }, [
      el('thead', null, [el('tr', null, [t('plugins.x.col_plugin'), t('plugins.x.col_kind'), t('plugins.lic.status'), t('plugins.lic.key')].map((h) => el('th', { scope: 'col', text: h }))
        .concat([el('th', null, [el('span', { class: 'st-sr', text: t('plugins.x.col_action') })])]))]),
      el('tbody', null, rows.length ? rows.map((p) => {
        const L = p.license;
        const [kind, sub] = licenseKind(L);
        const warn = !L.licensed || L.state === 'expiring';
        const stateText = L.state === 'expiring' && L.expiresAt ? t('plugins.x.lic_ends_on', { date: fmtDay(L.expiresAt) }) : t('plugins.lic.state.' + L.state);
        return el('tr', { 'data-plugin': p.id, 'data-tone': warn ? (L.licensed ? 'warn' : 'crit') : null }, [
          el('td', null, [el('a', { class: 'pgx-tnm', href: U.manage(p.id, 'license') }, [plugIcon(p.id, p, 'sm'), el('b', { text: p.name })])]),
          el('td', null, [kind, sub ? el('small', { text: sub }) : null]),
          el('td', null, [pill(stateText, P.licenseTone(L.state), true)]),
          el('td', { class: 'pgx-mono pgx-muted', text: L.keyMasked || '—' }),
          el('td', { class: 'pgx-right' }, [L.state === 'expiring' || L.state === 'expired' ? btn(t('plugins.x.renew_short'), { href: SHOP_URL, external: true, small: true, primary: true })
            : btn(t('plugins.x.manage_short'), { href: U.manage(p.id, 'license'), small: true })]),
        ]);
      }) : [el('tr', null, [el('td', { colspan: '5', class: 'pgx-muted', text: t('plugins.x.no_licensed') })])]),
    ]);
    main.appendChild(card([el('div', { class: 'pgx-table-wrap' }, [tbl])], { 'aria-label': t('plugins.x.lic_table') }, 'pgx-flush'));
    main.appendChild(card([h2(t('plugins.x.legend'), 'pgx-legend-h', 'pgx-h2-sm')].concat(['expiring', 'grace', 'offline', 'elsewhere'].map((k) => el('div', { class: 'pgx-lg' }, [
      pill(t('plugins.x.lg.' + k), k === 'offline' ? 'blue' : (k === 'elsewhere' ? 'crit' : 'warn')),
      el('span', { class: 'pgx-t' }, [el('span', { text: t('plugins.x.lg.' + k + '_t') }), el('small', { text: t('plugins.x.lg.' + k + '_d') })]),
    ]))), { 'aria-labelledby': 'pgx-legend-h' }, 'pgx-pad'));
  }

  // ════════════════════════════════════════════════════════════
  // Sicherheit & Upload
  // ════════════════════════════════════════════════════════════
  let staged = null;

  async function viewSecurity() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderSecurity();
    done();
  }

  function renderSecurity() {
    clear(main);
    main.appendChild(pageHead(t('plugins.area.security'), t('plugins.x.sec_sub')));
    const fileIn = $('pgx-file');
    const drop = el('div', { class: 'pgx-drop', id: 'pg-drop', tabindex: '0', role: 'button', 'aria-label': t('plugins.drop.title') }, [
      el('span', { class: 'pgx-drop-ic', 'aria-hidden': 'true' }, [icon(I.upload, 24)]),
      el('b', { text: t('plugins.x.drop_title') }),
      el('span', { class: 'pgx-muted' }, [t('plugins.x.drop_or') + ' ', el('span', { class: 'pgx-a', text: t('plugins.x.drop_choose') }), ' · ' + t('plugins.x.drop_max', { size: P.fmtBytes(P.MAX_PACKAGE_BYTES) })]),
    ]);
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; stage(f); });
    drop.addEventListener('click', () => fileIn.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
    const preview = el('div', { id: 'pgx-staged' });
    main.appendChild(card([el('div', { class: 'pgx-sec-h' }, [h2(t('plugins.x.upload_title'), 'pgx-up-h'), el('span', { class: 'pgx-sec-s', text: t('plugins.x.upload_d') })]), drop, preview],
      { 'aria-labelledby': 'pgx-up-h' }, 'pgx-pad pgx-stack-card'));
    renderStaged(preview);

    const setRow = (id, label, hint, on, onClick, isNew) => el('div', { class: 'pgx-set', id: id === 'pg-unsigned' ? 'unsigned' : null }, [
      el('span', { class: 'pgx-t' }, [el('b', null, [el('label', { for: id, text: label }), isNew ? pill(t('plugins.x.new'), 'new', false, { class: 'pgx-pill pgx-pill-xs' }) : null]), el('small', { id: id + '-hint', text: hint })]),
      el('button', { type: 'button', class: 'pgx-sw', role: 'switch', id, 'aria-checked': on ? 'true' : 'false', 'aria-describedby': id + '-hint', on: { click: onClick } }, [el('span', { 'aria-hidden': 'true' })]),
    ]);
    main.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.rules'), 'pgx-rules-h')]),
      setRow('pg-unsigned', t('plugins.sec.unsigned'), t('plugins.sec.unsigned_hint'), inst.allowUnsigned, toggleUnsigned),
      inst.allowUnsigned ? el('p', { class: 'pgx-note pgx-note-warn pgx-in-pad', id: 'pg-unsigned-on' }, [el('b', { text: t('plugins.sec.on_title') + ' ' }), t('plugins.sec.on_text')]) : el('span', { id: 'pg-unsigned-off', hidden: true }),
      setRow('pg-backup-media', t('plugins.sec.backup_media'), t('plugins.sec.backup_media_hint'), inst.backupMedia, async () => {
        const r = await req('PUT', API + '/policy', { backupMedia: !inst.backupMedia });
        if (!r.ok) { toast(r.error, 'error'); return; }
        inst.backupMedia = !!r.backupMedia;
        renderSecurity();
      }),
      CATALOG_ON ? setRow('pgx-catalog-check', t('plugins.x.check_title'), t('plugins.x.check_d'), inst.catalogCheck, async () => {
        const r = await req('PUT', API + '/policy', { catalogCheck: !inst.catalogCheck });
        if (!r.ok) { toast(r.error, 'error'); return; }
        inst.catalogCheck = r.catalogCheck !== false;
        renderSecurity();
      }, true) : null,
    ], { 'aria-labelledby': 'pgx-rules-h', id: 'pg-security' }, 'pgx-flush'));

    if (CATALOG_ON) {
      main.appendChild(card([el('div', { class: 'pgx-card-r' }, [h2(t('plugins.x.source_title'), 'pgx-src-h'), el('span', { class: 'pgx-push' }, [pill(cat.available ? t('plugins.x.reachable') : t('plugins.x.unreachable'), cat.available ? 'good' : 'warn')])]),
        kv([
          [t('plugins.x.source'), cat.source && !cat.source.official ? t('plugins.x.source_custom', { host: cat.source.host }) : t('plugins.x.source_official_long')],
          [t('plugins.x.address'), cat.source ? cat.source.host : '', true],
          [t('plugins.x.verification'), t('plugins.x.verification_v')],
          [t('plugins.x.last_check'), [cat.fetchedAt ? fmtDateTime(cat.fetchedAt) + ' · ' + t('plugins.x.n_plugins', { n: cat.plugins.length }) + ' · ' : '',
            linkBtn(t('plugins.x.check_now'), async (e) => { e.currentTarget.disabled = true; await loadCatalog(true); renderSecurity(); updateNav(); })]],
        ]),
      ], { 'aria-labelledby': 'pgx-src-h' }, 'pgx-pad'));
    }
  }

  async function stage(file) {
    const r = await uploadFile(file);
    if (!r) return;
    staged = Object.assign(r, { blob: file });
    renderStaged($('pgx-staged'));
  }

  function renderStaged(box) {
    if (!box) return;
    clear(box);
    if (!staged) return;
    const info = staged.info;
    const pl = info.plugin;
    const unsignedBlocked = (info.checks || []).some((c) => c.key === 'signature' && c.status === 'fail' && (c.code === 'unsigned' || c.code === 'untrusted'));
    const tone = info.canInstall ? (pl && pl.verified ? 'good' : 'warn') : (unsignedBlocked ? 'warn' : 'crit');
    const compat = (info.checks || []).find((c) => c.key === 'compatibility') || { params: {} };
    box.appendChild(el('div', { class: 'pgx-staged', 'data-tone': tone }, [
      el('div', { class: 'pgx-card-r' }, [
        el('span', { class: 'pgx-staged-ic', 'aria-hidden': 'true' }, [icon(I.file, 22)]),
        el('span', { class: 'pgx-t' }, [el('b', { text: staged.file.name }),
          el('small', { class: 'pgx-mono', text: [P.fmtBytes(staged.file.size), pl ? pl.name + ' ' + pl.version : '', compat.params.required ? t('plugins.x.gc_needs_short', { range: rng(compat.params.required) }) + (compat.status === 'ok' ? ' ✓' : '') : ''].filter(Boolean).join(' · ') })]),
        el('span', { class: 'pgx-push' }, [pill(pl && pl.verified ? t('plugins.badge.verified') : t('plugins.x.not_signed'), pl && pl.verified ? 'good' : 'warn')]),
      ]),
      el('p', { text: unsignedBlocked ? t('plugins.x.unsigned_blocked') : (info.canInstall ? (pl && pl.verified ? t('plugins.x.staged_ok') : t('plugins.x.staged_unsigned')) : t('plugins.in.blocked')) }),
      el('div', { class: 'pgx-acts' }, [
        btn(t('plugins.x.discard'), { small: true, onClick: () => { staged = null; renderStaged(box); } }),
        unsignedBlocked && !inst.allowUnsigned ? btn(t('plugins.x.allow_unsigned'), { small: true, onClick: toggleUnsigned }) : null,
        btn(t('plugins.cat.install'), { small: true, primary: true, disabled: !info.canInstall, id: 'pgx-staged-go', onClick: async () => {
          const r = await installDialog(info, staged.file, null);
          if (r) { staged = null; await loadInstalled(); renderSecurity(); }
        } }),
      ]),
    ]));
  }

  async function toggleUnsigned() {
    const on = !inst.allowUnsigned;
    let confirm = null;
    if (on) {
      confirm = await D.prompt({
        title: t('plugins.sec.confirm_title'), message: t('plugins.sec.confirm_text'), label: t('plugins.sec.confirm_label'),
        okLabel: t('plugins.sec.confirm_ok'), danger: true, maxLength: 20,
        validate: (v) => (v === t('plugins.sec.confirm_word') ? null : t('plugins.sec.confirm_wrong')),
      });
      if (confirm == null) return;
    } else if (!(await D.confirm({ title: t('plugins.sec.off_title'), message: t('plugins.sec.off_text'), okLabel: t('plugins.sec.off_ok') }))) return;
    const r = await req('PUT', API + '/policy', { allowUnsigned: on, confirm });
    if (!r.ok) { toast(r.error, 'error'); return; }
    inst.allowUnsigned = !!r.allowUnsigned;
    // a file waiting in the preview is checked again under the new rule
    if (staged && staged.blob) await stage(staged.blob);
    renderSecurity();
  }

  // ════════════════════════════════════════════════════════════
  // Speicher: storage targets (docs/storage-targets.md) — where the
  // plugins that keep files in areas (plugin.json media.areas) store them
  // ════════════════════════════════════════════════════════════
  const ST_API = '/api/v1/storage-targets';
  const CL_API = '/api/v1/cloud-accounts';
  const ST_KINDS = ['local', 'smb', 'webdav', 's3', 'gdrive', 'onedrive'];
  // Google Drive / OneDrive: the account is connected with OAuth (Cloud-Konten), not typed in
  const ST_CLOUD = { gdrive: 'google', onedrive: 'microsoft' };
  const ST_ICON = {
    local: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
    smb: 'M3 6h18v9H3zM8 19h8M12 15v4M7 10.5h.01M11 10.5h.01',
    webdav: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    s3: 'M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 8.5z',
    gdrive: 'M8 3h8l6 11-3 6H5l-3-6zM8 3l6 11H2M16 3l-8 17',
    onedrive: 'M5 18h13a3.5 3.5 0 0 0 .6-6.95A6 6 0 0 0 7.2 9.1 4.5 4.5 0 0 0 5 18z',
  };
  let stg = { targets: [], choices: null, cloud: null };

  async function viewStorage() {
    await loadInstalled();
    await loadTargets();
    await loadCloud();
    renderStorage();
    done();
    // back from Google / Microsoft (routes/cloudOAuth.js): the dialog with the connected account, or the error
    const draftId = query.get('cloudDraft');
    const cloudErr = query.get('cloud') === 'error' ? query.get('cloudError') : null;
    if (draftId || cloudErr) { try { history.replaceState(null, '', U.storage); } catch (_) { /* keep the address */ } }
    if (cloudErr) toast(cloudErrorText(cloudErr), 'error');
    if (draftId) {
      const r = await req('GET', CL_API + '/drafts/' + enc(draftId));
      if (!r.ok) { toast(r.error, 'error'); return; }
      const existing = r.draft.targetId ? stg.targets.find((x) => x.id === r.draft.targetId) || null : null;
      targetDialog(existing, { draft: r.draft });
    }
  }

  async function loadCloud() {
    const r = await req('GET', CL_API);
    stg.cloud = r.ok ? r : null;
  }
  function cloudReady(kind) { return !!(stg.cloud && stg.cloud.apps && stg.cloud.apps[ST_CLOUD[kind]] && stg.cloud.apps[ST_CLOUD[kind]].configured); }
  function cloudErrorText(code) {
    const s = t('plugins.cloud.err_' + code);
    return s === 'plugins.cloud.err_' + code ? t('plugins.cloud.err_failed') : s;
  }

  async function loadTargets() {
    const r = await req('GET', ST_API);
    if (!r.ok) { showError(r.error); return false; }
    stg.targets = r.targets || [];
    stg.cache = r.cache || null;
    return true;
  }

  function fmtFree(c) {
    if (!c || c.free == null) return '';
    return c.total ? t('plugins.stg.free_of', { free: P.fmtBytes(c.free), total: P.fmtBytes(c.total) }) : t('plugins.stg.free', { free: P.fmtBytes(c.free) });
  }

  function checkPill(tg) {
    const c = tg.check;
    if (tg.needsSecret) return pill(t(ST_CLOUD[tg.kind] ? 'plugins.stg.needs_reconnect' : 'plugins.stg.needs_secret'), 'warn', true);
    if (!c) return pill(t('plugins.stg.unchecked'), 'mute', true);
    return c.ok ? pill(t('plugins.stg.ok_at', { at: fmtDateTime(c.at) }), 'good', true) : pill(t('plugins.stg.failed_at', { at: fmtDateTime(c.at) }), 'crit', true);
  }

  function usedText(tg) {
    if (!tg.usedBy || !tg.usedBy.length) return t('plugins.stg.unused');
    return t('plugins.stg.used_by', { list: tg.usedBy.map((u) => (u.pluginName || u.plugin) + ' · ' + (u.label || u.area)).join(', ') });
  }

  function renderStorage() {
    clear(main);
    main.appendChild(pageHead(t('plugins.stg.title'), t('plugins.stg.sub'),
      [btn(t('plugins.stg.add'), { primary: true, icon: I.plus, id: 'pgx-stg-add', onClick: () => targetDialog(null) })]));
    const rows = stg.targets.map((tg) => {
      const err = tg.check && !tg.check.ok && tg.check.error ? el('p', { class: 'pgx-stg-err', text: stgErrorText(tg.check.error) }) : null;
      return el('div', { class: 'pgx-row pgx-stg-row', 'data-target': String(tg.id), 'data-kind': tg.kind }, [
        el('span', { class: 'pgx-ic', 'data-size': 'md', 'data-cat': 'system', 'aria-hidden': 'true' }, [icon(ST_ICON[tg.kind], 22)]),
        el('span', { class: 'pgx-t pgx-grow' }, [
          el('b', { text: tg.label }),
          el('small', { class: 'pgx-mono', text: tg.display }),
          el('small', { class: 'pgx-muted', text: [t('plugins.stg.kind_' + tg.kind), fmtFree(tg.check), usedText(tg)].filter(Boolean).join(' · ') }),
          err,
        ]),
        el('span', { class: 'pgx-stg-state' }, [checkPill(tg), tg.encrypted ? pill(t('plugins.stg.encrypted'), 'blue') : null]),
        el('span', { class: 'pgx-acts' }, [
          btn(t('plugins.stg.check'), { small: true, icon: I.refresh, action: 'check', onClick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            const r = await req('POST', ST_API + '/' + tg.id + '/check', {});
            b.disabled = false;
            if (!r.ok) { toast(r.error, 'error'); return; }
            toast(r.check.ok ? t('plugins.stg.check_ok') : stgErrorText(r.check.error, r.check.message), r.check.ok ? 'success' : 'error');
            await loadTargets();
            renderStorage();
          } }),
          btn(t('plugins.stg.edit'), { small: true, action: 'edit', onClick: () => targetDialog(tg) }),
          btn(t('plugins.stg.delete'), { small: true, ghost: true, action: 'delete', disabled: !!(tg.usedBy && tg.usedBy.length), label: t('plugins.stg.delete_l', { name: tg.label }), onClick: async () => {
            if (!(await D.confirm({ title: t('plugins.stg.delete_title', { name: tg.label }), message: t('plugins.stg.delete_text'), okLabel: t('plugins.stg.delete'), danger: true }))) return;
            const r = await req('DELETE', ST_API + '/' + tg.id);
            if (!r.ok) { toast(r.error, 'error'); return; }
            toast(t('plugins.stg.deleted'));
            await loadTargets();
            renderStorage();
          } }),
        ]),
      ]);
    });
    main.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.stg.list'), 'pgx-stg-h')]),
      rows.length ? el('div', { class: 'pgx-stg-list', id: 'pgx-stg-list' }, rows) : el('p', { class: 'pgx-muted pgx-in-pad', id: 'pgx-stg-empty', text: t('plugins.stg.empty') })],
    { 'aria-labelledby': 'pgx-stg-h' }, 'pgx-flush pgx-list'));
    if (stg.cache) main.appendChild(cacheCard(stg.cache));
    main.appendChild(card([h2(t('plugins.stg.about'), 'pgx-stg-about-h'),
      el('ul', { class: 'pgx-stg-about' }, ['server', 'local', 'smb', 'webdav', 's3', 'cloud'].map((k) => el('li', null, [el('b', { text: t('plugins.stg.about_' + k + '_t') }), ' ', t('plugins.stg.about_' + k)]))),
      el('p', { class: 'pgx-hint', text: t('plugins.stg.about_backup') }),
    ], { 'aria-labelledby': 'pgx-stg-about-h' }, 'pgx-pad pgx-stack-card'));
  }

  /** The local cache of plugin media kept on storage targets (mediaAreas.js): usage and its size. */
  function cacheCard(c) {
    const gb = el('input', { type: 'number', class: 'pgx-fld-in pgx-stg-cache-in', id: 'pgx-stg-cache', min: 0.25, max: 102400, step: 'any',
      value: String(Math.round((c.limit / (1024 * 1024 * 1024)) * 100) / 100), 'aria-label': t('plugins.stg.cache_size') });
    const save = async (limitBytes) => {
      const r = await req('PUT', ST_API + '/cache', { limitBytes });
      if (!r.ok) { toast(r.error, 'error'); return; }
      toast(t('plugins.stg.cache_saved'));
      stg.cache = r.cache;
      renderStorage();
    };
    return card([h2(t('plugins.stg.cache'), 'pgx-stg-cache-h'),
      el('p', { class: 'pgx-muted', id: 'pgx-stg-cache-use', text: t('plugins.stg.cache_use', { cached: P.fmtBytes(c.cached), limit: P.fmtBytes(c.limit), pending: P.fmtBytes(c.pending) }) }),
      el('p', { class: 'pgx-hint', text: t('plugins.stg.cache_hint') }),
      el('div', { class: 'pgx-inline' }, [
        el('label', { class: 'st-label', for: 'pgx-stg-cache', text: t('plugins.stg.cache_size') }), gb,
        btn(t('plugins.media.save'), { small: true, primary: true, id: 'pgx-stg-cache-save', onClick: () => save(Math.round(Number(gb.value) * 1024 * 1024 * 1024)) }),
        btn(t('plugins.media.reset', { quota: P.fmtBytes(c.default) }), { small: true, onClick: () => save(null) }),
      ]),
    ], { 'aria-labelledby': 'pgx-stg-cache-h' }, 'pgx-pad pgx-stack-card');
  }

  /**
   * An error code of a check → a sentence for people. `code` alone may be the
   * stored "code: message"; a TLS handshake error names the system's code
   * (the message starts with it).
   */
  function stgErrorText(code, message) {
    const full = String(code || '');
    const c = full.split(':')[0];
    const m = /^\s*([A-Z][A-Z0-9_]+)\b/.exec(message != null ? String(message) : full.slice(c.length + 1));
    const s = t('plugins.stg.err_' + c, { code: m ? m[1] : '?' });
    return s === 'plugins.stg.err_' + c ? t('plugins.stg.err_failed') : s;
  }

  async function stgChoices() {
    if (stg.choices) return stg.choices;
    const r = await req('GET', ST_API + '/choices');
    stg.choices = r.ok ? { peers: r.peers || [], routes: r.routes || [] } : { peers: [], routes: [] };
    return stg.choices;
  }

  /**
   * "Speicherziel hinzufügen" / "bearbeiten": the kind (new targets only),
   * its fields, Prüfen (checks the settings without saving), Speichern
   * (saves, then checks the stored target). → the saved target or null.
   */
  async function targetDialog(existing, opts) {
    const o = opts || {};
    const choices = await stgChoices();
    const title = existing ? t('plugins.stg.dlg_edit', { name: existing.label }) : t('plugins.stg.dlg_add');
    const d = dlg(title, 'md');
    // a freshly connected Google / Microsoft account (?cloudDraft=…): its kind, for a new or this target
    const draft = o.draft || null;
    let kind = existing ? existing.kind : (draft ? draft.kind : 'smb');
    const cfg = existing ? existing.config : {};
    // the folder chosen in Google Drive / OneDrive
    let sel = existing && ST_CLOUD[existing.kind] ? { folderId: cfg.folderId, folderPath: cfg.folderPath, driveId: cfg.driveId || null } : null;
    const secretSet = existing ? existing.secretSet : {};
    const form = el('div', { class: 'pgx-stg-form', id: 'pgx-stg-form' });
    const result = el('div', { id: 'pgx-stg-result', 'aria-live': 'polite' });
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    const headIc = el('span', { class: 'pgx-ic', 'data-size': 'lg', 'data-cat': 'system', 'aria-hidden': 'true' }, [icon(ST_ICON[kind], 28)]);
    d.body.appendChild(el('div', { class: 'pgx-in-head pgx-stg-head' }, [headIc,
      el('div', { class: 'pgx-in-title' }, [el('h3', { class: 'pgx-dh', text: title }), el('span', { class: 'pgx-muted', text: existing ? t('plugins.stg.kind_' + kind) + ' · ' + existing.display : t('plugins.stg.dlg_add_sub') })])]));
    d.body.appendChild(form);
    d.body.appendChild(result);
    d.body.appendChild(err);
    const inputs = {};

    function input(name, o) {
      const opt = o || {};
      const i = el('input', { type: opt.type || 'text', class: 'pgx-fld-in', id: 'pgx-stg-' + name, name, autocomplete: opt.type === 'password' ? 'new-password' : 'off',
        spellcheck: 'false', maxLength: opt.max || 400, placeholder: opt.placeholder || '', value: opt.value == null ? '' : String(opt.value) });
      inputs[name] = i;
      return i;
    }
    function field(name, label, control, hint) {
      return el('div', { class: 'pgx-stg-f', 'data-field': name }, [el('label', { class: 'pgx-lbl', for: 'pgx-stg-' + name, text: label }), control,
        hint ? el('small', { class: 'pgx-hint', text: hint }) : null]);
    }
    function select(name, options, value) {
      const s = el('select', { class: 'pgx-fld-in', id: 'pgx-stg-' + name, name }, options.map((o) => el('option', { value: String(o[0]), text: o[1] })));
      if (value != null) s.value = String(value);
      inputs[name] = s;
      return s;
    }
    /** The target's own certificate or CA (PEM) — for a NAS with a self-signed certificate. */
    function caField() {
      const ta = el('textarea', { class: 'pgx-fld-in pgx-stg-pem', id: 'pgx-stg-tlsCa', name: 'tlsCa', rows: 4, spellcheck: 'false', maxLength: 65536,
        placeholder: '-----BEGIN CERTIFICATE-----' });
      ta.value = cfg.tlsCa || '';
      inputs.tlsCa = ta;
      const info = existing && existing.tlsCaInfo && existing.tlsCaInfo.length
        ? existing.tlsCaInfo.map((c) => c.subject + ' · SHA-256 ' + c.fingerprint.slice(0, 16) + '…').join(' / ') : null;
      return field('tlsCa', t('plugins.stg.f_ca'), ta, info ? t('plugins.stg.f_ca_set', { info }) : t('plugins.stg.f_ca_h'));
    }
    function secretInput(name) {
      return input(name, { type: 'password', max: 512, placeholder: secretSet[name] ? t('plugins.stg.secret_kept') : '' });
    }

    /** "Mit Google verbinden": the administrator's own account, back here with ?cloudDraft=… */
    async function connect(e) {
      const b = e.currentTarget;
      b.disabled = true;
      const r = await req('POST', CL_API + '/connect', { provider: ST_CLOUD[kind], targetId: existing ? existing.id : null });
      if (!r.ok) { b.disabled = false; showFail(r); return; }
      location.href = r.url;
    }

    /** Google Drive / OneDrive: the connected account and the folder (browse, choose, create). */
    function cloudFields() {
      const prov = ST_CLOUD[kind];
      if (!cloudReady(kind)) {
        form.appendChild(el('p', { class: 'pgx-note pgx-note-warn', id: 'pgx-stg-cloud-missing' }, [icon(I.alert, 16),
          el('span', null, [t('plugins.stg.cloud_missing', { provider: t('plugins.cloud.p_' + prov) }), ' ', link(t('plugins.stg.cloud_setup'), U.cloud)])]));
        return;
      }
      // the draft only counts for its own kind (the kind can still be switched above)
      const dr = draft && draft.kind === kind ? draft : null;
      if (!dr && !existing) sel = null;
      form.appendChild(field('label', t('plugins.stg.f_label'), input('label', { max: 60, value: existing ? existing.label : (dr ? t('plugins.stg.kind_' + kind) : '') })));
      const account = dr ? dr.account : (existing ? cfg.account : null);
      form.appendChild(el('div', { class: 'pgx-stg-f', 'data-field': 'draft' }, [lbl(t('plugins.stg.f_account')),
        el('div', { class: 'pgx-inline' }, [
          account ? el('b', { id: 'pgx-stg-account', text: account }) : el('span', { class: 'pgx-muted', text: t('plugins.stg.not_connected') }),
          btn(account ? t('plugins.stg.reconnect') : t('plugins.stg.connect_' + prov), { small: true, primary: !account, id: 'pgx-stg-connect', onClick: connect }),
        ]),
        dr ? el('small', { class: 'pgx-hint', text: t('plugins.stg.connected_new') }) : null]));
      if (!account) { form.appendChild(el('p', { class: 'pgx-hint', text: t('plugins.stg.connect_h_' + prov) })); return; }
      const src = dr ? 'draft=' + enc(dr.id) : 'target=' + enc(existing.id);
      const chosen = el('b', { id: 'pgx-stg-folder', text: sel ? sel.folderPath : t('plugins.stg.no_folder') });
      const crumbs = el('div', { class: 'pgx-crumb pgx-stg-crumbs' });
      const list = el('div', { class: 'pgx-stg-browse', id: 'pgx-stg-browse', role: 'list' });
      const nameIn = el('input', { type: 'text', class: 'pgx-fld-in', id: 'pgx-stg-newfolder', maxLength: 120, placeholder: t('plugins.stg.new_folder_ph'), 'aria-label': t('plugins.stg.new_folder') });
      const stack = [{ id: 'root', name: t('plugins.stg.root_' + prov) }];
      let driveId = sel ? sel.driveId : null;
      const pathOf = () => '/' + stack.slice(1).map((x) => x.name).join('/');
      async function load() {
        clear(list);
        clear(crumbs);
        stack.forEach((n, i) => {
          if (i) crumbs.appendChild(el('span', { 'aria-hidden': 'true', text: '›' }));
          crumbs.appendChild(i === stack.length - 1 ? el('span', { 'aria-current': 'location', text: n.name })
            : linkBtn(n.name, () => { stack.length = i + 1; load(); }));
        });
        list.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.area.loading') }));
        const r = await req('GET', CL_API + '/folders?' + src + '&parent=' + enc(stack[stack.length - 1].id));
        clear(list);
        if (!r.ok) { list.appendChild(el('p', { class: 'pgx-stg-err', text: r.error })); return; }
        if (r.driveId) driveId = r.driveId;
        if (!r.folders.length) list.appendChild(el('p', { class: 'pgx-muted', text: t(prov === 'google' ? 'plugins.stg.no_subfolders_google' : 'plugins.stg.no_subfolders') }));
        r.folders.forEach((f) => list.appendChild(el('button', { type: 'button', class: 'pgx-stg-dir', role: 'listitem', 'data-folder': f.id,
          on: { click: () => { stack.push({ id: f.id, name: f.name }); load(); } } }, [icon('M3 6h6l2 2h10v11H3z', 17), f.name])));
      }
      const use = btn(t('plugins.stg.use_folder'), { small: true, primary: true, id: 'pgx-stg-use', onClick: () => {
        const top = stack[stack.length - 1];
        sel = { folderId: top.id, folderPath: pathOf(), driveId };
        chosen.textContent = sel.folderPath;
      } });
      const mk = btn(t('plugins.stg.new_folder'), { small: true, icon: I.plus, id: 'pgx-stg-mkdir', onClick: async () => {
        const name = nameIn.value.trim();
        if (!name) { nameIn.focus(); return; }
        const body = { parent: stack[stack.length - 1].id, name };
        if (dr) body.draft = dr.id; else body.target = existing.id;
        const r = await req('POST', CL_API + '/folders', body);
        if (!r.ok) { toast(r.error, 'error'); return; }
        nameIn.value = '';
        stack.push({ id: r.folder.id, name: r.folder.name });
        await load();
      } });
      form.appendChild(el('div', { class: 'pgx-stg-f', 'data-field': 'folderId' }, [lbl(t('plugins.stg.f_cloud_folder')),
        el('div', { class: 'pgx-inline' }, [t('plugins.stg.folder_chosen'), chosen]),
        el('div', { class: 'pgx-stg-picker' }, [crumbs, list, el('div', { class: 'pgx-inline' }, [use, nameIn, mk])]),
        el('small', { class: 'pgx-hint', text: t('plugins.stg.f_cloud_folder_h_' + prov) })]));
      form.appendChild(el('p', { class: 'pgx-note', text: t('plugins.stg.cloud_note') }));
      load();
    }

    function render() {
      clear(form);
      clear(headIc);
      headIc.appendChild(icon(ST_ICON[kind], 28));
      Object.keys(inputs).forEach((k) => delete inputs[k]);
      clear(result);
      err.hidden = true;
      if (!existing) {
        form.appendChild(el('div', { class: 'pgx-stg-kinds', role: 'radiogroup', 'aria-label': t('plugins.stg.kind') }, ST_KINDS.map((k) => el('button', {
          type: 'button', class: 'pgx-opt pgx-stg-kind', role: 'radio', 'aria-checked': k === kind ? 'true' : 'false', 'data-kind': k,
          on: { click: () => { kind = k; render(); } },
        }, [icon(ST_ICON[k], 20), el('span', { class: 'pgx-t' }, [el('b', { text: t('plugins.stg.kind_' + k) }), el('small', { text: t('plugins.stg.kind_' + k + '_d') })])]))));
      }
      if (ST_CLOUD[kind]) {
        cloudFields();
        return;
      }
      form.appendChild(field('label', t('plugins.stg.f_label'), input('label', { max: 60, value: existing ? existing.label : '' })));
      if (kind === 'local') {
        form.appendChild(field('path', t('plugins.stg.f_path'), input('path', { value: cfg.path, placeholder: '/mnt/usb/gatecontrol' }), t('plugins.stg.f_path_h')));
      } else if (kind === 'smb') {
        const v = cfg.via || { kind: 'host' };
        const how = select('via', [['host', t('plugins.stg.via_host')], ['peer', t('plugins.stg.via_peer')], ['route', t('plugins.stg.via_route')]], v.kind);
        form.appendChild(field('via', t('plugins.stg.f_via'), how));
        const hostF = field('host', t('plugins.stg.f_host'), input('host', { value: v.kind === 'host' ? v.host : '', placeholder: 'nas.fritz.box' }));
        const peerF = field('peerId', t('plugins.stg.f_peer'), select('peerId', choices.peers.map((p) => [p.id, p.label + ' (' + p.ip + ')']), v.peerId));
        const routeF = field('routeId', t('plugins.stg.f_route'), select('routeId', choices.routes.filter((r) => r.type === 'l4').map((r) => [r.id, r.label]), v.routeId), t('plugins.stg.f_route_h'));
        const portF = field('port', t('plugins.stg.f_port'), input('port', { type: 'number', value: v.port && v.port !== 445 ? v.port : '', placeholder: '445', max: 5 }));
        const sync = () => { hostF.hidden = how.value !== 'host'; peerF.hidden = how.value !== 'peer'; routeF.hidden = how.value !== 'route'; portF.hidden = how.value === 'route'; };
        how.addEventListener('change', sync);
        [hostF, peerF, routeF, portF].forEach((f) => form.appendChild(f));
        sync();
        form.appendChild(field('share', t('plugins.stg.f_share'), input('share', { value: cfg.share, placeholder: 'home', max: 80 })));
        form.appendChild(field('folder', t('plugins.stg.f_folder'), input('folder', { value: cfg.folder, placeholder: 'GateControl' }), t('plugins.stg.f_folder_h')));
        form.appendChild(field('username', t('plugins.stg.f_user'), input('username', { value: cfg.username, max: 120 })));
        form.appendChild(field('password', t('plugins.stg.f_password'), secretInput('password')));
        form.appendChild(field('domain', t('plugins.stg.f_domain'), input('domain', { value: cfg.domain, max: 120 }), t('plugins.stg.f_domain_h')));
      } else if (kind === 'webdav') {
        // since 1.218.0: through a route or a VPN peer like SMB — the URL still names the NAS (scheme, path, certificate)
        const v = cfg.via || { kind: 'host' };
        const how = select('via', [['host', t('plugins.stg.via_url')], ['route', t('plugins.stg.via_route_any')], ['peer', t('plugins.stg.via_peer')]], v.kind);
        form.appendChild(field('via', t('plugins.stg.f_via'), how));
        const routeF = field('routeId', t('plugins.stg.f_route_any'), select('routeId', choices.routes.map((r) => [r.id, r.label + ' · ' + (r.type === 'l4' ? 'L4' : 'HTTP') + (r.gateway ? ' · Gateway' : '')]), v.routeId),
          t('plugins.stg.f_route_webdav_h'));
        const peerF = field('peerId', t('plugins.stg.f_peer'), select('peerId', choices.peers.map((p) => [p.id, p.label + ' (' + p.ip + ')']), v.peerId));
        const portF = field('port', t('plugins.stg.f_port'), input('port', { type: 'number', value: v.kind === 'peer' && v.port ? v.port : '', placeholder: '443', max: 5 }), t('plugins.stg.f_port_webdav_h'));
        const urlF = field('url', t('plugins.stg.f_url'), input('url', { value: cfg.url, placeholder: 'https://nas.example.de:5006/GateControl' }), t('plugins.stg.f_url_h'));
        const urlViaH = el('small', { class: 'pgx-hint', id: 'pgx-stg-url-via', text: t('plugins.stg.f_url_via_h') });
        urlF.appendChild(urlViaH);
        const sync = () => { routeF.hidden = how.value !== 'route'; peerF.hidden = how.value !== 'peer'; portF.hidden = how.value !== 'peer'; urlViaH.hidden = how.value === 'host'; };
        how.addEventListener('change', sync);
        [routeF, peerF, portF, urlF].forEach((f) => form.appendChild(f));
        sync();
        form.appendChild(field('username', t('plugins.stg.f_user'), input('username', { value: cfg.username, max: 120 })));
        form.appendChild(field('password', t('plugins.stg.f_password'), secretInput('password')));
        form.appendChild(caField());
      } else {
        form.appendChild(field('endpoint', t('plugins.stg.f_endpoint'), input('endpoint', { value: cfg.endpoint, placeholder: 'https://fsn1.your-objectstorage.com' })));
        form.appendChild(field('region', t('plugins.stg.f_region'), input('region', { value: cfg.region, placeholder: 'us-east-1', max: 40 })));
        form.appendChild(field('bucket', t('plugins.stg.f_bucket'), input('bucket', { value: cfg.bucket, max: 63 })));
        form.appendChild(field('prefix', t('plugins.stg.f_prefix'), input('prefix', { value: cfg.prefix, placeholder: 'gatecontrol' }), t('plugins.stg.f_prefix_h')));
        form.appendChild(field('accessKeyId', t('plugins.stg.f_key'), input('accessKeyId', { value: cfg.accessKeyId, max: 128 })));
        form.appendChild(field('secretAccessKey', t('plugins.stg.f_secret'), secretInput('secretAccessKey')));
        const ps = el('input', { type: 'checkbox', id: 'pgx-stg-pathStyle' });
        ps.checked = cfg.pathStyle !== false;
        inputs.pathStyle = ps;
        form.appendChild(el('label', { class: 'pgx-check-line', 'data-field': 'pathStyle' }, [ps, t('plugins.stg.f_pathstyle')]));
        form.appendChild(caField());
        form.appendChild(el('p', { class: 'pgx-note', text: t('plugins.stg.s3_note') }));
      }
      const first = form.querySelector('input,select');
      if (first && !existing) setTimeout(() => { const l = inputs.label; if (l) l.focus(); }, 0);
    }

    function values() {
      const v = { kind };
      Object.keys(inputs).forEach((k) => { v[k] = inputs[k].type === 'checkbox' ? inputs[k].checked : inputs[k].value; });
      if (ST_CLOUD[kind]) {
        if (draft && draft.kind === kind) v.draft = draft.id;
        if (sel) { v.folderId = sel.folderId; v.folderPath = sel.folderPath; if (sel.driveId) v.driveId = sel.driveId; }
        if (existing && !(draft && draft.kind === kind)) v.account = cfg.account;
      }
      if (kind === 'smb' || kind === 'webdav') {
        const how = v.via;
        v.via = how === 'peer' ? { kind: 'peer', peerId: Number(v.peerId) } : how === 'route' ? { kind: 'route', routeId: Number(v.routeId) } : { kind: 'host' };
        delete v.peerId;
        delete v.routeId;
        if (kind === 'webdav' && how !== 'peer') delete v.port;
      }
      return v;
    }

    function showFail(r) {
      form.querySelectorAll('[data-invalid]').forEach((n) => n.removeAttribute('data-invalid'));
      if (r.field) {
        const f = form.querySelector('[data-field="' + r.field + '"]');
        if (f) { f.setAttribute('data-invalid', '1'); const i = f.querySelector('input,select,textarea'); if (i) i.focus(); }
      }
      err.textContent = r.error || t('plugins.err.generic');
      err.hidden = false;
    }

    function showCheck(c) {
      clear(result);
      const names = ['connect', 'folder', 'write', 'read', 'delete'];
      result.appendChild(el('ul', { class: 'pgx-checks pgx-stg-checks', id: 'pgx-stg-checks' }, names.map((n) => {
        const s = (c.steps || []).find((x) => x.step === n);
        const state = !s ? 'wait' : (s.ok ? 'ok' : 'fail');
        return el('li', { 'data-state': state === 'wait' ? 'warn' : state, 'data-step': n }, [
          el('span', { class: 'pgx-check-ic', 'aria-hidden': 'true', text: state === 'ok' ? '✓' : (state === 'fail' ? '✕' : '–') }),
          el('span', null, [el('b', { text: t('plugins.stg.step_' + n) }), state === 'fail' ? el('small', { text: stgErrorText(c.error, c.message) }) : null]),
        ]);
      })));
      if (c.ok) result.appendChild(el('p', { class: 'pgx-note pgx-note-good', id: 'pgx-stg-ok', text: [t('plugins.stg.check_ok'), fmtFree(c)].filter(Boolean).join(' · ') }));
      if (!c.ok && c.tls) result.appendChild(tlsBox(c.tls));
    }

    /**
     * After a TLS failure (docs/storage-targets.md "Certificates"): the
     * certificate the server presents, why it is not trusted, what helps —
     * and, after a confirmation with fingerprint and names, its leaf or the
     * CA certificates it sent as the target's own certificate.
     */
    function tlsBox(x) {
      const c = x.cert || { names: [], subject: '', issuer: '' };
      const fp = (f) => f.toUpperCase().match(/../g).join(':');
      const cn = (dn) => { const m = /(?:^|, )CN=([^,]+)/.exec(dn || ''); return m ? m[1] : dn; };
      const names = (z) => (z.names && z.names.length ? z.names.join(', ') : cn(z.subject));
      const day = (iso) => P.fmtDate(iso, lang);
      const kids = [el('h4', { class: 'pgx-stg-tls-h', text: t('plugins.stg.tls_title') })];
      if (x.reason) {
        kids.push(el('p', { class: 'pgx-note pgx-note-warn', id: 'pgx-stg-tls-why', 'data-reason': x.reason }, [icon(I.alert, 16), el('span', {
          text: t('plugins.stg.tls_' + x.reason, { host: x.host, names: names(c), issuer: cn(c.issuer), from: day(c.validFrom), to: day(c.validTo), code: x.code || '' }) })]));
      }
      (x.hints || []).forEach((h) => kids.push(el('p', { class: 'pgx-note', 'data-hint': h }, [icon(I.alert, 16), el('span', { text: t('plugins.stg.tls_hint_' + h) })])));
      // no TLS / a handshake refused: no certificate to show
      if (!x.cert) return el('div', { class: 'pgx-stg-tls', id: 'pgx-stg-tls' }, kids);
      kids.push(kv([
        [t('plugins.stg.tls_subject'), c.subject, true],
        [t('plugins.stg.tls_names'), c.names.join(', '), true],
        [t('plugins.stg.tls_issuer'), c.issuer, true],
        [t('plugins.stg.tls_valid'), day(c.validFrom) + ' – ' + day(c.validTo)],
        [t('plugins.stg.tls_fp'), fp(c.fingerprint), true],
        x.chain.length > 1 ? [t('plugins.stg.tls_chain'), x.chain.slice(1).map((z) => cn(z.subject)).join(' → ')] : null,
      ]));
      const cas = x.chain.slice(1).filter((z) => z.ca);
      // the confirmation stays in this dialog (a second one on top would close both on Escape)
      const ask = el('div', { class: 'pgx-stg-trust-ask', id: 'pgx-stg-trust-ask', role: 'group', hidden: true });
      const take = (certs, which) => {
        clear(ask);
        ask.setAttribute('data-which', which);
        ask.appendChild(el('b', { text: t('plugins.stg.tls_' + which + '_title') }));
        ask.appendChild(el('p', { class: 'pgx-hint', text: t('plugins.stg.tls_' + which + '_text') }));
        certs.forEach((z) => ask.appendChild(kv([[t('plugins.stg.tls_names'), names(z), true], [t('plugins.stg.tls_fp'), fp(z.fingerprint), true]])));
        ask.appendChild(el('div', { class: 'st-btnrow' }, [
          btn(t('common.cancel'), { small: true, ghost: true, onClick: () => { ask.hidden = true; } }),
          btn(t('plugins.stg.tls_trust_ok'), { small: true, primary: true, id: 'pgx-stg-trust-ok', onClick: () => {
            inputs.tlsCa.value = certs.map((z) => z.pem.trim()).join('\n') + '\n';
            ask.hidden = true;
            toast(t('plugins.stg.tls_taken'));
            checkBtn.click();
          } }),
        ]));
        ask.hidden = false;
      };
      const acts = [];
      if (inputs.tlsCa && x.trust && x.trust.leaf) acts.push(btn(t('plugins.stg.tls_trust'), { small: true, icon: I.shieldOk, id: 'pgx-stg-trust', onClick: () => take([c], 'trust') }));
      if (inputs.tlsCa && x.trust && x.trust.chain && cas.length) acts.push(btn(t('plugins.stg.tls_chain_take'), { small: true, id: 'pgx-stg-trust-chain', onClick: () => take(cas, 'chain') }));
      if (acts.length) kids.push(el('div', { class: 'st-btnrow pgx-stg-tls-acts' }, acts), ask);
      return el('div', { class: 'pgx-stg-tls', id: 'pgx-stg-tls' }, kids);
    }

    const cancel = el('button', { type: 'button', class: 'pgx-btn', text: t('common.cancel'), on: { click: () => d.close(null) } });
    const checkBtn = el('button', { type: 'button', class: 'pgx-btn', id: 'pgx-stg-check', text: t('plugins.stg.check') });
    const save = el('button', { type: 'button', class: 'pgx-btn pgx-btn-pri', id: 'pgx-stg-save', text: t('plugins.stg.save') });
    d.foot.appendChild(cancel);
    d.foot.appendChild(checkBtn);
    d.foot.appendChild(save);
    const busyOn = (on) => { checkBtn.disabled = on; save.disabled = on; };

    checkBtn.addEventListener('click', async () => {
      busyOn(true);
      err.hidden = true;
      clear(result);
      result.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.stg.checking') }));
      const body = Object.assign(values(), existing ? { id: existing.id } : {});
      const r = await req('POST', ST_API + '/check', body);
      busyOn(false);
      clear(result);
      if (!r.ok) { showFail(r); return; }
      showCheck(r.check);
    });
    save.addEventListener('click', async () => {
      busyOn(true);
      err.hidden = true;
      const r = existing ? await req('PATCH', ST_API + '/' + existing.id, values()) : await req('POST', ST_API, values());
      if (!r.ok) { busyOn(false); showFail(r); return; }
      clear(result);
      result.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.stg.checking') }));
      const c = await req('POST', ST_API + '/' + r.target.id + '/check', {});
      busyOn(false);
      toast(t(existing ? 'plugins.stg.saved' : 'plugins.stg.created'));
      if (c.ok && !c.check.ok) {
        // saved, but it does not work yet: keep the dialog open with the result
        existing = c.target;
        showCheck(c.check);
        return;
      }
      d.close(r.target);
    });

    render();
    const out = await d.promise;
    await loadTargets();
    if (VIEW === 'storage') renderStorage();
    return out;
  }

  // ════════════════════════════════════════════════════════════
  // Cloud-Konten (docs/cloud-accounts.md): the OAuth apps for Google and
  // Microsoft — for the storage targets "Google Drive" / "OneDrive" and the
  // people's import (gc.cloud) — and the people's connections
  // ════════════════════════════════════════════════════════════
  const CL_PROVIDERS = ['google', 'microsoft'];
  const CL_CONSOLE = { google: 'https://console.cloud.google.com/apis/credentials', microsoft: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' };

  async function viewCloud() {
    await loadInstalled();
    await loadCloud();
    if (!stg.cloud) showError(t('plugins.err.generic'));
    else renderCloud();
    done();
  }

  function copyText(v) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(() => toast(t('plugins.cloud.copied')), () => {});
  }

  function appState(a) {
    if (a.needsSecret) return pill(t('plugins.cloud.needs_secret'), 'warn', true);
    return a.configured ? pill(t('plugins.cloud.ready'), 'good', true) : pill(t('plugins.cloud.not_ready'), 'mute', true);
  }

  function renderCloud() {
    const C = stg.cloud;
    clear(main);
    main.appendChild(pageHead(t('plugins.cloud.title'), t('plugins.cloud.sub')));
    // the redirect URI to register at Google and Microsoft
    const uri = el('code', { class: 'pgx-mono pgx-cl-uri', id: 'pgx-cl-uri', text: C.redirectUri });
    main.appendChild(card([h2(t('plugins.cloud.redirect'), 'pgx-cl-redirect-h'),
      el('p', { class: 'pgx-muted', text: t('plugins.cloud.redirect_h') }),
      el('div', { class: 'pgx-inline' }, [uri, btn(t('plugins.cloud.copy'), { small: true, id: 'pgx-cl-copy', onClick: () => copyText(C.redirectUri) })]),
      C.https ? null : el('p', { class: 'pgx-note pgx-note-warn', id: 'pgx-cl-nohttps' }, [icon(I.alert, 16), el('span', { text: t('plugins.cloud.no_https') })]),
    ], { 'aria-labelledby': 'pgx-cl-redirect-h' }, 'pgx-pad pgx-stack-card'));
    CL_PROVIDERS.forEach((p) => main.appendChild(appCard(p, C.apps[p])));
    main.appendChild(connectionsCard(C.connections || []));
    main.appendChild(card([h2(t('plugins.cloud.about'), 'pgx-cl-about-h'),
      el('ul', { class: 'pgx-stg-about' }, ['target', 'import', 'secrets', 'hosts'].map((k) => el('li', null, [el('b', { text: t('plugins.cloud.about_' + k + '_t') }), ' ',
        t('plugins.cloud.about_' + k, { hosts: (C.hosts || []).join(', '), targets: String((C.targets || []).length) })]))),
      btn(t('plugins.cloud.to_storage'), { small: true, ghost: true, href: U.storage }),
    ], { 'aria-labelledby': 'pgx-cl-about-h' }, 'pgx-pad pgx-stack-card'));
  }

  /** One OAuth app: client id, secret (write-only), tenant (Microsoft), the scopes, the console. */
  function appCard(p, a) {
    const id = (n) => 'pgx-cl-' + p + '-' + n;
    const fld = (name, label, control, hint) => el('div', { class: 'pgx-stg-f', 'data-field': name }, [el('label', { class: 'pgx-lbl', for: id(name), text: label }), control,
      hint ? el('small', { class: 'pgx-hint', text: hint }) : null]);
    const clientId = el('input', { type: 'text', class: 'pgx-fld-in', id: id('clientId'), autocomplete: 'off', spellcheck: 'false', maxLength: 200, value: a.clientId || '' });
    const secret = el('input', { type: 'password', class: 'pgx-fld-in', id: id('clientSecret'), autocomplete: 'new-password', maxLength: 512,
      placeholder: a.secretSet ? t('plugins.stg.secret_kept') : '' });
    const tenant = p === 'microsoft' ? el('input', { type: 'text', class: 'pgx-fld-in', id: id('tenant'), autocomplete: 'off', spellcheck: 'false', maxLength: 200, value: a.tenant || 'common' }) : null;
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    const save = btn(t('plugins.cloud.save'), { small: true, primary: true, id: id('save'), onClick: async () => {
      err.hidden = true;
      const body = { clientId: clientId.value, clientSecret: secret.value };
      if (tenant) body.tenant = tenant.value;
      const r = await req('PUT', CL_API + '/apps/' + p, body);
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      toast(t('plugins.cloud.saved'));
      await loadCloud();
      renderCloud();
    } });
    const remove = a.clientId ? btn(t('plugins.cloud.remove'), { small: true, ghost: true, id: id('remove'), onClick: async () => {
      if (!(await D.confirm({ title: t('plugins.cloud.remove_title', { provider: t('plugins.cloud.p_' + p) }), message: t('plugins.cloud.remove_text'), okLabel: t('plugins.cloud.remove'), danger: true }))) return;
      const r = await req('DELETE', CL_API + '/apps/' + p);
      if (!r.ok) { toast(r.error, 'error'); return; }
      toast(t('plugins.cloud.removed'));
      await loadCloud();
      renderCloud();
    } }) : null;
    const scopes = a.scopes || {};
    return card([
      el('div', { class: 'pgx-card-h' }, [el('span', { class: 'pgx-ic', 'data-size': 'md', 'data-cat': 'system', 'aria-hidden': 'true' }, [icon(ST_ICON[p === 'google' ? 'gdrive' : 'onedrive'], 22)]),
        h2(t('plugins.cloud.app_' + p), id('h')), appState(a)]),
      el('div', { class: 'pgx-stg-form pgx-in-pad' }, [
        el('p', { class: 'pgx-muted' }, [t('plugins.cloud.app_' + p + '_h'), ' ', el('a', { class: 'pgx-a', href: CL_CONSOLE[p], target: '_blank', rel: 'noopener noreferrer', text: t('plugins.cloud.console_' + p) })]),
        fld('clientId', t('plugins.cloud.f_client_id'), clientId),
        fld('clientSecret', t('plugins.cloud.f_client_secret'), secret, a.needsSecret ? t('plugins.cloud.needs_secret_h') : null),
        tenant ? fld('tenant', t('plugins.cloud.f_tenant'), tenant, t('plugins.cloud.f_tenant_h')) : null,
        kv([[t('plugins.cloud.scope_import'), scopes.import, true], [t('plugins.cloud.scope_target'), scopes.target, true]]),
        err,
        el('div', { class: 'pgx-inline' }, [save, remove]),
      ]),
    ], { 'aria-labelledby': id('h'), 'data-provider': p, id: id('card') }, 'pgx-flush');
  }

  /** The people's connections (gc.cloud): who, which plugin, which account; "Trennen". */
  function connectionsCard(list) {
    const rows = list.map((c) => el('div', { class: 'pgx-row pgx-stg-row', 'data-connection': c.id }, [
      el('span', { class: 'pgx-ic', 'data-size': 'md', 'data-cat': 'system', 'aria-hidden': 'true' }, [icon(ST_ICON[c.provider === 'google' ? 'gdrive' : 'onedrive'], 22)]),
      el('span', { class: 'pgx-t pgx-grow' }, [
        el('b', { text: c.user.name + ' · ' + (c.account || t('plugins.cloud.p_' + c.provider)) }),
        el('small', { class: 'pgx-muted', text: [t('plugins.cloud.p_' + c.provider), c.pluginName, t('plugins.cloud.since', { at: fmtDateTime(c.connectedAt) })].filter(Boolean).join(' · ') }),
        c.error ? el('p', { class: 'pgx-stg-err', text: t('plugins.cloud.conn_auth') }) : null,
      ]),
      el('span', { class: 'pgx-acts' }, [btn(t('plugins.cloud.disconnect'), { small: true, ghost: true, action: 'disconnect', onClick: async () => {
        if (!(await D.confirm({ title: t('plugins.cloud.disconnect_title'), message: t('plugins.cloud.disconnect_text', { name: c.user.name }), okLabel: t('plugins.cloud.disconnect'), danger: true }))) return;
        const r = await req('DELETE', CL_API + '/connections/' + enc(c.id));
        if (!r.ok) { toast(r.error, 'error'); return; }
        toast(t('plugins.cloud.disconnected'));
        await loadCloud();
        renderCloud();
      } })]),
    ]));
    return card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.cloud.connections'), 'pgx-cl-conn-h')]),
      rows.length ? el('div', { class: 'pgx-stg-list', id: 'pgx-cl-conns' }, rows) : el('p', { class: 'pgx-muted pgx-in-pad', id: 'pgx-cl-empty', text: t('plugins.cloud.connections_empty') })],
    { 'aria-labelledby': 'pgx-cl-conn-h' }, 'pgx-flush pgx-list');
  }

  // ════════════════════════════════════════════════════════════
  // Protokoll
  // ════════════════════════════════════════════════════════════
  let logFilter = 'all';
  async function viewLog() {
    const [, r] = await Promise.all([loadInstalled(), req('GET', API + '/history'), loadCatalog(false)]);
    renderLog((r && r.history) || []);
    done();
  }

  function renderLog(hist) {
    clear(main);
    main.appendChild(pageHead(t('plugins.area.log'), t('plugins.x.log_sub')));
    const kinds = { all: () => true, install: (h) => h.action === 'install', update: (h) => h.action === 'update', uninstall: (h) => h.action === 'uninstall' };
    const seg = el('div', { class: 'pgx-seg', role: 'group', 'aria-label': t('plugins.x.filter') }, Object.keys(kinds).map((k) => el('button', {
      type: 'button', 'aria-pressed': String(logFilter === k), on: { click: () => { logFilter = k; renderLog(hist); } },
    }, [t('plugins.x.log_f_' + k), el('em', { text: String(hist.filter(kinds[k]).length) })])));
    main.appendChild(el('div', { class: 'pgx-toolbar' }, [seg]));
    const shown = hist.filter(kinds[logFilter] || kinds.all);
    main.appendChild(card([el('div', { class: 'pgx-card-h' }, [h2(t('plugins.x.log_title'), 'pgx-logv-h')])]
      .concat(shown.length ? shown.map(historyRow) : [el('p', { class: 'pgx-empty', text: t('plugins.x.log_empty') })]), { 'aria-labelledby': 'pgx-logv-h' }, 'pgx-flush'));
  }

  // ── Wiring ──
  const fileIn = $('pgx-file');
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    if (VIEW === 'security') { await stage(f); return; }
    const r = await uploadFile(f);
    if (r) { const p = await installDialog(r.info, r.file, null); if (p) location.href = U.manage(p.id); }
  });

  const VIEWS = new Map([['installed', viewInstalled], ['catalog', viewCatalog], ['catalogItem', viewCatalogItem], ['manage', viewManage], ['updates', viewUpdates],
    ['licenses', viewLicenses], ['security', viewSecurity], ['storage', viewStorage], ['cloud', viewCloud], ['log', viewLog]]);
  const start = VIEWS.get(VIEW) || viewInstalled;
  start().catch(() => { showError(t('plugins.err.generic')); busy.setAttribute('aria-busy', 'false'); });
}());
