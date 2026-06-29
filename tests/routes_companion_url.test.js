'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routes;
beforeEach(async () => { await setup(); routes = require('../src/services/routes'); });
afterEach(async () => { await teardown(); });

test('resolveCompanionUrl returns null for missing route', () => {
  assert.equal(routes.resolveCompanionUrl(99999), null);
});

test('resolveCompanionUrl returns null for route without target_peer_id', () => {
  const db = getDb();
  db.prepare(
    "INSERT INTO routes (domain, target_ip, target_port) VALUES ('nopeer.test.local', '127.0.0.1', 80)"
  ).run();
  const row = db.prepare("SELECT id FROM routes WHERE domain='nopeer.test.local'").get();
  assert.equal(routes.resolveCompanionUrl(row.id), null);
});

test('resolveCompanionUrl derives baseUrl from peer WireGuard IP', () => {
  const db = getDb();
  const peerInfo = db.prepare(
    "INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('testgw', 'FAKEPUB==testgw', '10.8.0.8/32', 1)"
  ).run();
  const peerId = Number(peerInfo.lastInsertRowid);
  const routeInfo = db.prepare(
    "INSERT INTO routes (domain, target_ip, target_port, target_peer_id) VALUES ('phoscon.example.test', '127.0.0.1', 80, ?)"
  ).run(peerId);
  const routeId = Number(routeInfo.lastInsertRowid);

  const result = routes.resolveCompanionUrl(routeId);
  assert.ok(result !== null);
  assert.equal(result.baseUrl, 'http://10.8.0.8:8080');
  assert.equal(result.domain, 'phoscon.example.test');
});
