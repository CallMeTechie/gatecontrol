# Design Spec — Gateway LAN Service Discovery (#8)

**Date:** 2026-05-27
**Status:** Draft for review
**Repos:** `gatecontrol` (server) + `gatecontrol-gateway` (companion)
**Tier:** Pro

---

## 1. Purpose & success criteria

Make onboarding services behind a gateway trivial. Instead of manually typing a LAN
host/port when creating a gateway-targeted route, the admin clicks **"LAN scannen"**, the
gateway discovers devices/services on its own LAN, and the UI suggests them — one click
pre-fills the route's `target_lan_host` / `target_lan_port` (+ WoL MAC when known) and
classifies HTTP vs L4.

**Done when:** an admin with a Pro licence, having enabled discovery on a gateway, can scan
that gateway's LAN from the route-create modal, see discovered devices stream in live, and
create a working route from a discovered device in one click — without ever typing an IP.

**Non-goals (explicitly out of scope, see §12):**
- True raw-socket **ARP** sweep (`NET_RAW`) — deferred to backlog; v1 uses a TCP-connect
  sweep that needs no extra container capability.
- **Persistent** LAN inventory / drift detection / "new device" alerts — results are ephemeral.
- Scanning arbitrary / free-text ranges — only subnets the gateway reports on its own interfaces.

---

## 2. Key decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Discovery method | **Hybrid**: passive mDNS + SSDP (always) + active TCP-connect sweep as a **separate opt-in** (`discovery_active_scan`, default off — §4.3) |
| 2 | Trigger / freshness | **On-demand** + short server-side cache (10 min TTL); no auto-scan on modal open |
| 3 | UI placement | **Route-create modal (primary)** + "Erkannte Geräte" section on gateway detail page |
| 4 | Consent / scope | **Opt-in per gateway** (default off), own auto-detected subnet only |
| 4b | Extended scope | Extra feature key unlocks selecting **additional gateway-reported subnets via checkbox** — never free-text |
| 5 | Server↔gateway delivery | **Asynchronous** — gateway returns `202`, streams results back via callback → SSE |
| 6 | Result persistence | **Ephemeral** — in-memory server cache, 10 min TTL; not stored in the DB |
| 7 | Capabilities | **No `NET_RAW`** — TCP-connect sweep + `/proc/net/arp` read for MACs; container caps unchanged |
| 8 | Port/service scope | **Service categories** (web/media/remote_access/file_sharing/printers/databases/iot) with an **include/exclude** mode + checkboxes; filters active **and** passive results. No free-text |
| 9 | Limits | **Subnet-size cap & scan timeout configurable** via gateway env (`GC_DISCOVERY_MAX_PREFIX` default `/22`, `GC_DISCOVERY_TIMEOUT_MS` default 45 s) |
| 10 | Gateway compatibility | UI shown only when the gateway emits a dedicated `lan_discovery: true` flag (set in Phase 2 when `/api/lan-scan` exists) — not licence, not a min-version constant; mixed-fleet safe |
| 11 | Ingest trust | LAN data is untrusted: server validates/clamps device payloads, rate-limits ingest per peer, escapes all LAN-origin strings on render (no stored XSS); `current_request_id` reconciliation (no cross-scan pollution) |

---

## 3. Architecture & data flow

```
[Admin]  ── "LAN scannen" ──▶  [Server]
 (route modal / GW detail)          │ POST /api/lan-scan {request_id, subnets[], timeout_ms}
                                    │ HTTP over WG tunnel · X-Gateway-Token (push token)
                                    ▼
                              [Gateway]  ── 202 {accepted, request_id} ──▶  (scans async)
                                    │ Hybrid scan: mDNS ∥ SSDP ∥ TCP-connect sweep
                                    │ batches every ~2 s + final
                                    │ POST /api/v1/gateway/discovery {request_id, devices[], done}
                                    │ Bearer GC_API_TOKEN
                                    ▼
                              [Server]  ── merge into ephemeral cache (10 min TTL, keyed by peer_id)
                                    │ ── publish SSE event `gateway_discovery` {peer_id, request_id, devices, done}
                                    ▼
                              [UI]  ── EventSource renders devices live; on reconnect → GET /discovered
                                    └▶ "Übernehmen" fills route fields + classifies HTTP/L4
```

