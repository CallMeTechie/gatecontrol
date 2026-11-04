'use strict';

// IP-Sperre (services/ipBlock.js): failures from every entry point, growing
// bans, exceptions, bans by hand, block lists (fake downloads — no network),
// the block file for Caddy, the Caddy route, the access-log hook, the
// middleware and the API (/api/v1/settings/ip-block).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, ipBlock, license, tmp;
const GET = (p) => agent.get('/api/v1' + p);
const PUT = (p, b) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(b);
const POST = (p, b) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(b || {});
const DEL = (p) => agent.delete('/api/v1' + p).set('X-CSRF-Token', csrf);

function fakeFetch(map) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (!(url in map)) return { ok: false, status: 404, headers: new Map(), text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => map[url] };
  };
  f.calls = calls;
  return f;
}

before(async () => {
  ({ app } = await setup());
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  ipBlock = require('../src/services/ipBlock');
  license = require('../src/services/license');
  tmp = fs.mkdtempSync(path.join(process.env.GC_DATA_DIR, 'ipb-'));
});

after(() => { license._overrideForTest({ ip_blocklists: false }); teardown(); });

beforeEach(() => {
  db.prepare('DELETE FROM ip_blocks').run();
  db.prepare('DELETE FROM ip_block_failures').run();
  db.prepare('DELETE FROM ip_block_strikes').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'ipblock.%'").run();
  ipBlock._resetForTest({ blockFile: path.join(tmp, 'ipblock.list'), dataDir: path.join(tmp, 'lists'), engine: true });
});

test('defaults: on, 10 failures in 10 minutes, rate limit not counted', () => {
  const c = ipBlock.getConfig();
  assert.equal(c.enabled, true);
  assert.equal(c.threshold, 10);
  assert.equal(c.window_min, 10);
  assert.deepEqual(c.durations_min, [10, 60, 1440]);
  assert.equal(c.sources.rate_limit, false);
  assert.equal(c.sources.waf, true);
});

test('failures from different entry points count together and ban at the threshold', () => {
  ipBlock.setConfig({ threshold: 5 });
  const ip = '185.220.100.23';
  for (let i = 0; i < 3; i++) assert.equal(ipBlock.noteFailure(ip, 'login', `user${i}`), false);
  assert.equal(ipBlock.noteFailure(ip, 'share_link', 'gatecontrol-drive: Belege'), false);
  assert.equal(ipBlock.noteFailure(ip, 'login', 'user9'), true);
  const bans = ipBlock.listBans();
  assert.equal(bans.length, 1);
  assert.equal(bans[0].ip, ip);
  assert.equal(bans[0].level, 1);
  assert.equal(bans[0].reason, 'login');
  assert.equal(bans[0].hits, 5);
  assert.equal(bans[0].sources.login, 4);
  const mins = (Date.parse(bans[0].expiresAt) - Date.parse(bans[0].createdAt)) / 60e3;
  assert.equal(mins, 10);
  assert.deepEqual(ipBlock.check(ip), { by: 'ban' });
  // a banned address is not counted further
  assert.equal(ipBlock.noteFailure(ip, 'login', 'x'), false);
});

test('the ban grows: 10 min, 1 h, 1 day', () => {
  ipBlock.setConfig({ threshold: 3 });
  const ip = '45.155.205.77';
  const expect = [10, 60, 1440, 1440];
  for (const minutes of expect) {
    for (let i = 0; i < 3; i++) ipBlock.noteFailure(ip, 'route_auth', 'nas.example.de');
    const b = ipBlock.listBans().find((x) => x.ip === ip);
    assert.equal((Date.parse(b.expiresAt) - Date.parse(b.createdAt)) / 60e3, minutes);
    ipBlock.unban(ip);
    db.prepare('UPDATE ip_block_strikes SET last_ban_at = ? WHERE ip = ?').run(Date.now() - 1000, ip);
  }
  // the third one notified (activity ip_blocked_day)
  const n = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'ip_blocked_day'").get().n;
  assert.ok(n >= 1);
});

