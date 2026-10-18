'use strict';

// plugin.json ui.geolocation and ui.inbox (docs/plugins.md "plugin.json",
// "User interface"): the <iframe allow="geolocation *"> of a plugin's frames,
// and window.GC.inbox — the viewer's own inbox summary in portal frames,
// handed on by the parent page (public/js/plugin-bridge.js) from the portal's
// own state (public/js/portal.js), nothing more.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const frame = require('../src/services/plugins/frame');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let agent, csrf, runtime, plugins, manifest;
const API = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const plain = (v) => JSON.parse(JSON.stringify(v));

function overrides(id, uiExtra, extra = {}) {
  return { id, name: { de: id, en: id }, ui: { ...clone(helloManifest.ui), ...uiExtra }, ...extra };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}

let inspectedGeo;
before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  manifest = require('../src/services/plugins/manifest');
  inspectedGeo = await install(helloPackage({ overrides: overrides('hello-geo', { geolocation: true, inbox: true }) }));
  await install(helloPackage({ overrides: overrides('hello-geomedia', { geolocation: true }, { media: { maxBytes: 4096, types: ['image/png'] } }) }));
  await install(helloPackage({ overrides: overrides('hello-flat', {}) }));
  for (const id of ['hello-geo', 'hello-geomedia', 'hello-flat']) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => { await plugins.stop(); teardown(); });

describe('plugin.json ui.geolocation / ui.inbox', () => {
  const check = (uiExtra, mut) => { const m = clone(helloManifest); Object.assign(m.ui, uiExtra); if (mut) mut(m); return manifest.validate(m); };

  it('booleans, default false', () => {
    const r = check({ geolocation: true, inbox: true });
    assert.equal(r.ok, true, r.errors.join(', '));
    assert.equal(r.manifest.ui.geolocation, true);
    assert.equal(r.manifest.ui.inbox, true);
    const d = check({});
    assert.equal(d.manifest.ui.geolocation, false);
    assert.equal(d.manifest.ui.inbox, false);
    assert.deepEqual(check({ geolocation: 'yes' }).errors, ['ui.geolocation: invalid']);
    assert.deepEqual(check({ inbox: 1 }).errors, ['ui.inbox: invalid']);
  });

  it('ui.inbox needs a portal UI (the inbox only reaches portal frames)', () => {
    assert.deepEqual(check({ inbox: true }, (m) => { delete m.ui.portal; }).errors, ['ui.inbox: needs ui.portal']);
    assert.equal(check({ inbox: false }, (m) => { delete m.ui.portal; }).ok, true);
  });

  it('the install dialog lists both, in German and English', () => {
    assert.equal(inspectedGeo.plugin.permissions.geolocation, true);
    assert.equal(inspectedGeo.plugin.permissions.inbox, true);
    const rows = (lang) => PUI.permRows(inspectedGeo.plugin.permissions, (k, p) => {
      const s = (lang === 'en' ? en : de)[k];
      assert.ok(s, 'missing ' + lang + ' ' + k);
      return s.replace(/\{\{(\w+)\}\}/g, (_, x) => (p && p[x] != null ? String(p[x]) : ''));
    });
    for (const lang of ['de', 'en']) {
      const r = rows(lang);
      const t = lang === 'en' ? en : de;
      assert.ok(r.some((x) => x.label === t['plugins.perm.geolocation'] && x.value === t['plugins.perm.geolocation_on']));
      assert.ok(r.some((x) => x.label === t['plugins.perm.inbox'] && x.value === t['plugins.perm.inbox_on']));
      assert.equal(new Set(r.map((x) => x.label)).size, r.length, 'labels stay unique (the update diff keys on them)');
    }
    assert.equal(plugins.list('de').find((p) => p.id === 'hello-flat').permissions.geolocation, false);
  });
});

