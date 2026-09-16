'use strict';

// Security check and "what is public?" (docs/feature-release-b.md §1 + §10).
//
//   runCheck({ userId })  → { generated_at, summary: { pass, fail, info }, checks: [...] }
//   exposure()            → { entries: [...] }  public entries (enabled AND external_enabled)
//
// Every check: { id, severity: critical|warning|info, status: pass|fail|na,
// count, items: [{ kind: route|zone|user|target, id, label }], fix | null }.
// summary: pass = status pass; fail = status fail with severity critical or
// warning; info = status fail with severity info (a finding, not an error);
// na is not counted.
//
// CAA lookups (DNS) run through tlsGuard.preflight (fallback tlsGuard.caaStatus
// when the preflight ended before its CAA step) and are cached per zone for
// 1 h (unknown results 10 min). The check waits at most CAA_BUDGET_MS for
// lookups; zones still being looked up are reported as `pending` on the caa
// check and an SSE event `security` ({ reason: 'caa' }) announces the
// finished lookups, so the page can reload.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const settings = require('./settings');
const license = require('./license');
const eventBus = require('./eventBus');
const { isPublicDomain } = require('./caddyTlsAutomation');

const HSTS_FIX_MAX_AGE = 31536000;
const CAA_TTL_MS = 60 * 60 * 1000;
const CAA_UNKNOWN_TTL_MS = 10 * 60 * 1000;
const CAA_BUDGET_MS = 3500;
const BACKUP_MAX_AGE_MS = 48 * 3600 * 1000;
const BACKUP_OK_STATUSES = ['ok', 'success', 'done', 'uploaded'];

function nowIso() { return new Date().toISOString(); }

function item(kind, id, label) { return { kind, id, label: label == null ? null : String(label) }; }

function check(id, severity, status, items = [], fix = null, extra = {}) {
  return { id, severity, status, count: status === 'fail' ? items.length : 0, items: status === 'fail' ? items : [], fix: status === 'fail' ? fix : null, ...extra };
}

function bulkFix(ids, set) {
  return { type: 'api', method: 'POST', url: '/api/v1/routes/bulk', body: { ids, set } };
}

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// ─── Route classification ───────────────────────────────

const isHttp = (r) => r.route_type !== 'l4';
const isPublic = (r) => !!r.enabled && !!r.external_enabled;

function loadRoutes(db) {
  return db.prepare(`
    SELECT r.*, ra.id AS route_auth_id,
           sb.domain_id AS zone_id, d.domain AS zone_domain, d.tls_min_version AS zone_tls_min_version,
           p.allowed_ips AS peer_allowed_ips
    FROM routes r
    LEFT JOIN route_auth ra ON ra.route_id = r.id
    LEFT JOIN service_bundles sb ON sb.id = r.bundle_id
    LEFT JOIN domains d ON d.id = sb.domain_id
    LEFT JOIN peers p ON p.id = r.peer_id
    ORDER BY r.domain, r.id
  `).all();
}

function authOf(r) {
  if (!isHttp(r)) return null;
  if (r.basic_auth_enabled && r.basic_auth_user && r.basic_auth_password_hash) return 'basic';
  if (r.route_auth_id != null) return 'route_auth';
  return null;
}

// An L4 entry is only really filtered when its rule set holds something
// layer 4 can match — `country` rules have no geo matcher in caddy-l4 and are
// ignored by the generator, so a filter made of nothing but those protects
// nobody and must not silence the check.
function isL4Filterable(r) {
  if (r.route_type !== 'l4' || !r.ip_filter_enabled) return false;
  let rules = r.ip_filter_rules;
  if (typeof rules === 'string') {
    try { rules = JSON.parse(rules || '[]'); } catch { return false; }
  }
  if (!Array.isArray(rules)) return false;
  // An allow list with no usable rule closes everything — that is protection.
  const mode = String(r.ip_filter_mode || 'whitelist');
  if (mode === 'whitelist' || mode === 'allow') return true;
  return rules.some((x) => x && (x.type === 'ip' || x.type === 'cidr'));
}

