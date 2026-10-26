'use strict';

// Person groups for plugins (docs/plugins.md "Groups"): plugin.json
// permissions.groups ("read" | "manage"), the host API gc.groups (read,
// ensure / remove of the plugin's own groups, ownership, errors), the hooks
// groupsChanged / groupUsage / groupDeleting, gc.notify({ groups }),
// GC.pickPrincipals (frame document, iframe attribute, the admin list) and
// the install dialog rows.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const PUI = require('../public/js/plugins-ui.js');
const Picker = require('../public/js/principal-picker.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// The plugin code of the tests: gc.groups through the real child process, hooks into its storage.
const GROUPS_JS = `'use strict';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = {
  async request(req, gc) {
    switch (req.path) {
      case '/kv':
        if (req.method === 'POST') { await gc.storage.set(String(req.body.key), req.body.value); return { json: { ok: true } }; }
        return { json: { ok: true, value: await gc.storage.get(String(req.query.key)) } };
      case '/groups':
        try { return { json: { ok: true, value: await gc.groups[req.body.fn](...(req.body.args || [])) } }; }
        catch (e) { return { status: 400, json: { ok: false, code: e.code || null, error: e.message } }; }
      case '/api-keys':
        return { json: { ok: true, keys: Object.keys(gc.groups).sort() } };
      default:
        return { status: 404, json: { ok: false } };
    }
  },
  async render() { return { html: '<p>groups</p>' }; },
  async groupsChanged({ changes }, gc) {
    const prev = (await gc.storage.get('changes')) || [];
    await gc.storage.set('changes', prev.concat(changes));
  },
  async groupUsage({ groupId, successorUserId }, gc) {
    const mode = await gc.storage.get('usage-mode');
    if (mode === 'successor') return [{ kind: 'Drive', label: 'Ordner ' + groupId, onDelete: 'geht an ' + successorUserId }];
    if (mode === 'throw') throw new Error('broken on purpose');
    if (mode === 'garbage') return 'nope';
    if (mode === 'slow') { await wait(8000); return [{ label: 'too late' }]; }
    return [{ kind: 'Drive', label: 'Team-Ordner ' + groupId, onDelete: 'wird verschoben' }, { label: 'ohne Art' }, { kind: 'x' }];
  },
  async groupDeleting(payload, gc) {
    if ((await gc.storage.get('deleting-mode')) === 'slow') await wait(5000);
    const prev = (await gc.storage.get('deleting')) || [];
    await gc.storage.set('deleting', prev.concat([payload]));
  },
};
`;

let app, agent, csrf, runtime, plugins, manifest, hostApi, registry, groups, pg, inspected;

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
function pkg(id, groupsPerm, extra = {}) {
  const permissions = { ...clone(helloManifest.permissions) };
  if (groupsPerm) permissions.groups = groupsPerm;
  return helloPackage({ overrides: { id, name: { de: id, en: id }, entry: 'server/groups.js', permissions, ...extra }, extra: new Map([['server/groups.js', GROUPS_JS]]) });
}
const call = (id, op, args) => hostApi.handle(registry.get(id), `groups.${op}`, args);
async function code(promise) { try { await promise; } catch (e) { return e.code; } return 'resolved'; }
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (id, key) => (await agent.get(`${API}/${id}/api/kv`).query({ key }).expect(200)).body.value;
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

let anna, ben, carla, dora, off;
before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  hostApi = require('../src/services/plugins/hostApi');
  registry = require('../src/services/plugins/registry');
  groups = require('../src/services/groups');
  pg = require('../src/services/plugins/groups');
  pg.init();
  anna = H.makeUser('gp-anna');
  ben = H.makeUser('gp-ben');
  carla = H.makeUser('gp-carla');
  dora = H.makeUser('gp-dora');
  off = H.makeUser('gp-off', { enabled: 0 });
  inspected = await install(pkg('grp-manage', 'manage'));
  await install(pkg('grp-manage2', 'manage'));
  await install(pkg('grp-read', 'read'));
  await install(pkg('grp-none', null));
  for (const id of ['grp-manage', 'grp-manage2', 'grp-read', 'grp-none']) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => { pg.shutdown(); groups._removeHooksMs = null; await plugins.stop(); teardown(); });
