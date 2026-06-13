'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const agg = require('../src/services/piholeAggregate');

test('mergeSummary sums queries and recomputes percent', () => {
  const r = agg.mergeSummary([
    { queries: { total: 100, blocked: 20 }, gravity: { domains_being_blocked: 1000 }, clients: { active: 3 } },
    { queries: { total: 300, blocked: 80 }, gravity: { domains_being_blocked: 1000 }, clients: { active: 4 } },
  ]);
  assert.equal(r.queries.total, 400);
  assert.equal(r.queries.blocked, 100);
  assert.equal(r.queries.percent, 25);
  assert.equal(r.gravity, 1000);
});

test('mergeTopList groups by key and sums counts', () => {
  const r = agg.mergeTopList([
    [{ domain: 'a.com', count: 5 }, { domain: 'b.com', count: 3 }],
    [{ domain: 'a.com', count: 2 }],
  ], 'domain', 2);
  assert.deepEqual(r, [{ domain: 'a.com', count: 7 }, { domain: 'b.com', count: 3 }]);
});

test('mergeHistory aligns buckets to a common grid (rounds to bucketSec, fills gaps)', () => {
  const r = agg.mergeHistory([
    [{ t: 1000, allowed: 10, blocked: 2 }],
    [{ t: 1005, allowed: 4, blocked: 1 }],
  ], 60);
  assert.equal(r.length, 1);
  assert.equal(r[0].allowed, 14);
  assert.equal(r[0].blocked, 3);
});

test('mergeBlocking is partial when instances disagree', () => {
  assert.equal(agg.mergeBlocking([{ blocking: true }, { blocking: true }]).state, 'enabled');
  assert.equal(agg.mergeBlocking([{ blocking: false }, { blocking: false }]).state, 'disabled');
  assert.equal(agg.mergeBlocking([{ blocking: true }, { blocking: false }]).state, 'partial');
});

test('mapClientsToPeers resolves WG IPs to peer names, leaves others null', () => {
  const peersByIp = { '10.8.0.5': { id: 5, name: 'Laptop' } };
  const r = agg.mapClientsToPeers([{ ip: '10.8.0.5', count: 9 }, { ip: '172.17.0.1', count: 3 }], peersByIp);
  assert.deepEqual(r[0], { ip: '10.8.0.5', count: 9, peerId: 5, peerName: 'Laptop' });
  assert.deepEqual(r[1], { ip: '172.17.0.1', count: 3, peerId: null, peerName: null });
});

test('detectAttribution = per_peer when any top-client IP is a peer WG IP', () => {
  assert.equal(agg.detectAttribution(['10.8.0.5', '1.2.3.4'], ['10.8.0.5']), 'per_peer');
  assert.equal(agg.detectAttribution(['172.17.0.1'], ['10.8.0.5']), 'collapsed');
  assert.equal(agg.detectAttribution([], ['10.8.0.5']), 'collapsed');
});
