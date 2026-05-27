# Scheduled Access Windows

Time-based access control for any proxied **route** (HTTP + L4) or **VPN peer**. Each target can carry
rules like "active Mon–Fri 09:00–17:00" or "blocked Sun 02:00–04:00 (maintenance)" or "contractor
access until 2026-06-01". Pro-tier (`access_windows`). Generalises the RDP maintenance-window concept
(reuses its schedule parser) to routes + peers, with per-rule allow/block polarity and optional
absolute date bounds. Roadmap #4.

Design + devil's-advocate decisions: `docs/superpowers/specs/2026-05-26-scheduled-access-windows-design.md`.

## Rule model

A rule (`access_rules` table) targets one route or peer and has:
- **mode** — `allow` (access permitted **only** during the window) or `block` (blocked during the window).
- **schedule** — recurring weekly windows, e.g. `Mo-Fr 09:00-17:00` (German/English day codes,
  `;`/newline-separated, day- and midnight-wraparound supported — same format/parser as RDP maintenance).
- **valid_from / valid_until** — optional `YYYY-MM-DD` absolute bounds (for temporary grants). Inclusive,
  in **server-local time**: `valid_until=2026-06-01` is active through 23:59:59 local on that day.
- **label**, **enabled**.

### Evaluation (`evaluate`, pure function of DB + clock)

For the current moment, over a target's enabled rules whose date bounds cover now:
1. If any **block** rule matches now → **denied** (block always wins).
2. Else if any **allow** rule applies → allowed only if some allow rule matches now, else denied.
3. Else (no applicable allow rule, no matching block) → **allowed** (default-open; the feature is opt-in
   per target).

So allow-rules define the *only* permitted windows; block-rules punch holes regardless.

## Enforcement

`buildCaddyConfig` and the WireGuard config generator consult `accessRules.isDenied(type, id, now)` at
**build time** — so the deny state is correct from the first config build (fail-closed across restarts,
including the `export-caddy-config.js` boot path and the boot WG rewrite). A cheap `anyRulesExist()`
short-circuit keeps the common no-rules case byte-identical / zero-cost.

- **HTTP route denied** → Caddy serves a `403` "access window" page (bilingual, shows the schedule)
  instead of proxying. forward_auth/basic_auth are skipped.
- **L4 route denied** → its listener is omitted (connection refused). This is a silent RST with no
  page (the only real L4 option); the "blocked now" badge + an activity-log entry compensate so
  support can tell "outside window" from an outage.
- **Peer denied** → omitted from `wg0.conf` **and** live-disconnected.

### `accessReconciler`

A 60-second reconciler (`src/services/accessReconciler.js`, started at boot, stopped on shutdown):
- Orphan-sweeps rules whose target no longer exists.
- Computes the current deny-set (peers gated on `enabled=1`), diffs it against the last applied set,
  and **on change only** requests a (coalesced, serialized) Caddy resync and a chained WG rewrite, and
  **calls `wireguard.removePeer(public_key)` directly** for newly-denied peers — because `wg syncconf`
  never removes a live peer; omitting it from the file alone would leave the tunnel connected.
- Activity-logs every transition (`access_window_denied` / `access_window_allowed`), including the
  full initial deny-set at boot (so boot-time denies, incl. L4, aren't silent).
- Also triggered immediately (`reconcileNow()`) after any rule create/update/delete.

Concurrency: `syncToCaddy` is internally serialized (a promise chain) so the reconciler, CRUD's
`withCaddySync`, and the monitor can't race `POST /load`. `removePeer` is invoked directly by the
reconciler (never through the coalesced sync) so a coalesced Caddy sync can't drop a disconnect.

## Admin API (session + CSRF; `requireFeature('access_windows')`)

- `GET  /api/v1/{routes|peers}/:id/access-rules` → `{ rules, state, rule }` (current state + matched rule).
- `POST /api/v1/{routes|peers}/:id/access-rules` → create `{ mode, schedule, valid_from?, valid_until?, label? }`
  (validates mode, schedule via `parseSchedule` — empty/garbage rejected so an `allow` rule can't
  silently lock the target out 24/7 — and `valid_from <= valid_until`).
- `PUT /…/:ruleId`, `DELETE /…/:ruleId`. All call `reconcileNow()`.

## UI

Route-edit and peer-edit modals get a Pro-gated "Access windows" subsection: a 🟢/🔴 state badge, the
rule list (mode chip, schedule, date bounds, label, delete), and an add-rule form (mode, schedule,
optional from/until dates, label). Safe-DOM only.

## Notes / limitations

- **Server-local time, no timezone field** — a window may drift ±1 h across a DST switch (documented,
  accepted), same as RDP maintenance.
- **L4 = connection refused** (no friendly page) — by design.
- **Worst-case latency** ≈ 60 s + boot for a peer that was live before a restart to be disconnected.
- **License-disabled peers** (`enabled=0` from limit enforcement) are not live-disconnected by this
  feature — that's a separate pre-existing path, intentionally out of scope here.
- RDP maintenance windows (`rdp_routes.maintenance_*`) remain separate; only the schedule parser is shared.
