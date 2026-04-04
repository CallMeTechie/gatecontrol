# Unified User Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge API tokens and admin users into a unified identity model with roles (`admin`/`user`), own sidebar page `/users`, and role-based scope filtering.

**Architecture:** Extend existing `users` table (add `enabled` column), add `user_id` FK to `api_tokens`. New `src/services/users.js` for CRUD, new API routes `/api/v1/users`, new page `/users` with list + detail modal. Auth middleware extended to check user enabled state and filter scopes by role. Settings "API" tab removed — token management moves to user detail view.

**Tech Stack:** Node.js 20, Express, SQLite (better-sqlite3), Nunjucks templates, vanilla JS, argon2 (password hashing), i18n (en/de)

**Spec:** `docs/superpowers/specs/2026-04-04-unified-user-model-design.md`

---

## File Structure

### New files
- `src/services/users.js` — User CRUD, role validation, enabled check
- `src/routes/api/users.js` — REST endpoints for user management
- `templates/default/pages/users.njk` — Users list page + detail modal
- `public/js/users.js` — Client-side user management logic
- `tests/users.test.js` — User service + API tests

### Modified files
- `src/db/migrations.js` — Migration 32: add `enabled` to users, `user_id` to api_tokens
- `src/middleware/auth.js` — Check user enabled, add `req.tokenUserId`, `req.tokenUserRole`
- `src/services/tokens.js` — Add `user_id` to create(), scope validation against role, assign/unassign
- `src/routes/api/tokens.js` — Add PUT /:id/assign endpoint, update create to accept user_id
- `src/routes/api/index.js` — Mount users router
- `src/routes/index.js` — Add `/users` page route
- `templates/default/partials/sidebar.njk` — Add "Access Control" section
- `templates/default/partials/bottomnav.njk` — Replace one nav item with Users
- `templates/default/pages/settings.njk` — Remove API tab
- `public/js/settings.js` — Remove token-related code
- `src/i18n/en.json` — English translations for users page
- `src/i18n/de.json` — German translations for users page
- `src/db/seed.js` — Ensure seeded admin has `role='admin'`, `enabled=1`

---

## Task 1: Database Migration

**Files:**
- Modify: `src/db/migrations.js` (after line 575, add migration 32)

- [ ] **Step 1: Add migration 32 to migrations array**

In `src/db/migrations.js`, add after the last migration object (version 31):

```javascript
  {
    version: 32,
    name: 'unified_user_model',
    sql: `
      ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE api_tokens ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
    `,
    detect: (db) => hasColumn(db, 'api_tokens', 'user_id'),
  },
```

Note: `users.role` already exists (migration 1, default 'admin'). `users.password_hash` stays NOT NULL — client users get the sentinel value `'!'` which can never match an argon2 hash.

- [ ] **Step 2: Update seed.js to ensure admin has enabled=1**

Read `src/db/seed.js` and verify the admin INSERT sets `enabled=1`. If the INSERT doesn't include `enabled`, it defaults to 1 from the migration, so no change needed. Just verify.

- [ ] **Step 3: Test migration runs**

```bash
cd /root/gatecontrol && NODE_ENV=test node -e "
  process.env.GC_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
  const { getDb } = require('./src/db/connection');
  const db = getDb();
  const cols = db.pragma('table_info(api_tokens)').map(c => c.name);
  console.log('user_id column exists:', cols.includes('user_id'));
  const userCols = db.pragma('table_info(users)').map(c => c.name);
  console.log('enabled column exists:', userCols.includes('enabled'));
"
```

Expected: both `true`.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations.js
git commit -m "feat: add migration 32 for unified user model (enabled + user_id)"
```

---

## Task 2: User Service

**Files:**
- Create: `src/services/users.js`
- Test: `tests/users.test.js`

- [ ] **Step 1: Write failing tests for user service**

Create `tests/users.test.js`:

```javascript
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
delete require.cache[require.resolve('../config/default')];

const users = require('../src/services/users');

