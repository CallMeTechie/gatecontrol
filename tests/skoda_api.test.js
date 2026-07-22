'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let ctx; let accounts; let skoda; let getDb;

before(async () => {
  ctx = await setup();
  accounts = require('../src/services/skoda/skodaAccounts');
  skoda = require('../src/services/skoda');
  ({ getDb } = require('../src/db/connection'));
});
after(async () => { skoda.stopPolling(); await teardown(); });
beforeEach(() => {
  skoda._resetForTest();
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.id);
});

function seedVehicle() {
  const acc = accounts.createAccount({ email: 'v@x.y', password: 'pw' });
  const db = getDb();
  db.prepare("INSERT INTO skoda_vehicles (account_id, vin, name, model, state_json, fetched_at, image, image_url) VALUES (?, 'TMBAPI', 'Elroq', 'Elroq', '{\"soc\":50}', datetime('now'), x'89504e47', 'u')").run(acc.id);
  return db.prepare("SELECT id FROM skoda_vehicles WHERE vin='TMBAPI'").get().id;
}

test('GET /api/v1/skoda returns accounts, vehicles, poll interval', async () => {
  seedVehicle();
  const res = await ctx.agent.get('/api/v1/skoda');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.accounts.length, 1);
  assert.equal('password_enc' in res.body.accounts[0], false);
  assert.equal(res.body.vehicles[0].vin, 'TMBAPI');
  assert.equal(res.body.vehicles[0].state.soc, 50);
  assert.equal(typeof res.body.poll_interval_min, 'number');
});

test('POST /accounts validates and creates', async () => {
  let res = await ctx.agent.post('/api/v1/skoda/accounts').set('x-csrf-token', ctx.csrfToken).send({ email: '', password: 'x' });
  assert.equal(res.status, 400);
  res = await ctx.agent.post('/api/v1/skoda/accounts').set('x-csrf-token', ctx.csrfToken).send({ email: 'n@x.y', password: 'pw' });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  res = await ctx.agent.post('/api/v1/skoda/accounts').set('x-csrf-token', ctx.csrfToken).send({ email: 'n@x.y', password: 'pw' });
  assert.equal(res.status, 409);
});

test('owners PUT validates users and vehicle', async () => {
  const vid = seedVehicle();
  const admin = getDb().prepare("SELECT id FROM users WHERE role='admin'").get();
  let res = await ctx.agent.put(`/api/v1/skoda/vehicles/${vid}/owners`).set('x-csrf-token', ctx.csrfToken).send({ user_ids: [admin.id] });
  assert.equal(res.status, 200);
  res = await ctx.agent.put(`/api/v1/skoda/vehicles/${vid}/owners`).set('x-csrf-token', ctx.csrfToken).send({ user_ids: [999999] });
  assert.equal(res.status, 400);
  res = await ctx.agent.put('/api/v1/skoda/vehicles/999999/owners').set('x-csrf-token', ctx.csrfToken).send({ user_ids: [] });
  assert.equal(res.status, 404);
});

test('owners PUT rejects non-array user_ids with 400', async () => {
  const vid = seedVehicle();
  const res = await ctx.agent.put(`/api/v1/skoda/vehicles/${vid}/owners`).set('x-csrf-token', ctx.csrfToken).send({ user_ids: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SKODA_VALIDATION');
});

test('PUT /accounts/:id updates password, DELETE removes account', async () => {
  const created = await ctx.agent.post('/api/v1/skoda/accounts').set('x-csrf-token', ctx.csrfToken).send({ email: 'p@x.y', password: 'pw' });
  const id = created.body.account.id;
  let res = await ctx.agent.put(`/api/v1/skoda/accounts/${id}`).set('x-csrf-token', ctx.csrfToken).send({ password: 'pw2' });
  assert.equal(res.status, 200);
  res = await ctx.agent.put('/api/v1/skoda/accounts/999999').set('x-csrf-token', ctx.csrfToken).send({ password: 'x' });
  assert.equal(res.status, 404);
  res = await ctx.agent.delete(`/api/v1/skoda/accounts/${id}`).set('x-csrf-token', ctx.csrfToken);
  assert.equal(res.status, 200);
  assert.equal(accounts.listAccounts().length, 0);
});

test('POST /accounts/:id/sync triggers a (mocked) sync', async () => {
  const { mock } = require('node:test');
  const acc = accounts.createAccount({ email: 'sync@x.y', password: 'pw' });
  const m = mock.method(skoda, 'syncAccount', async () => ({ ok: true, vehicles: 0 }));
  const res = await ctx.agent.post(`/api/v1/skoda/accounts/${acc.id}/sync`).set('x-csrf-token', ctx.csrfToken).send({});
  assert.equal(res.status, 200);
  assert.equal(m.mock.callCount(), 1);
  m.mock.restore();
});

test('vehicle image served admin-only with content type', async () => {
  const vid = seedVehicle();
  const res = await ctx.agent.get(`/api/v1/skoda/vehicles/${vid}/image`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/png/);
  const missing = await ctx.agent.get('/api/v1/skoda/vehicles/999999/image');
  assert.equal(missing.status, 404);
});

test('refresh cooldown maps to 429', async () => {
  const { mock } = require('node:test');
  const vid = seedVehicle();
  // Mocked: the cooldown logic itself is covered in skoda_sync.test.js — here
  // we only verify the error-code -> HTTP-status mapping, without any network.
  const err = Object.assign(new Error('refresh cooldown active'), { code: 'SKODA_REFRESH_COOLDOWN' });
  const m = mock.method(skoda, 'refreshVehicle', async () => { throw err; });
  const res = await ctx.agent.post(`/api/v1/skoda/vehicles/${vid}/refresh`).set('x-csrf-token', ctx.csrfToken).send({});
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'SKODA_REFRESH_COOLDOWN');
  m.mock.restore();
});

test('settings PUT validates range and persists', async () => {
  let res = await ctx.agent.put('/api/v1/skoda/settings').set('x-csrf-token', ctx.csrfToken).send({ poll_interval_min: 3 });
  assert.equal(res.status, 400);
  res = await ctx.agent.put('/api/v1/skoda/settings').set('x-csrf-token', ctx.csrfToken).send({ poll_interval_min: 30 });
  assert.equal(res.status, 200);
  assert.equal(require('../src/services/settings').get('skoda_poll_interval_min'), '30');
});

test('unauthenticated request is rejected', async () => {
  const supertest = require('supertest');
  const res = await supertest(ctx.app).get('/api/v1/skoda');
  assert.equal(res.status, 401);
});
