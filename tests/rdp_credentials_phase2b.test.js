'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { encryptCredentials, decryptCredentials } = require('../src/services/rdpCredentials');

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\nline2==\n-----END OPENSSH PRIVATE KEY-----';

describe('rdpCredentials phase2b', () => {
  it('round-trips ssh key + passphrase + sftp creds', () => {
    const enc = encryptCredentials({ username: 'u', ssh_private_key: PEM, ssh_passphrase: 'pp', sftp_password: 'sp' });
    assert.ok(enc.ssh_private_key_encrypted && enc.ssh_passphrase_encrypted && enc.sftp_password_encrypted);
    const dec = decryptCredentials(enc);
    assert.equal(dec.ssh_private_key, PEM);
    assert.equal(dec.ssh_passphrase, 'pp');
    assert.equal(dec.sftp_password, 'sp');
    assert.equal(dec.decrypt_failed, false);
    assert.equal(dec.decrypt_failed_fields.size, 0);
  });
  it('legacy decrypt_failed reflects ONLY username/password (not optional ssh/sftp)', () => {
    const enc = encryptCredentials({ username: 'u', password: 'p', sftp_password: 's' });
    enc.sftp_password_encrypted = 'not-valid-ciphertext';           // corrupt an OPTIONAL field
    const dec = decryptCredentials(enc);
    assert.equal(dec.decrypt_failed, false, 'username/password still ok → legacy flag false');
    assert.ok(dec.decrypt_failed_fields.has('sftp_password'), 'optional failure tracked separately');
  });
  it('decrypt_failed true when the main password is corrupt', () => {
    const enc = encryptCredentials({ username: 'u', password: 'p' });
    enc.password_encrypted = 'broken';
    const dec = decryptCredentials(enc);
    assert.equal(dec.decrypt_failed, true);
    assert.ok(dec.decrypt_failed_fields.has('password'));
  });
});
