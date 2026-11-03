'use strict';

// Grundschutz of the virus scan (services/scan/index.js): file-type rules
// that need no signatures and no memory of their own — always on.
//
//   * the EICAR test file (so "Mit Testdatei prüfen" works without a scanner)
//   * programs: Windows (MZ), Linux (ELF), macOS (Mach-O) by their first bytes,
//     scripts and other runnable types by name. A program that hides behind
//     another type ("Rechnung.pdf.exe", an MZ file named .pdf) is a finding
//     everywhere; a plain program only from outside (links, mail, GateDrop,
//     messenger) — people keep installers in their own Drive
//   * Office documents with macros from outside: OOXML with vbaProject.bin
//     (.docm/.xlsm/.pptm …), OLE2 documents with a _VBA_PROJECT stream
//   * ZIP archives: the names inside (programs, disguised programs, macro
//     documents), ZIPs in ZIPs up to `depth` levels; encrypted entries or a
//     deeper nesting make the file "not scannable"
//
// Everything is read through `read(start, end)` (plaintext byte ranges of the
// sealed file, media.readRangeRaw) — never the whole file into memory.
// Inner ZIPs are inflated asynchronously and only up to INNER_MAX bytes.

const zlib = require('node:zlib');
const { promisify } = require('node:util');

const inflateRaw = promisify(zlib.inflateRaw);

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const EXEC_EXT = new Set(['exe', 'scr', 'pif', 'com', 'cpl', 'msi', 'msp', 'dll', 'sys', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'hta', 'lnk', 'jar', 'reg', 'scf', 'iso', 'img', 'vhd', 'vhdx', 'appx', 'msix', 'apk', 'xll', 'gadget', 'application', 'chm', 'inf', 'url']);
const MACRO_EXT = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppsm', 'sldm']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'mp3', 'mp4',
  'mov', 'zip', 'csv', 'html', 'htm', 'heic', 'svg', 'eml', 'msg']);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const VBA_UTF16 = Buffer.from('_VBA_PROJECT', 'utf16le');
const MACRO_SCAN_MAX = 20 * 1024 * 1024;
const INNER_MAX = 50 * 1024 * 1024;
const MAX_ENTRIES = 20000;

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** "Rechnung.pdf.exe" → 'pdf' (the extension that pretends), else null. */
function decoyExt(name) {
  const parts = String(name || '').trim().toLowerCase().split('.');
  if (parts.length < 3) return null;
  const last = parts[parts.length - 1];
  const before = parts[parts.length - 2];
  return EXEC_EXT.has(last) && DOC_EXT.has(before) ? before : null;
}

/** What the first bytes say: 'pe' | 'elf' | 'macho' | 'ole' | 'zip' | null. */
function magicOf(head) {
  if (!head || head.length < 4) return null;
  if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'elf';
  const be = head.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(be)) return 'macho';
  if (be === 0xcafebabe && head.length >= 8 && head.readUInt32BE(4) < 40) return 'macho'; // universal binary (not a Java class)
  if (head.length >= 8 && head.subarray(0, 8).equals(OLE_MAGIC)) return 'ole';
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) ) return 'zip';
  return null;
}

/** A name inside an archive or of the file itself → finding code or null. */
function nameRule(name, external) {
  const decoy = decoyExt(name);
  if (decoy) return 'GC.Executable.DoubleExtension';
  const ext = extOf(name);
  if (external && EXEC_EXT.has(ext)) return 'GC.Executable.Attachment';
  if (external && MACRO_EXT.has(ext)) return 'GC.Office.Macro';
  return null;
}

// ─── ZIP ───────────────────────────────────────────────

/** The central directory of a ZIP in `buf`-like access → [{ name, method, encrypted, csize, size, offset }] or null. */
async function zipEntries(read, size) {
  if (size < 22) return null;
  const tailLen = Math.min(size, 65536 + 22);
  const tail = await read(size - tailLen, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64: the locator right before the EOCD
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) return null;
    const z64 = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await read(z64, z64 + 55);
    if (rec.readUInt32LE(0) !== 0x06064b50) return null;
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > size || cdSize > 64 * 1024 * 1024) return null;
  const cd = cdSize ? await read(cdOffset, cdOffset + cdSize - 1) : Buffer.alloc(0);
  const out = [];
  let p = 0;
  while (p + 46 <= cd.length && out.length < Math.min(count, MAX_ENTRIES)) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    // ZIP64 extra field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff && q + 8 <= x + 4 + len) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff && q + 8 <= x + 4 + len) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff && q + 8 <= x + 4 + len) { offset = Number(cd.readBigUInt64LE(q)); }
      }
      x += 4 + len;
    }
    out.push({ name, method, encrypted: !!(flags & 1), csize, size: usize, offset });
    p = xend + clen;
  }
  return out;
}

async function entryData(read, size, e) {
  const head = await read(e.offset, Math.min(size - 1, e.offset + 29));
  if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) return null;
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (e.csize === 0) return Buffer.alloc(0);
  const raw = await read(start, Math.min(size - 1, start + e.csize - 1));
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRaw(raw, { maxOutputLength: INNER_MAX });
  return null;
}

