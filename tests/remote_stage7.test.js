'use strict';

// gc.remote, version 6 (stage 7 of the plugin "Fernzugriff", docs/plugins.md "The screen relay",
// docs/feature-remote-access.md): a Windows PC shares its screen through the same relay. Its hello says
// input 'desktop' and names its displays; the viewer hears that ({t:'sender'}, ready.sender). Only to a
// desktop sender and only in control: move, button, wheel, kbd. Moves have a bucket of their own, a release
// never falls to the limits, the viewer may pick a display. Nothing of an input is logged.

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

const tokenPost = (raw, body, platform = 'android') => supertest(app).post('/api/v1/client/remote/screen-token').set('X-API-Token', raw).set('X-Client-Platform', platform).send(body);

/** The viewer's way in the browser: page → token. */
async function browserToken(ref) {
  const page = await agent.get('/remote/session/' + ref).expect(200);
  const cfg = pageCfg(page.text, 'rscreen-cfg');
  const t = await agent.post(`/remote/session/${ref}/token`).set('X-CSRF-Token', cfg.csrf).expect(200);
  return { page, cfg, token: t.body };
}

let owner, phone, pc, helperUser, helperApp;

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
  pc = H.makeDevice(owner, { name: 'ilse-pc', platform: 'windows' });
  helperUser = H.makeUser('screen-tom');
  helperApp = H.makeDevice(helperUser, { name: 'tom-phone', platform: 'android' });
  server = http.createServer(app);
  require('../src/tunnel/screenTunnel').attachScreenTunnel(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  await install(remotePackage());
  for (let i = 0; i < 50; i++) { try { if ((await pget('/has')).version >= 6) break; } catch { /* starting */ } await wait(100); }
});

after(async () => {
  screen._resetForTest();
  await new Promise((r) => server.close(r));
  await plugins.stop();
  teardown();
});


const VIEWER_HELLO = { t: 'hello', role: 'viewer', codecs: ['avc1'] };
const PC_HELLO = { t: 'hello', role: 'sender', width: 1920, height: 1080, fps: 15, scope: 'display', input: 'desktop', control: true,
  app: { platform: 'windows', version: '1.97.0' }, displays: [{ i: 0, primary: true, w: 2560, h: 1440 }, { i: 1, w: 1920, h: 1080, name: 'not passed' }], display: 0 };

/** A ticket of a PC (or a phone), both sides greeted → { r, s, v, sReady, vReady } */
async function pair({ mode = 'control', hello = PC_HELLO, viewerFirst = true, dev = pc, platform = 'windows' } = {}) {
  const r = (await call('screen', { viewer: helperUser, sender: { user: owner, device: dev.tokenId }, target: { id: 'pc-1', name: 'Ilses PC' }, mode })).result;
  const s = client((await tokenPost(dev.raw, { ref: r.senderRef }, platform).expect(200)).body.token);
  const v = client((await tokenPost(helperApp.raw, { ref: r.ref }).expect(200)).body.token);
  await s.open(); await v.open();
  let vReady, sReady;
  if (viewerFirst) {
    v.send(VIEWER_HELLO); vReady = await v.frame('ready');
    s.send(hello); sReady = await s.frame('ready');
  } else {
    s.send(hello); sReady = await s.frame('ready');
    v.send(VIEWER_HELLO); vReady = await v.frame('ready');
  }
  return { r, s, v, sReady, vReady };
}

const inputs = (c) => c.frames.filter((f) => f.t === 'input');

