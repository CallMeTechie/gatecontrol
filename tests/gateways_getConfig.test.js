'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { CONFIG_HASH_VERSION } = require('@callmetechie/gatecontrol-config-hash');

describe('gateways.getGatewayConfig', () => {
  let gateways, db, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gw-cfg-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'gw', apiPort: 9876 });
    gwPeerId = gw.peer.id;

    // Insert gateway-typed HTTP route
    db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind, target_peer_id, target_lan_host, target_lan_port, wol_enabled)
                VALUES ('nas.example.com', ?, 8080, 'http', 'gateway', ?, '192.168.1.10', 5001, 0)`)
      .run(gw.peer.ip, gwPeerId);
  });

  it('returns config with config_hash_version=1', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.equal(cfg.config_hash_version, CONFIG_HASH_VERSION);
  });

  it('includes peer_id', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.equal(cfg.peer_id, gwPeerId);
  });

  it('includes routes with lan_host/lan_port/wol fields', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    const route = cfg.routes.find(r => r.domain === 'nas.example.com');
    assert.ok(route);
    assert.equal(route.target_kind, 'gateway');
    assert.equal(route.target_lan_host, '192.168.1.10');
    assert.equal(route.target_lan_port, 5001);
    assert.equal(route.wol_enabled, false);
  });

  it('omits routes for other gateways', async () => {
    await gateways.createGateway({ name: 'gw2', apiPort: 9876 });
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.equal(cfg.routes.length, 1, 'should only contain gw1 routes');
  });

  it('includes l4_routes array (empty if none)', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.ok(Array.isArray(cfg.l4_routes));
  });
});
