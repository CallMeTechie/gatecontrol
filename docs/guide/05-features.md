# 5. Home gateway features

[← Edge plugins and Smart Home](04-edge-and-smart-home.md) · [Contents](README.md) · [Next: Updating an existing gateway →](06-updating-a-gateway.md)

A gateway can do more than the tunnel. You find all features like this:

1. “Network” → “Gateways” → click your gateway.
2. Tab “Features” (the number next to it says how many are on).

There you switch each feature on or off, grouped by area (“Eyes on the home
network”, “Devices at home”, “For the whole home network”, “Internet & power”,
“Extensions”, “System”). At the top it shows roughly how much memory the gateway needs with
the features that are on. The gateway's overview only shows in the card
“Features” what is on and what is off; “Manage” leads to the tab. Tabs of a
feature that is off look faded with “· off” and still open.

Gateway pools (several gateways in the same network that step in for each
other) are under “Gateways” as well: as a group of their own in the list, with
“Create pool” at the top right and “Open pool” for the settings. There is no
separate page “Gateway Pools” in the menu any more.

General requirements:

- Network watch, internet quality, presence and UPS need gateway version
  **1.21.0** or later, DNS filter and home cache **1.22.0**, print & scan **1.24.0**, radio **1.25.0**. If the gateway is
  older, the tab says so; update it then ([chapter 6](06-updating-a-gateway.md)).
- The gateway is in the home network in **host network mode** (default for the
  Pi, the Synology package and Linux with “Host (recommended)”).
