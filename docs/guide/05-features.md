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
  **1.21.0** or later, DNS filter and home cache **1.22.0**, print & scan **1.24.0** (PDF for printers without PDF **1.30.0**, text recognition and office files **1.33.0**), radio **1.25.0** (zigbee2mqtt, Thread and sensor keys: a gateway newer than 1.31.0), local AI **1.26.0**, cameras **1.28.0**. If the gateway is
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
  on the device or in the compose file – it runs inside the gateway. Only
  “Print office files” needs an extra service (see below).

**Switching it on:** Tab “Features” → area “Devices at home” → switch on
“Print & scan”. After about a minute the row lists what the gateway found
(“Found: HP OfficeJet 8020 (printer + scanner)”). “Settings in the plugin”
leads to devices, permissions, history and where scans are filed.

**Checking:** In the plugin under “Devices”, print a “Test page”. If the
printer is off, a job waits up to 24 hours and starts as soon as it is back.
If a device says “Certificate changed”, its security certificate changed (for
example after a firmware update) – confirm it in the plugin and it carries on.

### Printing from an Android phone

With the Android app 1.84.0 or later you print from any app on the printers at
home – with and without VPN. The job goes through the server and the gateway at
home. It needs the plugin “Print & scan” 1.0.1 or later and the right to print.

- **Switch on the print service (once):** Android settings › Connected devices ›
  Printing › “GateControl”. In an app's print dialog the printers are then called
  “GateControl – …” (with the printer's name).
- **Share:** share a PDF or picture › “Print with GateControl” – printer, copies,
  colour, both sides, “Print at home”.
- **No printers?** In the app under Settings › Printing › “Print through GateControl”
  the app says why (plugin not available for the app, no right, no connection).

If the printer is off, the job waits up to 24 hours (“off – prints as soon as it is on”).

### Printers without PDF (e.g. HP OfficeJet Pro 8720)

Many inkjets take no PDF over the network, only their own raster formats (PWG
raster, Apple raster/URF, PCLm, JPEG). A gateway **1.30.0** or later converts PDF
files for such printers itself when printing – to the printer's resolution,
colour, paper and two-sided printing. This applies to everything that prints
through GateControl: portal, Android print service, share, test page.

- **Switch:** in the row “Print & scan”, “Convert PDF for printers without
  PDF” (on by default). Below it the row says which printers take no PDF and
  whether this gateway converts for them.
- **“… takes no PDF. A gateway 1.30.0 or later converts …”:** update the
  gateway ([chapter 6](06-updating-a-gateway.md)). Until then only pictures
  print there; GateControl turns a PDF file down with exactly this reason.
- **“This gateway lacks the tool to convert PDF”:** the gateway's image is
  older than its version – get the current image with “Update to …”.
- **Raspberry Pi 3 or Zero:** converting takes longer there, a few minutes for
  large PDF files. It still prints; switch it off for this gateway if you
  prefer.
- A damaged or password-protected PDF cannot be converted – the job then fails
  with that reason.

### Printing office files

GateControl prints Word, Excel, PowerPoint, OpenDocument and RTF files when the
gateway turns them into a PDF first. That needs LibreOffice – a large extra
service, so it is switched on per gateway. Plain text files (`.txt`) always
work, also without it.

- **Requirement:** gateway **1.33.0** or later (else “… need a gateway 1.33.0
  or later”).
- **Switch on:** in the row “Print & scan”, tick “Print office files”. Below
  it says what it costs: a ≈ 200 MB download once, ≈ 700 MB on disk, up to
  ≈ 500 MB of memory while converting.
- **“… need the current compose file once”:** click “Download
  docker-compose.yml” and use the file as when setting up (Synology: rebuild
  the project). The Raspberry Pi sets the service up by itself (“being set up”
  – a few minutes the first time).
- **“Office files work now”:** in the portal, in the Android app (Share › “Print
  with GateControl”) and everywhere else these files can be printed now. The
  page count shows in the history after converting.
- **Little memory (below 2 GB) or a Raspberry Pi 3/Zero:** it works, converting
  just takes longer. A hint, not a ban.
- The service has no network and no rights; macros in documents do not run.

### Text recognition for scans

With “Text recognition for scans (searchable PDFs)” people can choose
“Searchable PDF” when scanning in the plugin: the PDF in Drive then has
invisible text over the picture – searching, selecting and copying work, and
Drive's search finds the document by its content. German and English are
recognised.

- **Requirement:** gateway **1.33.0** or later; the text recognition is in the
  image (≈ 45 MB), no extra service.
- **Switch on:** in the row “Print & scan”, tick “Text recognition for scans”.
  One gateway with it is enough – also for scanners at other gateways.
- **Duration:** 1–3 seconds a page on a PC, about a minute on a Raspberry Pi 3
  or Zero. Only one text recognition runs at a time; the scan itself is there
  at once. If it does not work (too long, gateway off), the plugin files the
  normal PDF and says so.
- **“This gateway lacks the text recognition”:** get the current image via
  “Update to …”.

### Paper, tray and print status

When a printer names its paper sizes and trays (gateway 1.33.0 or later),
people can choose A4, A5, Letter or photo paper (10 × 15 cm) in the plugin and
the Android app and – in the plugin – the tray (e.g. “photo tray”). What the
printer does not name is not offered; it then prints on its default paper.
When the printer stops while printing, the reason shows in the history and in
the Android app (“out of paper”, “cover open”, “paper jam” …); it goes away when
it carries on. Printers that name only PCLm besides JPEG (some HP models) now
get PDF files as PCLm.

### Printer not found

Below the switch the row shows what the last search saw (“Last search today
12:03: mDNS answers 14, print/scan services 3, devices 1”); “Search again”
searches at once.

- **“This gateway does not report yet …”:** the gateway is older than the
  improved search – update it first ([chapter 6](06-updating-a-gateway.md)). Older
  versions miss many printers next to the host's avahi/Bonjour (Synology,
  QNAP).
