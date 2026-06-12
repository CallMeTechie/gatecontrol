'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, peerId;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  // Direct private target_ips are SSRF-blocked at the API layer (parity
  // with POST /api/v1/routes) — bundle targets reference a peer instead.
  const db = require('../src/db/connection').getDb();
  peerId = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled)
    VALUES ('bundle-peer', ?, '10.8.0.40/32', 1)`)
    .run(require('crypto').randomBytes(16).toString('hex')).lastInsertRowid;
});
afterEach(teardown);

function POST(path, body) {
  return agent.post(path).set('X-CSRF-Token', csrf).send(body);
}
function PUT(path, body) {
  return agent.put(path).set('X-CSRF-Token', csrf).send(body);
}
function DEL(path) {
  return agent.delete(path).set('X-CSRF-Token', csrf);
}

function validBundle() {
  return {
    name: 'SSH Service',
    domain: 'bundle-api.example.com',
    target: { target_kind: 'peer', peer_id: peerId },
    http: { target_port: 80 },
    l4: [{ l4_protocol: 'tcp', l4_listen_port: 2022, target_port: 22 }],
  };
}

test('POST /api/v1/service-bundles creates bundle + members, GET returns them', async () => {
  const res = await POST('/api/v1/service-bundles', validBundle());
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  const bundle = res.body.bundle;
  assert.equal(bundle.domain, 'bundle-api.example.com');
  assert.equal(bundle.routes.length, 2);

  const list = await agent.get('/api/v1/service-bundles');
  assert.equal(list.status, 200);
  const found = list.body.bundles.find((b) => b.id === bundle.id);
  assert.ok(found);
  assert.equal(found.route_count, 2);

  const single = await agent.get('/api/v1/service-bundles/' + bundle.id);
  assert.equal(single.status, 200);
  assert.equal(single.body.bundle.routes.length, 2);

  // routes list carries the bundle join fields for the grouped UI
  const routesRes = await agent.get('/api/v1/routes');
  const member = routesRes.body.routes.find((r) => r.bundle_id === bundle.id);
  assert.ok(member, 'member routes expose bundle_id');
  assert.equal(member.bundle_name, 'SSH Service');
});

test('POST surfaces a 409 port conflict with a suggested port', async () => {
  await POST('/api/v1/service-bundles', validBundle());
  const res = await POST('/api/v1/service-bundles', {
    ...validBundle(),
    name: 'Kollision',
    domain: 'bundle-api2.example.com',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'BUNDLE_PORT_CONFLICT');
  assert.equal(res.body.conflict.port, 2022);
  assert.ok(res.body.conflict.suggestedPort > 2022);
});

test('POST rejects an invalid payload with 400', async () => {
  const res = await POST('/api/v1/service-bundles', {
    name: 'kaputt',
    target: { target_kind: 'peer', peer_id: peerId },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one exposure/);
});

test('PUT /:id renames, PUT /:id/toggle hard-sets all members', async () => {
  const { body } = await POST('/api/v1/service-bundles', validBundle());
  const id = body.bundle.id;

  const renamed = await PUT('/api/v1/service-bundles/' + id, { name: 'Umbenannt' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.bundle.name, 'Umbenannt');

  const off = await PUT(`/api/v1/service-bundles/${id}/toggle`, { enabled: false });
  assert.equal(off.status, 200);
  assert.ok(off.body.bundle.routes.every((r) => r.enabled === 0));

  const on = await PUT(`/api/v1/service-bundles/${id}/toggle`, { enabled: true });
  assert.ok(on.body.bundle.routes.every((r) => r.enabled === 1));
});

test('DELETE removes routes; ?delete_routes=false only ungroups', async () => {
  const db = require('../src/db/connection').getDb();

  const first = await POST('/api/v1/service-bundles', validBundle());
  const firstIds = first.body.bundle.routes.map((r) => r.id);
  const del = await DEL('/api/v1/service-bundles/' + first.body.bundle.id);
  assert.equal(del.status, 200);
  for (const rid of firstIds) {
    assert.equal(db.prepare('SELECT id FROM routes WHERE id = ?').get(rid), undefined);
  }

  const second = await POST('/api/v1/service-bundles', {
    ...validBundle(), name: 'Ungroup', domain: 'bundle-api3.example.com',
  });
  const secondIds = second.body.bundle.routes.map((r) => r.id);
  const ung = await DEL(`/api/v1/service-bundles/${second.body.bundle.id}?delete_routes=false`);
  assert.equal(ung.status, 200);
  for (const rid of secondIds) {
    const row = db.prepare('SELECT bundle_id FROM routes WHERE id = ?').get(rid);
    assert.ok(row, 'route survives ungroup');
    assert.equal(row.bundle_id, null);
  }
});

test('POST /group bundles existing routes', async () => {
  const db = require('../src/db/connection').getDb();
  const rid = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, enabled)
    VALUES ('grp-api.example.com', '10.8.0.40', 80, 1)`).run().lastInsertRowid;
  const res = await POST('/api/v1/service-bundles/group', {
    name: 'Gruppiert per API',
    route_ids: [rid],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.bundle.routes.length, 1);
});

test('POST rejects a private direct target_ip (SSRF parity)', async () => {
  const res = await POST('/api/v1/service-bundles', {
    name: 'ssrf', domain: 'ssrf.example.com',
    target: { target_kind: 'peer', target_ip: '192.168.1.1' },
    http: { target_port: 80 },
  });
  assert.equal(res.status, 400);
});

test('license: l4 exposures are denied when l4_routes limit is 0', async () => {
  const license = require('../src/services/license');
  license._overrideForTest({ http_routes: -1, l4_routes: 0 });
  const res = await POST('/api/v1/service-bundles', validBundle());
  assert.equal(res.status, 403);
  assert.equal(res.body.feature, 'l4_routes');

  // http-only bundle still works on the same license
  const httpOnly = await POST('/api/v1/service-bundles', {
    name: 'Nur Web', domain: 'http-only-lic.example.com',
    target: { target_kind: 'peer', peer_id: peerId },
    http: { target_port: 80 },
  });
  assert.equal(httpOnly.status, 201);
});

test('license: combined l4 count is checked against the limit', async () => {
  const license = require('../src/services/license');
  license._overrideForTest({ http_routes: -1, l4_routes: 1 });
  const res = await POST('/api/v1/service-bundles', {
    name: 'Zwei L4', domain: 'two-l4.example.com',
    target: { target_kind: 'peer', peer_id: peerId },
    l4: [
      { l4_protocol: 'tcp', l4_listen_port: 6001, target_port: 22 },
      { l4_protocol: 'tcp', l4_listen_port: 6002, target_port: 23 },
    ],
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.feature, 'l4_routes');
});
