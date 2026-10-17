'use strict';

// Realtime events of plugins (docs/plugins.md "Realtime events",
// src/services/plugins/events.js): permissions.events, gc.events.emit({ users,
// type, data }) → `event: plugin` { plugin, type, data } on the apps' push
// stream (GET /api/v1/client/push) and on the frame streams of the admin page
// (GET /api/v1/plugins/<id>/events) and the portal (GET
// /api/v1/portal/plugins/<id>/events); the frame client (GC.on, GC.upload) and
// the parent page (public/js/plugin-bridge.js) relaying events and uploads.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const supertest = require('supertest');
const { CookieAccessInfo } = require('cookiejar');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, runtime, plugins, manifest, events, frame, server, port, anna, annaDev, annaTab, ben, benDev, adminId;
const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
// values made inside a vm context (other prototypes) → plain values of this realm
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const emit = (id, body) => agent.post(`${API}/${id}/api/events`).set('X-CSRF-Token', csrf).send(body);

/** SSE over a real connection with the admin session's cookies → { status, events, waitFor, close } */
function openSse(pathname, { cookies = true } = {}) {
  const cookie = cookies ? agent.jar.getCookies(CookieAccessInfo.All).toValueString() : '';
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      const evs = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const ev = {};
          for (const line of block.split('\n')) {
            const m = /^(\w+): ?(.*)$/.exec(line);
            if (m) ev[m[1]] = m[1] === 'data' ? JSON.parse(m[2]) : m[2];
          }
          evs.push(ev);
        }
      });
      resolve({
        status: res.statusCode, events: evs,
        async waitFor(pred, ms = 3000) {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const hit = evs.find(pred); if (hit) return hit; await H.sleep(20); }
          throw new Error('timeout; got ' + JSON.stringify(evs));
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
  });
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  events = require('../src/services/plugins/events');
  frame = require('../src/services/plugins/frame');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('ev-anna');
  ben = H.makeUser('ev-ben');
  annaDev = H.makeDevice(anna, { name: 'ev-anna-phone' });
  annaTab = H.makeDevice(anna, { name: 'ev-anna-tablet' });
  benDev = H.makeDevice(ben, { name: 'ev-ben-phone' });
  await install(helloPackage({ overrides: { id: 'hello-ev', name: 'Live', permissions: { ...clone(helloManifest.permissions), events: true } } }));
  await install(helloPackage({ overrides: { id: 'hello-quiet', name: 'Leise' } }));
  for (const id of ['hello-ev', 'hello-quiet']) assert.equal(await runtime.waitRunning(id), true, id);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  events.closeStreams();
  require('../src/services/notify/stream')._resetForTest();
  await new Promise((r) => server.close(r));
  await plugins.stop();
  teardown();
});
beforeEach(() => events._resetForTest());

describe('plugin.json permissions.events', () => {
  it('a boolean; false by default', () => {
    const m = clone(helloManifest);
    assert.equal(manifest.validate(m).manifest.permissions.events, false);
    m.permissions.events = true;
    assert.equal(manifest.validate(m).manifest.permissions.events, true);
    m.permissions.events = 'yes';
    assert.deepEqual(manifest.validate(m).errors, ['permissions.events: invalid']);
  });
});

