'use strict';

// Pure helpers of the settings page (no DOM) — public/js/settings.js uses
// them in the browser, tests/settings_ui.test.js in node.
//
//   resolveLocation   /settings#<section>, the old tab names (#backup,
//                     ?tab=general …) and element ids → { section, anchor }
//   norm / matches    the settings search (case- and accent-insensitive)
//   valueKey / dirtyFields / savePlan   the save model
//   checkNumber, semverOk, cidrOk, recipientsOk   client-side checks
//   eventRows / typesOfRows / hooksForRow / webhookSummary   event matrix +
//                     webhook dialog (catalogue from services/notifications.js)
//   portalHost, nextBackupAt, windowSegments, minutesOf   small formatters
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCSettingsUI = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const SECTIONS = ['uebersicht', 'domains', 'netzwerk', 'daten', 'anmeldung', 'geraete', 'gruppen', 'richtlinien',
    'splittunnel', 'clientupdates', 'email', 'benachrichtigungen', 'webhooks', 'monitoring', 'pihole', 'geoip',
    'portal', 'backup', 'updates', 'lizenz', 'gefahr'];

  // The twelve tabs of the old page (links: /settings#backup from the
  // security check and the dashboard, ?tab=general, the quick search).
  const LEGACY_TABS = {
    general: 'uebersicht',
    security: 'anmeldung',
    backup: 'backup',
    email: 'email',
    monitoring: 'monitoring',
    advanced: 'updates',
    license: 'lizenz',
    'split-tunnel': 'splittunnel',
    'client-updates': 'clientupdates',
    'client-policy': 'richtlinien',
    pihole: 'pihole',
    portal: 'portal',
  };
  // Element ids of the old page that have no element of that id any more.
  const LEGACY_ANCHORS = {
    'card-autoupdate': 'updates',
    'autobackup-enabled': 'backup',
    'offsite-targets': 'backup',
    'premig-list': 'backup',
    'webhooks-list': 'webhooks',
    'alerts-email': 'benachrichtigungen',
    'smtp-host': 'email',
    'domains-table': 'domains',
    'acme-email': 'domains',
    'tls-max-attempts': 'domains',
    'security-locked-list': 'anmeldung',
    'cu-overview': 'clientupdates',
    'ip2location-key': 'geoip',
    'portal-base-domain': 'portal',
  };

  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  /**
   * Where to go: hash first (#<section>, #<old tab>, #<element id>), then
   * ?tab=<section|old tab>. `known` = available section ids,
   * `sectionOfElement(id)` → the section an element with that id lives in
   * (or null). → { section, anchor } or null.
   */
  function resolveLocation(loc, opts) {
    const o = opts || {};
    const known = new Set(o.known || SECTIONS);
    const ofEl = o.sectionOfElement || (() => null);
    const pick = (name, allowAnchor) => {
      if (!name || !ID_RE.test(name)) return null;
      if (known.has(name)) return { section: name, anchor: null };
      const legacy = LEGACY_TABS[name];
      if (legacy && known.has(legacy)) return { section: legacy, anchor: null };
      if (!allowAnchor) return null;
      const el = ofEl(name);
      if (el && known.has(el)) return { section: el, anchor: name };
      const old = LEGACY_ANCHORS[name];
      if (old && known.has(old)) return { section: old, anchor: null };
      return null;
    };
    let hash = String((loc && loc.hash) || '').replace(/^#/, '');
    try { hash = decodeURIComponent(hash); } catch (_) { /* keep raw */ }
    const fromHash = pick(hash, true);
    if (fromHash) return fromHash;
    const m = /(?:^|[?&])tab=([^&#]*)/.exec(String((loc && loc.search) || ''));
    if (m) {
      let tab = m[1];
      try { tab = decodeURIComponent(tab); } catch (_) { /* keep raw */ }
      return pick(tab, false);
    }
    return null;
  }

  // ── Search ──
  function norm(s) {
    let v = String(s == null ? '' : s).toLowerCase().replace(/ß/g, 'ss');
    try { v = v.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* old engines */ }
    return v.replace(/\s+/g, ' ').trim();
  }
  function tokens(q) { return norm(q).split(' ').filter(Boolean); }
  /** Every token of the query appears in the text. Empty query → true. */
  function matches(text, query) {
    const hay = norm(text);
    return tokens(query).every((tk) => hay.includes(tk));
  }

  // ── Save model ──
  /** Canonical comparable form of a field value. */
  function valueKey(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  /** Fields whose current value differs from the saved one. */
  function dirtyFields(baseline, current) {
    const out = [];
    for (const k of Object.keys(current || {})) {
      if (!(k in (baseline || {}))) continue; // never loaded → never dirty
      if (valueKey(baseline[k]) !== valueKey(current[k])) out.push(k);
    }
    return out;
  }
  /** The save groups that have at least one dirty field, in their order. */
  function savePlan(groups, dirty) {
    const d = new Set(dirty || []);
    return (groups || []).filter((g) => (g.fields || []).some((f) => d.has(f)));
  }
  /** Only the dirty keys of a mapping { bodyKey: fieldName } → { bodyKey: value }. */
  function pickDirty(map, values, dirty, cast) {
    const d = new Set(dirty || []);
    const out = {};
    for (const [bodyKey, field] of Object.entries(map)) {
      if (d.has(field)) out[bodyKey] = cast ? cast(values[field], field) : values[field];
    }
    return out;
  }

  /** null when ok, else { min, max } (also for empty / non-integers). */
  function checkNumber(value, min, max) {
    const s = String(value == null ? '' : value).trim();
    if (!/^-?\d+$/.test(s)) return { min, max };
    const n = Number(s);
    if (n < min || n > max) return { min, max };
    return null;
  }
  function semverOk(v) { const s = String(v || '').trim(); return s === '' || /^v?\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(s); }
  function cidrOk(v) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(v || '').trim());
    if (!m) return false;
    return m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32;
  }
  /** '' or comma-separated addresses that look like e-mail addresses. */
  function recipientsOk(v) {
    const list = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    return list.length <= 10 && list.every((a) => /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(a) && a.length <= 254);
  }

  // ── Events (catalogue: [{ id, events: [{ id, types, free }] }]) ──
  function allRows(catalogue) {
    const out = [];
    (catalogue || []).forEach((g) => (g.events || []).forEach((e) => out.push(Object.assign({ group: g.id }, e))));
    return out;
  }
  function parseTypes(v) { return String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean); }
  /** Row ids that a type list ticks (any of a row's types). '*' → every row. */
  function eventRows(catalogue, types) {
    const list = Array.isArray(types) ? types : parseTypes(types);
    if (list.includes('*')) return allRows(catalogue).map((r) => r.id);
    const set = new Set(list);
    return allRows(catalogue).filter((r) => r.types.some((t) => set.has(t))).map((r) => r.id);
  }
  /** Row ids → every type of those rows (catalogue order). */
  function typesOfRows(catalogue, ids) {
    const want = new Set(ids || []);
    return allRows(catalogue).filter((r) => want.has(r.id)).flatMap((r) => r.types);
  }
  /** Enabled webhooks that receive at least one type of the row. */
  function hooksForRow(row, hooks) {
    return (hooks || []).filter((h) => h.enabled && (String(h.events).trim() === '*' || parseTypes(h.events).some((t) => row.types.includes(t)))).length;
  }
  /** → { all: true } | { groups: [group ids in catalogue order], rows: n } */
  function webhookSummary(catalogue, events) {
    if (String(events == null ? '' : events).trim() === '*') return { all: true, groups: [], rows: 0 };
    const rows = eventRows(catalogue, events);
    const groups = (catalogue || []).filter((g) => (g.events || []).some((e) => rows.includes(e.id))).map((g) => g.id);
    return { all: false, groups, rows: rows.length };
  }

  // ── Small formatters ──
  function portalHost(base, prefix, internal) {
    const b = String(base || '').trim();
    const p = String(prefix || '').trim();
    if (!b) return String(internal || '');
    return p ? p + '.' + b : b;
  }
  const SCHEDULE_MS = { '6h': 6 * 3600e3, '12h': 12 * 3600e3, daily: 24 * 3600e3, '3d': 3 * 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
  /** Next automatic backup (ms) — last run + interval, never in the past. */
  function nextBackupAt(lastRun, schedule, enabled, now) {
    if (!enabled) return null;
    const step = SCHEDULE_MS[schedule] || SCHEDULE_MS.daily;
    const n = now == null ? Date.now() : now;
    const last = lastRun ? Date.parse(lastRun) : NaN;
    if (!Number.isFinite(last)) return n + step;
    let next = last + step;
    while (next < n) next += step;
    return next;
  }
  function minutesOf(hhmm) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  /** The window as bar segments in percent of the day ([] when invalid). */
  function windowSegments(start, end) {
    const a = minutesOf(start);
    const b = minutesOf(end);
    if (a == null || b == null || a === b) return [];
    const pct = (m) => Math.round((m / 1440) * 10000) / 100;
    if (a < b) return [{ left: pct(a), width: pct(b - a) }];
    return [{ left: pct(a), width: pct(1440 - a) }, { left: 0, width: pct(b) }];
  }
  /** Minutes until the window opens next (0 = open now). */
  function minutesToWindow(start, end, nowMinutes) {
    const a = minutesOf(start);
    const b = minutesOf(end);
    if (a == null || b == null || a === b) return null;
    const n = nowMinutes;
    const inside = a < b ? n >= a && n < b : n >= a || n < b;
    if (inside) return 0;
    return (a - n + 1440) % 1440;
  }
  function fmt(template, params) {
    let s = String(template == null ? '' : template);
    Object.keys(params || {}).forEach((k) => {
      s = s.split('{{' + k + '}}').join(String(params[k])).split('{' + k + '}').join(String(params[k]));
    });
    return s;
  }

  return {
    SECTIONS, LEGACY_TABS, LEGACY_ANCHORS, resolveLocation,
    norm, tokens, matches,
    valueKey, dirtyFields, savePlan, pickDirty,
    checkNumber, semverOk, cidrOk, recipientsOk,
    allRows, parseTypes, eventRows, typesOfRows, hooksForRow, webhookSummary,
    portalHost, nextBackupAt, minutesOf, windowSegments, minutesToWindow, fmt,
  };
});
