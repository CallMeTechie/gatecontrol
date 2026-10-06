'use strict';

// Dashboard redesign (2026-10): the new and changed endpoints behind
// /dashboard — shape, role gate, licence gating, rate limiting:
//   GET /api/v1/dashboard/stats            peers split into clients/gateways (one source)
//   GET /api/v1/dashboard/traffic          1h/24h/7d/30d, unit, continuous buckets
//   GET /api/v1/dashboard/top-peers        SQL aggregate of peer_traffic_snapshots
//   GET /api/v1/dashboard/security-summary WAF/logins/bots/Pi-hole/check, cached
//   GET /api/v1/logs/recent?category=      allow-listed category → event_type prefixes
//   GET /api/v1/gateways?peek=1            no side effect on the update tracking
//   GET /dashboard                         non-admin sessions go to /profile

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

let app, agent, db, license, security;
before(async () => {
  ({ app } = await setup());
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  security = require('../src/services/dashboardSecurity');
});
after(() => teardown());

async function loginAs(username, role) {
  const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
  // A member ('user') signs in only with "Mein Bereich" (self_service_enabled).
  db.prepare('INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES (?, ?, ?, ?)').run(username, hash, role, role === 'user' ? 1 : 0);
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  await a.post('/login').type('form').send({ username, password: 'Plain!Pass1234', _csrf: csrf }).expect(302);
  return a;
}

function addPeer(name, type = 'regular', handshake = 0) {
  return Number(db.prepare('INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, latest_handshake) VALUES (?, ?, ?, 1, ?, ?)')
    .run(name, crypto.randomBytes(16).toString('base64'), '10.8.9.' + Math.floor(Math.random() * 200 + 10) + '/32', type, handshake).lastInsertRowid);
}

const NEW_ENDPOINTS = ['/api/v1/dashboard/top-peers', '/api/v1/dashboard/security-summary', '/api/v1/logs/recent?category=login', '/api/v1/gateways?peek=1'];

