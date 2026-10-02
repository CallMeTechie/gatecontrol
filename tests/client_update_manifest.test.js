'use strict';

// Signed update manifests for the Windows clients: /api/v1/client/update/check
// passes update-manifest.json and its .sig through byte for byte, picks the
// installer named in the manifest and leaves Android and unsigned releases as
// before. GitHub is simulated by replacing https.get.

require('./helpers/test-env');
process.env.GC_BASE_URL = process.env.GC_BASE_URL || 'http://localhost:3000';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const supertest = require('supertest');

const updateRouter = require('../src/routes/api/client/update');

const app = express();
app.use('/api/v1/client/update', updateRouter);

// Exact bytes incl. key order/whitespace — must survive untouched.
const MANIFEST = '{"schema":1,"product":"pro","version":"1.22.0","fileName":"GateControl.Pro.Client.Setup.1.22.0.exe","sha256":"' + 'ab'.repeat(32) + '","size":1234}';
const SIGNATURE = 'c2lnbmF0dXJlLWJ5dGVz' + 'A'.repeat(64) + '==';

function release(extraAssets = [], { withSigned = true, tag = 'v1.22.0' } = {}) {
  const base = 'https://github.com/CallMeTechie/GateControl-Pro-Client/releases/download/' + tag;
  const assets = [
    { id: 1, name: 'GateControl.Pro.Client.Setup.1.21.9.exe', size: 11, url: 'https://api.github.com/repos/x/releases/assets/1', browser_download_url: `${base}/old-Setup.exe` },
    { id: 2, name: 'GateControl.Pro.Client.Setup.1.22.0.exe', size: 1234, url: 'https://api.github.com/repos/x/releases/assets/2', browser_download_url: `${base}/GateControl.Pro.Client.Setup.1.22.0.exe` },
    ...extraAssets,
  ];
  if (withSigned) {
    assets.push(
      { id: 3, name: 'update-manifest.json', size: MANIFEST.length, url: 'https://api.github.com/repos/x/releases/assets/3', browser_download_url: `${base}/update-manifest.json` },
      { id: 4, name: 'update-manifest.json.sig', size: SIGNATURE.length, url: 'https://api.github.com/repos/x/releases/assets/4', browser_download_url: `${base}/update-manifest.json.sig` },
    );
  }
  return { id: 99, tag_name: tag, body: 'notes', assets };
}

let routes;     // url -> { status, body, headers }
let requests;   // [{ url, headers }]
const realGet = https.get;

function fakeGet(url, opts, cb) {
  const target = String(url);
  requests.push({ url: target, headers: { ...(opts && opts.headers) } });
  const req = new EventEmitter();
  req.destroy = (err) => { if (err) req.emit('error', err); };
  setImmediate(() => {
    const route = routes[target];
    if (!route) return req.emit('error', new Error(`unexpected request ${target}`));
    const res = new PassThrough();
    res.statusCode = route.status || 200;
    res.headers = route.headers || {};
    cb(res);
    res.end(route.body === undefined ? '' : route.body);
  });
  return req;
}

function githubLatest(rel, repo = 'CallMeTechie/GateControl-Pro-Client') {
  routes[`https://api.github.com/repos/${repo}/releases/latest`] = { body: JSON.stringify(rel) };
}

beforeEach(() => {
  updateRouter._resetCache();
  delete process.env.GC_CLIENT_GITHUB_TOKEN;
  routes = {};
  requests = [];
  https.get = fakeGet;
});

afterEach(() => {
  https.get = realGet;
  delete process.env.GC_CLIENT_GITHUB_TOKEN;
});

const check = (q = 'version=1.21.1&platform=windows&client=pro') =>
  supertest(app).get(`/api/v1/client/update/check?${q}`);

