'use strict';

// Directory sync engine (services/directory/sync.js) with a fake adapter:
// accounts created / linked by e-mail / conflicts, disabling with sessions,
// tokens and VPN peers, re-enabling, the mass-change guard, an unreachable
// directory, administrators and the read-only imported groups.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, teardown } = require('./helpers/setup');

before(async () => { await setup(); });
after(() => teardown());

function db() { return require('../src/db/connection').getDb(); }
const store = () => require('../src/services/directory/store');
const sync = () => require('../src/services/directory/sync');
const adapters = () => require('../src/services/directory/adapters');
const groups = () => require('../src/services/groups');

/** A fake directory: users and groups in memory, optional failure. */
function makeFake() {
  const state = { users: new Map(), groups: new Map(), fail: false, fetches: 0 };
  const adapter = {
    kind: 'fake',
    async test() { if (state.fail) throw new Error('connect ECONNREFUSED'); return { ok: true, details: { sampleGroups: state.groups.size } }; },
    async searchGroups(q) {
      return [...state.groups.entries()].filter(([, g]) => !q || g.name.toLowerCase().includes(String(q).toLowerCase()))
        .map(([id, g]) => ({ externalId: id, name: g.name, dn: `CN=${g.name},OU=Gruppen`, description: null }));
    },
    async fetch(selected) {
      state.fetches++;
      if (state.fail) throw new Error('connect ECONNREFUSED 10.0.0.5:636');
      const users = new Map();
      const out = (selected || []).map((s) => {
        const g = state.groups.get(s.externalId);
        if (!g) return { externalId: s.externalId, name: s.name, found: false, members: [] };
        for (const m of g.members) if (state.users.has(m)) users.set(m, state.users.get(m));
        return { externalId: s.externalId, name: g.name, found: true, members: [...g.members] };
      });
      return { groups: out, users: [...users.values()] };
    },
    async authenticate() { return { ok: false, reason: 'invalid' }; },
  };
  return {
    state,
    adapter,
    user(id, extra) {
      const u = { externalId: id, loginName: id, upn: `${id}@corp.local`, dn: `CN=${id},OU=Staff`, email: `${id}@firma.de`, displayName: id.toUpperCase(), enabled: true, ...(extra || {}) };
      state.users.set(id, u);
      return u;
    },
    group(id, name, members) { state.groups.set(id, { name, members: new Set(members) }); },
  };
}