describe('roles and rate limiting', () => {
  it('a member is sent from /dashboard to /me and gets 403 on every dashboard API', async () => {
    const a = await loginAs('dash-plain-user', 'user');
    const page = await a.get('/dashboard');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/me');
    for (const url of NEW_ENDPOINTS.concat(['/api/v1/dashboard/stats', '/api/v1/dashboard/traffic?period=30d'])) {
      assert.equal((await a.get(url)).status, 403, url);
    }
  });

  it('the admin dashboard renders with the strings island', async () => {
    const res = await agent.get('/dashboard').expect(200);
    const island = res.text.match(/<script type="application\/json" id="db-i18n"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(island, 'island present');
    const strings = JSON.parse(island[1]);
    assert.ok(strings['dashboard.headline_ok']);
    assert.ok(strings['problems.gateway_offline']);
    assert.ok(Object.keys(strings).every((k) => k.startsWith('dashboard.') || k.startsWith('problems.')));
    assert.doesNotMatch(island[1], /</, 'no raw < inside the island');
  });

  it('unauthenticated requests are refused', async () => {
    for (const url of NEW_ENDPOINTS) assert.equal((await supertest(app).get(url)).status, 401, url);
  });

  it('the new endpoints go through the apiLimiter chain (rate-limit headers)', async () => {
    for (const url of NEW_ENDPOINTS) {
      const res = await agent.get(url).expect(200);
      assert.ok(res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'], `${url} is rate-limited`);
    }
  });
});

describe('GET /dashboard/stats', () => {
  it('splits the WireGuard peers into clients and gateways from the same handshake source', async (t) => {
    const wg = require('../src/services/wireguard');
    const gwKey = 'gwkey-' + crypto.randomBytes(4).toString('hex');
    db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('split-gw', ?, '10.8.7.2/32', 1, 'gateway')").run(gwKey);
    t.mock.method(wg, 'getStatus', async () => ({
      running: true,
      peers: [
        { publicKey: gwKey, isOnline: true },
        { publicKey: 'client-a', isOnline: true },
        { publicKey: 'client-b', isOnline: false },
      ],
    }));
    const res = await agent.get('/api/v1/dashboard/stats').expect(200);
    assert.deepEqual(res.body.peers.clients, { total: 2, online: 1 });
    assert.deepEqual(res.body.peers.gateways, { total: 1, online: 1 });
    assert.equal(res.body.peers.online, 2);
    assert.equal(res.body.wireguard.running, true);
  });
});

describe('GET /dashboard/traffic', () => {
  it('serves 1h/24h/7d/30d with their unit and bucket count; unknown periods fall back to 1h', async () => {
    for (const [p, n, unit] of [['1h', 60, 'minute'], ['24h', 24, 'hour'], ['7d', 7, 'day'], ['30d', 30, 'day'], ['1y', 60, 'minute']]) {
      const res = await agent.get('/api/v1/dashboard/traffic?period=' + p).expect(200);
      assert.equal(res.body.data.length, n, p);
      assert.equal(res.body.unit, unit, p);
      assert.ok(res.body.data.every((d) => typeof d.time === 'string' && 'upload' in d && 'download' in d), p);
    }
    const proto = await agent.get('/api/v1/dashboard/traffic?period=__proto__').expect(200);
    assert.equal(proto.body.period, '1h');
  });
});

describe('GET /dashboard/top-peers', () => {
  it('returns the top peers of today with online state and the client counts', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const a = addPeer('top-a', 'regular', nowS - 10);
    const b = addPeer('top-b', 'gateway', nowS - 99999);
    const ins = db.prepare("INSERT INTO peer_traffic_snapshots (peer_id, upload_bytes, download_bytes, recorded_at) VALUES (?, ?, ?, datetime('now'))");
    ins.run(a, 100, 900);
    ins.run(b, 5, 5);
    db.prepare("UPDATE peers SET client_product = 'pro', client_version = '1.0.0' WHERE id = ?").run(a);
    require('../src/services/settings').set(require('../src/services/clientUpdates').minVersionKey('pro'), '2.0.0');

    const res = await agent.get('/api/v1/dashboard/top-peers?limit=1').expect(200);
    assert.equal(res.body.period, 'today');
    assert.equal(res.body.peers.length, 1, 'limit is applied');
    assert.deepEqual(Object.keys(res.body.peers[0]).sort(), ['download', 'name', 'online', 'peer_id', 'peer_type', 'total', 'upload']);
    assert.equal(res.body.peers[0].name, 'top-a');
    assert.equal(res.body.peers[0].total, 1000);
    assert.equal(res.body.peers[0].online, true);
    assert.equal(res.body.clients.below_min, 1);

    const all = await agent.get('/api/v1/dashboard/top-peers?limit=999').expect(200);
    const gw = all.body.peers.find((p) => p.name === 'top-b');
    assert.equal(gw.online, false, 'a stale handshake is offline');
    assert.equal(gw.peer_type, 'gateway');
    assert.ok(all.body.peers.length <= 20, 'limit is capped');
  });
});

describe('GET /dashboard/security-summary', () => {
  it('without the licence features: WAF, bots and Pi-hole are null; logins and the check are there', async () => {
    license._overrideForTest({ waf: false, bot_blocking: false, pihole_integration: false });
    security._resetCacheForTest();
    db.prepare("INSERT INTO activity_log (event_type, message, severity) VALUES ('login_failed', 'x', 'warning'), ('login_2fa_failed', 'x', 'warning'), ('passkey_login_failed', 'x', 'warning')").run();
    db.prepare("INSERT INTO activity_log (event_type, message, severity, created_at) VALUES ('login_failed', 'old', 'warning', datetime('now', '-2 days'))").run();
    const res = await agent.get('/api/v1/dashboard/security-summary').expect(200);
    assert.equal(res.body.waf, null);
    assert.equal(res.body.bots, null);
    assert.equal(res.body.pihole, null);
    assert.equal(res.body.logins.failed_24h, 3, 'only the last 24 h, all three failure types');
    assert.equal(typeof res.body.logins.locked_accounts, 'number');
    const c = res.body.check;
    assert.ok(c && Number.isInteger(c.pass) && Number.isInteger(c.total) && Array.isArray(c.open));
    assert.ok(c.open.every((o) => o.id && o.title && o.title !== o.id), 'open items carry a translated title');
  });

  it('with the licences: hourly WAF series (24 buckets, current hour last), bans and the bot total', async () => {
    license._overrideForTest({ waf: true, bot_blocking: true, pihole_integration: true });
    security._resetCacheForTest();
    const now = new Date();
    const ev = db.prepare("INSERT INTO waf_events (ts, host, client_ip, action, tx_id) VALUES (?, 'w.example', '203.0.113.9', ?, ?)");
    ev.run(now.toISOString(), 'blocked', 'tx1');
    ev.run(now.toISOString(), 'blocked', 'tx1'); // same transaction, counted once
    ev.run(new Date(now - 3 * 3600e3).toISOString(), 'blocked', 'tx2');
    ev.run(now.toISOString(), 'detected', 'tx3');
    ev.run(new Date(now - 30 * 3600e3).toISOString(), 'blocked', 'tx-old');
    db.prepare("INSERT INTO waf_bans (ip, reason, banned_at, expires_at) VALUES ('198.51.100.1', 'x', ?, ?)").run(now.toISOString(), new Date(+now + 3600e3).toISOString());
    db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, bot_blocker_enabled, bot_blocker_count) VALUES ('bots.example', '10.8.0.9', 80, 'http', 1, 1, 41)").run();

    const res = await agent.get('/api/v1/dashboard/security-summary').expect(200);
    const waf = res.body.waf;
    assert.equal(waf.hourly.length, 24);
    assert.equal(waf.hourly[23], 1, 'current hour: one blocked transaction');
    assert.equal(waf.hourly[20], 1, 'three hours ago');
    assert.equal(waf.hourly.reduce((a, b) => a + b, 0), 2, 'older than 24 h is out');
    assert.equal(waf.blocked_24h, 2);
    assert.equal(waf.banned_ips, 1);
    assert.equal(res.body.bots.total, 41);
    assert.equal(res.body.bots.scope, 'total', 'a running counter, labelled as total');
    // No Pi-hole sync in tests: licensed, but no data → null (sub-tile hidden).
    assert.equal(res.body.pihole, null);
    license._overrideForTest({ waf: false, bot_blocking: false, pihole_integration: false });
  });

  it('is cached per user (30 s) — a second call within the window does not rebuild', async () => {
    security._resetCacheForTest();
    let builds = 0;
    const sc = require('../src/services/securityCheck');
    const orig = sc.runCheck;
    sc.runCheck = async (o) => { builds += 1; return orig(o); };
    try {
      const t = (k) => k;
      await security.summary({ userId: 1, lang: 'en', t, now: 1_000_000 });
      await security.summary({ userId: 1, lang: 'en', t, now: 1_000_000 + 10_000 });
      assert.equal(builds, 1);
      await security.summary({ userId: 1, lang: 'en', t, now: 1_000_000 + security.CACHE_MS + 1 });
      assert.equal(builds, 2);
      assert.equal(security.hourFrame(Date.UTC(2026, 0, 1, 5, 30)).length, 24);
    } finally { sc.runCheck = orig; security._resetCacheForTest(); }
  });
});

