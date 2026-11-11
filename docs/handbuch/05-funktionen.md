# 5. Funktionen der Heim-Gateways

[← Edge-Plugins und Smart Home](04-edge-und-smart-home.md) · [Inhaltsverzeichnis](README.md) · [Weiter: Bestehendes Gateway aktualisieren →](06-gateway-aktualisieren.md)

Ein Gateway kann mehr als nur den Tunnel. Alle Funktionen findest du so:

1. „Geräte“ → „Gateways“ → auf dein Gateway klicken.
2. Reiter „Funktionen“ (die Zahl daneben sagt, wie viele an sind).

Dort schaltest du jede Funktion ein oder aus, nach Bereichen geordnet
(„Heimnetz im Blick“, „Geräte im Heimnetz“, „Für das ganze Heimnetz“,
„Internet & Strom“, „Erweiterungen“, „System“). Oben steht, wie viel Speicher das Gateway mit
den eingeschalteten Funktionen ungefähr braucht. Die Übersicht des Gateways
zeigt in der Karte „Funktionen“ nur, was an und was aus ist; „Verwalten“
führt in den Reiter. Reiter einer ausgeschalteten Funktion stehen blass mit
„· aus“ da und lassen sich trotzdem öffnen.

Gateway-Pools (mehrere Gateways im selben Netz, die füreinander einspringen)
findest du ebenfalls unter „Gateways“: als eigene Gruppe in der Liste, mit
„Pool anlegen“ oben rechts und „Pool öffnen“ für die Einstellungen. Eine
eigene Seite „Gateway-Pools“ im Menü gibt es nicht mehr.