let fake;
let dirSeq = 0;
function newDirectory(extra) {
  dirSeq++;
  return store().create({
    kind: 'ad', name: `AD ${dirSeq}`, secret: 'Svc!Pass123',
    config: { host: 'dc01.corp.local', security: 'ldaps', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' },
    ...(extra || {}),
  }, { actor: 1 });
}

function linkOf(userId) { return db().prepare('SELECT * FROM directory_links WHERE user_id = ?').get(userId); }
function userByUsername(name) { return db().prepare('SELECT * FROM users WHERE username = ?').get(name); }
function userIdOfExt(dirId, ext) {
  const r = db().prepare('SELECT user_id FROM directory_links WHERE directory_id = ? AND external_id = ?').get(dirId, ext);
  return r ? r.user_id : null;
}

beforeEach(() => {
  fake = makeFake();
  adapters()._setFactory(() => fake.adapter);
});

describe('creating and linking accounts', () => {
  it('creates role-user accounts for members of the selected groups, imports the group read-only', async () => {
    fake.user('anna'); fake.user('ben'); fake.user('carl');
    fake.group('g-buch', 'Buchhaltung', ['anna', 'ben']);
    fake.group('g-other', 'Druckeradmins', ['carl']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'g-buch', name: 'Buchhaltung' }] });
    const run = await sync().run(d.id, { trigger: 'manual' });
    assert.equal(run.status, 'ok', JSON.stringify(run));
    assert.equal(run.summary.created, 2);
    const anna = userByUsername('anna');
    assert.ok(anna);
    assert.equal(anna.role, 'user');
    assert.equal(anna.enabled, 1);
    assert.equal(anna.password_hash, '!', 'no password is stored');
    assert.equal(anna.email, 'anna@firma.de');
    assert.equal(linkOf(anna.id).external_id, 'anna');
    assert.equal(userByUsername('carl'), undefined, 'not in a selected group');
    const g = db().prepare('SELECT * FROM groups WHERE source = ? AND external_id = ?').get(`directory:${d.id}`, 'g-buch');
    assert.ok(g);
    assert.equal(g.name, 'Buchhaltung');
    const members = groups().members(g.id);
    assert.deepEqual(members.map((m) => m.username).sort(), ['anna', 'ben']);
    assert.ok(members.every((m) => m.source === `directory:${d.id}`));
    // read-only for admins: name and directory members
    assert.throws(() => groups().update(g.id, { name: 'X' }), (e) => e.code === 'READ_ONLY');
    assert.throws(() => groups().removeMember(g.id, anna.id), (e) => e.code === 'READ_ONLY');
    // a GateControl role is still allowed
    groups().setMember(g.id, anna.id, 'lead');
    const activity = db().prepare("SELECT COUNT(*) AS c FROM activity_log WHERE event_type = 'user_created' AND message LIKE '%directory sync%'").get().c;
    assert.ok(activity >= 2);
    // second run: nothing new, role kept
    const again = await sync().run(d.id);
    assert.equal(again.summary.created, 0);
    assert.equal(groups().members(g.id).find((m) => m.userId === anna.id).role, 'lead');
  });

  it('records a conflict for an existing local account with the same e-mail instead of linking', async () => {
    const localId = Number(db().prepare("INSERT INTO users (username, password_hash, role, email) VALUES ('jkeller-local', '!', 'user', 'J.Keller@Firma.de')").run().lastInsertRowid);
    fake.user('jkeller', { email: 'j.keller@firma.de' });
    fake.group('g1', 'Einkauf', ['jkeller']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'g1', name: 'Einkauf' }] });
    const run = await sync().run(d.id);
    assert.equal(run.status, 'ok');
    assert.equal(run.summary.conflicts, 1);
    assert.equal(linkOf(localId), undefined, 'never linked silently');
    assert.equal(userByUsername('jkeller'), undefined, 'no second account while the conflict is open');
    const conflicts = sync().listConflicts(d.id);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].user.id, localId);
    assert.equal(conflicts[0].canMerge, true);
    // a second run does not duplicate it
    await sync().run(d.id);
    assert.equal(sync().listConflicts(d.id).length, 1);
    // merge → linked; the next run adds the membership and the name
    sync().resolveConflict(d.id, conflicts[0].id, 'merge', { actor: 1 });
    assert.equal(linkOf(localId).external_id, 'jkeller');
    await sync().run(d.id);
    const g = db().prepare('SELECT id FROM groups WHERE source = ? AND external_id = ?').get(`directory:${d.id}`, 'g1');
    assert.ok(groups().isMember(localId, g.id));
    assert.equal(db().prepare('SELECT display_name FROM users WHERE id = ?').get(localId).display_name, 'JKELLER');
  });

  it('"getrennt lassen" gives the directory person an own account at the next run', async () => {
    db().prepare("INSERT INTO users (username, password_hash, role, email) VALUES ('mia', '!', 'user', 'mia@firma.de')").run();
    fake.user('mia');
    fake.group('g2', 'Vertrieb', ['mia']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'g2', name: 'Vertrieb' }] });
    await sync().run(d.id);
    const [c] = sync().listConflicts(d.id);
    sync().resolveConflict(d.id, c.id, 'separate', { actor: 1 });
    const run = await sync().run(d.id);
    assert.equal(run.summary.created, 1);
    const uid = userIdOfExt(d.id, 'mia');
    assert.ok(uid);
    assert.notEqual(uid, userByUsername('mia').id);
    assert.equal(db().prepare('SELECT username FROM users WHERE id = ?').get(uid).username, 'mia-2');
  });

  it('does not create accounts when "Konten anlegen" is off', async () => {
    fake.user('noprov');
    fake.group('g3', 'Lager', ['noprov']);
    const d = newDirectory({ provision: false, selectedGroups: [{ externalId: 'g3', name: 'Lager' }] });
    const run = await sync().run(d.id);
    assert.equal(run.summary.created, 0);
    assert.equal(run.summary.skipped, 1);
    assert.equal(userByUsername('noprov'), undefined);
  });
});

