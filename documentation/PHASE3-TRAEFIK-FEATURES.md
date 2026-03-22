# Phase 3 — Traefik-Inspired Features

Advanced reverse proxy features inspired by Traefik, but configured through GateControl's web UI instead of YAML/Labels.

All features apply to **HTTP routes only** (not L4 TCP/UDP routes).

---

## Gzip/Zstd Compression

Enable response compression per route via Caddy's built-in `encode` handler.

### Configuration

Toggle "Compression" in the route's General settings (create form or edit modal).

When enabled, Caddy compresses responses using Zstd (preferred) or Gzip based on the client's `Accept-Encoding` header.

### Caddy Config Generated

```json
{
  "handler": "encode",
  "encodings": { "zstd": {}, "gzip": {} }
}
```

The encode handler is inserted **before** the reverse_proxy handler in the handler chain.

### When to Use

- Static content (HTML, CSS, JS) — significant size reduction
- API responses with large JSON payloads
- **Not recommended** for already-compressed content (images, video, archives)

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{"compress_enabled": true}'
```

---

## Custom Request/Response Headers

Add, modify, or remove HTTP headers per route. Supports both request headers (sent to backend) and response headers (sent to client).

### Configuration

In the route edit modal, switch to the **Headers** tab:

- **Request Headers** — Headers added to the request before forwarding to the backend
- **Response Headers** — Headers added to the response before sending to the client
- **Presets** — Quick-add common header sets:
  - **CORS Headers**: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`
  - **Security Headers**: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`

### Data Format

```json
{
  "request": [
    {"name": "X-Forwarded-Proto", "value": "https"},
    {"name": "X-Custom-Header", "value": "my-value"}
  ],
  "response": [
    {"name": "X-Frame-Options", "value": "DENY"},
    {"name": "Strict-Transport-Security", "value": "max-age=31536000"}
  ]
}
```

### Caddy Config Generated

Request headers use a `headers` handler before the proxy:
```json
{"handler": "headers", "request": {"set": {"X-Custom": ["value"]}}}
```

Response headers are added to the `reverse_proxy` handler:
```json
{"handler": "reverse_proxy", "headers": {"response": {"set": {"X-Frame-Options": ["DENY"]}}}}
```

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{
    "custom_headers": {
      "request": [{"name":"X-Api-Key","value":"secret"}],
      "response": [{"name":"X-Frame-Options","value":"SAMEORIGIN"}]
    }
  }'
```

---

## Per-Route Rate Limiting

Individual rate limits per route, enforced at the Caddy level via the `caddy-ratelimit` plugin.

### Configuration

Enable "Rate Limiting" in the route's Security settings:

| Setting | Options | Default |
|---------|---------|---------|
| Requests | Any positive integer | 100 |
| Window | 1 second / 1 minute / 5 minutes / 1 hour | 1 minute |

Rate limiting is keyed by client IP (`{http.request.remote.host}`).

### Caddy Config Generated

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

### Note on Caddy Build

The `caddy-ratelimit` plugin is included in the custom Caddy build (Dockerfile):
```dockerfile
RUN xcaddy build \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit
```

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{
    "rate_limit_enabled": true,
    "rate_limit_requests": 50,
    "rate_limit_window": "5m"
  }'
```

---

## Retry with Backoff

Automatically retry failed requests to the backend. Useful for transient errors like temporary backend unavailability.

### Configuration

Enable "Retry" in the route's Security settings:

| Setting | Description | Default |
|---------|-------------|---------|
| Retry Count | Number of retry attempts | 3 |
| Match Status | HTTP status codes that trigger retry | 502, 503, 504 |

### How It Works

1. Client request reaches Caddy
2. Caddy forwards to backend
3. If backend returns a matching status code (e.g., 502), Caddy retries
4. After all retries exhausted, the last error response is returned to the client

### Caddy Config Generated

```json
{
  "handler": "reverse_proxy",
  "upstreams": [{"dial": "10.8.0.2:8080"}],
  "retry_match": [{"status_code": [502, 503, 504]}],
  "retries": 3
}
```

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{
    "retry_enabled": true,
    "retry_count": 3,
    "retry_match_status": "502,503,504"
  }'
```

