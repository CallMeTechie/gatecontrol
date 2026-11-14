# Messenger bridges (preview)

The chat of the messenger plugin shall talk to people who have no GateControl
account: WhatsApp first (the WhatsApp Business **app** uses the same way,
"linked devices"), Signal and Telegram later. This file is the plan of the
server side and the contract with the plugin.

**State: stage 1, preview.** Nothing of it exists on a server that was not
started with `GC_BRIDGES_PREVIEW=1`, and with it the bridges are still **off**
until an administrator switches them on in the messenger plugin's settings.
Stage 1 has no containers yet (see "Stages"): with the switch on, the settings
page shows "service missing" until the compose file of stage 2 is in place.

## Parts

```
WhatsApp ── bridge (mautrix) ──(Unix socket)── internal Matrix homeserver     compose profile "bruecken"
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

1. **No port.** Homeserver and bridges are reached over Unix sockets in
   `/data/bridges/run` only. The homeserver gets no network at all, a bridge
   only outgoing connections to its messenger.
2. **No federation, no registration, no guests.** The server name
   `gc.internal` resolves nowhere.
3. **Secrets** (`as_token`, `hs_token`, the provisioning secret) are made once
   by the server (`crypto.randomBytes(32)`), kept in
   `/data/bridges/secrets.json` (0600, folder 0700) and returned by no API. The
   session keys of a bridge live in its own database where it runs; a backup of
   them leaves that place only encrypted (later stage).
4. **A contract, not a pass-through.** `gc.bridges` takes fixed network names
   and checked ids, builds every path itself and returns reduced fields only;
   a bridge's error text stays in the server log.
5. **Only the person themselves** links, reads or unlinks their account: the
   host checks that a request of exactly that person is in flight
   (`personContext`). An administrator switches the service and sees states,
   versions and memory — no contacts, no numbers, no contents.

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

**No measured numbers yet.** Neither program could be run where stage 1 was
built. The images, their configuration, the memory limits and the write load
are settled in stage 2 on a real Docker host; `update.sh` already reports the
real memory use so the first numbers come from the server itself.

## Stages

| # | Content |
|---|---|
| 1 | this: service, preview gate, wish/state files, `update.sh`, secrets, `gc.bridges` (state, switch, a person's link through the provisioning API), tests against a stand-in bridge |
| 2 | compose profile `bruecken` with pinned images, generated configuration and memory limits, proven on a real Docker host; portal page "Verknüpfte Dienste" |
| 3 | messages: the server as an application service (events → plugin hook, sending), outside contacts and rooms ↔ chats in the plugin |
| 4 | media, chat list marks and filters in the apps |
| 5 | history (30 days, in small portions at night), backup of the bridge state, storage targets for media, "phone not seen" notices, "bridge outdated" |
| 6 | a gateway as the place, moving between places |
| 7 | Signal, Telegram |

## Files

* `src/services/bridges/index.js` — settings (`bridges.enabled`,
  `bridges.networks`), `wanted()`, `status()`, `configure()`, secrets, logins
* `src/services/bridges/provision.js` — the provisioning client
* `src/services/autoUpdate.js` — `"bridges"` in the host config file
* `update.sh` — `sync_bridges` (marker 5)
* `src/services/plugins/hostApi.js` (`bridgesCall`), `child/bootstrap.js`
  (`makeBridges`), `manifest.js` (`permissions.bridges`)
* `tests/bridges.test.js`, `tests/helpers/fake-bridge.js`
* plugin API: [plugins.md](plugins.md) "Messenger bridges"
