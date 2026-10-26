'use strict';

// Person groups (docs/groups.md, services/groups.js): nesting, inheritance,
// leadership walk-up, roles per kind, read-only sources, invitations, CSV,
// usage, archive by end date, delete with confirmation, change events.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let groups;
let db;
before(async () => {
  await setup();
  groups = require('../src/services/groups');
  db = () => require('../src/db/connection').getDb();
});
after(() => teardown());

let seq = 0;
function user(name, { enabled = 1, email } = {}) {
  seq++;
  const n = `${name}${seq}`;
  return Number(db().prepare("INSERT INTO users (username, password_hash, role, enabled, email, display_name) VALUES (?, '!', 'user', ?, ?, ?)")
    .run(n, enabled, email || `${n}@example.com`, n).lastInsertRowid);
}
function uniq(base) { seq++; return `${base} ${seq}`; }
function code(fn, expected) {
  assert.throws(fn, (err) => { assert.equal(err.code, expected, err.message); return true; });
}

beforeEach(() => { groups.flushEvents(); });

describe('migration 109', () => {
  it('creates the tables and columns', () => {
    const { hasColumn, tableExists } = require('../src/db/migrationHelpers');
    for (const t of ['groups', 'group_members', 'group_invites', 'route_group_acl']) assert.ok(tableExists(db(), t), t);
    assert.ok(hasColumn(db(), 'rdp_routes', 'group_ids'));
    assert.ok(hasColumn(db(), 'users', 'disabled_reason'));
    assert.ok(db().prepare('SELECT 1 FROM migration_history WHERE version = 109').get());
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 109);
    assert.equal(m.detect(db()), true);
  });
});

describe('nesting', () => {
  it('builds a path and allows 3 levels, not 4', () => {
    const a = groups.create({ kind: 'department', name: uniq('Verwaltung') });
    const b = groups.create({ kind: 'team', name: 'Buchhaltung', parentId: a.id });
    const c = groups.create({ kind: 'team', name: 'Kreditoren', parentId: b.id });
    assert.equal(c.path, `${a.name} › Buchhaltung › Kreditoren`);
    assert.equal(c.depth, 3);
    assert.deepEqual(groups.get(a.id).childIds, [b.id]);
    code(() => groups.create({ kind: 'team', name: 'Zu tief', parentId: c.id }), 'DEPTH_EXCEEDED');
  });

  it('refuses a move that would exceed the depth or create a cycle', () => {
    const a = groups.create({ kind: 'department', name: uniq('A') });
    const b = groups.create({ kind: 'team', name: 'B', parentId: a.id });
    const x = groups.create({ kind: 'department', name: uniq('X') });
    const y = groups.create({ kind: 'team', name: 'Y', parentId: x.id });
    code(() => groups.move(a.id, b.id), 'CYCLE');
    code(() => groups.move(a.id, a.id), 'CYCLE');
    code(() => groups.move(x.id, b.id), 'DEPTH_EXCEEDED'); // b (2) + x (1) + y (1) = 4
    const moved = groups.move(y.id, b.id);
    assert.equal(moved.depth, 3);
    // update with parentId goes through move — and is atomic with the rename
    code(() => groups.update(x.id, { name: 'X neu', parentId: x.id }), 'CYCLE');
    assert.equal(groups.get(x.id).name, x.name);
  });

  it('names are unique per parent (case-insensitive), not globally', () => {
    const p1 = groups.create({ kind: 'department', name: uniq('P') });
    const p2 = groups.create({ kind: 'department', name: uniq('Q') });
    groups.create({ kind: 'team', name: 'Support', parentId: p1.id });
    groups.create({ kind: 'team', name: 'Support', parentId: p2.id });
    code(() => groups.create({ kind: 'team', name: 'support', parentId: p1.id }), 'NAME_TAKEN');
    code(() => groups.create({ kind: 'department', name: p1.name.toUpperCase() }), 'NAME_TAKEN');
  });

  it('validates kind, name, date and family placement', () => {
    code(() => groups.create({ kind: 'club', name: 'x' }), 'INVALID_KIND');
    code(() => groups.create({ kind: 'team', name: '  ' }), 'INVALID_NAME');
    code(() => groups.create({ kind: 'team', name: 'a › b' }), 'INVALID_NAME');
    code(() => groups.create({ kind: 'team', name: uniq('t'), endsAt: '2030-01-01' }), 'INVALID_DATE');
    code(() => groups.create({ kind: 'project', name: uniq('p'), endsAt: '2030-02-30' }), 'INVALID_DATE');
    const fam = groups.create({ kind: 'family', name: uniq('Familie') });
    code(() => groups.create({ kind: 'team', name: 'Kinder', parentId: fam.id }), 'FAMILY_NESTING');
    const dep = groups.create({ kind: 'department', name: uniq('D') });
    code(() => groups.create({ kind: 'family', name: 'F', parentId: dep.id }), 'FAMILY_NESTING');
  });

  it('list returns a tree and a flat list sorted by path', () => {
    const root = groups.create({ kind: 'site', name: uniq('Büro') });
    groups.create({ kind: 'team', name: 'Empfang', parentId: root.id });
    const tree = groups.list({ tree: true });
    const node = tree.find((g) => g.id === root.id);
    assert.equal(node.children.length, 1);
    assert.equal(node.children[0].name, 'Empfang');
    const flat = groups.list();
    const paths = flat.map((g) => g.path);
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)));
    assert.ok(groups.list({ kind: 'site' }).every((g) => g.kind === 'site'));
  });
});

