'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSync } = require('../src/services/piholeSync');

// 15 clients (> default 10). fakeClient records the count it was called with.
function makeClients(n){ return Array.from({length:n}, (_,i)=>({ ip:'10.8.0.'+(i+1), count: n-i })); }
function fakeClient(rec){
  return {
    id:'p1',
    getSummary: async () => ({ queries:{total:100,blocked:10}, gravity:{domains_being_blocked:5}, clients:{active:15} }),
    getHistory: async () => [],
    getTopDomains: async () => [{domain:'a.com',count:5}],
    getTopClients: async (blocked=false, count) => { rec.push({blocked, count}); return makeClients(15); },
    getQueryTypes: async () => ({}),
    getBlocking: async () => ({ blocking:true }),
  };
}

test('syncOnce passes top_clients_count to getTopClients and caches all >10 clients', async () => {
  const rec = [];
  const sync = createSync({
    loadConfig: () => ({ enabled:true, sync_interval_sec:30, top_clients_count:1000, manage_dns_chain:false, instances:[{id:'p1'}] }),
    clientFactory: () => fakeClient(rec),
    peersProvider: () => [{ id:7, name:'Dev7', ip:'10.8.0.7' }],
    eventBus: { publish(){} },
    dnsChain: { apply(){}, revert(){} },
  });
  const cache = await sync.syncOnce();
  // count threaded into BOTH calls (allowed + blocked)
  assert.ok(rec.some(r => r.count === 1000 && r.blocked === false), 'allowed call got count 1000');
  assert.ok(rec.some(r => r.count === 1000 && r.blocked === true), 'blocked call got count 1000');
  // cache holds all 15 (not capped at 10)
  assert.equal(cache.topClients.length, 15);
  // the BLOCKED list cap must be raised too (separate change in Step 3c — easy to miss)
  assert.equal(cache.topClientsBlocked.length, 15, 'topClientsBlocked must also respect count');
  // peer enrichment still works
  assert.equal(cache.topClients.find(c => c.ip === '10.8.0.7').peerId, 7);
  // topDomains cap unchanged (1 here, but the cap stays 10 — assert it is not raised by checking <=10)
  assert.ok(cache.topDomains.length <= 10);
});
