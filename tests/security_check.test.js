'use strict';

// Security check + exposure (docs/feature-release-b.md §1 + §10):
// GET /api/v1/security/check — every check id, statuses, fixes, summary,
// licence-dependent na, CAA cache + time budget (pending + SSE `security`);
// GET /api/v1/security/exposure — public entries only, protections, sorting;
// token scope `routes`.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

let agent, db, license, sec;
let zoneId, zone2Id, rHttps, rNoHsts, rProtected, rInternal, rL4, rOff, rGw;
const caaCalls = [];
let caaMode = 'none';

const GET = (p) => agent.get('/api/v1' + p);
const byId = (body) => Object.fromEntries(body.checks.map((c) => [c.id, c]));

function insertRoute(domain, extra = {}) {
  const cols = { domain, target_ip: '93.184.216.34', target_port: 80, route_type: 'http', https_enabled: 1, external_enabled: 1, ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
}
function host(domainId, sub, fqdn) {
  return db.prepare('INSERT INTO service_bundles (name, domain, domain_id, subdomain) VALUES (?, ?, ?, ?)').run(fqdn, fqdn, domainId, sub).lastInsertRowid;
}

before(async () => {
  await setup();
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  sec = require('../src/services/securityCheck');
  license._overrideForTest({ waf: true, scheduled_backups: true });
  sec._setCaaLookupForTest(async (zone) => {
    caaCalls.push(zone);
    if (caaMode === 'slow') return new Promise((resolve) => setTimeout(() => resolve({ status: 'allows', suggestion: null }), 400));
    if (zone === 'secure.example') return { status: 'allows', suggestion: null };
    return { status: 'none', suggestion: `${zone}. CAA 0 issue "letsencrypt.org"` };
  });

  zoneId = db.prepare("INSERT INTO domains (domain, status, tls_min_version) VALUES ('shop.example', 'verified', '1.2')").run().lastInsertRowid;
  zone2Id = db.prepare("INSERT INTO domains (domain, status, tls_min_version) VALUES ('secure.example', 'verified', '1.3')").run().lastInsertRowid;
  rHttps = insertRoute('www.shop.example', { hsts_enabled: 1, waf_enabled: 1, waf_mode: 'block', rate_limit_enabled: 1, bundle_id: host(zoneId, 'www', 'www.shop.example') });
  rNoHsts = insertRoute('api.shop.example', { bundle_id: host(zoneId, 'api', 'api.shop.example') });
  rProtected = insertRoute('admin.secure.example', { ip_filter_enabled: 1, waf_enabled: 1, waf_mode: 'detect', bundle_id: host(zone2Id, 'admin', 'admin.secure.example') });
  rInternal = insertRoute('intern.shop.example', { external_enabled: 0 });
  rOff = insertRoute('off.shop.example', { enabled: 0 });
  rL4 = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, external_enabled, https_enabled)
    VALUES (NULL, '93.184.216.35', 22, 'l4', 'tcp', '2222', 1, 0)`).run().lastInsertRowid;
  const gw = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('GW', ?, '10.8.0.9/32', 1, 'gateway')")
    .run(crypto.randomBytes(16).toString('hex')).lastInsertRowid;
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive)
    VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, 1)`).run(gw);
  rGw = insertRoute('nas.shop.example', { target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.2.151', target_lan_port: 8096, basic_auth_enabled: 1, basic_auth_user: 'u', basic_auth_password_hash: 'h' });
});

after(() => { sec._setCaaLookupForTest(null); license._overrideForTest({ waf: false }); teardown(); });

test('GET /security/check: shape, ids in order, summary counts', async () => {
  const r = await GET('/security/check');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(r.body.checks.map((c) => c.id),
    ['admin_2fa', 'require_2fa', 'hsts', 'caa', 'waf_coverage', 'waf_ready', 'public_unprotected', 'backup_offsite', 'tls_min', 'auto_update']);
  for (const c of r.body.checks) {
    assert.ok(['critical', 'warning', 'info'].includes(c.severity), c.id);
    assert.ok(['pass', 'fail', 'na'].includes(c.status), c.id);
    assert.equal(c.count, c.status === 'fail' ? c.items.length : 0, c.id);
    for (const it of c.items) assert.deepEqual(Object.keys(it).sort(), ['id', 'kind', 'label']);
  }
  const s = { pass: 0, fail: 0, info: 0 };
  for (const c of r.body.checks) {
    if (c.status === 'pass') s.pass++;
    else if (c.status === 'fail') s[c.severity === 'info' ? 'info' : 'fail']++;
  }
  assert.deepEqual(r.body.summary, s);
});

test('admin_2fa + require_2fa: fail with own-account link, na until every admin has 2FA, then an api fix', async () => {
  let c = byId((await GET('/security/check')).body);
  assert.equal(c.admin_2fa.status, 'fail');
  assert.equal(c.admin_2fa.severity, 'critical');
  assert.equal(c.admin_2fa.items[0].kind, 'user');
  assert.equal(c.admin_2fa.items[0].label, 'admin');
  assert.deepEqual(c.admin_2fa.fix, { type: 'link', href: '/profile#two-factor' });
  assert.equal(c.require_2fa.status, 'na');

  db.prepare("UPDATE users SET totp_enabled = 1 WHERE role = 'admin'").run();
  c = byId((await GET('/security/check')).body);
  assert.equal(c.admin_2fa.status, 'pass');
  assert.equal(c.require_2fa.status, 'fail');
  assert.deepEqual(c.require_2fa.fix, { type: 'api', method: 'PUT', url: '/api/v1/settings/security', body: { require_2fa: true } });
  require('../src/services/settings').set('security.require_2fa', 'true');
  c = byId((await GET('/security/check')).body);
  assert.equal(c.require_2fa.status, 'pass');
});

test('hsts: active HTTPS entries without HSTS, bulk fix (1 year, no preload)', async () => {
  const c = byId((await GET('/security/check')).body).hsts;
  assert.equal(c.status, 'fail');
  const ids = c.items.map((i) => i.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [rNoHsts, rProtected, rInternal, rGw].sort((a, b) => a - b), 'active only (not the disabled, not L4)');
  assert.deepEqual(c.fix, { type: 'api', method: 'POST', url: '/api/v1/routes/bulk', body: { ids: c.items.map((i) => i.id), set: { hsts_enabled: true, hsts_max_age: 31536000 } } });
});

test('caa: zones without CAA → copy of the suggestion; cached (no second lookup)', async () => {
  caaCalls.length = 0;
  sec._resetCaaCacheForTest();
  let c = byId((await GET('/security/check')).body).caa;
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.items, [{ kind: 'zone', id: zoneId, label: 'shop.example' }]);
  assert.deepEqual(c.fix, { type: 'copy', copy: 'shop.example. CAA 0 issue "letsencrypt.org"' });
  assert.equal(c.pending, 0);
  assert.deepEqual(caaCalls.sort(), ['secure.example', 'shop.example']);
  c = byId((await GET('/security/check')).body).caa;
  assert.equal(caaCalls.length, 2, 'served from the cache');
});

