# Storage targets

Since 1.203.0. Places **outside GateControl's own data folder** where it can
keep files: a folder of this server, a NAS over SMB or WebDAV, an
S3-compatible bucket. They are the first part of the server core for
GateControl Drive: the plugin media store will move the files of a plugin's
*areas* (plugin.json `media.areas`) there. In this version nothing uses them
yet — administrators can set them up and check them.

Code: `src/services/storageTargets/` (service, `net.js`, `drivers/*.js`),
`src/routes/api/storageTargets.js`; page: Einstellungen › Plugins › Speicher
(`/settings/plugins/storage`, `public/js/plugins-page.js` view `storage`).

## Kinds

| Kind | `kind` | Settings | Secret | Notes |
|---|---|---|---|---|
| Folder of this server | `local` | `path` (absolute) | – | another disk or a mounted volume. Never `/` or a system folder (`/etc`, `/usr`, `/proc`, `/root`, `/app` …); inside GateControl's data folder only below `<data>/storage/`. |
| NAS over SMB | `smb` | `via` (`{ kind: 'host', host, port }`, `{ kind: 'peer', peerId, port }` or `{ kind: 'route', routeId }` — an **L4** route), `share`, `folder`, `username`, `domain` | `password` | through the image's `smbclient` (SMB 2 or newer). |
| NAS over WebDAV | `webdav` | `url` (http/https, no user info), `username`, `tlsFingerprint` | `password` | Basic authentication; use https. |
| S3-compatible | `s3` | `endpoint`, `region` (default `us-east-1`), `bucket`, `prefix`, `pathStyle` (default true), `accessKeyId`, `tlsFingerprint` | `secretAccessKey` | AWS, Hetzner, Wasabi, Backblaze B2, MinIO, Synology C2. |

`tlsFingerprint`: the SHA-256 fingerprint of the server's certificate (64 hex
characters, colons allowed) — for a NAS with a self-signed certificate. With
it, exactly that certificate is accepted and the chain is not checked;
without it, the certificate must be valid as usual.

## Driver interface

Every driver (`drivers/<kind>.js`, `create(config, secret)`) offers the same
calls; a key is a relative path with `/` (`ab/12/<id>`), the driver maps it
below its folder, share folder, WebDAV URL or bucket prefix:

```js
await d.prepare();                         // the base folder / bucket exists (SMB, WebDAV: created)
await d.put(key, { length, open(start, end) });   // open → a readable of those bytes (inclusive); called once per S3 part
const stream = await d.get(key, { start, end } | null);   // plaintext bytes; a missing key → not_found
await d.head(key);                         // → { size, mtime } | null
await d.remove(key);                       // → true | false (S3 cannot tell: true unless 404)
await d.move(from, to);                    // local, SMB, WebDAV (S3 keys are never renamed)
await d.space();                           // → { free, total } in bytes, null where unknown (S3)
d.ranges                                   // false for SMB: a range read fetches the whole file and cuts it
```

Errors are `StorageError`s (`errors.js`) with `code`: `not_found`, `auth`,
`denied`, `unreachable`, `tls_fingerprint`, `blocked_address`, `full`,
`length_mismatch`, `protocol`, `failed`.

* **S3**: requests signed with AWS Signature V4 (header auth), bodies streamed
  as `UNSIGNED-PAYLOAD` over the connection; objects above 64 MiB go up as a
  multipart upload (64 MiB parts, larger parts when a file would need more than
  10 000), aborted when a part fails. Range reads with `Range`; a server that
  answers a range with 200 is cut to the range.
* **WebDAV**: `MKCOL` for every folder of a key (remembered per process),
  `PUT` with `Content-Length`, `GET` with `Range`, `MOVE` with `Overwrite: F`,
  free space from the RFC 4331 properties `quota-available-bytes` /
  `quota-used-bytes` of the base folder.
