'use strict';
// Regression: the management UI host (GC_BASE_URL) is added to caddyRoutes AFTER
// buildTlsAutomation ran, so with an empty routes table it was absent from the TLS
// policy entirely and fell through to Caddy's DEFAULT automation — an ACME account
// with NO contact email, even with GC_CADDY_EMAIL configured.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_CADDY_EMAIL = 'admin@example.com';   // TLS policies only emit when email set
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const GC_HOST = 'gc.example.com';
let buildCaddyConfig;
beforeEach(async () => {
  await setup();
  // helpers/setup pins GC_BASE_URL to localhost — whose TLD is private, so it would
  // never reach the ACME branch. Re-point it and drop the two modules that captured
  // it at require-time (their own dependencies stay cached).
  process.env.GC_BASE_URL = `https://${GC_HOST}`;
  delete require.cache[require.resolve('../config/default')];
  delete require.cache[require.resolve('../src/services/caddyConfig')];
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});
afterEach(teardown);

const policies = (cfg) => ((cfg.apps.tls || {}).automation || {}).policies || [];

test('management host gets an explicit ACME policy carrying the account email', async () => {
  const cfg = await buildCaddyConfig();
  const mgmt = policies(cfg)
    .filter(p => (p.issuers || []).some(i => i.module === 'acme'))
    .find(p => (p.subjects || []).includes(GC_HOST));
  assert.ok(mgmt, `${GC_HOST} must have an explicit ACME policy, not fall through to the default`);
  assert.equal(mgmt.issuers.find(i => i.module === 'acme').email, 'admin@example.com');
});

test('management host appears exactly once even when a route already serves it', async () => {
  require('../src/db/connection').getDb()
    .prepare("INSERT INTO routes (description, domain, target_ip, target_port, enabled, route_type) VALUES ('r',?,'10.0.0.2','80',1,'http')")
    .run(GC_HOST);
  const cfg = await buildCaddyConfig();
  const hits = policies(cfg).flatMap(p => p.subjects || []).filter(s => s === GC_HOST);
  assert.equal(hits.length, 1, 'no duplicate subject when the host is both a route and the management host');
});
