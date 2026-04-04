'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Set required env vars before requiring crypto module
process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
delete require.cache[require.resolve('../config/default')];

const { ecdhEncrypt, ecdhDecrypt } = require('../src/utils/crypto');

describe('ECDH E2EE', () => {
  it('roundtrips a simple string', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();
    const clientPub = clientEcdh.getPublicKey('base64');

    const encrypted = ecdhEncrypt('hello world', clientPub);
    const decrypted = ecdhDecrypt(encrypted, clientEcdh);

    assert.equal(decrypted, 'hello world');
  });

  it('roundtrips a JSON credentials blob', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();

    const credentials = JSON.stringify({
      username: 'admin',
      password: 'P@ssw0rd!',
      domain: 'CORP',
    });

    const encrypted = ecdhEncrypt(credentials, clientEcdh.getPublicKey('base64'));
    const decrypted = ecdhDecrypt(encrypted, clientEcdh);

    assert.equal(decrypted, credentials);
    const parsed = JSON.parse(decrypted);
    assert.equal(parsed.username, 'admin');
    assert.equal(parsed.password, 'P@ssw0rd!');
    assert.equal(parsed.domain, 'CORP');
  });

  it('produces different ciphertexts for same input (ephemeral keys)', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();
    const pub = clientEcdh.getPublicKey('base64');

    const a = ecdhEncrypt('same-input', pub);
    const b = ecdhEncrypt('same-input', pub);

    // Different server ephemeral keys → different ciphertext
    assert.notEqual(a.data, b.data);
    assert.notEqual(a.serverPublicKey, b.serverPublicKey);

    // Both decrypt correctly
    assert.equal(ecdhDecrypt(a, clientEcdh), 'same-input');
    assert.equal(ecdhDecrypt(b, clientEcdh), 'same-input');
  });

  it('returns all required fields as base64', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();

    const encrypted = ecdhEncrypt('test', clientEcdh.getPublicKey('base64'));

    assert.ok(encrypted.data);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.authTag);
    assert.ok(encrypted.serverPublicKey);

    // Validate base64 decodes cleanly
    assert.ok(Buffer.from(encrypted.iv, 'base64').length === 12);
    assert.ok(Buffer.from(encrypted.authTag, 'base64').length === 16);
    assert.ok(Buffer.from(encrypted.serverPublicKey, 'base64').length === 65);
  });

  it('fails with wrong client key', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();

    const wrongEcdh = crypto.createECDH('prime256v1');
    wrongEcdh.generateKeys();

    const encrypted = ecdhEncrypt('secret', clientEcdh.getPublicKey('base64'));

    assert.throws(() => ecdhDecrypt(encrypted, wrongEcdh));
  });

  it('fails with tampered ciphertext', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();

    const encrypted = ecdhEncrypt('secret', clientEcdh.getPublicKey('base64'));
    encrypted.data = Buffer.from('tampered').toString('base64');

    assert.throws(() => ecdhDecrypt(encrypted, clientEcdh));
  });

  it('fails with tampered authTag', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();

    const encrypted = ecdhEncrypt('secret', clientEcdh.getPublicKey('base64'));
    encrypted.authTag = crypto.randomBytes(16).toString('base64');

    assert.throws(() => ecdhDecrypt(encrypted, clientEcdh));
  });

  it('rejects invalid public key (wrong length)', () => {
    assert.throws(
      () => ecdhEncrypt('test', Buffer.from('short').toString('base64')),
      /Invalid ECDH public key/
    );
  });

  it('rejects invalid public key (wrong prefix)', () => {
    const badKey = Buffer.alloc(65, 0);
    badKey[0] = 0x03; // compressed prefix instead of 0x04
    assert.throws(
      () => ecdhEncrypt('test', badKey.toString('base64')),
      /Invalid ECDH public key/
    );
  });

  it('handles unicode credentials', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();

    const plaintext = JSON.stringify({
      username: 'Ädmin',
      password: 'Pässwörd!€',
      domain: null,
    });

    const encrypted = ecdhEncrypt(plaintext, clientEcdh.getPublicKey('base64'));
    assert.equal(ecdhDecrypt(encrypted, clientEcdh), plaintext);
  });

  it('handles empty string', () => {
    const clientEcdh = crypto.createECDH('prime256v1');
    clientEcdh.generateKeys();

    const encrypted = ecdhEncrypt('', clientEcdh.getPublicKey('base64'));
    assert.equal(ecdhDecrypt(encrypted, clientEcdh), '');
  });
});
