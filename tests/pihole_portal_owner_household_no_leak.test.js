// tests/pihole_portal_owner_household_no_leak.test.js
'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { setup, teardown, getAgent } = require('./helpers/setup');
let getDb, pihole, license, adminId, p1, foreignPeer, foreignUser;
beforeEach(async () => {
  await setup();
  getDb = require('../src/db/connection').getDb;
  pihole = require('../src/services/pihole'); license = require('../src/services/license'); license.hasFeature = () => true;
  adminId = getDb().prepare("SELECT id FROM users WHERE username='admin'").get().id;
  p1 = getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type,user_id) VALUES ('m1','k1','10.8.0.5/32',1,'regular',?)").run(adminId).lastInsertRowid;
  foreignUser = getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES ('bob','x','admin')").run().lastInsertRowid;
  foreignPeer = getDb().prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type,user_id) VALUES ('b1','k3','10.8.0.50/32',1,'regular',?)").run(foreignUser).lastInsertRowid;
});
afterEach(() => { teardown(); });

test('owner endpoint: response exposes only the aggregate, never foreign device or raw fields', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1,
    topClients:[{ ip:'10.8.0.5', count:100, peerId:p1, peerName:'m1' }, { ip:'10.8.0.50', count:999, peerId:foreignPeer, peerName:'b1' }],
    topClientsBlocked:[{ ip:'10.8.0.5', count:10, peerId:p1, peerName:'m1' }] });
  const r = await getAgent().get('/api/v1/portal/pihole/owner').expect(200);
  const raw = JSON.stringify(r.body);
  assert.equal(r.body.data.allowed, 100);
  // exhaustive key whitelist — cannot be gamed by field-name collisions
  assert.deepEqual(Object.keys(r.body.data).sort(), ['allowed','asOf','blocked','blockedPct','deviceCount','total']);
  assert.ok(!raw.includes('10.8.0.50') && !raw.includes('b1'), 'foreign device leaked');
  assert.ok(!/\bip\b|peerId|peerName|user_id|owner_name|topClients/.test(raw), 'raw field leaked: ' + raw);
});
test('household endpoint: only the global aggregate, no client list', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1,
    summary:{ queries:{ total:9, blocked:3 }, clients:{ active:2 } },
    topClients:[{ ip:'10.8.0.50', count:999, peerId:foreignPeer, peerName:'b1' }] });
  const r = await getAgent().get('/api/v1/portal/pihole/household').expect(200);
  const raw = JSON.stringify(r.body);
  assert.equal(r.body.data.total, 9);
  assert.deepEqual(Object.keys(r.body.data).sort(), ['activeClients','asOf','blocked','blockedPct','total']);
  assert.ok(!/peerId|peerName|topClients|\bip\b|10\.8\.0\.50/.test(raw), 'raw field leaked: ' + raw);
});
test('structural: owner+household handlers serialize only locally-built aggregates', () => {
  const src = fs.readFileSync(path.join(__dirname,'..','src','routes','api','portal.js'),'utf8');
  for (const route of ['/pihole/owner','/pihole/household']) {
    // String-based extraction (indexOf + brace-counting) — immune to regex-escaping bugs.
    const start = src.indexOf("router.get('" + route + "'");
    assert.ok(start !== -1, route + ' handler not found');
    let depth = 0, i = start, end = -1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      i++;
    }
    assert.ok(end !== -1, route + ' handler not terminated');
    const body = src.slice(start, end + 1);
    // Regex LITERALS on the extracted string — single-escaped, verified to match real code.
    assert.ok(!/res\.json\(\s*cache\s*\)/.test(body) && !/res\.json\(\s*\{[\s\S]*?\.\.\.\s*cache/.test(body), route + ' returns/spreads raw cache');
    // [^\n]* (same-line only) avoids false-positives from `res.json(...)` early-exit
    // guards that appear in the body BEFORE the topClients loop lines.  A real leak
    // (e.g. `res.json({ data: cache.topClients })`) would be on one line → still caught.
    assert.ok(!/res\.json\([^\n]*topClients/.test(body), route + ' serializes topClients');
  }
});
