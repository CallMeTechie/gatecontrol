'use strict';

const fs = require('node:fs');
const settings = require('./settings');
const { getDb } = require('../db/connection');
const config = require('../../config/default');

/**
 * "Namen im VPN" — where the names of the VPN devices live.
 *
 * Two zones, both answered by the dnsmasq of the server alone:
 *   primary — `<sub>.<domain>` of a domain from "Domains / Routen", chosen in
 *             Settings → VPN & Netzwerk (settings keys below), or the legacy
 *             zone while nothing is chosen;
 *   legacy  — GC_DNS_DOMAIN (default gc.internal). It stays for good as the
 *             second spelling: the portal (home.<legacy>), internal routes
 *             and the gateway assistant hang on it, and stored addresses
 *             never break.
 *
 * A device is `<name>.<primary>` AND `<name>.<legacy>` (services/dns.js writes
 * both into the hosts file). entrypoint.sh writes dnsmasq.conf with the legacy
 * zone only at every container start; applyDnsmasq() adds the primary zone
 * (`local=/…/` + the fixed names) in a block of its own and restarts dnsmasq —
 * the pattern of services/dnsChain.js, no container restart.
 *
 * The names exist in the VPN only: nothing is entered at the domain's
 * provider, no certificate is requested for them.
 */

const KEY_BASE = 'dns.names.base_domain';
const KEY_SUB = 'dns.names.sub';
const DEFAULT_SUB = 'vpn';
const FIXED_NAMES = ['gateway', 'server', 'gc-server'];
// Offered when the chosen subdomain is taken, in this order.
const SUB_SUGGESTIONS = ['vpn', 'gc', 'intern', 'net', 'geraete', 'vpn2', 'vpn3'];

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// The block in dnsmasq.conf. Deliberately NOT the `# >>> gatecontrol-<id> >>>`
// form of the DNS chain: dnsChainConf.js removes every block of that form.
const BLOCK_BEGIN = '# --- gatecontrol vpn names: begin ---';
const BLOCK_END = '# --- gatecontrol vpn names: end ---';
const BLOCK_RE = /\n?# --- gatecontrol vpn names: begin ---[\s\S]*?# --- gatecontrol vpn names: end ---\n?/g;

function log() { return require('../utils/logger'); }
function norm(h) { return String(h == null ? '' : h).trim().toLowerCase().replace(/\.$/, ''); }
function confPath() { return process.env.GC_DNSMASQ_CONF || '/app/config/dnsmasq.conf'; }

function legacyZone() { return norm(config.dns.domain) || 'gc.internal'; }

function validZone(zone) {
  return zone.length <= 253 && zone.split('.').length >= 2 && zone.split('.').every((l) => LABEL_RE.test(l));
}

function domainRow(base) {
  if (!base) return null;
  return getDb().prepare('SELECT id, domain, status FROM domains WHERE domain = ? COLLATE NOCASE').get(base) || null;
}

/**
 * The zones as they are in effect.
 * → { base, sub, custom, primary, legacy, zones: [primary, legacy], removed }
 *   custom  — a domain of the admin is chosen (primary !== legacy)
 *   removed — that domain is no longer under "Domains / Routen"; the names go
 *             on working (they only exist in the VPN)
 */
function current() {
  const legacy = legacyZone();
  let base = '';
  let sub = DEFAULT_SUB;
  try {
    base = norm(settings.get(KEY_BASE, ''));
    sub = norm(settings.get(KEY_SUB, DEFAULT_SUB)) || DEFAULT_SUB;
  } catch { base = ''; }
  const zone = base ? `${sub}.${base}` : '';
  // A stored value that cannot be a zone (edited by hand, broken restore)
  // never reaches dnsmasq.conf or the hosts file.
  const custom = !!zone && zone !== legacy && LABEL_RE.test(sub) && validZone(zone);
  const primary = custom ? zone : legacy;
  let removed = false;
  if (custom) { try { removed = !domainRow(base); } catch { removed = false; } }
  return {
    base: custom ? base : '',
    sub: custom ? sub : DEFAULT_SUB,
    custom,
    primary,
    legacy,
    zones: custom ? [primary, legacy] : [legacy],
    removed,
  };
}

/** `<name>.<zone>` for every zone, primary first. */
function fqdnsOf(name) {
  const n = norm(name);
  return n ? current().zones.map((z) => `${n}.${z}`) : [];
}

function under(host, zone) { return host === zone || host.endsWith('.' + zone); }

