# Support-Paket per Knopfdruck (support bundles)

A user presses "Support-Paket senden" in a client (Windows Pro/Community,
Android). After a confirmation dialog the client collects a **redacted**
diagnostics bundle and uploads it; admins see it per device in the peer edit
dialog and can download or delete it.

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
`GET /api/v1/client/peer-info` answer `supportBundleRequested: true` while an
admin request is open. The client then asks its user (same confirmation
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
  "errors": ["recent error/warn log lines"]
}
```

Only `schema` is required; everything else is best-effort per platform.

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
  (dir 0700, file 0600), index row in `support_bundles` (migration 84),
  `peers.support_bundle_requested_at` for the admin request.
* Retention: newest `GC_SUPPORT_BUNDLE_KEEP` (10) per peer, nothing older than
  `GC_SUPPORT_BUNDLE_MAX_AGE_DAYS` (30). Applied on every upload and in the
  6-hourly cleanup, which also removes files without a row (deleted peers).

## Admin API (admin session only, tokens refused)

* `GET    /api/v1/peers/:id/support-bundles` → `{ bundles, requestedAt }`
* `GET    /api/v1/peers/:id/support-bundles/:bundleId/download` (JSON attachment)
* `DELETE /api/v1/peers/:id/support-bundles/:bundleId`
* `POST   /api/v1/peers/:id/support-bundles/request`, `DELETE …/request`

Activity log: `support_bundle_uploaded`, `support_bundle_downloaded`,
`support_bundle_deleted`, `support_bundle_requested`.

No licence gate: support has to work for every edition.
