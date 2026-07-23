'use strict';
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');
const config = require('../config/default');
const license = require('../src/services/license');
const control = require('../src/services/skoda/skodaControl');
const HOME_HOST = `home.${config.dns.domain}`;
let app, accounts, owners, getDb, adminId, foreignId, mineId, foreignVehId;

beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  accounts = require('../src/services/skoda/skodaAccounts');
  owners = require('../src/services/skoda/skodaOwners');
  ({ getDb } = require('../src/db/connection'));
  license.hasFeature = () => true;
  adminId = getDb().prepare("SELECT id FROM users WHERE role='admin'").get().id;
  foreignId = getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('frau','x','user')").run().lastInsertRowid;
  const acc = accounts.createAccount({ email: 'a@x.y', password: 'pw' });
  getDb().prepare("INSERT INTO skoda_vehicles (account_id, vin, name, state_json, fetched_at) VALUES (?, 'VINM', 'Elroq', '{}', datetime('now'))").run(acc.id);
  mineId = getDb().prepare("SELECT id FROM skoda_vehicles WHERE vin='VINM'").get().id;
  owners.setOwners(mineId, [adminId]);
  getDb().prepare("INSERT INTO skoda_vehicles (account_id, vin, name, state_json, fetched_at) VALUES (?, 'VINF', 'Enyaq', '{}', datetime('now'))").run(acc.id);
  foreignVehId = getDb().prepare("SELECT id FROM skoda_vehicles WHERE vin='VINF'").get().id;
  owners.setOwners(foreignVehId, [foreignId]);
});
afterEach(async () => { await teardown(); });

test('logged-in owner can command own vehicle', async () => {
  const m = mock.method(control, 'runCommand', async () => ({ ok: true }));
  const agent = await getAgent();
  const res = await agent.post(`/api/v1/portal/skoda/vehicles/${mineId}/command`).set('Host', HOME_HOST).send({ action: 'ac_start', args: { temp: 21 } });
  assert.equal(res.status, 200);
  assert.equal(m.mock.callCount(), 1);
  m.mock.restore();
});

test('unauthenticated command returns 200 + reason login_required (no cloud call, Midea-parity)', async () => {
  const m = mock.method(control, 'runCommand', async () => ({ ok: true }));
  const res = await supertest(app).post(`/api/v1/portal/skoda/vehicles/${mineId}/command`).set('Host', HOME_HOST).send({ action: 'ac_stop' });
  assert.equal(res.status, 200);
  assert.equal(res.body.reason, 'login_required');
  assert.equal(m.mock.callCount(), 0);
  m.mock.restore();
});

test('commanding a foreign vehicle is 403 SKODA_NOT_OWNER', async () => {
  const m = mock.method(control, 'runCommand', async () => ({ ok: true }));
  const agent = await getAgent();
  const res = await agent.post(`/api/v1/portal/skoda/vehicles/${foreignVehId}/command`).set('Host', HOME_HOST).send({ action: 'ac_stop' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'SKODA_NOT_OWNER');
  assert.equal(m.mock.callCount(), 0);
  m.mock.restore();
});