function protectionsOf(r) {
  const http = isHttp(r);
  const https = http && !!r.https_enabled;
  return {
    auth: authOf(r),
    mtls: https && !!r.mtls_enabled && !!r.mtls_ca_pem,
    // IP filter or a peer ACL — both limit who may reach the entry. Since
    // docs/feature-next-package.md §S1.2 the IP filter also works for L4
    // entries (a `close` route in front of the listener); the peer ACL is
    // still HTTP-only, it runs through forward auth.
    ip_filter: (!!r.ip_filter_enabled && (http || isL4Filterable(r))) || (http && !!r.acl_enabled),
    waf: http && r.waf_enabled ? (r.waf_mode === 'block' ? 'block' : 'detect') : null,
    hsts: https && !!r.hsts_enabled,
    rate_limit: http && !!r.rate_limit_enabled,
    tls_min: String(r.zone_tls_min_version || '1.2') === '1.3' ? '1.3' : '1.2',
  };
}

// ─── CAA cache ──────────────────────────────────────────

const _caa = new Map();       // zone domain → { status, suggestion, at }
const _caaInflight = new Map(); // zone domain → Promise
let _caaSeam = null;          // tests: async (zone) → { status, suggestion }
let _caaAnnounce = null;

async function lookupCaa(zone) {
  if (_caaSeam) return _caaSeam(zone);
  const tlsGuard = require('./tlsGuard');
  const r = await tlsGuard.preflight(zone);
  if (r && r.caa_status) return { status: r.caa_status, suggestion: r.caa_suggestion || null };
  return tlsGuard.caaStatus(zone);
}

function caaCached(zone) {
  const c = _caa.get(zone);
  if (!c) return null;
  const ttl = c.status === 'unknown' ? CAA_UNKNOWN_TTL_MS : CAA_TTL_MS;
  return Date.now() - c.at < ttl ? c : null;
}

function startCaa(zone) {
  if (_caaInflight.has(zone)) return _caaInflight.get(zone);
  const p = (async () => {
    let res;
    try { res = await lookupCaa(zone); }
    catch (err) { logger.warn({ err: err.message, zone }, 'security check: CAA lookup failed'); res = { status: 'unknown', suggestion: null }; }
    const entry = { status: res && res.status ? res.status : 'unknown', suggestion: (res && res.suggestion) || null, at: Date.now() };
    _caa.set(zone, entry);
    _caaInflight.delete(zone);
    return entry;
  })();
  _caaInflight.set(zone, p);
  return p;
}

// Lookups that outlive the budget → one SSE `security` event when all are done.
function announceLater(promises) {
  if (_caaAnnounce) return;
  _caaAnnounce = Promise.allSettled(promises).then(() => {
    _caaAnnounce = null;
    try { eventBus.publish('security', { reason: 'caa' }); } catch { /* best-effort */ }
  });
}

async function caaResults(zones, budgetMs) {
  const out = new Map();
  const waiting = [];
  for (const z of zones) {
    const c = caaCached(z);
    if (c) out.set(z, c);
    else waiting.push([z, startCaa(z)]);
  }
  if (waiting.length === 0) return out;
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, budgetMs)); if (timer.unref) timer.unref(); });
  await Promise.race([Promise.allSettled(waiting.map(([, p]) => p)), deadline]);
  clearTimeout(timer);
  const late = [];
  for (const [z, p] of waiting) {
    const c = caaCached(z);
    if (c) out.set(z, c);
    else late.push(p);
  }
  if (late.length > 0) announceLater(late);
  return out;
}

// ─── Checks ─────────────────────────────────────────────

function adminsOf(db) {
  return db.prepare(`SELECT id, username, display_name, totp_enabled FROM users
    WHERE role = 'admin' AND enabled = 1 AND password_hash != '!' ORDER BY id`).all();
}

function checkAdmin2fa(admins, userId) {
  const missing = admins.filter((u) => !u.totp_enabled);
  if (missing.length === 0) return check('admin_2fa', 'critical', 'pass');
  const own = userId != null && missing.some((u) => u.id === Number(userId));
  return check('admin_2fa', 'critical', 'fail',
    missing.map((u) => item('user', u.id, u.username)),
    own ? { type: 'link', href: '/profile#two-factor' } : null);
}