describe('update check: signed manifests', () => {
  it('passes manifest and signature through unchanged and picks the named installer', async () => {
    const rel = release();
    githubLatest(rel);
    // public repo: GitHub redirects the browser download to storage
    routes[rel.assets[2].browser_download_url] = { status: 302, headers: { location: 'https://objects.githubusercontent.com/m' } };
    routes['https://objects.githubusercontent.com/m'] = { body: MANIFEST };
    routes[rel.assets[3].browser_download_url] = { body: SIGNATURE };

    const res = await check();
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.equal(res.body.version, '1.22.0');
    assert.equal(res.body.manifest, MANIFEST);
    assert.equal(res.body.signature, SIGNATURE);
    assert.equal(res.body.fileName, 'GateControl.Pro.Client.Setup.1.22.0.exe');
    assert.equal(res.body.fileSize, 1234);
    assert.equal(res.body.downloadUrl, rel.assets[1].browser_download_url);
    // no token configured -> never an Authorization header
    assert.ok(requests.every(r => !r.headers.Authorization));

    // cached with the release: a second check fetches nothing new
    const before = requests.length;
    const again = await check();
    assert.equal(again.body.manifest, MANIFEST);
    assert.equal(requests.length, before);
  });

  it('private repo: fetches assets via the API with the token, drops it on the storage redirect', async () => {
    process.env.GC_CLIENT_GITHUB_TOKEN = 'ghp_test';
    const rel = release();
    githubLatest(rel);
    routes[rel.assets[2].url] = { status: 302, headers: { location: 'https://objects.githubusercontent.com/signed-m' } };
    routes['https://objects.githubusercontent.com/signed-m'] = { body: MANIFEST };
    routes[rel.assets[3].url] = { body: SIGNATURE };

    const res = await check();
    assert.equal(res.body.manifest, MANIFEST);
    assert.equal(res.body.signature, SIGNATURE);
    assert.match(res.body.downloadUrl, /\/api\/v1\/client\/update\/download\?client=pro$/);

    const api = requests.find(r => r.url === rel.assets[2].url);
    assert.equal(api.headers.Authorization, 'Bearer ghp_test');
    assert.equal(api.headers.Accept, 'application/octet-stream');
    const storage = requests.find(r => r.url === 'https://objects.githubusercontent.com/signed-m');
    assert.equal(storage.headers.Authorization, undefined);
  });

  it('omits manifest fields for releases without signed assets (old releases)', async () => {
    githubLatest(release([], { withSigned: false }));
    const res = await check();
    assert.equal(res.body.available, true);
    assert.equal(res.body.manifest, undefined);
    assert.equal(res.body.signature, undefined);
    // old heuristic: first Setup exe
    assert.equal(res.body.fileName, 'GateControl.Pro.Client.Setup.1.21.9.exe');
  });

  it('omits manifest fields when an asset exceeds the size limit or fails', async () => {
    const rel = release();
    githubLatest(rel);
    routes[rel.assets[2].browser_download_url] = { body: 'x'.repeat(17 * 1024) };
    routes[rel.assets[3].browser_download_url] = { status: 404, body: 'nope' };
    const res = await check();
    assert.equal(res.body.available, true);
    assert.equal(res.body.manifest, undefined);
    assert.equal(res.body.signature, undefined);
  });

  it('does not touch manifests for Android', async () => {
    const rel = release([{ id: 5, name: 'gatecontrol-1.22.0.apk', size: 50, browser_download_url: 'https://github.com/a.apk' }]);
    githubLatest(rel, 'CallMeTechie/GateControl-Android-Client');
    const res = await check('version=1.0.0&platform=android');
    assert.equal(res.body.available, true);
    assert.equal(res.body.fileName, 'gatecontrol-1.22.0.apk');
    assert.equal(res.body.manifest, undefined);
    assert.ok(!requests.some(r => r.url.includes('update-manifest')));
  });

  it('reports no update when already current', async () => {
    githubLatest(release());
    const res = await check('version=1.22.0&platform=windows&client=pro');
    // channel/minVersion/mandatory are additive (old clients ignore them)
    assert.deepEqual(res.body, { ok: true, available: false, channel: 'stable', minVersion: null, mandatory: false });
  });
});
