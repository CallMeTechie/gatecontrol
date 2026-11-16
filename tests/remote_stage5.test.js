'use strict';

// gc.remote, version 4 (stage 5 of the plugin "Fernzugriff", docs/plugins.md "Remote access",
// docs/feature-remote-access.md): the screen relay gc-screen.v1 on /api/v1/remote/screen-relay. A phone
// (sender, its own app token) shares, one person watches (viewer: the session page or an app). The core
// passes H.264 frames on unchanged (key-frame gating for a new viewer), checks hello/config, counts
// bytes, ends both sides on bye, gc.remote.end or a lost side, and never logs a frame, ref or token.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const supertest = require('supertest');
const WebSocket = require('ws');
const { remotePackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const ID = 'gatecontrol-remote';
let app, agent, csrf, plugins, db, adminId, sessions, screen, server, port, H;
const call = async (api, args = {}) => (await agent.post(`/api/v1/plugins/${ID}/api/call`).set('X-CSRF-Token', csrf).send({ api, args }).expect(200)).body;
const pget = async (p) => (await agent.get(`/api/v1/plugins/${ID}/api${p}`).expect(200)).body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const kit = require('../public/js/remote-screen-kit.js');

function pageCfg(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]+)<`));
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&'));
}

/** A WebSocket client of gc-screen.v1 that keeps what came. */
function client(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/remote/screen-relay`, ['gc-screen.v1', 'token.' + token]);
  const c = { ws, frames: [], media: [], closed: false, status: null };
  ws.on('message', (d, bin) => { if (bin) c.media.push(Buffer.from(d)); else c.frames.push(JSON.parse(String(d))); });
  ws.on('close', () => { c.closed = true; });
  ws.on('unexpected-response', (req, res) => { c.status = res.statusCode; c.closed = true; });
  ws.on('error', () => { c.closed = true; });
  c.open = () => new Promise((resolve) => { if (ws.readyState === 1) resolve(true); ws.once('open', () => resolve(true)); ws.once('close', () => resolve(false)); ws.once('unexpected-response', () => resolve(false)); });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(c); if (v) return v; await wait(15); } throw new Error('timeout; frames ' + JSON.stringify(c.frames)); };
  c.frame = (t, n = 1) => c.until(() => { const l = c.frames.filter((f) => f.t === t); return l.length >= n ? l[n - 1] : null; });
  return c;
}

const frameOf = (key, ts, body) => Buffer.concat([screen.header({ key, ts }), Buffer.from(body)]);
const SENDER_HELLO = { t: 'hello', role: 'sender', width: 720, height: 1280, fps: 15, scope: 'display', app: { platform: 'android', version: '1.120.0' } };

async function install(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

const tokenPost = (raw, body) => supertest(app).post('/api/v1/client/remote/screen-token').set('X-API-Token', raw).set('X-Client-Platform', 'android').send(body);

/** The viewer's way in the browser: page → token. */
async function browserToken(ref) {
  const page = await agent.get('/remote/session/' + ref).expect(200);
  const cfg = pageCfg(page.text, 'rscreen-cfg');
  const t = await agent.post(`/remote/session/${ref}/token`).set('X-CSRF-Token', cfg.csrf).expect(200);
  return { page, cfg, token: t.body };
}

let owner, phone, helperUser, helperApp;

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  db = require('../src/db/connection').getDb();
  sessions = require('../src/services/remote/sessions');
  screen = require('../src/services/remote/screen');
  H = require('./helpers/notify');
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  owner = H.makeUser('screen-ilse');
  phone = H.makeDevice(owner, { name: 'ilse-phone', platform: 'android' });
  helperUser = H.makeUser('screen-tom');
  helperApp = H.makeDevice(helperUser, { name: 'tom-phone', platform: 'android' });
  server = http.createServer(app);
  require('../src/tunnel/screenTunnel').attachScreenTunnel(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  await install(remotePackage());
  for (let i = 0; i < 50; i++) { try { if ((await pget('/has')).version >= 4) break; } catch { /* starting */ } await wait(100); }
});

after(async () => {
  screen._resetForTest();
  await new Promise((r) => server.close(r));
  await plugins.stop();
  teardown();
});

