'use strict';

// GC.scanQr (docs/plugins.md "QR codes", since 1.196.0): a plugin frame is
// sandboxed without allow-same-origin, and Chromium refuses getUserMedia in
// such a frame whatever <iframe allow="camera"> says. So the frame asks the
// parent page (gc-scan), GateControl's own page shows its camera dialog
// (public/js/qr-scan.js) and answers only { text, code }.
//   * plugin.json ui.scanQr (or the older ui.camera) → GC.scanQr in the frame
//     document, data-plugin-scanqr on its <iframe>, a row in the install dialog;
//   * plugin-bridge.js: only from such an <iframe>, valid options, frame shown,
//     one scan at a time, rate limit, a call without a click asks first;
//   * qr-scan.js: the accept filter keeps scanning, cancel/timeout/hidden stop
//     the camera, an insecure page explains itself.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const frame = require('../src/services/plugins/frame');
const PUI = require('../public/js/plugins-ui.js');
const QR = require('../public/js/qr-scan.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const ROOT = path.join(__dirname, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'plugin-bridge.js'), 'utf8');
const QR_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'qr-scan.js'), 'utf8');
const DIALOG_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'gc-dialog.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const clone = (v) => JSON.parse(JSON.stringify(v));
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));

// ── a small DOM, enough for qr-scan.js and gc-dialog.js ──────────────────────
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.style = {};
    this.hidden = false;
    this.parentNode = null;
    this._text = '';
    const self = this;
    this.classList = {
      add: (c) => { const l = self.className.split(/\s+/).filter(Boolean); if (!l.includes(c)) l.push(c); self.className = l.join(' '); },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); }
  getAttribute(k) { return k === 'class' ? this.className : (k in this.attrs ? this.attrs[k] : null); }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { const l = this.listeners[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  click() { (this.listeners.click || []).slice().forEach((f) => f({ target: this, preventDefault() {}, stopPropagation() {} })); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  pause() {}
  play() { return Promise.resolve(); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)$/i.exec(sel);
    const tag = m[1].toUpperCase();
    const cls = m[2].split('.').filter(Boolean);
    return this.all().find((n) => (!tag || n.tagName === tag) && cls.every((c) => n.classList.contains(c))) || null;
  }
}
function fakeDocument({ portal = true, lang = 'de' } = {}) {
  const listeners = {};
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    createElement: (t) => new El(t, doc),
    createElementNS: (_, t) => new El(t, doc),
    createTextNode: (s) => { const n = new El('#text', doc); n._text = String(s); return n; },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: (t, f) => { const l = listeners[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
    dispatch: (t, e) => (listeners[t] || []).slice().forEach((f) => f(Object.assign({ preventDefault() {}, stopPropagation() {} }, e))),
    listeners,
    contains: () => true,
  };
  doc.documentElement = new El('html', doc);
  doc.documentElement.setAttribute('lang', lang);
  doc.head = new El('head', doc);
  doc.body = new El('body', doc);
  if (portal) doc.body.className = 'pt-body';
  doc.querySelector = (sel) => (sel === 'body.pt-body' ? (doc.body.classList.contains('pt-body') ? doc.body : null) : doc.body.querySelector(sel));
  return doc;
}
function fakeCamera(codes) {
  const stopped = [];
  const asked = [];
  let n = 0;
  const stream = () => {
    const tracks = [{ id: 't' + (++n), readyState: 'live', stop() { this.readyState = 'ended'; stopped.push(this.id); }, getSettings: () => ({ deviceId: 'cam1' }) }];
    return { getTracks: () => tracks, getVideoTracks: () => tracks };
  };
  const md = {
    getUserMedia: (c) => { asked.push(c); return md.fail ? Promise.reject(Object.assign(new Error('x'), { name: md.fail })) : Promise.resolve(stream()); },
    enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: 'cam1' }, { kind: 'videoinput', deviceId: 'cam2' }, { kind: 'audioinput', deviceId: 'mic' }]),
  };
  // BarcodeDetector stub: hands out the given codes one per frame, then nothing
  class BarcodeDetector {
    static getSupportedFormats() { return Promise.resolve(['qr_code']); }
    detect() { const c = codes.shift(); return Promise.resolve(c ? [{ rawValue: c }] : []); }
  }
  return { md, BarcodeDetector, stopped, asked };
}
/** qr-scan.js (and gc-dialog.js for an admin page) in a fake window. Timers run on flush(). */
function scanner({ portal = true, secure = true, codes = [], lang = 'de', camera = true } = {}) {
  const doc = fakeDocument({ portal, lang });
  const cam = fakeCamera(codes);
  const timers = new Map();
  let seq = 0;
  const win = {
    document: doc, isSecureContext: secure, BarcodeDetector: cam.BarcodeDetector,
    navigator: camera ? { mediaDevices: cam.md } : {},
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
    Promise, Object, Array, String, Number, Math, Error, Date, Map, JSON,
  };
  win.self = win;
  win.window = win;
  vm.createContext(win);
  if (!portal) vm.runInContext(DIALOG_SRC, win);
  vm.runInContext(QR_SRC, win);
  // the video element "plays" once srcObject is set
  const flush = async (filter = () => true) => {
    for (let round = 0; round < 50; round++) {
      await tick();
      const due = [...timers].filter(([, t]) => filter(t.ms));
      if (!due.length) return;
      due.forEach(([id, t]) => { timers.delete(id); t.fn(); });
    }
  };
  const video = () => doc.body.querySelector('video.gc-qr-video');
  const ready = () => { const v = video(); if (v) { v.readyState = 4; v.videoWidth = 640; v.videoHeight = 480; } };
  return { Q: win.GCQrScan, doc, cam, flush, ready, timers, video, q: (s) => doc.body.querySelector(s) };
}
const scanTimers = (ms) => ms <= 600; // the scan loop, not the 2-minute timeout

