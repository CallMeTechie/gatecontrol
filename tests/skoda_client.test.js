'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/skoda/api_responses');
const { SkodaClient, SkodaApiError, normalizeVehicleState } = require('../src/services/skoda/skodaClient');
const { API_BASE } = require('../src/services/skoda/skodaAuth');

function jsonRes(obj, status = 200) {
  return { status, ok: status < 400, headers: new Headers({ 'content-type': 'application/json' }), json: async () => obj, arrayBuffer: async () => new ArrayBuffer(0) };
}

function makeClient(routes, { session = { accessToken: 'AT', refreshToken: 'RT' } } = {}) {
  const saved = [];
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, auth: (opts.headers || {}).authorization });
    for (const [match, resOrFn] of routes) {
      if (url.includes(match)) return typeof resOrFn === 'function' ? resOrFn(url, opts) : resOrFn;
    }
    throw new Error('unexpected url ' + url);
  };
  const client = new SkodaClient({ getSession: () => session, saveSession: (s) => saved.push(s), fetchImpl });
  return { client, saved, calls };
}

test('garage sends bearer token and returns json', async () => {
  const { client, calls } = makeClient([['/api/v2/garage', jsonRes(fx.garage)]]);
  const garage = await client.garage();
  assert.equal(garage.vehicles[0].vin, 'TMBTESTVIN000001');
  assert.equal(calls[0].auth, 'Bearer AT');
});

test('401 triggers exactly one refresh then retry', async () => {
  let statusCalls = 0;
  const { client, saved } = makeClient([
    ['/api/v2/vehicle-status/TMBTESTVIN000001', () => (statusCalls++ === 0 ? jsonRes({}, 401) : jsonRes(fx.status))],
    ['/api/v1/authentication/refresh-token', jsonRes({ accessToken: 'AT2', refreshToken: 'RT2', idToken: 'ID2' })],
  ]);
  const status = await client.vehicleStatus('TMBTESTVIN000001');
  assert.equal(status.overall.locked, 'YES');
  assert.equal(statusCalls, 2);
  assert.equal(saved[0].accessToken, 'AT2'); // refreshed session persisted
});

test('second 401 after refresh raises SKODA_UNAUTHORIZED', async () => {
  const { client } = makeClient([
    ['/api/v2/vehicle-status/', jsonRes({}, 401)],
    ['/api/v1/authentication/refresh-token', jsonRes({ accessToken: 'AT2', refreshToken: 'RT2', idToken: 'ID2' })],
  ]);
  await assert.rejects(client.vehicleStatus('X'), (e) => e.code === 'SKODA_UNAUTHORIZED');
});

test('429 raises SKODA_RATE_LIMITED', async () => {
  const { client } = makeClient([['/api/v1/charging/', jsonRes({}, 429)]]);
  await assert.rejects(client.charging('X'), (e) => e.code === 'SKODA_RATE_LIMITED');
});

test('normalizeVehicleState maps all fixture parts', () => {
  const state = normalizeVehicleState({
    status: fx.status, drivingRange: fx.drivingRange, charging: fx.charging,
    airConditioning: fx.airConditioning, position: fx.positions, health: fx.health, maintenance: fx.maintenance,
  });
  assert.equal(state.locked, true);
  assert.equal(state.doorsOpen, false);
  assert.equal(state.lightsOn, false);
  assert.equal(state.detail.trunk, 'CLOSED');
  assert.equal(state.soc, 74);
  assert.equal(state.rangeKm, 310);
  assert.equal(state.charging.state, 'CHARGING');
  assert.equal(state.charging.powerKw, 10.5);
  assert.equal(state.charging.remainingMin, 95);
  assert.equal(state.charging.targetPercent, 80);
  assert.equal(state.charging.cableConnected, true);
  assert.equal(state.climate.state, 'OFF');
  assert.equal(state.climate.targetC, 22);
  assert.equal(state.climate.windowHeating, false);
  assert.equal(state.position.lat, 51.0);
  assert.equal(state.health.mileageKm, 5210);
  assert.equal(state.maintenance.dueInDays, 210);
  assert.equal(state.maintenance.partner, 'Autohaus Test GmbH');
  assert.equal(state.capturedAt, '2026-07-22T08:00:00Z');
});

test('renderImage rejects non-allowlisted or non-https hosts', async () => {
  const { client } = makeClient([]);
  await assert.rejects(client.renderImage('https://evil.example/x.png'), (e) => e.code === 'SKODA_API_ERROR');
  await assert.rejects(client.renderImage('http://ip-modcwp.azureedge.net/x.png'), (e) => e.code === 'SKODA_API_ERROR');
  await assert.rejects(client.renderImage('nicht-mal-eine-url'), (e) => e.code === 'SKODA_API_ERROR');
});

test('normalizeVehicleState tolerates missing parts with nulls', () => {
  const state = normalizeVehicleState({ status: null, drivingRange: null, charging: null, airConditioning: null, position: null, health: null, maintenance: null });
  assert.equal(state.locked, null);
  assert.equal(state.soc, null);
  assert.deepEqual(state.health.warnings, []);
  assert.equal(state.position, null);
});

test('fetchFullState survives one failing endpoint', async () => {
  const routes = [
    ['/api/v2/vehicle-status/V/driving-range', jsonRes(fx.drivingRange)],
    ['/api/v2/vehicle-status/V', jsonRes(fx.status)],
    ['/api/v1/charging/V', jsonRes({}, 500)], // this one fails
    ['/api/v2/air-conditioning/V', jsonRes(fx.airConditioning)],
    ['/api/v1/maps/positions', jsonRes(fx.positions)],
    ['/api/v1/vehicle-health-report/warning-lights/V', jsonRes(fx.health)],
    ['/api/v3/vehicle-maintenance/vehicles/V', jsonRes(fx.maintenance)],
  ];
  const { client } = makeClient(routes);
  const { state } = await client.fetchFullState('V');
  assert.equal(state.soc, 74);            // from drivingRange
  assert.equal(state.charging.state, null); // failed part -> nulls
});
