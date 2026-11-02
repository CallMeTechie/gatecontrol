'use strict';

// Export of Logs & Monitoring (FEATURES.md "Logs & Monitoring › Export"):
// rows of logEvents entries as CSV, JSON, NDJSON or text, with chosen
// columns, privacy options and time zone, written row by row to a stream;
// and the "Fehlerbericht" — a ZIP with the problems of a range, ten examples
// each with their surroundings, and the versions of server and plugins.

const zlib = require('node:zlib');
const { getDb } = require('../db/connection');

const FORMATS = ['csv', 'json', 'ndjson', 'log'];
const COLUMNS = ['time', 'level', 'source', 'message', 'fields', 'raw'];
const DEFAULT_COLUMNS = ['time', 'level', 'source', 'message', 'fields'];
const TYPES = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  ndjson: 'application/x-ndjson; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  zip: 'application/zip',
};

// ─── Privacy ─────────────────────────────────────────────────────────────────

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const IPV6 = /\b((?:[0-9a-f]{1,4}:){2}[0-9a-f]{1,4})(?::[0-9a-f]{0,4}){1,5}\b/gi;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Masking function for the chosen options:
 *   maskIp     203.0.113.24 → 203.0.113.x, IPv6 keeps the first three groups
 *   maskEmail  anna@example.org → a***@example.org
 *   pseudonymize  user names and display names → user-<id>
 */
function masker({ maskIp = false, maskEmail = false, pseudonymize = false } = {}) {
  let users = null;
  if (pseudonymize) {
    try {
      const rows = getDb().prepare('SELECT id, username, display_name FROM users ORDER BY id LIMIT 5000').all();
      const map = new Map();
      for (const r of rows) {
        for (const n of [r.username, r.display_name]) {
          if (typeof n === 'string' && n.trim().length >= 3 && !map.has(n.trim())) map.set(n.trim(), `user-${r.id}`);
        }
      }
      if (map.size) {
        const names = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
        users = { map, re: new RegExp(`(?<![\\w.@-])(${names.join('|')})(?![\\w.@-])`, 'g') };
      }
    } catch { users = null; }
  }
  if (!maskIp && !maskEmail && !users) return (v) => v;
  const str = (s) => {
    let out = s;
    if (maskEmail) out = out.replace(EMAIL, (m, first, domain) => `${first}***@${domain}`);
    if (maskIp) {
      out = out.replace(IPV4, (m, a, b, c) => `${a}.${b}.${c}.x`);
      out = out.replace(IPV6, (m, head) => `${head}::x`);
    }
    if (users) out = out.replace(users.re, (m) => users.map.get(m) || m);
    return out;
  };
  const walk = (v, depth = 0) => {
    if (typeof v === 'string') return str(v);
    if (v == null || typeof v !== 'object' || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, depth + 1);
    return o;
  };
  return walk;
}

// ─── Time ────────────────────────────────────────────────────────────────────

