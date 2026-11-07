'use strict';

// Kameras im Heimnetz, server side (phase 3c, step 4 — services/homeCameras.js,
// the gateway's docs/cameras.md): features.cameras in the config pull (never a
// password), the credentials route, the switch and the row "Kameras" (memory,
// Pi hint, compose), reports and events of the gateway (checked, only its own
// cameras), gc.cameras in a real plugin process (add → encrypted password,
// snapshot, live only in the VPN / LAN, events + hook), /camera-media tokens
// and the compose download with the service kameras.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const supertest = require('supertest');
const { cameraPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, gateways, plugins, hc;
const mgmt = [];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

const gwReq = (method, p, g = gw) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);
const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'print', 'radio', 'ai'];

function setTel(g, { caps = CAPS.concat('cameras'), version = '1.28.0', model = 'Raspberry Pi 3 Model B Plus Rev 1.3', cams = { enabled: true, service: 'managed', state: 'running', cameras: 1, recording: 1, storage: { free: 1.2e12, total: 4e12, problem: null } } } = {}) {
  const t = { gateway_version: version, capabilities: caps, hardware: { model, mem_total: 1024 ** 3 }, features: cams ? { cameras: cams } : {} };
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: t }), Date.now(), g.peer.id);
}

function fakeStream(status, type, body, headers = {}) {
  const s = new PassThrough();
  s.statusCode = status;
  s.headers = { 'content-type': type, ...headers };
  setImmediate(() => s.end(body));
  return s;
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gateways.mgmtCall = async (peerId, p, body) => {
    mgmt.push({ peerId, path: p, body });
    if (p === '/api/cameras/probe') {
      if (body.password !== 'geheim') return { status: 401, body: { error: 'auth_failed' } };
      return { status: 200, body: { ok: true, source: 'onvif', host: body.host, onvif: { port: 8000, path: '/onvif/device_service' }, info: { manufacturer: 'Reolink', model: 'E1 Zoom', firmware: 'v3' },
        profile: 'Main', profiles: [{ token: 'Main', name: 'Main', codec: 'h264', width: 2560, height: 1440 }], rtsp: { port: 554, path: '/h264Preview_01_main' },
        events: { supported: true, kinds: ['person', 'vehicle', 'animal', 'motion'] }, codec: 'h264', snapshot: { data: JPEG.toString('base64'), mime: 'image/jpeg' } } };
    }
    if (p === '/api/cameras/discover') return { status: 200, body: { found: [{ host: '192.168.1.73', port: 8000, path: '/onvif/device_service', name: 'Reolink E1', hardware: 'E1 Zoom' }, { host: '8.8.8.8' }] } };
    if (p === '/api/cameras/live') return { status: 200, body: { ready: true, codec: 'avc1.64001f', audio: false } };
    if (p === '/api/cameras/status') return { status: 200, body: { cameras: { service: 'managed', storage: { free: 5 }, discovered: [] } } };
    return { status: 200, body: { deleted: 1 } };
  };
  gateways.mgmtBinary = async (peerId, p) => {
    mgmt.push({ peerId, path: p });
    return { status: 200, type: 'image/jpeg', headers: { 'x-snapshot-at': new Date().toISOString() }, body: JPEG };
  };
  gateways.mgmtRequest = async (peerId, p, o) => {
    mgmt.push({ peerId, path: p, range: o && o.headers && o.headers.range });
    if (p.endsWith('index.m3u8')) return fakeStream(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n');
    if (p.endsWith('clip.mp4')) return fakeStream(206, 'video/mp4', Buffer.alloc(10), { 'content-range': 'bytes 0-9/100', 'content-length': '10', 'set-cookie': 'x=1' });
    return fakeStream(404, 'application/json', '{"error":"not_found"}');
  };
  gw = await gateways.createGateway({ name: 'Pi Keller' });
  gw2 = await gateways.createGateway({ name: 'DS918 Gateway' });
  db = require('../src/db/connection').getDb();
  hc = require('../src/services/homeCameras');
  plugins = require('../src/services/plugins');
  setTel(gw);
  setTel(gw2, { caps: CAPS, version: '1.26.0', cams: null, model: 'DS918+' });
});

