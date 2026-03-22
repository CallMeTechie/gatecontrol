# Phase 4 — Observability & Advanced Features

---

## Prometheus Metrics Export

GateControl exposes metrics at `/metrics` in Prometheus text exposition format for scraping by Prometheus, Grafana, or other monitoring tools.

### Setup

1. Enable in **Settings > Prometheus Metrics**
2. Configure Prometheus scrape target:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'gatecontrol'
    scrape_interval: 30s
    static_configs:
      - targets: ['gate.example.com']
    metrics_path: /metrics
    params:
      token: ['gc_your_token_here']
    scheme: https
```

### Authentication

The `/metrics` endpoint supports multiple auth methods:
- `Authorization: Bearer gc_xxx` header
- `X-API-Token: gc_xxx` header
- `?token=gc_xxx` query parameter (convenient for Prometheus)

Required scope: `system`, `read-only`, or `full-access`.

### Available Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `gatecontrol_peers_total` | gauge | — | Total number of peers |
| `gatecontrol_peers_online` | gauge | — | Currently online peers |
| `gatecontrol_peers_enabled` | gauge | — | Enabled peers |
| `gatecontrol_routes_total` | gauge | — | Total number of routes |
| `gatecontrol_routes_active` | gauge | — | Enabled routes |
| `gatecontrol_cpu_usage_percent` | gauge | — | CPU usage percentage |
| `gatecontrol_memory_usage_percent` | gauge | — | Memory usage percentage |
| `gatecontrol_uptime_seconds` | gauge | — | Application uptime |
| `gatecontrol_peer_status` | gauge | name, ip | Per-peer: 1=online, 0=offline |
| `gatecontrol_peer_transfer_rx_bytes` | gauge | name | Per-peer: received bytes |
| `gatecontrol_peer_transfer_tx_bytes` | gauge | name | Per-peer: transmitted bytes |
| `gatecontrol_route_monitoring_status` | gauge | domain | Per-route: 1=up, 0=down |

### Example Response

```
# HELP gatecontrol_peers_total Total number of WireGuard peers
# TYPE gatecontrol_peers_total gauge
gatecontrol_peers_total 5

# HELP gatecontrol_peer_status Peer online status
# TYPE gatecontrol_peer_status gauge
gatecontrol_peer_status{name="alice-laptop",ip="10.8.0.2"} 1
gatecontrol_peer_status{name="bob-phone",ip="10.8.0.3"} 0
```

### Grafana Dashboard

Use the Prometheus data source to build dashboards with:
- Peer online/offline status (stat panel)
- Traffic per peer over time (graph panel)
- CPU/RAM gauges
- Route monitoring status table

---

## Circuit Breaker

Protects your system when a backend is persistently failing. Instead of waiting for timeouts on every request, the circuit breaker detects failure patterns and returns 503 immediately.

### State Machine

```
  [CLOSED] ──── threshold failures ────→ [OPEN] ──── timeout elapsed ────→ [HALF-OPEN]
  (normal)                                (503)                              (testing)
     ↑                                                                         │
     │                          success ←──────────────────────────────────────┘
     └──────────────────────────────────────── failure → [OPEN]
```

### Configuration

Per-route in the Security tab (requires monitoring to be enabled):

| Setting | Default | Description |
|---------|---------|-------------|
| Threshold | 5 | Consecutive failures before opening |
| Timeout | 30s | Seconds before testing again (half-open) |

### How It Works

1. **CLOSED** (normal): Requests proxy normally. The monitoring service checks backend health periodically. Consecutive failures are counted.

2. **OPEN** (blocking): After reaching the threshold, GateControl replaces the Caddy route config with a `static_response` returning 503 with a `Retry-After` header. No requests reach the backend.

3. **HALF-OPEN** (testing): After the timeout, Caddy config is restored to normal. The next monitoring check determines the outcome:
   - Success → CLOSED (normal operation resumes)
   - Failure → OPEN (another timeout cycle)

### Caddy Config When Open

```json
{
  "handle": [{
    "handler": "static_response",
    "status_code": "503",
    "body": "Service temporarily unavailable",
    "headers": {"Retry-After": ["30"]}
  }]
}
```

### Route List Badges

- **CB: Closed** (green) — normal operation
- **CB: Open** (red) — backend down, returning 503
- **CB: Half-Open** (yellow) — testing recovery

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{
    "circuit_breaker_enabled": true,
    "circuit_breaker_threshold": 5,
    "circuit_breaker_timeout": 30
  }'
```

---

## Batch Operations

Select multiple peers or routes and perform bulk actions (enable, disable, delete) on them at once.

### Usage

1. Click **"Select"** button in the Peers or Routes header
2. Checkboxes appear next to each item
3. Select items (or use "Select All")
4. A floating action bar appears at the bottom with:
   - **Enable (N)** — enable all selected
   - **Disable (N)** — disable all selected
   - **Delete (N)** — delete all selected (with confirmation)
   - **Cancel** — exit batch mode

### API

```bash
# Batch disable peers
curl -X POST .../api/v1/peers/batch \
  -H "Authorization: Bearer gc_..." \
  -d '{"action": "disable", "ids": [1, 2, 3]}'
# Response: {"ok": true, "affected": 3}

# Batch delete routes
curl -X POST .../api/v1/routes/batch \
  -H "Authorization: Bearer gc_..." \
  -d '{"action": "delete", "ids": [5, 6]}'
```

### Actions

| Action | Peers | Routes |
|--------|-------|--------|
| `enable` | Set enabled=1, sync WireGuard | Set enabled=1, sync Caddy |
| `disable` | Set enabled=0, sync WireGuard | Set enabled=0, sync Caddy |
| `delete` | Delete peer, unlink routes, sync WireGuard | Delete route + ACL rules, sync Caddy |

---

## Peer Groups

Organize peers into groups for easier management. Groups can represent teams, locations, device types, or any other category.

### Creating Groups

Navigate to **Peers** page → **Peer Groups** card at the bottom:
- Enter group name, pick a color, add optional description
- Click "Add" to create

### Assigning Peers to Groups

- In the **Add Peer** or **Edit Peer** modal, select a group from the dropdown
- A colored badge (dot + group name) appears next to the peer in the list

### Filtering by Group

Use the **Group filter dropdown** above the peer list:
- **All** — show all peers
- **[Group Name]** — show only peers in that group
- **Ungrouped** — show peers without a group

### Group Management

In the Peer Groups card:
- Edit group name, color, description inline
- Delete a group (peers are unassigned, not deleted)
- Peer count shown per group

### API

```bash
# List groups
curl .../api/v1/peer-groups

# Create group
curl -X POST .../api/v1/peer-groups \
  -d '{"name": "Office", "color": "#3b82f6", "description": "Office devices"}'

# Assign peer to group
curl -X PUT .../api/v1/peers/1 \
  -d '{"group_id": 1}'

# Filter peers by group (client-side filtering in UI)
```

### Backup/Restore

Peer groups are included in backups (version 3). On restore, groups are created first, then peers are assigned by group name for portability across instances.

### Sidebar Badge

When groups exist, the peer count in the sidebar shows the total including group information.
