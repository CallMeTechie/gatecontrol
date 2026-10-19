'use strict';

// GC.saveFile (docs/plugins.md "User interface", since 1.186.0): the frame
// hands a Blob to the parent page, which checks type and size, cleans the
// name and offers the file as a download from its own document.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frame = require('../src/services/plugins/frame');

const plain = (v) => JSON.parse(JSON.stringify(v));

describe('the frame client: GC.saveFile', () => {
  function client() {
    const doc = frame.document({ html: '', lang: 'de' });
    const start = doc.indexOf('<script>') + '<script>'.length;
    const posted = [];
    let onMessage = null;
    const parent = { postMessage: (m) => posted.push(m) };
    const win = { parent, addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, getComputedStyle: () => ({}), innerWidth: 1, innerHeight: 1 };
    const ctx = { window: win, document: { documentElement: { lang: 'de', offsetHeight: 1, setAttribute() {} }, body: null },
      setTimeout: () => 1, clearTimeout() {}, Object, Error, Promise, Math, Number, String, Blob };
    vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), ctx);
    return { GC: win.GC, posted, deliver: (data) => onMessage({ source: parent, data }) };
  }

  it('posts the Blob and the name, resolves with the parent\'s answer; a non-Blob is refused', async () => {
    const c = client();
    await assert.rejects(c.GC.saveFile('text', 'a.csv'), /needs a Blob/);
    const blob = new Blob(['a;b\n1;2\n'], { type: 'text/csv' });
    const p = c.GC.saveFile(blob, 'Fahrtenbuch Oktober.csv');
    const m = c.posted.find((x) => x.type === 'gc-save');
    assert.equal(m.file, blob);
    assert.equal(m.name, 'Fahrtenbuch Oktober.csv');
    c.deliver({ type: 'gc-result', id: m.id, ok: true, data: { ok: true, name: 'Fahrtenbuch Oktober.csv' } });
    assert.deepEqual(plain(await p), { ok: true, name: 'Fahrtenbuch Oktober.csv' });
  });
});

describe('the parent page (plugin-bridge.js): GC.saveFile', () => {
  function bridge() {
    const replies = [];
    const handlers = {};
    const clicked = [];
    const attrs = { 'data-plugin-api': '/api/v1/plugins/hello/api/', 'data-plugin-id': 'hello', 'data-plugin-pages': '[]' };
    const frameEl = { contentWindow: { postMessage: (m) => replies.push(m) }, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener() {}, style: {} };
    const document = {
      readyState: 'complete', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frameEl], getElementById: () => null,
      addEventListener() {}, dispatchEvent: () => true,
      createElement: () => { const a = { style: {}, click() { clicked.push({ href: a.href, download: a.download, rel: a.rel }); }, remove() {} }; return a; },
      body: { appendChild() {} },
    };
    let now = 1000000;
    const objectUrls = [];
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, addEventListener: (type, fn) => { handlers[type] = fn; } },
      document, CustomEvent: class {}, MutationObserver: class { observe() {} },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), JSON, Blob,
      URL: { createObjectURL: (b) => { objectUrls.push(b); return 'blob:x/' + objectUrls.length; }, revokeObjectURL() {} },
      Date: { now: () => now },
      setTimeout: () => 1,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8'), ctx);
    const send = (data, origin = 'null') => handlers.message({ source: frameEl.contentWindow, origin, data });
    const results = () => plain(replies.filter((m) => m.type === 'gc-result'));
    return { send, results, clicked, objectUrls, tick: (ms) => { now += ms; } };
  }
  const csv = () => new Blob(['a;b\n'], { type: 'text/csv;charset=utf-8' });

  it('offers an allowed file as a download with a cleaned name and the type\'s extension', () => {
    const b = bridge();
    b.send({ type: 'gc-save', id: 1, file: csv(), name: '../../etc/Fahrtenbuch Škoda <Okt>.csv' });
    b.tick(2000);
    b.send({ type: 'gc-save', id: 2, file: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), name: 'bericht.exe' });
    b.tick(2000);
    b.send({ type: 'gc-save', id: 3, file: new Blob(['x'], { type: 'text/plain' }), name: '' });
    assert.deepEqual(b.clicked.map((c) => c.download), ['Fahrtenbuch Škoda _Okt_.csv', 'bericht.pdf', 'download.txt']);
    assert.ok(b.clicked.every((c) => c.href.startsWith('blob:') && c.rel === 'noopener'));
    assert.deepEqual(b.objectUrls.map((x) => x.type), ['text/csv', 'application/pdf', 'text/plain'], 'the type without parameters');
    assert.deepEqual(b.results().map((r) => [r.id, r.ok, r.data.name]), [[1, true, 'Fahrtenbuch Škoda _Okt_.csv'], [2, true, 'bericht.pdf'], [3, true, 'download.txt']]);
  });

  it('refuses other types, empty and too large files, a burst, and messages of other windows', () => {
    const b = bridge();
    b.send({ type: 'gc-save', id: 1, file: new Blob(['<script>'], { type: 'text/html' }), name: 'x.html' });
    b.send({ type: 'gc-save', id: 2, file: new Blob([], { type: 'text/csv' }), name: 'x.csv' });
    b.send({ type: 'gc-save', id: 3, file: 'not a blob', name: 'x.csv' });
    b.send({ type: 'gc-save', id: 4, file: { size: 21 * 1024 * 1024, type: 'text/csv' }, name: 'x.csv' });
    b.send({ type: 'gc-save', id: 5, file: csv(), name: 'x.csv' });
    b.send({ type: 'gc-save', id: 6, file: csv(), name: 'y.csv' });
    b.send({ type: 'gc-save', id: 7, file: csv(), name: 'z.csv' }, 'https://evil.example');
    assert.deepEqual(b.results().map((r) => [r.id, r.ok, r.status]), [[1, false, 400], [2, false, 400], [3, false, 400], [4, false, 400], [5, true, 200], [6, false, 429]]);
    assert.equal(b.clicked.length, 1);
  });
});
