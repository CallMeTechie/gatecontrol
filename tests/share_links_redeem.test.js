'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  const db = getDb();
  routeId = db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('r.example.com','10.0.0.7',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('redeem creates a session bound to the link with expiry = link expiry', () => {
  const svc = require('../src/services/shareLinks');
  const { id, token, expiresAt } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  const result = svc.redeemShareLink(token, '1.2.3.4');
  assert.ok(result);
  assert.equal(result.routeId, routeId);
  const db = getDb();
  const sess = db.prepare('SELECT * FROM route_auth_sessions WHERE id = ?').get(result.sessionId);
  assert.equal(sess.route_id, routeId);
  assert.equal(sess.share_link_id, id);
  assert.equal(sess.two_factor_pending, 0);
  assert.equal(sess.expires_at, expiresAt); // no extra cap
});

test('one-time link cannot be redeemed twice', () => {
  const svc = require('../src/services/shareLinks');
  const { token } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: true });
  assert.ok(svc.redeemShareLink(token, '1.1.1.1'));
  assert.equal(svc.redeemShareLink(token, '1.1.1.1'), null);
});

test('expired / revoked / unknown tokens do not redeem', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  // expired
  const { id: eid, token: et } = svc.createShareLink(routeId, { expiresInHours: 1, oneTime: false });
  db.prepare("UPDATE route_auth_share_links SET expires_at = datetime('now','-1 hour') WHERE id = ?").run(eid);
  assert.equal(svc.redeemShareLink(et, '1.1.1.1'), null);
  // revoked
  const { id: rid, token: rt } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  assert.equal(svc.revokeShareLink(routeId, rid), true);
  assert.equal(svc.redeemShareLink(rt, '1.1.1.1'), null);
  // unknown
  assert.equal(svc.redeemShareLink('nope', '1.1.1.1'), null);
});

test('revoke deletes the link\'s guest sessions; list hides revoked/expired', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  const { id, token } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  const r = svc.redeemShareLink(token, '1.1.1.1');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_sessions WHERE id = ?').get(r.sessionId).c, 1);
  svc.revokeShareLink(routeId, id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_sessions WHERE id = ?').get(r.sessionId).c, 0);
  assert.equal(svc.listShareLinks(routeId).length, 0);
});