describe('stage 7: cleaning (no relay)', () => {
  const c = (m, kind) => screen.cleanInput(m, kind);
  it('the desktop kinds go only to a desktop sender', () => {
    assert.deepEqual(c({ k: 'move', x: 0.123456, y: 1 }, 'desktop'), { t: 'input', k: 'move', x: 0.1235, y: 1 });
    assert.deepEqual(c({ k: 'button', b: 'right', down: true, x: 0.5, y: 0.5, extra: 1 }, 'desktop'), { t: 'input', k: 'button', b: 'right', down: true, x: 0.5, y: 0.5 });
    assert.deepEqual(c({ k: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: -240 }, 'desktop'), { t: 'input', k: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: -240 });
    assert.deepEqual(c({ k: 'kbd', code: 'KeyA', down: true }, 'desktop'), { t: 'input', k: 'kbd', code: 'KeyA', down: true });
    for (const code of ['Digit0', 'F24', 'Numpad7', 'ControlLeft', 'MetaRight', 'ArrowDown', 'NumpadEnter']) assert.ok(c({ k: 'kbd', code, down: false }, 'desktop'), code);
    assert.equal(c({ k: 'move', x: 0.5, y: 0.5 }), null, 'never to a phone');
    assert.equal(c({ k: 'kbd', code: 'KeyA', down: true }, 'touch'), null);
    assert.deepEqual(c({ k: 'tap', x: 0.5, y: 0.5 }, 'desktop'), { t: 'input', k: 'tap', x: 0.5, y: 0.5 }, 'the phone kinds stay for a PC');
    for (const bad of [
      { k: 'move', x: -0.1, y: 0 }, { k: 'button', b: 'back', down: true, x: 0, y: 0 }, { k: 'button', b: 'left', down: 1, x: 0, y: 0 },
      { k: 'wheel', x: 0, y: 0, dx: 0, dy: 0 }, { k: 'wheel', x: 0, y: 0, dx: 0, dy: 1201 }, { k: 'wheel', x: 0, y: 0, dx: 0.5, dy: 0 },
      { k: 'kbd', code: 'OSLeft', down: true }, { k: 'kbd', code: 'F25', down: true }, { k: 'kbd', code: 'KeyAA', down: true }, { k: 'kbd', code: 'KeyA' },
      { k: 'kbd', code: 'Power', down: true }, { k: 'kbd', code: 'AudioVolumeUp', down: true },
    ]) assert.equal(c(bad, 'desktop'), null, JSON.stringify(bad));
  });
  it('displays: index, main and size only, at most 8, the shared one must be listed', () => {
    assert.deepEqual(screen.cleanDisplays({ displays: [{ i: 0, primary: true, w: 1920, h: 1080, name: 'DELL' }], display: 0 }),
      { displays: [{ i: 0, primary: true, w: 1920, h: 1080 }], display: 0 });
    assert.equal(screen.cleanDisplays({}), null);
    for (const bad of [{ displays: [] }, { displays: [{ i: 0, w: 1, h: 1 }] }, { displays: [{ i: 0, w: 800, h: 600 }], display: 2 },
      { displays: [{ i: 0, w: 800, h: 600 }, { i: 0, w: 800, h: 600 }] }, { displays: Array.from({ length: 9 }, (_, i) => ({ i, w: 800, h: 600 })) }, { displays: 'x' }]) {
      assert.equal(screen.cleanDisplays(bad), false, JSON.stringify(bad));
    }
  });
  it('the kit builds what the relay takes', () => {
    assert.deepEqual(kit.senderInfo({ platform: 'windows', input: 'desktop', displays: [{ i: 0, primary: true, w: 800, h: 600 }], display: 0 }),
      { platform: 'windows', input: 'desktop', displays: [{ i: 0, primary: true, w: 800, h: 600 }], display: 0 });
    assert.equal(kit.senderInfo(null).input, 'touch');
    assert.deepEqual(kit.wheelInput({ x: 0.5, y: 0.5 }, 0, 100), { t: 'input', k: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: -120 });
    assert.equal(kit.wheelInput({ x: 0.5, y: 0.5 }, 0, 99999).dy, -1200);
    assert.equal(kit.wheelInput({ x: 0.5, y: 0.5 }, 0, 0), null);
    assert.equal(kit.kbdInput('OSLeft', true), null);
    assert.deepEqual([kit.buttonName(0), kit.buttonName(1), kit.buttonName(2), kit.buttonName(3)], ['left', 'middle', 'right', null]);
    for (const f of [kit.kbdInput('KeyQ', true), kit.buttonInput('left', true, { x: 0.1, y: 0.2 }), kit.moveInput({ x: 0.3, y: 0.4 }), kit.wheelInput({ x: 0, y: 1 }, 50, 0)]) {
      assert.deepEqual(screen.cleanInput(f, 'desktop'), f);
    }
    assert.deepEqual(kit.releaseAll(['ShiftLeft', 'KeyA'], ['left'], { x: 0.2, y: 0.3 }), [
      { t: 'input', k: 'kbd', code: 'ShiftLeft', down: false }, { t: 'input', k: 'kbd', code: 'KeyA', down: false },
      { t: 'input', k: 'button', b: 'left', down: false, x: 0.2, y: 0.3 }]);
  });
});

