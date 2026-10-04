'use strict';

// Dashboard UI kit: pure helpers of the dashboard (public/js/dashboard.js) —
// number/byte/rate formatting (de/en), relative times, chart ticks and
// geometry, bucket labels, activity categories, health-tile states and the
// headline. No DOM, no globals: UMD like ops-ui.js, so tests/dashboard_ui.test.js
// can load it in node:test.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GCDashUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ─── Strings ─────────────────────────────────────────────────────────────
  /** "{n} offline" + {n: 2} → "2 offline". */
  function fmt(template, params) {
    let s = template == null ? '' : String(template);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{' + k + '}').join(params[k] == null ? '' : String(params[k])); });
    return s;
  }
  /** Plural key: key_one for 1, key_other otherwise. */
  function plural(key, n) { return key + (Number(n) === 1 ? '_one' : '_other'); }

  // ─── Numbers ─────────────────────────────────────────────────────────────
  function locale(lang) { return lang === 'de' ? 'de-DE' : 'en-GB'; }
  function fmtNumber(n, lang, digits) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const d = digits == null ? 0 : digits;
    return new Intl.NumberFormat(locale(lang), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  }
  function fmtPercent(p, lang) {
    const v = Number(p);
    if (!Number.isFinite(v)) return '—';
    return fmtNumber(v, lang, v > 0 && v < 10 && v % 1 !== 0 ? 1 : 0) + ' %';
  }

  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  /** Index of the binary unit (1024) that keeps `bytes` below 1024. */
  function unitIndex(bytes) {
    let v = Math.abs(Number(bytes) || 0);
    let i = 0;
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
    return i;
  }
  /** 4509715660 → "4,2 GB" (de) / "4.2 GB" (en). One decimal below 10, none above. */
  function fmtBytes(bytes, lang) {
    const b = Number(bytes);
    if (!Number.isFinite(b) || b <= 0) return '0 B';
    const i = unitIndex(b);
    const v = b / Math.pow(1024, i);
    return fmtNumber(v, lang, i > 0 && v < 10 ? 1 : 0) + ' ' + UNITS[i];
  }
  function fmtRate(bytesPerSec, lang) { return fmtBytes(bytesPerSec, lang) + '/s'; }

  // ─── Chart ticks ─────────────────────────────────────────────────────────
  /** Nice step for ~`count` intervals up to `max` (1, 2, 2.5, 5 × 10^k). */
  function niceStep(max, count) {
    const raw = max / (count || 4);
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = [1, 2, 2.5, 5, 10].find((x) => x * p >= raw - 1e-12);
    return f * p;
  }
  /**
   * Y axis for byte values: the unit is chosen from the maximum, the steps
   * are nice numbers IN that unit, so every label shares unit and decimals.
   * → { top (bytes), unit, ticks: [{ value (bytes), label }] } (0 first)
   */
  function byteTicks(maxBytes, lang, count) {
    const max = Math.max(0, Number(maxBytes) || 0);
    if (max === 0) return { top: 1024, unit: 'KB', ticks: [{ value: 0, label: '0' }, { value: 1024, label: '1 KB' }] };
    const i = unitIndex(max);
    const scale = Math.pow(1024, i);
    const step = niceStep(max / scale, count || 4);
    const topScaled = step * Math.ceil(max / scale / step - 1e-9);
    const decimals = step % 1 === 0 ? 0 : (String(step).split('.')[1] || '').length;
    const ticks = [];
    for (let k = 0; k * step <= topScaled + 1e-9; k++) {
      const v = k * step;
      ticks.push({ value: v * scale, label: v === 0 ? '0' : fmtNumber(v, lang, decimals) + ' ' + UNITS[i] });
    }
    return { top: topScaled * scale, unit: UNITS[i], ticks };
  }

  // ─── Times ───────────────────────────────────────────────────────────────
  /**
   * Timestamp → epoch ms. SQLite's 'YYYY-MM-DD HH:MM:SS' is UTC (datetime('now')),
   * ISO strings carry their zone, numbers below 1e12 are epoch seconds.
   */
  function parseTime(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) return Date.parse(s.replace(' ', 'T') + 'Z');
    return Date.parse(s);
  }
  /** A day bucket 'YYYY-MM-DD' as a local calendar date (no zone shift). */
  function parseDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  /**
   * Relative time with the dashboard strings: t(key) → template.
   * Keys: dashboard.ago_now, .ago_seconds, .ago_minutes, .ago_hours, .ago_days ({n}).
   */
  function relTime(v, now, t) {
    const ts = parseTime(v);
    if (!Number.isFinite(ts)) return '';
    const s = Math.max(0, Math.floor(((now == null ? Date.now() : now) - ts) / 1000));
    if (s < 10) return t('dashboard.ago_now');
    if (s < 60) return fmt(t('dashboard.ago_seconds'), { n: s });
    if (s < 3600) return fmt(t('dashboard.ago_minutes'), { n: Math.floor(s / 60) });
    if (s < 86400) return fmt(t('dashboard.ago_hours'), { n: Math.floor(s / 3600) });
    return fmt(t('dashboard.ago_days'), { n: Math.floor(s / 86400) });
  }
  /**
   * Elapsed time without "ago" — for "seit {dur}" / "for {dur}".
   * Keys: dashboard.dur_seconds, .dur_minutes, .dur_hours, .dur_days ({n}).
   */
  function duration(v, now, t) {
    const ts = parseTime(v);
    if (!Number.isFinite(ts)) return '';
    const s = Math.max(0, Math.floor(((now == null ? Date.now() : now) - ts) / 1000));
    if (s < 60) return fmt(t('dashboard.dur_seconds'), { n: s });
    if (s < 3600) return fmt(t('dashboard.dur_minutes'), { n: Math.floor(s / 60) });
    if (s < 86400) return fmt(t('dashboard.dur_hours'), { n: Math.floor(s / 3600) });
    return fmt(t('dashboard.dur_days'), { n: Math.floor(s / 86400) });
  }
  /** Uptime in seconds → "12 Tagen" / "5 Std." style via dashboard.uptime_* keys. */
  function uptimeText(sec, t) {
    const s = Math.max(0, Number(sec) || 0);
    if (s >= 86400) { const n = Math.floor(s / 86400); return fmt(t(plural('dashboard.uptime_days', n)), { n }); }
    if (s >= 3600) { const n = Math.floor(s / 3600); return fmt(t(plural('dashboard.uptime_hours', n)), { n }); }
    const n = Math.max(1, Math.floor(s / 60));
    return fmt(t(plural('dashboard.uptime_minutes', n)), { n });
  }

  /** Axis / tooltip label of a chart bucket in the viewer's local time. */
  function bucketLabel(time, unit, lang, long) {
    const loc = locale(lang);
    if (unit === 'day') {
      const d = parseDay(time) || new Date(parseTime(time));
      if (Number.isNaN(d.getTime())) return '';
      return long
        ? new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short' }).format(d)
        : new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'numeric' }).format(d);
    }
    const ts = parseTime(time);
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    const hm = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    if (!long) return hm;
    if (unit === 'hour') {
      const end = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts + 3600000));
      return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'numeric' }).format(d) + ' ' + hm + '–' + end;
    }
    return hm;
  }

  /** Indices that get an x label: anchored on the newest point, at most ~maxLabels. */
  function xTickIndices(n, unit, maxLabels) {
    if (n <= 0) return [];
    const cap = maxLabels || 7;
    const pref = { minute: [10, 15, 20, 30], hour: [3, 4, 6, 8, 12], day: [1, 2, 5, 7, 10] }[unit] || [1, 2, 5, 10];
    let every = pref.find((e) => Math.ceil(n / e) <= cap) || Math.ceil(n / cap);
    if (n <= cap && unit === 'day') every = 1;
    const out = [];
    for (let i = n - 1; i >= 0; i -= every) out.unshift(i);
    return out;
  }

  /**
   * SVG geometry of the traffic chart in a width × height viewBox: points at
   * bucket centres, y scaled to `top`. → { xAt(i), yAt(v), down, up, area }
   */
  function chartGeometry(points, top, width, height) {
    const n = points.length;
    const W = width || 720;
    const H = height || 200;
    const t = top > 0 ? top : 1;
    const xAt = (i) => (i + 0.5) * W / Math.max(1, n);
    const yAt = (v) => H - (Math.max(0, Number(v) || 0) / t) * H;
    const path = (key) => points.map((p, i) => (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(p[key]).toFixed(1)).join(' ');
    const down = path('download');
    const up = path('upload');
    const area = n ? down + ' L' + xAt(n - 1).toFixed(1) + ' ' + H + ' L' + xAt(0).toFixed(1) + ' ' + H + ' Z' : '';
    return { xAt, yAt, down, up, area, width: W, height: H };
  }

  /** Sparkline path (0..w × 0..h, 1 px inset) of a series; '' without data. */
  function sparkPath(values, w, h) {
    const v = (values || []).map((x) => Math.max(0, Number(x) || 0));
    if (v.length < 2) return '';
    const max = Math.max(1, Math.max.apply(null, v));
    return v.map((x, i) => (i ? 'L' : 'M') + (i / (v.length - 1) * w).toFixed(1) + ' ' + (h - 1 - x / max * (h - 2)).toFixed(1)).join(' ');
  }

  /** The last segment of sparkPath() (the current hour, drawn in the series colour). */
  function sparkLast(values, w, h) {
    const d = sparkPath(values, w, h);
    if (!d) return '';
    const pts = d.split(' L');
    return 'M' + pts[pts.length - 2].replace(/^M/, '') + ' L' + pts[pts.length - 1];
  }

  /** Meter colour level: > 90 % crit, > 70 % warn. */
  function meterLevel(pct) {
    const p = Number(pct) || 0;
    if (p > 90) return 'crit';
    if (p > 70) return 'warn';
    return 'ok';
  }

  // ─── Activity ────────────────────────────────────────────────────────────
  // Same table as src/services/activityCategories.js (tests keep them equal).
  const ACTIVITY_CATEGORIES = {
    login: ['login', 'logout', 'passkey_login', 'account_'],
    peer: ['peer_', 'gateway_', 'client_', 'pool_', 'wg_'],
    route: ['route_', 'routes_', 'host_', 'service_bundle_', 'domain_', 'rdp_route_', 'share_', 'circuit_breaker_'],
    security: ['waf_', 'tls_', 'security_', 'passkey_added', 'passkey_removed', 'password_changed',
      'user_2fa_', 'token_', 'machine_binding_'],
  };
  function categoryOf(eventType) {
    const s = String(eventType || '');
    const names = Object.keys(ACTIVITY_CATEGORIES);
    for (let i = 0; i < names.length; i++) {
      if (ACTIVITY_CATEGORIES[names[i]].some((p) => s.indexOf(p) === 0)) return names[i];
    }
    return 'system';
  }
  /** activity_log severity → status state. */
  function severityState(sev) {
    return { success: 'good', warning: 'warn', error: 'crit' }[sev] || 'info';
  }

  // ─── Health tiles ────────────────────────────────────────────────────────
  // Each returns { state: 'good'|'warn'|'crit'|'none', value, sub: [key, params] }
  // or null when its data is missing (the tile then shows "no data").
  function tunnelTile(stats) {
    if (!stats || !stats.peers) return null;
    const c = stats.peers.clients || { online: stats.peers.online, total: stats.peers.total };
    const running = !!(stats.wireguard && stats.wireguard.running);
    return {
      state: running ? 'good' : 'crit',
      value: (c.online || 0) + ' / ' + (c.total || 0),
      sub: running ? ['dashboard.tile_tunnel_ok', {}] : ['dashboard.tile_tunnel_down', {}],
    };
  }
  function gatewaysTile(gws, now, t) {
    if (!gws || !Array.isArray(gws.gateways)) return null;
    const list = gws.gateways;
    if (!list.length) return { state: 'none', value: '0', sub: ['dashboard.tile_gw_none', {}] };
    const offline = list.filter((g) => g.status === 'offline');
    const degraded = list.filter((g) => g.status === 'degraded');
    const online = list.length - offline.length - degraded.length;
    const value = online + ' / ' + list.length;
    if (offline.length === 1) {
      const g = offline[0];
      return { state: 'crit', value, sub: ['dashboard.tile_gw_one_offline', { name: g.name, dur: duration(g.last_seen_at, now, t) }] };
    }
    if (offline.length > 1) return { state: 'crit', value, sub: ['dashboard.tile_gw_offline', { n: offline.length }] };
    if (degraded.length) return { state: 'warn', value, sub: ['dashboard.tile_gw_degraded', { n: degraded.length }] };
    return { state: 'good', value, sub: ['dashboard.tile_gw_ok', {}] };
  }
  /** Entries that do not answer: entry_down rows + entries behind offline gateways. */
  function unreachableEntries(problems) {
    const list = (problems && problems.problems) || [];
    return list.reduce((n, p) => {
      if (p.kind === 'entry_down') return n + 1;
      if (p.kind === 'gateway_offline') return n + ((p.gateway && p.gateway.entries) || 0);
      return n;
    }, 0);
  }
  function routesTile(stats, problems) {
    if (!stats || !stats.routes) return null;
    const active = Number(stats.routes.active) || 0;
    if (!active) return { state: 'none', value: '0', sub: ['dashboard.tile_routes_none', {}] };
    if (!problems) return { state: 'none', value: String(active), sub: ['dashboard.tile_routes_active', {}] };
    const down = unreachableEntries(problems);
    if (down > 0) return { state: 'warn', value: String(active), sub: ['dashboard.tile_routes_down', { n: down, ok: Math.max(0, active - down) }] };
    const m = stats.monitoring || {};
    if (Number(m.total) > 0) return { state: 'good', value: String(active), sub: ['dashboard.tile_routes_ok_monitored', { up: m.up || 0, total: m.total }] };
    return { state: 'good', value: String(active), sub: ['dashboard.tile_routes_ok', {}] };
  }
  function certsTile(tls) {
    if (!tls || !tls.summary) return null;
    const s = tls.summary;
    const total = Number(s.total) || 0;
    if (!total) return { state: 'none', value: '0', sub: ['dashboard.tile_certs_none', {}] };
    if (s.failed > 0) return { state: 'crit', value: String(total), sub: ['dashboard.tile_certs_failed', { n: s.failed }] };
    if (s.expiring > 0) {
      const days = (tls.hosts || []).filter((h) => h.state === 'issued' && h.days_left != null)
        .reduce((m, h) => Math.min(m, h.days_left), Infinity);
      return { state: 'warn', value: String(total), sub: [plural('dashboard.tile_certs_expiring', s.expiring), { n: s.expiring, days: Number.isFinite(days) ? days : '?' }] };
    }
    if (s.paused > 0) return { state: 'warn', value: String(total), sub: ['dashboard.tile_certs_paused', { n: s.paused }] };
    if (s.pending > 0) return { state: 'good', value: String(total), sub: ['dashboard.tile_certs_pending', { n: s.pending }] };
    return { state: 'good', value: String(total), sub: ['dashboard.tile_certs_ok', {}] };
  }
  function checkTile(sec) {
    const c = sec && sec.check;
    if (!c) return null;
    const open = (c.fail || 0) + (c.info || 0);
    const value = (c.pass || 0) + ' / ' + (c.total || 0);
    if (c.critical > 0) return { state: 'crit', value, sub: [plural('dashboard.tile_check_open', open), { n: open }] };
    if (c.fail > 0) return { state: 'warn', value, sub: [plural('dashboard.tile_check_open', open), { n: open }] };
    if (open > 0) return { state: 'good', value, sub: [plural('dashboard.tile_check_hints', open), { n: open }] };
    return { state: 'good', value, sub: ['dashboard.tile_check_ok', {}] };
  }

  // ─── Headline ────────────────────────────────────────────────────────────
  const SUMMARY_KINDS = [
    ['gateway_offline', 'dashboard.sum_gateway_offline'],
    ['entry_down', 'dashboard.sum_entry_down'],
    ['tls_failed', 'dashboard.sum_tls_broken'],
    ['tls_paused', 'dashboard.sum_tls_broken'],
    ['tls_expiring', 'dashboard.sum_tls_expiring'],
    ['update_failed', 'dashboard.sum_update'],
    ['update_rolled_back', 'dashboard.sum_update'],
    ['backup_failed', 'dashboard.sum_backup'],
    ['waf_engine_missing', 'dashboard.sum_waf'],
  ];
  /**
   * → { title: [key, params], sub: [[key, params], …] } — "Alles läuft" or
   * "N Dinge brauchen Aufmerksamkeit" plus one short phrase per kind.
   */
  function headline(problems, stats, gws) {
    const list = (problems && problems.problems) || [];
    if (!list.length) {
      const sub = [];
      const c = stats && stats.peers && (stats.peers.clients || stats.peers);
      if (c) sub.push([plural('dashboard.sum_ok_peers', c.online || 0), { n: c.online || 0 }]);
      if (gws && Array.isArray(gws.gateways) && gws.gateways.length) sub.push(['dashboard.sum_ok_gateways', {}]);
      if (stats && stats.routes && stats.routes.active > 0) sub.push(['dashboard.sum_ok_routes', {}]);
      return { title: ['dashboard.headline_ok', {}], sub };
    }
    const counts = {};
    list.forEach((p) => { counts[p.kind] = (counts[p.kind] || 0) + 1; });
    const merged = {};
    const order = [];
    SUMMARY_KINDS.forEach(([kind, key]) => {
      if (!counts[kind]) return;
      if (!(key in merged)) { merged[key] = 0; order.push(key); }
      merged[key] += counts[kind];
    });
    return {
      title: [plural('dashboard.headline_problems', list.length), { n: list.length }],
      sub: order.map((key) => [plural(key, merged[key]), { n: merged[key] }]),
    };
  }

  return {
    fmt, plural, fmtNumber, fmtPercent, fmtBytes, fmtRate, unitIndex, UNITS,
    niceStep, byteTicks, parseTime, parseDay, relTime, duration, uptimeText, bucketLabel, xTickIndices,
    chartGeometry, sparkPath, sparkLast, meterLevel,
    ACTIVITY_CATEGORIES, categoryOf, severityState,
    tunnelTile, gatewaysTile, routesTile, certsTile, checkTile, unreachableEntries, headline,
  };
});
