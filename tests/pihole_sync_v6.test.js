'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createSync } = require('../src/services/piholeSync');
const { createClient } = require('../src/services/piholeClient');

const FX = (state, name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/pihole', state, name + '.json'), 'utf8'));

let server;
afterEach(() => server && new Promise(r => server.close(r)));

// Mock a real Pi-hole v6: /api/auth (POST→session, DELETE→204) + all stat endpoints from fixtures.
// `counters` lets a test observe auth volume. `paddOverride` lets a test inject a broken shape.
function serveV6(state, counters, paddOverride) {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/auth' && req.method === 'POST') {
        if (counters) counters.auth = (counters.auth || 0) + 1;
        res.end(JSON.stringify({ session: { sid: 'S', valid: true, validity: 300 } }));
        return;
      }
      if (req.url === '/api/auth' && req.method === 'DELETE') { res.statusCode = 204; res.end(); return; }
      const routes = [
        ['/api/padd', () => paddOverride ?? FX(state, 'padd')],
        ['/api/history', () => FX(state, 'history')],
        ['/api/stats/top_domains', () => FX(state, 'top_domains')],
        ['/api/stats/top_clients', () => FX(state, 'top_clients')],
        ['/api/stats/query_types', () => FX(state, 'query_types')],
        ['/api/dns/blocking', () => FX(state, 'dns_blocking')],
        ['/api/info/version', () => FX(state, 'version')],
      ];
      for (const [prefix, body] of routes) {
        if (req.url.startsWith(prefix)) { res.end(JSON.stringify(body())); return; }
      }
      res.statusCode = 404; res.end('{}');
    });
    server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function makeSync(url) {
  return createSync({
    loadConfig: () => ({ enabled: true, sync_interval_sec: 30, manage_dns_chain: false,
      instances: [{ id: 'p', url, app_password: 'x', verify_tls: true }] }),
    clientFactory: (inst) => createClient(inst),   // ← the REAL client
    peersProvider: () => [],
    eventBus: { publish() {} },
    dnsChain: { apply() {}, revert() {} },
    loadDesired: () => null,
  });
}

test('syncOnce drives REAL client over POPULATED v6 fixtures → cache populated, no throw', async () => {
  const url = await serveV6('populated');
  const cache = await makeSync(url).syncOnce();
  const padd = FX('populated', 'padd');
  assert.equal(cache.instances[0].connected, true);
  assert.equal(cache.summary.queries.total, padd.queries.total);
  assert.equal(cache.summary.gravity, padd.gravity_size);          // mergeSummary: gravity = max(domains_being_blocked)
  assert.equal(cache.summary.clients.active, padd.active_clients);
  assert.equal(typeof cache.blocking.state, 'string');
  assert.ok(Array.isArray(cache.topClients));
  assert.ok(Array.isArray(cache.topDomains));
});

test('syncOnce drives REAL client over EMPTY v6 fixtures → no throw, zeros', async () => {
  const url = await serveV6('empty');
  const cache = await makeSync(url).syncOnce();
  assert.equal(cache.instances[0].connected, true);
  assert.equal(cache.summary.queries.total, FX('empty', 'padd').queries.total);
  assert.equal(cache.summary.clients.active, FX('empty', 'padd').active_clients);
  assert.ok(Array.isArray(cache.topDomains));
});

// Incident root cause #2: per-cycle re-login filled all 16 FTL seats.
// The cached client must NOT re-authenticate on a subsequent cycle.
test('sync reuses session across cycles — no extra auth on cycle 2', async () => {
  const counters = {};
  const url = await serveV6('populated', counters);
  const sync = makeSync(url);
  await sync.syncOnce();
  const afterFirst = counters.auth;
  assert.ok(afterFirst > 0, 'cycle 1 must authenticate at least once');
  await sync.syncOnce();
  assert.equal(counters.auth - afterFirst, 0, 'cycle 2 must add zero auth calls (session reused)');
});

// Resilience: a broken upstream shape must degrade that instance gracefully, not crash the cycle.
test('shape mismatch → instance connected:false, sync does not throw', async () => {
  const counters = {};
  const url = await serveV6('populated', counters, { unexpected: true }); // padd missing queries.*
  const cache = await makeSync(url).syncOnce();
  assert.equal(cache.instances[0].connected, false);
  assert.match(cache.instances[0].error || '', /unsupported_version/);
});