describe('stage 7: a PC as sender', () => {
  let p;
  it('the viewer hears what sends (platform, input, displays without names)', async () => {
    p = await pair();
    assert.deepEqual([p.vReady.mode, p.sReady.mode], ['control', 'control']);
    const s = await p.v.frame('sender');
    assert.deepEqual(s, { t: 'sender', platform: 'windows', input: 'desktop', displays: [{ i: 0, primary: true, w: 2560, h: 1440 }, { i: 1, primary: false, w: 1920, h: 1080 }], display: 0 });
  });

  it('mouse and keyboard reach the PC cleaned', async () => {
    p.v.send({ t: 'input', k: 'move', x: 0.25, y: 0.5 });
    p.v.send({ t: 'input', k: 'button', b: 'left', down: true, x: 0.25, y: 0.5 });
    p.v.send({ t: 'input', k: 'button', b: 'left', down: false, x: 0.3, y: 0.5 });
    p.v.send({ t: 'input', k: 'wheel', x: 0.3, y: 0.5, dx: 0, dy: -120 });
    p.v.send({ t: 'input', k: 'kbd', code: 'ControlLeft', down: true, secret: 'x' });
    p.v.send({ t: 'input', k: 'kbd', code: 'Power', down: true });
    p.v.send({ t: 'input', k: 'kbd', code: 'ControlLeft', down: false });
    await p.s.until((c) => inputs(c).length >= 6);
    await wait(100);
    assert.deepEqual(inputs(p.s).map((f) => f.k + (f.b || f.code || '') + (f.down === undefined ? '' : f.down)), [
      'move', 'buttonlefttrue', 'buttonleftfalse', 'wheel', 'kbdControlLefttrue', 'kbdControlLeftfalse']);
  });

  it('the PC reports a failed input of a desktop kind', async () => {
    p.s.send({ t: 'input_fail', k: 'kbd', reason: 'secure' });
    assert.deepEqual(await p.v.frame('input_fail'), { t: 'input_fail', k: 'kbd', reason: 'secure' });
  });

  it('moves: a bucket of their own, without a notice; a release always passes', async () => {
    await wait(1100);
    const m0 = inputs(p.s).filter((f) => f.k === 'move').length;
    for (let i = 0; i < 45; i++) p.v.send({ t: 'input', k: 'move', x: 0.5, y: i / 100 });
    await wait(300);
    const moved = inputs(p.s).filter((f) => f.k === 'move').length - m0;
    assert.ok(moved >= 28 && moved <= 33, 'moves passed ' + moved);
    assert.ok(!p.v.frames.some((f) => f.t === 'notice'), 'no notice for moves');
    await wait(1100);
    const k0 = inputs(p.s).length;
    for (let i = 0; i < 40; i++) p.v.send({ t: 'input', k: 'kbd', code: 'KeyA', down: true });
    p.v.send({ t: 'input', k: 'kbd', code: 'KeyA', down: false });
    p.v.send({ t: 'input', k: 'button', b: 'left', down: false, x: 0.5, y: 0.5 });
    assert.equal((await p.v.frame('notice')).code, 'input_rate');
    await wait(300);
    const got = inputs(p.s).slice(k0);
    assert.ok(got.length <= 34, 'limited ' + got.length);
    assert.deepEqual(got.slice(-2).map((f) => f.down), [false, false], 'the releases came through');
  });

  it('the viewer picks a display (also in view); a bad index goes nowhere; the PC tells the change', async () => {
    p.v.send({ t: 'display', i: 1 });
    p.v.send({ t: 'display', i: 5 });
    assert.deepEqual(await p.s.frame('display'), { t: 'display', i: 1 });
    await wait(100);
    assert.equal(p.s.frames.filter((f) => f.t === 'display').length, 1);
    p.s.send({ t: 'displays', displays: [{ i: 0, primary: true, w: 2560, h: 1440 }, { i: 1, w: 1920, h: 1080 }], display: 1 });
    assert.equal((await p.v.frame('sender', 2)).display, 1);
  });

  it('down to view: no more input, the PC hears the mode', async () => {
    p.s.send({ t: 'mode', mode: 'view', reason: 'sender' });
    await p.v.frame('mode');
    await wait(1100);
    const n = inputs(p.s).length;
    p.v.send({ t: 'input', k: 'kbd', code: 'KeyA', down: true });
    p.v.send({ t: 'input', k: 'move', x: 0.5, y: 0.5 });
    await p.v.until((c) => c.frames.find((f) => f.t === 'notice' && f.code === 'view_only'));
    await wait(100);
    assert.equal(inputs(p.s).length, n);
    // picking a display is watching: it still works
    p.v.send({ t: 'display', i: 0 });
    assert.deepEqual(await p.s.frame('display', 2), { t: 'display', i: 0 });
    const log = JSON.stringify(db.prepare("SELECT * FROM activity_log WHERE event_type LIKE 'remote_session_%'").all());
    assert.ok(!log.includes('ControlLeft') && !log.includes('KeyA') && !log.includes(p.r.ref));
    await call('end', { ref: p.r.ref });
  });

  it('a viewer that comes after the PC finds it in ready', async () => {
    const q = await pair({ viewerFirst: false });
    assert.deepEqual(q.vReady.sender, { platform: 'windows', input: 'desktop', displays: [{ i: 0, primary: true, w: 2560, h: 1440 }, { i: 1, primary: false, w: 1920, h: 1080 }], display: 0 });
    await call('end', { ref: q.r.ref });
  });

  it('a hello with a bad display list is refused; a bad update ends the session', async () => {
    const r = (await call('screen', { viewer: helperUser, sender: { user: owner, device: pc.tokenId }, target: { id: 'pc-1', name: 'Ilses PC' }, mode: 'control' })).result;
    const s = client((await tokenPost(pc.raw, { ref: r.senderRef }, 'windows').expect(200)).body.token);
    await s.open();
    s.send({ ...PC_HELLO, displays: [{ i: 0, w: 2, h: 2 }] });
    assert.equal((await s.frame('error')).code, 'bad_frame');
    await call('end', { ref: r.ref });
    const z = await pair();
    z.s.send({ t: 'displays', displays: [] });
    assert.equal((await z.v.frame('end')).reason, 'bad_frame');
  });
});

describe('stage 7: a phone stays a phone', () => {
  it('desktop input to a touch sender is dropped', async () => {
    const q = await pair({ dev: phone, platform: 'android', hello: { t: 'hello', role: 'sender', width: 720, height: 1280, fps: 15, scope: 'display', control: true, app: { platform: 'android', version: '1' } } });
    assert.equal((await q.v.frame('sender')).input, 'touch');
    q.v.send({ t: 'input', k: 'kbd', code: 'KeyA', down: true });
    q.v.send({ t: 'input', k: 'move', x: 0.5, y: 0.5 });
    q.v.send({ t: 'input', k: 'tap', x: 0.5, y: 0.5 });
    await q.s.until((c) => inputs(c).length >= 1);
    await wait(150);
    assert.deepEqual(inputs(q.s).map((f) => f.k), ['tap']);
    await call('end', { ref: q.r.ref });
  });
});
