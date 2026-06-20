'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const rdp = require('../src/services/rdp');

describe('stripSensitive phase2b', () => {
  it('drops all *_encrypted fields, keeps non-sensitive ones', () => {
    const row = { id: 1, name: 'r', host: 'h', port: 22,
      username_encrypted: 'x', password_encrypted: 'x',
      ssh_private_key_encrypted: 'x', ssh_passphrase_encrypted: 'x',
      sftp_password_encrypted: 'x', sftp_private_key_encrypted: 'x', sftp_passphrase_encrypted: 'x',
      rdp_disable_audio: null };
    const safe = rdp.stripSensitive(row);
    for (const k of Object.keys(safe)) assert.ok(!k.endsWith('_encrypted'), 'leaked ' + k);
    assert.ok('rdp_disable_audio' in safe);   // non-sensitive kept
  });
});
