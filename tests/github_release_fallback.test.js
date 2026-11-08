'use strict';

// github.com's release download path degraded (8 Nov 2026: …/releases/download/…
// answered 504 after ~11 s, the API at once): the plugin catalogue, the
// catalogue packages and the update manifests of the Windows clients take the
// API route (api.github.com/…/releases/tags/<tag> → asset id →
// …/releases/assets/<id>, Accept: application/octet-stream → 302 to the asset
// CDN). A fake GitHub answers: 504 → fallback, no answer → fallback in time,
// the rate limit (403, x-ratelimit-remaining 0) → no further API request,
// ETag/If-None-Match, a replaced asset (404 → looked up again), 404 → no
// fallback, foreign hosts refused, a custom catalogue URL never on the API way.

require('./helpers/test-env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const supertest = require('supertest');

const gh = require('../src/utils/githubRelease');
const catalog = require('../src/services/plugins/catalog');
const updateRouter = require('../src/routes/api/client/update');

const API = 'https://api.github.com/repos/CallMeTechie/gatecontrol-plugins';
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The host name of a requested URL (compared exactly, never as a substring). */
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };
const asked = (host) => seen.some((s) => hostOf(s.url) === host);

// ─── Fake GitHub ────────────────────────────────
// routes: url → { status, headers, body } | { hang: true } (no answer until the caller gives up)
let routes;
let seen; // [{ url, headers }]

function answer(url, headers) {
  seen.push({ url, headers: { ...(headers || {}) } });
  const r = routes.get(url);
  if (!r) return { status: 404, headers: {} };
  return typeof r === 'function' ? r(headers || {}) : r;
}

/** The catalogue's transport: one GET, no redirects followed. */
function catalogTransport(url, { headers, headerMs, deadline }) {
  const r = answer(url, headers);
  if (r.hang) {
    const wait = Math.min(headerMs || Infinity, deadline - Date.now());
    return new Promise((_res, rej) => setTimeout(() => rej(new catalog.CatalogError('catalog_timeout', 'no answer')), Math.max(0, wait)));
  }
  return Promise.resolve({ status: r.status, headers: r.headers || {}, location: (r.headers && r.headers.location) || null, body: r.body == null ? null : Buffer.from(r.body) });
}

/** https.get as the client update routes use it. */
const realGet = https.get;
function fakeHttpsGet(url, opts, cb) {
  const req = new EventEmitter();
  req.destroy = (err) => { if (err) req.emit('error', err); };
  setImmediate(() => {
    const r = answer(String(url), opts && opts.headers);
    if (r.hang) return; // the caller's timeout ends it
    const res = new PassThrough();
    res.statusCode = r.status || 200;
    res.headers = r.headers || {};
    cb(res);
    res.end(r.body == null ? '' : r.body);
  });
  return req;
}

const CATALOG_DOC = JSON.stringify({ schema: 1, generated_at: '2026-11-08T00:00:00Z', plugins: {} });

function release(assets, etag = '"r1"') {
  return (headers) => (headers['If-None-Match'] === etag
    ? { status: 304, headers: { etag } }
    : { status: 200, headers: { etag, 'x-ratelimit-remaining': '59' }, body: JSON.stringify({ tag_name: 'catalog', assets }) });
}

function serveApiCatalog(id = 7) {
  routes.set(`${API}/releases/tags/catalog`, release([{ id, name: 'catalog.json', size: CATALOG_DOC.length }]));
  routes.set(`${API}/releases/assets/${id}`, { status: 302, headers: { location: `${CDN}/${id}?sig=x` } });
  routes.set(`${CDN}/${id}?sig=x`, { status: 200, body: CATALOG_DOC });
}

beforeEach(() => {
  routes = new Map();
  seen = [];
  catalog._reset();
  catalog._setTransport(catalogTransport);
  delete process.env.GC_PLUGIN_CATALOG_URL;
});
afterEach(() => { catalog._reset(); delete process.env.GC_PLUGIN_CATALOG_URL; });

