'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const supertest = require('supertest');
const gs = require('../src/services/gatewaySetup');

test('readUpdateSh returns the vendored update.sh', () => {
  const s = gs.readUpdateSh();
  assert.ok(s.startsWith('#!/usr/bin/env bash'), 'has the vendored shebang');
  assert.match(s, /GATEWAY_STATE_DIR:-\/state/); // string unique to update.sh
});

// ─── HTTP endpoint test ──────────────────────────────────────────────────────

describe('GET /api/v1/gateways/:id/update-sh', () => {
  let app, agent, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwsetup-'));
    process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
    process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
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
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10, gateway_fleet: true });

    const gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'setup-test-gw', apiPort: 9877 });
    peerId = gw.peer.id;

    app = require('../src/app').createApp();
    agent = supertest.agent(app);

    const loginPage = await agent.get('/login');
    const m = loginPage.text.match(/name="_csrf"\s+value="([^"]+)"/);
    const formCsrf = m ? m[1] : '';
    await agent.post('/login').type('form')
      .send({ username: 'admin', password: 'TestPass123!', _csrf: formCsrf })
      .expect(302);
  });

  after(() => { try { require('../src/db/connection').closeDb(); } catch {} });

  it('GET /:id/update-sh → 200, text/plain, attachment update.sh, body is the script', async () => {
    const res = await agent.get(`/api/v1/gateways/${peerId}/update-sh`).expect(200);
    assert.match(res.headers['content-type'], /text\/plain/);
    const disp = res.headers['content-disposition'] || '';
    assert.ok(disp.includes('attachment'), 'content-disposition should say attachment');
    assert.ok(disp.includes('update.sh'), 'content-disposition filename should be update.sh');
    assert.ok(res.text.includes('GATEWAY_STATE_DIR:-/state'), 'body should be the update.sh script');
  });

  it('GET /:id/update-sh → 404 for unknown id', async () => {
    await agent.get('/api/v1/gateways/999999/update-sh').expect(404);
  });

  it('GET /:id/update-sh → 403 when gateway_fleet feature is off', async () => {
    const license = require('../src/services/license');
    try {
      license._overrideForTest({ gateway_fleet: false });
      await agent.get(`/api/v1/gateways/${peerId}/update-sh`).expect(403);
    } finally {
      license._overrideForTest({ gateway_fleet: true });
    }
  });

  it('GET /:id/update-sh → 404 for unknown id even when gateway_fleet is off (404-before-403)', async () => {
    const license = require('../src/services/license');
    try {
      license._overrideForTest({ gateway_fleet: false });
      await agent.get('/api/v1/gateways/999999/update-sh').expect(404);
    } finally {
      license._overrideForTest({ gateway_fleet: true });
    }
  });
});
