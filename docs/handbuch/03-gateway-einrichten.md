# 3. Gateway einrichten

[← Server einrichten](02-server-einrichten.md) · [Inhaltsverzeichnis](README.md) · [Weiter: Edge-Plugins und Smart Home →](04-edge-und-smart-home.md)

Ein Gateway richtest du immer über den **Assistenten** in GateControl ein. Er
legt das Gateway an, gibt dir die passenden Dateien und zeigt live, ob es sich
gemeldet hat. Danach folgst du der Anleitung für dein Gerät:

- [3.2 Synology NAS](#32-synology-nas)
- [3.3 Raspberry Pi](#33-raspberry-pi)
- [3.4 Linux-Rechner mit Docker](#34-linux-rechner-mit-docker)
- [3.5 Proxmox](#35-proxmox)

Wo die Gateways stehen, ordnest du mit [Standorten](#36-standorte). Umbenennen,
abschalten und entfernen: [3.7 Gateway verwalten](#37-gateway-verwalten).

## 3.1 Der Assistent „Gateway hinzufügen“

1. Öffne in GateControl links „Geräte“ → „Gateways“.
2. Klicke oben rechts auf „Gateway hinzufügen“.
3. **Schritt 1:**
   - „Name“: zum Beispiel `NAS Keller`. Erlaubt sind Buchstaben a–z, Ziffern,
     Leerzeichen, Punkt, Binde- und Unterstrich (keine Umlaute, höchstens 63 Zeichen).
   - „Standort (optional)“: wo das Gateway steht, zum Beispiel „Zuhause“ oder
     „Büro“. Wähle einen vorhandenen Standort, „Neuer Standort …“ (Name, Ort
     und auf Wunsch die Adresse direkt darunter) oder lass „Kein Standort“
     stehen. Mehr dazu in [3.6](#36-standorte).
   - „Worauf soll das Gateway laufen?“: „Raspberry Pi“, „Synology NAS“,
     „Proxmox“ oder „Anderer Linux-Rechner“.
4. **Schritt 2** gibt es nur beim Raspberry Pi (siehe [3.3](#33-raspberry-pi)).
5. Klicke „Gateway anlegen und weiter“.
6. **Schritt 3** zeigt die Anleitung für dein Gerät. Folge dem Abschnitt unten.
7. **Schritt 4** wartet auf das Gateway und hakt ab: „Gateway angelegt“ →
   „… hat sich gemeldet“ → „Tunnel steht“ → „Hardware erkannt“.
8. Klicke „Fertig – zum Gateway“.

Du kannst den Assistenten jederzeit schließen. Das Gateway erscheint dann als
Karte mit „wartet auf ersten Start“. Mit „Einrichtung fortsetzen“ geht es
weiter, wo du aufgehört hast.

**Wichtig zu den Einrichtungsdateien:** Sie enthalten den Zugangsschlüssel des
Gateways. Jeder neue Download erzeugt einen neuen Schlüssel – nur die zuletzt
heruntergeladene Datei gilt. War das Gateway schon verbunden, fragt der
Assistent vorher nach, weil das laufende Gateway sonst die Verbindung verliert.

**Prüfen:** Unter „Gateways“ steht eine Karte mit dem Namen deines Gateways.

## 3.2 Synology NAS

Du brauchst DSM 7.2 oder neuer und das Paket **Container Manager** aus dem Paket-Zentrum.

### Schritte

1. Wähle im Assistenten „Synology NAS“ und klicke „Gateway anlegen und weiter“.
2. Klicke auf `gatecontrol-gateway-nas.zip`. Das Paket enthält die fertige
   `docker-compose.yml`, die `gateway.env`, das Update-Skript `update.sh` und
   die leeren Ordner `gateway-state` und `gateway-cache`.
3. Öffne in DSM die **File Station** → Ordner `docker`.
4. Lege dort einen Ordner `gatecontrol-gateway` an.
5. Lade die ZIP-Datei in diesen Ordner hoch. Rechtsklick auf die ZIP → „Extrahieren“ → in diesen Ordner.
6. Lösche danach die ZIP-Datei – sie enthält den Zugangsschlüssel.

   So sieht der Ordner jetzt aus:

   ```
   docker/gatecontrol-gateway/
   ├─ docker-compose.yml
   ├─ update.sh
   ├─ config/
   │  └─ gateway.env
   ├─ gateway-state/
   └─ gateway-cache/
   ```

   > **Synology legt fehlende Ordner nicht an.** Fehlt ein Ordner, den die
   > Compose-Datei einbindet, bricht der Start mit `Bind mount failed: … does not exist`
   > ab. Das Paket bringt `config/`, `gateway-state/` und `gateway-cache/` mit.
   > Schreibst oder änderst du die Compose-Datei selbst, legst du fehlende
   > Ordner vorher in der File Station an.

7. Öffne den **Container Manager** → „Projekt“ → „Erstellen“.
8. Projektname: `gatecontrol-gateway`. Pfad: der Ordner `docker/gatecontrol-gateway`.
9. Wähle „Vorhandene docker-compose.yml verwenden“ → „Weiter“ → „Fertig“.
   Der Container Manager lädt jetzt die Images (dafür braucht die NAS Zugang zu
   `ghcr.io` und Docker Hub) und startet drei Container: `gateway`, `edge` und `mqtt`.

   > Die Meldung **„Your kernel does not support PIDs limit …“** ist harmlos.
   > Der Kernel der Synology kann die Prozess-Grenze (`pids_limit`) nicht
   > setzen. Docker lässt sie weg, alles andere läuft normal.

10. **Automatische Updates (einmalig, empfohlen):** „Systemsteuerung“ →
    „Aufgabenplaner“ → „Erstellen“ → „Geplante Aufgabe“ → „Benutzerdefiniertes Skript“.
    - Benutzer: `root`
    - Zeitplan: täglich, jede Minute wiederholen
    - Befehl: kopiere ihn aus dem Assistenten. Er sieht so aus:

      ```bash
      PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/volume1/docker/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/volume1/docker/gatecontrol-gateway bash /volume1/docker/gatecontrol-gateway/update.sh
      ```

      Liegt der Ordner `docker` auf einem anderen Volume, ersetze `volume1`.
11. Klicke im Assistenten „Projekt läuft – weiter“ und warte auf Schritt 4.

**Prüfen:**

- Container Manager → „Container“: `gatecontrol-gateway-gateway-1`,
  `gatecontrol-gateway-edge-1` und `gatecontrol-gateway-mqtt-1` laufen.
- Der Assistent zeigt „NAS hat sich gemeldet“ und „Tunnel steht“.

Kommt nach 10 Minuten nichts: Läuft das Projekt („Aktiv“)? Liegt `gateway.env`
im Ordner `config`? Das Protokoll (Container Manager → „Container“ →
`…-gateway-1` → „Protokoll“) nennt den Grund.

### Edge auf der Synology

Für [Edge-Plugins](04-edge-und-smart-home.md) ist auf der Synology nichts
weiter zu tun: Der Container `edge` läuft ohne eigenes Netz, der Container
`gateway` erledigt seine Verbindungen und prüft sie. Ein Kernel-Modul (früher
`xt_owner`) oder SSH braucht es nicht. Stammt die Compose-Datei von vor
Gateway 1.23.0, zeigt GateControl „Compose-Datei veraltet“ – dann die aktuelle
Datei herunterladen, siehe
[Kapitel 4](04-edge-und-smart-home.md#compose-datei-veraltet).

## 3.3 Raspberry Pi

Du brauchst: einen Raspberry Pi 3 B+, 4, 5 oder Zero 2 W, eine microSD-Karte
(mindestens 16 GB, Klasse A1/A2), einen PC mit Kartenleser und den kostenlosen
[Raspberry Pi Imager](https://www.raspberrypi.com/software/). Docker- oder
Linux-Kenntnisse sind nicht nötig.

### Schritte

1. Wähle im Assistenten „Raspberry Pi“ und klicke „Weiter“.
2. **Schritt 2 – „Raspberry Pi einstellen“:**
   - „Modell“: dein Pi.
   - „Netzwerk“: „LAN-Kabel“ (zuverlässiger) oder „WLAN“ mit Name und
     Passwort. Der Pi kann WPA2 und den WPA2/WPA3-Mischbetrieb, kein reines WPA3.
   - „Zigbee-Funkmodul“: „Automatisch erkennen“ (für RaspBee II oder ConBee) oder „Aus“.
   - „Erweitert (optional)“: Gerätename, Zeitzone, WLAN-Land, SSH-Schlüssel.
     Ohne SSH-Schlüssel bleibt SSH aus.
3. Klicke „Gateway anlegen und weiter“.
4. Lade **beide Dateien** herunter: das „Pi-Image“ (`.img.xz`) und die
   „Einrichtungsdatei (gatecontrol-setup.zip)“.
5. Starte den Raspberry Pi Imager:
   1. „Gerät wählen“ → dein Pi.
   2. „OS wählen“ → ganz unten „Eigenes Image verwenden“ → die `.img.xz`-Datei. Nicht entpacken.
   3. „SD-Karte wählen“ → deine Karte.
   4. Bei „Einstellungen anpassen?“ **Nein** wählen – WLAN usw. kommen aus der Einrichtungsdatei.
   5. „Schreiben“ und warten (ca. 5–10 Minuten).
6. Zieh die Karte ab und steck sie wieder ein. Es erscheint ein Laufwerk **`bootfs`**.
7. Entpacke die `gatecontrol-setup.zip` direkt auf `bootfs`, sodass es so aussieht:

   ```
   bootfs/
   └─ gatecontrol/
      ├─ gateway.env
      └─ settings.txt
   ```

8. Karte sicher auswerfen, in den Pi stecken, LAN-Kabel (falls genutzt), Strom an.
9. Klicke im Assistenten „Pi ist eingesteckt – weiter“. Der erste Start dauert 3–5 Minuten.

Der Pi übernimmt `gateway.env`, WLAN-Passwort und SSH-Schlüssel beim Start und
löscht sie danach von der Karte. Lass die Karte bis dahin nicht herumliegen.

**Prüfen:** Der Assistent zeigt „Pi hat sich gemeldet“ und „Tunnel steht“.
Kommt nach 10 Minuten nichts, steck die Karte in den PC: Die Datei
`bootfs/gatecontrol/STATUS.txt` nennt den Grund.

### settings.txt

Die Datei `bootfs/gatecontrol/settings.txt` enthält eine Einstellung pro Zeile,
`NAME=WERT`, **ohne Anführungszeichen**. Der Assistent füllt sie für dich. Die
wichtigsten Einträge:

| Eintrag | Bedeutung |
|---|---|
| `HOSTNAME` | Gerätename im Netz |
| `ZIGBEE` | `auto`, `on` oder `off` |
| `EDGE` | `on` (Standard) oder `off` – Edge-Container und MQTT-Broker |
| `TIMEZONE` | Zeitzone des Pi, z. B. `Europe/Berlin` |
| `WIFI_SSID`, `WIFI_PSK`, `WIFI_COUNTRY`, `WIFI_HIDDEN` | WLAN |
| `SSH_AUTHORIZED_KEY` | öffentlicher SSH-Schlüssel (Benutzer `gcadmin`) |
| `CACHE_DIR` | Ordner für den [Zwischenspeicher](05-funktionen.md#zwischenspeicher), am besten auf einem USB-Datenträger |

Ein falscher Wert steht danach in `STATUS.txt`. Alle Einträge erklärt die
[Pi-Anleitung im Gateway-Repository](https://github.com/CallMeTechie/gatecontrol-gateway/blob/main/docs/deployment/raspberry-pi.md#settingstxt-wlan-zeitzone-ssh).

**Updates:** Das Image hat das Auto-Update schon eingebaut. Du musst nichts einrichten.

**Zigbee:** Erkennt der Pi ein RaspBee II oder ConBee, startet er deCONZ mit.
Öffne dann Phoscon (`http://<IP-des-Pi>:8090`) und setze **sofort** ein Passwort.

## 3.4 Linux-Rechner mit Docker

Du brauchst einen Linux-Rechner mit Docker und Docker Compose im selben Netz
wie deine Geräte. Das WireGuard-Kernelmodul muss vorhanden sein (Standard bei
Debian 11+ und Ubuntu 22.04+).

### Schritte

1. Wähle im Assistenten „Anderer Linux-Rechner“ und klicke „Gateway anlegen und weiter“.
2. „Netzwerkmodus“: **„Host (empfohlen)“**. Nur damit gehen L4-Routen,
   Wake-on-LAN, Edge-Plugins und die Funktionen aus Kapitel 5.
3. Lade die drei Dateien herunter: `docker-compose.yml`, `gateway.env`, `update.sh`.
4. Bring die Dateien auf den Linux-Rechner (z. B. mit `scp` in dein
   Home-Verzeichnis) und lege den Ordner an:

   ```bash
   sudo mkdir -p /opt/gatecontrol-gateway/config /opt/gatecontrol-gateway/gateway-state /opt/gatecontrol-gateway/gateway-cache
   cd /opt/gatecontrol-gateway
   sudo mv ~/docker-compose.yml ~/update.sh .
   sudo mv ~/gateway.env config/
   sudo chmod 600 config/gateway.env
   sudo chmod +x update.sh
   ```

5. Starte das Gateway:

   ```bash
   cd /opt/gatecontrol-gateway
   sudo docker compose up -d
   ```

6. **Automatische Updates (einmalig, empfohlen):** Öffne `sudo crontab -e` und
   füge die Zeile aus dem Assistenten ein:

   ```
   * * * * * PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=/opt/gatecontrol-gateway/gateway-state GC_GW_COMPOSE_DIR=/opt/gatecontrol-gateway bash /opt/gatecontrol-gateway/update.sh
   ```

7. Klicke im Assistenten „Container läuft – weiter“.

**Prüfen:**

- `sudo docker compose ps` zeigt `gateway`, `edge` und `mqtt` als laufend.
- Der Assistent zeigt „Gateway hat sich gemeldet“ und „Tunnel steht“.
- Wenn nicht: `sudo docker compose logs gateway` nennt den Grund.

## 3.5 Proxmox

Du brauchst Proxmox VE 8 oder neuer und die Shell des Hosts (Weboberfläche → Knoten → „Shell“).

1. Wähle im Assistenten „Proxmox“ und klicke „Gateway anlegen und weiter“.
2. Kopiere den angezeigten Befehl und führe ihn in der Proxmox-Shell aus. Er
   legt einen LXC-Container mit dem Gateway an und koppelt ihn mit einem
   Einmal-Code. Der Code gilt 10 Minuten; mit „Neuen Code erzeugen“ bekommst du einen neuen.
3. Warte 1–3 Minuten.

Dieser Weg installiert das Gateway **ohne Docker**. Edge-Plugins und der
MQTT-Broker brauchen den Edge-Container und laufen dort deshalb nicht. Wer sie
braucht, nimmt in einer VM den Weg [3.4](#34-linux-rechner-mit-docker).

**Prüfen:** Der Assistent zeigt „Gateway hat sich gemeldet“.

## 3.6 Standorte

Ein Standort sagt, wo ein Gateway steht – zum Beispiel „Zuhause“, „Büro“ oder
„Eltern“. Mit mehreren Gateways an verschiedenen Orten behältst du so den
Überblick. Ein Standort hat einen Namen und auf Wunsch eine Adresse (Straße,
PLZ, Ort, Land). Die Peer-Gruppe eines Gateways ist etwas anderes und bleibt,
wie sie ist (änderbar im Gateway unter „Mehr“ → „Name und Gruppe ändern …“,
siehe [3.7](#37-gateway-verwalten)).

**Standorte anlegen und ändern:**

1. „Geräte“ → „Gateways“ → oben „Standorte“.
2. „Neuer Standort“: Name eingeben, die Adresse ist freiwillig. „Standort anlegen“.
3. Mit dem Stift änderst du einen Standort, mit dem Papierkorb löschst du ihn.
   Stehen dort noch Gateways, fragt GateControl nach. Die Gateways bleiben,
   wie sie sind, und stehen danach unter „Ohne Standort“.

**Den Standort eines Gateways festlegen:**

- beim Anlegen im Assistenten (Schritt 1, siehe [3.1](#31-der-assistent-gateway-hinzufügen)), oder
- im Gateway: „Mehr“ → „Standort ändern …“, in der Übersicht in der Karte
  „Gerät & Software“ bei „Standort“ oder über den Standort oben unter dem Namen.
  Ist das Gateway in einem Pool, kannst du den Standort mit
  „Auch für … übernehmen“ gleich für den Pool-Partner setzen.

**Die Liste nach Standort:** Sobald es einen Standort gibt, ordnet die Seite
„Gateways“ die Gateways nach Standort – je Standort ein Abschnitt mit Adresse
und „x von y online“, „Ohne Standort“ zuletzt. Mit „Gruppieren nach:
Standorte | Pools“ wechselst du zur Ansicht nach Pools; dort steht der
Standort auf jeder Karte. Der Browser merkt sich deine Wahl. Standorte ohne
Gateway stehen nur im Dialog „Standorte“.

Standorte verwalten nur Admins. Sie stecken in der Sicherung und kommen mit
der Wiederherstellung zurück.

**Prüfen:** Unter „Gateways“ steht dein Gateway im Abschnitt seines Standorts.

## 3.7 Gateway verwalten

Gateways verwaltest du nur noch auf der Seite „Gateways“ – die Seite
„Peers / Clients“ zeigt ausschließlich Geräte wie Handys und Laptops. Öffne
„Geräte“ → „Gateways“, klicke auf dein Gateway und dann oben rechts auf
„Mehr“. Unter „Verwalten“ findest du:

- **Name und Gruppe ändern …** – Name, Beschreibung und Peer-Gruppe.
- **Verbindungsdaten neu erzeugen …** – öffnet den Assistenten bei
  Schritt 3 mit den Dateien für dein Gerät. Hat sich das Gateway schon einmal
  gemeldet, fragt GateControl vorher: Mit neuen Daten verliert das laufende
  Gateway die Verbindung, bis es die neue Datei bekommt.
- **Proxy-Port ändern …** – der Port, auf dem das Gateway im Tunnel Anfragen
  annimmt (Standard 8080; auf einer Synology z. B. 18080, wenn 8080 belegt ist).
- **Deaktivieren …** – trennt den Tunnel. Routen über dieses Gateway sind
  dann nicht erreichbar. Das Gateway steht danach unten auf der Seite unter
  „Deaktivierte Gateways“; dort schaltest du es mit „Aktivieren“ wieder ein.
- **Gateway entfernen …** – zeigt, welche Routen dadurch abgeschaltet werden,
  und will zur Sicherheit die Tunnel-IP des Gateways. Die Routen bleiben
  erhalten (deaktiviert) und lassen sich später auf ein anderes Gateway umlenken.

**Prüfen:** Nach „Name und Gruppe ändern …“ steht der neue Name in der Karte
und in der Liste der Gateways.

Weiter mit [Kapitel 4: Edge-Plugins und Smart Home](04-edge-und-smart-home.md).
