# Ephemeral Share Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin mint a time-limited / one-time link that grants a guest access to one proxied HTTP route with no account and no login — the 32-byte token in the URL is the credential.

**Architecture:** Reuse the route-auth forward_auth plumbing. A share link redeem creates a normal `route_auth_session` (with a new `share_link_id`) that `GET /route-auth/verify` already accepts. The first link on an unprotected route inserts an `auth_type='share'` `route_auth` row (`needsForwardAuth` flips → forward_auth wired; the `/route-auth/*` sibling proxy already routes the redeem URL — no Caddy handler change). Pro-gated by a new `share_links` flag. Full design + devil's-advocate decisions: `docs/superpowers/specs/2026-05-25-ephemeral-share-links-design.md`.

**Tech Stack:** Node.js, Express, better-sqlite3, Caddy admin API, Nunjucks templates, `node --test`, supertest.

**Conventions (read once):**
- Tests run via `node --test --test-force-exit tests/`. Test harness: `tests/helpers/setup.js` exports `setup/teardown/getAgent/getCsrf`; admin agent is authed; CSRF header is `X-CSRF-Token`. API base prefix is `/api/v1`.
- `license._overrideForTest({...})` mutates the shared feature cache (Object.assign) — set what you need; the harness already unlocks most flags in `setup()`.
- Client JS: **no `innerHTML`** (PreToolUse hook blocks it) — use `document.createElement` / `textContent` / the existing `el()` helper.
- i18n: every user-facing string in `src/i18n/{en,de}.json`; client-side strings must also be whitelisted in `templates/{default,pro}/layout.njk` (`'key': {{ t('key') | dump | safe }}`) and read via `window.GC.t` / the page's `T(k,d)` helper.
- Two themes: `templates/default/...` and `templates/pro/...` — most template edits must be applied to **both**.
- `git` is available; commit after each task. **No `Co-Authored-By` trailer.** Do not push until the finish step.

---

### Task 1: Migration v45 — share-links table + session column

**Files:**
- Modify: `src/db/migrationList.js` (append after the v44 object, before the closing `]`)
- Modify: `tests/helpers/setup.js:43-69` (add `share_links: true` to the `_overrideForTest` block)
- Test: `tests/share_links_migration.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

beforeEach(setup);
afterEach(teardown);

test('migration v45 creates route_auth_share_links + share_link_id column', () => {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(route_auth_share_links)").all().map(c => c.name);
  assert.ok(cols.includes('token_hash'));
  assert.ok(cols.includes('one_time'));
  assert.ok(cols.includes('redeemed_count'));
  assert.ok(cols.includes('revoked_at'));
  const sessCols = db.prepare("PRAGMA table_info(route_auth_sessions)").all().map(c => c.name);
  assert.ok(sessCols.includes('share_link_id'));
  // token_hash is UNIQUE
  const idx = db.prepare("PRAGMA index_list(route_auth_share_links)").all();
  assert.ok(idx.length >= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_migration.test.js`
Expected: FAIL (no such table `route_auth_share_links`).

- [ ] **Step 3: Append the migration** in `src/db/migrationList.js` (after the v44 object at line ~825, inside the array):

```js
  {
    version: 45,
    name: 'create_route_auth_share_links',
    sql: `
      CREATE TABLE IF NOT EXISTS route_auth_share_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_by_user_id INTEGER,
        one_time INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        redeemed_count INTEGER NOT NULL DEFAULT 0,
        last_redeemed_at TEXT,
        last_redeemed_ip TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_share_links_token ON route_auth_share_links(token_hash);
      CREATE INDEX IF NOT EXISTS idx_share_links_route ON route_auth_share_links(route_id);
      ALTER TABLE route_auth_sessions ADD COLUMN share_link_id INTEGER REFERENCES route_auth_share_links(id) ON DELETE SET NULL;
    `,
    detect: (db) => hasColumn(db, 'route_auth_sessions', 'share_link_id'),
  },
```

Note: the table is created **before** the `ALTER`, so the FK target exists. The column is nullable (NULL default), which is the only form SQLite permits for an `ADD COLUMN` carrying a `REFERENCES` clause. Cleanup (Task 6) does explicit ordered deletes, so correctness does **not** depend on the FK actually firing (the `foreign_keys` PRAGMA may be off).

- [ ] **Step 4: Add `share_links: true` to the test harness override.** In `tests/helpers/setup.js`, inside the `license._overrideForTest({...})` object (around line 65-68), add a line:

```js
    share_links: true,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_migration.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrationList.js tests/helpers/setup.js tests/share_links_migration.test.js
git commit -m "feat: add route_auth_share_links migration (v45)"
```

---

### Task 2: License flag `share_links`

**Files:**
- Modify: `src/services/license.js:15-19` (add to `COMMUNITY_FALLBACK`)
- Test: `tests/share_links_license.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('share_links defaults to false in COMMUNITY_FALLBACK', () => {
  const license = require('../src/services/license');
  assert.equal(license.COMMUNITY_FALLBACK.share_links, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_license.test.js`
Expected: FAIL (`undefined !== false`).

- [ ] **Step 3: Add the flag.** In `src/services/license.js`, in the `COMMUNITY_FALLBACK` object next to `route_auth: false,` (line 19):

```js
  share_links: false,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_license.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/license.js tests/share_links_license.test.js
git commit -m "feat: add share_links community-fallback flag"
```

