'use strict';

// Sign-in in the apps with the own account (docs/groups.md "Anmeldung in den
// Apps", services/appSignin.js, routes/api/client/signin.js, routes/oidc.js
// ?client=app): the methods, the password path (local, directory, 2FA,
// lockout, disabled, own devices not allowed, licence limit, rate limit), the
// browser flow with "Mit Microsoft anmelden" against a fake Entra ID
// (redirect URI allow-list, handoff bound to the PKCE challenge, single use,
// TOTP step) and the directory switch "Geräte selbst einrichten erlauben".

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const argon2 = require('argon2');
const OTPAuth = require('otpauth');
const { setup, teardown } = require('./helpers/setup');
const config = require('../config/default');

let app, agent, csrf;
before(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
after(() => {
  require('../src/services/directory/adapters')._setFactory(null);
  require('../src/services/directory/entra')._setFetch(null);
  teardown();
});

function db() { return require('../src/db/connection').getDb(); }
const store = () => require('../src/services/directory/store');
const svc = () => require('../src/services/appSignin');
const PW = 'Plain!Pass1234';

async function makeUser(username, { role = 'user', selfEnroll = 1, enabled = 1, password = PW, mustChange = 0 } = {}) {
  const hash = password ? await argon2.hash(password, require('../src/utils/argon2Options')) : '!';
  return Number(db().prepare(`INSERT INTO users (username, password_hash, role, enabled, self_service_enabled, self_enroll_enabled, must_change_password)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(username, hash, role, enabled, selfEnroll, mustChange).lastInsertRowid);
}
function enableTotp(userId) {
  const { secret } = require('../src/services/adminTwoFactor').beginSetup(userId);
  db().prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
  return secret;
}
function totp(secret) {
  db().prepare('DELETE FROM admin_totp_used').run();
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}
const signin = (body) => supertest(app).post('/api/v1/client/signin/password').send(body);
const handoff = (body) => supertest(app).post('/api/v1/client/signin/handoff').send(body);
function activityRows(type) { return db().prepare('SELECT message, details FROM activity_log WHERE event_type = ? ORDER BY id').all(type); }
function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

beforeEach(() => {
  db().prepare('DELETE FROM login_attempts').run();
  svc()._reset();
});

// ─── methods ──────────────────────────────────────────────────────────────

describe('GET /api/v1/client/signin', () => {
  it('answers without a token: password always, Microsoft and the hint from the directories', async () => {
    const r0 = await supertest(app).get('/api/v1/client/signin').expect(200);
    assert.deepEqual(r0.body, { ok: true, version: 1, password: { enabled: true, hint: null }, microsoft: [] });
    assert.equal(r0.headers['cache-control'], 'no-store');
    const ad = store().create({ kind: 'ad', name: 'corp.local', secret: 'x', loginEnabled: true, config: { host: 'dc01.corp.local', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' } });
    const en = store().create({ kind: 'entra', name: 'Firma', secret: 'y', loginEnabled: true, config: { tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47', clientId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' } });
    const off = store().create({ kind: 'entra', name: 'Aus', secret: 'y', loginEnabled: false, config: { tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47', clientId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' } });
    const r = await supertest(app).get('/api/v1/client/signin').expect(200);
    assert.match(r.body.password.hint, /corp\.local.*Windows/);
    assert.deepEqual(r.body.microsoft.map((m) => m.id), [en.id]);
    assert.match(r.body.microsoft[0].label, /^(Mit Microsoft anmelden|Sign in with Microsoft)$/);
    const de = await supertest(app).get('/api/v1/client/signin').set('Accept-Language', 'de').expect(200);
    assert.equal(de.body.microsoft[0].label, 'Mit Microsoft anmelden');
    assert.equal(de.body.password.hint, 'Firmenkonto (corp.local): mit dem Windows-Passwort anmelden');
    for (const d of [ad, en, off]) store().remove(d.id, { confirmName: d.name });
  });
});

// ─── password ─────────────────────────────────────────────────────────────

describe('POST /api/v1/client/signin/password', () => {
  let lena;
  before(async () => { lena = await makeUser('as-lena'); });

  it('a member allowed to set up own devices gets a setup code the app redeems as before', async () => {
    const r = await signin({ username: 'as-lena', password: PW, hostname: 'Pixel', platform: 'android' }).expect(200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.code, /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/);
    assert.ok(!Number.isNaN(Date.parse(r.body.expiresAt)) && /T.*Z$/.test(r.body.expiresAt), 'ISO time');
    const row = db().prepare('SELECT user_id, scopes FROM client_enrollment_codes WHERE code_hash = ?').get(crypto.createHash('sha256').update(r.body.code).digest('hex'));
    assert.equal(row.user_id, lena);
    assert.deepEqual(JSON.parse(row.scopes).sort(), [...require('../src/services/clientEnrollment').DEFAULT_SCOPES].sort());
    const red = await supertest(app).post('/api/v1/client/enroll').send({ code: r.body.code, hostname: 'Pixel', platform: 'android', clientVersion: '2.0.0' }).expect(200);
    assert.ok(red.body.token && red.body.config);
    const log = activityRows('app_signin').pop();
    assert.match(log.message, /as-lena/);
    assert.equal(JSON.parse(log.details).platform, 'android');
    // neither the password nor the code is logged
    const all = JSON.stringify(db().prepare('SELECT message, details FROM activity_log').all());
    assert.equal(all.includes(PW), false);
    assert.equal(all.includes(r.body.code), false);
  });

  it('unknown account, wrong password and missing fields get the same answer and count for the lockout', async () => {
    for (const body of [{ username: 'as-nobody', password: PW }, { username: 'as-lena', password: 'wrong' }, { username: 'as-lena' }, {}]) {
      const r = await signin(body);
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.deepEqual(r.body, { ok: false, error: 'invalid_credentials' });
    }
    const ids = db().prepare('SELECT identifier FROM login_attempts').all().map((x) => x.identifier).sort();
    assert.deepEqual(ids, ['as-lena', 'as-nobody']);
    assert.ok(activityRows('app_signin_failed').some((x) => /as-nobody/.test(x.message)));
  });

  it('locked: 429 with retryAfter, even with the right password', async () => {
    for (let i = 0; i < 10; i++) require('../src/services/lockout').recordFailedAttempt('as-lena', 'admin', '127.0.0.1');
    const r = await signin({ username: 'as-lena', password: PW });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'locked');
    assert.ok(Number.isInteger(r.body.retryAfter) && r.body.retryAfter > 0);
  });

  it('enroll_not_allowed without the permission; admins are always allowed', async () => {
    await makeUser('as-noenroll', { selfEnroll: 0 });
    const r = await signin({ username: 'as-noenroll', password: PW });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, error: 'enroll_not_allowed' });
    const ok = await signin({ username: 'admin', password: 'TestPass123!' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('an admin without 2FA gets no device while two-factor login is required for admins', async () => {
    const settings = require('../src/services/settings');
    settings.set('security.require_2fa', 'true');
    try {
      const r = await signin({ username: 'admin', password: 'TestPass123!' });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'enroll_not_allowed');
    } finally { settings.set('security.require_2fa', 'false'); }
  });

  it('user_disabled only after the right password', async () => {
    await makeUser('as-off', { enabled: 0 });
    assert.equal((await signin({ username: 'as-off', password: 'nope' })).body.error, 'invalid_credentials');
    const r = await signin({ username: 'as-off', password: PW });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'user_disabled');
  });

  it('passkey-only accounts (no password) get invalid_credentials', async () => {
    await makeUser('as-passkey', { password: null });
    assert.equal((await signin({ username: 'as-passkey', password: '!' })).body.error, 'invalid_credentials');
  });

  it('an account that must set a new password first is refused', async () => {
    await makeUser('as-mustchange', { mustChange: 1 });
    const r = await signin({ username: 'as-mustchange', password: PW });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'password_change_required');
  });

  it('2FA: totp_required, totp_invalid, then the code', async () => {
    const id = await makeUser('as-tf');
    const secret = enableTotp(id);
    const a = await signin({ username: 'as-tf', password: PW });
    assert.equal(a.status, 401);
    assert.equal(a.body.error, 'totp_required');
    const b = await signin({ username: 'as-tf', password: PW, totp: '000000' === totp(secret) ? '111111' : '000000' });
    assert.equal(b.status, 401);
    assert.equal(b.body.error, 'totp_invalid');
    assert.ok(db().prepare('SELECT 1 FROM login_attempts WHERE identifier = ?').get(`admin_2fa:${id}`), 'counted for the 2FA lockout');
    const c = await signin({ username: 'as-tf', password: PW, totp: totp(secret) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    // a wrong password never reveals that 2FA is on
    assert.equal((await signin({ username: 'as-tf', password: 'x' })).body.error, 'invalid_credentials');
  });

  it('limit_reached when the licence has no room for another device', async () => {
    const license = require('../src/services/license');
    const m = mock.method(license, 'isWithinLimit', () => false);
    try {
      const r = await signin({ username: 'as-lena', password: PW });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'limit_reached');
    } finally { m.mock.restore(); }
  });

  it('directory accounts: Windows password by LDAP bind, own devices through the directory switch', async () => {
    const calls = [];
    let down = false;
    require('../src/services/directory/adapters')._setFactory(() => ({
      async authenticate(link, password) {
        calls.push(password);
        if (down) throw new Error('ETIMEDOUT');
        return password === 'Winter2026!' ? { ok: true } : { ok: false, reason: 'invalid' };
      },
    }));
    const dir = store().create({ kind: 'ad', name: 'Corp AD', secret: 'Svc!Pass', loginEnabled: true, config: { host: 'dc01.corp.local', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' } });
    assert.equal(dir.selfEnroll, false, 'off by default');
    const uid = await makeUser('as-mara', { selfEnroll: 0, password: null });
    db().prepare("INSERT INTO directory_links (user_id, directory_id, external_id, login_name, upn) VALUES (?, ?, 'guid-mara', 'mara', 'mara@corp.local')").run(uid, dir.id);

    const no = await signin({ username: 'CORP\\mara', password: 'Winter2026!' });
    assert.equal(no.body.error, 'enroll_not_allowed', 'directory switch off, no per-user permission');
    assert.equal((await signin({ username: 'mara', password: 'nope' })).body.error, 'invalid_credentials');

    // admin turns on "Geräte selbst einrichten erlauben" on the directory page
    const p = await agent.patch(`/api/v1/directories/${dir.id}`).set('X-CSRF-Token', csrf).send({ selfEnroll: true }).expect(200);
    assert.equal(p.body.directory.selfEnroll, true);
    const ok = await signin({ username: 'mara@corp.local', password: 'Winter2026!' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(JSON.parse(activityRows('app_signin').pop().details).via, 'directory');
    // the users page shows the rule
    const detail = await agent.get(`/api/v1/users/${uid}`).expect(200);
    assert.equal(detail.body.directory.selfEnroll, true);
    // the portal's "Meine Geräte" rule is the same
    const users = require('../src/services/users');
    assert.equal(users.mayEnroll(users.getById(uid)), true);
    assert.equal(calls.includes(''), false);

    down = true;
    const r = await signin({ username: 'mara', password: 'Winter2026!' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'directory_unavailable');
    down = false;

    store().update(dir.id, { selfEnroll: false });
    assert.equal((await signin({ username: 'mara', password: 'Winter2026!' })).body.error, 'enroll_not_allowed');
    store().remove(dir.id, { confirmName: 'Corp AD' });
  });

  it('rate limit: 429 rate_limited with retryAfter', async () => {
    const before = config.auth.rateLimitLogin;
    config.auth.rateLimitLogin = 1;
    try {
      let r;
      for (let i = 0; i < 3; i++) r = await signin({ username: 'as-nobody', password: 'x' });
      assert.equal(r.status, 429);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error, 'rate_limited');
      assert.ok(r.body.retryAfter > 0);
      let h;
      for (let i = 0; i < 5; i++) h = await handoff({ handoff: 'x', verifier: 'y' });
      assert.equal(h.status, 429);
      assert.equal(h.body.error, 'rate_limited');
    } finally { config.auth.rateLimitLogin = before; }
  });
});

// ─── handoff service ──────────────────────────────────────────────────────

describe('handoff', () => {
  it('single use, bound to the challenge, 2 minutes, only a hash kept', () => {
    const s = svc();
    const { verifier, challenge } = pkce();
    const raw = s.mintHandoff({ userId: 1, challenge });
    assert.equal([...s._handoffs.keys()].includes(raw), false, 'stored as hash');
    assert.throws(() => s.redeemHandoff(raw, pkce().verifier), (e) => e.code === 'invalid_or_expired');
    assert.throws(() => s.redeemHandoff(raw, verifier), (e) => e.code === 'invalid_or_expired', 'spent by the wrong attempt');
    const raw2 = s.mintHandoff({ userId: 1, challenge });
    assert.throws(() => s.redeemHandoff(raw2, verifier, { now: Date.now() + s.HANDOFF_TTL_MS + 1000 }), (e) => e.code === 'invalid_or_expired');
    const raw3 = s.mintHandoff({ userId: 7, challenge });
    assert.deepEqual(s.redeemHandoff(raw3, verifier), { userId: 7, directoryId: null });
    assert.throws(() => s.redeemHandoff(raw3, verifier), (e) => e.code === 'invalid_or_expired', 'replay');
  });

  it('redirect URIs: only the app scheme and loopback /signin', () => {
    const s = svc();
    for (const ok of ['gatecontrol://signin', 'http://127.0.0.1:49152/signin', 'http://localhost:8080/signin', 'http://127.0.0.1:65535/signin']) assert.equal(s.checkRedirectUri(ok), ok, ok);
    for (const bad of ['gatecontrol://signin/', 'gatecontrol://enroll', 'https://127.0.0.1:1/signin', 'http://127.0.0.1/signin', 'http://127.0.0.1:0/signin',
      'http://127.0.0.1:65536/signin', 'http://127.0.0.1:080/signin', 'http://127.0.0.2:80/signin', 'http://evil.example:80/signin',
      'http://127.0.0.1:80/signin?x=1', 'http://127.0.0.1:80/signin#a', 'http://127.0.0.1:80@evil/signin', '', null, 42]) {
      assert.equal(s.checkRedirectUri(bad), null, String(bad));
    }
  });
});

// ─── Microsoft in the browser → handoff ───────────────────────────────────

describe('"Mit Microsoft anmelden" for the app (?client=app)', () => {
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const CLIENT = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const OID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
  const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  let idp, dirId, userId;

  function sign(claims) {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  }
  function claimsFor(nonce, extra) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: ISSUER, aud: CLIENT, tid: TENANT, oid: OID, nonce, iat: now, nbf: now, exp: now + 3600, ...(extra || {}) };
  }
  function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  async function fakeFetch(url, init = {}) {
    const s = String(url);
    if (s.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer: ISSUER, authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`, token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys` });
    }
    if (s.endsWith('/discovery/v2.0/keys')) return json({ keys: [jwk] });
    if (s.endsWith('/oauth2/v2.0/token')) {
      const body = new URLSearchParams(init.body);
      if (crypto.createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== idp.challenge) return json({ error: 'invalid_grant' }, 400);
      return json({ id_token: idp.makeToken(idp.nonce), token_type: 'Bearer' });
    }
    return json({ error: 'unexpected' }, 404);
  }

  before(async () => {
    dirId = store().create({ kind: 'entra', name: 'Entra', secret: 'Entra-Secret-1', loginEnabled: true, config: { tenantId: TENANT, clientId: CLIENT } }).id;
    userId = await makeUser('as-mira', { password: null });
    db().prepare('INSERT INTO directory_links (user_id, directory_id, external_id, login_name, upn) VALUES (?, ?, ?, ?, ?)').run(userId, dirId, OID, 'mira@firma.de', 'mira@firma.de');
  });
  beforeEach(() => {
    idp = { makeToken: (nonce) => sign(claimsFor(nonce)) };
    require('../src/services/directory/entra')._setFetch(fakeFetch);
    require('../src/services/directory/oidc')._reset();
    db().prepare('UPDATE users SET enabled = 1, totp_enabled = 0, self_enroll_enabled = 1 WHERE id = ?').run(userId);
  });

  function startUrl(p) {
    const q = new URLSearchParams({ client: 'app', redirect_uri: 'gatecontrol://signin', state: 'app-state-1', challenge: p.challenge, ...(p.extra || {}) });
    return `/auth/oidc/${dirId}/start?${q}`;
  }
  async function start(a, p) {
    const r = await a.get(startUrl(p)).expect(302);
    const loc = new URL(r.headers.location);
    assert.equal(loc.host, 'login.microsoftonline.com');
    idp.nonce = loc.searchParams.get('nonce');
    idp.challenge = loc.searchParams.get('code_challenge');
    assert.notEqual(idp.challenge, p.challenge, 'Microsoft sees GateControl\'s own PKCE, never the app\'s');
    return loc.searchParams.get('state');
  }
  const callback = (a, state, extra = '') => a.get(`/auth/oidc/${dirId}/callback?code=auth-code-1&state=${encodeURIComponent(state)}${extra}`);
  function target(res) {
    const m = res.text.match(/http-equiv="refresh" content="0;url=([^"]+)"/);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  }

  it('signs in, redirects to the app with a handoff and the state; the handoff gives a setup code once', async () => {
    const p = pkce();
    const a = supertest.agent(app);
    const state = await start(a, p);
    const r = await callback(a, state);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const to = new URL(target(r));
    assert.equal(`${to.protocol}//${to.host}${to.pathname}`, 'gatecontrol://signin');
    assert.equal(to.searchParams.get('state'), 'app-state-1');
    const h = to.searchParams.get('handoff');
    assert.ok(h && h.length >= 43);
    assert.match(r.text, /data-app-return/, 'visible „Zurück zur App“ button');
    assert.match(r.text, /Zurück zur App|Back to the app/);
    // no web session was created
    assert.equal((await a.get('/profile')).status, 302);

    assert.equal((await handoff({ handoff: h, verifier: pkce().verifier })).body.error, 'invalid_or_expired', 'wrong verifier');
    const state2 = await start(a, p);
    const r2 = await callback(a, state2);
    const h2 = new URL(target(r2)).searchParams.get('handoff');
    const ok = await handoff({ handoff: h2, verifier: p.verifier });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.code, /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/);
    assert.ok(Date.parse(ok.body.expiresAt));
    const replay = await handoff({ handoff: h2, verifier: p.verifier });
    assert.equal(replay.status, 400);
    assert.deepEqual(replay.body, { ok: false, error: 'invalid_or_expired' });
    assert.equal(JSON.parse(activityRows('app_signin').pop().details).method, 'microsoft');
  });

  it('works from a browser that has a web session, and with the loopback redirect of Windows', async () => {
    const p = pkce();
    const state = await start(agent, { ...p, extra: { redirect_uri: 'http://127.0.0.1:53111/signin' } });
    const r = await callback(agent, state);
    const to = new URL(target(r));
    assert.equal(to.origin + to.pathname, 'http://127.0.0.1:53111/signin');
    assert.equal((await agent.get('/api/v1/groups')).status, 200, 'the admin session is untouched');
  });

  it('a wrong redirect_uri, state or challenge is a 400 page — nothing goes to Microsoft', async () => {
    const p = pkce();
    for (const extra of [{ redirect_uri: 'https://evil.example/signin' }, { redirect_uri: 'gatecontrol://other' }, { redirect_uri: 'http://127.0.0.1:80/signin/x' },
      { state: '' }, { state: 'a b' }, { challenge: 'short' }]) {
      const r = await supertest(app).get(startUrl({ ...p, extra }));
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.doesNotMatch(r.text, /http-equiv="refresh"/);
      assert.doesNotMatch(r.text, /evil\.example/);
    }
  });

  it('errors go back to the app: not_linked, user_disabled, enroll_not_allowed, access_denied', async () => {
    const run = async (prep, extraQuery = '') => {
      const a = supertest.agent(app);
      const state = await start(a, pkce());
      if (prep) prep();
      const r = await callback(a, state, extraQuery);
      const to = new URL(target(r));
      assert.equal(to.searchParams.get('state'), 'app-state-1');
      assert.equal(to.searchParams.get('handoff'), null);
      return to.searchParams.get('error');
    };
    idp.makeToken = (n) => sign(claimsFor(n, { oid: '11111111-1111-4111-8111-111111111111' }));
    assert.equal(await run(), 'not_linked');
    idp.makeToken = (n) => sign(claimsFor(n));
    assert.equal(await run(() => db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(userId)), 'user_disabled');
    db().prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(userId);
    assert.equal(await run(() => db().prepare('UPDATE users SET self_enroll_enabled = 0 WHERE id = ?').run(userId)), 'enroll_not_allowed');
    db().prepare('UPDATE users SET self_enroll_enabled = 1 WHERE id = ?').run(userId);
    assert.equal(await run(null, '&error=access_denied'), 'access_denied');
    assert.ok(activityRows('app_signin_failed').some((x) => /enroll_not_allowed/.test(x.message)));
  });

  it('with GateControl 2FA the TOTP step follows in the browser, then the handoff', async () => {
    const secret = enableTotp(userId);
    const p = pkce();
    const a = supertest.agent(app);
    const state = await start(a, p);
    const r = await callback(a, state);
    assert.equal(target(r), '/auth/app/2fa');
    assert.ok(r.headers['set-cookie'].some((c) => /^gc\.app2fa=/.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)));
    const page = await a.get('/auth/app/2fa').expect(200);
    assert.match(page.text, /action="\/auth\/app\/2fa"/);
    assert.doesNotMatch(page.text, /href="\/login"/, 'no way to the web login');
    const pageCsrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const bad = await a.post('/auth/app/2fa').type('form').send({ _csrf: pageCsrf, code: '000000' === totp(secret) ? '111111' : '000000' }).expect(200);
    assert.match(bad.text, /action="\/auth\/app\/2fa"/, 'asked again');
    const good = await a.post('/auth/app/2fa').type('form').send({ _csrf: pageCsrf, code: totp(secret) }).expect(200);
    const to = new URL(target(good));
    assert.equal(to.searchParams.get('state'), 'app-state-1');
    const ok = await handoff({ handoff: to.searchParams.get('handoff'), verifier: p.verifier });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // the pending step is gone
    assert.equal((await a.get('/auth/app/2fa')).status, 400);
    // without the cookie (another browser) there is no step to answer
    assert.equal((await supertest(app).get('/auth/app/2fa')).status, 400);
  });
});

describe('migration 113 (directory_self_enroll)', () => {
  it('adds directories.self_enroll, off by default', () => {
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 113);
    assert.equal(m.name, 'directory_self_enroll');
    assert.match(m.sql, /ALTER TABLE directories ADD COLUMN self_enroll INTEGER NOT NULL DEFAULT 0/);
    assert.equal(m.detect(db()), true);
  });
});
