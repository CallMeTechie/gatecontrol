'use strict';

// Einstellungen › KI-Anbieter (templates/aurora/partials/settings-ai.njk,
// docs/plugins.md "AI requests", API src/routes/api/ai.js). A section of the
// settings page with its own script: settings.js calls load() when it is
// shown and fills the general settings (default / fallback provider,
// pictures, budget, rate, prices) with the values it returns — those are
// fields of the save bar and saved by the `groups` below. Immediate actions
// stay immediate: a key is saved and tested with "Testen" (dialog
// "Verwalten"), a model, the provider switch and the plugin rows act on change.
//
// Keys are write-only: the page only ever gets their last four characters.
// DOM is built with GCDialog.el / textContent only — never innerHTML.
(function () {
  if (!document.getElementById('ai-providers')) return;
  const BASE = '/api/v1/ai';
  const IDS = ['openai', 'anthropic', 'gemini', 'openrouter'];
  const NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', openrouter: 'OpenRouter' };
  const INITIAL = { openai: 'O', anthropic: 'A', gemini: 'G', openrouter: 'R', local: 'L' };
  const LOCAL = 'local';
  const ICON_TRASH = 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3';
  const NS = 'http://www.w3.org/2000/svg';
  const lang = (window.GC && window.GC.language) || undefined;

  const $ = (id) => document.getElementById(id);
  function el(tag, props, children) { return window.GCDialog.el(tag, props, children); }
  function t(key, params) {
    const s = window.GC && window.GC.t && window.GC.t[key] != null ? window.GC.t[key] : key;
    return window.GCSettingsUI ? window.GCSettingsUI.fmt(s, params) : s;
  }
  function tp(key, n, params) { return t(key + (Number(n) === 1 ? '_one' : '_other'), Object.assign({ n }, params || {})); }
  function call(p) {
    return Promise.resolve(p).then((r) => r || { ok: false }, (e) => (e && e.data) || { ok: false, error: (e && e.message) || t('ai.err.internal') });
  }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function icon(d) {
    const svg = document.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', '15'], ['height', '15'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }
  function euro(cents) {
    try { return new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR' }).format((Number(cents) || 0) / 100); } catch (_) { return ((Number(cents) || 0) / 100).toFixed(2) + ' €'; }
  }
  function when(iso) {
    try { return new Date(iso).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }); } catch (_) { return iso || ''; }
  }
  function monthName() {
    try { return new Date().toLocaleDateString(lang, { month: 'long' }); } catch (_) { return ''; }
  }
  function busy(btn, on) { if (!btn) return; if (on) { if (window.btnLoading) window.btnLoading(btn); else btn.disabled = true; } else if (window.btnReset) window.btnReset(btn); else btn.disabled = false; }
  function caps(list) { return (list || []).map((c) => t('ai.cap.' + c)).join(', '); }
  function pill(tone, text) { return el('span', { class: 'pgx-pill', 'data-tone': tone || null, text }); }
  function kv(label, value, mono) { return el('div', { class: 'pgx-kv' }, [el('span', { text: label }), el('span', { class: mono ? 'pgx-mono' : null, text: value })]); }
  function switchBtn(id, on, label, onChange) {
    const b = el('button', { type: 'button', class: 'pgx-sw', role: 'switch', id, 'aria-checked': on ? 'true' : 'false', 'aria-label': label }, el('span', { 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next, b);
    });
    return b;
  }

  let state = null;       // GET /api/v1/ai
  let plugins = [];       // GET /api/v1/ai/plugins
  let usage = null;       // GET /api/v1/ai/usage
  const models = {};      // provider id → [{ id, name, capabilities }] from "Testen"
  let off = false;
  let managing = null;    // provider id of the open "Verwalten" dialog

  // ── Providers (rows) ──
  function statusOf(p) {
    if (p.keyState === 'invalid') return ['crit', t('ai.status.key_invalid')];
    if (p.configured) return ['good', t('ai.status.connected')];
    if (p.keySet && p.checkError) return ['crit', t('ai.status.error')];
    if (p.keySet && !p.modelText) return ['warn', t('ai.status.choose_model')];
    if (p.keySet && !p.enabled) return ['', t('ai.status.off')];
    return ['', t('ai.status.not_set')];
  }
  function localAll() {
    const l = state && (state.providers || []).find((p) => p.id === LOCAL);
    return !!(l && l.configured && l.enabled && state.localUse === 'all');
  }
  function roleOf(id) {
    const d = state && state.defaults ? state.defaults : {};
    if (localAll()) {
      // "Für alles": the local AI is the default, the cloud only answers when it cannot
      const first = d.provider || ((state.providers || []).find((p) => p.id !== LOCAL && p.configured && p.enabled) || {}).id;
      return id === first || d.fallback === id ? t('ai.role.fallback') : '';
    }
    if (d.provider === id) return t('ai.role.default');
    if (d.fallback === id) return t('ai.role.fallback');
    return '';
  }

  // the row of the local AI: "Lokale KI · <gateway>", ready / loading / not reachable, its role from the mode, 0 €
  function localStatusOf(p) {
    const g = p.gateway;
    if (!p.modelText || !g) return ['', t('ai.status.not_set')];
    if (!p.enabled) return ['', t('ai.status.off')];
    if (!g.supported) return ['warn', t('ai.local.st_old')];
    if (!g.enabled) return ['', t('ai.local.st_switched_off')];
    if (lstatus && lstatus.pull && lstatus.pull.state === 'pulling') return ['blue', t('ai.local.st_pulling')];
    if (!g.online) return ['crit', t('ai.local.st_offline')];
    if (g.state === 'running') return ['good', t('ai.local.st_ready')];
    if (g.state === 'starting') return ['warn', t('ai.local.st_starting')];
    if (g.state === 'service_missing') return ['warn', t('ai.local.st_service_missing')];
    if (g.state === 'unreachable') return ['crit', t('ai.local.st_unreachable')];
    return ['crit', t('ai.status.error')];
  }
  function localRow(p) {
    const st = localStatusOf(p);
    const ROLE = { all: 'ai.local.role_all', private: 'ai.local.role_private', fallback: 'ai.local.role_fallback' };
    const role = p.configured && p.enabled ? t(ROLE[state.localUse] || ROLE.all) : '';
    const name = t('ai.local.name') + (p.gateway ? ' · ' + p.gateway.name : '');
    const sub = [t('ai.local.free')];
    if (p.modelText) sub.unshift(p.modelText);
    const setup = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', 'aria-label': t('ai.local.setup_for'), text: p.modelText ? t('ai.local.change') : t('ai.local.setup'), disabled: off });
    setup.addEventListener('click', () => { const c = $('ai-local'); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); const f = c.querySelector('button, select, input'); if (f) f.focus({ preventScroll: true }); } });
    const sw = switchBtn('ai-on-local', p.enabled, t('ai.enabled.label_for', { name: t('ai.local.name') }), async (on, b) => {
      const r = await call(window.api.put(LBASE + '/enabled', { enabled: on }));
      if (!r.ok) { b.setAttribute('aria-checked', on ? 'false' : 'true'); toast(r.error || t('ai.err.internal'), 'error'); return; }
      await reload();
    });
    sw.disabled = off || !p.modelText;
    return el('li', { class: 'stx-row ai-prov ai-prov-local', 'data-provider': LOCAL, 'data-state': st[0] || 'none' }, [
      el('span', { class: 'pgx-ic stx-initial', 'data-size': 'sm', 'aria-hidden': 'true', text: INITIAL.local }),
      el('span', { class: 'stx-nm' }, [
        el('b', {}, [document.createTextNode(name + ' '), pill('new', t('ai.local.new'))]),
        el('small', { text: sub.join(' · ') }),
      ]),
      role ? pill('blue', role) : null,
      pill(st[0], st[1]),
      setup,
      sw,
    ]);
  }

  function providerRow(p) {
    if (p.local) return localRow(p);
    const st = statusOf(p);
    const sub = [];
    if (p.keySet) sub.push(t('ai.key.hint', { hint: p.keyHint || '' }));
    else sub.push(t('ai.key.none'));
    if (p.capabilities && p.capabilities.length) sub.push(caps(p.capabilities));
    const manage = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', 'aria-label': t('ai.manage_for', { name: NAMES[p.id] }), text: t('ai.manage'), disabled: off });
    manage.addEventListener('click', () => openManage(p.id));
    const sw = switchBtn('ai-on-' + p.id, p.enabled, t('ai.enabled.label_for', { name: NAMES[p.id] }), async (on, b) => {
      const r = await call(window.api.put(BASE + '/providers/' + p.id, { enabled: on }));
      if (!r.ok) { b.setAttribute('aria-checked', on ? 'false' : 'true'); toast(r.error || t('ai.err.internal'), 'error'); return; }
      await reload();
    });
    sw.disabled = off || !p.keySet;
    const role = roleOf(p.id);
    const note = p.keyState === 'invalid' ? t('ai.key.unreadable') : (p.checkError ? p.checkError : '');
    return el('li', { class: 'stx-row ai-prov', 'data-provider': p.id, 'data-state': st[0] || 'none' }, [
      el('span', { class: 'pgx-ic stx-initial', 'data-size': 'sm', 'aria-hidden': 'true', text: INITIAL[p.id] }),
      el('span', { class: 'stx-nm' }, [
        el('b', {}, [document.createTextNode(NAMES[p.id] + ' '), p.modelText ? el('span', { class: 'pgx-ver', text: p.modelText }) : null]),
        el('small', { text: sub.join(' · ') }),
        note ? el('small', { class: 'stx-crit', role: 'status', text: note }) : null,
      ]),
      role ? pill('new', role) : null,
      pill(st[0], st[1]),
      manage,
      sw,
    ]);
  }

  function renderProviders() {
    const box = $('ai-providers');
    clear(box);
    (state.providers || []).forEach((p) => box.appendChild(providerRow(p)));
  }

  // "Verwalten": key, test, model, delete key
  function modelSelect(p) {
    const list = models[p.id] || p.models || [];
    const sel = el('select', { class: 'st-select ai-prov-model', id: 'ai-model-' + p.id, disabled: off || !p.keySet });
    sel.appendChild(el('option', { value: '', text: list.length ? t('ai.model.choose') : t('ai.model.test_first') }));
    const ids = list.map((m) => m.id);
    if (p.modelText && ids.indexOf(p.modelText) < 0) sel.appendChild(el('option', { value: p.modelText, text: p.modelText }));
    list.forEach((m) => sel.appendChild(el('option', { value: m.id, text: m.name && m.name !== m.id ? m.name + ' (' + m.id + ')' : m.id })));
    sel.value = p.modelText || '';
    sel.addEventListener('change', async () => {
      const r = await call(window.api.put(BASE + '/providers/' + p.id, { modelText: sel.value || null }));
      if (!r.ok) { toast(r.error || t('ai.err.internal'), 'error'); return; }
      toast(t('ai.model.saved'));
      await reload();
    });
    return sel;
  }
  function renderManage() {
    const p = managing && state && (state.providers || []).find((x) => x.id === managing);
    const body = $('ai-prov-body');
    clear(body);
    if (!p) return;
    $('ai-prov-title').textContent = NAMES[p.id];
    const st = statusOf(p);
    body.appendChild(el('div', { class: 'pgx-inline' }, [pill(st[0], st[1]), el('span', { class: 'pgx-muted pgx-small', text: caps(p.capabilities) })]));
    const keyId = 'ai-key-' + p.id;
    const key = el('input', { type: 'password', class: 'st-input st-mono ai-prov-key', id: keyId, autocomplete: 'new-password', spellcheck: 'false', maxLength: 500,
      placeholder: p.keyHint ? '••••••••' + p.keyHint : t('ai.key.enter'), disabled: off });
    const test = el('button', { type: 'button', class: 'pgx-btn', text: t('ai.test_btn'), disabled: off });
    test.addEventListener('click', () => testProvider(p, key, test));
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); testProvider(p, key, test); } });
    const keyRow = el('div', { class: 'ai-prov-row' }, [key, test]);
    if (p.keySet) {
      const del = el('button', { type: 'button', class: 'st-icon-btn', 'aria-label': t('ai.key.delete'), title: t('ai.key.delete'), disabled: off }, icon(ICON_TRASH));
      del.addEventListener('click', async () => {
        const ok = await window.GCDialog.confirm({ title: t('ai.key.delete'), message: t('ai.key.delete_confirm', { name: NAMES[p.id] }), okLabel: t('ai.key.delete'), danger: true });
        if (!ok) return;
        const r = await call(window.api.put(BASE + '/providers/' + p.id, { key: '' }));
        if (!r.ok) { toast(r.error || t('ai.err.internal'), 'error'); return; }
        delete models[p.id];
        toast(t('ai.key.deleted'));
        await reload();
      });
      keyRow.appendChild(del);
    }
    body.appendChild(el('div', { class: 'st-fl' }, [el('label', { class: 'st-fl-label', for: keyId, text: t('ai.key.label') }), keyRow, el('span', { class: 'st-hint', text: t('ai.providers.desc') })]));
    const sel = modelSelect(p);
    body.appendChild(el('div', { class: 'st-fl' }, [el('label', { class: 'st-fl-label', for: sel.id, text: t('ai.model.label') }), sel]));
    const note = p.keyState === 'invalid' ? t('ai.key.unreadable') : (p.checkError ? p.checkError : '');
    if (note) body.appendChild(el('p', { class: 'st-hint ai-prov-err', role: 'status', text: note }));
  }
  function openManage(id) {
    managing = id;
    renderManage();
    window.openModal('ai-prov-modal');
    const k = $('ai-key-' + id);
    if (k && !k.disabled) k.focus();
  }

  async function testProvider(p, keyInput, btn) {
    busy(btn, true);
    try {
      const key = keyInput.value.trim();
      if (key) {
        const s = await call(window.api.put(BASE + '/providers/' + p.id, { key }));
        if (!s.ok) { toast(s.error || t('ai.err.field_key'), 'error'); return; }
        keyInput.value = '';
      }
      const r = await call(window.api.post(BASE + '/providers/' + p.id + '/test', {}));
      if (r.ok) {
        models[p.id] = r.models || [];
        toast(t('ai.test.ok', { name: NAMES[p.id], n: models[p.id].length }));
      } else {
        toast(r.error || t('ai.test.err_provider'), 'error');
      }
      await reload();
    } finally { busy(btn, false); }
  }

  // ── Plugins ──
  function providerOptions(sel, first, withLocal) {
    sel.appendChild(el('option', { value: '', text: first }));
    IDS.forEach((id) => sel.appendChild(el('option', { value: id, text: NAMES[id] })));
    // a plugin may be fixed to the local AI (default and fallback stay cloud providers — the mode decides)
    if (withLocal) sel.appendChild(el('option', { value: LOCAL, text: t('ai.local.name') }));
  }

  function renderPlugins() {
    const list = $('ai-plugins');
    clear(list);
    if (!plugins.length) { list.appendChild(el('li', { class: 'st-empty', text: t('ai.plugins.none') })); return; }
    plugins.forEach((pl) => {
      const sel = el('select', { class: 'st-select ai-plugin-provider', 'aria-label': t('ai.plugins.provider_for', { name: pl.name }), disabled: off });
      providerOptions(sel, t('ai.plugins.default_provider'), true);
      sel.value = pl.provider || '';
      sel.addEventListener('change', async () => {
        const r = await call(window.api.put(BASE + '/plugins/' + encodeURIComponent(pl.id), { provider: sel.value || null }));
        if (!r.ok) { toast(r.error || t('ai.err.internal'), 'error'); sel.value = pl.provider || ''; return; }
        pl.provider = r.plugin ? r.plugin.provider : (sel.value || null);
        toast(t('ai.plugins.saved'));
      });
      const sw = switchBtn('ai-allow-' + pl.id, pl.allowed, t('ai.plugins.allow_for', { name: pl.name }), async (on, b) => {
        const r = await call(window.api.put(BASE + '/plugins/' + encodeURIComponent(pl.id), { allowed: on }));
        if (!r.ok) { b.setAttribute('aria-checked', on ? 'false' : 'true'); toast(r.error || t('ai.err.internal'), 'error'); return; }
        pl.allowed = on;
        toast(t(on ? 'ai.plugins.allowed' : 'ai.plugins.blocked', { name: pl.name }));
        status();
      });
      sw.disabled = off;
      list.appendChild(el('li', { class: 'stx-row', 'data-plugin': pl.id }, [
        el('span', { class: 'stx-nm' }, [
          el('b', { text: pl.name }),
          pl.purpose ? el('small', { text: pl.purpose }) : null,
          el('small', { text: t('ai.plugins.caps', { caps: caps(pl.capabilities) }) + (pl.enabled ? '' : ' · ' + t('ai.plugins.disabled')) }),
        ]),
        sel,
        sw,
      ]));
    });
  }

  // ── Side column: usage, default & fallback ──
  function renderUsage(u) {
    const budget = state.budget ? state.budget.cents : 0;
    const used = u ? u.costCents : (state.budget ? state.budget.usedCents : 0);
    $('ai-c-usage').textContent = t('ai.usage.title_month', { month: monthName() });
    $('ai-usage-amount').textContent = euro(used);
    $('ai-usage-of').textContent = t('ai.usage.of', { limit: euro(budget) });
    const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
    const bar = $('ai-usage-bar');
    bar.style.width = pct.toFixed(1) + '%';
    bar.classList.toggle('st-bar-warn', pct >= 80);
    const kvs = $('ai-usage-kv');
    clear(kvs);
    kvs.appendChild(kv(t('ai.usage.kv_requests'), String((u && u.requests) || 0), true));
    kvs.appendChild(kv(t('ai.usage.kv_limit'), euro(budget), true));
    const list = $('ai-usage-list');
    clear(list);
    if (!u || !u.requests) { list.appendChild(el('li', { class: 'pgx-hint', text: t('ai.usage.none') })); return; }
    const names = {};
    plugins.forEach((p) => { names[p.id] = p.name; });
    const row = (label, r) => el('li', { class: 'pgx-kv' }, [el('span', { text: label + ' · ' + tp('ai.usage.requests', r.requests) }), el('span', { class: 'pgx-mono', text: euro(r.costCents) })]);
    (u.byPlugin || []).forEach((r) => list.appendChild(row(names[r.plugin] || r.plugin, r)));
    (u.byProvider || []).forEach((r) => list.appendChild(row(r.provider === LOCAL ? t('ai.local.name') : (NAMES[r.provider] || r.provider || '–'), r)));
    if (u.estimated) list.appendChild(el('li', { class: 'pgx-hint', text: t('ai.usage.estimated') }));
  }
  function renderRoles() {
    const d = state.defaults || {};
    const kvs = $('ai-roles-kv');
    clear(kvs);
    kvs.appendChild(kv(t('ai.role.default'), d.provider ? NAMES[d.provider] || d.provider : t('ai.defaults.auto')));
    kvs.appendChild(kv(t('ai.role.fallback'), d.fallback ? NAMES[d.fallback] || d.fallback : t('ai.defaults.none')));
    kvs.appendChild(kv(t('ai.defaults.per_hour'), String(state.perHour || '–'), true));
  }

  function status() {
    const active = (state.providers || []).filter((p) => p.configured && p.enabled).length;
    // (the local AI counts as a provider too)
    const allowed = plugins.filter((p) => p.allowed).length;
    const used = usage ? usage.costCents : (state.budget ? state.budget.usedCents : 0);
    const node = $('st-status-ki');
    if (node) node.textContent = off ? t('ai.status_line_off') : [tp('ai.status_line.providers', active), tp('ai.status_line.plugins', allowed), t('ai.status_line.cost', { cost: euro(used) })].join(' · ');
  }

  // ── General settings: values for the save bar ──
  function values() {
    const prices = state.priceOverrides && Object.keys(state.priceOverrides).length ? JSON.stringify(state.priceOverrides, null, 2) : '';
    return {
      'ai-default': (state.defaults && state.defaults.provider) || '',
      'ai-fallback': (state.defaults && state.defaults.fallback) || '',
      'ai-media': !!state.mediaAllowed,
      'ai-budget': state.budget ? (state.budget.cents / 100).toFixed(2) : '',
      'ai-perhour': String(state.perHour || ''),
      'ai-rate': String(state.eurPerUsd || ''),
      'ai-prices': prices,
    };
  }
  function prepareDefaults() {
    const def = $('ai-default');
    const fb = $('ai-fallback');
    if (!def.options.length) providerOptions(def, t('ai.defaults.auto'));
    if (!fb.options.length) providerOptions(fb, t('ai.defaults.none'));
    ['ai-default', 'ai-fallback', 'ai-media', 'ai-budget', 'ai-perhour', 'ai-rate', 'ai-prices'].forEach((id) => { $(id).disabled = off; });
  }
  const num = (v) => Number(String(v).trim().replace(',', '.'));

  // ── Load ──
  async function reload() {
    const [r, pl, us] = await Promise.all([call(window.api.get(BASE)), call(window.api.get(BASE + '/plugins')), call(window.api.get(BASE + '/usage'))]);
    if (!r.ok) {
      const box = $('ai-providers');
      clear(box);
      box.appendChild(el('li', { class: 'st-empty', text: r.error || t('ai.err.internal') }));
      return null;
    }
    state = r;
    off = !r.enabled;
    $('ai-off').hidden = !off;
    plugins = pl.ok ? pl.plugins || [] : [];
    usage = us.ok ? us.usage : null;
    renderProviders();
    renderPlugins();
    renderUsage(usage);
    renderRoles();
    renderManage();
    prepareDefaults();
    status();
    loadLocal().catch(() => {});
    return values();
  }

  // ── The local AI (phase 3c, step 3 — services/ai/local.js, /api/v1/ai/local) ──
  // Card "Lokale KI einrichten": on a gateway (GateControl downloads and starts
  // the model) or an existing AI server in the home network (Ollama, LM Studio),
  // the gateway with its memory, "Grafikkarte nutzen" (per gateway, the devices
  // go into its compose file; hints when a driver or the NVIDIA Container
  // Toolkit is missing), the model list with a fit per gateway and graphics
  // memory (hints, never a ban), the download with "Abbrechen"; a LAN server by
  // address or name with an optional API key and "Verbindung testen"; card
  // "Wofür die lokale KI?": the three modes, "Testen" and "Speichern".
  const LBASE = BASE + '/local';
  let lview = null;       // GET /api/v1/ai/local
  let lstatus = null;     // GET /api/v1/ai/local/status (live from the gateway)
  let draft = null;       // { source, peerId, model, lanUrl, lanApi, gpu, lanKey, keyRemove } as chosen on the page
  let lprobe = null;      // the answer of "Verbindung testen" { url, api, reachable, models, … } (nothing saved)
  let useDraft = null;
  let pollTimer = null;
  let testOut = null;     // the answer of "Testen"
  const nf1 = (n) => { try { return new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n); } catch (_) { return n.toFixed(1); } };
  const gbOf = (bytes) => nf1((Number(bytes) || 0) / 1e9);
  const gbMb = (mb) => nf1((Number(mb) || 0) / 1000);
  const ramOf = (mb) => nf1((Number(mb) || 0) / 1024);

  // 'http://192.168.1.20:11434/v1' → 'http://192.168.1.20:11434' (as the server stores it)
  function local_origin(u) {
    try { const x = new URL(u); return x.protocol + '//' + x.hostname + ':' + (x.port || (x.protocol === 'https:' ? '443' : '80')); } catch (_) { return null; }
  }
  function localGw(id) { return lview && (lview.gateways || []).find((g) => g.id === id) || null; }
  function catalogueOf(id) {
    const c = lview && (lview.catalogue || []).find((x) => x.peerId === id);
    if (!c) return [];
    // the fit as it would be with the choice of "Grafikkarte nutzen" on the page (an older server: as saved)
    const gpu = draft && draft.source === 'service' && draft.gpu ? draft.gpu : null;
    return gpu && c.byGpu && c.byGpu[gpu] ? c.byGpu[gpu] : c.models;
  }
  function gpuOf(g) { return (g && g.settings && g.settings.gpu) || 'off'; }
  function firstDraft() {
    const cur = lview.current;
    if (cur) return { source: cur.source, peerId: cur.peerId, model: cur.model, lanUrl: cur.lanUrl || '', lanApi: cur.lanApi || 'ollama', gpu: cur.gpu || 'off', lanKey: '', keyRemove: false };
    const gws = (lview.gateways || []).filter((g) => g.supported);
    const g = gws.find((x) => !x.hint) || gws[0] || null;
    draft = { source: g && g.hint ? 'lan' : 'service', peerId: g ? g.id : null, model: null, lanUrl: '', lanApi: 'ollama', gpu: gpuOf(g), lanKey: '', keyRemove: false };
    const rec = g ? catalogueOf(g.id).find((m) => m.fit === 'recommended') : null;
    draft.model = rec ? rec.id : null;
    return draft;
  }
  const VENDOR = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };
  function gwLabel(g) {
    const parts = [g.name];
    const facts = [];
    if (g.memMb) facts.push(t('ai.local.gw_ram', { gb: ramOf(g.memMb) }));
    if (g.cores) facts.push(tp('ai.local.gw_cores', g.cores));
    const gv = g.gpuView || null;
    const used = !!(gv && (gv.state === 'in_use' || gv.state === 'ready'));
    facts.push(g.gpu && g.gpu.length ? t(used ? 'ai.local.gw_gpu_on' : 'ai.local.gw_gpu', { vendor: g.gpu.map((x) => VENDOR[x.vendor] || t('ai.local.gpu_other')).join(', ') }) : t('ai.local.gw_no_gpu'));
    let text = parts.concat(facts.join(', ')).join(' – ');
    if (!g.supported) text += ' – ' + t('ai.local.gw_old', { min: lview.minGateway });
    else if (g.hint === 'memory') text += ' – ' + t('ai.local.gw_memory');
    if (!g.online) text += ' – ' + t('ai.local.gw_offline');
    return text;
  }
  function modelPresent(name) {
    const list = (lstatus && lstatus.models) || [];
    return list.some((m) => m.name === name || m.name === name + ':latest');
  }
  function pulling() { return !!(lstatus && lstatus.pull && lstatus.pull.state === 'pulling'); }

  async function loadStatus(id) {
    if (!id) { lstatus = null; return null; }
    const r = await call(window.api.get(LBASE + '/status?peer=' + encodeURIComponent(String(id))));
    lstatus = r.ok ? r.status : null;
    return lstatus;
  }
  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!pulling() || !draft) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      const box = $('ai-local-body');
      if (!box || !box.isConnected || box.closest('[hidden]')) return;
      const was = lstatus && lstatus.pull ? lstatus.pull.state : null;
      await loadStatus(draft.peerId);
      if (was === 'pulling' && lstatus && lstatus.pull && lstatus.pull.state === 'done') toast(t('ai.local.pull_done', { model: lstatus.pull.model }));
      renderLocal();
      if (!pulling()) await reload();
    }, 2000);
  }

  function seg(source, title, sub) {
    const on = draft.source === source;
    const b = el('button', { type: 'button', class: 'ai-seg-b', 'aria-pressed': on ? 'true' : 'false', 'data-source': source, disabled: off }, [
      el('b', { text: title }), el('small', { text: sub }),
    ]);
    b.addEventListener('click', () => {
      if (draft.source === source) return;
      draft.source = source;
      renderLocal();
    });
    return b;
  }

  function modelRow(m) {
    const id = 'ai-lm-' + m.id.replace(/[^a-z0-9]/gi, '-');
    const input = el('input', { type: 'radio', name: 'ai-local-model', id, value: m.id, disabled: off });
    input.checked = draft.model === m.id;
    input.addEventListener('change', () => { draft.model = m.id; renderLocal(); });
    const tone = m.fit === 'recommended' ? 'good' : (m.fit === 'not_recommended' ? 'warn' : '');
    return el('label', { class: 'ai-mod', for: id, 'data-model': m.id, 'data-fit': m.fit }, [
      input,
      el('span', { class: 'ai-mod-t' }, [
        el('b', { text: m.name }),
        el('span', { class: 'pgx-muted', text: ' · ' + t('ai.local.size_gb', { gb: gbMb(m.downloadMb) }) + ' · ' + t('ai.local.model.' + m.id.replace(/[^a-z0-9]/gi, '_')) }),
      ]),
      modelPresent(m.id) ? pill('blue', t('ai.local.present')) : null,
      m.vram ? pill(m.vram === 'full' ? 'good' : '', t('ai.local.vram.' + m.vram)) : null,
      pill(tone, t('ai.local.fit.' + m.fit)),
    ]);
  }

  // ── "Grafikkarte nutzen" (per gateway; gateway >= 1.31.0) ──
  const GPU_TONE = { available: 'info', experimental: 'info', compose: 'warn', unsupported: 'info', rpi: 'info' };
  function gpuBlock(g) {
    if (!g || g.platform === 'rpi') return null;
    const opts = g.gpuOptions || null;
    const sup = (g.supports || []).indexOf('gpu') >= 0;
    const cards = g.gpu || [];
    if (!sup) {
      // an older gateway: a hint only when there is a card to use
      return cards.length ? el('p', { class: 'pgx-hint', 'data-gpu-hint': 'unsupported', text: t('ai.local.gpu_hint.unsupported', { min: lview.minGatewayExt || '1.31.0' }) }) : null;
    }
    const sel = el('select', { class: 'st-select', id: 'ai-local-gpu', disabled: off });
    ['off', 'nvidia', 'amd', 'intel'].forEach((c) => sel.appendChild(el('option', { value: c, text: t('ai.local.gpu_opt.' + c) })));
    sel.value = draft.gpu || 'off';
    sel.addEventListener('change', () => {
      draft.gpu = sel.value;
      // the recommendation follows the graphics memory, unless a model was saved here
      const rec = catalogueOf(draft.peerId).find((m) => m.fit === 'recommended');
      if (rec && !(lview.current && lview.current.peerId === draft.peerId && lview.current.model === draft.model)) draft.model = rec.id;
      renderLocal();
    });
    const gv = opts ? opts[draft.gpu || 'off'] : g.gpuView;
    const sug = opts && opts.off ? opts.off.suggest : null;
    const card = gv && gv.card ? gv.card : (sug && opts[sug] ? opts[sug].card : null);
    const info = [];
    if (card) {
      info.push(t('ai.local.gpu_found', { name: card.name || VENDOR[card.vendor] || t('ai.local.gpu_other') }));
      if (card.vramMb) info.push(t('ai.local.gpu_vram', { gb: ramOf(card.vramMb) }));
      else if (card.integrated) info.push(t('ai.local.gpu_shared'));
      if (card.driver) info.push(t('ai.local.gpu_driver', { driver: card.driver }));
    } else if (cards.length) {
      info.push(t('ai.local.gpu_found', { name: cards.map((x) => VENDOR[x.vendor] || t('ai.local.gpu_other')).join(', ') }));
    } else info.push(t('ai.local.gpu_none'));
    const nodes = [
      el('label', { class: 'st-fl-label', for: 'ai-local-gpu', text: t('ai.local.gpu') }), sel,
      el('span', { class: 'st-hint', id: 'ai-local-gpu-info', text: info.join(' · ') }),
    ];
    const box = el('div', { class: 'st-fl', 'data-gpu': draft.gpu || 'off' }, nodes);
    const state = gv && gv.state;
    const saved = gpuOf(g) === (draft.gpu || 'off');
    if (saved && state === 'in_use') box.appendChild(el('p', { class: 'stx-box', 'data-tone': 'good', role: 'status', 'data-gpu-state': 'in_use', text: t('ai.local.gpu_state.in_use') }));
    else if (saved && state === 'ready') box.appendChild(el('p', { class: 'stx-box', 'data-tone': 'good', role: 'status', 'data-gpu-state': 'ready', text: t('ai.local.gpu_state.ready') }));
    ((gv && gv.hints) || []).forEach((h) => {
      // "compose": only once the choice is saved (before that, saving is the next step)
      if (h === 'compose' && !saved) return;
      box.appendChild(el('p', { class: 'stx-box', 'data-tone': GPU_TONE[h] || 'warn', role: 'status', 'data-gpu-hint': h, text: t('ai.local.gpu_hint.' + h, { name: g.name }) }));
    });
    if (!saved && (draft.gpu || 'off') !== 'off') box.appendChild(el('p', { class: 'pgx-hint', text: t('ai.local.gpu_save_note') }));
    return box;
  }

  function progressBox() {
    const p = lstatus && lstatus.pull;
    if (!p) return null;
    if (p.state === 'pulling') {
      const pct = p.total > 0 ? Math.min(100, (p.completed / p.total) * 100) : 0;
      const fill = el('span', { class: 'ai-dl-fill' });
      fill.style.width = pct.toFixed(1) + '%';
      const cancel = el('button', { type: 'button', class: 'pgx-btn', id: 'ai-local-cancel', text: t('ai.local.cancel') });
      cancel.addEventListener('click', async () => {
        busy(cancel, true);
        const r = await call(window.api.post(LBASE + '/pull/cancel', { peerId: draft.peerId }));
        busy(cancel, false);
        if (!r.ok) toast(r.error || t('ai.err.internal'), 'error');
        await loadStatus(draft.peerId);
        renderLocal();
      });
      return el('div', { class: 'ai-dl', role: 'status', 'data-pull': 'pulling' }, [
        el('span', { class: 'ai-dl-t' }, [
          el('b', { text: p.total ? t('ai.local.pulling', { done: gbOf(p.completed), total: gbOf(p.total) }) : t('ai.local.pulling_start', { model: p.model }) }),
          el('span', { class: 'ai-dl-bar', role: 'img', 'aria-label': pct.toFixed(0) + ' %' }, fill),
        ]),
        cancel,
      ]);
    }
    if (p.state === 'error') return el('p', { class: 'stx-box', 'data-tone': 'crit', role: 'status', 'data-pull': 'error', text: t('ai.local.pull_error', { model: p.model, error: (p.error && p.error.message) || '' }) });
    if (p.state === 'cancelled') return el('p', { class: 'pgx-hint', 'data-pull': 'cancelled', text: t('ai.local.pull_cancelled', { model: p.model }) });
    return null;
  }

  async function downloadCompose(g) {
    try {
      const r = await fetch('/api/v1/gateways/' + encodeURIComponent(String(g.id)) + '/compose', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.GC.csrfToken }, body: '{}',
      });
      if (!r.ok) { location.href = '/gateways#gw/' + encodeURIComponent(String(g.id)) + '/features'; return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'docker-compose.yml', hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(t('ai.local.compose_done'));
    } catch (_) { toast(t('ai.err.internal'), 'error'); }
  }

  function serviceNote(g) {
    if (!g || draft.source !== 'service') return null;
    const s = lstatus;
    const plain = el('p', { class: 'pgx-hint', text: t('ai.local.compose_note') });
    if (!g.online) return el('div', {}, [el('p', { class: 'stx-box', 'data-tone': 'warn', text: t('ai.local.offline', { name: g.name }) }), plain]);
    if (!s || !g.settings.enabled) return plain;
    if (s.service === 'managed') {
      if (s.state === 'starting') return el('p', { class: 'stx-box', 'data-tone': 'info', role: 'status', text: t('ai.local.starting') });
      // "Grafikkarte nutzen" saved, but the running service has another GPU kind: the compose file again
      const gv = g.gpuView;
      if (g.platform !== 'rpi' && gv && gv.choice === (draft.gpu || 'off') && gv.hints.indexOf('compose') >= 0) {
        const dl2 = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', id: 'ai-local-compose', text: t('ai.local.compose_btn') });
        dl2.addEventListener('click', () => downloadCompose(g));
        return el('div', { class: 'stx-box ai-local-compose', 'data-tone': 'warn', role: 'status', 'data-compose': 'gpu' }, [el('span', { text: t('ai.local.compose_gpu') + ' ' }), dl2]);
      }
      return plain;
    }
    if (g.platform === 'rpi') {
      return el('p', { class: 'stx-box', 'data-tone': s.service === 'absent' ? 'info' : 'warn', role: 'status', text: t(s.service === 'absent' ? 'ai.local.pi_starting' : 'ai.local.pi_old') });
    }
    const dl = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', id: 'ai-local-compose', text: t('ai.local.compose_btn') });
    dl.addEventListener('click', () => downloadCompose(g));
    return el('div', { class: 'stx-box ai-local-compose', 'data-tone': 'warn', role: 'status' }, [el('span', { text: t('ai.local.compose_missing') + ' ' }), dl]);
  }

  function canProbe(g) { return !!(g && (g.supports || []).indexOf('probe') >= 0); }
  function keyFields(g) {
    const cur = lview.current;
    const has = !!(cur && cur.keySet && cur.source === 'lan') && !draft.keyRemove;
    const key = el('input', { type: 'password', class: 'st-input st-mono', id: 'ai-local-key', autocomplete: 'new-password', spellcheck: 'false', maxLength: 512,
      placeholder: has ? t('ai.local.key_set', { hint: cur.keyHint || '' }) : t('ai.local.key_none'), value: draft.lanKey || '', disabled: off });
    key.addEventListener('input', () => { draft.lanKey = key.value.trim(); if (draft.lanKey) draft.keyRemove = false; });
    const row = [key];
    if (has) {
      const rm = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', id: 'ai-local-key-remove', text: t('ai.local.key_remove'), disabled: off });
      rm.addEventListener('click', () => { draft.keyRemove = true; draft.lanKey = ''; renderLocal(); });
      row.push(rm);
    }
    const hint = (lview.current && lview.current.keySet && draft.keyRemove) ? t('ai.local.key_removing') : t('ai.local.key_hint');
    const sup = !g || (g.supports || []).indexOf('lanKey') >= 0;
    return el('div', { class: 'st-fl' }, [el('label', { class: 'st-fl-label', for: 'ai-local-key', text: t('ai.local.key') }),
      el('div', { class: 'ai-prov-row' }, row), el('span', { class: 'st-hint', id: 'ai-local-key-hint', text: sup ? hint : t('ai.local.key_old', { min: lview.minGatewayExt || '1.31.0' }) })]);
  }
  function probeBox() {
    if (!lprobe) return null;
    if (lprobe.error && !lprobe.models) return el('p', { class: 'stx-box', 'data-tone': 'crit', role: 'status', 'data-probe': 'error', text: lprobe.error });
    if (lprobe.reachable) {
      return el('p', { class: 'stx-box', 'data-tone': 'good', role: 'status', 'data-probe': 'ok',
        text: t('ai.local.probe_ok', { url: lprobe.url, n: (lprobe.models || []).length }) + (lprobe.version ? ' · Ollama ' + lprobe.version : '') });
    }
    const code = (lprobe.error && lprobe.error.code) || 'unreachable';
    const known = ['unauthorized', 'not_private', 'unreachable', 'timeout', 'redirect'];
    return el('p', { class: 'stx-box', 'data-tone': 'warn', role: 'status', 'data-probe': code, text: t('ai.local.probe_err.' + (known.indexOf(code) >= 0 ? code : 'other'), { code }) });
  }
  async function runProbe(g, btn) {
    busy(btn, true);
    try {
      const body = { peerId: g.id, lanUrl: draft.lanUrl, lanApi: draft.lanApi };
      if (draft.lanKey) body.lanKey = draft.lanKey;
      const r = await call(window.api.post(LBASE + '/probe', body));
      lprobe = r.ok ? r.probe : { error: r.error || t('ai.err.internal') };
      if (r.ok && lprobe.reachable && lprobe.models.length && !lprobe.models.some((m) => m.name === draft.model)) draft.model = null;
      renderLocal();
    } finally { busy(btn, false); }
  }
  function lanFields(g) {
    const url = el('input', { type: 'text', class: 'st-input st-mono', id: 'ai-local-url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxLength: 200,
      placeholder: 'http://192.168.1.20:11434', value: draft.lanUrl || '', disabled: off });
    url.addEventListener('input', () => { draft.lanUrl = url.value.trim(); });
    const apiSel = el('select', { class: 'st-select', id: 'ai-local-api', disabled: off }, [
      el('option', { value: 'ollama', text: t('ai.local.api_ollama') }), el('option', { value: 'openai', text: t('ai.local.api_openai') }),
    ]);
    apiSel.value = draft.lanApi || 'ollama';
    apiSel.addEventListener('change', () => { draft.lanApi = apiSel.value; });
    const probing = canProbe(g);
    const connect = el('button', { type: 'button', class: 'pgx-btn', id: 'ai-local-connect', text: probing ? t('ai.local.probe') : t('ai.local.connect'), disabled: off || !g || !g.supported });
    connect.addEventListener('click', async () => {
      // gateway >= 1.31.0: ask the server without saving anything
      if (probing) { await runProbe(g, connect); return; }
      busy(connect, true);
      try {
        const r = await call(window.api.put('/api/v1/gateways/' + encodeURIComponent(String(g.id)) + '/features', { ai: { enabled: true, source: 'lan', lanUrl: draft.lanUrl, lanApi: draft.lanApi } }));
        if (r.ok === false) { toast(t('ai.local.err.field_lanUrl'), 'error'); return; }
        toast(t('ai.local.connected_saved'));
        const lv = await call(window.api.get(LBASE));
        if (lv.ok) lview = lv;
        // the gateway takes the new address with its next config pull (pushed right away): ask a few times
        for (let i = 0; i < 5; i++) {
          await new Promise((res) => setTimeout(res, 1500));
          await loadStatus(g.id);
          if (lstatus && lstatus.source === 'lan' && lstatus.lan && lstatus.lan.url === local_origin(draft.lanUrl)) break;
        }
        renderLocal();
      } finally { busy(connect, false); }
    });
    const fromProbe = lprobe && lprobe.reachable ? lprobe.models : null;
    const list = fromProbe || (lstatus && lstatus.source === 'lan' && lstatus.models) || [];
    const sel = el('select', { class: 'st-select', id: 'ai-local-lanmodel', disabled: off || !list.length });
    sel.appendChild(el('option', { value: '', text: list.length ? t('ai.model.choose') : t(probing ? 'ai.local.lan_models_probe' : 'ai.local.lan_models_first') }));
    if (draft.model && !list.some((m) => m.name === draft.model)) sel.appendChild(el('option', { value: draft.model, text: draft.model }));
    list.forEach((m) => sel.appendChild(el('option', { value: m.name, text: m.name + (m.size ? ' (' + t('ai.local.size_gb', { gb: gbOf(m.size) }) + ')' : '') })));
    sel.value = draft.model || '';
    sel.addEventListener('change', () => { draft.model = sel.value || null; });
    const lerr = lstatus && lstatus.source === 'lan' && lstatus.error ? lstatus.error.code : null;
    const reach = lprobe ? probeBox() : (lstatus && lstatus.source === 'lan'
      ? el('p', { class: 'stx-box', 'data-tone': lstatus.state === 'running' ? 'good' : 'warn', role: 'status',
        text: lstatus.state === 'running' ? t('ai.local.lan_ok', { url: (lstatus.lan && lstatus.lan.url) || draft.lanUrl })
          : (lerr === 'unauthorized' || lerr === 'not_private' ? t('ai.local.probe_err.' + lerr) : t('ai.local.lan_unreachable')) })
      : null);
    // a key over plain http travels unencrypted through the home network
    const plainKey = /^http:/i.test(draft.lanUrl || '') && (draft.lanKey || (lview.current && lview.current.keySet && !draft.keyRemove));
    return [
      el('div', { class: 'st-fl' }, [el('label', { class: 'st-fl-label', for: 'ai-local-url', text: t('ai.local.lan_url') }),
        el('div', { class: 'ai-prov-row' }, [url, apiSel, connect]), el('span', { class: 'st-hint', text: t('ai.local.lan_url_hint') })]),
      keyFields(g),
      plainKey ? el('p', { class: 'pgx-hint', 'data-key-http': '', text: t('ai.local.key_http') }) : null,
      reach,
      el('div', { class: 'st-fl' }, [el('label', { class: 'st-fl-label', for: 'ai-local-lanmodel', text: t('ai.model.label') }), sel]),
    ];
  }

  async function saveLocal(btn) {
    if (!draft.peerId) { toast(t('ai.local.err.field_peerId'), 'error'); return; }
    if (!draft.model) { toast(t('ai.local.err.field_model'), 'error'); return; }
    const g = localGw(draft.peerId);
    if (g && g.hint === 'memory' && draft.source === 'service') {
      const ok = await window.GCDialog.confirm({ title: t('ai.local.weak_title'), message: t('ai.local.weak_msg', { name: g.name }), okLabel: t('ai.local.weak_ok') });
      if (!ok) return;
    }
    busy(btn, true);
    try {
      const body = { source: draft.source, peerId: draft.peerId, model: draft.model };
      if (draft.source === 'lan') {
        body.lanUrl = draft.lanUrl;
        body.lanApi = draft.lanApi;
        // a typed key replaces the stored one, "Schlüssel entfernen" removes it, nothing typed keeps it
        if (draft.lanKey) body.lanKey = draft.lanKey;
        else if (draft.keyRemove) body.lanKey = null;
      }
      if (draft.source === 'service' && g && (g.supports || []).indexOf('gpu') >= 0 && g.platform !== 'rpi') body.gpu = draft.gpu || 'off';
      const r = await call(window.api.put(LBASE, body));
      if (!r.ok) { toast(r.error || t('ai.err.internal'), 'error'); return; }
      lview = r;
      draft.lanKey = '';
      draft.keyRemove = false;
      lprobe = null;
      toast(t('ai.local.saved'));
      await loadStatus(draft.peerId);
      if (r.startPull && lstatus && lstatus.state === 'running' && !modelPresent(draft.model) && !pulling()) await startPull();
      await reload();
    } finally { busy(btn, false); }
  }

  async function startPull() {
    const r = await call(window.api.post(LBASE + '/pull', { peerId: draft.peerId, model: draft.model }));
    if (!r.ok) { toast(r.error || t('ai.err.internal'), 'error'); return; }
    await loadStatus(draft.peerId);
    renderLocal();
  }

  function renderLocal() {
    const box = $('ai-local-body');
    if (!box || !lview) return;
    clear(box);
    if (!draft) draft = firstDraft();
    const gws = lview.gateways || [];
    if (!gws.length) { box.appendChild(el('p', { class: 'st-empty', text: t('ai.local.no_gateways') })); return; }
    box.appendChild(el('div', { class: 'ai-seg', role: 'group', 'aria-label': t('ai.local.where') }, [
      seg('service', t('ai.local.src_service'), t('ai.local.src_service_d')),
      seg('lan', t('ai.local.src_lan'), t('ai.local.src_lan_d')),
    ]));
    const sel = el('select', { class: 'st-select', id: 'ai-local-gw', disabled: off });
    gws.forEach((g) => sel.appendChild(el('option', { value: String(g.id), text: gwLabel(g), disabled: !g.supported })));
    if (!draft.peerId || !localGw(draft.peerId)) draft.peerId = (gws.find((g) => g.supported) || gws[0]).id;
    sel.value = String(draft.peerId);
    sel.addEventListener('change', async () => {
      draft.peerId = Number(sel.value);
      draft.gpu = gpuOf(localGw(draft.peerId));
      lprobe = null;
      const rec = catalogueOf(draft.peerId).find((m) => m.fit === 'recommended');
      if (draft.source === 'service' && rec && !(lview.current && lview.current.peerId === draft.peerId)) draft.model = rec.id;
      await loadStatus(draft.peerId);
      renderLocal();
    });
    const g = localGw(draft.peerId);
    box.appendChild(el('div', { class: 'st-fl' }, [
      el('label', { class: 'st-fl-label', for: 'ai-local-gw', text: draft.source === 'lan' ? t('ai.local.gw_lan') : t('ai.local.gw') }), sel,
      draft.source === 'lan' ? el('span', { class: 'st-hint', text: t('ai.local.gw_lan_hint') }) : null,
    ]));
    if (g && g.hint === 'memory' && draft.source === 'service') {
      const toLan = el('button', { type: 'button', class: 'pgx-btn pgx-btn-sm', text: t('ai.local.use_lan') });
      toLan.addEventListener('click', () => { draft.source = 'lan'; renderLocal(); });
      box.appendChild(el('div', { class: 'stx-box', 'data-tone': 'warn', role: 'status', 'data-local-hint': 'memory' }, [el('span', { text: t('ai.local.hint_memory', { name: g.name, gb: ramOf(g.memMb) }) + ' ' }), toLan]));
    }
    if (draft.source === 'service') {
      const gb = gpuBlock(g);
      if (gb) box.appendChild(gb);
      box.appendChild(el('span', { class: 'st-fl-label', id: 'ai-local-models-l', text: t('ai.model.label') }));
      const list = el('div', { class: 'ai-mods', role: 'radiogroup', 'aria-labelledby': 'ai-local-models-l' });
      catalogueOf(draft.peerId).forEach((m) => list.appendChild(modelRow(m)));
      box.appendChild(list);
      const chosen = catalogueOf(draft.peerId).find((m) => m.id === draft.model);
      if (chosen && chosen.fit === 'not_recommended') box.appendChild(el('p', { class: 'stx-box', 'data-tone': 'warn', role: 'status', text: t(chosen.reason === 'memory' ? 'ai.local.not_rec_memory' : 'ai.local.not_rec_slow', { name: chosen.name }) }));
      const pb = progressBox();
      if (pb) box.appendChild(pb);
      const saved = lview.current && lview.current.peerId === draft.peerId && lview.current.model === draft.model && lview.current.source === 'service';
      if (saved && lstatus && lstatus.state === 'running' && !modelPresent(draft.model) && !pulling()) {
        const load = el('button', { type: 'button', class: 'pgx-btn', id: 'ai-local-pull', text: t('ai.local.pull', { model: chosen ? chosen.name : draft.model }) });
        load.addEventListener('click', async () => { busy(load, true); try { await startPull(); } finally { busy(load, false); } });
        box.appendChild(el('div', { class: 'pgx-inline' }, [load]));
      }
      const note = serviceNote(g);
      if (note) box.appendChild(note);
    } else {
      lanFields(g).forEach((n) => { if (n) box.appendChild(n); });
    }
    const save = el('button', { type: 'button', class: 'pgx-btn pgx-btn-pri', id: 'ai-local-save', text: t('common.save'), disabled: off });
    save.addEventListener('click', () => saveLocal(save));
    box.appendChild(el('div', { class: 'pgx-inline ai-local-actions' }, [save]));
    schedulePoll();
  }

  function renderUse() {
    const box = $('ai-use-body');
    if (!box || !lview) return;
    clear(box);
    if (!useDraft) useDraft = lview.use || 'all';
    const list = el('div', { class: 'ai-uses', role: 'radiogroup', 'aria-labelledby': 'ai-c-use' });
    ['all', 'private', 'fallback'].forEach((u) => {
      const id = 'ai-use-' + u;
      const input = el('input', { type: 'radio', name: 'ai-use', id, value: u, disabled: off });
      input.checked = useDraft === u;
      input.addEventListener('change', () => { useDraft = u; });
      list.appendChild(el('label', { class: 'ai-use-o', for: id }, [input, el('span', {}, [el('b', { text: t('ai.use.' + u) }), el('span', { class: 'pgx-muted', text: ' – ' + t('ai.use.' + u + '_d') })])]));
    });
    box.appendChild(list);
    const ready = !!(lview.provider && lview.provider.configured);
    const test = el('button', { type: 'button', class: 'pgx-btn', id: 'ai-local-test', text: t('ai.local.test'), disabled: off || !ready });
    test.addEventListener('click', async () => {
      busy(test, true);
      testOut = { running: true };
      renderTestOut();
      try {
        const r = await call(window.api.post(LBASE + '/test', {}));
        testOut = r.ok ? { text: r.text, ms: r.durationMs, model: r.model } : { error: r.error || t('ai.err.internal') };
      } finally { busy(test, false); renderTestOut(); }
    });
    const save = el('button', { type: 'button', class: 'pgx-btn pgx-btn-pri', id: 'ai-use-save', text: t('common.save'), disabled: off });
    save.addEventListener('click', async () => {
      busy(save, true);
      try {
        const r = await call(window.api.put(LBASE + '/use', { use: useDraft }));
        if (!r.ok) { toast(r.error || t('ai.err.internal'), 'error'); return; }
        toast(t('ai.use.saved'));
        await reload();
      } finally { busy(save, false); }
    });
    box.appendChild(el('div', { class: 'pgx-inline ai-local-actions' }, [test, save]));
    if (!ready) box.appendChild(el('p', { class: 'pgx-hint', text: t('ai.use.not_ready') }));
    box.appendChild(el('div', { id: 'ai-test-out', role: 'status', 'aria-live': 'polite' }));
    renderTestOut();
  }

  function renderTestOut() {
    const out = $('ai-test-out');
    if (!out) return;
    clear(out);
    if (!testOut) return;
    if (testOut.running) { out.appendChild(el('p', { class: 'pgx-hint', text: t('ai.local.test_running') })); return; }
    if (testOut.error) { out.appendChild(el('p', { class: 'stx-box', 'data-tone': 'crit', text: testOut.error })); return; }
    out.appendChild(el('div', { class: 'stx-box ai-test-ans', 'data-tone': 'info' }, [
      el('p', { text: testOut.text }),
      el('small', { class: 'pgx-muted', text: t('ai.local.test_meta', { s: nf1((testOut.ms || 0) / 1000), model: testOut.model }) }),
    ]));
  }

  async function loadLocal() {
    const r = await call(window.api.get(LBASE));
    if (!r.ok) { lview = null; return; }
    lview = r;
    if (!draft) draft = firstDraft();
    else if (lview.current && !pulling()) draft.peerId = draft.peerId || lview.current.peerId;
    await loadStatus(draft.peerId);
    renderLocal();
    renderUse();
  }


  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    $('ai-log-open').addEventListener('click', openLog);
    $('ai-roles-edit').addEventListener('click', (e) => {
      e.preventDefault();
      const d = $('ai-default');
      d.scrollIntoView({ behavior: 'smooth', block: 'center' });
      d.focus({ preventScroll: true });
    });
  }

  // ── Log ──
  async function openLog() {
    const list = $('ai-log-list');
    clear(list);
    list.appendChild(el('li', { class: 'st-empty', text: t('common.loading') }));
    window.openModal('ai-log-modal');
    const r = await call(window.api.get(BASE + '/requests?limit=100'));
    clear(list);
    const rows = r.ok ? r.requests || [] : [];
    if (!rows.length) { list.appendChild(el('li', { class: 'st-empty', text: r.ok ? t('ai.log.empty') : (r.error || t('ai.err.internal')) })); return; }
    const names = {};
    plugins.forEach((p) => { names[p.id] = p.name; });
    rows.forEach((x) => {
      const pills = [pill(x.outcome === 'ok' ? 'good' : 'crit', x.outcome === 'ok' ? t('ai.log.ok') : x.outcome)];
      if (x.fallback) pills.push(pill('blue', t('ai.log.fallback')));
      const ROUTE = { local: 'ai.log.route_local', private: 'ai.log.route_private', budget: 'ai.log.route_budget', local_only: 'ai.log.route_local_only', test: 'ai.log.route_test' };
      if (x.route && ROUTE[x.route]) pills.push(pill('new', t(ROUTE[x.route])));
      if (x.estimated) pills.push(pill('', t('ai.log.estimated')));
      const sub = [when(x.at), x.provider ? (x.provider === LOCAL ? t('ai.local.name') : (NAMES[x.provider] || x.provider)) + (x.model ? ' · ' + x.model : '') : null,
        t('ai.log.tokens', { in: x.inputTokens, out: x.outputTokens }), x.mediaCount ? t('ai.log.media', { n: x.mediaCount }) : null,
        euro(x.costCents), (x.durationMs / 1000).toFixed(1) + ' s'].filter(Boolean).join(' · ');
      list.appendChild(el('li', { class: 'st-li' }, [
        el('div', { class: 'st-li-main' }, [el('div', { class: 'st-li-title', text: (names[x.plugin] || x.plugin) + ' · ' + (x.task || x.kind) }), el('div', { class: 'st-li-sub', text: sub })]),
        el('div', { class: 'st-li-pills' }, pills),
      ]));
    });
  }

  window.GCSettingsExt = window.GCSettingsExt || {};
  window.GCSettingsExt.ki = {
    // settings.js fills the fields with the returned values (saved state)
    fills: true,
    load() { wire(); return reload(); },
    validate(v, dirty) {
      const errs = {};
      if (dirty.includes('ai-prices') && String(v['ai-prices']).trim()) {
        try { JSON.parse(v['ai-prices']); } catch (_) { errs['ai-prices'] = t('ai.prices.invalid'); }
      }
      if (dirty.includes('ai-default') || dirty.includes('ai-fallback')) {
        if (v['ai-fallback'] && v['ai-fallback'] === v['ai-default']) errs['ai-fallback'] = t('ai.err.field_fallbackProvider');
      }
      return errs;
    },
    groups: [{
      fields: ['ai-default', 'ai-fallback', 'ai-media', 'ai-budget', 'ai-perhour', 'ai-rate', 'ai-prices'],
      map: { defaultProvider: 'ai-default', fallbackProvider: 'ai-fallback', mediaAllowed: 'ai-media', budgetCents: 'ai-budget', perHour: 'ai-perhour', eurPerUsd: 'ai-rate', priceOverrides: 'ai-prices' },
      save(v) {
        const raw = String(v['ai-prices']).trim();
        return window.api.put(BASE + '/settings', {
          defaultProvider: v['ai-default'] || null,
          fallbackProvider: v['ai-fallback'] || null,
          mediaAllowed: !!v['ai-media'],
          budgetCents: Math.round(num(v['ai-budget']) * 100),
          perHour: Math.round(num(v['ai-perhour'])),
          eurPerUsd: num(v['ai-rate']),
          priceOverrides: raw ? JSON.parse(raw) : {},
        }).catch((e) => {
          // { code: 'invalid', field: 'budgetCents' } → the message at that field
          const r = e && e.data;
          if (r && r.field) return Object.assign({}, r, { fields: { [r.field]: r.error } });
          throw e;
        });
      },
      after: () => reload(),
    }],
  };
}());
