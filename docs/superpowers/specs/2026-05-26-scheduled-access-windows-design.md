# Scheduled Access Windows — Design

**Date:** 2026-05-26 · **Roadmap:** #4 · **Repo:** server (`/root/gatecontrol`) · **Tier:** Pro (`access_windows`)
**Branch:** `feat/scheduled-access-windows`

## Goal

Time-based access control for **any proxied route (HTTP + L4) or VPN peer**: "active Mon–Fri 09–17",
"blocked Sun 02–04 (maintenance)", "contractor access until 2026-06-01". Generalises the existing
RDP maintenance-window concept (reuses its schedule parser) to routes + peers, with per-rule
allow/block polarity and optional absolute date bounds.

## Decisions (from brainstorming, locked)

- **Per-rule mode:** `allow` (access only during the window) or `block` (blocked during the window).
- **Targets:** routes (HTTP + L4) and VPN peers.
- **Schedule:** recurring weekly windows (`"Mo-Fr 09:00-17:00"` — reuse `rdpMaintenance` format/parser)
  **plus** optional `valid_from` / `valid_until` absolute date bounds (enables temporary grants).
- **Outside the permitted window:** HTTP → friendly **403** page ("access only Mon–Fri 09–17"); L4 →
  listener not served (connection refused); peer → removed from the WireGuard config (disconnected),
  re-added when the window opens.
- **Timezone:** server-local time (like RDP maintenance; no TZ field).
- **RDP maintenance** (`rdp_routes.maintenance_*`) stays separate for now; only the parser is shared.
  Unifying it is a possible follow-up.

## Data model — migration `access_rules`

```sql
CREATE TABLE IF NOT EXISTS access_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,          -- 'route' | 'peer'
  target_id INTEGER NOT NULL,         -- routes.id or peers.id (polymorphic; no FK)
  mode TEXT NOT NULL,                 -- 'allow' | 'block'
  schedule TEXT NOT NULL,             -- "Mo-Fr 09:00-17:00" (newline/';'-separated windows)
  valid_from TEXT,                    -- 'YYYY-MM-DD' or NULL (no lower bound)
  valid_until TEXT,                   -- 'YYYY-MM-DD' or NULL (no upper bound)
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_rules_target ON access_rules(target_type, target_id);
```
Polymorphic target → no FK. **Cascade-delete must cover every delete path** (DA-r1 #5): the single
`routes.delete`/`peers.delete` AND the **batch** `routes.batch('delete')` (routes.js:710) /
`peers.batch('delete')` (peers.js:645), each **inside the same DB transaction** as the row delete so
it can't half-commit. Because `routes`/`peers` use `INTEGER PRIMARY KEY` (rowid **reuse** is possible
without `AUTOINCREMENT` — verify in the migration), a leaked rule could later misfire on a reused id.
So the `accessReconciler` also runs a periodic **orphan sweep**: delete `access_rules` whose
`target_id` no longer exists for its `target_type`.

