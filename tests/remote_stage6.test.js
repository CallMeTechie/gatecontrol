'use strict';

// gc.remote, version 5 (stage 6 of the plugin "Fernzugriff", docs/plugins.md "The screen relay",
// docs/feature-remote-access.md): a screen ticket of mode control lets the viewer operate the phone. The
// mode in force is control only with the phone's hello control: true and the whole display shared; the
// phone goes down to view for good ({t:'mode', mode:'view'}). Input frames are cleaned, limited, passed on
// only in control and never logged.

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
  for (let i = 0; i < 50; i++) { try { if ((await pget('/has')).version >= 5) break; } catch { /* starting */ } await wait(100); }
});

after(async () => {
  screen._resetForTest();
  await new Promise((r) => server.close(r));
  await plugins.stop();
  teardown();
});


const VIEWER_HELLO = { t: 'hello', role: 'viewer', codecs: ['avc1'] };

/** A ticket, both sides connected and greeted → { r, s, v, sReady, vReady } */
async function pair({ mode = 'control', hello = {} } = {}) {
  const r = (await call('screen', { viewer: helperUser, sender: { user: owner, device: phone.tokenId }, target: { id: 'phone-1', name: 'Ilses Handy' }, mode })).result;
  const s = client((await tokenPost(phone.raw, { ref: r.senderRef }).expect(200)).body.token);
  const v = client((await tokenPost(helperApp.raw, { ref: r.ref }).expect(200)).body.token);
  await s.open(); await v.open();
  v.send(VIEWER_HELLO);
  const vReady = await v.frame('ready');
  s.send({ ...SENDER_HELLO, control: true, ...hello });
  const sReady = await s.frame('ready');
  return { r, s, v, sReady, vReady };
}

const inputs = (c) => c.frames.filter((f) => f.t === 'input');
const eventsOf = async (phase) => (await pget('/events')).result.filter((x) => x.protocol === 'screen' && x.phase === phase);

describe('the kit of the viewer page: input (no DOM)', () => {
  it('maps a point of the letterboxed picture to 0…1, nothing outside', () => {
    const rect = { left: 100, top: 0, width: 1000, height: 500 };
    // 720×1280 contained in 1000×500 → 281×500 centred
    assert.deepEqual(kit.toUnit(600, 250, rect, 720, 1280), { x: 0.5, y: 0.5 });
    assert.deepEqual(kit.toUnit(459.5, 0, rect, 720, 1280), { x: 0, y: 0 });
    assert.equal(kit.toUnit(300, 250, rect, 720, 1280), null, 'left of the picture');
    assert.equal(kit.toUnit(600, 250, rect, 0, 0), null, 'no picture yet');
  });
  it('a short press is a tap, a long one a long press, a movement a swipe (at most 32 points)', () => {
    assert.deepEqual(kit.gesture([{ x: 0.5, y: 0.5, t: 0 }, { x: 0.501, y: 0.5, t: 120 }]), { t: 'input', k: 'tap', x: 0.5, y: 0.5 });
    assert.deepEqual(kit.gesture([{ x: 0.5, y: 0.5, t: 0 }, { x: 0.5, y: 0.5, t: 900 }]), { t: 'input', k: 'long', x: 0.5, y: 0.5, ms: 900 });
    const pts = Array.from({ length: 100 }, (_, i) => ({ x: 0.1 + i * 0.008, y: 0.5, t: i * 10 }));
    const sw = kit.gesture(pts);
    assert.equal(sw.k, 'swipe');
    assert.equal(sw.pts.length, 32);
    assert.deepEqual(sw.pts[0], [0.1, 0.5]);
    assert.equal(sw.ms, 990);
    assert.ok(screen.cleanInput(sw), 'the server takes what the page builds');
    assert.equal(kit.gesture([]), null);
  });
  it('wheel, text and keys', () => {
    assert.deepEqual(kit.scroll({ x: 0.5, y: 0.5 }, 0, 100, 400, 1000), { t: 'input', k: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 });
    assert.equal(kit.scroll({ x: 0.5, y: 0.5 }, 0, 9000, 400, 1000).dy, 0.33);
    assert.equal(kit.scroll({ x: 0.5, y: 0.5 }, 0, 0, 400, 1000), null);
    assert.deepEqual(kit.textInput('Hallo\nWelt'), { t: 'input', k: 'text', text: 'HalloWelt' });
    assert.equal(kit.textInput(''), null);
    assert.equal(Array.from(kit.textInput('😀'.repeat(600)).text).length, 500);
    assert.deepEqual(kit.keyInput('recents'), { t: 'input', k: 'key', key: 'recents' });
    assert.equal(kit.keyInput('power'), null);
    assert.equal(kit.modeKey('nope'), 'remote.screen.mode_view.sender');
    assert.equal(kit.failKey('no_field'), 'remote.screen.fail.no_field');
    assert.equal(kit.noticeKey('x'), null);
  });
  it('every text of the page exists in German and English (also those of the script)', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    for (const k of ['remote.screen.control', 'remote.screen.key.back', 'remote.screen.mode_view.app_scope', 'remote.screen.fail.secure', 'remote.screen.notice.input_rate']) {
      assert.ok(de[k] && en[k], k);
    }
  });
});

