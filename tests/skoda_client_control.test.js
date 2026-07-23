'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SkodaClient, SkodaApiError } = require('../src/services/skoda/skodaClient');
const { API_BASE } = require('../src/services/skoda/skodaAuth');

function okRes(status = 200) {
  return { status, ok: status < 400, headers: new Headers(), json: async () => ({}), text: async () => '' };
}
function makeClient(routes, { session = { accessToken: 'AT', refreshToken: 'RT' } } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body, auth: (opts.headers || {}).authorization, ct: (opts.headers || {})['content-type'] });
    for (const [m, r] of routes) if (url.includes(m)) return typeof r === 'function' ? r(url, opts) : r;
    throw new Error('unexpected ' + url);
  };
  return { client: new SkodaClient({ getSession: () => session, saveSession: () => {}, fetchImpl }), calls };
}

test('startAc POSTs the correct path and body with bearer + content-type', async () => {
  const { client, calls } = makeClient([['/air-conditioning/V/start', okRes(202)]]);
  await client.startAc('V', 21.4);
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url, API_BASE + '/api/v2/air-conditioning/V/start');
  assert.equal(c.auth, 'Bearer AT');
  assert.equal(c.ct, 'application/json');
  const body = JSON.parse(c.body);
  assert.equal(body.heaterSource, 'ELECTRIC');
  assert.equal(body.targetTemperature.temperatureValue, 21); // rounded
  assert.equal(body.targetTemperature.unitInCar, 'CELSIUS');
});

test('stopAc and window heating POST with no body', async () => {
  const { client, calls } = makeClient([
    ['/air-conditioning/V/stop', okRes()],
    ['/start-window-heating', okRes()],
  ]);
  await client.stopAc('V');
  await client.startWindowHeating('V');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, undefined);
  assert.match(calls[1].url, /\/api\/v2\/air-conditioning\/V\/start-window-heating$/);
});

test('setChargeLimit uses PUT with targetSOCInPercent', async () => {
  const { client, calls } = makeClient([['/set-charge-limit', okRes()]]);
  await client.setChargeLimit('V', 80);
  assert.equal(calls[0].method, 'PUT');
  assert.match(calls[0].url, /\/api\/v1\/charging\/V\/set-charge-limit$/);
  assert.equal(JSON.parse(calls[0].body).targetSOCInPercent, 80);
});

test('lock/unlock POST currentSpin to vehicle-access', async () => {
  const { client, calls } = makeClient([['/vehicle-access/V/unlock', okRes()]]);
  await client.unlock('V', '1234');
  assert.match(calls[0].url, /\/api\/v1\/vehicle-access\/V\/unlock$/);
  assert.equal(JSON.parse(calls[0].body).currentSpin, '1234');
});

test('control 401 refreshes once then retries', async () => {
  let n = 0;
  const { client } = makeClient([
    ['/charging/V/start', () => (n++ === 0 ? okRes(401) : okRes())],
    ['/authentication/refresh-token', { status: 200, ok: true, headers: new Headers(), json: async () => ({ accessToken: 'AT2', refreshToken: 'RT2', idToken: 'ID2' }) }],
  ]);
  await client.startCharging('V'); // must not throw
  assert.equal(n, 2);
});

test('control 429 maps to SKODA_RATE_LIMITED', async () => {
  const { client } = makeClient([['/charging/V/stop', okRes(429)]]);
  await assert.rejects(client.stopCharging('V'), (e) => e.code === 'SKODA_RATE_LIMITED');
});

test('control 4xx maps to SKODA_API_ERROR with status', async () => {
  const { client } = makeClient([['/vehicle-access/V/lock', okRes(400)]]);
  await assert.rejects(client.lock('V', '0000'), (e) => e.code === 'SKODA_API_ERROR' && e.status === 400);
});
