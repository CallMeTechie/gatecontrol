// src/services/domains.js
'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const os = require('node:os');
const ipaddr = require('ipaddr.js');
const { getDb } = require('../db/connection');
const settings = require('./settings');
const config = require('../../config/default');
const { normalizeHost } = require('./domainSeed');
const { isLoopbackHost } = require('../utils/validate');

const DEFAULT_RESOLVERS = ['1.1.1.1', '9.9.9.9', '8.8.8.8'];
const TIMEOUT_MS = 5000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref()),
  ]);
}

function resolverServers() {
  return (settings.get('server.verify_resolver', '') || DEFAULT_RESOLVERS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
}

// Injectable seam: resolve(host, family) -> Promise<string[]>. Default uses an
// EXPLICIT public resolver (never the ambient/dnsmasq resolver).
let _resolve = async (host, family) => {
  const r = new dns.Resolver();
  r.setServers(resolverServers());
  return withTimeout(family === 6 ? r.resolve6(host) : r.resolve4(host));
};
// Injectable seam: resolveCaa(host) -> Promise<Array<{critical, issue?|issuewild?|iodef?}>>
// (Node's dns.resolveCaa shape). Throws on NODATA/NXDOMAIN like Node does.
let _resolveCaa = async (host) => {
  const r = new dns.Resolver();
  r.setServers(resolverServers());
  return withTimeout(r.resolveCaa(host));
};
// Injectable seam for the interface scan (os.networkInterfaces()).
let _interfaces = () => os.networkInterfaces();
// Test override for the whole server-address result (bypasses settings, config and interfaces).
let _serverIpsOverride = null;
let _resolverInjected = false;

function _setResolverForTest(fn) { if (process.env.NODE_ENV === 'test') { _resolve = fn; _resolverInjected = true; } }
function _setCaaResolverForTest(fn) { if (process.env.NODE_ENV === 'test') _resolveCaa = fn; }
function _setInterfacesForTest(fn) { if (process.env.NODE_ENV === 'test') _interfaces = fn; }
function _setServerIpsForTest(ips) { if (process.env.NODE_ENV === 'test') _serverIpsOverride = ips || null; }
function _isResolverInjected() { return _resolverInjected; }

async function resolveHost(host) {
  // returns { v4, v6 }. A FAMILY THROW = transient (timeout/SERVFAIL); an empty
  // array = NXDOMAIN (legit "no records"). If any family threw AND we got NO
  // records at all, surface transient (caller → pending), NOT "no records".
  const out = { v4: [], v6: [] };
  let threw = 0;
  try { out.v4 = await _resolve(host, 4) || []; } catch { threw++; }
  try { out.v6 = await _resolve(host, 6) || []; } catch { threw++; }
  if (threw > 0 && out.v4.length === 0 && out.v6.length === 0) {
    throw new Error('resolver_unreachable');
  }
  return out;
}

/**
 * CAA records of ONE name as { flags, tag, value }[]; [] when the name has no
 * CAA set (NODATA/NXDOMAIN). Any other resolver error → null (unknown).
 */
async function resolveCaa(host) {
  let raw;
  try { raw = await _resolveCaa(host); }
  catch (err) {
    const code = err && err.code;
    if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
    return null;
  }
  const out = [];
  for (const rec of raw || []) {
    if (!rec || typeof rec !== 'object') continue;
    const flags = Number(rec.critical || rec.flags || 0) || 0;
    for (const tag of ['issue', 'issuewild', 'iodef']) {
      if (rec[tag] !== undefined) out.push({ flags, tag, value: String(rec[tag]) });
    }
  }
  return out;
}

// ── Server addresses ──

// Public unicast only: a split-horizon or hosts-file answer for GC_WG_HOST
// (127.0.1.1, 10.8.0.1, ::1 …) must never become "the server address".
const NON_PUBLIC_RANGES = new Set([
  'unspecified', 'loopback', 'private', 'linkLocal', 'carrierGradeNat', 'broadcast', 'multicast',
  'uniqueLocal', 'ipv4Mapped', 'discard',
]);
function isPublicAddress(addr) {
  try { return !NON_PUBLIC_RANGES.has(ipaddr.parse(String(addr)).range()); }
  catch { return false; }
}

function isGlobalV6(addr) {
  try {
    const a = ipaddr.parse(addr);
    return a.kind() === 'ipv6' && a.range() === 'unicast'; // 2000::/3 — excludes link-local, ULA, loopback, mapped…
  } catch { return false; }
}

// Node cannot see the "temporary" (privacy-extension) flag. Manually
// configured / SLAAC-stable addresses usually carry a short interface id
// (`::1`, `::10`), temporary ones a random 64-bit tail — prefer the shorter.
function v6Rank(addr) {
  const groups = ipaddr.parse(addr).toNormalizedString().split(':');
  return groups.slice(4).filter(g => g !== '0').length;
}

function interfaceV6() {
  let ifaces;
  try { ifaces = _interfaces() || {}; } catch { return null; }
  const cands = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.internal) continue;
      if (i.family !== 'IPv6' && i.family !== 6) continue;
      if (!isGlobalV6(i.address)) continue;
      cands.push(i.address);
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => v6Rank(a) - v6Rank(b));
  return cands[0];
}

