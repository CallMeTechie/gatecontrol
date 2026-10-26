'use strict';

// Incremental directory sync (services/directory/sync.js "Delta", migration
// 112): the engine with a fake delta adapter (full first, then only the
// changes, fallbacks to a full read, the guard and immediate disabling in a
// delta run, delta + full reach the same end state) and the three adapters
// against fakes — Microsoft Graph delta queries (deltaLinks, paging,
// @removed, members@delta, nested groups, 410), Active Directory uSNChanged
// (RootDSE, another DC → full, disabled account, guard) and LDAP
// modifyTimestamp (watermark, changed / nested groups, no support).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, teardown } = require('./helpers/setup');

before(async () => { await setup(); });
after(() => {
  require('../src/services/directory/adapters')._setFactory(null);
  require('../src/services/directory/ldapConn')._setClientFactory(null);
  require('../src/services/directory/entra')._setFetch(null);
  teardown();
});

function db() { return require('../src/db/connection').getDb(); }
const store = () => require('../src/services/directory/store');
const sync = () => require('../src/services/directory/sync');
const adapters = () => require('../src/services/directory/adapters');
const groups = () => require('../src/services/groups');
const lu = () => require('../src/services/directory/ldapUtil');

function userIdOfExt(dirId, ext) {
  const r = db().prepare('SELECT user_id FROM directory_links WHERE directory_id = ? AND external_id = ?').get(dirId, ext);
  return r ? r.user_id : null;
}
function stateRow(dirId) { return db().prepare('SELECT * FROM directory_sync_state WHERE directory_id = ?').get(dirId); }

/** What the database says about a directory: accounts, names, mails, group members. */
function endState(dirId) {
  const accounts = db().prepare(`SELECT l.external_id, u.enabled, u.display_name, u.email, l.state FROM directory_links l
    JOIN users u ON u.id = l.user_id WHERE l.directory_id = ? ORDER BY l.external_id`).all(dirId);
  const members = db().prepare(`SELECT g.external_id AS g, g.name, g.archived_at IS NOT NULL AS archived, l.external_id AS u
    FROM groups g LEFT JOIN group_members m ON m.group_id = g.id LEFT JOIN directory_links l ON l.user_id = m.user_id
    WHERE g.source = ? ORDER BY g.external_id, l.external_id`).all(`directory:${dirId}`);
  return { accounts, members };
}

function sortData(data) {
  return {
    groups: data.groups.map((g) => ({ externalId: String(g.externalId).toLowerCase(), name: g.name, found: g.found, members: [...g.members].sort() }))
      .sort((a, b) => a.externalId.localeCompare(b.externalId)),
    users: data.users.map((p) => ({
      externalId: p.externalId, loginName: p.loginName || null, upn: p.upn || null, email: p.email || null,
      displayName: p.displayName || null, enabled: p.enabled !== false,
    })).sort((a, b) => a.externalId.localeCompare(b.externalId)),
  };
}

// ─── engine ─────────────────────────────────────────────────────────────────

/** A fake directory with a change log: every change bumps a version. */
function makeDeltaFake() {
  const state = { users: new Map(), groups: new Map(), removed: [], version: 0, fail: false, resync: false, noCursor: false, fetches: 0, deltas: 0 };
  const bump = () => ++state.version;
  const strip = (u) => { const { _v, ...p } = u; return p; };
  const adapter = {
    kind: 'fake',
    async test() { return { ok: true, details: {} }; },
    async searchGroups() { return []; },
    async fetch(selected, opts) {
      state.fetches++;
      if (state.fail) throw new Error('connect ECONNREFUSED');
      const users = new Map();
      const out = (selected || []).map((s) => {
        const g = state.groups.get(s.externalId);
        if (!g) return { externalId: s.externalId, name: s.name, found: false, members: [] };
        for (const m of g.members) if (state.users.has(m)) users.set(m, strip(state.users.get(m)));
        return { externalId: s.externalId, name: g.name, found: true, members: [...g.members].filter((m) => state.users.has(m)) };
      });
      const data = { groups: out, users: [...users.values()] };
      if (opts && opts.cursor) data.cursor = state.noCursor ? null : { v: state.version };
      return data;
    },
    async fetchDelta(selected, { cursor }) {
      state.deltas++;
      if (state.fail) throw new Error('connect ECONNREFUSED');
      if (state.resync) throw lu().fullSyncRequired('resync');
      const since = cursor.v;
      const groupsOut = [];
      for (const s of selected || []) {
        const g = state.groups.get(s.externalId);
        if (!g) { groupsOut.push({ externalId: s.externalId, found: false }); continue; }
        if (g._v > since) groupsOut.push({ externalId: s.externalId, name: g.name, found: true, members: [...g.members].filter((m) => state.users.has(m)) });
      }
      return {
        groups: groupsOut,
        users: [...state.users.values()].filter((u) => u._v > since).map(strip),
        removedUsers: state.removed.filter((r) => r.v > since).map((r) => r.id),
        cursor: { v: state.version },
      };
    },
    async authenticate() { return { ok: false, reason: 'invalid' }; },
  };
  return {
    state,
    adapter,
    user(id, extra) {
      state.users.set(id, { externalId: id, loginName: id, upn: `${id}@corp.local`, dn: `CN=${id},OU=Staff`, email: `${id}@delta.de`, displayName: id.toUpperCase(), enabled: true, ...(extra || {}), _v: bump() });
    },
    change(id, fields) { Object.assign(state.users.get(id), fields, { _v: bump() }); },
    remove(id) {
      state.users.delete(id);
      for (const g of state.groups.values()) if (g.members.delete(id)) g._v = bump();
      state.removed.push({ id, v: bump() });
    },
    group(id, name, members) { state.groups.set(id, { name, members: new Set(members), _v: bump() }); },
    add(gid, uid) { const g = state.groups.get(gid); g.members.add(uid); g._v = bump(); },
    drop(gid, uid) { const g = state.groups.get(gid); g.members.delete(uid); g._v = bump(); },
    rename(gid, name) { const g = state.groups.get(gid); g.name = name; g._v = bump(); },
  };
}