beforeEach(() => hostApi._resetBudgetsForTest());

describe('plugin.json permissions.groups', () => {
  it('"read" or "manage"; absent = null; anything else is invalid', () => {
    const m = clone(helloManifest);
    assert.equal(manifest.validate(m).manifest.permissions.groups, null);
    for (const v of ['read', 'manage']) {
      m.permissions.groups = v;
      assert.equal(manifest.validate(m).manifest.permissions.groups, v);
    }
    for (const bad of [true, 'write', 'READ', {}, ['read'], 1]) {
      m.permissions.groups = bad;
      assert.deepEqual(manifest.validate(m).errors, ['permissions.groups: invalid'], JSON.stringify(bad));
    }
  });

  it('the install dialog says "Gruppen: Gruppen und Mitglieder lesen" / "… und eigene Gruppen verwalten" (sensitive)', () => {
    assert.equal(inspected.plugin.permissions.groups, 'manage');
    const t = (k) => de[k] || k;
    const rows = (perm) => Object.fromEntries(PUI.permRows({ network: { internet: [], homeTargets: [] }, ...perm }, t).map((r) => [r.label, r.value]));
    assert.equal(rows({ groups: 'read' }).Gruppen, 'Gruppen und Mitglieder lesen');
    assert.equal(rows({ groups: 'manage' }).Gruppen, 'Gruppen und Mitglieder lesen und eigene Gruppen verwalten');
    assert.equal(rows({ groups: null }).Gruppen, undefined);
    assert.ok(PUI.sensitivePerms({ groups: 'read' }).includes('plugins.perm.groups'));
    // an update from read to manage is a changed row in the permission diff
    const diff = PUI.permDiff({ network: { internet: [], homeTargets: [] }, groups: 'manage' }, { network: { internet: [], homeTargets: [] }, groups: 'read' }, t);
    assert.equal(diff.rows.find((r) => r.label === 'Gruppen').change, 'changed');
    for (const k of ['plugins.perm.groups', 'plugins.perm.groups_read', 'plugins.perm.groups_manage']) assert.ok(de[k] && en[k], k);
  });
});

