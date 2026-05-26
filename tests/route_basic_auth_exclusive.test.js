'use strict';

/**
 * T1 — Server mutual exclusivity: enabling Basic Auth via PUT /:id removes any
 * existing route_auth row (symmetric to createOrUpdateAuth, which already clears
 * basic_auth_enabled when route-auth is set).
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let agent, csrf;

beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
});
afterEach(teardown);

test('PUT /:id with basic_auth_enabled=true removes an existing route_auth row', async () => {
  const db = getDb();

  // Create a route directly in DB (target_ip + target_port are NOT NULL)
  const routeId = db.prepare(
    "INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('exclusive.example.com', '1.2.3.4', 80, 1)"
  ).run().lastInsertRowid;

  // Insert a route_auth row for that route
  db.prepare(
    "INSERT INTO route_auth (route_id, auth_type, email) VALUES (?, 'email_password', 'x@y.z')"
  ).run(routeId);

  // Confirm the row exists before the PUT
  const before = db.prepare('SELECT COUNT(*) AS c FROM route_auth WHERE route_id = ?').get(routeId);
  assert.equal(before.c, 1, 'route_auth row should exist before PUT');

  // PUT with basic_auth_enabled: true — include all required fields so the update validates
  const res = await agent
    .put(`/api/v1/routes/${routeId}`)
    .set('X-CSRF-Token', csrf)
    .send({
      domain: 'exclusive.example.com',
      target_ip: '1.2.3.4',
      target_port: 80,
      basic_auth_enabled: true,
      basic_auth_user: 'admin',
      basic_auth_password: 'StrongPass123!',
    });

  assert.equal(res.status, 200, `Expected 200 but got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.route.basic_auth_enabled, 1, 'basic_auth_enabled should be 1 after PUT');

  // The route_auth row must be gone
  const after = db.prepare('SELECT COUNT(*) AS c FROM route_auth WHERE route_id = ?').get(routeId);
  assert.equal(after.c, 0, 'route_auth row should be removed when basic auth is enabled');
});

test('PUT /:id with basic_auth_enabled=false does NOT remove route_auth row', async () => {
  const db = getDb();

  const routeId = db.prepare(
    "INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('noremove.example.com', '1.2.3.4', 81, 1)"
  ).run().lastInsertRowid;

  db.prepare(
    "INSERT INTO route_auth (route_id, auth_type, email) VALUES (?, 'email_password', 'a@b.c')"
  ).run(routeId);

  const res = await agent
    .put(`/api/v1/routes/${routeId}`)
    .set('X-CSRF-Token', csrf)
    .send({
      domain: 'noremove.example.com',
      target_ip: '1.2.3.4',
      target_port: 81,
      basic_auth_enabled: false,
    });

  assert.equal(res.status, 200, `Expected 200 but got ${res.status}: ${JSON.stringify(res.body)}`);

  // route_auth row must still be present
  const after = db.prepare('SELECT COUNT(*) AS c FROM route_auth WHERE route_id = ?').get(routeId);
  assert.equal(after.c, 1, 'route_auth row should NOT be removed when basic auth is disabled');
});
