'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Set encryption key before requiring crypto module
const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

// Clear cached config so it picks up the new env var
delete require.cache[require.resolve('../config/default')];
const { encrypt, decrypt } = require('../src/utils/crypto');

describe('encrypt / decrypt', () => {
  it('roundtrips a string', () => {
    const plaintext = 'my-secret-private-key-12345';
    const ciphertext = encrypt(plaintext);
    assert.notEqual(ciphertext, plaintext);
    assert.equal(decrypt(ciphertext), plaintext);
  });

  it('produces different ciphertexts for same input (random IV)', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    assert.notEqual(a, b);
    assert.equal(decrypt(a), plaintext);
    assert.equal(decrypt(b), plaintext);
  });

  it('ciphertext has correct format (iv:tag:data)', () => {
    const ciphertext = encrypt('test');
    const parts = ciphertext.split(':');
    assert.equal(parts.length, 3);
    assert.equal(parts[0].length, 24); // 12 bytes = 24 hex chars
    assert.equal(parts[1].length, 32); // 16 bytes = 32 hex chars
    assert.ok(parts[2].length > 0);
  });

  it('throws on invalid ciphertext', () => {
    assert.throws(() => decrypt('not-valid-ciphertext'), /Invalid ciphertext/);
    assert.throws(() => decrypt('aaa:bbb'), /Invalid ciphertext/);
  });

  it('throws on tampered ciphertext', () => {
    const ciphertext = encrypt('secret');
    const parts = ciphertext.split(':');
    parts[2] = 'ff' + parts[2].slice(2); // tamper with encrypted data
    assert.throws(() => decrypt(parts.join(':')));
  });

  it('handles unicode', () => {
    const plaintext = 'Schlüssel mit Ümlauten: äöü ß';
    const ciphertext = encrypt(plaintext);
    assert.equal(decrypt(ciphertext), plaintext);
  });
});
