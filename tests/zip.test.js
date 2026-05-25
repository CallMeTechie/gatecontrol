'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createZip, crc32 } = require('../src/utils/zip');

test('crc32 matches known reference values', () => {
  assert.equal(crc32(Buffer.from('')), 0x00000000);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.from('hello')), 0x3610A686);
});

test('createZip produces a structurally valid store-only archive', () => {
  const files = [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'empty', data: Buffer.from('') }];
  const z = createZip(files);
  const eocd = z.length - 22;
  assert.equal(z.readUInt32LE(eocd), 0x06054b50);
  assert.equal(z.readUInt16LE(eocd + 10), 2);
  const cdSize = z.readUInt32LE(eocd + 12);
  const cdOff = z.readUInt32LE(eocd + 16);
  assert.equal(cdOff + cdSize, eocd);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt16LE(8), 0);
  assert.equal(z.readUInt32LE(14), crc32(Buffer.from('hello')));
  assert.equal(z.readUInt32LE(18), 5);
  assert.equal(z.readUInt32LE(22), 5);
  assert.equal(z.readUInt32LE(cdOff), 0x02014b50);
  assert.equal(z.readUInt32LE(cdOff + 42), 0);
});
