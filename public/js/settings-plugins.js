'use strict';

// Settings → Plugins (templates/aurora/partials/settings-plugins.njk,
// docs/plugins.md). Loaded before settings.js: registers the section's
// load() in window.GCSettingsExt, settings.js calls it when the section opens.
//
//   cards of the installed plugins → detail (Übersicht, Einstellungen,
//   Lizenz, Berechtigungen, Protokoll) · upload + 4-step install dialog ·
//   deactivate / uninstall (keep or wipe, typed confirmation) · the switch
//   "Unsignierte Plugins erlauben" (typed confirmation ERLAUBEN).
//
// DOM is built with GCDialog.el / textContent only — no HTML strings.
(function () {
  const root = document.getElementById('pg-root');
  if (!root) return;
  const P = window.GCPluginsUI;
  const D = window.GCDialog;
  const el = D.el;
  const lang = (window.GC && window.GC.language) === 'en' ? 'en' : 'de';
  const API = '/api/v1/plugins';

  let STR = {};
  try { STR = JSON.parse(document.getElementById('st-i18n').textContent || '{}'); } catch (_) { STR = {}; }
  function t(key, params) {
    let s = (window.GC && window.GC.t && window.GC.t[key] != null) ? window.GC.t[key] : (STR[key] != null ? STR[key] : key);
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  const $ = (id) => document.getElementById(id);
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  const NS = 'http://www.w3.org/2000/svg';
  function icon(d, size) {
    const svg = document.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', String(size || 20)], ['height', String(size || 20)], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '1.9'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/.test(d || '') ? d : 'M4 4h16v16H4z');
    svg.appendChild(p);
    return svg;
  }
  const DEFAULT_ICON = 'M14 4h-4v3H7v4h3v3h4v-3h3V7h-3zM5 20h14';

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
  let state = { plugins: [], allowUnsigned: false };
  let selected = null;
  let tab = 'overview';
  try { selected = new URLSearchParams(location.search).get('plugin'); } catch (_) { selected = null; }

  function chip(text, tone) { return el('span', { class: 'pg-badge', 'data-state': tone, text }); }
  function verifiedChip(p) { return p.verified ? chip(t('plugins.badge.verified'), 'good') : chip(t('plugins.badge.unverified'), 'warn'); }
  /** "Im Plan enthalten" / "Lifetime" for plugins licensed without an own key. */
  function sourceChip(p) {
    const s = p.license && p.license.licensed && p.license.source;
    return s === 'plan' || s === 'lifetime' ? chip(t('plugins.lic.source_' + s), 'good') : null;
  }

  // ── Cards ──
  function renderCards() {
    const grid = $('pg-grid');
    clear(grid);
    $('pg-empty').hidden = state.plugins.length > 0;
    // upgrade notice of a former built-in integration: gone once its plugin is installed
    document.querySelectorAll('[data-builtin-moved]').forEach((n) => {
      n.hidden = state.plugins.some((p) => p.id === n.getAttribute('data-builtin-moved'));
    });
    for (const p of state.plugins) {
      const st = P.statusChip(p);
      const on = selected === p.id;
      const card = el('button', { type: 'button', class: 'pg-card', 'aria-pressed': on ? 'true' : 'false', 'data-plugin': p.id, 'data-status': p.status,
        on: { click: () => { selected = p.id; tab = 'overview'; renderCards(); renderDetail(); } } }, [
        el('span', { class: 'pg-card-head' }, [
          el('span', { class: 'pg-ic' }, [icon(p.nav ? p.nav.icon : DEFAULT_ICON)]),
          el('span', { class: 'pg-card-name' }, [el('b', { text: p.name }), el('span', { class: 'pg-sub', text: p.publisher + ' · v' + p.version })]),
        ]),
        el('span', { class: 'pg-chips' }, [chip(t(st.key), st.tone), verifiedChip(p), sourceChip(p)]),
        el('span', { class: 'pg-card-note', text: noteOf(p) }),
      ]);
      grid.appendChild(card);
    }
  }

  function noteOf(p) {
    if (p.status === 'running') return t('plugins.note.running');
    if (p.status === 'disabled') return t('plugins.note.disabled');
    if (p.status === 'crashed') return t('plugins.note.crashed', { error: (p.process && p.process.lastError) || '' });
    if (p.status === 'starting') return t('plugins.note.starting');
    return t('plugins.reason.' + (p.reason || 'broken'));
  }

  // ── Detail ──
  const TABS = ['overview', 'settings', 'license', 'perms', 'log'];

  function renderDetail() {
    const box = $('pg-detail');
    const p = state.plugins.find((x) => x.id === selected);
    clear(box);
    box.hidden = !p;
    if (!p) return;
    const sw = el('button', { type: 'button', class: 'st-switch', role: 'switch', id: 'pg-toggle', 'aria-checked': p.enabled ? 'true' : 'false', 'aria-label': t('plugins.detail.active'),
      on: { click: () => setEnabled(p, !p.enabled) } }, [el('span', { class: 'st-knob', 'aria-hidden': 'true' })]);
    box.appendChild(el('div', { class: 'pg-dhead' }, [
      el('span', { class: 'pg-ic pg-ic-lg' }, [icon(p.nav ? p.nav.icon : DEFAULT_ICON, 24)]),
      el('div', { class: 'pg-dhead-text' }, [
        el('h3', { class: 'pg-dtitle', id: 'pg-dtitle', text: p.name }),
        el('div', { class: 'pg-sub' }, [p.publisher + ' · v' + p.version + ' · ', verifiedChip(p)]),
      ]),
      el('label', { class: 'pg-toggle' }, [el('span', { text: p.enabled ? t('plugins.detail.active') : t('plugins.detail.inactive') }), sw]),
    ]));
    const banner = bannerOf(p);
    if (banner) box.appendChild(banner);
    const legacyBox = el('div', { id: 'pg-legacy-slot' });
    box.appendChild(legacyBox);
    renderLegacy(p, legacyBox);
    const tl = el('div', { class: 'pg-tabs', role: 'tablist', 'aria-label': t('plugins.detail.tabs') });
    for (const id of TABS) {
      tl.appendChild(el('button', { type: 'button', class: 'pg-tab', role: 'tab', id: 'pg-tab-' + id, 'aria-selected': tab === id ? 'true' : 'false', 'aria-controls': 'pg-panel',
        text: t('plugins.tab.' + id), on: { click: () => { tab = id; renderDetail(); } } }));
    }
    box.appendChild(tl);
    const panel = el('div', { class: 'pg-panel', id: 'pg-panel', role: 'tabpanel', 'aria-labelledby': 'pg-tab-' + tab });
    box.appendChild(panel);
    ({ overview: panelOverview, settings: panelSettings, license: panelLicense, perms: panelPerms, log: panelLog })[tab](p, panel);
    box.appendChild(el('div', { class: 'pg-dfoot' }, [
      p.nav && p.status === 'running' ? el('a', { class: 'st-btn', href: '/plugins/' + encodeURIComponent(p.id), text: t('plugins.detail.open') }) : null,
      p.enabled ? el('button', { type: 'button', class: 'st-btn', id: 'pg-disable', text: t('plugins.detail.disable'), on: { click: () => setEnabled(p, false) } })
        : el('button', { type: 'button', class: 'st-btn', id: 'pg-enable', text: t('plugins.detail.enable'), on: { click: () => setEnabled(p, true) } }),
      el('button', { type: 'button', class: 'st-btn st-btn-danger', id: 'pg-uninstall', text: t('plugins.detail.uninstall'), on: { click: () => uninstallDialog(p) } }),
    ]));
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
    const r = await req('GET', API + '/' + encodeURIComponent(p.id) + '/legacy');
    if (!r.ok || !r.legacy || selected !== p.id) return;
    const L = r.legacy;
    if (!L.available && !L.imported) return;
    const box = el('section', { class: 'pg-banner pg-legacy', id: 'pg-legacy', role: 'region', 'aria-labelledby': 'pg-legacy-title', 'data-state': L.imported ? 'good' : 'warn' });
    box.appendChild(el('b', { id: 'pg-legacy-title', text: t('plugins.legacy.title') + '. ' }));
    if (L.imported) box.appendChild(el('span', { text: t('plugins.legacy.done', { date: P.fmtDate(L.imported.at, lang), summary: legacySummary(L.imported.counts) }) + ' ' }));
    else box.appendChild(el('span', { text: t('plugins.legacy.offer', { dataset: datasetName(L.dataset), summary: legacySummary(L.counts) }) + ' ' }));
    let blocked = null;
    if (!L.eligible) blocked = t('plugins.legacy.unsigned');
    else if (!L.available) blocked = null;
    else if (!L.running) blocked = t('plugins.legacy.not_running');
    if (blocked) box.appendChild(el('span', { class: 'pg-sub', text: blocked }));
    if (L.eligible && L.available && L.running) {
      if (L.imported) box.appendChild(el('span', { class: 'pg-sub', text: t('plugins.legacy.rerun_hint') + ' ' }));
      box.appendChild(el('button', { type: 'button', class: 'st-btn st-btn-sm' + (L.imported ? '' : ' st-btn-primary'), id: 'pg-legacy-go',
        text: t(L.imported ? 'plugins.legacy.rerun' : 'plugins.legacy.go'), on: { click: () => runLegacyImport(p) } }));
    }
    clear(slot);
    slot.appendChild(box);
  }

  async function runLegacyImport(p) {
    if (!(await D.confirm({ title: t('plugins.legacy.confirm_title'), message: t('plugins.legacy.confirm_text'), okLabel: t('plugins.legacy.go') }))) return;
    const btn = $('pg-legacy-go');
    if (btn) btn.disabled = true;
    const r = await req('POST', API + '/' + encodeURIComponent(p.id) + '/legacy/import', { confirm: true });
    if (btn) btn.disabled = false;
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast(t('plugins.legacy.ok', { summary: legacySummary(r.counts) }));
    renderDetail();
  }

  function bannerOf(p) {
    if (p.status === 'running' || p.status === 'disabled' || p.status === 'starting') return null;
    let action = null;
    if (p.reason === 'license') action = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('plugins.banner.license_action'), on: { click: () => { tab = 'license'; renderDetail(); } } });
    else if (p.reason === 'unsigned') action = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('plugins.banner.unsigned_action'), on: { click: () => { const c = $('pg-security'); if (c) c.scrollIntoView({ behavior: 'smooth' }); } } });
    const title = p.status === 'crashed' ? t('plugins.state.crashed') : t(P.statusChip(p).key);
    return el('div', { class: 'pg-banner', role: 'status', 'data-state': p.status === 'crashed' ? 'crit' : (p.reason === 'unsigned' ? 'warn' : 'crit') }, [
      el('b', { text: title + '.' }), ' ',
      el('span', { text: (p.status === 'crashed' ? t('plugins.note.crashed', { error: (p.process && p.process.lastError) || '' }) : t('plugins.reason.' + (p.reason || 'broken'))) + ' ' + t('plugins.banner.data_kept') }),
      action,
    ]);
  }

  async function panelOverview(p, panel) {
    const tiles = el('div', { class: 'pg-tiles' });
    const tile = (label, value, id) => el('div', { class: 'pg-tile' }, [el('div', { class: 'pg-tile-l', text: label }), el('div', { class: 'pg-tile-v', id: id || null, text: value })]);
    tiles.appendChild(tile(t('plugins.tile.status'), t(P.statusChip(p).key)));
    tiles.appendChild(tile(t('plugins.tile.version'), 'v' + p.version));
    tiles.appendChild(tile(t('plugins.tile.installed'), P.fmtDate(p.installedAt, lang)));
    tiles.appendChild(tile(t('plugins.tile.storage'), '…', 'pg-storage'));
    panel.appendChild(tiles);
    if (p.description) panel.appendChild(el('p', { class: 'pg-desc', text: p.description }));
    const adds = P.addsOf(p, t);
    if (adds.length) {
      panel.appendChild(el('div', { class: 'pg-h', text: t('plugins.adds.title') }));
      panel.appendChild(el('ul', { class: 'pg-adds' }, adds.map((a) => el('li', null, [el('span', { class: 'pg-dot', 'aria-hidden': 'true' }), el('span', null, [el('b', { text: a.title }), el('span', { class: 'pg-sub', text: a.text })])]))));
    }
    const r = await req('GET', API + '/' + encodeURIComponent(p.id));
    const s = $('pg-storage');
    if (s && r.ok) s.textContent = P.fmtBytes(r.plugin.storageBytes);
  }

  // ── Zugriffsziele (home-network targets the plugin declared) ──
  async function renderTargets(p, panel) {
    const r = await req('GET', API + '/' + encodeURIComponent(p.id) + '/targets');
    if (!r.ok || (!r.declared.length && !r.discovery)) return;
    const box = el('section', { class: 'pg-targets', id: 'pg-targets', 'aria-labelledby': 'pg-tg-title' });
    box.appendChild(el('div', { class: 'pg-h', id: 'pg-tg-title', text: t('plugins.tg.title') }));
    box.appendChild(el('p', { class: 'pg-sub pg-pad', text: t('plugins.tg.intro') }));
    for (const d of r.declared) {
      const isHttp = d.protocols.indexOf('http') >= 0;
      const row = el('div', { class: 'pg-target', 'data-target': d.id });
      row.appendChild(el('div', { class: 'pg-target-head' }, [el('b', { text: d.label }), el('span', { class: 'pg-sub', text: d.protocols.map(P.protoText).join(' · ') })]));
      const list = el('ul', { class: 'pg-target-list' });
      const save = async (assigned) => {
        const res = await req('PUT', API + '/' + encodeURIComponent(p.id) + '/targets/' + encodeURIComponent(d.id), { assigned });
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast(t('plugins.tg.saved'));
        clear(panel);
        await panelSettings(p, panel);
      };
      const strip = (a) => { const o = Object.assign({}, a); delete o.display; return o; };
      if (!d.assigned.length) list.appendChild(el('li', { class: 'pg-sub', text: t('plugins.tg.none') }));
      d.assigned.forEach((a, i) => list.appendChild(el('li', null, [
        el('span', { class: 'pg-badge', text: t('plugins.tg.kind_' + a.kind) }), el('span', { class: 'st-mono', text: a.display }),
        el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('plugins.tg.remove'),
          on: { click: () => save(d.assigned.filter((_, j) => j !== i).map(strip)) } }),
      ])));
      row.appendChild(list);
      const kind = el('select', { class: 'st-select', 'aria-label': t('plugins.tg.title') }, ['route', 'peer', 'host'].map((k) => el('option', { value: k, text: t('plugins.tg.kind_' + k) })));
      const routes = r.choices.routes.filter((x) => (isHttp ? x.type === 'http' : x.type === 'l4'));
      const routeSel = el('select', { class: 'st-select' }, routes.map((x) => el('option', { value: String(x.id), text: x.label + (x.internal ? ' · ' + t('plugins.tg.internal') : '') })));
      const peerSel = el('select', { class: 'st-select' }, r.choices.peers.map((x) => el('option', { value: String(x.id), text: x.label + ' (' + x.ip + ')' })));
      const hostIn = el('input', { type: 'text', class: 'st-input st-mono', placeholder: t('plugins.tg.host_ph'), maxLength: 253, spellcheck: 'false', autocomplete: 'off' });
      const portIn = el('input', { type: 'number', class: 'st-input st-input-num', placeholder: t('plugins.tg.port'), min: 1, max: 65535 });
      const schemeSel = el('select', { class: 'st-select' }, ['http', 'https'].map((k) => el('option', { value: k, text: k.toUpperCase() })));
      schemeSel.hidden = !isHttp;
      const sync = () => { routeSel.hidden = kind.value !== 'route'; peerSel.hidden = kind.value !== 'peer'; hostIn.hidden = kind.value !== 'host'; portIn.hidden = kind.value === 'route'; schemeSel.hidden = !isHttp || kind.value === 'route'; };
      kind.addEventListener('change', sync);
      sync();
      const add = el('button', { type: 'button', class: 'st-btn st-btn-primary st-btn-sm', text: t('plugins.tg.add'), on: { click: () => {
        let a;
        if (kind.value === 'route') a = { kind: 'route', routeId: Number(routeSel.value) };
        else if (kind.value === 'peer') a = { kind: 'peer', peerId: Number(peerSel.value), port: portIn.value || null, scheme: schemeSel.value };
        else a = { kind: 'host', host: hostIn.value.trim(), port: portIn.value || null, scheme: schemeSel.value };
        const keep = d.multiple ? d.assigned.map(strip) : [];
        save(keep.concat([a]));
      } } });
      row.appendChild(el('div', { class: 'pg-target-add' }, [kind, routeSel, peerSel, hostIn, portIn, schemeSel, add]));
      box.appendChild(row);
    }
    if (r.discovery) {
      const sw = el('button', { type: 'button', class: 'st-switch', role: 'switch', id: 'pg-discovery', 'aria-checked': r.discovery.granted ? 'true' : 'false',
        on: { click: async () => {
          const on = sw.getAttribute('aria-checked') !== 'true';
          const res = await req('PUT', API + '/' + encodeURIComponent(p.id) + '/discovery', { granted: on });
          if (!res.ok) { toast(res.error, 'error'); return; }
          sw.setAttribute('aria-checked', on ? 'true' : 'false');
        } } }, [el('span', { class: 'st-knob', 'aria-hidden': 'true' })]);
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
    panel.appendChild(el('p', { class: 'pg-sub pg-pad', text: t('plugins.settings.hint') }));
    const r = await req('GET', API + '/' + encodeURIComponent(p.id) + '/settings');
    if (!r.ok) { panel.appendChild(el('p', { class: 'st-err-block', text: r.error })); return; }
    if (!r.defs.length) { if (!panel.querySelector('#pg-targets')) panel.appendChild(el('p', { class: 'pg-sub', text: t('plugins.settings.none') })); return; }
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
      const res = await req('PUT', API + '/' + encodeURIComponent(p.id) + '/settings', { values });
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
    if (!L.required) { panel.appendChild(el('p', { class: 'pg-sub', id: 'pg-lic-none', text: t('plugins.lic.not_required') })); return; }
    const dl = el('dl', { class: 'pg-dl' });
    const row = (k, v, tone) => { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { 'data-state': tone || null, text: v || '—' })); };
    row(t('plugins.lic.status'), t('plugins.lic.state.' + L.state), P.licenseTone(L.state));
    if (L.source === 'plan' || L.source === 'lifetime') row(t('plugins.lic.kind'), t('plugins.lic.source_' + L.source), 'good');
    row(t('plugins.lic.key'), L.keyMasked || (L.source === 'plan' ? t('plugins.lic.no_key_needed') : ''));
    row(t('plugins.lic.valid_until'), L.expiresAt ? P.fmtDate(L.expiresAt, lang) : (L.state === 'valid' ? t('plugins.lic.unlimited') : ''));
    if (L.updatesUntil) row(t('plugins.lic.updates_until'), P.fmtDate(L.updatesUntil, lang));
    row(t('plugins.lic.source'), L.kind === 'first_party' ? t('plugins.lic.source_gc') : (L.server || ''));
    const input = el('input', { type: 'text', class: 'st-input st-mono', id: 'pg-lic-key', placeholder: t('plugins.lic.placeholder'), maxLength: 200, autocomplete: 'off', spellcheck: 'false' });
    const msg = el('p', { class: 'pg-sub', id: 'pg-lic-msg', role: 'status' });
    const save = el('button', { type: 'button', class: 'st-btn st-btn-primary st-btn-sm', id: 'pg-lic-save', text: t('plugins.lic.save'), on: { click: async () => {
      const r = await req('PUT', API + '/' + encodeURIComponent(p.id) + '/license', { key: input.value });
      if (!r.ok) { msg.textContent = r.error; return; }
      if (r.license.coveredBy) toast(t('plugins.lic.covered_' + r.license.coveredBy));
      else toast(t('plugins.lic.state.' + r.license.state));
      await load();
    } } });
    const check = el('button', { type: 'button', class: 'st-btn st-btn-sm', id: 'pg-lic-check', text: t('plugins.lic.check'), on: { click: async () => {
      const r = await req('POST', API + '/' + encodeURIComponent(p.id) + '/license/check', {});
      if (!r.ok) { msg.textContent = r.error; return; }
      toast(t('plugins.lic.state.' + r.license.state));
      await load();
    } } });
    panel.appendChild(el('div', { class: 'pg-lic' }, [dl, el('div', { class: 'pg-lic-form' }, [
      el('label', { class: 'st-label', for: 'pg-lic-key', text: t('plugins.lic.enter') }), input,
      el('div', { class: 'st-btnrow pg-mt' }, [save, check]),
      el('p', { class: 'pg-sub', text: L.kind === 'first_party' ? t(L.source === 'plan' ? 'plugins.lic.hint_plan' : 'plugins.lic.hint_gc') : t('plugins.lic.hint_third', { server: L.server || '' }) }),
      L.coveredBy ? el('p', { class: 'pg-sub', id: 'pg-lic-covered', role: 'note', text: t('plugins.lic.covered_' + L.coveredBy) }) : null,
      msg,
    ])]));
  }

  function permList(perm) {
    return el('div', { class: 'pg-perms' }, P.permRows(perm, t).map((r) => el('div', { class: 'pg-perm' }, [el('b', { text: r.label }), el('span', { text: r.value })])));
  }

  function panelPerms(p, panel) {
    panel.appendChild(el('p', { class: 'pg-sub pg-pad', text: t('plugins.perm.intro') }));
    panel.appendChild(permList(p.permissions));
  }

  async function panelLog(p, panel) {
    const r = await req('GET', API + '/' + encodeURIComponent(p.id) + '/logs');
    const list = el('ol', { class: 'pg-log', id: 'pg-log' });
    for (const e of (r.ok ? r.logs : [])) {
      let ts = '';
      try { ts = new Date(e.created_at).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { ts = ''; }
      list.appendChild(el('li', null, [el('span', { class: 'pg-log-t', text: ts }), el('span', { class: 'pg-log-l', 'data-level': e.level, text: e.level.toUpperCase() }), el('span', { class: 'pg-log-m', text: e.message })]));
    }
    if (!list.firstChild) list.appendChild(el('li', { class: 'pg-sub', text: t('plugins.log.empty') }));
    panel.appendChild(list);
  }

  // ── Actions ──
  async function setEnabled(p, on) {
    const r = await req('POST', API + '/' + encodeURIComponent(p.id) + (on ? '/enable' : '/disable'), {});
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast(t(on ? 'plugins.toast.enabled' : 'plugins.toast.disabled', { name: p.name }));
    await load();
  }

  function uninstallDialog(p) {
    const d = D.dialog({ title: t('plugins.un.title', { name: p.name }) });
    let mode = 'keep';
    d.body.appendChild(el('p', { class: 'zn-dialog-msg', text: t('plugins.un.only_disable') }));
    const opts = el('div', { class: 'pg-radios', role: 'radiogroup', 'aria-label': t('plugins.un.data') });
    const confirmWrap = el('label', { class: 'pg-confirm', hidden: true }, [el('span', { class: 'st-label', text: t('plugins.un.type', { name: p.name }) })]);
    const confirmIn = el('input', { type: 'text', class: 'st-input', id: 'pg-un-confirm', autocomplete: 'off', spellcheck: 'false' });
    confirmWrap.appendChild(confirmIn);
    const effects = el('ul', { class: 'pg-effects' });
    const go = el('button', { type: 'button', class: 'btn btn-danger', id: 'pg-un-go' });
    const sync = () => {
      opts.querySelectorAll('.pg-radio').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === mode ? 'true' : 'false'));
      confirmWrap.hidden = mode !== 'wipe';
      clear(effects);
      [['plugins.un.eff_ui', 'crit'], ['plugins.un.eff_bg', 'crit'], [mode === 'wipe' ? 'plugins.un.eff_wipe' : 'plugins.un.eff_keep', mode === 'wipe' ? 'crit' : 'good'], ['plugins.un.eff_code', 'crit']]
        .forEach(([k, tone]) => effects.appendChild(el('li', { 'data-state': tone }, [el('span', { class: 'pg-dot', 'aria-hidden': 'true' }), t(k)])));
      go.textContent = t(mode === 'wipe' ? 'plugins.un.go_wipe' : 'plugins.un.go');
      go.disabled = mode === 'wipe' && !P.wipeConfirmed(p, confirmIn.value);
    };
    for (const m of ['keep', 'wipe']) {
      opts.appendChild(el('button', { type: 'button', class: 'pg-radio', role: 'radio', 'data-mode': m, on: { click: () => { mode = m; sync(); } } }, [
        el('span', { class: 'pg-radio-dot', 'aria-hidden': 'true' }),
        el('span', null, [el('b', { text: t('plugins.un.' + m) }), el('span', { class: 'pg-sub', text: t('plugins.un.' + m + '_d') })]),
      ]));
    }
    confirmIn.addEventListener('input', sync);
    d.body.appendChild(opts);
    d.body.appendChild(el('div', { class: 'pg-h', text: t('plugins.un.removed') }));
    d.body.appendChild(effects);
    d.body.appendChild(confirmWrap);
    d.body.appendChild(el('p', { class: 'pg-sub', text: t('plugins.un.license_note') }));
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(err);
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('plugins.detail.disable'), on: { click: async () => { d.close(null); await setEnabled(p, false); } } }));
    go.addEventListener('click', async () => {
      const r = await req('POST', API + '/' + encodeURIComponent(p.id) + '/uninstall', { mode, confirm: confirmIn.value });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      d.close(true);
      toast(t('plugins.toast.uninstalled', { name: p.name }));
      selected = null;
      await load();
    });
    d.foot.appendChild(go);
    sync();
  }

  // ── Upload + install ──
  async function upload(file) {
    if (!file) return;
    if (file.size > P.MAX_PACKAGE_BYTES) { toast(t('plugins.err.package_too_large'), 'error'); return; }
    const buf = await file.arrayBuffer();
    const r = await req('POST', API + '/inspect', buf);
    if (!r.ok && !r.checks) { toast(r.error || t('plugins.err.generic'), 'error'); return; }
    installDialog(file, r);
  }

  function installDialog(file, info) {
    const d = D.dialog({ title: t('plugins.in.title'), wide: true });
    const plugin = info.plugin;
    let step = 1;
    let accepted = false;
    const steps = el('ol', { class: 'pg-steps', 'aria-label': t('plugins.in.steps') });
    const body = el('div', { class: 'pg-stepbody' });
    const err = el('p', { class: 'st-err-block', role: 'alert', hidden: true });
    d.body.appendChild(steps);
    d.body.appendChild(body);
    d.body.appendChild(err);
    const back = el('button', { type: 'button', class: 'btn btn-ghost', text: t('plugins.in.back'), on: { click: () => { step--; render(); } } });
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } });
    const next = el('button', { type: 'button', class: 'btn btn-primary', id: 'pg-in-next' });
    d.foot.appendChild(back);
    d.foot.appendChild(cancel);
    d.foot.appendChild(next);
    const keyIn = el('input', { type: 'text', class: 'st-input st-mono pg-key', id: 'pg-in-key', placeholder: t('plugins.lic.placeholder'), maxLength: 200, autocomplete: 'off', spellcheck: 'false' });
    let installed = null;

    function render() {
      clear(steps);
      ['check', 'perms', 'license', 'done'].forEach((k, i) => {
        const n = i + 1;
        steps.appendChild(el('li', { class: 'pg-step', 'aria-current': n === step ? 'step' : 'false', 'data-done': n < step ? '1' : '0' }, [el('span', { class: 'pg-step-n', text: n < step ? '✓' : String(n) }), t('plugins.in.step_' + k)]));
      });
      clear(body);
      err.hidden = true;
      back.hidden = step === 1 || step === 4;
      cancel.hidden = step === 4;
      next.hidden = false;
      next.disabled = false;
      if (step === 1) {
        body.appendChild(el('div', { class: 'pg-file' }, [el('b', { class: 'st-mono', text: file.name }), el('span', { class: 'pg-sub', text: P.fmtBytes(file.size) })]));
        if (plugin) body.appendChild(el('div', { class: 'pg-in-plugin' }, [el('b', { text: plugin.name + ' v' + plugin.version }), el('span', { class: 'pg-sub', text: plugin.publisher + (plugin.description ? ' · ' + plugin.description : '') })]));
        body.appendChild(el('div', { class: 'pg-h', text: t('plugins.in.checks') }));
        body.appendChild(el('ul', { class: 'pg-checks', id: 'pg-checks' }, (info.checks || []).map((c) => {
          const k = P.checkKeys(c);
          const params = Object.assign({}, c.params || {});
          return el('li', { 'data-state': c.status, 'data-check': c.key + '.' + c.code }, [el('span', { class: 'pg-check-ic', 'aria-hidden': 'true', text: P.checkSymbol(c.status) }),
            el('span', null, [el('b', { text: t(k.title, params) }), el('span', { class: 'pg-sub', text: t(k.detail, params) })])]);
        })));
        next.textContent = t('plugins.in.next');
        next.disabled = !info.canInstall;
        if (!info.canInstall) { err.textContent = t('plugins.in.blocked'); err.hidden = false; }
      } else if (step === 2) {
        body.appendChild(el('p', { class: 'pg-sub', text: t('plugins.in.perms_intro', { name: plugin.name }) }));
        body.appendChild(permList(plugin.permissions));
        const cb = el('input', { type: 'checkbox', id: 'pg-in-accept' });
        cb.checked = accepted;
        cb.addEventListener('change', () => { accepted = cb.checked; next.disabled = !accepted; });
        body.appendChild(el('label', { class: 'pg-accept' }, [cb, t('plugins.in.accept')]));
        next.textContent = t('plugins.in.next');
        next.disabled = !accepted;
      } else if (step === 3) {
        if (plugin.license.required) {
          body.appendChild(el('p', { class: 'pg-sub', text: plugin.license.kind === 'first_party' ? t('plugins.lic.hint_gc') : t('plugins.lic.hint_third', { server: plugin.license.server || '' }) }));
          body.appendChild(el('label', { class: 'st-label', for: 'pg-in-key', text: t('plugins.lic.key') }));
          body.appendChild(keyIn);
          body.appendChild(el('details', { class: 'pg-details' }, [el('summary', { text: t('plugins.in.no_license') }), el('p', { class: 'pg-sub', text: t('plugins.in.no_license_d') })]));
        } else {
          body.appendChild(el('p', { class: 'pg-sub', text: t('plugins.lic.not_required') }));
        }
        next.textContent = info.existing ? t('plugins.in.update') : t('plugins.in.install');
      } else {
        const p = installed;
        body.appendChild(el('div', { class: 'pg-done' }, [
          el('div', { class: 'pg-done-ic', 'aria-hidden': 'true', text: '✓' }),
          el('h3', { class: 'pg-done-title', text: t(info.existing ? 'plugins.in.done_update' : 'plugins.in.done', { name: plugin.name }) }),
          el('p', { class: 'pg-sub', text: p && p.status === 'running' ? t('plugins.in.done_running') : t('plugins.reason.' + ((p && p.reason) || 'starting')) }),
        ]));
        back.hidden = true;
        cancel.hidden = true;
        next.textContent = t('plugins.in.to_overview');
      }
    }

    next.addEventListener('click', async () => {
      if (step === 1 || step === 2) { step++; render(); return; }
      if (step === 4) { d.close(true); return; }
      next.disabled = true;
      const r = await req('POST', API + '/install', { token: info.token, accept: accepted, licenseKey: keyIn.value.trim() || null });
      next.disabled = false;
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      installed = r.plugin;
      selected = r.plugin.id;
      step = 4;
      render();
      await load();
      if (r.licenseError) toast(t('plugins.err.' + r.licenseError), 'error');
    });
    render();
  }

  // ── Unsigned plugins switch ──
  async function toggleUnsigned() {
    const on = !state.allowUnsigned;
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
    await load();
  }

  function renderPolicy() {
    const sw = $('pg-unsigned');
    sw.setAttribute('aria-checked', state.allowUnsigned ? 'true' : 'false');
    $('pg-unsigned-on').hidden = !state.allowUnsigned;
    $('pg-unsigned-off').hidden = state.allowUnsigned;
  }

  async function load() {
    const r = await req('GET', API);
    if (!r.ok) { $('pg-load-err').textContent = r.error; $('pg-load-err').hidden = false; return; }
    $('pg-load-err').hidden = true;
    state = { plugins: r.plugins || [], allowUnsigned: !!r.allowUnsigned };
    if (selected && !state.plugins.some((p) => p.id === selected)) selected = null;
    if (!selected && state.plugins.length) selected = state.plugins[0].id;
    renderPolicy();
    renderCards();
    renderDetail();
  }

  // ── Wiring ──
  const fileIn = $('pg-file');
  fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; upload(f); });
  const drop = $('pg-drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; upload(f); });
  $('pg-upload-btn').addEventListener('click', () => fileIn.click());
  $('pg-unsigned').addEventListener('click', toggleUnsigned);

  window.GCSettingsExt = window.GCSettingsExt || {};
  window.GCSettingsExt.plugins = { load };
}());