describe('cleanInput: only the fields of the contract', () => {
  const C = () => require('../src/services/remote/screen').cleanInput;
  it('keeps taps, long presses, paths, scrolls, keys and text — rounded, without extra fields', () => {
    const c = C();
    assert.deepEqual(c({ t: 'input', k: 'tap', x: 0.123456, y: 1, extra: 'x' }), { t: 'input', k: 'tap', x: 0.1235, y: 1 });
    assert.deepEqual(c({ k: 'long', x: 0, y: 0.5 }), { t: 'input', k: 'long', x: 0, y: 0.5, ms: 650 });
    assert.deepEqual(c({ k: 'long', x: 0, y: 0.5, ms: 1200 }), { t: 'input', k: 'long', x: 0, y: 0.5, ms: 1200 });
    assert.deepEqual(c({ k: 'swipe', pts: [[0, 0], [0.5, 0.25]], ms: 300 }), { t: 'input', k: 'swipe', pts: [[0, 0], [0.5, 0.25]], ms: 300 });
    assert.deepEqual(c({ k: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.2 }), { t: 'input', k: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -0.2 });
    assert.deepEqual(c({ k: 'key', key: 'back' }), { t: 'input', k: 'key', key: 'back' });
    assert.deepEqual(c({ k: 'text', text: 'Grüße 👋' }), { t: 'input', k: 'text', text: 'Grüße 👋' });
  });
  it('drops anything else', () => {
    const c = C();
    for (const bad of [
      { k: 'tap', x: 1.01, y: 0 }, { k: 'tap', x: -0.1, y: 0 }, { k: 'tap', x: '0.5', y: 0.5 }, { k: 'tap', x: NaN, y: 0 }, { k: 'tap' },
      { k: 'long', x: 0, y: 0, ms: 100 }, { k: 'long', x: 0, y: 0, ms: 5000 },
      { k: 'swipe', pts: [[0, 0]], ms: 300 }, { k: 'swipe', pts: Array.from({ length: 33 }, () => [0, 0]), ms: 300 }, { k: 'swipe', pts: [[0, 0], [2, 0]], ms: 300 },
      { k: 'swipe', pts: [[0, 0], [1, 1]] }, { k: 'swipe', pts: [[0, 0], [1, 1]], ms: 6000 }, { k: 'swipe', pts: [[0, 0, 0], [1, 1]], ms: 300 },
      { k: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0 }, { k: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 2 },
      { k: 'key', key: 'power' }, { k: 'key', key: 'volume_up' },
      { k: 'text', text: '' }, { k: 'text', text: 'a\nb' }, { k: 'text', text: 'a\u0007' }, { k: 'text', text: 'x'.repeat(501) }, { k: 'text', text: 5 },
      { k: 'shell', cmd: 'reboot' }, null, 'tap',
    ]) assert.equal(c(bad), null, JSON.stringify(bad));
  });
});

describe('gc.remote.screen (version 5): mode control', () => {
  it('a ticket of mode control; the page says so', async () => {
    assert.equal((await pget('/has')).version, 5);
    const r = (await call('screen', { viewer: adminId, sender: { user: owner, device: phone.tokenId }, target: { id: 'phone-1', name: 'Ilses Handy' }, mode: 'control' })).result;
    assert.equal(r.mode, 'control');
    const page = await agent.get('/remote/session/' + r.ref).expect(200);
    assert.equal(pageCfg(page.text, 'rscreen-cfg').mode, 'control');
    assert.match(page.text, /rscreen-control/);
    await call('end', { ref: r.ref });
  });
});

