'use strict';

// DNS filter of a home gateway (phase 3b, contract §1): settings per gateway
// (gateway_dns, migration 129), `features.dns` of the config pull, the
// statistics the gateway reports every 5 minutes, the tab "DNS-Filter" of the
// gateway page and the notice "DNS-Filter ausgefallen".
//
//   settings (stored, normalised on read)
//     enabled, logQueries, upstream { provider, url, fallbackRouter },
//     allowAll [pattern]             "Ausnahmen" for every profile
//     profiles [{ id, name, lists, safeSearch, allow, deny, schedules,
//                 users [userId], devices [netwatch device id] }]
//                                    profiles[0] is the default profile
//                                    (no members: every other device)
//
// Members come from the network watch: a person's devices (owner) follow
// the person's profile; a device can also be put into a profile directly
// (that wins). The gateway only gets MAC addresses (configPayload) — plugins
// never (homeInternet.js).
//
// Statistics: daily values per gateway in the server's time zone, a year.
// The gateway reports counts only — nothing per device and domain; the
// devices that asked (clientsSeen) only as a set for the router check
// ("4 Geräte, die gerade online sind, haben heute noch nicht gefragt").

const { domainToASCII } = require('node:url');
const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const catalog = require('./homeDnsCatalog');
const logger = require('../utils/logger');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const DOWN_AFTER_MS = 5 * MINUTE;
const LIMITS = Object.freeze({ profiles: 16, schedules: 12, patterns: 200, users: 64, devices: 256, name: 40, top: 20, topKeep: 50, clients: 1024, clientsKeep: 2048, byProfile: 32 });
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const DEFAULT_ID = 'default';

class DnsError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function bool(v, d) { return typeof v === 'boolean' ? v : d; }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }
function serverTz() { try { return require('./notify/router').serverTz(); } catch { return 'UTC'; } }
function lang() { try { return require('./notify/text').serverLang(); } catch { return 'de'; } }
function defaultName() { return lang() === 'en' ? 'Default' : 'Standard'; }

// ─── Patterns ──────────────────────────────────────────────────────────

/**
 * 'Example.COM.' → 'example.com', '*.foo.de' stays, 'bücher.de' → punycode.
 * null when it is no domain (a URL, a path, spaces, a bare '*').
 */
function normPattern(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  let wild = false;
  if (s.startsWith('*.')) { wild = true; s = s.slice(2); }
  if (!/^[\p{L}\p{N}._-]+$/u.test(s)) return null;
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 && !wild) return null;
  if (!labels.every((l) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return null;
  return (wild ? '*.' : '') + ascii;
}

function patterns(v, what) {
  if (!Array.isArray(v) || v.length > LIMITS.patterns) throw new DnsError('invalid', `${what}: up to ${LIMITS.patterns} domains`);
  const out = [];
  for (const x of v) {
    const p = normPattern(x);
    if (!p) throw Object.assign(new DnsError('invalid_domain', `${what}: "${String(x).slice(0, 60)}" is no domain`), { value: String(x).slice(0, 80) });
    if (!out.includes(p)) out.push(p);
  }
  return out.sort();
}

function patternsSoft(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v.slice(0, LIMITS.patterns)) { const p = normPattern(x); if (p && !out.includes(p)) out.push(p); }
  return out.sort();
}

// ─── Settings ──────────────────────────────────────────────────────────

function text(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
  return s || null;
}

function normSchedule(x) {
  if (!x || typeof x !== 'object') return null;
  const days = Array.isArray(x.days) ? [...new Set(x.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b) : [];
  if (!days.length || !HHMM_RE.test(x.from) || !HHMM_RE.test(x.to) || x.from === x.to) return null;
  const block = x.block === 'all' ? 'all' : 'categories';
  const categories = block === 'categories' && Array.isArray(x.categories)
    ? catalog.CATEGORY_IDS.filter((c) => x.categories.includes(c)) : [];
  if (block === 'categories' && !categories.length) return null;
  return { days, from: x.from, to: x.to, block, categories, allowAlways: patternsSoft(x.allowAlways) };
}

function normProfile(p, i) {
  const r = p && typeof p === 'object' ? p : {};
  const id = i === 0 ? DEFAULT_ID : (typeof r.id === 'string' && ID_RE.test(r.id) && r.id !== DEFAULT_ID ? r.id : null);
  if (!id) return null;
  const ints = (v, max) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, max).sort((a, b) => a - b) : []);
  return {
    id,
    name: text(r.name, LIMITS.name) || (i === 0 ? defaultName() : id),
    lists: Array.isArray(r.lists) ? catalog.LIST_IDS.filter((l) => r.lists.includes(l)) : [],
    safeSearch: r.safeSearch === true,
    allow: patternsSoft(r.allow),
    deny: patternsSoft(r.deny),
    schedules: Array.isArray(r.schedules) ? r.schedules.slice(0, LIMITS.schedules).map(normSchedule).filter(Boolean) : [],
    users: i === 0 ? [] : ints(r.users, LIMITS.users),
    devices: i === 0 ? [] : ints(r.devices, LIMITS.devices),
  };
}

