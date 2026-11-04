'use strict';

// Minimal ZIP reader for tests of the gateway assistant (gatecontrol-setup.zip,
// gatecontrol-gateway-nas.zip): central directory → entries, stored entries
// only, CRC checked with the writer's own crc32.

const assert = require('node:assert/strict');
const kit = require('../../public/js/gateway-kit');

/** Minimal ZIP reader (central directory → entries) that also checks the CRC. */
function unzip(buf) {
  const b = Buffer.from(buf);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(p), 0x02014b50, 'central header');
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const size = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const attrs = b.readUInt32LE(p + 38);
    const off = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(b.readUInt32LE(off), 0x04034b50, 'local header of ' + name);
    const lnlen = b.readUInt16LE(off + 26);
    const lelen = b.readUInt16LE(off + 28);
    const data = b.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + size);
    assert.equal(method, 0, 'stored');
    assert.equal(kit.crc32(data), crc, 'crc of ' + name);
    out.push({ name, data, mode: attrs >>> 16 });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

module.exports = { unzip };
