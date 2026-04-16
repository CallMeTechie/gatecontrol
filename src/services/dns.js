'use strict';

const { execFile } = require('node:child_process');
const { getDb } = require('../db/connection');
const { atomicWrite } = require('../utils/fs');
const config = require('../../config/default');
const logger = require('../utils/logger');

// ────────────────────────────────────────────────────────────
// Reserved / forbidden hostname labels
// ────────────────────────────────────────────────────────────
// These would either collide with static dnsmasq host-records generated
// in entrypoint.sh, impersonate infrastructure, or name well-known
// shadowing targets. Kept lowercase; all comparisons are case-insensitive.
const RESERVED_HOSTNAMES = new Set([
  'localhost', 'local', 'host', 'broadcasthost',
  'gateway', 'server', 'gc-server',
  'admin', 'root', 'router',
  // Reserved for future expansion
  'dns', 'vpn', 'api', 'auth', 'mail', 'ns', 'ns1', 'ns2',
]);

// RFC 1123 DNS label: 1-63 chars, starts with alphanumeric, contains
// alphanumeric or hyphen, doesn't end with hyphen. Deliberately narrower
// than the RFC allows: no uppercase (we normalize), no IDN/punycode yet
// (IDN normalization would add a second layer of complexity around
// homograph attacks — defer until there's real demand).
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────

/**
 * Normalize a caller-supplied hostname into DNS-canonical form.
 * Throws if the input is unusable (empty after normalization, too long,
 * contains structural violations). Does NOT enforce reserved-name rules
 * or uniqueness — those are policy checks, handled separately.
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeHostname(input) {
  if (typeof input !== 'string') {
    throw new Error('hostname must be a string');
  }
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('hostname must not be empty');
  }
  if (trimmed.length > 63) {
    throw new Error('hostname exceeds 63 characters');
  }
  return trimmed;
}

/**
 * Strict assertion that a hostname is safe to write into the hosts file.
 * Called BOTH at the API boundary AND at the renderer as a second line
 * of defence — if a bug in the API validator ever slips a malformed
 * value into the DB, we refuse to render it rather than injecting
 * arbitrary lines into the dnsmasq config.
 *
 * @param {string} hostname Pre-normalized (lowercase, trimmed)
 * @throws {Error} when the hostname is unsafe
 */
function strictHostnameAssert(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw new Error('hostname empty');
  }
  if (hostname.length > 63) {
    throw new Error('hostname too long');
  }
  if (!HOSTNAME_RE.test(hostname)) {
    throw new Error(`hostname has invalid characters: ${JSON.stringify(hostname)}`);
  }
  if (RESERVED_HOSTNAMES.has(hostname)) {
    throw new Error(`hostname is reserved: ${hostname}`);
  }
  // Control chars, whitespace, #, null — already ruled out by regex, but
  // assert explicitly so a future regex relaxation can't silently open
  // an injection path.
  for (let i = 0; i < hostname.length; i++) {
    const code = hostname.charCodeAt(i);
    if (code < 0x21 || code === 0x23 /* # */ || code > 0x7e) {
      throw new Error(`hostname contains disallowed byte 0x${code.toString(16)}`);
    }
  }
}

// ────────────────────────────────────────────────────────────
// Dedup
// ────────────────────────────────────────────────────────────

/**
 * Reserve a unique hostname for a peer, appending -2, -3, … if the
 * candidate collides with another peer's hostname. Wraps the check and
 * the caller's UPDATE in a single IMMEDIATE transaction so concurrent
 * reporters can't both take the same suffix.
 *
 * The updateFn receives the assigned hostname and MUST write it to the
 * peer row before the transaction commits.
 *
 * @param {string} candidate Pre-normalized candidate hostname
 * @param {number} peerId    Owner peer id (excluded from uniqueness check)
 * @param {(assigned:string) => void} updateFn Runs inside the transaction
 * @returns {string} The final assigned hostname (may differ from candidate)
 */
function reserveUniqueHostname(candidate, peerId, updateFn) {
  strictHostnameAssert(candidate);

  const db = getDb();
  const findClash = db.prepare(
    'SELECT id FROM peers WHERE hostname = ? COLLATE NOCASE AND id != ?'
  );

  const tx = db.transaction(() => {
    let attempt = candidate;
    // Preserve label length: -N suffix may push us over 63 chars.
    for (let n = 1; n < 100; n++) {
      if (n > 1) {
        const suffix = `-${n}`;
        const room = 63 - suffix.length;
        attempt = candidate.slice(0, room).replace(/-+$/, '') + suffix;
        // Final sanity: suffix could have produced invalid leading or
        // trailing char after truncation — revalidate.
        try { strictHostnameAssert(attempt); } catch { continue; }
      }
      const clash = findClash.get(attempt, peerId);
      if (!clash) {
        updateFn(attempt);
        return attempt;
      }
    }
    throw new Error(`could not find free hostname suffix for ${candidate}`);
  });

  return tx.immediate ? tx.immediate() : tx();
}

// ────────────────────────────────────────────────────────────
// Hosts-file rendering
// ────────────────────────────────────────────────────────────

/**
 * Extract the first /32 IPv4 address from a peer's allowed_ips field.
 * Peers have e.g. "10.8.0.5/32" — we strip the prefix for dnsmasq.
 */
function extractPeerIp(allowedIps) {
  if (!allowedIps) return null;
  const first = String(allowedIps).split(',')[0].trim();
  const ipPart = first.split('/')[0];
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ipPart)) return null;
  return ipPart;
}