function defaultProfile() {
  return { id: DEFAULT_ID, name: defaultName(), lists: catalog.LISTS.filter((l) => l.defaultOn).map((l) => l.id), safeSearch: false, allow: [], deny: [], schedules: [], users: [], devices: [] };
}

/** Stored settings (any shape) → the complete, valid settings object. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const up = r.upstream && typeof r.upstream === 'object' ? r.upstream : {};
  let provider = catalog.PROVIDER_IDS.includes(up.provider) ? up.provider : 'quad9';
  const url = typeof up.url === 'string' && validDohUrl(up.url) ? up.url.trim() : null;
  if (provider === 'custom' && !url) provider = 'quad9';
  const list = Array.isArray(r.profiles) && r.profiles.length ? r.profiles : [defaultProfile()];
  const profiles = [];
  for (let i = 0; i < list.length && profiles.length < LIMITS.profiles; i++) {
    const p = normProfile(list[i], profiles.length);
    if (p && !profiles.some((q) => q.id === p.id)) profiles.push(p);
  }
  return {
    enabled: bool(r.enabled, false),
    logQueries: bool(r.logQueries, false),
    upstream: { provider, url: provider === 'custom' ? url : null, fallbackRouter: bool(up.fallbackRouter, true) },
    allowAll: patternsSoft(r.allowAll),
    profiles,
  };
}

/** https only, a host name, no credentials, ≤ 300 characters. */
function validDohUrl(s) {
  if (typeof s !== 'string' || s.length > 300) return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password && !/[\s"'<>\\]/.test(s);
  } catch { return false; }
}

function row(peerId) { return db().prepare('SELECT * FROM gateway_dns WHERE peer_id = ?').get(peerId) || null; }

/** The settings of a gateway (defaults when it never had any). */
function get(peerId) {
  const r = row(peerId);
  return normalize(r ? json(r.settings) : null);
}

