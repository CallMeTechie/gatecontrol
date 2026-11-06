'use strict';

// Phase 3b of the gateways, server side: the DNS filter — features.timezone
// and features.dns in the config pull (and the hash), profiles with people
// and devices of the network watch (→ MAC addresses), the statistics
// endpoint (idempotent, daily values), the admin API (session + CSRF +
// admin), "Test: Domain prüfen" over the management API, the router check,
// the times of a profile in the server's time zone and the notice
// "DNS-Filter ausgefallen" (offline > 5 min, port 53 taken) and its end.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, gateways, annaId, timId;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const PHONE = '3c:22:fb:00:00:02';
const TIM = 'da:a1:19:00:00:05';
const TIM_TAB = 'da:a1:19:00:00:06';
const TV = 'a8:23:fe:44:55:66';
const PRINTER = '30:05:5c:11:22:33';
const ROUTER = 'f0:9f:c2:00:00:01';

function gwReq(method, path, g = gw) {
  return supertest(app)[method]('/api/v1/gateway' + path).set('Authorization', 'Bearer ' + g.apiToken);
}
const admin = (method, path, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + path).set('X-CSRF-Token', csrf);
function activities(type) {
  return db.prepare('SELECT event_type, message, details FROM activity_log WHERE event_type = ? ORDER BY id').all(type).map((r) => ({ ...r, details: JSON.parse(r.details || 'null') }));
}
const dev = (mac, ip, extra) => ({ mac, ip, vendor: null, hostname: null, randomMac: false, online: true, firstSeen: Date.now() - MIN, lastSeen: Date.now(), ports: null, ...extra });
const devId = (mac) => db.prepare('SELECT id FROM netwatch_devices WHERE peer_id = ? AND mac = ?').get(gw.peer.id, mac).id;
const pushed = [];
let STD; // the default profile's name in the server's language

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  STD = require('../src/services/notify/text').serverLang() === 'en' ? 'Default' : 'Standard';
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gw = await gateways.createGateway({ name: 'Pi Keller' });
  gw2 = await gateways.createGateway({ name: 'NAS Buero' });
  db = require('../src/db/connection').getDb();
  gateways.notifyConfigChanged = async (id) => { pushed.push(id); };
  require('../config/default').app.baseUrl = 'https://gc.example.com';
  const users = require('../src/services/users');
  annaId = (await users.create({ username: 'anna', password: 'AnnaPass123!x', role: 'user', displayName: 'Anna' })).id;
  timId = (await users.create({ username: 'tim', password: 'TimPass123!xy', role: 'user', displayName: 'Tim' })).id;
  // the inventory: Tim with phone and tablet, Anna's phone, a TV, a printer, the router
  await gwReq('post', '/netwatch').send({ full: true, devices: [
    dev(PHONE, '192.168.1.104'), dev(TIM, '192.168.1.120'), dev(TIM_TAB, '192.168.1.121'), dev(TV, '192.168.1.55'),
    dev(PRINTER, '192.168.1.40'), dev(ROUTER, '192.168.1.1'),
  ] }).expect(200);
  const put = (mac, body) => agent.put(`/api/v1/gateways/${gw.peer.id}/netwatch/devices/${devId(mac)}`).set('X-CSRF-Token', csrf).send(body).expect(200);
  await put(PHONE, { name: 'Annas Handy', ownerUserId: annaId });
  await put(TIM, { name: 'Tims Handy', ownerUserId: timId });
  await put(TIM_TAB, { name: 'Tims Tablet', ownerUserId: timId });
  await put(TV, { name: 'Fernseher' });
  db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({
    telemetry: { gateway_version: '1.22.0', lan_ip: '192.168.1.23', default_gateway_ip: '192.168.1.1',
      features: { dns: { enabled: true, running: true, state: 'running', listen: ['192.168.1.23', 'fe80::1', 'fd00::ba27:ebff:fe12:3456'] } } },
  }), Date.now(), gw.peer.id);
});

after(() => { teardown(); });

