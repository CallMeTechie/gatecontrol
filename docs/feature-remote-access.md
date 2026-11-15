# Fernzugriff (remote access) — the core part

Remote Desktops becomes the shop plugin **„Fernzugriff“** (EN "Remote access",
id `gatecontrol-remote`). This page describes what the core provides for it
(stage 0). The host API itself — every call, answer and error — is in
[plugins.md, "Remote access"](plugins.md#remote-access-permissionsremote).

## What stays in the core, what moves

| Core (transport, session) | Plugin (data, pages) |
|---|---|
| guacd container, the Guacamole tunnels, the session page | devices / targets with all settings (taken over from `rdp_routes`) |
| limits, heartbeat, single-use tokens (as before) | rights per person, group and device; view or control |
| key vault: passwords and SSH keys encrypted, the plugin holds handles | codes, requests, approvals of the devices |
| L4 listeners of the gateways, TCP probe, wake-on-LAN | history (from `rdp_sessions`), the directory of recordings |
| the old app API `/api/v1/client/rdp*` as a facade | pages: Geräte, Berechtigungen, Sitzungen, Einstellungen, portal tab, profile section |

## Stage 0 (this server version)

* `permissions.remote` and `gc.remote` version 1: sessions (`session`, `end`,
  `sessions`), vault (`vault.put/remove/info/list`), `probe`, `wake`,
  `listener` / `listener.remove` / `listeners`, `recordings.*` (the frame —
  recording comes with stage 3), the event `session` (hook `remoteSession`).
* `GC.openSession(ref)` in the plugin's frames, the session page
  `/remote/session/<ref>` (the page of the old browser sessions) and its
  tunnel `/api/v1/remote/guac-tunnel`.
* One upgrade dispatcher for all WebSocket paths (`src/tunnel/upgrade.js`):
  the old guacamole tunnel, the one of gc.remote and the edge channel of the
  gateways register their path there instead of each listening to every
  upgrade. Behaviour unchanged; a path nobody registered is left alone as
  before.
* The dataset `remote` of the built-in data import (`plugins/legacy.js`):
  `rdp_routes`, `rdp_sessions`, maintenance windows; credentials go into the
  core's vault and the plugin gets handles; ids stay; the tables stay and keep
  going into backups. The core's vault (`remote_vault`) is part of the backup
  as ciphertext.
* The facade hook `clientFacade` for the old app API, active only after the
  take-over; credentials through the facade with ECDH only.
* Platform `linux` for `gc.devices` (the Linux agent of stage 4).
* **Nothing changes for users yet**: the built-in Remote Desktops works as
  before. The notice `plugins.moved.remote` was prepared here and is switched
  on with stage 1 (below).

## Stage 1 (the plugin „Fernzugriff“ 1.0)

The plugin (gatecontrol-plugins, `plugins/gatecontrol-remote`) has the pages Geräte, Berechtigungen, Sitzungen and
Einstellungen, the portal tab and the profile section, takes the built-in data over and answers the old app API. The
core adds what only it knows:

* `gc.remote.gateways()` — the home gateways and failover pools for the device page (names and ids only).
* The facade passes `server: { connectHost }` and completes the plugin's answers like the old endpoints:
  `connect_address` of a gateway target, the DNS names of a device (`peer_hostname`, `peer_fqdn`,
  `peer_fqdn_primary`, feature `internal_dns`) — see plugins.md "Facade for the old app API".
* The upgrade notice `plugins.moved.remote` is switched on (dashboard, plugin area, the page `/rdp`):
  "Remote Desktops ist jetzt das Plugin „Fernzugriff“". With the plugin installed but its data not taken over yet,
  `/rdp` points to "Daten übernehmen" on the plugin's page; once taken over, `/rdp` leads to the plugin's page.
  The built-in tables and `/api/v1/rdp` stay (the Windows app's wake-on-LAN and status calls use them).

## Licence

„Fernzugriff“ needs a licence of its own — monthly, yearly or a lifetime
licence of the plugin. It is **not** part of a GateControl plan or a server
lifetime licence, and the feature key `remote_desktop` gives no "Im Plan
enthalten". The licence server's entitlement slug is the plugin id
`gatecontrol-remote` (first-party, see plugins.md "Licences"). Without a valid
licence the plugin opens no new sessions (`ERR_REMOTE_UNLICENSED`, the session
page answers `unlicensed`); existing data stays, the built-in Remote Desktops
is not affected.

## Security rules of the core

* Only signed-in GateControl people: a ticket belongs to one person and binds
  itself to the first browser session that opens it; never a public link,
  never a kiosk device.
* The plugin never sees a secret: the vault answers metadata only, the
  plaintext is resolved inside the core when a guacamole token is minted or
  when the facade encrypts for an app (ECDH).
* No target on loopback, link-local, multicast, reserved addresses or the hub
  address (only through the plugin's own listener).
* Every opened tunnel is a row of `remote_sessions` and an entry of the
  activity log (`remote_session_started` / `remote_session_ended`).

## Deprecated: plaintext credentials of `/connect`

`GET /api/v1/client/rdp/:id/connect` without `ecdhPublicKey` or `publicKey`
still answers username and password in plaintext over HTTPS for old apps. This
fallback is deprecated: the server logs one warning per token and hour
("RDP credentials sent without a client key … deprecated"). Targets answered
by the plugin never get it. All current apps send an ECDH key; the fallback
should be removed once no old app uses it any more.
