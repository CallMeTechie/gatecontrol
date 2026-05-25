# Design Spec — Gateway Fleet Dashboard (Roadmap #2, sub-project 2a)

- **Date:** 2026-05-24
- **Status:** Approved design, hardened after design review → ready for implementation plan
- **Feature:** Roadmap #2 split into **2a (this spec): fleet dashboard** and **2b: gateway auto-update** (separate later cycle). The "Update" action belongs to 2b.
- **Repo:** gatecontrol (server) only.
- **Tier:** Community (all licence modes).
- **Soft dependency:** live updates consume the `gc:gateway` SSE events from Feature #1 (PR #93); falls back to polling if #1 isn't merged — not a blocker.
- **Revisions:** v1 initial · v2 hardened vs DA round-1 concerns 1–7 (§11) · v3 focused DA round-2 fixes A–D (§12) · v4 status-model reconciled to the real in-memory state machine (§4) — `getHealthStatus` (online/offline/unknown) + client `degraded`/`pending` overlay, and `refreshHealth` feeds `recordProbeResult`.

## 1. Overview

A top-level **Gateways** page giving a fleet overview built from telemetry every gateway already sends each heartbeat into `gateway_meta.last_health` (versions, CPU/RAM/disk, route reachability, health checks). Cards per gateway with a **version-drift badge**, a detail drilldown, and an on-demand **re-check** that pulls genuinely fresh health from the gateway.

**Goals**
- Surface the existing-but-hidden heartbeat telemetry at a glance.
- Flag gateways running behind the latest released gateway version (absolute drift).
- Reuse what exists: `GET /api/v1/gateways` already returns full `health`; the server already calls gateways over the tunnel (`gateways.js`); the GitHub release-fetch pattern exists in `client/update.js`.

**Non-goals (2a):** the Update action / performing updates (→ 2b); gateway config editing / pool management (already elsewhere).

## 2. Data sources & drift detection

- **Existing per-gateway data:** `GET /api/v1/gateways` returns, per gateway, `status`, `last_seen_at`, `api_port`, and full `health` (incl. `telemetry.gateway_version`). No change to obtain it.
- **New — latest-version lookup (`src/services/gatewayRelease.js`):** mirrors the cached GitHub `releases/latest` fetch in `client/update.js` for repo `CallMeTechie/gatecontrol-gateway` (env `GC_GATEWAY_REPO` override, reuses `GC_CLIENT_GITHUB_TOKEN`, ~1 h cache). `getLatestVersion()` returns a **normalised** semver string (strip a leading `v` from `tag_name` — gateway releases are tagged `vX.Y.Z`) or `null` on any failure (no false badge). Isolated service; does **not** touch `client/update.js`. **Non-blocking (Concern B):** `getLatestVersion()` returns the cached/last-known value (or `null`) immediately and refreshes in the background; the gateways list endpoint must never await a live GitHub call — a cold cache yields `null` (no badge yet), not a stalled request.
- **Correct version comparison (Concern 1):** a small pure helper `compareVersions(a, b)` (e.g. in `src/utils/version.js`) — split on `.`, compare `[major, minor, patch]` **numerically** element-wise (NOT lexically — `1.10.0 > 1.9.0`). Returns -1/0/1; treats unparseable input as equal (→ no badge). Unit-tested.
- **API change:** the gateways list response gains a fleet-level `latest_version` and a per-gateway boolean **`update_available`** computed **server-side** (`latest_version != null && compareVersions(latest_version, telemetry.gateway_version) > 0`). Computing it server-side keeps the (testable) comparison in one place; the UI just renders the badge from the boolean.

## 3. UI

New top-level page **Gateways** at `/gateways` (new sidebar nav item; `templates/{default,pro}/pages/gateways.njk`; client `public/js/gateways.js`).

