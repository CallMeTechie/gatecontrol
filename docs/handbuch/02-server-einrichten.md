# 2. Server einrichten

[← Überblick](01-ueberblick.md) · [Inhaltsverzeichnis](README.md) · [Weiter: Gateway einrichten →](03-gateway-einrichten.md)

Der einfachste Weg ist das Installationsskript `setup.sh`. Es installiert
Docker, wenn es fehlt, fragt dich nach den wichtigsten Werten, erzeugt sichere
Schlüssel und legt die Einstellungsdatei `.env` an.

Alle Befehle in diesem Kapitel laufen **auf dem Server als root**.

## 2.1 Domain auf den Server zeigen lassen

1. Melde dich bei deinem Domain-Anbieter an.
2. Lege einen **A-Record** an, der auf die öffentliche IPv4-Adresse deines Servers zeigt:

   ```
   gate.example.com.   IN  A   198.51.100.42
   ```

3. Warte, bis der Eintrag weltweit bekannt ist (meist wenige Minuten, selten bis zu 30 Minuten).

**Prüfen:** `dig +short gate.example.com` (oder `nslookup gate.example.com`) zeigt die IP deines Servers.

## 2.2 Ports öffnen

Öffne in der Firewall deines Server-Anbieters (und in `ufw`/`iptables`, falls du sie nutzt):

| Port | Protokoll | Wofür |
|---|---|---|
| 80 | TCP | HTTP und die automatische Zertifikatsprüfung von Let's Encrypt |
| 443 | TCP | HTTPS für die Weboberfläche und alle Routen |
| 443 | UDP | HTTP/3 (optional) |
| 51820 | UDP | WireGuard-VPN (Gateways und Geräte) |

**Prüfen:** Die vier Regeln stehen in der Firewall-Übersicht deines Anbieters.

## 2.3 Dateien herunterladen

1. Melde dich per SSH am Server an und werde root:

   ```bash
   sudo -i
   ```

2. Lege den Ordner an und lade die Dateien herunter:

   ```bash
   mkdir -p /opt/gatecontrol && cd /opt/gatecontrol
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/setup.sh
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example
   curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh
   chmod +x update.sh
   ```

