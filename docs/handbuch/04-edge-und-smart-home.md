# 4. Edge-Plugins und Smart Home

[← Gateway einrichten](03-gateway-einrichten.md) · [Inhaltsverzeichnis](README.md) · [Weiter: Funktionen der Heim-Gateways →](05-funktionen.md)

## Was ist Edge?

Manche Plugins – zum Beispiel **Smart Home** – brauchen einen Teil, der direkt
in deinem Heimnetz läuft. Er findet dort Geräte wie Shelly oder Tasmota und
spricht mit ihnen. Diesen Teil nennt GateControl **Edge-Teil**.

Edge-Teile laufen auf dem Gateway in einem eigenen, abgeschotteten Container
namens `edge`. Er hat **kein eigenes Netz**: Was er braucht, erledigt der
Container `gateway` für ihn und prüft dabei jede Anfrage. So erreicht ein
Edge-Teil nur Geräte in deinem Heimnetz und GateControl – nicht das Internet
und nicht den Tunnel. Firewall-Regeln oder Kernel-Module braucht es dafür nicht. Dazu kommt ein lokaler **MQTT-Broker** im
Container `mqtt`, bei dem sich Geräte direkt im Heimnetz melden, ohne Cloud.

Solange du Edge nicht einschaltest, sind beide Container untätig.

### Voraussetzungen

