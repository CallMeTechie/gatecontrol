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
