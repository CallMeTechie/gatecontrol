'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

beforeEach(async () => {
  await setup();
  const rid = getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('inv.example.com','10.0.0.12',80,1)").run().lastInsertRowid;
  getDb().prepare("INSERT INTO route_auth (route_id, auth_type) VALUES (?, 'share')").run(rid);
});
afterEach(teardown);

test('login page for a share route shows the invitation copy, no password form', async () => {
  const res = await getAgent().get('/route-auth/login?route=inv.example.com');
  assert.equal(res.status, 200);
  assert.match(res.text, /route_auth_share_invite|invitation|Einladung/i);
  assert.ok(!/name="password"/.test(res.text), 'no password field on a share route');
});
