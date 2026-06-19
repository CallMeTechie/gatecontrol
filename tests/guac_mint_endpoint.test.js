// tests/guac_mint_endpoint.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
const license = require('../src/services/license');
const rdpSvc = require('../src/services/rdp');

let agent, csrf, db;
before(async () => {
  const c = await setup(); agent = c.agent; csrf = c.csrfToken; db = getDb();
  license._overrideForTest({ ...license.COMMUNITY_FALLBACK, browser_sessions: true, remote_desktop: true });
});
after(() => { license._overrideForTest({ ...license.COMMUNITY_FALLBACK }); teardown(); });

// Session-auth POSTs need the CSRF header (token-auth would bypass it). The
// session agent from setup() is NOT token-auth — see src/routes/api/index.js.
describe('POST /client/rdp/:id/browser-session', () => {
  it('mints a token for an rdp route with browser_enabled=1', async () => {
    const r = await rdpSvc.create({ name: 'b1', host: '10.0.0.5', protocol: 'rdp', port: 3389 });
    await rdpSvc.update(r.id, { browser_enabled: true });
    const res = await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.token);
    assert.equal(res.body.wsPath, '/api/v1/client/rdp/guac-tunnel');
  });
  it('rejects when browser_enabled=0', async () => {
    const r = await rdpSvc.create({ name: 'b2', host: '10.0.0.6', protocol: 'rdp', port: 3389 });
    const res = await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(403);
    assert.equal(res.body.ok, false);
  });
  it('rejects ssh (unsupported protocol in phase 2a)', async () => {
    const r = await rdpSvc.create({ name: 'b3', host: '10.0.0.7', protocol: 'ssh', username: 'u' });
    await rdpSvc.update(r.id, { browser_enabled: true });
    const res = await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(400);
    assert.equal(res.body.ok, false);
  });
  it('rejects without the browser_sessions license', async () => {
    license._overrideForTest({ ...license.COMMUNITY_FALLBACK, browser_sessions: false, remote_desktop: true });
    const r = await rdpSvc.create({ name: 'b4', host: '10.0.0.8', protocol: 'rdp', port: 3389 });
    await rdpSvc.update(r.id, { browser_enabled: true });
    const res = await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(403);
    assert.equal(res.body.ok, false);
    license._overrideForTest({ ...license.COMMUNITY_FALLBACK, browser_sessions: true, remote_desktop: true });
  });
  it('rejects when the route ACL excludes the requester (403)', async () => {
    // Set up a route whose ACL denies this user.
    // Session auth: req.tokenId = null, req.tokenUserId = undefined.
    // canAccessRoute(route, null, undefined) with token_ids=[999999]:
    //   token_ids is non-empty and tokenId is null (falsy) → returns false → 403.
    const r = await rdpSvc.create({ name: 'b5', host: '10.0.0.9', protocol: 'rdp', port: 3389 });
    await rdpSvc.update(r.id, { browser_enabled: true });
    db.prepare('UPDATE rdp_routes SET token_ids = ? WHERE id = ?').run(JSON.stringify([999999]), r.id);
    const res = await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(403);
    assert.equal(res.body.ok, false);
  });
  it('rejects when the route is in a maintenance window (503)', async () => {
    // DAY_MAP: So=Sun=0, Mo=1, ..., Sa=Sat=6.
    // 'So-Sa 00:00-23:59': startDay=0, endDay=6 covers all 7 days;
    // time window 00:00–23:58 (23:59 exclusive) covers virtually all time.
    // isInMaintenanceWindow() re-reads maintenance_schedule from the DB.
    const r = await rdpSvc.create({ name: 'b6', host: '10.0.0.10', protocol: 'rdp', port: 3389 });
    await rdpSvc.update(r.id, { browser_enabled: true, maintenance_enabled: true });
    db.prepare('UPDATE rdp_routes SET maintenance_schedule = ? WHERE id = ?').run('So-Sa 00:00-23:59', r.id);
    const res = await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(503);
    assert.equal(res.body.ok, false);
  });
});