function managementHost() {
  try { return norm(new URL(config.app.baseUrl).hostname); } catch { return ''; }
}
function portalHost() {
  try { return norm(require('./portalConfig').effectivePortalHost().host); } catch { return ''; }
}

/**
 * What already lives at or below `<sub>.<base>` and so keeps it from becoming
 * the zone of the device names. → { kind, fqdn } | null
 *   host — a host of the zone (service_bundles.subdomain equal to the
 *          subdomain or ending in `.<sub>`); route — a route domain;
 *   management / portal — GateControl's own addresses; domain — another
 *   domain entered under "Domains / Routen".
 */
function findCollision(base, sub) {
  const zone = `${sub}.${base}`;
  const db = getDb();
  const row = domainRow(base);
  if (row) {
    const hosts = db.prepare("SELECT subdomain FROM service_bundles WHERE domain_id = ? AND subdomain IS NOT NULL AND subdomain != ''").all(row.id);
    for (const h of hosts) {
      const s = norm(h.subdomain);
      if (s === sub || s.endsWith('.' + sub)) return { kind: 'host', fqdn: `${s}.${base}` };
    }
  }
  const routes = db.prepare("SELECT DISTINCT domain FROM routes WHERE domain IS NOT NULL AND domain != ''").all();
  for (const r of routes) {
    const d = norm(r.domain);
    if (under(d, zone)) return { kind: 'route', fqdn: d };
  }
  const mh = managementHost();
  if (mh && under(mh, zone)) return { kind: 'management', fqdn: mh };
  const ph = portalHost();
  if (ph && under(ph, zone)) return { kind: 'portal', fqdn: ph };
  for (const d of db.prepare('SELECT domain FROM domains').all()) {
    const dom = norm(d.domain);
    if (dom !== base && under(dom, zone)) return { kind: 'domain', fqdn: dom };
  }
  return null;
}

function suggestSub(base, taken) {
  for (const s of SUB_SUGGESTIONS) {
    if (s === taken) continue;
    if (`${s}.${base}` === legacyZone()) continue;
    if (!findCollision(base, s)) return s;
  }
  return null;
}

/**
 * Check a choice before it is saved (and for the live preview).
 * → { ok: true, primary, legacy, custom }
 * → { ok: false, error, field, fqdn?, suggestion? }
 *   error: domain_unknown | sub_required | sub_invalid | same_as_default |
 *          collision_host | collision_route | collision_management |
 *          collision_portal | collision_domain
 */
function check(baseRaw, subRaw) {
  const legacy = legacyZone();
  const base = norm(baseRaw);
  if (!base) return { ok: true, primary: legacy, legacy, custom: false };
  if (!domainRow(base)) return { ok: false, error: 'domain_unknown', field: 'base_domain' };
  const sub = norm(subRaw);
  if (!sub) return { ok: false, error: 'sub_required', field: 'sub', suggestion: suggestSub(base, '') };
  if (!LABEL_RE.test(sub) || !validZone(`${sub}.${base}`)) return { ok: false, error: 'sub_invalid', field: 'sub', suggestion: suggestSub(base, sub) };
  const zone = `${sub}.${base}`;
  if (zone === legacy) return { ok: false, error: 'same_as_default', field: 'sub', suggestion: suggestSub(base, sub) };
  const hit = findCollision(base, sub);
  if (hit) return { ok: false, error: 'collision_' + hit.kind, field: 'sub', fqdn: hit.fqdn, suggestion: suggestSub(base, sub) };
  return { ok: true, primary: zone, legacy, custom: true };
}

/**
 * Save a checked choice and put it into effect: dnsmasq.conf, the hosts file,
 * the open app streams (the client config names the zones) and the gateways
 * (`features.internal_dns` of their config pull).
 * @returns {{ ok: true, restarted: boolean } & ReturnType<typeof current>}
 */
function save(baseRaw, subRaw) {
  const base = norm(baseRaw);
  const v = check(base, subRaw);
  if (!v.ok) return v;
  settings.set(KEY_BASE, base);
  if (base) settings.set(KEY_SUB, norm(subRaw));
  const restarted = apply();
  // the gateways get the zones in `features.internal_dns` of their config pull (part of its hash): told
  // to pull now — one that is not reachable takes them over with its next poll
  try { require('./gatewayFeatures').notifyAllGateways(); } catch (err) { log().debug({ err: err.message }, 'gateways not told about the zones'); }
  return Object.assign({ ok: true, restarted }, current());
}

/**
 * Put the saved choice into effect (server start, save, backup restore).
 * Best-effort like the DNS chain: no dnsmasq.conf here (tests, a development
 * machine) is not an error. → whether dnsmasq was restarted
 */
