# Ephemeral Share Links — Design

**Date:** 2026-05-25
**Status:** Approved (design) — pending spec review → plan → implementation
**Roadmap:** #3 (last roadmap item)
**Repo:** server (`/root/gatecontrol`)
**Tier:** Pro (new `share_links` feature flag)

## Goal

Let an admin generate a time-limited (and optionally one-time) link that grants a **guest** access
to a single proxied route — **no VPN, no account, no login**. The token in the URL *is* the
credential: the guest clicks the link and is in. Model: **"the link is the protection."**

## Model ("link = protection")

- Share links can be created on **any** enabled HTTP route.
- Creating the **first** share link on a route makes it **share-gated**: at its public domain the
  route is reachable only with a valid share link (the admin reaches the upstream directly via
  VPN/LAN, or via their own link). This reuses the existing route-auth forward-auth plumbing.
- A route that already has route-auth (email/OTP/TOTP) keeps it for normal users; a share link is
  an additional **guest bypass** that needs no login.
- Guest experience: open `https://<route-domain>/route-auth/share/<token>` → redirected to `/`,
  access granted. No form, no credentials.

## Architecture (reuse route-auth)

The route-auth system already gates routes via Caddy `forward_auth` → `GET /route-auth/verify`
(checks the `gc.route.sid` cookie against `route_auth_sessions`, scoped to `route_id`); on failure
Caddy redirects to `/route-auth/login`. Reference: `src/routes/routeAuth.js`,
`src/services/caddyAuthSubroute.js`, `src/services/caddyConfig.js`.

### Share-gating via `auth_type = 'share'`

- When the first share link is created on a route that has **no** `route_auth` row, insert a
  `route_auth` row with `auth_type = 'share'` (no email/password/TOTP). This flips
  `getAuthForRoute(routeId)` to non-null → `needsForwardAuth` true → `forward_auth` is wired for
  the route on the **next Caddy config regeneration** (one reload when sharing is first enabled).
- `verify()` changes (`src/routes/routeAuth.js`):
  - It already accepts a valid non-pending `route_auth_session`. **Guest share sessions are normal
    `route_auth_sessions`** (with `share_link_id` set), so a valid guest session passes for ANY
    `auth_type` — i.e. a share link works both on `'share'` routes and as a bypass on
    `email_*`/`totp` routes, with no special-casing in the happy path.
  - New: when `auth_type === 'share'` and there is **no** valid session, return **401** but Caddy
    should land the guest on a friendly **"invitation required"** page, not the email/OTP login
    form. Done by making the `/route-auth/login` page detect `auth_type === 'share'` and render a
    minimal "this link is invalid or expired — ask the owner for a new one" view (no form).
- **Fail-closed:** a `'share'` route with zero valid links/sessions denies all guests at the domain
  (only the admin via VPN/LAN). Revoking the last link does **not** auto-unprotect; the admin turns
  sharing off explicitly (which deletes the `'share'` `route_auth` row + triggers one Caddy reload).
- **Redeem URL reachability (verified):** the Caddy sibling proxy that routes `/route-auth/*` to the
  server (`buildRouteAuthProxy`, matches `path: ['/route-auth/*']`, placed **first** in the route's
  list — see `caddyAuthSubroute.js` / `caddyConfig.js:458`) is added exactly when a route gains
  forward_auth. Creating the first link inserts the `'share'` row and regenerates Caddy **before**
  returning the URL to the admin, so by the time the guest has the link the route is gated AND the
  sibling proxy exists. `/route-auth/share/:token` is matched by the sibling and bypasses
  forward_auth, so the redeem works even with no session. No chicken-and-egg.
