# GateControl — Feature Documentation

Detailed documentation for recently added features. For the complete feature overview, see [README.md](README.md).

---

## Table of Contents

- [Peer Expiry](#peer-expiry)
- [Peer Access Control (ACL)](#peer-access-control-acl)
- [Automatic Backups](#automatic-backups)
- [Log Export](#log-export)
- [API Tokens](#api-tokens)
- [Mobile Sidebar](#mobile-sidebar)

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
   - 🔴 **Expired** — red tag, peer is disabled
   - 🟡 **Expires soon** — orange tag, expires within 7 days
   - ⚪ **Expires on [date]** — grey tag for future dates

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
Alice (10.8.0.2) → nas.example.com → ✅ Allowed
Bob   (10.8.0.3) → nas.example.com → ✅ Allowed
Guest (10.8.0.4) → nas.example.com → ❌ 403 Forbidden
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

### Security

- Only the SHA-256 hash is stored in the database — the raw token cannot be retrieved after creation
- Tokens use the `gc_` prefix (48 random bytes, hex-encoded) for easy identification
- Token-authenticated requests bypass CSRF (stateless, no session)
- Tokens **cannot create or delete other tokens** (prevents privilege escalation)
- Each token has its own rate limit counter (1000 requests / 15 min)

---

## Mobile Sidebar

Responsive sidebar for phones and tablets. The navigation sidebar collapses into a hamburger menu on screens smaller than 1024px.

### Behavior

| Screen | Sidebar |
|--------|---------|
| Desktop (≥ 1024px) | Always visible, no changes |
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
