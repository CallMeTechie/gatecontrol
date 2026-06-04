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
