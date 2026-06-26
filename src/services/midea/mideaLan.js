'use strict';

const crypto = require('node:crypto');
const { encryptAesEcb, decryptAesEcb, signMd5 } = require('./mideaCrypto');

// ---- V2 packet (_Packet, lan.py:686) ----
function buildTimestamp(now = new Date()) {
  // order: [microsecond//10000, second, minute, hour, day, month, year%100, year//100]
  const cs = Math.floor(now.getMilliseconds() * 1000 / 10000); // ms→µs→/10000 ≈ centiseconds
  return Buffer.from([
    cs & 0xff,
    now.getSeconds(), now.getMinutes(), now.getHours(),
    now.getDate(), now.getMonth() + 1,
    now.getFullYear() % 100, Math.floor(now.getFullYear() / 100),
  ]);
}

function encodePacket(deviceId, frame, now = new Date()) {
  const enc = encryptAesEcb(frame);
  const total = 40 + enc.length + 16;
  const header = Buffer.alloc(40);
  header[0] = 0x5a; header[1] = 0x5a;          // start
  header[2] = 0x01; header[3] = 0x11;          // message type
  header.writeUInt16LE(total, 4);              // total length
  header[6] = 0x20; header[7] = 0x00;          // magic
  // [8..11] message id = 0
  buildTimestamp(now).copy(header, 12);        // [12..19] timestamp
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(deviceId));
  idBuf.copy(header, 20);                       // [20..27] device id (8 LE)
  // [28..39] zero padding
  const headPlusEnc = Buffer.concat([header, enc]);
  return Buffer.concat([headPlusEnc, signMd5(headPlusEnc)]);
}

function decodePacket(packet) {
  if (!(packet[0] === 0x5a && packet[1] === 0x5a)) throw new Error('not a 5a5a packet');
  const encrypted = packet.slice(40, -16);
  const expectSign = packet.slice(-16);
  if (!signMd5(packet.slice(0, -16)).equals(expectSign)) throw new Error('packet sign mismatch');
  return decryptAesEcb(encrypted);
}

module.exports = { encodePacket, decodePacket, buildTimestamp };

// ---- V3 8370 framing (_LanProtocolV3, lan.py) ----
const { encryptAesCbc, decryptAesCbc, sha256, strxor } = require('./mideaCrypto');

const V3_MAGIC = 0x20;
const TYPE_HANDSHAKE_REQ = 0x0;
const TYPE_ENCRYPTED_REQ = 0x6;

function buildV3Header(payloadLenWithSign, pad, type) {
  // 8370 | size(2 big) | 20 | (pad<<4 | type)
  const h = Buffer.alloc(6);
  h[0] = 0x83; h[1] = 0x70;
  h.writeUInt16BE(payloadLenWithSign, 2);     // = len(payload)+pad+32, packet-id NOT counted
  h[4] = V3_MAGIC;
  h[5] = ((pad & 0x0f) << 4) | (type & 0x0f);
  return h;
}

function encodeEncryptedRequest(localKey, data, packetId) {
  const remainder = (data.length + 2) % 16;
  const pad = remainder ? 16 - remainder : 0;
  const size = data.length + pad + 32;
  const header = buildV3Header(size, pad, TYPE_ENCRYPTED_REQ);
  const pidBuf = Buffer.alloc(2); pidBuf.writeUInt16BE(packetId & 0xfff);
  const payload = Buffer.concat([pidBuf, data, crypto.randomBytes(pad)]);
  const enc = encryptAesCbc(localKey, payload);
  const hash = sha256(Buffer.concat([header, payload]));
  return Buffer.concat([header, enc, hash]);
}

function decodeEncryptedResponse(localKey, packet) {
  const header = packet.slice(0, 6);
  const enc = packet.slice(6, -32);
  const rxHash = packet.slice(-32);
  const dec = decryptAesCbc(localKey, enc);
  if (!sha256(Buffer.concat([header, dec])).equals(rxHash)) throw new Error('v3 hash mismatch');
  const pad = header[5] >> 4;
  return dec.slice(2, pad ? -pad : undefined);   // strip 2-byte packet id + padding
}

function encodeHandshakeRequest(token, packetId) {
  const pidBuf = Buffer.alloc(2); pidBuf.writeUInt16BE(packetId & 0xfff);
  const payload = Buffer.concat([pidBuf, token]);
  const header = buildV3Header(payload.length, 0, TYPE_HANDSHAKE_REQ);
  return Buffer.concat([header, payload]);
}

function decodeHandshakeResponse(packet) {
  return packet.slice(8);                         // strip 6-byte header + 2-byte packet id → 64 bytes
}

function getLocalKey(key, handshakeData) {
  const payload = handshakeData.slice(0, 32);
  const rxHash = handshakeData.slice(32);
  const decrypted = decryptAesCbc(key, payload);
  if (!sha256(decrypted).equals(rxHash)) throw new Error('handshake hash mismatch');
  return strxor(decrypted, key);                  // 32-byte session key
}

module.exports = Object.assign(module.exports, {
  encodeEncryptedRequest, decodeEncryptedResponse,
  encodeHandshakeRequest, decodeHandshakeResponse, getLocalKey,
});
