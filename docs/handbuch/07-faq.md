# 7. FAQ und Fehlerbehebung

[← Bestehendes Gateway aktualisieren](06-gateway-aktualisieren.md) · [Inhaltsverzeichnis](README.md)

## Allgemein

### Wo finde ich die Protokolle?

**Server** (auf dem Server als root):

```bash
cd /opt/gatecontrol
docker compose logs --tail 200 gatecontrol
```

Das Protokoll der Updates steht in `/var/log/gatecontrol-update.log`. In der
Oberfläche gibt es außerdem „Logs & Monitoring“.

**Gateway auf der Synology:** Container Manager → „Container“ →
`gatecontrol-gateway-gateway-1` (bzw. `…-edge-1`, `…-mqtt-1`) → „Protokoll“.

**Gateway unter Linux/Docker:**

```bash
cd /opt/gatecontrol-gateway
sudo docker compose logs --tail 200 gateway
sudo docker compose logs --tail 200 edge
```

**Raspberry-Pi-Image** (per SSH):

```bash
journalctl -u gatecontrol-gateway -b
sudo docker compose --project-directory /opt/gatecontrol-gateway logs --tail 200 gateway
```

Ohne SSH: Karte in den PC stecken und `bootfs/gatecontrol/STATUS.txt` lesen.

**In GateControl:** Gateway öffnen → Reiter „Edge-Plugins“ → „Protokoll des
Gateways“; beim einzelnen Plugin „Protokoll“.

Das Protokoll der Gateway-Updates liegt auf dem Gerät in `gateway-state/update.log`.

### Darf ich Passwörter oder Dateien in Chats oder Tickets teilen?

Nein. Teile **nie** die `.env` des Servers, eine `gateway.env`, die
`gatecontrol-setup.zip` oder die `gatecontrol-gateway-nas.zip` – auch nicht
Ausschnitte. Sie enthalten Passwörter, Tokens und die Schlüssel des Tunnels.
Schwärze in Protokollen Passwörter, Tokens und Schlüssel, bevor du sie teilst.
Ist doch etwas nach außen gelangt: Admin-Passwort ändern und für das Gateway
eine neue Einrichtungsdatei erzeugen (die alte gilt dann nicht mehr).

### Wie aktualisiere ich ein Gateway?

In GateControl auf der Karte des Gateways „Update auf …“ klicken. Das braucht
das eingerichtete Auto-Update. Neue Funktionen, die mehr in der Compose-Datei
brauchen (Edge, Zwischenspeicher), musst du einmal von Hand nachtragen.
Alles dazu: [Kapitel 6](06-gateway-aktualisieren.md).

## Server

### „Der Server läuft in UTC“

Diese Meldung steht beim Gateway im Reiter „Funktionen“ (Karte „System“) bei
„Ortszeit“. Dem Server fehlt die Zeitzone.

1. Trage sie in die `.env` des Servers ein:

   ```bash
   cd /opt/gatecontrol
   echo 'TZ=Europe/Berlin' >> .env
   ```

2. Übernimm sie mit `docker compose up -d` (nicht `docker restart`).

**Prüfen:** `docker exec gatecontrol printenv TZ` zeigt `Europe/Berlin`. Die
Gateways übernehmen die Zeitzone beim nächsten Abruf ihrer Konfiguration.

### Warum die Zeitzone in die `.env` und nicht in die Compose-Datei?

Die `docker-compose.yml` des Servers gibt die `.env` an den Container weiter
(`env_file: .env`). Alle Einstellungen stehen so an einer Stelle, und die
Compose-Datei bleibt so, wie sie ausgeliefert wird. Nach einer Änderung an der
`.env` immer `docker compose up -d` ausführen – `docker restart` übernimmt neue
Werte nicht.

Beim Gateway trägst du keine Zeitzone ein. Es bekommt sie vom Server
(ab Gateway 1.22.0).

### „Auto-Update nicht eingerichtet“, obwohl der Zeitplan läuft

