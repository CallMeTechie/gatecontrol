'use strict';

// WAF settings, own IPs and scanner ban (docs/feature-release-b.md §3).
//
//   getSettings / updateSettings   waf.trusted_ips, waf.trusted_bypass, waf.autoban.*
//   trustedMatcher / isTrusted     "own IPs": never counted, never banned
//   bypassList                     trusted IPs for the Coraza bypass directive
//                                  (id 9003) — [] unless trusted_bypass is on
//   onIngested(rows)               audit-ingest hook: counts scanner hits per
//                                  client IP in the window and bans at the threshold
//   listBans / addBan / removeBan  ban list (waf_bans); manual bans sync at once
//   banRoute({ gcHost })           srv0 route `gc_waf_bans` (null without bans)
//   sweep / start / stop           expiry sweep every 5 min
//
// Ban-triggered syncs are coalesced: at most one Caddy sync per 60 s (an
// attack wave produces a burst of bans). Only HTTP — layer 4 is untouched.

const ipaddr = require('ipaddr.js');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const settings = require('./settings');
const eventBus = require('./eventBus');
const { withCaddySync } = require('./routesSync');

const KEY_TRUSTED = 'waf.trusted_ips';
const KEY_BYPASS = 'waf.trusted_bypass';
const KEY_AB_ENABLED = 'waf.autoban.enabled';
const KEY_AB_THRESHOLD = 'waf.autoban.threshold';
const KEY_AB_WINDOW = 'waf.autoban.window_min';
const KEY_AB_DURATION = 'waf.autoban.duration_h';

const TRUSTED_MAX = 50;
const DEFAULTS = { threshold: 5, window_min: 10, duration_h: 24 };
const LIMITS = { threshold: [1, 1000], window_min: [1, 1440], duration_h: [1, 8760] };
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_MIN_INTERVAL_MS = 60 * 1000;
// Upper bound for auto-bans in force (a spray from thousands of addresses must
// not grow the Caddy config without limit); manual bans are not capped.
const MAX_AUTO_BANS = 2000;
// Manual CIDR bans: no ranges wider than this.
const MIN_BAN_PREFIX = { ipv4: 16, ipv6: 32 };

// Rule groups the scanner ban counts: 913 scanner detection, 930 LFI /
// protected files, 931 RFI, and 920440 (restricted file extension).
function isBanRule(ruleId) {
  const n = Number(ruleId);
  if (!Number.isInteger(n)) return false;
  return (n >= 913000 && n <= 913999) || (n >= 930000 && n <= 931999) || n === 920440;
}
const BAN_RULE_SQL = '(rule_id BETWEEN 913000 AND 913999 OR rule_id BETWEEN 930000 AND 931999 OR rule_id = 920440)';

function wafError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function nowIso() { return new Date().toISOString(); }

// ─── Addresses ──────────────────────────────────────────

// Network address of addr/prefix (ipaddr.js 1.x has no IPv6 helper for it).
function networkOf(addr, prefix) {
  const bytes = addr.toByteArray();
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    bytes[i] &= bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff;
  }
  return ipaddr.fromByteArray(bytes);
}

/** IP or CIDR → { kind, text, addr, prefix, single } (canonical) or null. */
function parseAddress(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > 64) return null;
  try {
    if (s.includes('/')) {
      const [addr, prefix] = ipaddr.parseCIDR(s);
      const a = addr.kind() === 'ipv6' && addr.isIPv4MappedAddress() ? addr.toIPv4Address() : addr;
      const p = a.kind() === 'ipv4' && addr.kind() === 'ipv6' ? prefix - 96 : prefix;
      if (p < 0) return null;
      const max = a.kind() === 'ipv4' ? 32 : 128;
      if (p === max) return { kind: a.kind(), text: a.toString(), addr: a, prefix: p, single: true };
      const net = networkOf(a, p);
      return { kind: a.kind(), text: `${net.toString()}/${p}`, addr: net, prefix: p, single: false };
    }
    if (!ipaddr.isValid(s)) return null;
    const a = ipaddr.process(s);
    return { kind: a.kind(), text: a.toString(), addr: a, prefix: a.kind() === 'ipv4' ? 32 : 128, single: true };
  } catch {
    return null;
  }
}

