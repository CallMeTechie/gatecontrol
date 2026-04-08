# Changelog

## [1.19.9] — 2026-04-08

### Fixes
- use npm@latest for glob/cross-spawn CVEs, ignore picomatch

---

## [1.19.8] — 2026-04-08

### Fixes
- update npm to 10.9.2 to fix cross-spawn CVE-2024-21538

---

## [1.19.7] — 2026-04-08

### Fixes
- remove global npm update that introduced picomatch CVE

---

## [1.19.6] — 2026-04-08

### Fixes
- add npm overrides for transitive CVEs (picomatch, cross-spawn)

---

## [1.19.5] — 2026-04-08

### Fixes
- patch remaining container CVEs (cross-spawn, go-jose/v4)

---

## [1.19.4] — 2026-04-08

### Fixes
- patch container vulnerabilities (zlib, npm, Go deps)

---

## [1.19.3] — 2026-04-08

### Fixes
- update caddy-mirror plugin to Caddy v2.11.2

---

## [1.19.2] — 2026-04-08

### Fixes
- add actions:read permission for CodeQL workflow

---

## [1.19.1] — 2026-04-08

### Fixes
- block releases on critical/high container vulnerabilities

---

## [1.19.0] — 2026-04-07

### Features
- add Android client support to update check endpoint

---

## [1.18.3] — 2026-04-07

### Fixes
- use api.del() instead of api.delete() for token revocation and user deletion

---

## [1.18.2] — 2026-04-05

### Fixes
- add user visibility checkboxes to create route form

---

## [1.18.1] — 2026-04-05

### Fixes
- add migration 33 for user_ids column + filter services/RDP by user

---

## [1.18.0] — 2026-04-04

### Features
- add token assignment UI for unassigned tokens in users page

---

## [1.17.2] — 2026-04-04

### Fixes
- prevent modal backdrop click from closing user/token modals

---

## [1.17.1] — 2026-04-04

### Fixes
- users page CSS — use correct modal/table classes, fix JS field names

---

## [1.17.0] — 2026-04-04

### Features
- add users page with token management, remove settings API tab

---

## [1.16.0] — 2026-04-04

### Features
- add user API routes and token user_id support

---

## [1.15.0] — 2026-04-04

### Features
- add user service with CRUD, role validation, and tests

---

## [1.14.1] — 2026-04-04

### Fixes
- remove WG/Caddy config pages, move service cards to settings

---

## [1.14.0] — 2026-04-04

### Features
- implement ECDH E2EE for RDP credential transmission

---

## [1.13.1] — 2026-04-04

### Fixes
- show RDP route count badge on all pages, not just /routes

---

## [1.13.0] — 2026-04-04

### Features
- maintenance window enforcement — block client connect during scheduled maintenance

---

## [1.12.4] — 2026-04-03

### Fixes
- RDP session disconnect — fallback lookup by routeId when sessionId missing

---

## [1.12.3] — 2026-04-03

### Fixes
- rewrite RDP dashboard to match mockup design exactly

---

## [1.12.2] — 2026-04-03

### Fixes
- DNS-Leak-Test Endpoint gibt VPN-DNS-Config zurück statt req.ip

---

## [1.12.1] — 2026-04-03

### Fixes
- robust client type detection via version range and X-Client-Name

---

## [1.12.0] — 2026-04-03

### Features
- support separate update repos for Community and Pro client

---

## [1.11.3] — 2026-04-03

### Fixes
- update check uses wrong repo, add redirect support and token docs

---

## [1.11.2] — 2026-04-02

### Fixes
- revert to push trigger for releases

---

## [1.11.1] — 2026-04-02

### Fixes
- register client:rdp as valid token scope

---

## [1.11.0] — 2026-04-02

### Features
- add client:rdp token scope for RDP access control

---

## [1.10.0] — 2026-04-02

### Features
- add host autocomplete with peer search, access mode field dependencies

---

## [1.9.3] — 2026-04-02

