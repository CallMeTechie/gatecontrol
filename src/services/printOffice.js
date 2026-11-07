'use strict';

// Office files and plain text for printing (Drucken & Scannen — gateway
// docs/print.md "Office-Dateien"): which kind of document a file is (by its
// content: RTF, OpenDocument by its `mimetype` entry, Office Open XML by the
// parts in the ZIP), how many pages it says it has (docProps/app.xml,
// meta.xml — an estimate before printing; the gateway reports the real count
// after LibreOffice made the PDF), and plain text as UTF-8/UTF-16/Latin-1.
// Only reading: a ZIP is looked at through its central directory, entries are
// inflated with a size limit, nothing is unpacked to disk.

const zlib = require('node:zlib');

const TYPES = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
});
const OFFICE_TYPES = Object.values(TYPES);
const BY_MIME = Object.fromEntries(Object.entries(TYPES).map(([ext, m]) => [m, ext]));
const TEXT = 'text/plain';
const MAX_ENTRIES = 4096;
const MAX_META = 1024 * 1024;

const le16 = (b, o) => b.readUInt16LE(o);
const le32 = (b, o) => b.readUInt32LE(o);

/** The entries of a ZIP (central directory) → [{ name, method, csize, size, offset }] or null (not a ZIP). */
function zipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || le32(buf, 0) !== 0x04034b50) return null;
  const from = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) if (le32(buf, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = le16(buf, eocd + 10);
  let o = le32(buf, eocd + 16);
  const out = [];
  for (let k = 0; k < Math.min(count, MAX_ENTRIES); k++) {
    if (o + 46 > buf.length || le32(buf, o) !== 0x02014b50) return out.length ? out : null;
    const method = le16(buf, o + 10);
    const csize = le32(buf, o + 20);
    const size = le32(buf, o + 24);
    const nl = le16(buf, o + 28);
    const el = le16(buf, o + 30);
    const cl = le16(buf, o + 32);
    const offset = le32(buf, o + 42);
    out.push({ name: buf.toString('utf8', o + 46, Math.min(buf.length, o + 46 + nl)), method, csize, size, offset });
    o += 46 + nl + el + cl;
  }
  return out;
}

/** The bytes of one entry (stored or deflated, ≤ max) or null. */
function zipRead(buf, e, max = MAX_META) {
  if (!e || e.size > max || e.offset + 30 > buf.length || le32(buf, e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + le16(buf, e.offset + 26) + le16(buf, e.offset + 28);
  const data = buf.subarray(start, Math.min(buf.length, start + e.csize));
  try {
    if (e.method === 0) return data.subarray(0, max);
    if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: max });
  } catch { return null; }
  return null;
}

/** An integer of an XML element (`<Pages>12</Pages>`, `meta:page-count="3"`) or null. */
function number(text, re) {
  const m = re.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= 100000 ? n : null;
}

/**
 * The kind of an office file by its content → { mime, ext, pages } (pages: what the file says, null when it
 * says nothing — Excel, a file never saved by an office program) or null (not one of TYPES).
 */
function officeInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return { mime: TYPES.rtf, ext: 'rtf', pages: null };
  const entries = zipEntries(buf);
  if (!entries) return null;
  const byName = new Map(entries.map((e) => [e.name, e]));
  // OpenDocument: the first entry "mimetype", stored, says what it is
  const mt = byName.get('mimetype');
  if (mt) {
    const m = (zipRead(buf, mt, 200) || Buffer.alloc(0)).toString('latin1').trim();
    const ext = BY_MIME[m];
    if (ext && ext.startsWith('od')) {
      const meta = zipRead(buf, byName.get('meta.xml'));
      return { mime: m, ext, pages: meta ? number(meta.toString('utf8'), /meta:page-count="(\d{1,6})"/) : null };
    }
    return null;
  }
  // Office Open XML: the main part names the kind; docProps/app.xml the pages (Word) or slides (PowerPoint)
  const ext = byName.has('word/document.xml') ? 'docx' : (byName.has('xl/workbook.xml') ? 'xlsx' : (byName.has('ppt/presentation.xml') ? 'pptx' : null));
  if (!ext || !byName.has('[Content_Types].xml')) return null;
  const app = zipRead(buf, byName.get('docProps/app.xml'));
  const text = app ? app.toString('utf8') : '';
  const pages = ext === 'docx' ? number(text, /<Pages>(\d{1,6})<\/Pages>/) : (ext === 'pptx' ? number(text, /<Slides>(\d{1,6})<\/Slides>/) : null);
  return { mime: TYPES[ext], ext, pages };
}

/** Plain text: a declared text/plain (or a .txt name) and no NUL byte in the first 8 KB (UTF-16 with a BOM counts). */
function isText(buf, mime, name) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  const named = typeof name === 'string' && /\.(txt|text|log|csv)$/i.test(name);
  if (m !== TEXT && !named) return false;
  if (!Buffer.isBuffer(buf) || !buf.length) return false;
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return true;
  return buf.subarray(0, 8192).indexOf(0) < 0;
}

/** The text of a file: UTF-16 by its BOM, UTF-8 (BOM dropped) when valid, else Latin-1. */
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    sw.swap16();
    return sw.toString('utf16le');
  }
  const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start)); } catch { return buf.toString('latin1'); }
}

module.exports = { TYPES, OFFICE_TYPES, TEXT, officeInfo, isText, decodeText, zipEntries, zipRead };
