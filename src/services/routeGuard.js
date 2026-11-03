'use strict';

// Route protection at a glance (Einstellungen › Sicherheit › Routenschutz).
//
// Reads what every route already has — nothing here adds a protection of its
// own: access (external_enabled = 0 is "nur über VPN", an active peer ACL
// "nur bestimmte Geräte"), login (Basic Auth, Route Auth, client
// certificate), countries / IP filter, rate limit, WAF. On top: a risk per
// route (risk() below, documented in FEATURES.md), the "Ist Absicht"
// confirmations (route_guard_acks) and the defaults for new routes.
//
// Risk (heuristic, every reason named in `reasons`):
//   low    the route is off, only reachable through the VPN / for chosen
//          devices, or asks for a login (Basic Auth, Route Auth, mTLS)
//   high   reachable from the internet without a login AND it looks like an
//          administration interface: a typical admin port of its target
//          (Proxmox 8006, Synology 5000/5001, Portainer 9443, Cockpit 9090,
//          Webmin 10000, UniFi 8443, Docker API 2375 …) or a name like
//          proxmox, router, nas, portainer, opnsense … in host or label;
//          an L4 forward of a remote-access / database port (22, 3389, 5900,
//          3306, 5432, 6379, 27017, 445 …) to the internet
//   check  reachable from the internet without a login otherwise (a public
//          gallery may be fine — "Ist Absicht" confirms it)
// A confirmation stays as long as access, login and target of the route are
// the same (fingerprint); a change asks again.
//
// Defaults for new routes (routeguard.defaults): access, WAF, countries,
// rate limit — used by routes.create() for every field the creation leaves
// open (a zone default — Zugang / WAF of the domain — comes first).

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const settings = require('./settings');
const logger = require('../utils/logger');

const K_DEFAULTS = 'routeguard.defaults';
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
const COUNTRY_PRESETS = { all: null, de: ['DE'], dach: ['DE', 'AT', 'CH'], de_eu: EU.slice() };

const ADMIN_PORTS = new Set([8006, 8007, 5000, 5001, 9443, 9000, 9090, 10000, 8443, 2375, 2376, 2019, 8834, 8888, 9001, 61208, 8081, 7443, 19999]);
const ADMIN_NAME_RE = /(?:^|[.\-_\s])(?:proxmox|pve|pbs|portainer|router|fritz|fritzbox|speedport|unifi|opnsense|pfsense|truenas|freenas|unraid|webmin|cockpit|admin|synology|dsm|nas|esxi|vcenter|idrac|ilo|ipmi|traefik|adminer|phpmyadmin|pihole|adguard|openwrt|mikrotik|omada|guacamole|netdata|glances|docker|k8s|kubernetes|rancher)(?:$|[.\-_\s\d])/i;
const DANGEROUS_L4_PORTS = new Set([22, 23, 445, 139, 3389, 5900, 5901, 3306, 5432, 6379, 27017, 9200, 11211, 1433, 1521, 2375, 2376]);

class RouteGuardError extends Error {
  constructor(code, message, status = 400, field = null) { super(message || code); this.code = code; this.statusCode = status; this.field = field; }
}

function db() { return getDb(); }

// ─── Defaults for new routes ───────────────────────────

const DEFAULTS = Object.freeze({ access: 'vpn', waf: false, countries: 'all', rate_limit: 0 });

function getDefaults() {
  let raw = {};
  try { raw = JSON.parse(settings.get(K_DEFAULTS, '{}')) || {}; } catch { raw = {}; }
  return {
    access: raw.access === 'internet' ? 'internet' : DEFAULTS.access,
    waf: typeof raw.waf === 'boolean' ? raw.waf : DEFAULTS.waf,
    countries: Object.prototype.hasOwnProperty.call(COUNTRY_PRESETS, raw.countries) ? raw.countries : DEFAULTS.countries,
    rate_limit: Number.isInteger(raw.rate_limit) && raw.rate_limit >= 0 && raw.rate_limit <= 100000 ? raw.rate_limit : DEFAULTS.rate_limit,
  };
}

function has(feature) {
  try { return require('./license').hasFeature(feature); } catch { return false; }
}

function geoKeySet() {
  try { return !!settings.get('ip2location.api_key', ''); } catch { return false; }
}