describe('gc.groups — reading', () => {
  let dep, team, sub;
  before(() => {
    dep = groups.create({ kind: 'department', name: 'GP Verwaltung' });
    team = groups.create({ kind: 'team', name: 'Buchhaltung', parentId: dep.id });
    sub = groups.create({ kind: 'team', name: 'Kreditoren', parentId: team.id });
    groups.setMember(team.id, anna, 'lead');
    groups.setMember(team.id, ben, 'deputy');
    groups.setMember(sub.id, carla, 'member');
    groups.setMember(team.id, off, 'member');
  });

  it('needs the permission: ERR_GROUPS_DENIED without it', async () => {
    for (const op of ['list', 'get', 'members', 'isMember', 'leadersOf', 'ensure', 'remove']) {
      assert.equal(await code(call('grp-none', op, { id: team.id, userId: anna, groupId: team.id, key: 'x' })), 'ERR_GROUPS_DENIED', op);
    }
  });

  it('list: all groups or the groups of a person (direct, inherited), by kind', async () => {
    const all = await call('grp-read', 'list', {});
    const t = all.find((g) => g.id === team.id);
    assert.equal(t.path, 'GP Verwaltung › Buchhaltung');
    assert.equal(t.source, 'local');
    assert.equal(t.own, false);
    assert.equal(t.key, null);
    assert.deepEqual(Object.keys(t).sort(), ['archived', 'childIds', 'depth', 'endsAt', 'id', 'key', 'kind', 'memberCount', 'name', 'own', 'parentId', 'path', 'source', 'totalMemberCount'].sort());
    assert.ok((await call('grp-read', 'list', { kind: 'department' })).every((g) => g.kind === 'department'));
    const direct = await call('grp-read', 'list', { userId: carla });
    assert.deepEqual(direct.map((g) => g.id), [sub.id]);
    const inh = await call('grp-read', 'list', { userId: carla, includeInherited: true });
    assert.deepEqual(inh.map((g) => [g.id, g.role, g.direct]), [[dep.id, 'member', false], [team.id, 'member', false], [sub.id, 'member', true]]);
    assert.deepEqual(Object.keys(inh[0]).sort(), ['archived', 'direct', 'id', 'kind', 'name', 'path', 'role', 'source']);
    assert.equal(await code(call('grp-read', 'list', { kind: 'club' })), 'ERR_INVALID');
    assert.equal(await code(call('grp-read', 'list', { userId: 'anna' })), 'ERR_INVALID');
  });

  it('get / members / isMember / leadersOf — plain JSON, never e-mail addresses or user names', async () => {
    const g = await call('grp-read', 'get', { id: team.id });
    assert.equal(g.name, 'Buchhaltung');
    assert.deepEqual(g.childIds, [sub.id]);
    assert.equal(await call('grp-read', 'get', { id: 999999 }), null);
    assert.equal(await code(call('grp-read', 'get', { id: 'x' })), 'ERR_INVALID');

    const ms = await call('grp-read', 'members', { id: team.id, nested: true });
    assert.deepEqual(ms.map((m) => [m.userId, m.role, m.direct]).sort((a, b) => a[0] - b[0]),
      [[anna, 'lead', true], [ben, 'deputy', true], [carla, 'member', false], [off, 'member', true]].sort((a, b) => a[0] - b[0]));
    for (const m of ms) {
      assert.deepEqual(Object.keys(m).sort(), ['direct', 'enabled', 'groupId', 'name', 'role', 'source', 'userId']);
      assert.ok(!('email' in m) && !('username' in m));
    }
    assert.equal(ms.find((m) => m.userId === off).enabled, false);
    assert.deepEqual((await call('grp-read', 'members', { id: team.id, roles: ['lead'] })).map((m) => m.userId), [anna]);
    assert.equal(await code(call('grp-read', 'members', { id: 999999 })), 'ERR_NOT_FOUND');
    assert.equal(await code(call('grp-read', 'members', { id: team.id, roles: ['boss'] })), 'ERR_INVALID');

    assert.equal(await call('grp-read', 'isMember', { userId: carla, groupId: team.id }), false);
    assert.equal(await call('grp-read', 'isMember', { userId: carla, groupId: team.id, nested: true }), true);
    assert.equal(await call('grp-read', 'isMember', { userId: off, groupId: team.id }), false, 'disabled accounts rest');
    assert.equal(await code(call('grp-read', 'isMember', { userId: carla, groupId: 999999 })), 'ERR_NOT_FOUND');

    const leaders = await call('grp-read', 'leadersOf', { userId: carla, groupId: sub.id });
    assert.deepEqual(leaders, [{ userId: anna, name: 'gp-anna', role: 'lead', groupId: team.id }, { userId: ben, name: 'gp-ben', role: 'deputy', groupId: team.id }]);
    assert.deepEqual((await call('grp-read', 'leadersOf', { userId: carla })).map((l) => l.userId), [anna, ben]);
    assert.equal(await code(call('grp-read', 'leadersOf', { userId: carla, groupId: 999999 })), 'ERR_NOT_FOUND');
  });

  it('a "read" plugin cannot ensure or remove', async () => {
    assert.equal(await code(call('grp-read', 'ensure', { key: 'x', name: 'X', kind: 'team', members: [] })), 'ERR_GROUPS_DENIED');
    assert.equal(await code(call('grp-read', 'remove', { key: 'x' })), 'ERR_GROUPS_DENIED');
  });

  it('the child process has gc.groups with every call', async () => {
    const r = await agent.get(`${API}/grp-read/api/api-keys`).expect(200);
    assert.deepEqual(r.body.keys, ['ensure', 'get', 'isMember', 'leadersOf', 'list', 'members', 'remove']);
    const v = await agent.post(`${API}/grp-read/api/groups`).set('X-CSRF-Token', csrf).send({ fn: 'members', args: [team.id, { nested: true, roles: ['deputy'] }] }).expect(200);
    assert.deepEqual(v.body.value.map((m) => m.userId), [ben]);
    const e = await agent.post(`${API}/grp-read/api/groups`).set('X-CSRF-Token', csrf).send({ fn: 'ensure', args: [{ key: 'x', name: 'X', kind: 'team', members: [] }] }).expect(400);
    assert.equal(e.body.code, 'ERR_GROUPS_DENIED');
  });
});

