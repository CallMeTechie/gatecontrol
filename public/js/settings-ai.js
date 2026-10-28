'use strict';

// Einstellungen › KI-Anbieter (templates/aurora/partials/settings-ai.njk,
// docs/plugins.md "AI requests", API src/routes/api/ai.js). A section of the
// settings page with its own script: settings.js calls load() when it is
// shown. Every control acts at once (no save bar): a key is saved and
// tested with "Testen", a model, the provider switch and the plugin rows
// on change, the general settings with their own "Speichern".
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
  function busy(btn, on) { if (!btn) return; if (on) { if (window.btnLoading) window.btnLoading(btn); else btn.disabled = true; } else if (window.btnReset) window.btnReset(btn); else btn.disabled = false; }
  function caps(list) { return (list || []).map((c) => t('ai.cap.' + c)).join(', '); }
  function switchBtn(id, on, label, onChange) {
    const b = el('button', { type: 'button', class: 'st-switch', role: 'switch', id, 'aria-checked': on ? 'true' : 'false', 'aria-label': label }, el('span', { class: 'st-knob', 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next, b);
    });
    return b;
  }

  let state = null;       // GET /api/v1/ai
  let plugins = [];       // GET /api/v1/ai/plugins
  const models = {};      // provider id → [{ id, name, capabilities }] from "Testen"
  let off = false;

  // ── Provider cards ──
  function statusOf(p) {
    if (p.keyState === 'invalid') return ['crit', t('ai.status.key_invalid')];
    if (p.configured) return ['good', t('ai.status.connected')];
    if (p.keySet && p.checkError) return ['crit', t('ai.status.error')];
    if (p.keySet && !p.modelText) return ['warn', t('ai.status.choose_model')];
    if (p.keySet && !p.enabled) return ['', t('ai.status.off')];
    return ['', t('ai.status.not_set')];
  }

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

  function providerCard(p) {
    const st = statusOf(p);
    const card = el('div', { class: 'st-tile ai-prov', 'data-state': st[0] || 'none', 'data-provider': p.id });
    card.appendChild(el('div', { class: 'st-tile-head' }, [
      el('span', { class: 'ai-initial', 'aria-hidden': 'true', text: INITIAL[p.id] }),
      el('div', { class: 'ai-prov-name' }, [el('span', { class: 'st-tile-name', text: NAMES[p.id] }), el('span', { class: 'st-li-sub', text: caps(p.capabilities) })]),
      el('span', { class: 'st-pill', 'data-state': st[0] || null, text: st[1] }),
    ]));
    const keyId = 'ai-key-' + p.id;
    const key = el('input', { type: 'password', class: 'st-input st-mono ai-prov-key', id: keyId, autocomplete: 'new-password', spellcheck: 'false', maxLength: 500,
      placeholder: p.keyHint ? '••••••••' + p.keyHint : t('ai.key.enter'), disabled: off });
    const test = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('ai.test_btn'), disabled: off });
    test.addEventListener('click', () => testProvider(p, key, test));
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); testProvider(p, key, test); } });
    const keyRow = el('div', { class: 'ai-prov-row' }, [el('label', { class: 'ai-prov-label', for: keyId, text: t('ai.key.label') }), key, test]);
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
    card.appendChild(keyRow);
    const sel = modelSelect(p);
    card.appendChild(el('div', { class: 'ai-prov-row' }, [el('label', { class: 'ai-prov-label', for: sel.id, text: t('ai.model.label') }), sel]));
    const sw = switchBtn('ai-on-' + p.id, p.enabled, t('ai.enabled.label_for', { name: NAMES[p.id] }), async (on, b) => {
      const r = await call(window.api.put(BASE + '/providers/' + p.id, { enabled: on }));
      if (!r.ok) { b.setAttribute('aria-checked', on ? 'false' : 'true'); toast(r.error || t('ai.err.internal'), 'error'); return; }
      await reload();
    });
    sw.disabled = off || !p.keySet;
    card.appendChild(el('div', { class: 'ai-prov-row ai-prov-switch' }, [el('span', { class: 'ai-prov-label', text: t('ai.enabled.label') }), sw]));
    const note = p.keyState === 'invalid' ? t('ai.key.unreadable') : (p.checkError ? p.checkError : '');
    if (note) card.appendChild(el('p', { class: 'st-hint ai-prov-err', role: 'status', text: note }));
    return card;
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

  function renderProviders() {
    const box = $('ai-providers');
    clear(box);
    (state.providers || []).forEach((p) => box.appendChild(providerCard(p)));
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
      });
      sw.disabled = off;
      list.appendChild(el('li', { class: 'st-li' }, [
        el('div', { class: 'st-li-main' }, [
          el('div', { class: 'st-li-title', text: pl.name }),
          el('div', { class: 'st-li-sub', text: pl.purpose }),
          el('div', { class: 'st-li-sub', text: t('ai.plugins.caps', { caps: caps(pl.capabilities) }) + (pl.enabled ? '' : ' · ' + t('ai.plugins.disabled')) }),
        ]),
        el('div', { class: 'st-li-actions' }, [sel, sw]),
      ]));
    });
  }

  // ── Usage ──
  function renderUsage(u) {
    const budget = state.budget ? state.budget.cents : 0;
    const used = u ? u.costCents : (state.budget ? state.budget.usedCents : 0);
    $('ai-usage-amount').textContent = euro(used);
    $('ai-usage-of').textContent = t('ai.usage.of', { limit: euro(budget) });
    const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
    const bar = $('ai-usage-bar');
    bar.style.width = pct.toFixed(1) + '%';
    bar.classList.toggle('st-bar-warn', pct >= 80);
    const list = $('ai-usage-list');
    clear(list);
    if (!u || !u.requests) { list.appendChild(el('li', { class: 'st-hint', text: t('ai.usage.none') })); return; }
    const names = {};
    plugins.forEach((p) => { names[p.id] = p.name; });
    const row = (label, r) => el('li', {}, [el('div', { class: 'st-bar-head' }, [
      el('span', { class: 'st-tile-name', text: label }), el('span', { text: euro(r.costCents) }), el('span', { class: 'st-hint', text: tp('ai.usage.requests', r.requests) }),
    ])]);
    (u.byPlugin || []).forEach((r) => list.appendChild(row(names[r.plugin] || r.plugin, r)));
    (u.byProvider || []).forEach((r) => list.appendChild(row(NAMES[r.provider] || r.provider || '–', r)));
    if (u.estimated) list.appendChild(el('li', { class: 'st-hint', text: t('ai.usage.estimated') }));
  }

  // ── Defaults & fallback ──
  function renderDefaults() {
    const def = $('ai-default');
    const fb = $('ai-fallback');
    clear(def);
    clear(fb);
    providerOptions(def, t('ai.defaults.auto'));
    providerOptions(fb, t('ai.defaults.none'));
    def.value = (state.defaults && state.defaults.provider) || '';
    fb.value = (state.defaults && state.defaults.fallback) || '';
    $('ai-media').setAttribute('aria-checked', state.mediaAllowed ? 'true' : 'false');
    $('ai-budget').value = state.budget ? (state.budget.cents / 100).toFixed(2) : '';
    $('ai-perhour').value = String(state.perHour || '');
    $('ai-rate').value = String(state.eurPerUsd || '');
    const prices = state.priceOverrides && Object.keys(state.priceOverrides).length ? JSON.stringify(state.priceOverrides, null, 2) : '';
    $('ai-prices').value = prices;
    ['ai-default', 'ai-fallback', 'ai-media', 'ai-budget', 'ai-perhour', 'ai-rate', 'ai-prices', 'ai-defaults-save'].forEach((id) => { $(id).disabled = off; });
  }

  async function saveDefaults() {
    const err = $('ai-defaults-err');
    err.hidden = true;
    let priceOverrides = {};
    const raw = $('ai-prices').value.trim();
    if (raw) {
      try { priceOverrides = JSON.parse(raw); } catch (_) { err.textContent = t('ai.prices.invalid'); err.hidden = false; $('ai-prices').focus(); return; }
    }
    const body = {
      defaultProvider: $('ai-default').value || null,
      fallbackProvider: $('ai-fallback').value || null,
      mediaAllowed: $('ai-media').getAttribute('aria-checked') === 'true',
      budgetCents: Math.round(Number($('ai-budget').value) * 100),
      perHour: Math.round(Number($('ai-perhour').value)),
      eurPerUsd: Number($('ai-rate').value),
      priceOverrides,
    };
    const btn = $('ai-defaults-save');
    busy(btn, true);
    try {
      const r = await call(window.api.put(BASE + '/settings', body));
      if (!r.ok) { err.textContent = r.error || t('ai.err.invalid'); err.hidden = false; return; }
      toast(t('ai.defaults.saved'));
      await reload();
    } finally { busy(btn, false); }
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
      const pills = [el('span', { class: 'st-pill', 'data-state': x.outcome === 'ok' ? 'good' : 'crit', text: x.outcome === 'ok' ? t('ai.log.ok') : x.outcome })];
      if (x.fallback) pills.push(el('span', { class: 'st-pill', 'data-state': 'info', text: t('ai.log.fallback') }));
      if (x.estimated) pills.push(el('span', { class: 'st-pill', text: t('ai.log.estimated') }));
      const sub = [when(x.at), x.provider ? (NAMES[x.provider] || x.provider) + (x.model ? ' · ' + x.model : '') : null,
        t('ai.log.tokens', { in: x.inputTokens, out: x.outputTokens }), x.mediaCount ? t('ai.log.media', { n: x.mediaCount }) : null,
        euro(x.costCents), (x.durationMs / 1000).toFixed(1) + ' s'].filter(Boolean).join(' · ');
      list.appendChild(el('li', { class: 'st-li' }, [
        el('div', { class: 'st-li-main' }, [el('div', { class: 'st-li-title', text: (names[x.plugin] || x.plugin) + ' · ' + (x.task || x.kind) }), el('div', { class: 'st-li-sub', text: sub })]),
        el('div', { class: 'st-li-pills' }, pills),
      ]));
    });
  }

  // ── Load ──
  async function reload() {
    const [r, pl, us] = await Promise.all([call(window.api.get(BASE)), call(window.api.get(BASE + '/plugins')), call(window.api.get(BASE + '/usage'))]);
    if (!r.ok) {
      const box = $('ai-providers');
      clear(box);
      box.appendChild(el('p', { class: 'st-empty', text: r.error || t('ai.err.internal') }));
      return;
    }
    state = r;
    off = !r.enabled;
    $('ai-off').hidden = !off;
    plugins = pl.ok ? pl.plugins || [] : [];
    renderProviders();
    renderPlugins();
    renderUsage(us.ok ? us.usage : null);
    renderDefaults();
  }

  let wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    $('ai-media').addEventListener('click', () => {
      const b = $('ai-media');
      b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });
    $('ai-defaults-save').addEventListener('click', saveDefaults);
    $('ai-log-open').addEventListener('click', openLog);
  }

  window.GCSettingsExt = window.GCSettingsExt || {};
  window.GCSettingsExt.ki = { load() { wire(); return reload(); } };
}());
