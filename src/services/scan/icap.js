'use strict';

// ICAP client (RFC 3507) for an own scanner (ESET, Sophos, Kaspersky, c-icap
// with ClamAV …). RESPMOD: the file goes as the body of an HTTP response the
// scanner may change; "Allow: 204" lets it answer "204 No Content" for a
// clean file. Infected: 200/403 with X-Infection-Found / X-Virus-ID /
// X-Violations-Found (or a replaced body). The body is sent chunked while it
// is read — never buffered. OPTIONS checks the connection ("Verbindung testen").

const N = require('./net');

const CHUNK = 64 * 1024;

function headersOf(text) {
  const lines = text.split('\r\n');
  const status = /^ICAP\/1\.0\s+(\d{3})/.exec(lines[0] || '');
  const h = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status: status ? Number(status[1]) : 0, headers: h };
}

function head(addr) { return `icap://${addr.host.includes(':') ? `[${addr.host}]` : addr.host}:${addr.port}/${addr.service || 'avscan'}`; }

async function options(addr, { timeoutMs = 5000 } = {}) {
  const sock = await N.connect(addr, { timeoutMs });
  try {
    await N.write(sock, Buffer.from(`OPTIONS ${head(addr)} ICAP/1.0\r\nHost: ${addr.host}\r\nEncapsulated: null-body=0\r\n\r\n`));
    const reply = await N.readReply(sock, { timeoutMs, done: (b) => b.includes('\r\n\r\n') });
    const r = headersOf(reply.toString('latin1'));
    if (r.status !== 200) throw new N.ScanNetError('protocol', `OPTIONS answered ${r.status || 'nothing'}`);
    return { service: r.headers.service || null, methods: r.headers.methods || null, istag: r.headers.istag || null };
  } finally { sock.destroy(); }
}

/** Finding of an ICAP answer → string or null. */
function findingOf(h) {
  const inf = h['x-infection-found'];
  if (inf) {
    const m = /Threat=([^;]+);?/i.exec(inf);
    return (m ? m[1] : inf).trim().slice(0, 200);
  }
  if (h['x-virus-id']) return String(h['x-virus-id']).trim().slice(0, 200);
  if (h['x-violations-found']) {
    const lines = String(h['x-violations-found']).split(/\s+/);
    return (lines[1] || 'ICAP.Violation').slice(0, 200);
  }
  return null;
}

/**
 * Scan `source` (async iterable of Buffers) of `name`.
 * → { verdict: 'clean' | 'infected' | 'unscannable', finding? }
 */
async function scan(addr, source, { name = 'file', timeoutMs = 120000 } = {}) {
  const sock = await N.connect(addr, { timeoutMs: 5000 });
  const reply = N.readReply(sock, { timeoutMs, max: 1024 * 1024, done: (b) => b.includes('\r\n\r\n') });
  reply.catch(() => {});
  try {
    const safe = String(name).replace(/[^\w.\-]/g, '_').slice(0, 100) || 'file';
    const reqHdr = `GET /${encodeURIComponent(safe)} HTTP/1.1\r\nHost: gatecontrol\r\n\r\n`;
    const resHdr = 'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n';
    const icap = `RESPMOD ${head(addr)} ICAP/1.0\r\nHost: ${addr.host}\r\nAllow: 204\r\n`
      + `Encapsulated: req-hdr=0, res-hdr=${Buffer.byteLength(reqHdr)}, res-body=${Buffer.byteLength(reqHdr) + Buffer.byteLength(resHdr)}\r\n\r\n`;
    await N.write(sock, Buffer.from(icap + reqHdr + resHdr, 'latin1'));
    for await (const part of source) {
      for (let o = 0; o < part.length; o += CHUNK) {
        const piece = part.subarray(o, o + CHUNK);
        await N.write(sock, Buffer.concat([Buffer.from(piece.length.toString(16) + '\r\n'), piece, Buffer.from('\r\n')]));
      }
    }
    await N.write(sock, Buffer.from('0\r\n\r\n'));
    const r = headersOf((await reply).toString('latin1').split('\r\n\r\n')[0]);
    if (r.status === 204) return { verdict: 'clean' };
    const found = findingOf(r.headers);
    if (found) return { verdict: 'infected', finding: found };
    if (r.status === 200) return { verdict: 'clean' }; // body returned unchanged without a finding
    if (r.status === 403) return { verdict: 'infected', finding: 'ICAP.Blocked' };
    if (r.status === 413) return { verdict: 'unscannable', reason: 'too_large' };
    throw new N.ScanNetError('protocol', `RESPMOD answered ${r.status || 'nothing'}`);
  } finally { sock.destroy(); }
}

module.exports = { options, scan, findingOf, headersOf };