function save(peerId, s) {
  db().prepare(`INSERT INTO gateway_dns (peer_id, settings, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
    .run(peerId, JSON.stringify(s), Date.now());
}

function needGateway(peerId) {
  try { return require('./gatewayFeatures').needGateway(peerId); } catch (e) {
    if (e && e.code === 'not_found') throw new DnsError('not_found', 'gateway not found');
    throw e;
  }
}

function gatewayName(peerId) {
  const r = db().prepare('SELECT name FROM peers WHERE id = ?').get(peerId);
  return r ? r.name : null;
}

function audit(type, g, message, details, { ip, user } = {}) {
  try {
    require('./activity').log(type, message, { source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, ...(user ? { user } : {}), ...details } });
  } catch (e) { logger.debug({ err: e.message }, 'dns activity not written'); }
}

function changed(peerId, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  save(peerId, after);
  require('./gatewayFeatures').notifyGateway(peerId);
  return true;
}

/** PUT …/dns { enabled?, logQueries?, upstream?, allowAll? } → settings */
function setGeneral(peerId, patch, actor = {}) {
  const g = needGateway(peerId);
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) throw new DnsError('invalid', 'invalid body');
  const before = get(g.id);
  const out = JSON.parse(JSON.stringify(before));
  let any = false;
  for (const [k, v] of Object.entries(p)) {
    any = true;
    if (k === 'enabled' || k === 'logQueries') {
      if (typeof v !== 'boolean') throw new DnsError('invalid', `${k} must be true or false`);
      out[k] = v;
    } else if (k === 'allowAll') {
      out.allowAll = patterns(v, 'allowAll');
    } else if (k === 'upstream') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DnsError('invalid', 'upstream: object');
      for (const [f, val] of Object.entries(v)) {
        if (f === 'provider') {
          if (!catalog.PROVIDER_IDS.includes(val)) throw new DnsError('invalid', 'upstream.provider: quad9, cloudflare or custom');
          out.upstream.provider = val;
        } else if (f === 'url') {
          if (val !== null && !validDohUrl(val)) throw new DnsError('invalid_url', 'upstream.url: an https:// address');
          out.upstream.url = val ? val.trim() : null;
        } else if (f === 'fallbackRouter') {
          if (typeof val !== 'boolean') throw new DnsError('invalid', 'upstream.fallbackRouter must be true or false');
          out.upstream.fallbackRouter = val;
        } else throw new DnsError('invalid', `upstream.${f}: unknown`);
      }
      if (out.upstream.provider === 'custom' && !out.upstream.url) throw new DnsError('invalid_url', 'upstream.url is needed for an own server');
      if (out.upstream.provider !== 'custom') out.upstream.url = null;
    } else throw new DnsError('invalid', `${k}: unknown`);
  }
  if (!any) throw new DnsError('invalid', 'nothing to change');
  const after = normalize(out);
  if (changed(g.id, before, after)) {
    const keys = ['enabled', 'logQueries', 'upstream', 'allowAll'].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    audit('gateway_dns_changed', g, `DNS filter settings changed on "${g.name}" (${keys.join(', ')})`, { changed: keys, enabled: after.enabled }, actor);
  }
  return after;
}

function validateProfile(b, s, peerId, current) {
  const p = b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  if (!p) throw new DnsError('invalid', 'invalid body');
  const out = current ? JSON.parse(JSON.stringify(current)) : { id: null, name: null, lists: [], safeSearch: false, allow: [], deny: [], schedules: [], users: [], devices: [] };
  const isDefault = out.id === DEFAULT_ID;
  for (const [k, v] of Object.entries(p)) {
    if (k === 'name') {
      const n = text(v, LIMITS.name);
      if (!n) throw new DnsError('invalid_name', 'name: 1…40 characters');
      if (s.profiles.some((q) => q.id !== out.id && q.name.toLowerCase() === n.toLowerCase())) throw new DnsError('name_taken', 'a profile with this name exists');
      out.name = n;
    } else if (k === 'lists') {
      if (!Array.isArray(v) || !v.every((x) => catalog.LIST_IDS.includes(x))) throw new DnsError('invalid', 'lists: ids of the catalogue');
      out.lists = catalog.LIST_IDS.filter((l) => v.includes(l));
    } else if (k === 'safeSearch') {
      if (typeof v !== 'boolean') throw new DnsError('invalid', 'safeSearch must be true or false');
      out.safeSearch = v;
    } else if (k === 'allow' || k === 'deny') {
      out[k] = patterns(v, k);
    } else if (k === 'schedules') {
      if (!Array.isArray(v) || v.length > LIMITS.schedules) throw new DnsError('invalid', `schedules: up to ${LIMITS.schedules}`);
      out.schedules = v.map((x, i) => {
        if (!x || typeof x !== 'object') throw new DnsError('invalid_schedule', `schedules[${i}]: object`);
        if (x.allowAlways !== undefined) patterns(x.allowAlways, `schedules[${i}].allowAlways`);
        const n = normSchedule(x);
        if (!n) throw Object.assign(new DnsError('invalid_schedule', `schedules[${i}]: days 1–7, from/to HH:MM (different), block all or categories with at least one category`), { index: i });
        return n;
      });
    } else if (k === 'users' || k === 'devices') {
      if (isDefault) throw new DnsError('invalid', 'the default profile has no members');
      const max = k === 'users' ? LIMITS.users : LIMITS.devices;
      if (!Array.isArray(v) || v.length > max || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw new DnsError('invalid', `${k}: up to ${max} ids`);
      const ids = [...new Set(v)];
      if (k === 'users') {
        const ok = new Set(ids.length ? db().prepare(`SELECT id FROM users WHERE enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id) : []);
        if (ids.some((x) => !ok.has(x))) throw new DnsError('invalid_member', 'unknown or disabled person');
      } else {
        const ok = new Set(ids.length ? db().prepare(`SELECT id FROM netwatch_devices WHERE peer_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(peerId, ...ids).map((r) => r.id) : []);
        if (ids.some((x) => !ok.has(x))) throw new DnsError('invalid_member', 'unknown device of this gateway');
      }
      out[k] = ids.sort((a, b) => a - b);
    } else throw new DnsError('invalid', `${k}: unknown`);
  }
  if (!out.name) throw new DnsError('invalid_name', 'name: 1…40 characters');
  return out;
}

/** POST …/dns/profiles — a new profile (behind the existing ones). */
function createProfile(peerId, body, actor = {}) {
  const g = needGateway(peerId);
  const s = get(g.id);
  if (s.profiles.length >= LIMITS.profiles) throw new DnsError('too_many', `at most ${LIMITS.profiles} profiles`);
  const p = validateProfile(body, s, g.id, null);
  p.id = 'p' + crypto.randomBytes(4).toString('hex');
  const after = normalize({ ...s, profiles: [...s.profiles, p] });
  changed(g.id, s, after);
  audit('gateway_dns_profile_created', g, `DNS profile "${p.name}" created on "${g.name}"`, { profile: p.id }, actor);
  return after.profiles.find((x) => x.id === p.id);
}

/** PUT …/dns/profiles/:pid */
function updateProfile(peerId, pid, body, actor = {}) {
  const g = needGateway(peerId);
  const s = get(g.id);
  const cur = s.profiles.find((x) => x.id === pid);
  if (!cur) throw new DnsError('not_found', 'profile not found');
  const p = validateProfile(body, s, g.id, cur);
  const after = normalize({ ...s, profiles: s.profiles.map((x) => (x.id === pid ? p : x)) });
  if (changed(g.id, s, after)) {
    const keys = Object.keys(body || {}).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(p[k]));
    audit('gateway_dns_profile_changed', g, `DNS profile "${p.name}" changed on "${g.name}" (${keys.join(', ')})`, { profile: pid, changed: keys }, actor);
  }
  return after.profiles.find((x) => x.id === pid);
}

/** DELETE …/dns/profiles/:pid — not the default profile; its members fall back to it. */
function deleteProfile(peerId, pid, actor = {}) {
  const g = needGateway(peerId);
  const s = get(g.id);
  const cur = s.profiles.find((x) => x.id === pid);
  if (!cur) throw new DnsError('not_found', 'profile not found');
  if (pid === DEFAULT_ID) throw new DnsError('default_profile', 'the default profile cannot be deleted');
  const after = normalize({ ...s, profiles: s.profiles.filter((x) => x.id !== pid) });
  changed(g.id, s, after);
  audit('gateway_dns_profile_deleted', g, `DNS profile "${cur.name}" deleted on "${g.name}"`, { profile: pid }, actor);
  return { removed: true };
}

// ─── Members → MAC addresses ───────────────────────────────────────────

function devicesOf(peerId) {
  return db().prepare('SELECT id, mac, ip, name, hostname, vendor, owner_user_id, online, last_seen FROM netwatch_devices WHERE peer_id = ? ORDER BY id').all(peerId);
}

/**
 * mac → profile id for every device that is not in the default profile:
 * devices put into a profile directly first, then the devices of the
 * profile's people; the earlier profile wins a tie.
 */
function assignment(peerId, s, devs) {
  const byId = new Map(devs.map((d) => [d.id, d]));
  const out = new Map();
  for (const p of s.profiles.slice(1)) {
    for (const id of p.devices) { const d = byId.get(id); if (d && !out.has(d.mac)) out.set(d.mac, p.id); }
  }
  for (const p of s.profiles.slice(1)) {
    const users = new Set(p.users);
    for (const d of devs) if (d.owner_user_id != null && users.has(d.owner_user_id) && !out.has(d.mac)) out.set(d.mac, p.id);
  }
  return out;
}

/** The profile a person's devices follow on a gateway (default when none names them). */
function profileOfUser(peerId, userId) {
  const s = get(peerId);
  return s.profiles.slice(1).find((p) => p.users.includes(userId)) || s.profiles[0];
}

function serverHosts() {
  const out = [];
  try {
    const h = new URL(require('../../config/default').app.baseUrl).hostname.toLowerCase();
    if (h && !/^[\d.]+$/.test(h) && !h.includes(':') && h !== 'localhost') { const p = normPattern(h); if (p) out.push(p); }
  } catch { /* no base URL */ }
  return out;
}

/** `features.dns` of the config pull (contract §1.1, server side 2/3). */
function configPayload(peerId, now = Date.now()) {
  const s = get(peerId);
  if (!s.enabled) return { enabled: false };
  const devs = devicesOf(peerId);
  const map = assignment(peerId, s, devs);
  const used = new Set();
  const profiles = s.profiles.map((p, i) => {
    p.lists.forEach((l) => used.add(l));
    const macs = i === 0 ? [] : [...map.entries()].filter(([, pid]) => pid === p.id).map(([mac]) => mac).filter((m) => MAC_RE.test(m)).sort();
    const allow = [...new Set([...p.allow, ...s.allowAll])].sort();
    return {
      id: p.id, name: p.name, lists: p.lists.slice(), safeSearch: p.safeSearch, allow, deny: p.deny.slice(),
      schedules: p.schedules.map((x) => ({ days: x.days.slice(), from: x.from, to: x.to, block: x.block, categories: x.categories.slice(), allowAlways: x.allowAlways.slice() })),
      macs,
    };
  });
  const lists = {};
  for (const l of catalog.LISTS) if (used.has(l.id)) lists[l.id] = { url: l.url, format: l.format, sha256: null };
  const categories = {};
  for (const c of catalog.CATEGORY_IDS) categories[c] = catalog.CATEGORIES[c].slice();
  const hi = require('./homeInternet');
  return {
    enabled: true,
    listen: 'lan',
    upstream: { mode: 'doh', provider: s.upstream.provider, ...(s.upstream.provider === 'custom' ? { url: s.upstream.url } : {}), fallbackRouter: s.upstream.fallbackRouter },
    logQueries: s.logQueries,
    alwaysAllow: serverHosts(),
    lists,
    categories,
    profiles,
    defaultProfile: s.profiles[0].id,
    pauses: hi.entriesFor(peerId, 'pause', now),
    extensions: hi.entriesFor(peerId, 'extend', now),
  };
}

// ─── Times of a profile ────────────────────────────────────────────────

const _fmt = new Map();
function partsOf(ms, tz) {
  let f = _fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    _fmt.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] || 1;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second), wd };
}

/** UTC milliseconds of a wall-clock time in `tz` (the later one in a DST gap/overlap is fine here). */
function zoned(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (ms) => { const p = partsOf(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
  let t = guess - off(guess);
  const o2 = off(t);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

/** 'YYYY-MM-DD' of `ms` in the server's time zone. */
function dayKey(ms, tz = serverTz()) {
  const p = partsOf(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * The running or next window of a profile's times from `now` (server time
 * zone): { from, to (ISO), block, categories, active } — null without times.
 */
function nextSchedule(profile, now = Date.now(), tz = serverTz()) {
  if (!profile || !profile.schedules || !profile.schedules.length) return null;
  const today = partsOf(now, tz);
  let best = null;
  for (let off = -1; off <= 7; off++) {
    const base = new Date(Date.UTC(today.y, today.mo - 1, today.d + off));
    const y = base.getUTCFullYear(); const mo = base.getUTCMonth() + 1; const d = base.getUTCDate();
    const wd = ((today.wd - 1 + off) % 7 + 7) % 7 + 1;
    for (const x of profile.schedules) {
      if (!x.days.includes(wd)) continue;
      const [fh, fm] = x.from.split(':').map(Number);
      const [th, tm] = x.to.split(':').map(Number);
      const start = zoned(y, mo, d, fh, fm, tz);
      const endBase = x.to > x.from ? new Date(Date.UTC(y, mo - 1, d)) : new Date(Date.UTC(y, mo - 1, d + 1));
      const end = zoned(endBase.getUTCFullYear(), endBase.getUTCMonth() + 1, endBase.getUTCDate(), th, tm, tz);
      if (end <= now) continue;
      if (!best || start < best.start) best = { start, end, x };
    }
  }
  if (!best) return null;
  return { from: iso(best.start), to: iso(best.end), block: best.x.block, categories: best.x.categories.slice(), active: best.start <= now };
}

// ─── Statistics (POST /api/v1/gateway/dns) ─────────────────────────────

function count(v, what) {
  if (v === undefined || v === null) return 0;
  if (!Number.isFinite(v) || v < 0 || v > 1e10) throw new DnsError('invalid', `${what}: a number ≥ 0`);
  return Math.round(v);
}

function normTime(v, now) {
  try { return require('./homePresence').normTime(v, now); } catch { return null; }
}

/** One report of the gateway → added to the day of `period.from` (idempotent per period). */
function ingest(peerId, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || !b.period || typeof b.period !== 'object') throw new DnsError('invalid', 'period { from, to } expected');
  const now = Date.now();
  const from = normTime(b.period.from, now);
  const to = normTime(b.period.to, now);
  if (!from || !to || to < from) throw new DnsError('invalid', 'period.from / period.to: times, from ≤ to');
  const queries = count(b.queries, 'queries');
  const blocked = count(b.blocked, 'blocked');
  const cached = count(b.cached, 'cached');
  const avgMs = b.avgMs == null ? null : Number(b.avgMs);
  if (avgMs != null && (!Number.isFinite(avgMs) || avgMs < 0 || avgMs > 60000)) throw new DnsError('invalid', 'avgMs: 0…60000');
  if (b.topBlocked != null && !Array.isArray(b.topBlocked)) throw new DnsError('invalid', 'topBlocked: array');
  const top = [];
  for (const x of (b.topBlocked || []).slice(0, LIMITS.top)) {
    if (!x || typeof x !== 'object') throw new DnsError('invalid', 'topBlocked[]: { domain, count, profileId }');
    const domain = normPattern(x.domain);
    if (!domain || domain.startsWith('*.')) continue;
    top.push({ domain, count: count(x.count, 'topBlocked[].count'), profileId: typeof x.profileId === 'string' && ID_RE.test(x.profileId) ? x.profileId : null });
  }
  if (b.clientsSeen != null && (!Array.isArray(b.clientsSeen) || b.clientsSeen.length > LIMITS.clients)) throw new DnsError('invalid', `clientsSeen: up to ${LIMITS.clients} MAC addresses`);
  const { normMac } = require('./homePresence');
  const clients = [...new Set((b.clientsSeen || []).map(normMac).filter(Boolean))];
  const byProfile = {};
  if (b.byProfile != null) {
    if (typeof b.byProfile !== 'object' || Array.isArray(b.byProfile)) throw new DnsError('invalid', 'byProfile: object');
    for (const [k, v] of Object.entries(b.byProfile).slice(0, LIMITS.byProfile)) {
      if (!ID_RE.test(k) || !v || typeof v !== 'object') continue;
      byProfile[k] = { queries: count(v.queries, 'byProfile.queries'), blocked: count(v.blocked, 'byProfile.blocked') };
    }
  }
  const day = dayKey(from);
  let duplicate = false;
  db().transaction(() => {
    const ins = db().prepare('INSERT OR IGNORE INTO dns_reports (peer_id, from_at, at) VALUES (?, ?, ?)').run(peerId, from, now);
    if (!ins.changes) { duplicate = true; return; }
    const cur = db().prepare('SELECT * FROM dns_stats_day WHERE peer_id = ? AND day = ?').get(peerId, day);
    const cl = new Set(cur ? json(cur.clients) || [] : []);
    for (const m of clients) { if (cl.size >= LIMITS.clientsKeep) break; cl.add(m); }
    const tp = (cur && json(cur.top)) || {};
    for (const x of top) {
      const e = tp[x.domain] || [0, null];
      tp[x.domain] = [e[0] + x.count, x.profileId || e[1]];
    }
    const keep = Object.entries(tp).sort((a, b) => b[1][0] - a[1][0]).slice(0, LIMITS.topKeep);
    const bp = (cur && json(cur.by_profile)) || {};
    for (const [k, v] of Object.entries(byProfile)) {
      const e = bp[k] || { queries: 0, blocked: 0 };
      bp[k] = { queries: e.queries + v.queries, blocked: e.blocked + v.blocked };
    }
    const msAdd = avgMs != null && queries ? avgMs * queries : 0;
    const nAdd = avgMs != null ? queries : 0;
    db().prepare(`INSERT INTO dns_stats_day (peer_id, day, queries, blocked, cached, ms_sum, ms_n, clients, top, by_profile, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id, day) DO UPDATE SET queries = queries + excluded.queries, blocked = blocked + excluded.blocked,
        cached = cached + excluded.cached, ms_sum = ms_sum + excluded.ms_sum, ms_n = ms_n + excluded.ms_n,
        clients = excluded.clients, top = excluded.top, by_profile = excluded.by_profile, updated_at = excluded.updated_at`)
      .run(peerId, day, queries, blocked, cached, msAdd, nAdd, JSON.stringify([...cl]), JSON.stringify(Object.fromEntries(keep)), JSON.stringify(bp), now);
    db().prepare(`INSERT INTO gateway_dns (peer_id, settings, report_at) VALUES (?, '{}', ?)
      ON CONFLICT(peer_id) DO UPDATE SET report_at = excluded.report_at`).run(peerId, now);
  })();
  return { duplicate };
}

/** Retention: daily values a year, the idempotence keys two days. */
function retention(now = Date.now()) {
  const old = dayKey(now - 366 * DAY);
  const a = db().prepare('DELETE FROM dns_stats_day WHERE day < ?').run(old).changes;
  const b = db().prepare('DELETE FROM dns_reports WHERE at < ?').run(now - 2 * DAY).changes;
  return { days: a, reports: b };
}

// ─── Telemetry, support ────────────────────────────────────────────────

/** The DNS part of the heartbeat telemetry (contract server side 5) — or null. */
function telemetryDns(tel) {
  const t = tel && typeof tel === 'object' ? tel : {};
  const d = (t.features && typeof t.features === 'object' && t.features.dns && typeof t.features.dns === 'object' ? t.features.dns : null)
    || (t.dns && typeof t.dns === 'object' && !Array.isArray(t.dns) ? t.dns : null);
  if (!d) return null;
  const states = ['running', 'starting', 'port_busy', 'error', 'off'];
  const listen = Array.isArray(d.listen) ? d.listen.filter((x) => typeof x === 'string' && /^[0-9a-f.:]{2,45}$/i.test(x)).slice(0, 16) : [];
  const err = d.lastError && typeof d.lastError === 'object' && typeof d.lastError.message === 'string' ? { at: d.lastError.at || null, message: d.lastError.message.slice(0, 200) } : null;
  const lists = {};
  if (d.lists && typeof d.lists === 'object') {
    for (const [k, v] of Object.entries(d.lists).slice(0, 20)) {
      if (!ID_RE.test(k) || !v || typeof v !== 'object') continue;
      lists[k] = { entries: Number.isFinite(v.entries) ? v.entries : null, updatedAt: v.updatedAt || null, error: typeof v.error === 'string' ? v.error.slice(0, 120) : null };
    }
  }
  return { state: states.includes(d.state) ? d.state : (d.running ? 'running' : 'off'), running: d.running === true || d.state === 'running', listen, lastError: err, lists };
}

// ─── Admin view (tab "DNS-Filter") ─────────────────────────────────────

function nameOfDevice(d) {
  try { return require('../../public/js/gateway-net-kit').displayName(d) || d.vendor || null; } catch { return d.name || d.hostname || d.vendor || null; }
}

function userNames(ids) {
  const list = [...new Set(ids.filter((x) => x != null))];
  if (!list.length) return new Map();
  return new Map(db().prepare(`SELECT id, display_name, username FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list).map((u) => [u.id, u.display_name || u.username]));
}

