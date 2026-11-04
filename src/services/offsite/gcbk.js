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

// gzip in the thread pool: a backup with plugin data has up to a few hundred
// MB — gzipSync blocked the main thread for many seconds
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

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
  const parts = [aad];
  async function* payload() {
    yield head;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) yield chunk;
    yield tail;
  }
  await pipeline(payload, zlib.createGzip(), cipher, async (source) => { for await (const c of source) parts.push(c); });
  parts.push(cipher.getAuthTag());
  return Buffer.concat(parts);
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
};
