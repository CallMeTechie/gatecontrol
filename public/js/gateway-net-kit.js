'use strict';

// Pure rules of the gateway tabs "Netzwerk" and "Internet" and of the card
// "Funktionen dieses Gateways" (no DOM). public/js/gateway-net.js uses them in
// the browser, the server (services/netwatch.js, inetq.js) and the tests in
// node — one place for which open ports count as risky, how the device list
// is filtered, how the history chart is drawn and what a UPS status means.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayNetKit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ─── Risky open ports (contract §2) ──────────────────────────────────
  // key → i18n gwn.risk.<key> (title + what to do). 445 only on devices that
  // are no NAS (a NAS shares files over SMB on purpose).
  const RISKY = [
    { port: 23, key: 'telnet' },
    { port: 21, key: 'ftp' },
    { port: 445, key: 'smb', notOnNas: true },
    { port: 3389, key: 'rdp' },
    { port: 5900, key: 'vnc' },
    { port: 6379, key: 'redis' },
    { port: 9000, key: 'port9000' },
    { port: 3306, key: 'mysql' },
    { port: 5432, key: 'postgres' },
  ];
  const NAS_VENDOR_RE = /synology|qnap|asustor|terramaster|western digital|wd ?my ?cloud|buffalo|netgear.*readynas|drobo|ugreen/i;
  const NAS_NAME_RE = /(^|[^a-z])(nas|diskstation|ds\d{3,4}|qnap|truenas|unraid|openmediavault|omv)([^a-z]|$)/i;

  function isNas(d) {
    if (!d) return false;
    if (d.vendor && NAS_VENDOR_RE.test(d.vendor)) return true;
    return [d.name, d.hostname].some((x) => typeof x === 'string' && NAS_NAME_RE.test(x));
  }

  /** Risky open ports of a device → [{ port, key }] (in the order of RISKY). */
  function risksOf(d) {
    const ports = d && Array.isArray(d.ports) ? d.ports.map((p) => (p && typeof p === 'object' ? p.port : p)) : [];
    if (!ports.length) return [];
    const nas = isNas(d);
    return RISKY.filter((r) => ports.indexOf(r.port) >= 0 && !(r.notOnNas && nas)).map((r) => ({ port: r.port, key: r.key }));
  }

  // ─── Device list ─────────────────────────────────────────────────────
  const FILTERS = ['all', 'online', 'new', 'watch', 'ports', 'owned'];

  /** Name shown for a device: admin name, name in the network, vendor, else null. */
  function displayName(d) {
    return (d && (d.name || d.hostname || null)) || null;
  }

  function matches(d, q) {
    if (!q) return true;
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return [d.name, d.hostname, d.vendor, d.ip, d.mac, d.ownerName].some((x) => typeof x === 'string' && x.toLowerCase().indexOf(s) >= 0);
  }

  /** Search (name, IP, vendor, MAC, owner) and filter of the list "Alle Geräte". */
  function filterDevices(list, q, filter) {
    const f = FILTERS.indexOf(filter) >= 0 ? filter : 'all';
    return (list || []).filter((d) => {
      if (!matches(d, q)) return false;
      if (f === 'online') return !!d.online;
      if (f === 'new') return d.status === 'new';
      if (f === 'watch') return d.status === 'watch';
      if (f === 'ports') return Array.isArray(d.ports) && d.ports.length > 0;
      if (f === 'owned') return d.ownerUserId != null;
      return true;
    });
  }

  /** Sort: new first, then online, then by name / IP. */
  function sortDevices(list) {
    const ipNum = (ip) => {
      const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip || ''));
      return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : Number.MAX_SAFE_INTEGER;
    };
    return (list || []).slice().sort((a, b) => {
      if ((a.status === 'new') !== (b.status === 'new')) return a.status === 'new' ? -1 : 1;
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      return ipNum(a.ip) - ipNum(b.ip) || String(displayName(a) || '').localeCompare(String(displayName(b) || ''));
    });
  }

  /** KPIs of the tab: { total, online, fresh, risky }. */
  function kpis(list) {
    const out = { total: 0, online: 0, fresh: 0, risky: 0 };
    (list || []).forEach((d) => {
      out.total++;
      if (d.online) out.online++;
      if (d.status === 'new') out.fresh++;
      if (risksOf(d).length) out.risky++;
    });
    return out;
  }

  // ─── Internet ────────────────────────────────────────────────────────
  const RANGES = ['24h', '7d', '30d'];
  const RANGE_MS = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };
  // bucket of one chart point per range (24h: the 5-minute values themselves)
  const BUCKET_MS = { '24h': 5 * 60e3, '7d': 3600e3, '30d': 3 * 3600e3 };

  /** NUT status text → 'online' | 'battery' | 'low' | 'unknown' */
  function upsState(status) {
    const words = String(status || '').toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 'unknown';
    if (words.indexOf('OB') >= 0) return words.indexOf('LB') >= 0 ? 'low' : 'battery';
    if (words.indexOf('OL') >= 0) return 'online';
    return 'unknown';
  }

  function onBattery(status) { const s = upsState(status); return s === 'battery' || s === 'low'; }

  /** Cause of an outage → i18n key part. */
  function causeKey(cause) { return cause === 'router' || cause === 'isp' ? cause : 'unknown'; }

  /** Minutes between two epoch ms values (at least 1 for a real outage). */
  function minutes(startMs, endMs) {
    const d = Math.max(0, Number(endMs) - Number(startMs));
    return Math.max(1, Math.round(d / 60000));
  }

  /**
   * Line and outage bands of the history chart in a viewBox W × H.
   * points: [{ t, rtt }] (rtt null = no value → gap); outages [{ start, end }].
   * → { lines: ['x,y x,y', …], bands: [{ x, w }], max, ticks: [{ y, label }] , xFrom, xTo }
   */
  function chartGeometry(points, outages, opts) {
    const o = opts || {};
    const W = o.width || 1000;
    const H = o.height || 160;
    const pad = o.pad || 8;
    const to = Number(o.to) || Date.now();
    const from = Number(o.from) || (to - RANGE_MS['24h']);
    const span = Math.max(1, to - from);
    const vals = (points || []).map((p) => p.rtt).filter((v) => typeof v === 'number' && isFinite(v) && v >= 0);
    const top = vals.length ? Math.max.apply(null, vals) : 0;
    // a round upper end: 20, 50, 100, 200, 500 … ms
    const steps = [20, 50, 100, 200, 500, 1000, 2000, 5000];
    let max = steps.find((s) => s >= top * 1.1) || Math.ceil(top / 1000) * 1000 || 20;
    if (max < 20) max = 20;
    const x = (t) => Math.round(((t - from) / span) * W * 10) / 10;
    const y = (v) => Math.round((H - pad - (v / max) * (H - 2 * pad)) * 10) / 10;
    const gap = o.gapMs || (BUCKET_MS[o.range] || BUCKET_MS['24h']) * 2.5;
    const lines = [];
    let cur = [];
    let lastT = null;
    (points || []).slice().sort((a, b) => a.t - b.t).forEach((p) => {
      const ok = typeof p.rtt === 'number' && isFinite(p.rtt) && p.rtt >= 0 && p.t >= from && p.t <= to;
      if (!ok || (lastT != null && p.t - lastT > gap)) { if (cur.length > 1) lines.push(cur.join(' ')); cur = []; }
      if (ok) { cur.push(x(p.t) + ',' + y(Math.min(p.rtt, max))); lastT = p.t; }
    });
    if (cur.length > 1) lines.push(cur.join(' '));
    else if (cur.length === 1) lines.push(cur[0] + ' ' + cur[0]);
    const bands = (outages || []).map((b) => {
      const s = Math.max(from, Number(b.start));
      const e = Math.min(to, b.end == null ? to : Number(b.end));
      if (!(e > s)) return null;
      return { x: x(s), w: Math.max(2, Math.round((x(e) - x(s)) * 10) / 10) };
    }).filter(Boolean);
    const half = max / 2;
    return { lines, bands, max, ticks: [{ y: y(half), value: half }, { y: y(max), value: max }], baseY: y(0), from, to };
  }

  /** Text alternative numbers of a range: { min, max, avg, loss } of the ping (ms, rounded) or null. */
  function summary(points) {
    const v = (points || []).map((p) => p.rtt).filter((x) => typeof x === 'number' && isFinite(x));
    const l = (points || []).map((p) => p.loss).filter((x) => typeof x === 'number' && isFinite(x));
    if (!v.length) return null;
    const sum = v.reduce((a, b) => a + b, 0);
    return {
      min: Math.round(Math.min.apply(null, v)),
      max: Math.round(Math.max.apply(null, v)),
      avg: Math.round(sum / v.length),
      loss: l.length ? Math.round((l.reduce((a, b) => a + b, 0) / l.length) * 10) / 10 : null,
    };
  }

  // ─── Funktionen card ─────────────────────────────────────────────────
  function ramLabel(mb) {
    if (!mb) return '—';
    if (mb >= 1000) return (Math.round((mb / 1024) * 10) / 10).toString().replace(/\.0$/, '') + ' GB';
    return Math.round(mb) + ' MB';
  }

  return {
    RISKY, FILTERS, RANGES, RANGE_MS, BUCKET_MS,
    isNas, risksOf, displayName, filterDevices, sortDevices, kpis,
    upsState, onBattery, causeKey, minutes, chartGeometry, summary, ramLabel,
  };
});
