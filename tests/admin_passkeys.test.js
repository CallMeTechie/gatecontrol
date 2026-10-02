'use strict';

// Passkey (WebAuthn) login for the admin UI (docs/feature-admin-passkeys.md):
// register / list / remove from the profile with re-auth, usernameless login,
// challenge single-use + TTL, strict origin / RP ID / UV, counter regression,
// CSRF, require_2fa interplay, activity log. Responses come from a software
// authenticator (tests/helpers/softWebauthn.js) and are verified by the real
// @simplewebauthn/server code.

const cryptoEnv = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || cryptoEnv.randomBytes(32).toString('hex');

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const OTPAuth = require('otpauth');
const { setup, teardown } = require('./helpers/setup');
const { SoftAuthenticator } = require('./helpers/softWebauthn');

let app, agent, csrf, auth;
beforeEach(async () => {
  ({ app, agent, csrfToken: csrf } = await setup());
  auth = new SoftAuthenticator(); // GC_BASE_URL=http://localhost:3000 (helpers/setup.js)
});
afterEach(teardown);

const db = () => require('../src/db/connection').getDb();
const events = (type) => db().prepare('SELECT * FROM activity_log WHERE event_type = ? ORDER BY id').all(type);

function regOptions(a = agent, token = csrf, body = {}) {
  return a.post('/api/v1/profile/passkeys/register/options').set('x-csrf-token', token).send(body);
}
function regFinish(a, token, body) {
  return a.post('/api/v1/profile/passkeys/register').set('x-csrf-token', token).send(body);
}

async function addPasskey(name = 'Laptop', o = {}) {
  const opt = await regOptions().expect(200);
  const { response, credential } = auth.create(opt.body.data, o);
  const res = await regFinish(agent, csrf, { name, response }).expect(200);
  return { passkey: res.body.data, credential, options: opt.body.data };
}

async function anonAgent() {
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  return { a, token: page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1], html: page.text };
}

async function loginOptions(a, token) {
  const r = await a.post('/login/passkey/options').set('x-csrf-token', token).send({}).expect(200);
  return r.body.data;
}

function loginFinish(a, token, response, extra = {}) {
  return a.post('/login/passkey').set('x-csrf-token', token).send({ response, ...extra });
}

// Shift Date.now() for the duration of fn (re-auth window, challenge TTL).
async function withClockAhead(t, ms, fn) {
  const real = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => real() + ms);
  try { return await fn(); } finally { Date.now.mock.restore(); }
}

// ── schema ────────────────────────────────────────────────────────────

test('migration v84: admin_passkeys table and users.webauthn_user_id exist', () => {
  const cols = db().prepare('PRAGMA table_info(admin_passkeys)').all().map((c) => c.name);
  for (const c of ['user_id', 'credential_id', 'public_key', 'sign_count', 'transports', 'name', 'created_at', 'last_used_at']) {
    assert.ok(cols.includes(c), c);
  }
  assert.ok(db().prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'webauthn_user_id'));
  assert.ok(db().prepare("SELECT 1 FROM migration_history WHERE version = 84 AND name = 'admin_passkeys'").get());
});

// ── registration ──────────────────────────────────────────────────────

test('register: options are pinned to GC_BASE_URL, require UV + discoverable credential', async () => {
  const opt = (await regOptions().expect(200)).body.data;
  assert.equal(opt.rp.id, 'localhost');
  assert.equal(opt.authenticatorSelection.userVerification, 'required');
  assert.equal(opt.authenticatorSelection.residentKey, 'required');
  assert.equal(opt.attestation, 'none');
  assert.equal(opt.user.name, 'admin');
  // The user handle is random, not the database id.
  const admin = db().prepare("SELECT id, webauthn_user_id FROM users WHERE username = 'admin'").get();
  assert.equal(opt.user.id, admin.webauthn_user_id);
  assert.ok(Buffer.from(opt.user.id, 'base64url').length === 32);
  assert.ok(opt.challenge.length >= 22);
});

