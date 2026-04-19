'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('gateways.notifyWol', () => {
  let gateways, peerId, pushToken, mockGwServer, received;

  before(async () => {
    received = [];
    mockGwServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        received.push({ path: req.url, headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, elapsed_ms: 12000 }));
      });
    }).listen(0);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wol-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'wol-gw', apiPort: mockGwServer.address().port });
    peerId = gw.peer.id;
    pushToken = gw.pushToken;
    require('../src/db/connection').getDb().prepare('UPDATE peers SET allowed_ips=? WHERE id=?').run('127.0.0.1/32', peerId);
  });

  after(() => { try { mockGwServer && mockGwServer.close(); } catch {} });

  it('POSTs to /api/wol with MAC, lan_host, timeout_ms', async () => {
    const result = await gateways.notifyWol(peerId, { mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 60000 });
    assert.equal(received.length, 1);
    const body = JSON.parse(received[0].body);
    assert.equal(body.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(body.lan_host, '192.168.1.10');
    assert.equal(body.timeout_ms, 60000);
    assert.equal(received[0].headers['x-gateway-token'], pushToken);
    assert.deepEqual(result, { success: true, elapsed_ms: 12000 });
  });
});
