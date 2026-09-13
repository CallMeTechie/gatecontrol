'use strict';

// WAF API + persistence (docs/feature-waf.md):
//   migration v74, route writes (waf_enabled/waf_mode/waf_paranoia, feature
//   gate `waf`, error codes), GET /waf/status, GET /waf/events (filters, keyset
//   cursor, rule_excluded), POST/DELETE /waf/routes/:id/exclusions (sync +
//   rollback, codes), token scope, retention cleanup.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, license, waf, caddy;
let rA, rB, rL4;
let syncCount = 0;
let failNextSync = null;

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const DEL = (p, body) => agent.delete('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const GET = (p) => agent.get('/api/v1' + p);
const routeRow = (id) => db.prepare('SELECT * FROM routes WHERE id = ?').get(id);

function insertRoute(domain, extra = {}) {
  const cols = { domain, target_ip: '10.0.0.5', target_port: 80, route_type: 'http', https_enabled: 0, ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
}
function insertEvent(over = {}) {
  const e = {
    ts: new Date().toISOString(), host: 'a.waf.test', route_id: rA, client_ip: '203.0.113.5', method: 'GET', uri: '/?q=x',
    rule_id: 941100, severity: 'critical', message: 'XSS Attack Detected via libinjection', action: 'blocked', tx_id: crypto.randomBytes(8).toString('hex'), raw: null,
    ...over,
  };
  return db.prepare(`INSERT INTO waf_events (ts, host, route_id, client_ip, method, uri, rule_id, severity, message, action, tx_id, raw)
    VALUES (@ts, @host, @route_id, @client_ip, @method, @uri, @rule_id, @severity, @message, @action, @tx_id, @raw)`).run(e).lastInsertRowid;
}

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  waf = require('../src/services/waf');
  caddy = require('../src/services/caddyConfig');
  license._overrideForTest({ waf: true });
  const orig = caddy.syncToCaddy;
  caddy.syncToCaddy = async () => {
    syncCount++;
    if (failNextSync) { const m = failNextSync; failNextSync = null; throw new Error(m); }
    return orig();
  };
  rA = insertRoute('a.waf.test');
  rB = insertRoute('b.waf.test', { waf_enabled: 1, waf_mode: 'block', waf_paranoia: 2 });
  rL4 = db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port) VALUES (NULL, '10.0.0.6', 22, 'l4', 'tcp', '2222')").run().lastInsertRowid;
});

after(() => { license._overrideForTest({ waf: false }); teardown(); });

// ─── Migration ──────────────────────────────────────────

test('migration v74 waf: route columns, waf_events table and indexes', () => {
  const cols = Object.fromEntries(db.prepare('PRAGMA table_info(routes)').all().map((c) => [c.name, c]));
  for (const [name, type, notnull, dflt] of [
    ['waf_enabled', 'INTEGER', 1, '0'],
    ['waf_mode', 'TEXT', 1, "'detect'"],
    ['waf_paranoia', 'INTEGER', 1, '1'],
    ['waf_exclusions', 'TEXT', 0, null],
  ]) {
    assert.ok(cols[name], name);
    assert.equal(cols[name].type.toUpperCase(), type, name);
    assert.equal(cols[name].notnull, notnull, name);
    assert.equal(cols[name].dflt_value, dflt, name);
  }
  const ev = db.prepare('PRAGMA table_info(waf_events)').all().map((c) => c.name);
  assert.deepEqual(ev, ['id', 'ts', 'host', 'route_id', 'client_ip', 'method', 'uri', 'rule_id', 'severity', 'message', 'action', 'tx_id', 'raw']);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'waf_events'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_waf_events_ts') && idx.includes('idx_waf_events_host'));
  assert.equal(db.prepare('SELECT name FROM migration_history WHERE version = 74').get().name, 'waf');
  assert.deepEqual(
    (({ waf_enabled, waf_mode, waf_paranoia, waf_exclusions }) => ({ waf_enabled, waf_mode, waf_paranoia, waf_exclusions }))(routeRow(rA)),
    { waf_enabled: 0, waf_mode: 'detect', waf_paranoia: 1, waf_exclusions: null },
  );
});

test('community fallback has waf: false', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/license'), 'utf8');
  assert.match(src, /\n\s+waf: false,/);
});

// ─── Route writes ───────────────────────────────────────