describe('disabling and enabling', () => {
  it('disables the account, ends sessions, revokes tokens, disables VPN peers at once; re-enabling restores account and peers only', async () => {
    for (const u of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11']) fake.user(u);
    fake.group('gd', 'Team D', ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gd', name: 'Team D' }] });
    await sync().run(d.id);
    const uid = userIdOfExt(d.id, 'd1');
    const peerOwned = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES ('d1-laptop', ?, '10.8.0.51/32', 1, 'regular', ?)").run(crypto.randomBytes(8).toString('hex'), uid).lastInsertRowid);
    const peerApp = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('d1-phone', ?, '10.8.0.52/32', 1, 'regular')").run(crypto.randomBytes(8).toString('hex')).lastInsertRowid);
    const peerOff = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES ('d1-old', ?, '10.8.0.53/32', 0, 'regular', ?)").run(crypto.randomBytes(8).toString('hex'), uid).lastInsertRowid);
    db().prepare("INSERT INTO api_tokens (name, token_hash, scopes, user_id, peer_id) VALUES ('d1-app', ?, '[\"client\"]', ?, ?)").run(crypto.randomBytes(16).toString('hex'), uid, peerApp);
    db().prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)').run('sid-d1-web', JSON.stringify({ userId: uid, cookie: {} }), Date.now() + 3600000);
    db().prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)').run('sid-d1-portal', JSON.stringify({ portalUserId: uid, cookie: {} }), Date.now() + 3600000);

    // deactivated in the directory (still in the group)
    fake.state.users.get('d1').enabled = false;
    const run = await sync().run(d.id);
    assert.equal(run.status, 'ok', JSON.stringify(run));
    assert.equal(run.summary.disabled, 1);
    const u = db().prepare('SELECT * FROM users WHERE id = ?').get(uid);
    assert.equal(u.enabled, 0);
    assert.equal(u.disabled_reason, 'directory');
    assert.equal(db().prepare("SELECT COUNT(*) AS c FROM sessions WHERE sid IN ('sid-d1-web', 'sid-d1-portal')").get().c, 0);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?').get(uid).c, 0);
    assert.equal(db().prepare('SELECT enabled FROM peers WHERE id = ?').get(peerOwned).enabled, 0);
    assert.equal(db().prepare('SELECT enabled FROM peers WHERE id = ?').get(peerApp).enabled, 0);
    const link = linkOf(uid);
    assert.equal(link.state, 'disabled');
    assert.deepEqual(JSON.parse(link.disabled_peer_ids).sort(), [peerOwned, peerApp].sort());
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'user_toggled' AND message LIKE '%disabled by the directory sync%'").get());
    const details = sync().getRun(d.id, run.id).details;
    assert.equal(details.disabled[0].why, 'deactivated');
    assert.equal(details.disabled[0].peers, 2);

    // active again → account and exactly the remembered peers, not the token
    fake.state.users.get('d1').enabled = true;
    const back = await sync().run(d.id);
    assert.equal(back.summary.enabled, 1);
    const u2 = db().prepare('SELECT * FROM users WHERE id = ?').get(uid);
    assert.equal(u2.enabled, 1);
    assert.equal(u2.disabled_reason, null);
    assert.equal(db().prepare('SELECT enabled FROM peers WHERE id = ?').get(peerOwned).enabled, 1);
    assert.equal(db().prepare('SELECT enabled FROM peers WHERE id = ?').get(peerApp).enabled, 1);
    assert.equal(db().prepare('SELECT enabled FROM peers WHERE id = ?').get(peerOff).enabled, 0, 'a peer that was off before stays off');
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?').get(uid).c, 0, 'tokens stay revoked');
    assert.equal(linkOf(uid).state, 'active');
  });

  it('removed from every selected group or deleted → disabled; an admin-disabled account is not enabled by the sync', async () => {
    for (const u of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11']) fake.user(u);
    fake.group('gr', 'Team R', ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gr', name: 'Team R' }] });
    await sync().run(d.id);
    fake.state.groups.get('gr').members.delete('r1');
    const run = await sync().run(d.id);
    assert.equal(run.summary.disabled, 1);
    assert.equal(sync().getRun(d.id, run.id).details.disabled[0].why, 'removed', 'deleted and left all groups look the same');
    // admin disables r2 by hand → the sync leaves it disabled
    const r2 = userIdOfExt(d.id, 'r2');
    require('../src/services/users').toggle(r2, { actorId: 1 });
    await sync().run(d.id);
    assert.equal(db().prepare('SELECT enabled, disabled_reason FROM users WHERE id = ?').get(r2).enabled, 0);
    assert.equal(db().prepare('SELECT disabled_reason FROM users WHERE id = ?').get(r2).disabled_reason, 'admin');
  });

  it('with "Sperren" off nobody is disabled', async () => {
    fake.user('k1');
    fake.group('gk', 'Team K', ['k1']);
    const d = newDirectory({ deprovision: false, selectedGroups: [{ externalId: 'gk', name: 'Team K' }] });
    await sync().run(d.id);
    fake.state.users.get('k1').enabled = false;
    const run = await sync().run(d.id);
    assert.equal(run.summary.disabled, 0);
    assert.equal(db().prepare('SELECT enabled FROM users WHERE id = ?').get(userIdOfExt(d.id, 'k1')).enabled, 1);
  });
});

describe('mass-change guard and unreachable directory', () => {
  it('stops before disabling more than 10 % (at least 3); a confirmation applies exactly that', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    ids.forEach((u) => fake.user(u));
    fake.group('gm', 'Team M', ids);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gm', name: 'Team M' }] });
    await sync().run(d.id);
    for (const u of ['m0', 'm1', 'm2']) fake.state.groups.get('gm').members.delete(u);
    fake.user('m-new');
    fake.state.groups.get('gm').members.add('m-new');
    const run = await sync().run(d.id);
    assert.equal(run.status, 'pending');
    assert.equal(run.guardReason, 'mass_disable');
    assert.equal(run.plan.disable.length, 3);
    // nothing changed, not even the new account
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM users u JOIN directory_links l ON l.user_id = u.id WHERE l.directory_id = ? AND u.enabled = 1').get(d.id).c, 10);
    assert.equal(userIdOfExt(d.id, 'm-new'), null);
    assert.equal(store().get(d.id).pendingRun.id, run.id);
    assert.equal(store().get(d.id).lastStatus, 'pending');
    // the scheduler pauses while the confirmation is open
    const runsBefore = db().prepare('SELECT COUNT(*) AS c FROM directory_runs WHERE directory_id = ?').get(d.id).c;
    await sync().runDue(Date.now() + 3600 * 1000 * 48);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM directory_runs WHERE directory_id = ?').get(d.id).c, runsBefore);

    // a 4th person disappears before the admin confirms → stops again
    fake.state.groups.get('gm').members.delete('m3');
    const again = await sync().confirm(d.id, run.id, { actor: 1 });
    assert.equal(again.status, 'pending');
    assert.equal(again.plan.disable.length, 4);
    assert.equal(sync().getRun(d.id, run.id).status, 'superseded');

    const done = await sync().confirm(d.id, again.id, { actor: 1 });
    assert.equal(done.status, 'ok');
    assert.equal(done.summary.disabled, 4);
    assert.equal(sync().getRun(d.id, again.id).status, 'confirmed');
    assert.ok(userIdOfExt(d.id, 'm-new'));
    assert.equal(store().get(d.id).pendingRun, null);
  });

  it('stops when every selected group comes back empty; discard changes nothing', async () => {
    fake.user('e1'); fake.user('e2');
    fake.group('ge', 'Team E', ['e1', 'e2']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'ge', name: 'Team E' }] });
    await sync().run(d.id);
    fake.state.groups.get('ge').members.clear();
    const run = await sync().run(d.id);
    assert.equal(run.status, 'pending');
    assert.match(run.guardReason, /all_groups_empty/);
    const r = sync().discard(d.id, run.id, { actor: 1 });
    assert.equal(r.status, 'discarded');
    assert.equal(db().prepare('SELECT enabled FROM users WHERE id = ?').get(userIdOfExt(d.id, 'e1')).enabled, 1);
    assert.throws(() => sync().discard(d.id, run.id), (e) => e.code === 'RUN_NOT_PENDING');
  });

  it('an unreachable directory changes nothing', async () => {
    fake.user('u1'); fake.user('u2');
    fake.group('gu', 'Team U', ['u1', 'u2']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gu', name: 'Team U' }] });
    await sync().run(d.id);
    const before = db().prepare('SELECT COUNT(*) AS c FROM group_members m JOIN groups g ON g.id = m.group_id WHERE g.source = ?').get(`directory:${d.id}`).c;
    fake.state.fail = true;
    const run = await sync().run(d.id);
    assert.equal(run.status, 'error');
    assert.match(run.error, /ECONNREFUSED/);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM users u JOIN directory_links l ON l.user_id = u.id WHERE l.directory_id = ? AND u.enabled = 1').get(d.id).c, 2);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM group_members m JOIN groups g ON g.id = m.group_id WHERE g.source = ?').get(`directory:${d.id}`).c, before);
    const dir = store().get(d.id);
    assert.equal(dir.lastStatus, 'error');
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'directory_sync_failed'").get());
  });
});

