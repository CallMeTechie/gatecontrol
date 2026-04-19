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

describe('gateways.notifyConfigChanged', () => {
  let gateways, peerId, pushToken, mockGwServer, receivedRequests;

  before(async () => {
    receivedRequests = [];
    mockGwServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        receivedRequests.push({ path: req.url, method: req.method, headers: req.headers, body });
        res.writeHead(200); res.end('ok');
      });
    }).listen(0);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwp-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'push-gw', apiPort: mockGwServer.address().port });
    peerId = gw.peer.id;
    pushToken = gw.pushToken;

    // Override peer allowed_ips to localhost for testing
    require('../src/db/connection').getDb()
      .prepare('UPDATE peers SET allowed_ips=? WHERE id=?').run('127.0.0.1/32', peerId);
  });

  after(() => { try { mockGwServer && mockGwServer.close(); } catch {} });

  it('POSTs to gateway /api/config-changed with decrypted push-token', async () => {
    await gateways.notifyConfigChanged(peerId);
    assert.equal(receivedRequests.length, 1);
    const r = receivedRequests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/api/config-changed');
    assert.equal(r.headers['x-gateway-token'], pushToken);
  });

  it('ignores push failures silently (best-effort)', async () => {
    mockGwServer.close();
    await assert.doesNotReject(() => gateways.notifyConfigChanged(peerId));
  });
});