describe('utils/githubRelease', () => {
  it('knows only github.com release downloads and API asset URLs', () => {
    assert.deepEqual(gh.parseDownloadUrl(catalog.DEFAULT_URL), { owner: 'CallMeTechie', repo: 'gatecontrol-plugins', tag: 'catalog', name: 'catalog.json' });
    assert.deepEqual(gh.parseDownloadUrl('https://github.com/o/r/releases/download/v1.2.3/a%20b.zip'), { owner: 'o', repo: 'r', tag: 'v1.2.3', name: 'a b.zip' });
    for (const u of ['http://github.com/o/r/releases/download/t/n', 'https://example.com/o/r/releases/download/t/n',
      'https://github.com/o/r/releases/tag/t', 'https://github.com/o/r/releases/download/t/n?x=1', 'https://u:p@github.com/o/r/releases/download/t/n',
      'https://github.com/o/r/releases/download/t/a%2Fb', 'not a url']) {
      assert.equal(gh.parseDownloadUrl(u), null, u);
    }
    assert.deepEqual(gh.parseAssetApiUrl('https://api.github.com/repos/o/r/releases/assets/12'), { owner: 'o', repo: 'r', id: '12' });
    assert.equal(gh.parseAssetApiUrl('https://api.github.com/repos/o/r/releases/assets/12/../x'), null);
    assert.equal(gh.parseAssetApiUrl('https://evil.example/repos/o/r/releases/assets/12'), null);
  });

  it('a 403 with x-ratelimit-remaining 0 stops API requests until the reset (at most an hour)', () => {
    gh._resetForTest();
    const now = Date.now();
    assert.equal(gh.noteRateLimit(403, { 'x-ratelimit-remaining': '3' }, now), false, 'an ordinary 403');
    assert.equal(gh.rateLimited(now), false);
    assert.equal(gh.noteRateLimit(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 600) }, now), true);
    assert.equal(gh.rateLimited(now + 1000), true);
    assert.equal(gh.rateLimited(now + 601000), false);
    gh.noteRateLimit(429, { 'retry-after': '99999' }, now);
    assert.ok(gh.rateLimitedUntil() <= now + 3600 * 1000 + 5);
    gh._resetForTest();
  });
});

