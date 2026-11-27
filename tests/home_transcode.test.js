'use strict';

// „Videos umwandeln“, server side (services/homeTranscode.js, the gateway's docs/transcode.md):
// features.transcode in the config pull and its checks, the row on the gateway page (support,
// hints, compose), the report of the gateway (checked, stored, trash kept), the compose download
// with the service umwandeln, and gc.transcode in a real plugin process (permission, checks of
// gateway/id/path, the gateway's error codes as reason, settings, hook transcodeChanged).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { transcodePackage, helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, gateways, plugins;
const mgmt = [];
let nextAnswer = null;

const gwReq = (method, p, g = gw) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);
const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'print', 'radio', 'ai', 'cameras'];
const ROOT = '/volume2/mediathek';
const FILE = ROOT + '/Serie A/Staffel 1/Folge 01.mkv';

function setTel(g, { caps = CAPS.concat('transcode'), version = '1.50.0', tc = { enabled: true, service: 'managed', state: 'ready', device: 'ok', deviceGid: 937, driver: 'Intel iHD driver - 26.3.5', encoders: ['vaapi_icq', 'vaapi_qvbr'], software: false, ffmpeg: '8.1.3', roots: [{ path: ROOT, state: 'ok', free: 1.8e12, total: 3.9e12 }], jobs: { queued: 2, done: 3, failed: 0 }, current: null, trash: { count: 3, bytes: 2436000000 }, arch: 'x64', error: null } } = {}) {
  const t = { gateway_version: version, capabilities: caps, hardware: { model: 'DS918+', mem_total: 16 * 1024 ** 3 }, features: tc ? { transcode: tc } : {} };
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: t }), Date.now(), g.peer.id);
}

const STATUS = {
  at: '2026-11-27T02:14:08.000Z', enabled: true, service: 'managed', state: 'running',
  caps: { at: '2026-11-26T19:02:11.000Z', ffmpeg: '8.1.3', uid: 1034, groups: [100, 61002, 937], device: 'ok', devicePath: '/dev/dri/renderD128', deviceGid: 937, deviceMode: '660', driver: 'Intel iHD driver - 26.3.5', vaH264Enc: true, encoders: ['vaapi_icq', 'vaapi_qvbr'], software: true },
  roots: [{ path: ROOT, state: 'ok', free: 1932735283200, total: 3900000000000 }],
  settings: { software: false, trashDays: 14, quality: 23, verifyDecode: true, minFreeGb: 20, minFreePct: 5 },
  pause: { all: false, until: null },
  jobs: [
    { id: 'k3J9x2Qw8LmN', path: FILE, state: 'running', error: null, percent: 41, fps: 78.3, speed: 3.14, paused: false, software: false, submittedAt: '2026-11-27T01:00:02.000Z', startedAt: '2026-11-27T02:11:40.000Z', finishedAt: null, result: null },
    { id: 'bad id!', path: FILE, state: 'done' },
    { id: 'Zp40aa71Bc2d', path: ROOT + '/Serie A/Staffel 1/Folge 00.mkv', state: 'failed', error: 'encode_failed', result: { log: ['line\u0007one', 'two'], mode: 'evil' } },
  ],
  trash: [{ id: 'Zp40aa71Bc2d', at: '2026-11-26T02:31:10.000Z', size: 812000000, expiresAt: '2026-12-10T02:31:10.000Z', path: ROOT + '/Serie A/Staffel 1/Folge 00.mkv' }],
};

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gateways.mgmtCall = async (peerId, p, body) => {
    mgmt.push({ peerId, path: p, body });
    if (nextAnswer) { const a = nextAnswer; nextAnswer = null; return a; }
    if (p === '/api/transcode/status') return { status: 200, body: STATUS };
    if (p === '/api/transcode/submit') return { status: 202, body: { job: { id: body.id, path: body.path, state: 'queued', submittedAt: '2026-11-27T01:00:02.000Z' } } };
    if (p === '/api/transcode/probe') return { status: 200, body: { path: body.path, source: { codec: 'h264', profile: 'High 10', bits: 10, width: 1920, height: 1080, evil: 'x' }, freeKb: 123456 } };
    if (p === '/api/transcode/pause' || p === '/api/transcode/resume') return { status: 200, body: { pause: { all: !body.id && p.endsWith('pause'), until: null } } };
    if (p === '/api/transcode/ack') return { status: 200, body: { removed: body.ids.length } };
    if (p === '/api/transcode/restore') return { status: 200, body: { id: body.id, restored: true } };
    if (p === '/api/transcode/purge') return { status: 200, body: { purged: true } };
    if (p === '/api/transcode/cancel') return { status: 200, body: { job: { id: body.id, path: FILE, state: 'cancelled' } } };
    return { status: 404, body: { error: 'not_found' } };
  };
  gw = await gateways.createGateway({ name: 'NAS Keller' });
  gw2 = await gateways.createGateway({ name: 'Pi Flur' });
  db = require('../src/db/connection').getDb();
  plugins = require('../src/services/plugins');
  setTel(gw, { tc: null });
  setTel(gw2, { caps: CAPS, version: '1.49.0', tc: null });
});

