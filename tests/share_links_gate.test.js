'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  const db = getDb();
  routeId = db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('g.example.com','10.0.0.6',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('ensureShareGate inserts a share route_auth row and is idempotent', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  assert.equal(svc.ensureShareGate(routeId), true);   // newly gated
  assert.equal(svc.ensureShareGate(routeId), false);  // already gated → no-op, no throw
  const rows = db.prepare("SELECT auth_type FROM route_auth WHERE route_id = ?").all(routeId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].auth_type, 'share');
});

test('ensureShareGate does NOT gate a route that already has real auth', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  db.prepare("INSERT INTO route_auth (route_id, auth_type) VALUES (?, 'email_password')").run(routeId);
  assert.equal(svc.ensureShareGate(routeId), false);
  assert.equal(db.prepare("SELECT auth_type FROM route_auth WHERE route_id = ?").get(routeId).auth_type, 'email_password');
});

test('disableSharing removes share gate + links; leaves real auth intact', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  svc.ensureShareGate(routeId);
  svc.createShareLink(routeId, { expiresInHours: 1, oneTime: false });
  assert.equal(svc.disableSharing(routeId), true); // removed a 'share' gate → caller regenerates Caddy
  assert.equal(db.prepare("SELECT COUNT(*) c FROM route_auth WHERE route_id = ?").get(routeId).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM route_auth_share_links WHERE route_id = ?").get(routeId).c, 0);
});