---

### Task 3: shareLinks service — token, create, validity

**Files:**
- Create: `src/services/shareLinks.js`
- Test: `tests/share_links_service.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  const db = getDb();
  const r = db.prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('app.example.com','10.0.0.5',8080,1)").run();
  routeId = r.lastInsertRowid;
});
afterEach(teardown);

test('createShareLink stores only the hash and returns the token once', () => {
  const svc = require('../src/services/shareLinks');
  const { id, token, expiresAt } = svc.createShareLink(routeId, { expiresInHours: 24, oneTime: false });
  assert.ok(token.length >= 40);
  assert.ok(id > 0);
  assert.ok(new Date(expiresAt).getTime() > Date.now());
  const db = getDb();
  const row = db.prepare('SELECT token_hash FROM route_auth_share_links WHERE id = ?').get(id);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  // plaintext token is nowhere in the row
  const dump = JSON.stringify(db.prepare('SELECT * FROM route_auth_share_links WHERE id = ?').get(id));
  assert.ok(!dump.includes(token));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_service.test.js`
Expected: FAIL (`Cannot find module '../src/services/shareLinks'`).

- [ ] **Step 3: Create `src/services/shareLinks.js`** with the token + create primitives:

```js
'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const activity = require('./activity');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a share link for a route. Returns { id, token, expiresAt }; the
 * plaintext token is returned ONCE and never stored (only its sha256).
 */
function createShareLink(routeId, { expiresInHours, oneTime, label, userId } = {}) {
  const db = getDb();
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + Number(expiresInHours) * 3600 * 1000).toISOString();
  const info = db.prepare(`
    INSERT INTO route_auth_share_links
      (route_id, token_hash, label, created_by_user_id, one_time, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(routeId, tokenHash, label || null, userId || null, oneTime ? 1 : 0, expiresAt);
  return { id: Number(info.lastInsertRowid), token, expiresAt };
}

module.exports = { hashToken, generateToken, createShareLink };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/shareLinks.js tests/share_links_service.test.js
git commit -m "feat: shareLinks service — token + create"
```

---

### Task 4: shareLinks service — `ensureShareGate` + `disableSharing`

**Files:**
- Modify: `src/services/shareLinks.js`
- Test: `tests/share_links_gate.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  const db = getDb();
  routeId = db.prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('g.example.com','10.0.0.6',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('ensureShareGate inserts a share route_auth row and is idempotent', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  assert.equal(svc.ensureShareGate(routeId), true);   // newly gated
  assert.equal(svc.ensureShareGate(routeId), false);  // already gated → no-op, no throw
  const rows = db.prepare("SELECT auth_type FROM route_auth WHERE route_id = ?").all(routeId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].auth_type, 'share');
});

test('ensureShareGate does NOT gate a route that already has real auth', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  db.prepare("INSERT INTO route_auth (route_id, auth_type) VALUES (?, 'email_password')").run(routeId);
  assert.equal(svc.ensureShareGate(routeId), false);
  assert.equal(db.prepare("SELECT auth_type FROM route_auth WHERE route_id = ?").get(routeId).auth_type, 'email_password');
});

test('disableSharing removes share gate + links; leaves real auth intact', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  svc.ensureShareGate(routeId);
  svc.createShareLink(routeId, { expiresInHours: 1, oneTime: false });
  assert.equal(svc.disableSharing(routeId), true); // removed a 'share' gate → caller regenerates Caddy
  assert.equal(db.prepare("SELECT COUNT(*) c FROM route_auth WHERE route_id = ?").get(routeId).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM route_auth_share_links WHERE route_id = ?").get(routeId).c, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_gate.test.js`
Expected: FAIL (`svc.ensureShareGate is not a function`).

- [ ] **Step 3: Add the functions** to `src/services/shareLinks.js` (before `module.exports`):

```js
/**
 * Make a route share-gated by inserting an auth_type='share' route_auth row,
 * idempotently. Returns true ONLY if it just enabled sharing (caller must then
 * regenerate Caddy). No-op (false) if the route already has any route_auth row.
 * Does NOT touch basic_auth (basic-auth routes are rejected at the API layer).
 */
function ensureShareGate(routeId) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO route_auth (route_id, auth_type)
    VALUES (?, 'share')
    ON CONFLICT(route_id) DO NOTHING
  `).run(routeId);
  if (info.changes > 0) {
    activity.log('share_enabled', `Sharing enabled for route ${routeId}`, {
      details: { routeId }, source: 'admin', severity: 'info',
    });
    return true;
  }
  return false;
}

/**
 * Turn sharing off. Always deletes the route's share links + share guest
 * sessions. If the route's auth is the 'share' type (not real auth), also
 * removes the gate row → returns true so the caller regenerates Caddy.
 * Never removes a real (email/otp/totp) route_auth row.
 */
