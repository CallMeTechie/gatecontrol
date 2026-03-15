# Layer 4 Routing for GateControl

## Overview

Add Layer 4 (TCP/UDP) proxy support to GateControl using the [caddy-l4](https://github.com/mholt/caddy-l4) plugin. This enables raw TCP/UDP forwarding for protocols like RDP, SSH, databases, and game servers — routing traffic to WireGuard peers or arbitrary IPs without requiring both endpoints to be inside the VPN.

## Use Case

A Windows VM connected as a WireGuard peer (e.g., `10.8.0.5`) can be reached via `rdp.domaincaster.com:3389` from anywhere — without requiring the client to be inside the WireGuard network.

## Requirements

| Decision | Result |
|---|---|
| Docker networking | `network_mode: host` — dynamic port binding without container restart |
| Protocols | TCP + UDP + TLS-SNI routing |
| UI | Integrated into existing route page with dynamic form fields |
| TLS modes | Configurable per route: None / Passthrough / Terminate |
| Peer binding | Yes — same peer dropdown as HTTP routes |
| Port ranges | Yes — single ports (`3389`) and ranges (`5000-5010`) |
| Port security | Blocklist for reserved ports |
| Architecture | Separate `apps.layer4` section in Caddy JSON config, parallel to `apps.http` |

---

## 1. Database Schema

### New columns on `routes` table

```sql
ALTER TABLE routes ADD COLUMN route_type TEXT NOT NULL DEFAULT 'http';
ALTER TABLE routes ADD COLUMN l4_protocol TEXT;
ALTER TABLE routes ADD COLUMN l4_listen_port TEXT;
ALTER TABLE routes ADD COLUMN l4_tls_mode TEXT;
CREATE INDEX idx_routes_route_type ON routes(route_type);
```

### Domain column constraint change

The existing `domain` column is `TEXT NOT NULL UNIQUE`. L4 routes with `tls_mode = 'none'` may have no domain. The migration must relax this constraint:

```sql
-- SQLite does not support ALTER COLUMN, so we recreate the table:
-- 1. Create new table with domain allowing NULL
-- 2. Copy data from old table
-- 3. Drop old table, rename new
-- 4. Replace UNIQUE constraint with partial unique index:
CREATE UNIQUE INDEX idx_routes_domain_unique
  ON routes(domain) WHERE domain IS NOT NULL AND domain != '';
```

The `create()` and `update()` functions in `routes.js` must skip domain validation and duplicate-domain checks when `route_type = 'l4'` and `domain` is null/empty.

### Field semantics

| Column | Values | Description |
|---|---|---|
| `route_type` | `'http'` \| `'l4'` | Determines which config section is generated |
| `l4_protocol` | `'tcp'` \| `'udp'` \| `null` | Transport protocol (only when `route_type='l4'`) |
| `l4_listen_port` | `'3389'` \| `'5000-5010'` \| `null` | External port or port range Caddy listens on |
| `l4_tls_mode` | `'none'` \| `'passthrough'` \| `'terminate'` \| `null` | TLS handling mode |

### Existing fields reused for L4

- `domain` — Used for TLS-SNI matching (required when `tls_mode != 'none'`, optional otherwise)
- `target_ip` / `target_port` — Backend destination
- `peer_id` — Optional WireGuard peer binding (IP derived from peer's `allowed_ips`)
- `enabled` — Toggle route on/off
- `description` — User description

### Backward compatibility

Existing routes get `route_type = 'http'` by default. All L4 fields default to `null`. No data loss, no behavioral change for existing routes.

---

## 2. Caddy Config Generation

### Architecture

`buildCaddyConfig()` generates both sections in one pass:

```javascript
{
  apps: {
    http:   { /* existing HTTP routes — unchanged */ },
    layer4: { /* NEW: L4 routes */ },
    tls:    { /* existing TLS config */ }
  }
}
```

### L4 server grouping

L4 routes are grouped by `(protocol, listen_port, tls_mode)`. Each group becomes one Caddy L4 server:

| Routes | Server name | Listen |
|---|---|---|
| `tcp/3389/none` | `l4-tcp-3389` | `tcp/:3389` |
| `tcp/8443/passthrough` | `l4-tls-8443` | `tcp/:8443` |
| `udp/27015/none` | `l4-udp-27015` | `udp/:27015` |

Multiple routes with the same `(protocol, port, tls_mode)` share a server and are distinguished by TLS-SNI matchers.

### TLS mode behavior

| TLS Mode | Matcher | Handler chain |
|---|---|---|
| `none` | None (port-based) | `proxy` directly |
| `passthrough` | `tls.sni` on domain | `proxy` (TLS stream forwarded unchanged) |
| `terminate` | `tls.sni` on domain | `tls` (terminate) → `proxy` (plaintext to backend) |

### Generated config example

```json
{
  "apps": {
    "layer4": {
      "servers": {
        "l4-tcp-3389": {
          "listen": ["tcp/:3389"],
          "routes": [
            {
              "handle": [{
                "handler": "proxy",
                "upstreams": [{ "dial": "10.8.0.5:3389" }]
              }]
            }
          ]
        },
        "l4-tls-8443": {
          "listen": ["tcp/:8443"],
          "routes": [
            {
              "match": [{ "tls": { "sni": ["ssh.domain.com"] } }],
              "handle": [{
                "handler": "proxy",
                "upstreams": [{ "dial": "10.8.0.2:22" }]
              }]
            },
            {
              "match": [{ "tls": { "sni": ["db.domain.com"] } }],
              "handle": [{
                "handler": "proxy",
                "upstreams": [{ "dial": "10.8.0.3:5432" }]
              }]
            }
          ]
        }
      }
    }
  }
}
```

### Port range handling

A route with `l4_listen_port = "5000-5010"` generates `listen: ["tcp/:5000-5010"]`. Caddy supports port ranges natively in listen addresses.

### Conflict detection

Before syncing to Caddy, `buildCaddyConfig()` validates:

1. No two `tls_mode=none` routes on the same port+protocol (no SNI to distinguish)
2. Port ranges must not overlap with each other or with single-port routes
3. L4 ports must not conflict with HTTP ports (80/443)

Conflicts cause the sync to fail with a descriptive error returned to the user.

---

## 3. UI Integration

### Route form — dynamic fields

A route type toggle (`HTTP` / `Layer 4`) is added to the create form and edit modal. Fields show/hide based on selection:

| Selection | Visible fields | Hidden fields |
|---|---|---|
| HTTP | Domain, Description, Peer, Target Port, Force HTTPS, Backend HTTPS, Basic Auth | Protocol, Listen Port, TLS Mode |
| Layer 4 | Domain*, Description, Peer, Target Port, Protocol, Listen Port, TLS Mode | Force HTTPS, Backend HTTPS, Basic Auth |

*Domain is optional when `tls_mode = 'none'` (placeholder: "Optional — only for TLS-SNI")

### UX behavior

- **Listen Port default:** Auto-fills from Target Port value (user can override)
- **TLS Terminate hint:** "Caddy will automatically generate a Let's Encrypt certificate"
- **TLS None + no domain hint:** "Port-based routing only, no SNI"
- **Port blocklist error:** "Port X is reserved (used by GateControl/Caddy/WireGuard)"

### Route list tags

L4 routes display protocol and TLS tags alongside existing HTTP tags:

```
rdp.domaincaster.com  → 10.8.0.5:3389     [TCP] [L4]       Active
ssh.domaincaster.com  → 10.8.0.2:22        [TCP] [TLS-SNI]  Active
game.domaincaster.com → 10.8.0.4:27015     [UDP] [L4]       Active
app.domaincaster.com  → 10.8.0.3:8080      [HTTPS] [Auth]   Active
```

---

## 4. Dockerfile Changes

### Custom Caddy build with L4 plugin

```dockerfile
# Stage 1: Caddy with L4 plugin
FROM caddy:2-builder AS caddy-builder
RUN xcaddy build \
    --with github.com/mholt/caddy-l4

# Stage 2: Node.js dependencies (existing)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production --ignore-scripts && npm rebuild argon2 better-sqlite3

# Stage 3: Runtime
FROM node:20-alpine
RUN apk add --no-cache \
    wireguard-tools iptables ip6tables \
    supervisor curl procps openssl
    # 'caddy' removed from apk — using custom binary

COPY --from=caddy-builder /usr/bin/caddy /usr/local/bin/caddy
# ... rest unchanged ...
```

### docker-compose.yml

```yaml
services:
  gatecontrol:
    network_mode: host        # replaces ports section
    # ports: removed entirely
    # sysctls: removed — incompatible with network_mode: host
    #   (entrypoint.sh already sets these via sysctl -w)
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    volumes:
      - gatecontrol-data:/data
    env_file:
      - .env
    restart: unless-stopped
```

**Migration notes:**
- `ports` section removed entirely — `network_mode: host` exposes all bound ports directly
- `sysctls` section removed — Docker does not allow `sysctls` with `network_mode: host`. The `entrypoint.sh` already sets `net.ipv4.ip_forward=1` and `net.ipv4.conf.all.src_valid_mark=1` via `sysctl -w`
- `EXPOSE` directive in Dockerfile removed — purely documentation, meaningless with host networking

Image size impact: ~+10-15MB from Go binary with plugin.

---

## 5. Backend Service & API

### Route service changes (`src/services/routes.js`)

**Extended `buildCaddyConfig()`:**
1. Load all enabled routes (existing)
2. Split by `route_type`: `http[]` and `l4[]`
3. Generate HTTP config (existing logic, unchanged)
4. Group L4 routes by `(protocol, listen_port, tls_mode)`
5. Generate one L4 server per group
6. Run conflict detection
7. Merge both sections into single config object

**New helper functions:**

| Function | Purpose |
|---|---|
| `buildL4Servers(l4Routes)` | Group routes and generate L4 server config |
| `buildL4Route(route)` | Single L4 route → Caddy JSON |
| `validatePortConflicts(l4Routes)` | Overlap, blocklist, duplicate checks |
| `isPortBlocked(port)` | Check against blocklist |
| `parsePortRange(portStr)` | `"5000-5010"` → `{ start: 5000, end: 5010 }` |

**Port blocklist:**

```javascript
const BLOCKED_PORTS = [80, 443, 2019, 3000, 51820];
```

Configurable via `GC_L4_BLOCKED_PORTS` env variable.

### API endpoints

No new endpoints. Existing CRUD endpoints accept additional fields:

| Endpoint | Change |
|---|---|
| `POST /api/routes` | Accepts `route_type`, `l4_protocol`, `l4_listen_port`, `l4_tls_mode` |
| `PUT /api/routes/:id` | Same new fields |
| `GET /api/routes` | Returns L4 fields, filterable via `?type=l4` |
| `GET /api/routes/:id` | Returns L4 fields |

### Validation (`src/utils/validate.js`)

New rules for `route_type = 'l4'`:

- `l4_protocol` must be `'tcp'` or `'udp'`
- `l4_listen_port` must be valid port (1-65535) or range (start-end, start < end, max 100 ports)
- `l4_listen_port` must not be in blocklist
- `l4_tls_mode` must be `'none'`, `'passthrough'`, or `'terminate'`
- `tls_mode != 'none'` requires `domain` AND `l4_protocol = 'tcp'` (DTLS not supported by caddy-l4)
- `domain` optional when `tls_mode = 'none'`
- `isPortBlocked()` applies only to `l4_listen_port`, never to `target_port`
- Domain validation (`validateDomain()`) must be skipped for L4 routes with `tls_mode = 'none'` and no domain

---

## 6. Configuration & i18n

### New environment variables (`config/default.js`)

```javascript
l4: {
  blockedPorts: process.env.GC_L4_BLOCKED_PORTS || '80,443,2019,3000,51820',
  maxPortRange: parseInt(process.env.GC_L4_MAX_PORT_RANGE) || 100,
}
```

### i18n keys (~15-20 new keys in en.json + de.json)

- Route type labels: `routes.type_http`, `routes.type_l4`
- Protocol labels: `routes.l4_protocol`, `routes.l4_protocol_tcp`, `routes.l4_protocol_udp`
- TLS mode labels: `routes.l4_tls_mode`, `routes.tls_none`, `routes.tls_passthrough`, `routes.tls_terminate`
- Form labels: `routes.l4_listen_port`, `routes.l4_listen_port_placeholder`
- Hints: `routes.tls_sni_hint`, `routes.tls_terminate_hint`, `routes.tls_none_hint`
- Errors: `routes.port_blocked`, `routes.port_range_invalid`, `routes.port_conflict`, `routes.tls_requires_domain`, `routes.tls_terminate_requires_tcp`
- Tags: `routes.tag_tcp`, `routes.tag_udp`, `routes.tag_tls_sni`, `routes.tag_l4`

---

## 7. Backup/Restore

The backup service (`src/services/backup.js`) explicitly maps route fields during export and restore. It must be updated to include the new L4 columns:

- **Export:** Add `route_type`, `l4_protocol`, `l4_listen_port`, `l4_tls_mode` to the route field mapping
- **Restore:** Map these fields back when restoring routes
- **BACKUP_VERSION:** Increment to handle backward compatibility (older backups without L4 fields get defaults)

---

## 8. Supervisord & Caddyfile Startup

Caddy currently starts with `caddy run --config /app/config/Caddyfile --adapter caddyfile`. The Caddyfile is a minimal bootstrap config (admin API + base domain). L4 config is loaded at runtime via the Admin API (`POST /load`).

This approach continues to work — the initial Caddyfile contains no L4 directives, and the full JSON config (including `apps.layer4`) is pushed via the Admin API when Node.js starts. The caddy-l4 plugin is compiled into the binary and available for JSON config, even though the bootstrap Caddyfile doesn't reference it.

No changes needed to supervisord.conf or the Caddyfile startup approach.

---

## 9. Testing

Extend existing tests in `tests/`:

- **Validation tests:** L4 port ranges, blocklist, TLS mode combinations, required fields
- **Config generation tests:** `buildCaddyConfig()` with mixed HTTP + L4 routes, correct server grouping, TLS mode handler chains
- **Conflict detection tests:** Duplicate ports, overlapping ranges, blocked ports
- **API tests:** Create/update/get L4 routes, filter by type, validation error responses
