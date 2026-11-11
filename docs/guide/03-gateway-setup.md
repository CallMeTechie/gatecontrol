# 3. Setting up a gateway

[← Setting up the server](02-server-setup.md) · [Contents](README.md) · [Next: Edge plugins and Smart Home →](04-edge-and-smart-home.md)

You always set up a gateway with the **assistant** in GateControl. It creates
the gateway, gives you the right files and shows live whether the gateway has
reported. Then follow the guide for your device:

- [3.2 Synology NAS](#32-synology-nas)
- [3.3 Raspberry Pi](#33-raspberry-pi)
- [3.4 Linux machine with Docker](#34-linux-machine-with-docker)
- [3.5 Proxmox](#35-proxmox)

You keep track of where the gateways are with [locations](#36-locations). Rename,
switch off and remove: [3.7 Managing a gateway](#37-managing-a-gateway).

## 3.1 The assistant “Add gateway”

1. In GateControl, open “Devices” → “Gateways” on the left.
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

### The setup page of the gateway

On a Synology and on a Linux machine there is nothing left to download that
contains access data. The gateway starts without an access file and, as long
as it is not connected, shows a page of its own in the home network:

```
http://<address of the device>:8642
```

There you enter two details from step 3 of the assistant:

- **Server address** – the address you open GateControl with, for example
  `gate.example.com`.
- **Setup code** – `XXXX-XXXX-XXXX-XXXX`. It is valid for 10 minutes and only
  once; “Create a new code” makes a new one.

After “Connect” the gateway fetches its access data itself, stores them in the
folder `config` and shows every step. The assistant in GateControl waits and
continues by itself.

Good to know:

- The page exists **in the home network only**. It does not answer from the
  internet or through the tunnel, and it never shows keys or access data.
- If the device lacks something (no internet, wrong clock, VPN device missing,
  folder `config` not writable), the page says what to do. On a Synology this
  does not hold for the VPN device: if `/dev/net/tun` is missing there, the
  container does not start at all and the page does not exist yet – see the
  [FAQ](07-faq.md#devnettun-is-missing-synology).
- Once connected, the same address only shows the state. This can be switched
  off per gateway: [Status page in the home network](05-features.md#status-page-in-the-home-network).
- At most 5 attempts in 5 minutes. After that it says “Too many attempts”.
- If the page says “… does not answer” or “There is no GateControl at …”:
  check the server address.

**The way before stays:** at the bottom of step 3 there is “Rather download the
file gateway.env (the way before)”. These files contain the access key of the
gateway. Every new download creates a new key – only the file downloaded last
is valid. If the gateway was already connected, the assistant asks first,
because the running gateway loses its connection otherwise. The Raspberry Pi
and Proxmox are set up as before (sections [3.3](#33-raspberry-pi) and
[3.5](#35-proxmox)).

**Check:** Under “Gateways” there is a card with the name of your gateway.

## 3.2 Synology NAS

You need DSM 7.2 or newer and the **Container Manager** package from the Package Center.

### Steps

1. In the assistant choose “Synology NAS” and click “Create gateway and continue”.
2. Step 3 shows the compose file. It contains no access data and is the same
   for every gateway. Click “As a package with folders (ZIP)” – the package
   `gatecontrol-gateway-nas.zip` brings the `docker-compose.yml`, the update
   script `update.sh` and the empty folders `config`, `gateway-state` and
   `gateway-cache`.
3. In DSM open **File Station** → folder `docker` and create a folder
   `gatecontrol-gateway` there.
4. Upload the ZIP file into this folder. Right-click the ZIP → “Extract” → into this folder.

   The folder now looks like this:

   ```
   docker/gatecontrol-gateway/
   ├─ docker-compose.yml
   ├─ update.sh
   ├─ config/
   ├─ gateway-state/
   └─ gateway-cache/
   ```

   > **Synology does not create missing folders.** If a folder the compose
   > file mounts is missing, the start fails with `Bind mount failed: … does not exist`.
   > The package brings `config/`, `gateway-state/` and `gateway-cache/`. If you
   > copy the compose file instead (“Copy”) and paste it in Container Manager,
   > create the three folders in File Station first.

5. Open **Container Manager** → “Project” → “Create”.
6. Project name: `gatecontrol-gateway`. Path: the folder `docker/gatecontrol-gateway`.
7. Choose “Use existing docker-compose.yml” → “Next” → “Done”. Container
   Manager now downloads the images (the NAS needs access to `ghcr.io` and
   Docker Hub for this) and starts three containers: `gateway`, `edge` and `mqtt`.

   > The message **“Your kernel does not support PIDs limit …”** is harmless.
   > The Synology kernel cannot set the process limit (`pids_limit`). Docker
   > leaves it out; everything else runs normally.

   > **If the project does not start and the message names `/dev/net/tun`**,
   > the Synology lacks the VPN device. Without SSH: “Control Panel” → “Task
   > Scheduler” → “Create” → “Triggered Task” → “User-defined script”, user
   > `root`, event “Boot-up”, command `insmod /lib/modules/tun.ko`; select the
   > task, “Run”, then start the project. The assistant shows the same steps.

8. In a browser in the home network open `http://<address of the Synology>:8642`
   – the [setup page of the gateway](#the-setup-page-of-the-gateway).
9. Enter the **server address** and the **setup code** from the assistant
   (each with “Copy”) and click “Connect”. The page shows: code accepted →
   access data stored → VPN tunnel → GateControl reports the gateway as online.

10. The assistant continues to step 4 by itself.
11. **Automatic updates (once, recommended):** “Control Panel” → “Task
    Scheduler” → “Create” → “Scheduled Task” → “User-defined script”.
    - User: `root`
    - Schedule: daily, repeat every minute
    - Command: copy it from the assistant (unfold it at the bottom of step 3). It looks like this:

      ```bash
      PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/volume1/docker/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/volume1/docker/gatecontrol-gateway bash /volume1/docker/gatecontrol-gateway/update.sh
      ```

      If the folder `docker` is on another volume, replace `volume1`.

**Check:**

- Container Manager → “Container”: `gatecontrol-gateway-gateway-1`,
  `gatecontrol-gateway-edge-1` and `gatecontrol-gateway-mqtt-1` are running.
- The page of the gateway shows “Connected”, the assistant “NAS has reported”
  and “Tunnel is up”.

Nothing after 10 minutes? Is the project running? What does
`http://<address of the Synology>:8642` show? The log (Container Manager →
“Container” → `…-gateway-1` → “Log”) names the reason.

**The way before (with a file):** “Rather download the file gateway.env” in the
assistant. The package `gatecontrol-gateway-nas.zip` then also contains
`config/gateway.env` – delete the ZIP after extracting, it contains the access
key. You do not need the setup page then.

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
3. Create a folder on the Linux machine and save the compose file from the
   assistant there as `docker-compose.yml` (“Copy” or “Download”). It contains
   no access data:

   ```bash
   sudo mkdir -p /opt/gatecontrol-gateway
   cd /opt/gatecontrol-gateway
   sudo nano docker-compose.yml      # paste the content from the assistant, save
   ```

4. Start the gateway:

   ```bash
   sudo docker compose up -d
   ```

   Docker creates the folders `config`, `gateway-state` and `gateway-cache` by itself.

5. In a browser in the home network open `http://<address of the machine>:8642`
   – the [setup page of the gateway](#the-setup-page-of-the-gateway) –, enter
   the **server address** and the **setup code** from the assistant and click
   “Connect”. The assistant then continues to step 4 by itself.
6. **Automatic updates (once, recommended):** download `update.sh` from the
   assistant (unfold it at the bottom of step 3) to `/opt/gatecontrol-gateway`,
   open `sudo crontab -e` and add the line from the assistant:

   ```
   * * * * * PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/opt/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/opt/gatecontrol-gateway bash /opt/gatecontrol-gateway/update.sh
   ```

**Check:**

- `sudo docker compose ps` shows `gateway`, `edge` and `mqtt` as running.
- The page of the gateway shows “Connected”, the assistant “Gateway has
  reported” and “Tunnel is up”.
- If not: `sudo docker compose logs gateway` names the reason.

In the network mode “Bridge” the compose file publishes the port 8642 of the
setup page (`ports: "8642:8642"`).

**The way before (with a file):** “Rather download the file gateway.env” in the
assistant, then download `docker-compose.yml`, `gateway.env` and `update.sh`,
put `gateway.env` into `/opt/gatecontrol-gateway/config/`
(`sudo chmod 600 config/gateway.env`) and run `sudo docker compose up -d`.

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
GateControl says so at the gateway itself: the tabs “Edge plugins” and “MQTT”
and the row “Edge plugins & MQTT” show “No edge container on this gateway”.
This is a note – the switches stay usable.

**Check:** The assistant shows “Gateway has reported”.

## 3.6 Locations

A location says where a gateway is – for example “Home”, “Office” or
“Parents”. With several gateways in different places this keeps the overview.
A location has a name and, if you like, an address (street, postcode, town,
country). The peer group of a gateway is something else and stays as it is
(changed in the gateway under “More” → “Change name and group …”, see
[3.7](#37-managing-a-gateway)).

**Create and change locations:**

1. “Devices” → “Gateways” → “Locations” at the top.
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

## 3.7 Managing a gateway

Gateways are managed on the page “Gateways” only – the page “Peers / Clients”
shows devices such as phones and laptops. Open “Devices” → “Gateways”, click
your gateway and then “More” at the top right. Under “Manage” you find:

- **Change name and group …** – name, description and peer group.
- **Renew access …** – makes the current access of the gateway invalid, for
  example when a `gateway.env` may have fallen into the wrong hands.
  GateControl always asks first: the running gateway loses its connection at
  once. Then GateControl shows the **server address** and a **setup code**.
  Open the page of the gateway in its home network
  (`http://<address of the gateway>:8642`) – after about two minutes it asks
  for a new code. Enter both there; the server address is fixed on the page,
  only the code can be entered. Routes and settings are kept. Older gateways
  without this page and gateways with a read-only folder `config` get a new
  file as before instead (the assistant at step 3, “Download gateway.env
  again”).
- **Change proxy port …** – the port on which the gateway takes requests in the
  tunnel (default 8080; on a Synology e.g. 18080 when 8080 is taken).
- **Disable …** – cuts the tunnel. Routes through this gateway cannot be
  reached then. The gateway is listed at the bottom of the page under
  “Disabled gateways”; “Enable” switches it on again.
- **Remove gateway …** – shows which routes are switched off by it and asks for
  the tunnel IP of the gateway to be sure. The routes stay (disabled) and can be
  pointed at another gateway later.

**Check:** After “Change name and group …” the new name is on the card and in
the list of gateways.

## 3.8 Versions and manual

Like a plugin, every gateway has its versions and its manual. Click “More” at
the top right of the gateway:

- **Versions** – every gateway version with its changes, the newest at the
  top. The version this gateway runs is marked **“Installed”**; every newer
  one **“Newer”**. If there is an update, a line above says how many versions
  it brings. “What's new?” next to “Update to … available” in “Status” leads
  here as well.
- **Manual** – chapters 3 to 7 of this guide right inside GateControl, with a
  table of contents. It ships with GateControl and needs no internet.

GateControl loads the version list from GitHub (at most every 6 hours) and
keeps it. If your server cannot reach GitHub right now, you see the last
loaded list with a hint – or, if it was never loaded, a link to the versions
on GitHub.

**Check:** “More” → “Versions” shows “Installed” next to your gateway's
version.

Continue with [chapter 4: Edge plugins and Smart Home](04-edge-and-smart-home.md).
