'use strict';
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let ctx, accounts, control, getDb, vehId;

before(async () => {
  ctx = await setup();
  accounts = require('../src/services/skoda/skodaAccounts');
  control = require('../src/services/skoda/skodaControl');
  ({ getDb } = require('../src/db/connection'));
});
after(async () => { await teardown(); });
beforeEach(() => {
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.id);
  const acc = accounts.createAccount({ email: 'a@x.y', password: 'pw' });
  getDb().prepare("INSERT INTO skoda_vehicles (account_id, vin, name, state_json, fetched_at) VALUES (?, 'VINA', 'Elroq', '{}', datetime('now'))").run(acc.id);
  vehId = getDb().prepare("SELECT id FROM skoda_vehicles WHERE vin='VINA'").get().id;
});

test('POST command forwards to runCommand and returns ok', async () => {
  const m = mock.method(control, 'runCommand', async () => ({ ok: true }));
  const res = await ctx.agent.post(`/api/v1/skoda/vehicles/${vehId}/command`).set('x-csrf-token', ctx.csrfToken).send({ action: 'ac_start', args: { temp: 21 } });
  assert.equal(res.status, 200);
  assert.equal(m.mock.calls[0].arguments[1], 'ac_start');
  m.mock.restore();
});

test('unknown command maps to 400', async () => {
  const err = Object.assign(new Error('x'), { code: 'SKODA_UNKNOWN_COMMAND' });
  const m = mock.method(control, 'runCommand', async () => { throw err; });
  const res = await ctx.agent.post(`/api/v1/skoda/vehicles/${vehId}/command`).set('x-csrf-token', ctx.csrfToken).send({ action: 'x' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SKODA_UNKNOWN_COMMAND');
  m.mock.restore();
});

test('spin required maps to 409', async () => {
  const err = Object.assign(new Error('x'), { code: 'SKODA_SPIN_REQUIRED' });
  const m = mock.method(control, 'runCommand', async () => { throw err; });
  const res = await ctx.agent.post(`/api/v1/skoda/vehicles/${vehId}/command`).set('x-csrf-token', ctx.csrfToken).send({ action: 'unlock' });
  assert.equal(res.status, 409);
  m.mock.restore();
});

test('PUT spin sets it (validated) and never echoes it', async () => {
  const accId = accounts.listAccounts()[0].id;
  const res = await ctx.agent.put(`/api/v1/skoda/accounts/${accId}/spin`).set('x-csrf-token', ctx.csrfToken).send({ spin: '1234' });
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes('1234'));
  assert.equal(accounts.listAccounts()[0].has_spin, true);
  const bad = await ctx.agent.put(`/api/v1/skoda/accounts/${accId}/spin`).set('x-csrf-token', ctx.csrfToken).send({ spin: 'ab' });
  assert.equal(bad.status, 400);
});

test('command requires admin session (unauth 401)', async () => {
  const supertest = require('supertest');
  const res = await supertest(ctx.app).post(`/api/v1/skoda/vehicles/${vehId}/command`).send({ action: 'ac_stop' });
  assert.equal(res.status, 401);
});
