# 7. FAQ and troubleshooting

[← Updating an existing gateway](06-updating-a-gateway.md) · [Contents](README.md)

## General

### Where do I find the logs?

**Server** (on the server as root):

```bash
cd /opt/gatecontrol
docker compose logs --tail 200 gatecontrol
```

The update log is in `/var/log/gatecontrol-update.log`. The interface also has
“Logs & Monitoring”.

**Gateway on the Synology:** Container Manager → “Container” →
`gatecontrol-gateway-gateway-1` (or `…-edge-1`, `…-mqtt-1`) → “Log”.

**Gateway on Linux/Docker:**

```bash
cd /opt/gatecontrol-gateway
sudo docker compose logs --tail 200 gateway
sudo docker compose logs --tail 200 edge
```

**Raspberry Pi image** (via SSH):

```bash
journalctl -u gatecontrol-gateway -b
sudo docker compose --project-directory /opt/gatecontrol-gateway logs --tail 200 gateway
```

Without SSH: put the card into the PC and read `bootfs/gatecontrol/STATUS.txt`.

**In GateControl:** open the gateway → tab “Edge plugins” → “Gateway log”; for a
single plugin “Log”.

The log of gateway updates is on the device in `gateway-state/update.log`.

### May I share passwords or files in chats or tickets?

No. **Never** share the server's `.env`, a `gateway.env`,
`gatecontrol-setup.zip` or `gatecontrol-gateway-nas.zip` – not even parts of
them. They contain passwords, tokens and the tunnel keys. Black out passwords,
tokens and keys in logs before you share them. If something got out anyway:
change the admin password and create a new set-up file for the gateway (the old
one is then no longer valid).

### How do I update a gateway?

Click “Update to …” on the gateway's card in GateControl. This needs auto-update
to be set up. New features that need more in the compose file (edge, home
cache) you have to add once by hand. All about it: [chapter 6](06-updating-a-gateway.md).

## Server

### “The server runs in UTC”

This message shows for a gateway in the tab “Features” (card “System”) under
“Local time”. The server lacks its time zone.

1. Add it to the server's `.env`:

   ```bash
   cd /opt/gatecontrol
   echo 'TZ=Europe/Berlin' >> .env
   ```

2. Apply it with `docker compose up -d` (not `docker restart`).

**Check:** `docker exec gatecontrol printenv TZ` shows your time zone. The
gateways take it over the next time they fetch their configuration.

### Why the time zone in `.env` and not in the compose file?

The server's `docker-compose.yml` passes `.env` to the container
(`env_file: .env`). All settings are in one place this way, and the compose
file stays as shipped. After a change to `.env` always run `docker compose up -d`
– `docker restart` does not pick up new values.

You do not set a time zone on the gateway. It gets it from the server (from gateway 1.22.0).

### “Auto-update not set up” although the schedule runs

Usually the server's data is not in the folder `/opt/gatecontrol/data` but in a
Docker volume (installations with an older `docker-compose.yml`). Check it:

```bash
docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Source}}{{"\n"}}{{end}}'
```

- `bind … /opt/gatecontrol/data`: the data is in the right place. Check the
  schedule (`cat /etc/cron.d/gatecontrol-update`) and the log
  `/var/log/gatecontrol-update.log`.
