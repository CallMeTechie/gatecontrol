'use strict';

// Person groups: admin API (/api/v1/groups), the admin page, the user
// profile API and the invitation link page (/portal/groups/join/:token).

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

async function createLoginUser(username, password = 'Plain!Pass1234', email = null) {
  const hash = await argon2.hash(password, require('../src/utils/argon2Options'));
  return Number(db().prepare("INSERT INTO users (username, password_hash, role, self_service_enabled, email) VALUES (?, ?, 'user', 1, ?)")
    .run(username, hash, email).lastInsertRowid);
}

async function loginAs(username, password = 'Plain!Pass1234', returnTo) {
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const loginCsrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const body = { username, password, _csrf: loginCsrf };
  if (returnTo) body.returnTo = returnTo;
  const res = await a.post('/login').type('form').send(body).expect(302);
  return { a, location: res.headers.location };
}

const api = (method, path) => agent[method](path).set('X-CSRF-Token', csrf);

describe('auth', () => {
  it('needs an admin session: member 403, token 403, nobody 401', async () => {
    await createLoginUser('grp-member');
    const { a } = await loginAs('grp-member');
    const r = await a.get('/api/v1/groups');
    assert.equal(r.status, 403);
    const page = await a.get('/profile').expect(200);
    const memberCsrf = page.text.match(/csrfToken:\s*'([^']+)'/)[1];
    const w = await a.post('/api/v1/groups').set('X-CSRF-Token', memberCsrf).send({ kind: 'team', name: 'x' });
    assert.equal(w.status, 403);
    const token = require('../src/services/tokens').create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    const t = await supertest(app).get('/api/v1/groups').set('Authorization', `Bearer ${token}`);
    assert.equal(t.status, 403);
    const anon = await supertest(app).get('/api/v1/groups');
    assert.ok([401, 302].includes(anon.status), String(anon.status));
    // the page: members go to their own profile
    const p = await a.get('/groups');
    assert.equal(p.status, 302);
    assert.equal(p.headers.location, '/profile');
  });

  it('refuses a write without the CSRF token', async () => {
    const r = await agent.post('/api/v1/groups').send({ kind: 'team', name: 'no csrf' });
    assert.equal(r.status, 403);
  });
});

describe('admin API', () => {
  let dep, team, uid;
  it('creates, lists (flat and tree), reads and updates', async () => {
    const r1 = await api('post', '/api/v1/groups').send({ kind: 'department', name: 'Verwaltung', source: 'plugin:evil' }).expect(201);
    dep = r1.body.group;
    assert.equal(dep.source, 'local', 'the API always creates local groups');
    team = (await api('post', '/api/v1/groups').send({ kind: 'team', name: 'Buchhaltung', parentId: dep.id }).expect(201)).body.group;
    assert.equal(team.path, 'Verwaltung › Buchhaltung');
    const dup = await api('post', '/api/v1/groups').send({ kind: 'team', name: 'buchhaltung', parentId: dep.id });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'NAME_TAKEN');
    assert.ok(dup.body.error);
    const bad = await api('post', '/api/v1/groups').send({ kind: 'nope', name: 'x' });
    assert.equal(bad.status, 400);
    const flat = (await agent.get('/api/v1/groups').expect(200)).body.groups;
    assert.ok(flat.some((g) => g.id === team.id));
    const tree = (await agent.get('/api/v1/groups?tree=1').expect(200)).body.groups;
    assert.equal(tree.find((g) => g.id === dep.id).children[0].id, team.id);
    const upd = await api('patch', `/api/v1/groups/${team.id}`).send({ name: 'Finanzen', color: '#2563eb' }).expect(200);
    assert.equal(upd.body.group.path, 'Verwaltung › Finanzen');
    const cyc = await api('patch', `/api/v1/groups/${dep.id}`).send({ parentId: team.id });
    assert.equal(cyc.body.code, 'CYCLE');
    assert.equal((await agent.get('/api/v1/groups/999999')).status, 404);
  });

  it('members: put, role change, delete; detail lists inherited members', async () => {
    uid = Number(db().prepare("INSERT INTO users (username, password_hash, role, email, display_name) VALUES ('sabine', '!', 'user', 's.wolf@firma.de', 'Sabine Wolf')").run().lastInsertRowid);
    await api('put', `/api/v1/groups/${team.id}/members/${uid}`).send({ role: 'lead' }).expect(200);
    const bad = await api('put', `/api/v1/groups/${team.id}/members/${uid}`).send({ role: 'parent' });
    assert.equal(bad.body.code, 'INVALID_ROLE');
    const d = (await agent.get(`/api/v1/groups/${dep.id}`).expect(200)).body;
    assert.deepEqual(d.members.map((m) => [m.userId, m.role, m.direct]), [[uid, 'member', false]]);
    assert.deepEqual(d.roles, ['member', 'lead', 'deputy', 'admin']);
    const prof = (await agent.get(`/api/v1/users/${uid}`).expect(200)).body;
    assert.deepEqual(prof.groups.map((g) => [g.path, g.role, g.direct]), [['Verwaltung', 'member', false], ['Verwaltung › Finanzen', 'lead', true]]);
    await api('delete', `/api/v1/groups/${team.id}/members/${uid}`).expect(200);
    assert.equal((await api('delete', `/api/v1/groups/${team.id}/members/${uid}`)).status, 404);
  });

  it('invites: link to the join page, listed and revocable', async () => {
    const r = await api('post', `/api/v1/groups/${team.id}/invites`).send({ role: 'member', expiresIn: 7, maxUses: 3 }).expect(201);
    assert.match(r.body.invite.url, /\/portal\/groups\/join\/[A-Za-z0-9_-]{43}$/);
    assert.equal(r.headers['cache-control'], 'no-store');
    const list = (await agent.get(`/api/v1/groups/${team.id}/invites`).expect(200)).body.invites;
    assert.equal(list.length, 1);
    assert.equal(list[0].token, undefined, 'the token is never listed');
    await api('delete', `/api/v1/groups/${team.id}/invites/${list[0].id}`).expect(200);
    assert.equal((await api('delete', `/api/v1/groups/${team.id}/invites/${list[0].id}`)).status, 404);
  });

  it('CSV import as text/plain and as JSON', async () => {
    const csv = 'pfad;email;rolle\nVerwaltung › Einkauf;s.wolf@firma.de;vertretung\nVerwaltung/Einkauf;nobody@x.example;member\n';
    const r = await agent.post('/api/v1/groups/import').set('X-CSRF-Token', csrf).set('Content-Type', 'text/plain').send(csv).expect(200);
    assert.deepEqual(r.body.created, ['Verwaltung › Einkauf']);
    assert.equal(r.body.added, 1);
    assert.equal(r.body.errors.length, 1);
    const j = await api('post', '/api/v1/groups/import').send({ csv: 'Projekt X;s.wolf@firma.de;member;projekt' }).expect(200);
    assert.deepEqual(j.body.created, ['Projekt X']);
    const missing = await api('post', '/api/v1/groups/import').send({});
    assert.equal(missing.status, 400);
  });

  it('usage, archive / unarchive, delete with the typed name', async () => {
    const u = (await agent.get(`/api/v1/groups/${team.id}/usage`).expect(200)).body.usage;
    assert.deepEqual(u, []);
    const a = await api('post', `/api/v1/groups/${team.id}/archive`).expect(200);
    assert.equal(a.body.group.archived, true);
    const flat = (await agent.get('/api/v1/groups').expect(200)).body.groups;
    assert.ok(!flat.some((g) => g.id === team.id));
    assert.ok((await agent.get('/api/v1/groups?archived=1').expect(200)).body.groups.some((g) => g.id === team.id));
    await api('post', `/api/v1/groups/${team.id}/unarchive`).expect(200);
    const wrong = await api('delete', `/api/v1/groups/${team.id}?confirm=Falsch`);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'CONFIRM_MISMATCH');
    const kids = await api('delete', `/api/v1/groups/${dep.id}?confirm=Verwaltung`);
    assert.equal(kids.body.code, 'HAS_CHILDREN');
    await api('delete', `/api/v1/groups/${team.id}?confirm=${encodeURIComponent('Finanzen')}`).expect(200);
    assert.equal((await agent.get(`/api/v1/groups/${team.id}`)).status, 404);
  });

  it('read-only groups answer 403 READ_ONLY', async () => {
    const groups = require('../src/services/groups');
    const d = groups.create({ kind: 'team', name: 'AD Gruppe', source: 'directory:1', externalId: 'guid-1' });
    const r = await api('patch', `/api/v1/groups/${d.id}`).send({ name: 'Neu' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'READ_ONLY');
    await api('patch', `/api/v1/groups/${d.id}`).send({ color: '#10b981' }).expect(200);
    const del = await api('delete', `/api/v1/groups/${d.id}?confirm=AD%20Gruppe`);
    assert.equal(del.status, 403);
  });
});

