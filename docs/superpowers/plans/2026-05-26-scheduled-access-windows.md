# Scheduled Access Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Time-based access control (per-rule allow/block, weekly schedule + absolute date bounds) for proxied routes (HTTP+L4) and VPN peers, enforced by a reconciler that regenerates Caddy/WG config and live-disconnects denied peers.

**Architecture:** A pure `evaluate()` (DB rows + clock) decides allow/denied per target. `buildCaddyConfig` and the WG file generator consult `isDenied(type,id,now)` at build time (fail-closed across restarts). An `accessReconciler` (60 s tick + `reconcileNow()`) diffs the deny-set and, on change, requests a coalesced Caddy sync + a chained WG rewrite + `removePeer` for newly-denied peers. Design + devil's-advocate decisions: `docs/superpowers/specs/2026-05-26-scheduled-access-windows-design.md`.

**Tech stack:** Node.js, Express, better-sqlite3, Caddy admin API (HTTP + layer4), WireGuard (`wg syncconf` + `wg set … peer … remove`), Nunjucks, `node --test`, supertest.

**Conventions (read once):**
- Tests: `NODE_ENV=test node --test --test-force-exit <file>`. Harness `tests/helpers/setup.js` (supertest agent `getAgent()`, CSRF `getCsrf()`, `/api/v1` prefix, admin authed, `license._overrideForTest`). Clean `/tmp/gc-test-*` after big runs.
- Routes need NOT-NULL `target_ip`/`target_port`. i18n is FLAT dotted keys; client strings whitelisted in `templates/{default,pro}/layout.njk` GC.t and read as `(GC.t && GC.t['key']) || 'fallback'`. No `innerHTML` in client JS. Both themes for template edits. No `Co-Authored-By`. Don't push until the finish step.
- Reuse the schedule matcher `parseMaintenanceActive(schedule, now)` from `src/services/rdpMaintenance.js`. Server-local time.

---

### Task 1: Migration v46 — `access_rules`

**Files:** Modify `src/db/migrationList.js` (append after v45, before `]`); Modify `tests/helpers/setup.js` (add `access_windows: true` to the override); Test `tests/access_rules_migration.test.js`.

- [ ] **Step 1: failing test**
```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
beforeEach(setup); afterEach(teardown);
test('migration v46 creates access_rules', () => {
  const cols = getDb().prepare("PRAGMA table_info(access_rules)").all().map(c => c.name);
  for (const c of ['target_type','target_id','mode','schedule','valid_from','valid_until','label','enabled'])
    assert.ok(cols.includes(c), 'missing '+c);
});
```
- [ ] **Step 2:** run → FAIL (no table).
- [ ] **Step 3:** append migration object:
```js
  {
    version: 46,
    name: 'create_access_rules',
    sql: `
      CREATE TABLE IF NOT EXISTS access_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        mode TEXT NOT NULL,
        schedule TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_access_rules_target ON access_rules(target_type, target_id);
    `,
    detect: (db) => hasColumn(db, 'access_rules', 'mode'),
  },
```
- [ ] **Step 4:** add `access_windows: true,` to the `_overrideForTest({...})` block in `tests/helpers/setup.js`.
- [ ] **Step 5:** run → PASS. **Step 6:** commit `feat: add access_rules migration (v46)`.

---

### Task 2: License flag `access_windows`

**Files:** Modify `src/services/license.js` (COMMUNITY_FALLBACK); Test `tests/access_windows_license.test.js`.

