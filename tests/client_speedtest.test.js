'use strict';

// Speed test of the apps' diagnosis screen (docs/feature-client-diagnosis.md):
//   GET  /api/v1/client/speedtest            limits + viaTunnel
//   GET  /api/v1/client/speedtest/download   N bytes (clamped), no compression
//   POST /api/v1/client/speedtest/upload     counted, discarded; 413 above max
// Token only (session → 403 token_required), scope client/full-access,
// machine binding, rate limit per token (429 rate_limited + Retry-After).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const BASE = '/api/v1/client/speedtest';
const KiB = 1024;
const MiB = 1024 * KiB;

let app, agent, anna, adminId, tokens, speedtest;
const saved = {};

before(async () => {
  ({ app, agent } = await setup());
  tokens = require('../src/services/tokens');
  speedtest = require('../src/routes/api/client/speedtest');
  anna = H.makeUser('st-anna');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  Object.assign(saved, config.speedtest);
});
after(() => {
  Object.assign(config.speedtest, saved);
  teardown();
});

// Every test gets its own device: the limiter counts per token.
const device = (scopes = ['client']) => H.makeDevice(anna, { name: 'st-phone', scopes });

/** Collect a binary body (supertest only buffers known text types). */
function binary(res, cb) {
  const parts = [];
  res.on('data', (c) => parts.push(c));
  res.on('end', () => cb(null, Buffer.concat(parts)));
}
const download = (dev, query = '') => supertest(app).get(`${BASE}/download${query}`)
  .set('X-API-Token', dev.raw).buffer(true).parse(binary);
const upload = (dev, body, type = 'application/octet-stream') => {
  const r = supertest(app).post(`${BASE}/upload`).set('X-API-Token', dev.raw);
  if (type) r.set('Content-Type', type);
  return r.send(body);
};

describe('access', () => {
  it('401 without a token, 403 token_required for a browser session on every endpoint', async () => {
    await supertest(app).get(BASE).expect(401);
    for (const [method, p] of [['get', BASE], ['get', `${BASE}/download`]]) {
      const r = await agent[method](p).expect(403);
      assert.equal(r.body.error, 'token_required');
    }
    const r = await agent.post(`${BASE}/upload`).set('X-CSRF-Token', getCsrf())
      .set('Content-Type', 'application/octet-stream').send(Buffer.alloc(10)).expect(403);
    assert.equal(r.body.error, 'token_required');
  });

  it('tokens without the client scope are refused (read-only may GET almost anything — not this)', async () => {
    const ro = H.makeDevice(adminId, { name: 'st-ro', scopes: ['read-only'] });
    const r = await supertest(app).get(`${BASE}/download?bytes=65536`).set('X-API-Token', ro.raw).expect(403);
    assert.equal(r.body.error, 'scope_required');
    const full = H.makeDevice(adminId, { name: 'st-full', scopes: ['full-access'] });
    await supertest(app).get(BASE).set('X-API-Token', full.raw).expect(200);
  });

  it('enforces the machine binding', async () => {
    const m = mock.method(tokens, 'machineBindingState', () => ({ licensed: true, mode: 'global' }));
    const d = device();
    try {
      const fp = 'e'.repeat(64);
      tokens.bindMachineFingerprint(d.tokenId, fp);
      await supertest(app).get(BASE).set('X-API-Token', d.raw).expect(403);
      await supertest(app).get(BASE).set('X-API-Token', d.raw).set('X-Machine-Fingerprint', 'f'.repeat(64)).expect(403);
      await supertest(app).get(BASE).set('X-API-Token', d.raw).set('X-Machine-Fingerprint', fp).expect(200);
    } finally {
      m.mock.restore();
    }
  });
});

describe('GET /api/v1/client/speedtest', () => {
  it('answers the limits and whether the request came through the tunnel', async () => {
    const d = device();
    const direct = await supertest(app).get(BASE).set('X-API-Token', d.raw).expect(200);
    assert.deepEqual(Object.keys(direct.body).sort(), ['maxDownloadBytes', 'maxUploadBytes', 'ok', 'viaTunnel']);
    assert.equal(direct.body.ok, true);
    assert.equal(direct.body.maxDownloadBytes, 25 * MiB);
    assert.equal(direct.body.maxUploadBytes, 25 * MiB);
    assert.equal(direct.body.viaTunnel, false);
    assert.match(direct.headers['cache-control'], /no-store/);
    // req.ip comes from X-Forwarded-For (trust proxy loopback): a WireGuard address
    const tunnel = await supertest(app).get(BASE).set('X-API-Token', d.raw).set('X-Forwarded-For', d.ip).expect(200);
    assert.equal(tunnel.body.viaTunnel, true);
    const lan = await supertest(app).get(BASE).set('X-API-Token', d.raw).set('X-Forwarded-For', '192.168.1.20').expect(200);
    assert.equal(lan.body.viaTunnel, false);
  });

  it('follows the configured limits (never below 64 KiB)', async () => {
    const d = device();
    try {
      config.speedtest.maxDownloadBytes = 3 * MiB;
      config.speedtest.maxUploadBytes = 1;
      const r = await supertest(app).get(BASE).set('X-API-Token', d.raw).expect(200);
      assert.equal(r.body.maxDownloadBytes, 3 * MiB);
      assert.equal(r.body.maxUploadBytes, 64 * KiB);
    } finally {
      Object.assign(config.speedtest, saved);
    }
  });
});

