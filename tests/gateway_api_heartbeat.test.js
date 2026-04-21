'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('gateway API: /heartbeat', () => {
  let server, apiToken, peerId, baseUrl, db;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwhb-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'hb-gw', apiPort: 9876 });
    apiToken = gw.apiToken; peerId = gw.peer.id;
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    db = require('../src/db/connection').getDb();
  });

  after(() => server && server.close());

  async function postJson(p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + p);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      }, (res) => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  it('accepts heartbeat with health payload and updates last_seen_at', () => {
    const before = Date.now() - 1;
    return postJson('/api/v1/gateway/heartbeat', {
      uptime_s: 3600,
      config_hash: 'sha256:' + 'a'.repeat(64),
      http_proxy_healthy: true,
      tcp_listeners: [{ port: 13389, status: 'listening' }],
      wg_handshake_age_s: 45,
      rx_bytes: 1234, tx_bytes: 5678,
    }, { Authorization: `Bearer ${apiToken}` }).then(r => {
      assert.equal(r.status, 200);
      const meta = db.prepare('SELECT last_seen_at FROM gateway_meta WHERE peer_id=?').get(peerId);
      assert.ok(meta.last_seen_at >= before);
    });
  });

  it('rejects heartbeat with invalid payload (wrong type)', async () => {
    const r = await postJson('/api/v1/gateway/heartbeat', { uptime_s: 'not-a-number' }, { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 400);
  });

  it('rejects heartbeat without auth', async () => {
    const r = await postJson('/api/v1/gateway/heartbeat', {});
    assert.equal(r.status, 401);
  });

  it('captures hostname into peers.hostname via internal_dns feature', async () => {
    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10, internal_dns: true });

    const r = await postJson('/api/v1/gateway/heartbeat', {
      uptime_s: 10,
      hostname: 'home-gw',
    }, { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT hostname, hostname_source FROM peers WHERE id = ?').get(peerId);
    assert.equal(row.hostname, 'home-gw');
    assert.equal(row.hostname_source, 'agent');
  });

  it('does not overwrite admin-set hostname from agent heartbeat', async () => {
    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10, internal_dns: true });
    const peers = require('../src/services/peers');
    peers.setHostname(peerId, 'admin-chosen', 'admin');

    const r = await postJson('/api/v1/gateway/heartbeat', {
      uptime_s: 10,
      hostname: 'some-other-name',
    }, { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT hostname, hostname_source FROM peers WHERE id = ?').get(peerId);
    assert.equal(row.hostname, 'admin-chosen');
    assert.equal(row.hostname_source, 'admin');
  });

  it('silently ignores malformed hostname (heartbeat still 200)', async () => {
    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10, internal_dns: true });

    const r = await postJson('/api/v1/gateway/heartbeat', {
      uptime_s: 10,
      hostname: 'BAD NAME WITH SPACES',
    }, { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
  });
});
