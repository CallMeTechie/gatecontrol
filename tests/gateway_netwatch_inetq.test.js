'use strict';

// Phase 3a of the gateways, server side: features in the config pull (and the
// hash), the gateway endpoints (netwatch, inetq, presence, speed test), the
// admin API (session + CSRF + admin, no API tokens), the notices (new
// devices collected and throttled, outages > 5 min, UPS on battery / back),
// the retention of the internet quality values.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, server, baseUrl;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function gwReq(method, path, token = gw.apiToken) {
  return supertest(app)[method]('/api/v1/gateway' + path).set('Authorization', 'Bearer ' + token);
}
const admin = (method, path) => agent[method]('/api/v1/gateways/' + gw.peer.id + path).set('X-CSRF-Token', csrf);
function activities(type) {
  return db.prepare('SELECT event_type, message, details FROM activity_log WHERE event_type = ? ORDER BY id').all(type).map((r) => ({ ...r, details: JSON.parse(r.details || 'null') }));
}
const dev = (mac, extra) => ({ mac, ip: '192.168.1.' + (parseInt(mac.slice(-2), 16) % 250 + 2), vendor: null, hostname: null, randomMac: false, online: true, firstSeen: Date.now() - MIN, lastSeen: Date.now(), ports: null, ...extra });

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10, gateway_lan_discovery: true });
  const gateways = require('../src/services/gateways');
  gw = await gateways.createGateway({ name: 'Pi Keller' });
  gw2 = await gateways.createGateway({ name: 'Pi Garage' });
  db = require('../src/db/connection').getDb();
  // no real gateway behind the tunnel IPs: management calls and config pushes answer from here
  gateways.notifyConfigChanged = async () => {};
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  require('../src/services/netwatch')._resetForTest();
  require('../src/services/inetq')._resetForTest();
  await new Promise((r) => server.close(r));
  teardown();
});

describe('migration 128', () => {
  it('creates the tables of phase 3a', () => {
    for (const t of ['gateway_features', 'netwatch_devices', 'inetq_samples', 'inetq_hourly', 'inetq_outages', 'inetq_speedtests', 'presence_consent', 'presence_state']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
    }
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 128);
    assert.equal(m.name, 'gateway_netwatch_inetq');
    assert.equal(m.detect(db), true);
  });
});

describe('features in the config pull', () => {
  it('a gateway without settings gets the defaults; the hash covers them', async () => {
    const r = await gwReq('get', '/config').expect(200);
    assert.deepEqual(r.body.features, {
      netwatch: { enabled: true, portscan: true },
      inetq: { enabled: true, speedtest: '4x' },
      presence: { enabled: true, macs: [] },
      ups: { enabled: false, host: '', port: 3493, name: null },
      // phase 3b (tests/gateway_dns.test.js, gateway_cache.test.js)
      timezone: require('../src/services/notify/router').serverTz(),
      dns: { enabled: false },
      cache: { enabled: false },
      // phase 3c (tests/print_scan.test.js)
      print: { enabled: false, manual: [] },
      // phase 3c, step 2 (tests/gateway_radio.test.js): Zigbee automatic, Bluetooth off
      radio: { zigbee: null, ble: false },
      // phase 3c, step 3 (tests/ai_local.test.js): the local AI off
      ai: { enabled: false, source: 'service', lan: null },
      // phase 3c, step 4 (tests/home_cameras.test.js): the cameras off
      cameras: { enabled: false },
    });
    const gateways = require('../src/services/gateways');
    assert.equal(r.body.config_hash, gateways.computeConfigHash(gw.peer.id));
    await gwReq('get', '/config/check?hash=' + encodeURIComponent(r.body.config_hash)).expect(304);
  });

  it('a switch changes features and the hash; presence is off without the network watch', async () => {
    const before0 = (await gwReq('get', '/config').expect(200)).body.config_hash;
    await admin('put', '/features').send({ netwatch: { enabled: false } }).expect(200);
    const r = await gwReq('get', '/config').expect(200);
    assert.equal(r.body.features.netwatch.enabled, false);
    assert.equal(r.body.features.presence.enabled, false);
    assert.notEqual(r.body.config_hash, before0);
    const chk = await gwReq('get', '/config/check?hash=' + encodeURIComponent(before0)).expect(200);
    assert.equal(chk.body.config_hash, r.body.config_hash);
    await admin('put', '/features').send({ netwatch: { enabled: true } }).expect(200);
  });

  it('targets only when set, sorted public IPv4', async () => {
    await admin('put', '/features').send({ inetq: { targets: ['9.9.9.9', '1.1.1.1'] } }).expect(200);
    assert.deepEqual((await gwReq('get', '/config')).body.features.inetq.targets, ['1.1.1.1', '9.9.9.9']);
    const bad = await admin('put', '/features').send({ inetq: { targets: ['192.168.1.1'] } });
    assert.equal(bad.status, 400);
    await admin('put', '/features').send({ inetq: { targets: [] } }).expect(200);
    assert.equal('targets' in (await gwReq('get', '/config')).body.features.inetq, false);
  });
});

