'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const gateways = require('../src/services/gateways');
const discoveryCache = require('../src/services/discoveryCache');

let agent;
test.before(async () => {
  const c = await setup(); agent = c.agent;
  require('../src/services/license')._overrideForTest({ gateway_lan_discovery: true, gateway_lan_discovery_multi_subnet: true, gateway_peers: -1 });
});
test.after(() => teardown());

test('POST /api/v1/gateway/discovery ingests a batch (Bearer) and caches it', async () => {
  discoveryCache._reset();
  const gw = await gateways.createGateway({ name: 'gw-ingest' });
  const peerId = gw.peer.id;
  const apiToken = gw.apiToken;
  discoveryCache.begin(peerId, 'rq');
  const res = await agent
    .post('/api/v1/gateway/discovery')
    .set('Authorization', `Bearer ${apiToken}`)
    .send({ request_id: 'rq', devices: [{ ip: '192.168.1.5', ports: [{ port: 80, source: 'tcp' }] }], done: true })
    .expect(200);
  assert.equal(res.body.ok, true);
  const snap = discoveryCache.get(peerId);
  assert.equal(snap.devices.length, 1);
  assert.equal(snap.done, true);
});

test('rejects without a gateway Bearer token', async () => {
  await agent.post('/api/v1/gateway/discovery').send({ request_id: 'x', devices: [], done: true }).expect(401);
});

test('accepts a discovery batch larger than the 16kb gateway body cap', async () => {
  discoveryCache._reset();
  const gw = await gateways.createGateway({ name: 'gw-big' });
  const peerId = gw.peer.id; const apiToken = gw.apiToken;
  discoveryCache.begin(peerId, 'big');
  const devices = Array.from({ length: 300 }, (_, i) => ({ ip: `192.168.${Math.floor(i / 254)}.${(i % 254) + 1}`, hostname: 'host-with-a-fairly-long-name-' + i, ports: [{ port: 80, source: 'tcp' }] }));
  const res = await agent.post('/api/v1/gateway/discovery').set('Authorization', `Bearer ${apiToken}`).send({ request_id: 'big', devices, done: true }).expect(200); // not 413
  assert.equal(res.body.ok, true);
});
