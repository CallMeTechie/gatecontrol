'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

let sh, dev, origFetch;
beforeEach(async () => {
  await setup();
  origFetch = global.fetch;
  dev = require('../src/services/smarthome/smarthomeDevices');
  sh = require('../src/services/smarthome');
});
afterEach(async () => { global.fetch = origFetch; await teardown(); });

function jsonRes(body, status = 200) {
  return { ok: status < 300, status, async json() { return body; }, async text() { return JSON.stringify(body); } };
}

test('capsFromLight derives color capability', () => {
  assert.equal(sh.capsFromLight({ state: { on: true, bri: 100, ct: 300 } }).color, 'ct');
  assert.equal(sh.capsFromLight({ state: { on: true, bri: 100, hue: 1, sat: 2 } }).color, 'hs');
  assert.equal(sh.capsFromLight({ state: { on: true } }).color, 'none');
  assert.equal(sh.capsFromLight({ state: { on: true, bri: 5 } }).bri, true);
});

test('lightKind classifies plugs/lights and skips Configuration tool', () => {
  assert.equal(sh.lightKind({ type: 'On/Off plug-in unit' }), 'plug');
  assert.equal(sh.lightKind({ type: 'Smart plug' }), 'plug');
  assert.equal(sh.lightKind({ type: 'Dimmable light' }), 'light');
  assert.equal(sh.lightKind({ type: 'Extended color light' }), 'light');
  assert.equal(sh.lightKind({ type: 'Configuration tool' }), null);
});

test('sensorKind classifies switches/sensors and skips virtuals', () => {
  assert.equal(sh.sensorKind({ type: 'ZHASwitch' }), 'switch');
  assert.equal(sh.sensorKind({ type: 'ZHAPresence' }), 'sensor');
  assert.equal(sh.sensorKind({ type: 'ZHAOpenClose' }), 'sensor');
  assert.equal(sh.sensorKind({ type: 'ZHAWater' }), 'sensor');
  assert.equal(sh.sensorKind({ type: 'CLIPPresence' }), null);
  assert.equal(sh.sensorKind({ type: 'Daylight' }), null);
});

test('sensorReading covers open/water/temperature/lightlevel/button', () => {
  assert.equal(sh.sensorReading({ state: { open: true } }).type, 'open');
  assert.equal(sh.sensorReading({ state: { water: false } }).type, 'water');
  assert.equal(sh.sensorReading({ state: { temperature: 2150 } }).value, 21.5);
  const ll = sh.sensorReading({ state: { lightlevel: 12000, lux: 25 } });
  assert.equal(ll.type, 'lightlevel'); assert.equal(ll.value, 25);
  assert.equal(sh.sensorReading({ state: { buttonevent: 1002 } }).type, 'button');
});

test('syncGateway classifies plugs/switches and skips virtuals', async () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'KEY', enabled: true });
  const origResolve = dev.resolveTransport;
  dev.resolveTransport = () => ({ baseUrl: 'http://gw', domain: 'gw' });
  global.fetch = async (url) => {
    if (url.endsWith('/lights')) return jsonRes({
      '1': { name: 'Configuration tool 1', type: 'Configuration tool', state: { reachable: true } },
      '2': { name: 'Poolpumpe', type: 'On/Off plug-in unit', uniqueid: 'p1', state: { on: false } },
      '3': { name: 'Wintergarten', type: 'Color temperature light', uniqueid: 'l1', state: { on: true, bri: 100, ct: 300 } },
    });
    if (url.endsWith('/groups')) return jsonRes({});
    if (url.endsWith('/sensors')) return jsonRes({
      '1': { name: 'Daylight', type: 'Daylight', state: {} },
      '14': { name: 'Fensterkontakt', type: 'ZHAOpenClose', uniqueid: 's1', state: { open: true } },
      '16': { name: 'Smart Switch', type: 'ZHASwitch', uniqueid: 'sw1', state: { buttonevent: 1002 } },
    });
    return jsonRes({});
  };
  try {
    const out = await sh.syncGateway(gw.id);
    assert.equal(out.counts.lights, 1);
    assert.equal(out.counts.plugs, 1);
    assert.equal(out.counts.sensors, 1);
    assert.equal(out.counts.switches, 1);
    const res = dev.listResources(gw.id);
    assert.ok(res.find((r) => r.kind === 'plug' && r.name === 'Poolpumpe'));
    assert.ok(res.find((r) => r.kind === 'switch' && r.name === 'Smart Switch'));
    assert.ok(res.find((r) => r.kind === 'sensor' && r.capabilities.reading === 'open'));
    assert.ok(!res.find((r) => r.name === 'Configuration tool 1'));
    assert.ok(!res.find((r) => r.name === 'Daylight'));
  } finally {
    dev.resolveTransport = origResolve;
  }
});