/** Single IP text → canonical form (IPv4-mapped IPv6 → IPv4) or null. */
function canonIp(value) {
  const p = parseAddress(value);
  return p && p.single ? p.text : null;
}

// Private, loopback, link-local, CGNAT, ULA …: never auto-banned. Behind a
// private load balancer Coraza sees the balancer's address — banning it
// would lock out everybody.
function isPublicIp(ip) {
  try { return ipaddr.process(String(ip)).range() === 'unicast'; } catch { return false; }
}

function matches(parsedIp, entry) {
  if (!parsedIp || !entry || parsedIp.kind() !== entry.addr.kind()) return false;
  return parsedIp.match(entry.addr, entry.prefix);
}

// ─── Settings ───────────────────────────────────────────

function parseTrustedList(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const p = parseAddress(v);
    if (p && !out.includes(p.text)) out.push(p.text);
  }
  return out.slice(0, TRUSTED_MAX);
}

function intSetting(key, name) {
  const n = parseInt(settings.get(key, String(DEFAULTS[name])), 10);
  const [min, max] = LIMITS[name];
  return Number.isInteger(n) && n >= min && n <= max ? n : DEFAULTS[name];
}

/** GET /settings/waf payload. */
function getSettings() {
  return {
    trusted_ips: parseTrustedList(settings.get(KEY_TRUSTED, '[]')),
    trusted_bypass: settings.get(KEY_BYPASS, 'false') === 'true',
    autoban: {
      enabled: settings.get(KEY_AB_ENABLED, 'false') === 'true',
      threshold: intSetting(KEY_AB_THRESHOLD, 'threshold'),
      window_min: intSetting(KEY_AB_WINDOW, 'window_min'),
      duration_h: intSetting(KEY_AB_DURATION, 'duration_h'),
    },
  };
}

function flag(v, field) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  throw wafError(field === 'trusted_bypass' ? 'WAF_SETTINGS_INVALID' : 'WAF_AUTOBAN_INVALID', `${field} must be a boolean`);
}

function validateTrustedInput(list) {
  if (!Array.isArray(list)) throw wafError('WAF_TRUSTED_IPS_INVALID', 'trusted_ips must be an array of IP addresses or CIDR ranges');
  if (list.length > TRUSTED_MAX) throw wafError('WAF_TRUSTED_IPS_INVALID', `at most ${TRUSTED_MAX} trusted addresses`);
  const out = [];
  for (const v of list) {
    const p = parseAddress(v);
    if (!p) throw wafError('WAF_TRUSTED_IPS_INVALID', `"${String(v).slice(0, 64)}" is not an IPv4/IPv6 address or CIDR range`);
    if (!out.includes(p.text)) out.push(p.text);
  }
  return out;
}

