'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, teardown } = require('./helpers/setup');
const gateways = require('../src/services/gateways');
const discoveryCache = require('../src/services/discoveryCache');

let agent, csrf;
test.before(async () => {
  const c = await setup(); agent = c.agent; csrf = c.csrfToken;
  require('../src/services/license')._overrideForTest({ gateway_lan_discovery: true, gateway_lan_discovery_multi_subnet: true, gateway_peers: -1 });
});
test.after(() => teardown());

async function seedScannableGateway() {
  // fake gateway that accepts /api/lan-scan
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => res.end(JSON.stringify({ accepted: true }))); }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const gw = await gateways.createGateway({ name: 'gw-disc-' + Math.random().toString(36).slice(2, 7), apiPort: srv.address().port });
  const peerId = gw.peer.id;
  const db = require('../src/db/connection').getDb();
  db.prepare(`UPDATE peers SET allowed_ips='127.0.0.1/32' WHERE id=?`).run(peerId);
  const health = { telemetry: { lan_discovery: true, lan_subnets: [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }], lan_discovery_categories: [{ key: 'web', label: 'Web' }] } };
  db.prepare(`UPDATE gateway_meta SET last_health=? WHERE peer_id=?`).run(JSON.stringify(health), peerId);
  gateways.setDiscoverySettings(peerId, { enabled: 1, active_scan: 0, subnets: ['192.168.1.0/24'], category_mode: 'include', categories: ['web'] });
  return { peerId, srv };
}

test('POST /:id/discover triggers a scan (202) and marks in-flight', async () => {
  discoveryCache._reset();
  const { peerId, srv } = await seedScannableGateway();
  const res = await agent.post(`/api/v1/gateways/${peerId}/discover`).set('X-CSRF-Token', csrf).send({}).expect(202);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.request_id, 'string');
  assert.deepEqual(res.body.subnets_scanned, ['192.168.1.0/24']);
  assert.equal(discoveryCache.inFlight(peerId), true);
  srv.close();
});

test('POST /:id/discover → 409 when a scan is already in flight (no force)', async () => {
  discoveryCache._reset();
  const { peerId, srv } = await seedScannableGateway();
  await agent.post(`/api/v1/gateways/${peerId}/discover`).set('X-CSRF-Token', csrf).send({}).expect(202);
  await agent.post(`/api/v1/gateways/${peerId}/discover`).set('X-CSRF-Token', csrf).send({}).expect(409);
  srv.close();
});

test('POST /:id/discover → 409 when the gateway lacks the capability flag', async () => {
  discoveryCache._reset();
  const { peerId, srv } = await seedScannableGateway();
  const db = require('../src/db/connection').getDb();
  db.prepare(`UPDATE gateway_meta SET last_health=? WHERE peer_id=?`).run(JSON.stringify({ telemetry: { lan_discovery: false } }), peerId);
  await agent.post(`/api/v1/gateways/${peerId}/discover`).set('X-CSRF-Token', csrf).send({}).expect(409);
  srv.close();
});

test('GET /:id/discovered returns the cached snapshot', async () => {
  discoveryCache._reset();
  const { peerId, srv } = await seedScannableGateway();
  discoveryCache.begin(peerId, 'r1');
  discoveryCache.ingest(peerId, 'r1', [{ ip: '192.168.1.5', ports: [] }], true);
  const res = await agent.get(`/api/v1/gateways/${peerId}/discovered`).expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.devices.length, 1);
  assert.equal(res.body.in_flight, false);
  srv.close();
});
