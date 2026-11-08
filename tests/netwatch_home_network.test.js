'use strict';

// Gateways in one home network (services/homeNetwork.js gatewayHomes()): a
// failover pool, or the same private LAN behind the same router. For the
// network watch they are ONE home network — a MAC both see is one device:
// decisions hold on every gateway, a new device is notified once, rows that
// are already doubled are merged (netwatch.reconcileHomes, migration 130) —
// and presence, "Internet zu Hause", the DNS filter and the home cache follow.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gateways, pool, nw;
let a, b, c, annaId;
const MIN = 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = '3c:22:fb:10:00:01';
const TABLET = '3c:22:fb:10:00:02';
const ESP = '24:0a:c4:10:00:03';
const ROUTER = '2c:91:ab:10:00:fe';

const dev = (mac, extra) => ({ mac, ip: '192.168.178.' + (parseInt(mac.slice(-2), 16) % 250 + 2), vendor: null, hostname: null, randomMac: false, online: true,
  firstSeen: Date.now() - MIN, lastSeen: Date.now(), ports: null, ...extra });
const report = (g, body) => supertest(app).post('/api/v1/gateway/netwatch').set('Authorization', 'Bearer ' + g.apiToken).send(body).expect(200);
const admin = (method, g, path) => agent[method]('/api/v1/gateways/' + g.peer.id + path).set('X-CSRF-Token', csrf);
const rowsOf = (mac) => db.prepare('SELECT * FROM netwatch_devices WHERE mac = ? ORDER BY peer_id').all(mac);
const rowOf = (g, mac) => db.prepare('SELECT * FROM netwatch_devices WHERE peer_id = ? AND mac = ?').get(g.peer.id, mac);
function activities(type) {
  return db.prepare('SELECT message, details FROM activity_log WHERE event_type = ? ORDER BY id').all(type).map((r) => ({ ...r, details: JSON.parse(r.details || 'null') }));
}
function telemetry(g, tel) {
  db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: tel }), g.peer.id);
}
function clearDevices() {
  db.prepare('DELETE FROM netwatch_devices').run();
  db.prepare("DELETE FROM activity_log WHERE event_type LIKE 'netwatch%'").run();
  nw._resetForTest();
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  a = await gateways.createGateway({ name: 'Pi Keller' });
  b = await gateways.createGateway({ name: 'Pi Garage' });
  c = await gateways.createGateway({ name: 'Pi Eltern' });
  db = require('../src/db/connection').getDb();
  pool = require('../src/services/gatewayPool');
  nw = require('../src/services/netwatch');
  const anna = await require('../src/services/users').create({ username: 'anna', password: 'AnnaPass123!x', role: 'user', display_name: 'Anna' });
  annaId = anna.id;
});

after(() => {
  nw._resetForTest();
  teardown();
});

