# Gateway LAN Service Discovery (Roadmap #8)

The gateway scans its own LAN (passive mDNS + SSDP, optional active TCP-connect sweep) on demand and streams the result back to the server, where the admin can review discovered devices and turn them into routes in one click. Trivial onboarding of services behind a gateway, without any container capability changes (no `NET_RAW`) and without ever fetching anything from the discovered devices themselves.

## What it does

Per gateway with the feature licensed and enabled:

- A **"Discovered devices"** card on the gateway detail page with a *Scan LAN* button and a live-updating device list — each entry shows hostname, IP, MAC (where ARP knows it) and the open ports observed by mDNS / SSDP / the TCP sweep.
- A **"Discovery settings"** panel on the same page: enable toggle, active-port-scan toggle (with the LAN-IDS warning), subnet checkboxes (only subnets the gateway actually reports; non-primary ones gated by the multi-subnet add-on), category-mode (`Only selected` / `All except selected`) and category checkboxes.
- A **"LAN scannen / Vorschläge"** picker in the *Create route* modal when the target is a discovery-capable gateway with discovery enabled. Adopting a device fills LAN host + port, switches the modal to HTTP or L4 by port (HTTP-class ports → HTTP, others → L4), suggests a domain from the hostname (stripping `.local`), and prefills the WoL MAC when known.

Results stream in over the existing admin SSE channel, so a scan triggered in one tab shows up in another. The cached snapshot persists for 10 minutes in memory (lost on server restart by design).

## How it works

**Three-phase architecture** spanning two repos:

