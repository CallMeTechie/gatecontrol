'use strict';

// Settings page (templates/aurora/pages/settings.njk).
//
// Structure: 22 sections (<section data-section>), one visible at a time,
// chosen in the grouped nav (a select at ≤ 900 px) and kept in the address:
// /settings#<section>; old tab names, old element ids and ?tab= still work
// (GCSettingsUI.resolveLocation).
//
// Save model: every input with data-st-field belongs to its section. Each
// section has a load() that fills the fields and records their saved values,
// and save groups — { fields, save(values, dirty) } — that talk to the
// existing endpoints. A change shows the sticky save bar ("N ungespeicherte
// Änderungen · Verwerfen · Speichern"); Speichern runs the groups with dirty
// fields, field errors (400 { fields }) appear next to the inputs. Leaving a
// section or the page with unsaved changes asks first. Immediate actions
// (test, restart, upload, list items, dialogs) stay buttons.
//
// DOM is built with GCDialog.el / textContent only — never innerHTML.
(function () {
  const page = document.getElementById('st-page');
  if (!page) return;
  const U = window.GCSettingsUI;
  const D = window.GCDialog;
  const O = window.GCOpsUI;
  const TG = window.GCTlsUI || null;
  const api = window.api;
  const lang = (window.GC && window.GC.language) || undefined;

  // ── Strings: the page island merges into GC.t (ops-ui / client-policy-form read it there) ──
  window.GC = window.GC || {};
  window.GC.t = window.GC.t || {};
  try { Object.assign(window.GC.t, JSON.parse(document.getElementById('st-i18n').textContent || '{}')); } catch (_) { /* keys stay visible */ }
  function t(key, params) { return U.fmt(window.GC.t[key] != null ? window.GC.t[key] : key, params); }
  function tp(key, n, params) { return t(key + (Number(n) === 1 ? '_one' : '_other'), Object.assign({ n }, params || {})); }

  let FEATURES = {};
  try { FEATURES = JSON.parse(page.dataset.features || '{}'); } catch (_) { FEATURES = {}; }
  let CATALOGUE = [];
  try { CATALOGUE = JSON.parse(document.getElementById('st-catalogue').textContent || '[]'); } catch (_) { CATALOGUE = []; }

  // ── Small helpers ──
  const $ = (id) => document.getElementById(id);
  const el = D.el;
  const NS = 'http://www.w3.org/2000/svg';
  function icon(d, size) {
    const svg = document.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', String(size || 15)], ['height', String(size || 15)], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }
  const ICON_TRASH = 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3';
  function call(p) {
    return Promise.resolve(p).then((r) => r || { ok: false }, (e) => (e && e.data) || { ok: false, error: (e && e.message) || t('st.err.generic') });
  }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }
  function errText(r) {
    if (r && r.feature) return t('st.err.license');
    return (r && r.error) || t('st.err.generic');
  }
  function pill(state, text) { return el('span', { class: 'st-pill', 'data-state': state, text }); }
  function busy(btn, on) { if (!btn) return; if (on) window.btnLoading(btn); else window.btnReset(btn); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function empty(text) { return el('li', { class: 'st-empty', text }); }
  function copyText(text) {
    const done = () => toast(t('st.copied'));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => { if (fallbackCopy(text)) done(); });
    } else if (fallbackCopy(text)) done();
  }
  function fallbackCopy(text) {
    const ta = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
  function fmtTime(d) {
    try { return new Date(d).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
  }

  // ══ Fields ════════════════════════════════════════════════════════════
  const CUSTOM = {}; // field name → { get(), set(v) }
  function sectionEl(id) { return document.querySelector('.st-section[data-section="' + id + '"]'); }
  function fieldEls(id) {
    const root = sectionEl(id);
    return root ? Array.from(root.querySelectorAll('[data-st-field]')) : [];
  }
  function fieldEl(id, name) {
    const root = sectionEl(id);
    return root ? root.querySelector('[data-st-field="' + name + '"]') : null;
  }
  function getField(node) {
    const name = node.dataset.stField;
    if (CUSTOM[name]) return CUSTOM[name].get();
    if (node.getAttribute('role') === 'switch') return node.getAttribute('aria-checked') === 'true';
    if (node.classList.contains('st-seg')) return node.dataset.value || '';
    if (node.type === 'checkbox') return node.checked;
    return node.value;
  }
  function setField(node, v) {
    const name = node.dataset.stField;
    if (CUSTOM[name]) { CUSTOM[name].set(v); return; }
    if (node.getAttribute('role') === 'switch') { node.setAttribute('aria-checked', v ? 'true' : 'false'); return; }
    if (node.classList.contains('st-seg')) { setSeg(node, v == null ? '' : String(v)); return; }
    if (node.type === 'checkbox') { node.checked = !!v; return; }
    node.value = v == null ? '' : String(v);
    if (node.type === 'range') syncRange(node);
  }
  function setSeg(node, v) {
    node.dataset.value = v;
    node.querySelectorAll('.st-seg-btn').forEach((b) => b.setAttribute('aria-pressed', b.dataset.value === v ? 'true' : 'false'));
  }
  function syncRange(node) {
    const out = document.querySelector('output[for="' + node.id + '"]');
    if (out) out.textContent = node.value + ' s';
  }
  function valuesOf(id) {
    const out = {};
    fieldEls(id).forEach((n) => { out[n.dataset.stField] = getField(n); });
    return out;
  }

  // Per section: saved values (baseline) and whether it was loaded.
  const baseline = {};
  /** Set fields from `vals` ({ field: value }) and record them as saved. */
  function fill(id, vals) {
    baseline[id] = baseline[id] || {};
    for (const [name, v] of Object.entries(vals)) {
      const node = fieldEl(id, name);
      if (!node) continue;
      setField(node, v);
      baseline[id][name] = getField(node);
    }
    applyShows(id);
  }
  /** Mark fields as saved with their current values. */
  function commit(id, names) {
    baseline[id] = baseline[id] || {};
    const cur = valuesOf(id);
    (names || Object.keys(cur)).forEach((n) => { if (n in cur) baseline[id][n] = cur[n]; });
  }
  function dirtyOf(id) { return U.dirtyFields(baseline[id] || {}, valuesOf(id)); }

  // data-st-show="field=value" / "field!=value": rows that only matter for one choice.
  function applyShows(id) {
    const root = sectionEl(id);
    if (!root) return;
    const vals = valuesOf(id);
    root.querySelectorAll('[data-st-show]').forEach((n) => {
      const m = /^([\w-]+)(!?=)(.*)$/.exec(n.dataset.stShow);
      if (!m) return;
      const v = U.valueKey(vals[m[1]]);
      n.hidden = m[2] === '=' ? v !== m[3] : v === m[3];
    });
  }

  // Field errors
  function errNode(node) {
    if (!node) return null;
    return $(node.id + '-err') || (node.closest('.st-row') && node.closest('.st-row').querySelector('.st-err')) || null;
  }
  function showFieldError(id, name, msg) {
    const node = fieldEl(id, name);
    const e = errNode(node);
    if (node && node.setAttribute) node.setAttribute('aria-invalid', 'true');
    if (e) { e.textContent = msg; e.hidden = false; return true; }
    return false;
  }
  function clearErrors(id) {
    const root = sectionEl(id);
    if (!root) return;
    root.querySelectorAll('[aria-invalid="true"]').forEach((n) => n.removeAttribute('aria-invalid'));
    root.querySelectorAll('.st-err').forEach((n) => { n.textContent = ''; n.hidden = true; });
    $('st-savebar-err').hidden = true;
  }

  // Controls: switches and segments change on click.
  document.addEventListener('click', (e) => {
    const sw = e.target.closest('.st-switch');
    if (sw && !sw.disabled && page.contains(sw)) {
      sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      sw.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const sb = e.target.closest('.st-seg-btn');
    if (sb && !sb.disabled && page.contains(sb)) {
      const seg = sb.closest('.st-seg');
      if (seg.dataset.value === sb.dataset.value) return;
      setSeg(seg, sb.dataset.value);
      seg.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  page.addEventListener('input', (e) => {
    if (e.target.type === 'range') syncRange(e.target);
    onFieldChange(e);
  });
  page.addEventListener('change', onFieldChange);
  function onFieldChange(e) {
    const sec = e.target.closest && e.target.closest('.st-section');
    if (!sec || sec.dataset.section !== current) return;
    applyShows(current);
    const field = e.target.closest('[data-st-field]');
    if (field) {
      field.removeAttribute('aria-invalid');
      const er = errNode(field);
      if (er && er.textContent) { er.textContent = ''; er.hidden = true; }
    }
    const s = SECTIONS[current];
    if (s && s.onChange) s.onChange(e);
    updateBar();
  }

  // ══ Save bar ══════════════════════════════════════════════════════════
  const bar = $('st-savebar');
  const barText = $('st-savebar-text');
  const barErr = $('st-savebar-err');
  const savedLine = $('st-saved');
  let lastSaved = null;
  let saving = false;
  function updateBar() {
    const n = current ? dirtyOf(current).length : 0;
    bar.hidden = n === 0;
    if (n) barText.textContent = tp('st.save.count', n);
    savedLine.textContent = !n && lastSaved ? t('st.save.saved_at', { time: fmtTime(lastSaved) }) : '';
  }
  $('st-discard').addEventListener('click', () => discard());
  $('st-save').addEventListener('click', () => save());

  function discard() {
    if (!current) return;
    const id = current;
    clearErrors(id);
    const b = baseline[id] || {};
    fieldEls(id).forEach((n) => { if (n.dataset.stField in b) setField(n, b[n.dataset.stField]); });
    applyShows(id);
    const s = SECTIONS[id];
    if (s && s.onDiscard) s.onDiscard();
    updateBar();
  }

  /** Client-side checks: numbers within min/max of their input. */
  function validate(id, dirty) {
    let ok = true;
    for (const name of dirty) {
      const node = fieldEl(id, name);
      if (!node || (node.type !== 'number' && node.type !== 'range')) continue;
      const bad = U.checkNumber(node.value, Number(node.min), Number(node.max));
      if (bad) { showFieldError(id, name, t('st.err.range', bad)); ok = false; }
    }
    const s = SECTIONS[id];
    const loose = [];
    if (s.validate) {
      const errs = s.validate(valuesOf(id), dirty) || {};
      for (const [name, msg] of Object.entries(errs)) { if (!showFieldError(id, name, msg)) loose.push(msg); ok = false; }
    }
    if (loose.length) { barErr.textContent = loose.join(' · '); barErr.hidden = false; }
    return ok;
  }

  async function save() {
    if (!current || saving) return false;
    const id = current;
    const s = SECTIONS[id];
    const dirty = dirtyOf(id);
    if (!dirty.length) return true;
    clearErrors(id);
    if (!validate(id, dirty)) { focusFirstError(id); return false; }
    const vals = valuesOf(id);
    const plan = U.savePlan(s.groups || [], dirty);
    for (const g of plan) {
      const asks = g.confirm ? [].concat(g.confirm(vals, dirty) || []) : [];
      for (const a of asks) if (!(await D.confirm(a))) return false;
    }
    saving = true;
    const btn = $('st-save');
    busy(btn, true);
    let allOk = true;
    const messages = [];
    try {
      for (const g of plan) {
        const r = await call(g.save(vals, dirty));
        if (r && r.ok) {
          commit(id, g.fields);
          if (r.warning) messages.push(r.warning);
          if (g.after) await g.after(r);
          continue;
        }
        allOk = false;
        let shown = false;
        if (r && r.fields) {
          for (const [k, msg] of Object.entries(r.fields)) {
            const name = (g.map && g.map[k]) || k;
            if (showFieldError(id, name, msg)) shown = true;
          }
        }
        if (!shown && g.errorField && !(r && r.feature)) shown = showFieldError(id, g.errorField, errText(r));
        if (!shown) messages.push(errText(r));
      }
    } finally {
      busy(btn, false);
      saving = false;
    }
    if (messages.length) { barErr.textContent = messages.join(' · '); barErr.hidden = false; }
    if (allOk) {
      lastSaved = new Date();
      if (!messages.length) toast(t('st.save.done'));
    } else {
      focusFirstError(id);
    }
    updateBar();
    if (allOk && messages.length) { bar.hidden = false; barText.textContent = t('st.save.saved_with_note'); }
    return allOk;
  }
  function focusFirstError(id) {
    const root = sectionEl(id);
    const bad = root && root.querySelector('[aria-invalid="true"]');
    if (bad && bad.focus) bad.focus();
  }

  window.addEventListener('beforeunload', (e) => {
    if (current && dirtyOf(current).length) { e.preventDefault(); e.returnValue = ''; }
  });

  // ══ Navigation ════════════════════════════════════════════════════════
  const SECTIONS = {};
  // Sections with their own script (loaded before this one), e.g. Plugins
  // (settings-plugins.js): { load() }.
  Object.assign(SECTIONS, window.GCSettingsExt || {});
  const navItems = Array.from(document.querySelectorAll('.st-nav-item'));
  const select = $('st-select');
  const known = navItems.map((b) => b.dataset.section);
  let current = null;
  const loaded = {};

  function sectionOfElement(elId) {
    const node = document.getElementById(elId);
    const sec = node && node.closest && node.closest('.st-section');
    return sec ? sec.dataset.section : null;
  }

  async function show(id, opts) {
    const o = opts || {};
    if (!known.includes(id)) id = known[0];
    if (current && id !== current && dirtyOf(current).length && !o.force) {
      const n = dirtyOf(current).length;
      const ok = await D.confirm({
        title: t('st.leave.title'),
        message: tp('st.leave.message', n, { section: navLabel(current) }),
        okLabel: t('st.leave.discard'),
        danger: true,
      });
      if (!ok) {
        syncNav();
        try { history.replaceState(null, '', location.pathname + '#' + current); } catch (_) { /* cosmetic */ }
        return false;
      }
      discard();
    }
    if (current !== id) {
      document.querySelectorAll('.st-section').forEach((s) => { s.hidden = s.dataset.section !== id; });
      current = id;
      barErr.hidden = true;
      try { localStorage.setItem('gc-settings-section', id); } catch (_) { /* optional */ }
      applySearchToSection();
    }
    syncNav();
    const target = o.anchor ? document.getElementById(o.anchor) : null;
    const hash = '#' + (o.anchor || id);
    if (location.hash !== hash || /[?&]tab=/.test(location.search)) {
      try { history.replaceState(null, '', location.pathname + hash); } catch (_) { /* cosmetic */ }
    }
    const s = SECTIONS[id];
    if (s && s.load && !(o.keep && loaded[id])) {
      try { await s.load(); } catch (err) { console.warn('[settings] loading', id, err); }
      loaded[id] = true;
      applyShows(id);
    }
    updateBar();
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
    else if (o.focus) { const h = $('st-h-' + id); if (h) h.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
    return true;
  }
  function navLabel(id) {
    const b = navItems.find((x) => x.dataset.section === id);
    return b ? b.querySelector('.st-nav-label').textContent : id;
  }
  function syncNav() {
    navItems.forEach((b) => b.setAttribute('aria-current', b.dataset.section === current ? 'page' : 'false'));
    if (select) select.value = current;
  }
  navItems.forEach((b) => b.addEventListener('click', () => show(b.dataset.section, { focus: true })));
  if (select) select.addEventListener('change', () => show(select.value, { focus: true }));
  window.addEventListener('hashchange', () => {
    const r = U.resolveLocation({ hash: location.hash, search: '' }, { known, sectionOfElement });
    if (r) show(r.section, { anchor: r.anchor, keep: r.section === current });
  });
  function setDot(id, on) {
    const b = navItems.find((x) => x.dataset.section === id);
    const dot = b && b.querySelector('[data-dot]');
    if (dot) dot.hidden = !on;
  }

  // ── Search ──
  const search = $('st-search');
  const searchCount = $('st-search-count');
  let query = '';
  function sectionText(id) {
    const sec = sectionEl(id);
    return [navLabel(id), sec ? sec.dataset.stKeywords : '', sec ? sec.textContent : ''].join(' ');
  }
  function runSearch() {
    query = search.value;
    let shown = 0;
    navItems.forEach((b) => {
      const hit = U.matches(sectionText(b.dataset.section), query);
      b.parentElement.hidden = !hit;
      if (hit) shown++;
    });
    document.querySelectorAll('.st-nav-group').forEach((g) => {
      g.hidden = !g.querySelector('li:not([hidden])');
    });
    if (select) Array.from(select.options).forEach((o) => { o.hidden = !U.matches(sectionText(o.value), query); });
    $('st-nav-empty').hidden = shown > 0;
    searchCount.textContent = query.trim() ? tp('st.search_count', shown) : '';
    applySearchToSection();
  }
  function applySearchToSection() {
    const sec = current && sectionEl(current);
    if (!sec) return;
    const head = [navLabel(current), sec.dataset.stKeywords, (sec.querySelector('.st-sec-head') || {}).textContent].join(' ');
    const whole = !query.trim() || U.matches(head, query);
    sec.querySelectorAll(':scope > .st-card').forEach((c) => { c.classList.toggle('st-search-miss', !whole && !U.matches(c.textContent, query)); });
  }
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; runSearch(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const first = navItems.find((b) => !b.parentElement.hidden);
      if (first) show(first.dataset.section, { focus: true });
    }
  });

  // Copy buttons of read-only rows.
  page.addEventListener('click', (e) => {
    const c = e.target.closest('[data-st-copy]');
    if (c) { const v = $(c.dataset.stCopy); if (v) copyText(v.textContent.trim()); }
  });

  // Shared action: clear the activity log (Daten + Gefahrenzone).
  document.querySelectorAll('[data-st-action="clear-logs"]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await D.confirm({ title: t('st.cleanup.confirm_title'), message: t('st.cleanup.confirm'), okLabel: t('st.cleanup.confirm_ok'), danger: true }))) return;
    busy(b, true);
    const r = await call(api.post('/api/v1/settings/clear-logs', {}));
    busy(b, false);
    if (r.ok) toast(t('st.cleanup.done', { n: r.deleted || 0 }));
    else toast(errText(r), 'error');
  }));

  // ══ Sections ══════════════════════════════════════════════════════════
  const get = (url) => call(api.get(url));
  const put = (url, body) => call(api.put(url, body));
  const post = (url, body) => call(api.post(url, body || {}));
  const del = (url) => call(api.del(url));
  const int = (v) => parseInt(v, 10);

  // ── Übersicht ──
  SECTIONS.uebersicht = {
    async load() {
      const wgDetail = $('st-svc-wg-detail');
      if (!wgDetail.dataset.base) wgDetail.dataset.base = wgDetail.textContent;
      const [wg, caddy] = await Promise.all([get('/api/v1/wg/status'), get('/api/v1/caddy/status')]);
      const wgOk = !!(wg && wg.running);
      setService('st-svc-wg', wg && wg.ok !== false ? (wgOk ? 'good' : 'crit') : 'warn');
      const online = wg && Array.isArray(wg.peers) ? wg.peers.filter((p) => p.isOnline).length : null;
      wgDetail.textContent = wgDetail.dataset.base + (online != null && wgOk ? ' · ' + tp('st.services.wg_peers', online) : '');
      const cOk = !!(caddy && caddy.running);
      setService('st-svc-caddy', caddy && caddy.ok !== false ? (cOk ? 'good' : 'crit') : 'warn');
      $('st-svc-caddy-detail').textContent = cOk
        ? t('st.services.caddy_detail', { http: caddy.httpRoutes || 0, l4: caddy.l4Routes || 0 })
        : '';
    },
  };
  function setService(id, state) {
    const tile = $(id);
    tile.dataset.state = state;
    $(id + '-state').dataset.state = state;
    $(id + '-state').textContent = t(state === 'good' ? 'st.services.running' : state === 'crit' ? 'st.services.stopped' : 'st.services.unknown');
  }
  $('st-wg-restart').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!(await D.confirm({ title: t('st.services.wg_restart_title'), message: t('settings.svc.wg_restart_confirm'), okLabel: t('st.services.wg_restart_ok') }))) return;
    busy(b, true);
    const r = await post('/api/v1/wg/restart');
    busy(b, false);
    if (r.ok && r.success) { toast(t('st.services.wg_restarted')); SECTIONS.uebersicht.load(); } else toast(r.ok ? t('settings.svc.wg_restart_failed') : errText(r), 'error');
  });
  $('st-caddy-reload').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    const r = await post('/api/v1/caddy/reload');
    busy(b, false);
    if (r.ok && r.success) { toast(t('st.services.caddy_reloaded')); SECTIONS.uebersicht.load(); } else toast(errText(r), 'error');
  });

  // ── Domains & Zertifikate ──
  const domList = $('st-dom-list');
  function domainRow(d) {
    const state = d.status === 'verified' ? 'good' : d.status === 'failed' ? 'crit' : 'warn';
    const label = t(d.status === 'verified' ? 'st.domains.verified' : d.status === 'failed' ? 'st.domains.failed' : 'st.domains.pending');
    const check = TG ? TG.parseCheck(d.check_json) : null;
    const code = TG ? TG.dnsCode(d) : null;
    let detail;
    if (d.status === 'failed') detail = code && TG ? TG.dnsCodeText(code) : (d.last_error || '');
    else if (d.status === 'verified') detail = d.verified_at ? t('st.domains.verified_at', { when: O.fmtAgo(d.verified_at, lang) || O.fmtDateTime(d.verified_at, lang) }) : '';
    else detail = t('st.domains.unchecked');
    const info = el('div', { class: 'st-li-main' }, [
      el('div', { class: 'st-li-title st-mono', text: d.domain }),
      detail ? el('div', { class: 'st-li-sub', text: detail }) : null,
      check && check.detail && d.status === 'failed' ? el('div', { class: 'st-li-sub st-mono', text: String(check.detail) }) : null,
    ]);
    if (check && TG) {
      const box = TG.recordsEl(check);
      box.hidden = true;
      const tg = el('button', { type: 'button', class: 'st-link-btn', 'aria-expanded': 'false', text: t('settings.tls.records_show') });
      tg.addEventListener('click', () => { box.hidden = !box.hidden; tg.setAttribute('aria-expanded', box.hidden ? 'false' : 'true'); });
      info.appendChild(el('div', { class: 'st-li-extra' }, [tg, box]));
      const caa = TG.caaEl ? TG.caaEl(check, { compact: true }) : null;
      if (caa) info.appendChild(caa);
    }
    const verify = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('st.domains.recheck') });
    verify.addEventListener('click', async () => {
      busy(verify, true);
      const r = await post('/api/v1/settings/domains/' + d.id + '/verify');
      busy(verify, false);
      if (r.ok) SECTIONS.domains.loadList(); else toast(errText(r), 'error');
    });
    const remove = el('button', { type: 'button', class: 'st-icon-btn', 'aria-label': t('st.domains.remove_label', { domain: d.domain }), title: t('st.domains.remove_label', { domain: d.domain }) }, [icon(ICON_TRASH)]);
    remove.addEventListener('click', async () => {
      if (!(await D.confirm({ title: t('st.domains.remove_title'), message: t('st.domains.remove_msg', { domain: d.domain }), okLabel: t('st.remove'), danger: true }))) return;
      const r = await del('/api/v1/settings/domains/' + d.id);
      if (r.ok) SECTIONS.domains.loadList(); else toast(errText(r), 'error');
    });
    return el('li', { class: 'st-li', 'data-domain': d.domain }, [info, pill(state, label), el('div', { class: 'st-li-actions' }, [verify, remove])]);
  }
  SECTIONS.domains = {
    async loadList() {
      const r = await get('/api/v1/settings/domains');
      if (!r.ok) { clear(domList); domList.appendChild(empty(errText(r))); return r; }
      const list = r.data.domains || [];
      clear(domList);
      if (!list.length) domList.appendChild(empty(t('st.domains.none')));
      list.forEach((d) => domList.appendChild(domainRow(d)));
      $('st-r-ip4').textContent = r.data.serverIp || '—';
      $('st-r-ip6').textContent = r.data.serverIpv6 || '—';
      $('st-dom-ipwarn').hidden = !r.data.serverIpWarning;
      setDot('domains', list.some((d) => d.status === 'failed') || !!r.data.serverIpWarning);
      return r;
    },
    async load() {
      const [r, acme, tls] = await Promise.all([this.loadList(), get('/api/v1/settings/acme-email'), get('/api/v1/settings/tls')]);
      const vals = {};
      if (r.ok) { vals['srv-ip'] = r.data.serverIpOverride || ''; vals['srv-ip6'] = r.data.serverIpv6Override || ''; }
      if (acme.ok) {
        vals['acme-email'] = acme.data.email;
        $('st-acme').placeholder = acme.data.inherited ? t('st.acme.email_ph_env') : t('st.acme.email_ph');
      }
      if (tls.ok) vals['tls-attempts'] = tls.max_attempts;
      fill('domains', vals);
    },
    groups: [
      { fields: ['srv-ip', 'srv-ip6'], errorField: 'srv-ip',
        save: (v) => api.put('/api/v1/settings/domains/server-ip', { ip: v['srv-ip'].trim(), ipv6: v['srv-ip6'].trim() }),
        after: () => SECTIONS.domains.loadList() },
      { fields: ['acme-email'], errorField: 'acme-email',
        save: (v) => api.put('/api/v1/settings/acme-email', { email: v['acme-email'].trim() })
          .then((r) => (r && r.ok && r.warning ? Object.assign({}, r, { warning: t(r.warning) }) : r)) },
      { fields: ['tls-attempts'], map: { max_attempts: 'tls-attempts' }, errorField: 'tls-attempts',
        save: (v) => api.put('/api/v1/settings/tls', { max_attempts: int(v['tls-attempts']) }) },
    ],
  };
  $('st-dom-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('st-dom-input');
    const err = $('st-dom-add-err');
    err.hidden = true;
    const domain = input.value.trim();
    if (!domain) { input.focus(); return; }
    const b = e.currentTarget.querySelector('button[type="submit"]');
    busy(b, true);
    const r = await post('/api/v1/settings/domains', { domain });
    busy(b, false);
    if (r.ok) { input.value = ''; SECTIONS.domains.loadList(); } else { err.textContent = errText(r); err.hidden = false; input.focus(); }
  });

  // ── VPN & Netzwerk ──
  SECTIONS.netzwerk = {
    async load() {
      const [dns, data, rb] = await Promise.all([get('/api/v1/settings/dns'), get('/api/v1/settings/data'), get('/api/v1/settings/route-block-default')]);
      const vals = {};
      if (dns.ok) vals.dns = dns.data.dns || '';
      if (data.ok) vals['peer-timeout'] = data.data.peer_online_timeout;
      if (rb.ok) { vals['rb-action'] = rb.data.action || 'not_found'; vals['rb-url'] = rb.data.redirect_url || ''; vals['rb-body'] = rb.data.body || ''; }
      fill('netzwerk', vals);
    },
    validate(v, dirty) {
      const errs = {};
      if (dirty.some((d) => d.startsWith('rb-'))) {
        if (v['rb-action'] === 'redirect' && !/^https?:\/\/\S+$/i.test(v['rb-url'].trim())) errs['rb-url'] = t('error.settings.block_redirect_invalid');
        if (v['rb-action'] === 'custom' && !v['rb-body'].trim()) errs['rb-body'] = t('error.settings.block_body_required');
      }
      return errs;
    },
    groups: [
      { fields: ['dns'], map: { dns: 'dns' }, errorField: 'dns', save: (v) => api.put('/api/v1/settings/dns', { dns: v.dns.trim() }) },
      { fields: ['peer-timeout'], map: { peer_online_timeout: 'peer-timeout' }, errorField: 'peer-timeout',
        save: (v) => api.put('/api/v1/settings/data', { peer_online_timeout: v['peer-timeout'] }) },
      { fields: ['rb-action', 'rb-url', 'rb-body'], map: { action: 'rb-action', body: 'rb-body', redirect_url: 'rb-url' },
        save: (v) => api.put('/api/v1/settings/route-block-default', { action: v['rb-action'], body: v['rb-body'], redirect_url: v['rb-url'].trim() }) },
    ],
  };

  // ── Daten & Aufbewahrung ──
  const DATA_MAP = { retention_traffic_days: 'ret-traffic', retention_activity_days: 'ret-activity', retention_waf_days: 'ret-waf' };
  SECTIONS.daten = {
    async load() {
      const r = await get('/api/v1/settings/data');
      if (r.ok) fill('daten', { 'ret-traffic': r.data.retention_traffic_days, 'ret-activity': r.data.retention_activity_days, 'ret-waf': r.data.retention_waf_days });
    },
    groups: [{ fields: Object.values(DATA_MAP), map: DATA_MAP, save: (v, d) => api.put('/api/v1/settings/data', U.pickDirty(DATA_MAP, v, d)) }],
  };

  // ── Anmeldung & Konten ──
  const self2fa = page.dataset.user2fa === '1';
  SECTIONS.anmeldung = {
    timer: null,
    async load() {
      const r = await get('/api/v1/settings/security');
      if (r.ok) {
        const lo = r.data.lockout;
        const pw = r.data.password;
        fill('anmeldung', {
          req2fa: !!r.data.require_2fa, 'lock-on': !!lo.enabled, 'lock-attempts': lo.max_attempts, 'lock-minutes': lo.duration,
          'pw-on': !!pw.complexity_enabled, 'pw-len': pw.min_length, 'pw-upper': !!pw.require_uppercase, 'pw-number': !!pw.require_number, 'pw-special': !!pw.require_special,
        });
      }
      await this.loadLocked();
      clearInterval(this.timer);
      this.timer = setInterval(() => { if (current === 'anmeldung') this.loadLocked(); }, 30000);
    },
    async loadLocked() {
      const box = $('st-locked');
      const r = await get('/api/v1/settings/lockout');
      clear(box);
      const list = (r.ok && r.locked) || [];
      if (!list.length) { box.appendChild(empty(t('security.lockout.no_locked'))); return; }
      list.forEach((acc) => {
        const btn = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('st.lockout.unlock') });
        btn.addEventListener('click', async () => {
          if (!(await D.confirm({ title: t('st.lockout.unlock_title'), message: t('st.lockout.unlock_msg', { name: acc.identifier }), okLabel: t('st.lockout.unlock_ok') }))) return;
          const res = await del('/api/v1/settings/lockout/' + encodeURIComponent(acc.identifier));
          if (res.ok) { toast(t('st.lockout.unlocked', { name: acc.identifier })); this.loadLocked(); } else toast(errText(res), 'error');
        });
        const meta = [t('st.lockout.remaining', { n: Math.max(1, Math.ceil(acc.remainingSeconds / 60)) }), tp('st.lockout.attempts_n', acc.attempts)];
        if (acc.lastIp) meta.push(t('st.lockout.from', { ip: acc.lastIp }));
        box.appendChild(el('li', { class: 'st-chiprow' }, [el('span', { class: 'st-mono st-strong', text: acc.identifier }), el('span', { class: 'st-li-sub', text: meta.join(' · ') }), btn]));
      });
    },
    groups: [{
      fields: ['req2fa', 'lock-on', 'lock-attempts', 'lock-minutes', 'pw-on', 'pw-len', 'pw-upper', 'pw-number', 'pw-special'],
      map: { 'lockout.max_attempts': 'lock-attempts', 'lockout.duration': 'lock-minutes', 'password.min_length': 'pw-len' },
      confirm: (v, d) => {
        const asks = [];
        if (d.includes('lock-attempts') && v['lock-on'] && int(v['lock-attempts']) <= 2) {
          asks.push({ title: t('st.confirm.title'), message: t('st.confirm.lockout_low', { n: int(v['lock-attempts']) }), okLabel: t('st.confirm.save_anyway'), danger: true });
        }
        if (d.includes('req2fa') && !v.req2fa) asks.push({ title: t('st.confirm.title'), message: t('st.confirm.req2fa_off'), okLabel: t('st.confirm.save_anyway'), danger: true });
        if (d.includes('req2fa') && v.req2fa && !self2fa) asks.push({ title: t('st.confirm.title'), message: t('st.confirm.req2fa_self'), okLabel: t('st.confirm.save_anyway') });
        return asks;
      },
      save(v, d) {
        const body = {};
        const lo = U.pickDirty({ enabled: 'lock-on', max_attempts: 'lock-attempts', duration: 'lock-minutes' }, v, d);
        const pw = U.pickDirty({ complexity_enabled: 'pw-on', min_length: 'pw-len', require_uppercase: 'pw-upper', require_number: 'pw-number', require_special: 'pw-special' }, v, d);
        if (Object.keys(lo).length) body.lockout = lo;
        if (Object.keys(pw).length) body.password = pw;
        if (d.includes('req2fa')) body.require_2fa = v.req2fa;
        return api.put('/api/v1/settings/security', body);
      },
    }],
  };

  // ── Gerätebindung ──
  SECTIONS.geraete = {
    async load() {
      const r = await get('/api/v1/settings/machine-binding');
      if (r.ok) fill('geraete', { 'mb-mode': r.data.mode || 'off' });
    },
    groups: [{
      fields: ['mb-mode'], errorField: 'mb-mode',
      confirm: (v) => ({ title: t('st.confirm.title'), message: t('st.confirm.mb_' + v['mb-mode']), okLabel: t('st.confirm.save_anyway'), danger: true }),
      save: (v) => api.put('/api/v1/settings/machine-binding', { mode: v['mb-mode'] }),
    }],
  };

  // ── Peer-Gruppen & Tags ──
  function safeColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#6b7280'; }
  SECTIONS.gruppen = {
    editing: null,
    groups: [],
    policies: {},
    async load() { await Promise.all([this.loadGroups(), this.loadTags()]); },
    async loadGroups() {
      const [r, cp] = await Promise.all([get('/api/v1/peer-groups'), get('/api/v1/settings/client-policy')]);
      this.groups = (r.ok && r.groups) || [];
      this.policies = {};
      if (cp.ok) (cp.data.groups || []).forEach((g) => { this.policies[g.id] = Object.keys(g.policy || {}).length > 0; });
      this.render();
    },
    render() {
      const box = $('st-groups');
      clear(box);
      if (!this.groups.length) { box.appendChild(empty(t('peer_groups.no_groups'))); return; }
      this.groups.forEach((g) => box.appendChild(this.editing === g.id ? this.editRow(g) : this.row(g)));
    },
    row(g) {
      const dot = el('span', { class: 'st-colordot', 'aria-hidden': 'true' });
      dot.style.background = safeColor(g.color);
      const edit = el('button', { type: 'button', class: 'st-btn st-btn-sm', 'aria-label': t('st.groups.edit_label', { name: g.name }), text: t('st.edit') });
      edit.addEventListener('click', () => { this.editing = g.id; this.render(); const f = document.querySelector('[data-group-edit="' + g.id + '"] input'); if (f) f.focus(); });
      return el('li', { class: 'st-li', 'data-group-id': String(g.id) }, [
        dot,
        el('div', { class: 'st-li-main' }, [el('div', { class: 'st-li-title', text: g.name }), g.description ? el('div', { class: 'st-li-sub', text: g.description }) : null]),
        el('span', { class: 'st-li-sub', text: tp('st.groups.peers', g.peer_count || 0) }),
        this.policies[g.id] ? el('span', { class: 'st-chip-accent', text: t('st.groups.own_policy') }) : null,
        edit,
      ]);
    },
    editRow(g) {
      const name = el('input', { type: 'text', class: 'st-input', maxLength: 100, value: g.name || '', 'aria-label': t('st.groups.name') });
      const desc = el('input', { type: 'text', class: 'st-input', maxLength: 255, value: g.description || '', 'aria-label': t('st.groups.desc'), placeholder: t('st.optional') });
      const color = el('input', { type: 'color', class: 'st-color', value: safeColor(g.color), 'aria-label': t('st.groups.color') });
      const err = el('span', { class: 'st-err st-err-block', role: 'alert', hidden: true });
      const saveB = el('button', { type: 'button', class: 'st-btn st-btn-sm st-btn-primary', text: t('common.save') });
      const cancelB = el('button', { type: 'button', class: 'st-btn st-btn-sm st-btn-ghost', text: t('common.cancel') });
      const delB = el('button', { type: 'button', class: 'st-btn st-btn-sm st-btn-danger', text: t('st.delete_dots') });
      saveB.addEventListener('click', async () => {
        if (!name.value.trim()) { err.textContent = t('error.peer_groups.name_required'); err.hidden = false; name.focus(); return; }
        busy(saveB, true);
        const r = await put('/api/v1/peer-groups/' + g.id, { name: name.value.trim(), description: desc.value.trim(), color: color.value });
        busy(saveB, false);
        if (r.ok) { this.editing = null; this.loadGroups(); } else { err.textContent = errText(r); err.hidden = false; }
      });
      cancelB.addEventListener('click', () => { this.editing = null; this.render(); });
      delB.addEventListener('click', async () => {
        if (!(await D.confirm({ title: t('st.groups.delete_title'), message: t('st.groups.delete_msg', { name: g.name }), okLabel: t('common.delete'), danger: true }))) return;
        const r = await del('/api/v1/peer-groups/' + g.id);
        if (r.ok) { this.editing = null; this.loadGroups(); } else { err.textContent = errText(r); err.hidden = false; }
      });
      return el('li', { class: 'st-li st-li-edit', 'data-group-edit': String(g.id) }, [
        el('div', { class: 'st-formline' }, [
          el('div', { class: 'st-fl st-fl-2' }, [name]), el('div', { class: 'st-fl st-fl-3' }, [desc]), el('div', { class: 'st-fl' }, [color]),
          saveB, cancelB, delB, err,
        ]),
      ]);
    },
    async loadTags() {
      const box = $('st-tags');
      const r = await get('/api/v1/tags');
      clear(box);
      const list = (r.ok && r.tags) || [];
      if (!list.length) { box.appendChild(empty(t('tags.no_tags'))); return; }
      list.forEach((tag) => {
        const x = el('button', { type: 'button', class: 'st-tag-x', 'aria-label': t('st.tags.remove_label', { name: tag.name }), title: t('st.tags.remove_label', { name: tag.name }), text: '×' });
        x.addEventListener('click', async () => {
          if (!(await D.confirm({ title: t('st.tags.delete_title'), message: t('tags.confirm_delete', { name: tag.name }), okLabel: t('common.delete'), danger: true }))) return;
          const res = await del('/api/v1/tags/' + encodeURIComponent(tag.name));
          if (res.ok) { toast(t('tags.deleted', { n: res.peers_affected || 0 })); this.loadTags(); } else toast(errText(res), 'error');
        });
        box.appendChild(el('li', { class: 'st-tag' }, [
          el('span', { text: tag.name }),
          el('span', { class: 'st-tag-n', text: tag.peer_count > 0 ? String(tag.peer_count) : t('tags.unused') }),
          x,
        ]));
      });
    },
  };
  $('st-group-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('st-g-name');
    const err = $('st-g-err');
    err.hidden = true;
    if (!name.value.trim()) { err.textContent = t('error.peer_groups.name_required'); err.hidden = false; name.focus(); return; }
    const b = e.currentTarget.querySelector('button[type="submit"]');
    busy(b, true);
    const r = await post('/api/v1/peer-groups', { name: name.value.trim(), description: $('st-g-desc').value.trim(), color: $('st-g-color').value });
    busy(b, false);
    if (r.ok) { name.value = ''; $('st-g-desc').value = ''; $('st-g-color').value = '#6b7280'; SECTIONS.gruppen.loadGroups(); } else { err.textContent = errText(r); err.hidden = false; }
  });
  $('st-tag-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('st-tag-input');
    const err = $('st-tag-err');
    err.hidden = true;
    if (!input.value.trim()) { err.textContent = t('tags.error_name_required'); err.hidden = false; input.focus(); return; }
    const b = e.currentTarget.querySelector('button[type="submit"]');
    busy(b, true);
    const r = await post('/api/v1/tags', { name: input.value.trim() });
    busy(b, false);
    if (r.ok) { input.value = ''; SECTIONS.gruppen.loadTags(); } else { err.textContent = errText(r); err.hidden = false; }
  });

  // ── Client-Richtlinien ──
  const CPF = window.ClientPolicyForm;
  const cpGlobal = CPF ? CPF.create($('st-cp-global'), { mode: 'global', idPrefix: 'stcp-global' }) : null;
  const cpGroup = CPF ? CPF.create($('st-cp-groupform'), { mode: 'override', idPrefix: 'stcp-group' }) : null;
  const cpSel = $('st-cp-group');
  if (cpGlobal) CUSTOM['cp-global'] = { get: () => cpGlobal.getValue(), set: (v) => cpGlobal.setValue(v) };
  if (cpGroup) CUSTOM['cp-group'] = { get: () => cpGroup.getValue(), set: (v) => cpGroup.setValue(v) };
  let cpState = null;
  let cpGroupId = '';
  SECTIONS.richtlinien = {
    async load() {
      const r = await get('/api/v1/settings/client-policy');
      if (!r.ok) return;
      this.apply(r.data);
    },
    apply(data) {
      cpState = data;
      const warn = $('st-cp-warn');
      const ws = data.warnings || [];
      warn.hidden = !ws.length;
      warn.textContent = ws.map((w) => t('client_policy.' + w.replace('split_tunnel_preset_conflict', 'split_preset_conflict'))).join(' ');
      clear(cpSel);
      data.groups.forEach((g) => cpSel.appendChild(el('option', {
        value: String(g.id),
        text: g.name + (Object.keys(g.policy || {}).length ? ' · ' + t('st.groups.own_policy') : ''),
      })));
      const has = data.groups.length > 0;
      $('st-cp-nogroups').hidden = has;
      $('st-cp-groupbody').hidden = !has;
      if (cpGroupId && data.groups.some((g) => String(g.id) === cpGroupId)) cpSel.value = cpGroupId;
      cpGroupId = cpSel.value;
      if (cpGroup) cpGroup.setInherited(data.global, null);
      const g = data.groups.find((x) => String(x.id) === cpGroupId);
      fill('richtlinien', { 'cp-global': data.global, 'cp-group': g ? g.policy : {} });
    },
    validate(v, d) {
      const errs = {};
      if (d.includes('cp-global') && cpGlobal && !cpGlobal.isValid()) errs['cp-global'] = t('error.client_policy.invalid');
      if (d.includes('cp-group') && cpGroup && !cpGroup.isValid()) errs['cp-group'] = t('error.client_policy.invalid');
      return errs;
    },
    groups: [
      { fields: ['cp-global'], errorField: 'cp-global', save: (v) => api.put('/api/v1/settings/client-policy', v['cp-global']),
        after: (r) => { if (r.data) SECTIONS.richtlinien.apply(r.data); } },
      { fields: ['cp-group'], errorField: 'cp-group', save: (v) => api.put('/api/v1/settings/client-policy/groups/' + cpGroupId, v['cp-group']),
        after: (r) => { if (r.data) SECTIONS.richtlinien.apply(r.data); } },
    ],
  };
  cpSel.addEventListener('change', async () => {
    if (dirtyOf('richtlinien').includes('cp-group')) {
      if (!(await D.confirm({ title: t('st.leave.title'), message: t('st.cp.switch_group'), okLabel: t('st.leave.discard'), danger: true }))) { cpSel.value = cpGroupId; return; }
    }
    cpGroupId = cpSel.value;
    const g = cpState && cpState.groups.find((x) => String(x.id) === cpGroupId);
    fill('richtlinien', { 'cp-group': g ? g.policy : {} });
    updateBar();
  });
  $('st-cp-inherit').addEventListener('click', async (e) => {
    const g = cpState && cpState.groups.find((x) => String(x.id) === cpGroupId);
    if (!g) return;
    if (!(await D.confirm({ title: t('st.cp.inherit_title'), message: t('st.cp.inherit_msg', { name: g.name }), okLabel: t('st.cp.inherit_ok'), danger: true }))) return;
    busy(e.currentTarget, true);
    const r = await put('/api/v1/settings/client-policy/groups/' + g.id, {});
    busy(e.currentTarget, false);
    if (r.ok) { SECTIONS.richtlinien.apply(r.data); updateBar(); toast(t('client_policy.saved')); } else toast(errText(r), 'error');
  });

  // ── Split-Tunnel-Vorgabe ──
  const PRIVATE_CIDRS = [{ cidr: '172.16.0.0/12', label: 'Private 172.x' }, { cidr: '192.168.0.0/16', label: 'Private 192.x' }];
  const LINK_LOCAL = { cidr: '169.254.0.0/16', label: 'Link-Local' };
  let stNets = [];
  CUSTOM['st-networks'] = {
    get: () => stNets.map((n) => ({ label: n.label || '', cidr: n.cidr })),
    set: (v) => { stNets = (v || []).map((n) => ({ label: n.label || '', cidr: n.cidr })); renderNets(); },
  };
  function renderNets() {
    const box = $('st-st-list');
    clear(box);
    if (!stNets.length) { box.appendChild(empty(t('st.st.no_networks'))); return; }
    stNets.forEach((n, i) => {
      const x = el('button', { type: 'button', class: 'st-icon-btn', 'aria-label': t('st.st.remove_label', { name: n.label || n.cidr }), title: t('st.st.remove_label', { name: n.label || n.cidr }), disabled: !FEATURES.split_tunnel_preset }, [icon('M6 6l12 12M18 6L6 18')]);
      x.addEventListener('click', () => {
        stNets.splice(i, 1);
        renderNets();
        $('st-st-networks').dispatchEvent(new Event('change', { bubbles: true }));
        toast(t('st.st.removed_hint'));
      });
      box.appendChild(el('li', { class: 'st-chiprow' }, [el('span', { class: 'st-strong', text: n.label || '—' }), el('span', { class: 'st-mono st-li-sub', text: n.cidr }), x]));
    });
  }
  $('st-st-addbtn').addEventListener('click', () => {
    const label = $('st-st-label');
    const cidr = $('st-st-cidr');
    const err = $('st-st-networks-err');
    err.hidden = true;
    const c = cidr.value.trim();
    if (!label.value.trim()) { err.textContent = t('settings.split_tunnel_label_required'); err.hidden = false; label.focus(); return; }
    if (!U.cidrOk(c)) { err.textContent = t('settings.split_tunnel_cidr_invalid'); err.hidden = false; cidr.focus(); return; }
    if (stNets.some((n) => n.cidr === c)) { err.textContent = t('st.st.duplicate'); err.hidden = false; cidr.focus(); return; }
    stNets.push({ label: label.value.trim(), cidr: c });
    label.value = '';
    cidr.value = '';
    renderNets();
    $('st-st-networks').dispatchEvent(new Event('change', { bubbles: true }));
    label.focus();
  });
  ['st-st-label', 'st-st-cidr'].forEach((idx) => $(idx).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('st-st-addbtn').click(); } }));
  SECTIONS.splittunnel = {
    async load() {
      const r = await get('/api/v1/settings/split-tunnel');
      if (!r.ok) return;
      const nets = r.networks || [];
      const priv = PRIVATE_CIDRS.every((p) => nets.some((n) => n.cidr === p.cidr));
      const ll = nets.some((n) => n.cidr === LINK_LOCAL.cidr);
      const custom = nets.filter((n) => !((priv && PRIVATE_CIDRS.some((p) => p.cidr === n.cidr)) || (ll && n.cidr === LINK_LOCAL.cidr)));
      fill('splittunnel', { 'st-mode': r.mode || 'off', 'st-private': priv, 'st-linklocal': ll, 'st-lock': !!r.locked, 'st-networks': custom });
    },
    groups: [{
      fields: ['st-mode', 'st-private', 'st-linklocal', 'st-lock', 'st-networks'],
      map: { mode: 'st-mode', networks: 'st-networks' },
      save(v) {
        let networks = v['st-networks'].slice();
        if (v['st-private']) networks = PRIVATE_CIDRS.concat(networks);
        if (v['st-linklocal']) networks.push(LINK_LOCAL);
        return api.put('/api/v1/settings/split-tunnel', { mode: v['st-mode'], networks, locked: v['st-lock'] });
      },
    }],
  };

  // ── Client-Updates ──
  const PRODUCT_KEYS = { pro: 'client_updates.product_pro', community: 'client_updates.product_community', android: 'client_updates.product_android', unknown: 'client_updates.product_unknown' };
  function renderVersions(ov) {
    const box = $('st-cu-overview');
    clear(box);
    const products = (ov && ov.products) || [];
    $('st-cu-unreported').textContent = ov && ov.unreported > 0 ? t('client_updates.overview_unreported', { count: ov.unreported }) : '';
    if (!products.length) { box.appendChild(el('p', { class: 'st-empty', text: t('client_updates.overview_empty') })); return; }
    products.forEach((p) => {
      const max = Math.max(1, ...p.versions.map((v) => v.count));
      box.appendChild(el('div', { class: 'st-tile' }, [
        el('div', { class: 'st-tile-head' }, [el('span', { class: 'st-tile-name', text: t(PRODUCT_KEYS[p.product] || PRODUCT_KEYS.unknown) }), el('span', { class: 'st-li-sub st-push', text: tp('st.cu.devices', p.total) })]),
        el('div', { class: 'st-li-sub', text: p.min_version ? t('client_updates.overview_min', { version: p.min_version }) : t('st.cu.no_min') }),
        el('ul', { class: 'st-bars' }, p.versions.map((v) => {
          const fillEl = el('span', { class: 'st-bar-fill' + (v.below_min ? ' st-bar-warn' : '') });
          fillEl.style.width = Math.round((v.count / max) * 100) + '%';
          return el('li', { class: 'st-bar-row', 'data-below-min': v.below_min ? '1' : null }, [
            el('div', { class: 'st-bar-head' }, [
              el('span', { class: 'st-mono', text: v.version }),
              v.below_min ? el('span', { class: 'st-bar-flag', text: t('client_updates.overview_below_min') }) : null,
              el('span', { class: 'st-strong st-push', text: String(v.count) }),
            ]),
            el('span', { class: 'st-bar-track' }, [fillEl]),
          ]);
        })),
      ]));
    });
  }
  SECTIONS.clientupdates = {
    async load() {
      const r = await get('/api/v1/settings/client-updates');
      if (!r.ok) { renderVersions(null); return; }
      fill('clientupdates', { 'cu-channel': r.data.default_channel || 'stable', 'cu-min-pro': (r.data.min_versions && r.data.min_versions.pro) || '', 'cu-min-community': (r.data.min_versions && r.data.min_versions.community) || '' });
      renderVersions(r.data.overview);
    },
    validate(v) {
      const errs = {};
      ['cu-min-pro', 'cu-min-community'].forEach((f) => { if (!U.semverOk(v[f])) errs[f] = t('error.client_updates.invalid_min_version'); });
      return errs;
    },
    groups: [{
      fields: ['cu-channel', 'cu-min-pro', 'cu-min-community'], errorField: 'cu-min-pro',
      save: (v) => api.put('/api/v1/settings/client-updates', { default_channel: v['cu-channel'], min_versions: { pro: v['cu-min-pro'].trim(), community: v['cu-min-community'].trim() } }),
      after: (r) => { if (r.data) renderVersions(r.data.overview); },
    }],
  };

  // ── E-Mail-Versand ──
  let smtpSaved = null;
  SECTIONS.email = {
    async load() {
      const r = await get('/api/v1/smtp/settings');
      if (!r.ok) return;
      const d = r.data;
      smtpSaved = d;
      $('st-smtp-pw').placeholder = d.hasPassword ? t('st.secret_set') : '';
      $('st-smtp-pw-clear').hidden = !d.hasPassword;
      fill('email', { 'smtp-host': d.host || '', 'smtp-port': d.port || '', 'smtp-tls': d.secure ? 'tls' : 'starttls', 'smtp-user': d.user || '', 'smtp-password': '', 'smtp-from': d.from || '' });
    },
    groups: [{
      fields: ['smtp-host', 'smtp-port', 'smtp-tls', 'smtp-user', 'smtp-password', 'smtp-from'],
      map: { host: 'smtp-host', port: 'smtp-port', from: 'smtp-from' }, errorField: 'smtp-host',
      save(v) {
        const body = { host: v['smtp-host'].trim(), port: v['smtp-port'], user: v['smtp-user'].trim(), from: v['smtp-from'].trim(), secure: v['smtp-tls'] === 'tls' };
        if (v['smtp-password']) body.password = v['smtp-password'];
        return api.put('/api/v1/smtp/settings', body);
      },
      after: () => SECTIONS.email.load(),
    }],
  };
  $('st-smtp-pw-clear').addEventListener('click', async (e) => {
    if (!smtpSaved) return;
    if (!(await D.confirm({ title: t('st.smtp.password_clear_title'), message: t('settings.autosave.clear_secret_confirm'), okLabel: t('st.remove'), danger: true }))) return;
    busy(e.currentTarget, true);
    const r = await put('/api/v1/smtp/settings', { host: smtpSaved.host, port: smtpSaved.port, user: smtpSaved.user, from: smtpSaved.from, secure: smtpSaved.secure, clear_password: true });
    busy(e.currentTarget, false);
    if (r.ok) { toast(t('st.smtp.password_cleared')); SECTIONS.email.load(); } else toast(errText(r), 'error');
  });
  $('st-smtp-test').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const msg = $('st-smtp-test-msg');
    if (dirtyOf('email').length) { msg.textContent = t('st.smtp.test_save_first'); msg.dataset.state = 'warn'; return; }
    const rec = await get('/api/v1/settings/alerts');
    const first = rec.ok ? String(rec.data.email || '').split(',')[0].trim() : '';
    const to = await D.prompt({
      title: t('st.smtp.test'), label: t('st.smtp.test_to'), value: first, placeholder: 'admin@example.com', okLabel: t('st.smtp.test_send'), maxLength: 254,
      validate: (v) => (U.recipientsOk(v) && v && !v.includes(',') ? null : t('error.settings.recipient_invalid')),
    });
    if (!to) return;
    busy(b, true);
    msg.textContent = '';
    const r = await post('/api/v1/smtp/test', { email: to });
    busy(b, false);
    msg.textContent = r.ok ? t('settings.smtp_test_sent', { email: to }) : errText(r);
    msg.dataset.state = r.ok ? 'good' : 'crit';
  });

  // ── Benachrichtigungen ──
  // Recipient + monitoring checks. The event matrix (e-mail per event, webhook
  // counts) moved into the rules of the notification centre (/notifications,
  // docs/feature-notification-center.md); this section only links there, so
  // `events` is neither shown nor sent from here any more.
  const ALERT_MAP = { email: 'al-email', backup_reminder_days: 'al-backup', resource_cpu_threshold: 'al-cpu', resource_ram_threshold: 'al-ram', resource_disk_threshold: 'al-disk' };
  SECTIONS.benachrichtigungen = {
    async load() {
      const r = await get('/api/v1/settings/alerts');
      if (!r.ok) return;
      const d = r.data;
      const note = $('st-al-smtp');
      clear(note);
      if (d.smtp && d.smtp.configured) note.appendChild(document.createTextNode(t('st.notify.smtp_ok', { host: d.smtp.host })));
      else {
        note.appendChild(document.createTextNode(t('st.notify.smtp_missing') + ' '));
        note.appendChild(el('a', { href: '#email', class: 'st-link', text: t('st.nav.email') }));
      }
      note.classList.toggle('st-note-warn', !(d.smtp && d.smtp.configured));
      fill('benachrichtigungen', {
        'al-email': d.email || '', 'al-backup': d.backup_reminder_days,
        'al-cpu': d.resource_cpu_threshold, 'al-ram': d.resource_ram_threshold, 'al-disk': d.resource_disk_threshold,
      });
    },
    validate(v, d) { return d.includes('al-email') && !U.recipientsOk(v['al-email']) ? { 'al-email': t('error.settings.recipient_invalid') } : {}; },
    groups: [{
      fields: Object.values(ALERT_MAP), map: ALERT_MAP,
      save: (v, d) => api.put('/api/v1/settings/alerts', U.pickDirty(ALERT_MAP, v, d, (val, f) => (f === 'al-email' ? String(val).trim() : val))),
    }],
  };

  // ── Webhooks ──
  const whList = $('st-wh-list');
  let whItems = [];
  let whEditing = null;
  function groupNames(ids) { return ids.map((g) => t('st.egroup.' + g)).join(', '); }
  function hookSummary(h) {
    const s = U.webhookSummary(CATALOGUE, h.events);
    if (s.all) return t('st.wh.all_events');
    if (!s.rows) return t('st.wh.custom_events', { list: String(h.events) });
    return groupNames(s.groups) + ' · ' + tp('st.wh.n_events', s.rows);
  }
  function hookRow(h) {
    let host = '';
    try { host = new URL(h.url).host; } catch (_) { host = h.url; }
    const test = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('st.test') });
    test.addEventListener('click', async () => {
      busy(test, true);
      const r = await post('/api/v1/webhooks/' + h.id + '/test');
      busy(test, false);
      if (r.ok) toast(t('settings.webhook_test_ok', { status: r.status }));
      else toast(t('settings.webhook_test_failed', { error: errText(r) }), 'error');
    });
    const edit = el('button', { type: 'button', class: 'st-btn st-btn-sm', 'aria-label': t('st.wh.edit_label', { name: h.description || host }), text: t('st.edit') });
    edit.addEventListener('click', () => openHook(h));
    return el('li', { class: 'st-li', 'data-webhook-id': String(h.id) }, [
      el('div', { class: 'st-li-main' }, [
        el('div', { class: 'st-li-title', text: h.description || host }),
        el('div', { class: 'st-li-sub st-mono st-wrap', text: h.url }),
        el('div', { class: 'st-li-sub', 'data-events': h.events, text: hookSummary(h) }),
      ]),
      pill(h.enabled ? 'good' : 'off', t(h.enabled ? 'st.wh.active' : 'st.wh.paused')),
      el('div', { class: 'st-li-actions' }, [test, edit]),
    ]);
  }
  SECTIONS.webhooks = {
    async load() {
      const r = await get('/api/v1/webhooks');
      whItems = (r.ok && r.webhooks) || [];
      clear(whList);
      if (!r.ok) { whList.appendChild(empty(errText(r))); return; }
      if (!whItems.length) whList.appendChild(empty(t('settings.webhooks_empty')));
      whItems.forEach((h) => whList.appendChild(hookRow(h)));
    },
  };
  // Dialog
  const whGroups = $('st-wh-groups');
  const whBoxes = {};
  (function buildHookEvents() {
    CATALOGUE.forEach((g) => {
      const box = el('fieldset', { class: 'st-wh-group' }, [el('legend', { class: 'st-wh-legend', text: t('st.egroup.' + g.id) })]);
      g.events.forEach((ev) => {
        const cb = el('input', { type: 'checkbox', value: ev.id });
        whBoxes[ev.id] = cb;
        box.appendChild(el('label', { class: 'st-check' }, [cb, el('span', { text: t('st.event.' + ev.id) })]));
      });
      whGroups.appendChild(box);
    });
  })();
  function syncHookScope() {
    const pick = $('st-wh-pick').checked;
    whGroups.hidden = !pick;
  }
  $('st-wh-all').addEventListener('change', syncHookScope);
  $('st-wh-pick').addEventListener('change', syncHookScope);
  function openHook(h) {
    whEditing = h || null;
    const title = $('st-wh-title');
    title.textContent = h ? title.dataset.edit : title.dataset.add;
    ['st-wh-url-err', 'st-wh-events-err', 'st-wh-err'].forEach((x) => { $(x).hidden = true; $(x).textContent = ''; });
    $('st-wh-url').value = h ? h.url : '';
    // Without the licence an existing webhook keeps its target (a new URL is a new webhook).
    $('st-wh-url').disabled = !!h && !FEATURES.webhooks;
    $('st-wh-desc').value = h ? (h.description || '') : '';
    $('st-wh-enabled').checked = h ? !!h.enabled : true;
    const all = !h || String(h.events).trim() === '*';
    $('st-wh-all').checked = all;
    $('st-wh-pick').checked = !all;
    const rows = new Set(all ? [] : U.eventRows(CATALOGUE, h.events));
    Object.keys(whBoxes).forEach((id) => { whBoxes[id].checked = rows.has(id); });
    syncHookScope();
    $('st-wh-delete').hidden = !h;
    window.openModal('st-wh-modal');
    $(h && !FEATURES.webhooks ? 'st-wh-desc' : 'st-wh-url').focus();
  }
  $('st-wh-add').addEventListener('click', () => openHook(null));
  $('st-wh-form').addEventListener('submit', (e) => { e.preventDefault(); saveHook(); });
  $('st-wh-save').addEventListener('click', saveHook);
  async function saveHook() {
    const urlErr = $('st-wh-url-err');
    const evErr = $('st-wh-events-err');
    const err = $('st-wh-err');
    [urlErr, evErr, err].forEach((x) => { x.hidden = true; });
    const url = $('st-wh-url').value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { urlErr.textContent = t('error.webhooks.url_invalid'); urlErr.hidden = false; $('st-wh-url').focus(); return; }
    let events = '*';
    if ($('st-wh-pick').checked) {
      const ids = Object.keys(whBoxes).filter((id) => whBoxes[id].checked);
      if (!ids.length) { evErr.textContent = t('st.wh.events_required'); evErr.hidden = false; return; }
      events = U.typesOfRows(CATALOGUE, ids);
    }
    const body = { url, description: $('st-wh-desc').value.trim(), events, enabled: $('st-wh-enabled').checked };
    if (whEditing && $('st-wh-url').disabled) delete body.url;
    const btn = $('st-wh-save');
    busy(btn, true);
    const r = whEditing ? await put('/api/v1/webhooks/' + whEditing.id, body) : await post('/api/v1/webhooks', body);
    busy(btn, false);
    if (r.ok) { window.closeModal('st-wh-modal'); toast(t('st.wh.saved')); SECTIONS.webhooks.load(); return; }
    err.textContent = errText(r);
    err.hidden = false;
  }
  $('st-wh-delete').addEventListener('click', async () => {
    if (!whEditing) return;
    const name = whEditing.description || whEditing.url;
    if (!(await D.confirm({ title: t('st.wh.delete_title'), message: t('st.wh.delete_msg', { name }), okLabel: t('common.delete'), danger: true }))) return;
    const r = await del('/api/v1/webhooks/' + whEditing.id);
    if (r.ok) { window.closeModal('st-wh-modal'); toast(t('st.wh.deleted')); SECTIONS.webhooks.load(); } else { $('st-wh-err').textContent = errText(r); $('st-wh-err').hidden = false; }
  });

  // ── Monitoring ──
  SECTIONS.monitoring = {
    async load() {
      const [m, gw, me] = await Promise.all([get('/api/v1/settings/monitoring'), get('/api/v1/settings/gateway-failover'), get('/api/v1/settings/metrics')]);
      const vals = {};
      if (m.ok) vals['mon-interval'] = m.data.interval;
      if (gw.ok) vals['gw-down'] = gw.data.gateway_down_threshold_s;
      if (me.ok) vals.prom = !!me.data.enabled;
      fill('monitoring', vals);
    },
    groups: [
      { fields: ['mon-interval'], map: { interval: 'mon-interval' }, errorField: 'mon-interval', save: (v) => api.put('/api/v1/settings/monitoring', { interval: v['mon-interval'] }) },
      { fields: ['gw-down'], map: { gateway_down_threshold_s: 'gw-down' }, errorField: 'gw-down', save: (v) => api.put('/api/v1/settings/gateway-failover', { gateway_down_threshold_s: int(v['gw-down']) }) },
      { fields: ['prom'], errorField: 'prom', save: (v) => api.put('/api/v1/settings/metrics', { enabled: v.prom }) },
    ],
  };

  // ── Pi-hole ──
  if (sectionEl('pihole')) {
    let phInstances = [];
    let phEditing = -1;
    const phSaved = {};
    const phList = $('st-ph-list');
    const phPayload = (vals, instances) => ({
      enabled: vals['ph-on'], manage_dns_chain: vals['ph-chain'], sync_interval_sec: int(vals['ph-sync']), top_clients_count: int(vals['ph-top']),
      instances: instances.map((i) => {
        const out = { id: i.id, label: i.label || '', url: i.url, dns_ip: i.dns_ip || '', dns_port: int(i.dns_port) || 53, verify_tls: i.verify_tls !== false, password_set: !!i.password_set };
        if (i.app_password) out.app_password = i.app_password;
        return out;
      }),
    });
    const renderPh = () => {
      clear(phList);
      if (!phInstances.length) { phList.appendChild(empty(t('pihole.cfg.no_instances'))); return; }
      phInstances.forEach((inst, idx) => {
        const test = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('pihole.cfg.test_connection') });
        test.addEventListener('click', async () => {
          busy(test, true);
          const r = await post('/api/v1/settings/pihole/test/' + encodeURIComponent(inst.id));
          busy(test, false);
          toast(phTestText(r, inst.dns_port), r.ok && r.data && r.data.connected ? 'success' : 'error');
        });
        const edit = el('button', { type: 'button', class: 'st-btn st-btn-sm', text: t('st.edit'), 'aria-label': t('st.ph.edit_label', { name: inst.label || inst.url }) });
        edit.addEventListener('click', () => openPh(idx));
        const detail = [inst.url];
        if (inst.dns_ip) detail.push(t('st.ph.dns', { ip: inst.dns_ip, port: inst.dns_port || 53 }));
        detail.push(t(inst.verify_tls !== false ? 'st.ph.tls_on' : 'st.ph.tls_off'));
        phList.appendChild(el('li', { class: 'st-li' }, [
          el('div', { class: 'st-li-main' }, [el('div', { class: 'st-li-title', text: inst.label || inst.url }), el('div', { class: 'st-li-sub st-mono', text: detail.join(' · ') })]),
          el('div', { class: 'st-li-actions' }, [test, edit]),
        ]));
      });
    };
    const phTestText = (r, port) => {
      if (!(r.ok && r.data && r.data.connected)) return errText(r.ok ? { error: t('pihole.cfg.test_failed') } : r);
      let msg = t('st.ph.test_ok', { version: r.data.version || '?' });
      if (r.data.dns) {
        if (!r.data.dns.reachable) msg += ' · ' + t('st.ph.dns_unreachable', { port: port || 53 });
        else {
          msg += ' · ' + t('st.ph.dns_ok');
          if (r.data.dns.blocking === true) msg += ' · ' + t('st.ph.blocking_on');
          else if (r.data.dns.blocking === false) msg += ' · ' + t('st.ph.blocking_off');
        }
      }
      return msg;
    };
    const openPh = (idx) => {
      phEditing = idx;
      const inst = idx >= 0 ? phInstances[idx] : null;
      const title = $('st-ph-title');
      title.textContent = inst ? title.dataset.edit : title.dataset.add;
      $('st-ph-label').value = inst ? inst.label || '' : '';
      $('st-ph-url').value = inst ? inst.url || '' : '';
      $('st-ph-dns').value = inst ? inst.dns_ip || '' : '';
      $('st-ph-dnsport').value = inst ? inst.dns_port || 53 : 53;
      $('st-ph-pw').value = '';
      $('st-ph-pw-hint').hidden = !(inst && inst.password_set);
      $('st-ph-tls').checked = inst ? inst.verify_tls !== false : true;
      $('st-ph-delete').hidden = !inst;
      $('st-ph-url-err').hidden = true;
      $('st-ph-testmsg').hidden = true;
      window.openModal('st-ph-modal');
      $('st-ph-label').focus();
    };
    const phForm = () => ({
      label: $('st-ph-label').value.trim(), url: $('st-ph-url').value.trim(), dns_ip: $('st-ph-dns').value.trim(),
      dns_port: int($('st-ph-dnsport').value) || 53, app_password: $('st-ph-pw').value, verify_tls: $('st-ph-tls').checked,
    });
    $('st-ph-url').addEventListener('blur', () => {
      const dns = $('st-ph-dns');
      if (dns.value.trim()) return;
      try { dns.value = new URL($('st-ph-url').value.trim()).hostname; } catch (_) { /* still typing */ }
    });
    const storeInstances = async (instances) => {
      // Saved values of the other fields: unsaved edits stay in the save bar.
      const r = await put('/api/v1/settings/pihole', phPayload(Object.assign({}, phSaved, baseline.pihole || {}), instances));
      if (r.ok) { const fresh = await get('/api/v1/settings/pihole'); phInstances = ((fresh.ok && fresh.data.instances) || instances).slice(); renderPh(); }
      return r;
    };
    $('st-ph-add').addEventListener('click', () => openPh(-1));
    $('st-ph-form').addEventListener('submit', (e) => { e.preventDefault(); $('st-ph-save').click(); });
    $('st-ph-save').addEventListener('click', async (e) => {
      const f = phForm();
      if (!/^https?:\/\/\S+$/i.test(f.url)) { $('st-ph-url-err').textContent = t('pihole.cfg.url_required'); $('st-ph-url-err').hidden = false; return; }
      const list = phInstances.map((i) => Object.assign({}, i));
      if (phEditing >= 0) {
        const cur = list[phEditing];
        Object.assign(cur, { label: f.label, url: f.url, dns_ip: f.dns_ip, dns_port: f.dns_port, verify_tls: f.verify_tls });
        if (f.app_password) { cur.app_password = f.app_password; cur.password_set = true; }
      } else {
        const n = { id: Date.now().toString(), label: f.label, url: f.url, dns_ip: f.dns_ip, dns_port: f.dns_port, verify_tls: f.verify_tls, password_set: !!f.app_password };
        if (f.app_password) n.app_password = f.app_password;
        list.push(n);
      }
      busy(e.currentTarget, true);
      const r = await storeInstances(list);
      busy(e.currentTarget, false);
      if (r.ok) { window.closeModal('st-ph-modal'); toast(t('pihole.cfg.saved')); } else { $('st-ph-testmsg').textContent = errText(r); $('st-ph-testmsg').hidden = false; }
    });
    $('st-ph-delete').addEventListener('click', async () => {
      if (phEditing < 0) return;
      const inst = phInstances[phEditing];
      if (!(await D.confirm({ title: t('st.ph.delete_title'), message: t('st.ph.delete_msg', { name: inst.label || inst.url }), okLabel: t('common.delete'), danger: true }))) return;
      const r = await storeInstances(phInstances.filter((_, i) => i !== phEditing));
      if (r.ok) window.closeModal('st-ph-modal'); else toast(errText(r), 'error');
    });
    $('st-ph-test').addEventListener('click', async (e) => {
      const f = phForm();
      const msg = $('st-ph-testmsg');
      if (!/^https?:\/\/\S+$/i.test(f.url)) { $('st-ph-url-err').textContent = t('pihole.cfg.url_required'); $('st-ph-url-err').hidden = false; return; }
      busy(e.currentTarget, true);
      const r = await post('/api/v1/settings/pihole/test', { url: f.url, app_password: f.app_password || null, verify_tls: f.verify_tls, dns_ip: f.dns_ip, dns_port: f.dns_port });
      busy(e.currentTarget, false);
      msg.textContent = phTestText(r, f.dns_port);
      msg.dataset.state = r.ok && r.data && r.data.connected ? 'good' : 'crit';
      msg.hidden = false;
    });
    SECTIONS.pihole = {
      async load() {
        const r = await get('/api/v1/settings/pihole');
        if (!r.ok) return;
        const c = r.data;
        phInstances = (c.instances || []).slice();
        renderPh();
        Object.assign(phSaved, { 'ph-on': !!c.enabled, 'ph-chain': !!c.manage_dns_chain, 'ph-sync': c.sync_interval_sec || 30, 'ph-top': c.top_clients_count || 1000 });
        fill('pihole', phSaved);
      },
      groups: [{
        fields: ['ph-on', 'ph-chain', 'ph-sync', 'ph-top'], map: { sync_interval_sec: 'ph-sync', top_clients_count: 'ph-top' },
        save: (v) => api.put('/api/v1/settings/pihole', phPayload(v, phInstances)),
      }],
    };
  }

  // ── Geo-IP ──
  SECTIONS.geoip = {
    async load() {
      const r = await get('/api/v1/settings/ip2location');
      const has = !!(r.ok && r.data.has_api_key);
      $('st-geo-key').placeholder = has ? t('st.secret_set') : '';
      $('st-geo-clear').hidden = !has;
      const state = $('st-geo-state');
      if (!state.dataset.tested) state.textContent = has ? t('st.geo.key_set') : t('st.geo.no_key');
      fill('geoip', { 'geo-key': '' });
    },
    groups: [{ fields: ['geo-key'], errorField: 'geo-key', save: (v) => api.put('/api/v1/settings/ip2location', { api_key: v['geo-key'] }),
      after: () => SECTIONS.geoip.load() }],
  };
  $('st-geo-test').addEventListener('click', async (e) => {
    const state = $('st-geo-state');
    busy(e.currentTarget, true);
    const r = await post('/api/v1/settings/ip2location/test', {});
    busy(e.currentTarget, false);
    state.dataset.tested = '1';
    state.textContent = r.ok && r.data
      ? t('st.geo.test_ok', { country: r.data.country_name + ' (' + r.data.country_code + ')', ip: r.data.ip })
      : t('st.geo.test_failed', { error: errText(r) });
    state.classList.toggle('st-note-warn', !(r.ok && r.data));
  });
  $('st-geo-clear').addEventListener('click', async (e) => {
    if (!(await D.confirm({ title: t('st.geo.clear_title'), message: t('settings.autosave.clear_secret_confirm'), okLabel: t('st.remove'), danger: true }))) return;
    busy(e.currentTarget, true);
    const r = await put('/api/v1/settings/ip2location', { api_key: '', clear: true });
    busy(e.currentTarget, false);
    if (r.ok) { delete $('st-geo-state').dataset.tested; toast(t('st.geo.cleared')); SECTIONS.geoip.load(); } else toast(errText(r), 'error');
  });

  // ── Portal ──
  let portalSaved = { host: '', internal: '' };
  const PORTAL_MAP = { enabled: 'po-on', autoappear: 'po-auto', trust_owner_mapping: 'po-trust' };
  const WIDGET_MAP = { device: 'w-device', traffic: 'w-traffic', services: 'w-services', pihole: 'w-pihole' };
  function renderPortalPreview() {
    const v = valuesOf('portal');
    const host = U.portalHost(v['po-domain'], v['po-prefix'], portalSaved.internal);
    const box = $('st-po-preview');
    clear(box);
    box.appendChild(document.createTextNode(t('st.portal.reachable') + ' '));
    box.appendChild(el('strong', { class: 'st-mono', text: 'https://' + host }));
    if (host !== portalSaved.host) box.appendChild(document.createTextNode(' · ' + t('settings.portal.switch_warning')));
    $('st-po-prefix').disabled = !v['po-domain'];
  }
  SECTIONS.portal = {
    async load() {
      const [p, dm] = await Promise.all([get('/api/v1/settings/portal'), get('/api/v1/settings/domains')]);
      if (!p.ok) return;
      const d = p.data;
      const sel = $('st-po-domain');
      while (sel.options.length > 1) sel.remove(1);
      const verified = dm.ok ? (dm.data.domains || []).filter((x) => x.status === 'verified') : [];
      verified.forEach((x) => sel.appendChild(el('option', { value: x.domain, text: x.domain })));
      if (d.base_domain && !verified.some((x) => x.domain === d.base_domain)) sel.appendChild(el('option', { value: d.base_domain, text: d.base_domain }));
      $('st-po-nodomains').hidden = verified.length > 0;
      portalSaved = { host: d.effectiveHost || '', internal: d.internalHost || '' };
      const w = d.widgets || {};
      fill('portal', {
        'po-on': !!d.enabled, 'po-auto': d.autoappear !== false, 'po-trust': !!d.trustOwnerMapping,
        'w-device': !!w.device, 'w-traffic': !!w.traffic, 'w-services': !!w.services, 'w-pihole': !!w.pihole,
        'po-domain': d.base_domain || '', 'po-prefix': d.prefix == null ? 'home' : d.prefix,
      });
      renderPortalPreview();
    },
    onChange: renderPortalPreview,
    onDiscard: renderPortalPreview,
    groups: [
      { fields: Object.values(PORTAL_MAP).concat(Object.values(WIDGET_MAP)),
        save(v, d) {
          const body = U.pickDirty(PORTAL_MAP, v, d);
          const widgets = U.pickDirty(WIDGET_MAP, v, d);
          if (Object.keys(widgets).length) body.widgets = widgets;
          return api.put('/api/v1/settings/portal', body);
        } },
      { fields: ['po-domain', 'po-prefix'], errorField: 'po-prefix',
        confirm: (v) => ({ title: t('settings.portal.switch_title'), message: t('st.confirm.portal', { host: 'https://' + U.portalHost(v['po-domain'], v['po-prefix'], portalSaved.internal) }), okLabel: t('st.confirm.switch') }),
        save: (v) => api.put('/api/v1/settings/portal', { base_domain: v['po-domain'], prefix: v['po-prefix'].trim() }),
        after: () => SECTIONS.portal.load() },
    ],
  };

  // ── Backups ──
  const BK = '/api/v1/settings/backup';
  const bk = { auto: null, targets: null, files: [], busy: {}, results: {}, tfiles: {}, candidates: null, pubkey: null, offsite: null };
  const passEl = $('st-off-pass');
  const pass2El = $('st-off-pass2');
  CUSTOM['off-pass'] = {
    get: () => (passEl.value || pass2El.value ? passEl.value + '\u0000' + pass2El.value : ''),
    set: (v) => { const s = String(v || '').split('\u0000'); passEl.value = s[0] || ''; pass2El.value = s[1] || ''; renderStrength(); },
  };
  function renderStrength() {
    const r = O.passphraseStrength(passEl.value);
    const box = $('st-off-strength');
    const text = $('st-off-strength-text');
    const mismatch = pass2El.value !== '' && pass2El.value !== passEl.value;
    box.dataset.level = r.level;
    box.classList.toggle('st-mismatch', mismatch);
    if (mismatch) text.textContent = t('offsite.passphrase_mismatch');
    else if (r.level === 'short') text.textContent = t('offsite.strength_short', { n: r.missing });
    else if (r.level === 'weak') text.textContent = t('offsite.strength_weak');
    else if (r.level === 'ok') text.textContent = t('offsite.strength_ok');
    else if (r.level === 'strong') text.textContent = t('offsite.strength_strong');
    else text.textContent = bk.offsite && bk.offsite.passphrase_set ? t('offsite.passphrase_set') : t('offsite.passphrase_missing');
  }
  [passEl, pass2El].forEach((n) => n.addEventListener('input', () => { renderStrength(); $('st-off-passfield').dispatchEvent(new Event('change', { bubbles: true })); }));

  function bkHero() {
    const a = bk.auto;
    const newest = bk.files[0];
    const last = (a && a.lastRun) || (newest && newest.created) || null;
    $('st-bk-last').textContent = last ? (O.fmtAgo(last, lang) || O.fmtDateTime(last, lang)) : t('st.bk.never');
    $('st-bk-last-sub').textContent = newest ? O.fmtDateTime(newest.created, lang) + ' · ' + O.fmtBytes(newest.size) : '';
    const next = a ? U.nextBackupAt(a.lastRun, a.schedule, a.enabled, Date.now()) : null;
    $('st-bk-next').textContent = next ? O.fmtDateTime(new Date(next).toISOString(), lang) : t('st.bk.auto_off');
    $('st-bk-next-sub').textContent = a && a.enabled ? t('autobackup.schedule_' + a.schedule) : '';
    const ts = bk.targets || [];
    const enabled = ts.filter((x) => x.enabled);
    const failing = enabled.filter((x) => x.last_status === 'failed' || x.last_verify_status === 'failed');
    $('st-bk-off').textContent = enabled.length ? t('st.bk.off_ok', { ok: enabled.length - failing.length, n: enabled.length }) : t('st.bk.off_none');
    $('st-bk-off-sub').textContent = failing.length ? t('st.bk.off_failing', { names: failing.map((x) => x.name).join(', ') }) : '';
    $('st-bk-off-stat').dataset.state = failing.length ? 'crit' : enabled.length ? 'good' : '';
    setDot('backup', failing.length > 0);
  }
  async function loadTargets() {
    const r = await get(BK + '/targets');
    if (r.ok) bk.targets = r.targets || [];
    renderTargets(r.ok ? null : errText(r));
    bkHero();
  }
  function targetResult(res) {
    if (!res) return null;
    return el('div', { class: 'st-result', 'data-state': res.ok ? 'good' : 'crit', role: 'status' }, [
      el('span', { text: res.text }),
      res.detail ? el('code', { class: 'st-code', text: res.detail }) : null,
      res.lines && res.lines.length ? el('div', { class: 'st-li-sub', text: res.lines.join(' · ') }) : null,
      res.warnings && res.warnings.length ? el('ul', { class: 'st-warnlist' }, res.warnings.map((w) => el('li', { text: w }))) : null,
      res.note ? el('div', { class: 'st-li-sub', text: res.note }) : null,
    ]);
  }
  function targetFiles(tg) {
    const f = bk.tfiles[tg.id];
    if (!f) return null;
    let body;
    if (f.error) body = el('div', { class: 'st-result', 'data-state': 'crit', text: f.error });
    else if (!f.files.length) body = el('p', { class: 'st-empty', text: t('offsite.files_empty') });
    else {
      body = el('ul', { class: 'st-sublist' }, f.files.map((x) => el('li', {}, [
        el('span', { class: 'st-mono st-grow', text: x.name }), el('span', { class: 'st-li-sub', text: O.fmtBytes(x.size) + (x.modified ? ' · ' + O.fmtDateTime(x.modified, lang) : '') }),
      ])));
    }
    return el('div', { class: 'st-tfiles', id: 'st-tfiles-' + tg.id }, [el('div', { class: 'st-sub-title', text: t('offsite.files_title') }), body, el('p', { class: 'st-hint', text: t('offsite.files_note') })]);
  }
  function tbtn(tg, name, label, fn, extra) {
    const b = el('button', Object.assign({ type: 'button', class: 'st-btn st-btn-sm' + (name === 'delete' ? ' st-btn-danger' : ''), 'data-action': name, text: label, disabled: !FEATURES.scheduled_backups || !!bk.busy[tg.id] }, extra || {}));
    if (bk.busy[tg.id] === name) b.classList.add('is-loading');
    b.addEventListener('click', () => fn(tg));
    return b;
  }
  function renderTargets(error) {
    const box = $('st-off-targets');
    clear(box);
    if (error && !bk.targets) { box.appendChild(empty(error)); return; }
    const list = bk.targets || [];
    if (!list.length) { box.appendChild(empty(t('offsite.targets_empty'))); return; }
    list.forEach((tg) => {
      const st = O.targetStatus(tg, bk.busy[tg.id] === 'run');
      const state = st.cls === 'tag-green' ? 'good' : st.cls === 'tag-red' ? 'crit' : st.cls === 'tag-blue' ? 'info' : 'off';
      const meta = [O.targetSummary(tg), t('offsite.keep', { n: tg.keep }),
        tg.last_run_at ? t('offsite.last_run', { x: O.fmtAgo(tg.last_run_at, lang) }) : t('offsite.never_run'),
        tg.last_verify_at ? t('offsite.verify_last', { x: O.fmtAgo(tg.last_verify_at, lang) }) : t('offsite.verify_never')];
      box.appendChild(el('li', { class: 'st-li st-li-target' + (tg.enabled ? '' : ' st-paused'), 'data-target-id': String(tg.id), 'data-type': tg.type }, [
        el('span', { class: 'st-typebadge', text: O.TYPE_LABELS[tg.type] || tg.type }),
        el('div', { class: 'st-li-main' }, [
          el('div', { class: 'st-li-title', text: tg.name }),
          el('div', { class: 'st-li-sub', text: meta.join(' · ') }),
          tg.config_error ? el('div', { class: 'st-li-sub st-crit', text: t('offsite.config_error') }) : null,
          tg.last_status === 'failed' && tg.last_error ? el('code', { class: 'st-code st-crit', text: tg.last_error }) : null,
        ]),
        el('div', { class: 'st-li-pills' }, [tg.enabled ? null : pill('off', t('offsite.paused')), pill(state, t(st.key))]),
        el('div', { class: 'st-li-actions st-li-actions-wrap' }, [
          tbtn(tg, 'test', t('offsite.act_test'), testTarget),
          tbtn(tg, 'run', t('offsite.act_run'), runTarget),
          tbtn(tg, 'verify', t('st.bk.act_verify'), verifyTarget),
          tbtn(tg, 'files', t('offsite.act_files'), toggleFiles, { 'aria-expanded': bk.tfiles[tg.id] ? 'true' : 'false', 'aria-controls': 'st-tfiles-' + tg.id }),
          tbtn(tg, 'edit', t('st.edit'), openTarget),
          tbtn(tg, 'delete', t('st.delete_dots'), deleteTarget),
        ]),
        targetResult(bk.results[tg.id]),
        targetFiles(tg),
      ]));
    });
  }
  async function testTarget(tg) {
    bk.busy[tg.id] = 'test'; delete bk.results[tg.id]; renderTargets();
    const r = await post(BK + '/targets/' + tg.id + '/test');
    bk.results[tg.id] = r.ok ? { ok: true, text: t('offsite.test_ok'), detail: r.detail || '' }
      : { ok: false, text: O.errorCode(r) === 'TRANSPORT_FAILED' ? t('offsite.test_failed') : O.errorText(r), detail: O.errorDetail(r) };
    delete bk.busy[tg.id]; renderTargets();
  }
  async function runTarget(tg) {
    bk.busy[tg.id] = 'run'; delete bk.results[tg.id]; renderTargets();
    const r = await post(BK + '/targets/' + tg.id + '/run');
    if (r.ok) {
      bk.results[tg.id] = { ok: true, text: t('offsite.run_ok', { file: r.file || '' }) + (r.deleted ? ' · ' + t('offsite.run_deleted', { n: r.deleted }) : '') };
      delete bk.tfiles[tg.id];
    } else {
      bk.results[tg.id] = { ok: false, text: O.errorText(r), detail: O.errorCode(r) === 'UPLOAD_FAILED' ? '' : O.errorDetail(r) };
      if (O.errorCode(r) === 'PASSPHRASE_NOT_SET') passEl.focus();
    }
    delete bk.busy[tg.id];
    await loadTargets();
  }
  async function verifyTarget(tg) {
    bk.busy[tg.id] = 'verify'; bk.results[tg.id] = { ok: true, text: t('offsite.verify_running') }; renderTargets();
    const r = await post(BK + '/targets/' + tg.id + '/verify');
    bk.results[tg.id] = r.ok
      ? { ok: true, text: t('offsite.verify_ok', { file: r.file || '' }), lines: O.verifyLines(r, lang), warnings: (r.warnings || []).map(O.verifyWarningText).filter(Boolean), note: t('offsite.verify_note') }
      : { ok: false, text: t('offsite.verify_failed') + ' · ' + O.errorText(r), detail: O.errorDetail(r) };
    delete bk.busy[tg.id];
    await loadTargets();
  }
  async function toggleFiles(tg) {
    if (bk.tfiles[tg.id]) { delete bk.tfiles[tg.id]; renderTargets(); return; }
    bk.busy[tg.id] = 'files'; renderTargets();
    const r = await get(BK + '/targets/' + tg.id + '/files');
    bk.tfiles[tg.id] = r.ok ? { files: r.files || [] } : { error: O.errorText(r) };
    delete bk.busy[tg.id]; renderTargets();
  }
  async function deleteTarget(tg) {
    if (!(await D.confirm({ title: t('offsite.delete_title'), message: t('offsite.delete_msg', { name: tg.name }), detail: t('offsite.delete_detail'), okLabel: t('common.delete'), danger: true }))) return;
    bk.busy[tg.id] = 'delete'; renderTargets();
    const r = await del(BK + '/targets/' + tg.id);
    delete bk.busy[tg.id];
    if (r.ok) { toast(t('offsite.deleted_target')); delete bk.results[tg.id]; } else toast(O.errorText(r), 'error');
    loadTargets();
  }

  // Target dialog
  let otEditing = null;
  let otType = 'sftp';
  const otModal = $('st-ot-modal');
  const otErr = $('st-ot-err');
  const OT_INPUTS = { host: 'st-ot-host', port: 'st-ot-port', username: 'st-ot-user', path: 'st-ot-path', share: 'st-ot-share', domain: 'st-ot-domain',
    endpoint: 'st-ot-endpoint', region: 'st-ot-region', bucket: 'st-ot-bucket', prefix: 'st-ot-prefix', access_key_id: 'st-ot-akid',
    secret_access_key: 'st-ot-secret', url: 'st-ot-url', password: 'st-ot-pw' };
  function otShowType(type) {
    otType = type;
    otModal.querySelectorAll('.st-typecard').forEach((c) => c.setAttribute('aria-pressed', c.dataset.type === type ? 'true' : 'false'));
    otModal.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for.split(' ').indexOf(type) < 0; });
    $('st-ot-port').placeholder = O.DEFAULT_PORTS[type] ? String(O.DEFAULT_PORTS[type]) : '';
    const cfg = (otEditing && otEditing.config) || {};
    const hasPw = !!(otEditing && (type === 'smb' || type === 'webdav') && cfg.has_password);
    $('st-ot-clearpw-row').hidden = !hasPw;
    $('st-ot-pw-hint').hidden = !hasPw;
    $('st-ot-secret-hint').hidden = !(otEditing && type === 's3' && cfg.has_secret_access_key);
    if (type === 'sftp') loadPubkey();
    if (type === 'sftp' || type === 'smb') fillCandidates(type);
  }
  otModal.querySelectorAll('.st-typecard').forEach((c) => c.addEventListener('click', () => { if (!otEditing) { otErr.hidden = true; otShowType(c.dataset.type); } }));
  function openTarget(tg) {
    otEditing = tg || null;
    otErr.hidden = true;
    $('st-ot-form').reset();
    otModal.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    const title = $('st-ot-title');
    title.textContent = otEditing ? title.dataset.edit : title.dataset.add;
    otModal.querySelectorAll('.st-typecard').forEach((c) => { c.disabled = !!otEditing && c.dataset.type !== otEditing.type; });
    $('st-ot-type-hint').hidden = !!otEditing;
    if (otEditing) {
      const c = otEditing.config || {};
      $('st-ot-name').value = otEditing.name || '';
      $('st-ot-keep').value = otEditing.keep || 14;
      $('st-ot-enabled').checked = !!otEditing.enabled;
      ['host', 'port', 'username', 'path', 'share', 'domain', 'endpoint', 'region', 'bucket', 'prefix', 'url', 'access_key_id'].forEach((k) => {
        if (c[k] != null && OT_INPUTS[k]) $(OT_INPUTS[k]).value = String(c[k]);
      });
      $('st-ot-pathstyle').checked = !!c.path_style;
    }
    $('st-ot-l4').value = '';
    $('st-ot-l4-note').hidden = true;
    otShowType(otEditing ? otEditing.type : 'sftp');
    window.openModal('st-ot-modal');
    (otEditing ? $('st-ot-name') : otModal.querySelector('.st-typecard[aria-pressed="true"]')).focus();
  }
  $('st-off-add').addEventListener('click', () => openTarget(null));
  $('st-ot-form').addEventListener('submit', (e) => { e.preventDefault(); saveTarget(); });
  $('st-ot-save').addEventListener('click', saveTarget);
  function otError(text, inputId) {
    otErr.textContent = text;
    otErr.hidden = false;
    const input = inputId && $(inputId);
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
  }
  async function saveTarget() {
    otErr.hidden = true;
    otModal.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    const val = (id) => $(id).value;
    const values = {
      name: val('st-ot-name'), keep: val('st-ot-keep'), enabled: $('st-ot-enabled').checked,
      host: val('st-ot-host'), port: val('st-ot-port'), username: val('st-ot-user'), path: val('st-ot-path'), share: val('st-ot-share'),
      domain: val('st-ot-domain'), endpoint: val('st-ot-endpoint'), region: val('st-ot-region'), bucket: val('st-ot-bucket'),
      prefix: val('st-ot-prefix'), access_key_id: val('st-ot-akid'), secret_access_key: val('st-ot-secret'), url: val('st-ot-url'),
      password: val('st-ot-pw'), clear_password: $('st-ot-clearpw').checked, path_style: $('st-ot-pathstyle').checked,
    };
    if (!values.name.trim()) { otError(O.errorText({ code: 'INVALID_NAME' }), 'st-ot-name'); return; }
    const body = O.targetPayload(otType, values, !!otEditing);
    const wasNew = !otEditing;
    const btn = $('st-ot-save');
    busy(btn, true);
    const r = otEditing ? await put(BK + '/targets/' + otEditing.id, body) : await post(BK + '/targets', body);
    busy(btn, false);
    if (r.ok && r.target) {
      window.closeModal('st-ot-modal');
      toast(t('offsite.saved_target'));
      delete bk.results[r.target.id];
      await loadTargets();
      const tg = (bk.targets || []).find((x) => x.id === r.target.id);
      if (tg) testTarget(tg); // "Speichern & testen" (for SFTP this also shows whether the key is in place)
      return;
    }
    const code = O.errorCode(r);
    const field = code === 'INVALID_CONFIG' ? O.configField(r) : null;
    otError(O.errorText(r), field ? OT_INPUTS[field] : code === 'INVALID_NAME' ? 'st-ot-name' : code === 'INVALID_KEEP' ? 'st-ot-keep' : null);
    if (wasNew && r.feature) otError(t('st.err.license'));
  }
  const l4 = $('st-ot-l4');
  async function fillCandidates(type) {
    if (!bk.candidates) {
      const r = await get(BK + '/targets/l4-candidates');
      bk.candidates = r.ok ? (r.routes || []) : [];
    }
    const list = O.sortCandidates(bk.candidates, type);
    while (l4.options.length > 1) l4.remove(1);
    list.forEach((c) => {
      const flags = [];
      if (!c.internal) flags.push(t('offsite.l4_public'));
      if (!c.enabled) flags.push(t('offsite.l4_off'));
      const lbl = /^L4 :\d+$/.test(String(c.label)) ? c.label : c.label + ' · TCP :' + c.listen_port;
      l4.appendChild(el('option', { value: String(c.route_id), text: lbl + ' → ' + c.target + (flags.length ? ' (' + flags.join(', ') + ')' : '') }));
    });
    l4.disabled = !list.length;
  }
  l4.addEventListener('change', () => {
    const c = (bk.candidates || []).find((x) => String(x.route_id) === l4.value);
    const note = $('st-ot-l4-note');
    if (!c) { note.hidden = true; return; }
    $('st-ot-host').value = c.connect_host;
    $('st-ot-port').value = String(c.connect_port);
    if (!$('st-ot-name').value.trim()) $('st-ot-name').value = String(c.label).slice(0, 64);
    let text = t('offsite.l4_filled', { host: c.connect_host, port: c.connect_port });
    if (!c.internal) text += ' ' + t('offsite.l4_public_warn');
    if (!c.enabled) text += ' ' + t('offsite.l4_off_warn');
    note.textContent = text;
    note.classList.toggle('st-warn-text', !c.internal || !c.enabled);
    note.hidden = false;
  });
  const pubkey = $('st-ot-pubkey');
  async function loadPubkey() {
    if (bk.pubkey) { pubkey.value = bk.pubkey; return; }
    if (!FEATURES.scheduled_backups) { pubkey.value = ''; pubkey.placeholder = t('st.err.license'); return; }
    const r = await get(BK + '/ssh-key');
    if (r.ok && r.public_key) { bk.pubkey = r.public_key; pubkey.value = r.public_key; } else { pubkey.value = ''; pubkey.placeholder = O.errorText(r); }
  }
  $('st-ot-keycopy').addEventListener('click', () => { if (pubkey.value) copyText(pubkey.value); });
  $('st-ot-keyrotate').addEventListener('click', async (e) => {
    if (!FEATURES.scheduled_backups) return;
    if (!(await D.confirm({ title: t('offsite.key_rotate_title'), message: t('offsite.key_rotate_msg'), okLabel: t('offsite.key_rotate_ok'), danger: true }))) return;
    busy(e.currentTarget, true);
    const r = await post(BK + '/ssh-key/rotate');
    busy(e.currentTarget, false);
    if (r.ok && r.public_key) { bk.pubkey = r.public_key; pubkey.value = r.public_key; toast(t('offsite.key_rotated')); } else toast(O.errorText(r), 'error');
  });

  async function loadFiles() {
    const box = $('st-bk-files');
    const r = await get('/api/v1/settings/autobackup/list');
    bk.files = (r.ok && r.files) || [];
    clear(box);
    if (!bk.files.length) { box.appendChild(empty(t('autobackup.no_files'))); return; }
    bk.files.forEach((f) => {
      const dl = el('a', { class: 'st-btn st-btn-sm', href: '/api/v1/settings/autobackup/download/' + encodeURIComponent(f.filename), download: f.filename, text: t('st.download') });
      const rm = el('button', { type: 'button', class: 'st-icon-btn', 'aria-label': t('st.bk.delete_label', { name: f.filename }), title: t('st.bk.delete_label', { name: f.filename }) }, [icon(ICON_TRASH)]);
      rm.addEventListener('click', async () => {
        if (!(await D.confirm({ title: t('st.bk.delete_title'), message: t('autobackup.confirm_delete'), okLabel: t('common.delete'), danger: true }))) return;
        const res = await del('/api/v1/settings/autobackup/' + encodeURIComponent(f.filename));
        if (res.ok) { loadFiles().then(bkHero); } else toast(errText(res), 'error');
      });
      box.appendChild(el('li', { class: 'st-li' }, [
        el('span', { class: 'st-mono st-li-main st-wrap', text: f.filename }),
        el('span', { class: 'st-li-sub', text: O.fmtBytes(f.size) + ' · ' + O.fmtDateTime(f.created, lang) }),
        el('div', { class: 'st-li-actions' }, [dl, rm]),
      ]));
    });
  }
  async function loadPremig() {
    const box = $('st-premig');
    const r = await get(BK + '/pre-migration');
    clear(box);
    if (!r.ok) { box.appendChild(empty(O.errorText(r))); return; }
    const files = r.files || [];
    if (!files.length) { box.appendChild(empty(t('premig.empty'))); return; }
    files.forEach((f) => box.appendChild(el('li', { class: 'st-li', 'data-name': f.name }, [
      el('div', { class: 'st-li-main' }, [el('div', { class: 'st-li-title', text: t('premig.versions', { from: f.from_version || '?', to: f.to_version || '?' }) }), el('div', { class: 'st-li-sub st-mono', text: f.name })]),
      el('span', { class: 'st-li-sub', text: O.fmtBytes(f.size) + ' · ' + O.fmtDateTime(f.created_at, lang) }),
      el('a', { class: 'st-btn st-btn-sm', href: BK + '/pre-migration/' + encodeURIComponent(f.name), download: f.name, text: t('st.download') }),
    ])));
  }
  SECTIONS.backup = {
    async load() {
      const [a, off] = await Promise.all([get('/api/v1/settings/autobackup'), get(BK + '/offsite')]);
      if (a.ok) bk.auto = a.data;
      if (off.ok) bk.offsite = off;
      $('st-off-abhint').hidden = !(a.ok && !a.data.enabled);
      fill('backup', {
        'ab-on': !!(a.ok && a.data.enabled), 'ab-schedule': (a.ok && a.data.schedule) || 'daily', 'ab-keep': (a.ok && a.data.retention) || 5,
        'off-pass': '', 'off-key': !(off.ok && off.include_key === false),
      });
      passEl.placeholder = off.ok && off.passphrase_set ? t('st.secret_set') : t('offsite.passphrase_ph_new');
      renderStrength();
      await Promise.all([loadTargets(), loadFiles(), loadPremig()]);
      bkHero();
    },
    validate(v, d) {
      if (!d.includes('off-pass')) return {};
      const s = O.passphraseStrength(passEl.value);
      if (passEl.value !== pass2El.value) return { 'off-pass': t('offsite.passphrase_mismatch') };
      if (s.level === 'short' || s.level === 'empty') return { 'off-pass': t('offsite.strength_short', { n: s.missing }) };
      return {};
    },
    groups: [
      { fields: ['ab-on', 'ab-schedule', 'ab-keep'], map: { retention: 'ab-keep', schedule: 'ab-schedule' }, errorField: 'ab-on',
        save: (v) => api.put('/api/v1/settings/autobackup', { enabled: v['ab-on'], schedule: v['ab-schedule'], retention: v['ab-keep'] }),
        after: async () => { const a = await get('/api/v1/settings/autobackup'); if (a.ok) { bk.auto = a.data; $('st-off-abhint').hidden = a.data.enabled; } bkHero(); } },
      { fields: ['off-pass'], errorField: 'off-pass', save: () => api.put(BK + '/offsite', { passphrase: passEl.value }),
        after: (r) => { bk.offsite = r; passEl.value = ''; pass2El.value = ''; commit('backup', ['off-pass']); passEl.placeholder = t('st.secret_set'); renderStrength(); } },
      { fields: ['off-key'], errorField: 'off-key', save: (v) => api.put(BK + '/offsite', { include_key: v['off-key'] }) },
    ],
  };
  $('st-bk-run').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    const r = await post('/api/v1/settings/autobackup/run');
    busy(b, false);
    const msg = $('st-bk-msg');
    msg.textContent = r.ok ? t('st.bk.run_ok', { file: r.filename }) : errText(r);
    msg.dataset.state = r.ok ? 'good' : 'crit';
    if (r.ok) { const a = await get('/api/v1/settings/autobackup'); if (a.ok) bk.auto = a.data; await loadFiles(); bkHero(); }
  });
  $('st-bk-download').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    try {
      const resp = await fetch('/api/v1/settings/backup', { credentials: 'same-origin' });
      if (!resp.ok) throw new Error(t('st.bk.download_failed'));
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const m = (resp.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const a = el('a', { href: url, download: m ? m[1] : 'gatecontrol-backup.json' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) { toast(t('settings.backup_failed', { error: err.message }), 'error'); }
    busy(b, false);
  });
  document.addEventListener('gc:backup', () => { if (current === 'backup') { clearTimeout(bk.sse); bk.sse = setTimeout(loadTargets, 400); } });

  // Restore
  let rsFile = null;
  let rsReady = false;
  let rsPluginAware = false;
  $('st-rs-pick').addEventListener('click', () => $('st-rs-file').click());
  $('st-rs-file').addEventListener('change', (e) => {
    rsFile = e.target.files[0] || null;
    $('st-rs-passrow').hidden = true;
    $('st-rs-pass').value = '';
    if (rsFile) previewRestore();
  });
  $('st-rs-check').addEventListener('click', previewRestore);
  $('st-rs-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); previewRestore(); } });
  function restoreForm() {
    const fd = new FormData();
    fd.append('backup', rsFile);
    if (!$('st-rs-passrow').hidden && $('st-rs-pass').value) fd.append('passphrase', $('st-rs-pass').value);
    return fd;
  }
  async function restoreCall(url) {
    try {
      const resp = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': window.GC.csrfToken }, body: restoreForm() });
      return await resp.json();
    } catch (err) { return { ok: false, error: err.message }; }
  }
  function restoreError(r) {
    if (r && (r.code === 'PASSPHRASE_REQUIRED' || r.code === 'DECRYPT_FAILED')) { $('st-rs-passrow').hidden = false; $('st-rs-pass').focus(); }
    return r && r.code ? O.errorText(r, ['offsite.err.generic', r.error || '']) : (r && r.error) || t('st.err.generic');
  }
  async function previewRestore() {
    if (!rsFile) return;
    $('st-rs-box').hidden = false;
    const prev = $('st-rs-preview');
    prev.textContent = t('common.loading');
    rsReady = false;
    rsPluginAware = false;
    $('st-rs-go').hidden = true;
    const r = await restoreCall('/api/v1/settings/restore/preview');
    if (!r.ok) { prev.textContent = restoreError(r); prev.dataset.state = 'crit'; return; }
    const s = r.summary;
    let line = t('st.bk.restore_summary', { peers: s.peers, routes: s.routes, settings: s.settings, webhooks: s.webhooks, date: O.fmtDateTime(s.created_at, lang) });
    if (r.encrypted) line += ' · ' + t('offsite.restore_encrypted') + ' · ' + t(r.include_key ? 'offsite.restore_with_key' : 'offsite.restore_without_key') + (r.gc_version ? ' · v' + r.gc_version : '');
    prev.textContent = line;
    prev.dataset.state = '';
    rsPluginAware = !!s.plugin_aware;
    rsReady = true;
    $('st-rs-go').hidden = false;
  }
  $('st-rs-go').addEventListener('click', async (e) => {
    if (!rsReady) return;
    const detail = t('settings.restore_warning_detail') + (rsPluginAware ? ' ' + t('settings.restore_warning_plugins') : '');
    if (!(await D.confirm({ title: t('settings.restore_confirm'), message: t('settings.restore_warning'), detail, okLabel: t('settings.restore_confirm_ok'), danger: true }))) return;
    busy(e.currentTarget, true);
    const r = await restoreCall('/api/v1/settings/restore');
    busy(e.currentTarget, false);
    if (r.ok) {
      const x = r.restored;
      await D.alert({ title: t('settings.restore_done_title'), message: t('settings.restore_done', { peers: x.peers, routes: x.routes, settings: x.settings, webhooks: x.webhooks }) });
      window.location.reload();
    } else { $('st-rs-preview').textContent = restoreError(r); $('st-rs-preview').dataset.state = 'crit'; }
  });

  // ── Updates ──
  let auSaved = null;
  function renderTimeline() {
    const v = valuesOf('updates');
    const segs = U.windowSegments(v['au-from'], v['au-to']);
    const w1 = $('st-au-win1');
    const w2 = $('st-au-win2');
    [w1, w2].forEach((w, i) => {
      const s = segs[i];
      w.hidden = !s;
      if (s) { w.style.left = s.left + '%'; w.style.width = s.width + '%'; }
    });
    const nowStr = O.timeIn(v['au-tz']) || '';
    const nowMin = U.minutesOf(nowStr);
    const now = $('st-au-now');
    now.hidden = nowMin == null;
    if (nowMin != null) now.style.left = (nowMin / 14.4) + '%';
    const wait = nowMin == null ? null : U.minutesToWindow(v['au-from'], v['au-to'], nowMin);
    const parts = [t('st.au.caption_tz', { tz: String(v['au-tz']).replace(/_/g, ' ') })];
    if (nowStr) parts.push(t('st.au.caption_now', { time: nowStr }));
    if (wait === 0) parts.push(t('st.au.caption_open'));
    else if (wait != null) parts.push(t('st.au.caption_next', { h: Math.floor(wait / 60), m: wait % 60 }));
    if (!segs.length) parts.push(t('autoupdate.window_same'));
    $('st-au-caption').textContent = parts.join(' · ');
  }
  function renderUpdateSh() {
    const u = auSaved && auSaved.update_sh;
    const state = $('st-ush-state');
    let mismatch = false;
    if (!u || u.image_version == null) state.textContent = t('st.ush.unknown_state');
    else if (u.matches) state.textContent = t('st.ush.ok');
    else {
      mismatch = true;
      state.textContent = u.host_version == null ? t('updatesh.unknown') : t('updatesh.mismatch', { host: u.host_version, image: u.image_version });
    }
    state.classList.toggle('st-warn-text', mismatch);
    const waiting = !!(auSaved && auSaved.last_action === 'waiting_window');
    $('st-au-waiting').hidden = !waiting;
    setDot('updates', mismatch || waiting);
  }
  async function loadAutoUpdate() {
    const d = await get('/api/v1/system/auto-update');
    if (!d || d.ok === false) return null;
    auSaved = d;
    return d;
  }
  SECTIONS.updates = {
    async load() {
      const d = await loadAutoUpdate();
      if (!d) return;
      const w = d.window || {};
      let tz = w.tz || O.DEFAULT_TZ;
      const browserTz = O.browserTimeZone(window.Intl);
      if (!w.enabled && tz === O.DEFAULT_TZ && browserTz && browserTz !== tz && O.timeIn(browserTz)) tz = browserTz;
      const tzSel = $('st-au-tz');
      clear(tzSel);
      O.timeZones(window.Intl, tz).forEach((z) => tzSel.appendChild(el('option', { value: z, text: z.replace(/_/g, ' ') })));
      fill('updates', {
        'au-mode': d.mode || 'auto', 'au-win': !!w.enabled, 'au-from': O.isHHMM(w.start) ? w.start : '03:00', 'au-to': O.isHHMM(w.end) ? w.end : '05:00',
        'au-tz': tz, 'au-mail': d.notify_email !== false,
      });
      renderUpdateSh();
      renderTimeline();
    },
    onChange: renderTimeline,
    onDiscard: renderTimeline,
    validate(v, d) {
      if (!d.some((x) => ['au-win', 'au-from', 'au-to', 'au-tz'].includes(x))) return {};
      const p = O.windowProblem({ enabled: v['au-win'], start: v['au-from'], end: v['au-to'], tz: v['au-tz'] });
      return p ? { 'au-from': p === 'same' ? t('autoupdate.window_same') : O.errorText({ code: 'INVALID_WINDOW' }) } : {};
    },
    groups: [
      { fields: ['au-mode'], errorField: 'au-mode', save: (v) => api.put('/api/v1/system/auto-update', { mode: v['au-mode'] }) },
      { fields: ['au-win', 'au-from', 'au-to', 'au-tz'], errorField: 'au-from',
        save: (v) => api.put('/api/v1/system/auto-update', { window: { enabled: v['au-win'], start: v['au-from'], end: v['au-to'], tz: v['au-tz'] } }),
        after: (r) => { auSaved = r; renderUpdateSh(); } },
      { fields: ['au-mail'], errorField: 'au-mail', save: (v) => api.put('/api/v1/system/auto-update', { notify_email: v['au-mail'] }) },
    ],
  };
  setInterval(() => { if (current === 'updates') renderTimeline(); }, 30000);
  $('st-au-trigger').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    const r = await post('/api/v1/system/auto-update/trigger');
    busy(b, false);
    const reasons = { cooldown: 'autoupdate.trigger_cooldown', stale_no_cron: 'autoupdate.not_configured', not_manual_mode: 'autoupdate.trigger_not_manual' };
    if (r.queued) toast(t('autoupdate.trigger_queued'));
    else toast(t(reasons[r.reason] || 'autoupdate.err.generic'), 'error');
  });
  $('st-ush-show').addEventListener('click', (e) => {
    const box = $('st-ush-cmds');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
  });
  $('st-ush-copy').addEventListener('click', () => copyText($('st-ush-cmd').textContent));

  // ── Lizenz ──
  const licForm = $('st-lic-form');
  if (licForm) licForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('st-lic-msg');
    const b = licForm.querySelector('button[type="submit"]');
    busy(b, true);
    const r = await post('/api/v1/license/activate', { license_key: $('st-lic-key').value.trim(), signing_key: $('st-lic-sig').value.trim() });
    busy(b, false);
    if (r.ok) { toast(t('license.activated')); setTimeout(() => location.reload(), 900); } else { msg.textContent = errText(r); msg.dataset.state = 'crit'; }
  });
  const licRefresh = $('st-lic-refresh');
  if (licRefresh) licRefresh.addEventListener('click', async () => {
    busy(licRefresh, true);
    const r = await post('/api/v1/license/refresh');
    busy(licRefresh, false);
    if (r.ok) { toast(t('license.refresh_success')); setTimeout(() => location.reload(), 900); } else toast(errText(r), 'error');
  });
  const licRemove = $('st-lic-remove');
  if (licRemove) licRemove.addEventListener('click', async () => {
    if (!(await D.confirm({ title: t('st.lic.remove_title'), message: t('license.remove_confirm'), okLabel: t('st.lic.remove_ok'), danger: true }))) return;
    busy(licRemove, true);
    const r = await del('/api/v1/license');
    busy(licRemove, false);
    if (r.ok) { toast(t('license.removed')); setTimeout(() => location.reload(), 900); } else toast(errText(r), 'error');
  });

  // ── Gefahrenzone ──
  $('st-wg-stop').addEventListener('click', () => {
    $('st-wgstop-pw').value = '';
    $('st-wgstop-err').hidden = true;
    window.openModal('st-wgstop-modal');
    $('st-wgstop-pw').focus();
  });
  $('st-wgstop-form').addEventListener('submit', (e) => { e.preventDefault(); $('st-wgstop-go').click(); });
  $('st-wgstop-go').addEventListener('click', async (e) => {
    const pw = $('st-wgstop-pw');
    const err = $('st-wgstop-err');
    err.hidden = true;
    if (!pw.value) { err.textContent = t('error.wireguard.password_required'); err.hidden = false; pw.focus(); return; }
    busy(e.currentTarget, true);
    const r = await post('/api/v1/wg/stop', { password: pw.value });
    busy(e.currentTarget, false);
    if (r.ok) { window.closeModal('st-wgstop-modal'); toast(t('st.danger.wg_stopped')); } else { err.textContent = errText(r); err.hidden = false; pw.focus(); }
  });

  // ══ Start ═════════════════════════════════════════════════════════════
  // Attention dots that matter before their section is opened.
  (async function dots() {
    const [tg, au] = await Promise.all([get(BK + '/targets'), loadAutoUpdate()]);
    if (tg.ok) { bk.targets = tg.targets || []; setDot('backup', bk.targets.some((x) => x.enabled && (x.last_status === 'failed' || x.last_verify_status === 'failed'))); }
    if (au) renderUpdateSh();
  })();

  const start = U.resolveLocation({ hash: location.hash, search: location.search }, { known, sectionOfElement });
  let first = start ? start.section : null;
  if (!first) { try { const s = localStorage.getItem('gc-settings-section'); if (known.includes(s)) first = s; } catch (_) { /* optional */ } }
  show(first || known[0], { anchor: start && start.anchor, force: true });

  // For tests and the quick search on this page.
  window.GCSettings = { show, save, discard, dirty: () => (current ? dirtyOf(current) : []), current: () => current };
})();
