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

describe('gateway API: /status and /probe', () => {
  let server, apiToken, baseUrl;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gws-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'st-gw', apiPort: 9876 });
    apiToken = gw.apiToken;
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  async function postJson(p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + p);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
  }

  it('POST /status accepts traffic counters', async () => {
    const r = await postJson('/api/v1/gateway/status',
      { rx_bytes: 1000, tx_bytes: 2000, active_connections: 5 },
      { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
  });

  it('POST /probe returns 200 with probe metadata', async () => {
    const r = await postJson('/api/v1/gateway/probe',
      { probe_target: '192.168.1.1', probe_port: 53 },
      { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok('server_timestamp' in body);
  });
});
