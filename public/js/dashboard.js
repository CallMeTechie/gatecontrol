'use strict';

// Dashboard (templates/aurora/pages/dashboard.njk).
//
// One coordinated refresh loop: every widget is a job with its own interval;
// a single timer (TICK_MS) runs the jobs that are due. SSE events (events.js
// → gc:*) mark only the affected jobs dirty and run them after a short
// debounce. A job never overlaps itself (a second request while one is in
// flight is folded into one re-run), and the loop pauses while the tab is
// hidden. Strings: the page's JSON island (#db-i18n: dashboard.*, problems.*)
// with window.GC.t as fallback (autoupdate.*, whatsnew.*). DOM is built with
// createElement/textContent only — never innerHTML with data.
(function () {
  var page = document.getElementById('db-page');
  if (!page || !window.GCDashUI || !window.GCOpsUI) return;

  var UI = window.GCDashUI;
  var O = window.GCOpsUI;
  var LANG = page.dataset.lang || (window.GC && GC.language) || 'de';
  var FLEET = page.dataset.fleet === '1';

  var I18N = {};
  try { I18N = JSON.parse(document.getElementById('db-i18n').textContent || '{}') || {}; } catch (_) { I18N = {}; }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function t(key, params) {
    var s = I18N[key] != null ? I18N[key] : (window.GC && GC.t && GC.t[key] != null ? GC.t[key] : key);
    if (params) {
      Object.keys(params).forEach(function (k) {
        var v = params[k] == null ? '' : String(params[k]);
        s = String(s).split('{{' + k + '}}').join(v).split('{' + k + '}').join(v);
      });
    }
    return s;
  }
  function tk(pair) { return pair ? t(pair[0], pair[1]) : ''; }
  function el(tag, props, children) { return O.el(document, tag, props, children); }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    return n;
  }
  function capitalize(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function storageGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch (_) { /* private mode / blocked storage */ } }
  function bytes(v) { return UI.fmtBytes(v, LANG); }
  function rel(v) { return UI.relTime(v, Date.now(), t); }
  function api(url) { return window.api.get(url); }

  // Status + category icons (24×24 stroke paths).
  var ICON = {
    good: 'M5 12l5 5 9-10',
    warn: 'M12 7v6M12 17v.5',
    crit: 'M7 7l10 10M17 7L7 17',
    info: 'M12 11v6M12 7v.5',
    none: 'M7 12h10',
    loading: 'M7 12h10',
    login: 'M15 3h4v18h-4M10 17l5-5-5-5M15 12H3',
    peer: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6',
    route: 'M4 6h10a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8h12',
    security: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    system: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  };
  function iconSvg(name, size, width) {
    var s = svg('svg', { viewBox: '0 0 24 24', width: size || 14, height: size || 14, fill: 'none', stroke: 'currentColor',
      'stroke-width': width || 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    s.appendChild(svg('path', { d: ICON[name] || ICON.none }));
    return s;
  }
  function statusCircle(state, cls, iconName) {
    return el('span', { class: 'db-status-ic ' + (cls || ''), 'data-state': state, 'aria-hidden': 'true' }, [iconSvg(iconName || state, 13, 3)]);
  }
  /** Sets the state of a template status icon (.db-status-ic inside `host`). */
  function setStatusIcon(host, state) {
    var ic = host && host.querySelector('.db-status-ic');
    if (!ic) return;
    ic.dataset.state = state;
    var p = ic.querySelector('path');
    if (p) p.setAttribute('d', ICON[state] || ICON.none);
  }
  function stateLabel(state) { return t('dashboard.state_' + (state === 'loading' ? 'none' : state)); }

  // ─── State ────────────────────────────────────────────────────────────────
  var state = {
    stats: null, problems: null, problemsError: false, gw: null, tls: null, top: null, res: null, au: null, sec: null,
    traffic: null, range: '24h', table: false, cat: 'all', feed: [], lastOk: 0, failures: 0,
  };
  var RANGES = ['1h', '24h', '7d', '30d'];
  var saved = storageGet('gc-dash-range');
  if (RANGES.indexOf(saved) >= 0) state.range = saved;

  // ─── Refresh loop ─────────────────────────────────────────────────────────
  var TICK_MS = 15000;
  var DEBOUNCE_MS = 700;
  var jobs = {};
  function job(name, every, fn) { jobs[name] = { every: every, fn: fn, at: 0, busy: null, again: false }; }
  function run(name) {
    var j = jobs[name];
    if (!j) return Promise.resolve();
    if (j.busy) { j.again = true; return j.busy; }
    j.at = Date.now();
    j.busy = Promise.resolve().then(j.fn).then(function () {
      state.lastOk = Date.now();
      state.failures = 0;
    }, function (err) {
      state.failures += 1;
      console.warn('[dashboard] ' + name + ' failed', err);
    }).then(function () {
      j.busy = null;
      renderLive();
      if (j.again) { j.again = false; return run(name); }
      return undefined;
    });
    return j.busy;
  }
  var timer = null;
  function tick() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (document.hidden) return;
    var now = Date.now();
    Object.keys(jobs).forEach(function (name) {
      var j = jobs[name];
      if (j.every && now - j.at >= j.every - 1000) run(name);
    });
    timer = setTimeout(tick, TICK_MS);
  }
  var dirty = {};
  var dirtyTimer = null;
  function refreshSoon(names) {
    names.forEach(function (n) { dirty[n] = true; });
    if (dirtyTimer) clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(function () {
      dirtyTimer = null;
      if (document.hidden) return; // the next visible tick picks everything up
      var list = Object.keys(dirty);
      dirty = {};
      list.forEach(run);
    }, DEBOUNCE_MS);
  }

  // ─── Live indicator ───────────────────────────────────────────────────────
  function renderLive() {
    var box = $('db-live');
    var text = $('db-live-text');
    if (!box || !text) return;
    if (document.hidden) { box.dataset.state = 'paused'; text.textContent = t('dashboard.live_paused'); return; }
    if (!state.lastOk) {
      box.dataset.state = state.failures ? 'stale' : 'loading';
      text.textContent = state.failures ? t('dashboard.live_offline') : t('dashboard.live_loading');
      return;
    }
    var s = Math.max(0, Math.round((Date.now() - state.lastOk) / 1000));
    var ago = s < 60 ? t('dashboard.live_ago_seconds', { n: s }) : t('dashboard.live_ago_minutes', { n: Math.floor(s / 60) });
    if (state.failures >= 2) {
      box.dataset.state = 'stale';
      text.textContent = t('dashboard.live_stale', { ago: ago });
    } else {
      box.dataset.state = 'live';
      text.textContent = t('dashboard.live_updated', { ago: ago });
    }
  }
  function refreshTimes() {
    Array.prototype.forEach.call(document.querySelectorAll('#db-page time[data-ts]'), function (n) {
      n.textContent = rel(Number(n.dataset.ts));
    });
  }
  var liveTimer = setInterval(function () {
    if (document.hidden) return;
    renderLive();
    if (Math.floor(Date.now() / 1000) % 15 === 0) refreshTimes();
  }, 1000);

  // ─── Headline ─────────────────────────────────────────────────────────────
  function renderHeadline() {
    if (!state.problems && !state.stats) return;
    var h = UI.headline(state.problemsError ? null : state.problems, state.stats, state.gw);
    if (!state.problems && !state.problemsError) h = { title: ['dashboard.title', {}], sub: [] };
    $('db-headline').textContent = tk(h.title);
    var parts = h.sub.map(tk);
    var od = (state.problems && state.problems.on_demand) || [];
    if (od.length && !(state.problems.problems || []).length) parts.push(t(UI.plural('dashboard.sum_on_demand', od.length), { n: od.length }));
    $('db-subline').textContent = parts.length ? capitalize(parts.join(', ')) + '.' : '';
  }

  // ─── Health tiles ─────────────────────────────────────────────────────────
  function renderTile(id, data) {
    var tile = $('db-tile-' + id);
    if (!tile) return;
    var st = data ? data.state : 'none';
    tile.dataset.state = st;
    setStatusIcon(tile, st);
    tile.querySelector('.db-tile-badge').textContent = data ? stateLabel(st) : t('dashboard.state_unknown');
    tile.querySelector('.db-tile-value').textContent = data ? data.value : '—';
    tile.querySelector('.db-tile-sub').textContent = data ? tk(data.sub) : t('dashboard.tile_no_data');
  }
  function renderTiles() {
    if (state.stats !== null) {
      renderTile('tunnel', UI.tunnelTile(state.stats));
      renderTile('routes', UI.routesTile(state.stats, state.problemsError ? null : state.problems));
    }
    if (state.gw !== null) renderTile('gateways', UI.gatewaysTile(state.gw, Date.now(), t));
    if (state.tls !== null) renderTile('certs', UI.certsTile(state.tls));
    if (state.sec !== null) renderTile('check', UI.checkTile(state.sec));
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  job('stats', 15000, function () {
    return api('/api/v1/dashboard/stats').then(function (d) {
      state.stats = d;
      renderStats();
    }, function (err) {
      if (state.stats === null) { state.stats = false; renderTile('tunnel', null); renderTile('routes', null); }
      throw err;
    });
  });
  function renderStats() {
    var d = state.stats;
    if (!d) return;
    renderTiles();
    renderHeadline();
    var tr = d.traffic || {};
    $('db-traffic-rate').textContent = t('dashboard.rate_now', { down: UI.fmtRate(tr.downloadRate, LANG), up: UI.fmtRate(tr.uploadRate, LANG) });
    var c = (d.peers && d.peers.clients) || { online: 0, total: 0 };
    $('db-peers-online').textContent = UI.fmtNumber(c.online, LANG);
    $('db-peers-offline').textContent = UI.fmtNumber(Math.max(0, c.total - c.online), LANG);
    $('db-peers-all').textContent = t('dashboard.peers_all_n', { n: c.total });
    // Topbar WireGuard state and sidebar badges (shared layout).
    var wg = $('wg-status');
    if (wg && d.wireguard && window.GC && GC.setWgState) GC.setWgState(d.wireguard.running);
    var pb = $('peer-count-badge');
    if (pb && d.peers) pb.textContent = d.peers.total;
    var rb = $('route-count-badge');
    if (rb && d.routes) rb.textContent = d.routes.active;
  }

  // ─── Problems ─────────────────────────────────────────────────────────────
  function entryText(e) {
    if (!e) return '';
    if (e.label) return e.label;
    var ports = e.listen ? e.listen + (e.target ? ' → ' + e.target : '') : (e.target || '');
    return (e.proto + (ports ? ' ' + ports : '')).trim();
  }
  function entryTitle(e) {
    var name = entryText(e);
    return e && e.fqdn && e.fqdn !== name ? name + ' · ' + e.fqdn : name;
  }
  function targetText(e) {
    if (!e) return '';
    if (e.lan_host) return e.lan_host + (e.target ? ':' + e.target : '');
    return e.fqdn || entryText(e);
  }
  var ACTION_KEY = {
    gateway_offline: 'dashboard.fix_gateway', entry_down: 'dashboard.fix_entry', tls_failed: 'dashboard.fix_cert',
    tls_paused: 'dashboard.fix_cert', tls_expiring: 'dashboard.fix_cert', update_failed: 'dashboard.fix_update',
    update_rolled_back: 'dashboard.fix_update', backup_failed: 'dashboard.fix_backup', waf_engine_missing: 'dashboard.fix_waf',
  };
  function longDate(v) {
    var ts = UI.parseTime(v);
    if (!Number.isFinite(ts)) return '';
    return new Intl.DateTimeFormat(LANG === 'de' ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ts));
  }
  /** → { title, detail: [strings] } per problem kind. */
  function describe(p) {
    switch (p.kind) {
      case 'gateway_offline':
        return {
          title: t('problems.gateway_offline', { name: (p.gateway && p.gateway.name) || '?' }),
          detail: [p.gateway && p.gateway.entries
            ? t(p.gateway.entries === 1 ? 'problems.gateway_offline_detail_one' : 'problems.gateway_offline_detail', { count: p.gateway.entries })
            : t('problems.gateway_offline_none')],
        };
      case 'entry_down': {
        var key = p.reason === 'refused' ? 'problems.entry_refused'
          : p.reason === 'unreachable' ? 'problems.entry_unreachable' : 'problems.entry_unknown';
        var detail = [];
        if (p.reason === 'refused') detail.push(t('problems.detail_refused', { target: targetText(p.entry) }));
        else if (p.reason === 'unreachable') detail.push(t('problems.detail_unreachable', { target: targetText(p.entry) }));
        else detail.push(t('problems.detail_monitor'));
        // Wake-on-LAN: only for a gateway target with the licence, and only
        // when nothing answered at all (S3 §2).
        if (p.reason === 'unreachable' && p.wol && p.wol.licensed) detail.push(p.wol.enabled ? t('problems.wol_on') : t('problems.wol_hint'));
        return { title: t(key, { entry: entryTitle(p.entry) }), detail: detail };
      }
      case 'tls_failed':
      case 'tls_paused': {
        var tls = p.tls || {};
        var d = [];
        if (tls.paused_reason) d.push(String(tls.paused_reason));
        else if (tls.code) d.push(String(tls.code));
        if (tls.max_attempts) d.push(t('problems.tls_attempts', { attempts: tls.attempts || 0, max: tls.max_attempts }));
        return { title: t(p.kind === 'tls_failed' ? 'problems.tls_failed' : 'problems.tls_paused', { host: tls.host || '?' }), detail: d };
      }
      case 'tls_expiring': {
        var x = p.tls || {};
        var ed = [];
        if (x.not_after) ed.push(t('problems.tls_expiring_detail', { date: longDate(x.not_after) }));
        if (x.code) ed.push(t('problems.tls_expiring_renewal', { code: x.code }));
        return { title: t('problems.tls_expiring', { host: x.host || '?' }), detail: ed };
      }
      case 'update_failed':
      case 'update_rolled_back': {
        var u = p.update || {};
        var ud = [];
        if (u.bad_version) ud.push(t('problems.update_detail', { version: 'v' + u.bad_version, running: 'v' + (u.running_version || '?') }));
        if (u.rollback_failed) ud.push(t('problems.update_rollback_failed'));
        return { title: t(p.kind === 'update_failed' ? 'problems.update_failed' : 'problems.update_rolled_back'), detail: ud };
      }
      case 'backup_failed':
        return {
          title: t('problems.backup_failed', { name: (p.backup && p.backup.name) || '?' }),
          detail: [t('problems.backup_detail', { status: (p.backup && p.backup.status) || '?' })],
        };
      case 'waf_engine_missing':
        return { title: t('problems.waf_engine_missing'), detail: [t('problems.waf_engine_detail', { count: (p.waf && p.waf.routes) || 0 })] };
      default:
        return { title: String(p.kind || ''), detail: [] };
    }
  }
  function problemWhen(p) {
    if (p.kind === 'tls_expiring' && p.tls && p.tls.days_left != null) {
      return t(UI.plural('dashboard.in_days', p.tls.days_left), { n: p.tls.days_left });
    }
    var ts = UI.parseTime(p.since);
    return Number.isFinite(ts) ? t('dashboard.since', { dur: UI.duration(ts, Date.now(), t) }) : '';
  }
  function problemRow(p) {
    var d = describe(p);
    var sev = p.severity === 'error' ? 'crit' : p.severity === 'warning' ? 'warn' : 'info';
    var when = problemWhen(p);
    return el('li', { class: 'db-prow', dataset: { kind: p.kind, severity: p.severity, problemId: p.id } }, [
      statusCircle(sev, 'db-status-ic-lg'),
      el('div', { class: 'db-prow-body' }, [
        el('div', { class: 'db-prow-head' }, [
          el('span', { class: 'db-prow-title', text: d.title }),
          el('span', { class: 'db-badge', 'data-state': sev, text: t(sev === 'crit' ? 'dashboard.sev_crit' : sev === 'warn' ? 'dashboard.sev_warn' : 'dashboard.sev_info') }),
        ]),
        d.detail.length ? el('div', { class: 'db-prow-detail', text: d.detail.filter(Boolean).join(' · ') }) : null,
        p.href ? el('div', { class: 'db-prow-actions' }, [
          el('a', { class: 'db-btn db-btn-sm', href: p.href, text: t(ACTION_KEY[p.kind] || 'problems.open') }),
        ]) : null,
      ]),
      when ? el('span', { class: 'db-prow-when', text: when }) : null,
    ]);
  }
  function renderProblems() {
    var card = $('dash-problems');
    var row = $('db-row-main');
    var list = $('dash-problems-list');
    var count = $('dash-problems-count');
    var hint = $('dash-problems-hint');
    var odBox = $('dash-problems-ondemand');
    var odList = $('dash-problems-ondemand-list');
    if (state.problemsError) {
      list.replaceChildren(el('li', { class: 'db-prow db-prow-error' }, [
        statusCircle('warn', 'db-status-ic-lg'),
        el('div', { class: 'db-prow-body' }, [el('div', { class: 'db-prow-title', text: t('problems.load_error') })]),
      ]));
      count.hidden = true; hint.hidden = true; odBox.hidden = true;
      card.hidden = false;
      row.dataset.problems = '1';
      return;
    }
    var data = state.problems || {};
    var problems = data.problems || [];
    var od = data.on_demand || [];
    var summary = data.summary || {};
    list.replaceChildren.apply(list, problems.map(problemRow));
    odList.replaceChildren.apply(odList, od.map(function (p) {
      return el('li', { class: 'db-od-row', dataset: { problemId: p.id, kind: 'on_demand' } }, [
        el('span', { class: 'db-od-text', text: t('problems.on_demand_note', { entry: entryTitle(p.entry) }) }),
        el('a', { class: 'db-link', href: p.href, text: t('problems.open') }),
      ]);
    }));
    odBox.hidden = od.length === 0;
    count.hidden = problems.length === 0;
    count.textContent = String(problems.length);
    count.dataset.state = summary.error ? 'crit' : 'warn';
    var h = summary.access_log === 'unavailable' && problems.some(function (p) { return p.kind === 'entry_down' && !p.reason; })
      ? t('problems.access_log_unavailable') : '';
    hint.hidden = !h;
    hint.textContent = h;
    // No problems: the card disappears and the traffic chart takes the row.
    card.hidden = problems.length === 0;
    row.dataset.problems = problems.length ? '1' : '0';
  }
  job('problems', 30000, function () {
    return api('/api/v1/dashboard/problems').then(function (d) {
      if (!d || d.ok === false) throw new Error('problems: bad answer');
      state.problems = d;
      state.problemsError = false;
    }).then(function () {
      renderProblems(); renderTiles(); renderHeadline();
    }, function (err) {
      state.problemsError = true;
      renderProblems(); renderTiles(); renderHeadline();
      throw err;
    });
  });

  // ─── Traffic chart ────────────────────────────────────────────────────────
  var PERIOD_KEY = { '1h': 'dashboard.period_1h', '24h': 'dashboard.period_24h', '7d': 'dashboard.period_7d', '30d': 'dashboard.period_30d' };
  function syncRangeButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#db-range [data-range]'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.range === state.range ? 'true' : 'false');
    });
    $('db-traffic-period').textContent = t(PERIOD_KEY[state.range]);
  }
  job('traffic', 30000, function () {
    var range = state.range;
    return api('/api/v1/dashboard/traffic?period=' + encodeURIComponent(range)).then(function (d) {
      // A period switch while this request was in flight wins.
      if (range !== state.range) return;
      state.traffic = { period: range, unit: d.unit || 'hour', data: Array.isArray(d.data) ? d.data : [] };
      renderTraffic();
    });
  });

  var chart = { points: [], unit: 'hour', geo: null, idx: null, nodes: null };
  function renderTraffic() {
    var tr = state.traffic;
    var host = $('db-chart');
    host.setAttribute('aria-busy', 'false');
    var points = tr.data;
    var down = 0;
    var up = 0;
    points.forEach(function (p) { down += Number(p.download) || 0; up += Number(p.upload) || 0; });
    $('db-traffic-total').textContent = bytes(down + up);
    $('db-traffic-down').textContent = bytes(down);
    $('db-traffic-up').textContent = bytes(up);
    var empty = down + up === 0;
    $('db-chart-empty').hidden = !empty;
    $('db-legend').hidden = empty;
    chart.points = points;
    chart.unit = tr.unit;
    renderTable(points, tr.unit, down, up);
    applyView(empty);
    if (empty) { host.replaceChildren(); chart.nodes = null; return; }
    var keep = chart.idx;
    var focused = chart.nodes && document.activeElement === chart.nodes.plot;
    buildChart(host, points, tr.unit, down, up);
    // A poll must not take the reader's point away (hover or keyboard).
    if (focused) chart.nodes.plot.focus({ preventScroll: true });
    if (keep != null && keep < points.length) showPoint(keep);
  }
  function applyView(empty) {
    $('db-chart').hidden = state.table || !!empty;
    $('db-table').hidden = !state.table || !!empty;
    var b = $('db-table-toggle');
    b.setAttribute('aria-pressed', state.table ? 'true' : 'false');
    b.textContent = state.table ? t('dashboard.as_chart') : t('dashboard.as_table');
  }
  function renderTable(points, unit, down, up) {
    var body = $('db-table-body');
    var rows = points.map(function (p) {
      return el('tr', null, [
        el('th', { scope: 'row', text: UI.bucketLabel(p.time, unit, LANG, true) }),
        el('td', { class: 'db-num', text: bytes(p.download) }),
        el('td', { class: 'db-num', text: bytes(p.upload) }),
      ]);
    }).reverse();
    body.replaceChildren.apply(body, rows);
    $('db-table-caption').textContent = t('dashboard.chart_summary', { period: t(PERIOD_KEY[state.range]), down: bytes(down), up: bytes(up) });
  }
  function buildChart(host, points, unit, down, up) {
    var W = 720;
    var H = 200;
    var max = 0;
    points.forEach(function (p) { max = Math.max(max, Number(p.download) || 0, Number(p.upload) || 0); });
    var axis = UI.byteTicks(max, LANG, 4);
    var geo = UI.chartGeometry(points, axis.top, W, H);
    var n = points.length;

    var yAxis = el('div', { class: 'db-chart-y', 'aria-hidden': 'true' }, axis.ticks.map(function (tick) {
      var s = el('span', { class: 'db-chart-ytick', text: tick.label });
      s.style.top = (geo.yAt(tick.value) / H * 100) + '%';
      return s;
    }));
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', class: 'db-chart-svg', 'aria-hidden': 'true', focusable: 'false' });
    axis.ticks.forEach(function (tick) {
      var y = geo.yAt(tick.value).toFixed(1);
      s.appendChild(svg('line', { x1: 0, x2: W, y1: y, y2: y, class: 'db-grid', 'vector-effect': 'non-scaling-stroke' }));
    });
    s.appendChild(svg('path', { d: geo.area, class: 'db-area-s1' }));
    s.appendChild(svg('path', { d: geo.down, class: 'db-line db-line-s1', 'vector-effect': 'non-scaling-stroke' }));
    s.appendChild(svg('path', { d: geo.up, class: 'db-line db-line-s2', 'vector-effect': 'non-scaling-stroke' }));
    var cross = svg('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'db-cross', 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
    s.appendChild(cross);

    var dot1 = el('span', { class: 'db-chart-dot db-dot-s1', hidden: true });
    var dot2 = el('span', { class: 'db-chart-dot db-dot-s2', hidden: true });
    var tipLabel = el('div', { class: 'db-tip-title' });
    var tipDown = el('strong', { class: 'db-mono' });
    var tipUp = el('strong', { class: 'db-mono' });
    var tip = el('div', { class: 'db-tip', role: 'status', hidden: true }, [
      tipLabel,
      el('div', { class: 'db-tip-row' }, [el('span', { class: 'db-key db-key-s1', 'aria-hidden': 'true' }), el('span', { text: t('dashboard.download') }), tipDown]),
      el('div', { class: 'db-tip-row' }, [el('span', { class: 'db-key db-key-s2', 'aria-hidden': 'true' }), el('span', { text: t('dashboard.upload') }), tipUp]),
    ]);
    var plot = el('div', {
      class: 'db-chart-plot', tabindex: '0', role: 'group', id: 'db-chart-plot',
      'aria-roledescription': t('dashboard.chart_role'),
      'aria-label': t('dashboard.chart_summary', { period: t(PERIOD_KEY[state.range]), down: bytes(down), up: bytes(up) }) + ' ' + t('dashboard.chart_keys'),
    }, [s, dot1, dot2, tip]);
    var xAxis = el('div', { class: 'db-chart-x', 'aria-hidden': 'true' }, UI.xTickIndices(n, unit, window.innerWidth < 560 ? 4 : 7).map(function (i) {
      var x = el('span', { class: 'db-chart-xtick', text: UI.bucketLabel(points[i].time, unit, LANG, false) });
      x.style.left = ((i + 0.5) / n * 100) + '%';
      if (i === n - 1) x.classList.add('db-chart-xtick-last');
      return x;
    }));
    var frame = el('div', { class: 'db-chart-frame' }, [yAxis, el('div', { class: 'db-chart-main' }, [plot, xAxis])]);
    host.replaceChildren(frame);

    chart.geo = geo;
    chart.nodes = { plot: plot, cross: cross, dot1: dot1, dot2: dot2, tip: tip, tipLabel: tipLabel, tipDown: tipDown, tipUp: tipUp, H: H };
    chart.idx = null;

    function indexAt(clientX) {
      var r = plot.getBoundingClientRect();
      if (!r.width) return null;
      return Math.min(n - 1, Math.max(0, Math.floor((clientX - r.left) / r.width * n)));
    }
    plot.addEventListener('pointermove', function (e) { showPoint(indexAt(e.clientX)); });
    plot.addEventListener('pointerdown', function (e) { showPoint(indexAt(e.clientX)); });
    plot.addEventListener('pointerleave', function () { if (document.activeElement !== plot) hidePoint(); });
    plot.addEventListener('focus', function () { if (chart.idx == null) showPoint(n - 1); });
    plot.addEventListener('blur', hidePoint);
    plot.addEventListener('keydown', function (e) {
      var i = chart.idx != null ? chart.idx : n - 1;
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
      else if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = n - 1;
      else if (e.key === 'Escape') { hidePoint(); return; }
      else return;
      e.preventDefault();
      showPoint(i);
    });
  }
  function showPoint(i) {
    var nd = chart.nodes;
    if (!nd || i == null || !chart.points[i]) return;
    chart.idx = i;
    var p = chart.points[i];
    var n = chart.points.length;
    var x = chart.geo.xAt(i);
    nd.cross.setAttribute('x1', x.toFixed(1));
    nd.cross.setAttribute('x2', x.toFixed(1));
    nd.cross.setAttribute('visibility', 'visible');
    var left = (i + 0.5) / n * 100;
    [[nd.dot1, p.download], [nd.dot2, p.upload]].forEach(function (pair) {
      pair[0].hidden = false;
      pair[0].style.left = left + '%';
      pair[0].style.top = (chart.geo.yAt(pair[1]) / nd.H * 100) + '%';
    });
    nd.tipLabel.textContent = UI.bucketLabel(p.time, chart.unit, LANG, true);
    nd.tipDown.textContent = bytes(p.download);
    nd.tipUp.textContent = bytes(p.upload);
    nd.tip.hidden = false;
    if (left > 60) { nd.tip.style.left = ''; nd.tip.style.right = (100 - left + 2) + '%'; }
    else { nd.tip.style.right = ''; nd.tip.style.left = (left + 2) + '%'; }
  }
  function hidePoint() {
    var nd = chart.nodes;
    if (!nd) return;
    chart.idx = null;
    nd.cross.setAttribute('visibility', 'hidden');
    nd.dot1.hidden = true;
    nd.dot2.hidden = true;
    nd.tip.hidden = true;
  }
  Array.prototype.forEach.call(document.querySelectorAll('#db-range [data-range]'), function (b) {
    b.addEventListener('click', function () {
      if (state.range === b.dataset.range) return;
      state.range = b.dataset.range;
      storageSet('gc-dash-range', state.range);
      chart.idx = null;
      syncRangeButtons();
      $('db-chart').setAttribute('aria-busy', 'true');
      run('traffic');
    });
  });
  $('db-table-toggle').addEventListener('click', function () {
    state.table = !state.table;
    applyView(!$('db-chart-empty').hidden);
  });

  // ─── Peers ────────────────────────────────────────────────────────────────
  job('top', 60000, function () {
    return api('/api/v1/dashboard/top-peers?period=today&limit=5').then(function (d) {
      state.top = d;
      renderTopPeers();
    });
  });
  function renderTopPeers() {
    var d = state.top || {};
    var peers = Array.isArray(d.peers) ? d.peers : [];
    $('db-peers-outdated').textContent = UI.fmtNumber((d.clients && d.clients.below_min) || 0, LANG);
    var max = peers.reduce(function (m, p) { return Math.max(m, p.total || 0); }, 0) || 1;
    var list = $('db-top-peers');
    list.replaceChildren.apply(list, peers.map(function (p) {
      var bar = el('span', { class: 'db-bar' });
      bar.style.width = Math.max(2, (p.total || 0) / max * 100) + '%';
      var online = !!p.online;
      return el('li', { class: 'db-bar-item' }, [
        el('div', { class: 'db-bar-head' }, [
          el('span', { class: 'db-dot', 'data-state': online ? 'good' : 'none', 'aria-hidden': 'true' }),
          el('span', { class: 'db-bar-name', text: p.name }),
          el('span', { class: 'db-sr', text: online ? t('dashboard.online') : t('dashboard.offline') }),
          p.peer_type === 'gateway' ? el('span', { class: 'db-bar-meta', text: t('dashboard.peer_gateway') }) : null,
        ]),
        el('div', { class: 'db-bar-row' }, [
          el('span', { class: 'db-bar-track' }, [bar]),
          el('span', { class: 'db-bar-value', text: bytes(p.total) }),
        ]),
      ]);
    }));
    $('db-top-peers-empty').hidden = peers.length > 0;
  }

  // ─── Gateways ─────────────────────────────────────────────────────────────
  // ?peek=1: the dashboard must not clear the terminal update states the
  // gateways page shows once (GET /gateways side effect).
  job('gateways', 30000, function () {
    return api('/api/v1/gateways?peek=1').then(function (d) {
      state.gw = d;
      renderGateways();
      renderTiles();
      renderHeadline();
    }, function (err) {
      if (state.gw === null) { state.gw = false; renderTile('gateways', null); }
      throw err;
    });
  });
  function timeOf(ms) {
    var d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '—';
    var loc = LANG === 'de' ? 'de-DE' : 'en-GB';
    var sameDay = d.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(loc, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  }
  function renderGateways() {
    var d = state.gw || {};
    var list = Array.isArray(d.gateways) ? d.gateways : [];
    var host = $('db-gw-list');
    host.replaceChildren.apply(host, list.map(function (g) {
      var st = g.status === 'offline' ? 'crit' : g.status === 'degraded' ? 'warn' : 'good';
      var tel = (g.health && g.health.telemetry) || {};
      var version = tel.gateway_version ? 'v' + String(tel.gateway_version).replace(/^v/i, '') : '';
      var routes = Array.isArray(g.routes) ? g.routes.length : 0;
      var parts = [];
      if (st === 'crit') {
        if (g.last_seen_at) parts.push(t('dashboard.gw_last_seen', { time: timeOf(g.last_seen_at) }));
        parts.push(t(UI.plural('dashboard.gw_affected', routes), { n: routes }));
      } else {
        if (g.latest_handshake) parts.push(t('dashboard.gw_handshake', { ago: rel(g.latest_handshake) }));
        var load = Array.isArray(tel.cpu_load_avg) ? tel.cpu_load_avg[0] : null;
        if (load != null && Number.isFinite(Number(load))) parts.push(t('dashboard.gw_load', { load: UI.fmtNumber(load, LANG, 1) }));
        parts.push(t(UI.plural('dashboard.gw_routes', routes), { n: routes }));
      }
      var action = null;
      if (g.update_state === 'updating') {
        action = el('div', { class: 'db-gw-note' }, [statusCircle('info', 'db-status-ic-sm'), el('span', { text: t('dashboard.gw_updating') })]);
      } else if (g.update_state === 'failed') {
        action = el('div', { class: 'db-gw-note' }, [statusCircle('warn', 'db-status-ic-sm'), el('span', { text: t('dashboard.gw_update_failed') })]);
      } else if (FLEET && g.update_available && st !== 'crit') {
        action = el('button', {
          type: 'button', class: 'db-btn db-btn-sm db-btn-accent', dataset: { gwUpdate: String(g.peer_id) },
          text: t('dashboard.gw_update', { v: d.latest_version ? 'v' + String(d.latest_version).replace(/^v/i, '') : '' }),
        });
      }
      return el('li', { class: 'db-gw', dataset: { state: st, peerId: String(g.peer_id) } }, [
        el('div', { class: 'db-gw-head' }, [
          el('span', { class: 'db-dot', 'data-state': st, 'aria-hidden': 'true' }),
          el('a', { class: 'db-gw-name', href: '/gateways#gw/' + encodeURIComponent(g.peer_id), text: g.name }),
          el('span', { class: 'db-badge', 'data-state': st }, [iconSvg(st, 10, 3.2), t(st === 'crit' ? 'dashboard.gw_offline' : st === 'warn' ? 'dashboard.gw_degraded' : 'dashboard.gw_online')]),
          version ? el('span', { class: 'db-gw-version', text: version }) : null,
        ]),
        el('div', { class: 'db-gw-detail', text: parts.join(' · ') }),
        action,
      ]);
    }));
    $('db-gw-empty').hidden = list.length > 0;
  }
  $('db-gw-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-gw-update]');
    if (!b) return;
    var id = b.dataset.gwUpdate;
    var D = window.GCDialog;
    if (!D || !D.confirm) return;
    D.confirm({ message: t('dashboard.gw_update_confirm'), okLabel: t('dashboard.gw_update_ok') }).then(function (ok) {
      if (!ok) return null;
      b.disabled = true;
      return window.api.post('/api/v1/gateways/' + encodeURIComponent(id) + '/update', {}).then(function (j) {
        var queued = j && j.ok !== false && j.reason !== 'cooldown';
        if (window.showToast) window.showToast(queued ? t('dashboard.gw_update_started') : t('dashboard.gw_update_refused'), queued ? 'success' : 'error');
        run('gateways');
      });
    }).catch(function (err) { b.disabled = false; console.warn('[dashboard] gateway update failed', err); });
  });

  // ─── Certificates (tile) ─────────────────────────────────────────────────
  job('tls', 60000, function () {
    return api('/api/v1/tls/status').then(function (d) {
      state.tls = d;
      renderTiles();
    }, function (err) {
      if (state.tls === null) { state.tls = false; renderTile('certs', null); }
      throw err;
    });
  });

  // ─── Server ───────────────────────────────────────────────────────────────
  job('resources', 15000, function () {
    return api('/api/v1/system/resources').then(function (d) {
      state.res = d;
      renderResources();
    });
  });
  function setMeter(id, pct, detail) {
    var m = $('db-meter-' + id);
    if (!m) return;
    var known = pct != null && Number.isFinite(Number(pct));
    var p = known ? Math.min(100, Math.max(0, Math.round(Number(pct)))) : 0;
    var level = known ? UI.meterLevel(p) : 'none';
    m.dataset.level = level;
    m.querySelector('.db-meter-detail').textContent = detail || '';
    var value = known ? p + ' %' : t('dashboard.meter_na');
    if (level === 'warn') value += ' · ' + t('dashboard.meter_tight');
    if (level === 'crit') value += ' · ' + t('dashboard.meter_critical');
    m.querySelector('.db-meter-value').textContent = value;
    var track = m.querySelector('[role="meter"]');
    track.setAttribute('aria-valuenow', String(p));
    track.setAttribute('aria-valuetext', value);
    m.querySelector('.db-meter-fill').style.width = p + '%';
  }
  function renderResources() {
    var d = state.res || {};
    var cpu = d.cpu || {};
    setMeter('cpu', cpu.percent, cpu.cores ? t(UI.plural('dashboard.meter_cores', cpu.cores), { n: cpu.cores }) : '');
    var mem = d.memory || {};
    setMeter('ram', mem.percent, mem.total ? t('dashboard.meter_of', { used: bytes(mem.used), total: bytes(mem.total) }) : '');
    var disk = d.disk;
    setMeter('disk', disk ? disk.percent : null, disk ? t('dashboard.meter_of', { used: bytes(disk.used), total: bytes(disk.total) }) : '');
    $('db-uptime').textContent = d.uptime ? t('dashboard.uptime_since', { time: UI.uptimeText(d.uptime.seconds, t) }) : '';
  }

  // ─── Auto-update (Server card) ────────────────────────────────────────────
  function T(k, d) { var s = t(k); return s === k ? d : s; }
  job('au', 60000, function () {
    return api('/api/system/auto-update').then(function (d) {
      state.au = d;
      renderAutoUpdate(d);
      revealAutoUpdate(d);
    });
  });
  function auAgo(s) {
    if (s == null) return '—';
    return s < 60 ? T('autoupdate.ago_seconds', '{x}s').replace('{x}', s) : T('autoupdate.ago_minutes', '{x}m').replace('{x}', Math.round(s / 60));
  }
  function renderAutoUpdate(d) {
    var box = $('auto-update');
    var st = d.status === 'active' ? 'good' : d.status === 'stale' ? 'crit' : 'warn';
    if (d.last_action === 'failed' || d.mode_mismatch) st = 'crit';
    else if (st === 'good' && d.last_action === 'rolled_back') st = 'warn';
    box.dataset.state = st;
    setStatusIcon(box, st);
    var title = $('db-au-title');
    if (!title.dataset.version) title.dataset.version = title.textContent.trim();
    var version = d.running_version ? 'v' + d.running_version : title.dataset.version;
    var label = d.status === 'active' ? T('autoupdate.active', 'Auto-update active')
      : d.status === 'stale' ? T('autoupdate.stale', 'Cron no longer running?') : T('autoupdate.not_configured', 'Auto-update not set up');
    title.textContent = version + ' · ' + label;
    var sub = [];
    if (d.status === 'active') sub.push(T('autoupdate.last_checked', 'checked {x} ago').replace('{x}', auAgo(d.age_s)));
    sub.push(d.mode === 'manual' ? T('autoupdate.mode_manual', 'Manual') : T('autoupdate.mode_auto', 'Automatic'));
    var win = d.window || {};
    if (win.enabled && win.start && win.end) sub.push(t('dashboard.au_window', { start: win.start, end: win.end }));
    $('db-au-sub').textContent = capitalize(sub.join(' · '));

    var notes = [];
    if (d.last_action === 'failed') {
      // bad_image on a failed marker = update.sh could not roll back either.
      notes.push(['crit', d.bad_image ? T('autoupdate.rollback_failed', 'Update and rollback failed — check the host') : T('autoupdate.failed', 'Last update failed')]);
    } else if (d.last_action === 'rolled_back') {
      var what = d.bad_version ? 'v' + d.bad_version : (d.bad_image ? d.bad_image.replace(/^sha256:/, '').slice(0, 12) : '');
      notes.push(['warn', T('autoupdate.rolled_back', 'Update {x} failed — previous version restored').replace('{x}', what).replace(/\s+/g, ' '),
        T('autoupdate.rolled_back_hint', 'The new image failed its health check. Automatic mode skips it until a newer release is published.')]);
    } else if (d.last_action === 'waiting_window') {
      notes.push(['info', T('autoupdate.waiting_window', 'Update waiting for the maintenance window') + (win.start && win.end ? ' (' + win.start + '–' + win.end + ')' : ''),
        T('autoupdate.waiting_window_hint', 'A new version is ready and will be deployed in the next window. "Update now" deploys it right away.')]);
    }
    if (d.mode_mismatch) notes.push(['crit', T('autoupdate.mismatch', 'Mode mismatch — host update.sh is outdated')]);
    else if (d.mode_pending) notes.push(['info', T('autoupdate.pending', 'Mode applies on the next cron run')]);
    var noteList = $('db-au-notes');
    noteList.replaceChildren.apply(noteList, notes.map(function (n) {
      return el('li', { class: 'db-au-note', 'data-state': n[0], title: n[2] || null }, [
        statusCircle(n[0], 'db-status-ic-sm'),
        el('span', { text: n[1] }),
        n[2] ? el('span', { class: 'db-sr', text: ' ' + n[2] }) : null,
      ]);
    }));

    var btns = [];
    var recheck = el('button', { type: 'button', class: 'db-icon-btn', title: T('autoupdate.recheck', 'Re-check'), 'aria-label': T('autoupdate.recheck', 'Re-check') }, [iconSvg('refresh', 16, 2.2)]);
    recheck.addEventListener('click', function () { run('au'); });
    btns.push(recheck);
    var newsBtn = el('button', { type: 'button', class: 'db-btn db-btn-sm', text: T('autoupdate.version_whats_new', "What's new?") });
    newsBtn.addEventListener('click', function () { loadWhatsNew(true, true); });
    btns.push(newsBtn);
    if (d.status !== 'active') {
      var setup = el('button', { type: 'button', class: 'db-btn db-btn-sm', text: T('autoupdate.setup', 'Set up auto-update') });
      setup.addEventListener('click', openAuSetup);
      btns.push(setup);
    }
    // Manual mode, or Automatic with a maintenance window: "Update now" drops
    // the trigger flag and update.sh deploys without waiting for the window.
    var windowOn = !!(d.window && d.window.enabled);
    if (d.mode === 'manual' || windowOn) {
      var trig = el('button', { type: 'button', class: 'db-btn db-btn-sm db-btn-primary', id: 'au-trigger', text: T('autoupdate.trigger', 'Update now') });
      if (d.mode !== 'manual') trig.title = T('autoupdate.trigger_now_window', 'Deploys the update right away without waiting for the window.');
      if (d.status !== 'active') { trig.disabled = true; trig.title = T('autoupdate.not_configured', 'Auto-update not set up'); }
      trig.addEventListener('click', triggerAuUpdate);
      btns.push(trig);
    }
    var actions = $('db-au-actions');
    actions.replaceChildren.apply(actions, btns);
  }

  // /dashboard#auto-update (fix link of the security check and of the update
  // problem): scroll to the Server card's update block, highlight it and,
  // while auto-update is not set up, open the setup guide.
  var auRevealPending = location.hash === '#auto-update';
  window.addEventListener('hashchange', function () {
    if (location.hash === '#auto-update') { auRevealPending = true; run('au'); }
  });
  function revealAutoUpdate(d) {
    if (!auRevealPending) return;
    auRevealPending = false;
    var box = $('auto-update');
    if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box.focus({ preventScroll: true });
    box.classList.remove('db-flash');
    void box.offsetWidth; // restart the animation
    box.classList.add('db-flash');
    setTimeout(function () { box.classList.remove('db-flash'); }, 2600);
    if (d && d.status !== 'active') openAuSetup();
  }

  // Why a trigger was not queued (autoUpdate.requestUpdate reasons).
  var TRIGGER_REASONS = {
    cooldown: ['autoupdate.trigger_cooldown', 'Just requested — please wait a moment.'],
    stale_no_cron: ['autoupdate.not_configured', 'Auto-update not set up'],
    not_manual_mode: ['autoupdate.trigger_not_manual', 'Only in Manual mode or with a maintenance window.'],
  };
  function triggerAuUpdate() {
    window.api.post('/api/system/auto-update/trigger', {}).then(function (j) {
      var queued = !!(j && j.queued);
      var r = !queued && j && TRIGGER_REASONS[j.reason];
      if (window.showToast) window.showToast(r ? T(r[0], r[1]) : T('autoupdate.trigger_queued', 'Update queued'), queued ? 'success' : 'error');
      run('au');
    }).catch(function (err) { console.warn('[dashboard] triggering update failed', err); });
  }
  function openAuSetup() {
    var body = $('au-setup-body');
    if (!body) return;
    $('au-setup-title').textContent = T('autoupdate.setup_title', 'Set up auto-update');
    body.replaceChildren(
      el('a', { class: 'btn btn-primary', href: '/api/v1/system/update-sh', text: T('autoupdate.download', '⬇ Download update.sh') }),
      el('details', { class: 'db-details' }, [
        el('summary', { text: T('autoupdate.guide', 'Step-by-step guide') }),
        el('pre', { class: 'db-pre', text: '# /etc/cron.d/gatecontrol-update\n*/5 * * * * root /opt/gatecontrol/update.sh' }),
        el('p', { class: 'db-note', text: T('autoupdate.setup_note', 'update.sh must run from /opt/gatecontrol. */5 interval is required. A new image that fails its health check is rolled back automatically.') }),
      ])
    );
    if (window.openModal) window.openModal('au-setup-modal-overlay');
  }
  // The modal closes via the global [data-close-modal] handler in app.js.

  // ─── "Was ist neu" strip (release B §6) ───────────────────────────────────
  // GET /system/whats-new → { current, unseen, sections:[{version,date,groups}] }.
  // Shown only while unseen, or on request ("Alle Neuerungen", version button).
  var news = { current: null, open: false };
  function firstItem(sections) {
    var s = sections && sections[0];
    var items = [];
    ((s && s.groups) || []).forEach(function (g) { (g.items || []).forEach(function (i) { items.push(i); }); });
    return { first: items[0] || null, more: Math.max(0, items.length - 1) };
  }
  function setNewsOpen(open) {
    news.open = open;
    $('whats-new-body').hidden = !open;
    $('whats-new-all').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function loadWhatsNew(all, reveal) {
    var strip = $('whats-new');
    return window.api.get('/api/system/whats-new' + (all ? '?all=1' : '')).then(function (d) {
      if (!d || !d.ok) return;
      news.current = d.current || null;
      if (!all && !d.unseen) { strip.hidden = true; return; }
      var sections = Array.isArray(d.sections) ? d.sections : [];
      if (!all) {
        $('whats-new-badge').textContent = O.fmt(strip.dataset.title || 'New in GateControl {v}', { v: d.current || '' });
        var text = $('whats-new-text');
        var f = firstItem(sections);
        var nodes = f.first ? O.tokenNodes(document, f.first) : [document.createTextNode(T('whatsnew.empty', 'No entries in the changelog.'))];
        if (f.more) nodes.push(document.createTextNode(' ' + t('dashboard.news_more', { n: f.more })));
        text.replaceChildren.apply(text, nodes);
      } else if (strip.hidden) {
        $('whats-new-badge').textContent = strip.dataset.titleAll || "What's new";
        $('whats-new-text').replaceChildren();
      }
      var body = $('whats-new-body');
      body.replaceChildren.apply(body, sections.length
        ? O.whatsNewNodes(document, sections, LANG)
        : [el('p', { class: 'op-empty', text: T('whatsnew.empty', 'No entries in the changelog.') })]);
      setNewsOpen(!!all);
      strip.hidden = false;
      if (reveal && typeof strip.scrollIntoView === 'function') strip.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function () {
      if (reveal && window.showToast) window.showToast(T('whatsnew.load_error', 'Could not load the changes.'), 'error');
    });
  }
  $('whats-new-all').addEventListener('click', function () {
    if (news.open) { setNewsOpen(false); return; }
    loadWhatsNew(true, false);
  });
  $('whats-new-dismiss').addEventListener('click', function () {
    $('whats-new').hidden = true;
    var body = news.current ? { version: news.current } : {};
    window.api.post('/api/system/whats-new/seen', body).catch(function () { /* best-effort; the strip is already gone */ });
  });

  // ─── Activity ─────────────────────────────────────────────────────────────
  // Live: SSE `activity` events are prepended as they arrive; the poll is the
  // fallback for a dead stream and for entries written without an event.
  var FEED_MAX = 8;
  job('activity', 30000, function () {
    var cat = state.cat;
    return api('/api/v1/logs/recent?limit=' + FEED_MAX + (cat !== 'all' ? '&category=' + encodeURIComponent(cat) : '')).then(function (d) {
      if (cat !== state.cat) return;
      state.feed = Array.isArray(d.entries) ? d.entries : [];
      renderFeed();
    });
  });
  var CAT_LABEL = { login: 'dashboard.cat_label_login', peer: 'dashboard.cat_label_peer', route: 'dashboard.cat_label_route', security: 'dashboard.cat_label_security', system: 'dashboard.cat_label_system' };
  function feedItem(e, fresh) {
    var cat = e.category || UI.categoryOf(e.event_type);
    var sev = UI.severityState(e.severity);
    var ts = UI.parseTime(e.created_at);
    var meta = [t(CAT_LABEL[cat] || CAT_LABEL.system)];
    if (e.ip_address) meta.push(e.ip_address);
    return el('li', { class: 'db-act' + (fresh ? ' db-act-new' : ''), dataset: { id: String(e.id), cat: cat, severity: sev } }, [
      el('span', { class: 'db-act-ic', 'data-state': sev, 'aria-hidden': 'true' }, [iconSvg(cat, 14, 2.2)]),
      el('div', { class: 'db-act-body' }, [
        el('div', { class: 'db-act-text', text: e.message || e.event_type }),
        el('div', { class: 'db-act-meta' }, [
          sev === 'warn' || sev === 'crit'
            ? el('span', { class: 'db-badge db-badge-sm', 'data-state': sev }, [iconSvg(sev, 9, 3.4), t(sev === 'crit' ? 'dashboard.sev_error' : 'dashboard.sev_warn')])
            : null,
          el('span', { text: meta.join(' · ') }),
        ]),
      ]),
      Number.isFinite(ts) ? el('time', { class: 'db-act-time', datetime: new Date(ts).toISOString(), dataset: { ts: String(ts) }, text: rel(ts) }) : null,
    ]);
  }
  function renderFeed(freshId) {
    var list = $('activity-feed');
    list.replaceChildren.apply(list, state.feed.map(function (e) { return feedItem(e, freshId != null && String(e.id) === String(freshId)); }));
    $('activity-empty').hidden = state.feed.length > 0;
  }
  document.addEventListener('gc:activity', function (ev) {
    var p = ev.detail || {};
    if (p.id == null) return;
    var entry = { id: p.id, event_type: p.eventType, message: p.message, severity: p.severity, created_at: p.createdAt, ip_address: null };
    entry.category = UI.categoryOf(entry.event_type);
    if (state.cat !== 'all' && entry.category !== state.cat) return;
    if (state.feed.some(function (e) { return String(e.id) === String(entry.id); })) return;
    state.feed = [entry].concat(state.feed).slice(0, FEED_MAX);
    renderFeed(entry.id);
  });
  Array.prototype.forEach.call(document.querySelectorAll('#db-activity-filter [data-cat]'), function (b) {
    b.addEventListener('click', function () {
      if (state.cat === b.dataset.cat) return;
      state.cat = b.dataset.cat;
      Array.prototype.forEach.call(document.querySelectorAll('#db-activity-filter [data-cat]'), function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      run('activity');
    });
  });

  // ─── Security (24 h) ──────────────────────────────────────────────────────
  job('security', 60000, function () {
    return api('/api/v1/dashboard/security-summary').then(function (d) {
      state.sec = d;
      renderSecurity();
      renderTiles();
    }, function (err) {
      if (state.sec === null) { state.sec = false; renderTile('check', null); }
      throw err;
    });
  });
  function subtile(id, data, value, sub) {
    var box = $('db-sec-' + id);
    box.hidden = !data;
    if (!data) return;
    $('db-sec-' + id + '-value').textContent = value;
    $('db-sec-' + id + '-sub').textContent = sub;
  }
  function renderSecurity() {
    var d = state.sec || {};
    var waf = d.waf;
    subtile('waf', waf, waf ? UI.fmtNumber(waf.blocked_24h, LANG) : '', waf
      ? t(UI.plural('dashboard.sec_waf_sub', waf.events_24h), { n: UI.fmtNumber(waf.events_24h, LANG) })
        + (waf.banned_ips ? ' · ' + t(UI.plural('dashboard.sec_waf_bans', waf.banned_ips), { n: waf.banned_ips }) : '')
      : '');
    if (waf) {
      var hourly = Array.isArray(waf.hourly) ? waf.hourly : [];
      $('db-sec-waf-spark').setAttribute('d', UI.sparkPath(hourly, 100, 28));
      $('db-sec-waf-spark-last').setAttribute('d', UI.sparkLast(hourly, 100, 28));
    }
    var lg = d.logins;
    subtile('logins', lg, lg ? UI.fmtNumber(lg.failed_24h, LANG) : '', lg
      ? (lg.locked_accounts ? t(UI.plural('dashboard.sec_locked', lg.locked_accounts), { n: lg.locked_accounts }) : t('dashboard.sec_locked_none'))
      : '');
    var bots = d.bots;
    subtile('bots', bots, bots ? UI.fmtNumber(bots.total, LANG) : '', bots
      ? t(UI.plural('dashboard.sec_bots_sub', bots.routes), { n: bots.routes })
      : '');
    var ph = d.pihole;
    subtile('pihole', ph, ph ? UI.fmtPercent(ph.percent, LANG) : '', ph
      ? t('dashboard.sec_pihole_sub', { n: UI.fmtNumber(ph.total, LANG) })
      : '');

    var row = $('db-sec-check');
    var c = d.check;
    row.hidden = !c;
    if (!c) return;
    var st = c.critical > 0 ? 'crit' : c.fail > 0 ? 'warn' : 'good';
    row.dataset.state = st;
    setStatusIcon(row, st);
    $('db-sec-check-title').textContent = t('dashboard.sec_check_title', { pass: c.pass, total: c.total });
    var open = (c.open || []).map(function (o) { return o.title; });
    $('db-sec-check-sub').textContent = open.length
      ? t('dashboard.sec_check_open_items', { items: open.slice(0, 3).join(' · ') + (open.length > 3 ? ' · …' : '') })
      : t('dashboard.sec_check_all_ok');
  }

  // ─── SSE → only the affected widgets ──────────────────────────────────────
  var SSE = {
    'gc:gateway': ['gateways', 'problems', 'stats'],
    'gc:peer': ['stats', 'top'],
    'gc:monitor': ['problems', 'stats'],
    'gc:tls': ['tls', 'problems'],
    'gc:backup': ['problems'],
    'gc:routes': ['problems', 'stats'],
    'gc:security': ['security', 'problems'],
    'gc:waf': ['security'],
    'gc:pihole': ['security'],
  };
  Object.keys(SSE).forEach(function (ev) {
    document.addEventListener(ev, function () { refreshSoon(SSE[ev]); });
  });
  // After a reconnect the stream may have missed events: refresh everything.
  document.addEventListener('gc:reconnected', function () {
    if (!state.lastOk) return; // the initial connect — the first tick is already running
    refreshSoon(Object.keys(jobs));
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
      renderLive();
    } else {
      tick();
      renderLive();
      refreshTimes();
    }
  });
  window.addEventListener('pagehide', function () {
    if (timer) clearTimeout(timer);
    clearInterval(liveTimer);
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  syncRangeButtons();
  applyView(false);
  loadWhatsNew(false, false);
  tick();

  // Test/debug seam (e2e): run a job now, or all of them.
  window.GCDashboard = {
    run: run,
    refreshAll: function () { return Promise.all(Object.keys(jobs).map(run)); },
    range: function () { return state.range; },
  };
})();