describe('events.check', () => {
  const code = (args) => { try { events.check(args); return null; } catch (e) { return e.code; } };
  it('users 1…500 ids, type [a-z][a-z0-9._-]{0,63}, data JSON ≤ 4 KB', () => {
    assert.deepEqual(events.check({ users: [3, 3, 4], type: 'message.new', data: { a: 1 } }), { users: [3, 4], type: 'message.new', data: { a: 1 } });
    assert.deepEqual(events.check({ users: [3], type: 'typing' }).data, null, 'no data → null');
    for (const users of [undefined, [], [0], ['1'], [1.5], new Array(501).fill(1)]) assert.equal(code({ users, type: 'x' }), 'ERR_INVALID', JSON.stringify(users));
    for (const type of [undefined, '', 'Message', '1abc', 'a b', 'x'.repeat(65), 7]) assert.equal(code({ users: [1], type }), 'ERR_INVALID', String(type));
    assert.equal(code({ users: [1], type: 'x', data: 'z'.repeat(4095) }), 'ERR_INVALID', '4 KB as JSON incl. quotes');
    assert.equal(code({ users: [1], type: 'x', data: 'z'.repeat(4094) }), null);
    assert.equal(code({ users: [1], type: 'x', data: { n: 10n } }), 'ERR_INVALID', 'not JSON');
  });

  it('600 calls per minute and plugin', () => {
    for (let i = 0; i < events.PER_MINUTE; i++) events.emit('rate-a', { users: [1], type: 'x' });
    assert.throws(() => events.emit('rate-a', { users: [1], type: 'x' }), (e) => e.code === 'ERR_RATE_LIMIT');
    assert.deepEqual(events.emit('rate-b', { users: [1], type: 'x' }), { delivered: 0 }, 'another plugin has its own budget');
  });
});

