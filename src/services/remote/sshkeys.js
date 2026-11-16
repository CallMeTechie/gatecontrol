'use strict';

// SSH keys of gc.remote (stage 3): a new ed25519 pair for gc.remote.vault.generate and the
// fingerprint of a host key for pinning (hostKeys.js). Plain node:crypto, no ssh-keygen:
//
//   * the private key in the OpenSSH format ("openssh-key-v1", unencrypted — it only ever lives
//     encrypted in the vault), which ssh2 and guacd (libssh2) both read;
//   * the public key as one authorized_keys line ("ssh-ed25519 AAAA… <comment>");
//   * a fingerprint like `ssh-keygen -l`: SHA-256 over the key blob, base64 without padding.

const crypto = require('node:crypto');

const COMMENT_RE = /[^A-Za-z0-9 ._@:+-]/g;

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function sshString(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([u32(b.length), b]);
}

/** A comment for the key line: printable ASCII only, at most 80 characters. */
function cleanComment(c) {
  return String(c == null ? '' : c).replace(COMMENT_RE, '').trim().slice(0, 80) || 'gatecontrol';
}

/**
 * A new ed25519 key pair → { privateKey, publicKey, fingerprint }.
 * privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----…" (no passphrase); publicKey: one authorized_keys line.
 */
function generateEd25519(comment) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const note = cleanComment(comment);
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = crypto.randomBytes(4);
  let secret = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(note)]);
  const pad = [];
  for (let i = 1; (secret.length + pad.length) % 8 !== 0; i++) pad.push(i);
  secret = Buffer.concat([secret, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString('none'), sshString('none'), sshString(Buffer.alloc(0)),
    u32(1), sshString(blob), sshString(secret),
  ]).toString('base64');
  const lines = body.match(/.{1,70}/g) || [];
  return {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n' + lines.join('\n') + '\n-----END OPENSSH PRIVATE KEY-----\n',
    publicKey: 'ssh-ed25519 ' + blob.toString('base64') + ' ' + note,
    fingerprint: fingerprint(blob),
  };
}

/** The algorithm named at the start of a key blob ("ssh-ed25519", "ecdsa-sha2-nistp256", …) or null. */
function algOf(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 5) return null;
  const n = blob.readUInt32BE(0);
  if (n < 1 || n > 64 || 4 + n > blob.length) return null;
  const s = blob.subarray(4, 4 + n).toString('latin1');
  return /^[a-z0-9@._-]+$/i.test(s) ? s : null;
}

/** { alg, sha256 } of a host key blob — sha256 as `ssh-keygen -l` prints it after "SHA256:". */
function fingerprint(blob) {
  return {
    alg: algOf(blob) || 'unknown',
    sha256: crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''),
  };
}

const SHA256_RE = /^[A-Za-z0-9+/]{43}$/;
const ALG_RE = /^[a-z0-9@._-]{3,64}$/i;

module.exports = { generateEd25519, fingerprint, algOf, cleanComment, SHA256_RE, ALG_RE };