after(async () => { await plugins.stop(); teardown(); });

const call = async (p, body = {}) => (await agent.post('/api/v1/plugins/transcode-demo/api' + p).set('X-CSRF-Token', csrf).send(body).expect(200)).body;

describe('features.transcode and the row "Videos umwandeln"', () => {
  it('off by default ({ enabled: false } in the config pull); every field checked', async () => {
    const c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.transcode, { enabled: false });
    const bad = [
      { transcode: { enabled: 'yes' } },
      { transcode: { roots: ['volume2/mediathek'] } },
      { transcode: { roots: ['/volume2/../etc'] } },
      { transcode: { roots: ['/volume2/a:b'] } },
      { transcode: { roots: ['/volume2/$HOME'] } },
      { transcode: { roots: ['/volume2/"x"'] } },
      { transcode: { roots: ['/volume2/mediathek/.gc-papierkorb'] } },
      { transcode: { roots: [ROOT, ROOT + '/Serien'] } },
      { transcode: { roots: Array.from({ length: 9 }, (_, i) => '/volume1/m' + i) } },
      { transcode: { uid: 0 } },
      { transcode: { gid: -1 } },
      { transcode: { trashDays: 0 } },
      { transcode: { quality: 40 } },
      { transcode: { gpu: 'intel' } },
    ];
    for (const b of bad) assert.equal((await admin('put', '/features').send(b)).status, 400, JSON.stringify(b));
  });
  it('switched on: folders, user and „ohne Grafik“ go into the config pull (fixed parts as the gateway defaults)', async () => {
    const v = (await admin('put', '/features').send({ transcode: { enabled: true, roots: [ROOT + '/', '/volume1/Filme (alt)'], uid: '1034', gid: 100, software: false } }).expect(200)).body.gateway;
    assert.deepEqual(v.features.transcode, { enabled: true, roots: [ROOT, '/volume1/Filme (alt)'], uid: 1034, gid: 100, software: false, trashDays: 14, quality: 23 });
    const c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.transcode, { enabled: true, roots: [ROOT, '/volume1/Filme (alt)'], software: false, trashDays: 14, quality: 23, verifyDecode: true, minFreeGb: 20, minFreePct: 5 });
    assert.ok(v.support.transcode === true && v.support.minGatewayTranscode === '1.50.0');
  });
  it('a gateway without the capability: supported false with the version', async () => {
    const old = (await admin('get', '/features', gw2).expect(200)).body.gateway;
    assert.equal(old.transcode.supported, false);
    assert.equal(old.transcode.minGateway, '1.50.0');
    assert.deepEqual(old.transcode.hints, []);
  });
  it('the row: no telemetry yet → the compose hint; with telemetry → what the gateway found, no hint', async () => {
    let v = (await admin('get', '/features').expect(200)).body.gateway.transcode;
    assert.equal(v.compose, 'compose');
    assert.equal(v.renderGid, 44, 'the group stays 44 while unknown');
    setTel(gw);
    v = (await admin('get', '/features').expect(200)).body.gateway.transcode;
    assert.equal(v.compose, null);
    assert.deepEqual(v.hints, []);
    assert.equal(v.deviceGid, 937);
    assert.deepEqual(v.encoders, ['vaapi_icq', 'vaapi_qvbr']);
    assert.equal(v.trash.count, 3);
    assert.equal(v.plugin.installed, false);
    const chips = (await agent.get('/api/v1/gateways').expect(200)).body;
    const me = (chips.gateways || chips).find((x) => x.peer_id === gw.peer.id);
    assert.ok(me.features_on.includes('transcode'));
  });
  it('hints: the group of the device missing, a folder not mounted, no user', async () => {
    setTel(gw, { tc: { enabled: true, service: 'managed', state: 'device_denied', device: 'denied', deviceGid: 937, roots: [{ path: ROOT, state: 'ok' }, { path: '/volume1/Filme (alt)', state: 'not_mounted' }], arch: 'x64' } });
    await admin('put', '/features').send({ transcode: { uid: null } }).expect(200);
    const v = (await admin('get', '/features').expect(200)).body.gateway.transcode;
    assert.deepEqual(v.hints, ['user', 'device_denied', 'not_mounted']);
    assert.equal(v.compose, 'compose');
    assert.equal(v.renderGid, 937);
    await admin('put', '/features').send({ transcode: { uid: 1034 } }).expect(200);
    setTel(gw, { tc: { enabled: true, service: 'managed', state: 'ready', device: 'ok', deviceGid: 937, roots: [{ path: ROOT, state: 'ok' }], arch: 'arm64' } });
    assert.deepEqual((await admin('get', '/features').expect(200)).body.gateway.transcode.hints, ['arch']);
    setTel(gw);
  });
});

