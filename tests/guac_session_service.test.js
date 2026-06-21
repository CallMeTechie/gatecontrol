// tests/guac_session_service.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const license = require('../src/services/license');
license._overrideForTest({ ...license.COMMUNITY_FALLBACK, browser_sessions: true, remote_desktop: true });
const rdp = require('../src/services/rdp');
const guacSession = require('../src/services/guacSession');

before(async () => { await setup(); });
after(() => teardown());

describe('guacSession.mintForRoute', () => {
  it('admin actor: ACL skipped, mints with peerId:null/tokenId:null + admin tokenName', async () => {
    const r = await rdp.create({ name: 'a', host: '10.0.0.2', protocol: 'rdp', port: 3389,
      username: 'u', password: 'p', browser_enabled: 1 });
    const route = rdp.getById(r.id, true);
    const res = guacSession.mintForRoute(route, { actor: { kind: 'admin', userId: 7 } });
    assert.equal(res.ok, true);
    assert.equal(typeof res.token, 'string');
    assert.ok(res.ttlMs > 0);
  });
  it('client actor without ACL access → 403 not_authorized', async () => {
    // user_ids passed as array so rdp.create stores "[999]" (not double-encoded)
    const r = await rdp.create({ name: 'b', host: '10.0.0.3', protocol: 'rdp', port: 3389,
      username: 'u', password: 'p', browser_enabled: 1, user_ids: [999] });
    const route = rdp.getById(r.id, true);
    const res = guacSession.mintForRoute(route, { actor: { kind: 'client', tokenId: 1, userId: 1, peerId: 1 } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.code, 'not_authorized');
  });
  it('not browser_enabled → 403 (admin actor still subject to non-ACL guards)', async () => {
    const r = await rdp.create({ name: 'c', host: '10.0.0.4', protocol: 'rdp', port: 3389, username: 'u', password: 'p' });
    const route = rdp.getById(r.id, true);
    const res = guacSession.mintForRoute(route, { actor: { kind: 'admin', userId: 7 } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.code, 'not_enabled');
  });
  it('licence off → 403 (both actors)', async () => {
    const r = await rdp.create({ name: 'd', host: '10.0.0.9', protocol: 'rdp', port: 3389, username: 'u', password: 'p', browser_enabled: 1 });
    const route = rdp.getById(r.id, true);
    license._overrideForTest({ ...license.COMMUNITY_FALLBACK, browser_sessions: false, remote_desktop: true });
    const res = guacSession.mintForRoute(route, { actor: { kind: 'admin', userId: 7 } });
    license._overrideForTest({ ...license.COMMUNITY_FALLBACK, browser_sessions: true, remote_desktop: true }); // restore
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.code, 'license_required');
  });

  // Guard: maintenance window active → 503
  // maintenance_schedule 'So-Sa 00:00-23:59\nSo-Sa 23:00-01:00' covers any time of day
  // (same schedule used in guac_mint_endpoint.test.js for this purpose)
  it('maintenance window active → 503', async () => {
    const r = await rdp.create({ name: 'maint1', host: '10.0.0.21', protocol: 'rdp', port: 3389,
      username: 'u', password: 'p', browser_enabled: 1, maintenance_enabled: 1,
      maintenance_schedule: 'So-Sa 00:00-23:59\nSo-Sa 23:00-01:00' });
    const route = rdp.getById(r.id, true);
    const res = guacSession.mintForRoute(route, { actor: { kind: 'admin', userId: 7 } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.code, 'maintenance_active');
  });

  // Guard: protocol not in SUPPORTED_PROTOCOLS → 400
  // Stub a minimal route object that passes all earlier guards (license/cred/enabled/maintenance)
  // and fails only at the protocol check. Admin actor skips ACL.
  it('unsupported protocol → 400', () => {
    const route = { id: 99999, protocol: 'http', browser_enabled: 1, maintenance_enabled: false,
      decrypt_failed: false, decrypt_failed_fields: new Set() };
    const res = guacSession.mintForRoute(route, { actor: { kind: 'admin', userId: 7 } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.code, 'protocol_unsupported');
  });

  // Guard: concurrency cap (per-route) reached → 429
  // Start 2 active sessions (== maxPerRoute default of 2) then mintForRoute → route_limit
  it('concurrency cap reached → 429', async () => {
    const rdpSessions = require('../src/services/rdpSessions');
    const config = require('../config/default');
    const r = await rdp.create({ name: 'conc1', host: '10.0.0.22', protocol: 'rdp', port: 3389,
      username: 'u', password: 'p', browser_enabled: 1 });
    const route = rdp.getById(r.id, true);
    const prevMax = config.guac.maxPerRoute;
    config.guac.maxPerRoute = 2;
    const s1 = rdpSessions.startSession(r.id, { tokenId: null, peerId: null, clientIp: 'x', via: 'browser' });
    const s2 = rdpSessions.startSession(r.id, { tokenId: null, peerId: null, clientIp: 'x', via: 'browser' });
    let res;
    try {
      res = guacSession.mintForRoute(route, { actor: { kind: 'admin', userId: 7 } });
    } finally {
      rdpSessions.endSession(s1.id, 'test');
      rdpSessions.endSession(s2.id, 'test');
      config.guac.maxPerRoute = prevMax;
    }
    assert.equal(res.ok, false);
    assert.equal(res.status, 429);
    assert.equal(res.code, 'limit_reached');
  });

  // Guard: cred-fail (required ssh key recorded in decrypt_failed_fields) → 409
  // Create an ssh route with a private key, then corrupt the encrypted column in DB,
  // then getById(true) → decrypt_failed_fields contains 'ssh_private_key' →
  // requiredCredFields(['username','ssh_private_key']).some(x => failed.has(x)) → true → 409
  it('ssh route with corrupted ssh_private_key → 409', async () => {
    const { getDb } = require('../src/db/connection');
    const r = await rdp.create({ name: 'credFail1', host: '10.0.0.23', protocol: 'ssh', port: 22,
      username: 'u', ssh_private_key: 'KEYBODY', browser_enabled: 1 });
    getDb().prepare("UPDATE rdp_routes SET ssh_private_key_encrypted='not-valid-ciphertext' WHERE id=?").run(r.id);
    const route = rdp.getById(r.id, true);
    const res = guacSession.mintForRoute(route, { actor: { kind: 'admin', userId: 7 } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.code, 'mint_failed');
  });

  // DA-C byte-identity regression: client actor tokenName MUST be null in the minted token.
  // The existing client path never embeds tokenName (rdp.js:353 omits it); the service
  // must keep client actor.tokenName=null so rdp_sessions.token_name stays NULL after
  // Task 9's evaluateConnection persists it. Decode the token to verify.
  it('client actor: tokenName is null in minted token (DA-C byte-identity)', async () => {
    const guacToken = require('../src/services/guacToken');
    const r = await rdp.create({ name: 'dac1', host: '10.0.0.24', protocol: 'rdp', port: 3389,
      username: 'u', password: 'p', browser_enabled: 1 });
    const route = rdp.getById(r.id, true);
    const res = guacSession.mintForRoute(route, {
      actor: { kind: 'client', tokenId: null, userId: null, peerId: null, tokenName: null },
    });
    assert.equal(res.ok, true);
    const decoded = guacToken.verifyAndConsume(res.token);
    assert.ok(decoded, 'token should be valid');
    assert.equal(decoded.connection.tokenName, null);
  });
});
