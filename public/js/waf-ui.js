'use strict';

// Web Application Firewall UI kit (docs/feature-waf.md, "Oberfläche"). Used
// by the WAF page (waf.js: status, events, exclusion dialogs), the domain
// dialog (domain-modal.js: entry tag "WAF" / "WAF · erkennt" + small WAF
// dialog) and the entry editor (entry-editor.js: exclusion list, engine
// hint). Loaded on waf.njk before waf.js and on zones.njk after secopt-ui.js
// and before domain-modal.js. UMD like secopt-ui.js: the pure helpers (field
// normalisation, exclusion rules, event filters/query, status totals, deep
// links, error mapping) are testable in node:test; the DOM part only exists
// in the browser. DOM is built with el() — no innerHTML. Strings come from
// the JSON islands #waf-i18n (WAF page) and #zones-i18n (zones page), keys waf.*.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCWafUI = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  // ─── Pure helpers ──────────────────────────────────────────────────────
  const MODES = ['detect', 'block'];
  const ACTIONS = ['blocked', 'detected'];
  const ACTION_FILTERS = ['all', 'blocked', 'detected'];
  const RANGES = ['24h', '7d', '30d'];
  const RANGE_MS = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
  const PARANOIA_LEVELS = [1, 2, 3, 4];
  const PAGE_SIZE = 50;
  const PATH_MAX = 512;
  const TAG_CLASS = { block: 'tag-red', detect: 'tag-amber' };
  const ACTION_CLASS = { blocked: 'tag-red', detected: 'tag-amber', unknown: 'tag-grey' };
  // Contract/validation codes → i18n key (routesValidation: WAF_MODE_INVALID,
  // WAF_PARANOIA_INVALID, WAF_REQUIRES_HTTP; exclusion codes of the WAF API).
  const ERROR_KEYS = {
    WAF_MODE_INVALID: 'waf.err.mode_invalid',
    WAF_PARANOIA_INVALID: 'waf.err.paranoia_invalid',
    WAF_REQUIRES_HTTP: 'waf.err.requires_http',
    WAF_RULE_ID_INVALID: 'waf.err.invalid_rule',
    WAF_PATH_INVALID: 'waf.err.invalid_path',
    WAF_EXCLUSION_INVALID: 'waf.err.exclusion_invalid',
    WAF_EXCLUSION_EXISTS: 'waf.err.duplicate',
    WAF_EXCLUSION_DUPLICATE: 'waf.err.duplicate',
    WAF_LICENSE: 'waf.err.license',
    ROUTE_NOT_FOUND: 'waf.err.route_not_found',
  };
  const ERROR_CODES = Object.keys(ERROR_KEYS);

  function str(v) { return v == null ? '' : String(v); }
  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // ── Route / entry fields ──
  function normMode(v) { return str(v).trim().toLowerCase() === 'block' ? 'block' : 'detect'; }
  function normParanoia(v) {
    const n = parseInt(v, 10);
    return PARANOIA_LEVELS.indexOf(n) >= 0 ? n : 1;
  }
  // { enabled, mode, paranoia } from a routes row / zones entry (waf_enabled,
  // waf_mode, waf_paranoia) or an entry.waf object. Unknown → off/detect/1.
  function wafOf(src) {
    const out = { enabled: false, mode: 'detect', paranoia: 1 };
    if (!isObj(src)) return out;
    if (isObj(src.waf)) {
      out.enabled = truthy(src.waf.enabled);
      out.mode = normMode(src.waf.mode);
      out.paranoia = normParanoia(src.waf.paranoia);
      return out;
    }
    out.enabled = truthy(src.waf_enabled);
    out.mode = normMode(src.waf_mode);
    out.paranoia = normParanoia(src.waf_paranoia);
    return out;
  }
  function isHttpEntry(e) { return !!e && e.route_type !== 'l4' && !e.rdp_owned; }
  // null (no WAF / not an HTTP entry) | 'detect' | 'block'.
  function wafState(e) {
    if (!isHttpEntry(e)) return null;
    const w = wafOf(e);
    return w.enabled ? w.mode : null;
  }
  // PUT /api/v1/routes/:id fields (only waf_enabled, waf_mode, waf_paranoia).
  function toRouteFields(cfg) {
    return { waf_enabled: !!(cfg && cfg.enabled), waf_mode: normMode(cfg && cfg.mode), waf_paranoia: normParanoia(cfg && cfg.paranoia) };
  }
  function modeKey(mode) { return 'waf.mode_' + normMode(mode); }
  function paranoiaKey(n) { return 'waf.paranoia_' + normParanoia(n); }
  function paranoiaHintKey(n) { return 'waf.paranoia_' + normParanoia(n) + '_hint'; }
  function tagKey(state) { return state === 'block' ? 'waf.tag_block' : 'waf.tag_detect'; }
  function chipKey(state) { return state === 'block' ? 'waf.chip_block' : 'waf.chip_detect'; }

  // ── Exclusions ({ rule_ids: [], paths: [] }, stored as JSON text) ──
  function parseRuleId(v) {
    const s = str(v).trim();
    if (!/^\d{1,9}$/.test(s)) return null;
    const n = parseInt(s, 10);
    return n > 0 ? n : null;
  }
  function normPath(v) { return str(v).trim(); }
  function validPath(v) {
    const s = normPath(v);
    return s.length > 0 && s.length <= PATH_MAX && s.charAt(0) === '/' && !/\s/.test(s);
  }
  function parseExclusions(v) {
    let o = v;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (_) { o = null; } }
    const out = { rule_ids: [], paths: [] };
    if (!isObj(o)) return out;
    (Array.isArray(o.rule_ids) ? o.rule_ids : []).forEach((r) => { const n = parseRuleId(r); if (n != null && out.rule_ids.indexOf(n) < 0) out.rule_ids.push(n); });
    (Array.isArray(o.paths) ? o.paths : []).forEach((p) => { const s = normPath(p); if (validPath(s) && out.paths.indexOf(s) < 0) out.paths.push(s); });
    return out;
  }
  function exclusionsOf(route) {
    if (!route) return parseExclusions(null);
    if (route.waf_exclusions !== undefined) return parseExclusions(route.waf_exclusions);
    return parseExclusions(isObj(route.waf) ? route.waf.exclusions : null);
  }
  // Client-side check before POST: null | 'invalid_rule' | 'invalid_path' | 'duplicate'.
  function exclusionError(kind, value, current) {
    const cur = parseExclusions(current);
    if (kind === 'rule') {
      const n = parseRuleId(value);
      if (n == null) return 'invalid_rule';
      return cur.rule_ids.indexOf(n) >= 0 ? 'duplicate' : null;
    }
    if (!validPath(value)) return 'invalid_path';
    return cur.paths.indexOf(normPath(value)) >= 0 ? 'duplicate' : null;
  }
  // POST/DELETE /waf/routes/:id/exclusions body.
  function exclusionBody(kind, value) { return kind === 'rule' ? { rule_id: parseRuleId(value) } : { path: normPath(value) }; }
  // New exclusion object with the item added/removed. Never mutates.
  function applyExclusion(current, kind, value, remove) {
    const cur = parseExclusions(current);
    const out = { rule_ids: cur.rule_ids.slice(), paths: cur.paths.slice() };
    const list = kind === 'rule' ? out.rule_ids : out.paths;
    const v = kind === 'rule' ? parseRuleId(value) : normPath(value);
    const i = list.indexOf(v);
    if (remove) { if (i >= 0) list.splice(i, 1); } else if (v != null && v !== '' && i < 0) list.push(v);
    return out;
  }
  // Exclusions carried by an API answer ({ exclusions } / { route: { waf_exclusions } }), else null.
  function exclusionsFromResponse(res) {
    if (!res || typeof res !== 'object') return null;
    if (res.exclusions !== undefined) return parseExclusions(res.exclusions);
    if (isObj(res.route) && res.route.waf_exclusions !== undefined) return parseExclusions(res.route.waf_exclusions);
    if (res.waf_exclusions !== undefined) return parseExclusions(res.waf_exclusions);
    return null;
  }
  function exclusionCount(current) { const c = parseExclusions(current); return c.rule_ids.length + c.paths.length; }

  // ── Events ──
  function actionKey(a) {
    const s = str(a).trim().toLowerCase();
    if (s === 'blocked' || s === 'block') return 'blocked';
    if (s === 'detected' || s === 'detect') return 'detected';
    return 'unknown';
  }
  // Path of a request URI for a path exclusion: no scheme/host, query or fragment.
  function pathOfUri(uri) {
    let p = str(uri).trim();
    if (!p) return '/';
    const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(p);
    if (abs) p = abs[1] || '/';
    p = p.split('#')[0].split('?')[0];
    return p.charAt(0) === '/' ? p : '/' + p;
  }
  function normFilter(f) {
    const o = f || {};
    return {
      host: str(o.host).trim().toLowerCase(),
      action: ACTION_FILTERS.indexOf(o.action) >= 0 ? o.action : 'all',
      range: RANGES.indexOf(o.range) >= 0 ? o.range : '24h',
    };
  }
  function rangeFrom(range, now) {
    const ms = RANGE_MS[range] || RANGE_MS['24h'];
    return new Date((now == null ? Date.now() : now) - ms).toISOString();
  }
  // '?limit=50&from=<iso>&host=…&action=…&cursor=…' for GET /api/v1/waf/events.
  function eventsQuery(filter, opts) {
    const f = normFilter(filter);
    const o = opts || {};
    const parts = ['limit=' + (o.limit || PAGE_SIZE), 'from=' + encodeURIComponent(rangeFrom(f.range, o.now))];
    if (f.host) parts.push('host=' + encodeURIComponent(f.host));
    if (f.action !== 'all') parts.push('action=' + f.action);
    if (o.cursor != null && o.cursor !== '') parts.push('cursor=' + encodeURIComponent(String(o.cursor)));
    return '?' + parts.join('&');
  }
  function tsOf(ev) { const d = new Date(ev && ev.ts); return isNaN(d.getTime()) ? null : d.getTime(); }
  // Guard in case the API ignores a filter: host, action and period.
  function matchesFilter(ev, filter, now) {
    const f = normFilter(filter);
    if (!ev) return false;
    if (f.host && str(ev.host).toLowerCase() !== f.host) return false;
    if (f.action !== 'all' && actionKey(ev.action) !== f.action) return false;
    const ts = tsOf(ev);
    if (ts != null && ts < (now == null ? Date.now() : now) - RANGE_MS[f.range]) return false;
    return true;
  }
  function normEvent(e) {
    const rid = e.rule_id == null || e.rule_id === '' ? null : e.rule_id;
    return Object.assign({}, e, { host: str(e.host).toLowerCase(), action: actionKey(e.action), rule_id: rid });
  }
  // { events, next_cursor } from the events answer ({ events, next_cursor }
  // per contract; items/data/cursor/next tolerated).
  function eventsFrom(res) {
    const r = res || {};
    const list = Array.isArray(r) ? r : (r.events || r.items || r.data || []);
    let next = Array.isArray(r) ? null : (r.next_cursor != null ? r.next_cursor : (r.cursor != null ? r.cursor : r.next));
    if (next === '' || next === false || next === undefined) next = null;
    return { events: (Array.isArray(list) ? list : []).filter(isObj).map(normEvent), next_cursor: next == null ? null : String(next) };
  }
  function eventKey(ev) {
    if (!ev) return '';
    if (ev.id != null) return 'id:' + ev.id;
    return [ev.tx_id, ev.ts, ev.rule_id, ev.host].map(str).join('|');
  }
  // Appends a page without duplicates (cursor pages may overlap on new events).
  function mergeEvents(list, more) {
    const seen = new Set((list || []).map(eventKey));
    const out = (list || []).slice();
    (more || []).forEach((e) => { const k = eventKey(e); if (!seen.has(k)) { seen.add(k); out.push(e); } });
    return out;
  }
  // Pretty-printed raw audit record (JSON text/object), else the text as is.
  function rawText(raw) {
    if (raw == null || raw === '') return '';
    if (typeof raw === 'object') { try { return JSON.stringify(raw, null, 2); } catch (_) { return String(raw); } }
    const s = String(raw);
    try { const o = JSON.parse(s); if (o && typeof o === 'object') return JSON.stringify(o, null, 2); } catch (_) { /* not JSON */ }
    return s;
  }
  function requestLine(ev) {
    const m = str(ev && ev.method).trim().toUpperCase();
    const u = str(ev && ev.uri).trim();
    return (m ? m + ' ' : '') + (u || '/');
  }

  // ── Status ──
  function statusRoute(x) {
    const id = x.route_id != null ? x.route_id : x.id;
    return {
      route_id: id == null || id === '' ? null : Number(id),
      host: str(x.host || x.domain).toLowerCase(),
      mode: normMode(x.mode != null ? x.mode : x.waf_mode),
      paranoia: normParanoia(x.paranoia != null ? x.paranoia : x.waf_paranoia),
      events_24h: toInt(x.events_24h),
      blocked_24h: toInt(x.blocked_24h),
    };
  }
  // { engine_available, routes (sorted by host), totals } from GET /waf/status.
  // A missing engine_available counts as available (no warning without proof).
  function statusFrom(res) {
    const r = res || {};
    const routes = (Array.isArray(r.routes) ? r.routes : []).filter(isObj).map(statusRoute)
      .sort((a, b) => a.host.localeCompare(b.host) || ((a.route_id || 0) - (b.route_id || 0)));
    const s = isObj(r.totals) ? r.totals : (isObj(r.summary) ? r.summary : (isObj(r.stats) ? r.stats : null));
    const sum = (k) => routes.reduce((n, x) => n + x[k], 0);
    return {
      engine_available: r.engine_available !== false,
      routes,
      totals: {
        events_24h: s && s.events_24h != null ? toInt(s.events_24h) : sum('events_24h'),
        blocked_24h: s && s.blocked_24h != null ? toInt(s.blocked_24h) : sum('blocked_24h'),
        routes: routes.length,
      },
    };
  }
  // Route id for an event: its own route_id, else the WAF route of its host.
  function routeIdFor(ev, routes) {
    if (!ev) return null;
    if (ev.route_id != null && ev.route_id !== '') return Number(ev.route_id);
    const host = str(ev.host).toLowerCase();
    const hit = (routes || []).find((r) => r.host === host && r.route_id != null);
    return hit ? hit.route_id : null;
  }
  // Host select options: status hosts + hosts seen in events + the current one.
  function hostOptions(routes, events, current) {
    const set = new Set();
    (routes || []).forEach((r) => { if (r.host) set.add(r.host); });
    (events || []).forEach((e) => { const h = str(e.host).toLowerCase(); if (h) set.add(h); });
    const c = str(current).trim().toLowerCase();
    if (c) set.add(c);
    return Array.from(set).sort();
  }

  // ── Deep links (/waf?host=&action=&range=) ──
  function parseDeepLink(search) {
    const q = str(search).replace(/^\?/, '');
    const out = {};
    q.split('&').forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf('=');
      const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
      let v = '';
      try { v = decodeURIComponent((i < 0 ? '' : pair.slice(i + 1)).replace(/\+/g, ' ')); } catch (_) { v = ''; }
      if (k === 'host' || k === 'action' || k === 'range') out[k] = v;
    });
    return normFilter(out);
  }
  function deepLinkQuery(filter) {
    const f = normFilter(filter);
    const parts = [];
    if (f.host) parts.push('host=' + encodeURIComponent(f.host));
    if (f.action !== 'all') parts.push('action=' + f.action);
    if (f.range !== '24h') parts.push('range=' + f.range);
    return parts.length ? '?' + parts.join('&') : '';
  }
  function pageHref(host) { return '/waf' + deepLinkQuery({ host }); }

  function errorKey(code) { return ERROR_KEYS[str(code).toUpperCase()] || null; }
  function clientErrorKey(err) { return err ? 'waf.err.' + err : null; }

  const pure = {
    MODES, ACTIONS, ACTION_FILTERS, RANGES, RANGE_MS, PARANOIA_LEVELS, PAGE_SIZE, PATH_MAX, TAG_CLASS, ACTION_CLASS, ERROR_KEYS, ERROR_CODES,
    normMode, normParanoia, wafOf, isHttpEntry, wafState, toRouteFields, modeKey, paranoiaKey, paranoiaHintKey, tagKey, chipKey,
    parseRuleId, normPath, validPath, parseExclusions, exclusionsOf, exclusionError, exclusionBody, applyExclusion, exclusionsFromResponse, exclusionCount,
    actionKey, pathOfUri, normFilter, rangeFrom, eventsQuery, matchesFilter, eventsFrom, eventKey, mergeEvents, rawText, requestLine,
    statusFrom, routeIdFor, hostOptions, parseDeepLink, deepLinkQuery, pageHref, errorKey, clientErrorKey,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ──────────────────────────────────────────────────────
  const doc = win.document;
  const GC = win.GC = win.GC || {};
  GC.t = GC.t || {};
  ['waf-i18n', 'zones-i18n'].forEach((id) => {
    try {
      const island = doc.getElementById(id);
      if (!island) return;
      const strings = JSON.parse(island.textContent || '{}');
      Object.keys(strings).forEach((k) => { if (GC.t[k] === undefined) GC.t[k] = strings[k]; });
    } catch (_) { /* keep whatever GC.t has */ }
  });

  function t(key, params) {
    let s = GC.t[key] != null ? GC.t[key] : key;
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function lang() { return GC.language || doc.documentElement.lang || 'de'; }
  // License flag from the layout (window.GC.features.waf).
  function licensed() { return !!(GC.features && GC.features.waf === true); }

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
    info: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, y1: 16, x2: 12, y2: 12 }], ['line', { x1: 12, y1: 8, x2: 12.01, y2: 8 }]],
    plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
    shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
    ban: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 4.93, y1: 4.93, x2: 19.07, y2: 19.07 }]],
    path: [['polyline', { points: '16 18 22 12 16 6' }], ['polyline', { points: '8 6 2 12 8 18' }]],
    ext: [['path', { d: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6' }], ['polyline', { points: '15 3 21 3 21 9' }], ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]],
    pencil: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z' }]],
    refresh: [['polyline', { points: '23 4 23 10 17 10' }], ['path', { d: 'M20.49 15a9 9 0 11-2.12-9.36L23 10' }]],
    down: [['polyline', { points: '6 9 12 15 18 9' }]],
    lock: [['rect', { x: 3, y: 11, width: 18, height: 11, rx: 2 }], ['path', { d: 'M7 11V7a5 5 0 0110 0v4' }]],
  };
  function icon(name, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    const s = String(size || 14);
    [['viewBox', '0 0 24 24'], ['width', s], ['height', s], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'],
      ['class', 'wf-ic']].forEach((a) => svg.setAttribute(a[0], a[1]));
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
  function isNotFound(err) { return !!err && !!err.data && err.data.status === 404; }
  function errMsg(err) {
    const d = err && err.data;
    if (d && d.feature === 'waf') return t('waf.err.license');
    const k = errorKey(d && d.code);
    if (k) return t(k);
    if (isNotFound(err) && !(d && d.error)) return t('waf.backend_missing');
    return (err && err.message) || t('waf.load_error');
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleString(lang(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return d.toISOString(); }
  }

  // Own fetch instead of api.*: the thrown Error must carry the HTTP status
  // (err.data.status) so a 404 of a server without the WAF API degrades to a
  // hint, and DELETE needs a JSON body (api.del sends none).
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
    const e = new Error((data && data.error) || 'API error: ' + res.status);
    e.data = Object.assign({}, data || {}, { status: res.status });
    throw e;
  }

  // GET /waf/status, shared by the editor and the domain dialog (30 s cache).
  let statusCache = null;
  function fetchStatus(opts) {
    const fresh = !!(opts && opts.fresh);
    if (!fresh && statusCache && Date.now() - statusCache.at < 30000) return statusCache.promise;
    const promise = request('GET', '/api/v1/waf/status').then(statusFrom);
    statusCache = { at: Date.now(), promise };
    promise.catch(() => { if (statusCache && statusCache.promise === promise) statusCache = null; });
    return promise;
  }
  async function fetchEvents(filter, opts) {
    const res = await request('GET', '/api/v1/waf/events' + eventsQuery(filter, opts));
    return eventsFrom(res);
  }
  function exclusionUrl(routeId) { return '/api/v1/waf/routes/' + encodeURIComponent(routeId) + '/exclusions'; }
  function announce(detail) {
    try { doc.dispatchEvent(new CustomEvent('gc:waf-exclusions', { detail: Object.assign({ local: true }, detail) })); } catch (_) { /* ignore */ }
  }
  // → { exclusions|null, res }
  async function addExclusion(routeId, body) {
    const res = await request('POST', exclusionUrl(routeId), body);
    statusCache = null;
    announce({ route_id: routeId, op: 'add', body });
    return { exclusions: exclusionsFromResponse(res), res };
  }
  async function removeExclusion(routeId, body) {
    const res = await request('DELETE', exclusionUrl(routeId), body);
    statusCache = null;
    announce({ route_id: routeId, op: 'remove', body });
    return { exclusions: exclusionsFromResponse(res), res };
  }

  // ── Dialog (own overlay, stacks above the domain modal / editor) ──
  function dialog(opts) {
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const closeBtn = el('button', { type: 'button', class: 'modal-close', 'aria-label': t('common.close') }, [icon('x', 16)]);
    const body = el('div', { class: 'modal-body zn-dialog-body wf-dialog-body' });
    const foot = el('div', { class: 'modal-foot zn-dialog-foot wf-dialog-foot' });
    const titleId = 'wf-dlg-' + Math.random().toString(36).slice(2, 8);
    const box = el('div', { class: 'modal zn-dialog-box wf-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'modal-head' }, [el('span', { class: 'modal-title', id: titleId, text: opts.title || '' }), closeBtn]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay zn-dialog wf-dialog', style: 'display:flex', dataset: { wfDialog: opts.kind || 'dialog' } }, [box]);
    const prevFocus = doc.activeElement;
    function close(result) {
      if (done) return;
      done = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus && doc.contains(prevFocus)) prevFocus.focus();
      resolveFn(result);
    }
    // Capture phase so app.js's global Escape never closes the modal underneath.
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
    }
    closeBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    return { overlay, box, body, foot, close, promise };
  }
  function hintEl(text, kind) {
    return el('div', { class: 'wf-hint' + (kind ? ' wf-hint-' + kind : '') }, [icon(kind === 'warn' ? 'alert' : 'info', 12), el('span', { text })]);
  }
  function errorBox() {
    const box = el('div', { class: 'zn-field-error wf-field-error', role: 'alert' });
    box.hidden = true;
    return { node: box, show(text) { box.textContent = text || ''; box.hidden = !text; }, hide() { box.hidden = true; } };
  }
  function modeTag(mode, extra) {
    const m = normMode(mode);
    return el('span', { class: 'tag ' + TAG_CLASS[m] + ' wf-mode-tag' + (extra ? ' ' + extra : ''), dataset: { wafMode: m } }, [el('span', { class: 'tag-dot' }), t(modeKey(m))]);
  }
  function actionTag(action) {
    const a = actionKey(action);
    return el('span', { class: 'tag ' + ACTION_CLASS[a] + ' wf-action-tag', dataset: { action: a } }, [
      el('span', { class: 'tag-dot' }), a === 'unknown' ? str(action) || '—' : t('waf.action_' + a),
    ]);
  }

  // ── Exclusion dialogs (event row actions on the WAF page) ──
  // ctx: { routeId, host, ruleId, uri }. Resolves { kind, value, exclusions }
  // after a successful POST, or null (cancelled). opts.current: exclusions
  // known for the route (client-side duplicate check).
  function openExclusionDialog(kind, ctx, opts) {
    const o = opts || {};
    const rule = kind === 'rule';
    const host = str(ctx.host);
    const d = dialog({ title: t(rule ? 'waf.exclude_rule_title' : 'waf.exclude_path_title'), kind: rule ? 'exclude-rule' : 'exclude-path' });
    d.overlay.classList.add('wf-exclude-dialog');
    const err = errorBox();
    const ok = el('button', { type: 'button', class: 'btn btn-primary wf-btn-ok', text: t('waf.exclude_ok') });
    let input = null;
    if (rule) {
      d.body.appendChild(el('p', { class: 'zn-dialog-msg wf-dialog-msg', text: t('waf.exclude_rule_msg', { rule: str(ctx.ruleId), host }) }));
      d.body.appendChild(hintEl(t('waf.exclude_rule_detail')));
    } else {
      input = el('input', { type: 'text', class: 'form-input zn-input wf-mono wf-path-input', value: pathOfUri(ctx.uri), maxLength: PATH_MAX, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('waf.exclude_path_label') });
      d.body.appendChild(el('p', { class: 'zn-dialog-msg wf-dialog-msg', text: t('waf.exclude_path_msg', { host }) }));
      d.body.appendChild(el('label', { class: 'wf-field' }, [el('span', { class: 'wf-f-label', text: t('waf.exclude_path_label') }), input]));
      d.body.appendChild(hintEl(t('waf.exclude_path_detail'), 'warn'));
      input.addEventListener('input', () => err.hide());
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
    }
    d.body.appendChild(err.node);
    ok.addEventListener('click', async () => {
      err.hide();
      const value = rule ? ctx.ruleId : input.value;
      const bad = exclusionError(kind, value, o.current || null);
      if (bad) { err.show(t(clientErrorKey(bad))); if (input) input.focus(); return; }
      busy(ok, true);
      try {
        const r = await addExclusion(ctx.routeId, exclusionBody(kind, value));
        const shown = rule ? String(parseRuleId(value)) : normPath(value);
        toast(t(rule ? 'waf.excluded_rule' : 'waf.excluded_path', { rule: shown, path: shown, host }), 'success');
        d.close({ kind, value: rule ? parseRuleId(value) : normPath(value), exclusions: r.exclusions });
      } catch (e) {
        err.show(errMsg(e));
        busy(ok, false);
      }
    });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(ok);
    if (input) { input.focus(); input.select(); } else ok.focus();
    return d.promise;
  }

  // ── Domain dialog: entry tag + small WAF dialog ──
  // opts.onOpen(entry): open the entry editor (Security tab); without it the
  // tag opens openEntryDialog (mode, paranoia, link to /waf?host=).
  function entryTag(entry, opts) {
    const state = wafState(entry);
    if (!state) return null;
    const o = opts || {};
    const w = wafOf(entry);
    return el('button', {
      type: 'button', class: 'tag ' + TAG_CLASS[state] + ' zn-opt-tag wf-entry-tag wf-entry-' + state,
      title: t('waf.tag_hint', { mode: t(modeKey(state)), paranoia: w.paranoia }), 'aria-haspopup': 'dialog',
      dataset: { waf: state },
      on: { click: (e) => { e.stopPropagation(); if (o.onOpen) o.onOpen(entry); else openEntryDialog(entry, o); } },
    }, [icon('shield', 10), t(tagKey(state))]);
  }
  function openEntryDialog(entry, opts) {
    const o = opts || {};
    const w = wafOf(entry);
    const host = str(entry && entry.domain);
    const d = dialog({ title: t('waf.dialog_title', { host }), kind: 'entry' });
    d.overlay.classList.add('wf-entry-dialog');
    d.body.appendChild(el('div', { class: 'wf-facts' }, [
      el('div', { class: 'wf-fact' }, [el('span', { class: 'wf-f-label', text: t('waf.mode_label') }), modeTag(w.mode)]),
      el('div', { class: 'wf-fact' }, [el('span', { class: 'wf-f-label', text: t('waf.paranoia_label') }), el('span', { class: 'wf-fact-val', text: t(paranoiaKey(w.paranoia)) })]),
    ]));
    d.body.appendChild(hintEl(t(w.mode === 'block' ? 'waf.mode_block_hint' : 'waf.mode_detect_hint')));
    if (w.mode === 'detect') d.body.appendChild(hintEl(t('waf.recommendation')));
    d.foot.appendChild(el('a', { class: 'btn btn-ghost wf-events-link', href: pageHref(host) }, [icon('ext', 12), t('waf.events_link')]));
    if (o.onEdit) d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-primary wf-btn-edit', on: { click: () => { d.close(null); o.onEdit(entry); } } }, [icon('pencil', 12), t('waf.dialog_edit')]));
    else d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-secondary', text: t('common.close'), on: { click: () => d.close(null) } }));
    return d;
  }

  // ── Entry editor: exclusion list (#edit-waf-exclusions) ──
  // Works on the saved route immediately (POST/DELETE per item). Returns
  // { set(route), setDisabled(bool), get() }.
  function exclusionsEditor(container, route, opts) {
    const o = opts || {};
    let routeId = route && route.id;
    let cur = exclusionsOf(route);
    let disabled = false;
    const list = el('div', { class: 'wf-excl-list', role: 'list' });
    const type = el('select', { class: 'form-select wf-excl-type', 'aria-label': t('waf.exclusion_type_label') }, [
      el('option', { value: 'rule', text: t('waf.exclusion_type_rule') }),
      el('option', { value: 'path', text: t('waf.exclusion_type_path') }),
    ]);
    const input = el('input', { type: 'text', class: 'form-input wf-mono wf-excl-input', placeholder: t('waf.exclusion_ph_rule'), maxLength: PATH_MAX, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('waf.exclusions_label') });
    const addBtn = el('button', { type: 'button', class: 'btn btn-ghost wf-excl-add' }, [icon('plus', 12), t('waf.exclusion_add')]);
    const err = errorBox();
    type.addEventListener('change', () => { input.placeholder = t(type.value === 'rule' ? 'waf.exclusion_ph_rule' : 'waf.exclusion_ph_path'); err.hide(); input.focus(); });
    input.addEventListener('input', () => err.hide());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    addBtn.addEventListener('click', add);

    function row(kind, value) {
      const label = kind === 'rule' ? t('waf.exclusion_rule', { rule: value }) : t('waf.exclusion_path', { path: value });
      const rm = el('button', {
        type: 'button', class: 'zn-ibtn zn-ibtn-danger wf-excl-remove', title: t('waf.exclusion_remove', { value }), 'aria-label': t('waf.exclusion_remove', { value }), disabled,
      }, [icon('x', 12)]);
      rm.addEventListener('click', async () => {
        err.hide();
        busy(rm, true);
        try {
          const r = await removeExclusion(routeId, exclusionBody(kind, value));
          cur = r.exclusions || applyExclusion(cur, kind, value, true);
          toast(t('waf.exclusion_removed'), 'success');
          render();
          if (o.onChanged) o.onChanged(cur);
        } catch (e) { err.show(errMsg(e)); busy(rm, false); }
      });
      return el('div', { class: 'wf-excl-row', role: 'listitem', dataset: { kind, value: String(value) } }, [
        el('span', { class: 'tag tag-grey wf-excl-kind', text: t(kind === 'rule' ? 'waf.exclusion_type_rule' : 'waf.exclusion_type_path') }),
        el('code', { class: 'wf-excl-value', title: label, text: String(value) }),
        el('span', { class: 'zn-spacer' }),
        rm,
      ]);
    }
    function render() {
      list.replaceChildren();
      if (!cur.rule_ids.length && !cur.paths.length) list.appendChild(el('div', { class: 'wf-excl-empty', text: t('waf.exclusions_empty') }));
      cur.rule_ids.forEach((r) => list.appendChild(row('rule', r)));
      cur.paths.forEach((p) => list.appendChild(row('path', p)));
      [type, input, addBtn].forEach((n) => { n.disabled = disabled || routeId == null; });
    }
    async function add() {
      err.hide();
      const kind = type.value === 'path' ? 'path' : 'rule';
      const value = input.value;
      if (!normPath(value)) { input.focus(); return; }
      const bad = exclusionError(kind, value, cur);
      if (bad) { err.show(t(clientErrorKey(bad))); input.focus(); return; }
      busy(addBtn, true);
      try {
        const r = await addExclusion(routeId, exclusionBody(kind, value));
        cur = r.exclusions || applyExclusion(cur, kind, value, false);
        input.value = '';
        toast(t('waf.exclusion_added'), 'success');
        render();
        if (o.onChanged) o.onChanged(cur);
      } catch (e) { err.show(errMsg(e)); } finally { busy(addBtn, false); render(); }
    }
    container.replaceChildren(
      el('div', { class: 'wf-excl-head' }, [el('span', { class: 'wf-f-label', text: t('waf.exclusions_label') })]),
      list,
      el('div', { class: 'wf-excl-add-row' }, [type, input, addBtn]),
      err.node,
      el('div', { class: 'wf-editor-hint wf-excl-hint', text: t('waf.exclusions_hint') }),
    );
    render();
    return {
      set(r) { routeId = r && r.id; cur = exclusionsOf(r); err.hide(); input.value = ''; render(); },
      setDisabled(on) { disabled = !!on; render(); },
      get() { return parseExclusions(cur); },
    };
  }

  // Engine / API hint for the editor: fills node with the warning when the
  // engine is missing or the WAF API answers 404; empties it otherwise.
  async function engineHint(node) {
    if (!node) return null;
    try {
      const s = await fetchStatus();
      node.textContent = s.engine_available ? '' : t('waf.engine_missing');
      node.dataset.wafEngine = s.engine_available ? 'ok' : 'missing';
      return s;
    } catch (e) {
      node.textContent = isNotFound(e) ? t('waf.backend_missing') : '';
      node.dataset.wafEngine = isNotFound(e) ? 'api-missing' : 'unknown';
      return null;
    }
  }

  return Object.assign(pure, {
    t, el, append, icon, busy, toast, errMsg, isNotFound, fmtTime, licensed, request, fetchStatus, fetchEvents,
    addExclusion, removeExclusion, dialog, hintEl, modeTag, actionTag, openExclusionDialog, entryTag, openEntryDialog,
    exclusionsEditor, engineHint,
  });
});
