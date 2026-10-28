'use strict';

// GC.keys, GC.mediaBytes, GC.openTab (docs/plugins.md "User interface", since 1.211.0): the frame keeps WebCrypto keys
// in the parent page's IndexedDB (never extractable secret / private keys), gets the bytes of its own media URLs
// through the parent, and opens its own public endpoints in a new tab during a click.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frame = require('../src/services/plugins/frame');

const plain = (v) => JSON.parse(JSON.stringify(v));
const subtle = globalThis.crypto.subtle;
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('the frame client', () => {
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

  it('posts the key operations, media requests and tabs and resolves with the answers', async () => {
    const c = client();
    const p = c.GC.keys.get('device-7');
    const m = c.posted.find((x) => x.type === 'gc-keys');
    assert.deepEqual(plain(m), { type: 'gc-keys', id: m.id, op: 'get', name: 'device-7', value: null });
    c.deliver({ type: 'gc-result', id: m.id, ok: true, data: null });
    assert.equal(await p, null);
    const b = c.GC.mediaBytes('/plugin-media/x', { start: 0, end: 99 });
    const mb = c.posted.find((x) => x.type === 'gc-media-bytes');
    assert.deepEqual([mb.url, mb.start, mb.end], ['/plugin-media/x', 0, 99]);
    c.deliver({ type: 'gc-result', id: mb.id, ok: false, status: 400, error: 'invalid request' });
    await assert.rejects(b, /invalid request/);
    const t = c.GC.openTab('/plugin-public/hello/x');
    const mt = c.posted.find((x) => x.type === 'gc-open-tab');
    c.deliver({ type: 'gc-result', id: mt.id, ok: true, data: { ok: false, code: 'no_gesture' } });
    assert.deepEqual(plain(await t), { ok: false, code: 'no_gesture' });
  });
});

/** A small IndexedDB in memory: open (with upgrade), transactions, get / put / delete / count (also with a range). */
function fakeIndexedDB() {
  const stores = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (fn) => { const r = {}; later(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); }); return r; };
  const db = {
    createObjectStore: (n) => { stores.set(n, new Map()); },
    transaction: (n) => {
      const tx = {};
      const s = stores.get(n);
      const store = {
        get: (k) => request(() => s.get(k)),
        put: (v, k) => request(() => { s.set(k, v); }),
        delete: (k) => request(() => { s.delete(k); }),
        count: (k) => request(() => (k && typeof k === 'object' ? [...s.keys()].filter((x) => x >= k.lower && x <= k.upper).length : (s.has(k) ? 1 : 0))),
      };
      tx.objectStore = () => store;
      later(() => later(() => { if (tx.oncomplete) tx.oncomplete(); }));
      return tx;
    },
  };
  return {
    stores,
    open: () => { const r = {}; later(() => { r.result = db; if (!stores.size && r.onupgradeneeded) r.onupgradeneeded(); r.onsuccess(); }); return r; },
  };
}

