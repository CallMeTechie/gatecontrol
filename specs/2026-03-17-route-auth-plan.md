# Route Auth System — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser Basic Auth dialogs with custom login pages supporting Email+Password, Email OTP, TOTP, and optional 2FA per route.

**Architecture:** Caddy `reverse_proxy` with `handle_response` blocks (forward_auth pattern) delegates auth to GateControl endpoints. Route-auth sessions are stored in SQLite, separate from admin sessions. Login pages are served through the target domain via Caddy proxying `/route-auth/*` to GateControl.

**Tech Stack:** Node.js/Express, SQLite (better-sqlite3), Argon2 (passwords), otpauth (TOTP), nodemailer (SMTP), Nunjucks templates, vanilla JS frontend.

**Spec:** `specs/2026-03-17-route-auth-design.md`

---

## Chunk 1: Foundation (DB, Dependencies, Services)

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install nodemailer, otpauth, and cookie-parser**

```bash
cd /root/gatecontrol && npm install nodemailer otpauth cookie-parser
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('nodemailer'); require('otpauth'); require('cookie-parser'); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add nodemailer, otpauth, and cookie-parser for route auth"
```

---

### Task 2: Database migrations

**Files:**
- Modify: `src/db/migrations.js` (append after line 202, before `logger.info('Database migrations completed')`)

- [ ] **Step 1: Add route_auth tables to migrations.js**

Append this block after the composite indexes section (after line 202), before the final `logger.info`:

```javascript
  // Migration: Route Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_auth (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL UNIQUE,
      auth_type TEXT NOT NULL,
      two_factor_enabled INTEGER NOT NULL DEFAULT 0,
      two_factor_method TEXT,
      email TEXT,
      password_hash TEXT,
      totp_secret_encrypted TEXT,
      session_max_age INTEGER NOT NULL DEFAULT 86400000,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_route_auth_route_id ON route_auth(route_id);

    CREATE TABLE IF NOT EXISTS route_auth_sessions (
      id TEXT PRIMARY KEY,
      route_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      ip_address TEXT,
      two_factor_pending INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_route_auth_sessions_expires ON route_auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_route_auth_sessions_route_pending ON route_auth_sessions(route_id, two_factor_pending);

    CREATE TABLE IF NOT EXISTS route_auth_otp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_route_auth_otp_route_email ON route_auth_otp(route_id, email);
  `);
```

- [ ] **Step 2: Verify migration runs without errors**

```bash
cd /root/gatecontrol && node -e "
  const { initDb } = require('./src/db/connection');
  initDb();
  const { runMigrations } = require('./src/db/migrations');
  runMigrations();
  const { getDb } = require('./src/db/connection');
  const tables = getDb().prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'route_auth%'\").all();
  console.log(tables.map(t => t.name));
"
```
Expected: `[ 'route_auth', 'route_auth_sessions', 'route_auth_otp' ]`

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations.js
git commit -m "feat: add route_auth database tables and indexes"
```

---

### Task 3: Email service (SMTP)

**Files:**
- Create: `src/services/email.js`

- [ ] **Step 1: Create email service**

Create `src/services/email.js` with the following functionality:

- `getSmtpSettings()` — reads smtp_* keys from settings table
- `isSmtpConfigured()` — checks if host, port, from are set
- `createTransporter()` — creates nodemailer transport from settings, decrypts password via `src/utils/crypto.js decrypt()`
- `sendMail({ to, subject, text, html })` — sends an email using the transporter
- `sendOtpEmail({ to, code, domain, lang })` — sends styled OTP email with 6-digit code, GateControl branding, supports EN and DE
- `sendTestEmail(to)` — sends a simple test email
- `saveSmtpSettings({ host, port, user, password, from, secure })` — upserts settings, encrypts password via `src/utils/crypto.js encrypt()`
- `resetTransporter()` — clears cached transporter (call after settings change)

Port 587 defaults to STARTTLS. Password is encrypted with AES-256-GCM via existing `encrypt()` from `src/utils/crypto.js`.

- [ ] **Step 2: Verify module loads**

