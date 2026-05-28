'use strict';

// Regression tests for the timestamp-format expiry bug: expires_at columns are
// stored via toISOString() ('...T...Z'), so comparing them against
// datetime('now') ('YYYY-MM-DD HH:MM:SS') as a raw string made same-day
// timestamps always sort as "not expired" (the 'T' at char 10 > ' '). The fix
// wraps the column in datetime() so both sides are normalised before comparison.

process.env.NODE_ENV = 'test';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const testDbPath = path.join(__dirname, `test-auth-expiry-${Date.now()}.db`);
process.env.GC_DB_PATH = testDbPath;
process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GC_LOG_LEVEL = 'silent';

delete require.cache[require.resolve('../config/default')];

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrations');

const HOUR = 3600 * 1000;
let routeId;

before(() => {
  runMigrations();
  const info = getDb()
    .prepare("INSERT INTO routes (domain, target_ip, target_port) VALUES ('expiry.test', '10.0.0.1', 80)")
    .run();
  routeId = Number(info.lastInsertRowid);
});

after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(testDbPath + suffix); } catch {}
  }
});

const routeAuth = require('../src/services/routeAuth');
const shareLinks = require('../src/services/shareLinks');

describe('routeAuth.verifySession — expiry', () => {
  it('verifies a non-expired session', () => {
    const { id } = routeAuth.createSession(routeId, 'a@b.c', '1.1.1.1', HOUR);
    assert.ok(routeAuth.verifySession(id, routeId), 'fresh session should verify');
  });

  it('rejects an expired session', () => {
    // Negative maxAge → expires_at in the past, created via the real API.
    const { id } = routeAuth.createSession(routeId, 'a@b.c', '1.1.1.1', -HOUR);
    assert.ok(!routeAuth.verifySession(id, routeId), 'expired session must be rejected');
  });
});

describe('routeAuth cleanup — expired sessions', () => {
  it('removes expired sessions and keeps valid ones', () => {
    getDb().prepare('DELETE FROM route_auth_sessions').run();
    const valid = routeAuth.createSession(routeId, 'v@b.c', '1.1.1.1', HOUR);
    const expired = routeAuth.createSession(routeId, 'e@b.c', '1.1.1.1', -HOUR);
    routeAuth._runCleanupForTest();
    const ids = getDb().prepare('SELECT id FROM route_auth_sessions').all().map(r => r.id);
    assert.ok(ids.includes(valid.id), 'valid session must survive cleanup');
    assert.ok(!ids.includes(expired.id), 'expired session must be cleaned up');
  });
});

describe('routeAuth.verifyOtp — expiry', () => {
  it('rejects an expired OTP', () => {
    const code = '123456';
    const past = new Date(Date.now() - HOUR).toISOString();
    getDb()
      .prepare('INSERT INTO route_auth_otp (route_id, code_hash, email, expires_at) VALUES (?, ?, ?, ?)')
      .run(routeId, routeAuth.hashOtp(code), 'otp-exp@b.c', past);
    assert.equal(routeAuth.verifyOtp(routeId, 'otp-exp@b.c', code), false, 'expired OTP must be rejected');
  });

  it('accepts a non-expired OTP', () => {
    const code = '654321';
    const future = new Date(Date.now() + HOUR).toISOString();
    getDb()
      .prepare('INSERT INTO route_auth_otp (route_id, code_hash, email, expires_at) VALUES (?, ?, ?, ?)')
      .run(routeId, routeAuth.hashOtp(code), 'otp-ok@b.c', future);
    assert.equal(routeAuth.verifyOtp(routeId, 'otp-ok@b.c', code), true, 'valid OTP must be accepted');
  });
});

describe('shareLinks — expiry', () => {
  it('redeems a non-expired share link', () => {
    const { token } = shareLinks.createShareLink(routeId, { expiresInHours: 24 });
    assert.ok(shareLinks.redeemShareLink(token, '1.1.1.1'), 'fresh share link should redeem');
  });

  it('refuses to redeem an expired share link', () => {
    // Negative expiresInHours → expires_at in the past.
    const { token } = shareLinks.createShareLink(routeId, { expiresInHours: -1 });
    assert.equal(shareLinks.redeemShareLink(token, '1.1.1.1'), null, 'expired share link must not redeem');
  });

  it('excludes expired links from listShareLinks', () => {
    const before = shareLinks.listShareLinks(routeId).length;
    shareLinks.createShareLink(routeId, { expiresInHours: -1, label: 'stale' });
    const after = shareLinks.listShareLinks(routeId);
    assert.equal(after.length, before, 'expired link must not appear in active list');
    assert.ok(!after.some(l => l.label === 'stale'));
  });
});
