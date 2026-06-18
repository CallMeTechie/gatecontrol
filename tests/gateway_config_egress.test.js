'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwcfg-egress-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb, getGatewayConfig, gwPeerId, sibPeerId, routeId;

before(async () => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
  getGatewayConfig = require('../src/services/gateways').getGatewayConfig;

  const gateways = require('../src/services/gateways');
  const license = require('../src/services/license');
  license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

  // Create two gateway peers
  const gw = await gateways.createGateway({ name: 'egress-gw', apiPort: 9876 });
  gwPeerId = gw.peer.id;
  const sib = await gateways.createGateway({ name: 'egress-sib', apiPort: 9877 });
  sibPeerId = sib.peer.id;

  const db = getDb();

  // Set sibling LAN IP in gateway_meta
  db.prepare("UPDATE gateway_meta SET lan_ip = '192.168.2.151' WHERE peer_id = ?").run(sibPeerId);

  // Set near-gateway LAN subnets in last_health (needed if validate() is ever called;
  // not required for resolveForPeer itself, but good hygiene)
  db.prepare("UPDATE gateway_meta SET lan_ip = '192.168.2.228', last_health = ? WHERE peer_id = ?")
    .run(JSON.stringify({ telemetry: { lan_ip: '192.168.2.228', lan_subnets: [{ cidr: '192.168.2.0/24' }] } }), gwPeerId);

  // Insert both gateways into a pool (failback_cooldown_s is NOT NULL with no default)
  const poolId = db.prepare("INSERT INTO gateway_pools (name, failback_cooldown_s) VALUES ('egress-pool', 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO gateway_pool_members (pool_id, peer_id) VALUES (?, ?)").run(poolId, gwPeerId);
  db.prepare("INSERT INTO gateway_pool_members (pool_id, peer_id) VALUES (?, ?)").run(poolId, sibPeerId);

  // Insert an internal L4 route for the near gateway (external_enabled=0)
  routeId = db.prepare(`
    INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol,
                        l4_listen_port, l4_tls_mode, target_kind, target_peer_id,
                        target_lan_host, target_lan_port, enabled, external_enabled)
    VALUES ('printer-l4.example.com', '127.0.0.1', 41445, 'l4', 'tcp',
            '41445', 'none', 'gateway', ?, '192.168.2.228', 41445, 1, 0)
  `).run(gwPeerId).lastInsertRowid;

  // Insert an egress_routes entry
  db.prepare(`
    INSERT INTO egress_routes (name, near_peer_id, vip_ip, vip_prefix, lan_listen_port,
                               target_route_id, allowed_source_ips, enabled)
    VALUES ('printer', ?, '192.168.2.250', 24, 14450, ?, '["192.168.2.45/32"]', 1)
  `).run(gwPeerId, routeId);
});

describe('getGatewayConfig: egress_routes', () => {
  it('includes egress_routes array in gateway config', () => {
    const cfg = getGatewayConfig(gwPeerId);
    assert.ok(Array.isArray(cfg.egress_routes), 'egress_routes must be an array');
  });

  it('resolves egress route with tunnel_target_host and tunnel_target_port', () => {
    const cfg = getGatewayConfig(gwPeerId);
    assert.equal(cfg.egress_routes.length, 1);
    const er = cfg.egress_routes[0];
    assert.ok(typeof er.tunnel_target_host === 'string' && er.tunnel_target_host.length > 0,
      'tunnel_target_host must be a non-empty string');
    assert.equal(er.tunnel_target_port, 41445);
    assert.equal(typeof er.tunnel_target_port, 'number');
  });

  it('resolves egress route with vip_ip', () => {
    const cfg = getGatewayConfig(gwPeerId);
    const er = cfg.egress_routes[0];
    assert.equal(er.vip_ip, '192.168.2.250');
  });

  it('resolves egress route near_peers from pool sibling LAN IPs', () => {
    const cfg = getGatewayConfig(gwPeerId);
    const er = cfg.egress_routes[0];
    assert.ok(Array.isArray(er.near_peers), 'near_peers must be an array');
    assert.ok(er.near_peers.includes('192.168.2.151'),
      `near_peers should contain sibling LAN IP, got ${JSON.stringify(er.near_peers)}`);
  });

  it('returns empty egress_routes for a gateway with no egress entries', () => {
    const cfg = getGatewayConfig(sibPeerId);
    assert.ok(Array.isArray(cfg.egress_routes));
    assert.equal(cfg.egress_routes.length, 0);
  });
});