function hostCandidates() {
  const list = [];
  try { list.push(config.wireguard.host); } catch { /* ignore */ }
  try { list.push(new URL(config.app.baseUrl).hostname); } catch { /* ignore */ }
  return list.map(h => normalizeHost(h)).filter(Boolean)
    .filter(h => !isLoopbackHost(h) && h !== '0.0.0.0' && h !== '::');
}

/**
 * Both public addresses of this server:
 *   { v4, v6, source: { v4: 'override'|'literal'|'wg_host'|'unknown',
 *                       v6: 'override'|'interface'|'wg_host'|'unknown' } }
 * v4: setting server.public_ip, else an IP literal in GC_WG_HOST/GC_BASE_URL,
 *     else the A record of those hosts.
 * v6: setting server.public_ipv6 (empty = automatic), else the first global
 *     IPv6 of the network interfaces (the container runs in the host network),
 *     else the AAAA record of GC_WG_HOST.
 * A legacy IPv6 literal in server.public_ip counts as the v6 override.
 */
async function getServerPublicIps() {
  if (_serverIpsOverride) {
    const o = _serverIpsOverride;
    return {
      v4: o.v4 || null, v6: o.v6 || null,
      source: { v4: o.v4 ? 'override' : 'unknown', v6: o.v6 ? 'override' : 'unknown' },
    };
  }
  const out = { v4: null, v6: null, source: { v4: 'unknown', v6: 'unknown' } };
  const ov4 = (settings.get('server.public_ip', '') || '').trim();
  const ov6 = (settings.get('server.public_ipv6', '') || '').trim();
  if (ov4 && net.isIPv4(ov4)) { out.v4 = ov4; out.source.v4 = 'override'; }
  if (ov6 && net.isIPv6(ov6)) { out.v6 = ov6; out.source.v6 = 'override'; }
  else if (ov4 && net.isIPv6(ov4)) { out.v6 = ov4; out.source.v6 = 'override'; }

  const cands = hostCandidates();
  if (!out.v4) {
    for (const host of cands) {
      if (net.isIPv4(host)) { out.v4 = host; out.source.v4 = 'literal'; break; }
    }
  }
  if (!out.v6) {
    const fromIf = interfaceV6();
    if (fromIf) { out.v6 = fromIf; out.source.v6 = 'interface'; }
  }
  if (!out.v4 || !out.v6) {
    for (const host of cands) {
      if (net.isIP(host)) continue;
      let r;
      try { r = await resolveHost(host); } catch { continue; }
      const a4 = r.v4.find(isPublicAddress);
      const a6 = r.v6.find(isPublicAddress);
      if (!out.v4 && a4) { out.v4 = a4; out.source.v4 = 'wg_host'; }
      if (!out.v6 && a6) { out.v6 = a6; out.source.v6 = 'wg_host'; }
      if (out.v4) break;
    }
  }
  return out;
}

/** Compatibility wrapper — the IPv4 address as before: { ip, family, source }. */
async function getServerPublicIp() {
  const ips = await getServerPublicIps();
  return { ip: ips.v4, family: ips.v4 ? 4 : null, source: ips.source.v4 };
}

