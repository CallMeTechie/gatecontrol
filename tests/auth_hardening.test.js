'use strict';

// Security hardening (fix/auth-hardening):
//   1. `read-only` tokens no longer reach secret-returning GET endpoints.
//   2. Disabled users cannot log in; sessions of disabled/deleted users are
//      rejected; disable + role change destroy the user's sessions.
//   3. Non-admin sessions are confined to their own profile endpoints.
//   4. Post-login redirects share one open-redirect guard.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const argon2 = require('argon2');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf;
before(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
after(() => teardown());

function db() { return require('../src/db/connection').getDb(); }

// A member ('user') signs in only with "Mein Bereich" (self_service_enabled).
async function createLoginUser(username, role = 'user', password = 'Plain!Pass1234') {
  const hash = await argon2.hash(password, require('../src/utils/argon2Options'));
  const id = db().prepare('INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES (?, ?, ?, ?)')
    .run(username, hash, role, role === 'user' ? 1 : 0).lastInsertRowid;
  return Number(id);
}

async function loginAs(username, password = 'Plain!Pass1234') {
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

function sessionsOf(userId) {
  return db().prepare("SELECT COUNT(*) AS c FROM sessions WHERE json_extract(data, '$.userId') = ?").get(userId).c;
}

// ─── 1. read-only scope ──────────────────────────────────────────────

describe('read-only token scope excludes secret endpoints', () => {
  const tokens = require('../src/services/tokens');
  let peerId, rdpId, readOnly, readOnlyPeers, fullAccess;

  before(async () => {
    const res = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf)
      .send({ name: 'secret-peer' }).expect(201);
    peerId = res.body.peer.id;
    const rdp = await require('../src/services/rdp').create({
      name: 'secret-rdp', host: '10.0.0.9', protocol: 'rdp', port: 3389, username: 'u', password: 'p',
    });
    rdpId = rdp.id;
    readOnly = tokens.create({ name: 'ro', scopes: ['read-only'] }, '127.0.0.1').rawToken;
    readOnlyPeers = tokens.create({ name: 'ro+peers', scopes: ['read-only', 'peers'] }, '127.0.0.1').rawToken;
    fullAccess = tokens.create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
  });

  function get(path, token) {
    return supertest(app).get(path).set('Authorization', `Bearer ${token}`);
  }

  it('denies peer config, peer QR, RDP credentials and webhooks', async () => {
    for (const p of [
      `/api/v1/peers/${peerId}/config`,
      `/api/v1/peers/${peerId}/config?download=1`,
      `/api/v1/peers/${peerId}/qr`,
      `/api/v1/PEERS/${peerId}/Config/`,
      `/api/v1/rdp/${rdpId}/credentials`,
      `/api/v1/client/rdp/${rdpId}/connect`,
      '/api/v1/webhooks',
      '/api/v1/settings/backup',
      '/api/v1/tokens',
    ]) {
      const res = await get(p, readOnly);
      assert.equal(res.status, 403, `${p} must be denied for read-only`);
      assert.ok(!/PrivateKey/.test(res.text), `${p} leaked a private key`);
    }
  });

  it('still allows ordinary GETs', async () => {
    await get('/api/v1/peers', readOnly).expect(200);
    await get(`/api/v1/peers/${peerId}`, readOnly).expect(200);
    await get('/api/v1/dashboard/stats', readOnly).expect(200);
    await get('/api/v1/rdp', readOnly).expect(200);
  });

  it('the resource scope or full-access still reach the secret endpoints', async () => {
    const r1 = await get(`/api/v1/peers/${peerId}/config`, readOnlyPeers).expect(200);
    assert.match(r1.body.config, /PrivateKey/);
    await get(`/api/v1/peers/${peerId}/qr`, readOnlyPeers).expect(200);
    await get(`/api/v1/rdp/${rdpId}/credentials`, readOnlyPeers).expect(403);
    await get(`/api/v1/rdp/${rdpId}/credentials`, fullAccess).expect(200);
    await get(`/api/v1/peers/${peerId}/config`, fullAccess).expect(200);
  });

  it('checkScope unit cases', () => {
    assert.equal(tokens.checkScope(['read-only'], '/api/v1/peers/1/config', 'GET'), false);
    assert.equal(tokens.checkScope(['read-only'], '/api/v1/peers//1/qr/', 'GET'), false);
    assert.equal(tokens.checkScope(['read-only'], '/api/v1/rdp/1/credentials', 'GET'), false);
    assert.equal(tokens.checkScope(['read-only'], '/api/v1/peers/1', 'GET'), true);
    assert.equal(tokens.checkScope(['read-only'], '/api/v1/peers/1/traffic', 'GET'), true);
    assert.equal(tokens.checkScope(['read-only'], '/api/v1/client/config', 'GET'), true);
    assert.equal(tokens.checkScope(['peers'], '/api/v1/peers/1/config', 'GET'), true);
    assert.equal(tokens.checkScope(['client:rdp'], '/api/v1/client/rdp/1/connect', 'GET'), true);
    assert.equal(tokens.checkScope(['full-access'], '/api/v1/rdp/1/credentials', 'GET'), true);
  });
});

// ─── 2. disabled users ───────────────────────────────────────────────

describe('disabled users and session revocation', () => {
  it('a disabled user cannot log in (same error as a wrong password)', async () => {
    const id = await createLoginUser('disabled-admin', 'admin');
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(id);
    const { a, location } = await loginAs('disabled-admin');
    assert.equal(location, '/login');
    const page = await a.get('/login').expect(200);
    const wrong = await loginAs('disabled-admin', 'Wrong!Pass1234');
    const wrongPage = await wrong.a.get('/login').expect(200);
    const flash = (t) => (t.match(/class="login-error"[\s\S]*?<span>([^<]+)<\/span>/) || [])[1];
    assert.ok(flash(page.text), 'disabled login must show an error');
    assert.equal(flash(page.text), flash(wrongPage.text));
    await a.get('/api/v1/ping').expect(401);
  });

  it('an existing session is rejected once the user is disabled', async () => {
    const id = await createLoginUser('soon-disabled', 'admin');
    const { a } = await loginAs('soon-disabled');
    await a.get('/api/v1/peers').expect(200);
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(id);
    await a.get('/api/v1/peers').expect(401);
    const page = await a.get('/dashboard');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/login');
    assert.equal(sessionsOf(id), 0, 'session must be destroyed');
  });

  it('an existing session is rejected once the user is deleted', async () => {
    const id = await createLoginUser('soon-gone', 'admin');
    const { a } = await loginAs('soon-gone');
    db().prepare('DELETE FROM users WHERE id = ?').run(id);
    await a.get('/api/v1/peers').expect(401);
  });

  it('PUT /users/:id/toggle (disable) destroys all sessions of that user', async () => {
    const id = await createLoginUser('toggle-me', 'admin');
    const s1 = await loginAs('toggle-me');
    const s2 = await loginAs('toggle-me');
    assert.equal(sessionsOf(id), 2);
    await agent.put(`/api/v1/users/${id}/toggle`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(sessionsOf(id), 0);
    await s1.a.get('/api/v1/ping').expect(401);
    await s2.a.get('/api/v1/ping').expect(401);
  });

  it('a role change destroys all sessions of that user', async () => {
    const id = await createLoginUser('demote-me', 'admin');
    const s = await loginAs('demote-me');
    await s.a.get('/api/v1/peers').expect(200);
    await agent.patch(`/api/v1/users/${id}`).set('X-CSRF-Token', csrf).send({ role: 'user' }).expect(200);
    assert.equal(sessionsOf(id), 0);
    await s.a.get('/api/v1/peers').expect(401);
  });

  it('a non-role update keeps the sessions', async () => {
    const id = await createLoginUser('rename-me', 'admin');
    const s = await loginAs('rename-me');
    await agent.patch(`/api/v1/users/${id}`).set('X-CSRF-Token', csrf).send({ displayName: 'Renamed' }).expect(200);
    assert.equal(sessionsOf(id), 1);
    await s.a.get('/api/v1/peers').expect(200);
  });

  it('tokens of a disabled user stop working', async () => {
    const tokens = require('../src/services/tokens');
    const id = await createLoginUser('token-owner', 'admin');
    const raw = tokens.create({ name: 'owned', scopes: ['read-only'], userId: id }, '127.0.0.1').rawToken;
    await supertest(app).get('/api/v1/peers').set('Authorization', `Bearer ${raw}`).expect(200);
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(id);
    const res = await supertest(app).get('/api/v1/peers').set('Authorization', `Bearer ${raw}`);
    assert.equal(res.status, 403);
  });
});

// ─── 3. admin API role gate ──────────────────────────────────────────

describe('non-admin sessions are denied on the admin API', () => {
  let a, userCsrf;
  before(async () => {
    await createLoginUser('plain-user', 'user');
    ({ a } = await loginAs('plain-user'));
    userCsrf = await pageCsrf(a);
  });

  it('admin endpoints answer 403', async () => {
    for (const p of [
      '/api/v1/peers', '/api/v1/routes', '/api/v1/tokens', '/api/v1/users',
      '/api/v1/settings/app', '/api/v1/rdp', '/api/v1/license', '/api/v1/dashboard/stats',
      '/api/v1/PEERS', '/api/v1/client/config?peerId=1',
    ]) {
      const res = await a.get(p);
      assert.equal(res.status, 403, `${p} must be admin-only`);
    }
    await a.post('/api/v1/tokens').set('X-CSRF-Token', userCsrf)
      .send({ name: 'x', scopes: ['full-access'] }).expect(403);
    const ev = await a.get('/api/v1/events');
    assert.equal(ev.status, 403);
  });

  it('self-service endpoints stay reachable', async () => {
    await a.get('/api/v1/ping').expect(200);
    await a.get('/api/v1/profile/2fa').expect(200);
    await a.get('/api/v1/settings/profile').expect(200);
    await a.post('/api/v1/settings/language').set('X-CSRF-Token', userCsrf).send({ language: 'en' }).expect(200);
  });

  it('admin sessions are unaffected', async () => {
    await agent.get('/api/v1/peers').expect(200);
    await agent.get('/api/v1/users').expect(200);
  });
});

// ─── 4. redirects ────────────────────────────────────────────────────

describe('safe redirect targets', () => {
  const { safeRedirect } = require('../src/routes/routeAuth');
  const { safeReturnTo } = require('../src/middleware/auth');

  it('route-auth safeRedirect rejects open-redirect tricks', () => {
    for (const bad of [
      '//evil.com', '/\\evil.com', '/\\/evil.com', '\\\\evil.com', '/\t/evil.com',
      '/\n/evil.com', '/\r\n//evil.com', '/\u0000x', 'https://evil.com', 'javascript:alert(1)',
      'evil.com', '', null, undefined, 42,
    ]) {
      assert.equal(safeRedirect(bad), '/', `must reject ${JSON.stringify(bad)}`);
    }
  });

  it('route-auth safeRedirect keeps local paths', () => {
    assert.equal(safeRedirect('/'), '/');
    assert.equal(safeRedirect('/dash?a=1&b=2'), '/dash?a=1&b=2');
    assert.equal(safeRedirect('/a/b#c'), '/a/b#c');
  });

  it('admin safeReturnTo uses the same guard plus the portal restriction', () => {
    assert.equal(safeReturnTo('/portal'), '/portal');
    assert.equal(safeReturnTo('/portal?x=1'), '/portal?x=1');
    assert.equal(safeReturnTo('/portal\\evil'), null);
    assert.equal(safeReturnTo('/portal\t'), null);
    assert.equal(safeReturnTo('//portal'), null);
    assert.equal(safeReturnTo('/dashboard'), null);
  });
});
