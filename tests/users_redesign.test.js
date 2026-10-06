'use strict';

// Users page redesign + "Mein Bereich" (member self-service) + per-device
// Pi-hole statistics: services, admin API, login flow, /me isolation,
// role-aware navigation and templates.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const argon2 = require('argon2');
const { setup, teardown } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');

let app, agent, csrf;
before(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
after(() => teardown());

const db = () => require('../src/db/connection').getDb();
const users = () => require('../src/services/users');
const tokens = () => require('../src/services/tokens');
const PW = 'Plain!Pass1234';

async function makeUser(username, role = 'user', { selfService = false, password = PW, displayName = null } = {}) {
  const hash = role === 'admin' || selfService ? await argon2.hash(password, require('../src/utils/argon2Options')) : '!';
  return Number(db().prepare('INSERT INTO users (username, password_hash, role, self_service_enabled, display_name) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, role, selfService ? 1 : 0, displayName).lastInsertRowid);
}

async function loginAs(username, password = PW) {
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const loginCsrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const res = await a.post('/login').type('form').send({ username, password, _csrf: loginCsrf }).expect(302);
  return { a, location: res.headers.location };
}

async function pageCsrf(a, path) {
  const page = await a.get(path).expect(200);
  return page.text.match(/csrfToken:\s*'([^']+)'/)[1];
}

function peer(name, ip, owner) {
  return Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES (?, ?, ?, 1, 'regular', ?)")
    .run(name, crypto.randomBytes(16).toString('base64'), ip + '/32', owner).lastInsertRowid);
}

function sessionsOf(userId) {
  return db().prepare("SELECT COUNT(*) AS c FROM sessions WHERE json_extract(data, '$.userId') = ?").get(userId).c;
}

// ─── Role cap: Pi-hole statistics for members ────────────────────────

describe('role cap and enrollment defaults', () => {
  it('members may hold `pihole` (read) but never `pihole:control` or admin scopes', () => {
    const u = users();
    assert.deepEqual(u.filterScopesForRole(['client', 'pihole', 'pihole:control', 'full-access', 'peers'], 'user'), ['client', 'pihole']);
    assert.ok(u.getAllowedScopes('admin').includes('pihole:control'));
  });

  it('DEFAULT_SCOPES lie inside the member cap and carry no pihole; admins keep it by default', () => {
    const e = require('../src/services/clientEnrollment');
    const cap = users().getAllowedScopes('user');
    assert.ok(e.DEFAULT_SCOPES.every((s) => cap.includes(s)));
    assert.ok(!e.DEFAULT_SCOPES.includes('pihole'), 'pihole is opt-in for member devices');
    assert.ok(e.ADMIN_DEFAULT_SCOPES.includes('pihole'));
  });

  it('a member device code without scopes gets no pihole; with pihole requested it does, control never', async () => {
    const e = require('../src/services/clientEnrollment');
    const id = await makeUser('cap-member');
    assert.ok(!e.createCode({ userId: id }).scopes.includes('pihole'));
    const withPi = e.createCode({ userId: id, scopes: ['client', 'pihole', 'pihole:control'] }).scopes;
    assert.ok(withPi.includes('pihole'));
    assert.ok(!withPi.includes('pihole:control'));
  });

  it('a member token with pihole reaches the read endpoints only; top-clients is limited to its own peer', async () => {
    require('../src/services/license')._overrideForTest({ pihole_integration: true, api_tokens: true });
    const id = await makeUser('pi-member');
    const p = peer('pi-phone', '10.8.0.201', id);
    const raw = tokens().create({ name: 'pi', scopes: ['client', 'pihole', 'pihole:control'], userId: id, peerId: p }, '127.0.0.1').rawToken;
    const r = (m, url) => supertest(app)[m](url).set('Authorization', `Bearer ${raw}`);
    await r('get', '/api/v1/pihole/summary').expect(200);
    const tc = await r('get', '/api/v1/pihole/top-clients').expect(200);
    assert.ok((tc.body.data || []).every((c) => c.peerId === p));
    const ctl = await r('post', '/api/v1/pihole/blocking').send({ enabled: false });
    assert.equal(ctl.status, 403, 'pihole:control is capped away for members');
  });
});

// ─── Services: password, role, delete ────────────────────────────────

describe('users service', () => {
  it('setPassword applies the policy and sets must_change_password', async () => {
    const id = await makeUser('pw-admin', 'admin');
    await assert.rejects(() => users().setPassword(id, 'short'), { code: 'PASSWORD_POLICY' });
    await users().setPassword(id, 'Another!Pass99', { mustChangePassword: true });
    const row = db().prepare('SELECT must_change_password, password_changed_at FROM users WHERE id = ?').get(id);
    assert.equal(row.must_change_password, 1);
    assert.ok(row.password_changed_at);
  });

  it('a member without "Mein Bereich" has no password to set', async () => {
    const id = await makeUser('pw-member');
    await assert.rejects(() => users().setPassword(id, 'Another!Pass99'), { code: 'NO_WEB_LOGIN' });
  });

  it('promotion needs a password and gives a working login; demotion removes the web login', async () => {
    const id = await makeUser('promote-me');
    await assert.rejects(() => users().changeRole(id, 'admin', {}), { code: 'PASSWORD_REQUIRED' });
    await users().changeRole(id, 'admin', { password: 'Promoted!Pass1' });
    const { location } = await loginAs('promote-me', 'Promoted!Pass1');
    assert.equal(location, '/dashboard');
    await users().changeRole(id, 'user');
    const row = db().prepare('SELECT password_hash, role, self_service_enabled FROM users WHERE id = ?').get(id);
    assert.equal(row.password_hash, '!');
    assert.equal(row.role, 'user');
    const again = await loginAs('promote-me', 'Promoted!Pass1');
    assert.equal(again.location, '/login');
  });

  it('the last enabled admin cannot be demoted', async () => {
    const d = db();
    const admins = d.prepare("SELECT id FROM users WHERE role = 'admin' AND enabled = 1").all();
    const keep = admins[0].id;
    d.prepare("UPDATE users SET enabled = 0 WHERE role = 'admin' AND id != ?").run(keep);
    try {
      await assert.rejects(() => users().changeRole(keep, 'user'), /last admin/);
    } finally {
      for (const a of admins) d.prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(a.id);
    }
  });

  it('deleteImpact lists tokens, owner-less peers and visibility entries; remove keeps a sole share hidden', async () => {
    const d = db();
    const id = await makeUser('del-me', 'user', { displayName: 'Del Me' });
    const other = await makeUser('del-other');
    const p = peer('del-phone', '10.8.0.210', id);
    tokens().create({ name: 'Del phone', scopes: ['client'], userId: id, peerId: p }, '127.0.0.1');
    tokens().create({ name: 'Del script', scopes: ['client'], userId: id }, '127.0.0.1');
    const r1 = d.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, user_ids) VALUES ('only.del.test', '10.0.0.1', 80, 'http', ?)").run(JSON.stringify([id])).lastInsertRowid;
    const r2 = d.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, user_ids) VALUES ('both.del.test', '10.0.0.1', 80, 'http', ?)").run(JSON.stringify([id, other])).lastInsertRowid;
    const impact = users().deleteImpact(id);
    assert.equal(impact.tokens.length, 2);
    assert.equal(impact.tokens.filter((t) => t.device).length, 1);
    assert.deepEqual(impact.peers.map((x) => x.name), ['del-phone']);
    assert.equal(impact.routes.find((r) => r.id === Number(r1)).onlyThisUser, true);
    assert.equal(impact.routes.find((r) => r.id === Number(r2)).onlyThisUser, false);

    const res = await agent.get(`/api/v1/users/${id}/delete-impact`).expect(200);
    assert.equal(res.body.impact.peers.length, 1);
    await agent.delete(`/api/v1/users/${id}`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(d.prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?').get(id).c, 0);
    assert.equal(d.prepare('SELECT user_id FROM peers WHERE id = ?').get(p).user_id, null);
    assert.equal(d.prepare('SELECT user_ids FROM routes WHERE id = ?').get(r1).user_ids, JSON.stringify([id]), 'sole share stays (hidden for all)');
    assert.equal(d.prepare('SELECT user_ids FROM routes WHERE id = ?').get(r2).user_ids, JSON.stringify([other]));
  });
});

// ─── Admin API ───────────────────────────────────────────────────────

describe('users admin API', () => {
  it('POST /users/:id/password resets another account and signs it out; own account refused', async () => {
    const id = await makeUser('reset-admin', 'admin');
    await loginAs('reset-admin');
    assert.equal(sessionsOf(id), 1);
    const res = await agent.post(`/api/v1/users/${id}/password`).set('X-CSRF-Token', csrf)
      .send({ password: 'Reset!Pass123', mustChangePassword: false }).expect(200);
    assert.equal(res.body.signed_out, 1);
    assert.equal(sessionsOf(id), 0);
    const { location } = await loginAs('reset-admin', 'Reset!Pass123');
    assert.equal(location, '/dashboard');
    const self = db().prepare('SELECT id FROM users WHERE username = ?').get('admin').id;
    await agent.post(`/api/v1/users/${self}/password`).set('X-CSRF-Token', csrf).send({ password: 'Reset!Pass123' }).expect(400);
    await agent.post(`/api/v1/users/${id}/password`).set('X-CSRF-Token', csrf).send({ password: 'x' }).expect(400);
  });

  it('POST /users/:id/role: promotion without password is 400; with password works', async () => {
    const id = await makeUser('role-api');
    await agent.post(`/api/v1/users/${id}/role`).set('X-CSRF-Token', csrf).send({ role: 'admin' }).expect(400);
    const ok = await agent.post(`/api/v1/users/${id}/role`).set('X-CSRF-Token', csrf).send({ role: 'admin', password: 'Role!Pass1234' }).expect(200);
    assert.equal(ok.body.user.role, 'admin');
    assert.equal(ok.body.user.has_password, true);
  });

  it('GET /users lists counts, auth facts and never a password hash', async () => {
    const res = await agent.get('/api/v1/users').expect(200);
    const u = res.body.users[0];
    for (const k of ['peer_count', 'token_count', 'passkey_count', 'last_login_at', 'has_password']) assert.ok(k in u, k);
    assert.ok(!res.text.includes('password_hash') && !res.text.includes('$argon2'));
  });

  it('GET /users/:id/visibility: reasons, hidden count, portal, pihole per device', async () => {
    const d = db();
    const id = await makeUser('vis-member', 'user', { displayName: 'Vis Member' });
    const other = await makeUser('vis-other');
    d.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES ('all.vis.test', '10.0.0.1', 80, 'http', 1)").run();
    d.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, user_ids) VALUES ('mine.vis.test', '10.0.0.1', 80, 'http', 1, ?)").run(JSON.stringify([id, other]));
    d.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, user_ids) VALUES ('theirs.vis.test', '10.0.0.1', 80, 'http', 1, ?)").run(JSON.stringify([other]));
    const p = peer('vis-phone', '10.8.0.220', id);
    const t = tokens().create({ name: 'Vis phone', scopes: ['client', 'pihole'], userId: id, peerId: p }, '127.0.0.1').token;
    const res = await agent.get(`/api/v1/users/${id}/visibility`).expect(200);
    const names = res.body.services.visible.map((s) => s.host);
    assert.ok(names.includes('all.vis.test') && names.includes('mine.vis.test') && !names.includes('theirs.vis.test'));
    assert.equal(res.body.services.visible.find((s) => s.host === 'all.vis.test').reason, 'all');
    assert.equal(res.body.services.visible.find((s) => s.host === 'mine.vis.test').reason, 'picked');
    assert.ok(res.body.services.hidden >= 1);
    assert.equal(res.body.web, 'none');
    assert.equal(res.body.pihole.devices.find((x) => x.tokenId === t.id).on, true);
    await agent.get('/api/v1/users/999999/visibility').expect(404);
  });

  it('PATCH /tokens/:id caps rights by the (new) owner and changes name/expiry', async () => {
    const owner = await makeUser('patch-member');
    const t = tokens().create({ name: 'Patch me', scopes: ['read-only'] }, '127.0.0.1').token;
    const capped = await agent.patch(`/api/v1/tokens/${t.id}`).set('X-CSRF-Token', csrf)
      .send({ user_id: owner, scopes: ['client', 'pihole', 'pihole:control', 'full-access'] }).expect(200);
    assert.deepEqual(capped.body.token.scopes, ['client', 'pihole']);
    assert.deepEqual(capped.body.dropped.sort(), ['full-access', 'pihole:control']);
    const exp = new Date(Date.now() + 86400000 * 30).toISOString();
    const renamed = await agent.patch(`/api/v1/tokens/${t.id}`).set('X-CSRF-Token', csrf).send({ name: 'Renamed', expires_at: exp }).expect(200);
    assert.equal(renamed.body.token.name, 'Renamed');
    assert.ok(renamed.body.token.expires_at);
    await agent.patch(`/api/v1/tokens/${t.id}`).set('X-CSRF-Token', csrf).send({ scopes: ['peers'] }).expect(400);
    await agent.patch(`/api/v1/tokens/${t.id}`).set('X-CSRF-Token', csrf).send({ expires_at: '2000-01-01T00:00:00Z' }).expect(400);
    await agent.patch('/api/v1/tokens/999999').set('X-CSRF-Token', csrf).send({ name: 'x' }).expect(404);
  });

  it('sessions: list without session ids, sign out one, sign out all', async () => {
    const id = await makeUser('sess-admin', 'admin');
    await loginAs('sess-admin');
    await loginAs('sess-admin');
    const list = await agent.get(`/api/v1/users/${id}/sessions`).expect(200);
    assert.equal(list.body.sessions.length, 2);
    const sids = db().prepare("SELECT sid FROM sessions WHERE json_extract(data, '$.userId') = ?").all(id).map((r) => r.sid);
    for (const sid of sids) assert.ok(!list.text.includes(sid), 'session id must not leak');
    await agent.delete(`/api/v1/users/${id}/sessions/${list.body.sessions[0].ref}`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(sessionsOf(id), 1);
    await agent.delete(`/api/v1/users/${id}/sessions/deadbeefdeadbeef`).set('X-CSRF-Token', csrf).expect(404);
    await agent.delete(`/api/v1/users/${id}/sessions`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(sessionsOf(id), 0);
  });

  it('DELETE /users/:id/passkeys/:pid removes another user\'s passkey only', async () => {
    const id = await makeUser('pk-admin', 'admin');
    const other = await makeUser('pk-other', 'admin');
    const ins = (uid, cred) => db().prepare("INSERT INTO admin_passkeys (user_id, credential_id, public_key, name) VALUES (?, ?, x'00', 'Key')").run(uid, cred).lastInsertRowid;
    const pk = ins(id, 'cred-a');
    const pkOther = ins(other, 'cred-b');
    await agent.delete(`/api/v1/users/${id}/passkeys/${pkOther}`).set('X-CSRF-Token', csrf).expect(404);
    await agent.delete(`/api/v1/users/${id}/passkeys/${pk}`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM admin_passkeys WHERE id = ?').get(pk).c, 0);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM admin_passkeys WHERE id = ?').get(pkOther).c, 1);
  });

  it('GET /users/:id/activity returns entries about that user', async () => {
    const id = await makeUser('act-member');
    require('../src/services/activity').log('user_updated', 'User "act-member" updated', { details: { userId: id } });
    const res = await agent.get(`/api/v1/users/${id}/activity`).expect(200);
    assert.ok(res.body.entries.some((e) => e.message.includes('act-member')));
  });

  it('a token is refused on the session-only users API', async () => {
    const raw = tokens().create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    await supertest(app).get('/api/v1/users').set('Authorization', `Bearer ${raw}`).expect(403);
  });
});

