'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let dev, owners, users;
beforeEach(async () => {
  await setup();
  dev = require('../src/services/smarthome/smarthomeDevices');
  owners = require('../src/services/smarthome/smarthomeOwners');
  users = require('../src/services/users');
});
afterEach(async () => { await teardown(); });

test('removing a user clears their smarthome ownership rows', () => {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const rid = dev.upsertResource({ gateway_id: gw.id, deconz_id: '1', deconz_type: 'lights', kind: 'light', name: 'L', capabilities: {} });
  const uid = Number(getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('victim', 'x', 'user')").run().lastInsertRowid);
  owners.setOwners(rid, [uid]);
  users.remove(uid);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM smarthome_resource_owners WHERE user_id = ?').get(uid).c, 0);
});
