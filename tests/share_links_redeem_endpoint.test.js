'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  routeId = getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('s.example.com','10.0.0.9',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('valid token → 302 to / + host-only gc.route.sid cookie + Referrer-Policy', async () => {
  const svc = require('../src/services/shareLinks');
  const { token } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  const res = await getAgent().get(`/route-auth/share/${token}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  const setCookie = (res.headers['set-cookie'] || []).join(';');
  assert.match(setCookie, /gc\.route\.sid=/);
  assert.match(setCookie, /Path=\//);
  assert.ok(!/Domain=/i.test(setCookie), 'cookie must be host-only (no Domain)');
});

test('invalid token → 200 generic page, no session', async () => {
  const res = await getAgent().get('/route-auth/share/deadbeef');
  assert.equal(res.status, 200);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM route_auth_sessions').get().c, 0);
});
