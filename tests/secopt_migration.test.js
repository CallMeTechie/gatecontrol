'use strict';

// Migration v72 `security_options` (docs/feature-security-options.md):
// alias columns on service_bundles, backend TLS / body limit / mTLS columns on
// routes, tls_min_version on domains — all with their defaults.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let db;

before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
});

after(teardown);

const cols = (table) => Object.fromEntries(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => [c.name, c]));

test('v72 adds the columns with the contract defaults', () => {
  const routes = cols('routes');
  for (const [name, type, notnull, dflt] of [
    ['backend_tls_verify', 'INTEGER', 1, '0'],
    ['backend_tls_server_name', 'TEXT', 0, null],
    ['backend_tls_ca_pem', 'TEXT', 0, null],
    ['max_body_mb', 'INTEGER', 1, '0'],
    ['mtls_enabled', 'INTEGER', 1, '0'],
    ['mtls_ca_pem', 'TEXT', 0, null],
    ['mtls_mode', 'TEXT', 1, "'require'"],
  ]) {
    assert.ok(routes[name], `routes.${name} missing`);
    assert.equal(routes[name].type.toUpperCase(), type, `routes.${name} type`);
    assert.equal(routes[name].notnull, notnull, `routes.${name} notnull`);
    assert.equal(routes[name].dflt_value, dflt, `routes.${name} default`);
  }
  const bundles = cols('service_bundles');
  assert.equal(bundles.aliases.type.toUpperCase(), 'TEXT');
  assert.equal(bundles.aliases.dflt_value, null);
  assert.equal(bundles.alias_mode.type.toUpperCase(), 'TEXT');
  assert.equal(bundles.alias_mode.notnull, 1);
  assert.equal(bundles.alias_mode.dflt_value, "'redirect'");
  const domains = cols('domains');
  assert.equal(domains.tls_min_version.type.toUpperCase(), 'TEXT');
  assert.equal(domains.tls_min_version.notnull, 1);
  assert.equal(domains.tls_min_version.dflt_value, "'1.2'");

  const applied = db.prepare('SELECT name FROM migration_history WHERE version = 72').get();
  assert.ok(applied, 'migration 72 recorded');
  assert.equal(applied.name, 'security_options');
});

test('plain inserts get the defaults', () => {
  const rid = db.prepare("INSERT INTO routes (domain, target_ip, target_port) VALUES ('mig.example.com', '10.0.0.1', 80)").run().lastInsertRowid;
  assert.deepEqual(
    db.prepare('SELECT backend_tls_verify, backend_tls_server_name, backend_tls_ca_pem, max_body_mb, mtls_enabled, mtls_ca_pem, mtls_mode FROM routes WHERE id = ?').get(rid),
    { backend_tls_verify: 0, backend_tls_server_name: null, backend_tls_ca_pem: null, max_body_mb: 0, mtls_enabled: 0, mtls_ca_pem: null, mtls_mode: 'require' },
  );
  const did = db.prepare("INSERT INTO domains (domain, status) VALUES ('mig.example.com', 'verified')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT tls_min_version FROM domains WHERE id = ?').get(did).tls_min_version, '1.2');
  const bid = db.prepare("INSERT INTO service_bundles (name, domain) VALUES ('mig', 'mig.example.com')").run().lastInsertRowid;
  assert.deepEqual(db.prepare('SELECT aliases, alias_mode FROM service_bundles WHERE id = ?').get(bid), { aliases: null, alias_mode: 'redirect' });
});
