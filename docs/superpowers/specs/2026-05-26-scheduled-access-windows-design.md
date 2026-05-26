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
Polymorphic target → no FK. On route/peer delete, the respective delete service deletes the rule rows
(`DELETE FROM access_rules WHERE target_type=? AND target_id=?`). `valid_from`/`valid_until` are
date-only (inclusive lower bound, **exclusive** upper bound at 00:00 of `valid_until`'s next day? — no:
**inclusive** day range: a rule with `valid_until='2026-06-01'` is active through the end of 2026-06-01
local time). State this explicitly to avoid off-by-one.

## Evaluation — `evaluate(targetType, targetId, now=new Date())`

Pure function over a target's rules. For `now`:
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
- Tick every **60 s**, and an explicit `reconcileNow()` call after any rule CRUD.
- Computes `evaluate()` for every target that has ≥1 rule, builds a **deny-set** (route ids + peer ids
  currently denied), and compares to the last-applied deny-set held in module state.
- **On change only** (the deny-set differs):
  - Rebuild + push the Caddy config (existing `caddyConfig` sync path).
  - Rebuild + apply the WireGuard config (existing peer-sync path).
  - Activity-log each target transition (`access_window_denied` / `access_window_allowed`).
- The deny-set is also consulted **at config-build time** (see below), so a rebuild triggered by any
  other cause (route edit, peer change) already reflects the current windows.

`caddyConfig` + WG generation call `accessRules.isDenied(targetType, id)` (which calls `evaluate` and
caches per build) when emitting each route/peer:

- **HTTP route denied:** replace the route's handler chain with a `static_response` 403 + a rendered
  "access window" page (Nunjucks, i18n, shows the human-readable schedule). Mirrors the existing
  maintenance-page render. forward_auth/route-auth is skipped for a denied route (the 403 short-circuits).
- **L4 route denied:** omit the L4 listener entirely (connection refused).
- **Peer denied:** omit its `[Peer]` block from the generated WG config. Effective inclusion =
  `peer.enabled === 1 AND !isDenied('peer', peer.id)` — the window gate is **separate** from the manual
  `enabled` flag (never mutates `peers.enabled`).

**Churn:** most ticks are no-ops (deny-set unchanged). A transition = one Caddy reload and/or one WG
reconfigure. Acceptable.

## Admin API (session + CSRF; `requireFeature('access_windows')`)

Mounted like `routeAuth`:
- `GET  /api/v1/routes/:id/access-rules` · `GET /api/v1/peers/:id/access-rules` — list a target's rules
  + the current `state` (allowed/denied) + next transition (optional).
- `POST /api/v1/routes/:id/access-rules` · `POST /api/v1/peers/:id/access-rules` — create
  `{ mode, schedule, valid_from?, valid_until?, label? }`. Validates: mode ∈ {allow,block};
  schedule parses (≥1 valid window via the parser); date bounds parse + `valid_from <= valid_until`.
  Then `accessReconciler.reconcileNow()`.
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
- `src/services/rdpMaintenance.js` — export `parseMaintenanceActive` is already exported; reuse it.
- `src/services/caddyConfig.js` — when building a route, consult `accessRules.isDenied('route', id)`;
  if denied, emit the 403 access-window handler (HTTP) / omit the L4 route.
- `src/services/caddyAccessWindow.js` (new, optional) — render the 403 access-window page (Nunjucks),
  mirrors `caddyMaintenance.renderMaintenancePage`.
- WG config generator (locate: the module that builds the `[Peer]` blocks / `wg syncconf`) — skip
  peers where `isDenied('peer', id)`.
- `src/routes/api/accessRules.js` (new) — the CRUD endpoints; mount in `src/routes/api/index.js` for
  both `/routes/:id/access-rules` and `/peers/:id/access-rules` (mergeParams, target_type from mount).
- `src/services/routes.js` + `src/services/peers.js` delete paths — cascade-delete rules.
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