- **“mDNS answers 0”:** the search does not reach the gateway – for example
  when the container does not run in the host network, the Wi-Fi filters
  multicast or the printer is in the guest Wi-Fi or another VLAN.
- **“dropped: other subnet”:** the printer has an address outside the
  gateway's home network. On its own the gateway only talks to devices in its
  own LAN – enter the address (next point).
- **Add it by IP address:** “Printer not found? Add it by IP address” → enter
  the address (it is in the printer's network menu or in the router's device
  list) → “Add” → “Save”. The gateway then asks the device directly (IPP on
  port 631 or 443, eSCL on 80 or 443). Private addresses only (10.x,
  172.16–31.x, 192.168.x), at most 16; best make the address a fixed one in
  the router. The window shows for each address whether the gateway reached
  it.

## Cameras

**What for:** cameras in the home network (e.g. Reolink, Tapo, Hikvision –
anything with ONVIF or RTSP) in the plugin “Door & Camera”: snapshots, the live
picture through GateControl, clips on motion. No vendor cloud – pictures and
clips stay on the gateway (on a Synology: on the NAS).

**Requirements:**

- GateControl server 1.240.0+ ([updates](02-server-setup.md#29-setting-up-updates)).
- Gateway 1.28.0+. If it is older, the row says “Gateway too old – needs 1.28.0”.
- Switch **ONVIF** or **RTSP** on in the camera:
  - Reolink: app or web interface › Settings › Network › Advanced › Server
    settings › ONVIF and RTSP on (ONVIF port usually 8000).
  - Tapo: app › camera › Settings › Advanced › create a **camera account** – its
    user and password go into GateControl (not your TP-Link account). ONVIF port 2020.
  - Others: look for “ONVIF” or “RTSP” in the camera's manual.
- The plugin “Door & Camera” (Settings › Plugins › Catalogue) 1.6.0 or later.
- Synology/Linux: the current compose file with the service `kameras` once
  (ffmpeg only, ≈ 80 MB). Without it the row offers “Download docker-compose.yml” –
  download it and recreate the project
  ([chapter 6](06-updating-a-gateway.md#63-synology-renewing-the-compose-file)); search,
  test picture and motion events work already, the live picture and clips do not.
  A folder of the NAS for the clips is chosen in the row under “Storage and networks”
  (see “Recordings”). The Raspberry Pi image adds the service itself;
  older images (before gateway 1.28.0) need a new image for it.

**Switching on:** tab “Features” → “Devices at home” → “Cameras”. Then in the
plugin “Door & Camera” › “Add camera”: the gateway searches for cameras (“Reolink
E1 Zoom · 192.168.1.73 · ONVIF – newly found”) or you enter an `rtsp://…` address,
plus name, user and password of the camera. “Connect and test” shows a test picture;
only then is the camera stored. The password stays encrypted on the server and goes
to the gateway only.

**Cameras with HTTPS** (gateway 1.29.0+, GateControl 1.242.0+, plugin 1.7.0+): when a
camera offers ONVIF only over HTTPS, the gateway finds it by itself (port 443 last) – or
you tick “HTTPS” when adding it. The certificate is **always checked**. Most cameras have
a self-signed certificate; then the test says “The camera's certificate is not trusted”.
Only if you trust the camera in your home network, tick “Do not check the certificate”
there (per camera, can be switched back under “Recordings”). The connection stays
encrypted and still goes to the camera's address only.

**Recordings:** per camera “on motion (people, cars, animals)”, “on motion, only when
nobody is at home” (from the family's presence – when it is unknown the gateway does
not record) or “never – live picture only”. A clip starts 5 seconds before the motion
and ends 10 seconds after it (2 minutes at most). Motion, people and vehicles are
detected by the **camera itself** (ONVIF events) – the gateway does no image analysis.
Keep 7, 14 or 30 days; with less than 1 GB free the gateway records nothing new. Clips
are in the Docker volume `cam-recordings`. **Changing the folder** (GateControl
1.242.0+): row “Cameras” › “Storage and networks” › “Folder for clips”, e.g.
`/volume1/kameras` (create the folder in File Station first). Then “Download
docker-compose.yml” and recreate the project – no SSH, no `.env`. The row says “Clips
in the folder /volume1/kameras”; while the gateway still uses the old storage (gateway
1.29.0+ reports it) it says “takes effect with the new compose file”. On a Raspberry Pi
the clips stay on the SD card. A `GC_CAMERA_DIR` already set in the `.env` still wins.

**Live picture:** only when the phone or PC is in the **VPN** (or in the server's own
network). On the road without VPN the portal and the app show a new snapshot every 10 seconds. In the
portal Safari and Edge/Chrome on phones play the picture themselves; **Firefox** and
Chrome/Edge on the PC play it from GateControl 1.242.0 through the built-in player (Media
Source Extensions, no external library). H.265 cameras do not play in many browsers –
choose the sub stream (usually H.264) then. A push with a snapshot for people comes at most
once per camera every 5 minutes, with the button “View”; everybody can switch it off for
themselves per camera (portal tab “Door” and the apps, plugin 1.7.0+).

**Hints instead of bans:** on a Raspberry Pi 3 B+ the row says “Cameras: at most 1 camera
with motion detection”, on a Pi 4 “at most 4”. Switching on stays possible. Cameras
outside the gateway's own home network (e.g. a camera VLAN) are reached only when that
network is listed under “Storage and networks” › “More networks for the camera search”
(private networks, /16 to /30, at most 8; API `PUT /api/v1/gateways/:id/features { cameras: { subnets } }`).

**Privacy:** the gateway records sound only when you switch it on per camera – recording
conversations is only allowed with everybody's consent. Who may see which camera is set in
the plugin under “Permissions” (column “sieht”): only these people see it in the portal and
in the app, get the push and find the clips.

## Radio (Zigbee, Bluetooth, Thread)

**What for:** Zigbee lights, plugs and sensors (IKEA, Philips Hue, Aqara …) through a
radio stick on the gateway, Bluetooth thermometers (BTHome, Shelly BLU, Xiaomi – encrypted
ones too) and a Thread network for Matter devices. You switch everything in the tab
“Radio” – without SSH and without `settings.txt`.

**Requirements:**

- Gateway 1.25.0+. If it is older, the row says “Gateway too old – from 1.25.0”.
  zigbee2mqtt, Thread and keys for encrypted sensors need a gateway **newer than
  1.30.0** – otherwise the tab says “gateway update needed”.
- Zigbee with **deCONZ**: a radio by dresden elektronik – ConBee II/III on USB or
  RaspBee II on the Pi header.
- Zigbee with **zigbee2mqtt**: for sticks deCONZ does not speak – Sonoff ZBDongle-E/-P,
  Home Assistant SkyConnect/ZBT-1/ZBT-2, CC2652 and EFR32 sticks (a ConBee works too).
  zigbee2mqtt talks through the gateway's MQTT broker; the tab offers “Switch on edge and
  MQTT” while it is off.
- **Thread:** a stick with **RCP firmware** (OpenThread): SkyConnect/ZBT-1, ZBT-2,
  ZBDongle-E or an nRF52840 dongle.
- **A stick serves one radio only.** On “Automatic” Zigbee gets a stick first, Thread
  another one. With a single multi stick Thread says “stick busy”. The list “Radio
  sticks” in the tab shows which stick serves what and what it suits – and there you can
  set it by hand if you like (see below).
- **Firmware:** multi sticks (SkyConnect, ZBDongle-E) do Zigbee *or* Thread – depending on
  the firmware. The gateway cannot see it; you change it in the browser with the maker's
  web flasher.
- **Synology/Linux:** the services (deCONZ, zigbee2mqtt, border router) come with the
  compose file. If one is missing, the tab shows “Download docker-compose.yml” – download it
  once and recreate the project ([chapter 6](06-updating-a-gateway.md)).
- **Raspberry Pi image:** nothing to do; the gateway starts the services itself. On a Pi 3
  or Zero (up to 1 GB) zigbee2mqtt (≈ 120 MB) and the border router (≈ 60 MB) run as well –
  the tab only points out that memory can get tight.
- Bluetooth: built in (the Pi from this image on) or a USB Bluetooth stick. A NAS usually
  has no Bluetooth.

**Switching on:** tab “Features” → “Devices at home” → switch on “Radio (Zigbee,
Bluetooth, Thread)”, or Zigbee, Bluetooth and Thread one by one in the tab “Radio”. At
Zigbee you choose the **Zigbee service**: “deCONZ” or “zigbee2mqtt”. deCONZ starts as
“automatic”: it runs as soon as a ConBee or RaspBee is detected. If a stick only suits
zigbee2mqtt, the tab says so.

**Setting sticks by hand:** In the tab “Radio” under “Radio sticks” every stick has
“Use for” with “Automatic (default)”, “Zigbee”, “Thread” and “do not use”. The choice
wins; “Automatic” only hands out the remaining sticks. The gateway knows the stick by its
serial number (an ID like in `/dev/serial/by-id`) – also after plugging it into another
socket. If a stick has no serial number of its own, the choice holds for the USB socket
(the tab says so). No SSH: the gateway hands the chosen stick to the service (deCONZ,
zigbee2mqtt, border router) itself.

- **If a chosen stick is not plugged in**, it stays in the list as “not plugged in” and
  the radio waits for it (“stick missing”) – it takes no other stick, so zigbee2mqtt does
  not start a new network on a different stick. Plug it back in or set it to “Automatic”.
- **Hints, not bans:** two sticks for the same radio – the one chosen first counts, the
  other stays free. A radio is off – the stick is taken once it is on. If the detection
  says the stick does not fit (deCONZ on a non-ConBee, Thread on a stick without known RCP
  firmware), the gateway takes it anyway – handy after reflashing. Only zigbee2mqtt cannot
  drive a stick without a matching adapter at all (“stick does not fit”).
- “do not use”: no service touches the stick – e.g. for a stick another program on the
  same machine uses.
- Needs a gateway **newer than 1.33.1** (that is 1.34.0 or later). On older gateways the
  choice is locked with a hint on the version; they keep assigning automatically.

**Pairing devices:** in the tab “Radio”, at Zigbee, “Start pairing” – GateControl
searches for 3 minutes. Put the device into pairing mode (usually hold its button for
5 s). The new device shows up as “new”; “Name it in Smart Home” opens it in the Smart
Home plugin. With deCONZ: if Smart Home is not connected yet, “Add to Smart Home” creates
the route and opens deCONZ briefly. With zigbee2mqtt the devices show up in Smart Home by
themselves (source “Radio” of the gateway); the tab lists them with their values,
“Remove” takes a device out of the Zigbee network.

**Bluetooth sensors:** the gateway only listens, it connects to nothing. New sensors
appear as “unknown” – “Take over” and give them a name (e.g. “Basement”); only sensors
you take over show up in Smart Home, the neighbours' stay out. **Encrypted sensors**
(BTHome with a key, e.g. Shelly BLU with encryption; Xiaomi stock firmware with a
bindkey) show “key missing”. Enter the key (32 characters) when taking them over or with
“Enter key”. GateControl stores it encrypted and hands it only to this gateway – never into
the configuration or a log. Then they show “decrypted” with their values, with a wrong key
“wrong key”. Older Xiaomi sensors with the old encryption (before MiBeacon v4) do not work.

**Thread / Matter:** switch Thread on – the gateway starts the OpenThread Border Router. If
it has no network yet, choose “Create network” or “Join existing network” (paste the
dataset of another border router, e.g. from Home Assistant › Settings › Thread). While the
network runs, the tab shows its name, channel and PAN; “Show dataset” hands out the access
for a Matter controller (only give it to your own devices). **For Matter over Thread you
still need a Matter controller** (Apple Home, Google Home, Home Assistant with the Matter
server) that takes the devices in – GateControl does not commission Matter devices itself
yet. If the gateway host does not forward IPv6, the tab says so: without
`net.ipv6.conf.all.forwarding=1` on the host, controllers in the home network do not find
the Thread devices. Matter devices on Wi-Fi already work through Smart Home.

**If something is stuck:** “approval needed” means deCONZ has a Phoscon password and does
not let GateControl in – once in Phoscon (port 8090 of the gateway) Gateway › Advanced ›
“Authenticate app”, then “Try again”. “MQTT off” at zigbee2mqtt: “Switch on edge and MQTT”.
If zigbee2mqtt or the border router keeps stopping, the stick's firmware usually does not
fit (Zigbee firmware for zigbee2mqtt, RCP firmware for Thread). “Stick missing”: the stick
chosen by hand is not plugged in – plug it back in or set it to “Automatic” under “Radio
sticks”.

## Local AI

**What for:** An AI model in the home network instead of the cloud. Drive and Mail
use it to summarise documents and mails, sort them and suggest replies – the
content never leaves the house and nothing costs money. In return a model without
a graphics card answers more slowly (seconds to minutes) and can do less than the
big cloud models; it does not understand pictures (those still go to the cloud when
“Send pictures” is on).

**Two ways:**

- **On a gateway:** GateControl downloads the model to the gateway and starts it
  there (service “ki” with Ollama). Sensible from about 4 GB RAM; a NAS with 8–16 GB
  is good. On a Raspberry Pi 3 B+ (1 GB) GateControl shows “too little memory” – you
  can still switch it on, but the second way is better then.
- **Existing AI server in the home network:** If Ollama, LM Studio, vLLM, a llama.cpp
  server or LocalAI already runs on a PC, a gateway in the same home network only
  forwards the questions – to exactly this one address. The server on the PC must
  listen on the network: Ollama with `OLLAMA_HOST=0.0.0.0`, LM Studio with “Serve on
  Local Network”.

**Requirements:**

- Gateway 1.26.0+. If it is older, the row says “Gateway too old – needs 1.26.0”.
  The graphics card, API keys, names/IPv6 and “Test the connection” need gateway
  **1.31.0**+ (before that a hint says so).
- **Synology/Linux** (only “On a gateway”): the current compose file with the service
  “ki”, once. If it is missing, the row “Local AI” and the setup show the button
  “Download docker-compose.yml” – download it, recreate the project
  ([chapter 6](06-updating-a-gateway.md)). The Ollama image is ≈ 3 GB, each model 1–6 GB.
- **Raspberry Pi image:** nothing to do – the image creates the service itself as
  soon as you switch the local AI on.

**Setup:** Settings › Extensions › AI providers › “Set up the local AI”:

1. Choose “On a gateway” or “Existing AI server in the home network”.
2. Choose the gateway. Its RAM, cores and whether it has a graphics card are shown.
   If it has one, **“Use the graphics card”** appears (see below).
3. Choose a model. GateControl says per gateway “recommended”, “fits” or “not
   recommended” (too little memory, or too slow without a graphics card) – you can
   always choose. To start with: **Llama 3.2 3B** (2 GB, fast, good for summaries and
   sorting); on weak hardware **Llama 3.2 1B**; with plenty of memory **Qwen 2.5 7B**
   (better answers, much slower without a graphics card).
   With a graphics card its memory counts: “in graphics memory” means fast; with 12 GB
   or more **Qwen 2.5 14B** is a good choice, with 24 GB **Qwen 2.5 32B**.
   For an AI server in the home network: enter its address, choose the kind (Ollama or
   OpenAI-compatible), the API key if needed, then **“Test the connection”** –
   GateControl lists the server’s models without saving anything. Choose one.
4. “Save”. On a gateway GateControl downloads the model (“Downloading the model: 1.3
   of 2.0 GB”, “Cancel” works any time; a later “Download” resumes).

**Address of the AI server:** with a port, for example

| As | Example |
|---|---|
| private IPv4 address | `http://192.168.1.20:11434` |
| name in the home network | `http://ki-pc.local:11434`, `http://pc.fritz.box:1234` |
| private IPv6 address (fd…/fc…) | `http://[fd00::20]:11434` |
| with `/v1` (OpenAI-compatible) | `http://192.168.1.20:8000/v1` |

The gateway resolves names itself (`.local` via mDNS, otherwise through the router)
and connects **only** to addresses in the home network. If a name points to the
internet, “Test the connection” says “The name does not point into the home
network”. There is no internet server for the local AI – that is what the cloud
providers are for.

**API key:** if the server asks for one (Ollama behind a proxy, vLLM with
`--api-key`, LocalAI, LM Studio or llama.cpp with a key), enter it in “API key”.
GateControl stores it encrypted, afterwards shows only “saved (…abcd)” and gives it
only to the gateway that forwards – never in a log, never in the configuration the
gateways fetch. “Remove the key” deletes it with the next “Save”. With `http://` the
key travels unencrypted through the home network – `https://` is better if the server
can do it.

**Use the graphics card** (only “On a gateway”, not on the Raspberry Pi): GateControl
finds the gateway’s card (NVIDIA, AMD, Intel), its driver and – once the service “ki”
sees it – its memory. Choose “Use the graphics card”, “Save”, then **download the new
compose file once** and recreate the project (as above); only then does the service
“ki” see the card. Afterwards it says “ready” or “The model runs on the graphics card”.

| Choice | What goes into the compose file | What the host needs |
|---|---|---|
| NVIDIA | the card for the service “ki” | NVIDIA driver 550 or newer **and** the NVIDIA Container Toolkit |
| AMD (ROCm) | Ollama’s ROCm image, `/dev/kfd` and `/dev/dri` | amdgpu driver with ROCm (`/dev/kfd`), x86-64 only |
| Intel (experimental) | `/dev/dri` (Vulkan) | i915 or xe driver |

If something is missing, GateControl says so instead of blocking the choice:
“NVIDIA driver missing”, “NVIDIA Container Toolkit missing” (the service “ki” does
not see the card or does not start), “/dev/kfd is missing (ROCm)”, “download the new
compose file”. Drivers and the toolkit are installed on the host itself (e.g. Linux:
package `nvidia-container-toolkit`, then `nvidia-ctk runtime configure
--runtime=docker` and restart Docker) – GateControl cannot do that for you. Most
Synology models have no usable graphics card.

**What is the local AI for?**

| Setting | What happens |
|---|---|
| For everything | Every request goes to the local AI first. The cloud only answers when the local AI is not reachable (gateway offline, busy, too slow, model missing) or has to understand a picture. |
| Only for private content | Drive documents and mails (the Drive and Mail plugins) go to the local AI – and **never** to the cloud, even when the local AI fails. Everything else as before. |
| Only as a fallback | Everything through the cloud as before; the local AI steps in once the monthly budget is used up. |

“Test: “Summarise this mail”” sends a made-up mail to the local AI and shows the
answer and how long it took. The local AI costs €0 and does not count against the
budget; it is still listed in the log of AI requests (marked “local”).

**In the tab “Features”:** the row “Local AI” in “Devices at home” switches the AI on
this gateway on and off and shows the model, the graphics card (“Graphics card: NVIDIA
GeForce RTX 3060 (12 GB) – ready”) and what it lacks; for an AI server in the home
network the address and whether an API key is set. The bar at the top shows the memory:
green the home network features, blue the model in memory; “tight” means little is
left for more features.

**If something goes wrong:** “Service “ki” missing” → download the compose file
(see above). “not reachable” with an AI server in the home network → is the PC on,
does the server listen on the network, is the port right? “asks for a (different) API
key” → enter or check the key. “The name does not point into the home network” →
enter the IP address or check the name in the router. Graphics card “waits for the
new compose file” → download the compose file and recreate the project. The activity log reports
“Local AI does not answer” at most once an hour.

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

**In the Android app:**

- **“Available offline” (Drive):** The app keeps a copy of marked files and
  folders on the phone that opens without a connection too. At home it loads
  the copies from the home cache, on the road through the server. When a file
  changes, the copy is renewed. The app's Drive settings have “Storage for
  offline files” (default 2 GB) and “Load offline files on Wi-Fi only”. Vault
  files stay in the home cache only (encrypted), not on the phone.
- **App updates:** The app from GitHub (not the one from Google Play) loads an
  update from the gateway at home. It checks the checksum and the app
  signature before Android offers to install it. If the gateway cannot be
  reached, it loads the update from the internet as before.

Continue with [chapter 6: Updating an existing gateway](06-updating-a-gateway.md).
