'use strict';

// IP block over every entry point (Einstellungen › Sicherheit › IP-Sperre).
//
// The account lockout (services/lockout.js) protects one account; this stops
// one ADDRESS that tries many accounts, links or routes. Failures from every
// entry point count together:
//
//   login        GateControl login, portal, app sign-in, 2FA (lockout.recordFailedAttempt)
//   route_auth   the login of protected routes (same hook, type route_auth)
//   share_link   wrong PIN of a public link (Drive, GateDrop — routes/publicLinks.js)
//   waf          every request the WAF blocked (waf.ingestLines)
//   scan         404s of one address: a probe path (/.env, /wp-admin …) counts
//                at once, any other ten 404s count once (access.log tail)
//   rate_limit   429 answers (off by default — own apps can hit it)
//
// Unknown names (login, route_auth): a failed login with a name or e-mail
// address that matches no account counts `unknown_user_weight` times (1, 2,
// 3 or 5; default 3) — the account lockout cannot stop those (credential
// stuffing with leaked lists), so the address is stopped earlier. A wrong
// second factor or a wrong password of an existing account counts once. The
// answer of the login stays the same either way; only the counting differs.
// A failure is one row with its weight (ip_block_failures.weight, .unknown_user).
//
// `threshold` failures (the sum of the weights) within `window_min` → a ban
// of 10 min, the next within 7 days 1 h, from the third on 1 day (level
// 1 … 3). Never banned: private,
// loopback and link-local addresses, the VPN subnet, the "Nie sperren" list
// and the WAF's own addresses. Bans by hand (IP or CIDR, also permanent)
// have level 0.
//
// Block lists (licence feature `ip_blocklists`), fetched once a day:
//   drop       Spamhaus DROP (IPv4 + IPv6 JSON) — networks used only for
//              attacks; free use with attribution (the © line is kept with
//              the file), at most one download per hour
//   attackers  blocklist.de "all" — addresses reported for attacks in the
//              last 48 hours; free, as is
//   tor        Tor exit nodes (check.torproject.org) — off by default
//
// Enforcement: one file <caddy data>/ipblock.list (exceptions first, `!`),
// read by the Caddy matcher http.matchers.gc_ipblock (caddy-plugins/mirror/
// ipblock.go) in the first route of srv0 — before the WAF, the routes, the
// portal and the login. The matcher re-reads the file when it changes, so a
// ban takes effect within seconds and never reloads Caddy (a reload
// re-provisions every app, the WAF rule sets included). GateControl itself
// checks the same set (middleware()) — that covers a Caddy without the
// module and requests that reach the app directly. Layer-4 routes get the
// bans (not the lists) through the WAF ban route of their listeners.

const fs = require('node:fs');
const path = require('node:path');
const ipaddr = require('ipaddr.js');
const config = require('../../config/default');
const { getDb } = require('../db/connection');
const settings = require('./settings');
const logger = require('../utils/logger');

const K_CONFIG = 'ipblock.config';
const K_NEVER = 'ipblock.never';
const K_LISTS = 'ipblock.lists_state';

const SOURCES = ['login', 'route_auth', 'share_link', 'waf', 'scan', 'rate_limit'];
const LISTS = ['drop', 'attackers', 'tor'];
const DURATIONS_MIN = [10, 60, 1440];
const WINDOWS_MIN = [10, 60];
const UNKNOWN_WEIGHTS = [1, 2, 3, 5];
const WEIGHTED_SOURCES = ['login', 'route_auth'];
const STRIKE_MEMORY_MS = 7 * 86400e3;
const NEVER_MAX = 50;
const MAX_AUTO_BANS = 5000;
const MASS_BANS = 20;
const MASS_WINDOW_MS = 10 * 60e3;
const MIN_PREFIX = { ipv4: 16, ipv6: 32 };
const MANUAL_HOURS = [1, 24, 168, 720];
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const LIST_MAX_ENTRIES = 200000;
const LIST_TIMEOUT_MS = 30000;
const LIST_REFRESH_MS = 24 * 3600e3;
const LIST_MIN_GAP_MS = 3600e3;
const SWEEP_MS = 60e3;
const TAIL_MS = 15e3;
const SCAN_404_PER_FAILURE = 10;

const DEFAULTS = Object.freeze({
  enabled: true,
  threshold: 10,
  window_min: 10,
  unknown_user_weight: 3,
  notify: true,
  sources: { login: true, route_auth: true, share_link: true, waf: true, scan: true, rate_limit: false },
  lists: { drop: true, attackers: false, tor: false },
});

const LIST_SOURCES = {
  drop: {
    urls: ['https://www.spamhaus.org/drop/drop_v4.json', 'https://www.spamhaus.org/drop/drop_v6.json'],
    format: 'drop-json',
  },
  attackers: { urls: ['https://lists.blocklist.de/lists/all.txt'], format: 'lines' },
  tor: { urls: ['https://check.torproject.org/torbulkexitlist'], format: 'lines' },
};

// Paths only a scanner asks for — one 404 there is one failure.
const PROBE_RE = /^\/(?:\.env|\.git\/|\.aws\/|\.ssh\/|\.DS_Store|wp-admin|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma\/|myadmin|admin\.php|cgi-bin\/|boaform|HNAP1|vendor\/phpunit|actuator\/|server-status|config\.json|backup\.(?:zip|sql|tar)|\.well-known\/security\.txt\.php|owa\/|ecp\/|autodiscover\/|solr\/|console\/|manager\/html|setup\.cgi|shell|eval-stdin\.php)/i;

class IpBlockError extends Error {
  constructor(code, message, status = 400, field = null) { super(message || code); this.code = code; this.statusCode = status; this.field = field; }
}

function db() { return getDb(); }
function now() { return Date.now(); }

// ─── Addresses ─────────────────────────────────────────

/** IP or CIDR → { kind, text, addr, prefix, single } (canonical), or null. */
function parseAddress(value) {
  return require('./wafBans').parseAddress(value);
}

function canonIp(value) {
  const p = parseAddress(value);
  return p && p.single ? p.text : null;
}

/** Only public unicast addresses are ever banned automatically. */
function isPublicIp(ip) {
  try { return ipaddr.process(String(ip)).range() === 'unicast'; } catch { return false; }
}

