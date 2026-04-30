'use strict';

// Tests the /api/v1/gateways list endpoint specifically for the stale
// route_reachability marker added to fix Bug 2 (2026-04-30): when a
// gateway is offline, its last cached health.route_reachability is
// frozen at the last observed values — the API must force-mark each
// reachable=false and add stale:true so the UI doesn't render lies.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const supertest = require('supertest');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('GET /api/v1/gateways — stale-reachability marker', () => {
  let app, agent, peerId, gateways;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwlist-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    process.env.GC_ADMIN_PASSWORD = 'TestPass123!';
    process.env.GC_ADMIN_USER = 'admin';
    process.env.GC_WG_HOST = 'test.example.com';
    process.env.GC_BASE_URL = 'http://localhost:3000';
    process.env.GC_LOG_LEVEL = 'silent';

    [
      '../config/default', '../src/db/connection', '../src/db/migrations',
      '../src/db/seed', '../src/services/gateways', '../src/services/license',
      '../src/app',
    ].forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });

    require('../src/db/migrations').runMigrations();
    await require('../src/db/seed').seedAdminUser();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'list-gw', apiPort: 9876 });
    peerId = gw.peer.id;

    app = require('../src/app').createApp();
    agent = supertest.agent(app);

    // Login flow (cookie+csrf), same pattern as helpers/setup.js
    const loginPage = await agent.get('/login');
    const m = loginPage.text.match(/name="_csrf"\s+value="([^"]+)"/);
    const formCsrf = m ? m[1] : '';
    await agent.post('/login').type('form')
      .send({ username: 'admin', password: 'TestPass123!', _csrf: formCsrf })
      .expect(302);
  });

  after(() => { try { require('../src/db/connection').closeDb(); } catch {} });

  function healthyHeartbeat() {
    return {
      tcp_listeners: [{ port: 13389, status: 'listening' }],
      route_reachability: [
        { route_id: 1, reachable: true, latency_ms: 3 },
        { route_id: 2, reachable: true, latency_ms: 4 },
      ],
    };
  }

  function brokenHeartbeat() {
    // listener_failed = real liveness problem (port collision etc.)
    return {
      tcp_listeners: [{ port: 13389, status: 'listener_failed' }],
      route_reachability: [
        { route_id: 1, reachable: true, latency_ms: 3 },
        { route_id: 2, reachable: true, latency_ms: 4 },
      ],
    };
  }

  it('preserves reachable:true entries when the gateway is online', async () => {
    // Drive the SM to "online" via 4 healthy heartbeats.
    gateways._resetSmCacheForTest();
    for (let i = 0; i < 4; i++) gateways.handleHeartbeat(peerId, healthyHeartbeat());

    const res = await agent.get('/api/v1/gateways').expect(200);
    assert.equal(res.body.ok, true);
    const gw = res.body.gateways.find(g => g.peer_id === peerId);
    assert.ok(gw, 'gateway must be in list');
    assert.equal(gw.status, 'online');
    assert.equal(gw.health.stale, undefined, 'online gateway must not be marked stale');
    assert.equal(gw.health.route_reachability.length, 2);
    assert.equal(gw.health.route_reachability.every(r => r.reachable === true), true);
  });

  it('force-marks reachable:false + stale:true when the gateway is offline', async () => {
    // Sanity: cached last_health should still say reachable:true from
    // the previous online sequence — that's the exact condition we want
    // the API to override.
    const db = require('../src/db/connection').getDb();
    const beforeRow = db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id=?').get(peerId);
    const beforeHealth = JSON.parse(beforeRow.last_health || '{}');
    assert.ok(
      beforeHealth.route_reachability.every(r => r.reachable === true),
      'sanity: cached health still says reachable:true before flip',
    );

    // Skip the 5-minute cooldown that normally blocks online→offline,
    // then push 3 broken heartbeats (3/5 unhealthy → state = offline).
    gateways._forceCooldownExhaustedForTest(peerId);
    for (let i = 0; i < 3; i++) gateways.handleHeartbeat(peerId, brokenHeartbeat());
    assert.equal(gateways.getHealthStatus(peerId), 'offline', 'precondition: SM is offline');

    const res = await agent.get('/api/v1/gateways').expect(200);
    assert.equal(res.body.ok, true);
    const gw = res.body.gateways.find(g => g.peer_id === peerId);
    assert.ok(gw, 'gateway must be in list');
    assert.equal(gw.status, 'offline');
    assert.equal(gw.health.stale, true, 'offline gateway must carry stale:true');
    assert.ok(Array.isArray(gw.health.route_reachability));
    assert.equal(
      gw.health.route_reachability.every(r => r.reachable === false),
      true,
      'every route_reachability entry must be force-set to reachable:false',
    );
    // Other fields of each entry must be preserved (route_id, latency_ms, …)
    assert.ok(gw.health.route_reachability.every(r => 'route_id' in r), 'route_id preserved');
    assert.ok(gw.health.route_reachability.some(r => 'latency_ms' in r), 'latency_ms preserved');
  });

  it('does not add stale flag when health has no route_reachability array', async () => {
    // Reset and push only bare heartbeats (no probes). State machine
    // sees them as healthy (bare = process alive), so status stays
    // online — but more importantly the API should not synthesize a
    // stale field out of nothing.
    gateways._resetSmCacheForTest();
    gateways.handleHeartbeat(peerId, { uptime_s: 10 });

    const res = await agent.get('/api/v1/gateways').expect(200);
    const gw = res.body.gateways.find(g => g.peer_id === peerId);
    assert.ok(gw);
    assert.equal(gw.health.stale, undefined);
  });
});
