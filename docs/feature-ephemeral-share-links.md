# Ephemeral Share Links

Time-limited (and optionally one-time) links that grant a **guest** access to a single proxied
HTTP route — **no VPN, no account, no login**. The 32-byte token in the URL *is* the credential:
the guest clicks the link and is in. Pro-tier feature (`share_links`).

Design + devil's-advocate decisions: `docs/superpowers/specs/2026-05-25-ephemeral-share-links-design.md`.
Implementation plan: `docs/superpowers/plans/2026-05-25-ephemeral-share-links.md`.

## Model — "the link is the protection"

- Share links can be created on **any** enabled HTTP route.
- Creating the **first** link on a route with no existing auth makes it **share-gated**: from then
  on, **anyone** reaching it by its domain — public internet, the VPN, or the client services
  portal — needs a valid share link. The only bypass is reaching the upstream service **directly at
  its LAN IP:port** (not via the route's domain). The admin confirms this explicitly before the
  route is gated (the public is locked out).
- A route that already has route-auth (email / OTP / TOTP) keeps it for normal users; a share link
  is an additional **guest bypass** that needs no login.
- Guest experience: open `https://<route-domain>/route-auth/share/<token>` → redirected to `/`,
  access granted. No form, no credentials.

## How it works (reuses route-auth)

The route-auth system already gates routes via a Caddy `forward_auth` subrequest to
`GET /route-auth/verify`, which checks the `gc.route.sid` cookie against `route_auth_sessions`
(scoped to the route id). Share links plug into this with no new gating mechanism:

- **Share-gating:** the first link on an unprotected route inserts a `route_auth` row with
  `auth_type = 'share'`. That flips `getAuthForRoute()` to non-null → `needsForwardAuth` true →
  forward_auth is wired on the next Caddy config regeneration (one reload when sharing is first
  enabled; turning it off triggers one more). Creating/revoking individual links on an
  already-gated route is **DB-only** — no Caddy churn.
- **Redeem:** `GET /route-auth/share/:token` is served by the existing Caddy `/route-auth/*` sibling
  proxy, which is placed *first* in the route's handler list, so the redeem **bypasses**
  forward_auth and works even when the route is gated. It validates the token (sha256 lookup),
  atomically bumps `redeemed_count`, and creates a guest `route_auth_session` (`email='share'`,
  `share_link_id`, `expires_at = link.expires_at`), sets the `gc.route.sid` cookie, and 302s to `/`.
- **Verify:** `verify()` already accepts any valid non-pending session for the route id, so a guest
  share session passes with no special-casing. A `'share'` route with no valid session → 401 →
  Caddy redirects to the login page, which renders a minimal **"invitation required"** view (no
  form) for `auth_type='share'`.

## Data model (migration v45)

`route_auth_share_links`:

| column | meaning |
|---|---|
| `id` | PK |
| `route_id` | FK → routes (ON DELETE CASCADE) |
| `token_hash` | sha256(token), UNIQUE — plaintext is **never** stored |
| `label` | optional admin note |
| `created_by_user_id` | FK → users (ON DELETE SET NULL) |
| `one_time` | 0/1 — single redemption if 1 |
| `expires_at` | hard expiry (ISO) |
| `redeemed_count`, `last_redeemed_at`, `last_redeemed_ip` | redemption telemetry |
| `revoked_at` | set on revoke |
| `created_at` | — |

Plus `route_auth_sessions.share_link_id` (nullable, FK → share_links ON DELETE SET NULL) ties a
guest session to its link so revoke can kill it.

A link is **valid** iff `revoked_at IS NULL AND expires_at > now AND (one_time = 0 OR redeemed_count = 0)`.

## Admin API (session + CSRF; `requireFeature('share_links')`)

Mounted at `/api/v1/routes/:id/share-links`:

- `POST /` — body `{ expiresInHours, oneTime, label?, confirmGate? }`. Rejects L4 routes
  (`l4_not_supported`) and basic-auth routes (`disable_basic_auth`, 409 — incompatible: forward_auth
  never wires when basic-auth is on). On a route with no existing auth, requires `confirmGate: true`
  (else 409 `needs_gate_confirm`) then idempotently share-gates it (`ensureShareGate`) and triggers
  one Caddy regen. Returns the full URL **once**: `{ ok, url, expires_at }`.
- `GET /` — list active (non-revoked, non-expired) links. **Never returns the token.**
- `DELETE /:linkId` — revoke (sets `revoked_at`, deletes the link's guest sessions).
- `POST /disable` — turn sharing off: deletes all the route's share links + guest sessions; if the
  route's auth is the `'share'` type, also removes the gate row and regenerates Caddy. Never touches
  a real (email/OTP/TOTP) route_auth row.

## UI

In the route edit modal's Auth section (hidden without `license.features.share_links`): create a
link (expiry 1 h / 24 h / 7 d + one-time toggle + optional label), with a **loud confirm** the first
time on an unprotected route ("⚠ this route is currently public; a share link makes it reachable
only via share links — everyone reaching it by its domain, incl. over VPN, is locked out"). The
generated URL is shown **once** with a copy button and a warning. A list of active links shows
label, expiry, one-time/reusable, redeemed count, and a Revoke button. When a route is share-managed
(`auth_type='share'`), the email/OTP/TOTP selector is replaced by a read-only "Managed by share
links" note.

## Security

- Token: `crypto.randomBytes(32)` base64url; stored **sha256-hashed**; shown once.
- Redeem is **atomic** (better-sqlite3 transaction) — a one-time link cannot be double-redeemed
  under a race.
- Guest session lifetime = the link's expiry (no extra cap — capping caused one-time-link lockouts
  on cookie loss and re-click friction; the link is valid until expiry anyway, and revoke deletes
  sessions immediately).
- Guest cookie is host-only (`Path=/`, no `Domain`), `HttpOnly`, `SameSite=Strict`; the redeem
  response sets `Referrer-Policy: no-referrer` and 302s to `/`, so the token isn't the landed URL
  and doesn't leak via Referer.
- The token rides in the URL path, so it is **redacted in the Caddy access log** via a `filter` log
  encoder (`/route-auth/share/<token>` → `/route-auth/share/REDACTED`). The Node side has no
  request-path logger.
- Credential endpoints (`POST /route-auth/login`, `/send-code`, `/verify-code`) reject
  `auth_type='share'` early (404) — share routes have no password/OTP/TOTP flow, only token redeem.
- Admin endpoints: session + CSRF + the `share_links` feature gate. Enforcement is **row-driven**
  (verify / forward_auth), never behind a license flag — only *creation* is gated, so a share gate
  can't be bypassed by toggling licensing.
- Expired/revoked links and their guest sessions are purged by the route-auth 15-minute cleanup
  (sessions first, then links).

## Limitations / out of scope

- Share links target **browser-reachable** routes: forward_auth answers an unauthenticated request
  with a 302 to an HTML page, so non-browser/API/webhook clients receive HTML, not their resource.
- No per-link path scoping (a link grants the whole route), no email-bound links, no L4/TCP support.
- A share-gated route still appears in the client services portal with `hasAuth: true` and its
  domain URL; clicking it lands on the gated domain (fail-closed — the user needs a link).
