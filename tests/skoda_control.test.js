'use strict';
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let control, accounts, skoda, getDb, vehId, accId;

function apiFetch(spy) {
  return async (url, opts = {}) => {
    spy.push({ url, method: opts.method, body: opts.body });
    return { status: 202, ok: true, headers: new Headers(), json: async () => ({}), text: async () => '' };
  };
}

before(async () => {
  await setup();
  control = require('../src/services/skoda/skodaControl');
  accounts = require('../src/services/skoda/skodaAccounts');
  skoda = require('../src/services/skoda');
  ({ getDb } = require('../src/db/connection'));
});
after(async () => { skoda.stopPolling(); await teardown(); });
beforeEach(() => {
  control._resetForTest();
  for (const a of accounts.listAccounts()) accounts.removeAccount(a.id);
  const acc = accounts.createAccount({ email: 'c@x.y', password: 'pw' });
  accounts.saveSession(acc.id, { accessToken: 'AT', refreshToken: 'RT' });
  accId = acc.id;
  getDb().prepare("INSERT INTO skoda_vehicles (account_id, vin, name, state_json, fetched_at) VALUES (?, 'VINCTL', 'Elroq', '{}', datetime('now'))").run(acc.id);
  vehId = getDb().prepare("SELECT id FROM skoda_vehicles WHERE vin='VINCTL'").get().id;
  mock.method(skoda, 'refreshVehicle', async () => ({ ok: true })); // don't hit cloud on the post-command refresh
});

test('unknown action is rejected', async () => {
  await assert.rejects(control.runCommand(vehId, 'explode', {}), (e) => e.code === 'SKODA_UNKNOWN_COMMAND');
});

test('prototype keys are not treated as commands', async () => {
  await assert.rejects(control.runCommand(vehId, 'constructor', {}), (e) => e.code === 'SKODA_UNKNOWN_COMMAND');
});

test('command on an account without a session is rejected with SKODA_NO_SESSION', async () => {
  accounts.saveSession(accId, null); // drop the session
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'ac_stop', {}, { fetchImpl: apiFetch(spy) }), (e) => e.code === 'SKODA_NO_SESSION');
  assert.equal(spy.length, 0);
});

test('ac_start without a temperature is rejected (NaN guard)', async () => {
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'ac_start', {}, { fetchImpl: apiFetch(spy) }), (e) => e.code === 'SKODA_VALIDATION');
  assert.equal(spy.length, 0);
});

test('ac_start validates temperature range', async () => {
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'ac_start', { temp: 40 }, { fetchImpl: apiFetch(spy) }), (e) => e.code === 'SKODA_VALIDATION');
  assert.equal(spy.length, 0); // never reached the cloud
});

test('charge_limit only accepts allowed steps', async () => {
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'charge_limit', { limit: 55 }, { fetchImpl: apiFetch(spy) }), (e) => e.code === 'SKODA_VALIDATION');
  const spy2 = [];
  await control.runCommand(vehId, 'charge_limit', { limit: 80 }, { fetchImpl: apiFetch(spy2) });
  assert.equal(JSON.parse(spy2[0].body).targetSOCInPercent, 80);
});

test('ac_start reaches the cloud with rounded temp', async () => {
  const spy = [];
  const r = await control.runCommand(vehId, 'ac_start', { temp: 21.6 }, { fetchImpl: apiFetch(spy) });
  assert.equal(r.ok, true);
  assert.match(spy[0].url, /\/air-conditioning\/VINCTL\/start$/);
  assert.equal(JSON.parse(spy[0].body).targetTemperature.temperatureValue, 21.5); // rounded to nearest 0.5
});

test('ac_temp accepts 15.5 and rejects 15.0 (widened range)', async () => {
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'ac_temp', { temp: 15.0 }, { fetchImpl: apiFetch(spy) }),
    (e) => e.code === 'SKODA_VALIDATION');
  const r = await control.runCommand(vehId, 'ac_temp', { temp: 15.5 }, { fetchImpl: apiFetch(spy) });
  assert.equal(r.ok, true); // 15.5 is now in range
});

test('lock without a set S-PIN is rejected before any cloud call', async () => {
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'lock', {}, { fetchImpl: apiFetch(spy) }), (e) => e.code === 'SKODA_SPIN_REQUIRED');
  assert.equal(spy.length, 0);
});

test('unlock uses the stored S-PIN and rate-limits after 5 attempts', async () => {
  accounts.setSpin(accId, '4321');
  const spy = [];
  for (let i = 0; i < 5; i++) await control.runCommand(vehId, 'unlock', {}, { fetchImpl: apiFetch(spy) });
  assert.equal(JSON.parse(spy[0].body).currentSpin, '4321');
  await assert.rejects(control.runCommand(vehId, 'unlock', {}, { fetchImpl: apiFetch(spy) }), (e) => e.code === 'SKODA_COMMAND_RATE_LIMIT');
  assert.equal(spy.length, 5); // 6th blocked before cloud
});