// Canonicalize an IP for comparison. Resolver output is already canonical, but a
// user-entered override / config literal may be non-canonical IPv6 (uppercase,
// leading zeros, '::' compression) — a plain string compare would then miss a
// correctly-pointing AAAA record. Falls back to lowercase for non-IP input.
function canonIp(ip) {
  try { return ipaddr.parse(String(ip)).toNormalizedString(); }
  catch { return String(ip || '').trim().toLowerCase(); }
}

/**
 * Strict domain verification — the same rules as tlsGuard.preflight() (A, AAAA
 * and CAA must all fit this server; no `not_public` short-cut). Returns
 *   { status: 'verified'|'pending'|'failed', resolvedIp, expectedIp, error, check }
 * where `error` is the preflight code and `check` the full preflight object
 * (persisted as domains.check_json).
 */
async function verify(domain) {
  const host = normalizeHost(domain);
  const { evaluatePreflight } = require('./tlsGuard');
  const check = await evaluatePreflight(host, { skipPublicCheck: true });
  const expectedIp = check.server.v4 || null;
  if (check.code === 'server_ip_unknown' || check.code === 'resolver_unreachable') {
    return { status: 'pending', resolvedIp: null, expectedIp, error: check.code, check };
  }
  if (check.ok) {
    return { status: 'verified', resolvedIp: expectedIp, expectedIp, error: null, check };
  }
  const foreign = [...check.records.a, ...check.records.aaaa].find(a => canonIp(a) !== canonIp(check.server.v4) && canonIp(a) !== canonIp(check.server.v6 || ''));
  return {
    status: 'failed',
    resolvedIp: foreign || check.records.a[0] || check.records.aaaa[0] || null,
    expectedIp, error: check.code, check,
  };
}

// ── CRUD ──
function row(domain) { return getDb().prepare('SELECT * FROM domains WHERE domain = ?').get(normalizeHost(domain)); }
function list() { return getDb().prepare('SELECT * FROM domains ORDER BY domain').all(); }
function listVerified() { return getDb().prepare("SELECT * FROM domains WHERE status='verified' ORDER BY domain").all(); }
function baseDomains() { return listVerified().map(r => r.domain); }
function isVerified(domain) { const r = row(domain); return !!r && r.status === 'verified'; }

function upsert(domain, v) {
  const db = getDb();
  // RETURNING * hands back the written row directly — no second SELECT round-trip.
  return db.prepare(`INSERT INTO domains (domain, status, resolved_ip, last_error, verified_at, last_checked_at, check_json)
    VALUES (@domain, @status, @resolved_ip, @last_error, @verified_at, datetime('now'), @check_json)
    ON CONFLICT(domain) DO UPDATE SET status=excluded.status, resolved_ip=excluded.resolved_ip,
      last_error=excluded.last_error, verified_at=excluded.verified_at, last_checked_at=excluded.last_checked_at,
      check_json=excluded.check_json
    RETURNING *`)
    .get({
      domain: normalizeHost(domain), status: v.status, resolved_ip: v.resolvedIp || null,
      last_error: v.error || null, verified_at: v.status === 'verified' ? new Date().toISOString() : null,
      check_json: v.check ? JSON.stringify(v.check) : null,
    });
}

async function add(domain) {
  const v = await verify(domain);
  return upsert(domain, v);
}
function seedPending(domain) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES (?, 'pending')").run(normalizeHost(domain));
}
function remove(idOrDomain) {
  const db = getDb();
  if (typeof idOrDomain === 'number') return db.prepare('DELETE FROM domains WHERE id = ?').run(idOrDomain);
  return db.prepare('DELETE FROM domains WHERE domain = ?').run(normalizeHost(idOrDomain));
}

module.exports = {
  getServerPublicIp, getServerPublicIps, resolveHost, resolveCaa, canonIp,
  verify, add, seedPending, list, listVerified, baseDomains, isVerified, remove, row,
  _setResolverForTest, _setCaaResolverForTest, _setInterfacesForTest, _setServerIpsForTest, _isResolverInjected,
};
