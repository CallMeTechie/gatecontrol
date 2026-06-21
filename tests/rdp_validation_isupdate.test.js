'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateRdpRoute } = require('../src/services/rdp');

describe('validateRdpRoute ssh-username isUpdate gating', () => {
  it('create ssh without username → error', () => {
    const e = validateRdpRoute({ name: 'n', host: 'h', protocol: 'ssh' }, false);
    assert.ok(e && e.username);
  });
  it('update ssh patch WITHOUT username field → no username error', () => {
    const e = validateRdpRoute({ protocol: 'ssh', name: 'newname' }, true);
    assert.ok(!e || !e.username);
  });
  it('update ssh patch WITH empty username → error', () => {
    const e = validateRdpRoute({ protocol: 'ssh', username: '' }, true);
    assert.ok(e && e.username);
  });
});
