'use strict';

/**
 * Error-path coverage for gateways.notifyConfigChanged and
 * gateways.notifyWol — both push to a remote gateway over HTTP and are
 * documented as best-effort. The happy paths live in
 * gateways_push.test.js + gateways_wol.test.js; this file covers:
 *
 *   - peer not registered as gateway → early-return without HTTP
 *   - request timeout              → resolved silently / null
 *   - upstream non-2xx             → resolved silently / null
 *   - connection refused           → resolved silently / null
 *   - malformed JSON response      → null (notifyWol only)
 *
 * Without these, a misbehaving Gateway can leak unhandled rejections
 * into the server event loop. All scenarios share one DB / one gateway
 * row — only `gateway_meta.api_port` is re-pointed between tests.
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

describe('gateways: push error paths', () => {
  let gateways, peerId;
  let hangServer, hangPort;          // accept + never reply → request timeout
  let badJsonServer, badJsonPort;    // 200 + unparseable body → JSON.parse swallowed
  let errorStatusServer, errorPort;  // 500 + parseable body → resolves silently

  before(async () => {
    hangServer = http.createServer((_req, _res) => { /* never reply */ });
    hangServer.listen(0);
    hangPort = hangServer.address().port;

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

  after(() => {
    try { hangServer && hangServer.close(); } catch {}
    try { badJsonServer && badJsonServer.close(); } catch {}
    try { errorStatusServer && errorStatusServer.close(); } catch {}
  });

  function repointApiPort(port) {
    require('../src/db/connection').getDb()
      .prepare('UPDATE gateway_meta SET api_port=? WHERE peer_id=?').run(port, peerId);
  }

  // ─── notifyConfigChanged ────────────────────────────────────────────
  it('notifyConfigChanged: peer without gateway_meta returns silently and makes no HTTP call', async () => {
    // peerId 99999 has never been registered as a gateway; the function
    // must return before opening any socket.
    const before = Date.now();
    await assert.doesNotReject(() => gateways.notifyConfigChanged(99999));
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 500,
      'no HTTP call should happen for unknown peerId — elapsed ' + elapsed + 'ms');
  });

  it('notifyConfigChanged: request timeout resolves without throwing (best-effort push)', async () => {
    repointApiPort(hangPort);
    const before = Date.now();
    await assert.doesNotReject(() => gateways.notifyConfigChanged(peerId));
    const elapsed = Date.now() - before;
    assert.ok(elapsed >= 1900 && elapsed < 5000,
      'timeout should fire near 2s — elapsed ' + elapsed + 'ms');
  });

  it('notifyConfigChanged: connection refused resolves silently', async () => {
    repointApiPort(await pickFreePort());
    await assert.doesNotReject(() => gateways.notifyConfigChanged(peerId));
  });

  // ─── notifyWol ──────────────────────────────────────────────────────
  it('notifyWol: returns null when peer is not registered as a gateway', async () => {
    const result = await gateways.notifyWol(99999, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    });
    assert.equal(result, null);
  });

  it('notifyWol: returns null when the gateway responds with malformed JSON', async () => {
    repointApiPort(badJsonPort);
    const result = await gateways.notifyWol(peerId, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    });
    assert.equal(result, null,
      'JSON.parse failure on the response body must be swallowed and surface as null');
  });

  it('notifyWol: 5xx with parseable body resolves without throwing', async () => {
    repointApiPort(errorPort);
    await assert.doesNotReject(() => gateways.notifyWol(peerId, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    }));
  });

  it('notifyWol: connection refused returns null', async () => {
    repointApiPort(await pickFreePort());
    const result = await gateways.notifyWol(peerId, {
      mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 1000,
    });
    assert.equal(result, null);
  });
});
