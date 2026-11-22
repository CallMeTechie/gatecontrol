'use strict';

// GateControl TV ships in the same GitHub release as the Android app:
// /api/v1/client/update/check and /download pick the APK by name —
// GateControl-Android-<v>.apk for the phone, GateControl-TV-<v>.apk for the
// TV (client=android-tv or X-Client-Platform: android-tv). The phone never
// gets the TV APK, whatever the order of the assets; the TV never the phone APK.

require('./helpers/test-env');
process.env.GC_BASE_URL = process.env.GC_BASE_URL || 'http://localhost:3000';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const updateRouter = require('../src/routes/api/client/update');
const { pickInstallerAsset, resolveClientType } = updateRouter._internals;

const app = express();
app.use('/api/v1/client/update', updateRouter);

const BASE = 'https://github.com/CallMeTechie/GateControl-Android-Client/releases/download/v1.90.0';
const asset = (id, name) => ({ id, name, size: 100 + id, url: `https://api.github.com/repos/x/releases/assets/${id}`, browser_download_url: `${BASE}/${name}` });
const TV = asset(1, 'GateControl-TV-1.90.0.apk');
const PHONE = asset(2, 'GateControl-Android-1.90.0.apk');
const AAB = asset(3, 'GateControl-Android-1.90.0.aab');
const MAPPING = asset(4, 'GateControl-Android-1.90.0-apk-mapping.txt');

function setRelease(assets, tag = 'v1.90.0') {
  updateRouter._setReleaseForTest('android', 'stable', { id: 9, tag_name: tag, body: 'notes', assets });
}
const check = (q, headers = {}) => supertest(app).get(`/api/v1/client/update/check?${q}`).set(headers).expect(200);

beforeEach(() => {
  updateRouter._resetCache();
  delete process.env.GC_CLIENT_GITHUB_TOKEN;
});

describe('client type', () => {
  it('android-tv from the client parameter, X-Client-Type or the platform; the phone stays android', () => {
    const req = (query, headers = {}) => ({ query, headers });
    assert.equal(resolveClientType(req({ client: 'android-tv' })), 'android-tv');
    assert.equal(resolveClientType(req({ client: 'GateControl-TV' })), 'android-tv');
    assert.equal(resolveClientType(req({}, { 'x-client-type': 'android-tv' })), 'android-tv');
    assert.equal(resolveClientType(req({ platform: 'android-tv' })), 'android-tv');
    assert.equal(resolveClientType(req({}, { 'x-client-platform': 'android-tv' })), 'android-tv');
    // an explicit client wins over the platform
    assert.equal(resolveClientType(req({ client: 'android-tv', platform: 'android' })), 'android-tv');
    assert.equal(resolveClientType(req({ client: 'android', platform: 'android' })), 'android');
    assert.equal(resolveClientType(req({ client: 'gatecontrol', platform: 'android' })), 'android');
  });
});

describe('pickInstallerAsset', () => {
  it('the phone never gets a TV APK, whatever comes first', () => {
    for (const order of [[TV, PHONE, AAB], [PHONE, TV], [AAB, MAPPING, TV, PHONE]]) {
      assert.equal(pickInstallerAsset('android', { assets: order }).name, PHONE.name);
      assert.equal(pickInstallerAsset('android-tv', { assets: order }).name, TV.name);
    }
  });

  it('a release with only a TV APK has nothing for the phone; one without has nothing for the TV', () => {
    assert.equal(pickInstallerAsset('android', { assets: [TV, AAB] }), undefined);
    assert.equal(pickInstallerAsset('android-tv', { assets: [PHONE, AAB] }), undefined);
  });

  it('names: TV as a word of its own, debug builds never, old phone names still', () => {
    const names = (type, list) => pickInstallerAsset(type, { assets: list.map((n, i) => asset(10 + i, n)) });
    assert.equal(names('android-tv', ['app-tv-release.apk']).name, 'app-tv-release.apk');
    assert.equal(names('android-tv', ['GateControl-TV-1.90.0-debug.apk', 'gatecontrol_tv_1.90.0.APK']).name, 'gatecontrol_tv_1.90.0.APK');
    assert.equal(names('android', ['app-tv-release.apk', 'gatecontrol-1.22.0.apk']).name, 'gatecontrol-1.22.0.apk');
    assert.equal(names('android', ['GateControl-Android-1.90.0-debug.apk', 'GateControl-TV-1.90.0.apk']), undefined);
    // the phone's own name wins over another phone-looking APK
    assert.equal(names('android', ['other-1.90.0.apk', 'GateControl-Android-1.90.0.apk']).name, 'GateControl-Android-1.90.0.apk');
  });
});

describe('GET /check and /download', () => {
  it('TV APK listed first: the phone gets the phone APK, the TV the TV APK', async () => {
    setRelease([TV, PHONE, AAB]);
    const phone = await check('version=1.89.0&platform=android&client=android');
    assert.equal(phone.body.available, true);
    assert.equal(phone.body.fileName, PHONE.name);
    assert.equal(phone.body.downloadUrl, PHONE.browser_download_url);
    // the phone app of today (client=gatecontrol, platform android)
    const legacy = await check('version=1.89.0&platform=android&client=gatecontrol');
    assert.equal(legacy.body.fileName, PHONE.name);
    const tv = await check('version=1.89.0&client=android-tv');
    assert.equal(tv.body.available, true);
    assert.equal(tv.body.fileName, TV.name);
    assert.equal(tv.body.downloadUrl, TV.browser_download_url);
    assert.equal(tv.body.manifest, undefined);
    const viaHeader = await check('version=1.89.0', { 'X-Client-Platform': 'android-tv' });
    assert.equal(viaHeader.body.fileName, TV.name);
  });

  it('a release without a TV build is no update for the TV; the phone gets no TV APK either', async () => {
    setRelease([PHONE, AAB]);
    const tv = await check('version=1.89.0&client=android-tv');
    assert.deepEqual(tv.body, { ok: true, available: false, channel: 'stable', minVersion: null, mandatory: false });
    updateRouter._resetCache();
    setRelease([TV, AAB]);
    const phone = await check('version=1.89.0&client=android');
    assert.equal(phone.body.downloadUrl, null);
    assert.equal(phone.body.fileName, 'GateControl-Android-1.90.0.apk');
  });

  it('the TV is current like the phone (same version)', async () => {
    setRelease([TV, PHONE]);
    assert.equal((await check('version=1.90.0&client=android-tv')).body.available, false);
  });

  it('/download redirects each app to its own APK', async () => {
    setRelease([TV, PHONE]);
    const tv = await supertest(app).get('/api/v1/client/update/download?client=android-tv').expect(302);
    assert.equal(tv.headers.location, TV.browser_download_url);
    const phone = await supertest(app).get('/api/v1/client/update/download?client=android').expect(302);
    assert.equal(phone.headers.location, PHONE.browser_download_url);
    updateRouter._resetCache();
    setRelease([PHONE]);
    await supertest(app).get('/api/v1/client/update/download?client=android-tv').expect(404);
  });

  it('private repository: the proxied download URL names the TV client', async () => {
    process.env.GC_CLIENT_GITHUB_TOKEN = 'x'.repeat(10);
    try {
      setRelease([TV, PHONE]);
      const tv = await check('version=1.89.0&client=android-tv');
      assert.match(tv.body.downloadUrl, /\/api\/v1\/client\/update\/download\?client=android-tv$/);
    } finally { delete process.env.GC_CLIENT_GITHUB_TOKEN; }
  });
});