function checkRequire2fa(admins) {
  if (settings.get('security.require_2fa', 'false') === 'true') return check('require_2fa', 'warning', 'pass');
  if (admins.length === 0 || admins.some((u) => !u.totp_enabled)) return check('require_2fa', 'warning', 'na');
  return check('require_2fa', 'warning', 'fail', [],
    { type: 'api', method: 'PUT', url: '/api/v1/settings/security', body: { require_2fa: true } });
}

function checkHsts(routes) {
  const list = routes.filter((r) => r.enabled && isHttp(r) && r.https_enabled && !r.hsts_enabled);
  if (list.length === 0) return check('hsts', 'warning', 'pass');
  return check('hsts', 'warning', 'fail', list.map((r) => item('route', r.id, r.domain)),
    bulkFix(list.map((r) => r.id), { hsts_enabled: true, hsts_max_age: HSTS_FIX_MAX_AGE }));
}

// Zones that matter for certificates: public, with at least one active HTTPS entry.
function activeZones(db, routes) {
  const ids = new Set(routes.filter((r) => r.enabled && isHttp(r) && r.https_enabled && r.zone_id != null).map((r) => r.zone_id));
  return db.prepare('SELECT id, domain, tls_min_version FROM domains ORDER BY domain').all()
    .filter((d) => ids.has(d.id));
}

async function checkCaa(zones, budgetMs) {
  const pub = zones.filter((z) => isPublicDomain(z.domain));
  if (pub.length === 0) return check('caa', 'warning', 'na', [], null, { pending: 0 });
  const res = await caaResults(pub.map((z) => String(z.domain).toLowerCase()), budgetMs);
  const failing = [];
  const suggestions = [];
  let pending = 0;
  let unknown = 0;
  for (const z of pub) {
    const r = res.get(String(z.domain).toLowerCase());
    if (!r) { pending++; continue; }
    if (r.status === 'unknown') { unknown++; continue; }
    if (r.status === 'none') {
      failing.push(item('zone', z.id, z.domain));
      suggestions.push(r.suggestion || `${z.domain}. CAA 0 issue "letsencrypt.org"`);
    }
  }
  if (failing.length > 0) {
    return check('caa', 'warning', 'fail', failing, { type: 'copy', copy: suggestions.join('\n') }, { pending });
  }
  if (pending > 0 || unknown === pub.length) return check('caa', 'warning', 'na', [], null, { pending });
  return check('caa', 'warning', 'pass', [], null, { pending: 0 });
}

function checkWafCoverage(routes, wafLicensed) {
  if (!wafLicensed) return check('waf_coverage', 'warning', 'na');
  const list = routes.filter((r) => isPublic(r) && isHttp(r) && !r.waf_enabled);
  if (list.length === 0) return check('waf_coverage', 'warning', 'pass');
  return check('waf_coverage', 'warning', 'fail', list.map((r) => item('route', r.id, r.domain)),
    bulkFix(list.map((r) => r.id), { waf_enabled: true, waf_mode: 'detect', waf_paranoia: 1 }));
}

async function checkWafReady(wafLicensed) {
  if (!wafLicensed) return check('waf_ready', 'info', 'na');
  let list = [];
  try {
    const { routes } = await require('./wafAssistant').assistant();
    list = routes.filter((r) => r.mode === 'detect' && r.readiness === 'ready');
  } catch (err) {
    logger.warn({ err: err.message }, 'security check: WAF assistant failed');
    return check('waf_ready', 'info', 'na');
  }
  if (list.length === 0) return check('waf_ready', 'info', 'pass');
  return check('waf_ready', 'info', 'fail', list.map((r) => item('route', r.route_id, r.host)),
    { type: 'link', href: '/waf#assistant' });
}