```bash
cd /root/gatecontrol && node -e "const e = require('./src/services/email'); console.log(typeof e.sendOtpEmail)"
```
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add src/services/email.js
git commit -m "feat: add SMTP email service for route auth OTP"
```

---

### Task 4: Route Auth service (core business logic)

**Files:**
- Create: `src/services/routeAuth.js`

- [ ] **Step 1: Create routeAuth service**

Create `src/services/routeAuth.js` with the following functionality:

**Session cleanup (setInterval, 15min, `.unref()`):**
- `startSessionCleanup()` / `stopSessionCleanup()`
- Deletes expired sessions (where `expires_at < now`)
- Deletes stale 2FA pending sessions (where `two_factor_pending = 1` and `created_at` older than 5 min)
- Cleans used/expired OTPs

**Route Auth CRUD:**
- `getAuthForRoute(routeId)` — SELECT from route_auth WHERE route_id
- `getAuthByDomain(domain)` — JOIN route_auth with routes on domain, WHERE enabled=1
- `createOrUpdateAuth(routeId, data)` — INSERT or UPDATE route_auth. Disables basic_auth on the route (mutual exclusivity). Hashes password with argon2 (using `src/utils/argon2Options.js`). Encrypts totp_secret with `encrypt()`. Logs to activity.
- `deleteAuth(routeId)` — DELETE from route_auth, route_auth_sessions, route_auth_otp. Logs to activity.

**Session management:**
- `createSession(routeId, email, ip, maxAge, twoFactorPending)` — INSERT with crypto.randomUUID(), calculates expires_at from maxAge
- `verifySession(sessionId, routeId)` — SELECT WHERE id, route_id, two_factor_pending=0, expires_at > now
- `getSession(sessionId)` — SELECT WHERE id, expires_at > now (includes pending sessions)
- `completeTwoFactor(sessionId)` — Finds pending session (created < 5min ago), clears flag, updates expires_at with route's session_max_age
- `deleteSession(sessionId)` — DELETE

**Password verification:**
- `verifyPassword(authConfig, email, password)` — checks email match, then argon2.verify

**OTP (Email Code):**
- `generateOtp()` — `crypto.randomInt(100000, 999999)` as string
- `hashOtp(code)` — `crypto.createHash('sha256')`
- `createAndSendOtp(routeId, email, domain, lang)` — invalidates previous OTPs for route/email, generates new code, stores hash in route_auth_otp, sends via `sendOtpEmail()`, logs to activity
- `verifyOtp(routeId, email, code)` — finds latest unused non-expired OTP, compares hash, marks used

**TOTP:**
- `generateTotpSecret(domain)` — creates otpauth.Secret, returns { secret: base32, uri: otpauth URI }
- `verifyTotp(encryptedSecret, token)` — decrypts secret, creates TOTP instance, validates with window=1

**Helpers:**
- `maskEmail(email)` — `m***@example.com`
- `generateCsrfToken()` — `crypto.randomBytes(32).toString('hex')`
- `verifyCsrfToken(cookieToken, bodyToken)` — `crypto.timingSafeEqual`

- [ ] **Step 2: Verify module loads**

```bash
cd /root/gatecontrol && node -e "const ra = require('./src/services/routeAuth'); console.log(Object.keys(ra).length + ' exports')"
```

- [ ] **Step 3: Commit**

```bash
git add src/services/routeAuth.js
git commit -m "feat: add route auth service with session, OTP, TOTP, and CSRF logic"
```

---

## Chunk 2: API Endpoints & Rate Limiting

### Task 5: Rate limiters for route auth

**Files:**
- Modify: `src/middleware/rateLimit.js`

- [ ] **Step 1: Add route auth rate limiters**

Add after the existing `apiLimiter` (after line 25, before `module.exports`):

- `routeAuthLoginLimiter` — 5 attempts / 15 min per IP, returns 429 JSON
- `routeAuthCodeLimiter` — 3 attempts / 5 min per email (from `req.body.email`), returns 429 JSON

Update `module.exports` to include both new limiters.

- [ ] **Step 2: Commit**

```bash
git add src/middleware/rateLimit.js
git commit -m "feat: add rate limiters for route auth endpoints"
```

---

### Task 6: SMTP admin API

**Files:**
- Create: `src/routes/api/smtp.js`

- [ ] **Step 1: Create SMTP API router**

- `GET /settings` — returns SMTP settings (never returns encrypted password, only `hasPassword: bool`)
- `PUT /settings` — validates host/port/from required, port 1-65535, saves via `saveSmtpSettings()`, all errors use i18n keys
- `POST /test` — requires email in body, calls `sendTestEmail()`, returns ok or error

All responses use `{ ok: true/false, ... }` format.

- [ ] **Step 2: Commit**

```bash
git add src/routes/api/smtp.js
git commit -m "feat: add SMTP settings admin API"
```

---

### Task 7: Route Auth admin API

**Files:**
- Create: `src/routes/api/routeAuth.js`

- [ ] **Step 1: Create route auth admin API router**

Uses `Router({ mergeParams: true })` since it's mounted at `/api/routes/:id/auth`.

- `GET /` — returns auth config (never returns password_hash or totp_secret, only `has_password` and `has_totp` booleans)
- `POST /` — validates: route exists, route_type is 'http', auth_type is valid enum, email required for email-based methods, password required for password-based methods, SMTP configured for email_code, 2FA method is valid. Calls `createOrUpdateAuth()`.
- `DELETE /` — calls `deleteAuth()`
- `POST /totp-setup` — generates TOTP secret via `generateTotpSecret(domain)`, returns `{ secret, uri }`
- `POST /totp-verify` — encrypts provided secret, verifies provided token, returns `{ valid: bool }`

All responses use `{ ok: true/false, ... }` format, errors use i18n keys via `req.t()`.

- [ ] **Step 2: Commit**

```bash
git add src/routes/api/routeAuth.js
git commit -m "feat: add route auth admin API (CRUD, TOTP setup)"
```

---

### Task 8: Public route auth endpoints

**Files:**
- Create: `src/routes/routeAuth.js`

- [ ] **Step 1: Create public route auth routes**

Express Router with these endpoints:

**GET /verify** — Caddy forward_auth check:
- Reads `X-Route-Domain` header
- Looks up auth config by domain
- If no config → 200 (allow)
- Reads `gc.route.sid` cookie, calls `verifySession()`
- Valid → 200, Invalid → 401

**GET /login** — Renders login page:
- Reads `?route=` param
- Looks up auth config
- If already authenticated → redirect to `?redirect` or `/`
- Checks for 2FA pending session
- Sets CSRF double-submit cookie (`gc.route.csrf`, httpOnly, secure, sameSite strict, 15min)
- Renders `route-auth-login.njk` with context: domain, authType, twoFactorEnabled, twoFactorMethod, is2faStep2, maskedEmail, redirect, csrfToken

**POST /login** — Email & Password:
- CSRF check (cookie vs body `_csrf`)
- Rate limited via `routeAuthLoginLimiter`
- Verifies password via `verifyPassword()`
- On fail: log `route_auth_login_failed`, return 401
- If 2FA enabled: create pending session (5min), set cookie, send OTP if email_code method, return `{ twoFactorRequired: true }`
- If single factor: create full session, set cookie, log `route_auth_login`, return redirect

**POST /send-code** — Email OTP:
- CSRF check, rate limited via `routeAuthCodeLimiter`
- Verifies email matches config
- Calls `createAndSendOtp()`
- Returns masked email

**POST /verify-code** — OTP or TOTP:
- CSRF check, rate limited via `routeAuthLoginLimiter`
- Determines TOTP vs email OTP from auth config
- Validates code
- If 2FA: calls `completeTwoFactor()`, upgrades session
- If single factor: creates new full session
- Logs success/failure to activity

**POST /logout:**
- Reads session cookie, logs activity
- Deletes session, clears cookies
- Redirects to login page

Cookie name: `gc.route.sid`. CSRF cookie: `gc.route.csrf`.

- [ ] **Step 2: Commit**

```bash
git add src/routes/routeAuth.js
git commit -m "feat: add public route auth endpoints (verify, login, OTP, TOTP, logout)"
```

---

### Task 9: Mount new routes

**Files:**
- Modify: `src/app.js`
- Modify: `src/routes/index.js`
- Modify: `src/routes/api/index.js`
- Modify: `src/server.js`

- [ ] **Step 1: Add cookie-parser to app.js**

In `src/app.js`:
- Add `const cookieParser = require('cookie-parser');` to requires
- Add `app.use(cookieParser());` after body parsing, before static files

- [ ] **Step 2: Mount route-auth routes in index.js**

In `src/routes/index.js`:
- Add `const routeAuthRoutes = require('./routeAuth');`
- Add `router.use('/route-auth', routeAuthRoutes);` before the admin auth routes

- [ ] **Step 3: Mount admin APIs in api/index.js**

In `src/routes/api/index.js`, add:
- `router.use('/routes/:id/auth', require('./routeAuth'));`
- `router.use('/smtp', require('./smtp'));`

- [ ] **Step 4: Start session cleanup in server.js**

In `src/server.js`, after the server starts:
- `const { startSessionCleanup } = require('./services/routeAuth');`
- `startSessionCleanup();`

- [ ] **Step 5: Verify app starts without errors**

```bash
cd /root/gatecontrol && node -e "
  const { initDb } = require('./src/db/connection');
  initDb();
  const { runMigrations } = require('./src/db/migrations');
  runMigrations();
  const { createApp } = require('./src/app');
  const app = createApp();
  console.log('App created successfully');
