'use strict';

// HSTS per host UI kit (docs/feature-hsts.md). Used by the domain dialog
// (domain-modal.js: head control + entry tag/dialog) and the entry editor
// (entry-editor.js: preload confirmation, error texts). Loaded on zones.njk
// after tls-ui.js and before domain-modal.js. UMD like tls-ui.js: the pure
// helpers (config normalisation, header value, labels, preload rules, error
// mapping) are testable in node:test; the DOM part only exists in the
// browser. DOM is built with el() — no innerHTML. Strings come from the
// zones i18n island (#zones-i18n, keys hsts.*) merged into GC.t.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCHstsUI = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  // ─── Pure helpers ──────────────────────────────────────────────────────
  const MIN_AGE = 300;
  const MAX_AGE = 63072000;
  const PRELOAD_MIN_AGE = 31536000;
  const DEFAULT_AGE = 31536000;
  // Select options: 0 = off (head control only), then 6 months / 1 year / 2 years.
  const AGE_OPTIONS = [0, 15552000, 31536000, 63072000];
  const AGE_KEYS = { 0: 'hsts.age_off', 15552000: 'hsts.age_6m', 31536000: 'hsts.age_1y', 63072000: 'hsts.age_2y' };
  const AGE_LABELS_DE = { 0: 'Aus', 15552000: '6 Monate', 31536000: '1 Jahr', 63072000: '2 Jahre' };
  const ERROR_CODES = ['HSTS_PRELOAD_REQUIREMENTS', 'HSTS_REQUIRES_HTTPS', 'HSTS_MAX_AGE_INVALID'];
  const HEADER_NAME = 'strict-transport-security';

  function str(v) { return v == null ? '' : String(v); }
  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function toInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

  // Canonical config { enabled, max_age, include_subdomains, preload } from
  // any of the contract shapes: entry.hsts / zone.hsts_default (object or
  // null), a routes row (hsts_enabled, hsts_max_age, …) or an already
  // canonical object. Anything unknown → HSTS off with the default max-age.
  function normalize(src) {
    const out = { enabled: false, max_age: DEFAULT_AGE, include_subdomains: false, preload: false };
    if (!src || typeof src !== 'object') return out;
    if ('hsts_enabled' in src || 'hsts_max_age' in src || 'hsts_subdomains' in src || 'hsts_preload' in src) {
      out.enabled = truthy(src.hsts_enabled);
      out.max_age = toInt(src.hsts_max_age, DEFAULT_AGE);
      out.include_subdomains = truthy(src.hsts_subdomains);
      out.preload = truthy(src.hsts_preload);
      return out;
    }
    out.enabled = truthy(src.enabled);
    out.max_age = toInt(src.max_age, DEFAULT_AGE);
    out.include_subdomains = truthy(src.include_subdomains);
    out.preload = truthy(src.preload);
    return out;
  }
  function fromEntry(entry) {
    if (!entry) return normalize(null);
    if (entry.hsts && typeof entry.hsts === 'object') return normalize(entry.hsts);
    if ('hsts_enabled' in entry) return normalize(entry);
    return normalize(null);
  }
  function fromRoute(route) { return normalize(route && 'hsts_enabled' in route ? route : null); }
  function fromZone(zone) {
    const d = zone && zone.hsts_default;
    if (typeof d === 'string') { try { return normalize(JSON.parse(d)); } catch (_) { return normalize(null); } }
    return normalize(d || null);
  }

  function preloadAllowed(cfg) {
    const c = normalize(cfg);
    return !!c.include_subdomains && c.max_age >= PRELOAD_MIN_AGE;
  }
  function ageValid(v) { const n = toInt(v, NaN); return Number.isFinite(n) && n >= MIN_AGE && n <= MAX_AGE; }

  // Client-side mirror of routesValidation: the contract's error code or null.
  function validate(cfg, opts) {
    const c = normalize(cfg);
    const o = opts || {};
    if (!c.enabled) return null;
    if (o.https_enabled === false) return 'HSTS_REQUIRES_HTTPS';
    if (!ageValid(c.max_age)) return 'HSTS_MAX_AGE_INVALID';
    if (c.preload && !preloadAllowed(c)) return 'HSTS_PRELOAD_REQUIREMENTS';
    return null;
  }

  // 'max-age=<n>; includeSubDomains; preload' — '' when HSTS is off.
  function headerValue(cfg) {
    const c = normalize(cfg);
    if (!c.enabled) return '';
    let v = 'max-age=' + c.max_age;
    if (c.include_subdomains) v += '; includeSubDomains';
    if (c.preload) v += '; preload';
    return v;
  }

  // Short label of a max-age: translated select option, else "<n> s".
  function ageLabel(maxAge, tr) {
    const n = toInt(maxAge, 0);
    if (AGE_KEYS[n] != null) return tr ? tr(AGE_KEYS[n]) : AGE_LABELS_DE[n];
    return tr ? tr('hsts.age_custom', { seconds: n }) : n + ' s';
  }
  // "1 Jahr · includeSubDomains · preload" / "Aus". tr(key, params) optional.
  function labelFor(cfg, tr) {
    const c = normalize(cfg);
    if (!c.enabled) return ageLabel(0, tr);
    const parts = [ageLabel(c.max_age, tr)];
    if (c.include_subdomains) parts.push(tr ? tr('hsts.include_subdomains') : 'includeSubDomains');
    if (c.preload) parts.push(tr ? tr('hsts.preload') : 'preload');
    return parts.join(' · ');
  }

  // i18n key of a contract error code, null for anything else.
  function errorKey(code) {
    const c = str(code).toUpperCase();
    if (ERROR_CODES.indexOf(c) < 0) return null;
    return 'hsts.err.' + c.slice('HSTS_'.length).toLowerCase();
  }

  // PUT /api/v1/routes/:id body (only the hsts_* fields).
  function toRouteFields(cfg) {
    const c = normalize(cfg);
    return { hsts_enabled: c.enabled, hsts_max_age: c.max_age, hsts_subdomains: c.include_subdomains, hsts_preload: c.preload };
  }
  // domains.hsts_default: object or null (= off).
  function toDefault(cfg) {
    const c = normalize(cfg);
    return c.enabled ? { enabled: true, max_age: c.max_age, include_subdomains: c.include_subdomains, preload: c.preload } : null;
  }
  function sameConfig(a, b) { return headerValue(a) === headerValue(b); }

  // HTTP entry with HTTPS — the only kind that can carry HSTS.
  function isEligible(entry) {
    return !!entry && entry.route_type !== 'l4' && !entry.rdp_owned && truthy(entry.https_enabled);
  }
  // Hosts the "auch auf bestehende Hosts anwenden" option would change.
  function applicableEntries(zone) {
    const out = [];
    for (const h of (zone && zone.hosts) || []) for (const e of h.entries || []) if (isEligible(e)) out.push(e);
    return out;
  }

  // custom_headers ({request:[],response:[]} as object or JSON string):
  // value of a response Strict-Transport-Security header, else null.
  function customHeaderHsts(entry) {
    let ch = entry && entry.custom_headers;
    if (!ch) return null;
    if (typeof ch === 'string') { try { ch = JSON.parse(ch); } catch (_) { return null; } }
    if (!ch || typeof ch !== 'object') return null;
    const list = Array.isArray(ch.response) ? ch.response : [];
    const hit = list.find((h) => h && str(h.name).trim().toLowerCase() === HEADER_NAME);
    return hit ? str(hit.value) : null;
  }
  function certNotIssued(entry) {
    return !!(entry && entry.tls && entry.tls.state && entry.tls.state !== 'issued');
  }

  const pure = {
    MIN_AGE, MAX_AGE, PRELOAD_MIN_AGE, DEFAULT_AGE, AGE_OPTIONS, AGE_KEYS, ERROR_CODES,
    normalize, fromEntry, fromRoute, fromZone, preloadAllowed, ageValid, validate, headerValue, ageLabel, labelFor,
    errorKey, toRouteFields, toDefault, sameConfig, isEligible, applicableEntries, customHeaderHsts, certNotIssued,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ──────────────────────────────────────────────────────
  const doc = win.document;
  const GC = win.GC = win.GC || {};
  GC.t = GC.t || {};
  try {
    const island = doc.getElementById('zones-i18n');
    if (island) {
      const strings = JSON.parse(island.textContent || '{}');
      Object.keys(strings).forEach((k) => { if (GC.t[k] === undefined) GC.t[k] = strings[k]; });
    }
  } catch (_) { /* keep whatever GC.t has */ }

  function t(key, params) {
    let s = GC.t[key] != null ? GC.t[key] : key;
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function label(cfg) { return labelFor(cfg, t); }
  function errorText(code) { const k = errorKey(code); return k ? t(k) : null; }

  const PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, placeholder: 1, maxLength: 1, htmlFor: 1, tabIndex: 1, href: 1, target: 1, rel: 1, name: 1 };
  function el(tag, props, children) {
    const node = doc.createElement(tag);
    const p = props || {};
    if (p.type != null) node.type = p.type;
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (k === 'type' || v == null) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.keys(v).forEach((d) => { node.dataset[d] = v[d]; });
      else if (k === 'style') node.setAttribute('style', v);
      else if (k === 'on') Object.keys(v).forEach((ev) => node.addEventListener(ev, v[ev]));
      else if (PROPS[k]) node[k] = v;
      else if (v === false) return;
      else node.setAttribute(k, v === true ? '' : v);
    });
    append(node, children);
    return node;
  }
  function append(node, children) {
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(node, c);
      else node.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    });
    return node;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    alert: [['path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }], ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }], ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
    x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
  };
  function icon(name, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    const s = String(size || 14);
    [['viewBox', '0 0 24 24'], ['width', s], ['height', s], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'],
      ['class', 'hs-ic']].forEach((a) => svg.setAttribute(a[0], a[1]));
    (ICONS[name] || []).forEach((spec) => {
      const n = doc.createElementNS(SVGNS, spec[0]);
      Object.keys(spec[1]).forEach((k) => n.setAttribute(k, String(spec[1][k])));
      svg.appendChild(n);
    });
    return svg;
  }

  // Mapped German text for a contract code, else the server/API message.
  function errMsg(err) {
    const code = err && err.data && err.data.code;
    return errorText(code) || (err && err.message) || t('zones.error_generic');
  }

  // ── Dialog (own overlay above the domain modal, like GCZonesUI.dialog) ──
  function dialog(opts) {
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const closeBtn = el('button', { type: 'button', class: 'modal-close', 'aria-label': t('common.close') }, [icon('x', 16)]);
    const body = el('div', { class: 'modal-body zn-dialog-body hs-dialog-body' });
    const foot = el('div', { class: 'modal-foot zn-dialog-foot hs-dialog-foot' });
    const titleId = 'hs-dlg-' + Math.random().toString(36).slice(2, 8);
    const box = el('div', { class: 'modal zn-dialog-box hs-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'modal-head' }, [el('span', { class: 'modal-title', id: titleId, text: opts.title || '' }), closeBtn]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay zn-dialog hs-dialog', style: 'display:flex', dataset: { hsDialog: opts.kind || 'dialog' } }, [box]);
    const prevFocus = doc.activeElement;
    function close(result) {
      if (done) return;
      done = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus && doc.contains(prevFocus)) prevFocus.focus();
      resolveFn(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
    }
    closeBtn.addEventListener('click', () => close(null));
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    return { overlay, box, body, foot, close, promise };
  }

  // ── Building blocks ──
  // Amber warning box + "ich verstehe" checkbox. onChange(checked).
  function preloadWarningEl(onChange) {
    const cb = el('input', { type: 'checkbox', class: 'hs-confirm-cb' });
    if (onChange) cb.addEventListener('change', () => onChange(cb.checked));
    const node = el('div', { class: 'hs-warn', role: 'alert' }, [
      el('div', { class: 'hs-warn-text' }, [icon('alert', 14), el('span', { text: t('hsts.preload_warning') })]),
      el('label', { class: 'hs-check hs-confirm' }, [cb, t('hsts.preload_confirm')]),
    ]);
    return { node, cb };
  }
  // Standalone confirmation (entry editor): resolves true when confirmed.
  function confirmPreload() {
    const d = dialog({ title: t('hsts.preload_confirm_title'), kind: 'preload' });
    const ok = el('button', { type: 'button', class: 'btn btn-primary hs-btn-ok', text: t('hsts.preload_confirm_ok'), disabled: true, on: { click: () => d.close(true) } });
    const w = preloadWarningEl((checked) => { ok.disabled = !checked; });
    d.body.appendChild(el('p', { class: 'zn-dialog-detail', text: t('hsts.preload_hint') }));
    d.body.appendChild(w.node);
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(false) } }));
    d.foot.appendChild(ok);
    w.cb.focus();
    return d.promise.then((r) => r === true);
  }

  // max-age select + includeSubDomains + preload. opts.withOff: include the
  // "Aus" option (head control). Returns { node, get(), set(cfg), sync(),
  // setDisabled(bool), select, sub, preload }. onChange(cfg) after each
  // user change (already normalised: preload cleared when not allowed).
  function fieldsEl(cfg, opts) {
    const o = opts || {};
    let cur = normalize(cfg);
    const select = el('select', { class: 'form-select zn-select hs-age ' + (o.selectClass || ''), 'aria-label': t('hsts.age_label') },
      AGE_OPTIONS.filter((v) => v !== 0 || o.withOff).map((v) => el('option', { value: String(v), text: ageLabel(v, t) })));
    const sub = el('input', { type: 'checkbox', class: 'hs-sub ' + (o.subClass || '') });
    const pre = el('input', { type: 'checkbox', class: 'hs-preload ' + (o.preloadClass || '') });
    const preLabel = el('label', { class: 'hs-check hs-check-preload', title: t('hsts.preload_hint') }, [pre, t('hsts.preload')]);
    const node = el('div', { class: 'hs-fields' + (o.className ? ' ' + o.className : '') }, [
      el('div', { class: 'hs-f' }, [el('span', { class: 'hs-f-label', text: t('hsts.age_label') }), select]),
      el('div', { class: 'hs-checks' }, [
        el('label', { class: 'hs-check' }, [sub, t('hsts.include_subdomains')]),
        preLabel,
      ]),
    ]);
    function ensureOption(v) {
      if (!Array.from(select.options).some((op) => op.value === String(v))) select.appendChild(el('option', { value: String(v), text: ageLabel(v, t) }));
    }
    function read() {
      const age = toInt(select.value, 0);
      const enabled = o.withOff ? age !== 0 : cur.enabled;
      const c = { enabled, max_age: age === 0 ? cur.max_age : age, include_subdomains: sub.checked, preload: pre.checked };
      if (!preloadAllowed(c)) c.preload = false;
      return normalize(c);
    }
    function sync() {
      const c = read();
      const allowed = preloadAllowed(c) && (o.withOff ? c.enabled : true);
      pre.disabled = !allowed || node.classList.contains('hs-disabled');
      if (!allowed) pre.checked = false;
      preLabel.classList.toggle('hs-check-off', !allowed);
      if (o.withOff) {
        const off = !c.enabled;
        sub.disabled = off || node.classList.contains('hs-disabled');
        node.classList.toggle('hs-fields-off', off);
      }
    }
    function set(c) {
      cur = normalize(c);
      const v = o.withOff && !cur.enabled ? 0 : cur.max_age;
      ensureOption(v);
      select.value = String(v);
      sub.checked = cur.include_subdomains;
      pre.checked = cur.preload && preloadAllowed(cur);
      sync();
    }
    function setDisabled(on) {
      node.classList.toggle('hs-disabled', !!on);
      select.disabled = !!on;
      sub.disabled = !!on;
      sync();
    }
    function changed() { sync(); cur = read(); if (o.onChange) o.onChange(cur, { preloadJustSet: pre.checked }); }
    select.addEventListener('change', changed);
    sub.addEventListener('change', changed);
    pre.addEventListener('change', changed);
    set(cur);
    return { node, select, sub, preload: pre, get: read, set, sync, setDisabled };
  }

  return Object.assign(pure, {
    t, el, icon, dialog, errMsg, errorText, label, fieldsEl, preloadWarningEl, confirmPreload,
  });
});
