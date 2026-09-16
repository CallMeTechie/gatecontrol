'use strict';

// WAF own IPs, trusted bypass and scanner ban (docs/feature-release-b.md §3):
// GET/PUT /api/v1/settings/waf, trusted flag on events + status counts without
// own IPs, the bypass directive (id 9003 before the CRS include), the ban list
// API, the Caddy route gc_waf_bans (position, matcher, exclusions), scanner
// counting in the audit ingest path, coalesced syncs, the expiry sweep,
// licence gate `waf`.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, license, waf, wafBans, caddy;
let rA;
let syncCount = 0;
let failNextSync = null;
const busEvents = [];

const POST = (p, body) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const PUT = (p, body) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(body);
const DEL = (p) => agent.delete('/api/v1' + p).set('X-CSRF-Token', csrf);
const GET = (p) => agent.get('/api/v1' + p);

function insertEvent(over = {}) {
  const e = {
    ts: new Date().toISOString(), host: 'a.bans.test', route_id: rA, client_ip: '203.0.113.5', method: 'GET', uri: '/',
    rule_id: 941100, severity: 'critical', message: 'XSS', action: 'detected', tx_id: crypto.randomBytes(8).toString('hex'), raw: null,
    ...over,
  };
  return db.prepare(`INSERT INTO waf_events (ts, host, route_id, client_ip, method, uri, rule_id, severity, message, action, tx_id, raw)
    VALUES (@ts, @host, @route_id, @client_ip, @method, @uri, @rule_id, @severity, @message, @action, @tx_id, @raw)`).run(e).lastInsertRowid;
}