### Fixes
- use GC_DATA_DIR for keypair path, set in test setup

---

## [1.9.2] — 2026-04-02

### Fixes
- update deprecated actions to latest, fix npm audit vulnerabilities

---

## [1.9.1] — 2026-04-02

### Fixes
- skip CodeQL on dependabot PRs (insufficient token permissions)

---

## [1.9.0] — 2026-04-02

### Features
- add CodeQL, npm audit, ESLint security, Dependabot, and security gate for releases

---

## [1.8.3] — 2026-04-01

### Fixes
- fix script load order, add api.patch(), stats 6-column layout, filter bar under stats

---

## [1.8.2] — 2026-04-01

### Fixes
- rewrite modal to section-based scrollable layout matching mockup

---

## [1.8.1] — 2026-04-01

### Fixes
- fix modal CSS classes, show/hide mechanism, and port hint element IDs

---

## [1.8.0] — 2026-04-01

### Features
- register RDP health check and session cleanup in background tasks

---

## [1.7.0] — 2026-04-01

### Features
- add i18n keys for EN and DE -- RDP dashboard, routes, errors

---

## [1.6.1] — 2026-04-01

### Änderungen
- unified Build & Release workflow with auto-versioning

---

All notable changes to GateControl are documented in this file.

---

## [1.6.0] — 2026-03-29

### Features
- **Client Scope for API Tokens** — New dedicated `client` scope restricts tokens to `/api/v1/client/*` endpoints only. Windows/Desktop clients no longer need the overly broad `peers` scope.
- **Token Permissions UI Restructured** — Scopes are now grouped into three sections: Access Level, Resources, and Integration. Full-access acts as a master toggle that auto-selects and disables all other checkboxes — no more manually checking every option.

### Tests
- **Token Scope Tests** — New `tests/tokens.test.js` with 33 tests covering scope validation, `checkScope` logic (full-access, read-only, client, resource scopes, edge cases), token CRUD API, and token-based auth enforcement.

---

## [1.5.2] — 2026-03-24

### Improvements
- **Multiple Backends — Peer Selection** — Backend targets now use a peer dropdown instead of manual IP input. Peer IPs are resolved at Caddy config build time, so backend configs automatically update when a peer's IP changes. Disabled peers are skipped.
- **Mirror Targets — Peer Selection** — Same improvement for Request Mirroring targets. Peer dropdown instead of IP input, automatic IP resolution, disabled peers skipped.

### UI
- Dashboard stat cards: 5 columns layout, compact padding and font sizes
- Dashboard: Fixed missing green stripe on Monitoring card
- Sidebar: Peer badge now consistently shows total peer count (was showing online count on dashboard, total on other pages)
- Sidebar: Removed peer group count badge (redundant)

### Documentation
- `documentation/USER-GUIDE.md` — Complete user guide covering DNS setup, peer/client configuration, WireGuard clients (including docker-wireguard-go), all route features, authentication methods, 2FA/TOTP setup
- `demo/index.html` — Interactive animated demo with pixel-accurate GateControl UI, 2 walkthrough scenes (Peer creation with QR code, Route creation with all feature toggles), auto-scrolling cursor

---

## [1.5.1] — 2026-03-23

### Security — Critical
- **CSRF-Bypass Prevention** — Defensive reset of `req.tokenAuth` against prototype pollution attacks
- **Route-Auth Forward-Auth** — Returns 401 instead of 200 when `x-route-domain` header is missing
- **Caddy Config Injection** — Header name/value validation, rate_limit_window allowlist, sticky_cookie_name regex
- **DNS-Check SSRF** — Domain validation before DNS lookup, resolved IPs removed from response
- **Key-File Permissions** — Re-secured after recursive chown in entrypoint

