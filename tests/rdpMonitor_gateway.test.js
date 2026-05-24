'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const test = require('node:test');
const assert = require('node:assert');
const { resolveCheckTarget, isGatewayStale } = require('../src/services/rdpMonitor');

test('gateway route checked against loopback listen port', () => {
  const t = resolveCheckTarget({ access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: 13389 });
  assert.deepStrictEqual(t, { host: '127.0.0.1', port: 13389 });
});

test('internal route checked against host:port', () => {
  const t = resolveCheckTarget({ access_mode: 'internal', host: '10.8.0.5', port: 3389 });
  assert.deepStrictEqual(t, { host: '10.8.0.5', port: 3389 });
});

test('gateway peer stale when last_seen older than threshold (epoch ms)', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(isGatewayStale(now - 200_000, 90_000, now), true);  // 200s old > 90s
  assert.strictEqual(isGatewayStale(now - 10_000, 90_000, now), false);  // 10s old
  assert.strictEqual(isGatewayStale(null, 90_000, now), true);           // never seen
});
