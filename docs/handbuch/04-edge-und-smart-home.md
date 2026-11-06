# 4. Edge-Plugins und Smart Home

[← Gateway einrichten](03-gateway-einrichten.md) · [Inhaltsverzeichnis](README.md) · [Weiter: Funktionen der Heim-Gateways →](05-funktionen.md)

## Was ist Edge?

Manche Plugins – zum Beispiel **Smart Home** – brauchen einen Teil, der direkt
in deinem Heimnetz läuft. Er findet dort Geräte wie Shelly oder Tasmota und
spricht mit ihnen. Diesen Teil nennt GateControl **Edge-Teil**.

Edge-Teile laufen auf dem Gateway in einem eigenen, abgeschotteten Container
namens `edge`. Er erreicht nur dein Heimnetz und GateControl – nicht das
Internet und nicht den Tunnel. Dazu kommt ein lokaler **MQTT-Broker** im
Container `mqtt`, bei dem sich Geräte direkt im Heimnetz melden, ohne Cloud.

Solange du Edge nicht einschaltest, sind beide Container untätig.

### Voraussetzungen

- Gateway-Version **1.19.0** oder neuer.
- Ein Gateway mit Docker im **Host-Netzwerkmodus**: Synology-Paket aus dem
  Assistenten, Raspberry-Pi-Image oder Linux mit „Host (empfohlen)“.
  Im Bridge-Modus und mit dem Proxmox-Installer gibt es keinen Edge-Container.
- In der Compose-Datei stehen die Dienste `edge` und `mqtt`. Bei Gateways aus
  dem aktuellen Assistenten ist das so. Ältere Compose-Dateien bringst du mit
  [Kapitel 6](06-gateway-aktualisieren.md) auf den Stand.
