'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mig-lanip-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb;
before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
});

describe('migration: gateway_meta.lan_ip', () => {
  it('adds a nullable lan_ip column to gateway_meta', () => {
    const cols = getDb().prepare("PRAGMA table_info(gateway_meta)").all();
    const lanIp = cols.find(c => c.name === 'lan_ip');
    assert.ok(lanIp, 'lan_ip column must exist');
    assert.equal(lanIp.notnull, 0, 'lan_ip must be nullable');
  });
});
