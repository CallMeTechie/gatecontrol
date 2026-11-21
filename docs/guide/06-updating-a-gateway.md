# 6. Updating an existing gateway

[← Home gateway features](05-features.md) · [Contents](README.md) · [Next: FAQ →](07-faq.md)

## 6.1 Updating the gateway software

When a new gateway version is out, the gateway's card under “Devices” →
“Gateways” shows a button “Update to …”. One click, confirm “Update” – the
gateway fetches the new image and restarts. If that fails, it rolls back to the
previous version.

GateControl looks for new gateway versions about once an hour. To check right
away: **“Re-check”** in the gateway's view (or the arrows at the top right of
its card). It asks the gateway whether it is reachable – a short message says
“reachable” or “not reachable” – and at the same time looks for a new version
(at most once a minute for the whole server). If there is one, “Update to …”
appears after a few seconds.

For the button to work, auto-update has to be set up on the device:

- **Raspberry Pi image:** already built in.
- **Synology:** the task in the Task Scheduler from [chapter 3.2](03-gateway-setup.md#32-synology-nas), step 10.
- **Linux:** the cron line from [chapter 3.4](03-gateway-setup.md#34-linux-machine-with-docker), step 6.

If it is not set up, the card shows a package icon with “Auto-update needs
setup”. A click opens “Set up auto-update” with the instructions.

While the gateway restarts, the card shows “Updating” with the time it is
expected back by – not “Offline”, and no offline alarm goes out. If it is not
back by then, it counts as offline and the alarm comes then. With its first
heartbeat it is “Online” again. In a pool, the gateway takes its routes back
only after the failback wait; the card counts that time down (“takes its routes
back in 4:30”).

What the new version brings is shown by **“What's new?”** next to “Update to
… available” in the gateway's “Status” (or “More” → “Versions”): every version
with its changes, the installed one marked, the newer ones “Newer”. More in
[3.8](03-gateway-setup.md#38-versions-and-manual).

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
| Cameras (live picture, clips) | 1.28.0 | service `kameras`, volumes `cam-ctl` and `${GC_CAMERA_DIR:-cam-recordings}:/recordings` |
| Radio: zigbee2mqtt, Thread border router | newer than 1.31.0 | services `zigbee2mqtt` and `otbr` (only when chosen), volumes `z2m-data` and `otbr-data` |
| Print office files | 1.33.0 | service `office`, volume `office-ctl` |
| MQTT with the device certificate (port 8883) and second TLS port 8884 | 1.44.0 / 1.45.0 | in the service `gateway` the volume `edge-mqtt-conf` at `/gc-mqtt-conf` (the gateway writes the broker files) |

The volume `edge-mqtt-conf` is in every newly created compose file since
gateway 1.23.0 (server 1.234.0). If your file is older, the edge container
still writes the broker files. It does not have the device certificate, and
GateControl then does not offer the switch. To see whether the volume is
there, run this in the folder of the compose file:

```bash
grep -n "gc-mqtt-conf" docker-compose.yml
```

If no line comes back, the file is too old. Always get the new file through
“Download docker-compose.yml only” on the gateway's page, not the examples on
GitHub. Only the file from GateControl fits your gateway.

You need this chapter if you see one of these:

- “edge service missing” or “edge container not running” in the tab “Edge plugins”,
- “folder not writable” for the home cache,
- your compose file has no line with `gateway-cache` or no service `edge`,
- the switch “Use the device certificate” in Edge › MQTT does not show,
  although the gateway is 1.44.0 or newer.

The **Raspberry Pi image** maintains its compose file itself. This chapter is
for **Synology** and **Linux/Docker**.

## 6.3 Synology: renewing the compose file

Do **not** download the NAS package from the assistant again. It creates a new
access key, and the running gateway loses its connection until it gets the new
`gateway.env`. Get only the compose file instead: “Devices” → “Gateways” → open
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

On start, Docker (or Container Manager) may report for `edge`, `mqtt` and – if
you chose them – `kameras` and `office`: “Your kernel does not support PIDs
limit capabilities or the cgroup is not mounted. PIDs limit discarded.” This
is harmless, you do not need to do anything. More in the
[FAQ](07-faq.md#your-kernel-does-not-support-pids-limit--synology).

**Check:**

- Container Manager → “Container”: `…-gateway-1`, `…-edge-1` and `…-mqtt-1` are running.
- In GateControl, after “Switch edge on”, the tab “Edge plugins” shows
  “Connected since …” and “Edge without network (isolated)”.

## 6.4 Linux/Docker: renewing the compose file

1. Update the gateway first (see [6.1](#61-updating-the-gateway-software)).
2. Get the current compose file: “Devices” → “Gateways” → open your gateway →
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
      - ./config:/config         # the gateway stores gateway.env here (setup page http://<address>:8642)
      - ./gateway-state:/state   # rw: auto-update state (self-update flag + last-pull)
      - ${GC_CACHE_DIR:-./gateway-cache}:/cache   # home cache, only used when switched on
      # edge container: the gateway socket there, its summary back, broker files for mqtt
      - type: volume
        source: edge-run
        target: /run/gc-edge
        volume: { nocopy: true }
      - type: volume
        source: edge-status
        target: /run/gc-edge-status
        read_only: true
        volume: { nocopy: true }
      - type: volume
        source: edge-mqtt-conf
        target: /gc-mqtt-conf
        volume: { nocopy: true }
      # only so that a new volume takes owner 61001 from the image (the gateway cannot read it)
      - type: volume
        source: edge-mqtt
        target: /gc-mqtt
        read_only: true
      - type: volume            # radio: control file for the deconz service
        source: radio-ctl
        target: /gc-radio
        volume: { nocopy: true }
      - type: volume            # local AI: control file for the service ki
        source: ai-ctl
        target: /gc-ai
        volume: { nocopy: true }
      - type: volume            # cameras: control files and picture ring of the service kameras
        source: cam-ctl
        target: /gc-cam
        volume: { nocopy: true }
      - type: volume            # print: office files for the service office, the PDF back
        source: office-ctl
        target: /gc-office
        volume: { nocopy: true }
      - ${GC_CAMERA_DIR:-cam-recordings}:/recordings   # cameras: clips (GC_CAMERA_DIR=/volume1/kameras for a NAS folder)
    environment:
      - LOG_LEVEL=info
      - GATEWAY_ENV_PATH=/config/gateway.env
      - GC_SETUP_PORT=${GC_SETUP_PORT:-8642}
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
  # Same image as the gateway, another command; runs without privileges and WITHOUT
  # NETWORK as user 61001: GateControl, LAN devices and MQTT only through the gateway
  # socket in edge-run (checked by the gateway). No network fence, no kernel module.
  # Stays idle until GateControl switches edge parts on for this gateway.
  # Leave out the services edge and mqtt (and the edge-* volumes) if you do not want edge parts.
  edge:
    image: ghcr.io/callmetechie/gatecontrol-gateway:latest
    entrypoint: ["/sbin/tini", "--", "node", "src/edge/main.js"]
    restart: unless-stopped
    network_mode: none        # no network: server, LAN and MQTT through the gateway socket
    user: "61001:61001"       # fixed UID/GID: group 61001 may use the gateway socket
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
  # the gateway then writes mosquitto.conf/passwd/acl to /gc-mqtt-conf (out of reach of
  # the edge container). The watcher copies them to /gc-mqtt, with TLS certificate and key
  # to /run/gc-mqtt-tls (tmpfs, 0600), restarts Mosquitto when the configuration changes
  # and sends SIGHUP when the accounts or the certificate change. Port 1883 only on LAN
  # addresses, no anonymous access.
  mqtt:
    image: eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f
    entrypoint:
      - /bin/sh
      - -c
      - |
        G=/gc-mqtt-conf; C=/gc-mqtt; T=/run/gc-mqtt-tls; p=""; s=""; r=""
        umask 077
        halt() { if [ -n "$$p" ]; then kill "$$p" 2>/dev/null; wait "$$p" 2>/dev/null; fi; p=""; }
        put() { cp "$$1" "$$2.n" && chmod 600 "$$2.n" && mv -f "$$2.n" "$$2"; }
        take() {
          for f in passwd acl; do put "$$G/$$f" "$$C/$$f" || return 1; done
          if [ ! -w "$$T" ]; then put "$$G/mosquitto.conf" "$$C/mosquitto.conf"; return; fi
          for d in tls tls-self; do
            if [ -d "$$G/$$d" ]; then
              mkdir -p "$$T/$$d" && put "$$G/$$d/server.crt" "$$T/$$d/server.crt" && put "$$G/$$d/server.key" "$$T/$$d/server.key" || return 1
            else rm -rf "$$T/$$d"; fi
          done
          sed -E "s#^(certfile|keyfile) $$G/#\1 $$T/#" "$$G/mosquitto.conf" > "$$C/mosquitto.conf.n" && mv -f "$$C/mosquitto.conf.n" "$$C/mosquitto.conf"
        }
        trap 'halt; exit 0' TERM INT
        mkdir -p "$$C/data"
        while :; do
          if [ -f "$$G/enabled" ] && [ -f "$$G/mosquitto.conf" ]; then
            n="$$(cksum < "$$G/mosquitto.conf")"
            if [ -n "$$p" ] && ! kill -0 "$$p" 2>/dev/null; then p=""; fi
            if [ -z "$$p" ] || [ "$$n" != "$$s" ]; then
              halt; r="$$(cat "$$G/reload" 2>/dev/null)"
              if take; then mosquitto -c "$$C/mosquitto.conf" & p=$$!; s="$$n"; fi
            elif [ "$$(cat "$$G/reload" 2>/dev/null)" != "$$r" ]; then
              r="$$(cat "$$G/reload" 2>/dev/null)"; take && kill -HUP "$$p"
            fi
          else
            halt; s=""
          fi
          sleep 2 & wait $$!
        done
    restart: unless-stopped
    network_mode: host
    user: "61001:61001"       # group 61001: reads the files of the gateway
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:                    # copy of certificate and key (0600, only 61001), never on disk
      - /run/gc-mqtt-tls:size=1m,mode=0700,uid=61001,gid=61001
    mem_limit: 128m
    pids_limit: 32
    depends_on:
      - gateway               # creates the volumes (edge-mqtt with owner 61001 from the image)
    volumes:
      - type: volume          # broker files from the gateway (read only)
        source: edge-mqtt-conf
        target: /gc-mqtt-conf
        read_only: true
        volume: { nocopy: true }
      - type: volume          # copy of the files (0600) + Mosquitto data (data/)
        source: edge-mqtt
        target: /gc-mqtt
        volume: { nocopy: true }
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  # tmpfs shared with the gateway: the gateway (root) creates its socket there, the setgid
  # bit gives it group 61001 → the edge container can use it, not remove or replace it
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
  # tmpfs: broker files, written by the gateway, read by the mqtt service
  edge-mqtt-conf:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=1m,uid=0,gid=61001,mode=2750"
  # packages of the edge parts + gc.store (owner 61001 from the image)
  edge-state:
  # copy of the broker files + Mosquitto data (data/), owner 61001
  edge-mqtt:
  # tmpfs shared: the control files of the gateway for deconz, zigbee2mqtt and otbr and their state (radio)
  radio-ctl:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=1m,uid=0,gid=0,mode=0755"
  # tmpfs shared: the control file of the gateway for the service ki and its state (local AI)
  ai-ctl:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=1m,uid=0,gid=0,mode=0755"
  # zigbee2mqtt: configuration.yaml, the Zigbee network and its devices (radio)
  z2m-data:
  # Thread border router: the active dataset and network data (radio)
  otbr-data:
  # the models of the local AI (1–6 GB each)
  ki-models:
  # tmpfs shared: the control files of the gateway for the service kameras and the picture ring (cameras)
  cam-ctl:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=256m,uid=0,gid=0,mode=0700"
  # clips and thumbnails of the cameras (when GC_CAMERA_DIR is not set)
  cam-recordings:
  # tmpfs shared: office files of the gateway for the service office and the PDFs (only while converting)
  office-ctl:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "size=160m,uid=0,gid=0,mode=0700"
```
<!-- /compose -->

You can move the home cache folder, e.g. to another volume: put a file `.env`
with `GC_CACHE_DIR=/volume1/gatecontrol-cache` next to the compose file, create
the folder and rebuild the project.

Continue with [chapter 7: FAQ and troubleshooting](07-faq.md).