describe('which gateways form one home network', () => {
  const home = require('../src/services/homeNetwork');

  it('alone without a pool and without reports', () => {
    assert.deepEqual(home.homeOf(a.peer.id), [a.peer.id]);
    assert.deepEqual(home.gatewayHomes(), [[a.peer.id], [b.peer.id], [c.peer.id]]);
  });

  it('the same LAN subnet alone is not enough (every FRITZ!Box has 192.168.178.0/24)', async () => {
    for (const g of [a, c]) telemetry(g, { lan_subnets: [{ cidr: '192.168.178.0/24' }], default_gateway_ip: '192.168.178.1' });
    assert.deepEqual(home.homeOf(a.peer.id), [a.peer.id]);
    // two different routers at 192.168.178.1
    await report(a, { full: true, devices: [dev(ROUTER, { ip: '192.168.178.1' })] });
    await report(c, { full: true, devices: [dev('2c:91:ab:99:99:99', { ip: '192.168.178.1' })] });
    assert.deepEqual(home.homeOf(a.peer.id), [a.peer.id]);
  });

  it('the same subnet and the same router: one home network', async () => {
    telemetry(b, { lan_subnets: [{ cidr: '192.168.178.0/23' }], default_gateway_ip: '192.168.178.1' });
    await report(b, { full: true, devices: [dev(ROUTER, { ip: '192.168.178.1' })] });
    assert.deepEqual(home.homeOf(a.peer.id), [a.peer.id, b.peer.id]);
    assert.deepEqual(home.homeOf(c.peer.id), [c.peer.id]);
    // a randomised router MAC proves nothing
    db.prepare('UPDATE netwatch_devices SET random_mac = 1 WHERE mac = ?').run(ROUTER);
    assert.deepEqual(home.homeOf(a.peer.id), [a.peer.id]);
    db.prepare('UPDATE netwatch_devices SET random_mac = 0 WHERE mac = ?').run(ROUTER);
    // a public "LAN" is never a home network
    telemetry(b, { lan_subnets: [{ cidr: '8.8.8.0/24' }], default_gateway_ip: '192.168.178.1' });
    assert.deepEqual(home.homeOf(a.peer.id), [a.peer.id]);
  });

  it('a gateway pool (failover) is one home network, also transitively', () => {
    for (const g of [a, b, c]) telemetry(g, {});
    const p1 = pool.createPool({ name: 'Failover', mode: 'failover', failback_cooldown_s: 0 });
    pool.addMember(p1, a.peer.id, 10);
    pool.addMember(p1, b.peer.id, 20);
    assert.deepEqual(home.homeOf(b.peer.id), [a.peer.id, b.peer.id]);
    assert.deepEqual(home.homeOf(c.peer.id), [c.peer.id]);
    const p2 = pool.createPool({ name: 'Zweitpool', mode: 'failover', failback_cooldown_s: 0 });
    pool.addMember(p2, b.peer.id, 10);
    pool.addMember(p2, c.peer.id, 20);
    assert.deepEqual(home.homeOf(c.peer.id), [a.peer.id, b.peer.id, c.peer.id]);
    pool.deletePool(p2);
    assert.deepEqual(home.homeOf(c.peer.id), [c.peer.id]);
    assert.deepEqual(home.homeMap().get(b.peer.id), [a.peer.id, b.peer.id]);
  });
});