- Auf der Synology: das Kernel-Modul `xt_owner` (siehe [Netzgrenze fehlt](#netzgrenze-fehlt)).

## 4.1 Edge einschalten

1. Installiere das Plugin, zum Beispiel „Smart Home“: „Einstellungen“ → „Plugins“.
2. Öffne „Netzwerk“ → „Gateways“ und klicke auf dein Gateway.
3. Wechsle in den Reiter „Edge-Plugins“.
4. Klicke „Edge einschalten“.
5. Schau auf die Zeile oben im Reiter:
   - „Verbunden seit …“ – der Edge-Container hat Verbindung zu GateControl.
   - „Netzgrenze aktiv (iptables)“ oder „Netzgrenze aktiv (nft)“ – die Abschottung steht.
6. Unter „Plugins mit Edge-Teil“ schaltest du das Plugin ein. Es öffnet sich
   ein Fenster mit den Fähigkeiten, die der Edge-Teil bekommt. Lies sie und
   klicke „Zustimmen und einschalten“.

**Prüfen:** Beim Plugin steht „läuft“. Statt „Verbunden seit …“ steht dort ein
Grund? Dann hilft [4.4](#44-statusmeldungen-und-was-hilft).

## 4.2 MQTT-Broker einschalten

Nur nötig, wenn Geräte wie Shelly, Tasmota oder ESPHome über MQTT melden sollen.

1. Im Gateway den Reiter „MQTT“ öffnen.
2. Den Schalter bei „MQTT-Broker im Heimnetz“ einschalten. Der Broker startet
   erst, wenn Edge eingeschaltet ist.
3. Unter „Konten“ für **jedes Gerät ein eigenes Konto** anlegen. Anonyme
   Zugriffe sind gesperrt.
4. Im Gerät die angezeigte „Adresse“ (Port 1883) und das Konto eintragen.

**Prüfen:** Der „Status“ zeigt „läuft“, und die Zahl der verbundenen Clients steigt.

## 4.3 Wo erscheinen meine Geräte?

Die Geräte erscheinen **im Plugin**, also links unter „Integrationen“ →
„Smart Home“ – nicht auf der Gateway-Seite. Die Gateway-Seite zeigt nur, ob
der Edge-Teil läuft, und hat sein „Protokoll“.

### Zigbee mit deCONZ (Raspberry Pi)

Hat dein Pi ein RaspBee II oder einen ConBee, bietet der Assistent in Schritt 4
„Im Smart Home einbinden“ an. GateControl legt dann eine interne Route zu
deCONZ an (nur über das VPN erreichbar) und gibt sie dem Smart-Home-Plugin.
Danach im Plugin „Gateway verbinden“ wählen und in Phoscon „Gateway entsperren“.

**Prüfen:** Im Smart-Home-Plugin erscheinen die Zigbee-Geräte.

## 4.4 Statusmeldungen und was hilft

Steht im Reiter „Edge-Plugins“ statt „Verbunden seit …“ einer der folgenden
Gründe, gehst du so vor. Neben dem Grund steht auch ein Link „Anleitung“.

### Gateway offline

Das Gateway meldet sich gar nicht mehr. Der Edge-Teil startet, sobald es wieder da ist.

1. Hat das Gerät Strom und Netz?
2. Läuft der Container `gateway`? (Synology: Container Manager → „Container“;
   Linux: `sudo docker compose ps`; Pi: `bootfs/gatecontrol/STATUS.txt`.)
3. Sieh ins Protokoll des Containers `gateway` (siehe [Kapitel 7](07-faq.md#wo-finde-ich-die-protokolle)).

**Prüfen:** Auf der Karte des Gateways steht es wieder als online.

### Edge-Dienst fehlt

Das Gateway läuft, aber in seiner Compose-Datei fehlt der Dienst `edge` (oder
beim Dienst `gateway` das Volume `edge-run`). Das ist typisch für Gateways, die
vor Edge eingerichtet wurden.

- **Synology / Linux:** Bring die Compose-Datei auf den aktuellen Stand. Unter
  der Meldung steht der Knopf „Nur docker-compose.yml herunterladen“: Er holt
  die aktuelle Datei ohne neue Schlüssel und zeigt, wie du sie einsetzt
  (Synology: Ordner `gateway-cache` anlegen, Projekt stoppen, YAML ersetzen,
  Projekt neu erstellen). Ausführlich: [Kapitel 6](06-gateway-aktualisieren.md).
- **Raspberry-Pi-Image:** In `settings.txt` steht `EDGE=off`. Ändere es auf
  `EDGE=on` und starte den Pi neu.

**Prüfen:** Der Grund verschwindet, „Verbunden seit …“ erscheint.

### Edge-Container läuft nicht

Der Dienst `edge` ist eingerichtet, meldet sich aber nicht.

1. Läuft der Container `edge`? Synology: Container Manager → „Container“ →
   `…-edge-1`. Linux: `sudo docker compose ps`.
2. Sieh in sein Protokoll (Container Manager oder `sudo docker compose logs edge`).
3. Fehlt beim Dienst `gateway` das Volume `edge-status`, bleibt die Meldung
   ebenfalls aus. Dann hilft [Kapitel 6](06-gateway-aktualisieren.md).

**Prüfen:** `…-edge-1` läuft und ist nach etwa einer Minute „gesund“.

### Netzgrenze fehlt

Das Gateway konnte die Firewall-Regeln für den Edge-Container nicht setzen.
Ohne sie startet kein Edge-Teil. Das Gateway selbst (Routen, Tunnel) arbeitet
normal weiter.

Meist fehlt dem Kernel der „Owner-Match“. Auf der Synology ist das das Modul `xt_owner`.

1. Öffne das Protokoll des Containers `gateway` und such nach `edge fence`.
   Steht dort `iptables owner match:`, fehlt `xt_owner`.
2. Melde dich per SSH an der NAS an und prüfe:

   ```bash
   lsmod | grep xt_owner
   ls /lib/modules/xt_owner.ko
   ```

3. Ist die Datei da, aber das Modul nicht geladen, lade es:

   ```bash
   sudo insmod /lib/modules/xt_owner.ko
   ```

4. Damit das einen Neustart übersteht: „Systemsteuerung“ → „Aufgabenplaner“ →
   „Erstellen“ → „Ausgelöste Aufgabe“ → „Benutzerdefiniertes Skript“, Ereignis
   „Hochfahren“, Benutzer `root`, Befehl `insmod /lib/modules/xt_owner.ko`.
5. Nach spätestens 30 Sekunden setzt das Gateway die Regeln.

Bringt DSM das Modul nicht mit, laufen auf dieser NAS keine Edge-Teile. Lass
Edge für dieses Gateway dann aus.

**Prüfen:** Im Reiter steht „Netzgrenze aktiv (iptables)“; im Protokoll von
`gateway` steht `edge fence: rules active`.

### Edge erreicht GateControl nicht

Der Edge-Container läuft, kommt aber nicht zum Server durch.

1. Ist der Server vom Gateway aus unter der Adresse aus `gateway.env`
   (`GC_SERVER_URL`, das ist deine `GC_BASE_URL`) erreichbar?
2. Steht vor GateControl ein weiterer Reverse Proxy (z. B. nginx, Traefik oder
   ein CDN)? Dann muss er **WebSocket-Verbindungen** zu
   `/api/v1/gateway/edge/ws` durchlassen. Ohne zusätzlichen Proxy ist nichts zu tun.
3. Hinweise stehen im Protokoll des Containers `edge`.

**Prüfen:** „Verbunden seit …“ erscheint.

Weiter mit [Kapitel 5: Funktionen der Heim-Gateways](05-funktionen.md).