/** Inspect a ZIP: { finding, detail } | { unscannable, detail } | null. */
async function inspectZip(read, size, { external, depth, maxDepth, path = '' }) {
  const entries = await zipEntries(read, size);
  if (!entries) return null;
  const names = entries.map((e) => e.name.toLowerCase());
  // an Office document is a ZIP too: macros live in vbaProject.bin
  if (names.some((n) => n.endsWith('vbaproject.bin'))) {
    if (external && path === '') return { finding: 'GC.Office.Macro', detail: { kind: 'macro' } };
    if (external) return { finding: 'GC.Archive.OfficeMacro', detail: { kind: 'archive_macro', entry: path } };
  }
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const base = e.name.split('/').pop();
    const rule = nameRule(base, true);
    if (rule) return { finding: rule === 'GC.Office.Macro' ? 'GC.Archive.OfficeMacro' : 'GC.Archive.Executable', detail: { kind: 'archive_entry', entry: (path ? path + ' › ' : '') + e.name.slice(0, 200), decoy: decoyExt(base) } };
  }
  if (entries.some((e) => e.encrypted)) return { unscannable: 'encrypted', detail: { kind: 'encrypted', entry: path || null } };
  for (const e of entries) {
    if (extOf(e.name) !== 'zip' && extOf(e.name) !== 'docm' && extOf(e.name) !== 'xlsm') continue;
    if (depth + 1 > maxDepth) return { unscannable: 'archive_depth', detail: { kind: 'depth', entry: e.name.slice(0, 200) } };
    if (e.size > INNER_MAX || e.csize > INNER_MAX) return { unscannable: 'too_large', detail: { kind: 'inner_too_large', entry: e.name.slice(0, 200) } };
    let inner;
    try { inner = await entryData(read, size, e); } catch { inner = null; }
    if (!inner) continue;
    const innerRead = async (s, en) => inner.subarray(s, en + 1);
    const r = await inspectZip(innerRead, inner.length, { external, depth: depth + 1, maxDepth, path: (path ? path + ' › ' : '') + e.name.slice(0, 200) });
    if (r) return r;
  }
  return null;
}

// ─── OLE2 macros ───────────────────────────────────────

async function oleHasMacros(read, size) {
  const limit = Math.min(size, MACRO_SCAN_MAX);
  const CH = 1024 * 1024;
  let carry = Buffer.alloc(0);
  for (let off = 0; off < limit; off += CH) {
    const part = await read(off, Math.min(limit, off + CH) - 1);
    const buf = carry.length ? Buffer.concat([carry, part]) : part;
    if (buf.indexOf(VBA_UTF16) >= 0) return true;
    carry = buf.subarray(Math.max(0, buf.length - VBA_UTF16.length));
  }
  return false;
}

/**
 * Run the rules. `read(start, end)` → Promise<Buffer> (inclusive range).
 * → { verdict: 'clean' | 'infected' | 'unscannable', finding?, reason?, detail? }
 */
async function check({ name, mime, size, read, external, maxDepth = 5 }) {
  if (!size) return { verdict: 'clean' };
  const head = await read(0, Math.min(size, 4096) - 1);
  if (head.subarray(0, 128).toString('latin1').includes(EICAR)) return { verdict: 'infected', finding: 'Eicar-Test-Signature', detail: { kind: 'eicar' } };
  const magic = magicOf(head);
  const ext = extOf(name);
  const decoy = decoyExt(name);
  if (magic === 'pe' || magic === 'elf' || magic === 'macho') {
    if (decoy) return { verdict: 'infected', finding: 'GC.Executable.DoubleExtension', detail: { kind: 'double_ext', decoy } };
    if (ext && DOC_EXT.has(ext)) return { verdict: 'infected', finding: 'GC.Executable.Disguised', detail: { kind: 'disguised', ext } };
    if (/^(image|video|audio|text)\//.test(String(mime || ''))) return { verdict: 'infected', finding: 'GC.Executable.Disguised', detail: { kind: 'disguised', mime } };
    if (external) return { verdict: 'infected', finding: 'GC.Executable.Attachment', detail: { kind: 'executable', format: magic } };
  }
  const byName = nameRule(name, external);
  if (byName) return { verdict: 'infected', finding: byName, detail: { kind: byName === 'GC.Office.Macro' ? 'macro' : (decoy ? 'double_ext' : 'executable'), decoy } };
  if (magic === 'zip') {
    const z = await inspectZip(read, size, { external, depth: 1, maxDepth });
    if (z && z.finding) return { verdict: 'infected', finding: z.finding, detail: z.detail };
    if (z && z.unscannable) return { verdict: 'unscannable', reason: z.unscannable, detail: z.detail };
  }
  if (magic === 'ole' && external && await oleHasMacros(read, size)) return { verdict: 'infected', finding: 'GC.Office.Macro', detail: { kind: 'macro' } };
  return { verdict: 'clean' };
}

module.exports = { EICAR, check, magicOf, decoyExt, extOf, nameRule, zipEntries, inspectZip };
