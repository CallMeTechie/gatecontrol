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

describe('gateway API: /config + /config/check', () => {
  let app, server, gateways, apiToken, baseUrl;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwapi-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'api-gw', apiPort: 9876 });
    apiToken = gw.apiToken;

    const { createApp } = require('../src/app');
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => { server && server.close(); });

  async function req(pathStr, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + pathStr);
      http.get({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
  }

  it('GET /api/v1/gateway/config returns 401 without auth', async () => {
    const r = await req('/api/v1/gateway/config');
    assert.equal(r.status, 401);
  });

  it('GET /api/v1/gateway/config returns 200 with config + hash', async () => {
    const r = await req('/api/v1/gateway/config', { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.config_hash_version, 1);
    assert.ok(body.peer_id);
    assert.ok(Array.isArray(body.routes));
    assert.match(body.config_hash, /^sha256:[0-9a-f]{64}$/);
  });

  it('GET /api/v1/gateway/config/check?hash=<match> returns 304', async () => {
    const first = await req('/api/v1/gateway/config', { Authorization: `Bearer ${apiToken}` });
    const hash = JSON.parse(first.body).config_hash;
    const r = await req('/api/v1/gateway/config/check?hash=' + encodeURIComponent(hash), { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 304);
  });

  it('GET /api/v1/gateway/config/check?hash=<mismatch> returns 200', async () => {
    const r = await req('/api/v1/gateway/config/check?hash=sha256:' + 'f'.repeat(64), { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
  });
});
