'use strict';

// Gateway backend TLS fingerprint (docs/feature-release-b.md §13b):
// routes.backend_tls_fingerprint — normalisation (colons, case, prefix),
// BACKEND_TLS_FINGERPRINT_INVALID, only gateway HTTP routes with backend_https
// (inherited value cleared when the route stops qualifying), emitted in the
// gateway config payload only when set, config hash unchanged (the shared
// schema strips unknown keys).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, gateways;
let gw, rGw, rGwPlain, rDirect;

const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const fp = (id) => db.prepare('SELECT backend_tls_fingerprint FROM routes WHERE id = ?').get(id).backend_tls_fingerprint;

const HEX = 'ab'.repeat(32);
const COLONS = HEX.toUpperCase().match(/../g).join(':');

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  gateways = require('../src/services/gateways');
  require('../src/services/license')._overrideForTest({ gateway_http_targets: -1, gateway_peers: -1 });
  gw = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('GW', ?, '10.8.0.9/32', 1, 'gateway')")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid;
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive)
    VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, 1)`).run(gw);
  const ins = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind, target_peer_id, target_lan_host, target_lan_port, backend_https, https_enabled)
    VALUES (?, '127.0.0.1', 8080, 'http', ?, ?, ?, ?, ?, 0)`);
  rGw = ins.run('nas.fp.test', 'gateway', gw, '192.168.1.10', 5001, 1).lastInsertRowid;
  rGwPlain = ins.run('plain.fp.test', 'gateway', gw, '192.168.1.11', 80, 0).lastInsertRowid;
  rDirect = db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, backend_https, https_enabled) VALUES ('direct.fp.test', '93.184.216.34', 443, 'http', 1, 0)").run().lastInsertRowid;
});

after(() => teardown());

test('normalisation: colons, upper case and a sha256: prefix → 64 hex lower case', () => {
  const { normalizeBackendFingerprint } = require('../src/services/routesValidation');
  assert.equal(normalizeBackendFingerprint(COLONS), HEX);
  assert.equal(normalizeBackendFingerprint(`SHA256:${HEX.toUpperCase()}`), HEX);
  assert.equal(normalizeBackendFingerprint(`sha256=${COLONS}`), HEX);
  assert.equal(normalizeBackendFingerprint(' '), null);
  assert.equal(normalizeBackendFingerprint(null), null);
  for (const bad of ['ab', 'zz'.repeat(32), HEX + 'ab', 'ab:'.repeat(31)]) {
    assert.throws(() => normalizeBackendFingerprint(bad), (e) => e.code === 'BACKEND_TLS_FINGERPRINT_INVALID' && e.statusCode === 400, bad);
  }
});

