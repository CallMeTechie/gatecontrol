// src/services/domainBoot.js
'use strict';
const { getDb } = require('../db/connection');
const domains = require('./domains');
const settings = require('./settings');
const { extractBaseDomains, shouldFlagServerIp, normalizeHost } = require('./domainSeed');
const { isPublicDomain } = require('./caddyTlsAutomation');

/**
 * Verify a set of domain names against the server IP, persist results, and
 * recompute the instance-level server-IP warning flag.
 *
 * Non-alarming path: rows that do NOT resolve correctly stay/return to
 * status='pending' (never written as 'failed' here — per-domain 'failed' is
 * produced only by the explicit per-row Re-check which calls domains.add()).
 *
 * Returns { verified, flagged }.
 */
async function verifyAndReflag(domainNames, { verifyEach = domains.verify } = {}) {
  // Verifications are independent (each does its own DNS lookup) → run concurrently,
  // then persist. Statements are prepared once, not per row.
  const verifications = await Promise.all(
    domainNames.map(async (d) => ({ domain: d, v: await verifyEach(d) }))
  );
  const db = getDb();
  const verifiedStmt = db.prepare("UPDATE domains SET status='verified', resolved_ip=?, last_error=NULL, verified_at=datetime('now'), last_checked_at=datetime('now') WHERE domain=?");
  const pendingStmt = db.prepare("UPDATE domains SET status='pending', last_checked_at=datetime('now') WHERE domain=?");
  const results = [];
  for (const { domain: d, v } of verifications) {
    results.push({ domain: d, matched: v.status === 'verified' });
    if (v.status === 'verified') {
      verifiedStmt.run(v.resolvedIp || null, d);
    } else {
      // keep/reset to pending; do NOT write 'failed' on this path
      pendingStmt.run(d);
    }
  }
  const flagged = shouldFlagServerIp(results);
  settings.set('domains.server_ip_warning', flagged ? '1' : '0');
  return { verified: results.filter(r => r.matched).length, flagged };
}

async function runDomainSeedAndVerify({ verifyEach = domains.verify } = {}) {
  const routeDomains = getDb().prepare('SELECT DISTINCT domain FROM routes WHERE domain IS NOT NULL').all().map(r => r.domain);
  // Only public-TLD bases can ever be verified against public DNS. Non-public
  // bases (.internal/.lan/...) would otherwise linger forever as 'pending'
  // noise on the Domains page, so they are never seeded.
  const bases = extractBaseDomains(routeDomains).filter(isPublicDomain);
  const seedStmt = getDb().prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES (?, 'pending')");
  for (const d of bases) seedStmt.run(normalizeHost(d));

  // One-time cleanup: drop non-public bases that earlier boots auto-seeded as
  // 'pending' (they can never verify; routes consume routes.domain directly and
  // nothing references the domains table by FK). Verified rows are never touched.
  const lingering = getDb().prepare("SELECT domain FROM domains WHERE status='pending'").all().map(r => r.domain);
  const delStmt = getDb().prepare('DELETE FROM domains WHERE domain=?');
  for (const d of lingering) {
    if (!isPublicDomain(d)) delStmt.run(d);
  }

  // verify only rows still pending (idempotent across boots)
  const pending = getDb().prepare("SELECT domain FROM domains WHERE status='pending'").all().map(r => r.domain);
  const { verified, flagged } = await verifyAndReflag(pending, { verifyEach });
  return { seeded: bases.length, verified, flagged };
}

/**
 * Re-verify ALL domain rows (regardless of current status) against the
 * current server IP and recompute the server-IP warning flag.
 * Used after the admin saves a corrected server-IP override so the warning
 * is refreshed immediately without a process restart.
 * Non-alarming: non-verified rows return to status='pending', never 'failed'.
 * Returns { verified, flagged }.
 */
async function reverifyAllAndReflag({ verifyEach = domains.verify } = {}) {
  const all = getDb().prepare('SELECT domain FROM domains').all().map(r => r.domain);
  return verifyAndReflag(all, { verifyEach });
}

module.exports = { runDomainSeedAndVerify, reverifyAllAndReflag, verifyAndReflag };
