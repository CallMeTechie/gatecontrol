'use strict';
// Smart-Home Logikketten (rules) subpage. Mirrors public/js/smarthome.js idioms:
// IIFE, $/esc/T/api helpers, CSRF header on mutations, addEventListener only (CSP
// blocks inline handlers: script-src-attr 'none').
(function () {
  const API = '/api/v1/smarthome';
  const T = (k) => (window.GC && GC.t && GC.t[k]) || k;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // api() mirrors smarthome.js but attaches res.status so save() can branch 409 (limit) vs 400 (invalid).
  async function api(path, opts) {
    const csrf = window.GC && GC.csrfToken;
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      ...opts,
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); const e = new Error(b.error || res.status); e.status = res.status; throw e; }
    return res.json();
  }

  const RULE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9c0 7-12 5-12 9"/></svg>';

  // Sensor reading → trigger kind understood by the server (rulesTranslate). humidity/unknown have no rule support.
  const TRIG = { presence: 'motion', open: 'contact', water: 'water', temperature: 'temperature', lightlevel: 'lux', button: 'button' };
  const EVENT_KINDS = ['motion', 'contact', 'water', 'button']; // edge-triggered (count for multi-hint)

  let gatewayId = null;
  let resources = [];
  let resById = {};
  let cancelSupported = true;
  let editingId = null;

  function resourceName(id) { const r = resById[id]; return r ? (r.name || ('#' + id)) : ('#' + id); }
  function trigType(r) { if (!r) return null; if (r.kind === 'switch') return 'button'; if (r.kind === 'sensor') return TRIG[r.capabilities && r.capabilities.reading] || null; return null; }
  function triggerResources() { return resources.filter((r) => r.enabled && trigType(r)); }
  function actionResources() { return resources.filter((r) => r.enabled && ['light', 'plug', 'group', 'scene'].includes(r.kind)); }

  // sRGB hex → CIE xy (deCONZ colour lights take xy; hs/xy caps).
  function hexToXy(hex) {
    const n = parseInt(hex.slice(1), 16);
    const g = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
    const r = g(((n >> 16) & 255) / 255), gg = g(((n >> 8) & 255) / 255), b = g((n & 255) / 255);
    const X = r * 0.4124 + gg * 0.3576 + b * 0.1805, Y = r * 0.2126 + gg * 0.7152 + b * 0.0722, Z = r * 0.0193 + gg * 0.1192 + b * 0.9505;
    const s = X + Y + Z || 1; return [+(X / s).toFixed(4), +(Y / s).toFixed(4)];
  }

  // ── Flow line (read-only card summary) ──────────────────────────────────
  function trigLabel(t) {
    const n = resourceName(t.resourceId);
    switch (t.kind) {
      case 'motion': return `${n}: ${T(t.event === 'detected' ? 'smarthome.val.motion' : 'smarthome.val.idle')}`;
      case 'contact': return `${n}: ${T(t.event === 'open' ? 'smarthome.val.open' : 'smarthome.val.closed')}`;
      case 'water': return `${n}: ${T(t.event === 'wet' ? 'smarthome.val.wet' : 'smarthome.val.dry')}`;
      case 'temperature': return `${n} ${t.op === 'lt' ? '<' : '>'} ${t.value} °C`;
      case 'lux': return `${n} ${t.op === 'lt' ? '<' : '>'} ${t.value} lx`;
      case 'button': return `${n}: ${T('smarthome.rules.btn_' + (t.action || 'short'))}`;
      default: return n;
    }
  }
  function actLabel(a) {
    const n = resourceName(a.resourceId);
    if (a.kind === 'scene') return `${n}: ${T('smarthome.activate')}`;
    const s = a.set || {}; let x = n;
    if (s.on === true) x += ': ' + T('smarthome.rules.act_on');
    else if (s.on === false) x += ': ' + T('smarthome.rules.act_off');
    if ('bri' in s) x += ' · ' + s.bri + ' %';
    if ('color' in s) x += ' · ' + T('smarthome.color');
    return x;
  }
  // Returns HTML; every user-origin field (resource names in labels) is wrapped in esc().
  function flowText(def) {
    def = def || {};
    const parts = [];
    (def.triggers || []).forEach((t) => parts.push(`<span class="pill pill-when">${esc(trigLabel(t))}</span>`));
    parts.push('<span class="arrow">→</span>');
    (def.actions || []).forEach((a) => parts.push(`<span class="pill pill-then">${esc(actLabel(a))}</span>`));
    if (def.timeWindow && def.timeWindow.from && def.timeWindow.to) parts.push(`<span class="pill pill-time">${esc(def.timeWindow.from)}–${esc(def.timeWindow.to)}</span>`);
    if (def.delay && def.delay.minutes) parts.push(`<span class="pill pill-time">+${esc(def.delay.minutes)} min</span>`);
    return parts.join('');
  }

  function ruleCard(r) {
    const el = document.createElement('div');
    el.className = 'card rule-card' + (r.orphaned ? ' rule-orphaned' : '');
    // Single innerHTML line: user fields (esc(r.name)) + flowText (esc internally) + optional warn (esc).
    el.innerHTML = `<div class="rule-ic">${RULE_ICON}</div><div class="rule-main"><div class="rule-name">${esc(r.name || '')}</div><div class="rule-flow">${flowText(r.definition)}</div>${r.orphaned ? `<div class="rule-warn">${esc(T('smarthome.rules.orphaned_warn'))}</div>` : ''}</div>`;
    const acts = document.createElement('div'); acts.className = 'rule-acts';
    if (!r.orphaned) {
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-sm btn-ghost'; edit.textContent = T('smarthome.rules.edit');
      edit.addEventListener('click', () => openBuilder(r)); acts.appendChild(edit);
    }
    const del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn-sm btn-ghost'; del.textContent = T('smarthome.rules.delete');
    del.addEventListener('click', () => deleteRule(r)); acts.appendChild(del);
    el.appendChild(acts);
    const tog = document.createElement('div'); tog.className = 'sh-switch' + (r.enabled ? ' on' : ''); tog.appendChild(document.createElement('i'));
    if (r.orphaned) { tog.style.opacity = '.4'; tog.style.pointerEvents = 'none'; } else tog.addEventListener('click', () => toggleRule(r, tog));
    el.appendChild(tog);
    return el;
  }

  function showLimit(msg) { const b = $('#shr-limit'); if (!b) return; if (msg) { b.textContent = msg; b.style.display = ''; } else { b.style.display = 'none'; } }

  function emptyMsg(list, txt) { list.replaceChildren(); const em = document.createElement('div'); em.className = 'sh-empty'; em.textContent = txt; list.appendChild(em); }

  async function loadRules() {
    const list = $('#shr-list'); if (!list) return;
    if (!gatewayId) {
      const gw = await api('/gateways').catch(() => ({ gateways: [] }));
      const g = (gw.gateways || []).find((x) => x.enabled) || (gw.gateways || [])[0];
      gatewayId = g ? g.id : null;
    }
    if (!gatewayId) { emptyMsg(list, T('smarthome.empty')); return; }
    // Resources power both the card name lookup and the builder dropdowns.
    try { const rd = await api(`/resources?gateway_id=${gatewayId}`); resources = rd.resources || []; }
    catch (_) { resources = []; }
    resById = {}; resources.forEach((r) => { resById[r.id] = r; });
    let data;
    try { data = await api(`/rules?gateway_id=${gatewayId}`); }
    catch (_) { emptyMsg(list, T('smarthome.load_error')); return; }
    cancelSupported = data.cancelSupported !== false;
    showLimit(data.limit_warn ? T('smarthome.rules.limit_warn') : null);
    if (!data.rules.length) { emptyMsg(list, T('smarthome.rules.empty')); return; }
    list.replaceChildren();
    data.rules.forEach((r) => list.appendChild(ruleCard(r)));
  }

  async function toggleRule(r, el) {
    const on = !r.enabled;
    try { await api(`/rules/${r.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: on }) }); r.enabled = on; el.classList.toggle('on', on); }
    catch (e) { alert(e.message); }
  }
  async function deleteRule(r) {
    if (!confirm(T('smarthome.rules.confirm_delete'))) return;
    try { await api(`/rules/${r.id}`, { method: 'DELETE' }); await loadRules(); }
    catch (e) { alert(e.message); }
  }

  // ── Builder ─────────────────────────────────────────────────────────────
  function makeSelect(cls, opts) {
    const s = document.createElement('select'); s.className = 'form-select ' + cls;
    opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; s.appendChild(o); });
    return s;
  }
  function makeNum(cls, ph) { const i = document.createElement('input'); i.type = 'number'; i.className = 'form-input ' + cls; if (ph) i.placeholder = ph; return i; }

  function renderTriggerFields(fields, r) {
    fields.replaceChildren(); if (!r) return;
    const type = trigType(r);
    if (type === 'motion') fields.appendChild(makeSelect('shr-f-event', [['detected', T('smarthome.val.motion')], ['ended', T('smarthome.val.idle')]]));
    else if (type === 'contact') fields.appendChild(makeSelect('shr-f-event', [['open', T('smarthome.val.open')], ['closed', T('smarthome.val.closed')]]));
    else if (type === 'water') fields.appendChild(makeSelect('shr-f-event', [['wet', T('smarthome.val.wet')], ['dry', T('smarthome.val.dry')]]));
    else if (type === 'temperature' || type === 'lux') {
      fields.appendChild(makeSelect('shr-f-op', [['lt', T('smarthome.rules.op_lt')], ['gt', T('smarthome.rules.op_gt')]]));
      fields.appendChild(makeNum('shr-f-val', type === 'temperature' ? '°C' : 'lx'));
    } else if (type === 'button') {
      fields.appendChild(makeSelect('shr-f-btn', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]));
      fields.appendChild(makeSelect('shr-f-act', [['short', T('smarthome.rules.btn_short')], ['long', T('smarthome.rules.btn_long')], ['double', T('smarthome.rules.btn_double')]]));
    }
  }
  function renderActionFields(fields, r) {
    fields.replaceChildren(); if (!r || r.kind === 'scene') return;
    const caps = r.capabilities || {};
    const opts = [['on', T('smarthome.rules.act_on')], ['off', T('smarthome.rules.act_off')]];
    if (caps.bri) opts.push(['bri', T('smarthome.brightness')]);
    if (caps.color) opts.push(['color', T('smarthome.color')]);
    const op = makeSelect('shr-f-aop', opts); fields.appendChild(op);
    const extra = document.createElement('span'); extra.className = 'shr-extra'; fields.appendChild(extra);
    function renderExtra() {
      extra.replaceChildren();
      if (op.value === 'bri') { const b = makeNum('shr-f-bri', '%'); b.min = 0; b.max = 100; b.value = 100; extra.appendChild(b); }
      else if (op.value === 'color') {
        if (caps.color === 'ct') { const n = makeNum('shr-f-ct', 'ct'); n.min = 153; n.max = 500; n.value = 300; extra.appendChild(n); }
        else { const c = document.createElement('input'); c.type = 'color'; c.className = 'shr-f-color'; c.value = '#ffd27a'; extra.appendChild(c); }
      }
    }
    op.addEventListener('change', renderExtra); renderExtra();
  }

  function rowSelect(resList) {
    const sel = document.createElement('select'); sel.className = 'form-select shr-res';
    resList.forEach((r) => { const o = document.createElement('option'); o.value = String(r.id); o.textContent = r.name || ('#' + r.id); sel.appendChild(o); });
    return sel;
  }
  function removeBtn(row, after) {
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'row-x'; rm.textContent = '×'; rm.title = T('smarthome.rules.delete');
    rm.addEventListener('click', () => { row.remove(); if (after) after(); });
    return rm;
  }

  function addTriggerRow(pre) {
    const list = $('#shr-when'); const sel = rowSelect(triggerResources());
    const row = document.createElement('div'); row.className = 'shr-row';
    const fields = document.createElement('div'); fields.className = 'shr-fields';
    row.appendChild(sel); row.appendChild(fields); row.appendChild(removeBtn(row, updateMultiHint));
    const setRes = () => { row._res = resById[Number(sel.value)]; renderTriggerFields(fields, row._res); updateMultiHint(); };
    sel.addEventListener('change', setRes);
    if (pre && pre.resourceId != null) sel.value = String(pre.resourceId);
    list.appendChild(row); setRes();
    if (pre) { const set = (c, v) => { const el = fields.querySelector('.' + c); if (el && v != null) el.value = String(v); }; set('shr-f-event', pre.event); set('shr-f-op', pre.op); set('shr-f-val', pre.value); set('shr-f-btn', pre.button); set('shr-f-act', pre.action); }
  }
  function addActionRow(pre) {
    const list = $('#shr-then'); const sel = rowSelect(actionResources());
    const row = document.createElement('div'); row.className = 'shr-row';
    const fields = document.createElement('div'); fields.className = 'shr-fields';
    row.appendChild(sel); row.appendChild(fields); row.appendChild(removeBtn(row));
    const setRes = () => { row._res = resById[Number(sel.value)]; renderActionFields(fields, row._res); };
    sel.addEventListener('change', setRes);
    if (pre && pre.resourceId != null) sel.value = String(pre.resourceId);
    list.appendChild(row); setRes();
    if (pre && pre.set) {
      const op = fields.querySelector('.shr-f-aop');
      if (op) {
        const s = pre.set; let v = 'on';
        if ('bri' in s) v = 'bri'; else if ('color' in s) v = 'color'; else if (s.on === false) v = 'off';
        op.value = v; op.dispatchEvent(new Event('change'));
        if (v === 'bri') { const b = fields.querySelector('.shr-f-bri'); if (b) b.value = s.bri; }
        else if (v === 'color' && s.color && s.color.ct != null) { const ct = fields.querySelector('.shr-f-ct'); if (ct) ct.value = s.color.ct; }
      }
    }
  }

  function updateMultiHint() {
    const n = $$('#shr-when .shr-row').filter((row) => EVENT_KINDS.includes(trigType(row._res))).length;
    const h = $('#shr-multi-hint'); if (h) h.style.display = n > 1 ? '' : 'none';
  }

  // deCONZ firmware without cancel-support downgrades to reset server-side; disable + hint the option.
  function applyCancelSupport() {
    const sel = $('#shr-onretrigger'); if (!sel) return;
    const opt = sel.querySelector('option[value="cancel"]'); if (!opt) return;
    opt.disabled = !cancelSupported;
    opt.title = cancelSupported ? '' : T('smarthome.rules.cancel_unsupported_hint');
    if (!cancelSupported && sel.value === 'cancel') sel.value = 'reset';
  }

  function openBuilder(rule) {
    editingId = rule ? rule.id : null;
    $('#shr-name').value = rule ? (rule.name || '') : '';
    $('#shr-from').value = ''; $('#shr-to').value = ''; $('#shr-delay-min').value = ''; $('#shr-onretrigger').value = 'ignore';
    $('#shr-when').replaceChildren(); $('#shr-then').replaceChildren();
    applyCancelSupport();
    const def = rule && rule.definition;
    if (def) {
      (def.triggers || []).forEach((t) => addTriggerRow(t));
      (def.actions || []).forEach((a) => addActionRow(a));
      if (def.timeWindow) { $('#shr-from').value = def.timeWindow.from || ''; $('#shr-to').value = def.timeWindow.to || ''; }
      if (def.delay) { $('#shr-delay-min').value = def.delay.minutes || ''; $('#shr-onretrigger').value = def.delay.onRetrigger || 'ignore'; }
    } else { addTriggerRow(); addActionRow(); }
    applyCancelSupport();
    updateMultiHint();
    const m = $('#shr-modal'); if (m) m.style.display = 'flex';
  }
  function closeBuilder() { const m = $('#shr-modal'); if (m) m.style.display = 'none'; }

  function readTrigger(row) {
    const r = row._res; if (!r) return null; const type = trigType(r);
    const g = (c) => row.querySelector('.' + c);
    if (type === 'motion' || type === 'contact' || type === 'water') return { kind: type, resourceId: r.id, event: g('shr-f-event').value };
    if (type === 'temperature' || type === 'lux') return { kind: type, resourceId: r.id, op: g('shr-f-op').value, value: Number(g('shr-f-val').value) };
    if (type === 'button') return { kind: 'button', resourceId: r.id, button: Number(g('shr-f-btn').value), action: g('shr-f-act').value };
    return null;
  }
  function readAction(row) {
    const r = row._res; if (!r) return null;
    if (r.kind === 'scene') return { kind: 'scene', resourceId: r.id };
    const opEl = row.querySelector('.shr-f-aop'); const op = opEl ? opEl.value : 'on';
    const a = { kind: r.kind, resourceId: r.id, set: {} };
    if (op === 'on') a.set.on = true;
    else if (op === 'off') a.set.on = false;
    else if (op === 'bri') a.set.bri = Number(row.querySelector('.shr-f-bri').value);
    else if (op === 'color') {
      const caps = r.capabilities || {};
      if (caps.color === 'ct') a.set.color = { ct: Number(row.querySelector('.shr-f-ct').value) };
      else a.set.color = { xy: hexToXy(row.querySelector('.shr-f-color').value) };
    }
    return a;
  }
  function buildDefinition() {
    const def = { triggers: [], actions: [] };
    $$('#shr-when .shr-row').forEach((row) => { const t = readTrigger(row); if (t) def.triggers.push(t); });
    $$('#shr-then .shr-row').forEach((row) => { const a = readAction(row); if (a) def.actions.push(a); });
    const from = $('#shr-from').value, to = $('#shr-to').value;
    if (from && to) def.timeWindow = { from, to };
    const mins = parseInt($('#shr-delay-min').value, 10);
    if (mins > 0) def.delay = { minutes: mins, onRetrigger: $('#shr-onretrigger').value };
    return def;
  }
  async function saveRule() {
    const name = $('#shr-name').value.trim();
    if (!name) { alert(T('smarthome.rules.name_required')); return; }
    const definition = buildDefinition();
    try {
      if (editingId) await api(`/rules/${editingId}`, { method: 'PUT', body: JSON.stringify({ name, definition }) });
      else await api('/rules', { method: 'POST', body: JSON.stringify({ gateway_id: gatewayId, name, definition }) });
      closeBuilder(); await loadRules();
    } catch (e) {
      if (e.status === 409) { showLimit(e.message); return; } // rule-limit / no-api-key → banner only
      alert(e.message); // 400 = validation detail from the server
    }
  }

  // Gateway-wide rule count (GC vs external) shown in an inline hint.
  function countHint() {
    let el = $('#shr-count-hint');
    if (!el) { el = document.createElement('div'); el.id = 'shr-count-hint'; el.className = 'banner'; const list = $('#shr-list'); if (list && list.parentNode) list.parentNode.insertBefore(el, list); }
    return el;
  }
  async function loadCount() {
    if (!gatewayId) return;
    try {
      const d = await api(`/rules/gateway-count?gateway_id=${gatewayId}`);
      const el = countHint();
      el.textContent = `${T('smarthome.rules.count_total')}: ${d.total_rules} · ${T('smarthome.rules.count_gc')}: ${d.gc_rules} · ${T('smarthome.rules.count_external')}: ${d.external_rules}`;
      el.style.display = '';
    } catch (e) { alert(e.message); }
  }

  function wire() {
    const nw = $('#shr-new'); if (nw) nw.addEventListener('click', () => openBuilder(null));
    const save = $('#shr-save'); if (save) save.addEventListener('click', saveRule);
    const addW = $('#shr-add-when'); if (addW) addW.addEventListener('click', () => addTriggerRow());
    const addT = $('#shr-add-then'); if (addT) addT.addEventListener('click', () => addActionRow());
    const cnt = $('#shr-gateway-count'); if (cnt) cnt.addEventListener('click', loadCount);
    $$('[data-shr-close]').forEach((el) => el.addEventListener('click', closeBuilder));
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); loadRules(); });
  window.SmartHomeRules = { loadRules, api };
})();
