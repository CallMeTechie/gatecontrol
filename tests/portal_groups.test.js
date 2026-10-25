'use strict';

// Portal "Meine Gruppen" (docs/groups.md "Portal"): /api/v1/portal/groups for
// signed-in people only (never device trust, never a kiosk device); members
// see their groups, leads and group admins maintain theirs (members, roles,
// invitation links) — local groups fully, directory groups only their extra
// local members, plugin groups never; lead / parent only by server admins,
// nobody changes their own membership. The tab, the panel and the strings.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const HOME = `home.${config.dns.domain}`;
const ROOT = path.join(__dirname, '..');
let app, groups;
const U = {};
const S = {};
let team, dept, dir, plug;

function portalAgent(ip) {
  const a = supertest.agent(app);
  const wrap = (m) => (p) => a[m](p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), delete: wrap('delete') };
}
async function signedIn(userId) {
  const dev = H.makeDevice(userId, { name: 'pg-phone' });
  const r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${dev.raw}`).send({}).expect(200);
  const p = portalAgent(dev.ip);
  await p.get('/auto?t=' + new URL(r.body.url).searchParams.get('t')).expect(302);
  const page = await p.get('/portal').expect(200);
  const ctx = JSON.parse(page.text.match(/id="portal-ctx"[^>]*>([^<]*)</)[1]);
  const csrf = ctx.csrf;
  const w = (m) => (u) => p[m](u).set('X-CSRF-Token', csrf);
  return { p, ctx, html: page.text, dev, post: w('post'), put: w('put'), del: w('delete') };
}
function uname(id) { return H.db().prepare('SELECT username FROM users WHERE id = ?').get(id).username; }
function setEmail(id, email) { H.db().prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id); }

before(async () => {
  ({ app } = await setup());
  groups = require('../src/services/groups');
  for (const n of ['anna', 'ben', 'carla', 'dora', 'eve', 'frank', 'gina']) U[n] = H.makeUser('pg-' + n);
  U.off = H.makeUser('pg-off', { enabled: 0 });
  setEmail(U.frank, 'Frank@Example.org');
  setEmail(U.off, 'off@example.org');
  dept = groups.create({ kind: 'department', name: 'PG Abteilung' });
  team = groups.create({ kind: 'team', name: 'PG Team', parentId: dept.id });
  const sub = groups.create({ kind: 'team', name: 'PG Sub', parentId: team.id });
  groups.setMember(team.id, U.anna, 'lead');
  groups.setMember(team.id, U.ben, 'admin');
  groups.setMember(team.id, U.carla, 'member');
  groups.setMember(sub.id, U.gina, 'member');
  dir = groups.create({ kind: 'team', name: 'PG Verzeichnis', source: 'directory:ad1', externalId: 'cn=pg' }, { owner: 'directory:ad1' });
  groups.setMember(dir.id, U.eve, 'member', { owner: 'directory:ad1', source: 'directory:ad1' });
  groups.setMember(dir.id, U.anna, 'admin');
  plug = groups.create({ kind: 'team', name: 'PG Plugin', source: 'plugin:pg-test', externalId: 'k' }, { owner: 'plugin:pg-test' });
  groups.setMember(plug.id, U.anna, 'lead', { owner: 'plugin:pg-test', source: 'plugin:pg-test' });
  for (const n of ['anna', 'ben', 'carla', 'dora']) S[n] = await signedIn(U[n]);
});
after(() => teardown());

describe('who may use it', () => {
  it('nobody without a sign-in: anonymous and device trust get 401', async () => {
    const anon = await supertest(app).get('/api/v1/portal/groups').set('Host', HOME);
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'LOGIN_REQUIRED');
    const trust = portalAgent(S.anna.dev.ip); // the device is known, nobody signed in
    for (const p of ['/api/v1/portal/groups', `/api/v1/portal/groups/${team.id}`, '/api/v1/portal/groups/principals']) {
      assert.equal((await trust.get(p)).status, 401, p);
    }
  });

  it('kiosk devices never reach it (the kiosk allow-list refuses every path)', () => {
    const { kioskAllowed } = require('../src/middleware/kioskSession');
    for (const [m, p] of [['GET', '/api/v1/portal/groups'], ['GET', `/api/v1/portal/groups/${team.id}`], ['GET', '/api/v1/portal/groups/principals'],
      ['POST', `/api/v1/portal/groups/${team.id}/members`], ['PUT', `/api/v1/portal/groups/${team.id}/members/1`],
      ['DELETE', `/api/v1/portal/groups/${team.id}/members/1`], ['POST', `/api/v1/portal/groups/${team.id}/invites`]]) {
      assert.equal(kioskAllowed(m, p), false, `${m} ${p}`);
    }
  });

  it('writes need the session\'s CSRF token', async () => {
    const r = await S.anna.p.post(`/api/v1/portal/groups/${team.id}/members`).send({ login: uname(U.dora) });
    assert.equal(r.status, 403);
  });
});

describe('a member', () => {
  it('sees own groups (direct and inherited) with role, path, source and leadership — no member list', async () => {
    const r = await S.carla.p.get('/api/v1/portal/groups').expect(200);
    const byId = Object.fromEntries(r.body.groups.map((g) => [g.id, g]));
    assert.deepEqual([byId[team.id].role, byId[team.id].direct, byId[team.id].manage, byId[team.id].sourceKind], ['member', true, false, 'local']);
    assert.equal(byId[team.id].path, 'PG Abteilung › PG Team');
    assert.deepEqual([byId[dept.id].role, byId[dept.id].direct], ['member', false]);
    assert.deepEqual(byId[team.id].leaders.map((l) => [l.userId, l.role]), [[U.anna, 'lead']]);
    const d = await S.carla.p.get(`/api/v1/portal/groups/${team.id}`).expect(200);
    assert.equal(d.body.manage, false);
    assert.equal(d.body.members, undefined);
    assert.equal(d.body.invites, undefined);
    assert.deepEqual(d.body.leaders.map((l) => l.name), ['pg-anna']);
  });

  it('cannot add, change, remove or invite', async () => {
    const id = team.id;
    assert.equal((await S.carla.post(`/api/v1/portal/groups/${id}/members`).send({ login: uname(U.dora) })).body.code, 'NOT_MANAGER');
    assert.equal((await S.carla.put(`/api/v1/portal/groups/${id}/members/${U.ben}`).send({ role: 'member' })).status, 403);
    assert.equal((await S.carla.del(`/api/v1/portal/groups/${id}/members/${U.ben}`)).status, 403);
    assert.equal((await S.carla.post(`/api/v1/portal/groups/${id}/invites`).send({})).status, 403);
    assert.equal((await S.carla.p.get(`/api/v1/portal/groups/${id}/invites`)).status, 403);
    // a lead of a parent group does not manage the subgroup either: only a direct role counts
    assert.equal((await S.anna.p.get(`/api/v1/portal/groups/${dept.id}`).expect(200)).body.manage, false);
  });

  it('somebody outside the group sees nothing of it; the tab is hidden without any group', async () => {
    const r = await S.dora.p.get(`/api/v1/portal/groups/${team.id}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NOT_MEMBER');
    assert.equal((await S.dora.p.get('/api/v1/portal/groups/999999')).status, 404);
    assert.deepEqual((await S.dora.p.get('/api/v1/portal/groups').expect(200)).body.groups, []);
    assert.equal(S.dora.ctx.tabs.groups, false);
    assert.ok(!S.dora.html.includes('id="panel-gruppen"'));
  });
});

