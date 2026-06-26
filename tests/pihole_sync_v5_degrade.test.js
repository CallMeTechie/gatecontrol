'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSync } = require('../src/services/piholeSync');

// Simulates a Pi-hole v5 client: getTopClients(blocked=true) throws (v6-only call),
// while all other methods return minimal valid data.
function fakeV5Client(id) {
  return {
    id,
    getSummary:    async () => ({ queries:{total:5,blocked:1}, gravity:{domains_being_blocked:3}, clients:{active:1} }),
    getHistory:    async () => [],
    getTopDomains: async () => [],
    getTopClients: async (blockedArg = false) => {
      if (blockedArg) throw new Error('v5 API: unknown endpoint');
      return [{ ip: '10.8.0.1', count: 5 }];
    },
    getQueryTypes: async () => ({}),
    getBlocking:   async () => ({ blocking: true }),
  };
}

test('v5 instance: getTopClients(true) rejection degrades topClientsBlocked to [] without marking instance disconnected', async () => {
  const client = fakeV5Client('p1');
  const sync = createSync({
    loadConfig: () => ({ enabled: true, sync_interval_sec: 30, manage_dns_chain: false, instances: [{ id: 'p1' }] }),
    clientFactory: () => client,
    peersProvider: () => [],
    eventBus: { publish() {} },
    dnsChain: { apply() {}, revert() {} },
    loadDesired: () => null,
  });
  const cache = await sync.syncOnce();
  assert.equal(cache.instances[0].connected, true, 'v5 instance must stay connected:true');
  assert.deepEqual(cache.topClientsBlocked, [], 'topClientsBlocked must degrade to [] on v5');
  // Remaining data must still be populated — the instance was not dropped
  assert.equal(cache.summary.queries.total, 5, 'summary must be populated from v5 data');
  assert.ok(Array.isArray(cache.topClients), 'topClients (allowed) must still be populated');
  assert.ok(cache.topClients.length > 0, 'topClients must contain entries from v5');
});

test('v5 instance alongside a failing instance: v5 stays connected, other stays disconnected', async () => {
  const v5 = fakeV5Client('v5');
  const bad = {
    id: 'bad',
    getSummary:    async () => { throw new Error('down'); },
    getHistory:    async () => { throw new Error('down'); },
    getTopDomains: async () => { throw new Error('down'); },
    getTopClients: async () => { throw new Error('down'); },
    getQueryTypes: async () => { throw new Error('down'); },
    getBlocking:   async () => { throw new Error('down'); },
  };
  const sync = createSync({
    loadConfig: () => ({ enabled: true, sync_interval_sec: 30, manage_dns_chain: false, instances: [{ id: 'v5' }, { id: 'bad' }] }),
    clientFactory: (inst) => (inst.id === 'v5' ? v5 : bad),
    peersProvider: () => [],
    eventBus: { publish() {} },
    dnsChain: { apply() {}, revert() {} },
    loadDesired: () => null,
  });
  const cache = await sync.syncOnce();
  assert.equal(cache.instances.find(i => i.id === 'v5').connected, true);
  assert.equal(cache.instances.find(i => i.id === 'bad').connected, false);
  assert.deepEqual(cache.topClientsBlocked, [], 'topClientsBlocked empty since v5 has none');
});