function disableSharing(routeId) {
  const db = getDb();
  const tx = db.transaction(() => {
    const auth = db.prepare('SELECT auth_type FROM route_auth WHERE route_id = ?').get(routeId);
    db.prepare('DELETE FROM route_auth_share_links WHERE route_id = ?').run(routeId);
    if (auth && auth.auth_type === 'share') {
      db.prepare('DELETE FROM route_auth_sessions WHERE route_id = ?').run(routeId);
      db.prepare("DELETE FROM route_auth WHERE route_id = ? AND auth_type = 'share'").run(routeId);
      activity.log('share_disabled', `Sharing disabled for route ${routeId}`, {
        details: { routeId }, source: 'admin', severity: 'info',
      });
      return true;
    }
    db.prepare('DELETE FROM route_auth_sessions WHERE route_id = ? AND share_link_id IS NOT NULL').run(routeId);
    return false;
  });
  return tx();
}
```

Then add `ensureShareGate` and `disableSharing` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_gate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/shareLinks.js tests/share_links_gate.test.js
git commit -m "feat: shareLinks ensureShareGate + disableSharing"
```

---

### Task 5: shareLinks service — atomic redeem + list + revoke

**Files:**
- Modify: `src/services/shareLinks.js`
- Test: `tests/share_links_redeem.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  const db = getDb();
  routeId = db.prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('r.example.com','10.0.0.7',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('redeem creates a session bound to the link with expiry = link expiry', () => {
  const svc = require('../src/services/shareLinks');
  const { id, token, expiresAt } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  const result = svc.redeemShareLink(token, '1.2.3.4');
  assert.ok(result);
  assert.equal(result.routeId, routeId);
  const db = getDb();
  const sess = db.prepare('SELECT * FROM route_auth_sessions WHERE id = ?').get(result.sessionId);
  assert.equal(sess.route_id, routeId);
  assert.equal(sess.share_link_id, id);
  assert.equal(sess.two_factor_pending, 0);
  assert.equal(sess.expires_at, expiresAt); // no extra cap
});

test('one-time link cannot be redeemed twice', () => {
  const svc = require('../src/services/shareLinks');
  const { token } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: true });
  assert.ok(svc.redeemShareLink(token, '1.1.1.1'));
  assert.equal(svc.redeemShareLink(token, '1.1.1.1'), null);
});

test('expired / revoked / unknown tokens do not redeem', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  // expired
  const { id: eid, token: et } = svc.createShareLink(routeId, { expiresInHours: 1, oneTime: false });
  db.prepare("UPDATE route_auth_share_links SET expires_at = datetime('now','-1 hour') WHERE id = ?").run(eid);
  assert.equal(svc.redeemShareLink(et, '1.1.1.1'), null);
  // revoked
  const { id: rid, token: rt } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  assert.equal(svc.revokeShareLink(routeId, rid), true);
  assert.equal(svc.redeemShareLink(rt, '1.1.1.1'), null);
  // unknown
  assert.equal(svc.redeemShareLink('nope', '1.1.1.1'), null);
});

test('revoke deletes the link\'s guest sessions; list hides revoked/expired', () => {
  const svc = require('../src/services/shareLinks');
  const db = getDb();
  const { id, token } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  const r = svc.redeemShareLink(token, '1.1.1.1');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_sessions WHERE id = ?').get(r.sessionId).c, 1);
  svc.revokeShareLink(routeId, id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_sessions WHERE id = ?').get(r.sessionId).c, 0);
  assert.equal(svc.listShareLinks(routeId).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_redeem.test.js`
Expected: FAIL (`svc.redeemShareLink is not a function`).

- [ ] **Step 3: Add the functions** to `src/services/shareLinks.js` (before `module.exports`):

```js
/**
 * Atomically redeem a token: validate, bump redeemed_count, create a guest
 * route_auth_session bound to the link with expiry = link expiry. Returns
 * { sessionId, expiresAt, routeId } or null if the token is invalid/expired/
 * revoked/already-used (one_time).
 */
function redeemShareLink(token, ip) {
  const db = getDb();
  const tokenHash = hashToken(token);
  const tx = db.transaction(() => {
    const link = db.prepare(`
      SELECT * FROM route_auth_share_links
      WHERE token_hash = ?
        AND revoked_at IS NULL
        AND expires_at > datetime('now')
        AND (one_time = 0 OR redeemed_count = 0)
    `).get(tokenHash);
    if (!link) return null;
    db.prepare(`
      UPDATE route_auth_share_links
      SET redeemed_count = redeemed_count + 1,
          last_redeemed_at = datetime('now'),
          last_redeemed_ip = ?
      WHERE id = ?
    `).run(ip || null, link.id);
    const sessionId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO route_auth_sessions
        (id, route_id, email, ip_address, two_factor_pending, expires_at, share_link_id)
      VALUES (?, ?, 'share', ?, 0, ?, ?)
    `).run(sessionId, link.route_id, ip || null, link.expires_at, link.id);
    return { sessionId, expiresAt: link.expires_at, routeId: link.route_id };
  });
  return tx();
}

/** Active (non-revoked, non-expired) links for a route. Never returns the token. */
function listShareLinks(routeId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, label, one_time, expires_at, redeemed_count, last_redeemed_at, created_at
    FROM route_auth_share_links
    WHERE route_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).all(routeId);
}

/** Revoke a link and delete its guest sessions. Returns false if not found / already revoked. */
function revokeShareLink(routeId, linkId) {
  const db = getDb();
  const tx = db.transaction(() => {
    const r = db.prepare(`
      UPDATE route_auth_share_links SET revoked_at = datetime('now')
      WHERE id = ? AND route_id = ? AND revoked_at IS NULL
    `).run(linkId, routeId);
    if (r.changes === 0) return false;
    db.prepare('DELETE FROM route_auth_sessions WHERE share_link_id = ?').run(linkId);
    return true;
  });
  return tx();
}
```

Then add `redeemShareLink`, `listShareLinks`, `revokeShareLink` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_redeem.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/shareLinks.js tests/share_links_redeem.test.js
git commit -m "feat: shareLinks atomic redeem + list + revoke"
```

