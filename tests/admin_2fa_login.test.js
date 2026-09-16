'use strict';

// Admin 2FA login flow (docs/feature-admin-2fa.md): setup → confirm → login
// with code (valid / invalid / replay / window), recovery code once, lockout,
// pending2fa expiry, no API access before the second factor, disable and
// recovery-code regeneration.

const cryptoEnv = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || cryptoEnv.randomBytes(32).toString('hex');

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const OTPAuth = require('otpauth');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf;
beforeEach(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
afterEach(teardown);

function totp(secret, offsetSec = 0) {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() + offsetSec * 1000 });
}

// TOTP steps are 30 s wide and the server accepts ±1 step. A test that mints a
// code for the previous step (or reuses one across two requests) fails when the
// step rolls over in between — it is then two steps away. Start such tests
// early inside a fresh step instead of pinning the clock.
async function inFreshStep(minLeftMs = 8000) {
  const left = 30000 - (Date.now() % 30000);
  if (left < minLeftMs) await new Promise((r) => setTimeout(r, left + 250));
}

async function enable2fa(a, token) {
  const s = await a.post('/api/v1/profile/2fa/setup').set('x-csrf-token', token).send({}).expect(200);
  assert.ok(s.body.data.secret && s.body.data.otpauth_url.startsWith('otpauth://totp/'));
  const c = await a.post('/api/v1/profile/2fa/confirm').set('x-csrf-token', token).send({ code: totp(s.body.data.secret) }).expect(200);
  assert.equal(c.body.data.recovery_codes.length, 10);
  return { secret: s.body.data.secret, codes: c.body.data.recovery_codes };
}

async function logout(a, token) {
  await a.post('/logout').type('form').send({ _csrf: token }).expect(302);
}

async function freshAgent() {
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  return { a, loginCsrf: page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1] };
}

function passwordLogin(a, loginCsrf, username = 'admin', password = 'TestPass123!') {
  return a.post('/login').type('form').send({ username, password, _csrf: loginCsrf });
}

async function twoFaPage(a, query = '') {
  const page = await a.get('/login/2fa' + query).expect(200);
  return { text: page.text, csrf: page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1] };
}

function post2fa(a, token, body) {
  return a.post('/login/2fa').type('form').send({ _csrf: token, ...body });
}

// Password step for a 2FA user: lands on /login/2fa, no session yet.
async function startLogin() {
  const { a, loginCsrf } = await freshAgent();
  const res = await passwordLogin(a, loginCsrf).expect(302);
  assert.equal(res.headers.location, '/login/2fa');
  return a;
}

test('migration v73: user columns and replay table exist', () => {
  const { getDb } = require('../src/db/connection');
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const c of ['totp_secret_enc', 'totp_enabled', 'totp_confirmed_at', 'recovery_codes']) assert.ok(cols.includes(c), c);
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_totp_used'").get();
  assert.ok(t);
  assert.ok(db.prepare("SELECT 1 FROM migration_history WHERE version = 73 AND name = 'admin_2fa'").get());
});

test('setup → confirm → login with valid code; no API before the second factor; session regenerated', async () => {
  const { secret } = await enable2fa(agent, csrf);
  const status = await agent.get('/api/v1/profile/2fa').expect(200);
  assert.equal(status.body.data.enabled, true);
  assert.equal(status.body.data.recovery_codes_remaining, 10);
  await logout(agent, csrf);

  const a = await startLogin();
  // Half-logged-in: pages and API stay closed (requireAuth unchanged).
  const dash = await a.get('/dashboard').expect(302);
  assert.equal(dash.headers.location, '/login');
  await a.get('/api/v1/ping').expect(401);

  const { text, csrf: c2 } = await twoFaPage(a);
  assert.match(text, /name="code"/);
  assert.match(text, /inputmode="numeric"/);
  assert.match(text, /autofocus/);

  // The confirmation code is already consumed (replay guard), use the next step.
  const ok = await post2fa(a, c2, { code: totp(secret, 30) }).expect(302);
  assert.equal(ok.headers.location, '/dashboard');
  const cookies = ok.headers['set-cookie'] || [];
  assert.ok(cookies.some((ck) => ck.startsWith('gc.sid=')), 'session id regenerated on completion');

  await a.get('/api/v1/ping').expect(200);
  await a.get('/dashboard').expect(200);
  // pending marker is gone: /login/2fa no longer reachable (guestOnly → /)
  const again = await a.get('/login/2fa').expect(302);
  assert.equal(again.headers.location, '/');
});

test('the confirmation code itself cannot be replayed at login', async () => {
  const s = await agent.post('/api/v1/profile/2fa/setup').set('x-csrf-token', csrf).send({}).expect(200);
  const code = totp(s.body.data.secret);
  await agent.post('/api/v1/profile/2fa/confirm').set('x-csrf-token', csrf).send({ code }).expect(200);
  await logout(agent, csrf);
  const a = await startLogin();
  const { csrf: c2 } = await twoFaPage(a);
  const res = await post2fa(a, c2, { code }).expect(302);
  assert.equal(res.headers.location, '/login/2fa');
});