test('register → list shows name, created, last used; activity passkey_added', async () => {
  const { passkey, credential } = await addPasskey('MacBook Touch ID');
  assert.equal(passkey.name, 'MacBook Touch ID');
  const list = (await agent.get('/api/v1/profile/passkeys').expect(200)).body.data;
  assert.equal(list.available, true);
  assert.equal(list.origin, 'http://localhost:3000');
  assert.equal(list.passkeys.length, 1);
  assert.equal(list.passkeys[0].name, 'MacBook Touch ID');
  assert.ok(list.passkeys[0].created_at);
  assert.equal(list.passkeys[0].last_used_at, null);
  assert.deepEqual(list.passkeys[0].transports, ['internal', 'hybrid']);
  // Nothing key-like in the API answer.
  assert.equal(list.passkeys[0].public_key, undefined);
  assert.equal(list.passkeys[0].credential_id, undefined);

  const row = db().prepare('SELECT * FROM admin_passkeys').get();
  assert.equal(row.credential_id, credential.id);
  assert.ok(Buffer.isBuffer(row.public_key) && row.public_key.length > 60);
  assert.equal(row.sign_count, 0);

  const ev = events('passkey_added');
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /MacBook Touch ID/);
  assert.ok(!ev[0].message.includes(credential.id), 'no credential id in the log');
});

test('register: empty name gets a default, long names are cut, control chars stripped', async () => {
  const opt = await regOptions().expect(200);
  const r = await regFinish(agent, csrf, { name: '  \u0007 ', response: auth.create(opt.body.data).response }).expect(200);
  assert.equal(r.body.data.name, 'Passkey 1');
  const opt2 = await regOptions().expect(200);
  const r2 = await regFinish(agent, csrf, { name: 'x'.repeat(200), response: auth.create(opt2.body.data).response }).expect(200);
  assert.equal(r2.body.data.name.length, 64);
});

test('register: wrong origin, wrong RP ID, missing UV, wrong challenge are rejected', async () => {
  for (const bad of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { uv: false }, { challenge: 'AAAAAAAAAAAAAAAAAAAAAA' }, { type: 'webauthn.get' }]) {
    const opt = await regOptions().expect(200);
    const r = await regFinish(agent, csrf, { name: 'x', response: auth.create(opt.body.data, { ...bad, store: false }).response }).expect(400);
    assert.equal(r.body.code, 'VERIFY_FAILED', JSON.stringify(bad));
  }
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM admin_passkeys').get().n, 0);
});

test('register: the challenge is single use (also after a failed attempt) and expires', async (t) => {
  const opt = (await regOptions().expect(200)).body.data;
  await regFinish(agent, csrf, { name: 'x', response: auth.create(opt, { origin: 'https://evil.example', store: false }).response }).expect(400);
  // Same ceremony, now with a valid response: the challenge is gone.
  const again = await regFinish(agent, csrf, { name: 'x', response: auth.create(opt).response }).expect(400);
  assert.equal(again.body.code, 'NO_CHALLENGE');
  // Without any options call at all.
  assert.equal((await regFinish(agent, csrf, { name: 'x', response: auth.create(opt).response }).expect(400)).body.code, 'NO_CHALLENGE');

  // Expired: valid response, but after the TTL.
  const opt2 = (await regOptions().expect(200)).body.data;
  const resp = auth.create(opt2).response;
  const { CHALLENGE_TTL_MS } = require('../src/services/adminPasskeys');
  const late = await withClockAhead(t, CHALLENGE_TTL_MS + 1000, () => regFinish(agent, csrf, { name: 'x', response: resp }));
  assert.equal(late.status, 400);
  assert.equal(late.body.code, 'NO_CHALLENGE');
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM admin_passkeys').get().n, 0);
});

test('register: the same authenticator cannot be added twice (excludeCredentials + unique id)', async () => {
  const { credential } = await addPasskey('One');
  const opt = (await regOptions().expect(200)).body.data;
  assert.deepEqual(opt.excludeCredentials.map((c) => c.id), [credential.id]);
  // The same authenticator registering the same credential again → 409.
  const dup = await regFinish(agent, csrf, { name: 'Two', response: auth.create(opt, { reuse: credential, store: false }).response }).expect(409);
  assert.equal(dup.body.code, 'DUPLICATE');
  // A response whose outer id differs from the attested one is refused.
  const opt2 = (await regOptions().expect(200)).body.data;
  const forged = auth.create(opt2, { store: false }).response;
  forged.id = credential.id; forged.rawId = credential.id;
  assert.equal((await regFinish(agent, csrf, { name: 'Three', response: forged }).expect(400)).body.code, 'VERIFY_FAILED');
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM admin_passkeys').get().n, 1);
});

