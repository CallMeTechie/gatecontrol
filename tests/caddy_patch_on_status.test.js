'use strict';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('caddyConfig: partial patch on gateway status change', () => {
  it('patchGatewayRouteHandlers sends PATCH per route', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cp-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/caddyConfig'].forEach(p => {
      try { delete require.cache[require.resolve(p)]; } catch {}
    });
    require('../src/db/migrations').runMigrations();
    const db = require('../src/db/connection').getDb();
    db.prepare("INSERT INTO peers (name, public_key, allowed_ips, peer_type) VALUES ('gw1', 'k1', '10.8.0.5/32', 'gateway')").run();
    const peerId = db.prepare("SELECT id FROM peers WHERE name='gw1'").get().id;
    db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind, target_peer_id) VALUES ('nas.example.com', '10.8.0.5', 8080, 'http', 'gateway', ?)").run(peerId);

    const caddyConfig = require('../src/services/caddyConfig');
    const patches = [];
    const mockPatch = mock.method(caddyConfig._caddyApi || (caddyConfig._caddyApi = {}), 'patch', async (p, b) => { patches.push({ p, b }); });
    try {
      await caddyConfig.patchGatewayRouteHandlers({ peerId, offline: true, gatewayName: 'gw1', lastSeen: '14:32' });
      assert.ok(patches.length >= 1);
    } finally {
      mockPatch.mock.restore();
    }
  });
});