describe('gc.groups — managing its own groups', () => {
  it('ensure creates the group (source plugin:<id>, key) with exactly these members, then updates it', async () => {
    const g = await call('grp-manage', 'ensure', { key: 'familie', name: 'Familie Test', kind: 'family', members: [{ userId: anna, role: 'parent' }, { userId: ben }] });
    assert.equal(g.created, true);
    assert.equal(g.source, 'plugin:grp-manage');
    assert.equal(g.key, 'familie');
    assert.equal(g.own, true);
    assert.equal(g.added, 2);
    const row = groups.get(g.id);
    assert.equal(row.externalId, 'familie');
    assert.equal(row.readOnly, true);
    let ms = groups.members(g.id);
    assert.deepEqual(ms.map((m) => [m.userId, m.role, m.source]).sort((a, b) => a[0] - b[0]), [[anna, 'parent', 'plugin:grp-manage'], [ben, 'child', 'plugin:grp-manage']]);

    const again = await call('grp-manage', 'ensure', { key: 'familie', name: 'Familie Test', kind: 'family', members: [{ userId: anna, role: 'parent' }, { userId: ben, role: 'child' }] });
    assert.deepEqual([again.created, again.added, again.removed, again.changed], [false, 0, 0, 0], 'idempotent');

    const upd = await call('grp-manage', 'ensure', { key: 'familie', name: 'Familie Neu', kind: 'family', members: [{ userId: anna, role: 'parent' }, { userId: ben, role: 'parent' }, { userId: carla, role: 'child' }] });
    assert.deepEqual([upd.id, upd.name, upd.added, upd.removed, upd.changed], [g.id, 'Familie Neu', 1, 0, 1]);
    const fewer = await call('grp-manage', 'ensure', { key: 'familie', name: 'Familie Neu', kind: 'family', members: [{ userId: carla, role: 'child' }] });
    assert.equal(fewer.removed, 2);
    ms = groups.members(g.id);
    assert.deepEqual(ms.map((m) => m.userId), [carla]);
  });

  it('parentKey nests below one of its own groups; a kind change keeps the wanted members', async () => {
    const top = await call('grp-manage', 'ensure', { key: 'org', name: 'GP Plugin-Org', kind: 'department', members: [] });
    const child = await call('grp-manage', 'ensure', { key: 'org-team', name: 'Team A', kind: 'team', parentKey: 'org', members: [{ userId: dora, role: 'lead' }] });
    assert.equal(child.parentId, top.id);
    assert.equal(child.path, 'GP Plugin-Org › Team A');
    const moved = await call('grp-manage', 'ensure', { key: 'org-team', name: 'Team A', kind: 'project', members: [{ userId: dora, role: 'lead' }] });
    assert.equal(moved.parentId, null, 'without parentKey it goes to the top level');
    assert.equal(moved.kind, 'project');
    assert.equal(await code(call('grp-manage', 'ensure', { key: 'x2', name: 'X2', kind: 'team', parentKey: 'nope', members: [] })), 'ERR_NOT_FOUND');
  });

  it('refuses bad input with ERR_INVALID', async () => {
    const bad = (spec) => code(call('grp-manage', 'ensure', spec));
    assert.equal(await bad({ name: 'X', kind: 'team', members: [] }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'has space', name: 'X', kind: 'team', members: [] }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'k', name: '', kind: 'team', members: [] }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'k', name: 'X', kind: 'club', members: [] }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'k', name: 'X', kind: 'team' }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'k', name: 'X', kind: 'team', members: [{ userId: 999999 }] }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'k', name: 'X', kind: 'team', members: [{ userId: anna, role: 'parent' }] }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'k', name: 'X', kind: 'team', members: [{ userId: anna }, { userId: anna }] }), 'ERR_INVALID');
    assert.equal(await bad({ key: 'k', name: 'X›Y', kind: 'team', members: [] }), 'ERR_INVALID');
  });

  it('ownership: admins cannot change a plugin group; another plugin cannot remove it; local groups stay off-limits', async () => {
    const mine = await call('grp-manage', 'ensure', { key: 'owned', name: 'GP Owned', kind: 'team', members: [{ userId: anna }] });
    assert.throws(() => groups.update(mine.id, { name: 'Hijack' }), (e) => e.code === 'READ_ONLY');
    assert.throws(() => groups.setMember(mine.id, ben, 'member'), (e) => e.code === 'READ_ONLY');
    assert.equal(await code(call('grp-manage2', 'remove', { key: mine.id })), 'ERR_READ_ONLY', 'by id: not its own');
    assert.equal(await call('grp-manage2', 'remove', { key: 'owned' }), false, 'its own key space: no such group');
    const theirs = await call('grp-manage2', 'ensure', { key: 'owned', name: 'GP Owned 2', kind: 'team', members: [] });
    assert.notEqual(theirs.id, mine.id, 'same key, another plugin: another group');
    const local = groups.create({ kind: 'team', name: 'GP Local' });
    assert.equal(await code(call('grp-manage', 'remove', { key: local.id })), 'ERR_READ_ONLY');
    assert.ok(groups.get(local.id));
    // the plugin's view of a group it does not own carries no key
    assert.equal((await call('grp-manage2', 'get', { id: mine.id })).key, null);
  });

  it('remove(key) deletes its own group (subgroups first: ERR_INVALID)', async () => {
    assert.equal(await code(call('grp-manage', 'remove', { key: 'org' })), 'resolved', 'org has no subgroups any more');
    const top = await call('grp-manage', 'ensure', { key: 'tree', name: 'GP Tree', kind: 'department', members: [] });
    await call('grp-manage', 'ensure', { key: 'tree-leaf', name: 'Leaf', kind: 'team', parentKey: 'tree', members: [] });
    assert.equal(await code(call('grp-manage', 'remove', { key: 'tree' })), 'ERR_INVALID');
    assert.equal(await call('grp-manage', 'remove', { key: 'tree-leaf' }), true);
    assert.equal(await call('grp-manage', 'remove', { key: 'tree' }), true);
    assert.equal(groups.get(top.id), null);
    assert.equal(await call('grp-manage', 'remove', { key: 'tree' }), false);
    assert.equal(await code(call('grp-manage', 'remove', { key: '' })), 'ERR_INVALID');
  });
});

