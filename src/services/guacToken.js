// src/services/guacToken.js
'use strict';
const crypto = require('node:crypto');
const nonce = require('./guacNonceStore');

const DEFAULT_TTL_MS = 60000;

function deriveKey() {
  const master = process.env.GC_ENCRYPTION_KEY;
  if (!master) throw new Error('GC_ENCRYPTION_KEY not set');
  // Distinct context from credential-at-rest: HKDF with a guac-token label.
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(master, 'utf8'),
    Buffer.from('guac-token'), 'guac-token-v1', 32));
}

function deriveMacKey() {
  const master = process.env.GC_ENCRYPTION_KEY;
  if (!master) throw new Error('GC_ENCRYPTION_KEY not set');
  // Distinct info from enc key — ensures mac key is independent.
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(master, 'utf8'),
    Buffer.from('guac-token'), 'guac-token-mac-v1', 32));
}

function mint(settingsObject, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const jti = crypto.randomUUID();
  const exp = Date.now() + ttlMs;
  const connection = { ...settingsObject, jti, exp };
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify({ connection }), 'utf8'), cipher.final()]);
  // Encrypt-then-MAC: HMAC-SHA256 over iv || ciphertext
  const mac = crypto.createHmac('sha256', deriveMacKey())
    .update(Buffer.concat([iv, enc]))
    .digest('base64');
  const inner = JSON.stringify({ iv: iv.toString('base64'), value: enc.toString('base64'), mac });
  const tokenStr = Buffer.from(inner, 'utf8').toString('base64');
  if (ttlMs > 0) nonce.register(jti, exp);   // negative ttl (tests) → don't register; still expired
  return { token: tokenStr, jti, ttlMs };
}

function verifyAndConsume(tokenStr) {
  try {
    const inner = JSON.parse(Buffer.from(String(tokenStr), 'base64').toString('utf8'));
    if (!inner || typeof inner.iv !== 'string' || typeof inner.value !== 'string' || typeof inner.mac !== 'string') return null;
    // Verify HMAC before decrypting (Encrypt-then-MAC)
    const ivBuf = Buffer.from(inner.iv, 'base64');
    const encBuf = Buffer.from(inner.value, 'base64');
    const expected = crypto.createHmac('sha256', deriveMacKey())
      .update(Buffer.concat([ivBuf, encBuf]))
      .digest();
    const provided = Buffer.from(inner.mac, 'base64');
    // Length guard prevents timingSafeEqual from throwing on wrong-length mac
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
    // MAC verified — proceed with decryption
    const key = deriveKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, ivBuf);
    const dec = Buffer.concat([decipher.update(encBuf), decipher.final()]);
    const obj = JSON.parse(dec.toString('utf8'));
    const c = obj && obj.connection;
    if (!c || typeof c.jti !== 'string' || typeof c.exp !== 'number' || typeof c.type !== 'string') return null;
    if (Date.now() >= c.exp) return null;          // expired
    if (!nonce.consume(c.jti)) return null;         // unknown / already used
    return { connection: c, jti: c.jti, exp: c.exp };
  } catch {
    return null;                                    // tampered / malformed → integrity backstop (C5)
  }
}

module.exports = { mint, verifyAndConsume, deriveKey };