- [ ] **Step 1: failing test**
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('access_windows defaults false', () => {
  assert.equal(require('../src/services/license').COMMUNITY_FALLBACK.access_windows, false);
});
```
- [ ] **Step 2:** run → FAIL. **Step 3:** add `access_windows: false,` next to `route_auth: false,` in `COMMUNITY_FALLBACK`. **Step 4:** PASS. **Step 5:** commit `feat: add access_windows community-fallback flag`.

---

### Task 3: `parseSchedule` — loud validation

**Files:** Modify `src/services/rdpMaintenance.js` (add + export `parseSchedule`); Test `tests/parse_schedule.test.js`.

Rationale: the existing `parseMaintenanceActive` silently skips bad lines; an allow-rule with a garbage schedule would deny 24/7. `parseSchedule` returns parsed windows + per-line errors so the API can reject loudly. **Do not** add the JSON-unwrap legacy branch.

- [ ] **Step 1: failing test**
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedule } = require('../src/services/rdpMaintenance');
test('valid multi-window schedule', () => {
  const r = parseSchedule('Mo-Fr 09:00-17:00; Sa 10:00-12:00');
  assert.equal(r.errors.length, 0);
  assert.equal(r.windows.length, 2);
});
test('empty schedule -> no windows', () => {
  const r = parseSchedule('   ');
  assert.equal(r.windows.length, 0);
});
test('garbage line -> error, no silent skip', () => {
  const r = parseSchedule('Montag 9-17');
  assert.ok(r.errors.length >= 1);
  assert.equal(r.windows.length, 0);
});
test('partially-bad -> reports the bad line', () => {
  const r = parseSchedule('Mo-Fr 09:00-17:00\nXX 99:99-00:00');
  assert.ok(r.errors.length >= 1);
});
```
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (reuse `SCHEDULE_LINE_RE` + `DAY_MAP`):
```js
function parseSchedule(str) {
  const windows = []; const errors = [];
  const lines = String(str || '').split(/[\n;]+/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(SCHEDULE_LINE_RE);
    if (!m) { errors.push(line); continue; }
    const [, dStart, dEnd, h1, m1, h2, m2] = m;
    if (DAY_MAP[dStart] === undefined || (dEnd !== undefined && DAY_MAP[dEnd] === undefined)) { errors.push(line); continue; }
    if (+h1 > 23 || +h2 > 23 || +m1 > 59 || +m2 > 59) { errors.push(line); continue; }
    windows.push({ dStart, dEnd: dEnd || dStart, h1: +h1, m1: +m1, h2: +h2, m2: +m2 });
  }
  return { windows, errors };
}
```
Add `parseSchedule` to `module.exports`.
- [ ] **Step 4:** PASS. **Step 5:** commit `feat: parseSchedule validator for access rules`.

---

### Task 4: `accessRules` service — `evaluate` (pure) + CRUD + `isDenied`

**Files:** Create `src/services/accessRules.js`; Test `tests/access_rules_eval.test.js`.

