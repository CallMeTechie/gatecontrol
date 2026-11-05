'use strict';

// Pure rules of the tabs "DNS-Filter" and "Zwischenspeicher" of a gateway
// (public/js/gateway-home.js, phase 3b) — no DOM, also loaded by the tests
// (tests/gateway_home_ui.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayHomeKit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DAYS = [1, 2, 3, 4, 5, 6, 7];
  const CATEGORIES = ['social', 'games', 'video'];
  const ROUTERS = ['fritzbox', 'speedport', 'vodafone', 'other'];
  const KINDS = ['drive', 'photos', 'updates', 'vault'];

  /**
   * [1,2,3,4,5] → 'Mo–Fr', [6,7] → 'Sa–So', [1,3,5] → 'Mo, Mi, Fr', all → every day.
   * `names` = short names Monday … Sunday, `every` = the text for all seven days.
   */
  function daysLabel(days, names, every) {
    const d = DAYS.filter((x) => (days || []).indexOf(x) >= 0);
    if (!d.length) return '';
    if (d.length === 7) return every;
    const runs = [];
    let start = d[0];
    let prev = d[0];
    for (let i = 1; i <= d.length; i++) {
      const x = d[i];
      if (x === prev + 1) { prev = x; continue; }
      runs.push([start, prev]);
      start = x; prev = x;
    }
    return runs.map(([a, b]) => (a === b ? names[a - 1] : names[a - 1] + '–' + names[b - 1])).join(', ');
  }

  /** 'Mo–Fr 21:00 – 07:00' */
  function scheduleTitle(x, names, every) {
    return daysLabel(x.days, names, every) + ' ' + x.from + ' – ' + x.to;
  }

  /** Does a time window cross midnight (to before from)? */
  function overnight(x) { return !!x && x.to < x.from; }

  /**
   * Domains from a free text (one per line, or separated by commas / spaces),
   * lower case, without "http(s)://", paths and duplicates. The server checks them.
   */
  function parsePatterns(text) {
    const out = [];
    String(text || '').split(/[\s,;]+/).forEach((raw) => {
      let s = raw.trim().toLowerCase();
      if (!s) return;
      s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  /** Bytes → { value, unit } in GB/MB/KB (1000-based like the size of a disk). */
  function bytesParts(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v >= 1e12) return { value: v / 1e12, unit: 'TB', digits: 1 };
    if (v >= 1e9) return { value: v / 1e9, unit: 'GB', digits: 1 };
    if (v >= 1e6) return { value: v / 1e6, unit: 'MB', digits: 0 };
    if (v >= 1e3) return { value: v / 1e3, unit: 'KB', digits: 0 };
    return { value: v, unit: 'B', digits: 0 };
  }

  /** The cache's limits are GiB values (1024³): their label in whole GB. */
  function gibLabel(bytes) { return Math.round(Number(bytes) / (1024 * 1024 * 1024)) + ' GB'; }

  /** Memory of the DNS filter (MB) for the lists of every profile (guide: 25 MB + 8 bytes per entry, gateway side 1). */
  function dnsMemMb(profiles, lists) {
    const used = {};
    (profiles || []).forEach((p) => (p.lists || []).forEach((l) => { used[l] = true; }));
    const entries = (lists || []).filter((l) => used[l.id]).reduce((a, l) => a + (l.entries || 0), 0);
    return 25 + Math.round((entries * 8) / 1048576);
  }

  /**
   * The router check of the dialog "Router einstellen": what the gateway
   * reported (state of its DNS server) and which online devices asked today.
   * → { answers: 'ok'|'busy'|'no'|'unknown', asking, missing, missingCount, ok }
   */
  function routerCheck(view) {
    const v = view || {};
    const tel = v.gateway && v.gateway.telemetry;
    const answers = !tel ? 'unknown' : tel.state === 'running' ? 'ok' : tel.state === 'port_busy' ? 'busy' : 'no';
    const r = v.router || {};
    return {
      answers,
      asking: r.asking || 0,
      missing: r.missing || [],
      missingCount: r.missingCount || 0,
      ok: answers === 'ok' && (r.asking || 0) > 0 && !(r.missingCount || 0),
    };
  }

  /** The best IPv6 address for the router: a unique local one (fd…) first, never link-local. */
  function pickV6(list) {
    const l = (list || []).filter((x) => typeof x === 'string' && x.indexOf(':') >= 0 && !/^fe80:/i.test(x));
    return l.find((x) => /^f[cd]/i.test(x)) || l[0] || null;
  }

  /** Percent (one decimal at most), null when unknown. */
  function pct(v) {
    return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10;
  }

  return { DAYS, CATEGORIES, ROUTERS, KINDS, daysLabel, scheduleTitle, overnight, parsePatterns, bytesParts, gibLabel, dnsMemMb, routerCheck, pickV6, pct };
});
