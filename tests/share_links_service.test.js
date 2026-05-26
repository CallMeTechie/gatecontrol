'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  const db = getDb();
  const r = db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('app.example.com','10.0.0.5',8080,1)").run();
  routeId = r.lastInsertRowid;
});
afterEach(teardown);

test('createShareLink stores only the hash and returns the token once', () => {
  const svc = require('../src/services/shareLinks');
  const { id, token, expiresAt } = svc.createShareLink(routeId, { expiresInHours: 24, oneTime: false });
  assert.ok(token.length >= 40);
  assert.ok(id > 0);
  assert.ok(new Date(expiresAt).getTime() > Date.now());
  const db = getDb();
  const row = db.prepare('SELECT token_hash FROM route_auth_share_links WHERE id = ?').get(id);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  // plaintext token is nowhere in the row
  const dump = JSON.stringify(db.prepare('SELECT * FROM route_auth_share_links WHERE id = ?').get(id));
  assert.ok(!dump.includes(token));
});
