'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// Setup test environment
const testDbPath = path.join(__dirname, `test-users-${Date.now()}.db`);
process.env.GC_DB_PATH = testDbPath;
process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GC_LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

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

const users = require('../src/services/users');

// ─── create() ────────────────────────────────────────────────

describe('users.create()', () => {
  it('should create an admin user with password', async () => {
    const user = await users.create({
      username: 'admin1',
      displayName: 'Admin One',
      role: 'admin',
      password: 'SecurePass123!',
      email: 'admin1@example.com',
    });
    assert.ok(user.id);
    assert.equal(user.username, 'admin1');
    assert.equal(user.display_name, 'Admin One');
    assert.equal(user.role, 'admin');
    assert.equal(user.email, 'admin1@example.com');
    assert.equal(user.password_hash, undefined, 'password_hash must not be exposed');
  });

  it('should create a client user without password', async () => {
    const user = await users.create({
      username: 'client1',
      displayName: 'Client One',
      role: 'user',
      email: 'client1@example.com',
    });
    assert.ok(user.id);
    assert.equal(user.username, 'client1');
    assert.equal(user.role, 'user');
    assert.equal(user.password_hash, undefined);
  });

  it('should reject duplicate username', async () => {
    await assert.rejects(
      () => users.create({ username: 'admin1', role: 'admin', password: 'Pass123!' }),
      { message: 'Username already exists' },
    );
  });

  it('should reject empty username', async () => {
    await assert.rejects(
      () => users.create({ username: '', role: 'admin', password: 'Pass123!' }),
      { message: 'Username is required' },
    );
  });

  it('should reject admin without password', async () => {
    await assert.rejects(
      () => users.create({ username: 'nopwadmin', role: 'admin' }),
      { message: 'Password is required for admin users' },
    );
  });
});

// ─── createClientUser() ──────────────────────────────────────

describe('users.createClientUser()', () => {
  it('should create a client user with role=user and sentinel password', () => {
    const user = users.createClientUser({ username: 'clientsync1', displayName: 'Sync Client' });
    assert.ok(user.id);
    assert.equal(user.role, 'user');
    assert.equal(user.password_hash, undefined);

    // Verify sentinel via internal query
    assert.equal(users.hasPassword(user.id), false);
  });
});

// ─── list() ──────────────────────────────────────────────────

describe('users.list()', () => {
  it('should return all users without password_hash', () => {
    const all = users.list();
    assert.ok(all.length >= 2);
    for (const u of all) {
      assert.equal(u.password_hash, undefined, 'password_hash must not be exposed');
    }
  });
});

// ─── getById() ───────────────────────────────────────────────

describe('users.getById()', () => {
  it('should return user without password_hash', async () => {
    const created = await users.create({
      username: 'getbyid_user',
      role: 'admin',
      password: 'Pass123!',
    });
    const found = users.getById(created.id);
    assert.equal(found.username, 'getbyid_user');
    assert.equal(found.password_hash, undefined);
  });

  it('should return null for nonexistent id', () => {
    const found = users.getById(99999);
    assert.equal(found, null);
  });
});

// ─── update() ────────────────────────────────────────────────

describe('users.update()', () => {
  it('should update display name', async () => {
    const created = await users.create({
      username: 'update_user',
      role: 'admin',
      password: 'Pass123!',
    });
    const updated = users.update(created.id, { displayName: 'New Name' });
    assert.equal(updated.display_name, 'New Name');
  });

  it('should prevent degrading last admin to user', async () => {
    // Delete all admins except admin1 (created earlier) to ensure single admin
    const all = users.list();
    const admins = all.filter((u) => u.role === 'admin');
    // Keep only one admin, remove the rest
    for (let i = 1; i < admins.length; i++) {
      try { users.remove(admins[i].id); } catch {}
    }

    // Now there's exactly 1 admin left
    const remaining = users.list().filter((u) => u.role === 'admin');
    assert.equal(remaining.length, 1, 'Should have exactly 1 admin');

    assert.throws(
      () => users.update(remaining[0].id, { role: 'user' }),
      { message: 'Cannot change role of last admin' },
    );
  });
});

// ─── toggle() ────────────────────────────────────────────────

describe('users.toggle()', () => {
  let toggleUser;

  before(async () => {
    // Create a second admin so we can toggle freely
    toggleUser = await users.create({
      username: 'toggle_admin',
      role: 'admin',
      password: 'Pass123!',
    });
  });

  it('should disable a user', () => {
    const toggled = users.toggle(toggleUser.id);
    assert.equal(toggled.enabled, 0);
  });

  it('should enable a user', () => {
    const toggled = users.toggle(toggleUser.id);
    assert.equal(toggled.enabled, 1);
  });

  it('should prevent disabling last enabled admin', () => {
    // Disable toggle_admin first so only the original admin1 remains enabled
    const all = users.list();
    const enabledAdmins = all.filter((u) => u.role === 'admin' && u.enabled === 1);

    // Disable all admins except the last one
    for (let i = 1; i < enabledAdmins.length; i++) {
      try { users.toggle(enabledAdmins[i].id); } catch {}
    }

    const lastAdmin = users.list().filter((u) => u.role === 'admin' && u.enabled === 1);
    assert.equal(lastAdmin.length, 1, 'Should have exactly 1 enabled admin');

    assert.throws(
      () => users.toggle(lastAdmin[0].id),
      { message: 'Cannot disable last enabled admin' },
    );
  });
});

// ─── remove() ────────────────────────────────────────────────

describe('users.remove()', () => {
  it('should delete a user', () => {
    const user = users.createClientUser({ username: 'to_delete' });
    const result = users.remove(user.id);
    assert.equal(result, true);
    assert.equal(users.getById(user.id), null);
  });

  it('should prevent deleting last admin', () => {
    const admins = users.list().filter((u) => u.role === 'admin');
    // Remove all but one
    for (let i = 1; i < admins.length; i++) {
      try { users.remove(admins[i].id); } catch {}
    }

    const remaining = users.list().filter((u) => u.role === 'admin');
    assert.equal(remaining.length, 1);

    assert.throws(
      () => users.remove(remaining[0].id),
      { message: 'Cannot delete last admin' },
    );
  });
});

// ─── getAllowedScopes() ──────────────────────────────────────

describe('users.getAllowedScopes()', () => {
  it('should return only client* scopes for user role', () => {
    const scopes = users.getAllowedScopes('user');
    assert.deepEqual(scopes, ['client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp']);
  });

  it('should return all VALID_SCOPES for admin role', () => {
    const scopes = users.getAllowedScopes('admin');
    const { VALID_SCOPES } = require('../src/services/tokens');
    assert.deepEqual(scopes, VALID_SCOPES);
  });
});