// ── plugin.json, frame document, templates, install dialog ──────────────────
let agent, csrf, runtime, plugins, manifest, inspectedQr;
const API = '/api/v1/plugins';
async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
const overrides = (id, uiExtra) => ({ id, name: { de: id === 'hello-qr' ? 'Hallo QR' : id, en: id === 'hello-qr' ? 'Hallo QR' : id }, ui: { ...clone(helloManifest.ui), ...uiExtra } });

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  inspectedQr = await install(helloPackage({ overrides: overrides('hello-qr', { scanQr: true }) }));
  await install(helloPackage({ overrides: overrides('hello-cam', { camera: true }) }));
  await install(helloPackage({ overrides: overrides('hello-noqr', {}) }));
  for (const id of ['hello-qr', 'hello-cam', 'hello-noqr']) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => { await plugins.stop(); teardown(); });

describe('plugin.json ui.scanQr', () => {
  const check = (uiExtra) => { const m = clone(helloManifest); Object.assign(m.ui, uiExtra); return manifest.validate(m); };

  it('a boolean, default false; ui.camera (1.188.0) grants it too', () => {
    assert.equal(check({ scanQr: true }).manifest.ui.scanQr, true);
    assert.equal(check({}).manifest.ui.scanQr, false);
    assert.deepEqual(check({ scanQr: 'yes' }).errors, ['ui.scanQr: invalid']);
    assert.equal(frame.scanQrOf(check({ scanQr: true }).manifest), true);
    assert.equal(frame.scanQrOf(check({ camera: true }).manifest), true, 'plugins that declared ui.camera keep working');
    assert.equal(frame.scanQrOf(check({}).manifest), false);
    assert.equal(frame.scanQrOf(null), false);
  });

  it('only a ui.scanQr frame gets no camera in its <iframe allow>: the page reads the code', () => {
    const v = plugins.list('de').find((p) => p.id === 'hello-qr');
    assert.equal(v.scanQr, true);
    assert.equal(v.allow, '');
    assert.equal(plugins.list('de').find((p) => p.id === 'hello-cam').scanQr, true);
    assert.equal(plugins.list('de').find((p) => p.id === 'hello-noqr').scanQr, false);
  });

  it('the install dialog names it, in German and English, not as a sensitive permission', () => {
    assert.equal(inspectedQr.plugin.permissions.scanQr, true);
    assert.equal(de['plugins.perm.scan_qr_on'], 'Kamera zum Scannen von QR-Codes (das Bild bleibt in GateControl, das Plugin bekommt nur den gelesenen Text)');
    for (const lang of ['de', 'en']) {
      const t = lang === 'en' ? en : de;
      const rows = PUI.permRows(inspectedQr.plugin.permissions, (k, p) => {
        assert.ok(t[k], 'missing ' + lang + ' ' + k);
        return t[k].replace(/\{\{(\w+)\}\}/g, (_, x) => (p && p[x] != null ? String(p[x]) : ''));
      });
      assert.ok(rows.some((x) => x.label === t['plugins.perm.scan_qr'] && x.value === t['plugins.perm.scan_qr_on']));
      assert.equal(new Set(rows.map((x) => x.label)).size, rows.length);
    }
    assert.equal(PUI.sensitivePerms(inspectedQr.plugin.permissions).includes('plugins.perm.scan_qr'), false);
  });

  it('the frame document has GC.scanQr only for such plugins', async () => {
    const has = async (url) => /if \(true\) api\.scanQr = scanQr;/.test((await agent.get(url).expect(200)).text);
    assert.equal(await has('/portal/plugins/hello-qr/frame'), true);
    assert.equal(await has('/portal/plugins/hello-cam/frame'), true);
    assert.equal(await has('/portal/plugins/hello-noqr/frame'), false);
    assert.equal(await has('/plugins/hello-qr/frame/' + helloManifest.ui.pages[0].id), true);
    assert.equal(await has('/plugins/hello-noqr/frame/' + helloManifest.ui.pages[0].id), false);
    // nothing else of the frame changes
    const csp = (id) => agent.get(`/portal/plugins/${id}/frame`).expect(200).then((r) => r.headers['content-security-policy'].replace(/127\.0\.0\.1:\d+/g, 'host'));
    assert.equal(await csp('hello-qr'), await csp('hello-noqr'));
  });

  it('portal and admin <iframe>s of such plugins carry data-plugin-scanqr and the plugin name; the pages load the dialog', async () => {
    const portal = (await agent.get('/portal').expect(200)).text;
    assert.match(/data-plugin-id="hello-qr"[^>]*>/.exec(portal)[0], /data-plugin-scanqr data-plugin-name="Hallo QR"/);
    assert.match(/data-plugin-id="hello-cam"[^>]*>/.exec(portal)[0], /data-plugin-scanqr/);
    assert.doesNotMatch(/data-plugin-id="hello-noqr"[^>]*>/.exec(portal)[0], /data-plugin-scanqr/);
    assert.match(portal, /<script src="\/js\/qr-scan\.js\?v=[^"]+" defer><\/script>\s*<script src="\/js\/plugin-bridge\.js/);
    const page = (await agent.get('/plugins/hello-qr').expect(200)).text;
    assert.match(/<iframe class="pg-frame"[^>]*>/.exec(page)[0], /data-plugin-scanqr data-plugin-name="Hallo QR"/);
    assert.match(page, /<script src="\/js\/qr-scan\.js\?v=[^"]+"><\/script>\s*<script src="\/js\/plugin-bridge\.js/);
    assert.doesNotMatch(/<iframe class="pg-frame"[^>]*>/.exec((await agent.get('/plugins/hello-noqr').expect(200)).text)[0], /data-plugin-scanqr/);
    // the settings page frame (plugins-page.js) sets the same attributes
    assert.match(fs.readFileSync(path.join(ROOT, 'public', 'js', 'plugins-page.js'), 'utf8'), /if \(p\.scanQr\) \{ attrs\['data-plugin-scanqr'\] = ''; attrs\['data-plugin-name'\] = p\.name \|\| p\.id; \}/);
  });

  it('the vendored jsQR is served from this origin, with its licence', async () => {
    const r = await agent.get('/vendor/jsqr/jsQR.js').expect(200);
    assert.match(r.text, /root\["jsQR"\] = factory\(\)/);
    assert.match(fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'jsqr', 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
    assert.match(fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'jsqr', 'README.md'), 'utf8'), /jsqr@1\.4\.0/);
  });
});