describe('network watch: one device in the home network (A, B in a failover pool)', () => {
  beforeEach(clearDevices);

  it('a device decided on A is known on B as soon as B sees it — no "new", no notice', async () => {
    await report(a, { full: true, devices: [dev(ROUTER)] }); // inventory
    await report(b, { full: true, devices: [dev(ROUTER)] });
    await report(a, { devices: [dev(PHONE, { vendor: 'Apple' })] });
    assert.equal(activities('netwatch_new_device').length, 1);
    const id = rowOf(a, PHONE).id;
    await admin('put', a, '/netwatch/devices/' + id).send({ name: 'Annas iPhone', ownerUserId: annaId, status: 'known', presence: true }).expect(200);
    await report(b, { devices: [dev(PHONE, { vendor: 'Apple' })] });
    const rb = rowOf(b, PHONE);
    assert.equal(rb.status, 'known');
    assert.equal(rb.name, 'Annas iPhone');
    assert.equal(rb.owner_user_id, annaId);
    assert.equal(rb.presence, 1);
    assert.equal(rb.decided_at, rowOf(a, PHONE).decided_at);
    await sleep(20);
    assert.equal(activities('netwatch_new_device').length, 1);
  });

  it('both gateways report the same new device: one notice for the home network, with both names', async () => {
    nw._gapMs = 200;
    await report(a, { full: true, devices: [dev(ROUTER)] });
    await report(b, { full: true, devices: [dev(ROUTER)] });
    // A reports two, B one of them — before A's notice is due
    await report(a, { devices: [dev(ESP, { hostname: 'esp32-a' })] });
    await report(a, { devices: [dev(TABLET, { hostname: 'tablet' })] });
    await report(b, { devices: [dev(TABLET, { hostname: 'tablet' }), dev(ESP, { hostname: 'esp32-a' })] });
    await sleep(400);
    const n = activities('netwatch_new_device');
    assert.equal(n.length, 2, JSON.stringify(n.map((x) => x.message)));
    assert.equal(n[0].details.count, 1);
    assert.equal(n[1].details.count, 1); // TABLET once, not twice
    assert.match(n[1].message, /Pi Keller \/ Pi Garage/);
    assert.deepEqual(n[1].details.peer_ids, [a.peer.id, b.peer.id]);
    assert.ok(rowsOf(TABLET).every((r) => r.notified_at));
    assert.ok(rowsOf(ESP).every((r) => r.status === 'new' && r.notified_at));
    // another round: nothing pending, nothing sent
    nw.flushPending();
    await sleep(300);
    assert.equal(activities('netwatch_new_device').length, 2);
    nw._gapMs = null;
  });

  it('sendNotice reads and marks in one transaction: a second call (other gateway, other timer) finds nothing', async () => {
    await report(a, { full: true, devices: [dev(ROUTER)] });
    await report(b, { full: true, devices: [dev(ROUTER)] });
    nw._gapMs = 60 * MIN; // hold the timers back
    db.prepare('UPDATE netwatch_devices SET notified_at = ? WHERE mac = ?').run(Date.now(), ROUTER);
    await report(a, { devices: [dev(ESP)] });
    await report(b, { devices: [dev(ESP)] });
    assert.equal(activities('netwatch_new_device').length, 0);
    assert.deepEqual(nw.sendNotice(b.peer.id), { count: 1 });
    assert.equal(nw.sendNotice(a.peer.id), null);
    assert.equal(activities('netwatch_new_device').length, 1);
    nw._gapMs = null;
    nw._resetForTest();
  });

  it('editing on B changes the device on A as well; the list says who else sees it', async () => {
    await report(a, { full: true, devices: [dev(ROUTER), dev(PHONE)] });
    await report(b, { full: true, devices: [dev(ROUTER), dev(PHONE), dev(TABLET)] });
    const r = await admin('put', b, '/netwatch/devices/' + rowOf(b, PHONE).id).send({ name: 'Telefon', ownerUserId: annaId, status: 'watch' }).expect(200);
    assert.equal(r.body.device.status, 'watch');
    for (const row of rowsOf(PHONE)) {
      assert.equal(row.name, 'Telefon');
      assert.equal(row.owner_user_id, annaId);
      assert.equal(row.status, 'watch');
      assert.ok(row.decided_at);
    }
    const ch = activities('netwatch_device_changed').at(-1);
    assert.deepEqual(ch.details.home_peer_ids, [a.peer.id, b.peer.id]);
    const l = await admin('get', a, '/netwatch').expect(200);
    assert.deepEqual(l.body.home, { gateways: [{ id: b.peer.id, name: 'Pi Garage' }] });
    const phone = l.body.devices.find((d) => d.mac === PHONE);
    assert.deepEqual(phone.alsoSeenBy, [{ id: b.peer.id, name: 'Pi Garage' }]);
    // still per gateway: A does not list B's tablet
    assert.equal(l.body.devices.some((d) => d.mac === TABLET), false);
    assert.equal(l.body.total, 2);
  });

  it('forgetting a device forgets it on every gateway of the home network', async () => {
    await report(a, { full: true, devices: [dev(ROUTER), dev(PHONE)] });
    await report(b, { full: true, devices: [dev(ROUTER), dev(PHONE)] });
    const r = await admin('delete', b, '/netwatch/devices/' + rowOf(b, PHONE).id).expect(200);
    assert.equal(r.body.gateways, 2);
    assert.equal(rowsOf(PHONE).length, 0);
    assert.equal(rowsOf(ROUTER).length, 2);
  });

  it('a gateway of another home network keeps its own device list and decisions', async () => {
    await report(a, { full: true, devices: [dev(ROUTER)] });
    await report(c, { full: true, devices: [dev(ROUTER)] });
    await report(a, { devices: [dev(PHONE)] });
    await admin('put', a, '/netwatch/devices/' + rowOf(a, PHONE).id).send({ name: 'Nur Keller', status: 'known' }).expect(200);
    await report(c, { devices: [dev(PHONE)] });
    assert.equal(rowOf(c, PHONE).status, 'new');
    assert.equal(rowOf(c, PHONE).name, null);
  });
});

