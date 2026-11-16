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

## Stage 2 (the Windows switch, gc.remote version 2, the plugin „Fernzugriff“ 1.1)

Switching „Remote Desktop erlauben“ on in the Windows app registers the PC with the plugin; it shows up at once
under Fernzugriff › Geräte and for everybody allowed. 3389 stays closed until a session is allowed — and then only
for exactly one counterpart (the plugin's contract: code, confirmation on the PC, „Ohne Code für Berechtigte“).
The core adds:

* `req.user.device.vpnIp` — the VPN address of the asking app (the first address of its token's peer) for plugins
  with `permissions.remote`: the host of the PC's RDP target.
* `gc.remote.hubAddress()` and `from` in the answer of `gc.remote.session` — guacd connects from the hub address;
  for a browser session the PC opens 3389 for it only.
* `gc.remote.peerAddress(userId, deviceId)` — the VPN address of the helper's own app device, only in a request of
  that person: for an app session the PC opens 3389 for it only.
* Signal topics (`notifyTopics[].signal`): silent data pushes to single devices that no switch, mute or quiet hours
  hold back — "open / close the firewall for this session".
* The facade also answers `POST /api/v1/rdp/:id/wol`, `GET /api/v1/rdp/:id/status`, `/:id/wol/status` and
  `/api/v1/rdp/status` for app tokens (`wake`, `statusAdmin`, `statusAll`) — the devices of the plugin have no row
  in `rdp_routes`.

## Stage 3 (SSH with tmux and recordings, gc.remote version 3, the plugin „Fernzugriff“ 1.2)

* **SSH terminal in the core** — `engine: 'term'`: ssh2 on the server, xterm.js on the session page (vendored,
  no CDN), the protocol `gc-term.v1` on `/api/v1/remote/ssh-tunnel` (docs/plugins.md "The SSH terminal").
  guacd stays for RDP, VNC, Telnet and the SSH targets that were not switched over (`engine: 'guac'`).
* **tmux** — `options.tmux { attach | create }` runs `tmux new -A -s '<name>'` on the device (the name is checked
  strictly: letters, digits, `_`, `-`); `gc.remote.tmux.list` reads the sessions for "Fortsetzen".
* **Host keys** — pinned per target: the first connection asks the person to confirm the fingerprint, a
  different key blocks and lands in the activity log (`remote_host_key_changed`). `gc.remote.hostKeys.*` for the
  plugin (pin a key the Linux agent reported, reset after a planned change).
* **Keys** — `gc.remote.vault.generate` makes an ed25519 pair in the core; the plugin shows the public key for
  `authorized_keys`, the private one never leaves the vault.
* **Native apps** — `POST /api/v1/client/remote/term-token` turns a ticket into a WebSocket token for an app
  token of the same person; the apps build their terminals natively (no WebView).
* **Recordings** — optional, only with the hint before the start and a red dot during the session. SSH in the
  terminal: asciicast v2 (output only). RDP/VNC/Telnet/SSH over guacd: guacd's recording on the drive
  `remote-recordings` (both `docker-compose.yml` files; `update.sh` marker 9 reports whether guacd and GateControl
  have it mounted — they get it with the next update). Encrypted like plugin media, written in whole 64 KiB chunks
  (the slow disk of a small VPS), never converted on the server: playback in the browser (xterm.js,
  `Guacamole.SessionRecording`) through a single-use ticket of the person the plugin names
  (`gc.remote.recordings.stream`), each viewing logged (`remote_recording_viewed`). Limits:
  `GC_REMOTE_REC_MAX_GB` (10), `GC_REMOTE_REC_DAYS` (30). Recordings are outside `./data` and not in backups;
  pinned host keys are.

## Stage 4 (the Linux agent, the plugin „Fernzugriff“ 1.6)

The agent `gatecontrol-agent` (own repository `gatecontrol-linux-agent`, Go) sets itself up with the ordinary setup
code (`POST /api/v1/client/enroll`, `platform: 'linux'`) and registers with the plugin (`host/register`, platform
`linux`). The core only adds what it needs:

* `POST /api/v1/client/enroll` answers `vpn: { subnet, gateway }` (`GC_WG_SUBNET`, `GC_WG_GATEWAY_IP`): the agent routes
  only the VPN network (never the `AllowedIPs = 0.0.0.0/0` of the app config), and the hub is where GateControl's SSH
  key is valid from.
* The push stream takes `X-Client-Platform: linux` (`gc.devices.list` shows the agent as `linux`).
* A peer made by the agent is described as „Linux Agent (linux, v…)“.
* The portal's „Gerät hinzufügen“ shows the command `sudo gatecontrol-agent enroll <server> <code>` under the code
  (`portal.devices.linux_enroll`).

## Stage 5 (the phone's screen, gc.remote version 4, the plugin „Fernzugriff“ 1.3)

* **Relay `gc-screen.v1`** — `gc.remote.screen({ viewer, sender: { user, device }, target })` gives a ticket with
  two refs: the phone (sender, only its own app token: `POST /api/v1/client/remote/screen-token { ref }`) and the
  viewer (the session page `/remote/session/<ref>` with WebCodecs, or an app through the same endpoint). One
  WebSocket path `/api/v1/remote/screen-relay`, the token in `Sec-WebSocket-Protocol` (docs/plugins.md "The screen
  relay").
* **Codec** — H.264 (Annex B) from the phone's MediaCodec, SPS/PPS in front of every key frame; the browser decodes
  with `VideoDecoder` without a `description`. The server reads one flag byte per frame and passes the bytes on —
  no decoding, no transcoding, nothing on the disk.
* **Only watching** in stage 5 (`mode: 'view'`); control (Android accessibility service) is stage 6 — in mode view the
  relay drops every input of a viewer. No recording yet (later fMP4 from the same frames, without transcoding).
* **Limits for a small VPS (4 cores, 8 GB)** — `GC_REMOTE_SCREEN_MAX` (8) sessions at once, one per phone, two per
  watching person, one viewer per session; frames ≤ 1 MiB, ≤ 1920×1080, ≤ 30 fps; 6 Mbit/s per session (4 MiB
  burst; over it frames are dropped and the phone is asked for a lower bitrate, 30 s over it ends the session);
  `GC_REMOTE_SCREEN_MAX_MIN` (240). The phone aims at 1.5 Mbit/s, 15 fps, 1280 px on the long edge: 8 sessions are
  about 25–60 Mbit/s through the server, CPU only for TLS.
* **End reasons** (`{t:'end', reason}`): `sender` (the phone's „Beenden“), `viewer`, `ended_by_plugin`,
  `sender_lost` (30 s), `viewer_lost` (60 s), `max_duration`, `peer_timeout` (the other side never came),
  `plugin_stopped`, `bad_frame`, `rate_exceeded`. **Errors** (`{t:'error', code}`): `hello_timeout`,
  `role_mismatch`, `bad_frame`, `codec_unsupported`, `rate_exceeded`, `replaced` (the same side connected again).
* **Honest about the network**: the server sees the stream because it passes it on — it is not end-to-end
  encrypted (the viewer page says so). Windows with FLAG_SECURE content (banking, the app's vault pages) stays black
  on the phone's side.

## Stage 6 (controlling the phone, gc.remote version 5, the plugin „Fernzugriff“ 1.4)

* **Asking is not allowing** — a helper may *ask* for „Ansehen und steuern“; `gc.remote.screen({ mode: 'control' })`
  is only called after the person at the phone chose it for this very request (the plugin, contract stage 6). Even
  then the relay lets input through only while the **mode in force** is control: the ticket says control, the phone's
  hello says `control: true` (Android: the accessibility service of the GitHub build runs; the Play build never
  controls) and the whole display is shared (one app shared → `app_scope`).
* **Going down at any time, for good** — the phone sends `{t:'mode', mode:'view', reason}` („Nur ansehen“ in the red
  bar, the notification or the frame on the screen; the service went off; the phone locked). Both sides hear it, the
  row gets `mode = 'view'`, the activity log `remote_session_mode`, the plugin the hook phase `mode`. Nothing brings
  control back within the session, not a reconnect either.
* **Input** (`{t:'input', k}`: `tap`, `long`, `swipe` with a path, `scroll`, `key` back/home/recents/enter/backspace,
  `text`) — coordinates 0…1 of the picture; the core passes on only the cleaned object, 30 a second, text 5 a second
  and 4000 characters in 10 s, and logs none of it. `{t:'notice', code}`: `view_only`, `input_rate`;
  `{t:'input_fail', reason}` from the phone: `no_field`, `blocked`, `locked`, `secure`.
* **Viewer page** — „Du steuerst“ in the toolbar, a bar Zurück / Start / Übersicht / Text, mouse, touch and keyboard on
  the picture; a change to view shows why at once and stops all input.
* **What the phone never does** — no input on the lock screen, the PIN entry or Android's own questions; no reading
  of content beyond the focused field (to insert text at the cursor); nothing outside a session. The server sees the
  input as it sees the picture (no end-to-end encryption).

## Stage 7 (sharing a Windows screen, gc.remote version 6, the plugin „Fernzugriff“ 1.5)

* **The same relay** — the GateControl app for Windows („Bildschirm teilen“, also Windows Home, nobody is signed off)
  captures a display (Electron `desktopCapturer`), encodes H.264 with WebCodecs (hardware first) and sends it as the
  sender of `gc-screen.v1`. Tickets, tokens, limits and end reasons are those of stage 5/6.
* **Mouse and keyboard** — the hello says `input: 'desktop'`; in control the viewer sends `move`, `button`, `wheel` and
  `kbd` (physical keys, shortcuts included), pasting is `text`. The core cleans and limits them (moves 30 a second of
  their own, a release always passes) and logs none of it. The PC carries them out with `SendInput` only while the
  mode in force is control and Windows' input desktop is the normal one; it lets go of everything when control ends.
* **Displays** — the hello names the displays (index and size); the viewer may pick one (`{t:'display', i}`).
* **What the PC never does** — no input into Windows' secure desktop (UAC prompt, lock and sign-in screen, Ctrl+Alt+Del):
  that would take a system service, which GateControl does not install. The person at the PC sees a bar at the top
  („… sieht zu / steuert · Beenden“) for the whole session.

## „Gerät hinzufügen“, neu (gc.remote version 7, the plugin „Fernzugriff“ 1.7)

The dialog of the plugin starts with the target instead of an address: the core knows the VPN devices, the home
gateways with their networks and the routes. Nothing new on the gateway and in the apps (the data of a device keep
`access_mode`, the facade answers as before).

* **`gc.remote.candidates({ user })`** — only for an enabled administrator whose request to the plugin is in flight
  (`plugins/personContext.js`): the peers with VPN address and name in the VPN (`app`: the PC or Linux computer
  registers itself through the GateControl app or the agent), per gateway its online state, pool, LAN subnets and the
  devices of the network watch (name, address, vendor, the open ports 22, 23, 3389, 5900–5909, `wake` instead of the
  MAC), the L4 routes that look like SSH, RDP, VNC or Telnet, and `twin` for a device known in the VPN and in a home
  network (the same name on both sides, only when unambiguous). Never a MAC, an owner or presence; the core keeps
  nothing of it and the plugin must not store it.
* **`gc.remote.scan(target, ports)`** — 1…8 ports of one target at once: directly from the server (the greeting
  tells SSH, VNC and Telnet) or through the gateway's `/api/probe`, one port each (no broad scan, no gateway change).
  At most two scans of a plugin at a time.
* **`listener({ listenPort: 'auto' })`** — the core picks the L4 port on the server from `GC_REMOTE_AUTO_PORT_MIN` …
  `GC_REMOTE_AUTO_PORT_MAX` (40000 … 40999); the route stays internal only. A listener keeps its port; an L4 gateway
  route to exactly this target is shared, whatever its port.
* **`wake({ watch: 'nw-<id>' }, { user })`** — wakes a device of the network watch without the plugin ever seeing its
  MAC (only for an administrator in a request).

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
* SSH (stage 3): the host key is always checked once pinned, and pinned only after
  the person confirmed it; tmux names are checked against a strict pattern and
  quoted; tokens of the terminal are single-use, 60 s and bound to the ticket's
  person; no key or password ever reaches a log, a recording's metadata or an app.
* Recordings only with the hint; playback only through a ticket for the person
  the plugin names (administrators and the owner), every viewing logged.
* Candidates (version 7): only for an administrator in a request, never a MAC, an owner or presence of the
  network watch; a scan is a handful of ports of one target, never a sweep.
* Screen (stage 5): the sending side of a ticket only for the phone's own app
  token, the watching side bound to the first browser session or app token;
  tokens single-use and 60 s, only in `Sec-WebSocket-Protocol`; frames are
  passed on, never stored or logged; the phone always asks the person (and
  Android asks again) — the core never starts a capture.

## Deprecated: plaintext credentials of `/connect`

`GET /api/v1/client/rdp/:id/connect` without `ecdhPublicKey` or `publicKey`
still answers username and password in plaintext over HTTPS for old apps. This
fallback is deprecated: the server logs one warning per token and hour
("RDP credentials sent without a client key … deprecated"). Targets answered
by the plugin never get it. All current apps send an ECDH key; the fallback
should be removed once no old app uses it any more.