test('PUT /routes/:id stores waf fields; PATCH semantics keep them', async () => {
  let r = await PUT(`/routes/${rA}`, { waf_enabled: true, waf_mode: 'block', waf_paranoia: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.route.waf_enabled, 1);
  assert.equal(r.body.route.waf_mode, 'block');
  assert.equal(r.body.route.waf_paranoia, 3);
  r = await GET(`/routes/${rA}`);
  assert.deepEqual([r.body.route.waf_enabled, r.body.route.waf_mode, r.body.route.waf_paranoia, r.body.route.waf_exclusions], [1, 'block', 3, null]);
  r = await PUT(`/routes/${rA}`, { description: 'x' });
  assert.equal(r.status, 200);
  assert.deepEqual([routeRow(rA).waf_enabled, routeRow(rA).waf_mode, routeRow(rA).waf_paranoia], [1, 'block', 3]);
  r = await PUT(`/routes/${rA}`, { waf_enabled: false, waf_mode: 'detect', waf_paranoia: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual([routeRow(rA).waf_enabled, routeRow(rA).waf_mode, routeRow(rA).waf_paranoia], [0, 'detect', 1]);
});

test('PUT /routes/:id validation codes', async () => {
  let r = await PUT(`/routes/${rA}`, { waf_mode: 'deny' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_MODE_INVALID');
  r = await PUT(`/routes/${rA}`, { waf_paranoia: 5 });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_PARANOIA_INVALID');
  r = await PUT(`/routes/${rA}`, { waf_paranoia: 'x' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_PARANOIA_INVALID');
  r = await PUT(`/routes/${rL4}`, { waf_enabled: 1 });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_REQUIRES_HTTP');
  assert.equal(routeRow(rA).waf_mode, 'detect', 'nothing written');
});

test('feature gate `waf`: enabling needs the licence, disabling does not', async () => {
  license._overrideForTest({ waf: false });
  try {
    let r = await PUT(`/routes/${rA}`, { waf_enabled: true });
    assert.equal(r.status, 403); assert.equal(r.body.feature, 'waf');
    r = await PUT(`/routes/${rA}`, { waf_enabled: false });
    assert.equal(r.status, 200);
    r = await POST(`/waf/routes/${rA}/exclusions`, { rule_id: 941100 });
    assert.equal(r.status, 403); assert.equal(r.body.feature, 'waf');
    r = await GET('/waf/status');
    assert.equal(r.status, 200); assert.equal(r.body.licensed, false);
  } finally { license._overrideForTest({ waf: true }); }
});

test('POST /routes accepts waf fields on create', async () => {
  const r = await POST('/routes', {
    domain: 'created.waf.test', target_ip: '93.184.216.34', target_port: 8080, https_enabled: false,
    waf_enabled: true, waf_mode: 'detect', waf_paranoia: 2,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = routeRow(r.body.route.id);
  assert.deepEqual([row.waf_enabled, row.waf_mode, row.waf_paranoia, row.waf_exclusions], [1, 'detect', 2, null]);
  const bad = await POST('/routes', { domain: 'bad.waf.test', target_ip: '93.184.216.34', target_port: 8080, https_enabled: false, waf_mode: 'x' });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'WAF_MODE_INVALID');
});

// ─── Status / events ────────────────────────────────────

test('GET /waf/status: engine flag, WAF routes with 24 h counters (requests, not rule rows)', async () => {
  db.prepare('DELETE FROM waf_events').run();
  insertEvent({ route_id: rB, host: 'b.waf.test', tx_id: 't1', rule_id: 941100 });
  insertEvent({ route_id: rB, host: 'b.waf.test', tx_id: 't1', rule_id: 941110 });
  insertEvent({ route_id: rB, host: 'b.waf.test', tx_id: 't2', action: 'detected' });
  insertEvent({ route_id: rB, host: 'b.waf.test', tx_id: 't3', ts: new Date(Date.now() - 2 * 86400000).toISOString() });
  db.prepare('UPDATE routes SET waf_exclusions = ? WHERE id = ?').run(JSON.stringify({ rule_ids: [920350], paths: ['/x'] }), rB);
  const r = await GET('/waf/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.licensed, true);
  assert.equal(r.body.engine_available, false, 'test env: no Caddy binary');
  assert.equal(r.body.events_24h, 2);
  assert.equal(r.body.blocked_24h, 1);
  const b = r.body.routes.find((x) => x.route_id === rB);
  assert.deepEqual(b, {
    route_id: rB, host: 'b.waf.test', enabled: true, mode: 'block', paranoia: 2,
    exclusions: { rule_ids: [920350], paths: ['/x'] }, events_24h: 2, blocked_24h: 1,
  });
  assert.equal(r.body.routes.some((x) => x.route_id === rA), false, 'routes without WAF are not listed');
  waf._setEngineForTest(true);
  try { assert.equal((await GET('/waf/status')).body.engine_available, true); } finally { waf._setEngineForTest(null); }
  db.prepare('UPDATE routes SET waf_exclusions = NULL WHERE id = ?').run(rB);
});

test('GET /waf/events: filters, newest first, keyset cursor, rule_excluded', async () => {
  db.prepare('DELETE FROM waf_events').run();
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const ids = [];
  for (let i = 0; i < 7; i++) {
    ids.push(insertEvent({
      ts: new Date(t0 + i * 3600000).toISOString(),
      host: i % 2 ? 'b.waf.test' : 'a.waf.test', route_id: i % 2 ? rB : rA,
      action: i < 4 ? 'blocked' : 'detected', rule_id: 941100 + i,
    }));
  }
  let r = await GET('/waf/events');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events.map((e) => e.id), [...ids].reverse());
  assert.equal(r.body.next_cursor, null);
  const e = r.body.events[0];
  assert.deepEqual(Object.keys(e).sort(), ['action', 'client_ip', 'host', 'id', 'message', 'method', 'route_id', 'rule_excluded', 'rule_id', 'severity', 'ts', 'tx_id', 'uri'].sort());

  r = await GET('/waf/events?limit=3');
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[6], ids[5], ids[4]]);
  assert.equal(r.body.next_cursor, ids[4]);
  r = await GET(`/waf/events?limit=3&cursor=${r.body.next_cursor}`);
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[3], ids[2], ids[1]]);
  r = await GET(`/waf/events?limit=3&cursor=${r.body.next_cursor}`);
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[0]]);
  assert.equal(r.body.next_cursor, null);

  r = await GET('/waf/events?host=B.WAF.TEST');
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[5], ids[3], ids[1]]);
  r = await GET('/waf/events?action=detected');
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[6], ids[5], ids[4]]);
  r = await GET(`/waf/events?route_id=${rA}&action=blocked`);
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[2], ids[0]]);
  r = await GET(`/waf/events?from=${encodeURIComponent(new Date(t0 + 2 * 3600000).toISOString())}&to=${encodeURIComponent(new Date(t0 + 4 * 3600000).toISOString())}`);
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[3], ids[2]]);
  r = await GET('/waf/events?rule_id=941103');
  assert.deepEqual(r.body.events.map((x) => x.id), [ids[3]]);

  for (const [q, code] of [['action=nope', 'WAF_ACTION_INVALID'], ['limit=0', 'WAF_LIMIT_INVALID'], ['cursor=x', 'WAF_CURSOR_INVALID'], ['from=yesterday', 'WAF_TIME_INVALID'], ['rule_id=x', 'WAF_RULE_ID_INVALID'], ['route_id=-1', 'WAF_ROUTE_ID_INVALID']]) {
    const x = await GET('/waf/events?' + q);
    assert.equal(x.status, 400, q); assert.equal(x.body.code, code, q);
  }
  assert.equal((await GET('/waf/events?limit=100000')).status, 200, 'limit is capped, not rejected');

  db.prepare('UPDATE routes SET waf_exclusions = ? WHERE id = ?').run(JSON.stringify({ rule_ids: [941100] }), rA);
  r = await GET('/waf/events?rule_id=941100');
  assert.equal(r.body.events[0].rule_excluded, true);
  r = await GET('/waf/events?rule_id=941101');
  assert.equal(r.body.events[0].rule_excluded, false);
  db.prepare('UPDATE routes SET waf_exclusions = NULL WHERE id = ?').run(rA);
});