function setDefaults(input) {
  const b = input && typeof input === 'object' ? input : {};
  const next = getDefaults();
  if (b.access !== undefined) {
    if (!['internet', 'vpn'].includes(b.access)) throw new RouteGuardError('invalid', 'access must be internet or vpn', 400, 'access');
    next.access = b.access;
  }
  if (b.waf !== undefined) {
    if (typeof b.waf !== 'boolean') throw new RouteGuardError('invalid', 'waf must be true or false', 400, 'waf');
    if (b.waf && !has('waf')) throw Object.assign(new RouteGuardError('license', 'the WAF needs a licence', 403, 'waf'), { feature: 'waf' });
    next.waf = b.waf;
  }
  if (b.countries !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(COUNTRY_PRESETS, b.countries)) throw new RouteGuardError('invalid', 'unknown country preset', 400, 'countries');
    if (b.countries !== 'all' && !has('ip_access_control')) throw Object.assign(new RouteGuardError('license', 'countries need a licence', 403, 'countries'), { feature: 'ip_access_control' });
    if (b.countries !== 'all' && !geoKeySet()) throw new RouteGuardError('geo_key', 'countries need an ip2location.io key (Einstellungen › Geo-IP)', 400, 'countries');
    next.countries = b.countries;
  }
  if (b.rate_limit !== undefined) {
    const n = Number(b.rate_limit);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new RouteGuardError('invalid', 'rate_limit must be 0 … 100000 per minute', 400, 'rate_limit');
    if (n > 0 && !has('rate_limiting')) throw Object.assign(new RouteGuardError('license', 'the rate limit needs a licence', 403, 'rate_limit'), { feature: 'rate_limiting' });
    next.rate_limit = n;
  }
  settings.set(K_DEFAULTS, JSON.stringify(next));
  return getDefaults();
}

/**
 * Fill the fields a new route leaves open (routes.create): `data` is changed
 * in place. `zoneWaf`: the domain has its own WAF default (that one wins).
 * Licence gates as for an explicit field; countries only with a Geo-IP key —
 * a country allow list without lookups would turn every visitor away.
 */
function applyDefaults(data, { routeType = 'http', zoneWaf = false, hasWafInput = false } = {}) {
  let d;
  try { d = getDefaults(); } catch { return data; }
  if (data.external_enabled === undefined) data.external_enabled = d.access === 'internet';
  if (routeType !== 'http') return data;
  if (!hasWafInput && !zoneWaf && d.waf && has('waf')) data.waf_enabled = true;
  if (data.ip_filter_enabled === undefined && d.countries !== 'all' && has('ip_access_control') && geoKeySet()) {
    data.ip_filter_enabled = true;
    data.ip_filter_mode = 'whitelist';
    data.ip_filter_rules = COUNTRY_PRESETS[d.countries].map((c) => ({ type: 'country', value: c }));
  }
  if (data.rate_limit_enabled === undefined && d.rate_limit > 0 && has('rate_limiting')) {
    data.rate_limit_enabled = true;
    data.rate_limit_requests = d.rate_limit;
    data.rate_limit_window = '1m';
  }
  return data;
}

// ─── The routes ────────────────────────────────────────

