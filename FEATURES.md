# GateControl — Feature Documentation

Detailed documentation for all features. For the complete feature overview, see [README.md](README.md).

---

## Table of Contents

- [Layer 4 TCP/UDP Proxy](#layer-4-tcpudp-proxy)
- [Route Authentication](#route-authentication)
- [SMTP Configuration](#smtp-configuration)
- [Caddy Config View](#caddy-config-view)
- [Custom Branding for Route Auth](#custom-branding-for-route-auth)
- [IP Access Control / Geo-Blocking](#ip-access-control--geo-blocking)
- [Uptime Monitoring](#uptime-monitoring)
- [Email Alert System](#email-alert-system)
- [Per-Peer Traffic Graphs](#per-peer-traffic-graphs)
- [Account Lockout](#account-lockout)
- [IP Block (IP-Sperre)](#ip-block-ip-sperre)
- [Route Protection (Routenschutz)](#route-protection-routenschutz)
- [Malware Scan (Virenscan)](#malware-scan-virenscan)
- [Password Complexity Enforcement](#password-complexity-enforcement)
- [Configurable Operational Timeouts](#configurable-operational-timeouts)
- [Peer Expiry](#peer-expiry)
- [Peer Access Control (ACL)](#peer-access-control-acl)
- [Automatic Backups](#automatic-backups)
- [Log Export](#log-export)
- [Server Log](#server-log)
- [Logs & Monitoring](#logs--monitoring)
- [API Tokens](#api-tokens)
- [Gzip/Zstd Compression](#gzipzstd-compression)
- [Custom Request/Response Headers](#custom-requestresponse-headers)
- [Per-Route Rate Limiting](#per-route-rate-limiting)
- [Retry with Backoff](#retry-with-backoff)
- [Multiple Backends / Load Balancing](#multiple-backends--load-balancing)
- [Sticky Sessions](#sticky-sessions)
- [Prometheus Metrics Export](#prometheus-metrics-export)
- [Circuit Breaker](#circuit-breaker)
- [Batch Operations](#batch-operations)
- [Peer Groups](#peer-groups)
- [Request Mirroring](#request-mirroring)
- [Mobile Sidebar](#mobile-sidebar)
- [Themes](#themes)

---

## Layer 4 TCP/UDP Proxy

Raw TCP and UDP port forwarding via the `caddy-l4` plugin. Reach RDP, SSH, databases, or game servers without a VPN tunnel.

### How It Works

1. When creating a route, select **Route Type: Layer 4**
2. Choose protocol (TCP or UDP) and a listen port or port range
3. Select a TLS mode:
   - **None** — port-based routing only
   - **Passthrough** — TLS-SNI routing, TLS negotiated with backend
   - **Terminate** — Caddy handles TLS with automatic Let's Encrypt certificate
4. GateControl configures Caddy's L4 module to forward traffic directly to the backend

### Configuration

| Setting | Options | Default |
|---------|---------|---------|
| **Protocol** | TCP, UDP | TCP |
| **Listen Port** | Single port or range (e.g., `5000-5010`) | — |
| **TLS Mode** | None, Passthrough, Terminate | None |
| **Domain** | Required for Passthrough/Terminate | — |
| **Max Port Range** | `GC_L4_MAX_PORT_RANGE` env var | 100 |
| **Blocked Ports** | `GC_L4_BLOCKED_PORTS` env var | 80, 443, 2019, 3000, 51820 |

### API

```bash
# Create L4 route (RDP forwarding)
curl -X POST https://gate.example.com/api/v1/routes \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "rdp.example.com",
    "route_type": "l4",
    "l4_protocol": "tcp",
    "l4_listen_port": "3389",
    "l4_tls_mode": "passthrough",
    "target_ip": "192.168.1.10",
    "target_port": 3389
  }'

# Create L4 route with port range
curl -X POST https://gate.example.com/api/v1/routes \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "game.example.com",
    "route_type": "l4",
    "l4_protocol": "udp",
    "l4_listen_port": "27015-27020",
    "l4_tls_mode": "none",
    "target_ip": "10.8.0.5",
    "target_port": 27015
  }'
```

### Important Notes

- Host networking required (`network_mode: host` in docker-compose.yml)
- Blocked ports prevent conflicts with GateControl services (Caddy, Node.js, WireGuard)
- TLS termination generates Let's Encrypt certificates per domain
- Monitoring uses TCP connects for L4 routes (not HTTP)
- HTTP-specific features (compression, headers, rate limiting) do not apply to L4 routes

---

## Route Authentication

Custom login page per route with multiple auth methods, optional 2FA, and configurable session duration.

### Auth Methods

| Method | Description |
|--------|-------------|
| **Email & Password** | Credentials stored as bcrypt hashes |
| **Email & Code (OTP)** | 6-digit code sent via SMTP, 5-minute expiry |
| **TOTP** | QR code setup, standard Authenticator apps (Google, Authy, etc.) |

### How It Works

1. Enable route auth on any HTTP route
2. Caddy's `forward_auth` mechanism intercepts requests and redirects to a login page
3. After successful login, a session cookie is set with the configured TTL
4. Subsequent requests pass through without re-authentication until the session expires
5. Optional 2FA adds a second authentication step (Email Code or TOTP)

### Configuration

| Setting | Options | Default |
|---------|---------|---------|
| **Auth Method** | None, Email/Password, Email/Code, TOTP | None |
| **2FA** | Off, Email Code, TOTP | Off |
| **Session Duration** | 1h, 24h, 7d, 30d, custom days | 24h |

### API

```bash
# Create route auth (Email & Password)
curl -X POST https://gate.example.com/api/v1/route-auth \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "route_id": 1,
    "auth_method": "password",
    "session_duration_hours": 24,
    "two_factor_enabled": false
  }'

# Setup TOTP (returns QR code)
curl -X POST https://gate.example.com/api/v1/route-auth/totp-setup \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"route_id": 1}'

# Verify TOTP code
curl -X POST https://gate.example.com/api/v1/route-auth/totp-verify \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"route_id": 1, "token": "123456"}'

# Delete route auth
curl -X DELETE "https://gate.example.com/api/v1/route-auth?route_id=1" \
  -H "Authorization: Bearer gc_your_token"
```

### Important Notes

- SMTP configuration required for Email & Code and email alerts
- TOTP codes tracked in-memory to prevent replay (90s expiry)
- Route-auth CSRF key derived from app secret via HMAC (domain-bound)
- Lockout is email-based (not IP-based) to prevent IP rotation bypass
- Static assets (CSS, JS) bypass forward auth on route-auth domains

---

## SMTP Configuration

Built-in SMTP settings for sending verification codes and alert emails.

### How It Works

1. Navigate to **Settings > Email & SMTP**
2. Enter SMTP host, port, credentials, and from address
3. Port 587 auto-enables STARTTLS, port 465 uses implicit TLS
4. Test with the **Send Test Email** button
5. Password is encrypted at rest (AES-256-GCM)

### API

```bash
# Get SMTP settings (password masked)
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/smtp

# Update SMTP settings
curl -X PUT https://gate.example.com/api/v1/smtp \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "smtp_host": "smtp.gmail.com",
    "smtp_port": "587",
    "smtp_user": "bot@example.com",
    "smtp_password": "app_password",
    "smtp_from": "noreply@example.com"
  }'

# Test SMTP connection
curl -X POST https://gate.example.com/api/v1/smtp/test \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"recipient": "admin@example.com"}'
```

### Important Notes

- Minimum config: host, port, from address (credentials optional for some servers)
- Password not readable via API after saving
- Transporter cached in memory, reset on settings change
- All email template values HTML-escaped (XSS protection)

---

## Caddy Config View

Live view of Caddy's JSON configuration with syntax highlighting and export capability.

### How It Works

- Navigate to the **Caddy Config** page
- Shows the current live Caddy configuration as pretty-printed JSON
- Config updates automatically after route create/update/delete
- Useful for debugging routing, ACL, headers, and compression settings

### API

```bash
# Get live Caddy config
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/caddy/status

# Force Caddy reload
curl -X POST https://gate.example.com/api/v1/caddy/reload \
  -H "Authorization: Bearer gc_your_token"
```

### Important Notes

- Read-only view — editing requires changing routes via UI or API
- Caddy admin API timeout configurable via `GC_CADDY_API_TIMEOUT` (default 10s)

---

## Custom Branding for Route Auth

Per-route custom branding for the login page: logo, title, welcome text, accent color, and background image.

### How It Works

1. Open a route's edit modal and navigate to the **Branding** section
2. Upload a logo (PNG, JPG, GIF, SVG — max 2 MB)
3. Set title, welcome text, accent color, and background image URL
4. The login page renders with your custom branding via CSS custom properties

### Configuration

| Setting | Limit |
|---------|-------|
| **Logo** | 2 MB, image/* MIME types |
| **Title** | 255 characters |
| **Welcome Text** | 2000 characters |
| **Accent Color** | Hex color (e.g., `#007bff`) |
| **Background Image** | External URL |

### API

```bash
# Upload logo
curl -X POST https://gate.example.com/api/v1/routes/1/branding/logo \
  -H "Authorization: Bearer gc_your_token" \
  -F "file=@logo.png"

# Delete logo
curl -X DELETE https://gate.example.com/api/v1/routes/1/branding/logo \
  -H "Authorization: Bearer gc_your_token"

# Update branding text fields
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "branding_title": "Customer Portal",
    "branding_text": "Welcome to our secure login",
    "branding_color": "#007bff",
    "branding_bg": "https://example.com/bg.jpg"
  }'
```

### Important Notes

- Logo stored in `/data/branding/` (persisted via Docker volume)
- Hex color validated via regex (prevents CSS injection)
- All text fields HTML-escaped on render
- Branding included in backup/restore

---

## IP Access Control / Geo-Blocking

Per-route IP filtering with whitelist/blacklist modes. Supports single IPs, CIDR ranges, and country codes via ip2location.io.

### How It Works

1. Open a route's edit modal and enable **IP Access Control**
2. Select mode: **Whitelist** (allow only listed) or **Blacklist** (block listed)
3. Add rules by type:
   - **IP** — exact match (e.g., `203.0.113.50`)
   - **CIDR** — range match (e.g., `10.0.0.0/8`)
   - **Country** — country code (e.g., `CN`, `US`, `DE`) via ip2location.io API
4. Caddy's forward-auth checks each request against the rules

### Configuration

| Setting | Description |
|---------|-------------|
| **Mode** | Whitelist or Blacklist |
| **Rules** | Array of `{type, value}` objects |
| **ip2location API Key** | Required for country rules (Settings > Advanced) |

### API

```bash
# Enable IP whitelist with CIDR
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "ip_filter_enabled": true,
    "ip_filter_mode": "whitelist",
    "ip_filter_rules": [
      {"type": "cidr", "value": "185.10.20.0/24"},
      {"type": "ip", "value": "203.0.113.50"}
    ]
  }'

# Enable country-based blacklist
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "ip_filter_enabled": true,
    "ip_filter_mode": "blacklist",
    "ip_filter_rules": [
      {"type": "country", "value": "CN"},
      {"type": "country", "value": "RU"}
    ]
  }'
```

### Important Notes

- Country rules require an ip2location.io API key
- GeoIP cache: 24-hour TTL, max 10,000 entries (LRU eviction)
- Empty whitelist blocks all traffic; empty blacklist allows all
- Uses `req.ip` (Express-resolved) — not raw X-Forwarded-For header
- IPv6-mapped IPv4 addresses automatically stripped (`::ffff:` prefix)

---

## Uptime Monitoring

Periodic health checks (HTTP or TCP) per route with dashboard display, response time tracking, and email alerts on status change.

### How It Works

1. Enable monitoring on any route
2. A background poller checks each monitored route at the configured interval (default 60s)
3. HTTP routes: `GET` request, expects status 200–399
4. L4/TCP routes: TCP connect test
5. Status changes (up/down) trigger webhooks and email alerts
6. Dashboard shows monitoring status with response time for each route

### Configuration

| Setting | Options | Default |
|---------|---------|---------|
| **Enable** | Per-route toggle | Off |
| **Interval** | Settings > Monitoring | 60s |
| **HTTP Timeout** | `GC_MONITOR_HTTP_TIMEOUT` | 10s |
| **TCP Timeout** | `GC_MONITOR_TCP_TIMEOUT` | 5s |
| **Email Alerts** | Settings > Email | Off |

### API

```bash
# Enable monitoring
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"monitoring_enabled": true}'

# Manual health check
curl -X POST https://gate.example.com/api/v1/routes/1/check \
  -H "Authorization: Bearer gc_your_token"
```

### Important Notes

- First check runs 10 seconds after startup
- Checks target backend IP + port (not public domain)
- Self-signed HTTPS backends accepted (`rejectUnauthorized: false`)
- Max 10 simultaneous checks per cycle
- Webhook events: `route_down`, `route_up`
- Prerequisite for Circuit Breaker feature

---

## Email Alert System

Event-based email notifications for security, peers, routes, and system events.

### Alert Events

| Group | Events |
|-------|--------|
| **Security** | Account lockout, failed auth attempts |
| **Peers** | Peer expiring soon (7 days), peer expired, peer offline |
| **Routes** | Route monitoring down/up, route auto-disabled |
| **System** | Backup overdue, CPU/RAM threshold exceeded |

### Configuration

Navigate to **Settings > Email & SMTP**:

- Enable/disable alerts per event group
- Set alert recipient email address
- Configure CPU/RAM thresholds
- Configure backup reminder frequency

### Important Notes

- Requires SMTP fully configured
- Alerts sent once per status change (not on every check)
- All email template values HTML-escaped
- CPU/RAM thresholds configurable via `GC_ALERT_CPU_THRESHOLD` / `GC_ALERT_RAM_THRESHOLD`

---

## Per-Peer Traffic Graphs

Interactive traffic history charts (24h, 7d, 30d) with persistent upload/download totals per peer.

### How It Works

1. Traffic snapshots collected every 60 seconds (configurable via `GC_TRAFFIC_INTERVAL`)
2. WireGuard stats extracted via `wg show` (transfer RX/TX)
3. Snapshots stored as deltas in the database
4. Charts display bandwidth over time with selectable periods

### Chart Periods

| Period | Granularity |
|--------|-------------|
| **24h** | Per-minute snapshots |
| **7d** | Hourly aggregated |
| **30d** | Daily aggregated |

### API

```bash
# Get peer traffic history
curl -H "Authorization: Bearer gc_your_token" \
  "https://gate.example.com/api/v1/peers/5/traffic?period=24h"

# Response:
# {
#   "ok": true,
#   "traffic": {
#     "total_rx": 1024000,
#     "total_tx": 512000,
#     "chart": [
#       {"timestamp": "2026-03-25T10:00:00Z", "rx": 100, "tx": 50},
#       ...
#     ]
#   }
# }
```

### Important Notes

- Rates calculated from deltas (bytes/second)
- Older snapshots automatically aggregated to save storage
- Traffic data included in peer detail view

---

## Account Lockout

Configurable account lockout after N failed login attempts for both admin and route-auth logins.

### How It Works

1. Each failed login increments a counter per email (route-auth) or username (admin)
2. After reaching the threshold, the account is locked for the configured duration
3. Lockout is email-based (not IP-based) to prevent IP rotation bypass
4. Manual unlock available in Settings > Security

### Configuration

| Setting | Options | Default |
|---------|---------|---------|
| **Enable** | On/Off toggle | On |
| **Threshold** | Failed attempts before lockout | 5 |
| **Duration** | Lock duration | 30 minutes |

### API

```bash
# Get lockout settings
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/settings/security

# Update lockout settings
curl -X PUT https://gate.example.com/api/v1/settings/security \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"lockout": {"enabled": true, "threshold": 5}}'

# Manual unlock (admin)
curl -X POST https://gate.example.com/api/v1/settings/unlock-admin \
  -H "Authorization: Bearer gc_your_token"

# Manual unlock (route-auth)
curl -X POST "https://gate.example.com/api/v1/settings/unlock-route-auth?email=user@example.com" \
  -H "Authorization: Bearer gc_your_token"
```

### Important Notes

- Counter resets after successful login
- Auto-unlock after duration expires (`locked_until` timestamp)
- Lockout triggers email alert (if configured)

---

## IP Block (IP-Sperre)

Settings › Security › IP-Sperre (`/settings/ipsperre`). The account lockout protects one account; the IP block stops one **address** that tries many accounts, links or routes. Failures of every entry point count together.

### What counts as a failure

| Source | Where it is counted |
|--------|--------------------|
| `login` | GateControl login, portal, app sign-in, second factor (`lockout.recordFailedAttempt`) |
| `route_auth` | Route login (same hook, type `route_auth`) |
| `share_link` | Wrong PIN of a public link of a plugin (Drive, GateDrop — `/s/<token>/unlock`) |
| `waf` | Every request the WAF blocked (audit log ingest) |
| `scan` | 404s from the access log: a probe path (`/.env`, `/wp-admin`, `/.git/` …) counts at once, any other ten 404s once; request bodies that are no JSON (`malformed request body`) count like those other 404s |
| `rate_limit` | 429 answers (off by default — own apps can hit it) |

Every source can be switched off. Default: 10 failures within 10 minutes (10 or 60 min, threshold 3 … 1000).

### Bans

- Automatic bans grow when they repeat within 7 days: 10 min › 1 h › 1 day (level 1 … 3). The third one is reported (`ip_blocked_day`), as are 20 bans within 10 minutes (`ip_block_mass`, at most hourly) — notification centre row "IP für einen Tag gesperrt / viele Sperren", logs in Logs & Monitoring (warnings appear under "Probleme").
- By hand: IP or CIDR (not wider than /16 resp. /32), 1 h, 1 day, 7 days, 30 days or permanent, with a note.
- Never banned: private, loopback and link-local addresses, the VPN subnet, the "Nie sperren" list (up to 50 entries) and the WAF's own addresses. Adding an exception lifts the bans inside it.
- The client address is the one Caddy determines (`trusted_proxies`: X-Forwarded-For only from private ranges) — behind a load balancer in the own network the visitor counts, never the proxy.

### Block lists (licence feature `ip_blocklists`)

| List | Source | Terms |
|------|--------|-------|
| Botnets / spam networks | Spamhaus DROP (`drop_v4.json`, `drop_v6.json`) | free to use with attribution; the © line stays with the stored file; at most one download per hour |
| Known attackers | blocklist.de `all.txt` (attacks of the last 48 h) | free, as is |
| Tor exit nodes | check.torproject.org `torbulkexitlist` | public; off by default |

Fetched once a day (and with "Jetzt aktualisieren"), 30 s timeout, at most 8 MB / 200 000 entries per list, only public ranges kept. A failed download keeps the previous list. Nothing is sent to these services.

### Enforcement

GateControl writes one file, `<caddy data>/ipblock.list` (exceptions first with `!`, then bans and lists). The Caddy matcher `http.matchers.gc_ipblock` (`caddy-plugins/mirror/ipblock.go`) in the **first** route of `srv0` reads it and re-reads it when it changes (every 2 s, lock-free swap) — before the HTTP→HTTPS redirect, the WAF, every route, the portal and the login; only the ACME challenge stays open. Answer: 403. A ban therefore works within seconds **without reloading Caddy** (a reload re-provisions every app, the WAF rule sets included — expensive with many bans). GateControl itself checks the same set as its first middleware (covers a Caddy without the module). Layer-4 listeners get the bans (not the lists) through the ban route of their listeners (coalesced sync, at most once a minute). Without the module in Caddy the page says so.

### API (admin session only)

```
GET    /api/v1/settings/ip-block
PUT    /api/v1/settings/ip-block              { enabled, threshold, window_min, notify, sources: {…}, lists: {…} }
POST   /api/v1/settings/ip-block/bans         { ip, hours: 1|24|168|720|null, note }
DELETE /api/v1/settings/ip-block/bans/:ip     (URL-encoded, also CIDR)
POST   /api/v1/settings/ip-block/never        { ip, label }
DELETE /api/v1/settings/ip-block/never/:ip
POST   /api/v1/settings/ip-block/lists/refresh
```

Settings: `ipblock.config`, `ipblock.never`, `ipblock.lists_state`; tables `ip_blocks`, `ip_block_failures`, `ip_block_strikes` (migration 123). Backups carry the settings and the bans set by hand.

---

## Route Protection (Routenschutz)

Settings › Security › Routenschutz (`/settings/routenschutz`): every route with what protects it — access (Internet / only VPN = `external_enabled = 0` / chosen devices = active peer ACL), login (Basic Auth, Route Auth with 2FA, client certificate), countries / IP filter, rate limit, WAF — plus a risk. Nothing here adds a protection of its own; it reads and changes the existing route fields.

### Risk (heuristic)

| Level | When |
|-------|------|
| low | route off, only VPN / chosen devices, or a login |
| high | from the internet without a login **and** an administration interface: typical admin port of the target (Proxmox 8006/8007, Synology 5000/5001, Portainer 9000/9443, Cockpit 9090, Webmin 10000, UniFi 8443, Docker API 2375/2376, Caddy admin 2019 …) or a name such as proxmox, router, fritz, nas, portainer, opnsense, unifi, admin in host, label or description; an L4 forward of a remote-access or database port (22, 23, 139, 445, 3389, 5900, 3306, 5432, 6379, 27017, 9200 …) |
| check | from the internet without a login otherwise |

"Braucht deine Aufmerksamkeit" lists high and check routes with **Nur über VPN** (sets `external_enabled = 0` through the bulk update, Caddy synced, rolled back on failure), **Anmeldung einschalten** (opens the route) and **Ist Absicht** (confirmed; stays confirmed as long as access, login and target are the same — a change asks again). The start page `/settings` shows the same points.

### Defaults for new routes

Access (Internet / only VPN), WAF (licence `waf`), countries (all, Germany, DACH, Germany + EU — licence `ip_access_control` and an ip2location.io key, otherwise a country allow list would turn every visitor away), rate limit per minute (licence `rate_limiting`). Applied by `routes.create()` to every field the creation leaves open; a WAF default of the domain comes first, and a newly added domain starts with the access default.

### VPN misuse

From the peer poller (`wg show dump` every 30 s):

- **Key in two places**: the endpoint of one peer keeps switching between at most three internet addresses (≥ 6 switches within 15 min, back and forth) → warn (`vpn_key_shared`) or block the peer (switched off like on the peer page).
- **New country**: a peer connects from a country it never came from (endpoint countries via ip2location.io, only with a key; the first country is learnt) → warn (`vpn_new_country`).

Each at most once per peer and 6 h; notification centre row "VPN-Schlüssel an zwei Orten / neues Land".

### API (admin session only)

```
GET    /api/v1/settings/route-guard
PUT    /api/v1/settings/route-guard            { defaults: { access, waf, countries, rate_limit }, vpn: { two_places, new_country } }
POST   /api/v1/settings/route-guard/routes/:id/vpn-only
POST   /api/v1/settings/route-guard/routes/:id/ack
DELETE /api/v1/settings/route-guard/routes/:id/ack
```

---

## Malware Scan (Virenscan)

Settings › Security › Virenscan (`/settings/virenscan`, tabs Einstellungen | Quarantäne | Verlauf). Every file a plugin stores through GateControl's media store is checked **right after it is stored, before anyone can open it**: uploads of the apps, the portal and plugin frames (also resumable — Drive's photo backup), public upload links (Drive, GateDrop), mail attachments (`gc.mail`), `gc.media.fetch`, cloud imports. Hand-overs and copies keep the result of their source.

### Checks

| Check | Needs | What |
|-------|-------|------|
| Grundschutz | nothing (always on, no extra memory) | file-type rules: programs (MZ/ELF/Mach-O, scripts) disguised as another type or with a double extension ("Rechnung.pdf.exe"); from outside (links, mail, GateDrop, messenger) also plain programs and Office documents with macros (OOXML `vbaProject.bin`, OLE2 `_VBA_PROJECT`); ZIP archives by their entries, ZIP in ZIP up to the configured depth; encrypted entries or deeper nesting → not scannable; the EICAR test file |
| Malware list | free abuse.ch Auth-Key (optional) | SHA-256 of known malware (MalwareBazaar export of recent additions, daily, kept 365 days in `scan_hashes`), compared **locally** with the checksum every file gets while it is stored — no file and no checksum leaves the server |
| ClamAV | licence `malware_scanning` | clamd over TCP (`INSTREAM`), on this server (optional container, see below) or in the network (e.g. `nas.home.lan:3310`) |
| Own scanner | licence `malware_scanning` | ICAP (RFC 3507, `RESPMOD` with `Allow: 204`; `X-Infection-Found`, `X-Virus-ID`, `X-Violations-Found`) — ESET, Sophos, Kaspersky, c-icap … |

Photos, videos and audio of the own Drive uploads only get the Grundschutz. Files above the size limit (default 200 MB) only get the Grundschutz and count as not scannable. The Vault is end-to-end encrypted and never seen by GateControl — it is not checked.

### States and enforcement

`plugin_media.scan_state`: `pending` → `clean` | `infected` | `unscannable`; `unchecked` (source switched off, files from before); `scan_blocked = 1` → the file is not served: `423` with `scan_pending` (check running, `Retry-After`), `quarantined` or `scan_blocked` on every download (apps, portal, frames, capability URLs, public links — ZIPs leave such files out), and the host API refuses to send it anywhere (`ERR_MEDIA_QUARANTINED` …, hand-over). The upload waits up to 15 s for the result; a larger file stays pending and is finished in the background (plugin hook `mediaScanned`).

- **On a finding** (all sources): quarantine (30 days, nobody can open it, then deleted), only mark, or delete at once (`422 infected`). Notification `malware_found` (also into the inbox of the person whose file it was), Logs & Monitoring.
- **Not scannable** (encrypted ZIP, too large, too deep): mark or block.
- **Scanner not reachable**: "Später prüfen" (default) — the file is accepted after the Grundschutz, served, and checked again every 5 minutes; "Uploads anhalten" — the upload is refused (`503 scan_unavailable`). Notification once per outage.
- **Quarantine**: finding, source, sender (mail), person, size, SHA-256, "auch bekannt bei MalwareBazaar"; **Erneut prüfen**, **Löschen**, **Trotzdem freigeben** (logged in the activity log as a warning; the checksum goes on the exception list `scan_exceptions` and is never reported again; part of backups). **Verlauf**: found, not scannable, deleted, released (12 months).
- **Nightly rescan** (licence): Drive files of the last 30 days with the newest signatures at 03:30 (nightly or Sundays).
- Every source can be switched off: Drive – shared-link uploads, Drive – own uploads and photo backup, GateDrop, Mail – attachments, Messenger – files, other plugins (off by default).

### Signatures and updates

- `VERSION` of clamd gives engine, daily version and its date; the DNS TXT record `current.cvd.clamav.net` (what freshclam asks — no HTTP, no new dependency) gives the latest published engine, main, daily and bytecode versions → "Update verfügbar" and "Signaturen älter als 2 Tage" (warning once a day).
- Signatures are fetched by freshclam inside the scanner; GateControl checks the state every 2 / 6 / 24 hours and sends `RELOAD` when a newer daily is published, so clamd picks up what freshclam downloaded. "Signaturen jetzt aktualisieren" sends `RELOAD` and fetches the malware list.
- Engine updates: ClamAV on this server follows the `clamav/clamav:1.4` (LTS) tag — `update.sh` pulls it and recreates the container after every GateControl update; ClamAV in the network is updated there (GateControl only shows that a newer version exists).

### ClamAV on this server

Choosing "ClamAV auf diesem Server" is enough when the host runs `update.sh` (marker 3) every 5 minutes: the server writes `"clamav":"on"` into `data/.auto-update-config.json`, and every run of `update.sh` starts the container `clamav` when it is not running — the compose profile `clamav` when `docker-compose.yml` has the service, otherwise `docker run` with the same settings and a `clamd.conf` in `<deploy dir>/clamav/` (not on the `/data` volume GateControl can write). Another scanner chosen → the container is removed again, but only one `update.sh` started (marker `<deploy dir>/clamav/.managed`); the signatures volume stays. Below 3000 MB RAM it is not started (`GC_CLAMAV_MIN_MEM_MB`); a failed start is retried every 30 minutes. `update.sh` reports to `data/.clamav-state.json` (`running|starting|failed|stopped`, `low_memory|start_failed`); the Virenscan page shows it while the scanner does not answer.

By hand (no `update.sh` cron): `docker compose --profile clamav up -d` (or `COMPOSE_PROFILES=clamav` in `.env`) starts the optional `clamav` service of `docker-compose.yml`: host network, clamd on `127.0.0.1:3310` only, `freshclam` 12× a day, signatures in the volume `clamav-db`, `mem_limit: 2g`. `ConcurrentDatabaseReload no` keeps the peak at about 1.5 GB during a signature reload (instead of ~3 GB; scans wait for the reload). Then choose "ClamAV auf diesem Server".

### Security

- Scanner addresses must resolve to own networks only (loopback, RFC 1918, CGNAT, ULA, link-local; never 169.254.169.254); the connection goes to the checked address. `GC_SCAN_ALLOW_PUBLIC=1` allows a scanner elsewhere.
- The file is streamed in 64 KB chunks from the sealed file to the scanner (never buffered); time limit 60 s + 1 s per MB; at most two checks at a time; the main thread only decrypts chunks; inner ZIPs are inflated asynchronously (≤ 50 MB).
- The abuse.ch key is stored encrypted (`scan.abusech_key_encrypted`) and never shown again.

### API (admin session only)

```
GET    /api/v1/settings/scan
PUT    /api/v1/settings/scan                  { engine: none|clamav_local|clamav_net|icap, address, icap_service, unreachable: later|hold,
                                                sources: {…}, action: quarantine|mark|delete, unscannable: mark|block, notify,
                                                max_mb, archive_depth, rescan: nightly|weekly|off, sig_check_h: 2|6|24, abusech_key }
POST   /api/v1/settings/scan/test             "Verbindung testen"
POST   /api/v1/settings/scan/eicar            "Mit Testdatei prüfen" (nothing stored)
POST   /api/v1/settings/scan/refresh          "Signaturen jetzt aktualisieren"
POST   /api/v1/settings/scan/recheck-all
GET    /api/v1/settings/scan/history
POST   /api/v1/settings/scan/findings/:id/recheck
POST   /api/v1/settings/scan/findings/:id/release
DELETE /api/v1/settings/scan/findings/:id
```

Plugins and apps: [docs/feature-malware-scan-contract.md](docs/feature-malware-scan-contract.md). Migration 124.

---

## Password Complexity Enforcement

Configurable password rules for minimum length, uppercase letters, numbers, and special characters.

### Configuration

Navigate to **Settings > Security**:

| Rule | Default |
|------|---------|
| **Minimum Length** | 8 characters |
| **Require Uppercase** | Off |
| **Require Numbers** | Off |
| **Require Special Characters** | Off |

### API

```bash
# Get password rules
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/settings/security

# Update rules
curl -X PUT https://gate.example.com/api/v1/settings/security \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "password": {
      "min_length": 12,
      "require_uppercase": true,
      "require_numbers": true,
      "require_special": true
    }
  }'
```

### Important Notes

- Rules applied when changing admin password or setting route-auth passwords
- All enabled rules must pass (AND logic)
- Special characters: `!@#$%^&*`
- Error messages localized (EN + DE)

---

## Configurable Operational Timeouts

Environment variables for tuning all operational timeouts and background task intervals.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GC_WG_COMMAND_TIMEOUT` | WireGuard CLI timeout | 10000 ms |
| `GC_CADDY_API_TIMEOUT` | Caddy admin API timeout | 10000 ms |
| `GC_WEBHOOK_TIMEOUT` | Webhook delivery timeout | 10000 ms |
| `GC_WEBHOOK_ALLOW_PRIVATE` | Allow webhooks to private/LAN targets (RFC1918, CGNAT, ULA, WireGuard subnet); loopback, link-local/metadata stay blocked | false |
| `GC_WEBHOOK_MAX_REDIRECTS` | Redirects followed per webhook delivery, each re-validated (0-5) | 3 |
| `GC_MONITOR_HTTP_TIMEOUT` | HTTP health check timeout | 10000 ms |
| `GC_MONITOR_TCP_TIMEOUT` | TCP health check timeout | 5000 ms |
| `GC_TRAFFIC_INTERVAL` | Traffic snapshot interval | 60000 ms |
| `GC_PEER_POLL_INTERVAL` | Peer status poll interval | 30000 ms |
| `GC_CADDY_SYNC_DELAY` | Delay before initial Caddy sync | 5000 ms |
| `GC_SHUTDOWN_TIMEOUT` | Graceful shutdown timeout | 10000 ms |

### Settings UI

Additional tuning available via **Settings > Advanced**:

- Monitoring interval (seconds)
- Data retention (days)
- Peer timeout (days)

---

## Peer Expiry

Automatically disable peers after a configurable time period. Useful for temporary guest access, contractor VPN, or time-limited demo environments.

### How It Works

1. When creating or editing a peer, set an expiration date:
   - **Never** (default) — peer stays active indefinitely
   - **1 day / 7 days / 30 days / 90 days** — relative to creation/edit time
   - **Custom date** — pick any future date via date picker

2. A background task checks every 60 seconds for expired peers. When found:
   - The peer is automatically disabled (`enabled = 0`)
   - WireGuard config is resynced (peer removed from active config)
   - An activity event `peer_expired` is logged
   - If email alerts are configured for peer events, a notification is sent

3. Visual indicators in the peer list:
   - **Expired** — red tag, peer is disabled
   - **Expires soon** — orange tag, expires within 7 days
   - **Expires on [date]** — grey tag for future dates

### API

```bash
# Create peer with 30-day expiry
curl -X POST https://gate.example.com/api/v1/peers \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "guest-access",
    "description": "Temporary guest",
    "expires_at": "2026-04-21T00:00:00.000Z"
  }'

# Update expiry (set to never)
curl -X PUT https://gate.example.com/api/v1/peers/5 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"expires_at": null}'

# Update expiry (extend by 30 days from now)
curl -X PUT https://gate.example.com/api/v1/peers/5 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"expires_at": "2026-05-22T00:00:00.000Z"}'
```

### Backup/Restore

Peer expiry dates are included in backups and restored automatically.

---

## Peer Access Control (ACL)

Restrict which WireGuard peers can access specific routes. By default, any peer can reach any route's backend through the VPN tunnel. ACL adds per-route access restrictions enforced at the Caddy reverse proxy level.

### How It Works

1. Open a route's settings (create or edit) and enable **"Peer Access Control"**
2. A checklist of all peers appears — select which peers should have access
3. GateControl generates a Caddy `remote_ip` matcher with the WireGuard IPs of the selected peers
4. Caddy only allows requests from those IPs — all others receive a 403 Forbidden

### Example

| Peer | WireGuard IP |
|------|-------------|
| Alice Laptop | 10.8.0.2 |
| Bob Phone | 10.8.0.3 |
| Guest WiFi | 10.8.0.4 |

**Route: nas.example.com** — ACL enabled, only Alice + Bob allowed:

```
Alice (10.8.0.2) → nas.example.com → Allowed
Bob   (10.8.0.3) → nas.example.com → Allowed
Guest (10.8.0.4) → nas.example.com → 403 Forbidden
```

### Generated Caddy Config

When ACL is enabled, GateControl adds a `remote_ip` matcher to the route:

```json
{
  "match": [{
    "host": ["nas.example.com"],
    "remote_ip": {
      "ranges": ["10.8.0.2/32", "10.8.0.3/32"]
    }
  }],
  "handle": [{ "handler": "reverse_proxy", "upstreams": [{"dial": "10.8.0.5:5001"}] }]
}
```

### Important Notes

- **ACL off** (default) = all peers can access the route
- **ACL on, no peers selected** = all traffic is blocked (warning shown in UI)
- ACL only affects traffic **through the WireGuard tunnel** (Caddy checks peer VPN IPs)
- ACL changes are synced to Caddy immediately
- ACL rules are included in backup/restore (peers referenced by name for portability)

### API

```bash
# Create route with ACL
curl -X POST https://gate.example.com/api/v1/routes \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "nas.example.com",
    "target_ip": "10.8.0.5",
    "target_port": 5001,
    "acl_enabled": true,
    "acl_peers": [3, 4]
  }'

# Update ACL on existing route
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "acl_enabled": true,
    "acl_peers": [3, 4, 5]
  }'

# Disable ACL
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"acl_enabled": false}'
```

---

## Automatic Backups

Schedule automatic backups at configurable intervals with retention management. Backup files are stored locally and can be downloaded or deleted via the Settings UI.

### Configuration

Navigate to **Settings > Automatic Backups**:

| Setting | Options | Default |
|---------|---------|---------|
| **Enable** | On/Off toggle | Off |
| **Schedule** | Every 6 hours, Every 12 hours, Daily, Every 3 days, Weekly | Daily |
| **Retention** | Number of backups to keep (oldest deleted first) | 5 |

### How It Works

1. Enable automatic backups and choose a schedule
2. GateControl runs the backup at the configured interval using the same backup engine as manual backups
3. Files are saved to `/data/backups/` as `gatecontrol-YYYYMMDD-HHmmss.json`
4. After each backup, files exceeding the retention limit are automatically deleted (oldest first)
5. On backup failure, an email alert is sent (if email alerts are configured)

### File Management

The Settings page shows all existing backup files with:
- **Filename** and file size
- **Download** button — download the backup file
- **Delete** button — remove individual backup files
- **Run Now** button — trigger an immediate backup regardless of schedule

### Storage Location

Backups are stored in `/data/backups/` inside the Docker container. Since `/data/` is mounted as a Docker volume (`gatecontrol-data`), backups persist across container restarts and updates.

Backups contain password and API-token hashes and encrypted keys, so they are owner-only on the host: the directory is `0700`, every backup file `0600` (backups from older versions are tightened on the next start).

### API

```bash
# Get auto-backup settings
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/settings/autobackup

# Enable daily backups, keep 10
curl -X PUT https://gate.example.com/api/v1/settings/autobackup \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "schedule": "daily", "retention": 10}'

# Trigger immediate backup
curl -X POST https://gate.example.com/api/v1/settings/autobackup/run \
  -H "Authorization: Bearer gc_your_token"

# List backup files
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/settings/autobackup/list

# Download a specific backup
curl -H "Authorization: Bearer gc_your_token" \
  -o backup.json \
  https://gate.example.com/api/v1/settings/autobackup/download/gatecontrol-20260322-120000.json

# Delete a backup file
curl -X DELETE -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/settings/autobackup/gatecontrol-20260322-120000.json
```

### Off-site Backups (built in)

With the **scheduled backups** licence, GateControl uploads an encrypted copy (`gatecontrol-YYYYMMDD-HHmmss.gcbk`, passphrase + scrypt/AES-256-GCM) of every automatic backup to SFTP, SMB, S3-compatible storage or WebDAV (**Settings > Backups > Off-site**), keeps the newest *n* per target and offers a read-only restore test.

**NAS behind the VPN.** WebDAV, SMB and SFTP targets have the same **Connection** choice as the storage targets (`via`, shared code in `src/services/storageTargets/via.js`):

| Connection | Connects to |
|---|---|
| Directly to the address (default) | the URL's / host field's own address, as before |
| Through a VPN device | the peer's VPN address and the given port (e.g. a gateway peer forwarding to the NAS, port 5006) |
| Through a route | what Caddy dials for the route, never Caddy itself: an L4 route's target or gateway listener (internal-only is fine); WebDAV over http also an HTTP route through a gateway's companion proxy |

For WebDAV the URL still sets the scheme, path, `Host` header and the name for SNI and the certificate check, so the NAS's certificate for `nas.example.com` stays valid through the tunnel; a private certificate or CA can be stored per target (**Own certificate or CA (PEM)**). SMB uses `smbclient -I <address> -p <port>`, SFTP connects to the dialled address. **Take over a storage target from Drive/plugins** fills URL, user, connection and certificate from an existing WebDAV/SMB storage target and copies its password once on save (logged in the activity log). When a connection to the target's own address is refused or times out and that name resolves to this server's public IP, the test says so ("The address points to this GateControl server itself …"). A JSON-backup restore re-links the peer / route of a target's connection by peer name / route domain.

API: `config.via` = `{ kind: 'host' }` | `{ kind: 'peer', peerId, port }` | `{ kind: 'route', routeId }`, WebDAV `config.tls_ca` (PEM), `config.password_from_storage_target` (write-only); `GET /api/v1/settings/backup/targets/storage-sources` lists the storage targets that can be taken over (never a secret); transport errors carry `hint: 'self_address'`.

### Combining with External Storage

For off-site backup storage, use API tokens and a cron job:

```bash
# /usr/local/bin/gatecontrol-offsite-backup.sh
#!/bin/bash
TOKEN="gc_your_token"
URL="https://gate.example.com"

# Trigger a fresh backup
curl -sf -X POST -H "Authorization: Bearer $TOKEN" "$URL/api/v1/settings/autobackup/run"

# Get latest filename
LATEST=$(curl -sf -H "Authorization: Bearer $TOKEN" "$URL/api/v1/settings/autobackup/list" \
  | jq -r '.files[0].name')

# Download and copy to NAS/S3/etc.
curl -sf -H "Authorization: Bearer $TOKEN" \
  -o "/mnt/nas/backups/$LATEST" \
  "$URL/api/v1/settings/autobackup/download/$LATEST"
```

---

## Log Export

Export activity logs and access logs as CSV or JSON files for compliance, external analysis, or archival purposes.

### Usage

On the **Logs** page, export buttons appear next to the log tabs:

- **Export CSV** — downloads a CSV file with header row
- **Export JSON** — downloads a pretty-printed JSON array

Export respects the currently active filters (e.g., status code filter for access logs).

### File Formats

**Activity Log CSV:**
```csv
timestamp,event,severity,message,details
2026-03-22T10:30:00Z,peer_created,info,Peer created: my-laptop,{"peer_id":5}
2026-03-22T10:31:00Z,route_created,info,Route created: app.example.com,{"route_id":3}
```

**Access Log CSV:**
```csv
timestamp,domain,method,path,status,remote_ip,user_agent
2026-03-22T10:30:00Z,app.example.com,GET,/,200,10.8.0.2,Mozilla/5.0...
2026-03-22T10:30:01Z,app.example.com,POST,/api/data,201,10.8.0.2,curl/8.0
```

**JSON format** contains the same fields as an array of objects.

### File Naming

- `gatecontrol-activity-YYYYMMDD.csv` / `.json`
- `gatecontrol-access-YYYYMMDD.csv` / `.json`

### API

```bash
# Export activity log as CSV
curl -H "Authorization: Bearer gc_your_token" \
  -o activity.csv \
  "https://gate.example.com/api/v1/logs/activity/export?format=csv"

# Export activity log as JSON
curl -H "Authorization: Bearer gc_your_token" \
  -o activity.json \
  "https://gate.example.com/api/v1/logs/activity/export?format=json"

# Export access log as CSV (with status filter)
curl -H "Authorization: Bearer gc_your_token" \
  -o access-errors.csv \
  "https://gate.example.com/api/v1/logs/access/export?format=csv&status=500"

# Export access log filtered by domain
curl -H "Authorization: Bearer gc_your_token" \
  -o access.json \
  "https://gate.example.com/api/v1/logs/access/export?format=json&domain=app.example.com"
```

### Token Scope

Log export endpoints require the `logs` token scope.

### Filters (optional)

Both list endpoints and their exports take additional filters; without them
they answer exactly as before. Invalid values are a `400` (`code: INVALID_QUERY`, `param`).

| Endpoint | Filters |
|---|---|
| `/api/v1/logs/activity`, `…/activity/export` | `severity` (comma list of `info,success,warning,error`), `category` (`login`, `peer`, `route`, `security`), `event` (comma list of exact event types, ≤ 20), `q` (text in message, event type or source), `from`/`to` (epoch ms or ISO) |
| `/api/v1/logs/access`, `…/access/export` | `domain`, `status` (one code or a comma list — each selects its class, `404` → 4xx), `method`, `q` (host, path, client IP, user agent), `from`/`to` |

`counts=1` adds the numbers for filter chips and a histogram:

- activity: `counts` per severity (ignoring the severity filter), `events` (event types with count, top 100), `histogram`
- access: `counts` per status class (ignoring the status filter), `histogram`

`bucket` = `1m`, `5m`, `15m`, `1h`, `6h`, `1d` or `auto` (≤ 120 buckets for `from`…`to`, `1h` without `from`).

---

## Server Log

GateControl writes its own log (pino JSON lines, secrets redacted) to stdout
**and** to a rotating file in the data directory: `/data/logs/server.log`,
rotated by size (5 MB × 5 files: `server.log`, `server.log.1` … `server.log.4`),
directory `0700`, files `0600`. Writing is asynchronous and batched (no fsync
per line); a full disk or missing permissions never disturb the host — lines are
dropped, the next successful write notes how many, and stdout carries one
warning per failure streak.

| Variable | Default | |
|---|---|---|
| `GC_SERVER_LOG` | on (off under `NODE_ENV=test`) | `off` keeps the log on stdout only |
| `GC_SERVER_LOG_DIR` | `<GC_DATA_DIR>/logs` | directory of `server.log` |
| `GC_SERVER_LOG_MAX_MB` | `5` | size per file (1–100) |
| `GC_SERVER_LOG_FILES` | `5` | files kept incl. the current one (1–20) |

### API (administrators only)

The server log holds internal details (plugin ids and errors, paths, stack
traces). Both endpoints answer only an **admin session** — API tokens are
refused (`403`) even with the `logs` scope, like the support bundles. The export
is part of diagnosis and support and is **not** behind the `log_export` licence.

```
GET /api/v1/logs/server?level=&q=&from=&to=&plugin=&module=&msg=&field=&before=&limit=&counts=&bucket=
GET /api/v1/logs/server/export?format=log|json|csv + the same filters
```

- `level` — comma list of `error` (incl. fatal), `warn`, `info`, `debug` (incl. trace); empty = all
- `q` — text in the message or any field, case-insensitive (≤ 200 characters)
- `from`/`to` — epoch ms or ISO, inclusive
- `plugin`, `module` — exact value of that field; `field=key:value` (repeatable, ≤ 5) for any other top-level field, e.g. `field=op:run`
- `msg` — text in the message only
- `limit` — 1–500 (default 200); newest first. `next` of the answer goes into `before` for the next, older page (`more: false` at the end)
- `counts=1` — `counts` per level group for the filter without its level, `histogram { bucketMs, buckets[{ t, time, error, warn, info, debug }] }` (`bucket` as above)

Entries: `{ ts, time, level, levelName, msg, fields }` (`fields` = everything but
level/time/msg/pid/hostname; lines over 32 KB come with `fields: { truncated, bytes }`).
The answer also carries `enabled`, `files [{ name, size, mtime }]` and
`retention { maxBytes, files }`.

Export (oldest first, streamed, at most 200 000 lines), file name
`gatecontrol-server-YYYYMMDD-HHMM.<format>`:

- `log` — `2026-11-02T08:22:38.286Z WARN  event loop was blocked {"blockedMs":2300,"tasks":["ipblock.rebuild ×3: 2210 ms"]}`
  (`tasks`: the marked background jobs — every timer of the server, the start
  steps `boot.*`, IP block, virus scan, backup, plugin media areas, home
  cache, plugin catalogue/updates, log problems — that ran in the blocked
  time, with their time in it, and the synchronous pieces of 20 ms or more:
  request handlers and their `res.json`/`res.send` (`GET /api/v1/…/:id`),
  messages of plugin processes and the answers to them (`plugin <id> <api>`);
  process starts of 20 ms or more (`spawn <program>`); async jobs carry
  `(async)` — they were under way, possibly only waiting — and come after the
  synchronous ones;
  `requests`: the requests and plugin host calls open in that time; each
  missing when empty). WAL checkpoints of the database run in a worker
  thread (`db/checkpointWorker.js`; `GC_DB_CHECKPOINT=main` keeps SQLite's
  automatic checkpoint on the main thread).
- `json` — array of the pino objects as written
- `csv` — `time,level,msg,plugin,module,details`


---

## Logs & Monitoring

The page **System › Logs & Monitoring** (`/logs`) shows every log source of the
host in one place: the server log (above), plugin logs (`gc.log`), the activity
log, Caddy's access log and remote desktop sessions.

- **Slow data disk** (since 1.255.0) — a write probe (4 KB + sync every
  2 minutes, in a worker thread) shows one hint at the top of the page while
  the disk needs 50 ms or more per write on average over half an hour: SSD,
  not a network share, an SD card or a busy NAS volume (docs/plugins.md,
  "Write speed of the data disk").
- **Ereignisse** — all sources as one list, newest first: time range (1 h, 24 h,
  7 days, 30 days, custom), live updates (every 15 s), KPI tiles (errors with
  the change against the period before, warnings with the most frequent code,
  "Server blockiert" = `event loop was blocked`, HTTP 5xx of all requests,
  plugins with errors — a click sets the filter), a timeline per level (drag =
  range, click = that slot), facets for level, source and plugin with counts,
  search with syntax (`plugin:mail`, `source:server`, `code:storage_timeout`,
  `-debug`, `"exact text"`, `-word`), chips, "Gleiche zusammenfassen", time
  clusters (≥ 3 warnings/errors from ≥ 2 sources within 2 s), multi-select
  (export, copy as text, "Zur selben Zeit zeigen") and endless loading. The
  filter lives in the address (`/logs#events?level=error&source=server`).
- **Entry** (`/logs#e/<id>`) — "Was bedeutet das?" for known codes (storage
  timeout, storage worker restarted, event loop blocked, slow plugin database,
  slow disk, plugin did not start in time, `no_right`, `lock_unreachable`,
  failed sign-in, malformed request body), the problem it
  belongs to, fields with "use as filter", raw JSON, copy, link, export with
  surroundings, and "Zur selben Zeit" (±10 s / ±1 min / ±5 min, all sources and levels).
- **Probleme** — errors and warnings grouped across sources: by code (also
  `ERR_*`, `E*` system codes, the event type of the activity log), otherwise by
  the normalised message; HTTP 5xx per status and host. Status open / watch /
  resolved / muted 7 days (stored in `log_problems`), "returned" when a
  resolved problem occurs again, sparkline, affected sources and plugins,
  correlation "Fällt zusammen mit …" (another problem within ±2 s at at least
  half of the occurrences). With "Benachrichtigen, wenn es nach „Erledigt“
  wieder auftritt" a returned problem is logged once as `log_problem_returned`
  (warning) — rules of the notification centre (event "Log-Problem wieder
  aufgetreten"), webhooks and alert e-mails pick it up.
- **Zugriffe** (access log with status classes and counts), **Sitzungen** (RDP
  history) and **Gespeicherte Filter** (saved filters and export templates,
  shared by all administrators, table `log_saved_views`).
- **Export** — current view, selection, one problem, time window around an
  entry, or the **Fehlerbericht** (ZIP: README with versions, `problems.json`,
  per problem up to 10 examples with all entries ±10 s, `versions.json`);
  CSV, JSON, NDJSON or text; columns; privacy (shorten IPs, mask e-mail
  addresses, user names → `user-<id>`); local time zone or UTC; preview with
  count and size; templates; optional note in the activity log. Exports are
  streamed while downloading.

### Rights and licence

| | admin session | token with `logs` |
|---|---|---|
| activity, access, sessions | ✓ | ✓ |
| server log, plugin logs | ✓ | — (403 when asked for) |
| problems, saved views, error report | ✓ | — |

Exports of activity and access keep needing the licence feature `log_export`
(the dialog shows them locked); server, plugins and sessions export freely.

### API

```
GET /api/v1/logs/meta
GET /api/v1/logs/events?from=&to=&level=&source=&plugin=&q=&problem=&before=&limit=
GET /api/v1/logs/events/stats?…&bucket=auto|1m|5m|15m|1h|6h|1d
GET /api/v1/logs/events/item?id=
GET /api/v1/logs/events/export?scope=view|selection|problem|window|report&format=csv|json|ndjson|log
    &columns=time,level,source,message,fields,raw&mask_ip=1&mask_email=1&pseudonymize=1&tz=utc|<IANA>&note=1
    (+ ids= for selection, problem= for problem, around=<id>&window=10|60|300 for window)
GET /api/v1/logs/events/export/preview?…   (first rows, count, bytes, file name)
GET /api/v1/logs/problems?status=open|watch|resolved|muted&sort=last|count|severity&from=&to=
GET /api/v1/logs/problems/item?key=
PUT /api/v1/logs/problems/state   { key, status?, notifyOnReturn?, title? }
GET|POST /api/v1/logs/saved, DELETE /api/v1/logs/saved/:id
```

Entries: `{ id, source, ts, time, level, levelName, msg, ctx, plugin, pluginName, code }`
(`fields`, `raw` for one entry). Ids: `s.<ts>.<hash>` (server), `p.<id>` (plugins),
`a.<id>` (activity), `h.<ts>.<hash>` (access), `r.<id>` (sessions).

---

## API Tokens

Stateless token authentication for automation, CI/CD pipelines, scripts, and external integrations. See [API_GUIDE.md](API_GUIDE.md) for complete integration examples with Home Assistant, Python, Node.js, Bash, and more.

### Creating Tokens

1. Navigate to **Settings > API Tokens**
2. Enter a token name (e.g., "Home Assistant", "Backup Script")
3. Select scopes (permissions)
4. Optionally set an expiry date
5. Click **Create** — the token (`gc_...`) is shown **once**. Copy it immediately.

### Scopes

| Scope | Access |
|-------|--------|
| `full-access` | All endpoints (read + write) |
| `read-only` | GET requests on all endpoints |
| `peers` | Full access to peer endpoints |
| `routes` | Full access to route endpoints |
| `settings` | Settings + SMTP endpoints |
| `webhooks` | Webhook endpoints |
| `logs` | Log endpoints + export |
| `system` | System, WireGuard, Caddy endpoints |
| `backup` | Backup/restore endpoints |

### API

```bash
# Create token
curl -X POST https://gate.example.com/api/v1/tokens \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CI/CD Deploy",
    "scopes": ["routes"],
    "expires_at": "2026-12-25"
  }'

# List tokens (masked)
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/tokens

# Revoke token
curl -X DELETE https://gate.example.com/api/v1/tokens/3 \
  -H "Authorization: Bearer gc_your_token"

# Use token (two methods)
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/peers

curl -H "X-API-Token: gc_your_token" \
  https://gate.example.com/api/v1/peers
```

### Security

- Only the SHA-256 hash is stored in the database — the raw token cannot be retrieved after creation
- Tokens use the `gc_` prefix (48 random bytes, hex-encoded) for easy identification
- Token-authenticated requests bypass CSRF (stateless, no session)
- Tokens **cannot create or delete other tokens** (prevents privilege escalation)
- Each token has its own rate limit counter (1000 requests / 15 min)

---

## Gzip/Zstd Compression

Per-route response compression via Caddy's `encode` handler. Reduces bandwidth 60–80% for text content.

### How It Works

1. Enable compression on any HTTP route
2. Caddy applies Zstd (preferred) or Gzip based on the client's `Accept-Encoding` header
3. Compression is transparent — clients decompress automatically
4. Bodies smaller than ~100 bytes are not compressed (overhead)

### API

```bash
# Enable compression
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"compress_enabled": true}'
```

### Generated Caddy Config

```json
{
  "handler": "encode",
  "encodings": {
    "zstd": {},
    "gzip": {}
  }
}
```

### Important Notes

- Browser support: Gzip (all browsers), Zstd (Chrome 123+, Firefox 112+)
- Typical savings: HTML 75–80%, CSS 82–86%, JSON 85–89%
- Mirror targets receive uncompressed data (compression applied after mirroring)
- Only for HTTP routes, not L4

---

## Custom Request/Response Headers

Per-route key-value editor for custom HTTP headers with CORS and security header presets.

### How It Works

1. Open a route's edit modal and navigate to the **Headers** tab
2. Add request headers (sent to backend) or response headers (sent to client)
3. Use presets for common CORS or security headers

### Configuration

| Setting | Limit |
|---------|-------|
| **Header Name** | Alphanumeric + hyphen, max 256 chars |
| **Header Value** | Max 4096 chars, no Caddy placeholders |
| **Presets** | CORS headers, Security headers |

### API

```bash
# Set custom headers
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "custom_headers": {
      "request": [
        {"name": "X-Custom", "value": "my-value"},
        {"name": "X-Forwarded-Custom", "value": "test"}
      ],
      "response": [
        {"name": "X-Powered-By", "value": "GateControl"},
        {"name": "Cache-Control", "value": "max-age=3600"}
      ]
    }
  }'
```

### Important Notes

- Header name validation: `^[a-zA-Z0-9\-]+$` (prevents injection)
- Caddy placeholders (e.g., `{http.request.header.user}`) are rejected
- Request headers added before reverse proxy; response headers set after backend response

---

## Per-Route Rate Limiting

Configurable requests-per-IP-per-window via the `caddy-ratelimit` plugin.

### How It Works

1. Enable rate limiting on any HTTP route
2. Set max requests and time window
3. Each client IP gets a separate quota
4. HTTP 429 returned when limit exceeded, with `Retry-After` header

### Configuration

| Setting | Options |
|---------|---------|
| **Max Requests** | Number per window |
| **Window** | 1s, 1m, 5m, 1h |

### API

```bash
# Enable rate limiting (100 requests per minute)
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "rate_limit_enabled": true,
    "rate_limit_requests": 100,
    "rate_limit_window": "1m"
  }'
```

### Generated Caddy Config

```json
{
  "handler": "rate_limit",
  "rate_limits": {
    "static": {
      "key": "{http.request.remote.host}",
      "window": "1m",
      "max_events": 100
    }
  }
}
```

### Important Notes

- Per-IP rate limiting — clients behind NAT share the same limit
- Window validation: accepts `1s`, `1m`, `5m`, `1h`; invalid values default to `1m`
- Only for HTTP routes, not L4
- Rate limiting counts only primary requests, not mirror targets

---

## Retry with Backoff

Automatic retries on backend connection failure via Caddy's load balancing retries.

### How It Works

1. Enable retry on any HTTP route
2. Set retry count (1–10)
3. On connection error, Caddy retries the request up to N times
4. With multiple backends, retries rotate across available upstreams

### API

```bash
# Enable retry (5 attempts)
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "retry_enabled": true,
    "retry_count": 5
  }'
```

### Important Notes

- Retries are immediate (no exponential backoff or jitter)
- All HTTP methods retried (idempotency not enforced)
- Single backend: retries go to the same server
- Multiple backends: retries provide failover behavior
- Only for HTTP routes, not L4

---

## Multiple Backends / Load Balancing

Weighted round-robin across multiple backend targets per route. Backend targets use peer dropdowns — IPs are resolved at Caddy config build time.

### How It Works

1. Open a route's edit modal and add multiple backends
2. Select peers from a dropdown and assign ports and weights
3. GateControl resolves peer IPs when building Caddy config
4. Disabled peers are automatically skipped
5. When a peer's IP changes, the next config rebuild picks up the new IP

### API

```bash
# Set multiple backends with weights
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "backends": [
      {"peer_id": 1, "port": 8080, "weight": 50},
      {"peer_id": 2, "port": 8080, "weight": 50},
      {"peer_id": 3, "port": 8080, "weight": 100}
    ]
  }'
```

### Generated Caddy Config

```json
{
  "handler": "reverse_proxy",
  "upstreams": [
    {"dial": "10.8.0.3:8080"},
    {"dial": "10.8.0.4:8080"},
    {"dial": "10.8.0.5:8080"}
  ],
  "load_balancing": {
    "selection_policy": {
      "policy": "weighted_round_robin",
      "weights": [50, 50, 100]
    }
  }
}
```

### Important Notes

- Weight ratio is proportional: 50:50:100 distributes ~25%/25%/50%
- Disabled peers filtered out before building upstreams
- Direct IP targets (`target_ip` without `peer_id`) still supported for backward compatibility
- Pair with Retry for failover behavior
- Pair with Sticky Sessions for session affinity

---

## Sticky Sessions

Cookie-based session affinity for multi-backend routes. The same client is always routed to the same backend.

### How It Works

1. Enable sticky sessions on a route with multiple backends
2. Caddy sets a cookie on the first request
3. Subsequent requests from the same client are routed to the same backend
4. Cookie expires after the configured TTL

### Configuration

| Setting | Default |
|---------|---------|
| **Cookie Name** | `gc_sticky` |
| **Cookie TTL** | 3600 seconds |

### API

```bash
# Enable sticky sessions
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "sticky_enabled": true,
    "sticky_cookie_name": "gc_sticky",
    "sticky_cookie_ttl": "3600"
  }'
```

### Important Notes

- Requires multiple backends (replaces round-robin selection policy)
- Cookie name validation: `^[a-zA-Z0-9_\-]+$`
- TTL converted to Caddy duration (e.g., `"3600s"`)
- Client must accept cookies for affinity to work

---

## Prometheus Metrics Export

`/metrics` endpoint with Prometheus text format for Grafana integration.

### Exported Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `gatecontrol_peers_total` | gauge | Total peers |
| `gatecontrol_peers_online` | gauge | Online peers |
| `gatecontrol_peers_enabled` | gauge | Enabled peers |
| `gatecontrol_peer_status` | gauge | Per-peer online (1/0), labels: `name`, `ip` |
| `gatecontrol_peer_transfer_rx_bytes` | gauge | Per-peer RX bytes |
| `gatecontrol_peer_transfer_tx_bytes` | gauge | Per-peer TX bytes |
| `gatecontrol_routes_total` | gauge | Total routes |
| `gatecontrol_routes_active` | gauge | Enabled routes |
| `gatecontrol_route_monitoring_status` | gauge | Per-route UP (1/0), label: `domain` |
| `gatecontrol_cpu_usage_percent` | gauge | CPU usage % |
| `gatecontrol_memory_usage_percent` | gauge | RAM usage % |
| `gatecontrol_uptime_seconds` | gauge | App uptime |

### Configuration

1. Navigate to **Settings > API** and enable Prometheus
2. Create an API token with `read-only` or `system` scope
3. Configure Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: gatecontrol
    scheme: https
    authorization:
      credentials: gc_your_token
    static_configs:
      - targets: ['gate.example.com']
```

### API

```bash
# Get metrics (header-only auth, no query params)
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/metrics
```

### Important Notes

- Header-only authentication (query parameter `?token=` removed for security)
- Metrics collected on-demand per request (not cached)
- Label values properly escaped (backslash, quote, newline)

---

## Circuit Breaker

Automatic response blocking (HTTP 503) when backends fail repeatedly. Three-state machine with auto-recovery.

### How It Works

```
CLOSED (normal) ──[N failures]──→ OPEN (returns 503)
  ↑                                  │
  └─[success in half-open]──← HALF-OPEN (testing)
                    [failure]──→ OPEN
```

1. **Closed** — normal operation, monitoring counts consecutive failures
2. **Open** — after N failures, Caddy returns 503 with `Retry-After` header
3. **Half-Open** — after timeout, the next monitoring check tests recovery
4. If the check succeeds, state returns to Closed; if it fails, back to Open

### Configuration

| Setting | Options | Default |
|---------|---------|---------|
| **Threshold** | Consecutive failures to trigger | 5 |
| **Timeout** | Seconds before testing recovery | 30 |

### API

```bash
# Enable circuit breaker
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "monitoring_enabled": true,
    "circuit_breaker_enabled": true,
    "circuit_breaker_threshold": 5,
    "circuit_breaker_timeout": 30
  }'

# Manual reset to closed
curl -X PATCH https://gate.example.com/api/v1/routes/1/circuit-breaker \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"status": "closed"}'
```

### Important Notes

- Requires Uptime Monitoring enabled (no monitoring = no state changes)
- In-memory counters reset on app restart (DB persists status)
- Threshold counts consecutive failures only (success resets counter)
- Manual reset clears counter and timestamp

---

## Batch Operations

Multi-select peers and routes for bulk enable/disable/delete with a floating action bar.

### How It Works

1. On the Peers or Routes page, checkboxes appear next to each item
2. Select multiple items — a floating action bar shows the count and available actions
3. Choose **Enable**, **Disable**, or **Delete**
4. All selected items are processed in one request

### API

```bash
# Batch enable peers
curl -X POST https://gate.example.com/api/v1/peers/batch \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"action": "enable", "ids": [1, 2, 5]}'

# Batch delete routes
curl -X POST https://gate.example.com/api/v1/routes/batch \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"action": "delete", "ids": [10, 15, 20]}'

# Response: {"ok": true, "affected": 3}
```

### Important Notes

- Actions: `enable`, `disable`, `delete`
- Activity logged per batch operation (e.g., `peers_batch_enabled`)
- Caddy/WireGuard sync triggered automatically after batch changes

---

## Peer Groups

Organize peers by team or location with colored badges and filter dropdown.

### How It Works

1. Create peer groups with a name, description, and color
2. Assign peers to groups when creating or editing
3. Filter the peer list by group
4. Colored badges appear on peer cards

### API

```bash
# Create group
curl -X POST https://gate.example.com/api/v1/peer-groups \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Office Servers",
    "description": "Servers in main office",
    "color": "#007bff"
  }'

# List groups
curl -H "Authorization: Bearer gc_your_token" \
  https://gate.example.com/api/v1/peer-groups

# Update group
curl -X PUT https://gate.example.com/api/v1/peer-groups/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"name": "Office Servers v2", "color": "#28a745"}'

# Delete group (peers are ungrouped)
curl -X DELETE https://gate.example.com/api/v1/peer-groups/1 \
  -H "Authorization: Bearer gc_your_token"

# Assign peer to group
curl -X PUT https://gate.example.com/api/v1/peers/5 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{"group_id": 1}'
```

### Important Notes

- Color validated via hex regex (prevents CSS injection)
- Deleting a group unsets `group_id` on all member peers (peers are not deleted)
- Groups included in backup/restore (backup format v3)

---

## Request Mirroring

Asynchronous request duplication to up to 5 mirror targets for shadow deployments, debugging, or load testing. The primary response is never affected.

### How It Works

1. Enable request mirroring on any HTTP route
2. Add mirror targets by selecting peers and ports (up to 5)
3. Caddy's custom `mirror` handler duplicates each request asynchronously
4. Mirror targets receive an exact copy (method, URI, headers, body)
5. Mirror failures are silently logged — they never affect the client response

### Configuration

| Setting | Limit |
|---------|-------|
| **Max Targets** | 5 per route |
| **Max Body Size** | 10 MB (larger requests mirrored without body) |
| **Per-Target Timeout** | 10 seconds |

### API

```bash
# Enable mirroring with 2 targets
curl -X PUT https://gate.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "mirror_enabled": true,
    "mirror_targets": [
      {"peer_id": 2, "port": 8080},
      {"peer_id": 3, "port": 8080}
    ]
  }'
```

### Handler Order

```
ACL / Forward Auth → Custom Headers → Rate Limiting → Mirroring → Compression → Reverse Proxy
```

### Important Notes

- Mirror targets receive uncompressed data (mirroring before compression)
- WebSocket upgrades automatically skipped
- Cannot mirror to the primary backend IP (validation)
- Disabled peers skipped at config generation time
- Rate limiting counts only the primary request, not mirrors
- Activity event: `route_mirror_changed`

---

## Mobile Sidebar

Responsive sidebar for phones and tablets. The navigation sidebar collapses into a hamburger menu on screens smaller than 1024px.

### Behavior

| Screen | Sidebar |
|--------|---------|
| Desktop (>= 1024px) | Always visible, no changes |
| Mobile/Tablet (< 1024px) | Hidden by default, hamburger button in topbar |

### Interactions

- **Tap hamburger** — sidebar slides in from left
- **Tap overlay** — sidebar closes
- **Tap nav item** — sidebar closes, navigates
- **Press Escape** — sidebar closes
- **Resize to desktop** — sidebar auto-shows, hamburger hidden

### Accessibility

- Hamburger button has `aria-label` and `aria-expanded`
- Focus trap when sidebar is open (Tab cycles within sidebar)
- 44px minimum touch targets

---

## Theme

GateControl has one UI theme, **Aurora** (Bricolage Grotesque / Hanken Grotesk /
JetBrains Mono, teal accent) with a dark and a light mode (toggle in the top bar,
remembered per browser). The former Classic (`default`) and Pro (`pro`) themes were
removed; `GC_DEFAULT_THEME` is ignored.
