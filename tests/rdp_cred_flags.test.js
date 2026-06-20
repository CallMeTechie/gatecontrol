// tests/rdp_cred_flags.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const rdp = require('../src/services/rdp');
const GRANULAR = ['has_username','has_password','has_ssh_private_key','has_ssh_passphrase',
  'has_sftp_password','has_sftp_private_key','has_sftp_passphrase'];

let agent, csrfToken, app;
before(async () => { const c = await setup(); agent = c.agent; csrfToken = c.csrfToken; app = c.app; });
after(() => teardown());

describe('granular has_* flags (credFlags-gated)', () => {
  it('stripSensitive WITHOUT credFlags exposes only has_credentials', () => {
    const row = { id: 1, name: 'r', host: 'h', port: 22,
      username_encrypted: 'x', password_encrypted: 'x', ssh_private_key_encrypted: 'x' };
    const safe = rdp.stripSensitive(row);
    assert.equal('has_credentials' in safe, true);
    for (const k of GRANULAR) assert.equal(k in safe, false, 'leaked ' + k);
  });
  it('stripSensitive WITH credFlags exposes all 7 granular flags', () => {
    const row = { id: 1, name: 'r', host: 'h', port: 22,
      username_encrypted: 'x', ssh_private_key_encrypted: 'x', sftp_password_encrypted: 'x' };
    const safe = rdp.stripSensitive(row, { credFlags: true });
    assert.equal(safe.has_username, true);
    assert.equal(safe.has_password, false);
    assert.equal(safe.has_ssh_private_key, true);
    assert.equal(safe.has_sftp_password, true);
    assert.equal(safe.has_credentials, true); // unchanged
  });
  it('getAll without credFlags does NOT leak flags (the .map index footgun)', async () => {
    await rdp.create({ name: 'a', host: '10.0.0.2', protocol: 'rdp', port: 3389, username: 'u' });
    await rdp.create({ name: 'b', host: '10.0.0.3', protocol: 'ssh', port: 22, username: 'u' });
    const list = rdp.getAll();
    for (const r of list) for (const k of GRANULAR) assert.equal(k in r, false);
    const adminList = rdp.getAll({ credFlags: true });
    assert.equal('has_ssh_private_key' in adminList[0], true);
  });
  it('getAll preserves pagination (limit/offset) alongside credFlags', () => {
    const page = rdp.getAll({ limit: 1, offset: 0, credFlags: true });
    assert.equal(page.length, 1);
  });
  it('getForToken (client path) NEVER contains granular flags', async () => {
    // Mirror the token+peer fixture from tests/rdp_protocol_consumers.test.js.
    const supertest = require('supertest');
    const tokens = require('../src/services/tokens');
    // Create a route that all tokens can access (no token_ids restriction)
    await rdp.create({ name: 'flag-test-route', host: '10.9.9.1', protocol: 'rdp', port: 3389, username: 'u' });
    const { token } = tokens.create({ name: 'leak-test-token', scopes: ['client:rdp'] }, '127.0.0.1');
    const tokenId = token.id;
    const client = rdp.getForToken(tokenId, null);
    assert.ok(client.length > 0, 'getForToken must return at least one route');
    for (const r of client) {
      for (const k of GRANULAR) assert.equal(k in r, false, 'client path leaked ' + k);
    }
  });
});

describe('HTTP layer — credFlags admin vs client path', () => {
  it('GET /api/v1/rdp/ (admin session) includes has_ssh_private_key boolean', async () => {
    const res = await agent.get('/api/v1/rdp/').set('X-CSRF-Token', csrfToken).expect(200);
    assert.equal(res.body.ok, true);
    const routes = res.body.routes || [];
    assert.ok(routes.length > 0, 'admin list must have routes');
    for (const r of routes) {
      assert.ok('has_ssh_private_key' in r, 'admin route missing has_ssh_private_key');
      assert.equal(typeof r.has_ssh_private_key, 'boolean');
    }
  });
  it('GET /api/v1/client/rdp (token auth) contains NO granular has_* flags', async () => {
    const supertest = require('supertest');
    const tokens = require('../src/services/tokens');
    const { rawToken } = tokens.create({ name: 'http-leak-test', scopes: ['client:rdp'] }, '127.0.0.1');
    const res = await supertest(app).get('/api/v1/client/rdp').set('X-Api-Token', rawToken).expect(200);
    assert.equal(res.body.ok, true);
    const routes = res.body.routes || [];
    for (const r of routes) {
      for (const k of GRANULAR) assert.equal(k in r, false, 'client HTTP path leaked ' + k);
    }
  });
});