- **Cards overview** (one per gateway): status pill, name + host, version + drift badge (from `update_available`), resource mini-bars (CPU load vs cores, RAM, disk), routes reachable `x/y` (informational — see §4), WG handshake age, config-sync, last-seen.
- **Detail drilldown:** a client-side detail panel/modal from the already-fetched gateway object (the list returns full `health` — no extra round-trip): full telemetry, the four health checks, per-route reachability table.
- **Re-check action (Concerns 2+3):** `POST /api/v1/gateways/:id/probe` calls a new `gateways.refreshHealth(peerId)` reusing the **existing** server→gateway call pattern in `gateways.js` (decrypt `push_token_encrypted`, `http.request` to `<tunnelIP>:<apiPort>/api/status` with `X-Gateway-Token`, short timeout, **bounded response size** — Concern C). The gateway's `/api/status` returns only the self-check (proxy/api/wg/dns / `route_reachability` / `overall_healthy`) — **NOT** `telemetry`/`hostname`/`config_hash` (those are heartbeat-only). So `refreshHealth` **MERGES** the fresh self-check fields onto the stored `last_health`, **preserving** `telemetry`/`hostname`/`config_hash` from the last heartbeat (Concern A), validates/whitelists the parsed fields, persists the merge, and returns the fresh gateway object. On connect failure it marks the gateway down and returns that. Net: fresh health + route-reachability on demand, recent telemetry retained (telemetry itself is heartbeat-cadence, ≤30 s old). The **Update** button is out of scope (2b). The UI POST sends the CSRF token (Concern 5).

## 4. Status derivation (Concern 4)

