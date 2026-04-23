'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('routes.update — clears gateway_* fields when target_kind switches away from gateway', () => {
  let routes, gateways, db, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-tkc-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
      '../src/services/gateways', '../src/services/routes',
      '../src/services/caddyConfig', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({
      gateway_peers: 10,
      http_routes: -1,
      l4_routes: -1,
    });

    // Stub Caddy sync — no real HTTP calls in tests
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {};

    routes = require('../src/services/routes');
    db = require('../src/db/connection').getDb();

    const gw = await gateways.createGateway({ name: 'tkc-gw', apiPort: 9876 });
    gwPeerId = gw.peer.id;
  });

  it('switching target_kind from "gateway" to "peer" clears target_peer_id, target_lan_host, target_lan_port, wol_enabled, wol_mac', async () => {
    // Create a gateway-backed route with all gateway-specific fields populated
    const created = await routes.create({
      domain: 'switch-gw-to-peer.example.com',
      target_ip: '10.8.0.99',
      target_port: 80,
      target_kind: 'gateway',
      target_peer_id: gwPeerId,
      target_lan_host: '192.168.1.10',
      target_lan_port: 3389,
      wol_enabled: 1,
      wol_mac: 'aa:bb:cc:dd:ee:ff',
    });

    // Sanity: all gateway fields populated after create
    const before = db.prepare('SELECT * FROM routes WHERE id = ?').get(created.id);
    assert.equal(before.target_kind, 'gateway');
    assert.equal(before.target_peer_id, gwPeerId);
    assert.equal(before.target_lan_host, '192.168.1.10');
    assert.equal(before.target_lan_port, 3389);
    assert.equal(before.wol_enabled, 1);
    assert.equal(before.wol_mac, 'aa:bb:cc:dd:ee:ff');

    // Switch away from gateway (no gateway_* fields in update payload)
    await routes.update(created.id, { target_kind: 'peer' });

    const after = db.prepare('SELECT * FROM routes WHERE id = ?').get(created.id);
    assert.equal(after.target_kind, 'peer', 'target_kind must be updated to peer');
    assert.equal(after.target_peer_id, null, 'target_peer_id must be NULL after switching away from gateway');
    assert.equal(after.target_lan_host, null, 'target_lan_host must be NULL');
    assert.equal(after.target_lan_port, null, 'target_lan_port must be NULL');
    assert.equal(after.wol_enabled, 0, 'wol_enabled must be 0');
    assert.equal(after.wol_mac, null, 'wol_mac must be NULL');
  });

  it('updating unrelated fields without touching target_kind does NOT clear gateway_* fields', async () => {
    const created = await routes.create({
      domain: 'unrelated-update.example.com',
      target_ip: '10.8.0.98',
      target_port: 80,
      target_kind: 'gateway',
      target_peer_id: gwPeerId,
      target_lan_host: '192.168.1.11',
      target_lan_port: 22,
      wol_enabled: 1,
      wol_mac: '11:22:33:44:55:66',
    });

    // Update only description — target_kind not in payload
    await routes.update(created.id, { description: 'new desc' });

    const after = db.prepare('SELECT * FROM routes WHERE id = ?').get(created.id);
    assert.equal(after.target_kind, 'gateway', 'target_kind unchanged');
    assert.equal(after.target_peer_id, gwPeerId, 'gateway_* preserved when not switching kinds');
    assert.equal(after.target_lan_host, '192.168.1.11');
    assert.equal(after.target_lan_port, 22);
    assert.equal(after.wol_enabled, 1);
    assert.equal(after.wol_mac, '11:22:33:44:55:66');
  });

  it('switching back to "gateway" with new values overwrites cleanly (no stale from previous switch)', async () => {
    const created = await routes.create({
      domain: 'roundtrip.example.com',
      target_ip: '10.8.0.97',
      target_port: 80,
      target_kind: 'gateway',
      target_peer_id: gwPeerId,
      target_lan_host: '192.168.1.20',
      target_lan_port: 443,
      wol_enabled: 1,
      wol_mac: 'aa:aa:aa:aa:aa:aa',
    });

    await routes.update(created.id, { target_kind: 'peer' });
    await routes.update(created.id, {
      target_kind: 'gateway',
      target_peer_id: gwPeerId,
      target_lan_host: '10.0.0.5',
      target_lan_port: 8080,
    });

    const after = db.prepare('SELECT * FROM routes WHERE id = ?').get(created.id);
    assert.equal(after.target_kind, 'gateway');
    assert.equal(after.target_lan_host, '10.0.0.5');
    assert.equal(after.target_lan_port, 8080);
  });
});