- [ ] **Step 1: failing test** (covers precedence, date bounds, disabled, default-open, allow-window in/out)
```js
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
let svc;
beforeEach(async () => { await setup(); svc = require('../src/services/accessRules'); });
afterEach(teardown);
function addRule(o) { return svc.createRule({ target_type:'route', target_id:1, mode:'allow', schedule:'Mo-Fr 09:00-17:00', ...o }); }
const MON10 = new Date(2026,5,1,10,0,0); // Mon 2026-06-01 10:00 local
const MON20 = new Date(2026,5,1,20,0,0);
const SUN10 = new Date(2026,5,7,10,0,0); // Sunday

test('no rules -> allowed (default open)', () => {
  assert.equal(svc.evaluate('route',1,MON10).state, 'allowed');
});
test('allow rule: in window allowed, out denied', () => {
  addRule({});
  assert.equal(svc.evaluate('route',1,MON10).state, 'allowed');
  assert.equal(svc.evaluate('route',1,MON20).state, 'denied');
  assert.equal(svc.evaluate('route',1,SUN10).state, 'denied');
});
test('block wins over allow', () => {
  addRule({});                                   // allow Mo-Fr 09-17
  addRule({ mode:'block', schedule:'Mo 09:00-12:00' });
  assert.equal(svc.evaluate('route',1,MON10).state, 'denied'); // block matches 10:00
});
test('date bounds: allow active through valid_until end-of-day; default-open after', () => {
  addRule({ valid_until:'2026-06-01' });                                   // allow Mo-Fr 09-17 until 2026-06-01
  assert.equal(svc.evaluate('route',1,new Date(2026,5,1,10,0,0)).state, 'allowed');  // Mon in window + in date
  assert.equal(svc.evaluate('route',1,new Date(2026,5,1,20,0,0)).state, 'denied');   // Mon out of window + in date
  // after valid_until the only allow rule is out of date -> no applicable allow, no block -> default-open
  assert.equal(svc.evaluate('route',1,new Date(2026,5,2,20,0,0)).state, 'allowed');
});
test('in-date block denies regardless of allow', () => {
  svc.createRule({ target_type:'route', target_id:1, mode:'block', schedule:'Mo 09:00-23:00', valid_until:'2026-06-30' });
  assert.equal(svc.evaluate('route',1,new Date(2026,5,1,10,0,0)).state, 'denied');
});
test('disabled rule ignored', () => {
  const r = addRule({}); svc.updateRule(r.id, { enabled: 0 });
  assert.equal(svc.evaluate('route',1,MON10).state, 'allowed'); // back to default-open
});
```
Truth-table reminder: once the only allow rule falls out of its date bounds, there are no applicable
allow rules and no matching block → **default-open** (`allowed`). The tests above assert this directly.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement `src/services/accessRules.js`:
```js
'use strict';
const { getDb } = require('../db/connection');
const { parseMaintenanceActive } = require('./rdpMaintenance');

function _dateActive(rule, now) {
  if (rule.valid_from) { const [y,m,d]=rule.valid_from.split('-').map(Number); if (now < new Date(y,m-1,d,0,0,0,0)) return false; }
  if (rule.valid_until) { const [y,m,d]=rule.valid_until.split('-').map(Number); if (now > new Date(y,m-1,d,23,59,59,999)) return false; }
  return true;
}
function rulesFor(targetType, targetId) {
  return getDb().prepare('SELECT * FROM access_rules WHERE target_type=? AND target_id=? AND enabled=1').all(targetType, targetId);
}
/** PURE: DB rows + clock only. */
function evaluate(targetType, targetId, now = new Date()) {
  const applicable = rulesFor(targetType, targetId).filter(r => _dateActive(r, now));
  const blocks = applicable.filter(r => r.mode === 'block');
  const allows = applicable.filter(r => r.mode === 'allow');
  for (const b of blocks) if (parseMaintenanceActive(b.schedule, now)) return { state:'denied', reason:{ rule:b } };
  if (allows.length > 0) {
    const hit = allows.find(a => parseMaintenanceActive(a.schedule, now));
    return hit ? { state:'allowed', reason:{ rule:hit } } : { state:'denied', reason:{ noAllowMatch:true } };
  }
  return { state:'allowed', reason:{ default:true } };
}
function isDenied(targetType, targetId, now = new Date()) { return evaluate(targetType, targetId, now).state === 'denied'; }
function listRules(targetType, targetId) {
  return getDb().prepare('SELECT * FROM access_rules WHERE target_type=? AND target_id=? ORDER BY id').all(targetType, targetId);
}
function createRule({ target_type, target_id, mode, schedule, valid_from, valid_until, label }) {
  const info = getDb().prepare(`INSERT INTO access_rules (target_type,target_id,mode,schedule,valid_from,valid_until,label) VALUES (?,?,?,?,?,?,?)`)
    .run(target_type, target_id, mode, schedule, valid_from||null, valid_until||null, label||null);
  return { id: Number(info.lastInsertRowid) };
}
function updateRule(id, fields) {
  const cols=[],vals=[]; for (const k of ['mode','schedule','valid_from','valid_until','label','enabled']) if (k in fields) { cols.push(`${k}=?`); vals.push(fields[k]); }
  if (!cols.length) return; cols.push("updated_at=datetime('now')"); vals.push(id);
  getDb().prepare(`UPDATE access_rules SET ${cols.join(',')} WHERE id=?`).run(...vals);
}
function deleteRule(id) { getDb().prepare('DELETE FROM access_rules WHERE id=?').run(id); }
function deleteForTarget(targetType, targetId) { getDb().prepare('DELETE FROM access_rules WHERE target_type=? AND target_id=?').run(targetType, targetId); }
module.exports = { evaluate, isDenied, listRules, createRule, updateRule, deleteRule, deleteForTarget };
```
- [ ] **Step 4:** PASS (fix the date-bounds assertion per the NOTE). **Step 5:** commit `feat: accessRules evaluate + CRUD (pure, fail-closed)`.

