'use strict';

// services/adminPasskeys (docs/feature-admin-passkeys.md): RP derivation from
// GC_BASE_URL, name normalisation, user handle, and the counter
// compare-and-set under concurrent assertions.

const cryptoEnv = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || cryptoEnv.randomBytes(32).toString('hex');

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { SoftAuthenticator } = require('./helpers/softWebauthn');

let app;
beforeEach(async () => { ({ app } = await setup()); });
afterEach(teardown);

const config = require('../config/default');
const passkeys = require('../src/services/adminPasskeys');
const db = () => require('../src/db/connection').getDb();
const adminId = () => db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

function withBaseUrl(url, fn) {
  const prev = config.app.baseUrl;
  config.app.baseUrl = url;
  try { return fn(); } finally { config.app.baseUrl = prev; }
}

test('relying party comes from GC_BASE_URL only', () => {
  assert.deepEqual(withBaseUrl('https://gate.example.com', passkeys.getRelyingParty),
    { rpID: 'gate.example.com', origin: 'https://gate.example.com', rpName: 'GateControl' });
  assert.deepEqual(withBaseUrl('https://Gate.Example.com:8443/some/path', passkeys.getRelyingParty),
    { rpID: 'gate.example.com', origin: 'https://gate.example.com:8443', rpName: 'GateControl' });
  assert.equal(withBaseUrl('http://localhost:3000', passkeys.getRelyingParty).rpID, 'localhost');
  // Not usable for WebAuthn: plain http on a real host, IP addresses, junk.
  for (const bad of ['http://gate.example.com', 'https://10.0.0.1', 'http://127.0.0.1:3000', 'https://[::1]:3000', 'not a url', '']) {
    assert.equal(withBaseUrl(bad, passkeys.getRelyingParty), null, bad);
    assert.equal(withBaseUrl(bad, passkeys.isAvailable), false, bad);
  }
});

test('unavailable RP: options are refused, login page hides the button', async () => {
  const prev = config.app.baseUrl;
  config.app.baseUrl = 'http://127.0.0.1:3000';
  try {
    await assert.rejects(() => passkeys.beginAuthentication(), { code: 'UNAVAILABLE' });
    await assert.rejects(() => passkeys.beginRegistration(adminId()), { code: 'UNAVAILABLE' });
    const a = require('supertest').agent(app);
    const page = await a.get('/login').expect(200);
    assert.doesNotMatch(page.text, /id="pk-login"/);
    const token = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const r = await a.post('/login/passkey/options').set('x-csrf-token', token).send({}).expect(503);
    assert.equal(r.body.code, 'UNAVAILABLE');
  } finally {
    config.app.baseUrl = prev;
  }
});

test('normalizeName trims, strips control characters and caps the length', () => {
  assert.equal(passkeys.normalizeName('  YubiKey 5\u0000\n '), 'YubiKey 5');
  assert.equal(passkeys.normalizeName(null), '');
  assert.equal(passkeys.normalizeName('ä'.repeat(100)).length, passkeys.NAME_MAX);
});

test('user handle is created once and stays stable', async () => {
  const a = await passkeys.beginRegistration(adminId());
  const b = await passkeys.beginRegistration(adminId());
  assert.equal(a.options.user.id, b.options.user.id);
  assert.notEqual(a.challenge, b.challenge);
});

test('concurrent assertions with the same counter: only one wins', async () => {
  const auth = new SoftAuthenticator();
  const reg = await passkeys.beginRegistration(adminId());
  const { response } = auth.create(reg.options);
  await passkeys.finishRegistration(adminId(), { response, expectedChallenge: reg.challenge, name: 'k' });

  const l1 = await passkeys.beginAuthentication();
  const l2 = await passkeys.beginAuthentication();
  const a1 = auth.get(l1.options, { counter: 7 });
  const a2 = auth.get(l2.options, { counter: 7 });
  const results = await Promise.allSettled([
    passkeys.finishAuthentication({ response: a1, expectedChallenge: l1.challenge }),
    passkeys.finishAuthentication({ response: a2, expectedChallenge: l2.challenge }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.code, 'COUNTER');
  assert.equal(db().prepare('SELECT sign_count FROM admin_passkeys').get().sign_count, 7);
});

test('registration limit per user', async () => {
  const uid = adminId();
  const ins = db().prepare("INSERT INTO admin_passkeys (user_id, credential_id, public_key, name) VALUES (?, ?, x'00', 'k')");
  for (let i = 0; i < passkeys.MAX_PASSKEYS_PER_USER; i++) ins.run(uid, `c${i}`);
  await assert.rejects(() => passkeys.beginRegistration(uid), { code: 'LIMIT' });
});
