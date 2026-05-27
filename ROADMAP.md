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

### 8. LAN service discovery at the gateway
The gateway scans its LAN (mDNS / SSDP / ARP) and suggests devices/ports as routes in the UI — trivial onboarding of services behind a gateway.
- **Repos:** gateway (discovery) + server (suggestion UI). **Builds on:** the gateway companion. **Tier:** Pro.

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

_Status legend: ✅ shipped · 🔜 in progress · 📋 planned · 📥 backlog · 🧱 tech-debt. Last updated 2026-05-27._