### Security — High
- **Route-Auth Lockout** — Changed from IP-based to email-based lockout (prevents IP rotation bypass)
- **OTP Range** — Full 000000–999999 range with `padStart` (was excluding leading-zero codes)
- **OTP Resend** — Requires valid pending 2FA session before allowing code resend
- **CSRF Key Separation** — Route-auth CSRF uses HMAC-derived key instead of shared app secret
- **WireGuard Config Injection** — DNS validated as IP list, keepalive as integer, newlines blocked
- **Email HTML Injection** — All interpolated values in email templates escaped
- **Route Target SSRF** — Private/loopback IPs blocked for direct route targets (peer-linked routes unaffected)
- **Metrics Token Leak** — Removed `?token=` query parameter auth, header-only authentication
- **WG Key in Logs** — wg-quick output filtered to strip private key lines
- **Trust Proxy** — Restricted to loopback only (prevents IP spoofing via X-Forwarded-For)
- **CSP Styles** — Split into `style-src-elem` (nonce-protected) and `style-src-attr` (inline attributes)
- **Dashboard XSS** — API integers coerced with `parseInt` and inserted via `textContent`

### Security — Medium
- **TOTP Replay Prevention** — In-memory tracking of used TOTP codes per route (90s expiry)
- **Session Secure Warning** — Startup warning when production mode without HTTPS
- **Rate-Limiter Bypass** — Elevated limit only for session-authenticated requests
- **Backup Key Validation** — Regex allowlist for settings keys during restore
- **IP Filter Fix** — Uses Express-resolved `req.ip` instead of raw X-Forwarded-For header
- **CSS Injection** — Peer group color validated against hex regex
- **Monitoring XSS** — Response time sanitized with `parseInt` before HTML insertion
- **API Key Masking** — ip2location key no longer exposed in DOM, shows "Key is set" instead
- **Health Endpoint** — Detailed component state only for localhost, external gets `{ok: true/false}`
- **WG Signal Handling** — Guard variable prevents premature `wg-quick down` during startup

### Security — Low/Info
- Rate-limit error strings translated (EN+DE)
- Hardcoded German strings in routes.njk replaced with i18n
- Dead code `generateCsrfToken`/`verifyCsrfToken` removed
- Argon2 parallelism reduced from 4 to 1 (libuv thread pool)
- CSP `frame-ancestors: 'self'` added (clickjacking protection)
- Crypto ciphertext split with explicit length validation
- Branding fields capped at 255 (title) / 2000 (text) characters

