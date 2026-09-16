'use strict';

// WAF assistant (docs/feature-release-b.md §3): per WAF route, is it safe to
// switch from detect to block? GET /api/v1/waf/assistant.
//
// Input: waf_events of the route since the last waf_enabled/waf_mode change
// (routes.waf_mode_changed_at), own (trusted) IPs left out of every verdict,
// plus a bounded look at Caddy's access log to tell "quiet" from "no traffic".
//
// Heuristic, per rule (the CRS scoring rules 949/959/980 and rules already
// excluded on the route are skipped):
//   attack          a) the rule belongs to the scanner groups (913 scanner,
//                      930 LFI, 931 RFI, 920440) or hit a typical secret path
//                      (/.env, /.git/, wp-config.php, /etc/passwd, …;
//                      SECRET_PATH_RE) — anything on such a path is an attack;
//                   b) a single-IP series: every hit from one address and at
//                      least SERIES_MIN_HITS requests;
//                   c) every source address is banned (scanner ban).
//   false_positive  the same rule on the same path from ≥ 3 different
//                   addresses that are neither own nor banned, on ≥ 2
//                   different (UTC) days — normal users of the app trip it.
//   unclear         everything else.
// The first matching verdict wins (attack before false_positive).
//
// Readiness of the route:
//   too_early   observed < 24 h (since waf_mode_changed_at)
//   no_traffic  no request since then: neither a WAF hit nor a line in the
//               scanned part of the access log (see trafficSeen)
//   review      at least one rule with verdict false_positive
//   ready       otherwise (also with zero external hits but traffic)
// Suggestion: exclude_rules = the false_positive rules; exclude_paths = paths
// on which ≥ 3 different rules are false positives (a whole endpoint the CRS
// cannot judge, e.g. a JSON API) — a path exclusion switches the engine off
// there, so it is only suggested when a rule exclusion would not do.
//
// Every rule carries the verdict's grounds twice (docs/feature-wave2.md §W1.3):
//   reason         English plain text — unchanged, for API users and logs
//   reason_code    stable code (REASON_CODES) the user interface translates
//   reason_params  the values the translated sentence needs
// The browser must never translate `reason` by matching its English wording.

const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const logger = require('../utils/logger');
const waf = require('./waf');
const wafBans = require('./wafBans');

const OBSERVE_MIN_HOURS = 24;
const FP_MIN_IPS = 3;
const FP_MIN_DAYS = 2;
const SERIES_MIN_HITS = 3;
const TOP_RULES = 10;
const PATHS_PER_RULE = 5;
const MAX_EVENTS_PER_ROUTE = 20000;
const PATH_EXCLUSION_MIN_RULES = 3;

// Grounds for a rule verdict. The text stays English (API), the code is what
// the user interface translates (waf.asst_reason_* in src/i18n/*.json).
const REASON_CODES = ['secret_path', 'scanner_rule', 'series', 'all_banned', 'shared_path', 'inconclusive'];

const ACCESS_TAIL_BYTES = 8 * 1024 * 1024;
const ACCESS_CACHE_MS = 5 * 60 * 1000;

// Typical secret / probe paths (lower-cased, URL-decoded path, no query).
const SECRET_PATH_RE = /(?:^|\/)(?:\.env(?:[./]|$)|\.git(?:\/|$)|\.svn(?:\/|$)|\.hg(?:\/|$)|\.bzr(?:\/|$)|\.aws(?:\/|$)|\.ssh(?:\/|$)|\.docker(?:env|\/|$)|\.kube(?:\/|$)|\.npmrc$|\.htaccess$|\.htpasswd$|\.ds_store$|\.vscode(?:\/|$)|\.idea(?:\/|$)|\.bash_history$|\.mysql_history$|id_[rd]sa(?:\.pub)?$|wp-config\.php|config\.php\.(?:bak|old|save|swp)$|phpinfo\.php$|server-status$|server-info$|web\.config$|docker-compose\.ya?ml$|(?:backup|dump|db|database)\.(?:sql|zip|tar|tgz|gz|7z|rar)$|[^/]+\.sql(?:\.gz)?$|[^/]+\.(?:bak|old|orig|save|swp)$|etc\/(?:passwd|shadow|hosts)$|proc\/self\/|actuator(?:\/|$)|phpmyadmin|vendor\/phpunit\/|cgi-bin\/)/i;