// ── the frame client ────────────────────────────────────────────────────────
describe('the frame client: GC.scanQr', () => {
  function client(scanQr = true) {
    const doc = frame.document({ html: '', lang: 'de', scanQr });
    const start = doc.indexOf('<script>') + '<script>'.length;
    const posted = [];
    let onMessage = null;
    const timers = [];
    const parent = { postMessage: (m) => posted.push(m) };
    const win = { parent, addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, getComputedStyle: () => ({}), innerWidth: 1, innerHeight: 1 };
    const ctx = { window: win, document: { documentElement: { lang: 'de', offsetHeight: 1, setAttribute() {} }, body: null },
      setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, Object, Error, Promise, Math, Number, String };
    vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), ctx);
    return { GC: win.GC, posted, deliver: (data) => onMessage({ source: parent, data }), fire: () => timers.splice(0).forEach((f) => f()) };
  }

  it('is missing without the flag (feature detection)', () => {
    assert.equal('scanQr' in client(false).GC, false);
    assert.equal(typeof client(true).GC.scanQr, 'function');
  });

  it('posts gc-scan with hint, accept and timeout and resolves with the text', async () => {
    const c = client();
    const p = c.GC.scanQr({ hint: 'Den Code der Website scannen', accept: 'otpauth://', timeout: 90 });
    const m = c.posted.find((x) => x.type === 'gc-scan');
    assert.deepEqual(plain(m), { type: 'gc-scan', id: m.id, hint: 'Den Code der Website scannen', accept: ['otpauth://'], timeout: 90 });
    c.deliver({ type: 'gc-result', id: m.id, ok: true, data: { text: 'otpauth://totp/x?secret=A', code: null } });
    assert.deepEqual(plain(await p), { text: 'otpauth://totp/x?secret=A', code: null });
  });

  it('never rejects: a refusal, an error answer and its own timeout resolve with text null and a code', async () => {
    const c = client();
    const p1 = c.GC.scanQr();
    const p2 = c.GC.scanQr({ accept: ['a', 'b'] });
    const p3 = c.GC.scanQr();
    const [m1, m2] = c.posted.filter((x) => x.type === 'gc-scan');
    assert.deepEqual(plain(m1.accept), []);
    c.deliver({ type: 'gc-result', id: m1.id, ok: true, data: { text: null, code: 'cancelled' } });
    c.deliver({ type: 'gc-result', id: m2.id, ok: false, status: 400, error: 'x', data: { code: 'invalid' } });
    c.fire();
    assert.deepEqual(plain(await p1), { text: null, code: 'cancelled' });
    assert.deepEqual(plain(await p2), { text: null, code: 'invalid' });
    assert.deepEqual(plain(await p3), { text: null, code: 'timeout' });
  });
});

