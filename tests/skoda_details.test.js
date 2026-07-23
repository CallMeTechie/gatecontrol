'use strict';
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let details, accounts, skoda, getDb, vehId, accId;

const VIN = 'TMBTESTVIN01234567';

// Raw shapes taken verbatim from the 2026-07-23 live spike (both real cars).
function apiFetch(spy = []) {
  return async (url, opts = {}) => {
    spy.push({ url });
    const j = (body) => ({ status: 200, ok: true, headers: new Headers(), json: async () => body, text: async () => '' });
    if (url.includes(`/vehicle-information/${VIN}/equipment`)) return j({ equipment: [{ name: 'Braking Assists' }, { name: 'Kessy Advanced' }, { name: null }] });
    if (url.includes(`/vehicle-information/${VIN}`)) return j({ vehicleSpecification: { title: 'Škoda Elroq', model: 'Elroq', modelYear: '2026', manufacturingDate: '2025-10-04', body: 'SUV', trimLevel: '85', engine: { powerInKW: 210 }, battery: { capacityInKWh: 77 }, maxChargingPowerInKW: 125 } });
    if (url.includes(`/connection-status/${VIN}/readiness`)) return j({ unreachable: false, ignitionOn: false, inMotion: false });
    if (url.includes(`/vehicle-status/${VIN}/driving-score`)) return j({ weeklyScore: { main: 96 }, monthlyScore: { main: 93 }, lastCalculationDate: '2026-07-23' });
    throw new Error('unexpected ' + url);
  };
}

before(async () => {
  await setup();
  details = require('../src/services/skoda/skodaDetails');
  accounts = require('../src/services/skoda/skodaAccounts');
  skoda = require('../src/services/skoda');
  ({ getDb } = require('../src/db/connection'));
});
after(async () => { skoda.stopPolling(); await teardown(); });
beforeEach(() => {
  details._resetForTest();
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.id);
  const acc = accounts.createAccount({ email: 'd@x.y', password: 'pw' });
  accounts.saveSession(acc.id, { accessToken: 'AT', refreshToken: 'RT' });
  accId = acc.id;
  getDb().prepare("INSERT INTO skoda_vehicles (account_id, vin, name, state_json, fetched_at) VALUES (?, ?, 'Elroq', '{}', datetime('now'))").run(acc.id, VIN);
  vehId = getDb().prepare('SELECT id FROM skoda_vehicles WHERE vin = ?').get(VIN).id;
});

test('getDetails normalizes the live shapes (admin form, full vin)', async () => {
  const d = await details.getDetails(vehId, { fetchImpl: apiFetch(), forAdmin: true });
  assert.equal(d.meta.model, 'Elroq');
  assert.equal(d.meta.modelYear, '2026');
  assert.equal(d.meta.powerKw, 210);
  assert.equal(d.meta.batteryKwh, 77);
  assert.equal(d.meta.vin, VIN); // admin: full vin
  assert.deepEqual(d.equipment, ['Braking Assists', 'Kessy Advanced']); // null name dropped
  assert.deepEqual(d.connection, { online: true, ignitionOn: false, inMotion: false });
  assert.deepEqual(d.drivingScore, { weekly: 96, monthly: 93, lastCalculationDate: '2026-07-23' });
});

test('no active session → SKODA_NO_SESSION, no cloud call', async () => {
  accounts.saveSession(accId, null);
  await assert.rejects(details.getDetails(vehId, { fetchImpl: () => { throw new Error('should not be called'); } }),
    (e) => e.code === 'SKODA_NO_SESSION');
});

test('warm admin cache still masks vin for a following portal call (VIN-leak regression)', async () => {
  await details.getDetails(vehId, { fetchImpl: apiFetch(), forAdmin: true }); // warms cache with full VIN
  const portal = await details.getDetails(vehId, { fetchImpl: () => { throw new Error('no refetch'); }, forAdmin: false });
  assert.match(portal.meta.vin, /^\*\*\*4567$/); // masked, served from cache
});

test('portal redaction returns a clone (mutating it does not poison the cache)', async () => {
  const portal = await details.getDetails(vehId, { fetchImpl: apiFetch(), forAdmin: false });
  portal.equipment.push('INJECTED'); // downstream mutation
  const admin = await details.getDetails(vehId, { fetchImpl: () => { throw new Error('no refetch'); }, forAdmin: true });
  assert.equal(admin.equipment.includes('INJECTED'), false);
});

test('concurrent expands share one cloud roundtrip (in-flight dedupe)', async () => {
  const spy = [];
  const f = apiFetch(spy);
  await Promise.all([
    details.getDetails(vehId, { fetchImpl: f, forAdmin: true }),
    details.getDetails(vehId, { fetchImpl: f, forAdmin: false }),
  ]);
  assert.equal(spy.length, 4); // 4 endpoints once, not 8
});

test('SKODA_RATE_LIMITED aborts and is negative-cached', async () => {
  const rl = async () => ({ status: 429, ok: false, headers: new Headers(), json: async () => ({}), text: async () => '' });
  await assert.rejects(details.getDetails(vehId, { fetchImpl: rl, forAdmin: true }), (e) => e.code === 'SKODA_RATE_LIMITED');
  await assert.rejects(details.getDetails(vehId, { fetchImpl: () => { throw new Error('no refetch'); }, forAdmin: true }),
    (e) => e.code === 'SKODA_RATE_LIMITED'); // hits negative cache, no refetch
});