after(async () => { await plugins.stop(); teardown(); });

let camId = null;
const call = async (p, body = {}) => (await agent.post('/api/v1/plugins/camera-demo/api' + p).set('X-CSRF-Token', csrf).send(body).expect(200)).body;

describe('features.cameras and the row "Kameras"', () => {
  it('off by default; switch and subnets validated; gateway too old', async () => {
    let c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.cameras, { enabled: false });
    for (const bad of [{ cameras: { enabled: 'yes' } }, { cameras: { subnets: ['8.8.8.0/24'] } }, { cameras: { subnets: ['10.0.0.0/8'] } }, { cameras: { x: 1 } }]) {
      assert.equal((await admin('put', '/features').send(bad)).status, 400, JSON.stringify(bad));
    }
    const v = (await admin('put', '/features').send({ cameras: { enabled: true, subnets: ['192.168.20.7/24'] } }).expect(200)).body.gateway;
    assert.deepEqual(v.features.cameras, { enabled: true, subnets: ['192.168.20.0/24'] });
    c = (await gwReq('get', '/config').expect(200)).body;
    assert.equal(c.features.cameras.enabled, true);
    assert.deepEqual(c.features.cameras.cameras, []);
    assert.equal(c.features.cameras.nobodyHome, null);
    const old = (await admin('get', '/features', gw2).expect(200)).body.gateway;
    assert.equal(old.cameras.supported, false);
    assert.equal(old.support.minGatewayCameras, '1.28.0');
  });
  it('overview: memory part, Pi 3 B+ hint, compose and plugin link', async () => {
    const v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(v.cameras.enabled, true);
    assert.equal(v.cameras.supported, true);
    assert.ok(v.memory.parts.some((p) => p.key === 'cameras' && p.mb === 100));
    assert.deepEqual(v.cameras.hint && [v.cameras.hint.key, v.cameras.hint.max], ['one_motion', 1]);
    assert.equal(v.cameras.compose, null, 'service managed');
    assert.equal(v.cameras.plugin.installed, false);
  });
});