describe('migration 129', () => {
  it('creates the tables of phase 3b', () => {
    for (const t of ['gateway_dns', 'dns_reports', 'dns_stats_day', 'home_internet', 'gateway_cache', 'home_cache_blobs', 'home_cache_have', 'cache_stats_day']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
    }
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 129);
    assert.equal(m.name, 'gateway_dns_cache');
    assert.equal(m.detect(db), true);
  });
});

describe('features.timezone and features.dns in the config pull', () => {
  it('the server time zone always, the filter switched off as { enabled: false }', async () => {
    const r = await gwReq('get', '/config').expect(200);
    assert.equal(r.body.features.timezone, require('../src/services/gatewayFeatures').timezone());
    assert.deepEqual(r.body.features.dns, { enabled: false });
    assert.equal(r.body.config_hash, gateways.computeConfigHash(gw.peer.id));
  });

  it('switching it on sends everything and changes the hash; the gateway is told', async () => {
    const before0 = (await gwReq('get', '/config')).body.config_hash;
    pushed.length = 0;
    const r = await admin('put', '/dns').send({ enabled: true }).expect(200);
    assert.equal(r.body.settings.enabled, true);
    assert.deepEqual(pushed, [gw.peer.id]);
    const c = await gwReq('get', '/config').expect(200);
    const d = c.body.features.dns;
    assert.notEqual(c.body.config_hash, before0);
    assert.equal(c.body.config_hash, gateways.computeConfigHash(gw.peer.id));
    assert.equal(d.enabled, true);
    assert.equal(d.listen, 'lan');
    assert.deepEqual(d.upstream, { mode: 'doh', provider: 'quad9', fallbackRouter: true });
    assert.equal(d.logQueries, false);
    assert.deepEqual(d.alwaysAllow, ['gc.example.com']);
    assert.deepEqual(Object.keys(d.lists).sort(), ['ads', 'malware']);
    assert.equal(d.lists.ads.format, 'adblock');
    assert.ok(d.lists.ads.url.startsWith('https://'));
    assert.equal(d.lists.ads.sha256, null);
    assert.deepEqual(Object.keys(d.categories), ['social', 'games', 'video']);
    assert.ok(d.categories.social.some((x) => x === 'tiktok.com'));
    assert.equal(d.defaultProfile, 'default');
    assert.equal(d.profiles.length, 1);
    assert.deepEqual(d.profiles[0].macs, []);
    assert.deepEqual(d.pauses, []);
    assert.deepEqual(d.extensions, []);
    // unchanged config → the gateway's check answers 304
    await gwReq('get', '/config/check?hash=' + encodeURIComponent(c.body.config_hash)).expect(304);
  });

  it('a custom DoH server only over https; dns0 is not offered', async () => {
    assert.equal((await admin('put', '/dns').send({ upstream: { provider: 'custom', url: 'http://dns.example/dns-query' } })).body.code, 'invalid_url');
    assert.equal((await admin('put', '/dns').send({ upstream: { provider: 'custom' } })).body.code, 'invalid_url');
    assert.equal((await admin('put', '/dns').send({ upstream: { provider: 'dns0' } })).status, 400);
    await admin('put', '/dns').send({ upstream: { provider: 'custom', url: 'https://dns.example.org/dns-query', fallbackRouter: false } }).expect(200);
    const d = (await gwReq('get', '/config')).body.features.dns;
    assert.deepEqual(d.upstream, { mode: 'doh', provider: 'custom', url: 'https://dns.example.org/dns-query', fallbackRouter: false });
    await admin('put', '/dns').send({ upstream: { provider: 'quad9', fallbackRouter: true } }).expect(200);
    assert.deepEqual((await gwReq('get', '/config')).body.features.dns.upstream, { mode: 'doh', provider: 'quad9', fallbackRouter: true });
  });
});

