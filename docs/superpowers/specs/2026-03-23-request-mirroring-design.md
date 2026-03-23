# Request Mirroring — Design Spec

**Date:** 2026-03-23
**Feature:** #20 from improvement list (Phase 5)
**Scope:** HTTP routes only (not L4)

## Overview

Request Mirroring duplicates every incoming request to one or more secondary backends ("mirror targets") without affecting the client. The client always receives the response from the primary backend. Mirror targets receive an exact copy of the request (method, URI, headers, body) asynchronously. Errors or timeouts at mirror targets are logged but never impact the client.

## Architecture

```
Client → Caddy → [mirror handler] ──goroutine──→ Mirror Target 1
                        │           ──goroutine──→ Mirror Target 2
                        ↓
                  [reverse_proxy] → Primary Backend → Response to Client
```

Mirroring is implemented as a **custom Caddy HTTP handler module** (`http.handlers.mirror`). GateControl already builds a custom Caddy binary with xcaddy (caddy-l4, caddy-ratelimit), so adding one more module is incremental.

## Components

### 1. Caddy Go Module — `caddy-mirror`

**Files:** `caddy-plugins/mirror/mirror.go` (~70-80 lines), `caddy-plugins/mirror/go.mod`

**Registration:** `http.handlers.mirror`

**JSON Config:**
```json
{
  "handler": "mirror",
  "targets": [
    { "dial": "10.8.0.3:8080" },
    { "dial": "10.8.0.5:9090" }
  ]
}
```

**Behavior:**
- Buffers the request body (max 10 MB, configurable). Requests with bodies exceeding the limit are mirrored without the body (headers/method/URI only).
- For each target, spawns a goroutine that:
  - Creates an `http.Request` copy (method, URI path + query, headers, buffered body)
  - Sends the request via `http.Client` with 10s timeout
  - Discards the response body and closes it
  - Logs errors at WARN level via Caddy's logger
- Immediately calls `next.ServeHTTP(w, r)` — no waiting on goroutines
- Uses `sync.Pool` for body buffers to reduce GC pressure

**Edge cases:**
- Mirror target unreachable → logged, ignored
- Mirror target slow (>10s) → context cancelled, logged, ignored
- Request body >10 MB → mirrored without body, logged at INFO
- WebSocket upgrades → not mirrored (detected via `Connection: Upgrade` header)

### 2. Database — Migration 26

Two new columns on `routes` table:

```sql
ALTER TABLE routes ADD COLUMN mirror_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN mirror_targets TEXT;
```

`mirror_targets` stores a JSON array: `[{"ip": "10.8.0.3", "port": 8080}, {"ip": "10.8.0.5", "port": 9090}]`

Same pattern as `backends` (JSON text column).

### 3. Caddy Config Generation — `src/services/routes.js`

In `buildCaddyConfig()`, when `route.mirror_enabled === 1` and `mirror_targets` is non-empty:

Insert the mirror handler into the handler chain **before** compress and reverse_proxy.

**Important:** `buildCaddyConfig()` has two separate handler chain constructions — the standard `routeHandlers` array and the `authHandlers` array (for routes using forward_auth / IP filtering). The mirror handler must be injected into **both** code paths at the same relative position.

```
Handler order (both code paths):
1. Request Headers (if custom_headers.request)
2. Rate Limit (if rate_limit_enabled)
3. Mirror (if mirror_enabled)          ← NEW
4. Encode/Compress (if compress_enabled)
5. Reverse Proxy (primary backend)
```

Mirror before compress ensures targets receive uncompressed requests.

Generated JSON:
```json
{
  "handler": "mirror",
  "targets": [
    { "dial": "10.8.0.3:8080" },
    { "dial": "10.8.0.5:9090" }
  ]
}
```

### 4. API — Route CRUD

**POST/PUT `/api/v1/routes`** accepts:
- `mirror_enabled` (boolean) — toggle
- `mirror_targets` (array of `{ip, port}`) — target list

