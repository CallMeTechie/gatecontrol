# Phase 5 — Request Mirroring

Duplicate HTTP requests to secondary backends for testing, debugging, or load validation — without affecting the client.

Applies to **HTTP routes only** (not L4 TCP/UDP routes).

---

## Overview

Request Mirroring copies every incoming request to one or more mirror targets asynchronously. The client always receives the response from the primary backend. Mirror targets receive an exact copy of the request (method, URI, headers, body). Errors or timeouts at mirror targets are logged but never impact the client.

```
Client → Caddy → [mirror handler] ──async──→ Mirror Target 1
                        │           ──async──→ Mirror Target 2
                        ↓
                  [reverse_proxy] → Primary Backend → Response to Client
```

### Use Cases

- **Version testing** — Mirror production traffic to a staging instance and check for errors, without affecting real users
- **Debugging** — Send traffic to a logging backend that records all requests
- **Load testing** — Verify a new backend handles real-world traffic volume before switching over
- **Shadow deployments** — Run a new version in parallel to validate correctness

---

## Technical Implementation

Request Mirroring is implemented as a **custom Caddy HTTP handler module** (`http.handlers.mirror`), written in Go and compiled into the Caddy binary via xcaddy.

### How It Works

1. The mirror handler reads and buffers the request body (max 10 MB)
2. For each configured mirror target, a goroutine is spawned that sends a copy of the request (method, URI, headers, body) via HTTP
3. The handler immediately passes the request to the next handler in the chain (reverse_proxy) — no waiting on mirror responses
4. Mirror goroutines run with a 10-second timeout. Errors are logged at WARN level.

### Handler Chain Position

```
1. Request Headers (if configured)
2. Rate Limit (if enabled)
3. Mirror (if enabled)          ← here
4. Encode/Compress (if enabled)
5. Reverse Proxy (primary backend)
```

Mirror is placed before compression so mirror targets receive uncompressed requests.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Mirror target unreachable | Logged at WARN, client unaffected |
| Mirror target slow (>10s) | Request cancelled, logged, client unaffected |
| Request body >10 MB | Mirrored without body (headers/method/URI only), logged at INFO |
| WebSocket upgrade | Not mirrored (detected via `Connection: Upgrade` header) |

### Memory Management

The module uses `sync.Pool` for body buffers to minimize garbage collection pressure under high traffic.

---

## Configuration

### UI

In the route edit modal (create or edit):

1. Toggle **"Request Mirroring"** to enable
2. Click **"Add Target"** to add mirror destinations
3. Enter the **IP address** and **port** for each target
4. Up to **5 mirror targets** per route

Mirror targets are displayed as a blue badge on the route card: `Mirror: 2 targets`

### API

#### Enable mirroring on a route

```bash
curl -X PUT https://your-domain.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "mirror_enabled": true,
    "mirror_targets": [
      {"ip": "10.8.0.3", "port": 8080},
      {"ip": "10.8.0.5", "port": 9090}
    ]
  }'
```

#### Disable mirroring

```bash
curl -X PUT https://your-domain.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "mirror_enabled": false,
    "mirror_targets": null
  }'
```

### Validation Rules

- Each target requires a valid IP address and port (1-65535)
- Maximum **5** mirror targets per route
- Mirror is only available for **HTTP routes** (not L4)
- Mirror targets array must be non-empty when `mirror_enabled` is true
- A mirror target cannot have the same IP:port as the primary backend

---

## Data Model

### Database Columns (Migration 26)

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `mirror_enabled` | INTEGER | 0 | Toggle (0 = off, 1 = on) |
| `mirror_targets` | TEXT | NULL | JSON array of targets |

### Mirror Targets JSON Format

```json
[
  {"ip": "10.8.0.3", "port": 8080},
  {"ip": "10.8.0.5", "port": 9090}
]
```

---

## Caddy Config Generated

When mirroring is enabled, the following handler is inserted into the Caddy JSON config:

```json
{
  "handler": "mirror",
  "targets": [
    {"dial": "10.8.0.3:8080"},
    {"dial": "10.8.0.5:9090"}
  ]
}
```

This handler is inserted in **both** the standard handler chain and the forward-auth handler chain (for routes using route authentication or IP filtering).

---

## Activity Logging

Changes to mirror configuration are logged as `route_mirror_changed` events in the activity log, including the route ID and the new mirror_enabled state.

---

## Backup Compatibility

Mirror settings (`mirror_enabled`, `mirror_targets`) are included in backup export/import automatically as regular route columns. No backup version change required.

---

## Important Notes

- **Write operations (POST, PUT, DELETE)** are mirrored too. If the mirror target processes write requests, it will execute them. Use a read-only or test backend as a mirror target when mirroring write traffic.
- Mirror targets should be reachable from the GateControl container's network. If mirroring to a WireGuard peer, ensure the peer is online.
- The 10 MB body buffer limit and 10-second timeout are hardcoded in the initial implementation. These may become configurable in future versions.
- Mirroring adds minimal latency since requests are dispatched asynchronously via goroutines. The primary response is not delayed.