describe('profiles: people and devices of the network watch → MAC addresses', () => {
  let kids;
  it('a profile for Tim: his devices follow him, a device picked directly wins', async () => {
    const r = await admin('post', '/dns/profiles').send({
      name: 'Kinder', lists: ['ads', 'malware', 'adult'], safeSearch: true, users: [timId], devices: [devId(TV)],
      allow: ['Anton.App', '*.schulportal.hessen.de'], deny: ['example.com'],
      schedules: [{ days: [1, 2, 3, 4, 5], from: '21:00', to: '07:00', block: 'categories', categories: ['social', 'games', 'video'], allowAlways: ['anton.app'] },
        { days: [6, 7], from: '22:00', to: '08:00', block: 'all' }],
    }).expect(200);
    kids = r.body.profile;
    assert.match(kids.id, /^p[0-9a-f]{8}$/);
    assert.deepEqual(kids.allow, ['*.schulportal.hessen.de', 'anton.app']);
    const free = (await admin('post', '/dns/profiles').send({ name: 'Ohne Filter', lists: [], devices: [devId(PRINTER), devId(TIM_TAB)] }).expect(200)).body.profile;
    await admin('put', '/dns').send({ allowAll: ['zoom.us'] }).expect(200);
    const d = (await gwReq('get', '/config')).body.features.dns;
    const byId = Object.fromEntries(d.profiles.map((p) => [p.id, p]));
    // Tim's tablet is put into "Ohne Filter" directly: that wins over his person
    assert.deepEqual(byId[kids.id].macs, [TV, TIM].sort());
    assert.deepEqual(byId[free.id].macs, [PRINTER, TIM_TAB].sort());
    assert.deepEqual(byId.default.macs, []);
    assert.equal(byId[kids.id].safeSearch, true);
    assert.deepEqual(byId[kids.id].allow, ['*.schulportal.hessen.de', 'anton.app', 'zoom.us']);
    assert.deepEqual(byId.default.allow, ['zoom.us']);
    assert.deepEqual(byId[kids.id].schedules[1], { days: [6, 7], from: '22:00', to: '08:00', block: 'all', categories: [], allowAlways: [] });
    assert.deepEqual(Object.keys(d.lists).sort(), ['ads', 'adult', 'malware']);
    // the default profile comes first
    assert.equal(d.profiles[0].id, 'default');
  });

  it('wrong values: a URL as domain, a broken time, the default profile cannot be deleted, names unique', async () => {
    const bad = await admin('put', `/dns/profiles/${kids.id}`).send({ allow: ['https://foo.de/x'] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_domain');
    assert.equal(bad.body.value, 'https://foo.de/x');
    assert.equal((await admin('put', `/dns/profiles/${kids.id}`).send({ schedules: [{ days: [1], from: '21:00', to: '21:00', block: 'all' }] })).body.code, 'invalid_schedule');
    assert.equal((await admin('put', `/dns/profiles/${kids.id}`).send({ schedules: [{ days: [], from: '21:00', to: '07:00', block: 'all' }] })).body.code, 'invalid_schedule');
    assert.equal((await admin('put', `/dns/profiles/${kids.id}`).send({ lists: ['nope'] })).status, 400);
    assert.equal((await admin('put', `/dns/profiles/${kids.id}`).send({ users: [99999] })).body.code, 'invalid_member');
    assert.equal((await admin('put', `/dns/profiles/${kids.id}`).send({ devices: [99999] })).body.code, 'invalid_member');
    assert.equal((await admin('delete', '/dns/profiles/default')).status, 409);
    assert.equal((await admin('post', '/dns/profiles').send({ name: 'kinder' })).body.code, 'name_taken');
    assert.equal((await admin('put', '/dns/profiles/default').send({ users: [timId] })).status, 400);
    assert.equal((await admin('put', '/dns/profiles/nope').send({ name: 'x' })).status, 404);
    // a device of another gateway is no member here
    assert.equal((await admin('put', `/dns/profiles/${kids.id}`, gw2).send({ name: 'x' })).status, 404);
  });

  it('a person\'s profile and the next time window (server time zone)', () => {
    const dns = require('../src/services/homeDns');
    assert.equal(dns.profileOfUser(gw.peer.id, timId).id, kids.id);
    assert.equal(dns.profileOfUser(gw.peer.id, annaId).id, 'default');
    const tz = 'Europe/Berlin';
    // Wednesday 5 November 2026, 20:00 in Berlin (CET, UTC+1)
    const wed20 = dns.zoned(2026, 11, 5, 20, 0, tz);
    assert.equal(new Date(wed20).toISOString(), '2026-11-05T19:00:00.000Z');
    const p = dns.profileOfUser(gw.peer.id, timId);
    const n1 = dns.nextSchedule(p, wed20, tz);
    assert.deepEqual(n1, { from: '2026-11-05T20:00:00.000Z', to: '2026-11-06T06:00:00.000Z', block: 'categories', categories: ['social', 'games', 'video'], active: false });
    const n2 = dns.nextSchedule(p, dns.zoned(2026, 11, 6, 2, 0, tz), tz); // Friday 02:00: the night from Thursday runs
    assert.equal(n2.active, true);
    assert.equal(n2.from, '2026-11-05T20:00:00.000Z');
    const n3 = dns.nextSchedule(p, dns.zoned(2026, 11, 7, 12, 0, tz), tz); // Saturday noon → Saturday 22:00 "all"
    assert.equal(n3.block, 'all');
    assert.equal(n3.from, '2026-11-07T21:00:00.000Z');
    assert.equal(dns.nextSchedule({ schedules: [] }, wed20, tz), null);
    // summer time: a window on 29 March 2026 (the switch day) starts at 21:00 CEST
    assert.equal(new Date(dns.zoned(2026, 3, 29, 21, 0, tz)).toISOString(), '2026-03-29T19:00:00.000Z');
    assert.equal(dns.dayKey(dns.zoned(2026, 11, 5, 23, 30, tz), tz), '2026-11-05');
  });

  it('patterns: subdomains, wildcards, punycode; junk is refused', () => {
    const { normPattern } = require('../src/services/homeDns');
    assert.equal(normPattern('Example.COM.'), 'example.com');
    assert.equal(normPattern('*.foo.de'), '*.foo.de');
    assert.equal(normPattern('bücher.de'), 'xn--bcher-kva.de');
    for (const x of ['', 'com', '*', 'a b.de', 'http://x.de', 'x.de/path', '-x.de', 42, null]) assert.equal(normPattern(x), null, String(x));
  });
});

describe('statistics: POST /api/v1/gateway/dns', () => {
  const t0 = Date.now() - 10 * MIN;
  const report = (from, extra) => ({
    period: { from, to: from + 5 * MIN }, queries: 1000, blocked: 180, cached: 610, avgMs: 4,
    topBlocked: [{ domain: 'DoubleClick.net', count: 120, profileId: 'default' }, { domain: 'tiktok.com', count: 30, profileId: null }],
    byProfile: { default: { queries: 800, blocked: 150 } },
    clientsSeen: [PHONE, TIM, TV.toUpperCase().replace(/:/g, '-')],
    ...extra,
  });

  it('adds a report to the day; the same period again counts once', async () => {
    await gwReq('post', '/dns').send(report(t0)).expect(200);
    await gwReq('post', '/dns').send(report(t0)).expect(200);
    await gwReq('post', '/dns').send(report(t0 + 5 * MIN, { queries: 500, blocked: 20, cached: 100, avgMs: 10, topBlocked: [{ domain: 'doubleclick.net', count: 5, profileId: 'default' }], clientsSeen: [PHONE] })).expect(200);
    const v = (await admin('get', '/dns').expect(200)).body;
    assert.equal(v.today.queries, 1500);
    assert.equal(v.today.blocked, 200);
    assert.equal(v.today.blockedPct, 13.3);
    assert.equal(v.today.cachedPct, 47.3);
    assert.equal(v.today.avgMs, 6); // (4 × 1000 + 10 × 500) / 1500
    assert.equal(v.today.clients, 3);
    assert.deepEqual(v.top.slice(0, 2).map((x) => [x.domain, x.count]), [['doubleclick.net', 125], ['tiktok.com', 30]]);
    assert.equal(v.top[0].profileName, STD);
  });

  it('the router check: online devices that did not ask today (not the router itself)', async () => {
    const v = (await admin('get', '/dns').expect(200)).body;
    assert.equal(v.router.state, 'partial');
    assert.equal(v.router.asking, 3);
    assert.ok(v.router.missing.some((x) => x.name === 'Tims Tablet'));
    const missingIps = v.router.missing.map((x) => x.ip).sort();
    assert.deepEqual(missingIps, ['192.168.1.121', '192.168.1.40']);
    assert.equal(v.router.missingCount, 2);
    assert.deepEqual(v.addresses, { v4: ['192.168.1.23'], v6: ['fe80::1', 'fd00::ba27:ebff:fe12:3456'] });
    // the admin view lists devices with their profile — the gateway's own data, never for plugins
    assert.equal(v.devices.find((x) => x.mac === TIM).profileId, v.profiles[1].id);
    assert.equal(v.profiles[1].people[0].name, 'Tim');
    assert.equal(v.profiles[1].deviceCount, 2);
  });

  it('wrong shapes are refused with 400; old periods are fine', async () => {
    assert.equal((await gwReq('post', '/dns').send({})).status, 400);
    assert.equal((await gwReq('post', '/dns').send({ period: { from: 'x', to: 'y' } })).status, 400);
    assert.equal((await gwReq('post', '/dns').send(report(t0 - DAY, { queries: -1 }))).status, 400);
    assert.equal((await gwReq('post', '/dns').send(report(t0 - DAY, { clientsSeen: new Array(1025).fill(PHONE) }))).status, 400);
    assert.equal((await gwReq('post', '/dns').send(report(t0 - DAY, { topBlocked: 'x' }))).status, 400);
    await gwReq('post', '/dns').send(report(t0 - DAY)).expect(200);
    assert.equal((await supertest(app).post('/api/v1/gateway/dns').send(report(t0))).status, 401);
  });

  it('retention: daily values a year, idempotence keys two days', () => {
    const dns = require('../src/services/homeDns');
    db.prepare("INSERT INTO dns_stats_day (peer_id, day, queries) VALUES (?, '2024-01-01', 5)").run(gw.peer.id);
    db.prepare('INSERT INTO dns_reports (peer_id, from_at, at) VALUES (?, 1, ?)').run(gw.peer.id, Date.now() - 3 * DAY);
    const r = dns.retention();
    assert.ok(r.days >= 1 && r.reports >= 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dns_stats_day WHERE day = '2024-01-01'").get().n, 0);
  });
});

describe('admin API: session, CSRF, "Test: Domain prüfen"', () => {
  it('API tokens are refused, writes need the CSRF token', async () => {
    const { rawToken } = require('../src/services/tokens').create({ name: 'p3b-tok', scopes: ['full-access'] }, '127.0.0.1');
    const anon = supertest(app);
    assert.equal((await anon.get(`/api/v1/gateways/${gw.peer.id}/dns`).set('Authorization', 'Bearer ' + rawToken)).status, 403);
    assert.equal((await anon.put(`/api/v1/gateways/${gw.peer.id}/dns`).set('Authorization', 'Bearer ' + rawToken).send({ enabled: false })).status, 403);
    assert.equal((await anon.get(`/api/v1/gateways/${gw.peer.id}/cache`).set('Authorization', 'Bearer ' + rawToken)).status, 403);
    assert.equal((await anon.get(`/api/v1/gateways/${gw.peer.id}/dns`)).status, 401);
    assert.equal((await agent.put(`/api/v1/gateways/${gw.peer.id}/dns`).send({ enabled: false })).status, 403);
    assert.equal((await admin('get', '/dns').set('X-CSRF-Token', csrf)).status, 200);
  });

  it('the gateway answers through the management API; old gateways and errors', async () => {
    const calls = [];
    const orig = gateways.mgmtCall;
    gateways.mgmtCall = async (peerId, path, payload) => { calls.push({ peerId, path, payload }); return { status: 200, body: { profileId: calls.length > 1 ? 'nope' : 'default', action: 'block', reason: 'list ads <b>' } }; };
    try {
      const r = await admin('post', '/dns/test').send({ domain: 'DoubleClick.net', deviceId: devId(TIM) }).expect(200);
      assert.deepEqual(calls[0], { peerId: gw.peer.id, path: '/api/dns/test', payload: { domain: 'doubleclick.net', mac: TIM } });
      assert.equal(r.body.result.action, 'block');
      assert.equal(r.body.result.profileName, STD);
      assert.equal(r.body.result.reason, 'list ads b');
      await admin('post', '/dns/test').send({ domain: 'example.com' }).expect(200);
      assert.deepEqual(calls[1].payload, { domain: 'example.com' });
      assert.equal((await admin('post', '/dns/test').send({ domain: 'not a domain' })).body.code, 'invalid_domain');
      gateways.mgmtCall = async () => ({ status: 404, body: null });
      assert.equal((await admin('post', '/dns/test').send({ domain: 'example.com' })).body.code, 'gateway_unsupported');
      gateways.mgmtCall = async () => null;
      assert.equal((await admin('post', '/dns/test').send({ domain: 'example.com' })).status, 502);
    } finally { gateways.mgmtCall = orig; }
  });

  it('the card "Funktionen": DNS filter, memory with the lists, the time zone', async () => {
    const g = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(g.dns.enabled, true);
    assert.equal(g.dns.state, 'running');
    assert.equal(g.support.dns, true);
    assert.equal(g.timezone.tz, require('../src/services/gatewayFeatures').timezone());
    const part = g.memory.parts.find((p) => p.key === 'dns');
    // ads 78 000 + malware 195 000 + adult 92 000 entries × 8 bytes (hashes, gateway side 1) + 25 MB
    assert.equal(part.entries, 365000);
    assert.equal(part.mb, 25 + Math.round((365000 * 8) / 1048576));
  });
});

describe('notice "DNS-Filter ausgefallen"', () => {
  it('offline longer than 5 minutes → one notice, its return → the end', () => {
    const dns = require('../src/services/homeDns');
    db.prepare('UPDATE gateway_meta SET last_seen_at = ? WHERE peer_id = ?').run(Date.now() - 3 * MIN, gw.peer.id);
    assert.deepEqual(dns.checkDown(), []);
    db.prepare('UPDATE gateway_meta SET last_seen_at = ? WHERE peer_id = ?').run(Date.now() - 6 * MIN, gw.peer.id);
    assert.deepEqual(dns.checkDown().map((x) => [x.type, x.reason]), [['dns_filter_down', 'offline']]);
    assert.deepEqual(dns.checkDown(), [], 'only once');
    const down = activities('dns_filter_down');
    assert.equal(down.length, 1);
    assert.equal(down[0].details.peer_id, gw.peer.id);
    assert.equal(down[0].details.reason, 'offline');
    assert.match(down[0].message, /Pi Keller/);
    db.prepare('UPDATE gateway_meta SET last_seen_at = ? WHERE peer_id = ?').run(Date.now(), gw.peer.id);
    assert.deepEqual(dns.checkDown().map((x) => x.type), ['dns_filter_up']);
    assert.equal(activities('dns_filter_up').length, 1);
    assert.equal(dns.outageOf(gw.peer.id), null);
  });

  it('port 53 taken → at once; a gateway too old for the filter is never "down"', () => {
    const dns = require('../src/services/homeDns');
    const h = JSON.parse(db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(gw.peer.id).last_health);
    h.telemetry.features.dns.state = 'port_busy';
    h.telemetry.features.dns.running = false;
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify(h), gw.peer.id);
    assert.deepEqual(dns.checkDown().map((x) => [x.type, x.reason]), [['dns_filter_down', 'port_busy']]);
    assert.equal(dns.outageOf(gw.peer.id).reason, 'port_busy');
    h.telemetry.features.dns.state = 'running';
    h.telemetry.features.dns.running = true;
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify(h), gw.peer.id);
    assert.deepEqual(dns.checkDown().map((x) => x.type), ['dns_filter_up']);
    // gw2: filter on, never seen, no capability → no notice
    dns.setGeneral(gw2.peer.id, { enabled: true });
    db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = NULL WHERE peer_id = ?').run(JSON.stringify({ telemetry: { gateway_version: '1.21.0' } }), gw2.peer.id);
    assert.deepEqual(dns.checkDown().filter((x) => x.peerId === gw2.peer.id), []);
  });

  it('the catalogue: dns_filter in the group "network", the end closes the alarm', () => {
    const g = require('../src/services/notifications').CATALOGUE.find((x) => x.id === 'network');
    assert.deepEqual(g.events.find((e) => e.id === 'dns_filter').types, ['dns_filter_down', 'dns_filter_up']);
    assert.ok(require('../src/services/notify/rules').RECOVERY_TYPES.has('dns_filter_up'));
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    for (const k of ['st.event.dns_filter', 'push.type.dns_filter_down', 'push.type.dns_filter_up', 'push.named.dns_filter_down', 'push.named.dns_filter_up',
      'push.dns.down_offline', 'push.dns.down_port_busy', 'push.dns.up', 'push.dns.reason_offline', 'push.dns.reason_port_busy']) {
      assert.ok(de[k] && en[k], k);
    }
  });
});

describe('pauses and extra time in features.dns', () => {
  it('a pause of Tim goes to the gateways where he has devices, with his MACs; the gateway is told', () => {
    const hi = require('../src/services/homeInternet');
    pushed.length = 0;
    const st = hi.pause(timId, 30, { pluginId: 'familie', actors: [1] });
    assert.ok(st.paused);
    assert.deepEqual(pushed, [gw.peer.id]);
    const d = require('../src/services/homeDns').configPayload(gw.peer.id);
    assert.deepEqual(d.pauses, [{ macs: [TIM, TIM_TAB].sort(), until: st.paused }]);
    assert.deepEqual(d.extensions, []);
    assert.deepEqual(require('../src/services/homeDns').configPayload(gw2.peer.id).pauses, []);
    hi.extend(timId, 15, { pluginId: 'familie', actors: [1] });
    assert.equal(require('../src/services/homeDns').configPayload(gw.peer.id).extensions.length, 1);
    hi.resume(timId, { actors: [1] });
    hi.extend(timId, 0, { actors: [1] });
    const d2 = require('../src/services/homeDns').configPayload(gw.peer.id);
    assert.deepEqual([d2.pauses, d2.extensions], [[], []]);
  });

  it('ended pauses drop out of the config and the table', () => {
    const hi = require('../src/services/homeInternet');
    db.prepare("INSERT INTO home_internet (user_id, kind, until_at, created_at) VALUES (?, 'pause', ?, ?)").run(annaId, Date.now() - 1000, Date.now() - MIN);
    assert.deepEqual(require('../src/services/homeDns').configPayload(gw.peer.id).pauses, []);
    assert.equal(hi.cleanup(), 1);
  });
});

describe('features.timezone() reads TZ of the server first', () => {
  const tzOf = () => require('../src/services/gatewayFeatures').timezone();
  let saved;
  before(() => { saved = process.env.TZ; });
  after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });

  it('TZ=Europe/Berlin and TZ=:Europe/Berlin give Europe/Berlin', () => {
    process.env.TZ = 'Europe/Berlin';
    assert.equal(tzOf(), 'Europe/Berlin');
    process.env.TZ = ':Europe/Berlin';
    assert.equal(tzOf(), 'Europe/Berlin');
  });

  it('an invalid TZ falls back to the zone of the runtime, never throws', () => {
    process.env.TZ = 'Mars/Olympus';
    const tz = tzOf();
    assert.equal(typeof tz, 'string');
    assert.notEqual(tz, 'Mars/Olympus');
  });
});