test('re-auth: stale session needs the current password for add and remove', async (t) => {
  const { passkey } = await addPasskey('Key');
  const { REAUTH_WINDOW_MS } = require('../src/routes/api/profilePasskeys');
  await withClockAhead(t, REAUTH_WINDOW_MS + 60 * 1000, async () => {
    const status = (await agent.get('/api/v1/profile/passkeys').expect(200)).body.data;
    assert.equal(status.reauth_required, true);
    assert.equal((await regOptions().expect(403)).body.code, 'REAUTH_REQUIRED');
    assert.equal((await regOptions(agent, csrf, { password: 'wrong' }).expect(400)).body.code, 'PASSWORD_INVALID');
    const del = await agent.post(`/api/v1/profile/passkeys/${passkey.id}/delete`).set('x-csrf-token', csrf).send({}).expect(403);
    assert.equal(del.body.code, 'REAUTH_REQUIRED');
    // Correct password: allowed, and it refreshes the window for the next call.
    await regOptions(agent, csrf, { password: 'TestPass123!' }).expect(200);
    await agent.post(`/api/v1/profile/passkeys/${passkey.id}/delete`).set('x-csrf-token', csrf).send({}).expect(200);
  });
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM admin_passkeys').get().n, 0);
});

test('remove: own passkey only; last one may go; password login keeps working', async () => {
  const { passkey } = await addPasskey('Only');
  // Someone else's id → 404, nothing deleted.
  const users = require('../src/services/users');
  const other = await users.create({ username: 'bob', password: 'BobPass123!x', role: 'admin' });
  db().prepare("INSERT INTO admin_passkeys (user_id, credential_id, public_key, name) VALUES (?, 'zzz', x'00', 'Bob key')").run(other.id);
  const bobKey = db().prepare("SELECT id FROM admin_passkeys WHERE credential_id = 'zzz'").get().id;
  await agent.post(`/api/v1/profile/passkeys/${bobKey}/delete`).set('x-csrf-token', csrf).send({}).expect(404);
  await agent.post('/api/v1/profile/passkeys/abc/delete').set('x-csrf-token', csrf).send({}).expect(404);

  await agent.post(`/api/v1/profile/passkeys/${passkey.id}/delete`).set('x-csrf-token', csrf).send({}).expect(200);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM admin_passkeys WHERE user_id != ?').get(other.id).n, 0);
  const ev = events('passkey_removed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].severity, 'warning');

  const { a, token } = await anonAgent();
  const res = await a.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: token }).expect(302);
  assert.equal(res.headers.location, '/dashboard');
});

test('management endpoints need CSRF and a browser session', async () => {
  await agent.post('/api/v1/profile/passkeys/register/options').send({}).expect(403);
  const anon = supertest(app);
  const r = await anon.get('/api/v1/profile/passkeys');
  assert.ok([401, 403].includes(r.status) || r.status === 302);
});

// ── login ─────────────────────────────────────────────────────────────

test('login page shows the passkey button bound to the configured origin', async () => {
  const { html } = await anonAgent();
  assert.match(html, /id="pk-login"[^>]*data-origin="http:\/\/localhost:3000"/);
  assert.match(html, /src="\/js\/webauthn\.js/);
  assert.match(html, /src="\/js\/login-passkey\.js/);
});

test('usernameless passkey login: session regenerated, API open, activity passkey_login', async () => {
  await addPasskey('Laptop');
  const { a, token } = await anonAgent();
  const opt = await loginOptions(a, token);
  assert.equal(opt.rpId, 'localhost');
  assert.equal(opt.userVerification, 'required');
  assert.deepEqual(opt.allowCredentials || [], []);

  await a.get('/api/v1/ping').expect(401);
  const res = await loginFinish(a, token, auth.get(opt)).expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.redirect, '/dashboard');
  assert.ok((res.headers['set-cookie'] || []).some((c) => c.startsWith('gc.sid=')), 'session id regenerated');
  await a.get('/api/v1/ping').expect(200);
  await a.get('/dashboard').expect(200);

  const row = db().prepare('SELECT sign_count, last_used_at FROM admin_passkeys').get();
  assert.equal(row.sign_count, 1);
  assert.ok(row.last_used_at);
  const ev = events('passkey_login');
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /admin/);
  // A passkey session is recent → management without password.
  const pageCsrf = (await a.get('/profile').expect(200)).text.match(/csrfToken:\s*'([^']+)'/)[1];
  await regOptions(a, pageCsrf).expect(200);
});