describe('hooks', () => {
  it('groupsChanged: the batched changes reach every running plugin with the permission', async () => {
    for (const id of ['grp-read', 'grp-none']) await kv(id, 'changes', null);
    const g = groups.create({ kind: 'team', name: 'GP Hooks' });
    groups.setMember(g.id, dora, 'member');
    groups.flushEvents();
    const got = await until(async () => {
      const c = await kvGet('grp-read', 'changes');
      return c && c.some((x) => x.type === 'member_added' && x.groupId === g.id) ? c : null;
    });
    assert.ok(got, 'grp-read got the batch');
    assert.ok(got.some((x) => x.type === 'group_created' && x.groupId === g.id));
    assert.deepEqual(got.find((x) => x.type === 'member_added' && x.groupId === g.id), { type: 'member_added', groupId: g.id, userId: dora, role: 'member' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await kvGet('grp-none', 'changes'), null, 'no permission, no hook');
  });

  it('groupUsage: one usage provider asks the plugins; errors, garbage and timeouts are ignored', async () => {
    const g = groups.create({ kind: 'team', name: 'GP Usage' });
    for (const id of ['grp-manage', 'grp-manage2', 'grp-read']) await kv(id, 'usage-mode', null);
    let usage = await groups.usage(g.id);
    const drive = usage.filter((u) => u.kind === 'Drive');
    assert.equal(drive.length, 3, 'grp-manage, grp-manage2 and grp-read');
    assert.deepEqual(drive[0], { kind: 'Drive', label: `Team-Ordner ${g.id}`, onDelete: 'wird verschoben' });
    assert.ok(usage.some((u) => u.label === 'ohne Art' && u.kind === 'grp-read'), 'kind defaults to the plugin name');
    assert.ok(!usage.some((u) => u.kind === 'x'), 'an entry without label is dropped');
    await kv('grp-manage', 'usage-mode', 'throw');
    await kv('grp-manage2', 'usage-mode', 'garbage');
    pg._usageMs = 300;
    await kv('grp-read', 'usage-mode', 'slow');
    try {
      usage = await groups.usage(g.id);
      assert.equal(usage.filter((u) => u.kind === 'Drive').length, 0);
    } finally {
      pg._usageMs = null;
      for (const id of ['grp-manage', 'grp-manage2', 'grp-read']) await kv(id, 'usage-mode', null);
    }
    // the admin API's "Wird genutzt von" lists them
    const r = await agent.get(`/api/v1/groups/${g.id}/usage`).expect(200);
    assert.ok(r.body.usage.some((u) => u.kind === 'Drive'));
  });

  it('groupDeleting: asked before a group is deleted (successor = its lead), the deleting plugin itself is not', async () => {
    for (const id of ['grp-manage', 'grp-read', 'grp-none']) await kv(id, 'deleting', null);
    const g = groups.create({ kind: 'team', name: 'GP Delete' });
    groups.setMember(g.id, ben, 'lead');
    await agent.delete(`/api/v1/groups/${g.id}`).query({ confirm: 'GP Delete' }).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(groups.get(g.id), null);
    assert.deepEqual(await kvGet('grp-read', 'deleting'), [{ groupId: g.id, successorUserId: ben }]);
    assert.deepEqual(await kvGet('grp-manage', 'deleting'), [{ groupId: g.id, successorUserId: ben }]);
    assert.equal(await kvGet('grp-none', 'deleting'), null);

    // an explicit successor; a refused deletion asks nobody
    const g2 = groups.create({ kind: 'team', name: 'GP Delete 2' });
    await kv('grp-read', 'deleting', null);
    await agent.delete(`/api/v1/groups/${g2.id}`).query({ confirm: 'wrong' }).set('X-CSRF-Token', csrf).expect(400);
    assert.equal(await kvGet('grp-read', 'deleting'), null);
    await agent.delete(`/api/v1/groups/${g2.id}`).query({ confirm: 'GP Delete 2', successor: String(carla) }).set('X-CSRF-Token', csrf).expect(200);
    assert.deepEqual(await kvGet('grp-read', 'deleting'), [{ groupId: g2.id, successorUserId: carla }]);
    await agent.delete(`/api/v1/groups/${groups.create({ kind: 'team', name: 'GP Delete 3' }).id}`).query({ confirm: 'GP Delete 3', successor: '999999' }).set('X-CSRF-Token', csrf).expect(404);

    // a plugin removing its own group: the others hear of it, the plugin itself not
    for (const id of ['grp-manage', 'grp-read']) await kv(id, 'deleting', null);
    const own = await call('grp-manage', 'ensure', { key: 'gone', name: 'GP Gone', kind: 'team', members: [] });
    assert.equal(await call('grp-manage', 'remove', { key: 'gone' }), true);
    assert.deepEqual(await kvGet('grp-read', 'deleting'), [{ groupId: own.id, successorUserId: null }]);
    assert.equal(await kvGet('grp-manage', 'deleting'), null);
  });

  it('groupUsage hears the successor (default lead, the admin\'s choice, none); successor=none deletes without one', async () => {
    const g = groups.create({ kind: 'team', name: 'GP Successor' });
    groups.setMember(g.id, ben, 'lead');
    await kv('grp-read', 'usage-mode', 'successor');
    try {
      const text = (body) => body.usage.find((u) => u.label === 'Ordner ' + g.id).onDelete;
      let r = await agent.get(`/api/v1/groups/${g.id}/usage`).expect(200);
      assert.equal(text(r.body), 'geht an ' + ben);
      assert.equal(r.body.defaultSuccessor.userId, ben);
      assert.equal(r.body.defaultSuccessor.role, 'lead');
      assert.equal(r.body.defaultSuccessor.inherited, false);
      r = await agent.get(`/api/v1/groups/${g.id}/usage`).query({ successor: String(carla) }).expect(200);
      assert.equal(text(r.body), 'geht an ' + carla);
      assert.equal(r.body.defaultSuccessor.userId, ben, 'the default stays the lead');
      r = await agent.get(`/api/v1/groups/${g.id}/usage`).query({ successor: 'none' }).expect(200);
      assert.equal(text(r.body), 'geht an null');
      await agent.get(`/api/v1/groups/${g.id}/usage`).query({ successor: '999999' }).expect(404);
    } finally { await kv('grp-read', 'usage-mode', null); }
    // a disabled account cannot take over
    const off2 = H.makeUser('gp-off-succ', { enabled: 0 });
    await agent.delete(`/api/v1/groups/${g.id}`).query({ confirm: 'GP Successor', successor: String(off2) }).set('X-CSRF-Token', csrf).expect(400);
    assert.ok(groups.get(g.id), 'refused, the group stays');
    await kv('grp-read', 'deleting', null);
    await agent.delete(`/api/v1/groups/${g.id}`).query({ confirm: 'GP Successor', successor: 'none' }).set('X-CSRF-Token', csrf).expect(200);
    assert.deepEqual(await kvGet('grp-read', 'deleting'), [{ groupId: g.id, successorUserId: null }]);
  });

  it('groupDeleting has a budget: a slow plugin does not stop the deletion', async () => {
    await kv('grp-read', 'deleting-mode', 'slow');
    groups._removeHooksMs = 300;
    try {
      const g = groups.create({ kind: 'team', name: 'GP Slow' });
      const t0 = Date.now();
      await groups.removeWithHooks(g.id, { confirmName: 'GP Slow' });
      assert.ok(Date.now() - t0 < 3000);
      assert.equal(groups.get(g.id), null);
    } finally {
      groups._removeHooksMs = null;
      await kv('grp-read', 'deleting-mode', null);
    }
    // without hooks remove() is unchanged and synchronous
    const g2 = groups.create({ kind: 'team', name: 'GP Sync' });
    assert.equal(groups.remove(g2.id, { confirmName: 'GP Sync' }), true);
  });
});

describe('gc.notify({ groups })', () => {
  let hub, orig, sent, team, sub, empty;
  before(() => {
    hub = require('../src/services/notify/hub');
    orig = hub.emitPlugin;
    team = groups.create({ kind: 'team', name: 'GP Notify' });
    sub = groups.create({ kind: 'team', name: 'Sub', parentId: team.id });
    empty = groups.create({ kind: 'team', name: 'GP Notify Empty' });
    groups.setMember(team.id, anna, 'member');
    groups.setMember(team.id, off, 'member');
    groups.setMember(sub.id, ben, 'member');
    groups.setMember(empty.id, off, 'member');
  });
  beforeEach(() => { sent = []; hub.emitPlugin = (id, n) => { sent.push({ id, n }); return { pushed: true, id: 'n1' }; }; });
  after(() => { hub.emitPlugin = orig; });
  const notify = (id, n) => hostApi.handle(registry.get(id), 'notify', { notification: n });

  it('expands the groups at send time (subgroups, enabled accounts only) and merges users', async () => {
    const r = await notify('grp-read', { title: 'Hallo Team', groups: [team.id], users: [carla, anna] });
    assert.deepEqual(r, { pushed: true, id: 'n1', recipients: 3 });
    assert.deepEqual(sent[0].n.users.sort((a, b) => a - b), [anna, ben, carla].sort((a, b) => a - b));
    const row = H.db().prepare("SELECT details FROM activity_log WHERE event_type = 'plugin_notice' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(row.details).groups, [team.id]);
  });

  it('groups without anybody send nothing — never the topic\'s subscribers', async () => {
    const r = await notify('grp-read', { title: 'Niemand', groups: [empty.id] });
    assert.deepEqual(r, { pushed: false, id: null, recipients: 0 });
    assert.equal(sent.length, 0);
  });

  it('needs permissions.groups; bad or unknown groups are ERR_INVALID', async () => {
    assert.equal(await code(notify('grp-none', { title: 'x', groups: [team.id] })), 'ERR_GROUPS_DENIED');
    assert.equal(await code(notify('grp-read', { title: 'x', groups: [] })), 'ERR_INVALID');
    assert.equal(await code(notify('grp-read', { title: 'x', groups: ['1'] })), 'ERR_INVALID');
    assert.equal(await code(notify('grp-read', { title: 'x', groups: [999999] })), 'ERR_INVALID');
    assert.equal(await code(notify('grp-read', { title: 'x', groups: new Array(51).fill(team.id) })), 'ERR_INVALID');
    assert.equal(sent.length, 0);
  });

  it('counts against the push budget like every notification', async () => {
    const p = registry.get('grp-read');
    for (let i = 0; i < 30; i++) await notify('grp-read', { title: 'n' + i, groups: [team.id] });
    assert.equal(await code(notify('grp-read', { title: 'over', groups: [team.id] })), 'ERR_RATE_LIMIT');
    assert.ok(p);
  });
});

describe('GC.pickPrincipals', () => {
  it('the frame document has it only for plugins with permissions.groups', async () => {
    const yes = (await agent.get('/plugins/grp-read/frame/main').expect(200)).text;
    assert.match(yes, /if \(true\) api\.pickPrincipals = pickPrincipals;/);
    const no = (await agent.get('/plugins/grp-none/frame/main').expect(200)).text;
    assert.match(no, /if \(false\) api\.pickPrincipals = pickPrincipals;/);
    assert.match(yes, /type: 'gc-pick'/);
  });

  it('admin and portal <iframe>s carry data-plugin-groups; the pages load the picker after the bridge', async () => {
    const page = (await agent.get('/plugins/grp-read').expect(200)).text;
    assert.match(/<iframe class="pg-frame"[^>]*>/.exec(page)[0], /data-plugin-groups data-plugin-name="grp-read"/);
    assert.match(page, /<script src="\/js\/plugin-bridge\.js\?v=[^"]+"><\/script>\s*<script src="\/js\/principal-picker\.js/);
    assert.doesNotMatch(/<iframe class="pg-frame"[^>]*>/.exec((await agent.get('/plugins/grp-none').expect(200)).text)[0], /data-plugin-groups/);
    const contrib = await require('../src/services/plugins/portal').contributions({ id: anna, name: 'gp-anna', role: 'user', portal: true, loggedIn: true }, 'de');
    assert.equal(contrib.tabs.find((t) => t.id === 'grp-read').groups, true);
    assert.equal(contrib.tabs.find((t) => t.id === 'grp-none').groups, undefined);
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
    assert.equal((tpl.match(/\.groups %\} data-plugin-groups/g) || []).length, 2, 'own tab and sections');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugins-page.js'), 'utf8'), /if \(p\.pickPrincipals\) \{ attrs\['data-plugin-groups'\] = ''/);
  });

  it('GET /api/v1/principals: every group and enabled person for admins only', async () => {
    const r = await agent.get('/api/v1/principals').expect(200);
    assert.ok(r.body.groups.some((g) => g.label === 'GP Notify › Sub'));
    assert.ok(r.body.users.some((u) => u.id === anna && u.label === 'gp-anna'));
    assert.ok(!r.body.users.some((u) => u.id === off), 'no disabled accounts');
    assert.ok(r.body.users.every((u) => !('email' in u)));
    const token = require('../src/services/tokens').create({ name: 'pp', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    const t = await supertest(app).get('/api/v1/principals').set('Authorization', `Bearer ${token}`);
    assert.ok([401, 403].includes(t.status), String(t.status));
  });

  it('the picker keeps only well-formed entries of the kinds asked for and searches label and sub', () => {
    const body = { groups: [{ id: 1, label: 'IT › Support', sub: 'Team' }, { id: 0, label: 'bad' }, { id: 2, label: '' }], users: [{ id: 5, label: 'Anna', sub: 'anna', self: true }, { id: '6', label: 'x' }] };
    assert.deepEqual(Picker.entries(body, { groups: true, users: false }).map((e) => e.id), [1]);
    const both = Picker.entries(body, { groups: true, users: true });
    assert.deepEqual(both.map((e) => `${e.type}:${e.id}`), ['group:1', 'user:5']);
    assert.equal(both[1].self, true);
    assert.equal(Picker.matches(both[0], 'sup team'), true);
    assert.equal(Picker.matches(both[0], 'anna'), false);
    for (const k of Object.keys(Picker.STR.de)) assert.ok(Picker.STR.en[k], k);
  });
});
