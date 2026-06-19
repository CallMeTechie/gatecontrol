'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
const rdpSessions = require('../src/services/rdpSessions');

let routeId;

before(async () => {
  await setup();
  const db = getDb();
  const r = db.prepare(
    "INSERT INTO rdp_routes (name, host, port) VALUES ('via-test', '10.0.0.1', 3389)"
  ).run();
  routeId = r.lastInsertRowid;
});

after(() => teardown());

describe('rdpSessions.startSession via/protocol extension', () => {
  it('records via/protocol when supplied (browser tunnel path)', () => {
    const s = rdpSessions.startSession(routeId, {
      tokenId: null, peerId: 7, clientIp: '10.8.0.2',
      via: 'browser', protocol: 'vnc',
    });
    const row = getDb().prepare('SELECT via, protocol FROM rdp_sessions WHERE id = ?').get(s.id);
    assert.equal(row.via, 'browser');
    assert.equal(row.protocol, 'vnc');
  });

  it('defaults to native/rdp when omitted (native path identical)', () => {
    const s = rdpSessions.startSession(routeId, {
      tokenId: 1, tokenName: 'n', peerId: null, clientIp: '127.0.0.1',
    });
    const row = getDb().prepare('SELECT via, protocol FROM rdp_sessions WHERE id = ?').get(s.id);
    assert.equal(row.via, 'native');
    assert.equal(row.protocol, 'rdp');
  });
});