describe('GET /logs/recent?category=', () => {
  it('filters by an allow-listed category; prefixes are literal (no LIKE wildcards); unknown → 400', async () => {
    const ins = db.prepare("INSERT INTO activity_log (event_type, message, severity) VALUES (?, ?, 'info')");
    ins.run('peer_connected', 'cat-peer');
    ins.run('peerXconnected', 'cat-not-peer'); // would match LIKE 'peer_%' without ESCAPE
    ins.run('waf_ip_banned', 'cat-sec');
    ins.run('passkey_login_failed', 'cat-login');
    const peer = await agent.get('/api/v1/logs/recent?limit=20&category=peer').expect(200);
    assert.equal(peer.body.category, 'peer');
    assert.ok(peer.body.entries.every((e) => e.category === 'peer'));
    assert.ok(peer.body.entries.some((e) => e.message === 'cat-peer'));
    assert.ok(!peer.body.entries.some((e) => e.message === 'cat-not-peer'));
    const login = await agent.get('/api/v1/logs/recent?limit=20&category=login').expect(200);
    assert.ok(login.body.entries.some((e) => e.message === 'cat-login'));
    const sec = await agent.get('/api/v1/logs/recent?limit=20&category=security').expect(200);
    assert.ok(sec.body.entries.some((e) => e.message === 'cat-sec'));
    const all = await agent.get('/api/v1/logs/recent?limit=20').expect(200);
    assert.equal(all.body.category, 'all');
    assert.ok(all.body.entries.some((e) => e.message === 'cat-not-peer' && e.category === 'system'));
    for (const bad of ['peer_%', 'bogus', '__proto__']) {
      const r = await agent.get('/api/v1/logs/recent?category=' + encodeURIComponent(bad));
      assert.equal(r.status, 400, bad);
    }
    assert.equal((await agent.get('/api/v1/logs/recent?category=a&category=b')).status, 400, 'arrays are refused');
  });
});