// ─── Exclusions ─────────────────────────────────────────

test('POST/DELETE /waf/routes/:id/exclusions: add, idempotent, remove, codes', async () => {
  let before = syncCount;
  let r = await POST(`/waf/routes/${rB}/exclusions`, { rule_id: 942100 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, route_id: rB, exclusions: { rule_ids: [942100], paths: [] }, changed: true });
  assert.equal(syncCount, before + 1);
  r = await POST(`/waf/routes/${rB}/exclusions`, { rule_id: '920350', path: '/api/upload' });
  assert.deepEqual(r.body.exclusions, { rule_ids: [920350, 942100], paths: ['/api/upload'] });
  before = syncCount;
  r = await POST(`/waf/routes/${rB}/exclusions`, { rule_id: 942100 });
  assert.equal(r.status, 200); assert.equal(r.body.changed, false);
  assert.equal(syncCount, before, 'no change → no sync');
  assert.deepEqual(JSON.parse(routeRow(rB).waf_exclusions), { rule_ids: [920350, 942100], paths: ['/api/upload'] });

  // Directives follow the stored exclusions.
  const d = waf.directivesFor(routeRow(rB));
  assert.match(d, /^SecRuleRemoveById 942100$/m);
  assert.match(d, new RegExp(`id:${10000 + rB * 100},phase:1,pass,nolog,ctl:ruleEngine=Off`));

  for (const [body, code] of [[{}, 'WAF_EXCLUSION_REQUIRED'], [{ rule_id: 'abc' }, 'WAF_RULE_ID_INVALID'], [{ path: 'no-slash' }, 'WAF_PATH_INVALID'], [{ path: '/a b' }, 'WAF_PATH_INVALID']]) {
    r = await POST(`/waf/routes/${rB}/exclusions`, body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.code, code);
  }
  r = await POST('/waf/routes/99999/exclusions', { rule_id: 1 });
  assert.equal(r.status, 404); assert.equal(r.body.code, 'WAF_ROUTE_NOT_FOUND');
  r = await POST(`/waf/routes/${rL4}/exclusions`, { rule_id: 1 });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_REQUIRES_HTTP');

  r = await DEL(`/waf/routes/${rB}/exclusions`, { rule_id: 942100 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.exclusions, { rule_ids: [920350], paths: ['/api/upload'] });
  r = await agent.delete(`/api/v1/waf/routes/${rB}/exclusions?path=${encodeURIComponent('/api/upload')}`).set('X-CSRF-Token', csrf);
  assert.equal(r.status, 200, 'query-string variant');
  assert.deepEqual(r.body.exclusions, { rule_ids: [920350], paths: [] });
  r = await DEL(`/waf/routes/${rB}/exclusions`, { rule_id: 942100 });
  assert.equal(r.status, 404); assert.equal(r.body.code, 'WAF_EXCLUSION_NOT_FOUND');
  r = await DEL(`/waf/routes/${rB}/exclusions`, { rule_id: 920350 });
  assert.deepEqual(r.body.exclusions, { rule_ids: [], paths: [] });
  assert.equal(routeRow(rB).waf_exclusions, null, 'empty → NULL');
});

test('exclusions: failed Caddy sync rolls the row back (502 CADDY_SYNC_FAILED)', async () => {
  failNextSync = 'Caddy admin API is not reachable — route saved but not deployed.';
  let r = await POST(`/waf/routes/${rB}/exclusions`, { rule_id: 930100 });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'CADDY_SYNC_FAILED');
  assert.equal(routeRow(rB).waf_exclusions, null);
  failNextSync = 'boom';
  r = await POST(`/waf/routes/${rB}/exclusions`, { rule_id: 930100 });
  assert.equal(r.status, 500);
  assert.equal(routeRow(rB).waf_exclusions, null);
});