Meist liegen die Daten des Servers nicht im Ordner `/opt/gatecontrol/data`,
sondern in einem Docker-Volume (Installationen mit einer älteren
`docker-compose.yml`). Prüfe es:

```bash
docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Source}}{{"\n"}}{{end}}'
```

- `bind … /opt/gatecontrol/data`: Die Daten liegen richtig. Prüfe den Zeitplan
  (`cat /etc/cron.d/gatecontrol-update`) und das Protokoll
  `/var/log/gatecontrol-update.log`.
- `volume gatecontrol_gatecontrol-data …` (oder ähnlich): Ein aktuelles
  `update.sh` erkennt das Volume selbst und arbeitet damit. Im Protokoll steht
  dann `NOTE: /data of 'gatecontrol' is the Docker volume …`. Ein altes
  `update.sh` holst du so: `cd /opt/gatecontrol && curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh && chmod +x update.sh`.
  Auf Dauer einfacher ist der Umzug nach `./data` (nächster Abschnitt): Dann
  sichert auch das `tar`-Backup aus [Kapitel 2.10](02-server-einrichten.md#210-backup) die Daten mit.

### Server-Daten von einem Docker-Volume nach ./data umziehen

Ältere Installationen speichern die Daten im Docker-Volume `gatecontrol-data`
(Docker hängt den Projektnamen davor, z. B. `gatecontrol_gatecontrol-data`).
Die aktuelle `docker-compose.yml` nutzt den Ordner `./data`. Der Umzug dauert
etwa eine Minute; so lange ist der Server nicht erreichbar. Nichts wird
gelöscht: Das Volume bleibt als Rückfall liegen.

Alle Befehle auf dem Server als root, im Ordner mit der `docker-compose.yml`
(hier `/opt/gatecontrol`).

1. Den Namen und den Ort des Volumes merken:

   ```bash
   cd /opt/gatecontrol
   docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Source}}{{"\n"}}{{end}}'
   ```

   Die Zeile mit `volume` nennt den Namen (z. B. `gatecontrol_gatecontrol-data`)
   und den Ort (z. B. `/var/lib/docker/volumes/gatecontrol_gatecontrol-data/_data`).
   Steht dort `bind … /opt/gatecontrol/data`, ist nichts zu tun.

2. Den Server anhalten:

   ```bash
   docker compose down
   ```

3. Die Daten kopieren (Rechte und Zeitstempel bleiben erhalten). Den Ort aus
   Schritt 1 einsetzen:

   ```bash
   mkdir -p data
   cp -a /var/lib/docker/volumes/gatecontrol_gatecontrol-data/_data/. data/
   ls data
   ```

   `ls data` zeigt unter anderem `gatecontrol.db` und den Ordner `wireguard`.

4. Die Compose-Datei umstellen. Ersetze sie durch die aktuelle oder ändere die
   eine Zeile:

   ```bash
   cp docker-compose.yml docker-compose.yml.bak
   sed -i 's#- gatecontrol-data:/data#- ./data:/data#' docker-compose.yml
   grep -n ':/data' docker-compose.yml
   ```

   `grep` zeigt `- ./data:/data`. Den Eintrag `gatecontrol-data:` unter
   `volumes:` am Dateiende darfst du stehen lassen.

5. Den Server starten:

   ```bash
   docker compose up -d
   ```

6. Prüfen:

   ```bash
   docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'
   docker compose ps
   ```

   Die erste Zeile zeigt `bind /opt/gatecontrol/data`, `docker compose ps`
   zeigt `(healthy)`. Melde dich an: Routen, Peers und Gateways sind wie vorher da.

Geht etwas schief: `docker compose down`, `cp docker-compose.yml.bak docker-compose.yml`,
`docker compose up -d` – dann läuft der Server wieder mit dem Volume.

Erst wenn alles mindestens einen Tag läuft, darfst du das Volume löschen
(`docker volume rm gatecontrol_gatecontrol-data`, Namen aus Schritt 1).

### „event loop was blocked“ im Protokoll

Der Server hat einige Sekunden lang nichts anderes getan – in der Zeit warten
Gateways, Apps und die Weboberfläche. Die Zeile nennt, was in der Zeit lief:

- `tasks`: Hintergrundaufgaben (z. B. `plugins.mediaAreas`, `home.staleOffers`),
  Startschritte (`boot.*`), Anfragen (`GET /api/v1/…`, IDs als `:id`) und
  Plugin-Aufrufe (`plugin <id> <Aufruf>`) mit der Zeit, die sie den Server
  belegt haben, und Prozessstarts (`spawn <Programm>`). Einträge mit
  `(async)` oder `(still running)` liefen nur in der Zeit – sie können auch
  nur gewartet haben (auf ein Programm, das Netz); die Ursache steht meist
  davor, ohne Zusatz.
- `requests`: Anfragen und Plugin-Aufrufe, die in der Zeit offen waren –
  Kandidaten, wenn `tasks` nichts Passendes nennt. Die Zeit ist die Zeit
  **innerhalb der Blockade**: Ein Aufruf, der die ganze Blockade über offen
  war, steht mit genau ihrer Länge da – auch wenn er nur gewartet hat. Ein
  `db.query` eines Plugins nennt seine Anweisung ohne Werte
  (`plugin gatecontrol-mail db.query SELECT … WHERE user_id = ?`).
- `blockedBy`: `cpu` – der Server hat in der Zeit selbst gerechnet
  (`mainCpuMs` nahe `blockedMs`); `waiting` – er hat gewartet, meist auf die
  Platte oder den Arbeitsspeicher (`diskReads`, `majorFaults` hoch) oder weil
  kein Prozessorkern frei war (`processCpuMs`: alle Threads zusammen).

- `diskSyncMs`: wie lange der Datenträger zuletzt für einen kleinen
  Schreibvorgang gebraucht hat. `waiting` mit `diskSyncMs` ab etwa 50 ms: Der
  Server hat auf den Datenträger gewartet (siehe „Der Datenträger ist beim
  Schreiben langsam“).

Anweisungen eines Plugins, die 200 ms oder länger laufen, fasst das Protokoll
je Plugin für 5 Minuten in einer Zeile „slow plugin database statements“
zusammen: Anzahl (`slow`), davon Schreibvorgänge (`writes`), längste Zeit
(`maxMs`) und die häufigsten Anweisungen ohne Werte. Sie laufen in einem
eigenen Thread und halten den Server nicht an – lesen sie aber große Teile
der Datenbank, bremsen sie die Platte für alle. Sind es fast nur
Schreibvorgänge, liegt es am Datenträger, nicht am Plugin.

Die Aufgaben mit vielen Einträgen (Bereiche von Drive
auf einem Speicherziel, der Zwischenspeicher der Gateways mit tausenden
Vorschaubildern, Sicherungen) arbeiten in kleinen Stücken, und die Datenbank schreibt
ihr Protokoll in einem eigenen Thread zurück. Kommt die Meldung trotzdem
öfter, die ganze Zeile (mit `tasks`, `requests` und `blockedBy`) und die
Zeilen „slow plugin database statements“ daneben in ein Ticket kopieren.

### Der Datenträger ist beim Schreiben langsam

Oben in **Logs & Monitoring** steht: „Der Datenträger von GateControl ist beim
Schreiben langsam (Ø … ms je Schreibvorgang …)“. GateControl misst alle
2 Minuten, wie lange der Datenträger braucht, bis ein kleiner Schreibvorgang
wirklich gespeichert ist. Der Hinweis erscheint, wenn das über eine halbe
Stunde im Mittel 50 ms oder länger dauert, und verschwindet von selbst, wenn
es wieder schnell geht. Eine SSD braucht 1–5 ms, eine Festplatte 10–30 ms.

Jede Änderung – ein Gerät meldet sich, ein Kalender wird abgeglichen, ein
Schloss meldet seinen Zustand – wartet darauf. Seit 1.255.0 schreiben die
Plugins so, dass nicht mehr jede Änderung auf den Datenträger wartet; ein
langsamer Datenträger bremst trotzdem Sicherungen, Updates und große Plugins.

Was hilft:

- den Ordner `/data` von GateControl auf eine **SSD** legen (bei einem NAS:
  ein SSD-Volume oder ein SSD-Cache für das Volume),
- **nicht** auf eine Netzwerkfreigabe (SMB/NFS), eine SD-Karte oder einen
  USB-Stick,
- **nicht** auf ein NAS-Volume, das gleichzeitig stark beschäftigt ist
  (Sicherungen, Datenträgerprüfung, RAID-Aufbau, Downloads, viele Kameras),
- bei einem NAS mit Festplatten: prüfen, ob gerade eine Datenträgerprüfung,
  ein RAID-Aufbau oder eine Sicherung läuft – dann ist der Hinweis
  vorübergehend.

Der Hinweis ist nur ein Hinweis – GateControl läuft weiter. Ausschalten lässt
sich die Messung mit `GC_DISK_PROBE=off`.

Was dabei verloren gehen kann: Die Datenbanken von GateControl und den
Plugins schreiben ihre Änderungen zuerst in ein Protokoll und bringen sie
regelmäßig gesammelt auf den Datenträger. Stürzt GateControl ab, geht nichts
verloren. Fällt der Strom aus, können die Änderungen der letzten Sekunden
(beim Server höchstens 30 s) fehlen – die Datenbank bleibt aber heil.

### „malformed request body“ im Protokoll

Jemand hat GateControl einen Inhalt geschickt, den es nicht lesen kann. Die
Zeile ist eine Warnung, kein Fehler des Servers: Die Anfrage bekam einen
4xx-Fehler (meist 400 `invalid_json`), nichts wurde ausgeführt. Sie nennt
Methode, Pfad, Adresse (`ip`), die Art (`type`) und die Länge des Inhalts
(`length`) – den Inhalt selbst nie, er ist oft ein Angriffsversuch.

- `entity.parse.failed`: kein gültiges JSON. Von einer fremden Adresse auf
  Pfade wie `/run`, `/api/…` oder `/` fast immer ein Scanner, der Lücken
  anderer Software sucht.
- `entity.too.large`: größer als erlaubt (1 MB, Gateway- und App-Aufrufe
  weniger).
- `encoding.unsupported` / `charset.unsupported`: eine Kodierung, die kein
  Programm von GateControl schickt.
- `request.aborted`: Die Verbindung brach ab, bevor der Inhalt da war (z. B.
  ein Handy im Funkloch).

Je Art steht höchstens eine Zeile in 5 Minuten im Protokoll; `repeated` sagt,
wie viele seit der letzten Zeile dazukamen. Ungültiges JSON und unbekannte
Kodierungen zählen für die IP-Sperre (Quelle „Durchsuchen unbekannter Adressen“) wie ein 404 eines
unbekannten Pfads: je zehn von einer Adresse ein Fehlversuch. Eigene Adressen,
das VPN und die Liste „Nie sperren“ zählen nie. Kommt die Zeile von einer
eigenen App oder einem Gateway, liegt der Fehler dort – dann die Zeile in ein
Ticket kopieren.

### Der Container startet nicht oder das Zertifikat kommt nicht

- `GC_ADMIN_PASSWORD is not set or still default`: In der `.env` steht noch
  `changeme`. Ein echtes Passwort eintragen, `docker compose up -d`.
- `127.0.0.1:53 is already bound`: Ein anderer DNS-Dienst läuft auf dem Server.
- `unable to fetch certificate`: Der A-Record zeigt noch nicht auf den Server
  oder Port 80 ist zu. Der Server versucht es von selbst wieder.

Ausführlich: [INSTALL.de.md §9](../../INSTALL.de.md#9-troubleshooting).

### Fehlversuch mit einer fremden E-Mail-Adresse im Protokoll

Im Protokoll steht `Failed login for user: …` mit einem Namen oder einer
E-Mail-Adresse, die du nicht kennst und für die es kein Konto gibt. Das ist
fast immer ein automatischer Versuch mit Zugangsdaten aus einem Datenleck
(„Credential Stuffing“) – niemand hat dein Passwort, und es gibt kein Konto,
das betroffen wäre. In den Details steht dann `unknownUser: true`.

Die Kontosperre hilft hier nicht: Es gibt kein Konto, das gesperrt werden
könnte. Dafür ist die **IP-Sperre** da (Einstellungen › Sicherheit ›
IP-Sperre). Sie zählt Fehlversuche einer Adresse über alle Eingänge zusammen
und sperrt sie nach 10 Fehlversuchen in 10 Minuten. Ein unbekannter
Benutzername zählt dabei mehrfach – Einstellung **„Unbekannte Benutzernamen
zählen“**, voreingestellt **dreifach**. Mit 10 Fehlversuchen sperrt also schon
der 4. Versuch mit einem unbekannten Namen. Das gilt für den
GateControl-Login, den Login aus dem Portal, die Anmeldung in den Apps und
die Logins geschützter Routen. Ein falsches Passwort zu einem bestehenden
Konto und ein falscher zweiter Faktor zählen einfach.

Wer sich anmeldet, merkt keinen Unterschied: Die Antwort ist für unbekannte
und bekannte Namen gleich, so lässt sich nicht herausfinden, welche Konten es
gibt. Vertippst du dich selbst öfter beim Namen, stell die Einstellung auf
„doppelt“ oder „einfach“ oder trag dein Netz unter **„Nie sperren“** ein.
Adressen im VPN und im eigenen Netz werden ohnehin nie gesperrt.

**Prüfen:** In der Liste „Gerade gesperrt“ steht bei solchen Adressen
„Anmeldeversuche mit unbekannten Benutzernamen“.

### Was ist im Backup?

GateControl kennt drei Sicherungen. Du findest alle unter „Einstellungen“ →
„Backups“:

| Datei | Wann sie entsteht | Was drin ist |
|---|---|---|
| `gatecontrol-v…-v…-….db` („Sicherungen vor Datenbank-Updates“) | vor jedem Update, das die Datenbank ändert | eine Kopie der Datenbank von GateControl, so wie sie vor dem Update war. Plugin-Daten sind nicht drin. Nur für den Notfall, Zurückspielen geht nur von Hand. |
| `gatecontrol-….json` („Lokale Backup-Dateien“) | automatisch nach Zeitplan oder mit „Backup jetzt erstellen“ | alles, was du zum Wiederherstellen brauchst: Geräte, Weiterleitungen, Benutzer, Einstellungen und die Plugins mit ihren Datenbanken und Dateien (bis 512 MB). Passwörter und Schlüssel bleiben verschlüsselt. |
| `gatecontrol-….gcbk` („Außer Haus“) | nach jedem automatischen Backup, auf deiner NAS oder in der Cloud | dieselbe `.json`, gepackt und mit deiner Passphrase verschlüsselt – deshalb deutlich kleiner. Auf Wunsch mit dem Schlüssel von GateControl, damit ein neuer Server sie lesen kann. |

**Nicht drin** sind:

- die Dateien von Drive und Plugins auf einem **Speicherziel** (NAS, Cloud) –
  sie bleiben dort liegen, das Backup kennt nur ihre Liste;
- kurzlebige Daten wie Anmeldungen, Protokolle, Login-Versuche und
  Verkehrs-Statistiken;
- **Plugin-Medien** (Fotos, Belege …), außer du schaltest unter „Plugins“ →
  „Sicherheit & Upload“ „Plugin-Medien im Backup“ ein (bis 128 MB);
- Teile eines Plugins, die nicht mehr ins Backup passen oder sich nicht lesen
  ließen. Dann steht in der Liste „⚠ Nicht vollständig: …“ mit dem Namen des
  Plugins, und im Dashboard erscheint ein Eintrag unter „Probleme“. Lösche im
  Plugin, was du nicht mehr brauchst, und erstelle das Backup neu. Bis dahin
  das letzte vollständige Backup (ohne ⚠) herunterladen und aufheben.

**Prüfen:** Unter „Lokale Backup-Dateien“ steht beim neuesten Backup kein ⚠;
beim Ziel außer Haus meldet „Wiederherstellung testen“ keine Warnung.

### Offsite-Backup auf eine NAS hinter dem VPN

Meldung beim Testen eines Ziels „Backups außer Haus“, z. B. `WebDAV PROPFIND
failed: connect ECONNREFUSED 89.163.231.212:5006`, darunter „Die Adresse zeigt
auf diesen GateControl-Server selbst“: Der Name der NAS
(`nas.example.com`) zeigt auf den GateControl-Server – von außen erreichst du
die NAS über eine Weiterleitung von GateControl, aber GateControl selbst
findet auf Port 5006 bei sich nichts.

So geht es (wie beim Speicherziel für Drive):

1. Einstellungen → Backups → Ziel bearbeiten (oder neu: WebDAV).
2. **Verbindung**: „Über ein VPN-Gerät“ und das Gateway im Heimnetz wählen
   (z. B. „Home Gateway (10.8.0.8)“), **Port** den WebDAV-Port der NAS
   (Synology: 5006 für https). Oder „Über eine Weiterleitung“ und eine
   L4-Weiterleitung auf die NAS – sie darf „nur intern“ bleiben.
3. Die **Adresse** bleibt `https://nas.example.com:5006/…`: Sie bestimmt Pfad,
   Host-Name und den Namen, gegen den das Zertifikat geprüft wird. Ein
   eigenes DSM-Zertifikat unter „Eigenes Zertifikat oder eigene CA (PEM)“
   einfügen (`cert.pem` reicht).

Hast du die NAS schon als Speicherziel für Drive eingerichtet: oben im Dialog
„Speicherziel von Drive/Plugins übernehmen“ wählen. Adresse, Benutzer,
Verbindung und Zertifikat werden eingetragen, das Passwort beim Speichern
einmal kopiert. Gib in der Adresse einen eigenen Unterordner an
(z. B. `…/GateControl/Backups/`), damit die Backups nicht zwischen den Dateien
von Drive liegen. SMB und SFTP haben dieselbe Wahl „Verbindung“.

## Gateway einrichten

### Der Assistent wartet nach 10 Minuten immer noch

- **Synology:** Läuft das Projekt im Container Manager? Liegt `gateway.env` im Ordner `config`? Protokoll von `…-gateway-1` ansehen.
- **Raspberry Pi:** Liegt die Einrichtungsdatei in `bootfs/gatecontrol/`? Hat der Pi Netz? `STATUS.txt` lesen.
- **Linux:** `sudo docker compose ps` und `sudo docker compose logs gateway`.
- **Proxmox:** Der Kopplungscode gilt 10 Minuten. Neuen Code erzeugen und den Befehl erneut ausführen.

Hast du die Einrichtungsdatei mehrmals heruntergeladen? Dann gilt nur die
letzte. Nimm genau diese.

### „Bind mount failed: … does not exist“ (Synology)

Die Compose-Datei bindet einen Ordner ein, den es auf der NAS nicht gibt. Der
Container Manager der Synology legt fehlende Ordner nicht selbst an.

1. Lies in der Meldung, welcher Ordner fehlt (meist `gateway-cache` oder `gateway-state`).
2. Leg ihn in der File Station in `docker/gatecontrol-gateway` an.
3. Starte das Projekt neu.

Das NAS-Paket aus dem aktuellen Assistenten bringt `config/`, `gateway-state/`
und `gateway-cache/` schon mit.

**Prüfen:** Das Projekt startet ohne Meldung, alle drei Container laufen.

### „Your kernel does not support PIDs limit …“ (Synology)

Harmlos. Der Kernel der Synology kann die Prozess-Grenze (`pids_limit`) der
Container `edge` und `mqtt` nicht setzen. Docker lässt sie weg, alles andere
läuft normal. Du musst nichts tun.

### „/dev/net/tun“ fehlt (Synology)

Das Gateway braucht auf der Synology das Gerät `/dev/net/tun`. Fehlt es, startet
der Container `gateway` nicht und die Meldung nennt `/dev/net/tun`. Das Modul
`tun` lädst du per SSH mit `sudo insmod /lib/modules/tun.ko` – damit es einen
Neustart übersteht, wie bei [xt_owner](04-edge-und-smart-home.md#netzgrenze-fehlt)
als Aufgabe beim „Hochfahren“.

## Gateway im Betrieb

### Gateway offline

Das Gateway meldet sich nicht mehr beim Server.

1. Hat das Gerät Strom und Netz? Kommt es ins Internet?
2. Läuft der Container `gateway`? (Protokolle: [oben](#wo-finde-ich-die-protokolle).)
3. Erreicht das Gerät den Server unter deiner Domain und Port 51820/UDP?

**Prüfen:** Die Karte unter „Gateways“ zeigt das Gateway wieder als online.

„Startet neu“ statt „Offline“: Das Gateway hat sich ordentlich beendet (Neustart
des Containers oder des Geräts) und wird für zehn Minuten zurück erwartet.

### „Edge-Dienst fehlt“

In der Compose-Datei des Gateways fehlen die Dienste `edge` und `mqtt`. Bring
sie mit [Kapitel 6](06-gateway-aktualisieren.md) auf den aktuellen Stand – am
schnellsten mit dem Knopf „Nur docker-compose.yml herunterladen“ unter der
Meldung (keine neuen Schlüssel). Beim
Raspberry-Pi-Image steht `EDGE=off` in `settings.txt` – auf `EDGE=on` ändern
und neu starten. Mehr: [Kapitel 4](04-edge-und-smart-home.md#edge-dienst-fehlt).

### „Compose-Datei veraltet“ / „Netzgrenze fehlt“ / xt_owner

Die Compose-Datei stammt von vor Gateway 1.23.0: Der Edge-Container läuft
dort noch im Netz des Hosts und braucht Firewall-Regeln, für die der
Synology-Kernel das Modul `xt_owner` bräuchte. Ein Modul per SSH zu laden ist
nicht mehr nötig – lade unter der Meldung mit „Nur docker-compose.yml
herunterladen“ die aktuelle Datei, in der der Edge-Container gar kein Netz hat
(bei „Netzgrenze fehlt“ vorher das Gateway aktualisieren). Mehr:
[Kapitel 4](04-edge-und-smart-home.md#compose-datei-veraltet).

### „Edge erreicht GateControl nicht“

Der Edge-Container läuft, kommt aber nicht zum Server. Steht vor GateControl
ein weiterer Reverse Proxy (nginx, Traefik, CDN), muss er WebSocket-Verbindungen
zu `/api/v1/gateway/edge/ws` durchlassen. Mehr:
[Kapitel 4](04-edge-und-smart-home.md#edge-erreicht-gatecontrol-nicht).

### Zwischenspeicher: „Ordner nicht beschreibbar“

Das Gateway kann nicht in seinen Ordner `/cache` schreiben.

1. Steht in der Compose-Datei die Zeile `${GC_CACHE_DIR:-./gateway-cache}:/cache`?
   Wenn nicht: [Kapitel 6](06-gateway-aktualisieren.md).
2. Gibt es den Ordner `gateway-cache` neben der Compose-Datei (bzw. den Ordner aus `GC_CACHE_DIR`)?
3. Raspberry Pi: Ist der USB-Datenträger aus `CACHE_DIR` beim Start eingehängt?

**Prüfen:** Im Reiter „Zwischenspeicher“ steht „aktiv“.

### DNS-Filter: „Port 53 belegt“

Auf dem Gerät des Gateways läuft schon ein anderer DNS-Dienst (z. B. das Paket
„DNS Server“ der Synology, Pi-hole oder systemd-resolved). Beende ihn oder leg
ihn auf eine andere Adresse. Das Gateway erzwingt nichts und versucht es jede Minute neu.

### Nach dem Abschalten des DNS-Filters geht das Internet nicht mehr

Im Router steht noch das Gateway als DNS-Server. Leere das Feld im Router und
schalte das WLAN der Geräte einmal aus und wieder ein.
