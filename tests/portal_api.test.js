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

// Home vhost host header (matches default GC_DNS_DOMAIN = 'gc.internal').
const HOME_HOST = 'home.gc.internal';

test('GET /api/v1/portal/device returns the calling peer (via reserved header)', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  // supertest connects from loopback (like Caddy); the reserved header carries the peer IP.
  // Host must match home.<domain> for identity to be established (anti-forgery gate).
  const res = await supertest(app).get('/api/v1/portal/device')
    .set('X-GC-Portal-Peer-IP', '10.8.0.5')
    .set('Host', HOME_HOST)
    .expect(200);
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

test('non-home Host with reserved header does NOT establish identity (mgmt-vhost forgery blocked)', async () => {
  // Regression: attacker reaches the management-UI Caddy vhost (externally reachable)
  // and supplies the reserved header — identity must be rejected because Host is wrong.
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  const res = await supertest(app).get('/api/v1/portal/device')
    .set('X-GC-Portal-Peer-IP', '10.8.0.5')
    .set('Host', 'admin.example.com')
    .expect(200);
  assert.equal(res.body.data, null, 'must be unidentified — mgmt-vhost Host rejected');
  assert.equal(res.body.reason, 'unidentified');
});

test('portal API returns 404 when portal master switch is off', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  require('../src/services/settings').set('portal.enabled', '0');
  await supertest(app).get('/api/v1/portal/device')
    .set('X-GC-Portal-Peer-IP', '10.8.0.5')
    .set('Host', HOME_HOST)
    .expect(404);
});

test('portal API returns 404 for a disabled widget, 200 for an enabled one', async () => {
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
                   VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  require('../src/services/settings').set('portal.widget.traffic', '0');

  // /traffic disabled → 404
  await supertest(app).get('/api/v1/portal/traffic')
    .set('X-GC-Portal-Peer-IP', '10.8.0.5')
    .set('Host', HOME_HOST)
    .expect(404);

  // /device still enabled → 200
  const res = await supertest(app).get('/api/v1/portal/device')
    .set('X-GC-Portal-Peer-IP', '10.8.0.5')
    .set('Host', HOME_HOST)
    .expect(200);
  assert.equal(res.body.ok, true);
});

test('GET /api/v1/portal/traffic returns period buckets for the calling peer', async () => {
  const db = getDb();
  const { lastInsertRowid: peerId } = db.prepare(
    `INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, total_rx, total_tx)
     VALUES ('bob','k2','10.8.0.6/32',1,'regular',500,300)`
  ).run();

  // Insert snapshots: two in the last 24 h, one older (3 days back)
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
     VALUES (?,400,150,datetime('now','-3 days','-1 hour'))`
  ).run(peerId);

  const res = await supertest(app).get('/api/v1/portal/traffic')
    .set('X-GC-Portal-Peer-IP', '10.8.0.6')
    .set('Host', HOME_HOST)
    .expect(200);

  assert.equal(res.body.ok, true);
  const d = res.body.data;

  // ── Period totals (existing assertions) ──────────────────────────────────
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

  // ── Time-series assertions (new) ─────────────────────────────────────────
  const s = d.series;
  assert.ok(s, 'series field present');

  // Shape: correct bucket counts
  assert.ok(Array.isArray(s['24h']), 'series.24h is array');
  assert.equal(s['24h'].length, 8,  '24h has 8 buckets (8 x 3h)');
  assert.equal(s['7d'].length,  7,  '7d has 7 buckets (7 x 1d)');
  assert.equal(s['30d'].length, 5,  '30d has 5 buckets (5 x 6d)');

  // Each bucket has {t, rx, tx}
  const sample = s['24h'][0];
  assert.equal(typeof sample.t,  'string', 'bucket.t is string');
  assert.equal(typeof sample.rx, 'number', 'bucket.rx is number');
  assert.equal(typeof sample.tx, 'number', 'bucket.tx is number');

  // 24h: last bucket (index 7 = now-3h..now) must contain the -1h and -2h snapshots
  assert.equal(s['24h'][7].rx, 300, '24h last bucket rx = 100+200');
  assert.equal(s['24h'][7].tx, 130, '24h last bucket tx = 50+80');

  // 24h: all other buckets are zero (no older data in 24h window)
  const other24h = s['24h'].slice(0, 7);
  assert.ok(other24h.every(b => b.rx === 0), '24h buckets 0-6 all rx=0');
  assert.ok(other24h.every(b => b.tx === 0), '24h buckets 0-6 all tx=0');

  // 7d: last bucket (index 6 = now-1d..now) contains the -1h and -2h snapshots
  assert.equal(s['7d'][6].rx, 300, '7d last-day bucket rx');
  assert.equal(s['7d'][6].tx, 130, '7d last-day bucket tx');

  // 7d: the -3d-1h snapshot falls unambiguously in bucket 3 ([now-4d, now-3d)).
  // Seeding with an extra -1 hour ensures it never straddles the now-3d boundary
  // regardless of sub-second timing between insert and handler execution.
  const bucket3dIdx = s['7d'].findIndex(b => b.rx === 400);
  assert.equal(bucket3dIdx, 3, '7d: -3d-1h snapshot is in bucket 3 (now-4d..now-3d)');
  assert.equal(s['7d'][bucket3dIdx].tx, 150, '7d -3d snapshot bucket tx');

  // 30d: last bucket (index 4 = now-6d..now) contains all three snapshots
  // (-1h, -2h, and -3d are all well within the last 6 days)
  assert.equal(s['30d'][4].rx, 700, '30d last bucket rx = 100+200+400');
  assert.equal(s['30d'][4].tx, 280, '30d last bucket tx = 50+80+150');

  // 30d: first 4 buckets are zero (all data is within last 6 days)
  const other30d = s['30d'].slice(0, 4);
  assert.ok(other30d.every(b => b.rx === 0), '30d buckets 0-3 all rx=0');
  assert.ok(other30d.every(b => b.tx === 0), '30d buckets 0-3 all tx=0');
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
    .set('X-GC-Portal-Peer-IP', '10.8.0.7')
    .set('Host', HOME_HOST)
    .expect(200);

  assert.equal(res.body.ok, true);
  const domains = res.body.data.map(s => s.domain);
  const domainSet = new Set(domains);
  assert.ok(domainSet.has('open.example.com'), 'open route visible');
  assert.ok(domainSet.has('acl.example.com'), 'ACL route visible when peer is member');
  assert.ok(!domainSet.has('hidden.example.com'), 'ACL route NOT visible when peer is not member');
  assert.ok(!domainSet.has('disabled.example.com'), 'disabled route not visible');
  assert.ok(!domainSet.has('l4.example.com'), 'L4 route NOT visible (excluded by route_type filter)');

  // Each item has required shape
  const open = res.body.data.find(s => s.domain === 'open.example.com');
  assert.equal(open.kind, 'http');
  assert.ok(open.id);
  assert.equal(open.name, 'Open App');
});
