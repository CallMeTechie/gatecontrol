# GateControl API Reference

All API endpoints are available at `/api/v1/*` with a backward-compatible `/api/*` alias. Every response includes a standardized `{ ok: true/false, ... }` format.

---

## Table of Contents

- [Authentication](#authentication)
- [Rate Limiting](#rate-limiting)
- [Dashboard](#dashboard)
- [Peers](#peers)
- [Routes](#routes)
- [Route Auth](#route-auth)
- [Settings](#settings)
- [SMTP](#smtp)
- [Logs](#logs)
- [WireGuard](#wireguard)
- [Caddy](#caddy)
- [System](#system)
- [Webhooks](#webhooks)
- [API Tokens](#api-tokens)
- [Health Check](#health-check)

---

## Authentication

GateControl supports two authentication methods:

### Session Authentication (Browser)

Used by the web interface. Login via `/login` to obtain a session cookie.

```bash
# Login and store session cookie
curl -c cookies.txt -X POST https://gate.example.com/login \
  -d "username=admin&password=yourpassword"

# Use session cookie for API requests
curl -b cookies.txt https://gate.example.com/api/v1/peers
```

Session-authenticated requests require a **CSRF token** for state-changing operations (POST, PUT, DELETE). The token is available in the `X-CSRF-Token` meta tag or cookie.

### API Token Authentication (Automation)

For scripts, CI/CD pipelines, and external integrations. Create tokens in **Settings > API Tokens**.

```bash
# Using Authorization header
curl -H "Authorization: Bearer gc_your_token_here" \
  https://gate.example.com/api/v1/peers

# Using X-API-Token header
curl -H "X-API-Token: gc_your_token_here" \
  https://gate.example.com/api/v1/peers
```

Token-authenticated requests **do not require CSRF tokens**.

### Token Scopes

Each token has one or more scopes that control access:

| Scope | Access |
|-------|--------|
| `full-access` | All endpoints (read + write) |
| `read-only` | GET requests on all endpoints |
| `peers` | Full access to `/api/v1/peers/*` |
| `routes` | Full access to `/api/v1/routes/*` |
| `settings` | Full access to `/api/v1/settings/*` and `/api/v1/smtp/*` |
| `webhooks` | Full access to `/api/v1/webhooks/*` |
| `logs` | Full access to `/api/v1/logs/*` |
| `system` | Full access to `/api/v1/system/*`, `/api/v1/wg/*`, `/api/v1/caddy/*` |
| `backup` | Full access to backup/restore endpoints |

Multiple granular scopes can be combined (e.g., `peers` + `routes`).

---

## Rate Limiting

| Context | Limit | Window |
|---------|-------|--------|
| Login | 5 attempts | 15 minutes |
| API (per IP or token) | 100 requests | 15 minutes |

Rate-limited responses return `429 Too Many Requests` with a `Retry-After` header.

---

## Dashboard

### Get Dashboard Stats

```
GET /api/v1/dashboard/stats
```

Returns peer count, route count, traffic totals, average latency, and monitoring status.

**Token scope:** `read-only`

### Get Traffic Chart Data

```
GET /api/v1/dashboard/traffic?period=24h
```

| Parameter | Values | Default |
|-----------|--------|---------|
| `period` | `1h`, `24h`, `7d` | `24h` |

**Token scope:** `read-only`

---

## Peers

### List Peers

```
GET /api/v1/peers
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `limit` | Number of peers per page | `50` |
| `offset` | Skip N peers | `0` |

**Token scope:** `peers`

### Get Peer

```
GET /api/v1/peers/:id
```

**Token scope:** `peers`

### Create Peer

```
POST /api/v1/peers
```

```json
{
  "name": "my-laptop",
  "description": "Work laptop",
  "tags": "office,dev"
}
```

Keys (private, public, preshared) and IP address are generated automatically.

**Token scope:** `peers`

### Update Peer

```
PUT /api/v1/peers/:id
```

```json
{
  "name": "my-laptop",
  "description": "Updated description",
  "dns": "1.1.1.1,8.8.8.8",
  "persistentKeepalive": 25,
  "enabled": true,
  "tags": "office,dev,vpn"
}
```

**Token scope:** `peers`

### Delete Peer

```
DELETE /api/v1/peers/:id
```

**Token scope:** `peers`

### Toggle Peer

```
PUT /api/v1/peers/:id/toggle
```

Enables or disables the peer. WireGuard config is synced immediately.

**Token scope:** `peers`

### Download Peer Config

```
GET /api/v1/peers/:id/config
GET /api/v1/peers/:id/config?download=1
```

Returns the WireGuard client configuration. Add `?download=1` to trigger a file download.

**Token scope:** `peers`

### Get Peer QR Code

```
GET /api/v1/peers/:id/qr
```

Returns a QR code image (PNG) for the peer's WireGuard configuration.

**Token scope:** `peers`

### Get Peer Traffic History

```
GET /api/v1/peers/:id/traffic?period=7d
```

| Parameter | Values | Default |
|-----------|--------|---------|
| `period` | `24h`, `7d`, `30d` | `24h` |

**Token scope:** `peers`

---

## Routes

### List Routes

```
GET /api/v1/routes
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `limit` | Number of routes per page | `50` |
| `offset` | Skip N routes | `0` |
| `type` | Filter by route type (`http`, `l4`) | all |

**Token scope:** `routes`

### Get Available Peers

```
GET /api/v1/routes/peers
```

Returns peers for the route target dropdown (id, name, ip).

**Token scope:** `routes`

### Get Route

```
GET /api/v1/routes/:id
```

**Token scope:** `routes`

### Create Route

```
POST /api/v1/routes
```

**HTTP Route:**
```json
{
  "domain": "app.example.com",
  "target_ip": "10.8.0.2",
  "target_port": 8080,
  "description": "Web application",
  "peer_id": 1,
  "https_enabled": true,
  "backend_https": false,
  "basic_auth_enabled": false,
  "monitoring_enabled": true
}
```

**Layer 4 Route:**
```json
{
  "domain": "rdp.example.com",
  "target_ip": "10.8.0.3",
  "target_port": 3389,
  "route_type": "l4",
  "l4_protocol": "tcp",
  "l4_listen_port": 3389,
  "l4_tls_mode": "none"
}
```

**Token scope:** `routes`

### Update Route

```
PUT /api/v1/routes/:id
```

Accepts the same fields as create, plus `enabled`.

**Token scope:** `routes`

### Delete Route

```
DELETE /api/v1/routes/:id
```

**Token scope:** `routes`

### Toggle Route

```
PUT /api/v1/routes/:id/toggle
```

**Token scope:** `routes`

### Check DNS

```
POST /api/v1/routes/check-dns
```

```json
{
  "domain": "app.example.com"
}
```

Checks if the domain resolves to the server's IP.

**Token scope:** `routes`

### Trigger Monitoring Check

```
POST /api/v1/routes/:id/check
```

Manually triggers an uptime monitoring check for the route.

**Token scope:** `routes`

### Upload Branding Logo

```
POST /api/v1/routes/:id/branding/logo
Content-Type: multipart/form-data
```

Upload an image file (max 2MB) as `logo` field.

**Token scope:** `routes`

### Remove Branding Logo

```
DELETE /api/v1/routes/:id/branding/logo
```

**Token scope:** `routes`

### Upload Background Image

```
POST /api/v1/routes/:id/branding/bg-image
Content-Type: multipart/form-data
```

Upload an image file (max 2MB) as `bg_image` field.

**Token scope:** `routes`

### Remove Background Image

```
DELETE /api/v1/routes/:id/branding/bg-image
```

**Token scope:** `routes`

---

## Route Auth

Configure authentication for individual routes. Mounted at `/api/v1/routes/:id/auth`.

### Get Auth Config

```
GET /api/v1/routes/:id/auth
```

Returns auth config without secrets (passwords, TOTP secrets masked).

**Token scope:** `routes`

### Create / Update Auth Config

```
POST /api/v1/routes/:id/auth
```

```json
{
  "auth_type": "email_password",
  "email": "user@example.com",
  "password": "SecurePass123!",
  "two_factor_enabled": true,
  "two_factor_method": "totp",
  "totp_secret": "JBSWY3DPEHPK3PXP",
  "session_max_age": 86400
}
```

| `auth_type` | Description |
|-------------|-------------|
| `email_password` | Email + Password login |
| `email_code` | Email + OTP code (via SMTP) |
| `totp` | TOTP only (Authenticator App) |

**Token scope:** `routes`

### Delete Auth Config

```
DELETE /api/v1/routes/:id/auth
```

**Token scope:** `routes`

### Generate TOTP Secret

```
POST /api/v1/routes/:id/auth/totp-setup
```

Returns a new TOTP secret with QR code URI.

**Token scope:** `routes`

### Verify TOTP Token

```
POST /api/v1/routes/:id/auth/totp-verify
```

```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "token": "123456"
}
```

**Token scope:** `routes`

---

## Settings

### Profile

```
GET  /api/v1/settings/profile
PUT  /api/v1/settings/profile    { "display_name": "Admin", "email": "admin@example.com", "language": "en" }
PUT  /api/v1/settings/password   { "current_password": "old", "new_password": "new" }
POST /api/v1/settings/language   { "language": "de" }
```

**Token scope:** `settings`

### Application Settings

```
GET /api/v1/settings/app
```

Returns app-level settings and environment configuration.

**Token scope:** `settings`

### Security Settings

```
GET /api/v1/settings/security
PUT /api/v1/settings/security
```

```json
{
  "lockout": {
    "enabled": true,
    "max_attempts": 5,
    "duration": 900
  },
  "password": {
    "complexity_enabled": true,
    "min_length": 8,
    "require_uppercase": true,
    "require_number": true,
    "require_special": true
  }
}
```

**Token scope:** `settings`

### Monitoring Settings

```
GET /api/v1/settings/monitoring
PUT /api/v1/settings/monitoring
```

```json
{
  "interval": 60000,
  "email_alerts": true,
  "alert_email": "admin@example.com"
}
```

**Token scope:** `settings`

### Data Retention Settings

```
GET /api/v1/settings/data
PUT /api/v1/settings/data
```

```json
{
  "retention_traffic_days": 30,
  "retention_activity_days": 90,
  "peer_online_timeout": 180
}
```

**Token scope:** `settings`

### IP2Location Settings

```
GET  /api/v1/settings/ip2location
PUT  /api/v1/settings/ip2location       { "api_key": "your-api-key" }
POST /api/v1/settings/ip2location/test  { "ip": "8.8.8.8" }
```

**Token scope:** `settings`

### Email Alert Settings

```
GET /api/v1/settings/alerts
PUT /api/v1/settings/alerts
```

```json
{
  "email": "alerts@example.com",
  "email_events": ["login_failed", "account_locked", "peer_connected", "route_down"],
  "backup_reminder_days": 7,
  "resource_cpu_threshold": 90,
  "resource_ram_threshold": 90
}
```

**Token scope:** `settings`

### Account Lockout Management

```
GET    /api/v1/settings/lockout              # List locked accounts
DELETE /api/v1/settings/lockout/:identifier   # Unlock account
```

**Token scope:** `settings`

### Backup & Restore

```
GET  /api/v1/settings/backup            # Download backup JSON
POST /api/v1/settings/restore/preview   # Validate backup file (multipart, max 10MB)
POST /api/v1/settings/restore           # Restore from backup (multipart, max 10MB)
POST /api/v1/settings/clear-logs        # Clear activity log
```

**Token scope:** `backup` (for backup/restore), `settings` (for clear-logs)

---

## SMTP

```
GET  /api/v1/smtp/settings    # Get SMTP config (password hidden)
PUT  /api/v1/smtp/settings    # Save SMTP config
POST /api/v1/smtp/test        # Send test email
```

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "user": "noreply@example.com",
  "password": "smtp-password",
  "from": "GateControl <noreply@example.com>",
  "secure": true
}
```

**Token scope:** `settings`

---

## Logs

### Activity Log

```
GET /api/v1/logs/activity?page=1&limit=50
```

Returns paginated activity events with severity levels.

### Recent Activity

```
GET /api/v1/logs/recent?limit=10
```

Returns the most recent activity entries (for dashboard widget).

### Access Log

```
GET /api/v1/logs/access?page=1&limit=50&domain=app.example.com&status=200&method=GET
```

| Parameter | Description |
|-----------|-------------|
| `page` | Page number |
| `limit` | Entries per page |
| `domain` | Filter by domain |
| `status` | Filter by HTTP status code |
| `method` | Filter by HTTP method |

**Token scope:** `logs`

---

## WireGuard

```
GET  /api/v1/wg/status    # Interface status (peers, transfer, handshakes)
GET  /api/v1/wg/config    # Masked wg0.conf content
POST /api/v1/wg/restart   # Restart WireGuard interface
POST /api/v1/wg/stop      # Stop WireGuard interface
```

**Token scope:** `system`

---

## Caddy

```
GET  /api/v1/caddy/status   # Caddy status + full JSON config
POST /api/v1/caddy/reload   # Rebuild and push full config to Caddy
```

**Token scope:** `system`

---

## System

```
GET /api/v1/system/resources
```

Returns CPU usage, RAM usage, uptime, and disk usage.

**Token scope:** `system`

---

## Webhooks

### List Webhooks

```
GET /api/v1/webhooks
```

### Create Webhook

```
POST /api/v1/webhooks
```

```json
{
  "url": "https://hooks.example.com/webhook",
  "events": ["peer_connected", "peer_disconnected"],
  "description": "Notify on peer changes"
}
```

Use `["*"]` for all events.

### Update Webhook

```
PUT /api/v1/webhooks/:id
```

```json
{
  "url": "https://hooks.example.com/webhook",
  "events": ["*"],
  "description": "All events",
  "enabled": true
}
```

### Delete Webhook

```
DELETE /api/v1/webhooks/:id
```

### Toggle Webhook

```
PUT /api/v1/webhooks/:id/toggle
```

### Test Webhook

```
POST /api/v1/webhooks/:id/test
```

Sends a test notification to the webhook URL.

**Token scope:** `webhooks`

---

## API Tokens

### List Tokens

```
GET /api/v1/tokens
```

Returns all tokens (without hashes). Shows name, scopes, created date, last used, expiry.

### Create Token

```
POST /api/v1/tokens
```

```json
{
  "name": "CI/CD Pipeline",
  "scopes": ["peers", "routes"],
  "expires_at": "2027-01-01T00:00:00Z"
}
```

**Response** (token value shown only once):
```json
{
  "ok": true,
  "token": "gc_a1b2c3d4e5f6...",
  "id": 1,
  "name": "CI/CD Pipeline",
  "scopes": ["peers", "routes"],
  "expires_at": "2027-01-01T00:00:00Z"
}
```

**Important:** The raw token is returned **only in this response**. Store it securely — it cannot be retrieved again.

### Revoke Token

```
DELETE /api/v1/tokens/:id
```

**Auth:** Token management endpoints require **session authentication only**. API tokens cannot create or revoke other tokens (prevents privilege escalation).

---

## Health Check

```
GET /health
```

No authentication required. Returns health status of database and WireGuard interface.

```json
{
  "status": "healthy",
  "checks": {
    "database": "ok",
    "wireguard": "ok"
  }
}
```

Used by Docker HEALTHCHECK and external monitoring.

---

## Error Responses

All errors follow the standardized format:

```json
{
  "ok": false,
  "error": "Human-readable error message"
}
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request (validation error, missing fields) |
| `401` | Unauthorized (no session or invalid token) |
| `403` | Forbidden (token scope insufficient, CSRF invalid) |
| `404` | Resource not found |
| `429` | Rate limit exceeded (check `Retry-After` header) |
| `500` | Internal server error |

---

## Quick Start Examples

### Create a peer via API token

```bash
# Create token in Settings > API Tokens, then:
TOKEN="gc_your_token_here"

# Create peer
curl -X POST https://gate.example.com/api/v1/peers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "auto-peer", "description": "Created via API"}'

# List peers
curl -H "Authorization: Bearer $TOKEN" \
  https://gate.example.com/api/v1/peers
```

### Toggle a peer on/off (Home Automation)

```bash
# Enable/disable peer (toggle)
curl -X PUT https://gate.example.com/api/v1/peers/1/toggle \
  -H "Authorization: Bearer $TOKEN"
```

### Download backup via script

```bash
# Token needs 'backup' scope
curl -H "Authorization: Bearer $TOKEN" \
  -o backup-$(date +%Y%m%d).json \
  https://gate.example.com/api/v1/settings/backup
```

### Monitor system resources

```bash
# Token needs 'system' scope
curl -H "Authorization: Bearer $TOKEN" \
  https://gate.example.com/api/v1/system/resources
```
