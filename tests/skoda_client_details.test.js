'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SkodaClient } = require('../src/services/skoda/skodaClient');
const { API_BASE } = require('../src/services/skoda/skodaAuth');

function okJson(body) { return { status: 200, ok: true, headers: new Headers(), json: async () => body, text: async () => '' }; }
function makeClient(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method });
    // most-specific route first: caller orders `routes` accordingly
    for (const [m, r] of routes) if (url.includes(m)) return typeof r === 'function' ? r(url, opts) : r;
    throw new Error('unexpected ' + url);
  };
  return { client: new SkodaClient({ getSession: () => ({ accessToken: 'AT', refreshToken: 'RT' }), saveSession: () => {}, fetchImpl }), calls };
}

test('TP4a enrichment GET paths', async () => {
  const { client, calls } = makeClient([
    ['/vehicle-information/V/equipment', okJson({ equipment: [] })], // before the bare one
    ['/vehicle-information/V', okJson({ vehicleSpecification: {} })],
    ['/connection-status/V/readiness', okJson({ unreachable: false })],
    ['/vehicle-status/V/driving-score', okJson({ weeklyScore: { main: 90 } })],
  ]);
  assert.deepEqual(await client.equipment('V'), { equipment: [] });
  assert.deepEqual(await client.vehicleInformation('V'), { vehicleSpecification: {} });
  assert.deepEqual(await client.connectionStatus('V'), { unreachable: false });
  assert.deepEqual(await client.drivingScore('V'), { weeklyScore: { main: 90 } });
  assert.equal(calls[1].url, API_BASE + '/api/v1/vehicle-information/V');
  assert.equal(calls[2].url, API_BASE + '/api/v2/connection-status/V/readiness');
  assert.equal(calls[3].url, API_BASE + '/api/v2/vehicle-status/V/driving-score');
});
