'use strict';

// Tile relay for the map frames of ui.maps plugins (docs/plugins.md "Maps",
// src/services/plugins/tiles.js): the token, the coordinates, the upstream
// (one fetch per tile, at most two at a time, cache, stale copy on failure)
// and window.GC.tiles in the frame document. The route itself:
// tests/plugins_app.test.js "maps in plugin frames".

require('./helpers/test-env');
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const config = require('../config/default');
const logger = require('../src/utils/logger');
const tiles = require('../src/services/plugins/tiles');
const frame = require('../src/services/plugins/frame');

const PNG = (n = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);
const png = (body = PNG(), headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'max-age=3600', ...headers } });
const sig = (exp) => crypto.createHmac('sha256', config.app.secret).update(`plugin-tiles:${exp}`).digest('base64url').slice(0, tiles.SIG_LEN);
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), 'condition not reached');
}

/** fetch stand-in: every call waits until the test answers it. */
function deferredFetch() {
  const calls = [];
  const fn = mock.method(globalThis, 'fetch', (url, opts) => new Promise((resolve, reject) => calls.push({ url, opts, resolve, reject })));
  return { calls, fn };
}

describe('tile relay: token', () => {
  const now = Date.UTC(2026, 9, 17, 10, 20, 30);

  it('expires at the next full hour + 24 h, the same token for the whole hour', () => {
    const t = tiles.token(now);
    const exp = Date.UTC(2026, 9, 18, 11, 0, 0) / 1000;
    assert.equal(t, `${exp}.${sig(exp)}`);
    assert.equal(tiles.token(Date.UTC(2026, 9, 17, 10, 0, 0)), t);
    assert.equal(tiles.token(Date.UTC(2026, 9, 17, 10, 59, 59)), t);
    assert.notEqual(tiles.token(Date.UTC(2026, 9, 17, 11, 0, 0)), t);
    assert.equal(sig(exp).length, 22);
    assert.match(t, /^\d+\.[A-Za-z0-9_-]{22}$/);
  });

  it('valid until exp, never more than 26 h ahead', () => {
    const t = tiles.token(now);
    const exp = Number(t.split('.')[0]);
    assert.equal(tiles.verify(t, now), true);
    assert.equal(tiles.verify(t, exp * 1000 - 1000), true);
    assert.equal(tiles.verify(t, exp * 1000), false, 'expired');
    assert.equal(tiles.verify(t, exp * 1000 + 3600e3), false, 'expired');
    const far = Math.floor(now / 1000) + 26 * 3600 + 1;
    assert.equal(tiles.verify(`${far}.${sig(far)}`, now), false, 'too far ahead');
    const edge = Math.floor(now / 1000) + 26 * 3600;
    assert.equal(tiles.verify(`${edge}.${sig(edge)}`, now), true);
  });

  it('a forged or malformed token is refused', () => {
    const t = tiles.token(now);
    const [exp, s] = t.split('.');
    const flipped = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    for (const bad of [`${exp}.${flipped}`, `${Number(exp) - 3600}.${s}`, `${exp}.${s}x`, `${exp}.${s.slice(0, -1)}`, `${exp}.${crypto.createHmac('sha256', 'other').update(`plugin-tiles:${exp}`).digest('base64url').slice(0, 22)}`,
      '', 'x', `${exp}`, `.${s}`, `-${exp}.${s}`, `${exp}.${s}.x`, null, undefined]) {
      assert.equal(tiles.verify(bad, now), false, String(bad));
    }
  });

  it('template(): the URL template of the relay, a path of this server', () => {
    assert.equal(tiles.template(now), `/plugins/_shared/tiles/${tiles.token(now)}/{z}/{x}/{y}.png`);
  });
});

describe('tile relay: coordinates', () => {
  it('z 0–19, x and y 0 … 2^z − 1, integers only', () => {
    assert.deepEqual(tiles.coords('0', '0', '0'), { z: 0, x: 0, y: 0 });
    assert.deepEqual(tiles.coords('19', String(2 ** 19 - 1), '0'), { z: 19, x: 2 ** 19 - 1, y: 0 });
    assert.deepEqual(tiles.coords('3', '7', '7'), { z: 3, x: 7, y: 7 });
    for (const [z, x, y] of [['20', '0', '0'], ['0', '1', '0'], ['0', '0', '1'], ['3', '8', '0'], ['3', '0', '8'], ['-1', '0', '0'], ['1', '-1', '0'],
      ['1.5', '0', '0'], ['1', '0x1', '0'], ['a', '0', '0'], ['', '0', '0'], ['1', '1e0', '0'], ['19', '99999999', '0'], [' 1', '0', '0']]) {
      assert.equal(tiles.coords(z, x, y), null, `${z}/${x}/${y}`);
    }
  });
});

