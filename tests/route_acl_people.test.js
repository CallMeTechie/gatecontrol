'use strict';

// routes.acl_people — "Geräte der Personen und Gruppen durchlassen"
// (docs/groups.md "Zugriff per Gruppe", services/groupAccess.js): whether the
// Caddy peer ACL of an acl_enabled route also passes the devices of its
// persons and group members. Migration 111 keeps existing routes with the
// ACL on and persons at the old behaviour (0); new routes default to 1.
// Covers the migration rule, aclPeers / aclRanges / aclDependsOnPeople, the
// Caddy config, the preview, the routes API and backup / restore.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { setup, teardown } = require('./helpers/setup');

let agent, csrf;
before(async () => {
  ({ agent, csrfToken: csrf } = await setup());
  require('../src/services/caddyConfig').syncToCaddy = async () => true;
  require('../src/services/routes').syncToCaddy = async () => {};
  require('../src/services/peers').rewriteWgConfig = async () => {};
});
after(() => teardown());

function db() { return require('../src/db/connection').getDb(); }
const groups = () => require('../src/services/groups');
const access = () => require('../src/services/groupAccess');
const migration = () => require('../src/db/migrationList').migrations.find((m) => m.version === 111);

let seq = 0;
function user(name) {
  return Number(db().prepare("INSERT INTO users (username, display_name, password_hash, role, enabled) VALUES (?, ?, 'x', 'user', 1)")
    .run(`${name}-${++seq}`, name).lastInsertRowid);
}
function route(domain, { userIds = null, acl = 0, people } = {}) {
  const id = Number(db().prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, user_ids, acl_enabled, external_enabled, https_enabled)
    VALUES (?, '10.0.0.5', 80, 'http', 1, ?, ?, 1, 1)`).run(domain, typeof userIds === 'string' ? userIds : (userIds ? JSON.stringify(userIds) : null), acl).lastInsertRowid);
  if (people !== undefined) db().prepare('UPDATE routes SET acl_people = ? WHERE id = ?').run(people, id);
  return id;
}
function peer(name, ip, userId = null) {
  return Number(db().prepare('INSERT INTO peers (name, public_key, allowed_ips, enabled, user_id) VALUES (?, ?, ?, 1, ?)')
    .run(name, 'pk-' + name + '-' + (++seq), ip + '/32', userId).lastInsertRowid);
}
const row = (id) => db().prepare('SELECT * FROM routes WHERE id = ?').get(id);
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
const build = (...ids) => require('../src/services/caddyConfig').buildCaddyConfig(
  db().prepare(`SELECT * FROM routes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids));

// ─── migration 111 ──────────────────────────────────────────────────────

