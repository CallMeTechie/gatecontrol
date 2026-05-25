# Gateway Fleet Dashboard (Roadmap #2a)

A top-level **Gateways** page (`/gateways`) showing every gateway's heartbeat telemetry as cards, with a version-drift badge, a detail drilldown, and an on-demand fresh-health re-check. Built entirely from data the gateways already report — no new agent-side work.

## What it shows

Per gateway (card): status pill (online / degraded / offline / pending), name + host, **version + drift badge**, CPU-load / RAM / disk mini-bars, routes-reachable `x/y`, WG-handshake age, last-seen. Fleet KPIs at the top: total · online · degraded · offline · update-available. Click a card → drilldown with the full `last_health` JSON.

## How it works

- **Data:** `GET /api/v1/gateways` already returns each gateway's `status`, `last_seen_at` and full `health` (telemetry). The list response was extended with a fleet-level `latest_version` and a per-gateway `update_available` flag.
- **Drift detection:** `src/services/gatewayRelease.js` fetches the latest `gatecontrol-gateway` release tag from GitHub (`releases/latest`, normalised — leading `v` stripped), cached ~1 h, **non-blocking** (returns cached/`null` immediately, refreshes in the background; `NODE_ENV=test` short-circuits the real call). `src/utils/version.js` `compareVersions` does a **numeric** semver compare (so `1.10.0 > 1.9.0`); `update_available` = `compareVersions(latest, telemetry.gateway_version) > 0`. If the GitHub check is unavailable, `latest_version` is `null` → no badges + a "version check unavailable" note (so absent badges aren't read as "all current").
- **Status derivation:** the `status` field comes from `gateways.getHealthStatus` (the in-memory state machine: `online`/`offline`/`unknown`). The UI overlays **degraded** (`online` + `health.overall_healthy === false`) and **pending** (`unknown` / no `last_health`). Per-route LAN unreachability is informational, **not** a gateway-level "degraded" (a gateway is healthy even if an optional LAN target is down).
- **Re-check** (`POST /api/v1/gateways/:id/probe` → `gateways.refreshHealth`): calls the gateway's own `GET /api/status` over the WireGuard tunnel (reusing the existing `X-Gateway-Token` push-call pattern; bounded response, field-whitelisted). `/api/status` returns only the self-check (proxy/api/wg/dns/route-reachability/overall_healthy) — **not** telemetry/hostname/config_hash — so `refreshHealth` **merges** the fresh self-check onto the stored `last_health`, preserving telemetry. It feeds a **single** `recordProbeResult(peerId, reachable)` into the state machine (respecting its hysteresis/cooldown — no synthetic pumping); the status then converges over the next probe cycles. On connect failure it reports `reachable: false`.

## Live updates

`public/js/gateways.js` listens for the `gc:gateway` / `gc:reconnected` DOM events from Feature #1's SSE client and re-fetches the fleet (debounced ~1 s). When Feature #1 isn't present those events never fire and a 30 s poll keeps the page fresh — soft dependency, no hard requirement. The client uses safe DOM construction (`createElement` / `textContent` / `replaceChildren`, no `innerHTML`) and reads i18n from `window.GC.t` + CSRF from `window.GC.csrfToken`.

## Scope & licence

- **Community feature** — `COMMUNITY_FALLBACK.gateway_fleet = true` in `src/services/license.js`; no Pro gate, no template lock (consistent with other Community features).
- **Out of scope (sub-project 2b):** the **Update action** that actually performs a gateway update — the parked gateway auto-update (host cron/systemd + flag-file, Option A). The dashboard only surfaces the drift badge.

_Design + plan: `docs/superpowers/specs/2026-05-24-gateway-fleet-dashboard-design.md`, `docs/superpowers/plans/2026-05-24-gateway-fleet-dashboard.md`._
