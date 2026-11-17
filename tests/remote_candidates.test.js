'use strict';

// gc.remote, version 7 (the new „Gerät hinzufügen“ of the plugin "Fernzugriff", docs/plugins.md "Remote access",
// docs/feature-remote-access.md): candidates() only for an administrator in a request and never with a MAC, the
// same device in the VPN and in a home network (twin), L4 routes that look like SSH / RDP / VNC, scan() of several
// ports directly (with the greeting) or through the gateway, listenPort 'auto', wake by a device of the watch.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { remotePackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const ID = 'gatecontrol-remote';
let agent, csrf, plugins, db, adminId, cand, targets, gateways, personContext;
const call = async (api, args = {}) => (await agent.post(`/api/v1/plugins/${ID}/api/call`).set('X-CSRF-Token', csrf).send({ api, args }).expect(200)).body;
const pget = async (p) => (await agent.get(`/api/v1/plugins/${ID}/api${p}`).expect(200)).body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function install(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

const GW = 61;      // gateway „Zuhause“, online, in pool „Heim“
const GW_OFF = 62;  // gateway „Ferienhaus“, offline
const MAC_PC = '3c:7c:3f:12:9a:01';
let nasPeer, pcPeer, lanNas, lanPc, lanPhone, poolId;

function gateway(id, name, { alive = true, subnets = [] } = {}) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)").run(id, name, 'pk-gw-' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at, last_health)
    VALUES (?, 9876, 'h', 'e', ?, ?, ?, ?)`).run(id, alive ? 1 : 0, alive ? Date.now() : Date.now() - 2 * 3600e3, Date.now(),
    JSON.stringify({ telemetry: { lan_subnets: subnets.map((cidr) => ({ cidr })) } }));
}
function peer(name, ip, extra = {}) {
  return Number(db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, hostname, client_platform) VALUES (?, ?, ?, 1, 'regular', ?, ?)`)
    .run(name, 'pk-' + name, ip + '/32', extra.hostname || null, extra.platform || null).lastInsertRowid);
}
function watched(peerId, d) {
  const now = Date.now();
  return Number(db.prepare(`INSERT INTO netwatch_devices (peer_id, mac, ip, vendor, hostname, random_mac, online, first_seen, last_seen, ports, ports_at, name, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', ?)`).run(peerId, d.mac, d.ip, d.vendor || null, d.hostname || null, d.random ? 1 : 0, d.online === false ? 0 : 1,
    now, now, d.ports ? JSON.stringify(d.ports) : null, d.ports ? now : null, d.name || null, now).lastInsertRowid);
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  db = require('../src/db/connection').getDb();
  cand = require('../src/services/remote/candidates');
  targets = require('../src/services/remote/targets');
  gateways = require('../src/services/gateways');
  personContext = require('../src/services/plugins/personContext');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  gateway(GW, 'Zuhause', { subnets: ['192.168.178.0/24'] });
  gateway(GW_OFF, 'Ferienhaus', { alive: false, subnets: ['192.168.10.0/24'] });
  poolId = Number(db.prepare("INSERT INTO gateway_pools (name, failback_cooldown_s) VALUES ('Heim', 60)").run().lastInsertRowid);
  db.prepare('INSERT INTO gateway_pool_members (pool_id, peer_id) VALUES (?, ?)').run(poolId, GW);
  nasPeer = peer('nas', '10.8.0.30', { hostname: 'nas' });
  pcPeer = peer('buero-pc', '10.8.0.12', { hostname: 'buero-pc', platform: 'windows' });
  peer('vps-backup', '10.8.0.40', { hostname: 'vps-backup' });
  lanNas = watched(GW, { mac: '00:11:32:aa:bb:01', ip: '192.168.178.20', vendor: 'Synology', hostname: 'NAS', ports: [{ port: 22, service: 'ssh' }, { port: 80, service: 'http' }, { port: 445, service: 'smb' }] });
  lanPc = watched(GW, { mac: MAC_PC, ip: '192.168.178.34', vendor: 'Micro-Star', hostname: 'DESKTOP-1', name: 'wohnzimmer-pc', ports: [{ port: 3389, service: 'rdp' }] });
  lanPhone = watched(GW, { mac: 'da:a1:19:00:00:01', ip: '192.168.178.70', hostname: 'handy', random: true });
  watched(GW_OFF, { mac: '00:11:32:aa:bb:09', ip: '192.168.10.15', hostname: 'werkbank-pc', ports: [{ port: 3389, service: 'rdp' }], online: false });
  // L4 routes: one to the NAS in the VPN that looks like SSH, one HTTP-ish that does not count
  db.prepare(`INSERT INTO routes (domain, target_ip, target_port, description, peer_id, route_type, l4_protocol, l4_listen_port, l4_tls_mode, target_kind, enabled)
    VALUES (NULL, '10.8.0.30', 22, 'git-server', ?, 'l4', 'tcp', '2222', 'none', 'peer', 1)`).run(nasPeer);
  db.prepare(`INSERT INTO routes (domain, target_ip, target_port, description, peer_id, route_type, l4_protocol, l4_listen_port, l4_tls_mode, target_kind, enabled)
    VALUES (NULL, '10.8.0.30', 8080, 'nas-web', ?, 'l4', 'tcp', '18080', 'none', 'peer', 1)`).run(nasPeer);
  await install(remotePackage());
  for (let i = 0; i < 50; i++) { try { if ((await pget('/has')).version >= 7) break; } catch { /* starting */ } await wait(100); }
});

