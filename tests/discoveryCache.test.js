'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../src/services/discoveryCache');

test('sanitizeDevices drops malformed, clamps, lowercases mac', () => {
  const out = cache.sanitizeDevices([
    { ip: '192.168.1.5', hostname: 'nas', mac: 'AA:BB:CC:DD:EE:FF', ports: [{ port: 80, source: 'tcp' }] },
    { ip: 'not-an-ip', ports: [] },
    { ip: '192.168.1.6', ports: [{ port: 70000, source: 'x' }, { port: 22, source: 'tcp' }] },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].mac, 'aa:bb:cc:dd:ee:ff');
  assert.deepEqual(out[1].ports.map(p => p.port), [22]); // 70000 dropped
});

test('ingest: matching request_id merges; non-matching dropped while in-flight; adopt when none', () => {
  cache._reset();
  cache.begin(7, 'r1');
  assert.equal(cache.inFlight(7), true);
  assert.deepEqual(cache.ingest(7, 'r1', [{ ip: '192.168.1.5', ports: [{ port: 80, source: 'tcp' }] }], false).accepted, true);
  assert.equal(cache.ingest(7, 'rX', [{ ip: '192.168.1.9', ports: [] }], false).reason, 'stale_request'); // non-matching dropped
  let snap = cache.get(7);
  assert.equal(snap.devices.length, 1);
  assert.equal(snap.in_flight, true);
  // terminal done clears in-flight
  cache.ingest(7, 'r1', [{ ip: '192.168.1.5', ports: [{ port: 443, source: 'tcp' }] }], true);
  snap = cache.get(7);
  assert.equal(snap.in_flight, false);
  assert.deepEqual(snap.devices[0].ports.map(p => p.port).sort((a, b) => a - b), [80, 443]); // merged
});

test('ingest adopts a late batch when no current (restart-safe)', () => {
  cache._reset();
  const r = cache.ingest(9, 'orphan', [{ ip: '10.0.0.2', ports: [] }], true); // no begin() first
  assert.equal(r.accepted, true);
  assert.equal(cache.get(9).devices.length, 1);
});

test('cancel clears; get returns null after', () => {
  cache._reset();
  cache.begin(3, 'r1');
  cache.cancel(3);
  assert.equal(cache.get(3), null);
  assert.equal(cache.inFlight(3), false);
});

test('get() lazily marks a scan timed_out after its grace window', async () => {
  cache._reset();
  cache.begin(11, 'r', 20); // 20ms grace
  await new Promise(r => setTimeout(r, 40));
  const snap = cache.get(11);
  assert.equal(snap.done, true);
  assert.equal(snap.timed_out, true);
  assert.equal(cache.inFlight(11), false);
});

test('ingest adopts a new requestId once the prior scan grace has expired (timed-out orphan)', async () => {
  cache._reset();
  cache.begin(13, 'oldreq', 20); // 20ms grace
  await new Promise(r => setTimeout(r, 40));
  // get() has NOT been called → e.done is still false even though grace expired
  const r = cache.ingest(13, 'newreq', [{ ip: '192.168.1.7', ports: [] }], false);
  assert.equal(r.accepted, true, 'a new requestId should be adopted after the orphan grace expires');
  const snap = cache.get(13);
  assert.equal(snap.request_id, 'newreq');
  assert.equal(snap.devices.length, 1);
});
