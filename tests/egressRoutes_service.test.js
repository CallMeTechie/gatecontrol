'use strict';
// config/default.js throws if GC_SECRET is missing — set before any require
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const svc = require('../src/services/egressRoutes');

function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE routes (id INTEGER PRIMARY KEY, route_type TEXT, target_kind TEXT, external_enabled INTEGER, l4_listen_port INTEGER, target_peer_id INTEGER, target_pool_id INTEGER);
    CREATE TABLE gateway_pool_members (pool_id INTEGER, peer_id INTEGER);
    CREATE TABLE gateway_meta (peer_id INTEGER, last_health TEXT, lan_ip TEXT);
    CREATE TABLE egress_routes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, device_id INTEGER, near_peer_id INTEGER, near_pool_id INTEGER, vip_ip TEXT, vip_prefix INTEGER, lan_listen_port INTEGER, target_route_id INTEGER, allowed_source_ips TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT);
  `);
  db.prepare("INSERT INTO routes VALUES (41,'l4','gateway',0,41445,79,NULL)").run(); // valid target
  db.prepare("INSERT INTO routes VALUES (42,'l4','gateway',1,9999,79,NULL)").run();  // external -> invalid
  db.prepare("INSERT INTO gateway_pool_members VALUES (1,79),(1,84)").run();
  db.prepare("INSERT INTO gateway_meta VALUES (79,'{\"telemetry\":{\"lan_ip\":\"192.168.2.228\",\"lan_subnets\":[{\"cidr\":\"192.168.2.0/24\"}]}}','192.168.2.228')").run();
  db.prepare("INSERT INTO gateway_meta VALUES (84,'{\"telemetry\":{\"lan_ip\":\"192.168.2.151\"}}','192.168.2.151')").run();
  return db;
}

test('validate rejects an external/non-l4 target route', () => {
  const db = seed();
  assert.throws(() => svc.validate({ target_route_id: 42, near_peer_id: 79, vip_ip: '192.168.2.250', lan_listen_port: 14450, allowed_source_ips: ['192.168.2.45/32'] }, db));
});

test('validate rejects a vip outside the near gateway lan_subnets', () => {
  const db = seed();
  assert.throws(() => svc.validate({ target_route_id: 41, near_peer_id: 79, vip_ip: '10.0.0.5', lan_listen_port: 14450, allowed_source_ips: ['192.168.2.45/32'] }, db));
});

test('resolveForPeer excludes egress routes whose target route is external (fail-closed)', () => {
  const db = seed();
  // route 42 has external_enabled=1 — the JOIN should filter it out even though the egress_route is enabled
  db.prepare("INSERT INTO egress_routes (name,near_peer_id,vip_ip,vip_prefix,lan_listen_port,target_route_id,allowed_source_ips,enabled) VALUES ('external-printer',79,'192.168.2.251',24,14451,42,'[]',1)").run();
  const out = svc.resolveForPeer(79, db, { hubIp: '10.8.0.1' });
  assert.equal(out.length, 0, 'resolveForPeer must return empty when only egress route targets an external route');
});

test('resolveForPeer builds hub-target + near_peers', () => {
  const db = seed();
  db.prepare("INSERT INTO egress_routes (name,near_peer_id,vip_ip,vip_prefix,lan_listen_port,target_route_id,allowed_source_ips,enabled) VALUES ('printer',79,'192.168.2.250',24,14450,41,'[\"192.168.2.45/32\"]',1)").run();
  const out = svc.resolveForPeer(79, db, { hubIp: '10.8.0.1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].tunnel_target_host, '10.8.0.1');
  assert.equal(out[0].tunnel_target_port, 41445);   // from route 41 — must be a number, not a string
  assert.equal(typeof out[0].tunnel_target_port, 'number');
  assert.deepEqual(out[0].near_peers, ['192.168.2.151']); // sibling 84
  assert.equal(out[0].vip_ip, '192.168.2.250');
});
