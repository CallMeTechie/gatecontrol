'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let db;
before(async () => { await setup(); db = getDb(); });
after(() => teardown());

describe('Migration 55: rdp_sessions browser-session columns', () => {
  const cols = () => db.pragma('table_info(rdp_sessions)').map((c) => c.name);
  it('adds protocol + via columns', () => {
    const c = cols();
    assert.ok(c.includes('protocol'), 'missing protocol');
    assert.ok(c.includes('via'), 'missing via');
  });
  it('defaults via=native, protocol=rdp for a new row', () => {
    const routeId = db.prepare("INSERT INTO rdp_routes (name, host, port) VALUES ('s', '10.0.0.9', 3389)").run().lastInsertRowid;
    const id = db.prepare("INSERT INTO rdp_sessions (rdp_route_id, status) VALUES (?, 'active')").run(routeId).lastInsertRowid;
    const row = db.prepare('SELECT protocol, via FROM rdp_sessions WHERE id = ?').get(id);
    assert.equal(row.protocol, 'rdp');
    assert.equal(row.via, 'native');
  });
});
