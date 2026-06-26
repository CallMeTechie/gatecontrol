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

test('V3 decodeEncryptedResponse decodes a known real packet → inner V2 payload (test_lan.py:37)', () => {
  const LOCAL_KEY = Buffer.from('55a0a178746a424bf1fc6bb74b9fb9e4515965048d24ce8dc72aca91597d05ab', 'hex');
  const PACKET = Buffer.from('8370008e2063ec2b8aeb17d4e3aff77094dde7fa65cf22671adf807f490a97b927347943626e9b4f58362cf34b97a0d641f8bf0c8fcbf69ad8cca131d2d7baa70ef048c5e3f3dc78da8af4598ff47aee762a0345c18815d91b50a24dedcacde0663c4ec5e73a963dc8bbbea9a593859996eb79dcfcc6a29b96262fcaa8ea6346366efea214e4a2e48caf83489475246b6fef90192b00', 'hex');
  const EXPECTED_PAYLOAD = Buffer.from('5a5a01116800208000000000eaa908020c0817143daa0000008600000000000000000180000000003e99f93bb0cf9ffa100cb24dbae7838641d6e63ccbcd366130cd74a372932526d98479ff1725dce7df687d32e1776bf68a3fa6fd6259d7eb25f32769fcffef78', 'hex');
  const innerV2 = lan.decodeEncryptedResponse(LOCAL_KEY, PACKET);
  assert.deepEqual(innerV2, EXPECTED_PAYLOAD);
  // and the inner V2 payload decodes to the expected 0xAA frame:
  const frame = lan.decodePacket(innerV2);
  assert.equal(frame.slice(0, 3).toString('hex'), 'aa23ac');
});

test('V3 encodeEncryptedRequest→decodeEncryptedResponse round-trips inner V2 payload', () => {
  const localKey = Buffer.alloc(32, 0x11);
  const innerV2 = lan.encodePacket(123456, Buffer.from('aa21ac8d000000000003418100ff03ff000200000000000000000000000003016971', 'hex'));
  const req = lan.encodeEncryptedRequest(localKey, innerV2, 5555);
  assert.equal(req.slice(0, 2).toString('hex'), '8370');
  assert.deepEqual(lan.decodeEncryptedResponse(localKey, req), innerV2);
});

test('getLocalKey inverts a synthetic handshake response', () => {
  const { encryptAesCbc, sha256, strxor } = require('../src/services/midea/mideaCrypto');
  const key = Buffer.alloc(32, 0x42);
  const session = Buffer.alloc(32, 0x77);
  const handshakeData = Buffer.concat([encryptAesCbc(key, session), sha256(session)]);
  const localKey = lan.getLocalKey(key, handshakeData);
  assert.equal(localKey.length, 32);
  assert.deepEqual(localKey, strxor(session, key));
});
