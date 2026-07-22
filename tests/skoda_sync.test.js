'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
const fx = require('./fixtures/skoda/api_responses');
let skoda; let accounts; let getDb;

function jsonRes(obj, status = 200) {
  return { status, ok: status < 400, headers: new Headers(), json: async () => obj, text: async () => JSON.stringify(obj), arrayBuffer: async () => new TextEncoder().encode('PNG').buffer };
}

// fetchImpl serving a full happy-path account: login already has a session, so
// only API calls happen. Login-flow paths are exercised in skoda_auth tests.
function apiFetch({ fail = {} } = {}) {
  return async (url) => {
    if (fail[Object.keys(fail).find((k) => url.includes(k))]) return jsonRes({}, fail[Object.keys(fail).find((k) => url.includes(k))]);
    if (url.includes('/api/v2/garage/vehicles/')) return jsonRes(fx.garage.vehicles[0]);
    if (url.includes('/api/v2/garage')) return jsonRes(fx.garage);
    if (url.includes('/driving-range')) return jsonRes(fx.drivingRange);
    if (url.includes('/api/v2/vehicle-status/')) return jsonRes(fx.status);
    if (url.includes('/api/v1/charging/')) return jsonRes(fx.charging);
    if (url.includes('/api/v2/air-conditioning/')) return jsonRes(fx.airConditioning);
    if (url.includes('/api/v1/maps/positions')) return jsonRes(fx.positions);
    if (url.includes('/warning-lights/')) return jsonRes(fx.health);
    if (url.includes('/vehicle-maintenance/')) return jsonRes(fx.maintenance);
    if (url.includes('render1.png')) return jsonRes({});
    throw new Error('unexpected ' + url);
  };
}

before(async () => {
  await setup();
  skoda = require('../src/services/skoda');
  accounts = require('../src/services/skoda/skodaAccounts');
  ({ getDb } = require('../src/db/connection'));
});
after(async () => { skoda.stopPolling(); await teardown(); });
beforeEach(() => {
  skoda._resetForTest();
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.id);
});

function seedAccountWithSession() {
  const acc = accounts.createAccount({ email: 's@x.y', password: 'pw' });
  accounts.saveSession(acc.id, { accessToken: 'AT', refreshToken: 'RT' });
  return acc;
}

test('syncAccount upserts vehicle with normalized state and image', async () => {
  const acc = seedAccountWithSession();
  const result = await skoda.syncAccount(acc.id, { fetchImpl: apiFetch() });
  assert.equal(result.ok, true);
  assert.equal(result.vehicles, 1);
  const status = skoda.getStatus();
  const v = status.vehicles[0];
  assert.equal(v.vin, 'TMBTESTVIN000001');
  assert.equal(v.name, 'Elroq');
  assert.equal(v.state.soc, 74);
  assert.ok(v.fetched_at);
  assert.equal(v.has_image, true);
  assert.equal('image' in v, false); // blob not in redacted listing
  const img = skoda.getVehicleImage(v.id);
  assert.ok(Buffer.isBuffer(img.image));
});

test('sync twice does not duplicate vehicles', async () => {
  const acc = seedAccountWithSession();
  await skoda.syncAccount(acc.id, { fetchImpl: apiFetch() });
  await skoda.syncAccount(acc.id, { fetchImpl: apiFetch() });
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM skoda_vehicles').get().c, 1);
});

test('429 sets rate_limited with 60min backoff, doubling capped at 240', async () => {
  const acc = seedAccountWithSession();
  await skoda.syncAccount(acc.id, { fetchImpl: apiFetch({ fail: { '/api/v2/garage': 429 } }) });
  let a = accounts.listAccounts()[0];
  assert.equal(a.status, 'rate_limited');
  assert.ok(a.next_retry_at);
  assert.equal(accounts.getAccountWithSecrets(acc.id).backoff_min, 60);
  await skoda.syncAll({ fetchImpl: apiFetch({ fail: { '/api/v2/garage': 429 } }), ignoreRetryAt: true });
  assert.equal(accounts.getAccountWithSecrets(acc.id).backoff_min, 120);
  await skoda.syncAll({ fetchImpl: apiFetch({ fail: { '/api/v2/garage': 429 } }), ignoreRetryAt: true });
  await skoda.syncAll({ fetchImpl: apiFetch({ fail: { '/api/v2/garage': 429 } }), ignoreRetryAt: true });
  assert.equal(accounts.getAccountWithSecrets(acc.id).backoff_min, 240); // capped
});

