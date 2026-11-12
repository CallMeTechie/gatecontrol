'use strict';
// LAN-Integrationen folgen Redirects nur innerhalb des
// konfigurierten Origins; Cloud-Metadaten sind als Ziel immer gesperrt.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { lanFetch, isMetadataHost } = require('../src/utils/lanFetch');

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
});

test('normal request passes through (loopback target allowed)', async () => {
  const base = await listen((req, res) => res.end('{"ok":true}'));
  const res = await lanFetch(`${base}/x`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('same-origin redirect is followed', async () => {
  const base = await listen((req, res) => {
    if (req.url === '/old') { res.writeHead(302, { Location: '/new' }); res.end(); return; }
    // Nur feste Werte zurückgeben, nichts aus der Anfrage spiegeln.
    res.end(JSON.stringify({ reachedNew: req.url === '/new' }));
  });
  const res = await lanFetch(`${base}/old`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { reachedNew: true });
});

test('redirect to another origin is rejected and never requested', async () => {
  let internalHits = 0;
  const internal = await listen((req, res) => { internalHits++; res.end('{"secret":1}'); });
  const rogue = await listen((req, res) => { res.writeHead(302, { Location: `${internal}/config/` }); res.end(); });
  await assert.rejects(() => lanFetch(`${rogue}/api/auth`, {}, { label: 'nas' }),
    (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN' && /^nas_redirect_blocked/.test(e.message));
  assert.equal(internalHits, 0);
});

test('redirect to metadata address is rejected', async () => {
  const rogue = await listen((req, res) => { res.writeHead(307, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); });
  await assert.rejects(() => lanFetch(`${rogue}/`), (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN');
});

test('same-origin redirect loop stops at the limit', async () => {
  let hits = 0;
  const base = await listen((req, res) => { hits++; res.writeHead(302, { Location: '/again' }); res.end(); });
  await assert.rejects(() => lanFetch(`${base}/`, {}, { maxRedirects: 2 }), (e) => e.code === 'LAN_TOO_MANY_REDIRECTS');
  assert.equal(hits, 3);
});

test('303 after POST continues as GET without body', async () => {
  const base = await listen((req, res) => {
    if (req.url === '/post') { res.writeHead(303, { Location: '/done' }); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => res.end(JSON.stringify({ isGet: req.method === 'GET', bodyEmpty: body.length === 0 })));
  });
  const res = await lanFetch(`${base}/post`, { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await res.json(), { isGet: true, bodyEmpty: true });
});

test('metadata addresses are forbidden as configured target', async () => {
  for (const u of ['http://169.254.169.254/', 'http://100.100.100.200/', 'http://[fd00:ec2::254]/', 'http://[::ffff:169.254.169.254]/']) {
    await assert.rejects(() => lanFetch(u), (e) => e.code === 'LAN_TARGET_FORBIDDEN', u);
  }
  assert.equal(isMetadataHost('192.168.1.2'), false);
  assert.equal(isMetadataHost('127.0.0.1'), false);
});

test('non-http protocols are rejected', async () => {
  await assert.rejects(() => lanFetch('file:///etc/passwd'), (e) => e.code === 'LAN_INVALID_PROTOCOL');
});

// ─── Schema-Upgrade http → https (Weboberflächen, Reverse-Proxies) ────────
// https auf :443 lässt sich im Test nicht binden → fetch wird gemockt.
function mockFetchSequence(routes) {
  const orig = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push(url);
    assert.equal(opts.redirect, 'manual');
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return {
      status: r.status, ok: r.status >= 200 && r.status < 300,
      headers: new Headers(r.location ? { location: r.location } : {}),
      body: null, async json() { return r.body; },
    };
  };
  return { seen, restore: () => { global.fetch = orig; } };
}

test('http → https upgrade on the same host (default ports) is allowed', async () => {
  const m = mockFetchSequence({
    'http://pi.hole/api/auth': { status: 308, location: 'https://pi.hole/api/auth' },
    'https://pi.hole/api/auth': { status: 200, body: { ok: 1 } },
  });
  try {
    const res = await lanFetch('http://pi.hole/api/auth', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.deepEqual(m.seen, ['http://pi.hole/api/auth', 'https://pi.hole/api/auth']);
  } finally { m.restore(); }
});

test('upgrade with explicit :80 → :443 is allowed, then same-origin hops continue', async () => {
  const m = mockFetchSequence({
    'http://pi.hole:80/admin': { status: 301, location: 'https://pi.hole:443/admin' },
    'https://pi.hole/admin': { status: 302, location: '/admin/' },
    'https://pi.hole/admin/': { status: 200, body: {} },
  });
  try {
    const res = await lanFetch('http://pi.hole:80/admin');
    assert.equal(res.status, 200);
  } finally { m.restore(); }
});

test('https → http downgrade is blocked', async () => {
  const m = mockFetchSequence({ 'https://pi.hole/api': { status: 302, location: 'http://pi.hole/api' } });
  try {
    await assert.rejects(() => lanFetch('https://pi.hole/api'), (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN');
    assert.equal(m.seen.length, 1);
  } finally { m.restore(); }
});

test('upgrade followed by a downgrade back to http is blocked', async () => {
  const m = mockFetchSequence({
    'http://pi.hole/x': { status: 301, location: 'https://pi.hole/x' },
    'https://pi.hole/x': { status: 302, location: 'http://pi.hole/y' },
  });
  try {
    await assert.rejects(() => lanFetch('http://pi.hole/x'), (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN');
  } finally { m.restore(); }
});

test('upgrade to another host or a non-default port is blocked', async () => {
  for (const [from, to] of [
    ['http://pi.hole/', 'https://evil.example/'],
    ['http://pi.hole/', 'https://127.0.0.1/'],
    ['http://pi.hole/', 'https://pi.hole:2019/'],
    ['http://pi.hole:8080/', 'https://pi.hole/'],
    ['http://pi.hole/', 'http://pi.hole:2019/'],
  ]) {
    const m = mockFetchSequence({ [from]: { status: 302, location: to } });
    try {
      await assert.rejects(() => lanFetch(from), (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN', `${from} → ${to}`);
      assert.equal(m.seen.length, 1);
    } finally { m.restore(); }
  }
});
