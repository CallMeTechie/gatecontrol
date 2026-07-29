'use strict';

// Regression test for PR #41 (client.js router split). The split moved
// 19 route handlers into 8 sub-router modules and introduced missing
// imports that surface as ReferenceError → 500 on specific paths:
//   - dns-check: config missing (unconditional path)
//   - traffic catch: logger missing
//   - status heartbeat: hasFeature missing (hostname path)
//   - status report: activity missing
//   - rdp session start: tokens missing (token-auth path)
//   - update download: https missing
// Existing tests used session-auth only, bypassing the token-auth
// paths the Android/Desktop clients hit. This suite creates an API
// token and exercises both auth modes.
//
// Assertion predicate: we distinguish "unhandled 500" (body shape
// { error: 'Internal server error' } from Express' global error
// handler — signature of uncaught ReferenceError) from "handled 500"
// (body shape { ok: false, error: '...' } — route code caught the
// exception and returned a specific message). Only the former
// indicates an import regression.

const nodeCrypto = require('node:crypto');
// Must be set before helpers/setup pulls in the app modules — /client/register
// stores an encrypted peer key and throws without it.
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let agent, apiToken, app;

// requireAuth prefers session auth (src/middleware/auth.js) — an agent that
// carries a login cookie never reaches the token branch, so `req.tokenAuth`
// stays false and CSRF rejects the POST before the handler runs. Token-auth
// paths must therefore be exercised session-less, straight against the app.
const tokenReq = () => supertest(app);

function assertNoUnhandled500(res, label) {
  if (res.status === 500 && !('ok' in res.body)) {
    throw new Error(
      `${label}: unhandled 500 (ReferenceError-style) — ${JSON.stringify(res.body)}`
    );
  }
}

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  app = ctx.app;
  const tokens = require('../src/services/tokens');
  const license = require('../src/services/license');
  license._overrideForTest && license._overrideForTest({ api_tokens: true });
  const t = tokens.create({ name: 'smoke-token', scopes: ['full-access'] }, '127.0.0.1');
  apiToken = t.rawToken;
});
after(() => teardown());

describe('Client API router — no unhandled-500 from split-affected paths', () => {
  it('GET /client/dns-check (unconditional config use)', async () => {
    const res = await agent.get('/api/v1/client/dns-check');
    assertNoUnhandled500(res, 'dns-check');
    // Semantic: valid response must include the fields the Android DNS-leak test needs
    if (res.status === 200) {
      assert.equal(res.body.ok, true);
      assert.ok(res.body.vpnDns, 'response must expose vpnDns');
      assert.ok(res.body.gatewayIp, 'response must expose gatewayIp');
    }
  });

  it('POST /client/heartbeat with hostname (hasFeature path)', async () => {
    const res = await agent
      .post('/api/v1/client/heartbeat')
      .set('X-Api-Token', apiToken)
      .send({ peerId: 1, connected: true, rxBytes: 0, txBytes: 0, hostname: 'smoketest' });
    assertNoUnhandled500(res, 'heartbeat');
  });

  it('POST /client/status (activity.log path)', async () => {
    const res = await agent
      .post('/api/v1/client/status')
      .set('X-Api-Token', apiToken)
      .send({ peerId: 1, status: 'online' });
    assertNoUnhandled500(res, 'status');
  });

  it('POST /client/rdp/:id/session with token auth (tokens.getById path)', async () => {
    const res = await agent
      .post('/api/v1/client/rdp/99999/session')
      .set('X-Api-Token', apiToken)
      .send({});
    assertNoUnhandled500(res, 'rdp session');
  });

  it('GET /client/traffic (logger error-path)', async () => {
    const res = await agent.get('/api/v1/client/traffic?peerId=1');
    assertNoUnhandled500(res, 'traffic');
  });

  it('GET /client/services', async () => {
    const res = await agent.get('/api/v1/client/services');
    assertNoUnhandled500(res, 'services');
  });

  it('GET /client/split-tunnel', async () => {
    const res = await agent.get('/api/v1/client/split-tunnel');
    assertNoUnhandled500(res, 'split-tunnel');
  });

  it('GET /client/ping', async () => {
    const res = await agent.get('/api/v1/client/ping');
    assertNoUnhandled500(res, 'ping');
  });

  it('GET /client/permissions', async () => {
    const res = await agent.get('/api/v1/client/permissions');
    assertNoUnhandled500(res, 'permissions');
  });

  it('GET /client/rdp', async () => {
    const res = await agent.get('/api/v1/client/rdp');
    assertNoUnhandled500(res, 'rdp list');
  });

  // Same split, two symbols missed: peers.js uses isBindingActive/FINGERPRINT_RE
  // from helpers without importing them. Both register paths reach them under
  // token auth — first call binds the token to a new peer, second call takes
  // the already-bound branch.
  it('POST /client/register with token auth (new peer → token binding path)', async () => {
    const res = await tokenReq()
      .post('/api/v1/client/register')
      .set('X-Api-Token', apiToken)
      .send({ hostname: 'smoke-desktop', platform: 'win32', clientVersion: '1.19.6' });
    assert.notEqual(res.status, 403, `token auth did not take effect: ${JSON.stringify(res.body)}`);
    // Not assertNoUnhandled500: this handler wraps everything in try/catch, so a
    // ReferenceError surfaces as a *handled* 500. Any 500 here is a defect.
    assert.notEqual(res.status, 500, `register failed: ${JSON.stringify(res.body)}`);
  });

  it('POST /client/register again (already-bound token path)', async () => {
    const res = await tokenReq()
      .post('/api/v1/client/register')
      .set('X-Api-Token', apiToken)
      .send({ hostname: 'smoke-desktop', platform: 'win32', clientVersion: '1.19.6' });
    assert.notEqual(res.status, 403, `token auth did not take effect: ${JSON.stringify(res.body)}`);
    assert.notEqual(res.status, 500, `re-register failed: ${JSON.stringify(res.body)}`);
  });
});