---

### Task 6: Extend `runCleanup` to purge expired links + orphan sessions

**Files:**
- Modify: `src/services/routeAuth.js:22-55` (`runCleanup`)
- Test: `tests/share_links_cleanup.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  routeId = getDb().prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('c.example.com','10.0.0.8',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('runCleanup purges expired share links and their guest sessions', () => {
  const svc = require('../src/services/shareLinks');
  const routeAuth = require('../src/services/routeAuth');
  const db = getDb();
  const { id, token } = svc.createShareLink(routeId, { expiresInHours: 1, oneTime: false });
  const r = svc.redeemShareLink(token, '1.1.1.1');
  // force-expire both link and session into the past
  db.prepare("UPDATE route_auth_share_links SET expires_at = datetime('now','-2 hours') WHERE id = ?").run(id);
  db.prepare("UPDATE route_auth_sessions SET expires_at = datetime('now','-2 hours') WHERE id = ?").run(r.sessionId);
  routeAuth._runCleanupForTest();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_share_links WHERE id = ?').get(id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM route_auth_sessions WHERE id = ?').get(r.sessionId).c, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_cleanup.test.js`
Expected: FAIL (`routeAuth._runCleanupForTest is not a function`).

- [ ] **Step 3: Extend `runCleanup`.** In `src/services/routeAuth.js`, inside `runCleanup()` after the existing `expiredOtps` DELETE (line ~42), add — **sessions first, then links**:

```js
    // Orphan guest sessions of expired/revoked share links, then the links
    const expiredShareSessions = db.prepare(`
      DELETE FROM route_auth_sessions
      WHERE share_link_id IN (
        SELECT id FROM route_auth_share_links
        WHERE revoked_at IS NOT NULL OR expires_at <= datetime('now')
      )
    `).run();
    const expiredShareLinks = db.prepare(`
      DELETE FROM route_auth_share_links
      WHERE revoked_at IS NOT NULL OR expires_at <= datetime('now')
    `).run();
```

Add `expiredShareSessions: expiredShareSessions.changes, expiredShareLinks: expiredShareLinks.changes` to the `logger.debug({...})` payload. Then export a test hook at the bottom `module.exports` block:

```js
  _runCleanupForTest: runCleanup,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_cleanup.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/routeAuth.js tests/share_links_cleanup.test.js
git commit -m "feat: cleanup purges expired share links + orphan sessions"
```

---

### Task 7: Dedicated redeem rate-limiter

**Files:**
- Modify: `src/middleware/rateLimit.js` (add `shareRedeemLimiter`, export it)
- Test: covered indirectly by Task 8; add a one-line export assertion here.
- Test: `tests/share_links_ratelimit.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('shareRedeemLimiter middleware is exported', () => {
  const rl = require('../src/middleware/rateLimit');
  assert.equal(typeof rl.shareRedeemLimiter, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_ratelimit.test.js`
Expected: FAIL (`undefined`).

- [ ] **Step 3: Add the limiter.** In `src/middleware/rateLimit.js`, near the other route-auth limiters (after `routeAuthCodeLimiter`):

```js
// Guest share-link redeem. Generous (the 256-bit token defeats brute force;
// this is anti-noise/anti-DoS) and SEPARATE from the 5/15-min login limiter so
// legitimate guests behind one NAT don't 429 each other. req.ip is the real
// client IP (trust proxy 'loopback' + Caddy X-Forwarded-For).
const shareRedeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});
```