### Documentation
- `documentation/SECURITY-HARDENING-v1.5.1.md` — Full security audit report with all 39 findings
- `documentation/SECURITY-CHANGES-v1.5.md` — Detailed migration guide for breaking changes (#13, #14, Prometheus config, Header-Auth)

---

## [1.5.0] — 2026-03-23

### New Features
- **Request Mirroring** — Duplicate HTTP requests asynchronously to up to 5 secondary backends for testing, debugging, or shadow deployments. Implemented as a custom Caddy Go module (`http.handlers.mirror`) with async goroutines, `sync.Pool` body buffering (max 10 MB), and 10s per-target timeout. Mirror targets receive an exact copy (method, URI, headers, body). Client response is never affected. WebSocket upgrades are automatically skipped. Configurable via UI toggle + target editor or API.

### Improvements
- Docker: Custom `caddy-mirror` Go module added to Caddy build via xcaddy
- `.dockerignore` excludes `*.tar.gz` to reduce build context size
- Activity log: `route_mirror_changed` event for mirror configuration audit trail
- Server-side validation for mirror targets (IP, port, max 5, no primary-backend overlap, HTTP-only)

### UI
- Mirror toggle + target editor in route create form and edit modal
- Blue `Mirror: N targets` badge on route cards
- Mobile FAB speed-dial with Peer/Route add options
- Settings tab bar: no vertical scroll, no rounded corners, active tab with bottom border
- Settings tabs collapse to hamburger menu on mobile (≤900px)
- Route badges on mobile: horizontal scroll instead of stacking

### i18n
- 8 new mirror-related translation keys (EN + DE)

---

## [1.4.0] — 2026-03-23

### New Features — Foundation
- **API Tokens** — Stateless token authentication for automation (CI/CD, Home Automation, scripts). Scoped permissions (full-access, read-only, per-resource). SHA-256 hash storage, `gc_` prefix, Bearer and X-API-Token header support
- **Migration History Table** — Versioned database migration system with auto-detection of legacy databases. 25 migrations tracked
- **Mobile Sidebar** — Responsive hamburger menu for phones/tablets (< 1024px) with slide-in animation, overlay, focus trap, ARIA

### New Features — Core Improvements
- **Peer Expiry** — Optional expiration date per peer (1d/7d/30d/90d/custom). Background task auto-disables expired peers every 60s. Visual indicators (expired/expires soon)
- **Peer Access Control (ACL)** — Restrict which WireGuard peers can access a route via Caddy `remote_ip` matcher. Multi-select checklist in route settings
- **Automatic Backups** — Scheduled backups (6h/12h/daily/3d/weekly) with retention limit. Run-now button, file list with download/delete in Settings
- **Log Export** — Download activity and access logs as CSV or JSON with filter support

### New Features — Advanced Routing
- **Gzip/Zstd Compression** — Per-route response compression via Caddy `encode` handler
- **Custom Request/Response Headers** — Key-value editor per route with CORS and Security header presets. New "Headers" tab in route edit modal
- **Per-Route Rate Limiting** — Configurable requests/window via `caddy-ratelimit` plugin (added to Dockerfile)
- **Retry with Backoff** — Automatic retries on backend failure via Caddy `load_balancing.retries`
- **Multiple Backends / Load Balancing** — Weighted round-robin across multiple backend targets per route
- **Sticky Sessions** — Cookie-based session affinity for multi-backend routes

### New Features — Observability & Management
- **Prometheus Metrics Export** — `/metrics` endpoint with 12 gauges (peers, routes, CPU, RAM, uptime, per-peer traffic, per-route monitoring). Token + query-param auth. Toggle in Settings
- **Circuit Breaker** — Per-route circuit breaker (closed/open/half-open). Returns 503 via Caddy when backends fail repeatedly. Auto-recovery via monitoring checks
- **Batch Operations** — Multi-select peers and routes for bulk enable/disable/delete with floating action bar
- **Peer Groups** — Organize peers by team/location with colored badges, filter dropdown, group management card. Backup v3

### Testing
- **API test script** expanded to 231 tests across 31 sections covering all features
- Tests cover: health, auth, dashboard, peers CRUD, routes CRUD, route auth, settings, SMTP, logs, WireGuard, Caddy, system, webhooks, tokens, backup, peer expiry, ACL, auto-backup, log export, compression, custom headers, rate limiting, retry, backends, sticky sessions, Prometheus, circuit breaker, batch operations, peer groups, error handling, security

### Improvements
- Docker: `caddy-ratelimit` plugin added to Caddy build, `/data/backups` directory
- Deploy: `SYS_MODULE` capability in docker-compose.yml, feature summary in setup.sh
- Rate limiting: 1000 req/15min for token-authenticated requests (vs 100 for unauthenticated)
- Backup format upgraded to version 3 (includes peer groups and ACL rules)

### Bug Fixes
- Fix token auth: use `req.originalUrl` to detect API routes
- Fix Caddy `load_balancing.selection_policy` format (object, not array)
- Fix Caddy retry config (inside `load_balancing` object, not top-level)
- Fix all route toggle switches (remove `data-managed`, deduplicate handlers)
- Fix ACL toggle with self-contained click handler
- Fix batch bar visibility in batch mode
- Fix backup test for version 3
- Remove browser confirm dialog on token revoke

---

## [1.3.0] — 2026-03-20

### New Features
- **Custom Branding for Route Auth** — Upload logo, set title, welcome text, accent/background color, and background image per route auth login page
- **IP Access Control / Geo-Blocking** — Per-route IP/CIDR whitelist or blacklist with optional country-based filtering via ip2location.io
- **Uptime Monitoring** — HTTP and TCP health checks per route with dashboard widget, configurable interval, and email alerts on route down/recovery
- **Email Alert System** — Event-based email notifications configurable per event group (Security, Peers, Routes, System) with backup reminders and CPU/RAM threshold alerts
- **Per-Peer Traffic Graphs** — Interactive traffic history charts (24h, 7d, 30d) with persistent upload/download totals per peer
- **Account Lockout** — Configurable lockout after N failed login attempts for admin and route-auth login with manual unlock via Settings
- **Password Complexity Enforcement** — Configurable rules for minimum length, uppercase letters, numbers, and special characters
- **API Versioning** — `/api/v1/` as primary mount with backward-compatible `/api/` alias
- **API Integration Tests** — 30+ tests with Supertest covering Auth, Peers, Routes, Dashboard, Settings, Webhooks, Logs, System, Health, and Backup endpoints
- **Field-Level Validation Errors** — Per-field error messages with red border and focus for peers and routes
- **Configurable Operational Timeouts** — 9 ENV vars for operational timeouts plus Settings UI for data retention and peer timeout
- **Favicon** — SVG + ICO favicon added

### Improvements
- Toggle endpoints changed from POST to PUT for REST correctness
- All frontend API calls migrated to `/api/v1/`
- Route edit modal restructured with tabs and wider layout
- DNS validation warning when creating/editing HTTP routes
- "Subdomains" renamed to "Domains" in navigation, titles, and labels
- Architecture diagram updated with Route Auth, SMTP, and Forward Auth

### Security
- 6 critical code review issues resolved (open redirect, IP allocation race condition, WireGuard iptables leak, showError/hideError fix, session secret validation, CSS class fix)
- 5 important security issues resolved (timing-safe CSRF/OTP comparison, rate limiter IP keying, SSRF DNS rebinding protection, route-auth CSRF domain binding)
- Node reverted to root user — WireGuard CLI requires root privileges; container provides isolation

### Bug Fixes
- 7 business logic issues resolved (backup includes route-auth, encryption key validation on restore, traffic rates with real time interval, traffic snapshots as deltas, Caddy reload uses syncToCaddy, WG config parser fix, atomic OTP verification)
- 4 Docker/Ops issues resolved (Caddy fetch timeout, atomic WG config writes, encryption key startup validation, health check verifies DB + WireGuard, shutdown stops session cleanup)
- 8 Frontend/UX issues resolved (i18n in JS, toggle/delete error visibility, German labels replaced with i18n, JSON parse error handling, label for-attributes, toggle ARIA/keyboard, CSS variables corrected, btn-secondary defined)
- Monitoring HTTP check now accepts self-signed certificates
- Route-auth CSRF tokens use pipe separator instead of dots

---

## [1.2.0] — 2026-03-18

### New Features
- **Route Authentication System** — Custom login page per route with multiple auth methods: Email & Password, Email & Code (OTP via SMTP), TOTP (Authenticator App). Optional Two-Factor Authentication (2FA) with configurable session duration
- **SMTP Configuration** — Built-in SMTP settings for sending email verification codes, configurable via Settings UI with test email functionality
- **Caddy Config Page** — View live Caddy reverse proxy JSON configuration with syntax highlighting and JSON export
- Route auth config integrated into both route create form and edit modal
- Auth method, 2FA, and session duration badges displayed on route list

### Improvements
- Security hardening: 13 issues addressed from security review
- Duplicated code consolidated and simplified across codebase
- Host networking fix for QUIC and L4 port issues

### Bug Fixes
- Forward auth uses Caddy pattern (GET rewrite + vars) to preserve request body
- CSRF protection replaced with HMAC-signed tokens for route auth (no cookie needed)
- Forward auth correctly proxies to backend on 2xx instead of returning 'OK'
- Static assets (CSS, JS) bypass forward auth on route-auth domains
- Caddy config syncs after route auth create/update/delete
- Email input CSS, sticky modal header/footer, 2FA toggle double-click fix

---

## [1.1.0] — 2026-03-16

### New Features
- **Layer 4 TCP/UDP Proxy** — Raw TCP and UDP port forwarding via caddy-l4 plugin. Three TLS modes (None, Passthrough, Terminate), port ranges, TLS-SNI routing, blocked port protection
- **Custom Caddy Build** — Caddy built with caddy-l4 plugin for Layer 4 routing support
- **Host Networking** — `network_mode: host` for dynamic L4 port binding without container restart

### Improvements
- **Multi-Stage Docker Build** — Native dependencies compiled in builder stage (420MB → 402MB)
- **Graceful Shutdown** — HTTP server closed cleanly, running requests finish, 10s timeout
- **Composite Database Indexes** — 4 composite indexes for activity_log, peers, and routes
- **Standardized API Response Format** — `ok` field added to all endpoints
- Caddy config validation in entrypoint with warning on errors
- Copy-to-clipboard button for WireGuard config
- Setup script updated for host networking, auto iptables, port conflict check
- API rate limiter no longer blocks authenticated users

### Bug Fixes
- WireGuard FORWARD rules inserted before Docker rules (`-I` instead of `-A`)
- RELATED/ESTABLISHED FORWARD rule and subnet-scoped MASQUERADE for WireGuard NAT
- Caddy admin API Origin header compatibility (v2.11+ requirement)
- L4 proxy dial format corrected (array of strings)
- HTTP-only badges hidden for L4 routes

---

## [1.0.3] — 2026-03-14

### Improvements
- Profile dropdown with separate profile page and logout button
- Retry-After header added to rate limiting responses
- CSRF token rotation after sensitive actions (password change, restore)
- Button loading states for all async operations
- Duplicate `formatBytes()` removed from logs.js

### Bug Fixes
- Nunjucks template error in topbar dropdown fixed
- Auto-sync package.json version from release tag

---

## [1.0.2] — 2026-03-13

### Improvements
- Modal focus trap and centralized modal handling
- Error responses sanitized with i18n for all API error messages

### Bug Fixes
- Modal no longer closes on overlay click (prevents accidental data loss)
- Release workflow: delete existing assets before upload

---

## [1.0.1] — 2026-03-11

### Initial Release

First public release of GateControl — Unified WireGuard VPN + Caddy Reverse Proxy Management.

#### Core Features
- **WireGuard VPN Peer Management** — Create, edit, enable/disable, delete peers with automatic key generation, IP allocation, QR codes, and hot-reload via `wg syncconf`
- **Caddy Reverse Proxy Routing** — Domain-based routing with automatic HTTPS via Let's Encrypt, optional Basic Auth, backend HTTPS support, peer-linked routes
- **Dashboard** — Connected peers, active routes, traffic charts (1h, 24h, 7d), CPU/RAM/uptime, average latency
- **Backup & Restore** — Full system backup as portable JSON with atomic transaction-based restore
- **Activity & Access Logs** — Full activity log with severity levels and filtering, Caddy access log with rotation
- **Webhooks** — Event-driven notifications with SSRF protection
- **Internationalization** — Full English and German language support (400+ keys)

#### Security
- AES-256-GCM encryption at rest for sensitive data
- Session-based auth with Argon2 password hashing
- CSRF protection, rate limiting, Helmet.js security headers, CSP nonces
- Webhook SSRF protection blocking private/internal IP ranges

#### Infrastructure
- Single Docker container orchestrating Node.js, WireGuard, and Caddy via Supervisord
- Interactive setup script supporting Ubuntu, Debian, Fedora, CentOS, RHEL, Rocky, Alma, Alpine
- Online (GHCR) and offline (tar.gz) installation options
- Docker health check endpoint (`/health`)
- GitHub Actions CI/CD with automatic GHCR publishing