describe('administrators and groups', () => {
  it('never creates, disables or merges an administrator', async () => {
    const adminId = db().prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
    db().prepare("UPDATE users SET email = 'chef@firma.de' WHERE id = ?").run(adminId);
    fake.user('chef', { email: 'chef@firma.de' });
    fake.user('a2'); fake.user('a3');
    fake.group('ga', 'Leitung', ['chef', 'a2', 'a3']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'ga', name: 'Leitung' }] });
    await sync().run(d.id);
    const [c] = sync().listConflicts(d.id);
    assert.equal(c.user.id, adminId);
    assert.equal(c.canMerge, false);
    assert.throws(() => sync().resolveConflict(d.id, c.id, 'merge'), (e) => e.code === 'ADMIN_NOT_MERGEABLE');
    // every account the sync created is a member account
    assert.equal(db().prepare("SELECT COUNT(*) AS c FROM users u JOIN directory_links l ON l.user_id = u.id WHERE l.directory_id = ? AND u.role <> 'user'").get(d.id).c, 0);
    // a linked account promoted to admin later is never disabled by the directory
    const a2 = userIdOfExt(d.id, 'a2');
    db().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(a2);
    fake.state.users.get('a2').enabled = false;
    const run = await sync().run(d.id);
    assert.equal(run.summary.disabled, 0);
    assert.equal(db().prepare('SELECT enabled FROM users WHERE id = ?').get(a2).enabled, 1);
    assert.equal(sync().getRun(d.id, run.id).details.adminsKept.length, 1);
    assert.equal(require('../src/services/users').setDirectoryEnabled(a2, false), false);
  });

  it('archives a deselected group, restores it when selected again; name clashes get a suffix', async () => {
    groups().create({ kind: 'team', name: 'Support' });
    fake.user('s1');
    fake.group('gs', 'Support', ['s1']);
    fake.group('gt', 'Technik', ['s1']);
    const d = newDirectory({ name: 'Firmen-AD', selectedGroups: [{ externalId: 'gs', name: 'Support' }, { externalId: 'gt', name: 'Technik' }] });
    await sync().run(d.id);
    const gs = db().prepare('SELECT * FROM groups WHERE source = ? AND external_id = ?').get(`directory:${d.id}`, 'gs');
    assert.equal(gs.name, 'Support (Firmen-AD)');
    store().update(d.id, { selectedGroups: [{ externalId: 'gt', name: 'Technik' }] });
    await sync().run(d.id);
    assert.ok(db().prepare('SELECT archived_at FROM groups WHERE id = ?').get(gs.id).archived_at);
    store().update(d.id, { selectedGroups: [{ externalId: 'gs', name: 'Support' }, { externalId: 'gt', name: 'Technik' }] });
    await sync().run(d.id);
    assert.equal(db().prepare('SELECT archived_at FROM groups WHERE id = ?').get(gs.id).archived_at, null);
    // renamed in the directory → renamed here
    fake.state.groups.get('gt').name = 'Technik & IT';
    await sync().run(d.id);
    assert.equal(db().prepare('SELECT name FROM groups WHERE source = ? AND external_id = ?').get(`directory:${d.id}`, 'gt').name, 'Technik & IT');
    // an extra local member is never removed by the directory
    const local = Number(db().prepare("INSERT INTO users (username, password_hash, role) VALUES ('steuerbuero', '!', 'user')").run().lastInsertRowid);
    groups().setMember(gs.id, local, 'member');
    await sync().run(d.id);
    assert.ok(groups().isMember(local, gs.id));
  });

  it('deleting the directory archives its groups as local groups and keeps the accounts', async () => {
    fake.user('x1');
    fake.group('gx', 'Projekt X', ['x1']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gx', name: 'Projekt X' }] });
    await sync().run(d.id);
    const uid = userIdOfExt(d.id, 'x1');
    assert.throws(() => store().remove(d.id, { confirmName: 'nope' }), (e) => e.code === 'CONFIRM_MISMATCH');
    store().remove(d.id, { confirmName: d.name });
    assert.ok(db().prepare('SELECT id FROM users WHERE id = ?').get(uid));
    assert.equal(linkOf(uid), undefined);
    const g = db().prepare("SELECT * FROM groups WHERE name = 'Projekt X'").get();
    assert.equal(g.source, 'local');
    assert.ok(g.archived_at);
  });
});