function apply() {
  let restarted = false;
  try { restarted = applyDnsmasq(); } catch (err) { log().warn({ err: err.message }, 'vpn names: dnsmasq.conf not written'); }
  try { require('./dns').rebuildNow(); } catch (err) { log().warn({ err: err.message }, 'vpn names: hosts file not rebuilt'); }
  try { require('./notify/control').configChanged({ all: true }); } catch (err) { log().debug({ err: err.message }, 'config_changed push not sent'); }
  return restarted;
}

/** The lines of the block for the zones in effect ([] = no block). */
function blockLines(state = current()) {
  if (!state.custom) return [];
  const gw = config.wireguard.gatewayIp;
  return [
    BLOCK_BEGIN,
    // Like the legacy zone in entrypoint.sh: never forwarded upstream — a name
    // that does not exist here is answered with "does not exist" at once.
    `local=/${state.primary}/`,
    ...FIXED_NAMES.map((n) => `host-record=${n}.${state.primary},${gw}`),
    BLOCK_END,
  ];
}

/**
 * Write the block into dnsmasq.conf and restart dnsmasq — only when the conf
 * does not already say exactly this (a server process starting next to a
 * dnsmasq that kept running causes no restart). SIGHUP is not enough:
 * dnsmasq reads `local=` and `host-record=` at its start only.
 *
 * Same process, same thread as the DNS chain's writer, and both read, change
 * and write the file in one synchronous step; the chain leaves this block
 * alone (see BLOCK_BEGIN) and this function never touches `server=` lines.
 * @returns {boolean} whether the conf changed (and dnsmasq was restarted)
 */
function applyDnsmasq() {
  // One open file for reading and writing: what is written is based on
  // exactly what was read, whatever happens to the path in between.
  let fd;
  try {
    fd = fs.openSync(confPath(), 'r+');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false; // no dnsmasq here (tests, a development machine)
    throw err;
  }
  let zone = null;
  try {
    const before = fs.readFileSync(fd, 'utf8');
    const lines = blockLines();
    const have = (before.match(BLOCK_RE) || []).map((b) => b.trim()).join('\n');
    if (have === lines.join('\n')) return false;
    let content = before.replace(BLOCK_RE, '\n').trimEnd();
    if (lines.length) { content += '\n' + lines.join('\n'); zone = current().primary; }
    const data = Buffer.from(content + '\n', 'utf8');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, data, 0, data.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  log().info({ zone }, 'vpn names: dnsmasq.conf written, restarting dnsmasq');
  require('./dns').restartDnsmasq();
  return true;
}

/** Is `host` the zone of the device names or a name inside it? (routes and hosts must stay out) */
function insideDeviceZone(host) {
  const s = current();
  return s.custom && under(norm(host), s.primary);
}

/**
 * Does a device name collide with something that already answers under one of
 * the zones — a route domain or the portal host? → the colliding fqdn | null
 * (Reserved names and names of other devices are checked in services/dns.js.)
 */
function deviceNameCollision(name) {
  const fqdns = fqdnsOf(name);
  if (!fqdns.length) return null;
  const ph = portalHost();
  const mh = managementHost();
  for (const f of fqdns) {
    if (f === ph || f === mh) return f;
  }
  const marks = fqdns.map(() => '?').join(',');
  const row = getDb().prepare(`SELECT domain FROM routes WHERE lower(domain) IN (${marks}) LIMIT 1`).get(...fqdns);
  return row ? norm(row.domain) : null;
}

/** Is `host` the name of a device in one of the zones? → the device's label | null */
function deviceAt(host) {
  const h = norm(host);
  for (const z of current().zones) {
    if (!h.endsWith('.' + z)) continue;
    const label = h.slice(0, -(z.length + 1));
    if (!label || label.includes('.')) continue;
    const row = getDb().prepare("SELECT hostname FROM peers WHERE hostname = ? COLLATE NOCASE").get(label);
    if (row) return label;
  }
  return null;
}

/** The fixed names of the server, in every zone. → [{ name, fqdns: [...], ip }] */
function fixedRecords() {
  const s = current();
  return FIXED_NAMES.map((n) => ({ name: n, fqdns: s.zones.map((z) => `${n}.${z}`), ip: config.wireguard.gatewayIp }));
}

module.exports = {
  KEY_BASE, KEY_SUB, DEFAULT_SUB, FIXED_NAMES,
  legacyZone, current, fqdnsOf, check, save, apply, applyDnsmasq, blockLines,
  insideDeviceZone, deviceNameCollision, deviceAt, fixedRecords, suggestSub,
};
