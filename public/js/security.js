'use strict';

// Sicherheits-Check page (security.njk; docs/feature-release-b.md §1 + §10).
// Tab „Check“: GET /api/v1/security/check → summary tiles, checks grouped by
// severity (status pill, affected items, fix action: api → confirm + request
// + re-check, link → navigate, copy → text + clipboard). Tab „Öffentlich
// erreichbar“: GET /api/v1/security/exposure (+ GET /api/v1/zones for the
// links into the zones page) → table with protection marks, filters, search.
// Live refresh on the SSE events gc:security / gc:routes (debounced).
// UMD: the pure helpers are testable in node:test; DOM via el() only — all
// server data (labels, hosts, the fix object) is untrusted.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCSecurityPage = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  // ─── Pure helpers ──────────────────────────────────────────────────────
  const SEVERITIES = ['critical', 'warning', 'info'];
  const CHECK_IDS = ['admin_2fa', 'require_2fa', 'hsts', 'caa', 'waf_coverage', 'waf_ready', 'public_unprotected', 'backup_offsite', 'tls_min', 'auto_update'];
  // Checks that report 'na' without a licence feature → licence hint.
  const CHECK_FEATURE = { waf_coverage: 'waf', waf_ready: 'waf', backup_offsite: 'scheduled_backups' };
  const STATUS_ORDER = { fail: 0, na: 1, pass: 2 };
  const PILL_CLASS = { pass: 'tag-green', critical: 'tag-red', warning: 'tag-amber', info: 'tag-blue', na: 'tag-grey' };
  const FIX_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
  // Checks with their own fix label (security.fix.<id>) / confirmation text (security.confirm.<id>).
  const FIX_LABELS = ['admin_2fa', 'require_2fa', 'hsts', 'caa', 'waf_coverage', 'waf_ready', 'backup_offsite', 'auto_update'];
  const CONFIRM_IDS = ['require_2fa', 'hsts', 'waf_coverage'];
  const ITEMS_SHOWN = 8;
  const PROTECTIONS = ['auth', 'mtls', 'ip_filter', 'waf', 'hsts', 'rate_limit', 'tls_min'];
  const FILTERS = ['all', 'unprotected', 'nowaf'];
  const TABS = ['check', 'exposure'];

  function str(v) { return v == null ? '' : String(v); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function severityOf(c) { return SEVERITIES.indexOf(c && c.severity) >= 0 ? c.severity : 'info'; }
  function statusOf(c) { const s = c && c.status; return s === 'pass' || s === 'fail' ? s : 'na'; }
  // Display kind: pass | fail (critical/warning) | info (a finding) | na
  function kindOf(c) {
    const s = statusOf(c);
    if (s !== 'fail') return s;
    return severityOf(c) === 'info' ? 'info' : 'fail';
  }
  function pillOf(c) {
    const k = kindOf(c);
    if (k === 'fail') return { cls: PILL_CLASS[severityOf(c)], key: 'security.status_fail' };
    return { cls: PILL_CLASS[k === 'info' ? 'info' : k], key: 'security.status_' + k };
  }
  // [{ severity, checks }] in severity order; inside: fail, na, pass; stable.
  function groupChecks(checks) {
    const list = (Array.isArray(checks) ? checks : []).filter(isObj);
    return SEVERITIES.map((sev) => ({
      severity: sev,
      checks: list.map((c, i) => ({ c, i })).filter((x) => severityOf(x.c) === sev)
        .sort((a, b) => (STATUS_ORDER[statusOf(a.c)] - STATUS_ORDER[statusOf(b.c)]) || (a.i - b.i)).map((x) => x.c),
    })).filter((g) => g.checks.length > 0);
  }
  function summaryOf(res) {
    const s = isObj(res && res.summary) ? res.summary : null;
    if (s) return { pass: +s.pass || 0, fail: +s.fail || 0, info: +s.info || 0 };
    const out = { pass: 0, fail: 0, info: 0 };
    (res && Array.isArray(res.checks) ? res.checks : []).forEach((c) => { const k = kindOf(c); if (out[k] != null) out[k]++; });
    return out;
  }
  function known(id) { return CHECK_IDS.indexOf(id) >= 0; }
  // i18n keys of the title and the explanation for the current status.
  function textKeys(c) {
    const id = str(c && c.id);
    if (!known(id)) return { title: 'security.check.unknown_title', desc: 'security.check.unknown_' + statusOf(c) };
    const base = 'security.check.' + id + '.';
    const s = statusOf(c);
    let desc = base + s;
    if (s === 'fail' && id === 'auto_update' && severityOf(c) !== 'info') desc = base + 'fail_failed';
    if (s === 'fail' && id === 'backup_offsite' && !(Array.isArray(c.items) && c.items.length)) desc = base + 'fail_none';
    return { title: base + 'title', desc };
  }
  function relPath(v) {
    const s = str(v).trim();
    return /^\/(?!\/)[^\s\\]*$/.test(s) && !/^\/[^?#]*\.\.(\/|$)/.test(s) ? s : null;
  }
  // Only fixes the page can run safely: api → same-origin /api/v1/…, a write
  // method and an object body; link → a relative path; copy → text.
  function safeFix(fix) {
    if (!isObj(fix)) return null;
    if (fix.type === 'api') {
      const method = str(fix.method).toUpperCase();
      const url = str(fix.url);
      if (FIX_METHODS.indexOf(method) < 0 || !/^\/api\/v1\/[A-Za-z0-9/_.%-]+$/.test(url) || /\.\./.test(url)) return null;
      if (fix.body != null && !isObj(fix.body)) return null;
      return { type: 'api', method, url, body: fix.body || {} };
    }
    if (fix.type === 'link') { const href = relPath(fix.href); return href ? { type: 'link', href } : null; }
    if (fix.type === 'copy') { const text = str(fix.copy); return text && text.length <= 20000 ? { type: 'copy', copy: text } : null; }
    return null;
  }
  function fixLabelKey(c, fix) {
    if (!fix) return null;
    if (FIX_LABELS.indexOf(str(c && c.id)) >= 0) return 'security.fix.' + c.id;
    return fix.type === 'copy' ? 'security.copy' : (fix.type === 'link' ? 'security.fix_open' : 'security.fix_generic');
  }
  function confirmKey(c) { return CONFIRM_IDS.indexOf(str(c && c.id)) >= 0 ? 'security.confirm.' + c.id : 'security.confirm_generic'; }
  // /settings#backup → the settings tab to preselect (settings.js restores it from localStorage).
  function settingsTab(href) {
    const m = /^\/settings#([a-z0-9-]+)$/.exec(str(href));
    return m ? m[1] : null;
  }

  // route id → { domain_id, host_id } from GET /api/v1/zones.
  function zoneIndex(res) {
    const idx = new Map();
    const zones = res && Array.isArray(res.zones) ? res.zones : [];
    zones.forEach((z) => (Array.isArray(z.hosts) ? z.hosts : []).forEach((h) => (Array.isArray(h.entries) ? h.entries : []).forEach((e) => {
      if (e && e.id != null) idx.set(Number(e.id), { domain_id: z.domain_id, host_id: h.id });
    })));
    (res && Array.isArray(res.unassigned) ? res.unassigned : []).forEach((h) => (Array.isArray(h.entries) ? h.entries : []).forEach((e) => {
      if (e && e.id != null && !idx.has(Number(e.id))) idx.set(Number(e.id), { domain_id: null, host_id: h.id });
    }));
    return idx;
  }
  function routeHref(routeId, idx) {
    const hit = idx && idx.get(Number(routeId));
    if (!hit || hit.domain_id == null) return '/routes';
    return '/routes?domain=' + encodeURIComponent(hit.domain_id) + (hit.host_id != null ? '&host=' + encodeURIComponent(hit.host_id) : '');
  }
  function itemHref(item, idx) {
    if (!isObj(item)) return null;
    const id = item.id;
    if (item.kind === 'route') return routeHref(id, idx);
    if (item.kind === 'zone') return id != null && /^\d+$/.test(String(id)) ? '/routes?domain=' + encodeURIComponent(id) : '/routes';
    if (item.kind === 'user') return '/users';
    if (item.kind === 'target') return '/settings#backup';
    return null;
  }

  // ── Exposure ──
  function protectionsOf(e) { return isObj(e && e.protections) ? e.protections : {}; }
  function isHttp(e) { return str(e && e.type) !== 'l4'; }
  // No access protection: no login, no mTLS, no IP filter (layer 4 has none of them).
  function isUnprotected(e) { const p = protectionsOf(e); return !p.auth && !p.mtls && !p.ip_filter; }
  function lacksWaf(e) { return isHttp(e) && !protectionsOf(e).waf; }
  function normFilter(f) { return FILTERS.indexOf(f) >= 0 ? f : 'all'; }
  function matchesQuery(e, q) {
    const s = str(q).trim().toLowerCase();
    if (!s) return true;
    return [e.host, e.zone, e.target, e.listen_port].some((v) => str(v).toLowerCase().indexOf(s) >= 0);
  }
  function filterEntries(entries, filter, q) {
    const f = normFilter(filter);
    return (Array.isArray(entries) ? entries : []).filter(isObj).filter((e) => {
      if (f === 'unprotected' && !isUnprotected(e)) return false;
      if (f === 'nowaf' && !lacksWaf(e)) return false;
      return matchesQuery(e, q);
    });
  }
  function exposureCounts(entries) {
    const list = (Array.isArray(entries) ? entries : []).filter(isObj);
    return { all: list.length, unprotected: list.filter(isUnprotected).length, nowaf: list.filter(lacksWaf).length };
  }
  // One cell per protection: { key, state: on|off|na, value } — value is the
  // label key for on-states with a flavour (auth kind, WAF mode, TLS version).
  function protectionCells(e) {
    const p = protectionsOf(e);
    const http = isHttp(e);
    return PROTECTIONS.map((k) => {
      if (!http) return { key: k, state: 'na', value: null };
      if (k === 'auth') return p.auth ? { key: k, state: 'on', value: 'security.exp_auth_' + (p.auth === 'basic' ? 'basic' : 'route_auth') } : { key: k, state: 'off', value: null };
      if (k === 'waf') return p.waf ? { key: k, state: 'on', value: 'security.exp_waf_' + (p.waf === 'block' ? 'block' : 'detect') } : { key: k, state: 'off', value: null };
      if (k === 'tls_min') return { key: k, state: str(p.tls_min) === '1.3' ? 'on' : 'off', value: null, text: str(p.tls_min) === '1.3' ? '1.3' : '1.2' };
      return { key: k, state: p[k] ? 'on' : 'off', value: null };
    });
  }
  function healthKind(h) { return h === 'ok' || h === 'down' ? h : 'unknown'; }
  function parseHash(hash) {
    const h = str(hash).replace(/^#/, '');
    return TABS.indexOf(h) >= 0 ? h : 'check';
  }

  const pure = {
    SEVERITIES, CHECK_IDS, CHECK_FEATURE, FIX_LABELS, CONFIRM_IDS, PILL_CLASS, PROTECTIONS, FILTERS, TABS, ITEMS_SHOWN,
    severityOf, statusOf, kindOf, pillOf, groupChecks, summaryOf, textKeys, safeFix, fixLabelKey, confirmKey, settingsTab, relPath,
    zoneIndex, routeHref, itemHref, isUnprotected, lacksWaf, normFilter, filterEntries, exposureCounts, protectionCells, healthKind, parseHash,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ──────────────────────────────────────────────────────
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const root = $('sc-page');
  if (!root) return pure;
  const GC = win.GC = win.GC || {};

  function t(key, params) {
    let s = GC.t && GC.t[key] != null ? GC.t[key] : key;
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function el(tag, props, children) {
    const n = doc.createElement(tag);
    const p = props || {};
    if (p.type != null) n.type = p.type;
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (k === 'type' || v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.keys(v).forEach((d) => { n.dataset[d] = v[d]; });
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else if (k === 'href' || k === 'disabled' || k === 'colSpan' || k === 'value' || k === 'title') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    append(n, children);
    return n;
  }
  function append(n, children) {
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(n, c);
      else n.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    });
    return n;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    check: [['polyline', { points: '20 6 9 17 4 12' }]],
    x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    ext: [['path', { d: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6' }], ['polyline', { points: '15 3 21 3 21 9' }], ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]],
    copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1' }]],
    bolt: [['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }]],
    alert: [['path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }], ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }], ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
    globe: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 2, y1: 12, x2: 22, y2: 12 }], ['path', { d: 'M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z' }]],
  };
  function icon(name, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    const s = String(size || 14);
    [['viewBox', '0 0 24 24'], ['width', s], ['height', s], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['class', 'sc-ic']].forEach((a) => svg.setAttribute(a[0], a[1]));
    (ICONS[name] || []).forEach((spec) => {
      const n = doc.createElementNS(SVGNS, spec[0]);
      Object.keys(spec[1]).forEach((k) => n.setAttribute(k, String(spec[1][k])));
      svg.appendChild(n);
    });
    return svg;
  }
  function toast(msg, type) { if (win.showToast) win.showToast(msg, type || 'success'); }
  function busy(btn, on) {
    if (!btn) return;
    if (on) { if (win.btnLoading) win.btnLoading(btn); else btn.disabled = true; } else if (win.btnReset) win.btnReset(btn); else btn.disabled = false;
  }
  function lang() { return GC.language || doc.documentElement.lang || 'de'; }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    try { return d.toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString().slice(11, 16); }
  }

  // Own fetch: the error carries the status and the JSON body (code, failed, feature).
  async function request(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRF-Token'] = GC.csrfToken || '';
      opts.body = JSON.stringify(body || {});
    }
    const res = await win.fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (data && data.csrfToken) GC.csrfToken = data.csrfToken;
    if (res.ok && !(data && data.ok === false)) return data || {};
    const e = new Error((data && data.error) || ('HTTP ' + res.status));
    e.data = Object.assign({}, data || {}, { status: res.status });
    throw e;
  }
  function errText(err) {
    const d = err && err.data;
    if (d && Array.isArray(d.failed) && d.failed.length) {
      const f = d.failed[0];
      return str(f.error || f.code) + (d.failed.length > 1 ? ' (+' + (d.failed.length - 1) + ')' : '');
    }
    return (err && err.message) || t('common.error');
  }

  // ── Dialog (zn-dialog styles from pro.css) ──
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      let done = false;
      const titleId = 'sc-dlg-' + Math.random().toString(36).slice(2, 8);
      const ok = el('button', { type: 'button', class: 'btn btn-primary sc-dialog-ok', text: opts.ok || t('security.confirm_ok') });
      const cancel = el('button', { type: 'button', class: 'btn btn-ghost sc-dialog-cancel', text: t('common.cancel') });
      const close = el('button', { type: 'button', class: 'modal-close', 'aria-label': t('common.close') }, [icon('x', 16)]);
      const box = el('div', { class: 'modal zn-dialog-box sc-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
        el('div', { class: 'modal-head' }, [el('span', { class: 'modal-title', id: titleId, text: opts.title || '' }), close]),
        el('div', { class: 'modal-body zn-dialog-body' }, [
          el('p', { class: 'zn-dialog-msg sc-dialog-msg', text: opts.message || '' }),
          opts.detail ? el('p', { class: 'zn-dialog-detail sc-dialog-detail', text: opts.detail }) : null,
        ]),
        el('div', { class: 'modal-foot zn-dialog-foot' }, [cancel, ok]),
      ]);
      const overlay = el('div', { class: 'modal-overlay zn-dialog sc-dialog', style: 'display:flex' }, [box]);
      const prev = doc.activeElement;
      function finish(v) {
        if (done) return;
        done = true;
        doc.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (prev && prev.focus && doc.contains(prev)) prev.focus();
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(false); } }
      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      close.addEventListener('click', () => finish(false));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
      doc.addEventListener('keydown', onKey, true);
      doc.body.appendChild(overlay);
      ok.focus();
    });
  }

  async function copyText(text) {
    try {
      if (win.navigator.clipboard && win.isSecureContext) { await win.navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* fall back */ }
    try {
      const ta = el('textarea', { class: 'sc-copy-buffer', 'aria-hidden': 'true' });
      ta.value = text;
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }

  // ─── State ─────────────────────────────────────────────────────────────
  const state = {
    tab: parseHash(win.location.hash),
    check: null, checkError: null, checkLoading: false,
    exposure: null, expError: null, expLoading: false,
    zones: null,
    filter: 'all', q: '',
    expanded: new Set(),
    running: new Set(),     // check ids with a fix in flight
    errors: new Map(),      // check id → error text of the last fix
  };

  // ─── Loading ───────────────────────────────────────────────────────────
  let checkSeq = 0;
  async function loadCheck() {
    const my = ++checkSeq;
    state.checkLoading = true;
    renderHeader();
    try {
      const res = await request('GET', '/api/v1/security/check');
      if (my !== checkSeq) return;
      state.check = res;
      state.checkError = null;
    } catch (err) {
      if (my !== checkSeq) return;
      state.checkError = err;
    } finally {
      if (my === checkSeq) { state.checkLoading = false; renderCheck(); renderHeader(); }
    }
  }
  let expSeq = 0;
  async function loadExposure() {
    const my = ++expSeq;
    state.expLoading = true;
    try {
      const [res, zones] = await Promise.all([
        request('GET', '/api/v1/security/exposure'),
        request('GET', '/api/v1/zones').catch(() => null),
      ]);
      if (my !== expSeq) return;
      state.exposure = Array.isArray(res.entries) ? res.entries.filter(isObj) : [];
      if (zones) state.zones = zoneIndex(zones);
      state.expError = null;
    } catch (err) {
      if (my !== expSeq) return;
      state.expError = err;
    } finally {
      if (my === expSeq) { state.expLoading = false; renderExposure(); renderCheck(); renderHeader(); }
    }
  }
  function reloadAll() { return Promise.all([loadCheck(), loadExposure()]); }

  // Live refresh: gc:security (check recomputed, e.g. CAA lookups done),
  // gc:routes (entries changed → both), reconnect → both. Debounced.
  let timer = null;
  let want = { check: false, exposure: false };
  let stale = false;
  function schedule(check, exposure) {
    want.check = want.check || check;
    want.exposure = want.exposure || exposure;
    if (doc.hidden) { stale = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const w = want;
      want = { check: false, exposure: false };
      if (w.check) loadCheck();
      if (w.exposure) loadExposure();
    }, 800);
  }

  // ─── Rendering: header, tabs ───────────────────────────────────────────
  function renderHeader() {
    const sub = $('sc-summary');
    const res = state.check;
    if (sub) {
      if (res) {
        const s = summaryOf(res);
        sub.textContent = t('security.summary', { time: fmtTime(res.generated_at), pass: s.pass, fail: s.fail, info: s.info });
      } else sub.textContent = state.checkError ? t('security.load_error') : t('security.page_sub');
    }
    const s = res ? summaryOf(res) : null;
    [['pass', 'pass'], ['fail', 'fail'], ['info', 'info']].forEach(([k]) => {
      const v = $('sc-tile-' + k + '-val');
      if (v) v.textContent = s ? String(s[k]) : '–';
      const tile = $('sc-tile-' + k);
      if (tile) tile.classList.toggle('sc-hot', !!s && k !== 'pass' && s[k] > 0);
    });
    const cc = $('sc-tab-check-count');
    if (cc) { const n = s ? s.fail + s.info : 0; cc.textContent = s && n ? String(n) : ''; cc.hidden = !(s && n); }
    const ec = $('sc-tab-exposure-count');
    if (ec) { ec.textContent = state.exposure ? String(state.exposure.length) : ''; ec.hidden = !state.exposure; }
    const btn = $('sc-refresh');
    if (btn) btn.classList.toggle('sc-spinning', state.checkLoading);
  }
  function setTab(tab, opts) {
    state.tab = TABS.indexOf(tab) >= 0 ? tab : 'check';
    doc.querySelectorAll('#sc-tabs [data-sc-tab]').forEach((b) => {
      const on = b.dataset.scTab === state.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    doc.querySelectorAll('[data-sc-panel]').forEach((p) => { p.hidden = p.dataset.scPanel !== state.tab; });
    if (!(opts && opts.keepHash)) {
      try { win.history.replaceState(null, '', win.location.pathname + win.location.search + (state.tab === 'check' ? '' : '#' + state.tab)); } catch (_) { /* ignore */ }
    }
  }

  // ─── Rendering: check tab ──────────────────────────────────────────────
  function stateBox(text, cls, retry) {
    return el('div', { class: 'sc-state' + (cls ? ' ' + cls : '') }, [
      el('span', { text }),
      retry ? el('button', { type: 'button', class: 'btn btn-sm sc-retry', text: t('security.retry'), on: { click: retry } }) : null,
    ]);
  }
  function renderCheck() {
    const box = $('sc-checks');
    if (!box) return;
    const res = state.check;
    const pending = $('sc-pending');
    if (!res) {
      if (pending) pending.hidden = true;
      box.replaceChildren(state.checkError
        ? stateBox(t('security.load_error') + ' ' + errText(state.checkError), 'sc-error', () => loadCheck())
        : stateBox(t('security.loading'), 'sc-loading'));
      return;
    }
    const caa = (res.checks || []).find((c) => c && c.id === 'caa');
    const nPending = caa && Number(caa.pending) > 0 ? Number(caa.pending) : 0;
    if (pending) {
      pending.hidden = !nPending;
      pending.textContent = nPending ? t('security.pending', { n: nPending }) : '';
    }
    const groups = groupChecks(res.checks);
    if (!groups.length) { box.replaceChildren(stateBox(t('security.empty'))); return; }
    const s = summaryOf(res);
    const nodes = [];
    if (s.fail === 0 && s.info === 0) nodes.push(el('div', { class: 'sc-allgood', role: 'status' }, [icon('check', 16), el('span', { text: t('security.all_good') })]));
    groups.forEach((g) => nodes.push(groupCard(g)));
    box.replaceChildren(...nodes);
  }
  function groupCard(g) {
    const open = g.checks.filter((c) => statusOf(c) === 'fail').length;
    return el('section', { class: 'card sc-group sc-group-' + g.severity, dataset: { severity: g.severity } }, [
      el('div', { class: 'sc-group-head' }, [
        el('span', { class: 'sc-group-dot', 'aria-hidden': 'true' }),
        el('h2', { class: 'sc-group-title', text: t('security.group_' + g.severity) }),
        el('span', { class: 'sc-group-count', text: t('security.group_open', { open, total: g.checks.length }) }),
      ]),
      el('div', { class: 'sc-group-list' }, g.checks.map(checkRow)),
    ]);
  }
  function checkRow(c) {
    const id = str(c.id);
    const keys = textKeys(c);
    const pill = pillOf(c);
    const kind = kindOf(c);
    const items = statusOf(c) === 'fail' && Array.isArray(c.items) ? c.items.filter(isObj) : [];
    const fix = statusOf(c) === 'fail' ? safeFix(c.fix) : null;
    const count = statusOf(c) === 'fail' && Number(c.count) > 0 ? Number(c.count) : 0;
    const desc = t(keys.desc, { id, mode: str(c.mode), action: str(c.last_action) });
    const row = el('article', { class: 'sc-check sc-k-' + kind, dataset: { checkId: id, status: statusOf(c), severity: severityOf(c) } }, [
      el('div', { class: 'sc-check-head' }, [
        el('span', { class: 'tag ' + pill.cls + ' sc-pill', text: t(pill.key) }),
        el('h3', { class: 'sc-check-title', text: known(id) ? t(keys.title) : t(keys.title, { id }) }),
        count ? el('span', { class: 'sc-check-count', text: t('security.count', { n: count }) }) : null,
      ]),
      el('p', { class: 'sc-check-desc', text: desc }),
      items.length ? itemsEl(c, items) : null,
      id === 'caa' && Number(c.pending) > 0 ? el('p', { class: 'sc-check-note', text: t('security.pending', { n: Number(c.pending) }) }) : null,
      fix && fix.type === 'copy' ? copyEl(fix) : null,
      actionsEl(c, fix),
      licenceSlot(c),
    ]);
    const err = state.errors.get(id);
    if (err) row.appendChild(el('div', { class: 'sc-check-error', role: 'alert', text: err }));
    return row;
  }
  function itemsEl(c, items) {
    const id = str(c.id);
    const all = state.expanded.has(id);
    const shown = all ? items : items.slice(0, ITEMS_SHOWN);
    const chips = shown.map((it) => {
      const label = str(it.label) || (str(it.kind) + ' ' + str(it.id));
      const href = itemHref(it, state.zones);
      return href
        ? el('a', { class: 'sc-item', href, title: t('security.item_open'), dataset: { kind: str(it.kind) }, on: { click: () => rememberSettingsTab(href) } }, [el('span', { class: 'sc-item-label', text: label })])
        : el('span', { class: 'sc-item', dataset: { kind: str(it.kind) } }, [el('span', { class: 'sc-item-label', text: label })]);
    });
    const more = items.length > ITEMS_SHOWN
      ? el('button', { type: 'button', class: 'sc-link sc-items-more', 'aria-expanded': all ? 'true' : 'false',
        text: all ? t('security.items_less') : t('security.items_more', { n: items.length - ITEMS_SHOWN }),
        on: { click: () => { if (all) state.expanded.delete(id); else state.expanded.add(id); renderCheck(); } } })
      : null;
    return el('div', { class: 'sc-items', role: 'list' }, chips.map((n) => { n.setAttribute('role', 'listitem'); return n; }).concat(more ? [more] : []));
  }
  function copyEl(fix) {
    const btn = el('button', { type: 'button', class: 'btn btn-sm sc-copy-btn' }, [icon('copy', 13), t('security.copy')]);
    btn.addEventListener('click', async () => {
      const ok = await copyText(fix.copy);
      toast(ok ? t('security.copied') : t('security.copy_failed'), ok ? 'success' : 'error');
    });
    return el('div', { class: 'sc-copy' }, [
      el('div', { class: 'sc-copy-hint', text: t('security.copy_hint') }),
      el('pre', { class: 'sc-copy-text', tabindex: '0', text: fix.copy }),
      btn,
    ]);
  }
  function rememberSettingsTab(href) {
    const tab = settingsTab(href);
    if (tab) { try { win.localStorage.setItem('settings-active-tab', tab); } catch (_) { /* storage off */ } }
  }
  function actionsEl(c, fix) {
    const id = str(c.id);
    const nodes = [];
    if (fix && fix.type === 'api') {
      const btn = el('button', { type: 'button', class: 'btn btn-primary btn-sm sc-fix', dataset: { fix: 'api' } }, [icon('bolt', 13), t(fixLabelKey(c, fix))]);
      if (state.running.has(id)) btn.disabled = true;
      btn.addEventListener('click', () => runFix(c, fix, btn));
      nodes.push(btn);
    } else if (fix && fix.type === 'link') {
      nodes.push(el('a', { class: 'btn btn-sm sc-fix', href: fix.href, dataset: { fix: 'link' }, on: { click: () => rememberSettingsTab(fix.href) } }, [icon('ext', 13), t(fixLabelKey(c, fix))]));
    }
    if (id === 'public_unprotected' && statusOf(c) === 'fail') {
      nodes.push(el('button', { type: 'button', class: 'btn btn-ghost btn-sm sc-to-exposure', on: { click: () => { setFilter('unprotected'); setTab('exposure'); } } }, [icon('globe', 13), t('security.show_exposure')]));
    }
    return nodes.length ? el('div', { class: 'sc-check-actions' }, nodes) : null;
  }
  function licenceSlot(c) {
    const feature = CHECK_FEATURE[str(c.id)];
    if (!feature || statusOf(c) !== 'na' || !win.GCLicenseHint) return null;
    const slot = el('div', { class: 'sc-licence' });
    slot.hidden = true;
    win.GCLicenseHint.load().then((info) => {
      if (!win.GCLicenseHint.reasonOf(info, feature)) return;
      slot.replaceChildren(win.GCLicenseHint.render(feature, { compact: true }));
      slot.hidden = false;
    }, () => { /* no licence info → no hint */ });
    return slot;
  }
  async function runFix(c, fix, btn) {
    const id = str(c.id);
    const n = Array.isArray(c.items) && c.items.length ? c.items.length : (Number(c.count) || 0);
    const ok = await confirmDialog({
      title: t(fixLabelKey(c, fix)),
      message: t(confirmKey(c), { n, method: fix.method, url: fix.url }),
      detail: CONFIRM_IDS.indexOf(id) >= 0 ? null : fix.method + ' ' + fix.url,
      ok: t('security.confirm_ok'),
    });
    if (!ok) return;
    state.running.add(id);
    state.errors.delete(id);
    busy(btn, true);
    try {
      await request(fix.method, fix.url, fix.body);
      toast(t('security.fix_done'), 'success');
    } catch (err) {
      state.errors.set(id, t('security.fix_failed', { error: errText(err) }));
      toast(t('security.fix_failed', { error: errText(err) }), 'error');
    } finally {
      state.running.delete(id);
      busy(btn, false);
    }
    await loadCheck();
    if (state.exposure) loadExposure();
  }

  // ─── Rendering: exposure tab ───────────────────────────────────────────
  const EXP_COLS = 12;
  function messageRow(node, cls) {
    const td = el('td', { colSpan: EXP_COLS }, [node]);
    td.colSpan = EXP_COLS;
    return el('tr', { class: 'sc-empty' + (cls ? ' ' + cls : '') }, [td]);
  }
  function renderChips() {
    const counts = state.exposure ? exposureCounts(state.exposure) : null;
    doc.querySelectorAll('#sc-exp-chips [data-filter]').forEach((b) => {
      const on = b.dataset.filter === state.filter;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const n = b.querySelector('.sc-chip-n');
      if (n) n.textContent = counts ? String(counts[b.dataset.filter]) : '';
    });
  }
  function renderExposure() {
    renderChips();
    const body = $('sc-exp-list');
    const sum = $('sc-exp-summary');
    if (!body) return;
    if (!state.exposure) {
      if (sum) sum.textContent = '';
      body.replaceChildren(messageRow(state.expError
        ? stateBox(t('security.exp_load_error') + ' ' + errText(state.expError), 'sc-error', () => loadExposure())
        : stateBox(t('common.loading'), 'sc-loading')));
      return;
    }
    const counts = exposureCounts(state.exposure);
    if (sum) sum.textContent = t('security.exp_summary', { n: counts.all, m: counts.unprotected });
    const list = filterEntries(state.exposure, state.filter, state.q);
    if (!state.exposure.length) { body.replaceChildren(messageRow(stateBox(t('security.exp_empty')))); return; }
    if (!list.length) {
      body.replaceChildren(messageRow(el('div', { class: 'sc-state' }, [
        el('span', { text: t('security.exp_empty_filter') }),
        el('button', { type: 'button', class: 'sc-link sc-reset', text: t('security.exp_reset'), on: { click: () => { state.q = ''; const s = $('sc-exp-search'); if (s) s.value = ''; setFilter('all'); } } }),
      ])));
      return;
    }
    body.replaceChildren(...list.map(expRow));
  }
  const COL_KEY = { auth: 'security.exp_col_auth', mtls: 'security.exp_col_mtls', ip_filter: 'security.exp_col_ip', waf: 'security.exp_col_waf', hsts: 'security.exp_col_hsts', rate_limit: 'security.exp_col_rate', tls_min: 'security.exp_col_tls' };
  function markEl(cell) {
    const name = t(COL_KEY[cell.key]);
    if (cell.state === 'na') return el('span', { class: 'sc-mark sc-na', title: name + ': ' + t('security.exp_na'), 'aria-label': name + ': ' + t('security.exp_na') }, [el('span', { class: 'sc-mark-dot', 'aria-hidden': 'true' })]);
    if (cell.key === 'tls_min') {
      return el('span', { class: 'sc-mark sc-tls sc-' + cell.state, title: name + ' ' + cell.text, 'aria-label': name + ' ' + cell.text }, [el('span', { class: 'sc-mark-txt', text: cell.text })]);
    }
    if (cell.state === 'on') {
      const label = cell.value ? t(cell.value) : t('security.exp_on');
      return el('span', { class: 'sc-mark sc-on', title: name + ': ' + label, 'aria-label': name + ': ' + label }, [icon('check', 13), cell.value ? el('span', { class: 'sc-mark-txt', text: label }) : null]);
    }
    return el('span', { class: 'sc-mark sc-off', title: name + ': ' + t('security.exp_off'), 'aria-label': name + ': ' + t('security.exp_off') }, [el('span', { class: 'sc-mark-off', 'aria-hidden': 'true', text: '–' })]);
  }
  function expRow(e) {
    const http = isHttp(e);
    const unprot = isUnprotected(e);
    const h = healthKind(e.health);
    const sub = [];
    if (e.zone && str(e.zone).toLowerCase() !== str(e.host).toLowerCase()) sub.push(str(e.zone));
    if (!http && e.listen_port) sub.push(t('security.exp_port', { port: str(e.listen_port) + (e.protocol ? '/' + str(e.protocol) : '') }));
    const href = routeHref(e.route_id, state.zones);
    const cells = protectionCells(e);
    return el('tr', { class: 'sc-exp-row' + (unprot ? ' sc-exp-unprotected' : ''), dataset: { routeId: str(e.route_id), type: http ? 'http' : 'l4' } }, [
      el('td', { class: 'sc-exp-host', 'data-label': t('security.exp_col_host') }, [
        el('div', { class: 'sc-host-line' }, [
          el('span', { class: 'sc-host', text: e.host ? str(e.host) : t('security.exp_no_host') }),
          unprot ? el('span', { class: 'tag tag-amber sc-unprot-tag', text: t('security.exp_unprotected') }) : null,
        ]),
        sub.length ? el('div', { class: 'sc-host-sub', text: sub.join(' · ') }) : null,
      ]),
      el('td', { class: 'sc-exp-target', 'data-label': t('security.exp_col_target') }, [el('code', { class: 'sc-mono', text: e.target ? str(e.target) : '—' })]),
      el('td', { class: 'sc-exp-type', 'data-label': t('security.exp_col_type') }, [el('span', { class: 'tag tag-grey sc-type', text: t(http ? 'security.exp_type_http' : 'security.exp_type_l4') })]),
      el('td', { class: 'sc-exp-health', 'data-label': t('security.exp_col_health') }, [el('span', { class: 'tag tag-dot sc-health sc-health-' + h + ' ' + (h === 'ok' ? 'tag-green' : h === 'down' ? 'tag-red' : 'tag-grey'), text: t('security.exp_health_' + h) })]),
    ].concat(cells.map((c) => el('td', { class: 'sc-p sc-p-' + c.key, 'data-label': t(COL_KEY[c.key]), dataset: { state: c.state } }, [markEl(c)])), [
      el('td', { class: 'sc-exp-open' }, [el('a', { class: 'btn btn-ghost btn-sm sc-open', href, title: t('security.exp_open'), 'aria-label': t('security.exp_open') + ': ' + str(e.host || e.target) }, [icon('ext', 13), el('span', { class: 'sc-open-txt', text: t('security.exp_open_short') })])]),
    ]));
  }
  function setFilter(f) {
    state.filter = normFilter(f);
    renderExposure();
  }

  // ─── Wiring ────────────────────────────────────────────────────────────
  const tabs = $('sc-tabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-sc-tab]'); if (b) setTab(b.dataset.scTab); });
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.indexOf(state.tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      setTab(next);
      const b = tabs.querySelector('[data-sc-tab="' + next + '"]');
      if (b) b.focus();
    });
  }
  win.addEventListener('hashchange', () => setTab(parseHash(win.location.hash), { keepHash: true }));
  const chips = $('sc-exp-chips');
  if (chips) chips.addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (b) setFilter(b.dataset.filter); });
  const search = $('sc-exp-search');
  if (search) search.addEventListener('input', () => { state.q = search.value; renderExposure(); });
  const refresh = $('sc-refresh');
  if (refresh) refresh.addEventListener('click', () => reloadAll());

  setTab(state.tab, { keepHash: true });
  renderHeader();
  renderCheck();
  renderExposure();
  reloadAll();
  doc.addEventListener('gc:security', () => schedule(true, false));
  doc.addEventListener('gc:routes', () => schedule(true, true));
  doc.addEventListener('gc:reconnected', () => schedule(true, true));
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden && stale) { stale = false; schedule(true, true); } });

  return Object.assign(pure, { reload: reloadAll, setTab, setFilter, getState: () => state });
});