test('caa: time budget — slow lookups are pending, the request does not wait, SSE security when done', async () => {
  sec._resetCaaCacheForTest();
  caaMode = 'slow';
  const got = [];
  const bus = require('../src/services/eventBus');
  const l = (e) => { if (e.type === 'security') got.push(e.payload); };
  bus.subscribe(l);
  try {
    const t0 = Date.now();
    const body = await sec.runCheck({ budgetMs: 50 });
    assert.ok(Date.now() - t0 < 350, 'does not wait for the lookups');
    const c = byId(body).caa;
    assert.equal(c.status, 'na');
    assert.equal(c.pending, 2);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(got, [{ reason: 'caa' }]);
    assert.equal(byId(await sec.runCheck({ budgetMs: 50 })).caa.status, 'pass', 'late results land in the cache');
  } finally { bus.unsubscribe(l); caaMode = 'none'; sec._resetCaaCacheForTest(); }
});

test('the real endpoint never blocks longer than 5 s (default budget)', () => {
  assert.ok(sec.CAA_BUDGET_MS <= 4000);
  assert.ok(sec.CAA_TTL_MS >= 3600 * 1000);
});

test('waf_coverage + waf_ready: public HTTP entries without WAF; na without the licence', async () => {
  let c = byId((await GET('/security/check')).body);
  assert.equal(c.waf_coverage.status, 'fail');
  assert.deepEqual(c.waf_coverage.items.map((i) => i.id).sort((a, b) => a - b), [rNoHsts, rGw].sort((a, b) => a - b));
  assert.deepEqual(c.waf_coverage.fix.body.set, { waf_enabled: true, waf_mode: 'detect', waf_paranoia: 1 });
  assert.equal(c.waf_ready.status, 'pass', 'the detect route is too early');

  db.prepare('UPDATE routes SET waf_mode_changed_at = ? WHERE id = ?').run(new Date(Date.now() - 50 * 3600000).toISOString(), rProtected);
  db.prepare(`INSERT INTO waf_events (ts, host, route_id, client_ip, rule_id, message, action, tx_id)
    VALUES (?, 'admin.secure.example', ?, '45.33.32.9', 920350, 'x', 'detected', 't1')`).run(new Date().toISOString(), rProtected);
  c = byId((await GET('/security/check')).body);
  assert.equal(c.waf_ready.status, 'fail');
  assert.equal(c.waf_ready.severity, 'info');
  assert.deepEqual(c.waf_ready.items, [{ kind: 'route', id: rProtected, label: 'admin.secure.example' }]);
  assert.deepEqual(c.waf_ready.fix, { type: 'link', href: '/waf#assistant' });

  license._overrideForTest({ waf: false });
  try {
    c = byId((await GET('/security/check')).body);
    assert.equal(c.waf_coverage.status, 'na');
    assert.equal(c.waf_ready.status, 'na');
  } finally { license._overrideForTest({ waf: true }); }
});

