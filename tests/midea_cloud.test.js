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

test('live login + listDevices', { skip: !process.env.GC_MIDEA_CLOUD }, async () => {
  const { email, password, app } = JSON.parse(process.env.GC_MIDEA_CLOUD);
  const c = new cloud.MideaCloud(app);
  await c.login(email, password);
  const devs = await c.listDevices();
  assert.ok(Array.isArray(devs));
});
