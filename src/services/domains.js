// src/services/domains.js
'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
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

// Injectable seam: resolve(host, family) -> Promise<string[]>. Default uses an
// EXPLICIT public resolver (never the ambient/dnsmasq resolver).
let _resolve = async (host, family) => {
  const servers = (settings.get('server.verify_resolver', '') || DEFAULT_RESOLVERS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
  const r = new dns.Resolver();
  r.setServers(servers);
  return withTimeout(family === 6 ? r.resolve6(host) : r.resolve4(host));
};
function _setResolverForTest(fn) { if (process.env.NODE_ENV === 'test') _resolve = fn; }

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

async function getServerPublicIp() {
  const override = (settings.get('server.public_ip', '') || '').trim();
  if (override) return { ip: override, family: net.isIPv6(override) ? 6 : 4, source: 'override' };
  const candidates = [config.wireguard.host, new URL(config.app.baseUrl).hostname]
    .map(h => normalizeHost(h)).filter(Boolean);
  for (const host of candidates) {
    if (isLoopbackHost(host) || host === '0.0.0.0') continue; // never 127.x/::1/localhost
    if (net.isIP(host)) return { ip: host, family: net.isIPv6(host) ? 6 : 4, source: 'literal' };
    try {
      const { v4, v6 } = await resolveHost(host);
      if (v4[0]) return { ip: v4[0], family: 4, source: 'wg_host' };
      if (v6[0]) return { ip: v6[0], family: 6, source: 'wg_host' };
    } catch { /* try next candidate */ }
  }
  return { ip: null, family: null, source: 'unknown' };
}

// Canonicalize an IP for comparison. Resolver output is already canonical, but a
// user-entered override / config literal may be non-canonical IPv6 (uppercase,
// leading zeros, '::' compression) — a plain string compare would then miss a
// correctly-pointing AAAA record. Falls back to lowercase for non-IP input.
function canonIp(ip) {
  try { return ipaddr.parse(String(ip)).toNormalizedString(); }
  catch { return String(ip || '').trim().toLowerCase(); }
}

async function verify(domain) {
  const host = normalizeHost(domain);
  const server = await getServerPublicIp();
  if (!server.ip) {
    return { status: 'pending', resolvedIp: null, expectedIp: null, error: 'server_ip_unknown' };
  }
  let resolved;
  try { resolved = await resolveHost(host); }
  catch { return { status: 'pending', resolvedIp: null, expectedIp: server.ip, error: 'resolver_unreachable' }; }
  const all = [...resolved.v4, ...resolved.v6];
  if (all.length === 0) {
    return { status: 'failed', resolvedIp: null, expectedIp: server.ip, error: 'no A/AAAA records' };
  }
  const wanted = canonIp(server.ip);
  if (all.some(a => canonIp(a) === wanted)) {
    return { status: 'verified', resolvedIp: server.ip, expectedIp: server.ip, error: null };
  }
  return { status: 'failed', resolvedIp: all[0], expectedIp: server.ip,
    error: `DNS verweist auf ${all[0]}, erwartet ${server.ip}` };
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
  return db.prepare(`INSERT INTO domains (domain, status, resolved_ip, last_error, verified_at, last_checked_at)
    VALUES (@domain, @status, @resolved_ip, @last_error, @verified_at, datetime('now'))
    ON CONFLICT(domain) DO UPDATE SET status=excluded.status, resolved_ip=excluded.resolved_ip,
      last_error=excluded.last_error, verified_at=excluded.verified_at, last_checked_at=excluded.last_checked_at
    RETURNING *`)
    .get({
      domain: normalizeHost(domain), status: v.status, resolved_ip: v.resolvedIp || null,
      last_error: v.error || null, verified_at: v.status === 'verified' ? new Date().toISOString() : null,
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
  getServerPublicIp, verify, add, seedPending, list, listVerified, baseDomains, isVerified, remove, row,
  _setResolverForTest,
};
