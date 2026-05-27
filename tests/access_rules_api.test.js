'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, getDb;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

// Insert a route with valid NOT-NULL columns (target_ip, target_port) and
// return its id.
function seedRoute() {
  const db = getDb();
  const info = db.prepare(
    "INSERT INTO routes (domain, route_type, target_ip, target_port) VALUES ('r.test', 'http', '10.0.0.5', 8080)"
  ).run();
  return Number(info.lastInsertRowid);
}

// Insert a peer with valid NOT-NULL columns (name, public_key, allowed_ips).
function seedPeer() {
  const db = getDb();
  const info = db.prepare(
    "INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('p1', 'PUBKEY_P1=', '10.8.0.5/32', 1)"
  ).run();
  return Number(info.lastInsertRowid);
}

test('POST create happy path -> rule persisted', async () => {
  const id = seedRoute();
  const res = await agent.post(`/api/v1/routes/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'allow', schedule: 'Mo-Fr 09:00-17:00', label: 'office hours' });
  assert.ok(res.status === 201 || res.status === 200, `unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.id, 'response should contain the new rule id');

  const row = getDb().prepare('SELECT * FROM access_rules WHERE id=?').get(res.body.id);
  assert.ok(row, 'rule should be persisted');
  assert.equal(row.target_type, 'route');
  assert.equal(row.target_id, id);
  assert.equal(row.mode, 'allow');
  assert.equal(row.schedule, 'Mo-Fr 09:00-17:00');
  assert.equal(row.label, 'office hours');
});

test('GET returns { rules, state, rule }', async () => {
  const id = seedRoute();
  await agent.post(`/api/v1/routes/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'allow', schedule: 'Mo-Fr 09:00-17:00' });

  const res = await agent.get(`/api/v1/routes/${id}/access-rules`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.rules), 'rules should be an array');
  assert.equal(res.body.rules.length, 1);
  assert.ok(['allowed', 'denied'].includes(res.body.state), `state should be allowed/denied, got ${res.body.state}`);
  // rule is either the matched/active rule object or null
  assert.ok('rule' in res.body, 'response should contain a rule field');
});

test('GET works for a peer target too', async () => {
  const id = seedPeer();
  await agent.post(`/api/v1/peers/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'block', schedule: 'Sa 00:00-23:00' });
  const res = await agent.get(`/api/v1/peers/${id}/access-rules`);
  assert.equal(res.status, 200);
  assert.equal(res.body.rules.length, 1);
  assert.equal(res.body.rules[0].target_type, 'peer');
});

test('PUT edits an existing rule', async () => {
  const id = seedRoute();
  const create = await agent.post(`/api/v1/routes/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'allow', schedule: 'Mo-Fr 09:00-17:00' });
  const ruleId = create.body.id;

  const res = await agent.put(`/api/v1/routes/${id}/access-rules/${ruleId}`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'block', schedule: 'Sa 10:00-12:00', label: 'changed' });
  assert.ok(res.status === 200 || res.status === 201, `unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);

  const row = getDb().prepare('SELECT * FROM access_rules WHERE id=?').get(ruleId);
  assert.equal(row.mode, 'block');
  assert.equal(row.schedule, 'Sa 10:00-12:00');
  assert.equal(row.label, 'changed');
});

test('DELETE removes a rule', async () => {
  const id = seedRoute();
  const create = await agent.post(`/api/v1/routes/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'allow', schedule: 'Mo-Fr 09:00-17:00' });
  const ruleId = create.body.id;

  const res = await agent.delete(`/api/v1/routes/${id}/access-rules/${ruleId}`)
    .set('X-CSRF-Token', csrf);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const row = getDb().prepare('SELECT * FROM access_rules WHERE id=?').get(ruleId);
  assert.equal(row, undefined, 'rule should be gone');
});

test('400 on bad mode', async () => {
  const id = seedRoute();
  const res = await agent.post(`/api/v1/routes/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'maybe', schedule: 'Mo-Fr 09:00-17:00' });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('400 on unparseable schedule', async () => {
  const id = seedRoute();
  const res = await agent.post(`/api/v1/routes/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'allow', schedule: 'Montag 9-17' });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /schedule/i);
});

test('400 on valid_from > valid_until', async () => {
  const id = seedRoute();
  const res = await agent.post(`/api/v1/routes/${id}/access-rules`)
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'allow', schedule: 'Mo-Fr 09:00-17:00', valid_from: '2026-12-31', valid_until: '2026-01-01' });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('403 without the access_windows flag', async () => {
  const id = seedRoute();
  const license = require('../src/services/license');
  license._overrideForTest({ access_windows: false });
  try {
    const res = await agent.post(`/api/v1/routes/${id}/access-rules`)
      .set('X-CSRF-Token', csrf)
      .send({ mode: 'allow', schedule: 'Mo-Fr 09:00-17:00' });
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
  } finally {
    license._overrideForTest({ access_windows: true });
  }
});

test('404 for unknown target id', async () => {
  const res = await agent.post('/api/v1/routes/999999/access-rules')
    .set('X-CSRF-Token', csrf)
    .send({ mode: 'allow', schedule: 'Mo-Fr 09:00-17:00' });
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
});

test('404 on GET for unknown target id', async () => {
  const res = await agent.get('/api/v1/peers/999999/access-rules');
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
});
