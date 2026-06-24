// src/services/domainBoot.js
'use strict';
const { getDb } = require('../db/connection');
const domains = require('./domains');
const settings = require('./settings');
const { extractBaseDomains, shouldFlagServerIp } = require('./domainSeed');

async function runDomainSeedAndVerify({ verifyEach = domains.verify } = {}) {
  const routeDomains = getDb().prepare('SELECT DISTINCT domain FROM routes WHERE domain IS NOT NULL').all().map(r => r.domain);
  const bases = extractBaseDomains(routeDomains);
  for (const d of bases) domains.seedPending(d);

  // verify only rows still pending (idempotent across boots)
  const pending = getDb().prepare("SELECT domain FROM domains WHERE status='pending'").all().map(r => r.domain);
  const results = [];
  for (const d of pending) {
    const v = await verifyEach(d);
    results.push({ domain: d, matched: v.status === 'verified' });
    if (v.status === 'verified') {
      getDb().prepare("UPDATE domains SET status='verified', resolved_ip=?, last_error=NULL, verified_at=datetime('now'), last_checked_at=datetime('now') WHERE domain=?").run(v.resolvedIp || null, d);
    } else {
      // keep pending; do NOT redden on boot (per spec)
      getDb().prepare("UPDATE domains SET last_checked_at=datetime('now') WHERE domain=?").run(d);
    }
  }
  const flagged = shouldFlagServerIp(results);
  settings.set('domains.server_ip_warning', flagged ? '1' : '0');
  return { seeded: bases.length, verified: results.filter(r => r.matched).length, flagged };
}

module.exports = { runDomainSeedAndVerify };
