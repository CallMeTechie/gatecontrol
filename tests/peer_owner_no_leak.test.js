'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

// Home-vhost Host header (matches default GC_DNS_DOMAIN = 'gc.internal').
// portalIdentity only establishes identity when Host === effectivePortalHost().host.
const HOME_HOST = 'home.gc.internal';

let app, getDb;
beforeEach(async () => {
  await setup();
  getDb = require('../src/db/connection').getDb;
  app = require('../src/app').createApp();
});
afterEach(teardown);

test('portal /device whitelists fields and never emits user_id/owner_name (behavioral)', async () => {
  // Insert a peer so the handler returns data rather than the `unidentified` envelope.
  // Identity is established via loopback (supertest behavior, like Caddy), the
  // X-GC-Portal-Peer-IP header (reserved; read by portalIdentity to set req.portalPeerId),
  // and the home Host vhost (matches effectivePortalHost().host for mgmt-vhost anti-forgery).
  // This test FAILS if the peer is not identified (data would be null).
  getDb().prepare(
    `INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
     VALUES ('devP','pk-no-leak-test','10.8.0.99/32',1,'regular')`
  ).run();

  const res = await supertest(app)
    .get('/api/v1/portal/device')
    .set('X-GC-Portal-Peer-IP', '10.8.0.99')
    .set('Host', HOME_HOST)
    .expect(200);

  assert.equal(res.body.ok, true);
  assert.ok(res.body.data !== null, 'peer should be identified and data must be returned (not unidentified)');
  assert.ok(!('user_id' in res.body.data), 'portal /device must not expose user_id');
  assert.ok(!('owner_name' in res.body.data), 'portal /device must not expose owner_name');
});

test('client-facing + portal route sources never reference user_id/owner_name', () => {
  const clientDir = path.join(__dirname, '..', 'src/routes/api/client');
  const clientFiles = fs.existsSync(clientDir)
    ? fs.readdirSync(clientDir)
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(clientDir, f))
    : [];
  const portalFile = path.join(__dirname, '..', 'src/routes/api/portal.js');
  const candidates = [
    ...clientFiles,
    ...(fs.existsSync(portalFile) ? [portalFile] : []),
  ];

  // Guard: a scan matching zero files is silent-green and worthless.
  // At minimum portal.js + at least one client/*.js file must be present.
  assert.ok(
    candidates.length >= 2,
    `source scan matched only ${candidates.length} file(s) — expected at least 2 (portal.js + ≥1 client route)`
  );

  for (const f of candidates) {
    const src = fs.readFileSync(f, 'utf8');
    // Must not contain any reference to the owner-mapping columns.
    assert.ok(
      !/\buser_id\b|\bowner_name\b/.test(src),
      `${path.basename(f)} must not reference owner mapping (user_id / owner_name)`
    );
    // Must not return a raw peer object: res.json(peer) or res.json({ ...peer ... }).
    assert.ok(
      !/res\.json\(\s*peer\s*\)/.test(src) && !/res\.json\(\s*\{[^}]*\.\.\.\s*\w*peer\w*/.test(src),
      `${path.basename(f)} must not return a raw peer object`
    );
  }
});
