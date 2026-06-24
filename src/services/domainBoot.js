// src/services/domainBoot.js
'use strict';
const { getDb } = require('../db/connection');
const domains = require('./domains');
const settings = require('./settings');
const { extractBaseDomains, shouldFlagServerIp } = require('./domainSeed');

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
  const results = [];
  for (const d of domainNames) {
    const v = await verifyEach(d);
    results.push({ domain: d, matched: v.status === 'verified' });
    if (v.status === 'verified') {
      getDb().prepare("UPDATE domains SET status='verified', resolved_ip=?, last_error=NULL, verified_at=datetime('now'), last_checked_at=datetime('now') WHERE domain=?").run(v.resolvedIp || null, d);
    } else {
      // keep/reset to pending; do NOT write 'failed' on this path
      getDb().prepare("UPDATE domains SET status='pending', last_checked_at=datetime('now') WHERE domain=?").run(d);
    }
  }
  const flagged = shouldFlagServerIp(results);
  settings.set('domains.server_ip_warning', flagged ? '1' : '0');
  return { verified: results.filter(r => r.matched).length, flagged };
}

async function runDomainSeedAndVerify({ verifyEach = domains.verify } = {}) {
  const routeDomains = getDb().prepare('SELECT DISTINCT domain FROM routes WHERE domain IS NOT NULL').all().map(r => r.domain);
  const bases = extractBaseDomains(routeDomains);
  for (const d of bases) domains.seedPending(d);

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