describe('User Service', () => {
  before(() => {
    const { getDb } = require('../src/db/connection');
    const db = getDb();
    // Ensure clean state — delete non-seeded users
    db.prepare("DELETE FROM users WHERE username != 'admin'").run();
  });

  describe('create', () => {
    it('creates an admin user with password', async () => {
      const user = await users.create({
        username: 'admin2',
        displayName: 'Second Admin',
        role: 'admin',
        password: 'Test1234!',
      });
      assert.ok(user.id);
      assert.equal(user.username, 'admin2');
      assert.equal(user.role, 'admin');
      assert.equal(user.enabled, 1);
      assert.ok(!user.password_hash); // not exposed
    });

    it('creates a client user without password', () => {
      const user = users.createClientUser({
        username: 'client-max',
        displayName: 'Max Mustermann',
      });
      assert.ok(user.id);
      assert.equal(user.username, 'client-max');
      assert.equal(user.role, 'user');
      assert.equal(user.enabled, 1);
    });

    it('rejects duplicate username', () => {
      assert.throws(() => users.createClientUser({ username: 'client-max' }));
    });

    it('rejects empty username', () => {
      assert.throws(() => users.createClientUser({ username: '' }));
    });

    it('rejects admin without password', async () => {
      await assert.rejects(() => users.create({ username: 'nopw', role: 'admin' }));
    });
  });

  describe('list', () => {
    it('returns all users', () => {
      const list = users.list();
      assert.ok(list.length >= 3); // seeded admin + admin2 + client-max
      assert.ok(list.every(u => !u.password_hash)); // never exposed
    });
  });

  describe('getById', () => {
    it('returns user without password_hash', () => {
      const list = users.list();
      const user = users.getById(list[0].id);
      assert.ok(user);
      assert.ok(!user.password_hash);
    });

    it('returns null for nonexistent', () => {
      assert.equal(users.getById(99999), null);
    });
  });

  describe('update', () => {
    it('updates display name', () => {
      const list = users.list();
      const client = list.find(u => u.username === 'client-max');
      const updated = users.update(client.id, { displayName: 'Max M.' });
      assert.equal(updated.display_name, 'Max M.');
    });
  });

  describe('toggle', () => {
    it('disables and enables a user', () => {
      const list = users.list();
      const client = list.find(u => u.username === 'client-max');
      const disabled = users.toggle(client.id);
      assert.equal(disabled.enabled, 0);
      const enabled = users.toggle(client.id);
      assert.equal(enabled.enabled, 1);
    });
  });

  describe('remove', () => {
    it('deletes a user', () => {
      const list = users.list();
      const client = list.find(u => u.username === 'client-max');
      users.remove(client.id);
      assert.equal(users.getById(client.id), null);
    });

    it('prevents deleting last admin', () => {
      // Get all admins, delete all but one, then try to delete the last
      const admins = users.list().filter(u => u.role === 'admin');
      if (admins.length > 1) {
        // Delete extras first
        for (let i = 1; i < admins.length; i++) {
          users.remove(admins[i].id);
        }
      }
      const lastAdmin = users.list().find(u => u.role === 'admin');
      assert.throws(() => users.remove(lastAdmin.id), /last admin/i);
    });
  });

  describe('role scope validation', () => {
    it('returns allowed scopes for user role', () => {
      const allowed = users.getAllowedScopes('user');
      assert.ok(allowed.includes('client'));
      assert.ok(allowed.includes('client:rdp'));
      assert.ok(!allowed.includes('full-access'));
      assert.ok(!allowed.includes('settings'));
      assert.ok(!allowed.includes('peers'));
    });

    it('returns all scopes for admin role', () => {
      const allowed = users.getAllowedScopes('admin');
      assert.ok(allowed.includes('full-access'));
      assert.ok(allowed.includes('settings'));
      assert.ok(allowed.includes('client'));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /root/gatecontrol && NODE_ENV=test node --test tests/users.test.js
```

Expected: FAIL — `Cannot find module '../src/services/users'`

- [ ] **Step 3: Implement user service**

Create `src/services/users.js`:

```javascript
'use strict';

const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');
const argon2Options = require('../utils/argon2Options');

const NO_PASSWORD_SENTINEL = '!';

const ROLE_SCOPES = {
  admin: null, // null = all scopes allowed
  user: ['client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp'],
};

function getAllowedScopes(role) {
  if (ROLE_SCOPES[role] === null) {
    // Admin: return all valid scopes
    const tokens = require('./tokens');
    return [...tokens.VALID_SCOPES];
  }
  return [...(ROLE_SCOPES[role] || [])];
}

function filterScopesForRole(scopes, role) {
  const allowed = getAllowedScopes(role);
  if (ROLE_SCOPES[role] === null) return scopes; // admin: no filtering
  return scopes.filter(s => allowed.includes(s));
}

function stripSensitive(row) {
  if (!row) return null;
  const { password_hash, ...safe } = row;
  return safe;
}

function list() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  return rows.map(stripSensitive);
}

function getById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return stripSensitive(row);
}

function getByUsername(username) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return stripSensitive(row);
}

function getByIdWithHash(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

async function create({ username, displayName, role, password, email }) {
  if (!username || typeof username !== 'string' || username.trim().length === 0) {
    throw new Error('Username is required');
  }
  if (!['admin', 'user'].includes(role)) {
    throw new Error('Role must be admin or user');
  }
  if (role === 'admin' && !password) {
    throw new Error('Admin users require a password');
  }

  const db = getDb();
  const hash = password ? await argon2.hash(password, argon2Options) : NO_PASSWORD_SENTINEL;

  const result = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, role, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(username.trim(), hash, displayName || null, email || null, role);

  activity.log('user_created', `User "${username}" created with role ${role}`, {
    source: 'admin', severity: 'info',
    details: { userId: result.lastInsertRowid, role },
  });

  logger.info({ userId: result.lastInsertRowid, username, role }, 'User created');
  return getById(result.lastInsertRowid);
}

function createClientUser({ username, displayName, email }) {
  if (!username || typeof username !== 'string' || username.trim().length === 0) {
    throw new Error('Username is required');
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email, role, enabled)
    VALUES (?, ?, ?, ?, 'user', 1)
  `).run(username.trim(), NO_PASSWORD_SENTINEL, displayName || null, email || null);

  activity.log('user_created', `Client user "${username}" created`, {
    source: 'admin', severity: 'info',
    details: { userId: result.lastInsertRowid, role: 'user' },
  });

  logger.info({ userId: result.lastInsertRowid, username }, 'Client user created');
  return getById(result.lastInsertRowid);
}

function update(id, data) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) throw new Error('User not found');

  const sets = [];
  const values = [];

  if (data.displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(data.displayName || null);
  }
  if (data.email !== undefined) {
    sets.push('email = ?');
    values.push(data.email || null);
  }
  if (data.username !== undefined && data.username.trim().length > 0) {
    sets.push('username = ?');
    values.push(data.username.trim());
  }
  if (data.role !== undefined) {
    if (!['admin', 'user'].includes(data.role)) throw new Error('Role must be admin or user');
    // Prevent degrading last admin
    if (existing.role === 'admin' && data.role === 'user') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get().c;
      if (adminCount <= 1) throw new Error('Cannot change role of last admin');
    }
    sets.push('role = ?');
    values.push(data.role);
  }

  if (sets.length === 0) return getById(id);

  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  logger.info({ userId: id }, 'User updated');
  return getById(id);
}

function toggle(id) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, role, enabled FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  // Prevent disabling last admin
  if (user.role === 'admin' && user.enabled) {
    const enabledAdmins = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND enabled = 1").get().c;
    if (enabledAdmins <= 1) throw new Error('Cannot disable last admin');
  }

  const newState = user.enabled ? 0 : 1;
  db.prepare("UPDATE users SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newState, id);

  activity.log('user_toggled', `User "${user.username}" ${newState ? 'enabled' : 'disabled'}`, {
    source: 'admin', severity: newState ? 'info' : 'warning',
    details: { userId: id },
  });

  return getById(id);
}

function remove(id) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found');

  // Prevent deleting last admin
  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) throw new Error('Cannot delete last admin');
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);

  activity.log('user_deleted', `User "${user.username}" deleted`, {
    source: 'admin', severity: 'warning',
    details: { userId: id, username: user.username },
  });

  logger.info({ userId: id, username: user.username }, 'User deleted');
}

function isEnabled(id) {
  const db = getDb();
  const row = db.prepare('SELECT enabled FROM users WHERE id = ?').get(id);
  return row ? !!row.enabled : false;
}

function hasPassword(id) {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id);
  return row ? row.password_hash !== NO_PASSWORD_SENTINEL : false;
}

function getTokenCount(userId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as c FROM api_tokens WHERE user_id = ?').get(userId).c;
}

function getPeerCount(userId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(DISTINCT peer_id) as c FROM api_tokens WHERE user_id = ? AND peer_id IS NOT NULL').get(userId).c;
}

function getLastAccess(userId) {
  const db = getDb();
  const row = db.prepare('SELECT MAX(last_used_at) as last FROM api_tokens WHERE user_id = ?').get(userId);
  return row ? row.last : null;
}

module.exports = {
  list,
  getById,
  getByUsername,
  getByIdWithHash,
  create,
  createClientUser,
  update,
  toggle,
  remove,
  isEnabled,
  hasPassword,
  getTokenCount,
  getPeerCount,
  getLastAccess,
  getAllowedScopes,
  filterScopesForRole,
  NO_PASSWORD_SENTINEL,
};
```

- [ ] **Step 4: Export VALID_SCOPES from tokens.js**

In `src/services/tokens.js`, ensure `VALID_SCOPES` is exported. Find the `module.exports` at the end and add `VALID_SCOPES` if not already exported:

```javascript
// Add to module.exports:
VALID_SCOPES,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /root/gatecontrol && NODE_ENV=test node --test tests/users.test.js
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/users.js tests/users.test.js src/services/tokens.js
git commit -m "feat: add user service with CRUD, role validation, and tests"
```

---

## Task 3: User API Routes

**Files:**
- Create: `src/routes/api/users.js`
- Modify: `src/routes/api/index.js` (add mount)

- [ ] **Step 1: Create user API routes**

Create `src/routes/api/users.js`:

```javascript
'use strict';

const { Router } = require('express');
const users = require('../../services/users');
const tokens = require('../../services/tokens');
const logger = require('../../utils/logger');

const router = Router();

// All user routes require session auth (admin only, no token auth)
router.use((req, res, next) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: 'User management requires admin session' });
  }
  // Check admin role
  const { getDb } = require('../../db/connection');
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Admin access required' });
  }
  next();
});

/**
 * GET /api/v1/users — List all users with token/peer counts
 */
router.get('/', (req, res) => {
  try {
    const list = users.list().map(u => ({
      ...u,
      tokenCount: users.getTokenCount(u.id),
      peerCount: users.getPeerCount(u.id),
      lastAccess: users.getLastAccess(u.id),
    }));
    res.json({ ok: true, users: list });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list users');
    res.status(500).json({ ok: false, error: req.t('error.users.list') });
  }
});

/**
 * POST /api/v1/users — Create user
 */
router.post('/', async (req, res) => {
  try {
    const { username, displayName, role, password, email } = req.body;
    let user;
    if (role === 'user') {
      user = users.createClientUser({ username, displayName, email });
    } else {
      user = await users.create({ username, displayName, role: role || 'admin', password, email });
    }
    res.status(201).json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create user');
    if (err.message.includes('UNIQUE') || err.message.includes('required') || err.message.includes('must be')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.create') });
  }
});

/**
 * GET /api/v1/users/:id — User detail with tokens
 */
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const user = users.getById(id);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });

    const userTokens = tokens.listByUserId(id);
    res.json({ ok: true, user, tokens: userTokens });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get user');
    res.status(500).json({ ok: false, error: req.t('error.users.get') });
  }
});

/**
 * PATCH /api/v1/users/:id — Update user
 */
router.patch('/:id', (req, res) => {
  try {
    const user = users.update(parseInt(req.params.id, 10), req.body);
    res.json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update user');
    if (err.message === 'User not found') {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    if (err.message.includes('last admin') || err.message.includes('must be')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.update') });
  }
});

/**
 * DELETE /api/v1/users/:id — Delete user
 */
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Prevent self-deletion
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_delete') });
    }
    users.remove(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete user');
    if (err.message === 'User not found') {
      return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });
    }
    if (err.message.includes('last admin')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.delete') });
  }
});

/**
 * PUT /api/v1/users/:id/toggle — Enable/disable user
 */
router.put('/:id/toggle', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: req.t('error.users.self_disable') });
    }
    const user = users.toggle(id);
    res.json({ ok: true, user });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle user');
    if (err.message.includes('last admin')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.users.toggle') });
  }
});

/**
 * POST /api/v1/users/:id/tokens — Create token for user
 */
router.post('/:id/tokens', (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const user = users.getById(userId);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.users.not_found') });

    const { name, scopes, expires_at, machine_binding_enabled } = req.body;

    // Filter scopes to role's allowed set
    const filteredScopes = users.filterScopesForRole(scopes || [], user.role);
    if (filteredScopes.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.tokens.scopes_required') });
    }

    const result = tokens.create({
      name: name,
      scopes: filteredScopes,
      expiresAt: expires_at || null,
      machineBindingEnabled: machine_binding_enabled || false,
      userId: userId,
    }, req.ip);

    res.status(201).json({ ok: true, token: result.rawToken, details: result.token });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create token for user');
    if (err.message.includes('required') || err.message.includes('Invalid')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: req.t('error.tokens.create') });
  }
});

/**
 * GET /api/v1/users/unassigned-tokens — List tokens without user_id
 */
router.get('/unassigned-tokens', (req, res) => {
  try {
    const unassigned = tokens.listUnassigned();
    res.json({ ok: true, tokens: unassigned });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list unassigned tokens');
    res.status(500).json({ ok: false, error: req.t('error.tokens.list') });
  }
});

/**
 * PUT /api/v1/tokens/:id/assign — Assign token to user
 */
// Note: This is mounted on the tokens router in tokens.js, not here.
// See Task 4 for that endpoint.

module.exports = router;
```

- [ ] **Step 2: Fix route ordering — move unassigned-tokens before :id param**

The `/unassigned-tokens` route must come BEFORE `/:id` to avoid Express matching "unassigned-tokens" as an `:id`. Reorder in the file: move the `GET /` and `POST /` and `GET /unassigned-tokens` routes above any `/:id` routes.

- [ ] **Step 3: Mount users router in API index**

In `src/routes/api/index.js`, add before the tokens line:

```javascript
router.use('/users', require('./users'));
```

- [ ] **Step 4: Run existing tests to verify no breakage**

```bash
cd /root/gatecontrol && NODE_ENV=test node --test tests/e2ee.test.js tests/crypto.test.js
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/users.js src/routes/api/index.js
git commit -m "feat: add user API routes with CRUD and token creation"
```

---

## Task 4: Token Service Updates

**Files:**
- Modify: `src/services/tokens.js` — add user_id to create(), listByUserId(), listUnassigned(), assignToUser()
- Modify: `src/routes/api/tokens.js` — add assign endpoint

- [ ] **Step 1: Add user_id support to tokens.create()**

In `src/services/tokens.js`, update the `create()` function's INSERT statement to include `user_id`:

Change the INSERT SQL from:
```sql
INSERT INTO api_tokens (name, token_hash, scopes, expires_at, machine_binding_enabled)
VALUES (?, ?, ?, ?, ?)
```
To:
```sql
INSERT INTO api_tokens (name, token_hash, scopes, expires_at, machine_binding_enabled, user_id)
VALUES (?, ?, ?, ?, ?, ?)
```

And add `opts.userId || null` as the 6th parameter.

- [ ] **Step 2: Add listByUserId() and listUnassigned() functions**

Add to `src/services/tokens.js`:

```javascript
function listByUserId(userId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map(formatToken);
}

function listUnassigned() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_tokens WHERE user_id IS NULL ORDER BY created_at DESC').all();
  return rows.map(formatToken);
}

function assignToUser(tokenId, userId) {
  const db = getDb();
  const token = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(tokenId);
  if (!token) throw new Error('Token not found');
  if (token.user_id !== null) throw new Error('Token is already assigned to a user');

  db.prepare("UPDATE api_tokens SET user_id = ? WHERE id = ?").run(userId, tokenId);
  return formatToken(db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(tokenId));
}
```

Export all three new functions in `module.exports`.

- [ ] **Step 3: Add assign endpoint to tokens router**

In `src/routes/api/tokens.js`, add:

```javascript
/**
 * PUT /api/v1/tokens/:id/assign — Assign unassigned token to a user
 */
router.put('/:id/assign', (req, res) => {
  if (req.tokenAuth) {
    return res.status(403).json({ ok: false, error: req.t('error.tokens.no_escalation') });
  }

  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId is required' });

    const token = tokens.assignToUser(parseInt(req.params.id, 10), parseInt(userId, 10));
    res.json({ ok: true, token });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to assign token');
    if (err.message === 'Token not found') {
      return res.status(404).json({ ok: false, error: req.t('error.tokens.not_found') });
    }
    if (err.message.includes('already assigned')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: 'Failed to assign token' });
  }
});
```

- [ ] **Step 4: Add user_id to formatToken()**

In `formatToken()`, include `user_id` in the returned object:

```javascript
user_id: row.user_id || null,
```

- [ ] **Step 5: Run tests**

```bash
cd /root/gatecontrol && NODE_ENV=test node --test tests/users.test.js tests/e2ee.test.js tests/crypto.test.js
```

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/tokens.js src/routes/api/tokens.js
git commit -m "feat: add user_id to tokens, listByUserId, assignToUser"
```

---

## Task 5: Auth Middleware — User Enabled Check + Role Scope Filtering

**Files:**
- Modify: `src/middleware/auth.js`

- [ ] **Step 1: Update auth middleware to check user enabled state**

Replace the token auth section in `requireAuth()` (lines 49-62) with:

```javascript
      const tokenRecord = getTokens().authenticate(rawToken);
      if (tokenRecord) {
        // If token is assigned to a user, check user is enabled
        if (tokenRecord.user_id) {
          const users = require('../services/users');
          if (!users.isEnabled(tokenRecord.user_id)) {
            return res.status(403).json({ ok: false, error: 'User account is disabled' });
          }
        }

        // Filter scopes by user role (if assigned)
        let effectiveScopes = tokenRecord.scopes;
        if (tokenRecord.user_id) {
          const users = require('../services/users');
          const user = users.getById(tokenRecord.user_id);
          if (user) {
            effectiveScopes = users.filterScopesForRole(tokenRecord.scopes, user.role);
          }
        }

        // Check scope for this request
        const fullPath = req.baseUrl + req.path;
        if (!getTokens().checkScope(effectiveScopes, fullPath, req.method)) {
          return res.status(403).json({ ok: false, error: 'Token does not have permission for this resource' });
        }

        // Mark request as token-authenticated
        req.tokenAuth = true;
        req.tokenId = tokenRecord.id;
        req.tokenScopes = effectiveScopes;
        req.tokenPeerId = tokenRecord.peer_id || null;
        req.tokenUserId = tokenRecord.user_id || null;
        return next();
      }
```

- [ ] **Step 2: Ensure authenticate() returns user_id**

In `src/services/tokens.js`, verify that `authenticate()` returns the `user_id` field. Check the SELECT query — it should already return all columns. If `formatToken()` is used, verify `user_id` is included (done in Task 4).

If `authenticate()` returns the raw row (not `formatToken`), `user_id` is already in the row from the database.

- [ ] **Step 3: Run all tests**

```bash
cd /root/gatecontrol && NODE_ENV=test node --test tests/users.test.js tests/e2ee.test.js tests/crypto.test.js
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add src/middleware/auth.js
git commit -m "feat: auth middleware checks user enabled state and filters scopes by role"
```

---

## Task 6: Users Page Template + Sidebar

**Files:**
- Create: `templates/default/pages/users.njk`
- Modify: `templates/default/partials/sidebar.njk`
- Modify: `templates/default/partials/bottomnav.njk`
- Modify: `src/routes/index.js` — add `/users` page route

- [ ] **Step 1: Add /users page route**

In `src/routes/index.js`, add to the `pages` array:

```javascript
  { path: '/users', template: 'users', titleKey: 'nav.users' },
```

- [ ] **Step 2: Add Access Control section to sidebar**

In `templates/default/partials/sidebar.njk`, add before the `<span class="nav-section-label">{{ t('nav.system') }}</span>` line:

```html
  <span class="nav-section-label">{{ t('nav.access_control') }}</span>
  <a href="/users" class="nav-item {{ 'active' if activeNav == 'users' }}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
    {{ t('nav.users') }}
  </a>

```

- [ ] **Step 3: Create users page template**

Create `templates/default/pages/users.njk`:

```html
{% extends theme + "/layout.njk" %}

{% block content %}
<div class="page-header">
  <div>
    <div class="page-eyebrow">{{ t('nav.access_control') }}</div>
    <div class="page-title">{{ t('users.title') }}</div>
    <div class="page-sub">{{ t('users.subtitle') }}</div>
  </div>
  <button class="btn btn-primary" id="btn-add-user">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    {{ t('users.add_user') }}
  </button>
</div>

{# ─── Unassigned Tokens Banner ─────────────────── #}
<div id="unassigned-banner" style="display:none;padding:12px 16px;margin-bottom:16px;background:var(--amber-lt);border:1px solid var(--amber-bd);border-radius:var(--radius-sm);font-size:13px;color:var(--text-1)">
  <span id="unassigned-count">0</span> {{ t('users.unassigned_tokens') }}
</div>

{# ─── Users Table ──────────────────────────────── #}
<div class="card">
  <div class="card-body" style="padding:0">
    <table class="data-table" id="users-table">
      <thead>
        <tr>
          <th>{{ t('users.col_name') }}</th>
          <th>{{ t('users.col_role') }}</th>
          <th>{{ t('users.col_tokens') }}</th>
          <th>{{ t('users.col_peers') }}</th>
          <th>{{ t('users.col_status') }}</th>
          <th>{{ t('users.col_last_access') }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="users-list"></tbody>
    </table>
  </div>
</div>

{# ─── Create/Edit User Modal ──────────────────── #}
<div id="user-modal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);align-items:center;justify-content:center">
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-md);padding:24px;max-width:520px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2)">
    <div style="font-size:15px;font-weight:600;color:var(--text-1);margin-bottom:16px" id="user-modal-title">{{ t('users.add_user') }}</div>

    <div class="form-group">
      <label class="form-label" for="user-username">{{ t('users.username') }}</label>
      <input type="text" id="user-username" style="width:100%" maxlength="50" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label" for="user-displayname">{{ t('users.display_name') }}</label>
      <input type="text" id="user-displayname" style="width:100%" maxlength="100">
    </div>
    <div class="form-group">
      <label class="form-label" for="user-email">{{ t('users.email') }}</label>
      <input type="email" id="user-email" style="width:100%" maxlength="200">
    </div>
    <div class="form-group">
      <label class="form-label" for="user-role">{{ t('users.role') }}</label>
      <select id="user-role" style="width:100%">
        <option value="user">{{ t('users.role_user') }}</option>
        <option value="admin">{{ t('users.role_admin') }}</option>
      </select>
    </div>
    <div class="form-group" id="user-password-group" style="display:none">
      <label class="form-label" for="user-password">{{ t('users.password') }}</label>
      <input type="password" id="user-password" style="width:100%" autocomplete="new-password">
      <small class="form-hint">{{ t('users.password_hint') }}</small>
    </div>

    <div id="user-modal-error" style="display:none;font-size:12px;color:var(--red);margin-bottom:8px"></div>

    {# ─── Token Section (only in edit mode) ───── #}
    <div id="user-tokens-section" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:14px;font-weight:600;color:var(--text-1)">{{ t('users.tokens') }}</span>
        <button class="btn btn-ghost" style="font-size:12px" id="btn-add-token-for-user">{{ t('users.add_token') }}</button>
      </div>
      <div id="user-tokens-list"></div>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-ghost" id="user-modal-cancel">{{ t('config.cancel') }}</button>
      <button class="btn btn-primary" id="user-modal-save">{{ t('data.save') or 'Save' }}</button>
    </div>
  </div>
</div>

{# ─── Create Token Sub-Modal ──────────────────── #}
<div id="token-modal" style="display:none;position:fixed;inset:0;z-index:1001;background:rgba(0,0,0,.5);align-items:center;justify-content:center">
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-md);padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2)">
    <div style="font-size:15px;font-weight:600;color:var(--text-1);margin-bottom:16px">{{ t('users.create_token') }}</div>
    <div class="form-group">
      <label class="form-label" for="new-token-name">{{ t('users.token_name') }}</label>
      <input type="text" id="new-token-name" style="width:100%" maxlength="100">
    </div>
    <div class="form-group">
      <label class="form-label">{{ t('users.token_scopes') }}</label>
      <div id="new-token-scopes" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    </div>
    <div class="form-group">
      <label class="form-label" for="new-token-expiry">{{ t('users.token_expiry') }}</label>
      <select id="new-token-expiry" style="width:100%">
        <option value="">{{ t('users.no_expiry') }}</option>
        <option value="30">30 {{ t('users.days') }}</option>
        <option value="90">90 {{ t('users.days') }}</option>
        <option value="365">365 {{ t('users.days') }}</option>
      </select>
    </div>
    <div id="token-modal-error" style="display:none;font-size:12px;color:var(--red);margin-bottom:8px"></div>
    <div id="token-created-result" style="display:none;margin-bottom:12px;padding:12px;background:var(--green-lt);border:1px solid var(--green-bd);border-radius:var(--radius-sm)">
      <div style="font-size:12px;color:var(--text-2);margin-bottom:4px">{{ t('users.token_created_copy') }}</div>
      <code id="token-created-value" style="font-size:12px;word-break:break-all;user-select:all"></code>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-ghost" id="token-modal-close">{{ t('config.cancel') }}</button>
      <button class="btn btn-primary" id="token-modal-create">{{ t('users.create_token') }}</button>
    </div>
  </div>
</div>
{% endblock %}

{% block scripts %}
<script src="/js/users.js"></script>
{% endblock %}
```

- [ ] **Step 4: Commit**

```bash
git add templates/default/pages/users.njk templates/default/partials/sidebar.njk templates/default/partials/bottomnav.njk src/routes/index.js
git commit -m "feat: add users page template and sidebar Access Control section"
```

---

## Task 7: Client JS for Users Page

**Files:**
- Create: `public/js/users.js`

- [ ] **Step 1: Create users.js client code**

Create `public/js/users.js` with the complete client-side logic for:
- Loading and rendering the users table
- Opening create/edit user modal with role-dependent password field
- Creating/editing users via API
- Token management within user detail (create, revoke, assign)
- Unassigned tokens banner + assignment
- Scope checkbox rendering based on user role
- Toggle enable/disable, delete with confirmation

This is the largest single file. Use `textContent` for all dynamic text (no innerHTML with user data). Follow the pattern from existing `public/js/settings.js` for API calls (`api.get`, `api.post`, etc.) and button helpers (`btnLoading`, `btnReset`).

The complete code is too large for inline spec. Implementation should follow the patterns in `public/js/rdp.js` and `public/js/settings.js` — DOM manipulation, event delegation on the table, modal open/close pattern with backdrop click.

- [ ] **Step 2: Test manually — navigate to /users**

After deploying, verify:
- Users table loads with at least the seeded admin
- Create user modal opens, role switch shows/hides password field
- Token creation works within user detail
- Unassigned tokens banner appears if any exist

- [ ] **Step 3: Commit**

```bash
git add public/js/users.js
git commit -m "feat: add client JS for users page with token management"
```

---

## Task 8: Remove Settings API Tab

**Files:**
- Modify: `templates/default/pages/settings.njk` — remove API tab and panel
- Modify: `public/js/settings.js` — remove token-related code at the end
- Note: `public/js/tokens.js` can be deleted entirely (logic moves to users.js)

- [ ] **Step 1: Remove API tab from settings template**

In `templates/default/pages/settings.njk`:
- Remove the `<div class="tab" data-settings-tab="api">` elements (both in dropdown and main tabs)
- Remove the entire `<div class="settings-panel" data-settings-panel="api">` block

- [ ] **Step 2: Remove tokens.js script include**

Search for `<script src="/js/tokens.js">` in `settings.njk` and remove it.

- [ ] **Step 3: Delete public/js/tokens.js**

```bash
rm public/js/tokens.js
```

- [ ] **Step 4: Run tests to verify no breakage**

```bash
cd /root/gatecontrol && NODE_ENV=test node --test tests/users.test.js tests/e2ee.test.js tests/crypto.test.js
```

- [ ] **Step 5: Commit**

```bash
git add templates/default/pages/settings.njk public/js/tokens.js
git commit -m "fix: remove API tokens tab from settings (moved to /users)"
```

---

## Task 9: i18n Translations

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English translations**

Add to `src/i18n/en.json`:

```json
  "nav.access_control": "Access Control",
  "nav.users": "Users",

  "users.title": "Users",
  "users.subtitle": "Manage users and their API tokens",
  "users.add_user": "Add User",
  "users.username": "Username",
  "users.display_name": "Display Name",
  "users.email": "Email",
  "users.role": "Role",
  "users.role_admin": "Admin",
  "users.role_user": "User",
  "users.password": "Password",
  "users.password_hint": "Required for admin users (web UI login)",
  "users.tokens": "API Tokens",
  "users.add_token": "Add Token",
  "users.create_token": "Create Token",
  "users.token_name": "Token Name",
  "users.token_scopes": "Scopes",
  "users.token_expiry": "Expires",
  "users.no_expiry": "Never",
  "users.days": "days",
  "users.token_created_copy": "Copy this token now — it won't be shown again:",
  "users.unassigned_tokens": "unassigned tokens from before the update. Assign them to users.",
  "users.col_name": "Name",
  "users.col_role": "Role",
  "users.col_tokens": "Tokens",
  "users.col_peers": "Peers",
  "users.col_status": "Status",
  "users.col_last_access": "Last Access",
  "users.confirm_delete": "Delete this user? All their tokens will be revoked.",
  "users.confirm_disable": "Disable this user? All their tokens will stop working.",

  "error.users.list": "Failed to load users",
  "error.users.create": "Failed to create user",
  "error.users.get": "Failed to load user",
  "error.users.update": "Failed to update user",
  "error.users.delete": "Failed to delete user",
  "error.users.toggle": "Failed to toggle user",
  "error.users.not_found": "User not found",
  "error.users.self_delete": "You cannot delete your own account",
  "error.users.self_disable": "You cannot disable your own account",
```

- [ ] **Step 2: Add German translations**

Add to `src/i18n/de.json`:

```json
  "nav.access_control": "Zugriffskontrolle",
  "nav.users": "Benutzer",

  "users.title": "Benutzer",
  "users.subtitle": "Benutzer und ihre API-Tokens verwalten",
  "users.add_user": "Benutzer anlegen",
  "users.username": "Benutzername",
  "users.display_name": "Anzeigename",
  "users.email": "E-Mail",
  "users.role": "Rolle",
  "users.role_admin": "Admin",
  "users.role_user": "Benutzer",
  "users.password": "Passwort",
  "users.password_hint": "Erforderlich für Admin-Benutzer (Web-UI-Login)",
  "users.tokens": "API-Tokens",
  "users.add_token": "Token hinzufügen",
  "users.create_token": "Token erstellen",
  "users.token_name": "Token-Name",
  "users.token_scopes": "Berechtigungen",
  "users.token_expiry": "Ablauf",
  "users.no_expiry": "Nie",
  "users.days": "Tage",
  "users.token_created_copy": "Kopieren Sie diesen Token jetzt — er wird nicht erneut angezeigt:",
  "users.unassigned_tokens": "nicht zugeordnete Tokens aus der vorherigen Version. Ordnen Sie sie Benutzern zu.",
  "users.col_name": "Name",
  "users.col_role": "Rolle",
  "users.col_tokens": "Tokens",
  "users.col_peers": "Peers",
  "users.col_status": "Status",
  "users.col_last_access": "Letzter Zugriff",
  "users.confirm_delete": "Benutzer löschen? Alle Tokens werden widerrufen.",
  "users.confirm_disable": "Benutzer deaktivieren? Alle Tokens werden ungültig.",

  "error.users.list": "Benutzer konnten nicht geladen werden",
  "error.users.create": "Benutzer konnte nicht erstellt werden",
  "error.users.get": "Benutzer konnte nicht geladen werden",
  "error.users.update": "Benutzer konnte nicht aktualisiert werden",
  "error.users.delete": "Benutzer konnte nicht gelöscht werden",
  "error.users.toggle": "Benutzer konnte nicht umgeschaltet werden",
  "error.users.not_found": "Benutzer nicht gefunden",
  "error.users.self_delete": "Sie können Ihr eigenes Konto nicht löschen",
  "error.users.self_disable": "Sie können Ihr eigenes Konto nicht deaktivieren",
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat: add i18n translations for users page (en + de)"
```

---

## Task 10: Final Integration + Push + CI

- [ ] **Step 1: Run all tests**

```bash
cd /root/gatecontrol && NODE_ENV=test node --test tests/users.test.js tests/e2ee.test.js tests/crypto.test.js
```

Expected: All PASS.

- [ ] **Step 2: Push and monitor CI**

```bash
git push
gh run list --repo CallMeTechie/gatecontrol -L 1 --workflow=release.yml
```

Watch until success. If failure: read logs, fix, commit, push, repeat.

- [ ] **Step 3: Pull version bump and deploy from GHCR**

```bash
git pull
cd /root/gatecontrol-deploy && docker compose pull && docker compose down && docker compose up -d
docker save ghcr.io/callmetechie/gatecontrol:latest | gzip > /root/gatecontrol-image.tar.gz
```

- [ ] **Step 4: Verify deployment**

```bash
docker exec gatecontrol node -e "console.log(require('/app/package.json').version)"
```

Navigate to `/users` in browser and verify the page loads.
