'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwcfg-l4-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb, getGatewayConfig;
before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
  getGatewayConfig = require('../src/services/gateways').getGatewayConfig;
});

// push_token_encrypted is NOT NULL with no default (migrationList.js gateway_meta
// CREATE) — supply a dummy literal or the INSERT throws before any assertion runs.
function seed({ homeLanIp }) {
  const db = getDb();
  const insPeer = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
                              VALUES (?, ?, ?, 'gateway', 1)`);
  const home = insPeer.run('home', crypto.randomBytes(16).toString('hex'), '10.8.0.2/32').lastInsertRowid;
  const sib  = insPeer.run('sib',  crypto.randomBytes(16).toString('hex'), '10.8.0.3/32').lastInsertRowid;
  const insMeta = db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, proxy_port, api_token_hash, push_token_encrypted, created_at, lan_ip)
                              VALUES (?, 8088, 8080, ?, 'enc', datetime('now'), ?)`);
  insMeta.run(home, 'x'.repeat(64), homeLanIp);
  insMeta.run(sib, 'y'.repeat(64), null);
  return { home, sib };
}

let _domainSeq = 0;
function insL4FailedOver(targetPeerId, originalPeerId) {
  // routes.domain is globally UNIQUE and the DB is shared across the cases in
  // this file — vary the domain per insert so seeding a second case does not
  // collide on the prior route.
  const domain = `ssh${_domainSeq++}.example.com`;
  return getDb().prepare(`INSERT INTO routes
    (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
     target_kind, target_peer_id, original_peer_id, target_lan_host, target_lan_port, enabled)
    VALUES (?,'127.0.0.1',2222,'l4','tcp','2222','none',
            'gateway', ?, ?, '127.0.0.1', 22, 1)`).run(domain, targetPeerId, originalPeerId).lastInsertRowid;
}

describe('getGatewayConfig: L4 loopback resolution', () => {
  it('failed-over L4 loopback → home LAN IP in the sibling config', () => {
    const { home, sib } = seed({ homeLanIp: '192.168.2.228' });
    insL4FailedOver(sib, home);
    const cfg = getGatewayConfig(sib);
    assert.equal(cfg.l4_routes.length, 1);
    assert.equal(cfg.l4_routes[0].target_lan_host, '192.168.2.228');
    assert.equal(cfg.l4_routes[0].target_lan_port, 22);
  });
  it('failed-over L4 loopback + unknown home LAN IP → listener omitted', () => {
    const { home, sib } = seed({ homeLanIp: null });
    insL4FailedOver(sib, home);
    const cfg = getGatewayConfig(sib);
    assert.equal(cfg.l4_routes.length, 0);
  });
  it('home serving (original_peer_id NULL) keeps 127.0.0.1', () => {
    const { home } = seed({ homeLanIp: '192.168.2.228' });
    getDb().prepare(`INSERT INTO routes
      (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
       target_kind, target_peer_id, original_peer_id, target_lan_host, target_lan_port, enabled)
      VALUES ('ssh2.example.com','127.0.0.1',2222,'l4','tcp','2222','none',
              'gateway', ?, NULL, '127.0.0.1', 22, 1)`).run(home);
    const cfg = getGatewayConfig(home);
    assert.equal(cfg.l4_routes.length, 1);
    assert.equal(cfg.l4_routes[0].target_lan_host, '127.0.0.1');
  });
});
