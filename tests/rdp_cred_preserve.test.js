// tests/rdp_cred_preserve.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const rdp = require('../src/services/rdp');

before(async () => { await setup(); });
after(() => teardown());

describe('credential preservation on partial update', () => {
  it('PATCH without ssh_private_key preserves the stored key', async () => {
    const r = await rdp.create({ name: 's', host: '10.0.0.5', protocol: 'ssh', port: 22, username: 'u', ssh_private_key: 'PEMBODY' });
    await rdp.update(r.id, { name: 'renamed' });              // no ssh_private_key in patch
    const after = rdp.getById(r.id, false, { credFlags: true });
    assert.equal(after.has_ssh_private_key, true, 'key wiped on unrelated update');
  });
  it('PATCH with ssh_private_key="" CLEARS it (explicit clear is intentional)', async () => {
    const r = await rdp.create({ name: 's2', host: '10.0.0.6', protocol: 'ssh', port: 22, username: 'u', ssh_private_key: 'PEMBODY' });
    await rdp.update(r.id, { ssh_private_key: '' });
    const after = rdp.getById(r.id, false, { credFlags: true });
    assert.equal(after.has_ssh_private_key, false, 'key should be cleared on explicit empty-string PATCH');
  });
});