function parseRules(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function accessOf(r) {
  if (r.acl_enabled) {
    // persons / groups of the route pass too when acl_people is on (services/groupAccess.js)
    let people = false;
    try { const v = JSON.parse(r.user_ids || '[]'); people = !!r.acl_people && Array.isArray(v) && v.length > 0; } catch { people = false; }
    let peers = 0;
    try { peers = db().prepare('SELECT COUNT(*) AS n FROM route_peer_acl WHERE route_id = ?').get(r.id).n; } catch { peers = 0; }
    if (peers > 0 || people) return 'peers';
  }
  return r.external_enabled ? 'internet' : 'vpn';
}

function authOf(r, ra) {
  if (r.basic_auth_enabled) return { kind: 'basic', twofa: false };
  if (ra) return { kind: 'route', type: ra.auth_type, twofa: !!ra.two_factor_enabled };
  if (r.mtls_enabled) return { kind: 'mtls', twofa: false };
  return null;
}

function geoOf(r) {
  if (!r.ip_filter_enabled) return null;
  const rules = parseRules(r.ip_filter_rules);
  return {
    mode: r.ip_filter_mode === 'blacklist' ? 'block' : 'allow',
    countries: rules.filter((x) => x && x.type === 'country').map((x) => String(x.value).toUpperCase()).slice(0, 30),
    addresses: rules.filter((x) => x && (x.type === 'ip' || x.type === 'cidr')).length,
  };
}

function targetOf(r) {
  if (r.target_kind === 'gateway') return { host: r.target_lan_host || null, port: Number(r.target_lan_port || r.target_port) || null, via: 'gateway' };
  return { host: r.target_ip || null, port: Number(r.target_port) || null, via: r.peer_id ? 'peer' : 'direct' };
}

function looksAdmin(r, target) {
  if (target.port && ADMIN_PORTS.has(target.port)) return 'port';
  const names = [r.domain, r.label, r.description].filter(Boolean).join(' ');
  if (ADMIN_NAME_RE.test(names)) return 'name';
  return null;
}

/** Fingerprint of what a confirmation ("Ist Absicht") was given for. */
function fingerprint(r, access, auth, target) {
  return crypto.createHash('sha256').update(JSON.stringify([access, auth ? auth.kind : null, target.host, target.port, r.domain, r.route_type])).digest('hex').slice(0, 16);
}

/** Risk of one route → { level, reasons[] } (see the header). */
function risk(r, { access, auth, target, waf }) {
  const reasons = [];
  if (!r.enabled) return { level: 'low', reasons: ['off'] };
  if (access !== 'internet') return { level: 'low', reasons: [access === 'peers' ? 'peers_only' : 'vpn_only'] };
  if (r.route_type === 'l4') {
    const port = Number(String(r.l4_listen_port || '').split('-')[0]) || null;
    if ((port && DANGEROUS_L4_PORTS.has(port)) || (target.port && DANGEROUS_L4_PORTS.has(target.port))) return { level: 'high', reasons: ['l4_sensitive_port'] };
    return { level: 'check', reasons: ['l4_open'] };
  }
  if (auth) return { level: 'low', reasons: ['login'] };
  const admin = looksAdmin(r, target);
  reasons.push('no_login');
  if (!waf) reasons.push('no_waf');
  if (admin) return { level: 'high', reasons: ['admin_' + admin, ...reasons] };
  return { level: 'check', reasons };
}

function routeHref(r) {
  if (r.zone_id != null && r.bundle_id != null) return '/routes?domain=' + r.zone_id + '&host=' + r.bundle_id;
  return '/routes';
}

function rows() {
  const list = db().prepare(`
    SELECT r.*, sb.domain_id AS zone_id
    FROM routes r
    LEFT JOIN service_bundles sb ON sb.id = r.bundle_id
    ORDER BY r.domain COLLATE NOCASE, r.id`).all();
  const auths = new Map(db().prepare('SELECT * FROM route_auth').all().map((a) => [a.route_id, a]));
  const acks = new Map(db().prepare('SELECT * FROM route_guard_acks').all().map((a) => [a.route_id, a]));
  return list.map((r) => {
    const access = accessOf(r);
    const auth = authOf(r, auths.get(r.id));
    const target = targetOf(r);
    const waf = r.route_type !== 'l4' && r.waf_enabled ? { mode: r.waf_mode || 'detect' } : null;
    const rk = risk(r, { access, auth, target, waf });
    const fp = fingerprint(r, access, auth, target);
    const ack = acks.get(r.id);
    const acked = !!ack && ack.kind === fp;
    return {
      id: r.id,
      host: r.domain || (r.l4_listen_port ? `:${r.l4_listen_port}` : `#${r.id}`),
      label: r.label || null,
      type: r.route_type === 'l4' ? 'l4' : 'http',
      enabled: !!r.enabled,
      target,
      access,
      auth,
      geo: geoOf(r),
      rateLimit: r.rate_limit_enabled ? { requests: Number(r.rate_limit_requests) || 0, window: r.rate_limit_window || '1m' } : null,
      waf,
      risk: acked && rk.level !== 'low' ? 'ack' : rk.level,
      reasons: rk.reasons,
      ack: acked ? { at: new Date(ack.at).toISOString(), by: ack.by_user } : null,
      href: routeHref(r),
    };
  });
}

/** GET /api/v1/settings/route-guard */
function overview() {
  const list = rows();
  const active = list.filter((r) => r.enabled);
  const http = active.filter((r) => r.type === 'http');
  return {
    routes: list,
    stats: {
      total: active.length,
      vpn: active.filter((r) => r.access !== 'internet').length,
      login: active.filter((r) => r.access === 'internet' && r.auth).length,
      open: active.filter((r) => r.access === 'internet' && !r.auth).length,
      waf: http.filter((r) => r.waf).length,
      http: http.length,
      high: active.filter((r) => r.risk === 'high').length,
      check: active.filter((r) => r.risk === 'check').length,
    },
    attention: active.filter((r) => r.risk === 'high' || r.risk === 'check')
      .sort((a, b) => (a.risk === 'high' ? 0 : 1) - (b.risk === 'high' ? 0 : 1))
      .map((r) => ({ id: r.id, host: r.host, risk: r.risk, reasons: r.reasons, href: r.href, type: r.type })),
    defaults: getDefaults(),
    licensed: { waf: has('waf'), ip_access_control: has('ip_access_control'), rate_limiting: has('rate_limiting'), route_auth: has('route_auth') },
    geoKey: geoKeySet(),
    vpn: require('./vpnGuard').getConfig(),
  };
}

/** Counts for the start page of the settings (cheap enough per page load). */
function attentionCount() {
  const list = rows().filter((r) => r.enabled);
  return { high: list.filter((r) => r.risk === 'high').length, check: list.filter((r) => r.risk === 'check').length, total: list.length };
}

// ─── Actions ───────────────────────────────────────────

function routeRow(id) {
  const r = db().prepare('SELECT * FROM routes WHERE id = ?').get(Number(id));
  if (!r) throw new RouteGuardError('not_found', 'route not found', 404);
  return r;
}

/** "Nur über VPN": external_enabled = 0 (the existing field), Caddy synced, rolled back on failure. */
async function vpnOnly(id, userId = null) {
  const r = routeRow(id);
  await require('./routes').bulkUpdate({ ids: [r.id], set: { external_enabled: false } });
  try {
    require('./activity').log('route_guard_vpn_only', `Route ${r.domain || r.id} only reachable through the VPN`, {
      source: 'admin', severity: 'info', details: { routeId: r.id, domain: r.domain, userId },
    });
  } catch { /* best-effort */ }
  return rows().find((x) => x.id === r.id) || null;
}

/** "Ist Absicht": confirm the current state of the route. */
function acknowledge(id, userId = null) {
  const r = routeRow(id);
  const row = rows().find((x) => x.id === r.id);
  const access = accessOf(r);
  const auths = db().prepare('SELECT * FROM route_auth WHERE route_id = ?').get(r.id);
  const fp = fingerprint(r, access, authOf(r, auths), targetOf(r));
  db().prepare(`INSERT INTO route_guard_acks (route_id, kind, at, by_user) VALUES (?, ?, ?, ?)
    ON CONFLICT(route_id) DO UPDATE SET kind = excluded.kind, at = excluded.at, by_user = excluded.by_user`).run(r.id, fp, Date.now(), userId);
  try {
    require('./activity').log('route_guard_ack', `Route ${r.domain || r.id}: open access confirmed as intended`, {
      source: 'admin', severity: 'info', details: { routeId: r.id, domain: r.domain, risk: row ? row.risk : null, userId },
    });
  } catch { /* best-effort */ }
  return rows().find((x) => x.id === r.id) || null;
}

function unacknowledge(id) {
  const r = routeRow(id);
  db().prepare('DELETE FROM route_guard_acks WHERE route_id = ?').run(r.id);
  return rows().find((x) => x.id === r.id) || null;
}

/** Backup: confirmations by domain (route ids change on restore). */
function exportBackup() {
  try {
    return db().prepare('SELECT a.kind, a.at, r.domain FROM route_guard_acks a JOIN routes r ON r.id = a.route_id WHERE r.domain IS NOT NULL').all();
  } catch { return []; }
}

function restoreBackup(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const a of list) {
    if (!a || typeof a.domain !== 'string') continue;
    const r = db().prepare("SELECT id FROM routes WHERE domain = ? AND route_type = 'http'").get(a.domain);
    if (!r) continue;
    try {
      db().prepare('INSERT OR REPLACE INTO route_guard_acks (route_id, kind, at, by_user) VALUES (?, ?, ?, NULL)').run(r.id, String(a.kind).slice(0, 32), Number(a.at) || Date.now());
      n++;
    } catch (err) { logger.debug({ err: err.message }, 'route guard: confirmation not restored'); }
  }
  return n;
}

module.exports = {
  COUNTRY_PRESETS, ADMIN_PORTS, DANGEROUS_L4_PORTS, RouteGuardError,
  getDefaults, setDefaults, applyDefaults, risk, looksAdmin, overview, attentionCount,
  vpnOnly, acknowledge, unacknowledge, exportBackup, restoreBackup,
};