The API already returns `status` from `gateways.getHealthStatus(peerId)` — the in-memory health **state machine** (values: `online` / `offline` / `unknown`), the same source the rest of the UI uses. The page derives the displayed badge from that status **plus** the gateway's own health:
- **offline** — API `status === 'offline'`.
- **pending** — API `status === 'unknown'` or no `last_health` yet (never heartbeated). Rendered neutrally, not as a fault.
- **degraded** — API `status === 'online'` **but** `health.overall_healthy === false` (the gateway's *own* health: http-proxy / mgmt-api / wg-handshake / dns). **Per-route LAN unreachability does NOT set "degraded"** — a gateway is healthy even if an optional LAN target (e.g. a powered-off device) is down. Route reachability is shown informationally (`x/y` + drilldown), not as a gateway status.
- **online** — otherwise.

The `refreshHealth` re-check feeds the **same** state machine via a **single** `gateways.recordProbeResult(peerId, reachable)` call (consistent with the background prober — it does **not** pump synthetic failures or bypass the SM's hysteresis/cooldown). The endpoint returns `reachable` so the UI can surface a failed re-check immediately; the persisted `status` then converges through the SM over the next probe cycles (no instant flip from one probe — that would defeat the anti-flap design).

Fleet KPIs: total · online · offline · update-available · degraded.

## 5. Live updates (tie-in to Feature #1)

`public/js/gateways.js` listens for `gc:gateway` and `gc:reconnected` and re-fetches the fleet, with a **~1 s debounce** (Concern 6) so a burst of transitions (the `gc:gateway` event fires on every state transition) collapses into one refetch. If #1 isn't present the events never fire and a 30 s poll keeps the page fresh. No hard dependency.

## 6. Auth & licence

- `requireAuth` (session) on the page and the probe endpoint. The probe is a state-changing POST under the CSRF-guarded `/api/v1` mount → the UI sends the CSRF token (token-auth callers are exempt).
- Community feature: register `gateway_fleet: true` in `COMMUNITY_FALLBACK` (`src/services/license.js`); no Pro guard.

## 7. Error handling

- `gatewayRelease.getLatestVersion()` → `null` on fetch failure/timeout → no drift badges, **and the UI surfaces "latest-version check unavailable"** (a small header note/tooltip) so absent badges aren't mistaken for "all current" (Concern 7). A `logger.warn` is emitted on fetch failure.
- `refreshHealth(peerId)`: 404 for unknown/non-gateway peer; short timeout on the gateway call; connect failure → mark down + return; never throws to the client (non-blocking toast, card keeps last state).
- A gateway with no `last_health` yet renders as "pending", not a crashed card.

## 8. Files

**New:** `src/services/gatewayRelease.js`; `src/utils/version.js` (`compareVersions`); `templates/{default,pro}/pages/gateways.njk`; `public/js/gateways.js`; `tests/version.test.js`, `tests/gatewayRelease.test.js`, `tests/api_gateways_fleet.test.js`; `docs/feature-gateway-fleet.md`.

**Modified:** `src/routes/index.js` (`/gateways` page route + sidebar nav); `src/routes/api/gateways.js` (`latest_version` + per-gateway `update_available` in the list; `POST /:id/probe`); `src/services/gateways.js` (`refreshHealth(peerId)` reusing the existing tunnel-call pattern); `src/services/license.js` (`gateway_fleet` flag).

## 9. Testing

- `tests/version.test.js` — `compareVersions`: numeric ordering (1.10.0 > 1.9.0), equal, `v`-prefix already stripped upstream, unparseable → 0.
- `tests/gatewayRelease.test.js` — cache hit/miss; strips leading `v`; returns `null` on failure (mock https); does not throw.
- `tests/api_gateways_fleet.test.js` — list includes `latest_version` + per-gateway `update_available` (with a mocked latest); `POST /:id/probe` → 404 for non-gateway peer, persists + returns fresh health for a gateway (mock the tunnel call), connect failure → down; all authed (401 without session). Established tmp-DB + `createApp().listen(0)` harness, raw `http`, `NODE_ENV=test`.
- Client `public/js/gateways.js` browser-only (out of c8) → `node --check` + manual. CI 40 % line gate held by the service/util/API tests.

## 10. Out of scope (tracked)

- **2b — Gateway auto-update:** the Update button + `POST .../gateway/pull` + push event + companion flag-file handler + host cron/systemd + docs (parked Option A). Separate cycle.
- Per-gateway config editing, pool management.

## 11. Risk mitigations from design review (traceability)

| # | Concern | Addressed in |
|---|---------|--------------|
| 1 | Version compare wrong (lexical / `v`-prefix) | §2 (`compareVersions` numeric tuple + strip `v`, server-side, unit-tested) |
| 2 | No per-peer probe in `gatewayProbe` | §3 (re-check uses `gateways.refreshHealth` via the existing tunnel-call pattern, not `gatewayProbe`) |
| 3 | "Re-check" couldn't get fresh telemetry | §3 (calls the gateway's `GET /api/status` → genuine fresh health) |
| 4 | "degraded" on any unreachable route = alarm fatigue | §4 (degraded = own `overall_healthy` only; routes informational) |
| 5 | CSRF on probe POST | §3, §6 (UI sends CSRF token) |
| 6 | Live refetch storm | §5 (~1 s debounce) |
| 7 | GitHub dep degrades silently | §7 (surface "version check unavailable" + warn log) |

## 12. Risk mitigations from DA round 2 (traceability)

| # | Concern | Addressed in |
|---|---------|--------------|
| A | `refreshHealth` persisting `/api/status` clobbers telemetry | §3 (MERGE fresh self-check onto stored `last_health`, preserve telemetry/hostname/config_hash) |
| B | Cold-cache `getLatestVersion()` blocks the list endpoint | §2 (non-blocking: cached/null immediately, background refresh) |
| C | Trusting/persisting gateway `/api/status` (size/shape) | §3 (bounded response size, validate/whitelist fields before merge) |
| D | `compareVersions` edge cases | §2 + §9 (missing segments → 0, ignore `-suffix`, non-numeric → no badge; unit-tested) |

Testing additions for the above: `tests/api_gateways_fleet.test.js` asserts a `refreshHealth` merge keeps `telemetry` while updating `overall_healthy`/`route_reachability` (mock the gateway `/api/status`); `getLatestVersion()` returns immediately on a cold cache (no blocking await).
