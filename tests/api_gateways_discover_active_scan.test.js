// tests/api_gateways_discover_active_scan.test.js
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

// Fake gateway that CAPTURES the /api/lan-scan request body so we can assert the
// active_scan flag the server forwarded.
async function seedCapturingGateway(activeScanStored) {
  const captured = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { try { captured.push(JSON.parse(b)); } catch { captured.push(null); } res.end(JSON.stringify({ accepted: true })); });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const gw = await gateways.createGateway({ name: 'gw-as-' + Math.random().toString(36).slice(2, 7), apiPort: srv.address().port });
  const peerId = gw.peer.id;
  const db = require('../src/db/connection').getDb();
  db.prepare(`UPDATE peers SET allowed_ips='127.0.0.1/32' WHERE id=?`).run(peerId);
  const health = { telemetry: { lan_discovery: true, lan_subnets: [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }], lan_discovery_categories: [{ key: 'web', label: 'Web' }] } };
  db.prepare(`UPDATE gateway_meta SET last_health=? WHERE peer_id=?`).run(JSON.stringify(health), peerId);
  gateways.setDiscoverySettings(peerId, { enabled: 1, active_scan: activeScanStored, subnets: ['192.168.1.0/24'], category_mode: 'include', categories: ['web'] });
  return { peerId, srv, captured };
}

test('active_scan:true override forwards active_scan=true even when stored setting is passive', async () => {
  discoveryCache._reset();
  const { peerId, srv, captured } = await seedCapturingGateway(0);
  await agent.post(`/api/v1/gateways/${peerId}/discover`).set('X-CSRF-Token', csrf).send({ active_scan: true }).expect(202);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].active_scan, true);
  // Spec §8: the override must NOT mutate the stored gateway setting.
  assert.equal(gateways.getDiscoverySettings(peerId).active_scan, 0, 'stored active_scan unchanged by override');
  srv.close();
});

test('no override uses the stored setting (passive)', async () => {
  discoveryCache._reset();
  const { peerId, srv, captured } = await seedCapturingGateway(0);
  await agent.post(`/api/v1/gateways/${peerId}/discover`).set('X-CSRF-Token', csrf).send({}).expect(202);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].active_scan, false);
  srv.close();
});
