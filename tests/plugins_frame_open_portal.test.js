'use strict';

// GC.openPortal (docs/plugins.md "User interface", since 1.254.0): a portal frame opens another plugin's portal tab
// with a short query — the address of a direct link ("/portal?<key>=<value>#plg-<id>") — only during a click, only
// a tab that is there, at most every 1.5 s; frames of the admin pages cannot.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frame = require('../src/services/plugins/frame');

const plain = (v) => JSON.parse(JSON.stringify(v));

describe('GC.openPortal in the frame', () => {
  it('posts the plugin and the query and resolves with the answer', async () => {
    const doc = frame.document({ html: '', lang: 'de' });
    const start = doc.indexOf('<script>') + '<script>'.length;
    const posted = [];
    let onMessage = null;
    const parent = { postMessage: (m) => posted.push(m) };
    const win = { parent, addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, getComputedStyle: () => ({}), innerWidth: 1, innerHeight: 1 };
    const ctx = { window: win, document: { documentElement: { lang: 'de', offsetHeight: 1, setAttribute() {} }, body: null },
      setTimeout: () => 1, clearTimeout() {}, Object, Error, Promise, Math, Number, String, Blob };
    vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), ctx);
    const p = win.GC.openPortal({ plugin: 'gatecontrol-mail', query: { open: 'message/42' } });
    const m = posted.find((x) => x.type === 'gc-open-portal');
    assert.deepEqual(plain(m), { type: 'gc-open-portal', id: m.id, plugin: 'gatecontrol-mail', query: { open: 'message/42' } });
    onMessage({ source: parent, data: { type: 'gc-result', id: m.id, ok: true, data: { ok: true } } });
    assert.deepEqual(plain(await p), { ok: true });
    const q = win.GC.openPortal({ plugin: 'gatecontrol-drive' });
    const n = posted.filter((x) => x.type === 'gc-open-portal')[1];
    assert.deepEqual(plain(n.query), {});
    onMessage({ source: parent, data: { type: 'gc-result', id: n.id, ok: true, data: { ok: false, code: 'not_found' } } });
    assert.deepEqual(plain(await q), { ok: false, code: 'not_found' });
  });
});

describe('GC.openPortal in the parent page (plugin-bridge.js)', () => {
  function bridge({ api = '/api/v1/portal/plugins/gatecontrol-notizen/api/', tabs = ['gatecontrol-mail', 'gatecontrol-drive'] } = {}) {
    const replies = [];
    const handlers = {};
    const assigned = [];
    const ua = { isActive: true };
    let now = 1700000000000;
    const attrs = { 'data-plugin-api': api, 'data-plugin-id': 'gatecontrol-notizen', 'data-plugin-pages': '[]' };
    const frameEl = { contentWindow: { postMessage: (m) => replies.push(m) }, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener() {}, style: {} };
    const panels = Object.fromEntries(tabs.map((t) => ['panel-plg-' + t, { querySelector: (s) => (s === 'iframe[data-plugin-frame]' ? {} : null) }]));
    const document = {
      readyState: 'complete', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frameEl], getElementById: (id) => panels[id] || null,
      addEventListener() {}, dispatchEvent: () => true, createElement: () => ({ style: {} }), body: { appendChild() {} },
    };
    class FakeDate extends Date { static now() { return now; } }
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, addEventListener: (type, fn) => { handlers[type] = fn; },
        location: { href: 'https://gc.example.com/portal#plg-gatecontrol-notizen', origin: 'https://gc.example.com', assign: (u) => assigned.push(u) },
        open() { return null; } },
      navigator: { userActivation: ua },
      document, CustomEvent: class {}, MutationObserver: class { observe() {} }, JSON, Blob, URL, indexedDB: null,
      fetch: async () => { throw new Error('no fetch'); }, Date: FakeDate, setTimeout, Number, Promise, Object,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8'), ctx);
    let id = 0;
    const open = (plugin, query) => {
      handlers.message({ source: frameEl.contentWindow, origin: 'null', data: { type: 'gc-open-portal', id: ++id, plugin, query } });
      return plain(replies.find((m) => m.type === 'gc-result' && m.id === id).data);
    };
    return { open, assigned, ua, later: (ms) => { now += ms; } };
  }

  it('opens the tab with the query of a direct link, during a click only, at most every 1.5 s', () => {
    const b = bridge();
    assert.deepEqual(b.open('gatecontrol-mail', { open: 'message/42', account: 3 }), { ok: true });
    assert.deepEqual(b.assigned, ['/portal?open=message%2F42&account=3#plg-gatecontrol-mail']);
    assert.deepEqual(b.open('gatecontrol-drive', {}), { ok: false, code: 'rate_limited' });
    b.later(1500);
    assert.deepEqual(b.open('gatecontrol-drive', null), { ok: true });
    assert.equal(b.assigned[1], '/portal#plg-gatecontrol-drive');
    b.later(2000);
    b.ua.isActive = false;
    assert.deepEqual(b.open('gatecontrol-mail', { open: 'x' }), { ok: false, code: 'no_gesture' });
    assert.equal(b.assigned.length, 2);
  });

  it('refuses another address, a long or odd query and a tab that is not there', () => {
    const b = bridge();
    const bad = [
      ['../admin', {}], ['Gatecontrol-Mail', {}], ['', {}], [42, {}], ['gatecontrol-mail', ['x']], ['gatecontrol-mail', 'open=x'],
      ['gatecontrol-mail', { section: 'x' }], ['gatecontrol-mail', { Open: 'x' }], ['gatecontrol-mail', { 'a-b': 'x' }],
      ['gatecontrol-mail', { open: 'x'.repeat(201) }], ['gatecontrol-mail', { open: { deep: 1 } }],
      ['gatecontrol-mail', Object.fromEntries([...Array(9)].map((_, i) => ['k' + i, 'v']))],
    ];
    for (const [plugin, query] of bad) assert.deepEqual(b.open(plugin, query), { ok: false, code: 'invalid' }, JSON.stringify([plugin, query]));
    assert.deepEqual(b.open('gatecontrol-schule', { open: 'x' }), { ok: false, code: 'not_found' });
    assert.deepEqual(b.assigned, []);
  });

  it('is for portal frames only', () => {
    const b = bridge({ api: '/api/v1/plugins/gatecontrol-notizen/api/' });
    assert.deepEqual(b.open('gatecontrol-mail', { open: 'x' }), { ok: false, code: 'not_allowed' });
    assert.deepEqual(b.assigned, []);
  });
});