describe('membership', () => {
  it('a subgroup member is an inherited member of every ancestor', () => {
    const dep = groups.create({ kind: 'department', name: uniq('Vertrieb') });
    const team = groups.create({ kind: 'team', name: 'Innendienst', parentId: dep.id });
    const sub = groups.create({ kind: 'team', name: 'Angebote', parentId: team.id });
    const u = user('anna');
    const v = user('ben');
    groups.setMember(sub.id, u, 'lead');
    groups.setMember(dep.id, v, 'member');
    assert.equal(groups.isMember(u, dep.id), false);
    assert.equal(groups.isMember(u, dep.id, { nested: true }), true);
    const m = groups.members(dep.id, { nested: true });
    const anna = m.find((x) => x.userId === u);
    assert.equal(anna.direct, false);
    assert.equal(anna.role, 'member');
    assert.equal(anna.groupId, sub.id);
    assert.equal(groups.members(dep.id).length, 1);
    const mine = groups.groupsOfUser(u, { includeInherited: true });
    assert.deepEqual(mine.map((g) => [g.id, g.role, g.direct]), [[dep.id, 'member', false], [team.id, 'member', false], [sub.id, 'lead', true]]);
    assert.equal(groups.groupsOfUser(u).length, 1);
    assert.equal(groups.get(dep.id).totalMemberCount, 2);
    assert.deepEqual([...groups.effectiveUserIds([dep.id])].sort(), [u, v].sort());
    assert.deepEqual([...groups.effectiveUserIds([sub.id])], [u]);
    assert.deepEqual(groups.members(dep.id, { nested: true, roles: ['member'] }).length, 2);
  });

  it('roles depend on the kind', () => {
    const team = groups.create({ kind: 'team', name: uniq('Team') });
    const fam = groups.create({ kind: 'family', name: uniq('Familie') });
    const u = user('c');
    code(() => groups.setMember(team.id, u, 'parent'), 'INVALID_ROLE');
    code(() => groups.setMember(fam.id, u, 'lead'), 'INVALID_ROLE');
    assert.equal(groups.setMember(fam.id, u, 'parent').role, 'parent');
    assert.equal(groups.setMember(team.id, u).role, 'member');
    assert.equal(groups.setMember(team.id, u, 'admin').changed, true);
    assert.equal(groups.setMember(team.id, u, 'admin').changed, false);
    code(() => groups.setMember(team.id, 999999, 'member'), 'USER_NOT_FOUND');
    code(() => groups.update(fam.id, { kind: 'team' }), 'INVALID_KIND');
  });

  it('disabled accounts rest; deleted accounts drop their memberships', () => {
    const g = groups.create({ kind: 'team', name: uniq('Ruhe') });
    const u = user('d');
    groups.setMember(g.id, u, 'member');
    groups.flushEvents();
    const seen = [];
    const on = (b) => seen.push(...b);
    groups.events.on('change', on);
    require('../src/services/users').toggle(u);
    assert.equal(db().prepare('SELECT disabled_reason FROM users WHERE id = ?').get(u).disabled_reason, 'admin');
    assert.equal(groups.isMember(u, g.id), false);
    assert.equal(groups.effectiveUserIds([g.id]).size, 0);
    assert.equal(groups.members(g.id)[0].enabled, false);
    require('../src/services/users').toggle(u);
    assert.equal(groups.isMember(u, g.id), true);
    require('../src/services/users').remove(u);
    groups.flushEvents();
    groups.events.off('change', on);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM group_members WHERE user_id = ?').get(u).c, 0);
    assert.deepEqual(seen.map((c) => c.reason), ['user_disabled', 'user_enabled', 'user_deleted']);
    assert.ok(seen.every((c) => c.groupId === g.id && c.userId === u));
  });
});