**Validation:**
- Each target requires a valid IP address and port (1-65535)
- Maximum 5 mirror targets per route
- Mirror only available for HTTP routes (`route_type !== 'l4'`)
- Mirror targets array must be non-empty when `mirror_enabled` is true
- No mirror target may match the primary upstream (same IP:port) to prevent accidental double-delivery

**Rollback:** The existing rollback logic in `update()` does not cover newer columns (compress, rate_limit, retry, backends, sticky, circuit_breaker). This is a pre-existing limitation. `mirror_enabled` and `mirror_targets` are included in the same snapshot-based rollback as all other route columns — if refactored in the future, mirror columns will benefit automatically.

**Activity logging:** Enabling/disabling mirroring and changing mirror targets logs a `route_mirror_changed` event to the activity log for audit trail consistency.

**GET `/api/v1/routes`** returns `mirror_enabled` and `mirror_targets` in route objects.

### 5. UI — Route Edit Modal

New toggle block in the route edit modal, following the existing pattern (same as Rate Limit, Retry, Circuit Breaker toggles):

**Toggle row:**
- Label: "Request Mirroring" / description: "Duplicate requests to secondary backends for testing"
- Toggle switch

**Target editor (when enabled):**
- List of mirror targets, each row: IP input + Port input + Delete button
- "Add Target" button (disabled when 5 targets reached)
- Same visual pattern as the Backends editor

**Route card badge:**
- `Mirror: N targets` — blue tag, shown when mirror_enabled

### 6. i18n Keys

New keys in `en.json` and `de.json`:

```
routes.mirror            → "Request Mirroring" / "Request Mirroring"
routes.mirror_desc       → "Duplicate requests to secondary backends for testing" / "Requests an sekundäre Backends duplizieren zum Testen"
routes.mirror_target_ip  → "Target IP" / "Ziel-IP"
routes.mirror_target_port → "Target Port" / "Ziel-Port"
routes.mirror_add_target → "Add Target" / "Ziel hinzufügen"
routes.mirror_badge      → "Mirror: {{count}} targets" / "Mirror: {{count}} Ziele"
routes.mirror_max        → "Maximum 5 mirror targets" / "Maximal 5 Mirror-Ziele"
```

### 7. Backup Compatibility

`mirror_enabled` and `mirror_targets` are regular route columns. The existing backup export/import includes all route columns automatically. No backup version bump needed.

### 8. Dockerfile Change

In the xcaddy build stage, add the mirror module:

Add to the existing `xcaddy build` command (which already includes `github.com/mholt/caddy-l4` and `github.com/mholt/caddy-ratelimit`):

```dockerfile
--with github.com/custom/caddy-mirror=./caddy-plugins/mirror
```

The exact plugin paths must match the existing Dockerfile — do not replace the existing `--with` lines.

### 9. Testing

- **Go module:** Unit test for mirror handler — mock HTTP server as target, verify requests are received
- **API test:** Add mirror target CRUD to `scripts/api-test.sh`
- **Integration:** Create route with mirror enabled, send request, verify primary response and mirror target receives copy

## Not in Scope

- Mirror for L4 (TCP/UDP) routes — HTTP only
- Response comparison (comparing primary vs mirror responses)
- Conditional mirroring (mirror only certain methods or paths)
- Mirror traffic percentage (that's Canary Deployments, #21)

## Files Changed

| File | Change |
|------|--------|
| `caddy-plugins/mirror/mirror.go` | NEW — Custom Caddy module |
| `caddy-plugins/mirror/mirror_test.go` | NEW — Go unit tests |
| `caddy-plugins/mirror/go.mod` | NEW — Go module definition |
| `Dockerfile` | Add mirror module to xcaddy build |
| `src/db/migrations.js` | Migration 26: mirror columns |
| `src/services/routes.js` | Mirror handler in buildCaddyConfig() |
| `src/routes/api/routes.js` | Accept mirror fields in CRUD |
| `public/js/routes.js` | Mirror toggle + target editor in modal |
| `templates/default/pages/routes.njk` | Mirror UI section in edit modal |
| `src/i18n/en.json` | Mirror translation keys |
| `src/i18n/de.json` | Mirror translation keys |
| `scripts/api-test.sh` | Mirror API tests |