describe('the parent page (plugin-bridge.js)', () => {
  function bridge({ fetchImpl, active = true } = {}) {
    const replies = [];
    const transfers = [];
    const handlers = {};
    const opened = [];
    const attrs = { 'data-plugin-api': '/api/v1/portal/plugins/hello/api/', 'data-plugin-id': 'hello', 'data-plugin-pages': '[]' };
    const frameEl = { contentWindow: { postMessage: (m, o, t) => { replies.push(m); if (t) transfers.push(t); } }, getAttribute: (k) => (k in attrs ? attrs[k] : null), addEventListener() {}, style: {} };
    const document = {
      readyState: 'complete', documentElement: { getAttribute: () => 'dark' }, querySelectorAll: () => [frameEl], getElementById: () => null,
      addEventListener() {}, dispatchEvent: () => true, createElement: () => ({ style: {} }), body: { appendChild() {} },
    };
    const idb = fakeIndexedDB();
    const fetched = [];
    const ctx = {
      window: { GC: { csrfToken: 'tok' }, addEventListener: (type, fn) => { handlers[type] = fn; }, location: { href: 'https://gc.example.com/portal', origin: 'https://gc.example.com' },
        open: (u, target, features) => { opened.push({ u, target, features }); return null; } },
      navigator: { userActivation: { isActive: active } },
      document, CustomEvent: class {}, MutationObserver: class { observe() {} }, JSON, Blob, URL, CryptoKey, indexedDB: idb,
      IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) },
      fetch: async (u, o) => { fetched.push({ u, o }); return fetchImpl(u, o); },
      Date, setTimeout, Number, Promise, Object,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8'), ctx);
    const send = (data, origin = 'null') => handlers.message({ source: frameEl.contentWindow, origin, data });
    const result = (id) => replies.find((m) => m.type === 'gc-result' && m.id === id);
    return { send, result, idb, opened, fetched, transfers };
  }

  it('keeps keys per plugin and name, never an extractable secret or private key', async () => {
    const b = bridge();
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const open = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    b.send({ type: 'gc-keys', id: 1, op: 'put', name: 'device-7', value: pair });
    b.send({ type: 'gc-keys', id: 2, op: 'put', name: 'leak', value: open });
    b.send({ type: 'gc-keys', id: 3, op: 'put', name: '../x', value: pair });
    b.send({ type: 'gc-keys', id: 4, op: 'put', name: 'odd', value: { publicKey: pair.publicKey, privateKey: pair.privateKey, extra: 1 } });
    await flush();
    assert.equal(b.result(1).ok, true);
    assert.deepEqual([2, 3, 4].map((i) => b.result(i).status), [400, 400, 400]);
    assert.deepEqual([...b.idb.stores.get('keys').keys()], ['hello/device-7']);
    b.send({ type: 'gc-keys', id: 5, op: 'get', name: 'device-7' });
    b.send({ type: 'gc-keys', id: 6, op: 'get', name: 'nope' });
    await flush();
    assert.equal(b.result(5).data.privateKey, pair.privateKey);
    assert.equal(b.result(6).data, null);
    b.send({ type: 'gc-keys', id: 7, op: 'remove', name: 'device-7' });
    await flush();
    assert.equal(b.result(7).data, true);
    assert.equal(b.idb.stores.get('keys').size, 0);
  });

  it('fetches the plugin\'s own media URLs (a range, ≤ 16 MiB) and hands the bytes over', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const b = bridge({ fetchImpl: async () => ({ ok: true, status: 206, headers: { get: (h) => ({ 'content-length': '4', 'content-range': 'bytes 10-13/100' }[h] || null) }, arrayBuffer: async () => bytes.buffer.slice(0) }) });
    const url = '/plugin-media/' + 'a'.repeat(32) + '.1700000000.7.' + 'b'.repeat(22);
    b.send({ type: 'gc-media-bytes', id: 1, url, start: 10, end: 13 });
    await flush();
    const r = b.result(1);
    assert.equal(r.ok, true);
    assert.deepEqual([r.data.start, r.data.end, r.data.total], [10, 13, 100]);
    assert.deepEqual([...new Uint8Array(r.data.data)], [1, 2, 3, 4]);
    assert.equal(b.transfers.length, 1, 'the buffer is transferred');
    assert.equal(b.fetched[0].o.credentials, 'omit');
    assert.equal(b.fetched[0].o.headers.Range, 'bytes=10-13');
    assert.equal(b.fetched[0].o.headers['X-GC-Plugin'], 'hello', 'the server refuses another plugin\'s file (tests/plugins_media.test.js)');
    for (const [id, u, s, e] of [[2, '/api/v1/portal/plugins/hello/api/me', null, null], [3, 'https://evil.example' + url, null, null], [4, url, 0, 17 * 1024 * 1024], [5, url + '?x=1', null, null], [6, url, 5, 1]]) {
      b.send({ type: 'gc-media-bytes', id, url: u, start: s, end: e });
    }
    await flush();
    assert.deepEqual([2, 3, 4, 5, 6].map((i) => b.result(i).status), [400, 400, 400, 400, 400]);
    assert.equal(b.fetched.length, 1);
  });

  it('opens only the plugin\'s own public endpoints, only during a click', async () => {
    const b = bridge();
    b.send({ type: 'gc-open-tab', id: 1, url: '/plugin-public/hello/office/open/7?access_token=x' });
    b.send({ type: 'gc-open-tab', id: 2, url: '/plugin-public/other/x' });
    b.send({ type: 'gc-open-tab', id: 3, url: 'https://evil.example/plugin-public/hello/x' });
    b.send({ type: 'gc-open-tab', id: 4, url: '/settings' });
    assert.deepEqual(plain([1, 2, 3, 4].map((i) => b.result(i).data)), [{ ok: true }, { ok: false, code: 'invalid' }, { ok: false, code: 'invalid' }, { ok: false, code: 'invalid' }]);
    assert.deepEqual(b.opened.map((o) => [o.u, o.target, o.features]), [['https://gc.example.com/plugin-public/hello/office/open/7?access_token=x', '_blank', 'noopener,noreferrer']]);
    const idle = bridge({ active: false });
    idle.send({ type: 'gc-open-tab', id: 1, url: '/plugin-public/hello/x' });
    assert.deepEqual(plain(idle.result(1).data), { ok: false, code: 'no_gesture' });
    assert.equal(idle.opened.length, 0);
  });
});
