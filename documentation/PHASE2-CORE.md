# Phase 2 — Core Improvements

Features with the highest direct user impact.

---

## Peer Expiry

Automatically disable peers after a configurable time period. Ideal for temporary guest access, contractor VPN, or demo environments.

### Configuration

When creating or editing a peer, select an expiration:

| Option | Duration |
|--------|----------|
| Never | No expiry (default) |
| 1 day | 24 hours from now |
| 7 days | 1 week from now |
| 30 days | 1 month from now |
| 90 days | 3 months from now |
| Custom date | Any future date |

### Background Task

A check runs every 60 seconds:
1. Finds peers where `expires_at < NOW()` and `enabled = 1`
2. Disables the peer and syncs WireGuard config
3. Logs a `peer_expired` activity event
4. Sends email alert (if configured for peer events)

### Visual Indicators

- 🔴 **Expired** — red tag, peer is disabled
- 🟡 **Expires soon** — orange tag, within 7 days
- ⚪ **Expires on [date]** — grey tag for future dates

### API

```bash
# Create with 30-day expiry
curl -X POST .../api/v1/peers \
  -H "Authorization: Bearer gc_..." \
  -d '{"name":"guest", "expires_at":"2026-04-21T00:00:00Z"}'

# Remove expiry
curl -X PUT .../api/v1/peers/5 \
  -d '{"expires_at": null}'
```

---

## Peer Access Control (ACL)

Restrict which WireGuard peers can access specific routes via Caddy's `remote_ip` matcher.

### How It Works

1. Enable "Peer Access Control" on a route
2. Select allowed peers from the checklist
3. Caddy only allows requests from selected peer IPs

### Example

```
Alice (10.8.0.2) → nas.example.com → ✅ Allowed
Bob   (10.8.0.3) → nas.example.com → ✅ Allowed
Guest (10.8.0.4) → nas.example.com → ❌ 403 Forbidden
```

### Caddy Config Generated

```json
{
  "match": [{
    "host": ["nas.example.com"],
    "remote_ip": {"ranges": ["10.8.0.2/32", "10.8.0.3/32"]}
  }]
}
```

### Important

- ACL off = all peers can access (default)
- ACL on + no peers selected = all traffic blocked (warning in UI)
- Only affects VPN tunnel traffic (Caddy checks WireGuard IPs)
- ACL rules included in backup/restore (peers referenced by name)

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{"acl_enabled": true, "acl_peers": [3, 4, 5]}'
```

---

## Automatic Backups

Scheduled automatic backups with retention management.

### Settings (Settings > Automatic Backups)

| Setting | Options | Default |
|---------|---------|---------|
| Enable | On/Off | Off |
| Schedule | 6h / 12h / Daily / 3 days / Weekly | Daily |
| Retention | Number of backups to keep | 5 |

### Features

- Files saved to `/data/backups/gatecontrol-YYYYMMDD-HHmmss.json`
- Oldest files deleted when retention limit exceeded
- "Run Now" button for immediate backup
- Download/delete individual backup files in Settings
- Email alert on backup failure

### API

```bash
# Get settings
curl .../api/v1/settings/autobackup

# Enable daily, keep 10
curl -X PUT .../api/v1/settings/autobackup \
  -d '{"enabled": true, "schedule": "daily", "retention": 10}'

# Trigger now
curl -X POST .../api/v1/settings/autobackup/run

# List files
curl .../api/v1/settings/autobackup/list

# Download
curl -o backup.json .../api/v1/settings/autobackup/download/gatecontrol-20260322-120000.json
```

---

## Log Export

Export activity and access logs as CSV or JSON files.

### Usage

Export buttons on the **Logs** page for both Activity and Access tabs.

### Formats

**Activity CSV:** `timestamp,event,severity,message,details`

**Access CSV:** `timestamp,domain,method,path,status,remote_ip,user_agent`

**JSON:** Pretty-printed array with same fields.

### Filenames

- `gatecontrol-activity-YYYYMMDD.csv` / `.json`
- `gatecontrol-access-YYYYMMDD.csv` / `.json`

### API

```bash
# Activity as CSV
curl -o activity.csv ".../api/v1/logs/activity/export?format=csv"

# Access as JSON, filtered by domain
curl -o access.json ".../api/v1/logs/access/export?format=json&domain=app.example.com"
```

Token scope: `logs`
