'use strict';

// Phase 3b of the gateways, server side: the home cache — features.cache in
// the config pull (secret per gateway, never in the admin view), the stock
// (app updates the server keeps, refreshUpdates with a stubbed GitHub), the
// gateway endpoints want (ETag) / blob (Range, streams, only its own stock) /
// report (have, gone, counters), the lan hint of the update check and its
// signature against the gateway's formula HMAC-SHA256(secret, sha256 + "\n" + exp),
// "Zwischenspeicher leeren" over the management API.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, gateways, hc, clientPeerId;
const APK = crypto.randomBytes(300 * 1024);
const APK_SHA = crypto.createHash('sha256').update(APK).digest('hex');
const EXE = crypto.randomBytes(120 * 1024);
const EXE_SHA = crypto.createHash('sha256').update(EXE).digest('hex');
const FP = 'AB:'.repeat(31) + 'AB';

function gwReq(method, p, g = gw) {
  return supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
}
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);
const pushed = [];

function release(tag, assets) {
  return { id: 7, tag_name: tag, body: '', prerelease: false, assets };
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gw = await gateways.createGateway({ name: 'NAS Buero' });
  gw2 = await gateways.createGateway({ name: 'Pi Keller' });
  db = require('../src/db/connection').getDb();
  hc = require('../src/services/homeCache');
  gateways.notifyConfigChanged = async (id) => { pushed.push(id); };
  db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({
    telemetry: { gateway_version: '1.22.0', lan_ip: '192.168.1.23',
      hardware: { model: 'Synology DS920+', platform: 'synology', mem_total: 8 * 1024 ** 3 },
      storage: [{ mount: '/volume1', fs: 'btrfs', sizeBytes: 4e12, freeBytes: 1.2e12, removable: false, origin: 'host' },
        { mount: '/cache', fs: 'btrfs', sizeBytes: 4e12, freeBytes: 0.9e12, removable: false, origin: 'container' }],
      features: { cache: { enabled: true, running: true, port: 8443, tlsSha256: FP, usedBytes: 0 } } },
  }), Date.now(), gw.peer.id);
  // a client that runs the Android app (the stock takes the installers in use)
  const peers = require('../src/services/peers');
  const p = await peers.create({ name: 'annas-handy' });
  clientPeerId = p.id;
  db.prepare("UPDATE peers SET client_product = 'android', client_version = '1.80.0' WHERE id = ?").run(clientPeerId);
});

after(() => { hc._resetForTest(); teardown(); });

describe('settings and features.cache', () => {
  it('off: only { enabled: false }, no secret', async () => {
    const r = await gwReq('get', '/config').expect(200);
    assert.deepEqual(r.body.features.cache, { enabled: false });
  });

  it('on: the volume /cache, size, kinds and a secret per gateway — never in the admin view', async () => {
    pushed.length = 0;
    await admin('put', '/cache').send({ enabled: true, maxBytes: 50 * hc.GB }).expect(200);
    assert.deepEqual(pushed, [gw.peer.id]);
    const c = (await gwReq('get', '/config').expect(200)).body;
    const f = c.features.cache;
    assert.equal(f.enabled, true);
    assert.equal(f.path, '/cache', 'gateway side 14: always its volume');
    assert.equal(f.maxBytes, 50 * hc.GB);
    assert.deepEqual(f.kinds, { drive: true, photos: true, updates: true, vault: false });
    assert.match(f.secret, /^[0-9a-f]{64}$/);
    assert.equal((await gwReq('get', '/config')).body.features.cache.secret, f.secret, 'stable');
    assert.equal(c.config_hash, gateways.computeConfigHash(gw.peer.id));
    // stored encrypted, not as plain text
    assert.ok(!db.prepare('SELECT secret_enc FROM gateway_cache WHERE peer_id = ?').get(gw.peer.id).secret_enc.includes(f.secret));
    const v = (await admin('get', '/cache').expect(200)).body;
    assert.ok(!JSON.stringify(v).includes(f.secret));
    assert.equal(v.settings.path, undefined);
    assert.equal(v.hostSetting, 'GC_CACHE_DIR');
    assert.equal(v.state.running, true);
    assert.equal(v.state.pinned, true);
    assert.equal(v.freeBytes, 0.9e12, 'the free space of the volume /cache');
    // a second gateway has its own secret
    await admin('put', '/cache', gw2).send({ enabled: true }).expect(200);
    assert.notEqual((await gwReq('get', '/config', gw2)).body.features.cache.secret, f.secret);
  });

  it('wrong values: a folder (set at the gateway), sizes, unknown kinds', async () => {
    assert.equal((await admin('put', '/cache').send({ path: '/volume1/cache' })).status, 400);
    assert.equal((await admin('put', '/cache').send({ maxBytes: 100 })).status, 400);
    assert.equal((await admin('put', '/cache').send({ kinds: { music: true } })).status, 400);
    assert.equal((await admin('put', '/cache').send({})).status, 400);
  });

  it('the host folder suggestion: on a Pi only a removable drive, never the container\'s own mounts', async () => {
    const v = await hc.view(gw.peer.id);
    assert.deepEqual(v.suggestion, { mount: '/volume1', hostDir: '/volume1/gatecontrol-cache', freeBytes: 1.2e12, removable: false, setting: 'GC_CACHE_DIR' });
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: { gateway_version: '1.22.0',
      hardware: { model: 'Raspberry Pi 4 Model B Rev 1.4' },
      storage: [{ mount: '/', fs: 'ext4', sizeBytes: 32e9, freeBytes: 20e9, removable: false }, { mount: '/media/usb0', fs: 'ext4', sizeBytes: 1e12, freeBytes: 9e11, removable: true }] } }), gw2.peer.id);
    const v2 = await hc.view(gw2.peer.id);
    assert.equal(v2.pi, true);
    assert.equal(v2.suggestion.hostDir, '/media/usb0/gatecontrol-cache');
    assert.equal(v2.suggestion.setting, 'CACHE_DIR');
    assert.equal(v2.hostSetting, 'CACHE_DIR');
  });
});