after(async () => {
  cand._resetForTest();
  targets._resetForTest();
  await plugins.stop();
  teardown();
});

describe('gc.remote.candidates (version 7)', () => {
  it('version 7; only for an administrator whose request is in flight', async () => {
    assert.equal((await pget('/has')).version, 7);
    assert.equal((await call('candidates', {})).code, 'ERR_INVALID');
    // outside a request of that person
    assert.throws(() => cand.candidates({ id: ID }, { user: adminId }), (e) => e.code === 'not_allowed');
    // a person who is not an administrator, in a request
    const marc = Number(db.prepare("INSERT INTO users (username, password_hash, role, enabled) VALUES ('cand-marc', '!', 'user', 1)").run().lastInsertRowid);
    await personContext.run(ID, marc, false, async () => {
      assert.throws(() => cand.candidates({ id: ID }, { user: marc }), (e) => e.code === 'not_allowed');
    });
    // the administrator through the plugin's API (the forwarder runs the request in personContext)
    assert.equal((await call('candidates', { user: adminId })).ok, true);
  });

  it('peers, gateways with their watch devices, routes — never a MAC', async () => {
    const r = (await call('candidates', { user: adminId })).result;
    const all = JSON.stringify(r);
    for (const mac of [MAC_PC, '00:11:32:aa:bb:01', MAC_PC.toUpperCase()]) assert.ok(!all.toLowerCase().includes(mac), 'no MAC ' + mac);
    assert.ok(!/"mac"|owner|presence/i.test(all), 'no MAC, owner or presence field');
    assert.equal(r.vpn.subnet, require('../config/default').wireguard.subnet);
    const nas = r.peers.find((p) => p.name === 'nas');
    assert.equal(nas.address, '10.8.0.30');
    assert.equal(r.peers.find((p) => p.name === 'buero-pc').app, 'windows');
    assert.ok(!r.peers.some((p) => p.peerId === GW), 'gateways are not peers of the list');
    const home = r.gateways.find((g) => g.peerId === GW);
    assert.equal(home.online, true);
    assert.deepEqual(home.pool, { poolId, name: 'Heim' });
    assert.deepEqual(home.subnets, ['192.168.178.0/24']);
    assert.deepEqual(Object.keys(home.watch).sort(), ['enabled', 'portscan', 'scannedAt']);
    const pc = home.devices.find((d) => d.address === '192.168.178.34');
    assert.equal(pc.name, 'wohnzimmer-pc', 'the name the administrator gave wins over the host name');
    assert.equal(pc.vendor, 'Micro-Star');
    assert.equal(pc.wake, true);
    assert.equal(pc.ref, 'nw-' + lanPc);
    assert.deepEqual(pc.ports, [{ port: 3389, service: 'rdp' }]);
    const nasLan = home.devices.find((d) => d.ref === 'nw-' + lanNas);
    assert.deepEqual(nasLan.ports, [{ port: 22, service: 'ssh' }], 'only the ports of a remote desktop or a shell');
    assert.equal(home.devices.find((d) => d.ref === 'nw-' + lanPhone).wake, false, 'a random MAC cannot be woken');
    const away = r.gateways.find((g) => g.peerId === GW_OFF);
    assert.equal(away.online, false);
    assert.equal(away.pool, null);
    // the same NAS in the VPN and in the home network
    assert.deepEqual(nas.twin, { gatewayPeerId: GW, ref: 'nw-' + lanNas, address: '192.168.178.20' });
    assert.deepEqual(nasLan.twin, { peerId: nasPeer, address: '10.8.0.30' });
    assert.equal(r.peers.find((p) => p.name === 'vps-backup').twin, null);
    // routes: only the one that looks like SSH
    assert.deepEqual(r.routes.map((x) => [x.name, x.protocol, x.listenPort, x.target.kind, x.target.host, x.target.port]), [['git-server', 'ssh', 2222, 'peer', '10.8.0.30', 22]]);
  });
});