describe('admin API: features', () => {
  it('session only: API tokens are refused, writes need the CSRF token', async () => {
    const { rawToken } = require('../src/services/tokens').create({ name: 'p3a-tok', scopes: ['full-access'] }, '127.0.0.1');
    const anon = supertest(app);
    assert.equal((await anon.get(`/api/v1/gateways/${gw.peer.id}/features`).set('Authorization', 'Bearer ' + rawToken)).status, 403);
    assert.equal((await anon.put(`/api/v1/gateways/${gw.peer.id}/features`).set('Authorization', 'Bearer ' + rawToken).send({ inetq: { speedtest: 'off' } })).status, 403);
    assert.equal((await anon.get(`/api/v1/gateways/${gw.peer.id}/netwatch`).set('Authorization', 'Bearer ' + rawToken)).status, 403);
    assert.equal((await anon.post(`/api/v1/gateways/${gw.peer.id}/inetq/speedtest`).set('Authorization', 'Bearer ' + rawToken)).status, 403);
    assert.equal((await anon.get(`/api/v1/gateways/${gw.peer.id}/features`)).status, 401);
    assert.equal((await agent.put(`/api/v1/gateways/${gw.peer.id}/features`).send({ inetq: { speedtest: 'off' } })).status, 403);
    // the old gateways list still answers tokens as before (not swallowed by the new router)
    assert.equal((await anon.get('/api/v1/gateways').set('Authorization', 'Bearer ' + rawToken)).status, 200);
  });

  it('the overview: switches, hardware hints, memory estimate', async () => {
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify({
      telemetry: { gateway_version: '1.20.0', lan_discovery: true, mem_total: 1024 * 1048576,
        hardware: { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', cpu_cores: 4, mem_total: 1024 * 1048576, storage: { total: 30e9, free: 22e9 },
          radios: [{ kind: 'zigbee', type: 'raspbee2-conbee2', device: '/dev/ttyAMA0', detected: true, enabled: true }] } },
    }), gw.peer.id);
    const r = await admin('get', '/features').expect(200);
    const g = r.body.gateway;
    assert.equal(g.hardware.board, 'pi3bplus');
    assert.deepEqual(g.speedLimit, { key: 'pi3bplus', mbps: 300 });
    assert.equal(g.support.netwatch, false, '1.20.0 is too old');
    assert.equal(g.support.minGateway, '1.21.0');
    assert.ok(g.zigbee && g.zigbee.enabled);
    assert.equal(g.lanDiscovery.available, true);
    // gateway 80 + netwatch 15 + inetq 10 + deCONZ 90 (≈ 90 MB with a small network, phase 3c step 2)
    assert.equal(g.memory.usedMb, 195);
    assert.equal(g.memory.totalMb, 1024);
    assert.equal(g.memory.level, 'ok');
  });

  it('capabilities in the telemetry win over the version', () => {
    const f = require('../src/services/gatewayFeatures');
    assert.deepEqual(f.support({ gateway_version: '1.20.0', capabilities: ['netwatch'] }), { netwatch: true, inetq: false, presence: false, ups: false, dns: false, cache: false, print: false, radio: false, ai: false, cameras: false, version: '1.20.0', minGateway: '1.21.0', minGateway3b: '1.22.0', minGatewayPrint: '1.24.0', minGatewayRadio: '1.25.0', minGatewayAi: '1.26.0', minGatewayCameras: '1.28.0' });
    // phase 3c: only by the capability, never by the version
    assert.equal(f.support({ gateway_version: '1.30.0' }).print, false);
    assert.equal(f.support({ gateway_version: '1.24.0', capabilities: ['print'] }).print, true);
    assert.equal(f.support({ gateway_version: '1.21.0' }).inetq, true);
    assert.equal(f.support({}).ups, false);
  });

  it('UPS: only a private IPv4 host, switching on needs one', async () => {
    assert.equal((await admin('put', '/features').send({ ups: { enabled: true } })).body.code, 'ups_host_required');
    assert.equal((await admin('put', '/features').send({ ups: { host: '8.8.8.8' } })).body.code, 'invalid_host');
    assert.equal((await admin('put', '/features').send({ ups: { port: 70000 } })).status, 400);
    assert.equal((await admin('put', '/features').send({ ups: { bogus: 1 } })).status, 400);
    assert.equal((await admin('put', '/features').send({ inetq: { speedtest: 'daily' } })).status, 400);
    assert.equal((await admin('put', '/features').send({})).status, 400);
    const r = await admin('put', '/features').send({ ups: { enabled: true, host: '192.168.1.10', port: 3493, name: 'ups' } }).expect(200);
    assert.deepEqual(r.body.gateway.features.ups, { enabled: true, host: '192.168.1.10', port: 3493, name: 'ups' });
    assert.deepEqual((await gwReq('get', '/config')).body.features.ups, { enabled: true, host: '192.168.1.10', port: 3493, name: 'ups' });
    assert.equal(activities('gateway_features_changed').length > 0, true);
  });

  it('the existing LAN discovery switch is used, not a second one', async () => {
    await admin('put', '/features').send({ lanDiscovery: true }).expect(200);
    assert.equal(require('../src/services/gateways').getDiscoverySettings(gw.peer.id).enabled, 1);
    await admin('put', '/features').send({ lanDiscovery: false }).expect(200);
    assert.equal(require('../src/services/gateways').getDiscoverySettings(gw.peer.id).enabled, 0);
    assert.equal((await admin('put', '/features').send({ lanDiscovery: 'yes' })).status, 400);
  });

  it('an unknown gateway → 404', async () => {
    assert.equal((await agent.get('/api/v1/gateways/99999/features')).status, 404);
  });
});