describe('tile relay: upstream', () => {
  beforeEach(() => tiles._reset());
  afterEach(() => { mock.restoreAll(); tiles._reset(); });

  it('fetches from OpenStreetMap with a User-Agent naming GateControl, caches the tile', async () => {
    const body = PNG(10);
    const f = mock.method(globalThis, 'fetch', async () => png(body));
    const a = await tiles.get({ z: 5, x: 3, y: 4 });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, body);
    assert.equal(f.mock.callCount(), 1);
    const [url, opts] = f.mock.calls[0].arguments;
    assert.equal(url, 'https://tile.openstreetmap.org/5/3/4.png');
    assert.match(opts.headers['User-Agent'], /^GateControl\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/CallMeTechie\/gatecontrol\)$/);
    assert.ok(opts.signal instanceof AbortSignal);
    const b = await tiles.get({ z: 5, x: 3, y: 4 });
    assert.deepEqual(b.body, body);
    assert.equal(f.mock.callCount(), 1, 'second request from the cache');
    assert.equal(tiles._stats().entries, 1);
  });

  it('at most two upstream requests at a time, the rest waits', async () => {
    const d = deferredFetch();
    const ps = [0, 1, 2, 3, 4].map((x) => tiles.get({ z: 4, x, y: 1 }));
    await tick();
    assert.equal(d.calls.length, 2);
    assert.equal(tiles._stats().queued, 3);
    d.calls[0].resolve(png());
    await until(() => d.calls.length === 3);
    await tick();
    assert.equal(d.calls.length, 3, 'one finished, one more started');
    d.calls[1].resolve(png());
    d.calls[2].resolve(png());
    await until(() => d.calls.length === 5);
    d.calls[3].resolve(png());
    d.calls[4].resolve(png());
    const out = await Promise.all(ps);
    assert.deepEqual(out.map((o) => o.status), [200, 200, 200, 200, 200]);
    assert.deepEqual(d.calls.map((c) => c.url), [0, 1, 2, 3, 4].map((x) => `https://tile.openstreetmap.org/4/${x}/1.png`));
    assert.deepEqual(tiles._stats(), { entries: 5, bytes: 5 * PNG().length, active: 0, queued: 0 });
  });

  it('concurrent requests for the same tile share one upstream fetch', async () => {
    const d = deferredFetch();
    const ps = [1, 2, 3, 4].map(() => tiles.get({ z: 2, x: 1, y: 1 }));
    await tick();
    assert.equal(d.calls.length, 1);
    d.calls[0].resolve(png(PNG(3)));
    const out = await Promise.all(ps);
    assert.ok(out.every((o) => o.status === 200 && o.body.equals(PNG(3))));
    assert.equal(d.fn.mock.callCount(), 1);
  });

  it('serves a stale copy when the upstream fails after the tile expired; logs at most once a minute', async () => {
    let t = Date.UTC(2026, 0, 1);
    mock.method(Date, 'now', () => t);
    const warn = mock.method(logger, 'warn', () => {});
    let answer = () => png(PNG(5), { 'cache-control': 'public, max-age=60' });
    const f = mock.method(globalThis, 'fetch', async () => answer());
    assert.equal((await tiles.get({ z: 1, x: 0, y: 0 })).status, 200);
    t += 23 * 3600e3; // max-age 60 s, clamped to 1 day: still fresh
    await tiles.get({ z: 1, x: 0, y: 0 });
    assert.equal(f.mock.callCount(), 1);
    t += 2 * 3600e3;
    answer = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
    const s = await tiles.get({ z: 1, x: 0, y: 0 });
    assert.equal(f.mock.callCount(), 2);
    assert.deepEqual([s.status, s.stale, s.body.equals(PNG(5))], [200, true, true]);
    answer = () => new Response('busy', { status: 503 });
    assert.equal((await tiles.get({ z: 1, x: 0, y: 0 })).stale, true);
    assert.equal((await tiles.get({ z: 1, x: 1, y: 0 })).status, 502, 'no stale copy');
    assert.equal(warn.mock.callCount(), 1, 'one log line per minute');
    assert.equal(warn.mock.calls[0].arguments[0].reason, 'timeout');
    t += 61e3;
    await tiles.get({ z: 1, x: 1, y: 1 });
    assert.equal(warn.mock.callCount(), 2);
    assert.equal(warn.mock.calls[1].arguments[0].reason, 'status 503');
    answer = () => png(PNG(6));
    const fresh = await tiles.get({ z: 1, x: 0, y: 0 });
    assert.deepEqual([fresh.stale, fresh.body.equals(PNG(6))], [undefined, true]);
  });

  it('upstream max-age clamped to [1 day, 7 days]', () => {
    assert.equal(tiles.ttlOf('max-age=60'), 86400e3);
    assert.equal(tiles.ttlOf(null), 86400e3);
    assert.equal(tiles.ttlOf('public, max-age=172800, stale-while-revalidate=1'), 172800e3);
    assert.equal(tiles.ttlOf('max-age=99999999'), 7 * 86400e3);
    assert.equal(tiles.ttlOf('s-maxage=999999'), 86400e3);
  });

  it('a tile older than its clamped max-age is fetched again', async () => {
    let t = Date.UTC(2026, 0, 1);
    mock.method(Date, 'now', () => t);
    const f = mock.method(globalThis, 'fetch', async () => png(PNG(), { 'cache-control': 'max-age=99999999' }));
    await tiles.get({ z: 0, x: 0, y: 0 });
    t += 7 * 86400e3 - 1000;
    await tiles.get({ z: 0, x: 0, y: 0 });
    assert.equal(f.mock.callCount(), 1);
    t += 2000;
    await tiles.get({ z: 0, x: 0, y: 0 });
    assert.equal(f.mock.callCount(), 2);
  });

  it('upstream 404 → 404, other failures → 502; only 200 image/png is cached', async () => {
    mock.method(logger, 'warn', () => {});
    const answers = [
      () => new Response('nope', { status: 404 }),
      () => new Response('blocked', { status: 403 }),
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => png(PNG(), { 'content-length': String(1024 * 1024) }),
      () => { throw new TypeError('fetch failed'); },
    ];
    let i = 0;
    const f = mock.method(globalThis, 'fetch', async () => answers[i++]());
    assert.equal((await tiles.get({ z: 3, x: 1, y: 1 })).status, 404);
    for (let k = 0; k < 4; k++) assert.equal((await tiles.get({ z: 3, x: 1, y: 1 })).status, 502, String(k));
    assert.equal(f.mock.callCount(), 5);
    assert.equal(tiles._stats().entries, 0);
  });

  it('the cache is bounded by bytes, least recently used out first', async () => {
    const size = 500 * 1024;
    const fit = Math.floor(tiles.CACHE_MAX_BYTES / size);
    const f = mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(size), { status: 200, headers: { 'content-type': 'image/png' } }));
    for (let x = 0; x < fit; x++) await tiles.get({ z: 8, x, y: 0 });
    assert.equal(tiles._stats().entries, fit);
    await tiles.get({ z: 8, x: 0, y: 0 }); // used again: 1 is now the oldest
    await tiles.get({ z: 8, x: fit, y: 0 }); // over the bound → 1 goes
    assert.equal(tiles._stats().entries, fit);
    assert.ok(tiles._stats().bytes <= tiles.CACHE_MAX_BYTES);
    const n = f.mock.callCount();
    await tiles.get({ z: 8, x: 0, y: 0 });
    assert.equal(f.mock.callCount(), n, '0 still cached');
    await tiles.get({ z: 8, x: 1, y: 0 });
    assert.equal(f.mock.callCount(), n + 1, '1 was evicted');
  });
});

