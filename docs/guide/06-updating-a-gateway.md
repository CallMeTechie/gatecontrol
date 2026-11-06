# 6. Updating an existing gateway

[← Home gateway features](05-features.md) · [Contents](README.md) · [Next: FAQ →](07-faq.md)

## 6.1 Updating the gateway software

When a new gateway version is out, the gateway's card under “Network” →
“Gateways” shows a button “Update to …”. One click, confirm “Update” – the
gateway fetches the new image and restarts. If that fails, it rolls back to the
previous version.

For the button to work, auto-update has to be set up on the device:

- **Raspberry Pi image:** already built in.
- **Synology:** the task in the Task Scheduler from [chapter 3.2](03-gateway-setup.md#32-synology-nas), step 10.
- **Linux:** the cron line from [chapter 3.4](03-gateway-setup.md#34-linux-machine-with-docker), step 6.

If it is not set up, the card shows a package icon with “Auto-update needs
setup”. A click opens “Set up auto-update” with the instructions.

**Check:** After a few minutes the card shows the new version.

## 6.2 Why the compose file needs extra care

Auto-update **only swaps the image**. It **never** changes the compose file
`docker-compose.yml` on your device. New features that need additional
containers or folders therefore do not arrive by themselves:

| Feature | since gateway | needs in the compose file |
|---|---|---|
| Auto-update | – | `./gateway-state:/state` |
| Edge plugins and MQTT | 1.19.0 | services `edge` and `mqtt`, volumes `edge-run`, `edge-status`, `edge-state`, `edge-mqtt` |
| Home cache | 1.22.0 | `${GC_CACHE_DIR:-./gateway-cache}:/cache` |
| Failover pools, scanning via another gateway, ping of the internet quality | – | the capabilities `NET_RAW`, `SETGID` and `SETUID` under `cap_add` |

You need this chapter if you see one of these:

- “edge service missing” or “edge container not running” in the tab “Edge plugins”,
- “folder not writable” for the home cache,
- your compose file has no line with `gateway-cache` or no service `edge`.

The **Raspberry Pi image** maintains its compose file itself. This chapter is
for **Synology** and **Linux/Docker**.

## 6.3 Synology: renewing the compose file

Do **not** download the NAS package from the assistant again. It creates a new
access key, and the running gateway loses its connection until it gets the new
`gateway.env`. Get only the compose file instead: “Network” → “Gateways” → open
your gateway → icon “Download docker-compose.yml only” (file with an arrow, top
right) → “Synology NAS”, “Host” → “Download”. This creates no new keys. If the tab
“Edge plugins” shows “edge service missing”, the same button is there as well.
The file is the same as the [example file](#example-file-synology) below.

1. **Update the gateway first.** If the card shows “Update to …”, click it and
   wait until the new version shows. Then the new image is on the NAS, which the
   edge container needs as well.
2. **Save the old file.** File Station → `docker/gatecontrol-gateway` →
   download `docker-compose.yml`.
3. **Create folders.** In File Station, create the folders `gateway-cache` and –
   if it is missing – `gateway-state` in `docker/gatecontrol-gateway`. Synology
   does not create missing folders itself.
4. **Stop the project.** Container Manager → “Project” → `gatecontrol-gateway` → “Stop”.
5. **Put in the new file.** Open the tab “YAML configuration” of the project,
   replace the whole content with the downloaded file (or the [example file](#example-file-synology)) and save.
6. **Build and start again.** Rebuild the project and start it.

If you had changes of your own in the old file (for example another folder for
`config`), carry them over into the new file. You no longer need a `TZ=…` line:
the gateway gets the time zone from the server.

Via SSH, steps 3 to 6 also work like this (after you put the new
`docker-compose.yml` into the folder):

```bash
cd /volume1/docker/gatecontrol-gateway
sudo mkdir -p gateway-state gateway-cache
sudo docker compose up -d
```

**Check:**

- Container Manager → “Container”: `…-gateway-1`, `…-edge-1` and `…-mqtt-1` are running.
- In GateControl, after “Switch edge on”, the tab “Edge plugins” shows
  “Connected since …” and “Network fence active (iptables)”.

## 6.4 Linux/Docker: renewing the compose file

1. Update the gateway first (see [6.1](#61-updating-the-gateway-software)).
2. Get the current compose file: “Network” → “Gateways” → open your gateway →
   icon “Download docker-compose.yml only” → “Linux machine with Docker”, “Host
   (recommended)” → “Download”. This creates no new keys. Do **not** download
   the `gateway.env` again – that creates a new access key.
3. On the Linux machine:

   ```bash
   cd /opt/gatecontrol-gateway
   sudo cp docker-compose.yml docker-compose.yml.bak
   sudo mv ~/docker-compose.yml .
   sudo mkdir -p gateway-state gateway-cache
   sudo docker compose up -d
   ```

**Check:** `sudo docker compose ps` shows `gateway`, `edge` and `mqtt` as running.

## Example file Synology

This is exactly the file the assistant creates for the Synology (host network,
WireGuard in user space). Create the folders `config/` (with `gateway.env`),
`gateway-state/` and `gateway-cache/` next to it first.

<!-- compose:synology-host -->
```yaml
# Userspace WireGuard (wireguard-go) — for Synology DSM and any host
# without the WireGuard kernel module. ~2-3x slower than kernel WG
# but reliable and needs no kernel modifications.
services:
  gateway:
    image: ghcr.io/callmetechie/gatecontrol-gateway:latest
    restart: unless-stopped
    network_mode: host
    cap_drop:
      - ALL
    cap_add:
      - NET_ADMIN         # wg-quick + WireGuard interface, ip/iptables
      - NET_BIND_SERVICE  # L4 routes and the DNS filter on ports <1024
      - NET_RAW           # ping (internet quality), keepalived VRRP + GARP (failover)
      - SETGID            # keepalived enable_script_security (health-check script)
      - SETUID            # keepalived enable_script_security (health-check script)
    devices:
      - /dev/net/tun:/dev/net/tun
    read_only: true
    user: "0:0"                # wg-quick needs root; only the capabilities above
    tmpfs:
      - /tmp
      - /run
      - /etc/wireguard
    volumes:
      - ./config:/config:ro
      - ./gateway-state:/state   # rw: auto-update state (self-update flag + last-pull)
      - ${GC_CACHE_DIR:-./gateway-cache}:/cache   # home cache, only used when switched on
      # edge container: credentials + fence marker there, its summary back
      - type: volume
        source: edge-run
        target: /run/gc-edge
        volume: { nocopy: true }
      - type: volume
        source: edge-status
        target: /run/gc-edge-status
        read_only: true
        volume: { nocopy: true }
    environment:
      - LOG_LEVEL=info
      - GATEWAY_ENV_PATH=/config/gateway.env
      - WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go
    healthcheck:
      interval: 60s
      timeout: 5s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # Edge parts of plugins in the home network (switched on per gateway in GateControl).
  # Same image as the gateway, another command; runs without privileges as user 61001
  # and stays idle until GateControl switches edge parts on for this gateway.
  # Leave out the services edge and mqtt (and the edge-* volumes) if you do not want edge parts.
  edge:
    image: ghcr.io/callmetechie/gatecontrol-gateway:latest
    entrypoint: ["/sbin/tini", "--", "node", "src/edge/main.js"]
    restart: unless-stopped
    network_mode: host        # LAN devices (UDP/multicast/mDNS) like the gateway
    user: "61001:61001"       # fixed UID: the network fence (owner match) depends on it
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=16m
    mem_limit: 512m
    pids_limit: 256
    volumes:
      - type: volume
        source: edge-run
        target: /run/gc-edge
        read_only: true
        volume: { nocopy: true }
      - type: volume
        source: edge-status
        target: /run/gc-edge-status
        volume: { nocopy: true }
      - edge-state:/state-edge
      - edge-mqtt:/gc-mqtt   # broker files (owner 61001 from the image)
    environment:
      - LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "node", "src/edge/healthcheck.js"]
      interval: 60s
      timeout: 5s
      retries: 3
      start_period: 60s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # Local MQTT broker. Idle (only a small watcher) until GateControl switches MQTT on;
  # the edge host then writes mosquitto.conf/passwd/acl to /gc-mqtt. Port 1883 only on
  # LAN addresses, no anonymous access. The watcher restarts Mosquitto when the
  # configuration changes and sends SIGHUP when the accounts change.
  mqtt:
    image: eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f
    entrypoint:
      - /bin/sh
      - -c
      - |
        C=/gc-mqtt; p=""; s=""; r=""
        halt() { if [ -n "$$p" ]; then kill "$$p" 2>/dev/null; wait "$$p" 2>/dev/null; fi; p=""; }
        trap 'halt; exit 0' TERM INT
        while :; do
          if [ -f "$$C/enabled" ] && [ -f "$$C/mosquitto.conf" ]; then
            n="$$(cksum < "$$C/mosquitto.conf")"
            if [ -n "$$p" ] && ! kill -0 "$$p" 2>/dev/null; then p=""; fi
            if [ -z "$$p" ] || [ "$$n" != "$$s" ]; then
              halt; mosquitto -c "$$C/mosquitto.conf" & p=$$!
              s="$$n"; r="$$(cat "$$C/reload" 2>/dev/null)"
            elif [ "$$(cat "$$C/reload" 2>/dev/null)" != "$$r" ]; then
              r="$$(cat "$$C/reload" 2>/dev/null)"; kill -HUP "$$p"
            fi
          else
            halt; s=""
          fi
          sleep 2 & wait $$!
        done
    restart: unless-stopped
    network_mode: host
    user: "61001:61001"       # like the edge host: reads its files (0600)
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    mem_limit: 128m
    pids_limit: 32
    depends_on:
      - edge                  # creates the volume with owner 61001
    volumes:
      - type: volume
        source: edge-mqtt
        target: /gc-mqtt
        volume: { nocopy: true }
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  # tmpfs shared with the gateway: the gateway (root) writes, the setgid bit gives every
  # file group 61001 → the edge container can read, not change
  edge-run:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=1m,uid=0,gid=61001,mode=2750"
  # tmpfs shared: the edge host writes its summary, the gateway reads it
  edge-status:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=1m,uid=61001,gid=61001,mode=0755"
  # packages of the edge parts + gc.store (owner 61001 from the image)
  edge-state:
  # broker files from the edge host + Mosquitto data (data/)
  edge-mqtt:
```
<!-- /compose -->

You can move the home cache folder, e.g. to another volume: put a file `.env`
with `GC_CACHE_DIR=/volume1/gatecontrol-cache` next to the compose file, create
the folder and rebuild the project.

Continue with [chapter 7: FAQ and troubleshooting](07-faq.md).