describe('pages', () => {
  it('renders /groups for admins with the island and the dialogs', async () => {
    const res = await agent.get('/groups').expect(200);
    for (const id of ['grp-page', 'grp-tree', 'grp-detail', 'grp-dlg-create', 'grp-dlg-delete', 'grp-dlg-import', 'grp-dlg-member', 'grp-dlg-invite', 'grp-i18n']) {
      assert.ok(res.text.includes(`id="${id}"`), id);
    }
    assert.match(res.text, /href="\/groups" class="nav-item nav-item-sub active"/);
    assert.match(res.text, /"grp\.add":/);
    assert.match(res.text, /\/js\/groups\.js\?v=/);
  });
});

describe('invitation link page', () => {
  let groupId, token, link;
  before(async () => {
    const groups = require('../src/services/groups');
    groupId = groups.create({ kind: 'team', name: 'Einladungsteam' }).id;
    token = groups.createInvite(groupId, { maxUses: 1 }).token;
    link = `/portal/groups/join/${token}`;
  });

  it('an unknown token gets the invalid page', async () => {
    const r = await supertest(app).get('/portal/groups/join/' + 'x'.repeat(43));
    assert.equal(r.status, 404);
    assert.match(r.text, /data-group-join="invalid"/);
  });

  it('signed out: login link with returnTo back to the invitation', async () => {
    const r = await supertest(app).get(link).expect(200);
    assert.match(r.text, /data-group-join="valid"/);
    assert.ok(r.text.includes('/login?returnTo=' + encodeURIComponent(link)), 'login link');
    assert.equal(r.headers['cache-control'], 'no-store');
    // POST without a session: the CSRF check or the login redirect stops it
    const p = await supertest(app).post(link).type('form').send({});
    assert.ok([302, 403].includes(p.status));
    assert.equal(require('../src/services/groups').members(groupId).length, 0);
  });

  it('signed in: joins once; the link is used up afterwards', async () => {
    const uid = await createLoginUser('joiner');
    const { a, location } = await loginAs('joiner', undefined, link);
    assert.equal(location, link, 'the login comes back to the invitation');
    const page = await a.get(link).expect(200);
    const formCsrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const done = await a.post(link).type('form').send({ _csrf: formCsrf }).expect(200);
    assert.match(done.text, /data-group-join="done"/);
    assert.equal(require('../src/services/groups').isMember(uid, groupId), true);
    const again = await a.get(link);
    assert.equal(again.status, 404, 'maxUses reached');
  });
});