describe('leadersOf', () => {
  it('lead before deputy, never oneself, walks up when a level has nobody', () => {
    const dep = groups.create({ kind: 'department', name: uniq('Technik') });
    const team = groups.create({ kind: 'team', name: 'Werkstatt', parentId: dep.id });
    const boss = user('boss');
    const dep2 = user('stv');
    const lead = user('lead');
    const worker = user('worker');
    groups.setMember(dep.id, dep2, 'deputy');
    groups.setMember(dep.id, boss, 'lead');
    groups.setMember(team.id, worker, 'member');
    // no lead in the team → the department's lead and deputy
    assert.deepEqual(groups.leadersOf(worker, { groupId: team.id }), [
      { userId: boss, role: 'lead', groupId: dep.id }, { userId: dep2, role: 'deputy', groupId: dep.id }]);
    assert.deepEqual(groups.leadersOf(worker).map((l) => l.userId), [boss, dep2]);
    groups.setMember(team.id, lead, 'lead');
    assert.deepEqual(groups.leadersOf(worker, { groupId: team.id }), [{ userId: lead, role: 'lead', groupId: team.id }]);
    // the team lead's own leader is the level above
    assert.deepEqual(groups.leadersOf(lead, { groupId: team.id }).map((l) => l.userId), [boss, dep2]);
    // a disabled leader does not count
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(lead);
    assert.deepEqual(groups.leadersOf(worker, { groupId: team.id }).map((l) => l.userId), [boss, dep2]);
    // family: the parent leads
    const fam = groups.create({ kind: 'family', name: uniq('Fam') });
    const mum = user('mum');
    const kid = user('kid');
    groups.setMember(fam.id, mum, 'parent');
    groups.setMember(fam.id, kid, 'child');
    assert.deepEqual(groups.leadersOf(kid, { groupId: fam.id }), [{ userId: mum, role: 'parent', groupId: fam.id }]);
  });
});