describe('gc.remote.scan (version 7)', () => {
  it('direct: several ports at once, the greeting tells SSH and VNC', async () => {
    const servers = [];
    const listen = (greet) => new Promise((res) => {
      const s = net.createServer((c) => { if (greet) c.write(greet); c.on('error', () => {}); });
      servers.push(s);
      s.listen(0, '127.0.0.1', () => res(s.address().port));
    });
    const map = { 22: await listen('SSH-2.0-OpenSSH_9.6\r\n'), 5900: await listen('RFB 003.008\n'), 3389: await listen(null) };
    targets._setLookupForTest(async () => [{ address: '10.20.30.40', family: 4 }]);
    cand._setConnectForTest(({ port }) => (map[port] ? net.connect({ host: '127.0.0.1', port: map[port] }) : net.connect({ host: '127.0.0.1', port: 1 })));
    try {
      const r = await call('scan', { target: { id: 'ext', host: 'ferien-nas.example.test' }, ports: [22, 3389, 5900, 23] });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.result.via, 'direct');
      assert.equal(r.result.address, '10.20.30.40');
      const by = Object.fromEntries(r.result.results.map((x) => [x.port, x]));
      assert.deepEqual([by[22].open, by[22].service], [true, 'ssh']);
      assert.deepEqual([by[5900].open, by[5900].service], [true, 'vnc']);
      assert.deepEqual([by[3389].open, by[3389].service], [true, null]);
      assert.equal(by[23].open, false);
    } finally {
      cand._resetForTest();
      targets._resetForTest();
      for (const s of servers) s.close();
    }
    assert.equal((await call('scan', { target: { id: 'x', host: '10.8.0.30' }, ports: [] })).code, 'ERR_INVALID');
    assert.equal((await call('scan', { target: { id: 'x', host: '10.8.0.30' }, ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).code, 'ERR_INVALID');
    assert.equal((await call('scan', { target: { id: 'x', host: '127.0.0.1' }, ports: [22] })).code, 'ERR_REMOTE_NOT_ALLOWED');
    assert.equal((await call('scan', { target: { id: 'x', listener: 'dev-1' }, ports: [22] })).code, 'ERR_INVALID');
    assert.equal(cand.classify(Buffer.from([0xff, 0xfd, 0x18])), 'telnet');
  });

  it('through the gateway: its probe per port; an offline gateway is said so', async () => {
    const orig = gateways.probeGatewayTarget;
    const asked = [];
    gateways.probeGatewayTarget = async (peerId, host, port) => { asked.push([peerId, host, port]); return { probed_target: true, probe_result: port === 3389, probe_latency_ms: 18 }; };
    try {
      const r = (await call('scan', { target: { id: 'lan', host: '192.168.178.34', gateway: { peerId: GW } }, ports: [22, 3389, 5900, 23] })).result;
      assert.equal(r.via, 'gateway');
      assert.deepEqual(r.results.map((x) => [x.port, x.open, x.responseTime]), [[22, false, null], [3389, true, 18], [5900, false, null], [23, false, null]]);
      assert.equal(asked.length, 4);
      assert.ok(asked.every((x) => x[0] === GW && x[1] === '192.168.178.34'));
      assert.equal((await call('scan', { target: { id: 'lan', host: '192.168.10.15', gateway: { peerId: GW_OFF } }, ports: [3389] })).code, 'ERR_REMOTE_GATEWAY_OFFLINE');
      gateways.probeGatewayTarget = async () => ({ ok: true });
      const old = (await call('scan', { target: { id: 'lan', host: '192.168.178.34', gateway: { peerId: GW } }, ports: [3389] })).result;
      assert.equal(old.results[0].open, null, 'an older gateway that cannot probe the target');
    } finally { gateways.probeGatewayTarget = orig; }
  });
});

describe('listenPort auto and wake by the watch (version 7)', () => {
  it('auto picks a free port of the range, keeps it for the same target and shares a matching old route', async () => {
    const cfg = require('../config/default').remoteListeners;
    const a = await call('listener', { key: 'dev-100001', gateway: { peerId: GW }, host: '192.168.178.34', port: 3389, listenPort: 'auto' });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.result.auto, true);
    assert.ok(a.result.listenPort >= cfg.autoMin && a.result.listenPort <= cfg.autoMax);
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(a.result.routeId);
    assert.equal(route.external_enabled, 0, 'internal only');
    const again = (await call('listener', { key: 'dev-100001', gateway: { peerId: GW }, host: '192.168.178.34', port: 3389, listenPort: 'auto' })).result;
    assert.equal(again.listenPort, a.result.listenPort);
    const b = (await call('listener', { key: 'dev-100002', gateway: { peerId: GW }, host: '192.168.178.50', port: 22, listenPort: 'auto' })).result;
    assert.notEqual(b.listenPort, a.result.listenPort);
    // an old gateway route to exactly this target on 13389: shared, whatever its port
    db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode, target_kind, target_peer_id, target_lan_host, target_lan_port, enabled)
      VALUES (NULL, '0.0.0.0', 13389, 'l4', 'tcp', '13389', 'none', 'gateway', ?, '192.168.178.60', 3389, 1)`).run(GW);
    const s = (await call('listener', { key: 'route-7', gateway: { peerId: GW }, host: '192.168.178.60', port: 3389, listenPort: 'auto' })).result;
    assert.deepEqual([s.shared, s.listenPort], [true, 13389]);
    // the range is full
    const prev = { ...cfg };
    cfg.autoMin = a.result.listenPort; cfg.autoMax = a.result.listenPort;
    try {
      assert.equal((await call('listener', { key: 'dev-100003', gateway: { peerId: GW }, host: '192.168.178.51', port: 22, listenPort: 'auto' })).code, 'ERR_REMOTE_PORT_IN_USE');
    } finally { Object.assign(cfg, prev); }
    for (const k of ['dev-100001', 'dev-100002', 'route-7']) await call('listener.remove', { key: k });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes WHERE id = ?').get(a.result.routeId).n, 0);
  });

  it('wake by a device of the watch: the core takes the MAC, only for an administrator in a request', async () => {
    const orig = gateways.notifyWol;
    const sent = [];
    gateways.notifyWol = async (peerId, x) => { sent.push([peerId, x.mac, x.lan_host]); return { ok: true }; };
    try {
      const target = { id: 'nw', host: '192.168.178.34', port: 3389, gateway: { peerId: GW }, watch: 'nw-' + lanPc };
      assert.equal((await call('wake', { target })).code, 'ERR_INVALID', 'without the person');
      const r = await call('wake', { target, user: adminId });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.result, { sent: true, via: 'gateway' });
      assert.deepEqual(sent, [[GW, MAC_PC, '192.168.178.34']]);
      assert.equal((await call('wake', { target: { ...target, watch: 'nw-' + lanPhone }, user: adminId })).code, 'ERR_REMOTE_NOT_ALLOWED', 'a random MAC');
      assert.equal((await call('wake', { target: { ...target, watch: 'nw-999999' }, user: adminId })).code, 'ERR_NOT_FOUND');
      assert.equal((await call('wake', { target: { ...target, watch: 'aa:bb' }, user: adminId })).code, 'ERR_INVALID');
    } finally { gateways.notifyWol = orig; }
  });
});

describe('a listener of a failover pool (Fernzugriff 1.7.2: a home with two gateways)', () => {
  const GW2 = 91; // the second gateway of „Heim“, the reserve
  const health = () => require('../src/services/gatewayHealth');

  it('the members get the new listener at once; probe and wake go through the member serving the pool', async () => {
    gateway(GW2, 'Zuhause-2', { subnets: ['192.168.178.0/24'] });
    db.prepare('INSERT INTO gateway_pool_members (pool_id, peer_id, priority) VALUES (?, ?, 1000)').run(poolId, GW2);
    const pushed = [];
    const asked = [];
    const woken = [];
    const orig = { push: gateways.notifyConfigChanged, probe: gateways.probeGatewayTarget, wol: gateways.notifyWol, snap: health().getSnapshot };
    gateways.notifyConfigChanged = async (peerId) => { pushed.push(peerId); };
    gateways.probeGatewayTarget = async (peerId, host, port) => { asked.push([peerId, host, port]); return { probed_target: true, probe_result: false, probe_latency_ms: 9 }; };
    gateways.notifyWol = async (peerId, x) => { woken.push([peerId, x.mac, x.lan_host]); return { ok: true }; };
    let snap = { [GW]: { alive: true }, [GW2]: { alive: true } };
    health().getSnapshot = () => snap;
    try {
      const l = await call('listener', { key: 'dev-100010', gateway: { poolId }, host: '192.168.178.89', port: 22, listenPort: 'auto' });
      assert.equal(l.ok, true, JSON.stringify(l));
      assert.deepEqual(l.result.gateway, { poolId });
      // before: no push for a pool route — the gateways only saw it at their next poll (300 s), the session met a closed door
      assert.deepEqual([...new Set(pushed)].sort(), [GW, GW2]);

      // the probe asks the gateway Caddy uses (the first live member), never the server's own port (1 ms, always open)
      const target = { id: 'dev-100010', name: 'develop', listener: 'dev-100010', mac: '3c:7c:3f:12:9a:10' };
      const p = await call('probe', target);
      assert.equal(p.ok, true, JSON.stringify(p));
      assert.deepEqual(p.result, { online: false, responseTime: 9, via: 'gateway' });
      assert.deepEqual(asked, [[GW, '192.168.178.89', 22]]);
      snap = { [GW]: { alive: false }, [GW2]: { alive: true } };
      await call('probe', target);
      assert.deepEqual(asked[1], [GW2, '192.168.178.89', 22], 'after a failover: the reserve');
      assert.equal((await call('wake', target)).result.via, 'gateway');
      assert.deepEqual(woken, [[GW2, '3c:7c:3f:12:9a:10', '192.168.178.89']]);

      // no member alive: offline without asking anyone, no broadcast into the server's own network
      snap = { [GW]: { alive: false }, [GW2]: { alive: false } };
      assert.deepEqual((await call('probe', target)).result, { online: false, responseTime: null, via: 'gateway' });
      assert.equal(asked.length, 2);
      targets._resetForTest();
      assert.equal((await call('wake', target)).code, 'ERR_REMOTE_GATEWAY_OFFLINE');

      // removed: the members drop the listener at once as well
      pushed.length = 0;
      await call('listener.remove', { key: 'dev-100010' });
      assert.deepEqual([...new Set(pushed)].sort(), [GW, GW2]);
    } finally {
      Object.assign(gateways, { notifyConfigChanged: orig.push, probeGatewayTarget: orig.probe, notifyWol: orig.wol });
      health().getSnapshot = orig.snap;
      targets._resetForTest();
      db.prepare('DELETE FROM gateway_pool_members WHERE peer_id = ?').run(GW2);
    }
  });
});