describe('the lead', () => {
  it('sees the members with what may be changed, the roles to give and the invitation links', async () => {
    const d = (await S.anna.p.get(`/api/v1/portal/groups/${team.id}`).expect(200)).body;
    assert.equal(d.manage, true);
    assert.deepEqual(d.roles, ['member', 'deputy', 'admin']);
    const m = Object.fromEntries(d.members.map((x) => [x.userId, x]));
    assert.deepEqual([m[U.anna].self, m[U.anna].canEditRole, m[U.anna].canRemove], [true, false, false], 'never the own membership');
    assert.deepEqual([m[U.ben].canEditRole, m[U.ben].canRemove], [true, true]);
    assert.deepEqual([m[U.gina].direct, m[U.gina].canEditRole, m[U.gina].canRemove], [false, false, false], 'from a subgroup');
    assert.ok('email' in m[U.carla]);
    assert.deepEqual(d.invites, []);
  });

  it('adds an existing person by exact user name or e-mail address (one answer for unknown and disabled)', async () => {
    const add = (login, role) => S.anna.post(`/api/v1/portal/groups/${team.id}/members`).send({ login, role });
    let r = await add(uname(U.dora).toUpperCase());
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.member.userId, r.body.member.role], [U.dora, 'member']);
    r = await add('frank@example.org', 'deputy');
    assert.equal(r.status, 201);
    assert.equal(r.body.member.userId, U.frank);
    assert.equal((await add(uname(U.dora))).body.code, 'ALREADY_MEMBER');
    const unknown = await add('nobody@example.org');
    const disabled = await add('off@example.org');
    assert.deepEqual([unknown.status, unknown.body.code], [404, 'USER_NOT_FOUND']);
    assert.deepEqual([disabled.status, disabled.body.code, disabled.body.error], [404, 'USER_NOT_FOUND', unknown.body.error]);
    assert.equal((await add(uname(U.eve), 'lead')).body.code, 'INVALID_ROLE');
    assert.equal((await add('')).status, 400);
    const row = H.db().prepare("SELECT source, details FROM activity_log WHERE event_type = 'group_member_added' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.source, 'user');
    assert.equal(JSON.parse(row.details).actorId, U.anna);
  });

  it('sets roles member / deputy / admin; the deputy shows up as leadership', async () => {
    const put = (uid, role) => S.anna.put(`/api/v1/portal/groups/${team.id}/members/${uid}`).send({ role });
    assert.equal((await put(U.carla, 'deputy')).status, 200);
    const leaders = (await S.carla.p.get(`/api/v1/portal/groups/${team.id}`).expect(200)).body.leaders;
    assert.deepEqual(leaders.map((l) => [l.userId, l.role]), [[U.anna, 'lead'], [U.frank, 'deputy']], 'nobody is their own leader');
    const g = (await S.dora.p.get('/api/v1/portal/groups').expect(200)).body.groups.find((x) => x.id === team.id);
    assert.deepEqual(g.leaders[0], { userId: U.anna, name: 'pg-anna', role: 'lead', groupId: team.id }, 'lead before deputies');
    assert.deepEqual(g.leaders.slice(1).map((l) => [l.userId, l.role]).sort((a, b) => a[0] - b[0]), [[U.carla, 'deputy'], [U.frank, 'deputy']].sort((a, b) => a[0] - b[0]));
    assert.equal((await put(U.carla, 'lead')).body.code, 'PROTECTED', 'lead only by server admins');
    assert.equal((await put(U.carla, 'boss')).body.code, 'INVALID_ROLE');
    assert.equal((await put(U.anna, 'member')).body.code, 'SELF');
    assert.equal((await put(U.gina, 'admin')).status, 404, 'a member from a subgroup is no direct member');
    assert.equal((await put(U.carla, 'member')).status, 200);
  });

  it('removes local members, never itself', async () => {
    assert.equal((await S.anna.del(`/api/v1/portal/groups/${team.id}/members/${U.dora}`)).status, 200);
    assert.equal(groups.isMember(U.dora, team.id), false);
    assert.equal((await S.anna.del(`/api/v1/portal/groups/${team.id}/members/${U.dora}`)).status, 404);
    assert.equal((await S.anna.del(`/api/v1/portal/groups/${team.id}/members/${U.anna}`)).body.code, 'SELF');
  });

  it('creates, lists and revokes invitation links within the limits of the admin page', async () => {
    const r = await S.anna.post(`/api/v1/portal/groups/${team.id}/invites`).send({ role: 'member', expiresInDays: 7, maxUses: 3 });
    assert.equal(r.status, 201);
    assert.match(r.body.invite.url, /\/portal\/groups\/join\/[A-Za-z0-9_-]{43}$/);
    assert.equal(r.body.invite.maxUses, 3);
    const list = (await S.anna.p.get(`/api/v1/portal/groups/${team.id}/invites`).expect(200)).body.invites;
    assert.deepEqual(list.map((i) => i.id), [r.body.invite.id]);
    assert.equal((await S.anna.p.get(`/api/v1/portal/groups/${team.id}`).expect(200)).body.invites.length, 1);
    assert.equal((await S.anna.post(`/api/v1/portal/groups/${team.id}/invites`).send({ role: 'lead' })).body.code, 'PROTECTED');
    assert.equal((await S.anna.post(`/api/v1/portal/groups/${team.id}/invites`).send({ expiresInDays: 31 })).body.code, 'INVALID');
    assert.equal((await S.anna.post(`/api/v1/portal/groups/${team.id}/invites`).send({ maxUses: 501 })).body.code, 'INVALID');
    // the link works like one from the admin page
    const accepted = groups.acceptInvite(r.body.invite.token, U.eve);
    assert.deepEqual([accepted.groupId, accepted.role, accepted.already], [team.id, 'member', false]);
    assert.equal((await S.anna.del(`/api/v1/portal/groups/${team.id}/invites/${r.body.invite.id}`)).status, 200);
    assert.equal((await S.anna.del(`/api/v1/portal/groups/${team.id}/invites/${r.body.invite.id}`)).status, 404);
    assert.equal(groups.lookupInvite(r.body.invite.token), null);
  });
});

