'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { tcpProbe, runProbeCycle } = require('../src/services/gatewayProbe');

describe('tcpProbe', () => {
  let acceptor;
  let listenPort;

  before(async () => {
    // Spin up a minimal TCP acceptor that just accepts + closes.
    acceptor = net.createServer((sock) => sock.end());
    await new Promise((resolve) => acceptor.listen(0, '127.0.0.1', resolve));
    listenPort = acceptor.address().port;
  });

  after(() => acceptor.close());

  test('returns true when port accepts the connection', async () => {
    const ok = await tcpProbe('127.0.0.1', listenPort, 500);
    assert.equal(ok, true);
  });

  test('returns false when nothing listens on the port', async () => {
    // A free ephemeral port almost certainly not in use
    const ok = await tcpProbe('127.0.0.1', 1, 300);
    assert.equal(ok, false);
  });

  test('returns false on timeout (host unreachable, not routed)', async () => {
    // 203.0.113.0/24 is TEST-NET-3, never routable on the internet
    const ok = await tcpProbe('203.0.113.1', 1, 200);
    assert.equal(ok, false);
  });
});

describe('runProbeCycle', () => {
  function fakeLogger() {
    const calls = [];
    return {
      warn: (...a) => calls.push(['warn', ...a]),
      error: (...a) => calls.push(['error', ...a]),
      info: () => {},
      debug: () => {},
      calls,
    };
  }

  test('skips gateways with a fresh last_seen_at', async () => {
    const probes = [];
    const records = [];
    const NOW = 1_000_000;
    const fresh = { peer_id: 1, ip: '10.0.0.1', api_port: 9876, last_seen_at: NOW - 5000 };
    const stale = { peer_id: 2, ip: '10.0.0.2', api_port: 9876, last_seen_at: NOW - 120_000 };
    const result = await runProbeCycle({
      listGateways: () => [fresh, stale],
      recordProbeResult: (id, ok) => records.push([id, ok]),
      probe: async (h, p) => { probes.push([h, p]); return true; },
      now: () => NOW,
      heartbeatGraceMs: 60_000,
      logger: fakeLogger(),
    });
    assert.equal(result.probed, 1);
    assert.deepEqual(probes, [['10.0.0.2', 9876]], 'only stale peer must be probed');
    assert.deepEqual(records, [[2, true]]);
  });

  test('records both alive and dead outcomes from parallel probes', async () => {
    const records = [];
    const gws = [
      { peer_id: 1, ip: '10.0.0.1', api_port: 9876, last_seen_at: 0 },
      { peer_id: 2, ip: '10.0.0.2', api_port: 9876, last_seen_at: 0 },
      { peer_id: 3, ip: '10.0.0.3', api_port: 9876, last_seen_at: 0 },
    ];
    const probeMap = { '10.0.0.1': true, '10.0.0.2': false, '10.0.0.3': true };
    const result = await runProbeCycle({
      listGateways: () => gws,
      recordProbeResult: (id, ok) => records.push([id, ok]),
      probe: async (h) => probeMap[h],
      now: () => 999_999_999,
      heartbeatGraceMs: 60_000,
    });
    assert.equal(result.probed, 3);
    assert.equal(result.alive, 2);
    assert.equal(result.dead, 1);
    records.sort((a, b) => a[0] - b[0]);
    assert.deepEqual(records, [[1, true], [2, false], [3, true]]);
  });

  test('skips gateways without ip or api_port (malformed row)', async () => {
    const records = [];
    const gws = [
      { peer_id: 1, ip: '', api_port: 9876, last_seen_at: 0 },
      { peer_id: 2, ip: '10.0.0.2', api_port: null, last_seen_at: 0 },
      { peer_id: 3, ip: '10.0.0.3', api_port: 9876, last_seen_at: 0 },
    ];
    await runProbeCycle({
      listGateways: () => gws,
      recordProbeResult: (id, ok) => records.push([id, ok]),
      probe: async () => true,
      now: () => 999_999_999,
      heartbeatGraceMs: 60_000,
    });
    assert.deepEqual(records, [[3, true]]);
  });

  test('a probe that throws does not abort the whole cycle', async () => {
    const records = [];
    const gws = [
      { peer_id: 1, ip: '10.0.0.1', api_port: 9876, last_seen_at: 0 },
      { peer_id: 2, ip: '10.0.0.2', api_port: 9876, last_seen_at: 0 },
    ];
    await runProbeCycle({
      listGateways: () => gws,
      recordProbeResult: (id, ok) => records.push([id, ok]),
      probe: async (h) => {
        if (h === '10.0.0.1') throw new Error('boom');
        return true;
      },
      now: () => 999_999_999,
      heartbeatGraceMs: 60_000,
      logger: fakeLogger(),
    });
    assert.deepEqual(records, [[2, true]]);
  });

  test('empty gateway list is a no-op', async () => {
    const records = [];
    const result = await runProbeCycle({
      listGateways: () => [],
      recordProbeResult: (id, ok) => records.push([id, ok]),
      probe: async () => true,
      now: () => 999_999_999,
      heartbeatGraceMs: 60_000,
    });
    assert.equal(result.probed, 0);
    assert.deepEqual(records, []);
  });
});