// ─── Scope / retention ──────────────────────────────────

test('token scope: /api/v1/waf maps to `routes`', () => {
  const { checkScope } = require('../src/services/tokens');
  assert.equal(checkScope(['routes'], '/api/v1/waf/status', 'GET'), true);
  assert.equal(checkScope(['routes'], '/api/v1/waf/routes/1/exclusions', 'POST'), true);
  assert.equal(checkScope(['peers'], '/api/v1/waf/events', 'POST'), false);
});

test('retention: data.retention_waf_days (default 14)', () => {
  const settings = require('../src/services/settings');
  db.prepare('DELETE FROM waf_events').run();
  const day = 86400000;
  const keep = insertEvent({ ts: new Date(Date.now() - 13 * day).toISOString() });
  insertEvent({ ts: new Date(Date.now() - 15 * day).toISOString() });
  assert.equal(waf.retentionDays(), 14);
  assert.equal(waf.cleanup(), 1);
  assert.deepEqual(db.prepare('SELECT id FROM waf_events').all().map((r) => r.id), [keep]);
  settings.set('data.retention_waf_days', '7');
  try {
    assert.equal(waf.retentionDays(), 7);
    assert.equal(waf.cleanup(), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waf_events').get().n, 0);
    settings.set('data.retention_waf_days', 'garbage');
    assert.equal(waf.retentionDays(), 14);
  } finally { settings.set('data.retention_waf_days', '14'); }
});
