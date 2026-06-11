'use strict';

// Route-auth TOTP replay protection is now DB-backed (route_auth_totp_used)
// so it survives a process restart. These tests lock in: accept-once,
// reject-on-replay, per-route isolation, the no-routeId setup path, and that
// the consumed code is actually persisted.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const OTPAuth = require('otpauth');

let svc, encrypt;
beforeEach(async () => {
  await setup();
  svc = require('../src/services/routeAuth');
  encrypt = require('../src/utils/crypto').encrypt;
});
afterEach(teardown);

// Build an encrypted secret plus the current valid 6-digit code for it.
function makeTotp() {
  const { secret } = svc.generateTotpSecret('totp.test');
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return { enc: encrypt(secret), token: totp.generate() };
}

test('valid code accepted once, rejected on replay', () => {
  const { enc, token } = makeTotp();
  assert.equal(svc.verifyTotp(enc, token, 42), true);
  assert.equal(svc.verifyTotp(enc, token, 42), false);
});

test('consumed code is persisted in route_auth_totp_used', () => {
  const { getDb } = require('../src/db/connection');
  const { enc, token } = makeTotp();
  svc.verifyTotp(enc, token, 7);
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM route_auth_totp_used WHERE route_id = 7').get();
  assert.equal(row.n, 1);
});

test('replay guard is scoped per route', () => {
  const { enc, token } = makeTotp();
  assert.equal(svc.verifyTotp(enc, token, 1), true);
  // Same code under a different route id is not a replay for that route.
  assert.equal(svc.verifyTotp(enc, token, 2), true);
});

test('no routeId (setup-verification path) does not track replay', () => {
  const { enc, token } = makeTotp();
  assert.equal(svc.verifyTotp(enc, token), true);
  assert.equal(svc.verifyTotp(enc, token), true);
});

test('wrong code is rejected', () => {
  const { enc } = makeTotp();
  assert.equal(svc.verifyTotp(enc, '000000', 5), false);
});