"
```
Expected: `App created successfully`

- [ ] **Step 6: Commit**

```bash
git add src/app.js src/routes/index.js src/routes/api/index.js src/server.js package.json package-lock.json
git commit -m "feat: mount route auth routes and add cookie-parser"
```

---

## Chunk 3: Caddy Integration

### Task 10: Extend buildCaddyConfig for forward auth

**Files:**
- Modify: `src/services/routes.js`

- [ ] **Step 1: Add route auth import**

At the top of `src/services/routes.js`, after the existing requires (after line 9):

```javascript
const { getAuthForRoute } = require('./routeAuth');
```

- [ ] **Step 2: Modify buildCaddyConfig**

In the `buildCaddyConfig()` function, after the basic auth handler block (after line 96), before setting `caddyRoutes[route.domain]`:

Check if route has route_auth config (`getAuthForRoute(route.id)`). If yes and basic_auth is NOT enabled:

1. Create a `/route-auth/*` route that proxies to `127.0.0.1:3000`
2. Create a forward auth `reverse_proxy` subrequest handler that:
   - Rewrites to `/route-auth/verify`
   - Sets headers: `X-Route-Domain`, `X-Forwarded-Host`, `X-Forwarded-Uri`
   - On 401 response: redirects to `/route-auth/login?route={domain}&redirect={uri}`
3. Unshift the forward auth handler before the reverse proxy in routeConfig
4. Set `caddyRoutes[route.domain]` with both the route-auth proxy route and the main route

If no route_auth or basic_auth is enabled: set caddyRoutes as before (existing behavior).

See spec `specs/2026-03-17-route-auth-design.md` lines 102-136 for exact Caddy JSON structure.

- [ ] **Step 3: Commit**

```bash
git add src/services/routes.js
git commit -m "feat: extend Caddy config with forward auth for route auth"
```

---

## Chunk 4: i18n

### Task 11: Add i18n translations

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English translations**

Add a `route_auth` section to `en.json` covering all UI text:
- Login page: verify_access, access_to, email, password, sign_in, continue, verify, send_code, enter_code, authenticator_code, enter_authenticator_code, code_sent_to, resend_code, back, step_1_sign_in, step_2_email_code, step_2_authenticator, protected_by
- Errors: route_not_found, invalid_credentials, invalid_code, session_expired, too_many_attempts
- Route settings: auth_type, auth_none, auth_basic, auth_route, method, method_email_password, method_email_code, method_totp, two_factor, two_factor_desc, two_factor_active, factor_1, factor_2_email, factor_2_totp, session_duration, session_1h/12h/24h/7d/30d
- TOTP: totp_setup, totp_scan_qr, totp_confirm_code, totp_confirm, totp_generate, totp_fields_required
- Validation: email_required, password_required, password_hint, invalid_auth_type, invalid_2fa_method, http_only, smtp_not_configured
- SMTP: smtp_title, smtp_subtitle, smtp_server_settings, smtp_host, smtp_port, smtp_user, smtp_password, smtp_from, smtp_from_hint, smtp_tls, smtp_tls_desc, smtp_test, smtp_test_desc, smtp_test_send, smtp_test_success, smtp_test_email_required, smtp_fields_required, smtp_invalid_port, smtp_save
- Badge: badge_route_auth, email_password_is_factor_1

- [ ] **Step 2: Add German translations**

Add matching `route_auth` section to `de.json` with German translations for all the same keys.

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat: add i18n translations for route auth and SMTP settings"
```

---

## Chunk 5: Frontend Templates and UI

### Task 12: Login page template and styles

**Files:**
- Create: `templates/default/pages/route-auth-login.njk`
- Create: `public/css/route-auth.css`
- Create: `public/js/route-auth-login.js`

**Design reference:** `/root/mockup-route-auth-login.html`

- [ ] **Step 1: Create login page CSS (`public/css/route-auth.css`)**

Standalone CSS file for the public login page. Uses same CSS variables as `public/css/app.css` (--bg-base, --accent, --text-1, --border, etc.) and same font families (Outfit, DM Serif Display, JetBrains Mono).

Key classes:
- `.login-card` — centered card with shadow, max-width 400px
- `.logo` / `.logo-icon` / `.logo-wordmark` — GateControl branding
- `.domain-badge` — mono font, bg-input background
- `.code-inputs` — 6 individual input fields, 44x52px each
- `.step-indicator` — dots for 2FA progress
- `.info-text` — centered gray text
- `.btn-primary` — green accent button, full width
- Responsive: card width adapts below 600px

- [ ] **Step 2: Create login page template (`templates/default/pages/route-auth-login.njk`)**

Standalone HTML page (does NOT extend layout.njk). Includes:
- Google Fonts links
- Link to `/css/route-auth.css`
- Script `/js/route-auth-login.js` with nonce `{{ cspNonce }}`

Template logic using Nunjucks conditionals:
- If `error`: show error message
- If `is2faStep2` and `twoFactorMethod == 'email_code'`: show code input (Email Code step 2)
- If `is2faStep2` and `twoFactorMethod == 'totp'`: show code input (TOTP step 2)
- If `authType == 'email_password'` and not 2FA: show email + password form
- If `authType == 'email_code'`: show email field + send code button, then code input
- If `authType == 'totp'`: show code input
- If `twoFactorEnabled` and not `is2faStep2`: show email + password form (step 1 with step indicator)

All visible text uses `{{ t('route_auth.*') }}` i18n keys.
Hidden fields: `_csrf` (value from `csrfToken`), `route` (value from `domain`), `redirect`.

- [ ] **Step 3: Create login page JavaScript (`public/js/route-auth-login.js`)**

Vanilla JS handling:
- **Code input auto-focus:** On each `.code-inputs input`, advance focus on input, go back on backspace, distribute on paste (6-char paste fills all fields)
- **Form submission via fetch:** POST to `/route-auth/login`, `/route-auth/send-code`, or `/route-auth/verify-code` depending on form action
- **Login flow:** On success with `twoFactorRequired`, reload page (server will show step 2 since pending session exists). On success with `redirect`, `window.location = redirect`.
- **Send code flow:** On success, show code input section, hide email section
- **Error display:** Show error message in a `.form-error` div
- **Resend code:** Re-POST to `/route-auth/send-code`
- **Auto-submit:** When all 6 code digits are filled, automatically submit

- [ ] **Step 4: Commit**

```bash
git add public/css/route-auth.css templates/default/pages/route-auth-login.njk public/js/route-auth-login.js
git commit -m "feat: add route auth login page template, styles, and frontend logic"
```

---

### Task 13: Route edit modal — auth type selection

**Files:**
- Modify: `templates/default/partials/modals/route-edit.njk` (lines 78-94)
- Modify: `public/js/routes.js`

**Design reference:** `/root/mockup-route-auth-settings.html`

- [ ] **Step 1: Update route-edit.njk**

Replace the Basic Auth toggle row and fields (lines 78-94) with:

1. **Auth type toggle-group** (full width, 3 options):
   - `{{ t('route_auth.auth_none') }}` — data-value="none"
   - `{{ t('route_auth.auth_basic') }}` — data-value="basic"
   - `{{ t('route_auth.auth_route') }}` — data-value="route"

2. **Basic Auth fields** (shown when "basic" selected, same as existing lines 85-94):
   - Username input, Password input

3. **Route Auth section** (shown when "route" selected, `id="edit-route-auth-fields"`):
   - **Method toggle-group**: Email & Passwort | Email & Code | TOTP
   - **Email field** (shown for email_password, email_code, and when 2FA)
   - **Password field** (shown for email_password and when 2FA)
   - **TOTP setup area** (shown for TOTP): button "QR-Code generieren", placeholder for QR image + secret, verify input + confirm button
   - **2FA toggle row** (same style as HTTPS toggle): label, description, toggle switch
   - When 2FA active: show factor sections with `tfa-section` styling, disable "Email & Passwort" in method group
   - **Session duration dropdown**: 1h, 12h, 24h (default), 7d, 30d

All text uses `{{ t('route_auth.*') }}` keys.
Hidden input `id="edit-route-auth-type"` to track auth type.

- [ ] **Step 2: Update public/js/routes.js**

Add route auth UI logic:

**Toggle handling:**
- Auth type toggle: show/hide Basic Auth fields vs Route Auth section vs nothing
- Method toggle: show/hide email, password, TOTP fields based on selection
- 2FA toggle: when enabled, disable "Email & Passwort" method option (it becomes factor 1), show factor 1/2 sections, auto-switch to email_code or totp if email_password was selected

**TOTP setup:**
- "Generate QR code" button: POST `/api/routes/:id/auth/totp-setup`, display returned URI as QR code (use client-side QR library or data URI), show base32 secret
- Verify input: POST `/api/routes/:id/auth/totp-verify` with secret + token, show success/error

**Save flow:**
- When saving a route with Route Auth, after the main route save, POST `/api/routes/:id/auth` with the auth config
- When saving with "none" or "basic", DELETE `/api/routes/:id/auth` if route auth existed

**Load flow:**
- When opening edit modal, GET `/api/routes/:id/auth` and populate fields
- Set correct toggle states, show/hide relevant sections

**Route list badges:**
- When rendering route items, check for route_auth data
- Show "Route Auth" badge (tag-blue) with tooltip showing method

- [ ] **Step 3: Commit**

```bash
git add templates/default/partials/modals/route-edit.njk public/js/routes.js
git commit -m "feat: add route auth config UI to route edit modal"
```

---

### Task 14: SMTP settings card on settings page

**Files:**
- Modify: `templates/default/pages/settings.njk`
- Modify: `public/js/settings.js`

**Design reference:** `/root/mockup-route-auth-settings.html` (SMTP Settings screen)

- [ ] **Step 1: Add SMTP card to settings.njk**

In the left column of the `two-col` grid (after the webhooks card, after line 60), add two new cards:

**Card 1: Server settings**
- Card head: mail SVG icon + `{{ t('route_auth.smtp_server_settings') }}`
- Card body:
  - Inline row: Host input + Port input (100px)
  - User input
  - Password input
  - From (email) input with hint
  - TLS toggle row (same style as HTTPS toggle in route-edit)
  - Save button (align right)

**Card 2: Test connection**
- Card head: checkmark SVG icon + `{{ t('route_auth.smtp_test') }}`
- Card body:
  - Description text
  - Inline row: email input + send button (`btn-ghost`)
  - Result div (`id="smtp-test-result"`, hidden initially)

- [ ] **Step 2: Update public/js/settings.js**

Add SMTP settings handling:

- **On page load:** GET `/api/smtp/settings`, populate fields (host, port, user, from, secure toggle, show "Password set" indicator if hasPassword)
- **Save button:** PUT `/api/smtp/settings` with form values. Show success flash.
- **Test button:** POST `/api/smtp/test` with email. Show success (green) or error (red) in result div.

- [ ] **Step 3: Commit**

```bash
git add templates/default/pages/settings.njk public/js/settings.js
git commit -m "feat: add SMTP configuration card to settings page"
```

---

## Chunk 6: Integration and Testing

### Task 15: End-to-end verification

- [ ] **Step 1: Build Docker image**

```bash
cd /root/gatecontrol && docker build -t gatecontrol:route-auth .
```

- [ ] **Step 2: Run container and verify startup**

Verify:
- Database migrations run without errors (route_auth tables created)
- App starts and all routes are mounted
- Session cleanup timer is running

- [ ] **Step 3: Test SMTP settings UI**

- Navigate to `/settings`
- Verify SMTP card is visible
- Save SMTP settings
- Send test email

- [ ] **Step 4: Test route auth configuration**

- Edit an HTTP route
- Select "Route Auth"
- Configure Email & Password method
- Save and verify Caddy config is updated with forward auth

- [ ] **Step 5: Test login page**

- Access the route's domain
- Verify redirect to login page
- Test login with correct/incorrect credentials
- Verify session cookie is set
- Verify redirect to target after auth

- [ ] **Step 6: Test TOTP flow**

- Edit route, select TOTP method
- Generate QR code, scan and verify with code
- Test TOTP login on the route

- [ ] **Step 7: Test 2FA flow**

- Edit route, enable 2FA with TOTP as second factor
- Test step 1 (email + password) then step 2 (TOTP code)
- Verify full flow works end to end

- [ ] **Step 8: Build deploy image**

```bash
cd /root/gatecontrol && docker build -t gatecontrol:route-auth .
docker save gatecontrol:route-auth | gzip > /root/gatecontrol-deploy/gatecontrol-image.tar.gz
```

---

## Task Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-4 | Foundation: dependencies, DB migrations, email service, route auth service |
| 2 | 5-9 | API endpoints, rate limiting, route mounting |
| 3 | 10 | Caddy forward auth config generation |
| 4 | 11 | i18n translations (EN + DE) |
| 5 | 12-14 | Frontend: login page, route edit modal, SMTP settings |
| 6 | 15 | Integration testing and Docker build |
