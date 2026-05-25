'use strict';

// Tests POST /api/v1/gateways/:id/update (gateway self-update trigger, #2b)
// plus the update_state augmentation on GET /api/v1/gateways.
//
// Harness mirrors tests/gateway_api_list.test.js: createApp() + the login
// flow (form _csrf → session → API csrfToken) + a supertest.agent. The
// route lazy-requires ../../services/gateways per call, so notifySelfUpdate
// is monkeypatched per-case (saved + restored).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const supertest = require('supertest');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('POST /api/v1/gateways/:id/update + update_state in list', () => {
  let app, agent, csrf, gateways, license, gatewayRelease, db, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwupd-'));
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
      '../src/services/gatewayRelease', '../src/app',
    ].forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });

    require('../src/db/migrations').runMigrations();
    await require('../src/db/seed').seedAdminUser();

    license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    gateways = require('../src/services/gateways');
    gatewayRelease = require('../src/services/gatewayRelease');
    db = require('../src/db/connection').getDb();

    const gw = await gateways.createGateway({ name: 'upd-gw', apiPort: 9876 });
    peerId = gw.peer.id;

    app = require('../src/app').createApp();
    agent = supertest.agent(app);

    // Login flow (cookie+csrf), same pattern as gateway_api_list.test.js.
    const loginPage = await agent.get('/login');
    const m = loginPage.text.match(/name="_csrf"\s+value="([^"]+)"/);
    const formCsrf = m ? m[1] : '';
    await agent.post('/login').type('form')
      .send({ username: 'admin', password: 'TestPass123!', _csrf: formCsrf })
      .expect(302);

    // API CSRF token from a page load (same as helpers/setup.js).
    const dashPage = await agent.get('/dashboard');
    const gcMatch = dashPage.text.match(/csrfToken:\s*'([^']+)'/);
    csrf = gcMatch ? gcMatch[1] : '';
    assert.ok(csrf, 'precondition: API csrf token obtained');
  });

  after(() => { try { require('../src/db/connection').closeDb(); } catch {} });

  // Save + restore the real notifySelfUpdate around each stubbed case.
  function withStub(stub, fn) {
    const orig = gateways.notifySelfUpdate;
    gateways.notifySelfUpdate = stub;
    return Promise.resolve()
      .then(fn)
      .finally(() => { gateways.notifySelfUpdate = orig; });
  }

  function clearTracking() {
    db.prepare(`UPDATE gateway_meta SET update_request_id=NULL, update_requested_at=NULL, update_target_version=NULL WHERE peer_id=?`).run(peerId);
  }

  it('200 queued:true — sets update_request_id when stub returns ok+queued', async () => {
    clearTracking();
    gateways.handleHeartbeat(peerId, { telemetry: { state_dir_writable: true, gateway_version: '1.9.3' } });

    await withStub(async () => ({ ok: true, queued: true }), async () => {
      const res = await agent.post(`/api/v1/gateways/${peerId}/update`)
        .set('x-csrf-token', csrf)
        .expect(200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.queued, true);
    });

    const gmRow = db.prepare('SELECT update_request_id FROM gateway_meta WHERE peer_id=?').get(peerId);
    assert.ok(gmRow.update_request_id, 'update_request_id must be set after a queued update');
  });

  it('200 queued:false + cooldown — does NOT set update_request_id', async () => {
    clearTracking();
    gateways.handleHeartbeat(peerId, { telemetry: { state_dir_writable: true, gateway_version: '1.9.3' } });

    await withStub(async () => ({ skipped: 'cooldown' }), async () => {
      const res = await agent.post(`/api/v1/gateways/${peerId}/update`)
        .set('x-csrf-token', csrf)
        .expect(200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.queued, false);
      assert.equal(res.body.reason, 'cooldown');
    });

    const gmRow = db.prepare('SELECT update_request_id FROM gateway_meta WHERE peer_id=?').get(peerId);
    assert.equal(gmRow.update_request_id, null, 'cooldown must leave update_request_id NULL');
  });

  it('404 — unknown id / non-gateway peer', async () => {
    const res = await agent.post('/api/v1/gateways/999999/update')
      .set('x-csrf-token', csrf)
      .expect(404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'not_found');
  });

  it('403 — gateway_fleet not licensed', async () => {
    clearTracking();
    gateways.handleHeartbeat(peerId, { telemetry: { state_dir_writable: true, gateway_version: '1.9.3' } });
    license._overrideForTest({ gateway_fleet: false });
    try {
      const res = await agent.post(`/api/v1/gateways/${peerId}/update`)
        .set('x-csrf-token', csrf)
        .expect(403);
      assert.equal(res.body.ok, false);
    } finally {
      // _overrideForTest Object.assigns onto a shared cache — must reset
      // to TRUE (the default) so other tests/cases aren't poisoned.
      license._overrideForTest({ gateway_fleet: true });
    }
  });

  it('409 — telemetry lacks state_dir_writable (not migrated)', async () => {
    clearTracking();
    gateways.handleHeartbeat(peerId, { telemetry: { gateway_version: '1.9.3' } });
    const res = await agent.post(`/api/v1/gateways/${peerId}/update`)
      .set('x-csrf-token', csrf)
      .expect(409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'not_migrated');
  });

  it('persists the concrete target_version when release cache is set', async () => {
    clearTracking();
    gatewayRelease._setCache('1.9.4');
    gateways.handleHeartbeat(peerId, { telemetry: { state_dir_writable: true, gateway_version: '1.9.3' } });
    try {
      await withStub(async () => ({ ok: true, queued: true }), async () => {
        await agent.post(`/api/v1/gateways/${peerId}/update`)
          .set('x-csrf-token', csrf)
          .expect(200);
      });
      const gmRow = db.prepare('SELECT update_target_version FROM gateway_meta WHERE peer_id=?').get(peerId);
      assert.equal(gmRow.update_target_version, '1.9.4');
    } finally {
      gatewayRelease._setCache(null);
    }
  });

  it('GET / exposes update_state (updating) when a request_id is pending', async () => {
    clearTracking();
    gatewayRelease._setCache('1.9.4');
    gateways.handleHeartbeat(peerId, { telemetry: { state_dir_writable: true, gateway_version: '1.9.3' } });
    await withStub(async () => ({ ok: true, queued: true }), async () => {
      await agent.post(`/api/v1/gateways/${peerId}/update`)
        .set('x-csrf-token', csrf)
        .expect(200);
    });

    const res = await agent.get('/api/v1/gateways').expect(200);
    const gw = res.body.gateways.find(g => g.peer_id === peerId);
    assert.ok(gw, 'gateway must be in list');
    assert.equal(gw.update_state, 'updating');
    assert.equal(gw.update_target_version, '1.9.4');
    assert.ok(gw.update_requested_at, 'update_requested_at must be exposed');
    gatewayRelease._setCache(null);
    clearTracking();
  });

  it('GET / clears terminal (done) state after exposing it', async () => {
    clearTracking();
    gatewayRelease._setCache('1.9.4');
    // Pending request_id matched by telemetry → done (version satisfied, pull ok)
    const rid = 'rid-done-1';
    gateways.markUpdateRequested(peerId, rid, '1.9.4');
    gateways.handleHeartbeat(peerId, {
      telemetry: {
        state_dir_writable: true,
        gateway_version: '1.9.4',
        last_pull_request_id: rid,
        last_pull_ok: true,
      },
    });

    const res = await agent.get('/api/v1/gateways').expect(200);
    const gw = res.body.gateways.find(g => g.peer_id === peerId);
    assert.ok(gw);
    assert.equal(gw.update_state, 'done');

    // Terminal state must have been cleared by the post-map loop.
    const gmRow = db.prepare('SELECT update_request_id FROM gateway_meta WHERE peer_id=?').get(peerId);
    assert.equal(gmRow.update_request_id, null, 'terminal state must be cleared after the list call');
    gatewayRelease._setCache(null);
  });
});
