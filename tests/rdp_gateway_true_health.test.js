'use strict';
const crypto = require('node:crypto');
// Must be set before any module that touches encryption (createGateway calls encrypt())
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, teardown } = require('./helpers/setup');
const gateways = require('../src/services/gateways');

let ctx;
test.before(async () => {
  ctx = await setup();
  require('../src/services/license')._overrideForTest({ gateway_peers: -1 });
});
test.after(() => teardown());

test('probeGatewayTarget returns probed_target + probe_result from gateway', async () => {
  // fake companion echoes probed_target and derives probe_result from requested port
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      got = { path: req.url, token: req.headers['x-gateway-token'], body };
      res.end(JSON.stringify({
        probed_target: { host: body.host, port: body.port },
        probe_result: body.port === 3389,
      }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;

  // create a gateway peer, then point its gateway_meta at the fake server
  const gw = await gateways.createGateway({ name: 'gw-probe', apiPort: port });
  const db = require('../src/db/connection').getDb();
  db.prepare(`UPDATE peers SET allowed_ips='127.0.0.1/32' WHERE id=?`).run(gw.peer.id);
  const peerId = gw.peer.id;

  const r = await gateways.probeGatewayTarget(peerId, '192.168.2.144', 3389);
  assert.equal(got.path, '/api/probe');
  assert.equal(typeof got.token, 'string');
  assert.deepEqual(got.body, { host: '192.168.2.144', port: 3389 });
  assert.deepEqual(r.probed_target, { host: '192.168.2.144', port: 3389 });
  assert.equal(r.probe_result, true);

  // a different port -> probe_result false
  const r2 = await gateways.probeGatewayTarget(peerId, '192.168.2.144', 13389);
  assert.deepEqual(r2.probed_target, { host: '192.168.2.144', port: 13389 });
  assert.equal(r2.probe_result, false);

  srv.close();
});

test('probeGatewayTarget returns null for an unknown peerId', async () => {
  const r = await gateways.probeGatewayTarget(999999, '192.168.2.144', 3389);
  assert.equal(r, null);
});

// --- Task 3: rdpMonitor uses the gateway probe for direct-peer gateway routes ---
const net = require('node:net');
const rdpMonitor = require('../src/services/rdpMonitor');

function getDb() { return require('../src/db/connection').getDb(); }

// Start a fake companion HTTP server. `handler(body)` returns the JSON body the
// companion responds with (or undefined to use `respond`).
async function startCompanion(handler) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const out = handler(body, req);
      res.end(JSON.stringify(out || {}));
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  return { srv, port: srv.address().port };
}

// Create a LIVE gateway peer whose API points at `apiPort`.
async function makeLiveGateway(name, apiPort) {
  const gw = await gateways.createGateway({ name, apiPort });
  const db = getDb();
  db.prepare(`UPDATE peers SET allowed_ips='127.0.0.1/32' WHERE id=?`).run(gw.peer.id);
  db.prepare(`UPDATE gateway_meta SET last_seen_at=? WHERE peer_id=?`).run(Date.now(), gw.peer.id);
  return gw.peer.id;
}

// Start a plain TCP listener on 127.0.0.1 and return its port (the loopback L4
// listener the OLD probe path would have hit).
async function startLoopbackListener() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  return { srv, port: srv.address().port };
}

