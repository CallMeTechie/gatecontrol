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
  const INITIAL = { openai: 'O', anthropic: 'A', gemini: 'G', openrouter: 'R' };
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
  function roleOf(id) {
    const d = state && state.defaults ? state.defaults : {};
    if (d.provider === id) return t('ai.role.default');
    if (d.fallback === id) return t('ai.role.fallback');
    return '';
  }

  function providerRow(p) {
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
  function providerOptions(sel, first) {
    sel.appendChild(el('option', { value: '', text: first }));
    IDS.forEach((id) => sel.appendChild(el('option', { value: id, text: NAMES[id] })));
  }

  function renderPlugins() {
    const list = $('ai-plugins');
    clear(list);
    if (!plugins.length) { list.appendChild(el('li', { class: 'st-empty', text: t('ai.plugins.none') })); return; }
    plugins.forEach((pl) => {
      const sel = el('select', { class: 'st-select ai-plugin-provider', 'aria-label': t('ai.plugins.provider_for', { name: pl.name }), disabled: off });
      providerOptions(sel, t('ai.plugins.default_provider'));
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
    (u.byProvider || []).forEach((r) => list.appendChild(row(NAMES[r.provider] || r.provider || '–', r)));
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
    return values();
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
      if (x.estimated) pills.push(pill('', t('ai.log.estimated')));
      const sub = [when(x.at), x.provider ? (NAMES[x.provider] || x.provider) + (x.model ? ' · ' + x.model : '') : null,
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