describe('secrets and validation', () => {
  it('stores the secret encrypted and never returns it', () => {
    const d = newDirectory();
    const row = db().prepare('SELECT secret_enc, config_json FROM directories WHERE id = ?').get(d.id);
    assert.ok(row.secret_enc && !row.secret_enc.includes('Svc!Pass123'));
    assert.ok(!row.config_json.includes('Svc!Pass123'));
    assert.equal(require('../src/utils/crypto').decrypt(row.secret_enc), 'Svc!Pass123');
    assert.equal(d.secret, store().MASK);
    assert.equal(JSON.stringify(store().get(d.id)).includes('Svc!Pass123'), false);
    // the mask / an empty value keeps the secret
    store().update(d.id, { secret: store().MASK, name: 'Renamed' });
    store().update(d.id, { secret: '' });
    assert.equal(store().secretOf(store().load(d.id)), 'Svc!Pass123');
  });

  it('refuses unencrypted or broken settings', () => {
    const base = { kind: 'ad', name: 'x', secret: 's', config: { host: 'dc', baseDn: 'DC=x', bindDn: 'CN=y' } };
    assert.throws(() => store().create({ ...base, config: { ...base.config, security: 'plain' } }), (e) => e.code === 'INVALID_SECURITY');
    assert.throws(() => store().create({ ...base, config: { ...base.config, host: 'bad host!' } }), (e) => e.code === 'INVALID_HOST');
    assert.throws(() => store().create({ ...base, config: { ...base.config, host: '169.254.169.254' } }), (e) => e.code === 'INVALID_HOST');
    assert.throws(() => store().create({ ...base, config: { ...base.config, caCert: 'not a cert' } }), (e) => e.code === 'INVALID_CA');
    assert.throws(() => store().create({ ...base, intervalMin: 2 }), (e) => e.code === 'INVALID_INTERVAL');
    assert.throws(() => store().create({ ...base, secret: '' }), (e) => e.code === 'INVALID_SECRET');
    assert.throws(() => store().create({ kind: 'entra', name: 'e', secret: 's', config: { tenantId: 'firma.onmicrosoft.com', clientId: crypto.randomUUID() } }), (e) => e.code === 'INVALID_TENANT');
    assert.throws(() => store().create({ kind: 'ldap', name: 'l', secret: 's', config: { ...base.config, userFilter: 'uid=*' } }), (e) => e.code === 'INVALID_FILTER');
    assert.throws(() => store().create({ kind: 'ldap', name: 'l', secret: 's', config: { ...base.config, attrs: { id: 'bad attr' } } }), (e) => e.code === 'INVALID_ATTRIBUTE');
    const ok = store().create({ kind: 'ldap', name: 'Synology', secret: 's', config: { ...base.config, security: 'starttls', attrs: { member: 'memberUid' } } });
    assert.equal(ok.config.port, 389);
    assert.equal(ok.config.attrs.member, 'memberUid');
    assert.equal(ok.config.attrs.id, 'entryUUID');
  });
});

describe('scheduler', () => {
  it('runs a directory when its interval has passed', async () => {
    fake.user('t1');
    fake.group('gtt', 'Team T', ['t1']);
    const d = newDirectory({ intervalMin: 15, selectedGroups: [{ externalId: 'gtt', name: 'Team T' }] });
    // other test directories have no pending run issue; only count this one
    const before = fake.state.fetches;
    await sync().runDue(Date.now());
    assert.ok(fake.state.fetches > before, 'a new directory is synced at once');
    assert.ok(userIdOfExt(d.id, 't1'));
    const mid = fake.state.fetches;
    await sync().runDue(Date.now() + 5 * 60000);
    const after5 = fake.state.fetches;
    await sync().runDue(Date.now() + 16 * 60000);
    assert.ok(fake.state.fetches > after5);
    assert.ok(after5 >= mid);
  });
});