describe('plugin catalogue: the API route when github.com fails', () => {
  it('504 → fetched over the API (release → asset → CDN); the asset id is kept, the release asked with If-None-Match', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 504 });
    serveApiCatalog();
    const cat = await catalog.get();
    assert.equal(cat.generatedAt, '2026-11-08T00:00:00Z');
    assert.deepEqual(seen.map((s) => s.url), [catalog.DEFAULT_URL, `${API}/releases/tags/catalog`, `${API}/releases/assets/7`, `${CDN}/7?sig=x`]);
    assert.equal(seen[2].headers.Accept, 'application/octet-stream');
    assert.equal(seen[3].headers && seen[3].headers.Accept, undefined, 'the CDN gets no API headers');
    // the next load: the API way first (download path failed a moment ago), asset id from memory
    seen = [];
    await catalog.get({ refresh: true });
    assert.deepEqual(seen.map((s) => s.url), [`${API}/releases/assets/7`, `${CDN}/7?sig=x`]);
  });

  it('a replaced asset (rolling release: 404 on the old id) is looked up again with If-None-Match', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 502 });
    serveApiCatalog(7);
    await catalog.get();
    // the catalogue was published again: new asset id, new ETag
    routes.delete(`${API}/releases/assets/7`);
    routes.set(`${API}/releases/tags/catalog`, (headers) => {
      assert.equal(headers['If-None-Match'], '"r1"');
      return { status: 200, headers: { etag: '"r2"' }, body: JSON.stringify({ assets: [{ id: 8, name: 'catalog.json', size: CATALOG_DOC.length }] }) };
    });
    routes.set(`${API}/releases/assets/8`, { status: 302, headers: { location: `${CDN}/8?sig=x` } });
    routes.set(`${CDN}/8?sig=x`, { status: 200, body: CATALOG_DOC });
    seen = [];
    assert.ok(await catalog.get({ refresh: true }));
    assert.deepEqual(seen.map((s) => s.url), [`${API}/releases/assets/7`, `${API}/releases/tags/catalog`, `${API}/releases/assets/8`, `${CDN}/8?sig=x`]);
  });

  it('no answer in time → the API route; the whole fetch stays far below 11 s', async () => {
    const old = catalog.TIMEOUTS.catalogHeaders;
    catalog.TIMEOUTS.catalogHeaders = 300;
    try {
      routes.set(catalog.DEFAULT_URL, { hang: true });
      serveApiCatalog();
      const t = Date.now();
      assert.ok(await catalog.get());
      const ms = Date.now() - t;
      assert.ok(ms >= 280 && ms < 2000, `${ms} ms`);
    } finally { catalog.TIMEOUTS.catalogHeaders = old; }
  });

  it('the rate limit: 403 with x-ratelimit-remaining 0 → the download error, and no API request until the reset', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 504 });
    routes.set(`${API}/releases/tags/catalog`, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) } });
    await assert.rejects(catalog.get(), (e) => e.code === 'catalog_unreachable' && /504/.test(e.message) && e.viaApi === 'rate_limited');
    assert.equal(gh.rateLimited(), true);
    seen = [];
    await assert.rejects(catalog.get({ refresh: true }), (e) => e.code === 'catalog_unreachable');
    assert.ok(!asked('api.github.com'), JSON.stringify(seen.map((s) => s.url)));
  });

  it('a 404 of the download path is no reason for the API route', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 404 });
    serveApiCatalog();
    await assert.rejects(catalog.get(), (e) => e.code === 'catalog_unreachable' && e.message === 'HTTP 404');
    assert.deepEqual(seen.map((s) => s.url), [catalog.DEFAULT_URL]);
  });

  it('the API route keeps the allow-list: a redirect to a foreign host is refused, the host never asked', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 504 });
    routes.set(`${API}/releases/tags/catalog`, release([{ id: 9, name: 'catalog.json', size: 10 }]));
    routes.set(`${API}/releases/assets/9`, { status: 302, headers: { location: 'https://evil.example/catalog.json' } });
    await assert.rejects(catalog.get(), (e) => e.code === 'catalog_redirect');
    assert.ok(!asked('evil.example'));
  });

  it('the size cap of the catalogue holds on the API route (the release says how big)', async () => {
    routes.set(catalog.DEFAULT_URL, { status: 504 });
    routes.set(`${API}/releases/tags/catalog`, release([{ id: 10, name: 'catalog.json', size: 3 * 1024 * 1024 }]));
    await assert.rejects(catalog.get(), (e) => e.code === 'catalog_too_large');
  });

  it('a custom GC_PLUGIN_CATALOG_URL never takes the API route', async () => {
    process.env.GC_PLUGIN_CATALOG_URL = 'https://plugins.example.com/catalog.json';
    routes.set('https://plugins.example.com/catalog.json', { status: 504 });
    serveApiCatalog();
    await assert.rejects(catalog.get(), (e) => e.code === 'catalog_unreachable' && e.message === 'HTTP 504');
    assert.deepEqual(seen.map((s) => s.url), ['https://plugins.example.com/catalog.json']);
    assert.equal(catalog.allowedHosts().has('api.github.com'), false, 'the API host is no catalogue host');
  });

  it('a package download takes the same way and is still checked against the catalogue sha256', async () => {
    const crypto = require('node:crypto');
    const pkg = Buffer.from('package bytes '.repeat(10));
    const sha = crypto.createHash('sha256').update(pkg).digest('hex');
    const url = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases/download/demo-v1.0.0/demo-1.0.0.gcplugin';
    const doc = { schema: 1, plugins: { 'gatecontrol-demo': { id: 'gatecontrol-demo', name: 'Demo', publisher: 'x', versions: [{
      schema: 1, id: 'gatecontrol-demo', version: '1.0.0', prerelease: false, gatecontrol: '>=1.0.0', license_required: false, size: pkg.length, sha256: sha, url,
    }] } } };
    routes.set(catalog.DEFAULT_URL, { status: 200, body: JSON.stringify(doc) });
    routes.set(url, { status: 503 });
    routes.set(`${API}/releases/tags/demo-v1.0.0`, release([{ id: 21, name: 'demo-1.0.0.gcplugin', size: pkg.length }]));
    routes.set(`${API}/releases/assets/21`, { status: 302, headers: { location: `${CDN}/21` } });
    routes.set(`${CDN}/21`, { status: 200, body: pkg });
    const r = await catalog.download('gatecontrol-demo', '1.0.0', '1.253.1');
    assert.ok(r.buf.equals(pkg));
    // other bytes on the API way: the checksum refuses them
    catalog._reset();
    catalog._setTransport(catalogTransport);
    routes.set(`${CDN}/21`, { status: 200, body: Buffer.from('x'.repeat(pkg.length)) });
    await assert.rejects(catalog.download('gatecontrol-demo', '1.0.0', '1.253.1'), (e) => e.code === 'catalog_hash_mismatch');
  });
});

