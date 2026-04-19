'use strict';

const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('monitor: auto-WoL on backend down', () => {
  let monitor, gateways, routeId, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-awol-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/monitor', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    monitor = require('../src/services/monitor');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'wm-gw', apiPort: 9876 });
    peerId = gw.peer.id;
    const db = require('../src/db/connection').getDb();
    db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind, target_peer_id, target_lan_host, target_lan_port, wol_enabled, wol_mac)
                VALUES ('nas.example.com', ?, 8080, 'http', 'gateway', ?, '192.168.1.10', 5001, 1, 'AA:BB:CC:DD:EE:FF')`)
      .run(gw.peer.ip, peerId);
    routeId = db.prepare('SELECT id FROM routes WHERE domain=?').get('nas.example.com').id;
  });

  it('monitor down-event on wol_enabled route triggers gateways.notifyWol', () => {
    const spy = mock.method(gateways, 'notifyWol', () => Promise.resolve({ success: true }));
    try {
      monitor.handleRouteDownDetected(routeId);
      assert.equal(spy.mock.calls.length, 1);
      const call = spy.mock.calls[0];
      assert.equal(call.arguments[0], peerId);
      assert.equal(call.arguments[1].mac, 'AA:BB:CC:DD:EE:FF');
      assert.equal(call.arguments[1].lan_host, '192.168.1.10');
    } finally {
      spy.mock.restore();
    }
  });

  it('monitor down-event on wol_disabled route does NOT trigger WoL', () => {
    const db = require('../src/db/connection').getDb();
    db.prepare('UPDATE routes SET wol_enabled=0 WHERE id=?').run(routeId);
    const spy = mock.method(gateways, 'notifyWol', () => Promise.resolve({ success: true }));
    try {
      monitor.handleRouteDownDetected(routeId);
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});