test('passkey login honours a portal returnTo, ignores foreign ones', async () => {
  await addPasskey();
  let { a, token } = await anonAgent();
  let res = await loginFinish(a, token, auth.get(await loginOptions(a, token)), { returnTo: '/portal/x' }).expect(200);
  assert.equal(res.body.redirect, '/portal/x');
  ({ a, token } = await anonAgent());
  res = await loginFinish(a, token, auth.get(await loginOptions(a, token)), { returnTo: '//evil.example/' }).expect(200);
  assert.equal(res.body.redirect, '/dashboard');
});

test('passkey login skips TOTP (passkey = MFA); password path still asks for the code', async () => {
  const s = await agent.post('/api/v1/profile/2fa/setup').set('x-csrf-token', csrf).send({}).expect(200);
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(s.body.data.secret) }).generate();
  await agent.post('/api/v1/profile/2fa/confirm').set('x-csrf-token', csrf).send({ code }).expect(200);
  await addPasskey();

  const pw = await anonAgent();
  const r = await pw.a.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: pw.token }).expect(302);
  assert.equal(r.headers.location, '/login/2fa');

  const { a, token } = await anonAgent();
  await loginFinish(a, token, auth.get(await loginOptions(a, token))).expect(200);
  await a.get('/api/v1/ping').expect(200);
});

test('require_2fa: a passkey session passes the policy, a password-only session does not', async () => {
  await addPasskey();
  require('../src/services/settings').set('security.require_2fa', 'true');

  const pw = await anonAgent();
  await pw.a.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: pw.token }).expect(302);
  const blocked = await pw.a.get('/dashboard').expect(302);
  assert.equal(blocked.headers.location, '/profile?setup2fa=1');
  // …but passkeys can still be managed from the confined profile.
  const pwCsrf = (await pw.a.get('/profile').expect(200)).text.match(/csrfToken:\s*'([^']+)'/)[1];
  await pw.a.get('/api/v1/profile/passkeys').expect(200);
  await regOptions(pw.a, pwCsrf).expect(200);

  const { a, token } = await anonAgent();
  await loginFinish(a, token, auth.get(await loginOptions(a, token))).expect(200);
  await a.get('/dashboard').expect(200);
  await a.get('/api/v1/peers').expect(200);
});

test('login: assertion replay, reused challenge and counter regression are rejected', async () => {
  await addPasskey();
  const { a, token } = await anonAgent();
  const opt = await loginOptions(a, token);
  const assertion = auth.get(opt); // counter 1
  // Verify consumes the challenge even when it fails…
  const bad = auth.get(opt, { origin: 'https://evil.example', keepCounter: true });
  assert.equal((await loginFinish(a, token, bad).expect(400)).body.code, 'LOGIN_FAILED');
  // …so the valid assertion for that challenge is dead now.
  await loginFinish(a, token, assertion).expect(400);

  // A fresh challenge: the old assertion (old challenge) does not fit.
  await loginOptions(a, token);
  await loginFinish(a, token, assertion).expect(400);

  // Successful login moves the counter to 5.
  const b = await anonAgent();
  await loginFinish(b.a, b.token, auth.get(await loginOptions(b.a, b.token), { counter: 5 })).expect(200);
  assert.equal(db().prepare('SELECT sign_count FROM admin_passkeys').get().sign_count, 5);
  // Counter going back (cloned authenticator) or standing still → rejected.
  for (const counter of [3, 5]) {
    const c = await anonAgent();
    const r = await loginFinish(c.a, c.token, auth.get(await loginOptions(c.a, c.token), { counter })).expect(400);
    assert.equal(r.body.code, 'LOGIN_FAILED');
    await c.a.get('/api/v1/ping').expect(401);
  }
  assert.equal(db().prepare('SELECT sign_count FROM admin_passkeys').get().sign_count, 5);
  assert.ok(events('passkey_login_failed').some((e) => /COUNTER/.test(e.message)));
});

test('login: authenticators without a counter (always 0) keep working', async () => {
  await addPasskey();
  for (let i = 0; i < 2; i++) {
    const { a, token } = await anonAgent();
    await loginFinish(a, token, auth.get(await loginOptions(a, token), { counter: 0 })).expect(200);
  }
});

