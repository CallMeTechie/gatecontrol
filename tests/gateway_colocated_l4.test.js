'use strict';

// A gateway on the server's own host (both network_mode: host on one NAS):
// its tunnel IP is an address of this host, Caddy's L4 listener holds the
// port there. Caddy must dial the LAN target itself — never
// <gateway tunnel IP>:<listen port> (that is Caddy's own listener) — and the
// gateway gets no listener for these routes (services/gatewayColocation.js).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let caddyConfig, gatewayPool, gatewayHealth, gateways, colocation, getDb;

// The host's interfaces: lo, the LAN and the gateway's WireGuard interface
// (gatecontrol0) with the tunnel IP of gateway 10.
function hostWith(...ips) {
  return () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4' }],
    eth0: [{ address: '192.168.1.10', family: 'IPv4' }],
    gatecontrol0: ips.map((address) => ({ address, family: 'IPv4' })),
  });
}

beforeEach(async () => {
  await setup();
  caddyConfig = require('../src/services/caddyConfig');
  gatewayPool = require('../src/services/gatewayPool');
  gatewayHealth = require('../src/services/gatewayHealth');
  gateways = require('../src/services/gateways');
  colocation = require('../src/services/gatewayColocation');
  getDb = require('../src/db/connection').getDb;
  gatewayHealth._resetSnapshotCache();
});
afterEach(async () => {
  colocation._setInterfacesForTest(null);
  colocation.noteBuilt(null);
  await teardown();
});

function addGateway(id, ip) {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, 'gw-' + id, 'pk' + id, ip + '/32');
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at) VALUES (?, 9876, 'h', 'e', ?, 1, strftime('%s','now')*1000)")
    .run(id, Date.now());
}

function addL4Route({ peerId = null, poolId = null, lanHost = '192.168.1.20', lanPort = 22, listen = '2222', domain = 'ssh.example.com' }) {
  return getDb().prepare(`
    INSERT INTO routes (domain, target_kind, target_peer_id, target_pool_id, target_lan_host, target_lan_port,
                        target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode, enabled)
    VALUES (?, 'gateway', ?, ?, ?, ?, '127.0.0.1', ?, 'l4', 'tcp', ?, 'none', 1)
  `).run(domain, peerId, poolId, lanHost, lanPort, lanPort, listen).lastInsertRowid;
}

const dialsOf = (cfg) => {
  const servers = (cfg.apps.layer4 && cfg.apps.layer4.servers) || {};
  const out = [];
  for (const s of Object.values(servers)) {
    for (const r of s.routes) {
      for (const h of r.handle || []) {
        if (h.handler === 'proxy') for (const u of h.upstreams) out.push(...u.dial);
      }
    }
  }
  return out;
};

test('gateway elsewhere: Caddy dials <tunnel IP>:<listen port> as before', async () => {
  colocation._setInterfacesForTest(hostWith());
  addGateway(10, '10.8.0.10');
  addL4Route({ peerId: 10 });
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  assert.deepEqual(dialsOf(cfg), ['10.8.0.10:2222']);
  assert.equal(gateways.getGatewayConfig(10).l4_routes.length, 1);
});

test('gateway on this host: Caddy dials the LAN target itself, never its own listener', async () => {
  colocation._setInterfacesForTest(hostWith('10.8.0.10'));
  addGateway(10, '10.8.0.10');
  addL4Route({ peerId: 10 });
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  assert.deepEqual(dialsOf(cfg), ['192.168.1.20:22']);
  assert.deepEqual(cfg.apps.layer4.servers['l4-tcp-2222'].listen, ['tcp/:2222']);
});

test('gateway on this host: no listener in its config (Caddy holds the port)', () => {
  colocation._setInterfacesForTest(hostWith('10.8.0.10'));
  addGateway(10, '10.8.0.10');
  addL4Route({ peerId: 10 });
  const cfg = gateways.getGatewayConfig(10);
  assert.deepEqual(cfg.l4_routes, []);
});

test('gateway on this host, loopback target: the host itself (127.0.0.1)', async () => {
  colocation._setInterfacesForTest(hostWith('10.8.0.10'));
  addGateway(10, '10.8.0.10');
  addL4Route({ peerId: 10, lanHost: '127.0.0.1', lanPort: 22 });
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  assert.deepEqual(dialsOf(cfg), ['127.0.0.1:22']);
});

test('gateway on this host, loopback target on a port of the server itself: listener left out', async () => {
  colocation._setInterfacesForTest(hostWith('10.8.0.10'));
  addGateway(10, '10.8.0.10');
  addL4Route({ peerId: 10, lanHost: '127.0.0.1', lanPort: 2019 });
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  assert.deepEqual(dialsOf(cfg), []);
});

test('pool: the member on this host is dialled directly, the other one through its tunnel IP', async () => {
  colocation._setInterfacesForTest(hostWith('10.8.0.10'));
  addGateway(10, '10.8.0.10');
  addGateway(11, '10.8.0.11');
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'load_balancing', lb_policy: 'round_robin', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 10, 100);
  gatewayPool.addMember(poolId, 11, 200);
  addL4Route({ poolId });
  gatewayHealth.evaluatePeer(10);
  gatewayHealth.evaluatePeer(11);
  const cfg = await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  assert.deepEqual(dialsOf(cfg).sort(), ['10.8.0.11:2222', '192.168.1.20:22']);
});

test('directL4Target: loopback of another (home) gateway → its LAN IP, unknown → null', () => {
  const route = { target_lan_host: '127.0.0.1', target_lan_port: 22, target_peer_id: 11, original_peer_id: 10, home_lan_ip: '192.168.2.5' };
  assert.equal(colocation.directL4Target(route, 11), '192.168.2.5:22');
  assert.equal(colocation.directL4Target({ ...route, home_lan_ip: null }, 11), null);
  assert.equal(colocation.directL4Target({ target_lan_host: 'fd00::5', target_lan_port: 22 }, 10), '[fd00::5]:22');
  assert.equal(colocation.directL4Target({ target_lan_host: '', target_lan_port: 22 }, 10), null);
});

test('isColocatedTunnelIp: only an address of this host counts, loopback never', () => {
  colocation._setInterfacesForTest(hostWith('10.8.0.10'));
  assert.equal(colocation.isColocatedTunnelIp('10.8.0.10/32'), true);
  assert.equal(colocation.isColocatedTunnelIp('10.8.0.11/32'), false);
  assert.equal(colocation.isColocatedTunnelIp('127.0.0.1'), false);
  assert.equal(colocation.isColocatedTunnelIp(''), false);
  colocation._setInterfacesForTest(() => { throw new Error('no scan'); });
  assert.equal(colocation.isColocatedTunnelIp('10.8.0.10'), false);
});

test('changedSinceBuild: the gateway on this host came up after the last Caddy config → true until rebuilt', async () => {
  colocation._setInterfacesForTest(hostWith());
  addGateway(10, '10.8.0.10');
  addL4Route({ peerId: 10 });
  await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  assert.equal(colocation.changedSinceBuild('10.8.0.10/32'), false);
  colocation._setInterfacesForTest(hostWith('10.8.0.10'));
  assert.equal(colocation.changedSinceBuild('10.8.0.10/32'), true);
  assert.equal(colocation.changedSinceBuild('10.8.0.99/32'), false, 'a gateway without an L4 route in the config');
  await caddyConfig.buildCaddyConfig({ gatewayProxyPort: 8080 });
  assert.equal(colocation.changedSinceBuild('10.8.0.10/32'), false);
});
