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
