'use strict';

// The plugin area (templates/aurora/pages/plugins.njk, docs/plugins.md
// "Plugin area"). One script for every view of /plugins:
//
//   installed    Meine Plugins: state tiles, "Braucht deine Aufmerksamkeit",
//                search / filter / list or tiles grouped by area, suggestions
//                from the catalogue; without plugins: the first-run page
//   catalog      the catalogue as a store: areas, search, sort, highlight, cards
//   catalogItem  one catalogue plugin: description, versions, install panel
//   manage       one installed plugin: overview, settings, permissions,
//                licence, log, versions; restart, switch, update, uninstall
//   updates      updates with release notes, "Alle aktualisieren", automatic
//                updates, history
//   licenses     licence key without naming the plugin, all licences
//   security     upload with preview, unsigned plugins, media in backups,
//                update checks, catalogue source
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
  const SHOP_URL = 'https://callmetechie.de/products/gatecontrol/pricing';

  let STR = {};
  try { STR = JSON.parse(document.getElementById('pgx-i18n').textContent || '{}'); } catch (_) { STR = {}; }
  function t(key, params) {
    let s = STR[key] != null ? STR[key] : ((window.GC && window.GC.t && window.GC.t[key] != null) ? window.GC.t[key] : key);
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  const $ = (id) => document.getElementById(id);
  const main = $('pgx-main');
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  const query = new URLSearchParams(location.search);
  const enc = encodeURIComponent;

  const NS = 'http://www.w3.org/2000/svg';
  function icon(d, size) {
    const svg = document.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', String(size || 20)], ['height', String(size || 20)], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '1.9'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/.test(d || '') ? d : P.ICON_PATHS.puzzle);
    svg.appendChild(p);
    return svg;
  }
  const I = {
    check: 'M5 12l5 5 9-10', x: 'M6 6l12 12M18 6L6 18', back: 'M15 18l-6-6 6-6', next: 'M9 6l6 6-6 6', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
    upload: 'M12 20V9M7 13l5-5 5 5M5 4h14', download: 'M12 4v11M7 10l5 5 5-5M5 20h14', plus: 'M12 5v14M5 12h14', refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
    shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4', key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 12l9-9M16 7l3 3',
    alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16.5h.01', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', more: 'M12 6h.01M12 12h.01M12 18h.01',
    app: 'M9 2.5h6A2.5 2.5 0 0 1 17.5 5v14a2.5 2.5 0 0 1-2.5 2.5H9A2.5 2.5 0 0 1 6.5 19V5A2.5 2.5 0 0 1 9 2.5zM11 18.5h2', portal: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4zM3 9h18',
    page: 'M6 3h8l4 4v14H6zM14 3v4h4', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4', link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    spark: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z', file: 'M6 3h8l4 4v14H6zM14 3v4h4', power: 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0',
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
  function catItem(id) { return cat.plugins.find((x) => x.id === id) || null; }
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

  function showError(msg) {
    const e = $('pgx-err');
    e.textContent = msg || t('plugins.err.generic');
    e.hidden = false;
  }

  // ── Small building blocks ──
  const TONE = { good: 'good', info: 'info', crit: 'crit', warn: 'warn', off: 'off' };
  function pill(text, tone, dot) {
    return el('span', { class: 'pgx-pill', 'data-tone': TONE[tone] || 'off' }, [dot ? el('span', { class: 'pgx-dot', 'aria-hidden': 'true' }) : null, text]);
  }
  function statusPill(p) {
    const s = P.statusChip(p);
    return pill(t(s.key), s.tone, true);
  }
  function plugIcon(id, installed, size) {
    const meta = metaOf(id);
    return el('span', { class: 'pgx-ic' + (size === 'lg' ? ' pgx-ic-lg' : (size === 'xl' ? ' pgx-ic-xl' : (size === 'sm' ? ' pgx-ic-sm' : ''))), 'data-cat': P.categoryOf(meta), 'aria-hidden': 'true' },
      [icon(P.iconPath(meta, installed), size === 'xl' ? 40 : (size === 'lg' ? 30 : (size === 'sm' ? 17 : 22)))]);
  }
  function btn(text, o) {
    const opt = o || {};
    const cls = 'st-btn' + (opt.primary ? ' st-btn-primary' : '') + (opt.danger ? ' st-btn-danger' : '') + (opt.small ? ' st-btn-sm' : '') + (opt.cls ? ' ' + opt.cls : '');
    const kids = [opt.icon ? icon(opt.icon, 16) : null, text];
    if (opt.href) return el('a', { class: cls, href: opt.href, id: opt.id || null, target: opt.external ? '_blank' : null, rel: opt.external ? 'noopener noreferrer' : null }, kids);
    return el('button', { type: 'button', class: cls, id: opt.id || null, disabled: !!opt.disabled, 'data-action': opt.action || null, on: opt.onClick ? { click: opt.onClick } : null }, kids);
  }
  function switchBtn(on, label, onClick, id) {
    return el('button', { type: 'button', class: 'st-switch', role: 'switch', id: id || null, 'aria-checked': on ? 'true' : 'false', 'aria-label': label, on: { click: onClick } },
      [el('span', { class: 'st-knob', 'aria-hidden': 'true' })]);
  }
  function card(cls, kids, attrs) { return el('section', Object.assign({ class: 'pgx-card' + (cls ? ' ' + cls : '') }, attrs || {}), kids); }
  function cardHead(title, extra, id) {
    return el('div', { class: 'pgx-card-head' }, [el('h2', { class: 'pgx-h2', id: id || null, text: title })].concat(extra || []));
  }
  function lbl(text) { return el('span', { class: 'pgx-lbl', text }); }
  function kv(rows) {
    return el('dl', { class: 'pgx-kv' }, rows.filter(Boolean).reduce((acc, r) => acc.concat([el('dt', { text: r[0] }), el('dd', { class: r[2] ? 'st-mono' : null, text: r[1] == null || r[1] === '' ? '—' : String(r[1]) })]), []));
  }
  function catName(c) { return t('plugins.x.cat.' + c); }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(typeof iso === 'number' ? iso : String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso)) || String(iso).includes('T') ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
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
  /** Release notes as text nodes (CHANGELOG markdown, plugins-ui.js noteLines). */
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

  /** Short "what it adds" chips of an installed plugin. */
  function addChips(p) {
    const out = [];
    if (p.app) out.push(t('plugins.x.add_app'));
    if (p.portal && p.portal.label) out.push(t('plugins.x.add_portal'));
    else if (p.portal && (p.portal.sections || []).length) out.push(t('plugins.x.add_portal_sections', { n: p.portal.sections.length }));
    if (p.nav) out.push(t('plugins.x.add_page'));
    if (p.permissions && p.permissions.notify) out.push(t('plugins.x.add_notify'));
    if (p.permissions && p.permissions.background) out.push(t('plugins.x.add_bg'));
    if (p.provides && p.provides.length) out.push(t('plugins.x.add_services', { n: p.provides.length }));
    return out;
  }

  function noteOf(p) {
    if (p.status === 'crashed') return t('plugins.note.crashed', { error: (p.process && p.process.lastError) || '' });
    if (p.status === 'blocked') return t('plugins.reason.' + (p.reason || 'broken'));
    if (P.licenseExpiring(p)) return t('plugins.x.lic_expiring_on', { date: P.fmtDate(p.license.expiresAt, lang) });
    const m = catItem(p.id);
    return (m && m.summary) || p.description || '';
  }

  function updateNav() {
    const set = (id, n, tone) => {
      const e = $('pgx-count-' + id);
      if (!e) return;
      e.hidden = !n;
      e.textContent = n ? String(n) : '';
      e.setAttribute('data-tone', tone || 'off');
    };
    set('installed', inst.loaded ? inst.plugins.length : 0, 'off');
    if (cat.available) set('catalog', cat.plugins.length, 'off');
    const ups = cat.plugins.filter((x) => x.state === 'update').length;
    set('updates', ups, 'info');
    const lic = inst.plugins.filter((p) => p.license && p.license.required && !['valid', 'not_required'].includes(p.license.state)).length;
    set('licenses', lic, 'warn');
  }

  function done() { main.setAttribute('aria-busy', 'false'); updateNav(); }

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

  function permRowsBox(perm, existing) {
    const sens = P.sensitivePerms(perm).map((k) => t(k));
    const box = el('div', { class: 'pgx-perms' });
    if (existing && existing.permissions) {
      const diff = P.permDiff(perm, existing.permissions, t);
      box.appendChild(el('p', { class: 'pgx-note' + (diff.changed ? ' pgx-note-warn' : ''), role: 'note', id: 'pgx-perm-diff', 'data-changed': String(diff.changed),
        text: diff.changed ? t('plugins.in.perms_changed', { from: existing.version, n: diff.changed }) : t('plugins.in.perms_same', { from: existing.version }) }));
      diff.rows.forEach((r) => box.appendChild(el('div', { class: 'pgx-perm', 'data-change': r.change || 'same', 'data-sensitive': sens.indexOf(r.label) >= 0 ? '1' : null }, [
        el('b', null, [r.label, r.change ? ' ' : null, r.change ? pill(t('plugins.perm.diff_' + r.change), 'warn') : null]),
        el('span', null, [r.value, r.change === 'changed' ? el('span', { class: 'pgx-muted pgx-block', text: t('plugins.perm.diff_before', { value: r.old }) }) : null]),
      ])));
      diff.removed.forEach((r) => box.appendChild(el('div', { class: 'pgx-perm', 'data-change': 'removed' }, [
        el('b', null, [r.label, ' ', pill(t('plugins.perm.diff_removed'), 'good')]), el('span', { class: 'pgx-gone', text: r.value })])));
      return box;
    }
    P.permRows(perm, t).forEach((r) => box.appendChild(el('div', { class: 'pgx-perm', 'data-sensitive': sens.indexOf(r.label) >= 0 ? '1' : null }, [el('b', { text: r.label }), el('span', { text: r.value })])));
    return box;
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
    const d = D.dialog({ title: t(isUpdate ? 'plugins.in.title_update' : 'plugins.in.title'), wide: true });
    const body = el('div', { class: 'pgx-in' });
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(body);
    d.body.appendChild(err);
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } });
    const go = el('button', { type: 'button', class: 'btn btn-primary', id: 'pgx-in-go' });
    d.foot.appendChild(cancel);
    d.foot.appendChild(go);
    const keyIn = el('input', { type: 'text', class: 'st-input st-mono pgx-key', id: 'pgx-in-key', placeholder: t('plugins.lic.placeholder'), maxLength: 200, autocomplete: 'off', spellcheck: 'false' });
    const accept = el('input', { type: 'checkbox', id: 'pgx-in-accept' });
    const setup = el('input', { type: 'checkbox', id: 'pgx-in-setup' });
    setup.checked = true;
    let phase = 'check';
    let installed = null;
    let result = null;

    const steps = () => el('ol', { class: 'pgx-steps', 'aria-label': t('plugins.in.steps') }, [['check', 1], ['install', 2]].map(([k, n]) => {
      const doneStep = k === 'check' && phase !== 'check';
      return el('li', { 'aria-current': (phase === k || (k === 'install' && phase === 'done')) ? 'step' : 'false', 'data-done': doneStep || phase === 'done' ? '1' : '0' },
        [el('span', { class: 'pgx-step-n', text: doneStep || (phase === 'done') ? '✓' : String(n) }), t('plugins.x.step_' + k)]);
    }));

    function header() {
      const id = plugin ? plugin.id : '';
      return el('div', { class: 'pgx-in-head' }, [
        plugin ? plugIcon(id, installedOf(id), 'lg') : el('span', { class: 'pgx-ic pgx-ic-lg' }, [icon(I.file, 26)]),
        el('div', { class: 'pgx-in-title' }, [
          el('b', { text: plugin ? plugin.name + ' ' + plugin.version : file.name }),
          el('span', { class: 'pgx-muted', text: [P.fmtBytes(file.size), plugin ? (plugin.verified ? t('plugins.x.signed_by', { publisher: plugin.publisher }) : t('plugins.badge.unverified')) : '',
            info.origin === 'catalog' ? t('plugins.x.from_catalog') : t('plugins.x.from_upload')].filter(Boolean).join(' · ') }),
        ]),
      ]);
    }

    function render() {
      clear(body);
      err.hidden = true;
      body.appendChild(steps());
      body.appendChild(header());
      if (phase === 'check') {
        const failed = (info.checks || []).filter((c) => c.status !== 'ok');
        const checks = el('ul', { class: 'pgx-checks', id: 'pgx-checks' }, (failed.length ? info.checks : []).map((c) => {
          const k = P.checkKeys(c);
          const params = Object.assign({}, c.params || {});
          return el('li', { 'data-state': c.status, 'data-check': c.key + '.' + c.code }, [el('span', { class: 'pgx-check-ic', 'aria-hidden': 'true', text: P.checkSymbol(c.status) }),
            el('span', null, [el('b', { text: t(k.title, params) }), el('span', { class: 'pgx-muted pgx-block', text: t(k.detail, params) })])]);
        }));
        if (!failed.length) {
          body.appendChild(el('p', { class: 'pgx-ok-line', id: 'pgx-checks-ok' }, [icon(I.check, 16), t('plugins.x.checks_ok', { n: (info.checks || []).length })]));
        } else body.appendChild(checks);
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
          body.appendChild(keyIn);
          body.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.x.key_later') }));
        }
        body.appendChild(el('label', { class: 'pgx-check-line' }, [accept, t('plugins.in.accept')]));
        if (!isUpdate) body.appendChild(el('label', { class: 'pgx-check-line' }, [setup, t('plugins.x.setup_after')]));
        go.textContent = t(isUpdate ? 'plugins.x.accept_update' : 'plugins.x.accept_install');
        go.disabled = !accept.checked;
        accept.onchange = () => { go.disabled = !accept.checked; };
      } else if (phase === 'install') {
        const rows = [['download', true], ['verify', true], ['install', false], ['start', false]];
        body.appendChild(el('ol', { class: 'pgx-progress' }, rows.map(([k, ok]) => el('li', { 'data-state': ok ? 'done' : (k === 'install' ? 'run' : 'wait') }, [
          el('span', { class: 'pgx-prog-ic', 'aria-hidden': 'true', text: ok ? '✓' : '' }), t('plugins.x.prog_' + k)]))));
        body.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.x.prog_bg') }));
        go.textContent = t('plugins.x.installing');
        go.disabled = true;
      } else {
        const p = installed;
        const running = p && p.status === 'running';
        body.appendChild(el('div', { class: 'pgx-done' }, [
          el('span', { class: 'pgx-done-ic', 'aria-hidden': 'true' }, [icon(I.check, 26)]),
          el('div', null, [
            el('h3', { class: 'pgx-h3', text: t(isUpdate ? 'plugins.in.done_update' : 'plugins.in.done', { name: plugin.name }) }),
            el('p', { class: 'pgx-muted', text: running ? t('plugins.x.done_running') : t('plugins.reason.' + ((p && p.reason) || 'starting')) }),
          ]),
        ]));
        if (result && result.licenseError) body.appendChild(el('p', { class: 'pgx-note pgx-note-warn', text: t('plugins.err.' + result.licenseError) }));
        const adds = p ? P.addsOf(p, t) : [];
        if (!isUpdate && adds.length) {
          body.appendChild(lbl(t('plugins.x.new_for_you')));
          body.appendChild(el('ul', { class: 'pgx-adds pgx-adds-tight' }, adds.map((a) => el('li', null, [el('b', { text: a.title }), el('span', { class: 'pgx-muted pgx-block', text: a.text })]))));
        }
        cancel.textContent = t('plugins.x.later');
        cancel.hidden = false;
        go.disabled = false;
        go.textContent = t(p && p.settingsCount && !isUpdate ? 'plugins.x.set_up' : 'plugins.x.show_plugin');
      }
    }

    go.addEventListener('click', async () => {
      if (phase === 'done') { d.close(installed); location.href = '/plugins/manage/' + enc(installed.id) + (installed.settingsCount && !isUpdate ? '?tab=settings' : ''); return; }
      if (phase !== 'check' || !accept.checked) return;
      phase = 'install';
      cancel.hidden = true;
      render();
      const r = await req('POST', API + '/install', { token: info.token, accept: true, licenseKey: keyIn.value.trim() || null });
      if (!r.ok) { phase = 'check'; cancel.hidden = false; render(); err.textContent = r.error; err.hidden = false; return; }
      installed = r.plugin;
      result = r;
      if (!isUpdate && setup.checked) {
        d.close(installed);
        location.href = '/plugins/manage/' + enc(installed.id) + (installed.settingsCount ? '?tab=settings' : '');
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
    const d = D.dialog({ title: t('plugins.x.update_all_title', { n: list.length }), wide: true });
    const box = el('div', { class: 'pgx-in' });
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(box);
    d.body.appendChild(err);
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } });
    const go = el('button', { type: 'button', class: 'btn btn-primary', id: 'pgx-ua-go', text: t('plugins.x.prepare'), disabled: true });
    d.foot.appendChild(cancel);
    d.foot.appendChild(go);
    const rows = list.map((it) => ({ it, state: 'wait', info: null, error: null }));
    const accept = el('input', { type: 'checkbox', id: 'pgx-ua-accept' });
    let phase = 'prepare';
    function render() {
      clear(box);
      box.appendChild(el('ul', { class: 'pgx-ua' }, rows.map((r) => {
        const changed = r.info && r.info.existing && !samePerm(r.info);
        return el('li', { 'data-state': r.state }, [
          plugIcon(r.it.id, installedOf(r.it.id), 'sm'),
          el('span', { class: 'pgx-grow' }, [el('b', { text: r.it.name }), el('span', { class: 'pgx-muted pgx-block st-mono', text: (r.it.installedVersion || '') + ' → ' + r.it.latest.version })]),
          changed ? pill(t('plugins.x.perm_changes'), 'warn') : null,
          el('span', { class: 'pgx-ua-state', text: t('plugins.x.ua_' + r.state) + (r.error ? ': ' + r.error : '') }),
        ]);
      })));
      if (phase === 'confirm') {
        const changes = rows.filter((r) => r.info && r.info.existing && !samePerm(r.info));
        if (changes.length) {
          changes.forEach((r) => { box.appendChild(lbl(r.it.name)); box.appendChild(permRowsBox(r.info.plugin.permissions, r.info.existing)); });
        }
        box.appendChild(el('label', { class: 'pgx-check-line' }, [accept, changes.length ? t('plugins.x.accept_changes') : t('plugins.x.accept_updates')]));
        go.textContent = t('plugins.x.update_n', { n: rows.filter((r) => r.state === 'ready').length });
        go.disabled = !accept.checked;
        accept.onchange = () => { go.disabled = !accept.checked; };
      }
    }
    function samePerm(info) { return JSON.stringify(info.plugin.permissions) === JSON.stringify(info.existing.permissions); }
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
      if (!accept.checked) return;
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

  // ════════════════════════════════════════════════════════════
  // Meine Plugins
  // ════════════════════════════════════════════════════════════
  const ui = { q: '', filter: query.get('filter') || 'all', layout: 'list' };
  try { ui.layout = localStorage.getItem('gc.plugins.layout') === 'grid' ? 'grid' : 'list'; } catch (_) { ui.layout = 'list'; }

  async function viewInstalled() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderInstalled();
    done();
  }

  function renderInstalled() {
    clear(main);
    if (!inst.loaded) return;
    if (!inst.plugins.length) { renderFirstRun(); return; }
    const ps = inst.plugins;
    const running = ps.filter((p) => p.status === 'running').length;
    const problems = ps.filter((p) => P.isProblem(p)).length;
    const ups = cat.plugins.filter((x) => x.state === 'update');
    const lic = ps.filter((p) => P.licenseExpiring(p) || (p.status === 'blocked' && p.reason === 'license')).length;

    main.appendChild(el('div', { class: 'pgx-lead' }, [
      el('p', { class: 'pgx-muted', text: [t('plugins.x.n_installed', { n: ps.length }), t('plugins.x.local'),
        cat.fetchedAt ? t('plugins.x.checked_ago', { ago: ago(cat.fetchedAt) }) : null].filter(Boolean).join(' · ') }),
      el('div', { class: 'pgx-actions' }, [btn(t('plugins.x.upload'), { href: '/plugins/security', icon: I.upload }),
        CATALOG_ON ? btn(t('plugins.x.discover'), { href: '/plugins/catalog', primary: true, icon: I.plus }) : null]),
    ]));

    const stat = (key, value, of, text, tone, href, filter) => el(href ? 'a' : 'button', {
      class: 'pgx-stat', href: href || null, type: href ? null : 'button', 'data-tone': tone, 'aria-pressed': filter ? String(ui.filter === filter) : null,
      on: filter ? { click: () => { ui.filter = ui.filter === filter ? 'all' : filter; renderInstalled(); } } : null,
    }, [el('span', { class: 'pgx-lbl', text: t('plugins.x.stat_' + key) }), el('b', null, [String(value), of != null ? el('small', { text: ' / ' + of }) : null]), el('span', { class: 'pgx-muted', text })]);
    main.appendChild(el('div', { class: 'pgx-stats' }, [
      stat('running', running, ps.length, t('plugins.x.stat_running_d'), 'good', null, 'active'),
      stat('problems', problems, null, problems ? ps.filter((p) => P.isProblem(p)).map((p) => p.name).join(', ') : t('plugins.x.stat_none'), problems ? 'crit' : 'off', null, 'problems'),
      stat('updates', ups.length, null, ups.length ? t('plugins.x.stat_updates_d') : t('plugins.x.stat_uptodate'), ups.length ? 'info' : 'off', '/plugins/updates'),
      stat('licenses', lic, null, lic ? t('plugins.x.stat_lic_d') : t('plugins.x.stat_lic_ok'), lic ? 'warn' : 'off', '/plugins/licenses'),
    ]));

    const att = P.attention(ps, cat.plugins);
    if (att.length) main.appendChild(attentionCard(att));

    const search = el('input', { type: 'search', class: 'pgx-search-in', id: 'pgx-q', placeholder: t('plugins.x.search_installed'), 'aria-label': t('plugins.x.search_installed'), value: ui.q });
    const seg = el('div', { class: 'pgx-seg', role: 'group', 'aria-label': t('plugins.x.filter') }, ['all', 'active', 'problems', 'off'].map((f) => el('button', {
      type: 'button', 'aria-pressed': String(ui.filter === f), 'data-filter': f, on: { click: () => { ui.filter = f; renderInstalled(); } },
    }, [t('plugins.x.f_' + f), el('em', { text: String(P.filterInstalled(ps, f).length) })])));
    const layoutSeg = el('div', { class: 'pgx-seg', role: 'group', 'aria-label': t('plugins.x.layout') }, [['list', I.list], ['grid', I.grid]].map(([k, ic]) => el('button', {
      type: 'button', 'aria-pressed': String(ui.layout === k), 'aria-label': t('plugins.x.layout_' + k), title: t('plugins.x.layout_' + k),
      on: { click: () => { ui.layout = k; try { localStorage.setItem('gc.plugins.layout', k); } catch (_) { /* private mode */ } renderInstalled(); } },
    }, [icon(ic, 17)])));
    main.appendChild(el('div', { class: 'pgx-toolbar' }, [el('label', { class: 'pgx-search' }, [icon(I.search, 17), search]), seg, layoutSeg]));

    const listBox = el('div', { id: 'pgx-list' });
    main.appendChild(listBox);
    const fill = () => {
      clear(listBox);
      const shown = P.filterInstalled(ps, ui.filter).filter((p) => P.matches(Object.assign({}, metaOf(p.id), p), ui.q));
      if (!shown.length) { listBox.appendChild(el('p', { class: 'pgx-empty', text: t('plugins.x.none_match') })); return; }
      const groups = P.groupByCategory(shown, (p) => metaOf(p.id));
      const wrap = el('div', { class: ui.layout === 'grid' ? 'pgx-tiles' : 'pgx-card pgx-list' });
      groups.forEach((g) => {
        if (ui.layout === 'grid') {
          wrap.appendChild(el('div', { class: 'pgx-group-h pgx-span' }, [el('span', { class: 'pgx-lbl', text: catName(g.category) }), el('span', { class: 'pgx-muted', text: String(g.items.length) })]));
          g.items.forEach((p) => wrap.appendChild(pluginTile(p)));
        } else {
          wrap.appendChild(el('div', { class: 'pgx-group-h' }, [el('span', { class: 'pgx-lbl', text: catName(g.category) }), el('span', { class: 'pgx-muted', text: String(g.items.length) })]));
          g.items.forEach((p) => wrap.appendChild(pluginRow(p)));
        }
      });
      listBox.appendChild(wrap);
    };
    search.addEventListener('input', () => { ui.q = search.value; fill(); });
    fill();

    const sugg = cat.plugins.filter((x) => x.state === 'not_installed').slice(0, 3);
    if (sugg.length) {
      main.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-sugg-h' }, [
        el('div', { class: 'pgx-sec-head' }, [el('h2', { class: 'pgx-h2', id: 'pgx-sugg-h', text: t('plugins.x.suggestions') }), el('a', { class: 'pgx-more', href: '/plugins/catalog', text: t('plugins.x.whole_catalog') })]),
        el('div', { class: 'pgx-mini-grid' }, sugg.map((x) => el('a', { class: 'pgx-card pgx-mini', href: '/plugins/catalog/' + enc(x.id) }, [
          plugIcon(x.id, null), el('span', { class: 'pgx-grow' }, [el('b', { text: x.name }), el('span', { class: 'pgx-muted pgx-block', text: x.summary || x.description })]),
          el('span', { class: 'st-btn st-btn-sm', text: t('plugins.x.view') }),
        ]))),
      ]));
    }
  }

  function enabledSwitch(p) {
    return switchBtn(p.enabled, t('plugins.x.active_of', { name: p.name }), async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      if (await setEnabled(p, !p.enabled)) { await loadInstalled(); renderInstalled(); } else b.disabled = false;
    });
  }

  function pluginRow(p) {
    const href = '/plugins/manage/' + enc(p.id);
    return el('div', { class: 'pgx-row', 'data-plugin': p.id, 'data-status': p.status }, [
      plugIcon(p.id, p),
      el('div', { class: 'pgx-row-name' }, [
        el('a', { class: 'pgx-row-link', href }, [el('b', { text: p.name }), el('span', { class: 'pgx-ver', text: p.version })]),
        el('span', { class: 'pgx-muted pgx-clamp', 'data-tone': P.isProblem(p) ? 'crit' : null, text: noteOf(p) }),
      ]),
      el('div', { class: 'pgx-chips' }, addChips(p).map((x) => el('span', { class: 'pgx-chip', text: x }))),
      updatePill(p) || statusPill(p),
      enabledSwitch(p),
    ]);
  }

  function pluginTile(p) {
    return el('div', { class: 'pgx-card pgx-tile', 'data-plugin': p.id, 'data-status': p.status }, [
      el('div', { class: 'pgx-tile-top' }, [plugIcon(p.id, p), el('a', { class: 'pgx-row-link pgx-grow', href: '/plugins/manage/' + enc(p.id) }, [el('b', { text: p.name }), el('span', { class: 'pgx-ver', text: p.version })]), enabledSwitch(p)]),
      el('p', { class: 'pgx-muted pgx-clamp', text: noteOf(p) }),
      el('div', { class: 'pgx-tile-foot' }, [updatePill(p) || statusPill(p), el('div', { class: 'pgx-chips' }, addChips(p).slice(0, 3).map((x) => el('span', { class: 'pgx-chip', text: x })))]),
    ]);
  }

  function updatePill(p) {
    const c = catItem(p.id);
    return c && c.state === 'update' && c.latest && p.status !== 'crashed' && p.status !== 'blocked' ? pill(t('plugins.x.update_to', { version: c.latest.version }), 'info') : null;
  }

  function attentionCard(items) {
    const rows = items.map((a) => {
      if (a.kind === 'updates') {
        const list = a.ids.map((id) => catItem(id)).filter(Boolean);
        return el('div', { class: 'pgx-att', 'data-kind': 'updates' }, [
          el('span', { class: 'pgx-ic', 'data-cat': 'update', 'aria-hidden': 'true' }, [icon(I.refresh, 22)]),
          el('span', { class: 'pgx-grow' }, [el('b', { text: t('plugins.x.att_updates', { n: list.length }) }),
            el('span', { class: 'pgx-muted pgx-block', text: list.map((x) => x.name + ' ' + x.installedVersion + ' → ' + x.latest.version).join(' · ') })]),
          btn(t('plugins.x.whats_new'), { href: '/plugins/updates', small: true }),
          btn(t('plugins.x.update_all'), { small: true, primary: true, id: 'pgx-att-update-all', onClick: () => updateAll(list, async () => { await Promise.all([loadInstalled(), loadCatalog(false)]); renderInstalled(); updateNav(); }) }),
        ]);
      }
      const p = installedOf(a.id);
      const tone = a.kind === 'expiring' || a.kind === 'unsigned' ? 'warn' : 'crit';
      const actions = [];
      if (a.kind === 'crashed') {
        actions.push(btn(t('plugins.tab.log'), { href: '/plugins/manage/' + enc(p.id) + '?tab=log', small: true }));
        actions.push(btn(t('plugins.x.restart'), { small: true, primary: true, onClick: async (e) => { e.currentTarget.disabled = true; await restart(p); await loadInstalled(); renderInstalled(); } }));
      } else if (a.kind === 'license' || a.kind === 'expiring') {
        actions.push(btn(t(a.kind === 'expiring' ? 'plugins.x.renew' : 'plugins.banner.license_action'), { href: '/plugins/manage/' + enc(p.id) + '?tab=license', small: true, primary: a.kind === 'license' }));
      } else if (a.kind === 'unsigned') {
        actions.push(btn(t('plugins.banner.unsigned_action'), { href: '/plugins/security', small: true }));
      } else if (a.kind === 'incompatible') {
        const c = catItem(p.id);
        if (c && c.state === 'update') actions.push(btn(t('plugins.cat.update'), { small: true, primary: true, onClick: (e) => installFromCatalog(c, e.currentTarget).then(reloadInstalled) }));
      } else actions.push(btn(t('plugins.x.details'), { href: '/plugins/manage/' + enc(p.id), small: true }));
      const text = a.kind === 'crashed' ? ((p.process && p.process.lastError) || t('plugins.reason.crashed'))
        : (a.kind === 'expiring' ? t('plugins.x.att_expiring_d', { date: P.fmtDate(p.license.expiresAt, lang) }) : (a.kind === 'license' ? t('plugins.lic.state.' + ((p.license && p.license.state) || 'missing')) + ' · ' + t('plugins.reason.license') : t('plugins.reason.' + (a.kind === 'broken' ? (p.reason || 'broken') : a.kind))));
      return el('div', { class: 'pgx-att', 'data-kind': a.kind }, [
        plugIcon(p.id, p),
        el('span', { class: 'pgx-grow' }, [el('b', { text: t('plugins.x.att_' + a.kind, { name: p.name }) }), el('span', { class: 'pgx-muted pgx-block', text })]),
        pill(t(a.kind === 'expiring' ? 'plugins.lic.state.expiring' : P.statusChip(p).key), tone, true),
      ].concat(actions));
    });
    return card('pgx-att-card', [cardHead(t('plugins.x.attention'), [pill(String(items.length), 'off')], 'pgx-att-h')].concat(rows), { 'aria-labelledby': 'pgx-att-h', id: 'pgx-attention' });
  }

  async function reloadInstalled() { await Promise.all([loadInstalled(), loadCatalog(false)]); renderInstalled(); updateNav(); }

  function renderFirstRun() {
    if (cat.loaded && !cat.available && !cat.disabled) {
      main.appendChild(el('div', { class: 'pgx-note pgx-note-warn pgx-row-note', role: 'status' }, [icon(I.alert, 18), el('span', { class: 'pgx-grow', text: t('plugins.x.offline') }),
        btn(t('plugins.x.retry'), { small: true, onClick: async () => { await loadCatalog(true); renderInstalled(); updateNav(); } })]));
    }
    main.appendChild(el('div', { class: 'pgx-first' }, [
      el('span', { class: 'pgx-eyebrow', text: t('plugins.area.title') }),
      el('h2', { class: 'pgx-display', text: t('plugins.x.first_title') }),
      el('p', { class: 'pgx-muted pgx-big', text: t('plugins.x.first_text') }),
      el('div', { class: 'pgx-actions' }, [CATALOG_ON ? btn(t('plugins.x.open_catalog'), { href: '/plugins/catalog', primary: true }) : null, btn(t('plugins.x.upload'), { href: '/plugins/security' })]),
    ]));
    const groups = P.groupByCategory(cat.plugins, (x) => x).filter((g) => g.category !== 'other');
    if (groups.length) {
      main.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-bundles-h' }, [
        el('h2', { class: 'pgx-h2', id: 'pgx-bundles-h', text: t('plugins.x.bundles') }),
        el('div', { class: 'pgx-mini-grid' }, groups.map((g) => el('a', { class: 'pgx-card pgx-bundle', href: '/plugins/catalog?cat=' + enc(g.category) }, [
          el('span', { class: 'pgx-stack' }, g.items.slice(0, 4).map((x) => plugIcon(x.id, null, 'sm'))),
          el('b', { text: t('plugins.x.bundle.' + g.category) }),
          el('span', { class: 'pgx-muted', text: g.items.map((x) => x.name).join(', ') }),
          el('span', { class: 'pgx-more', text: t('plugins.x.n_view', { n: g.items.length }) }),
        ]))),
      ]));
    }
    main.appendChild(card('pgx-how', [cardHead(t('plugins.x.how')), el('ol', { class: 'pgx-how-list' }, [1, 2, 3].map((n) => el('li', null, [
      el('span', { class: 'pgx-how-n', text: String(n) }), el('span', null, [el('b', { text: t('plugins.x.how' + n) }), el('span', { class: 'pgx-muted pgx-block', text: t('plugins.x.how' + n + '_d') })]),
    ])))]));
  }

  // ════════════════════════════════════════════════════════════
  // Katalog
  // ════════════════════════════════════════════════════════════
  const cf = { q: query.get('q') || '', cat: query.get('cat') || 'all', sort: 'recommended', installed: true, notInstalled: true, updatesOnly: false, compatibleOnly: true };

  async function viewCatalog() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderCatalog();
    done();
  }

  function catalogAction(x, small) {
    const a = P.catalogAction(x);
    if (a === 'install') return btn(t('plugins.cat.install'), { primary: true, small, cls: 'pgx-raise', action: 'install', onClick: (e) => installFromCatalog(x, e.currentTarget).then(afterCatalogInstall) });
    if (a === 'update') return btn(t('plugins.cat.update'), { small, cls: 'pgx-raise pgx-btn-info', action: 'update', onClick: (e) => installFromCatalog(x, e.currentTarget).then(afterCatalogInstall) });
    if (x.state === 'installed') {
      const p = installedOf(x.id);
      return el('a', { class: 'pgx-installed pgx-raise', href: '/plugins/manage/' + enc(x.id), 'data-tone': p && P.isProblem(p) ? 'crit' : 'good' },
        [icon(p && P.isProblem(p) ? I.alert : I.check, 15), p && P.isProblem(p) ? t('plugins.x.installed_problem') : t('plugins.cat.state.installed')]);
    }
    if (x.state === 'incompatible' && x.requiresNewer) return pill(t('plugins.x.needs_gc', { range: x.requiresNewer.gatecontrol }), 'warn');
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

  function renderCatalog() {
    clear(main);
    if (!cat.available) {
      main.appendChild(card('pgx-offline', [
        el('div', { class: 'pgx-row-note' }, [icon(I.alert, 20), el('span', { class: 'pgx-grow', text: cat.error || t('plugins.cat.unreachable') })]),
        el('div', { class: 'pgx-actions' }, [btn(t('plugins.x.retry'), { primary: true, onClick: async (e) => { e.currentTarget.disabled = true; await loadCatalog(true); renderCatalog(); updateNav(); } }),
          btn(t('plugins.x.upload'), { href: '/plugins/security', icon: I.upload })]),
      ]));
      return;
    }
    const counts = {};
    cat.plugins.forEach((x) => { const c = P.categoryOf(x); counts[c] = (counts[c] || 0) + 1; });
    const layout = el('div', { class: 'pgx-cat' });
    const filters = el('aside', { class: 'pgx-filters', 'aria-label': t('plugins.x.filters') });
    const mainCol = el('div', { class: 'pgx-cat-main' });
    layout.appendChild(filters);
    layout.appendChild(mainCol);
    main.appendChild(layout);

    const results = el('div', { id: 'pgx-results' });
    const refresh = () => { syncUrl(); renderFilters(); renderResults(); };

    function renderFilters() {
      clear(filters);
      filters.appendChild(lbl(t('plugins.x.areas')));
      const nav = el('div', { class: 'pgx-fl', role: 'group', 'aria-label': t('plugins.x.areas') });
      [['all', cat.plugins.length]].concat(P.CATEGORIES.filter((c) => counts[c]).map((c) => [c, counts[c]])).forEach(([c, n]) => nav.appendChild(el('button', {
        type: 'button', class: 'pgx-fl-item', 'aria-pressed': String(cf.cat === c), 'data-cat': c, on: { click: () => { cf.cat = c; refresh(); } },
      }, [c === 'all' ? icon(P.ICON_PATHS.puzzle, 16) : el('span', { class: 'pgx-cat-dot', 'data-cat': c, 'aria-hidden': 'true' }), el('span', { class: 'pgx-grow', text: c === 'all' ? t('plugins.x.all') : catName(c) }), el('em', { text: String(n) })])));
      filters.appendChild(nav);
      filters.appendChild(lbl(t('plugins.x.show')));
      [['installed', 'show_installed'], ['notInstalled', 'show_not_installed'], ['updatesOnly', 'show_updates'], ['compatibleOnly', 'show_compatible']].forEach(([k, key]) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!cf[k];
        cb.addEventListener('change', () => { cf[k] = cb.checked; renderResults(); });
        filters.appendChild(el('label', { class: 'pgx-check-line pgx-fl-check' }, [cb, t('plugins.x.' + key, { version: cat.serverVersion || inst.serverVersion })]));
      });
      filters.appendChild(lbl(t('plugins.x.source')));
      filters.appendChild(el('p', { class: 'pgx-muted pgx-small' }, [
        cat.source && !cat.source.official ? t('plugins.x.source_custom', { host: cat.source.host }) : t('plugins.x.source_official'), el('br'),
        cat.fetchedAt ? t('plugins.x.checked_ago', { ago: ago(cat.fetchedAt) }) + ' · ' : '',
        el('button', { type: 'button', class: 'pgx-link', id: 'pgx-cat-refresh', text: t('plugins.x.check_now'), on: { click: async (e) => {
          e.currentTarget.disabled = true;
          await loadCatalog(true);
          toast(t('plugins.cat.refreshed'));
          renderCatalog();
          updateNav();
        } } }),
      ]));
    }

    const search = el('input', { type: 'search', class: 'pgx-search-in', id: 'pgx-cq', placeholder: t('plugins.x.search_catalog'), 'aria-label': t('plugins.x.search_catalog'), value: cf.q });
    search.addEventListener('input', () => { cf.q = search.value; syncUrl(); renderResults(); });
    const sort = el('select', { class: 'st-select pgx-sort', 'aria-label': t('plugins.x.sort') }, ['recommended', 'recent', 'name'].map((k) => {
      const o = el('option', { value: k, text: t('plugins.x.sort_' + k) });
      if (cf.sort === k) o.selected = true;
      return o;
    }));
    sort.addEventListener('change', () => { cf.sort = sort.value; renderResults(); });
    mainCol.appendChild(el('div', { class: 'pgx-toolbar' }, [el('label', { class: 'pgx-search pgx-search-lg' }, [icon(I.search, 19), search]), sort]));
    mainCol.appendChild(results);

    function renderResults() {
      clear(results);
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
      if (!filtered) {
        const hl = cat.plugins.filter((x) => x.highlight && x.highlight.title).sort((a, b) => (Date.parse((b.latest && b.latest.publishedAt) || '') || 0) - (Date.parse((a.latest && a.latest.publishedAt) || '') || 0))[0];
        if (hl) results.appendChild(heroCard(hl));
        const fresh = cat.plugins.filter((x) => x.state === 'not_installed');
        if (fresh.length) {
          results.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-fresh-h' }, [
            el('div', { class: 'pgx-sec-head' }, [el('h2', { class: 'pgx-h2', id: 'pgx-fresh-h', text: t('plugins.x.not_yours') }), el('span', { class: 'pgx-muted', text: t('plugins.x.fits') })]),
            el('div', { class: 'pgx-feat-grid' }, fresh.slice(0, 4).map((x) => featureCard(x))),
          ]));
        }
      }
      results.appendChild(el('section', { class: 'pgx-sec', 'aria-labelledby': 'pgx-all-h' }, [
        el('div', { class: 'pgx-sec-head' }, [el('h2', { class: 'pgx-h2', id: 'pgx-all-h', text: cf.cat === 'all' ? t('plugins.x.all_plugins') : catName(cf.cat) }), el('span', { class: 'pgx-ver', text: String(list.length) })]),
        list.length ? el('div', { class: 'pgx-grid', id: 'pgx-cat-grid' }, list.map((x) => catalogCard(x)))
          : el('div', { class: 'pgx-empty' }, [t('plugins.x.none_found'), ' ', el('button', { type: 'button', class: 'pgx-link', text: t('plugins.x.reset_filters'), on: { click: () => {
            Object.assign(cf, { q: '', cat: 'all', installed: true, notInstalled: true, updatesOnly: false, compatibleOnly: true });
            search.value = '';
            refresh();
          } } })]),
      ]));
      results.appendChild(card('pgx-upload-teaser', [el('div', { class: 'pgx-row-note' }, [
        el('span', { class: 'pgx-ic', 'data-cat': 'other', 'aria-hidden': 'true' }, [icon(I.upload, 22)]),
        el('span', { class: 'pgx-grow' }, [el('b', { text: t('plugins.x.own_plugin') }), el('span', { class: 'pgx-muted pgx-block', text: t('plugins.x.own_plugin_d') })]),
        btn(t('plugins.x.upload'), { href: '/plugins/security' }),
      ])]));
    }
    refresh();
  }

  function heroCard(x) {
    const h = x.highlight;
    return el('section', { class: 'pgx-hero', 'aria-labelledby': 'pgx-hero-h', id: 'pgx-hero' }, [
      el('div', { class: 'pgx-hero-text' }, [
        pill(t('plugins.x.new_in', { name: x.name, version: h.version }), 'info'),
        el('h2', { class: 'pgx-display', id: 'pgx-hero-h', text: h.title }),
        h.text ? el('p', { class: 'pgx-muted pgx-big', text: h.text }) : null,
        el('div', { class: 'pgx-actions' }, [btn(t('plugins.x.view'), { href: '/plugins/catalog/' + enc(x.id), primary: true }), catalogAction(x)]),
      ]),
      el('div', { class: 'pgx-hero-art', 'aria-hidden': 'true' }, [plugIcon(x.id, installedOf(x.id), 'xl')]),
    ]);
  }

  function chipsOf(x) {
    return [catName(P.categoryOf(x)), x.audience === 'admins' ? t('plugins.x.admins_only') : null, x.latest && x.latest.licenseRequired ? t('plugins.x.license') : t('plugins.cat.license_free')].filter(Boolean)
      .map((c) => el('span', { class: 'pgx-chip', text: c }));
  }

  function featureCard(x) {
    return el('article', { class: 'pgx-card pgx-feat', 'data-cat-plugin': x.id }, [
      plugIcon(x.id, null, 'lg'),
      el('div', { class: 'pgx-grow' }, [
        el('a', { class: 'pgx-card-link', href: '/plugins/catalog/' + enc(x.id) }, [el('b', { text: x.name })]),
        el('p', { class: 'pgx-muted pgx-clamp3', text: x.summary || x.description }),
        el('div', { class: 'pgx-chips' }, chipsOf(x)),
      ]),
      catalogAction(x, true),
    ]);
  }

  function catalogCard(x) {
    const isNew = x.highlight && x.latest && x.highlight.version && x.latest.version.split('.').slice(0, 2).join('.') === x.highlight.version.split('.').slice(0, 2).join('.');
    return el('article', { class: 'pgx-card pgx-pc', 'data-cat-plugin': x.id, 'data-cat-state': x.state }, [
      el('div', { class: 'pgx-pc-top' }, [plugIcon(x.id, installedOf(x.id)), el('div', { class: 'pgx-grow' }, [
        el('a', { class: 'pgx-card-link', href: '/plugins/catalog/' + enc(x.id) }, [el('b', { text: x.name })]),
        el('span', { class: 'pgx-muted pgx-block pgx-small', text: catName(P.categoryOf(x)) }),
      ]), isNew ? pill(t('plugins.x.new_v', { version: x.highlight.version.split('.').slice(0, 2).join('.') }), 'info') : null]),
      el('p', { class: 'pgx-muted pgx-clamp3', text: x.summary || x.description }),
      el('div', { class: 'pgx-pc-foot' }, [
        el('span', { class: 'pgx-ver', text: x.state === 'update' ? x.installedVersion + ' → ' + x.latest.version : ((x.latest ? x.latest.version : '') + (x.latest ? ' · ' + P.fmtBytes(x.latest.size) : '')) }),
        catalogAction(x, true),
      ]),
    ]);
  }

  // ── One catalogue plugin ──
  async function viewCatalogItem() {
    const [, , r] = await Promise.all([loadInstalled(), loadCatalog(false), req('GET', CAT_API + '/' + enc(TARGET))]);
    clear(main);
    if (!r.ok || !r.plugin) {
      main.appendChild(card('pgx-offline', [el('p', { text: r.error || t('plugins.err.catalog_unknown') }), btn(t('plugins.x.back_catalog'), { href: '/plugins/catalog', icon: I.back })]));
      done();
      return;
    }
    const x = r.plugin;
    if (!catItem(x.id)) cat.plugins.push(x);
    const p = installedOf(x.id);
    const category = P.categoryOf(x);
    main.appendChild(el('nav', { class: 'pgx-crumb', 'aria-label': t('plugins.x.path') }, [el('a', { href: '/plugins/catalog', text: t('plugins.area.catalog') }), ' › ',
      el('a', { href: '/plugins/catalog?cat=' + enc(category), text: catName(category) }), ' › ', el('span', { 'aria-current': 'page', text: x.name })]));
    const tabs = ['overview', 'versions'];
    let tab = query.get('tab') === 'versions' ? 'versions' : 'overview';
    const left = el('div', { class: 'pgx-colm' });
    const aside = el('aside', { class: 'pgx-aside', 'aria-label': t('plugins.x.install_panel') });
    main.appendChild(el('div', { class: 'pgx-cols' }, [left, aside]));

    left.appendChild(el('div', { class: 'pgx-dhero' }, [plugIcon(x.id, p, 'xl'), el('div', { class: 'pgx-grow' }, [
      el('h2', { class: 'pgx-display', text: x.name }),
      el('p', { class: 'pgx-muted pgx-big', text: x.summary || '' }),
      el('div', { class: 'pgx-chips' }, chipsOf(x).concat([el('span', { class: 'pgx-chip', text: x.publisher })])),
    ])]));
    const tl = el('div', { class: 'pg-tabs pgx-tabs', role: 'tablist', 'aria-label': t('plugins.detail.tabs') });
    const panel = el('div', { class: 'pgx-panel', role: 'tabpanel', id: 'pgx-panel' });
    left.appendChild(tl);
    left.appendChild(panel);
    const renderTab = () => {
      clear(tl);
      tabs.forEach((id) => tl.appendChild(el('button', { type: 'button', class: 'pg-tab', role: 'tab', 'aria-selected': String(tab === id), id: 'pgx-tab-' + id,
        text: id === 'versions' ? t('plugins.x.tab_versions') + ' ' + (x.versions || []).length : t('plugins.tab.overview'), on: { click: () => { tab = id; renderTab(); } } })));
      panel.setAttribute('aria-labelledby', 'pgx-tab-' + tab);
      clear(panel);
      if (tab === 'versions') { panel.appendChild(versionsList(x.versions || [], p ? p.version : null)); return; }
      if (x.highlight && x.highlight.title) {
        panel.appendChild(el('div', { class: 'pgx-hl' }, [pill(t('plugins.x.new_v', { version: x.highlight.version }), 'info'), el('b', { text: x.highlight.title }), x.highlight.text ? el('p', { class: 'pgx-muted', text: x.highlight.text }) : null]));
      }
      if (x.description) panel.appendChild(el('p', { class: 'pgx-desc', text: x.description }));
      if (p) {
        const adds = P.addsOf(p, t);
        if (adds.length) {
          panel.appendChild(el('h3', { class: 'pgx-h3', text: t('plugins.x.adds_to', { name: x.name }) }));
          panel.appendChild(el('ul', { class: 'pgx-adds' }, adds.map((a) => el('li', null, [el('b', { text: a.title }), el('span', { class: 'pgx-muted pgx-block', text: a.text })]))));
        }
      } else {
        panel.appendChild(el('p', { class: 'pgx-note', role: 'note' }, [icon(I.shield, 16), ' ', t('plugins.x.perms_before')]));
      }
      if (x.latest && x.latest.notes) {
        panel.appendChild(el('h3', { class: 'pgx-h3', text: t('plugins.x.new_in_version', { version: x.latest.version }) }));
        panel.appendChild(notesBlock(x.latest.notes, 14));
        panel.appendChild(el('button', { type: 'button', class: 'pgx-link', text: t('plugins.x.all_versions'), on: { click: () => { tab = 'versions'; renderTab(); } } }));
      }
    };
    renderTab();

    // install panel
    const act = catalogAction(x);
    const lines = [];
    if (x.latest) {
      lines.push(el('div', { class: 'pgx-line', 'data-tone': x.latest.compatible === false ? 'warn' : 'good' }, [icon(x.latest.compatible === false ? I.alert : I.check, 17),
        el('span', null, [t(x.latest.compatible === false ? 'plugins.x.not_fitting' : 'plugins.x.fitting'), el('span', { class: 'pgx-muted', text: ' ' + t('plugins.x.gc_needs', { installed: r.serverVersion, range: x.latest.gatecontrol }) })])]));
    } else if (x.requiresNewer) {
      lines.push(el('div', { class: 'pgx-line', 'data-tone': 'warn' }, [icon(I.alert, 17), t('plugins.cat.requires', { range: x.requiresNewer.gatecontrol, installed: r.serverVersion })]));
    }
    lines.push(el('div', { class: 'pgx-line', 'data-tone': 'good' }, [icon(I.shield, 17), el('span', null, [t('plugins.x.signed_by', { publisher: x.publisher }), el('span', { class: 'pgx-muted', text: ' · ' + t('plugins.x.sha_checked') })])]));
    if (x.latest && x.latest.licenseRequired && !(p && p.license && p.license.licensed)) {
      lines.push(el('div', { class: 'pgx-note pgx-note-warn' }, [icon(I.key, 17), el('span', null, [t('plugins.x.license_needed'), ' ', el('a', { href: SHOP_URL, target: '_blank', rel: 'noopener noreferrer', text: t('plugins.x.shop') })])]));
    }
    aside.appendChild(card('pgx-install', [act ? el('div', { class: 'pgx-install-act' }, [act]) : null].concat(lines)));
    aside.appendChild(card('', [lbl(t('plugins.x.details')), kv([
      [t('plugins.tile.version'), x.latest ? x.latest.version : (x.versions && x.versions[0] ? x.versions[0].version : ''), true],
      p ? [t('plugins.x.installed_v'), p.version, true] : null,
      [t('plugins.x.size'), x.latest ? P.fmtBytes(x.latest.size) : ''],
      [t('plugins.x.publisher'), x.publisher],
      [t('plugins.x.for'), x.audience === 'admins' ? t('plugins.x.admins') : t('plugins.x.everyone')],
      [t('plugins.x.published'), x.latest ? P.fmtDate(x.latest.publishedAt, lang) : ''],
      [t('plugins.x.needs'), x.latest ? 'GateControl ' + x.latest.gatecontrol : ''],
    ])]));
    const rel = (x.related || []).map((id) => catItem(id)).filter(Boolean);
    if (rel.length) {
      aside.appendChild(card('', [lbl(t('plugins.x.related'))].concat(rel.map((y) => el('a', { class: 'pgx-rel', href: '/plugins/catalog/' + enc(y.id) }, [
        plugIcon(y.id, installedOf(y.id), 'sm'), el('span', { class: 'pgx-grow' }, [el('b', { text: y.name }), el('span', { class: 'pgx-muted pgx-block pgx-small', text: y.state === 'installed' || y.state === 'update' ? t('plugins.cat.state.installed') : catName(P.categoryOf(y)) })]),
        icon(I.next, 16)])))));
    }
    if (p) aside.appendChild(btn(t('plugins.x.manage'), { href: '/plugins/manage/' + enc(p.id), icon: I.gear }));
    done();
  }

  function versionsList(versions, installedVersion) {
    const box = el('ol', { class: 'pgx-versions' });
    if (!versions.length) box.appendChild(el('li', { class: 'pgx-muted', text: t('plugins.x.no_versions') }));
    versions.forEach((v) => box.appendChild(el('li', { 'data-version': v.version }, [
      el('div', { class: 'pgx-v-head' }, [el('b', { class: 'st-mono', text: v.version }), v.version === installedVersion ? pill(t('plugins.x.installed_here'), 'good') : null,
        v.compatible === false ? pill(t('plugins.x.needs_gc', { range: v.gatecontrol }), 'warn') : null, el('span', { class: 'pgx-muted pgx-small', text: P.fmtDate(v.publishedAt, lang) })]),
      v.notes ? notesBlock(v.notes) : el('p', { class: 'pgx-muted', text: t('plugins.x.no_notes') }),
    ])));
    return box;
  }

  // ════════════════════════════════════════════════════════════
  // One installed plugin (/plugins/manage/<id>)
  // ════════════════════════════════════════════════════════════
  const TABS = ['overview', 'settings', 'perms', 'license', 'log', 'versions'];
  let mtab = TABS.indexOf(query.get('tab')) >= 0 ? query.get('tab') : 'overview';

  async function viewManage() {
    await Promise.all([loadInstalled(), loadCatalog(false)]);
    renderManage();
    done();
  }

  function renderManage() {
    clear(main);
    const p = installedOf(TARGET);
    if (!p) { main.appendChild(card('pgx-offline', [el('p', { text: t('plugins.err.not_found') }), btn(t('plugins.x.back_mine'), { href: '/plugins', icon: I.back })])); return; }
    const c = catItem(p.id);
    main.appendChild(el('nav', { class: 'pgx-crumb', 'aria-label': t('plugins.x.path') }, [el('a', { href: '/plugins', text: t('plugins.area.title') }), ' › ', el('span', { 'aria-current': 'page', text: p.name })]));

    const proc = p.process || {};
    const since = p.status === 'running' && proc.startedAt ? t('plugins.x.running_since', { ago: ago(new Date(proc.startedAt).toISOString()) }) : t(P.statusChip(p).key);
    const menu = el('details', { class: 'pgx-menu' }, [
      el('summary', { class: 'st-btn pgx-icon-btn', 'aria-label': t('plugins.x.more_actions'), title: t('plugins.x.more_actions') }, [icon(I.more, 18)]),
      el('div', { class: 'pgx-menu-pop', role: 'menu' }, [
        el('button', { type: 'button', role: 'menuitem', text: t('plugins.x.check_license'), on: { click: () => { mtab = 'license'; renderManage(); } } }),
        el('button', { type: 'button', role: 'menuitem', 'data-tone': 'crit', id: 'pgx-uninstall-menu', text: t('plugins.detail.uninstall'), on: { click: () => uninstallDialog(p) } }),
      ]),
    ]);
    main.appendChild(card('pgx-mhero', [
      plugIcon(p.id, p, 'xl'),
      el('div', { class: 'pgx-grow' }, [
        el('div', { class: 'pgx-title-row' }, [el('h2', { class: 'pgx-display', id: 'pgx-dtitle', text: p.name }), pill(since, P.statusChip(p).tone, true)]),
        el('p', { class: 'pgx-muted', text: (c && c.summary) || p.description || '' }),
        el('div', { class: 'pgx-metaline' }, [el('span', { class: 'st-mono', text: 'v' + p.version }), el('span', { text: p.publisher }),
          el('span', { 'data-tone': p.verified ? 'good' : 'warn' }, [icon(I.shield, 14), ' ', t(p.verified ? 'plugins.badge.verified' : 'plugins.badge.unverified')]),
          el('span', { text: catName(P.categoryOf(metaOf(p.id))) })]),
      ]),
      el('div', { class: 'pgx-actions' }, [
        p.nav && p.status === 'running' ? btn(t('plugins.detail.open'), { href: '/plugins/' + enc(p.id), icon: I.ext }) : null,
        btn(t('plugins.x.restart'), { icon: I.refresh, id: 'pgx-restart', disabled: !p.enabled, onClick: async (e) => { e.currentTarget.disabled = true; await restart(p); await loadInstalled(); renderManage(); } }),
        el('span', { class: 'pgx-switch-box' }, [el('span', { text: t(p.enabled ? 'plugins.detail.active' : 'plugins.detail.inactive') }),
          switchBtn(p.enabled, t('plugins.detail.active'), async () => { if (await setEnabled(p, !p.enabled)) { await loadInstalled(); renderManage(); updateNav(); } }, 'pgx-toggle')]),
        menu,
      ]),
    ], { 'aria-labelledby': 'pgx-dtitle' }));

    if (c && c.state === 'update' && c.latest) {
      main.appendChild(el('div', { class: 'pgx-banner', 'data-tone': 'info', role: 'status' }, [icon(I.refresh, 18),
        el('span', { class: 'pgx-grow' }, [el('b', { text: t('plugins.x.update_available', { version: c.latest.version }) }), ' ', el('span', { class: 'pgx-muted', text: t('plugins.x.update_kind.' + P.updateKind(p.version, c.latest.version)) })]),
        el('button', { type: 'button', class: 'pgx-link', text: t('plugins.x.whats_new'), on: { click: () => { mtab = 'versions'; renderManage(); } } }),
        btn(t('plugins.cat.update'), { primary: true, small: true, id: 'pgx-update', onClick: (e) => installFromCatalog(c, e.currentTarget).then(async (r) => { if (r) { await Promise.all([loadInstalled(), loadCatalog(false)]); renderManage(); updateNav(); } }) })]));
    }
    const banner = problemBanner(p);
    if (banner) main.appendChild(banner);
    const legacySlot = el('div', { id: 'pg-legacy-slot' });
    main.appendChild(legacySlot);
    renderLegacy(p, legacySlot);

    const tl = el('div', { class: 'pg-tabs pgx-tabs', role: 'tablist', 'aria-label': t('plugins.detail.tabs') });
    TABS.forEach((id) => {
      if (id === 'versions' && !c) return;
      const n = id === 'perms' ? P.permRows(p.permissions, t).length : null;
      tl.appendChild(el('button', { type: 'button', class: 'pg-tab', role: 'tab', id: 'pg-tab-' + id, 'aria-selected': String(mtab === id), 'aria-controls': 'pg-panel',
        on: { click: () => { mtab = id; try { history.replaceState(null, '', location.pathname + (id === 'overview' ? '' : '?tab=' + id)); } catch (_) { /* ignore */ } renderManage(); } } },
      [id === 'versions' ? t('plugins.x.tab_versions') : t('plugins.tab.' + id), n ? el('em', { class: 'pgx-tab-n', text: String(n) }) : null]));
    });
    const left = el('div', { class: 'pgx-colm' }, [tl]);
    const panel = el('div', { class: 'pgx-panel', id: 'pg-panel', role: 'tabpanel', 'aria-labelledby': 'pg-tab-' + mtab });
    left.appendChild(panel);
    const aside = el('aside', { class: 'pgx-aside', 'aria-label': t('plugins.x.details') });
    main.appendChild(el('div', { class: 'pgx-cols' }, [left, aside]));
    ({ overview: panelOverview, settings: panelSettings, license: panelLicense, perms: panelPerms, log: panelLog, versions: panelVersions })[mtab](p, panel, c);
    manageAside(p, c, aside);
  }

  function problemBanner(p) {
    if (!P.isProblem(p)) return null;
    let action = null;
    if (p.reason === 'license') action = btn(t('plugins.banner.license_action'), { small: true, onClick: () => { mtab = 'license'; renderManage(); } });
    else if (p.reason === 'unsigned') action = btn(t('plugins.banner.unsigned_action'), { small: true, href: '/plugins/security' });
    else if (p.status === 'crashed') action = btn(t('plugins.x.restart'), { small: true, primary: true, onClick: async () => { await restart(p); await loadInstalled(); renderManage(); } });
    const title = p.status === 'crashed' ? t('plugins.state.crashed') : t(P.statusChip(p).key);
    return el('div', { class: 'pgx-banner', role: 'status', 'data-tone': p.reason === 'unsigned' ? 'warn' : 'crit' }, [icon(I.alert, 18),
      el('span', { class: 'pgx-grow' }, [el('b', { text: title + '. ' }), (p.status === 'crashed' ? t('plugins.note.crashed', { error: (p.process && p.process.lastError) || '' }) : t('plugins.reason.' + (p.reason || 'broken'))) + ' ' + t('plugins.banner.data_kept')]),
      action]);
  }

  function manageAside(p, c, aside) {
    const L = p.license || {};
    if (L.required) {
      aside.appendChild(card('pgx-lic-card', [
        el('div', { class: 'pgx-title-row' }, [lbl(t('plugins.tab.license')), pill(t('plugins.lic.state.' + L.state), P.licenseTone(L.state), true)]),
        el('b', { class: 'pgx-big-v', text: L.source === 'plan' || L.source === 'lifetime' ? t('plugins.lic.source_' + L.source) : (L.expiresAt ? t('plugins.x.until', { date: P.fmtDate(L.expiresAt, lang) }) : (L.state === 'valid' ? t('plugins.lic.unlimited') : t('plugins.lic.state.' + L.state))) }),
        L.keyMasked ? el('span', { class: 'pgx-muted pgx-small' }, [t('plugins.lic.key') + ' ', el('span', { class: 'st-mono', text: L.keyMasked })]) : null,
        el('button', { type: 'button', class: 'pgx-link', text: t('plugins.x.manage_license'), on: { click: () => { mtab = 'license'; renderManage(); } } }),
      ]));
    }
    aside.appendChild(card('', [lbl(t('plugins.x.details')), kv([
      [t('plugins.tile.version'), p.version + (c && c.state === 'update' && c.latest ? ' → ' + c.latest.version : (c ? ' · ' + t('plugins.x.current') : '')), true],
      [t('plugins.tile.installed'), P.fmtDate(p.installedAt, lang)],
      [t('plugins.x.updated'), P.fmtDate(p.updatedAt, lang)],
      [t('plugins.x.needs'), 'GateControl ' + (p.requires || '') + (p.compatible ? ' ✓' : '')],
      [t('plugins.x.publisher'), p.publisher],
      [t('plugins.x.origin'), c ? t('plugins.x.source_official') : t('plugins.x.origin_upload')],
    ])]));
    const sens = P.sensitivePerms(p.permissions);
    aside.appendChild(card('', [lbl(t('plugins.tab.perms')),
      el('p', { class: 'pgx-muted pgx-small', text: t('plugins.x.perms_count', { n: P.permRows(p.permissions, t).length, s: sens.length }) }),
      sens.length ? el('div', { class: 'pgx-chips' }, sens.map((k) => pill(t(k), 'warn'))) : null,
      el('button', { type: 'button', class: 'pgx-link', text: t('plugins.x.view_all'), on: { click: () => { mtab = 'perms'; renderManage(); } } })]));
    if (c) aside.appendChild(btn(t('plugins.x.in_catalog'), { href: '/plugins/catalog/' + enc(p.id), icon: P.ICON_PATHS.puzzle }));
    aside.appendChild(btn(t('plugins.detail.uninstall'), { danger: true, icon: I.trash, id: 'pg-uninstall', onClick: () => uninstallDialog(p) }));
  }

  async function panelOverview(p, panel, c) {
    const proc = p.process || {};
    const tiles = el('div', { class: 'pgx-mtiles' });
    const tile = (label, value, sub, tone, id) => el('div', { class: 'pgx-mtile' }, [lbl(label), el('b', { id: id || null, 'data-tone': tone || null, text: value }), sub ? el('span', { class: 'pgx-muted pgx-small', text: sub }) : null]);
    tiles.appendChild(tile(t('plugins.tile.status'), t(P.statusChip(p).key), p.status === 'running' && proc.startedAt ? t('plugins.x.since', { date: fmtDateTime(proc.startedAt) }) : '', P.statusChip(p).tone));
    tiles.appendChild(tile(t('plugins.x.data'), '…', t('plugins.x.data_d'), null, 'pg-storage'));
    tiles.appendChild(tile(t('plugins.x.errors7d'), String(p.errors7d || 0), proc.crashes ? t('plugins.x.crashes', { n: proc.crashes }) : t('plugins.x.no_crashes'), p.errors7d ? 'warn' : null));
    tiles.appendChild(tile(t('plugins.tile.version'), p.version, c && c.state === 'update' && c.latest ? t('plugins.x.update_to', { version: c.latest.version }) : (c ? t('plugins.x.current') : '')));
    panel.appendChild(tiles);
    if (p.description) panel.appendChild(el('p', { class: 'pgx-desc', text: p.description }));
    const adds = P.addsOf(p, t);
    if (adds.length) {
      panel.appendChild(el('h3', { class: 'pgx-h3', text: t('plugins.x.adds_to', { name: p.name }) }));
      panel.appendChild(el('ul', { class: 'pgx-adds' }, adds.map((a) => el('li', null, [el('b', { text: a.title }), el('span', { class: 'pgx-muted pgx-block', text: a.text })]))));
    }
    const peers = [];
    (p.uses || []).forEach((id) => peers.push({ id, rel: 'uses' }));
    (p.usedBy || []).forEach((id) => { if (!peers.some((x) => x.id === id)) peers.push({ id, rel: 'used_by' }); });
    ((c && c.related) || []).forEach((id) => { if (!peers.some((x) => x.id === id)) peers.push({ id, rel: 'related' }); });
    if (peers.length) {
      panel.appendChild(el('h3', { class: 'pgx-h3', text: t('plugins.x.works_with') }));
      panel.appendChild(el('p', { class: 'pgx-muted pgx-small', text: t('plugins.x.works_with_d') }));
      panel.appendChild(el('div', { class: 'pgx-deps' }, peers.map((d) => {
        const o = installedOf(d.id);
        const ci = catItem(d.id);
        const name = (o && o.name) || (ci && ci.name) || d.id;
        return el('a', { class: 'pgx-dep', href: o ? '/plugins/manage/' + enc(d.id) : '/plugins/catalog/' + enc(d.id), 'data-installed': o ? '1' : '0' }, [
          plugIcon(d.id, o, 'sm'),
          el('span', { class: 'pgx-grow' }, [el('b', { text: name }), el('span', { class: 'pgx-muted pgx-block pgx-small', text: t('plugins.x.rel_' + d.rel) })]),
          o ? icon(I.check, 16) : el('span', { class: 'pgx-muted pgx-small', text: t('plugins.x.not_installed') }),
        ]);
      })));
    }
    const logs = await req('GET', API + '/' + enc(p.id) + '/logs');
    if (logs.ok && logs.logs.length) {
      panel.appendChild(el('div', { class: 'pgx-sec-head' }, [el('h3', { class: 'pgx-h3', text: t('plugins.x.recent') }),
        el('button', { type: 'button', class: 'pgx-link', text: t('plugins.x.whole_log'), on: { click: () => { mtab = 'log'; renderManage(); } } })]));
      panel.appendChild(logList(logs.logs.slice(0, 5)));
    }
    const r = await req('GET', API + '/' + enc(p.id));
    const s = $('pg-storage');
    if (s && r.ok) s.textContent = P.fmtBytes(r.plugin.storageBytes);
    if (p.media) await renderMedia(p, panel);
  }

  function logList(entries) {
    const list = el('ol', { class: 'pg-log', id: 'pg-log' });
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
    panel.appendChild(logList(r.ok ? r.logs : []));
  }

  function panelPerms(p, panel) {
    panel.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.perm.intro') }));
    panel.appendChild(permRowsBox(p.permissions, null));
  }

  async function panelVersions(p, panel, c) {
    const r = await req('GET', CAT_API + '/' + enc(p.id));
    if (!r.ok) { panel.appendChild(el('p', { class: 'pgx-muted', text: r.error })); return; }
    panel.appendChild(versionsList(r.plugin.versions || [], p.version));
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
    const box = el('section', { class: 'pgx-subcard', id: 'pg-media', 'aria-labelledby': 'pg-media-title' });
    box.appendChild(el('h3', { class: 'pgx-h3', id: 'pg-media-title', text: t('plugins.media.title') }));
    box.appendChild(el('p', { class: 'pgx-muted', id: 'pg-media-usage', text: t('plugins.media.usage', { used: P.fmtBytes(m.usage.bytes), quota: P.fmtBytes(m.quota), count: m.usage.count }) }));
    box.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.media.limits', { max: P.fmtBytes(m.maxBytes), types: P.mediaTypes(m.types) }) }));
    const gb = el('input', { type: 'number', class: 'st-input st-input-num', id: 'pg-media-quota', min: 0.001, max: 1024, step: 'any',
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

  // ── Zugriffsziele (home-network targets the plugin declared) ──
  async function renderTargets(p, panel) {
    const r = await req('GET', API + '/' + enc(p.id) + '/targets');
    if (!r.ok || (!r.declared.length && !r.discovery)) return;
    const box = el('section', { class: 'pgx-subcard', id: 'pg-targets', 'aria-labelledby': 'pg-tg-title' });
    box.appendChild(el('h3', { class: 'pgx-h3', id: 'pg-tg-title', text: t('plugins.tg.title') }));
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
      const sw = switchBtn(r.discovery.granted, t('plugins.tg.discovery'), async () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        const res = await req('PUT', API + '/' + enc(p.id) + '/discovery', { granted: on });
        if (!res.ok) { toast(res.error, 'error'); return; }
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
      }, 'pg-discovery');
      box.appendChild(el('div', { class: 'st-row pg-target' }, [
        el('div', { class: 'st-row-text' }, [el('label', { class: 'st-label', for: 'pg-discovery', text: t('plugins.tg.discovery') }),
          el('span', { class: 'st-hint', text: t('plugins.tg.discovery_hint', { ports: r.discovery.udp.join(', ') }) })]),
        el('div', { class: 'st-row-ctl' }, [sw]),
      ]));
    }
    panel.appendChild(box);
  }

  async function panelSettings(p, panel) {
    await renderTargets(p, panel);
    panel.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.settings.hint') }));
    const r = await req('GET', API + '/' + enc(p.id) + '/settings');
    if (!r.ok) { panel.appendChild(el('p', { class: 'st-err-block', text: r.error })); return; }
    if (!r.defs.length) { if (!panel.querySelector('#pg-targets')) panel.appendChild(el('p', { class: 'pgx-muted', text: t('plugins.settings.none') })); return; }
    const form = el('form', { class: 'pg-form', id: 'pg-settings-form', novalidate: true, autocomplete: 'off' });
    const inputs = {};
    for (const d of r.defs) {
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
      const res = await req('PUT', API + '/' + enc(p.id) + '/settings', { values });
      form.querySelectorAll('.st-err').forEach((n) => { n.textContent = ''; n.hidden = true; });
      if (res.ok) { msg.textContent = ''; toast(t('plugins.settings.saved')); return; }
      if (res.fields) {
        for (const k of Object.keys(res.fields)) {
          const n = inputs[k] && $(inputs[k].ctl.id + '-err');
          if (n) { n.textContent = t('plugins.settings.invalid'); n.hidden = false; }
        }
      }
      msg.textContent = res.error || t('plugins.err.generic');
    });
    panel.appendChild(form);
  }

  function panelLicense(p, panel) {
    const L = p.license || {};
    if (!L.required) { panel.appendChild(el('p', { class: 'pgx-muted', id: 'pg-lic-none', text: t('plugins.lic.not_required') })); return; }
    const dl = el('dl', { class: 'pg-dl' });
    const row = (k, v, tone) => { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { 'data-state': tone || null, text: v || '—' })); };
    row(t('plugins.lic.status'), t('plugins.lic.state.' + L.state), P.licenseTone(L.state));
    if (L.source === 'plan' || L.source === 'lifetime') row(t('plugins.lic.kind'), t('plugins.lic.source_' + L.source), 'good');
    row(t('plugins.lic.key'), L.keyMasked || (L.source === 'plan' ? t('plugins.lic.no_key_needed') : ''));
    row(t('plugins.lic.valid_until'), L.expiresAt ? P.fmtDate(L.expiresAt, lang) : (L.state === 'valid' ? t('plugins.lic.unlimited') : ''));
    if (L.updatesUntil) row(t('plugins.lic.updates_until'), P.fmtDate(L.updatesUntil, lang));
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
    panel.appendChild(el('div', { class: 'pg-lic' }, [dl, el('div', { class: 'pg-lic-form' }, [
      refreshBox,
      el('label', { class: 'st-label', for: 'pg-lic-key', text: t('plugins.lic.enter') }), input,
      el('div', { class: 'st-btnrow pgx-mt' }, [save, check]),
      el('p', { class: 'pgx-muted', text: L.kind === 'first_party' ? t(L.source === 'plan' ? 'plugins.lic.hint_plan' : 'plugins.lic.hint_gc') : t('plugins.lic.hint_third', { server: L.server || '' }) }),
      L.coveredBy ? el('p', { class: 'pgx-muted', id: 'pg-lic-covered', role: 'note', text: t('plugins.lic.covered_' + L.coveredBy) }) : null,
      msg,
    ])]));
  }

  function uninstallDialog(p) {
    const d = D.dialog({ title: t('plugins.un.title', { name: p.name }) });
    let mode = 'keep';
    d.body.appendChild(el('p', { class: 'zn-dialog-msg', text: t('plugins.x.un_intro') }));
    const lost = P.addsOf(p, t).map((a) => a.title);
    if (lost.length) {
      d.body.appendChild(lbl(t('plugins.x.un_lost')));
      d.body.appendChild(el('ul', { class: 'pgx-lost' }, lost.map((x) => el('li', null, [icon(I.x, 15), x]))));
    }
    const users = (p.usedBy || []).map((id) => installedOf(id)).filter(Boolean);
    if (users.length) d.body.appendChild(el('p', { class: 'pgx-note pgx-note-warn', id: 'pgx-un-used', role: 'note' }, [icon(I.alert, 16), ' ', t('plugins.x.un_used_by', { names: users.map((u) => u.name).join(', ') })]));
    const opts = el('div', { class: 'pg-radios', role: 'radiogroup', 'aria-label': t('plugins.un.data') });
    const confirmWrap = el('label', { class: 'pg-confirm', hidden: true }, [el('span', { class: 'st-label', text: t('plugins.un.type', { name: p.name }) })]);
    const confirmIn = el('input', { type: 'text', class: 'st-input', id: 'pg-un-confirm', autocomplete: 'off', spellcheck: 'false' });
    confirmWrap.appendChild(confirmIn);
    const go = el('button', { type: 'button', class: 'btn btn-danger', id: 'pg-un-go' });
    const sync = () => {
      opts.querySelectorAll('.pg-radio').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === mode ? 'true' : 'false'));
      confirmWrap.hidden = mode !== 'wipe';
      go.textContent = t(mode === 'wipe' ? 'plugins.un.go_wipe' : 'plugins.un.go');
      go.disabled = mode === 'wipe' && !P.wipeConfirmed(p, confirmIn.value);
    };
    for (const m of ['keep', 'wipe']) {
      opts.appendChild(el('button', { type: 'button', class: 'pg-radio', role: 'radio', 'data-mode': m, on: { click: () => { mode = m; sync(); } } }, [
        el('span', { class: 'pg-radio-dot', 'aria-hidden': 'true' }),
        el('span', null, [el('b', { text: t('plugins.un.' + m) }), el('span', { class: 'pgx-muted pgx-block', text: t('plugins.un.' + m + '_d') })]),
      ]));
    }
    confirmIn.addEventListener('input', sync);
    d.body.appendChild(lbl(t('plugins.un.data')));
    d.body.appendChild(opts);
    d.body.appendChild(confirmWrap);
    if (p.license && p.license.required) d.body.appendChild(el('p', { class: 'pgx-muted pgx-row-note' }, [icon(I.key, 16), ' ', t('plugins.un.license_note')]));
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(err);
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    if (p.enabled) d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('plugins.detail.disable'), on: { click: async () => { d.close(null); if (await setEnabled(p, false)) { await loadInstalled(); renderManage(); } } } }));
    go.addEventListener('click', async () => {
      const r = await req('POST', API + '/' + enc(p.id) + '/uninstall', { mode, confirm: confirmIn.value });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      d.close(true);
      toast(t('plugins.toast.uninstalled', { name: p.name }));
      location.href = '/plugins';
    });
    d.foot.appendChild(go);
    sync();
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

  function renderUpdates(r) {
    clear(main);
    const ups = (r && r.updates) || [];
    main.appendChild(el('div', { class: 'pgx-lead' }, [
      el('p', { class: 'pgx-muted' }, [
        ups.length ? t('plugins.x.n_updates', { n: ups.length }) : t('plugins.x.all_current'),
        cat.fetchedAt ? ' · ' + t('plugins.x.checked_ago', { ago: ago(cat.fetchedAt) }) + ' · ' : ' · ',
        el('button', { type: 'button', class: 'pgx-link', id: 'pgx-up-refresh', text: t('plugins.x.check_now'), on: { click: async (e) => {
          e.currentTarget.disabled = true;
          const [nr] = await Promise.all([req('GET', CAT_API + '/updates?refresh=1'), loadCatalog(false)]);
          await loadCatalog(false);
          renderUpdates(nr);
          updateNav();
          toast(t('plugins.cat.refreshed'));
        } } }),
      ]),
      ups.length ? btn(t('plugins.x.update_all_n', { n: ups.length }), { primary: true, icon: I.refresh, id: 'pgx-update-all', onClick: () => updateAll(ups.map((u) => catItem(u.id)).filter(Boolean), reloadUpdates) }) : null,
    ]));
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
    main.appendChild(card('pgx-auto-card', [el('div', { class: 'pgx-row-note' }, [
      el('div', { class: 'pgx-grow' }, [el('h2', { class: 'pgx-h2', id: 'pgx-auto-h', text: t('plugins.x.auto_title') }), el('p', { class: 'pgx-muted', text: t('plugins.x.auto_d') })]), au,
    ])], { 'aria-labelledby': 'pgx-auto-h' }));

    if (!ups.length) {
      main.appendChild(card('pgx-uptodate', [el('div', { class: 'pgx-row-note' }, [el('span', { class: 'pgx-done-ic', 'aria-hidden': 'true' }, [icon(I.check, 22)]),
        el('span', null, [el('b', { text: t('plugins.x.all_current') }), el('span', { class: 'pgx-muted pgx-block', text: t('plugins.x.all_current_d') })])])]));
    }
    ups.forEach((u) => {
      const item = catItem(u.id);
      main.appendChild(card('pgx-upcard', [
        el('div', { class: 'pgx-up-head' }, [
          plugIcon(u.id, installedOf(u.id), 'lg'),
          el('div', { class: 'pgx-grow' }, [el('b', { class: 'pgx-up-name', text: u.name }), el('span', { class: 'pgx-vv' }, [el('s', { text: u.from }), ' → ', el('span', { text: u.to })])]),
          pill(t('plugins.x.update_kind.' + u.kind), u.kind === 'patch' ? 'good' : 'info'),
          item ? btn(t('plugins.cat.update'), { primary: true, small: true, action: 'update', onClick: (e) => installFromCatalog(item, e.currentTarget).then(async (res) => { if (res) await reloadUpdates(); }) }) : null,
        ]),
        el('div', { class: 'pgx-up-body' }, [
          u.needsApproval ? el('p', { class: 'pgx-note pgx-note-warn', role: 'note' }, [icon(I.shield, 16), ' ', t('plugins.x.needs_approval')]) : null,
        ].concat(u.notes.length ? u.notes.map((n) => el('div', { class: 'pgx-up-notes' }, [u.notes.length > 1 ? el('b', { class: 'st-mono pgx-small', text: n.version }) : null, notesBlock(n.notes, 12)]))
          : [el('p', { class: 'pgx-muted', text: t('plugins.x.no_notes') })]).concat([
          el('p', { class: 'pgx-ok-line' }, [icon(I.check, 15), t('plugins.x.up_fits', { installed: inst.serverVersion, range: u.gatecontrol, size: P.fmtBytes(u.size) })]),
        ])),
      ], { 'data-update': u.id }));
    });

    const hist = (r && r.history) || [];
    if (hist.length) {
      main.appendChild(card('pgx-hist', [cardHead(t('plugins.x.history'), null, 'pgx-hist-h'), el('ol', { class: 'pgx-hist-list' }, hist.map((h) => el('li', null, [
        el('span', { class: 'pgx-muted st-mono pgx-small', text: P.fmtDate(h.at, lang) }),
        el('span', { class: 'pgx-grow' }, [el('b', { text: h.name || h.id }), ' ', el('span', { class: 'pgx-muted st-mono', text: h.action === 'uninstall' ? t('plugins.x.h_uninstalled') : (h.from ? h.from + ' → ' + h.to : h.to) })]),
        pill(h.by === 'auto' ? t('plugins.x.h_auto') : (h.user ? t('plugins.x.h_by', { name: h.user }) : t('plugins.x.h_admin')), 'off'),
        h.action !== 'uninstall' && catItem(h.id) ? el('a', { class: 'pgx-link', href: '/plugins/catalog/' + enc(h.id) + '?tab=versions', text: t('plugins.x.notes') }) : null,
      ])))], { 'aria-labelledby': 'pgx-hist-h' }));
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

  function renderLicenses(resultMsg) {
    clear(main);
    const req2 = inst.plugins.filter((p) => p.license && p.license.required);
    const ok = req2.filter((p) => p.license.licensed && p.license.state !== 'expiring').length;
    main.appendChild(el('div', { class: 'pgx-lead' }, [
      el('p', { class: 'pgx-muted', text: t('plugins.x.lic_lead', { n: req2.length, ok, warn: req2.length - ok }) }),
      btn(t('plugins.x.shop'), { href: SHOP_URL, external: true, icon: I.ext }),
    ]));
    const keyIn = el('input', { type: 'text', class: 'st-input st-mono pgx-key', id: 'pgx-lic-key', placeholder: t('plugins.lic.placeholder'), maxLength: 200, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('plugins.lic.key') });
    const msg = el('p', { class: 'pgx-muted', id: 'pgx-lic-msg', role: 'status' });
    if (resultMsg) { msg.textContent = resultMsg.text; msg.setAttribute('data-tone', resultMsg.tone); }
    const go = btn(t('plugins.x.key_assign'), { primary: true, id: 'pgx-lic-go', onClick: async (e) => {
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
      if (r.valid && !r.installed && catItem(r.pluginId)) {
        $('pgx-lic-msg').appendChild(el('a', { class: 'pgx-link', href: '/plugins/catalog/' + enc(r.pluginId), text: ' ' + t('plugins.x.to_catalog_item') }));
      }
    } });
    main.appendChild(card('pgx-key-card', [cardHead(t('plugins.x.key_title'), null, 'pgx-key-h'),
      el('div', { class: 'pgx-inline' }, [keyIn, go]),
      el('p', { class: 'pgx-muted pgx-small', text: t('plugins.x.key_d') }), msg], { 'aria-labelledby': 'pgx-key-h' }));

    const rows = req2.slice().sort((a, b) => Number(a.license.licensed && a.license.state !== 'expiring') - Number(b.license.licensed && b.license.state !== 'expiring') || a.name.localeCompare(b.name));
    const tbl = el('table', { class: 'pgx-table', id: 'pgx-lic-table' }, [
      el('thead', null, [el('tr', null, [t('plugins.x.col_plugin'), t('plugins.lic.kind'), t('plugins.lic.status'), t('plugins.lic.valid_until'), t('plugins.lic.key')].map((h) => el('th', { scope: 'col', text: h }))
        .concat([el('th', null, [el('span', { class: 'st-sr', text: t('plugins.x.col_action') })])]))]),
      el('tbody', null, rows.length ? rows.map((p) => {
        const L = p.license;
        const kind = L.source === 'plan' || L.source === 'lifetime' ? t('plugins.lic.source_' + L.source) : (L.kind === 'first_party' ? t('plugins.x.lic_key_kind') : t('plugins.x.lic_third'));
        const warn = !L.licensed || L.state === 'expiring';
        return el('tr', { 'data-plugin': p.id, 'data-tone': warn ? (L.licensed ? 'warn' : 'crit') : null }, [
          el('td', null, [el('a', { class: 'pgx-tlink', href: '/plugins/manage/' + enc(p.id) + '?tab=license' }, [plugIcon(p.id, p, 'sm'), el('b', { text: p.name })])]),
          el('td', { text: kind }),
          el('td', null, [pill(t('plugins.lic.state.' + L.state), P.licenseTone(L.state), true)]),
          el('td', { text: L.expiresAt ? P.fmtDate(L.expiresAt, lang) : (L.licensed ? t('plugins.lic.unlimited') : '—') }),
          el('td', { class: 'st-mono pgx-muted', text: L.keyMasked || '—' }),
          el('td', { class: 'pgx-right' }, [L.state === 'expiring' || L.state === 'expired' ? btn(t('plugins.x.renew'), { href: SHOP_URL, external: true, small: true, primary: true })
            : btn(t('plugins.x.manage_short'), { href: '/plugins/manage/' + enc(p.id) + '?tab=license', small: true })]),
        ]);
      }) : [el('tr', null, [el('td', { colspan: '6', class: 'pgx-muted', text: t('plugins.x.no_licensed') })])]),
    ]);
    main.appendChild(card('pgx-table-card', [el('div', { class: 'pgx-table-wrap' }, [tbl])]));
    main.appendChild(card('pgx-legend', [cardHead(t('plugins.x.legend'), null, 'pgx-legend-h')].concat(['expiring', 'grace', 'offline', 'elsewhere'].map((k) => el('div', { class: 'pgx-legend-row' }, [
      pill(t('plugins.x.lg.' + k), k === 'offline' ? 'info' : (k === 'elsewhere' ? 'crit' : 'warn')),
      el('span', null, [el('b', { text: t('plugins.x.lg.' + k + '_t') }), el('span', { class: 'pgx-muted pgx-block', text: t('plugins.x.lg.' + k + '_d') })]),
    ]))), { 'aria-labelledby': 'pgx-legend-h' }));
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
    const fileIn = $('pgx-file');
    const drop = el('label', { class: 'pg-drop pgx-drop', id: 'pg-drop', for: 'pgx-file' }, [
      el('span', { class: 'pg-drop-ic', 'aria-hidden': 'true' }, [icon(I.upload, 22)]),
      el('span', { class: 'pg-drop-text' }, [el('b', { text: t('plugins.drop.title') }), el('span', { class: 'pgx-muted pgx-block', text: t('plugins.drop.hint') })]),
    ]);
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; stage(f); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
    drop.setAttribute('tabindex', '0');
    const preview = el('div', { id: 'pgx-staged' });
    main.appendChild(card('pgx-upload', [cardHead(t('plugins.x.upload_title'), [el('span', { class: 'pgx-muted pgx-small', text: t('plugins.x.upload_d') })], 'pgx-up-h'), drop, preview], { 'aria-labelledby': 'pgx-up-h' }));
    renderStaged(preview);

    const rowOf = (id, label, hint, on, onClick, isNew) => el('div', { class: 'st-row' }, [
      el('div', { class: 'st-row-text' }, [el('label', { class: 'st-label', for: id }, [label, isNew ? ' ' : null, isNew ? pill(t('plugins.x.new'), 'info') : null]), el('span', { class: 'st-hint', id: id + '-hint', text: hint })]),
      el('div', { class: 'st-row-ctl' }, [el('button', { type: 'button', class: 'st-switch', role: 'switch', id, 'aria-checked': on ? 'true' : 'false', 'aria-describedby': id + '-hint', on: { click: onClick } }, [el('span', { class: 'st-knob', 'aria-hidden': 'true' })])]),
    ]);
    main.appendChild(card('pgx-rules', [cardHead(t('plugins.x.rules'), null, 'pgx-rules-h'),
      rowOf('pg-unsigned', t('plugins.sec.unsigned'), t('plugins.sec.unsigned_hint'), inst.allowUnsigned, toggleUnsigned),
      el('p', { class: 'pgx-note' + (inst.allowUnsigned ? ' pgx-note-warn' : ''), id: inst.allowUnsigned ? 'pg-unsigned-on' : 'pg-unsigned-off' },
        inst.allowUnsigned ? [el('b', { text: t('plugins.sec.on_title') + ' ' }), t('plugins.sec.on_text')] : [t('plugins.sec.off_note')]),
      rowOf('pg-backup-media', t('plugins.sec.backup_media'), t('plugins.sec.backup_media_hint'), inst.backupMedia, async () => {
        const r = await req('PUT', API + '/policy', { backupMedia: !inst.backupMedia });
        if (!r.ok) { toast(r.error, 'error'); return; }
        inst.backupMedia = !!r.backupMedia;
        renderSecurity();
      }),
      CATALOG_ON ? rowOf('pgx-catalog-check', t('plugins.x.check_title'), t('plugins.x.check_d'), inst.catalogCheck, async () => {
        const r = await req('PUT', API + '/policy', { catalogCheck: !inst.catalogCheck });
        if (!r.ok) { toast(r.error, 'error'); return; }
        inst.catalogCheck = r.catalogCheck !== false;
        renderSecurity();
      }, true) : null,
    ], { 'aria-labelledby': 'pgx-rules-h', id: 'pg-security' }));

    if (CATALOG_ON) {
      main.appendChild(card('pgx-source', [cardHead(t('plugins.x.source_title'), [pill(cat.available ? t('plugins.x.reachable') : t('plugins.x.unreachable'), cat.available ? 'good' : 'warn', true)], 'pgx-src-h'),
        kv([
          [t('plugins.x.source'), cat.source && !cat.source.official ? t('plugins.x.source_custom', { host: cat.source.host }) : t('plugins.x.source_official')],
          [t('plugins.x.address'), cat.source ? cat.source.host : '', true],
          [t('plugins.x.verification'), t('plugins.x.verification_v')],
          [t('plugins.x.last_check'), cat.fetchedAt ? fmtDateTime(cat.fetchedAt) + ' · ' + t('plugins.x.n_plugins', { n: cat.plugins.length }) : '—'],
        ]),
        btn(t('plugins.x.check_now'), { small: true, icon: I.refresh, onClick: async (e) => { e.currentTarget.disabled = true; await loadCatalog(true); renderSecurity(); updateNav(); } }),
      ], { 'aria-labelledby': 'pgx-src-h' }));
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
    const tone = info.canInstall ? (pl && pl.verified ? 'good' : 'warn') : 'crit';
    box.appendChild(el('div', { class: 'pgx-staged', 'data-tone': tone }, [
      el('div', { class: 'pgx-row-note' }, [
        el('span', { class: 'pgx-ic', 'data-cat': 'other', 'aria-hidden': 'true' }, [icon(I.file, 22)]),
        el('span', { class: 'pgx-grow' }, [el('b', { class: 'st-mono', text: staged.file.name }),
          el('span', { class: 'pgx-muted pgx-block st-mono pgx-small', text: [P.fmtBytes(staged.file.size), pl ? pl.name + ' ' + pl.version : '', pl ? t('plugins.x.gc_needs_short', { range: (info.checks.find((c) => c.key === 'compatibility') || { params: {} }).params.required || '' }) : ''].filter(Boolean).join(' · ') })]),
        pill(pl && pl.verified ? t('plugins.badge.verified') : t('plugins.badge.unverified'), pl && pl.verified ? 'good' : 'warn'),
      ]),
      el('p', { class: 'pgx-small', text: unsignedBlocked ? t('plugins.x.unsigned_blocked') : (info.canInstall ? (pl && pl.verified ? t('plugins.x.staged_ok') : t('plugins.x.staged_unsigned')) : t('plugins.in.blocked')) }),
      el('div', { class: 'pgx-actions' }, [
        btn(t('plugins.x.discard'), { small: true, onClick: () => { staged = null; renderStaged(box); } }),
        unsignedBlocked && !inst.allowUnsigned ? btn(t('plugins.x.allow_unsigned'), { small: true, onClick: toggleUnsigned }) : null,
        btn(t('plugins.x.check_install'), { small: true, primary: true, disabled: !info.canInstall, id: 'pgx-staged-go', onClick: async () => {
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

  // ── Wiring ──
  const fileIn = $('pgx-file');
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    if (VIEW === 'security') { await stage(f); return; }
    const r = await uploadFile(f);
    if (r) { const p = await installDialog(r.info, r.file, null); if (p) location.href = '/plugins/manage/' + enc(p.id); }
  });

  const VIEWS = { installed: viewInstalled, catalog: viewCatalog, catalogItem: viewCatalogItem, manage: viewManage, updates: viewUpdates, licenses: viewLicenses, security: viewSecurity };
  (VIEWS[VIEW] || viewInstalled)().catch(() => { showError(t('plugins.err.generic')); main.setAttribute('aria-busy', 'false'); });
}());
