# Installationsanleitung

Dies ist die vollständige, Schritt-für-Schritt-Anleitung zur Installation von GateControl. Sie geht von einem frischen Linux-Host mit Root-Zugang ohne bestehendes GateControl-Setup aus. Bestehende Installationen, die auf das empfohlene Verzeichnislayout umziehen möchten, finden die Anleitung in **[§12 Migration bestehender Installationen](#12-migration-bestehender-installationen)**.

Für eine Einzeiler-Zusammenfassung siehe die Quick-Start-Sektion in der [README.de](README.de.md). Dieses Dokument deckt den kompletten Ablauf von DNS bis zum ersten Login ab.

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#1-voraussetzungen)
2. [Verzeichnislayout](#2-verzeichnislayout)
3. [Setup-Dateien herunterladen](#3-setup-dateien-herunterladen)
4. [`.env` konfigurieren](#4-env-konfigurieren)
5. [Erster Start](#5-erster-start)
6. [Erster Login](#6-erster-login)
7. [Erster Peer und erste Route](#7-erster-peer-und-erste-route)
8. [Installation verifizieren](#8-installation-verifizieren)
9. [Troubleshooting](#9-troubleshooting)
10. [Backup und Restore](#10-backup-und-restore)
11. [Updates](#11-updates)
12. [Migration bestehender Installationen](#12-migration-bestehender-installationen)

---

## 1. Voraussetzungen

### Hardware

| Ressource | Minimum | Empfohlen |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Platte | 20 GB | 40 GB (mehr für ausführliche Activity-Logs und Caddy-Access-Logs) |

### Software

- **Betriebssystem:** Moderne Linux-Distribution (Debian 11+, Ubuntu 22.04+, Fedora, Rocky, Alma, Alpine). Getestet auf Debian 13.
- **Docker Engine:** 24.0 oder neuer
- **Docker Compose:** v2 (seit Docker Engine 23.0 integriert)
- **WireGuard-Kernelmodul:** auf den meisten modernen Kernels vorhanden. Der Container bringt kein externes Install mit, aber WireGuard-Capabilities (`NET_ADMIN`) müssen dem Container gewährt werden können.

### DNS

Bevor der Container gestartet wird, muss **ein DNS-A-Record** (optional zusätzlich AAAA für IPv6) auf die öffentliche IP des Hosts zeigen:

```
gate.example.com.   IN  A   198.51.100.42
```

GateControl nutzt diesen Namen für zwei Zwecke:

- **Admin-UI** via `GC_BASE_URL` — Caddy fordert automatisch beim ersten Start ein Let's-Encrypt-Zertifikat dafür an.
- **WireGuard-Endpunkt**, falls du zusätzlich `GC_WG_HOST=gate.example.com` setzt. (`GC_WG_HOST` kann auch eine blanke öffentliche IP sein, aber derselbe Hostname vereinfacht Peer-Konfigurationen.)

Jede Domain, für die du später eine Reverse-Proxy-Route einrichtest, braucht einen eigenen A-Record, der auf denselben Host zeigt.

### Ports

| Port | Protokoll | Zweck | Erreichbar von |
|---|---|---|---|
| 80 | TCP | HTTP → HTTPS Redirect, **ACME HTTP-01-Challenge** | Internet |
| 443 | TCP | HTTPS für Admin-UI und alle Reverse-Proxy-Routen | Internet |
| 443 | UDP | HTTP/3 (optional, empfohlen) | Internet |
| 51820 | UDP | WireGuard-VPN-Endpunkt | Internet |
| 53 | TCP/UDP auf `127.0.0.1` und auf der VPN-Gateway-IP (`10.8.0.1` per Default) | Interner DNS für VPN-Peers | nur Container (Loopback + WG-Interface) |

Sofern auf dem Host bereits etwas auf `127.0.0.1:53` lauscht (häufige Ursachen: NetworkManager-dnsmasq, libvirt-dnsmasq, bind9), weigert sich der GateControl-Container zu starten. `systemd-resolved` nutzt `127.0.0.53` und kollidiert **nicht**. Das Entrypoint-Skript prüft das explizit und beendet sich mit einer klaren Fehlermeldung, falls es einen anderen Listener findet.

Öffne die ersten vier Ports in deiner Cloud-Firewall / iptables / ufw, bevor du den Container startest.

---

## 2. Verzeichnislayout

Lege ein dediziertes Deploy-Verzeichnis an — **getrennt von einem eventuell geklonten Source-Repository**. Der empfohlene Pfad ist `/opt/gatecontrol/`:

```
/opt/gatecontrol/
├── docker-compose.yml    # Image, Ports, Volume
├── .env                  # deine Config (Passwörter, Domain etc.)
├── update.sh             # Helper-Skript zum Pullen + Neustart
└── data/                 # entsteht beim ersten Start — hält DB, Certs, Keys, WG-Config
```

Warum getrennt vom Source-Repo:

- Klares mentales Modell: "Code" und "Config" werden nie vermischt.
- Das Source-Repo kann jederzeit frisch geklont, aufgeräumt oder aktualisiert werden, ohne Produktiv-Zustand zu verlieren.
- Ein-Zeilen-Backup: `tar czf backup.tar.gz /opt/gatecontrol` sichert alles.

```bash
mkdir -p /opt/gatecontrol
cd /opt/gatecontrol
```

---

## 3. Setup-Dateien herunterladen

Drei Varianten. Alle enden mit denselben Dateien in `/opt/gatecontrol/`.

### Variante A — Interaktives Setup (empfohlen)

`setup.sh` herunterladen und ausführen. Es installiert Docker, falls es fehlt, führt interaktiv durch die `.env`-Werte, erzeugt sichere Secrets und startet den Container:

```bash
cd /opt/gatecontrol
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/setup.sh
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example
bash setup.sh
```

Dann direkt zu [§6 Erster Login](#6-erster-login) — setup.sh erledigt den Rest.

### Variante B — Manuell (volle Kontrolle)

```bash
cd /opt/gatecontrol
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example
curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh
chmod +x update.sh
cp .env.example .env
```

Weiter mit [§4 `.env` konfigurieren](#4-env-konfigurieren).

### Variante C — Offline / Air-gapped

Für Hosts ohne Internetzugriff während des Installs das Image-Tarball aus einem Release laden:

```bash
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/gatecontrol-image.tar.gz
docker load < gatecontrol-image.tar.gz
rm gatecontrol-image.tar.gz
```

Weiter mit `docker-compose.yml` und `.env.example` aus Variante B.

---

## 4. `.env` konfigurieren

Bearbeite `/opt/gatecontrol/.env`. Drei Werte sind **Pflicht**; alle anderen haben sinnvolle Defaults.

### Pflicht

| Variable | Bedeutung | Beispiel |
|---|---|---|
| `GC_ADMIN_PASSWORD` | Anfangspasswort für den `admin`-Account. Wird **nur** beim ersten Start gelesen — spätere Änderungen laufen über das UI. | `R7!xK2#wPq9$Lm4v` |
| `GC_WG_HOST` | Öffentliche IP oder Hostname, den VPN-Clients anrufen. Muss aus dem Internet auf UDP/51820 erreichbar sein. | `gate.example.com` oder `198.51.100.42` |
| `GC_BASE_URL` | Volle URL der Admin-UI. Caddy verwendet den Hostnamen für Let's-Encrypt-Zertifikat. | `https://gate.example.com` |

### Dringend empfohlen

| Variable | Warum | Beispiel |
|---|---|---|
| `GC_CADDY_EMAIL` | Let's Encrypt kontaktiert dich bei Ablauf-Warnungen oder Problemen. Ohne funktioniert, aber du hast keinen Recovery-Kanal. | `admin@example.com` |

### Optional — leer lassen für Auto-Generierung

| Variable | Verhalten bei leer |
|---|---|
| `GC_SECRET` | Ein 48-Byte-Session-Secret wird beim ersten Start generiert und in `/data/.session_secret` (chmod 600) abgelegt. |
| `GC_ENCRYPTION_KEY` | Ein 32-Byte-AES-256-Key wird generiert und in `/data/.encryption_key` (chmod 600) abgelegt. **Unbedingt sichern.** Ein Restore der DB ohne passenden Key schlägt fehl. |

Die komplette Referenz mit WireGuard-Tuning, Rate-Limits, Timeouts, Client-Update-Repos und Lizenzkey steht in der `.env.example` im Repository.

### Datei editieren

```bash
cd /opt/gatecontrol
nano .env   # oder vim oder ein anderer Editor
```

Die drei Pflichtwerte setzen. Speichern und Editor verlassen.

---

## 5. Erster Start

```bash
cd /opt/gatecontrol
docker compose up -d
docker compose logs -f
```

Beim ersten Lauf macht das Entrypoint eine Reihe von Dingen. Zu erwarten ist in etwa diese Reihenfolge:

1. `» Auto-detected egress interface: <name>` — das Netzwerk-Interface für VPN-NAT. Bei Fallback auf `eth0` ist das auf den meisten Cloud-VMs korrekt; Hosts mit ungewöhnlichen NIC-Namen werden automatisch erkannt.
2. `» MASQUERADE rule active: 10.8.0.0/24 → <iface>` — iptables-NAT-Regel ist aktiv.
3. `» Generating WireGuard server keypair...` — nur beim Erststart. Der Private-Key landet in `./data/wireguard/wg0.conf` mit `chmod 600`.
4. `» Session secret generated and saved` — nur beim Erststart.
5. `» Encryption key generated and saved` — nur beim Erststart.
6. `» Generating dnsmasq config (split-horizon for <hostname> → 10.8.0.1)...` — interner DNS.
7. `» Exporting Caddy JSON from DB...` — auf frischer DB sind noch keine User-Routen vorhanden, aber die **Management-UI-Route** (`GC_BASE_URL`-Hostname → `127.0.0.1:3000`) wird automatisch injiziert. Du musst diese Route nicht manuell anlegen.
8. `» Starting services via supervisord...`
9. Caddy bootet, holt sich das Let's-Encrypt-Zertifikat für den `GC_BASE_URL`-Hostnamen. Der erste Cert-Fetch dauert 10–30 Sekunden. Achte auf:
   - `obtaining certificate` gefolgt von
   - `certificate obtained successfully`
   - Bei `lookup <hostname>: no such host` oder `unable to fetch certificate` ist der DNS noch nicht propagiert — der ACME-Client retry automatisch.
10. WireGuard startet, Interface `wg0` kommt hoch.
11. Node.js-Webapp startet auf `127.0.0.1:3000`. Caddy proxied Requests auf dem `GC_BASE_URL`-Hostnamen dorthin.

Log-Tail mit `Ctrl+C` verlassen — der Container läuft im Hintergrund weiter.

---

## 6. Erster Login

Im Browser `GC_BASE_URL` öffnen, z.B. `https://gate.example.com`.

- **Username:** `admin` (konfigurierbar via `GC_ADMIN_USER`)
- **Passwort:** Der Wert aus `GC_ADMIN_PASSWORD`

### Die Management-UI-Route ist automatisch

Du musst **keine** Reverse-Proxy-Route für die Admin-UI selbst anlegen. GateControl liest `GC_BASE_URL` aus und injiziert eine Caddy-Route, die den Hostnamen auf den internen Node.js-Port mappt. Damit ist das Henne-Ei-Problem "Ich brauche die UI, um die UI zu konfigurieren" beim ersten Start gelöst.

### Empfohlene erste Aktionen

1. **Admin-Passwort ändern** — Einstellungen → Profil → Passwort ändern. Ab hier ist `GC_ADMIN_PASSWORD` in der `.env` irrelevant; der Hash liegt in der DB.
2. **SMTP konfigurieren** (optional, aber nützlich) — Einstellungen → SMTP. Erforderlich für Route-Authentifizierung mit E-Mail-OTP, für E-Mail-Alerts und die Test-E-Mail-Funktion.
3. **E-Mail-Alerts konfigurieren** (optional) — Einstellungen → E-Mail-Alerts. Auswählen, welche Event-Gruppen Benachrichtigungen auslösen sollen.
4. **Security-Einstellungen prüfen** — Einstellungen → Security. Die Defaults (Passwort-Komplexität, Account-Lockout nach Fehlversuchen) sind sinnvoll; anpassen an die eigene Policy.

---

## 7. Erster Peer und erste Route

### VPN-Peer anlegen

1. **Peers** → **Neuer Peer**
2. Namen vergeben (z.B. `laptop-alice`).
3. GateControl generiert automatisch ein Keypair und weist eine IP aus `GC_WG_SUBNET` zu (Default `10.8.0.0/24`, erster Peer erhält `10.8.0.2`).
4. **Konfiguration herunterladen** für eine `.conf`-Datei oder den angezeigten QR-Code mit der WireGuard-Mobile-App scannen.
5. Der Peer zeigt sich als online, sobald der Client den ersten Handshake abgeschlossen hat (Status-Punkt in der Peer-Liste beobachten).

### Reverse-Proxy-Route anlegen

Typischer Fall: einen internen Dienst hinter dem VPN über HTTPS und eine öffentliche Domain bereitstellen.

1. DNS-A-Record für `service.example.com` anlegen, der auf die öffentliche IP des GateControl-Hosts zeigt.
2. **Routen** → **Neue Route**
3. **Domain:** `service.example.com`
4. **Ziel:** Peer aus dem Dropdown wählen (z.B. `laptop-alice`); die IP wird automatisch eingetragen. Oder manuell eine IP setzen.
5. **Ziel-Port:** Der Port, auf dem der Dienst im Peer-Netzwerk lauscht (z.B. `80`, `8080`, `5001`).
6. **Backend HTTPS** aktivieren, falls das Ziel ein Self-Signed-TLS nutzt (z.B. Synology DSM auf Port 5001).
7. Speichern.

Innerhalb weniger Sekunden holt Caddy das Zertifikat und beginnt die Route auszuliefern.

---

## 8. Installation verifizieren

### Container-Health

```bash
cd /opt/gatecontrol
docker compose ps
```

Erwartet:

```
NAME          IMAGE                                       STATUS                   PORTS
gatecontrol   ghcr.io/callmetechie/gatecontrol:latest     Up 2 minutes (healthy)
```

Das `(healthy)`-Tag bedeutet, Dockers interner Healthcheck gegen `/health` ist positiv.

### `/health`-Endpunkt

Vom Host aus:

```bash
curl -s http://127.0.0.1:3000/health | jq
```

Erwartet:

```json
{
  "ok": true,
  "version": "1.52.0",
  "uptime": 42,
  "db": true,
  "wireguard": true,
  "caddy": true
}
```

Aus dem Internet (anonym):

```bash
curl -s https://gate.example.com/health
```

Erwartet — anonymen Aufrufern werden keine internen Details geleakt:

```json
{"ok":true}
```

Eingeloggte Admins sehen die vollen Details auch im Browser: öffne `GC_BASE_URL/health` in derselben Registerkarte, in der du eingeloggt bist.

### Container-Logs

```bash
docker compose logs --tail 100
```

Nach dem Boot-Strap sollten keine `level=error`-Zeilen mehr auftauchen. Häufige Nicht-Fehler, die du **ignorieren** kannst:

- `dnsmasq warning: interface wg0 does not currently exist` beim Start — dnsmasq kommt vor wg-quick hoch; `bind-dynamic` fängt das ab.
- `storage cleaning happened too recently; skipping for now` — Caddy-Self-Log bei jedem Start.

---

## 9. Troubleshooting

### Container startet nicht: `GC_ADMIN_PASSWORD is not set or still default`

`GC_ADMIN_PASSWORD` in `.env` auf ein echtes Passwort setzen und `docker compose up -d` erneut ausführen. Das Entrypoint verweigert den Start bei Placeholder `changeme` mit Absicht.

### Container startet nicht: `GC_WG_HOST is not set or still the example value`

Analog — `GC_WG_HOST` in `.env` setzen. Jeder Wert außer `gate.example.com` läuft durch.

### Container beendet sich mit `127.0.0.1:53 is already bound`

Ein anderer Prozess auf dem Host belegt den DNS-Port, den der Container für seinen internen dnsmasq braucht. Konflikt identifizieren und beseitigen:

```bash
ss -lntup | grep ':53 '
```

Häufige Verursacher:

- **NetworkManager-dnsmasq** — `systemctl disable --now NetworkManager` (auf Headless-Servern).
- **libvirt-dnsmasq** — `systemctl disable --now libvirtd` oder libvirts Default-Netzwerk umkonfigurieren.
- **bind9 / named** — stoppen oder GateControl auf einen anderen Host verschieben.

`systemd-resolved` (bindet `127.0.0.53`) kollidiert **nicht**.

### Let's Encrypt scheitert: `unable to fetch certificate`

Häufigste Ursachen in dieser Reihenfolge:

1. **DNS noch nicht propagiert.** Let's Encrypt muss den Hostnamen aus dem Internet zu diesem Host auflösen. `dig +short gate.example.com` muss die öffentliche IP zurückliefern. Bis zu 30 Minuten nach Setzen des Records warten.
2. **Port 80 nicht aus dem Internet erreichbar.** ACME-HTTP-01-Challenges kommen auf Port 80. In der Cloud-Firewall freigeben.
3. **Let's-Encrypt-Rate-Limits erreicht.** Bei vielen Neustarts in kurzer Zeit kann das Limit ca. 1 Stunde greifen. Caddy-Log auf `rateLimited`-Antworten prüfen.

Caddy wiederholt automatisch mit exponentiellem Backoff — der Container muss nicht neu gestartet werden.

### Admin-UI liefert SSL/TLS-Fehler im Browser (`ERR_SSL_PROTOCOL_ERROR`)

Drei Dinge in dieser Reihenfolge prüfen:

1. **Container noch beim Booten?** Der erste Cert-Fetch braucht 10–30 Sekunden. Warten und neu laden.
2. **DNS zeigt auf den richtigen Host?** `curl -v https://gate.example.com 2>&1 | grep -i "connected"` — die IP in den Klammern muss die öffentliche IP dieses Hosts sein.
3. **Jemand hat die Test-Suite gegen das Live-Admin-API laufen lassen?** GateControl nutzt `network_mode: host` für dynamisches L4-Port-Binding. Das Ausführen von `npm test` auf dem Host, während der Container läuft, hat früher die Live-Caddy-Config überschrieben. Seit v1.50.9 gefixt — ältere Versionen updaten, dann ist das Problem dauerhaft weg.

### `/health` liefert 503

JSON-Antwort aus einem Localhost-Call lesen (`curl -s http://127.0.0.1:3000/health`). Welches der Felder `db`, `wireguard`, `caddy` `false` ist, sagt dir, was kaputt ist:

- `db: false` — SQLite-Datei-Permissions falsch oder Platte voll. `ls -la /opt/gatecontrol/data/gatecontrol.db` muss Owner `101:_ssh` zeigen (das ist der Container-User `gatecontrol` aus Host-Sicht).
- `wireguard: false` — `/sys/class/net/wg0` fehlt. `docker compose logs` nach wg-quick-Fehlern durchsuchen.
- `caddy: false` — Caddy-Admin-API auf `127.0.0.1:2019` antwortet nicht. `docker compose logs` nach Caddy-Crashes durchsuchen.

### VPN-Peers verbinden sich, haben aber kein Internet

Die `GC_NET_INTERFACE`-Autodetection wählt das Default-Route-Interface. Bei Hosts mit ungewöhnlichen Namen (z.B. Container-in-Container) kann das fehlschlagen und auf `eth0` zurückfallen. `GC_NET_INTERFACE` explizit in `.env` setzen und neustarten:

```bash
ip route | awk '/^default/ {print $5; exit}'   # echten Interface-Namen ermitteln
```

---

## 10. Backup und Restore

### Was zu sichern ist

Alles unter `/opt/gatecontrol/` — insbesondere:

- `.env` — deine Config (Passwörter, Domain).
- `data/gatecontrol.db` — die Datenbank (Peers, Routen, User, Sessions, Logs).
- `data/.encryption_key` — der AES-256-Key für verschlüsselte DB-Spalten. **Ohne diesen Key ist die DB wertlos.**
- `data/.session_secret` — Cookie-Signing-Key. Ein Verlust entwertet nur bestehende Sessions; nicht kritisch.
- `data/wireguard/wg0.conf` — WireGuard-Server-Private-Key. Wird bei Neuinstall neu erzeugt, bestehende Peers bräuchten dann neue Configs.
- `data/caddy/` — Zertifikate und Private-Keys. Let's Encrypt kann sie neu ausstellen, aber Rate-Limits bei häufigen Restores beachten.

### Voll-Backup (empfohlen)

```bash
BACKUP=/backup/gatecontrol-$(date +%F).tar.gz
tar czf "$BACKUP" -C /opt gatecontrol
chmod 600 "$BACKUP"   # enthält Secrets — entsprechend schützen
```

Das Archiv ist self-contained und kann die komplette Installation wiederherstellen. Verschlüsselt oder auf einem Access-kontrollierten Volume speichern.

### In-UI-Backup

Einstellungen → Backup → **Full backup download**. Liefert eine portable JSON-Datei mit Peers, Routen, Route-Auth-Configs, ACL-Regeln, Settings, Webhooks und verschlüsselten Keys. Wiederherstellen via **Backup hochladen** auf derselben Seite — funktioniert über Instanzen hinweg, solange der Encryption-Key identisch ist (oder dieselbe Instanz ist).

Das In-UI-Backup enthält **keine** Caddy-Zertifikate — die werden nach Restore automatisch neu ausgestellt.

---

## 11. Updates

### Automatisches Update

```bash
cd /opt/gatecontrol
./update.sh
```

`update.sh` pullt das neueste Image aus GHCR, erzeugt den Container nur dann neu, wenn tatsächlich ein neues Image gezogen wurde, und loggt nach `/var/log/gatecontrol-update.log`. Sicher per Cron oder systemd-Timer einplanbar:

```
# /etc/cron.d/gatecontrol-update
0 3 * * * root /opt/gatecontrol/update.sh
```

### Manuelles Update

```bash
cd /opt/gatecontrol
docker compose pull
docker compose up -d
```

Downtime liegt bei etwa 10–30 Sekunden während Container-Restart und Caddy-Reload des persistierten Zustands. Datenmigration ist nie nötig — Migrationen laufen automatisch beim Container-Start mit Per-Step-Commits, sodass ein gescheiterter Schritt keine erfolgreichen Schritte zurückrollt.

### Nach dem Update verifizieren

```bash
curl -s http://127.0.0.1:3000/health | jq .version
```

Der Versions-String muss zum gepullten Tag passen.

---

## 12. Migration bestehender Installationen

Falls du eine ältere GateControl-Installation mit einem **Named Docker Volume** hast (der historische Default), kannst du mit ca. 15 Sekunden Downtime auf das empfohlene Layout in `/opt/gatecontrol/` umziehen. Named Volumes sind vom Host-Dateisystem aus unsichtbar und machen Backups umständlich; Bind-Mounts lösen das.

Schritte:

```bash
# 1. Quelle verifizieren
docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'
# Zeigt "volume <pfad>" → weiter. Zeigt "bind <pfad>" → schon fertig.

# 2. Neue Location vorbereiten
mkdir -p /opt/gatecontrol
cp /pfad/zum/alten/.env /opt/gatecontrol/.env
cat > /opt/gatecontrol/docker-compose.yml <<'EOF'
services:
  gatecontrol:
    image: ghcr.io/callmetechie/gatecontrol:latest
    container_name: gatecontrol
    network_mode: host
    cap_add:
      - NET_ADMIN
    volumes:
      - ./data:/data
    env_file:
      - .env
    restart: unless-stopped
EOF

# 3. Alt stoppen, Daten kopieren, Neu starten (kurze Downtime)
cd /pfad/zum/alten  # wo das alte docker-compose.yml liegt
docker compose down

mkdir -p /opt/gatecontrol/data
VOL_PATH=$(docker volume inspect <alter-volume-name> --format '{{.Mountpoint}}')
cp -a "$VOL_PATH"/. /opt/gatecontrol/data/
chown -R 101:102 /opt/gatecontrol/data

cd /opt/gatecontrol
docker compose up -d

# 4. Verifizieren
docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'
# sollte jetzt zeigen: bind /opt/gatecontrol/data
curl -s http://127.0.0.1:3000/health | jq
```

Das alte Named Volume mindestens 24 Stunden als Fallback liegen lassen. Wenn du sicher bist, dass das neue Setup läuft:

```bash
docker volume rm <alter-volume-name>
```

---

## Hilfe bekommen

- **Bug-Reports / Feature-Requests:** [GitHub Issues](https://github.com/CallMeTechie/gatecontrol/issues)
- **Security-Meldungen:** siehe [SECURITY.md](SECURITY.md)
- **Diskussionen:** [GitHub Discussions](https://github.com/CallMeTechie/gatecontrol/discussions)

Beim Öffnen eines Issues die Ausgabe von Folgendem beilegen:

```bash
docker compose ps
docker compose logs --tail 200
curl -s http://127.0.0.1:3000/health
```

und sensible Werte (Passwörter, Tokens, Private-Keys) vor dem Posten schwärzen.