function todayOf(peerId, now) {
  const r = db().prepare('SELECT * FROM dns_stats_day WHERE peer_id = ? AND day = ?').get(peerId, dayKey(now));
  if (!r) return { queries: 0, blocked: 0, cached: 0, avgMs: null, clients: [], top: [], byProfile: {} };
  const top = Object.entries(json(r.top) || {}).map(([domain, v]) => ({ domain, count: v[0], profileId: v[1] })).sort((a, b) => b.count - a.count);
  return { queries: r.queries, blocked: r.blocked, cached: r.cached, avgMs: r.ms_n ? r.ms_sum / r.ms_n : null, clients: json(r.clients) || [], top, byProfile: json(r.by_profile) || {} };
}

function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : null; }

/** Everything the tab "DNS-Filter" shows. */
function view(peerId, now = Date.now()) {
  const gf = require('./gatewayFeatures');
  const g = needGateway(peerId);
  const tel = gf.telemetryOf(g);
  const s = get(g.id);
  const devs = devicesOf(g.id);
  const map = assignment(g.id, s, devs);
  const names = userNames([...devs.map((d) => d.owner_user_id), ...s.profiles.flatMap((p) => p.users)]);
  const today = todayOf(g.id, now);
  const seen = new Set(today.clients);
  const routerIp = typeof tel.default_gateway_ip === 'string' ? tel.default_gateway_ip : null;
  const online = devs.filter((d) => d.online === 1 && d.ip !== routerIp);
  const missing = online.filter((d) => !seen.has(d.mac));
  const asking = devs.filter((d) => seen.has(d.mac)).length;
  const routerState = !today.clients.length ? 'none' : (missing.length ? 'partial' : 'ok');
  const running = require('./homeInternet').runningOn(g.id, now);
  const profiles = s.profiles.map((p, i) => {
    const members = devs.filter((d) => (i === 0 ? !map.has(d.mac) : map.get(d.mac) === p.id));
    return {
      ...p,
      people: p.users.map((u) => ({ id: u, name: names.get(u) || ('#' + u), devices: devs.filter((d) => d.owner_user_id === u && map.get(d.mac) === p.id).length })),
      deviceCount: members.length,
      directDevices: p.devices.map((id) => { const d = devs.find((x) => x.id === id); return d ? { id, name: nameOfDevice(d), ownerName: d.owner_user_id != null ? names.get(d.owner_user_id) || null : null } : null; }).filter(Boolean),
      paused: running.filter((r) => p.users.includes(r.userId) || (i === 0 && !s.profiles.slice(1).some((q) => q.users.includes(r.userId)))),
      stats: today.byProfile[p.id] || null,
    };
  });
  const profName = new Map(s.profiles.map((p) => [p.id, p.name]));
  const listen = (telemetryDns(tel) || {}).listen || [];
  return {
    gateway: {
      id: g.id, name: g.name, support: gf.support(tel), lanIp: typeof tel.lan_ip === 'string' ? tel.lan_ip : null,
      routerIp, telemetry: telemetryDns(tel),
    },
    settings: s,
    catalog: {
      lists: catalog.LISTS.map((l) => ({ id: l.id, url: l.url, format: l.format, entries: l.entries, source: l.source, home: l.home, license: l.license, defaultOn: l.defaultOn })),
      categories: catalog.CATEGORIES,
      providers: catalog.PROVIDERS,
    },
    addresses: {
      v4: [...new Set([...listen.filter((x) => x.includes('.')), ...(typeof tel.lan_ip === 'string' ? [tel.lan_ip] : [])])],
      v6: listen.filter((x) => x.includes(':')),
    },
    today: {
      day: dayKey(now), queries: today.queries, blocked: today.blocked, blockedPct: pct(today.blocked, today.queries),
      cachedPct: pct(today.cached, today.queries), avgMs: today.avgMs == null ? null : Math.round(today.avgMs * 10) / 10, clients: today.clients.length,
    },
    top: today.top.slice(0, 10).map((x) => ({ domain: x.domain, count: x.count, profileId: x.profileId, profileName: x.profileId ? profName.get(x.profileId) || null : null })),
    profiles,
    router: {
      state: routerState, asking, online: online.length,
      missing: missing.slice(0, 20).map((d) => ({ id: d.id, name: nameOfDevice(d), ip: d.ip })), missingCount: missing.length,
    },
    devices: devs.map((d) => ({ id: d.id, name: nameOfDevice(d), ip: d.ip, mac: d.mac, ownerUserId: d.owner_user_id, ownerName: d.owner_user_id != null ? names.get(d.owner_user_id) || null : null, online: d.online === 1, profileId: map.get(d.mac) || DEFAULT_ID })),
    paused: running,
    outage: outageOf(g.id),
    reportAt: iso((row(g.id) || {}).report_at),
    timezone: serverTz(),
  };
}