test('syncGateway caches normalized live state', async () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'KEY', enabled: true });
  const origResolve = dev.resolveTransport;
  dev.resolveTransport = () => ({ baseUrl: 'http://gw', domain: 'gw' });
  global.fetch = async (url) => {
    if (url.endsWith('/lights')) return jsonRes({ '5': { name: 'Lamp', type: 'Dimmable light', uniqueid: 'l', state: { on: true, bri: 254, reachable: true } } });
    if (url.endsWith('/groups')) return jsonRes({});
    if (url.endsWith('/sensors')) return jsonRes({ '10': { name: 'Temp', type: 'ZHATemperature', uniqueid: 't', state: { temperature: 2150 } } });
    return jsonRes({});
  };
  try {
    await sh.syncGateway(gw.id);
    const res = dev.listResources(gw.id);
    const lamp = res.find((r) => r.kind === 'light');
    assert.equal(lamp.state.on, true);
    assert.equal(lamp.state.bri, 100);
    const temp = res.find((r) => r.kind === 'sensor');
    assert.equal(temp.state.type, 'temperature');
    assert.equal(temp.state.value, 21.5);
  } finally { dev.resolveTransport = origResolve; }
});

test('syncGateway upserts lights and sensors (best-effort)', async () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'KEY', enabled: true });
  const origResolve = dev.resolveTransport;
  dev.resolveTransport = () => ({ baseUrl: 'http://gw', domain: 'gw' });
  global.fetch = async (url) => {
    if (url.endsWith('/lights')) return jsonRes({ '1': { name: 'Lamp', type: 'Color light', uniqueid: 'aa', state: { on: true, bri: 100, hue: 1, sat: 2 } } });
    if (url.endsWith('/groups')) return jsonRes({});
    if (url.endsWith('/sensors')) return jsonRes({ '2': { name: 'Motion', type: 'ZHAPresence', uniqueid: 'bb', state: { presence: true } } });
    return jsonRes({});
  };
  try {
    const out = await sh.syncGateway(gw.id);
    assert.equal(out.counts.lights, 1);
    assert.equal(out.counts.sensors, 1);
    const res = dev.listResources(gw.id);
    assert.ok(res.find((r) => r.kind === 'light' && r.capabilities.color === 'hs'));
    assert.ok(res.find((r) => r.kind === 'sensor'));
  } finally {
    dev.resolveTransport = origResolve;
  }
});

test('connectGateway propagates link-button-not-pressed', async () => {
  const origResolve = dev.resolveTransport;
  dev.resolveTransport = () => ({ baseUrl: 'http://gw', domain: 'gw' });
  global.fetch = async () => jsonRes([{ error: { type: 101, description: 'link button not pressed' } }]);
  try {
    await assert.rejects(() => sh.connectGateway({ name: 'GW', route_id: 1 }), (e) => e.code === 'DECONZ_LINK_BUTTON_NOT_PRESSED');
  } finally {
    dev.resolveTransport = origResolve;
  }
});

test('setResourceState rejects unknown resource', async () => {
  await assert.rejects(() => sh.setResourceState(9999, { on: true }), (e) => e.code === 'SMARTHOME_RESOURCE_NOT_FOUND');
});

test('testGateway returns reachable:true on successful getConfig', async () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'KEY', enabled: true });
  const origResolve = dev.resolveTransport;
  dev.resolveTransport = () => ({ baseUrl: 'http://gw', domain: 'gw' });
  global.fetch = async () => jsonRes({ name: 'deCONZ', swversion: '2.27.4', apiversion: '1.16.0' });
  try {
    const result = await sh.testGateway(gw.id);
    assert.equal(result.reachable, true);
    assert.equal(result.baseUrl, 'http://gw');
    assert.ok(result.config && result.config.name === 'deCONZ');
  } finally {
    dev.resolveTransport = origResolve;
  }
});

test('testGateway returns reachable:false on fetch error without throwing', async () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'KEY', enabled: true });
  const origResolve = dev.resolveTransport;
  dev.resolveTransport = () => ({ baseUrl: 'http://gw', domain: 'gw' });
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const result = await sh.testGateway(gw.id);
    assert.equal(result.reachable, false);
    assert.equal(result.baseUrl, 'http://gw');
    assert.ok(result.detail || result.code);
  } finally {
    dev.resolveTransport = origResolve;
  }
});

test('testGateway throws for missing gateway', async () => {
  await assert.rejects(() => sh.testGateway(99999), (e) => e.code === 'SMARTHOME_GATEWAY_NOT_FOUND');
});
