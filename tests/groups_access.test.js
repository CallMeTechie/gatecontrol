'use strict';

// Zugriff per Gruppe (docs/groups.md, services/groupAccess.js): HTTP routes
// and RDP entries restricted to persons ∪ effective group members — client
// API, RDP ACL, "Was sieht <Name>?", route login of the apps, the Caddy peer
// ACL (devices of members) with the throttled reload, the admin preview and
// the routes API.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf;
before(async () => {
  ({ app, agent, csrfToken: csrf } = await setup());
  // No Caddy in the test environment.
  require('../src/services/caddyConfig').syncToCaddy = async () => true;
});
after(() => teardown());

function db() { return require('../src/db/connection').getDb(); }
const groups = () => require('../src/services/groups');
const access = () => require('../src/services/groupAccess');

let seq = 0;
function user(name, { enabled = 1 } = {}) {
  return Number(db().prepare("INSERT INTO users (username, display_name, password_hash, role, enabled) VALUES (?, ?, 'x', 'user', ?)")
    .run(`${name}-${++seq}`, name, enabled).lastInsertRowid);
}
function route(domain, { userIds, acl = 0, external = 1 } = {}) {
  return Number(db().prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, user_ids, acl_enabled, external_enabled, https_enabled)
    VALUES (?, '10.0.0.5', 80, 'http', 1, ?, ?, ?, 1)`).run(domain, userIds ? JSON.stringify(userIds) : null, acl, external).lastInsertRowid);
}
function peer(name, ip, userId = null) {
  return Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, user_id) VALUES (?, ?, ?, 1, ?)")
    .run(name, 'pk-' + name + '-' + (++seq), ip + '/32', userId).lastInsertRowid);
}
function tokenFor(userId, peerId) {
  return Number(db().prepare("INSERT INTO api_tokens (name, token_hash, scopes, user_id, peer_id) VALUES (?, ?, '[\"client\"]', ?, ?)")
    .run('t' + (++seq), crypto.randomBytes(16).toString('hex'), userId, peerId).lastInsertRowid);
}
const visibleTo = (uid) => require('../src/services/routes').getForUser(uid).map((r) => r.domain);

describe('HTTP routes and RDP: persons ∪ group members', () => {
  let anna, ben, cara, dora, dep, team, sub, proj;
  let rOpen, rPersons, rGroup, rMixed, rArchived, rStale;

  before(() => {
    anna = user('Anna'); ben = user('Ben'); cara = user('Cara'); dora = user('Dora');
    dep = groups().create({ kind: 'department', name: 'Verwaltung' });
    team = groups().create({ kind: 'team', name: 'Buchhaltung', parentId: dep.id });
    sub = groups().create({ kind: 'team', name: 'Team A', parentId: team.id });
    proj = groups().create({ kind: 'project', name: 'Altprojekt' });
    groups().setMember(sub.id, anna);            // nested: Team A ⊂ Buchhaltung ⊂ Verwaltung
    groups().setMember(team.id, ben, 'lead');
    groups().setMember(proj.id, cara);
    groups().archive(proj.id);
    rOpen = route('open.ga.test');
    rPersons = route('persons.ga.test', { userIds: [dora] });
    rGroup = route('group.ga.test');
    access().setRouteGroups(rGroup, [dep.id]);
    rMixed = route('mixed.ga.test', { userIds: [dora] });
    access().setRouteGroups(rMixed, [team.id]);
    rArchived = route('archived.ga.test');
    access().setRouteGroups(rArchived, [proj.id]);
    rStale = route('stale.ga.test', { userIds: [987654] });
  });

  it('client API (routes.getForUser): nested members, groups-only, mixed, archived, stale', () => {
    assert.deepEqual(visibleTo(anna).filter((d) => d.endsWith('.ga.test')).sort(),
      ['group.ga.test', 'mixed.ga.test', 'open.ga.test'], 'Anna via Team A (subgroup) sees group + mixed');
    assert.deepEqual(visibleTo(dora).filter((d) => d.endsWith('.ga.test')).sort(),
      ['mixed.ga.test', 'open.ga.test', 'persons.ga.test'], 'Dora is named');
    assert.deepEqual(visibleTo(cara).filter((d) => d.endsWith('.ga.test')), ['open.ga.test'], 'archived group grants nothing');
    assert.deepEqual(visibleTo(null).filter((d) => d.endsWith('.ga.test')), ['open.ga.test'], 'no person → only open');
    assert.ok(!visibleTo(anna).includes('stale.ga.test') && !visibleTo(dora).includes('stale.ga.test'), 'stale id keeps it hidden');
  });

  it('a disabled member drops out at once, enabling brings access back', () => {
    assert.ok(visibleTo(ben).includes('group.ga.test'));
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(ben);
    assert.ok(!visibleTo(ben).includes('group.ga.test'));
    assert.ok(!access().effectiveUsers({ groups: [team.id] }).has(ben));
    db().prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(ben);
    assert.ok(visibleTo(ben).includes('group.ga.test'));
  });

  it('leaving the group ends access on the next request', () => {
    groups().removeMember(sub.id, anna);
    assert.ok(!visibleTo(anna).includes('group.ga.test'));
    groups().setMember(sub.id, anna);
    assert.ok(visibleTo(anna).includes('group.ga.test'));
  });

  it('deleting the only group of a route keeps the route closed (NOBODY marker)', () => {
    const solo = groups().create({ kind: 'team', name: 'Kurzzeit' });
    groups().setMember(solo.id, cara);
    const r = route('solo.ga.test');
    access().setRouteGroups(r, [solo.id]);
    assert.ok(visibleTo(cara).includes('solo.ga.test'));
    groups().remove(solo.id, { confirmName: 'Kurzzeit' });
    const row = db().prepare('SELECT user_ids FROM routes WHERE id = ?').get(r);
    assert.equal(row.user_ids, '[0]');
    assert.equal(access().routeGroupIds(r).length, 0);
    for (const u of [anna, ben, cara, dora, null]) assert.ok(!visibleTo(u).includes('solo.ga.test'), `hidden for ${u}`);
    // a route that still names a person keeps its person list
    const g2 = groups().create({ kind: 'team', name: 'Kurzzeit2' });
    const r2 = route('solo2.ga.test', { userIds: [dora] });
    access().setRouteGroups(r2, [g2.id]);
    groups().remove(g2.id, { confirmName: 'Kurzzeit2' });
    assert.equal(db().prepare('SELECT user_ids FROM routes WHERE id = ?').get(r2).user_ids, JSON.stringify([dora]));
  });

  it('rdpAcl.canAccessRoute stays pure: groups via userGroups / groupsOf, fail closed without', () => {
    const { canAccessRoute } = require('../src/services/rdpAcl');
    const r = { user_ids: null, group_ids: JSON.stringify([7]), token_ids: JSON.stringify([1]) };
    assert.equal(canAccessRoute(r, 1, 5), false, 'no membership info → closed (token list ignored)');
    assert.equal(canAccessRoute(r, 1, 5, { userGroups: new Set([7]) }), true);
    assert.equal(canAccessRoute(r, 1, 5, { userGroups: [8] }), false);
    assert.equal(canAccessRoute(r, 1, 5, { groupsOf: () => [7] }), true);
    assert.equal(canAccessRoute(r, 1, null, { groupsOf: () => [7] }), false, 'no person → closed');
    assert.equal(canAccessRoute({ user_ids: '[5]', group_ids: '[7]' }, null, 5), true, 'named person');
    assert.equal(canAccessRoute({ group_ids: 'not-json' }, null, 5), true, 'malformed → no restriction');
  });

  it('RDP entries: list, by id and the user profile listing follow the same rule', async () => {
    const rdp = require('../src/services/rdp');
    const mk = (name, data) => db().prepare(`INSERT INTO rdp_routes (name, host, port, enabled, user_ids, group_ids) VALUES (?, '10.0.0.9', 3389, 1, ?, ?)`)
      .run(name, data.user_ids ? JSON.stringify(data.user_ids) : null, data.group_ids ? JSON.stringify(data.group_ids) : null).lastInsertRowid;
    const gRdp = mk('ga-rdp-group', { group_ids: [dep.id] });
    const aRdp = mk('ga-rdp-archived', { group_ids: [proj.id] });
    const mRdp = mk('ga-rdp-mixed', { user_ids: [dora], group_ids: [team.id] });
    const names = (uid) => rdp.getForToken(null, uid).map((r) => r.name).filter((n) => n.startsWith('ga-rdp'));
    assert.deepEqual(names(anna).sort(), ['ga-rdp-group', 'ga-rdp-mixed']);
    assert.deepEqual(names(dora), ['ga-rdp-mixed']);
    assert.deepEqual(names(cara), []);
    const row = db().prepare('SELECT * FROM rdp_routes WHERE id = ?').get(gRdp);
    assert.equal(rdp.canAccessRoute(row, null, anna), true, 'by id (wrapper resolves groups)');
    assert.equal(rdp.canAccessRoute(row, null, cara), false);
    assert.equal(rdp.canAccessRoute(db().prepare('SELECT * FROM rdp_routes WHERE id = ?').get(aRdp), null, cara), false);
    assert.ok(mRdp);

    const vis = require('../src/services/userVisibility').forUser(anna);
    const svc = vis.services.visible.find((e) => e.host === 'group.ga.test');
    assert.equal(svc.reason, 'group');
    assert.deepEqual(svc.groups, ['Verwaltung']);
    const rd = vis.rdp.visible.find((e) => e.name === 'ga-rdp-mixed');
    assert.equal(rd.reason, 'group');
    assert.deepEqual(rd.groups, ['Verwaltung › Buchhaltung']);
    const self = require('../src/services/userVisibility').servicesForSelf(anna).map((e) => e.name);
    assert.ok(self.includes('ga-rdp-group') && self.includes('group.ga.test'));
  });

  it('RDP create/update validate group ids (exist, not archived; stored ones are kept)', async () => {
    const rdp = require('../src/services/rdp');
    await assert.rejects(rdp.create({ name: 'ga-v1', host: '10.0.0.8', group_ids: [99999] }), (e) => e.fields && e.fields.group_ids && e.code === 'GROUP_NOT_FOUND');
    await assert.rejects(rdp.create({ name: 'ga-v2', host: '10.0.0.8', group_ids: [proj.id] }), (e) => e.code === 'GROUP_ARCHIVED');
    await assert.rejects(rdp.create({ name: 'ga-v3', host: '10.0.0.8', group_ids: 'x' }), (e) => e.code === 'GROUPS_INVALID');
    const created = await rdp.create({ name: 'ga-v4', host: '10.0.0.8', group_ids: [team.id], user_ids: [] });
    const row = db().prepare('SELECT user_ids, group_ids FROM rdp_routes WHERE id = ?').get(created.id);
    assert.equal(row.group_ids, JSON.stringify([team.id]));
    assert.equal(row.user_ids, null);
    // archive the stored group: an update that keeps it is fine, a new archived one is not
    const g = groups().create({ kind: 'project', name: 'Zwischenprojekt' });
    await rdp.update(created.id, { group_ids: [team.id, g.id] });
    groups().archive(g.id);
    await rdp.update(created.id, { group_ids: [g.id], description: 'x' });
    assert.equal(db().prepare('SELECT group_ids FROM rdp_routes WHERE id = ?').get(created.id).group_ids, JSON.stringify([g.id]));
    await rdp.update(created.id, { group_ids: [] });
    assert.equal(db().prepare('SELECT group_ids FROM rdp_routes WHERE id = ?').get(created.id).group_ids, null);
  });

  it('route login of the apps: the session is re-checked on every request', async () => {
    const domain = 'applogin.ga.test';
    const r = route(domain);
    access().setRouteGroups(r, [team.id]);
    db().prepare("INSERT INTO route_auth (route_id, auth_type, email) VALUES (?, 'email_password', 'x@example.com')").run(r);
    const ra = require('../src/services/routeAuth');
    const s1 = ra.createSession(r, `app:user:${ben}`, '127.0.0.1', 3600000, false).id;
    const s2 = ra.createSession(r, 'app:token:1', '127.0.0.1', 3600000, false).id;
    const s3 = ra.createSession(r, 'x@example.com', '127.0.0.1', 3600000, false).id;
    const verify = (sid) => supertest(app).get('/route-auth/verify').set('X-Route-Domain', domain).set('Cookie', `gc.route.sid=${sid}`);
    assert.equal((await verify(s1)).status, 200, 'member');
    assert.equal((await verify(s2)).status, 401, 'token without person: restricted route');
    assert.equal((await verify(s3)).status, 200, 'route credentials are not GateControl accounts');
    groups().removeMember(team.id, ben);
    assert.equal((await verify(s1)).status, 401, 'left the group');
    groups().setMember(team.id, ben, 'lead');
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(ben);
    assert.equal((await verify(s1)).status, 401, 'disabled account');
    db().prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(ben);
    assert.equal((await verify(s1)).status, 200);
  });
});

// ─── Caddy peer ACL ─────────────────────────────────────────────────────

function rangesOf(cfg, domain) {
  const out = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.remote_ip && Array.isArray(node.remote_ip.ranges)) node.remote_ip.ranges.forEach((r) => out.add(r));
    Object.values(node).forEach(walk);
  };
  for (const srv of Object.values(cfg.apps.http.servers)) {
    for (const r of srv.routes || []) {
      if (JSON.stringify(r.match || []).includes(domain)) walk(r);
    }
  }
  return [...out].sort();
}

describe('Caddy peer ACL: devices of released persons and group members', () => {
  let eva, finn, grp, rid, pExplicit, pEva, pEvaToken, pFinn;
  const build = () => require('../src/services/caddyConfig').buildCaddyConfig(
    db().prepare('SELECT * FROM routes WHERE id = ?').all(rid));

  before(() => {
    eva = user('Eva'); finn = user('Finn');
    grp = groups().create({ kind: 'team', name: 'ACL-Team' });
    groups().setMember(grp.id, eva);
    pExplicit = peer('acl-laptop', '10.8.0.41');
    pEva = peer('acl-eva-phone', '10.8.0.42', eva);
    pEvaToken = peer('acl-eva-app', '10.8.0.43');
    tokenFor(eva, pEvaToken);
    pFinn = peer('acl-finn', '10.8.0.44', finn);
    rid = route('acl.ga.test', { acl: 1 });
    require('../src/services/caddyAcl').setAclPeers(rid, [pExplicit]);
    access().setRouteGroups(rid, [grp.id]);
  });

  it('allowed source IPs = listed devices ∪ devices (owned + token-bound) of group members', () => {
    assert.deepEqual(rangesOf(build(), 'acl.ga.test'), ['10.8.0.41/32', '10.8.0.42/32', '10.8.0.43/32']);
    const peers = access().aclPeers(db().prepare('SELECT * FROM routes WHERE id = ?').get(rid));
    assert.deepEqual(peers.map((p) => p.peerId).sort((a, b) => a - b), [pExplicit, pEva, pEvaToken]);
    assert.ok(!peers.some((p) => p.peerId === pFinn));
  });

  it('named persons bring their devices too; membership changes and disabled accounts drop them', () => {
    db().prepare('UPDATE routes SET user_ids = ? WHERE id = ?').run(JSON.stringify([finn]), rid);
    assert.ok(rangesOf(build(), 'acl.ga.test').includes('10.8.0.44/32'));
    db().prepare('UPDATE routes SET user_ids = NULL WHERE id = ?').run(rid);
    groups().removeMember(grp.id, eva);
    assert.deepEqual(rangesOf(build(), 'acl.ga.test'), ['10.8.0.41/32']);
    groups().setMember(grp.id, eva);
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(eva);
    assert.deepEqual(rangesOf(build(), 'acl.ga.test'), ['10.8.0.41/32'], 'disabled account: devices drop out');
    db().prepare('UPDATE users SET enabled = 1 WHERE id = ?').run(eva);
  });

  it('something listed but no address left → fails closed; nothing listed keeps the old behaviour', () => {
    const empty = groups().create({ kind: 'team', name: 'ACL-Leer' });
    const r2 = route('acl2.ga.test', { acl: 1 });
    access().setRouteGroups(r2, [empty.id]);
    const r3 = route('acl3.ga.test', { acl: 1 });
    const cfg = require('../src/services/caddyConfig').buildCaddyConfig(db().prepare('SELECT * FROM routes WHERE id IN (?, ?)').all(r2, r3));
    assert.deepEqual(rangesOf(cfg, 'acl2.ga.test'), ['0.0.0.0/32']);
    assert.deepEqual(rangesOf(cfg, 'acl3.ga.test'), [], 'external route, ACL without anything listed: no peer matcher (as before)');
    assert.deepEqual(access().aclRanges({ id: r2, user_ids: null }), { configured: true, ranges: [] });
  });

  it('createReloader: at most one reload per interval, requests join the pending one', () => {
    let now = 0;
    const timers = [];
    let reloads = 0;
    const r = access().createReloader({
      reload: () => { reloads++; }, intervalMs: 5000, now: () => now,
      setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
      clearTimer: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    });
    const runDue = () => { for (const t of timers.splice(0)) { now = Math.max(now, t.at); t.fn(); } };
    assert.equal(r.request(), true);
    assert.equal(timers[0].at, 0, 'first reload right away');
    assert.equal(r.request(), false, 'joins the pending one');
    runDue();
    assert.equal(reloads, 1);
    now = 1000;
    r.request();
    assert.equal(timers[0].at, 5000, 'next one waits for the interval');
    r.request(); r.request();
    assert.equal(timers.length, 1);
    runDue();
    assert.equal(reloads, 2);
  });

  it('startCaddySync: membership changes and device events trigger a reload, unrelated ones do not', async () => {
    let reloads = 0;
    access().stopCaddySync();
    access().startCaddySync({ reload: () => { reloads++; }, intervalMs: 0 });
    const tick = () => new Promise((r) => setTimeout(r, 20));
    try {
      groups().flushEvents();
      await tick();
      reloads = 0;
      groups().removeMember(grp.id, eva);
      groups().flushEvents();
      await tick();
      assert.equal(reloads, 1, 'membership change → reload');
      require('../src/services/activity').log('peer_created', 'Peer "x" created', {});
      await tick();
      assert.equal(reloads, 2, 'device event → reload');
      require('../src/services/activity').log('route_updated', 'x', {});
      await tick();
      assert.equal(reloads, 2, 'unrelated event → nothing');
      // no acl route depends on people → no reload
      db().prepare('UPDATE routes SET acl_enabled = 0 WHERE acl_enabled = 1').run();
      groups().setMember(grp.id, eva);
      groups().flushEvents();
      await tick();
      assert.equal(reloads, 2);
    } finally {
      access().stopCaddySync();
      db().prepare('UPDATE routes SET acl_enabled = 1 WHERE id = ?').run(rid);
    }
  });
});

// ─── admin API ──────────────────────────────────────────────────────────

describe('admin API: preview, principals, routes', () => {
  const api = (method, path) => agent[method](path).set('X-CSRF-Token', csrf);
  let gina, hans, grp, sub;

  before(() => {
    gina = user('Gina'); hans = user('Hans', { enabled: 1 });
    grp = groups().create({ kind: 'department', name: 'Vorschau' });
    sub = groups().create({ kind: 'team', name: 'Unterteam', parentId: grp.id });
    groups().setMember(grp.id, gina, 'lead');
    groups().setMember(sub.id, hans);
    db().prepare("UPDATE users SET enabled = 0, disabled_reason = 'directory' WHERE id = ?").run(hans);
  });

  it('POST /api/v1/access/preview lists people with their reasons and flags disabled accounts', async () => {
    const pid = peer('prev-dev', '10.8.0.61', gina);
    const res = await api('post', '/api/v1/access/preview').send({ groupIds: [grp.id], userIds: [gina, 424242], peerIds: [pid] }).expect(200);
    assert.equal(res.body.count, 1);
    const g = res.body.people.find((p) => p.userId === gina);
    assert.deepEqual(g.reasons.map((r) => r.type).sort(), ['device', 'group', 'person']);
    assert.equal(g.reasons.find((r) => r.type === 'group').role, 'lead');
    const h = res.body.people.find((p) => p.userId === hans);
    assert.equal(h.disabled, true);
    assert.equal(h.disabledReason, 'directory');
    const hr = h.reasons.find((r) => r.type === 'group');
    assert.equal(hr.direct, false);
    assert.equal(hr.viaPath, 'Vorschau › Unterteam');
    assert.deepEqual(res.body.unknownUserIds, [424242]);
    assert.equal(res.body.devices[0].owner, 'Gina');
    const bad = await api('post', '/api/v1/access/preview').send({ groupIds: 'nope' });
    assert.equal(bad.status, 400);
  });

  it('preview and principals are admin-session only', async () => {
    const token = require('../src/services/tokens').create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    const t = await supertest(app).post('/api/v1/access/preview').set('Authorization', `Bearer ${token}`).send({});
    assert.equal(t.status, 403);
    const anon = await supertest(app).get('/api/v1/access/principals');
    assert.ok([401, 302, 403].includes(anon.status), String(anon.status));
    const p = await agent.get('/api/v1/access/principals').expect(200);
    assert.ok(p.body.groups.some((x) => x.path === 'Vorschau › Unterteam'));
    assert.ok(p.body.users.some((u) => u.id === hans && u.enabled === false));
    assert.ok(p.body.peers.some((x) => x.name === 'prev-dev' && x.owner === 'Gina'));
  });

  it('PUT /api/routes/:id stores persons and groups, validates groups, can clear', async () => {
    const id = route('api.ga.test');
    let res = await api('put', '/api/v1/routes/' + id).send({ user_ids: [gina], group_ids: [grp.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.route.group_ids, [grp.id]);
    assert.equal(db().prepare('SELECT user_ids FROM routes WHERE id = ?').get(id).user_ids, JSON.stringify([gina]));
    const detail = await agent.get('/api/v1/routes/' + id).expect(200);
    assert.deepEqual(detail.body.route.group_ids, [grp.id]);

    const missing = await api('put', '/api/v1/routes/' + id).send({ group_ids: [999999] });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'GROUP_NOT_FOUND');
    const arch = groups().create({ kind: 'project', name: 'API-Archiv' });
    groups().archive(arch.id);
    const archived = await api('put', '/api/v1/routes/' + id).send({ group_ids: [grp.id, arch.id] });
    assert.equal(archived.status, 400);
    assert.equal(archived.body.code, 'GROUP_ARCHIVED');
    assert.ok(archived.body.error);

    // a group archived after it was released may stay on the route
    const later = groups().create({ kind: 'project', name: 'API-Später' });
    await api('put', '/api/v1/routes/' + id).send({ group_ids: [later.id] }).expect(200);
    groups().archive(later.id);
    await api('put', '/api/v1/routes/' + id).send({ group_ids: [later.id], description: 'kept' }).expect(200);
    assert.deepEqual(access().routeGroupIds(id), [later.id]);

    // absent = keep; null / [] = clear
    await api('put', '/api/v1/routes/' + id).send({ description: 'nothing else' }).expect(200);
    assert.deepEqual(access().routeGroupIds(id), [later.id]);
    await api('put', '/api/v1/routes/' + id).send({ user_ids: null, group_ids: [] }).expect(200);
    const row = db().prepare('SELECT user_ids FROM routes WHERE id = ?').get(id);
    assert.equal(row.user_ids, null);
    assert.deepEqual(access().routeGroupIds(id), []);
  });

  it('group usage lists the routes and RDP entries released for it', async () => {
    const id = route('usage.ga.test');
    access().setRouteGroups(id, [sub.id]);
    const u = await agent.get(`/api/v1/groups/${sub.id}/usage`).expect(200);
    assert.ok(u.body.usage.some((x) => x.kind === 'route' && x.id === id));
    // the only restriction of the route: it stays locked — key plus the text in the caller's language
    const e = u.body.usage.find((x) => x.kind === 'route' && x.id === id);
    assert.equal(e.onDeleteKey, 'grp.usage.route_locked');
    const texts = ['de', 'en'].map((l) => require(`../src/i18n/${l}.json`)['grp.usage.route_locked']);
    assert.ok(texts.includes(e.onDelete), e.onDelete);
    assert.ok('defaultSuccessor' in u.body);
  });
});
