'use strict';

// Idle keep-alive connections: the Node app closes them later than its
// clients (services/caddyAppUpstream.js, APP_KEEP_ALIVE_MS). With Node's
// default (5 s + 1 s) a request sent in the moment the server closes the idle
// connection ended in ECONNRESET / "socket hang up" — in the browser tests
// (Playwright's page.request keeps connections without a limit) and behind
// Caddy (idle connections to the upstream for 2 minutes; a POST is not
// retried → 502).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { APP_KEEP_ALIVE_MS, CADDY_UPSTREAM_IDLE_MS } = require('../src/services/caddyAppUpstream');

test('the app keeps idle connections open longer than Caddy does', () => {
  assert.ok(APP_KEEP_ALIVE_MS > CADDY_UPSTREAM_IDLE_MS, `${APP_KEEP_ALIVE_MS} > ${CADDY_UPSTREAM_IDLE_MS}`);
  assert.equal(CADDY_UPSTREAM_IDLE_MS, 120 * 1000, "Caddy's default keep_alive idle_timeout (2m)");
  const src = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(src, /server\.keepAliveTimeout = require\('\.\/services\/caddyAppUpstream'\)\.APP_KEEP_ALIVE_MS;/);
});

test('an idle connection survives the old 6 s and a short headersTimeout: the next request reuses it', async () => {
  // headersTimeout far below the idle time: it must not end an idle connection
  const srv = http.createServer({ headersTimeout: 1000, requestTimeout: 2000, connectionsCheckingInterval: 200 }, (req, res) => {
    req.resume();
    req.on('end', () => res.end(JSON.stringify({ ok: true })));
  });
  srv.keepAliveTimeout = APP_KEEP_ALIVE_MS;
  let connections = 0;
  srv.on('connection', () => { connections++; });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  // like Playwright's request context: keep-alive, no idle limit of its own
  const agent = new http.Agent({ keepAlive: true });
  const send = (method) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/', method, agent }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, keepAlive: res.headers['keep-alive'], body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
  try {
    const first = await send('GET');
    assert.equal(first.status, 200);
    assert.equal(first.keepAlive, `timeout=${APP_KEEP_ALIVE_MS / 1000}`);
    await new Promise((r) => setTimeout(r, 6500));
    const second = await send('POST');
    assert.equal(second.status, 200);
    assert.equal(connections, 1, 'the idle connection was still open and reused');
  } finally {
    agent.destroy();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});
