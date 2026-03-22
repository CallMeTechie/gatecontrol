# Phase 1 — Foundation

Features that enable future development and external integrations.

---

## API Tokens

Stateless token authentication for automation, CI/CD pipelines, scripts, and external integrations.

### Token Management

Navigate to **Settings > API Tokens** to create, list, and revoke tokens.

- Token format: `gc_` prefix + 48 random hex bytes (e.g., `gc_a1b2c3d4...`)
- Only the SHA-256 hash is stored in the database — the raw token is shown **once** on creation
- Tokens cannot create or delete other tokens (prevents privilege escalation)

### Authentication

```bash
# Authorization header
curl -H "Authorization: Bearer gc_your_token" https://gate.example.com/api/v1/peers

# X-API-Token header
curl -H "X-API-Token: gc_your_token" https://gate.example.com/api/v1/peers
```

Token-authenticated requests bypass CSRF protection (stateless, no session needed).

### Scopes

| Scope | Access |
|-------|--------|
| `full-access` | All endpoints (read + write) |
| `read-only` | GET requests on all endpoints |
| `peers` | Peer endpoints |
| `routes` | Route endpoints |
| `settings` | Settings + SMTP |
| `webhooks` | Webhook endpoints |
| `logs` | Log endpoints + export |
| `system` | System, WireGuard, Caddy |
| `backup` | Backup/restore |

### Rate Limiting

- Authenticated requests (session or token): 1000 requests / 15 min
- Unauthenticated requests: 100 requests / 15 min
- Rate limiting keyed by token ID for token-auth, IP for others

---

## Migration History Table

Versioned database migration system that tracks which migrations have been applied.

### How It Works

- Each migration has a version number, name, and SQL
- On startup, the system checks `migration_history` for what's already applied
- Only new migrations are executed, in a single transaction
- Legacy databases (pre-migration-history) are auto-detected — existing schema is scanned and migrations marked as "already applied"

### Migration History Table Schema

```sql
CREATE TABLE migration_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checksum TEXT
);
```

### Current Migrations

| Version | Name | Description |
|---------|------|-------------|
| 1-14 | Core schema | Original tables (users, peers, routes, settings, etc.) |
| 15 | api_tokens | API token storage |
| 16 | peers_expires_at | Peer expiry date |
| 17 | route_peer_acl | Peer access control per route |
| 18 | compress_enabled | Route compression toggle |
| 19 | custom_headers | Route custom headers (JSON) |
| 20 | rate_limit_columns | Per-route rate limiting |
| 21 | retry_columns | Retry with backoff |
| 22 | backends_column | Multiple backends |
| 23 | sticky_session_columns | Sticky sessions |

---

## Mobile Sidebar

Responsive navigation sidebar for mobile and tablet devices.

### Behavior

| Screen Size | Sidebar |
|-------------|---------|
| Desktop (≥ 1024px) | Always visible, unchanged |
| Mobile/Tablet (< 1024px) | Hidden, hamburger button in topbar |

### Interactions

- Tap hamburger → sidebar slides in from left
- Tap overlay / nav item / Escape → sidebar closes
- Resize to desktop → sidebar auto-shows

### Accessibility

- `role="switch"`, `aria-expanded`, `aria-label` on hamburger button
- Focus trap when sidebar is open
- 44px minimum touch targets
- Keyboard navigation (Space/Enter to toggle)
