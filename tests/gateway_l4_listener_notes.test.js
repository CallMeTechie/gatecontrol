'use strict';

// A gateway that cannot open the listener of a TCP/UDP route used to show
// only "degradiert". Its heartbeat now names the route and the reason
// (l4_listener_issues) and the routes its own target service answers directly
// (l4_listeners_direct); gateways.l4ListenerNotes checks both lists and adds
// the route (name, protocol, whose route it is), GET /api/v1/gateways carries
// the result as l4_listeners. The case behind it: a failover pool of two
// NAS, a route of the first one pointing at the second on the same port.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, gws;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  require('../src/services/caddyConfig').syncToCaddy = async () => true;
  gws = require('../src/services/gateways');
  gws.notifyConfigChanged = async (id) => {
    db.prepare('UPDATE gateway_meta SET last_config_hash = ? WHERE peer_id = ?').run(gws.computeConfigHash(id), id);
    return { ok: true };
  };
  require('../src/services/gatewayHealth')._resetSnapshotCache();
});
afterEach(teardown);

function gateway(id, name) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at, last_health)
    VALUES (?, 9876, ?, 'e', 1, ?, ?, '{}')`).run(id, 'h' + id, Date.now(), Date.now());
}
function l4Route(id, domain, peerId, proto, listen, host, port) {
  db.prepare(`INSERT INTO routes (id, domain, target_kind, target_peer_id, target_lan_host, target_lan_port,
      target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode, enabled)
    VALUES (?, ?, 'gateway', ?, ?, ?, '0.0.0.0', ?, 'l4', ?, ?, 'none', 1)`).run(id, domain, peerId, host, port, port, proto, String(listen));
}
async function pool(name, members) {
  const r = await agent.post('/api/v1/gateway-pools').set('X-CSRF-Token', csrf).send({ name, mode: 'failover', failback_cooldown_s: 900 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const put = await agent.put(`/api/v1/gateway-pools/${r.body.id}/members`).set('X-CSRF-Token', csrf)
    .send(members.map((peer_id, i) => ({ peer_id, priority: i + 1 })));
  assert.equal(put.status, 200, JSON.stringify(put.body));
}
const listed = async (id) => {
  const r = await agent.get('/api/v1/gateways');
  assert.equal(r.status, 200);
  return r.body.gateways.find((g) => g.peer_id === id);
};
const base = { http_proxy_healthy: true, api_healthy: true, tcp_listeners: [], dns_resolve_ok: true, wg_handshake_age_s: 20 };

test('an old heartbeat without the new fields: two empty lists, the gateway is listed as before', async () => {
  gateway(21, 'DS218+');
  gws.handleHeartbeat(21, { ...base, l4_routes_configured: 1, l4_listeners_missing: 1, overall_healthy: false });
  assert.deepEqual(gws.l4ListenerNotes(21, { l4_listeners_missing: 1 }), { issues: [], direct: [] });
  assert.deepEqual(gws.l4ListenerNotes(21, null), { issues: [], direct: [] });
  const g = await listed(21);
  assert.deepEqual(g.l4_listeners, { issues: [], direct: [] });
  assert.equal(g.health.overall_healthy, false);
  assert.equal(g.health.l4_listeners_missing, 1);
  // a gateway that never sent a heartbeat
  gateway(22, 'neu');
  assert.deepEqual((await listed(22)).l4_listeners, { issues: [], direct: [] });
});

test('the reserve cannot open the partner\'s port: route, protocol, port, reason and whose route it is', async () => {
  gateway(21, 'DS218+');
  gateway(22, 'DS918+');
  l4Route(300, 'dns.example.com', 21, 'udp', 5335, '192.168.2.151', 5335);
  await pool('Heimnetz', [21, 22]);
  assert.deepEqual(gws.getGatewayConfig(22).l4_routes.map((r) => r.id), [300], 'the reserve has the partner\'s route in its config');

  gws.handleHeartbeat(22, { ...base, l4_routes_configured: 1, l4_listeners_missing: 1, overall_healthy: false, listener_reapply_triggered: true,
    l4_listener_issues: [{ route_id: 300, listen_port: 5335, reason: 'port_in_use', code: 'EADDRINUSE' }], l4_listeners_direct: [] });
  const g = await listed(22);
  assert.deepEqual(g.l4_listeners, {
    issues: [{ route_id: 300, listen_port: 5335, reason: 'port_in_use', code: 'EADDRINUSE', domain: 'dns.example.com', protocol: 'udp', reserve_of: 'DS218+' }],
    direct: [],
  });
  assert.equal(g.health.overall_healthy, false);
  // on the gateway the route belongs to it is no reserve
  assert.equal(gws.l4ListenerNotes(21, { l4_listener_issues: [{ route_id: 300, listen_port: 5335, reason: 'port_in_use' }] }).issues[0].reserve_of, null);
});

test('the target service answers directly: listed under direct, the gateway reports itself healthy', async () => {
  gateway(21, 'DS218+');
  gateway(22, 'DS918+');
  l4Route(300, 'dns.example.com', 21, 'tcp', 5335, '192.168.2.151', 5335);
  await pool('Heimnetz', [21, 22]);
  gws.handleHeartbeat(22, { ...base, l4_routes_configured: 1, l4_listeners_missing: 0, overall_healthy: true,
    l4_listener_issues: [], l4_listeners_direct: [{ route_id: 300, listen_port: 5335, reachable: true }] });
  const g = await listed(22);
  assert.deepEqual(g.l4_listeners, { issues: [],
    direct: [{ route_id: 300, listen_port: 5335, reachable: true, domain: 'dns.example.com', protocol: 'tcp', reserve_of: 'DS218+' }] });
  assert.equal(g.health.overall_healthy, true);
  assert.equal(g.status, 'online');
  assert.equal(gws.l4ListenerNotes(22, { l4_listeners_direct: [{ route_id: 300, listen_port: 5335, reachable: false }] }).direct[0].reachable, false);
});

test('what a gateway sends is checked: unknown reasons, odd codes, wrong types, a deleted route, long lists', () => {
  gateway(21, 'DS218+');
  l4Route(300, 'ssh.example.com', 21, 'tcp', 2222, '192.168.1.9', 22);
  const n = gws.l4ListenerNotes(21, { l4_listener_issues: [
    { route_id: 300, listen_port: 'x', reason: '<b>', code: 'drop table' },
    { route_id: 999, listen_port: 70000, reason: 'permission_denied', code: 'EACCES' },
    { route_id: 'abc', listen_port: 1 }, null, 'text',
  ], l4_listeners_direct: 'nope' });
  assert.deepEqual(n.issues, [
    { route_id: 300, listen_port: 2222, reason: 'error', code: null, domain: 'ssh.example.com', protocol: 'tcp', reserve_of: null },
    { route_id: 999, listen_port: null, reason: 'permission_denied', code: 'EACCES', domain: null, protocol: null, reserve_of: null },
  ]);
  assert.deepEqual(n.direct, []);
  const many = Array.from({ length: 60 }, (_, i) => ({ route_id: i + 1, listen_port: 1000 + i, reason: 'port_in_use' }));
  assert.equal(gws.l4ListenerNotes(21, { l4_listener_issues: many }).issues.length, 20);
});
