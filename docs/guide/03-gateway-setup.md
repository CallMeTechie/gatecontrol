# 3. Setting up a gateway

[← Setting up the server](02-server-setup.md) · [Contents](README.md) · [Next: Edge plugins and Smart Home →](04-edge-and-smart-home.md)

You always set up a gateway with the **assistant** in GateControl. It creates
the gateway, gives you the right files and shows live whether the gateway has
reported. Then follow the guide for your device:

- [3.2 Synology NAS](#32-synology-nas)
- [3.3 Raspberry Pi](#33-raspberry-pi)
- [3.4 Linux machine with Docker](#34-linux-machine-with-docker)
- [3.5 Proxmox](#35-proxmox)

You keep track of where the gateways are with [locations](#36-locations).

## 3.1 The assistant “Add gateway”

1. In GateControl, open “Network” → “Gateways” on the left.
2. Click “Add gateway” at the top right.
3. **Step 1:**
   - “Name”: for example `NAS basement`. Allowed are letters a–z, digits,
     spaces, dot, hyphen and underscore (no umlauts, at most 63 characters).
   - “Location (optional)”: where the gateway is, for example “Home” or
     “Office”. Choose an existing location, “New location …” (name, town and,
     if you like, the address right below) or keep “No location”. More in
     [3.6](#36-locations).
   - “Where should the gateway run?”: “Raspberry Pi”, “Synology NAS”,
     “Proxmox” or “Other Linux machine”.
4. **Step 2** only exists for the Raspberry Pi (see [3.3](#33-raspberry-pi)).
5. Click “Create gateway and continue”.
6. **Step 3** shows the instructions for your device. Follow the section below.
7. **Step 4** waits for the gateway and ticks off: “Gateway created” →
   “… has reported” → “Tunnel is up” → “Hardware detected”.
8. Click “Done – to the gateway”.

You can close the assistant at any time. The gateway then shows as a card with
“waiting for first start”. “Continue set-up” takes you back to where you left off.

**Important about the set-up files:** They contain the gateway's access key.
Every new download creates a new key – only the file downloaded last is valid.
If the gateway was already connected, the assistant asks first, because the
running gateway would otherwise lose its connection.

**Check:** Under “Gateways” there is a card with the name of your gateway.

## 3.2 Synology NAS

You need DSM 7.2 or newer and the **Container Manager** package from the Package Center.

### Steps

1. In the assistant choose “Synology NAS” and click “Create gateway and continue”.
2. Click `gatecontrol-gateway-nas.zip`. The package contains the ready
   `docker-compose.yml`, the `gateway.env`, the update script `update.sh` and
   the empty folders `gateway-state` and `gateway-cache`.
3. In DSM open **File Station** → folder `docker`.
4. Create a folder `gatecontrol-gateway` there.
5. Upload the ZIP file into this folder. Right-click the ZIP → “Extract” → into this folder.
6. Delete the ZIP file afterwards – it contains the access key.

   The folder now looks like this:

   ```
   docker/gatecontrol-gateway/
   ├─ docker-compose.yml
   ├─ update.sh
   ├─ config/
   │  └─ gateway.env
   ├─ gateway-state/
   └─ gateway-cache/
   ```

   > **Synology does not create missing folders.** If a folder the compose
   > file mounts is missing, the start fails with `Bind mount failed: … does not exist`.
   > The package brings `config/`, `gateway-state/` and `gateway-cache/`. If you
   > write or change the compose file yourself, create missing folders in File
   > Station first.

7. Open **Container Manager** → “Project” → “Create”.
8. Project name: `gatecontrol-gateway`. Path: the folder `docker/gatecontrol-gateway`.
9. Choose “Use existing docker-compose.yml” → “Next” → “Done”. Container
   Manager now downloads the images (the NAS needs access to `ghcr.io` and
   Docker Hub for this) and starts three containers: `gateway`, `edge` and `mqtt`.

   > The message **“Your kernel does not support PIDs limit …”** is harmless.
   > The Synology kernel cannot set the process limit (`pids_limit`). Docker
   > leaves it out; everything else runs normally.

10. **Automatic updates (once, recommended):** “Control Panel” → “Task
    Scheduler” → “Create” → “Scheduled Task” → “User-defined script”.
    - User: `root`
    - Schedule: daily, repeat every minute
    - Command: copy it from the assistant. It looks like this:

      ```bash
      PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/volume1/docker/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/volume1/docker/gatecontrol-gateway bash /volume1/docker/gatecontrol-gateway/update.sh
      ```

      If the folder `docker` is on another volume, replace `volume1`.
11. In the assistant click “Project is running – next” and wait for step 4.

**Check:**

- Container Manager → “Container”: `gatecontrol-gateway-gateway-1`,
  `gatecontrol-gateway-edge-1` and `gatecontrol-gateway-mqtt-1` are running.
- The assistant shows “NAS has reported” and “Tunnel is up”.

Nothing after 10 minutes? Is the project running? Is `gateway.env` in the folder
`config`? The log (Container Manager → “Container” → `…-gateway-1` → “Log”)
names the reason.

### Edge on the Synology

For [edge plugins](04-edge-and-smart-home.md) there is nothing more to do on
the Synology: the container `edge` runs without a network of its own, the
container `gateway` makes its connections and checks them. No kernel module
(formerly `xt_owner`) and no SSH are needed. If the compose file is from before
gateway 1.23.0, GateControl shows “Compose file outdated” – then download the
current file, see [chapter 4](04-edge-and-smart-home.md#compose-file-outdated).

## 3.3 Raspberry Pi

You need: a Raspberry Pi 3 B+, 4, 5 or Zero 2 W, a microSD card (at least
16 GB, class A1/A2), a PC with a card reader and the free
[Raspberry Pi Imager](https://www.raspberrypi.com/software/). No Docker or
Linux knowledge is needed.

### Steps

1. In the assistant choose “Raspberry Pi” and click “Next”.
2. **Step 2 – “Set up the Raspberry Pi”:**
   - “Model”: your Pi.
   - “Network”: “LAN cable” (more reliable) or “WLAN” with name and password.
     The Pi supports WPA2 and WPA2/WPA3 mixed mode, not WPA3 only.
   - “Zigbee radio”: “Detect automatically” (for RaspBee II or ConBee) or “Off”.
   - “Advanced (optional)”: device name, time zone, WLAN country, SSH key.
     Without an SSH key, SSH stays off.
3. Click “Create gateway and continue”.
4. Download **both files**: the “Pi image” (`.img.xz`) and the “Set-up file
   (gatecontrol-setup.zip)”.
5. Start the Raspberry Pi Imager:
   1. “Choose device” → your Pi.
   2. “Choose OS” → at the very bottom “Use custom” → the `.img.xz` file. Do not unpack it.
   3. “Choose storage” → your card.
   4. At “Apply OS customisation?” choose **No** – WLAN etc. come from the set-up file.
   5. “Write” and wait (about 5–10 minutes).
6. Unplug the card and plug it in again. A drive **`bootfs`** appears.
7. Unpack `gatecontrol-setup.zip` directly onto `bootfs` so that it looks like this:

   ```
   bootfs/
   └─ gatecontrol/
      ├─ gateway.env
      └─ settings.txt
   ```

8. Eject the card safely, put it into the Pi, plug in the LAN cable (if used), power on.
9. In the assistant click “Pi is plugged in – next”. The first start takes 3–5 minutes.

The Pi takes over `gateway.env`, the WLAN password and the SSH key at the start
and then deletes them from the card. Do not leave the card lying around until then.

**Check:** The assistant shows “Pi has reported” and “Tunnel is up”. Nothing
after 10 minutes? Put the card into the PC: the file
`bootfs/gatecontrol/STATUS.txt` names the reason.

### settings.txt

The file `bootfs/gatecontrol/settings.txt` has one setting per line,
`NAME=VALUE`, **without quotes**. The assistant fills it for you. The most
important entries:

| Entry | Meaning |
|---|---|
| `HOSTNAME` | Device name in the network |
| `ZIGBEE` | `auto`, `on` or `off` |
| `EDGE` | `on` (default) or `off` – edge container and MQTT broker |
| `TIMEZONE` | Time zone of the Pi, e.g. `Europe/Berlin` |
| `WIFI_SSID`, `WIFI_PSK`, `WIFI_COUNTRY`, `WIFI_HIDDEN` | WLAN |
| `SSH_AUTHORIZED_KEY` | public SSH key (user `gcadmin`) |
| `CACHE_DIR` | Folder for the [home cache](05-features.md#home-cache), best on a USB drive |

A wrong value is then named in `STATUS.txt`. All entries are explained in the
[Pi guide in the gateway repository](https://github.com/CallMeTechie/gatecontrol-gateway/blob/main/docs/deployment/raspberry-pi.md#settingstxt-wlan-zeitzone-ssh) (German).

**Updates:** The image has auto-update built in. You do not need to set up anything.

**Zigbee:** If the Pi detects a RaspBee II or ConBee, it starts deCONZ as well.
Then open Phoscon (`http://<IP-of-the-Pi>:8090`) and set a password **right away**.

## 3.4 Linux machine with Docker

You need a Linux machine with Docker and Docker Compose in the same network as
your devices. The WireGuard kernel module has to be present (standard on
Debian 11+ and Ubuntu 22.04+).

### Steps

1. In the assistant choose “Other Linux machine” and click “Create gateway and continue”.
2. “Network mode”: **“Host (recommended)”**. Only then do L4 routes,
   Wake-on-LAN, edge plugins and the features of chapter 5 work.
3. Download the three files: `docker-compose.yml`, `gateway.env`, `update.sh`.
4. Copy the files to the Linux machine (e.g. with `scp` into your home
   directory) and create the folder:

   ```bash
   sudo mkdir -p /opt/gatecontrol-gateway/config /opt/gatecontrol-gateway/gateway-state /opt/gatecontrol-gateway/gateway-cache
   cd /opt/gatecontrol-gateway
   sudo mv ~/docker-compose.yml ~/update.sh .
   sudo mv ~/gateway.env config/
   sudo chmod 600 config/gateway.env
   sudo chmod +x update.sh
   ```

5. Start the gateway:

   ```bash
   cd /opt/gatecontrol-gateway
   sudo docker compose up -d
   ```

6. **Automatic updates (once, recommended):** open `sudo crontab -e` and add
   the line from the assistant:

   ```
   * * * * * PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/opt/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/opt/gatecontrol-gateway bash /opt/gatecontrol-gateway/update.sh
   ```

7. In the assistant click “Container is running – next”.

**Check:**

- `sudo docker compose ps` shows `gateway`, `edge` and `mqtt` as running.
- The assistant shows “Gateway has reported” and “Tunnel is up”.
- If not: `sudo docker compose logs gateway` names the reason.

## 3.5 Proxmox

You need Proxmox VE 8 or newer and the host shell (web UI → node → “Shell”).

1. In the assistant choose “Proxmox” and click “Create gateway and continue”.
2. Copy the command shown and run it in the Proxmox shell. It creates an LXC
   container with the gateway and pairs it with a one-time code. The code is
   valid for 10 minutes; “New code” gives you a new one.
3. Wait 1–3 minutes.

This way installs the gateway **without Docker**. Edge plugins and the MQTT
broker need the edge container and therefore do not run there. If you need
them, use [3.4](#34-linux-machine-with-docker) in a VM.

**Check:** The assistant shows “Gateway has reported”.

## 3.6 Locations

A location says where a gateway is – for example “Home”, “Office” or
“Parents”. With several gateways in different places this keeps the overview.
A location has a name and, if you like, an address (street, postcode, town,
country). The peer group of a gateway is something else and stays as it is
(changed under “Peers”).

**Create and change locations:**

1. “Network” → “Gateways” → “Locations” at the top.
2. “New location”: enter a name, the address is optional. “Create location”.
3. The pencil changes a location, the bin deletes it. If gateways are still
   there, GateControl asks first. The gateways stay as they are and show under
   “No location” afterwards.

**Set the location of a gateway:**

- when creating it in the assistant (step 1, see [3.1](#31-the-assistant-add-gateway)), or
- on the gateway: “More” → “Change location …”, in the overview in the card
  “Device & software” at “Location”, or with the location below the name.
  If the gateway is in a pool, “Also use it for …” sets the location for the
  pool partner at the same time.

**The list by location:** As soon as there is a location, the page “Gateways”
groups the gateways by location – one section per location with the address
and “x of y online”, “No location” last. “Group by: Locations | Pools”
switches to the view by pool; there each card shows its location. The browser
remembers your choice. Locations without a gateway only show in the dialog
“Locations”.

Only admins manage locations. They are part of the backup and come back with
a restore.

**Check:** Under “Gateways” your gateway is in the section of its location.

Continue with [chapter 4: Edge plugins and Smart Home](04-edge-and-smart-home.md).