describe('GET /gateways?peek=1', () => {
  it('reports a terminal update state without clearing it; the plain read still clears it', async () => {
    const id = addPeer('peek-gw', 'gateway');
    db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health,
        update_request_id, update_requested_at, update_target_version)
      VALUES (?, 9876, 'h', 'e', ?, ?, 'req-1', ?, '1.2.3')`)
      .run(id, Date.now(), JSON.stringify({ telemetry: { last_pull_request_id: 'req-1', last_pull_ok: true, gateway_version: '1.2.3' } }), Date.now());
    const stateOf = (res) => res.body.gateways.find((g) => g.peer_id === id);
    for (let i = 0; i < 2; i++) {
      const g = stateOf(await agent.get('/api/v1/gateways?peek=1').expect(200));
      assert.equal(g.update_state, 'done', `peek #${i + 1}`);
      assert.ok('latest_handshake' in g);
    }
    assert.equal(db.prepare('SELECT update_request_id FROM gateway_meta WHERE peer_id = ?').get(id).update_request_id, 'req-1');
    assert.equal(stateOf(await agent.get('/api/v1/gateways').expect(200)).update_state, 'done');
    assert.equal(db.prepare('SELECT update_request_id FROM gateway_meta WHERE peer_id = ?').get(id).update_request_id, null, 'cleared by the page read');
    assert.equal(stateOf(await agent.get('/api/v1/gateways?peek=1').expect(200)).update_state, 'idle');
  });
});

describe('system: CPU usage', () => {
  it('the first on-demand sample is a real measurement, and /metrics keeps its own baseline', async () => {
    const system = require('../src/services/system');
    let slept = 0;
    const r = await system.sampleCpuUsage('test-consumer', { sleep: async (ms) => { slept = ms; } });
    assert.equal(slept, system.MIN_SAMPLE_MS, 'no previous sample → a fresh window is measured');
    assert.ok(r.percent >= 0 && r.percent <= 100);
    assert.ok(r.cores > 0);
    // Another consumer's call does not move this consumer's baseline.
    system.getCpuUsage('metrics');
    const res = await agent.get('/api/v1/system/resources').expect(200);
    assert.ok(Number.isInteger(res.body.cpu.percent));
    assert.ok('disk' in res.body);
  });
});
