'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let accounts; let getDb;

before(async () => {
  await setup();
  accounts = require('../src/services/skoda/skodaAccounts');
  ({ getDb } = require('../src/db/connection'));
});
after(async () => { await teardown(); });
beforeEach(() => { for (const a of accounts.listAccounts()) accounts.removeAccount(a.id); });

test('createAccount encrypts password at rest and redacts list', () => {
  const acc = accounts.createAccount({ email: 'me@example.com', password: 'geheim' });
  assert.equal(acc.email, 'me@example.com');
  assert.equal(acc.has_credentials, true);
  assert.equal('password' in acc, false);
  const row = getDb().prepare('SELECT password_enc FROM skoda_accounts WHERE id = ?').get(acc.id);
  assert.notEqual(row.password_enc, 'geheim');
  assert.match(row.password_enc, /^[0-9a-f]{24}:[0-9a-f]{32}:/); // iv:tag:enc format
});

test('duplicate email raises SKODA_ACCOUNT_EXISTS', () => {
  accounts.createAccount({ email: 'a@b.c', password: 'x' });
  assert.throws(() => accounts.createAccount({ email: 'a@b.c', password: 'y' }), (e) => e.code === 'SKODA_ACCOUNT_EXISTS');
});

test('empty or malformed fields raise SKODA_VALIDATION', () => {
  assert.throws(() => accounts.createAccount({ email: '', password: 'x' }), (e) => e.code === 'SKODA_VALIDATION');
  assert.throws(() => accounts.createAccount({ email: 'keine-mail', password: 'x' }), (e) => e.code === 'SKODA_VALIDATION');
  assert.throws(() => accounts.createAccount({ email: 'a@b.c', password: '' }), (e) => e.code === 'SKODA_VALIDATION');
  // ReDoS guard: an overlong string must be rejected in bounded time (RFC 5321 cap)
  assert.throws(() => accounts.createAccount({ email: `${'a'.repeat(9000)}@x`, password: 'x' }), (e) => e.code === 'SKODA_VALIDATION');
});

test('setStatus caps status_detail length at 300 chars', () => {
  const acc = accounts.createAccount({ email: 'cap@x.y', password: 'pw' });
  accounts.setStatus(acc.id, 'error', 'x'.repeat(1000));
  assert.equal(accounts.listAccounts().find((a) => a.id === acc.id).status_detail.length, 300);
});

test('getAccountWithSecrets decrypts password and session roundtrip', () => {
  const acc = accounts.createAccount({ email: 'a@b.c', password: 'pw1' });
  accounts.saveSession(acc.id, { accessToken: 'AT', refreshToken: 'RT' });
  const full = accounts.getAccountWithSecrets(acc.id);
  assert.equal(full.password, 'pw1');
  assert.deepEqual(full.session, { accessToken: 'AT', refreshToken: 'RT' });
});

test('setStatus stores backoff and retry time; updatePassword resets them', () => {
  const acc = accounts.createAccount({ email: 'a@b.c', password: 'pw1' });
  accounts.setStatus(acc.id, 'rate_limited', 'HTTP 429', { backoffMin: 60, nextRetryAt: '2026-07-22T12:00:00Z' });
  let listed = accounts.listAccounts()[0];
  assert.equal(listed.status, 'rate_limited');
  assert.equal(listed.next_retry_at, '2026-07-22T12:00:00Z');
  accounts.updatePassword(acc.id, 'pw2');
  listed = accounts.listAccounts()[0];
  assert.equal(listed.status, 'ok');
  assert.equal(listed.next_retry_at, null);
  assert.equal(accounts.getAccountWithSecrets(acc.id).password, 'pw2');
});

test('removeAccount cascades vehicles and owners', () => {
  const acc = accounts.createAccount({ email: 'a@b.c', password: 'pw' });
  const db = getDb();
  db.prepare('INSERT INTO skoda_vehicles (account_id, vin) VALUES (?, ?)').run(acc.id, 'TMBX');
  const veh = db.prepare('SELECT id FROM skoda_vehicles WHERE vin = ?').get('TMBX');
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  db.prepare('INSERT INTO skoda_vehicle_owners (skoda_vehicle_id, user_id) VALUES (?, ?)').run(veh.id, admin.id);
  accounts.removeAccount(acc.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skoda_vehicles').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skoda_vehicle_owners').get().c, 0);
});
