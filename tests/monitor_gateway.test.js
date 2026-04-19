'use strict';

const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('monitor: gateway health tracking', () => {
  let gateways, activity, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mon-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/services/gatewayHealth']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    gateways._resetSmCacheForTest && gateways._resetSmCacheForTest();
    activity = require('../src/services/activity');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'mon-gw', apiPort: 9876 });
    peerId = gw.peer.id;
  });

  it('after 4 heartbeats with http_proxy_healthy=true gateway is online', () => {
    for (let i = 0; i < 4; i++) {
      gateways.handleHeartbeat(peerId, { http_proxy_healthy: true, tcp_listeners: [] });
    }
    const status = gateways.getHealthStatus(peerId);
    assert.equal(status, 'online');
  });

  it('after online then 3 unhealthy heartbeats transitions to offline with alert', () => {
    // bring to online
    for (let i = 0; i < 4; i++) gateways.handleHeartbeat(peerId, { http_proxy_healthy: true });
    assert.equal(gateways.getHealthStatus(peerId), 'online');

    // Fake cooldown exhaustion
    gateways._forceCooldownExhaustedForTest(peerId);

    const activitySpy = mock.method(activity, 'log');
    try {
      for (let i = 0; i < 3; i++) gateways.handleHeartbeat(peerId, { http_proxy_healthy: false });
      assert.equal(gateways.getHealthStatus(peerId), 'offline');
      assert.ok(activitySpy.mock.calls.some(c => c.arguments[0] === 'gateway_offline'));
    } finally {
      activitySpy.mock.restore();
    }
  });
});