describe('the kit of the viewer page (no DOM)', () => {
  it('reads the frame head, builds the decoder configuration, names reasons and errors', () => {
    const f = kit.parseMedia(new Uint8Array(frameOf(true, 2 ** 33 + 5, [0, 0, 0, 1, 0x65])));
    assert.deepEqual([f.key, f.ts, [...f.data]], [true, 2 ** 33 + 5, [0, 0, 0, 1, 0x65]]);
    assert.equal(kit.parseMedia(new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9])), null, 'another version');
    assert.equal(kit.parseMedia(new Uint8Array(12)), null, 'no payload');
    assert.deepEqual(kit.decoderConfig({ codec: 'avc1.42E01F', width: 720, height: 1280 }), { codec: 'avc1.42E01F', codedWidth: 720, codedHeight: 1280, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
    assert.equal(kit.decoderConfig({ codec: 'vp8', width: 1, height: 1 }), null);
    assert.equal(kit.endKey('sender'), 'remote.screen.end.sender');
    assert.equal(kit.endKey('<x>'), 'remote.screen.end.other');
    assert.equal(kit.errorKey('nope'), 'remote.screen.err.failed');
    assert.equal(kit.isFinal('not_found'), true);
    assert.deepEqual(kit.fit(720, 1280, 1000, 500), { width: 281, height: 500 });
    assert.equal(kit.backoff(4), null);
  });
  it('every text of the page exists in German and English', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const tpl = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'templates', 'aurora', 'pages', 'remote-screen.njk'), 'utf8');
    const keys = [...tpl.matchAll(/t\('(remote\.screen\.[a-z_.]+)'\)/g)].map((m) => m[1]);
    assert.ok(keys.length > 20);
    for (const k of keys) { assert.ok(de[k], 'de ' + k); assert.ok(en[k], 'en ' + k); }
  });
});

describe('gc.remote.screen (version 4): the ticket', () => {
  it('checks viewer, sender device, mode, recording and target', async () => {
    assert.ok((await pget('/has')).version >= 4);
    const T = { id: 'phone-1', name: 'Ilses Handy' };
    assert.equal((await call('screen', { viewer: 999999, sender: { user: owner, device: phone.tokenId }, target: T })).code, 'ERR_NOT_FOUND');
    assert.equal((await call('screen', { viewer: adminId, sender: { user: owner, device: helperApp.tokenId }, target: T })).code, 'ERR_REMOTE_NOT_ALLOWED', 'not her phone');
    assert.equal((await call('screen', { viewer: adminId, sender: { user: owner, device: 'x' }, target: T })).code, 'ERR_INVALID');
    assert.equal((await call('screen', { viewer: adminId, sender: { user: owner, device: phone.tokenId }, target: T, mode: 'edit' })).code, 'ERR_INVALID', 'only view or control');
    assert.equal((await call('screen', { viewer: adminId, sender: { user: owner, device: phone.tokenId }, target: T, record: true })).code, 'ERR_REMOTE_RECORDING_UNAVAILABLE');
    assert.equal((await call('screen', { viewer: adminId, sender: { user: owner, device: phone.tokenId }, target: { id: 'a b' } })).code, 'ERR_INVALID');
    const r = await call('screen', { viewer: adminId, sender: { user: owner, device: phone.tokenId }, target: T });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.result.protocol, r.result.engine, r.result.mode, r.result.record], ['screen', 'screen', 'view', false]);
    assert.match(r.result.ref, /^[A-Za-z0-9_-]{43}$/);
    assert.match(r.result.senderRef, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(r.result.ref, r.result.senderRef);
    assert.deepEqual((await call('end', { ref: r.result.senderRef })).result, { ended: 0 }, 'either ref ends it');
    await tokenPost(phone.raw, { ref: r.result.senderRef }).expect(404);
  });
});

describe('screen tokens: the phone for its side, the viewer for the other', () => {
  it('only the named phone gets the sender side; a viewer app binds the viewer side; no terminal token', async () => {
    const r = (await call('screen', { viewer: helperUser, sender: { user: owner, device: phone.tokenId }, target: { id: 'phone-1', name: 'Ilses Handy' } })).result;
    await tokenPost(helperApp.raw, { ref: r.senderRef }).expect(404);
    const other = H.makeDevice(owner, { name: 'ilse-tablet', platform: 'android' });
    assert.equal((await tokenPost(other.raw, { ref: r.senderRef })).status, 404, 'another device of the same person');
    assert.equal((await tokenPost(phone.raw, { ref: r.ref })).status, 404, 'the owner is not the viewer');
    const s = await tokenPost(phone.raw, { ref: r.senderRef }).expect(200);
    assert.deepEqual([s.body.role, s.body.wsPath, s.body.ttl], ['sender', '/api/v1/remote/screen-relay', 60]);
    const v = await tokenPost(helperApp.raw, { ref: r.ref }).expect(200);
    assert.equal(v.body.role, 'viewer');
    await supertest(app).post('/api/v1/client/remote/term-token').set('X-API-Token', helperApp.raw).set('X-Client-Platform', 'android').send({ ref: r.ref }).expect(404);
    // the viewer side is bound to that app now: the browser cannot take it
    await agent.get('/remote/session/' + r.ref).expect(404);
    await call('end', { ref: r.ref });
  });

  it('an upgrade without a valid token is refused (401)', async () => {
    const c = client('A'.repeat(43));
    assert.equal(await c.open(), false);
    assert.equal(c.status, 401);
  });
});