function nowIso() { return new Date().toISOString(); }

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → ISO; null when unparsable. */
function toIso(v) {
  if (!v) return null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pathOf(uri) {
  let p = String(uri || '/').split('?')[0].split('#')[0] || '/';
  if (!p.startsWith('/')) p = '/' + p;
  return p.slice(0, 256);
}

function isSecretPath(p) {
  let s = String(p || '').toLowerCase();
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  return SECRET_PATH_RE.test(s.replace(/\/{2,}/g, '/'));
}

// ─── Access log (traffic since …) ───────────────────────

let _access = { at: 0, file: null, hosts: new Map(), windowStart: null, promise: null };

function accessLogPath() {
  return path.join(config.caddy.dataDir || '/data/caddy', 'access.log');
}

/**
 * The tail (ACCESS_TAIL_BYTES) of Caddy's access log → Map(host → last ISO
 * time) plus the time of the oldest line read. Cached for 5 min; never
 * throws (unreadable → null, the assistant then only counts WAF hits).
 */
async function trafficSeen() {
  const file = accessLogPath();
  if (_access.promise) return _access.promise;
  if (_access.file === file && Date.now() - _access.at < ACCESS_CACHE_MS) return _access.hosts ? _access : null;
  _access.promise = (async () => {
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
      const size = (await fh.stat()).size;
      const start = Math.max(0, size - ACCESS_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (start > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
      const hosts = new Map();
      let oldest = null;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const host = e && e.request && e.request.host ? String(e.request.host).toLowerCase().replace(/:\d+$/, '') : null;
        const ts = Number(e && e.ts);
        if (!host || !Number.isFinite(ts)) continue;
        const iso = new Date(ts * 1000).toISOString();
        if (!oldest || iso < oldest) oldest = iso;
        const cur = hosts.get(host);
        if (!cur || iso > cur) hosts.set(host, iso);
      }
      _access = { at: Date.now(), file, hosts, windowStart: oldest, promise: null };
    } catch {
      _access = { at: Date.now(), file, hosts: null, windowStart: null, promise: null };
    } finally {
      if (fh) { try { await fh.close(); } catch { /* ignore */ } }
    }
    return _access.hosts ? _access : null;
  })();
  return _access.promise;
}

function _resetAccessCacheForTest() { _access = { at: 0, file: null, hosts: new Map(), windowStart: null, promise: null }; }

// ─── Analysis ───────────────────────────────────────────

/**
 * Analyse one route. `ctx` = { trusted(ip), banned(ip), traffic (trafficSeen
 * result or null), now (ms) }.
 */
function analyseRoute(db, route, ctx) {
  const mode = route.waf_mode === 'block' ? 'block' : 'detect';
  const since = toIso(route.waf_mode_changed_at) || toIso(route.updated_at) || toIso(route.created_at) || nowIso();
  const observedHours = Math.max(0, Math.floor((ctx.now - new Date(since).getTime()) / 3600000));
  const excluded = new Set(waf.parseExclusions(route.waf_exclusions).rule_ids);

  const rows = db.prepare(`SELECT id, ts, client_ip, uri, rule_id, message, tx_id FROM waf_events
    WHERE route_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?`).all(route.id, since, MAX_EVENTS_PER_ROUTE);

  const txAll = new Set();
  const txExternal = new Set();
  const rules = new Map();
  for (const r of rows) {
    const tx = r.tx_id || `row:${r.id}`;
    txAll.add(tx);
    if (ctx.trusted(r.client_ip)) continue;
    txExternal.add(tx);
    if (r.rule_id == null || waf.SUMMARY_RULE_RE.test(String(r.rule_id)) || excluded.has(r.rule_id)) continue;
    let rule = rules.get(r.rule_id);
    if (!rule) {
      rule = { rule_id: r.rule_id, message: r.message || null, tx: new Set(), ips: new Set(), paths: new Map() };
      rules.set(r.rule_id, rule);
    }
    rule.tx.add(tx);
    const ip = r.client_ip ? String(r.client_ip) : null;
    if (ip) rule.ips.add(ip);
    const p = pathOf(r.uri);
    let pe = rule.paths.get(p);
    if (!pe) { pe = { hits: new Set(), cleanIps: new Set(), days: new Set() }; rule.paths.set(p, pe); }
    pe.hits.add(tx);
    if (ip && !ctx.banned(ip)) pe.cleanIps.add(ip);
    pe.days.add(String(r.ts).slice(0, 10));
  }

  const analysed = [...rules.values()].map((rule) => {
    const hits = rule.tx.size;
    const ips = [...rule.ips];
    const paths = [...rule.paths.entries()].sort((a, b) => b[1].hits.size - a[1].hits.size);
    let verdict = 'unclear';
    let reason = `${hits} request(s) from ${ips.length} address(es) — not conclusive`;
    let reasonCode = 'inconclusive';
    let reasonParams = { hits, ips: ips.length };
    const secret = paths.find(([p]) => isSecretPath(p));
    const fpPaths = paths.filter(([p, pe]) => !isSecretPath(p) && pe.cleanIps.size >= FP_MIN_IPS && pe.days.size >= FP_MIN_DAYS).map(([p]) => p);
    if (wafBans.isBanRule(rule.rule_id) || secret) {
      verdict = 'attack';
      reason = secret ? `hits a typical secret path (${secret[0]})` : 'scanner / file-inclusion rule';
      reasonCode = secret ? 'secret_path' : 'scanner_rule';
      reasonParams = secret ? { path: secret[0] } : {};
    } else if (ips.length === 1 && hits >= SERIES_MIN_HITS) {
      verdict = 'attack';
      reason = `series of ${hits} requests from a single address`;
      reasonCode = 'series';
      reasonParams = { hits };
    } else if (ips.length > 0 && ips.every((ip) => ctx.banned(ip))) {
      verdict = 'attack';
      reason = 'every source address is banned';
      reasonCode = 'all_banned';
      reasonParams = {};
    } else if (fpPaths.length > 0) {
      verdict = 'false_positive';
      const pe = rule.paths.get(fpPaths[0]);
      reason = `same path ${fpPaths[0]} from ${pe.cleanIps.size} different addresses on ${pe.days.size} days`;
      reasonCode = 'shared_path';
      reasonParams = { path: fpPaths[0], ips: pe.cleanIps.size, days: pe.days.size };
    }
    return {
      rule_id: rule.rule_id,
      message: rule.message,
      hits,
      ips: ips.length,
      paths: paths.slice(0, PATHS_PER_RULE).map(([p]) => p),
      verdict,
      reason,
      reason_code: reasonCode,
      reason_params: reasonParams,
      _fpPaths: fpPaths,
    };
  }).sort((a, b) => b.hits - a.hits || a.rule_id - b.rule_id);

  const fpRules = analysed.filter((r) => r.verdict === 'false_positive');
  const pathRuleCount = new Map();
  for (const r of fpRules) for (const p of r._fpPaths) pathRuleCount.set(p, (pathRuleCount.get(p) || 0) + 1);
  const suggestion = {
    exclude_rules: fpRules.map((r) => r.rule_id).sort((a, b) => a - b),
    exclude_paths: [...pathRuleCount.entries()].filter(([, n]) => n >= PATH_EXCLUSION_MIN_RULES).map(([p]) => p)
      .filter((p) => { try { waf.validateExclusionPath(p); return true; } catch { return false; } }),
  };

  // Traffic: a WAF hit, or the host in the scanned access log after `since`.
  let traffic = txAll.size > 0;
  if (!traffic && ctx.traffic && ctx.traffic.hosts) {
    const last = ctx.traffic.hosts.get(String(route.domain || '').toLowerCase());
    traffic = !!(last && last >= since);
  }

  let readiness;
  if (observedHours < OBSERVE_MIN_HOURS) readiness = 'too_early';
  else if (!traffic) readiness = 'no_traffic';
  else if (fpRules.length > 0) readiness = 'review';
  else readiness = 'ready';

  return {
    route_id: route.id,
    host: route.domain,
    mode,
    paranoia: Number.isInteger(route.waf_paranoia) ? route.waf_paranoia : 1,
    detect_since: mode === 'detect' ? since : null,
    observed_hours: observedHours,
    events_total: txAll.size,
    events_external: txExternal.size,
    top_rules: analysed.slice(0, TOP_RULES).map(({ _fpPaths, ...r }) => r),
    readiness,
    suggestion,
  };
}

/** GET /waf/assistant payload: { routes } for every HTTP route with the WAF on. */
async function assistant({ routeId } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT id, domain, waf_mode, waf_paranoia, waf_exclusions, waf_mode_changed_at, updated_at, created_at
    FROM routes WHERE waf_enabled = 1 AND route_type != 'l4' ${routeId ? 'AND id = ?' : ''} ORDER BY domain, id`)
    .all(...(routeId ? [routeId] : []));
  if (rows.length === 0) return { routes: [] };
  const s = wafBans.getSettings();
  const ctx = {
    trusted: wafBans.trustedMatcher(s.trusted_ips),
    banned: wafBans.trustedMatcher(wafBans.activeBanIps()),
    traffic: null,
    now: Date.now(),
  };
  try { ctx.traffic = await trafficSeen(); } catch (err) { logger.warn({ err: err.message }, 'waf assistant: access log unavailable'); }
  return { routes: rows.map((r) => analyseRoute(db, r, ctx)) };
}

module.exports = {
  OBSERVE_MIN_HOURS,
  FP_MIN_IPS,
  FP_MIN_DAYS,
  SECRET_PATH_RE,
  REASON_CODES,
  isSecretPath,
  assistant,
  analyseRoute,
  trafficSeen,
  _resetAccessCacheForTest,
};
