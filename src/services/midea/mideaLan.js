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

// ---- Part C: UDP discovery (discover.py) ----
const dgram = require('node:dgram');

// 72-byte broadcast probe — from const.py DISCOVERY_MSG
const DISCOVERY_MSG = Buffer.from(
  '5a5a011148009200' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '7f75bd6b3e4f8b762e849c6e578d6590036e9d4342a50f1f569eb8ec918e92e5',
  'hex'
);
// assert DISCOVERY_MSG.length === 72 (verified: 16+64+64 hex chars = 72 bytes)

function detectVersion(d) {
  if (d[0] === 0x5a && d[1] === 0x5a) return 2;
  if (d[0] === 0x83 && d[1] === 0x70) return 3;
  return 1; // V1 XML (unsupported for AC)
}

function parseDiscoveryResponse(datagram) {
  const version = detectVersion(datagram);
  let data = datagram;
  if (version === 3) data = data.slice(8, -16); // strip 8370 header + 16-byte hash → inner 5a5a
  // 6-byte LE device id (bytes 20..25):
  let devId = 0n;
  for (let i = 0; i < 6; i++) devId += BigInt(data[20 + i]) << BigInt(8 * i);
  const encrypted = data.slice(40, -16);
  const decrypted = decryptAesEcb(encrypted);
  const ip = `${decrypted[3]}.${decrypted[2]}.${decrypted[1]}.${decrypted[0]}`;
  const port = decrypted.readUInt16LE(4);
  const sn = decrypted.slice(8, 40).toString('ascii');
  const nameLen = decrypted[40];
  const name = decrypted.slice(41, 41 + nameLen).toString('ascii');
  const deviceType = parseInt(name.split('_')[1], 16);
  return { ip, port, deviceId: devId.toString(), sn, deviceType, version };
}

function discover({ timeoutMs = 3000, broadcast = '255.255.255.255', ports = [6445, 20086] } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = new Map();
    sock.on('message', (msg) => {
      try {
        const v = detectVersion(msg);
        if (v === 1) return;
        const info = parseDiscoveryResponse(msg);
        if (info.deviceType === 0xac) found.set(info.deviceId, info);
      } catch { /* ignore malformed */ }
    });
    sock.on('error', () => { try { sock.close(); } catch {} resolve([]); });
    sock.bind(() => {
      sock.setBroadcast(true);
      for (const port of ports) for (let i = 0; i < 3; i++) sock.send(DISCOVERY_MSG, port, broadcast);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs);
  });
}

module.exports = Object.assign(module.exports, { detectVersion, parseDiscoveryResponse, discover, DISCOVERY_MSG });

// ---- Part D: TCP transport LanDevice ----
const net = require('node:net');
const mideaAc = require('./mideaAc');

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`midea ${label} timeout`)), ms)),
  ]);
}

class LanDevice {
  constructor({ ip, port = 6444, deviceId, protocolVersion = 3, token = null, key = null, timeoutMs = 8000 }) {
    if (protocolVersion === 3 && (!token || !key)) {
      throw new Error('token and key are required for protocol version 3');
    }
    this.ip = ip; this.port = port; this.deviceId = deviceId;
    this.version = protocolVersion;
    this.token = token ? Buffer.from(token, 'hex') : null;
    this.key = key ? Buffer.from(key, 'hex') : null;
    this.timeoutMs = timeoutMs;
    this._packetId = 0;
  }

  _nextPid() { this._packetId = (this._packetId + 1) & 0xfff; return this._packetId; }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.ip, port: this.port }, () => resolve(sock));
      sock.setTimeout(this.timeoutMs);
      sock.on('timeout', () => { sock.destroy(); reject(new Error('midea connect timeout')); });
      sock.on('error', reject);
    });
  }

  _readOnce(sock) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const need = (b) => {
        if (b.length < 6) return Infinity;
        if (b[0] === 0x83 && b[1] === 0x70) return b.readUInt16BE(2) + 8;   // 8370
        if (b[0] === 0x5a && b[1] === 0x5a) return b.readUInt16LE(4);       // 5a5a
        return b.length;
      };
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= need(buf)) { sock.off('data', onData); resolve(buf); }
      };
      sock.on('data', onData);
      sock.once('error', reject);
    });
  }

  async _send(sock, payload) {
    sock.write(payload);
    return withTimeout(this._readOnce(sock), this.timeoutMs, 'read');
  }

  async _authenticate(sock) {
    const req = encodeHandshakeRequest(this.token, this._nextPid());
    const resp = await this._send(sock, req);
    const data = decodeHandshakeResponse(resp);
    return getLocalKey(this.key, data);          // localKey
  }

  // Sends a 0xAA frame, returns parsed AcState.
  async _command(frame) {
    const sock = await this._connect();
    try {
      let localKey = null;
      if (this.version === 3) localKey = await this._authenticate(sock);
      const v2 = encodePacket(Number(this.deviceId) || 0, frame);
      let reply;
      if (this.version === 3) {
        const req = encodeEncryptedRequest(localKey, v2, this._nextPid());
        const raw = await this._send(sock, req);
        const innerV2 = decodeEncryptedResponse(localKey, raw);
        reply = decodePacket(innerV2);
      } else {
        const raw = await this._send(sock, v2);
        reply = decodePacket(raw);
      }
      return mideaAc.parseState(reply);
    } finally {
      try { sock.destroy(); } catch {}
    }
  }

  async getState() {
    return this._command(mideaAc.buildQuery({ messageId: this._nextPid() & 0xff }));
  }

  async setState(patch) {
    const current = await this.getState();        // read
    const merged = { ...current, ...patch };       // modify
    await this._command(mideaAc.buildSet(merged, { messageId: this._nextPid() & 0xff })); // write
    return this.getState();                        // confirm
  }
}

module.exports = Object.assign(module.exports, { LanDevice });
