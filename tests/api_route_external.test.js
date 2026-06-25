'use strict';

/**
 * API-level tests: external_enabled is accepted and persisted by the
 * POST /api/v1/routes (create) and PUT /api/v1/routes/:id (update) handlers.
 *
 * These tests go through the real HTTP API using the shared test harness
 * (tests/helpers/setup.js), which provides an authenticated supertest agent
 * and handles DB setup/teardown per test.
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
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('example.com','verified')").run();
});

afterEach(teardown);

// Minimal valid HTTP route body (no WireGuard peer needed — target_ip is a
// routable public address so the SSRF guard does not trip).
const MINIMAL_ROUTE = {
  domain: 'ext-api-test.example.com',
  target_ip: '93.184.216.34', // example.com — public, non-private
  target_port: 80,
};

test('POST /api/v1/routes without external_enabled → 201, stored as 0 (internal-only default)', async () => {
  const res = await agent
    .post('/api/v1/routes')
    .set('X-CSRF-Token', csrf)
    .send(MINIMAL_ROUTE);

  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);

  const routeId = res.body.route.id;
  assert.ok(routeId, 'response must include route.id');

  // Read back via GET to confirm persistence
  const getRes = await agent.get(`/api/v1/routes/${routeId}`);
  assert.equal(getRes.status, 200);
  assert.equal(
    getRes.body.route.external_enabled,
    0,
    'omitting external_enabled on create must default to 0 (internal-only)',
  );
});

test('POST /api/v1/routes with external_enabled: true → 201, stored as 1', async () => {
  const res = await agent
    .post('/api/v1/routes')
    .set('X-CSRF-Token', csrf)
    .send({ ...MINIMAL_ROUTE, domain: 'ext-api-on.example.com', external_enabled: true });

  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);

  const routeId = res.body.route.id;
  const getRes = await agent.get(`/api/v1/routes/${routeId}`);
  assert.equal(getRes.status, 200);
  assert.equal(
    getRes.body.route.external_enabled,
    1,
    'external_enabled: true on create must persist as 1',
  );
});

test('PUT /api/v1/routes/:id with external_enabled: true → stored as 1', async () => {
  // First create a route without external_enabled (default 0)
  const createRes = await agent
    .post('/api/v1/routes')
    .set('X-CSRF-Token', csrf)
    .send({ ...MINIMAL_ROUTE, domain: 'ext-api-update.example.com' });

  assert.equal(createRes.status, 201);
  const routeId = createRes.body.route.id;

  // Confirm it's internal-only
  const before = await agent.get(`/api/v1/routes/${routeId}`);
  assert.equal(before.body.route.external_enabled, 0, 'precondition: starts as internal-only');

  // Now update with external_enabled: true
  const updateRes = await agent
    .put(`/api/v1/routes/${routeId}`)
    .set('X-CSRF-Token', csrf)
    .send({ external_enabled: true });

  assert.equal(
    updateRes.status,
    200,
    `Expected 200, got ${updateRes.status}: ${JSON.stringify(updateRes.body)}`,
  );
  assert.equal(updateRes.body.ok, true);

  // Read back to confirm
  const after = await agent.get(`/api/v1/routes/${routeId}`);
  assert.equal(after.status, 200);
  assert.equal(
    after.body.route.external_enabled,
    1,
    'PUT with external_enabled: true must toggle to 1',
  );
});