test('public_unprotected, tls_min, backup_offsite, auto_update', async () => {
  let c = byId((await GET('/security/check')).body);
  assert.equal(c.public_unprotected.status, 'fail');
  assert.equal(c.public_unprotected.severity, 'info');
  assert.deepEqual(c.public_unprotected.items.map((i) => i.id).sort((a, b) => a - b), [rHttps, rNoHsts].sort((a, b) => a - b),
    'basic auth / ip filter protect; internal, disabled and L4 are out');
  assert.equal(c.tls_min.status, 'fail');
  assert.deepEqual(c.tls_min.items, [{ kind: 'zone', id: zoneId, label: 'shop.example' }]);
  assert.equal(c.backup_offsite.status, 'fail', 'no off-site target');
  assert.deepEqual(c.backup_offsite.fix, { type: 'link', href: '/settings#backup' });
  assert.equal(c.auto_update.status, 'na', 'update.sh not set up in the test env');

  license._overrideForTest({ scheduled_backups: false });
  try { assert.equal(byId((await GET('/security/check')).body).backup_offsite.status, 'na'); }
  finally { license._overrideForTest({ scheduled_backups: true }); }

  // With a target table (strand B1, v76): fresh successful upload → pass; stale → fail.
  db.exec(`CREATE TABLE IF NOT EXISTS backup_targets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config_enc TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, keep INTEGER NOT NULL DEFAULT 14, last_run_at TEXT, last_status TEXT, last_error TEXT, created_at TEXT NOT NULL)`);
  const t = db.prepare("INSERT INTO backup_targets (name, type, config_enc, last_run_at, last_status, created_at) VALUES ('NAS', 'sftp', 'x', ?, 'ok', 'now')")
    .run(new Date().toISOString()).lastInsertRowid;
  assert.equal(byId((await GET('/security/check')).body).backup_offsite.status, 'pass');
  db.prepare('UPDATE backup_targets SET last_run_at = ? WHERE id = ?').run(new Date(Date.now() - 49 * 3600000).toISOString(), t);
  c = byId((await GET('/security/check')).body).backup_offsite;
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.items, [{ kind: 'target', id: t, label: 'NAS' }]);
  db.prepare("UPDATE backup_targets SET last_run_at = ?, last_status = 'failed' WHERE id = ?").run(new Date().toISOString(), t);
  assert.equal(byId((await GET('/security/check')).body).backup_offsite.status, 'fail');
});

test('GET /security/exposure: public entries only, sorted by host, protections', async () => {
  const r = await GET('/security/exposure');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.entries.map((e) => e.route_id);
  assert.ok(!ids.includes(rInternal) && !ids.includes(rOff));
  assert.deepEqual(r.body.entries.map((e) => e.host), ['admin.secure.example', 'api.shop.example', 'nas.shop.example', 'www.shop.example', null]);
  const e = Object.fromEntries(r.body.entries.map((x) => [x.route_id, x]));
  assert.deepEqual(e[rHttps], {
    route_id: rHttps, host: 'www.shop.example', zone: 'shop.example', type: 'http', target: '93.184.216.34:80', health: 'unknown',
    protections: { auth: null, mtls: false, ip_filter: false, waf: 'block', hsts: true, rate_limit: true, tls_min: '1.2' },
  });
  assert.equal(e[rProtected].protections.tls_min, '1.3');
  assert.equal(e[rProtected].protections.ip_filter, true);
  assert.equal(e[rProtected].protections.waf, 'detect');
  assert.equal(e[rGw].target, '192.168.2.151:8096');
  assert.equal(e[rGw].protections.auth, 'basic');
  assert.equal(e[rGw].health, 'ok', 'gateway alive');
  assert.equal(e[rGw].zone, 'shop.example', 'zone by suffix without a host link');
  assert.equal(e[rL4].type, 'l4');
  assert.equal(e[rL4].target, '93.184.216.35:22');
  assert.equal(e[rL4].listen_port, '2222');
  assert.deepEqual(e[rL4].protections, { auth: null, mtls: false, ip_filter: false, waf: null, hsts: false, rate_limit: false, tls_min: '1.2' });

  db.prepare("UPDATE routes SET monitoring_enabled = 1, monitoring_status = 'down' WHERE id = ?").run(rHttps);
  const again = (await GET('/security/exposure')).body.entries.find((x) => x.route_id === rHttps);
  assert.equal(again.health, 'down');
});

test('token scope: /api/v1/security → routes', () => {
  const { checkScope } = require('../src/services/tokens');
  assert.equal(checkScope(['routes'], '/api/v1/security/check', 'GET'), true);
  assert.equal(checkScope(['routes'], '/api/v1/security/exposure', 'GET'), true);
  assert.equal(checkScope(['peers'], '/api/v1/security/check', 'GET'), false);
});
