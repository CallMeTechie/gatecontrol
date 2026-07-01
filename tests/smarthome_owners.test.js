// tests/smarthome_owners.test.js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let dev, owners;
beforeEach(async () => {
  await setup();
  dev = require('../src/services/smarthome/smarthomeDevices');
  owners = require('../src/services/smarthome/smarthomeOwners');
});
afterEach(async () => { await teardown(); });

function mkUser(name) {
  return Number(getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'user')").run(name).lastInsertRowid);
}

test('setOwners validates user existence, replaces set, ownersOf reflects it', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'L', capabilities: {} });
  const u1 = mkUser('a'); const u2 = mkUser('b');
  owners.setOwners(rid, [u1, u2]);
  assert.deepEqual(owners.ownersOf(rid).map((o) => o.username).sort(), ['a', 'b']);
  owners.setOwners(rid, [u1]); // replace
  assert.deepEqual(owners.ownersOf(rid).map((o) => o.username), ['a']);
  assert.throws(() => owners.setOwners(rid, [99999]), (e) => e.code === 'SMARTHOME_OWNER_UNKNOWN_USER');
});

test('setOwners works for plug kind (assignable)', () => {
  const gw = dev.createGateway({ name: 'GWp', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '3', deconz_type: 'lights', kind: 'plug', name: 'Plug', capabilities: {} });
  const u = mkUser('p');
  owners.setOwners(rid, [u]);
  assert.deepEqual(owners.ownersOf(rid).map((o) => o.username), ['p']);
});

test('setOwners refuses non-assignable kinds and missing resource', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const sid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '2', deconz_type: 'sensors', kind: 'switch', name: 'S', capabilities: {} });
  assert.throws(() => owners.setOwners(sid, []), (e) => e.code === 'SMARTHOME_NOT_ASSIGNABLE');
  assert.throws(() => owners.setOwners(99999, []), (e) => e.code === 'SMARTHOME_RESOURCE_NOT_FOUND');
});

test('resourcesOwnedBy includes scenes of owned groups; isOwner is direct-only', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const grp = dev.upsertResource({ gateway_id: gw.id, deconz_id: '5', deconz_type: 'groups', kind: 'group', name: 'G', capabilities: {} });
  const scn = dev.upsertResource({ gateway_id: gw.id, deconz_id: '5/1', deconz_type: 'scenes', kind: 'scene', name: 'G · S', capabilities: {} });
  const u = mkUser('u');
  owners.setOwners(grp, [u]);
  const owned = owners.resourcesOwnedBy(u);
  assert.ok(owned.includes(grp));
  assert.ok(owned.includes(scn));          // inherited
  assert.equal(owners.isOwner(scn, u), false);   // no own record
  assert.equal(owners.canAccess(scn, u), true);  // inherited access
  assert.deepEqual(owners.inheritedOwnersOf(dev.getResource(scn)).map((o) => o.username), ['u']);
  assert.equal(owners.isOwner(grp, u), true);
});

test('setOwners accepts sensor kind; switch stays non-assignable; resourcesOwnedBy includes owned sensor', () => {
  const gw = dev.createGateway({ name: 'GWs', route_id: null, apiKey: 'K', enabled: true });
  const sensor = dev.upsertResource({ gateway_id: gw.id, deconz_id: '2', deconz_type: 'sensors', kind: 'sensor', name: 'Temp', capabilities: {} });
  const sw = dev.upsertResource({ gateway_id: gw.id, deconz_id: '3', deconz_type: 'sensors', kind: 'switch', name: 'Btn', capabilities: {} });
  const u = mkUser('s');
  owners.setOwners(sensor, [u]);
  assert.deepEqual(owners.ownersOf(sensor).map((o) => o.username), ['s']);
  assert.ok(owners.resourcesOwnedBy(u).includes(sensor));
  assert.throws(() => owners.setOwners(sw, [u]), (e) => e.code === 'SMARTHOME_NOT_ASSIGNABLE');
});

test('removeAllForUser and removeAllForResource clear rows', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'L', capabilities: {} });
  const u = mkUser('u');
  owners.setOwners(rid, [u]);
  owners.removeAllForUser(u);
  assert.equal(owners.ownersOf(rid).length, 0);
  owners.setOwners(rid, [u]);
  owners.removeAllForResource(rid);
  assert.equal(owners.ownersOf(rid).length, 0);
});
