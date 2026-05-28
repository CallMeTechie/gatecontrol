'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const gateways = require('../src/services/gateways');

let agent;
before(async () => {
  const c = await setup(); agent = c.agent;
  require('../src/services/license')._overrideForTest({ gateway_lan_discovery: true, gateway_peers: -1 });
});
after(() => teardown());

test('GET /api/v1/gateways includes a discovery block per gateway', async () => {
  const gw = await gateways.createGateway({ name: 'gw-fp' });
  const peerId = gw.peer.id;
  gateways.setDiscoverySettings(peerId, { enabled: 1, active_scan: 0, subnets: ['192.168.1.0/24'], category_mode: 'include', categories: ['web'] });
  const res = await agent.get('/api/v1/gateways').expect(200);
  const g = (res.body.gateways || []).find(x => x.peer_id === peerId);
  assert.ok(g, 'gateway present');
  assert.equal(g.discovery.enabled, 1);
  assert.equal(g.discovery.active_scan, 0);
});
