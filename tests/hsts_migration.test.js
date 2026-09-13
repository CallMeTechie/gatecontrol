'use strict';

// Migration v71 `hsts` (docs/feature-hsts.md): four hsts_* columns on routes
// with their defaults, hsts_default on domains (NULL = off).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let db;

before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
});

after(teardown);

test('v71 adds the hsts_* columns to routes and hsts_default to domains', () => {
  const routeCols = Object.fromEntries(db.prepare('PRAGMA table_info(routes)').all().map((c) => [c.name, c]));
  for (const [name, dflt] of [['hsts_enabled', '0'], ['hsts_max_age', '31536000'], ['hsts_subdomains', '0'], ['hsts_preload', '0']]) {
    assert.ok(routeCols[name], `routes.${name} missing`);
    assert.equal(routeCols[name].type.toUpperCase(), 'INTEGER');
    assert.equal(routeCols[name].notnull, 1, `routes.${name} must be NOT NULL`);
    assert.equal(String(routeCols[name].dflt_value), dflt, `routes.${name} default`);
  }
  const domainCols = Object.fromEntries(db.prepare('PRAGMA table_info(domains)').all().map((c) => [c.name, c]));
  assert.ok(domainCols.hsts_default, 'domains.hsts_default missing');
  assert.equal(domainCols.hsts_default.type.toUpperCase(), 'TEXT');
  assert.equal(domainCols.hsts_default.dflt_value, null);

  const applied = db.prepare('SELECT name FROM migration_history WHERE version = 71').get();
  assert.ok(applied, 'migration 71 recorded');
  assert.equal(applied.name, 'hsts');
});

test('a plain insert gets the HSTS defaults (off, 1 year, no flags)', () => {
  const id = db.prepare("INSERT INTO routes (domain, target_ip, target_port) VALUES ('mig.example.com', '10.0.0.1', 80)").run().lastInsertRowid;
  const row = db.prepare('SELECT hsts_enabled, hsts_max_age, hsts_subdomains, hsts_preload FROM routes WHERE id = ?').get(id);
  assert.deepEqual(row, { hsts_enabled: 0, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0 });
  const did = db.prepare("INSERT INTO domains (domain, status) VALUES ('mig.example.com', 'verified')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT hsts_default FROM domains WHERE id = ?').get(did).hsts_default, null);
});
