'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let dev;
beforeEach(async () => { await setup(); dev = require('../src/services/smarthome/smarthomeDevices'); });
afterEach(async () => { await teardown(); });

test('createGateway encrypts api key, getGateway decrypts', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'SECRET', enabled: true });
  const row = getDb().prepare('SELECT api_key_enc FROM smarthome_gateways WHERE id=?').get(gw.id);
  assert.notEqual(row.api_key_enc, 'SECRET');
  assert.ok(row.api_key_enc.includes(':'));
  assert.equal(dev.getGateway(gw.id).apiKey, 'SECRET');
});

test('rowToResource does not leak capabilities_json', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', uniqueid: 'aa', kind: 'light', name: 'L', capabilities: { on: true } });
  const r = dev.listResources(gw.id)[0];
  assert.ok(!('capabilities_json' in r));
  assert.deepEqual(r.capabilities, { on: true });
});

test('upsertResource matches lights by uniqueid across deconz_id change', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', uniqueid: 'aa:bb', kind: 'light', name: 'Lamp', capabilities: { on: true } });
  // Conbee reassigned id 1 -> 7 but same MAC:
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '7', deconz_type: 'lights', uniqueid: 'aa:bb', kind: 'light', name: 'Lamp', capabilities: { on: true } });
  const lights = dev.listResources(gw.id).filter((r) => r.kind === 'light');
  assert.equal(lights.length, 1);
  assert.equal(lights[0].deconz_id, '7');
});

test('markMissing disables unseen, keeps seen enabled', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'A', capabilities: {} });
  dev.upsertResource({ gateway_id: gw.id, deconz_id: '2', deconz_type: 'lights', kind: 'light', name: 'B', capabilities: {} });
  dev.markMissing(gw.id, ['lights:1']); // only #1 seen
  const a = dev.listResources(gw.id).find((r) => r.deconz_id === '1');
  const b = dev.listResources(gw.id).find((r) => r.deconz_id === '2');
  assert.equal(a.enabled, 1);
  assert.equal(b.enabled, 0);
});

test('removeGateway cascades resources, owners, rules', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'A', capabilities: {} });
  getDb().prepare('INSERT INTO smarthome_resource_owners (resource_id, user_id) VALUES (?, 1)').run(rid);
  dev.removeGateway(gw.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM smarthome_resources WHERE gateway_id=?').get(gw.id).c, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM smarthome_resource_owners WHERE resource_id=?').get(rid).c, 0);
});

test('resolveBaseUrl returns null for missing route', () => {
  assert.equal(dev.resolveBaseUrl(99999), null);
});

test('resolveTransport returns null for missing route', () => {
  assert.equal(dev.resolveTransport(99999), null);
});