test('login: wrong origin / RP ID, missing UV, bad signature, foreign user handle, unknown id fail alike', async () => {
  await addPasskey();
  const other = new SoftAuthenticator();
  const otherCred = other.create({ challenge: 'x', user: { id: 'AAAA' } }).credential;
  const cases = [
    { origin: 'https://evil.example' },
    { origin: 'http://127.0.0.1:3000' },
    { rpId: 'evil.example' },
    { uv: false },
    { up: false, uv: false },
    { signWith: otherCred.privateKey },
    { userHandle: Buffer.alloc(32, 1).toString('base64url') },
    { userHandle: null },
    { id: otherCred.id },
    { type: 'webauthn.create' },
  ];
  for (const o of cases) {
    const { a, token } = await anonAgent();
    const r = await loginFinish(a, token, auth.get(await loginOptions(a, token), { ...o, keepCounter: true })).expect(400);
    assert.equal(r.body.code, 'LOGIN_FAILED', JSON.stringify(Object.keys(o)));
    assert.equal(r.body.error, require('../src/i18n/en.json')['passkey.error_login_failed']);
    await a.get('/api/v1/ping').expect(401);
  }
  assert.equal(db().prepare('SELECT sign_count FROM admin_passkeys').get().sign_count, 0);
});

test('login: disabled account is refused even with a valid passkey', async () => {
  await addPasskey();
  db().prepare("UPDATE users SET enabled = 0 WHERE username = 'admin'").run();
  const { a, token } = await anonAgent();
  await loginFinish(a, token, auth.get(await loginOptions(a, token))).expect(400);
  await a.get('/api/v1/ping').expect(401);
});

test('login: expired challenge, missing challenge, missing CSRF', async (t) => {
  await addPasskey();
  const { a, token } = await anonAgent();
  // No options call yet.
  assert.equal((await loginFinish(a, token, auth.get({ challenge: 'AAAA' }, { keepCounter: true })).expect(400)).body.code, 'NO_CHALLENGE');
  const opt = await loginOptions(a, token);
  const assertion = auth.get(opt);
  const { CHALLENGE_TTL_MS } = require('../src/services/adminPasskeys');
  const late = await withClockAhead(t, CHALLENGE_TTL_MS + 1000, () => loginFinish(a, token, assertion));
  assert.equal(late.status, 400);
  assert.equal(late.body.code, 'NO_CHALLENGE');
  await a.post('/login/passkey/options').send({}).expect(403);
  await a.post('/login/passkey').send({ response: assertion }).expect(403);
});

test('deleting a user removes their passkeys (FK cascade)', async () => {
  const users = require('../src/services/users');
  const bob = await users.create({ username: 'bob2', password: 'BobPass123!x', role: 'admin' });
  db().prepare("INSERT INTO admin_passkeys (user_id, credential_id, public_key, name) VALUES (?, 'bobcred', x'00', 'k')").run(bob.id);
  await agent.delete(`/api/v1/users/${bob.id}`).set('x-csrf-token', csrf).expect(200);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM admin_passkeys WHERE credential_id = 'bobcred'").get().n, 0);
});

test('profile page renders the passkey card with its scripts and i18n', async () => {
  const page = await agent.get('/profile').expect(200);
  assert.match(page.text, /id="pk-card"/);
  assert.match(page.text, /id="pk-btn-add"/);
  assert.match(page.text, /id="pk-i18n"/);
  assert.match(page.text, /src="\/js\/webauthn\.js/);
  assert.match(page.text, /src="\/js\/profile-passkeys\.js/);
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['webauthn.js', 'profile-passkeys.js', 'login-passkey.js']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'js', f)), f);
    await agent.get(`/js/${f}`).expect(200).expect('Content-Type', /javascript/);
  }
});

test('passkey options start on a fresh session id; the page CSRF token stays valid', async () => {
  await addPasskey();
  const { a, token } = await anonAgent();
  const before = (await a.get('/login').expect(200)).headers['set-cookie'];
  const r = await a.post('/login/passkey/options').set('x-csrf-token', token).send({}).expect(200);
  const sid = (r.headers['set-cookie'] || []).find((c) => c.startsWith('gc.sid='));
  assert.ok(sid, 'options answer sets a new session cookie');
  assert.ok(!before || !before.some((c) => c.split(';')[0] === sid.split(';')[0]), 'session id changed');
  // A fixated (pre-ceremony) session id does not carry the challenge.
  const fixated = supertest.agent(app);
  const fx = await fixated.get('/login').expect(200);
  const fxToken = fx.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const opt = r.body.data;
  await loginFinish(fixated, fxToken, auth.get(opt, { keepCounter: true })).expect(400);
  // The same CSRF token works for the verify call and the password form.
  await loginFinish(a, token, auth.get(opt)).expect(200);
  const b = await anonAgent();
  await b.a.post('/login/passkey/options').set('x-csrf-token', b.token).send({}).expect(200);
  const pw = await b.a.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: b.token }).expect(302);
  assert.equal(pw.headers.location, '/dashboard');
});
