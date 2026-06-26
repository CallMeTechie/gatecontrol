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

test('parseDiscoveryResponse decodes a real V2 discovery response (test_discover.py:12)', () => {
  const V2 = Buffer.from('5a5a011178007a8000000000000000000000000060ca0000000e0000000000000000000001000000c08651cb1b88a167bdcf7d37534ef81312d39429bf9b2673f200b635fae369a560fa9655eab8344be22b1e3b024ef5dfd392dc3db64dbffb6a66fb9cd5ec87a78000cd9043833b9f76991e8af29f3496', 'hex');
  const info = lan.parseDiscoveryResponse(V2);
  assert.equal(info.version, 2);
  assert.equal(info.port, 6444);
  assert.equal(info.deviceType, 0xac);
  assert.equal(info.sn, '000000P0000000Q1F0C9D153F7B40000');
  assert.equal(String(info.deviceId), '15393162840672');
  assert.equal(info.ip, '10.100.1.140');
});

test('detectVersion by magic bytes', () => {
  assert.equal(lan.detectVersion(Buffer.from('5a5a0111', 'hex')), 2);
  assert.equal(lan.detectVersion(Buffer.from('837000c8', 'hex')), 3);
  assert.equal(lan.detectVersion(Buffer.from('3c3f786d', 'hex')), 1); // '<?xm' → V1 XML
});

test('computeBroadcast derives the subnet-directed broadcast address', () => {
  assert.equal(lan.computeBroadcast('192.168.1.50', '255.255.255.0'), '192.168.1.255');
  assert.equal(lan.computeBroadcast('10.0.5.4', '255.255.255.0'), '10.0.5.255');
  assert.equal(lan.computeBroadcast('172.16.5.4', '255.255.0.0'), '172.16.255.255');
  assert.equal(lan.computeBroadcast('192.168.1.50', '255.255.255.128'), '192.168.1.127');
  assert.equal(lan.computeBroadcast('10.1.2.3', '255.0.0.0'), '10.255.255.255');
  // malformed inputs → null (never throws)
  assert.equal(lan.computeBroadcast('not-an-ip', '255.255.255.0'), null);
  assert.equal(lan.computeBroadcast('192.168.1.1', 'bad'), null);
  assert.equal(lan.computeBroadcast('192.168.1.', '255.255.255.0'), null);   // trailing-dot / empty octet
  assert.equal(lan.computeBroadcast('192.168.1.999', '255.255.255.0'), null); // out-of-range octet
});

// ---- LanDevice ----

test('LanDevice requires token/key for V3', () => {
  const { LanDevice } = require('../src/services/midea/mideaLan');
  assert.throws(() => new LanDevice({ ip: '1.2.3.4', deviceId: '1', protocolVersion: 3 }),
    /token.*required|key.*required/i);
});

test('LanDevice V2 constructs without token/key', () => {
  const { LanDevice } = require('../src/services/midea/mideaLan');
  const dev = new LanDevice({ ip: '1.2.3.4', deviceId: '42', protocolVersion: 2 });
  assert.equal(dev.ip, '1.2.3.4');
  assert.equal(dev.version, 2);
  assert.equal(dev.token, null);
  assert.equal(dev.key, null);
});

test('LanDevice _nextPid wraps at 0xfff', () => {
  const { LanDevice } = require('../src/services/midea/mideaLan');
  const dev = new LanDevice({ ip: '1.2.3.4', deviceId: '1', protocolVersion: 2 });
  dev._packetId = 0xfff;
  assert.equal(dev._nextPid(), 0); // (0xfff + 1) & 0xfff === 0
});

test('LanDevice live getState', { skip: !process.env.GC_MIDEA_LIVE }, async () => {
  const { LanDevice } = require('../src/services/midea/mideaLan');
  const dev = new LanDevice(JSON.parse(process.env.GC_MIDEA_LIVE)); // {ip,port,deviceId,protocolVersion,token,key}
  const st = await dev.getState();
  assert.equal(typeof st.indoorTemp, 'number');
});