test('never banned: private addresses, the VPN subnet, own networks, switched-off sources', () => {
  ipBlock.setConfig({ threshold: 3, sources: { waf: false } });
  for (let i = 0; i < 5; i++) {
    ipBlock.noteFailure('10.8.0.5', 'login', 'a');
    ipBlock.noteFailure('192.168.178.20', 'login', 'a');
    ipBlock.noteFailure('45.155.205.200', 'waf', 'a.example');
  }
  ipBlock.addNever({ ip: '185.220.100.0/24', label: 'Büro' });
  for (let i = 0; i < 5; i++) ipBlock.noteFailure('185.220.100.9', 'login', 'a');
  assert.equal(ipBlock.listBans().length, 0);
  assert.equal(ipBlock.check('10.8.0.5'), null);
  assert.ok(ipBlock.exceptions().some((e) => e.kind === 'vpn'));
});

test('ban by hand: CIDR, permanent, never an exception or a private range', () => {
  const b = ipBlock.banManual({ ip: '185.220.100.0/24', hours: null, note: 'Angreifer' }, 1);
  assert.equal(b.level, 0);
  assert.equal(b.expiresAt, null);
  assert.deepEqual(ipBlock.check('185.220.100.200'), { by: 'ban' });
  assert.throws(() => ipBlock.banManual({ ip: '10.8.0.0/24' }), (e) => e.code === 'not_public');
  assert.throws(() => ipBlock.banManual({ ip: '1.0.0.0/8' }), (e) => e.code === 'too_wide');
  ipBlock.addNever({ ip: '45.155.205.0/28' });
  assert.throws(() => ipBlock.banManual({ ip: '45.155.205.5' }), (e) => e.code === 'exempt');
  assert.throws(() => ipBlock.banManual({ ip: '45.155.205.50', hours: 5 }), (e) => e.field === 'hours');
  // adding an exception lifts a ban inside it
  ipBlock.banManual({ ip: '91.240.118.9', hours: 24 });
  const r = ipBlock.addNever({ ip: '91.240.118.0/24' });
  assert.deepEqual(r.lifted, ['91.240.118.9']);
});

test('block file: exceptions first, bans, lists; Caddy route only with the matcher', () => {
  ipBlock.banManual({ ip: '185.220.100.23', hours: 1 });
  ipBlock.addNever({ ip: '91.240.118.0/24', label: 'Heim' });
  ipBlock.writeNow();
  const text = fs.readFileSync(ipBlock.blockFile(), 'utf8');
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(lines[0], '!10.8.0.0/24');
  assert.ok(lines.includes('!91.240.118.0/24'));
  assert.ok(lines.includes('185.220.100.23/32'));
  const route = ipBlock.caddyRoute();
  assert.equal(route['@id'], 'gc_ip_block');
  assert.equal(route.match[0].gc_ipblock.file, ipBlock.blockFile());
  assert.deepEqual(route.match[0].not, [{ path: ['/.well-known/acme-challenge/*'] }]);
  assert.equal(route.handle[0].status_code, 403);
  assert.deepEqual(ipBlock.l4Ranges(), ['185.220.100.23/32']);
  ipBlock._resetForTest({ blockFile: ipBlock.blockFile(), engine: false });
  assert.equal(ipBlock.caddyRoute(), null, 'no matcher in Caddy → no route');
  ipBlock._resetForTest({ blockFile: ipBlock.blockFile(), engine: true });
  ipBlock.setConfig({ enabled: false });
  assert.equal(ipBlock.caddyRoute(), null, 'off → no route');
  assert.equal(ipBlock.check('185.220.100.23'), null);
});

test('caddy config: the block route is the very first route of srv0', () => {
  const caddy = require('../src/services/caddyConfig');
  db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, https_enabled) VALUES ('ipb.example.test', '10.0.0.5', 80, 'http', 0)").run();
  const cfg = caddy.buildCaddyConfig();
  assert.equal(cfg.apps.http.servers.srv0.routes[0]['@id'], 'gc_ip_block');
  ipBlock.setConfig({ enabled: false });
  const off = caddy.buildCaddyConfig();
  assert.ok(!JSON.stringify(off).includes('gc_ipblock'));
  db.prepare("DELETE FROM routes WHERE domain = 'ipb.example.test'").run();
});

