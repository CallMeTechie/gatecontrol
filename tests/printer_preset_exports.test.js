'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
describe('orchestrator-required exports', () => {
  it('serviceBundle exports normalizeInput', () => {
    const sb = require('../src/services/serviceBundle');
    assert.equal(typeof sb.normalizeInput, 'function');
  });
  it('routes exports assertDomainAvailable', () => {
    const r = require('../src/services/routes');
    assert.equal(typeof r.assertDomainAvailable, 'function');
  });
});
// R1-G9: assertNoExistingConflicts is NOT exported — the orchestrator allocates
// collision-free print ports itself (Task 4), so a DB conflict pre-check is redundant.
