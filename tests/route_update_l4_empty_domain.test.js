'use strict';

// Regression: PUT /api/v1/routes/:id validated every domain it received, so the
// edit modal's `domain: ''` for an L4 route without TLS was rejected and every
// edit of such a route failed. The API now applies the service-layer rule: an
// empty domain is fine for L4, required for HTTP; TLS-SNI still needs one.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, routes, l4Id, httpId;
const PUT = (id, body) => agent.put(`/api/v1/routes/${id}`).set('X-CSRF-Token', csrf).send(body);

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  const caddy = require('../src/services/caddyConfig');
  caddy.syncToCaddy = async () => {};
  routes = require('../src/services/routes');
  const db = require('../src/db/connection').getDb();
  const peerId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('nas', ?, '10.8.0.60/32', 1)")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid;
  l4Id = (await routes.create({ route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2222', l4_tls_mode: 'none',
    peer_id: peerId, target_port: 22 }, { skipSync: true })).id;
  httpId = (await routes.create({ domain: 'web.example.test', peer_id: peerId, target_port: 80 }, { skipSync: true })).id;
});
after(() => teardown());

test('L4 route without TLS saves with an empty domain', async () => {
  const res = await PUT(l4Id, { domain: '', route_type: 'l4', l4_tls_mode: 'none', description: 'SSH NAS' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(routes.getById(l4Id).description, 'SSH NAS');
});

test('L4 route switching to TLS passthrough still requires a domain', async () => {
  const res = await PUT(l4Id, { domain: '', route_type: 'l4', l4_tls_mode: 'passthrough' });
  assert.equal(res.status, 400);
});

test('HTTP route still rejects an empty domain', async () => {
  const res = await PUT(httpId, { domain: '' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields && res.body.fields.domain);
});
