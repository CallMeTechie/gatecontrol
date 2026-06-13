'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const license = require('../src/services/license');
const pihole = require('../src/services/pihole');
let agent, csrf;
beforeEach(async () => { await setup(); agent = getAgent(); csrf = getCsrf(); });
afterEach(teardown);

test('summary 403 without license, 200 with', async () => {
  // pihole_integration is NOT enabled by setup() — verify 403
  let res = await agent.get('/api/v1/pihole/summary');
  assert.equal(res.status, 403);
  // enable feature via _overrideForTest (the real mechanism used across the test suite)
  license._overrideForTest({ pihole_integration: true });
  try {
    res = await agent.get('/api/v1/pihole/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok('data' in res.body);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('history 403 without license, 200 with', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.get('/api/v1/pihole/history');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('top-domains 200 with license', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.get('/api/v1/pihole/top-domains');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('top-clients 200 with license', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.get('/api/v1/pihole/top-clients');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('query-types 200 with license', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.get('/api/v1/pihole/query-types');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('health 200 with license', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.get('/api/v1/pihole/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok('data' in res.body);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('POST blocking persists desired-state', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.post('/api/v1/pihole/blocking').set('X-CSRF-Token', csrf).send({ enabled: false, timer: 300 });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(pihole.getDesired().enabled, false);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('POST blocking 400 if enabled not boolean', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.post('/api/v1/pihole/blocking').set('X-CSRF-Token', csrf).send({ enabled: 'yes' });
    assert.equal(res.status, 400);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('POST blocking 403 without license', async () => {
  const res = await agent.post('/api/v1/pihole/blocking').set('X-CSRF-Token', csrf).send({ enabled: true });
  assert.equal(res.status, 403);
});

test('POST blocking with negative timer still returns ok (treated as no timer)', async () => {
  license._overrideForTest({ pihole_integration: true });
  try {
    const res = await agent.post('/api/v1/pihole/blocking').set('X-CSRF-Token', csrf).send({ enabled: true, timer: -5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  } finally {
    license._overrideForTest({ pihole_integration: false });
  }
});

test('GET /summary maps nested cache.summary fields (not top-level)', async () => {
  license._overrideForTest({ pihole_integration: true });
  const realGetCache = pihole.getCache;
  pihole.getCache = () => ({ summary: { queries: { total: 100, blocked: 20, percent: 20 }, gravity: 500, clients: { active: 5 } }, blocking: { state: 'enabled', timer: null }, attribution: 'per_peer', lastSyncAt: 123 });
  try {
    const res = await agent.get('/api/v1/pihole/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.queries.total, 100);
    assert.equal(res.body.data.gravity, 500);
    assert.equal(res.body.data.clients.active, 5);
    assert.equal(res.body.data.attribution, 'per_peer');
  } finally {
    pihole.getCache = realGetCache;
    license._overrideForTest({ pihole_integration: false });
  }
});
