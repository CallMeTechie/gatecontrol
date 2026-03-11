'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// Setup test environment
const testDbPath = path.join(__dirname, `test-activity-${Date.now()}.db`);
process.env.GC_DB_PATH = testDbPath;
process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GC_LOG_LEVEL = 'silent';

// Clear cached config
delete require.cache[require.resolve('../config/default')];

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrations');

// Initialize DB before tests
before(() => {
  runMigrations();
});

after(() => {
  closeDb();
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch {}
});

// Require after DB setup
const activity = require('../src/services/activity');

describe('activity.sanitizeIp (via log)', () => {
  it('stores valid IPv4 addresses', () => {
    activity.log('test', 'test msg', { ipAddress: '192.168.1.1' });
    const entries = activity.getRecent(1);
    assert.equal(entries[0].ip_address, '192.168.1.1');
  });

  it('stores valid IPv6 addresses', () => {
    activity.log('test', 'ipv6 test', { ipAddress: '2001:db8::1' });
    const entries = activity.getRecent(1);
    assert.equal(entries[0].ip_address, '2001:db8::1');
  });

  it('strips ::ffff: prefix from IPv6-mapped IPv4', () => {
    activity.log('test', 'mapped test', { ipAddress: '::ffff:10.0.0.1' });
    const entries = activity.getRecent(1);
    assert.equal(entries[0].ip_address, '10.0.0.1');
  });

  it('rejects malicious payloads in IP field', () => {
    activity.log('test', 'xss test', { ipAddress: '<script>alert(1)</script>' });
    const entries = activity.getRecent(1);
    assert.equal(entries[0].ip_address, null);
  });

  it('rejects arbitrary strings', () => {
    activity.log('test', 'bad ip', { ipAddress: 'not-an-ip-address' });
    const entries = activity.getRecent(1);
    assert.equal(entries[0].ip_address, null);
  });

  it('handles null/undefined gracefully', () => {
    activity.log('test', 'null ip', { ipAddress: null });
    const entries = activity.getRecent(1);
    assert.equal(entries[0].ip_address, null);
  });
});

describe('activity.log', () => {
  it('stores event type, message and severity', () => {
    activity.log('peer_created', 'New peer added', { severity: 'success', source: 'admin' });
    const entries = activity.getRecent(1);
    assert.equal(entries[0].event_type, 'peer_created');
    assert.equal(entries[0].message, 'New peer added');
    assert.equal(entries[0].severity, 'success');
    assert.equal(entries[0].source, 'admin');
  });

  it('stores JSON details', () => {
    activity.log('test_details', 'detail test', { details: { key: 'value', count: 42 } });
    const entries = activity.getRecent(1);
    assert.deepEqual(entries[0].details, { key: 'value', count: 42 });
  });

  it('defaults to info severity and system source', () => {
    activity.log('test_defaults', 'default test');
    const entries = activity.getRecent(1);
    assert.equal(entries[0].severity, 'info');
    assert.equal(entries[0].source, 'system');
  });
});

describe('activity.getPaginated', () => {
  before(() => {
    // Insert enough entries for pagination
    for (let i = 0; i < 10; i++) {
      activity.log('pagination_test', `entry ${i}`);
    }
  });

  it('returns paginated results', () => {
    const result = activity.getPaginated(1, 5);
    assert.equal(result.entries.length, 5);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 5);
    assert.ok(result.total >= 10);
    assert.ok(result.totalPages >= 2);
  });

  it('returns correct page 2', () => {
    const result = activity.getPaginated(2, 5);
    assert.equal(result.page, 2);
    assert.ok(result.entries.length > 0);
  });
});

describe('activity.getCount', () => {
  it('returns a positive count', () => {
    const count = activity.getCount();
    assert.ok(count > 0);
  });
});
