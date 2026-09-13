'use strict';

// TLS guard UI kit (docs/feature-tls-guard.md). Shared by the certificates
// page (certificates.js), the zones page + domain dialog (zones-page.js,
// domain-modal.js) and the settings page (settings.js). Loaded before those
// scripts. UMD like zones-view.js: the pure helpers (sorting, filtering,
// summaries, reason codes) are testable in node:test; the DOM part (dialogs,
// tags, records) only exists in the browser. DOM is built with el() — no
// innerHTML. Strings arrive as the JSON island #tls-i18n (partials/tls-i18n.njk).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCTlsUI = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  // ─── Pure helpers ──────────────────────────────────────────────────────
  const EXPIRING_DAYS = 14;
  const STATES = ['pending', 'issued', 'failed', 'paused', 'internal', 'none'];
  const SORT_ORDER = { paused: 0, failed: 1, expiring: 2, pending: 3, issued: 4, internal: 5, none: 6, unknown: 7 };
  const FILTERS = ['all', 'problems', 'expiring', 'valid'];
  const TLS_ERR_CODES = ['dns', 'caa', 'rate_limited', 'account', 'preflight', 'other'];
  const DNS_CODES = ['ok', 'no_records', 'a_mismatch', 'aaaa_mismatch', 'aaaa_without_ipv6', 'caa_blocks',
    'resolver_unreachable', 'server_ip_unknown', 'not_public'];
  const PROBLEM_STATES = ['failed', 'paused'];

  function str(v) { return v == null ? '' : String(v); }

  function isProblemState(state) { return PROBLEM_STATES.indexOf(state) >= 0; }

  function isExpiring(h) {
    return !!h && h.state === 'issued' && typeof h.days_left === 'number' && h.days_left < EXPIRING_DAYS;
  }

  // Display state of a TlsHost: the API state, with 'expiring' split out of
  // 'issued' (< 14 days) and anything unknown mapped to 'unknown'.
  function stateKey(h) {
    if (!h) return 'unknown';
    if (isExpiring(h)) return 'expiring';
    return STATES.indexOf(h.state) >= 0 ? h.state : 'unknown';
  }

  // Problems first (paused, failed, expiring), then pending, issued,
  // internal, none; alphabetically by host within a group. Never mutates.
  function sortHosts(hosts) {
    return (hosts || []).slice().sort((a, b) => {
      const oa = SORT_ORDER[stateKey(a)];
      const ob = SORT_ORDER[stateKey(b)];
      if (oa !== ob) return oa - ob;
      return str(a.host).toLowerCase().localeCompare(str(b.host).toLowerCase());
    });
  }

  function matchesFilter(h, filter) {
    const k = stateKey(h);
    switch (filter) {
      case 'problems': return k === 'paused' || k === 'failed' || k === 'expiring';
      case 'expiring': return k === 'expiring';
      case 'valid': return k === 'issued' || k === 'expiring';
      default: return true;
    }
  }

  function filterHosts(hosts, filter) {
    const f = FILTERS.indexOf(filter) >= 0 ? filter : 'all';
    return (hosts || []).filter((h) => matchesFilter(h, f));
  }

  // Same shape as the API Summary (minus acme_email_missing), computed from
  // the host list — used when the response carries no summary.
  function summarize(hosts) {
    const s = { total: 0, issued: 0, expiring: 0, failed: 0, paused: 0, pending: 0, internal: 0, none: 0 };
    for (const h of hosts || []) {
      s.total++;
      const k = stateKey(h);
      if (k === 'expiring') { s.expiring++; s.issued++; }
      else if (s[k] !== undefined) s[k]++;
    }
    return s;
  }

  // Chip counts for the filter bar.
  function filterCounts(hosts) {
    const out = {};
    FILTERS.forEach((f) => { out[f] = filterHosts(hosts, f).length; });
    return out;
  }

  // Effective error code of a TlsHost: last_error_code, else the preflight
  // code of a preflight-paused host.
  function errorCode(h) {
    if (!h) return null;
    if (h.last_error_code) return String(h.last_error_code);
    if (h.paused_reason === 'preflight' && h.preflight && h.preflight.code) return 'preflight:' + h.preflight.code;
    return null;
  }

  // i18n key for a short German reason: 'preflight:<c>' → dns_check.<c>,
  // else tls.err.<code>; unknown codes fall back to the generic texts.
  function reasonKey(code) {
    const c = str(code);
    if (!c) return null;
    if (c.indexOf('preflight:') === 0) {
      const d = c.slice('preflight:'.length);
      return 'dns_check.' + (DNS_CODES.indexOf(d) >= 0 ? d : 'unknown');
    }
    return 'tls.err.' + (TLS_ERR_CODES.indexOf(c) >= 0 ? c : 'other');
  }

  function dnsCodeKey(code) {
    const c = str(code);
    return 'dns_check.' + (DNS_CODES.indexOf(c) >= 0 ? c : 'unknown');
  }

  // check_json may arrive as a JSON string or an object.
  function parseCheck(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
  }

  // DNS check code of a zone / domains row: last_error (a code since the
  // guard), or the code inside check_json. Free-text last_error values from
  // before the guard yield null — callers then show the text itself.
  function dnsCode(row) {
    if (!row) return null;
    const direct = row.dns_code || row.verification_code || row.last_error;
    if (direct && DNS_CODES.indexOf(String(direct)) >= 0) return String(direct);
    const chk = parseCheck(row.check_json || row.check);
    if (chk && chk.code) return String(chk.code);
    return null;
  }

  // First HTTP entry of a zones Host whose certificate failed / is paused.
  function hostTlsProblem(host) {
    if (!host) return null;
    for (const e of host.entries || []) {
      if (e && e.tls && isProblemState(e.tls.state)) return { state: e.tls.state, entry: e, tls: e.tls };
    }
    if (host.tls_problem) return { state: 'failed', entry: null, tls: null };
    return null;
  }

  // tls: {state, code, detail} from a create response (host/entry).
  function tlsFromResponse(res) {
    if (!res) return null;
    const t = res.tls || (res.host && res.host.tls) || (res.entry && res.entry.tls) || null;
    return t && t.state ? t : null;
  }

  const pure = {
    EXPIRING_DAYS, FILTERS, STATES, SORT_ORDER, DNS_CODES, TLS_ERR_CODES,
    isProblemState, isExpiring, stateKey, sortHosts, matchesFilter, filterHosts, summarize, filterCounts,
    errorCode, reasonKey, dnsCodeKey, parseCheck, dnsCode, hostTlsProblem, tlsFromResponse,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ──────────────────────────────────────────────────────
  const doc = win.document;
  const GC = win.GC = win.GC || {};
  GC.t = GC.t || {};
  try {
    const island = doc.getElementById('tls-i18n');
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
  function has(key) { return GC.t[key] != null; }
  function lang() { return GC.language || doc.documentElement.lang || 'de'; }

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
    refresh: [['polyline', { points: '23 4 23 10 17 10' }], ['path', { d: 'M20.49 15a9 9 0 11-2.12-9.36L23 10' }]],
    x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    check: [['polyline', { points: '20 6 9 17 4 12' }]],
    search: [['circle', { cx: 11, cy: 11, r: 8 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
    shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
    ext: [['path', { d: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6' }], ['polyline', { points: '15 3 21 3 21 9' }], ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]],
    down: [['polyline', { points: '6 9 12 15 18 9' }]],
  };
  function icon(name, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    const s = String(size || 14);
    [['viewBox', '0 0 24 24'], ['width', s], ['height', s], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'],
      ['class', 'tg-ic']].forEach((a) => svg.setAttribute(a[0], a[1]));
    (ICONS[name] || []).forEach((spec) => {
      const n = doc.createElementNS(SVGNS, spec[0]);
      Object.keys(spec[1]).forEach((k) => n.setAttribute(k, String(spec[1][k])));
      svg.appendChild(n);
    });
    return svg;
  }

  function busy(btn, on) {
    if (!btn) return;
    if (on) { if (win.btnLoading) win.btnLoading(btn); else btn.disabled = true; }
    else if (win.btnReset) win.btnReset(btn); else btn.disabled = false;
  }
  function toast(msg, type) {
    if (win.showToast) win.showToast(msg, type || 'success');
    else if (type === 'error') console.error(msg);
  }
  function errMsg(err) { return (err && err.message) || t('common.error'); }
  function isNotFound(err) {
    return !!err && (/API error: 404/.test(str(err.message)) || (err.data && err.data.status === 404));
  }

  // api.get throws for every non-2xx; api.post/put resolve {ok:false} for
  // 400/403/429 — normalise both to a thrown Error carrying the body.
  async function call(promise) {
    const res = await promise;
    if (res && res.ok === false) {
      const e = new Error(res.error || t('common.error'));
      e.data = res;
      throw e;
    }
    return res || {};
  }

  // ── Formatting ──
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleDateString(lang(), { year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (_) { return d.toISOString().slice(0, 10); }
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleString(lang(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
  }
  // "in 12 Min." / "vor 3 Std." for times within a day, else the date+time.
  function fmtWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const diff = (d.getTime() - Date.now()) / 1000;
    if (Math.abs(diff) < 86400 && typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
      try {
        const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
        if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), 'minute');
        return rtf.format(Math.round(diff / 3600), 'hour');
      } catch (_) { /* fall through */ }
    }
    return fmtDateTime(iso);
  }

  // ── Tags and texts ──
  const TAG_CLASS = { issued: 'tag-green', expiring: 'tag-amber', pending: 'tag-blue', failed: 'tag-red', paused: 'tag-amber', internal: 'tag-grey', none: 'tag-grey', unknown: 'tag-grey' };

  function stateText(h) {
    const k = stateKey(h);
    switch (k) {
      case 'issued': return t('tls.state_issued', { date: fmtDate(h.not_after) });
      case 'expiring': return t('tls.state_expiring', { date: fmtDate(h.not_after) });
      case 'pending': return t('tls.state_pending');
      case 'failed': return h.max_attempts > 0
        ? t('tls.state_failed', { n: h.attempts || 0, max: h.max_attempts })
        : t('tls.state_failed_nomax', { n: h.attempts || 0 });
      case 'paused': return t('tls.state_paused');
      case 'internal': return t('tls.state_internal');
      case 'none': return t('tls.state_none');
      default: return t('tls.state_unknown');
    }
  }

  function stateTag(h, extraClass) {
    const k = stateKey(h);
    return el('span', { class: 'tag ' + TAG_CLASS[k] + ' tg-state tg-state-' + k + (extraClass ? ' ' + extraClass : ''), dataset: { state: k } }, [
      el('span', { class: 'tag-dot' }), stateText(h),
    ]);
  }

  // Secondary line under the status: pause reason, days left, kind hints.
  function stateSub(h) {
    const k = stateKey(h);
    if (k === 'paused') {
      return h.paused_reason === 'preflight' ? t('tls.paused_preflight') : t('tls.paused_attempts', { n: h.attempts || 0 });
    }
    if ((k === 'issued' || k === 'expiring') && typeof h.days_left === 'number') {
      if (h.days_left < 0) return t('tls.expired');
      return h.days_left === 1 ? t('tls.days_left_one') : t('tls.days_left', { days: h.days_left });
    }
    if (k === 'internal') return t('tls.kind_internal_hint');
    if (k === 'none') return t('tls.kind_none_hint');
    return '';
  }

  function shortReason(h) {
    const key = reasonKey(errorCode(h));
    return key ? t(key) : '';
  }
  function dnsCodeText(code) { return t(dnsCodeKey(code)); }
  function dnsCodeHint(code) {
    const key = dnsCodeKey(code) + '_hint';
    return has(key) ? t(key) : '';
  }

  // ── Records / preflight blocks ──
  function recordsEl(pf) {
    const r = (pf && pf.records) || {};
    const srv = (pf && pf.server) || {};
    const list = (arr, fmt) => (Array.isArray(arr) && arr.length
      ? el('div', { class: 'tg-rec-vals' }, arr.map((v) => el('code', { class: 'tg-mono', text: fmt ? fmt(v) : String(v) })))
      : el('span', { class: 'tg-muted', text: t('tls.records_none') }));
    const caa = (c) => (c && typeof c === 'object' ? [c.flags != null ? c.flags : 0, c.tag, '"' + str(c.value) + '"'].join(' ') : String(c));
    const row = (label, val) => el('div', { class: 'tg-rec' }, [el('span', { class: 'tg-rec-label', text: label }), val]);
    return el('div', { class: 'tg-records' }, [
      el('div', { class: 'tg-rec-title', text: t('dns_check.records_title') }),
      row(t('tls.records_a'), list(r.a)),
      row(t('tls.records_aaaa'), list(r.aaaa)),
      row(t('tls.records_caa'), list(r.caa, caa)),
      el('div', { class: 'tg-rec-title', text: t('dns_check.server_title') }),
      row(t('tls.server_v4'), srv.v4 ? el('code', { class: 'tg-mono', text: srv.v4 }) : el('span', { class: 'tg-muted', text: t('tls.server_unknown') })),
      row(t('tls.server_v6'), srv.v6 ? el('code', { class: 'tg-mono', text: srv.v6 }) : el('span', { class: 'tg-muted', text: t('tls.server_unknown') })),
      pf && pf.checked_at ? el('div', { class: 'tg-muted tg-small', text: t('tls.checked_at', { time: fmtDateTime(pf.checked_at) }) }) : null,
    ]);
  }

  // Preflight result: verdict tag, code text, detail, explanation, records.
  function preflightEl(pf) {
    if (!pf) return el('div', { class: 'tg-muted', text: t('tls.preflight_none') });
    const ok = pf.ok === true;
    const hint = dnsCodeHint(pf.code);
    return el('div', { class: 'tg-preflight ' + (ok ? 'tg-pf-ok' : 'tg-pf-bad'), dataset: { code: str(pf.code) } }, [
      el('div', { class: 'tg-pf-head' }, [
        el('span', { class: 'tag ' + (ok ? 'tag-green' : 'tag-red') + ' tg-pf-verdict' }, [el('span', { class: 'tag-dot' }), ok ? t('tls.preflight_ok') : t('tls.preflight_failed')]),
        el('span', { class: 'tg-pf-code', text: dnsCodeText(pf.code) }),
      ]),
      pf.detail ? el('div', { class: 'tg-pf-detail tg-mono', text: String(pf.detail) }) : null,
      hint ? el('p', { class: 'tg-pf-hint', text: hint }) : null,
      recordsEl(pf),
    ]);
  }

  // Short reason + collapsible original Caddy text.
  function errorEl(h) {
    const code = errorCode(h);
    if (!code && !h.last_error) return el('span', { class: 'tg-muted', text: '—' });
    const wrap = el('div', { class: 'tg-err' });
    wrap.appendChild(el('div', { class: 'tg-err-short', text: shortReason(h) || t('tls.err.other') }));
    if (h.last_error) {
      const orig = el('pre', { class: 'tg-orig', text: String(h.last_error) });
      orig.hidden = true;
      const toggle = el('button', { type: 'button', class: 'tg-link tg-orig-toggle', 'aria-expanded': 'false', text: t('tls.err_original') });
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        orig.hidden = !orig.hidden;
        toggle.setAttribute('aria-expanded', orig.hidden ? 'false' : 'true');
        toggle.textContent = orig.hidden ? t('tls.err_original') : t('tls.err_original_hide');
      });
      wrap.appendChild(toggle);
      wrap.appendChild(orig);
    }
    return wrap;
  }

  // ── API ──
  // Own GET instead of api.get: the thrown Error must carry the HTTP status
  // (err.data.status) so a 404 of the not-yet-merged backend degrades to the
  // "Backend noch nicht verfügbar" hint whatever the body says.
  async function getJson(url) {
    const res = await win.fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (body && body.csrfToken) GC.csrfToken = body.csrfToken;
    if (res.ok && body && body.ok !== false) return body;
    const e = new Error((body && body.error) || 'API error: ' + res.status);
    e.data = Object.assign({ status: res.status }, body || {});
    throw e;
  }
  async function fetchStatus() {
    return getJson('/api/v1/tls/status');
  }
  async function fetchHost(host) {
    const res = await fetchStatus();
    const key = str(host).toLowerCase();
    return (res.hosts || []).find((h) => str(h.host).toLowerCase() === key) || null;
  }
  async function preflight(host) {
    const res = await getJson('/api/v1/tls/preflight/' + encodeURIComponent(host));
    return res.result || null;
  }
  // → TlsHost; throws Error with err.data = { status, code: 'PREFLIGHT_FAILED', result }
  // on 409. Own fetch instead of api.post: app.js drops the body of a non-2xx
  // answer unless it carries `error`, but the contract's 409 body is
  // { ok:false, code, result } and the result must reach the dialog.
  async function retry(host) {
    const res = await win.fetch('/api/v1/tls/' + encodeURIComponent(host) + '/retry', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': GC.csrfToken || '' },
      body: '{}',
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (body && body.csrfToken) GC.csrfToken = body.csrfToken;
    if (res.ok && body && body.ok !== false) return body.status || null;
    const e = new Error((body && body.error) || (body && body.code === 'PREFLIGHT_FAILED' ? t('tls.preflight_failed') : 'API error: ' + res.status));
    e.data = Object.assign({ status: res.status }, body || {});
    throw e;
  }
  function announce(host, state) {
    try { doc.dispatchEvent(new CustomEvent('gc:tls', { detail: { host, state, local: true } })); } catch (_) { /* ignore */ }
  }

  // ── Dialog (own overlay above the domain modal, like GCZonesUI.dialog) ──
  function dialog(opts) {
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const closeBtn = el('button', { type: 'button', class: 'modal-close', 'aria-label': t('common.close') }, [icon('x', 16)]);
    const body = el('div', { class: 'modal-body zn-dialog-body tg-dialog-body' });
    const foot = el('div', { class: 'modal-foot zn-dialog-foot tg-dialog-foot' });
    const titleId = 'tg-dlg-' + Math.random().toString(36).slice(2, 8);
    const box = el('div', { class: 'modal zn-dialog-box zn-dialog-wide tg-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'modal-head' }, [el('span', { class: 'modal-title', id: titleId, text: opts.title || '' }), closeBtn]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay zn-dialog tg-dialog', style: 'display:flex', dataset: { tgDialog: opts.kind || 'detail' } }, [box]);
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

  function setTitle(d, text) { const n = d.box.querySelector('.modal-title'); if (n) n.textContent = text; }

  // ── Certificate detail dialog (also used for "Prüfen" and the entry tag) ──
  // host: FQDN; tlsHost: TlsHost if the caller has it; opts.check: run the
  // preflight immediately (the "Prüfen" action); opts.onChanged(tlsHost).
  function openDetail(host, tlsHost, opts) {
    const o = opts || {};
    let h = tlsHost || null;
    let pf = h && h.preflight ? h.preflight : null;
    let checking = false;
    const d = dialog({ title: t('tls.detail_title', { host }), kind: o.check ? 'preflight' : 'detail' });
    const facts = el('div', { class: 'tg-facts' });
    const pfBox = el('div', { class: 'tg-pf-box' });
    const errBox = el('div', { class: 'tg-field-error', role: 'alert' });
    errBox.hidden = true;
    d.body.appendChild(facts);
    d.body.appendChild(pfBox);
    d.body.appendChild(errBox);

    const checkBtn = el('button', { type: 'button', class: 'btn btn-ghost tg-btn-check' }, [icon('search', 13), t('tls.check')]);
    const retryBtn = el('button', { type: 'button', class: 'btn btn-primary tg-btn-retry' }, [icon('refresh', 13), t('tls.retry')]);
    const closeBtn = el('button', { type: 'button', class: 'btn btn-secondary', text: t('common.close'), on: { click: () => d.close(null) } });
    d.foot.appendChild(checkBtn);
    d.foot.appendChild(retryBtn);
    d.foot.appendChild(closeBtn);

    function renderFacts() {
      if (!h) {
        facts.replaceChildren(el('div', { class: 'tg-muted', text: t('common.loading') }));
        retryBtn.hidden = true;
        return;
      }
      const k = stateKey(h);
      const rows = [
        el('div', { class: 'tg-fact-state' }, [stateTag(h), el('span', { class: 'tg-muted tg-small', text: stateSub(h) })]),
      ];
      if (h.issuer) rows.push(el('div', { class: 'tg-fact', text: t('tls.issuer', { issuer: h.issuer }) }));
      if (h.not_after) rows.push(el('div', { class: 'tg-fact', text: t('tls.not_after', { date: fmtDate(h.not_after) }) }));
      if (h.kind === 'acme' || k === 'failed' || k === 'paused' || k === 'pending') {
        rows.push(el('div', { class: 'tg-fact', text: h.max_attempts > 0 ? t('tls.attempts', { n: h.attempts || 0, max: h.max_attempts }) : t('tls.attempts_unlimited', { n: h.attempts || 0 }) }));
      }
      if (h.last_attempt_at) rows.push(el('div', { class: 'tg-fact', text: t('tls.last_attempt', { time: fmtDateTime(h.last_attempt_at) }) }));
      if (k === 'failed') rows.push(el('div', { class: 'tg-fact', text: h.next_retry_at ? t('tls.next_retry', { time: fmtWhen(h.next_retry_at) }) : t('tls.next_retry_none') }));
      rows.push(el('div', { class: 'tg-fact tg-fact-err' }, [el('span', { class: 'tg-fact-label', text: t('tls.col_error') }), errorEl(h)]));
      facts.replaceChildren(...rows);
      retryBtn.hidden = !isProblemState(h.state);
      checkBtn.hidden = h.kind === 'none';
    }
    function renderPf() {
      if (checking) pfBox.replaceChildren(el('div', { class: 'tg-muted tg-pf-running' }, [icon('refresh', 13), ' ', t('tls.preflight_running')]));
      else pfBox.replaceChildren(preflightEl(pf));
    }
    function fail(err) {
      errBox.textContent = isNotFound(err) ? t('tls.backend_missing') : errMsg(err);
      errBox.hidden = false;
    }

    async function runCheck() {
      checking = true;
      errBox.hidden = true;
      renderPf();
      busy(checkBtn, true);
      try {
        pf = await preflight(host);
      } catch (err) { fail(err); } finally {
        checking = false;
        busy(checkBtn, false);
        renderPf();
      }
    }
    async function runRetry() {
      errBox.hidden = true;
      busy(retryBtn, true);
      busy(checkBtn, true);
      try {
        const next = await retry(host);
        if (next) h = next;
        else if (h) h = Object.assign({}, h, { state: 'pending', attempts: 0, last_error: null, last_error_code: null, next_retry_at: null, paused_at: null, paused_reason: null });
        pf = (h && h.preflight) || pf;
        toast(t('tls.retry_ok', { host }), 'success');
        renderFacts();
        renderPf();
        announce(host, h ? h.state : 'pending');
        if (o.onChanged) o.onChanged(h);
      } catch (err) {
        const data = err && err.data;
        if (data && data.code === 'PREFLIGHT_FAILED') {
          pf = data.result || pf;
          toast(t('tls.retry_failed', { host }), 'error');
          renderPf();
        } else fail(err);
      } finally {
        busy(retryBtn, false);
        busy(checkBtn, false);
      }
    }
    checkBtn.addEventListener('click', runCheck);
    retryBtn.addEventListener('click', runRetry);

    renderFacts();
    renderPf();
    if (!h) {
      fetchHost(host).then((found) => {
        h = found || { host, state: 'unknown', kind: 'acme', attempts: 0, max_attempts: 0 };
        pf = pf || (h.preflight || null);
        renderFacts();
        renderPf();
      }).catch((err) => {
        h = { host, state: 'unknown', kind: 'acme', attempts: 0, max_attempts: 0 };
        renderFacts();
        fail(err);
      });
    }
    if (o.check) runCheck();
    closeBtn.focus();
    return d;
  }

  function openPreflight(host, tlsHost, opts) {
    const d = openDetail(host, tlsHost, Object.assign({}, opts || {}, { check: true }));
    setTitle(d, t('tls.preflight_title', { host }));
    return d;
  }

  // ── Domain DNS check dialog (domain modal head / zone head) ──
  // zone: { domain_id, domain, verification, check_json? }. Records come from
  // the domains row (check_json) when the settings API exposes them, else
  // from a live preflight of the base domain. opts.onChanged(row).
  function openDnsCheck(zone, opts) {
    const o = opts || {};
    const domain = zone.domain;
    let row = null;
    let check = parseCheck(zone.check_json || zone.check);
    const d = dialog({ title: t('tls.dns_title', { domain }), kind: 'dns' });
    const head = el('div', { class: 'tg-fact-state' });
    const box = el('div', { class: 'tg-pf-box' });
    const errBox = el('div', { class: 'tg-field-error', role: 'alert' });
    errBox.hidden = true;
    d.body.appendChild(head);
    d.body.appendChild(box);
    d.body.appendChild(errBox);
    const recheck = el('button', { type: 'button', class: 'btn btn-primary tg-btn-recheck' }, [icon('refresh', 13), t('tls.dns_recheck')]);
    d.foot.appendChild(recheck);
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-secondary', text: t('common.close'), on: { click: () => d.close(null) } }));

    function verification() { return (row && row.status) || zone.verification || 'pending'; }
    function render(loading) {
      const v = verification();
      const cls = v === 'verified' ? 'tag-green' : v === 'failed' ? 'tag-red' : 'tag-amber';
      const label = v === 'verified' ? t('zones.dns_verified') : v === 'failed' ? t('zones.dns_failed') : t('zones.dns_pending');
      head.replaceChildren(el('span', { class: 'tag ' + cls + ' zn-dns' }, [el('span', { class: 'tag-dot' }), label]));
      if (loading) box.replaceChildren(el('div', { class: 'tg-muted tg-pf-running' }, [icon('refresh', 13), ' ', t('tls.preflight_running')]));
      else if (check) box.replaceChildren(preflightEl(check));
      else box.replaceChildren(el('div', { class: 'tg-muted', text: t('tls.dns_no_check') }));
    }
    async function load() {
      render(true);
      try {
        const res = await call(win.api.get('/api/v1/settings/domains'));
        const rows = (res.data && res.data.domains) || [];
        row = rows.find((r) => str(r.domain).toLowerCase() === str(domain).toLowerCase()) || null;
        if (row) check = parseCheck(row.check_json) || check;
        if (!check) check = await preflight(domain);
      } catch (err) {
        if (!check) { errBox.textContent = isNotFound(err) ? t('tls.backend_missing') : errMsg(err); errBox.hidden = false; }
      }
      render(false);
    }
    recheck.addEventListener('click', async () => {
      errBox.hidden = true;
      busy(recheck, true);
      render(true);
      try {
        const res = await call(win.api.post('/api/settings/domains/' + zone.domain_id + '/verify', {}));
        row = res.data || row;
        check = parseCheck(row && row.check_json) || check;
        if (row && row.status === 'verified') toast(t('tls.dns_verified_now', { domain }), 'success');
        else toast(t('tls.dns_still_failed', { domain }), 'error');
        if (o.onChanged) o.onChanged(row);
      } catch (err) { errBox.textContent = errMsg(err); errBox.hidden = false; } finally {
        busy(recheck, false);
        render(false);
      }
    });
    render(true);
    load();
    return d;
  }

  // Tag for the domain modal head / zone head: on 'failed' a clickable red
  // tag "DNS: <Grund>" that opens the DNS dialog; null otherwise (callers
  // fall back to the plain verification tag).
  function dnsTag(zone, opts) {
    if (!zone || zone.verification !== 'failed') return null;
    const code = dnsCode(zone);
    const text = code ? t('tls.dns_tag', { reason: dnsCodeText(code) }) : t('zones.dns_failed');
    return el('button', {
      type: 'button', class: 'tag tag-red zn-dns tg-dns-tag', title: t('tls.dns_tag_hint'), 'aria-haspopup': 'dialog',
      on: { click: (e) => { e.stopPropagation(); openDnsCheck(zone, opts); } },
    }, [el('span', { class: 'tag-dot' }), text]);
  }

  // Amber "Zertifikat: <Kurzgrund>" tag on an HTTP entry line of the domain dialog.
  function entryTag(entry, opts) {
    const tls = entry && entry.tls;
    if (!tls || !isProblemState(tls.state)) return null;
    const partial = { host: entry.domain, state: tls.state, last_error_code: tls.last_error_code, paused_reason: tls.paused_reason, preflight: tls.preflight || null };
    const reason = shortReason(partial) || (tls.state === 'paused' ? t('tls.state_paused') : t('tls.err.other'));
    return el('button', {
      type: 'button', class: 'tag tag-amber zn-opt-tag tg-entry-tag', title: t('tls.entry_tag_hint'), 'aria-haspopup': 'dialog',
      dataset: { tlsState: tls.state },
      on: { click: (e) => { e.stopPropagation(); openDetail(entry.domain, null, opts); } },
    }, [el('span', { class: 'tag-dot' }), t('tls.entry_tag', { reason })]);
  }

  // Adds the warning mark to a zones-page HTTPS chip when the entry's
  // certificate failed / is paused.
  function decorateChip(chipNode, entry) {
    const tls = entry && entry.tls;
    if (!chipNode || !tls || !isProblemState(tls.state)) return chipNode;
    chipNode.classList.add('tg-chip-warn');
    chipNode.title = t('tls.chip_warn');
    chipNode.appendChild(el('span', { class: 'tg-warn-mark', 'aria-label': t('tls.chip_warn') }, [icon('alert', 10)]));
    return chipNode;
  }

  // Host-row status text on the zones page, or null when no TLS problem.
  function hostProblemText(host) {
    const p = hostTlsProblem(host);
    if (!p) return null;
    return p.state === 'paused' ? t('tls.host_problem_paused') : t('tls.host_problem_failed');
  }

  // Inline notice after creating a host/entry whose certificate got paused.
  function noticeEl(o) {
    const reason = o.reason || (o.tls ? t(reasonKey(o.tls.code ? 'preflight:' + o.tls.code : 'other') || 'tls.err.other') : '');
    const box = el('div', { class: 'tg-notice', role: 'alert' }, [
      icon('alert', 14),
      el('span', { class: 'tg-notice-text', text: o.host ? t('tls.created_paused', { host: o.host, reason }) : t('tls.created_paused_short', { reason }) }),
      o.tls && o.tls.detail ? el('code', { class: 'tg-mono tg-small', text: String(o.tls.detail) }) : null,
      el('button', { type: 'button', class: 'btn btn-ghost zn-btn-sm tg-notice-details', text: t('tls.notice_details'), on: { click: () => openDetail(o.host, null) } }),
      el('button', { type: 'button', class: 'zn-ibtn tg-notice-close', 'aria-label': t('common.close'), on: { click: () => { box.remove(); if (o.onClose) o.onClose(); } } }, [icon('x', 12)]),
    ]);
    return box;
  }
  function pausedReason(tls) {
    if (!tls) return '';
    if (tls.code) return t(reasonKey('preflight:' + tls.code));
    return t('tls.paused_preflight');
  }

  return Object.assign(pure, {
    t, el, append, icon, busy, toast, call, errMsg, isNotFound, fmtDate, fmtDateTime, fmtWhen,
    stateTag, stateText, stateSub, shortReason, dnsCodeText, dnsCodeHint, recordsEl, preflightEl, errorEl,
    fetchStatus, fetchHost, preflight, retry, dialog,
    openDetail, openPreflight, openDnsCheck, dnsTag, entryTag, decorateChip, hostProblemText, noticeEl, pausedReason,
  });
});