describe('GET /api/v1/client/speedtest/download', () => {
  it('sends exactly the requested bytes, uncompressed and uncached', async () => {
    const d = device();
    const r = await download(d, '?bytes=300000').set('Accept-Encoding', 'gzip, br').expect(200);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.headers['content-length'], '300000');
    assert.equal(r.headers['content-encoding'], 'identity');
    assert.match(r.headers['cache-control'], /no-store/);
    assert.match(r.headers['cache-control'], /no-transform/);
    assert.equal(r.body.length, 300000);
    // incompressible: gzip gains (almost) nothing
    assert.ok(zlib.gzipSync(r.body).length > r.body.length * 0.99);
  });

  it('clamps to [64 KiB, max] and defaults to 10 MiB', async () => {
    const d = device();
    assert.equal(speedtest.downloadSize('1', 25 * MiB), 64 * KiB);
    assert.equal(speedtest.downloadSize('999999999999', 25 * MiB), 25 * MiB);
    assert.equal(speedtest.downloadSize(undefined, 25 * MiB), 10 * MiB);
    assert.equal(speedtest.downloadSize('abc', 25 * MiB), 10 * MiB);
    assert.equal(speedtest.downloadSize('-5', 25 * MiB), 10 * MiB);
    assert.equal(speedtest.downloadSize(['1', '2'], 25 * MiB), 10 * MiB);
    assert.equal(speedtest.downloadSize(undefined, 2 * MiB), 2 * MiB);
    const small = await download(d, '?bytes=10').expect(200);
    assert.equal(small.body.length, 64 * KiB);
    try {
      config.speedtest.maxDownloadBytes = 200 * KiB;
      const big = await download(d, '?bytes=99999999').expect(200);
      assert.equal(big.headers['content-length'], String(200 * KiB));
      assert.equal(big.body.length, 200 * KiB);
      const def = await download(d).expect(200);
      assert.equal(def.body.length, 200 * KiB);
    } finally {
      Object.assign(config.speedtest, saved);
    }
  });

  it('streams the 10 MiB default', async () => {
    const r = await download(device()).expect(200);
    assert.equal(r.headers['content-length'], String(10 * MiB));
    assert.equal(r.body.length, 10 * MiB);
  });
});

describe('POST /api/v1/client/speedtest/upload', () => {
  it('counts the body and answers bytes + serverMs', async () => {
    const d = device();
    const r = await upload(d, crypto.randomBytes(512 * KiB)).expect(200);
    assert.deepEqual(Object.keys(r.body).sort(), ['bytes', 'ok', 'serverMs']);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.bytes, 512 * KiB);
    assert.ok(Number.isInteger(r.body.serverMs) && r.body.serverMs >= 0);
    const empty = await upload(d, Buffer.alloc(0)).expect(200);
    assert.equal(empty.body.bytes, 0);
  });

  it('413 too_large above the limit (declared or streamed)', async () => {
    const d = device();
    try {
      config.speedtest.maxUploadBytes = 64 * KiB;
      const r = await upload(d, Buffer.alloc(64 * KiB + 1));
      assert.equal(r.status, 413);
      assert.deepEqual(r.body, { ok: false, error: 'too_large' });
      const ok = await upload(d, Buffer.alloc(64 * KiB)).expect(200);
      assert.equal(ok.body.bytes, 64 * KiB);
    } finally {
      Object.assign(config.speedtest, saved);
    }
  });

  it('415 for another content type (a JSON body is never a speed test)', async () => {
    const r = await upload(device(), JSON.stringify({ a: 1 }), 'application/json');
    assert.equal(r.status, 415);
    assert.equal(r.body.error, 'unsupported_media_type');
  });
});

describe('rate limit', () => {
  it('30 requests per token and 10 minutes, then 429 rate_limited with Retry-After; other tokens unaffected', async () => {
    const d = device();
    let last;
    for (let i = 0; i < 31; i++) last = await supertest(app).get(BASE).set('X-API-Token', d.raw);
    assert.equal(last.status, 429);
    assert.deepEqual(last.body, { ok: false, error: 'rate_limited' });
    assert.ok(Number(last.headers['retry-after']) > 0);
    const dl = await supertest(app).get(`${BASE}/download?bytes=65536`).set('X-API-Token', d.raw);
    assert.equal(dl.status, 429);
    await supertest(app).get(BASE).set('X-API-Token', device().raw).expect(200);
  });

  it('the limiter sits in front of every handler (static)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/api/client/speedtest.js'), 'utf8');
    const routes = Array.from(src.matchAll(/router\.(get|post)\('([^']+)',\s*([A-Za-z]+)/g));
    assert.equal(routes.length, 3);
    for (const m of routes) assert.equal(m[3], 'speedtestLimiter', m[2]);
    assert.doesNotMatch(src, /activity\.log/);
  });
});
