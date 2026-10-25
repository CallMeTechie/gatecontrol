'use strict';

// Backup / restore of the person groups (docs/groups.md "Sicherung"):
// groups (ids kept, nesting), members (by username), invitations (hashes),
// route_group_acl, rdp_routes.group_ids and the user ids of user_ids lists.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

before(async () => {
  await setup();
  require('../src/services/peers').rewriteWgConfig = async () => {};
  require('../src/services/routes').syncToCaddy = async () => {};
  require('../src/services/caddyConfig').syncToCaddy = async () => true;
});
after(() => teardown());

function db() { return require('../src/db/connection').getDb(); }
const groups = () => require('../src/services/groups');
const access = () => require('../src/services/groupAccess');
const backup = () => require('../src/services/backup');

describe('backup round trip with groups', () => {
  let anna, ben, dep, team, proj, rid, rdpId, invite, snapshot;

  before(() => {
    const ins = db().prepare("INSERT INTO users (username, display_name, password_hash, role, enabled) VALUES (?, ?, 'hash', 'user', 1)");
    anna = Number(ins.run('bk-anna', 'Anna').lastInsertRowid);
    ben = Number(ins.run('bk-ben', 'Ben').lastInsertRowid);
    dep = groups().create({ kind: 'department', name: 'Verwaltung', color: '#336699' });
    team = groups().create({ kind: 'team', name: 'Buchhaltung', parentId: dep.id });
    proj = groups().create({ kind: 'project', name: 'Projekt X', endsAt: '2099-12-31' });
    groups().setMember(team.id, anna, 'lead');
    groups().setMember(dep.id, ben);
    groups().setMember(proj.id, ben);
    groups().archive(proj.id);
    invite = groups().createInvite(team.id, { role: 'member', expiresInDays: 7, maxUses: 3 });
    rid = Number(db().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, user_ids) VALUES ('bk.ga.test', '10.0.0.5', 80, 'http', 1, ?)")
      .run(JSON.stringify([ben])).lastInsertRowid);
    access().setRouteGroups(rid, [team.id]);
    rdpId = Number(db().prepare("INSERT INTO rdp_routes (name, host, port, enabled, user_ids, group_ids) VALUES ('bk-rdp', '10.0.0.9', 3389, 1, ?, ?)")
      .run(JSON.stringify([anna]), JSON.stringify([dep.id])).lastInsertRowid);
    snapshot = {
      members: db().prepare('SELECT g.name AS g, u.username AS u, m.role FROM group_members m JOIN groups g ON g.id = m.group_id JOIN users u ON u.id = m.user_id ORDER BY g, u').all(),
    };
  });

  it('exports groups, members (by username), invitation hashes and route group refs', () => {
    const b = backup().createBackup();
    assert.ok(Array.isArray(b.data.groups));
    const t = b.data.groups.find((g) => g.name === 'Buchhaltung');
    assert.equal(t.group_ref, team.id);
    assert.equal(t.parent_ref, dep.id);
    assert.ok(b.data.groups.find((g) => g.name === 'Projekt X').archived_at, 'archived state kept');
    assert.ok(b.data.group_members.some((m) => m.group_ref === team.id && m.user_name === 'bk-anna' && m.role === 'lead'));
    const inv = b.data.group_invites.find((i) => i.group_ref === team.id);
    assert.match(inv.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(b).includes(invite.token), 'the raw invitation token never lands in a backup');
    assert.deepEqual(b.data.routes.find((r) => r.domain === 'bk.ga.test').group_refs, [team.id]);
    assert.ok(b.data.users.every((u) => Number.isInteger(u.user_ref)));
    const sum = backup().getBackupSummary(b);
    assert.equal(sum.groups, 3);
    assert.ok(sum.group_members >= 3);
  });

  it('restores ids, nesting, memberships, invitations and access consistently', async () => {
    const b = JSON.parse(JSON.stringify(backup().createBackup()));
    // Wreck the current state: the restore must replace it.
    groups().removeMember(team.id, anna);
    const extra = groups().create({ kind: 'team', name: 'Nach der Sicherung' });
    db().prepare('DELETE FROM routes WHERE id = ?').run(rid);

    const result = await backup().restoreBackup(b);
    assert.equal(result.groups, 3);

    const gs = groups().list({ includeArchived: true });
    assert.equal(gs.length, 3);
    assert.ok(!gs.some((g) => g.id === extra.id), 'groups created after the backup are gone');
    const t = groups().get(team.id);
    assert.equal(t.name, 'Buchhaltung');
    assert.equal(t.parentId, dep.id);
    assert.equal(t.path, 'Verwaltung › Buchhaltung');
    assert.equal(groups().get(dep.id).color, '#336699');
    assert.equal(groups().get(proj.id).archived, true);

    // users keep their ids → memberships, user_ids and plugin data stay right
    const annaNow = db().prepare("SELECT id FROM users WHERE username = 'bk-anna'").get().id;
    const benNow = db().prepare("SELECT id FROM users WHERE username = 'bk-ben'").get().id;
    assert.equal(annaNow, anna);
    assert.equal(benNow, ben);
    const members = db().prepare('SELECT g.name AS g, u.username AS u, m.role FROM group_members m JOIN groups g ON g.id = m.group_id JOIN users u ON u.id = m.user_id ORDER BY g, u').all();
    assert.deepEqual(members, snapshot.members);

    assert.ok(groups().lookupInvite(invite.token), 'invitation link still works');

    const r = db().prepare("SELECT id, user_ids FROM routes WHERE domain = 'bk.ga.test'").get();
    assert.deepEqual(access().routeGroupIds(r.id), [team.id]);
    assert.equal(r.user_ids, JSON.stringify([ben]));
    const rdp = db().prepare("SELECT user_ids, group_ids FROM rdp_routes WHERE name = 'bk-rdp'").get();
    assert.equal(rdp.group_ids, JSON.stringify([dep.id]));
    assert.equal(rdp.user_ids, JSON.stringify([anna]));
    assert.ok(rdpId);

    // and access works after the restore
    const vis = require('../src/services/routes').getForUser(anna).map((x) => x.domain);
    assert.ok(vis.includes('bk.ga.test'));
  });

  it('a route released for a group missing from the backup stays closed; old backups keep the groups', async () => {
    const b = JSON.parse(JSON.stringify(backup().createBackup()));
    b.data.routes.find((r) => r.domain === 'bk.ga.test').group_refs = [987654];
    b.data.routes.find((r) => r.domain === 'bk.ga.test').user_ids = null;
    await backup().restoreBackup(b);
    const r = db().prepare("SELECT id, user_ids FROM routes WHERE domain = 'bk.ga.test'").get();
    assert.equal(r.user_ids, '[0]');
    assert.ok(!require('../src/services/routes').getForUser(anna).some((x) => x.domain === 'bk.ga.test'));

    // A backup without the groups section (older format) leaves the groups alone.
    const old = JSON.parse(JSON.stringify(backup().createBackup()));
    delete old.data.groups; delete old.data.group_members; delete old.data.group_invites;
    old.data.users = [];
    await backup().restoreBackup(old);
    assert.equal(groups().list({ includeArchived: true }).length, 3);
    assert.ok(groups().isMember(anna, team.id));
  });

  it('user ids a backup does not know become NOBODY (0), never another person', async () => {
    const b = JSON.parse(JSON.stringify(backup().createBackup()));
    // user 555555 does not exist in the backup's user list → NOBODY
    b.data.rdp_routes.find((x) => x.name === 'bk-rdp').user_ids = JSON.stringify([anna, 555555]);
    await backup().restoreBackup(b);
    const rdp = db().prepare("SELECT user_ids FROM rdp_routes WHERE name = 'bk-rdp'").get();
    assert.equal(rdp.user_ids, JSON.stringify([anna, 0]));
  });
});