describe('the group admin', () => {
  it('maintains members and links but never touches the lead', async () => {
    const d = (await S.ben.p.get(`/api/v1/portal/groups/${team.id}`).expect(200)).body;
    assert.equal(d.manage, true);
    const anna = d.members.find((m) => m.userId === U.anna);
    assert.deepEqual([anna.canEditRole, anna.canRemove], [false, false]);
    assert.equal((await S.ben.put(`/api/v1/portal/groups/${team.id}/members/${U.anna}`).send({ role: 'member' })).body.code, 'PROTECTED');
    assert.equal((await S.ben.del(`/api/v1/portal/groups/${team.id}/members/${U.anna}`)).body.code, 'PROTECTED');
    assert.equal((await S.ben.post(`/api/v1/portal/groups/${team.id}/members`).send({ login: uname(U.dora) })).status, 201);
    assert.equal((await S.ben.post(`/api/v1/portal/groups/${team.id}/invites`).send({})).status, 201);
  });
});

describe('directory and plugin groups', () => {
  it('directory group: only extra local members can be added, changed and removed', async () => {
    const d = (await S.anna.p.get(`/api/v1/portal/groups/${dir.id}`).expect(200)).body;
    assert.equal(d.manage, true);
    assert.equal(d.group.sourceKind, 'directory');
    const eve = d.members.find((m) => m.userId === U.eve);
    assert.deepEqual([eve.source, eve.canEditRole, eve.canRemove], ['directory', false, false]);
    assert.equal((await S.anna.del(`/api/v1/portal/groups/${dir.id}/members/${U.eve}`)).body.code, 'READ_ONLY');
    assert.equal((await S.anna.put(`/api/v1/portal/groups/${dir.id}/members/${U.eve}`).send({ role: 'deputy' })).body.code, 'READ_ONLY');
    assert.equal((await S.anna.post(`/api/v1/portal/groups/${dir.id}/members`).send({ login: uname(U.frank) })).status, 201);
    const frank = (await S.anna.p.get(`/api/v1/portal/groups/${dir.id}`).expect(200)).body.members.find((m) => m.userId === U.frank);
    assert.deepEqual([frank.source, frank.canEditRole, frank.canRemove], ['local', true, true]);
    assert.equal((await S.anna.del(`/api/v1/portal/groups/${dir.id}/members/${U.frank}`)).status, 200);
    assert.equal((await S.anna.post(`/api/v1/portal/groups/${dir.id}/invites`).send({})).status, 201);
  });

  it('plugin group: read-only even for its lead', async () => {
    const list = (await S.anna.p.get('/api/v1/portal/groups').expect(200)).body.groups;
    const g = list.find((x) => x.id === plug.id);
    assert.deepEqual([g.role, g.manage, g.sourceKind], ['lead', false, 'plugin']);
    const d = (await S.anna.p.get(`/api/v1/portal/groups/${plug.id}`).expect(200)).body;
    assert.equal(d.manage, false);
    assert.equal((await S.anna.post(`/api/v1/portal/groups/${plug.id}/members`).send({ login: uname(U.dora) })).body.code, 'NOT_MANAGER');
    assert.equal((await S.anna.post(`/api/v1/portal/groups/${plug.id}/invites`).send({})).body.code, 'NOT_MANAGER');
  });
});

