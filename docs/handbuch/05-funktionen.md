# 5. Funktionen der Heim-Gateways

[← Edge-Plugins und Smart Home](04-edge-und-smart-home.md) · [Inhaltsverzeichnis](README.md) · [Weiter: Bestehendes Gateway aktualisieren →](06-gateway-aktualisieren.md)

Ein Gateway kann mehr als nur den Tunnel. Alle Funktionen findest du so:

1. „Netzwerk“ → „Gateways“ → auf dein Gateway klicken.
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

Allgemeine Voraussetzungen:

- Netzwerk-Wächter, Internetqualität, Anwesenheit und USV brauchen
  Gateway-Version **1.21.0** oder neuer, DNS-Filter und Zwischenspeicher **1.22.0**,
  Drucken & Scannen **1.24.0**.
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
3. „Adresse des USV-Servers“ (private IPv4), „Port“ (meist 3493) und optional
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
  Gateway selbst.

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

## Zwischenspeicher

**Wofür:** Hält App-Updates, Dateien und Fotos (über das Drive-Plugin) im
Heimnetz bereit. Apps im Heimnetz laden sie dann in voller LAN-Geschwindigkeit.
Wer was sehen darf, prüft weiterhin der Server.

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

Weiter mit [Kapitel 6: Bestehendes Gateway aktualisieren](06-gateway-aktualisieren.md).