/** Formatter for the chosen time zone ('utc' or an IANA name), ISO-like. */
function timeFormatter(tz) {
  if (!tz || tz === 'utc' || tz === 'UTC') return (ts) => new Date(ts).toISOString();
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'shortOffset',
    });
  } catch { return (ts) => new Date(ts).toISOString(); }
  return (ts) => {
    const p = {};
    for (const x of fmt.formatToParts(new Date(ts))) p[x.type] = x.value;
    const ms = String(ts % 1000).padStart(3, '0');
    const off = (p.timeZoneName || 'GMT').replace('GMT', '') || '+0';
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${ms} ${off === '+0' ? 'UTC' : 'UTC' + off}`;
  };
}

function validTimeZone(tz) {
  if (!tz || tz === 'utc') return true;
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// ─── Rows ────────────────────────────────────────────────────────────────────

const FORMULA = /^[=+\-@\t\r]/;
function csvField(v) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (FORMULA.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function sourceLabel(e) {
  return e.source === 'plugins' || (e.plugin && e.pluginName) ? `${e.source}${e.pluginName ? ':' + e.pluginName : ''}` : e.source;
}

/**
 * Writer for one export: header(), row(entry) and footer() return strings.
 * opts: { format, columns, tz, mask }
 */
function writer(opts) {
  const format = opts.format;
  const cols = COLUMNS.filter((c) => opts.columns.includes(c));
  const time = timeFormatter(opts.tz);
  const mask = opts.mask || ((v) => v);
  let n = 0;
  const obj = (e) => {
    const o = {};
    if (cols.includes('time')) o.time = time(e.ts);
    if (cols.includes('level')) o.level = e.level;
    if (cols.includes('source')) {
      o.source = e.source;
      if (e.plugin) o.plugin = e.plugin;
    }
    if (cols.includes('message')) o.message = e.msg;
    if (cols.includes('fields')) o.fields = e.fields;
    if (cols.includes('raw')) o.raw = e.raw;
    return mask(o);
  };
  return {
    header() {
      if (format === 'csv') return cols.map((c) => c).join(',') + '\n';
      if (format === 'json') return '[';
      return '';
    },
    row(e) {
      const o = obj(e);
      n += 1;
      if (format === 'csv') {
        return cols.map((c) => {
          if (c === 'source') return csvField(sourceLabel({ ...e, pluginName: e.pluginName }));
          if (c === 'message') return csvField(o.message);
          return csvField(o[c]);
        }).join(',') + '\n';
      }
      if (format === 'json') return (n === 1 ? '\n' : ',\n') + JSON.stringify(o);
      if (format === 'ndjson') return JSON.stringify(o) + '\n';
      // text: "<time> <LEVEL> [source] message {fields}"
      const parts = [];
      if (o.time) parts.push(o.time);
      if (o.level) parts.push(o.level.toUpperCase().padEnd(5));
      if (o.source) parts.push(`[${sourceLabel(e)}]`);
      if (o.message != null) parts.push(String(o.message).replace(/\r?\n/g, ' ⏎ '));
      if (o.fields && Object.keys(o.fields).length) parts.push(JSON.stringify(o.fields));
      if (o.raw) parts.push(JSON.stringify(o.raw));
      return parts.join(' ') + '\n';
    },
    footer() {
      if (format === 'json') return n ? '\n]\n' : ']\n';
      return '';
    },
  };
}

// ─── ZIP (stored entries are deflated; no external dependency) ──────────────

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** files: [{ name, data: Buffer|string }] → Buffer of a ZIP archive. */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'problem';
}

/**
 * Fehlerbericht: errors and warnings of the range grouped into problems (top
 * 50 by count); per problem up to 10 examples, each with the entries of all
 * sources ±10 s around it (≤ 40); versions of server, Node and plugins.
 */
async function report({ from, to, allowed, mask, tz, lang }) {
  const logEvents = require('./logEvents');
  const logProblems = require('./logProblems');
  const time = timeFormatter(tz);
  const m = mask || ((v) => v);
  const all = (await logProblems.collect({ from, to, allowed })).sort((a, b) => b.count - a.count).slice(0, 50);
  const pkg = require('../../package.json');
  const plugins = [...logEvents.pluginNames().entries()].map(([id, p]) => ({ id, name: p.name, version: p.version }));
  const files = [];
  const summary = [];
  let n = 0;
  for (const p of all) {
    n += 1;
    const filter = logEvents.parseFilter({ level: 'error,warn', from: String(p.firstTs), to: String(p.lastTs), problem: p.key }, { allowed });
    const examples = [];
    await logEvents.each(filter, async (e) => {
      examples.push(e);
      return examples.length < 10;
    }, { desc: true });
    const lines = [];
    for (const ex of examples) {
      const around = logEvents.parseFilter({ from: String(ex.ts - 10000), to: String(ex.ts + 10000) }, { allowed });
      const ctx = [];
      await logEvents.each(around, async (e) => { ctx.push(e); return ctx.length < 40; });
      lines.push(JSON.stringify(m({
        example: { time: time(ex.ts), level: ex.level, source: ex.source, plugin: ex.plugin, message: ex.msg, fields: ex.fields },
        around: ctx.map((e) => ({ time: time(e.ts), level: e.level, source: e.source, plugin: e.plugin, message: e.msg, self: e.id === ex.id || undefined })),
      })));
    }
    files.push({ name: `problems/${String(n).padStart(2, '0')}-${slug(p.code || p.title)}.ndjson`, data: lines.join('\n') + '\n' });
    summary.push(m({ n, key: p.key, code: p.code, title: p.title, level: p.level, count: p.count, first: time(p.firstTs), last: time(p.lastTs),
      sources: p.sources, status: p.status }));
  }
  const readme = [
    'GateControl – Fehlerbericht / error report',
    `Erstellt / created: ${time(Date.now())}`,
    `Zeitraum / range: ${from != null ? time(from) : '—'} – ${to != null ? time(to) : time(Date.now())}`,
    `GateControl ${pkg.version} · Node ${process.version} · ${process.platform}/${process.arch}`,
    `Sprache / language: ${lang || 'de'}`,
    '',
    `Probleme / problems: ${all.length}`,
    ...summary.map((s) => `  ${String(s.n).padStart(2, ' ')}. [${s.level}] ${s.title} (${s.count}×, ${s.code || 'ohne Code'})`),
    '',
    'Plugins:',
    ...plugins.map((p) => `  ${p.id} ${p.version || ''} (${p.name})`),
    '',
    'problems.json: alle Probleme; problems/*.ndjson: je Problem bis zu 10 Beispiele mit allen Einträgen ±10 s.',
  ].join('\n') + '\n';
  files.unshift(
    { name: 'README.txt', data: readme },
    { name: 'problems.json', data: JSON.stringify(summary, null, 2) + '\n' },
    { name: 'versions.json', data: JSON.stringify({ gatecontrol: pkg.version, node: process.version, plugins }, null, 2) + '\n' },
  );
  return zip(files);
}

module.exports = { FORMATS, COLUMNS, DEFAULT_COLUMNS, TYPES, masker, timeFormatter, validTimeZone, writer, zip, report, csvField };
