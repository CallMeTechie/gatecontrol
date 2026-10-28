'use strict';

// GC.openUrl (docs/plugins.md "Cloud import", permissions.cloudImport): the
// sandboxed frame hands the address of gc.cloud.connectUrl to the parent
// page, which opens it in the same tab — only
// <GC_BASE_URL>/oauth/cloud/start?flow=<id>, nothing else.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frame = require('../src/services/plugins/frame');

const plain = (v) => JSON.parse(JSON.stringify(v));
const FLOW = 'https://gate.example.de/oauth/cloud/start?flow=' + 'A'.repeat(32);

describe('the frame client: GC.openUrl', () => {
  function client(openUrl) {
    const doc = frame.document({ html: '', lang: 'de', openUrl });
    const start = doc.indexOf('<script>') + '<script>'.length;
    const posted = [];
    let onMessage = null;
    const parent = { postMessage: (m) => posted.push(m) };
    const win = { parent, addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, getComputedStyle: () => ({}), innerWidth: 1, innerHeight: 1 };
    const ctx = { window: win, document: { documentElement: { lang: 'de', offsetHeight: 1, setAttribute() {} }, body: null },
      setTimeout: () => 1, clearTimeout() {}, Object, Error, Promise, Math, Number, String };
    vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), ctx);
    return { GC: win.GC, posted, deliver: (data) => onMessage({ source: parent, data }) };
  }

  it('only plugins with permissions.cloudImport have it', () => {
    assert.equal(typeof client(false).GC.openUrl, 'undefined');
    assert.equal(typeof client(true).GC.openUrl, 'function');
    assert.equal(frame.openUrlOf({ permissions: { cloudImport: { purpose: { de: 'x', en: 'x' } } } }), true);
    assert.equal(frame.openUrlOf({ permissions: { cloudImport: null } }), false);
  });

  it('posts the address and resolves or rejects with the page\'s answer', async () => {
    const c = client(true);
    const p = c.GC.openUrl(FLOW);
    const m = c.posted.find((x) => x.type === 'gc-open');
    assert.equal(m.url, FLOW);
    c.deliver({ type: 'gc-result', id: m.id, ok: true, data: { ok: true } });
    assert.deepEqual(plain(await p), { ok: true });
    const q = c.GC.openUrl('https://evil.example/');
    const n = c.posted.filter((x) => x.type === 'gc-open')[1];
    c.deliver({ type: 'gc-result', id: n.id, ok: false, status: 400, error: 'not allowed' });
    await assert.rejects(q, /not allowed/);
  });
});

describe('the parent page (plugin-bridge.js): GC.openUrl', () => {
  function bridge(cloudAttr) {
    const replies = [];
    const handlers = {};
    const assigned = [];
    const attrs = { 'data-plugin-api': '/api/v1/portal/plugins/hello/api/', 'data-plugin-id': 'hello', 'data-plugin-pages': '[]' };
    if (cloudAttr !== undefined) attrs['data-plugin-cloud'] = cloudAttr;
    const frameEl = { contentWindow: { postMessage: (m) => replies.push(m) }, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener() {}, style: {} };
    const document = {
      readyState: 'complete', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frameEl], getElementById: () => null,
      addEventListener() {}, dispatchEvent: () => true, body: { appendChild() {} },
    };
    let now = 1000000;
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, addEventListener: (type, fn) => { handlers[type] = fn; },
        location: { href: 'https://home.example.de/portal#plg-hello', assign: (u) => assigned.push(u) } },
      document, CustomEvent: class {}, MutationObserver: class { observe() {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), JSON, URL, Date: { now: () => now }, setTimeout: () => 1,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8'), ctx);
    const send = (data, origin = 'null') => handlers.message({ source: frameEl.contentWindow, origin, data });
    const results = () => plain(replies.filter((m) => m.type === 'gc-result'));
    return { send, results, assigned, tick: (ms) => { now += ms; } };
  }

  it('opens the connect address of GC_BASE_URL in the same tab', () => {
    const b = bridge('https://gate.example.de');
    b.send({ type: 'gc-open', id: 1, url: FLOW });
    assert.deepEqual(b.assigned, [FLOW]);
    assert.deepEqual(b.results(), [{ type: 'gc-result', id: 1, ok: true, status: 200, data: { ok: true } }]);
  });

  it('refuses every other address, frames without the attribute, other senders and a burst', () => {
    const b = bridge('https://gate.example.de');
    const bad = [
      'https://evil.example/oauth/cloud/start?flow=' + 'A'.repeat(32),
      'https://gate.example.de/oauth/cloud/callback?state=x&code=y',
      'https://gate.example.de/settings/plugins',
      'https://gate.example.de/oauth/cloud/start?flow=short',
      FLOW + '&go=1',
      FLOW + '#x',
      'https://user@gate.example.de/oauth/cloud/start?flow=' + 'A'.repeat(32),
      'http://gate.example.de/oauth/cloud/start?flow=' + 'A'.repeat(32),
      'javascript:alert(1)',
      '/portal',
    ];
    bad.forEach((url, i) => b.send({ type: 'gc-open', id: i + 1, url }));
    assert.deepEqual(b.assigned, []);
    assert.equal(b.results().every((r) => r.ok === false && r.error === 'not allowed'), true);
    // a relative address resolves against GC_BASE_URL
    b.send({ type: 'gc-open', id: 50, url: '/oauth/cloud/start?flow=' + 'B'.repeat(32) });
    assert.deepEqual(b.assigned, ['https://gate.example.de/oauth/cloud/start?flow=' + 'B'.repeat(32)]);
    // at most one per 1.5 s
    b.send({ type: 'gc-open', id: 51, url: FLOW });
    assert.equal(b.assigned.length, 1);
    b.tick(2000);
    b.send({ type: 'gc-open', id: 52, url: FLOW });
    assert.equal(b.assigned.length, 2);
    // a message that does not come from the frame itself
    b.tick(2000);
    b.send({ type: 'gc-open', id: 53, url: FLOW }, 'https://evil.example');
    assert.equal(b.assigned.length, 2);
    // a frame without permissions.cloudImport
    const none = bridge(undefined);
    none.send({ type: 'gc-open', id: 1, url: FLOW });
    assert.deepEqual(none.assigned, []);
    assert.equal(none.results()[0].error, 'not allowed');
  });
});
