'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routes, peers, accessRules, wireguard, origSync;

beforeEach(async () => {
  await setup();
  // Stub WG sync so peer deletes never shell out to a real `wg`.
  // (caddyConfig.syncToCaddy already early-returns under NODE_ENV=test.)
  wireguard = require('../src/services/wireguard');
  origSync = wireguard.syncConfig;
  wireguard.syncConfig = async () => null;
  routes = require('../src/services/routes');
  peers = require('../src/services/peers');
  accessRules = require('../src/services/accessRules');
});
afterEach(() => { wireguard.syncConfig = origSync; teardown(); });

function rulesCountFor(type, id) {
  return getDb()
    .prepare('SELECT COUNT(*) AS c FROM access_rules WHERE target_type=? AND target_id=?')
    .get(type, id).c;
}
function insertRoute() {
  return Number(getDb()
    .prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('cascade.example.com', '10.8.0.9', 80, 1)")
    .run().lastInsertRowid);
}
function insertPeer(name, key, ip) {
  return Number(getDb()
    .prepare('INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES (?,?,?,1)')
    .run(name, key, ip).lastInsertRowid);
}

test('routes.remove (single) cascade-deletes the route access rules', async () => {
  const routeId = insertRoute();
  accessRules.createRule({ target_type: 'route', target_id: routeId, mode: 'allow', schedule: 'Mo-Fr 09:00-17:00' });
  assert.equal(rulesCountFor('route', routeId), 1, 'precondition: rule exists');

  await routes.remove(routeId);

  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM routes WHERE id=?').get(routeId).c, 0, 'route row gone');
  assert.equal(rulesCountFor('route', routeId), 0, 'route access rules cascaded');
});

test('routes.batch("delete") cascade-deletes the route access rules', async () => {
  const routeId = insertRoute();
  accessRules.createRule({ target_type: 'route', target_id: routeId, mode: 'block', schedule: 'Mo 09:00-12:00' });
  assert.equal(rulesCountFor('route', routeId), 1, 'precondition: rule exists');

  await routes.batch('delete', [routeId]);

  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM routes WHERE id=?').get(routeId).c, 0, 'route row gone');
  assert.equal(rulesCountFor('route', routeId), 0, 'route access rules cascaded');
});

test('peers.remove (single) cascade-deletes the peer access rules', async () => {
  const peerId = insertPeer('p-single', 'PUBKEY_SINGLE=', '10.8.0.21/32');
  accessRules.createRule({ target_type: 'peer', target_id: peerId, mode: 'allow', schedule: 'Mo-Fr 09:00-17:00' });
  assert.equal(rulesCountFor('peer', peerId), 1, 'precondition: rule exists');

  await peers.remove(peerId);

  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM peers WHERE id=?').get(peerId).c, 0, 'peer row gone');
  assert.equal(rulesCountFor('peer', peerId), 0, 'peer access rules cascaded');
});

test('peers.batch("delete") cascade-deletes the peer access rules', async () => {
  const peerId = insertPeer('p-batch', 'PUBKEY_BATCH=', '10.8.0.22/32');
  accessRules.createRule({ target_type: 'peer', target_id: peerId, mode: 'block', schedule: 'Mo 09:00-12:00' });
  assert.equal(rulesCountFor('peer', peerId), 1, 'precondition: rule exists');

  await peers.batch('delete', [peerId]);

  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM peers WHERE id=?').get(peerId).c, 0, 'peer row gone');
  assert.equal(rulesCountFor('peer', peerId), 0, 'peer access rules cascaded');
});