test('syncAll skips rate_limited account before next_retry_at and success resets backoff', async () => {
  const acc = seedAccountWithSession();
  accounts.setStatus(acc.id, 'rate_limited', '429', { backoffMin: 60, nextRetryAt: '2999-01-01T00:00:00Z' });
  let called = false;
  await skoda.syncAll({ fetchImpl: async (u) => { called = true; return apiFetch()(u); } });
  assert.equal(called, false);
  accounts.setStatus(acc.id, 'rate_limited', '429', { backoffMin: 60, nextRetryAt: '2000-01-01T00:00:00Z' });
  await skoda.syncAll({ fetchImpl: apiFetch() });
  const a = accounts.listAccounts()[0];
  assert.equal(a.status, 'ok');
  assert.equal(accounts.getAccountWithSecrets(acc.id).backoff_min, 0);
});

test('refreshVehicle enforces 5 minute cooldown', async () => {
  const acc = seedAccountWithSession();
  await skoda.syncAccount(acc.id, { fetchImpl: apiFetch() });
  const v = skoda.getStatus().vehicles[0];
  await skoda.refreshVehicle(v.id, { fetchImpl: apiFetch() });
  await assert.rejects(skoda.refreshVehicle(v.id, { fetchImpl: apiFetch() }), (e) => e.code === 'SKODA_REFRESH_COOLDOWN');
});

test('concurrent syncs of the same account are serialized (account lock)', async () => {
  const acc = seedAccountWithSession();
  let inFlight = 0; let maxInFlight = 0;
  const slowFetch = async (url) => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return apiFetch()(url);
  };
  await Promise.all([
    skoda.syncAccount(acc.id, { fetchImpl: slowFetch }),
    skoda.syncAccount(acc.id, { fetchImpl: slowFetch }),
  ]);
  assert.equal(maxInFlight, 1);
});

test('vehicle missing from a later garage response keeps its data (spec rule)', async () => {
  const acc = seedAccountWithSession();
  await skoda.syncAccount(acc.id, { fetchImpl: apiFetch() });
  const emptyGarage = async (url) => (
    url.includes('/api/v2/garage') && !url.includes('/garage/vehicles/')
      ? jsonRes({ vehicles: [] })
      : apiFetch()(url)
  );
  await skoda.syncAccount(acc.id, { fetchImpl: emptyGarage });
  const v = skoda.getStatus().vehicles[0];
  assert.equal(v.vin, 'TMBTESTVIN000001');
  assert.ok(v.state);
  assert.ok(v.fetched_at);
});

test('corrupt session_enc marks account as error without breaking syncAll', async () => {
  const acc = seedAccountWithSession();
  getDb().prepare('UPDATE skoda_accounts SET session_enc = ? WHERE id = ?').run('kaputt', acc.id);
  await skoda.syncAll({ fetchImpl: apiFetch() }); // must not throw
  assert.equal(accounts.listAccounts()[0].status, 'error');
});

test('pollIntervalMs respects setting with a 5 minute floor', () => {
  const settings = require('../src/services/settings');
  settings.set('skoda_poll_interval_min', '30');
  assert.equal(skoda.pollIntervalMs(), 30 * 60000);
  settings.set('skoda_poll_interval_min', '1');
  assert.equal(skoda.pollIntervalMs(), 5 * 60000);
  settings.set('skoda_poll_interval_min', '15');
});