3. Lege die Daten in den Ordner `data` neben der Compose-Datei. Die mitgelieferte
   `docker-compose.yml` speichert sie sonst in einem Docker-Volume, das du im
   Dateisystem nicht siehst. Das Update-Skript `update.sh` und die Backups in
   [INSTALL.de.md](../../INSTALL.de.md#10-backup-und-restore) erwarten den Ordner
   `/opt/gatecontrol/data`:

   ```bash
   sed -i 's#gatecontrol-data:/data#./data:/data#' docker-compose.yml
   grep -n ':/data' docker-compose.yml
   ```

   Läuft dein Server schon länger mit der unveränderten Datei, ändere sie
   **nicht** einfach – sonst startet er mit leerer Datenbank. Den Umzug
   beschreibt [INSTALL.de.md §12](../../INSTALL.de.md#12-migration-bestehender-installationen).

**Prüfen:** `ls -a /opt/gatecontrol` zeigt `setup.sh`, `docker-compose.yml`,
`.env.example` und `update.sh`. Der `grep`-Befehl zeigt die Zeile `- ./data:/data`.

## 2.4 Das Installationsskript ausführen

1. Starte das Skript:

   ```bash
   cd /opt/gatecontrol
   bash setup.sh
   ```

2. Beantworte die Fragen:

   | Frage des Skripts | Was du eingibst |
   |---|---|
   | `Domain fuer das Web-Interface` | deine Domain, z. B. `gate.example.com` |
   | `HTTPS verwenden? (J/n)` | Enter (= Ja) |
   | `Oeffentliche IP oder Domain fuer WireGuard` | Enter (= dieselbe Domain) |
   | `Admin-Benutzername [admin]` | Enter oder ein eigener Name |
   | `Admin-Passwort` / `Passwort wiederholen` | ein starkes Passwort (wird nicht angezeigt) |
   | `Sprache (de/en) [de]` | Enter |
   | `E-Mail fuer Let's Encrypt Zertifikate (optional)` | deine E-Mail-Adresse (empfohlen) |
   | `Netzwerk-Interface [...]` | Enter (das Skript erkennt es selbst) |
   | `Container jetzt starten? (J/n)` | **`n`** – erst stellst du noch die Zeitzone ein |

   Meldet das Skript `Port … ist bereits belegt`, läuft auf dem Server schon ein
   Webserver oder VPN. Brich dann ab und beende diesen Dienst zuerst.

**Prüfen:** Das Skript zeigt die „Zusammenfassung“ und es gibt eine Datei
`/opt/gatecontrol/.env`.

## 2.5 Die Werte in der `.env`, die du wirklich brauchst

`setup.sh` hat diese Werte für dich gesetzt. Du musst sie nur kennen:

| Wert | Bedeutung |
|---|---|
| `GC_BASE_URL` | Adresse der Weboberfläche, z. B. `https://gate.example.com`. Für diese Domain holt der Server automatisch das HTTPS-Zertifikat. |
| `GC_WG_HOST` | Adresse, unter der Gateways und Geräte das VPN erreichen. |
| `GC_ADMIN_USER` / `GC_ADMIN_PASSWORD` | Erster Login. Das Passwort gilt nur beim allerersten Start; danach änderst du es in der Oberfläche. |
| `GC_CADDY_EMAIL` | Kontakt für Let's Encrypt (Warnungen zu Zertifikaten). |
| `GC_SECRET`, `GC_ENCRYPTION_KEY` | Geheime Schlüssel, vom Skript erzeugt. **Nie ändern, nie weitergeben.** Ohne den Encryption-Key ist ein Backup der Datenbank wertlos. |

Eine Zeile fehlt noch: die **Zeitzone**.

1. Trage sie in die `.env` ein:

   ```bash
   cd /opt/gatecontrol
   echo 'TZ=Europe/Berlin' >> .env
   ```

   Warum? Die Gateways übernehmen die Zeitzone vom Server. Sie gilt für den
   nächtlichen Portscan, den Plan der Geschwindigkeitsmessung und die Zeiten des
   DNS-Filters. Ohne `TZ` läuft der Server in UTC, und die Gateways rechnen dann
   auch in UTC.

2. Schütze die Datei, damit nur root sie lesen kann:

   ```bash
   chmod 600 .env
   ```

**Sicherheitshinweis:** Die `.env` enthält dein Admin-Passwort und die
geheimen Schlüssel. Gib sie nie weiter, schick sie nie per Chat oder E-Mail und
füge sie nie in ein Ticket ein.

Eine Regel für später: Nach **jeder** Änderung an der `.env` startest du mit

```bash
cd /opt/gatecontrol
docker compose up -d
```

– **nicht** mit `docker restart gatecontrol`. Nur `docker compose up -d` erstellt
den Container mit den neuen Werten neu. `docker restart` startet ihn mit den
alten Werten.

**Prüfen:** `grep -c '^TZ=' /opt/gatecontrol/.env` zeigt `1`.

## 2.6 Server starten

1. Starte GateControl:

   ```bash
   cd /opt/gatecontrol
   docker compose up -d
   ```

2. Sieh beim ersten Start zu:

   ```bash
   docker compose logs -f gatecontrol
   ```

   Nach 10–30 Sekunden erscheint `certificate obtained successfully`. Dann hat
   der Server sein HTTPS-Zertifikat. Beende die Anzeige mit `Strg+C` – der
   Server läuft weiter.

**Prüfen:**

- `docker compose ps` zeigt `gatecontrol` mit `(healthy)`.
- `curl -s https://gate.example.com/health` antwortet `{"ok":true}`.
- `docker exec gatecontrol printenv TZ` zeigt `Europe/Berlin`.

## 2.7 Erster Login

1. Öffne im Browser deine Adresse, z. B. `https://gate.example.com`.
2. Melde dich mit dem Benutzernamen (Standard `admin`) und dem Passwort aus `setup.sh` an.
3. Ändere das Passwort: oben rechts das Benutzermenü → „Profil“ → „Passwort ändern“.

Eine Route für die Weboberfläche selbst musst du nicht anlegen. Das macht
GateControl automatisch.

**Prüfen:** Du siehst das Dashboard. Im Browser steht ein Schloss-Symbol (gültiges Zertifikat).

## 2.8 Domain und HTTPS

Für die Weboberfläche ist HTTPS jetzt fertig. Für jede weitere Domain, die du
als Route einrichtest (z. B. `nas.example.com`), gilt dasselbe:

1. Beim Domain-Anbieter einen A-Record auf die IP des Servers anlegen.
2. In GateControl die Route anlegen („Netzwerk“ → „Domains / Routen“).

Das Zertifikat holt der Server von selbst.

**Prüfen:** `https://nas.example.com` öffnet sich ohne Zertifikatswarnung.

## 2.9 Updates einrichten

GateControl aktualisiert sich mit `update.sh`. Das Skript muss alle 5 Minuten laufen.

1. Lege den Zeitplan an:

   ```bash
   echo '*/5 * * * * root /opt/gatecontrol/update.sh' > /etc/cron.d/gatecontrol-update
   ```

   Fehlt der Ordner `/etc/cron.d`, installiere zuerst cron (Debian/Ubuntu: `apt install cron`).

2. Wähle in GateControl „Einstellungen“ → „Updates“ den Modus:
   - **Automatisch:** Neue Versionen kommen von selbst, auf Wunsch nur in einem Wartungsfenster.
   - **Manuell:** Der Server aktualisiert erst, wenn du „Jetzt aktualisieren“ klickst.

Von Hand aktualisieren geht jederzeit:

```bash
cd /opt/gatecontrol
./update.sh
```

Klappt ein Update nicht, stellt `update.sh` die vorige Version automatisch wieder her.

**Prüfen:** Nach spätestens 5 Minuten zeigt „Einstellungen“ → „Updates“ einen
Status (nicht mehr „Auto-Update nicht eingerichtet“). Das Protokoll steht in
`/var/log/gatecontrol-update.log`.

## 2.10 Backup

Am einfachsten sicherst du den ganzen Ordner (er enthält Geheimnisse, also gut schützen):

```bash
tar czf /root/gatecontrol-$(date +%F).tar.gz -C /opt gatecontrol
chmod 600 /root/gatecontrol-*.tar.gz
```

Mehr dazu (auch Backups in der Oberfläche unter „Einstellungen“ → „Backups“):
[INSTALL.de.md §10](../../INSTALL.de.md#10-backup-und-restore).

**Prüfen:** `tar tzf /root/gatecontrol-*.tar.gz | grep -c data/` zeigt eine Zahl größer als 0.

Weiter mit [Kapitel 3: Gateway einrichten](03-gateway-einrichten.md).
