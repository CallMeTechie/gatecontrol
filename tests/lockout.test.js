'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// Isolated test DB (node --test runs each file in its own process, so setting
// GC_DB_PATH here is safe and does not collide with other suites).
process.env.NODE_ENV = 'test';
const testDbPath = path.join(__dirname, `test-lockout-${Date.now()}.db`);
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

const lockout = require('../src/services/lockout');
const settings = require('../src/services/settings');

// Clean slate + default lockout settings before every test.
beforeEach(() => {
  getDb().prepare('DELETE FROM login_attempts').run();
  settings.set('security.lockout.enabled', 'true');
  settings.set('security.lockout.max_attempts', '5');
  settings.set('security.lockout.duration', '15');
});

describe('lockout.isLocked — threshold behaviour', () => {
  it('is NOT locked below the max-attempts threshold', () => {
    for (let i = 0; i < 4; i++) lockout.recordFailedAttempt('user-a', 'admin', '1.1.1.1');
    const res = lockout.isLocked('user-a');
    assert.equal(res.locked, false);
    assert.equal(res.remainingSeconds, 0);
  });

  it('locks once attempts reach the threshold', () => {
    for (let i = 0; i < 5; i++) lockout.recordFailedAttempt('user-b', 'admin', '1.1.1.1');
    const res = lockout.isLocked('user-b');
    assert.equal(res.locked, true);
    // 15-minute window, computed from the oldest attempt → ~900s remaining.
    assert.ok(res.remainingSeconds > 880 && res.remainingSeconds <= 900,
      `expected ~900s remaining, got ${res.remainingSeconds}`);
  });

  // Regression guard for the timestamp-format bug: failed_at is stored as
  // datetime('now') ('YYYY-MM-DD HH:MM:SS'); a JS toISOString() cutoff
  // ('...T...Z') sorts before it at char 10 (' ' < 'T'), so the COUNT was
  // always 0 and the lockout never engaged. Attempts recorded "just now" MUST
  // be counted inside the window.
  it('counts attempts recorded just now (timestamp-format regression)', () => {
    for (let i = 0; i < 6; i++) lockout.recordFailedAttempt('user-c', 'admin', '1.1.1.1');
    assert.equal(lockout.isLocked('user-c').locked, true);
  });

  it('keeps identifiers isolated from one another', () => {
    for (let i = 0; i < 5; i++) lockout.recordFailedAttempt('user-d', 'admin', '1.1.1.1');
    lockout.recordFailedAttempt('user-e', 'admin', '2.2.2.2');
    assert.equal(lockout.isLocked('user-d').locked, true);
    assert.equal(lockout.isLocked('user-e').locked, false);
  });
});

describe('lockout.clearAttempts / unlockAccount', () => {
  it('clearAttempts unlocks an identifier', () => {
    for (let i = 0; i < 5; i++) lockout.recordFailedAttempt('user-f', 'admin', '1.1.1.1');
    assert.equal(lockout.isLocked('user-f').locked, true);
    lockout.clearAttempts('user-f');
    assert.equal(lockout.isLocked('user-f').locked, false);
  });

  it('unlockAccount unlocks an identifier', () => {
    for (let i = 0; i < 5; i++) lockout.recordFailedAttempt('user-g', 'admin', '1.1.1.1');
    assert.equal(lockout.isLocked('user-g').locked, true);
    lockout.unlockAccount('user-g');
    assert.equal(lockout.isLocked('user-g').locked, false);
  });
});

describe('lockout.getLockedAccounts', () => {
  it('lists only identifiers at or above the threshold', () => {
    for (let i = 0; i < 5; i++) lockout.recordFailedAttempt('locked-1', 'admin', '1.1.1.1');
    for (let i = 0; i < 2; i++) lockout.recordFailedAttempt('notlocked', 'admin', '2.2.2.2');
    const accounts = lockout.getLockedAccounts();
    const ids = accounts.map(a => a.identifier);
    assert.ok(ids.includes('locked-1'));
    assert.ok(!ids.includes('notlocked'));
    const locked = accounts.find(a => a.identifier === 'locked-1');
    assert.equal(locked.attempts, 5);
    assert.equal(locked.type, 'admin');
    assert.ok(locked.remainingSeconds > 880 && locked.remainingSeconds <= 900);
  });
});

describe('lockout — disabled via settings', () => {
  it('never locks when security.lockout.enabled is false', () => {
    settings.set('security.lockout.enabled', 'false');
    for (let i = 0; i < 20; i++) lockout.recordFailedAttempt('user-h', 'admin', '1.1.1.1');
    assert.equal(lockout.isLocked('user-h').locked, false);
    assert.deepEqual(lockout.getLockedAccounts(), []);
  });

  it('honours a custom max_attempts threshold', () => {
    settings.set('security.lockout.max_attempts', '3');
    for (let i = 0; i < 3; i++) lockout.recordFailedAttempt('user-i', 'admin', '1.1.1.1');
    assert.equal(lockout.isLocked('user-i').locked, true);
  });
});

describe('lockout.cleanup', () => {
  it('removes attempts older than the retention window', () => {
    const db = getDb();
    // Insert an old attempt (2 days ago) and a fresh one.
    db.prepare(`INSERT INTO login_attempts (identifier, type, ip_address, failed_at)
                VALUES ('old', 'admin', '1.1.1.1', datetime('now', '-2 days'))`).run();
    lockout.recordFailedAttempt('fresh', 'admin', '1.1.1.1');
    const removed = lockout.cleanup(1); // keep 1 day
    assert.equal(removed, 1);
    const remaining = db.prepare('SELECT identifier FROM login_attempts').all().map(r => r.identifier);
    assert.ok(remaining.includes('fresh'));
    assert.ok(!remaining.includes('old'));
  });
});