describe('the relay in control: input to the phone', () => {
  let p;
  it('both hear mode control when the phone can carry input out', async () => {
    p = await pair();
    assert.equal(p.vReady.mode, 'control');
    assert.equal(p.sReady.mode, 'control');
  });

  it('a tap reaches the phone cleaned; a bad one does not', async () => {
    p.v.send({ t: 'input', k: 'tap', x: 0.25, y: 0.75, note: 'not passed on' });
    p.v.send({ t: 'input', k: 'tap', x: 3, y: 0.75 });
    p.v.send({ t: 'input', k: 'key', key: 'home' });
    await p.s.until((c) => inputs(c).length >= 2);
    await wait(100);
    assert.deepEqual(inputs(p.s), [{ t: 'input', k: 'tap', x: 0.25, y: 0.75 }, { t: 'input', k: 'key', key: 'home' }]);
  });

  it('the phone reports a failed input to the viewer (cleaned)', async () => {
    p.s.send({ t: 'input_fail', k: 'text', reason: 'no_field', secret: 'x' });
    p.s.send({ t: 'input_fail', k: '<b>', reason: 'whatever' });
    assert.deepEqual(await p.v.frame('input_fail'), { t: 'input_fail', k: 'text', reason: 'no_field' });
    assert.deepEqual(await p.v.frame('input_fail', 2), { t: 'input_fail', reason: 'blocked' });
  });

  it('30 inputs a second at most; text 5 a second', async () => {
    await wait(1100);
    const before = inputs(p.s).length;
    for (let i = 0; i < 45; i++) p.v.send({ t: 'input', k: 'tap', x: 0.5, y: 0.5 });
    assert.equal((await p.v.frame('notice')).code, 'input_rate');
    await wait(200);
    const n = inputs(p.s).length - before;
    assert.ok(n >= 28 && n <= 33, 'passed ' + n);
    await wait(1100);
    const t0 = inputs(p.s).length;
    for (let i = 0; i < 8; i++) p.v.send({ t: 'input', k: 'text', text: 'abc' });
    await wait(300);
    assert.equal(inputs(p.s).length - t0, 5);
  });

  it('the phone goes down to view: both hear it, input is dropped, the row and the hook follow — nothing of the input logged', async () => {
    p.s.send({ t: 'mode', mode: 'view', reason: 'sender' });
    assert.deepEqual(await p.v.frame('mode'), { t: 'mode', mode: 'view', reason: 'sender' });
    assert.equal((await p.s.frame('mode')).mode, 'view');
    await wait(1100);
    const n = inputs(p.s).length;
    p.v.send({ t: 'input', k: 'tap', x: 0.5, y: 0.5 });
    assert.equal((await p.v.until((c) => c.frames.filter((f) => f.t === 'notice' && f.code === 'view_only')[0])).code, 'view_only');
    await wait(100);
    assert.equal(inputs(p.s).length, n);
    // never up again over the relay
    p.s.send({ t: 'mode', mode: 'control' });
    await wait(100);
    p.v.send({ t: 'input', k: 'tap', x: 0.5, y: 0.5 });
    await wait(150);
    assert.equal(inputs(p.s).length, n);
    const row = db.prepare("SELECT * FROM remote_sessions WHERE protocol = 'screen' AND status = 'active' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.mode, 'view');
    let ev = null;
    for (let i = 0; i < 50 && !ev; i++) { ev = (await eventsOf('mode')).find((e) => e.ref === p.r.ref); if (!ev) await wait(50); }
    assert.ok(ev, 'hook phase mode');
    assert.deepEqual([ev.mode, ev.reason], ['view', 'sender']);
    const log = JSON.stringify(db.prepare("SELECT * FROM activity_log WHERE event_type LIKE 'remote_session_%'").all());
    assert.ok(log.includes('remote_session_mode'));
    assert.ok(!log.includes('abc') && !log.includes(p.r.ref) && !log.includes(p.r.senderRef));
  });

  it('a reconnect of the phone cannot bring control back', async () => {
    p.s.ws.terminate();
    await p.v.frame('waiting');
    const s2 = client((await tokenPost(phone.raw, { ref: p.r.senderRef }).expect(200)).body.token);
    await s2.open();
    s2.send({ ...SENDER_HELLO, control: true });
    assert.equal((await s2.frame('ready')).mode, 'view');
    await call('end', { ref: p.r.ref });
  });
});

describe('the relay: when control does not hold', () => {
  it('the phone cannot control (Play build, service off): view, the viewer hears why', async () => {
    const { r, s, v, sReady } = await pair({ hello: { control: false } });
    assert.equal(sReady.mode, 'view');
    assert.deepEqual(await v.frame('mode'), { t: 'mode', mode: 'view', reason: 'sender_no_control' });
    v.send({ t: 'input', k: 'tap', x: 0.5, y: 0.5 });
    await v.until((c) => c.frames.find((f) => f.t === 'notice'));
    assert.equal(inputs(s).length, 0);
    await call('end', { ref: r.ref });
  });

  it('only one app shared: view (app_scope)', async () => {
    const { r, v, sReady } = await pair({ hello: { scope: 'app' } });
    assert.equal(sReady.mode, 'view');
    assert.equal((await v.frame('mode')).reason, 'app_scope');
    await call('end', { ref: r.ref });
  });

  it('a ticket of mode view never passes input, even when the phone could', async () => {
    const { r, s, v, vReady, sReady } = await pair({ mode: 'view' });
    assert.deepEqual([vReady.mode, sReady.mode, sReady.modeReason], ['view', 'view', 'viewer_only']);
    v.send({ t: 'input', k: 'key', key: 'back' });
    assert.equal((await v.frame('notice')).code, 'view_only');
    assert.equal(inputs(s).length, 0);
    await call('end', { ref: r.ref });
  });
});
