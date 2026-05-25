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

test('slug sanitizes hostile names', () => {
  assert.equal(gs._slug('Office GW', 7), 'office-gw');
  assert.equal(gs._slug('..', 7), 'gateway-7');
  assert.equal(gs._slug('a\nb', 7), 'a-b');
  assert.equal(gs._slug('', 7), 'gateway-7');
  assert.equal(gs._slug('  ', 7), 'gateway-7');
});

test('renderScript embeds update.sh + single-quotes/escapes name + lowercase image', () => {
  const s = gs.renderScript({ id: 7, name: "weird ' name" });
  const m = s.match(/^GATEWAY_NAME=.*$/m);
  assert.ok(m && m[0].indexOf("'\\''") !== -1, 'name single-quote-escaped on one line');
  assert.equal(s.indexOf('{{UPDATE_SH}}'), -1, 'UPDATE_SH placeholder consumed');
  assert.match(s, /GATEWAY_STATE_DIR:-\/state/);
  assert.match(s, /ghcr\.io\/callmetechie\/gatecontrol-gateway:latest/);
});

test('renderScript does not interpret $-sequences in the name (replace footgun)', () => {
  const s = gs.renderScript({ id: 7, name: '$& $$ end' });
  assert.match(s, /^GATEWAY_NAME='\$& \$\$ end'$/m);
});

test('buildBundleFiles lists all expected entries', () => {
  const names = gs.buildBundleFiles({ id: 7, name: 'gw' }).map((f) => f.name).sort();
  assert.deepEqual(names, ['README.md','docker-compose.state-snippet.yml','setup.sh','systemd/gatecontrol-gateway-update.path','systemd/gatecontrol-gateway-update.service','update.sh']);
});

test('rendered setup.sh passes bash -n syntax check', { skip: !require('node:child_process').spawnSync('bash', ['--version']).status === 0 }, () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const which = spawnSync('bash', ['--version']);
  if (which.status !== 0 && which.error) {
    // bash not available — skip gracefully
    return;
  }
  const script = gs.renderScript({ id: 1, name: 'x' });
  const tmp = require('node:path').join(os.tmpdir(), `gatecontrol-setup-test-${process.pid}.sh`);
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    const result = spawnSync('bash', ['-n', tmp]);
    assert.equal(result.status, 0, `bash -n failed: ${result.stderr ? result.stderr.toString() : ''}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// ─── HTTP endpoint tests (T4) ────────────────────────────────────────────────

describe('GET /api/v1/gateways/:id/setup-script and setup-bundle.zip', () => {
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

    // Clear module cache for a clean slate
    [
      '../config/default', '../src/db/connection', '../src/db/migrations',
      '../src/db/seed', '../src/services/gateways', '../src/services/license',
      '../src/app',
    ].forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });

    require('../src/db/migrations').runMigrations();
    await require('../src/db/seed').seedAdminUser();

    const license = require('../src/services/license');
    // Ensure gateway_fleet + gateway_peers are on for setup
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10, gateway_fleet: true });

    const gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'setup-test-gw', apiPort: 9877 });
    peerId = gw.peer.id;

    app = require('../src/app').createApp();
    agent = supertest.agent(app);

    // Login flow (cookie + csrf)
    const loginPage = await agent.get('/login');
    const m = loginPage.text.match(/name="_csrf"\s+value="([^"]+)"/);
    const formCsrf = m ? m[1] : '';
    await agent.post('/login').type('form')
      .send({ username: 'admin', password: 'TestPass123!', _csrf: formCsrf })
      .expect(302);
  });

  after(() => { try { require('../src/db/connection').closeDb(); } catch {} });

  it('GET /:id/setup-script → 200, text/plain, attachment .sh, body contains GATEWAY_NAME= and gateway-state:/state', async () => {
    const res = await agent.get(`/api/v1/gateways/${peerId}/setup-script`).expect(200);
    assert.match(res.headers['content-type'], /text\/plain/);
    const disp = res.headers['content-disposition'] || '';
    assert.ok(disp.includes('attachment'), 'content-disposition should say attachment');
    assert.ok(disp.endsWith('.sh"') || disp.includes('.sh'), 'content-disposition should reference .sh');
    assert.ok(res.text.includes('GATEWAY_NAME='), 'body should contain GATEWAY_NAME=');
    assert.ok(res.text.includes('gateway-state:/state'), 'body should contain gateway-state:/state');
  });

  it('GET /:id/setup-bundle.zip → 200, application/zip, body starts with PK\\x03\\x04', async () => {
    const res = await agent
      .get(`/api/v1/gateways/${peerId}/setup-bundle.zip`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
        response.on('error', callback);
      })
      .expect(200);

    assert.equal(res.headers['content-type'], 'application/zip');
    const body = res.body;
    assert.ok(body.length > 0, 'zip body must be non-empty');
    // PK\x03\x04 local file header signature
    assert.equal(body[0], 0x50, 'byte 0 must be 0x50 (P)');
    assert.equal(body[1], 0x4b, 'byte 1 must be 0x4b (K)');
    assert.equal(body[2], 0x03, 'byte 2 must be 0x03');
    assert.equal(body[3], 0x04, 'byte 3 must be 0x04');
  });

  it('GET /:id/setup-script → 404 for unknown id', async () => {
    await agent.get('/api/v1/gateways/999999/setup-script').expect(404);
  });

  it('GET /:id/setup-script → 403 when gateway_fleet feature is off', async () => {
    const license = require('../src/services/license');
    try {
      license._overrideForTest({ gateway_fleet: false });
      await agent.get(`/api/v1/gateways/${peerId}/setup-script`).expect(403);
    } finally {
      license._overrideForTest({ gateway_fleet: true });
    }
  });

  it('GET /:id/setup-script → 404 for unknown id even when gateway_fleet is off (404-before-403)', async () => {
    const license = require('../src/services/license');
    try {
      license._overrideForTest({ gateway_fleet: false });
      await agent.get('/api/v1/gateways/999999/setup-script').expect(404);
    } finally {
      license._overrideForTest({ gateway_fleet: true });
    }
  });
});
