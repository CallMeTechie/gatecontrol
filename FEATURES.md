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
- [Password Complexity Enforcement](#password-complexity-enforcement)
- [Configurable Operational Timeouts](#configurable-operational-timeouts)
- [Peer Expiry](#peer-expiry)
- [Peer Access Control (ACL)](#peer-access-control-acl)
- [Automatic Backups](#automatic-backups)
- [Log Export](#log-export)
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

## Themes

GateControl supports multiple UI themes:

- **Classic** (`default`) — Original design with warm tones (Outfit font, teal accent)
- **Pro** (`pro`) — Clean corporate design (Inter font, Royal Blue accent, Stripe/Linear aesthetic)

Set the default theme via environment variable:

```
GC_DEFAULT_THEME=pro
```

Users can switch themes individually via **Profile → Theme**.