---

### Task 5: Shared coalesced Caddy sync

**Files:** Create `src/services/caddySync.js` (promote `monitor.js`'s `requestCaddySync`); Modify `src/services/monitor.js` to re-export/use it; Test `tests/caddy_sync_coalesce.test.js`.

Rationale (DA): one coalesced, serialized entry the reconciler + monitor + CRUD use, so concurrent callers don't race `POST /load`. Coalesced via `setImmediate` (NOT a timer) so a deny isn't delayed.

- [ ] **Step 1: failing test**
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('requestCaddySync coalesces concurrent calls into one syncToCaddy', async () => {
  const routes = require('../src/services/routes');
  let calls = 0; const orig = routes.syncToCaddy;
  routes.syncToCaddy = async () => { calls++; };
  try {
    const { requestCaddySync } = require('../src/services/caddySync');
    await Promise.all([requestCaddySync(), requestCaddySync(), requestCaddySync()]);
    assert.equal(calls, 1);
  } finally { routes.syncToCaddy = orig; }
});
```
(Run with `NODE_ENV=test`; this test stubs `routes.syncToCaddy` so it doesn't hit Caddy.)
- [ ] **Step 2:** run → FAIL (no module). **Step 3:**
  - Create `src/services/caddySync.js` with the exact `pendingSync` coalescer currently in
    `monitor.js:21-36` (move it here; `require('./routes').syncToCaddy` lazily inside). Update
    `monitor.js` to `const { requestCaddySync } = require('./caddySync')` and delete its local copy.
  - **Serialize `syncToCaddy` itself** (closes DA-r1 #2 for ALL callers without rerouting): add a
    module-level promise chain in `caddyConfig.js` around the read-prev → build → `POST /load` → verify
    → rollback critical section (mirror `peers.js:_wgRewriteChain`), so concurrent callers
    (CRUD's `withCaddySync`, the reconciler's `requestCaddySync`, monitor) run **one at a time** — no
    overlapping `/load`, no stale-`previousConfig` clobber. CRUD keeps `withCaddySync` (its DB-rollback
    semantics are preserved); the chain only serializes execution.
  - Add a test that two concurrent `syncToCaddy()` calls don't interleave (e.g. instrument an
    in-flight counter that never exceeds 1).
- [ ] **Step 4:** PASS. **Step 5:** commit `refactor: shared coalesced requestCaddySync + serialized syncToCaddy`.

Note: with `syncToCaddy` internally serialized, the reconciler safely uses `requestCaddySync` and CRUD
keeps `withCaddySync`; rerouting every caller is unnecessary. Document this in Task 13 (the
per-target non-overlap + internal serialization make the design race-free).

---

### Task 6: WG generator deny-awareness

**Files:** Modify `src/services/peers.js` `_rewriteWgConfigInner` (line ~504); Test `tests/access_wg_deny.test.js`.

- [ ] **Step 1: failing test** (`tests/access_wg_deny.test.js`). The test env has no WG config file and
  `_rewriteWgConfigInner` early-returns if the file is missing — so **seed a temp `GC_WG_CONFIG_PATH`
  with an `[Interface]` section BEFORE requiring the harness**, and **stub `wireguard.syncConfig` to a
  no-op** so it never shells out to a real `wg`. Peer INSERT must satisfy NOT-NULL `name`,
  `public_key`, `allowed_ips`.
```js
'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const wgFile = path.join(os.mkdtempSync(path.join(os.tmpdir(),'gc-wg-')), 'wg0.conf');
fs.writeFileSync(wgFile, '[Interface]\nPrivateKey = AA==\nListenPort = 51820\n');
process.env.GC_WG_CONFIG_PATH = wgFile;                 // BEFORE setup requires config
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
let peers, wireguard, origSync, peerId;
beforeEach(async () => {
  await setup();
  wireguard = require('../src/services/wireguard'); origSync = wireguard.syncConfig;
  wireguard.syncConfig = async () => null;              // no real `wg`
  peers = require('../src/services/peers');
  peerId = getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('p1','PUBKEY_P1=','10.8.0.5/32',1)").run().lastInsertRowid;
});
afterEach(() => { wireguard.syncConfig = origSync; teardown(); });

test('denied peer is omitted from the rewritten WG config; allowed peer present', async () => {
  await peers.rewriteWgConfig();
  assert.match(fs.readFileSync(wgFile,'utf8'), /PUBKEY_P1=/);          // allowed -> present
  require('../src/services/accessRules').createRule({ target_type:'peer', target_id:peerId, mode:'block', schedule:'Mo-So 00:00-23:59' });
  await peers.rewriteWgConfig();
  assert.doesNotMatch(fs.readFileSync(wgFile,'utf8'), /PUBKEY_P1=/);   // denied -> omitted
});
```
- [ ] **Step 2:** run → FAIL. **Step 3:** in `_rewriteWgConfigInner`, capture `const now = new Date()`
  at the top, then after `SELECT * FROM peers WHERE enabled = 1` add
  `.filter(p => !require('./accessRules').isDenied('peer', p.id, now))`. **Step 4:** PASS. (Also confirm
  during impl that `wireguard.syncConfig` is safe/no-op under `NODE_ENV=test`; the stub guards the test
  regardless.) **Step 5:** commit `feat: WG config omits access-denied peers`.

---

### Task 7: `accessReconciler` — tick, transitions, removePeer, orphan sweep, boot

**Files:** Create `src/services/accessReconciler.js`; wire `start()` into server boot (`src/server.js`); Test `tests/access_reconciler.test.js`.

- [ ] **Step 1: failing test** — stub `wireguard.removePeer` + `caddySync.requestCaddySync` +
  `peers.rewriteWgConfig` (count calls); insert peers/routes + rules; drive `reconcile(now)` with explicit clocks:
  - **allow→deny** for a peer calls `removePeer(peer.public_key)` once + requests a caddy sync; activity-logged.
  - **deny→allow** for a peer: peer no longer in deny-set, `rewriteWgConfig` called (re-adds); activity-logged `access_window_allowed`.
  - **no-op tick** (deny-set unchanged) calls neither removePeer nor requestCaddySync.
  - **`start()` boot:** an already-denied peer in the **initial** deny-set gets `removePeer` (empty `lastDenied` → treated as transition); an already-denied **L4 route** in the initial set is **activity-logged** (not silent).
  - **orphan sweep** deletes a rule whose target row no longer exists.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. Module state `lastDenied = new Set()` of `"type:id"`. `reconcile(now = new Date())`:
  1. **Orphan sweep — two explicit statements:**
     `DELETE FROM access_rules WHERE target_type='route' AND target_id NOT IN (SELECT id FROM routes)` and
     `DELETE FROM access_rules WHERE target_type='peer' AND target_id NOT IN (SELECT id FROM peers)`.
  2. Compute the current deny-set: `SELECT DISTINCT target_type,target_id FROM access_rules` → for each, `isDenied(type,id,now)`.
  3. Diff vs `lastDenied`. For each peer that became denied (in current, not in last), look up its key
     (`SELECT public_key FROM peers WHERE id=?`) and `await wireguard.removePeer(public_key)`. Track
     `routesChanged` / `peersChanged`. **Activity-log every transition in both directions** —
     `access_window_denied` / `access_window_allowed` with `{target_type, target_id, schedule}` — and on
     `start()`'s first run, log/disconnect the **entire** initial deny-set (since `lastDenied` is empty),
     so boot-time denies (incl. L4 routes) are not silent.
  4. If `routesChanged`: `await require('./caddySync').requestCaddySync()`. If `peersChanged`:
     `await require('./peers').rewriteWgConfig()` (serialized via `_wgRewriteChain`). `removePeer` is
     called **directly** (step 3), never through the coalesced sync, so it can't be dropped.
  5. `lastDenied = current`.
  `reconcileNow()` = `await reconcile()`. `start()`: run one `await reconcile()` (initial set treated as
  transitions), then `this._timer = setInterval(() => reconcile().catch(()=>{}), 60000); this._timer.unref();`.
  `stop()` clears the timer.
- [ ] **Step 3b: wire boot + shutdown.** In `src/server.js`, call `accessReconciler.start()` **alongside
  the other start hooks** (next to `startMonitor()` / `caddyReconciler.startReconciler()` in the
  `app.listen` callback — NOT gated on the deferred 2 s WG `setTimeout`; `start()`'s own initial
  `reconcile()` issues `removePeer` + a WG rewrite independently, and `_wgRewriteChain` serializes it
  against the boot rewrite, so order is safe). Add `accessReconciler.stop()` to the shutdown stoppers array.
- [ ] **Step 4:** PASS. **Step 5:** commit `feat: accessReconciler (transitions, live peer disconnect, orphan sweep, boot)`.

---

### Task 8: caddyConfig integration — 403 page (HTTP) / omit listener (L4)

**Files:** Modify `src/services/caddyConfig.js` (`buildCaddyConfig`); Create `src/services/caddyAccessWindow.js`; Test `tests/access_caddy_build.test.js`.

- [ ] **Step 1: failing test** — build the config (real builder, e.g. `buildCaddyConfig()`) for: a denied
  HTTP route → its server route handler is a `static_response` (403), not the reverse_proxy; an allowed
  route → normal; a denied L4 route → absent from the `layer4` app. Stub `accessRules.isDenied` to force
  states. Also assert the **no-rules common case** is unchanged (the existing `caddyConfig_contract`
  determinism + a fixture with no `access_rules` rows still byte-identical).
- [ ] **Step 2:** run → FAIL. **Step 3:**
  - In `buildCaddyConfig`, capture `const now = new Date()` once. **Short-circuit:** call
    `accessRules.anyRulesExist()` (a new cheap `SELECT 1 FROM access_rules LIMIT 1`) once; if false, skip
    all `isDenied` checks entirely → the no-rules path is a true no-op and output is byte-identical
    (protects the `caddyConfig_contract` determinism test + adds zero per-route query cost for the
    common case). Add `anyRulesExist()` to `accessRules.js`.
  - For each HTTP route, `if (rulesExist && require('./accessRules').isDenied('route', route.id, now))`
    → emit a route whose handler is `{ handler:'static_response', status_code:403, body: <html>,
    headers:{'Content-Type':['text/html; charset=utf-8']} }` instead of the normal chain (skip forward_auth).
  - For L4, exclude denied routes from `activeL4Routes` (gated on `rulesExist`).
  - Create `caddyAccessWindow.js` `renderAccessWindowPage(ctx)` mirroring
    `caddyMaintenance.renderMaintenancePage` BUT — since it renders server-side with `t = identity`
    (which returns the key, not localized text) — the template must **hardcode the human-readable
    copy** (a short bilingual DE/EN "Access is only permitted during the configured hours" page), NOT
    `t('access.page_title')`. The body must contain **no `now`/timestamp** string (determinism). Show
    the route's human-readable schedule (passed in `ctx`).
- [ ] **Step 4:** PASS + run existing `tests/caddyConfig_*.test.js` (esp. `caddyConfig_contract`) to confirm no regression. **Step 5:** commit `feat: caddy emits 403 access-window page / omits denied L4`.

---

### Task 9: Cascade-delete rules on target delete (single + batch, in-transaction)

**Files:** Modify `src/services/routes.js` (delete + `batch('delete')`); Modify `src/services/peers.js` (delete + `batch('delete')`); Test `tests/access_cascade_delete.test.js`.

- [ ] **Step 1: failing test** — create a route + a peer, add rules to each; delete the route (single
  `routes.remove`) and the peer (via `peers.batch('delete', [...])`); assert `access_rules` for both
  targets are gone. (For peers also test single `peers.remove`.)
- [ ] **Step 2:** run → FAIL. **Step 3:** all four paths — `routes.remove`, `routes.batch('delete')`,
  `peers.remove`, `peers.batch('delete')` — must delete the target's `access_rules` **in the same DB
  transaction** as the row delete. The single deletes (`routes.remove` ~607, `peers.remove` ~239) are
  **not** currently `db.transaction`-wrapped (their `withCaddySync`/rollback is a Caddy-failure
  compensator, not a transaction) → wrap `row-delete + deleteForTarget` in one `db.transaction(() => {…})`.
  The batch paths (`routes.batch` ~710, `peers.batch` ~646) likewise wrap the bulk `DELETE … WHERE id IN
  (…)` + a matching `DELETE FROM access_rules WHERE target_type=? AND target_id IN (…)`. **Note:** a
  later Caddy-sync rollback (`reinsertRouteRow`) restores the route row but **not** its rules — that's
  intentional and acceptable (a route being deleted has moot rules); do NOT attempt to snapshot/restore
  rules. **Step 4:** PASS. **Step 5:** commit `feat: cascade-delete access rules with route/peer`.

---

### Task 10: Admin API — `/api/v1/{routes|peers}/:id/access-rules`

**Files:** Create `src/routes/api/accessRules.js`; mount in `src/routes/api/index.js`; Test `tests/access_rules_api.test.js`.

- [ ] **Step 1: failing test** — CRUD happy path; 400 on bad mode / unparseable schedule (use a garbage
  schedule like `'Montag 9-17'`) / `valid_from>valid_until`; **403 without the flag** — the harness sets
  `access_windows: true`, so this case must `require('../src/services/license')._overrideForTest({ access_windows:false })`
  before the call and reset after; 404 unknown target; GET returns `{ rules, state, rule }` (the matched/active rule for the badge).
- [ ] **Step 2:** run → FAIL. **Step 3:** the router is a **factory** closing over `target_type`
  (`module.exports = (target_type) => { const router = Router({ mergeParams:true }); …; return router; }`)
  — note this differs from `routeAuth.js` (which exports a plain Router); don't copy its shape. POST
  validates via `parseSchedule` (reject if `errors.length || !windows.length`) + mode ∈ {allow,block} +
  date order; verifies the target row exists (404 else); `accessRules.createRule` then `await
  require('../../services/accessReconciler').reconcileNow()`. GET returns `{ ok, rules: listRules(...),
  state: evaluate(...).state, rule: evaluate(...).reason.rule || null }`. PUT/DELETE + `reconcileNow()`.
  All under `requireFeature('access_windows')`. Mount BEFORE `/routes` and `/peers`:
```js
router.use('/routes/:id/access-rules', require('./accessRules')('route'));
router.use('/peers/:id/access-rules', require('./accessRules')('peer'));
```
(Export a factory that closes over `target_type`, or read it from the path.)
- [ ] **Step 4:** PASS + regression on `api_routes_pin_unchanged` / peers tests. **Step 5:** commit `feat: access-rules admin API`.

---

### Task 11: i18n (en+de) + GC.t

**Files:** `src/i18n/{en,de}.json`; both `layout.njk`; Test `tests/access_windows_i18n.test.js`.

- [ ] Flat keys (en+de) for the **UI** (client): `access.title`, `access.add_rule`, `access.mode_allow`,
  `access.mode_block`, `access.schedule`, `access.valid_from`, `access.valid_until`, `access.label`,
  `access.state_allowed`, `access.state_blocked`, `access.delete`, `access.err_schedule`,
  `access.err_date_order`. (The 403 access-window PAGE is rendered server-side with `t = identity`, so
  its copy is **hardcoded bilingual in the njk template**, NOT i18n keys — Task 8.) Test asserts
  `k in en && k in de` for these keys (the existing `tests/i18n_update_keys.test.js` only checks
  hardcoded gateway lists, so it won't validate these — your own test is the real check; still run it to
  confirm no regression). Whitelist the client-read keys in both `layout.njk`. Commit `feat: access-windows i18n + GC.t`.

---

### Task 12: UI — access-windows subsection (routes + peers)

**Files:** `public/js/routes.js`, `public/js/peers.js`, `templates/{default,pro}/partials/modals/route-edit.njk`, the peer-edit modal; (client-only; verify via eslint + manual).

- [ ] Add a Pro-gated (`{% if license.features.access_windows %}`) "Access windows" subsection to the route-edit and peer-edit modals: a state badge (🟢/🔴 from `GET .../access-rules` → `state`), a rule list (mode chip, schedule, date bounds, label, delete button), and an add-rule form (mode select, schedule text input with `Mo-Fr 09:00-17:00` placeholder, optional from/until date inputs, label). Wire CRUD to `/api/v1/{routes|peers}/:id/access-rules` with `X-CSRF-Token: window.GC.csrfToken`. Safe-DOM only (`document.createElement`/`textContent`); map API error codes to localized text. `node --check` + CI-equivalent eslint (0 errors). Commit `feat: access-windows route/peer UI`.

---

### Task 13: Docs + full verify + finish

- [ ] Write `docs/feature-scheduled-access-windows.md` (model, allow/block precedence, date bounds, server-local time, the L4 silent-RST asymmetry, fail-closed-on-restart mechanism, license-disabled-peer out-of-scope note).
- [ ] Run the FULL suite `NODE_ENV=test node --test --test-force-exit tests/` (expect only the pre-existing `requires wg` failure). ESLint security scan 0 errors. Clean `/tmp/gc-test-*`.
- [ ] Use **superpowers:finishing-a-development-branch** (push + PR). Do not push earlier.

---

## Self-review notes (spec coverage)
- Migration → T1. License → T2. parseSchedule (loud) → T3. evaluate/CRUD/isDenied (pure, fail-closed) → T4. Shared coalesced sync → T5. WG deny-aware → T6. Reconciler (transitions + boot removePeer + orphan sweep) → T7. Caddy 403/L4-omit → T8. Cascade delete (single+batch) → T9. API → T10. i18n → T11. UI → T12. Docs/verify → T13.
- DA decisions honored: pure `evaluate` + build-time `isDenied(now)` = fail-closed (T4/T6/T8); `removePeer` on allow→deny + full initial deny-set at boot (T7); coalesced-not-debounced shared sync (T5); WG via `_wgRewriteChain` (T6/T7); cascade in batch paths (T9); loud schedule validation (T3/T10); next-transition deferred; license-disabled-peer out of scope (documented T13).
- Open checks for implementers: confirm `buildCaddyConfig` is the real exported builder name + how L4 routes are assembled (caddyConfig.js ~578-621); confirm the WG config path / how existing WG tests assert file contents; confirm `server.js` startup hook location for `accessReconciler.start()`; confirm `routes`/`peers` batch-delete transactional wrapping before relying on it.
