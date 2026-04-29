'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rback-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb, getRouteColumns, restoreRouteRow, reinsertRouteRow;

before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
  ({ getRouteColumns, restoreRouteRow, reinsertRouteRow } = require('../src/services/routesRollback'));
});

beforeEach(() => {
  getDb().prepare('DELETE FROM routes').run();
});

describe('routesRollback: getRouteColumns', () => {
  it('reads the live routes-table schema, including a stable id column', () => {
    const cols = getRouteColumns(getDb());
    assert.ok(Array.isArray(cols));
    assert.ok(cols.includes('id'), 'id column must be present');
    assert.ok(cols.includes('domain'), 'domain column must be present');
    assert.ok(cols.includes('target_ip'), 'target_ip column must be present');
    assert.ok(cols.includes('target_port'), 'target_port column must be present');
  });
});

describe('routesRollback: restoreRouteRow', () => {
  it('overwrites an existing row with the snapshot, preserving the id', () => {
    const db = getDb();
    const insertResult = db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port) VALUES ('a.example.com', '10.0.0.1', 80)"
    ).run();
    const id = insertResult.lastInsertRowid;

    // Mutate the row.
    db.prepare("UPDATE routes SET domain='b.example.com', target_port=8080 WHERE id=?").run(id);

    // Restore from a snapshot of the original.
    restoreRouteRow(db, id, { domain: 'a.example.com', target_ip: '10.0.0.1', target_port: 80 });

    const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
    assert.equal(row.domain, 'a.example.com');
    assert.equal(row.target_port, 80);
    assert.equal(row.id, id, 'id is unchanged after restore');
  });

  it('writes NULL for snapshot fields that are undefined', () => {
    const db = getDb();
    const id = db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port, description) VALUES ('x.example.com', '10.0.0.2', 80, 'before')"
    ).run().lastInsertRowid;

    restoreRouteRow(db, id, { domain: 'x.example.com', target_ip: '10.0.0.2', target_port: 80 });
    const row = db.prepare('SELECT description FROM routes WHERE id=?').get(id);
    assert.equal(row.description, null, 'undefined description in the snapshot is restored as NULL');
  });
});

describe('routesRollback: reinsertRouteRow', () => {
  it('re-inserts a row and preserves the original id', () => {
    const db = getDb();
    const id = db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port) VALUES ('keep-id.example.com', '10.0.0.3', 80)"
    ).run().lastInsertRowid;
    const original = db.prepare('SELECT * FROM routes WHERE id=?').get(id);

    db.prepare('DELETE FROM routes WHERE id=?').run(id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes').get().n, 0);

    reinsertRouteRow(db, original);
    const reborn = db.prepare('SELECT * FROM routes WHERE id=?').get(id);
    assert.ok(reborn, 'row must reappear at the original id');
    assert.equal(reborn.domain, 'keep-id.example.com');
  });
});
