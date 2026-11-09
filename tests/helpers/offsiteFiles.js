'use strict';

// The off-site transports upload archive FILES ({ path, size }, see
// src/services/offsite/source.js) and download into files (downloadTo) —
// helpers for tests that want Buffers on their side.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let dir = null;
function tmpDir() {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-files-'));
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  }
  return dir;
}

function tmpName(kind) { return path.join(tmpDir(), `${kind}-${crypto.randomBytes(6).toString('hex')}`); }

/** A Buffer as an archive file for upload(): { path, size, ...extra }. */
function archiveFile(buf, extra = {}) {
  const p = tmpName('archive');
  fs.writeFileSync(p, buf, { mode: 0o600 });
  return { path: p, size: buf.length, ...extra };
}

/** downloadTo() into a temp file → its content as a Buffer (the file is removed). */
async function downloadBuffer(transport, cfg, name, ctx, opts) {
  const p = tmpName('download');
  try {
    const n = await transport.downloadTo(cfg, name, p, ctx, opts);
    const buf = fs.readFileSync(p);
    if (n !== buf.length) throw new Error(`downloadTo said ${n} bytes, the file has ${buf.length}`);
    return buf;
  } finally { fs.rmSync(p, { force: true }); }
}

module.exports = { archiveFile, downloadBuffer, tmpName };