Add `shareRedeemLimiter` to the file's `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_ratelimit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/rateLimit.js tests/share_links_ratelimit.test.js
git commit -m "feat: dedicated share-redeem rate limiter"
```

---

### Task 8: Guest redeem endpoint `GET /route-auth/share/:token`

**Files:**
- Modify: `src/routes/routeAuth.js` (add the route; make `setSessionCookie` set explicit `path:'/'`)
- Test: `tests/share_links_redeem_endpoint.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let routeId;
beforeEach(async () => {
  await setup();
  routeId = getDb().prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('s.example.com','10.0.0.9',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('valid token → 302 to / + host-only gc.route.sid cookie + Referrer-Policy', async () => {
  const svc = require('../src/services/shareLinks');
  const { token } = svc.createShareLink(routeId, { expiresInHours: 5, oneTime: false });
  const res = await getAgent().get(`/route-auth/share/${token}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  const setCookie = (res.headers['set-cookie'] || []).join(';');
  assert.match(setCookie, /gc\.route\.sid=/);
  assert.match(setCookie, /Path=\//);
  assert.ok(!/Domain=/i.test(setCookie), 'cookie must be host-only (no Domain)');
});

test('invalid token → 200 generic page, no session', async () => {
  const res = await getAgent().get('/route-auth/share/deadbeef');
  assert.equal(res.status, 200);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM route_auth_sessions').get().c, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_redeem_endpoint.test.js`
Expected: FAIL (404, no such route).

- [ ] **Step 3a: Make the cookie path explicit.** In `src/routes/routeAuth.js`, in `setSessionCookie` (line ~74-81), add `path: '/'` to the options object (no `domain`, keep host-only):

```js
  res.cookie(COOKIE_SID, sessionId, {
    httpOnly: true,
    secure: config.app.baseUrl.startsWith('https'),
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
```

- [ ] **Step 3b: Add the redeem route** in `src/routes/routeAuth.js`. Add the require near the top imports:

```js
const shareLinks = require('../services/shareLinks');
const { routeAuthLoginLimiter, routeAuthCodeLimiter, shareRedeemLimiter } = require('../middleware/rateLimit');
```

(adjust the existing `routeAuthLoginLimiter, routeAuthCodeLimiter` import line to add `shareRedeemLimiter`).

Add the handler after the `/verify` route:

```js
// GET /route-auth/share/:token — redeem a share link (the token IS the
// credential; no login). Reached via the Caddy /route-auth/* sibling proxy
// (bypasses forward_auth), so it works even when the route is share-gated.
router.get('/share/:token', shareRedeemLimiter, (req, res) => {
  (async () => {
    res.set('Referrer-Policy', 'no-referrer');
    const result = shareLinks.redeemShareLink(req.params.token, req.ip);
    if (!result) {
      // Generic invalid/expired view — no enumeration signal.
      return res.status(200).render(`${res.locals.theme}/pages/route-auth-login.njk`, {
        domain: req.query.route || req.headers['x-forwarded-host'] || req.headers.host || '',
        redirect: '/', authType: 'share', shareInvalid: true,
        twoFactorEnabled: false, twoFactorMethod: null, is2faStep2: false,
        maskedEmail: '', routeCsrfToken: '', branding: null,
      });
    }
    const maxAge = new Date(result.expiresAt).getTime() - Date.now();
    setSessionCookie(res, result.sessionId, maxAge > 0 ? maxAge : 1000);
    return res.redirect('/');
  })().catch((err) => res.status(500).send(err.message));
});
```

Note: the `route-auth-login.njk` `shareInvalid` branch is added in Task 11; until then the page may render without the share copy, but the 200 + no-session assertions pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_redeem_endpoint.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/routeAuth.js tests/share_links_redeem_endpoint.test.js
git commit -m "feat: guest share-link redeem endpoint"
```

---

### Task 9: Reject `auth_type='share'` on credential endpoints

**Files:**
- Modify: `src/routes/routeAuth.js` (POST `/login`, `/send-code`, `/verify-code`)
- Test: `tests/share_links_credential_guard.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

beforeEach(async () => {
  await setup();
  const db = getDb();
  const routeId = db.prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('share.example.com','10.0.0.10',80,1)").run().lastInsertRowid;
  db.prepare("INSERT INTO route_auth (route_id, auth_type) VALUES (?, 'share')").run(routeId);
});
afterEach(teardown);

test('POST /route-auth/login on a share route → 404, no lockout side effects', async () => {
  const res = await getAgent().post('/route-auth/login')
    .type('form').send({ domain: 'share.example.com', email: 'x@y.z', password: 'p' });
  assert.equal(res.status, 404);
});
```

(Note: CSRF — the `/route-auth/login` POST checks a signed CSRF token; the guard must run **before** CSRF so an attacker without a token still gets 404. Place the `auth_type==='share'` check immediately after `getAuthByDomain` resolves, which is after the CSRF check in the current code. To keep the test simple and the guard meaningful, move the share check to right after `const authConfig = ... getAuthByDomain(domain)` and return 404 regardless of CSRF. Verify the CSRF check doesn't 403 first: if it does, the test should expect 403→ instead assert `!= 200` and no session. Prefer: add the share guard immediately after computing `domain` + `authConfig`, before CSRF, so 404 wins.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_credential_guard.test.js`
Expected: FAIL (likely 403 CSRF or 401, not 404).

- [ ] **Step 3: Add guards.** In `src/routes/routeAuth.js`, in each of POST `/login`, POST `/send-code`, POST `/verify-code`, immediately after the `const authConfig = domain ? getAuthByDomain(domain) : null;` line and its `if (!authConfig)` 404, add:

```js
    if (authConfig && authConfig.auth_type === 'share') {
      // Share routes have no password/OTP/TOTP flow — only token redeem.
      return res.status(404).json({ ok: false, error: req.t('route_auth.not_configured') });
    }
```

To make the guard win over CSRF for `/login` (so the test's no-token POST returns 404), compute `authConfig` and run this guard **before** the CSRF verification block in `/login`. For `/send-code` and `/verify-code`, place it right after their existing `if (!authConfig) 404`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_credential_guard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/routeAuth.js tests/share_links_credential_guard.test.js
git commit -m "feat: reject credential flows on share routes"
```

---

### Task 10: Admin API endpoints + Caddy regen + mount

**Files:**
- Create: `src/routes/api/shareLinks.js`
- Modify: `src/routes/api/index.js` (mount before `/routes`)
- Test: `tests/share_links_api.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let agent, csrf, routeId;
beforeEach(async () => {
  await setup();
  agent = getAgent(); csrf = getCsrf();
  routeId = getDb().prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('api.example.com','10.0.0.11',80,1)").run().lastInsertRowid;
});
afterEach(teardown);

test('create on a public route needs confirmGate, then returns the URL once', async () => {
  let res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, oneTime: false });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'needs_gate_confirm');

  res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, oneTime: false, confirmGate: true });
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^https:\/\/api\.example\.com\/route-auth\/share\/.+/);
  // route is now share-gated
  assert.equal(getDb().prepare("SELECT auth_type FROM route_auth WHERE route_id = ?").get(routeId).auth_type, 'share');
});

test('list never leaks the token; revoke works', async () => {
  await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, oneTime: false, confirmGate: true });
  let res = await agent.get(`/api/v1/routes/${routeId}/share-links`);
  assert.equal(res.status, 200);
  assert.equal(res.body.links.length, 1);
  assert.ok(!('token' in res.body.links[0]) && !('token_hash' in res.body.links[0]));
  const linkId = res.body.links[0].id;
  res = await agent.delete(`/api/v1/routes/${routeId}/share-links/${linkId}`).set('X-CSRF-Token', csrf);
  assert.equal(res.status, 200);
  assert.equal((await agent.get(`/api/v1/routes/${routeId}/share-links`)).body.links.length, 0);
});