describe('the stock: app updates', () => {
  it('refreshUpdates keeps the installer of the apps in use (stubbed GitHub), checks the digest', async () => {
    const r = await hc.refreshUpdates({
      fetchRelease: async (product) => (product === 'android'
        ? release('v1.81.0', [{ id: 11, name: 'GateControl-1.81.0.apk', size: APK.length, updated_at: '2026-11-01T00:00:00Z', digest: 'sha256:' + APK_SHA, browser_download_url: 'https://example.invalid/a.apk' }])
        : null),
      signedOf: async () => null,
      download: async (asset, dest) => { fs.writeFileSync(dest, APK); return { sha256: APK_SHA, size: APK.length }; },
    });
    assert.deepEqual(r, { fetched: 1, removed: 0 });
    const b = db.prepare('SELECT * FROM home_cache_blobs WHERE sha256 = ?').get(APK_SHA);
    assert.equal(b.kind, 'updates');
    assert.equal(b.source, 'update');
    assert.equal(b.label, 'android 1.81.0');
    assert.ok(fs.existsSync(b.file));
    assert.ok(b.file.startsWith(hc.updatesDir() + path.sep));
    // the same release again: nothing to download
    const again = await hc.refreshUpdates({ fetchRelease: async () => release('v1.81.0', [{ id: 11, name: 'GateControl-1.81.0.apk', size: APK.length, updated_at: '2026-11-01T00:00:00Z', browser_download_url: 'x' }]),
      signedOf: async () => null, download: async () => { throw new Error('must not download'); } });
    assert.equal(again.fetched, 0);
    // a download that does not match the published digest is dropped
    db.prepare("UPDATE peers SET client_product = 'community' WHERE id = ?").run(clientPeerId);
    const bad = await hc.refreshUpdates({ fetchRelease: async () => release('v2.0.0', [{ id: 12, name: 'GateControl-Setup-2.0.0.exe', size: EXE.length, updated_at: 'x', digest: 'sha256:' + '0'.repeat(64), browser_download_url: 'x' }]),
      signedOf: async () => null, download: async (a, dest) => { fs.writeFileSync(dest, EXE); return { sha256: EXE_SHA, size: EXE.length }; } });
    assert.equal(bad.fetched, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM home_cache_blobs WHERE sha256 = ?').get(EXE_SHA).n, 0);
    db.prepare("UPDATE peers SET client_product = 'android' WHERE id = ?").run(clientPeerId);
  });

  it('GET /cache/want: the stock of this gateway, ETag → 304', async () => {
    const r = await gwReq('get', '/cache/want').expect(200);
    assert.equal(r.body.maxBytes, 50 * hc.GB);
    assert.deepEqual(r.body.items, [{ sha256: APK_SHA, size: APK.length, kind: 'updates', priority: 80 }]);
    const etag = r.headers.etag;
    assert.ok(etag);
    await gwReq('get', '/cache/want').set('If-None-Match', etag).expect(304);
    // app updates switched off: the stock is empty, the ETag changes
    await admin('put', '/cache').send({ kinds: { updates: false } }).expect(200);
    const r2 = await gwReq('get', '/cache/want').expect(200);
    assert.deepEqual(r2.body.items, []);
    assert.notEqual(r2.headers.etag, etag);
    await admin('put', '/cache').send({ kinds: { updates: true } }).expect(200);
  });

  it('GET /cache/blob/<sha256>: the bytes, Range, only blobs of its stock', async () => {
    const full = await gwReq('get', '/cache/blob/' + APK_SHA).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.ok(Buffer.compare(full.body, APK) === 0);
    assert.equal(full.headers['content-type'], 'application/octet-stream');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['x-content-sha256'], APK_SHA);
    assert.equal(Number(full.headers['content-length']), APK.length);
    const part = await gwReq('get', '/cache/blob/' + APK_SHA).set('Range', 'bytes=100-199').buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(206);
    assert.ok(Buffer.compare(part.body, APK.subarray(100, 200)) === 0);
    assert.equal(part.headers['content-range'], `bytes 100-199/${APK.length}`);
    await gwReq('get', '/cache/blob/' + APK_SHA).set('Range', `bytes=${APK.length + 5}-`).expect(416);
    await gwReq('get', '/cache/blob/' + 'f'.repeat(64)).expect(404);
    await gwReq('get', '/cache/blob/not-a-sha').expect(404);
    // the other gateway keeps no app updates: not its stock
    await admin('put', '/cache', gw2).send({ kinds: { updates: false } }).expect(200);
    await gwReq('get', '/cache/blob/' + APK_SHA, gw2).expect(404);
    await admin('put', '/cache', gw2).send({ kinds: { updates: true } }).expect(200);
    // without the gateway token: nothing
    assert.equal((await supertest(app).get('/api/v1/gateway/cache/blob/' + APK_SHA)).status, 401);
  });
});

