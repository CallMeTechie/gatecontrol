# 4. Edge plugins and Smart Home

[← Setting up a gateway](03-gateway-setup.md) · [Contents](README.md) · [Next: Home gateway features →](05-features.md)

## What is edge?

Some plugins – for example **Smart Home** – need a part that runs right in your
home network. It finds devices such as Shelly or Tasmota there and talks to
them. GateControl calls this part the **edge part**.

Edge parts run on the gateway in their own isolated container called `edge`.
It only reaches your home network and GateControl – not the internet and not
the tunnel. On top comes a local **MQTT broker** in the container `mqtt`, where
devices report right in the home network, without a cloud.

As long as you do not switch edge on, both containers are idle.

### Requirements

- Gateway version **1.19.0** or later.
- A gateway with Docker in **host network mode**: the Synology package from the
  assistant, the Raspberry Pi image or Linux with “Host (recommended)”. Bridge
  mode and the Proxmox installer have no edge container.
- The compose file contains the services `edge` and `mqtt`. Gateways from the
  current assistant have them. Bring older compose files up to date with
  [chapter 6](06-updating-a-gateway.md).
- On the Synology: the kernel module `xt_owner` (see [network fence missing](#network-fence-missing)).

## 4.1 Switching edge on

1. Install the plugin, for example “Smart Home”: “Settings” → “Plugins”.
2. Open “Network” → “Gateways” and click your gateway.
3. Switch to the tab “Edge plugins”.
4. Click “Switch edge on”.
5. Look at the line at the top of the tab:
   - “Connected since …” – the edge container is connected to GateControl.
   - “Network fence active (iptables)” or “Network fence active (nft)” – the isolation is in place.
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
gateway” in the plugin and use “Unlock gateway” in Phoscon.

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

- **Synology / Linux:** Bring the compose file up to date – [chapter 6](06-updating-a-gateway.md).
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

### Network fence missing

The gateway could not set the firewall rules for the edge container. Without
them no edge part starts. The gateway itself (routes, tunnel) keeps working normally.

Usually the kernel lacks the “owner match”. On the Synology that is the module `xt_owner`.

1. Open the log of the container `gateway` and search for `edge fence`. If it
   says `iptables owner match:`, `xt_owner` is missing.
2. Log in to the NAS via SSH and check:

   ```bash
   lsmod | grep xt_owner
   ls /lib/modules/xt_owner.ko
   ```

3. If the file exists but the module is not loaded, load it:

   ```bash
   sudo insmod /lib/modules/xt_owner.ko
   ```

4. So that it survives a restart: “Control Panel” → “Task Scheduler” →
   “Create” → “Triggered Task” → “User-defined script”, event “Boot-up”, user
   `root`, command `insmod /lib/modules/xt_owner.ko`.
5. Within 30 seconds the gateway sets the rules.

If DSM does not ship the module, no edge parts can run on this NAS. Leave edge
off for this gateway then.

**Check:** The tab shows “Network fence active (iptables)”; the log of
`gateway` shows `edge fence: rules active`.

### Edge cannot reach GateControl

The edge container runs but cannot get through to the server.

1. Is the server reachable from the gateway at the address in `gateway.env`
   (`GC_SERVER_URL`, that is your `GC_BASE_URL`)?
2. Is there another reverse proxy in front of GateControl (e.g. nginx, Traefik
   or a CDN)? Then it has to pass **WebSocket connections** to
   `/api/v1/gateway/edge/ws`. Without an extra proxy there is nothing to do.
3. The log of the container `edge` has hints.

**Check:** “Connected since …” shows.

Continue with [chapter 5: Home gateway features](05-features.md).