describe('the apps\' push stream', () => {
  it('event: plugin { plugin, type, data } to every open stream of the listed people only — no SSE id', async () => {
    const a1 = await H.openStream(port, annaDev.raw);
    const a2 = await H.openStream(port, annaTab.raw);
    const b = await H.openStream(port, benDev.raw);
    try {
      for (const s of [a1, a2, b]) await s.waitFor((e) => e.event === 'hello');
      const r = await emit('hello-ev', { users: [anna], type: 'message.new', data: { conv: 7, id: 42 } }).expect(200);
      assert.deepEqual(r.body.result, { delivered: 2 });
      for (const s of [a1, a2]) {
        const ev = await s.waitFor((e) => e.event === 'plugin');
        assert.deepEqual(ev.data, { plugin: 'hello-ev', type: 'message.new', data: { conv: 7, id: 42 } });
        assert.equal(ev.id, undefined, 'not resumable');
      }
      await H.sleep(100);
      assert.equal(b.events.some((e) => e.event === 'plugin'), false);
      // nothing stored: a reconnect brings no plugin event
      a1.close();
      const again = await H.openStream(port, annaDev.raw);
      await again.waitFor((e) => e.event === 'hello');
      await H.sleep(100);
      assert.equal(again.events.some((e) => e.event === 'plugin'), false);
      again.close();
    } finally { for (const s of [a1, a2, b]) s.close(); }
  });

  it('refusals through the process: no permission, bad arguments, rate limit', async () => {
    let r = await emit('hello-quiet', { users: [anna], type: 'x' }).expect(400);
    assert.equal(r.body.code, 'ERR_EVENTS_DENIED');
    r = await emit('hello-ev', { users: [anna], type: 'Bad Type' }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await emit('hello-ev', { users: [anna], type: 'x', data: 'z'.repeat(5000) }).expect(400);
    assert.equal(r.body.code, 'ERR_INVALID');
    for (let i = 0; i < events.PER_MINUTE; i++) events.emit('hello-ev', { users: [999999], type: 'x' });
    r = await emit('hello-ev', { users: [anna], type: 'x' }).expect(400);
    assert.equal(r.body.code, 'ERR_RATE_LIMIT');
  });
});

describe('frame streams (admin page, portal)', () => {
  it('admin: GET /api/v1/plugins/<id>/events — the administrator\'s events; 404 without permissions.events', async () => {
    await agent.get(`${API}/hello-quiet/events`).expect(404);
    await agent.get(`${API}/nope-x/events`).expect(404);
    const s = await openSse(`${API}/hello-ev/events`);
    try {
      assert.equal(s.status, 200);
      await s.waitFor((e) => e.event === 'hello' && e.data.plugin === 'hello-ev');
      await emit('hello-ev', { users: [anna], type: 'not.for.admin' }).expect(200);
      const r = await emit('hello-ev', { users: [adminId, anna], type: 'read', data: { upTo: 9 } }).expect(200);
      assert.ok(r.body.result.delivered >= 1);
      const ev = await s.waitFor((e) => e.event === 'plugin');
      assert.deepEqual(ev.data, { plugin: 'hello-ev', type: 'read', data: { upTo: 9 } });
      assert.equal(s.events.filter((e) => e.event === 'plugin').length, 1, 'only events naming this person');
    } finally { s.close(); }
    await H.sleep(50);
    assert.equal(events._streamCount(), 0, 'closed with the connection');
  });

  it('portal: GET /api/v1/portal/plugins/<id>/events — a signed-in viewer only', async () => {
    const anon = await openSse('/api/v1/portal/plugins/hello-ev/events', { cookies: false });
    assert.ok([401, 403].includes(anon.status), String(anon.status));
    anon.close();
    await agent.get('/api/v1/portal/plugins/hello-quiet/events').expect(404);
    const s = await openSse('/api/v1/portal/plugins/hello-ev/events');
    try {
      assert.equal(s.status, 200);
      await s.waitFor((e) => e.event === 'hello');
      await emit('hello-ev', { users: [adminId], type: 'typing', data: { conv: 1 } }).expect(200);
      assert.deepEqual((await s.waitFor((e) => e.event === 'plugin')).data, { plugin: 'hello-ev', type: 'typing', data: { conv: 1 } });
    } finally { s.close(); }
  });

  it('at most 16 streams per person', () => {
    const fake = () => ({ writeHead() {}, flushHeaders() {}, write() { return true; }, end() {}, once() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
    const req = { on() {} };
    for (let i = 0; i < events.STREAMS_PER_USER; i++) events.openStream(req, fake(), 'p', 5);
    const res = fake();
    events.openStream(req, res, 'p', 5);
    assert.deepEqual([res.code, res.body], [503, { ok: false, code: 'too_many_streams' }]);
    events.closeStreams('p');
    assert.equal(events._streamCount(), 0);
  });

  it('a lagging frame stream drops the event (ephemeral)', () => {
    const writes = [];
    let full = false;
    const res = { writeHead() {}, flushHeaders() {}, write(c) { writes.push(c); return !full; }, end() {}, once() {} };
    events.openStream({ on() {} }, res, 'lag', 6);
    full = true;
    assert.equal(events.emit('lag', { users: [6], type: 'a' }).delivered, 1, 'written, then the socket is full');
    assert.equal(events.emit('lag', { users: [6], type: 'b' }).delivered, 0, 'dropped while lagging');
    assert.equal(writes.filter((w) => w.startsWith('event: plugin')).length, 1);
    events.closeStreams('lag');
  });
});

describe('the frame client: GC.on / GC.off / GC.upload', () => {
  function client() {
    const doc = frame.document({ html: '', lang: 'de' });
    const start = doc.indexOf('<script>') + '<script>'.length;
    const posted = [];
    let onMessage = null;
    const parent = { postMessage: (m) => posted.push(m) };
    class Blob { constructor(size, type) { this.size = size; this.type = type; } }
    const win = { parent, addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, getComputedStyle: () => ({}), innerWidth: 1, innerHeight: 1 };
    const ctx = { window: win, document: { documentElement: { lang: 'de', offsetHeight: 1, setAttribute() {} }, body: null }, setTimeout, clearTimeout, Object, Error, Promise, Math, Number, String, Blob };
    vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), ctx);
    return { GC: win.GC, posted, deliver: (data) => onMessage({ source: parent, data }), Blob };
  }

  it('GC.on subscribes once, passes { plugin, type, data } to every listener, GC.off unsubscribes', () => {
    const c = client();
    const got = [];
    const f1 = (e) => got.push(['f1', e.type]);
    const f2 = (e) => got.push(['f2', e.data.n]);
    c.GC.on('event', f1);
    c.GC.on('event', f2);
    c.GC.on('event', f1);
    c.GC.on('other', f1);
    assert.equal(c.posted.filter((m) => m.type === 'gc-subscribe').length, 1);
    c.deliver({ type: 'gc-event', event: { plugin: 'p', type: 'message.new', data: { n: 3 } } });
    assert.deepEqual(got, [['f1', 'message.new'], ['f2', 3]]);
    c.GC.off('event', f1);
    c.GC.off('event', f2);
    assert.equal(c.posted.filter((m) => m.type === 'gc-unsubscribe').length, 1);
    c.deliver({ type: 'gc-event', event: { plugin: 'p', type: 'x', data: {} } });
    assert.equal(got.length, 2);
  });

  it('GC.upload posts the Blob, reports progress, resolves with the parent\'s answer', async () => {
    const c = client();
    await assert.rejects(() => c.GC.upload('not a file'), /File or Blob/);
    const progress = [];
    const file = new c.Blob(1000, 'image/png');
    const p = c.GC.upload(file, { onProgress: (x) => progress.push(x) });
    const msg = c.posted.find((m) => m.type === 'gc-upload');
    assert.equal(msg.file, file);
    assert.equal(msg.mime, 'image/png');
    assert.equal(msg.progress, true);
    c.deliver({ type: 'gc-upload-progress', id: msg.id, loaded: 500, total: 1000 });
    c.deliver({ type: 'gc-result', id: msg.id, ok: true, status: 200, data: { mediaId: 'a'.repeat(32), mime: 'image/png', bytes: 1000 } });
    assert.deepEqual(plain(await p), { mediaId: 'a'.repeat(32), mime: 'image/png', bytes: 1000 });
    assert.deepEqual(plain(progress), [{ loaded: 500, total: 1000 }]);
    const q = c.GC.upload(new c.Blob(5, ''));
    const m2 = c.posted.filter((m) => m.type === 'gc-upload')[1];
    c.deliver({ type: 'gc-result', id: m2.id, ok: false, status: 413, data: { ok: false, code: 'too_large' }, error: 'too_large' });
    await assert.rejects(q, (e) => e.status === 413 && e.message === 'too_large');
  });
});

describe('the parent page (plugin-bridge.js): uploads and events of a frame', () => {
  function bridge({ events: withEvents = true, base = '/api/v1/portal/plugins/hello-ev/api/' } = {}) {
    const replies = [];
    const handlers = {};
    const xhrs = [];
    const sources = [];
    const attrs = { 'data-plugin-api': base, 'data-plugin-id': 'hello-ev', 'data-plugin-pages': '[]', ...(withEvents ? { 'data-plugin-events': '' } : {}) };
    const frameEl = { contentWindow: { postMessage: (m) => replies.push(m) }, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener() {}, style: {} };
    class Blob { constructor(size, type) { this.size = size; this.type = type; } }
    class XMLHttpRequest {
      constructor() { this.headers = {}; this.upload = {}; xhrs.push(this); }
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(k, v) { this.headers[k] = v; }
      send(body) { this.body = body; }
    }
    class EventSource {
      constructor(url, opts) { this.url = url; this.opts = opts; this.listeners = {}; this.closed = false; sources.push(this); }
      addEventListener(t, fn) { this.listeners[t] = fn; }
      close() { this.closed = true; }
    }
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, addEventListener: (type, fn) => { handlers[type] = fn; } },
      document: { readyState: 'complete', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frameEl], getElementById: () => null },
      MutationObserver: class { observe() {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      Blob, XMLHttpRequest, EventSource, JSON,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8'), ctx);
    const send = (data, origin = 'null') => handlers.message({ source: frameEl.contentWindow, origin, data });
    return { replies, xhrs, sources, send, Blob };
  }

  it('gc-upload: a raw PUT to …/media with the CSRF token and the file type, progress and result back to the frame', () => {
    const b = bridge();
    const file = new b.Blob(1234, 'audio/ogg');
    b.send({ type: 'gc-upload', id: 5, file, mime: 'audio/ogg', progress: true });
    const x = b.xhrs[0];
    assert.deepEqual([x.method, x.url, x.withCredentials, x.body], ['PUT', '/api/v1/portal/plugins/hello-ev/media', true, file]);
    assert.equal(x.headers['X-CSRF-Token'], 'tok');
    assert.equal(x.headers['Content-Type'], 'audio/ogg');
    x.upload.onprogress({ loaded: 600, total: 1234, lengthComputable: true });
    x.status = 200;
    x.responseText = JSON.stringify({ ok: true, mediaId: 'b'.repeat(32), mime: 'audio/ogg', bytes: 1234 });
    x.onload();
    assert.deepEqual(plain(b.replies.find((m) => m.type === 'gc-upload-progress')), { type: 'gc-upload-progress', id: 5, loaded: 600, total: 1234 });
    assert.deepEqual(plain(b.replies.find((m) => m.type === 'gc-result')), { type: 'gc-result', id: 5, ok: true, status: 200, data: { mediaId: 'b'.repeat(32), mime: 'audio/ogg', bytes: 1234 }, error: null });
    // the admin page: its own API base
    const a = bridge({ base: '/api/v1/plugins/hello-ev/api/' });
    a.send({ type: 'gc-upload', id: 1, file: new a.Blob(3, 'image/png') });
    assert.equal(a.xhrs[0].url, '/api/v1/plugins/hello-ev/media');
  });

  it('gc-upload refusals: not a Blob, empty, over 100 MB, a message from elsewhere', () => {
    const b = bridge();
    b.send({ type: 'gc-upload', id: 1, file: 'x' });
    b.send({ type: 'gc-upload', id: 2, file: new b.Blob(0, 'image/png') });
    b.send({ type: 'gc-upload', id: 3, file: new b.Blob(100 * 1024 * 1024 + 1, 'image/png') });
    b.send({ type: 'gc-upload', id: 4, file: new b.Blob(10, 'image/png') }, 'https://evil.example');
    assert.equal(b.xhrs.length, 0);
    assert.deepEqual(plain(b.replies.filter((m) => m.type === 'gc-result').map((m) => [m.id, m.status])), [[1, 400], [2, 400], [3, 400]]);
    const x = bridge();
    x.send({ type: 'gc-upload', id: 9, file: new x.Blob(10, 'image/png') });
    x.xhrs[0].status = 507;
    x.xhrs[0].responseText = JSON.stringify({ ok: false, code: 'quota_exceeded' });
    x.xhrs[0].onload();
    assert.deepEqual(plain(x.replies.find((m) => m.type === 'gc-result')), { type: 'gc-result', id: 9, ok: false, status: 507, data: { ok: false, code: 'quota_exceeded' }, error: 'quota_exceeded' });
  });

  it('gc-subscribe opens one EventSource per plugin and passes events on; a frame without data-plugin-events gets none', () => {
    const b = bridge();
    b.send({ type: 'gc-subscribe' });
    b.send({ type: 'gc-subscribe' });
    assert.equal(b.sources.length, 1);
    assert.equal(b.sources[0].url, '/api/v1/portal/plugins/hello-ev/events');
    b.sources[0].listeners.plugin({ data: JSON.stringify({ plugin: 'hello-ev', type: 'message.new', data: { id: 1 } }) });
    assert.deepEqual(plain(b.replies.filter((m) => m.type === 'gc-event')), [{ type: 'gc-event', event: { plugin: 'hello-ev', type: 'message.new', data: { id: 1 } } }]);
    b.send({ type: 'gc-unsubscribe' });
    assert.equal(b.sources[0].closed, true, 'the last frame gone → closed');
    b.send({ type: 'gc-subscribe' });
    b.send({ type: 'gc-hello' }); // the frame reloaded: its subscription ends with the old document
    assert.equal(b.sources[1].closed, true);
    const n = bridge({ events: false });
    n.send({ type: 'gc-subscribe' });
    assert.equal(n.sources.length, 0);
  });
});

describe('templates', () => {
  it('only frames of plugins with permissions.events carry data-plugin-events', async () => {
    assert.match((await agent.get('/plugins/hello-ev').expect(200)).text, /data-plugin-frame[^>]*data-plugin-events/);
    assert.doesNotMatch((await agent.get('/plugins/hello-quiet').expect(200)).text, /data-plugin-events/);
    const p = (await supertest(app).get('/plugins/hello-ev')).status;
    assert.ok([302, 401].includes(p), 'admin pages stay for administrators');
  });
});
