'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let agent, csrf, routeId;
beforeEach(async () => {
  await setup();
  agent = getAgent(); csrf = getCsrf();
  routeId = getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('api.example.com','10.0.0.11',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('create on a public route needs confirmGate, then returns the URL once', async () => {
  let res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, oneTime: false });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'needs_gate_confirm');

  res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, oneTime: false, confirmGate: true });
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^https:\/\/api\.example\.com\/route-auth\/share\/.+/);
  // route is now share-gated
  assert.equal(getDb().prepare("SELECT auth_type FROM route_auth WHERE route_id = ?").get(routeId).auth_type, 'share');
});

test('list never leaks the token; revoke works', async () => {
  await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, oneTime: false, confirmGate: true });
  let res = await agent.get(`/api/v1/routes/${routeId}/share-links`);
  assert.equal(res.status, 200);
  assert.equal(res.body.links.length, 1);
  assert.ok(!('token' in res.body.links[0]) && !('token_hash' in res.body.links[0]));
  const linkId = res.body.links[0].id;
  res = await agent.delete(`/api/v1/routes/${routeId}/share-links/${linkId}`).set('X-CSRF-Token', csrf);
  assert.equal(res.status, 200);
  assert.equal((await agent.get(`/api/v1/routes/${routeId}/share-links`)).body.links.length, 0);
});

test('403 without share_links feature', async () => {
  require('../src/services/license')._overrideForTest({ share_links: false });
  const res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, confirmGate: true });
  assert.equal(res.status, 403);
  require('../src/services/license')._overrideForTest({ share_links: true }); // reset
});

test('409 on a basic-auth route', async () => {
  getDb().prepare('UPDATE routes SET basic_auth_enabled = 1 WHERE id = ?').run(routeId);
  const res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, confirmGate: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'disable_basic_auth');
});
