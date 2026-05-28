'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const gateways = require('../src/services/gateways');

let agent, csrf;
test.before(async () => {
  const c = await setup(); agent = c.agent; csrf = c.csrfToken;
  require('../src/services/license')._overrideForTest({ gateway_lan_discovery: true, gateway_lan_discovery_multi_subnet: true, gateway_peers: -1 });
});
test.after(() => teardown());

function seedGatewayWithSubnets(subnets) {
  // create gateway + set last_health telemetry so the server knows its reported subnets + capability
  return gateways.createGateway({ name: 'gw-settings-' + Math.random().toString(36).slice(2, 7) }).then((gw) => {
    const peerId = gw.peer.id;
    const db = require('../src/db/connection').getDb();
    const health = { telemetry: { lan_discovery: true, lan_subnets: subnets.map((cidr, i) => ({ iface: 'eth0', cidr, primary: i === 0 })),
      lan_discovery_categories: [{ key: 'web', label: 'Web' }, { key: 'iot', label: 'IoT' }] } };
    db.prepare(`UPDATE gateway_meta SET last_health=? WHERE peer_id=?`).run(JSON.stringify(health), peerId);
    return peerId;
  });
}

test('PUT discovery-settings saves valid subnet+category selection', async () => {
  const peerId = await seedGatewayWithSubnets(['192.168.1.0/24']);
  const res = await agent.put(`/api/v1/gateways/${peerId}/discovery-settings`).set('X-CSRF-Token', csrf)
    .send({ enabled: true, active_scan: false, subnets: ['192.168.1.0/24'], category_mode: 'exclude', categories: ['iot'] })
    .expect(200);
  assert.equal(res.body.ok, true);
  const s = gateways.getDiscoverySettings(peerId);
  assert.equal(s.enabled, 1);
  assert.deepEqual(s.subnets, ['192.168.1.0/24']);
  assert.equal(s.category_mode, 'exclude');
});

test('rejects a subnet the gateway did not report', async () => {
  const peerId = await seedGatewayWithSubnets(['192.168.1.0/24']);
  await agent.put(`/api/v1/gateways/${peerId}/discovery-settings`).set('X-CSRF-Token', csrf)
    .send({ enabled: true, subnets: ['10.0.0.0/24'] }).expect(400);
});

test('multi-subnet selection requires gateway_lan_discovery_multi_subnet', async () => {
  const license = require('../src/services/license');
  const peerId = await seedGatewayWithSubnets(['192.168.1.0/24', '192.168.2.0/24']);
  license._overrideForTest({ gateway_lan_discovery: true, gateway_lan_discovery_multi_subnet: false });
  await agent.put(`/api/v1/gateways/${peerId}/discovery-settings`).set('X-CSRF-Token', csrf)
    .send({ enabled: true, subnets: ['192.168.1.0/24', '192.168.2.0/24'] }).expect(403);
  // restore full unlock for other tests
  license._overrideForTest({ gateway_lan_discovery: true, gateway_lan_discovery_multi_subnet: true });
});