- The **time zone** comes from the server (see [chapter 2.5](02-server-setup.md#25-the-values-in-env-you-really-need)).
  The card shows under “Local time” which one applies. If it says “The server
  runs in UTC”, `TZ` is missing in the server's `.env`.

## Network watch

**What for:** Finds every device in the home network, reports new devices and
checks open ports once a day at night.

**Switch on:** In the card “Network watch” (on by default from version 1.21.0).
You can switch “Check open ports” off separately. You see the devices in the tab “Network”.

**Check:** Your devices show up in the tab “Network”.

## Internet quality

**What for:** Measures ping and loss every minute, the speed on a schedule, and
detects outages with their cause.

**Switch on:** In the card “Internet quality” (on by default). In the tab
“Internet” you set “Measure speed”: “never automatically”, “4× a day” or
“every hour”. Every hour uses a lot of data.

**Check:** Measurements show up in the tab “Internet”.

## Presence

**What for:** Detects assigned phones in the Wi-Fi for the family presence.

**Switch on:** In the card “Presence” (on by default). It needs the network
watch. It only works for people who switch on “My phone in the Wi-Fi” in the
family portal themselves.

**Check:** The person shows as at home when their phone is in the Wi-Fi.

## UPS status

**What for:** Reads the state of a UPS (on mains, on battery, runtime left) from
a NUT server, for example from the Synology.

**Switch on:**

1. On the Synology: “Control Panel” → “Hardware & Power” → “UPS” → enable the
   network UPS server and allow the gateway's IP.
2. In GateControl click “Set address” at “UPS status”.
3. Enter the “Address of the UPS server” (private IPv4), the “Port” (usually
   3493) and optionally the UPS name (empty = the first UPS; Synology: `ups`).
4. “Save and switch on”.

**Check:** The card shows “On mains” and the battery charge.

## DNS filter

**What for:** Filters ads, trackers and malicious sites for **every** device in
the home network – also TVs and consoles. With profiles and times per person
(e.g. screen time for children: “internet off completely” or only certain
categories at certain times).

**Requirements:** Gateway 1.22.0+. No other DNS service may use port 53 on the
device (e.g. the Synology “DNS Server” package, Pi-hole or systemd-resolved).

**Switch on:**

1. Tab “DNS filter” → “Switch on DNS filter”.
2. Click “Guide” and choose your router (FRITZ!Box, Speedport, Vodafone
   Station or other router).
3. Enter the gateway address shown as the **DNS server** in your router
   (“Enter in the router as DNS server:”). On a FRITZ!Box: “Home Network” →
   “Network” → “Network Settings” → “Additional Settings” → “IPv4 Settings” →
   “Local DNS server”. If your network uses IPv6, enter the IPv6 address as well.
4. Leave a second DNS field in the router empty or enter a second gateway.
   Another address (e.g. 8.8.8.8) lets devices ask past the filter.
5. Switch the devices' Wi-Fi off and on once.
6. Create profiles and times under “Profiles”. The times use the server's time zone.

**Important:** If the gateway is off, the devices in the home network can no
longer resolve names – the internet then seems “gone”. A second gateway as a
reserve helps. If you want to switch the filter off again, clear the field in
the router **first**.

Some routers (many Speedport models, Vodafone Station) do not allow an own DNS
server. Then you enter it on the devices themselves; the guide in GateControl
explains how.

**Check:** The “Check” in the guide says “Router points to the gateway”.

## Print & scan

**What for:** Print at home while you are out (the boarding pass is in the
output tray when you get home) and scan from your phone – straight into Drive.
Printers and scanners stay in the home network; GateControl does not expose
them to the internet.

**Requirements:**

- Gateway 1.24.0+. If it is older, the row says “Gateway too old – needs 1.24.0”.
- A printer or scanner with AirPrint/AirScan (IPP or eSCL) in the same home
  network – nearly all devices since about 2015. Older ones do not show up.
- The plugin “Print & scan” (Settings › Plugins › Catalogue). Nothing to set up
  on the device or in the compose file – it runs inside the gateway.

**Switching it on:** Tab “Features” → area “Devices at home” → switch on
“Print & scan”. After about a minute the row lists what the gateway found
(“Found: HP OfficeJet 8020 (printer + scanner)”). “Settings in the plugin”
leads to devices, permissions, history and where scans are filed.

**Checking:** In the plugin under “Devices”, print a “Test page”. If the
printer is off, a job waits up to 24 hours and starts as soon as it is back.
If a device says “Certificate changed”, its security certificate changed (for
example after a firmware update) – confirm it in the plugin and it carries on.

## Radio (Zigbee, Bluetooth, Thread)

**What for:** Zigbee lights, plugs and sensors (IKEA, Philips Hue, Aqara …) through a
radio stick on the gateway, Bluetooth thermometers that send their values openly
(BTHome, Xiaomi with custom firmware, Shelly BLU) and – later – Matter devices over
Thread. You switch everything in the tab “Radio” – without SSH and without
`settings.txt`.

**Requirements:**

- Gateway 1.25.0+. If it is older, the row says “Gateway too old – from 1.25.0”.
- Zigbee: a radio by dresden elektronik – ConBee II/III on USB or RaspBee II on the Pi
  header. GateControl recognises other Zigbee sticks (ZBT-1, Sonoff), but deCONZ
  cannot use them.
- **Synology/Linux:** the deCONZ service comes with the compose file. When a stick is
  plugged in, the tab shows “Download docker-compose.yml” – download it once and
  recreate the project ([chapter 6](06-updating-a-gateway.md)). After that everything works here.
- **Raspberry Pi image:** nothing to do; older images (up to 1.24) still start deCONZ by
  themselves and only show the switch with a new image.
- Bluetooth: built in (the Pi from this image on) or a USB Bluetooth stick. A NAS usually
  has no Bluetooth.

**Switching on:** tab “Features” → “Devices at home” → switch on “Radio (Zigbee,
Bluetooth, Thread)”, or Zigbee and Bluetooth one by one in the tab “Radio”. Zigbee
starts as “automatic”: it runs as soon as a ConBee or RaspBee is detected.

**Pairing devices:** in the tab “Radio”, at Zigbee, “Start pairing” – GateControl
searches for 3 minutes. Put the device into pairing mode (usually hold its button for
5 s). The new device shows up as “new”; “Name it in Smart Home” opens it in the Smart
Home plugin. If Smart Home is not connected yet, “Add to Smart Home” creates the route
and opens deCONZ briefly so the plugin gets its key without Phoscon.

**Bluetooth sensors:** the gateway only listens, it connects to nothing. New sensors
appear as “unknown” – “Take over” and give them a name (e.g. “Basement”); only sensors
you take over show up in Smart Home, the neighbours' stay out. Sensors with Xiaomi
stock firmware send encrypted values – they are recognised, their values come in a
later step.

**Thread / Matter:** when a Thread-capable stick (ZBT-1, Sonoff ZBDongle-E) is plugged
in, the tab shows it. GateControl adds the Thread border router in a later step. Matter
devices on Wi-Fi already work through Smart Home.

**If something is stuck:** “approval needed” means deCONZ has a Phoscon password and does
not let GateControl in – once in Phoscon (port 8090 of the gateway) Gateway › Advanced ›
“Authenticate app”, then “Try again”.

## Home cache

**What for:** Keeps app updates, files and photos (via the Drive plugin) in the
home network. Apps in the home network then load them at full LAN speed. The
server still decides who may see what.

**Requirements:**

- Gateway 1.22.0+.
- A folder for the files:
  - **Synology / Linux:** `gateway-cache` next to the compose file. The compose
    file has to mount it (`${GC_CACHE_DIR:-./gateway-cache}:/cache`) and the
    folder has to exist. Older compose files lack this – see
    [chapter 6](06-updating-a-gateway.md).
  - **Raspberry Pi:** best a USB drive. Put `CACHE_DIR=<folder on the USB drive>`
    into `settings.txt` and restart. Constant writing wears out the SD card.
- Port 8443 in the home network is free.

**Switch on:** Tab “Home cache” → “Switch on home cache”. Under “What is kept”
you choose the kinds (Drive, photos, app updates, vault files), under “Storage”
the maximum size.

**Check:** The state is “on”. If it says “folder not writable”, the folder or
the compose line is missing ([chapter 7](07-faq.md#home-cache-folder-not-writable)).

Continue with [chapter 6: Updating an existing gateway](06-updating-a-gateway.md).