describe('migration 111 (route_acl_people)', () => {
  const CASES = [
    // [label, acl_enabled, user_ids, expected acl_people]
    ['ACL + persons', 1, '[3,4]', 0],
    ['ACL + person ids as strings', 1, '["7"]', 0],
    ['ACL + NOBODY marker', 1, '[0]', 0],
    ['ACL without persons (NULL)', 1, null, 1],
    ['ACL with empty string', 1, '', 1],
    ['ACL with []', 1, '[]', 1],
    ['ACL with null JSON', 1, 'null', 1],
    ['ACL with malformed JSON', 1, '[1,', 1],
    ['ACL with a non-array', 1, '{"a":1}', 1],
    ['ACL with no usable id', 1, '["x", -1, 1.5]', 1],
    ['no ACL + persons', 0, '[3]', 1],
    ['no ACL, no persons', 0, null, 1],
  ];

  it('is the next version after 110, declares detect and a JS data step', () => {
    const m = migration();
    assert.ok(m, 'migration 111 exists');
    const versions = require('../src/db/migrationList').migrations.map((x) => x.version);
    assert.equal(Math.max(...versions), 111);
    assert.equal(typeof m.detect, 'function');
    assert.equal(typeof m.run, 'function');
    assert.match(m.sql, /ALTER TABLE routes ADD COLUMN acl_people INTEGER NOT NULL DEFAULT 1/);
    assert.equal(m.detect(db()), true, 'migrated test database has the column');
  });

  it('applies the rule on a pre-111 routes table (sql + run)', () => {
    const mem = new Database(':memory:');
    mem.exec('CREATE TABLE routes (id INTEGER PRIMARY KEY, domain TEXT, acl_enabled INTEGER DEFAULT 0, user_ids TEXT)');
    const ins = mem.prepare('INSERT INTO routes (domain, acl_enabled, user_ids) VALUES (?, ?, ?)');
    for (const [label, acl, ids] of CASES) ins.run(label, acl, ids);
    assert.equal(migration().detect(mem), false);
    mem.transaction(() => { mem.exec(migration().sql); migration().run(mem); })();
    for (const [label, , , want] of CASES) {
      assert.equal(mem.prepare('SELECT acl_people FROM routes WHERE domain = ?').get(label).acl_people, want, label);
    }
    // a route created afterwards gets the default 1
    ins.run('later', 1, '[5]');
    assert.equal(mem.prepare("SELECT acl_people FROM routes WHERE domain = 'later'").get().acl_people, 1);
    mem.close();
  });

  it('the migration runner executes the data step in the same run', () => {
    const d = db();
    const ids = CASES.map(([label, acl, userIds]) => route(`mig-${CASES.findIndex((c) => c[0] === label)}.acl.test`, { acl, userIds: userIds === null ? null : userIds }));
    d.prepare('ALTER TABLE routes DROP COLUMN acl_people').run();
    d.prepare('DELETE FROM migration_history WHERE version = 111').run();
    const prev = process.env.GC_SKIP_PRE_MIGRATION_BACKUP;
    process.env.GC_SKIP_PRE_MIGRATION_BACKUP = '1';
    try { require('../src/db/migrations').runMigrations(); } finally {
      if (prev === undefined) delete process.env.GC_SKIP_PRE_MIGRATION_BACKUP; else process.env.GC_SKIP_PRE_MIGRATION_BACKUP = prev;
    }
    assert.ok(d.prepare('SELECT 1 FROM migration_history WHERE version = 111').get(), 'recorded');
    CASES.forEach(([label, , , want], i) => assert.equal(row(ids[i]).acl_people, want, label));
    d.prepare(`DELETE FROM routes WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  });

  it('legacyAclPeople mirrors the rule for backup rows', () => {
    const f = access().legacyAclPeople;
    assert.equal(f({ acl_enabled: 1, user_ids: '[2]' }), 0);
    assert.equal(f({ acl_enabled: true, user_ids: '[2]' }), 0);
    assert.equal(f({ acl_enabled: 1, user_ids: '[' }), 1);
    assert.equal(f({ acl_enabled: 0, user_ids: '[2]' }), 1);
    assert.equal(f({ acl_enabled: 1 }), 1);
    assert.equal(f(null), 1);
  });
});

// ─── groupAccess: aclPeers / aclRanges / aclDependsOnPeople ─────────────

describe('Caddy layer follows acl_people', () => {
  let ida, jon, grp, pListed, pIda, pJon;

  before(() => {
    ida = user('Ida'); jon = user('Jon');
    grp = groups().create({ kind: 'team', name: 'ACL-People' });
    groups().setMember(grp.id, jon);
    pListed = peer('ap-listed', '10.8.1.10');
    pIda = peer('ap-ida', '10.8.1.11', ida);
    pJon = peer('ap-jon', '10.8.1.12', jon);
  });

  it('acl_people 1: listed devices ∪ devices of persons and group members', () => {
    const id = route('on.ap.test', { acl: 1, userIds: [ida], people: 1 });
    require('../src/services/caddyAcl').setAclPeers(id, [pListed]);
    access().setRouteGroups(id, [grp.id]);
    assert.deepEqual(access().aclPeers(row(id)).map((p) => p.peerId).sort((a, b) => a - b), [pListed, pIda, pJon]);
    assert.deepEqual(access().aclRanges(row(id)), { configured: true, ranges: ['10.8.1.10/32', '10.8.1.11/32', '10.8.1.12/32'] });
    assert.deepEqual(rangesOf(build(id), 'on.ap.test'), ['10.8.1.10/32', '10.8.1.11/32', '10.8.1.12/32']);
  });

  it('acl_people 0: only the listed devices (the behaviour before person groups)', () => {
    const id = route('off.ap.test', { acl: 1, userIds: [ida], people: 0 });
    require('../src/services/caddyAcl').setAclPeers(id, [pListed]);
    access().setRouteGroups(id, [grp.id]);
    assert.deepEqual(access().aclPeers(row(id)).map((p) => [p.peerId, p.via]), [[pListed, 'device']]);
    assert.deepEqual(access().aclRanges(row(id)), { configured: true, ranges: ['10.8.1.10/32'] });
    assert.deepEqual(rangesOf(build(id), 'off.ap.test'), ['10.8.1.10/32']);
    // a partial object (no acl_people) reads the stored value
    assert.deepEqual(access().aclPeers({ id, user_ids: JSON.stringify([ida]) }).map((p) => p.peerId), [pListed]);
    assert.equal(access().aclPeopleOn({ id }), false);
    assert.equal(access().aclPeopleOn({ id: 999999 }), true, 'unknown route: default');
  });

  it('fails closed only with acl_people 1; with 0 and no device: no matcher (historic)', () => {
    const empty = groups().create({ kind: 'team', name: 'ACL-People-Leer' });
    const on = route('fc-on.ap.test', { acl: 1, people: 1 });
    access().setRouteGroups(on, [empty.id]);
    const off = route('fc-off.ap.test', { acl: 1, userIds: [ida], people: 0 });
    access().setRouteGroups(off, [empty.id]);
    const cfg = build(on, off);
    assert.deepEqual(rangesOf(cfg, 'fc-on.ap.test'), ['0.0.0.0/32'], 'persons/groups listed, no address → closed');
    assert.deepEqual(rangesOf(cfg, 'fc-off.ap.test'), [], 'acl_people 0 without devices: no peer matcher');
    assert.deepEqual(access().aclRanges(row(off)), { configured: false, ranges: [] });
    assert.deepEqual(access().aclRanges(row(on)), { configured: true, ranges: [] });
  });

  it('visibility by persons and groups is not affected by acl_people', () => {
    const id = route('vis.ap.test', { acl: 1, userIds: [ida], people: 0 });
    access().setRouteGroups(id, [grp.id]);
    const visible = (uid) => require('../src/services/routes').getForUser(uid).some((r) => r.id === id);
    assert.equal(visible(ida), true, 'named person sees it');
    assert.equal(visible(jon), true, 'group member sees it');
    assert.equal(visible(user('Fremd')), false, 'others do not');
  });

  it('aclDependsOnPeople only counts routes with acl_people 1', () => {
    const d = db();
    const saved = d.prepare('SELECT id, acl_enabled, acl_people FROM routes').all();
    try {
      d.prepare('UPDATE routes SET acl_enabled = 0').run();
      const id = route('dep.ap.test', { acl: 1, userIds: [ida], people: 0 });
      assert.equal(access().aclDependsOnPeople(), false, 'acl_people 0 + persons');
      access().setRouteGroups(id, [grp.id]);
      assert.equal(access().aclDependsOnPeople(), false, 'acl_people 0 + groups');
      d.prepare('UPDATE routes SET acl_people = 1 WHERE id = ?').run(id);
      assert.equal(access().aclDependsOnPeople(), true);
      d.prepare('DELETE FROM routes WHERE id = ?').run(id);
    } finally {
      const upd = d.prepare('UPDATE routes SET acl_enabled = ?, acl_people = ? WHERE id = ?');
      for (const r of saved) upd.run(r.acl_enabled, r.acl_people, r.id);
    }
  });

  it('preview: person devices pass only with aclPeople, visibleOnly without', () => {
    const on = access().preview({ userIds: [ida], groupIds: [grp.id], peerIds: [pListed], aclPeople: true });
    assert.equal(on.aclPeople, true);
    assert.deepEqual(on.personDevices.map((d) => d.peerId).sort((a, b) => a - b), [pIda, pJon]);
    assert.equal(on.people.find((p) => p.userId === ida).ownDevices, 1);
    assert.ok(on.people.every((p) => p.visibleOnly === false));
    const off = access().preview({ userIds: [ida], groupIds: [grp.id], peerIds: [pIda], aclPeople: false });
    assert.equal(off.aclPeople, false);
    assert.deepEqual(off.personDevices, []);
    assert.equal(off.people.find((p) => p.userId === ida).visibleOnly, false, 'Ida has a listed device');
    assert.equal(off.people.find((p) => p.userId === jon).visibleOnly, true, 'Jon only sees the route');
    const rdp = access().preview({ userIds: [ida] });
    assert.equal(rdp.aclPeople, null);
    assert.deepEqual(rdp.personDevices, []);
  });
});

// ─── routes API ─────────────────────────────────────────────────────────

describe('routes API: acl_people', () => {
  const api = (method, path) => agent[method](path).set('X-CSRF-Token', csrf);
  before(() => {
    db().prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
  });

  it('create defaults to 1, accepts false; GET returns it', async () => {
    let res = await api('post', '/api/v1/routes').send({ domain: 'ap-new.example.com', target_ip: '93.184.216.34', target_port: 80, acl_enabled: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.route.acl_people, 1);
    res = await api('post', '/api/v1/routes').send({ domain: 'ap-off.example.com', target_ip: '93.184.216.34', target_port: 80, acl_enabled: true, acl_people: false });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const detail = await agent.get('/api/v1/routes/' + res.body.route.id).expect(200);
    assert.equal(detail.body.route.acl_people, 0);
    const list = await agent.get('/api/v1/routes').expect(200);
    const rows = list.body.routes || list.body.data || [];
    const listed = rows.find((r) => r.id === res.body.route.id);
    if (listed) assert.equal(listed.acl_people, 0);
  });

  it('update: set, keep when absent, validate; activity on change', async () => {
    const id = route('ap-put.ga.test', { acl: 1, userIds: [1], people: 0 });
    let res = await api('put', '/api/v1/routes/' + id).send({ description: 'x' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row(id).acl_people, 0, 'absent = keep');
    res = await api('put', '/api/v1/routes/' + id).send({ acl_people: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.route.acl_people, 1);
    const evt = db().prepare("SELECT details FROM activity_log WHERE event_type = 'route_acl_people_changed' ORDER BY id DESC LIMIT 1").get();
    assert.ok(evt, 'activity logged');
    const det = JSON.parse(evt.details);
    assert.equal(Number(det.routeId), id);
    assert.deepEqual({ ...det, routeId: undefined }, { routeId: undefined, acl_enabled: true, old_acl_people: false, new_acl_people: true });
    res = await api('put', '/api/v1/routes/' + id).send({ acl_people: false });
    assert.equal(res.status, 200);
    assert.equal(row(id).acl_people, 0);
    const bad = await api('put', '/api/v1/routes/' + id).send({ acl_people: 'yes' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.fields && bad.body.fields.acl_people);
    assert.equal(row(id).acl_people, 0);
  });

  it('licence gate like acl_enabled: turning it on needs peer_acl', async () => {
    const license = require('../src/services/license');
    const id = route('ap-lic.ga.test', { acl: 1, people: 0 });
    license._overrideForTest({ peer_acl: false });
    try {
      const res = await api('put', '/api/v1/routes/' + id).send({ acl_people: true });
      assert.equal(res.status, 403);
      assert.equal(res.body.feature, 'peer_acl');
      await api('put', '/api/v1/routes/' + id).send({ acl_people: false }).expect(200);
    } finally {
      license._overrideForTest({ peer_acl: true });
    }
    assert.equal(row(id).acl_people, 0);
  });

  it('the rollback snapshot (Caddy sync failure, batch) restores acl_people', () => {
    const { restoreRouteRow, reinsertRouteRow } = require('../src/services/routesRollback');
    const id = route('ap-rb.ga.test', { acl: 1, userIds: [1], people: 0 });
    const snapshot = row(id);
    db().prepare('UPDATE routes SET acl_people = 1 WHERE id = ?').run(id);
    restoreRouteRow(db(), id, snapshot);
    assert.equal(row(id).acl_people, 0);
    db().prepare('DELETE FROM routes WHERE id = ?').run(id);
    reinsertRouteRow(db(), snapshot);
    assert.equal(row(id).acl_people, 0);
  });

  it('preview endpoint passes aclPeople through', async () => {
    const u = user('Kai');
    peer('ap-kai', '10.8.1.20', u);
    const on = await api('post', '/api/v1/access/preview').send({ userIds: [u], aclPeople: true }).expect(200);
    assert.equal(on.body.aclPeople, true);
    assert.equal(on.body.personDevices.length, 1);
    const off = await api('post', '/api/v1/access/preview').send({ userIds: [u], aclPeople: false }).expect(200);
    assert.equal(off.body.people[0].visibleOnly, true);
    assert.deepEqual(off.body.personDevices, []);
  });
});

// ─── backup / restore ───────────────────────────────────────────────────

describe('backup / restore: acl_people', () => {
  const backup = () => require('../src/services/backup');
  const byDomain = (d) => db().prepare('SELECT acl_enabled, acl_people FROM routes WHERE domain = ?').get(d);

  before(() => {
    route('bk-off.ap.test', { acl: 1, userIds: [1], people: 0 });
    route('bk-on.ap.test', { acl: 1, userIds: [1], people: 1 });
    route('bk-plain.ap.test', { acl: 0, userIds: [1] });
  });

  it('a new backup carries acl_people and restores it as stored', async () => {
    const b = JSON.parse(JSON.stringify(backup().createBackup()));
    assert.equal(b.data.routes.find((r) => r.domain === 'bk-off.ap.test').acl_people, 0);
    assert.equal(b.data.routes.find((r) => r.domain === 'bk-on.ap.test').acl_people, 1);
    await backup().restoreBackup(b);
    assert.equal(byDomain('bk-off.ap.test').acl_people, 0);
    assert.equal(byDomain('bk-on.ap.test').acl_people, 1, 'an explicit 1 stays 1');
    assert.equal(byDomain('bk-plain.ap.test').acl_people, 1);
  });

  it('an old backup without acl_people gets the migration rule (never wider access)', async () => {
    const b = JSON.parse(JSON.stringify(backup().createBackup()));
    for (const r of b.data.routes) delete r.acl_people;
    const extra = { ...b.data.routes.find((r) => r.domain === 'bk-on.ap.test'), domain: 'bk-bad.ap.test', user_ids: '[1,' };
    b.data.routes.push(extra);
    await backup().restoreBackup(b);
    assert.equal(byDomain('bk-off.ap.test').acl_people, 0, 'ACL + persons → 0');
    assert.equal(byDomain('bk-on.ap.test').acl_people, 0, 'ACL + persons → 0 (rule, not the lost value)');
    assert.equal(byDomain('bk-plain.ap.test').acl_people, 1, 'no ACL → 1');
    assert.equal(byDomain('bk-bad.ap.test').acl_people, 1, 'malformed user_ids → 1');
  });
});