test('block lists: parse, licence gate, fake download, kept on failure', async () => {
  const drop4 = '{"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}\n{"cidr":"10.0.0.0/8"}\n{"type":"metadata","timestamp":1,"copyright":"(c) 2026 The Spamhaus Project SLU"}\n';
  const drop6 = '{"cidr":"2a06:e480::/29","sblid":"SBL1"}\n';
  assert.deepEqual(ipBlock.parseList('drop-json', drop4), ['1.10.16.0/20']);
  assert.deepEqual(ipBlock.parseList('lines', '# x\n185.220.100.7\n185.220.100.7\n127.0.0.1\nbad\n2001:db8::1\n'), ['185.220.100.7/32']);
  assert.throws(() => ipBlock.setConfig({ lists: { attackers: true } }, { licensed: false }), (e) => e.feature === 'ip_blocklists');
  license._overrideForTest({ ip_blocklists: true });
  const fetch = fakeFetch({
    'https://www.spamhaus.org/drop/drop_v4.json': drop4,
    'https://www.spamhaus.org/drop/drop_v6.json': drop6,
    'https://lists.blocklist.de/lists/all.txt': '45.155.205.99\n',
  });
  ipBlock._resetForTest({ fetch, blockFile: ipBlock.blockFile(), dataDir: path.join(tmp, 'lists'), engine: true });
  ipBlock.setConfig({ lists: { drop: true, attackers: true } });
  const r = await ipBlock.refreshLists({ force: true });
  assert.deepEqual(r.drop, { ok: true, count: 2 });
  assert.deepEqual(r.attackers, { ok: true, count: 1 });
  assert.ok(!fetch.calls.some((u) => u.includes('torproject')), 'Tor stays off');
  assert.deepEqual(ipBlock.check('1.10.20.1'), { by: 'drop' });
  assert.deepEqual(ipBlock.check('2a06:e480::1'), { by: 'drop' });
  assert.deepEqual(ipBlock.check('45.155.205.99'), { by: 'attackers' });
  // a failed download keeps the previous list
  ipBlock._resetForTest({ fetch: fakeFetch({}), blockFile: ipBlock.blockFile(), dataDir: path.join(tmp, 'lists'), engine: true });
  const r2 = await ipBlock.refreshLists({ force: true });
  assert.equal(r2.drop.ok, false);
  assert.deepEqual(ipBlock.check('1.10.20.1'), { by: 'drop' });
  const st = ipBlock.stats().lists.find((l) => l.id === 'drop');
  assert.equal(st.count, 2);
  assert.ok(st.error);
  const text = fs.readFileSync(path.join(tmp, 'lists', 'drop.txt'), 'utf8');
  assert.match(text, /Spamhaus Project/);
  license._overrideForTest({ ip_blocklists: false });
});

test('block lists: a ban does not rebuild the list sets (seconds per ban with a large list)', async () => {
  license._overrideForTest({ ip_blocklists: true });
  const many = Array.from({ length: 6000 }, (_, i) => `45.${150 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`);
  const fetch = fakeFetch({
    'https://www.spamhaus.org/drop/drop_v4.json': '{"cidr":"1.10.16.0/20"}\n',
    'https://www.spamhaus.org/drop/drop_v6.json': '{"cidr":"2a06:e480::/29"}\n',
    'https://lists.blocklist.de/lists/all.txt': many.join('\n') + '\n2a0b:4140::7\n',
  });
  ipBlock._resetForTest({ fetch, blockFile: ipBlock.blockFile(), dataDir: path.join(tmp, 'lists'), engine: true });
  try {
    await listsAndBans(many);
  } finally { license._overrideForTest({ ip_blocklists: false }); }
});

