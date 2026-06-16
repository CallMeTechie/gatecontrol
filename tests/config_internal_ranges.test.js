'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function loadConfig(extraEnv) {
  for (const [k, v] of Object.entries(extraEnv || {})) process.env[k] = v;
  process.env.NODE_ENV = 'test';
  process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
  delete require.cache[require.resolve('../config/default')];
  return require('../config/default');
}

test('internalOnlyRanges defaults to the VPN subnet only', () => {
  delete process.env.GC_HUB_PUBLIC_IP;
  const c = loadConfig({ GC_WG_SUBNET: '10.8.0.0/24' });
  assert.deepEqual(c.wireguard.internalOnlyRanges, ['10.8.0.0/24']);
});

test('internalOnlyRanges appends GC_HUB_PUBLIC_IP as /32 when set', () => {
  const c = loadConfig({ GC_WG_SUBNET: '10.8.0.0/24', GC_HUB_PUBLIC_IP: '54.36.233.20' });
  assert.deepEqual(c.wireguard.internalOnlyRanges, ['10.8.0.0/24', '54.36.233.20/32']);
  delete process.env.GC_HUB_PUBLIC_IP; // don't leak into later test files
});
