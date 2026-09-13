'use strict';

// security.require_2fa enforcement, admin reset, disable-refusal under
// policy, and the "other auth paths are unaffected" guarantees.

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

async function enable2fa(a, token) {
  const s = await a.post('/api/v1/profile/2fa/setup').set('x-csrf-token', token).send({}).expect(200);
  await a.post('/api/v1/profile/2fa/confirm').set('x-csrf-token', token).send({ code: totp(s.body.data.secret) }).expect(200);
  return s.body.data.secret;
}

function setRequire(on) {
  return agent.put('/api/v1/settings/security').set('x-csrf-token', csrf).send({ require_2fa: on }).expect(200);
}

async function loginAs(username, password) {
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const loginCsrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const res = await a.post('/login').type('form').send({ username, password, _csrf: loginCsrf }).expect(302);
  return { a, location: res.headers.location };
}

async function pageCsrf(a, path = '/profile') {
  const page = await a.get(path).expect(200);
  return page.text.match(/csrfToken:\s*'([^']+)'/)[1];
}

test('security.require_2fa is stored and reported', async () => {
  const before = await agent.get('/api/v1/settings/security').expect(200);
  assert.equal(before.body.data.require_2fa, false);
  // The toggling admin needs 2FA themself, otherwise the policy closes the
  // settings API right after the PUT (only the profile setup stays open).
  await enable2fa(agent, csrf);
  await setRequire(true);
  const after = await agent.get('/api/v1/settings/security').expect(200);
  assert.equal(after.body.data.require_2fa, true);
  assert.equal(require('../src/services/settings').get('security.require_2fa'), 'true');
  await setRequire('false');
  assert.equal(require('../src/services/settings').get('security.require_2fa'), 'false');
});

test('require_2fa: admin without 2FA is sent to the profile setup and blocked elsewhere', async () => {
  await setRequire(true);

  const dash = await agent.get('/dashboard').expect(302);
  assert.equal(dash.headers.location, '/profile?setup2fa=1');
  const api = await agent.get('/api/v1/peers').expect(403);
  assert.equal(api.body.code, 'TWO_FA_REQUIRED');
  await agent.get('/api/v1/users').expect(403);

  // Allowed: profile page and what the setup needs
  await agent.get('/profile').expect(200);
  await agent.get('/api/v1/profile/2fa').expect(200);
  await agent.get('/api/v1/settings/profile').expect(200);
  await agent.get('/api/v1/ping').expect(200);
  const st = await agent.get('/api/v1/profile/2fa').expect(200);
  assert.equal(st.body.data.required, true);

  // After setting it up, everything opens again
  await enable2fa(agent, csrf);
  await agent.get('/dashboard').expect(200);
  await agent.get('/api/v1/peers').expect(200);

  // logout still works while blocked (another admin without 2FA)
  await agent.post('/api/v1/users').set('x-csrf-token', csrf)
    .send({ username: 'second', role: 'admin', password: 'Second!Pass123' }).expect(201);
  const { a, location } = await loginAs('second', 'Second!Pass123');
  assert.equal(location, '/dashboard');
  const r = await a.get('/dashboard').expect(302);
  assert.equal(r.headers.location, '/profile?setup2fa=1');
  const c2 = await pageCsrf(a);
  await a.post('/logout').type('form').send({ _csrf: c2 }).expect(302);
  await a.get('/api/v1/ping').expect(401);
});

test('require_2fa: disable is refused with 409 TWO_FA_REQUIRED', async () => {
  const secret = await enable2fa(agent, csrf);
  await setRequire(true);
  const res = await agent.post('/api/v1/profile/2fa/disable').set('x-csrf-token', csrf)
    .send({ password: 'TestPass123!', code: totp(secret, 30) }).expect(409);
  assert.equal(res.body.code, 'TWO_FA_REQUIRED');
  await setRequire(false);
  await agent.post('/api/v1/profile/2fa/disable').set('x-csrf-token', csrf)
    .send({ password: 'TestPass123!', code: totp(secret, 30) }).expect(200);
});

