# 4. Edge plugins and Smart Home

[← Setting up a gateway](03-gateway-setup.md) · [Contents](README.md) · [Next: Home gateway features →](05-features.md)

## What is edge?

Some plugins – for example **Smart Home** – need a part that runs right in your
home network. It finds devices such as Shelly or Tasmota there and talks to
them. GateControl calls this part the **edge part**.

Edge parts run on the gateway in their own isolated container called `edge`.
It has **no network of its own**: what it needs, the container `gateway` does
for it and checks every request. So an edge part only reaches devices in your
home network and GateControl – not the internet and not the tunnel. No firewall
rules or kernel modules are needed for that. On top comes a local **MQTT broker** in the container `mqtt`, where
devices report right in the home network, without a cloud.

As long as you do not switch edge on, both containers are idle.

### Requirements

- Gateway version **1.23.0** or later (edge without network; from 1.19.0 edge
  only works with a network fence, see [compose file outdated](#compose-file-outdated)).
- A gateway with Docker in **host network mode**: the Synology package from the
  assistant, the Raspberry Pi image or Linux with “Host (recommended)”. Bridge
  mode and the Proxmox installer have no edge container.
- The compose file contains the services `edge` and `mqtt`, `edge` with
  `network_mode: none`. Gateways from the current assistant have them. Replace
  older compose files with the button “Download docker-compose.yml only”
  ([chapter 6](06-updating-a-gateway.md)) – on the Synology too, nothing is
  needed via SSH.

## 4.1 Switching edge on

1. Install the plugin, for example “Smart Home”: “Settings” → “Plugins”.
2. Open “Network” → “Gateways” and click your gateway.
3. Switch to the tab “Edge plugins”.
4. Click “Switch edge on”.
5. Look at the line at the top of the tab:
   - “Connected since …” – the edge container is connected to GateControl.
   - “Edge without network (isolated)” – the isolation is in place. With an
     older compose file it says “Network fence active (iptables)” or “(nft)”.
6. Under “Plugins with an edge part” switch the plugin on. A window shows the
   capabilities the edge part gets. Read them and click “Agree and switch on”.

**Check:** The plugin shows “running”. Instead of “Connected since …” there is
a reason? Then see [4.4](#44-status-messages-and-what-helps).

## 4.2 Switching the MQTT broker on

Only needed if devices such as Shelly, Tasmota or ESPHome should report via MQTT.

1. Open the tab “MQTT” of the gateway.
2. Switch on “MQTT broker in the home network”. The broker only starts when edge is on.
3. Under “Accounts” create **one account per device**. Anonymous access is blocked.
4. Enter the “Address” shown (port 1883) and the account in the device.

**Check:** The “Status” shows “running” and the number of connected clients goes up.

## 4.3 Where do my devices show up?

The devices show up **in the plugin**, on the left under “Integrations” →
“Smart Home” – not on the gateway page. The gateway page only shows whether
the edge part runs, and has its “Log”.

### Zigbee with deCONZ (Raspberry Pi)

If your Pi has a RaspBee II or ConBee, the assistant offers “Add to Smart Home”
in step 4. GateControl then creates an internal route to deCONZ (only reachable
over the VPN) and gives it to the Smart Home plugin. Then choose “Connect
gateway” in the plugin. With gateway 1.25.0+ GateControl opens deCONZ briefly by
itself – “Unlock gateway” in Phoscon is then not needed. The same works in the tab
“Radio” of the gateway, where you also switch Zigbee on and off and pair devices
([chapter 5](05-features.md#radio-zigbee-bluetooth-thread)).

**Check:** The Zigbee devices show up in the Smart Home plugin.

## 4.4 Status messages and what helps

If the tab “Edge plugins” shows one of the following reasons instead of
“Connected since …”, do this. Next to the reason there is also a link “Guide”.

### Gateway offline

The gateway no longer reports at all. The edge part starts as soon as it is back.

1. Does the device have power and network?
2. Is the container `gateway` running? (Synology: Container Manager →
   “Container”; Linux: `sudo docker compose ps`; Pi: `bootfs/gatecontrol/STATUS.txt`.)
3. Look at the log of the container `gateway` (see [chapter 7](07-faq.md#where-do-i-find-the-logs)).

**Check:** The gateway's card shows it online again.

### Edge service missing

The gateway runs, but its compose file lacks the service `edge` (or the service
`gateway` lacks the volume `edge-run`). This is typical for gateways set up
before edge existed.

- **Synology / Linux:** Bring the compose file up to date. Below the message is
  the button “Download docker-compose.yml only”: it fetches the current file
  without new keys and shows how to put it in place (Synology: create the folder
  `gateway-cache`, stop the project, replace the YAML, rebuild the project).
  In detail: [chapter 6](06-updating-a-gateway.md).
- **Raspberry Pi image:** `settings.txt` says `EDGE=off`. Change it to
  `EDGE=on` and restart the Pi.

**Check:** The reason disappears and “Connected since …” shows.

### Edge container not running

The service `edge` is set up but does not report.

1. Is the container `edge` running? Synology: Container Manager → “Container” →
   `…-edge-1`. Linux: `sudo docker compose ps`.
2. Look at its log (Container Manager or `sudo docker compose logs edge`).
3. If the service `gateway` lacks the volume `edge-status`, the report is
   missing as well. Then [chapter 6](06-updating-a-gateway.md) helps.

**Check:** `…-edge-1` runs and is “healthy” after about a minute.

### Compose file outdated

The compose file is from before gateway 1.23.0: the container `edge` still runs
in the host's network there and therefore needs a network fence made of
firewall rules. The gateway could not set it – on the Synology the kernel
usually lacks the module `xt_owner`. Without it no edge part starts. The
gateway itself (routes, tunnel) keeps working normally.

The way out is the current compose file, in which `edge` has no network at all:

1. Click “Download docker-compose.yml only” below the message.
2. Put it in place as shown there (Synology: create the folder `gateway-cache`,
   stop the project, replace the YAML, rebuild the project). In detail:
   [chapter 6](06-updating-a-gateway.md).

The **Raspberry Pi image** practically never shows this (the Pi can set the
network fence). Otherwise a freshly written, current image helps.

**Check:** The tab shows “Edge without network (isolated)”, the edge parts run.

### Network fence missing

The same situation on a gateway **older than 1.23.0**: update the gateway first
(auto-update or [chapter 6](06-updating-a-gateway.md)), then get the current
compose file as under [compose file outdated](#compose-file-outdated). Loading a
kernel module by hand is no longer needed.

**Check:** The tab shows “Edge without network (isolated)”.

### Edge cannot reach GateControl

The edge container runs but cannot get through to the server.

1. Is the server reachable from the gateway at the address in `gateway.env`
   (`GC_SERVER_URL`, that is your `GC_BASE_URL`)?
2. Is there another reverse proxy in front of GateControl (e.g. nginx, Traefik
   or a CDN)? Then it has to pass **WebSocket connections** to
   `/api/v1/gateway/edge/ws`. Without an extra proxy there is nothing to do.
3. The container `edge` connects through the container `gateway`: hints are in
   the log of `gateway` (keyword `edge relay`) and of `edge`.

**Check:** “Connected since …” shows.

## 4.5 Plugin manuals and setup notices

From GateControl **1.241.0** every plugin that has one brings its own manual:
Settings → Plugins → *plugin* → tab “Manual”. It says what the plugin does,
what it needs, how to set it up step by step (including steps outside
GateControl such as the compose file or settings of a camera), permissions,
frequent questions and what is new in the installed version. Links lead to
sections, the table of contents sits beside the text (above it on a phone).
The manual comes anew with every plugin update.

When a plugin **needs your help** after an install or an update, GateControl
shows an amber notice:

- at the top of the plugin's page (on every tab) with “Read in the manual”
  and “Done”,
- as “Action needed” at the plugin in the list “My plugins”,
- as “Plugins need your help” on the dashboard.

Some notices clear themselves: when a gateway lacks, for example, the service
`kameras`, the notice names the gateway and offers “Download
docker-compose.yml”; once the service runs, it goes away. Others you mark as
“Done” when the work is done – that goes into the activity log with your name.

**Check:** the dashboard no longer shows “Plugins need your help”.

Continue with [chapter 5: Home gateway features](05-features.md).
