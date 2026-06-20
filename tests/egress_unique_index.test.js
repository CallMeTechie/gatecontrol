'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os'); const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
describe('egress lan_listen_port uniqueness', () => {
  let db;
  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-eu-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db'); process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    db = require('../src/db/connection').getDb();
  });
  it('rejects a second enabled egress route with same near_peer_id + lan_listen_port', () => {
    db.prepare("INSERT INTO egress_routes (name,near_peer_id,vip_ip,vip_prefix,lan_listen_port,target_route_id,allowed_source_ips,enabled) VALUES ('a',1,'192.168.2.250',24,14450,1,'[]',1)").run();
    assert.throws(() => {
      db.prepare("INSERT INTO egress_routes (name,near_peer_id,vip_ip,vip_prefix,lan_listen_port,target_route_id,allowed_source_ips,enabled) VALUES ('b',1,'192.168.2.251',24,14450,1,'[]',1)").run();
    }, /UNIQUE/);
  });
});
