'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let accounts; let getDb;

before(async () => { await setup(); accounts = require('../src/services/skoda/skodaAccounts'); ({ getDb } = require('../src/db/connection')); });
after(async () => { await teardown(); });
beforeEach(() => { for (const a of accounts.listAccounts()) accounts.removeAccount(a.id); });

test('spin_enc column exists on skoda_accounts', () => {
  const cols = getDb().prepare('PRAGMA table_info(skoda_accounts)').all().map((c) => c.name);
  assert.ok(cols.includes('spin_enc'));
});

test('setSpin encrypts at rest, getSpin roundtrips, has_spin reflects it', () => {
  const acc = accounts.createAccount({ email: 'a@b.c', password: 'pw' });
  assert.equal(accounts.listAccounts()[0].has_spin, false);
  accounts.setSpin(acc.id, '1234');
  const row = getDb().prepare('SELECT spin_enc FROM skoda_accounts WHERE id = ?').get(acc.id);
  assert.notEqual(row.spin_enc, '1234');
  assert.match(row.spin_enc, /^[0-9a-f]{24}:[0-9a-f]{32}:/);
  assert.equal(accounts.getSpin(acc.id), '1234');
  const listed = accounts.listAccounts()[0];
  assert.equal(listed.has_spin, true);
  assert.equal('spin_enc' in listed, false);
  assert.equal('spin' in listed, false);
});

test('setSpin rejects non-numeric or wrong-length', () => {
  const acc = accounts.createAccount({ email: 'a@b.c', password: 'pw' });
  assert.throws(() => accounts.setSpin(acc.id, 'abcd'), (e) => e.code === 'SKODA_VALIDATION');
  assert.throws(() => accounts.setSpin(acc.id, '12'), (e) => e.code === 'SKODA_VALIDATION');
});

test('getSpin returns null when unset', () => {
  const acc = accounts.createAccount({ email: 'a@b.c', password: 'pw' });
  assert.equal(accounts.getSpin(acc.id), null);
});
