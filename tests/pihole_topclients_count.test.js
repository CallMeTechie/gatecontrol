'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createClient } = require('../src/services/piholeClient');

let server, lastTopClientsUrl;
function start(handler){ return new Promise(r=>{ server=http.createServer(handler); server.listen(0,()=>r()); }); }
function baseUrl(){ return `http://127.0.0.1:${server.address().port}`; }
beforeEach(()=>{ lastTopClientsUrl=null; });
afterEach(()=> new Promise(r=>server.close(r)));

async function handler(req,res){
  if (req.url==='/api/auth'){ res.end(JSON.stringify({ session:{ sid:'S', csrf:'c', validity:300, valid:true } })); return; }
  if (req.url.startsWith('/api/stats/top_clients')){ lastTopClientsUrl=req.url; res.end(JSON.stringify({ clients:[{ip:'10.0.0.1',count:1}] })); return; }
  res.statusCode=404; res.end('{}');
}

test('getTopClients(false, 500) appends count=500', async () => {
  await start(handler);
  const c = createClient({ id:'p1', url: baseUrl(), app_password:'pw' });
  await c.getTopClients(false, 500);
  assert.equal(lastTopClientsUrl, '/api/stats/top_clients?count=500');
});
test('getTopClients(true, 500) → blocked=true&count=500', async () => {
  await start(handler);
  const c = createClient({ id:'p1', url: baseUrl(), app_password:'pw' });
  await c.getTopClients(true, 500);
  assert.equal(lastTopClientsUrl, '/api/stats/top_clients?blocked=true&count=500');
});
test('getTopClients() without count is unchanged (back-compat)', async () => {
  await start(handler);
  const c = createClient({ id:'p1', url: baseUrl(), app_password:'pw' });
  await c.getTopClients();
  assert.equal(lastTopClientsUrl, '/api/stats/top_clients');
});
