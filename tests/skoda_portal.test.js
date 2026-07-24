'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let portal; let accounts; let owners; let getDb; let adminId; let otherId;

const STATE = {
  capturedAt: '2026-07-22T08:00:00Z', locked: true, doorsOpen: false, windowsOpen: false,
  detail: { bonnet: 'CLOSED', trunk: 'CLOSED', sunroof: null }, lightsOn: false,
  soc: 74, rangeKm: 310,
  charging: { state: 'CHARGING', powerKw: 10.5, remainingMin: 95, targetPercent: 80, mode: 'ACTIVATED', cableConnected: true },
  climate: { state: 'OFF', targetC: 22, remainingMin: null, windowHeating: false },
  position: { lat: 50.9413, lon: 6.9583 },
  health: { mileageKm: 5210, warnings: [] },
  maintenance: { dueInDays: 210, dueInKm: 24790, partner: 'Autohaus Test' },
};

before(async () => {
  await setup();
  portal = require('../src/services/skoda/skodaPortal');
  accounts = require('../src/services/skoda/skodaAccounts');
  owners = require('../src/services/skoda/skodaOwners');
  ({ getDb } = require('../src/db/connection'));
  adminId = getDb().prepare("SELECT id FROM users WHERE role='admin'").get().id;
  const info = getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('frau', 'x', 'user')").run();
  otherId = info.lastInsertRowid;
});
after(async () => { await teardown(); });

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM skoda_vehicle_owners').run();
  db.prepare('DELETE FROM skoda_vehicles').run();
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.id);
});

function seedVehicle(vin, name, state) {
  const acc = accounts.createAccount({ email: `${vin}@x.y`, password: 'pw' });
  getDb().prepare("INSERT INTO skoda_vehicles (account_id, vin, name, model, state_json, fetched_at) VALUES (?,?,?,?,?,datetime('now'))")
    .run(acc.id, vin, name, name, JSON.stringify(state));
  return getDb().prepare('SELECT id FROM skoda_vehicles WHERE vin=?').get(vin).id;
}

test('portalVehiclesFor returns only the owner\'s vehicles, redacted, with address', async () => {
  const mine = seedVehicle('TMBMINE', 'Elroq', STATE);
  const foreign = seedVehicle('TMBFOREIGN', 'Enyaq', STATE);
  owners.setOwners(mine, [adminId]);
  owners.setOwners(foreign, [otherId]);
  const fetchImpl = async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({ address: { road: 'Hauptstraße', house_number: '5', postcode: '50667', city: 'Köln' } }) });

  const list = await portal.portalVehiclesFor(adminId, { fetchImpl });
  assert.equal(list.length, 1);
  const v = list[0];
  assert.equal(v.name, 'Elroq');
  assert.equal(v.state.soc, 74);
  assert.equal(v.state.position.address, 'Hauptstraße 5, 50667 Köln');
  assert.equal(v.state.position.lat, 50.9413);
  // redaction: no account_id, no vin, no raw account fields
  assert.equal('account_id' in v, false);
  assert.equal('vin' in v, false);
});

test('portalVehiclesFor returns [] for a user who owns nothing', async () => {
  const mine = seedVehicle('TMBX', 'Elroq', STATE);
  owners.setOwners(mine, [adminId]);
  assert.deepEqual(await portal.portalVehiclesFor(otherId), []);
});

test('portalVehiclesFor returns [] for null owner', async () => {
  assert.deepEqual(await portal.portalVehiclesFor(null), []);
});

test('portalVehiclesFor tolerates null state and missing position', async () => {
  const noState = { ...STATE, position: null };
  const v1 = seedVehicle('TMBNOPOS', 'Elroq', noState);
  owners.setOwners(v1, [adminId]);
  const list = await portal.portalVehiclesFor(adminId, { fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.equal(list[0].state.position, null);
});

test('includePosition:false nulls position and skips geocoding', async () => {
  const mine = seedVehicle('TMBPOS', 'Elroq', STATE);
  owners.setOwners(mine, [adminId]);
  const list = await portal.portalVehiclesFor(adminId, {
    includePosition: false,
    fetchImpl: async () => { throw new Error('geocode must not run without login'); },
  });
  assert.equal(list[0].state.position, null);
});

test('portal redaction passes timers through with only the five allowed fields', async () => {
  const withTimers = JSON.parse(JSON.stringify(STATE));
  withTimers.climate.timers = [
    { id: 1, enabled: true, time: '12:00', type: 'RECURRING', days: ['MONDAY'], secretVin: 'TMBLEAK' },
  ];
  const id = seedVehicle('TMBTIMER', 'Elroq', withTimers);
  owners.setOwners(id, [adminId]);

  const list = await portal.portalVehiclesFor(adminId, { includePosition: true });
  assert.deepEqual(list[0].state.climate.timers, [
    { id: 1, enabled: true, time: '12:00', type: 'RECURRING', days: ['MONDAY'] },
  ]);
});

test('portal redaction hides timers from a device-trust reader without a login', async () => {
  const withTimers = JSON.parse(JSON.stringify(STATE));
  withTimers.climate.timers = [{ id: 1, enabled: true, time: '12:00', type: 'RECURRING', days: ['MONDAY'] }];
  const id = seedVehicle('TMBNOLOGIN', 'Elroq', withTimers);
  owners.setOwners(id, [adminId]);

  const list = await portal.portalVehiclesFor(adminId, { includePosition: false });
  assert.deepEqual(list[0].state.climate.timers, []);
});

test('portal redaction yields an empty timer list when state has none', async () => {
  const noTimers = JSON.parse(JSON.stringify(STATE));
  delete noTimers.climate.timers;
  const id = seedVehicle('TMBNOTIMER', 'Enyaq', noTimers);
  owners.setOwners(id, [adminId]);

  const list = await portal.portalVehiclesFor(adminId, { includePosition: true });
  assert.deepEqual(list[0].state.climate.timers, []);
});
