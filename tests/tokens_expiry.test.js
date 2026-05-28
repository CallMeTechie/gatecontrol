'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
const testDbPath = path.join(__dirname, `test-tokens-expiry-${Date.now()}.db`);
process.env.GC_DB_PATH = testDbPath;
process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GC_LOG_LEVEL = 'silent';

delete require.cache[require.resolve('../config/default')];

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrations');

before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(testDbPath + suffix); } catch {}
  }
});

const tokens = require('../src/services/tokens');

describe('tokens.authenticate — expiry enforcement', () => {
  it('accepts a token with no expiry', () => {
    const { rawToken } = tokens.create({ name: 'no-expiry', scopes: ['read-only'] }, '1.1.1.1');
    const auth = tokens.authenticate(rawToken);
    assert.ok(auth, 'token with null expires_at should authenticate');
    assert.equal(auth.name, 'no-expiry');
  });

  it('accepts a token whose expiry is in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { rawToken } = tokens.create({ name: 'future', scopes: ['read-only'], expiresAt: future }, '1.1.1.1');
    assert.ok(tokens.authenticate(rawToken), 'unexpired token should authenticate');
  });

  it('rejects a token whose expiry has passed', () => {
    // create() refuses past dates, so create valid then backdate expires_at.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { rawToken, token } = tokens.create({ name: 'expired', scopes: ['read-only'], expiresAt: future }, '1.1.1.1');
    getDb().prepare("UPDATE api_tokens SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(token.id);
    assert.equal(tokens.authenticate(rawToken), null, 'expired token must be rejected');
  });

  it('returns null for an unknown / malformed token', () => {
    assert.equal(tokens.authenticate('gc_does_not_exist'), null);
    assert.equal(tokens.authenticate('not-a-gc-token'), null);
    assert.equal(tokens.authenticate(''), null);
    assert.equal(tokens.authenticate(null), null);
  });
});

describe('tokens.create — expiry validation', () => {
  it('rejects an expiry date in the past', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    assert.throws(
      () => tokens.create({ name: 'bad', scopes: ['read-only'], expiresAt: past }, '1.1.1.1'),
      /future/i,
    );
  });
});
