# Location sharing on tap, user profile and device page

The Android app can send its position to the own GateControl server — **only when its user taps
the satellite button** next to the bell on the start screen. There is no background location, no
periodic sending and no way for the server to ask a device for its position. Admins see the last
position of each device on a map.

## Admin

- **User profile** `/users/:id` (users page → "Profil öffnen"): header (role, status, e-mail,
  language, created, last sign-in), device cards (app, platform, client version, tunnel IP,
  online / last contact, chip "Standort 08:42" for the last shared position), latest activity,
  cards for access (role, visible services, RDP, web interface), security (passkeys, TOTP,
  tokens, own area) and **Standortfreigabe** (allow switch per user). Editing stays on the users
  page; the profile links into its panel tabs.
- **Device page** `/users/:id/devices/:peerId` (click a device card, or "Gerät öffnen" in the
  panel's access tab): last position on an OpenStreetMap map (accuracy circle, coordinates,
  provider, sent via tunnel or internet), "In OpenStreetMap öffnen", "Standorte löschen", device
  data (tunnel IP, host name, public key shortened, handshake, data, binding, app last active,
  notifications) and the history (newest 20, a click shows the point on the map).
- Both pages are admin only (non-admins → `/profile`); an unknown user goes back to `/users`, a
  peer that is not the user's device back to the profile.
- A device is every peer the user owns (`peers.user_id`) plus every peer one of the user's tokens
  is bound to; a token not registered yet shows as a card without a page.

### Admin API (session, admin)

| Method | Path | Answer |
|---|---|---|
| GET | `/api/v1/users/:id/devices` | `{ ok, devices: [{ key, peer, token, app, location }], location: { allowed, keep, retention_days } }` |
| GET | `/api/v1/users/:id/devices/:peerId` | `{ ok, user, device: { peer, token, push, locations }, location }` — 404 `error.users.device_not_found` for a foreign peer |
| DELETE | `/api/v1/users/:id/devices/:peerId/locations` | `{ ok, deleted }` |
| PUT | `/api/v1/users/:id/location-sharing` | body `{ enabled: boolean }` → `{ ok, user }` (400 otherwise) |

Activity: `user_location_sharing_changed`, `user_device_locations_deleted`.

## Client API (token, scope `client` or `full-access`, machine binding)

The token must belong to a device (`api_tokens.peer_id`), otherwise 403 `no_peer`. The person is
the token's owner, else the peer's owner. Responses carry `Cache-Control: no-store`.

### `GET /api/v1/client/location`

```json
{ "ok": true, "allowed": true, "last": { "lat": 51.3397, "lng": 12.3731, "accuracy": 12, "at": 1760000000000 },
  "keep": 20, "retention_days": 30 }
```

`allowed` = the user exists, is enabled and `users.location_sharing = 1`. The app hides the
satellite button when `allowed` is false; 404 means an older server without the feature.

### `POST /api/v1/client/location` (10 per minute and device)

Body: `lat` (−90…90), `lng` (−180…180), optional `accuracy` (0…100000 m), `altitude`
(±20000 m), `provider` (`[a-z][a-z0-9_-]{0,15}`, else dropped), `captured_at` (epoch ms; outside
now −10 min … +2 min the server time is used). Answers `{ ok: true, at }` (server time),
400 `invalid_lat|invalid_lng|invalid_accuracy|invalid_altitude`, 403 `location_not_allowed`.
Coordinates are stored with 7 decimals, accuracy/altitude with 1. Activity
`client_location_shared` (device name and accuracy — never coordinates).

### `DELETE /api/v1/client/location`

Deletes every position of the device, also when sharing is no longer allowed →
`{ ok: true, deleted }`. Activity `client_location_deleted`.

## Storage and retention

- Migration **97**: `users.location_sharing INTEGER NOT NULL DEFAULT 1` — allowed unless the admin
  switches it off; the person still has to switch it on in the app and tap.
- Migration **98**: table `device_locations` (`peer_id` → peers, cascade; `token_id`, `user_id`,
  `lat`, `lng`, `accuracy`, `altitude`, `provider`, `via` tunnel|direct, `captured_at`,
  `received_at` epoch ms).
- Newest **20** per device (trimmed on insert), at most **30 days** (hidden from reads after
  that and removed by the 6-hourly cleanup in `server.js`). Deleting a user deletes the rows they
  sent; deleting a peer deletes its rows.

## Map tiles

The map uses Leaflet 1.9.4 (vendored, `public/vendor/leaflet/`, its CSS in `app.css`) and tiles
from `https://tile.openstreetmap.org`. Only the device page adds that host to `img-src`
(`script-src` / `connect-src` unchanged). The tile requests send the server's origin as referrer
(OpenStreetMap's tile policy) and reveal the map area to OpenStreetMap; nothing else about the
device leaves the server.

## App (Android ≥ 1.26)

Settings › Standortfreigabe: switch "Standort teilen auf Tipp" (prominent disclosure, then the
foreground location permission — precise or approximate, "while using the app"), permission
state, last sent, recipient, delete. Switching off asks whether to delete the stored positions.
The satellite button is grey when ready, red while locating / sending and for 60 s after.
