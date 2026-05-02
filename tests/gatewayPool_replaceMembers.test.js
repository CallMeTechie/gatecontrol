'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let gatewayPool, getDb, agent, csrf;
beforeEach(async () => {
  await setup();
  gatewayPool = require('../src/services/gatewayPool');
  getDb = require('../src/db/connection').getDb;
  agent = getAgent();
  csrf = getCsrf();
});
afterEach(teardown);

function insertGatewayPeer(db, id, name) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', '10.8.0.' || ? || '/32', 1)")
    .run(id, name || ('gw-' + id), 'pk' + id, id);
  // alive=0 keeps the peer in the offline branch of applyPoolMutationWithSequencing,
  // so it only calls syncToCaddy (which we stub) and skips the real companion push.
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, created_at) VALUES (?, 9876, 'h', 'e', 0, strftime('%s','now')*1000)")
    .run(id);
}

// ── Service layer ─────────────────────────────────────────────────────────

test('replaceMembers inserts members from empty', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  insertGatewayPeer(db, 2);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  const out = gatewayPool.replaceMembers(poolId, [
    { peer_id: 1, priority: 1 },
    { peer_id: 2, priority: 2 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].peer_id, 1);
  assert.equal(out[0].priority, 1);
});

test('replaceMembers diffs existing members (add + remove + reorder in one call)', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  insertGatewayPeer(db, 2);
  insertGatewayPeer(db, 3);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 1, 100);
  gatewayPool.addMember(poolId, 2, 200);

  // Replace: drop 1, keep 2 with new priority, add 3 at the top
  gatewayPool.replaceMembers(poolId, [
    { peer_id: 3, priority: 1 },
    { peer_id: 2, priority: 2 },
  ]);
  const members = gatewayPool.listMembers(poolId);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map(m => m.peer_id), [3, 2]);
  assert.deepEqual(members.map(m => m.priority), [1, 2]);
});

test('replaceMembers rejects non-gateway peer', () => {
  const db = getDb();
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (10, 'client', 'pk10', 'client', '10.8.0.10/32', 1)").run();
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  assert.throws(
    () => gatewayPool.replaceMembers(poolId, [{ peer_id: 10, priority: 1 }]),
    /peer_not_gateway/,
  );
});

test('replaceMembers rejects duplicate peer_id', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  assert.throws(
    () => gatewayPool.replaceMembers(poolId, [
      { peer_id: 1, priority: 1 },
      { peer_id: 1, priority: 2 },
    ]),
    /duplicate_peer/,
  );
});

test('replaceMembers([]) is allowed when pool is unreferenced', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 1, 1);
  gatewayPool.replaceMembers(poolId, []);
  assert.equal(gatewayPool.listMembers(poolId).length, 0);
});

test('replaceMembers([]) rejects when pool is referenced by routes', () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  const poolId = gatewayPool.createPool({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  gatewayPool.addMember(poolId, 1, 1);
  db.prepare(`
    INSERT INTO routes (domain, target_kind, target_pool_id, target_ip, target_port, route_type, enabled)
    VALUES ('x.test', 'gateway', ?, '0.0.0.0', 5000, 'http', 1)
  `).run(poolId);
  assert.throws(
    () => gatewayPool.replaceMembers(poolId, []),
    /last_member_in_use/,
  );
});

// ── HTTP layer ────────────────────────────────────────────────────────────

test('PUT /api/v1/gateway-pools/:id/members replaces full member list', async () => {
  // Stub syncToCaddy — real one tries to reach Caddy admin:2019.
  // Same pattern as routes_hook_notify.test.js.
  require('../src/services/caddyConfig').syncToCaddy = async () => {};

  const db = getDb();
  insertGatewayPeer(db, 1);
  insertGatewayPeer(db, 2);
  const create = await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  const poolId = create.body.id;

  // Wrap payload as {members:[...]} — the route accepts both raw arrays and
  // {members} envelopes, but supertest's auto-type detection on bare arrays
  // is flaky across versions, so the envelope form is the safe choice.
  const res = await agent.put(`/api/v1/gateway-pools/${poolId}/members`)
    .set('X-CSRF-Token', csrf)
    .set('Content-Type', 'application/json')
    .send({ members: [
      { peer_id: 1, priority: 1 },
      { peer_id: 2, priority: 2 },
    ] });
  assert.equal(res.status, 200, 'body=' + JSON.stringify(res.body));
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].peer_id, 1);
});

test('PUT /members rejects non-array body', async () => {
  const db = getDb();
  insertGatewayPeer(db, 1);
  const create = await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf)
    .send({ name: 'P', mode: 'failover', failback_cooldown_s: 60 });
  const poolId = create.body.id;

  const res = await agent.put(`/api/v1/gateway-pools/${poolId}/members`).set('X-CSRF-Token', csrf)
    .send({ not: 'an array' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /array_required/);
});

test('PUT /members 404 for unknown pool', async () => {
  const res = await agent.put('/api/v1/gateway-pools/9999/members').set('X-CSRF-Token', csrf).send([]);
  assert.equal(res.status, 404);
});