The direct server→gateway tunnel call already exists for `notifyWol` / `notifyConfigChanged`
(`gateways.js`), and gateway→server Bearer auth already exists for the heartbeat — both
directions reuse established, authenticated channels.

---

## 4. Discovery engine (gateway — new module `src/discovery/`)

Three sources run in parallel, merged per device by IP.

### 4.1 Passive mDNS
- Query `_services._dns-sd._udp.local` (PTR) to enumerate advertised service types, then
  PTR/SRV/TXT per type; listen on `224.0.0.251:5353`.
- Dependency: `multicast-dns` (small, well-established).
- Yields: hostname, service type (`_http._tcp`, `_raop._tcp`, `_googlecast._tcp`, …), port, TXT hints.

### 4.2 Passive SSDP / UPnP
- Send `M-SEARCH * ssdp:all` to `239.255.255.250:1900`, collect unicast responses; parse
  `LOCATION`, `ST`, `SERVER`. Hand-rolled over `dgram` (the codebase already uses `dgram` for WoL).
- Yields: device URL/host, device type, server string.
- **Do not fetch the `LOCATION` URL** — only extract host:port from it. Fetching a LAN-controlled URL
  from the gateway (which sits on both the LAN and the tunnel) is an SSRF surface. If UPnP device XML
  is ever needed, bound size + timeout and never follow off-subnet redirects.

**Multicast egress binding (both passive sources) — required.** The companion runs
`network_mode: host` with WireGuard up, so a multicast socket without an explicit interface can
leave via `gatecontrol0` or a Docker bridge → silently zero results, or queries leaking over the
tunnel. Both mDNS and SSDP **must** bind the multicast socket to each detected physical-LAN
interface (`socket.setMulticastInterface()` / bind to the LAN IP; `addMembership(group, lanAddr)`)
and send once per LAN subnet. Multi-homed behaviour is explicitly tested (§13).

### 4.3 Active TCP-connect sweep (replaces raw ARP)
- For each host in the target subnet(s), attempt TCP connect to a **curated common-port list**
  with a short per-attempt timeout (~400 ms) and bounded concurrency.
- **Open** (SYN-ACK) ⇒ a routable service; **RST** ⇒ host alive but port closed (still useful as
  a liveness signal); no response ⇒ filtered/down.
- **No `NET_RAW` needed** — plain outbound TCP. This is the relevant signal anyway: we want
  *services* (host:port to proxy), not bare liveness.
- **MAC enrichment for WoL:** after the sweep, read `/proc/net/arp` (the connects populate the
  kernel ARP cache for same-subnet hosts) → map alive IP → MAC. No raw sockets.

The active sweep does not use a flat port list — the effective ports come from the **discovery
categories** (§4.4), so the admin controls exactly what is probed.