describe('gc.cameras in a plugin process', () => {
  it('installs with the permission shown, gc.cameras exists', async () => {
    const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(cameraPackage());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.plugin.permissions.cameras, true, 'shown in the install dialog');
    await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    let has = null;
    for (let i = 0; i < 50 && !has; i++) { try { has = await call('/has'); } catch { await new Promise((res) => setTimeout(res, 100)); } }
    assert.equal(has.cameras, true);
    const a = await call('/available');
    assert.equal(a.result.available, true);
    assert.deepEqual(a.result.gateways.map((g) => [g.name, g.supported, g.enabled]), [['Pi Keller', true, true]]);
  });
  it('discover: only private addresses', async () => {
    const d = await call('/discover', {});
    assert.deepEqual(d.result.found.map((x) => [x.host, x.name, x.cameraId]), [['192.168.1.73', 'Reolink E1', null]]);
  });
  it('add: refuses a wrong password and a public address; stores the password encrypted, never in the config pull', async () => {
    let r = await call('/add', { gatewayId: gw.peer.id, name: 'Einfahrt', host: '192.168.1.73', user: 'admin', password: 'falsch' });
    assert.equal(r.code, 'ERR_CAMERA_AUTH');
    r = await call('/add', { gatewayId: gw.peer.id, name: 'X', host: '8.8.8.8', user: 'a', password: 'b' });
    assert.equal(r.code, 'ERR_CAMERA_NOT_ALLOWED');
    r = await call('/add', { gatewayId: gw2.peer.id, name: 'X', host: '192.168.1.5', user: 'a', password: 'geheim' });
    assert.equal(r.code, 'ERR_CAMERA_UNSUPPORTED');
    r = await call('/add', { gatewayId: gw.peer.id, name: 'Einfahrt', host: '192.168.1.73', user: 'admin', password: 'geheim', settings: { record: 'away', retentionDays: 7 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    camId = r.result.camera.id;
    assert.match(camId, /^c[0-9a-f]{15}$/);
    assert.equal(r.result.camera.model, 'E1 Zoom');
    assert.equal(r.result.snapshot.mime, 'image/jpeg');
    assert.equal(JSON.stringify(r).includes('geheim'), false);
    const row = db.prepare('SELECT password_enc FROM home_cameras WHERE id = ?').get(camId);
    assert.ok(row.password_enc && !row.password_enc.includes('geheim'));
    const c = (await gwReq('get', '/config').expect(200)).body.features.cameras;
    assert.equal(JSON.stringify(c).includes('geheim'), false);
    assert.deepEqual(c.cameras.map((x) => [x.id, x.host, x.record, x.retentionDays, x.onvif.port]), [[camId, '192.168.1.73', 'away', 7, 8000]]);
    const cred = (await gwReq('get', '/cameras/credentials').expect(200)).body;
    assert.deepEqual(cred.cameras[camId], { user: 'admin', password: 'geheim' });
    assert.equal(cred.rev, c.credRev);
    assert.deepEqual((await gwReq('get', '/cameras/credentials', gw2).expect(200)).body.cameras, {}, 'other gateway: nothing');
  });
  it('update: a new password changes credRev', async () => {
    const before = (await gwReq('get', '/config').expect(200)).body.features.cameras.credRev;
    const r = await call('/update', { id: camId, patch: { password: 'neu', settings: { record: 'motion' } } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.settings.record, 'motion');
    assert.notEqual((await gwReq('get', '/config').expect(200)).body.features.cameras.credRev, before);
    assert.equal((await call('/update', { id: camId, patch: { settings: { record: 'always' } } })).code, 'ERR_INVALID');
  });
  it('report and events of the gateway: checked, own cameras only, hook cameraEvent', async () => {
    await gwReq('post', '/cameras/report').send({ service: 'managed', storage: { free: 5e11, total: 1e12 }, cameras: [{ id: camId, state: 'ok', events: 'pullpoint', kinds: ['person'], codec: 'h264', stream: 'running' }, { id: 'evil' }] }).expect(200);
    const ev = { id: 'e0123456789abcde', cameraId: camId, kind: 'person', kinds: ['person', 'motion'], phase: 'start', startedAt: new Date().toISOString(), nobodyHome: true, clip: null, thumb: true };
    assert.equal((await gwReq('post', '/cameras/events', gw2).send({ events: [ev] }).expect(200)).body.events, 0, 'not its camera');
    assert.equal((await gwReq('post', '/cameras/events').send({ events: [ev, { id: 'bad' }] }).expect(200)).body.events, 1);
    await gwReq('post', '/cameras/events').send({ events: [{ ...ev, phase: 'end', endedAt: new Date().toISOString(), clip: { ms: 24000, bytes: 9000000 } }] }).expect(200);
    assert.equal((await gwReq('post', '/cameras/events').send({ events: 'x' })).status, 400);
    let hooked = [];
    for (let i = 0; i < 40 && hooked.length < 2; i++) { hooked = (await call('/hooked')).result; await new Promise((r) => setTimeout(r, 50)); }
    assert.deepEqual(hooked.map((h) => [h.phase, h.kind, h.camera, h.nobodyHome]).sort(), [['end', 'person', 'Einfahrt', true], ['start', 'person', 'Einfahrt', true]], JSON.stringify(hooked));
    const list = (await call('/events', { cameraId: camId })).result;
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].clip, { ms: 24000, bytes: 9000000 });
    assert.match(list[0].clipUrl, /^\/camera-media\/[^/]+\/clip\.mp4$/);
    assert.match(list[0].thumbUrl, /\/thumb\.jpg$/);
    const cams = (await call('/list')).result;
    assert.equal(cams[0].state, 'ok');
    assert.deepEqual(cams[0].events.kinds, ['person']);
  });
  it('snapshot ≤ 300 KB for a push; snapshot URL; live in the LAN, snapshot only from the internet', async () => {
    const s = await call('/snapshot', { id: camId });
    assert.equal(Buffer.from(s.result.data, 'base64').equals(JPEG), true);
    const u = (await call('/snapshotUrl', { id: camId })).result;
    assert.match(u.url, /^\/camera-media\/.+\/snapshot\.jpg$/);
    const img = await supertest(app).get(u.url).expect(200);
    assert.equal(img.headers['content-type'], 'image/jpeg');
    assert.equal(img.headers['cache-control'], 'no-store');
    const l = (await call('/live', { id: camId })).result;
    assert.equal(l.mode, 'live', 'the test request comes from 127.0.0.1');
    assert.equal(l.codec, 'avc1.64001f');
    const pl = await supertest(app).get(l.hls).expect(200);
    assert.equal(pl.headers['content-type'], 'application/vnd.apple.mpegurl');
    assert.ok(mgmt.some((m) => m.path === `/api/cameras/${camId}/live/index.m3u8`));
    assert.equal(hc.netOfRequest({ ip: '203.0.113.7' }), 'internet');
    assert.equal(hc.netOfRequest({ ip: '10.8.0.5' }), 'vpn');
    const net = await hc.live('camera-demo', camId, { ip: '203.0.113.7' });
    assert.equal(net.mode, 'snapshot');
    assert.equal(net.every, 10);
    assert.equal(net.reason, 'vpn_required');
  });
  it('/camera-media: tokens are bound to kind and file; clips pass Range, nothing else of the gateway', async () => {
    const ev = (await call('/events', { cameraId: camId })).result[0];
    const r = await supertest(app).get(ev.clipUrl).set('Range', 'bytes=0-9').expect(206);
    assert.equal(r.headers['content-range'], 'bytes 0-9/100');
    assert.equal(r.headers['set-cookie'], undefined);
    assert.ok(mgmt.some((m) => m.path === `/api/cameras/events/${ev.id}/clip.mp4` && m.range === 'bytes=0-9'));
    const tok = ev.clipUrl.split('/')[2];
    await supertest(app).get(`/camera-media/${tok}/index.m3u8`).expect(404);
    await supertest(app).get(`/camera-media/${tok.slice(0, -2)}xx/clip.mp4`).expect(404);
    const forged = hc.sign('live', camId, 'other-plugin', 60);
    await supertest(app).get(`/camera-media/${forged}/index.m3u8`).expect(404);
  });
  it('remove: the camera goes, its events with it', async () => {
    assert.equal((await call('/remove', { id: camId })).result.removed, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM home_camera_events').get().n, 0);
    assert.deepEqual((await gwReq('get', '/config').expect(200)).body.features.cameras.cameras, []);
  });
});

describe('compose download with the service kameras', () => {
  it('when cameras are on (or asked for)', async () => {
    const kit = require('../public/js/gateway-kit');
    db.prepare("UPDATE gateway_meta SET platform = 'synology' WHERE peer_id = ?").run(gw.peer.id);
    let text = (await admin('post', '/compose').send({ platform: 'synology' }).expect(200)).text;
    assert.equal(text, kit.buildCompose({ platform: 'synology', network: 'host', cameras: true }));
    assert.match(text, /\n {2}kameras:\n/);
    text = (await admin('post', '/compose').send({ platform: 'synology', cameras: false }).expect(200)).text;
    assert.doesNotMatch(text, /\n {2}kameras:\n/);
  });
  it('the admin API of the gateway answers the overview', async () => {
    const v = (await admin('get', '/cameras').expect(200)).body.cameras;
    assert.equal(v.enabled, true);
    assert.equal(v.live.service, 'managed');
  });
});