// Public entries without any access control. HTTP: no auth, no mTLS, no IP
// filter / peer ACL. L4 (docs/feature-next-package.md §S1.4): no usable IP
// filter — a TCP/UDP forward has neither auth nor mTLS to offer, and a
// connection rate is a brake, not access control. Entries that are internal
// only (external_enabled = 0) never reach this check, they are not public.
function checkPublicUnprotected(routes) {
  const list = routes.filter(isPublic).filter((r) => {
    const p = protectionsOf(r);
    return !p.auth && !p.mtls && !p.ip_filter;
  });
  if (list.length === 0) return check('public_unprotected', 'info', 'pass');
  // A plain port forward has no domain — label it the way the entry list does.
  const label = (r) => (isHttp(r)
    ? r.domain
    : `${String(r.l4_protocol || 'tcp').toUpperCase()} ${r.l4_listen_port || '?'}${r.domain ? ` (${r.domain})` : ''}`);
  return check('public_unprotected', 'info', 'fail', list.map((r) => item('route', r.id, label(r))), null);
}

function checkBackupOffsite(db) {
  if (!license.hasFeature('scheduled_backups')) return check('backup_offsite', 'warning', 'na');
  const fix = { type: 'link', href: '/settings#backup' };
  const targets = tableExists(db, 'backup_targets')
    ? db.prepare('SELECT id, name, enabled, last_run_at, last_status FROM backup_targets WHERE enabled = 1 ORDER BY id').all()
    : [];
  if (targets.length === 0) return check('backup_offsite', 'warning', 'fail', [], fix);
  const now = Date.now();
  const bad = targets.filter((t) => {
    const okStatus = BACKUP_OK_STATUSES.includes(String(t.last_status || '').toLowerCase());
    const at = t.last_run_at ? new Date(/^\d{4}-\d{2}-\d{2} /.test(t.last_run_at) ? t.last_run_at.replace(' ', 'T') + 'Z' : t.last_run_at).getTime() : NaN;
    return !okStatus || !Number.isFinite(at) || now - at > BACKUP_MAX_AGE_MS;
  });
  if (bad.length === 0) return check('backup_offsite', 'warning', 'pass');
  return check('backup_offsite', 'warning', 'fail', bad.map((t) => item('target', t.id, t.name)), fix);
}

function checkTlsMin(zones) {
  const list = zones.filter((z) => String(z.tls_min_version || '1.2') !== '1.3');
  if (zones.length === 0) return check('tls_min', 'info', 'na');
  if (list.length === 0) return check('tls_min', 'info', 'pass');
  return check('tls_min', 'info', 'fail', list.map((z) => item('zone', z.id, z.domain)), null);
}

function checkAutoUpdate() {
  let st;
  try { st = require('./autoUpdate').getStatus(); } catch { return check('auto_update', 'info', 'na'); }
  const fix = { type: 'link', href: '/dashboard#auto-update' };
  if (st.last_action === 'rolled_back' || st.last_action === 'failed') {
    return check('auto_update', 'warning', 'fail', [], fix, { mode: st.mode, last_action: st.last_action });
  }
  if (st.status === 'not_configured') return check('auto_update', 'info', 'na', [], null, { mode: st.mode, last_action: null });
  if (st.mode === 'manual') return check('auto_update', 'info', 'fail', [], fix, { mode: st.mode, last_action: st.last_action || null });
  return check('auto_update', 'info', 'pass', [], null, { mode: st.mode, last_action: st.last_action || null });
}

/** GET /security/check payload. */
async function runCheck({ userId, budgetMs = CAA_BUDGET_MS } = {}) {
  const db = getDb();
  const routes = loadRoutes(db);
  const admins = adminsOf(db);
  const zones = activeZones(db, routes);
  const wafLicensed = license.hasFeature('waf');

  const [caa, wafReady] = await Promise.all([checkCaa(zones, budgetMs), checkWafReady(wafLicensed)]);
  const checks = [
    checkAdmin2fa(admins, userId),
    checkRequire2fa(admins),
    checkHsts(routes),
    caa,
    checkWafCoverage(routes, wafLicensed),
    wafReady,
    checkPublicUnprotected(routes),
    checkBackupOffsite(db),
    checkTlsMin(zones),
    checkAutoUpdate(),
  ];
  const summary = { pass: 0, fail: 0, info: 0 };
  for (const c of checks) {
    if (c.status === 'pass') summary.pass++;
    else if (c.status === 'fail') summary[c.severity === 'info' ? 'info' : 'fail']++;
  }
  return { generated_at: nowIso(), summary, checks };
}