**Separately toggleable + conservative (refines decision #1).** The active sweep is a distinct
per-gateway switch `discovery_active_scan` (**default off**): enabling discovery gives the
near-zero-risk passive sources (mDNS/SSDP) immediately, while the active port-probe is a
deliberate, clearly-labelled opt-in. *Rationale:* an active LAN port-scan can trip a customer
IDS / segmentation appliance (UniFi/Firewalla/…) and get the **gateway** — the proxy for every
route at that site — quarantined, i.e. a site-wide outage. When enabled, the sweep stays gentle
(low concurrency default + small random jitter between connects) and the UI states plainly that
the gateway will actively scan the LAN.

### 4.4 Discovery categories — include / exclude (admin-controlled)
Discovery is scoped by **named service categories**, not a flat port list, so the admin can
deliberately decide what gets found (e.g. exclude IoT / smart-home devices). Each category
bundles the signals across all three sources — TCP ports (active sweep), mDNS service types, and
SSDP device-type patterns — so excluding a category also hides matching **passive** hits, not just
the active probe.

Default categories (defined gateway-side, env-overridable, reported to the server so the UI can
render checkboxes — **never free-text**):

| Category | TCP ports | mDNS types (examples) | SSDP (examples) | Route class |
|---|---|---|---|---|
| `web` | 80, 443, 8080, 8443, 8000, 8081, 3000, 5000 | `_http._tcp`, `_https._tcp` | — | HTTP |
| `media` | 32400, 8096, 8200 | `_googlecast._tcp`, `_airplay._tcp` | MediaServer/Renderer | HTTP |
| `remote_access` | 22, 3389, 5900 | `_ssh._tcp`, `_rfb._tcp` | — | L4 |
| `file_sharing` | 445, 139, 548, 2049, 21 | `_smb._tcp`, `_afpovertcp._tcp` | — | L4 |
| `printers` | 9100, 631, 515 | `_ipp._tcp`, `_pdl-datastream._tcp` | Printer | HTTP/L4 |
| `databases` | 5432, 3306, 6379, 27017 | — | — | L4 |
| `iot` | 1883, 5683, 8123 | `_hap._tcp`, `_matter._tcp`, `_hue._tcp` | WeMo/Belkin | L4 |

Per-gateway setting (stored server-side, §6.1):
- `discovery_category_mode`: **`include`** (probe/keep **only** the selected categories) or
  **`exclude`** (probe/keep **all** categories **except** the selected ones).
- `discovery_categories`: the selected category keys.
- **Default:** `include` with all categories selected ⇒ full scan out of the box; the admin
  unchecks the categories they don't want (e.g. `iot`), or switches to `exclude` and ticks them.

Applies to **all three sources**: the active sweep probes only the effective port set; passive
mDNS/SSDP results are filtered by category. **Uncategorised** passive hits (matching no known
category) are **always surfaced** — they're voluntarily advertised, low-noise, and hiding them
would defeat discovery.

### 4.5 Bounds & safety (gateway side)
- **Subnet-size cap — configurable:** the gateway refuses any subnet whose prefix is *shorter*
  (larger) than `GC_DISCOVERY_MAX_PREFIX` (default `/22`); raise or lower it per environment.
  Default scan target = the gateway's `primary` subnet (typically `/24`).
- **Scan timeout — configurable:** `GC_DISCOVERY_TIMEOUT_MS` (default 45 000) plus a concurrency
  cap `GC_DISCOVERY_CONCURRENCY` (default 128). A larger subnet just takes longer, still bounded
  by the timeout.
- **Interface guard (defense in depth):** the gateway scans **only** subnets that match one of its
  own non-VPN, non-Docker, non-loopback interfaces (validates the server-supplied `subnets[]`
  against `os.networkInterfaces()`); anything else is silently dropped from the scan set.
- Result batching: POST partial results every ~2 s (or every N devices), plus a final `done:true`.

### 4.6 Device record shape
```jsonc
{
  "ip": "192.168.1.20",
  "hostname": "nas.local",          // mDNS/SSDP name, fallback reverse-DNS, may be null
  "mac": "AA:BB:CC:DD:EE:FF",       // from /proc/net/arp, may be null
  "ports": [
    { "port": 5000, "source": "tcp",  "service_hint": null },
    { "port": 5357, "source": "ssdp", "service_hint": "WSD" },
    { "port": 80,   "source": "mdns", "service_hint": "_http._tcp" }
  ],
  "sources": ["mdns", "ssdp", "tcp"]
}
```

---

## 5. Server↔gateway protocol

### 5.1 Server → gateway (trigger)
`POST {gateway-tunnel-ip}:{api_port}/api/lan-scan`  ·  auth `X-Gateway-Token` (decrypted push token)
```json
{
  "request_id": "uuid",
  "subnets": ["192.168.1.0/24"],
  "category_mode": "include",
  "categories": ["web", "media", "remote_access", "file_sharing", "printers", "databases"],
  "timeout_ms": 45000
}
```
→ `202 { "accepted": true, "request_id": "uuid", "subnets_scanned": ["192.168.1.0/24"] }`
(or `409` if a scan is already in flight on that gateway; `403` if discovery disabled / invalid subnet).

### 5.2 Gateway → server (results callback)
`POST {serverUrl}/api/v1/gateway/discovery`  ·  auth `Bearer {GC_API_TOKEN}` (same as heartbeat)
```json
{ "request_id": "uuid", "devices": [ /* §4.6 */ ], "done": false }
```
- Server resolves `peer_id` from the authenticated **Bearer token** — results are always bound to
  that peer; a `peer_id` in the body is never trusted. This (not request_id strictness) is the
  authorization boundary: the gateway is the user's own, already-authenticated device. Results from
  a discovery-**disabled** peer are ignored.
- **request_id reconciliation (resolves the cancel ⇄ late-result tension):** the server holds one
  `current_request_id` per peer (set when it issues a scan via `POST /discover`).
  - a batch **matching** `current_request_id` is merged into that scan's set (dedupe by IP, union ports);
  - a batch with a **non-matching** request_id is **dropped while a current exists** — so a cancelled
    or superseded scan can never pollute a newer one;
  - if **no current exists** (server restarted mid-scan, or the scan was force-cancelled), a batch
    from an enabled peer is **adopted** as the new current — so an honest scan's late results aren't
    lost after a deploy. Each scan is its own set; a new request_id supersedes the previous set
    rather than merging across scans.
- **Ingest validation (LAN data is untrusted):** reject/clamp the payload — each `ip` a valid IPv4
  inside a scanned subnet, `port` ∈ 1–65535, `mac` well-formed; cap devices-per-scan, ports-per-
  device, batch count and total payload size; **rate-limit ingest per peer** (the request_id gate is
  no longer the throttle). LAN-origin strings (hostname, `service_hint`, SSDP `SERVER`) are stored
  raw but **escaped on render** (safe-DOM) — never interpolated into HTML.
- Server updates the peer's cache set and publishes the scoped SSE event.

### 5.3 SSE event (server → UI)
New event type on the existing `GET /api/v1/events` bus:
```
event: gateway_discovery
data: { "peer_id": 79, "request_id": "uuid", "devices": [...], "done": false, "timed_out": false }
```
**Authorization scoping:** the `/api/v1/events` stream is admin-only, and `gateway_discovery`
carries a sensitive LAN inventory — so it is delivered only to authorized admin sessions via the
EventBus filter, never fanned out to every subscriber. Where the bus allows, prefer delivering
only to sessions that own/triggered that gateway's scan (filter on `peer_id` / `request_id`).

### 5.4 Async robustness (the cost of decision #5 — must be handled)
- **In-flight tracking:** server keeps `{ peer_id → { request_id, started_at, subnets } }` in memory.
- **Orphaned-scan timeout:** if no `done` arrives within `timeout_ms + 15 s` grace, the server emits
  a terminal `gateway_discovery { done:true, timed_out:true }` and clears the in-flight entry, so the
  UI spinner never hangs forever.
- **SSE reconnect:** on (re)connect the client calls `GET /gateways/:id/discovered`, which returns the
  current cache **and** in-flight status, so a dropped SSE connection mid-scan recovers gracefully.
- **One scan per gateway at a time.** The gateway itself **rejects a concurrent `/api/lan-scan` with
  409** (its scan self-terminates within `GC_DISCOVERY_TIMEOUT_MS`); there is **no remote abort**.
  An explicit **cancel** clears the server's `current_request_id` + in-flight timer so the spinner
  never hangs — but a rescan issued immediately after may be briefly refused by the gateway
  ("Gateway scannt noch") until its in-flight scan ends. The UI shows "läuft seit Xs — abbrechen".
- **Server-restart caveat:** in-flight state is in memory; a restart drops `current_request_id`
  (late results are then adopted per §5.2). The UI distinguishes "no in-flight scan + empty cache"
  (offer a scan) from "scan completed, 0 devices" (show empty result) — it must never conflate the two.

---

## 6. Data model

### 6.1 Migration (server) — extend `gateway_meta`
```sql
ALTER TABLE gateway_meta ADD COLUMN discovery_enabled       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_meta ADD COLUMN discovery_subnets       TEXT;  -- JSON array of selected CIDRs; NULL = primary auto-detected only
ALTER TABLE gateway_meta ADD COLUMN discovery_category_mode TEXT NOT NULL DEFAULT 'include';  -- 'include' | 'exclude'
ALTER TABLE gateway_meta ADD COLUMN discovery_categories    TEXT;  -- JSON array of category keys; NULL = all categories (full scan)
ALTER TABLE gateway_meta ADD COLUMN discovery_active_scan   INTEGER NOT NULL DEFAULT 0;  -- 0 = passive only (mDNS/SSDP); 1 = also active TCP-connect sweep
```

### 6.2 Telemetry payload (gateway → server, gains one field)
The gateway reports its physical-LAN subnets so the UI can render the subnet checkboxes:
```jsonc
"lan_subnets": [ { "iface": "eth0", "cidr": "192.168.1.0/24", "primary": true } ]   // excludes wg/docker/vpn/loopback
```
Stored within the existing `last_health` JSON blob (no new column).
**"Primary"** = the subnet of the interface that carries the host default route (the gateway
already derives `default_gateway_ip` from `/proc/net/route`); exactly one subnet is flagged
`primary`. Without the multi-subnet feature key, only the `primary` subnet is selectable and
scannable.

The gateway also reports its **available discovery categories** (the §4.4 catalogue — keys +
labels only, not the port lists) in the same telemetry, so the settings UI renders the category
checkboxes without the server hard-coding them:
```jsonc
"lan_discovery_categories": [ { "key": "web", "label": "Web" }, { "key": "iot", "label": "IoT / Smart home" }, … ]
```
**Capability signal — a dedicated flag, set in Phase 2.** The gateway emits `lan_discovery: true` in
telemetry **only once the `/api/lan-scan` endpoint actually exists** (Phase 2, §11) — not merely when
it reports `lan_subnets`/categories (Phase 1 data). The server shows the discovery UI for a gateway
only when this flag is present — never on licence alone, and **not** on a hard-coded min-version
constant (which would just drift). Older gateways — and gateways still between Phase 1 and Phase 2 —
simply don't show the feature, instead of surfacing a button that 404s on `/api/lan-scan`.

### 6.3 Ephemeral result cache (server, in-memory)
```
discoveryCache: Map<peer_id, { request_id, updated_at, devices: Device[], done, timed_out }>
```
TTL 10 min (entry purged on read if stale). **Not persisted.** Lost on server restart → user re-scans.

---

## 7. Licensing

Add to `COMMUNITY_FALLBACK` in `license.js`:
```js
gateway_lan_discovery: false,            // Pro base: feature + per-gateway opt-in + own-subnet scan
gateway_lan_discovery_multi_subnet: false, // extra key: select additional gateway-reported subnets (checkbox)
```
- All discovery API endpoints guarded by `requireFeature('gateway_lan_discovery')`.
- The multi-subnet checkbox set is gated by `gateway_lan_discovery_multi_subnet`: without it, only the
  primary auto-detected subnet is selectable/scannable; the saved `discovery_subnets` is ignored down to
  the primary subnet at scan time. **Never any free-text input.**

---

## 8. Server API endpoints

All under `/api/v1/gateways/:id`, session + CSRF + `requireFeature('gateway_lan_discovery')`.

| Method | Path | Purpose |
|--------|------|---------|
| `PUT`  | `/discovery-settings` | `{ enabled, active_scan, subnets[], category_mode, categories[] }` — `subnets[]` validated ⊆ gateway-reported `lan_subnets` (multi-subnet gated by `gateway_lan_discovery_multi_subnet`); `active_scan` toggles the active TCP sweep (passive-only when false); `category_mode` ∈ {`include`,`exclude`}; `categories[]` validated ⊆ gateway-reported category keys. |
| `POST` | `/discover` | Trigger a scan. Requires `discovery_enabled` **and** the gateway reporting discovery capability (§6.2); resolves subnets (clamped to primary unless multi-subnet licensed) **+** `active_scan` **+** `category_mode`/`categories` from settings; `409` if already in flight unless `force:true` (cancels the stale in-flight); calls `notifyLanScan`. |
| `GET`  | `/discovered` | Return cached devices + in-flight status for this gateway (SSE-reconnect fallback). |

New service function `gateways.notifyLanScan(peerId, { subnets, active_scan, category_mode, categories, request_id, timeout_ms })`
mirrors the existing `notifyWol` (http.request over tunnel, X-Gateway-Token). It no-ops (returns a
clear "unsupported" result) if the gateway's telemetry doesn't signal discovery capability.

---

## 9. UI

### 9.1 Route-create modal (primary entry)
- When `target_kind = gateway` and a gateway is selected **and** it has `discovery_enabled` **and**
  reports discovery capability (§6.2), show a **"LAN scannen / Vorschläge"** button next to the
  LAN-host/port fields. (No capability → button hidden, not a dead 404 button.)
- No auto-scan on open: if cached results exist (<10 min) they render immediately; the button (re)scans.
- Results list streams in via SSE; each row shows hostname · IP · ports (with source badge) **and a
  "zuletzt gesehen vor X min" age**, and an **"Übernehmen"** action that:
  - **re-probes** the chosen `host:port` via the gateway's existing `/api/probe` first, so a stale
    (DHCP-moved) entry is caught instead of silently creating a route to the wrong host,
  - fills `create-route-lan-host` + `create-route-lan-port`,
  - pre-fills `create-route-wol-mac` **if a MAC is known** — MACs come from the ARP cache populated
    by the **active** sweep, so in the default passive-only mode they're absent unless the per-host
    re-probe above captures one; the WoL prefill simply doesn't appear when no MAC is available,
  - classifies the chosen port → **HTTP** (sets `https_enabled` for 443/8443) or **L4** route,
  - suggests a `domain` from the hostname.
- Devices/ports that already have a route on this gateway are flagged ("bereits geroutet").

### 9.2 Gateway detail page
The whole discovery block renders only for gateways that report discovery capability (§6.2).
- New **"Erkannte Geräte"** section (renders the cache) + a **"LAN scannen"** button.
- A **discovery settings** sub-panel:
  - enable toggle;
  - **active-scan toggle** (`discovery_active_scan`, default off) with an **inline warning** that the
    gateway will actively port-probe the LAN (may trip a LAN IDS); passive mDNS/SSDP run regardless;
  - **subnet checkboxes** (list = gateway-reported `lan_subnets`; multiple selection only enabled
    with `gateway_lan_discovery_multi_subnet`);
  - **category mode** toggle (`include` / `exclude`) + **category checkboxes** (list = the
    gateway-reported category catalogue) — e.g. uncheck `iot` to skip smart-home devices. No free-text.

### 9.3 i18n
All user-facing strings in `src/i18n/en.json` + `src/i18n/de.json` (parity), `gateways.discovery.*`
and `routes.suggested.*` key namespaces. Client strings exposed via `GC.t`.

---

## 10. Security & safety summary

- **Opt-in per gateway**, default off.
- **Scope:** only subnets the gateway reports on its own physical interfaces; multi-subnet via checkbox +
  extra key; **never free-text**. Gateway re-validates the server-supplied subnet set against its own
  interfaces (defense in depth — a buggy/compromised server can't make a gateway scan foreign ranges).
- **Caps:** subnet-size cap (`GC_DISCOVERY_MAX_PREFIX`, default `/22`) + scan timeout
  (`GC_DISCOVERY_TIMEOUT_MS`, default 45 s) + concurrency cap — all configurable; default target `/24`.
- **Service scope:** category include/exclude (no full 1–65535 scan); the filter applies to the active
  sweep **and** to passive mDNS/SSDP results, so an excluded category (e.g. `iot`) is genuinely hidden.
- **Active scan is opt-in (default off)** and clearly labelled — passive discovery (mDNS/SSDP) is
  near-zero-risk; the active port-probe is the only part that can trip a LAN IDS or quarantine the
  gateway, so it is a deliberate switch, run gently (low concurrency + jitter).
- **Capability-gated UI:** discovery surfaces only for gateways that report support + a minimum
  companion version — never on licence alone — so a mixed-version fleet can't reach a dead 404 button.
- **SSE scoping:** the discovery event is delivered only to authorized admin sessions (§5.3), not
  fanned out to every subscriber.
- **Untrusted LAN data:** discovered records are validated/clamped on ingest (IP within subnet, port
  range, MAC format, bounded counts/size, per-peer rate-limit) and all LAN-origin strings are escaped
  on render — a malicious LAN device cannot inject stored XSS into the admin UI or flood the cache.
  The gateway never fetches a device-supplied `LOCATION` URL (SSRF, §4.2).
- **Rate-limit:** one scan per gateway in flight; cache TTL discourages hammering.
- **Auth:** server→gateway `X-Gateway-Token`; gateway→server `Bearer`; `request_id` strictly bound to the
  authenticated gateway's in-flight scan.
- **Audit log:** scan trigger (actor, gateway, subnets) and completion (device count, duration) → activity log.
- **Privacy:** results ephemeral; no durable LAN inventory at rest.

---

## 11. Repos, phases & release ordering

This is a two-repo feature with a **hard release dependency**: the server UI needs gateways that
already report `lan_subnets` + the category catalogue (capability signal, §6.2) and expose
`/api/lan-scan`. Build and ship it as **three separately releasable, individually mergeable phases**,
in order. The server must always tolerate gateways that haven't reached a given phase (capability
detection, §6.2 / §9) — never assume support.

**Phase 1 — Gateway telemetry (companion; ships & deploys first).** Add `lan_subnets` + the
available-category catalogue to the heartbeat/telemetry payload (**data only — it does NOT set the
`lan_discovery` capability flag**, so the server won't yet offer discovery for a Phase-1-only gateway).
Version bump.

**Phase 2 — Gateway discovery engine (companion).** New `src/discovery/` module: mDNS + SSDP
(multicast **bound to the LAN interface(s)**, §4.1/§4.2) + the **opt-in** active TCP-connect sweep +
`/proc/net/arp` MAC enrichment; `POST /api/lan-scan` (X-Gateway-Token, async 202; validates subnets
against its own interfaces; honours `active_scan` + categories) + the batched results-callback client
(Bearer). On reaching this phase the gateway sets **`lan_discovery: true`** in telemetry — the
capability flag the server gates the UI on (§6.2). Version bump. Until a given gateway reaches this
phase, the server simply doesn't show discovery for it.

**Phase 3 — Server (`gatecontrol`).** Migration: `gateway_meta` discovery columns
(`discovery_enabled`, `discovery_active_scan`, `discovery_subnets`, `discovery_category_mode`,
`discovery_categories`) + licence flags. `gateways.notifyLanScan` + ingest endpoint
`POST /api/v1/gateway/discovery` + ephemeral cache + in-flight tracking/timeout/cancel + **scoped**
SSE `gateway_discovery` event. Admin API `PUT /discovery-settings`, `POST /discover` (force/cancel),
`GET /discovered`. UI: route-modal picker + gateway-detail section + settings panel, **all
capability-gated**. i18n en/de; `docs/feature-gateway-lan-discovery.md`.

---

## 12. Future work (explicitly deferred)

- **True ARP sweep (`NET_RAW`)** — surface hosts with no open common ports. Already added to ROADMAP backlog.
- **Persistent inventory / drift detection / "new device" alerts** — would justify a DB table and tie into
  the alert-channels roadmap item (#7); the persistence belongs *there*, not in this feature.
- **Synchronous fallback** — if async proves flaky, a synchronous scan variant is a smaller surface; not planned.

---

## 13. Testing strategy (CI only — no local test runs)

- **Gateway:** unit tests for the mDNS/SSDP parsers and the TCP-sweep with mocked sockets/`dgram`;
  **multicast socket bound to the LAN interface** (multi-homed mock — not `gatecontrol0`/docker);
  interface-guard rejects foreign subnets; configurable subnet-size cap; `/proc/net/arp` parser;
  **`active_scan` off ⇒ no TCP sweep (passive only)**; **category resolution** (include vs exclude →
  effective port set) and **passive-result filtering** (excluded category dropped, uncategorised kept).
- **Server:** ingest endpoint — peer_id from token; **`current_request_id` reconciliation**
  (matching merges; non-matching dropped while a current exists; adopted when none → restart-safe;
  new scan supersedes, no cross-scan merge); results from a discovery-disabled gateway ignored;
  **ingest validation** (bad IP / out-of-subnet / bad port / bad MAC rejected; oversized payload
  clamped) and **per-peer ingest rate-limit**; cache TTL; orphaned-scan timeout emits terminal event;
  **cancel clears `current_request_id`**; **`notifyLanScan` no-ops without the `lan_discovery` flag**;
  capability gate hides UI for a Phase-1-only gateway; **SSE event scoped to the authorized session**;
  `discovery-settings` validation (subnets ⊆ reported + multi-subnet gating; `category_mode` enum;
  `categories` ⊆ reported keys); API feature + capability guards; HTTP/L4 classification helper.
- **Escaping/SSRF:** a discovered hostname/service string containing markup is rendered escaped (no
  XSS); the SSDP parser extracts host:port without ever fetching the `LOCATION` URL.
- **Integration:** "Übernehmen" on a stale cache entry **re-probes via `/api/probe`** before filling
  the route fields; UI distinguishes "no in-flight + empty cache" from "completed, 0 devices".
- Coverage gate held per project convention; tests run via GitHub Actions.
