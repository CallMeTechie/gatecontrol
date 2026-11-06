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

Diese Meldung steht beim Gateway in der Karte „Funktionen dieses Gateways“ bei
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

### Der Container startet nicht oder das Zertifikat kommt nicht

- `GC_ADMIN_PASSWORD is not set or still default`: In der `.env` steht noch
  `changeme`. Ein echtes Passwort eintragen, `docker compose up -d`.
- `127.0.0.1:53 is already bound`: Ein anderer DNS-Dienst läuft auf dem Server.
- `unable to fetch certificate`: Der A-Record zeigt noch nicht auf den Server
  oder Port 80 ist zu. Der Server versucht es von selbst wieder.

Ausführlich: [INSTALL.de.md §9](../../INSTALL.de.md#9-troubleshooting).

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

### „Edge-Dienst fehlt“

In der Compose-Datei des Gateways fehlen die Dienste `edge` und `mqtt`. Bring
sie mit [Kapitel 6](06-gateway-aktualisieren.md) auf den aktuellen Stand – am
schnellsten mit dem Knopf „Nur docker-compose.yml herunterladen“ unter der
Meldung (keine neuen Schlüssel). Beim
Raspberry-Pi-Image steht `EDGE=off` in `settings.txt` – auf `EDGE=on` ändern
und neu starten. Mehr: [Kapitel 4](04-edge-und-smart-home.md#edge-dienst-fehlt).

### „Netzgrenze fehlt“ / xt_owner

Dem Kernel fehlt der Owner-Match, auf der Synology das Modul `xt_owner`. Die
Schritte stehen in [Kapitel 4](04-edge-und-smart-home.md#netzgrenze-fehlt).

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