describe('client update manifests: the API route when github.com fails', () => {
  const app = express();
  app.use('/api/v1/client/update', updateRouter);
  const REPO = 'https://api.github.com/repos/CallMeTechie/GateControl-Pro-Client';
  const DL = 'https://github.com/CallMeTechie/GateControl-Pro-Client/releases/download/v1.22.0';
  const MANIFEST = '{"schema":1,"product":"pro","version":"1.22.0","fileName":"GateControl.Pro.Client.Setup.1.22.0.exe"}';
  const SIG = 'c2ln' + 'A'.repeat(80) + '==';
  const rel = {
    id: 5, tag_name: 'v1.22.0', body: 'notes', assets: [
      { id: 2, name: 'GateControl.Pro.Client.Setup.1.22.0.exe', size: 10, url: `${REPO}/releases/assets/2`, browser_download_url: `${DL}/GateControl.Pro.Client.Setup.1.22.0.exe` },
      { id: 3, name: 'update-manifest.json', size: MANIFEST.length, url: `${REPO}/releases/assets/3`, browser_download_url: `${DL}/update-manifest.json` },
      { id: 4, name: 'update-manifest.json.sig', size: SIG.length, url: `${REPO}/releases/assets/4`, browser_download_url: `${DL}/update-manifest.json.sig` },
    ],
  };
  const check = () => supertest(app).get('/api/v1/client/update/check?version=1.21.1&platform=windows&client=pro');

  beforeEach(() => { updateRouter._resetCache(); https.get = fakeHttpsGet; delete process.env.GC_CLIENT_GITHUB_TOKEN; });
  afterEach(() => { https.get = realGet; updateRouter._resetCache(); });

  function apiAssets() {
    routes.set(`${REPO}/releases/assets/3`, { status: 302, headers: { location: 'https://objects.githubusercontent.com/m3' } });
    routes.set('https://objects.githubusercontent.com/m3', { status: 200, body: MANIFEST });
    routes.set(`${REPO}/releases/assets/4`, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/s4' } });
    routes.set('https://release-assets.githubusercontent.com/s4', { status: 200, body: SIG });
  }

  it('504 on the browser download → manifest and signature over the API, byte for byte', async () => {
    routes.set(`${REPO}/releases/latest`, { status: 200, headers: { etag: '"l1"' }, body: JSON.stringify(rel) });
    routes.set(`${DL}/update-manifest.json`, { status: 504 });
    routes.set(`${DL}/update-manifest.json.sig`, { status: 504 });
    apiAssets();
    const r = await check().expect(200);
    assert.equal(r.body.manifest, MANIFEST);
    assert.equal(r.body.signature, SIG);
    const api = seen.find((s) => s.url === `${REPO}/releases/assets/3`);
    assert.equal(api.headers.Accept, 'application/octet-stream');
    assert.equal(api.headers.Authorization, undefined);
  });

  it('no answer from the browser download → the API route within a few seconds', async () => {
    routes.set(`${REPO}/releases/latest`, { status: 200, body: JSON.stringify(rel) });
    routes.set(`${DL}/update-manifest.json`, { hang: true });
    routes.set(`${DL}/update-manifest.json.sig`, { hang: true });
    apiAssets();
    const t = Date.now();
    const r = await check().expect(200);
    assert.equal(r.body.manifest, MANIFEST);
    assert.ok(Date.now() - t < 8000, `${Date.now() - t} ms`);
  });

  it('releases/latest with If-None-Match (304 keeps the release); the rate limit keeps the last release without asking', async () => {
    routes.set(`${REPO}/releases/latest`, { status: 200, headers: { etag: '"l1"' }, body: JSON.stringify(rel) });
    routes.set(`${DL}/update-manifest.json`, { status: 200, body: MANIFEST });
    routes.set(`${DL}/update-manifest.json.sig`, { status: 200, body: SIG });
    assert.equal((await check().expect(200)).body.version, '1.22.0');
    // the release cache (2 min) runs out: a conditional request
    updateRouter._expireReleasesForTest();
    routes.set(`${REPO}/releases/latest`, (headers) => (headers['If-None-Match'] === '"l1"' ? { status: 304, headers: { etag: '"l1"' } } : { status: 500 }));
    assert.equal((await check().expect(200)).body.version, '1.22.0');
    // the limit is used up: the last release, and no further request to the API
    updateRouter._expireReleasesForTest();
    routes.set(`${REPO}/releases/latest`, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 900) } });
    assert.equal((await check().expect(200)).body.version, '1.22.0');
    updateRouter._expireReleasesForTest();
    seen = [];
    assert.equal((await check().expect(200)).body.version, '1.22.0');
    assert.ok(!asked('api.github.com'), JSON.stringify(seen.map((s) => s.url)));
  });

  it('a redirect off GitHub\'s hosts is never followed', async () => {
    routes.set(`${REPO}/releases/latest`, { status: 200, body: JSON.stringify(rel) });
    routes.set(`${DL}/update-manifest.json`, { status: 302, headers: { location: 'https://evil.example/m' } });
    routes.set(`${DL}/update-manifest.json.sig`, { status: 200, body: SIG });
    const r = await check().expect(200);
    assert.equal(r.body.manifest, undefined, 'no manifest without both files');
    assert.ok(!asked('evil.example'));
    await sleep(0);
  });
});

