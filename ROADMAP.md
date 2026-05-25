# GateControl — Roadmap

Planned and in-progress features. Already-shipping features live in [FEATURES.md](FEATURES.md).

Each item notes the **repos** it touches and the intended **licence tier**. New features follow the project conventions: `COMMUNITY_FALLBACK` + API guards + template locks for Pro-gated features, i18n (en + de) for every user-facing string, tests to hold the coverage gate, and a `docs/feature-*.md` write-up on completion.

---

## 🔜 Next up (in progress)

### 1. Real-time event bus (SSE) — server → UI & clients
A server-side event stream (`GET /api/events`, Server-Sent Events) that pushes peer / route / gateway state changes live, replacing UI polling and feeding client push notifications ("route down", security alerts).
- **Repos:** server (event source + endpoint + live UI); Windows / Android clients consume later.
- **Builds on:** WebSocket support shipped in gateway 1.9.2; Windows backlog item "server pushes events via WebSocket".
- **Tier:** Community (live web UI) + Pro (client push / external fan-out).

### 2. Gateway fleet dashboard
A fleet overview built from the telemetry every gateway already sends each heartbeat (versions, CPU/RAM/disk, default gateway, DNS resolvers) into `gateway_meta.last_health` — with a **version-drift badge** ("gateway X = 1.8.0, current = 1.9.2").
- **Repos:** server (UI page + read API over existing telemetry).
- **Builds on:** existing heartbeat telemetry; feeds the parked **gateway auto-update** (image-digest comparison).
- **Tier:** Community.

### 3. Ephemeral share links
Generate a time-limited (or one-time) link to a single proxied service for guests — no VPN access or account required (cf. Cloudflare Access / Tailscale Funnel share).
- **Repos:** server (token model + route-auth integration + UI).
- **Builds on:** existing route-auth (email-OTP / IP-whitelist).
- **Tier:** Pro.

---

## 📋 Planned — new candidates (2026-05-24)

### 4. Scheduled access windows (generalised)
Generalise the existing RDP maintenance-window concept to **any route or peer** ("active Mon–Fri 09–17"): contractor access, kids' devices, temporary grants.
- **Repos:** server. **Builds on:** `rdpMaintenance`. **Tier:** Pro.

### 5. Geo-/ASN filter per route
Country / ASN allow-deny lists per route, complementing the existing caddy-defender bot blocker.
- **Repos:** server (Caddy layer + UI). **Tier:** Pro.

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

- **Log streaming** — Activity/access logs → Syslog / Loki / ELK (Pino transports).
- **WireGuard 2FA** — second factor on the VPN connect itself, not just the web login.
- **Device approval** — new peers stay `pending` until an admin confirms.
- **Split DNS** — per-domain DNS routing (internal names → internal resolver).
- **HTTP cache (souin)** / **WAF (coraza)** — per-route Caddy plugins.
- **Gateway auto-update** — parked; plan = host cron/systemd + flag-file (Option A), not Watchtower.
- **Windows client** — server-profile switching; English i18n.

## 🧱 Strategic / tech-debt

- **SQLite → PostgreSQL** evaluation (single-writer bottleneck at scale).
- **Encryption-key rotation** with re-encryption (currently `GC_ENCRYPTION_KEY` is not rotatable).
- **Background-task retry rollout** — extend `withRetry` to all interval tasks.

---

_Status legend: 🔜 in progress · 📋 planned · 📥 backlog · 🧱 tech-debt. Last updated 2026-05-24._
