'use strict';
// Regression: since Drive 1.24 a gateway's home cache fetches hundreds of
// small previews per sync (GET /cache/blob/<sha256>, one request each). They
// used to count against the one per-gateway budget (GC_RATE_LIMIT_GATEWAY,
// 300 / 15 min) → heartbeat and config poll got 429 → the server declared the
// gateway offline (pool failover). Cache and file transfers now have their own
// budgets; heartbeat/config never starve.
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const config = require('../config/default');
const gateways = require('../src/services/gateways');
const { gatewayBudget } = require('../src/middleware/rateLimit');

let app;
const homeCache = require('../src/services/homeCache');
const print = require('../src/services/homePrint');
const orig = { sendBlob: homeCache.sendBlob, want: homeCache.want, ocrPage: print.ocrPage };

test.before(async () => {
  ({ app } = await setup());
  require('../src/services/license')._overrideForTest({ gateway_peers: -1 });
  // Successful answers without a real stock (failed requests do not count anyway).
  homeCache.sendBlob = async (_peer, _sha, _req, res) => { res.type('application/octet-stream').end(Buffer.from('x')); };
  homeCache.want = () => ({ etag: '"w1"', maxBytes: 1, items: [] });
  print.ocrPage = async (_peer, _id, _n, res) => { res.type('image/png').end(Buffer.from('p')); };
});
test.after(() => { Object.assign(homeCache, { sendBlob: orig.sendBlob, want: orig.want }); print.ocrPage = orig.ocrPage; teardown(); });

const gw = (g, method, p) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', `Bearer ${g.apiToken}`);
const heartbeat = (g) => gw(g, 'get', '/config/check?hash=sha256:stale');
const blob = (g, i) => gw(g, 'get', '/cache/blob/' + i.toString(16).padStart(64, '0'));

test('budget classes: cache, bulk transfers, everything else', () => {
  const b = (p) => gatewayBudget({ path: p });
  assert.equal(b('/cache/want'), 'cache');
  assert.equal(b('/cache/blob/' + 'a'.repeat(64)), 'cache');
  assert.equal(b('/cache'), 'cache');
  for (const p of ['/print/jobs/j1/file', '/print/scans/s1/pages/2', '/print/ocr/o1/pages/1', '/print/ocr/o1/document', '/print/ocr/o1/text',
    '/edge/packages/demo/1.0.0', '/speedtest/down', '/speedtest/up', '/cameras/events']) assert.equal(b(p), 'bulk', p);
  for (const p of ['/heartbeat', '/config', '/config/check', '/status', '/probe', '/print/ocr/o1', '/print/jobs', '/print/scans/s1', '/cameras/report', '/cache/blob', '/cachex', '/netwatch'])
    assert.equal(b(p), 'api', p);
});

test('many blob downloads do not starve heartbeat / config poll', async () => {
  const g = await gateways.createGateway({ name: 'gw-cache-heavy' });
  config.auth.rateLimitGateway = 3;
  config.auth.rateLimitGatewayCache = 100000;
  try {
    for (let i = 0; i < 40; i++) assert.equal((await blob(g, i + 1)).status, 200, `blob ${i}`);
    assert.equal((await gw(g, 'get', '/cache/want')).status, 200);
    for (let i = 0; i < 3; i++) {
      const r = await heartbeat(g);
      assert.equal(r.status, 200, `heartbeat ${i} after 40 blobs must be 200, got ${r.status}`);
      assert.equal(r.headers['ratelimit-limit'], '3', 'heartbeat carries the API budget headers');
    }
    // the API budget itself still works
    assert.equal((await heartbeat(g)).status, 429);
    assert.equal((await blob(g, 99)).status, 200, 'an exhausted API budget does not block the cache either');
  } finally {
    config.auth.rateLimitGateway = 100000;
  }
});

test('the cache budget is per gateway, has its own headers and Retry-After', async () => {
  const a = await gateways.createGateway({ name: 'gw-cache-a' });
  const b = await gateways.createGateway({ name: 'gw-cache-b' });
  config.auth.rateLimitGatewayCache = 3;
  try {
    const st = [];
    for (let i = 0; i < 5; i++) st.push((await blob(a, i + 1)).status);
    assert.deepEqual(st, [200, 200, 200, 429, 429]);
    const r = await blob(a, 9);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) > 0, 'Retry-After on 429');
    assert.equal(r.headers['ratelimit-limit'], '3');
    assert.equal(r.body.ok, false);
    assert.equal((await gw(a, 'post', '/cache').send({})).status, 429, 'stock report shares the cache budget');
    assert.equal((await heartbeat(a)).status, 200, 'heartbeat unaffected by an exhausted cache budget');
    assert.equal((await blob(b, 1)).status, 200, 'gateway B keeps its own cache budget');
  } finally {
    config.auth.rateLimitGatewayCache = 100000;
  }
});

test('file transfers (OCR pages) have their own budget too', async () => {
  const g = await gateways.createGateway({ name: 'gw-bulk' });
  config.auth.rateLimitGateway = 2;
  config.auth.rateLimitGatewayBulk = 2;
  try {
    const st = [];
    for (let i = 0; i < 3; i++) st.push((await gw(g, 'get', `/print/ocr/ocr-${i}/pages/1`)).status);
    assert.deepEqual(st, [200, 200, 429]);
    assert.equal((await heartbeat(g)).status, 200);
    assert.equal((await heartbeat(g)).status, 200);
    assert.equal((await heartbeat(g)).status, 429);
  } finally {
    config.auth.rateLimitGateway = 100000;
    config.auth.rateLimitGatewayBulk = 100000;
  }
});
