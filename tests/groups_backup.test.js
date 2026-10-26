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

describe('backup round trip with directory connections', () => {
  let anna, ben, peerId, dirId, parent, dirGroup;
  const store = () => require('../src/services/directory/store');
  const { encrypt } = require('../src/utils/crypto');

  // A secret encrypted like utils/crypto does, but with another server key.
  function foreignSecret(text) {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = c.update(text, 'utf8', 'hex') + c.final('hex');
    return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc}`;
  }

  before(() => {
    const uid = (name) => db().prepare('SELECT id FROM users WHERE username = ?').get(name).id;
    anna = uid('bk-anna');
    ben = uid('bk-ben');
    peerId = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('bk-dir-peer', 'BKDIRPEER=', '10.8.0.77/32', 0)").run().lastInsertRowid);
    parent = groups().list().find((g) => g.name === 'Verwaltung');
    dirId = Number(db().prepare(`INSERT INTO directories (kind, name, config_json, secret_enc, selected_groups, parent_group_id, last_status)
      VALUES ('ad', 'Firma AD', ?, ?, ?, ?, 'pending')`).run(JSON.stringify({ host: 'dc.corp.local', port: 636, security: 'ldaps', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' }),
      encrypt('geheim'), JSON.stringify([{ externalId: 'g-1', name: 'Vertrieb' }]), parent.id).lastInsertRowid);
    dirGroup = groups().create({ kind: 'team', name: 'Vertrieb', parentId: parent.id, source: `directory:${dirId}`, externalId: 'g-1' });
    groups().setMember(dirGroup.id, anna, 'member', { source: `directory:${dirId}`, owner: `directory:${dirId}` });
    db().prepare(`INSERT INTO directory_links (user_id, directory_id, external_id, login_name, upn, email, state, disabled_peer_ids)
      VALUES (?, ?, 'u-anna', 'anna', 'anna@corp.local', 'anna@corp.local', 'disabled', ?)`).run(anna, dirId, JSON.stringify([peerId]));
    db().prepare(`INSERT INTO directory_conflicts (directory_id, external_id, user_id, email, display_name, login_name, status)
      VALUES (?, 'u-ben', ?, 'ben@corp.local', 'Ben', 'ben', 'open')`).run(dirId, ben);
    db().prepare("INSERT INTO directory_runs (directory_id, trigger, status, started_at) VALUES (?, 'manual', 'pending', datetime('now'))").run(dirId);
  });

  it('exports connections (secret as stored), links and conflicts with user refs — not the runs', () => {
    const b = backup().createBackup();
    const d = b.data.directories.find((x) => x.name === 'Firma AD');
    assert.equal(d.directory_ref, dirId);
    assert.equal(d.secret_enc, db().prepare('SELECT secret_enc FROM directories WHERE id = ?').get(dirId).secret_enc, 'encrypted exactly as stored');
    assert.ok(!JSON.stringify(b).includes('geheim'), 'never the plain secret');
    const l = b.data.directory_links.find((x) => x.external_id === 'u-anna');
    assert.deepEqual([l.user_ref, l.user_name, l.directory_ref], [anna, 'bk-anna', dirId]);
    assert.deepEqual(l.disabled_peer_names, ['bk-dir-peer']);
    const c = b.data.directory_conflicts.find((x) => x.external_id === 'u-ben');
    assert.deepEqual([c.user_ref, c.user_name, c.status], [ben, 'bk-ben', 'open']);
    assert.ok(!('directory_runs' in b.data));
    assert.equal(backup().getBackupSummary(b).directories, 1);
  });

  it('restores ids, secret, links (same user ids, peers by name) and conflicts; a waiting run is dropped', async () => {
    const b = JSON.parse(JSON.stringify(backup().createBackup()));
    db().prepare("UPDATE directories SET name = 'Umbenannt' WHERE id = ?").run(dirId);
    db().prepare('DELETE FROM directory_links').run();
    const result = await backup().restoreBackup(b);
    assert.equal(result.directories, 1);
    assert.deepEqual(result.directories_secret_reentry, []);
    const row = store().load(dirId);
    assert.equal(row.name, 'Firma AD');
    assert.equal(row.parent_group_id, parent.id);
    assert.equal(store().secretOf(row), 'geheim');
    assert.equal(row.last_status, null, 'the stopped run is not in the backup');
    assert.equal(store().get(dirId).needsSecret, false);
    assert.equal(groups().get(dirGroup.id).source, `directory:${dirId}`);
    const newPeer = db().prepare("SELECT id FROM peers WHERE name = 'bk-dir-peer'").get().id;
    const link = db().prepare("SELECT * FROM directory_links WHERE external_id = 'u-anna'").get();
    assert.equal(link.user_id, anna);
    assert.equal(link.directory_id, dirId);
    assert.equal(link.state, 'disabled');
    assert.equal(link.disabled_peer_ids, JSON.stringify([newPeer]));
    const conflict = db().prepare("SELECT * FROM directory_conflicts WHERE external_id = 'u-ben'").get();
    assert.equal(conflict.user_id, ben);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM directory_runs').get().c, 0);
    assert.equal(store().get(dirId).stats.linked, 1);
  });

  it('a secret from a server with another key is dropped and marked for re-entry, the restore goes on', async () => {
    const b = JSON.parse(JSON.stringify(backup().createBackup()));
    b.data.directories.find((x) => x.directory_ref === dirId).secret_enc = foreignSecret('fremd');
    const result = await backup().restoreBackup(b);
    assert.deepEqual(result.directories_secret_reentry, ['Firma AD']);
    const row = store().load(dirId);
    assert.equal(row.secret_enc, null);
    const shape = store().get(dirId);
    assert.equal(shape.needsSecret, true);
    assert.equal(shape.hasSecret, false);
    assert.equal(db().prepare("SELECT user_id FROM directory_links WHERE external_id = 'u-anna'").get().user_id, anna, 'links still restored');
    // the schedule waits until the secret is entered again
    await require('../src/services/directory/sync').runDue(Date.now());
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM directory_runs WHERE directory_id = ?').get(dirId).c, 0);
    store().update(dirId, { secret: 'neu' });
    assert.equal(store().get(dirId).needsSecret, false);
  });

  it('a backup without the directory section leaves the connections alone', async () => {
    const old = JSON.parse(JSON.stringify(backup().createBackup()));
    delete old.data.directories; delete old.data.directory_links; delete old.data.directory_conflicts;
    db().prepare("UPDATE directories SET name = 'Nach der Sicherung' WHERE id = ?").run(dirId);
    await backup().restoreBackup(old);
    assert.equal(store().load(dirId).name, 'Nach der Sicherung');
  });
});