- Gateway-Version **1.23.0** oder neuer (Edge ohne Netz; ab 1.19.0 geht Edge
  nur mit Netzgrenze, siehe [Compose-Datei veraltet](#compose-datei-veraltet)).
- Ein Gateway mit Docker im **Host-Netzwerkmodus**: Synology-Paket aus dem
  Assistenten, Raspberry-Pi-Image oder Linux mit „Host (empfohlen)“.
  Im Bridge-Modus und mit dem Proxmox-Installer gibt es keinen Edge-Container.
- In der Compose-Datei stehen die Dienste `edge` und `mqtt`, `edge` mit
  `network_mode: none`. Bei Gateways aus dem aktuellen Assistenten ist das so.
  Ältere Compose-Dateien ersetzt du über den Knopf „Nur docker-compose.yml
  herunterladen“ ([Kapitel 6](06-gateway-aktualisieren.md)) – auch auf der
  Synology ist dafür nichts per SSH nötig.

## 4.1 Edge einschalten

1. Installiere das Plugin, zum Beispiel „Smart Home“: „Einstellungen“ → „Plugins“.
2. Öffne „Geräte“ → „Gateways“ und klicke auf dein Gateway.
3. Wechsle in den Reiter „Edge-Plugins“.
4. Klicke „Edge einschalten“.
5. Schau auf die Zeile oben im Reiter:
   - „Verbunden seit …“ – der Edge-Container hat Verbindung zu GateControl.
   - „Edge ohne Netzwerk (isoliert)“ – die Abschottung steht. Bei einer älteren
     Compose-Datei steht hier „Netzgrenze aktiv (iptables)“ bzw. „(nft)“.
6. Unter „Plugins mit Edge-Teil“ schaltest du das Plugin ein. Es öffnet sich
   ein Fenster mit den Fähigkeiten, die der Edge-Teil bekommt. Lies sie und
   klicke „Zustimmen und einschalten“.

**Prüfen:** Beim Plugin steht „läuft“. Statt „Verbunden seit …“ steht dort ein
Grund? Dann hilft [4.4](#44-statusmeldungen-und-was-hilft).

### Zusätzliche Rechte (optional)

Manche Plugins brauchen ein Recht nur für eine bestimmte Funktion – das
Smart-Home-Plugin etwa die MQTT-Themen `zigbee2mqtt/#`, wenn du Zigbee2MQTT
nutzt. Solche Rechte fragt das Plugin erst an, wenn es sie braucht. Ab
GateControl **1.317.0** gilt:

- Der Edge-Teil läuft **ohne** diese Rechte weiter. Ein Update, das nur ein
  neues zusätzliches Recht mitbringt, schaltet nichts aus – Shelly, Tasmota &
  Co. laufen weiter.
- Fragt das Plugin an, steht im Aktivitätsprotokoll „Plugin … asks for an
  additional capability on gateway …“ mit dem Weg zur Bestätigung (höchstens
  einmal am Tag je Gateway und Recht).
- Beim Plugin im Reiter „Edge-Plugins“ steht der Abschnitt „Zusätzliche
  Rechte (optional)“: je Recht „bestätigt“, „angefragt“ oder „nicht
  bestätigt“, dazu „Bestätigen“ bzw. „Entziehen“. Ein bestätigtes Recht gilt
  nur für dieses Gateway.
- Hat ein Plugin mehrere zusätzliche Rechte (z. B. Tuya: TCP ins Heimnetz,
  UDP-Broadcast und die UDP-Ports 6666, 6667, 7000), steht unter der Liste der
  Schalter „Alle bestätigen“ mit „(x von y bestätigt)“. Einschalten bestätigt
  nach einer Rückfrage alle noch offenen Rechte auf einmal; der Schalter steht
  auf „an“, sobald alle bestätigt sind. Ausschalten entzieht alle wieder. Die
  Knöpfe je Recht bleiben – du kannst danach auch einzelne wieder entziehen.
- „Entziehen“ nimmt das Recht beim nächsten Abgleich wieder heraus; das Gateway
  beendet dann die Abos des Plugins auf diesen Themen.

Damit ein bestätigtes MQTT-Thema am Gateway wirkt, braucht das Gateway eine
Version, die zusätzliche Rechte aus dem Plugin-Paket kennt. Ältere Gateways
lassen das Plugin normal laufen, verweigern aber das zusätzliche Thema.

**Prüfen:** Beim Recht steht „bestätigt“, und die Funktion im Plugin
(z. B. Zigbee2MQTT-Geräte) erscheint.

## 4.2 MQTT-Broker einschalten

Nur nötig, wenn Geräte wie Shelly, Tasmota oder ESPHome über MQTT melden sollen.

1. Im Gateway den Reiter „MQTT“ öffnen.
2. Den Schalter bei „MQTT-Broker im Heimnetz“ einschalten. Der Broker startet
   erst, wenn Edge eingeschaltet ist.
3. Unter „Konten“ für **jedes Gerät ein eigenes Konto** anlegen. Anonyme
   Zugriffe sind gesperrt.
4. Im Gerät die angezeigte „Adresse“ (Port 1883) und das Konto eintragen.

**Prüfen:** Der „Status“ zeigt „läuft“, und die Zahl der verbundenen Clients steigt.

### Verschlüsselt verbinden (TLS, Port 8883)

Im Heimnetz reicht meist Port 1883. Wer die Verbindung verschlüsseln will,
schaltet im Reiter „MQTT“ bei **„Verschlüsselt verbinden (TLS)“** den Schalter
„TLS auf Port 8883“ ein – pro Gateway, Standard ist aus.

- Port 8883 kommt **zusätzlich**; Port 1883 bleibt offen. Geräte ohne TLS laufen
  also weiter.
- Das Gateway erzeugt das Zertifikat selbst (selbst signiert). Es bleibt über
  Neustarts und Updates gleich.
- Die Karte zeigt danach den **Fingerabdruck (SHA-256)** und „Zertifikat (PEM)
  kopieren“. Geräte, die das Zertifikat prüfen, bekommen den Fingerabdruck oder
  das Zertifikat als „eigene CA“ hinterlegt. Als Server im Gerät die Adresse des
  Gateways mit Port 8883 eintragen.

**Kann mein Gerät das?** Viele Shelly- und Tasmota-Geräte können kein TLS oder
nur mit Aufwand: Shelly der ersten Generation gar nicht, neuere Shelly mit
hochgeladenem Zertifikat („User CA“), Tasmota meist nur mit einer Firmware, die
TLS enthält. Im Zweifel bleibt das Gerät auf Port 1883.

Steht dort **„Gateway-Update nötig“**, ist das Gateway zu alt, um das Zertifikat
selbst zu erzeugen – der Schalter ist dann ausgegraut. Nach dem
[Update](06-gateway-aktualisieren.md) lässt er sich einschalten.

#### Mit dem Gerätezertifikat

Gibt GateControl das Gerätezertifikat an dieses Gateway weiter (Einstellungen ›
VPN & Netzwerk › Zertifikat für die Namen › an Geräte weitergeben, Gateway
anhaken), kann Port 8883 statt des selbst erzeugten dieses Zertifikat nehmen:
Schalter **„Gerätezertifikat verwenden“** in derselben Karte, pro Gateway,
Standard aus. Den Schalter gibt es ab Gateway 1.44.0.

- Der Broker heißt dann `mqtt-<Name des Gateways>.geraete.<Zone>`, z. B.
  `mqtt-gw-keller.geraete.vpn.example.com`. Die Karte zeigt die Adresse mit Port
  8883 zum Kopieren. Pro Gateway ein eigener Name, genau eine Ebene unter dem
  Geräte-Bereich – nur die deckt das Wildcard ab.
- Clients prüfen Kette und Namen wie bei einer Website und brauchen weder
  Fingerabdruck noch eigenes Zertifikat.
- Erreichbar im Heimnetz (LAN-Adresse) und im VPN (Tunnel-Adresse des Gateways).
  **Den Namen müssen die Clients auflösen können:** im VPN über das DNS von
  GateControl (der Name zeigt nur bei eingeschaltetem Schalter auf die
  Tunnel-Adresse), im Heimnetz muss ihn der DNS des Routers kennen (Eintrag auf
  die LAN-Adresse des Gateways).
- Das Zertifikat wird automatisch erneuert; der Broker übernimmt es ohne
  Neustart, verbundene Geräte bleiben verbunden. Fehlt es, läuft es ab oder wird
  die Weitergabe beendet, nimmt das Gateway wieder das selbst erzeugte (mit dem
  bisherigen Fingerabdruck).
- Geräte, die den Fingerabdruck des selbst erzeugten hinterlegt haben, verbinden
  sich mit eingeschaltetem Schalter nicht mehr – sie brauchen dann den Namen statt
  des Fingerabdrucks.
- Hinweise in der Karte: Weitergabe fehlt, kein Name im Geräte-Bereich, ein Gerät
  heißt schon `mqtt-<Name>` (das Gerät behält seinen Namen), TLS aus, oder eine
  TCP-Route belegt Port 8883 an der Tunnel-Adresse (dann nur im Heimnetz).

**Geräte umstellen.** Mit eingeschaltetem Schalter gibt es zwei Arten von Geräten:

- **Geräte, die das Zertifikat prüfen** (Kette und Namen, z. B. Home Assistant,
  Node-RED, die meisten Apps): Adresse auf den Namen
  `mqtt-<Name des Gateways>.geraete.<Zone>` mit Port **8883** ändern und die
  Standard-CA (die eingebauten Stammzertifikate) verwenden – kein eigenes
  Zertifikat, kein Fingerabdruck.
- **Geräte, die nur einen festen Fingerabdruck prüfen können** (viele kleine
  Smart-Home-Geräte): Unterschalter **„Zweiter Port für Geräte mit Fingerabdruck
  (8884)“** einschalten (Standard aus, ab Gateway 1.45.0). Port 8884 hat dann das
  selbst erzeugte Zertifikat mit dem bisherigen Fingerabdruck; im Gerät ändert
  man **nur den Port von 8883 auf 8884**, Adresse und Fingerabdruck bleiben. Die
  Karte zeigt die Zeile „Port 8884 – selbst erzeugtes Zertifikat“ mit dem
  Fingerabdruck (SHA-256) und dem Zertifikat (PEM) zum Kopieren.
- Port 8884 gibt es nur, solange Port 8883 das Gerätezertifikat hat. Fällt das
  Gateway auf das selbst erzeugte zurück, hat 8883 wieder den alten Fingerabdruck
  und 8884 entfällt. Die Erneuerung des Gerätezertifikats trennt Verbindungen auf
  8884 nicht.

## 4.3 Wo erscheinen meine Geräte?

Die Geräte erscheinen **im Plugin**, also links unter „Zuhause“ →
„Smart Home“ – nicht auf der Gateway-Seite. Die Gateway-Seite zeigt nur, ob
der Edge-Teil läuft, und hat sein „Protokoll“.

### Zigbee mit deCONZ (Raspberry Pi)

Hat dein Pi ein RaspBee II oder einen ConBee, bietet der Assistent in Schritt 4
„Im Smart Home einbinden“ an. GateControl legt dann eine interne Route zu
deCONZ an (nur über das VPN erreichbar) und gibt sie dem Smart-Home-Plugin.
Danach im Plugin „Gateway verbinden“ wählen. Mit Gateway 1.25.0+ gibt GateControl
deCONZ dabei kurz selbst frei – „Gateway entsperren“ in Phoscon ist dann nicht nötig.
Dasselbe geht im Reiter „Funk“ des Gateways, dort schaltest du Zigbee auch ein und aus
und lernst Geräte an ([Kapitel 5](05-funktionen.md#funk-zigbee-bluetooth-thread)).

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

### Compose-Datei veraltet

Die Compose-Datei stammt von vor Gateway 1.23.0: Der Container `edge` läuft
dort noch im Netz des Hosts und braucht deshalb eine Netzgrenze aus
Firewall-Regeln. Die konnte das Gateway nicht setzen – auf der Synology fehlt
dem Kernel meist das Modul `xt_owner`. Ohne sie startet kein Edge-Teil. Das
Gateway selbst (Routen, Tunnel) arbeitet normal weiter.

Die Lösung ist die aktuelle Compose-Datei, in der `edge` gar kein Netz hat:

1. Unter der Meldung auf „Nur docker-compose.yml herunterladen“ klicken.
2. Wie dort angezeigt einsetzen (Synology: Ordner `gateway-cache` anlegen,
   Projekt stoppen, YAML ersetzen, Projekt neu erstellen). Ausführlich:
   [Kapitel 6](06-gateway-aktualisieren.md).

Beim **Raspberry-Pi-Image** kommt die Meldung praktisch nicht vor (der Pi kann
die Netzgrenze setzen). Sonst hilft ein frisch geschriebenes, aktuelles Image.

**Prüfen:** Im Reiter steht „Edge ohne Netzwerk (isoliert)“, die Edge-Teile laufen.

### Netzgrenze fehlt

Dieselbe Lage bei einem Gateway **älter als 1.23.0**: Aktualisiere zuerst das
Gateway (Auto-Update oder [Kapitel 6](06-gateway-aktualisieren.md)) und hole
dann wie unter [Compose-Datei veraltet](#compose-datei-veraltet) die aktuelle
Compose-Datei. Ein Kernel-Modul von Hand zu laden ist nicht mehr nötig.

**Prüfen:** Im Reiter steht „Edge ohne Netzwerk (isoliert)“.

### Edge erreicht GateControl nicht

Der Edge-Container läuft, kommt aber nicht zum Server durch.

1. Ist der Server vom Gateway aus unter der Adresse aus `gateway.env`
   (`GC_SERVER_URL`, das ist deine `GC_BASE_URL`) erreichbar?
2. Steht vor GateControl ein weiterer Reverse Proxy (z. B. nginx, Traefik oder
   ein CDN)? Dann muss er **WebSocket-Verbindungen** zu
   `/api/v1/gateway/edge/ws` durchlassen. Ohne zusätzlichen Proxy ist nichts zu tun.
3. Der Container `edge` verbindet sich über den Container `gateway`: Hinweise
   stehen im Protokoll von `gateway` (Stichwort `edge relay`) und von `edge`.

**Prüfen:** „Verbunden seit …“ erscheint.

## 4.5 Handbuch und Einrichtungshinweise der Plugins

Ab GateControl **1.241.0** bringt jedes Plugin, das eines hat, sein eigenes
Handbuch mit: Einstellungen → Plugins → *Plugin* → Reiter „Handbuch“. Dort
steht, was das Plugin kann, was es voraussetzt, wie du es Schritt für Schritt
einrichtest (auch Schritte außerhalb von GateControl, etwa die Compose-Datei
oder Einstellungen an einer Kamera), Berechtigungen, häufige Fragen und was in
der installierten Version neu ist. Links zeigen auf Abschnitte, das
Inhaltsverzeichnis steht neben dem Text (auf dem Handy darüber). Das Handbuch
kommt mit jedem Plugin-Update neu.

Braucht ein Plugin nach der Installation oder einem Update **deine Hilfe**,
zeigt GateControl einen gelben Hinweis:

- oben auf der Plugin-Seite (auf jedem Reiter) mit „Im Handbuch nachlesen“
  und „Erledigt“,
- als „Handeln nötig“ am Plugin in der Liste „Meine Plugins“,
- als „Plugins brauchen deine Hilfe“ auf dem Dashboard.

Manche Hinweise erledigen sich selbst: Fehlt einem Gateway zum Beispiel der
Dienst `kameras`, nennt der Hinweis das Gateway und bietet „docker-compose.yml
herunterladen“ an; sobald der Dienst läuft, verschwindet er. Andere klickst du
nach getaner Arbeit auf „Erledigt“ – das steht mit deinem Namen im
Aktivitätsprotokoll.

**Prüfen:** Auf dem Dashboard steht kein „Plugins brauchen deine Hilfe“ mehr.

Weiter mit [Kapitel 5: Funktionen der Heim-Gateways](05-funktionen.md).
