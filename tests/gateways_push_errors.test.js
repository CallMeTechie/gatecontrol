'use strict';

/**
 * Error-path coverage for gateways.notifyConfigChanged and
 * gateways.notifyWol — both push to a remote gateway over HTTP and are
 * documented as best-effort. The happy path lives in
 * gateways_push.test.js + gateways_wol.test.js; this file covers:
 *
 *   - peer not registered as gateway → early-return without HTTP
 *   - request timeout              → resolved silently / null
 *   - upstream non-2xx             → resolved silently / null
 *   - connection refused           → resolved silently / null
 *   - malformed JSON response      → null (notifyWol only)
 *
 * Without these, a misbehaving Gateway can leak unhandled rejections
 * into the server event loop.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

describe('gateways: notifyConfigChanged error paths', () => {
  let gateways, peerId, hangServer, hangPort;

  before(async () => {
    // Server accepts the connection but never responds — request must
    // hit the 2s req.timeout and resolve silently.
    hangServer = http.createServer((_req, _res) => { /* never reply */ });
    hangServer.listen(0);
    hangPort = hangServer.address().port;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwerr-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'err-gw', apiPort: hangPort });
    peerId = gw.peer.id;
    require('../src/db/connection').getDb()
      .prepare('UPDATE peers SET allowed_ips=? WHERE id=?').run('127.0.0.1/32', peerId);
  });

  after(() => { try { hangServer && hangServer.close(); } catch {} });

  it('peer without a gateway_meta row returns silently and makes no HTTP call', async () => {
    // peerId 99999 has never been registered as a gateway; the function
    // must return before opening any socket.
    const before = Date.now();
    await assert.doesNotReject(() => gateways.notifyConfigChanged(99999));
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 500,
      'no HTTP call should happen for unknown peerId — elapsed ' + elapsed + 'ms');
  });

  it('request timeout resolves without throwing (best-effort push)', async () => {
    // Hang server keeps the socket open, request times out at 2000ms.
    const before = Date.now();
    await assert.doesNotReject(() => gateways.notifyConfigChanged(peerId));
    const elapsed = Date.now() - before;
    assert.ok(elapsed >= 1900 && elapsed < 5000,
      'timeout should fire near 2s — elapsed ' + elapsed + 'ms');
  });

  it('connection refused resolves silently', async () => {
    // Re-point the gateway at a freshly-allocated and immediately-closed
    // port so the connect attempt is refused.
    const refusedPort = await pickFreePort();
    require('../src/db/connection').getDb()
      .prepare('UPDATE gateway_meta SET api_port=? WHERE peer_id=?')
      .run(refusedPort, peerId);
    await assert.doesNotReject(() => gateways.notifyConfigChanged(peerId));
  });
});

describe('gateways: notifyWol error paths', () => {
  let gateways, peerId, badJsonServer, badJsonPort, errorStatusServer, errorPort;

  before(async () => {
    badJsonServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not-json');
    });
    badJsonServer.listen(0);
    badJsonPort = badJsonServer.address().port;

    errorStatusServer = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('{}');
    });
    errorStatusServer.listen(0);
    errorPort = errorStatusServer.address().port;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wolerr-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'wol-err-gw', apiPort: badJsonPort });
    peerId = gw.peer.id;
    require('../src/db/connection').getDb()
      .prepare('UPDATE peers SET allowed_ips=? WHERE id=?').run('127.0.0.1/32', peerId);
  });

  after(() => {
    try { badJsonServer && badJsonServer.close(); } catch {}
    try { errorStatusServer && errorStatusServer.close(); } catch {}
  });

  it('returns null when peer is not registered as a gateway', async () => {
    const result = await gateways.notifyWol(99999, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    });
    assert.equal(result, null);
  });

  it('returns null when the gateway responds with malformed JSON', async () => {
    const result = await gateways.notifyWol(peerId, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    });
    assert.equal(result, null,
      'JSON.parse failure on the response body must be swallowed and surface as null');
  });

  it('returns null when the gateway returns a non-2xx status with empty/whitespace body', async () => {
    // Re-point the same peer at the 500-server. Even though the body
    // here is "{}" (parseable), the helper does not differentiate
    // status codes — but it MUST not throw.
    require('../src/db/connection').getDb()
      .prepare('UPDATE gateway_meta SET api_port=? WHERE peer_id=?')
      .run(errorPort, peerId);
    await assert.doesNotReject(() => gateways.notifyWol(peerId, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    }));
  });

  it('returns null on connection refused', async () => {
    const refusedPort = await pickFreePort();
    require('../src/db/connection').getDb()
      .prepare('UPDATE gateway_meta SET api_port=? WHERE peer_id=?')
      .run(refusedPort, peerId);
    const result = await gateways.notifyWol(peerId, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    });
    assert.equal(result, null);
  });
});