function insertGatewayRoute({ name, host, port, peerId, listenPort, enabled = 1, hce = 1 }) {
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO rdp_routes (name, host, port, access_mode, gateway_peer_id, gateway_listen_port, enabled, health_check_enabled, credential_mode)
     VALUES (?, ?, ?, 'gateway', ?, ?, ?, ?, 'none')`
  ).run(name, host, port, peerId, listenPort, enabled, hce);
  return info.lastInsertRowid;
}

test('gateway route with LIVE gateway but DOWN host reports offline (no false-positive)', async () => {
  const c = await startCompanion((body) => ({
    probed_target: { host: body.host, port: body.port },
    probe_result: false,
    probe_latency_ms: 5,
  }));
  const peerId = await makeLiveGateway('gw-t3-down', c.port);
  // A real loopback listener on the listen port → the OLD code would say online.
  const loop = await startLoopbackListener();
  const routeId = insertGatewayRoute({
    name: 'rdp-t3-down', host: '192.168.2.144', port: 3389, peerId, listenPort: loop.port,
  });

  const r = await rdpMonitor.checkRouteById(routeId);
  assert.equal(r.online, false, 'live gateway + dead host must report offline');

  loop.srv.close();
  c.srv.close();
});

test('old companion (no probed_target) falls back to legacy loopback probe', async () => {
  // Legacy response: NO probed_target field.
  const c = await startCompanion(() => ({ probe_result: true }));
  const peerId = await makeLiveGateway('gw-t3-legacy', c.port);
  const loop = await startLoopbackListener();
  const routeId = insertGatewayRoute({
    name: 'rdp-t3-legacy', host: '192.168.2.144', port: 3389, peerId, listenPort: loop.port,
  });

  const r = await rdpMonitor.checkRouteById(routeId);
  assert.equal(r.online, true, 'missing probed_target → fall back to loopback checkTcp (listener up → online)');

  loop.srv.close();
  c.srv.close();
});

test('gateway route with empty host reports offline (no loopback fallback)', async () => {
  let called = false;
  const c = await startCompanion(() => { called = true; return { probed_target: { host: '', port: 0 }, probe_result: true }; });
  const peerId = await makeLiveGateway('gw-t3-empty', c.port);
  // Loopback listener is up so a fallback WOULD return online — must not happen.
  const loop = await startLoopbackListener();
  const routeId = insertGatewayRoute({
    name: 'rdp-t3-empty', host: '', port: 3389, peerId, listenPort: loop.port,
  });

  const r = await rdpMonitor.checkRouteById(routeId);
  assert.equal(r.online, false, 'empty host → offline, not loopback fallback');
  assert.equal(called, false, 'gateway must NOT be probed for a host-less route');

  loop.srv.close();
  c.srv.close();
});

test('checkAll skips re-entry while a cycle is still running', async () => {
  const db = getDb();
  db.prepare('DELETE FROM rdp_routes').run();

  const c = await startCompanion((body) => new Promise(() => {})); // never used directly
  // slow companion: respond after ~200ms
  c.srv.removeAllListeners('request');
  c.srv.on('request', (req, res) => {
    let b = ''; req.on('data', x => b += x);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      setTimeout(() => res.end(JSON.stringify({ probed_target: { host: body.host, port: body.port }, probe_result: true, probe_latency_ms: 200 })), 200);
    });
  });
  const peerId = await makeLiveGateway('gw-t3-reentry', c.port);
  insertGatewayRoute({ name: 'rdp-t3-reentry', host: '192.168.2.144', port: 3389, peerId, listenPort: 0 });

  const p1 = rdpMonitor.checkAll();          // do not await — keeps the cycle in flight
  const r2 = await rdpMonitor.checkAll();    // should be skipped by the re-entry guard
  assert.deepEqual(r2, [], 're-entry while running must return []');

  const r1 = await p1;
  assert.ok(r1.length >= 1, 'first cycle must produce results');

  c.srv.close();
});

test('checkAll runs route probes in parallel (one slow gateway does not stall others)', async () => {
  const db = getDb();
  db.prepare('DELETE FROM rdp_routes').run();

  // Slow gateway (~200ms)
  const slow = await startCompanion(() => {});
  slow.srv.removeAllListeners('request');
  slow.srv.on('request', (req, res) => {
    let b = ''; req.on('data', x => b += x);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      setTimeout(() => res.end(JSON.stringify({ probed_target: { host: body.host, port: body.port }, probe_result: true, probe_latency_ms: 200 })), 200);
    });
  });
  const slowPeer = await makeLiveGateway('gw-t3-par-slow', slow.port);
  insertGatewayRoute({ name: 'rdp-t3-par-slow', host: '192.168.2.10', port: 3389, peerId: slowPeer, listenPort: 0 });

  // Fast gateway (immediate)
  const fast = await startCompanion((body) => ({ probed_target: { host: body.host, port: body.port }, probe_result: true, probe_latency_ms: 1 }));
  const fastPeer = await makeLiveGateway('gw-t3-par-fast', fast.port);
  insertGatewayRoute({ name: 'rdp-t3-par-fast', host: '192.168.2.11', port: 3389, peerId: fastPeer, listenPort: 0 });

  const start = Date.now();
  const results = await rdpMonitor.checkAll();
  const elapsed = Date.now() - start;

  assert.equal(results.length, 2, 'both routes checked');
  assert.ok(elapsed < 350, `parallel probes should finish in ~max latency, got ${elapsed}ms`);

  slow.srv.close();
  fast.srv.close();
});
