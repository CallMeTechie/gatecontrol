# Open routes from the apps (optional automatic login)

The GateControl apps list the routes a device may see (`GET /api/v1/client/services`) and open
them natively. For a route with route-auth the admin can opt in per route to
**"Anmeldung aus den GateControl-Apps erlauben"** (`route_auth.app_login`, default off): the app
then opens the route with a one-time link that sets the route-auth session cookie — no login page,
and no second factor.

The trust decision is the admin's: whoever may see the route in the app (route visibility
`routes.user_ids`, token scopes, machine binding) gets in without credentials. Basic-auth routes
have no `route_auth` row and therefore never get an automatic login.

## Admin

- Route editor → Zugangsschutz → Route-Auth: toggle "Anmeldung aus den GateControl-Apps erlauben"
  (hint: "Geräte, die diese Route sehen dürfen, öffnen sie in der App ohne Login-Seite (auch ohne
  zweiten Faktor).").
- `POST /api/v1/routes/:id/auth` accepts `app_login` (boolean-ish; omitted = keep the stored
  value); `GET`/`POST` return `app_login` as a boolean.
- Backups carry `app_login` with the route-auth config.
- Migrations: **95** `route_auth.app_login INTEGER NOT NULL DEFAULT 0`, **96** table
  `route_app_tickets`.

## Client API

### `GET /api/v1/client/services` (scope `client:services`)

Additional fields per service; the existing ones (`id`, `name`, `domain`, `url`, `hasAuth`,
`tls`) are unchanged.

```json
{
  "ok": true,
  "services": [
    {
      "id": 12, "name": "nas.example.com", "domain": "nas.example.com",
      "url": "https://nas.example.com", "hasAuth": false, "tls": "auto",
      "status": "up",
      "auth": "route",
      "appLogin": true
    }
  ]
}
```

| Field | Values |
|---|---|
| `status` | `"up"` / `"down"` from uptime monitoring; `null` when monitoring is off or has no verdict |
| `auth` | `"basic"` (Basic Auth, wins like in the Caddy config), `"route"` (a `route_auth` row of any type, incl. share-gated), `"none"` |
| `appLogin` | `true` only for `auth: "route"` with `app_login = 1` |

### `POST /api/v1/client/services/:id/open`

Token only (a browser session gets 403), the token needs `client:services` (path scope) and
`client` (or `full-access`), machine binding is enforced, 30 requests per minute and device.
`Cache-Control: no-store`.

| Answer | When |
|---|---|
| `200 { "ok": true, "url": "https://<domain>/route-auth/app/<ticket>", "autoLogin": true, "expiresIn": 60 }` | route-auth with `app_login = 1` |
| `200 { "ok": true, "url": "https://<domain>", "autoLogin": false }` | anything else |
| `404 { "ok": false, "error": "not_found" }` | unknown id, disabled, not http, or not visible to the token's owner (same rule as the services list) |
| `403` | no token / scope / machine binding |
| `429 { "ok": false, "error": "rate_limited" }` | |

The app opens `url` in the browser / a WebView right away (the ticket lives 60 s and works once).
On any non-2xx it falls back to the plain `https://<domain>`.

### `GET /route-auth/app/:ticket` (on the route's own domain)

Served by the Caddy `/route-auth/*` sibling proxy that every route-auth route has, so it bypasses
forward_auth and the cookie lands on the route's domain. Consumes the ticket atomically and
re-checks: route still enabled, still visible to the ticket's owner, no Basic Auth, `route_auth`
row with `app_login = 1`, device token not revoked, and the request host (`X-Forwarded-Host` /
`Host`) equals the route's domain. Then it creates a full route-auth session
(`email = "app:user:<id>"` or `"app:token:<id>"`, lifetime = the route's session duration), sets
`gc.route.sid` and redirects to `/`; activity entry `route_app_login` (ids only).
Every failure shows the same generic "link invalid" page as share links. `Referrer-Policy:
no-referrer`, 60 redeems per 15 minutes and IP.

## Tickets

`services/routeAppTickets.js`, modelled on the portal login tickets: 32 random bytes base64url,
only the SHA-256 is stored, 60 s TTL, single use (`UPDATE … WHERE used_at IS NULL AND expires_at >
now`), expired rows are removed on create. Neither the ticket nor the URL is logged; the Caddy
access log redacts `/route-auth/app/<ticket>`.
