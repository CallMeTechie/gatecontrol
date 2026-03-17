# Route Auth System — Design Spec

**Branch:** `feature/route-auth`
**Date:** 2026-03-17
**Status:** Approved

## Overview

Replace the ugly browser Basic Auth dialog with a custom login page for protected routes. Users authenticate via Email & Password, Email & Code (OTP), or TOTP (Authenticator App). Optional 2FA combines Email & Password as first factor with Email Code or TOTP as second factor. Auth method is configured per route by the admin. Basic Auth remains available for backwards compatibility.

## Architecture

**Approach:** Caddy `forward_auth` → GateControl auth endpoints.

Caddy checks a session cookie via `GET /route-auth/verify` on every request to a protected route. If the cookie is missing or invalid, the user is redirected to `/route-auth/login?route=<domain>`. After successful authentication, a session cookie is set and Caddy forwards the request to the target.

```
User → domain.com → Caddy
                      ↓
               forward_auth → GET /route-auth/verify
                      ↓                    ↓
               Cookie valid?          Cookie missing/invalid
                      ↓                    ↓
               → Proxy to target     → 302 Redirect to
                                       /route-auth/login?route=domain.com
```

## Auth Methods

### Single Factor (one of):
- **Email & Password** — Classic login form
- **Email & Code** — Enter email, receive 6-digit code via SMTP
- **TOTP** — Enter 6-digit code from Authenticator app

### Two Factor (2FA enabled):
- **Step 1:** Email & Password (always, mandatory)
- **Step 2:** Email Code OR TOTP (admin chooses which)

Admin selects method and configures credentials when creating/editing a route. For TOTP, admin generates a secret, scans QR code, and confirms with a code before saving.

## Data Model

### New Table: `route_auth`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `route_id` | INTEGER FK UNIQUE | References routes.id, ON DELETE CASCADE |
| `auth_type` | TEXT NOT NULL | `email_password`, `email_code`, `totp` |
| `two_factor_enabled` | INTEGER DEFAULT 0 | 0/1 |
| `two_factor_method` | TEXT | `email_code` or `totp` (only when 2FA active) |
| `email` | TEXT | Login email (required for email_password, email_code, 2FA; optional for TOTP-only) |
| `password_hash` | TEXT | Argon2 hash (for email_password and 2FA) |
| `totp_secret_encrypted` | TEXT | AES-256-GCM encrypted (when TOTP selected) |
| `session_max_age` | INTEGER NOT NULL DEFAULT 86400000 | Session duration in ms |
| `created_at` | TEXT DEFAULT CURRENT_TIMESTAMP | |
| `updated_at` | TEXT DEFAULT CURRENT_TIMESTAMP | |

### New Table: `route_auth_sessions`

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `route_id` | INTEGER FK | References routes.id, ON DELETE CASCADE |
| `email` | TEXT NOT NULL | Authenticated email |
| `ip_address` | TEXT | Client IP |
| `two_factor_pending` | INTEGER DEFAULT 0 | 1 = password verified but 2FA step not yet completed |
| `expires_at` | TEXT NOT NULL | |
| `created_at` | TEXT DEFAULT CURRENT_TIMESTAMP | |

Indexes: `expires_at` for cleanup, `route_id + two_factor_pending` for verify lookups.

**Session cleanup:** Expired sessions are cleaned up on a periodic interval (every 15 minutes) using `setInterval` in the routeAuth service, similar to how the existing session store handles cleanup. Additionally, expired sessions are rejected at verify time.

### New Table: `route_auth_otp`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `route_id` | INTEGER FK | References routes.id, ON DELETE CASCADE |
| `code_hash` | TEXT NOT NULL | SHA-256 hash of 6-digit code |
| `email` | TEXT NOT NULL | Recipient |
| `expires_at` | TEXT NOT NULL | 5 min validity |
| `used` | INTEGER DEFAULT 0 | 0/1 |
| `created_at` | TEXT DEFAULT CURRENT_TIMESTAMP | |

### SMTP Settings

Stored in existing `settings` table (key-value):
- `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password_encrypted`, `smtp_from`, `smtp_secure`

### Existing `routes` table

Unchanged. `basic_auth_enabled`, `basic_auth_user`, `basic_auth_password_hash` remain for backwards compatibility. A route uses either Basic Auth OR Route Auth, not both.

## Caddy Integration

### Forward Auth Config Generation

Caddy's JSON API has no native `forward_auth` handler — it compiles to a `reverse_proxy` with `handle_response` blocks. Routes with Route Auth get a `reverse_proxy` subrequest handler instead of `http_basic`:

```json
{
  "handler": "reverse_proxy",
  "upstreams": [{ "dial": "127.0.0.1:3000" }],
  "rewrite": { "uri": "/route-auth/verify" },
  "headers": {
    "request": {
      "set": {
        "X-Route-Domain": ["nas.example.com"],
        "X-Forwarded-Host": ["{http.request.host}"],
        "X-Forwarded-Uri": ["{http.request.uri}"]
      }
    }
  },
  "handle_response": [
    {
      "match": { "status_code": [401] },
      "routes": [
        {
          "handle": [
            {
              "handler": "headers",
              "response": {
                "set": {
                  "Location": ["/route-auth/login?route={http.request.host}&redirect={http.request.uri}"]
                }
              }
            },
            { "handler": "static_response", "status_code": 302 }
          ]
        }
      ]
    }
  ]
}
```

The `/route-auth/verify` endpoint returns 200 (allow) or 401 (deny). On 401, Caddy's `handle_response` redirects to the login page. The login page is served through the **same domain** as the target route (Caddy proxies `/route-auth/*` to GateControl before the target reverse_proxy). This ensures cookies are set on the correct domain.

**Caddy route structure per protected domain:**
1. `route /route-auth/*` → proxy to GateControl (login page, verify, etc.)
2. `route *` → forward_auth subrequest + proxy to target

Routes with Basic Auth remain unchanged. Routes without auth have no auth handler. Route Auth is **only available for HTTP routes** (`route_type = 'http'`), not L4 routes.

## API Endpoints