---

## Multiple Backends / Load Balancing

Distribute traffic across multiple backend servers with weighted round-robin load balancing.

### Configuration

Enable "Multiple Backends" in the route's General settings. This replaces the single target IP/port with a dynamic backend list.

Each backend entry has:
- **IP** — Backend server IP address
- **Port** — Backend server port
- **Weight** — Relative weight for traffic distribution (default: 1)

### Load Balancing Policies

| Scenario | Policy |
|----------|--------|
| All weights equal | `round_robin` |
| Different weights | `weighted_round_robin` |
| Sticky sessions enabled | `cookie` (overrides above) |

### Example

| Backend | IP | Port | Weight | Traffic Share |
|---------|-----|------|--------|--------------|
| Server A | 10.8.0.2 | 8080 | 3 | 75% |
| Server B | 10.8.0.3 | 8080 | 1 | 25% |

### Caddy Config Generated

```json
{
  "handler": "reverse_proxy",
  "upstreams": [
    {"dial": "10.8.0.2:8080"},
    {"dial": "10.8.0.3:8080"}
  ],
  "load_balancing": {
    "selection_policy": [{
      "policy": "weighted_round_robin",
      "weights": [3, 1]
    }]
  }
}
```

### Combining with Other Features

- **Retry** — retries cycle through all backends
- **Health checks** — combine with Uptime Monitoring for health-aware routing
- **Sticky sessions** — see below

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{
    "backends": [
      {"ip":"10.8.0.2","port":8080,"weight":3},
      {"ip":"10.8.0.3","port":8080,"weight":1}
    ]
  }'
```

---

## Sticky Sessions

Route the same client to the same backend server using a session cookie. Only available when multiple backends are configured.

### Configuration

Enable "Sticky Sessions" when multiple backends are active:

| Setting | Description | Default |
|---------|-------------|---------|
| Cookie Name | Name of the affinity cookie | `gc_sticky` |
| Cookie TTL | How long the cookie persists | 1 hour |

TTL options: 1 hour, 4 hours, 24 hours, 7 days.

### How It Works

1. First request: Caddy picks a backend via round-robin and sets a cookie
2. Subsequent requests: Caddy reads the cookie and routes to the same backend
3. If the cookie expires or the backend is down, a new backend is selected

### Caddy Config Generated

When sticky sessions are enabled, the load balancing policy changes to `cookie`:

```json
{
  "handler": "reverse_proxy",
  "upstreams": [
    {"dial": "10.8.0.2:8080"},
    {"dial": "10.8.0.3:8080"}
  ],
  "load_balancing": {
    "selection_policy": [{
      "policy": "cookie",
      "name": "gc_sticky",
      "max_age": "3600s"
    }]
  }
}
```

### When to Use

- Applications that store session state in memory (not in a shared database)
- WebSocket connections that must stay on the same server
- Applications with server-side caching that benefits from request locality

### API

```bash
curl -X PUT .../api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -d '{
    "backends": [
      {"ip":"10.8.0.2","port":8080,"weight":1},
      {"ip":"10.8.0.3","port":8080,"weight":1}
    ],
    "sticky_enabled": true,
    "sticky_cookie_name": "gc_sticky",
    "sticky_cookie_ttl": "3600"
  }'
```

---

## Feature Comparison: GateControl vs Traefik

| Feature | Traefik | GateControl |
|---------|---------|-------------|
| Compression | Static YAML label | Toggle in UI, per route |
| Custom Headers | `traefik.http.middlewares...` labels | Key-value editor with presets |
| Rate Limiting | Static YAML config | Slider in UI, per route |
| Retry | Static middleware definition | Toggle + config in UI |
| Load Balancing | Service definition in YAML | Dynamic backend list in UI |
| Sticky Sessions | Static label config | Toggle with cookie settings in UI |
| **Configuration change** | Redeploy / edit files | Click in browser, instant |