describe('home cache installers: the API route when github.com fails', () => {
  beforeEach(() => { https.get = fakeHttpsGet; gh._resetForTest(); });
  afterEach(() => { https.get = realGet; gh._resetForTest(); });

  it('504 on the browser download → the installer over the API, hashed on the way', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const hc = require('../src/services/homeCache');
    const body = 'installer bytes';
    const asset = { id: 31, name: 'app.apk', size: body.length,
      url: 'https://api.github.com/repos/CallMeTechie/GateControl-Android-Client/releases/assets/31',
      browser_download_url: 'https://github.com/CallMeTechie/GateControl-Android-Client/releases/download/v1.0.0/app.apk' };
    routes.set(asset.browser_download_url, { status: 504 });
    routes.set(asset.url, { status: 302, headers: { location: 'https://objects.githubusercontent.com/apk' } });
    routes.set('https://objects.githubusercontent.com/apk', { status: 200, body });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ghfb-'));
    try {
      const got = await hc._downloadWithFallback(asset, path.join(dir, 'x'), '');
      assert.equal(got.sha256, crypto.createHash('sha256').update(body).digest('hex'));
      assert.equal(fs.readFileSync(path.join(dir, 'x'), 'utf8'), body);
      // a 404 stays a 404
      routes.set(asset.browser_download_url, { status: 404 });
      seen = [];
      await assert.rejects(hc._downloadWithFallback(asset, path.join(dir, 'y'), ''), /http 404/);
      assert.deepEqual(seen.map((s) => s.url), [asset.browser_download_url]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
