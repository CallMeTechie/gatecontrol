'use strict';

// Small PDF helpers for "Drucken & Scannen" (services/homePrint.js) — no
// dependency: JPEG pages wrapped into a PDF (DCTDecode, the bytes as they
// are), the page count of a PDF (for the page limit per day), and the test
// page (PDF with the standard font Helvetica, nothing embedded).

const zlib = require('node:zlib');

const A4 = Object.freeze({ w: 595.28, h: 841.89 });
const MAX_INFLATE = 16 * 1024 * 1024;

/** Width, height and colour components of a JPEG (SOF0…SOF15 except 4, 8, 12), or null. */
function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return null;
    const m = buf[o + 1];
    if (m === 0xff) { o += 1; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    const len = buf.readUInt16BE(o + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (o + 10 > buf.length) return null;
      const height = buf.readUInt16BE(o + 5);
      const width = buf.readUInt16BE(o + 7);
      const components = buf[o + 9];
      if (!width || !height || ![1, 3, 4].includes(components)) return null;
      return { width, height, components };
    }
    if (m === 0xd9 || m === 0xda) return null;
    o += 2 + len;
  }
  return null;
}

function obj(n, body) { return Buffer.concat([Buffer.from(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]); }

function stream(dict, data) {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

/** Objects (index 0 = object 1) → a complete PDF with xref, catalog = object 1. */
function assemble(objects) {
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pos);
    const b = obj(i + 1, body);
    parts.push(b);
    pos += b.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const off of offsets) xref.push(String(off).padStart(10, '0') + ' 00000 n ');
  parts.push(Buffer.from(xref.join('\n') + '\n'));
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const num = (x) => (Math.round(x * 100) / 100).toString();

/**
 * JPEG pages → PDF. pages: [{ jpeg: Buffer, dpi?: number }]. With `dpi` (a
 * scan) the page has the scanned size; without (a photo to print) the
 * picture is fitted into A4 with a margin of 1 cm, turned to landscape A4
 * when it is wider than high.
 */
function jpegsToPdf(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('no pages');
  const objects = [null, null]; // 1 catalog, 2 pages
  const kids = [];
  for (const p of pages) {
    const info = jpegInfo(p.jpeg);
    if (!info) throw Object.assign(new Error('not a JPEG'), { code: 'not_jpeg' });
    let pw;
    let ph;
    let iw;
    let ih;
    if (Number.isFinite(p.dpi) && p.dpi > 0) {
      pw = (info.width / p.dpi) * 72;
      ph = (info.height / p.dpi) * 72;
      iw = pw; ih = ph;
    } else {
      const land = info.width > info.height;
      pw = land ? A4.h : A4.w;
      ph = land ? A4.w : A4.h;
      const margin = 28.35;
      const s = Math.min((pw - 2 * margin) / info.width, (ph - 2 * margin) / info.height);
      iw = info.width * s; ih = info.height * s;
    }
    const x = (pw - iw) / 2;
    const y = (ph - ih) / 2;
    const cs = info.components === 1 ? '/DeviceGray' : (info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB');
    const imgN = objects.length + 1;
    objects.push(stream(`/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''}`, p.jpeg));
    const content = Buffer.from(`q ${num(iw)} 0 0 ${num(ih)} ${num(x)} ${num(y)} cm /Im0 Do Q`);
    const cN = objects.length + 1;
    objects.push(stream('', content));
    const pageN = objects.length + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] /Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${cN} 0 R >>`);
    kids.push(`${pageN} 0 R`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  return assemble(objects);
}

function countIn(text) {
  const pages = (text.match(/\/Type\s{0,8}\/Page(?![a-zA-Z])/g) || []).length;
  // the root of the page tree has the largest /Count (outlines count less in any sane file)
  let count = 0;
  for (const m of text.matchAll(/\/Count\s{1,8}(\d{1,6})/g)) count = Math.max(count, Number(m[1]));
  return { pages, count };
}

/**
 * Page count of a PDF: the page objects (also inside compressed object
 * streams), else the /Count of the page tree; 1 when nothing is found (a PDF
 * the printer reads anyway — the limit then counts it as one page).
 */
function pdfPages(buf) {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 1024).indexOf('%PDF-') < 0) return null;
  const text = buf.toString('latin1');
  let { pages, count } = countIn(text);
  if (!pages) {
    // PDF 1.5+: page objects inside /Type /ObjStm streams (FlateDecode)
    let inflated = 0;
    let at = text.indexOf('/ObjStm');
    while (at >= 0 && inflated < MAX_INFLATE) {
      const kw = text.indexOf('stream', at);
      if (kw < 0) break;
      let start = kw + 6;
      if (text[start] === '\r') start += 1;
      if (text[start] === '\n') start += 1;
      const end = text.indexOf('endstream', start);
      if (end < 0) break;
      at = text.indexOf('/ObjStm', end);
      try {
        const out = zlib.inflateSync(buf.subarray(start, end), { maxOutputLength: MAX_INFLATE });
        inflated += out.length;
        const c = countIn(out.toString('latin1'));
        pages += c.pages;
        count = Math.max(count, c.count);
      } catch { /* not deflated / broken: skip */ }
    }
  }
  return Math.max(1, pages || count || 1);
}

/** PDF string literal in WinAnsi (Latin-1), ( ) \ escaped; other characters → '?'. */
function pdfText(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c === 0x20ac) out += '\\200';
    else if (c === 0x2013) out += '\\226';
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += '\\' + c.toString(8).padStart(3, '0');
    else out += '?';
  }
  return '(' + out + ')';
}

/**
 * The test page: title, the printer, when, and colour bars (only grey when
 * the printer prints black and white). lines: { title, device, when, note }.
 */
function testPagePdf({ title, device, when, note, color = true }) {
  const bars = color
    ? [['0 0 0', 'K'], ['0 0.68 0.94', 'C'], ['0.93 0 0.55', 'M'], ['1 0.95 0', 'Y']]
    : [['0 0 0', '100'], ['0.25 0.25 0.25', '75'], ['0.5 0.5 0.5', '50'], ['0.75 0.75 0.75', '25']];
  const ops = [];
  ops.push('BT /F1 26 Tf 56 760 Td ' + pdfText(title) + ' Tj ET');
  ops.push('BT /F1 13 Tf 56 728 Td ' + pdfText(device) + ' Tj ET');
  ops.push('BT /F1 11 Tf 56 708 Td ' + pdfText(when) + ' Tj ET');
  bars.forEach(([rgb, label], i) => {
    const x = 56 + i * 124;
    ops.push(`${rgb} rg ${x} 560 112 112 re f`);
    ops.push(`0 0 0 rg BT /F1 10 Tf ${x} 544 Td ${pdfText(label)} Tj ET`);
  });
  ops.push('0 0 0 RG 1 w 56 480 m 539 480 l S');
  if (note) ops.push('BT /F1 10 Tf 56 460 Td ' + pdfText(note) + ' Tj ET');
  const content = Buffer.from(ops.join('\n'), 'latin1');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    stream('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]);
}

module.exports = { jpegInfo, jpegsToPdf, pdfPages, testPagePdf, pdfText, A4 };
