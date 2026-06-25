'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, getDb;
beforeEach(async () => { await setup(); agent = getAgent(); csrf = getCsrf(); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);

test('create with unverified public base → 400 field error', async () => {
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ domain: 'nas.domaincaster.com', target_ip: '1.1.1.1', target_port: 80, route_type: 'http' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields && res.body.fields.domain);
});

test('create with verified public base → 201', async () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ domain: 'nas.domaincaster.com', target_ip: '1.1.1.1', target_port: 80, route_type: 'http' });
  assert.equal(res.status, 201);
});

test('create with non-public TLD (carve-out) → 201 without verify', async () => {
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ domain: 'nas.gc.internal', target_ip: '1.1.1.1', target_port: 80, route_type: 'http' });
  assert.equal(res.status, 201);
});

test('update non-domain field on a legacy unverified-base route → ok (grandfathering)', async () => {
  // seed a legacy route directly (bypasses policy), unverified public base
  getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES ('legacy.example.com','10.0.0.3',80,'http',1)").run();
  const id = getDb().prepare("SELECT id FROM routes WHERE domain='legacy.example.com'").get().id;
  const res = await agent.put('/api/v1/routes/' + id).set('X-CSRF-Token', csrf).send({ target_port: 81 });
  assert.equal(res.status, 200);
});

test('update changing domain to unverified public base → 400', async () => {
  getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES ('a.gc.internal','10.0.0.3',80,'http',1)").run();
  const id = getDb().prepare("SELECT id FROM routes WHERE domain='a.gc.internal'").get().id;
  const res = await agent.put('/api/v1/routes/' + id).set('X-CSRF-Token', csrf).send({ domain: 'b.unverified.com' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.domain);
});

test('routes list flags public routes with unverified base', async () => {
  getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES ('x.unverified.com','10.0.0.4',80,'http',1)").run();
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('verified.com','verified')").run();
  getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES ('y.verified.com','10.0.0.5',80,'http',1)").run();
  getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES ('z.gc.internal','10.0.0.6',80,'http',1)").run();
  const res = await agent.get('/api/v1/routes').expect(200);
  const by = Object.fromEntries(res.body.routes.map(r => [r.domain, r]));
  assert.equal(by['x.unverified.com'].baseUnverified, true);
  assert.equal(by['y.verified.com'].baseUnverified, false);
  assert.equal(by['z.gc.internal'].baseUnverified, false);   // non-public → never flagged
  // domainIsPublic is a first-class flag (drives Task 6 edit-modal path detection):
  assert.equal(by['x.unverified.com'].domainIsPublic, true);
  assert.equal(by['y.verified.com'].domainIsPublic, true);
  assert.equal(by['z.gc.internal'].domainIsPublic, false);
});

test('create with CGNAT target_ip (100.64.0.0/10) is rejected by the SSRF guard', async () => {
  // internal-TLD domain → carve-out passes the domain policy, so the SSRF guard is reached.
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ domain: 'cgnat.gc.internal', target_ip: '100.64.0.1', target_port: 80, route_type: 'http' });
  assert.equal(res.status, 400);
});

test('create with a non-CGNAT 100.x target_ip (100.128.0.1) is allowed', async () => {
  // boundary: 100.128/9 is public space, must NOT be blocked by the 100.64/10 rule.
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ domain: 'pub100.gc.internal', target_ip: '100.128.0.1', target_port: 80, route_type: 'http' });
  assert.equal(res.status, 201);
});