let fake;
let seq = 0;
function newDirectory(extra) {
  seq++;
  return store().create({
    kind: 'ad', name: `Delta ${seq}`, secret: 'Svc!Pass123',
    config: { host: 'dc01.corp.local', security: 'ldaps', baseDn: 'DC=corp,DC=local', bindDn: 'CN=svc,DC=corp,DC=local' },
    ...(extra || {}),
  }, { actor: 1 });
}

describe('engine: full and delta runs', () => {
  beforeEach(() => {
    fake = makeDeltaFake();
    adapters()._setFactory(() => fake.adapter);
  });

  it('reads everything first, then only the changes; "Vollständig abgleichen" reads everything again', async () => {
    fake.user('a1'); fake.user('a2');
    fake.group('ga', 'Team A', ['a1', 'a2']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'ga', name: 'Team A' }] });
    assert.equal(store().get(d.id).deltaReady, false);
    const first = await sync().run(d.id);
    assert.equal(first.status, 'ok', JSON.stringify(first));
    assert.equal(first.mode, 'full');
    assert.equal(first.summary.fullReason, 'first');
    assert.equal(first.summary.created, 2);
    assert.ok(stateRow(d.id), 'the delta position is stored');

    fake.change('a1', { displayName: 'Anna Delta' });
    const second = await sync().run(d.id, { trigger: 'schedule' });
    assert.equal(second.mode, 'delta');
    assert.equal(second.summary.changes.users, 1);
    assert.equal(fake.state.fetches, 1, 'no full read');
    assert.equal(fake.state.deltas, 1);
    assert.equal(db().prepare('SELECT display_name FROM users WHERE id = ?').get(userIdOfExt(d.id, 'a1')).display_name, 'Anna Delta');

    const shape = store().get(d.id);
    assert.equal(shape.lastRunMode, 'delta');
    assert.equal(shape.deltaReady, true);
    assert.equal(shape.fullSyncHours, 24);
    assert.equal(Date.parse(shape.nextFullSyncAt) - Date.parse(shape.lastFullSyncAt), 24 * 3600000);
    assert.equal(sync().listRuns(d.id)[0].mode, 'delta');

    const forced = await sync().run(d.id, { full: true });
    assert.equal(forced.mode, 'full');
    assert.equal(forced.summary.fullReason, 'forced');
    assert.equal(fake.state.fetches, 2);
  });

  it('delta and full reach the same end state (new, changed, disabled, removed, deleted people, renamed group)', async () => {
    for (const u of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12']) fake.user(u);
    // enough people that 3 disabled stay below the guard's 10 %
    const crowd = Array.from({ length: 30 }, (_, i) => `sc${i}`);
    crowd.forEach((u) => fake.user(u));
    fake.group('gs1', 'Service', ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', ...crowd]);
    fake.group('gs2', 'Technik', ['s7', 's8', 's9', 's10', 's11', 's12']);
    const selectedGroups = [{ externalId: 'gs1', name: 'Service' }, { externalId: 'gs2', name: 'Technik' }];
    const d = newDirectory({ selectedGroups });
    await sync().run(d.id);
    const snapshot = JSON.parse(stateRow(d.id).snapshot_json);
    const cursor = JSON.parse(stateRow(d.id).cursor_json);

    fake.user('s13');
    fake.add('gs1', 's13'); // new person
    fake.change('s2', { displayName: 'Sabine Neu', email: 's2.neu@delta.de' }); // changed
    fake.change('s3', { enabled: false }); // disabled in the directory
    fake.drop('gs1', 's4'); // only in gs1 → removed from every group
    fake.drop('gs2', 's8'); // still in gs1
    fake.remove('s9'); // deleted
    fake.rename('gs2', 'Technik & IT');

    // pure: the snapshot plus the changes is exactly what a full read returns
    const delta = await fake.adapter.fetchDelta(selectedGroups, { cursor, snapshot });
    const merged = sync().mergeDelta(snapshot, delta, selectedGroups);
    assert.deepEqual(sortData(merged), sortData(await fake.adapter.fetch(selectedGroups)));

    const run = await sync().run(d.id);
    assert.equal(run.status, 'ok', JSON.stringify(run));
    assert.equal(run.mode, 'delta');
    assert.equal(run.summary.created, 1);
    assert.equal(run.summary.disabled, 3, 's3 deactivated, s4 removed, s9 deleted');
    const details = sync().getRun(d.id, run.id).details;
    assert.deepEqual(details.disabled.map((x) => x.why).sort(), ['deactivated', 'removed', 'removed']);
    const afterDelta = endState(d.id);

    // a full read afterwards finds nothing left to do
    const full = await sync().run(d.id, { full: true });
    assert.equal(full.mode, 'full');
    for (const k of ['created', 'disabled', 'enabled', 'updated', 'groupChanges', 'conflicts', 'groupsCreated', 'groupsArchived']) {
      assert.equal(full.summary[k], 0, `${k} after the delta run`);
    }
    assert.deepEqual(endState(d.id), afterDelta);
    assert.equal(db().prepare('SELECT name FROM groups WHERE source = ? AND external_id = ?').get(`directory:${d.id}`, 'gs2').name, 'Technik & IT');
  });

  it('a delta run disables at once (sessions, tokens, VPN peers) and the guard counts against all linked accounts', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `q${i}`);
    ids.forEach((u) => fake.user(u));
    fake.group('gq', 'Team Q', ids);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gq', name: 'Team Q' }] });
    await sync().run(d.id);
    const uid = userIdOfExt(d.id, 'q0');
    const peer = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES ('q0-laptop', ?, '10.8.0.91/32', 1, 'regular', ?)").run(crypto.randomBytes(8).toString('hex'), uid).lastInsertRowid);
    db().prepare("INSERT INTO api_tokens (name, token_hash, scopes, user_id) VALUES ('q0-app', ?, '[\"client\"]', ?)").run(crypto.randomBytes(16).toString('hex'), uid);
    db().prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)').run('sid-q0', JSON.stringify({ userId: uid, cookie: {} }), Date.now() + 3600000);

    fake.change('q0', { enabled: false });
    const run = await sync().run(d.id);
    assert.equal(run.mode, 'delta');
    assert.equal(run.summary.disabled, 1);
    assert.equal(db().prepare('SELECT enabled, disabled_reason FROM users WHERE id = ?').get(uid).disabled_reason, 'directory');
    assert.equal(db().prepare("SELECT COUNT(*) AS c FROM sessions WHERE sid = 'sid-q0'").get().c, 0);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?').get(uid).c, 0);
    assert.equal(db().prepare('SELECT enabled FROM peers WHERE id = ?').get(peer).enabled, 0);
    assert.deepEqual(JSON.parse(db().prepare('SELECT disabled_peer_ids FROM directory_links WHERE user_id = ?').get(uid).disabled_peer_ids), [peer]);

    // 3 of 12 at once in a delta run → stops; the position stays where it was
    const cursorBefore = stateRow(d.id).cursor_json;
    for (const u of ['q1', 'q2', 'q3']) fake.change(u, { enabled: false });
    const stopped = await sync().run(d.id);
    assert.equal(stopped.status, 'pending');
    assert.equal(stopped.mode, 'delta');
    assert.equal(stopped.guardReason, 'mass_disable');
    assert.equal(stopped.summary.linked, 12);
    assert.equal(stateRow(d.id).cursor_json, cursorBefore);
    assert.equal(db().prepare('SELECT enabled FROM users WHERE id = ?').get(userIdOfExt(d.id, 'q1')).enabled, 1);
    const done = await sync().confirm(d.id, stopped.id, { actor: 1 });
    assert.equal(done.status, 'ok');
    assert.equal(done.mode, 'delta');
    assert.equal(done.summary.disabled, 3);

    // an administrator stays untouched in a delta run too
    const q4 = userIdOfExt(d.id, 'q4');
    db().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(q4);
    fake.change('q4', { enabled: false });
    const admin = await sync().run(d.id);
    assert.equal(admin.mode, 'delta');
    assert.equal(admin.summary.disabled, 0);
    assert.equal(db().prepare('SELECT enabled FROM users WHERE id = ?').get(q4).enabled, 1);
    assert.equal(sync().getRun(d.id, admin.id).details.adminsKept.length, 1);
  });

  it('falls back to a full read: resync, changed settings or groups, full sync due; a failure keeps the position', async () => {
    fake.user('f1'); fake.user('f2');
    fake.group('gf', 'Team F', ['f1']);
    fake.group('gf2', 'Team F2', ['f2']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gf', name: 'Team F' }] });
    await sync().run(d.id);

    fake.state.resync = true;
    const resync = await sync().run(d.id);
    assert.equal(resync.status, 'ok');
    assert.equal(resync.mode, 'full');
    assert.equal(resync.summary.fullReason, 'resync');
    fake.state.resync = false;

    store().update(d.id, { selectedGroups: [{ externalId: 'gf', name: 'Team F' }, { externalId: 'gf2', name: 'Team F2' }] });
    assert.equal(store().get(d.id).deltaReady, false, 'the state belongs to the old selection');
    const changed = await sync().run(d.id);
    assert.equal(changed.mode, 'full');
    assert.equal(changed.summary.fullReason, 'settings_changed');
    assert.ok(userIdOfExt(d.id, 'f2'));

    assert.equal((await sync().run(d.id)).mode, 'delta');
    store().update(d.id, { fullSyncHours: 6 });
    db().prepare('UPDATE directories SET last_full_sync_at = ? WHERE id = ?').run(new Date(Date.now() - 7 * 3600000).toISOString(), d.id);
    const due = await sync().run(d.id);
    assert.equal(due.mode, 'full');
    assert.equal(due.summary.fullReason, 'due');
    assert.ok(Date.now() - Date.parse(store().get(d.id).lastFullSyncAt) < 60000);
    assert.throws(() => store().update(d.id, { fullSyncHours: 0 }), (e) => e.code === 'INVALID_FULL_INTERVAL');
    assert.throws(() => store().update(d.id, { fullSyncHours: 169 }), (e) => e.code === 'INVALID_FULL_INTERVAL');

    const before = stateRow(d.id);
    fake.change('f1', { displayName: 'egal' });
    fake.state.fail = true;
    const failed = await sync().run(d.id);
    assert.equal(failed.status, 'error');
    assert.deepEqual(stateRow(d.id), before);
    fake.state.fail = false;
    const again = await sync().run(d.id);
    assert.equal(again.mode, 'delta');
    assert.equal(again.summary.changes.users, 1, 'the change is seen after the failure');
  });

  it('a directory without a delta position syncs fully every time', async () => {
    fake.state.noCursor = true;
    fake.user('n1');
    fake.group('gn', 'Team N', ['n1']);
    const d = newDirectory({ selectedGroups: [{ externalId: 'gn', name: 'Team N' }] });
    await sync().run(d.id);
    const second = await sync().run(d.id);
    assert.equal(second.mode, 'full');
    assert.equal(second.summary.fullReason, 'unsupported');
    const shape = store().get(d.id);
    assert.equal(shape.deltaUnsupported, true);
    assert.equal(shape.nextFullSyncAt, null);
  });
});

