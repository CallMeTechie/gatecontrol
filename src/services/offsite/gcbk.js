'use strict';

// GCBK1 — encrypted off-site backup container (docs/feature-release-b.md §7).
//
//   offset  size  content
//   0       5     ASCII "GCBK1"
//   5       2     header length H (uint16, big endian)
//   7       H     header, UTF-8 JSON:
//                   { kdf:"scrypt", N, r, p, salt:<b64 16 B>, iv:<b64 12 B>,
//                     cipher:"aes-256-gcm", compression:"gzip",
//                     created_at, gc_version, include_key }
//   7+H     n     AES-256-GCM ciphertext of gzip(payload JSON)
//   end-16  16    GCM auth tag
//
// Key = scrypt(passphrase NFC, salt, 32, {N, r, p}). Magic + length + header
// are the GCM additional data, so the header cannot be altered unnoticed.
// Payload JSON: { format:"gatecontrol-offsite", version:1, created_at,
//   gc_version, backup:<the JSON backup of services/backup.js>,
//   encryption_key?:<GC_ENCRYPTION_KEY hex, only with include_key> }.
//
// With include_key, passphrase + archive are enough for a restore on new
// hardware: services/offsite/rekey.js re-encrypts every secret in the backup
// from the archived key to the key of the restoring installation.
//
// No dependencies beyond Node core modules — also used by the stand-alone
// CLI src/bin/offsite-decrypt.js, which must work without a configured app.

const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

// gzip in the thread pool. encryptBackup()/decryptBackup() work on one buffer
// (small backups, tests); backup FILES go through the streaming
// encryptBackupFile() / decryptBackupFileTo() — a backup with plugin data has
// up to several hundred MB.
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
// the largest decrypted payload (a backup JSON with 512 MB plugin data +
// 128 MB plugin media is about 860 MB; services/plugins/backup.js)
const MAX_PLAIN_BYTES = 1024 * 1024 * 1024;

const MAGIC = Buffer.from('GCBK1', 'ascii');
const FORMAT = 'gatecontrol-offsite';
const DEFAULT_KDF = Object.freeze({ N: 1 << 17, r: 8, p: 1 });
// Upper bounds for parameters read from a (possibly hostile) file.
const MAX_N = 1 << 18; // ≤ 256 MiB scrypt memory with r = 8
const MAX_R = 8;
const MAX_P = 4;
const MAX_HEADER = 4096;
const MIN_PASSPHRASE = 12;

class GcbkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function isGcbk(buf) {
  return Buffer.isBuffer(buf) && buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function normPass(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new GcbkError('PASSPHRASE_REQUIRED', 'passphrase required');
  return Buffer.from(passphrase.normalize('NFC'), 'utf8');
}

function deriveKey(passphrase, salt, { N, r, p }) {
  const maxmem = 128 * N * r * 2 + 1024 * 1024;
  return new Promise((resolve, reject) => {
    crypto.scrypt(normPass(passphrase), salt, 32, { N, r, p, maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * @param {object} backup        JSON backup object (services/backup.createBackup)
 * @param {object} opts
 * @param {string} opts.passphrase
 * @param {string} [opts.encryptionKey]  hex key to embed (include_key)
 * @param {string} [opts.gcVersion]
 * @param {object} [opts.kdf]            {N,r,p} (tests use a small N)
 * @returns {Promise<Buffer>}
 */
async function encryptBackup(backup, { passphrase, encryptionKey, gcVersion = null, kdf = DEFAULT_KDF } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new GcbkError('PASSPHRASE_TOO_SHORT', `passphrase must have at least ${MIN_PASSPHRASE} characters`);
  }
  const createdAt = new Date().toISOString();
  const payload = { format: FORMAT, version: 1, created_at: createdAt, gc_version: gcVersion, backup };
  if (encryptionKey) payload.encryption_key = encryptionKey;
  const plain = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({
    kdf: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    cipher: 'aes-256-gcm', compression: 'gzip',
    created_at: createdAt, gc_version: gcVersion, include_key: !!encryptionKey,
  }), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(header.length);
  const aad = Buffer.concat([MAGIC, len, header]);

  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([aad, ct, cipher.getAuthTag()]);
}

/**
 * encryptBackup() for a backup FILE (services/autobackup writes them), as a
 * stream: the file is read in chunks and spliced into the payload text as it
 * is — never parsed, never stringified again — then gzip (thread pool) and
 * AES-GCM run chunk by chunk. JSON.parse + JSON.stringify + one cipher pass
 * over a few hundred MB blocked the event loop for seconds before. The
 * payload is the same as encryptBackup() makes (the backup part keeps the
 * whitespace of the file — gzip makes that free, JSON.parse ignores it).
 *
 * @param {string} file          path of a JSON backup file
 * @param {object} opts          as encryptBackup()
 * @returns {Promise<Buffer>}
 */
async function encryptBackupFile(file, { passphrase, encryptionKey, gcVersion = null, kdf = DEFAULT_KDF } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new GcbkError('PASSPHRASE_TOO_SHORT', `passphrase must have at least ${MIN_PASSPHRASE} characters`);
  }
  await checkJsonObjectFile(file);
  const createdAt = new Date().toISOString();
  // the keys in the order of encryptBackup()'s payload object
  const head = Buffer.from(JSON.stringify({ format: FORMAT, version: 1, created_at: createdAt, gc_version: gcVersion }).slice(0, -1) + ',"backup":', 'utf8');
  const tail = Buffer.from((encryptionKey ? ',"encryption_key":' + JSON.stringify(encryptionKey) : '') + '}', 'utf8');

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({
    kdf: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    cipher: 'aes-256-gcm', compression: 'gzip',
    created_at: createdAt, gc_version: gcVersion, include_key: !!encryptionKey,
  }), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(header.length);
  const aad = Buffer.concat([MAGIC, len, header]);

  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  async function* payload() {
    yield head;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) yield chunk;
    yield tail;
  }
  // into a temp file next to the backup, then read in one piece: the archive
  // is in memory once (chunks + Buffer.concat held it twice)
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.gcbk.tmp`;
  try {
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    out.write(aad);
    await pipeline(payload, zlib.createGzip(), cipher, out);
    await fs.promises.appendFile(tmp, cipher.getAuthTag());
    return await fs.promises.readFile(tmp);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

/** The file must hold a JSON object (first/last non-blank byte) — a cheap check instead of parsing it. */
async function checkJsonObjectFile(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const n = Math.min(size, 4096);
    const start = Buffer.alloc(n);
    const end = Buffer.alloc(n);
    await fh.read(start, 0, n, 0);
    await fh.read(end, 0, n, size - n);
    const first = start.toString('latin1').trimStart()[0];
    const last = end.toString('latin1').trimEnd().slice(-1);
    if (first !== '{' || last !== '}') throw new GcbkError('CORRUPT', 'the backup file is not a JSON object');
  } finally { await fh.close(); }
}

/** Parse + sanity-check the header without the passphrase. */
function readHeader(buf) {
  if (!isGcbk(buf)) throw new GcbkError('NOT_GCBK', 'not a GCBK1 file');
  if (buf.length < 7) throw new GcbkError('CORRUPT', 'file truncated');
  const hlen = buf.readUInt16BE(5);
  if (hlen === 0 || hlen > MAX_HEADER || buf.length < 7 + hlen + 16) throw new GcbkError('CORRUPT', 'file truncated or header invalid');
  let h;
  try { h = JSON.parse(buf.subarray(7, 7 + hlen).toString('utf8')); } catch { throw new GcbkError('CORRUPT', 'header is not JSON'); }
  const ok = h && h.kdf === 'scrypt' && h.cipher === 'aes-256-gcm'
    && Number.isInteger(h.N) && h.N >= 1024 && h.N <= MAX_N && (h.N & (h.N - 1)) === 0
    && Number.isInteger(h.r) && h.r >= 1 && h.r <= MAX_R
    && Number.isInteger(h.p) && h.p >= 1 && h.p <= MAX_P
    && typeof h.salt === 'string' && typeof h.iv === 'string';
  if (!ok) throw new GcbkError('UNSUPPORTED', 'unsupported GCBK1 parameters');
  const salt = Buffer.from(h.salt, 'base64');
  const iv = Buffer.from(h.iv, 'base64');
  if (salt.length < 16 || iv.length !== 12) throw new GcbkError('UNSUPPORTED', 'unsupported GCBK1 parameters');
  return { header: h, headerLength: hlen, salt, iv };
}

/**
 * @param {Buffer} buf
 * @param {string} passphrase
 * @returns {Promise<{header:object, payload:{backup:object, encryption_key?:string}}>}
 */
async function decryptBackup(buf, passphrase) {
  const { header, headerLength, salt, iv } = readHeader(buf);
  const aad = buf.subarray(0, 7 + headerLength);
  const body = buf.subarray(7 + headerLength, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const key = await deriveKey(passphrase, salt, header);
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(aad);
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new GcbkError('DECRYPT_FAILED', 'wrong passphrase or damaged file');
  }
  let payload;
  try {
    payload = JSON.parse((await gunzip(plain, { maxOutputLength: 512 * 1024 * 1024 })).toString('utf8'));
  } catch {
    throw new GcbkError('CORRUPT', 'decrypted content is not a GateControl backup');
  }
  if (!payload || payload.format !== FORMAT || !payload.backup || typeof payload.backup !== 'object') {
    throw new GcbkError('CORRUPT', 'decrypted content is not a GateControl backup');
  }
  if (payload.encryption_key !== undefined && !/^[0-9a-f]{64}$/i.test(String(payload.encryption_key))) {
    throw new GcbkError('CORRUPT', 'archived encryption key is invalid');
  }
  return { header, payload };
}

/**
 * decryptBackup() for an archive FILE, as a stream: the decrypted, unzipped
 * payload JSON is written to `outFile` (new file, 0600) in pieces — never the
 * whole archive or payload in memory. The GCM tag is checked at the end; on
 * any error `outFile` is removed (nothing of an unauthenticated archive is
 * left). Read the payload with utils/jsonSpool (backup.readBackupFile).
 *
 * @param {string} file      the .gcbk
 * @param {string} passphrase
 * @param {string} outFile   where the payload JSON goes
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<{header: object, bytes: number}>}
 */
async function decryptBackupFileTo(file, passphrase, outFile, { maxBytes = MAX_PLAIN_BYTES } = {}) {
  let size;
  let first;
  const tag = Buffer.alloc(16);
  const fh = await fs.promises.open(file, 'r');
  try {
    size = (await fh.stat()).size;
    first = Buffer.alloc(Math.min(size, 7 + MAX_HEADER + 16));
    await fh.read(first, 0, first.length, 0);
    if (size >= 16) await fh.read(tag, 0, 16, size - 16);
  } finally { await fh.close(); }
  const { header, headerLength, salt, iv } = readHeader(first); // checks the length too
  const aad = first.subarray(0, 7 + headerLength);
  if (size <= 7 + headerLength + 16) throw new GcbkError('CORRUPT', 'file truncated');
  const key = await deriveKey(passphrase, salt, header);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new GcbkError('TOO_LARGE', `decrypted backup is larger than ${Math.round(maxBytes / 1048576)} MB`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(file, { start: 7 + headerLength, end: size - 17, highWaterMark: 256 * 1024 }),
      d, zlib.createGunzip(), limit,
      fs.createWriteStream(outFile, { flags: 'wx', mode: 0o600 }),
    );
  } catch (err) {
    await fs.promises.rm(outFile, { force: true }).catch(() => {});
    if (err instanceof GcbkError || (err && (err.code === 'ENOSPC' || err.code === 'EEXIST'))) throw err;
    // a wrong key shows as a broken gzip stream, a changed file at the latest as a bad tag at the end
    throw new GcbkError('DECRYPT_FAILED', 'wrong passphrase or damaged file');
  }
  return { header, bytes };
}

/** The payload of a decrypted archive (decryptBackupFileTo + jsonSpool / JSON.parse) checked like decryptBackup() does. */
function checkPayload(payload) {
  if (!payload || payload.format !== FORMAT || !payload.backup || typeof payload.backup !== 'object') {
    throw new GcbkError('CORRUPT', 'decrypted content is not a GateControl backup');
  }
  if (payload.encryption_key !== undefined && !/^[0-9a-f]{64}$/i.test(String(payload.encryption_key))) {
    throw new GcbkError('CORRUPT', 'archived encryption key is invalid');
  }
  return payload;
}

/** Is the FILE an archive (magic bytes)? */
async function isGcbkFile(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    return bytesRead === MAGIC.length && b.equals(MAGIC);
  } finally { await fh.close(); }
}

module.exports = {
  MAGIC,
  FORMAT,
  DEFAULT_KDF,
  MIN_PASSPHRASE,
  GcbkError,
  isGcbk,
  readHeader,
  encryptBackup,
  encryptBackupFile,
  decryptBackup,
  decryptBackupFileTo,
  checkPayload,
  isGcbkFile,
  MAX_PLAIN_BYTES,
};
