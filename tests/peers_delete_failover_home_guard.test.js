'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-del-guard-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb, peers;
before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
  peers = require('../src/services/peers');
});

let _seq = 0;
function seedFailoverRoute() {
  const db = getDb();
  const ins = db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled)
                          VALUES (?, ?, ?, 'gateway', 1)`);
  const home = ins.run('home-gw-' + _seq, crypto.randomBytes(16).toString('hex'), '10.8.0.2/32').lastInsertRowid;
  const sib = ins.run('sib-gw-' + _seq, crypto.randomBytes(16).toString('hex'), '10.8.0.3/32').lastInsertRowid;
  _seq++;
  db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind,
              target_peer_id, original_peer_id, target_lan_host, target_lan_port, enabled)
              VALUES ('x' || ? || '.example.com','127.0.0.1',8080,'http','gateway',?,?, '127.0.0.1', 8096, 1)`)
    .run(_seq, sib, home);
  return { home, sib };
}

describe('peers delete: failover-home guard', () => {
  it('remove() blocks deleting a gateway that is original_peer_id of a route', async () => {
    const { home } = seedFailoverRoute();
    await assert.rejects(() => peers.remove(home), /failover_home/);
  });

  it('batch delete blocks when any id is a failover home', async () => {
    const { home } = seedFailoverRoute();
    await assert.rejects(() => peers.batch('delete', [home]), /failover_home/);
  });

  it('deleting a gateway that is NOT a failover home still succeeds', async () => {
    const { sib } = seedFailoverRoute();
    getDb().prepare("UPDATE routes SET target_peer_id = original_peer_id, original_peer_id = NULL WHERE original_peer_id IS NOT NULL").run();
    await assert.doesNotReject(() => peers.remove(sib));
  });
});