describe('templates', () => {
  it('portal and admin frames of a ui.geolocation plugin may use the location; next to the microphone of a media plugin', async () => {
    const portal = (await agent.get('/portal').expect(200)).text;
    assert.match(portal, /src="\/portal\/plugins\/hello-geo\/frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy" allow="geolocation \*"/);
    assert.match(portal, /src="\/portal\/plugins\/hello-geomedia\/frame" sandbox="allow-scripts allow-forms allow-downloads" referrerpolicy="no-referrer" loading="lazy" allow="microphone \*; geolocation \*"/);
    assert.match(portal, /src="\/portal\/plugins\/hello-flat\/frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy"\s+data-plugin-frame/);
    const page = (await agent.get('/plugins/hello-geo').expect(200)).text;
    assert.match(/<iframe class="pg-frame"[^>]*>/.exec(page)[0], /referrerpolicy="no-referrer" allow="geolocation \*"/);
    assert.match(/<iframe class="pg-frame"[^>]*>/.exec((await agent.get('/plugins/hello-geomedia').expect(200)).text)[0], /allow="microphone \*; geolocation \*"/);
    assert.doesNotMatch((await agent.get('/plugins/hello-flat').expect(200)).text, /allow="/);
    // nothing else of the frame changes: same CSP as a plugin without the flag
    const csp = (id) => agent.get(`/portal/plugins/${id}/frame`).expect(200).then((r) => r.headers['content-security-policy'].replace(/127\.0\.0\.1:\d+/g, 'host'));
    assert.equal(await csp('hello-geo'), await csp('hello-flat'));
  });

  it('only portal frames of a ui.inbox plugin carry data-plugin-inbox', async () => {
    const portal = (await agent.get('/portal').expect(200)).text;
    assert.match(portal, /data-plugin-id="hello-geo"[^>]*data-plugin-inbox/);
    assert.doesNotMatch(/data-plugin-id="hello-geomedia"[^>]*>/.exec(portal)[0], /data-plugin-inbox/);
    assert.doesNotMatch(/data-plugin-id="hello-flat"[^>]*>/.exec(portal)[0], /data-plugin-inbox/);
    assert.doesNotMatch((await agent.get('/plugins/hello-geo').expect(200)).text, /data-plugin-inbox/, 'never on the admin page');
  });
});

describe('the frame client: GC.inbox', () => {
  function client() {
    const doc = frame.document({ html: '', lang: 'de' });
    const start = doc.indexOf('<script>') + '<script>'.length;
    const posted = [];
    let onMessage = null;
    const timers = [];
    const parent = { postMessage: (m) => posted.push(m) };
    const win = { parent, addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, getComputedStyle: () => ({}), innerWidth: 1, innerHeight: 1 };
    const ctx = { window: win, document: { documentElement: { lang: 'de', offsetHeight: 1, setAttribute() {} }, body: null },
      setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, Object, Error, Promise, Math, Number, String };
    vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), ctx);
    return { GC: win.GC, posted, deliver: (data, source = parent) => onMessage({ source, data }), flush: () => timers.splice(0).forEach((f) => f()) };
  }

  it('on subscribes once, passes the parent\'s summary on, a later listener gets the last one, off unsubscribes; open asks the parent', () => {
    const c = client();
    assert.equal(Object.isFrozen(c.GC.inbox), true);
    const got = [];
    const f1 = (s) => got.push(['f1', s.unread]);
    const f2 = (s) => got.push(['f2', s.unread]);
    c.GC.inbox.on(f1);
    c.GC.inbox.on(f1);
    c.GC.inbox.on('not a function');
    assert.equal(c.posted.filter((m) => m.type === 'gc-inbox-subscribe').length, 1);
    c.deliver({ type: 'gc-inbox', inbox: { available: true, unread: 3, latest: { title: 'Tür offen', createdAt: '2026-10-18T10:00:00Z', priority: 'high' } } });
    c.deliver({ type: 'gc-inbox', inbox: { available: true, unread: 9 } }, { not: 'the parent' });
    c.deliver({ type: 'gc-inbox', inbox: 'garbage' });
    assert.deepEqual(got, [['f1', 3]]);
    c.GC.inbox.on(f2);
    c.flush();
    assert.deepEqual(got, [['f1', 3], ['f2', 3]]);
    assert.equal(c.posted.filter((m) => m.type === 'gc-inbox-subscribe').length, 1);
    c.GC.inbox.off(f1);
    c.GC.inbox.off(f2);
    c.GC.inbox.off(f2);
    assert.equal(c.posted.filter((m) => m.type === 'gc-inbox-unsubscribe').length, 1);
    c.GC.inbox.open();
    assert.equal(c.posted.filter((m) => m.type === 'gc-inbox-open').length, 1);
  });
});