// GET air-conditioning liefert die Slots, POST .../timers quittiert mit 202.
function timerFetch(spy, { timers = [{ id: 1, enabled: false, time: '05:15', type: 'RECURRING', selectedDays: ['MONDAY'] }], getStatus = 200 } = {}) {
  return async (url, opts = {}) => {
    spy.push({ url, method: opts.method || 'GET', body: opts.body });
    if (!opts.method || opts.method === 'GET') {
      if (getStatus !== 200) return { status: getStatus, ok: false, headers: new Headers(), json: async () => ({}), text: async () => '' };
      return { status: 200, ok: true, headers: new Headers(), json: async () => ({ state: 'OFF', timers }), text: async () => '' };
    }
    return { status: 202, ok: true, headers: new Headers(), json: async () => ({}), text: async () => '' };
  };
}
const OK_ARGS = { id: 1, enabled: true, time: '07:30', days: ['FRIDAY', 'MONDAY', 'MONDAY'] };

test('timer_set rejects malformed arguments before touching the cloud', async () => {
  const bad = [
    { id: 0, enabled: true, time: '07:30', days: ['MONDAY'] },
    { id: 1.5, enabled: true, time: '07:30', days: ['MONDAY'] },
    { id: '1', enabled: true, time: '07:30', days: ['MONDAY'] },
    { id: 1, enabled: 'true', time: '07:30', days: ['MONDAY'] },
    { id: 1, enabled: true, time: '7:30', days: ['MONDAY'] },
    { id: 1, enabled: true, time: '24:00', days: ['MONDAY'] },
    { id: 1, enabled: true, time: '07:60', days: ['MONDAY'] },
    { id: 1, enabled: true, time: '07:30', days: [] },
    { id: 1, enabled: true, time: '07:30', days: ['FUNDAY'] },
    { id: 1, enabled: true, time: '07:30', days: '__proto__' },
    { id: 1, enabled: true, time: '07:30', days: ['__proto__'] },
  ];
  for (const args of bad) {
    const spy = [];
    await assert.rejects(control.runCommand(vehId, 'timer_set', args, { fetchImpl: timerFetch(spy) }), (e) => e.code === 'SKODA_VALIDATION', JSON.stringify(args));
    assert.equal(spy.length, 0, `reached the cloud with ${JSON.stringify(args)}`);
  }
});

test('timer_set writes the slot back with deduped, sorted days', async () => {
  const spy = [];
  const r = await control.runCommand(vehId, 'timer_set', OK_ARGS, { fetchImpl: timerFetch(spy) });
  assert.equal(r.ok, true);
  const post = spy.find((c) => c.method === 'POST');
  assert.match(post.url, /\/api\/v2\/air-conditioning\/VINCTL\/timers$/);
  assert.deepEqual(JSON.parse(post.body), {
    timers: [{ id: 1, enabled: true, time: '07:30', type: 'RECURRING', selectedDays: ['MONDAY', 'FRIDAY'] }],
  });
});

test('timer_set ignores a type supplied by the client', async () => {
  const spy = [];
  await control.runCommand(vehId, 'timer_set', { ...OK_ARGS, type: 'ONE_OFF' }, { fetchImpl: timerFetch(spy) });
  const post = spy.find((c) => c.method === 'POST');
  assert.equal(JSON.parse(post.body).timers[0].type, 'RECURRING'); // aus der Cloud-Antwort, nicht aus dem Request
});

test('timer_set on an unknown slot fails without writing', async () => {
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'timer_set', { ...OK_ARGS, id: 9 }, { fetchImpl: timerFetch(spy) }), (e) => e.code === 'SKODA_TIMER_NOT_FOUND');
  assert.equal(spy.filter((c) => c.method === 'POST').length, 0);
});

test('timer_set refuses ONE_OFF slots without writing', async () => {
  const spy = [];
  const timers = [{ id: 1, enabled: false, time: '05:15', type: 'ONE_OFF', selectedDays: [] }];
  await assert.rejects(control.runCommand(vehId, 'timer_set', OK_ARGS, { fetchImpl: timerFetch(spy, { timers }) }), (e) => e.code === 'SKODA_TIMER_READONLY');
  assert.equal(spy.filter((c) => c.method === 'POST').length, 0);
});

test('a failing air-conditioning read propagates and writes nothing', async () => {
  const spy = [];
  await assert.rejects(control.runCommand(vehId, 'timer_set', OK_ARGS, { fetchImpl: timerFetch(spy, { getStatus: 429 }) }), (e) => e.code === 'SKODA_RATE_LIMITED');
  assert.equal(spy.filter((c) => c.method === 'POST').length, 0);
});
