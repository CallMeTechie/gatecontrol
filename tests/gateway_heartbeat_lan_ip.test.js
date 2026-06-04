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

describe('gateway API: heartbeat lan_ip capture', () => {
  let server, apiToken, peerId, baseUrl, db;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwhblanip-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'hb-lanip-gw', apiPort: 9877 });
    apiToken = gw.apiToken; peerId = gw.peer.id;
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    db = require('../src/db/connection').getDb();
  });

  after(() => server && server.close());

  function postJson(p, body, headers = {}) {
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

  function getDb() { return db; }

  async function sendHeartbeat(body) {
    const r = await postJson('/api/v1/gateway/heartbeat', body, { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
    return r;
  }

  describe('heartbeat: lan_ip capture', () => {
    it('stores a valid private lan_ip', async () => {
      await sendHeartbeat({ lan_ip: '192.168.2.228' });
      const row = getDb().prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id = ?').get(peerId);
      assert.equal(row.lan_ip, '192.168.2.228');
    });
    it('ignores a public/invalid lan_ip', async () => {
      getDb().prepare('UPDATE gateway_meta SET lan_ip = NULL WHERE peer_id = ?').run(peerId);
      await sendHeartbeat({ lan_ip: '8.8.8.8' });
      await sendHeartbeat({ lan_ip: 'garbage' });
      const row = getDb().prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id = ?').get(peerId);
      assert.equal(row.lan_ip, null);
    });
    it('only writes on change (no-op when unchanged)', async () => {
      await sendHeartbeat({ lan_ip: '10.1.2.3' });
      const before = getDb().prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id = ?').get(peerId);
      await sendHeartbeat({ lan_ip: '10.1.2.3' });
      const after = getDb().prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id = ?').get(peerId);
      assert.equal(before.lan_ip, '10.1.2.3');
      assert.equal(after.lan_ip, '10.1.2.3');
    });
  });
});
