'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractBaseDomains, shouldFlagServerIp } = require('../src/services/domainSeed');

test('extractBaseDomains reduces to last-two-labels, distinct, lowercased', () => {
  const out = extractBaseDomains([
    'nas.domaincaster.com', 'foo.bar.domaincaster.com', 'domaincaster.com',
    'a.marcbackes.net', 'MARCBACKES.NET', '', '*.wild.com', null,
  ]);
  assert.deepEqual(out.sort(), ['domaincaster.com', 'marcbackes.net', 'wild.com'].sort());
});

test('shouldFlagServerIp: true only when >=2 and all mismatch', () => {
  assert.equal(shouldFlagServerIp([{ domain: 'a', matched: false }]), false); // n=1
  assert.equal(shouldFlagServerIp([{ domain: 'a', matched: false }, { domain: 'b', matched: false }]), true);
  assert.equal(shouldFlagServerIp([{ domain: 'a', matched: false }, { domain: 'b', matched: true }]), false);
  assert.equal(shouldFlagServerIp([]), false);
});