async function listsAndBans(many) {
  ipBlock.setConfig({ lists: { drop: true, attackers: true }, threshold: 3 });
  // parsed in slices: the same entries as in one go
  const text = many.join('\n');
  assert.deepEqual(await ipBlock.parseListAsync('lines', text), ipBlock.parseList('lines', text));
  await ipBlock.refreshLists({ force: true });
  const sets = new Map(ipBlock._state.listed);
  assert.deepEqual(ipBlock.check('45.150.23.100'), { by: 'attackers' });
  assert.deepEqual(ipBlock.check('2a0b:4140::7'), { by: 'attackers' });
  assert.deepEqual(ipBlock.check('1.10.31.255'), { by: 'drop' });
  assert.equal(ipBlock.check('1.10.32.0'), null);
  for (let i = 1; i <= 3; i++) {
    ipBlock.noteFailure(`91.200.12.${i}`, 'login', 'x');
    ipBlock.noteFailure(`91.200.12.${i}`, 'login', 'x');
    assert.equal(ipBlock.noteFailure(`91.200.12.${i}`, 'login', 'x'), true);
  }
  ipBlock.sweep(Date.now() + 86400e3);
  for (const [id, set] of sets) assert.equal(ipBlock._state.listed.get(id), set, `${id}: the same set after bans and expiries`);
  // a restart reads the list files again (fast path for IPv4 CIDR texts) — same answers
  ipBlock._state.listEntries.clear();
  ipBlock._state.listSets.clear();
  ipBlock.rebuild();
  assert.notEqual(ipBlock._state.listed.get('attackers'), sets.get('attackers'));
  assert.deepEqual(ipBlock.check('45.150.23.100'), { by: 'attackers' });
  assert.deepEqual(ipBlock.check('2a0b:4140::7'), { by: 'attackers' });
  assert.deepEqual(ipBlock.check('1.10.16.1'), { by: 'drop' });
  assert.equal(ipBlock.check('45.151.0.1'), null);
  // the block file still carries every list entry
  ipBlock.writeNow();
  const file = fs.readFileSync(ipBlock.blockFile(), 'utf8');
  assert.ok(file.includes('\n45.150.23.100/32\n') && file.includes('1.10.16.0/20') && file.includes('2a0b:4140::7/128'));
}

test('PrefixSet.addText: the IPv4 fast path matches the full parser', () => {
  const a = new ipBlock.PrefixSet();
  const b = new ipBlock.PrefixSet();
  // leading zeros are no canonical text: they take the full parser, like everything that is not a.b.c.d/n
  for (const t of ['1.10.16.0/20', '45.155.205.99/32', '8.8.8.8/32', '2a06:e480::/29', '0.0.0.0/0', '010.1.1.1/32']) {
    assert.equal(a.addText(t), true);
    b.add(require('../src/services/wafBans').parseAddress(t));
  }
  assert.equal(a.addText('bad'), false);
  assert.equal(a.size, b.size);
  assert.deepEqual([...a.v4.keys()].sort(), [...b.v4.keys()].sort());
  for (const [bits, set] of b.v4) assert.deepEqual([...a.v4.get(bits)].sort(), [...set].sort());
  assert.deepEqual([...a.v6.keys()], [...b.v6.keys()]);
});

test('access log: probe paths, other 404s in tens, 429 only when switched on, blocked hits counted', () => {
  ipBlock.setConfig({ threshold: 3 });
  const line = (ip, status, uri, extra = {}) => JSON.stringify({ status, request: { client_ip: ip, host: 'a.example.de', uri }, ...extra });
  ipBlock.noteAccessLines([line('185.220.100.1', 404, '/.env'), line('185.220.100.1', 404, '/wp-admin/x.php'), line('185.220.100.1', 404, '/.git/config')]);
  assert.ok(ipBlock.check('185.220.100.1'));
  const many = [];
  for (let i = 0; i < 25; i++) many.push(line('185.220.100.2', 404, `/page${i}`));
  ipBlock.noteAccessLines(many);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ip_block_failures WHERE ip = '185.220.100.2'").get().n, 2);
  ipBlock.noteAccessLines([line('185.220.100.3', 429, '/'), line('185.220.100.3', 429, '/'), line('185.220.100.3', 429, '/')]);
  assert.equal(ipBlock.check('185.220.100.3'), null);
  ipBlock.noteAccessLines([line('185.220.100.9', 403, '/', { resp_headers: { 'X-Gc-Block': ['1'] } })]);
  assert.equal(ipBlock.stats().blockedHits24h, 1);
});