describe('GC.tiles in the frame document', () => {
  function gcOf(doc) {
    const start = doc.indexOf('<script>') + '<script>'.length;
    const win = { parent: { postMessage() {} }, addEventListener() {} };
    vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), { window: win, document: { documentElement: { lang: 'de' } }, setTimeout, Object, Error, Promise, String });
    return win.GC;
  }

  it('maps frames get the relay template, other frames null', () => {
    const tpl = tiles.template();
    assert.equal(gcOf(frame.document({ html: '', lang: 'de', maps: true, tiles: tpl })).tiles, tpl);
    assert.equal(gcOf(frame.document({ html: '', lang: 'de', maps: true })).tiles, null);
    assert.equal(gcOf(frame.document({ html: '', lang: 'de', maps: false, tiles: tpl })).tiles, null, 'only maps frames');
    assert.equal(gcOf(frame.document({ html: '', lang: 'de' })).tiles, null);
    for (const bad of ['https://evil.example/{z}/{x}/{y}.png', '/plugins/_shared/tiles/a"</script>/{z}/{x}/{y}.png', '/plugins/_shared/tiles/a/{z}/{x}/{y}.png\n']) {
      assert.equal(gcOf(frame.document({ html: '', lang: 'de', maps: true, tiles: bad })).tiles, null, bad);
    }
  });

  it('the CSP of maps frames allows the relay of this origin, the others do not', () => {
    const o = 'https://gc.example.com';
    assert.ok(frame.cspFor({ maps: true, origin: o }).split('; ').includes(`img-src data: https://tile.openstreetmap.org ${o}/plugins/_shared/leaflet/images/ ${o}/plugins/_shared/tiles/`));
    assert.doesNotMatch(frame.cspFor({ maps: false, origin: o, avatars: true }), /_shared\/tiles/);
    assert.doesNotMatch(frame.cspFor({ maps: true }), /_shared\/tiles/);
  });
});
