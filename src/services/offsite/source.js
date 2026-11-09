'use strict';

// What an off-site transport uploads (upload(cfg, name, body)): the archive
// FILE that services/offsite/index.js builds — { path, size, partSize?,
// partHashes? } (gcbk.writeBackupArchive) — or a Buffer (the write probes of
// test(), small uploads in tests). A file is never read into memory: the
// transports send it from read streams (one per request, so a retry after a
// certificate was trusted starts from the first byte again) or hand its path
// to smbclient / sftp, which read it in chunks themselves.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const READ_CHUNK = 256 * 1024;

/**
 * → { size, buffer (Buffer | null), path (string | null), partSize, partHashes,
 *     open(start, end) → Readable of bytes start…end (inclusive) }
 */
function sourceOf(body) {
  if (Buffer.isBuffer(body)) {
    return { size: body.length, buffer: body, path: null, partSize: null, partHashes: null, open: null };
  }
  if (body && typeof body.path === 'string' && Number.isSafeInteger(body.size) && body.size > 0) {
    return {
      size: body.size,
      buffer: null,
      path: body.path,
      partSize: Number.isSafeInteger(body.partSize) ? body.partSize : null,
      partHashes: Array.isArray(body.partHashes) ? body.partHashes : null,
      open: (start = 0, end = body.size - 1) => fs.createReadStream(body.path, { start, end, highWaterMark: READ_CHUNK }),
    };
  }
  throw new TypeError('upload: a Buffer or an archive file { path, size }');
}

/** SHA-256 (hex) of bytes start…end (inclusive) of a file, read in chunks. */
async function hashFile(file, start, end) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file, { start, end, highWaterMark: READ_CHUNK })) h.update(c);
  return h.digest('hex');
}

// a local path handed to smbclient (-c "…; put "<path>" …") or to an sftp
// batch line ("put "<path>" …"): no quote, backslash, ";" or control character
const LOCAL_PATH_RE = /^\/[^"\\;\u0000-\u001f\u007f]*$/;

/** A local file path the smbclient / sftp command lines can carry; throws code TRANSPORT otherwise. */
function localPath(p, what) {
  if (typeof p !== 'string' || !LOCAL_PATH_RE.test(p)) {
    const e = new Error(`${what}: the local path of the archive contains characters the transfer cannot pass on`);
    e.code = 'TRANSPORT';
    throw e;
  }
  return p;
}

// errors of this server's own disk while writing a download — never the target's fault
const LOCAL_CODES = new Set(['ENOSPC', 'EDQUOT', 'EEXIST', 'EACCES', 'EPERM', 'EROFS']);
function isLocalError(err) { return !!(err && LOCAL_CODES.has(err.code)); }

class TooLarge extends Error {
  constructor(max) { super(`the archive is larger than ${Math.round(max / 1048576)} MB`); this.code = 'TOO_LARGE'; }
}

/**
 * Write a response body to `file` (new, 0600), at most `maxBytes` — piece by
 * piece, never the whole body in memory. → bytes written. On an error the
 * file stays for the caller to remove (it owns the name).
 */
async function streamToFile(stream, file, maxBytes) {
  let n = 0;
  const limit = new Transform({
    transform(chunk, enc, cb) {
      n += chunk.length;
      if (n > maxBytes) cb(new TooLarge(maxBytes));
      else cb(null, chunk);
    },
  });
  await pipeline(stream, limit, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  return n;
}

/**
 * Hard time limit of an smbclient / sftp transfer of `bytes`: the base limit
 * plus what the slowest line still worth waiting for (1 Mbit/s) needs — a
 * few hundred MB over a home upload take longer than the old fixed 3 min.
 */
function transferTimeout(baseMs, bytes) {
  const MIN_RATE = 128 * 1024; // bytes per second
  return baseMs + Math.ceil((Number(bytes) || 0) / MIN_RATE) * 1000;
}

module.exports = { sourceOf, hashFile, localPath, streamToFile, transferTimeout, isLocalError, TooLarge, READ_CHUNK };