describe('the relay: hello, key-frame gating, frames unchanged, bye', () => {
  let r;
  let sender;
  let viewer;
  it('the page is the viewer; the browser token is a gc-screen.v1 token', async () => {
    r = (await call('screen', { viewer: adminId, sender: { user: owner, device: phone.tokenId }, target: { id: 'phone-1', name: 'Ilses Handy' } })).result;
    const b = await browserToken(r.ref);
    assert.match(b.page.text, /remote-screen\.js/);
    assert.equal(b.cfg.mode, 'view');
    assert.deepEqual([b.token.engine, b.token.wsPath], ['screen', '/api/v1/remote/screen-relay']);
    assert.ok(!b.page.text.includes(r.senderRef), 'the page never names the sender side');
    viewer = client(b.token.token);
    assert.equal(await viewer.open(), true);
    assert.equal(viewer.ws.protocol, 'gc-screen.v1');
    viewer.send({ t: 'hello', role: 'viewer', codecs: ['avc1'] });
    const ready = await viewer.frame('ready');
    assert.deepEqual([ready.role, ready.mode, ready.peer.name, ready.limits.maxFrame], ['viewer', 'view', 'Ilses Handy', 1024 * 1024]);
    await viewer.frame('waiting');
  });

  it('the phone joins: it hears who watches and is asked for a key frame', async () => {
    const s = await tokenPost(phone.raw, { ref: r.senderRef }).expect(200);
    sender = client(s.body.token);
    await sender.open();
    sender.send(SENDER_HELLO);
    const ready = await sender.frame('ready');
    assert.equal(ready.role, 'sender');
    assert.ok(ready.peer.name, 'the name of the person who watches');
    assert.equal((await sender.frame('viewer')).state, 'joined');
    await sender.frame('keyframe');
    const live = (await call('sessions', { active: true })).result.find((x) => x.protocol === 'screen');
    assert.deepEqual([live.engine, live.via, live.userId, live.mode, live.targetId], ['screen', 'browser', adminId, 'view', 'phone-1']);
    const ev = await (async () => { for (let i = 0; i < 50; i++) { const e = (await pget('/events')).result.find((x) => x.protocol === 'screen' && x.phase === 'start'); if (e) return e; await wait(50); } return null; })();
    assert.ok(ev, 'hook start');
    assert.equal(ev.ref, r.ref);
  });

  it('config first, then only from a key frame on — bytes unchanged', async () => {
    sender.send({ t: 'config', codec: 'avc1.42E01F', width: 720, height: 1280 });
    assert.deepEqual(await viewer.frame('config'), { t: 'config', codec: 'avc1.42E01F', width: 720, height: 1280 });
    sender.ws.send(frameOf(false, 1000, 'delta-before-key'));
    const key = frameOf(true, 2000, 'KEY-with-sps-pps');
    sender.ws.send(key);
    sender.ws.send(frameOf(false, 3000, 'delta-1'));
    await viewer.until((c) => c.media.length >= 2);
    assert.ok(viewer.media[0].equals(key), 'the key frame, byte for byte');
    assert.equal(viewer.media[1].subarray(12).toString(), 'delta-1');
    assert.ok(!viewer.media.some((m) => m.subarray(12).toString() === 'delta-before-key'), 'no delta before the first key frame');
    // a viewer sends no pictures; its input is dropped in view mode (stage 6: only with mode control)
    viewer.ws.send(frameOf(true, 1, 'from-viewer'));
    viewer.send({ t: 'input', k: 'tap', x: 0.5, y: 0.5 });
    assert.equal((await viewer.frame('notice')).code, 'view_only');
    sender.send({ t: 'state', paused: true, reason: 'locked' });
    assert.deepEqual(await viewer.frame('state'), { t: 'state', paused: true, reason: 'locked' });
    assert.equal(sender.media.length, 0);
    viewer.send({ t: 'ping' });
    await viewer.frame('pong');
  });

  it('the phone ends it: both hear end sender, the row ends normally, the ticket is gone', async () => {
    sender.send({ t: 'bye' });
    assert.equal((await viewer.frame('end')).reason, 'sender');
    assert.equal((await sender.frame('end')).reason, 'sender');
    await viewer.until((c) => c.closed);
    const row = db.prepare("SELECT * FROM remote_sessions WHERE protocol = 'screen' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual([row.status, row.end_reason, row.engine], ['ended', 'sender', 'screen']);
    await tokenPost(phone.raw, { ref: r.senderRef }).expect(404);
    const ev = await (async () => { for (let i = 0; i < 50; i++) { const e = (await pget('/events')).result.find((x) => x.protocol === 'screen' && x.phase === 'end'); if (e) return e; await wait(50); } return null; })();
    assert.equal(ev.reason, 'sender');
    // nothing of a ref or a token in the activity log
    const log = JSON.stringify(db.prepare("SELECT * FROM activity_log WHERE event_type LIKE 'remote_session_%'").all());
    assert.ok(!log.includes(r.ref) && !log.includes(r.senderRef));
  });
});

describe('the relay: checks, reconnect, gc.remote.end, limits', () => {
  async function pair() {
    const r = (await call('screen', { viewer: helperUser, sender: { user: owner, device: phone.tokenId }, target: { id: 'phone-1', name: 'Ilses Handy' } })).result;
    const s = client((await tokenPost(phone.raw, { ref: r.senderRef }).expect(200)).body.token);
    const v = client((await tokenPost(helperApp.raw, { ref: r.ref }).expect(200)).body.token);
    await s.open(); await v.open();
    s.send(SENDER_HELLO);
    v.send({ t: 'hello', role: 'viewer', codecs: ['avc1'] });
    await s.frame('ready'); await v.frame('ready');
    return { r, s, v };
  }

  it('a wrong role and an oversized picture are refused', async () => {
    const r = (await call('screen', { viewer: helperUser, sender: { user: owner, device: phone.tokenId }, target: { id: 'phone-1' } })).result;
    const s = client((await tokenPost(phone.raw, { ref: r.senderRef }).expect(200)).body.token);
    await s.open();
    s.send({ t: 'hello', role: 'viewer' });
    assert.equal((await s.frame('error')).code, 'role_mismatch');
    const s2 = client((await tokenPost(phone.raw, { ref: r.senderRef }).expect(200)).body.token);
    await s2.open();
    s2.send({ ...SENDER_HELLO, width: 4000, height: 3000 });
    assert.equal((await s2.frame('error')).code, 'bad_frame');
    await call('end', { ref: r.ref });
  });

  it('a lost phone: the viewer waits, the phone comes back with a new token and is asked for a key frame', async () => {
    const { r, s, v } = await pair();
    s.ws.terminate();
    assert.equal((await v.frame('waiting')).reason, 'sender_lost');
    const s2 = client((await tokenPost(phone.raw, { ref: r.senderRef }).expect(200)).body.token);
    await s2.open();
    s2.send(SENDER_HELLO);
    await s2.frame('ready');
    await s2.frame('keyframe');
    assert.equal((await v.frame('state')).paused, false);
    // a bad config ends it
    s2.send({ t: 'config', codec: 'avc1.42E01F', width: 99999, height: 2 });
    assert.equal((await v.frame('end')).reason, 'bad_frame');
    assert.equal(sessions._ticketForTest(r.ref), null);
  });

  it('gc.remote.end with the sender ref ends both sides (ended_by_plugin)', async () => {
    const { r, s, v } = await pair();
    assert.deepEqual((await call('end', { ref: r.senderRef })).result, { ended: 1 });
    assert.equal((await v.frame('end')).reason, 'ended_by_plugin');
    assert.equal((await s.frame('end')).reason, 'ended_by_plugin');
  });

  it('one session per phone and GC_REMOTE_SCREEN_MAX overall', async () => {
    const cfg = require('../config/default');
    const { r } = await pair();
    const r2 = (await call('screen', { viewer: helperUser, sender: { user: owner, device: phone.tokenId }, target: { id: 'phone-1' } })).result;
    assert.equal((await tokenPost(phone.raw, { ref: r2.senderRef })).status, 429, 'the phone shares already');
    const old = cfg.remoteScreen.max;
    cfg.remoteScreen.max = 1;
    try {
      assert.equal((await tokenPost(helperApp.raw, { ref: r2.ref })).status, 429, 'the server is full');
    } finally { cfg.remoteScreen.max = old; }
    await call('end', { ref: r.ref });
    await call('end', { ref: r2.ref });
  });
});
