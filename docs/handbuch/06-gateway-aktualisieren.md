# 6. Bestehendes Gateway aktualisieren

[← Funktionen der Heim-Gateways](05-funktionen.md) · [Inhaltsverzeichnis](README.md) · [Weiter: FAQ →](07-faq.md)

## 6.1 Gateway-Software aktualisieren

Ist eine neue Gateway-Version da, zeigt die Karte des Gateways unter
„Netzwerk“ → „Gateways“ einen Knopf „Update auf …“. Ein Klick, „Aktualisieren“
bestätigen – das Gateway holt sich das neue Image und startet neu. Klappt das
nicht, rollt es auf die vorige Version zurück.

Damit der Knopf wirkt, muss das Auto-Update auf dem Gerät eingerichtet sein:

- **Raspberry-Pi-Image:** ist schon eingebaut.
- **Synology:** die Aufgabe im Aufgabenplaner aus [Kapitel 3.2](03-gateway-einrichten.md#32-synology-nas), Schritt 10.
- **Linux:** die Cron-Zeile aus [Kapitel 3.4](03-gateway-einrichten.md#34-linux-rechner-mit-docker), Schritt 6.

Ist es nicht eingerichtet, zeigt die Karte ein Paket-Symbol mit „Auto-Update
noch nicht eingerichtet“. Ein Klick darauf öffnet „Auto-Update einrichten“ mit
der Anleitung.

Während das Gateway neu startet, zeigt die Karte „Update läuft“ mit der Zeit,
bis zu der es zurück erwartet wird – kein „Offline“, und es geht kein
Offline-Alarm raus. Ist es bis dahin nicht wieder da, gilt es als offline und
der Alarm kommt dann. Sobald der erste Heartbeat eintrifft, steht es wieder auf
„Online“. Ist das Gateway in einem Pool, holt es seine Routen erst nach der
Wartezeit für den Rückwechsel zurück; die Karte zählt diese Zeit herunter
(„übernimmt seine Routen in 4:30 wieder“).

**Prüfen:** Nach einigen Minuten zeigt die Karte die neue Version.

## 6.2 Warum die Compose-Datei extra dran ist

Das Auto-Update tauscht **nur das Image** aus. Die Compose-Datei
`docker-compose.yml` auf deinem Gerät ändert es **nie**. Neue Funktionen, die
zusätzliche Container oder Ordner brauchen, kommen deshalb nicht von selbst:

| Funktion | seit Gateway | braucht in der Compose-Datei |
|---|---|---|
| Auto-Update | – | `./gateway-state:/state` |
| Edge-Plugins und MQTT | 1.19.0 | Dienste `edge` und `mqtt`, Volumes `edge-run`, `edge-status`, `edge-state`, `edge-mqtt` |
| Zwischenspeicher | 1.22.0 | `${GC_CACHE_DIR:-./gateway-cache}:/cache` |
| Failover-Pools, Scan über ein anderes Gateway, Ping der Internetqualität | – | unter `cap_add` die Rechte `NET_RAW`, `SETGID` und `SETUID` |
| Kameras (Live-Bild, Clips) | 1.28.0 | Dienst `kameras`, Volumes `cam-ctl` und `${GC_CAMERA_DIR:-cam-recordings}:/recordings` |
| Funk: zigbee2mqtt, Thread Border Router | nach 1.31.0 | Dienste `zigbee2mqtt` und `otbr` (nur wenn gewählt), Volumes `z2m-data` und `otbr-data` |
| Office-Dateien drucken | 1.33.0 | Dienst `office`, Volume `office-ctl` |

Du brauchst dieses Kapitel, wenn du eines davon siehst:

- „Edge-Dienst fehlt“ oder „Edge-Container läuft nicht“ im Reiter „Edge-Plugins“,
- „Ordner nicht beschreibbar“ beim Zwischenspeicher,
- deine Compose-Datei hat keine Zeile mit `gateway-cache` oder keinen Dienst `edge`.

Das **Raspberry-Pi-Image** pflegt seine Compose-Datei selbst. Dieses Kapitel
gilt für **Synology** und **Linux/Docker**.

## 6.3 Synology: Compose-Datei erneuern

Lade **nicht** das NAS-Paket aus dem Assistenten neu herunter. Es erzeugt einen
neuen Zugangsschlüssel, und das laufende Gateway verliert die Verbindung, bis
es die neue `gateway.env` bekommt. Hol dir stattdessen nur die Compose-Datei:
„Netzwerk“ → „Gateways“ → dein Gateway öffnen → Symbol „Nur docker-compose.yml
herunterladen“ (Datei mit Pfeil oben rechts) → „Synology NAS“, „Host“ →
„Herunterladen“. Das erzeugt keine neuen Schlüssel. Zeigt der Reiter
„Edge-Plugins“ „Edge-Dienst fehlt“, steht derselbe Knopf auch dort. Die
Datei ist dieselbe wie die [Beispieldatei](#beispieldatei-synology) unten.

1. **Gateway zuerst aktualisieren.** Zeigt die Karte „Update auf …“, klicke es
   und warte, bis die neue Version angezeigt wird. Dann liegt das neue Image auf
   der NAS, das auch der Edge-Container braucht.
2. **Alte Datei sichern.** File Station → `docker/gatecontrol-gateway` →
   `docker-compose.yml` herunterladen.
3. **Ordner anlegen.** In der File Station in `docker/gatecontrol-gateway` die
   Ordner `gateway-cache` und – falls er fehlt – `gateway-state` anlegen.
   Synology legt fehlende Ordner nicht selbst an.
4. **Projekt stoppen.** Container Manager → „Projekt“ → `gatecontrol-gateway` → „Stoppen“.
5. **Neue Datei einsetzen.** Im Projekt den Reiter „YAML-Konfiguration“ öffnen,
   den ganzen Inhalt durch die heruntergeladene Datei (oder die [Beispieldatei](#beispieldatei-synology)) ersetzen und speichern.
6. **Neu erstellen und starten.** Das Projekt neu erstellen und starten.

Hattest du in der alten Datei eigene Änderungen (zum Beispiel einen anderen
Ordner für `config`), übernimm sie in die neue Datei. Eine Zeile `TZ=…` brauchst
du nicht mehr: Das Gateway bekommt die Zeitzone vom Server.

Per SSH geht Schritt 3 bis 6 auch so (nachdem du die neue `docker-compose.yml`
in den Ordner gelegt hast):

```bash
cd /volume1/docker/gatecontrol-gateway
sudo mkdir -p gateway-state gateway-cache
sudo docker compose up -d
```

**Prüfen:**

- Container Manager → „Container“: `…-gateway-1`, `…-edge-1` und `…-mqtt-1` laufen.
- In GateControl zeigt der Reiter „Edge-Plugins“ nach „Edge einschalten“
  „Verbunden seit …“ und „Edge ohne Netzwerk (isoliert)“.

## 6.4 Linux/Docker: Compose-Datei erneuern

1. Gateway zuerst aktualisieren (siehe [6.1](#61-gateway-software-aktualisieren)).
2. Hol dir die aktuelle Compose-Datei: „Netzwerk“ → „Gateways“ → dein Gateway
   öffnen → Symbol „Nur docker-compose.yml herunterladen“ → „Linux-Rechner mit
   Docker“, „Host (empfohlen)“ → „Herunterladen“. Das erzeugt keine neuen
   Schlüssel. Lade **nicht** die `gateway.env` neu herunter – das erzeugt einen
   neuen Zugangsschlüssel.
3. Auf dem Linux-Rechner:

   ```bash
   cd /opt/gatecontrol-gateway
   sudo cp docker-compose.yml docker-compose.yml.bak
   sudo mv ~/docker-compose.yml .
   sudo mkdir -p gateway-state gateway-cache
   sudo docker compose up -d
   ```

**Prüfen:** `sudo docker compose ps` zeigt `gateway`, `edge` und `mqtt` als laufend.

## Beispieldatei Synology

Das ist genau die Datei, die der Assistent für die Synology erzeugt (Host-Netzwerk,
WireGuard im Userspace). Lege vorher die Ordner `config/` (mit `gateway.env`),
`gateway-state/` und `gateway-cache/` neben ihr an.

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
  # the edge container). The watcher copies them to /gc-mqtt, restarts Mosquitto when the
  # configuration changes and sends SIGHUP when the accounts change. Port 1883 only on
  # LAN addresses, no anonymous access.
  mqtt:
    image: eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f
    entrypoint:
      - /bin/sh
      - -c
      - |
        G=/gc-mqtt-conf; C=/gc-mqtt; p=""; s=""; r=""
        halt() { if [ -n "$$p" ]; then kill "$$p" 2>/dev/null; wait "$$p" 2>/dev/null; fi; p=""; }
        take() { for f in mosquitto.conf passwd acl; do cp "$$G/$$f" "$$C/.$$f" && chmod 600 "$$C/.$$f" && mv -f "$$C/.$$f" "$$C/$$f" || return 1; done; }
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

Den Ordner des Zwischenspeichers kannst du verlegen, z. B. auf ein anderes
Volume: Lege dazu neben der Compose-Datei eine Datei `.env` mit
`GC_CACHE_DIR=/volume1/gatecontrol-cache` an, leg den Ordner an und erstelle
das Projekt neu.

Weiter mit [Kapitel 7: FAQ und Fehlerbehebung](07-faq.md).