- **Basic-auth incompatibility (verified):** `caddyConfig.js:449` forces `routeAuthConfig = null`
  when `route.basic_auth_enabled`, so forward_auth never wires and `verify()` never runs on a
  basic-auth route — a share link there would be silently inert. Therefore the create endpoint
  **rejects** share-link creation on a basic-auth route with a clear error ("disable Basic Auth to
  use share links"); we do **not** silently strip the admin's basic auth.

### Caddy churn is bounded

- Enabling sharing on a previously-unprotected route → 1 Caddy regen+reload (adds forward_auth).
- Turning sharing off → 1 Caddy regen+reload (removes it).
- Creating/revoking individual links on an already-gated route → **DB only, no Caddy change**.
- Routes that already had route-auth → **no Caddy change at all** (forward_auth already on).

## Data model

New table (migration; mirror the `route_auth_otp` / pairing-code patterns — hash-only, atomic):
```sql
CREATE TABLE route_auth_share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,            -- sha256(token); plaintext never stored
  label TEXT,                                 -- optional admin note
  created_by_user_id INTEGER,
  one_time INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,                   -- ISO; hard expiry
  redeemed_count INTEGER NOT NULL DEFAULT 0,
  last_redeemed_at TEXT,
  last_redeemed_ip TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_share_links_token ON route_auth_share_links(token_hash);
CREATE INDEX idx_share_links_route ON route_auth_share_links(route_id);
```
Plus `ALTER TABLE route_auth_sessions ADD COLUMN share_link_id INTEGER;` (nullable; ties a guest
session to the link that created it, so revoke can kill it).

A link is **valid** iff `revoked_at IS NULL AND expires_at > now AND (one_time = 0 OR redeemed_count = 0)`.

## Guest redeem flow

`GET /route-auth/share/:token` (public; served via the existing Caddy `/route-auth/*` sibling
proxy on the route domain — **no Caddy change**; rate-limited):
1. `hash = sha256(token)`; look up the link by `token_hash`.
2. Validate (exists, not revoked, not expired, and if `one_time` then `redeemed_count = 0`). On any
   failure → render the generic **"link invalid/expired"** page (200, no enumeration signal; never
   reveal whether the token existed). 
3. Atomically (transaction): re-check validity, `redeemed_count += 1`, set `last_redeemed_at/ip`;
   create a `route_auth_session` with `route_id = link.route_id`, `email = 'share'`,
   `share_link_id = link.id`, `two_factor_pending = 0`, `expires_at = link.expires_at`. **No
   separate session cap** (DA #1): the link is valid until its expiry anyway, so a shorter session
   only adds friction (daily re-click for reusable links) and, for one-time links, a hard lockout if
   the cookie drops (the link can't be re-redeemed). Session = link lifetime; `revoke` deletes the
   session immediately, so this adds no exposure window.
4. Set the `gc.route.sid` cookie (same attributes as the normal route-auth login: httpOnly, secure,
   sameSite, scoped to the route domain) and 302 → `/`.

The existing `verify()` then passes the guest through on subsequent requests.

## Admin API (session + CSRF; `requireFeature('share_links')`)

Mounted under the routes API (mirror `src/routes/api/routeAuth.js`):
- `POST /api/routes/:id/share-links` — body `{ expiresInHours, oneTime, label?, confirmGate? }`.
  Validates the route exists + is an enabled HTTP route + is **not** basic-auth (else 409 "disable
  Basic Auth"). If the route has **no** `route_auth` row, this call would make a public route
  link-only → require `confirmGate: true` (else 409 `needs_gate_confirm` so the UI can show the
  warning); then `ensureShareGate(routeId)` idempotently inserts the `auth_type='share'` row
  (`INSERT … ON CONFLICT(route_id) DO NOTHING`, which also clears `basic_auth_enabled`) and flags
  Caddy regen. If the route already has any `route_auth` row (email/otp/totp/share), just add the
  link — no confirm, no new row, no Caddy regen. Generate a 32-byte token (base64url), store its
  sha256, insert the link. **Return the full URL once** (`https://<domain>/route-auth/share/<token>`).
  Activity-log. Trigger Caddy regen **only** if sharing was just enabled.
- `GET /api/routes/:id/share-links` — list active (non-revoked, non-expired) links: id, label,
  one_time, expires_at, redeemed_count, last_redeemed_at. Never returns the token.
- `DELETE /api/routes/:id/share-links/:linkId` — set `revoked_at`, delete `route_auth_sessions`
  with that `share_link_id`. Activity-log.
- `POST /api/routes/:id/sharing/disable` (or DELETE) — turn sharing off: delete all the route's
  share links + the `auth_type='share'` `route_auth` row (only if it's `'share'`, never an
  email/OTP row) + its share sessions → Caddy regen. (Routes with real route-auth: this only
  removes share links, leaves the route-auth intact, no Caddy change.)

## UI

In the route edit modal, a **"Teilen / Share links"** subsection (Pro-gated, hidden without
`license.features.share_links`):
- "Create share link" → expiry select (1h / 24h / 7d) + "one-time" checkbox + optional label →
  shows the generated URL **once** with a copy button + a clear warning ("anyone with this link
  gets in — keep the expiry short / use one-time").
- A list of active links: label, expiry countdown, one-time/reusable, redeemed count, **Revoke**.
- **Loud confirm** when creating the first link on an unprotected route (DA #2): a warning dialog
  "⚠ this route is currently public; a share link makes it reachable **only** via share links —
  everyone else is locked out (you reach the service directly via VPN/LAN)" → sends `confirmGate:true`.
- If the route is currently share-only (`auth_type='share'`) with no active links: a "share-only,
  no active links — closed to guests" hint + a "turn sharing off" action.
- **Route-auth section coexistence (DA #3):** when `auth_type='share'`, the existing email/OTP/TOTP
  route-auth selector renders a read-only "managed by share links" state instead of garbage; the
  routes-list auth badge shows a localized "Share link" label for `'share'`.

## Security

- Token: `crypto.randomBytes(32)` base64url; stored **sha256-hashed**; shown once.
- Redeem is **atomic** (transaction) — one-time can't be double-redeemed under a race.
- Generic invalid/expired page — **no token enumeration** (don't reveal existence; constant-ish response).
- Rate-limit `GET /route-auth/share/:token` (reuse the route-auth limiter).
- Guest sessions are bounded by the link expiry (+ a hard cap); revoke deletes them immediately.
- Admin endpoints: session + CSRF + `share_links` feature gate.
- Hard expiry + periodic cleanup (extend the existing route-auth 15-min cleanup to purge expired
  links + their sessions).
- The token rides in the URL (history/referrer): mitigated by short expiry + one-time; the redeem
  immediately 302s to `/` so the token isn't the landed URL. Set `Referrer-Policy: no-referrer` on
  the redeem response.

## Edge cases

- Route deleted → cascade deletes links (FK ON DELETE CASCADE) + sessions.
- Disabling a route → its share links stop working (verify denies; the route isn't served).
- Creating a share link on a route that already has email/OTP route-auth → no `'share'` row, no
  Caddy change; the link is purely a guest bypass.
- L4 routes (non-HTTP) → share links not offered (forward-auth is HTTP-only); the API rejects them.
- Basic-auth routes → share links rejected (incompatible; see Architecture). The UI hides/​disables
  the share subsection with a hint when the route uses basic auth.
- Clock: expiry compared in the DB (`datetime('now')`) consistently, like route_auth_otp.
- `createOrUpdateAuth({auth_type:'share'})` logs a `route_auth_updated` activity entry — acceptable,
  but the share-gating call should pass a label so the audit trail reads as "share enabled", not a
  generic auth change.

## Tier / i18n / Tests

- `share_links: false` in `COMMUNITY_FALLBACK`; `requireFeature('share_links')` on the admin
  endpoints; template lock (UI hidden) — per the new-feature licensing convention.
- i18n (en+de) for the UI strings + the guest invalid/expired page + GC.t for client strings.
- Tests:
  - Service: token create (hash stored, plaintext returned once), validity predicate, atomic
    one-time redeem (double-redeem second call fails), revoke deletes sessions, share-gating
    create/remove the `'share'` route_auth row.
  - Redeem endpoint: valid → 302 + cookie + session row; expired/used/revoked → generic page, no
    session; one-time second hit → generic page.
  - Admin endpoints: 200 create returns URL once; list never leaks token; 404 unknown/L4 route;
    403 without `share_links`; revoke.
  - `verify()`: guest share session passes; `auth_type='share'` with no session → 401; expired
    guest session → 401.
  - Caddy: `needsForwardAuth` true for a `'share'` route (so forward_auth gets wired).
  - Session expiry = link expiry (no cap); redeeming a one-time link yields a session lasting until
    the link's expiry (DA #1).
  - Create on a public (no-auth) route without `confirmGate` → 409 `needs_gate_confirm`; with it →
    gated + Caddy regen flagged (DA #2). Create on a basic-auth route → 409.
  - `ensureShareGate` idempotent: two calls leave exactly one `route_auth` row, no throw (DA #4).
  - Redeem path doesn't log the raw token (DA #5).
  - i18n parity.

## Devil's-advocate decisions (folded in)

1. **No session cap** — guest session expiry = link expiry (see redeem step 3). Prevents one-time
   lockout on cookie loss and daily re-click friction for reusable links.
2. **Loud confirm before share-gating a public route** — the create flow, when the route has **no**
   `route_auth` row, requires an explicit confirm: "⚠ this route is currently public; a share link
   makes it reachable **only** via share links — everyone else is locked out." No silent conversion.
   (Routes that already have auth, or are already share-gated, skip the warning.)
3. **`auth_type='share'` handled in existing route-auth UI/API** — the route-auth admin section must
   detect `'share'` and render a read-only "managed by share links" state (hide the email/OTP/TOTP
   selector), and the routes-list auth badge needs a `'share'` label (i18n). The legacy route-auth
   config endpoint's `validAuthTypes` whitelist stays unchanged (admins don't pick `'share'` there);
   `'share'` rows are only created via the share-link service. Guard: saving the legacy route-auth
   form on a `'share'` route is either disabled in the UI or, if it happens, converts to the chosen
   real auth type (acceptable — share sessions/links keep working since `verify()` accepts any valid
   session and redeem is auth-type-agnostic).
4. **Idempotent share-gating** — `ensureShareGate(routeId)` uses `INSERT … ON CONFLICT(route_id) DO
   NOTHING` (or catches the UNIQUE violation and treats the route as already gated) so a
   double-click / concurrent first-link create can't 500. `route_auth.route_id` is `UNIQUE`.
5. **Token not logged** — redact/exclude `:token` from the Caddy access log and the Node request
   logger for `/route-auth/share/*` (the redeem also 302s to `/` with `Referrer-Policy: no-referrer`).
6. **Enforcement is row-driven, never license-gated** — `verify()` / `needsForwardAuth` must NOT
   gain a `route_auth`-flag check; only share-link **creation** is gated by `share_links`. A `'share'`
   gate must not be bypassable by toggling the `route_auth` license flag.

## Out of scope / future

- Binding a link to a specific email / sending it via email (the link is the credential).
- Per-link path scoping (a link grants the whole route).
- Share links for L4/TCP routes.

## File structure

- `src/db/migrationList.js` — migration: `route_auth_share_links` + `route_auth_sessions.share_link_id`.
- `src/services/shareLinks.js` (new) — create/list/revoke/redeem/validity + `ensureShareGate` +
  `disableSharing` helpers. Separate module (route-auth service is already large); it requires the
  route-auth service only for `createSession`/session deletion helpers.
- `src/routes/routeAuth.js` — `GET /route-auth/share/:token` + the share-only login-page branch +
  `verify()` already passing guest sessions.
- `src/routes/api/routes.js` (or a new `src/routes/api/shareLinks.js`) — the 3–4 admin endpoints.
- `src/services/caddyConfig.js` — `needsForwardAuth` already keys off `getAuthForRoute`, which now
  returns the `'share'` config; confirm no change needed beyond that.
- `public/js/routes.js` + `templates/{default,pro}/pages/routes.njk` + `.../partials/modals/route-edit.njk`
  — the share subsection, the first-link confirm dialog, the `auth_type='share'` read-only state in
  the route-auth section, and the `'share'` auth badge label.
- `src/routes/routeAuth.js` cleanup (`runCleanup`) + `src/services/routeAuth.js` — purge expired/
  revoked share links (sessions already purged by `expires_at`).
- `templates/{default,pro}/pages/route-auth-login.njk` — the `authType==='share'` "invitation
  required / link invalid or expired" branch (no form).
- `src/services/license.js` — `share_links` flag.
- `src/i18n/{en,de}.json` + both `layout.njk` — i18n + GC.t.
- `docs/feature-ephemeral-share-links.md` — writeup.
- Tests: `tests/share_links.test.js`, `tests/share_link_redeem.test.js`.
