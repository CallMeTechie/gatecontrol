'use strict';

// POST /api/v1/routes/bulk (docs/feature-release-b.md §2): all-or-nothing
// validation with the PUT /routes/:id rules, licence gates, one transaction,
// exactly one Caddy sync, full rollback on sync failure, activity log,
// routes.waf_mode_changed_at.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, license;
let rHttps, rPlain, rL4, rOff;
let syncCount = 0;
let failNextSync = null;

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const row = (id) => db.prepare('SELECT * FROM routes WHERE id = ?').get(id);

function insertRoute(domain, extra = {}) {
  const cols = { domain, target_ip: '10.0.0.5', target_port: 80, route_type: 'http', https_enabled: 0, external_enabled: 1, ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
}

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  license._overrideForTest({ waf: true, uptime_monitoring: true, http_routes: -1, l4_routes: -1 });
  const caddy = require('../src/services/caddyConfig');
  const orig = caddy.syncToCaddy;
  caddy.syncToCaddy = async () => {
    syncCount++;
    if (failNextSync) { const m = failNextSync; failNextSync = null; throw new Error(m); }
    return orig();
  };
  rHttps = insertRoute('https.bulk.test', { https_enabled: 1 });
  rPlain = insertRoute('plain.bulk.test');
  rOff = insertRoute('off.bulk.test', { https_enabled: 1, enabled: 0 });
  rL4 = db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, external_enabled) VALUES (NULL, '10.0.0.6', 22, 'l4', 'tcp', '2222', 1)").run().lastInsertRowid;
});

after(() => { license._overrideForTest({ waf: false }); teardown(); });

