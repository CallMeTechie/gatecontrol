# GateControl — Roadmap

Planned and in-progress features. Already-shipping features live in [FEATURES.md](FEATURES.md).

Each item notes the **repos** it touches and the intended **licence tier**. New features follow the project conventions: `COMMUNITY_FALLBACK` + API guards + template locks for Pro-gated features, i18n (en + de) for every user-facing string, tests to hold the coverage gate, and a `docs/feature-*.md` write-up on completion.

---

## ✅ Shipped (2026-05)

### 1. Real-time event bus (SSE) — server → UI & clients ✅
Server-Sent Events (`GET /api/v1/events`) pushing peer / route / gateway state changes live; replaced UI polling on dashboard/peers/routes/logs.
- Shipped: **server 1.66.0** (PR #93). Tier: Community (live UI) + Pro flag for fan-out.

### 2. Gateway fleet dashboard + auto-update ✅
- **2a — Fleet dashboard:** `/gateways` overview from heartbeat telemetry (versions, CPU/RAM/disk, DNS) with a version-drift badge. Shipped: **server 1.65.0** (PR #95). Tier: Community.
- **2b — Gateway auto-update:** admin-triggered, Option A (host flag-file + `update.sh` + DSM/systemd/cron trigger; no docker.sock). Digest-pinned rollback, request_id-matched state machine. Shipped: **server 1.68.0** (PR #100) + companion 1.10.1 (PR #8/#9); verified end-to-end on nas3.

### 3. Ephemeral share links ✅
Time-limited / one-time link granting a guest access to a single proxied route — no VPN, no account; the 32-byte token in the URL is the credential. Pro (`share_links`). Model "link = protection": the first link on an unprotected route makes it share-gated; on a route that already has auth it's a guest bypass.
- Shipped: **server 1.70.0** (PR #107), then live-hardened through **1.70.6**:
  - auth-method clarity + green active-method tab + Basic⊻Route-Auth mutual exclusivity (PR #109)
  - share-URL shown after creation + clipboard copy icon (PR #110)
  - route-auth cookie `SameSite=Lax` (PR #111)
  - **strip `gc.route.sid` from upstream requests** — fixed guest sessions dying behind devices (e.g. Speedport) that clear unknown cookies (PR #112)
- Repos: server. Tier: Pro.

### 4. Scheduled access windows ✅
Time-based access control for any proxied **route** (HTTP + L4) or **VPN peer** — generalises the RDP maintenance-window concept. Per-rule **allow/block** polarity, recurring weekly **schedule** (`Mo-Fr 09:00-17:00`, shared parser) plus optional absolute **valid_from / valid_until** date bounds (server-local time). Enforced **fail-closed at build time** (`buildCaddyConfig` + WG generator consult `isDenied`); a 60 s `accessReconciler` diffs the deny-set, resyncs Caddy, rewrites WG, and live-disconnects newly-denied peers (`wg syncconf` never removes a live peer). HTTP denied → bilingual 403 page; L4 denied → listener omitted; peer denied → out of `wg0.conf` + dropped.
- Shipped: **server 1.71.0** (PR #113), then:
  - access-windows section added to the "Neue Route anlegen" modal (PR #114 → 1.72.0)
  - rule-input redesign — labelled Mo–So day toggles + `type=time` pickers + design-consistent CSS in both themes (PR #115 → 1.72.1)
- Repos: server. Tier: Pro (`access_windows`).

### 5. Geo filter per route — already shipped (predates this roadmap) ✅
Per-route **country / IP / CIDR** allow-deny lists already exist via the per-route IP filter (`ip_filter_enabled` / `ip_filter_mode` / `ip_filter_rules`) — rule types `ip`, `cidr`, `country`. Country is resolved through **ip2location.io** (per-request, 24 h in-memory cache; API key under Settings). UI type selector + i18n (en/de) in place. This item was logged in error during the 2026-05-24 planning sweep. The only genuinely new part — **ASN filtering** — was never built and moves to the backlog below.
- Repos: server. Tier: Pro (`ip_access_control`).

### 8. LAN service discovery at the gateway ✅
The gateway scans its own LAN (passive mDNS + SSDP always, optional active TCP-connect sweep) on demand and streams results back to the server. The admin reviews discovered devices on the gateway detail page and one-click-adopts them as routes via a new picker in the *Create route* modal. No new container capabilities (no `NET_RAW`); SSDP `LOCATION` is never fetched (no SSRF); untrusted LAN strings are sanitised on ingest and rendered via `textContent` only. Three phases:
- **Phase 1 — gateway telemetry** (`gatecontrol-gateway` 1.11.0, PR #10): heartbeat reports `lan_subnets` + `lan_discovery_categories`. No capability flag yet (mixed-fleet safety).
- **Phase 2 — gateway engine + endpoint** (`gatecontrol-gateway` 1.12.0, PR #11): scan engine under `src/discovery/` + new `POST /api/lan-scan`; advertises `lan_discovery: true` in telemetry.
- **Phase 3 — server backend + UI** (this PR): migration #47 + 2 licence flags + ephemeral discoveryCache with `current_request_id` reconciliation + Bearer ingest + SSE event + 3 admin endpoints + UI cards on the gateway detail page + scan/suggest picker in the route-create modal + en/de i18n + feature doc.
- See `docs/feature-gateway-lan-discovery.md`. Repos: gateway + server. Tier: Pro (`gateway_lan_discovery`; multi-subnet add-on `gateway_lan_discovery_multi_subnet`).

### 9. RDP over gateway — connect via server `connect_address` ✅
Pro/Android clients reach **gateway-mode RDP routes** (`access_mode=gateway`) through a server-issued `connect_address` instead of a direct peer IP, so RDP works for hosts that are only reachable behind a Home Gateway. The server adds the connect endpoint, a **gateway-aware RDP health monitor** (loopback probe + gateway-peer heartbeat gate), **RDP wizard UX** (host hint, NLA note, peer-autocomplete suppressed in gateway mode) and a `GC_RDP_PUBLIC_HOST` override for Cloudflare/NAT/reverse-proxy setups. Builds on the underlying gateway-routing architecture (`access_mode=gateway`, commit `cfd8eb9`). Three phases:
- **Phase A — server** (`connect_address` endpoint + gateway-aware health + wizard UX): shipped **server 1.63.0** (commit `5c3d90b`). Deployed and verified live on **1.75.3**.
- **Phase B — Pro client:** PR #5, merged 2026-05-24.
- **Phase C — Android client:** PR #12, merged 2026-05-24.
- See `docs/feature-rdp-via-gateway.md` (+ `docs/feature-rdp-via-l4-gateway.md`). Repos: server + windows-client-pro + android-client. Tier: Pro.

---

## 🔜 Next up

_Nothing actively in progress — pick the next item from the planned candidates below._

---

## 📋 Planned — new candidates (2026-05-24)

### 6. Status page (internal / public)
A statuspage-style overview per proxied service generated from `monitor.js` uptime data, optionally shareable publicly.
- **Repos:** server. **Builds on:** uptime monitoring. **Tier:** Community + Pro (public page).

### 7. Native alert channels for homelab
Add ntfy / Gotify / Telegram / Discord alongside the existing email + webhook alerting.
- **Repos:** server (notification adapters + settings UI). **Tier:** Community.

### 10. Direct-path shortcut for gateway traffic (relay stays the fallback)
Today **all** service traffic to a gateway-mode route hairpins through the central WG hub (`client → server → gateway tunnel-IP → L4 listener → LAN target`), even when the client and the serving gateway sit on the **same physical LAN**. This item adds a **candidate hierarchy** to `connect_address` resolution so the server hands back the cheapest viable path and only falls back to the hub when nothing better is reachable. Inspired by wireplug's STUN-based NAT classification — but reframed: GC is **hub-and-spoke**, so the central server is always reachable and we do **not** have wireplug's mesh NAT-traversal problem for basic connectivity. The win here is **hairpin avoidance / latency + hub-bandwidth savings**, not NAT traversal.

Path tiers, evaluated in `resolveConnectEndpoint()` (`src/services/rdp.js:760`):
- **Tier 0 — same-LAN direct (recommended first/only scope):** if the requesting client and the serving gateway share a subnet, return `gateway_meta.lan_ip` as `connect_address` instead of the hub host. Builds **entirely** on existing infrastructure — LAN discovery (`discovery_*`, migration #45) + `gateway_meta.lan_ip` (#46) + the L4 listener already binding on the gateway. No STUN, no endpoint tracking. Closes the open Phases 2/3a/3b of the LAN-discovery spec rather than opening a new build site.
- **Tier 1 — reflexive direct via mini-STUN (deferred):** a small server-side UDP responder (≈40 lines `dgram`, modelled on wireplug `server/stun.rs`) reachable on **two** addresses lets clients/gateways classify their NAT `Easy`/`Fixed`/`Hard` and learn their reflexive endpoint. Gateways report `nat_class` + `reflexive_endpoint` in the existing heartbeat (`routes/api/gateway.js:120`); two new `gateway_meta` columns store them. **Deferred** — only worth it if hub bandwidth is measured as a real bottleneck, and it requires roaming-endpoint tracking that the server deliberately does not do today (`peers.endpoint` is not live-maintained). When either side is `Hard`-NAT, a direct path is impossible and we fall to Tier 2 anyway.
- **Tier 2 — hub relay (status quo, always the fallback):** current behaviour (`publicHost` + `gateway_listen_port`). Never removed, so the change is strictly additive and cannot regress connectivity.

**Transport selection — relay-first, upgrade-on-proof** (design refinement, adapted from wireflow's `probe.discover()` race-and-upgrade pattern). Rather than statically committing to a tier in `connect_address` and risking a wrong same-LAN guess that *blocks* the connection, the client should **start on the guaranteed-working Tier 2 hub relay** and only switch to a direct tier once that path is **proven reachable** (e.g. a quick probe to `gateway_meta.lan_ip` succeeds), then silently upgrade the live connection. The direct path is thus the *optimisation on top of a working baseline*, never a precondition — a failed/slow direct attempt can never degrade connectivity, only fail to improve it. wireflow does this by racing direct vs relay with a 500 ms grace window and a later `handleUpgradeTransport()` upgrade; the GC analogue is a client-side reachability probe + connection re-dial, since GC has no live transport mux. Keeps the additive-only guarantee above intact.
- **Repos:** server (+ gateway heartbeat + Pro/Android clients for Tier 1 only; upgrade-on-proof logic lives client-side). **Builds on:** #8 LAN discovery, #9 RDP-over-gateway `connect_address`, loopback-failover (`gateway_meta.lan_ip`). **Tier:** Pro. **Recommended scope:** Tier 0 only; treat Tier 1 as a separate opt-in item gated on a measured bandwidth need.

### 11. Encrypted upstream DNS (DoT / DoH / DNSCrypt + DNSSEC)
The DNS chain forwards client queries to upstream resolvers in **plaintext UDP/53** today (`src/services/pihole.js:31` → `GC_DNSMASQ_UPSTREAMS` defaults `1.1.1.1,8.8.8.8`). That means the VPN encrypts the client→server hop but the server→internet DNS egress is observable by the hosting ISP / upstream path — a privacy gap for a product whose selling point is private connectivity. This item adds an **encrypted, validating upstream** stage so the egress DNS leaving the server is itself encrypted and DNSSEC-checked. Keeps the existing topology intact: **dnsmasq stays the front**, Pi-hole stays the filter, and only the *upstream* target changes from plaintext `1.1.1.1:53` to a local encrypting forwarder.
- **Design:** run a `dnscrypt-proxy` (or `unbound` with DoT) forwarder bound to loopback (e.g. `127.0.0.1:5353`) that speaks DoH/DoT + DNSSEC outward; point `GC_DNSMASQ_UPSTREAMS` (or the Pi-hole upstream) at it instead of `1.1.1.1:53`. Admin setting to pick provider(s) (Cloudflare / Quad9 / custom) and toggle DNSSEC-required.
- **Notes / open questions:** packaging — sidecar container vs. in-server process (server already runs host-net Docker); failure mode must fail **safe** (no silent fallback to plaintext if the encrypted resolver is down); interaction with the existing dnsmasq health probe (`pihole.js:86`); per-route vs. global upstream. Validate it does **not** regress the Pi-hole ECS/EDNS0 chain (`project_pihole_dns_topology`).
- **Repos:** server (DNS chain wiring + settings UI + i18n). **Builds on:** Pi-hole/dnsmasq DNS topology, #? split-DNS (backlog) if landed. **Tier:** Pro (privacy feature). _Origin: hardening idea adapted from the `secure-wireguard-implementation` guide (Unbound + DNSCrypt + DNSSEC); the SSH-port/port-knocking/honeypot/MTU parts of that guide were reviewed and rejected as host-ops, already-covered, or counterproductive._

---

## 📥 Carried over from backlog

- **ASN filter per route** — autonomous-system allow/deny lists (the unbuilt half of the former "Geo-/ASN filter" item). Needs an IP→ASN source; ip2location.io may already return ASN on the existing per-IP lookup, so this could land as a 4th `asn` rule type on the IP filter. Tier: Pro.
- **True ARP sweep for LAN discovery** — optional add-on to #8: a raw-socket ARP sweep (requires `NET_RAW` on the gateway container) to also surface LAN hosts that have *no* open common ports — beyond the v1 TCP-connect sweep, which finds liveness + open ports without `NET_RAW`. Deferred from #8 v1. Tier: Pro (gateway).
- **Log streaming** — Activity/access logs → Syslog / Loki / ELK (Pino transports).
- **WireGuard 2FA** — second factor on the VPN connect itself, not just the web login.
- **Device approval** — new peers stay `pending` until an admin confirms.
- **Split DNS** — per-domain DNS routing (internal names → internal resolver).
- **HTTP cache (souin)** / **WAF (coraza)** — per-route Caddy plugins.
- **Windows client** — server-profile switching; English i18n.

## 🧱 Strategic / tech-debt

- **SQLite → PostgreSQL** evaluation (single-writer bottleneck at scale).
- **Encryption-key rotation** with re-encryption (currently `GC_ENCRYPTION_KEY` is not rotatable).
- **Background-task retry rollout** — extend `withRetry` to all interval tasks.

---

### 12. WireGuard traffic obfuscation — DPI / censorship resistance (opt-in)
WireGuard has a recognisable on-the-wire fingerprint (the 4-byte message-type header + characteristic handshake sizes), so DPI can detect and block/throttle it. Users behind restrictive corporate firewalls, censoring ISPs, or in heavily-filtered countries simply can't connect today — the tunnel just fails. This item adds an **opt-in** obfuscation layer that disguises the WG traffic so it survives DPI. **Strictly opt-in / off by default:** for the typical homelab or normal-ISP user it is pure overhead and must never be on the default path. The transferable substance (not the code) is the technique from `ClusterM/wg-obfuscator`: **(a)** randomise the WG type header (kills the primary DPI signature), **(b)** XOR-scramble with a shared plaintext key, **(c)** dummy-pad handshake/data packets to vary sizes, **(d)** optional protocol masking (emulate STUN, which DPI rarely blocks).

**First decision before any build — Path A vs Path B:**
- **Path A — external obfuscator sidecar** (the wg-obfuscator model): a UDP proxy runs on **both** ends; WG `Endpoint` points at `127.0.0.1:<port>`, the real endpoint moves into the proxy config. Works with any WG, but is **cross-cutting**: server + gateways + **every** client (Windows-Pro, Android) need the proxy/process. The XOR+padding core is ~150 lines and trivially re-implementable natively per client; STUN masking (~280 lines) is optional/phase-2.
- **Path B — AmneziaWG** (a `wireguard-go` fork with obfuscation built into the protocol). GC already ships userspace WG (`/root/docker-wireguard-go`), so server/gateway side could be a **binary swap** with obfuscation in-protocol — potentially far less glue than Path A. Clients would need the Amnezia variant. **Investigate B before committing to A.**

- **Licence flag:** wg-obfuscator is **GPL-3.0**. Given GC's Pro/commercial licensing, it may only be used as a **separate process / sidecar** (GPL aggregation), never linked or embedded into Pro-licensed code; a clean-room native re-implementation of the (trivial) idea avoids the issue, but copying the `.h` does not. AmneziaWG is similarly GPL — same separate-process rule applies.
- **Notes / open questions:** shared-key distribution + rotation (the obfuscation key is plaintext, symmetric, per-deployment); per-route vs. whole-tunnel; UX for enabling it only where needed; throughput/CPU on the NAS; interaction with #10 (obfuscation changes the effective endpoint to loopback).
- **Repos:** server + gateway + windows-client-pro + android-client (Path A) **or** server + gateway + clients' WG layer (Path B). **Builds on:** userspace WG (`docker-wireguard-go`), connect/endpoint model. **Tier:** Pro (`traffic_obfuscation`), off by default. _Origin: `ClusterM/wg-obfuscator` (technique only, not code — GPL-3)._

---

_Status legend: ✅ shipped · 🔜 in progress · 📋 planned · 📥 backlog · 🧱 tech-debt. Last updated 2026-06-20._
