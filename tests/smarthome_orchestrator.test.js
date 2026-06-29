'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
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
