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
  candidates when `tasks` names nothing that fits.

The jobs with many entries (Drive areas on a storage target,
the home cache of the gateways with thousands of previews, backups) work in
small pieces, and the database writes its log back in a thread of its own.
If the message still comes often, copy the line with `tasks` and `requests`
into a ticket.

### The container does not start or the certificate does not come

- `GC_ADMIN_PASSWORD is not set or still default`: `.env` still says
  `changeme`. Enter a real password, `docker compose up -d`.
- `127.0.0.1:53 is already bound`: another DNS service runs on the server.
- `unable to fetch certificate`: the A record does not point to the server yet
  or port 80 is closed. The server retries by itself.

In detail: [INSTALL.md §9](../../INSTALL.md#9-troubleshooting).

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