// ── the parent page ─────────────────────────────────────────────────────────
describe('the parent page (plugin-bridge.js): gc-scan', () => {
  function bridge({ attr = true, active = true, shown = true, ua = true } = {}) {
    const replies = [];
    const handlers = {};
    const opened = [];
    const attrs = { 'data-plugin-api': '/api/v1/portal/plugins/hello/api/', 'data-plugin-id': 'hello', 'data-plugin-pages': '[]', 'data-plugin-name': 'Vault' };
    if (attr) attrs['data-plugin-scanqr'] = '';
    const state = { shown, active, now: 1000000, busy: false };
    const frameEl = {
      contentWindow: { postMessage: (m) => replies.push(m) }, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener() {}, style: {},
      isConnected: true, checkVisibility: () => state.shown,
    };
    const document = {
      readyState: 'complete', visibilityState: 'visible', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frameEl], getElementById: () => null,
      addEventListener() {}, dispatchEvent: () => true, createElement: () => ({ style: {} }), body: { appendChild() {} },
    };
    // qr-scan.js's checks (normalize) with a recorded open()
    const GCQrScan = {
      normalize: QR.normalize, MAX_TEXT: QR.MAX_TEXT,
      active: () => state.busy,
      open: (o) => {
        let resolve;
        const run = { o, promise: new Promise((r) => { resolve = r; }), cancelled: null };
        run.cancel = (code) => { run.cancelled = code; resolve({ text: null, code }); };
        run.answer = (r) => resolve(r);
        opened.push(run);
        return run;
      },
    };
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, GCQrScan, addEventListener: (type, fn) => { handlers[type] = fn; } },
      navigator: ua ? { userActivation: { get isActive() { return state.active; } } } : {},
      document, CustomEvent: class {}, MutationObserver: class { observe() {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), JSON, Blob, URL,
      Date: { now: () => state.now },
      setTimeout: () => 1,
    };
    vm.runInNewContext(BRIDGE_SRC, ctx);
    const send = (data, origin = 'null', source = frameEl.contentWindow) => handlers.message({ source, origin, data });
    const results = () => plain(replies.filter((m) => m.type === 'gc-result'));
    const last = () => results().slice(-1)[0];
    return { send, results, last, opened, state };
  }
  const scanMsg = (id, extra) => ({ type: 'gc-scan', id, hint: 'Hinweis', accept: ['otpauth://'], timeout: 60, ...extra });

  it('opens the dialog with the plugin name and the cleaned options; answers only the text', async () => {
    const b = bridge();
    b.send(scanMsg(1, { hint: 'Den\nCode scannen' }));
    assert.equal(b.opened.length, 1);
    const o = b.opened[0].o;
    assert.deepEqual({ name: o.name, hint: o.hint, accept: plain(o.accept), timeoutMs: o.timeoutMs, gesture: o.gesture }, { name: 'Vault', hint: 'Den Code scannen', accept: ['otpauth://'], timeoutMs: 60000, gesture: true });
    assert.equal(typeof o.visible, 'function');
    b.opened[0].answer({ text: 'otpauth://totp/a?secret=B', code: null, picture: 'never passed on' });
    await tick();
    assert.deepEqual(b.last(), { type: 'gc-result', id: 1, ok: true, status: 200, data: { text: 'otpauth://totp/a?secret=B', code: null } });
  });

  it('refuses without data-plugin-scanqr, with invalid options, for a hidden frame, while a scan is open, and too fast', () => {
    const none = bridge({ attr: false });
    none.send(scanMsg(1));
    assert.deepEqual(none.last().data, { text: null, code: 'not_allowed' });
    assert.equal(none.opened.length, 0);

    const b = bridge();
    b.send(scanMsg(2, { accept: 'otpauth://' }));
    b.send(scanMsg(3, { accept: Array(9).fill('a') }));
    b.send(scanMsg(4, { accept: [''] }));
    b.send(scanMsg(5, { accept: ['x'.repeat(101)] }));
    assert.deepEqual(b.results().map((r) => [r.id, r.data.code]), [[2, 'invalid'], [3, 'invalid'], [4, 'invalid'], [5, 'invalid']]);
    b.state.shown = false;
    b.send(scanMsg(6));
    assert.deepEqual(b.last().data.code, 'hidden');
    b.state.shown = true;
    b.state.busy = true;
    b.send(scanMsg(7));
    assert.deepEqual(b.last().data.code, 'busy');
    b.state.busy = false;
    b.send(scanMsg(8));
    assert.equal(b.opened.length, 1);
    b.state.now += 1000;
    b.send(scanMsg(9));
    assert.deepEqual(b.last().data.code, 'rate_limited');
    b.state.now += 600;
    b.send(scanMsg(10));
    assert.equal(b.opened.length, 2);
    // messages of other windows or origins are ignored
    const n = b.results().length;
    b.send(scanMsg(11), 'https://evil.example');
    b.send(scanMsg(12), 'null', {});
    b.send({ type: 'gc-scan', id: 'x' });
    assert.equal(b.results().length, n);
  });

  it('a call without a click: the dialog asks first, a repeat within 10 s is refused; no API → the dialog asks too', () => {
    const b = bridge({ active: false });
    b.send(scanMsg(1));
    assert.equal(b.opened[0].o.gesture, false);
    b.opened[0].cancel('cancelled');
    b.state.now += 5000;
    b.send(scanMsg(2));
    assert.deepEqual(b.last().data, { text: null, code: 'no_gesture' });
    b.state.now += 5001;
    b.send(scanMsg(3));
    assert.equal(b.opened.length, 2);
    b.state.now += 2000;
    b.state.active = true;
    b.send(scanMsg(4));
    assert.equal(b.opened.length, 3, 'with a click: no 10 s wait');
    assert.equal(b.opened[2].o.gesture, true);
    const old = bridge({ ua: false });
    old.send(scanMsg(1));
    assert.equal(old.opened[0].o.gesture, true, 'a browser without navigator.userActivation: the dialog itself is the check');
  });

  it('cancel and a new document in the frame end the scan; a too long text is not passed on', async () => {
    const b = bridge();
    b.send(scanMsg(1));
    b.opened[0].cancel('cancelled');
    await tick();
    assert.deepEqual(b.last(), { type: 'gc-result', id: 1, ok: true, status: 200, data: { text: null, code: 'cancelled' } });
    b.state.now += 2000;
    b.send(scanMsg(2));
    b.send({ type: 'gc-hello' });
    assert.equal(b.opened[1].cancelled, 'cancelled');
    b.state.now += 2000;
    b.send(scanMsg(3));
    b.opened[2].answer({ text: 'x'.repeat(QR.MAX_TEXT + 1), code: null });
    await tick();
    assert.deepEqual(b.last().data, { text: null, code: 'cancelled' });
  });
});

