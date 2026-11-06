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
  „Verbunden seit …“ und „Netzgrenze aktiv (iptables)“.

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

Den Ordner des Zwischenspeichers kannst du verlegen, z. B. auf ein anderes
Volume: Lege dazu neben der Compose-Datei eine Datei `.env` mit
`GC_CACHE_DIR=/volume1/gatecontrol-cache` an, leg den Ordner an und erstelle
das Projekt neu.

Weiter mit [Kapitel 7: FAQ und Fehlerbehebung](07-faq.md).