describe('reports and the lan hint', () => {
  it('POST /cache: have / gone / full, counters per day', async () => {
    await gwReq('post', '/cache').send({ have: [APK_SHA.toUpperCase()], usedBytes: APK.length, hits: 3, misses: 1, bytesServed: 3 * APK.length, bytesFetched: APK.length }).expect(200);
    await gwReq('post', '/cache').send({ have: [], hits: 1, misses: 0, bytesServed: APK.length, bytesFetched: 0 }).expect(200);
    const v = (await admin('get', '/cache').expect(200)).body;
    assert.equal(v.usage.usedBytes, APK.length);
    assert.equal(v.today.hits, 4);
    assert.equal(v.today.hitPct, 80);
    assert.equal(v.today.bytesServed, 4 * APK.length);
    assert.deepEqual(v.kinds.updates, { bytes: APK.length, count: 1, wanted: 1 });
    assert.equal(v.stock.have, 1);
    assert.equal((await gwReq('post', '/cache').send({ have: ['xyz'] })).status, 400);
    assert.equal((await gwReq('post', '/cache').send({ hits: -1 })).status, 400);
    assert.equal((await gwReq('post', '/cache').send({ have: new Array(5001).fill(APK_SHA) })).status, 400);
  });

  it('the signature is the gateway\'s formula HMAC-SHA256(secret, sha256 + "\\n" + exp), hex', () => {
    const secret = hc.secretOf(gw.peer.id, false);
    const now = Date.parse('2026-11-05T12:00:00Z');
    const h = hc.hintFor(gw.peer.id, APK_SHA, { now });
    const exp = Math.floor(now / 1000) + 600;
    const sig = crypto.createHmac('sha256', secret).update(APK_SHA + '\n' + exp).digest('hex');
    assert.deepEqual(h, { url: `https://192.168.1.23:8443/blob/${APK_SHA}?exp=${exp}&sig=${sig}`, sha256: APK_SHA, tlsSha256: 'ab'.repeat(32), exp });
    assert.equal(hc.signature(secret, APK_SHA, exp), sig);
    // a blob the gateway does not hold, an unknown one: no hint
    assert.equal(hc.hintFor(gw2.peer.id, APK_SHA, { now }), null);
    assert.equal(hc.hintFor(gw.peer.id, 'e'.repeat(64), { now }), null);
  });

  it('the update check answers with lan only for a client at the gateway\'s site', async () => {
    const upd = require('../src/routes/api/client/update');
    upd._resetCache();
    upd._setReleaseForTest('android', 'stable', release('v1.81.0', [{ id: 11, name: 'GateControl-1.81.0.apk', size: APK.length, updated_at: '2026-11-01T00:00:00Z', browser_download_url: 'https://example.invalid/a.apk' }]));
    const hn = require('../src/services/homeNetwork');
    const orig = hn.check;
    const seen = [];
    hn.check = async (ip, peerId, opts) => { seen.push(opts.local); return opts.local === '192.168.1.50' ? { same_lan: true, site: { type: 'gateway', gatewayId: gw.peer.id, name: 'NAS Buero' } } : { same_lan: false, site: null }; };
    try {
      const home = await supertest(app).get('/api/v1/client/update/check?version=1.80.0&client=android&local=192.168.1.50').expect(200);
      assert.equal(home.body.available, true);
      assert.ok(home.body.lan, JSON.stringify(home.body));
      assert.equal(home.body.lan.sha256, APK_SHA);
      assert.match(home.body.lan.url, new RegExp(`^https://192\\.168\\.1\\.23:8443/blob/${APK_SHA}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
      assert.equal(home.body.lan.tlsSha256, 'ab'.repeat(32));
      assert.ok(home.body.lan.exp - Date.now() / 1000 <= 600);
      // header instead of the query works the same
      const viaHeader = await supertest(app).get('/api/v1/client/update/check?version=1.80.0&client=android').set('X-GC-Local', '192.168.1.50').expect(200);
      assert.ok(viaHeader.body.lan);
      const away = await supertest(app).get('/api/v1/client/update/check?version=1.80.0&client=android&local=10.0.0.5').expect(200);
      assert.equal(away.body.lan, undefined);
      assert.deepEqual(seen, ['192.168.1.50', '192.168.1.50', '10.0.0.5']);
      // a replaced asset (other upload) is not the blob in the stock: no hint
      upd._setReleaseForTest('android', 'stable', release('v1.81.0', [{ id: 11, name: 'GateControl-1.81.0.apk', size: APK.length, updated_at: '2026-11-02T00:00:00Z', browser_download_url: 'https://example.invalid/a.apk' }]));
      assert.equal((await supertest(app).get('/api/v1/client/update/check?version=1.80.0&client=android&local=192.168.1.50').expect(200)).body.lan, undefined);
    } finally { hn.check = orig; upd._resetCache(); }
  });

  it('the telemetry of the gateway (side 18): urls[0], states; no hint unless running', async () => {
    const tc = hc.telemetryCache({ lan_ip: '192.168.1.23', cache: { state: 'running', urls: ['https://192.168.1.24:8443', 'https://[fd00::1]:8443'], tlsSha256: 'ab'.repeat(32), freeBytes: 5 } });
    assert.deepEqual([tc.state, tc.running, tc.url, tc.freeBytes], ['running', true, 'https://192.168.1.24:8443', 5]);
    // a home network without IPv4: the gateway listens on its unique local address only — that one is the hint;
    // link-local and global IPv6 never are
    const v6 = hc.telemetryCache({ lan_ip: null, cache: { state: 'running', port: 8443, urls: ['https://[fe80::1]:8443', 'https://[2a02:8070::5]:8443', 'https://[fd12:3456:789a:1::5]:8443', 'https://[fd00::9]:8443'], tlsSha256: 'ab'.repeat(32) } });
    assert.equal(v6.url, 'https://[fd12:3456:789a:1::5]:8443');
    assert.equal(hc.telemetryCache({ cache: { state: 'running', urls: ['https://[2a02:8070::5]:8443', 'https://[fe80::1]:8443', 'http://[fd00::9]:8443', 'https://user@[fd00::9]:8443'] } }).url, null);
    // IPv4 first, wherever it stands in the list
    assert.equal(hc.telemetryCache({ cache: { state: 'running', urls: ['https://[fd00::9]:8443', 'https://192.168.1.24:8443'] } }).url, 'https://192.168.1.24:8443');
    const bad = hc.telemetryCache({ features: { cache: { enabled: true, running: false, state: 'path_unwritable', error: { at: 1, code: 'EACCES' } } } });
    assert.deepEqual([bad.state, bad.running, bad.error], ['path_unwritable', false, 'EACCES']);
    const h = JSON.parse(db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(gw.peer.id).last_health);
    h.telemetry.features.cache.state = 'no_secret';
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify(h), gw.peer.id);
    assert.equal(hc.hintFor(gw.peer.id, APK_SHA), null);
    assert.equal((await hc.view(gw.peer.id)).state.state, 'no_secret');
    h.telemetry.features.cache.state = 'running';
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify(h), gw.peer.id);
  });

  it('"Zwischenspeicher leeren": the gateway is asked, the server forgets what it held', async () => {
    const orig = gateways.mgmtCall;
    const calls = [];
    gateways.mgmtCall = async (peerId, p) => { calls.push([peerId, p]); return { status: 202, body: { accepted: true } }; };
    try {
      await admin('post', '/cache/clear').send({}).expect(200);
      assert.deepEqual(calls, [[gw.peer.id, '/api/cache/clear']]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM home_cache_have WHERE peer_id = ?').get(gw.peer.id).n, 0);
      gateways.mgmtCall = async () => ({ status: 404, body: null });
      assert.equal((await admin('post', '/cache/clear').send({})).body.code, 'gateway_unsupported');
    } finally { gateways.mgmtCall = orig; }
  });

  it('the card "Funktionen" counts the cache in the memory estimate', async () => {
    const g = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(g.cache.enabled, true);
    assert.ok(g.memory.parts.some((p) => p.key === 'cache' && p.mb === 10));
    assert.equal(g.support.cache, true);
  });
});
