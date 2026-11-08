# Gateway Fleet Dashboard (Roadmap #2a)

A top-level **Gateways** page (`/gateways`) showing every gateway's heartbeat telemetry as cards, with a version-drift badge, a detail drilldown, and an on-demand fresh-health re-check. Built entirely from data the gateways already report — no new agent-side work.

## What it shows

Per gateway (card): status pill (online / degraded / offline / pending), name + host, **version + drift badge**, CPU-load / RAM / disk mini-bars, routes-reachable `x/y`, WG-handshake age, last-seen. Fleet KPIs at the top: total · online · degraded · offline · update-available. Click a card → drilldown with the full `last_health` JSON.

## How it works

- **Data:** `GET /api/v1/gateways` already returns each gateway's `status`, `last_seen_at` and full `health` (telemetry). The list response was extended with a fleet-level `latest_version` and a per-gateway `update_available` flag.
- **Drift detection:** `src/services/gatewayRelease.js` fetches the latest `gatecontrol-gateway` release tag from GitHub (`releases/latest`, normalised — leading `v` stripped), cached ~1 h, **non-blocking** (returns cached/`null` immediately, refreshes in the background; `NODE_ENV=test` short-circuits the real call). `src/utils/version.js` `compareVersions` does a **numeric** semver compare (so `1.10.0 > 1.9.0`); `update_available` = `compareVersions(latest, telemetry.gateway_version) > 0`. If the GitHub check is unavailable, `latest_version` is `null` → no badges + a "version check unavailable" note (so absent badges aren't read as "all current").
- **Status derivation:** the `status` field comes from `gateways.getHealthStatus` (the in-memory state machine: `online`/`offline`/`unknown`). The UI overlays **degraded** (`online` + `health.overall_healthy === false`) and **pending** (`unknown` / no `last_health`). Per-route LAN unreachability is informational, **not** a gateway-level "degraded" (a gateway is healthy even if an optional LAN target is down).
- **Re-check** (`POST /api/v1/gateways/:id/probe` → `gateways.refreshHealth`): calls the gateway's own `GET /api/status` over the WireGuard tunnel (reusing the existing `X-Gateway-Token` push-call pattern; bounded response, field-whitelisted). `/api/status` returns only the self-check (proxy/api/wg/dns/route-reachability/overall_healthy) — **not** telemetry/hostname/config_hash — so `refreshHealth` **merges** the fresh self-check onto the stored `last_health`, preserving telemetry. It feeds a **single** `recordProbeResult(peerId, reachable)` into the state machine (respecting its hysteresis/cooldown — no synthetic pumping); the status then converges over the next probe cycles. On connect failure it reports `reachable: false`.

## Versions and manual (`#versions`, `#handbook`)

The page's buttons **Versionen** and **Handbuch** open a view built from the plugin area's blocks (`pgx-*` classes, the tabs "Versionen" / "Handbuch" of a plugin), `public/js/gateway-docs.js` + the pure `public/js/gateway-docs-kit.js`:

- **Versions** — `GET /api/v1/gateways/releases[?from=X.Y.Z][&refresh=1]` (`src/services/gatewayReleaseNotes.js`): the GitHub releases of `gatecontrol-gateway` (`/releases?per_page=60`, the same source as the drift check; drafts and pre-releases left out), notes cleaned of "What's Changed", "by @user in …/pull/N" (→ `(#N)`), conventional-commit prefixes and "Full Changelog". Cached in memory and in `gateway-releases.json` next to the database, checked every 6 h with an ETag (a 304 is free of the API limit), "Neu laden" at most once a minute. Offline: the last list with `stale: true` (banner) or `available: false` (hint + link to GitHub). The notes are untrusted text — the page renders them with `GCPluginsUI.noteLines` as text nodes, like plugin release notes. `since` = the versions after `from` up to the latest: "Was ist neu?" next to "Update auf X verfügbar" on the card, in the state card and in the "Mehr" menu (`#versions/<installed>`); the rows say which gateway runs which version.
- **Manual** — `GET /api/v1/gateways/handbook?lang=` (`src/services/gatewayHandbook.js`): chapters 3–7 of `docs/handbuch` / `docs/guide` as one document through the plugin handbooks' safe renderer (`src/services/plugins/markdown.js`), with the table of contents (levels 1–2). Links between these chapters become in-app anchors, other links point to the guide on GitHub; `anchors` maps every `<file>#<GitHub anchor>` to the in-app anchor, so a help topic of `public/js/handbook.js` opens its heading (`#handbook/gw.rpi` → `#handbook/3-3-raspberry-pi`). The help links of the page (`a[data-guide]`) open the in-app manual; inside the assistant in a new tab (the assistant stays open); their `href` stays the GitHub address (middle click, no script). The image keeps `docs/handbuch` and `docs/guide` (`.dockerignore` exceptions).

## Live updates

`public/js/gateways.js` listens for the `gc:gateway` / `gc:reconnected` DOM events from Feature #1's SSE client and re-fetches the fleet (debounced ~1 s). When Feature #1 isn't present those events never fire and a 30 s poll keeps the page fresh — soft dependency, no hard requirement. The client uses safe DOM construction (`createElement` / `textContent` / `replaceChildren`, no `innerHTML`) and reads i18n from `window.GC.t` + CSRF from `window.GC.csrfToken`.

## Scope & licence

- **Community feature** — `COMMUNITY_FALLBACK.gateway_fleet = true` in `src/services/license.js`; no Pro gate, no template lock (consistent with other Community features).
- **Out of scope (sub-project 2b):** the **Update action** that actually performs a gateway update — the parked gateway auto-update (host cron/systemd + flag-file, Option A). The dashboard only surfaces the drift badge.

_Design + plan: `docs/superpowers/specs/2026-05-24-gateway-fleet-dashboard-design.md`, `docs/superpowers/plans/2026-05-24-gateway-fleet-dashboard.md`._
