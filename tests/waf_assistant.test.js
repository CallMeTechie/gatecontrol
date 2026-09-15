'use strict';

// WAF assistant (docs/feature-release-b.md §3): GET /api/v1/waf/assistant —
// verdicts (attack / false_positive / unclear), readiness (too_early /
// no_traffic / review / ready), own IPs excluded, suggestion, access-log
// traffic, response shape.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

let agent, db, license, assistantSvc, config;
let origCaddyDataDir;
let rMain, rEarly, rQuiet, rBusy, rBlock;

const GET = (p) => agent.get('/api/v1' + p);
const H = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function insertRoute(domain, extra = {}) {
  const cols = { domain, target_ip: '10.0.0.5', target_port: 80, route_type: 'http', https_enabled: 1, external_enabled: 1, waf_enabled: 1, waf_mode: 'detect', ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
}
function ev(routeId, { ip, rule, uri = '/', ago = H, msg = 'rule message' }) {
  db.prepare(`INSERT INTO waf_events (ts, host, route_id, client_ip, method, uri, rule_id, severity, message, action, tx_id)
    VALUES (?, 'x', ?, ?, 'GET', ?, ?, 'critical', ?, 'detected', ?)`).run(iso(ago), routeId, ip, uri, rule, msg, crypto.randomBytes(8).toString('hex'));
}

before(async () => {
  await setup();
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  assistantSvc = require('../src/services/wafAssistant');
  config = require('../config/default');
  license._overrideForTest({ waf: true });
  require('../src/services/settings').set('waf.trusted_ips', JSON.stringify(['93.215.209.180']));

  rMain = insertRoute('main.assist.test', { waf_mode_changed_at: iso(72 * H) });
  // attack: scanner rule on a secret path
  ev(rMain, { ip: '45.33.32.1', rule: 930130, uri: '/.env' });
  // attack: single-IP series (4 × XSS from one address)
  for (let i = 0; i < 4; i++) ev(rMain, { ip: '45.33.32.2', rule: 941100, uri: '/search?q=' + i });
  // false positive: same rule + path from 3 addresses on 2 days
  ev(rMain, { ip: '45.33.32.10', rule: 942100, uri: '/api/save?x=1', ago: 50 * H });
  ev(rMain, { ip: '45.33.32.11', rule: 942100, uri: '/api/save', ago: 26 * H });
  ev(rMain, { ip: '45.33.32.12', rule: 942100, uri: '/api/save', ago: 2 * H, msg: 'SQL Injection Attack Detected via libinjection' });
  // unclear: two addresses, one day
  ev(rMain, { ip: '45.33.32.20', rule: 932100, uri: '/cmd', ago: 3 * H });
  ev(rMain, { ip: '45.33.32.21', rule: 932100, uri: '/cmd', ago: 3 * H });
  // own IP: never counted as external, never in a verdict
  for (let i = 0; i < 5; i++) ev(rMain, { ip: '93.215.209.180', rule: 920350, uri: '/own' });
  // scoring rule: skipped
  ev(rMain, { ip: '45.33.32.30', rule: 949110, uri: '/' });
  // before detect_since: ignored
  ev(rMain, { ip: '45.33.32.40', rule: 921110, uri: '/old', ago: 100 * H });

  rEarly = insertRoute('early.assist.test', { waf_mode_changed_at: iso(2 * H) });
  ev(rEarly, { ip: '45.33.32.50', rule: 942100, uri: '/x', ago: H });
  rQuiet = insertRoute('quiet.assist.test', { waf_mode_changed_at: iso(48 * H) });
  rBusy = insertRoute('busy.assist.test', { waf_mode_changed_at: iso(48 * H) });
  rBlock = insertRoute('block.assist.test', { waf_mode: 'block', waf_mode_changed_at: iso(100 * H) });
  insertRoute('off.assist.test', { waf_enabled: 0 });

  // Access log: traffic for busy.assist.test after detect_since. Written to a
  // temp data dir — /data is not writable on CI runners.
  origCaddyDataDir = config.caddy.dataDir;
  config.caddy.dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gc-wafassist-'));
  const dir = config.caddy.dataDir;
  fs.writeFileSync(path.join(dir, 'access.log'), [
    JSON.stringify({ ts: (Date.now() - 5 * H) / 1000, request: { host: 'busy.assist.test', uri: '/' }, status: 200 }),
    JSON.stringify({ ts: (Date.now() - 60 * H) / 1000, request: { host: 'quiet.assist.test', uri: '/' }, status: 200 }),
    'not json',
  ].join('\n') + '\n');
  assistantSvc._resetAccessCacheForTest();
});

after(() => {
  license._overrideForTest({ waf: false });
  if (origCaddyDataDir !== undefined) {
    try { fs.rmSync(config.caddy.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    config.caddy.dataDir = origCaddyDataDir;
  }
  teardown();
});

test('response shape and route list (WAF routes only)', async () => {
  const r = await GET('/waf/assistant');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const hosts = r.body.routes.map((x) => x.host);
  assert.ok(!hosts.includes('off.assist.test'));
  const main = r.body.routes.find((x) => x.route_id === rMain);
  assert.deepEqual(Object.keys(main).sort(), ['detect_since', 'events_external', 'events_total', 'host', 'mode', 'observed_hours', 'paranoia', 'readiness', 'route_id', 'suggestion', 'top_rules'].sort());
  assert.deepEqual(Object.keys(main.top_rules[0]).sort(), ['hits', 'ips', 'message', 'paths', 'reason', 'rule_id', 'verdict'].sort());
  assert.deepEqual(Object.keys(main.suggestion).sort(), ['exclude_paths', 'exclude_rules']);
  assert.equal(main.mode, 'detect');
  assert.ok(main.observed_hours >= 71 && main.observed_hours <= 72);
  assert.match(main.detect_since, /^\d{4}-\d{2}-\d{2}T/);
});

test('verdicts, own IPs, counts, suggestion, readiness review', async () => {
  const main = (await GET(`/waf/assistant?route_id=${rMain}`)).body.routes[0];
  const v = Object.fromEntries(main.top_rules.map((x) => [x.rule_id, x]));
  assert.equal(v[930130].verdict, 'attack');
  assert.match(v[930130].reason, /secret path/);
  assert.equal(v[941100].verdict, 'attack');
  assert.match(v[941100].reason, /single address/);
  assert.equal(v[941100].hits, 4);
  assert.equal(v[941100].ips, 1);
  assert.equal(v[942100].verdict, 'false_positive');
  assert.deepEqual(v[942100].paths, ['/api/save'], 'query string stripped');
  assert.equal(v[942100].ips, 3);
  assert.equal(v[942100].message, 'SQL Injection Attack Detected via libinjection', 'message of the newest hit');
  assert.equal(v[932100].verdict, 'unclear');
  assert.ok(!v[920350], 'own IP rule not in the list');
  assert.ok(!v[949110], 'scoring rule skipped');
  assert.ok(!v[921110], 'before detect_since');
  // 1 + 4 + 3 + 2 + 1 (949110) external requests; + 5 own
  assert.equal(main.events_external, 11);
  assert.equal(main.events_total, 16);
  assert.equal(main.readiness, 'review');
  assert.deepEqual(main.suggestion, { exclude_rules: [942100], exclude_paths: [] });
  assert.equal(main.top_rules[0].rule_id, 941100, 'sorted by hits');
});

test('banned sources do not count towards a false positive; exclusions drop the rule', async () => {
  const now = new Date();
  db.prepare("INSERT INTO waf_bans (ip, reason, hits, banned_at, expires_at, manual) VALUES ('45.33.32.12', 'x', 1, ?, ?, 1)")
    .run(now.toISOString(), new Date(now.getTime() + H).toISOString());
  let main = (await GET(`/waf/assistant?route_id=${rMain}`)).body.routes[0];
  assert.equal(main.top_rules.find((x) => x.rule_id === 942100).verdict, 'unclear', 'only 2 clean addresses left');
  assert.equal(main.readiness, 'ready');
  db.prepare('DELETE FROM waf_bans').run();

  db.prepare('UPDATE routes SET waf_exclusions = ? WHERE id = ?').run(JSON.stringify({ rule_ids: [942100], paths: [] }), rMain);
  main = (await GET(`/waf/assistant?route_id=${rMain}`)).body.routes[0];
  assert.ok(!main.top_rules.some((x) => x.rule_id === 942100));
  assert.equal(main.readiness, 'ready');
  db.prepare('UPDATE routes SET waf_exclusions = NULL WHERE id = ?').run(rMain);
});

test('readiness: too_early, no_traffic, ready from the access log; block routes', async () => {
  const all = Object.fromEntries((await GET('/waf/assistant')).body.routes.map((x) => [x.route_id, x]));
  assert.equal(all[rEarly].readiness, 'too_early');
  assert.equal(all[rQuiet].readiness, 'no_traffic', 'access-log line is older than detect_since');
  assert.equal(all[rQuiet].events_total, 0);
  assert.equal(all[rBusy].readiness, 'ready', 'traffic in the access log, zero hits');
  assert.equal(all[rBlock].mode, 'block');
  assert.equal(all[rBlock].detect_since, null);
});

test('route_id validation; secret path helper', async () => {
  const r = await GET('/waf/assistant?route_id=abc');
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_ROUTE_ID_INVALID');
  for (const p of ['/.env', '/.git/config', '/wp-config.php', '/backup.sql', '/%2eenv', '/etc/passwd', '/app/.aws/credentials']) {
    assert.equal(assistantSvc.isSecretPath(p), true, p);
  }
  for (const p of ['/', '/api/save', '/environment', '/login', '/static/app.js']) {
    assert.equal(assistantSvc.isSecretPath(p), false, p);
  }
});
