'use strict';

// The streamed ZIP of the public links (src/services/plugins/zipStream.js):
// since 1.215.0 entry names with sub folders made safe for every extractor
// (no "..", nothing absolute, no backslash or ":"), unique names (a file never
// named like a folder), and ZIP64 sizes for an entry of 4 GiB or more — checked
// here with a lowered threshold, by a parser below and by `unzip -t` when the
// system has it.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const Z = require('../src/services/plugins/zipStream');

after(() => Z._setZip64MinForTest(null));

const entry = (name, buf) => ({ name, size: buf.length, read: async function* r() { yield buf.subarray(0, 3); yield buf.subarray(3); } });

async function build(entries) {
  const parts = [];
  for await (const p of Z.zipStream(entries, new Date(2026, 9, 29, 12, 0, 0))) parts.push(p);
  return Buffer.concat(parts);
}

/** Parse a ZIP (stored entries, ZIP64 extra fields) → [{ name, data, zip64 }], checking CRCs, descriptors and sizes. */
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'end record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header');
    const crc = buf.readUInt32LE(p + 16);
    let size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    let off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    let zip64 = false;
    if (xlen) {
      const x = buf.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
      assert.equal(x.readUInt16LE(0), 1, 'ZIP64 extra');
      let q = 4;
      if (size === 0xffffffff) { size = Number(x.readBigUInt64LE(q)); assert.equal(Number(x.readBigUInt64LE(q + 8)), size); q += 16; zip64 = true; }
      if (off === 0xffffffff) off = Number(x.readBigUInt64LE(q));
    }
    assert.equal(buf.readUInt32LE(off), 0x04034b50, 'local header');
    const lnl = buf.readUInt16LE(off + 26);
    const lxl = buf.readUInt16LE(off + 28);
    assert.equal(lxl, zip64 ? 20 : 0, 'a ZIP64 extra field in the local header of a big entry only');
    const start = off + 30 + lnl + lxl;
    const data = buf.subarray(start, start + size);
    assert.equal(zlib.crc32(data), crc, 'crc ' + name);
    assert.equal(buf.readUInt32LE(start + size), 0x08074b50, 'data descriptor');
    if (zip64) assert.equal(Number(buf.readBigUInt64LE(start + size + 16)), size, '8-byte sizes in the descriptor');
    else assert.equal(buf.readUInt32LE(start + size + 12), size);
    out.push({ name, data, zip64 });
    p += 46 + nlen + xlen;
  }
  return out;
}

describe('zip stream names', () => {
  it('no "..", nothing absolute, no backslash or ":" and no control characters in a name', () => {
    const got = Z.names([
      { name: '../../etc/passwd' }, { name: '/abs/x.txt' }, { name: 'a/./b//c.txt' }, { name: '..\\..\\win.ini' },
      { name: 'C:/Windows/x.dll' }, { name: 'datei.txt:stream' }, { name: 'a\u0000b\u202e.txt' }, { name: '..' }, { name: '' },
    ]).map(String);
    assert.deepEqual(got, ['etc/passwd', 'abs/x.txt', 'a/b/c.txt', '.._.._win.ini', 'C_/Windows/x.dll', 'datei.txt_stream', 'ab.txt', 'file', 'file (2)']);
    for (const n of got) {
      assert.ok(!n.startsWith('/') && !n.includes('\\') && !n.includes(':'), n);
      assert.ok(!n.split('/').some((s) => s === '..' || s === '.' || s === ''), n);
    }
  });

  it('unique (case-insensitive) names; a file named like a folder of another entry gets a number', () => {
    assert.deepEqual(Z.names([{ name: 'Fotos' }, { name: 'fotos/a.jpg' }, { name: 'Fotos/A.JPG' }, { name: 'a.txt' }, { name: 'A.txt' }, { name: 'x.y/z' }]).map(String),
      ['Fotos (2)', 'fotos/a.jpg', 'Fotos/A (2).JPG', 'a.txt', 'A (2).txt', 'x.y/z']);
  });
});

describe('zip stream ZIP64 entries', () => {
  it('an entry from the ZIP64 size on carries its sizes as ZIP64 (local extra, 8-byte descriptor, central extra); the length is exact', async () => {
    Z._setZip64MinForTest(1000);
    try {
      const small = crypto.randomBytes(999);
      const big = crypto.randomBytes(70 * 1024 + 5);
      const entries = [entry('klein.bin', small), entry('Ordner/gross.bin', big), entry('auch klein.txt', Buffer.from('abc'))];
      const z = await build(entries);
      assert.equal(z.length, Z.zipLength(entries));
      const got = unzip(z);
      assert.deepEqual(got.map((e) => [e.name, e.zip64]), [['klein.bin', false], ['Ordner/gross.bin', true], ['auch klein.txt', false]]);
      assert.ok(got[1].data.equals(big) && got[0].data.equals(small));
      // a real extractor agrees, when the system has one
      const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
      if (probe.status === 0) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-zip64-'));
        try {
          fs.writeFileSync(path.join(dir, 't.zip'), z);
          const r = spawnSync('unzip', ['-t', path.join(dir, 't.zip')], { encoding: 'utf8' });
          assert.equal(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stdout, /No errors detected/);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
    } finally { Z._setZip64MinForTest(null); }
  });

  it('a 5 GB entry: no error any more, the length counts the ZIP64 fields', () => {
    const GB = 1024 ** 3;
    const one = Z.zipLength([{ name: 'v.mp4', size: 5 * GB }]);
    // local header + name + ZIP64 extra (20) + data + 24-byte descriptor; central + name + extra (4 + 16); end records (the directory lies beyond 4 GiB)
    assert.equal(one, 30 + 5 + 20 + 5 * GB + 24 + 46 + 5 + 20 + 56 + 20 + 22);
  });
});