describe('network watch: gateway report', () => {
  it('rejects a wrong token and a wrong shape', async () => {
    assert.equal((await gwReq('post', '/netwatch', 'gc_gw_' + 'a'.repeat(64)).send({ devices: [] })).status, 403);
    assert.equal((await gwReq('post', '/netwatch').send({ devices: 'x' })).status, 400);
    assert.equal((await gwReq('post', '/netwatch').send({ devices: [{ mac: 'nope' }] })).status, 400);
    assert.equal((await gwReq('post', '/netwatch').send({ devices: [dev('aa:bb:cc:00:00:01', { ports: [{ port: 0 }] })] })).status, 400);
    const many = Array.from({ length: 1025 }, (_, i) => dev('aa:bb:cc:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0')));
    assert.equal((await gwReq('post', '/netwatch').send({ full: true, devices: many })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM netwatch_devices').get().n, 0);
  });

  it('the first report is the inventory: known, no notice', async () => {
    const r = await gwReq('post', '/netwatch').send({ scanAt: Date.now(), full: true, devices: [
      dev('00:11:32:aa:bb:01', { vendor: 'Synology', hostname: 'diskstation', ports: [{ port: 443, service: 'https' }, { port: 445, service: 'smb' }, { port: 5001, service: null }] }),
      dev('30:05:5C:11:22:33', { vendor: 'Brother', ports: [{ port: 80, service: 'http' }, { port: 631, service: 'ipp' }, { port: 23, service: 'telnet' }] }),
      dev('a8-23-fe-44-55-66', { vendor: 'LG', ports: [] }),
    ] }).expect(200);
    assert.deepEqual(r.body, { ok: true, devices: 3 });
    const rows = db.prepare('SELECT mac, status FROM netwatch_devices WHERE peer_id = ? ORDER BY mac').all(gw.peer.id);
    assert.deepEqual(rows.map((x) => x.mac), ['00:11:32:aa:bb:01', '30:05:5c:11:22:33', 'a8:23:fe:44:55:66']);
    assert.ok(rows.every((x) => x.status === 'known'));
    assert.equal(activities('netwatch_new_device').length, 0);
  });

  it('a new MAC is new and notified once; more within 10 minutes are collected', async () => {
    const nw = require('../src/services/netwatch');
    nw._gapMs = 300;
    await gwReq('post', '/netwatch').send({ full: false, devices: [dev('24:0a:c4:9f:12:aa', { vendor: 'Espressif', hostname: 'esp32-9f12aa', ports: [] })] }).expect(200);
    let n = activities('netwatch_new_device');
    assert.equal(n.length, 1);
    assert.equal(n[0].details.count, 1);
    assert.equal(n[0].details.peer_name, 'Pi Keller');
    assert.match(n[0].message, /esp32-9f12aa/);
    // the same device again: no second notice
    await gwReq('post', '/netwatch').send({ devices: [dev('24:0a:c4:9f:12:aa')] }).expect(200);
    // two more right away: held back, then one collected notice
    await gwReq('post', '/netwatch').send({ devices: [dev('da:a1:19:00:00:01', { randomMac: true }), dev('3c:22:fb:00:00:02', { vendor: 'Apple' })] }).expect(200);
    assert.equal(activities('netwatch_new_device').length, 1);
    await sleep(500);
    n = activities('netwatch_new_device');
    assert.equal(n.length, 2);
    assert.equal(n[1].details.count, 2);
    nw._gapMs = null;
    // the notification center turned it into a push of the topic "network"
    const notif = db.prepare("SELECT topic, title FROM notifications WHERE event_type = 'netwatch_new_device' ORDER BY id DESC LIMIT 1").get();
    assert.equal(notif.topic, 'network');
    assert.match(notif.title, /Pi Keller/);
  });

  it('full: devices missing from the list are offline; a random MAC is detected by its bit', async () => {
    await gwReq('post', '/netwatch').send({ full: true, devices: [dev('00:11:32:aa:bb:01'), dev('da:a1:19:00:00:01')] }).expect(200);
    const off = db.prepare("SELECT online FROM netwatch_devices WHERE mac = 'a8:23:fe:44:55:66'").get();
    assert.equal(off.online, 0);
    assert.equal(db.prepare("SELECT random_mac FROM netwatch_devices WHERE mac = 'da:a1:19:00:00:01'").get().random_mac, 1);
    // ports: null keeps the last ports
    assert.ok(JSON.parse(db.prepare("SELECT ports FROM netwatch_devices WHERE mac = '00:11:32:aa:bb:01'").get().ports).length === 3);
  });

  it('is per gateway', async () => {
    await supertest(app).post('/api/v1/gateway/netwatch').set('Authorization', 'Bearer ' + gw2.apiToken).send({ devices: [dev('24:0a:c4:9f:12:aa')] }).expect(200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM netwatch_devices WHERE mac = ?').get('24:0a:c4:9f:12:aa').n, 2);
  });
});

describe('network watch: admin API', () => {
  it('list with KPIs, risky ports (not SMB on a NAS), search and filter', async () => {
    const r = await admin('get', '/netwatch').expect(200);
    assert.equal(r.body.total, 6);
    assert.equal(r.body.kpis.fresh, 3);
    assert.equal(r.body.kpis.risky, 1);
    const printer = r.body.devices.find((x) => x.mac === '30:05:5c:11:22:33');
    assert.deepEqual(printer.risks, [{ port: 23, key: 'telnet' }]);
    const nas = r.body.devices.find((x) => x.mac === '00:11:32:aa:bb:01');
    assert.deepEqual(nas.risks, []);
    assert.ok(r.body.lastScanAt);
    assert.equal(r.body.devices[0].status, 'new', 'new devices first');
    const q = await admin('get', '/netwatch?q=brother').expect(200);
    assert.deepEqual(q.body.devices.map((x) => x.mac), ['30:05:5c:11:22:33']);
    const f = await admin('get', '/netwatch?filter=new').expect(200);
    assert.equal(f.body.devices.length, 3);
  });

  it('confirm a device: name, owner, status; presence needs an owner', async () => {
    const id = db.prepare("SELECT id FROM netwatch_devices WHERE peer_id = ? AND mac = '3c:22:fb:00:00:02'").get(gw.peer.id).id;
    const r = await admin('put', '/netwatch/devices/' + id).send({ name: 'Marcs iPhone', ownerUserId: 1, status: 'known', presence: true }).expect(200);
    assert.equal(r.body.device.name, 'Marcs iPhone');
    assert.equal(r.body.device.ownerUserId, 1);
    assert.equal(r.body.device.presence, true);
    assert.equal(r.body.device.status, 'known');
    const r2 = await admin('put', '/netwatch/devices/' + id).send({ ownerUserId: null }).expect(200);
    assert.equal(r2.body.device.presence, false, 'without an owner it cannot count');
    assert.equal((await admin('put', '/netwatch/devices/' + id).send({ ownerUserId: 4242 })).body.code, 'invalid_owner');
    assert.equal((await admin('put', '/netwatch/devices/' + id).send({ status: 'new' })).status, 400);
    assert.equal((await admin('put', '/netwatch/devices/' + id).send({})).status, 400);
    // a device of another gateway is not reachable through this one
    const other = db.prepare('SELECT id FROM netwatch_devices WHERE peer_id = ?').get(gw2.peer.id).id;
    assert.equal((await admin('put', '/netwatch/devices/' + other).send({ name: 'x' })).status, 404);
    assert.ok(activities('netwatch_device_changed').length >= 2);
  });

  it('confirming before the notice went out: no notice any more', async () => {
    const nw = require('../src/services/netwatch');
    nw._gapMs = 60 * MIN;
    await gwReq('post', '/netwatch').send({ devices: [dev('b8:27:eb:00:00:09', { vendor: 'Raspberry Pi' })] }).expect(200);
    const before0 = activities('netwatch_new_device').length;
    const id = db.prepare("SELECT id FROM netwatch_devices WHERE mac = 'b8:27:eb:00:00:09'").get().id;
    await admin('put', '/netwatch/devices/' + id).send({ status: 'watch' }).expect(200);
    assert.equal(nw.sendNotice(gw.peer.id), null);
    assert.equal(activities('netwatch_new_device').length, before0);
    nw._resetForTest();
    nw._gapMs = null;
  });

  it('forget a device', async () => {
    const id = db.prepare("SELECT id FROM netwatch_devices WHERE mac = 'b8:27:eb:00:00:09'").get().id;
    await admin('delete', '/netwatch/devices/' + id).expect(200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM netwatch_devices WHERE id = ?').get(id).n, 0);
  });

  it('"Jetzt scannen" goes to the gateway management API', async () => {
    const gateways = require('../src/services/gateways');
    const orig = gateways.mgmtCall;
    const calls = [];
    try {
      gateways.mgmtCall = async (peerId, path) => { calls.push([peerId, path]); return { status: 202, body: { ok: true } }; };
      const r = await admin('post', '/netwatch/scan').expect(200);
      assert.deepEqual(r.body, { ok: true, busy: false });
      gateways.mgmtCall = async () => ({ status: 409, body: null });
      assert.equal((await admin('post', '/netwatch/scan').expect(200)).body.busy, true);
      gateways.mgmtCall = async () => null;
      assert.equal((await admin('post', '/netwatch/scan')).status, 502);
      gateways.mgmtCall = async () => ({ status: 404, body: null });
      assert.equal((await admin('post', '/netwatch/scan')).body.code, 'gateway_unsupported');
    } finally { gateways.mgmtCall = orig; }
    assert.deepEqual(calls, [[gw.peer.id, '/api/netwatch/scan']]);
  });
});

describe('internet quality', () => {
  const now = Date.now();
  const bucket = (t) => t - (t % (5 * MIN));

  it('rejects a wrong shape', async () => {
    assert.equal((await gwReq('post', '/inetq').send({ samples: [{ t: 'never' }] })).status, 400);
    assert.equal((await gwReq('post', '/inetq').send({ samples: 'x' })).status, 400);
    assert.equal((await gwReq('post', '/inetq').send({ samples: Array.from({ length: 2001 }, () => ({ t: now })) })).status, 400);
  });

  it('samples, outages and speed tests are stored idempotently', async () => {
    const samples = [];
    for (let i = 0; i < 12; i++) samples.push({ t: bucket(now) - i * 5 * MIN, rttRouterMs: 2, rttInetMs: 14 + (i % 3), lossInetPct: 0, rttServerMs: 22 });
    const body = { samples, outages: [{ start: now - 30 * MIN, end: now - 28 * MIN, cause: 'isp' }], speedtests: [{ at: now - 10 * MIN, downMbps: 248.4, upMbps: 46, bytes: 60e6 }] };
    await gwReq('post', '/inetq').send(body).expect(200);
    await gwReq('post', '/inetq').send(body).expect(200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inetq_samples WHERE peer_id = ?').get(gw.peer.id).n, 12);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inetq_outages WHERE peer_id = ?').get(gw.peer.id).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inetq_speedtests WHERE peer_id = ?').get(gw.peer.id).n, 1);
    // 2 minutes: no notice
    assert.equal(activities('inet_outage').length, 0);
  });

  it('an outage longer than 5 minutes is notified when it is over, with duration and cause', async () => {
    const start = now - 20 * MIN;
    await gwReq('post', '/inetq').send({ outages: [{ start, end: null, cause: 'router' }] }).expect(200);
    assert.equal(activities('inet_outage').length, 0, 'still running');
    const view = await admin('get', '/inetq').expect(200);
    assert.equal(view.body.now.state, 'outage');
    assert.equal(view.body.now.outageCause, 'router');
    await gwReq('post', '/inetq').send({ outages: [{ start, end: start + 7 * MIN, cause: 'router' }] }).expect(200);
    const n = activities('inet_outage');
    assert.equal(n.length, 1);
    assert.equal(n[0].details.minutes, 7);
    assert.equal(n[0].details.cause, 'router');
    // sent again: not notified twice
    await gwReq('post', '/inetq').send({ outages: [{ start, end: start + 7 * MIN, cause: 'router' }] }).expect(200);
    assert.equal(activities('inet_outage').length, 1);
  });

  it('the notice can be switched off per gateway', async () => {
    await admin('put', '/features').send({ notify: { outage: false } }).expect(200);
    await gwReq('post', '/inetq').send({ outages: [{ start: now - 60 * MIN, end: now - 50 * MIN, cause: 'isp' }] }).expect(200);
    assert.equal(activities('inet_outage').length, 1);
    await admin('put', '/features').send({ notify: { outage: true } }).expect(200);
  });

  it('the view: now, speed, history of 24 h / 7 days / 30 days, outages', async () => {
    const r = await admin('get', '/inetq?range=24h').expect(200);
    assert.equal(r.body.now.state, 'ok');
    assert.ok(r.body.now.rttInetMs >= 14);
    assert.equal(r.body.speed.downMbps, 248.4);
    assert.equal(r.body.points.length, 12);
    assert.equal(r.body.outages.length, 3);
    assert.equal(r.body.gateway.speedLimit.key, 'pi3bplus');
    const w = await admin('get', '/inetq?range=7d').expect(200);
    assert.ok(w.body.points.length >= 1 && w.body.points.length <= 2, 'hourly buckets');
    assert.equal((await admin('get', '/inetq?range=bogus').expect(200)).body.range, '24h');
  });

  it('"Jetzt messen" goes to the gateway management API', async () => {
    const gateways = require('../src/services/gateways');
    const orig = gateways.mgmtCall;
    let path = null;
    try {
      gateways.mgmtCall = async (peerId, p) => { path = p; return { status: 202, body: { ok: true } }; };
      await admin('post', '/inetq/speedtest').expect(200);
    } finally { gateways.mgmtCall = orig; }
    assert.equal(path, '/api/inetq/speedtest');
    assert.ok((await admin('get', '/inetq').expect(200)).body.speedPending);
  });

  it('retention: 5-minute values older than 30 days → hourly values; a year → gone (in steps)', async () => {
    const inetq = require('../src/services/inetq');
    const H = 3600 * 1000;
    const base = now - 40 * DAY - ((now - 40 * DAY) % H);
    const ins = db.prepare('INSERT INTO inetq_samples (peer_id, t, rtt_router_ms, rtt_inet_ms, loss_inet_pct, rtt_server_ms) VALUES (?, ?, ?, ?, ?, ?)');
    for (let h = 0; h < 5; h++) for (let i = 0; i < 12; i++) ins.run(gw.peer.id, base + h * H + i * 5 * MIN, 2, 10 + i, i === 0 ? 50 : 0, 20);
    db.prepare('INSERT INTO inetq_hourly (peer_id, t, rtt_inet_ms, n) VALUES (?, ?, ?, ?)').run(gw.peer.id, now - 400 * DAY, 12, 12);
    db.prepare('INSERT INTO inetq_outages (peer_id, start_at, end_at, cause, notified) VALUES (?, ?, ?, ?, 1)').run(gw.peer.id, now - 400 * DAY, now - 400 * DAY + MIN, 'isp');
    db.prepare('INSERT INTO inetq_speedtests (peer_id, at, down_mbps) VALUES (?, ?, ?)').run(gw.peer.id, now - 400 * DAY, 10);
    inetq._stepRows = 1;
    let yields = 0;
    const origSetImmediate = global.setImmediate;
    global.setImmediate = (fn, ...a) => { yields++; return origSetImmediate(fn, ...a); };
    let r;
    try { r = await inetq.retention(now); } finally { global.setImmediate = origSetImmediate; inetq._stepRows = null; }
    assert.equal(r.compactedHours, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inetq_samples WHERE t < ?').get(now - 30 * DAY).n, 0);
    const hr = db.prepare('SELECT * FROM inetq_hourly WHERE peer_id = ? AND t = ?').get(gw.peer.id, base);
    assert.equal(hr.n, 12);
    assert.equal(hr.rtt_inet_ms, 15.5);
    assert.equal(hr.rtt_inet_max, 21);
    assert.equal(r.hourlyDeleted, 1);
    assert.equal(r.outagesDeleted, 1);
    assert.equal(r.speedtestsDeleted, 1);
    assert.ok(yields >= 3, 'gave the event loop back between the steps');
    // the recent values stay
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inetq_samples WHERE peer_id = ?').get(gw.peer.id).n, 12);
  });
});

describe('speed test endpoints', () => {
  const inetq = () => require('../src/services/inetq');

  function raw(method, path, { token = gw.apiToken, body = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(baseUrl + '/api/v1/gateway' + path, { method, headers: { Authorization: 'Bearer ' + token, ...headers } }, (res) => {
        let n = 0;
        const chunks = [];
        res.on('data', (c) => { n += c.length; if (chunks.length < 4) chunks.push(c); });
        const done = () => resolve({ status: res.statusCode, headers: res.headers, bytes: n, text: Buffer.concat(chunks).toString('utf8').slice(0, 400) });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      });
      req.on('error', reject);
      if (body) req.end(body); else req.end();
    });
  }

  it('download: exactly N random bytes, octet-stream, no cache', async () => {
    const r = await raw('GET', '/speedtest/down?bytes=200000');
    assert.equal(r.status, 200);
    assert.equal(r.bytes, 200000);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['content-encoding'], undefined);
  });

  it('download: limits of N', async () => {
    assert.equal((await raw('GET', '/speedtest/down?bytes=0')).status, 400);
    assert.equal((await raw('GET', '/speedtest/down?bytes=100000001')).status, 400);
    assert.equal((await raw('GET', '/speedtest/down?bytes=1e6')).status, 400);
    assert.equal((await raw('GET', '/speedtest/down?bytes=10', { token: 'gc_gw_' + 'b'.repeat(64) })).status, 403);
  });

  it('upload: counted and thrown away; too big → 413', async () => {
    const r = await raw('POST', '/speedtest/up', { body: Buffer.alloc(300000, 7), headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).bytes, 300000);
    const big = await raw('POST', '/speedtest/up', { headers: { 'Content-Length': '100000001', 'Content-Type': 'application/octet-stream' } }).catch((e) => ({ status: 'reset', e }));
    assert.ok(big.status === 413 || big.status === 'reset');
  });

  it('at most 8 streams per gateway and 16 in all; a daily budget', () => {
    const q = inetq();
    q._resetForTest();
    const slots = [];
    for (let i = 0; i < 8; i++) slots.push(q.acquire(gw.peer.id, 1000));
    assert.ok(slots.every((s) => s.release));
    assert.deepEqual(q.acquire(gw.peer.id, 1000), { error: 'busy' });
    for (let i = 0; i < 8; i++) slots.push(q.acquire(gw2.peer.id, 1000));
    assert.deepEqual(q.acquire(9999, 1000), { error: 'busy' }, 'the server-wide limit');
    slots.forEach((s) => s.release());
    q.account(gw.peer.id, q.SPEED_BUDGET_BYTES);
    assert.deepEqual(q.acquire(gw.peer.id, 1), { error: 'budget' });
    assert.ok(q.acquire(gw2.peer.id, 1).release);
    q._resetForTest();
  });

  it('plan "hourly": a download stream is cut to 25 MB; the used-up budget shows in the view', async () => {
    const q = inetq();
    await admin('put', '/features').send({ inetq: { speedtest: 'hourly' } }).expect(200);
    try {
      const r = await raw('GET', '/speedtest/down?bytes=60000000');
      assert.equal(r.status, 200);
      assert.equal(r.bytes, q.SPEED_HOURLY_MAX_BYTES);
      assert.equal(Number(r.headers['content-length']), q.SPEED_HOURLY_MAX_BYTES);
    } finally { await admin('put', '/features').send({ inetq: { speedtest: '4x' } }).expect(200); }
    q._resetForTest();
    assert.equal(q.budgetInfo(gw.peer.id).exhausted, false);
    q.account(gw.peer.id, q.SPEED_BUDGET_BYTES - 1000);
    assert.equal((await raw('GET', '/speedtest/down?bytes=100000')).status, 429);
    const v = await admin('get', '/inetq').expect(200);
    assert.equal(v.body.speedBudget.exhausted, true);
    assert.ok(v.body.speedBudget.resetAt);
    q._resetForTest();
    // the gateway reports a test refused for the budget
    await gwReq('post', '/inetq').send({ speedtests: [{ at: Date.now(), downMbps: null, upMbps: null, bytes: 0, error: 'budget' }] }).expect(200);
    q._resetForTest();
  });

  it('a busy gateway gets 429 busy', async () => {
    const q = inetq();
    const slots = Array.from({ length: 8 }, () => q.acquire(gw.peer.id, 1));
    try {
      const r = await raw('GET', '/speedtest/down?bytes=10');
      assert.equal(r.status, 429);
      assert.match(r.text, /busy/);
    } finally { slots.forEach((s) => s.release()); }
  });

  it('a stream ends after its time limit (no endless stream)', async () => {
    const q = inetq();
    q._streamMaxMs = 30;
    try {
      const r = await raw('GET', '/speedtest/down?bytes=100000000').catch(() => ({ status: 200, bytes: -1 }));
      assert.ok(r.bytes < 100000000, 'cut before the end');
    } finally { q._streamMaxMs = null; q._resetForTest(); }
  });
});

describe('UPS from the heartbeat', () => {
  it('on battery and back are notices; a steady status is not', async () => {
    const hb = (status, extra) => gwReq('post', '/heartbeat').send({ uptime_s: 1, telemetry: { ups: { status, charge: 100, runtimeSec: 2520, model: 'Back-UPS 700', at: Date.now(), ...extra } } }).expect(200);
    await hb('OL');
    await hb('OL');
    assert.equal(activities('ups_on_battery').length, 0);
    await hb('OB DISCHRG', { charge: 97 });
    const n = activities('ups_on_battery');
    assert.equal(n.length, 1);
    assert.equal(n[0].details.charge, 97);
    assert.equal(n[0].details.runtime_min, 42);
    await hb('OB DISCHRG');
    assert.equal(activities('ups_on_battery').length, 1);
    await hb('OL CHRG');
    assert.equal(activities('ups_on_line').length, 1);
    const v = await admin('get', '/inetq').expect(200);
    assert.equal(v.body.ups.state, 'online');
    assert.equal(v.body.ups.model, 'Back-UPS 700');
  });

  it('switched off: no notice', async () => {
    await admin('put', '/features').send({ notify: { ups: false } }).expect(200);
    await gwReq('post', '/heartbeat').send({ telemetry: { ups: { status: 'OB' } } }).expect(200);
    assert.equal(activities('ups_on_battery').length, 1);
    await admin('put', '/features').send({ notify: { ups: true } }).expect(200);
  });
});

describe('notification catalogue', () => {
  it('a group "network" with its own admin-only topic', () => {
    const notifications = require('../src/services/notifications');
    const g = notifications.CATALOGUE.find((x) => x.id === 'network');
    // phase 3b adds dns_filter (tests/gateway_dns.test.js)
    assert.deepEqual(g.events.map((e) => e.id), ['netwatch_new_device', 'inet_outage', 'ups_state', 'dns_filter']);
    const c = require('../src/services/notify/constants');
    assert.ok(c.CORE_TOPICS.includes('network'));
    assert.ok(c.ADMIN_ONLY_TOPICS.has('network'));
    assert.match('network', c.TOPIC_RE);
    const rules = require('../src/services/notify/rules');
    assert.ok(rules.RECOVERY_TYPES.has('ups_on_line'));
  });
});