// ─── "Test: Domain prüfen" (gateway management API) ────────────────────

async function test(peerId, body) {
  const g = needGateway(peerId);
  const b = body && typeof body === 'object' ? body : {};
  const domain = normPattern(b.domain);
  if (!domain || domain.startsWith('*.')) throw new DnsError('invalid_domain', 'a domain like example.com');
  const s = get(g.id);
  if (!s.enabled) throw new DnsError('unavailable', 'the DNS filter is switched off');
  const payload = { domain };
  if (b.deviceId != null) {
    const d = Number.isSafeInteger(b.deviceId) ? db().prepare('SELECT mac FROM netwatch_devices WHERE id = ? AND peer_id = ?').get(b.deviceId, g.id) : null;
    if (!d) throw new DnsError('invalid_member', 'unknown device of this gateway');
    payload.mac = d.mac;
  }
  const r = await require('./gateways').mgmtCall(g.id, '/api/dns/test', payload);
  if (!r) throw new DnsError('gateway_unreachable', 'gateway not reachable');
  if (r.status === 404) throw new DnsError('gateway_unsupported', 'the gateway does not know this command yet');
  if (r.status === 503) throw new DnsError('unavailable', 'the DNS filter is not running on the gateway yet');
  if (r.status < 200 || r.status >= 300 || !r.body || typeof r.body !== 'object') throw new DnsError('gateway_error', 'gateway answered ' + r.status);
  const action = r.body.action === 'block' ? 'block' : 'allow';
  const pid = typeof r.body.profileId === 'string' && ID_RE.test(r.body.profileId) ? r.body.profileId : null;
  const p = pid ? s.profiles.find((x) => x.id === pid) : null;
  const reason = typeof r.body.reason === 'string' ? r.body.reason.replace(/[^\w .:/*()+,-]/g, '').slice(0, 120) : null;
  return { domain, action, profileId: pid, profileName: p ? p.name : null, reason };
}

// ─── "DNS-Filter ausgefallen" ──────────────────────────────────────────

function outageOf(peerId) {
  const r = row(peerId);
  if (!r || !r.down_since) return null;
  return { since: iso(r.down_since), reason: r.down_reason || null, notified: r.down_notified === 1 };
}

/**
 * Every minute (gatewayOps): a gateway with the filter switched on that has
 * been offline for more than 5 minutes, or whose DNS server cannot take
 * port 53 (port_busy), is a notice to the admins (topic "network"); its
 * return ends it. Gateways that cannot filter yet (too old) are skipped.
 */
function checkDown(now = Date.now()) {
  const gf = require('./gatewayFeatures');
  const rows = db().prepare(`SELECT d.peer_id, d.settings, d.down_since, d.down_reason, d.down_notified, gm.last_seen_at, gm.last_health, p.name
    FROM gateway_dns d JOIN peers p ON p.id = d.peer_id JOIN gateway_meta gm ON gm.peer_id = d.peer_id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1`).all();
  const out = [];
  for (const r of rows) {
    const s = normalize(json(r.settings));
    const tel = (json(r.last_health) || {}).telemetry || {};
    const can = gf.support(tel).dns;
    let reason = null;
    let since = null;
    if (s.enabled && can) {
      const last = Number(r.last_seen_at) || 0;
      if (!last || now - last > DOWN_AFTER_MS) { reason = 'offline'; since = last || now; }
      else {
        const t = telemetryDns(tel);
        if (t && t.state === 'port_busy') { reason = 'port_busy'; since = now; }
      }
    }
    if (reason) {
      // a new outage starts now (offline: since the last heartbeat); a change of the reason keeps it
      if (!r.down_since) db().prepare('UPDATE gateway_dns SET down_since = ?, down_reason = ?, down_notified = 0 WHERE peer_id = ?').run(since, reason, r.peer_id);
      else if (r.down_reason !== reason) db().prepare('UPDATE gateway_dns SET down_reason = ? WHERE peer_id = ?').run(reason, r.peer_id);
      if (!r.down_notified) {
        db().prepare('UPDATE gateway_dns SET down_notified = 1 WHERE peer_id = ?').run(r.peer_id);
        notice('dns_filter_down', r, reason);
        out.push({ peerId: r.peer_id, type: 'dns_filter_down', reason });
      }
    } else if (r.down_since) {
      db().prepare('UPDATE gateway_dns SET down_since = NULL, down_reason = NULL, down_notified = 0 WHERE peer_id = ?').run(r.peer_id);
      if (r.down_notified && s.enabled) {
        notice('dns_filter_up', r, r.down_reason, now - r.down_since);
        out.push({ peerId: r.peer_id, type: 'dns_filter_up' });
      }
    }
  }
  return out;
}

function notice(type, r, reason, durationMs) {
  const text = require('./notify/text');
  const l = text.serverLang();
  const minutes = durationMs ? Math.max(1, Math.round(durationMs / MINUTE)) : null;
  const message = type === 'dns_filter_down'
    ? text.t(l, 'push.dns.down_' + (reason === 'port_busy' ? 'port_busy' : 'offline'), { gateway: r.name })
    : text.t(l, 'push.dns.up', { gateway: r.name, minutes: String(minutes || 1) });
  try {
    require('./activity').log(type, message, {
      source: 'system', severity: type === 'dns_filter_down' ? 'warning' : 'info',
      details: { peer_id: r.peer_id, peer_name: r.name, reason: reason || null, ...(minutes ? { minutes } : {}) },
    });
  } catch (e) { logger.warn({ err: e.message }, 'dns notice not written'); }
}

module.exports = {
  DnsError, LIMITS, DEFAULT_ID, DOWN_AFTER_MS,
  normPattern, normalize, get, setGeneral, createProfile, updateProfile, deleteProfile,
  configPayload, profileOfUser, nextSchedule, dayKey, zoned, ingest, retention, telemetryDns, view, test, checkDown, outageOf,
  assignment, gatewayName, validDohUrl,
};
