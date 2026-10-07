'use strict';

// Home-network targets (docs/plugins.md "Netzwerk"): plugin.json declares
// what it needs, the administrator assigns routes, VPN peers or hosts, the
// plugin only names the id. Transport like GateControl itself (companion
// proxy + X-Gateway-Target-Domain for gateway routes).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, hostApi, netPolicy, targets, db;
const API = '/api/v1/plugins';
const call = (p, body) => agent.post(`${API}/hello/api${p}`).set('X-CSRF-Token', csrf).send(body || {});
const assign = (target, assigned) => agent.put(`${API}/hello/targets/${target}`).set('X-CSRF-Token', csrf).send({ assigned });

function peer(name, ip, type = 'client') {
  return Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, ?)").run(name, 'pk-' + name, ip + '/32', type).lastInsertRowid);
}
function route(fields) {
  const f = { route_type: 'http', target_ip: '', target_port: 80, enabled: 1, ...fields };
  const cols = Object.keys(f);
  return Number(db.prepare(`INSERT INTO routes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => f[c])).lastInsertRowid);
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  hostApi = require('../src/services/plugins/hostApi');
  netPolicy = require('../src/services/plugins/netPolicy');
  targets = require('../src/services/plugins/targets');
  db = require('../src/db/connection').getDb();
  netPolicy._setReservedForTest(['10.8.0.0/24']);
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(helloPackage()).expect(200);
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning('hello'), true);
});
after(async () => {
  hostApi._lookup = null; hostApi._udpTargets = null;
  netPolicy._setTestPrivateForTest(null); netPolicy._setReservedForTest(null);
  await plugins.stop();
  teardown();
});

describe('declared, unassigned', () => {
  it('the install dialog shows the targets in plain terms', async () => {
    const r = await agent.get(API + '/hello').expect(200);
    assert.deepEqual(r.body.plugin.permissions.network.homeTargets.map((t) => [t.id, t.protocols]), [['gateway', ['http']], ['device', ['tcp:6444', 'udp:6445']]]);
    assert.deepEqual(r.body.plugin.permissions.network.discovery, { udp: ['6445', '20086'] });
  });
  it('an unassigned target is refused', async () => {
    const r = await call('/target', { target: 'gateway', path: '/api' }).expect(502);
    assert.equal(r.body.code, 'ERR_NET_DENIED');
    assert.match(r.body.error, /no target assigned/);
    const u = await call('/target', { target: 'not-declared', path: '/' }).expect(502);
    assert.match(u.body.error, /declares no target/);
  });
  it('home and VPN addresses are not reachable as internet hosts', async () => {
    hostApi._lookup = async () => [{ address: '10.8.0.30', family: 4 }];
    const r = await agent.get(`${API}/hello/api/fetch?url=${encodeURIComponent('https://api.example.com/x')}`).expect(502);
    assert.match(r.body.error, /not_public/);
    const r2 = await agent.get(`${API}/hello/api/fetch?url=${encodeURIComponent('http://smarthome.internal/')}`).expect(502);
    assert.match(r2.body.error, /not_allowed/);
    hostApi._lookup = null;
  });
});

describe('assigned by the administrator', () => {
  it('the API lists declared targets and the routes/peers to choose from', async () => {
    const gw = peer('Gateway Wohnung', '10.8.0.20', 'gateway');
    route({ domain: 'phoscon.home.example', target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.1.50', target_lan_port: 80, target_port: 80 });
    const r = await agent.get(API + '/hello/targets').expect(200);
    assert.deepEqual(r.body.declared.map((d) => d.id), ['gateway', 'device']);
    assert.deepEqual(r.body.discovery, { udp: ['6445', '20086'], granted: false });
    assert.ok(r.body.choices.routes.some((x) => x.label === 'phoscon.home.example'));
    assert.ok(r.body.choices.peers.some((x) => x.label === 'Gateway Wohnung' && x.ip === '10.8.0.20' && x.gateway));
  });
  it('invalid assignments are refused', async () => {
    assert.equal((await assign('gateway', [{ kind: 'route', routeId: 99999 }]).expect(400)).body.code, 'unknown_route');
    assert.equal((await assign('gateway', [{ kind: 'host', host: '127.0.0.1' }]).expect(400)).body.code, 'blocked_address');
    assert.equal((await assign('gateway', [{ kind: 'host', host: 'a b' }]).expect(400)).body.code, 'invalid_host');
    assert.equal((await assign('gateway', [{ kind: 'host', host: 'a.example' }, { kind: 'host', host: 'b.example' }]).expect(400)).body.code, 'too_many_targets');
    assert.equal((await assign('nope', []).expect(400)).body.code, 'unknown_target');
  });
  it('a gateway route resolves to the companion proxy with X-Gateway-Target-Domain', async () => {
    const rid = db.prepare("SELECT id FROM routes WHERE domain = 'phoscon.home.example'").get().id;
    const r = await assign('gateway', [{ kind: 'route', routeId: rid }]).expect(200);
    assert.equal(r.body.assigned[0].display, 'phoscon.home.example');
    const ep = await targets.resolve(plugins.get('hello'), 'gateway', 0, 'http');
    assert.deepEqual({ scheme: ep.scheme, host: ep.host, port: ep.port, address: ep.address, headers: ep.headers },
      { scheme: 'http', host: '10.8.0.20', port: 8080, address: '10.8.0.20', headers: { 'x-gateway-target-domain': 'phoscon.home.example' } });
    const act = db.prepare("SELECT message FROM activity_log WHERE event_type = 'plugin_target_changed'").get();
    assert.match(act.message, /gateway/);
  });
  it('end to end through the plugin: a direct HTTP route goes to its backend', async (t) => {
    const seen = [];
    const srv = http.createServer((req, res) => { seen.push({ url: req.url, domain: req.headers['x-gateway-target-domain'] }); res.end('{"ok":1}'); });
    const ok = await new Promise((r) => { srv.once('error', () => r(false)); srv.listen(0, '127.0.0.1', () => r(true)); });
    if (!ok) { t.skip('no port'); return; }
    netPolicy._setTestPrivateForTest(['127.0.0.1']);
    try {
      const rid = route({ domain: 'direct.home.example', target_ip: '127.0.0.1', target_port: srv.address().port });
      await assign('gateway', [{ kind: 'route', routeId: rid }]).expect(200);
      const r = await call('/target', { target: 'gateway', path: '/api/lights?x=1', opts: { headers: { 'X-Gateway-Target-Domain': 'evil.example' } } }).expect(200);
      assert.equal(r.body.status, 200);
      assert.deepEqual(seen, [{ url: '/api/lights?x=1', domain: 'evil.example' }], 'direct route: no gateway header involved');
      const bad = await call('/target', { target: 'gateway', path: '//evil.example/x' }).expect(502);
      assert.match(bad.body.error, /leaves the target/);
    } finally { netPolicy._setTestPrivateForTest(null); srv.close(); }
  });
  it('end to end through the companion proxy: the route’s domain header wins over the plugin’s', async (t) => {
    const seen = [];
    const srv = http.createServer((req, res) => { seen.push({ url: req.url, domain: req.headers['x-gateway-target-domain'] }); res.end('{}'); });
    const ok = await new Promise((r) => { srv.once('error', () => r(false)); srv.listen(8080, '127.0.0.1', () => r(true)); });
    if (!ok) { t.skip('port 8080 in use'); return; }
    netPolicy._setTestPrivateForTest(['127.0.0.1']);
    try {
      const gw = peer('Loopback-Gateway', '127.0.0.1', 'gateway');
      const rid = route({ domain: 'deconz.home.example', target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.1.50', target_lan_port: 80 });
      await assign('gateway', [{ kind: 'route', routeId: rid }]).expect(200);
      await call('/target', { target: 'gateway', path: '/api/key/lights', opts: { headers: { 'X-Gateway-Target-Domain': 'admin.gatecontrol.example' } } }).expect(200);
      assert.deepEqual(seen, [{ url: '/api/key/lights', domain: 'deconz.home.example' }]);
    } finally { netPolicy._setTestPrivateForTest(null); srv.close(); }
  });
  it('an internal-only domain is reachable only once assigned (resolved through the server’s DNS)', async () => {
    hostApi._lookup = async (h) => (h === 'smarthome.internal' ? [{ address: '10.8.0.30', family: 4 }] : []);
    await assign('gateway', []).expect(200);
    let r = await call('/target', { target: 'gateway', path: '/' }).expect(502);
    assert.match(r.body.error, /no target assigned/);
    await assign('gateway', [{ kind: 'host', host: 'smarthome.internal', port: 8443, scheme: 'https' }]).expect(200);
    const ep = await targets.resolve(plugins.get('hello'), 'gateway', 0, 'http', { lookup: hostApi._lookup });
    assert.deepEqual([ep.scheme, ep.host, ep.port, ep.address], ['https', 'smarthome.internal', 8443, '10.8.0.30']);
    r = await call('/target', { target: 'gateway', path: '/' }).expect(502);
    assert.equal(r.body.code, 'ERR_NET', 'passes the policy, then the connection fails: ' + r.body.error);
    hostApi._lookup = null;
  });
  it('GateControl’s own admin API / Caddy admin are never reachable, even when assigned', async () => {
    await assign('gateway', [{ kind: 'host', host: '10.8.0.1', port: 3000 }]).expect(200);
    let r = await call('/target', { target: 'gateway', path: '/' }).expect(502);
    assert.match(r.body.error, /admin ports/);
    await assign('gateway', [{ kind: 'host', host: '10.8.0.1', port: 2019 }]).expect(200);
    r = await call('/target', { target: 'gateway', path: '/config/' }).expect(502);
    assert.match(r.body.error, /admin ports/);
  });
  it('TCP: a peer target on a declared port; other ports refused', async (t) => {
    const srv = net.createServer((s) => s.on('data', (d) => s.write(d)));
    const ok = await new Promise((r) => { srv.once('error', () => r(false)); srv.listen(6444, '127.0.0.1', () => r(true)); });
    if (!ok) { t.skip('port 6444 in use'); return; }
    netPolicy._setTestPrivateForTest(['127.0.0.1']);
    try {
      const pid = peer('Klima', '127.0.0.1');
      await assign('device', [{ kind: 'peer', peerId: pid }]).expect(200);
      const r = await call('/tcp', { target: 'device', send: 'hello-6444' }).expect(200);
      assert.equal(r.body.echo, 'hello-6444');
      const no = await call('/tcp', { target: 'device', port: 6443, send: 'x' }).expect(502);
      assert.match(no.body.error, /not declared/);
      const http2 = await call('/target', { target: 'device', path: '/' }).expect(502);
      assert.match(http2.body.error, /does not allow HTTP/);
    } finally { netPolicy._setTestPrivateForTest(null); srv.close(); }
  });
  it('local discovery needs the administrator’s grant and declared ports', async (t) => {
    let r = await call('/discover', { ports: [6445] }).expect(502);
    assert.match(r.body.error, /not granted/);
    await agent.put(API + '/hello/discovery').set('X-CSRF-Token', csrf).send({ granted: true }).expect(200);
    const sock = dgram.createSocket('udp4');
    sock.on('message', (m, ri) => sock.send(Buffer.from('ac:' + m), ri.port, ri.address));
    const ok = await new Promise((res) => { sock.once('error', () => res(false)); sock.bind(6445, '127.0.0.1', () => res(true)); });
    if (!ok) { t.skip('port 6445 in use'); return; }
    netPolicy._setTestPrivateForTest(['127.0.0.1']);
    netPolicy._setReservedForTest(['10.8.0.0/24']);
    hostApi._udpTargets = ['127.0.0.1'];
    try {
      r = await call('/discover', { ports: [6445] }).expect(200);
      assert.deepEqual(r.body.found, [{ address: '127.0.0.1', data: 'ac:probe' }]);
      r = await call('/discover', { ports: [53] }).expect(502);
      assert.equal(r.body.code, 'ERR_NET_DENIED');
    } finally { netPolicy._setTestPrivateForTest(null); hostApi._udpTargets = null; sock.close(); }
  });
  it('wipe removes the assignments, keep leaves them', async () => {
    await agent.post(API + '/hello/uninstall').set('X-CSRF-Token', csrf).send({ mode: 'keep' }).expect(200);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM plugin_targets WHERE plugin_id = 'hello'").get().n > 0);
    const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(helloPackage()).expect(200);
    await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    await agent.post(API + '/hello/uninstall').set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Hallo Welt' }).expect(200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plugin_targets WHERE plugin_id = 'hello'").get().n, 0);
  });
});
