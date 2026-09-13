'use strict';
// TLS guard API: /api/v1/tls/*, PUT /api/v1/settings/tls, tls in route/host
// answers, server-ipv6 override, token scope, SSE type list.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const V4 = '198.51.100.7';
const FOREIGN6 = '2001:41d0:301:1::29';
let domains, dnsMap, agent, csrf;
const nodata = () => { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; };

beforeEach(async () => {
  await setup();
  agent = getAgent(); csrf = getCsrf();
  domains = require('../src/services/domains');
  dnsMap = { 'example.com': { a: [V4], aaaa: [] } };
  domains._setServerIpsForTest({ v4: V4, v6: null });
  domains._setCaaResolverForTest(async () => nodata());
  domains._setResolverForTest(async (host, family) => {
    const r = dnsMap[host] || { a: [], aaaa: [] };
    return family === 4 ? r.a : r.aaaa;
  });
  require('../src/db/connection').getDb().prepare("INSERT INTO domains (domain, status) VALUES ('example.com','verified')").run();
});
afterEach(() => { domains._setServerIpsForTest(null); teardown(); });

const ROUTE = { target_ip: '203.0.113.10', target_port: 8080, https_enabled: true };

test('GET /tls/status, preflight and retry', async () => {
  dnsMap['jenny.example.com'] = { a: [V4], aaaa: [FOREIGN6] };
  const created = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf).send({ ...ROUTE, domain: 'jenny.example.com' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.tls, { state: 'paused', code: 'aaaa_without_ipv6', detail: `AAAA ${FOREIGN6} but this server has no IPv6 address` });
  assert.equal(created.body.route.tls, undefined, 'route row itself carries no tls');

  let res = await agent.get('/api/v1/tls/status').expect(200);
  assert.equal(res.body.ok, true);
  const h = res.body.hosts.find((x) => x.host === 'jenny.example.com');
  assert.ok(h, 'host listed');
  assert.equal(h.state, 'paused'); assert.equal(h.kind, 'acme'); assert.equal(h.route_id, created.body.route.id);
  assert.equal(h.paused_reason, 'preflight'); assert.equal(h.last_error_code, 'preflight:aaaa_without_ipv6');
  assert.equal(h.preflight.code, 'aaaa_without_ipv6');
  assert.deepEqual(Object.keys(h).sort(), ['alias_of', 'attempts', 'days_left', 'domain_id', 'host', 'host_id', 'issuer', 'kind', 'last_attempt_at',
    'last_error', 'last_error_code', 'max_attempts', 'next_retry_at', 'not_after', 'paused_at', 'paused_reason', 'preflight', 'route_id', 'state']);
  assert.equal(h.alias_of, null);
  assert.equal(res.body.summary.paused, 1);
  assert.equal(res.body.summary.acme_email_missing, true);
  assert.deepEqual(res.body.settings, { max_attempts: 3 });

  res = await agent.get('/api/v1/tls/preflight/jenny.example.com').expect(200);
  assert.equal(res.body.result.code, 'aaaa_without_ipv6');
  await agent.get('/api/v1/tls/preflight/bad host!').expect(400);

  res = await agent.post('/api/v1/tls/jenny.example.com/retry').set('X-CSRF-Token', csrf).expect(409);
  assert.equal(res.body.ok, false); assert.equal(res.body.code, 'PREFLIGHT_FAILED'); assert.equal(res.body.result.code, 'aaaa_without_ipv6');

  dnsMap['jenny.example.com'] = { a: [V4], aaaa: [] };
  res = await agent.post('/api/v1/tls/jenny.example.com/retry').set('X-CSRF-Token', csrf).expect(200);
  assert.equal(res.body.status.state, 'pending'); assert.equal(res.body.status.host, 'jenny.example.com');

  // zones view carries entry.tls and host.tls_problem
  res = await agent.get('/api/v1/zones').expect(200);
  const host = res.body.zones.flatMap((z) => z.hosts).concat(res.body.unassigned).find((x) => x.fqdn === 'jenny.example.com');
  assert.ok(host);
  assert.equal(host.tls_problem, false);
  assert.equal(host.entries[0].tls.state, 'pending');
});