test('lockout failures feed the block (login and route login)', () => {
  ipBlock.setConfig({ threshold: 3 });
  const lockout = require('../src/services/lockout');
  lockout.recordFailedAttempt('alice', 'admin', '185.220.100.60');
  lockout.recordFailedAttempt('bob', 'admin', '185.220.100.60');
  lockout.recordFailedAttempt('a@b.c:99999', 'route_auth', '185.220.100.60');
  const b = ipBlock.listBans().find((x) => x.ip === '185.220.100.60');
  assert.ok(b);
  assert.deepEqual(b.sources, { login: 2, route_auth: 1 });
});

test('middleware: a blocked address gets 403 before anything else', () => {
  ipBlock.banManual({ ip: '185.220.100.77', hours: 1 });
  let status = null;
  let nextCalled = false;
  const res = { setHeader() {}, status(s) { status = s; return this; }, type() { return this; }, send() { return this; } };
  ipBlock.middleware({ ip: '185.220.100.77' }, res, () => { nextCalled = true; });
  assert.equal(status, 403);
  assert.equal(nextCalled, false);
  ipBlock.middleware({ ip: '::ffff:127.0.0.1' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('sweep removes expired bans and old failures', () => {
  ipBlock.banManual({ ip: '185.220.100.88', hours: 1 });
  db.prepare("UPDATE ip_blocks SET expires_at = ? WHERE ip = '185.220.100.88'").run(Date.now() - 1);
  db.prepare("INSERT INTO ip_block_failures (ip, source, detail, at) VALUES ('185.220.100.89', 'login', NULL, ?)").run(Date.now() - 3 * 3600e3);
  assert.equal(ipBlock.sweep(), 1);
  assert.equal(ipBlock.check('185.220.100.88'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ip_block_failures').get().n, 0);
});

// ─── API ────────────────────────────────────────────

test('API: read, save with field errors, ban, unban, never list', async () => {
  let r = await GET('/settings/ip-block');
  assert.equal(r.status, 200);
  assert.equal(r.body.config.threshold, 10);
  assert.equal(r.body.vpnSubnet, '10.8.0.0/24');
  r = await PUT('/settings/ip-block', { threshold: 2 });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.threshold);
  r = await PUT('/settings/ip-block', { threshold: 20, window_min: 60, sources: { rate_limit: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.threshold, 20);
  assert.equal(r.body.config.sources.rate_limit, true);
  r = await PUT('/settings/ip-block', { lists: { tor: true } });
  assert.equal(r.status, 403);
  assert.equal(r.body.feature, 'ip_blocklists');
  r = await POST('/settings/ip-block/bans', { ip: '185.220.100.0/24', hours: 24, note: 'test' });
  assert.equal(r.status, 201);
  r = await GET('/settings/ip-block');
  assert.equal(r.body.bans.length, 1);
  r = await DEL('/settings/ip-block/bans/' + encodeURIComponent('185.220.100.0/24'));
  assert.equal(r.status, 200);
  r = await DEL('/settings/ip-block/bans/' + encodeURIComponent('185.220.100.0/24'));
  assert.equal(r.status, 404);
  r = await POST('/settings/ip-block/never', { ip: '45.155.205.0/28', label: 'Büro' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.never, [{ ip: '45.155.205.0/28', label: 'Büro' }]);
  r = await DEL('/settings/ip-block/never/' + encodeURIComponent('45.155.205.0/28'));
  assert.equal(r.status, 200);
  r = await POST('/settings/ip-block/lists/refresh');
  assert.equal(r.status, 403, 'block lists need the licence');
});

test('API: forbidden for API tokens', async () => {
  const tokens = require('../src/services/tokens');
  license._overrideForTest({ api_tokens: true });
  const t = tokens.create({ name: 'ipb', scopes: ['settings'] }, '127.0.0.1');
  const r = await require('supertest')(app).get('/api/v1/settings/ip-block').set('Authorization', 'Bearer ' + t.rawToken);
  license._overrideForTest({ api_tokens: false });
  assert.equal(r.status, 403);
});
