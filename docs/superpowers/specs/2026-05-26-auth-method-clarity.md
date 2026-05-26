# Auth-Method Clarity + Share Error Messages — Design & Plan

**Date:** 2026-05-26 · **Repo:** server (`/root/gatecontrol`) · **Branch:** `fix/auth-method-clarity`

## Problem

A route can carry **two auth truths at once**: `routes.basic_auth_enabled` AND a `route_auth` row.
Caddy resolves this with a precedence (`caddyConfig.js:449`: when `basic_auth_enabled`, route-auth is
forced `null` → **Basic Auth wins, route-auth ignored**). But the UI doesn't reflect that precedence,
producing three concrete bugs + one UX gap:

1. **Save** (`public/js/routes.js:1737`): switching auth to *Basic* enables basic_auth but never
   deletes an existing `route_auth` row → both persist (how `speedport.domaincaster.com` ended up
   with Basic + a dead `email_password` row).
2. **Load** (`public/js/routes.js:1249`): if *any* `route_auth` row exists, the edit toggle is set to
   *Route-Auth* — even when Basic Auth is the method Caddy actually enforces → misleading.
3. **List badge** (`public/js/routes.js:244`): when both exist, *both* badges render → ambiguous.
4. **Share errors**: the client shows raw API codes (`disable_basic_auth`, `l4_not_supported`,
   `invalid_expiry`) instead of human text.

## Single source of truth — "effective active method"

Mirror Caddy's precedence exactly:
```
basic_auth_enabled        -> 'basic'
else route_auth row exists -> route_auth.auth_type   (route / share)
else                       -> 'none'
```
Everything (green tab, selected tab on load, list badge) derives from this.

## Decisions (confirmed with user)

- **Green = the active state's tab**, always exactly one: no-auth → **Keine** green, Basic → **Basic
  Auth** green, Route-Auth → **Route-Auth** green. **Blue** = currently-visited tab (only when it
  differs from the active one). **Grey** = inactive. Visiting the active tab keeps it **green** (green
  wins over blue).
- **Mutual exclusivity**: a route has exactly one active method. Enforced **server-side**: enabling
  Basic Auth via `PUT /:id` removes any `route_auth` row (symmetric to `createOrUpdateAuth`, which
  already clears `basic_auth_enabled` when route-auth is set).
- **Legacy data** (routes that already have both, e.g. speedport): **non-destructive** — the load-fix
  shows the truth immediately (Basic = green/active); the dead `route_auth` row is removed on the
  next save (the server enforcement above). No bulk migration.
- **Scope**: the green tab lives in the **route-edit dialog**. The route **list** badge is corrected
  to show only the effective-active method (no green tint there). Create form unchanged.

## Changes

### Server
- `src/routes/api/routes.js` `PUT /:id` (line ~419): when the update sets `basic_auth_enabled` truthy,
  delete the route's `route_auth` row + its sessions (use `routeAuth.deleteAuth(id)` or a direct
  delete). This makes Basic ⊻ Route-Auth mutually exclusive at the API, independent of the client,
  and reconciles legacy rows on the next save.

### Client (`public/js/routes.js`)
- **Load** (`showEditModal`, ~1247-1286): compute `activeMethod` from the effective-active rule
  (Basic wins). Set the auth-type toggle's selected value to `activeMethod`. Still populate the
  route-auth fields from `/auth` data if present (so switching to Route-Auth shows prior values), but
  do **not** let a dead route_auth row select the Route tab when Basic is active.
- **Green indicator**: a new class `method-active` applied to the `#edit-auth-type-group` button whose
  `data-value === activeMethod` (incl. `'none'`). Reset (remove from all three) at modal open, then
  set once. It is **independent** of `.on` (the blue selected/visited class managed by the toggle
  click handler) — so when the user clicks a different tab, `.on` (blue) moves but `.method-active`
  (green) stays on the persisted active method.
- **List badge** (~244): render only the effective-active method — if `basic_auth_enabled`, show the
  Basic Auth badge and **suppress** the route-auth method badge (guard `route_auth_enabled &&
  !basic_auth_enabled`).
- **Share create errors**: map `data.error` codes → localized text via `shareT(...)`; fallback to the
  raw error for unknown codes.

### CSS (`public/css/app.css` + `public/css/pro.css`)
- `#edit-auth-type-group .toggle-btn.method-active { background: var(--green); color: <inverse/white>; }`
  Scoped to the auth-type group via the `#id` selector so its specificity beats `.toggle-btn.on`
  (green wins when a button is both active and visited), and so other toggle-groups stay blue.

### i18n (`src/i18n/{en,de}.json` + both `layout.njk` GC.t)
- Flat keys: `route_auth.share_err_basic_auth`, `route_auth.share_err_l4`,
  `route_auth.share_err_expiry`. Whitelist the three in `GC.t` (both themes).

## Tasks (TDD where server-testable; client = eslint + manual)

- **T1 — Server mutual exclusivity.** Test (`tests/route_basic_auth_exclusive.test.js`): create a
  route with a `route_auth` row, `PUT /:id` with `basic_auth_enabled:true` → route_auth row gone +
  basic enabled. Then implement in `routes.js` PUT.
- **T2 — i18n + GC.t.** Test (`tests/auth_clarity_i18n.test.js`): the 3 share-error keys exist in
  en+de (`k in en`). Add flat keys + whitelist. Run `i18n_update_keys.test.js` for parity.
- **T3 — Client load + green active tab.** `showEditModal` effective-active select + `method-active`
  green class (reset-then-set on open) + CSS in both themes. Verify: `node --check`, eslint, and the
  `#edit-auth-type-group .toggle-btn.method-active` CSS beats `.on`.
- **T4 — Client list badge + share error mapping.** Badge shows only effective-active; share create
  maps error codes to `shareT` messages. Verify: eslint.
- **T5 — Docs + full suite + finish.** Update this doc's status, run `NODE_ENV=test node --test
  --test-force-exit tests/` (expect only the pre-existing `requires wg` failure), eslint, PR.

## Out of scope
- Bulk migration of legacy both-set rows (non-destructive on-save reconcile chosen).
- Green tint in the route list / create form.
