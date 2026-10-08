'use strict';

// The former built-in integrations (Smart Home, Klimaanlage, Fahrzeuge) are
// plugins now; their tables stay until the data is imported. Deleting a user
// still removes that user's owner rows there (and nothing else).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let users;
beforeEach(async () => {
  await setup();
  users = require('../src/services/users');
});
afterEach(async () => { await teardown(); });

test('removing a user clears their owner rows of the built-in integration tables', () => {
  const db = getDb();
  const uid = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('victim', 'x', 'user')").run().lastInsertRowid);
  const keep = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('keeper', 'x', 'user')").run().lastInsertRowid);
  db.prepare("INSERT INTO smarthome_gateways (id, name) VALUES (1, 'GW')").run();
  db.prepare("INSERT INTO smarthome_resources (id, gateway_id, deconz_id, deconz_type, kind, name) VALUES (10, 1, '1', 'lights', 'light', 'L')").run();
  db.prepare("INSERT INTO midea_devices (id, name, device_sn) VALUES (3, 'AC', 'sn-1')").run();
  db.prepare("INSERT INTO skoda_accounts (id, email, password_enc) VALUES (1, 'a@b.c', 'x')").run();
  db.prepare("INSERT INTO skoda_vehicles (id, account_id, vin) VALUES (5, 1, 'TMB1')").run();
  for (const u of [uid, keep]) {
    db.prepare('INSERT INTO smarthome_resource_owners (resource_id, user_id) VALUES (10, ?)').run(u);
    db.prepare('INSERT INTO midea_device_owners (midea_device_id, user_id) VALUES (3, ?)').run(u);
    db.prepare('INSERT INTO skoda_vehicle_owners (skoda_vehicle_id, user_id) VALUES (5, ?)').run(u);
  }
  users.remove(uid);
  for (const t of ['smarthome_resource_owners', 'midea_device_owners', 'skoda_vehicle_owners']) {
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id = ?`).get(uid).c, 0, t);
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id = ?`).get(keep).c, 1, t + ' (other user kept)');
  }
  // the built-in data itself stays for the import
  assert.equal(db.prepare('SELECT COUNT(*) c FROM smarthome_resources').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM midea_devices').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skoda_vehicles').get().c, 1);
});

test('the delete impact no longer lists built-in portal ownership', () => {
  const db = getDb();
  const uid = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('someone', 'x', 'user')").run().lastInsertRowid);
  assert.equal('portal' in users.deleteImpact(uid), false);
});
