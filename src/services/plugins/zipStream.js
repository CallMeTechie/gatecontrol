'use strict';

// A streamed ZIP of stored (uncompressed) entries — "Alle als ZIP" of the
// public links (publicLinks.js, routes/publicLinks.js, since 1.193.0).
//
//   * nothing is held in memory or written to disk: each entry's bytes are
//     read (decrypted) while they are sent; the CRC-32 is computed on the
//     way and written in a data descriptor after the entry (general purpose
//     flag bit 3), names are UTF-8 (bit 11);
//   * the sizes are known in advance (plugin_media.bytes), so the whole
//     archive's length is too (zipLength) — the download shows its progress;
//   * one entry is at most 2 GB (media.maxBytes), but 20 of them pass 4 GiB:
//     an entry whose local header lies beyond 4 GiB gets a ZIP64 extra field
//     in the central directory, and the archive a ZIP64 end record when the
//     directory lies beyond 4 GiB (APPNOTE 4.3.14 / 4.5.3).

const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const FLAGS = 0x0008 | 0x0800; // data descriptor, UTF-8 names
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const ENTRY_MAX = MAX32 - 1;    // one entry's size must fit the 32-bit fields

const LOCAL_LEN = 30;
const DESCRIPTOR_LEN = 16;
const CENTRAL_LEN = 46;
const ZIP64_EXTRA_LEN = 12;     // tag, size, 8-byte local header offset
const END_LEN = 22;
const END64_LEN = 56;
const LOCATOR64_LEN = 20;

// CRC-32 (zlib.crc32 since Node 22.2; the table for older runtimes)
let table = null;
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** MS-DOS date and time of `d` (local time, 2-second resolution, 1980 at the earliest). */
function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** The entries' names as unique UTF-8 buffers ("a.pdf", "a (2).pdf", …). */
function names(entries) {
  const seen = new Set();
  return entries.map((e) => {
    const raw = String(e.name || 'file');
    const dot = raw.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [raw.slice(0, dot), raw.slice(dot)] : [raw, ''];
    let name = raw;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    seen.add(name.toLowerCase());
    return Buffer.from(name, 'utf8');
  });
}

/** Offsets of every local header, the central directory's offset and size. */
function layout(entries) {
  const nameBufs = names(entries);
  let offset = 0;
  const offsets = [];
  entries.forEach((e, i) => {
    if (!Number.isSafeInteger(e.size) || e.size < 0 || e.size > ENTRY_MAX) throw new Error('zip entry too large');
    offsets.push(offset);
    offset += LOCAL_LEN + nameBufs[i].length + e.size + DESCRIPTOR_LEN;
  });
  const cdOffset = offset;
  let cdSize = 0;
  nameBufs.forEach((n, i) => { cdSize += CENTRAL_LEN + n.length + (offsets[i] >= MAX32 ? ZIP64_EXTRA_LEN : 0); });
  const zip64 = entries.length >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32;
  return { nameBufs, offsets, cdOffset, cdSize, zip64 };
}

/** The exact length of the archive zipStream() writes for these entries. */
function zipLength(entries) {
  const l = layout(entries);
  return l.cdOffset + l.cdSize + (l.zip64 ? END64_LEN + LOCATOR64_LEN : 0) + END_LEN;
}

function localHeader(name, t) {
  const b = Buffer.alloc(LOCAL_LEN);
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(20, 4);            // version needed: 2.0
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(0, 8);             // stored
  b.writeUInt16LE(t.time, 10);
  b.writeUInt16LE(t.date, 12);
  // crc and sizes 0: they follow in the data descriptor
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);
  return Buffer.concat([b, name]);
}

function descriptor(crc, size) {
  const b = Buffer.alloc(DESCRIPTOR_LEN);
  b.writeUInt32LE(SIG_DESCRIPTOR, 0);
  b.writeUInt32LE(crc >>> 0, 4);
  b.writeUInt32LE(size, 8);
  b.writeUInt32LE(size, 12);
  return b;
}

function centralHeader(name, t, crc, size, offset) {
  const big = offset >= MAX32;
  const b = Buffer.alloc(CENTRAL_LEN);
  b.writeUInt32LE(SIG_CENTRAL, 0);
  b.writeUInt16LE(big ? 45 : 20, 4); // version made by (MS-DOS host)
  b.writeUInt16LE(big ? 45 : 20, 6); // version needed (4.5: ZIP64)
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(t.time, 12);
  b.writeUInt16LE(t.date, 14);
  b.writeUInt32LE(crc >>> 0, 16);
  b.writeUInt32LE(size, 20);
  b.writeUInt32LE(size, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(big ? ZIP64_EXTRA_LEN : 0, 30);
  b.writeUInt32LE(big ? MAX32 : offset, 42);
  if (!big) return Buffer.concat([b, name]);
  const x = Buffer.alloc(ZIP64_EXTRA_LEN);
  x.writeUInt16LE(0x0001, 0);
  x.writeUInt16LE(8, 2);
  x.writeBigUInt64LE(BigInt(offset), 4);
  return Buffer.concat([b, name, x]);
}

function endRecords(count, cdOffset, cdSize, zip64) {
  const out = [];
  if (zip64) {
    const e = Buffer.alloc(END64_LEN);
    e.writeUInt32LE(SIG_END64, 0);
    e.writeBigUInt64LE(BigInt(END64_LEN - 12), 4);
    e.writeUInt16LE(45, 12);
    e.writeUInt16LE(45, 14);
    e.writeBigUInt64LE(BigInt(count), 24);
    e.writeBigUInt64LE(BigInt(count), 32);
    e.writeBigUInt64LE(BigInt(cdSize), 40);
    e.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(LOCATOR64_LEN);
    loc.writeUInt32LE(SIG_LOCATOR64, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    out.push(e, loc);
  }
  const b = Buffer.alloc(END_LEN);
  b.writeUInt32LE(SIG_END, 0);
  b.writeUInt16LE(Math.min(count, MAX16), 8);
  b.writeUInt16LE(Math.min(count, MAX16), 10);
  b.writeUInt32LE(zip64 ? MAX32 : cdSize, 12);
  b.writeUInt32LE(zip64 ? MAX32 : cdOffset, 16);
  out.push(b);
  return Buffer.concat(out);
}

/**
 * The archive, piece by piece.
 * @param {Array<{ name: string, size: number, read: () => AsyncIterable<Buffer> }>} entries
 * @param {Date} [when] the entries' modification time
 * @returns {AsyncGenerator<Buffer>} throws when an entry yields another size than declared
 */
async function* zipStream(entries, when = new Date()) {
  const l = layout(entries);
  const t = dosDateTime(when);
  const crcs = [];
  for (let i = 0; i < entries.length; i++) {
    yield localHeader(l.nameBufs[i], t);
    let crc = 0;
    let size = 0;
    for await (const part of entries[i].read()) {
      size += part.length;
      if (size > entries[i].size) throw new Error('zip entry larger than declared');
      crc = crc32(part, crc);
      yield part;
    }
    if (size !== entries[i].size) throw new Error('zip entry shorter than declared');
    crcs.push(crc);
    yield descriptor(crc, size);
  }
  const central = entries.map((e, i) => centralHeader(l.nameBufs[i], t, crcs[i], e.size, l.offsets[i]));
  yield Buffer.concat(central);
  yield endRecords(entries.length, l.cdOffset, l.cdSize, l.zip64);
}

module.exports = { zipStream, zipLength, crc32, names };
