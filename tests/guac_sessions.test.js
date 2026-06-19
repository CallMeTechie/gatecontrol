// tests/guac_sessions.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_GUAC_MAX_PER_ROUTE = '2';
process.env.GC_GUAC_MAX_PER_USER = '2';
process.env.GC_GUAC_MAX_GLOBAL = '10';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
const rdpSessions = require('../src/services/rdpSessions');
const { admitSession } = require('../src/services/guacSessions');

let db, routeId, cfg, cfgPrev;
before(async () => {
  await setup(); db = getDb();
  // Env vars above only apply if config is required here first; in the full suite
  // config may already be cached → set the caps on the loaded object directly.
  cfg = require('../config/default').guac;
  cfgPrev = { maxGlobal: cfg.maxGlobal, maxPerRoute: cfg.maxPerRoute, maxPerUser: cfg.maxPerUser };
  cfg.maxGlobal = 10; cfg.maxPerRoute = 2; cfg.maxPerUser = 2;
  routeId = db.prepare("INSERT INTO rdp_routes (name, host, port, protocol) VALUES ('r','10.0.0.5',5900,'vnc')").run().lastInsertRowid;
});
after(() => { Object.assign(cfg, cfgPrev); teardown(); });
beforeEach(() => { db.prepare('DELETE FROM rdp_sessions').run(); });

describe('admitSession (reclaim-before-cap)', () => {
  it('admits when under cap', () => {
    const r = admitSession({ routeId, tokenId: 1, peerId: null, isStale: () => false });
    assert.equal(r.ok, true);
  });
  it('rejects a third LIVE session for the same route (route cap=2, no reclaim)', () => {
    rdpSessions.startSession(routeId, { tokenId: 1, peerId: 11, clientIp: 'x' });
    rdpSessions.startSession(routeId, { tokenId: 1, peerId: 12, clientIp: 'x' });
    const r = admitSession({ routeId, tokenId: 1, peerId: 13, isStale: () => false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'route_limit');
  });
  it('rejects a third LIVE session for the same user across routes (user cap=2)', () => {
    const route2 = db.prepare("INSERT INTO rdp_routes (name, host, port, protocol) VALUES ('r2','10.0.0.6',5900,'vnc')").run().lastInsertRowid;
    rdpSessions.startSession(routeId, { tokenId: 1, peerId: 99, clientIp: 'x' });
    rdpSessions.startSession(route2, { tokenId: 1, peerId: 99, clientIp: 'x' });
    const r = admitSession({ routeId: route2, tokenId: 1, peerId: 99, isStale: () => false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'user_limit');
  });
  it('rejects when the global cap is reached', () => {
    // config.guac is read at require-time → mutate the loaded object, don't set env.
    const cfg = require('../config/default').guac;
    const prev = cfg.maxGlobal; cfg.maxGlobal = 1;
    try {
      rdpSessions.startSession(routeId, { tokenId: 1, peerId: 1, clientIp: 'x' });
      const r = admitSession({ routeId, tokenId: 2, peerId: 2, isStale: () => false });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'global_limit');
    } finally { cfg.maxGlobal = prev; }
  });
  it('reclaims a STALE slot and then admits', () => {
    rdpSessions.startSession(routeId, { tokenId: 1, peerId: 11, clientIp: 'x' });
    rdpSessions.startSession(routeId, { tokenId: 1, peerId: 12, clientIp: 'x' });
    // Mark all stale → reclaim frees them, admission succeeds.
    const r = admitSession({ routeId, tokenId: 1, peerId: 13, isStale: () => true });
    assert.equal(r.ok, true);
  });
});
