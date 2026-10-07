'use strict';

// Package signatures (docs/plugins.md "Signatur").
//
// The file `signature` inside a package is JSON:
//   { "v": 1, "alg": "Ed25519", "publicKey": "<base64 raw 32 bytes>", "sig": "<base64 64 bytes>" }
// signed over the canonical manifest of every OTHER file:
//   "GCPLUGIN-MANIFEST-V1\n" + for each path in byte order: "<sha256 hex> <path>\n"
//
// verify() results:
//   none       no signature file                            → unsigned
//   trusted    valid signature by a trusted publisher key   → "Verifiziert", first-party
//   untrusted  valid signature by a key we do not trust     → treated as unsigned
//   invalid    signature file present but it does not verify (or is malformed)
//              → the package was changed after signing: ALWAYS rejected

const crypto = require('node:crypto');
const { BUILTIN_PUBLIC_KEYS } = require('./constants');

const SIGNATURE_FILE = 'signature';
const HEADER = 'GCPLUGIN-MANIFEST-V1\n';
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

function canonicalManifest(files) {
  const paths = [...files.keys()].filter((p) => p !== SIGNATURE_FILE).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let out = HEADER;
  for (const p of paths) out += crypto.createHash('sha256').update(files.get(p)).digest('hex') + ' ' + p + '\n';
  return Buffer.from(out, 'utf8');
}

function publicKeyFromRaw(b64) {
  if (typeof b64 !== 'string' || !B64_32.test(b64)) throw new Error('invalid public key');
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('invalid public key');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

function rawFromPublicKey(key) {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Private key from a base64 32-byte seed or a PEM string. */
function privateKeyFrom(material) {
  const s = String(material || '').trim();
  if (!s) throw new Error('no signing key');
  if (s.includes('-----BEGIN')) {
    const key = crypto.createPrivateKey(s);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('signing key is not Ed25519');
    return key;
  }
  const seed = Buffer.from(s, 'base64');
  if (seed.length !== 32) throw new Error('signing key must be a base64 32-byte seed or a PEM');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** Trusted publisher keys: built-in list + GC_PLUGIN_PUBKEYS (JSON array of base64 raw keys). */
function trustedKeys() {
  const out = [...BUILTIN_PUBLIC_KEYS];
  const env = process.env.GC_PLUGIN_PUBKEYS;
  if (env && env.trim()) {
    try {
      const list = JSON.parse(env);
      if (Array.isArray(list)) for (const k of list) if (typeof k === 'string' && B64_32.test(k.trim())) out.push(k.trim());
    } catch { /* an unparsable value trusts nothing extra */ }
  }
  return [...new Set(out)];
}

/** Add a `signature` file to `files` (Map), signed with `privateKey`. */
function sign(files, privateKey) {
  const key = privateKey instanceof crypto.KeyObject ? privateKey : privateKeyFrom(privateKey);
  const pub = crypto.createPublicKey(key);
  const sig = crypto.sign(null, canonicalManifest(files), key);
  const out = new Map(files);
  out.set(SIGNATURE_FILE, Buffer.from(JSON.stringify({ v: 1, alg: 'Ed25519', publicKey: rawFromPublicKey(pub), sig: sig.toString('base64') }), 'utf8'));
  return out;
}

function keyId(b64) {
  return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);
}

/**
 * @param {Map<string,Buffer>} files
 * @returns {{status:'none'|'trusted'|'untrusted'|'invalid', publicKey?:string, keyId?:string}}
 */
function verify(files) {
  const sf = files.get(SIGNATURE_FILE);
  if (!sf) return { status: 'none' };
  let doc;
  try { doc = JSON.parse(sf.toString('utf8')); } catch { return { status: 'invalid' }; }
  if (!doc || doc.v !== 1 || doc.alg !== 'Ed25519' || typeof doc.sig !== 'string' || typeof doc.publicKey !== 'string') return { status: 'invalid' };
  let key;
  try { key = publicKeyFromRaw(doc.publicKey); } catch { return { status: 'invalid' }; }
  const sig = Buffer.from(doc.sig, 'base64');
  let ok = false;
  try { ok = sig.length === 64 && crypto.verify(null, canonicalManifest(files), key, sig); } catch { ok = false; }
  if (!ok) return { status: 'invalid' };
  const trusted = trustedKeys().includes(doc.publicKey);
  return { status: trusted ? 'trusted' : 'untrusted', publicKey: doc.publicKey, keyId: keyId(doc.publicKey) };
}

/** A new key pair: { privateSeed (base64 32), publicKey (base64 32) }. */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { privateSeed: der.subarray(der.length - 32).toString('base64'), publicKey: rawFromPublicKey(publicKey) };
}

module.exports = { SIGNATURE_FILE, canonicalManifest, sign, verify, trustedKeys, privateKeyFrom, publicKeyFromRaw, generateKeyPair, keyId };
