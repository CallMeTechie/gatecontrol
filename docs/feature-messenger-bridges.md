# Messenger bridges (preview)

The chat of the messenger plugin shall talk to people who have no GateControl
account: WhatsApp first (the WhatsApp Business **app** uses the same way,
"linked devices"), Signal and Telegram later. This file is the plan of the
server side and the contract with the plugin.

**State: stage 2, preview.** Nothing of it exists on a server that was not
started with `GC_BRIDGES_PREVIEW=1`, and with it the bridges are still **off**
until an administrator switches them on in the messenger plugin's settings.
Stage 2 brings the containers (compose profile `bruecken`, pinned images,
generated configuration). **None of it has been started by the people who
wrote it** — no Docker where it was built. What the programs really accept
and need is what `./update.sh bridges-probe` on the server shows (see
"Probe"); until then the memory limits are provisional and no number about
memory is claimed anywhere.

## Parts

```
WhatsApp ── bridge (mautrix) ──(Unix socket)──▶ internal Matrix homeserver    compose profile "bruecken"
                 ▲      ◀──(relay: HTTP → the bridge's Unix socket)──┘
                 │ provisioning API v3 (Unix socket, shared secret)
                 ▼
   server: src/services/bridges        driver "local"; later a gateway behind the same contract
                 │ gc.bridges.* (permissions.bridges)
                 ▼
   messenger plugin: settings, a person's own link, children's lock, later rooms ↔ chats
```

* **A plugin never sees Matrix.** It names a network (`whatsapp`) and a person
  (GateControl user id). Internal Matrix ids (`@gc_<id>:gc.internal`), tokens
  and the bridge's session keys stay in `src/services/bridges` and in the
  containers.
* **Location neutral.** `status().location` is `server` today. A gateway as
  the place comes later behind the same host API (the driver then calls the
  gateway instead of a local socket); the plugin does not change.
* **No Docker access.** As with "ClamAV auf diesem Server", the server writes
  its wish into `/data/.auto-update-config.json` (`"bridges":"whatsapp"`), the
  host's `update.sh` (marker 5, `sync_bridges`) brings up the services
  `bruecken-hs` and `bruecken-<network>` of the compose profile `bruecken` and
  reports to `/data/.bridges-state.json`: state, error, and per container
  whether it runs, the memory it really uses, its limit and its version.
  `update.sh` removes only containers it started; the data in `/data/bridges`
  stays.

## Security limits

1. **No port.** Nothing is published. The server reaches homeserver and
   bridges over Unix sockets only (`/data/bridges/hs/run/hs.sock`,
   `/data/bridges/run/<network>.sock`). The homeserver sits in a Docker
   network without a way out (`internal: true`); a bridge has a network only
   for its outgoing connections to its messenger and shares none with the
   homeserver.
2. **No federation, no registration, no guests.** The server name
   `gc.internal` resolves nowhere.
3. **Secrets.** The server makes one master key (`crypto.randomBytes(32)`),
   kept in `/data/bridges/secrets.json` (0600, folder 0700). `as_token`,
   `hs_token` and the provisioning secret are derived from it per purpose
   (HMAC-SHA-256): the file's content is never sent anywhere, and no API
   returns a token. Every registration has its own pair: the homeserver finds
   a registration by its `as_token`, so a shared one would put one bridge's
   bot into another bridge's namespace (its `/register` fails). WhatsApp keeps
   the purposes `as_token`/`hs_token` it had from the start; Signal and
   Telegram use `as_token:<network>`/`hs_token:<network>`. The session keys of a bridge live in its own database
   where it runs; a backup of them leaves that place only encrypted (later
   stage).
4. **A contract, not a pass-through.** `gc.bridges` takes fixed network names
   and checked ids, builds every path itself and returns reduced fields only;
   a bridge's error text stays in the server log.
5. **Only the person themselves** links or reads their account: the
   host checks that a request of exactly that person is in flight
   (`personContext`). An administrator switches the service and sees states,
   versions and memory — no contacts, no numbers, no contents.
