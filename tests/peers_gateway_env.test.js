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

describe('POST /api/v1/peers/:id/gateway-env/rotate', () => {
  let server, baseUrl, gwPeerId, adminToken;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-env-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/services/tokens', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const gateways = require('../src/services/gateways');
    const tokens = require('../src/services/tokens');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10, api_tokens: true });

    const gw = await gateways.createGateway({ name: 'env-gw', apiPort: 9876 });
    gwPeerId = gw.peer.id;
    const t = tokens.create({ name: 'admin', scopes: ['full-access'] }, '127.0.0.1');
    adminToken = t.rawToken;
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  async function postJson(p, body, headers = {}) {
    return new Promise(resolve => {
      const url = new URL(baseUrl + p);
      const payload = JSON.stringify(body);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      }, (r) => {
        let b = ''; r.on('data', c => b += c);
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.end(payload);
    });
  }

  it('returns gateway.env content on POST rotate', async () => {
    const r = await postJson(`/api/v1/peers/${gwPeerId}/gateway-env/rotate`, {}, { Authorization: `Bearer ${adminToken}` });
    assert.equal(r.status, 200);
    assert.match(r.body, /GC_SERVER_URL=/);
    assert.match(r.body, /GC_API_TOKEN=gc_gw_[a-f0-9]{64}/);
    assert.match(r.body, /GC_GATEWAY_TOKEN=[a-f0-9]{64}/);
    assert.match(r.body, /GC_TUNNEL_IP=/);
  });

  it('returns 404 on non-gateway peer', async () => {
    const db = require('../src/db/connection').getDb();
    const regularPeerId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, peer_type) VALUES ('regular', 'krg', '10.8.0.77/32', 'regular')").run().lastInsertRowid;
    const r = await postJson(`/api/v1/peers/${regularPeerId}/gateway-env/rotate`, {}, { Authorization: `Bearer ${adminToken}` });
    assert.equal(r.status, 404);
  });
});
