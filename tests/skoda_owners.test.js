'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

let owners, getDb, vehicleId, adminId, db;

before(async () => {
  await setup();
  owners = require('../src/services/skoda/skodaOwners');
  ({ getDb } = require('../src/db/connection'));
  db = getDb();
  db.prepare("INSERT INTO skoda_accounts (email, password_enc) VALUES ('o@x.y', 'enc')").run();
  const acc = db.prepare("SELECT id FROM skoda_accounts WHERE email='o@x.y'").get();
  db.prepare("INSERT INTO skoda_vehicles (account_id, vin) VALUES (?, 'TMBOWN')").run(acc.id);
  vehicleId = db.prepare("SELECT id FROM skoda_vehicles WHERE vin='TMBOWN'").get().id;
  adminId = db.prepare("SELECT id FROM users WHERE role='admin'").get().id;
});

after(async () => { await teardown(); });

beforeEach(() => { owners.removeAllForVehicle(vehicleId); });

test('setOwners replaces assignment and isOwner reflects it', () => {
  owners.setOwners(vehicleId, [adminId]);
  assert.equal(owners.isOwner(vehicleId, adminId), true);
  assert.deepEqual(owners.vehiclesOwnedBy(adminId), [vehicleId]);
  owners.setOwners(vehicleId, []);
  assert.equal(owners.isOwner(vehicleId, adminId), false);
});

test('unknown user rejected before write', () => {
  assert.throws(() => owners.setOwners(vehicleId, [999999]), (e) => e.code === 'SKODA_OWNER_UNKNOWN_USER');
  assert.equal(owners.ownersOf(vehicleId).length, 0);
});

test('unknown vehicle rejected', () => {
  assert.throws(() => owners.setOwners(999999, [adminId]), (e) => e.code === 'SKODA_VEHICLE_NOT_FOUND');
});

test('ownersOf returns id and username', () => {
  owners.setOwners(vehicleId, [adminId]);
  const list = owners.ownersOf(vehicleId);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, adminId);
  assert.ok(list[0].username);
});

test('deleting a user removes their skoda owner rows', async () => {
  const users = require('../src/services/users');
  const u = await users.create({ username: 'skoda-owner-tmp', password: 'pw12345678', role: 'user' });
  owners.setOwners(vehicleId, [u.id]);
  users.remove(u.id);
  assert.deepEqual(owners.vehiclesOwnedBy(u.id), []);
});
