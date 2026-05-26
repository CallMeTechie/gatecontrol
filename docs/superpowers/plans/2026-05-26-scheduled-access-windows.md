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
test('date bounds: inactive after valid_until end-of-day', () => {
  addRule({ valid_until:'2026-06-01' });
  assert.equal(svc.evaluate('route',1,new Date(2026,5,1,23,59,59)).state, 'allowed');
  assert.equal(svc.evaluate('route',1,new Date(2026,5,2,10,0,0)).state, 'denied'); // allow rule out of date -> no applicable allow -> default... see note
});
test('disabled rule ignored', () => {
  const r = addRule({}); svc.updateRule(r.id, { enabled: 0 });
  assert.equal(svc.evaluate('route',1,MON10).state, 'allowed'); // back to default-open
});
```
NOTE on the date-bounds test: once the only allow rule is out of its date bounds, there are **no applicable allow rules and no block** → default-open (`allowed`). Assert that explicitly (it documents the truth-table). Adjust the assertion to `allowed` and add a separate case where an in-date block rule denies.
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
- [ ] **Step 2:** run → FAIL (no module). **Step 3:** create `src/services/caddySync.js` with the exact `pendingSync` coalescer currently in `monitor.js:21-36` (move it here, `require('./routes').syncToCaddy` lazily inside). Update `monitor.js` to `const { requestCaddySync } = require('./caddySync')` and delete its local copy. **Step 4:** PASS. **Step 5:** commit `refactor: shared coalesced requestCaddySync (caddySync.js)`.

Note for later tasks: route/peer CRUD + `license.enforceLimitsInternal` should call `requestCaddySync()` instead of `syncToCaddy()` directly where safe — but keep that change minimal and out of this task to avoid churn; the reconciler (Task 7) uses `requestCaddySync`.

---

### Task 6: WG generator deny-awareness

**Files:** Modify `src/services/peers.js` `_rewriteWgConfigInner` (line ~504); Test `tests/access_wg_deny.test.js`.

- [ ] **Step 1: failing test** — create an enabled peer + a current 'block' rule on it; assert the rewritten config omits its `[Peer]` block.
```js
// setup: insert peer (enabled=1) with a public_key; add access_rules block rule covering NOW for ('peer', peerId);
// call peers.rewriteWgConfig(); read the generated config file (config.wireguard.configPath) and assert the pubkey is absent.
```
(Find the config path + how existing WG tests read it — grep `tests/*wg*`, `tests/*peer*`. If no file in test env, assert `_rewriteWgConfigInner` filters the peer out by stubbing the writer; prefer the established WG-test approach.)
- [ ] **Step 2:** run → FAIL. **Step 3:** in `_rewriteWgConfigInner`, after loading `SELECT * FROM peers WHERE enabled = 1`, filter: `.filter(p => !require('./accessRules').isDenied('peer', p.id, new Date()))`. Capture `now` once at the top of the function. **Step 4:** PASS. **Step 5:** commit `feat: WG config omits access-denied peers`.

---

### Task 7: `accessReconciler` — tick, transitions, removePeer, orphan sweep, boot

**Files:** Create `src/services/accessReconciler.js`; wire `start()` into server boot (`src/server.js`); Test `tests/access_reconciler.test.js`.

- [ ] **Step 1: failing test** — drive transitions with a stubbed clock + stubbed sync/removePeer:
  - allow→deny transition for a peer calls `wireguard.removePeer(pubkey)` once and requests a caddy sync.
  - no-op tick (deny-set unchanged) does nothing.
  - `start()` issues `removePeer` for an already-denied peer in the **initial** deny-set (boot live-disconnect).
  - orphan sweep deletes a rule whose target no longer exists.
  Use dependency injection or `require` stubbing for `wireguard.removePeer` and `caddySync.requestCaddySync`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement: module state `lastDenied = new Set()` of `"type:id"`. `reconcile(now=new Date())`:
  1. orphan sweep: delete `access_rules` where target row missing.
  2. compute current deny-set over all targets that have rules (`evaluate`).
  3. diff vs `lastDenied`: for each newly-denied **peer**, `await wireguard.removePeer(pubkey)`; collect whether any route or peer changed.
  4. if changed: `await require('./caddySync').requestCaddySync()` (routes) and `await require('./peers').rewriteWgConfig()` (peers, via the chain); activity-log each transition.
  5. set `lastDenied`.
  `reconcileNow()` = `reconcile()`. `start()`: treat `lastDenied` as empty, run one `reconcile()` (so initial denied peers get `removePeer`), then `setInterval(reconcile, 60000).unref()`. `stop()` clears the interval. Wire `accessReconciler.start()` into the server start hooks (`src/server.js`, alongside the other startup tasks — after migrations/WG init).
- [ ] **Step 4:** PASS. **Step 5:** commit `feat: accessReconciler (transitions, live peer disconnect, orphan sweep)`.

---

### Task 8: caddyConfig integration — 403 page (HTTP) / omit listener (L4)

**Files:** Modify `src/services/caddyConfig.js` (`buildCaddyConfig`); Create `src/services/caddyAccessWindow.js`; Test `tests/access_caddy_build.test.js`.

- [ ] **Step 1: failing test** — build the config (the real exported builder, e.g. `buildCaddyConfig()`) for: a denied HTTP route → its server route handler is a `static_response` (403), not the reverse_proxy; an allowed route → normal; a denied L4 route → absent from the `layer4` app. Stub `accessRules.isDenied` to force states.
- [ ] **Step 2:** run → FAIL. **Step 3:** in `buildCaddyConfig`, capture `const now = new Date()` once; for each HTTP route, `if (require('./accessRules').isDenied('route', route.id, now))` → emit a route whose handler is `{ handler:'static_response', status_code:403, body: caddyAccessWindow.renderAccessWindowPage({...}), headers:{'Content-Type':['text/html; charset=utf-8']} }` instead of the normal handler chain (skip forward_auth). For L4 routes, exclude denied ones from `activeL4Routes`. Create `caddyAccessWindow.js` mirroring `caddyMaintenance.renderMaintenancePage` (render an "access window" njk page; reuse `gateway-offline.njk` or add a small template — keep it simple, i18n keys via the `t`=identity global).
- [ ] **Step 4:** PASS + run existing `tests/caddyConfig_*.test.js` to confirm no regression. **Step 5:** commit `feat: caddy emits 403 access-window page / omits denied L4`.

---

### Task 9: Cascade-delete rules on target delete (single + batch, in-transaction)

**Files:** Modify `src/services/routes.js` (delete + `batch('delete')`); Modify `src/services/peers.js` (delete + `batch('delete')`); Test `tests/access_cascade_delete.test.js`.

- [ ] **Step 1: failing test** — create a route + a peer, add rules to each; delete the route (single) and the peer (via batch); assert `access_rules` for both targets are gone.
- [ ] **Step 2:** run → FAIL. **Step 3:** in each delete path call `require('./accessRules').deleteForTarget('route'|'peer', id)` in the same statement sequence as the row delete (wrap in a `db.transaction` if the existing path isn't already transactional). **Step 4:** PASS. **Step 5:** commit `feat: cascade-delete access rules with route/peer`.

---

### Task 10: Admin API — `/api/v1/{routes|peers}/:id/access-rules`

**Files:** Create `src/routes/api/accessRules.js`; mount in `src/routes/api/index.js`; Test `tests/access_rules_api.test.js`.

- [ ] **Step 1: failing test** — CRUD happy path; 400 on bad mode / unparseable schedule / `valid_from>valid_until`; 403 without `access_windows` (override false); 404 unknown target; GET returns `state`.
- [ ] **Step 2:** run → FAIL. **Step 3:** create the router (`Router({mergeParams:true})`); derive `target_type` from a mount param or two mounts. POST validates via `parseSchedule` (reject `errors.length || !windows.length`) + mode + date order; calls `accessRules.createRule` then `require('../../services/accessReconciler').reconcileNow()`. GET lists rules + `evaluate().state`. PUT/DELETE update/delete + `reconcileNow()`. All `requireFeature('access_windows')`. Mount BEFORE `/routes` and `/peers`:
```js
router.use('/routes/:id/access-rules', require('./accessRules')('route'));
router.use('/peers/:id/access-rules', require('./accessRules')('peer'));
```
(Export a factory that closes over `target_type`, or read it from the path.)
- [ ] **Step 4:** PASS + regression on `api_routes_pin_unchanged` / peers tests. **Step 5:** commit `feat: access-rules admin API`.

---

### Task 11: i18n (en+de) + GC.t

**Files:** `src/i18n/{en,de}.json`; both `layout.njk`; Test `tests/access_windows_i18n.test.js`.

- [ ] Flat keys (en+de): `access.title`, `access.add_rule`, `access.mode_allow`, `access.mode_block`, `access.schedule`, `access.valid_from`, `access.valid_until`, `access.label`, `access.state_allowed`, `access.state_blocked`, `access.delete`, `access.err_schedule`, `access.err_date_order`, `access.page_title`, `access.page_body` (the 403 page). Test asserts `k in en && k in de` for the client-read subset; run `tests/i18n_update_keys.test.js`. Whitelist the client-read keys in both `layout.njk`. Commit `feat: access-windows i18n + GC.t`.

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
