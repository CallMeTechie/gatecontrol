# Storage targets

Since 1.203.0. Places **outside GateControl's own data folder** where it can
keep files: a folder of this server, a NAS over SMB or WebDAV, an
S3-compatible bucket, a folder in Google Drive or OneDrive
(docs/cloud-accounts.md). They are the first part of the server core for
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
| NAS over WebDAV | `webdav` | `url` (http/https, no user info), `via` (since 1.218.0: `{ kind: 'host' }` — the default, `{ kind: 'route', routeId }` or `{ kind: 'peer', peerId, port }`, see "Addresses"), `username`, `tlsCa` | `password` | Basic authentication; use https. |
| S3-compatible | `s3` | `endpoint`, `region` (default `us-east-1`), `bucket`, `prefix`, `pathStyle` (default true), `accessKeyId`, `tlsCa` | `secretAccessKey` | AWS, Hetzner, Wasabi, Backblaze B2, MinIO, Synology C2. |
| Google Drive | `gdrive` | `account`, `folderId`, `folderPath` | the OAuth token | the administrator's own account, scope `drive.file` (GateControl sees only what it created); connected with *Mit Google verbinden* (docs/cloud-accounts.md). |
| OneDrive | `onedrive` | `account`, `driveId`, `folderId`, `folderPath` | the OAuth token | personal or work/school, `Files.ReadWrite`; connected with *Mit Microsoft verbinden*. |

`tlsCa`: the target's own trust anchor in PEM (one or more certificates,
≤ 64 KiB) — the NAS's self-signed certificate or a private company CA. TLS is
**always** verified: with `tlsCa`, only these certificates are trusted (not
the system's CAs); a server presenting exactly one of them needs no matching
host name (a NAS reached by its IP with a certificate for "synology"),
anything signed by them is checked against the host name as usual. The admin
API answers `tlsCaInfo: [{ subject, fingerprint, validTo }]`.

### Certificates

Every certificate in `tlsCa` is a trust anchor of its own, not only a
self-signed root (`allowPartialTrustChain`, OpenSSL's
`X509_V_FLAG_PARTIAL_CHAIN`, Node ≥ 22.9; since 1.219.1). So a leaf issued by
a CA works pinned on its own: DSM's default certificate is issued by
"Synology Inc. CA", and `cert.pem` of its export is enough — whether DSM sends
the CA along or not. An intermediate CA works as the only anchor, too. Before
1.219.1 such a leaf was refused (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or
`SELF_SIGNED_CERT_IN_CHAIN` with the CA in the chain): OpenSSL wanted the
chain up to a self-signed root. Never paste `privkey.pem` — `tlsCa` takes
certificates only.

| Stored in `tlsCa` | Server presents | Result |
|---|---|---|
| the leaf (`cert.pem`) | exactly that leaf (with or without its CA) | trusted under any name or IP |
| the leaf | another leaf of the same CA | `tls` (the CA is not trusted through the leaf) |
| a CA (root or intermediate) | a leaf it issued for the URL's name | trusted |
| a CA | a leaf it issued for another name, or reached by IP | `tls` (`ERR_TLS_CERT_ALTNAME_INVALID`) |
| anything | a certificate not stored and not issued by a stored one | `tls` |
| the leaf or its CA | the leaf, expired / not valid yet | `tls` (`CERT_HAS_EXPIRED` / `CERT_NOT_YET_VALID`) |

The dates are checked for a pinned leaf as well — deliberately: a pinned
certificate is no lifetime pass; when the NAS renews it (Let's Encrypt every
60–90 days), the new one has to be stored (or its CA / the intermediate
instead of the leaf).

**Diagnosis.** A check that fails with `tls`, `not_tls` or `tls_handshake` (WebDAV, S3) reads the
certificate the server presents (`net.inspectTls`): a second handshake to the
same checked, pinned address — same `dial` (route, peer), same SNI, same
trust (the target's `tlsCa` or the system CAs), verified as always (no
`rejectUnauthorized: false`): the certificate is read when the handshake is
done, before Node's verdict closes the socket (or it is closed right after a
trusted one) — not one application byte, no credentials. `check.tls`:

```
{ reason, code, host, cert, chain: [cert …], hints: [...], trust: { leaf, chain } }
cert: { subject, issuer, names (SAN), validFrom, validTo (ISO), fingerprint (SHA-256 hex), ca, selfSigned, pem }
```

`reason`: `name` (the certificate's names do not include the URL's host),
`expired`, `not_yet_valid`, `self_signed`, `missing_intermediate` (the server
sent its leaf only and its issuer is unknown — DSM without the
intermediate; Node does not fetch it through AIA), `untrusted_ca` (a CA
nobody trusts, also a self-signed one sent along), `not_stored` (a `tlsCa` is
set and this certificate is neither one of them nor issued by one),
`untrusted` (any other OpenSSL code, in `code`), `not_tls` / `handshake`
(the probe got no certificate: no TLS on that port, or the handshake was
aborted — `cert` null, `chain` empty, `code` the system's), `null` (trusted now).
`chain`: the leaf first, then the certificates the server sent along (with
the issuers the trust store knows). `hints`: `intermediate`
(with `missing_intermediate`), `route_decrypts` (a certificate of Caddy's
internal CA "Caddy Local Authority", or the WebDAV target's L4 route
terminates TLS: GateControl answers instead of the NAS — set the route's TLS
mode to pass through). `trust.leaf`: the page offers "Diesem Zertifikat
vertrauen" (not for a date, not with `route_decrypts`); `trust.chain`:
"Mitgelieferte Kette übernehmen" — the CA certificates the server sent (not
for `name`). Both ask first in the dialog with names and fingerprints, then
put the PEM into the field and check again; it is kept only when the
administrator saves.

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
await d.copy(from, to);                    // since 1.215.0 (gc.media.copy): local, WebDAV, S3 — a copy on the target itself; never over an existing object (local, WebDAV: exists)
await d.space();                           // → { free, total } in bytes, null where unknown (S3)
d.ranges                                   // false for SMB: a range read fetches the whole file and cuts it
```

* **Google Drive** / **OneDrive** (`drivers/gdrive.js`, `drivers/onedrive.js`,
  docs/cloud-accounts.md): a key's folders are created below the chosen
  folder (one at a time, ids remembered); Drive: resumable upload sessions in
  64 MiB parts, `Range` on `alt=media`; OneDrive: up to 4 MiB in one PUT,
  larger through an upload session in 60 MiB fragments, downloads through
  Graph's redirect to its storage host (never with the token). The token is
  refreshed when needed and written back into the target's secret. A refused
  refresh is `auth` ("Konto neu verbinden"). Sealed blocks only, no `move`.

Errors are `StorageError`s (`errors.js`) with `code`: `not_found`, `auth`,
`denied`, `unreachable`, `tls` (certificate not trusted), `not_tls` (the other side
speaks no TLS: OpenSSL's "wrong version number", "packet length too long" … —
an http port such as Synology's 5000/5005, HTTPS off in the WebDAV server),
`tls_handshake` (a handshake aborted for another reason: an alert, no common
protocol; both keep the system's code in `sys`, since 1.219.1 — before, every
`ERR_SSL_*` counted as `tls`), `blocked_address`, `full`,
`length_mismatch`, `protocol`, `failed`.

* **S3**: requests signed with AWS Signature V4 (header auth), bodies streamed
  as `UNSIGNED-PAYLOAD` over the connection; objects above 64 MiB go up as a
  multipart upload (64 MiB parts, larger parts when a file would need more than
  10 000), aborted when a part fails. Range reads with `Range`; a server that
  answers a range with 200 is cut to the range. `copy`: `CopyObject`
  (`x-amz-copy-source`, a 200 with an `<Error>` body counts as failed), above
  5 GiB a multipart upload of `UploadPartCopy` parts (512 MiB), aborted when a
  part fails — S3 cannot refuse an existing destination, the media store only
  copies to fresh keys there.
* **WebDAV**: `MKCOL` for every folder of a key (remembered per process),
  `PUT` with `Content-Length`, `GET` with `Range`, `MOVE` and (since 1.215.0)
  `COPY` with `Overwrite: F`,
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
  into place; a key that would leave the folder is refused. `copy` (since
  1.215.0) uses `copyFile` with a reflink where the file system can, through a
  temporary file, never over an existing file.

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

### WebDAV through a route or a peer

Since 1.218.0 a WebDAV target has `via` like SMB, so GateControl in a data
centre can use a NAS behind a gateway in a home network — without opening
the route to the outside. `url` still decides the scheme, the path, the
`Host` header and, for https, the name for SNI and the certificate check;
only the connection goes elsewhere (`net.request({ dial })`, the address
checked and pinned as always):

| `via` | connects to |
|---|---|
| `{ kind: 'host' }` (default; rows from before 1.218.0 have no `via`) | the URL's host and port, as before |
| `{ kind: 'peer', peerId, port }` | the peer's VPN address, `port` (default: the URL's port, else 443 / 80) |
| `{ kind: 'route', routeId }`, **L4 route** (TCP) | what Caddy dials for it: the gateway's listener (gateway VPN address, listen port) for a gateway route, else the peer or target address with the target port |
| `{ kind: 'route', routeId }`, **HTTP route through a gateway** | the gateway's companion proxy (`http://<gateway VPN address>:<proxy port>` with `X-Gateway-Target-Domain: <route domain>`, `routes.resolveCompanionUrl`) — **http URLs only**, and only when the route speaks http to the NAS |
| `{ kind: 'route', routeId }`, other **HTTP route** | its backend (peer VPN address or target address, target port) — only when the backend speaks the URL's scheme |

Never through Caddy and the route's public domain: an internal-only route
(docs/route-external-exposure.md) stays internal, its outside block does not
apply to GateControl itself. The route or peer is read again for every
connection (a gateway failover moves a route), a missing or switched-off one
is `unreachable` at the "connect" step; the address rules above apply to what
is dialled (never GateControl's app port or the Caddy admin port on this
server's addresses → `blocked_address`).

Why these route kinds: an **L4 route** passes the bytes untouched, so TLS
runs from GateControl to the NAS itself — the certificate is checked against
the URL's name with `tlsCa` or the system CAs exactly as without a route, and
Range, COPY, MOVE, MKCOL and the quota properties need nothing from the
route. This is the route for https. An **HTTP route through a gateway**
ends at the companion's HTTP proxy, which makes its own connection to the
NAS: for an https NAS that TLS connection is the companion's (unchecked
unless the route pins a fingerprint), GateControl's `tlsCa` could not apply —
so only plain http goes this way (GateControl → gateway inside WireGuard, the
last hop in the home network as the URL says). A route that cannot carry the
URL (UDP, an HTTP route through a gateway with an https URL or an https
backend, an HTTP route whose backend speaks the other scheme) is refused with
`400 invalid`, `field: 'routeId'`.

A self-signed NAS certificate for another name ("synology") works through a
route like without one: store exactly that certificate as `tlsCa` — also DSM's
default certificate, which is issued by "Synology Inc. CA" (its `cert.pem`).
The route has to pass TLS through (TLS mode "Keiner" or "Durchleitung"); one
that terminates TLS answers with Caddy's certificate (the check says so).

Example — GateControl in a data centre, a Synology NAS (192.168.178.20, WebDAV
Server with https on 5006) behind the gateway "Heim": an L4 route, TCP,
target the gateway "Heim" with LAN target `192.168.178.20:5006`, any free
listen port (e.g. 15006), "Von extern erreichbar" off. The storage target:
WebDAV, *Über eine Weiterleitung* → that route, URL
`https://<the NAS's certificate name>:5006/GateControl` (with the DSM default
certificate: any name, e.g. `https://synology:5006/GateControl`, and that
certificate — exported from DSM — as `tlsCa`).

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
GET    /api/v1/storage-targets/choices      → { peers: [{ id, label, ip }], routes: [{ id, label, type: 'l4' | 'http', gateway, https?, internal }] }   (for "via": SMB takes L4 routes, WebDAV both; UDP routes are left out)
GET    /api/v1/storage-targets/:id          → { target }
PATCH  /api/v1/storage-targets/:id          { label, …settings, …secrets }   (a secret left empty keeps the stored one)
DELETE /api/v1/storage-targets/:id
POST   /api/v1/storage-targets/:id/check    → { check, target }
```

A view: `{ id, kind, label, config, secretSet: { <field>: boolean }, needsSecret,
display, tlsCaInfo, encrypted, ranges, check: { at, ok, error, free, total } | null, usedBy:
[{ kind, plugin, area, label }], createdAt, updatedAt }` — never a secret.
`check`: `{ ok, error, message, free, total, steps: [{ step, ok }] }`, after a `tls`,
`not_tls` or `tls_handshake` failure also `tls` (see "Certificates") and, for the
latter two, `sys` (e.g. `ERR_SSL_WRONG_VERSION_NUMBER`).

Errors: `400 invalid` with `field` (the input field to fix), `404 not_found`,
`409 in_use` (delete, or changing *where* a used target points — path, host,
peer, route, share, folder, URL, WebDAV `via`, endpoint, bucket, prefix; a
WebDAV PATCH without `via` keeps the stored one), `409 limit` (50
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
— plugin media areas name it — and the secret exactly as stored. An SMB or
WebDAV target through a peer or a route names it by peer name / route domain; a
restore maps them to the restored ids (a missing one leaves the target
unreachable until it is edited). Files on a target are **never** part of the
GateControl backup.

## Media areas

Plugins with `media.areas` (docs/plugins.md "Media areas") keep files on
targets; the administrator picks the target per area in the plugin's
settings. The page *Plugins › Speicher* also shows the **cache** — local
copies of files kept on targets — and sets its size (`PUT
/api/v1/storage-targets/cache { limitBytes | null }`, default 5 GB; `GET
/api/v1/storage-targets` answers `cache: { cached, pending, limit, default }`).
`usedBy` of a target lists the areas on it (or moving to it) and plugins that
still have files there. Folder, SMB and WebDAV drivers have `files: true`
(readable files, docs/plugins.md "Readable files") and `list(prefix)` →
`[{ key, size, mtime }]` (recursive; SMB through `recurse` + `ls`, WebDAV
through PROPFIND Depth 1 per folder) for the scans; a `move` never overwrites
an existing object (StorageError `exists`). S3, Google Drive and OneDrive hold
sealed blocks only.

## Tests

`tests/storage_targets.test.js` (API, validation, secrets, the check against a
folder, "in use", SigV4 against AWS's documented example, addresses, backup)
and `tests/storage_targets_via.test.js` (WebDAV through stand-in L4, gateway
and HTTP routes and a peer to a WebDAV server of the test: http and https
with an own CA or a pinned self-signed certificate, the check, Range, COPY,
MOVE, quota, validation, "in use", blocked ports, backup, DSM's default
certificate, the TLS diagnosis through a route) and
`tests/storage_targets_tls.test.js` (`tlsCa`: a pinned leaf issued by a CA,
by IP and any name, a CA with the right and the wrong name, an intermediate
as anchor, certificates not stored, expired and not yet valid; `inspectTls`:
every reason, no application byte, the address rules; no TLS on the port, a
handshake aborted by an alert, the error mapping) run with every
`npm test`. `tests/storage_targets_live.test.js` runs the
drivers against real servers when they are named in the environment
(`GC_TEST_S3_*`, `GC_TEST_WEBDAV_*`, `GC_TEST_SMB_*`, see the file); the CI job
"storage targets (S3, WebDAV, SMB)" starts moto, wsgidav and Samba for it.
