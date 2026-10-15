# Profile pictures and favourite colours

Since 1.168.0 every person has a **profile picture** (optional) and a **favourite colour**. Both
show up in the admin UI (users list, user profile, own profile, topbar), in the portal (header,
"Wer bist du?"), in the apps and — through `gc.users` — in plugins (Familie: member lists, wall,
presence). The colour is the colour of the presence ring "at home"; red means "away" and is
therefore not a favourite colour.

Each person changes both in the GateControl app (Settings → Profil), on "Konto & Sicherheit"
(`/profile`) or in the portal on "Meine Geräte"; an administrator changes them on the user
profile (`/users/:id`, card "Profilbild & Farbe").

## Colours

| key | hex | | key | hex |
|---|---|---|---|---|
| blue | `#3B82F6` | | teal | `#14B8A6` |
| green | `#22C55E` | | lime | `#84CC16` |
| yellow | `#EAB308` | | orange | `#F97316` |
| pink | `#EC4899` | | purple | `#A855F7` |
| indigo | `#6366F1` | | slate | `#64748B` |

`services/avatars.js` `PALETTE` holds them in this order (the table read row by row: blue, teal,
green, lime, yellow, orange, pink, purple, indigo, slate). Without a choice the colour is
`PALETTE[userId % 10]` — `color` is never `null` in an answer. Ring colour "away": `#E5484D`;
unknown / not shared: a neutral 1 px border. Without a picture: the initials (two words → first
letters, one word → first two letters) in white on the colour.

## Pictures

- PNG, JPEG or WebP, square, 64…512 px, at most 96 KB. The server parses the header only (PNG
  IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X) and stores the bytes as sent; animated WebP and APNG are
  refused. The type comes from the bytes, not from `Content-Type`.
- The apps and the browser pages crop to the centre square and scale down to 256×256 before
  uploading (browser: canvas, WebP quality 0.85, JPEG when the browser cannot encode WebP, lower
  quality until it fits; `public/js/avatar-edit.js`).
- **Capability URL** `/avatars/<avatarId>.<ext>` (`ext` = `png` | `jpg` | `webp`): `avatarId` is
  24 random url-safe characters, new on every change. No login — the URL is the secret, like the
  plugin assets. Answer: the right `Content-Type`, `Cache-Control: public, max-age=31536000,
  immutable`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`
  (plugin frames), `Content-Security-Policy: default-src 'none'`. Unknown id, wrong extension or
  removed picture → 404. Served by the app itself, so it works on every host: the admin UI, the
  portal host and the base URL the apps use for `/api/v1/client/...`. 600 requests per minute and
  address.
- Removing the picture deletes the row: the old URL answers 404 at once. Deleting the user
  deletes the picture (`ON DELETE CASCADE`).

## Storage

Migration 101 `user_avatars`: table `user_avatars(user_id PK → users.id ON DELETE CASCADE,
avatar_id TEXT UNIQUE, mime, data BLOB, updated_at)` and column `users.avatar_color` (palette key,
`NULL` = default). The JSON backup (Settings → Backup, auto-backup, offsite) carries
`data.user_avatars: [{ user_name, avatar_id, mime, data (base64), updated_at }]` and
`users.avatar_color`; a restore that replaces the users restores the pictures with the same URLs
(each checked again like an upload, a broken one is skipped).

## APIs

All answers `{ ok, … }`; errors `{ ok: false, code, error[, reason | field] }`:

| Status | code | When |
|---|---|---|
| 415 | `UNSUPPORTED_TYPE` | `Content-Type` is not `image/png`, `image/jpeg` or `image/webp` |
| 413 | `TOO_LARGE` | body over 96 KB |
| 400 | `INVALID_IMAGE` | `reason`: `empty`, `format`, `animated`, `not_square`, `too_small`, `too_big`, `too_large` |
| 400 | `INVALID_COLOR` | `field: 'color'` — not a palette key (`red` included) |
| 404 | `NOT_FOUND` | unknown user |
| 429 | `RATE_LIMITED` | too many changes |

The raw body parser runs only on `PUT …/avatar`.

### Apps — device token (scope `client` or `full-access`, machine binding)

| Method | Path | Answer |
|---|---|---|
| GET | `/api/v1/client/me/profile` | `{ ok, user: { id, name, initials, color, colorHex, avatarUrl \| null }, palette: [{ key, hex }] }` |
| PUT | `/api/v1/client/me/avatar` | raw body → `{ ok, avatarUrl }` |
| DELETE | `/api/v1/client/me/avatar` | `{ ok }` |
| PUT | `/api/v1/client/me/color` | `{ color: key \| null }` → `{ ok, color, colorHex }` |

Always the token's owner. A token without a person (machine / service token) → 403 `NO_USER`.
Writes: 30 per hour and token; reading counts against the general API budget only.
`Cache-Control: no-store`.

### Administrator — session + CSRF

| Method | Path | Answer |
|---|---|---|
| PUT | `/api/v1/users/:id/avatar` | raw body → `{ ok, avatarUrl }` |
| DELETE | `/api/v1/users/:id/avatar` | `{ ok }` |
| PUT | `/api/v1/users/:id/color` | `{ color: key \| null }` → `{ ok, color, colorHex }` |

`GET /api/v1/users` (every row) and `GET /api/v1/users/:id` (`user`) carry `avatarUrl`, `color`,
`colorHex`.

### Own account — session + CSRF

| Method | Path | Answer |
|---|---|---|
| GET | `/api/v1/profile/avatar` | like `GET /api/v1/client/me/profile` |
| PUT / DELETE | `/api/v1/profile/avatar` | as above |
| PUT | `/api/v1/profile/color` | as above |

The same under `/api/v1/me/{profile,avatar,color}` (web session) and
`/api/v1/portal/me/{profile,avatar,color}` (portal session; CSRF token of the portal page). A
kiosk device gets 403 `kiosk_forbidden` there (the paths are not on the kiosk allow-list). Browser
writes: 60 per 15 minutes and person.

### Portal

The header viewer (`viewer` of `portal.njk`) carries `avatarUrl`, `color`, `colorHex`; "Wer bist
du?" shows the pictures of the people of a shared device. `portal-ctx.canEditLook` is true for a
signed-in person (not on a kiosk device): the tab "Meine Geräte" then has the card "Profilbild &
Farbe".

### Plugins

`gc.users.list()/get(id)` → `{ id, name, role, avatarUrl, color, colorHex, initials }`; every
plugin frame may load `<origin>/avatars/` (docs/plugins.md "User interface").

## Activity log

`avatar_changed` (details: `userId`, `actorId`, `mime`, `size`, `bytes`), `avatar_removed`,
`avatar_color_changed` (`color`) — never the image. `source`: `api` (app), `admin`, `user`
(own profile, portal).