### Public (no admin login required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/route-auth/verify` | Caddy forward_auth check — validates session cookie, returns 200 or 401+Redirect |
| `GET` | `/route-auth/login` | Render login page (adapts to route's auth_type) |
| `POST` | `/route-auth/login` | Validate email & password |
| `POST` | `/route-auth/send-code` | Generate and send email OTP |
| `POST` | `/route-auth/verify-code` | Validate email OTP or TOTP code |
| `POST` | `/route-auth/logout` | Delete session, redirect to login |

### Admin API (behind auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/routes/:id/auth` | Get route auth config |
| `POST` | `/api/routes/:id/auth` | Create/update route auth config |
| `DELETE` | `/api/routes/:id/auth` | Remove route auth config |
| `POST` | `/api/routes/:id/auth/totp-setup` | Generate TOTP secret, return QR code URI |
| `GET` | `/api/smtp/settings` | Get SMTP settings |
| `PUT` | `/api/smtp/settings` | Save SMTP settings |
| `POST` | `/api/smtp/test` | Send test email |

## Auth Flow Details

### Single Factor — Email & Password
```
Login page → POST /route-auth/login (email + password)
  → Argon2 verify → Set session cookie → Redirect to target
```

### Single Factor — Email & Code
```
Login page → Enter email → POST /route-auth/send-code
  → Generate 6-digit code → Send via SMTP → Code input screen
  → POST /route-auth/verify-code → Set session cookie → Redirect
```

### Single Factor — TOTP
```
Login page → Enter TOTP code → POST /route-auth/verify-code
  → otpauth.verify() → Set session cookie → Redirect
```

### 2FA — Email & Password + Email Code
```
Step 1: POST /route-auth/login (email + password)
  → Argon2 verify → Temp token (2FA pending) → Send code via SMTP → Redirect to step 2
Step 2: POST /route-auth/verify-code (code + temp token)
  → Verify code → Set session cookie → Redirect to target
```

### 2FA — Email & Password + TOTP
```
Step 1: POST /route-auth/login (email + password)
  → Argon2 verify → Temp token (2FA pending) → Redirect to step 2
Step 2: POST /route-auth/verify-code (totp + temp token)
  → otpauth.verify() → Set session cookie → Redirect to target
```

## Session Cookie

- **Name:** `gc.route.sid`
- **Attributes:** HttpOnly, Secure, SameSite=Strict
- **Value:** Session ID (UUID) → lookup in `route_auth_sessions`
- **Domain:** Not explicitly set (defaults to the request domain). Since Caddy proxies `/route-auth/*` through the target domain (e.g., `nas.example.com`), the cookie is automatically scoped to that domain.
- **Expiry:** Configurable per route (`session_max_age`), stored as ms in DB, converted to ISO timestamp for `expires_at`
- Separate from admin session cookie (`gc.sid`)

## Security

- OTP codes stored as SHA-256 hash (not plaintext)
- When a new OTP is generated, all previous unused OTPs for the same route/email are invalidated
- TOTP secrets encrypted with AES-256-GCM (using existing `GC_ENCRYPTION_KEY` and `src/utils/crypto.js`)
- SMTP password encrypted with same AES-256-GCM utility in the `settings` table
- Password hashing uses Argon2 (via existing `src/utils/argon2Options.js`), consistent with admin auth (note: existing Basic Auth uses bcrypt — not changed for backwards compatibility)
- **2FA temp tokens:** Stored in `route_auth_sessions` with `two_factor_pending = 1` flag. After Step 1 (password verified), a session is created with this flag set. Step 2 verification clears the flag. Sessions with `two_factor_pending = 1` older than 5 minutes are rejected and cleaned up. The session ID is set as the `gc.route.sid` cookie immediately, but the `forward_auth` verify endpoint rejects sessions with `two_factor_pending = 1`.
- Email addresses partially masked in logs (`m***@example.com`)
- **CSRF protection:** Route-auth POST endpoints use double-submit cookie pattern (not session-based). A CSRF token is set as a cookie on the login page and must be sent back in the request body. This avoids dependency on admin sessions.
- **Rate limiting:** 5 login attempts / 15 min per IP, 3 code requests / 5 min per email. Additionally, per-route rate limiting: 10 failed attempts / 15 min per route (across all IPs) triggers a temporary lockout with warning in activity log.
- Failed attempts logged to activity_log
- **Mutual exclusivity:** Service layer enforces that a route cannot have both `basic_auth_enabled = 1` and a `route_auth` entry. Setting one disables the other.
- **Logout uses POST** (not GET) to prevent CSRF via link prefetching

## UI Integration

### Route Edit Modal (`route-edit.njk`)

Auth type selection replaces current Basic Auth toggle:

```
Authentifizierung: [Keine] [Basic Auth] [Route Auth]  ← toggle-group
```

When "Route Auth" selected:
- Method toggle: [Email & Passwort] [Email & Code] [TOTP]
- Conditional fields based on method (email, password, TOTP setup)
- 2FA toggle row (like HTTPS toggle)
- When 2FA enabled: "Email & Passwort" method disabled (is always factor 1), show factor 1 + factor 2 sections
- Session duration dropdown (1h, 12h, 24h, 7d, 30d)

### SMTP Settings Card (`settings.njk`)

New card in existing `two-col` grid on `/settings` page:
- Server settings: Host, Port, User, Password, Sender, TLS toggle
- Test section: Email input + send button, inline result display

### Route List Badges

- Existing "Auth" badge stays for Basic Auth
- New "Route Auth" badge (different color) for new auth method
- Tooltip shows method: "Email & Passwort", "TOTP", "2FA: Email + TOTP"

### Login Page

- Standalone page at `/route-auth/login` (no admin layout, own template)
- GateControl branding (logo + name), Cloudflare-style centered card
- Domain badge showing which route is being accessed
- Adapts to auth_type: shows relevant form fields
- 2FA: step indicator dots, sequential screens
- Code input: 6 individual fields with auto-focus on input, backspace navigation, paste support

## Activity Logging

Events written to existing `activity_log`:
- `route_auth_login` — Successful login (email, route domain, IP)
- `route_auth_login_failed` — Failed attempt (email, route domain, IP, reason)
- `route_auth_code_sent` — Email code sent (masked email, route domain)
- `route_auth_logout` — Session ended
- `route_auth_session_expired` — Automatic expiry
- `route_auth_config_created` — Admin enabled Route Auth on a route
- `route_auth_config_updated` — Admin changed Route Auth settings
- `route_auth_config_deleted` — Admin removed Route Auth from a route
- `route_auth_lockout` — Route temporarily locked due to excessive failed attempts

### Edge Cases

- **Invalid `?route=` parameter:** If the domain does not exist or has no Route Auth configured, show a generic "Route not found" error page (no information leaking about existing routes).
- **SMTP not configured:** If admin selects Email Code method but SMTP is not configured, show validation error with link to SMTP settings.
- **Mobile responsiveness:** Login page uses responsive CSS with breakpoints matching the existing `app.css` (900px, 600px). Card adapts to mobile viewport.

## File Structure

### New Files

| File | Description |
|------|-------------|
| `src/services/routeAuth.js` | Route auth business logic |
| `src/services/email.js` | SMTP service |
| `src/routes/routeAuth.js` | Public auth endpoints |
| `src/routes/api/routeAuth.js` | Admin API for route auth config |
| `src/routes/api/smtp.js` | Admin API for SMTP settings |
| `templates/default/pages/route-auth-login.njk` | Login page template |
| `public/js/route-auth-login.js` | Login page frontend logic |
| `public/css/route-auth.css` | Login page styles |

### Modified Files

| File | Changes |
|------|---------|
| `src/db/migrations.js` | Add route_auth, route_auth_sessions, route_auth_otp tables |
| `src/services/routes.js` | Extend buildCaddyConfig() with forward_auth handler |
| `src/routes/api/routes.js` | Handle route_auth data in create/update/delete |
| `src/app.js` | Mount new routes |
| `templates/default/partials/modals/route-edit.njk` | Auth type selection, method config, TOTP setup, 2FA toggle |
| `templates/default/pages/settings.njk` | SMTP card in two-col grid |
| `public/js/routes.js` | Route auth UI logic |
| `public/js/settings.js` | SMTP settings logic |
| `src/i18n/en.json` | New i18n keys |
| `src/i18n/de.json` | German translations |
| `src/middleware/rateLimit.js` | Rate limiters for route-auth endpoints |
| `package.json` | Add nodemailer, otpauth |

## Dependencies

- **`nodemailer`** — SMTP email sending
- **`otpauth`** — TOTP generation and validation

No new native dependencies required. OTP code generation uses `crypto.randomInt()`, hashing uses `crypto.createHash('sha256')` (both Node.js built-in).