describe('read-only sources', () => {
  it('directory groups: structure and own members read-only, roles and local members allowed', () => {
    const src = 'directory:1';
    const d = groups.create({ kind: 'team', name: uniq('AD-Team'), source: src, externalId: crypto.randomUUID() });
    const dirUser = user('dir');
    const ext = user('ext');
    // the directory sync (owner) adds its own member
    groups.setMember(d.id, dirUser, 'member', { source: src, owner: src });
    code(() => groups.setMember(d.id, ext, 'member', { source: src }), 'READ_ONLY');
    code(() => groups.update(d.id, { name: 'neu' }), 'READ_ONLY');
    code(() => groups.move(d.id, null), 'READ_ONLY');
    code(() => groups.remove(d.id, { confirmName: d.name }), 'READ_ONLY');
    code(() => groups.create({ kind: 'team', name: 'lokal', parentId: d.id }), 'READ_ONLY');
    code(() => groups.archive(d.id), 'READ_ONLY');
    assert.equal(groups.update(d.id, { color: '#112233' }).color, '#112233');
    // admin: role on a directory member, extra local member
    assert.equal(groups.setMember(d.id, dirUser, 'lead').role, 'lead');
    const added = groups.setMember(d.id, ext, 'member');
    assert.equal(added.source, 'local');
    code(() => groups.removeMember(d.id, dirUser), 'READ_ONLY');
    assert.equal(groups.removeMember(d.id, ext), true);
    // the owner may do everything
    assert.equal(groups.update(d.id, { name: uniq('AD neu') }, { owner: src }).readOnly, true);
    assert.equal(groups.removeMember(d.id, dirUser, { owner: src }), true);
  });

  it('plugin groups are read-only for admins (members too)', () => {
    const src = 'plugin:gatecontrol-familie';
    const f = groups.create({ kind: 'family', name: uniq('Familie Backes'), source: src, externalId: 'family' + seq });
    const u = user('p');
    code(() => groups.setMember(f.id, u, 'parent'), 'READ_ONLY');
    groups.setMember(f.id, u, 'parent', { source: src, owner: src });
    code(() => groups.setMember(f.id, u, 'child'), 'READ_ONLY');
    code(() => groups.removeMember(f.id, u), 'READ_ONLY');
    code(() => groups.createInvite(f.id), 'READ_ONLY');
    code(() => groups.create({ kind: 'team', name: 'x', source: 'evil source' }), 'INVALID_SOURCE');
  });
});

