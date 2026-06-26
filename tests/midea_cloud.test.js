'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cloud = require('../src/services/midea/mideaCloud');

test('APP_VARIANTS expose public constants, not secrets', () => {
  assert.equal(cloud.APP_VARIANTS.msmarthome.appId, '1010');
  assert.equal(cloud.APP_VARIANTS.nethome.appId, '1017');
  assert.ok(cloud.APP_VARIANTS.nethome.appKey);   // public app key present
});

test('computeUdpid matches the real msmart vector (big-endian device id)', () => {
  // device_id 147334558165565 → big-endian 6-byte id = 86000000aa3d
  // udpid = strxor(sha256(idBytes)[:16], sha256(idBytes)[16:]).hex
  // This is the SHARP vector — verified against the V3 discovery response tail.
  const idBytes = Buffer.from('86000000aa3d', 'hex');
  assert.equal(cloud.computeUdpid(idBytes), '4fbe0d4139de99cc88a0285e14657045');
  // little-endian sibling, for completeness:
  assert.equal(cloud.computeUdpid(Buffer.from('3daa00000086', 'hex')), 'b617531f693d3380eed45a7fa2e257b2');
});

test('getToken builds idBytes for both endians without RangeError', async () => {
  const c = new cloud.MideaCloud('msmarthome');
  // Stub the network: always return an empty tokenlist so both endianness
  // branches run their buffer construction, then fall through to NO_TOKEN.
  const calls = [];
  c._request = async (endpoint, body) => { calls.push(body.udpid); return { tokenlist: [] }; };
  await assert.rejects(
    () => c.getToken('147334558165565'),
    (e) => e.code === 'MIDEA_CLOUD_NO_TOKEN',
  );
  // Both endianness udpids were attempted (no synchronous RangeError aborted it).
  assert.equal(calls.length, 2);
});

test('MSmartHome request body sends NUMERIC format/clientType (cloud.py types)', async () => {
  const c = new cloud.MideaCloud('msmarthome');
  let sent;
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => { sent = JSON.parse(opts.body); return { status: 200, json: async () => ({ code: '0', data: {} }) }; };
  try {
    await c._requestMSmart('/v1/user/login/id/get', { loginAccount: 'a@b.de' });
  } finally { global.fetch = origFetch; }
  // The Midea cloud rejects "2"/"1" (strings) with "value is illegal" — these must be numbers.
  assert.strictEqual(sent.format, 2);
  assert.strictEqual(sent.clientType, 1);
  assert.equal(typeof sent.format, 'number');
  assert.equal(typeof sent.clientType, 'number');
  // common fields present + passthrough data merged
  assert.equal(sent.appId, '1010');
  assert.equal(sent.language, 'en_US');
  assert.equal(sent.loginAccount, 'a@b.de');
  assert.ok(sent.stamp && sent.reqId && sent.deviceId);
});

test('live login + listDevices', { skip: !process.env.GC_MIDEA_CLOUD }, async () => {
  const { email, password, app } = JSON.parse(process.env.GC_MIDEA_CLOUD);
  const c = new cloud.MideaCloud(app);
  await c.login(email, password);
  const devs = await c.listDevices();
  assert.ok(Array.isArray(devs));
});