test('invalid code is rejected with an error and keeps the pending step', async () => {
  await enable2fa(agent, csrf);
  await logout(agent, csrf);
  const a = await startLogin();
  const { csrf: c2 } = await twoFaPage(a);
  const res = await post2fa(a, c2, { code: '000000' }).expect(302);
  assert.equal(res.headers.location, '/login/2fa');
  const { text } = await twoFaPage(a);
  assert.match(text, /login-error/);
  await a.get('/api/v1/ping').expect(401);
  // empty submission
  const empty = await post2fa(a, c2, { code: '' }).expect(302);
  assert.equal(empty.headers.location, '/login/2fa');
});

test('a used login code is rejected on replay (admin_totp_used)', async () => {
  await inFreshStep();
  const { secret } = await enable2fa(agent, csrf);
  await logout(agent, csrf);
  const code = totp(secret, 30);

  const a1 = await startLogin();
  const p1 = await twoFaPage(a1);
  assert.equal((await post2fa(a1, p1.csrf, { code }).expect(302)).headers.location, '/dashboard');
  const { getDb } = require('../src/db/connection');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM admin_totp_used').get().n >= 1, true);

  const a2 = await startLogin();
  const p2 = await twoFaPage(a2);
  assert.equal((await post2fa(a2, p2.csrf, { code }).expect(302)).headers.location, '/login/2fa');
  await a2.get('/api/v1/ping').expect(401);
});

test('window: previous step accepted, two steps away rejected', async () => {
  await inFreshStep();
  const { secret } = await enable2fa(agent, csrf);
  await logout(agent, csrf);

  const a1 = await startLogin();
  const p1 = await twoFaPage(a1);
  assert.equal((await post2fa(a1, p1.csrf, { code: totp(secret, -30) }).expect(302)).headers.location, '/dashboard');

  const a2 = await startLogin();
  const p2 = await twoFaPage(a2);
  assert.equal((await post2fa(a2, p2.csrf, { code: totp(secret, 90) }).expect(302)).headers.location, '/login/2fa');
});

test('recovery code works exactly once', async () => {
  const { codes } = await enable2fa(agent, csrf);
  await logout(agent, csrf);

  const a1 = await startLogin();
  const p1 = await twoFaPage(a1, '?recovery=1');
  assert.match(p1.text, /name="recovery_code"/);
  // lower-case, no dash: input is normalised
  const ok = await post2fa(a1, p1.csrf, { recovery_code: codes[0].toLowerCase().replace('-', '') }).expect(302);
  assert.equal(ok.headers.location, '/dashboard');
  const st = await a1.get('/api/v1/profile/2fa').expect(200);
  assert.equal(st.body.data.recovery_codes_remaining, 9);

  const a2 = await startLogin();
  const p2 = await twoFaPage(a2, '?recovery=1');
  assert.equal((await post2fa(a2, p2.csrf, { recovery_code: codes[0] }).expect(302)).headers.location, '/login/2fa?recovery=1');
  await a2.get('/api/v1/ping').expect(401);
  assert.equal((await post2fa(a2, p2.csrf, { recovery_code: codes[1] }).expect(302)).headers.location, '/dashboard');
  await a2.get('/api/v1/ping').expect(200);
});

test('lockout after failed attempts clears pending2fa and blocks the 2FA step', async () => {
  await enable2fa(agent, csrf);
  await logout(agent, csrf);
  const a = await startLogin();
  const { csrf: c2 } = await twoFaPage(a);
  let last;
  for (let i = 0; i < 5; i++) last = await post2fa(a, c2, { code: '111111' }).expect(302);
  // 5th failure = lockout (default max_attempts 5) → back to the password form
  assert.equal(last.headers.location, '/login');
  const page = await a.get('/login/2fa').expect(302);
  assert.equal(page.headers.location, '/login');

  const lockout = require('../src/services/lockout');
  const { getDb } = require('../src/db/connection');
  const admin = getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get();
  assert.equal(lockout.isLocked(`admin_2fa:${admin.id}`).locked, true);

  // Even a fresh password login cannot reach the code form while locked.
  const { a: b, loginCsrf } = await freshAgent();
  await passwordLogin(b, loginCsrf).expect(302);
  const blocked = await b.get('/login/2fa').expect(302);
  assert.equal(blocked.headers.location, '/login');
});

test('pending2fa expires after 5 minutes', async () => {
  await enable2fa(agent, csrf);
  await logout(agent, csrf);
  const a = await startLogin();
  await a.get('/login/2fa').expect(200);
  const { getDb } = require('../src/db/connection');
  getDb().prepare("UPDATE sessions SET data = json_set(data, '$.pending2fa.at', 0) WHERE json_extract(data, '$.pending2fa.userId') IS NOT NULL").run();
  const res = await a.get('/login/2fa').expect(302);
  assert.equal(res.headers.location, '/login');
  const { csrf: c } = { csrf: (await a.get('/login').expect(200)).text.match(/name="_csrf"\s+value="([^"]+)"/)[1] };
  const post = await post2fa(a, c, { code: '123456' }).expect(302);
  assert.equal(post.headers.location, '/login');
});

