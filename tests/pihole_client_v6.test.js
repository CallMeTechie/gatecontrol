'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('../src/services/piholeClient');

const FX = (state, name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/pihole', state, name + '.json'), 'utf8'));

let server;
afterEach(() => server && new Promise(r => server.close(r)));

// Serve fixtures: /api/auth → session; other paths → matching fixture by routing table.
function serveFixtures(state, routes) {
  return new Promise(res => {
    server = http.createServer((req, res2) => {
      if (req.url === '/api/auth') { res2.end(JSON.stringify({ session: { sid: 'S', valid: true, validity: 300 } })); return; }
      for (const [prefix, name] of routes) {
        if (req.url.startsWith(prefix)) { res2.end(JSON.stringify(FX(state, name))); return; }
      }
      res2.statusCode = 404; res2.end('{}');
    });
    server.listen(0, () => res(`http://127.0.0.1:${server.address().port}`));
  });
}

test('getSummary maps /api/padd → contract (gravity_size, active_clients, queries)', async () => {
  const url = await serveFixtures('populated', [['/api/padd', 'padd']]);
  const c = createClient({ id: 'p', url, app_password: 'x', verify_tls: true });
  const r = await c.getSummary();
  const fx = FX('populated', 'padd');
  assert.equal(r.queries.total, fx.queries.total);
  assert.equal(r.queries.blocked, fx.queries.blocked);
  assert.equal(r.gravity.domains_being_blocked, fx.gravity_size);
  assert.equal(r.clients.active, fx.active_clients);
});

test('getSummary on EMPTY fixture does not throw; maps real values', async () => {
  const url = await serveFixtures('empty', [['/api/padd', 'padd']]);
  const c = createClient({ id: 'p', url, app_password: 'x' });
  const r = await c.getSummary();
  const fx = FX('empty', 'padd');
  assert.equal(r.queries.total, fx.queries.total);
  assert.equal(r.queries.blocked, fx.queries.blocked);
  assert.equal(r.gravity.domains_being_blocked, fx.gravity_size);
  assert.equal(r.clients.active, fx.active_clients);
});

test('getSummary defaults gravity/active to 0 when /api/padd omits them', async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/auth') { res.end(JSON.stringify({ session: { sid: 'S', valid: true, validity: 300 } })); return; }
    if (req.url.startsWith('/api/padd')) { res.end(JSON.stringify({ queries: { total: 0, blocked: 0 } })); return; }
    res.statusCode = 404; res.end('{}');
  });
  const url = await new Promise(r => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));
  const c = createClient({ id: 'p', url, app_password: 'x' });
  const r = await c.getSummary();
  assert.equal(r.gravity.domains_being_blocked, 0);
  assert.equal(r.clients.active, 0);
});

test('getHistory unwraps .history → [{t,allowed,blocked}] with underflow guard', async () => {
  const url = await serveFixtures('populated', [['/api/history', 'history']]);
  const c = createClient({ id: 'p', url, app_password: 'x' });
  const r = await c.getHistory();
  const fx = FX('populated', 'history').history;
  assert.equal(Array.isArray(r), true);
  assert.equal(r.length, fx.length);
  assert.equal(r[0].t, fx[0].timestamp);
  assert.equal(r[0].blocked, fx[0].blocked);
  assert.equal(r[0].allowed, Math.max(0, fx[0].total - fx[0].blocked));
  assert.ok(r.every(p => p.allowed >= 0));
});

test('getTopDomains/getTopClients unwrap envelope arrays; getQueryTypes returns types object', async () => {
  const url = await serveFixtures('populated', [
    ['/api/stats/top_domains', 'top_domains'],
    ['/api/stats/top_clients', 'top_clients'],
    ['/api/stats/query_types', 'query_types'],
  ]);
  const c = createClient({ id: 'p', url, app_password: 'x' });
  const td = await c.getTopDomains(true);
  assert.ok(Array.isArray(td) && (td.length === 0 || ('domain' in td[0] && 'count' in td[0])));
  const tc = await c.getTopClients();
  assert.ok(Array.isArray(tc) && (tc.length === 0 || ('ip' in tc[0] && 'count' in tc[0])));
  const qt = await c.getQueryTypes();
  assert.equal(typeof qt, 'object');
  assert.equal(Array.isArray(qt), false);
  const fxqt = FX('populated', 'query_types').types;
  assert.equal(qt.A, fxqt.A);
});

test('top lists on EMPTY fixture → empty arrays, no throw', async () => {
  const url = await serveFixtures('empty', [['/api/stats/top_domains','top_domains'],['/api/stats/top_clients','top_clients']]);
  const c = createClient({ id: 'p', url, app_password: 'x' });
  assert.deepEqual(await c.getTopDomains(true), []);
  assert.deepEqual(await c.getTopClients(), []);
});
