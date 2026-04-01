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

// --- Asymmetric Encryption (RSA-OAEP) -------------------------

const fs = require('node:fs');
const path = require('node:path');

const KEYPAIR_DIR = '/data';
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

module.exports = {
  generateKeyPair,
  generatePresharedKey,
  derivePublicKey,
  encrypt,
  decrypt,
  getServerPublicKey,
  publicKeyEncrypt,
  privateKeyDecrypt,
  getOrCreateKeypair,
};
