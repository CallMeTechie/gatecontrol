'use strict';

// Sign-in with the company account: LDAP filter escaping and GUIDs, the AD
// adapter against a fake ldapts client (TLS, escaping, search-then-bind),
// the password form for directory accounts with a fake adapter (empty
// password refused before the directory, lockout, admins always local), and
// "Mit Microsoft anmelden" (OIDC code flow with PKCE) against a fake Entra
// with locally generated RSA keys.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app;
before(async () => { ({ app } = await setup()); });
after(() => {
  require('../src/services/directory/adapters')._setFactory(null);
  require('../src/services/directory/entra')._setFetch(null);
  require('../src/services/directory/ldapConn')._setClientFactory(null);
  teardown();
});

function db() { return require('../src/db/connection').getDb(); }
const store = () => require('../src/services/directory/store');
const u = require('../src/services/directory/ldapUtil');

async function loginPage(agent) {
  const page = await agent.get('/login').expect(200);
  return { html: page.text, csrf: page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1] };
}
async function postLogin(agent, username, password) {
  const { csrf } = await loginPage(agent);
  return agent.post('/login').type('form').send({ username, password, _csrf: csrf });
}

// ─── LDAP helpers ─────────────────────────────────────────────────────────

describe('LDAP filter escaping and ids', () => {
  it('escapes every filter metacharacter (RFC 4515)', () => {
    assert.equal(u.escapeFilterValue('a*b(c)\\d\u0000e'), 'a\\2ab\\28c\\29\\5cd\\00e');
    assert.equal(u.escapeFilterValue('*)(uid=*))(|(uid=*'), '\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a');
    assert.equal(u.escapeFilterValue('Jürgen Müller'), 'Jürgen Müller');
    assert.equal(u.escapeFilterValue('line\nbreak'), 'line\\0abreak');
    assert.equal(u.escapeBinary(Buffer.from([0x00, 0x2a, 0xff])), '\\00\\2a\\ff');
  });

  it('converts AD objectGUIDs both ways', () => {
    const s = '01234567-89ab-cdef-0123-456789abcdef';
    const buf = u.guidToBuffer(s);
    assert.equal(buf.toString('hex'), '67452301ab89efcd0123456789abcdef');
    assert.equal(u.guidToString(buf), s);
    assert.throws(() => u.guidToBuffer('nope'));
  });

  it('accepts login names only in a fixed format', () => {
    for (const ok of ['lena', 'l.berg', 'CORP\\lena', 'lena@corp.local', "o'neil", 'Jürgen']) assert.equal(u.loginNameOk(ok), true, ok);
    for (const bad of ['', 'a*', 'a(b)', 'x)(uid=*', 'a b', 'a\nb', 'x'.repeat(300), 'a\\b\\c']) assert.equal(u.loginNameOk(bad), false, JSON.stringify(bad));
  });
});

// ─── AD adapter against a fake ldapts client ──────────────────────────────

