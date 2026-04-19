'use strict';

const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('routes hooks → notifyConfigChanged', () => {
  let routes, gateways, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rh-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/routes', '../src/services/caddyConfig', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({
      gateway_peers: 10,
      http_routes: -1,
      l4_routes: -1,
    });

    // Stub syncToCaddy so no real HTTP calls
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {};

    routes = require('../src/services/routes');
    const gw = await gateways.createGateway({ name: 'hook-gw', apiPort: 9876 });
    gwPeerId = gw.peer.id;
  });

  it('createRoute with target_kind=gateway calls notifyConfigChanged', async () => {
    const spy = mock.method(gateways, 'notifyConfigChanged', () => Promise.resolve());
    try {
      await routes.create({
        domain: 'new.example.com', route_type: 'http',
        target_ip: '10.8.0.5',
        target_port: 8080,
        target_kind: 'gateway', target_peer_id: gwPeerId,
        target_lan_host: '192.168.1.50', target_lan_port: 8080,
      });
      assert.ok(spy.mock.calls.length >= 1);
      const called = spy.mock.calls.some(c => c.arguments[0] === gwPeerId);
      assert.ok(called, 'notifyConfigChanged called with right peerId');
    } finally {
      spy.mock.restore();
    }
  });

  it('createRoute with target_kind=peer does NOT call notifyConfigChanged', async () => {
    const spy = mock.method(gateways, 'notifyConfigChanged', () => Promise.resolve());
    try {
      await routes.create({
        domain: 'peer.example.com', route_type: 'http',
        target_kind: 'peer', target_ip: '10.8.0.5', target_port: 80,
      });
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});
