'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mig-egress-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb;
before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
});

describe('migration 54: egress_routes table', () => {
  it('creates egress_routes with expected columns', () => {
    const cols = getDb().prepare("PRAGMA table_info(egress_routes)").all().map(c => c.name);
    for (const c of [
      'id', 'name', 'device_id', 'near_peer_id', 'near_pool_id',
      'vip_ip', 'vip_prefix', 'lan_listen_port', 'target_route_id',
      'allowed_source_ips', 'enabled', 'created_at', 'updated_at',
    ]) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });
});
