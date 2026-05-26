'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  routeId = getDb().prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('c.example.com','10.0.0.8',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('runCleanup purges expired share links and their guest sessions', () => {
  const svc = require('../src/services/shareLinks');
  const routeAuth = require('../src/services/routeAuth');
  const db = getDb();
  const { id, token } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  const r = svc.redeemShareLink(token, '1.1.1.1');
  // REVOKE the link but keep the guest session's expiry in the FUTURE, so only
  // the new ordered cleanup (orphan-session-of-revoked-link) can remove it —
  // the pre-existing `expires_at <= now` delete must NOT be what purges it.
  db.prepare("UPDATE route_auth_share_links SET revoked_at = datetime('now') WHERE id = ?").run(id);
  // (revokeShareLink would delete the session itself; here we set revoked_at
  //  directly to leave the session in place and prove cleanup removes it.)
  assert.ok(new Date(db.prepare('SELECT expires_at FROM route_auth_sessions WHERE id = ?').get(r.sessionId).expires_at).getTime() > Date.now());
  routeAuth._runCleanupForTest();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_share_links WHERE id = ?').get(id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_sessions WHERE id = ?').get(r.sessionId).c, 0);
});
