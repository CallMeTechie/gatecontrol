'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

let owners, devices, users, db, adminId, bobId;
before(async () => {
  await setup();                       // Migrationen + Admin-Seed
  owners = require('../src/services/midea/mideaOwners');
  devices = require('../src/services/midea/mideaDevices');
  users = require('../src/services/users');
  db = require('../src/db/connection').getDb();
  adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  bobId = (await users.create({ username: 'bob', password: 'TestPass123!', role: 'user' })).id;  // users.create is async
});
after(async () => { await teardown(); });
beforeEach(() => {
  db.prepare('DELETE FROM midea_device_owners').run();
  for (const d of devices.listDevices()) devices.removeDevice(d.id);
});

function mkDevice(sn) { return devices.createDevice({ name: sn, device_sn: sn }); }

test('setOwners persists multiple owners; ownersOf returns them sorted', () => {
  const d = mkDevice('o-1');
  const res = owners.setOwners(d.id, [bobId, adminId]);
  assert.equal(res.length, 2);
  const names = owners.ownersOf(d.id).map((o) => o.username);
  assert.deepEqual(names, ['admin', 'bob']);   // ORDER BY username
});

test('setOwners replaces the set and dedupes', () => {
  const d = mkDevice('o-2');
  owners.setOwners(d.id, [adminId, adminId, bobId]);  // dedupe
  assert.equal(owners.ownersOf(d.id).length, 2);
  owners.setOwners(d.id, [bobId]);                     // replace
  assert.deepEqual(owners.ownersOf(d.id).map((o) => o.id), [bobId]);
});

test('setOwners with [] removes all owners', () => {
  const d = mkDevice('o-3');
  owners.setOwners(d.id, [adminId]);
  owners.setOwners(d.id, []);
  assert.equal(owners.ownersOf(d.id).length, 0);
});

test('setOwners rejects an unknown user id and writes NOTHING (validate-before-write)', () => {
  const d = mkDevice('o-4');
  owners.setOwners(d.id, [adminId]);                   // existing baseline
  assert.throws(
    () => owners.setOwners(d.id, [bobId, 999999]),     // 999999 unknown
    (e) => e.code === 'MIDEA_OWNER_UNKNOWN_USER',
  );
  // unchanged: still exactly the baseline owner
  assert.deepEqual(owners.ownersOf(d.id).map((o) => o.id), [adminId]);
});

test('devicesOwnedBy returns owned device ids; empty for unowned', () => {
  const d1 = mkDevice('o-5'); const d2 = mkDevice('o-6');
  owners.setOwners(d1.id, [bobId]);
  assert.deepEqual(owners.devicesOwnedBy(bobId), [d1.id]);
  assert.deepEqual(owners.devicesOwnedBy(adminId), []);   // owns nothing
  assert.equal(owners.ownersOf(d2.id).length, 0);         // d2 has no owner → invisible
});

test('V62 detect returns true after migration', () => {
  const { tableExists } = require('../src/db/migrationHelpers');
  assert.equal(tableExists(db, 'midea_device_owners'), true);
});

test('isOwner reflects membership', () => {
  const d = mkDevice('o-7');
  owners.setOwners(d.id, [bobId]);
  assert.equal(owners.isOwner(d.id, bobId), true);
  assert.equal(owners.isOwner(d.id, adminId), false);
});

test('removeAllForDevice / removeAllForUser clear rows', () => {
  const d = mkDevice('o-8');
  owners.setOwners(d.id, [adminId, bobId]);
  owners.removeAllForUser(bobId);
  assert.deepEqual(owners.ownersOf(d.id).map((o) => o.id), [adminId]);
  owners.removeAllForDevice(d.id);
  assert.equal(owners.ownersOf(d.id).length, 0);
});

test('deleting a user removes their owner rows', async () => {
  const d = require('../src/services/midea/mideaDevices').createDevice({ name: 'c-u', device_sn: 'c-u' });
  const carolId = (await users.create({ username: 'carol', password: 'TestPass123!', role: 'user' })).id;
  owners.setOwners(d.id, [adminId, carolId]);
  users.remove(carolId);
  assert.deepEqual(owners.ownersOf(d.id).map((o) => o.id), [adminId]);  // carol gone, admin stays
});

test('deleting a device removes its owner rows', () => {
  const d = devices.createDevice({ name: 'c-d', device_sn: 'c-d' });
  owners.setOwners(d.id, [adminId, bobId]);
  devices.removeDevice(d.id);
  // table row count for that device is zero
  assert.equal(db.prepare('SELECT COUNT(*) c FROM midea_device_owners WHERE midea_device_id = ?').get(d.id).c, 0);
  assert.equal(devices.getDevice(d.id), null);   // device gone too
});
