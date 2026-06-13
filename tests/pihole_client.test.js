'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createClient } = require('../src/services/piholeClient');

let server, calls, sidIssued;
function start(handler) {
  return new Promise(res => { server = http.createServer(handler); server.listen(0, () => res()); });
}
function baseUrl() { return `http://127.0.0.1:${server.address().port}`; }
beforeEach(() => { calls = []; sidIssued = 0; });
afterEach(() => new Promise(r => server.close(r)));

test('authenticates once and reuses SID across calls', async () => {
  await start(async (req, res) => {
    calls.push(req.url);
    if (req.url === '/api/auth') { sidIssued++; res.end(JSON.stringify({ session:{ sid:'SID1', csrf:'c', validity:300, valid:true } })); return; }
    if (req.url.startsWith('/api/stats/summary')) {
      assert.equal(req.headers['x-ftl-sid'], 'SID1');
      res.end(JSON.stringify({ queries:{ total:10, blocked:2 }, gravity:{ domains_being_blocked:5 }, clients:{ active:1 } })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  const c = createClient({ id:'p1', url: baseUrl(), app_password:'pw', verify_tls:true });
  await c.getSummary();
  await c.getSummary();
  assert.equal(sidIssued, 1, 'should authenticate only once');
});

test('re-authenticates once on 401 then succeeds', async () => {
  let summaryHits = 0;
  await start(async (req, res) => {
    if (req.url === '/api/auth') { sidIssued++; res.end(JSON.stringify({ session:{ sid:`SID${sidIssued}`, validity:300, valid:true } })); return; }
    if (req.url.startsWith('/api/stats/summary')) {
      summaryHits++;
      if (summaryHits === 1) { res.statusCode = 401; res.end('{}'); return; }
      res.end(JSON.stringify({ queries:{ total:1, blocked:0 }, gravity:{ domains_being_blocked:0 }, clients:{ active:0 } })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  const c = createClient({ id:'p1', url: baseUrl(), app_password:'pw' });
  const r = await c.getSummary();
  assert.equal(r.queries.total, 1);
  assert.equal(sidIssued, 2, 'should re-auth exactly once');
});

test('flags unsupported_version when summary schema is wrong', async () => {
  await start(async (req, res) => {
    if (req.url === '/api/auth') { res.end(JSON.stringify({ session:{ sid:'S', validity:300, valid:true } })); return; }
    if (req.url.startsWith('/api/stats/summary')) { res.end(JSON.stringify({ unexpected:true })); return; }
    res.statusCode = 404; res.end('{}');
  });
  const c = createClient({ id:'p1', url: baseUrl(), app_password:'pw' });
  await assert.rejects(() => c.getSummary(), /unsupported_version/);
});
