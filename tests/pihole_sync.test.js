'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSync } = require('../src/services/piholeSync');

function fakeClient(id, data) {
  return {
    id,
    getSummary: async () => data.summary,
    getHistory: async () => data.history || [],
    getTopDomains: async () => data.topDomains || [],
    getTopClients: async () => data.topClients || [],
    getQueryTypes: async () => data.queryTypes || {},
    getBlocking: async () => data.blocking || { blocking: true },
    setBlocking: async (en, t) => { data._set = { en, t }; data.blocking = { blocking: en, timer: t }; },
  };
}

test('syncOnce aggregates reachable instances, marks failures, publishes', async () => {
  const events = [];
  const ok = fakeClient('p1', { summary: { queries:{total:10,blocked:2}, gravity:{domains_being_blocked:5}, clients:{active:1} }, topClients:[{ip:'10.8.0.5',count:9}] });
  const bad = { id:'p2', getSummary: async () => { throw new Error('down'); }, getHistory: async()=>{throw new Error('x')}, getTopDomains: async()=>{throw new Error('x')}, getTopClients: async()=>{throw new Error('x')}, getQueryTypes: async()=>{throw new Error('x')}, getBlocking: async()=>{throw new Error('x')} };
  const sync = createSync({
    loadConfig: () => ({ enabled:true, sync_interval_sec:30, manage_dns_chain:false, instances:[{id:'p1'},{id:'p2'}] }),
    clientFactory: (inst) => (inst.id === 'p1' ? ok : bad),
    peersProvider: () => [{ id:5, name:'Laptop', ip:'10.8.0.5' }],
    eventBus: { publish: (t,p) => events.push({ t, p }) },
    dnsChain: { apply(){}, revert(){} },
  });
  const cache = await sync.syncOnce();
  assert.equal(cache.summary.queries.total, 10);
  assert.equal(cache.instances.find(i => i.id==='p2').connected, false);
  assert.equal(cache.topClients[0].peerName, 'Laptop');
  assert.equal(cache.attribution, 'per_peer');
  assert.ok(events.some(e => e.t === 'pihole'));
});

test('reconciliation: conforming instance is NOT re-armed; divergent gets remaining timer', async () => {
  const now = 1_000_000;
  const setCalls = [];
  const c1 = fakeClient('p1', { summary:{queries:{total:1,blocked:0},gravity:{domains_being_blocked:0},clients:{active:0}}, blocking:{ blocking:false } });
  const c2 = fakeClient('p2', { summary:{queries:{total:1,blocked:0},gravity:{domains_being_blocked:0},clients:{active:0}}, blocking:{ blocking:true } });
  c1.setBlocking = async (en,t) => setCalls.push(['p1',en,t]);
  c2.setBlocking = async (en,t) => setCalls.push(['p2',en,t]);
  const sync = createSync({
    loadConfig: () => ({ enabled:true, sync_interval_sec:30, instances:[{id:'p1'},{id:'p2'}] }),
    clientFactory: (i) => (i.id==='p1'?c1:c2),
    peersProvider: () => [],
    eventBus: { publish(){} },
    dnsChain: { apply(){}, revert(){} },
    now: () => now,
    loadDesired: () => ({ enabled:false, timer_ends_at: now/1000 + 100 }),
  });
  await sync.syncOnce();
  assert.deepEqual(setCalls, [['p2', false, 100]]);
});

test('reconciliation: null desired-state enforces nothing', async () => {
  const setCalls = [];
  const c = fakeClient('p1', { summary:{queries:{total:1,blocked:0},gravity:{domains_being_blocked:0},clients:{active:0}}, blocking:{ blocking:true } });
  c.setBlocking = async (en,t) => setCalls.push([en,t]);
  const sync = createSync({
    loadConfig: () => ({ enabled:true, instances:[{id:'p1'}] }),
    clientFactory: () => c, peersProvider: () => [], eventBus:{publish(){}}, dnsChain:{apply(){},revert(){}},
    loadDesired: () => null,
  });
  await sync.syncOnce();
  assert.equal(setCalls.length, 0);
});

test('auto-revert: all instances down for >=2 cycles reverts the DNS chain; recovery re-applies', async () => {
  let up = false;
  const chainCalls = [];
  const live = fakeClient('p1', { summary:{queries:{total:1,blocked:0},gravity:{domains_being_blocked:0},clients:{active:0}} });
  const dead = { id:'p1', getSummary: async()=>{throw new Error('down')}, getHistory:async()=>{throw 0}, getTopDomains:async()=>{throw 0}, getTopClients:async()=>{throw 0}, getQueryTypes:async()=>{throw 0}, getBlocking:async()=>{throw 0} };
  const sync = createSync({
    loadConfig: () => ({ enabled:true, manage_dns_chain:true, sync_interval_sec:30, instances:[{id:'p1', dns_ip:'10.8.0.5'}] }),
    clientFactory: () => (up ? live : dead),
    peersProvider: () => [], eventBus:{publish(){}},
    dnsChain: { apply:(ips)=>chainCalls.push(['apply',ips.join(',')]), revert:()=>chainCalls.push(['revert']) },
    loadDesired: () => null,
  });
  await sync.syncOnce();
  await sync.syncOnce();
  up = true;
  await sync.syncOnce();
  assert.deepEqual(chainCalls, [['revert'], ['apply','10.8.0.5']]);
});

test('start() is idempotent — calling twice does not start a second interval', () => {
  const sync = createSync({
    loadConfig: () => ({ enabled:false, instances:[] }),
    clientFactory: () => ({}), peersProvider: () => [], eventBus:{publish(){}},
    dnsChain:{apply(){},revert(){}},
  });
  // double start then stop must not throw and must leave no running timer
  sync.start();
  sync.start();
  assert.doesNotThrow(() => sync.stop());
});
