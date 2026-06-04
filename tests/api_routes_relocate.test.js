'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
});
afterEach(teardown);

function POST(path, body) {
  return agent.post(path).set('X-CSRF-Token', csrf).send(body);
}

test('POST /api/v1/routes/relocate repins routes to the target gateway, clears pool + original, sets new LAN target', async () => {
  const db = require('../src/db/connection').getDb();
  // Source gateway the route currently lives on (FK targets for
  // target_peer_id + original_peer_id must reference a real peer row).
  const oldgw = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
    VALUES ('oldgw', ?, '10.8.0.8/32', 'gateway', 1)`)
    .run(require('crypto').randomBytes(16).toString('hex')).lastInsertRowid;
  const gw = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
    VALUES ('newgw', ?, '10.8.0.9/32', 'gateway', 1)`)
    .run(require('crypto').randomBytes(16).toString('hex')).lastInsertRowid;
  const rid = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind,
    target_peer_id, original_peer_id, target_pool_id, target_lan_host, target_lan_port, enabled)
    VALUES ('move.example.com','127.0.0.1',8080,'http','gateway', ?, ?, NULL, '127.0.0.1', 8096, 1)`)
    .run(oldgw, oldgw).lastInsertRowid;

  const res = await POST('/api/v1/routes/relocate', {
    target_peer_id: gw,
    items: [{ id: rid, target_lan_host: '192.168.5.10', target_lan_port: 8096 }],
  });
  assert.equal(res.status, 200);

  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(rid);
  assert.equal(row.target_peer_id, gw);
  assert.equal(row.target_pool_id, null);
  assert.equal(row.original_peer_id, null);
  assert.equal(row.target_lan_host, '192.168.5.10');
  assert.equal(row.target_lan_port, 8096);
});

test('POST /api/v1/routes/relocate rejects a non-gateway target_peer_id', async () => {
  const res = await POST('/api/v1/routes/relocate', {
    target_peer_id: 999999,
    items: [{ id: 1, target_lan_host: '192.168.5.10', target_lan_port: 80 }],
  });
  assert.equal(res.status, 400);
});

test('POST /api/v1/routes/relocate rejects an invalid target_lan_host (bad octets)', async () => {
  const db = require('../src/db/connection').getDb();
  const gw = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
    VALUES ('newgw', ?, '10.8.0.9/32', 'gateway', 1)`)
    .run(require('crypto').randomBytes(16).toString('hex')).lastInsertRowid;
  const rid = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind,
    target_peer_id, original_peer_id, target_pool_id, target_lan_host, target_lan_port, enabled)
    VALUES ('badhost.example.com','127.0.0.1',8080,'http','gateway', ?, ?, NULL, '127.0.0.1', 8096, 1)`)
    .run(gw, gw).lastInsertRowid;

  const res = await POST('/api/v1/routes/relocate', {
    target_peer_id: gw,
    items: [{ id: rid, target_lan_host: '999.1.2.3', target_lan_port: 80 }],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'target_lan_host_invalid');
});

test('POST /api/v1/routes/relocate rejects an invalid target_lan_port', async () => {
  const db = require('../src/db/connection').getDb();
  const gw = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
    VALUES ('newgw', ?, '10.8.0.9/32', 'gateway', 1)`)
    .run(require('crypto').randomBytes(16).toString('hex')).lastInsertRowid;
  const rid = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind,
    target_peer_id, original_peer_id, target_pool_id, target_lan_host, target_lan_port, enabled)
    VALUES ('badport.example.com','127.0.0.1',8080,'http','gateway', ?, ?, NULL, '127.0.0.1', 8096, 1)`)
    .run(gw, gw).lastInsertRowid;

  const res = await POST('/api/v1/routes/relocate', {
    target_peer_id: gw,
    items: [{ id: rid, target_lan_host: '192.168.5.10', target_lan_port: 0 }],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'target_lan_port_invalid');
});

test('POST /api/v1/routes/relocate leaves a non-gateway route untouched (moved=0)', async () => {
  const db = require('../src/db/connection').getDb();
  const gw = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
    VALUES ('newgw', ?, '10.8.0.9/32', 'gateway', 1)`)
    .run(require('crypto').randomBytes(16).toString('hex')).lastInsertRowid;
  const peer = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
    VALUES ('plainpeer', ?, '10.8.0.20/32', 'peer', 1)`)
    .run(require('crypto').randomBytes(16).toString('hex')).lastInsertRowid;
  // A non-gateway route (target_kind 'peer', the schema default). The UPDATE in
  // the handler is scoped to target_kind='gateway', so this row must not move.
  const rid = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind,
    target_peer_id, original_peer_id, target_pool_id, target_lan_host, target_lan_port, enabled)
    VALUES ('peer.example.com','127.0.0.1',8080,'http','peer', ?, NULL, NULL, '192.168.1.5', 8080, 1)`)
    .run(peer).lastInsertRowid;

  const res = await POST('/api/v1/routes/relocate', {
    target_peer_id: gw,
    items: [{ id: rid, target_lan_host: '192.168.5.10', target_lan_port: 8096 }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 0);

  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(rid);
  assert.equal(row.target_peer_id, peer);
  assert.equal(row.target_lan_host, '192.168.1.5');
});