describe('POST /api/v1/gateway/transcode/report', () => {
  it('stores the checked state; a report without trash keeps the last trash', async () => {
    const r = await gwReq('post', '/transcode/report').send(STATUS).expect(200);
    assert.deepEqual(r.body, {});
    const ht = require('../src/services/homeTranscode');
    let rep = ht.lastReport(gw.peer.id);
    assert.equal(rep.state, 'running');
    assert.deepEqual(rep.jobs.map((j) => j.id), ['k3J9x2Qw8LmN', 'Zp40aa71Bc2d'], 'a job with a bad id is dropped');
    assert.equal(rep.jobs[1].result.mode, null);
    assert.deepEqual(rep.jobs[1].result.log, ['line one', 'two']);
    assert.equal(rep.trash.length, 1);
    const { trash, ...noTrash } = STATUS;
    assert.ok(trash);
    await gwReq('post', '/transcode/report').send({ ...noTrash, state: 'ready', jobs: [] }).expect(200);
    rep = ht.lastReport(gw.peer.id);
    assert.equal(rep.state, 'ready');
    assert.equal(rep.trash.length, 1, 'trash kept');
    await gwReq('post', '/transcode/report').send({ ...noTrash, trash: [] }).expect(200);
    assert.equal(ht.lastReport(gw.peer.id).trash.length, 0);
    await gwReq('post', '/transcode/report').send(STATUS).expect(200);
  });
  it('refuses a body that is no object; needs the gateway token', async () => {
    assert.equal((await gwReq('post', '/transcode/report').send([1, 2])).status, 400);
    assert.equal((await supertest(app).post('/api/v1/gateway/transcode/report').send(STATUS)).status, 401);
  });
});

