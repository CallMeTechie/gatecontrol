# Diagnose-Assistent (client diagnosis)

The Android app has a diagnosis screen ("Diagnose-Assistent"). It runs a fixed
set of checks on the device and can send the result to the admins together
with the support bundle ("Problem melden"). The server's part: a speed test
against the user's own GateControl server, and two optional keys in the
support bundle (`diagnosis`, `description`) that the admin UI shows.

## What the app checks

| id          | check                                                                                     |
|-------------|-------------------------------------------------------------------------------------------|
| `internet`  | the device reaches the internet at all                                                    |
| `server`    | the GateControl server answers, latency                                                   |
| `tunnel`    | the WireGuard tunnel is up                                                                |
| `handshake` | age of the last WireGuard handshake                                                       |
| `dns`       | DNS leak: the VPN network's DNS servers vs. `vpnDns` of `GET /api/v1/client/dns-check` (scope `client:dns`) |
| `mtu`       | MTU probe: ping with "don't fragment" to the gateway IP (`gatewayIp` of `dns-check`)      |
| `speed`     | download / upload speed against the own server (below)                                   |

Each check ends as `ok`, `warn`, `fail` or `skipped` (e.g. MTU while the tunnel
is down). The server does not run or judge any check — it stores and shows
what the app reports.

## Speed test API

Token only (`X-API-Token`, scope `client` or `full-access`); machine binding
applies like on every client route. A browser session gets `403
{ ok: false, error: "token_required" }`, a token without the scope `403
scope_required`. Every response carries `Cache-Control: no-store,
no-transform`.

Rate limit: `speedtestLimiter` (`src/middleware/rateLimit.js`), in front of
every handler, **`GC_SPEEDTEST_RATE_LIMIT` (30) requests per token and 10
minutes** across the three endpoints, failed requests included → `429
{ ok: false, error: "rate_limited" }` with `Retry-After` (seconds). The
general API limit of the token applies as well. No activity log entry per run
(a debug log line only).

### `GET /api/v1/client/speedtest`

```json
{ "ok": true, "maxDownloadBytes": 26214400, "maxUploadBytes": 26214400, "viaTunnel": true }
```

`viaTunnel`: the request came from inside the WireGuard subnet
(`services/homeNetwork.viaOf`, the same rule as `via` of
`GET /api/v1/client/home-network`). The app should run the test with the
tunnel up and show a note when this is `false` (the numbers are then the
direct internet path).

### `GET /api/v1/client/speedtest/download?bytes=N`

`200`, `Content-Type: application/octet-stream`, `Content-Length: N`,
`Content-Encoding: identity`, exactly N bytes of random (incompressible) data.
N is clamped to **[64 KiB, `maxDownloadBytes`]**; missing or not a plain
non-negative integer → **10 MiB** (or `maxDownloadBytes` when that is
smaller). The app measures the time to read the body.

### `POST /api/v1/client/speedtest/upload`

Body `Content-Type: application/octet-stream` (or no type), up to
`maxUploadBytes`. The server counts the bytes while they stream in and
discards them (nothing is buffered or stored).

* `200 { "ok": true, "bytes": <received>, "serverMs": <ms from the request head to the last byte> }`
* `413 { "ok": false, "error": "too_large" }` — a declared `Content-Length`
  above the limit is refused before reading; a chunked body is cut off at the
  limit (`Connection: close`). The app should send at most `maxUploadBytes`.
* `415 { "ok": false, "error": "unsupported_media_type" }` — any other type
  (a JSON body never reaches the counter, the global parser takes it).

### Limits (config/default.js `speedtest`)

| env                                | default | meaning                                  |
|------------------------------------|---------|------------------------------------------|
| `GC_SPEEDTEST_MAX_DOWNLOAD_BYTES`  | 25 MiB  | largest download per request (≥ 64 KiB)  |
| `GC_SPEEDTEST_MAX_UPLOAD_BYTES`    | 25 MiB  | largest upload per request (≥ 64 KiB)    |
| `GC_SPEEDTEST_RATE_LIMIT`          | 30      | requests per token and 10 minutes        |

### Older servers

Servers before this feature answer `404` on `/api/v1/client/speedtest*`; the
app should show the speed check as `skipped`.

## "Problem melden": diagnosis and description in the support bundle

The app uploads the normal support bundle (`POST /api/v1/client/support-bundle`,
[feature-support-bundle.md](feature-support-bundle.md)) with two optional
top-level keys; `schema` stays `1`:

```json
{
  "schema": 1,
  "description": "Seit dem Update geht im Büro-WLAN nichts mehr.",
  "diagnosis": {
    "startedAt": "2026-10-13T09:59:50.000Z",
    "finishedAt": "2026-10-13T10:00:04.000Z",
    "summary": "warn",
    "checks": [
      { "id": "handshake", "status": "warn", "title": "Handshake", "detail": "vor 190 s",
        "value": 190, "hint": "Länger als 3 Minuten – Verbindung prüfen." }
    ]
  }
}
```

Cleaned on upload (`services/supportBundles.normalizeDiagnosis` /
`normalizeDescription`) — **an invalid value is dropped, never a 400**:

* `description`: string, CR/LF → LF, control characters removed (tabs and
  line breaks stay), trimmed, max **2000** characters; empty → dropped.
* `diagnosis`: object; `summary` `ok|warn|fail` (missing/invalid → derived
  from the checks: any `fail` → `fail`, any `warn` → `warn`, else `ok`);
  `startedAt` / `finishedAt` kept when parseable dates (≤ 40 chars);
  `checks` max **30**, each needs `id` (`[A-Za-z0-9_.-]{1,40}`) and `status`
  `ok|warn|fail|skipped` — others are dropped; `title` one line ≤ 120 (falls
  back to the id), `detail` / `hint` ≤ 500 (line breaks kept), `value` a
  number, a boolean or one line ≤ 120 (objects are dropped). Without a valid
  check and without a valid summary the whole `diagnosis` is dropped.
* Both then go through the server redaction like every other string (a
  description with a token or a long key in it shows `[REDACTED]`).

Migration 99 adds `support_bundles.description` (the first 300 characters of
the redacted description) and `diagnosis_summary` for the inbox row and the
notification; the file keeps the full content.

Older servers accept and store the keys unchanged (they only check `schema`)
and show them under "Weitere Daten" in the viewer.

## Admin UI

* **Viewer** (`/support-bundles#view/…`): "Problembeschreibung" (plain text,
  line breaks kept) and "Diagnose" — summary chip, time of the run, counts and
  one row per check with status icon and colour, title, value, detail and
  hint. Both come before the tunnel section; every value via `textContent`.
* **Inbox row:** a small diagnosis chip and the start of the description under
  the device name (full preview as tooltip).
* **Notification** "Support-Paket empfangen": the facts gain *Diagnose*
  (alles in Ordnung / mit Warnungen / Probleme gefunden) and *Beschreibung:
  vom Nutzer beigefügt* — never the text itself (it is personal and webhooks
  get the facts too).