function validateAutobanInt(value, name) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  const [min, max] = LIMITS[name];
  if (!Number.isInteger(n) || n < min || n > max) {
    throw wafError('WAF_AUTOBAN_INVALID', `autoban.${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * PUT /settings/waf. Validates everything first, then writes. A change that
 * alters the generated Caddy config (bypass list, bans of addresses that just
 * became trusted) is synced once with a full rollback of the settings and the
 * removed bans on failure. → { settings, synced }
 */
async function updateSettings(input) {
  const body = input && typeof input === 'object' ? input : {};
  const cur = getSettings();
  const next = JSON.parse(JSON.stringify(cur));
  if (body.trusted_ips !== undefined) next.trusted_ips = validateTrustedInput(body.trusted_ips);
  if (body.trusted_bypass !== undefined) next.trusted_bypass = flag(body.trusted_bypass, 'trusted_bypass');
  if (body.autoban !== undefined) {
    const ab = body.autoban;
    if (!ab || typeof ab !== 'object' || Array.isArray(ab)) throw wafError('WAF_AUTOBAN_INVALID', 'autoban must be an object');
    if (ab.enabled !== undefined) next.autoban.enabled = flag(ab.enabled, 'autoban.enabled');
    for (const name of ['threshold', 'window_min', 'duration_h']) {
      if (ab[name] !== undefined) next.autoban[name] = validateAutobanInt(ab[name], name);
    }
  }

  const db = getDb();
  const prevRaw = {};
  for (const k of [KEY_TRUSTED, KEY_BYPASS, KEY_AB_ENABLED, KEY_AB_THRESHOLD, KEY_AB_WINDOW, KEY_AB_DURATION]) prevRaw[k] = settings.get(k, null);
  const writeAll = (s) => {
    settings.set(KEY_TRUSTED, JSON.stringify(s.trusted_ips));
    settings.set(KEY_BYPASS, s.trusted_bypass ? 'true' : 'false');
    settings.set(KEY_AB_ENABLED, s.autoban.enabled ? 'true' : 'false');
    settings.set(KEY_AB_THRESHOLD, String(s.autoban.threshold));
    settings.set(KEY_AB_WINDOW, String(s.autoban.window_min));
    settings.set(KEY_AB_DURATION, String(s.autoban.duration_h));
  };

  // Own IPs are never banned: bans covered by the new trusted list go.
  const matcher = trustedMatcher(next.trusted_ips);
  const unbanned = db.prepare('SELECT * FROM waf_bans').all().filter((b) => {
    const p = parseAddress(b.ip);
    return p && (p.single ? matcher(p.text) : next.trusted_ips.some((t) => { const tp = parseAddress(t); return tp && matches(p.addr, tp); }));
  });

  const bypassBefore = cur.trusted_bypass ? cur.trusted_ips.join(',') : '';
  const bypassAfter = next.trusted_bypass ? next.trusted_ips.join(',') : '';
  const needsSync = bypassBefore !== bypassAfter || unbanned.some((b) => isActive(b));

  db.transaction(() => {
    writeAll(next);
    const del = db.prepare('DELETE FROM waf_bans WHERE ip = ?');
    for (const b of unbanned) del.run(b.ip);
  })();

  if (needsSync) {
    await withCaddySync(syncToCaddy, () => {
      db.transaction(() => {
        for (const [k, v] of Object.entries(prevRaw)) {
          if (v === null) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
          else settings.set(k, v);
        }
        restoreBans(db, unbanned);
      })();
    }, 'waf settings');
    _banSync.lastAt = Date.now();
  }
  for (const b of unbanned) publishBan('unban', b.ip);
  try {
    require('./activity').log('waf_settings_changed', 'WAF settings changed', {
      source: 'admin', severity: 'info',
      details: { trusted_ips: next.trusted_ips.length, trusted_bypass: next.trusted_bypass, autoban: next.autoban, unbanned: unbanned.map((b) => b.ip) },
    });
  } catch { /* best-effort */ }
  return { settings: getSettings(), synced: needsSync };
}

/** A function ip → bool for the given (or configured) trusted list. */
function trustedMatcher(list) {
  const entries = (list || getSettings().trusted_ips).map(parseAddress).filter(Boolean);
  if (entries.length === 0) return () => false;
  const cache = new Map();
  return (ip) => {
    if (ip == null || ip === '') return false;
    const key = String(ip);
    if (cache.has(key)) return cache.get(key);
    let hit = false;
    try {
      const a = ipaddr.process(key);
      hit = entries.some((e) => matches(a, e));
    } catch { hit = false; }
    if (cache.size < 50000) cache.set(key, hit);
    return hit;
  };
}

function isTrusted(ip) { return trustedMatcher()(ip); }

/** Addresses for the Coraza bypass directive (id 9003); [] unless trusted_bypass is on. */
function bypassList() {
  const s = getSettings();
  return s.trusted_bypass ? s.trusted_ips : [];
}

// ─── Bans ───────────────────────────────────────────────

function isActive(ban, now = nowIso()) {
  return !ban.expires_at || String(ban.expires_at) > now;
}

function publishBan(kind, ip) {
  try { eventBus.publish('waf', { kind, ip }); } catch { /* best-effort */ }
}

function restoreBans(db, rows) {
  const ins = db.prepare(`INSERT OR REPLACE INTO waf_bans (ip, reason, hits, first_seen, banned_at, expires_at, manual)
    VALUES (@ip, @reason, @hits, @first_seen, @banned_at, @expires_at, @manual)`);
  for (const r of rows) ins.run(r);
}

function toApi(b) {
  return {
    ip: b.ip,
    reason: b.reason || null,
    hits: b.hits == null ? null : b.hits,
    first_seen: b.first_seen || null,
    banned_at: b.banned_at || null,
    expires_at: b.expires_at || null,
    manual: !!b.manual,
  };
}

/** Bans in force (expired rows are hidden until the sweep deletes them), newest first. */
function listBans() {
  const now = nowIso();
  return getDb().prepare('SELECT * FROM waf_bans ORDER BY banned_at DESC, ip').all()
    .filter((b) => isActive(b, now))
    .map(toApi);
}

function syncToCaddy() { return require('./caddyConfig').syncToCaddy(); }

/**
 * Manual ban { ip, duration_h? } (IP or CIDR, not wider than /16 resp. /32,
 * never an own IP, loopback or unspecified). Synced right away; the row is
 * removed / restored again when the sync fails. → the ban
 */
async function addBan(input) {
  const body = input && typeof input === 'object' ? input : {};
  const p = parseAddress(body.ip);
  if (!p) throw wafError('WAF_BAN_IP_INVALID', 'ip must be an IPv4/IPv6 address or CIDR range');
  if (!p.single && p.prefix < MIN_BAN_PREFIX[p.kind]) {
    throw wafError('WAF_BAN_IP_INVALID', `ranges wider than /${MIN_BAN_PREFIX[p.kind]} cannot be banned`);
  }
  const range = p.addr.range();
  if (['loopback', 'unspecified'].includes(range)) throw wafError('WAF_BAN_IP_INVALID', 'loopback and unspecified addresses cannot be banned');
  const s = getSettings();
  const trusted = s.trusted_ips.map(parseAddress).filter(Boolean);
  if (trusted.some((t) => matches(p.addr, t) || (!p.single && matches(t.addr, p)))) {
    throw wafError('WAF_BAN_TRUSTED', 'this address is one of your own (trusted) addresses');
  }
  let hours = s.autoban.duration_h;
  if (body.duration_h !== undefined && body.duration_h !== null && body.duration_h !== '') {
    const n = typeof body.duration_h === 'string' ? Number(body.duration_h.trim()) : body.duration_h;
    if (!Number.isInteger(n) || n < LIMITS.duration_h[0] || n > LIMITS.duration_h[1]) {
      throw wafError('WAF_BAN_DURATION_INVALID', `duration_h must be an integer between ${LIMITS.duration_h[0]} and ${LIMITS.duration_h[1]}`);
    }
    hours = n;
  }
  const reason = body.reason !== undefined && body.reason !== null ? String(body.reason).trim().slice(0, 200) : '';
  const db = getDb();
  const prev = db.prepare('SELECT * FROM waf_bans WHERE ip = ?').get(p.text) || null;
  const now = new Date();
  const row = {
    ip: p.text,
    reason: reason || 'manual',
    hits: prev ? prev.hits : null,
    first_seen: prev ? prev.first_seen : null,
    banned_at: now.toISOString(),
    expires_at: new Date(now.getTime() + hours * 3600000).toISOString(),
    manual: 1,
  };
  restoreBans(db, [row]);
  await withCaddySync(syncToCaddy, () => {
    if (prev) restoreBans(db, [prev]);
    else db.prepare('DELETE FROM waf_bans WHERE ip = ?').run(p.text);
  }, 'waf ban');
  _banSync.lastAt = Date.now();
  publishBan('ban', p.text);
  try {
    require('./activity').log('waf_ip_banned', `IP ${p.text} banned manually for ${hours} h`, {
      source: 'admin', severity: 'warning', details: { ip: p.text, duration_h: hours, manual: true },
    });
  } catch { /* best-effort */ }
  return toApi(row);
}

/** DELETE /waf/bans/:ip — 404 WAF_BAN_NOT_FOUND when there is no such ban. */
async function removeBan(ipIn) {
  const p = parseAddress(ipIn);
  if (!p) throw wafError('WAF_BAN_IP_INVALID', 'ip must be an IPv4/IPv6 address or CIDR range');
  const db = getDb();
  const prev = db.prepare('SELECT * FROM waf_bans WHERE ip = ?').get(p.text);
  if (!prev) throw wafError('WAF_BAN_NOT_FOUND', 'ban not found', 404);
  db.prepare('DELETE FROM waf_bans WHERE ip = ?').run(p.text);
  if (isActive(prev)) {
    await withCaddySync(syncToCaddy, () => restoreBans(db, [prev]), 'waf unban');
    _banSync.lastAt = Date.now();
  }
  publishBan('unban', p.text);
  try {
    require('./activity').log('waf_ip_unbanned', `IP ${p.text} unbanned`, { source: 'admin', severity: 'info', details: { ip: p.text } });
  } catch { /* best-effort */ }
  return toApi(prev);
}

/** Active ban addresses (canonical IP / CIDR text), sorted. */
function activeBanIps() {
  const now = nowIso();
  return getDb().prepare('SELECT ip FROM waf_bans WHERE expires_at IS NULL OR expires_at > ? ORDER BY ip').all(now).map((r) => r.ip);
}

/**
 * srv0 route for the ban list, or null when nothing is banned (the config
 * then stays byte-identical). client_ip honours the server's trusted_proxies
 * (private ranges) — a direct client cannot talk itself out of the ban with
 * X-Forwarded-For. The management host and the ACME challenge path stay
 * reachable. Answer: 403 with the WAF block page.
 */
function banRoute({ gcHost } = {}) {
  let ips;
  try { ips = activeBanIps(); } catch (err) { logger.warn({ err: err.message }, 'waf: ban list unavailable'); return null; }
  if (ips.length === 0) return null;
  const ranges = ips.map((ip) => {
    const p = parseAddress(ip);
    if (!p) return null;
    return p.single ? `${p.text}/${p.kind === 'ipv4' ? 32 : 128}` : p.text;
  }).filter(Boolean);
  if (ranges.length === 0) return null;
  const not = [];
  const host = String(gcHost || '').trim().toLowerCase();
  if (host) not.push({ host: [host] });
  not.push({ path: ['/.well-known/acme-challenge/*'] });
  const { renderBlockPage } = require('./waf');
  return {
    '@id': 'gc_waf_bans',
    match: [{ client_ip: { ranges }, not }],
    handle: [{
      handler: 'static_response',
      status_code: 403,
      headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Cache-Control': ['no-store'] },
      body: renderBlockPage({ reference: '{http.vars.client_ip}' }),
    }],
    terminal: true,
  };
}

// ─── Coalesced sync ─────────────────────────────────────

const _banSync = { lastAt: 0, timer: null };

/** Sync Caddy because of bans — at most once per 60 s. */
function scheduleBanSync() {
  if (_banSync.timer) return;
  const wait = Math.max(0, _banSync.lastAt + SYNC_MIN_INTERVAL_MS - Date.now());
  _banSync.timer = setTimeout(async () => {
    _banSync.timer = null;
    _banSync.lastAt = Date.now();
    try { await syncToCaddy(); }
    catch (err) { logger.warn({ err: err.message }, 'waf: ban sync failed'); }
  }, wait);
  if (_banSync.timer.unref) _banSync.timer.unref();
}

// ─── Scanner ban (audit ingest hook) ────────────────────

/**
 * Called by waf.ingestLines with the rows just stored. For every public,
 * not trusted, not yet banned client IP with a scanner-group hit in the
 * batch: count its requests (transactions) with such hits in the window; at
 * the threshold → ban (manual = 0). Never throws.
 */
function onIngested(rows) {
  try {
    if (!rows || rows.length === 0) return 0;
    const s = getSettings();
    if (!s.autoban.enabled) return 0;
    if (!require('./license').hasFeature('waf')) return 0;
    const candidates = [...new Set(rows.filter((r) => r.client_ip && isBanRule(r.rule_id)).map((r) => String(r.client_ip)))];
    if (candidates.length === 0) return 0;
    const db = getDb();
    const trusted = trustedMatcher(s.trusted_ips);
    const now = new Date();
    const since = new Date(now.getTime() - s.autoban.window_min * 60000).toISOString();
    const activeBans = new Set(activeBanIps());
    let autoCount = db.prepare('SELECT COUNT(*) AS n FROM waf_bans WHERE manual = 0 AND (expires_at IS NULL OR expires_at > ?)').get(now.toISOString()).n;
    const countStmt = db.prepare(`SELECT COUNT(DISTINCT COALESCE(tx_id, 'row:' || id)) AS hits, MIN(ts) AS first_seen,
        group_concat(DISTINCT rule_id) AS rules
      FROM waf_events WHERE client_ip = ? AND ts >= ? AND ${BAN_RULE_SQL}`);
    let banned = 0;
    for (const raw of candidates) {
      const ip = canonIp(raw);
      if (!ip || !isPublicIp(ip) || trusted(ip) || activeBans.has(ip)) continue;
      const c = countStmt.get(raw, since);
      if (!c || c.hits < s.autoban.threshold) continue;
      if (autoCount >= MAX_AUTO_BANS) {
        logger.warn({ ip, max: MAX_AUTO_BANS }, 'waf: auto-ban limit reached — not banning');
        break;
      }
      const rules = String(c.rules || '').split(',').filter(Boolean).slice(0, 8).join(', ');
      restoreBans(db, [{
        ip,
        reason: `scanner: ${c.hits} requests in ${s.autoban.window_min} min (rules ${rules})`.slice(0, 200),
        hits: c.hits,
        first_seen: c.first_seen,
        banned_at: now.toISOString(),
        expires_at: new Date(now.getTime() + s.autoban.duration_h * 3600000).toISOString(),
        manual: 0,
      }]);
      activeBans.add(ip);
      autoCount++;
      banned++;
      publishBan('ban', ip);
      try {
        require('./activity').log('waf_ip_banned', `IP ${ip} banned for ${s.autoban.duration_h} h (scanner: ${c.hits} requests)`, {
          source: 'system', severity: 'warning', details: { ip, hits: c.hits, rules, duration_h: s.autoban.duration_h, manual: false },
        });
      } catch { /* best-effort */ }
    }
    if (banned > 0) scheduleBanSync();
    return banned;
  } catch (err) {
    logger.warn({ err: err.message }, 'waf: scanner ban failed');
    return 0;
  }
}

// ─── Expiry sweep ───────────────────────────────────────

/** Delete expired bans; a removal is synced (coalesced). Returns the number removed. */
function sweep() {
  try {
    const db = getDb();
    const now = nowIso();
    const rows = db.prepare('SELECT ip FROM waf_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now);
    if (rows.length === 0) return 0;
    db.prepare('DELETE FROM waf_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    for (const r of rows) publishBan('unban', r.ip);
    scheduleBanSync();
    return rows.length;
  } catch (err) {
    logger.warn({ err: err.message }, 'waf: ban sweep failed');
    return 0;
  }
}

let _sweepTimer = null;
function start() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (_sweepTimer.unref) _sweepTimer.unref();
}
function stop() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
  if (_banSync.timer) { clearTimeout(_banSync.timer); _banSync.timer = null; }
}

function _resetForTest() { stop(); _banSync.lastAt = 0; }

module.exports = {
  TRUSTED_MAX,
  MAX_AUTO_BANS,
  SYNC_MIN_INTERVAL_MS,
  isBanRule,
  parseAddress,
  canonIp,
  isPublicIp,
  getSettings,
  updateSettings,
  trustedMatcher,
  isTrusted,
  bypassList,
  listBans,
  addBan,
  removeBan,
  activeBanIps,
  banRoute,
  scheduleBanSync,
  onIngested,
  sweep,
  start,
  stop,
  _banSync,
  _resetForTest,
};