test('route update answers carry tls when HTTPS is turned on; host create/entry answers too', async () => {
  dnsMap['plain.example.com'] = { a: ['203.0.113.9'], aaaa: [] };
  const created = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf).send({ ...ROUTE, domain: 'plain.example.com', https_enabled: false });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.tls, undefined);
  const upd = await agent.put('/api/v1/routes/' + created.body.route.id).set('X-CSRF-Token', csrf).send({ https_enabled: true });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.tls.state, 'paused'); assert.equal(upd.body.tls.code, 'a_mismatch');

  require('../src/services/license')._overrideForTest({ gateway_http_targets: -1, gateway_peers: -1, gateway_tcp_routing: true });
  const db = require('../src/db/connection').getDb();
  const gw = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw', 'k1', '10.8.0.2/32', 1, 'gateway')").run().lastInsertRowid;
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
    VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, '{}', 1)`).run(gw);
  db.prepare("UPDATE domains SET gateway_kind = 'gateway', gateway_peer_id = ? WHERE domain = 'example.com'").run(gw);
  const zoneId = db.prepare("SELECT id FROM domains WHERE domain = 'example.com'").get().id;
  dnsMap['nas.example.com'] = { a: [V4], aaaa: [FOREIGN6] };
  const hc = await agent.post(`/api/v1/domains/${zoneId}/hosts`).set('X-CSRF-Token', csrf)
    .send({ subdomain: 'nas', lan_host: '192.168.1.10', entries: [{ type: 'tcp', target_port: 22, listen_port: 2022 }] });
  assert.equal(hc.status, 201, JSON.stringify(hc.body));
  assert.equal(hc.body.tls, undefined, 'plain tcp: no preflight');
  const he = await agent.post(`/api/v1/hosts/${hc.body.host.id}/entries`).set('X-CSRF-Token', csrf).send({ type: 'http', target_port: 5001 });
  assert.equal(he.status, 201, JSON.stringify(he.body));
  assert.equal(he.body.tls.state, 'paused'); assert.equal(he.body.tls.code, 'aaaa_without_ipv6');
  assert.equal(he.body.entry.tls, undefined);
});

test('PUT /settings/tls validates and stores max_attempts', async () => {
  let res = await agent.put('/api/v1/settings/tls').set('X-CSRF-Token', csrf).send({ max_attempts: 5 }).expect(200);
  assert.deepEqual(res.body, { ok: true, max_attempts: 5 });
  res = await agent.get('/api/v1/settings/tls').expect(200);
  assert.equal(res.body.max_attempts, 5);
  res = await agent.get('/api/v1/tls/status').expect(200);
  assert.equal(res.body.settings.max_attempts, 5);
  await agent.put('/api/v1/settings/tls').set('X-CSRF-Token', csrf).send({ max_attempts: 11 }).expect(400);
  await agent.put('/api/v1/settings/tls').set('X-CSRF-Token', csrf).send({ max_attempts: 'x' }).expect(400);
  await agent.put('/api/v1/settings/tls').set('X-CSRF-Token', csrf).send({}).expect(400);
  res = await agent.put('/api/v1/settings/tls').set('X-CSRF-Token', csrf).send({ max_attempts: '0' }).expect(200);
  assert.equal(res.body.max_attempts, 0);
});

test('PUT /settings/domains/server-ip accepts ipv6 and GET exposes both addresses', async () => {
  domains._setServerIpsForTest(null);
  domains._setInterfacesForTest(() => ({}));
  const settings = require('../src/services/settings');
  await agent.put('/api/v1/settings/domains/server-ip').set('X-CSRF-Token', csrf).send({ ip: V4, ipv6: '2001:db8::1' }).expect(200);
  assert.equal(settings.get('server.public_ip'), V4);
  assert.equal(settings.get('server.public_ipv6'), '2001:db8::1');
  await agent.put('/api/v1/settings/domains/server-ip').set('X-CSRF-Token', csrf).send({ ipv6: 'nope' }).expect(400);
  await agent.put('/api/v1/settings/domains/server-ip').set('X-CSRF-Token', csrf).send({ ipv6: '' }).expect(200);
  assert.equal(settings.get('server.public_ipv6'), '');
  assert.equal(settings.get('server.public_ip'), V4, 'ipv6-only body leaves the IPv4 override alone');
  await agent.put('/api/v1/settings/domains/server-ip').set('X-CSRF-Token', csrf).send({ ipv6: '2001:db8::2' }).expect(200);
  const res = await agent.get('/api/v1/settings/domains').expect(200);
  assert.equal(res.body.data.serverIp, V4);
  assert.equal(res.body.data.serverIpv6, '2001:db8::2');
  assert.deepEqual(res.body.data.serverIps.source, { v4: 'override', v6: 'override' });
});

test('token scope, unauthenticated access and the SSE type list', async () => {
  const tokens = require('../src/services/tokens');
  assert.equal(tokens.checkScope(['routes'], '/api/v1/tls/status', 'GET'), true);
  assert.equal(tokens.checkScope(['routes'], '/api/v1/tls/x.example.com/retry', 'POST'), true);
  assert.equal(tokens.checkScope(['peers'], '/api/v1/tls/status', 'GET'), false);
  const supertest = require('supertest');
  const app = require('../src/app').createApp();
  const r = await supertest(app).get('/api/v1/tls/status');
  assert.ok([401, 403].includes(r.status));
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'events.js'), 'utf8');
  assert.match(src, /'routes',\s*'tls'\]/, 'events.js forwards tls');
});
