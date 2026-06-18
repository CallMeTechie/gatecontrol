'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

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

function POST(path, body) { return agent.post(path).set('X-CSRF-Token', csrf).send(body); }
function DEL(path)        { return agent.delete(path).set('X-CSRF-Token', csrf); }

/**
 * Insert gateway + gateway_meta (with LAN subnets) + an L4 gateway route.
 * Returns { peerId, routeId }.
 */
async function createFixtures() {
  const gateways = require('../src/services/gateways');
  const db = require('../src/db/connection').getDb();

  const { peer } = await gateways.createGateway({ name: 'egress-test-gw' });

  // Populate last_health so lanSubnetsOf() finds a valid subnet for vip_ip validation.
  db.prepare('UPDATE gateway_meta SET last_health=? WHERE peer_id=?').run(
    JSON.stringify({ telemetry: { lan_subnets: [{ cidr: '192.168.10.0/24' }] } }),
    peer.id,
  );

  // L4 + gateway + internal-only (external_enabled defaults to 0 for new rows)
  const routeId = db.prepare(`
    INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind)
    VALUES ('egress-l4-fixture.example.com', '10.8.0.1', 9000, 'l4', 'gateway')
  `).run().lastInsertRowid;

  return { peerId: peer.id, routeId };
}

// ── (a) Feature not granted → 403 ────────────────────────────────────────────

test('GET /api/v1/egress-routes without feature → 403', async () => {
  require('../src/services/license')._overrideForTest({ gateway_scan_egress: false });
  const res = await agent.get('/api/v1/egress-routes');
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.feature, 'gateway_scan_egress');
});

// ── (b) Feature granted, invalid payload → 400 ───────────────────────────────

test('POST /api/v1/egress-routes with invalid target_route_id → 400', async () => {
  require('../src/services/license')._overrideForTest({ gateway_scan_egress: true });
  const res = await POST('/api/v1/egress-routes', {
    name: 'bad-route',
    near_peer_id: 1,
    vip_ip: '192.168.10.50',
    lan_listen_port: 5000,
    target_route_id: 99999,  // does not exist
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.ok, false);
});

// ── (c) POST valid → 201 + row ────────────────────────────────────────────────

test('POST /api/v1/egress-routes valid → 201 + row', async () => {
  require('../src/services/license')._overrideForTest({ gateway_scan_egress: true });
  const { peerId, routeId } = await createFixtures();

  const res = await POST('/api/v1/egress-routes', {
    name: 'scan-egress-test',
    near_peer_id: peerId,
    vip_ip: '192.168.10.10',
    lan_listen_port: 9500,
    target_route_id: routeId,
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.ok(res.body.data.id, 'response must include data.id');
  assert.equal(res.body.data.name, 'scan-egress-test');
});

// ── (d) DELETE → 200 ──────────────────────────────────────────────────────────

test('DELETE /api/v1/egress-routes/:id → 200', async () => {
  require('../src/services/license')._overrideForTest({ gateway_scan_egress: true });
  const { peerId, routeId } = await createFixtures();

  const created = await POST('/api/v1/egress-routes', {
    name: 'to-delete',
    near_peer_id: peerId,
    vip_ip: '192.168.10.20',
    lan_listen_port: 9501,
    target_route_id: routeId,
  });
  assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const id = created.body.data.id;

  const del = await DEL(`/api/v1/egress-routes/${id}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.ok, true);
});