1. **Phase 1 — gateway telemetry** (`gatecontrol-gateway` 1.11.0). The gateway reports its physical-LAN subnets and a category catalogue in heartbeat telemetry: `lan_subnets: [{iface, cidr, primary}]` and `lan_discovery_categories: [{key, label}]`. The canonical `isPhysicalLan` filter excludes loopback, WireGuard (`wg*` / `gatecontrol0`), Docker (`docker*`/`br-*`/`veth*`) and overlays (`tailscale*`/`zt*`/`nebula*`).
2. **Phase 2 — gateway engine + endpoint** (`gatecontrol-gateway` 1.12.0). The gateway exposes `POST /api/lan-scan` (auth-gated by the existing `X-Gateway-Token`). The scan engine is a small composition under `src/discovery/`: a pure category resolver (selection → effective ports + passive-filter predicate), three injectable sources (passive mDNS via `multicast-dns`, passive SSDP M-SEARCH, optional active TCP-connect sweep + `/proc/net/arp` for MACs), an orchestrator that merges by IP and filters passive hits by category, a Bearer-authed results client that POSTs batches back, and a long-lived `ScanManager` (one scan at a time → 409, re-validates the requested subnets against the gateway's own physical-LAN interfaces, hard timeout, guarantees a terminal `done`, ignores late batches from a superseded scan). The capability flag `lan_discovery: true` is set in telemetry only here — never in Phase 1 — so a Phase-1-only gateway in a mixed fleet does not surface a dead button.
3. **Phase 3 — server backend + UI** (this PR). Five admin-side surfaces:
   - Migration #47 adds `discovery_enabled`, `discovery_active_scan`, `discovery_subnets`, `discovery_category_mode`, `discovery_categories` to `gateway_meta`.
   - `src/services/discoveryCache.js` — ephemeral per-peer cache with `current_request_id` reconciliation (matching → merge, non-matching while in-flight → drop, no-current → adopt for restart-safety), sanitisation (drops malformed entries, length-caps every untrusted string, lowercases MACs, caps at `MAX_DEVICES`/`MAX_PORTS_PER_DEVICE`), per-peer ingest rate limit (60/min), lazy orphan timeout, 10-minute display TTL.
   - `src/services/gateways.js` gains `notifyLanScan(peerId, …)` (Bearer POST to the gateway over the tunnel) plus `getDiscoverySettings` / `setDiscoverySettings`.
   - `POST /api/v1/gateway/discovery` — Bearer-authed ingest endpoint; sanitises, reconciles, then publishes a `gateway_discovery` event on the admin SSE stream (`/api/v1/events`, `requireAuth`). Per-path body cap raised to 512 kB for this route only.
   - Three admin endpoints (session + CSRF, gated by `requireFeature('gateway_lan_discovery')` AND the gateway's reported capability flag):
     - `PUT /api/v1/gateways/:id/discovery-settings` — saves settings. Subnets must be in the gateway's reported `lan_subnets`. Multi-subnet selection requires the `gateway_lan_discovery_multi_subnet` add-on; categories are filtered to those the gateway reports.
     - `POST /api/v1/gateways/:id/discover` — generates a UUID `request_id`, primes the cache, calls `notifyLanScan`, audit-logs `gateway_scan_triggered`, returns `202 {ok, request_id, subnets_scanned}` (or 409 capability/disabled/in-flight, or 502 if the gateway is unreachable, cancelling the cache entry). A `setTimeout(graceMs + 250).unref()` publishes a terminal `gateway_discovery` SSE if the gateway never reports `done`, so the UI spinner can never hang.
     - `GET /api/v1/gateways/:id/discovered` — read-only cache snapshot.

The UI lives in `public/js/routes.js` (modal picker) and `public/js/gateways.js` (detail cards), with `public/js/events.js` re-dispatching the SSE event as `gc:gateway_discovery`. All untrusted LAN strings render through `el()` (which uses `textContent`) — never `innerHTML`. The `window.GC.features.gateway_lan_discovery_multi_subnet` flag is injected by both theme layouts so the settings panel can gate non-primary subnet checkboxes without an extra fetch.

## Security posture

- **No `NET_RAW`.** The active source is a plain `node:net` TCP-connect sweep; MACs come from reading `/proc/net/arp`. Container capabilities are unchanged.
- **No SSRF.** SSDP `LOCATION` headers are parsed for `{host, port}` only — the URL is never fetched. mDNS uses `multicast-dns` on a specific LAN-interface IP; multicast is never bound to `0.0.0.0` or `wg*`.
- **Untrusted LAN data is validated and length-capped** at ingest. The server stores raw strings; the UI escapes them at render time.
- **Subnet whitelist at the route.** The server re-validates requested subnets against the gateway's own reported physical-LAN interfaces, plus a prefix-size cap (`GC_DISCOVERY_MAX_PREFIX`, default `/22`) — a misbehaving gateway can't trick the server into scanning a foreign or huge subnet.
- **Ingest is rate-limited** per peer (60 batches/min) and the body cap is 512 kB for the discovery endpoint specifically (16 kB elsewhere on the gateway router).
- **Ephemeral cache.** Discovery results are never persisted: lost on server restart by design.

## Licence flags

- `gateway_lan_discovery` (base) — gates the route-modal picker and the detail-page cards; without it, none of the UI renders and the admin endpoints return 403 / `feature_not_available`.
- `gateway_lan_discovery_multi_subnet` (add-on) — allows selecting more than the gateway's primary subnet on the settings panel; without it the `POST /:id/discover` clamps to the primary regardless of the saved selection.

Both flags default to `false` in `COMMUNITY_FALLBACK`.

## Deferred / out of scope

- **Live per-device re-probe on adopt** (spec §9.1). The route picker shows *"results from N min ago"* prominently instead and adopts directly. The existing per-host probe relays a gateway-health check, not an arbitrary host:port — a real re-probe needs a confirmed gateway endpoint that doesn't exist yet.
- **Cancel button while a scan is in flight.** Phase 3a's `force: true` on `POST /:id/discover` restarts a scan but there's no pure cancel; the orphan-timeout SSE clears the spinner instead.
- **"Already routed" badge on devices.** Needs the gateway's existing route list cross-referenced; the `already_routed` i18n key was intentionally deferred.
- **True raw-socket ARP sweep** (`NET_RAW`) to surface devices with no open common ports — listed as a backlog add-on.
- **Route-EDIT modal picker.** Phase 3b ships the CREATE-modal picker only (per spec §9.1 "primary").

## Files touched (Phase 3, server)

- DB: `src/db/migrationList.js` (migration #47).
- Services: `src/services/{discoveryCache,gateways,license}.js`.
- API: `src/routes/api/gateway.js` (Bearer ingest), `src/routes/api/gateways.js` (3 admin routes + fleet-payload `discovery` block), `src/app.js` (per-path body cap).
- UI: `src/i18n/{en,de}.json`, `templates/{default,pro}/layout.njk`, `templates/{default,pro}/pages/routes.njk`, `public/js/{events,routes,gateways}.js`.

_Design + plans: `docs/superpowers/specs/2026-05-27-gateway-lan-discovery-design.md`, `docs/superpowers/plans/2026-05-27-gateway-lan-discovery-phase{1-telemetry,2-engine,3a-server,3b-ui}.md` (local-only, gitignored)._
