'use strict';

// Re-key a JSON backup from the GC_ENCRYPTION_KEY it was written under to the
// key of the installation that restores it (off-site archives with
// include_key, docs/feature-release-b.md §7).
//
// Every secret GateControl stores goes through utils/crypto.encrypt() and has
// the shape "<iv 24 hex>:<tag 32 hex>:<ciphertext hex>". Instead of keeping a
// list of encrypted columns in sync with the schema, walk the whole backup and
// convert every string of exactly that shape which decrypts under the old key.
// The GCM tag makes a false positive impossible in practice: a string that
// merely looks like a ciphertext fails authentication and stays untouched.

const crypto = require('node:crypto');

const CT_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

function decryptWith(keyHex, ciphertext) {
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return d.update(encHex, 'hex', 'utf8') + d.final('utf8');
}

function encryptWith(keyHex, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  let enc = c.update(plaintext, 'utf8', 'hex');
  enc += c.final('hex');
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc}`;
}

/**
 * Returns a deep copy of `backup` with all secrets re-encrypted. Counts are
 * for logging only (never the values).
 *
 * @param {object} backup
 * @param {string} fromKeyHex
 * @param {string} toKeyHex
 * @returns {{ backup: object, converted: number }}
 */
function rekeyBackup(backup, fromKeyHex, toKeyHex) {
  if (!/^[0-9a-f]{64}$/i.test(fromKeyHex || '') || !/^[0-9a-f]{64}$/i.test(toKeyHex || '')) {
    throw new Error('rekey: keys must be 64 hex characters');
  }
  let converted = 0;
  const same = fromKeyHex.toLowerCase() === toKeyHex.toLowerCase();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (same || v.length > 1024 * 1024 || !CT_RE.test(v)) return v;
      let plain;
      try { plain = decryptWith(fromKeyHex, v); } catch { return v; }
      converted++;
      return encryptWith(toKeyHex, plain);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { backup: walk(backup), converted };
}

module.exports = { rekeyBackup, decryptWith, encryptWith };