/**
 * Render the peer hosts file content from current DB state. Returns the
 * full file body (trailing newline). Skips peers with no hostname, no
 * valid IP, or hostname that fails strict assertion. Skipped peers are
 * logged at debug level — they simply don't resolve until fixed.
 */
function renderHostsContent() {
  const db = getDb();
  const domain = config.dns.domain;

  const peers = db.prepare(`
    SELECT id, hostname, allowed_ips
    FROM peers
    WHERE hostname IS NOT NULL AND hostname != ''
    ORDER BY hostname
  `).all();

  const lines = [
    '# Auto-generated by GateControl services/dns.js — do not edit.',
    '# Regenerated on every peer mutation and reloaded into dnsmasq via SIGHUP.',
  ];

  for (const peer of peers) {
    const ip = extractPeerIp(peer.allowed_ips);
    if (!ip) {
      logger.debug({ peerId: peer.id, allowedIps: peer.allowed_ips }, 'DNS skip: peer has no valid IPv4');
      continue;
    }
    let hostname;
    try {
      hostname = peer.hostname.toLowerCase();
      strictHostnameAssert(hostname);
    } catch (err) {
      logger.warn({ peerId: peer.id, hostname: peer.hostname, err: err.message }, 'DNS skip: hostname failed strict validation');
      continue;
    }
    // Format: <ip> <fqdn> <short>
    // dnsmasq serves both names. FQDN first makes reverse-PTR pick it up.
    lines.push(`${ip}\t${hostname}.${domain}\t${hostname}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Rewrite the hosts file atomically and reload dnsmasq. Returns the
 * number of peer entries written.
 */
function rebuildNow() {
  if (!config.dns.enabled) {
    logger.debug('DNS disabled — skipping rebuild');
    return 0;
  }

  const content = renderHostsContent();
  try {
    atomicWrite(config.dns.hostsFile, content, { mode: 0o644 });
  } catch (err) {
    logger.error({ err: err.message, path: config.dns.hostsFile }, 'DNS: hosts-file write failed');
    throw err;
  }

  const entries = content.split('\n').filter((l) => l && !l.startsWith('#')).length;
  logger.info({ entries, path: config.dns.hostsFile }, 'DNS hosts-file rebuilt');

  // SIGHUP dnsmasq — pkill tolerates the process not running (exit 1),
  // we log that as a warning rather than propagating because a missing
  // dnsmasq during tests or cold-start is not a Node-process error.
  execFile('pkill', ['-HUP', 'dnsmasq'], { timeout: 5000 }, (err) => {
    if (err && err.code !== 1) {
      logger.warn({ err: err.message }, 'DNS: pkill -HUP dnsmasq failed');
    }
  });

  return entries;
}

// ────────────────────────────────────────────────────────────
// Debounced rebuild
// ────────────────────────────────────────────────────────────

let _debounceTimer = null;
let _pendingPromise = null;
let _pendingResolve = null;

/**
 * Schedule a rebuild. Multiple calls within the debounce window coalesce
 * into a single trailing-edge rebuild. Returns a promise that resolves
 * after the pending rebuild completes (or rejects with the rebuild
 * error). Useful for tests and any caller that needs to await the flush.
 */
function scheduleRebuild() {
  if (!_pendingPromise) {
    _pendingPromise = new Promise((resolve) => { _pendingResolve = resolve; });
  }

  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    const resolve = _pendingResolve;
    _pendingPromise = null;
    _pendingResolve = null;
    try {
      const entries = rebuildNow();
      resolve({ ok: true, entries });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  }, config.dns.rebuildDebounceMs);

  return _pendingPromise;
}

/**
 * Force-flush any pending rebuild immediately. Returns the final entry
 * count. Primarily for tests — production code should rely on debouncing.
 */
async function flushPendingRebuild() {
  if (!_debounceTimer) return null;
  clearTimeout(_debounceTimer);
  _debounceTimer = null;
  const resolve = _pendingResolve;
  _pendingPromise = null;
  _pendingResolve = null;
  try {
    const entries = rebuildNow();
    resolve({ ok: true, entries });
    return { ok: true, entries };
  } catch (err) {
    resolve({ ok: false, error: err.message });
    return { ok: false, error: err.message };
  }
}

// ────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────

/**
 * Status snapshot for the admin UI / /api/admin/dns/status endpoint.
 */
function getStatus() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN hostname IS NOT NULL AND hostname != '' THEN 1 ELSE 0 END) AS with_hostname,
      SUM(CASE WHEN hostname_source = 'admin' THEN 1 ELSE 0 END) AS admin_source,
      SUM(CASE WHEN hostname_source = 'agent' THEN 1 ELSE 0 END) AS agent_source,
      SUM(CASE WHEN hostname_source = 'stale' THEN 1 ELSE 0 END) AS stale_source
    FROM peers
  `).get();

  const fs = require('node:fs');
  let hostsFile = null;
  try {
    const stat = fs.statSync(config.dns.hostsFile);
    hostsFile = { path: config.dns.hostsFile, mtime: stat.mtime.toISOString(), size: stat.size };
  } catch { /* file may not exist yet */ }

  return {
    enabled: config.dns.enabled,
    domain: config.dns.domain,
    peers: {
      total: row.total || 0,
      with_hostname: row.with_hostname || 0,
      admin_source: row.admin_source || 0,
      agent_source: row.agent_source || 0,
      stale_source: row.stale_source || 0,
    },
    hostsFile,
  };
}

module.exports = {
  normalizeHostname,
  strictHostnameAssert,
  reserveUniqueHostname,
  renderHostsContent,
  rebuildNow,
  scheduleRebuild,
  flushPendingRebuild,
  getStatus,
  RESERVED_HOSTNAMES,
};