describe('invites', () => {
  it('accepts within expiry and maxUses, counts no use for an existing member', () => {
    const g = groups.create({ kind: 'team', name: uniq('Einladung') });
    const inv = groups.createInvite(g.id, { role: 'member', expiresInDays: 7, maxUses: 2 });
    assert.match(inv.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(groups.lookupInvite(inv.token).groupId, g.id);
    const a = user('a'); const b = user('b'); const c = user('c');
    assert.deepEqual(groups.acceptInvite(inv.token, a), { groupId: g.id, role: 'member', already: false });
    assert.equal(groups.acceptInvite(inv.token, a).already, true);
    groups.acceptInvite(inv.token, b);
    code(() => groups.acceptInvite(inv.token, c), 'INVITE_INVALID');
    assert.equal(groups.lookupInvite(inv.token), null);
    assert.equal(groups.isMember(b, g.id), true);
    assert.equal(groups.listInvites(g.id)[0].uses, 2);
    // the raw token is not stored
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM group_invites WHERE token_hash = ?').get(inv.token).c, 0);
  });

  it('refuses expired, unknown, revoked tokens and disabled accounts', () => {
    const g = groups.create({ kind: 'team', name: uniq('Ablauf') });
    const inv = groups.createInvite(g.id, { maxUses: 5 });
    db().prepare("UPDATE group_invites SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    code(() => groups.acceptInvite(inv.token, user('e')), 'INVITE_INVALID');
    code(() => groups.acceptInvite('nope', user('f')), 'INVITE_INVALID');
    const inv2 = groups.createInvite(g.id, { role: 'deputy' });
    code(() => groups.acceptInvite(inv2.token, user('g', { enabled: 0 })), 'USER_DISABLED');
    assert.equal(groups.revokeInvite(g.id, inv2.id), true);
    code(() => groups.acceptInvite(inv2.token, user('h')), 'INVITE_INVALID');
    code(() => groups.createInvite(g.id, { expiresInDays: 90 }), 'INVALID');
    code(() => groups.createInvite(g.id, { role: 'child' }), 'INVALID_ROLE');
  });
});

describe('CSV import', () => {
  it('creates missing local groups, sets roles and reports per-line errors', () => {
    const mail = `csv${seq}@firma.de`;
    const u = user('csv', { email: mail });
    const top = uniq('Import');
    const text = [
      'pfad;email;rolle',
      `${top} › Buchhaltung;${mail};Leitung`,
      `${top}/Einkauf;${mail};mitglied`,
      `${top}/Einkauf;unknown@nowhere.example;member`,
      `${top}/Einkauf;${mail};chef`,
      `${top}/A/B/C;${mail};member`,
      '',
      `# comment`,
      `${top}/Einkauf;${mail.toUpperCase()};member`,
    ].join('\n');
    const r = groups.importCsv(text, {});
    assert.deepEqual(r.created, [top, `${top} › Buchhaltung`, `${top} › Einkauf`]);
    assert.equal(r.added, 2);
    assert.equal(r.unchanged, 1);
    assert.deepEqual(r.errors.map((e) => [e.line, e.code]), [[4, 'USER_NOT_FOUND'], [5, 'INVALID_ROLE'], [6, 'DEPTH_EXCEEDED']]);
    const mine = groups.groupsOfUser(u);
    assert.deepEqual(mine.map((g) => [g.path, g.role]), [[`${top} › Buchhaltung`, 'lead'], [`${top} › Einkauf`, 'member']]);
    assert.equal(groups.get(mine[0].id).kind, 'team');
    assert.equal(groups.list().find((g) => g.path === top).kind, 'department');
  });
});

describe('usage, archive, delete', () => {
  it('lists routes, RDP entries and provider entries', async () => {
    const g = groups.create({ kind: 'project', name: uniq('Umzug') });
    const r = db().prepare("INSERT INTO routes (domain, target_ip, target_port, label) VALUES (?, '10.0.0.5', 80, 'Planer')").run(`umzug${seq}.example.com`);
    db().prepare('INSERT INTO route_group_acl (route_id, group_id) VALUES (?, ?)').run(r.lastInsertRowid, g.id);
    const rdp = db().prepare("INSERT INTO rdp_routes (name, host, group_ids) VALUES ('PC 2', '10.0.0.9', ?)").run(JSON.stringify([g.id]));
    const off = groups.registerUsageProvider(async (id) => (id === g.id ? [{ kind: 'Drive', label: 'Team-Ordner', onDelete: 'wird verschoben' }] : []));
    const broken = groups.registerUsageProvider(async () => { throw new Error('boom'); });
    const u = await groups.usage(g.id);
    off(); broken();
    assert.deepEqual(u.map((x) => [x.kind, x.label]), [['route', 'Planer'], ['rdp', 'PC 2'], ['Drive', 'Team-Ordner']]);
    assert.equal(u[2].onDelete, 'wird verschoben');
    // delete: confirmation, RDP list cleaned, route ACL cascades
    code(() => groups.remove(g.id, { confirmName: 'falsch' }), 'CONFIRM_MISMATCH');
    db().prepare('UPDATE rdp_routes SET user_ids = ? WHERE id = ?').run('[1]', rdp.lastInsertRowid);
    assert.equal(groups.remove(g.id, { confirmName: g.name }), true);
    assert.equal(groups.get(g.id), null);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM route_group_acl WHERE group_id = ?').get(g.id).c, 0);
    assert.equal(db().prepare('SELECT group_ids FROM rdp_routes WHERE id = ?').get(rdp.lastInsertRowid).group_ids, null);
  });

  it('usage says what deleting does: the only restriction → stays locked, else only this release ends', async () => {
    const g = groups.create({ kind: 'team', name: uniq('Wirkung') });
    const other = groups.create({ kind: 'team', name: uniq('Andere') });
    const p = user('wirkung');
    const route = (label, userIds) => {
      const id = Number(db().prepare("INSERT INTO routes (domain, target_ip, target_port, label, user_ids) VALUES (?, '10.0.0.5', 80, ?, ?)")
        .run(`${label.toLowerCase()}${seq}.example.com`, label, userIds == null ? null : JSON.stringify(userIds)).lastInsertRowid);
      db().prepare('INSERT INTO route_group_acl (route_id, group_id) VALUES (?, ?)').run(id, g.id);
      return id;
    };
    route('Solo');
    route('Marker', [0]); // the NOBODY marker is not a person
    route('Person', [p]);
    const both = route('Zwei');
    db().prepare('INSERT INTO route_group_acl (route_id, group_id) VALUES (?, ?)').run(both, other.id);
    db().prepare("INSERT INTO rdp_routes (name, host, group_ids) VALUES ('RDP Solo', '10.0.0.9', ?)").run(JSON.stringify([g.id]));
    db().prepare("INSERT INTO rdp_routes (name, host, group_ids, user_ids) VALUES ('RDP Person', '10.0.0.9', ?, ?)").run(JSON.stringify([g.id]), JSON.stringify([p]));
    db().prepare("INSERT INTO rdp_routes (name, host, group_ids) VALUES ('RDP Zwei', '10.0.0.9', ?)").run(JSON.stringify([g.id, other.id]));
    const u = await groups.usage(g.id);
    const key = (label) => u.find((x) => x.label === label).onDeleteKey;
    assert.equal(key('Solo'), 'grp.usage.route_locked');
    assert.equal(key('Marker'), 'grp.usage.route_locked');
    assert.equal(key('Person'), 'grp.usage.route_dropped');
    assert.equal(key('Zwei'), 'grp.usage.route_dropped');
    assert.equal(key('RDP Solo'), 'grp.usage.rdp_locked');
    assert.equal(key('RDP Person'), 'grp.usage.rdp_dropped');
    assert.equal(key('RDP Zwei'), 'grp.usage.rdp_dropped');
    assert.ok(u.every((x) => x.core && x.onDelete === null), 'core entries carry a key, no text');
  });

  it('defaultSuccessor / resolveSuccessor: lead, else deputy, walking up; none; enabled accounts only', () => {
    const top = groups.create({ kind: 'department', name: uniq('Oben') });
    const sub = groups.create({ kind: 'team', name: 'Unten', parentId: top.id });
    assert.equal(groups.defaultSuccessor(sub.id), null);
    assert.equal(groups.resolveSuccessor(sub.id, null), null);
    const boss = user('boss');
    const dep = user('dep');
    groups.setMember(top.id, boss, 'lead');
    let d = groups.defaultSuccessor(sub.id);
    assert.equal(d.userId, boss);
    assert.equal(d.groupId, top.id);
    assert.equal(d.inherited, true);
    groups.setMember(sub.id, dep, 'deputy');
    d = groups.defaultSuccessor(sub.id);
    assert.deepEqual([d.userId, d.role, d.inherited], [dep, 'deputy', false]);
    assert.equal(groups.resolveSuccessor(sub.id, ''), dep);
    assert.equal(groups.resolveSuccessor(sub.id, 'none'), null);
    assert.equal(groups.resolveSuccessor(sub.id, 0), null);
    assert.equal(groups.resolveSuccessor(sub.id, String(boss)), boss);
    code(() => groups.resolveSuccessor(sub.id, 987654), 'USER_NOT_FOUND');
    code(() => groups.resolveSuccessor(sub.id, user('aus', { enabled: 0 })), 'USER_DISABLED');
  });

  it('a list that only named the group stays when the entry names nobody else', () => {
    const g = groups.create({ kind: 'team', name: uniq('Allein') });
    const rdp = db().prepare("INSERT INTO rdp_routes (name, host, group_ids) VALUES ('PC 3', '10.0.0.10', ?)").run(JSON.stringify([g.id]));
    groups.remove(g.id, { confirmName: g.name });
    assert.equal(db().prepare('SELECT group_ids FROM rdp_routes WHERE id = ?').get(rdp.lastInsertRowid).group_ids, JSON.stringify([g.id]));
  });

  it('refuses to delete a group with subgroups', () => {
    const p = groups.create({ kind: 'department', name: uniq('Eltern') });
    groups.create({ kind: 'team', name: 'Kind', parentId: p.id });
    code(() => groups.remove(p.id, { confirmName: p.name }), 'HAS_CHILDREN');
  });

  it('archives projects after their end date, with subgroups; access ends', () => {
    const p = groups.create({ kind: 'project', name: uniq('Projekt'), endsAt: '2026-03-31' });
    const sub = groups.create({ kind: 'team', name: 'Kern', parentId: p.id });
    const future = groups.create({ kind: 'project', name: uniq('Später'), endsAt: '2099-12-31' });
    const u = user('pm');
    groups.setMember(sub.id, u, 'member');
    assert.equal(groups.archiveExpired(new Date('2026-03-31T12:00:00')), 0); // the last day still counts
    assert.equal(groups.archiveExpired(new Date('2026-04-01T08:00:00')), 1);
    assert.equal(groups.get(p.id).archived, true);
    assert.equal(groups.get(sub.id).archived, true);
    assert.equal(groups.get(future.id).archived, false);
    assert.equal(groups.isMember(u, sub.id), false);
    assert.equal(groups.effectiveUserIds([p.id]).size, 0);
    assert.equal(groups.groupsOfUser(u).length, 0);
    assert.equal(groups.groupsOfUser(u, { includeArchived: true }).length, 1);
    assert.ok(!groups.list().some((g) => g.id === p.id));
    assert.ok(groups.list({ includeArchived: true }).some((g) => g.id === p.id));
    // data is kept; restoring clears the passed end date
    assert.equal(groups.members(sub.id).length, 1);
    const back = groups.unarchive(p.id);
    assert.equal(back.archived, false);
    assert.equal(back.endsAt, null);
    assert.equal(groups.get(sub.id).archived, false);
  });
});

describe('change events', () => {
  it('are batched and flushed once', async () => {
    groups.flushEvents();
    const batches = [];
    const on = (b) => batches.push(b);
    groups.events.on('change', on);
    const g = groups.create({ kind: 'team', name: uniq('Events') });
    const u = user('ev');
    groups.setMember(g.id, u, 'member');
    groups.setMember(g.id, u, 'lead');
    groups.update(g.id, { name: uniq('Events neu') });
    groups.removeMember(g.id, u);
    groups.archive(g.id);
    assert.equal(batches.length, 0, 'nothing before the batch window ends');
    await new Promise((r) => setTimeout(r, groups.BATCH_MS + 150));
    groups.events.off('change', on);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map((c) => c.type), ['group_created', 'member_added', 'role_changed', 'group_renamed', 'member_removed', 'group_archived']);
    assert.deepEqual(batches[0][2], { type: 'role_changed', groupId: g.id, userId: u, role: 'lead' });
    assert.deepEqual(groups.flushEvents(), []);
  });

  it('flushEvents emits synchronously', () => {
    const batches = [];
    const on = (b) => batches.push(b);
    groups.events.on('change', on);
    const g = groups.create({ kind: 'site', name: uniq('Sync') });
    groups.flushEvents();
    groups.events.off('change', on);
    assert.deepEqual(batches, [[{ type: 'group_created', groupId: g.id }]]);
  });

  it('writes activity entries', () => {
    const g = groups.create({ kind: 'team', name: uniq('Log') });
    const rows = db().prepare("SELECT event_type FROM activity_log WHERE json_extract(details, '$.groupId') = ?").all(g.id);
    assert.deepEqual(rows.map((r) => r.event_type), ['group_created']);
  });
});
