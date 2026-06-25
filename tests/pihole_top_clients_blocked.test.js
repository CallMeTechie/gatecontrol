'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSync } = require('../src/services/piholeSync');

// fakeClient whose getTopClients branches on the `blocked` argument.
function fakeClient(id, allowed, blocked) {
  return {
    id,
    getSummary: async () => ({ queries:{total:10,blocked:3}, gravity:{domains_being_blocked:5}, clients:{active:1} }),
    getHistory: async () => [],
    getTopDomains: async () => [],
    getTopClients: async (blockedArg = false) => (blockedArg ? blocked : allowed),
    getQueryTypes: async () => ({}),
    getBlocking: async () => ({ blocking: true }),
  };
}

test('syncOnce populates topClientsBlocked, peer-enriched', async () => {
  const c = fakeClient('p1',
    [{ ip:'10.8.0.5', count:9 }],   // allowed
    [{ ip:'10.8.0.5', count:4 }]);  // blocked
  const sync = createSync({
    loadConfig: () => ({ enabled:true, sync_interval_sec:30, manage_dns_chain:false, instances:[{id:'p1'}] }),
    clientFactory: () => c,
    peersProvider: () => [{ id:5, name:'Laptop', ip:'10.8.0.5' }],
    eventBus: { publish(){} },
    dnsChain: { apply(){}, revert(){} },
  });
  const cache = await sync.syncOnce();
  assert.ok(Array.isArray(cache.topClientsBlocked), 'topClientsBlocked must be an array');
  const row = cache.topClientsBlocked.find(r => r.ip === '10.8.0.5');
  assert.ok(row, 'blocked entry for the peer ip missing');
  assert.equal(row.count, 4);
  assert.equal(row.peerId, 5);
  assert.equal(row.peerName, 'Laptop');
  // the allowed (false-call) list must remain intact — guards against removing the existing call
  const allowed = cache.topClients.find(r => r.ip === '10.8.0.5');
  assert.ok(allowed, 'topClients (allowed) must still be populated from getTopClients(false)');
  assert.equal(allowed.count, 9);
});

test('topClientsBlocked defaults to [] before first sync', async () => {
  const sync = createSync({
    loadConfig: () => ({ enabled:false, instances:[] }),
    clientFactory: () => ({}), peersProvider: () => [], eventBus:{publish(){}}, dnsChain:{apply(){},revert(){}},
  });
  assert.deepEqual(sync.getCache().topClientsBlocked, []);
});
