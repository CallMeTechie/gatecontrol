'use strict';
const crypto = require('node:crypto');
// Must be set before any module that touches encryption (createGateway calls encrypt())
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, teardown } = require('./helpers/setup');
const gateways = require('../src/services/gateways');

let ctx;
test.before(async () => {
  ctx = await setup();
  require('../src/services/license')._overrideForTest({ gateway_lan_discovery: true, gateway_lan_discovery_multi_subnet: true, gateway_peers: -1 });
});
test.after(() => teardown());

test('notifyLanScan POSTs /api/lan-scan to the gateway with X-Gateway-Token + payload', async () => {
  // fake gateway listening on loopback
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { got = { path: req.url, token: req.headers['x-gateway-token'], body: JSON.parse(b || '{}') }; res.end(JSON.stringify({ accepted: true, request_id: got.body.request_id, subnets_scanned: got.body.subnets })); });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;

  // create a gateway peer, then point its gateway_meta at the fake server
  const gw = await gateways.createGateway({ name: 'gw-test', apiPort: port });
  const db = require('../src/db/connection').getDb();
  db.prepare(`UPDATE peers SET allowed_ips='127.0.0.1/32' WHERE id=?`).run(gw.peer.id);
  const peerId = gw.peer.id;

  const r = await gateways.notifyLanScan(peerId, {
    request_id: 'req-1', subnets: ['192.168.1.0/24'], category_mode: 'include', categories: ['web'], active_scan: true,
  });
  assert.equal(got.path, '/api/lan-scan');
  assert.equal(typeof got.token, 'string');
  assert.equal(got.body.request_id, 'req-1');
  assert.deepEqual(got.body.subnets, ['192.168.1.0/24']);
  assert.equal(got.body.active_scan, true);
  assert.equal(r.accepted, true);
  srv.close();
});

test('getDiscoverySettings/setDiscoverySettings round-trip', () => {
  const db = require('../src/db/connection').getDb();
  const peerId = db.prepare(`SELECT peer_id FROM gateway_meta LIMIT 1`).get().peer_id;
  gateways.setDiscoverySettings(peerId, { enabled: 1, active_scan: 1, subnets: ['192.168.1.0/24'], category_mode: 'exclude', categories: ['iot'] });
  const s = gateways.getDiscoverySettings(peerId);
  assert.equal(s.enabled, 1);
  assert.equal(s.active_scan, 1);
  assert.deepEqual(s.subnets, ['192.168.1.0/24']);
  assert.equal(s.category_mode, 'exclude');
  assert.deepEqual(s.categories, ['iot']);
});
