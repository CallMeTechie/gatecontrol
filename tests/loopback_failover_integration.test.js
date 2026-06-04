'use strict';

// End-to-end loopback failover: drives the REAL failover machinery
// (reconcileFailoverState) from DB alive-state and asserts that the loopback
// target gets rewritten to the home gateway's LAN IP on pivot, then restored
// to 127.0.0.1 on failback — for BOTH the HTTP path (buildCaddyConfig) and the
// L4 path (getGatewayConfig). Unlike caddyConfig_loopback_failover.test.js,
// nothing here injects the post-pivot state by hand: the pivot is produced by
// the same function the boot reconciler / watchdog use.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-loop-int-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let db, buildCaddyConfig, getGatewayConfig, reconcileFailoverState, gatewayPool;
let HOME, SIB, HTTP_RID, L4_RID;

// Same X-Gateway-Target extractor as the unit test.
function gwTarget(config, domain) {
  const srv = config.apps.http.servers;
  for (const name of Object.keys(srv)) {
    for (const r of srv[name].routes) {
      const match = (r.match || []).some(m => (m.host || []).includes(domain));
      if (!match) continue;
      const rp = (r.handle || []).find(h => h.handler === 'reverse_proxy');
      if (rp && rp.headers && rp.headers.request && rp.headers.request.set) {
        const v = rp.headers.request.set['X-Gateway-Target'];
        if (v) return v[0];
      }
    }
  }
  return null;
}

function setAlive(peerId, alive) {
  db.prepare('UPDATE gateway_meta SET alive = ? WHERE peer_id = ?').run(alive ? 1 : 0, peerId);
}

before(() => {
  require('../src/db/migrations').runMigrations();
  db = require('../src/db/connection').getDb();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
  getGatewayConfig = require('../src/services/gateways').getGatewayConfig;
  reconcileFailoverState = require('../src/services/gatewayHealth').reconcileFailoverState;
  gatewayPool = require('../src/services/gatewayPool');

  const now = Math.floor(Date.now() / 1000);
  const mkPeer = (name, ips) => db.prepare(
    `INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
     VALUES (?, ?, ?, 'gateway', 1)`
  ).run(name, crypto.randomBytes(16).toString('hex'), ips).lastInsertRowid;

  HOME = mkPeer('HOME', '10.8.0.2/32');
  SIB = mkPeer('SIB', '10.8.0.3/32');

  // gateway_meta: api_token_hash + push_token_encrypted + created_at are NOT NULL.
  const mkMeta = (peerId, lanIp) => db.prepare(
    `INSERT INTO gateway_meta (peer_id, api_token_hash, push_token_encrypted, created_at, alive, lan_ip)
     VALUES (?, ?, 'enc', ?, 1, ?)`
  ).run(peerId, crypto.randomBytes(16).toString('hex'), now, lanIp);
  mkMeta(HOME, '192.168.2.228');
  mkMeta(SIB, null);

  // Pool with both members; HOME higher priority (lower number = higher).
  const poolId = gatewayPool.createPool({ name: 'p1', mode: 'failover', failback_cooldown_s: 0 });
  gatewayPool.addMember(poolId, HOME, 10);
  gatewayPool.addMember(poolId, SIB, 20);

  // HTTP gateway route pinned to HOME, loopback LAN target.
  HTTP_RID = db.prepare(
    `INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind,
       target_peer_id, original_peer_id, target_pool_id, target_lan_host, target_lan_port,
       enabled, https_enabled)
     VALUES ('jelly.example.com','127.0.0.1',8080,'http','gateway', ?, NULL, NULL,
       '127.0.0.1', 8096, 1, 1)`
  ).run(HOME).lastInsertRowid;

  // L4 gateway route pinned to HOME, loopback LAN target.
  L4_RID = db.prepare(
    `INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind,
       target_peer_id, original_peer_id, target_pool_id, target_lan_host, target_lan_port,
       l4_protocol, l4_listen_port, l4_tls_mode, enabled)
     VALUES (NULL,'127.0.0.1',22,'l4','gateway', ?, NULL, NULL,
       '127.0.0.1', 22, 'tcp', '2222', 'none', 1)`
  ).run(HOME).lastInsertRowid;
});

describe('loopback failover integration (real pivot → rewrite → failback)', () => {
  it('phase 1: HOME down → routes pivot to SIB and loopback rewrites to HOME LAN IP', async () => {
    setAlive(HOME, false);
    setAlive(SIB, true);

    await reconcileFailoverState();

    // Real pivot happened in the DB.
    const httpRow = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = ?').get(HTTP_RID);
    assert.equal(httpRow.target_peer_id, SIB, 'HTTP route now targets SIB');
    assert.equal(httpRow.original_peer_id, HOME, 'HTTP route remembers HOME as original');

    const l4Row = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = ?').get(L4_RID);
    assert.equal(l4Row.target_peer_id, SIB, 'L4 route now targets SIB');
    assert.equal(l4Row.original_peer_id, HOME, 'L4 route remembers HOME as original');

    // HTTP path: buildCaddyConfig rewrites 127.0.0.1 → HOME LAN IP.
    const cfg = buildCaddyConfig();
    assert.equal(gwTarget(cfg, 'jelly.example.com'), '192.168.2.228:8096');

    // L4 path: SIB's companion config rewrites the loopback to HOME LAN IP.
    const sibCfg = getGatewayConfig(SIB);
    assert.equal(sibCfg.l4_routes.length, 1);
    assert.equal(sibCfg.l4_routes[0].target_lan_host, '192.168.2.228');
  });

  it('phase 2: HOME recovers → routes fail back and loopback restores to 127.0.0.1', async () => {
    setAlive(HOME, true);

    await reconcileFailoverState();

    const httpRow = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = ?').get(HTTP_RID);
    assert.equal(httpRow.target_peer_id, HOME, 'HTTP route restored to HOME');
    assert.equal(httpRow.original_peer_id, null, 'HTTP route original cleared');

    const l4Row = db.prepare('SELECT target_peer_id, original_peer_id FROM routes WHERE id = ?').get(L4_RID);
    assert.equal(l4Row.target_peer_id, HOME, 'L4 route restored to HOME');
    assert.equal(l4Row.original_peer_id, null, 'L4 route original cleared');

    const cfg = buildCaddyConfig();
    assert.equal(gwTarget(cfg, 'jelly.example.com'), '127.0.0.1:8096');

    const homeCfg = getGatewayConfig(HOME);
    assert.equal(homeCfg.l4_routes.length, 1);
    assert.equal(homeCfg.l4_routes[0].target_lan_host, '127.0.0.1');
  });
});
