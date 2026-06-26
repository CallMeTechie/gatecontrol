'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lan = require('../src/services/midea/mideaLan');

test('V2 packet encode→decode round-trips the frame', () => {
  const FRAME = Buffer.from('aa21ac8d000000000003418100ff03ff000200000000000000000000000003016971', 'hex');
  const packet = lan.encodePacket(123456, FRAME);
  assert.equal(packet.slice(0, 2).toString('hex'), '5a5a');
  assert.deepEqual(lan.decodePacket(packet), FRAME);
});

test('decodePacket decodes a known real V2 packet (test_lan.py:26)', () => {
  const PACKET = Buffer.from('5a5a01116800208000000000000000000000000060ca0000000e0000000000000000000001000000c6a90377a364cb55af337259514c6f96bf084e8c7a899b50b68920cdea36cecf11c882a88861d1f46cd87912f201218c66151f0c9fbe5941c5384e707c36ff76', 'hex');
  const EXPECTED_FRAME = Buffer.from('aa22ac00000000000303c0014566000000300010045cff2070000000000000008bed19', 'hex');
  assert.deepEqual(lan.decodePacket(PACKET), EXPECTED_FRAME);
});