test('PUT /routes/:id stores the normalised fingerprint on a gateway route with backend_https', async () => {
  const r = await PUT(`/routes/${rGw}`, { backend_tls_fingerprint: COLONS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.route.backend_tls_fingerprint, HEX);
  assert.equal(fp(rGw), HEX);
  // PATCH semantics: another field keeps it.
  await PUT(`/routes/${rGw}`, { description: 'x' }).expect(200);
  assert.equal(fp(rGw), HEX);
});

test('invalid value and non-qualifying routes → 400 BACKEND_TLS_FINGERPRINT_INVALID', async () => {
  let r = await PUT(`/routes/${rGw}`, { backend_tls_fingerprint: 'nope' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'BACKEND_TLS_FINGERPRINT_INVALID');
  r = await PUT(`/routes/${rGwPlain}`, { backend_tls_fingerprint: HEX });
  assert.equal(r.status, 400, 'gateway route without backend_https'); assert.equal(r.body.code, 'BACKEND_TLS_FINGERPRINT_INVALID');
  r = await PUT(`/routes/${rDirect}`, { backend_tls_fingerprint: HEX });
  assert.equal(r.status, 400, 'not a gateway route'); assert.equal(r.body.code, 'BACKEND_TLS_FINGERPRINT_INVALID');
  // In one write with backend_https: allowed.
  r = await PUT(`/routes/${rGwPlain}`, { backend_https: true, backend_tls_fingerprint: HEX });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fp(rGwPlain), HEX);
  // backend_https off → the inherited fingerprint is cleared.
  r = await PUT(`/routes/${rGwPlain}`, { backend_https: false });
  assert.equal(r.status, 200);
  assert.equal(fp(rGwPlain), null);
  // Empty string clears.
  r = await PUT(`/routes/${rGw}`, { backend_tls_fingerprint: '' });
  assert.equal(r.status, 200);
  assert.equal(fp(rGw), null);
});

test('POST /routes accepts it for a new gateway route', async () => {
  const r = await POST('/routes', {
    domain: 'new.fp.test', target_port: 8080, https_enabled: false, backend_https: true,
    target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.1.20', target_lan_port: 443,
    backend_tls_fingerprint: COLONS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(fp(r.body.route.id), HEX);
});

test('gateway config: field only when set; config hash identical with and without it', () => {
  const lib = require('@callmetechie/gatecontrol-config-hash');
  db.prepare('UPDATE routes SET backend_tls_fingerprint = NULL WHERE id = ?').run(rGw);
  const cfgWithout = gateways.getGatewayConfig(gw);
  const without = cfgWithout.routes.find((x) => x.id === rGw);
  assert.ok(!('backend_tls_fingerprint' in without), 'absent when not set');
  const hashWithout = gateways.computeConfigHash(gw);

  db.prepare('UPDATE routes SET backend_tls_fingerprint = ? WHERE id = ?').run(HEX, rGw);
  const cfg = gateways.getGatewayConfig(gw);
  assert.equal(cfg.routes.find((x) => x.id === rGw).backend_tls_fingerprint, HEX);
  for (const other of cfg.routes.filter((x) => x.id !== rGw)) {
    if (other.id !== rGw && !other.backend_tls_fingerprint) assert.ok(!('backend_tls_fingerprint' in other));
  }
  // The shared schema strips unknown keys (zod .strip()): the payload parses,
  // and the hash does not see the field.
  const parsed = lib.GatewayConfigSchema.parse(cfg);
  assert.ok(!('backend_tls_fingerprint' in parsed.routes.find((x) => x.id === rGw)));
  assert.equal(gateways.computeConfigHash(gw), hashWithout);

  // A stored value on a route that no longer has backend_https is not emitted.
  db.prepare('UPDATE routes SET backend_https = 0 WHERE id = ?').run(rGw);
  assert.ok(!('backend_tls_fingerprint' in gateways.getGatewayConfig(gw).routes.find((x) => x.id === rGw)));
  db.prepare('UPDATE routes SET backend_https = 1 WHERE id = ?').run(rGw);
});

test('the fingerprint never reaches the Caddy config', () => {
  const cfg = JSON.stringify(require('../src/services/caddyConfig').buildCaddyConfig());
  assert.ok(!cfg.includes(HEX));
});

// config-hash >= 1.3.0 knows the field and REJECTS a malformed value, which
// would make the whole gateway-config response throw. Writes normalise, so
// this only guards rows from a hand-edited database or an old restore.
test('gateway config drops a malformed fingerprint instead of shipping it', () => {
  const { getDb } = require('../src/db/connection');
  const db = getDb();
  const id = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind, target_peer_id,
      target_lan_host, target_lan_port, backend_https, backend_tls_fingerprint, enabled)
    VALUES ('fp-bad.example.com', '127.0.0.1', 8080, 'http', 'gateway', ?, '192.168.1.10', 443, 1, ?, 1)`)
    .run(gw, "NOT-A-FINGERPRINT").lastInsertRowid;
  try {
    const cfg = require('../src/services/gateways').getGatewayConfig(gw);
    const row = cfg.routes.find((r) => r.id === id);
    assert.ok(row, 'route is in the config');
    assert.equal('backend_tls_fingerprint' in row, false, 'malformed value is not shipped');
  } finally {
    db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  }
});