// ── qr-scan.js ──────────────────────────────────────────────────────────────
describe('qr-scan.js: options and the accept filter', () => {
  it('normalize: accept prefixes (≤ 8, 1…100 characters, lower-cased), timeout 10…600 s (default 120), hint cleaned and capped', () => {
    assert.deepEqual(plain(QR.normalize({ accept: ['OTPAUTH://', 'otpauth-migration://'], hint: '  a\u0000b ', timeout: 5 })), { ok: true, hint: 'a b', accept: ['otpauth://', 'otpauth-migration://'], timeoutMs: 10000 });
    assert.equal(QR.normalize({}).timeoutMs, 120000);
    assert.equal(QR.normalize({ timeout: 9999 }).timeoutMs, 600000);
    assert.equal(QR.normalize({ hint: 'x'.repeat(500) }).hint.length, 200);
    assert.equal(QR.normalize({ hint: 42 }).hint, '');
    for (const accept of ['otpauth', Array(9).fill('a'), [''], [1], ['x'.repeat(101)], ['a\nb']]) assert.equal(QR.normalize({ accept }).ok, false, JSON.stringify(accept));
  });

  it('matches: any code without prefixes, else a case-insensitive prefix; never more than 4096 characters', () => {
    assert.equal(QR.matches('anything', []), true);
    assert.equal(QR.matches('OTPAUTH://totp/x', ['otpauth://']), true);
    assert.equal(QR.matches('otpauth-migration://offline?data=x', ['otpauth://', 'otpauth-migration://']), true);
    assert.equal(QR.matches('https://example.com', ['otpauth://']), false);
    assert.equal(QR.matches('', []), false);
    assert.equal(QR.matches('a'.repeat(4097), []), false);
    assert.equal(QR.matches(null, []), false);
  });
});