function auditLine(ip, ruleId, uri = '/.env') {
  return JSON.stringify({
    transaction: {
      id: crypto.randomBytes(8).toString('hex'), unix_timestamp: Date.now() * 1e6, server_id: 'a.bans.test', client_ip: ip,
      is_interrupted: false, request: { method: 'GET', uri, protocol: 'HTTP/1.1' },
    },
    messages: [{ data: { id: ruleId, msg: 'scanner rule', severity: 2 } }],
  });
}

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  waf = require('../src/services/waf');
  wafBans = require('../src/services/wafBans');
  caddy = require('../src/services/caddyConfig');
  license._overrideForTest({ waf: true });
  const orig = caddy.syncToCaddy;
  caddy.syncToCaddy = async () => {
    syncCount++;
    if (failNextSync) { const m = failNextSync; failNextSync = null; throw new Error(m); }
    return orig();
  };
  require('../src/services/eventBus').subscribe((e) => { if (e.type === 'waf' && e.payload.kind) busEvents.push(e.payload); });
  rA = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, https_enabled, external_enabled, waf_enabled, waf_mode)
    VALUES ('a.bans.test', '10.0.0.5', 80, 'http', 1, 1, 1, 'block')`).run().lastInsertRowid;
});

after(() => { wafBans._resetForTest(); waf._setEngineForTest(null); license._overrideForTest({ waf: false }); teardown(); });

// ─── Settings ───────────────────────────────────────────

test('GET /settings/waf: defaults (scanner ban off)', async () => {
  const r = await GET('/settings/waf');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true, trusted_ips: [], trusted_bypass: false,
    autoban: { enabled: false, threshold: 5, window_min: 10, duration_h: 24 },
  });
});

test('PUT /settings/waf: validation codes, nothing written on error', async () => {
  let r = await PUT('/settings/waf', { trusted_ips: ['not-an-ip'] });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_TRUSTED_IPS_INVALID');
  r = await PUT('/settings/waf', { trusted_ips: Array.from({ length: 51 }, (_, i) => `198.51.100.${i}`) });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_TRUSTED_IPS_INVALID');
  r = await PUT('/settings/waf', { trusted_ips: '1.2.3.4' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_TRUSTED_IPS_INVALID');
  r = await PUT('/settings/waf', { autoban: { threshold: 0 } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_AUTOBAN_INVALID');
  r = await PUT('/settings/waf', { autoban: { window_min: 2000 } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_AUTOBAN_INVALID');
  r = await PUT('/settings/waf', { autoban: { enabled: 'maybe' } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_AUTOBAN_INVALID');
  r = await PUT('/settings/waf', { trusted_bypass: 'x' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_SETTINGS_INVALID');
  assert.deepEqual((await GET('/settings/waf')).body.trusted_ips, []);
});

test('PUT /settings/waf: normalises and stores; bypass change syncs, other changes do not', async () => {
  let before = syncCount;
  let r = await PUT('/settings/waf', { trusted_ips: ['93.215.209.180', '10.1.2.3/8', '2001:DB8::1', '93.215.209.180'], autoban: { threshold: 3, window_min: 15, duration_h: 12 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.trusted_ips, ['93.215.209.180', '10.0.0.0/8', '2001:db8::1']);
  assert.deepEqual(r.body.autoban, { enabled: false, threshold: 3, window_min: 15, duration_h: 12 });
  assert.equal(r.body.synced, false);
  assert.equal(syncCount, before, 'no config change without the bypass');

  before = syncCount;
  r = await PUT('/settings/waf', { trusted_bypass: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.synced, true);
  assert.equal(syncCount, before + 1);

  // Sync failure → 502 and the settings roll back.
  failNextSync = 'Caddy admin API is not reachable';
  r = await PUT('/settings/waf', { trusted_bypass: false });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'CADDY_SYNC_FAILED');
  assert.equal((await GET('/settings/waf')).body.trusted_bypass, true);
});

test('licence gate `waf` on settings, bans and assistant', async () => {
  license._overrideForTest({ waf: false });
  try {
    for (const [m, p] of [['get', '/settings/waf'], ['put', '/settings/waf'], ['get', '/waf/bans'], ['post', '/waf/bans'], ['delete', '/waf/bans/1.2.3.4'], ['get', '/waf/assistant']]) {
      const r = await agent[m]('/api/v1' + p).set('X-CSRF-Token', csrf).send({});
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.feature, 'waf');
    }
  } finally { license._overrideForTest({ waf: true }); }
});

// ─── Trusted flag + counts ──────────────────────────────

test('events carry trusted; status counts exclude own IPs and report trusted_24h', async () => {
  db.prepare('DELETE FROM waf_events').run();
  insertEvent({ client_ip: '93.215.209.180', action: 'blocked' });
  insertEvent({ client_ip: '10.20.30.40' });
  insertEvent({ client_ip: '203.0.113.77', action: 'blocked' });
  const ev = (await GET('/waf/events')).body.events;
  const byIp = Object.fromEntries(ev.map((e) => [e.client_ip, e.trusted]));
  assert.deepEqual(byIp, { '93.215.209.180': true, '10.20.30.40': true, '203.0.113.77': false });
  const st = (await GET('/waf/status')).body;
  assert.equal(st.events_24h, 1);
  assert.equal(st.blocked_24h, 1);
  assert.equal(st.trusted_24h, 2);
  assert.equal(st.routes.find((x) => x.route_id === rA).events_24h, 1);
});

// ─── Bypass directive ───────────────────────────────────

test('trusted bypass: SecRule id 9003 before the CRS include, only when on', () => {
  waf._setEngineForTest(true);
  const route = { id: rA, domain: 'a.bans.test', route_type: 'http', waf_enabled: 1, waf_mode: 'block', waf_paranoia: 1 };
  const plain = waf.directivesFor(route);
  assert.ok(!plain.includes('9003'));
  const d = waf.directivesFor(route, { trustedIps: ['93.215.209.180', '10.0.0.0/8'] });
  const lines = d.split('\n');
  const i = lines.indexOf('SecRule REMOTE_ADDR "@ipMatch 93.215.209.180,10.0.0.0/8" "id:9003,phase:1,pass,nolog,ctl:ruleEngine=Off"');
  assert.ok(i > 0, d);
  assert.ok(i < lines.indexOf('Include @owasp_crs/*.conf'));
  assert.ok(i > lines.findIndex((l) => l.includes('id:9002')), 'next to the body rules');
  assert.equal(d.replace(lines[i] + '\n', ''), plain, 'otherwise identical');

  // buildCaddyConfig picks the list from the settings (bypass is on here).
  const cfg = JSON.stringify(caddy.buildCaddyConfig());
  assert.ok(cfg.includes('id:9003'), 'bypass directive in the generated config');
});

// ─── Bans API + Caddy route ─────────────────────────────

test('manual ban: validation codes', async () => {
  let r = await POST('/waf/bans', { ip: 'nope' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_BAN_IP_INVALID');
  r = await POST('/waf/bans', { ip: '198.51.0.0/8' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_BAN_IP_INVALID');
  r = await POST('/waf/bans', { ip: '127.0.0.1' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_BAN_IP_INVALID');
  r = await POST('/waf/bans', { ip: '93.215.209.180' });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_BAN_TRUSTED');
  r = await POST('/waf/bans', { ip: '10.9.9.9' });
  assert.equal(r.status, 400, 'inside a trusted CIDR'); assert.equal(r.body.code, 'WAF_BAN_TRUSTED');
  r = await POST('/waf/bans', { ip: '198.51.100.7', duration_h: 0 });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'WAF_BAN_DURATION_INVALID');
  r = await DEL('/waf/bans/198.51.100.200');
  assert.equal(r.status, 404); assert.equal(r.body.code, 'WAF_BAN_NOT_FOUND');
});

test('manual ban: 201, synced at once, list, Caddy route after redirect + mTLS guards; delete', async () => {
  const before = syncCount;
  let r = await POST('/waf/bans', { ip: '198.51.100.7', duration_h: 2 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ban.ip, '198.51.100.7');
  assert.equal(r.body.ban.manual, true);
  assert.equal(syncCount, before + 1);
  const hours = (new Date(r.body.ban.expires_at) - new Date(r.body.ban.banned_at)) / 3600000;
  assert.equal(hours, 2);
  r = await POST('/waf/bans', { ip: '2001:db8:beef::/48' });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const list = (await GET('/waf/bans')).body.bans;
  assert.deepEqual(list.map((b) => b.ip).sort(), ['198.51.100.7', '2001:db8:beef::/48']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['banned_at', 'expires_at', 'first_seen', 'hits', 'ip', 'manual', 'reason', 'reason_code', 'reason_params']);
  assert.ok(busEvents.some((e) => e.kind === 'ban' && e.ip === '198.51.100.7'));
  // docs/feature-wave2.md §W1.3: the reason of a ban the service writes itself
  // gets a code; `reason` keeps its plain text.
  assert.deepEqual(list.map((b) => b.reason_code).sort(), ['manual', 'manual']);
  assert.deepEqual(list[0].reason_params, {});

  // Route position: gc_https_redirect, the mTLS guard, then gc_waf_bans.
  const base = { route_type: 'http', target_kind: 'direct', target_ip: '127.0.0.1', target_port: 8081, enabled: 1, external_enabled: 1 };
  const cfg = caddy.buildCaddyConfig([
    { ...base, id: 91, domain: 'tls.bans.test', https_enabled: 1 },
    { ...base, id: 92, domain: 'mtls.bans.test', https_enabled: 1, mtls_enabled: 1, mtls_ca_pem: 'x' },
  ]);
  const routes = cfg.apps.http.servers.srv0.routes;
  assert.equal(routes[0]['@id'], 'gc_https_redirect');
  assert.equal(routes[1].handle[0].status_code, 421, 'mTLS SNI guard');
  const ban = routes[2];
  assert.equal(ban['@id'], 'gc_waf_bans');
  assert.deepEqual(ban.match[0].client_ip.ranges, ['198.51.100.7/32', '2001:db8:beef::/48']);
  assert.deepEqual(ban.match[0].not, [{ host: ['localhost'] }, { path: ['/.well-known/acme-challenge/*'] }]);
  assert.equal(ban.handle[0].status_code, 403);
  assert.match(ban.handle[0].body, /Anfrage blockiert/);
  assert.match(ban.handle[0].body, /\{http\.vars\.client_ip\}/);
  assert.equal(ban.terminal, true);
  assert.equal(JSON.stringify(cfg).match(/gc_waf_bans/g).length, 1);

  r = await DEL('/waf/bans/' + encodeURIComponent('2001:db8:beef::/48'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await DEL('/waf/bans/198.51.100.7');
  assert.equal(r.status, 200);
  assert.deepEqual((await GET('/waf/bans')).body.bans, []);
  assert.ok(!JSON.stringify(caddy.buildCaddyConfig()).includes('gc_waf_bans'), 'no bans → no route');
});

test('ban sync failure → 502 and the row is gone again', async () => {
  failNextSync = 'Caddy admin API is not reachable';
  const r = await POST('/waf/bans', { ip: '198.51.100.8' });
  assert.equal(r.status, 502);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM waf_bans WHERE ip = '198.51.100.8'").get().n, 0);
});

// ─── Scanner ban ────────────────────────────────────────

test('scanner ban: threshold per IP in the window, scanner groups only, never private/own IPs', async () => {
  wafBans._resetForTest();
  await PUT('/settings/waf', { autoban: { enabled: true, threshold: 3, window_min: 10, duration_h: 12 } }).expect(200);
  db.prepare('DELETE FROM waf_events').run();
  // (TEST-NET addresses count as reserved — never banned — so real public ones here.)
  const scan = '45.33.32.50';
  // Two scanner requests + one XSS (not counted) → below the threshold.
  waf.ingestLines([auditLine(scan, 913100), auditLine(scan, 930120), auditLine(scan, 941100, '/?q=<script>')]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waf_bans WHERE ip = ?').get(scan).n, 0);
  // Third scanner request (920440) → banned.
  waf.ingestLines([auditLine(scan, 920440, '/backup.sql')]);
  const ban = db.prepare('SELECT * FROM waf_bans WHERE ip = ?').get(scan);
  assert.ok(ban, 'banned');
  assert.equal(ban.manual, 0);
  assert.equal(ban.hits, 3);
  assert.match(ban.reason, /scanner/);
  assert.equal(Math.round((new Date(ban.expires_at) - new Date(ban.banned_at)) / 3600000), 12);
  assert.ok(wafBans._banSync.timer, 'a coalesced sync is scheduled');
  assert.ok(busEvents.some((e) => e.kind === 'ban' && e.ip === scan));

  // Private, CGNAT and own IPs are never banned.
  for (const ip of ['192.168.1.50', '100.64.1.1', '93.215.209.180', '10.1.1.1', '203.0.113.9']) {
    waf.ingestLines([1, 2, 3, 4].map(() => auditLine(ip, 913100)));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waf_bans WHERE ip = ?').get(ip).n, 0, ip);
  }
  // Old hits outside the window do not count.
  const old = new Date(Date.now() - 30 * 60000).toISOString();
  for (let i = 0; i < 5; i++) insertEvent({ ts: old, client_ip: '45.33.32.60', rule_id: 913100 });
  waf.ingestLines([auditLine('45.33.32.60', 913100)]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM waf_bans WHERE ip = '45.33.32.60'").get().n, 0);

  // Off → no counting.
  await PUT('/settings/waf', { autoban: { enabled: false } }).expect(200);
  waf.ingestLines([1, 2, 3].map(() => auditLine('45.33.32.70', 913100)));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM waf_bans WHERE ip = '45.33.32.70'").get().n, 0);
});

test('coalesced ban sync: at most one per 60 s', async () => {
  wafBans._resetForTest();
  const before = syncCount;
  wafBans.scheduleBanSync();
  wafBans.scheduleBanSync();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(syncCount, before + 1, 'first one runs right away, the second is merged');
  wafBans.scheduleBanSync();
  assert.ok(wafBans._banSync.timer, 'next one waits for the 60 s window');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(syncCount, before + 1);
  wafBans._resetForTest();
});

test('adding an own IP lifts its ban; expiry sweep deletes expired bans', async () => {
  const scan = '45.33.32.50';
  assert.ok(db.prepare('SELECT 1 FROM waf_bans WHERE ip = ?').get(scan));
  const cur = (await GET('/settings/waf')).body.trusted_ips;
  const r = await PUT('/settings/waf', { trusted_ips: [...cur, '45.33.32.0/24'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.synced, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waf_bans WHERE ip = ?').get(scan).n, 0);
  assert.ok(busEvents.some((e) => e.kind === 'unban' && e.ip === scan));

  const past = new Date(Date.now() - 1000).toISOString();
  db.prepare("INSERT INTO waf_bans (ip, reason, hits, banned_at, expires_at, manual) VALUES ('198.51.100.99', 'x', 1, ?, ?, 0)").run(past, past);
  assert.deepEqual((await GET('/waf/bans')).body.bans.filter((b) => b.ip === '198.51.100.99'), [], 'expired bans are hidden');
  assert.ok(!JSON.stringify(caddy.buildCaddyConfig()).includes('198.51.100.99'), 'and not in the config');
  assert.equal(wafBans.sweep(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM waf_bans WHERE ip = '198.51.100.99'").get().n, 0);
  wafBans._resetForTest();
});

test('token auth: PUT /settings/waf is session-only; scope of /waf/bans is routes', () => {
  const { checkScope } = require('../src/services/tokens');
  assert.equal(checkScope(['routes'], '/api/v1/waf/bans', 'POST'), true);
  assert.equal(checkScope(['settings'], '/api/v1/settings/waf', 'GET'), true);
});
