'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/services/midea/mideaCrypto');

test('ENC_KEY = md5(SIGN_KEY), 16 bytes', () => {
  assert.equal(c.ENC_KEY.length, 16);
  assert.equal(c.SIGN_KEY.toString(), 'xhdiwjnchekd4d512chdjx5d8e4c394D2D7S');
});

test('AES-ECB round-trip', () => {
  const pt = Buffer.from('hello midea lan!', 'utf8');
  assert.deepEqual(c.decryptAesEcb(c.encryptAesEcb(pt)), pt);
});

test('AES-CBC zero-IV no-pad round-trip on 32-byte block', () => {
  const key = Buffer.alloc(32, 7);
  const data = Buffer.alloc(32, 9);            // bereits 16er-Vielfaches
  assert.deepEqual(c.decryptAesCbc(key, c.encryptAesCbc(key, data)), data);
});

test('strxor', () => {
  assert.deepEqual(
    c.strxor(Buffer.from([0xff, 0x0f]), Buffer.from([0x0f, 0xff])),
    Buffer.from([0xf0, 0xf0]),
  );
});

test('frameChecksum matches GetStateCommand vector tail', () => {
  // frame[10:-1] of GetStateCommand (msg_id 0x11) = ...0311f4
  // CRC8 input is the 22-byte payload (without the trailing CRC byte itself).
  // Source: msmart/device/AC/test_command.py EXPECTED_PAYLOAD
  //   "418100ff03ff00020000000000000000000000000311f4"
  const payload = Buffer.from('418100ff03ff00020000000000000000000000000311', 'hex'); // 22 bytes, incl. msg_id 0x11
  assert.equal(c.crc8(payload), 0xf4);
});
