// tests/pihole_portal_no_leak.test.js
'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const config = require('../config/default');
const HOME_HOST = `home.${config.dns.domain}`;

let app, getDb, pihole, license, peerId, otherId;
beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
  getDb = require('../src/db/connection').getDb;
  pihole = require('../src/services/pihole');
  license = require('../src/services/license');
  peerId = getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type) VALUES ('Mine','k1','10.8.0.9/32',1,'regular')").run().lastInsertRowid;
  otherId = getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type) VALUES ('Other','k2','10.8.0.50/32',1,'regular')").run().lastInsertRowid;
  license.hasFeature = () => true;
});
afterEach(() => { teardown(); });

test('behavioral: response exposes only the aggregate, never other devices or raw fields', async () => {
  pihole.getCache = () => ({
    instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt: 1750000000000,
    topClients:        [{ ip:'10.8.0.9', count:100, peerId, peerName:'Mine' },  { ip:'10.8.0.50', count:999, peerId: otherId, peerName:'Other' }],
    topClientsBlocked: [{ ip:'10.8.0.9', count:10,  peerId, peerName:'Mine' },  { ip:'10.8.0.50', count:500, peerId: otherId, peerName:'Other' }],
  });
  const r = await supertest(app).get('/api/v1/portal/pihole').set('X-GC-Portal-Peer-IP','10.8.0.9').set('Host', HOME_HOST).expect(200);
  const raw = JSON.stringify(r.body);
  // only this device's numbers
  assert.equal(r.body.data.allowed, 100);
  assert.equal(r.body.data.blocked, 10);
  // no other device, no ip, no peerId, no owner mapping
  assert.ok(!raw.includes('10.8.0.50'), 'other device IP leaked');
  assert.ok(!raw.includes('Other'), 'other device name leaked');
  assert.ok(!/\bip\b|peerId|peerName|user_id|owner_name|topClients/.test(raw), 'raw field leaked: ' + raw);
  assert.equal(r.body.data.total, 110); // 999/500 of the other device must NOT appear
});

test('structural: the /pihole handler (server) serializes only a locally built aggregate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api', 'portal.js'), 'utf8');
  // isolate the /pihole handler body — capture group 1 starts at const pid (the
  // device-scoped logic), so topClients references appear BEFORE any res.json() in
  // that scope; \s* before the closing brace tolerates 2-space indentation
  const m = src.match(/router\.get\(\s*['"]\/pihole['"][\s\S]*?(const pid\s*=[\s\S]*?)\n\s*\}\);/);
  assert.ok(m, '/pihole handler not found');
  const body = m[1]; // capture group 1: device-scoped logic only (after early-exit gates)
  // [\s\S]*? (not [^)]/[^}]) so multi-line res.json(...) calls can't slip past
  assert.ok(!/res\.json\(\s*cache\s*\)/.test(body), 'handler returns raw cache');
  assert.ok(!/res\.json\(\s*\{[\s\S]*?\.\.\.\s*cache/.test(body), 'handler spreads cache into response');
  assert.ok(!/res\.json\(\s*[\s\S]*?topClients/.test(body), 'handler serializes topClients');
  // the success res.json must reference the whitelisted keys
  assert.ok(/total[\s\S]*blocked[\s\S]*allowed[\s\S]*blockedPct[\s\S]*asOf/.test(body), 'whitelisted aggregate keys missing');
});
