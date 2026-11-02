'use strict';

// Logs & Monitoring — admin page /logs (FEATURES.md "Logs & Monitoring",
// templates/aurora/pages/logs.njk).
//
//   Ereignisse   server, plugins, activity, access, sessions as one list:
//                KPI tiles (click = filter), timeline (drag = range, click =
//                slot), facets with counts, search syntax, chips, "Gleiche
//                zusammenfassen", time clusters, selection bar, endless
//                loading; #e/<id> opens an entry ("Was bedeutet das?",
//                fields as filter, raw data, "Zur selben Zeit").
//   Probleme     grouped errors/warnings, status, correlation, notify.
//   Zugriffe     Caddy access log; Sitzungen (rdp-history.js); Gespeicherte Filter.
//   Export       dialog: scope, range, levels, sources, format, columns,
//                privacy, time zone, preview, templates.
// APIs: /api/v1/logs/{meta,events,events/stats,events/item,events/export,
// events/export/preview,problems,problems/item,problems/state,saved,access}.
// Strings: the #lg-i18n island (lg.*, common.*). DOM only via el() — no
// innerHTML: log lines are untrusted text. The pure helpers are exported for
// node:test (tests/logs_page.test.js); in the browser the file mounts itself.
(function (root, factory) {
  const core = factory(typeof window !== 'undefined' ? window : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof self !== 'undefined' ? self : this, function (win) {
  const LEVELS = ['error', 'warn', 'info', 'debug'];
  const SOURCES = ['server', 'plugins', 'activity', 'access', 'sessions'];
  const RANGES = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
  const TABS = ['events', 'problems', 'access', 'sessions', 'saved'];
  const DEFAULTS = { range: '24h', from: null, to: null, levels: ['error', 'warn'], sources: ['server', 'plugins', 'activity'], plugins: [], q: '', problem: '' };
  const PAGE = 100;
  const CLUSTER_MS = 2000;
  const LIVE_MS = 15000;
  const WINDOWS = [10, 60, 300];
  const COLS = ['time', 'level', 'source', 'message', 'fields', 'raw'];

  // ─── Pure helpers ────────────────────────────────────────────────────────

  function str(v) { return v == null ? '' : String(v); }
  function list(v) { return str(v).split(',').map((s) => s.trim()).filter(Boolean); }

  /** Filter state → "range=24h&level=error,warn…" (defaults left out). */
  function stateQuery(s) {
    const p = [];
    const add = (k, v) => p.push(k + '=' + encodeURIComponent(v));
    if (s.range !== DEFAULTS.range) add('range', s.range);
    if (s.range === 'custom') {
      if (s.from != null) add('from', s.from);
      if (s.to != null) add('to', s.to);
    }
    if (s.levels.join(',') !== DEFAULTS.levels.join(',')) add('level', s.levels.join(',') || 'none');
    if (s.sources.join(',') !== DEFAULTS.sources.join(',')) add('source', s.sources.join(',') || 'none');
    if (s.plugins.length) add('plugin', s.plugins.join(','));
    if (s.q) add('q', s.q);
    if (s.problem) add('problem', s.problem);
    return p.join('&');
  }

  /** "range=7d&level=…" → filter state (invalid parts dropped). */
  function parseState(query) {
    const s = { range: DEFAULTS.range, from: null, to: null, levels: DEFAULTS.levels.slice(), sources: DEFAULTS.sources.slice(), plugins: [], q: '', problem: '' };
    str(query).replace(/^\?/, '').split('&').forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf('=');
      const k = i < 0 ? pair : pair.slice(0, i);
      let v = '';
      try { v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1)); } catch { return; }
      if (k === 'range' && (RANGES[v] || v === 'custom')) s.range = v;
      if ((k === 'from' || k === 'to') && /^\d{10,16}$/.test(v)) s[k] = Number(v);
      if (k === 'level') s.levels = v === 'none' ? [] : LEVELS.filter((l) => list(v).includes(l));
      if (k === 'source') s.sources = v === 'none' ? [] : SOURCES.filter((x) => list(v).includes(x));
      if (k === 'plugin') s.plugins = list(v).filter((x) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(x)).slice(0, 50);
      if (k === 'q') s.q = v.slice(0, 300);
      if (k === 'problem') s.problem = v.slice(0, 300);
    });
    if (s.range === 'custom' && s.from == null) s.range = DEFAULTS.range;
    return s;
  }

  /** '#events?…' / '#e/<id>' / '#problems/<key>' → { tab, query, entry, problem }. */
  function parseHash(hash) {
    const h = str(hash).replace(/^#/, '');
    const qi = h.indexOf('?');
    const path = qi < 0 ? h : h.slice(0, qi);
    const query = qi < 0 ? '' : h.slice(qi + 1);
    const m = /^e\/([A-Za-z0-9.]{3,40})$/.exec(path);
    if (m) return { tab: 'events', query, entry: m[1], problem: null };
    const p = /^problems\/(.+)$/.exec(path);
    if (p) {
      let key = null;
      try { key = decodeURIComponent(p[1]); } catch { key = null; }
      return { tab: 'problems', query, entry: null, problem: key };
    }
    return { tab: TABS.includes(path) ? path : 'events', query, entry: null, problem: null };
  }

  /** Effective from/to (epoch ms) of a state at `now`; to null = now (live). */
  function bounds(s, now) {
    if (s.range === 'custom') return { from: s.from, to: s.to };
    return { from: now - (RANGES[s.range] || RANGES['24h']), to: null };
  }

  /** API query of a state (for /events, /events/stats). */
  function apiQuery(s, now, extra) {
    const b = bounds(s, now);
    const p = [];
    const add = (k, v) => p.push(k + '=' + encodeURIComponent(v));
    if (b.from != null) add('from', b.from);
    if (b.to != null) add('to', b.to);
    if (s.levels.length && s.levels.length < LEVELS.length) add('level', s.levels.join(','));
    if (s.sources.length) add('source', s.sources.join(','));
    if (s.plugins.length) add('plugin', s.plugins.join(','));
    if (s.q) add('q', s.q);
    if (s.problem) add('problem', s.problem);
    Object.keys(extra || {}).forEach((k) => { if (extra[k] != null && extra[k] !== '') add(k, extra[k]); });
    return p.join('&');
  }

  /** Message with numbers blanked (for "Gleiche zusammenfassen"). */
  function sameKey(e) {
    return [e.source, e.plugin || '', e.level, str(e.msg).replace(/\d+/g, '#')].join('|');
  }

  /** Consecutive identical entries → one row { entry, ids, n }. */
  function collapse(entries, on) {
    const out = [];
    for (const e of entries) {
      const last = out[out.length - 1];
      if (on && last && sameKey(last.entry) === sameKey(e)) {
        last.n += 1;
        last.ids.push(e.id);
        continue;
      }
      out.push({ entry: e, ids: [e.id], n: 1 });
    }
    return out;
  }

  /**
   * Time clusters among rows (newest first): ≥ 3 warnings/errors from ≥ 2
   * sources, each within 2 s of the next. → [{ start, end, n, sources, from, to }]
   * (start/end: row indexes).
   */
  function clusters(rows) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const e = rows[i].entry;
      if (e.level !== 'error' && e.level !== 'warn') { i += 1; continue; }
      let j = i;
      let last = e.ts;
      const srcs = new Set([e.plugin ? 'p:' + e.plugin : e.source]);
      let n = rows[i].n;
      let k = i + 1;
      while (k < rows.length && last - rows[k].entry.ts <= CLUSTER_MS) {
        const x = rows[k].entry;
        if (x.level === 'error' || x.level === 'warn') {
          j = k;
          last = x.ts;
          srcs.add(x.plugin ? 'p:' + x.plugin : x.source);
          n += rows[k].n;
        }
        k += 1;
      }
      if (n >= 3 && srcs.size >= 2) {
        out.push({ start: i, end: j, n, sources: srcs.size, from: rows[j].entry.ts, to: e.ts });
        i = j + 1;
      } else {
        i += 1;
      }
    }
    return out;
  }

  /** Every bucket start between from and to (empty ones too), capped. */
  function bucketTimes(from, to, ms) {
    const out = [];
    if (!(ms > 0) || from == null) return out;
    for (let t = Math.floor(from / ms) * ms; t <= to && out.length < 400; t += ms) out.push(t);
    return out;
  }

  function fmtBytes(n) {
    if (!(n >= 0)) return '–';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** Entry as one text line (copy as text). */
  function textLine(e) {
    return [str(e.time), str(e.level).toUpperCase().padEnd(5), '[' + e.source + (e.pluginName ? ':' + e.pluginName : '') + ']', str(e.msg), e.ctx ? '· ' + e.ctx : '']
      .filter(Boolean).join(' ');
  }

  /** A field as search text: key:value for known keys, else "value". */
  function fieldFilter(key, value) {
    const v = str(value);
    const k = { plugin: 'plugin', event: 'event', status: 'status', ip: 'ip', host: 'host', code: 'code' }[key];
    if (k && !/\s|"/.test(v)) return k + ':' + v;
    return '"' + v.replace(/"/g, '') + '"';
  }

  /** Nested fields → [[ 'a.b', value ]] (two levels, the rest as JSON). */
  function flatFields(obj) {
    const out = [];
    Object.keys(obj || {}).forEach((k) => {
      const v = obj[k];
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        Object.keys(v).forEach((k2) => {
          const x = v[k2];
          out.push([k + '.' + k2, x != null && typeof x === 'object' ? JSON.stringify(x) : x]);
        });
      } else {
        out.push([k, Array.isArray(v) ? JSON.stringify(v) : v]);
      }
    });
    return out.filter((p) => p[1] != null && p[1] !== '');
  }

  const pure = {
    LEVELS, SOURCES, RANGES, TABS, DEFAULTS, stateQuery, parseState, parseHash, bounds, apiQuery,
    sameKey, collapse, clusters, bucketTimes, fmtBytes, textLine, fieldFilter, flatFields,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ────────────────────────────────────────────────────────
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const page = $('lg-page');
  if (!page) return pure;

  function readJson(id) {
    const n = $(id);
    if (!n) return {};
    try { return JSON.parse(n.textContent || '{}') || {}; } catch { return {}; }
  }
  const I18N = readJson('lg-i18n');
  const LANG = (win.GC && win.GC.language) || doc.documentElement.lang || 'de';
  const LOCALE = LANG === 'en' ? 'en-GB' : 'de-DE';
  function T(key, params) {
    let s = I18N[key];
    if (s == null && win.GC && win.GC.t) s = win.GC.t[key];
    if (s == null) s = key;
    Object.keys(params || {}).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  const D = win.GCDialog;
  const LICENCE_EXPORT = page.dataset.licenceExport === '1';
  const nf = new Intl.NumberFormat(LOCALE);
  const num = (n) => nf.format(Number(n) || 0);

  function el(tag, props, children) {
    const n = doc.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else if (k === 'hidden' || k === 'type' || k === 'value' || k === 'disabled' || k === 'checked') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      n.append(c instanceof win.Node ? c : String(c));
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(d, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    const px = String(size || 14);
    [['viewBox', '0 0 24 24'], ['width', px], ['height', px], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    d.split('|').forEach((part) => {
      const path = doc.createElementNS(SVGNS, 'path');
      path.setAttribute('d', part);
      svg.append(path);
    });
    return svg;
  }
  const I_X = 'M6 6l12 12|M18 6 6 18';
  const I_FUNNEL = 'M3 5h18l-7 8v6l-4-2v-4z';
  const I_CLOCK = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M12 7v5l3 2';
  const I_LEFT = 'm15 18-6-6 6-6';
  const I_RIGHT = 'm9 18 6-6-6-6';
  const I_LOCK = 'M6 11h12v10H6z|M8 11V7a4 4 0 0 1 8 0v4';
  const I_DOWN = 'M12 3v12|M7 10l5 5 5-5|M4 21h16';
  function toast(msg, type) { if (win.showToast) win.showToast(msg, type || 'success'); }

  async function api(method, url, body) {
    const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (method !== 'GET') opts.headers['X-CSRF-Token'] = (win.GC && win.GC.csrfToken) || '';
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await win.fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || res.statusText || 'error');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function fmtTime(ts, opts) {
    try {
      return new Intl.DateTimeFormat(LOCALE, opts || { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
    } catch { return new Date(ts).toISOString(); }
  }
  const fmtShort = (ts) => fmtTime(ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtClock = (ts) => fmtTime(ts, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function fmtFull(ts) {
    const base = fmtTime(ts, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return base + ',' + String(ts % 1000).padStart(3, '0');
  }
  function ago(ts) {
    const d = Date.now() - ts;
    if (d < 60e3) return T('lg.ago_now');
    if (d < 3600e3) return T('lg.ago_min', { n: Math.floor(d / 60e3) });
    if (d < 86400e3) return T('lg.ago_h', { n: Math.floor(d / 3600e3) });
    return T('lg.ago_d', { n: Math.floor(d / 86400e3) });
  }
  function toLocalInput(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function levelBadge(level) {
    return el('span', { class: 'lg-lv lg-lv-' + level, text: T('lg.level_' + level) });
  }
  function sourceLabel(e) {
    if (e.source === 'plugins') return e.pluginName || e.plugin || T('lg.src_plugins');
    return T('lg.src_' + e.source);
  }
  function codeTitle(code, fallback) {
    const k = 'lg.code.' + code + '.title';
    return code && I18N[k] ? I18N[k] : fallback;
  }

  // ─── State ───────────────────────────────────────────────────────────────

  let meta = { admin: true, sources: SOURCES.slice(), plugins: [], licence: { log_export: LICENCE_EXPORT } };
  let state = parseState('');
  let tab = 'events';
  let entries = [];
  let next = null;
  let loading = false;
  const selected = new Set();
  let stats = null;
  let pluginsOpen = false;
  let live = false;
  let liveTimer = null;
  let generation = 0;
  let detailId = null;
  let problemKey = null;
  let savedViews = [];

  function allowedSources() { return SOURCES.filter((s) => meta.sources.includes(s)); }

  function writeHash() {
    let h;
    if (detailId) h = '#e/' + detailId;
    else if (tab === 'problems' && problemKey) h = '#problems/' + encodeURIComponent(problemKey);
    else h = '#' + tab;
    const q = stateQuery(state);
    if (q && (tab === 'events' || tab === 'problems') && !detailId) h += '?' + q;
    if (h !== win.location.hash) win.history.replaceState(null, '', h);
  }

  // ─── Tabs ────────────────────────────────────────────────────────────────

  function showTab(name, opts) {
    tab = TABS.includes(name) ? name : 'events';
    doc.querySelectorAll('#lg-tabs [role="tab"]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    TABS.forEach((t) => { $('lg-panel-' + t).hidden = t !== tab; });
    $('lg-sub').textContent = T(tab === 'problems' ? 'lg.subtitle_problems' : 'lg.subtitle');
    $('lg-range').hidden = !(tab === 'events' || tab === 'problems' || tab === 'access');
    $('lg-live').hidden = tab !== 'events';
    if (tab === 'problems') loadProblems();
    if (tab === 'access') loadAccess(true);
    if (tab === 'saved') loadSaved();
    if (!(opts && opts.keepHash)) writeHash();
  }

  $('lg-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[role="tab"]');
    if (!b) return;
    detailId = null;
    problemKey = null;
    showTab(b.dataset.tab);
    if (b.dataset.tab === 'events') { showDetail(null); reloadEvents(); }
  });
  $('lg-tabs').addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const btns = Array.from(doc.querySelectorAll('#lg-tabs [role="tab"]')).filter((b) => !b.hidden);
    let i = btns.indexOf(doc.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowRight') i = (i + 1) % btns.length;
    if (e.key === 'ArrowLeft') i = (i - 1 + btns.length) % btns.length;
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = btns.length - 1;
    btns[i].focus();
    btns[i].click();
  });

  // ─── Range, live ─────────────────────────────────────────────────────────

  function paintRange() {
    doc.querySelectorAll('#lg-range [data-range]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.range === state.range ? 'true' : 'false'));
  }
  $('lg-range').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    if (b.dataset.range === 'custom') {
      const form = $('lg-custom');
      form.hidden = !form.hidden;
      const bb = bounds(state, Date.now());
      $('lg-custom-from').value = toLocalInput(bb.from != null ? bb.from : Date.now() - 86400e3);
      $('lg-custom-to').value = toLocalInput(bb.to != null ? bb.to : Date.now());
      if (!form.hidden) $('lg-custom-from').focus();
      return;
    }
    $('lg-custom').hidden = true;
    setState({ range: b.dataset.range, from: null, to: null });
  });
  $('lg-custom').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = Date.parse($('lg-custom-from').value);
    const to = $('lg-custom-to').value ? Date.parse($('lg-custom-to').value) : null;
    if (!Number.isFinite(from) || (to != null && (!Number.isFinite(to) || to < from))) return;
    $('lg-custom').hidden = true;
    setState({ range: 'custom', from, to: to != null ? to + 59999 : null });
  });
  $('lg-custom-cancel').addEventListener('click', () => { $('lg-custom').hidden = true; });

  function setLive(on) {
    live = !!on;
    const b = $('lg-live');
    b.setAttribute('aria-pressed', live ? 'true' : 'false');
    b.title = T(live ? 'lg.live_on' : 'lg.live_off');
    if (liveTimer) win.clearInterval(liveTimer);
    liveTimer = live ? win.setInterval(liveTick, LIVE_MS) : null;
  }
  $('lg-live').addEventListener('click', () => setLive(!live));
  let lastLive = 0;
  function liveTick() {
    // Throttled: at most every 5 s (SSE events can come in bursts).
    if (Date.now() - lastLive < 5000) return;
    if (doc.hidden || tab !== 'events' || detailId || state.range === 'custom' || loading) return;
    lastLive = Date.now();
    loadStats();
    if (!selected.size && $('lg-list').getBoundingClientRect().top > -200) loadEvents(true);
  }

  /** Change the filter (partial) and reload what shows it. */
  function setState(patch) {
    state = Object.assign({}, state, patch);
    paintRange();
    selected.clear();
    detailId = null;
    writeHash();
    if (tab === 'events') {
      showDetail(null);
      reloadEvents();
    } else if (tab === 'problems') loadProblems();
    else if (tab === 'access') loadAccess(true);
  }

  function reloadEvents() {
    paintFilters();
    loadStats();
    loadEvents(true);
  }

  // ─── Stats: KPI tiles, timeline, facet counts ───────────────────────────

  let statsGen = 0;
  async function loadStats() {
    const gen = ++statsGen;
    try {
      const r = await api('GET', '/api/v1/logs/events/stats?' + apiQuery(state, Date.now(), { bucket: 'auto' }));
      if (gen !== statsGen) return;
      stats = r;
      paintKpis();
      paintHist();
      paintFilters();
      paintCount();
    } catch { /* the list shows the error */ }
  }

  function kpiTile(o) {
    return el('button', { type: 'button', class: 'lg-kpi' + (o.tone ? ' lg-kpi-' + o.tone : ''), 'data-kpi': o.id, title: T('lg.kpi_filter_hint'),
      on: { click: o.click } }, [
      el('span', { class: 'lg-kl', text: o.label }),
      el('span', { class: 'lg-kv' }, [o.value, o.of ? el('span', { class: 'lg-kv-of', text: ' / ' + o.of }) : null]),
      el('span', { class: 'lg-kd', text: o.sub || '' }),
    ]);
  }

  function paintKpis() {
    const box = $('lg-kpis');
    clear(box);
    if (!stats) return;
    const k = stats.kpi;
    const reset = { plugins: [], q: '', problem: '' };
    let errSub = '';
    if (k.errorsBefore != null) {
      const d = k.errors - k.errorsBefore;
      errSub = d > 0 ? T('lg.kpi_errors_more', { n: num(d) }) : d < 0 ? T('lg.kpi_errors_less', { n: num(-d) }) : T('lg.kpi_errors_same');
    }
    box.append(kpiTile({ id: 'errors', label: T('lg.kpi_errors'), value: num(k.errors), sub: errSub, tone: k.errors ? 'error' : null,
      click: () => setState(Object.assign({ levels: ['error'], sources: allowedSources() }, reset)) }));
    box.append(kpiTile({ id: 'warnings', label: T('lg.kpi_warnings'), value: num(k.warnings), tone: k.warnings ? 'warn' : null,
      sub: k.topWarning ? T('lg.kpi_warnings_top', { n: num(k.topWarning.count), name: codeTitle(k.topWarning.code, k.topWarning.code) }) : '',
      click: () => setState(Object.assign({ levels: ['warn'], sources: allowedSources() }, reset)) }));
    if (meta.sources.includes('server')) {
      box.append(kpiTile({ id: 'blocked', label: T('lg.kpi_blocked'), value: num(k.blocked.count) + '×',
        sub: k.blocked.count ? T('lg.kpi_blocked_sub', { s: (k.blocked.maxMs / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 }), time: fmtShort(Date.parse(k.blocked.at)) }) : T('lg.kpi_blocked_none'),
        click: () => setState(Object.assign({ levels: LEVELS.slice(), sources: ['server'] }, reset, { q: 'code:event_loop_blocked' })) }));
    }
    if (meta.sources.includes('access')) {
      box.append(kpiTile({ id: 'http', label: T('lg.kpi_http'), value: num(k.http.errors), sub: T('lg.kpi_http_sub', { n: num(k.http.total) }),
        click: () => setState(Object.assign({ levels: ['error'], sources: ['access'] }, reset)) }));
    }
    if (meta.sources.includes('plugins')) {
      const names = k.plugins.withErrors.slice(0, 4).map((p) => p.name).join(', ');
      box.append(kpiTile({ id: 'plugins', label: T('lg.kpi_plugins'), value: num(k.plugins.withErrors.length), of: k.plugins.installed ? num(k.plugins.installed) : null,
        sub: names || T('lg.kpi_plugins_none'), click: () => setState(Object.assign({ levels: ['error', 'warn'], sources: ['plugins'] }, reset)) }));
    }
  }

  // Timeline: bars per bucket (stacked by level), click = that slot, drag = range.
  let histBuckets = [];
  function paintHist() {
    const plot = $('lg-hist');
    const axis = $('lg-hist-axis');
    plot.querySelectorAll('.lg-bar').forEach((n) => n.remove());
    clear(axis);
    if (!stats || !stats.histogram) return;
    const now = Date.now();
    const b = bounds(state, now);
    const ms = stats.histogram.bucketMs;
    const by = new Map(stats.histogram.buckets.map((x) => [x.t, x]));
    const from = b.from != null ? b.from : (stats.histogram.buckets[0] ? stats.histogram.buckets[0].t : now - 86400e3);
    histBuckets = bucketTimes(from, b.to != null ? b.to : now, ms).map((t) => by.get(t) || { t, error: 0, warn: 0, info: 0, debug: 0 });
    const max = Math.max(1, ...histBuckets.map((x) => x.error + x.warn + x.info + x.debug));
    histBuckets.forEach((x, i) => {
      const total = x.error + x.warn + x.info + x.debug;
      const label = T('lg.hist_bar', { time: fmtShort(x.t), error: x.error, warn: x.warn, info: x.info, debug: x.debug });
      const bar = el('button', { type: 'button', class: 'lg-bar' + (total ? '' : ' lg-bar-empty'), 'data-i': i, 'aria-label': label, title: label });
      ['error', 'warn', 'info', 'debug'].forEach((lv) => {
        if (x[lv]) bar.append(el('span', { class: 'lg-bseg lg-bseg-' + lv, style: 'height:' + Math.max(2, Math.round((x[lv] / max) * 100)) + '%' }));
      });
      plot.append(bar);
    });
    const ticks = Math.min(7, histBuckets.length);
    for (let i = 0; i < ticks; i++) {
      const idx = Math.round((i / Math.max(1, ticks - 1)) * (histBuckets.length - 1));
      const t = histBuckets[idx] ? histBuckets[idx].t : from;
      const long = i === 0 || i === ticks - 1 || ms >= 86400e3;
      axis.append(el('span', { text: long ? fmtShort(t) : fmtTime(t, { hour: '2-digit', minute: '2-digit' }) }));
    }
  }
  (function brush() {
    const plot = $('lg-hist');
    const box = $('lg-hist-brush');
    let start = null;
    let moved = false;
    const idxAt = (x) => {
      const r = plot.getBoundingClientRect();
      const f = Math.min(0.9999, Math.max(0, (x - r.left) / r.width));
      return Math.floor(f * histBuckets.length);
    };
    const pick = (i, j) => {
      const ms = stats && stats.histogram ? stats.histogram.bucketMs : 0;
      if (!histBuckets[i] || !histBuckets[j] || !ms) return;
      setState({ range: 'custom', from: histBuckets[i].t, to: histBuckets[j].t + ms - 1 });
    };
    plot.addEventListener('pointerdown', (e) => {
      if (!histBuckets.length || e.button !== 0 || e.pointerType === 'touch') return;
      start = e.clientX;
      moved = false;
    });
    plot.addEventListener('pointermove', (e) => {
      if (start == null) return;
      if (Math.abs(e.clientX - start) > 6) moved = true;
      if (!moved) return;
      const r = plot.getBoundingClientRect();
      const a = Math.max(0, Math.min(start, e.clientX) - r.left);
      const b = Math.min(r.width, Math.max(start, e.clientX) - r.left);
      box.hidden = false;
      box.style.left = a + 'px';
      box.style.width = (b - a) + 'px';
    });
    const end = (e) => {
      if (start == null) return;
      const s = start;
      start = null;
      box.hidden = true;
      if (moved) pick(idxAt(Math.min(s, e.clientX)), idxAt(Math.max(s, e.clientX)));
    };
    plot.addEventListener('pointerup', end);
    plot.addEventListener('pointerleave', (e) => { if (start != null && moved) end(e); });
    // Click (mouse, touch, keyboard Enter/Space on the focused bar): that slot.
    plot.addEventListener('click', (e) => {
      if (moved) { moved = false; return; }
      const bar = e.target.closest('.lg-bar');
      if (bar) pick(Number(bar.dataset.i), Number(bar.dataset.i));
    });
  })();

  // ─── Filter column ───────────────────────────────────────────────────────

  function facetRow(o) {
    const cb = el('input', { type: 'checkbox', checked: o.checked, disabled: o.disabled, 'data-facet': o.facet, value: o.value, on: { change: o.change } });
    return el('label', { class: 'lg-fr' + (o.disabled ? ' lg-fr-off' : '') }, [cb, o.label, el('span', { class: 'lg-fc', text: o.count == null ? '' : num(o.count) })]);
  }

  function toggle(arr, v, on) {
    const s = new Set(arr);
    if (on) s.add(v); else s.delete(v);
    return Array.from(s);
  }

  function paintFilters() {
    const c = stats ? stats.counts : null;
    const lv = $('lg-f-levels');
    clear(lv);
    LEVELS.forEach((l) => lv.append(facetRow({ facet: 'level', value: l, checked: state.levels.includes(l), label: levelBadge(l),
      count: c ? c.levels[l] : null, change: (e) => setState({ levels: LEVELS.filter((x) => (x === l ? e.target.checked : state.levels.includes(x))) }) })));
    const sv = $('lg-f-sources');
    clear(sv);
    allowedSources().forEach((s) => sv.append(facetRow({ facet: 'source', value: s, checked: state.sources.includes(s), label: el('span', { text: T('lg.src_' + s) }),
      count: c ? c.sources[s] : null, change: (e) => setState({ sources: SOURCES.filter((x) => (x === s ? e.target.checked : state.sources.includes(x))) }) })));
    const pv = $('lg-f-plugins');
    clear(pv);
    $('lg-f-plugins-box').hidden = !meta.sources.includes('plugins');
    const plist = c ? c.plugins.slice() : [];
    state.plugins.forEach((id) => { if (!plist.some((p) => p.id === id)) plist.push({ id, name: id, count: 0 }); });
    if (!plist.length) pv.append(el('p', { class: 'lg-faint lg-small', text: T('lg.f_no_plugins') }));
    (pluginsOpen ? plist : plist.slice(0, 5)).forEach((p) => pv.append(facetRow({ facet: 'plugin', value: p.id, checked: state.plugins.includes(p.id),
      label: el('span', { text: p.name }), count: p.count, change: (e) => setState({ plugins: toggle(state.plugins, p.id, e.target.checked) }) })));
    if (plist.length > 5) {
      pv.append(el('button', { type: 'button', class: 'lg-link', text: pluginsOpen ? T('lg.f_less') : T('lg.f_more', { n: plist.length - 5 }),
        on: { click: () => { pluginsOpen = !pluginsOpen; paintFilters(); } } }));
    }
    paintSavedFacet();
    paintChips();
    ['lg-search', 'lg-search-m'].forEach((id) => { if (doc.activeElement !== $(id)) $(id).value = state.q; });
  }

  function paintSavedFacet() {
    const box = $('lg-f-saved');
    clear(box);
    const filters = savedViews.filter((v) => v.kind === 'filter');
    if (!filters.length) box.append(el('p', { class: 'lg-faint lg-small', text: T('lg.f_saved_none') }));
    filters.forEach((v) => box.append(el('button', { type: 'button', class: 'lg-saved-link', text: v.name, on: { click: () => applySaved(v) } })));
  }

  function chip(text, onRemove, label) {
    return el('span', { class: 'lg-chip' }, [text, el('button', { type: 'button', 'aria-label': label || T('lg.chip_remove', { v: text }), on: { click: onRemove } }, [icon(I_X, 12)])]);
  }

  function filterCount() {
    let n = 0;
    if (state.levels.join(',') !== DEFAULTS.levels.join(',')) n += 1;
    if (state.sources.join(',') !== DEFAULTS.sources.join(',')) n += 1;
    if (state.plugins.length) n += 1;
    if (state.q) n += 1;
    if (state.problem) n += 1;
    if (state.range === 'custom') n += 1;
    return n;
  }

  function paintChips() {
    const box = $('lg-chips');
    clear(box);
    if (state.levels.length < LEVELS.length) {
      box.append(chip(T('lg.chip_level', { v: state.levels.map((l) => T('lg.level_' + l)).join(', ') || '–' }), () => setState({ levels: LEVELS.slice() })));
    }
    const allowed = allowedSources();
    if (allowed.some((s) => !state.sources.includes(s))) {
      box.append(chip(T('lg.chip_source', { v: state.sources.map((s) => T('lg.src_' + s)).join(', ') || '–' }), () => setState({ sources: allowed })));
    }
    if (state.plugins.length) box.append(chip(T('lg.chip_plugin', { v: state.plugins.join(', ') }), () => setState({ plugins: [] })));
    if (state.q) box.append(chip(T('lg.chip_q', { v: state.q }), () => setState({ q: '' })));
    if (state.problem) box.append(chip(T('lg.chip_problem', { v: state.problem.replace(/^[chm]:/, '') }), () => setState({ problem: '' })));
    if (state.range === 'custom') {
      box.append(chip(fmtShort(state.from) + ' – ' + (state.to != null ? fmtShort(state.to) : '…'), () => setState({ range: DEFAULTS.range, from: null, to: null }), T('lg.chip_range_reset')));
    }
    if (box.firstChild) {
      box.append(el('button', { type: 'button', class: 'lg-link', text: T('lg.clear_all'),
        on: { click: () => setState({ range: DEFAULTS.range, from: null, to: null, levels: LEVELS.slice(), sources: allowedSources(), plugins: [], q: '', problem: '' }) } }));
    }
    const n = filterCount();
    const dot = $('lg-filter-count');
    dot.hidden = !n;
    dot.textContent = String(n);
    $('lg-mobile-summary').textContent = [T('lg.range_' + state.range), state.levels.map((l) => T('lg.level_' + l)).join(', '),
      state.sources.map((s) => T('lg.src_' + s)).join(', '), stats ? (stats.total === 1 ? T('lg.count_one') : T('lg.count', { n: num(stats.total) })) : '']
      .filter(Boolean).join(' · ');
  }

  function paintCount() {
    $('lg-count').textContent = stats ? (stats.total === 1 ? T('lg.count_one') : T('lg.count', { n: num(stats.total) })) : '';
    paintChips();
  }

  let searchTimer = null;
  function onSearch(e) {
    const v = e.target.value;
    win.clearTimeout(searchTimer);
    searchTimer = win.setTimeout(() => { if (v.trim() !== state.q) setState({ q: v.trim() }); }, 350);
  }
  $('lg-search').addEventListener('input', onSearch);
  $('lg-search-m').addEventListener('input', onSearch);
  $('lg-collapse').addEventListener('change', () => paintRows());

  function applySaved(v) {
    closeSheet();
    detailId = null;
    showTab('events', { keepHash: true });
    setState(parseState(v.data && v.data.state ? v.data.state : ''));
  }
  $('lg-save-filter').addEventListener('click', async () => {
    if (!D) return;
    const name = await D.prompt({ title: T('lg.f_save_title'), label: T('lg.f_save_label'), maxLength: 80 });
    if (!name) return;
    try {
      await api('POST', '/api/v1/logs/saved', { kind: 'filter', name, data: { state: stateQuery(state) } });
      toast(T('lg.sv_saved'));
      await fetchSaved();
      paintSavedFacet();
    } catch (err) { toast(err.message, 'error'); }
  });

  // ─── Event list ──────────────────────────────────────────────────────────

  async function loadEvents(reset) {
    if (loading && !reset) return;
    const gen = reset ? ++generation : generation;
    loading = true;
    $('lg-rows').setAttribute('aria-busy', 'true');
    try {
      const r = await api('GET', '/api/v1/logs/events?' + apiQuery(state, Date.now(), { limit: PAGE, before: reset ? null : next }));
      if (gen !== generation) return;
      entries = reset ? r.entries : entries.concat(r.entries);
      next = r.next;
      paintRows();
    } catch (err) {
      if (gen !== generation) return;
      const rows = $('lg-rows');
      clear(rows);
      rows.append(el('div', { class: 'lg-empty', role: 'alert' }, [el('p', { text: T('lg.error_load') + ' ' + err.message }),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('lg.retry'), on: { click: () => reloadEvents() } })]));
    } finally {
      if (gen === generation) {
        loading = false;
        $('lg-rows').setAttribute('aria-busy', 'false');
      }
    }
  }

  function rowNode(row) {
    const e = row.entry;
    const isSel = row.ids.every((id) => selected.has(id));
    const titled = e.source === 'server' && e.code && I18N['lg.code.' + e.code + '.title'];
    const cb = el('input', { type: 'checkbox', checked: isSel, 'aria-label': T('lg.select_row') + ': ' + e.msg,
      on: { change: (ev) => {
        row.ids.forEach((id) => (ev.target.checked ? selected.add(id) : selected.delete(id)));
        ev.target.closest('.lg-row').classList.toggle('lg-row-sel', ev.target.checked);
        paintSelection();
      } } });
    return el('div', { class: 'lg-row lg-row-' + e.level + (isSel ? ' lg-row-sel' : ''), role: 'listitem', 'data-id': e.id, 'data-level': e.level, 'data-source': e.source }, [
      cb,
      el('span', { class: 'lg-mono lg-time', text: fmtTime(e.ts) }),
      levelBadge(e.level),
      el('span', { class: 'lg-src', text: sourceLabel(e) }),
      el('a', { class: 'lg-msg', href: '#e/' + encodeURIComponent(e.id), on: { click: (ev) => { ev.preventDefault(); openEntry(e.id); } } }, [
        el('span', { class: 'lg-m1', text: titled ? codeTitle(e.code, e.msg) : e.msg }),
        el('span', { class: 'lg-m2', text: [titled ? e.msg : '', e.ctx].filter(Boolean).join(' · ') }),
      ]),
      el('span', { class: 'lg-mono lg-n lg-r', text: row.n > 1 ? '×' + row.n : '' }),
    ]);
  }

  function clusterNode(c) {
    const secs = Math.max(1, Math.round((c.to - c.from) / 1000));
    return el('div', { class: 'lg-cluster', role: 'listitem' }, [
      icon(I_CLOCK, 14),
      el('span', null, [el('b', { text: fmtClock(c.from) + (c.to - c.from >= 1000 ? ' – ' + fmtClock(c.to) : '') }), ' · ', T('lg.cluster', { n: c.n, k: c.sources, s: secs })]),
      el('button', { type: 'button', class: 'lg-link lg-cluster-go', text: T('lg.cluster_view'),
        on: { click: () => setState({ range: 'custom', from: c.from - 1000, to: c.to + 1000, levels: LEVELS.slice(), sources: allowedSources(), plugins: [], q: '', problem: '' }) } }),
    ]);
  }

  function paintRows() {
    const box = $('lg-rows');
    clear(box);
    const rows = collapse(entries, $('lg-collapse').checked);
    if (!rows.length) {
      const empty = el('div', { class: 'lg-empty', role: 'listitem' }, [el('p', { class: 'lg-empty-title', text: T('lg.empty') }), el('p', { class: 'lg-faint', text: T('lg.empty_hint') })]);
      if (state.levels.length < LEVELS.length) {
        empty.append(el('button', { type: 'button', class: 'btn btn-sm', text: T('lg.empty_all_levels'), on: { click: () => setState({ levels: LEVELS.slice() }) } }));
      }
      box.append(empty);
    }
    const starts = new Map(clusters(rows).map((c) => [c.start, c]));
    const frag = doc.createDocumentFragment();
    rows.forEach((row, i) => {
      if (starts.has(i)) frag.append(clusterNode(starts.get(i)));
      frag.append(rowNode(row));
    });
    box.append(frag);
    box.setAttribute('role', 'list');
    $('lg-more').hidden = !next;
    $('lg-more-text').textContent = next ? T('lg.more_auto') : (entries.length ? T('lg.end') : '');
    paintSelection();
  }

  function paintSelection() {
    const n = selected.size;
    $('lg-selbar').hidden = !n;
    $('lg-sel-n').textContent = T('lg.sel_count', { n: num(n) });
    const all = $('lg-select-all');
    const ids = entries.map((e) => e.id);
    all.checked = ids.length > 0 && ids.every((id) => selected.has(id));
    all.indeterminate = n > 0 && !all.checked;
  }
  $('lg-select-all').addEventListener('change', (e) => {
    entries.forEach((x) => (e.target.checked ? selected.add(x.id) : selected.delete(x.id)));
    paintRows();
  });
  $('lg-sel-clear').addEventListener('click', () => { selected.clear(); paintRows(); });
  $('lg-sel-copy').addEventListener('click', async () => {
    const lines = entries.filter((e) => selected.has(e.id)).map(textLine).join('\n');
    try { await win.navigator.clipboard.writeText(lines); toast(T('lg.copied')); } catch { toast(T('lg.copy_failed'), 'error'); }
  });
  $('lg-sel-same').addEventListener('click', () => {
    const ts = entries.filter((e) => selected.has(e.id)).map((e) => e.ts);
    if (!ts.length) return;
    setState({ range: 'custom', from: Math.min(...ts) - 10000, to: Math.max(...ts) + 10000, levels: LEVELS.slice(), sources: allowedSources(), plugins: [], q: '', problem: '' });
  });
  $('lg-sel-export').addEventListener('click', () => openExport({ scope: 'selection' }));
  $('lg-more').addEventListener('click', () => loadEvents(false));
  if (win.IntersectionObserver) {
    new win.IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting) && next && !loading && tab === 'events' && !detailId) loadEvents(false);
    }, { rootMargin: '400px' }).observe($('lg-sentinel'));
  }

  // ─── Entry detail ────────────────────────────────────────────────────────

  function openEntry(id) {
    if (tab !== 'events') showTab('events', { keepHash: true });
    detailId = id;
    writeHash();
    showDetail(id);
  }

  async function showDetail(id) {
    const box = $('lg-detail');
    const main = $('lg-events-main');
    if (!id) {
      box.hidden = true;
      main.hidden = false;
      clear(box);
      return;
    }
    main.hidden = true;
    box.hidden = false;
    clear(box);
    box.append(el('p', { class: 'lg-faint lg-pad', text: T('lg.loading') }));
    let r;
    try {
      r = await api('GET', '/api/v1/logs/events/item?id=' + encodeURIComponent(id));
    } catch (err) {
      if (detailId !== id) return;
      clear(box);
      box.append(detailNav(null), el('div', { class: 'lg-card lg-pad', role: 'alert' }, [el('p', { text: err.status === 404 ? T('lg.d_gone') : err.message })]));
      return;
    }
    if (detailId !== id) return;
    renderDetail(r.entry, r.problem);
  }

  function detailNav(e) {
    const idx = e ? entries.findIndex((x) => x.id === e.id) : -1;
    const go = (i) => { if (entries[i]) openEntry(entries[i].id); };
    return el('nav', { class: 'lg-crumb', 'aria-label': T('lg.d_path') }, [
      el('a', { href: '#events', class: 'lg-link', text: T('lg.d_back'), on: { click: (ev) => { ev.preventDefault(); detailId = null; writeHash(); showDetail(null); if (!entries.length) reloadEvents(); } } }),
      e ? el('span', { 'aria-hidden': 'true', text: '›' }) : null,
      e ? el('span', { text: fmtTime(e.ts) + ' · ' + sourceLabel(e) }) : null,
      el('span', { class: 'lg-crumb-end' }, [
        el('button', { type: 'button', class: 'btn btn-sm', 'aria-label': T('lg.d_prev'), title: T('lg.d_prev'), disabled: idx <= 0, on: { click: () => go(idx - 1) } }, [icon(I_LEFT, 16)]),
        el('button', { type: 'button', class: 'btn btn-sm', 'aria-label': T('lg.d_next'), title: T('lg.d_next'), disabled: idx < 0 || idx >= entries.length - 1, on: { click: () => go(idx + 1) } }, [icon(I_RIGHT, 16)]),
      ]),
    ]);
  }

  function addToSearch(text) {
    setState({ q: state.q ? state.q + ' ' + text : text, levels: LEVELS.slice(), sources: allowedSources() });
  }

  function renderDetail(e, problem) {
    const box = $('lg-detail');
    clear(box);
    const known = e.code && I18N['lg.code.' + e.code + '.text'];
    const card = el('section', { class: 'lg-card lg-pad lg-dcard', 'aria-labelledby': 'lg-d-title' }, [
      el('div', { class: 'lg-dmeta' }, [levelBadge(e.level),
        el('span', { class: 'lg-src', text: e.source === 'plugins' ? T('lg.src_plugins') + ' · ' + sourceLabel(e) : sourceLabel(e) }),
        el('span', { class: 'lg-mono', text: fmtFull(e.ts) })]),
      el('h2', { class: 'lg-dtitle', id: 'lg-d-title', tabindex: '-1', text: e.msg || '–' }),
    ]);
    if (known || problem) {
      const ex = el('div', { class: 'lg-explain' });
      if (known) ex.append(el('h3', { class: 'lg-explain-h', text: T('lg.d_explain') }), el('p', { text: I18N['lg.code.' + e.code + '.text'] }));
      if (problem && meta.admin) {
        ex.append(el('a', { class: 'lg-link', href: '#problems/' + encodeURIComponent(problem.key), text: T('lg.d_problem', { title: codeTitle(e.code, e.msg) }),
          on: { click: (ev) => { ev.preventDefault(); openProblem(problem.key); } } }));
      }
      if (ex.firstChild) card.append(ex);
    }
    const fields = el('div', { class: 'lg-fields' }, [el('div', { class: 'lg-fields-head' }, [el('h3', { class: 'lg-fh', text: T('lg.d_fields') }), el('span', { class: 'lg-faint lg-small', text: T('lg.d_fields_hint') })])]);
    const rows = [[T('lg.d_source'), sourceLabel(e), 'source:' + e.source], [T('lg.d_time_utc'), e.time, null]];
    if (e.code) rows.push([T('lg.d_code'), e.code, 'code:' + e.code]);
    flatFields(e.fields).forEach((p) => rows.push([p[0], String(p[1]), fieldFilter(p[0], p[1])]));
    rows.forEach((r) => fields.append(el('div', { class: 'lg-fieldrow' }, [el('span', { class: 'lg-faint', text: r[0] }), el('span', { class: 'lg-mono lg-break', text: r[1] }),
      r[2] ? el('button', { type: 'button', class: 'lg-icon-btn', 'aria-label': T('lg.d_as_filter', { v: r[2] }), title: T('lg.d_as_filter', { v: r[2] }), on: { click: () => addToSearch(r[2]) } }, [icon(I_FUNNEL, 16)]) : el('span')])));
    card.append(fields);
    card.append(el('details', { class: 'lg-raw' }, [el('summary', { text: T('lg.d_raw') }), el('pre', { class: 'lg-pre', text: JSON.stringify(e.raw, null, 2) })]));
    card.append(el('div', { class: 'lg-actions' }, [
      el('button', { type: 'button', class: 'btn', text: T('lg.d_copy'), on: { click: async () => {
        try { await win.navigator.clipboard.writeText(JSON.stringify(e.raw, null, 2)); toast(T('lg.copied')); } catch { toast(T('lg.copy_failed'), 'error'); }
      } } }),
      el('button', { type: 'button', class: 'btn', text: T('lg.d_link'), on: { click: async () => {
        const url = win.location.origin + '/logs#e/' + encodeURIComponent(e.id);
        try { await win.navigator.clipboard.writeText(url); toast(T('lg.d_link_copied')); } catch { toast(url); }
      } } }),
      el('button', { type: 'button', class: 'btn', text: T('lg.d_export'), on: { click: () => openExport({ scope: 'window', around: e }) } }),
      e.plugin ? el('a', { class: 'btn lg-push', href: '/settings/plugins', text: T('lg.d_plugin') }) : null,
    ]));
    const aside = el('aside', { class: 'lg-card lg-pad lg-same', 'aria-labelledby': 'lg-same-title' });
    box.append(detailNav(e), el('div', { class: 'lg-dgrid' }, [card, aside]));
    renderSame(aside, e, 60);
    $('lg-d-title').focus();
  }

  async function renderSame(aside, e, w) {
    clear(aside);
    const seg = el('div', { class: 'lg-seg', role: 'group', 'aria-label': T('lg.d_window') }, WINDOWS.map((x) =>
      el('button', { type: 'button', class: 'lg-seg-btn', 'aria-pressed': x === w ? 'true' : 'false', text: T('lg.win_' + x), on: { click: () => renderSame(aside, e, x) } })));
    const sub = el('p', { class: 'lg-faint lg-small' });
    const tl = el('ol', { class: 'lg-timeline' });
    aside.append(el('div', { class: 'lg-same-head' }, [el('h2', { class: 'lg-h', id: 'lg-same-title', text: T('lg.d_same') }), seg]), sub, tl,
      el('button', { type: 'button', class: 'btn', text: T('lg.d_window_export'), on: { click: () => openExport({ scope: 'window', around: e, window: w }) } }));
    try {
      const from = e.ts - w * 1000;
      const to = e.ts + w * 1000;
      const r = await api('GET', '/api/v1/logs/events?from=' + from + '&to=' + to + '&limit=300&source=' + allowedSources().join(','));
      const items = r.entries.slice().reverse();
      sub.textContent = T('lg.d_same_sub', { n: num(items.length), from: fmtClock(from), to: fmtClock(to) });
      items.forEach((x) => tl.append(el('li', { class: 'lg-ev' + (x.id === e.id ? ' lg-ev-self' : ''), 'data-level': x.level }, [
        el('span', { class: 'lg-mono', text: fmtClock(x.ts) }),
        el('span', { class: 'lg-dot lg-dot-' + x.level, 'aria-hidden': 'true' }),
        el('span', { class: 'lg-ev-body' }, [
          el('span', { class: 'lg-ev-head' }, [el('span', { class: 'lg-src', text: sourceLabel(x) }), el('span', { class: 'lg-ev-lv lg-tx-' + x.level, text: T('lg.level_' + x.level) })]),
          x.id === e.id ? el('span', { class: 'lg-ev-msg', text: x.msg })
            : el('a', { class: 'lg-ev-msg', href: '#e/' + encodeURIComponent(x.id), text: x.msg, on: { click: (ev) => { ev.preventDefault(); openEntry(x.id); } } }),
          x.ctx ? el('span', { class: 'lg-faint lg-small', text: x.ctx }) : null,
        ]),
      ])));
    } catch (err) {
      sub.textContent = err.message;
    }
  }

  // ─── Problems ────────────────────────────────────────────────────────────

  let pStatus = 'open';
  let currentProblem = null;
  function problemRange() {
    const b = bounds(state, Date.now());
    return (b.from != null ? '&from=' + b.from : '') + (b.to != null ? '&to=' + b.to : '');
  }
  async function loadProblems() {
    const listBox = $('lg-plist');
    clear(listBox);
    listBox.append(el('p', { class: 'lg-faint lg-pad', text: T('lg.loading') }));
    try {
      const r = await api('GET', '/api/v1/logs/problems?status=' + pStatus + '&sort=' + $('lg-p-sort').value + problemRange());
      Object.keys(r.counts).forEach((s) => { const n = doc.querySelector('#lg-p-status [data-count="' + s + '"]'); if (n) n.textContent = num(r.counts[s]); });
      setProblemBadge(r.counts.open);
      clear(listBox);
      if (!r.problems.length) listBox.append(el('p', { class: 'lg-empty', text: T(pStatus === 'open' ? 'lg.p_empty_open' : 'lg.p_empty') }));
      r.problems.forEach((p) => listBox.append(problemRow(p)));
      if (problemKey) showProblem(problemKey);
      else paintProblemEmpty();
    } catch (err) {
      clear(listBox);
      listBox.append(el('p', { class: 'lg-empty', role: 'alert', text: err.message }));
    }
  }

  function setProblemBadge(n) {
    const b = $('lg-problems-badge');
    b.hidden = !n;
    b.textContent = n ? num(n) : '';
  }

  function badgeOf(p) {
    if (p.status === 'muted') return ['muted', T('lg.p_badge_muted', { time: p.mutedUntil ? fmtShort(Date.parse(p.mutedUntil)) : '' })];
    if (p.status === 'resolved') return ['resolved', T('lg.p_badge_resolved')];
    if (p.flags.returned) return ['returned', T('lg.p_badge_returned')];
    if (p.flags.new) return ['new', T('lg.p_badge_new')];
    if (p.flags.quiet) return ['quiet', T('lg.p_badge_quiet', { n: Math.floor((Date.now() - p.lastTs) / 86400e3) })];
    if (p.status === 'watch') return ['watch', T('lg.p_badge_watch')];
    return ['open', T('lg.p_badge_open')];
  }

  function problemTitle(p) { return p.known ? codeTitle(p.code, p.title) : p.title; }
  function srcName(s) { return SOURCES.includes(s) ? T('lg.src_' + s) : s; }

  function problemRow(p) {
    const b = badgeOf(p);
    const max = Math.max(1, ...p.spark);
    const sub = [p.code || T('lg.p_no_code'), p.kinds === 1 ? T('lg.p_kinds_one') : T('lg.p_kinds', { n: p.kinds })].join(' · ');
    return el('button', { type: 'button', class: 'lg-prow lg-prow-' + p.level + (p.key === problemKey ? ' lg-prow-sel' : ''), 'data-key': p.key,
      'aria-pressed': p.key === problemKey ? 'true' : 'false', on: { click: () => openProblem(p.key) } }, [
      levelBadge(p.level),
      el('span', { class: 'lg-pmain' }, [
        el('span', { class: 'lg-ptitle-row' }, [el('span', { class: 'lg-ptitle', text: problemTitle(p) }), el('span', { class: 'lg-st lg-st-' + b[0], text: b[1] })]),
        el('span', { class: 'lg-faint lg-small', text: sub }),
        el('span', { class: 'lg-psrc' }, Object.keys(p.sources).slice(0, 6).map((s) => el('span', { class: 'lg-src', text: srcName(s) }))),
      ]),
      el('span', { class: 'lg-spark', role: 'img', 'aria-label': T('lg.p_spark') }, p.spark.map((v) => el('span', { class: 'lg-bg-' + p.level, style: 'height:' + Math.max(v ? 3 : 1, Math.round((v / max) * 28)) + 'px' }))),
      el('span', { class: 'lg-pcount' }, [el('span', { class: 'lg-pnum', text: num(p.count) }), el('span', { class: 'lg-faint lg-small', text: ago(p.lastTs) })]),
    ]);
  }

  function paintProblemEmpty() {
    const box = $('lg-pdetail');
    clear(box);
    currentProblem = null;
    box.append(el('p', { class: 'lg-faint', text: T('lg.p_select') }));
  }

  function openProblem(key) {
    problemKey = key;
    detailId = null;
    if (tab !== 'problems') { showTab('problems', { keepHash: true }); writeHash(); return; }
    writeHash();
    doc.querySelectorAll('#lg-plist .lg-prow').forEach((n) => {
      const on = n.dataset.key === key;
      n.classList.toggle('lg-prow-sel', on);
      n.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    showProblem(key);
  }

  async function showProblem(key) {
    const box = $('lg-pdetail');
    clear(box);
    box.append(el('p', { class: 'lg-faint', text: T('lg.loading') }));
    let p;
    try {
      p = (await api('GET', '/api/v1/logs/problems/item?key=' + encodeURIComponent(key) + problemRange())).problem;
    } catch (err) {
      if (problemKey !== key) return;
      clear(box);
      box.append(el('p', { role: 'alert', text: err.status === 404 ? T('lg.p_empty') : err.message }));
      return;
    }
    if (problemKey !== key) return;
    currentProblem = p;
    clear(box);
    box.append(el('div', { class: 'lg-phead' }, [levelBadge(p.level), el('h2', { class: 'lg-dtitle', text: problemTitle(p) }),
      el('span', { class: 'lg-mono lg-faint', text: p.code ? '„' + p.code + '“' : p.title })]));
    p.correlations.slice(0, 1).forEach((c) => box.append(el('div', { class: 'lg-corr' }, [el('b', { text: T('lg.p_corr', { title: c.known ? codeTitle(c.code, c.title) : c.title }) }), ' ',
      T('lg.p_corr_text', { hits: c.hits, of: c.of })])));
    box.append(el('div', { class: 'lg-pstats' }, [
      el('div', null, [el('span', { class: 'lg-fh', text: T('lg.p_count') }), el('span', { class: 'lg-pstat', text: num(p.count) })]),
      el('div', null, [el('span', { class: 'lg-fh', text: T('lg.p_first') }), el('span', { class: 'lg-pstat lg-pstat-s', text: fmtShort(p.firstTs) })]),
      el('div', null, [el('span', { class: 'lg-fh', text: T('lg.p_last') }), el('span', { class: 'lg-pstat lg-pstat-s', text: fmtShort(p.lastTs) })]),
    ]));
    const max = Math.max(1, ...Object.values(p.sources));
    box.append(el('div', { class: 'lg-pblock' }, [el('h3', { class: 'lg-fh', text: T('lg.p_affected') })].concat(Object.keys(p.sources).sort((a, c) => p.sources[c] - p.sources[a]).map((s) =>
      el('div', { class: 'lg-aff' }, [el('span', { class: 'lg-aff-name', text: srcName(s) }),
        el('span', { class: 'lg-aff-bar' }, [el('span', { class: 'lg-aff-fill lg-bg-' + p.level, style: 'width:' + Math.round((p.sources[s] / max) * 100) + '%' })]),
        el('span', { class: 'lg-mono lg-r', text: num(p.sources[s]) })])))));
    const statusBtns = [['open', 'lg.p_set_open'], ['watch', 'lg.p_set_watch'], ['resolved', 'lg.p_set_resolved'], ['muted', 'lg.p_set_mute']].map((s) =>
      el('button', { type: 'button', class: 'btn btn-sm lg-state-btn', 'data-state': s[0], 'aria-pressed': p.status === s[0] ? 'true' : 'false', text: T(s[1]),
        on: { click: () => setProblemState(p, { status: s[0] }) } }));
    const notify = el('input', { type: 'checkbox', checked: p.notifyOnReturn, 'aria-describedby': 'lg-p-notify-hint', on: { change: (ev) => setProblemState(p, { notifyOnReturn: ev.target.checked }) } });
    box.append(el('div', { class: 'lg-pblock' }, [el('h3', { class: 'lg-fh', text: T('lg.p_status') }), el('div', { class: 'lg-actions' }, statusBtns),
      el('label', { class: 'lg-check' }, [notify, T('lg.p_notify')]), el('span', { class: 'lg-faint lg-small', id: 'lg-p-notify-hint', text: T('lg.p_notify_hint') })]));
    box.append(el('div', { class: 'lg-pblock' }, [el('h3', { class: 'lg-fh', text: T('lg.p_recent') })].concat(p.samples.slice(0, 5).map((x) =>
      el('a', { class: 'lg-recent', href: '#e/' + encodeURIComponent(x.id), on: { click: (ev) => { ev.preventDefault(); openEntry(x.id); } } }, [
        el('span', { class: 'lg-mono', text: fmtTime(x.ts) }), el('span', { text: sourceLabel(x) + ' · ' + x.msg })])))));
    box.append(el('div', { class: 'lg-actions' }, [
      el('button', { type: 'button', class: 'btn', text: T('lg.p_show_all', { n: num(p.count) }), on: { click: () => {
        problemKey = null;
        showTab('events', { keepHash: true });
        setState({ problem: p.key, levels: ['error', 'warn'], sources: allowedSources(), plugins: [], q: '' });
      } } }),
      el('button', { type: 'button', class: 'btn btn-primary', text: T('lg.p_export'), on: { click: () => openExport({ scope: 'problem', problem: p }) } }),
    ]));
  }

  async function setProblemState(p, patch) {
    try {
      await api('PUT', '/api/v1/logs/problems/state', Object.assign({ key: p.key, title: problemTitle(p) }, patch));
      toast(T('lg.p_saved'));
      loadProblems();
    } catch (err) { toast(err.message, 'error'); }
  }

  $('lg-p-status').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    pStatus = b.dataset.status;
    doc.querySelectorAll('#lg-p-status [data-status]').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    problemKey = null;
    writeHash();
    loadProblems();
  });
  $('lg-p-sort').addEventListener('change', () => loadProblems());

  async function refreshProblemBadge() {
    if (!meta.admin) return;
    try {
      const r = await api('GET', '/api/v1/logs/problems?status=open' + problemRange());
      setProblemBadge(r.counts.open);
    } catch { /* badge stays */ }
  }

  // ─── Access log ──────────────────────────────────────────────────────────

  const access = { page: 1, status: '', q: '' };
  async function loadAccess(reset) {
    if (reset) access.page = 1;
    const b = bounds(state, Date.now());
    const p = ['page=' + access.page, 'limit=100', 'counts=1'];
    if (access.status) p.push('status=' + access.status);
    if (access.q) p.push('q=' + encodeURIComponent(access.q));
    if (b.from != null) p.push('from=' + b.from);
    if (b.to != null) p.push('to=' + b.to);
    const tbody = $('lg-a-rows');
    try {
      const r = await api('GET', '/api/v1/logs/access?' + p.join('&'));
      if (reset) clear(tbody);
      paintAccessChips(r.counts || {});
      $('lg-a-count').textContent = T('lg.a_count', { n: num(r.total) });
      if (!r.entries.length && reset) tbody.append(el('tr', null, [el('td', { colspan: '6', class: 'lg-empty', text: T('lg.a_empty') })]));
      r.entries.forEach((e) => {
        const ts = Date.parse(e.timestamp);
        const lv = e.status >= 500 ? 'error' : e.status >= 400 ? 'warn' : 'info';
        tbody.append(el('tr', null, [
          el('td', { class: 'lg-mono', text: Number.isFinite(ts) ? fmtTime(ts) : '' }),
          el('td', null, [el('span', { class: 'lg-lv lg-lv-' + lv, text: String(e.status) })]),
          el('td', { class: 'lg-mono', text: e.method }),
          el('td', { class: 'lg-break', text: e.host + e.uri }),
          el('td', { class: 'lg-mono', text: e.remote_ip }),
          el('td', { class: 'lg-mono lg-r', text: e.duration + ' ms' }),
        ]));
      });
      $('lg-a-more').hidden = !(r.page < r.totalPages);
    } catch (err) {
      clear(tbody);
      tbody.append(el('tr', null, [el('td', { colspan: '6', role: 'alert', text: err.message })]));
    }
  }
  function paintAccessChips(counts) {
    const box = $('lg-a-status');
    clear(box);
    [['', T('lg.a_all'), counts.total], ['200', '2xx', counts['2xx']], ['300', '3xx', counts['3xx']], ['400', '4xx', counts['4xx']], ['500', '5xx', counts['5xx']]].forEach((c) =>
      box.append(el('button', { type: 'button', class: 'lg-seg-btn', 'aria-pressed': access.status === c[0] ? 'true' : 'false', text: c[1] + (c[2] != null ? ' · ' + num(c[2]) : ''),
        on: { click: () => { access.status = c[0]; loadAccess(true); } } })));
  }
  let aTimer = null;
  $('lg-a-search').addEventListener('input', (e) => {
    win.clearTimeout(aTimer);
    aTimer = win.setTimeout(() => { access.q = e.target.value.trim(); loadAccess(true); }, 350);
  });
  $('lg-a-more').addEventListener('click', () => { access.page += 1; loadAccess(false); });
  function accessExport(format) {
    const b = bounds(state, Date.now());
    const p = ['format=' + format];
    if (access.status) p.push('status=' + access.status);
    if (access.q) p.push('q=' + encodeURIComponent(access.q));
    if (b.from != null) p.push('from=' + b.from);
    download('/api/v1/logs/access/export?' + p.join('&'));
  }
  $('lg-a-csv').addEventListener('click', () => accessExport('csv'));
  $('lg-a-json').addEventListener('click', () => accessExport('json'));
  if (!LICENCE_EXPORT) {
    ['lg-a-csv', 'lg-a-json'].forEach((id) => { $(id).disabled = true; $(id).title = T('lg.a_locked'); });
    $('lg-a-locked').hidden = false;
  }

  function download(url) {
    const a = el('a', { href: url, download: '', style: 'display:none' });
    doc.body.append(a);
    a.click();
    a.remove();
  }

  // ─── Saved views ─────────────────────────────────────────────────────────

  async function fetchSaved() {
    if (!meta.admin) return;
    try { savedViews = (await api('GET', '/api/v1/logs/saved')).saved; } catch { savedViews = []; }
  }
  async function loadSaved() {
    await fetchSaved();
    const f = $('lg-sv-filters');
    const t = $('lg-sv-templates');
    clear(f);
    clear(t);
    const item = (v, apply) => el('li', { class: 'lg-saved-item' }, [
      el('span', { class: 'lg-saved-name' }, [el('b', { text: v.name }),
        el('span', { class: 'lg-faint lg-small lg-break', text: v.kind === 'filter' ? (v.data.state || '–') : [v.data.format, v.data.scope].filter(Boolean).join(' · ') })]),
      apply ? el('button', { type: 'button', class: 'btn btn-sm', text: T('lg.sv_apply'), on: { click: () => applySaved(v) } }) : null,
      el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: T('lg.sv_delete'), on: { click: async () => {
        if (D && !(await D.confirm({ title: T('lg.sv_delete_title', { name: v.name }), message: T('lg.sv_delete_msg'), danger: true }))) return;
        try { await api('DELETE', '/api/v1/logs/saved/' + v.id); toast(T('lg.sv_deleted')); loadSaved(); } catch (err) { toast(err.message, 'error'); }
      } } }),
    ]);
    const filters = savedViews.filter((v) => v.kind === 'filter');
    const templates = savedViews.filter((v) => v.kind === 'export');
    if (!filters.length) f.append(el('li', { class: 'lg-faint', text: T('lg.f_saved_none') }));
    if (!templates.length) t.append(el('li', { class: 'lg-faint', text: T('lg.sv_none_templates') }));
    filters.forEach((v) => f.append(item(v, true)));
    templates.forEach((v) => t.append(item(v, false)));
    paintSavedFacet();
  }

  // ─── Export dialog ───────────────────────────────────────────────────────

  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  let lastWindowEntry = null;

  function openExport(ctx) {
    if (!D) return;
    const c = ctx || {};
    if (c.around) lastWindowEntry = c.around;
    const b = bounds(state, Date.now());
    const x = {
      scope: c.scope || 'view',
      from: b.from, to: b.to,
      levels: state.levels.slice(), sources: state.sources.filter((s) => meta.sources.includes(s)),
      format: 'csv', columns: ['time', 'level', 'source', 'message', 'fields'],
      mask_ip: true, mask_email: true, pseudonymize: false, tz: TZ, note: false,
      window: c.window || 60, problem: c.problem || currentProblem, around: c.around || lastWindowEntry,
    };
    if (x.scope === 'problem' && !x.problem) x.scope = 'view';
    if (x.scope === 'window' && !x.around) x.scope = 'view';
    if (x.scope === 'selection' && !selected.size) x.scope = 'view';
    const dlg = D.dialog({ title: T('lg.x_title'), wide: true });
    dlg.box.classList.add('lg-xbox');
    dlg.body.classList.add('lg-x');
    const left = el('div', { class: 'lg-x-left' });
    const right = el('aside', { class: 'lg-x-right', 'aria-label': T('lg.x_preview') });
    dlg.body.append(left, right);

    const tplSel = el('select', { 'aria-label': T('lg.x_template') }, [el('option', { value: '', text: T('lg.x_template_none') })]
      .concat(savedViews.filter((v) => v.kind === 'export').map((v) => el('option', { value: String(v.id), text: v.name }))));
    tplSel.addEventListener('change', () => {
      const v = savedViews.find((s) => String(s.id) === tplSel.value);
      if (!v) return;
      const d = v.data || {};
      if (d.format) x.format = d.format;
      if (d.columns) x.columns = list(d.columns);
      ['mask_ip', 'mask_email', 'pseudonymize', 'note'].forEach((k) => { if (typeof d[k] === 'boolean') x[k] = d[k]; });
      if (d.levels != null) x.levels = list(d.levels);
      if (d.sources != null) x.sources = list(d.sources).filter((s) => meta.sources.includes(s));
      if (d.tz) x.tz = d.tz === 'utc' ? 'utc' : TZ;
      if (d.scope === 'report' || d.scope === 'view') x.scope = d.scope;
      paint();
    });
    left.append(el('label', { class: 'lg-field lg-x-tpl' }, [el('span', { text: T('lg.x_template') }), tplSel]));

    const scopes = el('div', { class: 'lg-x-scopes' });
    left.append(el('fieldset', { class: 'lg-x-set' }, [el('legend', { class: 'lg-fh', text: T('lg.x_scope') }), scopes]));
    const rangeBox = el('div', { class: 'lg-x-row' });
    left.append(el('div', { class: 'lg-x-set' }, [el('h3', { class: 'lg-fh', text: T('lg.x_range') }), rangeBox]));
    const lvBox = el('div', { class: 'lg-x-toggles', role: 'group', 'aria-label': T('lg.x_levels') });
    const srcBox = el('div', { class: 'lg-x-toggles', role: 'group', 'aria-label': T('lg.x_sources') });
    const lockNote = el('p', { class: 'lg-note lg-small', text: T('lg.x_locked_hint'), hidden: LICENCE_EXPORT });
    left.append(el('div', { class: 'lg-x-cols2' }, [el('div', { class: 'lg-x-set' }, [el('h3', { class: 'lg-fh', text: T('lg.x_levels') }), lvBox]),
      el('div', { class: 'lg-x-set' }, [el('h3', { class: 'lg-fh', text: T('lg.x_sources') }), srcBox, lockNote])]));
    const fmtBox = el('div', { class: 'lg-x-formats', role: 'radiogroup', 'aria-label': T('lg.x_format') });
    left.append(el('div', { class: 'lg-x-set' }, [el('h3', { class: 'lg-fh', text: T('lg.x_format') }), fmtBox]));
    const colBox = el('div');
    const privBox = el('div');
    left.append(el('div', { class: 'lg-x-cols2' }, [el('fieldset', { class: 'lg-x-set' }, [el('legend', { class: 'lg-fh', text: T('lg.x_columns') }), colBox]),
      el('fieldset', { class: 'lg-x-set' }, [el('legend', { class: 'lg-fh', text: T('lg.x_privacy') }), privBox])]));

    const pre = el('pre', { class: 'lg-pre lg-x-pre', tabindex: '0', 'aria-label': T('lg.x_preview') });
    const sum = el('p', { class: 'lg-x-sum', 'aria-live': 'polite' });
    const file = el('p', { class: 'lg-faint lg-small lg-break' });
    const noteCb = el('input', { type: 'checkbox', on: { change: (e) => { x.note = e.target.checked; preview(); } } });
    right.append(el('h3', { class: 'lg-fh', text: T('lg.x_preview') }), pre, el('div', { class: 'lg-x-sumbox' }, [sum, file, el('p', { class: 'lg-faint lg-small', text: T('lg.x_stream') })]),
      el('label', { class: 'lg-check' }, [noteCb, T('lg.x_note')]));

    const goLabel = el('span', { text: T('lg.x_download_plain') });
    const go = el('button', { type: 'button', class: 'btn btn-primary', id: 'lg-x-go' }, [icon(I_DOWN, 16), goLabel]);
    const saveTpl = el('button', { type: 'button', class: 'btn btn-ghost lg-x-savetpl', text: T('lg.x_save_template') });
    dlg.foot.append(saveTpl, el('span', { class: 'lg-push' }), el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: () => dlg.close() } }), go);

    function tog(on, label, click, o) {
      const opt = o || {};
      return el('button', { type: 'button', class: 'lg-tog' + (on ? ' lg-tog-on' : ''), 'aria-pressed': on ? 'true' : 'false', disabled: opt.disabled, title: opt.title,
        on: { click } }, [opt.locked ? icon(I_LOCK, 12) : null, label]);
    }

    function scopeOpt(id, title, sub, enabled, wide) {
      const r = el('input', { type: 'radio', name: 'lg-x-scope', value: id, checked: x.scope === id, disabled: !enabled, on: { change: () => { x.scope = id; paint(); } } });
      return el('label', { class: 'lg-x-opt' + (x.scope === id ? ' lg-x-opt-on' : '') + (enabled ? '' : ' lg-x-opt-off') + (wide ? ' lg-x-wide' : '') }, [r,
        el('span', { class: 'lg-x-ot' }, [el('span', { class: 'lg-x-o1', text: title }), el('span', { class: 'lg-x-o2', text: sub })])]);
    }

    function paint() {
      clear(scopes);
      const selN = selected.size;
      scopes.append(scopeOpt('view', T('lg.x_scope_view'), stats ? T('lg.x_scope_view_sub', { n: num(stats.total) }) : '', true));
      scopes.append(scopeOpt('selection', T('lg.x_scope_selection'), selN ? T('lg.x_scope_selection_sub', { n: num(selN) }) : T('lg.x_scope_selection_none'), selN > 0));
      if (meta.admin) scopes.append(scopeOpt('problem', T('lg.x_scope_problem'), x.problem ? '„' + problemTitle(x.problem) + '“ · ' + num(x.problem.count) + '×' : T('lg.x_scope_problem_none'), !!x.problem));
      scopes.append(scopeOpt('window', T('lg.x_scope_window'), x.around ? T('lg.x_scope_window_sub', { time: fmtTime(x.around.ts), w: T('lg.win_' + x.window) }) : T('lg.x_scope_window_none'), !!x.around));
      if (meta.admin) scopes.append(scopeOpt('report', T('lg.x_scope_report'), T('lg.x_scope_report_sub'), true, true));

      const rangeOn = x.scope === 'view' || x.scope === 'report' || x.scope === 'problem';
      clear(rangeBox);
      const fromIn = el('input', { type: 'datetime-local', value: x.from != null ? toLocalInput(x.from) : '', disabled: !rangeOn, 'aria-label': T('lg.custom_from'),
        on: { change: (e) => { const v = Date.parse(e.target.value); if (Number.isFinite(v)) { x.from = v; paint(); } } } });
      const toIn = el('input', { type: 'datetime-local', value: x.to != null ? toLocalInput(x.to) : '', disabled: !rangeOn, 'aria-label': T('lg.custom_to'),
        on: { change: (e) => { const v = e.target.value ? Date.parse(e.target.value) + 59999 : null; x.to = Number.isFinite(v) ? v : null; paint(); } } });
      rangeBox.append(el('label', { class: 'lg-field' }, [el('span', { text: T('lg.custom_from') }), fromIn]), el('label', { class: 'lg-field' }, [el('span', { text: T('lg.custom_to') }), toIn]));
      ['1h', '24h', '7d', '30d'].forEach((r) => rangeBox.append(tog(x.to == null && x.from != null && Math.abs(Date.now() - RANGES[r] - x.from) < 120e3, T('lg.range_' + r),
        () => { x.from = Date.now() - RANGES[r]; x.to = null; paint(); }, { disabled: !rangeOn })));

      const filterOn = x.scope === 'view';
      clear(lvBox);
      LEVELS.forEach((l) => lvBox.append(tog(x.levels.includes(l), T('lg.level_' + l), () => { x.levels = LEVELS.filter((y) => (y === l ? !x.levels.includes(l) : x.levels.includes(y))); paint(); }, { disabled: !filterOn })));
      clear(srcBox);
      allowedSources().forEach((s) => {
        const locked = !LICENCE_EXPORT && (s === 'activity' || s === 'access');
        if (locked) x.sources = x.sources.filter((y) => y !== s);
        srcBox.append(tog(x.sources.includes(s), T('lg.src_' + s) + (locked ? ' · ' + T('lg.x_locked') : ''),
          () => { x.sources = SOURCES.filter((y) => (y === s ? !x.sources.includes(s) : x.sources.includes(y))); paint(); },
          { disabled: !filterOn || locked, locked, title: locked ? T('lg.x_locked_hint') : null }));
      });
      const report = x.scope === 'report';
      clear(fmtBox);
      [['csv', 'CSV', 'lg.x_fmt_csv'], ['json', 'JSON', 'lg.x_fmt_json'], ['ndjson', 'NDJSON', 'lg.x_fmt_ndjson'], ['log', T('lg.x_fmt_log_name'), 'lg.x_fmt_log']].forEach((f) =>
        fmtBox.append(el('button', { type: 'button', role: 'radio', class: 'lg-fmt' + (x.format === f[0] && !report ? ' lg-fmt-on' : ''), 'aria-checked': x.format === f[0] && !report ? 'true' : 'false',
          disabled: report, 'data-format': f[0], on: { click: () => { x.format = f[0]; paint(); } } }, [el('span', { class: 'lg-x-o1', text: f[1] }), el('span', { class: 'lg-x-o2', text: T(f[2]) })])));
      clear(colBox);
      COLS.forEach((cn) => colBox.append(el('label', { class: 'lg-check' }, [
        el('input', { type: 'checkbox', checked: x.columns.includes(cn), disabled: report, on: { change: (e) => { x.columns = COLS.filter((k) => (k === cn ? e.target.checked : x.columns.includes(k))); preview(); } } }),
        T('lg.x_col_' + cn)])));
      clear(privBox);
      [['mask_ip', 'lg.x_mask_ip'], ['mask_email', 'lg.x_mask_email'], ['pseudonymize', 'lg.x_pseudo']].forEach((p) => privBox.append(el('label', { class: 'lg-check' }, [
        el('input', { type: 'checkbox', checked: x[p[0]], 'data-opt': p[0], on: { change: (e) => { x[p[0]] = e.target.checked; preview(); } } }), T(p[1])])));
      privBox.append(el('h3', { class: 'lg-fh lg-x-tzh', text: T('lg.x_tz') }));
      [[TZ, T('lg.x_tz_local', { tz: TZ })], ['utc', T('lg.x_tz_utc')]].forEach((z) => privBox.append(el('label', { class: 'lg-check' }, [
        el('input', { type: 'radio', name: 'lg-x-tz', checked: x.tz === z[0], on: { change: () => { x.tz = z[0]; preview(); } } }), z[1]])));
      noteCb.checked = x.note;
      preview();
    }

    function query() {
      const p = [];
      const add = (k, v) => { if (v != null && v !== '') p.push(k + '=' + encodeURIComponent(v)); };
      add('scope', x.scope);
      if (x.scope !== 'report') {
        add('format', x.format);
        add('columns', x.columns.join(','));
      }
      add('tz', x.tz);
      if (x.mask_ip) add('mask_ip', '1');
      if (x.mask_email) add('mask_email', '1');
      if (x.pseudonymize) add('pseudonymize', '1');
      if (x.note) add('note', '1');
      if (x.scope === 'view' || x.scope === 'report' || x.scope === 'problem') {
        add('from', x.from);
        add('to', x.to);
      }
      if (x.scope === 'view') {
        if (x.levels.length < LEVELS.length) add('level', x.levels.join(','));
        add('source', x.sources.join(','));
        if (state.plugins.length) add('plugin', state.plugins.join(','));
        add('q', state.q);
        add('problem', state.problem);
      }
      if (x.scope === 'selection') add('ids', Array.from(selected).slice(0, 300).join(','));
      if (x.scope === 'problem' && x.problem) add('problem', x.problem.key);
      if (x.scope === 'window' && x.around) { add('around', x.around.id); add('window', x.window); }
      return p.join('&');
    }

    let pt = null;
    let pgen = 0;
    function preview() {
      win.clearTimeout(pt);
      sum.textContent = T('lg.x_counting');
      go.disabled = true;
      if (x.scope === 'view' && (!x.sources.length || !x.levels.length)) {
        pre.textContent = T('lg.x_preview_empty');
        sum.textContent = T('lg.x_summary', { n: 0, size: fmtBytes(0) });
        file.textContent = '';
        goLabel.textContent = T('lg.x_download_plain');
        return;
      }
      pt = win.setTimeout(async () => {
        const g = ++pgen;
        try {
          const r = await api('GET', '/api/v1/logs/events/export/preview?' + query());
          if (g !== pgen) return;
          if (x.scope === 'report') {
            pre.textContent = T('lg.x_scope_report_sub');
            sum.textContent = T('lg.x_summary_report', { n: num(r.problems) });
            goLabel.textContent = T('lg.x_download_report');
            go.disabled = false;
          } else {
            pre.textContent = r.count ? [r.header].concat(r.lines).filter((l) => l != null).join('\n') + (r.count > r.lines.length ? '\n…' : '') : T('lg.x_preview_empty');
            sum.textContent = T('lg.x_summary', { n: num(r.count), size: fmtBytes(r.bytes) });
            goLabel.textContent = r.count ? T('lg.x_download', { n: num(r.count) }) : T('lg.x_download_plain');
            go.disabled = !r.count;
          }
          file.textContent = T('lg.x_file', { name: r.filename });
        } catch (err) {
          if (g !== pgen) return;
          sum.textContent = T('lg.x_failed') + ': ' + err.message;
          pre.textContent = '';
          go.disabled = true;
        }
      }, 300);
    }

    go.addEventListener('click', () => {
      download('/api/v1/logs/events/export?' + query());
      dlg.close();
    });
    saveTpl.addEventListener('click', async () => {
      const name = await D.prompt({ title: T('lg.x_save_template'), label: T('lg.x_template_name'), maxLength: 80 });
      if (!name) return;
      try {
        await api('POST', '/api/v1/logs/saved', { kind: 'export', name, data: {
          scope: x.scope === 'report' ? 'report' : 'view', format: x.format, columns: x.columns.join(','), levels: x.levels.join(','), sources: x.sources.join(','),
          mask_ip: x.mask_ip, mask_email: x.mask_email, pseudonymize: x.pseudonymize, note: x.note, tz: x.tz === 'utc' ? 'utc' : 'local',
        } });
        toast(T('lg.sv_saved'));
        await fetchSaved();
      } catch (err) { toast(err.message, 'error'); }
    });
    paint();
  }
  $('lg-export-open').addEventListener('click', () => openExport({ scope: tab === 'problems' && currentProblem ? 'problem' : (detailId ? 'window' : 'view') }));

  // ─── Mobile filter sheet ─────────────────────────────────────────────────

  // The sheet lives under <body>: inside the page it would sit below the
  // bottom navigation (stacking context of the app shell).
  doc.body.append($('lg-sheet'));
  let sheetReturn = null;
  function openSheet() {
    const aside = $('lg-filters');
    sheetReturn = { parent: aside.parentNode, next: aside.nextSibling, focus: doc.activeElement };
    $('lg-sheet-box').append(aside);
    $('lg-sheet').hidden = false;
    const first = aside.querySelector('input,button');
    if (first) first.focus();
  }
  function closeSheet() {
    if ($('lg-sheet').hidden || !sheetReturn) return;
    sheetReturn.parent.insertBefore($('lg-filters'), sheetReturn.next);
    $('lg-sheet').hidden = true;
    if (sheetReturn.focus && sheetReturn.focus.focus) sheetReturn.focus.focus();
    sheetReturn = null;
  }
  $('lg-filter-open').addEventListener('click', openSheet);
  $('lg-sheet-done').addEventListener('click', closeSheet);
  $('lg-sheet').addEventListener('click', (e) => { if (e.target === $('lg-sheet')) closeSheet(); });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lg-sheet').hidden) closeSheet(); });

  // ─── Routing + start ─────────────────────────────────────────────────────

  function route() {
    const h = parseHash(win.location.hash);
    if (h.query || (h.tab === 'events' && !h.entry)) state = parseState(h.query);
    state.sources = state.sources.filter((s) => meta.sources.includes(s));
    paintRange();
    detailId = h.entry;
    problemKey = h.problem;
    showTab(h.tab, { keepHash: true });
    if (h.tab === 'events') {
      showDetail(detailId);
      reloadEvents();
    }
    if (h.tab !== 'problems') refreshProblemBadge();
  }
  win.addEventListener('popstate', route);
  win.addEventListener('hashchange', route);

  (async function start() {
    try { meta = await api('GET', '/api/v1/logs/meta'); } catch { /* defaults */ }
    if (meta.serverLog && meta.serverLog.enabled === false) $('lg-server-off').hidden = false;
    if (!meta.admin) {
      ['problems', 'saved'].forEach((t) => { $('lg-tab-' + t).hidden = true; });
      $('lg-save-filter').hidden = true;
    }
    await fetchSaved();
    route();
    doc.addEventListener('gc:activity', () => { if (live && tab === 'events') liveTick(); });
  })();

  return pure;
});