describe('rows already doubled: merge at the start (reconcileHomes)', () => {
  beforeEach(clearDevices);

  function insert(g, mac, extra) {
    const r = { name: null, owner_user_id: null, status: 'new', presence: 0, decided_at: null, notified_at: null, ...extra };
    db.prepare(`INSERT INTO netwatch_devices (peer_id, mac, first_seen, last_seen, name, owner_user_id, status, presence, decided_at, notified_at, presence_online, presence_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g.peer.id, mac, Date.now() - MIN, Date.now(), r.name, r.owner_user_id, r.status, r.presence, r.decided_at, r.notified_at,
      r.presence_online ?? null, r.presence_at ?? null, Date.now(), Date.now());
  }

  it('the row decided last wins; an empty name comes from the other; open "new" notices are done', () => {
    const t0 = Date.now() - 10 * MIN;
    insert(a, PHONE, { name: 'iPhone (alt)', owner_user_id: 1, status: 'known', presence: 1, decided_at: t0 });
    insert(b, PHONE, { owner_user_id: annaId, status: 'watch', decided_at: t0 + MIN });
    insert(a, TABLET, { status: 'known' }); // inventory on A
    insert(b, TABLET, { status: 'new' }); // pending on B
    insert(a, ESP, { status: 'new', notified_at: t0 }); // notified on A
    insert(b, ESP, { status: 'new' });
    insert(c, PHONE, { status: 'new' }); // another home network: untouched
    const r = nw.reconcileHomes();
    assert.deepEqual(r, { devices: 3, rows: 4 });
    for (const row of rowsOf(PHONE).filter((x) => x.peer_id !== c.peer.id)) {
      assert.equal(row.name, 'iPhone (alt)');
      assert.equal(row.owner_user_id, annaId);
      assert.equal(row.status, 'watch');
      assert.equal(row.presence, 0);
      assert.equal(row.decided_at, t0 + MIN);
    }
    assert.equal(rowOf(c, PHONE).status, 'new');
    assert.equal(rowOf(b, TABLET).status, 'known');
    assert.equal(rowOf(b, ESP).status, 'new');
    assert.equal(rowOf(b, ESP).notified_at, t0);
    assert.equal(activities('netwatch_home_merged').length, 1);
    // idempotent
    assert.deepEqual(nw.reconcileHomes(), { devices: 0, rows: 0 });
    assert.equal(activities('netwatch_home_merged').length, 1);
  });

  it('migration 130: decided_at from the last "netwatch_device_changed" of the device', () => {
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 130);
    assert.equal(m.name, 'netwatch_decided_at');
    assert.equal(m.detect(db), true);
    insert(a, PHONE, { status: 'known' });
    const id = rowOf(a, PHONE).id;
    const log = db.prepare("INSERT INTO activity_log (event_type, message, details, created_at) VALUES ('netwatch_device_changed', 'x', ?, ?)");
    log.run(JSON.stringify({ device_id: id }), '2026-01-02 03:04:05');
    log.run(JSON.stringify({ device_id: id }), '2026-03-02 03:04:05');
    log.run('not json', '2026-04-01 00:00:00');
    m.run(db);
    assert.equal(rowOf(a, PHONE).decided_at, Date.parse('2026-03-02T03:04:05Z'));
  });
});

describe('presence, "Internet zu Hause", DNS filter, home cache in the home network', () => {
  const presence = require('../src/services/homePresence');
  const inet = require('../src/services/homeInternet');
  const dns = require('../src/services/homeDns');

  before(async () => {
    clearDevices();
    await report(a, { full: true, devices: [dev(ROUTER), dev(PHONE), dev(TABLET)] });
    await report(b, { full: true, devices: [dev(ROUTER), dev(PHONE)] }); // B has not seen the tablet yet
    await admin('put', a, '/netwatch/devices/' + rowOf(a, PHONE).id).send({ name: 'Annas iPhone', ownerUserId: annaId, status: 'known', presence: true }).expect(200);
    await admin('put', a, '/netwatch/devices/' + rowOf(a, TABLET).id).send({ name: 'Annas Tablet', ownerUserId: annaId, status: 'known' }).expect(200);
    presence.setConsent(annaId, true);
  });

  it('both gateways watch the phone; the person is listed with it once', () => {
    assert.deepEqual(presence.macsFor(a.peer.id), [PHONE]);
    assert.deepEqual(presence.macsFor(b.peer.id), [PHONE]);
    const list = presence.devices(annaId);
    assert.equal(list.length, 2);
    const phone = list.find((d) => d.name === 'Annas iPhone');
    assert.equal(phone.gateway, 'Pi Keller / Pi Garage');
    assert.equal(phone.counts, true);
  });

  it('setCounts on one row changes the phone on both gateways', () => {
    const phone = presence.devices(annaId).find((d) => d.name === 'Annas iPhone');
    presence.setCounts(annaId, phone.id, false);
    assert.ok(rowsOf(PHONE).every((r) => r.presence === 0));
    presence.setCounts(annaId, phone.id, true);
    assert.ok(rowsOf(PHONE).every((r) => r.presence === 1));
  });

  it('a gateway that is down does not keep the person home with its last report', async () => {
    const t = Date.now();
    presence.ingest(a.peer.id, { events: [{ mac: PHONE, online: true, at: t - 5 * MIN }] });
    presence.ingest(b.peer.id, { events: [{ mac: PHONE, online: true, at: t - 5 * MIN }] });
    assert.equal(presence.list().find((x) => x.userId === annaId).home, true);
    // A goes down (its last word: online); B sees the phone leave
    db.prepare('UPDATE gateway_meta SET alive = 0 WHERE peer_id = ?').run(a.peer.id);
    presence.ingest(b.peer.id, { events: [{ mac: PHONE, online: false, at: t - MIN }] });
    assert.equal(presence.list().find((x) => x.userId === annaId).home, false);
    // both up: any gateway that sees the phone keeps the person home
    db.prepare('UPDATE gateway_meta SET alive = 1 WHERE peer_id = ?').run(a.peer.id);
    presence.recompute(annaId, Date.now());
    assert.equal(presence.list().find((x) => x.userId === annaId).home, true);
  });

  it('a pause holds on the failover gateway too — also for a device only A has seen; counted once', async () => {
    await dns.setGeneral(a.peer.id, { enabled: true });
    assert.equal(dns.get(b.peer.id).enabled, true); // the DNS settings hold for the home network
    inet.pause(annaId, 30, { actors: [1] });
    const pa = dns.configPayload(a.peer.id).pauses;
    const pb = dns.configPayload(b.peer.id).pauses;
    assert.deepEqual(pa.map((x) => x.macs), [[PHONE, TABLET]]);
    assert.deepEqual(pb, pa);
    assert.deepEqual(inet.gatewaysOf(annaId), [a.peer.id, b.peer.id]);
    const st = inet.status(annaId);
    assert.equal(st.devices, 2);
    assert.equal(st.filtered, true);
    assert.deepEqual(inet.runningOn(b.peer.id).map((x) => x.userId), [annaId]);
    inet.resume(annaId, { actors: [1] });
  });

  it('DNS profiles hold on both gateways: people and devices put in directly (by the row of A) → MACs on B', () => {
    const p = dns.createProfile(b.peer.id, { name: 'Kinder', users: [annaId], schedules: [{ days: [1, 2, 3, 4, 5], from: '21:00', to: '06:00', block: 'all' }] });
    const esp = dns.createProfile(a.peer.id, { name: 'IoT', devices: [rowOf(a, TABLET).id] });
    for (const g of [a, b]) {
      const prof = dns.configPayload(g.peer.id).profiles;
      assert.deepEqual(prof.find((x) => x.id === p.id).macs, [PHONE], g.name);
      assert.deepEqual(prof.find((x) => x.id === esp.id).macs, [TABLET], g.name); // the direct device wins over the person
      assert.equal(prof.find((x) => x.id === p.id).schedules.length, 1);
    }
    // the view of B: devices of the home network once, the direct device as B's view lists it, the other gateway named
    const v = dns.view(b.peer.id);
    assert.deepEqual(v.gateway.home, [{ id: a.peer.id, name: 'Pi Keller' }]);
    assert.equal(v.devices.filter((d) => d.mac === PHONE).length, 1);
    assert.equal(v.devices.find((d) => d.mac === PHONE).id, rowOf(b, PHONE).id);
    const iot = v.profiles.find((x) => x.id === esp.id);
    assert.deepEqual(iot.devices, [rowOf(a, TABLET).id]); // B has no row of the tablet: A's
    assert.equal(iot.directDevices[0].name, 'Annas Tablet');
    // a device of the home network may be put in from B; one of another home network may not
    const both = dns.updateProfile(b.peer.id, esp.id, { devices: [rowOf(a, TABLET).id, rowOf(b, PHONE).id] });
    assert.equal(both.devices.length, 2);
    assert.deepEqual(dns.configPayload(a.peer.id).profiles.find((x) => x.id === esp.id).macs, [PHONE, TABLET]);
    db.prepare("INSERT INTO netwatch_devices (peer_id, mac, first_seen, last_seen, status, created_at) VALUES (?, '00:11:22:33:44:55', 1, 1, 'known', 1)").run(c.peer.id);
    const foreign = db.prepare("SELECT id FROM netwatch_devices WHERE mac = '00:11:22:33:44:55'").get().id;
    assert.throws(() => dns.updateProfile(b.peer.id, esp.id, { devices: [foreign] }), (e) => e.code === 'invalid_member');
  });

  it('DNS settings that differ (pool created later): the ones changed last are taken over', () => {
    const s = dns.get(a.peer.id);
    db.prepare('UPDATE gateway_dns SET settings = ?, updated_at = ? WHERE peer_id = ?').run(JSON.stringify({ ...s, enabled: false, profiles: [s.profiles[0]] }), Date.now() - 60 * MIN, b.peer.id);
    db.prepare('UPDATE gateway_dns SET updated_at = ? WHERE peer_id = ?').run(Date.now() - MIN, a.peer.id);
    assert.equal(dns.reconcileHomes(), 1);
    assert.deepEqual(dns.get(b.peer.id), dns.get(a.peer.id));
    assert.equal(activities('gateway_dns_home_synced').length, 1);
    assert.equal(dns.reconcileHomes(), 0);
    // a gateway of another home network keeps its own settings
    assert.equal(dns.get(c.peer.id).enabled, false);
  });

  it('the home cache of B keeps the files of people whose devices only A has seen', async () => {
    db.prepare('DELETE FROM netwatch_devices WHERE peer_id = ? AND owner_user_id = ?').run(b.peer.id, annaId);
    const cache = require('../src/services/homeCache');
    db.prepare(`INSERT INTO home_cache_blobs (sha256, size, kind, source, user_ids, created_at, updated_at) VALUES (?, 10, 'photos', 'plugin', ?, 1, 1)`)
      .run('a'.repeat(64), JSON.stringify([annaId]));
    db.prepare(`INSERT INTO gateway_cache (peer_id, settings, updated_at) VALUES (?, ?, 1)`).run(b.peer.id, JSON.stringify({ enabled: true, kinds: { photos: true } }));
    assert.deepEqual((await cache.stockOf(b.peer.id)).map((x) => x.sha256), ['a'.repeat(64)]);
  });
});