describe('AD adapter (fake ldapts client)', () => {
  const GROUP_GUID = '11111111-2222-3333-4444-555555555555';
  const USER_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let calls;
  function fakeClient(options) {
    const client = {
      options,
      async startTLS(tls) { calls.push(['startTLS', tls]); },
      async bind(dn, pw) {
        calls.push(['bind', dn, pw]);
        if (dn === 'CN=Lena,OU=Staff,DC=corp,DC=local' && pw !== 'Winter2026!') {
          const err = new Error('Invalid credentials'); err.name = 'InvalidCredentialsError'; err.code = 49; throw err;
        }
      },
      async *searchPaginated(base, opts) {
        calls.push(['search', base, opts.filter]);
        if (opts.filter.includes('(objectClass=group)(objectGUID=')) {
          yield { searchEntries: [{ dn: 'CN=R&D (Köln),OU=Gruppen,DC=corp,DC=local', objectGUID: u.guidToBuffer(GROUP_GUID), cn: 'R&D (Köln)' }] };
        } else if (opts.filter.includes('memberOf:1.2.840.113556.1.4.1941:=')) {
          yield { searchEntries: [{ dn: 'CN=Lena,OU=Staff,DC=corp,DC=local', objectGUID: u.guidToBuffer(USER_GUID), sAMAccountName: 'lena', userPrincipalName: 'lena@corp.local', mail: 'lena@firma.de', displayName: 'Lena Berg', userAccountControl: '512' }] };
        } else if (opts.filter.includes('(objectClass=user)(objectGUID=')) {
          yield { searchEntries: [{ dn: 'CN=Lena,OU=Staff,DC=corp,DC=local', objectGUID: u.guidToBuffer(USER_GUID), sAMAccountName: 'lena', userAccountControl: '512' }] };
        } else {
          yield { searchEntries: [] };
        }
      },
      async unbind() { calls.push(['unbind']); },
    };
    calls.push(['new', options]);
    return client;
  }
  const dir = { kind: 'ad', config: { host: '10.8.0.20', port: 389, security: 'starttls', tlsServerName: 'dc01.corp.local', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' } };

  beforeEach(() => {
    calls = [];
    require('../src/services/directory/ldapConn')._setClientFactory(fakeClient);
  });

  it('uses StartTLS with certificate checks, resolves nested membership with an escaped DN', async () => {
    const adapter = require('../src/services/directory/ad').create(dir, { secret: 'Svc!Pass' });
    const data = await adapter.fetch([{ externalId: GROUP_GUID, name: 'R&D' }]);
    const created = calls.find((c) => c[0] === 'new')[1];
    assert.equal(created.url, 'ldap://10.8.0.20:389');
    const tls = calls.find((c) => c[0] === 'startTLS')[1];
    assert.equal(tls.rejectUnauthorized, true);
    assert.equal(tls.servername, 'dc01.corp.local');
    assert.deepEqual(calls.find((c) => c[0] === 'bind').slice(1), ['CN=svc,DC=corp,DC=local', 'Svc!Pass']);
    const memberSearch = calls.find((c) => c[0] === 'search' && c[2].includes('memberOf'));
    assert.match(memberSearch[2], /memberOf:1\.2\.840\.113556\.1\.4\.1941:=CN=R&D \\28Köln\\29,OU=Gruppen,DC=corp,DC=local/);
    assert.equal(data.groups[0].found, true);
    assert.deepEqual(data.groups[0].members, [USER_GUID]);
    assert.equal(data.users[0].loginName, 'lena');
    assert.equal(data.users[0].enabled, true);
    assert.ok(calls.some((c) => c[0] === 'unbind'));
  });

  it('checks a password by search-then-bind; empty password never opens a connection', async () => {
    const adapter = require('../src/services/directory/ad').create(dir, { secret: 'Svc!Pass' });
    const link = { external_id: USER_GUID };
    assert.deepEqual(await adapter.authenticate(link, ''), { ok: false, reason: 'invalid' });
    assert.equal(calls.length, 0);
    const ok = await adapter.authenticate(link, 'Winter2026!');
    assert.equal(ok.ok, true);
    const binds = calls.filter((c) => c[0] === 'bind').map((c) => c[1]);
    assert.deepEqual(binds, ['CN=svc,DC=corp,DC=local', 'CN=Lena,OU=Staff,DC=corp,DC=local']);
    calls = [];
    assert.deepEqual(await adapter.authenticate(link, 'wrong'), { ok: false, reason: 'invalid' });
  });

  it('refuses plain LDAP', () => {
    const conn = require('../src/services/directory/ldapConn');
    assert.throws(() => conn.urlFor({ host: 'dc', security: 'none' }), (e) => e.code === 'INVALID_SECURITY');
    assert.equal(conn.urlFor({ host: 'dc01.corp.local' }), 'ldaps://dc01.corp.local:636');
    assert.equal(conn.tlsOptionsFor({ host: 'dc01.corp.local' }).rejectUnauthorized, true);
  });
});

// ─── password form for directory accounts ─────────────────────────────────

describe('password login of directory accounts (LDAP bind)', () => {
  let adapterCalls;
  let unreachable;
  let dirAd;
  let lenaId;
  before(async () => {
    dirAd = store().create({
      kind: 'ad', name: 'Corp AD', secret: 'Svc!Pass', loginEnabled: true,
      config: { host: 'dc01.corp.local', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' },
    });
    lenaId = Number(db().prepare("INSERT INTO users (username, password_hash, role, email, self_service_enabled, display_name) VALUES ('lena', '!', 'user', 'lena@firma.de', 1, 'Lena Berg')").run().lastInsertRowid);
    db().prepare("INSERT INTO directory_links (user_id, directory_id, external_id, login_name, upn, email) VALUES (?, ?, 'guid-lena', 'lena', 'lena@corp.local', 'lena@firma.de')").run(lenaId, dirAd.id);
  });
  beforeEach(() => {
    adapterCalls = [];
    unreachable = false;
    require('../src/services/directory/adapters')._setFactory(() => ({
      async authenticate(link, password) {
        adapterCalls.push({ ext: link.external_id, password });
        if (unreachable) throw new Error('connect ETIMEDOUT');
        return password === 'Winter2026!' ? { ok: true } : { ok: false, reason: 'invalid' };
      },
    }));
    db().prepare('DELETE FROM login_attempts').run();
  });

  it('signs in with the directory password — by login name, DOMAIN\\name, UPN or e-mail', async () => {
    for (const name of ['lena', 'CORP\\lena', 'lena@corp.local', 'LENA@FIRMA.DE']) {
      const a = supertest.agent(app);
      const r = await postLogin(a, name, 'Winter2026!');
      assert.equal(r.status, 302, name);
      assert.equal(r.headers.location, '/profile', name);
      const prof = await a.get('/profile');
      assert.equal(prof.status, 200, name);
    }
    assert.ok(adapterCalls.every((c) => c.ext === 'guid-lena'));
    assert.equal(db().prepare('SELECT password_hash FROM users WHERE id = ?').get(lenaId).password_hash, '!', 'the password is never stored');
  });

  it('a wrong password is refused and counted for the lockout of the account', async () => {
    const a = supertest.agent(app);
    const r = await postLogin(a, 'lena@corp.local', 'nope');
    assert.equal(r.headers.location, '/login');
    const ids = db().prepare('SELECT identifier FROM login_attempts').all().map((x) => x.identifier).sort();
    assert.deepEqual(ids, ['lena', 'lena@corp.local']);
    // locked account → the directory is not even asked
    for (let i = 0; i < 10; i++) require('../src/services/lockout').recordFailedAttempt('lena', 'admin', '127.0.0.1');
    adapterCalls = [];
    const r2 = await postLogin(supertest.agent(app), 'lena@firma.de', 'Winter2026!');
    assert.equal(r2.headers.location, '/login');
    assert.equal(adapterCalls.length, 0);
  });

  it('refuses an empty password before contacting the directory', async () => {
    const r = await postLogin(supertest.agent(app), 'lena', '');
    assert.equal(r.headers.location, '/login');
    assert.equal(adapterCalls.length, 0);
    const auth = require('../src/services/directory/auth');
    const user = db().prepare('SELECT * FROM users WHERE id = ?').get(lenaId);
    assert.equal(await auth.verifyPassword(user, ''), 'invalid');
    assert.equal(await auth.verifyPassword(user, null), 'invalid');
    assert.equal(adapterCalls.length, 0);
  });

  it('directory down: the member gets a clear message, a local admin still signs in locally', async () => {
    unreachable = true;
    const a = supertest.agent(app);
    const r = await postLogin(a, 'lena', 'Winter2026!');
    assert.equal(r.headers.location, '/login');
    const page = await a.get('/login');
    assert.ok(/nicht erreichbar|cannot be reached/.test(page.text), 'directory unavailable message');
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM login_attempts').get().c, 0, 'not counted as a failed password');
    const admin = await postLogin(supertest.agent(app), 'admin', 'TestPass123!');
    assert.equal(admin.headers.location, '/dashboard');
  });

  it('an administrator linked to the directory uses the local password; a disabled account is refused', async () => {
    const argon2 = require('argon2');
    const hash = await argon2.hash('Local!Admin123', require('../src/utils/argon2Options'));
    const aid = Number(db().prepare("INSERT INTO users (username, password_hash, role) VALUES ('it-admin', ?, 'admin')").run(hash).lastInsertRowid);
    db().prepare("INSERT INTO directory_links (user_id, directory_id, external_id, login_name) VALUES (?, ?, 'guid-admin', 'it-admin')").run(aid, dirAd.id);
    const r = await postLogin(supertest.agent(app), 'it-admin', 'Local!Admin123');
    assert.equal(r.headers.location, '/dashboard');
    const r2 = await postLogin(supertest.agent(app), 'it-admin', 'Winter2026!');
    assert.equal(r2.headers.location, '/login');
    assert.equal(adapterCalls.length, 0, 'the directory is never asked for an admin');

    db().prepare("UPDATE users SET enabled = 0, disabled_reason = 'directory' WHERE id = ?").run(lenaId);
    const r3 = await postLogin(supertest.agent(app), 'lena', 'Winter2026!');
    assert.equal(r3.headers.location, '/login');
    db().prepare('UPDATE users SET enabled = 1, disabled_reason = NULL WHERE id = ?').run(lenaId);
  });

  it('with sign-in switched off the directory is not asked', async () => {
    store().update(dirAd.id, { loginEnabled: false });
    const r = await postLogin(supertest.agent(app), 'lena', 'Winter2026!');
    assert.equal(r.headers.location, '/login');
    assert.equal(adapterCalls.length, 0);
    store().update(dirAd.id, { loginEnabled: true });
    const page = await loginPage(supertest.agent(app));
    assert.match(page.html, /maxlength="256"/);
  });
});

// ─── OpenID Connect with a fake Entra ID ──────────────────────────────────

describe('Mit Microsoft anmelden (OIDC)', () => {
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const CLIENT = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const OID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
  const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  let idp;
  let dirId;
  let userId;

  function sign(claims, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
    const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${s}`;
  }
  function claimsFor(nonce, extra) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: ISSUER, aud: CLIENT, tid: TENANT, oid: OID, nonce, iat: now, nbf: now, exp: now + 3600, name: 'Mara', ...(extra || {}) };
  }
  function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

  async function fakeFetch(url, init = {}) {
    const s = String(url);
    idp.requests.push(s);
    if (s === `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`) {
      return json({ issuer: ISSUER, authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`, token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys` });
    }
    if (s === `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`) return json({ keys: [jwk] });
    if (s === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      const body = new URLSearchParams(init.body);
      idp.tokenRequests.push(Object.fromEntries(body));
      const verifier = body.get('code_verifier');
      const challenge = crypto.createHash('sha256').update(verifier || '').digest('base64url');
      if (challenge !== idp.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
      if (body.get('client_secret') !== 'Entra-Secret-1' || body.get('code') !== 'auth-code-1') return json({ error: 'invalid_client' }, 401);
      return json({ id_token: idp.makeToken(idp.nonce), access_token: 'x', token_type: 'Bearer' });
    }
    return json({ error: 'unexpected' }, 404);
  }

  before(() => {
    const d = store().create({ kind: 'entra', name: 'Entra', secret: 'Entra-Secret-1', loginEnabled: true, config: { tenantId: TENANT, clientId: CLIENT } });
    dirId = d.id;
    userId = Number(db().prepare("INSERT INTO users (username, password_hash, role, email, self_service_enabled) VALUES ('mara', '!', 'user', 'mara@firma.de', 1)").run().lastInsertRowid);
    db().prepare('INSERT INTO directory_links (user_id, directory_id, external_id, login_name, upn) VALUES (?, ?, ?, ?, ?)').run(userId, dirId, OID, 'mara@firma.onmicrosoft.com', 'mara@firma.onmicrosoft.com');
  });
  beforeEach(() => {
    idp = { requests: [], tokenRequests: [], makeToken: (nonce) => sign(claimsFor(nonce)) };
    require('../src/services/directory/entra')._setFetch(fakeFetch);
    require('../src/services/directory/oidc')._reset();
    db().prepare('UPDATE users SET enabled = 1, totp_enabled = 0 WHERE id = ?').run(userId);
  });

  async function start(agent) {
    const r = await agent.get(`/auth/oidc/${dirId}/start`).expect(302);
    const loc = new URL(r.headers.location);
    assert.equal(loc.origin + loc.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    idp.nonce = loc.searchParams.get('nonce');
    idp.challenge = loc.searchParams.get('code_challenge');
    return { state: loc.searchParams.get('state'), loc, cookie: r.headers['set-cookie'] };
  }
  async function callback(agent, state, extra = '') {
    return agent.get(`/auth/oidc/${dirId}/callback?code=auth-code-1&state=${encodeURIComponent(state)}${extra}`);
  }
  function bounceTarget(res) {
    const m = res.text.match(/http-equiv="refresh" content="0;url=([^"]+)"/);
    return m ? m[1] : null;
  }
  async function loggedIn(agent) { return (await agent.get('/profile')).status === 200; }

  it('shows the button and sends the browser to Microsoft with state, nonce and PKCE', async () => {
    const a = supertest.agent(app);
    const page = await loginPage(a);
    assert.ok(page.html.includes(`/auth/oidc/${dirId}/start`));
    const { loc, cookie } = await start(a);
    assert.equal(loc.searchParams.get('client_id'), CLIENT);
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('redirect_uri'), `http://localhost:3000/auth/oidc/${dirId}/callback`);
    assert.ok(loc.searchParams.get('state').length >= 32);
    assert.ok(loc.searchParams.get('nonce').length >= 32);
    assert.ok(cookie.some((c) => /^gc\.oidc=/.test(c) && /SameSite=Lax/i.test(c) && /HttpOnly/i.test(c) && /Path=\/auth\/oidc/.test(c)));
  });

  it('signs in the linked account (object id) and creates a normal session', async () => {
    const a = supertest.agent(app);
    const { state } = await start(a);
    const r = await callback(a, state);
    assert.equal(r.status, 200);
    assert.equal(bounceTarget(r), '/profile');
    assert.equal(await loggedIn(a), true);
    const tr = idp.tokenRequests[0];
    assert.equal(tr.grant_type, 'authorization_code');
    assert.equal(tr.client_id, CLIENT);
    assert.ok(tr.code_verifier && tr.code_verifier.length >= 43);
    const sess = db().prepare("SELECT data FROM sessions WHERE json_extract(data, '$.userId') = ? ORDER BY rowid DESC LIMIT 1").get(userId);
    assert.equal(JSON.parse(sess.data).authMethod, 'oidc');
  });

  it('with GateControl 2FA on, the TOTP step follows', async () => {
    db().prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
    const a = supertest.agent(app);
    const { state } = await start(a);
    const r = await callback(a, state);
    assert.equal(bounceTarget(r), '/login/2fa');
    assert.equal(await loggedIn(a), false);
  });

  const refused = async (a, r) => {
    assert.equal(r.status, 200);
    assert.equal(bounceTarget(r), '/login');
    assert.equal(await loggedIn(a), false);
  };

  it('refuses a wrong state, and a state is single use', async () => {
    const a = supertest.agent(app);
    const { state } = await start(a);
    await refused(a, await callback(a, 'x'.repeat(43)));
    await refused(a, await callback(a, state)); // the transaction is gone
    assert.equal(idp.tokenRequests.length, 0);
  });

  it('refuses a callback without the transaction cookie (another browser)', async () => {
    const a = supertest.agent(app);
    const { state } = await start(a);
    const b = supertest.agent(app);
    await refused(b, await callback(b, state));
  });

  it('refuses when the PKCE verifier does not match (token endpoint says no)', async () => {
    const a = supertest.agent(app);
    const { state } = await start(a);
    idp.challenge = 'tampered';
    await refused(a, await callback(a, state));
  });

  for (const [label, make] of [
    ['wrong tenant', (n) => sign(claimsFor(n, { tid: '00000000-0000-0000-0000-000000000000' }))],
    ['wrong issuer', (n) => sign(claimsFor(n, { iss: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0' }))],
    ['wrong audience', (n) => sign(claimsFor(n, { aud: '00000000-0000-0000-0000-000000000001' }))],
    ['bad signature', (n) => sign(claimsFor(n), { key: other.privateKey })],
    ['unknown key id', (n) => sign(claimsFor(n), { kid: 'k2' })],
    ['alg none', (n) => { const t = sign(claimsFor(n)).split('.'); t[0] = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url'); return `${t[0]}.${t[1]}.`; }],
    ['expired', (n) => sign(claimsFor(n, { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200, nbf: Math.floor(Date.now() / 1000) - 7200 }))],
    ['not yet valid', (n) => sign(claimsFor(n, { nbf: Math.floor(Date.now() / 1000) + 3600 }))],
    ['wrong nonce', () => sign(claimsFor('another-nonce'))],
    ['unknown object id', (n) => sign(claimsFor(n, { oid: '11111111-1111-4111-8111-111111111111' }))],
  ]) {
    it(`refuses an ID token with ${label}`, async () => {
      idp.makeToken = make;
      const a = supertest.agent(app);
      const { state } = await start(a);
      await refused(a, await callback(a, state));
    });
  }

  it('refuses a disabled account and says why when no account is linked', async () => {
    db().prepare("UPDATE users SET enabled = 0, disabled_reason = 'directory' WHERE id = ?").run(userId);
    const a = supertest.agent(app);
    const { state } = await start(a);
    const r = await callback(a, state);
    assert.equal(bounceTarget(r), '/login');
    // the bounce page continues to /login, which shows the reason
    const page = await a.get('/login');
    assert.ok(/kein freigegebenes GateControl-Konto|no enabled GateControl account/.test(page.text));
    assert.equal(await loggedIn(a), false);
  });

  it('refuses when Microsoft reports an error and when sign-in is switched off', async () => {
    const a = supertest.agent(app);
    const { state } = await start(a);
    await refused(a, await a.get(`/auth/oidc/${dirId}/callback?error=access_denied&state=${encodeURIComponent(state)}`));
    store().update(dirId, { loginEnabled: false });
    const r = await supertest.agent(app).get(`/auth/oidc/${dirId}/start`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login');
    store().update(dirId, { loginEnabled: true });
  });

  it('verifyIdToken checks the claims on its own', async () => {
    const oidc = require('../src/services/directory/oidc');
    const opts = { issuer: ISSUER, audience: CLIENT, nonce: 'n1', tenantId: TENANT, jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys` };
    const claims = await oidc.verifyIdToken(sign(claimsFor('n1')), opts);
    assert.equal(claims.oid, OID);
    await assert.rejects(oidc.verifyIdToken(sign(claimsFor('n1', { tid: undefined })), opts), (e) => e.code === 'BAD_TOKEN' && e.reason === 'tenant');
    await assert.rejects(oidc.verifyIdToken('a.b', opts), (e) => e.code === 'BAD_TOKEN');
  });
});
