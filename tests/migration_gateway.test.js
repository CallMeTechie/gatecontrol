'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// Minimal env so config/default loads
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('migration 36: gateway support', () => {
  let db;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-migr-'));
  const dbPath = path.join(tmpDir, 'test.db');

  before(async () => {
    process.env.GC_DB_PATH = dbPath;
    delete require.cache[require.resolve('../config/default')];
    delete require.cache[require.resolve('../src/db/connection')];
    delete require.cache[require.resolve('../src/db/migrations')];
    const { getDb } = require('../src/db/connection');
    const { runMigrations } = require('../src/db/migrations');
    runMigrations();
    db = getDb();
  });

  it('peers.peer_type column exists with default "regular"', () => {
    const cols = db.prepare("PRAGMA table_info(peers)").all();
    const peerType = cols.find(c => c.name === 'peer_type');
    assert.ok(peerType, 'peer_type column missing');
    assert.equal(peerType.dflt_value, "'regular'");
  });

  it('routes has target_kind/target_peer_id/target_lan_host/target_lan_port columns', () => {
    const cols = db.prepare("PRAGMA table_info(routes)").all().map(c => c.name);
    assert.ok(cols.includes('target_kind'));
    assert.ok(cols.includes('target_peer_id'));
    assert.ok(cols.includes('target_lan_host'));
    assert.ok(cols.includes('target_lan_port'));
    assert.ok(cols.includes('wol_enabled'));
    assert.ok(cols.includes('wol_mac'));
  });

  it('gateway_meta table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(gateway_meta)").all().map(c => c.name);
    assert.ok(cols.includes('peer_id'));
    assert.ok(cols.includes('api_port'));
    assert.ok(cols.includes('api_token_hash'));
    assert.ok(cols.includes('push_token_encrypted'));
    assert.ok(cols.includes('needs_repair'));
    assert.ok(cols.includes('last_seen_at'));
    assert.ok(cols.includes('last_config_hash'));
  });

  it('existing routes get target_kind=peer by default', () => {
    db.prepare("INSERT INTO peers (name, public_key, allowed_ips) VALUES ('legacy', 'key1', '10.8.0.99/32')").run();
    db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type) VALUES ('legacy.com', '10.8.0.99', 80, 'http')").run();
    const row = db.prepare("SELECT target_kind FROM routes WHERE domain='legacy.com'").get();
    assert.equal(row.target_kind, 'peer');
  });
});