**Date-bound semantics (precise — no lexical string compares; DA-r1 #4):** `valid_from`/`valid_until`
are `'YYYY-MM-DD'`. Parse to **local civil time** (matching `parseMaintenanceActive`, which uses local
`getDay()/getHours()`): `from = new Date(y, m-1, d, 0,0,0,0)`, `until = new Date(y, m-1, d, 23,59,59,999)`.
A rule applies iff `(valid_from === null || now >= from) && (valid_until === null || now <= until)`.
So `valid_until='2026-06-01'` is active through **23:59:59.999 local on 2026-06-01** and inactive at
00:00 on 2026-06-02. Never compare the date string against a SQLite UTC `datetime('now')` timestamp.

## Evaluation — `evaluate(targetType, targetId, now=new Date())`

**`evaluate` is a PURE function of the DB rows + the clock** (DA-r1 #3) — it must NOT depend on the
reconciler's in-memory deny-set. The in-memory set is *only* an optimization to decide whether a
config push is needed; correctness (including the very first config build at boot, before the
reconciler has ticked) comes from `evaluate` reading the DB live. This guarantees the feature is
**fail-closed on restart**: a denied target stays denied from the first build, not "allowed until the
first tick."

For `now`:
1. Take `enabled = 1` rules whose date bounds cover `now`:
   `(valid_from IS NULL OR now >= start-of-day(valid_from)) AND (valid_until IS NULL OR now <= end-of-day(valid_until))`.
2. A rule **matches** if `parseMaintenanceActive(rule.schedule, now)` is true (weekly window covers now).
3. Resolve:
   - if any **block** rule matches → `'denied'` (block always wins).
   - else if there is **≥1 applicable allow rule** (enabled + in date bounds, regardless of whether it
     matches now): access is `'allowed'` iff some allow rule matches now, else `'denied'`.
   - else (no applicable allow rules, no matching block) → `'allowed'` (default-open).

Returns `{ state: 'allowed'|'denied', reason }`. Reason carries the matched/active rule for UI + logs.

**Truth table intent:** Allow-rules define the *only* permitted windows for that target; Block-rules
punch holes regardless of allow. No rules / only out-of-date rules ⇒ default allowed (feature is
opt-in per target).

## Enforcement — `accessReconciler`

A singleton interval service (mirrors the `monitor.js` pattern; `unref()`'d; `withRetry`-wrapped):
- Tick every **60 s**, and an explicit `reconcileNow()` after any rule CRUD.
- Computes `evaluate()` for every target that has ≥1 rule, builds a **deny-set** (route ids + peer ids
  currently denied), and diffs it against the last-applied set held in module state (optimization only).
- **On change only** (the deny-set differs):
  - Request a Caddy resync **through the shared serialized+debounced sync** (see Concurrency below).
  - Apply the WireGuard change **through the existing `_wgRewriteChain`** — and crucially, for each
    peer that just transitioned **allow→deny, call `wireguard.removePeer(peer.public_key)`** in
    addition to rewriting `wg0.conf`. `wg syncconf` only ADDS/UPDATES peers — it does **not** remove a
    live peer from the kernel interface (DA-r1 #1; cf. `peers.js` toggle/remove/checkExpiredPeers,
    which already call `removePeer`). Omitting the `[Peer]` block from the file alone leaves the
    contractor's tunnel connected forever — the control would fail open. deny→allow is handled by the
    normal `syncConfig` (it re-adds).
  - Activity-log each transition (`access_window_denied` / `access_window_allowed`), incl. L4 (DA-r1 #6).
- The deny-set is also consulted **at config-build time** (below), so a rebuild triggered by any other
  cause already reflects current windows.

`caddyConfig` + WG generation call `accessRules.isDenied(targetType, id)` (which calls `evaluate` and
caches per build) when emitting each route/peer:

- **HTTP route denied:** replace the route's handler chain with a `static_response` 403 + a rendered
  "access window" page (Nunjucks, i18n, shows the human-readable schedule). Mirrors the existing
  maintenance-page render. forward_auth/route-auth is skipped for a denied route (the 403 short-circuits).
- **L4 route denied:** omit the L4 listener from the generated `layer4` app (connection refused —
  the only real L4 option). This is a silent RST with no user-facing page, unlike HTTP. Compensate
  (DA-r1 #6): activity-log the L4 transition with the schedule in details, and surface the
  "blocked now" badge + next-transition in the route UI so support can distinguish "outside window"
  from an outage. Document this asymmetry in the feature doc.
- **Peer denied:** the WG config generator (`peers.js:_rewriteWgConfigInner`, today a bare
  `SELECT * FROM peers WHERE enabled = 1`) must become **deny-set-aware** — effective inclusion =
  `peer.enabled === 1 AND !isDenied('peer', peer.id)`. The window gate is **separate** from the manual
  `enabled` flag (never mutates `peers.enabled`). Plus the `removePeer` step above for live disconnect.

## Concurrency, serialization & boot order (DA-r1 #2, #3)

`syncToCaddy` (caddyConfig.js:629) and the WG rewrite are currently **not globally serialized** —
route/peer CRUD, the monitor's local coalescer, and `license.enforceLimitsInternal` already call them
independently. Adding the reconciler as a 4th uncoordinated caller risks racing `POST /load` (a stale
`previousConfig` rollback clobbering a good config) and, via the TLS self-test, an auto Caddy restart
that drops live connections — on a 60 s cadence near window boundaries.

**Required before/with this feature:** a single shared, **debounced + serialized** `requestCaddySync()`
(promote the monitor's `pendingSync` pattern into a shared module) that route/peer CRUD, license
enforcement, monitor, AND the reconciler all funnel through — no direct parallel `syncToCaddy`. All WG
writes go through the existing `_wgRewriteChain` (peers.js:496). The reconciler never builds its own
parallel sync path.

**Boot order:** migrations → `accessRules` queryable → `accessReconciler.start()` performs **one
synchronous reconcile before the server accepts traffic** → the first Caddy/WG build already consults
`isDenied`. Combined with the pure `evaluate`, this makes the feature fail-closed across restarts/redeploys.

**Churn:** most ticks are no-ops (deny-set unchanged). A transition = one debounced Caddy resync and/or
one chained WG reconfigure. Acceptable.

## Admin API (session + CSRF; `requireFeature('access_windows')`)

Mounted like `routeAuth`:
- `GET  /api/v1/routes/:id/access-rules` · `GET /api/v1/peers/:id/access-rules` — list a target's rules
  + the current `state` (allowed/denied) + next transition (optional).
- `POST /api/v1/routes/:id/access-rules` · `POST /api/v1/peers/:id/access-rules` — create
  `{ mode, schedule, valid_from?, valid_until?, label? }`. Validates (400 on any failure): mode ∈
  {allow,block}; **schedule via a new `parseSchedule(str) → { windows, errors }`** (separate from the
  match function) — reject if `windows.length === 0` **or** any line failed to parse. The existing
  parser silently `continue`s past bad lines; that must NOT pass validation, else an `allow` rule with
  an empty/garbage schedule denies the target **24/7** (self-lockout, DA-r1 #7). Validate date bounds
  parse + `valid_from <= valid_until`. Do **not** carry the RDP-era JSON-unwrap legacy branch into the
  new table. Then `accessReconciler.reconcileNow()`.
- `PUT /api/v1/.../access-rules/:ruleId` — edit. `DELETE /api/v1/.../access-rules/:ruleId` — remove.
  Both call `reconcileNow()`.

## UI

Route edit modal + peer edit modal: an "Access windows / Zeitfenster" subsection (Pro-gated, hidden
without `license.features.access_windows`):
- Current state badge: **🟢 allowed now** / **🔴 blocked now (rule X)**.
- List of rules: mode chip (allow/block), schedule, date bounds, label, enabled toggle, delete.
- Add-rule form: mode select, schedule input (with a hint of the `Mo-Fr 09:00-17:00` format + a small
  builder is out of scope — free-text with live validation), optional from/until date pickers, label.
- Safe-DOM client only (no innerHTML).

## License / i18n / tests

- `access_windows: false` in `COMMUNITY_FALLBACK`; `requireFeature('access_windows')` on the API;
  template lock on the UI subsection.
- i18n en+de for UI + the 403 "access window" page; GC.t whitelist for client strings.
- Tests:
  - `evaluate()`: allow-only (in/out window), block-only, allow+block precedence (block wins),
    date-bounds (before/after/within), no-rules default-allow, disabled rule ignored, multi-window
    schedule, midnight/day wrap (delegated to the shared parser but assert integration).
  - migration creates `access_rules`.
  - API: CRUD, validation (bad mode/schedule/date order → 400), 403 without `access_windows`, 404
    unknown target, reconcile-now called.
  - reconciler: deny-set transition triggers a (mocked) caddy + wg rebuild exactly once; no-op tick
    doesn't; activity-logged.
  - caddyConfig: a denied HTTP route emits the 403 static_response (not the reverse_proxy); a denied
    L4 route is omitted; an allowed route is normal.
  - WG generation: a denied peer is omitted; enabled+allowed peer present; disabled peer absent
    regardless of window.
  - **`removePeer` is called on an allow→deny transition** (mock `wireguard.removePeer`, assert it
    fires for the newly-denied peer — proves the live disconnect, not just file omission; DA-r1 #1).
  - **Boot fail-closed:** a target that should be denied *now* is denied on the very first config
    build (no in-memory state), before any reconciler tick (DA-r1 #3).
  - **Date off-by-one + DST:** `valid_until=today` → allowed 23:59:59 local, denied 00:00 next day;
    a window across a DST-switch day still evaluates (DA-r1 #4).
  - **`parseSchedule`:** empty string / all-garbage / partially-bad → `errors` non-empty / `windows`
    empty; an `allow` rule with such a schedule is rejected at the API (no 24/7 lockout; DA-r1 #7).
  - **Serialized sync:** concurrent reconcile + CRUD funnel through the shared debounced sync — no
    overlapping `POST /load` (DA-r1 #2). (May be a focused unit test on the shared sync module.)
  - **Batch delete + orphan sweep:** `routes.batch('delete')` / `peers.batch('delete')` remove the
    rules in-transaction; the reconciler's orphan sweep deletes rules for a vanished target (DA-r1 #5).
  - route/peer delete cascades the rules.
  - i18n parity.

## Edge cases

- Rule on a **disabled** route/peer: the route/peer isn't served anyway; rules are inert until enabled.
- `valid_from > valid_until`: rejected at the API (400).
- Empty/invalid schedule: rejected at the API (the parser must yield ≥1 window).
- Target deleted while denied: rules removed by the delete service; reconciler drops it from the deny-set.
- Reconciler missed tick (process busy): next tick reconciles; config-build-time `isDenied` keeps any
  other rebuild correct. Worst case a transition is applied up to ~60 s late — acceptable for access
  windows (document it).
- DST / clock jumps: server-local `new Date()`, same semantics as RDP maintenance; a window may be
  ±1 h around a DST switch — documented, accepted (no TZ handling).
- A route that is **both** route-auth'd and access-denied: the 403 access-window page wins (denied
  short-circuits before forward_auth).
- Mode `block` with an `allow` rule on the same target: block still wins when it matches.

## File structure

- `src/db/migrationList.js` — migration: `access_rules` (next version).
- `src/services/accessRules.js` (new) — CRUD + `evaluate` + `isDenied` (+ a small per-build cache).
- `src/services/accessReconciler.js` (new) — interval tick + `reconcileNow()` + deny-set diff +
  triggers caddy/wg rebuild + activity log; `start()/stop()` like the route-auth cleanup.
- `src/services/rdpMaintenance.js` — reuse `parseMaintenanceActive` for match; **add
  `parseSchedule(str) → { windows, errors }`** (loud validation; no silent line-skip; no JSON-unwrap).
- A shared **serialized + debounced Caddy sync** module (promote `monitor.js`'s `pendingSync` pattern,
  e.g. `src/services/caddySync.js`) used by CRUD, license enforcement, monitor, AND the reconciler
  (DA-r1 #2). WG writes reuse `peers.js` `_wgRewriteChain` + `wireguard.removePeer` on deny.
- `src/services/caddyConfig.js` — when building a route, consult `accessRules.isDenied('route', id)`;
  if denied, emit the 403 access-window handler (HTTP) / omit the L4 listener.
- `src/services/caddyAccessWindow.js` (new) — render the 403 access-window page (Nunjucks), mirrors
  `caddyMaintenance.renderMaintenancePage`.
- `src/services/peers.js` `_rewriteWgConfigInner` — make deny-set-aware (`enabled=1 AND !isDenied`);
  reconciler calls `removePeer` for allow→deny transitions.
- `src/routes/api/accessRules.js` (new) — the CRUD endpoints; mount in `src/routes/api/index.js` for
  both `/routes/:id/access-rules` and `/peers/:id/access-rules` (mergeParams, target_type from mount).
- `src/services/routes.js` + `src/services/peers.js` — cascade-delete rules in **both** single AND
  batch delete paths, in-transaction (DA-r1 #5).
- `public/js/routes.js` + `public/js/peers.js` + `templates/{default,pro}/...` — UI subsections.
- `src/services/license.js` — `access_windows` flag.
- `src/i18n/{en,de}.json` + both `layout.njk` — i18n + GC.t.
- App bootstrap (`src/app.js` / server start) — `accessReconciler.start()`.
- `docs/feature-scheduled-access-windows.md` — writeup.
- Tests: `tests/access_rules*.test.js`, `tests/access_reconciler.test.js`, caddy/wg integration tests.

## Out of scope

- Unifying RDP maintenance into `access_rules` (separate follow-up).
- Per-rule timezones / DST-correct scheduling.
- A graphical schedule builder (free-text `Mo-Fr 09:00-17:00` with validation only).
- Per-source-IP or per-user windows (target-level only).