test('one invalid route → 400 BULK_INVALID with every failure, nothing written, no sync', async () => {
  const before = syncCount;
  const r = await POST('/routes/bulk', { ids: [rHttps, rPlain, rL4, 999999], set: { hsts_enabled: true, hsts_max_age: 31536000 } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 'BULK_INVALID');
  const byId = Object.fromEntries(r.body.failed.map((f) => [f.id, f]));
  assert.equal(byId[rPlain].code, 'HSTS_REQUIRES_HTTPS');
  assert.equal(byId[rL4].code, 'HSTS_REQUIRES_HTTPS');
  assert.equal(byId[999999].code, 'NOT_FOUND');
  assert.ok(!byId[rHttps], 'the valid route is not listed');
  assert.equal(row(rHttps).hsts_enabled, 0, 'valid route untouched too');
  assert.equal(syncCount, before);
});

test('WAF on for several routes: one sync, changed count, waf_mode_changed_at, activity log', async () => {
  const before = syncCount;
  const r = await POST('/routes/bulk', { ids: [rHttps, rPlain], set: { waf_enabled: true, waf_mode: 'detect', waf_paranoia: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, updated: [rHttps, rPlain], changed: 2 });
  assert.equal(syncCount, before + 1, 'exactly one Caddy sync');
  for (const id of [rHttps, rPlain]) {
    const x = row(id);
    assert.deepEqual([x.waf_enabled, x.waf_mode, x.waf_paranoia], [1, 'detect', 2]);
    assert.match(x.waf_mode_changed_at, /^\d{4}-\d{2}-\d{2}T/);
  }
  const log = db.prepare("SELECT * FROM activity_log WHERE event_type = 'routes_bulk_update' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log, 'activity entry');
  assert.deepEqual(JSON.parse(log.details).routeIds, [rHttps, rPlain]);

  // Paranoia only: waf_mode_changed_at stays.
  const stamp = row(rHttps).waf_mode_changed_at;
  const again = await POST('/routes/bulk', { ids: [rHttps], set: { waf_paranoia: 3 } });
  assert.equal(again.status, 200);
  assert.equal(row(rHttps).waf_paranoia, 3);
  assert.equal(row(rHttps).waf_mode_changed_at, stamp);
});

test('nothing to change → changed 0 and no sync', async () => {
  const before = syncCount;
  const r = await POST('/routes/bulk', { ids: [rHttps, rPlain], set: { waf_enabled: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, updated: [rHttps, rPlain], changed: 0 });
  assert.equal(syncCount, before);
});

test('WAF on an L4 route → WAF_REQUIRES_HTTP; HSTS on HTTPS routes works', async () => {
  let r = await POST('/routes/bulk', { ids: [rL4], set: { waf_enabled: true } });
  assert.equal(r.status, 400);
  assert.equal(r.body.failed[0].code, 'WAF_REQUIRES_HTTP');
  r = await POST('/routes/bulk', { ids: [rHttps, rOff], set: { hsts_enabled: true, hsts_max_age: 31536000, hsts_subdomains: false } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row(rHttps).hsts_enabled, 1);
  assert.equal(row(rOff).hsts_enabled, 1);
  r = await POST('/routes/bulk', { ids: [rHttps], set: { hsts_max_age: 10 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.failed[0].code, 'HSTS_MAX_AGE_INVALID');
});

test('request shape errors', async () => {
  let r = await POST('/routes/bulk', { ids: [], set: { enabled: true } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'BULK_IDS_INVALID');
  r = await POST('/routes/bulk', { ids: Array.from({ length: 201 }, (_, i) => i + 1), set: { enabled: true } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'BULK_IDS_INVALID');
  r = await POST('/routes/bulk', { ids: ['x'], set: { enabled: true } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'BULK_IDS_INVALID');
  r = await POST('/routes/bulk', { ids: [rHttps], set: {} });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'BULK_SET_INVALID');
  r = await POST('/routes/bulk', { ids: [rHttps], set: { domain: 'evil.test' } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'BULK_FIELD_INVALID');
  r = await POST('/routes/bulk', { ids: [rHttps], set: { enabled: 'yes' } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'BULK_FIELD_INVALID');
  r = await POST('/routes/bulk', { ids: [rHttps], set: { waf_mode: 'deny' } });
  assert.equal(r.status, 400); assert.equal(r.body.failed[0].code, 'WAF_MODE_INVALID');
});

test('licence gates: waf, uptime_monitoring, route limit on enable; disabling needs nothing', async () => {
  license._overrideForTest({ waf: false, uptime_monitoring: false });
  try {
    let r = await POST('/routes/bulk', { ids: [rPlain], set: { waf_enabled: true } });
    assert.equal(r.status, 403); assert.equal(r.body.feature, 'waf');
    r = await POST('/routes/bulk', { ids: [rPlain], set: { monitoring_enabled: true } });
    assert.equal(r.status, 403); assert.equal(r.body.feature, 'uptime_monitoring');
    r = await POST('/routes/bulk', { ids: [rPlain], set: { waf_enabled: false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(row(rPlain).waf_enabled, 0);
  } finally { license._overrideForTest({ waf: true, uptime_monitoring: true }); }

  const enabledHttp = db.prepare("SELECT COUNT(*) AS n FROM routes WHERE (route_type = 'http' OR route_type IS NULL) AND enabled = 1").get().n;
  license._overrideForTest({ http_routes: enabledHttp });
  try {
    const r = await POST('/routes/bulk', { ids: [rOff], set: { enabled: true } });
    assert.equal(r.status, 403); assert.equal(r.body.feature, 'http_routes');
    assert.equal(row(rOff).enabled, 0);
  } finally { license._overrideForTest({ http_routes: -1 }); }
});

test('enable/disable/external/monitoring in one go', async () => {
  const r = await POST('/routes/bulk', { ids: [rOff, rPlain], set: { enabled: true, external_enabled: false, monitoring_enabled: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const id of [rOff, rPlain]) {
    const x = row(id);
    assert.deepEqual([x.enabled, x.external_enabled, x.monitoring_enabled], [1, 0, 1]);
  }
});

test('Caddy sync failure → 502 CADDY_SYNC_FAILED and every row restored', async () => {
  const snapA = row(rHttps);
  const snapB = row(rPlain);
  failNextSync = 'Caddy admin API is not reachable';
  const r = await POST('/routes/bulk', { ids: [rHttps, rPlain], set: { waf_enabled: true, waf_mode: 'block', external_enabled: true } });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CADDY_SYNC_FAILED');
  // (monitoring_* columns belong to the monitor's async first check)
  const cols = (x) => { const o = { ...x }; for (const k of Object.keys(o)) if (k.startsWith('monitoring_')) delete o[k]; return o; };
  assert.deepEqual(cols(row(rHttps)), cols(snapA));
  assert.deepEqual(cols(row(rPlain)), cols(snapB));
});

test('token scope: /api/v1/routes/bulk is routes', () => {
  const { checkScope } = require('../src/services/tokens');
  assert.equal(checkScope(['routes'], '/api/v1/routes/bulk', 'POST'), true);
  assert.equal(checkScope(['peers'], '/api/v1/routes/bulk', 'POST'), false);
});
