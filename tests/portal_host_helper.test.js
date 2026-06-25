'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let pc, settings, getDb;
beforeEach(async () => {
  await setup();
  pc = require('../src/services/portalConfig');
  settings = require('../src/services/settings');
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

test('effectivePortalHost: internal default when no base', () => {
  const r = pc.effectivePortalHost();
  assert.match(r.host, /^home\./);     // home.<gc.internal>
  assert.equal(r.public, false);
});

test('effectivePortalHost: prefix.base when base set; empty prefix -> apex', () => {
  settings.set('portal.base_domain', 'domaincaster.com');
  settings.set('portal.prefix', 'home');
  assert.deepEqual(pc.effectivePortalHost(), { host: 'home.domaincaster.com', public: true });
  settings.set('portal.prefix', '');
  assert.deepEqual(pc.effectivePortalHost(), { host: 'domaincaster.com', public: true });
});

test('validatePortalHost: empty base ok; unverified rejected; verified ok', () => {
  assert.equal(pc.validatePortalHost('', 'home').ok, true);
  assert.equal(pc.validatePortalHost('nope.com', 'home').ok, false);          // not in domains
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  assert.equal(pc.validatePortalHost('domaincaster.com', 'home').ok, true);
});

test('validatePortalHost: rejects collision with a route domain', () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  getDb().prepare("INSERT INTO routes (description, domain, target_ip, target_port, enabled, route_type) VALUES ('r','home.domaincaster.com','10.0.0.2','80',1,'http')").run();
  const r = pc.validatePortalHost('domaincaster.com', 'home');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'collision');
});

test('validatePortalHost: rejects collision with a peer FQDN', () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('gc.internal','verified')").run();
  getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, hostname) VALUES ('p','k','10.8.0.9/32',1,'regular','alice')").run();
  // peer FQDN = alice.<GC_DNS_DOMAIN=gc.internal>; choosing base=gc.internal + prefix=alice collides
  const r = pc.validatePortalHost('gc.internal', 'alice');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'collision');
});

test('validatePortalHost: rejects invalid prefix', () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  assert.equal(pc.validatePortalHost('domaincaster.com', 'bad_prefix!').ok, false);
});