6. **Ending somebody else's link** is the one thing another person may do
   (`unlinkFor`: a parent taking a child's permission back). It never makes or
   reads a link. The host requires an acting person — a changing request of
   `actor` in flight right now —, refuses administrators as targets and writes
   every call to the activity log (`bridges_unlinked_for`: who, whose, which
   plugin). Whether the actor is that child's parent is the plugin's rule.

## Homeserver

mautrix needs a homeserver with application services. Its documentation calls
Dendrite "not a supported environment" and Conduit-based servers "also fine";
for the bridge's own database "SQLite is fine for small instances". Synapse
would add PostgreSQL as a second service. The plan is therefore a server of
the Conduit family (one program, embedded RocksDB): Tuwunel first — it
registers application services from its configuration and reaches them over
`unix://` — continuwuity as the fallback. Their default caches are sized for
bigger servers (continuwuity documents `128 + 64 × cores` MB for the database
read cache alone) and will be set small.

### What the pinned versions really do (read from their sources, not run)

* Tuwunel 1.9.4 registers application services from its configuration
  (`[global.appservice.<ID>]`, `[[global.appservice.<ID>.users]]`) and listens
  on a Unix socket (`unix_socket_path`) next to its TCP listener (default:
  loopback, left alone).
* It reaches an application service **by HTTP only** (`reqwest`, the `url` of
  the registration) — not over a Unix socket, as the plan of stage 1 assumed.
* A mautrix bridge has **one** listener for the application-service API and
  the provisioning API: TCP, or a Unix socket when `appservice.hostname` is an
  absolute path. It reaches the homeserver over `unix://…` as well.

So the bridge listens on its Unix socket (the server needs the provisioning
API there, and no port shall exist), and a **relay** (`socat`, service
`bruecken-<network>-relay`) in the homeserver's closed network hands the
homeserver's HTTP calls to that socket.

## Images

Pinned by version and digest in `src/services/bridges/images.js` and in both
compose files (a test keeps them in step):

| Service | Image | Version | Digest (multi-arch index) |
|---|---|---|---|
| `bruecken-hs` | `ghcr.io/matrix-construct/tuwunel` | v1.9.4 | `sha256:0e86c6164d6c9f5b60291938eb61ad8395021c37fe58d47a963ea7edddbedaec` |
| `bruecken-whatsapp` | `dock.mau.dev/mautrix/whatsapp` | v0.2610.0 (mautrix-go v0.32.0) | `sha256:c807054cb015d0f5c90d20d85aac216d062b4a6f4ae834b931fd5e7f03e27391` |
| `bruecken-whatsapp-relay` | `alpine/socat` | 1.8.1.3 | `sha256:71131702f671a88b3808a70b7330f9679cd9b9933adcafadc191508edfe55bba` |
| `bruecken-signal` | `dock.mau.dev/mautrix/signal` | v0.2610.0 (mautrix-go v0.32.0, libsignal 0.105.0) | `sha256:39afa721aa69472b2e91c75bd7d81a739e47f7e480fc0ff5ac8247af28eb2d0a` |
| `bruecken-signal-relay` | `alpine/socat` | 1.8.1.3 | (as above) |
| `bruecken-telegram` | `dock.mau.dev/mautrix/telegram` | v0.2610.0 (the Go version, mautrix-go v0.32.0; stage 7b, started only with the administrator's application id) | `sha256:ed3f3b39289fae425a875311d8875729271c24f88ba03209bd1bfbaf31e6c78f` |
| `bruecken-telegram-relay` | `alpine/socat` | 1.8.1.3 | (as above) |

The digests are the `Docker-Content-Digest` of the tag's manifest list at the
registry (amd64 and arm64 in each). The fallback homeserver, should Tuwunel
not work out in the probe, is continuwuity; it has no configuration-file
registration of application services (admin command only), so the change is
more than swapping an image.

`update.sh` reports the image each container runs (`.Config.Image`); a
container on another reference than the pinned one shows as **outdated**
(`networks[].outdated`, `wantVersion`). Since stage 5 (marker 8) the server
hands its pins to `update.sh` with every config file (`"bridges_images"`), and
`update.sh` writes them into a compose override of its own
(`.bruecken-images.yml` next to `docker-compose.yml`, used for `up` only): a
GateControl release with a new pin updates the containers at the next run of
the script, without a new `docker-compose.yml`. `update.sh` takes a reference
only when it is a `<tag>@sha256:<digest>` of the repository it knows for that
name (`bridge_repo`: Tuwunel, mautrix-whatsapp, socat) and only for a service
the compose file has — nothing unpinned is ever pulled, and a compromised
server cannot name another image. With an older script (or no pins) the
`docker-compose.yml` on the host decides as before; it is replaced by hand,
`update.sh` does not touch it.

A second kind of "outdated": WhatsApp itself turns the bridge's version away
(the bridge's state error `wa-client-outdated`, "405 client outdated",
mautrix-whatsapp `pkg/connector/handlewhatsapp.go`) — `networks[].clientOutdated`
(seen in a login during the last day). Only a newer pin helps, i.e. a
GateControl update. After the file was replaced, `update.sh`
runs `compose up` again for the containers it started (it remembers the
file's checksum next to the configuration revision in `.bruecken-managed`).

## Containers

All three: `read_only`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`,
`cpus`, `mem_limit`, a health check, log rotation, no published port, mounts
only below `./data/bridges` (`GC_BRIDGES_DIR`, set by `update.sh` when the
data directory is somewhere else).

* They run as root with exactly one capability, `DAC_OVERRIDE`: the
  GateControl container re-owns everything under `/data` at each start
  (`chown -R gatecontrol`), so a fixed user id inside the bridge containers
  would lose its files with the next GateControl restart.
* The bridge is started as `/usr/bin/mautrix-whatsapp --config … --no-update`,
  not through the image's `docker-run.sh` (which chowns `/data` and edits the
  configuration with `yq`): the configuration is GateControl's, mounted
  read-only, never rewritten.
* `mem_limit` 384 MB (homeserver), 512 MB (bridge), 32 MB (relay) and one CPU
  each are **provisional upper bounds**, not measured needs.

## Configuration

`src/services/bridges/config.js` writes, before `update.sh` is asked for
anything (`wish()`, called whenever the host file is written):

```
/data/bridges/secrets.json                 the master key (0600), stage 1
/data/bridges/hs/config/tuwunel.toml       homeserver
/data/bridges/hs/data/                     its database (RocksDB)
/data/bridges/hs/run/hs.sock               its socket (the bridge sees the folder read-only)
/data/bridges/whatsapp/config/config.yaml  bridge
/data/bridges/whatsapp/data/whatsapp.db    its database (SQLite)
/data/bridges/run/whatsapp.sock            its socket (the relay sees the folder read-only)
```

Idempotent (same master key → same files; a file is rewritten only when its
content differs). A hash of the files travels to `update.sh` as
`"bridges_rev"`; a new revision recreates the containers.

**Every key is one the pinned version documents** — the key lists in
`tests/fixtures/bridges/` come from the example configurations of the release
tags, and `tests/bridges_config.test.js` checks each written key against
them. The homeserver runs with `error_on_unknown_config_opts = true`, so a
wrong key stops it at start instead of being ignored.

Homeserver (`tuwunel-example.toml` of v1.9.4): `server_name`,
`database_path`, `unix_socket_path`, `error_on_unknown_config_opts`,
`allow_registration`, `allow_guest_registration`, `allow_federation`,
`federate_created_rooms`, `federate_admin_room`, `grant_admin_to_first_user`,
`trusted_servers`, `new_user_displayname_suffix`, `db_cache_capacity_mb` (32;
default "128.0 + (64.0 * CPU core count)"), `db_write_buffer_capacity_mb`
(16; default "48.0 + (4.0 * CPU core count)"), `cache_capacity_modifier`
(0.25), `allow_local_presence`, `allow_incoming_presence`,
`allow_outgoing_presence`, `log`, `log_colors`; per application service
`url`, `as_token`, `hs_token`, `sender_localpart`, `rate_limited`,
`receive_ephemeral` and the namespace `users` (`exclusive`, `regex`). Two
registrations: the bridge (`whatsapp`) and the server itself (`gatecontrol`,
no `url`, namespace `@gc_.*`) — the server makes a person's internal account
with it before their first link (`hs.js`, `m.login.application_service`).

Bridge (mautrix-go v0.32.0 `bridgev2/matrix/mxmain/example-config.yaml` and
mautrix-whatsapp v0.2610.0 `pkg/connector/example-config.yaml`; only what
differs from the built-in defaults is written, the bridge fills in the rest):
`homeserver.address` (`unix://…`), `.domain`, `.software`;
`appservice.address`, `.hostname` (the socket path), `.port`, `.id`,
`.bot.username`, `.ephemeral_events`, `.as_token`, `.hs_token`,
`.username_template`; `database.type` (`sqlite3-fk-wal`), `.uri`
(`file:…?_txlock=immediate`, as the example recommends), `.max_open_conns`,
`.max_idle_conns`; `bridge.personal_filtering_spaces`,
`.bridge_status_notices`, `.permissions` (the internal server only, as
`user`); `matrix.federate_rooms`, `.delivery_receipts`,
`.message_status_events`; `provisioning.shared_secret`,
`.allow_matrix_auth`, `.debug_endpoints`, `.enable_session_transfers`;
`backfill.enabled`; `double_puppet.*` (emptied — the defaults carry example
servers); `encryption.allow/default/require`; `logging`;
`network.history_sync.max_initial_conversations` (0),
`.request_full_sync`, `.media_requests.auto_request_media` (and, with the
administrator's switch since gc.bridges version 13, `.request_method` — see
[Old media from the phone](#old-media-from-the-phone-gcbridges-version-13));
`network.displayname_template` (`{{or .BusinessName .PushName}}`, see
[Names](#names)).

### Names

mautrix-whatsapp v0.2610.0 names a contact's account ("ghost") with
`{{or .BusinessName .PushName .Phone .RedactedPhone "Unknown user"}} (WA)`
(`pkg/connector/example-config.yaml`, `config.go formatDisplayname`): as long
as it knows no push name — right after a link, before the contact wrote — the
name **is the phone number**, and the DM room's name follows the ghost
(bridgev2 `private_chat_portal_meta`, `Portal.UpdateInfoFromGhost`). Found in
the first real test: a chat „+49… (WA)“. Therefore:

* the template is `{{or .BusinessName .PushName}}` — what the contact shows
  publicly, no number, no suffix (the apps mark the network themselves). Not
  `.FullName`: that is the name in the *linking person's* address book, and a
  ghost is shared by everybody who has that contact (its name and every
  member event carry it into the other person's rooms). No name → empty.
* every name leaves the server through `services/bridges/names.js`: the
  suffix ` (WA)` goes, a name that is only a number (≥ 5 digits, or the
  bridge's redacted form with `∙`) and „Unknown user“ become `null` — room
  names, member names, contact lists, `resolve`/`createDm`. A ghost keeps its
  old name until the bridge syncs it again (push name, contact sync after an
  app state sync); the check covers that time too.
* the plugin names a chat without a name after the person's own address
  book (Mail, by `matchNumbers` — the number never leaves the server) and
  otherwise with a neutral label („WhatsApp-Kontakt“).

**Sparing with the disk** (the server's does about 38 ms per fdatasync):
small homeserver caches and no presence; the bridge's SQLite driver
`sqlite3-fk-wal` sets `journal_mode = WAL` and `synchronous = NORMAL`
(go.mau.fi/util v0.11.0, `dbutil/litestream/register.go`) — a sync per
checkpoint, not per transaction; **no history**: `backfill.enabled: false`
and no rooms for old conversations at login (`max_initial_conversations: 0`,
a room appears with its first new message); no end-to-bridge encryption
inside the internal server, no spaces, no status notices. RocksDB options of
the homeserver (`rocksdb_optimize_for_spinning_disks`, `rocksdb_direct_io`)
stay on their defaults until the probe shows a reason.

## Messages (stage 3)

How a message gets from the outside messenger into a plugin and back. Nothing
of this was run against the real programs in development — it is read from
the sources of the pinned versions and tested against stand-ins
(`tests/bridges_messages.test.js`, `tests/helpers/fake-homeserver.js`).

```
bridge ──events──▶ homeserver ──PUT /_matrix/app/v1/transactions/{txnId}──▶ bruecken-core-relay (socat)
                                                                                  │ Unix socket data/bridges/run/core.sock
                                                                                  ▼
                       appservice.js (hs_token, constant-time)  ─▶  events.js  ─▶  bridge_inbox (sealed)
                                                                                  │ hook bridgeEvents, gc.bridges.events.pull / ack
                                                                                  ▼
                                                                              the plugin
plugin ──gc.bridges.send / react / redact / read / typing──▶ hs.js ──client API as @gc_<id>──▶ homeserver ──▶ bridge
```

**Why transactions and not `/sync`.** The server is registered as the
application service `gatecontrol`; with a `url` the homeserver pushes every
event of the rooms its accounts are in. It keeps that queue in its own
database and deletes an entry only after HTTP 200, retrying after 2, 4, … 512
seconds — so nothing is lost while GateControl restarts, and GateControl keeps
no position of its own. The transaction id is a hash of the events and stays
the same for a retry: `bridge_txns` remembers the last 2000, a transaction is
taken once. Polling `/sync` per person would need a stored position per
account, a reload of cut-off timelines after a pause, and an open request per
person. Price of the push: one more relay container, so the
`docker-compose.yml` on the host has to be replaced once (`update.sh` marker 7
starts `bruecken-core-relay` when the file has it and reports
`"core-relay":{"present":false}` when not; `status().messages.relay` says
`missing`).

**Whose room.** The bridge runs with `split_portals`: every person gets rooms
of their own, also for a group two people are in. `bridge_rooms` maps a room
to one person, one network and a random reference (`r…`) — the only thing a
plugin sees of a room. A room is taken over when the bridge invites the
account (the server accepts) or joins it itself (double puppeting: the
registration `gcpuppet` has no address, the bridge acts with its token for
`@gc_…`). What was said before the account was in the room — the very message
that made the bridge open it — is fetched once (`GET …/messages`, 30 events).
An invite for a second person into a known room, or from an account that is
no bridge, is ignored.

**Neutral events** (`events.pull`), each with `seq`, `userId`, `network`,
`chat: { id, kind: 'direct' | 'group', name, avatar?, channel?, readOnly? }` (`avatar` since stage 4, `channel` / `readOnly` since version 7 — see "Channels, groups, format"), `at` (ms):

| `type` | Fields |
|---|---|
| `chat` | the chat became known or changed its name / kind; `closed: true` when the account left |
| `message` | `id`, `sender`, `kind: 'text' \| 'notice' \| 'media' \| 'unsupported'`, `text`, `marks?`, `preview?` (version 7), `replyTo` (a message id or null), `media: { kind: 'image' \| 'video' \| 'audio' \| 'voice' \| 'file' \| 'sticker' \| 'location', name }` for `media` — since stage 4 with `ref` and the file's details (see "Files") |
| `edit` | `id`, `sender`, `target`, `text`, `marks?`, `preview?` (version 7) |
| `redact` | `id`, `sender`, `target` — a message or a reaction |
| `reaction` | `id`, `sender`, `target`, `emoji` |
| `status` | `target`, `status: 'sent' \| 'delivered' \| 'failed'`, `reason`, `retriable` — the bridge's word on a message GateControl sent (`com.beeper.message_send_status`); `delivered` only in direct chats |
| `contact` | `contact: { id, name, avatar }` — a contact's name or picture changed |
| `lost` | a row that could not be opened (the bridges' folder was replaced) — acknowledge it |

`sender`: `{ id, name, avatar }` (a contact; `id` is an HMAC of the bridge's address,
`c…`), `{ self: true }` (written by the person in the messenger's own app) or
`{ system: true }` (the bridge itself) — since version 7 `{ channel: true, system: true }` for a channel's post. Messages GateControl sent itself do
not come back. Not stored, only in the hook's payload: `typing`
`{ chat, contacts: [id] }` and `receipt` `{ chat, upTo, reader }`.

No Matrix address, no room id and no phone number is in any of it; message ids
are the homeserver's event ids (hashes). The inbox is sealed with a key derived
from the master key, so texts of other people are not readable in the server's
database or its backups; rows go when the plugin acknowledges them, at the
latest after 14 days. A person's rooms and waiting events go with their
account (foreign keys).

**Out.** `send` (text, `replyTo`, `edit`), `react`, `redact`, `read`, `typing`
— each as the person's internal account, only while that person has a
changing request in flight. There is no queue in the server: when the bridge
is away the call fails (`ERR_BRIDGE_UNREACHABLE`) and the plugin shows it.

**Changed for this in the configuration** (every key is in the fixtures):
homeserver — `url` and `receive_ephemeral` for `gatecontrol`, the registration
`gcpuppet`; bridge — `double_puppet.secrets`, `bridge.split_portals: true`
(irreversible; nothing used the rooms before), `matrix.message_status_events:
true`, `matrix.message_error_notices: false`, `appservice.bot.avatar: remove`
(the default picture lies on another server, which an island never reaches —
the likely source of the line "Federation is disabled" at the homeserver's
start; that line comes from `validate_request_destination` and is harmless),
`logging.min_level: warn` (zeroconfig: "levels below the global min_level are
never logged" — the info and debug lines are the ones that name chats and
accounts).

**Not in this stage:** files of any kind (stage 4; until then `media` with
kind and name), starting a chat with a new number (the provisioning API has
`resolve_identifier` and `create_dm`; it needs a dialog in the clients),
contact pictures, history.

## Files (stage 4)

Read from the sources of the pinned versions, tested against the stand-ins
(`tests/bridges_media.test.js`); not run against the real programs.

```
in   bridge ──upload──▶ homeserver ──event with mxc://──▶ events.js: media.ref (sealed) ─▶ plugin
     plugin ──gc.bridges.media.fetch(userId, network, ref)──▶ hs.js GET /_matrix/client/v1/media/download/…
            ──stream──▶ media.storeStream (sealed on disk, virus scan "bridge") ──▶ { mediaId, mime, bytes, name, scan }
out  plugin ──gc.bridges.send(…, { media: { mediaId, kind } })──▶ media.readRange (only if the scan let it through)
            ──stream──▶ hs.js POST /_matrix/media/v3/upload ──▶ m.image / m.video / m.audio / m.file ──▶ bridge
```

**In.** A `message` of kind `media` carries `media: { kind, name, ref, mime,
size, w, h, durationMs, waveform? }`. `ref` (`m…`) is the file's mxc://
address and the person it was delivered for, sealed with a key derived from
the master key (AES-256-GCM, the nonce derived from the content: the same file
for the same person always gives the same ref — a plugin can tell "unchanged",
nothing else can be read). A file of another server or an encrypted one
(`file` instead of `url`; the rooms of the bridges are not encrypted) has no
ref. A location has no file: `media.geo { lat, lon }` from `geo_uri`.
`gc.bridges.media.fetch(userId, network, ref, { name })` needs no person — it
sends nothing and reads only what was delivered for that person — and stores
into **this** plugin's media: the size limit (`media.maxBytes`) is checked
against the homeserver's Content-Length before a byte is read (an answer
without Content-Length, sent chunked, is counted as it arrives and stopped at
the limit), the type must be one of `media.types` (any other file that is
no picture, sound or video is kept as `application/octet-stream`, a download),
the quota and the room on the server as for every file. The bytes go straight
from the socket into the sealed file (one fsync, as for every file); the
virus scan checks them as a file of that plugin (scan kind `bridge`; for the
messenger the source "messenger"), a later result comes with the hook
`mediaScanned`. Refusals: `ERR_MEDIA_TOO_LARGE`, `ERR_MEDIA_TYPE`,
`ERR_MEDIA_QUOTA`, `ERR_BUSY` (scan unavailable and uploads held),
`ERR_BRIDGE` (`m_not_found`, `bad_answer`), `ERR_BRIDGE_UNREACHABLE`,
`ERR_INVALID` (a ref of another person, or of another installation). Every
refusal is written to the server's log once per plugin, code and reason an
hour („bridges: a file was not fetched“, `code`, `reason`, `detail` — never
the ref, a name or an address): a file that keeps „loading“ shows there.

**Pictures.** The picture of a chat (`m.room.avatar`; with
`private_chat_portal_meta` also the contact's picture in a direct chat) is
`chat.avatar`, a contact's (`avatar_url` of its membership) `sender.avatar` /
`contact.avatar` — refs like a file's, `null` when there is none, missing when
the event does not know it. Fetched the same way.

**Out.** `send(…, { txnId, text?, replyTo?, media: { mediaId, kind: 'image' |
'video' | 'audio' | 'voice' | 'file', name?, w?, h?, durationMs?, waveform? } })`:
the plugin's own stored file, only when the virus scan lets it be served
(`ERR_MEDIA_SCAN_PENDING`, `ERR_MEDIA_QUARANTINED`, `ERR_MEDIA_BLOCKED`
otherwise), read chunk by chunk and streamed to the homeserver; what was
uploaded is remembered per file (memory), so sending again uploads nothing.
The content is what mautrix-whatsapp reads (`pkg/msgconv/from-matrix.go`,
`constructMediaMessage`, `reuploadFileToWhatsApp`): `body` = the caption or
the name, `filename`, `info { mimetype, size, w, h, duration }`; a voice
message is `m.audio` with `org.matrix.msc3245.voice` (PTT) and
`org.matrix.msc1767.audio { duration, waveform }` (values ≤ 255 are taken as
they are). What the bridge takes (`pkg/connector/capabilities.go`): pictures
`image/jpeg` (png and webp are converted to JPEG), videos `video/mp4` /
`video/3gpp`, sound and voice `audio/ogg` (taken as Opus), `audio/mp4`,
`audio/aac`, `audio/mpeg`, `audio/amr` — **not** `audio/webm` —, files of any
type, up to 2000 MB. The plugin checks this before it sends.

**Homeserver.** `max_request_size` is raised from 24 MiB to 32 MiB, so a file
up to the messenger's 25 MB goes through in both directions (Tuwunel holds a
request in memory). The homeserver keeps its own copy of every file that
crossed — removing it needs its admin API (stage 5, with storage targets).

## A new chat by number (stage 4)

`gc.bridges.resolve(userId, network, number)` → `{ found: true, name } |
{ found: false }` and `gc.bridges.createDm(userId, network, number)` →
`{ chat: { id, kind: 'direct', name } }` — the provisioning API's
`GET /v3/resolve_identifier/{id}` and `POST /v3/create_dm/{id}`
(bridgev2 `provisionutil.ResolveIdentifier`; WhatsApp asks "is this number on
WhatsApp", `startchat.go validateIdentifer`). Inside a changing request of
that person; the number must be `+` with the country code (spaces, dashes,
brackets and a leading `00` are taken), else `ERR_INVALID` / `invalid_number`.
At most 20 numbers per person and hour (`ERR_RATE_LIMIT` with `retryAfterS`)
— every number is a question to WhatsApp. Of the answer only the name and the
room go on, and the contact's reference as the events name it (`contactId` = `sender.id`); the bridge's id, address and identifiers (they hold the number)
and its error texts (they name the number) stay out, and the number is never
written to a log or a table. `createDm` knows the room at once (state
`invited` in `bridge_rooms`, the plugin has the chat reference straight away);
its join brings name and kind as usual, sending works as soon as the account
is in the room.

## Contacts (stage 4c)

`gc.bridges.contacts(userId, network, { query? })`, `matchNumbers(userId, network, numbers)` and
`createDmByRef(userId, network, ref)` (gc.bridges version 6) — „Neuer Chat“ with the person's WhatsApp contacts
instead of a typed number. The provisioning API's `GET /v3/contacts` and `POST /v3/search_users { query }`
(bridgev2 `provisionutil.GetContactList` / `SearchUsers`: `{ contacts | results: [RespResolveIdentifier] }`;
mautrix-whatsapp `startchat.go getContactList` reads the bridge's own contact store — no question to WhatsApp). Of
each contact only the name, the picture (as a reference for `media.fetch`, like `contact.avatar`) and the person's
chat with it (`dm_room_mxid` → the chat reference, only when that room is the person's) go on, and the contact's reference as the events name it (`contactId` = `sender.id`); the bridge's id, the
ghost's Matrix id and the identifiers (`tel:+…`) stay in this module. In their place a sealed reference (`k…`,
AES-256-GCM with a key that exists only in this process): person, network, the ghost's Matrix id (or the bridge's id)
and the time — it opens only for that person and network, for 30 minutes, until the server restarts.
`createDmByRef` hands the ghost's Matrix id to `POST /v3/create_dm/{id}` (`ResolveIdentifier`: `ParseGhostMXID` →
`CreateChatWithGhost`, no `IsOnWhatsApp`) and adopts the room like `createDm`; it does not count against the 20
numbers per hour. `matchNumbers` compares the person's numbers (e.g. of their address book, handed in by the plugin)
with the identifiers of that list — nothing else is read, nothing counted, nothing kept. The list is held in memory
for 10 minutes per person and network (a search is not kept), never written to a table or a log.

## History (stage 5)

How the pinned bridge loads older messages (read from mautrix-whatsapp v0.2610.0 and mautrix-go v0.32.0, not run):

* WhatsApp sends the recent history **once, at the link** (history sync notifications of the phone). The bridge keeps
  it only with `backfill.enabled` (`pkg/connector/handlewhatsapp.go`: `saveWAHistorySyncNotification` only then);
  without it the blob is neither downloaded nor stored. It lands in the bridge's database
  (`whatsapp_history_sync_conversation` / `_message`).
* `network.history_sync.max_initial_conversations`: rooms for this many recent chats right after the link
  (`createPortalsFromHistorySync`), each filled with up to `backfill.max_initial_messages` messages ("forward
  backfill", `bridgev2/portalbackfill.go` `doForwardBackfill` → `sendLegacyBackfill`: one event per message, with its
  own time in the past, and the files re-uploaded to the homeserver). Every other chat gets its stored history when its
  next message makes the room. Afterwards the bridge deletes what it backfilled from its own tables.
* The backfill **queue** (`backfill.queue`, batches, `batch_delay`, `max_batches`) and the provisioning endpoint
  `POST /v3/backfill/{room}` only work against a Beeper homeserver ("standard Matrix servers don't support inserting
  messages into history", `bridgev2/matrix/provisioning.go` `PostPaginate` needs `BatchSending`). On Tuwunel there is
  no "later, in batches, at night" in the bridge — and no per-person switch: the configuration is global.

So the split:

* **Bridge (global):** with history allowed (`bridges.history`, on by default; card „Brücken“ → `configure({ history })`)
  `backfill: { enabled: true, max_initial_messages: 200, max_catchup_messages: 100, queue: { enabled: false } }` and
  `history_sync.max_initial_conversations: 30`, never `request_full_sync`; `auto_request_media` (requests to the phone
  for files that ran out) only with the administrator's switch of version 13 (see "Old media from the phone"). Off: as
  in stage 3. A change rewrites the configuration (new revision → `update.sh`
  recreates the containers).
* **Server (per person):** an event is **history** when it is older than the person's link (`bridges.linked_at`,
  noted when a link completes) **and** older than the room is here (`bridge_rooms.created_at`), each minus a minute.
  A late message (bridge or phone away) is newer than the link and never history; a link from before stage 5 has no
  time, so nothing is history for it. What the person chose (`history.set`: `0` none, `30` days — the default — or `-1`
  everything) decides: unwanted history is **never written** (one check per event, no row); wanted history goes to
  `bridge_backlog` (sealed like the inbox, marked `history: true`). Before a live event of the same chat is filed, the
  chat's waiting history moves into the inbox ahead of it, in the order it came — so the plugin fills a chat in order
  and keeps the event id unique per chat (nothing twice). Fewer days later drop what waits and is not wanted.
* **Plugin:** files the backlog at night in small portions (Messenger: 100 events a minute in its window, default
  01:00–05:00 in the time zone of the update window), without push, as read; files of the history only on request.

What it costs on the slow disk (estimates, nothing measured): the bridge writes the history sync into its SQLite in a
few large transactions and up to 30 × 200 events plus their files into the homeserver at the link (RocksDB; Tuwunel's
media folder). The server writes one commit per homeserver transaction, as before; the plugin one commit per portion.

## Backup (stage 5)

`src/services/bridges/backup.js`. A running RocksDB or SQLite is never copied, and the server has no Docker access:

1. Every night after `bridges.backup_time` (default 03:10, the update window's time zone) — or on „Jetzt sichern“
   (`configure({ backupNow: true })`) — the server writes a request id into the config file (`"bridges_backup"`).
2. `update.sh` (marker 8, while the bridges run) stops the bridge(s), then the homeserver, packs `hs/data` and
   `<bridge>/data` into `$DATA_DIR/bridges/backup/state-<id>.tar` (0600, owner of that folder), starts them again
   (`compose start`) and reports in `.bridges-backup.json` (`{ id, result, at, bytes }`). Downtime: as long as the
   tar takes plus the homeserver's start (the probe: about 4 s to open its database); the messengers hold messages back.
3. The server takes the file at its next tick (every 5 minutes): AES-256-GCM with a key of its own, that key encrypted
   with `GC_ENCRYPTION_KEY` (`utils/crypto`), → `backup/state.enc` + `state.json`; the plain file is deleted.
4. The GateControl backup carries `data.bridges`: `{ version: 1, created_at, master_key_enc, rooms: [bridge_rooms with
   user_name], snapshot: { id, at, bytes, iv, tag, key_enc, data } }` — `data` the encrypted snapshot (base64, read from
   a hard link; spooled on a restore like the plugins' parts). Both keys are ciphertexts of `utils/crypto`, so the
   off-site re-key converts them; `validateEncryptedFields` checks them.
5. Restore (`restoreBackup` → `restorePart`, after the users): the master key back into `secrets.json` (the one before
   as `secrets.json.before-restore`), the rooms of people whose id stayed the same (the internal account is
   `@gc_<id>` — a person with a new id starts anew after a new link), inbox/backlog/transactions/file notes emptied; the
   snapshot decrypted to `backup/restore-<id>.tar` and `"bridges_restore":"<id>"` in the config file. `update.sh` checks
   every member (plain files and folders only, below `hs/data` or `<bridge>/data`, no `..`), stops the containers,
   keeps the current folders as `*.prev`, unpacks, reports in `.bridges-restore.json`; the next run starts them. A file
   the host did not take within a day is deleted again.

## Files at the homeserver (stage 5)

Every file a message of a room carries is noted in `bridge_media` (`mxc` address, person, state; no name). After the
plugin took it over (`media.fetch` → `mediaFetched`), after it was history nobody wanted, or after 30 days nobody
fetched it, the server deletes it at the homeserver: Synapse admin API `DELETE /_synapse/admin/v1/media/<server>/<id>`
(Tuwunel serves it, `src/api/client/admin/media/delete_media.rs`), as the server's own bot `@gcbot` — the homeserver
makes it its administrator at every start (`admin_execute = ["users make-user-admin @gcbot:gc.internal"]`,
`admin_execute_errors_ignore`), the bot takes its seat in `#admins:gc.internal` at its first refusal. The bot has no
password and no device; its token never leaves the server; the homeserver has no port. A file waits an hour after it
was taken over (another person's copy of the same file may still be on its way). Pictures of chats and contacts are
not deleted (they are fetched again when they change). `status().cleanup`: `{ deleted, waiting, lastAt, error }`
(`no_admin` until the bot is an administrator).

## Health (stage 5)

`gc.bridges.health({ userIds, network })` reads `whoami` per person (no person's request needed; ≤ 100 people) and
returns each login's state without its id and name (WhatsApp names both after the number). mautrix-whatsapp reports a
phone not seen for **12 days** (`pkg/connector/phoneping.go`, `PhoneDisconnectWarningTime`; WhatsApp ends companion
devices after about 14) as `TRANSIENT_DISCONNECT` with error `wa-phone-offline` while still connected — the server
passes `state: connected`, `phoneOffline: true`, `since` (when the bridge said so; it re-evaluates at each reconnect,
so the time is a lower bound). The plugin turns it into a push and the hint in „Verknüpfte Dienste“.

## Login references (stage 5)

A bridge names a login by its own id — mautrix-whatsapp by the person's phone number. That id never leaves the server:
`logins()` and a completed login step give a reference (`l` + 22 characters, HMAC with a key derived from the bridges'
master key over person, network and id), `logout(userId, network, ref)` asks the bridge for the person's logins and
ends the one whose reference matches. `unlinkFor` and `health` use the bridge directly and pass no id at all. The
messenger replaces what older versions kept (`bridge_links.login_id`) with a keyed hash at its start.

## Probe

`./update.sh bridges-probe [seconds]` on the host (as root, in the install
folder) reads and measures, it changes no setting:

1. nothing happens when the bridges are not switched on;
2. it starts the wanted containers (the same way a cron run would), waits up
   to 3 minutes for them and their sockets;
3. it measures for `seconds` (default 60, 10…900): memory per container (now
   and the highest value seen, `docker stats`), what each wrote
   (`/proc/<pid>/io` of the main process and `docker stats` BlockIO),
   restarts, OOM kills, health;
4. it writes `/data/.bridges-probe.json` — the numbers, the image references
   and the last 60 log lines per container, redacted (`probe_redact`): lines
   about linking (QR and pairing data, `wa.me` links), calls of the
   provisioning API, raw events and request bodies are left out entirely; in
   the rest Matrix addresses, WhatsApp ids, id fields, anything that looks
   like a key or token (20 characters and more) and runs of digits are
   blanked — and prints a summary.

`status().host.probe` passes the **numbers** on (the messenger's settings
show them); the log lines stay in the file.

## Channels, groups, format (gc.bridges version 7)

"Chats v2 – Teil A". Read from the sources of the pinned versions (mautrix-whatsapp v0.2610.0, mautrix-go bridgev2) and
tested against the stand-in homeserver (`tests/bridges_channels.test.js`); not yet seen with a real channel.

**Kind of a chat.** bridgev2 writes `com.beeper.room_type.v2` into `m.bridge` only for a direct chat (`dm`, then also
`com.beeper.room_type: dm`) and a space (`bridgev2/portal.go` `getBridgeInfo`; the field has `omitempty`). A WhatsApp group
and a channel are `RoomTypeDefault` (`pkg/connector/chatinfo.go` `wrapGroupInfo`, `wrapNewsletterInfo`) — the field is
missing, and before version 7 every group stayed `direct`. Now the kind is read from the chat's id at the bridge,
`m.bridge` → `channel.id` (`waid.MakePortalID`: the WhatsApp JID): `…@g.us` a group, `…@newsletter` a channel,
`…@s.whatsapp.net` / `…@lid` a person. The id never leaves `events.js` (like a phone number).

**`chat` fields** (whenever the room's state is known, so in every `chat` event): `channel` — a channel the person follows
(`kind: 'group'`); `readOnly` — the person may not write: their level in `m.room.power_levels` (`users[@gc_<id>]`, else
`users_default`) is below the one of `m.room.message` (`events`, else `events_default`). A channel has
`events_default: 50` and the follower 0 (`wrapNewsletterInfo`), a WhatsApp group "only admins" `events_default` = the
admin level (`wrapGroupInfo`, `IsAnnounce`). A change of the power levels sends a new `chat` event. `gc.bridges.chats()`
names both too (`bridge_rooms.channel`, `read_only`, migration 150).

**A channel's posts** come from the bridge's own account (`pkg/connector/id.go` `makeEventSender`: `NewsletterServer` →
`EventSender{}`, "Send as bot"). In a channel the sender is `{ channel: true, system: true }` (`system` for plugins that
only know version 6: they keep showing a notice), the post a `text` or `media` message — not a `notice` — and its edits,
deletions and other kinds (`unsupported`) pass like a contact's. The bridge's own messages elsewhere stay notices.

**Format** (`format.js`). mautrix-whatsapp keeps WhatsApp's markers (`*bold*`) in `body` and writes HTML into
`formatted_body` (`pkg/msgconv/wa-text.go`). A `text` (also an `edit`, a caption) gets the text of that HTML and
`marks: [{ type: 'bold' | 'italic' | 'strike' | 'code' | 'link', start, end, url? }]` — offsets in UTF-16 code units of
`text`, end exclusive, marks may nest; `link` only for an http(s) address written as a link (never a mention — those are
`matrix.to` addresses of the bridge's accounts — or another scheme). Lines (`<br>`, blocks) become `\n`, list items
`• ` / `1. `, a quote `> `. The parser is strict: a tag, attribute or entity it does not know, or tags that do not fit,
and the HTML is dropped — the message carries its plain `body`, without `marks`. No HTML ever reaches a plugin. Plain
addresses in a text are no marks: the apps make them clickable themselves (in every chat).

**Link preview.** `com.beeper.linkpreviews` (MSC4095; `pkg/msgconv/urlpreview.go`) → `preview: { url, title, description,
site, image: { ref, mime, w, h, size } | null }` on a `text` message or `edit` — the first one, an http(s) `url` only (an
address without a scheme gets `https://`), `site` = `og:site_name` or the host. The picture is a file reference like
`media.ref` (fetched with `media.fetch`, noted in `bridge_media` for the clean-up).

**History of a channel.** When a channel is opened its newest 10 posts are fetched (not 30); of the history the bridge
brings at a new link (`backfill.max_initial_messages`, up to 200 per chat) a channel keeps the newest 10 in
`bridge_backlog` (`channelTrim` — with what belongs to them; the files of the others are marked unwanted). The bridge
cannot be told to leave channels out of the 30 conversations it fills at a link: `history_sync.max_initial_conversations`
counts every conversation of WhatsApp's history sync by its last message (`pkg/connector/backfill.go`,
`wadb/conversation.go` `getRecentConversations` — no filter by kind, no setting per kind). Whether WhatsApp's history
sync includes channels at all is open (not seen with a real phone).

**Rooms from before.** `bridge_rooms.channel` is NULL for a room known before version 7. Its next event, or
`refreshRooms()` (20 rooms per tick of `index.js`), reads its state again and sends a `chat` event when kind, channel or
readOnly differ — a group that was `direct` becomes `group` in the plugin without a new message.

**Reactions** go out as before (`react`); `HandleMatrixReaction` has no special case for a channel — whether WhatsApp takes
a reaction on a channel post is open. A refusal comes back as a `status` event (`failed`) with the reaction's id as
`target`. The bridge passes on no reaction counts of a channel.

## Signal (stage 7a, gc.bridges version 10)

A second bridge next to WhatsApp, read from the sources of mautrix-signal v0.2610.0 (and mautrix-go v0.32.0) and tested
against the stand-ins (`tests/bridges_signal.test.js`, `tests/helpers/fake-bridge.js` with `network: 'signal'`); not
yet run with a real Signal account.

**Containers.** `bruecken-signal` and `bruecken-signal-relay` (socat, port 29320) in the profile `bruecken`, the same
rules as WhatsApp's (`read_only`, one capability, no port, its own socket `run/signal.sock`, `mem_limit` 384 MB — an
upper bound, not measured). The release `docker-compose.yml` carries `bruecken-telegram` and its relay (29321) already,
so that the file is replaced once for both; the server never asks for Telegram before stage 7b (it needs the
administrator's Telegram application id). The pin is the `Docker-Content-Digest` of the manifest list at
`dock.mau.dev` (checked against the registry, amd64 and arm64).

**update.sh marker 10.** `bridge_repo` takes a pin for `signal` / `telegram` only from `dock.mau.dev/mautrix/signal` /
`…/telegram` (their relays from `alpine/socat`). A wanted bridge whose service the host's `docker-compose.yml` lacks is
left out — the others run — and reported as `"<name>":{"present":false}`; `status().networks[].needs` is then
`compose` (the messenger's settings ask to replace the file once). The server asks for Signal only from marker 10 on
(`needs: 'script'` before; update.sh updates itself after a GateControl update). `probe_redact` drops lines with
`sgnl:`, `linkdevice`, the transfer archive, `tg:`, `t.me/`, login tokens and passwords, and blanks UUIDs (Signal's
account ids, also `PNI:…`), Base64 runs of 20 characters and more (with `/`: Signal's group ids), more id fields
(`aci`, `pni`, `service_id`, `group_id`, `e164`, `number`, `username`, `peer_id`, …) and long runs of digits.

**Configuration** (`config.js`, every key in `tests/fixtures/bridges/keys-mautrix-signal-0.2610.0.json`):
`network.displayname_template: '{{or .ProfileName ""}}'` (only the name the contact shows in their Signal profile —
the default falls back to the number; `ContactName` and `Nickname` are the linking person's and "not safe on
multi-user instances"), `number_in_topic: false`, `use_contact_avatars: false`, `device_name: GateControl` (as Signal
shows it in "Linked devices"), `note_to_self_avatar: ''` (the default lies on another server);
`bridge.view_limited_media: true`; `logging.min_level: warn`; spaces off as for WhatsApp.

**Login.** QR code only (`login.go`: the one flow `qr`; `NET.signal.flows`): `login.flows` filters, `login.start`
refuses any other flow before the bridge is asked. The code is `sgnl://linkdevice?…`; Signal renews it every 45 s — the
waiting step answers with a new `display_and_wait` step (same step id, new data). The login is named by the account's
ACI (a UUID), with the number as its name; `logins()` passes a name only when it is a number (an account without a
visible number has no name, never its id). The bridge's own texts never leave the server — its last one is
"Successfully logged in as <number> / <ACI>": every step gets our own `instructions`, field names and descriptions
are emptied (all networks).

**History.** With `backfill.enabled` (history allowed) the bridge asks the phone for the transfer archive at the link
(`PerformProvisioning(…, Backfill.Enabled)`), the phone asks the person, and the bridge makes a room for every chat of
it (`chatsync.go`), filled by the forward backfill from the archive. Once: later there is nothing (`FetchMessages` reads
only the archive's tables). `historyOf(userId, 'signal')` caps the person's choice at **30 days**
(`NET.signal.historyDays`, also for "everything"); the rest is never written. The plugin files it at night as before.

**Events.** Kind from the chat's id (`m.bridge` → `channel.id`): 44 characters of Base64 a group, a UUID /
`PNI:<uuid>` a person (`pkg/signalid` `ParsePortalID`). Disappearing messages: the state
`com.beeper.disappearing_timer { type, timer }` → `chat.timer: { type: 'after_read' | 'after_send', seconds } | null`
(in every `chat` event that knows the room's state; a change sends one); the bridge's notice about it
(`com.beeper.action_message` type `disappearing_timer`) is a `notice` with `action: { type: 'timer', seconds }`; the
bridge deletes the messages itself (redactions). A sticker is `media.kind: 'sticker'` (the emoji as its name). A
view-once picture or video (`com.beeper.view_limited`, because of `view_limited_media`) is a message of kind
`unsupported` with `viewOnce: true` — no file, and the file at the homeserver is marked unwanted at once. Signal has no
channels.

**Erkennen.** `recognition.get / set(userId, …, network)` for `whatsapp`, `signal` and `telegram` (the profile keeps
one consent per network: `users.recognize_by_signal` / `_telegram`, migration 155). Signal accounts carry a fixed id
(the ACI): every whoami notes the keyed hash of the person's own (`profile.noteOwnAccounts`, `user_bridge_accounts`),
and `matchAccounts` compares a contact's ACI with it — `via: 'own_signal'`, strong, only with that person's consent;
numbers count where the bridge knows them (`tel:` identifiers) as for WhatsApp. User names never count. A profile
number the own Signal has becomes `state: 'signal'` ("Bestätigt über dein Signal"). Not solved by the bridge: it trusts
a contact's new safety number by itself (`IsTrustedIdentity`, TRUSTED_UNVERIFIED) and reports nothing — the apps say so
once per Signal chat.

**Animated stickers.** One switch for every bridge that converts them: `configure({ animatedStickers })`,
`status().stickers.animated`, off by default (a still picture). Signal sends its stickers as pictures and converts
nothing; Telegram (stage 7b) is the first bridge that uses the switch.

## Telegram (stage 7b, gc.bridges version 11)

A third bridge, read from the sources of mautrix-telegram v0.2610.0 (the Go version on bridgev2, mautrix-go v0.32.0)
and tested against the stand-ins (`tests/bridges_telegram.test.js`, `tests/helpers/fake-bridge.js` with
`network: 'telegram'`); not yet run with a real Telegram account. The pin was checked against the registry
(`Docker-Content-Digest` of the manifest list, amd64 and arm64); the image runs `/usr/bin/mautrix-telegram` and brings
`lottieconverter` and `ffmpeg`. Containers, relay (29321) and update.sh marker 10 as for Signal (both in the release
`docker-compose.yml` since 7a).

**The application id.** Telegram wants an id of its own for every program that logs in (my.telegram.org › API
development tools: `api_id`, a number, and `api_hash`, 32 hex digits). The administrator enters it once in the
messenger's settings: `configure({ telegramApp: { apiId, apiHash } })` (only inside a changing request of an
administrator; `null` removes it). The values are checked (5 to 10 digits, 32 hex digits, never the bridge's example
values) without being echoed in an error, kept in `/data/bridges/secrets.json` (0600) next to the master key as
`telegramApp: { enc, setAt, setBy }` — `enc` encrypted with `GC_ENCRYPTION_KEY` (`utils/crypto`), so a restored master
key does not lose it — and written in clear only into the Telegram bridge's configuration file (0600). No API returns
it: `status().telegramApp` is `{ set, setAt, setBy }`; the activity log says "Telegram-Anwendung hinterlegt / entfernt"
and who did it. Without it Telegram is not asked of update.sh (`wanted()`), its `status().networks[]` says
`needs: 'app'` (state `stopped`), and every call for a person answers `ERR_BRIDGES_UNAVAILABLE` / `no_app`. The
GateControl backup carries it as it lies (`data.bridges.telegram_app`, still encrypted); a restore puts it back when it
opens with that server's key. A changed `GC_ENCRYPTION_KEY` without a re-key means: enter it again.

**Configuration** (`config.js`, every key in `tests/fixtures/bridges/keys-mautrix-telegram-0.2610.0.json`):
`api_id` / `api_hash`, `device_info.device_model: GateControl` (Telegram › Settings › Devices),
`displayname_template: '{{.FullName}}'` with `contact_names: false` (the name the contact shows, not the linking
person's address book) and `contact_avatars: false` (no pictures only that person sees), `sync.create_limit: 15` and
`login_sync_limit: 15` (rooms for the 15 most recently active chats at a new link, the others with their first message),
`member_list.max_initial_sync: 100`, `sync_broadcast_channels: false`, no data export (`takeout.*: false`),
`bridge_communities: false`, `saved_message_avatar: ''`, `animated_sticker.target` `png` (the default: a still
picture) or `gif` (the administrator's switch `animatedStickers`), `bridge.view_limited_media: true`,
`logging.min_level: warn`.

**Login.** The flows `qr` and `phone` (`NET.telegram.flows`); the bridge's `bot` (a bot is no person) and `manual` (raw
session data) are never offered. By phone: a step with a `phone_number` field, then a `2fa_code` field (the code comes in
the Telegram app), then — when the two-step verification is on — a `password` field. A wrong code or password comes back
as the same kind of step with `retry: true` (the bridge's `….incorrect` step ids). By QR: `tg://login?token=…`, renewed
when it runs out (a new `display_and_wait` step, same step id), then the password step when it is on. Number, code and
password go from the plugin through `login.step` to the bridge's socket and nowhere else: not stored, not logged (no
host call's arguments are), not in an error (the bridge's errors are words like `fi_mau_telegram_phone_number_invalid`).
The bridge's last text names the person and the Telegram id — replaced like every step's. A login is named by the
Telegram user id (digits — never taken for a phone number); `logins()` names it by the number of its profile, or not at
all. Errors at the start: `fi_mau_telegram_phone_number_invalid`, `fi_mau_telegram_flood_wait_…` / `…_flood` (too many
tries — Telegram's wait), `fi_mau_telegram_login_email_required` (Telegram wants an e-mail login set up: use the QR
code), `fi_mau_telegram_login_timed_out`.

**What the bridge keeps to itself** (`bridgedb.js`): the member count of a group or channel (`PortalMetadata.
member_count`) and whether a contact is a bot (`ghost.is_bot`) never reach the homeserver (at most 100 members are in
a room; the bot flag would need `ghost_extra_profile_info`, which writes the contacts' numbers into the homeserver's
profiles). The server reads them from the bridge's own SQLite file (`telegram/data/telegram.db`), read-only, one row
per room, kept 10 minutes; nothing else of the file is read.

**Events.** Kind from the chat's id: `user:<n>` a person or bot (`direct`), `chat:<n>` a small group, `channel:<n>` a
supergroup or a channel (`group`; `channel:<n>:<topic>` a forum topic). A **channel** (broadcast) is told by the room's
state — the bridge makes the channel itself a member with the highest level (`@telegram_channel-<n>`) — or by the
bridge's database (not a supergroup): `chat.channel: true`, read-only, its posts by `{ channel: true, system: true }`,
at most `CHANNEL_HISTORY` (10) of its history. `chat.members` (the count Telegram reports; the messenger mutes a group of
200 and more at first) and `chat.bot` (a direct chat with a bot) come from the database. "Saved Messages" (the direct
chat with the person's own account) is not shown: its room is closed here at once. A file larger than the homeserver
takes (`max_request_size`, 32 MB) arrives as the bridge's notice "Too large file …" → a message of kind `unsupported`
with `tooLarge: true`; its other notices about media it cannot carry (stories, games without support,
`fi.mau.telegram.unsupported`, a failed download) → kind `unsupported`; neither their English text nor a file name goes
on. A file the homeserver took but that is larger than the messenger's own limit is the plugin's (`media.maxBytes`,
`too_large` at `media.fetch`). Secret chats never arrive (they exist only on the phone). Not solved: the bridge does not
carry the buttons under a bot's message (reply markup) and does not mark such a message — `message.buttons` is defined
for that hint but never set with v0.2610.0.

**History.** What the person chose (`NET.telegram.historyDays: null`): Telegram brings older messages from its server
whenever a room is made (at the link: the 15 most recent chats, each with up to `HISTORY.messages`; later: a chat with
its first new message). The bridge waits out Telegram's `FLOOD_WAIT` itself (`backfill.go`, `tgerr.FloodWait`); the
server keeps the load small (15 chats, 100 members, channels trimmed to 10) and the plugin files the history at night in
small portions as for WhatsApp.

**Erkennen.** A Telegram login and contact carry a fixed account id, the numeric user id (`NET.telegram.accountIds`,
`ACCOUNT_RE.telegram`; a channel's `channel-<n>` is none): noted as a keyed hash (`profile.noteOwnAccounts`),
compared by `matchAccounts` — `via: 'own_telegram'`, strong, only with the consent `byTelegram`. Numbers count where the
bridge knows them (contacts that share their number). User names never count. A profile number the own Telegram has
becomes `state: 'telegram'` ("Bestätigt über dein Telegram"); the portal's profile shows the line "An meinem
verknüpften Telegram".

## WhatsApp-Status (gc.bridges version 12)

What mautrix-whatsapp v0.2610.0 does with the contacts' status updates (read from its source, `pkg/connector`):

* With `network.enable_status_broadcast` (its default, and since version 12 written by `config.js` so a change of the
  default moves nothing) it makes **one room per person** for the chat `status@broadcast` (`makeWAPortalKey`: the
  broadcast server gets the login as receiver). Name "WhatsApp Status Broadcast", `RoomTypeDefault` (no
  `com.beeper.room_type.v2`), no backfill. Every status is a normal message of the contact's ghost: `m.text` (colour and
  font of a text status are lost), `m.image` / `m.video` with the caption as `body`. A status the contact deletes comes
  as a redaction; **when a status runs out after 24 hours nothing comes** — WhatsApp sends no such event and the bridge
  deletes nothing. Own status updates (posted on the phone) are dropped by the bridge (`handlewhatsapp.go`).
* `network.disable_status_broadcast_send` (default, also written): a message into the room is refused
  (`ErrBroadcastSendDisabled`) — without it, a message there would post a status of the person to all their contacts.
* A **reaction** to a status is always refused (`PreHandleMatrixReaction` → `ErrBroadcastReactionUnsupported`, no
  switch). An answer or a reaction goes to the direct chat with the contact as a normal message (the plugin does it).
* A **read receipt** in the room (`HandleMatrixReadReceipt`) marks every message between the bridge's last receipt there
  and this one read at WhatsApp, for every sender (`GetMessagesBetweenTimeQuery`, grouped by sender → `MarkRead`) —
  the contacts then see the person under "Gesehen von".
* `mute_status_broadcast` / `status_broadcast_tag` are account data of the person's Matrix account — GateControl does
  not read them, so they change nothing here and keep their defaults.

**Server.** `events.js` knows the room by its id at the bridge (`CHAT_IDS.whatsapp`: `status@broadcast`, never passed on):
`chat.status: true`, `kind: 'group'`, `readOnly: true` (kept in `bridge_rooms.status`, migration 156). A plugin before
version 12 ignores the field and shows the chat as before. `read(…, messageId)` there sends nothing (`{ ok: true,
skipped: 'status' }`) unless the plugin adds `{ status: true }` — its explicit word "the person watched this status and
wants WhatsApp to know". `send`, `react`, `redact` there are refused (`ERR_BRIDGE` / `status_room`), `typing` is not sent.
Rooms known from before (kept as a direct chat — no id fitted): migration 156 sets `channel` of every WhatsApp direct
chat back to NULL, so `refreshRooms` looks at each once more (a few per tick) and the plugin gets one `chat` event for
the status room; the next status update would do the same.

**The same contact.** The bridge names the sender of a message by `pickLID(Info.Sender, Info.SenderAlt)`
(`events.go GetSender`) — in the direct chat and in the status room alike: the LID ghost (`@whatsapp_lid-…`) whenever
WhatsApp tells the LID, else the number's ghost. `sender.id` is the HMAC of that ghost, so a contact is the same
`sender.id` in both rooms whenever WhatsApp delivered both messages with the LID (the usual case since WhatsApp moved to
LIDs). When one came only with the number (an old client of the contact), the two ids differ: the plugin then finds the
direct chat by the contact's `contactId` in `contacts()` (the bridge's contact store names the LID ghost when it knows
it) and otherwise offers no answer — it never guesses by name.

**The plugin's part** (messenger 1.25.0): the room's messages are not a chat but status updates of their senders in the
status row (`GET status/feed` → `bridged`); deleted after 24 hours with their files; no push; "seen" to WhatsApp only on
the person's own switch, while watching, and only for a status before which everything in the room was watched too (so
the bridge's "everything up to here" never reports a status nobody saw).

## Old media from the phone (gc.bridges version 13)

A picture, video, voice message or file of the history whose copy at WhatsApp ran out (WhatsApp keeps the files of a
chat on its servers only for a while; the phone keeps them) cannot be downloaded by the bridge. What mautrix-whatsapp
v0.2610.0 then does (read from its source, `pkg/msgconv/wa-media.go`, `pkg/connector/connector.go`, `mediarequest.go`,
`backfill.go`, `events.go`):

* It writes an **`m.notice`** in place of the file: `Old <kind>. <suffix>` (`<kind>`: `photo`, `sticker`, `video
  attachment`, `video message`, `voice message`, `audio attachment`, `file attachment`; a caption follows after a blank
  line), with the file's description in `fi.mau.whatsapp.failed_media` (`type`, `content` with `msgtype` and the caption,
  `type_description`, the keys). The suffix says what the bridge was configured with: `Requesting old media is not
  enabled on this bridge.` / `Media will be requested from your phone automatically soon.` / `… overnight.`
* It keeps a **request** for the file in its database either way (`media_backfill_requests`, status "not requested").
* With `history_sync.media_requests.auto_request_media` it asks the **phone** for the file (a media retry receipt;
  the phone uploads it again): `request_method: immediate` at once when the message is backfilled (what was waiting
  from before is not asked for); `local_time` from a loop that sends everything still waiting, then every 24 hours.
  Its time of day (`request_local_time`, minutes after midnight) counts in the time zone of the person's login — and
  **v0.2610.0 never sets one** (`WALogin.Timezone` is never written, `LoadTimezone` gives nil): the loop then starts
  **8 hours after the bridge connected**. The bridges restart every night for their snapshot (`BACKUP_TIME`, see
  "Backup"), so the requests go out about 8 hours after that time, once a day (`03:10` → about `11:10`; a snapshot at
  `19:00` gives about `03:00`). `request_local_time` is therefore not written.
* When the phone answers, the bridge **edits the notice** (`m.replace`, `WAMediaRetry`) into the file. When it cannot
  (not on the phone any more, an error), into the notice `Failed to bridge media after re-requesting it from your
  phone: …`.
* Signal and Telegram have no such option: Telegram's bridge fetches every file from Telegram's servers, Signal's has
  no media request (neither key list holds one).

**Configuration.** The administrator's switch (card „Brücken“ of the messenger → `configure({ mediaRequests })`,
setting `bridges.media_requests`): `'off'` (the default) writes `media_requests: { auto_request_media: false }` exactly as
before — an update to this version recreates no container; `'daily'` writes `auto_request_media: true, request_method:
local_time`; `'now'` `auto_request_media: true, request_method: immediate`. A change is a new revision (`config.rev`),
`update.sh` recreates the WhatsApp bridge. `HISTORY.conversations` stays 30. `status().mediaRequests: { mode, options,
dailyAt, timeZone }` — `dailyAt`: about when `'daily'` asks (the snapshot's time plus 8 hours, in `timeZone`).

**Server.** The notice never reaches a plugin as text (`events.js`, WhatsApp rooms only): an `m.notice` of a contact
with `fi.mau.whatsapp.failed_media` or the words above becomes a message of kind `'unsupported'` with `oldMedia: { kind:
image | video | voice | audio | file | sticker, name (a file's name, else null), request: off | daily | now }` and the
caption as its text. `request` is what the bridge's suffix says (what it was configured with when it wrote the notice),
else the administrator's choice now. The bridge's other notice about a file it could not carry over (`Failed to bridge
photo, please view it on the WhatsApp app` — also for a live message) is `oldMedia` with `request: 'failed'`. The edit
with the file is an `edit` that carries `media` like a message (kind, reference, type, size, length, waveform — the file
is noted in `bridge_media` for the clean-up) next to the text it always had; the edit "Failed to bridge media after
re-requesting it …" is an `edit` with `text: null` and `oldMedia: { request: 'failed' }`. Plugins before version 13
ignore both fields (and an edit without text); they show the message as "not shown here yet".

**The plugin's part** (messenger 1.26.0): the placeholder „Ältere Sprachnachricht – öffne sie in WhatsApp“ (off) /
„… – wird später vom Handy geladen“ (daily) / „… – wird geladen“ (now) / „… – kam vom Handy nicht; öffne sie in WhatsApp“
(failed); the edit with the file turns it into the file (fetched like any other, with the virus scan).

## Stages

| # | Content |
|---|---|
| 1 | service, preview gate, wish/state files, `update.sh`, secrets, `gc.bridges` (state, switch, a person's link through the provisioning API), tests against a stand-in bridge |
| 2 | this: compose profile `bruecken` with pinned images, generated configuration, provisional limits, the probe, "outdated", `unlinkFor`; plugins: portal page "Verknüpfte Dienste", the parents' switch in the family plugin. Open until the probe ran: whether the programs start with these files, and the real limits |
| 3 | messages (see "Messages"): the server as an application service — transactions through `bruecken-core-relay`, neutral events in a sealed inbox, sending as the person; text, reply, edit, deletion, reaction, read, typing, what the bridge says about a sent message; the probe blanks more. Plugin: bridged chats for the linked person only |
| 4 | files in both directions through the plugin's media with the virus scan, pictures of chats and contacts, a chat with a new number (API only); the apps follow. 4c: a new chat with a contact of the bridge (`contacts`, `matchNumbers`, `createDmByRef`, gc.bridges version 6) |
| 5 | this: history (each person: off / 30 days / everything; the plugin files it at night in small portions), the nightly encrypted snapshot of the bridges' data in the GateControl backup with restore, the files of bridged chats in a sealed media area on a storage target (plugin), clean-up of the homeserver's copies, "phone not seen" from the bridge's own warning, the pins to `update.sh` (marker 8) and "client outdated" |
| 6 | a gateway as the place, moving between places |
| 7 | 7a: Signal (see "Signal"; gc.bridges version 10, update.sh marker 10, the compose file with Signal and Telegram), 7b: Telegram (see "Telegram"; gc.bridges version 11, the administrator's application id, `bridgedb.js`); WhatsApp status in the status row (see "WhatsApp-Status"; gc.bridges version 12); old media from the phone (see "Old media from the phone"; gc.bridges version 13) |

## Files

* `src/services/bridges/index.js` — settings (`bridges.enabled`,
  `bridges.networks`), `wanted()`, `wish()`, `status()`, `configure()`,
  secrets, logins, `unlinkFor()`
* `src/services/bridges/images.js` — the pinned images, `compare()`
* `src/services/bridges/config.js` — the containers' configuration
* `src/services/bridges/hs.js` — the server's one call to the homeserver
* `docker-compose.yml`, `deploy/docker-compose.yml` — profile `bruecken`
* `src/services/bridges/provision.js` — the provisioning client
* `src/services/autoUpdate.js` — `"bridges"`, `"bridges_rev"` in the host config file
* `update.sh` — `sync_bridges`, `bridges_probe` (marker 7: also `bruecken-core-relay`; `probe_redact`)
* `src/services/bridges/appservice.js`, `events.js`, `hs.js` — stage 3: the listener for the homeserver's
  transactions, their translation into neutral events (tables `bridge_rooms`, `bridge_inbox`, `bridge_txns`,
  migration 148), the homeserver's client API as a person's internal account
* stage 4: `events.js` (`media.ref`, pictures, `adopt`), `hs.js` (`download`, `upload`), `index.js` (`openFile`,
  `send` with a file, `resolve`, `createDm`), `provision.js` (`resolve_identifier`, `create_dm`), `hostApi.js`
  (`bridgeFetch`, `bridgeFile`), `media.js` (`storeStream` with scan kind `bridge`)
* `src/services/plugins/hostApi.js` (`bridgesCall`), `child/bootstrap.js`
  (`makeBridges`), `manifest.js` (`permissions.bridges`)
* `tests/bridges.test.js`, `tests/bridges_config.test.js`,
  `tests/helpers/fake-bridge.js`, `tests/fixtures/bridges/`
* stage 5: `config.js` (history, `admin_execute`), `events.js` (history, `bridge_backlog`, `bridge_media`, migration
  149), `index.js` (`history`, `health`, `cleanupRun`, `mediaFetched`, `wish()` with images and snapshot ids),
  `backup.js`, `hs.js` (`deleteMedia`, `joinAdminRoom`), `services/backup.js` (`data.bridges`), `autoUpdate.js`
  (`bridges_images`, `bridges_backup`, `bridges_restore`), `update.sh` marker 8 (`bridges_images_sync`, `bcompose`,
  `bridges_backup_maybe`, `bridges_restore_maybe`), `plugins/mediaAreas.js` (`sealed`); tests
  `tests/bridges_stage5.test.js`
* stage 7b: `config.js` (Telegram model), `index.js` (`NET.telegram`, the application id `telegramApp`), `bridgedb.js`
  (member count, bot), `events.js` (Telegram kinds, channels, "Saved Messages", too large files), `backup.js`
  (`telegram_app`); tests `tests/bridges_telegram.test.js`, `tests/fixtures/bridges/keys-mautrix-telegram-0.2610.0.json`
* plugin API: [plugins.md](plugins.md) "Messenger bridges"