// ─── Login: must_change_password ─────────────────────────────────────

describe('change password at login', () => {
  it('asks for an own password before the session exists', async () => {
    const id = await makeUser('must-change', 'admin');
    db().prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(id);
    const { a, location } = await loginAs('must-change');
    assert.equal(location, '/login/change-password');
    await a.get('/api/v1/ping').expect(401);
    const page = await a.get('/login/change-password').expect(200);
    const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const same = await a.post('/login/change-password').type('form').send({ _csrf: c, password: PW, password_confirm: PW }).expect(302);
    assert.equal(same.headers.location, '/login/change-password');
    const ok = await a.post('/login/change-password').type('form').send({ _csrf: c, password: 'Fresh!Pass9876', password_confirm: 'Fresh!Pass9876' }).expect(302);
    assert.equal(ok.headers.location, '/dashboard');
    await a.get('/api/v1/ping').expect(200);
    assert.equal(db().prepare('SELECT must_change_password FROM users WHERE id = ?').get(id).must_change_password, 0);
  });
});

// ─── Invitation end to end ───────────────────────────────────────────

describe('invitation to "Mein Bereich"', () => {
  let id;
  let link;
  before(async () => { id = await makeUser('invitee', 'user', { displayName: 'In Vitee' }); });

  it('a member without self-service cannot sign in', async () => {
    const { location } = await loginAs('invitee', 'whatever');
    assert.equal(location, '/login');
  });

  it('the admin creates a one-time link; only the hash is stored', async () => {
    const res = await agent.post(`/api/v1/users/${id}/invite`).set('X-CSRF-Token', csrf).send({}).expect(201);
    link = res.body.link;
    assert.match(link, /\/invite\/[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.emailed, false);
    const token = link.split('/invite/')[1];
    const row = db().prepare('SELECT token_hash FROM user_invites WHERE user_id = ?').get(id);
    assert.notEqual(row.token_hash, token);
    assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(db().prepare('SELECT self_service_enabled FROM users WHERE id = ?').get(id).self_service_enabled === 1);
  });

  it('invalid tokens get one generic 404 page', async () => {
    const res = await supertest(app).get('/invite/' + 'A'.repeat(43)).expect(404);
    assert.ok(res.text.includes('data-invite="invalid"'));
    await supertest(app).get('/invite/short').expect(404);
  });

  it('the policy applies, then the password is set, the link is spent and login lands on /me', async () => {
    const path = link.replace(/^https?:\/\/[^/]+/, '');
    const a = supertest.agent(app);
    const page = await a.get(path).expect(200);
    assert.ok(withoutScripts(page.text).includes('invitee'));
    const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const weak = await a.post(path).type('form').send({ _csrf: c, password: 'x', password_confirm: 'x' }).expect(200);
    assert.ok(weak.text.includes('login-error'));
    await a.post(path).type('form').send({ _csrf: c, password: 'Invite!Pass123', password_confirm: 'Invite!Pass123' }).expect(302);
    await a.get(path).expect(404);
    const { a: m, location } = await loginAs('invitee', 'Invite!Pass123');
    assert.equal(location, '/me');
    await m.get('/me').expect(200);
  });

  it('switching self-service off invalidates the password and the sessions', async () => {
    await loginAs('invitee', 'Invite!Pass123');
    await agent.delete(`/api/v1/users/${id}/self-service`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(sessionsOf(id), 0);
    const { location } = await loginAs('invitee', 'Invite!Pass123');
    assert.equal(location, '/login');
  });

  it('disabling a member removes its self-service login too', async () => {
    const mid = await makeUser('disable-self', 'user', { selfService: true });
    await agent.put(`/api/v1/users/${mid}/toggle`).set('X-CSRF-Token', csrf).expect(200);
    await agent.put(`/api/v1/users/${mid}/toggle`).set('X-CSRF-Token', csrf).expect(200);
    const row = db().prepare('SELECT password_hash, self_service_enabled FROM users WHERE id = ?').get(mid);
    assert.equal(row.password_hash, '!');
    assert.equal(row.self_service_enabled, 0);
  });
});

// ─── /me isolation and escalation ────────────────────────────────────

describe('"Mein Bereich" API isolation', () => {
  let alice, bob, a, aCsrf, aliceTok, bobTok, bobPeer;
  before(async () => {
    alice = await makeUser('me-alice', 'user', { selfService: true });
    bob = await makeUser('me-bob', 'user', { selfService: true });
    const ap = peer('alice-phone', '10.8.0.230', alice);
    bobPeer = peer('bob-phone', '10.8.0.231', bob);
    aliceTok = tokens().create({ name: 'Alice phone', scopes: ['client'], userId: alice, peerId: ap }, '127.0.0.1').token.id;
    bobTok = tokens().create({ name: 'Bob phone', scopes: ['client'], userId: bob, peerId: bobPeer }, '127.0.0.1').token.id;
    db().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, user_ids) VALUES ('bob.only.test', '10.0.0.9', 80, 'http', 1, ?)").run(JSON.stringify([bob]));
    ({ a } = await loginAs('me-alice'));
    aCsrf = await pageCsrf(a, '/me');
  });

  it('lists only the own devices', async () => {
    const res = await a.get('/api/v1/me/devices').expect(200);
    const ids = res.body.devices.map((d) => d.id);
    assert.deepEqual(ids, [aliceTok]);
    assert.ok(!res.text.includes('bob-phone'));
  });

  it('cannot revoke another user\'s device (404, token stays)', async () => {
    await a.delete(`/api/v1/me/devices/${bobTok}`).set('X-CSRF-Token', aCsrf).expect(404);
    assert.ok(tokens().getById(bobTok));
    await a.delete('/api/v1/me/devices/abc').set('X-CSRF-Token', aCsrf).expect(404);
  });

  it('ignores ids from the client', async () => {
    const res = await a.get(`/api/v1/me/devices?userId=${bob}&user_id=${bob}`).expect(200);
    assert.deepEqual(res.body.devices.map((d) => d.id), [aliceTok]);
  });

  it('services: own shares only, no credentials, no names of other users', async () => {
    const res = await a.get('/api/v1/me/services').expect(200);
    assert.ok(!res.body.services.some((s) => s.host === 'bob.only.test'));
    assert.ok(!/password|credential|user_ids|me-bob/i.test(res.text));
  });

  it('reaches no admin API', async () => {
    for (const p of ['/api/v1/users', `/api/v1/users/${bob}`, `/api/v1/users/${bob}/visibility`, '/api/v1/tokens', '/api/v1/peers',
      '/api/v1/routes', '/api/v1/settings/app', '/api/v1/enrollment', '/api/v1/logs/recent']) {
      const res = await a.get(p);
      assert.equal(res.status, 403, p);
    }
    await a.post('/api/v1/enrollment').set('X-CSRF-Token', aCsrf).send({ userId: alice }).expect(403);
    await a.patch(`/api/v1/tokens/${aliceTok}`).set('X-CSRF-Token', aCsrf).send({ scopes: ['full-access'] }).expect(403);
    await a.post(`/api/v1/users/${alice}/role`).set('X-CSRF-Token', aCsrf).send({ role: 'admin', password: 'x' }).expect(403);
  });

  it('own device setup needs the permission; scopes stay app scopes (no escalation)', async () => {
    await a.post('/api/v1/me/enrollment').set('X-CSRF-Token', aCsrf).send({}).expect(403);
    db().prepare('UPDATE users SET self_enroll_enabled = 1 WHERE id = ?').run(alice);
    const res = await a.post('/api/v1/me/enrollment').set('X-CSRF-Token', aCsrf)
      .send({ pihole: true, scopes: ['full-access', 'pihole:control'], userId: bob, peerId: bobPeer }).expect(201);
    assert.deepEqual(res.body.scopes.sort(), ['client', 'client:dns', 'client:rdp', 'client:services', 'client:traffic', 'pihole']);
    const row = db().prepare('SELECT user_id, peer_id FROM client_enrollment_codes ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
    assert.equal(row.user_id, alice);
    assert.equal(row.peer_id, null);
  });

  it('is session only: a member token cannot use /me', async () => {
    const raw = tokens().create({ name: 'Alice tok', scopes: ['client'], userId: alice }, '127.0.0.1').rawToken;
    const res = await supertest(app).get('/api/v1/me/devices').set('Authorization', `Bearer ${raw}`);
    assert.equal(res.status, 403);
  });

  it('revokes the own device and logs it', async () => {
    await a.delete(`/api/v1/me/devices/${aliceTok}`).set('X-CSRF-Token', aCsrf).expect(200);
    assert.equal(tokens().getById(aliceTok), null);
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'self_device_revoked'").get());
  });
});

// ─── Navigation and guards ───────────────────────────────────────────

describe('role-aware navigation', () => {
  let m;
  before(async () => {
    await makeUser('nav-member', 'user', { selfService: true });
    ({ a: m } = await loginAs('nav-member'));
  });

  it('every admin page redirects a member to /me', async () => {
    for (const p of ['/dashboard', '/peers', '/routes', '/users', '/settings', '/logs', '/rdp', '/security', '/certificates', '/gateways', '/']) {
      const res = await m.get(p);
      assert.equal(res.status, 302, p);
      assert.equal(res.headers.location, '/me', p);
    }
    await m.get('/me').expect(200);
    await m.get('/profile').expect(200);
  });

  it('member pages show only the member navigation', async () => {
    const res = await m.get('/me').expect(200);
    const html = withoutScripts(res.text);
    assert.ok(html.includes('href="/me"') && html.includes('href="/profile"'));
    for (const admin of ['href="/dashboard"', 'href="/peers"', 'href="/settings"', 'href="/users"', 'class="bottom-nav"', 'id="fab-btn"']) {
      assert.ok(!html.includes(admin), admin);
    }
    assert.ok(!res.text.includes('/js/events.js'), 'no admin event stream');
    assert.match(res.text, /role: "user"/);
  });

  it('admin pages keep the admin navigation', async () => {
    const res = await agent.get('/dashboard').expect(200);
    const html = withoutScripts(res.text);
    assert.ok(html.includes('href="/users"') && html.includes('class="bottom-nav"'));
  });
});

// ─── Templates: no raw keys, de/en parity ────────────────────────────

describe('templates', () => {
  const RAW = /\b(?:us|me|invite|pwchange|nav|users)\.[a-z_]+(?:\.[a-z_]+)*\b/g;
  for (const lang of ['de', 'en']) {
    it(`/users, /me, invite and password pages (${lang}) render without raw keys`, async () => {
      await agent.post('/api/v1/settings/language').set('X-CSRF-Token', csrf).send({ language: lang }).expect(200);
      for (const p of ['/users', '/me', '/profile']) {
        const res = await agent.get(p).expect(200);
        const raw = withoutScripts(res.text).match(RAW);
        assert.equal(raw, null, `${p}: ${raw}`);
      }
      const inv = await supertest(app).get('/invite/' + 'B'.repeat(43)).set('Accept-Language', lang);
      assert.equal(withoutScripts(inv.text).match(RAW), null);
      const island = (await agent.get('/users')).text.match(/id="us-i18n"[^>]*>([^<]*)</)[1];
      const strings = JSON.parse(island);
      assert.ok(strings['us.wz.title'] && strings['users.mb.title'] && strings['error.users.last_admin']);
    });
  }

  it('every us.* / me.* / invite.* / pwchange.* key exists in both languages', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const pick = (o) => Object.keys(o).filter((k) => /^(us|me|invite|pwchange)\./.test(k)).sort();
    assert.deepEqual(pick(de), pick(en));
    assert.ok(pick(de).length > 300);
    // German copy uses real umlauts, never ae/oe/ue transliterations.
    const TRANSLIT = /\b(?:fuer|ueber|Ueber|waehl|aender|Aender|loesch|Loesch|koenn|moegl|muess|Schluessel|zurueck|Geraet|geraet|Passwoert|oeffn|Oeffn|hinzufueg)/;
    for (const k of pick(de)) assert.ok(!TRANSLIT.test(de[k]), `${k}: ${de[k]}`);
  });

  it('users.js uses no innerHTML and every string key it asks for exists', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'users.js'), 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(src), 'no innerHTML assignments');
    const de = require('../src/i18n/de.json');
    const used = [...src.matchAll(/\bT\('([a-z_.]+[a-z_])'/g)].map((m) => m[1]);
    const missing = used.filter((k) => de[k] === undefined && !/[._]$/.test(k));
    assert.deepEqual(missing, []);
  });
});