describe('migration 112 (directory_delta_sync)', () => {
  it('follows 111, declares detect; the test database has the columns and the table', () => {
    const list = require('../src/db/migrationList').migrations;
    const m = list.find((x) => x.version === 112);
    assert.ok(m);
    assert.equal(list.indexOf(m), list.findIndex((x) => x.version === 111) + 1);
    assert.equal(m.detect(db()), true);
    const cols = db().prepare('PRAGMA table_info(directory_sync_state)').all().map((c) => c.name);
    assert.deepEqual(cols, ['directory_id', 'fingerprint', 'cursor_json', 'snapshot_json', 'updated_at']);
    assert.equal(db().prepare("SELECT dflt_value FROM pragma_table_info('directories') WHERE name = 'full_sync_hours'").get().dflt_value, '24');
    assert.equal(db().prepare("SELECT dflt_value FROM pragma_table_info('directory_runs') WHERE name = 'mode'").get().dflt_value, "'full'");
  });
});

describe('mergeDelta', () => {
  it('takes over only the fields a partial profile carries and drops people in no group', () => {
    const snap = {
      groups: [{ externalId: 'g', name: 'G', dn: null, found: true, members: ['a', 'b'] }],
      users: [{ externalId: 'a', loginName: 'a', upn: 'a@x', dn: null, email: 'a@x', displayName: 'A', enabled: true },
        { externalId: 'b', loginName: 'b', upn: 'b@x', dn: null, email: 'b@x', displayName: 'B', enabled: true }],
    };
    const out = sync().mergeDelta(snap, {
      users: [{ externalId: 'a', displayName: 'Anna' }, { externalId: 'c', loginName: 'c', email: 'c@x', displayName: 'C', enabled: true }],
      groups: [{ externalId: 'G', add: ['c'], remove: ['b'] }],
    }, [{ externalId: 'g', name: 'G' }]);
    assert.deepEqual(out.groups[0].members, ['a', 'c']);
    const a = out.users.find((p) => p.externalId === 'a');
    assert.deepEqual([a.displayName, a.email, a.enabled], ['Anna', 'a@x', true]);
    assert.equal(out.users.some((p) => p.externalId === 'b'), false);
    const gone = sync().mergeDelta(snap, { groups: [{ externalId: 'g', found: false }] }, [{ externalId: 'g', name: 'G (Auswahl)' }]);
    assert.deepEqual([gone.groups[0].found, gone.groups[0].members, gone.groups[0].name, gone.users.length], [false, [], 'G (Auswahl)', 0]);
  });
});