test('403 without share_links feature', async () => {
  require('../src/services/license')._overrideForTest({ share_links: false });
  const res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, confirmGate: true });
  assert.equal(res.status, 403);
  require('../src/services/license')._overrideForTest({ share_links: true }); // reset
});

test('409 on a basic-auth route', async () => {
  getDb().prepare('UPDATE routes SET basic_auth_enabled = 1 WHERE id = ?').run(routeId);
  const res = await agent.post(`/api/v1/routes/${routeId}/share-links`).set('X-CSRF-Token', csrf)
    .send({ expiresInHours: 24, confirmGate: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'disable_basic_auth');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_api.test.js`
Expected: FAIL (404 — route not mounted).

- [ ] **Step 3a: Create `src/routes/api/shareLinks.js`:**

```js
'use strict';

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const { requireFeature } = require('../../middleware/license');
const shareLinks = require('../../services/shareLinks');
const { syncToCaddy } = require('../../services/routes');

// Mounted at /api/v1/routes/:id/share-links (mergeParams for :id)
const router = Router({ mergeParams: true });

function getRoute(routeId) {
  return getDb().prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
}

// POST / — create a share link (Pro: share_links)
router.post('/', requireFeature('share_links'), (req, res) => {
  (async () => {
    const routeId = Number(req.params.id);
    const route = getRoute(routeId);
    if (!route || !route.enabled) return res.status(404).json({ ok: false, error: 'not_found' });
    if (route.l4_listen_port) return res.status(409).json({ ok: false, error: 'l4_not_supported' });
    if (route.basic_auth_enabled) return res.status(409).json({ ok: false, error: 'disable_basic_auth' });

    const { expiresInHours, oneTime, label, confirmGate } = req.body || {};
    const hours = Number(expiresInHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
      return res.status(400).json({ ok: false, error: 'invalid_expiry' });
    }

    const db = getDb();
    const existingAuth = db.prepare('SELECT auth_type FROM route_auth WHERE route_id = ?').get(routeId);
    let gated = false;
    if (!existingAuth) {
      if (!confirmGate) return res.status(409).json({ ok: false, error: 'needs_gate_confirm' });
      gated = shareLinks.ensureShareGate(routeId);
    }

    const { token, expiresAt } = shareLinks.createShareLink(routeId, {
      expiresInHours: hours, oneTime: !!oneTime, label,
      userId: req.session && req.session.userId,
    });

    if (gated) {
      try { await syncToCaddy(); }
      catch (e) { logger.warn({ e: e.message }, 'caddy sync after share gate failed'); }
    }

    const url = `https://${route.domain}/route-auth/share/${token}`;
    res.status(201).json({ ok: true, url, expires_at: expiresAt });
  })().catch((err) => { logger.error({ err: err.message }, 'create share link'); res.status(500).json({ ok: false, error: req.t('common.error') }); });
});

// GET / — list active links (no token)
router.get('/', requireFeature('share_links'), (req, res) => {
  res.json({ ok: true, links: shareLinks.listShareLinks(Number(req.params.id)) });
});

// DELETE /:linkId — revoke
router.delete('/:linkId', requireFeature('share_links'), (req, res) => {
  const ok = shareLinks.revokeShareLink(Number(req.params.id), Number(req.params.linkId));
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

// POST /disable — turn sharing off (removes the share gate if present)
router.post('/disable', requireFeature('share_links'), (req, res) => {
  (async () => {
    const removedGate = shareLinks.disableSharing(Number(req.params.id));
    if (removedGate) { try { await syncToCaddy(); } catch (e) { logger.warn({ e: e.message }, 'caddy sync after disable'); } }
    res.json({ ok: true });
  })().catch((err) => res.status(500).json({ ok: false, error: req.t('common.error') }));
});

module.exports = router;
```

- [ ] **Step 3b: Mount it.** In `src/routes/api/index.js`, add **before** the `router.use('/routes', require('./routes'));` line (so the more-specific path matches first), next to the existing `/routes/:id/auth` mount:

```js
router.use('/routes/:id/share-links', require('./shareLinks'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/shareLinks.js src/routes/api/index.js tests/share_links_api.test.js
git commit -m "feat: share-links admin API (create/list/revoke/disable)"
```

---

### Task 11: Login-page `share` branch (both themes)

**Files:**
- Modify: `templates/default/pages/route-auth-login.njk`
- Modify: `templates/pro/pages/route-auth-login.njk`
- Test: `tests/share_links_login_page.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

beforeEach(async () => {
  await setup();
  const rid = getDb().prepare("INSERT INTO routes (domain, target_lan_host, target_lan_port, enabled) VALUES ('inv.example.com','10.0.0.12',80,1)").run().lastInsertRowid;
  getDb().prepare("INSERT INTO route_auth (route_id, auth_type) VALUES (?, 'share')").run(rid);
});
afterEach(teardown);

test('login page for a share route shows the invitation copy, no password form', async () => {
  const res = await getAgent().get('/route-auth/login?route=inv.example.com');
  assert.equal(res.status, 200);
  assert.match(res.text, /route_auth_share_invite|invitation|Einladung/i);
  assert.ok(!/name="password"/.test(res.text), 'no password field on a share route');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_login_page.test.js`
Expected: FAIL (renders empty/garbage or includes a password field).

- [ ] **Step 3: Add the branch.** In **both** `route-auth-login.njk` files, find the auth-method conditional (`{% if authType == 'email_password' %}` … chain). Add a leading branch so `share` short-circuits the password/OTP forms:

```jinja
{% if authType == 'share' %}
  <div class="ra-share-invite">
    <h2>{{ t('route_auth.share_invite_title') }}</h2>
    <p>{{ t('route_auth.share_invite_body') if not shareInvalid else t('route_auth.share_invalid_body') }}</p>
  </div>
{% elif authType == 'email_password' %}
  {# ...existing... #}
```

Keep the rest of the chain unchanged (the existing `{% elif %}`/`{% else %}` arms remain). Match each theme's existing markup/classes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/share_links_login_page.test.js`
Expected: PASS. (Add the three i18n keys in Task 13; until then `t()` echoes the key, which still satisfies the regex via the key name `route_auth.share_*` — but Task 13 must run before the final suite for proper copy.)

- [ ] **Step 5: Commit**

```bash
git add templates/default/pages/route-auth-login.njk templates/pro/pages/route-auth-login.njk tests/share_links_login_page.test.js
git commit -m "feat: share-route invitation login page"
```

---

### Task 12: Route-edit UI — share subsection, confirm, `'share'` coexistence

**Files:**
- Modify: `public/js/routes.js` (share subsection render + create/list/revoke/confirm wiring; `'share'` badge label at ~line 251; auth read-only state at ~line 1261)
- Modify: `templates/default/partials/modals/route-edit.njk` and `templates/pro/partials/modals/route-edit.njk` (container for the share subsection inside the auth section ~line 210)
- Test: manual (client-side); add a lightweight assertion that the auth badge maps `'share'`.

This task has no server test (pure client/template). Verify by lint + manual smoke in the finish step. Implement carefully against the conventions (no `innerHTML`).

- [ ] **Step 1: `'share'` auth badge + read-only state (no behavior break).**
  - In `public/js/routes.js` around line 251 where `methodLabels[r.route_auth_type]` builds the auth badge, ensure a `'share'` entry resolves to a localized label: add `share: (GC.t && GC.t['route_auth.method_share']) || 'Share link'` to the `methodLabels` map.
  - Around line 1261 (`var method = auth.auth_type || 'email_password'`), add: if `auth.auth_type === 'share'`, render a read-only note (`T('route_auth.share_managed','Managed by share links')`) and **skip** building the email/OTP/TOTP selector for that route.

- [ ] **Step 2: Add the share subsection container** to both `route-edit.njk` files, inside the auth section (near line 210), gated by the Pro flag:

```jinja
{% if license.features.share_links %}
<div class="form-section" id="share-links-section" data-route-id="">
  <label class="form-label">{{ t('route_auth.share_links_title') }}</label>
  <div id="share-links-list"></div>
  <button type="button" class="btn btn-sm" id="share-link-create">{{ t('route_auth.share_create') }}</button>
</div>
{% endif %}
```

- [ ] **Step 3: Wire the client logic** in `public/js/routes.js` (use `el()`/`createElement`/`textContent`, **never `innerHTML`**):
  - On opening the route-edit modal, set `#share-links-section`'s `data-route-id` and call `loadShareLinks(routeId)` → `GET /api/v1/routes/:id/share-links` → render rows (label, expiry, one-time/reusable, redeemed count, **Revoke** button).
  - `#share-link-create` opens a small inline form (expiry select `1`/`24`/`168` hours, one-time checkbox, optional label) → `POST /api/v1/routes/:id/share-links`.
    - On `409 needs_gate_confirm`: show a confirm dialog with the warning copy (`T('route_auth.share_gate_warning', ...)`) → retry with `confirmGate: true`.
    - On `201`: show the returned `url` **once** in a read-only field with a Copy button + warning (`T('route_auth.share_copy_warning', ...)`); refresh the list.
  - Revoke button → `DELETE /api/v1/routes/:id/share-links/:linkId` → refresh.
  - All POST/DELETE include `X-CSRF-Token: GC.csrfToken`.

- [ ] **Step 4: Lint**

Run: `npx eslint public/js/routes.js`
Expected: no errors (no `innerHTML`, no unused vars).

- [ ] **Step 5: Commit**

```bash
git add public/js/routes.js templates/default/partials/modals/route-edit.njk templates/pro/partials/modals/route-edit.njk
git commit -m "feat: share-links route-edit UI + share auth coexistence"
```

---

### Task 13: i18n (en + de) + GC.t whitelist

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/de.json`
- Modify: `templates/default/layout.njk`, `templates/pro/layout.njk` (GC.t whitelist)
- Test: `tests/i18n_parity.test.js` exists? Add/extend a parity check, else `tests/share_links_i18n.test.js` (new)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const keys = [
  'route_auth.method_share', 'route_auth.share_managed',
  'route_auth.share_invite_title', 'route_auth.share_invite_body', 'route_auth.share_invalid_body',
  'route_auth.share_links_title', 'route_auth.share_create',
  'route_auth.share_gate_warning', 'route_auth.share_copy_warning',
];
test('all share-link i18n keys exist in en + de', () => {
  for (const k of keys) {
    assert.ok(k.split('.').reduce((o, p) => o && o[p], en), `en missing ${k}`);
    assert.ok(k.split('.').reduce((o, p) => o && o[p], de), `de missing ${k}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/share_links_i18n.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the keys** to `src/i18n/en.json` and `src/i18n/de.json` under the existing `route_auth` object. English values e.g.:

```
"method_share": "Share link",
"share_managed": "Managed by share links",
"share_invite_title": "Private access",
"share_invite_body": "Open the share link you were given to access this service.",
"share_invalid_body": "This link is invalid or has expired — ask the owner for a new one.",
"share_links_title": "Share links",
"share_create": "Create share link",
"share_gate_warning": "This route is currently public. A share link makes it reachable only via share links — everyone reaching it by its domain (incl. over VPN) is locked out.",
"share_copy_warning": "Anyone with this link gets in. Copy it now — it won't be shown again."
```

German equivalents in `de.json` (translate appropriately).

- [ ] **Step 4: Whitelist client-read keys** in **both** `layout.njk` files, next to the existing `route_auth.method_*` lines (~line 61-63):

```jinja
'route_auth.method_share': {{ t('route_auth.method_share') | dump | safe }},
'route_auth.share_managed': {{ t('route_auth.share_managed') | dump | safe }},
'route_auth.share_links_title': {{ t('route_auth.share_links_title') | dump | safe }},
'route_auth.share_create': {{ t('route_auth.share_create') | dump | safe }},
'route_auth.share_gate_warning': {{ t('route_auth.share_gate_warning') | dump | safe }},
'route_auth.share_copy_warning': {{ t('route_auth.share_copy_warning') | dump | safe }},
```

- [ ] **Step 5: Run test to verify it passes + run any existing i18n parity test**

Run: `node --test --test-force-exit tests/share_links_i18n.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json templates/default/layout.njk templates/pro/layout.njk tests/share_links_i18n.test.js
git commit -m "feat: share-links i18n (en+de) + GC.t whitelist"
```

---

### Task 14: Docs + full verification + finish

**Files:**
- Create: `docs/feature-ephemeral-share-links.md`
- Test: full suite

- [ ] **Step 1: Write the feature doc** `docs/feature-ephemeral-share-links.md`: what it is, the "link = protection" model + the public-route lockout warning, the guest flow, admin endpoints, Pro gating, security properties (hash-only, atomic one-time, fail-closed, host-only cookie, no-referrer), the `auth_type='share'` mechanism + basic-auth incompatibility, and how to reach the upstream directly (LAN IP:port). Reference the spec.

- [ ] **Step 2: Run the FULL test suite**

Run: `node --test --test-force-exit tests/`
Expected: all pass (a pre-existing WireGuard peer test may be skipped on non-wg hosts — that's expected, see project notes). If any new test fails, fix before proceeding.

- [ ] **Step 3: Lint the whole change**

Run: `npx eslint src/ public/js/ tests/`
Expected: no errors.

- [ ] **Step 4: Commit docs**

```bash
git add -f docs/feature-ephemeral-share-links.md
git commit -m "docs: ephemeral share-links feature writeup"
```

- [ ] **Step 5: Finish the branch** — use the **superpowers:finishing-a-development-branch** skill (verify tests → push → open PR). Do NOT manually push before this step.

---

## Self-review notes (spec coverage)

- Data model + session column → Task 1. License flag → Task 2. Service (token/create/validity/gate/disable/redeem/list/revoke) → Tasks 3-5. Cleanup → Task 6. Rate limiter → Task 7. Redeem endpoint + cookie attrs + Referrer-Policy → Task 8. Credential guards (DA-r2 #7) → Task 9. Admin API + confirmGate + basic-auth reject + Caddy regen (DA-r2 #6, #2) → Task 10. Login share branch → Task 11. UI + `'share'` coexistence (DA #3) → Task 12. i18n + GC.t → Task 13. Docs + verify → Task 14.
- DA decisions: no session cap (Task 5 test asserts expiry = link expiry); host-only cookie + path:'/' + no-referrer (Task 8 test); idempotent gate (Task 4 test); enforcement row-driven not license-gated (verify() untouched — only creation gated). Token-not-logged: confirm the default request logger doesn't log full paths for `/route-auth/share/*`; if it does, add redaction in Task 8 (check `src/utils/logger`/morgan config during implementation).
- Open implementation check (flag if it bites): confirm `route_auth_sessions.email` is `NOT NULL` (it is) so `'share'` sentinel is valid; confirm `syncToCaddy` is the correct exported name in `src/services/routes.js` (used by `api/routeAuth.js`).
