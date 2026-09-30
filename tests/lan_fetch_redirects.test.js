'use strict';
// LAN-Integrationen (Pi-hole, deCONZ) folgen Redirects nur innerhalb des
// konfigurierten Origins; Cloud-Metadaten sind als Ziel immer gesperrt.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { lanFetch, isMetadataHost } = require('../src/utils/lanFetch');
const pihole = require('../src/services/piholeClient');
const deconz = require('../src/services/smarthome/deconzClient');

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
    res.end(JSON.stringify({ url: req.url }));
  });
  const res = await lanFetch(`${base}/old`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: '/new' });
});

test('redirect to another origin is rejected and never requested', async () => {
  let internalHits = 0;
  const internal = await listen((req, res) => { internalHits++; res.end('{"secret":1}'); });
  const rogue = await listen((req, res) => { res.writeHead(302, { Location: `${internal}/config/` }); res.end(); });
  await assert.rejects(() => lanFetch(`${rogue}/api/auth`, {}, { label: 'pihole' }),
    (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN' && /^pihole_redirect_blocked/.test(e.message));
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
    req.on('end', () => res.end(JSON.stringify({ method: req.method, body })));
  });
  const res = await lanFetch(`${base}/post`, { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await res.json(), { method: 'GET', body: '' });
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

test('Pi-hole client: cross-origin redirect on auth is an error', async () => {
  let internalHits = 0;
  const internal = await listen((req, res) => { internalHits++; res.end('{"session":{"sid":"X"}}'); });
  const rogue = await listen((req, res) => { res.writeHead(307, { Location: `${internal}/api/auth` }); res.end(); });
  const c = pihole.createClient({ id: 'p', url: rogue, app_password: 'pw' });
  await assert.rejects(() => c.getSummary(), (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN');
  assert.equal(internalHits, 0);
});

test('Pi-hole client: same-origin redirect still works', async () => {
  const seen = [];
  const base = await listen((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/api/padd') { res.writeHead(301, { Location: '/api/padd/' }); res.end(); return; }
    if (req.url === '/api/auth') { res.end(JSON.stringify({ session: { sid: 'S' } })); return; }
    if (req.url === '/api/padd/') {
      assert.equal(req.headers['x-ftl-sid'], 'S');
      res.end(JSON.stringify({ queries: { total: 3, blocked: 1 } })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  const s = await pihole.createClient({ id: 'p', url: base, app_password: 'pw' }).getSummary();
  assert.equal(s.queries.total, 3);
  assert.deepEqual(seen, ['POST /api/auth', 'GET /api/padd', 'GET /api/padd/']);
});

test('deCONZ client: cross-origin redirect is an error', async () => {
  const internal = await listen((req, res) => res.end('{}'));
  const rogue = await listen((req, res) => { res.writeHead(302, { Location: `${internal}/` }); res.end(); });
  await assert.rejects(() => deconz.createClient({ baseUrl: rogue, apiKey: 'K' }).getLights(),
    (e) => e.code === 'LAN_REDIRECT_CROSS_ORIGIN' && /^deconz_redirect_blocked/.test(e.message));
});

test('deCONZ client: normal request ok', async () => {
  const base = await listen((req, res) => res.end(JSON.stringify({ 1: { name: 'L' } })));
  const lights = await deconz.createClient({ baseUrl: base, apiKey: 'K' }).getLights();
  assert.equal(lights['1'].name, 'L');
});
