// tests/rdp_admin_browser_session.test.js
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
const supertest = require('supertest');

let app, agent, csrfToken;
before(async () => { ({ app, agent, csrfToken } = await setup()); });
after(() => teardown());

describe('admin browser-session mint', () => {
  it('admin session + CSRF mints a token (200), ACL bypassed', async () => {
    // user_ids as array — rdp.create calls JSON.stringify itself; pre-stringified would double-encode
    const r = await rdp.create({ name: 'win', host: '10.0.0.5', protocol: 'rdp', port: 3389,
      username: 'u', password: 'p', browser_enabled: 1, user_ids: [999] });
    const res = await agent.post('/api/v1/rdp/' + r.id + '/browser-session')
      .set('X-CSRF-Token', csrfToken).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.wsPath, '/api/v1/client/rdp/guac-tunnel');
  });
  it('missing CSRF → 403 (DA2-#4)', async () => {
    const r = await rdp.create({ name: 'win2', host: '10.0.0.6', protocol: 'rdp', port: 3389,
      username: 'u', password: 'p', browser_enabled: 1 });
    await agent.post('/api/v1/rdp/' + r.id + '/browser-session').expect(403);
  });
  it('not browser_enabled → 403', async () => {
    const r = await rdp.create({ name: 'win3', host: '10.0.0.7', protocol: 'rdp', port: 3389, username: 'u', password: 'p' });
    await agent.post('/api/v1/rdp/' + r.id + '/browser-session')
      .set('X-CSRF-Token', csrfToken).expect(403);
  });

  // --- Step 5: HTTP mapping + admission + audit + role-gate assertions ---

  it('nonexistent id → 404 (Chain1-G3)', async () => {
    await agent.post('/api/v1/rdp/999999/browser-session').set('X-CSRF-Token', csrfToken).expect(404);
  });

  it('concurrency full → 429 (Chain1-G3)', async () => {
    const rdpSessions = require('../src/services/rdpSessions');
    const r = await rdp.create({ name: 'full', host: '10.0.0.20', protocol: 'rdp', port: 3389, username: 'u', password: 'p', browser_enabled: 1 });
    // maxPerRoute=2 — fill both slots
    rdpSessions.startSession(r.id, { via: 'browser', protocol: 'rdp' });
    rdpSessions.startSession(r.id, { via: 'browser', protocol: 'rdp' });
    await agent.post('/api/v1/rdp/' + r.id + '/browser-session').set('X-CSRF-Token', csrfToken).expect(429);
  });

  it('admin peerId:null is admitted bounded by global+route (per-user skipped, DA-A)', () => {
    const { admitSession } = require('../src/services/guacSessions');
    // routeId 777777 has no active sessions — both global and route slots free
    assert.equal(admitSession({ routeId: 777777, tokenId: null, peerId: null, isStale: () => false }).ok, true);
  });

  it('admin session records token_id:null + token_name marker, no api_tokens mis-join (DA2-#5)', async () => {
    const rdpSessions = require('../src/services/rdpSessions');
    const r = await rdp.create({ name: 'audit', host: '10.0.0.21', protocol: 'rdp', port: 3389, username: 'u', password: 'p', browser_enabled: 1 });
    // Simulate what the WS path does after an admin mint: start a session with the admin audit marker
    rdpSessions.startSession(r.id, { via: 'browser', protocol: 'rdp', tokenId: null, tokenName: 'admin:1', peerId: null });

    // 1. Per-route history (SELECT * — no joins): verify token_name + null fields recorded
    const rows = rdpSessions.getHistory(r.id);
    const adminRow = rows.find(x => x.token_name === 'admin:1');
    assert.ok(adminRow, 'admin:1 row must exist in per-route history');
    assert.equal(adminRow.token_id, null, 'token_id must be null for admin session');
    assert.equal(adminRow.peer_id, null, 'peer_id must be null for admin session');

    // 2. Global history (LEFT JOIN api_tokens → users): no api_tokens row for token_id=null
    //    → user_display_name must be null (no mis-join)
    const allRows = rdpSessions.getGlobalHistory();
    const globalAdminRow = allRows.find(x => x.token_name === 'admin:1' && x.rdp_route_id === r.id);
    assert.ok(globalAdminRow, 'admin:1 row must appear in global history');
    assert.equal(globalAdminRow.user_display_name, null,
      'user_display_name must be null: LEFT JOIN on api_tokens with token_id=null yields no match');
  });

  it('role:user is rejected by the admin-role gate (Chain3-C1, data-level)', () => {
    const users = require('../src/services/users');
    // createClientUser returns the user with role:'user'
    const u = users.createClientUser({ username: 'client-x', displayName: 'X' });
    // The endpoint gate is `users.getById(session.userId).role !== 'admin'`; assert the data the gate keys on:
    assert.notEqual(users.getById(u.id).role, 'admin');
    // (Full HTTP-403 negative requires a role:'user' web session, which is impossible today —
    //  client users are passwordless. Revisit when the captive-portal optional login lands.)
  });
});