function cidrText(p) { return p.single ? `${p.text}/${p.kind === 'ipv4' ? 32 : 128}` : p.text; }

/**
 * A set of IP prefixes with a lookup per prefix length (IPv4 as numbers,
 * IPv6 as masked byte strings). Built once per change, asked per request.
 */
class PrefixSet {
  constructor() { this.v4 = new Map(); this.v6 = new Map(); this.size = 0; }

  add(p) {
    if (!p) return;
    if (p.kind === 'ipv4') {
      this.addV4(v4num(p.addr), p.prefix);
    } else {
      const bits = p.prefix;
      if (!this.v6.has(bits)) this.v6.set(bits, new Set());
      this.v6.get(bits).add(v6key(p.addr, bits));
    }
    this.size++;
  }

  /** IPv4 network as number + prefix length (the fast path of the block lists). */
  addV4(num, bits) {
    if (!this.v4.has(bits)) this.v4.set(bits, new Set());
    this.v4.get(bits).add((num & mask32(bits)) >>> 0);
  }

  /** One entry of a block list (canonical CIDR text as written by parseList). → added? */
  addText(text) {
    const m = V4_CIDR_RE.exec(text);
    if (m) {
      const o = [m[1], m[2], m[3], m[4]].map(Number);
      const bits = Number(m[5]);
      if (o.every((x) => x <= 255) && bits <= 32) {
        this.addV4(((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0, bits);
        this.size++;
        return true;
      }
    }
    const p = parseAddress(text);
    if (!p) return false;
    this.add(p);
    return true;
  }

  has(addr) {
    if (!addr) return false;
    if (addr.kind() === 'ipv4') {
      const n = v4num(addr);
      for (const [bits, set] of this.v4) if (set.has((n & mask32(bits)) >>> 0)) return true;
      return false;
    }
    for (const [bits, set] of this.v6) if (set.has(v6key(addr, bits))) return true;
    return false;
  }
}

const V4_CIDR_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\/(\d{1,2})$/;
// block lists are parsed and built in slices of this many lines, with a turn
// of the event loop in between (a list has up to LIST_MAX_ENTRIES lines)
const SLICE = 2000;
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

function v4num(a) { const b = a.octets; return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }
function mask32(bits) { return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; }
function v6key(a, bits) {
  const bytes = a.toByteArray();
  let out = '';
  for (let i = 0; i < 16; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    out += String.fromCharCode(bytes[i] & (keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff));
  }
  return bits + ':' + out;
}

function processAddr(ip) {
  try { return ipaddr.process(String(ip)); } catch { return null; }
}

// ─── Settings ──────────────────────────────────────────

function readJson(key, fallback) {
  try {
    const raw = settings.get(key, null);
    if (raw == null || raw === '') return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

function getConfig() {
  const raw = readJson(K_CONFIG, {});
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULTS.enabled,
    threshold: Number.isInteger(c.threshold) && c.threshold >= 3 && c.threshold <= 1000 ? c.threshold : DEFAULTS.threshold,
    window_min: WINDOWS_MIN.includes(c.window_min) ? c.window_min : DEFAULTS.window_min,
    unknown_user_weight: UNKNOWN_WEIGHTS.includes(c.unknown_user_weight) ? c.unknown_user_weight : DEFAULTS.unknown_user_weight,
    notify: typeof c.notify === 'boolean' ? c.notify : DEFAULTS.notify,
    sources: { ...DEFAULTS.sources },
    lists: { ...DEFAULTS.lists },
    durations_min: DURATIONS_MIN.slice(),
  };
  for (const s of SOURCES) if (c.sources && typeof c.sources[s] === 'boolean') out.sources[s] = c.sources[s];
  for (const l of LISTS) if (c.lists && typeof c.lists[l] === 'boolean') out.lists[l] = c.lists[l];
  return out;
}

function bool(v, field) {
  if (typeof v === 'boolean') return v;
  throw new IpBlockError('invalid', `${field} must be true or false`, 400, field);
}

/** Validate and store a partial config. → the new config. */
function setConfig(input, { licensed = listsLicensed() } = {}) {
  const b = input && typeof input === 'object' ? input : {};
  const cur = getConfig();
  const next = {
    enabled: cur.enabled, threshold: cur.threshold, window_min: cur.window_min, unknown_user_weight: cur.unknown_user_weight,
    notify: cur.notify, sources: { ...cur.sources }, lists: { ...cur.lists },
  };
  if (b.enabled !== undefined) next.enabled = bool(b.enabled, 'enabled');
  if (b.notify !== undefined) next.notify = bool(b.notify, 'notify');
  if (b.threshold !== undefined) {
    const n = Number(b.threshold);
    if (!Number.isInteger(n) || n < 3 || n > 1000) throw new IpBlockError('invalid', 'threshold must be an integer between 3 and 1000', 400, 'threshold');
    next.threshold = n;
  }
  if (b.window_min !== undefined) {
    const n = Number(b.window_min);
    if (!WINDOWS_MIN.includes(n)) throw new IpBlockError('invalid', 'window_min must be 10 or 60', 400, 'window_min');
    next.window_min = n;
  }
  if (b.unknown_user_weight !== undefined) {
    const n = typeof b.unknown_user_weight === 'boolean' ? NaN : Number(b.unknown_user_weight);
    if (!UNKNOWN_WEIGHTS.includes(n)) {
      throw new IpBlockError('invalid', `unknown_user_weight must be one of ${UNKNOWN_WEIGHTS.join(', ')}`, 400, 'unknown_user_weight');
    }
    next.unknown_user_weight = n;
  }
  if (b.sources !== undefined) {
    if (!b.sources || typeof b.sources !== 'object') throw new IpBlockError('invalid', 'sources must be an object', 400, 'sources');
    const unknown = Object.keys(b.sources).find((k) => !SOURCES.includes(k));
    if (unknown !== undefined) throw new IpBlockError('invalid', `unknown source ${String(unknown).slice(0, 32)}`, 400, 'sources');
    for (const src of SOURCES) {
      if (Object.prototype.hasOwnProperty.call(b.sources, src)) next.sources[src] = bool(b.sources[src], `sources.${src}`);
    }
  }
  const listsBefore = { ...next.lists };
  if (b.lists !== undefined) {
    if (!b.lists || typeof b.lists !== 'object') throw new IpBlockError('invalid', 'lists must be an object', 400, 'lists');
    const unknownList = Object.keys(b.lists).find((k) => !LISTS.includes(k));
    if (unknownList !== undefined) throw new IpBlockError('invalid', `unknown list ${String(unknownList).slice(0, 32)}`, 400, 'lists');
    for (const id of LISTS) {
      if (!Object.prototype.hasOwnProperty.call(b.lists, id)) continue;
      const on = bool(b.lists[id], `lists.${id}`);
      if (on && !listsBefore[id] && !licensed) throw Object.assign(new IpBlockError('license', 'block lists need a licence with ip_blocklists', 403, 'lists'), { feature: 'ip_blocklists' });
      next.lists[id] = on;
    }
  }
  settings.set(K_CONFIG, JSON.stringify(next));
  rebuild();
  // a list switched on: fetch it now (in the background)
  const turnedOn = LISTS.filter((l) => next.lists[l] && !cur.lists[l]);
  if (turnedOn.length && licensed && !_state.testMode) setImmediate(() => { refreshLists({ only: turnedOn }).catch(() => {}); });
  return getConfig();
}

function listsLicensed() {
  try { return require('./license').hasFeature('ip_blocklists'); } catch { return false; }
}

// ─── Exceptions ("Nie sperren") ────────────────────────

function vpnSubnet() {
  const p = parseAddress(config.wireguard.subnet);
  return p ? p.text : null;
}

function getNever() {
  const list = readJson(K_NEVER, []);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    const p = parseAddress(e && e.ip);
    if (p && !out.some((x) => x.ip === p.text)) out.push({ ip: p.text, label: e && typeof e.label === 'string' ? e.label.slice(0, 60) : '' });
  }
  return out.slice(0, NEVER_MAX);
}

function wafTrusted() {
  try { return require('./wafBans').getSettings().trusted_ips; } catch { return []; }
}

/** Every exception: the VPN subnet, own networks, the WAF's own addresses. */
function exceptions() {
  const out = [];
  const vpn = vpnSubnet();
  if (vpn) out.push({ ip: vpn, label: '', kind: 'vpn' });
  for (const n of getNever()) out.push({ ...n, kind: 'own' });
  for (const t of wafTrusted()) if (!out.some((x) => x.ip === t)) out.push({ ip: t, label: '', kind: 'waf' });
  return out;
}

function addNever({ ip, label } = {}) {
  const p = parseAddress(ip);
  if (!p) throw new IpBlockError('invalid', 'not an IP address or CIDR range', 400, 'ip');
  const list = getNever();
  if (list.some((x) => x.ip === p.text)) throw new IpBlockError('exists', 'already in the list', 409, 'ip');
  if (list.length >= NEVER_MAX) throw new IpBlockError('too_many', `at most ${NEVER_MAX} entries`, 400, 'ip');
  list.push({ ip: p.text, label: typeof label === 'string' ? label.trim().slice(0, 60) : '' });
  settings.set(K_NEVER, JSON.stringify(list));
  // an address that is now an exception is no longer banned
  const ex = buildSet([p]);
  const lifted = db().prepare('SELECT ip FROM ip_blocks').all().filter((r) => {
    const rp = parseAddress(r.ip);
    return rp && (ex.has(rp.addr) || (!rp.single && rp.kind === p.kind && p.addr.match(rp.addr, rp.prefix)));
  });
  for (const r of lifted) db().prepare('DELETE FROM ip_blocks WHERE ip = ?').run(r.ip);
  rebuild();
  return { never: getNever(), lifted: lifted.map((r) => r.ip) };
}

function removeNever(ip) {
  const p = parseAddress(ip);
  const list = getNever();
  const next = list.filter((x) => !p || x.ip !== p.text);
  if (next.length === list.length) throw new IpBlockError('not_found', 'not in the list', 404, 'ip');
  settings.set(K_NEVER, JSON.stringify(next));
  rebuild();
  return getNever();
}

// ─── The block set ─────────────────────────────────────

const _state = {
  exempt: new PrefixSet(),
  banned: new PrefixSet(),
  listed: new Map(), // list id → PrefixSet
  listEntries: new Map(), // list id → [cidr text]
  listSets: new Map(), // list id → { entries, set } — the set built from exactly that array
  listText: new Map(), // list id → { entries, text } — its lines for the block file
  writing: false,
  writeAgain: false,
  writeTimer: null,
  sweepTimer: null,
  tailTimer: null,
  listTimer: null,
  tail: null,
  scan404: new Map(),
  massAt: 0,
  massNotified: 0,
  testMode: process.env.NODE_ENV === 'test',
  engine: null,
  fetch: null,
  blockFile: null,
  dataDir: null,
};

function buildSet(parsed) {
  const s = new PrefixSet();
  for (const p of parsed) s.add(p);
  return s;
}

function activeBans(at = now()) {
  return db().prepare('SELECT * FROM ip_blocks WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC').all(at);
}

/** The set of a block list's entries — built once per list content (a ban never rebuilds it). */
function listSet(id) {
  const entries = _state.listEntries.get(id) || [];
  const c = _state.listSets.get(id);
  if (c && c.entries === entries) return c.set;
  const set = new PrefixSet();
  for (const e of entries) set.addText(e);
  _state.listSets.set(id, { entries, set });
  return set;
}

/** listSet() in slices with turns of the event loop in between (after a download). */
async function buildListSet(entries) {
  const set = new PrefixSet();
  for (let i = 0; i < entries.length; i += SLICE) {
    if (i) await yieldLoop();
    for (const e of entries.slice(i, i + SLICE)) set.addText(e);
  }
  return { entries, set };
}

/**
 * Rebuild the in-memory sets and (debounced) the file Caddy reads. Bans and
 * exceptions are read again; the block lists keep their sets until their
 * content changes (a list has up to 200 000 entries — rebuilding them on
 * every ban blocked the server for seconds per ban).
 */
function rebuild() {
  require('../utils/loopStall').withTask('ipblock.rebuild', () => {
    try {
      const cfg = getConfig();
      _state.exempt = buildSet(exceptions().map((e) => parseAddress(e.ip)).filter(Boolean));
      _state.banned = cfg.enabled ? buildSet(activeBans().map((b) => parseAddress(b.ip)).filter(Boolean)) : new PrefixSet();
      const licensed = listsLicensed();
      for (const id of LISTS) {
        if (!(cfg.enabled && licensed && cfg.lists[id])) { _state.listed.delete(id); continue; }
        if (!_state.listEntries.has(id)) loadListFile(id);
        _state.listed.set(id, listSet(id));
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'ip block: rebuild failed');
    }
  });
  scheduleWrite();
}

/**
 * Is `ip` blocked? → null or { by: 'ban' | <list id> }. Exceptions and
 * non-public addresses are never blocked.
 */
function check(ip) {
  const a = processAddr(ip);
  if (!a || a.range() !== 'unicast') return null;
  if (_state.exempt.has(a)) return null;
  if (_state.banned.has(a)) return { by: 'ban' };
  for (const [id, set] of _state.listed) if (set.has(a)) return { by: id };
  return null;
}

function isExempt(ip) {
  const a = processAddr(ip);
  if (!a || a.range() !== 'unicast') return true;
  return _state.exempt.has(a);
}

// ─── The file for Caddy ────────────────────────────────

function blockFile() { return _state.blockFile || path.join(config.caddy.dataDir || '/data/caddy', 'ipblock.list'); }

/** The content of the block file (exceptions first). */
function fileContent() {
  const cfg = getConfig();
  const lines = ['# GateControl IP-Sperre — written by GateControl, read by http.matchers.gc_ipblock', '# ! = never blocked'];
  for (const e of exceptions()) { const p = parseAddress(e.ip); if (p) lines.push('!' + cidrText(p)); }
  if (cfg.enabled) {
    for (const b of activeBans()) { const p = parseAddress(b.ip); if (p) lines.push(cidrText(p)); }
    const licensed = listsLicensed();
    for (const id of LISTS) {
      if (!licensed || !cfg.lists[id]) continue;
      lines.push(`# list ${id}`);
      const text = listText(id);
      if (text) lines.push(text);
    }
  }
  return lines.join('\n') + '\n';
}

/** The lines of a block list for the file, joined once per list content. */
function listText(id) {
  const entries = _state.listEntries.get(id) || [];
  const c = _state.listText.get(id);
  if (c && c.entries === entries) return c.text;
  const text = entries.join('\n');
  _state.listText.set(id, { entries, text });
  return text;
}

function writeNow() {
  const file = blockFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, fileContent(), { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn({ err: err.message, file }, 'ip block: cannot write the block file');
  }
}

/** writeNow() without synchronous file I/O (the debounced writes after a change); one at a time. */
async function writeLater() {
  if (_state.writing) { _state.writeAgain = true; return; }
  _state.writing = true;
  const file = blockFile();
  try {
    do {
      _state.writeAgain = false;
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(tmp, fileContent(), { mode: 0o644 });
        await fs.promises.rename(tmp, file);
      } catch (err) {
        fs.promises.rm(tmp, { force: true }).catch(() => {});
        logger.warn({ err: err.message, file }, 'ip block: cannot write the block file');
      }
    } while (_state.writeAgain);
  } finally { _state.writing = false; }
}

function scheduleWrite() {
  if (_state.writeTimer) return;
  _state.writeTimer = setTimeout(() => { _state.writeTimer = null; writeLater(); }, _state.testMode ? 0 : 500);
  if (_state.writeTimer.unref) _state.writeTimer.unref();
}

// ─── Caddy ─────────────────────────────────────────────

const MODULE = 'http.matchers.gc_ipblock';

/** true when the Caddy binary has the matcher (caddy list-modules, cached; GC_IPBLOCK_ENGINE=1|0 forces it). */
function engineAvailable() {
  if (_state.engine !== null) return _state.engine;
  const env = process.env.GC_IPBLOCK_ENGINE;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false' || process.env.NODE_ENV === 'test') return false;
  try {
    const out = require('node:child_process').execFileSync('caddy', ['list-modules'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    _state.engine = out.split('\n').some((l) => l.trim() === MODULE);
  } catch (err) {
    logger.warn({ err: err.message }, 'ip block: caddy list-modules failed');
    _state.engine = false;
  }
  if (!_state.engine) logger.warn('ip block: the Caddy binary has no http.matchers.gc_ipblock — only GateControl itself checks the block');
  return _state.engine;
}

/**
 * The first route of srv0, or null (IP block off or no matcher in Caddy —
 * the config then stays byte-identical). The ACME challenge stays open.
 */
function caddyRoute() {
  if (!getConfig().enabled) return null;
  if (!engineAvailable()) return null;
  return {
    '@id': 'gc_ip_block',
    match: [{ gc_ipblock: { file: blockFile() }, not: [{ path: ['/.well-known/acme-challenge/*'] }] }],
    handle: [{
      handler: 'static_response',
      status_code: 403,
      headers: { 'Content-Type': ['text/plain; charset=utf-8'], 'Cache-Control': ['no-store'], 'X-Gc-Block': ['1'] },
      body: 'Forbidden — this address is blocked. / Gesperrt — diese Adresse ist gesperrt.\n',
    }],
    terminal: true,
  };
}

/** Bans as CIDR ranges for the layer-4 listeners (lists stay HTTP-only). */
function l4Ranges() {
  try {
    if (!getConfig().enabled) return [];
    return activeBans().map((b) => parseAddress(b.ip)).filter(Boolean).map(cidrText);
  } catch { return []; }
}

// ─── Failures and bans ─────────────────────────────────

function strikeLevel(ip, at) {
  const s = db().prepare('SELECT * FROM ip_block_strikes WHERE ip = ?').get(ip);
  const strikes = s && at - s.last_ban_at < STRIKE_MEMORY_MS ? s.strikes + 1 : 1;
  return Math.min(3, strikes);
}

/**
 * What the failures of one address were: points per source (`by`), the main
 * source, what was tried, the number of attempts, and how many of them (and
 * their points) were names without an account. `unknownMain`: those names
 * brought more than half of the points.
 */
function summary(rows) {
  const by = {};
  const targets = new Set();
  let points = 0;
  let unknown = 0;
  let unknownPoints = 0;
  for (const r of rows) {
    const w = Number(r.weight) > 0 ? Number(r.weight) : 1;
    by[r.source] = (by[r.source] || 0) + w;
    points += w;
    if (r.unknown_user) { unknown++; unknownPoints += w; }
    if (r.detail) targets.add(r.detail);
  }
  const main = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  return {
    by, main: main ? main[0] : null, targets: [...targets].slice(0, 5), targetCount: targets.size,
    points, attempts: rows.length, unknown, unknownPoints, unknownMain: unknownPoints * 2 > points,
  };
}

function activity(type, message, details, severity = 'info') {
  try { require('./activity').log(type, message, { source: 'system', severity, ipAddress: details && details.ip, details }); } catch { /* best-effort */ }
}

function publish(kind, ip) {
  try { require('./eventBus').publish('ipblock', { kind, ip }); } catch { /* best-effort */ }
  // layer-4 listeners carry the bans in their config: a coalesced sync (at
  // most one a minute, shared with the WAF bans) — only when there are any
  try {
    if (!_state.testMode && db().prepare("SELECT 1 FROM routes WHERE route_type = 'l4' AND enabled = 1 LIMIT 1").get()) {
      require('./wafBans').scheduleBanSync();
    }
  } catch { /* best-effort */ }
}

/** Ban `ip` automatically after its failures. → the ban row or null. */
function autoBan(ip, rows, at) {
  const cfg = getConfig();
  const autoCount = db().prepare('SELECT COUNT(*) AS n FROM ip_blocks WHERE manual = 0 AND (expires_at IS NULL OR expires_at > ?)').get(at).n;
  if (autoCount >= MAX_AUTO_BANS) {
    logger.warn({ ip, max: MAX_AUTO_BANS }, 'ip block: limit of automatic bans reached');
    return null;
  }
  const level = strikeLevel(ip, at);
  const minutes = DURATIONS_MIN[level - 1];
  const sum = summary(rows);
  const row = {
    ip, manual: 0, level, reason: sum.main || 'login',
    detail: JSON.stringify({
      by: sum.by, targets: sum.targets, targetCount: sum.targetCount,
      attempts: sum.attempts, unknown: sum.unknown, unknownPoints: sum.unknownPoints, unknownMain: sum.unknownMain,
    }),
    hits: sum.points, created_at: at, expires_at: at + minutes * 60e3, created_by: null,
  };
  db().transaction(() => {
    db().prepare(`INSERT OR REPLACE INTO ip_blocks (ip, manual, level, reason, detail, hits, created_at, expires_at, created_by)
      VALUES (@ip, @manual, @level, @reason, @detail, @hits, @created_at, @expires_at, @created_by)`).run(row);
    db().prepare(`INSERT INTO ip_block_strikes (ip, strikes, last_ban_at) VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET strikes = excluded.strikes, last_ban_at = excluded.last_ban_at`).run(ip, level, at);
    db().prepare('DELETE FROM ip_block_failures WHERE ip = ?').run(ip);
  })();
  rebuild();
  publish('ban', ip);
  const details = { ip, level, reason: row.reason, hits: row.hits, duration_min: minutes, sources: sum.by, targets: sum.targets };
  if (sum.unknown) { details.unknown_users = sum.unknown; details.unknown_main = sum.unknownMain; }
  const msg = `IP ${ip} blocked for ${minutes} min (${row.hits} failures, ${row.reason}${sum.unknownMain ? ', mostly unknown user names' : ''})`;
  if (level === 3 && cfg.notify) activity('ip_blocked_day', msg, details, 'warning');
  else activity('ip_blocked', msg, details, level === 3 ? 'warning' : 'info');
  noteMass(at, cfg);
  lookupCountryLater(ip);
  return row;
}

function noteMass(at, cfg) {
  if (!cfg.notify) return;
  const n = db().prepare('SELECT COUNT(*) AS n FROM ip_blocks WHERE manual = 0 AND created_at > ?').get(at - MASS_WINDOW_MS).n;
  if (n >= MASS_BANS && at - _state.massNotified > 3600e3) {
    _state.massNotified = at;
    activity('ip_block_mass', `${n} addresses blocked within 10 minutes`, { count: n, minutes: 10 }, 'warning');
  }
}

/** The country of a banned address (ip2location.io, only with a key; cached there). */
function lookupCountryLater(ip) {
  if (_state.testMode) return;
  try { if (!settings.get('ip2location.api_key', '')) return; } catch { return; }
  setImmediate(async () => {
    try {
      const cc = await require('./ipFilter').lookupCountry(ip);
      if (!cc) return;
      const r = db().prepare('SELECT detail FROM ip_blocks WHERE ip = ?').get(ip);
      if (!r) return;
      let d = {};
      try { d = JSON.parse(r.detail || '{}'); } catch { d = {}; }
      d.country = String(cc).slice(0, 2).toUpperCase();
      db().prepare('UPDATE ip_blocks SET detail = ? WHERE ip = ?').run(JSON.stringify(d), ip);
    } catch { /* best-effort */ }
  });
}

/** The points of one failure: `weight` (1 … 50), or the setting for a name without an account. */
function weightOf(cfg, source, { weight = 1, unknownUser = false } = {}) {
  if (unknownUser && WEIGHTED_SOURCES.includes(source)) return cfg.unknown_user_weight;
  const w = Math.floor(Number(weight));
  return Number.isFinite(w) ? Math.max(1, Math.min(50, w)) : 1;
}

/**
 * One failure of `ip` at entry point `source` (`detail`: what was tried — an
 * account, a host, a link; short text, no secrets). `unknownUser`: a login
 * (login, route_auth) with a name that matches no account — counts with
 * `unknown_user_weight`. Bans when the points in the window reach the
 * threshold. Never throws. → true when this failure banned the address.
 */
function noteFailure(ip, source, detail = null, { weight = 1, unknownUser = false, at = now() } = {}) {
  try {
    if (!SOURCES.includes(source)) return false;
    const cfg = getConfig();
    if (!cfg.enabled || !cfg.sources[source]) return false;
    const canon = canonIp(ip);
    if (!canon || !isPublicIp(canon) || isExempt(canon)) return false;
    if (_state.banned.has(processAddr(canon))) return false;
    const d = detail == null ? null : String(detail).replace(/[\r\n\t]/g, ' ').slice(0, 120);
    const unknown = !!unknownUser && WEIGHTED_SOURCES.includes(source);
    db().prepare('INSERT INTO ip_block_failures (ip, source, detail, at, weight, unknown_user) VALUES (?, ?, ?, ?, ?, ?)')
      .run(canon, source, d, at, weightOf(cfg, source, { weight, unknownUser: unknown }), unknown ? 1 : 0);
    const since = at - cfg.window_min * 60e3;
    const rows = db().prepare('SELECT source, detail, weight, unknown_user FROM ip_block_failures WHERE ip = ? AND at > ?').all(canon, since);
    if (rows.reduce((n, r) => n + (Number(r.weight) > 0 ? Number(r.weight) : 1), 0) < cfg.threshold) return false;
    return !!autoBan(canon, rows, at);
  } catch (err) {
    logger.warn({ err: err.message }, 'ip block: failure not counted');
    return false;
  }
}

/** Manual ban { ip, hours (null = permanent), note }. */
function banManual({ ip, hours = null, note = '' } = {}, userId = null) {
  const p = parseAddress(ip);
  if (!p) throw new IpBlockError('invalid', 'not an IP address or CIDR range', 400, 'ip');
  if (!p.single && p.prefix < MIN_PREFIX[p.kind]) throw new IpBlockError('too_wide', `ranges wider than /${MIN_PREFIX[p.kind]} cannot be blocked`, 400, 'ip');
  if (p.addr.range() !== 'unicast') throw new IpBlockError('not_public', 'only public addresses can be blocked', 400, 'ip');
  const ex = exceptions().map((e) => parseAddress(e.ip)).filter(Boolean);
  if (ex.some((e) => e.kind === p.kind && (p.addr.match(e.addr, e.prefix) || e.addr.match(p.addr, p.prefix)))) {
    throw new IpBlockError('exempt', 'this address is never blocked (VPN, own networks)', 409, 'ip');
  }
  let h = null;
  if (hours !== null && hours !== undefined && hours !== '') {
    h = Number(hours);
    if (!MANUAL_HOURS.includes(h)) throw new IpBlockError('invalid', `hours must be one of ${MANUAL_HOURS.join(', ')} or null`, 400, 'hours');
  }
  const at = now();
  const row = {
    ip: p.text, manual: 1, level: 0, reason: 'manual',
    detail: JSON.stringify({ note: typeof note === 'string' ? note.trim().slice(0, 120) : '' }),
    hits: null, created_at: at, expires_at: h ? at + h * 3600e3 : null, created_by: userId,
  };
  db().prepare(`INSERT OR REPLACE INTO ip_blocks (ip, manual, level, reason, detail, hits, created_at, expires_at, created_by)
    VALUES (@ip, @manual, @level, @reason, @detail, @hits, @created_at, @expires_at, @created_by)`).run(row);
  rebuild();
  publish('ban', p.text);
  activity('ip_blocked', `IP ${p.text} blocked by hand${h ? ` for ${h} h` : ' permanently'}`, { ip: p.text, manual: true, hours: h }, 'info');
  return toApi(row);
}

function unban(ip) {
  const p = parseAddress(ip);
  if (!p) throw new IpBlockError('invalid', 'not an IP address or CIDR range', 400, 'ip');
  const r = db().prepare('SELECT * FROM ip_blocks WHERE ip = ?').get(p.text);
  if (!r) throw new IpBlockError('not_found', 'not blocked', 404, 'ip');
  db().prepare('DELETE FROM ip_blocks WHERE ip = ?').run(p.text);
  db().prepare('DELETE FROM ip_block_failures WHERE ip = ?').run(p.text);
  rebuild();
  publish('unban', p.text);
  activity('ip_unblocked', `IP ${p.text} unblocked`, { ip: p.text }, 'info');
  return toApi(r);
}

function toApi(r) {
  let d = {};
  try { d = JSON.parse(r.detail || '{}') || {}; } catch { d = {}; }
  return {
    ip: r.ip, manual: !!r.manual, level: r.level, reason: r.reason, hits: r.hits == null ? null : r.hits,
    sources: d.by || {}, targets: Array.isArray(d.targets) ? d.targets : [], targetCount: d.targetCount || 0,
    attempts: Number.isInteger(d.attempts) ? d.attempts : null,
    unknownUsers: Number.isInteger(d.unknown) ? d.unknown : 0, unknownMain: d.unknownMain === true,
    note: d.note || '', country: d.country || null,
    createdAt: new Date(r.created_at).toISOString(), expiresAt: r.expires_at == null ? null : new Date(r.expires_at).toISOString(),
    createdBy: r.created_by == null ? null : r.created_by,
  };
}

function listBans() { return activeBans().map(toApi); }

/** Backup: the bans set by hand that are still in force. */
function exportBackup() {
  return activeBans().filter((b) => b.manual).map((b) => ({ ip: b.ip, reason: b.reason, detail: b.detail, created_at: b.created_at, expires_at: b.expires_at }));
}

function restoreBackup(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const b of list) {
    const p = parseAddress(b && b.ip);
    if (!p) continue;
    const exp = b.expires_at == null ? null : Number(b.expires_at);
    if (exp != null && !(exp > now())) continue;
    db().prepare(`INSERT OR REPLACE INTO ip_blocks (ip, manual, level, reason, detail, hits, created_at, expires_at, created_by)
      VALUES (?, 1, 0, 'manual', ?, NULL, ?, ?, NULL)`).run(p.text, typeof b.detail === 'string' ? b.detail.slice(0, 500) : null, Number(b.created_at) || now(), exp);
    n++;
  }
  rebuild();
  return n;
}

// ─── Block lists ───────────────────────────────────────

function dataDir() { return _state.dataDir || path.join(process.env.GC_DATA_DIR || process.env.GC_DATA_PATH || '/data', 'ipblock'); }
function listFile(id) { return path.join(dataDir(), `${id}.txt`); }

function loadListFile(id) {
  try {
    const text = fs.readFileSync(listFile(id), 'utf8');
    _state.listEntries.set(id, text.split('\n').filter((l) => l && !l.startsWith('#')).slice(0, LIST_MAX_ENTRIES));
  } catch { _state.listEntries.set(id, []); }
}

function listsState() {
  const s = readJson(K_LISTS, {});
  return s && typeof s === 'object' ? s : {};
}

function setListState(id, patch) {
  const s = listsState();
  s[id] = { ...(s[id] || {}), ...patch };
  settings.set(K_LISTS, JSON.stringify(s));
}

/** Lines of a downloaded list into `out` (Set of canonical CIDR texts; public ranges only). */
function parseLines(format, lines, out) {
  const add = (v) => {
    const p = parseAddress(v);
    if (!p || p.addr.range() !== 'unicast') return;
    if (!p.single && p.prefix < (p.kind === 'ipv4' ? 8 : 16)) return;
    if (out.size < LIST_MAX_ENTRIES) out.add(cidrText(p));
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (format === 'drop-json') {
      let o = null;
      try { o = JSON.parse(line); } catch { o = null; }
      if (o && typeof o.cidr === 'string') add(o.cidr);
    } else {
      add(line.split(/[\s;,#]/)[0]);
    }
  }
}

/** Entries of one downloaded text → canonical CIDR texts (public ranges only, no duplicates). */
function parseList(format, text) {
  const out = new Set();
  parseLines(format, String(text).split('\n'), out);
  return [...out];
}

/** parseList() in slices with turns of the event loop in between (a list has up to 8 MB). */
async function parseListAsync(format, text) {
  const lines = String(text).split('\n');
  const out = new Set();
  for (let i = 0; i < lines.length; i += SLICE) {
    if (i) await yieldLoop();
    parseLines(format, lines.slice(i, i + SLICE), out);
  }
  return [...out];
}

async function download(url) {
  const f = _state.fetch || globalThis.fetch;
  const res = await f(url, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS), headers: { 'User-Agent': 'GateControl IP-Sperre' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
  if (len > LIST_MAX_BYTES) throw new Error('list too large');
  if (!res.body || typeof res.body.getReader !== 'function') return String(await res.text()).slice(0, LIST_MAX_BYTES);
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIST_MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('list too large'); }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Download the switched-on lists (or `only`). Each list on its own: a failed
 * download keeps the previous file. `force` ignores the one-hour gap.
 * → { <id>: { ok, count?, error? } }
 */
async function refreshLists({ only = null, force = false } = {}) {
  const cfg = getConfig();
  const out = {};
  if (!listsLicensed()) return out;
  const ids = (only || LISTS).filter((id) => cfg.lists[id]);
  for (const id of ids) {
    const st = listsState()[id] || {};
    if (!force && st.tried_at && now() - st.tried_at < LIST_MIN_GAP_MS) { out[id] = { ok: true, skipped: true, count: st.count || 0 }; continue; }
    setListState(id, { tried_at: now() });
    try {
      const src = LIST_SOURCES[id];
      const texts = [];
      for (const u of src.urls) texts.push(await download(u));
      const entries = await parseListAsync(src.format, texts.join('\n'));
      if (entries.length === 0) throw new Error('empty list');
      await fs.promises.mkdir(dataDir(), { recursive: true });
      const tmp = listFile(id) + '.tmp';
      const head = id === 'drop' ? '# Spamhaus DROP — (c) The Spamhaus Project, https://www.spamhaus.org/drop/\n' : `# ${src.urls.join(' ')}\n`;
      await fs.promises.writeFile(tmp, head + `# fetched ${new Date().toISOString()}\n` + entries.join('\n') + '\n');
      await fs.promises.rename(tmp, listFile(id));
      // the set is built here in slices; rebuild() below only takes it
      _state.listSets.set(id, await buildListSet(entries));
      _state.listEntries.set(id, entries);
      setListState(id, { count: entries.length, updated_at: now(), error: null });
      out[id] = { ok: true, count: entries.length };
    } catch (err) {
      setListState(id, { error: String(err && err.message || err).slice(0, 200) });
      logger.warn({ list: id, err: err && err.message }, 'ip block: list not updated');
      out[id] = { ok: false, error: String(err && err.message || err).slice(0, 200) };
    }
  }
  rebuild();
  return out;
}

// ─── Access log (404 scans, 429, hits of the block) ────

function noteAccessLines(lines, at = now()) {
  const cfg = getConfig();
  const counts = new Map();
  let blocked = 0;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const status = Number(e.status);
    const req = e.request || {};
    const ip = req.client_ip || req.remote_ip;
    if (status === 403 && e.resp_headers && e.resp_headers['X-Gc-Block']) { blocked++; continue; }
    if (!ip || !cfg.enabled) continue;
    if (status === 404 && cfg.sources.scan) {
      const uri = String(req.uri || '').split('?')[0];
      const host = String(req.host || '').split(':')[0].toLowerCase();
      if (PROBE_RE.test(uri)) noteFailure(ip, 'scan', `${host}${uri}`.slice(0, 120), { at });
      else {
        const k = `${ip}`;
        const c = (counts.get(k) || 0) + 1;
        counts.set(k, c);
      }
    } else if (status === 429 && cfg.sources.rate_limit) {
      noteFailure(ip, 'rate_limit', String(req.host || '').split(':')[0].toLowerCase().slice(0, 120), { at });
    }
  }
  // any other 404s: every ten from one address count once (kept across ticks)
  for (const [ip, c] of counts) {
    const total = (_state.scan404.get(ip) || 0) + c;
    const n = Math.floor(total / SCAN_404_PER_FAILURE);
    _state.scan404.set(ip, total % SCAN_404_PER_FAILURE);
    if (n > 0) noteFailure(ip, 'scan', null, { weight: n, at });
  }
  if (_state.scan404.size > 20000) _state.scan404.clear();
  if (blocked) addBlockedHits(blocked, at);
  return blocked;
}

// Requests turned away by the block, per hour (last 25 hours), for the tile.
const _hits = new Map();
function addBlockedHits(n, at = now()) {
  const h = Math.floor(at / 3600e3);
  _hits.set(h, (_hits.get(h) || 0) + n);
  for (const k of _hits.keys()) if (k < h - 25) _hits.delete(k);
}
function blockedLast24h(at = now()) {
  const h = Math.floor(at / 3600e3);
  let n = 0;
  for (const [k, v] of _hits) if (k > h - 24) n += v;
  return n;
}

async function tailTick() {
  if (!_state.tail) {
    const { createLogTail } = require('../utils/logTail');
    _state.tail = createLogTail(path.join(config.caddy.dataDir || '/data/caddy', 'access.log'));
  }
  try {
    const lines = await _state.tail.readNewLines();
    if (lines.length) require('../utils/loopStall').withTask('ipblock.accessLog', () => noteAccessLines(lines));
  } catch (err) { logger.debug({ err: err.message }, 'ip block: access log not read'); }
}

// ─── Sweep ─────────────────────────────────────────────

function sweep(at = now()) {
  try {
    const gone = db().prepare('SELECT ip FROM ip_blocks WHERE expires_at IS NOT NULL AND expires_at <= ?').all(at);
    if (gone.length) {
      db().prepare('DELETE FROM ip_blocks WHERE expires_at IS NOT NULL AND expires_at <= ?').run(at);
      for (const g of gone) publish('unban', g.ip);
      rebuild();
    }
    db().prepare('DELETE FROM ip_block_failures WHERE at < ?').run(at - 2 * 3600e3);
    db().prepare('DELETE FROM ip_block_strikes WHERE last_ban_at < ?').run(at - 30 * 86400e3);
    return gone.length;
  } catch (err) {
    logger.warn({ err: err.message }, 'ip block: sweep failed');
    return 0;
  }
}

// ─── State for the page ────────────────────────────────

function stats(at = now()) {
  const bans = activeBans(at);
  const fails = db().prepare('SELECT COALESCE(SUM(weight), 0) AS n, COUNT(DISTINCT ip) AS ips FROM ip_block_failures WHERE at > ?').get(at - 86400e3);
  // failures that led to a ban were removed from the table: add the hits of bans of the last 24 h
  const banned24 = db().prepare('SELECT COALESCE(SUM(hits), 0) AS n, COUNT(*) AS ips FROM ip_blocks WHERE manual = 0 AND created_at > ?').get(at - 86400e3);
  const ls = listsState();
  const cfg = getConfig();
  const licensed = listsLicensed();
  return {
    blocked: bans.length,
    blockedDay: bans.filter((b) => b.level === 3).length,
    blockedManual: bans.filter((b) => b.manual).length,
    failures24h: fails.n + banned24.n,
    failureIps24h: fails.ips + banned24.ips,
    blockedHits24h: blockedLast24h(at),
    exceptions: exceptions().length,
    lists: LISTS.map((id) => ({
      id, on: cfg.lists[id], licensed,
      count: (_state.listEntries.get(id) || []).length || (ls[id] && ls[id].count) || 0,
      updatedAt: ls[id] && ls[id].updated_at ? new Date(ls[id].updated_at).toISOString() : null,
      error: ls[id] && ls[id].error ? ls[id].error : null,
    })),
  };
}

/** GET /api/v1/settings/ip-block */
function view() {
  return {
    config: getConfig(),
    never: getNever(),
    exceptions: exceptions(),
    vpnSubnet: vpnSubnet(),
    bans: listBans(),
    stats: stats(),
    engine: engineAvailable(),
    licensed: listsLicensed(),
    manualHours: MANUAL_HOURS,
  };
}

// ─── Express ───────────────────────────────────────────

/**
 * Early middleware of the app: a blocked address gets 403 for everything
 * GateControl serves (admin, portal, login, route login, public links).
 */
function middleware(req, res, next) {
  let hit = null;
  try { hit = check(req.ip); } catch { hit = null; }
  if (!hit) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Gc-Block', '1');
  return res.status(403).type('text/plain').send('Forbidden — this address is blocked. / Gesperrt — diese Adresse ist gesperrt.\n');
}

// ─── Lifecycle ─────────────────────────────────────────

function start() {
  rebuild();
  writeNow();
  setImmediate(() => { try { engineAvailable(); } catch { /* logged */ } });
  if (!_state.sweepTimer) {
    _state.sweepTimer = setInterval(() => require('../utils/loopStall').withTask('ipblock.sweep', () => sweep()), SWEEP_MS);
    if (_state.sweepTimer.unref) _state.sweepTimer.unref();
  }
  if (!_state.tailTimer) {
    _state.tailTimer = setInterval(require('../utils/loopStall').task('ipblock.tail', () => tailTick()), TAIL_MS);
    if (_state.tailTimer.unref) _state.tailTimer.unref();
  }
  if (!_state.listTimer) {
    const due = () => {
      const ls = listsState();
      const cfg = getConfig();
      const stale = LISTS.filter((id) => cfg.lists[id] && (!ls[id] || !ls[id].updated_at || now() - ls[id].updated_at > LIST_REFRESH_MS));
      if (stale.length) require('../utils/loopStall').withTask('ipblock.lists', () => refreshLists({ only: stale })).catch(() => {});
    };
    _state.listTimer = setInterval(due, 3600e3);
    if (_state.listTimer.unref) _state.listTimer.unref();
    setTimeout(due, 60e3).unref();
  }
}

function stop() {
  for (const k of ['sweepTimer', 'tailTimer', 'listTimer']) if (_state[k]) { clearInterval(_state[k]); _state[k] = null; }
  if (_state.writeTimer) { clearTimeout(_state.writeTimer); _state.writeTimer = null; }
}

function _resetForTest({ fetch = null, blockFile: bf = null, dataDir: dd = null, engine = null } = {}) {
  stop();
  _state.fetch = fetch;
  _state.blockFile = bf;
  _state.dataDir = dd;
  _state.engine = engine;
  _state.listEntries.clear();
  _state.listSets.clear();
  _state.listText.clear();
  _state.listed.clear();
  _state.scan404.clear();
  _state.massNotified = 0;
  _hits.clear();
  rebuild();
}

module.exports = {
  SOURCES, LISTS, DURATIONS_MIN, MANUAL_HOURS, UNKNOWN_WEIGHTS, LIST_SOURCES, PROBE_RE, IpBlockError,
  getConfig, setConfig, getNever, addNever, removeNever, exceptions,
  noteFailure, banManual, unban, listBans, check, isExempt, exportBackup, restoreBackup,
  refreshLists, parseList, parseListAsync, noteAccessLines, sweep, stats, view,
  caddyRoute, l4Ranges, blockFile, fileContent, writeNow, engineAvailable,
  middleware, start, stop, rebuild, PrefixSet, _resetForTest, _state,
};
