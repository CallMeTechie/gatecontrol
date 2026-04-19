'use strict';

const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const config = require('../../config/default');

const execFileAsync = promisify(execFile);

/**
 * Run a command with stdin input and return stdout
 */
function execWithInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { timeout: 5000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${cmd} exited with ${code}: ${stderr}`));
      resolve(stdout.trim());
    });
    proc.on('error', reject);
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * Generate a WireGuard keypair
 */
async function generateKeyPair() {
  const { stdout: rawPriv } = await execFileAsync('wg', ['genkey'], { timeout: 5000 });
  const privateKey = rawPriv.trim();
  const publicKey = await execWithInput('wg', ['pubkey'], privateKey);
  return { privateKey, publicKey };
}

/**
 * Generate a WireGuard preshared key
 */
async function generatePresharedKey() {
  const { stdout } = await execFileAsync('wg', ['genpsk'], { timeout: 5000 });
  return stdout.trim();
}

/**
 * Derive public key from private key
 */
async function derivePublicKey(privateKey) {
  return execWithInput('wg', ['pubkey'], privateKey);
}

/**
 * Encrypt a value using AES-256-GCM
 */
function encrypt(plaintext) {
  const key = config.encryption.key;
  if (!key) {
    throw new Error('GC_ENCRYPTION_KEY is not set — cannot store sensitive data unencrypted');
  }

  const keyBuf = Buffer.from(key, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypt a value encrypted with AES-256-GCM
 */
function decrypt(ciphertext) {
  const key = config.encryption.key;
  if (!key) {
    throw new Error('GC_ENCRYPTION_KEY is not set — cannot decrypt data');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');
  const [ivHex, tagHex, encHex] = parts;
  if (ivHex.length !== 24) throw new Error('Invalid IV length');
  if (tagHex.length !== 32) throw new Error('Invalid auth tag length');
  if (!encHex || encHex.length === 0) throw new Error('Empty ciphertext');

  const keyBuf = Buffer.from(key, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  let decrypted = decipher.update(encHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- ECDH + AES-256-GCM (E2EE for RDP credentials) ------------

/**
 * Encrypt plaintext for a client using ephemeral ECDH key agreement.
 *
 * Flow:
 *  1. Server generates ephemeral ECDH keypair (prime256v1)
 *  2. Derives shared secret with client's public key
 *  3. Derives AES-256 key via HKDF-SHA256
 *  4. Encrypts plaintext with AES-256-GCM
 *
 * @param {string} plaintext - Data to encrypt (typically JSON string)
 * @param {string} clientPublicKeyBase64 - Client's ephemeral ECDH public key (base64, uncompressed P-256 point)
 * @returns {{ data: string, iv: string, authTag: string, serverPublicKey: string }} All base64-encoded
 */
// X.509 SubjectPublicKeyInfo header for P-256 uncompressed point (26 bytes)
const P256_SPKI_HEADER = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'
);

/**
 * Convert a raw 65-byte uncompressed P-256 point to X.509 SPKI encoding (91 bytes).
 * Java/Android KeyFactory.generatePublic() requires X.509 format.
 */
function rawToSpki(rawPub) {
  return Buffer.concat([P256_SPKI_HEADER, rawPub]);
}

/**
 * Extract the 65-byte raw uncompressed point from an X.509 SPKI-encoded P-256 key.
 */
function spkiToRaw(spkiBuf) {
  if (spkiBuf.length === 91) {
    return spkiBuf.subarray(spkiBuf.length - 65);
  }
  return spkiBuf; // already raw
}

function ecdhEncrypt(plaintext, clientPublicKeyBase64) {
  const clientPubOriginal = Buffer.from(clientPublicKeyBase64, 'base64');

  // Accept both raw uncompressed (65 bytes) and X.509/SPKI-encoded (91 bytes).
  // Java/Android sends X.509; Node.js clients send raw.
  let clientPubRaw;
  let clientIsSpki = false;
  if (clientPubOriginal.length === 91) {
    clientPubRaw = spkiToRaw(clientPubOriginal);
    clientIsSpki = true;
  } else {
    clientPubRaw = clientPubOriginal;
  }

  if (clientPubRaw.length !== 65 || clientPubRaw[0] !== 0x04) {
    throw new Error(`Invalid ECDH public key: expected 65-byte uncompressed P-256 point, got ${clientPubRaw.length} bytes`);
  }

  // 1. Ephemeral server ECDH keypair
  const serverEcdh = crypto.createECDH('prime256v1');
  serverEcdh.generateKeys();

  // 2. Shared secret (always uses raw key bytes)
  const sharedSecret = serverEcdh.computeSecret(clientPubRaw);

  // 3. Derive AES-256 key via HKDF
  //    salt = clientPub || serverPub  (binds both parties)
  //    info = protocol identifier     (domain separation)
  //
  //    CRITICAL: salt must use the SAME key encoding the client uses.
  //    - Android (Java) uses X.509/SPKI-encoded keys (.encoded → 91 bytes)
  //    - Node.js uses raw uncompressed keys (65 bytes)
  //    If the client sent X.509, we use X.509 for both keys in the salt.
  //    If the client sent raw, we use raw for both.
  const serverPubRaw = serverEcdh.getPublicKey();
  const clientPubForSalt = clientIsSpki ? clientPubOriginal : clientPubRaw;
  const serverPubForSalt = clientIsSpki ? rawToSpki(serverPubRaw) : serverPubRaw;
  const salt = Buffer.concat([clientPubForSalt, serverPubForSalt]);
  const aesKey = crypto.hkdfSync('sha256', sharedSecret, salt, 'gatecontrol-rdp-e2ee-v1', 32);

  // 4. AES-256-GCM encrypt
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Return server public key in the same format the client uses:
  // X.509/SPKI for Java/Android, raw for Node.js clients.
  const serverPubKeyForResponse = clientIsSpki
    ? rawToSpki(serverPubRaw).toString('base64')
    : serverEcdh.getPublicKey('base64');

  return {
    data: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    serverPublicKey: serverPubKeyForResponse,
  };
}

/**
 * Decrypt data that was encrypted with ecdhEncrypt (for testing / server-side use).
 *
 * @param {{ data: string, iv: string, authTag: string, serverPublicKey: string }} encrypted
 * @param {object} clientEcdh - The client's ECDH object (from crypto.createECDH)
 * @returns {string} Decrypted plaintext
 */
function ecdhDecrypt(encrypted, clientEcdh) {
  const serverPubBuf = Buffer.from(encrypted.serverPublicKey, 'base64');
  const sharedSecret = clientEcdh.computeSecret(serverPubBuf);

  const clientPubBuf = clientEcdh.getPublicKey();
  const salt = Buffer.concat([clientPubBuf, serverPubBuf]);
  const aesKey = crypto.hkdfSync('sha256', sharedSecret, salt, 'gatecontrol-rdp-e2ee-v1', 32);

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(aesKey),
    Buffer.from(encrypted.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// --- Asymmetric Encryption (RSA-OAEP) -------------------------

const fs = require('node:fs');
const path = require('node:path');

const KEYPAIR_DIR = process.env.GC_DATA_DIR || '/data';
const PUBKEY_PATH = path.join(KEYPAIR_DIR, '.rdp-pubkey.pem');
const PRIVKEY_PATH = path.join(KEYPAIR_DIR, '.rdp-privkey.pem');

function getOrCreateKeypair() {
  if (fs.existsSync(PUBKEY_PATH) && fs.existsSync(PRIVKEY_PATH)) {
    return {
      publicKey: fs.readFileSync(PUBKEY_PATH, 'utf8'),
      privateKey: fs.readFileSync(PRIVKEY_PATH, 'utf8'),
    };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  if (!fs.existsSync(KEYPAIR_DIR)) fs.mkdirSync(KEYPAIR_DIR, { recursive: true });
  fs.writeFileSync(PUBKEY_PATH, publicKey, { mode: 0o644 });
  fs.writeFileSync(PRIVKEY_PATH, privateKey, { mode: 0o600 });
  return { publicKey, privateKey };
}

function getServerPublicKey() {
  const { publicKey } = getOrCreateKeypair();
  return publicKey;
}

function publicKeyEncrypt(plaintext, publicKeyPem) {
  const encrypted = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plaintext, 'utf8')
  );
  return encrypted.toString('base64');
}

function privateKeyDecrypt(ciphertext) {
  const { privateKey } = getOrCreateKeypair();
  const decrypted = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(ciphertext, 'base64')
  );
  return decrypted.toString('utf8');
}

/**
 * Rotate the master encryption key. Placeholder implementation: for the
 * home-gateway-companion feature we only need the side-effect of marking all
 * gateway_meta rows `needs_repair=1` so the admin re-pairs each gateway with
 * fresh push-tokens encrypted under the new key.
 *
 * Full re-encryption of peer keys is out of scope for Plan 2 and would be
 * implemented here alongside key versioning in a dedicated rotation workflow.
 */
function rotateMasterKey() {
  const { getDb } = require('../db/connection');
  const logger = require('./logger');
  const db = getDb();

  // Mark all gateways as needing re-pairing — push_token_encrypted was
  // encrypted under the old master key and can't be decrypted after rotation.
  db.prepare('UPDATE gateway_meta SET needs_repair=1').run();

  const count = db.prepare('SELECT COUNT(*) AS n FROM gateway_meta').get().n;
  logger.warn({ count }, 'Master key rotated — all gateways marked needs_repair');
}

module.exports = {
  generateKeyPair,
  generatePresharedKey,
  derivePublicKey,
  encrypt,
  decrypt,
  ecdhEncrypt,
  ecdhDecrypt,
  getServerPublicKey,
  publicKeyEncrypt,
  privateKeyDecrypt,
  getOrCreateKeypair,
  rotateMasterKey,
};
