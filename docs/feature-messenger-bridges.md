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
   returns a token. The session keys of a bridge live in its own database
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

The digests are the `Docker-Content-Digest` of the tag's manifest list at the
registry (amd64 and arm64 in each). The fallback homeserver, should Tuwunel
not work out in the probe, is continuwuity; it has no configuration-file
registration of application services (admin command only), so the change is
more than swapping an image.

`update.sh` reports the image each container runs (`.Config.Image`); a
container on another reference than the pinned one shows as **outdated**
(`networks[].outdated`, `wantVersion`). That happens when the
`docker-compose.yml` on the host is older than the server — it is replaced by
hand, `update.sh` does not touch it. After the file was replaced, `update.sh`
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
`.request_full_sync`, `.media_requests.auto_request_media`.

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
`chat: { id, kind: 'direct' | 'group', name, avatar? }` (`avatar` since stage 4), `at` (ms):

| `type` | Fields |
|---|---|
| `chat` | the chat became known or changed its name / kind; `closed: true` when the account left |
| `message` | `id`, `sender`, `kind: 'text' \| 'notice' \| 'media' \| 'unsupported'`, `text`, `replyTo` (a message id or null), `media: { kind: 'image' \| 'video' \| 'audio' \| 'voice' \| 'file' \| 'sticker' \| 'location', name }` for `media` — since stage 4 with `ref` and the file's details (see "Files") |
| `edit` | `id`, `sender`, `target`, `text` |
| `redact` | `id`, `sender`, `target` — a message or a reaction |
| `reaction` | `id`, `sender`, `target`, `emoji` |
| `status` | `target`, `status: 'sent' \| 'delivered' \| 'failed'`, `reason`, `retriable` — the bridge's word on a message GateControl sent (`com.beeper.message_send_status`); `delivered` only in direct chats |
| `contact` | `contact: { id, name, avatar }` — a contact's name or picture changed |
| `lost` | a row that could not be opened (the bridges' folder was replaced) — acknowledge it |

`sender`: `{ id, name, avatar }` (a contact; `id` is an HMAC of the bridge's address,
`c…`), `{ self: true }` (written by the person in the messenger's own app) or
`{ system: true }` (the bridge itself). Messages GateControl sent itself do
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
against the homeserver's Content-Length before a byte is read (no length: not
read at all), the type must be one of `media.types` (any other file that is
no picture, sound or video is kept as `application/octet-stream`, a download),
the quota and the room on the server as for every file. The bytes go straight
from the socket into the sealed file (one fsync, as for every file); the
virus scan checks them as a file of that plugin (scan kind `bridge`; for the
messenger the source "messenger"), a later result comes with the hook
`mediaScanned`. Refusals: `ERR_MEDIA_TOO_LARGE`, `ERR_MEDIA_TYPE`,
`ERR_MEDIA_QUOTA`, `ERR_BUSY` (scan unavailable and uploads held),
`ERR_BRIDGE` (`m_not_found`, `bad_answer`), `ERR_BRIDGE_UNREACHABLE`,
`ERR_INVALID` (a ref of another person, or of another installation).

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
room go on; the bridge's id, address and identifiers (they hold the number)
and its error texts (they name the number) stay out, and the number is never
written to a log or a table. `createDm` knows the room at once (state
`invited` in `bridge_rooms`, the plugin has the chat reference straight away);
its join brings name and kind as usual, sending works as soon as the account
is in the room.

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

## Stages

| # | Content |
|---|---|
| 1 | service, preview gate, wish/state files, `update.sh`, secrets, `gc.bridges` (state, switch, a person's link through the provisioning API), tests against a stand-in bridge |
| 2 | this: compose profile `bruecken` with pinned images, generated configuration, provisional limits, the probe, "outdated", `unlinkFor`; plugins: portal page "Verknüpfte Dienste", the parents' switch in the family plugin. Open until the probe ran: whether the programs start with these files, and the real limits |
| 3 | messages (see "Messages"): the server as an application service — transactions through `bruecken-core-relay`, neutral events in a sealed inbox, sending as the person; text, reply, edit, deletion, reaction, read, typing, what the bridge says about a sent message; the probe blanks more. Plugin: bridged chats for the linked person only |
| 4 | files in both directions through the plugin's media with the virus scan, pictures of chats and contacts, a chat with a new number (API only); the apps follow |
| 5 | history (30 days, in small portions at night), backup of the bridge state, storage targets for media, "phone not seen" notices, "bridge outdated" |
| 6 | a gateway as the place, moving between places |
| 7 | Signal, Telegram |

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
* plugin API: [plugins.md](plugins.md) "Messenger bridges"