- `volume gatecontrol_gatecontrol-data …` (or similar): a current `update.sh`
  detects the volume by itself and works with it. The log then says
  `NOTE: /data of 'gatecontrol' is the Docker volume …`. Get a current
  `update.sh` like this: `cd /opt/gatecontrol && curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh && chmod +x update.sh`.
  In the long run the move to `./data` (next section) is simpler: then the `tar`
  backup from [chapter 2.10](02-server-setup.md#210-backup) includes the data too.

### Move the server data from a Docker volume to ./data

Older installations keep the data in the Docker volume `gatecontrol-data`
(Docker puts the project name in front, e.g. `gatecontrol_gatecontrol-data`).
The current `docker-compose.yml` uses the folder `./data`. The move takes about
a minute; during that time the server is not reachable. Nothing is deleted: the
volume stays as a fallback.

All commands on the server as root, in the folder with the `docker-compose.yml`
(here `/opt/gatecontrol`).

1. Note the name and location of the volume:

   ```bash
   cd /opt/gatecontrol
   docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Source}}{{"\n"}}{{end}}'
   ```

   The line with `volume` names the volume (e.g. `gatecontrol_gatecontrol-data`)
   and its location (e.g. `/var/lib/docker/volumes/gatecontrol_gatecontrol-data/_data`).
   If it says `bind … /opt/gatecontrol/data`, there is nothing to do.

2. Stop the server:

   ```bash
   docker compose down
   ```

3. Copy the data (permissions and time stamps are kept). Use the location from
   step 1:

   ```bash
   mkdir -p data
   cp -a /var/lib/docker/volumes/gatecontrol_gatecontrol-data/_data/. data/
   ls data
   ```

   `ls data` shows among others `gatecontrol.db` and the folder `wireguard`.

4. Switch the compose file. Replace it with the current one or change the one line:

   ```bash
   cp docker-compose.yml docker-compose.yml.bak
   sed -i 's#- gatecontrol-data:/data#- ./data:/data#' docker-compose.yml
   grep -n ':/data' docker-compose.yml
   ```

   `grep` shows `- ./data:/data`. The entry `gatecontrol-data:` under `volumes:`
   at the end of the file may stay.

5. Start the server:

   ```bash
   docker compose up -d
   ```

6. Check:

   ```bash
   docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'
   docker compose ps
   ```

   The first line shows `bind /opt/gatecontrol/data`, `docker compose ps` shows
   `(healthy)`. Log in: routes, peers and gateways are there as before.

If something goes wrong: `docker compose down`, `cp docker-compose.yml.bak docker-compose.yml`,
`docker compose up -d` – the server runs with the volume again.

Only when everything has been running for at least a day may you delete the
volume (`docker volume rm gatecontrol_gatecontrol-data`, name from step 1).

### “event loop was blocked” in the log

The server did nothing else for a few seconds – gateways, apps and the web
interface wait meanwhile. The line names what ran in that time:

- `tasks`: background jobs (e.g. `plugins.mediaAreas`, `home.staleOffers`),
  start steps (`boot.*`), requests (`GET /api/v1/…`, ids as `:id`) and plugin
  calls (`plugin <id> <call>`) with the time they held the server, and
  process starts (`spawn <program>`). Entries marked `(async)` or
  `(still running)` only ran in that time – they may just have waited (for a
  program, the network); the cause is usually listed before them, without a
  mark.
- `requests`: requests and plugin calls that were open in that time –
  candidates when `tasks` names nothing that fits. The time is the time
  **within the stall**: a call open during the whole stall shows exactly its
  length – even when it only waited. A plugin's `db.query` names its
  statement without values
  (`plugin gatecontrol-mail db.query SELECT … WHERE user_id = ?`).
- `blockedBy`: `cpu` – the server computed in that time itself (`mainCpuMs`
  near `blockedMs`); `waiting` – it waited, mostly for the disk or memory
  (`diskReads`, `majorFaults` high) or because no CPU core was free
  (`processCpuMs`: all threads together).

- `diskSyncMs`: how long the disk last took for one small write. `waiting`
  with `diskSyncMs` from about 50 ms: the server waited for the disk (see
  “The disk is slow to write”).

Plugin statements that run 200 ms or longer are summed up per plugin for
5 minutes in one line “slow plugin database statements”: the count (`slow`),
how many were writes (`writes`), the longest time (`maxMs`) and the most
frequent statements without their values. They run in a thread of their own
and do not stop the server – but when they read large parts of the database,
they slow the disk for everyone. Almost only writes: it is the disk, not the
plugin.

The jobs with many entries (Drive areas on a storage target,
the home cache of the gateways with thousands of previews, backups) work in
small pieces, and the database writes its log back in a thread of its own.
If the message still comes often, copy the whole line (with `tasks`,
`requests` and `blockedBy`) and the “slow plugin database statements” lines
next to it into a ticket.

### The disk is slow to write

At the top of **Logs & Monitoring**: “GateControl’s data disk is slow to write
(avg. … ms per write …)”. Every 2 minutes GateControl measures how long the
disk takes until a small write is really stored. The hint appears when that
takes 50 ms or longer on average over half an hour, and goes away by itself
when it is fast again. An SSD takes 1–5 ms, a hard disk 10–30 ms.

Every change – a device reports in, a calendar is synced, a lock reports its
state – waits for it. Since 1.255.0 the plugins write so that not every change
waits for the disk; a slow disk still slows down backups, updates and large
plugins.

What helps:

- put GateControl’s `/data` folder on an **SSD** (on a NAS: an SSD volume or
  an SSD cache for the volume),
- **not** on a network share (SMB/NFS), an SD card or a USB stick,
- **not** on a NAS volume that is very busy at the same time (backups, disk
  checks, a RAID rebuild, downloads, many cameras),
- on a NAS with hard disks: check whether a disk check, a RAID rebuild or a
  backup is running – then the hint is temporary.

The hint is only a hint – GateControl keeps running. The measurement can be
switched off with `GC_DISK_PROBE=off`.

What can be lost: the databases of GateControl and the plugins write their
changes to a log first and bring them onto the disk in batches. If
GateControl crashes, nothing is lost. On a power cut the changes of the last
seconds (at most 30 s for the server) can be missing – the database stays
intact.

### “malformed request body” in the log

Someone sent GateControl a body it cannot read. The line is a warning, not a
fault of the server: the request got a 4xx error (mostly 400 `invalid_json`)
and nothing ran. It names the method, path, address (`ip`), the kind
(`type`) and the length of the body (`length`) – never the body itself, which
is often an attack.

- `entity.parse.failed`: not valid JSON. From a foreign address to paths like
  `/run`, `/api/…` or `/` almost always a scanner probing for holes in other
  software.
- `entity.too.large`: larger than allowed (1 MB, less for gateway and app
  calls).
- `encoding.unsupported` / `charset.unsupported`: an encoding no program of
  GateControl sends.
- `request.aborted`: the connection broke before the body arrived (e.g. a
  phone losing its signal).

At most one line per kind and 5 minutes reaches the log; `repeated` says how
many came since the last line. Invalid JSON and unknown encodings count for
the IP block (source “Probing unknown paths”) like a 404 of an unknown path: every ten from
one address are one failure. Own addresses, the VPN and the “never block”
list never count. If the line comes from one of your apps or a gateway, the
fault is there – copy the line into a ticket.

### The container does not start or the certificate does not come

- `GC_ADMIN_PASSWORD is not set or still default`: `.env` still says
  `changeme`. Enter a real password, `docker compose up -d`.
- `127.0.0.1:53 is already bound`: another DNS service runs on the server.
- `unable to fetch certificate`: the A record does not point to the server yet
  or port 80 is closed. The server retries by itself.

In detail: [INSTALL.md §9](../../INSTALL.md#9-troubleshooting).

### Failed login with a stranger's e-mail address in the log

The log says `Failed login for user: …` with a name or e-mail address you do
not know and that has no account. That is almost always an automated attempt
with credentials from a data leak ("credential stuffing") – nobody has your
password, and there is no account that could be affected. Its details then
say `unknownUser: true`.

The account lockout does not help here: there is no account to lock. That is
what the **IP block** is for (Settings › Security › IP block). It counts the
failures of one address over every entry point together and blocks it after
10 failures within 10 minutes. An unknown user name counts several times –
setting **"Unknown user names count"**, **triple** by default. With 10
failures the 4th attempt with an unknown name already blocks. This applies to
the GateControl login, the login from the portal, the sign-in in the apps and
the logins of protected routes – there also when someone asks for an e-mail
code for an address that has no access to the route. A wrong password of an
existing account, a wrong second factor and a wrong or expired e-mail code
count once. The log shows such failures of a route as `route_auth_failed`
with the route, the masked address (`s***@example.com`) and the IP.

Whoever signs in sees no difference: the answer is the same for unknown and
known names, so nobody can find out which accounts exist. With the e-mail code
login every address sees the same sentence: "If this address has access to
this page, we have sent you a code." Only the address with access really gets
a mail. If you often mistype
your own name, set it to "twice" or "once", or add your network under
**"Never block"**. Addresses in the VPN and in your own network
are never blocked anyway.

**Check:** in the list "Blocked right now" such addresses say "sign-ins with
unknown user names".

### What is in the backup?

GateControl has three kinds of backup. You find them all under “Settings” →
“Backups”:

| File | When it is made | What is in it |
|---|---|---|
| `gatecontrol-v…-v…-….db` (“Snapshots before database updates”) | before every update that changes the database | a copy of GateControl's database as it was before the update. No plugin data. For emergencies only; restoring it is a manual job. |
| `gatecontrol-….json` (“Local backup files”) | on schedule or with “Back up now” | everything you need for a restore: devices, routes, users, settings and the plugins with their databases and files (up to 512 MB). Passwords and keys stay encrypted. |
| `gatecontrol-….gcbk` (“Off-site”) | after every automatic backup, on your NAS or in the cloud | the same `.json`, compressed and encrypted with your passphrase – that is why it is much smaller. Optionally with GateControl's key, so a new server can read it. |

**Not in it:**

- the files of Drive and plugins on a **storage target** (NAS, cloud) – they
  stay there, the backup only knows their list;
- short-lived data such as sessions, logs, login attempts and traffic
  statistics;
- **plugin media** (photos, receipts …), unless you switch on “Plugin media
  in backups” under “Plugins” → “Security & upload” (up to 128 MB);
- parts of a plugin that no longer fit into the backup or could not be read.
  Then the list says “⚠ Not complete: …” with the plugin's name, and the
  dashboard shows an entry under “Problems”. Delete what you no longer need
  in the plugin and make the backup again. Until then, download the last
  complete backup (without ⚠) and keep it.

**Check:** under “Local backup files” the newest backup has no ⚠; for the
off-site target “Test restore” reports no warning.

### Off-site backup to a NAS behind the VPN

Message when testing an off-site backup target, e.g. `WebDAV PROPFIND failed:
connect ECONNREFUSED 89.163.231.212:5006`, followed by “The address points to
this GateControl server itself”: the NAS's name (`nas.example.com`) points at
the GateControl server – from outside you reach the NAS through a GateControl
route, but GateControl itself finds nothing on port 5006 at its own address.

How to fix it (as for Drive's storage target):

1. Settings → Backups → edit the target (or a new one: WebDAV).
2. **Connection**: “Through a VPN device” and the gateway in the home network
   (e.g. “Home Gateway (10.8.0.8)”), **Port** the NAS's WebDAV port
   (Synology: 5006 for https). Or “Through a route” and an L4 route to the
   NAS – it may stay internal only.
3. The **URL** stays `https://nas.example.com:5006/…`: it sets the path, the
   host name and the name the certificate is checked against.
4. **Save.** The test that follows remembers the NAS certificate (“NAS
   certificate remembered”) – you no longer need a PEM file. If “Test” shows
   “The NAS identifies itself with its own certificate” instead, click “Trust
   this device”.

If the NAS is already a storage target for Drive: choose “Take over a storage
target from Drive/plugins” at the top of the dialog. URL, user, connection
and certificate are filled in, the password is copied once when you save.
Give the URL its own sub-folder (e.g. `…/GateControl/Backups/`), so the
backups do not end up between Drive's files. SMB, SFTP and S3 have the same
“Connection” choice.

## Setting up a gateway

### The assistant is still waiting after 10 minutes

- **Synology:** Is the project running in Container Manager? Is `gateway.env` in the folder `config`? Look at the log of `…-gateway-1`.
- **Raspberry Pi:** Is the set-up file in `bootfs/gatecontrol/`? Does the Pi have network? Read `STATUS.txt`.
- **Linux:** `sudo docker compose ps` and `sudo docker compose logs gateway`.
- **Proxmox:** The pairing code is valid for 10 minutes. Create a new code and run the command again.

Did you download the set-up file several times? Then only the last one is valid. Use exactly that one.

### “Bind mount failed: … does not exist” (Synology)

The compose file mounts a folder that does not exist on the NAS. Synology's
Container Manager does not create missing folders itself.

1. Read in the message which folder is missing (usually `gateway-cache` or `gateway-state`).
2. Create it in File Station in `docker/gatecontrol-gateway`.
3. Start the project again.

The NAS package from the current assistant already brings `config/`,
`gateway-state/` and `gateway-cache/`.

**Check:** The project starts without a message, all three containers run.

### “Your kernel does not support PIDs limit …” (Synology)

Harmless. The Synology kernel cannot set the process limit (`pids_limit`) of the
containers `edge` and `mqtt`. Docker leaves it out, everything else runs
normally. You do not need to do anything.

### “/dev/net/tun” is missing (Synology)

On the Synology the gateway needs the device `/dev/net/tun`. If it is missing,
the container `gateway` does not start and the message names `/dev/net/tun`.
Load the module `tun` via SSH with `sudo insmod /lib/modules/tun.ko` – to make
it survive a restart, add it as a task at “Boot-up”, as for
[xt_owner](04-edge-and-smart-home.md#network-fence-missing).

## Running gateway

### Gateway offline

The gateway no longer reports to the server.

1. Does the device have power and network? Does it reach the internet?
2. Is the container `gateway` running? (Logs: [above](#where-do-i-find-the-logs).)
3. Does the device reach the server at your domain and port 51820/UDP?

**Check:** The card under “Gateways” shows the gateway online again.

“Restarting” instead of “Offline”: the gateway stopped properly (restart of the
container or the device) and is expected back for ten minutes.

### “Edge service missing”

The gateway's compose file lacks the services `edge` and `mqtt`. Bring it up to
date with [chapter 6](06-updating-a-gateway.md) – quickest with the button
“Download docker-compose.yml only” below the message (no new keys). On the Raspberry Pi image,
`settings.txt` says `EDGE=off` – change it to `EDGE=on` and restart. More:
[chapter 4](04-edge-and-smart-home.md#edge-service-missing).

If it says “No edge container on this gateway” instead, the gateway runs as a
Proxmox container without Docker ([chapter 3.5](03-gateway-setup.md#35-proxmox)).
There is no compose file to renew there: edge plugins and the MQTT broker need
a gateway with Docker, for example in a VM.

### “Compose file outdated” / “Network fence missing” / xt_owner

The compose file is from before gateway 1.23.0: the edge container still runs
in the host's network there and needs firewall rules for which the Synology
kernel would need the module `xt_owner`. Loading a module via SSH is no longer
needed – download the current file with “Download docker-compose.yml only”
below the message, in which the edge container has no network at all (for
“Network fence missing” update the gateway first). More:
[chapter 4](04-edge-and-smart-home.md#compose-file-outdated).

### “Edge cannot reach GateControl”

The edge container runs but cannot get to the server. If there is another
reverse proxy in front of GateControl (nginx, Traefik, CDN), it has to pass
WebSocket connections to `/api/v1/gateway/edge/ws`. More:
[chapter 4](04-edge-and-smart-home.md#edge-cannot-reach-gatecontrol).

### Home cache: “folder not writable”

The gateway cannot write to its folder `/cache`.

1. Does the compose file have the line `${GC_CACHE_DIR:-./gateway-cache}:/cache`?
   If not: [chapter 6](06-updating-a-gateway.md).
2. Does the folder `gateway-cache` exist next to the compose file (or the folder from `GC_CACHE_DIR`)?
3. Raspberry Pi: is the USB drive from `CACHE_DIR` mounted at start?

**Check:** The tab “Home cache” shows “on”.

### DNS filter: “Port 53 taken”

Another DNS service already runs on the gateway's device (e.g. the Synology
“DNS Server” package, Pi-hole or systemd-resolved). Stop it or move it to
another address. The gateway forces nothing and tries again every minute.

### After switching the DNS filter off the internet no longer works

The router still lists the gateway as DNS server. Clear the field in the router
and switch the devices' Wi-Fi off and on once.

### “LAN discovery is not enabled on your current plan”

The card “Discovered devices” (tab “Network”) and the device suggestions when
creating a route belong to the licence feature “LAN discovery”. Without it the
list stays empty and the scan button is off – this is not a fault of the
gateway. The network watch in the same tab does not depend on it.

### My home network has IPv6 only – what works?

A gateway without a private IPv4 address works for routes (also to targets
with an IPv6 address), the DNS filter, the home cache, the local AI in the home
network and the UPS status (an address like `fd00::10`). GateControl then
recognises “at home” by the private IPv6 addresses (`fd…`): the router has to
distribute such ULA addresses (on the FRITZ!Box in the IPv6 settings of the
home network: “Always assign unique local addresses (ULA)”), the gateway
reports its ULA network, and the app sends its own ULA address along. The
server evaluates this from this release on; an app that only sends IPv4
addresses still counts as away in an IPv6-only network.

These keep working with IPv4 only: network watch, presence in the Wi-Fi and LAN
discovery (they search an IPv4 subnet), the internet quality (targets and
router over IPv4), the MQTT broker and edge plugins in the home network,
Wake-on-LAN, printing & scanning and cameras. Switch them off in an IPv6-only
network – the internet quality would otherwise report a permanent outage.