describe('the parent page (plugin-bridge.js): GC.inbox', () => {
  function bridge({ inbox = true, base = '/api/v1/portal/plugins/hello-geo/api/', page = true } = {}) {
    const replies = [];
    const handlers = {};
    const docListeners = {};
    const asked = [];
    const attrs = { 'data-plugin-api': base, 'data-plugin-id': 'hello-geo', 'data-plugin-pages': '[]', ...(inbox ? { 'data-plugin-inbox': '' } : {}) };
    const frameEl = { contentWindow: { postMessage: (m) => replies.push(m) }, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener() {}, style: {} };
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
    const document = {
      readyState: 'complete', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frameEl], getElementById: () => null,
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
      dispatchEvent: (ev) => { (docListeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    };
    // the portal's side (portal.js): takes requests and opens, announces its state
    if (page) {
      document.addEventListener('gc:inbox-request', (e) => { e.detail.handled = true; asked.push('request'); });
      document.addEventListener('gc:inbox-open', (e) => { e.detail.handled = true; asked.push('open'); });
    }
    const announce = (detail) => document.dispatchEvent(new CustomEvent('gc:inbox', { detail }));
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, addEventListener: (type, fn) => { handlers[type] = fn; } },
      document, CustomEvent,
      MutationObserver: class { observe() {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      JSON,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8'), ctx);
    const send = (data, origin = 'null') => handlers.message({ source: frameEl.contentWindow, origin, data });
    const inboxReplies = () => plain(replies.filter((m) => m.type === 'gc-inbox').map((m) => m.inbox));
    return { replies, send, announce, asked, inboxReplies };
  }
  const OFF = { available: false, unread: 0, latest: null };

  it('subscribe asks the portal; its announcements reach the frame — count, title, time, priority only', () => {
    const b = bridge();
    b.announce({ unread: 1, latest: { title: 'vorher' } });
    assert.deepEqual(b.inboxReplies(), [], 'nothing before the frame subscribes');
    b.send({ type: 'gc-inbox-subscribe' });
    b.send({ type: 'gc-inbox-subscribe' });
    assert.deepEqual(b.asked, ['request'], 'asked once');
    b.announce({ unread: 2, latest: { id: 7, title: 'x'.repeat(300), body: 'secret', data: { facts: [] }, createdAt: '2026-10-18T10:00:00Z', priority: 'critical', topic: 'security' }, items: [{ id: 1 }] });
    b.announce({ unread: -5, latest: { title: 'Neu', priority: 'evil' } });
    b.announce('garbage');
    assert.deepEqual(b.inboxReplies(), [
      { available: true, unread: 2, latest: { title: 'x'.repeat(200), createdAt: '2026-10-18T10:00:00Z', priority: 'critical' } },
      { available: true, unread: 0, latest: { title: 'Neu', createdAt: null, priority: 'normal' } },
    ]);
    b.send({ type: 'gc-inbox-unsubscribe' });
    b.announce({ unread: 4, latest: null });
    assert.equal(b.inboxReplies().length, 2, 'nothing after unsubscribing');
    b.send({ type: 'gc-inbox-subscribe' });
    b.send({ type: 'gc-hello' }); // a new document in the frame: its subscription ends with the old one
    b.announce({ unread: 5, latest: null });
    assert.equal(b.inboxReplies().length, 2);
  });

  it('open asks the portal to show its inbox', () => {
    const b = bridge();
    b.send({ type: 'gc-inbox-open' });
    assert.deepEqual(b.asked, ['open']);
    b.send({ type: 'gc-inbox-open' }, 'https://evil.example');
    assert.deepEqual(b.asked, ['open'], 'messages of other windows are ignored');
  });

  it('available: false — without the attribute, on an admin page, on a page without the notification center', () => {
    const n = bridge({ inbox: false });
    n.send({ type: 'gc-inbox-subscribe' });
    n.send({ type: 'gc-inbox-open' });
    assert.deepEqual(n.asked, [], 'the portal is never asked');
    n.announce({ unread: 3, latest: { title: 'geheim' } });
    assert.deepEqual(n.inboxReplies(), [OFF]);
    const a = bridge({ base: '/api/v1/plugins/hello-geo/api/' });
    a.send({ type: 'gc-inbox-subscribe' });
    a.announce({ unread: 3, latest: { title: 'geheim' } });
    assert.deepEqual(a.inboxReplies(), [OFF]);
    const p = bridge({ page: false });
    p.send({ type: 'gc-inbox-subscribe' });
    p.announce({ unread: 3, latest: { title: 'geheim' } });
    assert.deepEqual(p.inboxReplies(), [OFF], 'nobody took the request: unsubscribed again');
  });
});

describe('portal.js hands its own inbox state to the bridge', () => {
  it('announces gc:inbox from the bell\'s state and answers gc:inbox-request / gc:inbox-open', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
    assert.match(src, /new CustomEvent\('gc:inbox', \{ detail: detail \}\)/);
    assert.match(src, /addEventListener\('gc:inbox-request'/);
    assert.match(src, /addEventListener\('gc:inbox-open'[\s\S]{0,200}activate\('mitteilungen'/);
    // only title, time and priority of the newest item travel
    const fn = /function announceInbox[\s\S]*?\n {2}\}/.exec(src)[0];
    assert.doesNotMatch(fn, /\.body|\.data|\.facts/);
  });
});