describe('docker-compose.yml with the service umwandeln', () => {
  it('folders, user and the reported group of the device; devices only with a device; { transcode: false } by hand', async () => {
    let r = await admin('post', '/compose').send({ platform: 'synology', network: 'host' }).expect(200);
    const text = r.text || r.body.toString();
    assert.match(text, /\n {2}umwandeln:\n/);
    assert.match(text, /user: "1034:100"/);
    assert.match(text, /- "937"/);
    assert.match(text, /- "\/volume2\/mediathek:\/volume2\/mediathek"/);
    assert.match(text, /- "\/volume1\/Filme \(alt\):\/volume1\/Filme \(alt\)"/);
    assert.match(text, /- "GC_UMW_ROOTS=\/volume2\/mediathek:\/volume1\/Filme \(alt\)"/);
    assert.match(text, /\/dev\/dri\/renderD128/);
    assert.match(text, /source: umw-ctl/);
    r = await admin('post', '/compose').send({ platform: 'linux', network: 'host', transcode: false }).expect(200);
    assert.doesNotMatch(r.text || r.body.toString(), /\n {2}umwandeln:\n/);
    // no device on the host: no `devices:` in the service
    const st = JSON.parse(JSON.stringify(STATUS));
    st.caps.device = 'absent';
    await gwReq('post', '/transcode/report').send(st).expect(200);
    r = await admin('post', '/compose').send({ platform: 'synology', network: 'host' }).expect(200);
    const svc = (r.text || r.body.toString()).split('\n  umwandeln:\n')[1].split('\nvolumes:')[0];
    assert.doesNotMatch(svc, /devices:/);
    await gwReq('post', '/transcode/report').send(STATUS).expect(200);
  });
});

