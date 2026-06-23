'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, getDb;
beforeEach(async () => {
  await setup();
  getDb = require('../src/db/connection').getDb;
  app = require('../src/app').createApp();
});
afterEach(teardown);

test('GET /api/v1/portal/device returns the calling peer (via reserved header)', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  // supertest connects from loopback (like Caddy); the reserved header carries the peer IP.
  const res = await supertest(app).get('/api/v1/portal/device')
    .set('X-GC-Portal-Peer-IP', '10.8.0.5').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.name, 'alice');
});

test('a generic X-Forwarded-For does NOT establish identity (only the reserved header does)', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  const res = await supertest(app).get('/api/v1/portal/device')
    .set('X-Forwarded-For', '10.8.0.5').expect(200);
  assert.equal(res.body.data, null);
  assert.equal(res.body.reason, 'unidentified');
});

test('portal endpoints never require a token and never 500 on unknown IP', async () => {
  const res = await supertest(app).get('/api/v1/portal/device')
    .set('X-GC-Portal-Peer-IP', '10.8.0.250').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data, null);
  assert.equal(res.body.reason, 'unidentified');
});

test('GET /api/v1/portal/traffic returns period buckets for the calling peer', async () => {
  const db = getDb();
  const { lastInsertRowid: peerId } = db.prepare(
    `INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, total_rx, total_tx)
     VALUES ('bob','k2','10.8.0.6/32',1,'regular',500,300)`
  ).run();

  // Insert snapshots: two in the last 24 h, one older (7d)
  db.prepare(
    `INSERT INTO peer_traffic_snapshots (peer_id, download_bytes, upload_bytes, recorded_at)
     VALUES (?,100,50,datetime('now','-1 hours'))`
  ).run(peerId);
  db.prepare(
    `INSERT INTO peer_traffic_snapshots (peer_id, download_bytes, upload_bytes, recorded_at)
     VALUES (?,200,80,datetime('now','-2 hours'))`
  ).run(peerId);
  db.prepare(
    `INSERT INTO peer_traffic_snapshots (peer_id, download_bytes, upload_bytes, recorded_at)
     VALUES (?,400,150,datetime('now','-3 days'))`
  ).run(peerId);

  const res = await supertest(app).get('/api/v1/portal/traffic')
    .set('X-GC-Portal-Peer-IP', '10.8.0.6').expect(200);

  assert.equal(res.body.ok, true);
  const d = res.body.data;
  // Total comes from peers.total_rx / total_tx
  assert.equal(d.total.rx, 500);
  assert.equal(d.total.tx, 300);
  // last24h: only the two recent rows
  assert.equal(d.last24h.rx, 300);  // 100 + 200
  assert.equal(d.last24h.tx, 130);  // 50 + 80
  // last7d: all three rows
  assert.equal(d.last7d.rx, 700);   // 100 + 200 + 400
  assert.equal(d.last7d.tx, 280);   // 50 + 80 + 150
  // last30d: all three rows
  assert.equal(d.last30d.rx, 700);
  assert.equal(d.last30d.tx, 280);
});

test('GET /api/v1/portal/services returns only visible routes for the calling peer', async () => {
  const db = getDb();
  const { lastInsertRowid: peerId } = db.prepare(
    `INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
     VALUES ('carol','k3','10.8.0.7/32',1,'regular')`
  ).run();

  // Open route (no ACL) — should be visible
  db.prepare(
    `INSERT INTO routes (domain, description, target_ip, target_port, enabled, acl_enabled)
     VALUES ('open.example.com','Open App','10.0.0.1',80,1,0)`
  ).run();

  // ACL-restricted route: carol IS on the ACL — should be visible
  const { lastInsertRowid: aclRouteId } = db.prepare(
    `INSERT INTO routes (domain, description, target_ip, target_port, enabled, acl_enabled)
     VALUES ('acl.example.com','Restricted App','10.0.0.2',80,1,1)`
  ).run();
  db.prepare(
    `INSERT INTO route_peer_acl (route_id, peer_id) VALUES (?,?)`
  ).run(aclRouteId, peerId);

  // ACL-restricted route: carol is NOT on the ACL — should NOT be visible
  const { lastInsertRowid: hiddenRouteId } = db.prepare(
    `INSERT INTO routes (domain, description, target_ip, target_port, enabled, acl_enabled)
     VALUES ('hidden.example.com','Hidden App','10.0.0.3',80,1,1)`
  ).run();
  // Insert some OTHER peer on the hidden route ACL
  const { lastInsertRowid: otherId } = db.prepare(
    `INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
     VALUES ('dave','k4','10.8.0.8/32',1,'regular')`
  ).run();
  db.prepare(
    `INSERT INTO route_peer_acl (route_id, peer_id) VALUES (?,?)`
  ).run(hiddenRouteId, otherId);

  // Disabled route — should NOT be visible
  db.prepare(
    `INSERT INTO routes (domain, description, target_ip, target_port, enabled, acl_enabled)
     VALUES ('disabled.example.com','Disabled App','10.0.0.4',80,0,0)`
  ).run();

  // Enabled L4 route (open ACL) — should NOT be visible (route_type filter)
  db.prepare(
    `INSERT INTO routes (domain, description, target_ip, target_port, enabled, acl_enabled, route_type)
     VALUES ('l4.example.com','L4 App','10.0.0.5',443,1,0,'l4')`
  ).run();

  const res = await supertest(app).get('/api/v1/portal/services')
    .set('X-GC-Portal-Peer-IP', '10.8.0.7').expect(200);

  assert.equal(res.body.ok, true);
  const domains = res.body.data.map(s => s.domain);
  assert.ok(domains.includes('open.example.com'), 'open route visible');
  assert.ok(domains.includes('acl.example.com'), 'ACL route visible when peer is member');
  assert.ok(!domains.includes('hidden.example.com'), 'ACL route NOT visible when peer is not member');
  assert.ok(!domains.includes('disabled.example.com'), 'disabled route not visible');
  assert.ok(!domains.includes('l4.example.com'), 'L4 route NOT visible (excluded by route_type filter)');

  // Each item has required shape
  const open = res.body.data.find(s => s.domain === 'open.example.com');
  assert.equal(open.kind, 'http');
  assert.ok(open.id);
  assert.equal(open.name, 'Open App');
});
