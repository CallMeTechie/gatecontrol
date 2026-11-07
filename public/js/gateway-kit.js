'use strict';

// Pure helpers of the gateway set-up (no DOM) — shared by the browser
// (gateway-wizard.js, peers.js) and the server (services/gatewaySetup.js
// builds the Synology package with the same compose), tested in node by
// tests/gateway_kit.test.js. docs/feature-gateway-wizard.md.
//
//   buildCompose        the onboarding docker-compose.yml (platform
//                       synology|linux × network host|bridge)
//   check*              input checks of the Raspberry-Pi step (WLAN, host
//                       name, time zone, SSH key) → null or an error code
//   buildSettingsTxt    gatecontrol/settings.txt of the Pi image (contract:
//                       KEY=VALUE, one key per line, no quotes)
//   zipStored           a small ZIP writer (stored, no compression, UTF-8
//                       names) → Uint8Array; also used for the NAS package
//   suggestHostname     "Pi Keller" → "gc-pi-keller"
//   nasTaskCommand      the DSM task-scheduler command for update.sh
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCGatewayKit = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const PLATFORMS = ['rpi', 'synology', 'proxmox', 'linux'];
  const PI_MODELS = ['pi5', 'pi4', 'pi3bplus', 'pizero2w'];
  const GATEWAY_REPO = 'CallMeTechie/gatecontrol-gateway';
  const RELEASES_URL = 'https://github.com/' + GATEWAY_REPO + '/releases/latest';
  const IMAGER_REPO_URL = 'https://github.com/' + GATEWAY_REPO + '/releases/latest/download/gatecontrol-rpi-imager.json';
  const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/' + GATEWAY_REPO + '/main/scripts/install-pve.sh';
  const NAS_DIR = '/volume1/docker/gatecontrol-gateway';
  const DECONZ_PORT = 8090;

  // Edge container and local MQTT broker of the gateway — exactly as in docker-compose.example.yml
  // of gatecontrol-gateway (since v1.23.0: the edge container runs WITHOUT network, network_mode: none;
  // the server, LAN devices and MQTT only through the gateway socket in edge-run, checked by the gateway —
  // no network fence, no kernel module such as xt_owner): edge = the gateway image with another command,
  // no privileges, user 61001, idle until the server switches edge parts on; mqtt = mosquitto
  // (digest-pinned) behind a small watcher, idle until the server switches MQTT on (the gateway writes
  // the broker files to edge-mqtt-conf, the watcher copies them to edge-mqtt).
  // `$$` is compose's escape for a literal `$` in the watcher script.
  const EDGE_SERVICES = [
    '',
    '  # Edge parts of plugins in the home network (switched on per gateway in GateControl).',
    '  # Same image as the gateway, another command; runs without privileges and WITHOUT',
    '  # NETWORK as user 61001: GateControl, LAN devices and MQTT only through the gateway',
    '  # socket in edge-run (checked by the gateway). No network fence, no kernel module.',
    '  # Stays idle until GateControl switches edge parts on for this gateway.',
    '  # Leave out the services edge and mqtt (and the edge-* volumes) if you do not want edge parts.',
    '  edge:',
    '    image: ghcr.io/callmetechie/gatecontrol-gateway:latest',
    '    entrypoint: ["/sbin/tini", "--", "node", "src/edge/main.js"]',
    '    restart: unless-stopped',
    '    network_mode: none        # no network: server, LAN and MQTT through the gateway socket',
    '    user: "61001:61001"       # fixed UID/GID: group 61001 may use the gateway socket',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    read_only: true',
    '    tmpfs:',
    '      - /tmp:size=16m',
    '    mem_limit: 512m',
    '    pids_limit: 256',
    '    volumes:',
    '      - type: volume',
    '        source: edge-run',
    '        target: /run/gc-edge',
    '        read_only: true',
    '        volume: { nocopy: true }',
    '      - type: volume',
    '        source: edge-status',
    '        target: /run/gc-edge-status',
    '        volume: { nocopy: true }',
    '      - edge-state:/state-edge',
    '    environment:',
    '      - LOG_LEVEL=info',
    '    healthcheck:',
    '      test: ["CMD", "node", "src/edge/healthcheck.js"]',
    '      interval: 60s',
    '      timeout: 5s',
    '      retries: 3',
    '      start_period: 60s',
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
    '',
    '  # Local MQTT broker. Idle (only a small watcher) until GateControl switches MQTT on;',
    '  # the gateway then writes mosquitto.conf/passwd/acl to /gc-mqtt-conf (out of reach of',
    '  # the edge container). The watcher copies them to /gc-mqtt, restarts Mosquitto when the',
    '  # configuration changes and sends SIGHUP when the accounts change. Port 1883 only on',
    '  # LAN addresses, no anonymous access.',
    '  mqtt:',
    '    image: eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f',
    '    entrypoint:',
    '      - /bin/sh',
    '      - -c',
    '      - |',
    '        G=/gc-mqtt-conf; C=/gc-mqtt; p=""; s=""; r=""',
    '        halt() { if [ -n "$$p" ]; then kill "$$p" 2>/dev/null; wait "$$p" 2>/dev/null; fi; p=""; }',
    '        take() { for f in mosquitto.conf passwd acl; do cp "$$G/$$f" "$$C/.$$f" && chmod 600 "$$C/.$$f" && mv -f "$$C/.$$f" "$$C/$$f" || return 1; done; }',
    '        trap \'halt; exit 0\' TERM INT',
    '        mkdir -p "$$C/data"',
    '        while :; do',
    '          if [ -f "$$G/enabled" ] && [ -f "$$G/mosquitto.conf" ]; then',
    '            n="$$(cksum < "$$G/mosquitto.conf")"',
    '            if [ -n "$$p" ] && ! kill -0 "$$p" 2>/dev/null; then p=""; fi',
    '            if [ -z "$$p" ] || [ "$$n" != "$$s" ]; then',
    '              halt; r="$$(cat "$$G/reload" 2>/dev/null)"',
    '              if take; then mosquitto -c "$$C/mosquitto.conf" & p=$$!; s="$$n"; fi',
    '            elif [ "$$(cat "$$G/reload" 2>/dev/null)" != "$$r" ]; then',
    '              r="$$(cat "$$G/reload" 2>/dev/null)"; take && kill -HUP "$$p"',
    '            fi',
    '          else',
    '            halt; s=""',
    '          fi',
    '          sleep 2 & wait $$!',
    '        done',
    '    restart: unless-stopped',
    '    network_mode: host',
    '    user: "61001:61001"       # group 61001: reads the files of the gateway',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    read_only: true',
    '    mem_limit: 128m',
    '    pids_limit: 32',
    '    depends_on:',
    '      - gateway               # creates the volumes (edge-mqtt with owner 61001 from the image)',
    '    volumes:',
    '      - type: volume          # broker files from the gateway (read only)',
    '        source: edge-mqtt-conf',
    '        target: /gc-mqtt-conf',
    '        read_only: true',
    '        volume: { nocopy: true }',
    '      - type: volume          # copy of the files (0600) + Mosquitto data (data/)',
    '        source: edge-mqtt',
    '        target: /gc-mqtt',
    '        volume: { nocopy: true }',
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
  ];

  // Top-level volumes of the host-network compose (edge, mqtt and the radio control of the gateway).
  const VOLUMES = [
    '',
    'volumes:',
    '  # tmpfs shared with the gateway: the gateway (root) creates its socket there, the setgid',
    '  # bit gives it group 61001 → the edge container can use it, not remove or replace it',
    '  edge-run:',
    '    driver_opts:',
    '      type: tmpfs',
    '      device: tmpfs',
    '      o: "size=1m,uid=0,gid=61001,mode=2750"',
    '  # tmpfs shared: the edge host writes its summary, the gateway reads it',
    '  edge-status:',
    '    driver_opts:',
    '      type: tmpfs',
    '      device: tmpfs',
    '      o: "size=1m,uid=61001,gid=61001,mode=0755"',
    '  # tmpfs: broker files, written by the gateway, read by the mqtt service',
    '  edge-mqtt-conf:',
    '    driver_opts:',
    '      type: tmpfs',
    '      device: tmpfs',
    '      o: "size=1m,uid=0,gid=61001,mode=2750"',
    '  # packages of the edge parts + gc.store (owner 61001 from the image)',
    '  edge-state:',
    '  # copy of the broker files + Mosquitto data (data/), owner 61001',
    '  edge-mqtt:',
    '  # tmpfs shared: the control file of the gateway for the deconz service and its state (radio)',
    '  radio-ctl:',
    '    driver_opts:',
    '      type: tmpfs',
    '      device: tmpfs',
    '      o: "size=1m,uid=0,gid=0,mode=0755"',
    '  # tmpfs shared: the control file of the gateway for the service ki and its state (local AI)',
    '  ai-ctl:',
    '    driver_opts:',
    '      type: tmpfs',
    '      device: tmpfs',
    '      o: "size=1m,uid=0,gid=0,mode=0755"',
    '  # the models of the local AI (1–6 GB each)',
    '  ki-models:',
    '  # tmpfs shared: the control files of the gateway for the service kameras and the picture ring (cameras)',
    '  cam-ctl:',
    '    driver_opts:',
    '      type: tmpfs',
    '      device: tmpfs',
    '      o: "size=256m,uid=0,gid=0,mode=0700"',
    '  # clips and thumbnails of the cameras (when GC_CAMERA_DIR is not set)',
    '  cam-recordings:',
  ];

  // The local AI (phase 3c, step 3 — gateway >= 1.26.0, docs/local-ai.md of the gateway): Ollama,
  // switched on and off in GateControl: the gateway creates /gc-ai/run, the small watcher starts
  // `ollama serve` (127.0.0.1:11435 only) or ends it. Without run only the watcher runs.
  const KI_SERVICE = [
    '',
    '  # Local AI with Ollama (gateway >= 1.26.0, docs/local-ai.md of the gateway) — switched on in GateControl:',
    '  # the gateway creates /gc-ai/run, the small watcher starts `ollama serve` (127.0.0.1:11435 only) or',
    '  # ends it. The models are downloaded by GateControl (KI-Anbieter › Lokale KI).',
    '  ki:',
    '    image: ollama/ollama:0.40.8@sha256:2b8eecdb85aa6ea67c381c8ecffec04b2658496cf2821a8f88b0485bdff198e8',
    '    entrypoint:',
    '      - /bin/sh',
    '      - -c',
    '      - |',
    '        C=/gc-ai; p=""',
    '        say() { printf \'%s %s\\n\' "$$1" "$$(date +%s)" >"$$C/.ki.state" && mv -f "$$C/.ki.state" "$$C/ki.state"; }',
    '        halt() { if [ -n "$$p" ]; then kill "$$p" 2>/dev/null; wait "$$p" 2>/dev/null; fi; p=""; }',
    '        dead() { [ ! -e "/proc/$$1" ] || grep -q \'^State:[[:space:]]*Z\' "/proc/$$1/status" 2>/dev/null; }',
    '        trap \'halt; say idle; exit 0\' TERM INT',
    '        while :; do',
    '          if [ -f "$$C/run" ]; then',
    '            if [ -n "$$p" ] && dead "$$p"; then wait "$$p"; say exit; p=""; sleep 8; fi',
    '            if [ -z "$$p" ]; then ollama serve & p=$$!; fi',
    '            say running',
    '          else',
    '            halt; say idle',
    '          fi',
    '          sleep 2 & wait $$!',
    '        done',
    '    restart: unless-stopped',
    '    network_mode: host',
    '    # the gateway goes first: a smaller CPU share, and when memory runs out the kernel ends the model,',
    '    # never the gateway or the tunnel',
    '    cpu_shares: 256',
    '    oom_score_adj: 800',
    '    volumes:',
    '      - ki-models:/root/.ollama',
    '      - type: volume            # control file of the gateway, state back',
    '        source: ai-ctl',
    '        target: /gc-ai',
    '        volume: { nocopy: true }',
    '    environment:',
    '      - TZ=${TZ:-Etc/UTC}',
    '      # only local (the gateway forwards), not 11434 — an Ollama already on this host is not disturbed',
    '      - OLLAMA_HOST=127.0.0.1:11435',
    '      - OLLAMA_NUM_PARALLEL=1',
    '      - OLLAMA_MAX_LOADED_MODELS=1',
    '      - OLLAMA_KEEP_ALIVE=10m',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "case \\"$$(cut -d\' \' -f1 /gc-ai/ki.state 2>/dev/null)\\" in running) ollama list >/dev/null ;; *) true ;; esac"]',
    '      interval: 60s',
    '      timeout: 10s',
    '      retries: 3',
    '      start_period: 120s',
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
  ];

  // Cameras (phase 3c, step 4 — gateway >= 1.28.0, docs/cameras.md of the gateway): ffmpeg only, switched on in
  // GateControl; the gateway decides per camera what runs (control files in cam-ctl).
  const KAMERAS_SERVICE = [
    '',
    '  # Cameras in the home network (gateway >= 1.28.0, docs/cameras.md of the gateway) — only the ffmpeg of this',
    '  # image is used (mediamtx itself does not run). The entry waits for /gc-cam/kameras.sh, which the gateway writes,',
    '  # and runs it: one ffmpeg per camera (stream copy into a picture ring). No port, no capabilities.',
    '  kameras:',
    '    image: bluenviron/mediamtx:1.21.3-ffmpeg@sha256:208e9f1740a09a5ee63b6308e77ce0d54fce0456462f640e6bd9acfc62ebb5a2',
    '    entrypoint:',
    '      - /bin/sh',
    '      - -c',
    '      - |',
    '        while [ ! -s /gc-cam/kameras.sh ]; do sleep 2; done',
    '        exec /bin/sh /gc-cam/kameras.sh',
    '    restart: unless-stopped',
    '    network_mode: host        # the cameras are in the LAN; no port is opened',
    '    user: "0:0"               # reads the control files of the gateway (root, 0600) — without any capability',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    read_only: true',
    '    tmpfs:',
    '      - /tmp:size=16m',
    '    # the gateway goes first: a smaller CPU share, ffmpeg goes first when memory runs out',
    '    cpu_shares: 512',
    '    oom_score_adj: 500',
    '    mem_limit: 768m',
    '    pids_limit: 64',
    '    depends_on:',
    '      - gateway               # creates cam-ctl and writes kameras.sh',
    '    volumes:',
    '      - type: volume            # control files of the gateway, the picture ring back',
    '        source: cam-ctl',
    '        target: /gc-cam',
    '        volume: { nocopy: true }',
    '    environment:',
    '      - TZ=${TZ:-Etc/UTC}',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "[ ! -s /gc-cam/kameras.sh ] || [ $$(( $$(date +%s) - $$(cut -d\' \' -f2 /gc-cam/kameras.state 2>/dev/null || echo 0) )) -lt 60 ]"]',
    '      interval: 60s',
    '      timeout: 10s',
    '      retries: 3',
    '      start_period: 60s',
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
  ];

  const DECONZ_SERVICE = [
    '',
    '  # Zigbee with deCONZ/Phoscon (gateway >= 1.25.0, docs/radio.md of the gateway) — only with a radio of',
    '  # dresden elektronik (ConBee II/III, RaspBee). Switched on and off in GateControl: the gateway writes',
    '  # /gc-radio/zigbee.env (device, major:minor), the small watcher creates exactly that device node and',
    '  # starts deCONZ — no `devices:` (fails without a stick), no /dev mount; a stick plugged in later works',
    '  # without a new container. Without zigbee.env only the watcher runs.',
    '  deconz:',
    '    image: deconzcommunity/deconz:2.33.2@sha256:3defae1287ecc1a73b68279e12579a5a5e997a83f4ff785fe4bc30f21faf8015',
    '    entrypoint:',
    '      - /bin/sh',
    '      - -c',
    '      - |',
    '        C=/gc-radio; p=""; s=""; st=idle; dt=-',
    '        say() { st="$$1"; dt="$${2:--}"; printf \'%s %s %s\\n\' "$$st" "$$dt" "$$(date +%s)" >"$$C/.deconz.state" && mv -f "$$C/.deconz.state" "$$C/deconz.state"; }',
    '        halt() { if [ -n "$$p" ]; then kill "$$p" 2>/dev/null; wait "$$p" 2>/dev/null; fi; p=""; }',
    '        dead() { [ ! -e "/proc/$$1" ] || grep -q \'^State:[[:space:]]*Z\' "/proc/$$1/status" 2>/dev/null; }',
    '        trap \'halt; say idle; exit 0\' TERM INT',
    '        while :; do',
    '          if [ -f "$$C/zigbee.env" ]; then',
    '            n="$$(cksum <"$$C/zigbee.env")"',
    '            if [ -n "$$p" ] && dead "$$p"; then wait "$$p"; say exit "$$?"; p=""; sleep 8; fi',
    '            if [ -z "$$p" ] || [ "$$n" != "$$s" ]; then',
    '              halt; s="$$n"',
    '              dv="$$(sed -n \'s/^DEVICE=\\(tty[A-Z]\\{3\\}[0-9]\\{1,3\\}\\)$$/\\1/p\' "$$C/zigbee.env")"',
    '              mm="$$(sed -n \'s/^DEV=\\([0-9]\\{3\\}\\):\\([0-9]\\{1,7\\}\\)$$/\\1 \\2/p\' "$$C/zigbee.env")"',
    '              bd="$$(sed -n \'s/^BAUD=\\([0-9]\\{1,6\\}\\)$$/\\1/p\' "$$C/zigbee.env")"',
    '              case "$$dv:$${mm%% *}" in',
    '                ttyACM*:166|ttyUSB*:188|ttyAMA*:204)',
    '                  rm -f "/dev/$$dv"',
    '                  if mknod "/dev/$$dv" c $$mm && chgrp dialout "/dev/$$dv" && chmod 660 "/dev/$$dv"; then',
    '                    DECONZ_DEVICE="/dev/$$dv" DECONZ_BAUDRATE="$${bd:-0}" /start.sh & p=$$!; say running "$$dv"',
    '                  else say wait mknod; fi ;;',
    '                *) say wait invalid ;;',
    '              esac',
    '            else say "$$st" "$$dt"; fi',
    '          else',
    '            halt; s=""; say idle',
    '          fi',
    '          sleep 2 & wait $$!',
    '        done',
    '    restart: unless-stopped',
    '    network_mode: host',
    '    # only these device kinds may be created and opened: ttyACM (ConBee II), ttyUSB (ConBee III /',
    '    # ConBee), ttyAMA (RaspBee on the GPIO header)',
    '    device_cgroup_rules:',
    '      - "c 166:* rmw"',
    '      - "c 188:* rmw"',
    '      - "c 204:* rmw"',
    '    volumes:',
    '      - ./deconz:/opt/deCONZ',
    '      - type: volume            # control file of the gateway, state back',
    '        source: radio-ctl',
    '        target: /gc-radio',
    '        volume: { nocopy: true }',
    '    environment:',
    '      - TZ=${TZ:-Etc/UTC}',
    '      - DECONZ_WEB_PORT=8090',
    '      - DECONZ_WS_PORT=8091',
    '      - DECONZ_VNC_MODE=0',
    '      - DECONZ_UPNP=1',
    '      - DEBUG_INFO=1',
    '      - DEBUG_APS=0',
    '      - DEBUG_ZCL=0',
    '      - DEBUG_ZDP=0',
    '      - DEBUG_OTA=0',
    '      - DEBUG_HTTP=0',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "case \\"$$(cut -d\' \' -f1 /gc-radio/deconz.state 2>/dev/null)\\" in running) curl -fs -m 4 -o /dev/null http://127.0.0.1:8090/api/config ;; *) true ;; esac"]',
    '      interval: 60s',
    '      timeout: 10s',
    '      retries: 3',
    '      start_period: 120s',
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
  ];

  // ─── docker-compose.yml (onboarding) ──────────────────────────────────
  // platform: synology → wireguard-go userspace (needs /dev/net/tun; DSM and
  // other hosts without the WireGuard kernel module), linux → kernel WG.
  // network: host → full feature set (L4 routes, Wake-on-LAN), bridge →
  // HTTP routes only.
  // The clips of the cameras: the folder chosen in GateControl (Gateway › Funktionen › Kameras, a plain absolute
  // path — checked again here, nothing else gets into the YAML) as the default of GC_CAMERA_DIR, else the volume.
  const CAMERA_DIR_RE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,15}$/;
  function recordingsLine(dir) {
    const ok = typeof dir === 'string' && dir.length <= 200 && CAMERA_DIR_RE.test(dir) && dir.split('/').indexOf('..') < 0 && dir.split('/').indexOf('.') < 0;
    return ok
      ? '      - ${GC_CAMERA_DIR:-' + dir + '}:/recordings   # cameras: clips in the folder chosen in GateControl (the folder must exist)'
      : '      - ${GC_CAMERA_DIR:-cam-recordings}:/recordings   # cameras: clips (GC_CAMERA_DIR=/volume1/kameras for a NAS folder)';
  }

  function buildCompose(opts) {
    const o = opts || {};
    const platform = o.platform === 'linux' ? 'linux' : 'synology';
    const network = o.network === 'bridge' ? 'bridge' : 'host';
    const lines = [];
    const headerNotes = [];

    if (network === 'bridge') {
      headerNotes.push(
        '# Bridge mode: HTTP routes only. L4-Routes (raw TCP), Wake-on-LAN and',
        '# edge parts of plugins require host-network mode and will NOT work with this compose.');
    }
    if (platform === 'synology') {
      headerNotes.push(
        '# Userspace WireGuard (wireguard-go) — for Synology DSM and any host',
        '# without the WireGuard kernel module. ~2-3x slower than kernel WG',
        '# but reliable and needs no kernel modifications.');
    } else {
      headerNotes.push(
        '# Linux kernel WireGuard — full performance via netlink, no TUN',
        '# device required. Requires the wireguard kernel module loaded',
        '# on the host (default on Debian 11+ / Ubuntu 22.04+ / kernel ≥5.6).');
    }

    // The gateway service as in docker-compose.example.yml of gatecontrol-gateway (tests/fixtures/
    // gateway-compose/docker-compose.example.yml, compared by tests/gateway_compose_parity.test.js).
    // Deliberate differences: no TZ line (the gateway takes its time zone from the server since
    // gateway 1.22.0 — the env value would only be a fallback), /dev/net/tun and the wireguard-go
    // switch only on synology (linux = kernel WireGuard), bridge mode without the host-only parts.
    lines.push(
      'services:',
      '  gateway:',
      '    image: ghcr.io/callmetechie/gatecontrol-gateway:latest',
      '    restart: unless-stopped'
    );
    if (network === 'host') lines.push('    network_mode: host');
    lines.push(
      '    cap_drop:',
      '      - ALL',
      '    cap_add:',
      '      - NET_ADMIN         # wg-quick + WireGuard interface, ip/iptables'
    );
    // NET_BIND_SERVICE only matters in host mode (low ports for L4 routes, DNS filter on 53).
    if (network === 'host') lines.push('      - NET_BIND_SERVICE  # L4 routes and the DNS filter on ports <1024');
    // NET_RAW: ICMP ping of the internet quality (else TCP fallback) and keepalived VRRP + GARP
    // (failover pools / scan egress, raw socket; NET_ADMIN does not cover it).
    lines.push('      - NET_RAW           # ping (internet quality), keepalived VRRP + GARP (failover)');
    // SETGID/SETUID: keepalived enable_script_security drops to script_user for its health check —
    // keepalived (VIP on the LAN interface) only runs with the host network.
    if (network === 'host') {
      lines.push(
        '      - SETGID            # keepalived enable_script_security (health-check script)',
        '      - SETUID            # keepalived enable_script_security (health-check script)'
      );
    }
    // /dev/net/tun only for the wireguard-go userspace path.
    if (platform === 'synology') {
      lines.push(
        '    devices:',
        '      - /dev/net/tun:/dev/net/tun'
      );
    }
    if (network === 'bridge') {
      lines.push(
        '    ports:',
        '      - "8080:8080"   # HTTP proxy (Caddy upstream)',
        '      - "9876:9876"   # Management API (do NOT expose to internet)'
      );
    }
    lines.push(
      '    read_only: true',
      // wg-quick needs UID 0; the image keeps a non-root user for later — pin root explicitly
      '    user: "0:0"                # wg-quick needs root; only the capabilities above',
      '    tmpfs:',
      '      - /tmp',
      '      - /run',
      '      - /etc/wireguard',
      '    volumes:',
      '      - ./config:/config:ro',
      '      - ./gateway-state:/state   # rw: auto-update state (self-update flag + last-pull)',
      // home cache (gateway >= 1.22.0): always mounted at /cache, used only when switched on for
      // this gateway; GC_CACHE_DIR moves it elsewhere (e.g. a USB disk), as in the gateway's own example
      '      - ${GC_CACHE_DIR:-./gateway-cache}:/cache   # home cache, only used when switched on'
    );
    // edge parts of plugins (docs/plugins.md "Edge part"): host network only — the gateway opens the LAN
    // (UDP, multicast, mDNS) for the network-less edge container through its socket in edge-run and
    // writes the broker files to edge-mqtt-conf
    if (network === 'host') {
      lines.push(
        '      # edge container: the gateway socket there, its summary back, broker files for mqtt',
        '      - type: volume',
        '        source: edge-run',
        '        target: /run/gc-edge',
        '        volume: { nocopy: true }',
        '      - type: volume',
        '        source: edge-status',
        '        target: /run/gc-edge-status',
        '        read_only: true',
        '        volume: { nocopy: true }',
        '      - type: volume',
        '        source: edge-mqtt-conf',
        '        target: /gc-mqtt-conf',
        '        volume: { nocopy: true }',
        '      # only so that a new volume takes owner 61001 from the image (the gateway cannot read it)',
        '      - type: volume',
        '        source: edge-mqtt',
        '        target: /gc-mqtt',
        '        read_only: true',
        // radio (gateway >= 1.25.0): the control file for the deconz service; harmless without it
        '      - type: volume            # radio: control file for the deconz service',
        '        source: radio-ctl',
        '        target: /gc-radio',
        '        volume: { nocopy: true }',
        // local AI (gateway >= 1.26.0): the control file for the service ki; harmless without it
        '      - type: volume            # local AI: control file for the service ki',
        '        source: ai-ctl',
        '        target: /gc-ai',
        '        volume: { nocopy: true }',
        // cameras (gateway >= 1.28.0): control files + picture ring of the service kameras, and the clips; harmless without it
        '      - type: volume            # cameras: control files and picture ring of the service kameras',
        '        source: cam-ctl',
        '        target: /gc-cam',
        '        volume: { nocopy: true }',
        recordingsLine(o.cameraDir)
      );
    }
    lines.push(
      '    environment:',
      '      - LOG_LEVEL=info',
      '      - GATEWAY_ENV_PATH=/config/gateway.env'
    );
    // the image sets it too; kept visible where the userspace path is the point of the profile
    if (platform === 'synology') lines.push('      - WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go');
    lines.push(
      '    healthcheck:',
      '      interval: 60s',
      '      timeout: 5s',
      '      retries: 3',
      '    logging:',
      '      driver: json-file',
      '      options:',
      '        max-size: "10m"',
      '        max-file: "3"'
    );
    if (network === 'host') {
      lines.push(...EDGE_SERVICES);
      // Zigbee (phase 3c, step 2): only when wanted — the image is ≈ 350 MB (the gateway's example keeps it in
      // the profile "zigbee"; here it is wanted, so without the profile)
      if (o.zigbee === true) lines.push(...DECONZ_SERVICE);
      // the local AI (phase 3c, step 3): only when switched on for this gateway — the image is ≈ 3 GB (the
      // gateway's example keeps it in the profile "ki")
      if (o.ai === true) lines.push(...KI_SERVICE);
      // cameras (phase 3c, step 4): only when switched on for this gateway (the gateway's example keeps it in the
      // profile "kameras")
      if (o.cameras === true) lines.push(...KAMERAS_SERVICE);
      lines.push(...VOLUMES);
    }
    const header = headerNotes.length > 0 ? headerNotes.join('\n') + '\n' : '';
    return header + lines.join('\n') + '\n';
  }

  // ─── Input checks (Raspberry-Pi step) ─────────────────────────────────

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    // eslint-disable-next-line no-undef
    return new Uint8Array(Buffer.from(String(s), 'utf8'));
  }

  // settings.txt is read line by line, values are trimmed and stripped of
  // surrounding quotes by the image — so a value must not start or end with
  // white space or a quote, and never contain a line break or other control
  // character.
  // eslint-disable-next-line no-control-regex
  const CONTROL_RE = /[\u0000-\u001f\u007f]/;
  function edgeSafe(s) { return !/^[\s'"]|[\s'"]$/.test(s); }

  /** WLAN name: 1–32 bytes UTF-8. */
  function checkSsid(v) {
    const s = String(v == null ? '' : v);
    if (!s) return 'ssid_required';
    if (utf8(s).length > 32) return 'ssid_too_long';
    if (CONTROL_RE.test(s) || !edgeSafe(s)) return 'ssid_chars';
    return null;
  }

  /** WPA passphrase: 8–63 printable ASCII, or 64 hex digits; empty = open network. */
  function checkPsk(v) {
    const s = String(v == null ? '' : v);
    if (!s) return null;
    if (/^[0-9a-fA-F]{64}$/.test(s)) return null;
    if (s.length < 8 || s.length > 63) return 'psk_length';
    if (!/^[\x20-\x7e]+$/.test(s) || !edgeSafe(s)) return 'psk_chars';
    return null;
  }

  /** Host name: one RFC-1123 label (letters, digits, hyphen; 1–63; no hyphen at either end). */
  function checkHostname(v) {
    const s = String(v == null ? '' : v);
    if (!s) return null; // empty = image default
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s)) return 'hostname_invalid';
    return null;
  }

  function checkCountry(v) {
    return /^[A-Z]{2}$/.test(String(v || '')) ? null : 'country_invalid';
  }

  function checkTimezone(v, known) {
    const s = String(v || '');
    if (!s) return null;
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(s) || s.length > 64) return 'timezone_invalid';
    if (Array.isArray(known) && known.length && known.indexOf(s) < 0 && s !== 'UTC' && s !== 'Etc/UTC') return 'timezone_invalid';
    return null;
  }

  function b64decode(s) {
    if (typeof atob === 'function') {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // eslint-disable-next-line no-undef
    return new Uint8Array(Buffer.from(s, 'base64'));
  }

  // RFC 4253 wire format: uint32 length + bytes.
  function sshFields(blob) {
    const out = [];
    let p = 0;
    while (p + 4 <= blob.length && out.length < 8) {
      const len = ((blob[p] << 24) >>> 0) + (blob[p + 1] << 16) + (blob[p + 2] << 8) + blob[p + 3];
      p += 4;
      if (len > blob.length - p) return null;
      out.push(blob.subarray(p, p + len));
      p += len;
    }
    return p === blob.length ? out : null;
  }

  function mpintBits(b) {
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    if (i === b.length) return 0;
    let bits = (b.length - i - 1) * 8;
    let top = b[i];
    while (top) { bits++; top >>= 1; }
    return bits;
  }

  const SSH_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
    'ssh-rsa', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];

  /** One OpenSSH public key line (ed25519 / ecdsa / rsa ≥ 3072 bit); empty = SSH stays off. */
  function checkSshKey(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    if (s.length > 16384 || CONTROL_RE.test(s)) return 'ssh_invalid';
    const m = /^(\S+) ([A-Za-z0-9+/]+={0,3})(?: ([^\r\n]*))?$/.exec(s);
    if (!m || SSH_TYPES.indexOf(m[1]) < 0) return 'ssh_invalid';
    let fields;
    try { fields = sshFields(b64decode(m[2])); } catch (e) { return 'ssh_invalid'; }
    if (!fields || !fields.length) return 'ssh_invalid';
    let type = '';
    for (let i = 0; i < fields[0].length; i++) type += String.fromCharCode(fields[0][i]);
    if (type !== m[1]) return 'ssh_invalid';
    if (type === 'ssh-rsa') {
      if (fields.length !== 3) return 'ssh_invalid';
      if (mpintBits(fields[2]) < 3072) return 'ssh_rsa_short';
    } else if (type === 'ssh-ed25519') {
      if (fields.length !== 2 || fields[1].length !== 32) return 'ssh_invalid';
    }
    return null;
  }

  /** "Pi Keller" → "gc-pi-keller" (ASCII folding of the German umlauts, max 63). */
  function suggestHostname(name) {
    let s = String(name || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    if (typeof s.normalize === 'function') s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!s) return 'gatecontrol-gw';
    if (s.indexOf('gc-') !== 0) s = 'gc-' + s;
    return s.slice(0, 63).replace(/-+$/, '');
  }

  // ─── settings.txt (Pi image contract) ─────────────────────────────────
  /**
   * @param {{hostname?, zigbee?, timezone?, network?: 'lan'|'wifi', ssid?, psk?, country?, hidden?, sshKey?}} o
   * @returns {{text?: string, errors?: object}}
   */
  function buildSettingsTxt(o) {
    const s = o || {};
    const errors = {};
    const zigbee = ['auto', 'on', 'off'].indexOf(s.zigbee) >= 0 ? s.zigbee : 'auto';
    const hostname = String(s.hostname || '').trim().toLowerCase();
    const timezone = String(s.timezone || '').trim();
    const sshKey = String(s.sshKey || '').trim();
    let e;
    if ((e = checkHostname(hostname))) errors.hostname = e;
    if ((e = checkTimezone(timezone, s.knownTimezones))) errors.timezone = e;
    if ((e = checkSshKey(sshKey))) errors.sshKey = e;
    const wifi = s.network === 'wifi';
    const country = String(s.country || 'DE').trim().toUpperCase();
    if (wifi) {
      if ((e = checkSsid(s.ssid))) errors.ssid = e;
      if ((e = checkPsk(s.psk))) errors.psk = e;
      if ((e = checkCountry(country))) errors.country = e;
    }
    if (Object.keys(errors).length) return { errors };

    const lines = [
      '# GateControl Gateway — Einstellungen (vom Gateway-Assistenten erzeugt)',
      '# Format: NAME=WERT, Zeilen mit # sind Kommentare.',
      '',
    ];
    if (hostname) lines.push('HOSTNAME=' + hostname);
    lines.push('ZIGBEE=' + zigbee);
    if (timezone) lines.push('TIMEZONE=' + timezone);
    if (wifi) {
      lines.push('WIFI_SSID=' + s.ssid);
      lines.push('WIFI_PSK=' + (s.psk || ''));
      lines.push('WIFI_COUNTRY=' + country);
      lines.push('WIFI_HIDDEN=' + (s.hidden ? '1' : '0'));
    }
    if (sshKey) lines.push('SSH_AUTHORIZED_KEY=' + sshKey);
    return { text: lines.join('\n') + '\n' };
  }

  // ─── ZIP (stored entries, no compression) ─────────────────────────────

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  // Only plain relative names: no "..", ".", empty segments, backslashes,
  // drive letters or control characters (a fixed set of names is passed in
  // anyway — this is the second line).
  function safeEntryName(name) {
    const s = String(name);
    const dir = s.endsWith('/');
    const parts = (dir ? s.slice(0, -1) : s).split('/');
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || /[\\:]/.test(p) || CONTROL_RE.test(p))) {
      throw new Error('unsafe zip entry name: ' + s);
    }
    return s;
  }

  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
      date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
    };
  }

  /**
   * @param {Array<{name: string, data?: string|Uint8Array, mode?: number}>} files
   *        a name ending in "/" is a directory entry; mode = unix permissions
   * @param {Date} [when]
   * @returns {Uint8Array}
   */
  function zipStored(files, when) {
    const { time, date } = dosDateTime(when || new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    let count = 0;
    for (const f of files) {
      const name = safeEntryName(f.name);
      const isDir = name.endsWith('/');
      const nameBytes = utf8(name);
      const data = isDir ? new Uint8Array(0) : (typeof f.data === 'string' ? utf8(f.data) : (f.data || new Uint8Array(0)));
      const crc = crc32(data);
      const mode = (isDir ? 0o40755 : 0o100000 | (f.mode || 0o644)) >>> 0;

      const local = new Uint8Array(30);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0x0800, true);      // UTF-8 names
      lv.setUint16(8, 0, true);           // stored
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      chunks.push(local, nameBytes, data);

      const c = new Uint8Array(46);
      const cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, (3 << 8) | 20, true); // made by: UNIX, 2.0 (permissions in the external attributes)
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(38, ((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, true);
      cv.setUint32(42, offset, true);
      central.push(c, nameBytes);

      offset += 30 + nameBytes.length + data.length;
      count++;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, count, true);
    ev.setUint16(10, count, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const all = chunks.concat(central, [end]);
    let total = 0;
    for (const a of all) total += a.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  /** The Pi set-up file: gatecontrol/gateway.env + gatecontrol/settings.txt. */
  function piSetupZip(envContent, settingsText, when) {
    return zipStored([
      { name: 'gatecontrol/' },
      { name: 'gatecontrol/gateway.env', data: String(envContent || ''), mode: 0o600 },
      { name: 'gatecontrol/settings.txt', data: String(settingsText || '') },
    ], when);
  }

  /**
   * Host trigger of update.sh (DSM task scheduler, cron): without variables the
   * script looks for the flag in /state (only inside the container) — so the
   * host side of /state and the project folder are passed, plus docker in PATH
   * (gatecontrol-gateway docs/auto-update.md).
   */
  function nasTaskCommand(dir) {
    const d = String(dir || NAS_DIR).replace(/\/+$/, '');
    return 'PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=' + d + '/gateway-state GC_GW_COMPOSE_DIR=' + d + ' bash ' + d + '/update.sh';
  }

  /** Proxmox: the one-line LXC installer with a pairing code. */
  function pairingCommand(token) {
    return 'bash -c "$(curl -fsSL ' + INSTALL_SCRIPT_URL + ')" -- \\\n  --token "' + token + '" --yes';
  }

  /** "1.17.0" ≥ "1.16.11"? (plain x.y.z, anything else → false). */
  function versionAtLeast(v, min) {
    const a = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    const b = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(min || ''));
    if (!a || !b) return false;
    for (let i = 1; i <= 3; i++) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
    }
    return true;
  }

  return {
    PLATFORMS, PI_MODELS, GATEWAY_REPO, RELEASES_URL, IMAGER_REPO_URL, INSTALL_SCRIPT_URL, NAS_DIR, DECONZ_PORT,
    buildCompose, checkSsid, checkPsk, checkHostname, checkCountry, checkTimezone, checkSshKey,
    suggestHostname, buildSettingsTxt, crc32, zipStored, piSetupZip, nasTaskCommand, pairingCommand, versionAtLeast,
  };
});