describe('gc.transcode in a plugin process', () => {
  it('installs with the permission shown, gc.transcode exists', async () => {
    const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(transcodePackage());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.plugin.permissions.transcode, true, 'shown in the install dialog');
    const ins = await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
    assert.equal(ins.status, 200, JSON.stringify(ins.body));
    let has = null;
    let last = null;
    for (let i = 0; i < 50 && !has; i++) {
      const x = await agent.post('/api/v1/plugins/transcode-demo/api/has').set('X-CSRF-Token', csrf).send({});
      if (x.status === 200) has = x.body; else { last = [x.status, x.body]; await new Promise((res) => setTimeout(res, 100)); }
    }
    assert.ok(has, JSON.stringify(last));
    assert.equal(has.transcode, true);
  });
  it('available(): the gateways with the capability or the switch', async () => {
    const a = (await call('/available')).result;
    assert.equal(a.available, true);
    assert.deepEqual(a.gateways.map((g) => [g.name, g.supported, g.enabled]), [['NAS Keller', true, true]]);
    const g = a.gateways[0];
    assert.equal(g.caps.deviceGid, 937);
    assert.deepEqual(g.settings, { roots: [ROOT, '/volume1/Filme (alt)'], software: false, trashDays: 14, quality: 23 });
  });
  it('report() and status(): the stored and the live state', async () => {
    const rep = (await call('/report', { gatewayId: gw.peer.id })).result;
    assert.equal(rep.jobs[0].id, 'k3J9x2Qw8LmN');
    assert.ok(rep.reportedAt);
    const st = (await call('/status', { gatewayId: gw.peer.id })).result;
    assert.equal(st.state, 'running');
    assert.equal(st.trash.length, 1);
    assert.equal(mgmt.at(-1).path, '/api/transcode/status');
  });
  it('submit: checks id and path, passes software: false and quality, maps the gateway codes', async () => {
    let r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000001', path: FILE, software: false, quality: 22 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(mgmt.at(-1).body, { id: 'job-00000001', path: FILE, software: false, quality: 22 });
    assert.equal(r.result.job.state, 'queued');
    const n = mgmt.length;
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'short', path: FILE });
    assert.deepEqual([r.code, r.reason], ['ERR_INVALID', 'invalid_request']);
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000002', path: '/volume3/anders/x.mkv' });
    assert.deepEqual([r.code, r.reason], ['ERR_INVALID', 'outside_roots']);
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000002', path: ROOT + '/../etc/x.mkv' });
    assert.deepEqual([r.code, r.reason], ['ERR_INVALID', 'bad_path']);
    r = await call('/submit', { gatewayId: gw2.peer.id, id: 'job-00000002', path: FILE });
    assert.deepEqual([r.code, r.reason], ['ERR_TRANSCODE_UNSUPPORTED', 'gateway_update']);
    assert.equal(mgmt.length, n, 'nothing reached the gateway');
    nextAnswer = { status: 409, body: { error: 'duplicate_id' } };
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000001', path: ROOT + '/b.mkv' });
    assert.deepEqual([r.code, r.reason], ['ERR_TRANSCODE_CONFLICT', 'duplicate_id']);
    nextAnswer = { status: 429, body: { error: 'queue_full' } };
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000003', path: FILE });
    assert.deepEqual([r.code, r.reason], ['ERR_TRANSCODE_BUSY', 'queue_full']);
    nextAnswer = { status: 409, body: { error: 'service_missing' } };
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000003', path: FILE });
    assert.deepEqual([r.code, r.reason], ['ERR_TRANSCODE_SERVICE', 'service_missing']);
    nextAnswer = { status: 503, body: { error: 'feature_disabled' } };
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000003', path: FILE });
    assert.deepEqual([r.code, r.reason], ['ERR_TRANSCODE_UNSUPPORTED', 'feature_disabled']);
    nextAnswer = null;
    gateways.mgmtCall = ((orig) => async (...a) => (a[1] === '/api/transcode/submit' ? null : orig(...a)))(gateways.mgmtCall);
    r = await call('/submit', { gatewayId: gw.peer.id, id: 'job-00000003', path: FILE });
    assert.deepEqual([r.code, r.reason], ['ERR_TRANSCODE_OFFLINE', 'offline']);
  });
  it('probe, pause / resume, cancel, ack, restore, purge', async () => {
    let r = await call('/probe', { gatewayId: gw.peer.id, path: ROOT + '/Film.mp4' });
    assert.deepEqual(r.result, { path: ROOT + '/Film.mp4', source: { codec: 'h264', profile: 'High 10', bits: 10, width: 1920, height: 1080 }, freeKb: 123456 });
    r = await call('/pause', { gatewayId: gw.peer.id, opts: { ttlSec: 180 } });
    assert.deepEqual(mgmt.at(-1).body, { ttlSec: 180 });
    assert.equal(r.result.pause.all, true);
    r = await call('/pause', { gatewayId: gw.peer.id, opts: { ttlSec: 5 } });
    assert.equal(r.code, 'ERR_INVALID');
    await call('/pause', { gatewayId: gw.peer.id, opts: { id: 'job-00000001' } });
    assert.deepEqual(mgmt.at(-1).body, { id: 'job-00000001' });
    await call('/resume', { gatewayId: gw.peer.id });
    assert.deepEqual([mgmt.at(-1).path, mgmt.at(-1).body], ['/api/transcode/resume', {}]);
    r = await call('/cancel', { gatewayId: gw.peer.id, id: 'job-00000001' });
    assert.equal(r.result.job.state, 'cancelled');
    r = await call('/ack', { gatewayId: gw.peer.id, ids: ['job-00000001', 'Zp40aa71Bc2d'] });
    assert.equal(r.result.removed, 2);
    r = await call('/ack', { gatewayId: gw.peer.id, ids: [] });
    assert.equal(r.code, 'ERR_INVALID');
    r = await call('/restore', { gatewayId: gw.peer.id, id: 'Zp40aa71Bc2d' });
    assert.deepEqual(r.result, { id: 'Zp40aa71Bc2d', restored: true });
    nextAnswer = { status: 422, body: { error: 'not_in_trash' } };
    r = await call('/restore', { gatewayId: gw.peer.id, id: 'Zp40aa71Bc2d' });
    assert.deepEqual([r.code, r.reason], ['ERR_TRANSCODE_FAILED', 'not_in_trash']);
    r = await call('/purge', { gatewayId: gw.peer.id, opts: { all: true } });
    assert.deepEqual([r.result, mgmt.at(-1).body], [{ purged: true }, { all: true }]);
    r = await call('/purge', { gatewayId: gw.peer.id, opts: { all: true, id: 'Zp40aa71Bc2d' } });
    assert.equal(r.code, 'ERR_INVALID');
    const acts = db.prepare("SELECT event_type FROM activity_log WHERE event_type LIKE 'transcode_%'").all().map((x) => x.event_type);
    assert.ok(acts.includes('transcode_submitted') && acts.includes('transcode_restored') && acts.includes('transcode_purged'));
  });
  it('settings: only trashDays and quality — into the config pull', async () => {
    let r = await call('/settings', { gatewayId: gw.peer.id, opts: { trashDays: 30, quality: 21 } });
    assert.deepEqual(r.result, { trashDays: 30, quality: 21 });
    const c = (await gwReq('get', '/config').expect(200)).body.features.transcode;
    assert.equal(c.trashDays, 30);
    assert.equal(c.quality, 21);
    r = await call('/settings', { gatewayId: gw.peer.id, opts: { software: true } });
    assert.equal(r.code, 'ERR_INVALID');
    r = await call('/settings', { gatewayId: gw.peer.id, opts: { trashDays: 400 } });
    assert.equal(r.code, 'ERR_INVALID');
  });
  it('hook transcodeChanged: a report reaches the plugin with gatewayId and the state', async () => {
    await gwReq('post', '/transcode/report').send({ ...STATUS, state: 'paused', pause: { all: true, until: '2026-11-27T03:00:00.000Z' } }).expect(200);
    let got = [];
    for (let i = 0; i < 50; i++) {
      got = (await call('/hooked')).result;
      if (got.some((e) => e.status && e.status.state === 'paused')) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const ev = got.find((e) => e.status && e.status.state === 'paused');
    assert.ok(ev, JSON.stringify(got).slice(0, 300));
    assert.equal(ev.gatewayId, gw.peer.id);
    assert.equal(ev.status.pause.all, true);
    assert.ok(Array.isArray(ev.status.trash));
  });
  it('the row only names the plugin „Medien“ (not any plugin with the permission)', async () => {
    const v = (await admin('get', '/features').expect(200)).body.gateway.transcode;
    assert.equal(v.plugin.installed, false, 'only the plugin „Medien“ counts');
  });
  it('a plugin without the permission has no gc.transcode', async () => {
    const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(helloPackage());
    assert.equal(r.status, 200);
    assert.equal(r.body.plugin.permissions.transcode, false);
  });
});

describe('gateway-pool-kit: the row and the chip', () => {
  const PK = require('../public/js/gateway-pool-kit');
  const base = { features: { netwatch: { enabled: true }, inetq: { enabled: true }, presence: { enabled: true }, ups: { enabled: false } } };
  it('in the group "Geräte im Heimnetz" after the cameras, a chip of the fleet card', () => {
    assert.deepEqual(PK.FEATURE_GROUPS.find((g) => g.key === 'devices').features.slice(0, 3), ['print', 'cameras', 'transcode']);
    assert.ok(PK.CHIP_KEYS.includes('transcode'));
    assert.deepEqual(PK.CHIP_KEYS, require('../src/services/gatewayFeatures').CHIP_KEYS);
  });
  it('featureStates: not on the Raspberry Pi image unless switched on', () => {
    const st = (tc) => PK.featureStates({ ...base, transcode: tc }).find((x) => x.key === 'transcode');
    assert.deepEqual(st({ enabled: false, platform: 'synology' }), { key: 'transcode', on: false });
    assert.equal(st({ enabled: false, platform: 'rpi' }), undefined);
    assert.deepEqual(st({ enabled: true, platform: 'rpi' }), { key: 'transcode', on: true });
  });
});