// ─── Microsoft Entra ID (Graph delta queries) ──────────────────────────────

describe('Entra adapter: Graph delta queries', () => {
  const entra = require('../src/services/directory/entra');
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const CLIENT = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const gid = (n) => `aaaaaaaa-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const uid = (n) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  let G;
  let seen;

  function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  function transitive(id, out = { users: new Set(), groups: new Set() }) {
    for (const m of G.groups.get(id).members) {
      if (G.groups.has(m)) { if (!out.groups.has(m)) { out.groups.add(m); transitive(m, out); } } else if (G.users.has(m)) out.users.add(m);
    }
    return out;
  }
  const userJson = (u) => ({ '@odata.type': '#microsoft.graph.user', ...u });
  /** A delta round from position n of a log, two entries per page. */
  function deltaPage(kind, url) {
    const log = kind === 'users' ? G.userLog : G.groupLog;
    if (G.gone) return json({ error: { code: 'syncStateNotFound' } }, 410);
    if (url.includes('$deltatoken=latest')) return json({ value: [], '@odata.deltaLink': `${GRAPH}/${kind}/delta?$deltatoken=T${log.length}` });
    const m = /\$(deltatoken|skiptoken)=T(\d+)/.exec(url);
    const from = Number(m[2]);
    const page = log.slice(from, from + 2);
    if (from + 2 < log.length) return json({ value: page, '@odata.nextLink': `${GRAPH}/${kind}/delta?$skiptoken=T${from + 2}` });
    return json({ value: page, '@odata.deltaLink': `${GRAPH}/${kind}/delta?$deltatoken=T${log.length}` });
  }

  beforeEach(() => {
    seen = [];
    G = { users: new Map(), groups: new Map(), userLog: [], groupLog: [], gone: false };
    for (let i = 1; i <= 6; i++) G.users.set(uid(i), { id: uid(i), displayName: `U${i}`, mail: `u${i}@firma.de`, userPrincipalName: `u${i}@firma.onmicrosoft.com`, accountEnabled: true });
    G.groups.set(gid(1), { id: gid(1), displayName: 'Vertrieb', members: new Set([uid(1), gid(2)]) });
    G.groups.set(gid(2), { id: gid(2), displayName: 'Vertrieb Nord', members: new Set([uid(2)]) });
    G.groups.set(gid(3), { id: gid(3), displayName: 'Technik', members: new Set([uid(3), uid(5)]) });
    entra._tokenCache.clear();
    entra._setFetch(async (url, init = {}) => {
      const s = String(url);
      seen.push(s);
      if (s.endsWith('/oauth2/v2.0/token')) return json({ access_token: 'tok', expires_in: 3600 });
      if (s.startsWith(`${GRAPH}/users/delta`)) return deltaPage('users', s);
      if (s.startsWith(`${GRAPH}/groups/delta`)) return deltaPage('groups', s);
      let m = /^https:\/\/graph\.microsoft\.com\/v1\.0\/groups\/([0-9a-f-]{36})\?\$select=id,displayName$/.exec(s);
      if (m) return G.groups.has(m[1]) ? json({ id: m[1], displayName: G.groups.get(m[1]).displayName }) : json({ error: { code: 'Request_ResourceNotFound' } }, 404);
      m = /groups\/([0-9a-f-]{36})\/transitiveMembers\/microsoft\.graph\.(user|group)\?/.exec(s);
      if (m) {
        if (!G.groups.has(m[1])) return json({ error: { code: 'Request_ResourceNotFound' } }, 404);
        const t = transitive(m[1]);
        return json({ value: m[2] === 'user' ? [...t.users].map((id) => userJson(G.users.get(id))) : [...t.groups].map((id) => ({ '@odata.type': '#microsoft.graph.group', id })) });
      }
      m = /users\/([0-9a-f-]{36})\?\$select=/.exec(s);
      if (m) return G.users.has(m[1]) ? json(userJson(G.users.get(m[1]))) : json({ error: { code: 'Request_ResourceNotFound' } }, 404);
      return json({ error: { code: 'unexpected' } }, 500);
    });
  });

  const adapter = () => entra.create({ kind: 'entra', config: { tenantId: TENANT, clientId: CLIENT } }, { secret: 'sec' });
  const SEL = [{ externalId: gid(1), name: 'Vertrieb' }, { externalId: gid(3), name: 'Technik' }];

  it('takes the deltaLinks without enumerating ($deltatoken=latest) and remembers nested groups', async () => {
    const data = await adapter().fetch(SEL, { cursor: true });
    assert.deepEqual(data.groups[0].members.sort(), [uid(1), uid(2)].sort());
    assert.ok(seen.some((u) => u.startsWith(`${GRAPH}/users/delta?$select=`) && u.endsWith('$deltatoken=latest')));
    assert.ok(seen.some((u) => u.startsWith(`${GRAPH}/groups/delta?$select=displayName,members`) && u.endsWith('$deltatoken=latest')));
    assert.equal(data.cursor.users, `${GRAPH}/users/delta?$deltatoken=T0`);
    assert.deepEqual(data.cursor.nested, { [gid(1)]: [gid(2)], [gid(3)]: [] });
    // without the cursor option: no delta requests (and no cursor)
    seen = [];
    const plain = await adapter().fetch(SEL);
    assert.equal(plain.cursor, undefined);
    assert.equal(seen.some((u) => u.includes('/delta')), false);
  });

  it('applies partial users, @removed, members@delta and nested changes with paging — same result as a full read', async () => {
    const a = adapter();
    const first = await a.fetch(SEL, { cursor: true });
    const snapshot = sync().snapshotOf(first);
    // users: a partial change (only the name), a disabled account, a deleted one, a stranger
    G.users.get(uid(1)).displayName = 'Ana Neu';
    G.userLog.push({ id: uid(1), displayName: 'Ana Neu' });
    G.users.get(uid(3)).accountEnabled = false;
    G.userLog.push({ id: uid(3), accountEnabled: false });
    G.users.delete(uid(5));
    G.groups.get(gid(3)).members.delete(uid(5));
    G.userLog.push({ id: uid(5), '@removed': { reason: 'changed' } });
    G.userLog.push({ id: 'cccccccc-0000-4000-8000-000000000001', displayName: 'Fremd' });
    // flat selected group: one added (unknown → read once), one removed
    G.groups.get(gid(3)).members.add(uid(4));
    G.groupLog.push({ id: gid(3), 'members@delta': [{ '@odata.type': '#microsoft.graph.user', id: uid(4) }, { '@odata.type': '#microsoft.graph.user', id: uid(5), '@removed': { reason: 'deleted' } }] });
    // nested group of Vertrieb changes → Vertrieb is read again
    G.groups.get(gid(2)).members.add(uid(6));
    G.groupLog.push({ id: gid(2), 'members@delta': [{ '@odata.type': '#microsoft.graph.user', id: uid(6) }] });
    G.groupLog.push({ id: 'dddddddd-0000-4000-8000-000000000001', displayName: 'Fremde Gruppe' });

    seen = [];
    const delta = await a.fetchDelta(SEL, { cursor: first.cursor, snapshot });
    assert.ok(seen.some((u) => u.includes('$skiptoken=T2')), 'follows @odata.nextLink');
    assert.deepEqual(delta.removedUsers, [uid(5)]);
    assert.deepEqual(delta.users.find((p) => p.externalId === uid(3)), { externalId: uid(3), enabled: false });
    assert.equal(delta.users.some((p) => p.externalId.startsWith('cccccccc')), false, 'strangers are ignored');
    assert.equal(seen.filter((u) => u.includes(`/users/${uid(4)}?`)).length, 1, 'the new member is read once');
    assert.ok(seen.some((u) => u.includes(`groups/${gid(1)}/transitiveMembers/microsoft.graph.user`)), 'nested change → transitive list again');
    assert.equal(seen.some((u) => u.includes(`groups/${gid(3)}/transitiveMembers`)), false, 'a flat group takes members@delta');
    const t = delta.groups.find((g) => g.externalId === gid(3));
    assert.deepEqual([t.add, t.remove], [[uid(4)], [uid(5)]]);
    assert.equal(delta.cursor.users, `${GRAPH}/users/delta?$deltatoken=T4`);
    assert.equal(delta.cursor.groups, `${GRAPH}/groups/delta?$deltatoken=T3`);

    const merged = sync().mergeDelta(snapshot, delta, SEL);
    assert.deepEqual(sortData(merged), sortData(await adapter().fetch(SEL)));
    assert.equal(merged.users.find((p) => p.externalId === uid(1)).email, 'u1@firma.de', 'a partial object keeps the rest');

    // the next round starts at the new links: nothing new
    const empty = await a.fetchDelta(SEL, { cursor: delta.cursor, snapshot: sync().snapshotOf(merged) });
    assert.deepEqual([empty.users.length, empty.groups.length, empty.removedUsers.length], [0, 0, 0]);
  });

  it('a nested group added, a deleted selected group; 410 Gone → full sync required', async () => {
    const a = adapter();
    const first = await a.fetch(SEL, { cursor: true });
    const snapshot = sync().snapshotOf(first);
    G.groups.set(gid(4), { id: gid(4), displayName: 'Technik Süd', members: new Set([uid(6)]) });
    G.groups.get(gid(3)).members.add(gid(4));
    G.groupLog.push({ id: gid(3), 'members@delta': [{ '@odata.type': '#microsoft.graph.group', id: gid(4) }] });
    G.groups.delete(gid(1));
    G.groupLog.push({ id: gid(1), '@removed': { reason: 'deleted' } });
    const delta = await a.fetchDelta(SEL, { cursor: first.cursor, snapshot });
    assert.deepEqual(delta.groups.find((g) => g.externalId === gid(1)), { externalId: gid(1), found: false });
    const t = delta.groups.find((g) => g.externalId === gid(3));
    assert.deepEqual(t.members.sort(), [uid(3), uid(5), uid(6)].sort(), 'read again with the new nested group');
    assert.deepEqual(delta.cursor.nested[gid(3)], [gid(4)]);
    assert.deepEqual(sortData(sync().mergeDelta(snapshot, delta, SEL)), sortData(await adapter().fetch(SEL)));

    G.gone = true;
    await assert.rejects(a.fetchDelta(SEL, { cursor: delta.cursor, snapshot }), (e) => e.code === 'FULL_SYNC_REQUIRED' && e.reason === 'resync');
  });
});

// ─── Active Directory (uSNChanged) ─────────────────────────────────────────

describe('AD adapter: uSNChanged on the same domain controller', () => {
  const conn = require('../src/services/directory/ldapConn');
  const BASE = 'DC=corp,DC=local';
  const STAFF = 'OU=Staff,DC=corp,DC=local';
  const IN_CHAIN = /\(memberOf:1\.2\.840\.113556\.1\.4\.1941:=([^)]*)\)/;
  // every test gets its own people (one directory per account)
  let R = 0;
  const guid = (p, n) => `${p}${String(R).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let AD;
  let filters;

  function touch(o) { AD.usn += 1; o.usn = AD.usn; }
  function userEntry(u) {
    return {
      dn: u.dn, objectGUID: lu().guidToBuffer(u.guid), sAMAccountName: u.sam, userPrincipalName: `${u.sam}@corp.local`, mail: u.mail,
      displayName: u.name, userAccountControl: String(u.uac), uSNChanged: String(u.usn),
    };
  }
  function groupEntry(g) { return { dn: g.dn, objectGUID: lu().guidToBuffer(g.guid), cn: g.cn, uSNChanged: String(g.usn) }; }
  const groupByDn = (dn) => [...AD.groups.values()].find((g) => lu().normDn(g.dn) === lu().normDn(dn));
  function chain(g, out = { users: new Set(), groups: new Set() }) {
    for (const m of g.members) {
      if (AD.groups.has(m)) { if (!out.groups.has(m)) { out.groups.add(m); chain(AD.groups.get(m), out); } } else if (AD.users.has(m)) out.users.add(m);
    }
    return out;
  }
  function client() {
    return {
      async bind() {},
      async unbind() {},
      async search(base, opts) {
        assert.equal(base, '');
        assert.equal(opts.scope, 'base');
        return { searchEntries: [{ dn: '', highestCommittedUSN: String(AD.usn), dnsHostName: AD.dc, dsServiceName: `CN=NTDS Settings,CN=${AD.dc.split('.')[0]}` }] };
      },
      async *searchPaginated(base, opts) {
        const f = opts.filter;
        filters.push(f);
        const min = /\(uSNChanged>=(\d+)\)/.exec(f);
        const usnOk = (o) => !min || o.usn >= Number(min[1]);
        const byGuid = /\(objectGUID=((?:\\[0-9a-f]{2})+)\)/.exec(f);
        if (byGuid) {
          const id = lu().guidToString(Buffer.from(byGuid[1].replace(/\\/g, ''), 'hex'));
          const g = AD.groups.get(id);
          yield { searchEntries: g ? [groupEntry(g)] : [] };
          return;
        }
        const inChain = IN_CHAIN.exec(f);
        const g = inChain && groupByDn(inChain[1]);
        if (f.includes('(objectClass=group)') && g) {
          yield { searchEntries: [...chain(g).groups].map((id) => AD.groups.get(id)).filter(usnOk).map(groupEntry) };
          return;
        }
        if (f.includes('(objectCategory=person)') && g) {
          yield { searchEntries: [...chain(g).users].map((id) => AD.users.get(id)).filter((u) => usnOk(u) && lu().isUnder(u.dn, base)).map(userEntry) };
          return;
        }
        yield { searchEntries: [] };
      },
    };
  }

  beforeEach(() => {
    filters = [];
    R++;
    AD = { usn: 1000, dc: 'dc01.corp.local', users: new Map(), groups: new Map() };
    for (let i = 1; i <= 12; i++) {
      const u = { guid: guid('b', i), sam: `ad${R}-${i}`, dn: `CN=ad${i},${STAFF}`, mail: `ad${R}-${i}@corp.de`, name: `AD ${i}`, uac: 512 };
      touch(u);
      AD.users.set(u.guid, u);
    }
    const nested = { guid: guid('c', 2), cn: 'Vertrieb Nord', dn: `CN=Vertrieb Nord,OU=Gruppen,${BASE}`, members: new Set([guid('b', 11), guid('b', 12)]) };
    const top = { guid: guid('c', 1), cn: 'Vertrieb', dn: `CN=Vertrieb,OU=Gruppen,${BASE}`, members: new Set([...Array.from({ length: 10 }, (_, i) => guid('b', i + 1)), nested.guid]) };
    touch(nested); touch(top);
    AD.groups.set(top.guid, top);
    AD.groups.set(nested.guid, nested);
    conn._setClientFactory(client);
    adapters()._setFactory(null);
  });

  function adDirectory() {
    seq++;
    return store().create({
      kind: 'ad', name: `AD delta ${seq}`, secret: 'Svc!Pass123',
      config: { host: 'corp.local', security: 'ldaps', baseDn: BASE, userBaseDn: STAFF, bindDn: `CN=svc,${BASE}` },
      selectedGroups: [{ externalId: guid('c', 1), name: 'Vertrieb' }],
    }, { actor: 1 });
  }

  it('a full read stores DC and USN; the delta asks only for changed members and disables a deactivated account at once', async () => {
    const d = adDirectory();
    const first = await sync().run(d.id);
    assert.equal(first.status, 'ok', JSON.stringify(first));
    assert.equal(first.summary.created, 12);
    assert.deepEqual(JSON.parse(stateRow(d.id).cursor_json), { dc: 'dc01.corp.local', service: 'CN=NTDS Settings,CN=dc01', usn: '1014' });

    const u1 = AD.users.get(guid('b', 1));
    u1.uac = 514; // ACCOUNTDISABLE
    touch(u1);
    const uid1 = userIdOfExt(d.id, guid('b', 1));
    const peer = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES ('ad1-pc', ?, '10.8.0.95/32', 1, 'regular', ?)").run(crypto.randomBytes(8).toString('hex'), uid1).lastInsertRowid);
    db().prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)').run('sid-ad1', JSON.stringify({ userId: uid1, cookie: {} }), Date.now() + 3600000);
    filters = [];
    const run = await sync().run(d.id);
    assert.equal(run.mode, 'delta', JSON.stringify(run));
    assert.equal(run.summary.disabled, 1);
    assert.ok(filters.some((f) => f.includes('(uSNChanged>=1015)') && f.includes('(objectCategory=person)')), filters.join('\n'));
    assert.equal(filters.some((f) => f.includes('(objectCategory=person)') && !f.includes('uSNChanged')), false, 'no full member list');
    assert.equal(db().prepare('SELECT enabled FROM users WHERE id = ?').get(uid1).enabled, 0);
    assert.equal(db().prepare('SELECT enabled FROM peers WHERE id = ?').get(peer).enabled, 0);
    assert.equal(db().prepare("SELECT COUNT(*) AS c FROM sessions WHERE sid = 'sid-ad1'").get().c, 0);
    assert.equal(JSON.parse(stateRow(d.id).cursor_json).usn, '1015');

    // a member added to the NESTED group: the group changes, not the account
    const n = { guid: guid('b', 13), sam: `ad${R}-13`, dn: `CN=ad13,${STAFF}`, mail: `ad${R}-13@corp.de`, name: 'AD 13', uac: 512 };
    touch(n);
    AD.users.set(n.guid, n);
    const nested = AD.groups.get(guid('c', 2));
    nested.members.add(n.guid);
    touch(nested);
    const added = await sync().run(d.id);
    assert.equal(added.mode, 'delta');
    assert.equal(added.summary.created, 1);
    assert.ok(userIdOfExt(d.id, guid('b', 13)));
  });

  it('the guard stops a delta run; another domain controller answering → full read', async () => {
    const d = adDirectory();
    await sync().run(d.id);
    for (const i of [2, 3, 4]) { const u = AD.users.get(guid('b', i)); u.uac = 514; touch(u); }
    const stopped = await sync().run(d.id);
    assert.equal(stopped.status, 'pending');
    assert.equal(stopped.mode, 'delta');
    assert.equal(stopped.plan.disable.length, 3);
    assert.equal(JSON.parse(stateRow(d.id).cursor_json).usn, '1014', 'position kept while the run waits');
    const done = await sync().confirm(d.id, stopped.id, { actor: 1 });
    assert.equal(done.status, 'ok');
    assert.equal(done.summary.disabled, 3);

    AD.dc = 'dc02.corp.local';
    AD.users.get(guid('b', 5)).name = 'Unbemerkt'; // no uSNChanged on dc02's numbering — only a full read sees it
    const other = await sync().run(d.id);
    assert.equal(other.status, 'ok');
    assert.equal(other.mode, 'full');
    assert.equal(other.summary.fullReason, 'dc_changed');
    assert.equal(db().prepare('SELECT display_name FROM users WHERE id = ?').get(userIdOfExt(d.id, guid('b', 5))).display_name, 'Unbemerkt');
    assert.equal(JSON.parse(stateRow(d.id).cursor_json).dc, 'dc02.corp.local');
  });

  it('delta and full reach the same data (moved out of the account base, renamed group)', async () => {
    const a = require('../src/services/directory/ad').create({ kind: 'ad', config: { host: 'corp.local', security: 'ldaps', baseDn: BASE, userBaseDn: STAFF, bindDn: `CN=svc,${BASE}` } }, { secret: 's' });
    const sel = [{ externalId: guid('c', 1), name: 'Vertrieb' }];
    const first = await a.fetch(sel, { cursor: true });
    const snapshot = sync().snapshotOf(first);
    const moved = AD.users.get(guid('b', 6));
    moved.dn = `CN=ad6,OU=Ehemalige,${BASE}`;
    touch(moved);
    const renamed = AD.users.get(guid('b', 7));
    renamed.mail = 'neu7@corp.de';
    touch(renamed);
    const delta = await a.fetchDelta(sel, { cursor: first.cursor, snapshot });
    assert.deepEqual(delta.groups[0].remove, [guid('b', 6)]);
    assert.deepEqual(sortData(sync().mergeDelta(snapshot, delta, sel)), sortData(await a.fetch(sel)));
    await assert.rejects(a.fetchDelta(sel, { cursor: { ...first.cursor, dc: 'dc09.corp.local' }, snapshot }), (e) => e.code === 'FULL_SYNC_REQUIRED' && e.reason === 'dc_changed');
    await assert.rejects(a.fetchDelta(sel, { cursor: { ...first.cursor, usn: '999999' }, snapshot }), (e) => e.reason === 'usn_rollback');
  });
});