test('without 2FA the login is unchanged; setup guards', async () => {
  await logout(agent, csrf);
  const { a, loginCsrf } = await freshAgent();
  const res = await passwordLogin(a, loginCsrf).expect(302);
  assert.equal(res.headers.location, '/dashboard');
  await a.get('/api/v1/ping').expect(200);
  // no pending marker → 2FA page is not offered
  const p = await a.get('/login/2fa').expect(302);
  assert.equal(p.headers.location, '/');

  // confirm without setup / wrong code
  const dash = await a.get('/dashboard');
  const c2 = dash.text.match(/csrfToken:\s*'([^']+)'/)[1];
  await a.post('/api/v1/profile/2fa/confirm').set('x-csrf-token', c2).send({ code: '123456' }).expect(400);
  const s = await a.post('/api/v1/profile/2fa/setup').set('x-csrf-token', c2).send({}).expect(200);
  const wrong = await a.post('/api/v1/profile/2fa/confirm').set('x-csrf-token', c2).send({ code: '000000' }).expect(400);
  assert.equal(wrong.body.code, 'CODE_INVALID');
  const st = await a.get('/api/v1/profile/2fa').expect(200);
  assert.equal(st.body.data.enabled, false);
  assert.equal(st.body.data.pending, true);
  await a.post('/api/v1/profile/2fa/confirm').set('x-csrf-token', c2).send({ code: totp(s.body.data.secret) }).expect(200);
  await a.post('/api/v1/profile/2fa/setup').set('x-csrf-token', c2).send({}).expect(409);
});

test('disable needs password + code; afterwards the login is password-only', async () => {
  const { secret } = await enable2fa(agent, csrf);
  const bad = await agent.post('/api/v1/profile/2fa/disable').set('x-csrf-token', csrf).send({ password: 'nope', code: totp(secret, 30) }).expect(400);
  assert.equal(bad.body.code, 'PASSWORD_INVALID');
  const badCode = await agent.post('/api/v1/profile/2fa/disable').set('x-csrf-token', csrf).send({ password: 'TestPass123!', code: '000000' }).expect(400);
  assert.equal(badCode.body.code, 'CODE_INVALID');
  await agent.post('/api/v1/profile/2fa/disable').set('x-csrf-token', csrf).send({ password: 'TestPass123!', code: totp(secret, 30) }).expect(200);
  const st = await agent.get('/api/v1/profile/2fa').expect(200);
  assert.equal(st.body.data.enabled, false);
  const { getDb } = require('../src/db/connection');
  const row = getDb().prepare("SELECT totp_secret_enc, recovery_codes FROM users WHERE username = 'admin'").get();
  assert.equal(row.totp_secret_enc, null);
  assert.equal(row.recovery_codes, null);

  await logout(agent, csrf);
  const { a, loginCsrf } = await freshAgent();
  assert.equal((await passwordLogin(a, loginCsrf).expect(302)).headers.location, '/dashboard');
});

test('recovery codes can be regenerated with the password; old ones stop working', async () => {
  const { codes } = await enable2fa(agent, csrf);
  await agent.post('/api/v1/profile/2fa/recovery-codes').set('x-csrf-token', csrf).send({ password: 'wrong' }).expect(400);
  const r = await agent.post('/api/v1/profile/2fa/recovery-codes').set('x-csrf-token', csrf).send({ password: 'TestPass123!' }).expect(200);
  const fresh = r.body.data.recovery_codes;
  assert.equal(fresh.length, 10);
  assert.ok(fresh.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)));
  assert.notDeepEqual(fresh, codes);
  await logout(agent, csrf);

  const a = await startLogin();
  const p = await twoFaPage(a, '?recovery=1');
  assert.equal((await post2fa(a, p.csrf, { recovery_code: codes[0] }).expect(302)).headers.location, '/login/2fa?recovery=1');
  assert.equal((await post2fa(a, p.csrf, { recovery_code: fresh[0] }).expect(302)).headers.location, '/dashboard');
});

test('secrets are encrypted at rest and never exposed; recovery codes stored as argon2 hashes', async () => {
  const { secret } = await enable2fa(agent, csrf);
  const { getDb } = require('../src/db/connection');
  const row = getDb().prepare("SELECT totp_secret_enc, recovery_codes FROM users WHERE username = 'admin'").get();
  assert.ok(row.totp_secret_enc && !row.totp_secret_enc.includes(secret));
  const hashes = JSON.parse(row.recovery_codes);
  assert.equal(hashes.length, 10);
  assert.ok(hashes.every((h) => h.startsWith('$argon2id$')));
  const profile = await agent.get('/api/v1/settings/profile').expect(200);
  assert.equal(profile.body.profile.totp_enabled, 1);
  assert.equal(profile.body.profile.totp_secret_enc, undefined);
  const list = await agent.get('/api/v1/users').expect(200);
  for (const u of list.body.users) {
    assert.equal(u.totp_secret_enc, undefined);
    assert.equal(u.recovery_codes, undefined);
  }
  assert.equal(list.body.users.find((u) => u.username === 'admin').totp_enabled, 1);
});