describe('qr-scan.js: the dialog', () => {
  it('portal: reads codes until one passes the filter (hint for the others), answers its text, stops the camera, closes', async () => {
    const s = scanner({ codes: [null, 'https://example.com/x', 'otpauth://totp/A?secret=B'] });
    const run = s.Q.open({ name: 'Vault', hint: 'Den Code der Website scannen', accept: ['otpauth://'], timeoutMs: 60000 });
    assert.equal(s.Q.active(), true);
    assert.ok(s.q('.pt-overlay.gc-qr-overlay'), 'the portal dialog');
    assert.equal(s.q('.gc-qr-overlay').style.zIndex, '2147483600');
    assert.equal(s.q('.gc-qr-sub').textContent, 'für Vault');
    assert.equal(s.q('.gc-qr-hint').textContent, 'Den Code der Website scannen');
    assert.match(s.q('.gc-qr-privacy').textContent, /Vault bekommt nur den gelesenen Text/);
    await s.flush(scanTimers);
    assert.equal(s.cam.asked.length, 1);
    assert.deepEqual(plain(s.cam.asked[0].video.facingMode), { ideal: 'environment' });
    assert.equal(s.q('.gc-qr-switch').hidden, false, 'two cameras: the switch is shown');
    const status = s.q('.gc-qr-status');
    s.ready();
    await s.flush(scanTimers);
    assert.deepEqual(plain(await run.promise), { text: 'otpauth://totp/A?secret=B', code: null });
    assert.equal(status.getAttribute('data-tone'), 'warn', 'the non-matching code showed the hint');
    assert.match(status.textContent, /passt hier nicht/);
    assert.deepEqual(s.cam.stopped, ['t1']);
    assert.equal(s.q('.gc-qr-overlay'), null, 'closed');
    assert.equal(s.Q.active(), false);
  });

  it('only one at a time', async () => {
    const s = scanner();
    const a = s.Q.open({ name: 'A' });
    assert.deepEqual(plain(await s.Q.open({ name: 'B' }).promise), { text: null, code: 'busy' });
    a.cancel();
    assert.deepEqual(plain(await a.promise), { text: null, code: 'cancelled' });
  });

  it('"Abbrechen" and Escape cancel and stop the camera; admin pages use the shared dialog', async () => {
    for (const portal of [true, false]) {
      const s = scanner({ portal });
      const run = s.Q.open({ name: 'Schule' });
      await s.flush(scanTimers);
      if (!portal) {
        assert.ok(s.q('.modal-overlay.zn-dialog.gc-qr-overlay'), 'gc-dialog.js');
        assert.equal(s.q('.gc-qr-cancel').className, 'btn btn-ghost gc-qr-cancel');
      }
      s.q('.gc-qr-cancel').click();
      assert.deepEqual(plain(await run.promise), { text: null, code: 'cancelled' });
      assert.deepEqual(s.cam.stopped, ['t1']);
      assert.equal(s.q('.gc-qr-overlay'), null);
      const s2 = scanner({ portal });
      const run2 = s2.Q.open({ name: 'Schule' });
      await s2.flush(scanTimers);
      s2.doc.dispatch('keydown', { key: 'Escape' });
      assert.deepEqual(plain(await run2.promise), { text: null, code: 'cancelled' });
      assert.deepEqual(s2.cam.stopped, ['t1']);
    }
  });

  it('timeout and a hidden page end the scan and stop the camera', async () => {
    const s = scanner();
    const run = s.Q.open({ name: 'X', timeoutMs: 30000 });
    await s.flush(scanTimers);
    await s.flush((ms) => ms === 30000);
    assert.deepEqual(plain(await run.promise), { text: null, code: 'timeout' });
    assert.deepEqual(s.cam.stopped, ['t1']);
    const h = scanner();
    const run2 = h.Q.open({ name: 'X' });
    await h.flush(scanTimers);
    h.doc.visibilityState = 'hidden';
    h.doc.dispatch('visibilitychange', {});
    assert.deepEqual(plain(await run2.promise), { text: null, code: 'hidden' });
    assert.deepEqual(h.cam.stopped, ['t1']);
    // the frame went out of view (another portal tab)
    const v = scanner();
    let shown = true;
    const run3 = v.Q.open({ name: 'X', visible: () => shown });
    await v.flush(scanTimers);
    shown = false;
    await v.flush(scanTimers);
    assert.deepEqual(plain(await run3.promise), { text: null, code: 'hidden' });
    assert.deepEqual(v.cam.stopped, ['t1']);
  });

  it('without a click the camera starts only after "Kamera starten"', async () => {
    const s = scanner({ codes: ['WebUntis-Code'] });
    const run = s.Q.open({ name: 'Schule', gesture: false });
    await s.flush(scanTimers);
    assert.equal(s.cam.asked.length, 0);
    assert.match(s.q('.gc-qr-status').textContent, /Schule möchte einen QR-Code lesen/);
    s.q('.gc-qr-start').click();
    await s.flush(scanTimers);
    assert.equal(s.cam.asked.length, 1);
    s.ready();
    await s.flush(scanTimers);
    assert.deepEqual(plain(await run.promise), { text: 'WebUntis-Code', code: null });
  });

  it('an insecure page, a browser without camera, a denied or missing camera: a clear message, the code on close', async () => {
    const cases = [
      [{ secure: false }, null, 'insecure', /nur über eine sichere Verbindung/],
      [{ camera: false }, null, 'unsupported', /keine Kamera verwenden/],
      [{}, 'NotAllowedError', 'denied', /Kein Zugriff auf die Kamera/],
      [{}, 'NotFoundError', 'no_camera', /Keine Kamera gefunden/],
      [{}, 'NotReadableError', 'camera_error', /ließ sich nicht starten/],
      [{ lang: 'en' }, 'NotAllowedError', 'denied', /No access to the camera/],
    ];
    for (const [opts, fail, code, re] of cases) {
      const s = scanner(opts);
      s.cam.md.fail = fail;
      const run = s.Q.open({ name: 'X' });
      await s.flush(scanTimers);
      assert.match(s.q('.gc-qr-status').textContent, re, code);
      assert.equal(s.q('.gc-qr-status').getAttribute('data-tone'), 'error');
      assert.equal(s.q('.gc-qr-view').hidden, true);
      assert.match(s.q('.gc-qr-cancel').textContent, /Schließen|Close/);
      s.q('.gc-qr-cancel').click();
      assert.deepEqual(plain(await run.promise), { text: null, code }, code);
    }
  });
});
