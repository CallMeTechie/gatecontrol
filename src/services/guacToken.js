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

function mint(settingsObject, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const jti = crypto.randomUUID();
  const exp = Date.now() + ttlMs;
  const connection = { ...settingsObject, jti, exp };
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify({ connection }), 'utf8'), cipher.final()]);
  const inner = JSON.stringify({ iv: iv.toString('base64'), value: enc.toString('base64') });
  const tokenStr = Buffer.from(inner, 'utf8').toString('base64');
  if (ttlMs > 0) nonce.register(jti, exp);   // negative ttl (tests) → don't register; still expired
  return { token: tokenStr, jti, ttlMs };
}

function verifyAndConsume(tokenStr) {
  try {
    const inner = JSON.parse(Buffer.from(String(tokenStr), 'base64').toString('utf8'));
    if (!inner || typeof inner.iv !== 'string' || typeof inner.value !== 'string') return null;
    const key = deriveKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(inner.iv, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(inner.value, 'base64')), decipher.final()]);
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
