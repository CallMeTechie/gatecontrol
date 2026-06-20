// tests/api_printer_presets.test.js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
let agent, csrf, gwPeerId;
beforeEach(async () => {
  await setup(); agent = getAgent(); csrf = getCsrf();
  const db = require('../src/db/connection').getDb();
  require('../src/services/license')._overrideForTest({ l4_routes: 100, http_routes: 100, gateway_tcp_routing: true, gateway_scan_egress: true });
  gwPeerId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw','k1','10.8.0.9/32',1,'gateway')").run().lastInsertRowid;
  // Full gateway_meta row (NOT NULL cols, no defaults) + lan_subnets telemetry — mirror gatewayPool.test.js.
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health)
    VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, ?)`)
    .run(gwPeerId, JSON.stringify({ telemetry: { lan_subnets: [{ cidr: '192.168.2.0/24', primary: true }], scan_egress: true } }));
});
afterEach(teardown);
function POST(p, b) { return agent.post(p).set('X-CSRF-Token', csrf).send(b); }
test('creates a print-only preset → 201', async () => {
  const res = await POST('/api/v1/printer-presets', { near_peer_id: gwPeerId, printer_ip: '192.168.2.45', name: 'EG', print_ports: [9100] });
  assert.equal(res.status, 201); assert.equal(res.body.ok, true); assert.ok(res.body.preset.bundle_id);
});
test('scan without gateway_scan_egress → 403', async () => {
  require('../src/services/license')._overrideForTest({ l4_routes: 100, http_routes: 100, gateway_tcp_routing: true, gateway_scan_egress: false });
  const res = await POST('/api/v1/printer-presets', { near_peer_id: gwPeerId, printer_ip: '192.168.2.45', name: 'EG', print_ports: [9100], scan: { enabled: true, vip_ip: '192.168.2.250', target: { mode: 'new', nas_ip: '192.168.9.10', nas_peer_id: gwPeerId } } });
  assert.equal(res.status, 403); assert.equal(res.body.feature, 'gateway_scan_egress');
});
test('duplicate EWS domain → 409 (R3-M3)', async () => {
  await POST('/api/v1/printer-presets', { near_peer_id: gwPeerId, printer_ip: '192.168.2.45', name: 'A', print_ports: [9100], ews: { enabled: true, domain: 'dup.example.com' } });
  const res = await POST('/api/v1/printer-presets', { near_peer_id: gwPeerId, printer_ip: '192.168.2.46', name: 'B', print_ports: [9100], ews: { enabled: true, domain: 'dup.example.com' } });
  assert.equal(res.status, 409); assert.equal(res.body.code, 'DOMAIN_CONFLICT');
});
// Implementer note (R3-M3): verify routes.assertDomainAvailable's actual throw text matches
// the /domain already exists/i regex in mapDomainError — adjust the regex if the wording differs.
