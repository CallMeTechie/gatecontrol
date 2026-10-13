# Support-Paket per Knopfdruck (support bundles)

A user presses "Support-Paket senden" in a client (Windows Pro/Community,
Android). After a confirmation dialog the client collects a **redacted**
diagnostics bundle and uploads it. Admins get a notification ("Support-Paket
von <Gerät>"), find every bundle under **System › Support-Pakete** (badge with
the unopened ones), read it in the browser viewer, and see the device's
bundles in the peer edit dialog; download and delete work in all three places.

## Client API

`POST /api/v1/client/support-bundle?peerId=<id>`

* Auth: API token (`X-API-Token`), scope `client`, token bound to the peer;
  machine binding applies. Admin sessions are refused (`token_required`).
* Body: `Content-Type: application/gzip` (or `application/octet-stream`) with
  the gzip-compressed bundle JSON, max `GC_SUPPORT_BUNDLE_MAX_BYTES` (5 MB).
  Plain `application/json` is accepted as well (global 1 MB parser limit).
  The decompressed JSON may be at most `GC_SUPPORT_BUNDLE_MAX_JSON_BYTES`
  (20 MB); decompression is capped, zip bombs get 413.
* Rate limit: `GC_SUPPORT_BUNDLE_PER_HOUR` (3) stored uploads per peer and
  hour, plus 4× that many attempts per token and hour.
* Answers: `201 { ok, bundle: { id, created_at, size_bytes } }`;
  `400 invalid_gzip | invalid_json | invalid_bundle | unsupported_schema | empty_body`,
  `403` (not bound / wrong peer / no token), `413 too_large`, `429 rate_limited`.

Admin request: heartbeat (`POST /api/v1/client/heartbeat`) and
`GET /api/v1/client/peer-info` answer `supportBundleRequested: true` (and
`supportBundleRequestedAt`, the request time) while an admin request is open. The client then asks its user (same confirmation
dialog) — nothing is ever sent without consent. The next upload clears the
request and is marked `reason = admin_request`.

## Bundle format (schema 1)

```json
{
  "schema": 1,
  "createdAt": "2026-10-02T10:00:00.000Z",
  "reason": "user | admin_request",
  "client": { "product": "pro|community|android", "version": "1.24.0",
              "coreVersion": "1.10.0", "platform": "windows|android",
              "os": "Windows 10.0.22631", "arch": "x64", "locale": "de" },
  "tunnel": { "connected": true, "connectedSince": "…", "lastHandshakeAgeSec": 12,
              "endpoint": "…", "rxBytes": 0, "txBytes": 0, "killSwitch": false },
  "settings": { "…": "snapshot without secrets" },
  "wireguardConfig": "[Interface] … PrivateKey = [REDACTED] …",
  "network": { "interfaces": [], "dnsServers": [], "routes": "…" },
  "logs": { "lines": ["…"], "totalLines": 0, "truncated": false },
  "errors": ["recent error/warn log lines"],
  "description": "optional — the user's problem description (≤ 2000 chars)",
  "diagnosis": { "startedAt": "…", "finishedAt": "…", "summary": "ok|warn|fail",
                 "checks": [{ "id": "dns", "status": "ok|warn|fail|skipped",
                              "title": "…", "detail": "…", "value": "…", "hint": "…" }] }
}
```

Only `schema` is required; everything else is best-effort per platform.
`description` and `diagnosis` come from the apps' diagnosis assistant
("Problem melden", [feature-client-diagnosis.md](feature-client-diagnosis.md)):
cleaned on upload (lengths, max 30 checks, known statuses), an invalid value is
dropped — never a 400 — so older apps and odd values keep working.

## Redaction

Mandatory on the client **and** repeated on the server
(`src/utils/supportRedact.js`, mirrored in gatecontrol-client-core
`src/support/redact.js` and Android `SupportRedactor`):

* object keys naming a secret (password, token, apiKey, privateKey,
  presharedKey, secret, cookie, authorization, credential, setup/enrollment
  code, machine key, session id) → `"[REDACTED]"`