// ─── Exposure ───────────────────────────────────────────

function targetOf(r) {
  if (r.target_kind === 'gateway') {
    if (r.target_lan_host) return `${r.target_lan_host}:${r.target_lan_port != null ? r.target_lan_port : r.target_port}`;
    return null;
  }
  const ip = r.peer_id && r.peer_allowed_ips ? String(r.peer_allowed_ips).split('/')[0] : r.target_ip;
  return ip ? `${ip}:${r.target_port}` : null;
}

function healthOf(r, ctx) {
  const domainZones = require('./domainZones');
  let base;
  try { base = domainZones.entryHealth(r, ctx); } catch { base = 'unknown'; }
  if (base === 'down') return 'down';
  if (r.monitoring_enabled && r.monitoring_status === 'up') return 'ok';
  if (r.target_kind === 'gateway' && (r.target_pool_id != null || r.target_peer_id != null)) return base === 'ok' ? 'ok' : 'unknown';
  if (r.peer_id != null) return base === 'ok' ? 'ok' : 'unknown';
  return 'unknown';
}

function healthContext(db) {
  let timeoutS = 180;
  try { timeoutS = parseInt(settings.get('data.peer_online_timeout', '180'), 10) || 180; } catch { /* default */ }
  const peers = new Map(db.prepare('SELECT id, enabled, latest_handshake FROM peers').all().map((p) => [p.id, p]));
  const gwMeta = new Map(db.prepare('SELECT peer_id, alive FROM gateway_meta').all().map((g) => [g.peer_id, g]));
  const poolMembers = new Map();
  for (const m of db.prepare('SELECT pool_id, peer_id FROM gateway_pool_members').all()) {
    if (!poolMembers.has(m.pool_id)) poolMembers.set(m.pool_id, []);
    poolMembers.get(m.pool_id).push(m.peer_id);
  }
  return { timeoutS, peers, gwMeta, poolMembers };
}

/** GET /security/exposure payload: public entries sorted by host. */
function exposure() {
  const db = getDb();
  const routes = loadRoutes(db).filter(isPublic);
  const ctx = healthContext(db);
  const domainZones = require('./domainZones');
  const entries = routes.map((r) => {
    let zone = r.zone_domain || null;
    if (!zone && r.domain) {
      try { const z = domainZones.resolveZone(r.domain, db); zone = z ? z.domain : null; } catch { zone = null; }
    }
    const e = {
      route_id: r.id,
      host: r.domain || null,
      zone,
      type: isHttp(r) ? 'http' : 'l4',
      target: targetOf(r),
      health: healthOf(r, ctx),
      protections: protectionsOf(r),
    };
    if (!isHttp(r)) {
      e.listen_port = r.l4_listen_port != null ? String(r.l4_listen_port) : null;
      e.protocol = r.l4_protocol || null;
    }
    return e;
  });
  entries.sort((a, b) => {
    if (a.host && !b.host) return -1;
    if (!a.host && b.host) return 1;
    const c = String(a.host || '').localeCompare(String(b.host || ''), undefined, { sensitivity: 'base' });
    return c !== 0 ? c : a.route_id - b.route_id;
  });
  return { entries };
}

function _setCaaLookupForTest(fn) { if (process.env.NODE_ENV === 'test') _caaSeam = fn; }
function _resetCaaCacheForTest() { _caa.clear(); _caaInflight.clear(); _caaAnnounce = null; }

module.exports = {
  CAA_BUDGET_MS,
  CAA_TTL_MS,
  runCheck,
  exposure,
  protectionsOf,
  _setCaaLookupForTest,
  _resetCaaCacheForTest,
};
