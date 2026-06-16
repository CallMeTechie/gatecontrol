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
  require('../src/services/license')._overrideForTest({ gateway_peers: -1 });
});
test.after(() => teardown());

test('probeGatewayTarget returns probed_target + probe_result from gateway', async () => {
  // fake companion echoes probed_target and derives probe_result from requested port
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      got = { path: req.url, token: req.headers['x-gateway-token'], body };
      res.end(JSON.stringify({
        probed_target: { host: body.host, port: body.port },
        probe_result: body.port === 3389,
      }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;

  // create a gateway peer, then point its gateway_meta at the fake server
  const gw = await gateways.createGateway({ name: 'gw-probe', apiPort: port });
  const db = require('../src/db/connection').getDb();
  db.prepare(`UPDATE peers SET allowed_ips='127.0.0.1/32' WHERE id=?`).run(gw.peer.id);
  const peerId = gw.peer.id;

  const r = await gateways.probeGatewayTarget(peerId, '192.168.2.144', 3389);
  assert.equal(got.path, '/api/probe');
  assert.equal(typeof got.token, 'string');
  assert.deepEqual(got.body, { host: '192.168.2.144', port: 3389 });
  assert.deepEqual(r.probed_target, { host: '192.168.2.144', port: 3389 });
  assert.equal(r.probe_result, true);

  // a different port -> probe_result false
  const r2 = await gateways.probeGatewayTarget(peerId, '192.168.2.144', 13389);
  assert.deepEqual(r2.probed_target, { host: '192.168.2.144', port: 13389 });
  assert.equal(r2.probe_result, false);

  srv.close();
});

test('probeGatewayTarget returns null for an unknown peerId', async () => {
  const r = await gateways.probeGatewayTarget(999999, '192.168.2.144', 3389);
  assert.equal(r, null);
});
