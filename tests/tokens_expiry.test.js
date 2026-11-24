'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.NODE_ENV = 'test';
// Die Test-DB liegt in os.tmpdir(), nicht im Repo-Baum: die CI checkt
// unprivilegiert aus und der lokale Lauf mountet /app read-only —
// eine DB neben den Testdateien schlägt dort fehl (und nur dort).
const testDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-tokexp-')), 'test.db');
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

describe('tokens.authenticate — last_used_at at most once a minute', () => {
  it('writes last_used_at on first use and again only when it is a minute old', () => {
    const { rawToken, token } = tokens.create({ name: 'last-used', scopes: ['read-only'] }, '1.1.1.1');
    const read = () => getDb().prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(token.id).last_used_at;
    assert.equal(read(), null);
    assert.ok(tokens.authenticate(rawToken));
    const first = read();
    assert.ok(first, 'set at the first use');
    // a use shortly after: no write (an old value that is still recent stays)
    getDb().prepare("UPDATE api_tokens SET last_used_at = datetime('now', '-30 seconds') WHERE id = ?").run(token.id);
    const recent = read();
    let writes = 0;
    const orig = getDb().prepare.bind(getDb());
    const db = getDb();
    db.prepare = (sql) => { if (/UPDATE api_tokens SET last_used_at/.test(sql)) writes++; return orig(sql); };
    try {
      assert.ok(tokens.authenticate(rawToken));
      assert.equal(writes, 0, 'no write within the minute');
      assert.equal(read(), recent);
      // a minute old → written again
      db.prepare = orig;
      getDb().prepare("UPDATE api_tokens SET last_used_at = datetime('now', '-61 seconds') WHERE id = ?").run(token.id);
      const old = read();
      assert.ok(tokens.authenticate(rawToken));
      assert.notEqual(read(), old, 'refreshed after a minute');
    } finally { delete db.prepare; }
  });
});
