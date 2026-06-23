'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let portalIdentity, peers, getDb;
beforeEach(async () => {
  await setup();
  portalIdentity = require('../src/middleware/portalIdentity');
  peers = require('../src/services/peers');
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

// Default home hostname for the test env (GC_DNS_DOMAIN not overridden here,
// so it resolves to the config default 'gc.internal').
const HOME_HOST = 'home.gc.internal';

function runMw(ip, hostname) {
  // Simulate a request that arrived via the internal home Caddy vhost:
  // connection from loopback + the Caddy-set reserved header + home Host.
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    get: (h) => (String(h).toLowerCase() === 'x-gc-portal-peer-ip' ? ip : undefined),
    hostname: hostname !== undefined ? hostname : HOME_HOST,
  };
  let called = false;
  portalIdentity(req, {}, () => { called = true; });
  return { req, called };
}

test('maps a direct peer tunnel IP to its peer id', () => {
  const db = getDb();
  db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
              VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  const { req, called } = runMw('10.8.0.5');
  assert.equal(called, true);
  assert.ok(req.portalPeerId, 'expected a peer id');
});

test('returns null for an unknown source IP', () => {
  const { req } = runMw('10.8.0.99');
  assert.equal(req.portalPeerId, null);
});

test('returns null when the IP belongs to a gateway peer (fail-safe)', () => {
  const db = getDb();
  db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
              VALUES ('gw','k2','10.8.0.9/32',1,'gateway')`).run();
  const { req } = runMw('10.8.0.9');
  assert.equal(req.portalPeerId, null);
});

test('returns null for a disabled peer', () => {
  const db = getDb();
  db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
              VALUES ('bob','k3','10.8.0.6/32',0,'regular')`).run();
  const { req } = runMw('10.8.0.6');
  assert.equal(req.portalPeerId, null);
});

test('returns null when the reserved header is absent (not via internal site)', () => {
  const db = getDb();
  db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
              VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    get: () => undefined,
    hostname: HOME_HOST,
  };
  portalIdentity(req, {}, () => {});
  assert.equal(req.portalPeerId, null);
});

test('returns null when the connection is NOT from loopback (direct-to-Node forgery)', () => {
  const db = getDb();
  db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
              VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  // Attacker hits the Node port directly over the tunnel with a forged header.
  const req = {
    socket: { remoteAddress: '10.8.0.99' },
    get: (h) => (String(h).toLowerCase() === 'x-gc-portal-peer-ip' ? '10.8.0.5' : undefined),
    hostname: HOME_HOST,
  };
  portalIdentity(req, {}, () => {});
  assert.equal(req.portalPeerId, null);
});

test('returns null when Host is a non-home vhost (mgmt-UI forgery blocked)', () => {
  const db = getDb();
  db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type)
              VALUES ('alice','k1','10.8.0.5/32',1,'regular')`).run();
  // loopback + correct header, but Host is the management UI vhost — must be rejected.
  const { req } = runMw('10.8.0.5', 'admin.example.com');
  assert.equal(req.portalPeerId, null,
    'identity must NOT be established when Host is not the home vhost');
});
