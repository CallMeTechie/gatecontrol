'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let getDb;

before(async () => { await setup(); ({ getDb } = require('../src/db/connection')); });
after(async () => { await teardown(); });

test('skoda tables exist with expected columns', () => {
  const db = getDb();
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.deepEqual(
    cols('skoda_accounts').sort(),
    ['backoff_min', 'created_at', 'email', 'id', 'next_retry_at', 'password_enc', 'session_enc', 'spin_enc', 'status', 'status_detail', 'updated_at']
  );
  assert.deepEqual(
    cols('skoda_vehicles').sort(),
    ['account_id', 'created_at', 'fetched_at', 'id', 'image', 'image_url', 'model', 'name', 'state_json', 'vin']
  );
  assert.deepEqual(cols('skoda_vehicle_owners').sort(), ['created_at', 'skoda_vehicle_id', 'user_id']);
});

test('vin is unique', () => {
  const db = getDb();
  db.prepare("INSERT INTO skoda_accounts (email, password_enc) VALUES ('u@x.y', 'enc')").run();
  const acc = db.prepare("SELECT id FROM skoda_accounts WHERE email = 'u@x.y'").get();
  db.prepare("INSERT INTO skoda_vehicles (account_id, vin) VALUES (?, 'TMB1')").run(acc.id);
  assert.throws(() => db.prepare("INSERT INTO skoda_vehicles (account_id, vin) VALUES (?, 'TMB1')").run(acc.id));
});