// ─── LDAP (modifyTimestamp) ─────────────────────────────────────────────────

describe('LDAP adapter: modifyTimestamp', () => {
  const conn = require('../src/services/directory/ldapConn');
  const ldap = require('../src/services/directory/ldap');
  let L;
  let calls;
  let NOW = Date.now();
  const ts = (minAgo, plusMs = 0) => ldap.genTime(NOW - minAgo * 60000 + plusMs);
  const PEOPLE = 'ou=people,dc=nas';
  function client() {
    return {
      async startTLS() {},
      async bind() {},
      async unbind() {},
      async *searchPaginated(base, opts) {
        const f = opts.filter;
        calls.push([base, f, opts.scope]);
        const since = /\(modifyTimestamp>=(\d{14}Z)\)/.exec(f);
        if (since && !L.timestamps) throw new Error('unsupported filter');
        const fresh = (e) => !since || ldap.parseGenTime(e.modifyTimestamp) >= ldap.parseGenTime(since[1]);
        const out = (e) => { const c = { ...e }; if (!L.timestamps) delete c.modifyTimestamp; return c; };
        const isUserFilter = f.includes('inetOrgPerson');
        if (opts.scope === 'base') {
          const e = isUserFilter ? L.people.find((p) => p.dn === base) : L.groups.find((g) => g.dn === base);
          yield { searchEntries: e ? [out(e)] : [] };
          return;
        }
        if (isUserFilter) {
          const login = /\(uid=([^)*]+)\)/.exec(f);
          yield { searchEntries: L.people.filter((p) => fresh(p) && (!login || p.uid === login[1])).map(out) };
          return;
        }
        const id = /\(entryUUID=([^)]*)\)/.exec(f);
        yield { searchEntries: L.groups.filter((g) => fresh(g) && (!id || g.entryUUID === id[1])).map(out) };
      },
    };
  }
  beforeEach(() => {
    calls = [];
    NOW = Date.now();
    L = {
      timestamps: true,
      people: ['anna', 'ben', 'carl'].map((n) => ({ dn: `uid=${n},${PEOPLE}`, entryUUID: `u-${n}`, uid: n, mail: `${n}@nas.de`, displayName: n, modifyTimestamp: ts(120) })),
      groups: [
        { dn: 'cn=team,ou=groups,dc=nas', entryUUID: 'g-team', cn: 'team', member: [`uid=anna,${PEOPLE}`, 'cn=sub,ou=groups,dc=nas'], modifyTimestamp: ts(120) },
        { dn: 'cn=sub,ou=groups,dc=nas', entryUUID: 'g-sub', cn: 'sub', member: [`uid=ben,${PEOPLE}`], modifyTimestamp: ts(120) },
      ],
    };
    conn._setClientFactory(client);
  });
  const cfg = { host: 'nas.local', security: 'starttls', baseDn: 'dc=nas', userBaseDn: PEOPLE, groupBaseDn: 'ou=groups,dc=nas', bindDn: 'uid=root,cn=users,dc=nas' };
  const SEL = [{ externalId: 'g-team', name: 'team' }];

  it('stores a watermark and the nested groups; a changed account comes alone, a changed nested group resolves the group again', async () => {
    const a = ldap.create({ kind: 'ldap', config: cfg }, { secret: 's' });
    const first = await a.fetch(SEL, { cursor: true });
    assert.equal(first.cursor.watermark, ts(120));
    assert.deepEqual(first.cursor.nested, { 'g-team': ['cn=sub,ou=groups,dc=nas'] });
    const snapshot = sync().snapshotOf(first);

    const anna = L.people.find((p) => p.uid === 'anna');
    anna.mail = 'anna.neu@nas.de';
    anna.modifyTimestamp = ts(30);
    calls = [];
    const d1 = await a.fetchDelta(SEL, { cursor: first.cursor, snapshot });
    assert.ok(calls.some((c) => c[1].includes(`(modifyTimestamp>=${ts(120, 1000)})`)), 'from the second after the watermark');
    assert.deepEqual(d1.groups, []);
    assert.deepEqual(d1.users.map((p) => [p.externalId, p.email]), [['u-anna', 'anna.neu@nas.de']]);
    assert.equal(d1.cursor.watermark, ts(30));
    const merged1 = sync().mergeDelta(snapshot, d1, SEL);
    assert.deepEqual(sortData(merged1), sortData(await a.fetch(SEL)));

    // carl joins the nested group: only the group changes; carl is looked up on his own
    const sub = L.groups.find((g) => g.entryUUID === 'g-sub');
    sub.member.push(`uid=carl,${PEOPLE}`);
    sub.modifyTimestamp = ts(20);
    calls = [];
    const d2 = await a.fetchDelta(SEL, { cursor: d1.cursor, snapshot: sync().snapshotOf(merged1) });
    assert.deepEqual(d2.groups[0].members.sort(), ['u-anna', 'u-ben', 'u-carl']);
    assert.ok(calls.some((c) => c[0] === `uid=carl,${PEOPLE}` && c[2] === 'base'), 'the new member is read by DN');
    assert.equal(calls.some((c) => c[0] === `uid=anna,${PEOPLE}`), false, 'known members come from the snapshot');
    assert.deepEqual(sortData(sync().mergeDelta(sync().snapshotOf(merged1), d2, SEL)), sortData(await a.fetch(SEL)));
  });

  it('memberUid of an account created later resolves when the account appears', async () => {
    L.groups.push({ dn: 'cn=posix,ou=groups,dc=nas', entryUUID: 'g-posix', cn: 'posix', memberUid: ['anna', 'dora'], modifyTimestamp: ts(120) });
    const a = ldap.create({ kind: 'ldap', config: { ...cfg, attrs: { member: 'memberUid' } } }, { secret: 's' });
    const sel = [{ externalId: 'g-posix', name: 'posix' }];
    const first = await a.fetch(sel, { cursor: true });
    assert.deepEqual(first.cursor.unresolved, { 'g-posix': ['dora'] });
    L.people.push({ dn: `uid=dora,${PEOPLE}`, entryUUID: 'u-dora', uid: 'dora', mail: 'dora@nas.de', displayName: 'Dora', modifyTimestamp: ts(5) });
    const snapshot = sync().snapshotOf(first);
    const delta = await a.fetchDelta(sel, { cursor: first.cursor, snapshot });
    assert.deepEqual(delta.groups[0].members.sort(), ['u-anna', 'u-dora']);
    assert.deepEqual(sortData(sync().mergeDelta(snapshot, delta, sel)), sortData(await a.fetch(sel)));
  });

  it('a server without modifyTimestamp gets no delta position — every run stays full', async () => {
    L.timestamps = false;
    const a = ldap.create({ kind: 'ldap', config: cfg }, { secret: 's' });
    const first = await a.fetch(SEL, { cursor: true });
    assert.equal(first.cursor, null);
    assert.deepEqual(first.groups[0].members.sort(), ['u-anna', 'u-ben']);
    await assert.rejects(a.fetchDelta(SEL, { cursor: null, snapshot: sync().snapshotOf(first) }), (e) => e.code === 'FULL_SYNC_REQUIRED');
    // the engine: reason 'unsupported' from the second run on
    adapters()._setFactory(null);
    seq++;
    const d = store().create({ kind: 'ldap', name: `NAS ${seq}`, secret: 's', config: cfg, selectedGroups: SEL }, { actor: 1 });
    await sync().run(d.id);
    const second = await sync().run(d.id);
    assert.equal(second.status, 'ok', JSON.stringify(second));
    assert.deepEqual([second.mode, second.summary.fullReason], ['full', 'unsupported']);
    assert.equal(store().get(d.id).deltaUnsupported, true);
  });
});