* **SMB**: one `smbclient` process per operation. Its commands go in on stdin,
  one per line (with `-c` smbclient splits at `;`, which may be part of a file
  name); the file data through a FIFO in a private temporary folder (`put
  <fifo> "<path>"`, `get "<path>" <fifo>`), so nothing is held in memory or
  written to the server's disk; the password goes into an authentication file
  (0600) in that folder, never onto a command line. Names with `" < > | ? * :
  \` or control characters are refused (Windows does not allow them either).
  A reader that stops early (a range) closes the FIFO, which ends smbclient.
  Answers are judged by their `NT_STATUS_…` codes.
* **Folder**: writes go to a temporary file in the same folder and are renamed
  into place; a key that would leave the folder is refused.

## Addresses

Every connection goes to an address resolved once, checked and pinned (no
second DNS answer between check and connect — `net.js`). Allowed: public,
private, carrier-grade NAT, unique-local and loopback addresses (a MinIO next
to GateControl is fine). Never: unspecified, broadcast, multicast, link-local,
reserved ranges, the cloud metadata addresses, and GateControl's own app port
and the Caddy admin port (2019) on this server's addresses.

An SMB target through a **peer** connects to the peer's VPN address (port
`port`, default 445); through an **L4 route** to what Caddy dials for it (the
gateway's listener for a gateway route, else the peer or target address and
port).

## Check

`check()` (button "Prüfen") runs five steps and stops at the first that fails:
`connect` (resolve, sign in), `folder` (`prepare`), `write` (a random test
file of 64 KiB + 17 bytes, `.gatecontrol-check-<random>`), `read` (size, the
whole file and a range across a 64 KiB boundary, compared byte for byte),
`delete`; then the free space. The result of a stored target is kept on its
row (`checked_at`, `check_ok`, `check_error`, `free_bytes`, `total_bytes`) and
shown in the list. "Prüfen" in the dialog checks unsaved settings without
storing anything; saving checks the stored target and keeps the dialog open
when the check fails.

## Admin API

Admin session only (API tokens and members: 403), CSRF and the API limiter of
`/api/v1`:

```
GET    /api/v1/storage-targets              → { targets: [view] }
POST   /api/v1/storage-targets              { kind, label, …settings, …secrets } → 201 { target }
POST   /api/v1/storage-targets/check        { kind, …[, id] } → { check }   (nothing stored; with id the stored secret fills empty fields)
GET    /api/v1/storage-targets/choices      → { peers: [{ id, label, ip }], routes: [{ id, label }] }   (for SMB "via")
GET    /api/v1/storage-targets/:id          → { target }
PATCH  /api/v1/storage-targets/:id          { label, …settings, …secrets }   (a secret left empty keeps the stored one)
DELETE /api/v1/storage-targets/:id
POST   /api/v1/storage-targets/:id/check    → { check, target }
```

A view: `{ id, kind, label, config, secretSet: { <field>: boolean }, needsSecret,
display, encrypted, ranges, check: { at, ok, error, free, total } | null, usedBy:
[{ kind, plugin, area, label }], createdAt, updatedAt }` — never a secret.
`check`: `{ ok, error, message, free, total, steps: [{ step, ok }] }`.

Errors: `400 invalid` with `field` (the input field to fix), `404 not_found`,
`409 in_use` (delete, or changing *where* a used target points — path, host,
peer, route, share, folder, URL, endpoint, bucket, prefix), `409 limit` (50
targets). Activity: `storage_target_created`, `storage_target_changed`,
`storage_target_deleted` (never a secret).

## Storage

Table `storage_targets` (migration 114): `id, kind, label, config_json,
secret_enc, created_at, updated_at, checked_at, check_ok, check_error,
free_bytes, total_bytes`. `secret_enc` is the JSON of the secret fields,
encrypted with `GC_ENCRYPTION_KEY` (`utils/crypto`, like
`directories.secret_enc`). A secret that cannot be decrypted (a backup from a
server with another key) makes the target show "Passwort neu eingeben"
(`needsSecret`) and fail with `auth` until it is entered again.

## Backup

The GateControl backup contains the targets (`storage_targets`) with their id
— plugin media areas will name it — and the secret exactly as stored. An SMB
target through a peer or an L4 route names it by peer name / route domain; a
restore maps them to the restored ids (a missing one leaves the target
unreachable until it is edited). Files on a target are **never** part of the
GateControl backup.

## Tests

`tests/storage_targets.test.js` (API, validation, secrets, the check against a
folder, "in use", SigV4 against AWS's documented example, addresses, backup)
runs with every `npm test`. `tests/storage_targets_live.test.js` runs the
drivers against real servers when they are named in the environment
(`GC_TEST_S3_*`, `GC_TEST_WEBDAV_*`, `GC_TEST_SMB_*`, see the file); the CI job
"storage targets (S3, WebDAV, SMB)" starts moto, wsgidav and Samba for it.