test('admin can reset another user\'s 2FA (activity log user_2fa_reset), not their own', async () => {
  const created = await agent.post('/api/v1/users').set('x-csrf-token', csrf)
    .send({ username: 'colleague', role: 'admin', password: 'Colleague!Pass1' }).expect(201);
  const otherId = created.body.user.id;

  const { a } = await loginAs('colleague', 'Colleague!Pass1');
  const c2 = await pageCsrf(a, '/dashboard');
  await enable2fa(a, c2);

  let list = await agent.get('/api/v1/users').expect(200);
  let other = list.body.users.find((u) => u.id === otherId);
  assert.equal(other.totp_enabled, 1);
  assert.equal(other.totp_secret_enc, undefined);
  assert.equal(other.recovery_codes, undefined);
  const detail = await agent.get(`/api/v1/users/${otherId}`).expect(200);
  assert.equal(detail.body.user.totp_enabled, 1);
  assert.equal(detail.body.user.recovery_codes, undefined);

  const reset = await agent.delete(`/api/v1/users/${otherId}/2fa`).set('x-csrf-token', csrf).expect(200);
  assert.equal(reset.body.user.totp_enabled, 0);
  list = await agent.get('/api/v1/users').expect(200);
  other = list.body.users.find((u) => u.id === otherId);
  assert.equal(other.totp_enabled, 0);

  const { getDb } = require('../src/db/connection');
  const row = getDb().prepare('SELECT totp_secret_enc, recovery_codes FROM users WHERE id = ?').get(otherId);
  assert.equal(row.totp_secret_enc, null);
  assert.equal(row.recovery_codes, null);
  const log = getDb().prepare("SELECT message, details FROM activity_log WHERE event_type = 'user_2fa_reset' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log && log.message.includes('colleague'));

  // the colleague now logs in with the password only
  const again = await loginAs('colleague', 'Colleague!Pass1');
  assert.equal(again.location, '/dashboard');

  const me = getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get();
  await agent.delete(`/api/v1/users/${me.id}/2fa`).set('x-csrf-token', csrf).expect(400);
  await agent.delete('/api/v1/users/999999/2fa').set('x-csrf-token', csrf).expect(404);
});

test('profile 2FA endpoints are session-only (no API tokens)', async () => {
  const tokens = require('../src/services/tokens');
  const { rawToken } = tokens.create({ name: 't', scopes: ['settings', 'read-only'] }, '127.0.0.1');
  const anon = supertest(app);
  const r = await anon.post('/api/v1/profile/2fa/setup').set('Authorization', `Bearer ${rawToken}`).send({});
  assert.equal(r.status, 403);
  const s = await anon.get('/api/v1/profile/2fa').set('Authorization', `Bearer ${rawToken}`);
  assert.equal(s.status, 403);
  // and the reset endpoint is admin-session only like the rest of /users
  const d = await anon.delete('/api/v1/users/1/2fa').set('Authorization', `Bearer ${rawToken}`);
  assert.equal(d.status, 403);
});

test('token and gateway auth are not affected by require_2fa', async () => {
  await setRequire(true);
  const tokens = require('../src/services/tokens');
  const { rawToken } = tokens.create({ name: 'ro', scopes: ['read-only'] }, '127.0.0.1');
  const anon = supertest(app);
  // A token request carries no session → the policy never engages.
  const r = await anon.get('/api/v1/dashboard/stats').set('Authorization', `Bearer ${rawToken}`);
  assert.notEqual(r.status, 403, `token request must not be blocked by 2FA policy (got ${r.status})`);
  // Gateway API: own auth, no session → 401 from its own guard, not a redirect
  const g = await anon.get('/api/v1/gateway/config');
  assert.ok([401, 403, 404].includes(g.status));
  assert.notEqual(g.headers.location, '/profile?setup2fa=1');
});

test('non-admin sessions are not subject to require_2fa', async () => {
  await setRequire(true);
  const { getDb } = require('../src/db/connection');
  // Only admin accounts are gated: flip the seeded admin to role=user for the check.
  await enable2fa(agent, csrf); // keep an admin with 2FA so the check below is about the role
  const argon2 = require('argon2');
  const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
  getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('viewer', ?, 'user')").run(hash);
  const { a, location } = await loginAs('viewer', 'Plain!Pass1234');
  assert.equal(location, '/dashboard');
  await a.get('/dashboard').expect(200);
});
