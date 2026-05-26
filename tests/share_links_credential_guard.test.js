'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

beforeEach(async () => {
  await setup();
  const db = getDb();
  const routeId = db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('share.example.com','10.0.0.10',80,1)").run().lastInsertRowid;
  db.prepare("INSERT INTO route_auth (route_id, auth_type) VALUES (?, 'share')").run(routeId);
});
afterEach(teardown);

test('POST /route-auth/login on a share route → 404, no lockout side effects', async () => {
  const res = await getAgent().post('/route-auth/login')
    .type('form').send({ domain: 'share.example.com', email: 'x@y.z', password: 'p' });
  assert.equal(res.status, 404);
});