* WireGuard `PrivateKey = …` / `PresharedKey = …` lines
* `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
  `X-API-Token`, `X-API-Key` values
* `key=value` / `"key": "value"` pairs with a secret-like key
* GateControl tokens `gc_…`, JWTs, PEM private keys, 44-char base64 keys
  (WireGuard keys — public keys are masked too), hex strings ≥ 32 chars,
  setup codes `XXXX-XXXX-XXXX-XXXX`

## Storage and retention

* File: `<GC_DATA_PATH>/support/<peerId>/<YYYYMMDDTHHMMSSZ>-<rand>.json.gz`
  (dir 0700, file 0600), index row in `support_bundles` (migration 85),
  `peers.support_bundle_requested_at` for the admin request. Migration 94
  adds `viewed_at` / `viewed_by` (first admin who opened it in the viewer —
  until then the bundle is "neu") and `user_id` (the person whose app token
  uploaded it; the device owner is shown when NULL). Migration 99 adds
  `description` (first 300 characters of the redacted problem description)
  and `diagnosis_summary` (`ok|warn|fail`) for the inbox row and the
  notification facts.
* Retention: newest `GC_SUPPORT_BUNDLE_KEEP` (10) per peer, nothing older than
  `GC_SUPPORT_BUNDLE_MAX_AGE_DAYS` (30). Applied on every upload and in the
  6-hourly cleanup, which also removes files without a row (deleted peers).

## Admin API (admin session only, tokens refused)

* `GET    /api/v1/support-bundles?peerId=&status=new|viewed&limit=1..200&offset=`
  → `{ bundles, total, limit, offset, unviewed, peers }` — every device,
  newest first; a bundle carries `peer_name`, `user_name` (sender, else the
  device owner), `is_new`, `viewed_at`, `viewed_by_name`; `peers` are the
  devices with bundles (`count`, `unviewed`) for the filter. Bad values → 400.
* `GET    /api/v1/peers/:id/support-bundles` → `{ bundles, requestedAt }`
  (each with `is_new` / `viewed_at` now)
* `GET    /api/v1/peers/:id/support-bundles/:bundleId` → `{ bundle, data }` for
  the viewer: the parsed JSON, **redacted once more on read**
  (`supportRedact`, defence in depth for files written before a rule
  existed), `Cache-Control: no-store`. Marks the bundle viewed (first view:
  `viewed_at`/`viewed_by`, activity `support_bundle_viewed`). Larger than
  `GC_SUPPORT_BUNDLE_MAX_VIEW_BYTES` (8 MB uncompressed) → `413 { code:
  "too_large" }`, not marked — the download still works. Unknown bundle,
  other peer or missing file → 404.
* `GET    /api/v1/peers/:id/support-bundles/:bundleId/download` (JSON attachment)
* `DELETE /api/v1/peers/:id/support-bundles/:bundleId`
* `POST   /api/v1/peers/:id/support-bundles/request`, `DELETE …/request`

`GET /api/v1/peers` adds `support_bundles_total` and
`support_bundles_unviewed` per device for an admin session (never for API
tokens).

Activity log: `support_bundle_uploaded`, `support_bundle_viewed`,
`support_bundle_downloaded`, `support_bundle_deleted`, `support_bundle_requested`.

## Notification ("Support-Paket empfangen")

`support_bundle_uploaded` is a catalogue row of the notification center
(`support_bundle`, group System → topic `system`, admins only): rule default
on, recipients "Alle Admins", app on, priority `normal`, e-mail off (on via
the rule or the settings matrix like every core row), webhooks on.

* Title `push.named.support_bundle_uploaded` ("Support-Paket von <Gerät>"),
  body `push.body.support_bundle_uploaded` (where to look in the admin UI).
* Facts: Client (`Android 1.17.0`), Anlass (`vom Nutzer gesendet` / `auf
  Anfrage`), Größe; with the diagnosis assistant also Diagnose (`alles in
  Ordnung` / `mit Warnungen` / `Probleme gefunden`) and Beschreibung (`vom
  Nutzer beigefügt` — the text itself never leaves the bundle).
* `data.route` stays `inbox`: the apps have no admin screen and `open_portal`
  only reaches portal tabs, so there is no deep link into the admin UI.

## Admin UI

* **System › Support-Pakete** (`/support-bundles`, `templates/aurora/pages/
  support-bundles.njk`, `public/js/support-inbox.js`, CSS §11 `sb-`): table
  with time, device (link → filter; below it a diagnosis chip and the start
  of the problem description when the app sent them), user, client + version,
  reason, size, status (neu / angesehen, with who and when); filter by device
  (`?peer=<id>`) and status (`?status=new|viewed`), pages of 50; view,
  download, delete. Empty state explains how a bundle gets here (button in
  the app, "Paket anfordern" in the peer dialog). Sidebar badge = bundles no
  admin opened (`middleware/locals.js`, raised live by `app.js` on
  `gc:activity support_bundle_uploaded`).
* **Viewer** (`/support-bundles#view/<peerId>/<bundleId>`): summary (device →
  `/peers#edit/<id>`, user, received, created on the device, reason, client,
  core, OS, platform, arch, locale, size), problem description (plain text,
  line breaks kept) and diagnosis (summary chip, counts, one row per check with
  status icon/colour, title, value, detail, hint) when present, tunnel, settings as key/value
  table, network (interfaces, DNS, routes), WireGuard config, recent errors,
  logs (search with highlighted matches, level filter, error/warn colours from
  logcat / `[level]` / `level=` / `INFO`-style lines, truncation note, at most
  2000 rows drawn), other keys, "Rohdaten (JSON)"; download, delete. Every
  value goes through `textContent`.
* **Peers:** a small badge with the number of unopened bundles next to the
  device name (link to the filtered inbox); the edit dialog section shows a
  count, "neu", a view link per bundle and stays visible for every client
  device (Android included — it was never hidden for them, it only had no
  pointer to it), for gateways only when they have bundles or a request.
  `/peers#edit/<id>` opens that device's dialog.

No licence gate: support has to work for every edition.