Wo die Gateways stehen („Zuhause“, „Büro“ …), ordnest du mit „Standorte“ oben
auf derselben Seite. Sobald es einen Standort gibt, ist die Liste nach
Standorten gruppiert; „Gruppieren nach: Standorte | Pools“ wechselt zur
Ansicht nach Pools. Mehr in [Kapitel 3.6](03-gateway-einrichten.md#36-standorte).

Allgemeine Voraussetzungen:

- Netzwerk-Wächter, Internetqualität, Anwesenheit und USV brauchen
  Gateway-Version **1.21.0** oder neuer, DNS-Filter und Zwischenspeicher **1.22.0**,
  Drucken & Scannen **1.24.0** (PDF an Drucker ohne PDF **1.30.0**, Texterkennung und
  Office-Dateien **1.33.0**), Funk **1.25.0** (zigbee2mqtt, Thread und Sensor-Schlüssel: ein Gateway nach 1.31.0), Lokale KI **1.26.0**, Kameras **1.28.0**.
  Ist das Gateway älter, steht das im Reiter; aktualisiere es dann ([Kapitel 6](06-gateway-aktualisieren.md)).
- Das Gateway steht im Heimnetz im **Host-Netzwerkmodus** (Standard beim Pi,
  beim Synology-Paket und bei Linux mit „Host (empfohlen)“).
- Die **Zeitzone** kommt vom Server (siehe [Kapitel 2.5](02-server-einrichten.md#25-die-werte-in-der-env-die-du-wirklich-brauchst)).
  In der Karte steht bei „Ortszeit“, welche gilt. Steht dort „Der Server läuft
  in UTC“, fehlt `TZ` in der `.env` des Servers.

## Netzwerk-Wächter

**Wofür:** Findet alle Geräte im Heimnetz, meldet neue Geräte und prüft
einmal täglich nachts offene Ports.

**Einschalten:** In der Karte „Netzwerk-Wächter“ (ab Version 1.21.0 standardmäßig an).
„Offene Ports prüfen“ kannst du einzeln abschalten. Die Geräte siehst du im Reiter „Netzwerk“.

**Prüfen:** Im Reiter „Netzwerk“ erscheinen deine Geräte.

## Internetqualität

**Wofür:** Misst jede Minute Ping und Verlust, nach Plan die Geschwindigkeit,
und erkennt Ausfälle mit Ursache.

**Einschalten:** In der Karte „Internetqualität“ (standardmäßig an). Im Reiter
„Internet“ stellst du bei „Geschwindigkeit messen“ ein: „nie automatisch“,
„4× täglich“ oder „stündlich“. Stündlich braucht viel Datenvolumen.

**Datenvolumen:** Je Gateway sind höchstens 12 GB Messvolumen in 24 Stunden
erlaubt. Das Gateway merkt sich seinen Verbrauch selbst (Gateway ab der Fassung
mit dem Tagesbudget) – er geht also weder bei einem Neustart des Gateways noch
bei einem Update des Servers verloren. Ist das Budget aufgebraucht, steht in
der Karte „Geschwindigkeit“, ab wann wieder gemessen wird. Bei „stündlich“
wird jede Messung auf rund 200 MB je Richtung gekürzt – Download **und**
Upload; an schnellen Anschlüssen ist sie dadurch etwas ungenauer.

**Prüfen:** Im Reiter „Internet“ erscheinen Messwerte.

## Anwesenheit

**Wofür:** Erkennt zugeordnete Handys im WLAN für die Familie-Anwesenheit.

**Einschalten:** In der Karte „Anwesenheit“ (standardmäßig an). Sie braucht den
Netzwerk-Wächter. Sie wirkt nur für Personen, die im Familie-Portal selbst „Über
mein Handy im WLAN“ einschalten.

**Prüfen:** Die Person erscheint als zu Hause, wenn ihr Handy im WLAN ist.

## USV-Status

**Wofür:** Liest den Zustand einer USV (Netzbetrieb, auf Akku, Restlaufzeit)
über einen NUT-Server, zum Beispiel von der Synology.

**Einschalten:**

1. Auf der Synology: „Systemsteuerung“ → „Hardware & Energie“ → „USV“ →
   Netzwerk-USV-Server aktivieren und die IP des Gateways erlauben.
2. In GateControl bei „USV-Status“ auf „Adresse einstellen“ klicken.
3. „Adresse des USV-Servers“ (private IPv4 – in einem Heimnetz ohne IPv4 eine
   private IPv6-Adresse wie `fd00::10`), „Port“ (meist 3493) und optional
   den USV-Namen eintragen (leer = die erste USV; Synology: `ups`).
4. „Speichern und einschalten“.

**Prüfen:** Die Karte zeigt „Netzbetrieb“ und den Akkustand.

## DNS-Filter

**Wofür:** Filtert Werbung, Tracker und Schadseiten für **alle** Geräte im
Heimnetz – auch Fernseher und Konsolen. Mit Profilen und Zeiten je Person
(z. B. Bildschirmzeit für Kinder: „Internet ganz aus“ oder nur bestimmte
Kategorien zu bestimmten Zeiten).

**Voraussetzungen:** Gateway 1.22.0+. Auf dem Gerät darf kein anderer
DNS-Dienst Port 53 belegen (z. B. das Paket „DNS Server“ der Synology,
Pi-hole oder systemd-resolved).

**Einschalten:**

1. Reiter „DNS-Filter“ → „DNS-Filter einschalten“.
2. Klicke „Anleitung“ und wähle deinen Router (FRITZ!Box, Speedport, Vodafone
   Station oder anderer Router).
3. Trage im Router die angezeigte Adresse des Gateways als **DNS-Server** ein
   („Im Router als DNS-Server eintragen:“). Bei der FRITZ!Box: „Heimnetz“ →
   „Netzwerk“ → „Netzwerkeinstellungen“ → „Weitere Einstellungen“ →
   „IPv4-Einstellungen“ → „Lokaler DNS-Server“. Nutzt dein Netz IPv6, trag
   auch die IPv6-Adresse ein.
4. Ein zweites DNS-Feld im Router leer lassen oder ein zweites Gateway
   eintragen. Eine andere Adresse (z. B. 8.8.8.8) lässt Geräte am Filter vorbei.
5. WLAN der Geräte einmal aus- und wieder einschalten.
6. Profile und Zeiten legst du unter „Profile“ an. Die Zeiten gelten in der
   Zeitzone des Servers.

**Wichtig:** Ist das Gateway aus, können die Geräte im Heimnetz keine Namen mehr
auflösen – das Internet wirkt dann „weg“. Ein zweites Gateway als Reserve hilft.
Willst du den Filter wieder abschalten, leere **zuerst** das Feld im Router.

Manche Router (viele Speedport-Modelle, Vodafone Station) erlauben keinen
eigenen DNS-Server. Dann trägst du ihn an den Geräten selbst ein; die Anleitung
in GateControl erklärt das.

**Prüfen:** In der „Prüfung“ der Anleitung steht „Router zeigt auf das Gateway“.

## Drucken & Scannen

**Wofür:** Von unterwegs zu Hause drucken (die Bordkarte liegt im Ausgabefach,
wenn du heimkommst) und vom Handy aus scannen – direkt ins Drive. Drucker und
Scanner bleiben im Heimnetz; GateControl stellt sie nicht ins Internet.

**Voraussetzungen:**

- Gateway 1.24.0+. Ist es älter, steht in der Zeile „Gateway zu alt – ab 1.24.0“.
- Drucker bzw. Scanner mit AirPrint/AirScan (IPP bzw. eSCL) im selben Heimnetz –
  das sind fast alle Geräte seit etwa 2015. Ältere erscheinen nicht.
- Das Plugin „Drucken & Scannen“ (Einstellungen › Plugins › Katalog). Am
  Gerät und an der Compose-Datei musst du nichts ändern – es läuft im
  Gateway selbst. Nur „Office-Dateien drucken“ braucht einen Zusatzdienst
  (siehe unten).

**Einschalten:** Reiter „Funktionen“ → Bereich „Geräte im Heimnetz“ →
„Drucken & Scannen“ einschalten. Nach etwa einer Minute steht dort, was das
Gateway gefunden hat („Gefunden: HP OfficeJet 8020 (Drucker + Scanner)“).
„Einstellungen im Plugin“ führt zu Geräten, Berechtigungen, Verlauf und der
Ablage der Scans.

**Prüfen:** Im Plugin unter „Geräte“ „Testseite“ drucken. Ist der Drucker aus,
wartet ein Auftrag bis zu 24 Stunden und startet, sobald er wieder da ist.
Meldet ein Gerät „Zertifikat geändert“, hat sich sein Sicherheitszertifikat
geändert (z. B. nach einem Firmware-Update) – im Plugin bestätigen, dann geht
es weiter.

### Drucken vom Android-Handy

Mit der Android-App ab 1.84.0 druckst du aus jeder App auf den Druckern zu
Hause – mit und ohne VPN. Der Auftrag läuft über den Server und das Gateway zu
Hause. Dafür braucht es das Plugin „Drucken & Scannen“ ab 1.0.1 und das Recht
„drucken“.

- **Druckdienst einschalten (einmal):** Android-Einstellungen › Verbundene
  Geräte › Drucken › „GateControl“. Im Druckdialog einer App heißen die
  Drucker dann „GateControl – …“ (mit dem Namen des Druckers).
- **Teilen:** ein PDF oder Bild teilen › „Mit GateControl drucken“ – Drucker,
  Kopien, Farbe, beidseitig, „Zu Hause drucken“.
- **Keine Drucker?** In der App unter Einstellungen › Drucken › „Drucken über
  GateControl“ steht, warum (Plugin nicht für die App verfügbar, kein Recht,
  keine Verbindung).

Ist der Drucker aus, wartet der Auftrag bis zu 24 Stunden („aus – druckt,
sobald er an ist“).

### Drucker ohne PDF (z. B. HP OfficeJet Pro 8720)

Viele Tintenstrahler nehmen über das Netz kein PDF an, nur ihre eigenen
Rasterformate (PWG-Raster, Apple-Raster/URF, PCLm, JPEG). Ein Gateway ab **1.30.0**
wandelt PDF-Dateien für solche Drucker beim Drucken selbst um – passend zu
Auflösung, Farbe, Papier und beidseitigem Druck des Druckers. Das gilt für
alles, was über GateControl druckt: Portal, Android-Druckdienst, Teilen,
Testseite.

- **Schalter:** In der Zeile „Drucken & Scannen“ „PDF für Drucker ohne PDF
  umwandeln“ (Standard an). Darunter steht, welche Drucker kein PDF nehmen und
  ob dieses Gateway für sie umwandelt.
- **„… nimmt kein PDF. PDF-Dateien … wandelt ein Gateway ab 1.30.0 um“:**
  Gateway aktualisieren ([Kapitel 6](06-gateway-aktualisieren.md)). Bis dahin
  drucken dort nur Bilder; eine PDF-Datei lehnt GateControl mit genau diesem
  Grund ab.
- **„Diesem Gateway fehlt das Werkzeug …“:** Das Gateway-Image ist älter als
  seine Version – über „Update auf …“ das aktuelle Image holen.
- **Raspberry Pi 3 oder Zero:** Das Umwandeln dauert dort länger, bei großen
  PDF-Dateien ein paar Minuten. Gedruckt wird trotzdem; wer das nicht möchte,
  schaltet es für dieses Gateway aus.
- Eine kaputte oder mit Kennwort geschützte PDF-Datei kann das Gateway nicht
  umwandeln – der Auftrag schlägt dann mit diesem Grund fehl.

### Office-Dateien drucken

Word, Excel, PowerPoint, OpenDocument und RTF druckt GateControl, wenn das
Gateway vorher ein PDF daraus macht. Das braucht LibreOffice – ein großer
Zusatzdienst, deshalb nur auf Wunsch je Gateway. Reine Text-Dateien (`.txt`)
gehen immer, auch ohne ihn.

- **Voraussetzung:** Gateway ab **1.33.0** (sonst „Texterkennung … kann ein
  Gateway ab 1.33.0“).
- **Einschalten:** In der Zeile „Drucken & Scannen“ „Office-Dateien drucken“
  anhaken. Darunter steht, was es kostet: einmal ≈ 200 MB herunterladen,
  ≈ 700 MB auf dem Datenträger, beim Umwandeln bis ≈ 500 MB Arbeitsspeicher.
- **„… brauchen einmalig die aktuelle Compose-Datei“:** auf „docker-compose.yml
  herunterladen“ klicken und die Datei wie beim Einrichten übernehmen (Synology:
  Projekt neu erstellen). Der Raspberry Pi richtet den Dienst selbst ein
  („wird eingerichtet“ – beim ersten Mal ein paar Minuten).
- **„Office-Dateien gehen jetzt“:** Im Portal, in der Android-App (Teilen ›
  „Mit GateControl drucken“) und überall sonst lassen sich diese Dateien jetzt
  drucken. Die Seitenzahl steht nach dem Umwandeln im Verlauf.
- **Wenig Arbeitsspeicher (unter 2 GB) oder Raspberry Pi 3/Zero:** es geht,
  das Umwandeln dauert aber länger. Ein Hinweis, kein Verbot.
- Der Dienst hat kein Netz und keine Rechte; Makros in Dokumenten laufen nicht.

### Texterkennung für Scans

Mit „Texterkennung für Scans (durchsuchbare PDFs)“ kann man beim Scannen im
Plugin „Durchsuchbares PDF“ wählen: Das PDF im Drive hat dann unsichtbaren
Text über dem Bild – Suchen, Markieren, Kopieren gehen, und die Suche im Drive
findet das Dokument über seinen Inhalt. Erkannt werden Deutsch und Englisch.

- **Voraussetzung:** Gateway ab **1.33.0**; die Texterkennung ist im Image
  (≈ 45 MB), kein Zusatzdienst.
- **Einschalten:** In der Zeile „Drucken & Scannen“ „Texterkennung für Scans“
  anhaken. Es reicht ein Gateway damit – auch für Scanner an anderen Gateways.
- **Dauer:** auf einem PC 1–3 Sekunden je Seite, auf einem Raspberry Pi 3 oder
  Zero etwa eine Minute. Es läuft immer nur eine Texterkennung zugleich; der
  Scan selbst ist sofort da. Klappt sie nicht (zu lange, Gateway aus), legt das
  Plugin das normale PDF ab und sagt das.
- **„Diesem Gateway fehlt die Texterkennung“:** über „Update auf …“ das aktuelle
  Image holen.

### Papier, Fach und Druckstatus

Nennt ein Drucker seine Papierformate und Fächer (Gateway ab 1.33.0), kann man
im Plugin und in der Android-App A4, A5, Letter oder Fotopapier (10 × 15 cm)
wählen und – im Plugin – das Fach (z. B. „Fotofach“). Was der Drucker nicht
nennt, wird nicht angeboten; dann druckt er auf seinem Standardpapier.
Hält der Drucker beim Drucken an, steht der Grund im Verlauf und in der
Android-App („Papier fehlt“, „Klappe offen“, „Papierstau“ …); geht es weiter,
verschwindet er wieder. Drucker, die außer JPEG nur PCLm nennen (manche
HP-Modelle), bekommen PDF-Dateien jetzt als PCLm.

### Drucker wird nicht gefunden

Unter dem Schalter steht, was die letzte Suche gesehen hat („Letzte Suche
heute 12:03: mDNS-Antworten 14, Druck-/Scandienste 3, Geräte 1“); „Neu
suchen“ sucht sofort.

- **„Dieses Gateway meldet noch nicht …“:** Das Gateway ist älter als die
  verbesserte Suche – zuerst aktualisieren ([Kapitel 6](06-gateway-aktualisieren.md)).
  Ältere Versionen übersehen neben avahi/Bonjour des Hosts (Synology, QNAP)
  viele Drucker.
- **„mDNS-Antworten 0“:** Die Suche kommt nicht beim Gateway an – etwa wenn der
  Container nicht im Host-Netz läuft, das WLAN Multicast filtert oder der
  Drucker im Gäste-WLAN bzw. einem anderen VLAN steht.
- **„verworfen: anderes Subnetz“:** Der Drucker hat eine Adresse außerhalb des
  Heimnetzes des Gateways. Von sich aus spricht das Gateway nur mit Geräten im
  eigenen LAN – trag die Adresse ein (nächster Punkt).
- **Per IP-Adresse hinzufügen:** „Drucker nicht gefunden? Per IP-Adresse
  hinzufügen“ → Adresse eintragen (steht im Netzwerk-Menü am Drucker oder in
  der Geräteliste des Routers) → „Hinzufügen“ → „Speichern“. Das Gateway fragt
  das Gerät dann direkt (IPP auf Port 631 bzw. 443, eSCL auf 80 bzw. 443).
  Nur private Adressen (10.x, 172.16–31.x, 192.168.x), höchstens 16; die
  Adresse im Router am besten fest vergeben. Im Fenster steht je Adresse, ob
  das Gateway sie erreicht hat.

## Kameras

**Wofür:** Kameras im Heimnetz (z. B. Reolink, Tapo, Hikvision – alles mit ONVIF
oder RTSP) im Plugin „Tür & Kamera“: Standbilder, Live-Bild über GateControl,
Clips bei Bewegung. Ohne Hersteller-Cloud – Bilder und Clips bleiben auf dem
Gateway (bei der Synology auf der NAS).

**Voraussetzungen:**

- GateControl-Server 1.240.0+ ([Updates](02-server-einrichten.md#29-updates-einrichten)).
- Gateway 1.28.0+. Ist es älter, steht in der Zeile „Gateway zu alt – ab 1.28.0“.
- An der Kamera **ONVIF** bzw. **RTSP** einschalten:
  - Reolink: App oder Weboberfläche › Einstellungen › Netzwerk › Erweitert ›
    Server-Einstellungen › ONVIF und RTSP an (Port ONVIF meist 8000).
  - Tapo: App › Kamera › Einstellungen › Erweitert › **Kamerakonto** anlegen –
    Benutzer und Passwort dieses Kontos trägst du in GateControl ein (nicht dein
    TP-Link-Konto). ONVIF-Port 2020.
  - Andere: im Handbuch der Kamera nach „ONVIF“ oder „RTSP“ suchen.
- Das Plugin „Tür & Kamera“ (Einstellungen › Plugins › Katalog) ab 1.6.0.
- Synology/Linux: einmal die aktuelle Compose-Datei mit dem Dienst `kameras`
  (nur ffmpeg, ≈ 80 MB). Fehlt er, bietet die Zeile „docker-compose.yml
  herunterladen“ an – herunterladen, Projekt neu erstellen
  ([Kapitel 6](06-gateway-aktualisieren.md#63-synology-compose-datei-erneuern)). Ohne ihn gehen Suche,
  Testbild und Bewegungsmeldungen schon, Live-Bild und Clips noch nicht. Einen
  Ordner der NAS für die Clips wählst du in der Zeile unter „Speicherort und Netze“
  (siehe „Aufnahmen“). Das Raspberry-Pi-Image legt den Dienst selbst
  an; ältere Images (vor Gateway 1.28.0) brauchen dafür ein neues Image.

**Einschalten:** Reiter „Funktionen“ → „Geräte im Heimnetz“ → „Kameras“. Dann
im Plugin „Tür & Kamera“ › „Kamera hinzufügen“: das Gateway sucht Kameras
(„Reolink E1 Zoom · 192.168.1.73 · ONVIF – neu gefunden“) oder du gibst eine
Adresse `rtsp://…` selbst ein, dazu Name, Benutzer und Passwort der Kamera.
„Verbinden und testen“ zeigt ein Testbild; erst dann ist die Kamera gespeichert.
Das Passwort liegt verschlüsselt auf dem Server und geht nur an das Gateway.

**Kameras mit HTTPS** (Gateway 1.29.0+, GateControl 1.242.0+, Plugin 1.7.0+):
Bietet eine Kamera ONVIF nur über HTTPS an, findet das Gateway das selbst (zuletzt
Port 443) – oder du setzt beim Hinzufügen „HTTPS“. Das Zertifikat wird **immer
geprüft**. Die meisten Kameras haben ein selbst signiertes Zertifikat; dann
meldet der Test „Das Zertifikat der Kamera ist nicht vertrauenswürdig“. Nur wenn
du der Kamera in deinem Heimnetz vertraust, setze dort „Zertifikat nicht prüfen“
(je Kamera, später unter „Aufnahmen“ wieder abschaltbar). Die Verbindung bleibt
verschlüsselt und geht weiter nur an die Adresse der Kamera.

**Aufnahmen:** je Kamera „bei Bewegung (Personen, Autos, Tiere)“, „bei Bewegung,
nur wenn niemand zu Hause ist“ (aus der Anwesenheit der Familie – ist sie
unbekannt, nimmt das Gateway nicht auf) oder „nie – nur Live-Bild“. Ein Clip
beginnt 5 Sekunden vor der Bewegung und endet 10 Sekunden danach (höchstens
2 Minuten). Bewegung, Personen und Fahrzeuge erkennt die **Kamera selbst**
(ONVIF-Ereignisse) – das Gateway rechnet nichts nach. Aufbewahren 7, 14 oder
30 Tage; unter 1 GB freiem Platz nimmt das Gateway nichts Neues auf. Die Clips
liegen im Docker-Volume `cam-recordings`. **Speicherort ändern** (GateControl
1.242.0+): Zeile „Kameras“ › „Speicherort und Netze“ › „Speicherort für Clips“,
z. B. `/volume1/kameras` (den Ordner vorher in der File Station anlegen). Danach
„docker-compose.yml herunterladen“ und das Projekt neu erstellen – kein SSH, keine
`.env`. Die Zeile zeigt „Clips im Ordner /volume1/kameras“; solange das Gateway
noch den alten Speicher nutzt (Gateway 1.29.0+ meldet das), steht dort „gilt erst
mit der neuen Compose-Datei“. Auf dem Raspberry Pi bleiben die Clips auf der
SD-Karte. Eine schon gesetzte `GC_CAMERA_DIR` in der `.env` geht weiter vor.

**Live-Bild:** nur, wenn das Handy oder der PC im **VPN** ist (oder im selben
Netz wie der Server). Unterwegs ohne VPN zeigen Portal und App alle 10 Sekunden ein
neues Standbild. Im Portal spielen Safari und Edge/Chrome auf dem Handy das Bild
selbst; **Firefox** und Chrome/Edge am PC spielen es ab GateControl 1.242.0 über
den eingebauten Player (Media Source Extensions, ohne externe Bibliothek).
Kameras mit H.265 laufen in vielen Browsern nicht – dann den Unterstrom (meist
H.264) wählen. Push mit Standbild bei Personen kommt höchstens einmal pro
Kamera alle 5 Minuten, mit dem Knopf „Ansehen“; jede Person kann ihn je Kamera
für sich abschalten (Portal-Tab „Tür“ und Apps, Plugin 1.7.0+).

**Hinweise statt Verbote:** Auf einem Raspberry Pi 3 B+ steht „Kameras: höchstens
1 Kamera mit Bewegungserkennung“, auf einem Pi 4 „höchstens 4“. Einschalten
bleibt möglich. Kameras außerhalb des eigenen Heimnetzes (z. B. ein eigenes
Kamera-VLAN) erreicht das Gateway nur, wenn das Netz unter „Speicherort und
Netze“ › „Weitere Netze für die Kamera-Suche“ steht (private Netze, /16 bis /30,
höchstens 8; per API `PUT /api/v1/gateways/:id/features { cameras: { subnets } }`).

**Datenschutz:** Ton nimmt das Gateway nur auf, wenn du ihn je Kamera
einschaltest – Gespräche aufzuzeichnen ist nur mit Einverständnis aller erlaubt.
Wer welche Kamera sehen darf, legst du im Plugin unter „Berechtigungen“ fest
(Spalte „sieht“): nur diese Personen sehen sie im Portal und in der App, bekommen
den Push und finden die Clips.

## Funk (Zigbee, Bluetooth, Thread)

**Wofür:** Zigbee-Lampen, -Steckdosen und -Sensoren (IKEA, Philips Hue, Aqara …)
über einen Funkstick am Gateway, Bluetooth-Thermometer (BTHome, Shelly BLU, Xiaomi –
auch verschlüsselte) und ein Thread-Netz für Matter-Geräte. Alles schaltest du im
Reiter „Funk“ – ohne SSH und ohne `settings.txt`.

**Voraussetzungen:**

- Gateway 1.25.0+. Ist es älter, steht in der Zeile „Gateway zu alt – ab 1.25.0“.
  zigbee2mqtt, Thread und Schlüssel für verschlüsselte Sensoren brauchen ein Gateway
  **nach 1.31.0** – sonst steht im Reiter „Gateway-Update nötig“.
- Zigbee mit **deCONZ**: ein Funkmodul von dresden elektronik – ConBee II/III am USB
  oder RaspBee II auf der Pi-Leiste.
- Zigbee mit **zigbee2mqtt**: für Sticks, die deCONZ nicht spricht – Sonoff
  ZBDongle-E/-P, Home Assistant SkyConnect/ZBT-1/ZBT-2, CC2652- und EFR32-Sticks
  (ConBee geht auch). zigbee2mqtt spricht über den MQTT-Broker des Gateways; der
  Reiter bietet „Edge und MQTT einschalten“ an, wenn er noch aus ist.
- **Thread:** ein Stick mit **RCP-Firmware** (OpenThread): SkyConnect/ZBT-1, ZBT-2,
  ZBDongle-E oder ein nRF52840-Dongle.
- **Ein Stick bedient nur einen Funk.** Auf „Automatisch“ bekommt Zigbee zuerst
  einen Stick, Thread einen anderen. Steckt nur ein Multi-Stick, steht bei Thread
  „Stick belegt“. Die Liste „Funksticks“ im Reiter zeigt, welcher Stick was bedient
  und wozu er passt – und dort legst du ihn auf Wunsch von Hand fest (siehe unten).
- **Firmware:** Multi-Sticks (SkyConnect, ZBDongle-E) können Zigbee *oder* Thread –
  je nach Firmware. Das Gateway sieht die Firmware nicht; gewechselt wird im Browser
  mit dem Web-Flasher des Herstellers.
- **Synology/Linux:** die Dienste (deCONZ, zigbee2mqtt, Border Router) bringt die
  Compose-Datei mit. Fehlt einer, zeigt der Reiter „docker-compose.yml herunterladen“ –
  einmal herunterladen, Projekt neu erstellen ([Kapitel 6](06-gateway-aktualisieren.md)).
- **Raspberry-Pi-Image:** nichts zu tun; das Gateway startet die Dienste selbst.
  Auf einem Pi 3 oder Zero (bis 1 GB) laufen zigbee2mqtt (≈ 120 MB) und der Border
  Router (≈ 60 MB) auch – der Reiter weist nur darauf hin, dass es eng werden kann.
- Bluetooth: eingebaut (Pi ab diesem Image) oder ein USB-Bluetooth-Stick. Eine NAS hat
  meist kein Bluetooth.

**Einschalten:** Reiter „Funktionen“ → „Geräte im Heimnetz“ → „Funk (Zigbee,
Bluetooth, Thread)“ einschalten, oder im Reiter „Funk“ Zigbee, Bluetooth und Thread
einzeln. Bei Zigbee wählst du den **Zigbee-Dienst**: „deCONZ“ oder „zigbee2mqtt“.
deCONZ steht anfangs auf „automatisch“: läuft, sobald ein ConBee oder RaspBee erkannt
ist. Steckt ein Stick, der nur zu zigbee2mqtt passt, sagt der Reiter das.

**Sticks von Hand festlegen:** Im Reiter „Funk“ unter „Funksticks“ steht neben jedem
Stick „Wofür?“ mit „Automatisch (Standard)“, „Zigbee“, „Thread“ und „nicht verwenden“.
Die Wahl geht vor; „Automatisch“ verteilt nur die übrigen Sticks. Das Gateway erkennt
den Stick an seiner Seriennummer (Kennung wie in `/dev/serial/by-id`) – auch nach
dem Umstecken in eine andere Buchse. Hat ein Stick keine eigene Seriennummer, gilt
die Wahl für die USB-Buchse (der Reiter sagt das). Ohne SSH: Das Gateway gibt dem
Dienst (deCONZ, zigbee2mqtt, Border Router) selbst den gewählten Stick.

- **Steckt ein gewählter Stick nicht**, bleibt er mit „nicht eingesteckt“ in der Liste,
  und der Funk wartet auf ihn („Stick fehlt“) – er nimmt keinen anderen Stick, damit
  zigbee2mqtt nicht auf einem fremden Stick ein neues Netz aufmacht. Wieder einstecken
  oder auf „Automatisch“ stellen.
- **Hinweise, keine Sperren:** Zwei Sticks für denselben Funk – der zuerst gewählte
  zählt, der andere bleibt frei. Ein Funk ist aus – der Stick wird genommen, sobald er
  an ist. Passt der Stick laut Erkennung nicht (deCONZ an einem Nicht-ConBee, Thread an
  einem Stick ohne bekannte RCP-Firmware), nimmt das Gateway ihn trotzdem – praktisch
  nach dem Umflashen. Nur zigbee2mqtt kann einen Stick ohne passenden Adapter gar nicht
  ansteuern („Stick passt nicht“).
- „nicht verwenden“: Kein Dienst fasst den Stick an – z. B. für einen Stick, den ein
  anderes Programm am selben Rechner nutzt.
- Braucht ein Gateway **nach 1.33.1** (also ab 1.34.0). Bei älteren Gateways ist die
  Auswahl gesperrt, mit einem Hinweis auf die Version; sie teilen weiter automatisch zu.

**Geräte anlernen:** Im Reiter „Funk“ bei Zigbee „Anlernen starten“ – GateControl
sucht 3 Minuten. Gerät in den Kopplungsmodus bringen (meist Knopf 5 s drücken). Das
neue Gerät erscheint mit „neu“; „In Smart Home benennen“ öffnet es im Plugin Smart
Home. Mit deCONZ: Ist Smart Home noch nicht verbunden, steht dort „Im Smart Home
einbinden“ – GateControl legt die Route an und gibt deCONZ kurz frei. Mit zigbee2mqtt
erscheinen die Geräte von selbst in Smart Home (Quelle „Funk“ des Gateways); der
Reiter listet sie mit ihren Werten, „Entfernen“ meldet ein Gerät aus dem Zigbee-Netz ab.

**Bluetooth-Sensoren:** Das Gateway hört nur zu, es verbindet sich mit nichts.
Neue Sensoren stehen als „unbekannt“ da – „Übernehmen“ und einen Namen geben (z. B.
„Keller“); nur übernommene Sensoren erscheinen in Smart Home, die der Nachbarn
bleiben draußen. **Verschlüsselte Sensoren** (BTHome mit Schlüssel, z. B. Shelly BLU
mit Verschlüsselung; Xiaomi-Originalfirmware mit Bindkey) zeigen „Schlüssel fehlt“.
Den Schlüssel (32 Zeichen) gibst du beim Übernehmen oder mit „Schlüssel eintragen“
ein. GateControl speichert ihn verschlüsselt und gibt ihn nur an dieses Gateway –
nie in die Konfiguration oder ins Protokoll. Danach steht dort „entschlüsselt“ mit
den Werten, bei einem falschen Schlüssel „Schlüssel falsch“. Ältere Xiaomi-Sensoren
mit der alten Verschlüsselung (vor MiBeacon v4) gehen nicht.

**Thread / Matter:** Thread einschalten – das Gateway startet den OpenThread Border
Router. Hat er noch kein Netz, wählst du „Netz anlegen“ oder „Vorhandenem Netz
beitreten“ (Datensatz eines anderen Border Routers einfügen, z. B. aus Home
Assistant › Einstellungen › Thread). Läuft das Netz, zeigt der Reiter Name, Kanal und
PAN; „Datensatz anzeigen“ gibt den Zugang für einen Matter-Controller heraus (nur an
eigene Geräte weitergeben). **Für Matter über Thread fehlt dann noch ein
Matter-Controller** (Apple Home, Google Home, Home Assistant mit Matter-Server), der die
Geräte aufnimmt – GateControl nimmt Matter-Geräte selbst noch nicht auf. Leitet der
Gateway-Host IPv6 nicht weiter, sagt der Reiter das: Ohne `net.ipv6.conf.all.forwarding=1`
am Host finden Controller im Heimnetz die Thread-Geräte nicht. Matter-Geräte im WLAN
gehen schon jetzt über Smart Home.

**Wenn etwas hakt:** „Freigabe nötig“ heißt: deCONZ hat ein Phoscon-Passwort und lässt
GateControl nicht hinein – einmal in Phoscon (Port 8090 des Gateways) Gateway ›
Erweitert › „App authentifizieren“, dann „Erneut versuchen“. „MQTT aus“ bei
zigbee2mqtt: „Edge und MQTT einschalten“. Beendet sich zigbee2mqtt oder der Border
Router immer wieder, passt meist die Firmware des Sticks nicht (Zigbee-Firmware für
zigbee2mqtt, RCP-Firmware für Thread). „Stick fehlt“: der von Hand gewählte Stick
steckt nicht – unter „Funksticks“ wieder einstecken oder auf „Automatisch“ stellen.

## Lokale KI

**Wofür:** Ein KI-Modell im Heimnetz statt in der Cloud. Drive und Mail fassen
Dokumente und Mails damit zusammen, sortieren und schlagen Antworten vor – die
Inhalte verlassen das Haus nicht, und es kostet nichts. Dafür antwortet ein
Modell ohne Grafikkarte langsamer (Sekunden bis Minuten) und kann weniger als
die großen Cloud-Modelle; Bilder versteht es nicht (die gehen weiter an die
Cloud, wenn „Bilder senden“ an ist).

**Zwei Wege:**

- **Auf einem Gateway:** GateControl lädt das Modell auf das Gateway und startet
  es dort (Dienst „ki“ mit Ollama). Sinnvoll ab etwa 4 GB RAM; eine NAS mit 8–16 GB
  ist gut. Auf einem Raspberry Pi 3 B+ (1 GB) zeigt GateControl „zu wenig Speicher“ –
  einschalten bleibt möglich, besser ist dann der zweite Weg.
- **Vorhandener KI-Server im Heimnetz:** Läuft schon Ollama, LM Studio, vLLM, ein
  llama.cpp-Server oder LocalAI auf einem PC, leitet ein Gateway im selben Heimnetz die
  Fragen nur weiter – an genau diese eine Adresse. Am PC muss der Server im Netz
  lauschen: Ollama mit `OLLAMA_HOST=0.0.0.0`, LM Studio mit „Serve on Local Network“.

**Voraussetzungen:**

- Gateway 1.26.0+. Ist es älter, steht in der Zeile „Gateway zu alt – ab 1.26.0“.
  Grafikkarte, API-Schlüssel, Namen/IPv6 und „Verbindung testen“ brauchen Gateway
  **1.31.0**+ (vorher steht dort ein Hinweis).
- **Synology/Linux** (nur „Auf einem Gateway“): einmal die aktuelle Compose-Datei mit
  dem Dienst „ki“. Fehlt er, zeigen die Zeile „Lokale KI“ und die Einrichtung den Knopf
  „docker-compose.yml herunterladen“ – herunterladen, Projekt neu erstellen
  ([Kapitel 6](06-gateway-aktualisieren.md)). Das Ollama-Image ist ≈ 3 GB, jedes Modell
  1–6 GB.
- **Raspberry-Pi-Image:** nichts zu tun – das Image legt den Dienst selbst an, sobald
  du die lokale KI einschaltest.

**Einrichten:** Einstellungen › Erweiterungen › KI-Anbieter › „Lokale KI einrichten“:

1. „Auf einem Gateway“ oder „Vorhandener KI-Server im Heimnetz“ wählen.
2. Das Gateway wählen. Daneben stehen RAM, Kerne und ob eine Grafikkarte da ist.
   Hat es eine, erscheint **„Grafikkarte nutzen“** (siehe unten).
3. Ein Modell wählen. GateControl sagt je Gateway „empfohlen“, „passt“ oder „nicht
   empfohlen“ (zu wenig Speicher oder ohne Grafikkarte zu langsam) – wählen geht
   immer. Für den Anfang: **Llama 3.2 3B** (2 GB, schnell, gut für Zusammenfassen und
   Sortieren); auf schwacher Hardware **Llama 3.2 1B**; mit viel Speicher **Qwen 2.5 7B**
   (bessere Antworten, deutlich langsamer ohne Grafikkarte).
   Mit Grafikkarte zählt ihr Speicher: „im Grafikspeicher“ heißt schnell; mit 12 GB
   oder mehr ist **Qwen 2.5 14B** eine gute Wahl, mit 24 GB **Qwen 2.5 32B**.
   Beim KI-Server im Heimnetz: Adresse eintragen, die Art wählen (Ollama oder
   OpenAI-kompatibel), falls nötig den API-Schlüssel, dann **„Verbindung testen“** –
   GateControl zeigt die Modelle des Servers, ohne etwas zu speichern. Eines wählen.
4. „Speichern“. Auf einem Gateway lädt GateControl das Modell herunter
   („Modell wird geladen: 1,3 von 2,0 GB“, „Abbrechen“ geht jederzeit; ein späteres
   „Laden“ setzt fort).

**Adresse des KI-Servers:** mit Port, z. B.

| So | Beispiel |
|---|---|
| private IPv4-Adresse | `http://192.168.1.20:11434` |
| Name im Heimnetz | `http://ki-pc.local:11434`, `http://pc.fritz.box:1234` |
| private IPv6-Adresse (fd…/fc…) | `http://[fd00::20]:11434` |
| mit `/v1` (OpenAI-kompatibel) | `http://192.168.1.20:8000/v1` |

Das Gateway löst Namen selbst auf (`.local` per mDNS, sonst über den Router) und
verbindet sich **nur** mit Adressen im Heimnetz. Zeigt ein Name ins Internet, sagt
„Verbindung testen“: „Der Name zeigt nicht ins Heimnetz“. Einen Server im Internet
gibt es für die lokale KI nicht – dafür sind die Cloud-Anbieter da.

**API-Schlüssel:** Verlangt der Server einen (Ollama hinter einem Proxy, vLLM mit
`--api-key`, LocalAI, LM Studio oder llama.cpp mit Schlüssel), ihn ins Feld
„API-Schlüssel“ eintragen. GateControl speichert ihn verschlüsselt, zeigt danach nur
„gespeichert (…abcd)“ und gibt ihn nur dem Gateway, das weiterleitet – nie im
Protokoll, nie in der Konfiguration, die die Gateways abholen. „Schlüssel entfernen“
löscht ihn beim nächsten „Speichern“. Mit `http://` geht der Schlüssel unverschlüsselt
durchs Heimnetz – besser `https://`, wenn der Server es kann.

**Grafikkarte nutzen** (nur „Auf einem Gateway“, nicht beim Raspberry Pi): GateControl
erkennt die Karte des Gateways (NVIDIA, AMD, Intel), ihren Treiber und – sobald der
Dienst „ki“ sie sieht – ihren Speicher. „Grafikkarte nutzen“ wählen, „Speichern“,
dann **einmal die neue Compose-Datei herunterladen** und das Projekt neu erstellen
(wie oben); erst dann sieht der Dienst „ki“ die Karte. Danach steht dort „bereit“ bzw.
„Das Modell läuft auf der Grafikkarte“.

| Wahl | Was in die Compose-Datei kommt | Was auf dem Rechner da sein muss |
|---|---|---|
| NVIDIA | die Karte für den Dienst „ki“ | NVIDIA-Treiber ab 550 **und** das NVIDIA Container Toolkit |
| AMD (ROCm) | das ROCm-Image von Ollama, `/dev/kfd` und `/dev/dri` | amdgpu-Treiber mit ROCm (`/dev/kfd`), nur x86-64 |
| Intel (experimentell) | `/dev/dri` (Vulkan) | i915- oder xe-Treiber |

Fehlt etwas, sagt GateControl es, statt die Wahl zu sperren: „NVIDIA-Treiber fehlt“,
„NVIDIA Container Toolkit fehlt“ (der Dienst „ki“ sieht die Karte nicht oder startet
nicht), „/dev/kfd fehlt (ROCm)“, „neue Compose-Datei herunterladen“. Treiber und
Toolkit installiert man auf dem Rechner selbst (z. B. Linux: Paket
`nvidia-container-toolkit`, dann `nvidia-ctk runtime configure --runtime=docker` und
Docker neu starten) – das kann GateControl nicht abnehmen. Auf einer Synology gibt es
für die meisten Modelle keine nutzbare Grafikkarte.

**Wofür die lokale KI?**

| Einstellung | Was passiert |
|---|---|
| Für alles | Alle Anfragen gehen zuerst an die lokale KI. Die Cloud antwortet nur, wenn die lokale KI nicht erreichbar ist (Gateway offline, besetzt, zu langsam, Modell fehlt) oder ein Bild verstehen muss. |
| Nur für private Inhalte | Drive-Dokumente und Mails (Plugins Drive und Mail) gehen an die lokale KI – und **nie** in die Cloud, auch wenn die lokale KI ausfällt. Alles andere wie bisher. |
| Nur als Ausweich | Alles wie bisher über die Cloud; die lokale KI springt ein, wenn das Monatsbudget aufgebraucht ist. |

„Testen: „Fasse diese Mail zusammen““ schickt eine erfundene Mail an die lokale KI und
zeigt die Antwort und wie lange sie gedauert hat. Die lokale KI kostet 0 € und zählt
nicht ins Budget; im Protokoll der KI-Anfragen steht sie trotzdem (mit „lokal“).

**Im Reiter „Funktionen“:** Die Zeile „Lokale KI“ im Bereich „Geräte im Heimnetz“
schaltet die KI auf diesem Gateway ein und aus und zeigt das Modell, die Grafikkarte
(„Grafikkarte: NVIDIA GeForce RTX 3060 (12 GB) – bereit“) und was ihr fehlt; beim
KI-Server im Heimnetz die Adresse und ob ein API-Schlüssel gesetzt ist. Der Balken oben
zeigt den Speicher: grün die Heimnetz-Funktionen, blau das Modell im Speicher; „knapp“
heißt, für weitere Funktionen bleibt wenig.

**Wenn etwas hakt:** „Dienst „ki“ fehlt“ → Compose-Datei herunterladen (siehe oben).
„nicht erreichbar“ beim KI-Server im Heimnetz → läuft der PC, lauscht der Server im
Netz, stimmt der Port? „verlangt einen (anderen) API-Schlüssel“ → Schlüssel eintragen
oder prüfen. „Der Name zeigt nicht ins Heimnetz“ → die IP-Adresse eintragen oder den
Namen im Router prüfen. Grafikkarte „wartet auf die neue Compose-Datei“ → Compose-Datei
herunterladen und das Projekt neu erstellen. Das Aktivitätsprotokoll meldet „Lokale KI antwortet nicht“
höchstens einmal pro Stunde.

## Zwischenspeicher

**Wofür:** Hält App-Updates, Dateien und Fotos (über das Drive-Plugin) im
Heimnetz bereit. Apps im Heimnetz laden sie dann in voller LAN-Geschwindigkeit.
Wer was sehen darf, prüft weiterhin der Server.

Ab GateControl 1.249.0 liegen dort auch die **Vorschaubilder** (Drive 1.24.0+):
die kleinen Bilder der Foto- und Dateilisten. Zu Hause bauen sich die Listen in
der App dann sofort auf. Vorschaubilder sind klein (meist unter 40 KB), zählen
aber zur Höchstgröße. Sie gehören zur Art ihrer Datei (Drive oder Fotos) –
wer „Fotos“ ausschaltet, schaltet auch deren Vorschaubilder aus.

**Voraussetzungen:**

- Gateway 1.22.0+.
- Ein Ordner für die Dateien:
  - **Synology / Linux:** `gateway-cache` neben der Compose-Datei. Die
    Compose-Datei muss ihn einbinden (`${GC_CACHE_DIR:-./gateway-cache}:/cache`)
    und der Ordner muss existieren. Ältere Compose-Dateien haben das nicht – siehe
    [Kapitel 6](06-gateway-aktualisieren.md).
  - **Raspberry Pi:** am besten ein USB-Datenträger. Trage in `settings.txt`
    `CACHE_DIR=<Ordner auf dem USB-Datenträger>` ein und starte neu. Ständiges
    Schreiben nutzt die SD-Karte ab.
- Port 8443 im Heimnetz ist frei.

**Einschalten:** Reiter „Zwischenspeicher“ → „Zwischenspeicher einschalten“.
Unter „Was zwischengespeichert wird“ wählst du die Arten (Drive, Fotos,
App-Updates, Tresor-Dateien), unter „Speicher“ die Höchstgröße.

**Prüfen:** Der Zustand ist „aktiv“. Steht dort „Ordner nicht beschreibbar“,
fehlt der Ordner oder die Compose-Zeile ([Kapitel 7](07-faq.md#zwischenspeicher-ordner-nicht-beschreibbar)).

**In der Android-App:**

- **„Offline verfügbar“ (Drive):** Die App behält von markierten Dateien und
  Ordnern eine Kopie auf dem Handy, die auch ohne Verbindung öffnet. Zu Hause
  lädt sie die Kopien aus dem Zwischenspeicher, unterwegs über den Server.
  Ändert sich eine Datei, wird die Kopie erneuert. In den Drive-Einstellungen
  der App stehen „Speicher für Offline-Dateien“ (Standard 2 GB) und
  „Offline-Dateien nur im WLAN laden“. Auch Tresor-Dateien, -Ordner oder
  ein ganzer Tresor lassen sich offline halten: auf dem Handy liegt dann nur
  der verschlüsselte Inhalt, geöffnet wird wie immer erst nach dem
  Entsperren und nur im Arbeitsspeicher – auch ohne Verbindung. Wird das
  Gerät aus dem Tresor entfernt oder meldest du dich ab, löscht die App diese
  Dateien.
- **App-Updates:** Die App aus GitHub (nicht die aus Google Play) lädt ein
  Update zu Hause vom Gateway. Sie prüft Prüfsumme und App-Signatur, bevor
  Android die Installation anbietet. Ist das Gateway nicht erreichbar, lädt
  sie es wie bisher aus dem Internet.

Weiter mit [Kapitel 6: Bestehendes Gateway aktualisieren](06-gateway-aktualisieren.md).
