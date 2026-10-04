'use strict';

// "Sicherheit (24 h)" card of the dashboard — one aggregated, cached read
// (GET /api/v1/dashboard/security-summary):
//
//   waf      blocked requests of the last 24 h, the same count per hour
//            (24 buckets, the last one is the current hour) and the active
//            bans — only with the `waf` licence feature
//   logins   failed admin logins (password, second factor, passkey) of the
//            last 24 h from activity_log + accounts currently locked out
//   bots     requests the bot blocker rejected: routes.bot_blocker_count is a
//            running counter since the blocker was switched on per route
//            (services/botBlockerCounter.js adds to it, nothing resets it),
//            so this is a TOTAL, not a 24 h value — only with `bot_blocking`
//   pihole   blocked share and query count of Pi-hole's own summary window
//            (synced cache, no request to Pi-hole) — only with
//            `pihole_integration` and once a sync has data
//   check    the security check summary + the ids of the open findings
//
// Every query is an indexed range or a small aggregate (no log scans); the
// whole answer is cached for CACHE_MS per user (the security check result
// depends on the requesting admin) because the security check may resolve
// CAA records.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const CACHE_MS = 30 * 1000;
const FAILED_LOGIN_TYPES = ['login_failed', 'login_2fa_failed', 'passkey_login_failed'];
const HOUR_MS = 3600 * 1000;

const _cache = new Map(); // key → { at, data, promise }

function hasFeature(key) {
  try { return require('./license').hasFeature(key); } catch { return false; }
}

/** 24 hourly buckets (UTC hour starts, oldest → newest; the last one is the current hour). */
function hourFrame(now) {
  const last = Math.floor(now / HOUR_MS) * HOUR_MS;
  const starts = [];
  for (let i = 23; i >= 0; i--) starts.push(last - i * HOUR_MS);
  return starts;
}

function wafSummary(db, now) {
  const waf = require('./waf');
  const starts = hourFrame(now);
  const from = new Date(starts[0]).toISOString();
  const s = waf.stats({ since: new Date(now - 24 * HOUR_MS).toISOString() });
  // Same counting rule as waf.stats(): one blocked transaction per tx_id
  // (rows without one count per row). The trusted (own) IPs are left out.
  let trusted = [];
  try {
    const wafBans = require('./wafBans');
    const list = wafBans.getSettings().trusted_ips;
    if (list.length) {
      const m = wafBans.trustedMatcher(list);
      trusted = db.prepare('SELECT DISTINCT client_ip FROM waf_events WHERE ts >= ? AND client_ip IS NOT NULL')
        .all(from).map((r) => r.client_ip).filter((ip) => m(ip));
    }
  } catch (err) { logger.debug({ err: err.message }, 'dashboard security: trusted list unavailable'); }
  const excl = trusted.length ? ' AND (client_ip IS NULL OR client_ip NOT IN (SELECT value FROM json_each(?)))' : '';
  const args = trusted.length ? [from, JSON.stringify(trusted)] : [from];
  const rows = db.prepare(`SELECT substr(ts, 1, 13) AS h, COUNT(DISTINCT COALESCE(tx_id, 'row:' || id)) AS n
    FROM waf_events WHERE ts >= ? AND action = 'blocked'${excl} GROUP BY h`).all(...args);
  const byHour = new Map(rows.map((r) => [r.h, r.n]));
  const hourly = starts.map((t) => byHour.get(new Date(t).toISOString().slice(0, 13)) || 0);
  let banned = 0;
  try {
    banned = db.prepare('SELECT COUNT(*) AS n FROM waf_bans WHERE expires_at IS NULL OR expires_at > ?')
      .get(new Date(now).toISOString()).n;
  } catch { /* table missing on very old schemas */ }
  return { blocked_24h: s.blocked, events_24h: s.events, hourly, banned_ips: banned };
}

function loginSummary(db) {
  const ph = FAILED_LOGIN_TYPES.map(() => '?').join(',');
  const failed = db.prepare(`SELECT COUNT(*) AS n FROM activity_log
    WHERE event_type IN (${ph}) AND created_at >= datetime('now', '-24 hours')`).get(...FAILED_LOGIN_TYPES).n;
  let locked = 0;
  try {
    locked = require('./lockout').getLockedAccounts().filter((a) => a.type === 'admin').length;
  } catch (err) { logger.debug({ err: err.message }, 'dashboard security: lockout state unavailable'); }
  return { failed_24h: failed, locked_accounts: locked };
}

function botSummary(db) {
  const r = db.prepare(`SELECT COALESCE(SUM(bot_blocker_count), 0) AS total, COUNT(*) AS routes
    FROM routes WHERE bot_blocker_enabled = 1 AND enabled = 1`).get();
  return { total: r.total || 0, routes: r.routes || 0, scope: 'total' };
}

function piholeSummary() {
  const cache = require('./pihole').getCache();
  const q = cache && cache.summary && cache.summary.queries;
  if (!q || !Number.isFinite(Number(q.total))) return null;
  return {
    total: Number(q.total) || 0,
    blocked: Number(q.blocked) || 0,
    percent: Number(q.percent) || 0,
  };
}

async function checkSummary(userId, t) {
  const res = await require('./securityCheck').runCheck({ userId });
  const checks = Array.isArray(res.checks) ? res.checks : [];
  const open = checks.filter((c) => c.status === 'fail').map((c) => ({
    id: c.id,
    severity: c.severity,
    title: typeof t === 'function' ? t(`security.check.${c.id}.title`) : c.id,
  }));
  const rank = { critical: 0, warning: 1, info: 2 };
  open.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  return {
    pass: res.summary.pass,
    fail: res.summary.fail,
    info: res.summary.info,
    total: checks.filter((c) => c.status !== 'na').length,
    critical: open.filter((c) => c.severity === 'critical').length,
    open,
  };
}

function section(name, fn) {
  try { return fn(); } catch (err) {
    logger.warn({ err: err.message, section: name }, 'dashboard security summary section failed');
    return null;
  }
}

async function build({ userId, t, now }) {
  const db = getDb();
  const out = {
    generated_at: new Date(now).toISOString(),
    waf: hasFeature('waf') ? section('waf', () => wafSummary(db, now)) : null,
    logins: section('logins', () => loginSummary(db)),
    bots: hasFeature('bot_blocking') ? section('bots', () => botSummary(db)) : null,
    pihole: hasFeature('pihole_integration') ? section('pihole', () => piholeSummary()) : null,
    check: null,
  };
  try { out.check = await checkSummary(userId, t); }
  catch (err) { logger.warn({ err: err.message }, 'dashboard security summary: security check failed'); }
  return out;
}

/**
 * The card's data, cached for CACHE_MS per (user, language). `now` is
 * injectable for tests; `fresh` bypasses the cache.
 */
async function summary({ userId = null, lang = '', t, now = Date.now(), fresh = false } = {}) {
  const key = `${userId == null ? '-' : userId}:${lang}`;
  const hit = _cache.get(key);
  if (!fresh && hit) {
    if (hit.promise) return hit.promise;
    if (now - hit.at < CACHE_MS) return hit.data;
  }
  const promise = build({ userId, t, now }).then((data) => {
    _cache.set(key, { at: now, data, promise: null });
    return data;
  }, (err) => { _cache.delete(key); throw err; });
  _cache.set(key, { at: hit ? hit.at : 0, data: hit ? hit.data : null, promise });
  return promise;
}

function _resetCacheForTest() { _cache.clear(); }

module.exports = { summary, hourFrame, FAILED_LOGIN_TYPES, CACHE_MS, _resetCacheForTest };
