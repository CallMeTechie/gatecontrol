'use strict';

// Notification centre — admin page /notifications (System › Benachrichtigungen,
// docs/feature-notification-center.md "Portal und Admin-Oberfläche").
//
// Five tabs, addressable by hash: #overview (default), #rules[/<event_id>],
// #devices, #history[/<id>], #settings. Arrow keys / Home / End move between
// the tabs. Every value comes from the admin API at runtime:
//   GET  /api/v1/notify/overview                 Übersicht
//   GET  /api/v1/notify/rules, PUT …/rules/:id   Regeln (table + editor)
//   GET  /api/v1/notify/devices                  Geräte (presence)
//   POST /api/v1/notify/send, POST …/test        "Nachricht senden", tests
//   GET  /api/v1/notify/history[/:id], POST …/:id/resend   Verlauf
//   GET/PUT /api/v1/notify/settings              Einstellungen
// A 404 (server without the notification centre yet) or any other error
// renders a calm state box with "Erneut versuchen" — the page never breaks.
// A 403 of a licensed endpoint shows the licence hint (feature email_alerts).
// Live: gc:push_presence (presence of one device) and gc:notify (a new
// notification) from events.js.
//
// Strings: the #nc-i18n island (notify.*, common.*). DOM only through el()/
// textContent — no innerHTML. The pure helpers are exported for node:test
// (tests/notify_admin_page.test.js); in the browser the file mounts itself.
(function (root, factory) {
  const core = factory(typeof window !== 'undefined' ? window : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof self !== 'undefined' ? self : this, function (win) {
  const TABS = ['overview', 'rules', 'devices', 'history', 'settings'];
  const PRIORITIES = ['info', 'normal', 'high', 'critical'];
  const GROUPS = ['security', 'peers', 'routes', 'system', 'plugins'];
  const SOURCES = ['security', 'devices', 'services', 'system', 'plugins'];
  const FILTERS = ['all', 'important', 'undelivered', 'plugins', 'manual'];
  const DEVICE_STATES = ['connected', 'restricted', 'offline', 'unsupported'];
  const RECOVERY = ['off', 'silent', 'normal'];
  const TARGETS = ['all', 'users', 'groups', 'devices'];
  const RULE_FIELDS = ['enabled', 'priority', 'recipients', 'ch_app', 'ch_email', 'ch_webhook', 'email_fallback_s', 'delay_s', 'bundle_s', 'recovery'];
  const SETTINGS_FIELDS = ['enabled', 'allow_direct', 'keepalive_s', 'max_streams', 'retention_h', 'max_queue', 'history_days', 'email_fallback_s'];
  const SETTINGS_BOOL = ['enabled', 'allow_direct'];
  const DELAY_CHOICES = [0, 60, 120, 300, 600, 900];
  const BUNDLE_CHOICES = [0, 300, 900, 1800, 3600];
  const FALLBACK_CHOICES = [0, 120, 300, 600, 900, 1800, 3600];
  const TTL_CHOICES = [3600, 6 * 3600, 24 * 3600, 3 * 86400];
  const HISTORY_LIMIT = 50;
  const TITLE_MAX = 120;
  const BODY_MAX = 1000;

  // ─── Pure helpers ────────────────────────────────────────────────────────
  function str(v) { return v == null ? '' : String(v); }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function bool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function count(v) { return Math.max(0, Math.round(num(v, 0))); }

  // lower case, without diacritics (ä → a), ß → ss (like the quick search)
  function norm(s) {
    let v = str(s).toLowerCase().replace(/ß/g, 'ss');
    try { v = v.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* old engines */ }
    return v;
  }

  /** '#rules/gateway_offline' → { tab: 'rules', id: 'gateway_offline' }. */
  function parseHash(hash) {
    const h = str(hash).replace(/^#/, '');
    const i = h.indexOf('/');
    const tab = i < 0 ? h : h.slice(0, i);
    let id = i < 0 ? '' : h.slice(i + 1);
    try { id = decodeURIComponent(id); } catch (_) { /* keep raw */ }
    if (TABS.indexOf(tab) < 0) return { tab: 'overview', id: '' };
    return { tab, id: tab === 'rules' || tab === 'history' ? id : '' };
  }
  function hashFor(tab, id) {
    const t = TABS.indexOf(tab) >= 0 ? tab : 'overview';
    if (t === 'overview') return '';
    return '#' + t + (id ? '/' + encodeURIComponent(str(id)) : '');
  }

  function prioOf(p) { return PRIORITIES.indexOf(p) >= 0 ? p : 'normal'; }
  function prioTone(p) { return { critical: 'crit', high: 'high', normal: 'info', info: 'muted' }[prioOf(p)]; }

  /** Ids of a list (numbers or {id}), de-duplicated, order kept. */
  function idList(a) {
    const out = [];
    const seen = new Set();
    (Array.isArray(a) ? a : []).forEach((x) => {
      const v = isObj(x) ? x.id : x;
      if (v == null || v === '') return;
      const k = String(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    });
    return out;
  }
  function sameIds(a, b) {
    const A = idList(a).map(String).sort();
    const B = idList(b).map(String).sort();
    return A.length === B.length && A.every((x, i) => x === B[i]);
  }
  function normRecipients(r) {
    const o = isObj(r) ? r : {};
    return { admins: bool(o.admins), owner: bool(o.owner), subscribers: bool(o.subscribers), users: idList(o.users), groups: idList(o.groups) };
  }
  function sameRecipients(a, b) {
    const x = normRecipients(a);
    const y = normRecipients(b);
    return x.admins === y.admins && x.owner === y.owner && x.subscribers === y.subscribers && sameIds(x.users, y.users) && sameIds(x.groups, y.groups);
  }
  function hasRecipient(r) {
    const x = normRecipients(r);
    return x.admins || x.owner || x.subscribers || x.users.length > 0 || x.groups.length > 0;
  }

  function normRule(r) {
    const o = isObj(r) ? r : {};
    return {
      event_id: str(o.event_id),
      group: GROUPS.indexOf(o.group) >= 0 ? o.group : 'system',
      label: str(o.label) || str(o.event_id),
      priority: prioOf(o.priority),
      recipients: normRecipients(o.recipients),
      ch_app: bool(o.ch_app),
      ch_email: bool(o.ch_email),
      ch_webhook: bool(o.ch_webhook),
      email_fallback_s: count(o.email_fallback_s),
      delay_s: count(o.delay_s),
      bundle_s: count(o.bundle_s),
      recovery: RECOVERY.indexOf(o.recovery) >= 0 ? o.recovery : 'off',
      enabled: o.enabled === undefined ? true : bool(o.enabled),
      plugin_id: o.plugin_id ? str(o.plugin_id) : null,
    };
  }
  function copyRule(r) {
    const c = Object.assign({}, r);
    c.recipients = Object.assign({}, r.recipients, { users: r.recipients.users.slice(), groups: r.recipients.groups.slice() });
    return c;
  }
  /** The fields of `draft` that differ from `orig` — the body of PUT /rules/:id. */
  function ruleDiff(orig, draft) {
    const out = {};
    RULE_FIELDS.forEach((f) => {
      if (f === 'recipients') {
        if (!sameRecipients(orig.recipients, draft.recipients)) {
          const r = normRecipients(draft.recipients);
          out.recipients = { admins: r.admins, owner: r.owner, subscribers: r.subscribers, users: r.users.slice(), groups: r.groups.slice() };
        }
      } else if (orig[f] !== draft[f]) out[f] = draft[f];
    });
    return out;
  }
  function ruleMatches(rule, query, group) {
    if (group && rule.group !== group) return false;
    const toks = norm(query).trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return true;
    const hay = norm([rule.label, rule.event_id, rule.plugin_id || ''].join(' '));
    return toks.every((tk) => hay.indexOf(tk) >= 0);
  }
  /** Rules in catalogue group order (security, peers, routes, system, plugins); server order inside a group. */
  function groupRules(rules) {
    return GROUPS.map((g) => ({ group: g, rules: (rules || []).filter((r) => r.group === g) })).filter((x) => x.rules.length > 0);
  }
  /** A plugin rule is a Pro feature (plugin topics, docs "Entscheidungen" 1). */
  function ruleLocked(rule, pro) { return !pro && (rule.group === 'plugins' || !!rule.plugin_id); }

  /** Without the licence the e-mail switch of a non-free core event is locked (free list from the page). */
  function emailLocked(rule, pro, free) {
    if (pro) return false;
    if (rule.group === 'plugins' || rule.plugin_id) return true;
    const list = Array.isArray(free) ? free : FREE_EVENTS;
    return list.indexOf(rule.event_id) < 0;
  }
  let FREE_EVENTS = [];

  /** Recipients as display parts: [{kind:'admins'}|{kind:'user',id,name}|…]. */
  function recipientParts(rcpt, users, groups) {
    const r = normRecipients(rcpt);
    const nameIn = (list, id) => {
      const hit = (Array.isArray(list) ? list : []).find((x) => isObj(x) && String(x.id) === String(id));
      return hit ? str(hit.name) : '#' + id;
    };
    const out = [];
    if (r.admins) out.push({ kind: 'admins' });
    if (r.owner) out.push({ kind: 'owner' });
    if (r.subscribers) out.push({ kind: 'subscribers' });
    r.users.forEach((id) => out.push({ kind: 'user', id, name: nameIn(users, id) }));
    r.groups.forEach((id) => out.push({ kind: 'group', id, name: nameIn(groups, id) }));
    return out;
  }

  /** Delivery summary of a notification (overview "Letzte"). */
  function statusOf(item) {
    const o = isObj(item) ? item : {};
    const total = count(o.total);
    const delivered = count(o.delivered);
    const read = count(o.read);
    if (bool(o.silent)) return { key: 'notify.status.silent', params: {}, tone: 'muted' };
    if (!total) return { key: null, text: '–', params: {}, tone: 'muted' };
    if (read >= total) return { key: 'notify.status.read', params: { read, total }, tone: 'good' };
    return { key: 'notify.status.delivered', params: { delivered, total }, tone: delivered >= total ? 'good' : 'warn' };
  }
  /** Status column of the history (ok / waiting / partial). */
  function histStatusOf(item) {
    const o = isObj(item) ? item : {};
    const total = count(o.total);
    const delivered = count(o.delivered);
    const read = count(o.read);
    const open = Math.max(0, total - delivered);
    if (!total) return bool(o.silent) ? { key: 'notify.status.silent', params: {}, tone: 'muted' } : { key: null, text: '–', params: {}, tone: 'muted' };
    const status = ['ok', 'partial', 'waiting'].indexOf(o.status) >= 0 ? o.status : (open ? 'waiting' : 'ok');
    if (status === 'partial' && open) return { key: 'notify.hist.status_partial', params: { delivered, total, n: open }, tone: 'crit' };
    if (status === 'waiting' && open) return { key: 'notify.hist.status_waiting', params: { delivered, total, n: open }, tone: 'warn' };
    if (read >= total) return { key: 'notify.status.read', params: { read, total }, tone: 'good' };
    return { key: 'notify.hist.status_ok', params: { delivered, total }, tone: 'good' };
  }

  /** Seconds as a duration key: {key, params} for the "seit …" texts. */
  function durationOf(ms) {
    const s = Math.max(0, Math.floor(num(ms, 0) / 1000));
    if (s < 60) return { key: 'notify.dur.s', params: { n: s } };
    const m = Math.floor(s / 60);
    if (m < 60) return { key: 'notify.dur.min', params: { n: m } };
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? { key: 'notify.dur.h_min', params: { h, m: m % 60 } } : { key: 'notify.dur.h', params: { n: h } };
    const d = Math.floor(h / 24);
    return { key: 'notify.dur.d', plural: true, params: { count: d } };
  }
  /** A span in seconds for the selects: {key, plural, params} or null for 0. */
  function spanOf(seconds) {
    const s = count(seconds);
    if (!s) return null;
    if (s % 86400 === 0) return { key: 'notify.time.d', plural: true, params: { count: s / 86400 } };
    if (s % 3600 === 0) return { key: 'notify.time.h', plural: true, params: { count: s / 3600 } };
    if (s % 60 === 0) return { key: 'notify.time.min', plural: true, params: { count: s / 60 } };
    return { key: 'notify.time.s', params: { n: s } };
  }
  /** Choice list for a select, with the current value added when it is not one of them. */
  function choicesWith(list, current) {
    const out = list.slice();
    const c = count(current);
    if (out.indexOf(c) < 0) out.push(c);
    return out.sort((a, b) => a - b);
  }
  /** Latency in ms → seconds with one decimal below 10 s ("0,4"). */
  function latencyNumber(ms, lang) {
    const s = Math.max(0, num(ms, 0)) / 1000;
    const digits = s < 10 ? 1 : 0;
    try { return new Intl.NumberFormat(lang || 'de', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(s); } catch (_) { return s.toFixed(digits); }
  }

  /** Who a manual message reaches right now / later, from the presence list. */
  function reachOf(devices, target) {
    const list = (Array.isArray(devices) ? devices : []).filter((d) => isObj(d) && d.state !== 'unsupported');
    const tg = isObj(target) ? target : { type: 'all', ids: [] };
    const ids = new Set(idList(tg.ids).map(String));
    let sel;
    if (tg.type === 'all') sel = list;
    else if (tg.type === 'users') sel = list.filter((d) => d.user && ids.has(String(d.user.id)));
    else if (tg.type === 'devices') sel = list.filter((d) => ids.has(String(d.token_id)));
    else return { known: false, now: 0, later: 0, total: 0 };
    const now = sel.filter((d) => d.state === 'connected' || d.state === 'restricted').length;
    return { known: true, now, later: sel.length - now, total: sel.length };
  }
  /** "Gültig bis" choices: tonight 23:00 (when ≥ 30 min away) plus fixed spans. */
  function ttlChoices(nowDate, maxTtl) {
    const now = nowDate instanceof Date ? nowDate : new Date();
    const max = count(maxTtl) || Infinity; // the server allows 60 s … retention_h
    const out = [];
    const tonight = new Date(now.getTime());
    tonight.setHours(23, 0, 0, 0);
    const left = Math.round((tonight.getTime() - now.getTime()) / 1000);
    if (left >= 1800 && left <= max) out.push({ kind: 'tonight', ttl: left, at: tonight });
    TTL_CHOICES.filter((s) => s <= max).forEach((s) => out.push({ kind: 'span', ttl: s }));
    if (!out.length) out.push({ kind: 'span', ttl: Math.max(60, Math.min(3600, count(maxTtl) || 3600)) });
    return out;
  }
  function sendBody(target, form) {
    const tg = isObj(target) ? target : {};
    const type = TARGETS.indexOf(tg.type) >= 0 ? tg.type : 'all';
    return {
      target: { type, ids: type === 'all' ? [] : idList(tg.ids) },
      title: str(form && form.title).trim().slice(0, TITLE_MAX),
      body: str(form && form.body).trim().slice(0, BODY_MAX),
      priority: prioOf(form && form.priority),
      ttl_s: count(form && form.ttl_s) || 86400,
    };
  }

  // Rule group → overview source (security, devices, services, system, plugins).
  const GROUP_SOURCE = { security: 'security', peers: 'devices', routes: 'services', system: 'system', plugins: 'plugins' };
  /**
   * Where a notification came from. The server writes source 'system' for core
   * events, 'plugin:<id>' and 'manual:<user id>'; the topic (overview) or the
   * rule group of the event (history) tells the core events apart.
   * → {key} | {plugin: id} | {text}
   */
  function sourceKind(source, topic, group) {
    const s = str(source);
    if (/^manual(:|$)/.test(s)) return { key: 'notify.source.manual' };
    const m = /^plugins?[:.](.+)$/.exec(s);
    if (m) return { plugin: m[1] };
    if (SOURCES.indexOf(topic) >= 0) return { key: 'notify.source.' + topic };
    if (GROUP_SOURCE[group]) return { key: 'notify.source.' + GROUP_SOURCE[group] };
    if (SOURCES.indexOf(s) >= 0) return { key: 'notify.source.' + s };
    return { text: s };
  }
  /** Field codes of a 400 (`fields: {field: code}`) → list of {field, code}. */
  function fieldCodes(data) {
    const f = isObj(data) && isObj(data.fields) ? data.fields : {};
    return Object.keys(f).map((k) => ({ field: k, code: str(f[k]) }));
  }
  function historyQuery(o) {
    const f = FILTERS.indexOf(o && o.filter) >= 0 ? o.filter : 'all';
    const days = [1, 7, 30].indexOf(Number(o && o.days)) >= 0 ? Number(o.days) : 7;
    let q = '?filter=' + f + '&days=' + days + '&limit=' + HISTORY_LIMIT;
    if (o && o.before != null && o.before !== '') q += '&before=' + encodeURIComponent(str(o.before));
    return q;
  }
  function normSettings(s) {
    const o = isObj(s) ? s : {};
    const out = {};
    SETTINGS_FIELDS.forEach((f) => { out[f] = SETTINGS_BOOL.indexOf(f) >= 0 ? bool(o[f]) : (o[f] == null ? null : num(o[f], null)); });
    return out;
  }
  function settingsDiff(orig, draft) {
    const out = {};
    SETTINGS_FIELDS.forEach((f) => { if (draft[f] !== orig[f]) out[f] = draft[f]; });
    return out;
  }
  /** null = fine; else {min,max} of the violated range. */
  function rangeError(value, min, max) {
    if (value === '' || value == null) return { min, max };
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return { min, max };
    return null;
  }

  const pure = {
    TABS, PRIORITIES, GROUPS, SOURCES, FILTERS, DEVICE_STATES, RULE_FIELDS, SETTINGS_FIELDS, TTL_CHOICES, HISTORY_LIMIT,
    GROUP_SOURCE, fieldCodes, emailLocked, norm, parseHash, hashFor, prioOf, prioTone, idList, normRecipients, sameRecipients, hasRecipient, normRule, copyRule,
    ruleDiff, ruleMatches, groupRules, ruleLocked, recipientParts, statusOf, histStatusOf, durationOf, spanOf, choicesWith,
    latencyNumber, reachOf, ttlChoices, sendBody, sourceKind, historyQuery, normSettings, settingsDiff, rangeError,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ────────────────────────────────────────────────────────
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const page = $('nc-page');
  if (!page) return pure;

  function readJson(id) {
    try { return JSON.parse((doc.getElementById(id) || {}).textContent || '{}') || {}; } catch (_) { return {}; }
  }
  const I18N = readJson('nc-i18n');
  const CTX = readJson('nc-ctx');
  const LANG = CTX.lang || doc.documentElement.lang || 'de';
  FREE_EVENTS = Array.isArray(CTX.free) ? CTX.free.map(String) : [];

  function has(key) { return I18N[key] != null || !!(win.GC && win.GC.t && win.GC.t[key] != null); }
  function T(key, params) {
    let s = I18N[key];
    if (s == null && win.GC && win.GC.t) s = win.GC.t[key];
    if (s == null) s = key;
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function P(base, n, params) { return T(base + (Number(n) === 1 ? '_one' : '_other'), Object.assign({ count: n }, params || {})); }
  function TK(desc) { if (!desc) return ''; return desc.plural ? P(desc.key, desc.params.count, desc.params) : T(desc.key, desc.params); }
  // A key built from server data (state, kind): the label when we have one, else the raw value.
  function label(prefix, id) { const k = prefix + id; return has(k) ? T(k) : str(id); }

  // ── DOM helpers ──
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Attribute names are literals of this file only (never server text);
  // href only for same-origin paths and in-page anchors.
  function safeHref(v) {
    const s = str(v);
    if (/^\/(?![/\\])/.test(s) && s.indexOf('\\') < 0) return s;
    if (/^#[\w/%.:-]*$/.test(s)) return s;
    return '#';
  }
  const PLAIN_ATTRS = ['id', 'role', 'title', 'colspan', 'scope', 'tabindex', 'maxlength', 'placeholder', 'rows', 'datetime', 'name', 'autocomplete', 'for'];
  function setAttr(n, k, v) {
    const s = v === true ? '' : String(v);
    if (k === 'href') n.setAttribute('href', safeHref(v));
    else if (PLAIN_ATTRS.indexOf(k) >= 0) n.setAttribute(k, s);
    else if (/^aria-[a-z]+$/.test(k) || /^data-[a-z][a-z-]*$/.test(k)) n.setAttribute(k, s);
  }
  function el(tag, props, children) {
    const n = doc.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected' || k === 'hidden' || k === 'type') n[k] = v;
      else setAttr(n, k, v);
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      n.append(c instanceof win.Node ? c : String(c));
    });
    return n;
  }
  function icon(d, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['width', String(size || 18)], ['height', String(size || 18)]]
      .forEach((a) => svg.setAttribute(a[0], a[1]));
    str(d).split('|').forEach((part) => {
      const path = doc.createElementNS(SVGNS, 'path');
      path.setAttribute('d', part);
      svg.appendChild(path);
    });
    return svg;
  }
  const ICON = {
    security: 'M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z|M12 8v5M12 16h.01',
    devices: 'M3 4h18v6H3z|M3 14h18v6H3z|M7 7h.01M7 17h.01',
    services: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    system: 'M20 6 9 17l-5-5',
    plugins: 'M9 3h6v4a2 2 0 1 0 0 4v6H9v-4a2 2 0 1 0 0-4z',
    manual: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
    critical: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4M12 17h.01',
    close: 'M6 6l12 12M18 6L6 18',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9|M10.3 21a1.94 1.94 0 0 0 3.4 0',
  };
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function toast(msg, type) { if (win.showToast) win.showToast(msg, type || 'success'); }

  // ── Time ──
  // SQLite datetime('now') is UTC without a zone ("2026-10-06 12:34:56").
  function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function fmtTime(v, seconds) {
    const d = toDate(v);
    if (!d) return '–';
    const o = { hour: '2-digit', minute: '2-digit' };
    if (seconds) o.second = '2-digit';
    try { return d.toLocaleTimeString(LANG, o); } catch (_) { return d.toISOString().slice(11, seconds ? 19 : 16); }
  }
  function fmtWhen(v, seconds) {
    const d = toDate(v);
    if (!d) return '–';
    if (sameDay(d, new Date())) return fmtTime(d, seconds);
    let day;
    try { day = d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' }); } catch (_) { day = d.toISOString().slice(5, 10); }
    return day + ' ' + fmtTime(d, seconds);
  }
  function fmtLong(v) {
    const d = toDate(v);
    if (!d) return '–';
    try { return d.toLocaleString(LANG, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
  }
  let rtf = null;
  try { rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto', style: 'short' }); } catch (_) { rtf = null; }
  function rel(v) {
    const d = toDate(v);
    if (!d) return '–';
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(sec);
    if (!rtf) return fmtWhen(d);
    if (abs < 60) return rtf.format(sec, 'second');
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    return rtf.format(Math.round(sec / 86400), 'day');
  }
  function since(v) {
    const d = toDate(v);
    return d ? T('notify.dev.since', { time: TK(durationOf(Date.now() - d.getTime())) }) : '';
  }
  function latencyText(ms) { return ms == null ? '–' : T('notify.latency', { n: latencyNumber(ms, LANG) }); }
  function spanText(seconds, zeroKey) { const d = spanOf(seconds); return d ? TK(d) : T(zeroKey); }

  // ── API ──
  async function request(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRF-Token'] = (win.GC && win.GC.csrfToken) || '';
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try { res = await win.fetch(url, opts); } catch (e) {
      const err = new Error(str(e && e.message) || 'network');
      err.status = 0;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (data && data.csrfToken && win.GC) win.GC.csrfToken = data.csrfToken;
    if (res.ok && !(data && data.ok === false)) return data || {};
    const err = new Error(str(data && data.error) || ('HTTP ' + res.status));
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  function isLicence(err) { return !!err && err.status === 403; }
  // Loading (action = false): 404 means the server has no notification centre
  // yet. Actions: the server's own (localised) message, field codes of a 400
  // mapped to texts, 503 = push switched off, 403 = licence.
  function errText(err, action) {
    if (!err) return T('common.error');
    if (err.status === 503) return T('notify.err.push_disabled');
    if (isLicence(err)) return T('notify.err.license');
    const codes = fieldCodes(err.data);
    if (err.status === 400 && codes.length) return codes.map((c) => label('notify.err.field.', c.code)).join(' ');
    if (err.status === 404 && (!action || !(err.data && err.data.error))) return T('notify.unavailable');
    if (action) return str(err.data && err.data.error) || T('common.error');
    return T('notify.load_error', { msg: str(err.message) || T('common.error') });
  }
  function errToast(err) { toast(errText(err, true), 'error'); }
  function busy(btn, on) { if (btn) { btn.disabled = !!on; btn.setAttribute('aria-busy', on ? 'true' : 'false'); } }

  /** Calm state box (unavailable / error / licence) with "Erneut versuchen". */
  function stateBox(box, err, retry) {
    if (!box) return;
    clear(box);
    if (!err) { box.hidden = true; return; }
    box.hidden = false;
    box.dataset.kind = err.status === 404 ? 'unavailable' : (isLicence(err) ? 'licence' : 'error');
    box.appendChild(icon(err.status === 404 ? ICON.bell : ICON.critical, 18));
    const text = el('div', { class: 'nc-state-text' }, [el('span', { text: errText(err) })]);
    if (isLicence(err) && win.GCLicenseHint) text.appendChild(win.GCLicenseHint.render('email_alerts', { compact: true }));
    box.appendChild(text);
    if (retry) box.appendChild(el('button', { type: 'button', class: 'btn btn-sm nc-retry', text: T('notify.retry'), on: { click: retry } }));
  }
  function emptyRow(tbody, cols, text) {
    clear(tbody);
    tbody.appendChild(el('tr', { class: 'nc-empty-row' }, [el('td', { colspan: cols, text })]));
  }

  // ── State ──
  const state = {
    tab: 'overview',
    pro: !!CTX.pro,
    ov: null, ovErr: null, ovLoaded: false,
    rules: null, users: [], groups: [], webhooks: 0, rulesErr: null, rulesLoading: null,
    sel: null, orig: null, draft: null,
    devices: null, devErr: null, devLoading: null,
    hist: { filter: 'all', days: 7, items: [], next: null, loaded: false, err: null, sel: null, detail: null, seq: 0, dseq: 0 },
    settings: null, setDraft: null, setErr: null,
    send: { type: 'all', ids: [] },
  };
  function setPro(on) {
    state.pro = !!on;
    page.dataset.pro = state.pro ? '1' : '0';
    const fields = $('nc-send-fields');
    if (fields) fields.disabled = !state.pro;
    const lock = $('nc-send-lock');
    if (lock) lock.hidden = state.pro;
    page.querySelectorAll('.nc-pro').forEach((n) => { n.hidden = state.pro; });
  }

  // ─── Tabs ────────────────────────────────────────────────────────────────
  const tabsEl = $('nc-tabs');
  function setTab(tab, id, opts) {
    const o = opts || {};
    state.tab = TABS.indexOf(tab) >= 0 ? tab : 'overview';
    tabsEl.querySelectorAll('[data-nc-tab]').forEach((b) => {
      const on = b.dataset.ncTab === state.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    page.querySelectorAll('[data-nc-panel]').forEach((p) => { p.hidden = p.dataset.ncPanel !== state.tab; });
    const sub = $('nc-sub');
    if (sub) sub.textContent = T('notify.sub.' + state.tab);
    if (!o.keepHash) writeHash(state.tab, id);
    if (state.tab === 'overview') { if (!state.ovLoaded) loadOverview(); }
    if (state.tab === 'rules') {
      ensureRules().then(() => { if (id) openRule(id, { keepHash: true }); });
    }
    if (state.tab === 'devices') {
      if (!state.devices && !state.devLoading) loadDevices();
      ensureRules({ quiet: true });
      refreshTtl();
      updateSend();
    }
    if (state.tab === 'history') {
      if (!state.hist.loaded) loadHistory(true);
      if (id && String(id) !== String(state.hist.sel)) openDetail(id, { keepHash: true });
    }
    if (state.tab === 'settings' && !state.settings) loadSettings();
  }
  function writeHash(tab, id) {
    try { win.history.replaceState(null, '', win.location.pathname + win.location.search + hashFor(tab, id)); } catch (_) { /* ignore */ }
  }
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nc-tab]');
    if (b) setTab(b.dataset.ncTab);
  });
  tabsEl.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (keys.indexOf(e.key) < 0) return;
    e.preventDefault();
    const i = TABS.indexOf(state.tab);
    let next = TABS[i];
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i + TABS.length - 1) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else next = TABS[TABS.length - 1];
    setTab(next);
    const b = tabsEl.querySelector('[data-nc-tab="' + next + '"]');
    if (b) b.focus();
  });
  win.addEventListener('hashchange', () => {
    const h = parseHash(win.location.hash);
    setTab(h.tab, h.id, { keepHash: true });
  });

  // ─── Header actions ──────────────────────────────────────────────────────
  $('nc-test-me').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    try {
      const res = await request('POST', '/api/v1/notify/test', {});
      const n = count(res.devices);
      toast(n ? P('notify.test_sent', n) : T('notify.test_none'), n ? 'success' : 'warning');
    } catch (err) { errToast(err); } finally { busy(b, false); }
  });
  $('nc-compose').addEventListener('click', () => {
    setTab('devices');
    const target = state.pro ? $('nc-send-title') : $('nc-send-lock');
    const panel = $('nc-send');
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
    if (target) { if (!state.pro) target.setAttribute('tabindex', '-1'); target.focus(); }
  });

  // ─── Übersicht ───────────────────────────────────────────────────────────
  function sourceText(item) {
    const it = isObj(item) ? item : { source: item };
    const rule = state.rules && it.event_id ? state.rules.find((r) => r.event_id === it.event_id) : null;
    const k = sourceKind(it.source, it.topic, rule ? rule.group : null);
    if (k.key) return T(k.key);
    if (k.plugin) return T('notify.source.plugin', { name: pluginName(k.plugin) });
    return k.text;
  }
  // The plugin's own name from its sidebar entry (Integrationen), else its id.
  function pluginName(id) {
    const a = doc.querySelector('#sidebar [data-plugin-nav="' + cssEsc(id) + '"]');
    if (!a) return id;
    const c = a.cloneNode(true);
    c.querySelectorAll('.nav-tag-off, .nav-badge').forEach((n) => n.remove());
    return c.textContent.replace(/\s+/g, ' ').trim() || id;
  }
  function sourceIcon(item) {
    if (item.priority === 'critical') return ICON.critical;
    const s = str(item.source);
    if (/^plugin/.test(s)) return ICON.plugins;
    if (/^manual/.test(s)) return ICON.manual;
    if (ICON[item.topic]) return ICON[item.topic];
    return ICON.bell;
  }
  function kpi(id, value, sub, tone) {
    const val = $('nc-kpi-' + id + '-val');
    const subEl = $('nc-kpi-' + id + '-sub');
    const tile = $('nc-kpi-' + id);
    if (!val) return;
    clear(val);
    [].concat(value).forEach((v) => val.append(v instanceof win.Node ? v : String(v)));
    subEl.textContent = sub || '';
    if (tone) tile.dataset.tone = tone; else delete tile.dataset.tone;
  }
  function setNavBadge(n) {
    const b = $('nc-nav-badge');
    if (!b) return;
    const v = count(n);
    b.hidden = !v;
    b.textContent = v ? String(v) : '';
    if (v) b.title = P('notify.nav_badge', v); else b.removeAttribute('title');
  }
  async function loadOverview(quiet) {
    const box = $('nc-ov-state');
    if (!quiet && !state.ov) clear($('nc-recent-list')).appendChild(el('li', { class: 'nc-empty', text: T('common.loading') }));
    try {
      const res = await request('GET', '/api/v1/notify/overview');
      state.ov = res || {};
      state.ovErr = null;
    } catch (err) {
      state.ovErr = err;
    }
    state.ovLoaded = true;
    stateBox(box, state.ovErr, () => loadOverview());
    renderOverview();
    refreshTtl();
  }
  function renderOverview() {
    const ov = state.ov;
    const failed = !!state.ovErr;
    page.querySelector('.nc-ov-grid').hidden = failed && !ov;
    $('nc-kpis').hidden = failed && !ov;
    if (!ov) return;
    const k = isObj(ov.kpis) ? ov.kpis : {};
    kpi('devices', [String(count(k.devices_connected)), el('small', { class: 'nc-kpi-of', text: '/ ' + count(k.devices_total) })],
      T('notify.kpi.devices_sub', { direct: count(k.direct), tunnel: count(k.tunnel) }), count(k.devices_connected) ? 'good-sub' : null);
    kpi('delivered', String(count(k.delivered_24h)), T('notify.kpi.delivered_sub', { read: count(k.read_24h) }));
    const queued = count(k.queued);
    kpi('queued', String(queued), queued ? P('notify.kpi.queued_sub', count(k.queued_devices)) : T('notify.kpi.queued_empty'), queued ? 'warn' : null);
    kpi('failed', String(count(k.failed_7d)), T('notify.kpi.failed_sub'), count(k.failed_7d) ? 'crit' : null);
    kpi('latency', k.median_latency_ms == null ? '–' : latencyText(k.median_latency_ms), T('notify.kpi.latency_sub'));
    setNavBadge(queued);

    // Letzte Benachrichtigungen
    const list = clear($('nc-recent-list'));
    const recent = (Array.isArray(ov.recent) ? ov.recent : []).filter(isObj);
    if (!recent.length) list.appendChild(el('li', { class: 'nc-empty', text: T('notify.recent_empty') }));
    recent.forEach((it) => {
      const st = statusOf(it);
      const prio = prioOf(it.priority);
      const meta = [sourceText(it), T('notify.prio.' + prio)];
      if (bool(it.silent)) meta.push(T('notify.status.silent_meta'));
      else if (it.recipients_label) meta.push(T('notify.to', { who: str(it.recipients_label) }));
      list.appendChild(el('li', {}, [
        el('a', { class: 'nc-recent-item', href: hashFor('history', it.id), 'data-prio': prio, 'data-id': str(it.id) }, [
          el('span', { class: 'nc-ic', 'data-tone': bool(it.silent) ? 'good' : prioTone(prio) }, [icon(sourceIcon(it), 18)]),
          el('span', { class: 'nc-recent-text' }, [
            el('b', { class: 'nc-recent-title', text: str(it.title) }),
            el('span', { class: 'nc-sub', text: meta.filter(Boolean).join(' · ') }),
          ]),
          el('span', { class: 'nc-recent-side' }, [
            el('span', { class: 'nc-status', 'data-tone': st.tone, text: st.key ? T(st.key, st.params) : st.text }),
            el('time', { class: 'nc-faint', datetime: str(it.created_at), text: fmtWhen(it.created_at) }),
          ]),
        ]),
      ]));
    });

    // Push-Dienst
    const hub = isObj(ov.hub) ? ov.hub : {};
    const pill = $('nc-hub-state');
    const on = bool(hub.enabled);
    pill.dataset.tone = on ? 'good' : 'muted';
    clear(pill).append(el('span', { class: 'nc-dot', 'aria-hidden': 'true' }), T(on ? 'notify.hub.running' : 'notify.hub.off'));
    const dl = clear($('nc-hub'));
    const row = (dt, dd, cls) => { dl.appendChild(el('dt', { text: dt })); dl.appendChild(el('dd', { class: cls || null, text: dd })); };
    row(T('notify.hub.endpoint'), (str(hub.endpoint) || '/api/v1/client/push') + ' (SSE)', 'nc-mono');
    row(T('notify.hub.reach'), T(bool(hub.allow_direct) ? 'notify.hub.reach_direct' : 'notify.hub.reach_tunnel'));
    row(T('notify.hub.keepalive'), T('notify.hub.keepalive_val', { s: count(hub.keepalive_s) || 25 }));
    row(T('notify.hub.buffer'), T('notify.hub.buffer_val', { h: count(hub.retention_h), n: count(hub.max_queue) }));
    row(T('notify.hub.third'), T('notify.hub.third_val'), 'nc-good');

    // Quellen
    const bars = clear($('nc-sources'));
    const sources = SOURCES.map((id) => {
      const hit = (Array.isArray(ov.sources) ? ov.sources : []).find((s) => isObj(s) && s.id === id);
      return { id, count: hit ? count(hit.count) : 0 };
    });
    const max = Math.max(0, ...sources.map((s) => s.count));
    if (!max) bars.appendChild(el('p', { class: 'nc-hint', text: T('notify.sources_empty') }));
    else {
      sources.forEach((s) => {
        const fill = el('span', { class: 'nc-bar-fill', 'data-source': s.id });
        fill.style.width = Math.round((s.count / max) * 100) + '%';
        bars.appendChild(el('div', { class: 'nc-bar-row' }, [
          el('span', { class: 'nc-bar-label', text: T('notify.source.' + s.id) }),
          el('span', { class: 'nc-bar', role: 'presentation' }, [fill]),
          el('span', { class: 'nc-bar-n', text: String(s.count) }),
        ]));
      });
    }
  }

  // ─── Regeln ──────────────────────────────────────────────────────────────
  function ensureRules(opts) {
    if (state.rules) return Promise.resolve(state.rules);
    if (state.rulesLoading) return state.rulesLoading;
    return loadRules(opts);
  }
  function loadRules(opts) {
    const quiet = !!(opts && opts.quiet);
    const p = (async () => {
      if (!quiet && !state.rules) emptyRow($('nc-rules-body'), 6, T('common.loading'));
      try {
        const res = await request('GET', '/api/v1/notify/rules');
        state.rules = (Array.isArray(res.rules) ? res.rules : []).filter(isObj).map(normRule).filter((r) => r.event_id);
        state.users = (Array.isArray(res.users) ? res.users : []).filter(isObj);
        state.groups = (Array.isArray(res.groups) ? res.groups : []).filter(isObj);
        state.webhooks = count(res.webhooks_count);
        if (typeof res.pro === 'boolean') setPro(res.pro);
        state.rulesErr = null;
      } catch (err) {
        state.rulesErr = err;
      } finally {
        state.rulesLoading = null;
      }
      stateBox($('nc-rules-state'), state.rulesErr, () => loadRules());
      renderRules();
      updateSend();
      return state.rules;
    })();
    state.rulesLoading = p;
    return p;
  }
  function recipientText(rule) {
    const parts = recipientParts(rule.recipients, state.users, state.groups).map(partLabel);
    let s = parts.length ? parts.join(' + ') : T('notify.rcpt.none');
    if (rule.bundle_s) s += ' · ' + T('notify.rcpt.bundled');
    return s;
  }
  function partLabel(p) {
    if (p.kind === 'user') return p.name;
    if (p.kind === 'group') return T('notify.rcpt.group', { name: p.name });
    return T('notify.rcpt.' + p.kind);
  }
  function dot(on, what) {
    return el('span', { class: 'nc-dot-cell', 'data-on': on ? '1' : '0' }, [
      el('span', { 'aria-hidden': 'true', text: on ? '●' : '○' }),
      el('span', { class: 'nc-sr', text: what + ': ' + T(on ? 'notify.rules.on' : 'notify.rules.off') }),
    ]);
  }
  function prioChip(p) { return el('span', { class: 'nc-prio', 'data-prio': prioOf(p), text: T('notify.prio.' + prioOf(p)) }); }
  function renderRules() {
    const body = $('nc-rules-body');
    if (!state.rules) { if (state.rulesErr) emptyRow(body, 6, '–'); return; }
    const q = $('nc-rule-search').value;
    const g = $('nc-rule-group').value;
    const groups = groupRules(state.rules.filter((r) => ruleMatches(r, q, g)));
    clear(body);
    if (!state.rules.length) { emptyRow(body, 6, T('notify.rules.empty')); return; }
    if (!groups.length) { emptyRow(body, 6, T('notify.rules.no_match')); return; }
    groups.forEach((grp) => {
      body.appendChild(el('tr', { class: 'nc-group-row', 'data-group': grp.group }, [
        el('th', { colspan: 6, scope: 'colgroup', text: T('notify.group.' + grp.group) }),
      ]));
      grp.rules.forEach((r) => {
        const locked = ruleLocked(r, state.pro);
        const selected = state.sel === r.event_id;
        const nameCell = el('td', {}, [el('div', { class: 'nc-rule-name' }, [
          el('button', { type: 'button', class: 'nc-row-btn', 'data-event-id': r.event_id, 'aria-pressed': selected ? 'true' : 'false', text: r.label }),
          !r.enabled ? el('span', { class: 'nc-tag', text: T('notify.rules.disabled') }) : null,
          locked ? el('span', { class: 'st-pro nc-pro-chip', text: T('notify.pro') }) : null,
        ])]);
        body.appendChild(el('tr', { class: 'nc-rule-row', 'data-event-id': r.event_id, 'data-selected': selected ? '1' : '0', 'data-enabled': r.enabled ? '1' : '0' }, [
          nameCell,
          el('td', {}, [prioChip(r.priority)]),
          el('td', { class: 'nc-muted-2', text: recipientText(r) }),
          el('td', { class: 'nc-c' }, [dot(r.ch_app, T('notify.rules.col_app'))]),
          el('td', { class: 'nc-c' }, [dot(r.ch_email, T('notify.rules.col_email'))]),
          el('td', { class: 'nc-c' }, [dot(r.ch_webhook, T('notify.rules.col_webhook'))]),
        ]));
      });
    });
  }
  $('nc-rule-search').addEventListener('input', renderRules);
  $('nc-rule-group').addEventListener('change', renderRules);
  $('nc-rules-body').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-event-id]');
    if (row) openRule(row.dataset.eventId);
  });

  function ruleDirty() { return !!(state.orig && state.draft) && Object.keys(ruleDiff(state.orig, state.draft)).length > 0; }
  async function confirmDiscard() {
    if (!ruleDirty()) return true;
    const D = win.GCDialog;
    if (!D) return true;
    return D.confirm({
      title: T('notify.ed.dirty_title'), message: T('notify.ed.dirty_msg', { name: state.orig.label }),
      okLabel: T('notify.ed.discard'), cancelLabel: T('common.cancel'), danger: true,
    });
  }
  async function openRule(eventId, opts) {
    if (!state.rules) return;
    const rule = state.rules.find((r) => r.event_id === eventId);
    if (!rule) return;
    if (state.sel && state.sel !== eventId && !(await confirmDiscard())) return;
    state.sel = eventId;
    state.orig = copyRule(rule);
    state.draft = copyRule(rule);
    if (!(opts && opts.keepHash)) writeHash('rules', eventId);
    renderRules();
    renderEditor();
    const ed = $('nc-rule-editor');
    if (ed && ed.scrollIntoView && win.matchMedia && win.matchMedia('(max-width: 1100px)').matches) ed.scrollIntoView({ block: 'start' });
    const title = $('nc-ed-title');
    if (title && !(opts && opts.noFocus)) title.focus();
  }
  async function closeRule() {
    if (!(await confirmDiscard())) return;
    const was = state.sel;
    state.sel = null; state.orig = null; state.draft = null;
    $('nc-rule-editor').hidden = true;
    $('nc-rule-hint').hidden = false;
    writeHash('rules');
    renderRules();
    const btn = was ? $('nc-rules-body').querySelector('button[data-event-id="' + cssEsc(was) + '"]') : null;
    if (btn) btn.focus();
  }
  function cssEsc(s) { return win.CSS && win.CSS.escape ? win.CSS.escape(s) : str(s).replace(/["\\]/g, '\\$&'); }

  function selectEl(id, values, current, text) {
    const s = el('select', { class: 'form-select nc-select-sm', id });
    choicesWith(values, current).forEach((v) => s.appendChild(el('option', { value: String(v), selected: v === count(current), text: text(v) })));
    return s;
  }
  function switchBtn(id, on, labelledBy, onChange) {
    const b = el('button', { type: 'button', class: 'st-switch', role: 'switch', id, 'aria-checked': on ? 'true' : 'false', 'aria-labelledby': labelledBy }, [
      el('span', { class: 'st-knob', 'aria-hidden': 'true' }),
    ]);
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    });
    return b;
  }
  function renderEditor() {
    const ed = clear($('nc-rule-editor'));
    const d = state.draft;
    if (!d) { ed.hidden = true; $('nc-rule-hint').hidden = false; return; }
    ed.hidden = false;
    $('nc-rule-hint').hidden = true;
    const locked = ruleLocked(d, state.pro);

    ed.appendChild(el('div', { class: 'nc-aside-head' }, [
      el('div', { class: 'nc-aside-headtext' }, [
        el('div', { class: 'nc-eyebrow', text: T('notify.ed.eyebrow') }),
        el('h2', { class: 'nc-aside-title', id: 'nc-ed-title', tabindex: '-1', text: d.label }),
        el('div', { class: 'nc-mono nc-faint nc-small', text: d.event_id }),
      ]),
      el('button', { type: 'button', class: 'nc-icon-btn', id: 'nc-ed-close', 'aria-label': T('notify.ed.close'), title: T('notify.ed.close'), on: { click: closeRule } }, [icon(ICON.close, 16)]),
    ]));
    if (locked) {
      const lock = el('div', { class: 'nc-lock' }, [el('p', { class: 'nc-hint', text: T('notify.ed.plugin_locked') })]);
      if (win.GCLicenseHint) lock.appendChild(win.GCLicenseHint.render('email_alerts', { compact: true }));
      ed.appendChild(lock);
    }
    const fs = el('fieldset', { class: 'nc-fieldset', disabled: locked });
    ed.appendChild(fs);

    // Regel aktiv
    fs.appendChild(el('div', { class: 'nc-ed-switch' }, [
      el('div', {}, [
        el('span', { class: 'nc-label', id: 'nc-ed-enabled-label', text: T('notify.ed.enabled') }),
        el('span', { class: 'nc-hint', text: T('notify.ed.enabled_hint') }),
      ]),
      switchBtn('nc-ed-enabled', d.enabled, 'nc-ed-enabled-label', (v) => { d.enabled = v; updateEditorState(); }),
    ]));

    // Priorität
    const prioHint = el('p', { class: 'nc-hint', id: 'nc-ed-prio-hint', text: T('notify.prio_hint.' + d.priority) });
    const seg = el('div', { class: 'nc-seg nc-seg-4', role: 'group', 'aria-labelledby': 'nc-ed-prio-legend', 'aria-describedby': 'nc-ed-prio-hint' });
    const capped = d.group === 'plugins' || !!d.plugin_id; // plugins send at most "high"
    PRIORITIES.forEach((p) => {
      seg.appendChild(el('button', {
        type: 'button', class: 'nc-seg-btn', 'data-prio': p, 'aria-pressed': d.priority === p ? 'true' : 'false', text: T('notify.prio.' + p),
        disabled: capped && p === 'critical', title: capped && p === 'critical' ? T('notify.err.field.priority_capped') : null,
        on: {
          click: () => {
            d.priority = p;
            seg.querySelectorAll('[data-prio]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.prio === p ? 'true' : 'false'));
            prioHint.textContent = T('notify.prio_hint.' + p);
            updateEditorState();
          },
        },
      }));
    });
    fs.appendChild(el('div', { class: 'nc-ed-block' }, [el('span', { class: 'nc-label', id: 'nc-ed-prio-legend', text: T('notify.ed.priority') }), seg, prioHint]));

    // Empfänger
    const chips = el('ul', { class: 'nc-chips', id: 'nc-ed-chips', 'aria-labelledby': 'nc-ed-rcpt-label' });
    const add = el('select', { class: 'form-select nc-select-sm nc-pick', id: 'nc-ed-add', 'aria-label': T('notify.rcpt.add_label') });
    const warn = el('p', { class: 'nc-hint nc-warn', id: 'nc-ed-rcpt-warn', text: T('notify.ed.no_recipient') });
    function renderChips() {
      clear(chips);
      recipientParts(d.recipients, state.users, state.groups).forEach((p) => {
        const name = partLabel(p);
        chips.appendChild(el('li', { class: 'nc-chip', 'data-kind': p.kind }, [
          el('span', { text: name }),
          el('button', {
            type: 'button', class: 'nc-chip-x', 'aria-label': T('notify.rcpt.remove', { name }), title: T('notify.rcpt.remove', { name }),
            on: { click: () => { removeRecipient(d.recipients, p); renderChips(); updateEditorState(); add.focus(); } },
          }, [icon(ICON.close, 12)]),
        ]));
      });
      clear(add);
      add.appendChild(el('option', { value: '', text: T('notify.rcpt.add') }));
      const roles = el('optgroup', {});
      roles.label = T('notify.rcpt.roles');
      ['admins', 'owner', 'subscribers'].forEach((k) => { if (!d.recipients[k]) roles.appendChild(el('option', { value: 'role:' + k, text: T('notify.rcpt.' + k) })); });
      if (roles.children.length) add.appendChild(roles);
      const people = el('optgroup', {});
      people.label = T('notify.rcpt.people');
      state.users.forEach((u) => {
        if (d.recipients.users.some((x) => String(x) === String(u.id))) return;
        people.appendChild(el('option', { value: 'user:' + u.id, disabled: !state.pro, text: state.pro ? str(u.name) : T('notify.rcpt.pro_suffix', { name: str(u.name) }) }));
      });
      if (people.children.length) add.appendChild(people);
      const grps = el('optgroup', {});
      grps.label = T('notify.rcpt.groups');
      state.groups.forEach((g) => {
        if (d.recipients.groups.some((x) => String(x) === String(g.id))) return;
        grps.appendChild(el('option', { value: 'group:' + g.id, disabled: !state.pro, text: state.pro ? str(g.name) : T('notify.rcpt.pro_suffix', { name: str(g.name) }) }));
      });
      if (grps.children.length) add.appendChild(grps);
      warn.hidden = hasRecipient(d.recipients);
    }
    add.addEventListener('change', () => {
      const v = add.value;
      if (!v) return;
      const i = v.indexOf(':');
      const kind = v.slice(0, i);
      const id = v.slice(i + 1);
      if (kind === 'role') d.recipients[id] = true;
      else if (kind === 'user') { const u = state.users.find((x) => String(x.id) === id); if (u) d.recipients.users.push(u.id); }
      else if (kind === 'group') { const g = state.groups.find((x) => String(x.id) === id); if (g) d.recipients.groups.push(g.id); }
      renderChips();
      updateEditorState();
      add.focus();
    });
    renderChips();
    fs.appendChild(el('div', { class: 'nc-ed-block' }, [el('span', { class: 'nc-label', id: 'nc-ed-rcpt-label', text: T('notify.ed.recipients') }), chips, add, warn]));

    // Kanäle
    const emailHint = el('span', { class: 'nc-hint', id: 'nc-ed-email-hint' });
    const fallback = selectEl('nc-ed-fallback', FALLBACK_CHOICES, d.email_fallback_s, (v) => spanText(v, 'notify.time.now'));
    const fallbackRow = el('label', { class: 'nc-inline-field', for: 'nc-ed-fallback' }, [el('span', { text: T('notify.ed.email_fallback') }), fallback]);
    function emailText() {
      emailHint.textContent = d.email_fallback_s ? T('notify.ed.email_hint_after', { time: spanText(d.email_fallback_s, 'notify.time.now') }) : T('notify.ed.email_hint_now');
      fallbackRow.hidden = !d.ch_email;
    }
    fallback.addEventListener('change', () => { d.email_fallback_s = count(fallback.value); emailText(); updateEditorState(); });
    const channel = (key, title, hint, extra) => {
      // Without the licence the e-mail of a non-free core event stays as it is (403 otherwise).
      const mailLocked = key === 'ch_email' && emailLocked(d, state.pro);
      const cb = el('input', { type: 'checkbox', class: 'nc-check', id: 'nc-ed-' + key, checked: !!d[key], disabled: mailLocked, title: mailLocked ? T('notify.err.license') : null, 'aria-describedby': 'nc-ed-' + key + '-hint' });
      cb.addEventListener('change', () => { d[key] = cb.checked; if (key === 'ch_email') emailText(); updateEditorState(); });
      if (hint && !hint.id) hint.id = 'nc-ed-' + key + '-hint';
      return el('div', { class: 'nc-channel' }, [
        el('label', { class: 'nc-channel-main', for: 'nc-ed-' + key }, [el('span', { class: 'nc-channel-text' }, [el('b', { text: title }), hint]), cb]),
        extra || null,
      ]);
    };
    const hookHint = el('span', { class: 'nc-hint', id: 'nc-ed-ch_webhook-hint' }, [
      state.webhooks ? P('notify.ed.webhook_n', state.webhooks) : T('notify.ed.webhook_none'),
    ]);
    if (!state.webhooks) { hookHint.append(' · '); hookHint.appendChild(el('a', { href: '/settings#webhooks', class: 'nc-link', text: T('notify.ed.webhook_setup') })); }
    emailHint.id = 'nc-ed-ch_email-hint';
    fs.appendChild(el('div', { class: 'nc-ed-block' }, [
      el('span', { class: 'nc-label', text: T('notify.ed.channels') }),
      el('div', { class: 'nc-channels' }, [
        channel('ch_app', T('notify.ed.app'), el('span', { class: 'nc-hint', text: T('notify.ed.app_hint') })),
        channel('ch_email', T('notify.ed.email'), emailHint, fallbackRow),
        channel('ch_webhook', T('notify.ed.webhook'), hookHint),
      ]),
    ]));
    emailText();

    // Rauschen vermeiden
    const delay = selectEl('nc-ed-delay', DELAY_CHOICES, d.delay_s, (v) => spanText(v, 'notify.time.now'));
    delay.addEventListener('change', () => { d.delay_s = count(delay.value); updateEditorState(); });
    const bundle = selectEl('nc-ed-bundle', BUNDLE_CHOICES, d.bundle_s, (v) => spanText(v, 'notify.time.no_bundle'));
    bundle.addEventListener('change', () => { d.bundle_s = count(bundle.value); updateEditorState(); });
    const recovery = el('select', { class: 'form-select nc-select-sm', id: 'nc-ed-recovery' });
    RECOVERY.forEach((v) => recovery.appendChild(el('option', { value: v, selected: d.recovery === v, text: T('notify.ed.recovery_' + v) })));
    recovery.addEventListener('change', () => { d.recovery = recovery.value; updateEditorState(); });
    fs.appendChild(el('div', { class: 'nc-ed-block' }, [
      el('span', { class: 'nc-label', text: T('notify.ed.noise') }),
      el('div', { class: 'nc-noise' }, [
        el('label', { for: 'nc-ed-delay', text: T('notify.ed.delay') }), delay,
        el('label', { for: 'nc-ed-bundle', text: T('notify.ed.bundle') }), bundle,
        el('label', { for: 'nc-ed-recovery', text: T('notify.ed.recovery') }), recovery,
      ]),
    ]));

    // Fuß
    const preview = el('button', { type: 'button', class: 'btn', id: 'nc-ed-preview', text: T('notify.ed.preview') });
    const save = el('button', { type: 'button', class: 'btn btn-primary', id: 'nc-ed-save', text: T('notify.ed.save'), disabled: true });
    preview.addEventListener('click', async () => {
      busy(preview, true);
      try {
        // With the licence: this rule's label and priority to the own person
        // (POST /send); without: the plain test message (POST /test is free).
        if (state.pro && CTX.self) {
          await request('POST', '/api/v1/notify/send', {
            target: { type: 'users', ids: [CTX.self] }, title: T('notify.ed.preview_title', { name: d.label }).slice(0, TITLE_MAX),
            body: T('notify.ed.preview_body'), priority: d.priority, ttl_s: 3600,
          });
        } else await request('POST', '/api/v1/notify/test', {});
        toast(T('notify.ed.preview_sent'));
      } catch (err) { errToast(err); } finally { busy(preview, false); }
    });
    save.addEventListener('click', saveRule);
    fs.appendChild(el('div', { class: 'nc-aside-foot' }, [preview, save]));
    updateEditorState();
  }
  function removeRecipient(r, p) {
    if (p.kind === 'user') r.users = r.users.filter((x) => String(x) !== String(p.id));
    else if (p.kind === 'group') r.groups = r.groups.filter((x) => String(x) !== String(p.id));
    else r[p.kind] = false;
  }
  function updateEditorState() {
    const save = $('nc-ed-save');
    if (save) save.disabled = !ruleDirty() || ruleLocked(state.draft, state.pro);
  }
  async function saveRule() {
    const d = state.draft;
    const o = state.orig;
    if (!d || !o) return;
    const diff = ruleDiff(o, d);
    if (!Object.keys(diff).length) return;
    const btn = $('nc-ed-save');
    busy(btn, true);
    try {
      const res = await request('PUT', '/api/v1/notify/rules/' + encodeURIComponent(d.event_id), diff);
      const saved = normRule(isObj(res.rule) ? Object.assign({}, d, res.rule) : d);
      state.rules = state.rules.map((r) => (r.event_id === saved.event_id ? saved : r));
      state.orig = copyRule(saved);
      state.draft = copyRule(saved);
      renderRules();
      toast(T('notify.ed.saved', { name: saved.label }));
    } catch (err) {
      errToast(err);
    } finally {
      busy(btn, false);
      updateEditorState();
    }
  }

  // ─── Geräte ──────────────────────────────────────────────────────────────
  const PLATFORM = { android: 'Android', windows: 'Windows', linux: 'Linux', macos: 'macOS', ios: 'iOS' };
  const CLIENT = { pro: 'Pro', community: 'Community', wireguard: 'WireGuard' };
  function normDevice(d) {
    const o = isObj(d) ? d : {};
    return Object.assign({}, o, {
      token_id: o.token_id,
      name: str(o.name) || '#' + str(o.token_id),
      state: DEVICE_STATES.indexOf(o.state) >= 0 ? o.state : 'offline',
      via: o.via === 'tunnel' ? 'tunnel' : (o.via === 'direct' ? 'direct' : null),
      queued: count(o.queued),
      user: isObj(o.user) ? o.user : null,
    });
  }
  function platformText(d) {
    const p = str(d.platform).toLowerCase();
    const c = str(d.client_type).toLowerCase();
    return [PLATFORM[p] || str(d.platform), CLIENT[c] || (c && c !== p ? str(d.client_type) : ''), str(d.app_version)].filter(Boolean).join(' ');
  }
  async function loadDevices(quiet) {
    if (state.devLoading) return state.devLoading;
    const p = (async () => {
      if (!quiet && !state.devices) emptyRow($('nc-dev-body'), 5, T('common.loading'));
      try {
        const res = await request('GET', '/api/v1/notify/devices');
        state.devices = (Array.isArray(res.devices) ? res.devices : []).filter(isObj).map(normDevice);
        state.devErr = null;
      } catch (err) {
        state.devErr = err;
      } finally {
        state.devLoading = null;
      }
      stateBox($('nc-dev-state'), state.devErr, () => loadDevices());
      renderDevices();
      updateSend();
    })();
    state.devLoading = p;
    return p;
  }
  function connDetail(d) {
    if (d.state === 'connected') return [d.via ? T('notify.dev.via.' + d.via) : null, since(d.connected_since)].filter(Boolean).join(' · ');
    if (d.state === 'restricted') return T('notify.dev.restricted_hint');
    if (d.state === 'unsupported') return T('notify.dev.unsupported_hint');
    return [since(d.last_seen), d.buffer_until ? T('notify.dev.buffer_until', { time: fmtLong(d.buffer_until) }) : null].filter(Boolean).join(' · ');
  }
  function deviceRow(d) {
    const unsupported = d.state === 'unsupported';
    const who = d.user ? [str(d.user.name), d.user.role === 'admin' ? T('notify.dev.role_admin') : null].filter(Boolean).join(' · ') : T('notify.dev.no_user');
    const can = testable(d);
    const test = unsupported ? null : el('button', {
      type: 'button', class: 'btn btn-sm nc-dev-test', 'data-token-id': str(d.token_id), disabled: !can,
      title: !can && d.state !== 'offline' ? T('notify.dev.test_pro') : null,
      'aria-label': T('notify.dev.test_label', { name: d.name }), text: T('notify.dev.test'),
    });
    return el('tr', { 'data-token-id': str(d.token_id), 'data-state': d.state }, [
      el('td', {}, [
        el('div', { class: 'nc-dev-name' }, [el('b', { text: d.name }), ' ', el('span', { class: 'nc-faint nc-small', text: platformText(d) })]),
        el('div', { class: 'nc-sub', text: who }),
      ]),
      el('td', {}, [
        el('span', { class: 'nc-conn', 'data-state': d.state }, [el('span', { class: 'nc-dot', 'aria-hidden': 'true' }), T('notify.dev.state.' + d.state)]),
        el('div', { class: 'nc-sub', text: connDetail(d) }),
      ]),
      el('td', { class: 'nc-c' }, [el('span', { class: 'nc-num', 'data-tone': d.queued ? 'warn' : null, text: unsupported ? '–' : String(d.queued) })]),
      el('td', { class: 'nc-muted-2', text: unsupported || !d.last_ack_at ? '–' : rel(d.last_ack_at) }),
      el('td', { class: 'nc-r' }, [test]),
    ]);
  }
  // A test to one device needs POST /send (licence); without it only the own
  // devices can be tested (POST /test reaches all of them).
  function ownDevice(d) { return !!(d.user && CTX.self && String(d.user.id) === String(CTX.self)); }
  function testable(d) { return d.state !== 'offline' && d.state !== 'unsupported' && (state.pro || ownDevice(d)); }
  function renderDevices() {
    const body = $('nc-dev-body');
    if (!state.devices) { if (state.devErr) emptyRow(body, 5, '–'); return; }
    clear(body);
    if (!state.devices.length) { emptyRow(body, 5, T('notify.dev.empty')); return; }
    state.devices.forEach((d) => body.appendChild(deviceRow(d)));
  }
  $('nc-dev-body').addEventListener('click', async (e) => {
    const b = e.target.closest('button.nc-dev-test');
    if (!b || !state.devices) return;
    const d = state.devices.find((x) => String(x.token_id) === b.dataset.tokenId);
    if (!d) return;
    busy(b, true);
    try {
      if (state.pro) {
        await request('POST', '/api/v1/notify/send', {
          target: { type: 'devices', ids: [d.token_id] }, title: T('notify.dev.test_title'), body: T('notify.dev.test_body'), priority: 'info', ttl_s: 3600,
        });
      } else await request('POST', '/api/v1/notify/test', {});
      toast(T('notify.dev.test_sent', { name: d.name }));
    } catch (err) { errToast(err); } finally { busy(b, false); }
  });

  // "Nachricht senden"
  const sendForm = $('nc-send-form');
  const sendPick = $('nc-send-pick');
  const sendChips = $('nc-send-chips');
  function candidates(type) {
    if (type === 'users') return state.users.map((u) => ({ id: u.id, name: str(u.name) }));
    if (type === 'groups') return state.groups.map((g) => ({ id: g.id, name: str(g.name) }));
    if (type === 'devices') return (state.devices || []).filter((d) => d.state !== 'unsupported').map((d) => ({ id: d.token_id, name: d.name + (d.user ? ' · ' + str(d.user.name) : '') }));
    return [];
  }
  function refreshTtl() {
    const sel = $('nc-send-ttl');
    const keep = sel.value;
    clear(sel);
    const hub = state.ov && isObj(state.ov.hub) ? state.ov.hub : null;
    const retention = (state.settings && state.settings.retention_h) || (hub && count(hub.retention_h)) || 0;
    ttlChoices(new Date(), retention * 3600).forEach((c) => {
      const text = c.kind === 'tonight' ? T('notify.send.ttl_tonight', { time: fmtTime(c.at) }) : T('notify.send.ttl_in', { time: spanText(c.ttl, 'notify.time.now') });
      sel.appendChild(el('option', { value: c.kind === 'tonight' ? 'tonight' : String(c.ttl), 'data-ttl': String(c.ttl), text }));
    });
    sel.value = keep && sel.querySelector('option[value="' + cssEsc(keep) + '"]') ? keep : String(86400);
  }
  function ttlValue() {
    const opt = $('nc-send-ttl').selectedOptions && $('nc-send-ttl').selectedOptions[0];
    return opt ? count(opt.getAttribute('data-ttl')) : 86400;
  }
  function updatePreview() {
    const title = $('nc-send-title').value.trim();
    const body = $('nc-send-body').value.trim();
    $('nc-pv-app').textContent = T('notify.send.preview_app', { prio: T('notify.prio.' + prioOf($('nc-send-prio').value)) });
    const pt = $('nc-pv-title');
    pt.textContent = title || T('notify.send.preview_title_ph');
    pt.dataset.empty = title ? '0' : '1';
    const pb = $('nc-pv-body');
    pb.textContent = body || T('notify.send.preview_body_ph');
    pb.dataset.empty = body ? '0' : '1';
  }
  function updateSend() {
    const type = state.send.type;
    $('nc-send-target').querySelectorAll('[data-target]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.target === type ? 'true' : 'false'));
    const list = candidates(type);
    // chips
    clear(sendChips);
    sendChips.hidden = type === 'all';
    state.send.ids.forEach((id) => {
      const c = list.find((x) => String(x.id) === String(id));
      const name = c ? c.name : '#' + id;
      sendChips.appendChild(el('span', { class: 'nc-chip', role: 'listitem' }, [
        el('span', { text: name }),
        el('button', {
          type: 'button', class: 'nc-chip-x', 'aria-label': T('notify.rcpt.remove', { name }), title: T('notify.rcpt.remove', { name }),
          on: { click: () => { state.send.ids = state.send.ids.filter((x) => String(x) !== String(id)); updateSend(); sendPick.focus(); } },
        }, [icon(ICON.close, 12)]),
      ]));
    });
    // picker
    clear(sendPick);
    sendPick.hidden = type === 'all';
    if (type !== 'all') {
      sendPick.appendChild(el('option', { value: '', text: T('notify.send.pick_' + type) }));
      list.filter((c) => !state.send.ids.some((x) => String(x) === String(c.id))).forEach((c) => sendPick.appendChild(el('option', { value: String(c.id), text: c.name })));
    }
    // reach + button
    const reach = reachOf(state.devices, state.send);
    const reachEl = $('nc-send-reach');
    if (type === 'groups') reachEl.textContent = state.send.ids.length ? T('notify.send.reach_groups') : '';
    else if (!state.devices || (type !== 'all' && !state.send.ids.length)) reachEl.textContent = '';
    else if (!reach.total) reachEl.textContent = T('notify.send.reach_none');
    else if (!reach.later) reachEl.textContent = T('notify.send.reach_now', { now: P('notify.send.n_dev', reach.now) });
    else if (!reach.now) reachEl.textContent = T('notify.send.reach_later', { later: P('notify.send.n_dev', reach.later) });
    else reachEl.textContent = T('notify.send.reach', { now: P('notify.send.n_dev', reach.now), later: P('notify.send.n_dev', reach.later) });
    const btn = $('nc-send-btn');
    let who;
    const n = state.send.ids.length;
    if (type === 'all') who = T('notify.send.target.all');
    else if (type === 'users') who = P('notify.send.n_people', n);
    else if (type === 'groups') who = P('notify.send.n_groups', n);
    else who = P('notify.send.n_dev', n);
    btn.textContent = (type === 'users' && reach.known && n) ? T('notify.send.btn_devices', { who, devices: P('notify.send.n_dev', reach.total) }) : T('notify.send.btn', { who });
    updatePreview();
  }
  $('nc-send-target').addEventListener('click', (e) => {
    const b = e.target.closest('[data-target]');
    if (!b || b.dataset.target === state.send.type) return;
    state.send = { type: b.dataset.target, ids: [] };
    sendError('');
    updateSend();
  });
  sendPick.addEventListener('change', () => {
    const v = sendPick.value;
    if (!v) return;
    const c = candidates(state.send.type).find((x) => String(x.id) === v);
    if (c) state.send.ids.push(c.id);
    sendError('');
    updateSend();
    sendPick.focus();
  });
  ['nc-send-title', 'nc-send-body'].forEach((id) => $(id).addEventListener('input', updatePreview));
  $('nc-send-prio').addEventListener('change', updatePreview);
  function sendError(msg) {
    const e = $('nc-send-err');
    e.textContent = msg || '';
    e.hidden = !msg;
    $('nc-send-title').setAttribute('aria-invalid', msg === T('notify.send.need_title') ? 'true' : 'false');
  }
  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.pro) return;
    const body = sendBody(state.send, { title: $('nc-send-title').value, body: $('nc-send-body').value, priority: $('nc-send-prio').value, ttl_s: ttlValue() });
    if (!body.title) { sendError(T('notify.send.need_title')); $('nc-send-title').focus(); return; }
    if (body.target.type !== 'all' && !body.target.ids.length) { sendError(T('notify.send.need_target')); sendPick.focus(); return; }
    sendError('');
    const btn = $('nc-send-btn');
    busy(btn, true);
    try {
      const res = await request('POST', '/api/v1/notify/send', body);
      toast(T('notify.send.sent', { now: P('notify.send.n_dev', count(res.devices_now)), later: P('notify.send.n_dev', count(res.devices_later)) }));
      $('nc-send-title').value = '';
      $('nc-send-body').value = '';
      updatePreview();
      refreshAfterNotify();
    } catch (err) {
      if (isLicence(err)) setPro(false);
      sendError(errText(err));
    } finally { busy(btn, false); }
  });

  // ─── Verlauf ─────────────────────────────────────────────────────────────
  const H = state.hist;
  async function loadHistory(reset, quiet) {
    const my = ++H.seq;
    const body = $('nc-hist-body');
    const more = $('nc-hist-more');
    if (reset && !quiet) emptyRow(body, 4, T('common.loading'));
    busy(more, true);
    try {
      const res = await request('GET', '/api/v1/notify/history' + historyQuery({ filter: H.filter, days: H.days, before: reset ? null : H.next }));
      if (my !== H.seq) return;
      const items = (Array.isArray(res.items) ? res.items : []).filter(isObj);
      H.items = reset ? items : H.items.concat(items);
      H.next = res.next_before != null && res.next_before !== '' ? res.next_before : null;
      H.err = null;
    } catch (err) {
      if (my !== H.seq) return;
      H.err = err;
      if (reset) H.items = [];
    } finally {
      busy(more, false);
    }
    H.loaded = true;
    stateBox($('nc-hist-state'), H.err, () => loadHistory(true));
    renderHistory();
  }
  function histMeta(it) {
    const prio = prioOf(it.priority);
    const parts = [T('notify.prio.' + prio)];
    if (bool(it.silent)) parts.push(T('notify.hist.silent_meta'));
    else if (it.recipients_label) parts.push(T('notify.to', { who: str(it.recipients_label) }));
    return parts.join(' · ');
  }
  function renderHistory() {
    const body = $('nc-hist-body');
    clear(body);
    if (!H.items.length) emptyRow(body, 4, H.err ? '–' : T('notify.hist.empty'));
    H.items.forEach((it) => {
      const st = histStatusOf(it);
      const prio = prioOf(it.priority);
      const selected = String(H.sel) === String(it.id);
      body.appendChild(el('tr', { class: 'nc-hist-row', 'data-id': str(it.id), 'data-prio': prio, 'data-selected': selected ? '1' : '0' }, [
        el('td', { class: 'nc-mono nc-small nc-nowrap' }, [el('time', { datetime: str(it.created_at), text: fmtWhen(it.created_at) })]),
        el('td', {}, [
          el('button', { type: 'button', class: 'nc-row-btn', 'data-id': str(it.id), 'aria-pressed': selected ? 'true' : 'false', text: str(it.title) }),
          el('div', { class: 'nc-sub' }, [el('span', { class: 'nc-prio-text', 'data-prio': prio, text: histMeta(it) })]),
        ]),
        el('td', { class: 'nc-muted-2', text: sourceText(it) }),
        el('td', { class: 'nc-nowrap' }, [el('span', { class: 'nc-status', 'data-tone': st.tone, text: st.key ? T(st.key, st.params) : st.text })]),
      ]));
    });
    $('nc-hist-more').hidden = !H.next;
  }
  $('nc-hist-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b || b.dataset.filter === H.filter) return;
    H.filter = b.dataset.filter;
    $('nc-hist-filters').querySelectorAll('[data-filter]').forEach((x) => {
      const on = x.dataset.filter === H.filter;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    loadHistory(true);
  });
  $('nc-hist-days').addEventListener('change', () => { H.days = Number($('nc-hist-days').value) || 7; loadHistory(true); });
  $('nc-hist-more').addEventListener('click', () => loadHistory(false));
  $('nc-hist-body').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) openDetail(row.dataset.id);
  });

  async function openDetail(id, opts) {
    if (id == null || id === '') return;
    H.sel = String(id);
    if (!(opts && opts.keepHash)) writeHash('history', id);
    renderHistory();
    const box = clear($('nc-proto'));
    box.hidden = false;
    $('nc-proto-hint').hidden = true;
    box.appendChild(el('p', { class: 'nc-hint', text: T('common.loading') }));
    const my = ++H.dseq;
    let res = null;
    let error = null;
    try { res = await request('GET', '/api/v1/notify/history/' + encodeURIComponent(String(id))); } catch (err) { error = err; }
    if (my !== H.dseq) return;
    H.detail = res;
    renderDetail(id, res, error);
  }
  function closeDetail() {
    const was = H.sel;
    H.sel = null;
    H.detail = null;
    $('nc-proto').hidden = true;
    $('nc-proto-hint').hidden = false;
    writeHash('history');
    renderHistory();
    const btn = was ? $('nc-hist-body').querySelector('button[data-id="' + cssEsc(was) + '"]') : null;
    if (btn) btn.focus();
  }
  function deliveryLine(dv) {
    const parts = [];
    if (dv.delivered_at) {
      let s = T('notify.proto.delivered_at', { time: fmtTime(dv.delivered_at, true) });
      const via = dv.via === 'tunnel' || dv.via === 'direct' ? T('notify.dev.via.' + dv.via) : null;
      if (dv.latency_ms != null && via) s += ' ' + T('notify.proto.latency_via', { latency: latencyText(dv.latency_ms), via });
      else if (dv.latency_ms != null) s += ' (' + latencyText(dv.latency_ms) + ')';
      else if (via) s += ' (' + via + ')';
      parts.push(s);
      parts.push(dv.read_at ? T('notify.proto.read_at', { time: fmtTime(dv.read_at, true) }) : T('notify.proto.not_read'));
    } else if (dv.queued_at) {
      parts.push(T('notify.proto.queued_at', { time: fmtWhen(dv.queued_at, true) }));
    }
    if (dv.action) parts.push(T('notify.proto.action', { name: str(dv.action) }));
    return parts.join(' · ');
  }
  function stateTone(s) { return { read: 'good', delivered: 'info', sent: 'info', queued: 'warn', dismissed: 'muted', expired: 'crit', failed: 'crit', revoked: 'muted' }[s] || 'muted'; }
  function renderDetail(id, res, error) {
    const box = clear($('nc-proto'));
    const head = el('div', { class: 'nc-aside-head' });
    const close = el('button', { type: 'button', class: 'nc-icon-btn', id: 'nc-proto-close', 'aria-label': T('notify.ed.close'), title: T('notify.ed.close'), on: { click: closeDetail } }, [icon(ICON.close, 16)]);
    box.appendChild(head);
    if (error || !res) {
      head.append(el('div', { class: 'nc-aside-headtext' }, [el('div', { class: 'nc-eyebrow', text: T('notify.proto.eyebrow') }), el('h2', { class: 'nc-aside-title', id: 'nc-proto-title', tabindex: '-1', text: '#' + id })]), close);
      const sb = el('div', { class: 'nc-state' });
      box.appendChild(sb);
      stateBox(sb, error || { status: 0, message: '' }, () => openDetail(id, { keepHash: true }));
      return;
    }
    const n = isObj(res.notification) ? res.notification : {};
    const prio = prioOf(n.priority);
    const rule = state.rules && n.event_id ? state.rules.find((r) => r.event_id === n.event_id) : null;
    const meta = el('p', { class: 'nc-hint' });
    if (n.event_id) { meta.append(T('notify.proto.event') + ' '); meta.appendChild(el('code', { class: 'nc-mono', text: str(n.event_id) })); }
    const metaParts = [];
    if (rule) metaParts.push(T('notify.proto.rule', { name: rule.label }));
    metaParts.push(T('notify.prio.' + prio));
    meta.append((n.event_id ? ' · ' : '') + metaParts.join(' · '));
    head.append(el('div', { class: 'nc-aside-headtext' }, [
      el('div', { class: 'nc-eyebrow', text: T('notify.proto.eyebrow') }),
      el('h2', { class: 'nc-aside-title', id: 'nc-proto-title', tabindex: '-1', text: str(n.title) || '#' + id }),
      meta,
    ]), close);
    if (n.body) box.appendChild(el('p', { class: 'nc-proto-body', text: str(n.body) }));

    // Ablauf
    const tl = (Array.isArray(res.timeline) ? res.timeline : []).filter(isObj);
    if (tl.length) {
      box.appendChild(el('h3', { class: 'nc-label', text: T('notify.proto.timeline') }));
      box.appendChild(el('ol', { class: 'nc-timeline' }, tl.map((x) => {
        // The server sends the text already localised; the kind is the fallback.
        const kind = str(x.kind);
        return el('li', { 'data-kind': kind }, [
          el('span', { class: 'nc-tl-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'nc-tl-text' }, [el('b', { text: str(x.text) || label('notify.tl.', kind) })]),
          el('time', { class: 'nc-mono nc-faint nc-small', datetime: str(x.at), text: fmtTime(x.at, true) }),
        ]);
      })));
    }

    // Zustellungen
    const dl = (Array.isArray(res.deliveries) ? res.deliveries : []).filter(isObj);
    box.appendChild(el('h3', { class: 'nc-label', text: T('notify.proto.deliveries') }));
    if (!dl.length) box.appendChild(el('p', { class: 'nc-hint', text: T('notify.proto.no_deliveries') }));
    else {
      box.appendChild(el('ul', { class: 'nc-deliveries' }, dl.map((dv) => el('li', { class: 'nc-delivery', 'data-state': str(dv.state) }, [
        el('div', { class: 'nc-delivery-head' }, [
          el('b', { text: [str(dv.device_name), str(dv.user_name)].filter(Boolean).join(' · ') || '#' + str(dv.token_id) }),
          el('span', { class: 'nc-status nc-pill-sm', 'data-tone': stateTone(dv.state), text: label('notify.dstate.', str(dv.state)) }),
        ]),
        el('div', { class: 'nc-sub', text: deliveryLine(dv) }),
      ]))));
    }

    // E-Mail
    const mail = isObj(res.email) ? res.email : {};
    box.appendChild(el('p', { class: 'nc-callout nc-small', text: bool(mail.sent) ? T('notify.proto.email_sent', { time: fmtTime(mail.at, true) }) : T('notify.proto.email_none') }));

    // Aktionen
    const resend = el('button', { type: 'button', class: 'btn', id: 'nc-proto-resend', text: T('notify.proto.resend') });
    resend.addEventListener('click', async () => {
      const D = win.GCDialog;
      const ok = D ? await D.confirm({ title: T('notify.proto.resend_title'), message: T('notify.proto.resend_msg', { name: str(n.title) }), okLabel: T('notify.proto.resend'), cancelLabel: T('common.cancel') }) : true;
      if (!ok) return;
      busy(resend, true);
      try {
        await request('POST', '/api/v1/notify/history/' + encodeURIComponent(String(id)) + '/resend', {});
        toast(T('notify.proto.resent'));
        openDetail(id, { keepHash: true });
        loadHistory(true, true);
      } catch (err) { errToast(err); busy(resend, false); }
    });
    const foot = el('div', { class: 'nc-aside-foot' }, [resend]);
    if (rule) {
      foot.appendChild(el('a', { class: 'btn btn-primary', id: 'nc-proto-rule', href: hashFor('rules', n.event_id), text: T('notify.proto.open_rule') }));
    }
    box.appendChild(foot);
    if (!rule && n.event_id && !state.rules) ensureRules({ quiet: true }).then(() => { if (String(H.sel) === String(id) && H.detail === res) renderDetail(id, res, null); });
  }

  // ─── Einstellungen ───────────────────────────────────────────────────────
  const setForm = $('nc-set-form');
  const setFields = Array.from(setForm.querySelectorAll('[data-nc-field]'));
  async function loadSettings() {
    setForm.hidden = true;
    try {
      const res = await request('GET', '/api/v1/notify/settings');
      state.settings = normSettings(isObj(res.settings) ? res.settings : res);
      state.setDraft = Object.assign({}, state.settings);
      state.setErr = null;
    } catch (err) {
      state.setErr = err;
    }
    stateBox($('nc-set-state'), state.setErr, () => loadSettings());
    setForm.hidden = !state.settings;
    fillSettings();
  }
  function fillSettings() {
    if (!state.setDraft) return;
    setFields.forEach((f) => {
      const k = f.dataset.ncField;
      const v = state.setDraft[k];
      if (f.getAttribute('role') === 'switch') f.setAttribute('aria-checked', v ? 'true' : 'false');
      else f.value = v == null ? '' : String(v);
      fieldError(f, null);
    });
    updateSettingsBar();
  }
  function fieldError(f, msg) {
    const err = $(f.id + '-err');
    if (err) { err.textContent = msg || ''; err.hidden = !msg; }
    if (f.getAttribute('role') !== 'switch') f.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  function updateSettingsBar() {
    const dirty = state.settings && state.setDraft ? Object.keys(settingsDiff(state.settings, state.setDraft)).length > 0 : false;
    $('nc-set-save').disabled = !dirty;
    $('nc-set-discard').disabled = !dirty;
    $('nc-set-dirty').hidden = !dirty;
  }
  setFields.forEach((f) => {
    const k = f.dataset.ncField;
    if (f.getAttribute('role') === 'switch') {
      f.addEventListener('click', () => {
        if (!state.setDraft) return;
        state.setDraft[k] = f.getAttribute('aria-checked') !== 'true';
        f.setAttribute('aria-checked', state.setDraft[k] ? 'true' : 'false');
        updateSettingsBar();
      });
    } else {
      f.addEventListener('input', () => {
        if (!state.setDraft) return;
        const raw = f.value.trim();
        state.setDraft[k] = raw === '' ? null : Number(raw);
        const bad = rangeError(raw, Number(f.min), Number(f.max));
        fieldError(f, bad ? T('notify.set.range', bad) : null);
        updateSettingsBar();
      });
    }
  });
  $('nc-set-discard').addEventListener('click', () => { if (state.settings) { state.setDraft = Object.assign({}, state.settings); fillSettings(); } });
  setForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.settings) return;
    let firstBad = null;
    setFields.forEach((f) => {
      if (f.getAttribute('role') === 'switch') return;
      const bad = rangeError(f.value.trim(), Number(f.min), Number(f.max));
      fieldError(f, bad ? T('notify.set.range', bad) : null);
      if (bad && !firstBad) firstBad = f;
    });
    if (firstBad) { firstBad.focus(); return; }
    const diff = settingsDiff(state.settings, state.setDraft);
    if (!Object.keys(diff).length) return;
    const btn = $('nc-set-save');
    busy(btn, true);
    try {
      const res = await request('PUT', '/api/v1/notify/settings', diff);
      const next = isObj(res.settings) ? res.settings : res;
      state.settings = normSettings(Object.assign({}, state.setDraft, SETTINGS_FIELDS.some((f) => f in next) ? next : {}));
      state.setDraft = Object.assign({}, state.settings);
      fillSettings();
      toast(T('notify.set.saved'));
      state.ovLoaded = false; // the hub card shows these values
    } catch (err) {
      const fields = err && err.data && isObj(err.data.fields) ? err.data.fields : null;
      if (fields) {
        setFields.forEach((f) => { if (fields[f.dataset.ncField]) fieldError(f, str(fields[f.dataset.ncField])); });
      }
      errToast(err);
    } finally {
      busy(btn, false);
      updateSettingsBar();
    }
  });

  // ─── Live updates (events.js) ────────────────────────────────────────────
  const timers = {};
  function later(key, fn, ms) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(fn, ms);
  }
  function refreshAfterNotify() {
    if (state.ovLoaded) later('ov', () => loadOverview(true), 800);
    if (H.loaded && H.items.length <= HISTORY_LIMIT) later('hist', () => loadHistory(true, true), 800);
    if (state.devices) later('dev', () => loadDevices(true), 1500);
  }
  doc.addEventListener('gc:push_presence', (e) => {
    const p = e && isObj(e.detail) ? e.detail : null;
    if (!p || !state.devices) { if (state.ovLoaded) later('ov', () => loadOverview(true), 1500); return; }
    const i = state.devices.findIndex((d) => String(d.token_id) === String(p.token_id));
    if (i >= 0) {
      const d = state.devices[i];
      const next = normDevice(Object.assign({}, d, {
        state: DEVICE_STATES.indexOf(p.state) >= 0 ? p.state : d.state,
        via: p.via !== undefined ? p.via : d.via,
        connected_since: p.state === 'connected' && d.state !== 'connected' ? new Date().toISOString() : d.connected_since,
        last_seen: p.state === 'offline' && d.state !== 'offline' ? new Date().toISOString() : d.last_seen,
      }));
      state.devices[i] = next;
      const row = $('nc-dev-body').querySelector('tr[data-token-id="' + cssEsc(String(p.token_id)) + '"]');
      const focused = row && row.contains(doc.activeElement);
      if (row) {
        const fresh = deviceRow(next);
        row.replaceWith(fresh);
        if (focused) { const b = fresh.querySelector('button'); if (b) b.focus(); }
      }
      updateSend();
    }
    // the full record (buffer, last ack, a device we did not know) follows from the API
    later('dev', () => loadDevices(true), 2500);
    if (state.ovLoaded) later('ov', () => loadOverview(true), 1500);
  });
  doc.addEventListener('gc:notify', refreshAfterNotify);
  doc.addEventListener('gc:reconnected', () => {
    if (state.tab === 'overview' && state.ovLoaded) loadOverview(true);
    if (state.devices) loadDevices(true);
    if (H.loaded) loadHistory(true, true);
  });

  // ─── Keyboard: Esc closes the open side panel ────────────────────────────
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || doc.querySelector('.modal-overlay.active, .gcd-dialog')) return;
    if (state.tab === 'rules' && state.sel && $('nc-rule-editor').contains(doc.activeElement)) closeRule();
    else if (state.tab === 'history' && H.sel && $('nc-proto').contains(doc.activeElement)) closeDetail();
  });

  // ─── Start ───────────────────────────────────────────────────────────────
  setPro(state.pro);
  refreshTtl();
  updateSend();
  const start = parseHash(win.location.hash);
  setTab(start.tab, start.id, { keepHash: true });
  if (start.tab !== 'overview') loadOverview(true); // KPIs + sidebar badge
  win.GCNotify = { pure, tab: () => state.tab, rule: () => state.sel, message: () => H.sel };
  return pure;
});
