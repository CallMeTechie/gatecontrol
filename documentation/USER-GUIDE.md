# GateControl — Benutzerhandbuch

Vollständige Anleitung zur Einrichtung und Nutzung aller Funktionen von GateControl.

---

## Inhaltsverzeichnis

- [Domains & DNS](#domains--dns)
- [Peers einrichten](#peers-einrichten)
- [WireGuard-Clients](#wireguard-clients)
- [Routes einrichten](#routes-einrichten)
- [HTTPS & Let's Encrypt](#https--lets-encrypt)
- [Backend HTTPS](#backend-https)
- [Komprimierung](#komprimierung)
- [Authentifizierung (Basic Auth vs. Route Auth)](#authentifizierung)
- [Zwei-Faktor-Authentifizierung (2FA / TOTP)](#zwei-faktor-authentifizierung)
- [Peer-Zugriffskontrolle (ACL)](#peer-zugriffskontrolle-acl)
- [IP-Zugriffskontrolle / Geo-Blocking](#ip-zugriffskontrolle--geo-blocking)
- [Rate Limiting](#rate-limiting)
- [Wiederholung bei Fehler (Retry)](#wiederholung-bei-fehler-retry)
- [Uptime-Monitoring](#uptime-monitoring)
- [Circuit Breaker](#circuit-breaker)
- [Request Mirroring](#request-mirroring)

---

## Domains & DNS

### Grundprinzip

GateControl fungiert als Reverse Proxy: Anfragen an eine Domain (z.B. `app.example.com`) werden über Caddy an ein Backend weitergeleitet — typischerweise ein Dienst hinter dem WireGuard-Tunnel.

Damit das funktioniert, müssen DNS-Einträge auf die **öffentliche IP des Servers** zeigen, auf dem GateControl läuft.

### DNS-Einträge erstellen

Für jede Domain oder Subdomain die du in GateControl als Route nutzen willst, brauchst du einen DNS-Eintrag:

**A-Record (IPv4):**
```
app.example.com    A    203.0.113.50
nas.example.com    A    203.0.113.50
```

**Wildcard (optional):**
```
*.example.com      A    203.0.113.50
```

Ein Wildcard-Record (`*.example.com`) deckt alle Subdomains ab — du kannst dann beliebig viele Routes erstellen ohne jeweils einen neuen DNS-Eintrag zu setzen.

**AAAA-Record (IPv6, optional):**
```
app.example.com    AAAA    2001:db8::1
```

### Wo DNS konfigurieren?

| Anbieter | Verwaltung |
|---|---|
| Cloudflare | Dashboard → DNS → Add Record |
| Hetzner | DNS Console → Zone → Record hinzufügen |
| IONOS / 1&1 | Domain Center → DNS-Einstellungen |
| Namecheap | Domain List → Manage → Advanced DNS |
| AWS Route 53 | Hosted Zone → Create Record |
| Eigener DNS-Server | Zone-File oder Admin-UI |

### Wichtige Hinweise

- **Propagation:** DNS-Änderungen brauchen 1–60 Minuten bis sie weltweit sichtbar sind
- **TTL:** Setze den TTL auf 300 (5 Minuten) für schnellere Änderungen
- **Proxy:** Wenn du Cloudflare nutzt, setze den Proxy-Status auf **DNS only** (graue Wolke), nicht auf Proxied (orange Wolke). Caddy braucht den direkten Zugriff für Let's Encrypt
- **GateControl DNS-Check:** Beim Erstellen einer Route prüft GateControl automatisch ob die Domain auf die richtige IP zeigt

### Mehrere Domains

Du kannst beliebig viele Domains und Subdomains verwenden:
```
app.example.com        →  10.8.0.2:8080
nas.example.com        →  10.8.0.3:5000
git.andere-domain.de   →  10.8.0.4:3000
```

Jede Domain braucht ihren eigenen DNS-Eintrag der auf die GateControl-Server-IP zeigt.

---

## Peers einrichten

### Was ist ein Peer?

Ein Peer ist ein WireGuard-Endpunkt — ein Gerät oder Server das über den VPN-Tunnel mit GateControl verbunden ist. Jeder Peer bekommt eine eigene IP-Adresse im WireGuard-Subnetz (Standard: `10.8.0.0/24`).

### Peer erstellen (Server-Seite)

1. Navigiere zu **Peers** in der Sidebar
2. Klicke **Add Peer** (oder den + Button auf Mobile)
3. Fülle aus:
   - **Name:** Ein beschreibender Name (z.B. "NAS Zuhause", "Server Büro")
   - **DNS:** DNS-Server für den Client (Standard: `1.1.1.1, 8.8.8.8`)
   - **Persistent Keepalive:** Halte die Verbindung aktiv, empfohlen `25` Sekunden für NAT-Szenarien
   - **Ablaufdatum:** Optional — Peer wird automatisch deaktiviert nach Ablauf
   - **Gruppe:** Optional — organisiere Peers nach Team, Standort oder Zweck
4. Klicke **Save**

GateControl generiert automatisch:
- Privaten Schlüssel (verschlüsselt in der Datenbank gespeichert)
- Öffentlichen Schlüssel
- Preshared Key (zusätzliche Verschlüsselungsschicht)
- Nächste verfügbare IP-Adresse im Subnetz

### Peer-Konfiguration herunterladen

Nach dem Erstellen stehen dir zwei Wege zur Verfügung:

**Config-Datei:**
- Klicke auf den Peer → **Download Config**
- Du erhältst eine `.conf` Datei die du in jedem WireGuard-Client importieren kannst

**QR-Code:**
- Klicke auf das QR-Code Symbol
- Scanne den Code mit der WireGuard-App auf deinem Smartphone

### Peer-Konfiguration (Client-Seite)

Die heruntergeladene Config sieht so aus:

```ini
[Interface]
PrivateKey = <automatisch generiert>
Address = 10.8.0.2/32
DNS = 1.1.1.1, 8.8.8.8

[Peer]
PublicKey = <Server Public Key>
PresharedKey = <automatisch generiert>
Endpoint = dein-server.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

**AllowedIPs Erklärung:**
- `0.0.0.0/0` — Gesamter Traffic über VPN (Full Tunnel)
- `10.8.0.0/24` — Nur Traffic zum VPN-Subnetz (Split Tunnel)

Für Reverse-Proxy-Nutzung reicht Split Tunnel (`10.8.0.0/24`), da nur der GateControl-Server die Peers erreichen muss.

---

## WireGuard-Clients

### Empfohlene Software nach Betriebssystem

| Betriebssystem | Client | Bemerkung |
|---|---|---|
| **Windows** | [WireGuard for Windows](https://www.wireguard.com/install/) | Offizieller Client, einfache Config-Import |
| **macOS** | [WireGuard for macOS](https://apps.apple.com/app/wireguard/id1451685025) | App Store, Menüleisten-Integration |
| **Linux** | `wg-quick` (Paket `wireguard-tools`) | `wg-quick up wg0` mit der .conf Datei |
| **Android** | [WireGuard for Android](https://play.google.com/store/apps/details?id=com.wireguard.android) | QR-Code oder Config-Import |
| **iOS / iPadOS** | [WireGuard for iOS](https://apps.apple.com/app/wireguard/id1441195209) | QR-Code oder Config-Import |
| **Synology NAS** | [docker-wireguard-go](https://github.com/CallMeTechie/docker-wireguard-go) | Empfohlen für NAS-Systeme |
| **Docker (allgemein)** | [docker-wireguard-go](https://github.com/CallMeTechie/docker-wireguard-go) | Funktioniert auf jedem Docker-Host |

### Client einrichten

**Windows / macOS / Smartphone:**
1. WireGuard-App installieren
2. "Tunnel hinzufügen" → Config-Datei importieren (oder QR-Code scannen)
3. Tunnel aktivieren
4. Fertig — der Peer erscheint in GateControl als "Online"

**Linux:**
```bash
# Config-Datei nach /etc/wireguard/ kopieren
sudo cp gatecontrol-peer.conf /etc/wireguard/wg0.conf

# Tunnel starten
sudo wg-quick up wg0

# Automatisch bei Boot starten
sudo systemctl enable wg-quick@wg0
```

### docker-wireguard-go — WireGuard für NAS & Docker

[docker-wireguard-go](https://github.com/CallMeTechie/docker-wireguard-go) ist unser eigenes Companion-Projekt für GateControl. Es ist ein Docker-Container der WireGuard als VPN-Client ausführt — speziell entwickelt für Synology NAS Systeme, aber kompatibel mit jedem Docker-Host.

**Vorteile gegenüber anderen WireGuard-Clients:**

| Feature | Kernel-WireGuard | Standard-Container | docker-wireguard-go |
|---|---|---|---|
| Kernel-Modul nötig | Ja | Ja | **Nein** |
| `SYS_MODULE` Capability | Ja | Ja | **Nein** |
| Synology DSM kompatibel | Nein | Nein | **Ja** |
| Image-Größe | — | ~50-100 MB | **~8.5 MB** |
| Performance | ~1+ Gbit/s | ~1+ Gbit/s | ~200-400 Mbit/s |

**Warum docker-wireguard-go?**

Synology NAS Systeme (besonders ältere Modelle) haben keine WireGuard-Kernel-Module und erlauben kein `SYS_MODULE` Capability in Docker. Herkömmliche WireGuard-Container funktionieren dort nicht. docker-wireguard-go nutzt die offizielle **wireguard-go** Userspace-Implementierung — es braucht nur `NET_ADMIN` und läuft auf jedem System.

Obwohl es primär für Synology entwickelt wurde, funktioniert es auf **jedem Docker-Host**: Raspberry Pi, QNAP, Unraid, TrueNAS, generische Linux-Server etc.

**Einrichtung auf Synology NAS:**

1. Peer in GateControl erstellen und Config herunterladen
2. Config-Datei auf die NAS kopieren (z.B. nach `/volume1/docker/wireguard/wg0.conf`)
3. Container starten:

```yaml
# docker-compose.yml
services:
  wireguard:
    image: ghcr.io/callmetechie/docker-wireguard-go:latest
    container_name: wireguard
    network_mode: host
    cap_add:
      - NET_ADMIN
    volumes:
      - /volume1/docker/wireguard/wg0.conf:/etc/wireguard/wg0.conf:ro
    restart: unless-stopped
```

4. Container starten: `docker compose up -d`
5. Prüfen: `docker exec wireguard wg show` — sollte den Tunnel und Handshake anzeigen
6. In GateControl wird der Peer als "Online" angezeigt

**Performance:** Die Userspace-Implementierung erreicht ~200-400 Mbit/s — mehr als ausreichend für typische NAS-Anwendungen (Dateizugriff, Reverse Proxy, Medienstreaming).

---

## Routes einrichten

### Route erstellen

1. Navigiere zu **Routes** in der Sidebar
2. Klicke **Add Route** (oder den + Button auf Mobile)
3. Wähle den **Routentyp**: HTTP (Layer 7) oder L4 (TCP/UDP)
4. Fülle aus:
   - **Domain:** Die Domain für diese Route (z.B. `app.example.com`)
   - **Beschreibung:** Optional
   - **Target Peer:** Wähle den WireGuard-Peer auf dem der Dienst läuft
   - **Target Port:** Der Port des Dienstes auf dem Peer (z.B. `8080`)
5. Konfiguriere optionale Features (siehe folgende Abschnitte)
6. Klicke **Save & Reload**

GateControl erstellt automatisch die Caddy-Konfiguration und lädt sie ohne Unterbrechung neu.

---

## HTTPS & Let's Encrypt

### Automatisches HTTPS

Wenn "HTTPS erzwingen" aktiviert ist (Standard), übernimmt Caddy automatisch:

1. **Zertifikat beantragen** bei Let's Encrypt
2. **HTTP → HTTPS Redirect** — alle HTTP-Anfragen werden auf HTTPS umgeleitet
3. **Zertifikat erneuern** — automatisch vor Ablauf (alle 60 Tage)

**Voraussetzungen:**
- Die Domain muss per DNS auf die öffentliche IP des GateControl-Servers zeigen
- Port 80 und 443 müssen vom Internet erreichbar sein (für Let's Encrypt ACME Challenge)
- Keine Cloudflare-Proxy (orange Wolke) — nur DNS-only (graue Wolke)

### Konfiguration

Beim Erstellen oder Bearbeiten einer Route:
- **HTTPS erzwingen:** Toggle aktivieren (Standard: an)

Es gibt keine weitere Konfiguration — Caddy erledigt alles automatisch.

### Fehlerbehebung

| Problem | Lösung |
|---|---|
| Zertifikat wird nicht ausgestellt | DNS prüfen: `dig app.example.com` — muss Server-IP zeigen |
| "Too many requests" von Let's Encrypt | Rate Limit erreicht — 5 Zertifikate pro Domain pro Woche |
| Port 80/443 blockiert | Firewall/Router prüfen, Ports forwarden |

---

## Backend HTTPS

### Wann brauche ich das?

Wenn der Zieldienst selbst HTTPS verwendet (z.B. Synology DSM auf Port 5001, Proxmox auf 8006, oder andere Dienste mit selbstsignierten Zertifikaten).

### Konfiguration

Beim Erstellen oder Bearbeiten einer Route:
- **Backend HTTPS:** Toggle aktivieren

Caddy verbindet sich dann per HTTPS zum Backend und akzeptiert selbstsignierte Zertifikate (`insecure_skip_verify`). Die Verbindung Client → Caddy ist weiterhin durch Let's Encrypt gesichert.

```
Client ──HTTPS (Let's Encrypt)──→ Caddy ──HTTPS (self-signed)──→ Backend
```

### Typische Anwendungsfälle

| Dienst | Port | Backend HTTPS nötig? |
|---|---|---|
| Synology DSM | 5001 | Ja |
| Proxmox | 8006 | Ja |
| Home Assistant | 8123 | Nein (HTTP) |
| Nginx/Apache | 80/443 | Je nach Config |
| Node.js App | 3000 | Nein (HTTP) |

---

## Komprimierung

### Was macht es?

Aktiviert Gzip/Zstd-Komprimierung für Responses. Caddy komprimiert Antworten automatisch basierend auf dem `Accept-Encoding` Header des Clients.

### Konfiguration

Beim Erstellen oder Bearbeiten einer Route:
- **Komprimierung:** Toggle aktivieren

### Wann sinnvoll?

- **Ja:** HTML, CSS, JavaScript, JSON-APIs, SVG
- **Nein:** Bilder (JPEG, PNG, WebP), Video, bereits komprimierte Dateien (ZIP, tar.gz)

Typische Einsparung: 60-80% bei Textinhalten.

---

## Authentifizierung

GateControl bietet zwei verschiedene Authentifizierungsmethoden pro Route:

### Basic Auth

HTTP Basic Authentication — der Browser zeigt einen nativen Login-Dialog.

**Vorteile:**
- Einfach einzurichten (Username + Passwort)
- Funktioniert mit allen Browsern und HTTP-Clients
- Keine Session nötig — Credentials werden bei jedem Request mitgesendet

**Nachteile:**
- Kein anpassbares Login-Formular
- Keine 2FA möglich
- Credentials werden bei jedem Request übertragen (Base64, nicht verschlüsselt — HTTPS zwingend!)
- Kein "Ausloggen" möglich (Browser speichert Credentials bis Tab geschlossen wird)

**Einrichtung:**
1. Route erstellen oder bearbeiten
2. Auth-Typ: **Basic Auth** wählen
3. **Username** eingeben
4. **Passwort** eingeben
5. Speichern

### Route Auth

Eigene Login-Seite pro Route mit erweiterten Funktionen.

**Vorteile:**
- Anpassbare Login-Seite (Logo, Farben, Begrüßungstext)
- Mehrere Auth-Methoden (Email & Passwort, Email & Code, TOTP)
- 2FA / Zwei-Faktor-Authentifizierung möglich
- Session-basiert mit konfigurierbarer Dauer (1h bis 30 Tage)
- Sauberes Ausloggen möglich

**Nachteile:**
- Komplexer einzurichten
- Erfordert SMTP-Konfiguration für Email-basierte Methoden

**Einrichtung:**
1. Route erstellen oder bearbeiten
2. Auth-Typ: **Route Auth** wählen
3. Auth-Methode wählen:

| Methode | Beschreibung | SMTP nötig? |
|---|---|---|
| **Email & Passwort** | Login mit Email-Adresse und Passwort | Nein |
| **Email & Code** | Login mit Email, 6-stelliger Code per Email | Ja |
| **TOTP** | Login mit Authenticator App (Google/Microsoft Authenticator, Authy) | Nein |

4. Email-Adresse und Passwort eingeben
5. Session-Dauer wählen (wie lange bleibt der User eingeloggt)
6. Speichern

**Für Email & Code:** SMTP muss unter **Settings → Email** konfiguriert sein.

### Vergleich

| Feature | Basic Auth | Route Auth |
|---|---|---|
| Login-Dialog | Browser-nativ | Custom Login-Seite |
| Branding | Nein | Logo, Farben, Text |
| 2FA / TOTP | Nein | Ja |
| Session-Dauer | Bis Tab geschlossen | Konfigurierbar |
| Ausloggen | Nein | Ja |
| Email-Code (OTP) | Nein | Ja |
| SMTP benötigt | Nein | Nur für Email-Code |
| API-kompatibel | Ja (Header) | Nein (Browser-Session) |
| Einrichtungsaufwand | Minimal | Mittel |

**Empfehlung:**
- **Basic Auth** für APIs, Entwickler-Tools, einfache Dienste
- **Route Auth** für Dienste die von Endnutzern verwendet werden

---

## Zwei-Faktor-Authentifizierung

### Was ist TOTP?

TOTP (Time-based One-Time Password) generiert alle 30 Sekunden einen neuen 6-stelligen Code in einer Authenticator-App. Auch bekannt als "Google Authenticator" oder "2FA".

### Unterstützte Authenticator-Apps

| App | Plattform | Empfehlung |
|---|---|---|
| **Google Authenticator** | Android, iOS | Einfach, weit verbreitet |
| **Microsoft Authenticator** | Android, iOS | Gut für Microsoft-Ökosystem |
| **Authy** | Android, iOS, Desktop | Cloud-Backup der Codes |
| **1Password / Bitwarden** | Alle | Integration in Passwort-Manager |

### TOTP einrichten

**Als eigenständige Auth-Methode:**
1. Route bearbeiten → Auth-Typ: **Route Auth**
2. Methode: **TOTP**
3. Speichern
4. Route erneut bearbeiten → TOTP-Bereich zeigt QR-Code
5. QR-Code mit Authenticator-App scannen
6. Bestätigungs-Code eingeben

**Als zweiter Faktor (2FA):**
1. Route bearbeiten → Auth-Typ: **Route Auth**
2. Methode: **Email & Passwort** (erster Faktor)
3. **Zwei-Faktor-Authentifizierung** Toggle aktivieren
4. Zweiten Faktor wählen:
   - **Email Code** — 6-stelliger Code per Email
   - **TOTP** — Code aus Authenticator App
5. Speichern
6. Bei TOTP als zweitem Faktor: Route erneut bearbeiten → QR-Code scannen

### Login-Ablauf mit 2FA

```
1. User öffnet geschützte URL
2. Redirect zur Login-Seite
3. Email + Passwort eingeben (Faktor 1)
4. Code eingeben (Faktor 2):
   - Email Code: Code wird per Email gesendet
   - TOTP: Code aus Authenticator-App eingeben
5. Session wird erstellt (konfigurierbare Dauer)
6. Redirect zur ursprünglichen URL
```

---

## Peer-Zugriffskontrolle (ACL)

### Was macht es?

Beschränkt den Zugriff auf eine Route auf bestimmte WireGuard-Peers. Nur Geräte die über einen erlaubten Peer verbunden sind können die Route erreichen.

### Wie funktioniert es?

Caddy prüft die IP-Adresse des anfragenden Clients gegen eine Whitelist der erlaubten Peer-IPs (`remote_ip` Matcher). Anfragen von nicht erlaubten IPs werden blockiert.

### Einrichtung

1. Route erstellen oder bearbeiten
2. **Peer-Zugriffskontrolle** Toggle aktivieren
3. In der Peer-Checkliste die erlaubten Peers auswählen
4. Speichern

**Beispiel:** Route `nas.example.com` → Nur Peers "Laptop Büro" und "Smartphone Chef" dürfen zugreifen.

### Anwendungsfälle

- Admin-Panels nur für bestimmte Geräte zugänglich machen
- Entwicklungs-Server nur für das Dev-Team
- Interne Dienste nach Abteilung trennen

---

## IP-Zugriffskontrolle / Geo-Blocking

### Was macht es?

Beschränkt den Zugriff auf eine Route nach IP-Adresse, CIDR-Range oder Land. Funktioniert unabhängig von WireGuard — auch für direkte Internet-Zugriffe.

### Modi

| Modus | Beschreibung |
|---|---|
| **Whitelist** | Nur aufgelistete IPs/Ranges/Länder haben Zugriff |
| **Blacklist** | Aufgelistete IPs/Ranges/Länder werden blockiert, alle anderen haben Zugriff |

### Einrichtung

1. Route erstellen oder bearbeiten
2. **IP-Zugriffskontrolle** Toggle aktivieren
3. Modus wählen: **Whitelist** oder **Blacklist**
4. Regeln hinzufügen:
   - **IP:** Einzelne IP-Adresse (z.B. `203.0.113.50`)
   - **CIDR:** IP-Range (z.B. `10.0.0.0/8`)
   - **Country:** Ländercode (z.B. `DE`, `US`, `GB`)
5. Speichern

**Für Länder-basierte Filterung:** Ein ip2location.io API-Key muss unter **Settings → Advanced → ip2location** konfiguriert sein.

### Beispiele

**Nur aus Deutschland zugreifen:**
- Modus: Whitelist
- Regel: Country `DE`

**China und Russland blockieren:**
- Modus: Blacklist
- Regeln: Country `CN`, Country `RU`

**Nur aus dem Büro-Netzwerk:**
- Modus: Whitelist
- Regel: CIDR `203.0.113.0/24`

---

## Rate Limiting

### Was macht es?

Begrenzt die Anzahl der Anfragen pro IP-Adresse in einem Zeitfenster. Schützt vor Brute-Force-Angriffen, Scraping und übermäßiger API-Nutzung.

### Einrichtung

1. Route erstellen oder bearbeiten
2. **Rate Limiting** Toggle aktivieren
3. Konfigurieren:
   - **Requests:** Maximale Anzahl Anfragen (z.B. `100`)
   - **Zeitfenster:** `1 Sekunde`, `1 Minute`, `5 Minuten`, `1 Stunde`
4. Speichern

### Empfohlene Werte

| Anwendung | Requests | Zeitfenster |
|---|---|---|
| Webseite | 100 | 1 Minute |
| API | 60 | 1 Minute |
| Login-Seite | 10 | 1 Minute |
| Statische Dateien | 500 | 1 Minute |

Wenn ein Client das Limit überschreitet, erhält er den HTTP-Status `429 Too Many Requests`.

---

## Wiederholung bei Fehler (Retry)

### Was macht es?

Wenn das Backend einen Fehlerstatus zurückgibt (z.B. 502, 503, 504), versucht Caddy die Anfrage automatisch erneut. Nützlich bei instabilen Backends oder kurzen Ausfällen.

### Einrichtung

1. Route erstellen oder bearbeiten
2. **Wiederholung bei Fehler** Toggle aktivieren
3. Konfigurieren:
   - **Anzahl Wiederholungen:** 1–10 (Standard: 3)
   - **Status-Codes:** Komma-getrennt (Standard: `502,503,504`)
4. Speichern

### Wie funktioniert es?

```
Client → Caddy → Backend antwortet 502
                  Caddy → Retry 1 → Backend antwortet 502
                  Caddy → Retry 2 → Backend antwortet 200 ✓
         Caddy ← 200 an Client
```

Wenn alle Wiederholungen fehlschlagen, erhält der Client den letzten Fehlerstatus.

### Wann sinnvoll?

- Backend startet gerade neu (kurzer 503)
- Load Balancer mit mehreren Backends (Retry geht an nächsten Backend)
- Instabile Netzwerkverbindungen zum Backend

### Wann NICHT sinnvoll?

- POST/PUT Requests die nicht idempotent sind (Retry könnte doppelte Aktionen auslösen)
- Backend ist permanent down (dafür gibt es Circuit Breaker)

---

## Uptime-Monitoring

### Was macht es?

Prüft regelmäßig ob eine Route erreichbar ist. Bei Ausfall werden Benachrichtigungen gesendet (Email, Webhook).

### Einrichtung

1. Route erstellen oder bearbeiten
2. **Uptime Monitoring** Toggle aktivieren
3. Speichern

### Konfiguration (global)

Unter **Settings → Monitoring:**

| Einstellung | Beschreibung | Standard |
|---|---|---|
| **Intervall** | Wie oft geprüft wird | 60 Sekunden |
| **Email-Benachrichtigung** | Bei Status-Änderung Email senden | Aus |
| **Alert-Email** | Empfänger-Adresse | — |

### Was wird geprüft?

- **HTTP-Routes:** HTTP GET auf die Domain, erwartet Status 2xx
- **TCP-Routes (L4):** TCP-Verbindungsaufbau zum Port

### Status

| Status | Bedeutung | Badge |
|---|---|---|
| `up` | Route ist erreichbar | Grün |
| `down` | Route ist nicht erreichbar | Rot |
| `unknown` | Noch nicht geprüft | Grau |

### Benachrichtigungen

Bei Status-Änderung (up → down oder down → up):
- **Email:** Wenn unter Settings aktiviert und SMTP konfiguriert
- **Webhook:** Wenn Webhooks für `route_monitor_up` / `route_monitor_down` konfiguriert sind

---

## Circuit Breaker

### Was macht es?

Wenn ein Backend wiederholt ausfällt, blockiert der Circuit Breaker alle Anfragen an diese Route temporär und gibt sofort `503 Service Unavailable` zurück. Das verhindert, dass Anfragen an ein totes Backend hängen bleiben und Ressourcen verschwenden.

### Voraussetzung

**Uptime Monitoring muss aktiviert sein** — der Circuit Breaker nutzt die Monitoring-Ergebnisse um den Status zu bestimmen.

### Einrichtung

1. Route erstellen oder bearbeiten
2. **Uptime Monitoring** aktivieren (falls noch nicht aktiv)
3. **Circuit Breaker** Toggle aktivieren
4. Konfigurieren:
   - **Schwellwert:** Anzahl aufeinanderfolgender Fehler bis der Breaker öffnet (Standard: 5)
   - **Timeout:** Sekunden bis der Breaker einen erneuten Versuch erlaubt (Standard: 30)
5. Speichern

### Status-Machine

```
    ┌─────────┐  Fehler ≥ Schwellwert  ┌──────┐
    │ CLOSED  │ ─────────────────────→  │ OPEN │
    │ (normal)│                         │(503) │
    └─────────┘                         └──────┘
         ↑                                  │
         │                          Timeout abgelaufen
         │                                  ↓
         │        Erfolg            ┌───────────┐
         └────────────────────────  │ HALF-OPEN │
                                    │ (1 Test)  │
                  Fehler            └───────────┘
              ┌──────────────────→  zurück zu OPEN
```

| Status | Verhalten |
|---|---|
| **Closed** | Normal — alle Requests gehen ans Backend |
| **Open** | Blockiert — sofort 503, kein Backend-Kontakt |
| **Half-Open** | Test — ein einzelner Request wird durchgelassen. Bei Erfolg → Closed, bei Fehler → Open |

### Manueller Reset

In der Route-Liste: Klicke auf den Circuit Breaker Badge → "Reset" um den Breaker manuell zu schließen.

---

## Request Mirroring

### Was macht es?

Dupliziert jeden eingehenden HTTP-Request asynchron an ein oder mehrere sekundäre Backends ("Mirror Targets"). Der Client erhält immer nur die Antwort vom primären Backend — Mirror-Targets beeinflussen die Antwort nie.

```
Client → Caddy → [Mirror] ──async──→ Mirror Target 1
                    │       ──async──→ Mirror Target 2
                    ↓
              [Reverse Proxy] → Primäres Backend → Antwort an Client
```

### Anwendungsfälle

- **Neue Version testen:** Produktions-Traffic an eine Staging-Instanz spiegeln
- **Debugging:** Traffic an ein Logging-Backend senden das alles aufzeichnet
- **Lasttest:** Prüfen ob ein neues Backend realen Traffic aushält
- **Shadow Deployment:** Neue Version parallel laufen lassen und Ergebnisse vergleichen

### Einrichtung

1. Route erstellen oder bearbeiten
2. **Request Mirroring** Toggle aktivieren
3. **Ziel hinzufügen** klicken
4. IP-Adresse und Port des Mirror-Targets eingeben
5. Bis zu **5 Mirror-Targets** pro Route möglich
6. Speichern

### Wichtige Hinweise

- **Schreibende Requests werden auch gespiegelt** (POST, PUT, DELETE). Das Mirror-Target führt diese aus. Nutze ein Read-Only oder Test-Backend als Mirror-Target.
- **Body-Limit:** Request-Bodies bis 10 MB werden vollständig gespiegelt. Größere Bodies werden ohne Body gespiegelt (Headers/Method/URI only).
- **Timeout:** Mirror-Requests haben einen 10-Sekunden-Timeout. Langsame Targets beeinflussen den Client nicht.
- **WebSocket:** WebSocket-Upgrades werden nicht gespiegelt.
- **Nur HTTP-Routes:** Request Mirroring ist für L4 (TCP/UDP) Routes nicht verfügbar.

### API

```bash
# Mirror aktivieren
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "mirror_enabled": true,
    "mirror_targets": [
      {"ip": "203.0.113.10", "port": 8080},
      {"ip": "203.0.113.11", "port": 9090}
    ]
  }'
```