describe('GC.pickPrincipals in the portal', () => {
  it('every group by name and only the viewer as a person', async () => {
    const r = (await S.carla.p.get('/api/v1/portal/groups/principals').expect(200)).body;
    assert.ok(r.groups.some((g) => g.label === 'PG Abteilung › PG Team'));
    assert.ok(r.groups.every((g) => Object.keys(g).sort().join() === 'id,label,sub'), 'no member lists');
    assert.deepEqual(r.users, [{ id: U.carla, label: 'pg-carla', sub: '', self: true }]);
  });
});

describe('the portal page', () => {
  it('signed-in members get the tab "Gruppen" and its panel', async () => {
    assert.equal(S.anna.ctx.tabs.groups, true);
    assert.match(S.anna.html, /id="tab-gruppen" href="#gruppen" data-tab="gruppen"/);
    assert.match(S.anna.html, /id="panel-gruppen" role="tabpanel"[^>]*data-panel="gruppen" hidden/);
    for (const id of ['pt-grp-chips', 'pt-grp-main', 'pt-grp-side']) assert.ok(S.anna.html.includes(`id="${id}"`), id);
    const i18n = JSON.parse(S.anna.html.match(/id="portal-i18n"[^>]*>([^<]*)</)[1]);
    assert.ok(i18n['grp.role.deputy'] && i18n['grp.kind.team'] && i18n['portal.groups.title']);
  });

  it('portal.js uses only strings that exist in both languages', () => {
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'portal.js'), 'utf8');
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const keys = new Set((js.match(/'portal\.groups\.[a-z_.]+'/g) || []).map((k) => k.slice(1, -1)));
    assert.ok(keys.size > 30);
    for (const k of keys) {
      if (k.endsWith('.')) continue; // prefixes (portal.groups.src.)
      if (k === 'portal.groups.people') { assert.ok(de[k + '_one'] && en[k + '_other']); continue; }
      assert.ok(de[k] && en[k], k);
    }
    for (const s of ['local', 'directory', 'plugin']) assert.ok(de[`portal.groups.src.${s}`] && en[`portal.groups.src.${s}`], s);
    for (const k of Object.keys(de).filter((x) => x.startsWith('error.groups.portal.'))) assert.ok(en[k], k);
  });
});
