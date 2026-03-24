# GateControl

🇬🇧 [English](README.md) | 🇩🇪 **Deutsch**

**Vereinheitlichte WireGuard VPN + Caddy Reverse Proxy Verwaltung**

GateControl ist eine selbstgehostete, containerisierte Verwaltungsplattform, die WireGuard VPN Peer-Management mit Caddy Reverse-Proxy-Routing in einer einzigen, sicherheitsorientierten Weboberfläche kombiniert. Sie ist für Selbsthoster und kleine Teams gedacht, die volle Kontrolle über ihre VPN-Infrastruktur und Reverse-Proxy-Konfiguration haben möchten – ohne mehrere Tools jonglieren oder Konfigurationsdateien manuell bearbeiten zu müssen.

---

## Inhaltsverzeichnis

- [Funktionen](#funktionen)
- [So funktioniert es](#so-funktioniert-es)
- [Architektur](#architektur)
- [Sicherheit](#sicherheit)
- [Schnellstart](#schnellstart)
- [Installation](#installation)
- [Konfiguration](#konfiguration)
- [Nutzung](#nutzung)
- [Ergänzende Projekte](#ergänzende-projekte)
- [Tech Stack](#tech-stack)
- [Entwicklung](#entwicklung)
- [Lizenz](#lizenz)

---

## Funktionen

### VPN Peer-Verwaltung
- Erstellen, Bearbeiten, Aktivieren/Deaktivieren und Löschen von WireGuard-Peers über eine übersichtliche Weboberfläche
- Automatische Schlüsselgenerierung (privater Schlüssel, öffentlicher Schlüssel, Preshared Key) — kein manuelles Schlüsselhandling
- Automatische IP-Zuweisung aus einem konfigurierbaren Subnetz (Standard `10.8.0.0/24`)
- Herunterladbare Peer-Konfigurationsdateien und scannbare QR-Codes für mobile Clients
- Echtzeit-Peer-Statusüberwachung (Online/Offline-Erkennung über WireGuard-Handshake)
- **Peer-Gruppen** — Peers nach Team, Standort oder Zweck organisieren mit farbigen Badges, Filter-Dropdown und Gruppen-Verwaltung
- **Batch-Operationen** — Mehrere Peers gleichzeitig aktivieren, deaktivieren oder löschen mit Floating Action Bar
- Peer-Tagging zur Organisation
- **Peer-Ablaufdatum** — Optionales Ablaufdatum pro Peer (1 Tag, 7 Tage, 30 Tage, 90 Tage oder benutzerdefiniert). Abgelaufene Peers werden automatisch durch einen Hintergrund-Task deaktiviert. Visuelle Indikatoren zeigen "Abgelaufen" (rot) und "Läuft bald ab" (orange) an
- Hot-Reload von Konfigurationsänderungen über `wg syncconf` — kein VPN-Neustart erforderlich

### Reverse-Proxy-Routing (Layer 7)
- Domain-basiertes Reverse-Proxy-Routing mit Caddy
- Automatisches HTTPS mit Let's-Encrypt-Zertifikaten — Zero-Configuration TLS
- Optionale Basic-Authentifizierung pro Route
- **Route-Authentifizierung** — Eigene Login-Seite pro Route mit mehreren Auth-Methoden: Email & Passwort, Email & Code (OTP via SMTP), TOTP (Authenticator App). Optionale Zwei-Faktor-Authentifizierung (2FA) mit konfigurierbarer Session-Dauer
- **Custom Branding** — Logo-Upload, Titel, Begrüßungstext, Akzent-/Hintergrundfarbe und Hintergrundbild pro Route-Auth-Login-Seite
- **IP-Zugriffskontrolle / Geo-Blocking** — Per-Route IP/CIDR Whitelist oder Blacklist mit optionaler länderbasierter Filterung via ip2location.io Integration
- **Peer-Zugriffskontrolle (ACL)** — Festlegen, welche WireGuard-Peers auf eine Route zugreifen dürfen. Caddy erzwingt erlaubte Peer-IPs über `remote_ip` Matcher. Konfiguration über Multi-Select-Checkliste in den Route-Einstellungen
- **Gzip/Zstd-Komprimierung** — Per-Route-Toggle für Response-Komprimierung über Caddys `encode` Handler
- **Benutzerdefinierte Request/Response-Header** — Key-Value-Editor pro Route mit CORS- und Security-Header-Presets
- **Per-Route Rate Limiting** — Konfigurierbare Requests/Zeitfenster pro Route via caddy-ratelimit Plugin
- **Retry mit Backoff** — Automatische Wiederholungen bei Backend-Fehler mit konfigurierbarer Anzahl und Status-Code-Matching
- **Mehrere Backends / Load Balancing** — Weighted Round Robin über mehrere Backend-Ziele pro Route. Backends werden über Peer-Dropdown ausgewählt — IPs werden automatisch aus der WireGuard-Peer-Konfiguration aufgelöst
- **Sticky Sessions** — Cookie-basierte Session-Affinität bei Multi-Backend-Routen mit konfigurierbarem Cookie-Name und TTL
- **Circuit Breaker** — Per-Route Circuit Breaker (Closed/Open/Half-Open) der 503 zurückgibt wenn Backends wiederholt ausfallen, mit automatischer Wiederherstellung über Monitoring-Checks
- **Request Mirroring** — Requests asynchron an bis zu 5 sekundäre Backends (über Peer-Dropdown ausgewählt) duplizieren für Testing, Debugging oder Shadow Deployments. Custom Caddy Go-Modul mit async Goroutines, 10 MB Body-Buffer mit sync.Pool und 10s Timeout. Client-Response wird nie von Mirror-Targets beeinflusst
- **Batch-Operationen** — Mehrere Routen gleichzeitig aktivieren, deaktivieren oder löschen
- Backend-HTTPS-Unterstützung für Ziele mit selbstsignierten Zertifikaten (z.B. Synology DSM auf Port 5001)
- Routen direkt mit VPN-Peers verknüpfen — die Route zielt automatisch auf die WireGuard-IP des Peers
- Atomare Konfigurationssynchronisation mit Caddy mit automatischem Rollback bei Fehler

### Layer 4 TCP/UDP Proxy
- Raw TCP- und UDP-Port-Forwarding via [caddy-l4](https://github.com/mholt/caddy-l4) Plugin
- Dienste wie RDP, SSH, Datenbanken oder Game-Server über GateControl erreichbar — ohne dass der Client im VPN sein muss
- Drei TLS-Modi pro Route: **Keiner** (direktes Port-Forwarding), **Durchleitung** (TLS-SNI-Routing ohne Terminierung), **Terminieren** (Caddy verwaltet TLS mit Let's Encrypt)
- Mehrere Dienste auf demselben Port via TLS-SNI-Routing — z.B. `ssh.beispiel.de:8443` und `db.beispiel.de:8443`
- Port-Ranges unterstützt (z.B. `5000-5010` für Multi-Port-Dienste)
- Blockierte-Port-Schutz verhindert versehentliches Binden an System-Ports (80, 443, 2019, 3000, 51820)
- L4-Routen mit WireGuard-Peers verknüpfbar — gleiche Peer-Auswahl wie bei HTTP-Routen
- Host-Networking (`network_mode: host`) für dynamische Port-Bindung ohne Container-Neustart

### Uptime Monitoring
- **Backend-Service-Monitoring** mit HTTP- und TCP-Health-Checks pro Route
- Konfigurierbares Check-Intervall mit per-Route Aktivieren/Deaktivieren
- Dashboard-Widget zeigt überwachte Routen mit Echtzeit-Status (up/down/unknown)
- Automatische Email-Benachrichtigungen bei Route-Ausfall und -Wiederherstellung (integriert mit Email-Alerts)
- Checks laufen im Hintergrund — kein Einfluss auf die Request-Verarbeitung

### Monitoring & Logging
- Echtzeit-Traffic-Monitoring mit Upload-/Download-Statistiken pro Peer
- **Per-Peer Traffic-Verlauf** mit persistenten Gesamtwerten und interaktiven Charts (24h, 7d, 30d)
- Dashboard mit Systemmetriken: verbundene Peers, aktive Routen, CPU, RAM, Uptime
- Traffic-Charts mit 1-Stunden-, 24-Stunden- und 7-Tage-Ansichten
- **Health-Check-Endpoint** (`/health`) zur Verifizierung von Datenbank- und WireGuard-Status
- Vollständiges Aktivitätsprotokoll mit Schweregrad-Stufen und Filterung (Peer erstellt, Route geändert, Login-Events, etc.)
- **Log-Export** — Aktivitäts- und Zugriffsprotokolle als CSV oder JSON herunterladen mit Filter-Unterstützung
- **Prometheus Metrics** — `/metrics` Endpoint mit 12 Gauges für Grafana/Prometheus (Peers, Routen, CPU, RAM, Uptime, Per-Peer Traffic, Per-Route Monitoring-Status)
- Caddy-Zugriffsprotokoll mit automatischer Rotation (10 MB, 3 Dateien behalten)

### Sicherheitseinstellungen
- **Konfigurierbarer Account-Lockout** — Konten nach N Fehlversuchen für eine konfigurierbare Dauer sperren (gilt für Admin- und Route-Auth-Login)
- **Manuelles Entsperren** — Gesperrte Konten direkt auf der Einstellungsseite anzeigen und entsperren
- **Passwort-Komplexität erzwingen** — Konfigurierbare Regeln für Mindestlänge, Großbuchstaben, Zahlen und Sonderzeichen
- Alle Sicherheitseinstellungen über die Weboberfläche verwaltbar (Einstellungen > Sicherheit)

### Backup & Wiederherstellung
- Vollständiges System-Backup als portables JSON (Peers, Routen, Route-Auth-Konfigurationen, ACL-Regeln, Einstellungen, Webhooks)
- **Automatische geplante Backups** — Konfigurierbares Intervall (6h, 12h, täglich, 3 Tage, wöchentlich) mit Aufbewahrungslimit. Backup-Dateien direkt in den Einstellungen verwalten (herunterladen, löschen)
- **Verschlüsselungsschlüssel-Validierung** bei Wiederherstellung — verhindert stille Fehler bei Wiederherstellung auf einer anderen Instanz
- Verschlüsselte Schlüssel werden für den Export entschlüsselt — Wiederherstellung auf beliebiger Instanz
- Atomare, transaktionsbasierte Wiederherstellung mit automatischer WireGuard- und Caddy-Resynchronisation
- Backup-Versionierung für Vorwärtskompatibilität

### Email-Benachrichtigungen
- Event-basiertes Email-Benachrichtigungssystem — jedes Aktivitäts-Event kann einen Email-Alert auslösen
- Konfigurierbar pro Event-Gruppe über Einstellungen > Email-Benachrichtigungen
- Periodische Prüfungen: Backup-Erinnerung (kein Backup seit N Tagen), CPU/RAM-Schwellwert-Alerts (stündlich)
- Alle Alerts nutzen den bestehenden SMTP-Service

**Alert-Event-Gruppen:**

| Gruppe | Events | Auslöser |
|--------|--------|----------|
| **Sicherheit** | `login_failed`, `account_locked`, `password_changed` | Fehlgeschlagener Admin-Login, Kontosperrung ausgelöst, Passwort geändert |
| **Peers** | `peer_connected`, `peer_disconnected`, `peer_created`, `peer_deleted`, `peer_expired` | Peer kommt online/geht offline via WireGuard-Handshake, Peer hinzugefügt/entfernt, Peer durch Ablauf automatisch deaktiviert |
| **Routen** | `route_down`, `route_up`, `route_created`, `route_deleted` | Uptime-Monitor erkennt Route down/recovered, Route hinzugefügt/entfernt |
| **System** | `system_start`, `wg_restart`, `backup_restored`, `backup_reminder`, `resource_alert` | Anwendung gestartet, WireGuard neugestartet, Backup wiederhergestellt, kein Backup seit N Tagen, CPU/RAM über Schwellwert |

### Webhooks
- Ereignisgesteuerte Benachrichtigungen an externe Dienste
- Abonnement für spezifische Ereignisse oder Wildcard (`*`) für alle Ereignisse
- URL-Validierung blockiert private/interne IP-Bereiche zur SSRF-Prävention mit DNS-Rebinding-Schutz
- JSON-Payloads mit Ereignistyp, Nachricht, Details und Zeitstempel

### Internationalisierung
- Vollständige englische und deutsche Sprachunterstützung (400+ Übersetzungsschlüssel)
- Umfasst alle UI-Elemente: Navigation, Formulare, Statusmeldungen, Fehlermeldungen, Dialoge

### API-Tokens
- **Stateless Token-Authentifizierung** für Automatisierung, CI/CD-Pipelines und externe Integrationen
- Scoped Permissions: `full-access`, `read-only` oder pro Ressource (`peers`, `routes`, `settings`, `webhooks`, `logs`, `system`, `backup`)
- Token-Verwaltung in Einstellungen (erstellen, auflisten, widerrufen) — Token-Wert wird nur einmal bei Erstellung angezeigt
- Sichere Speicherung: nur SHA-256-Hash in der Datenbank, `gc_`-Prefix zur einfachen Identifikation
- Akzeptiert via `Authorization: Bearer gc_xxx` oder `X-API-Token: gc_xxx` Header
- Tokens können keine anderen Tokens erstellen (verhindert Privilegien-Eskalation)
- Rate Limiting pro Token-ID

### Responsive UI
- **Mobile Sidebar** mit Hamburger-Menü für Smartphones und Tablets (< 1024px)
- Slide-In-Animation mit Overlay-Backdrop, Focus-Trap und Tastaturnavigation (Escape zum Schließen)
- Desktop-Layout unverändert — Sidebar immer sichtbar auf großen Bildschirmen

### SMTP-Konfiguration
- Integrierte SMTP-Einstellungen für den Versand von E-Mail-Verifizierungscodes
- Konfigurierbar über die Weboberfläche (Host, Port, Benutzer, Passwort, Absender, TLS)
- Test-E-Mail-Funktion zur Überprüfung der SMTP-Konfiguration

---

## So funktioniert es

GateControl läuft als einzelner Docker-Container, der drei Dienste über Supervisord orchestriert:

<p align="center">
  <img src=".github/architecture.svg" alt="GateControl Architektur-Diagramm" width="100%">
</p>

### Startsequenz

1. **Entrypoint** validiert erforderliche Umgebungsvariablen und aktiviert IP-Forwarding
2. **WireGuard-Schlüsselpaar** wird beim ersten Start generiert und unter `/data/wireguard/` gespeichert
3. **AES-256-Verschlüsselungsschlüssel** wird generiert (oder vom vorherigen Lauf geladen) und unter `/data/.encryption_key` gespeichert
4. **Supervisord** startet drei Prozesse in Reihenfolge:
   - **Caddy** (Priorität 10) — Reverse Proxy mit automatischem HTTPS
   - **WireGuard** (Priorität 20) — VPN-Interface via `wg-quick up`
   - **Node.js** (Priorität 30) — Webanwendung mit Hintergrundaufgaben
5. **Hintergrundaufgaben** starten: Traffic-Erfassung (alle 60s), Peer-Status-Abfrage (alle 30s), Datenbereinigung (alle 6h)
6. **Bestehende Routen** werden nach einer 5-Sekunden-Startverzögerung mit Caddy synchronisiert

### Traffic-Fluss

**VPN-Client → Internet:**
```
Client-Gerät → WireGuard-Tunnel (verschlüsselt) → GateControl-Container → iptables NAT → Internet
```

**Externer Request → Interner Dienst (über HTTP Reverse Proxy):**
```
Browser → Caddy (HTTPS/Let's Encrypt) → WireGuard Peer-IP:Port → Interner Dienst
```

**Externer Request → Interner Dienst (über Layer 4 Proxy, z.B. RDP):**
```
RDP-Client → Caddy L4 (TCP/:3389) → WireGuard Peer-IP:3389 → Windows VM
```

Interne Dienste (hinter deinem VPN) können im Internet erreichbar gemacht werden — HTTP-Dienste mit automatischem HTTPS, oder Raw-TCP/UDP-Dienste (RDP, SSH, Datenbanken) via Layer 4 Proxying. Caddy leitet den Traffic durch den WireGuard-Tunnel zu Diensten auf Peer-Geräten weiter, ohne Ports im internen Netzwerk zu öffnen.

---

## Architektur

```
src/
├── server.js              # Anwendungs-Einstiegspunkt, Hintergrundaufgaben, Graceful Shutdown
├── app.js                 # Express-Setup, Sicherheits-Middleware, Template-Engine
├── db/
│   ├── connection.js      # SQLite mit WAL-Modus und Performance-Pragmas
│   ├── migrations.js      # Versionierte Migrationen mit History-Tracking (23 Migrationen)
│   └── seed.js            # Admin-Benutzer-Initialisierung beim ersten Start
├── services/              # Geschäftslogik-Schicht
│   ├── peers.js           # Peer CRUD, Schlüsselgenerierung, IP-Zuweisung, WG-Sync
│   ├── wireguard.js       # WireGuard CLI-Wrapper (wg, wg-quick, wg syncconf)
│   ├── routes.js          # Route CRUD, Caddy JSON-Config-Builder, Admin-API-Sync
│   ├── l4.js              # Layer 4 Server-Gruppierung, Config-Generierung, Konflikterkennung
│   ├── traffic.js         # Periodische Traffic-Snapshots, Per-Peer und aggregierte Chart-Daten
│   ├── lockout.js         # Account-Lockout-Tracking und -Durchsetzung
│   ├── peerStatus.js      # Hintergrund-Peer-Online/Offline-Abfrage
│   ├── activity.js        # Aktivitäts-Event-Logging mit Schweregrad-Stufen
│   ├── accessLog.js       # HTTP-Zugriffsprotokoll-Verarbeitung
│   ├── settings.js        # Key-Value Einstellungs-Persistenz
│   ├── autobackup.js      # Geplante automatische Backups mit Aufbewahrung
│   ├── backup.js          # Vollständiges Backup/Restore mit atomaren Transaktionen
│   ├── email.js           # SMTP E-Mail-Service (OTP-Versand, Test-Emails)
│   ├── routeAuth.js       # Route-Authentifizierung (Sessions, OTP, TOTP, CSRF)
│   ├── webhook.js         # Ereignisgesteuerte Webhook-Zustellung
│   ├── tokens.js          # API-Token CRUD, SHA-256-Hashing, Scope-Durchsetzung
│   ├── qrcode.js          # QR-Code-Generierung für Peer-Konfigurationen
│   └── system.js          # Systeminfo (CPU, RAM, Uptime, Festplatte)
├── routes/
│   ├── index.js           # Seitenrouten (Dashboard, Peers, Routen, Logs, Einstellungen)
│   ├── auth.js            # Login/Logout-Handler
│   ├── routeAuth.js       # Öffentliche Route-Auth-Endpunkte (Verify, Login, Logout)
│   └── api/               # RESTful API-Endpunkte
│       ├── peers.js       # /api/peers — CRUD, Toggle, Sync, Config-Export, Traffic-Charts
│       ├── routes.js      # /api/routes — CRUD, Toggle
│       ├── routeAuth.js   # /api/routes/:id/auth — Route-Auth-Konfigurations-CRUD
│       ├── smtp.js        # /api/smtp — SMTP-Einstellungsverwaltung
│       ├── dashboard.js   # /api/dashboard — Statistiken, Traffic, Charts
│       ├── settings.js    # /api/settings — Abrufen/Setzen, Sicherheitseinstellungen, Lockout-Verwaltung
│       ├── logs.js        # /api/logs — Aktivitäts- + Zugriffslogs mit Filterung
│       ├── wireguard.js   # /api/wg — Status, Neustart
│       ├── caddy.js       # /api/caddy — Status, Neuladen
│       ├── webhooks.js    # /api/webhooks — CRUD
│       ├── tokens.js      # /api/tokens — API-Token-Verwaltung
│       └── system.js      # /api/system — Systeminfo
├── middleware/
│   ├── auth.js            # Session-basierte Authentifizierungs-Guards
│   ├── csrf.js            # CSRF-Token-Schutz (csrf-sync)
│   ├── i18n.js            # Spracherkennung und Übersetzungs-Injektion
│   ├── rateLimit.js       # Rate Limiting (Login + API)
│   ├── sessionStore.js    # SQLite-gestützter Session-Speicher
│   └── locals.js          # Template-Variablen-Injektion
├── utils/
│   ├── crypto.js          # AES-256-GCM-Verschlüsselung, WireGuard-Schlüsselgenerierung
│   ├── ip.js              # IP-Zuweisung aus WireGuard-Subnetz
│   ├── logger.js          # Strukturiertes Logging via Pino
│   └── validate.js        # Eingabevalidierung (Domains, IPs, Namen)
└── i18n/
    ├── en.json            # Englische Übersetzungen
    └── de.json            # Deutsche Übersetzungen
```

---

## Sicherheit

GateControl wurde mit einem Security-First-Ansatz auf jeder Ebene entwickelt.

### Ende-zu-Ende-Verschlüsselung

Der gesamte VPN-Traffic zwischen Clients und dem GateControl-Server wird durch WireGuards moderne Kryptografie Ende-zu-Ende verschlüsselt:

- **Noise Protocol Framework** für den Schlüsselaustausch
- **Curve25519** für Elliptic-Curve Diffie-Hellman (ECDH)
- **ChaCha20-Poly1305** für authentifizierte Verschlüsselung (AEAD)
- **BLAKE2s** für Hashing
- **SipHash24** für Hashtable-Keys

Jede Peer-Verbindung nutzt ein einzigartiges Schlüsselpaar plus einen optionalen Preshared Key (standardmäßig generiert) für Post-Quanten-Resistenz.

### Datenverschlüsselung im Ruhezustand

Sensible Daten in der Datenbank (private Schlüssel, Preshared Keys) werden mit **AES-256-GCM** verschlüsselt:

- 256-Bit-Schlüssel (beim ersten Start automatisch generiert, unter `/data/.encryption_key` mit `chmod 600` gespeichert)
- 96-Bit-zufälliger IV pro Verschlüsselungsoperation
- 128-Bit-Authentifizierungs-Tag zur Integritätsprüfung
- Ciphertext-Format: `iv:tag:encrypted` (hex-kodiert)

### HTTPS & Let's Encrypt

Caddy provisioniert und erneuert TLS-Zertifikate automatisch über **Let's Encrypt** für alle konfigurierten Routen:

- Zero-Configuration HTTPS — einfach eine Domain hinzufügen und Caddy erledigt den Rest
- Automatische HTTP-zu-HTTPS-Weiterleitung auf allen Routen
- Unterstützung für benutzerdefinierte ACME CA (z.B. für interne PKI via `GC_CADDY_ACME_CA`)
- Zertifikatsdaten persistent unter `/data/caddy/` über Container-Neustarts hinweg

### Webanwendungssicherheit

| Schicht | Implementierung |
|---------|----------------|
| **Authentifizierung** | Session-basiert mit Argon2-Passwort-Hashing |
| **Account-Lockout** | Konfigurierbarer Max-Versuche + Sperrdauer für Admin- und Route-Auth-Login. Manuelles Entsperren via UI |
| **Passwort-Komplexität** | Konfigurierbarer Erzwingung von Mindestlänge, Großbuchstaben, Zahlen, Sonderzeichen |
| **CSRF-Schutz** | Synchronizer-Token-Pattern via csrf-sync; domain-gebundene HMAC-signierte Tokens für Route-Auth mit Timing-Safe-Vergleich |
| **Rate Limiting** | 5 Login-Versuche / 15 Min, 100 API-Requests / 15 Min pro IP (konfigurierbar) |
| **Route-Authentifizierung** | Pro-Route-Auth mit Email+Passwort, OTP, TOTP, 2FA. Argon2-Passwort-Hashing, AES-256-GCM-verschlüsselte TOTP-Secrets |
| **Sicherheits-Header** | Helmet.js mit strikter Content Security Policy, HSTS, X-Frame-Options |
| **CSP-Nonces** | Pro Request `crypto.randomBytes(16)` Nonce für Inline-Scripts |
| **Session-Cookies** | `HttpOnly`, `Secure`, `SameSite=Strict`, konfigurierbares Max-Age |
| **Eingabevalidierung** | Serverseitige Validierung für Domains, IPs, Namen, Beschreibungen mit Feld-Level-Fehler-Feedback |
| **Webhook-SSRF-Schutz** | Blockiert Requests an localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, 100.64-127.x CGNAT) mit DNS-Rebinding-Schutz |
| **Fehler-Bereinigung** | Detaillierte Fehler nur in der Entwicklung; generische Meldungen in Produktion |

### Container-Sicherheit

- Läuft auf Alpine Linux (minimale Angriffsfläche)
- WireGuard-Konfigurationsdateien mit `chmod 600` gesichert
- Verschlüsselungsschlüssel-Datei mit `chmod 600` gesichert
- Nur benötigte Capabilities: `NET_ADMIN` (Netzwerk-Interface-Verwaltung) und `SYS_MODULE` (Kernel-Modul-Laden)
- Health-Check-Endpoint (`/health`) überprüft DB-Konnektivität und WireGuard-Interface-Status
- Atomare WireGuard-Config-Schreibvorgänge (Write-to-Tmp + Rename) verhindern Korruption bei Crash
- Graceful Shutdown mit Bereinigung aller Hintergrundaufgaben und Timer

---

## Schnellstart

```bash
# Klonen und starten
git clone https://github.com/CallMeTechie/gatecontrol.git
cd gatecontrol
cp .env.example .env

# .env bearbeiten — mindestens folgende Werte setzen:
#   GC_ADMIN_PASSWORD  (dein Admin-Passwort)
#   GC_WG_HOST         (deine öffentliche IP oder Domain)
#   GC_BASE_URL        (https://deine-domain.de)

docker compose up -d
```

GateControl ist anschließend unter deiner konfigurierten `GC_BASE_URL` erreichbar.

---

## Installation

### Option 1: Online (empfohlen)

Setup-Dateien herunterladen und den interaktiven Installer starten:

```bash
mkdir gatecontrol && cd gatecontrol

# Setup-Dateien vom neuesten Release herunterladen
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/setup.sh
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example

# Interaktives Setup starten (installiert Docker bei Bedarf, zieht Image von GHCR)
sudo bash setup.sh
```

Das Setup-Skript wird:
1. Dein Betriebssystem erkennen (Ubuntu, Debian, Fedora, CentOS, RHEL, Rocky, Alma, Alpine)
2. Docker und Docker Compose installieren, falls nicht vorhanden
3. Das neueste Image von `ghcr.io/callmetechie/gatecontrol` ziehen
4. Dich durch die Konfiguration führen (Domain, Admin-Zugangsdaten, Sprache, etc.)
5. Sichere Secrets automatisch generieren
6. Den Container starten

### Option 2: Offline

Alle Release-Assets inklusive des vorgefertigten Docker-Images herunterladen:

```bash
# Alle Dateien eines bestimmten Releases herunterladen
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/gatecontrol-image.tar.gz
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/setup.sh
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/.env.example

# Setup starten — erkennt die tar.gz und lädt sie lokal
sudo bash setup.sh
```

### Option 3: Docker Compose (manuell)

```bash
git clone https://github.com/CallMeTechie/gatecontrol.git
cd gatecontrol
cp .env.example .env
# .env mit deinen Werten bearbeiten
docker compose up -d
```

### Aktualisierung

```bash
# Neuestes Image ziehen
docker pull ghcr.io/callmetechie/gatecontrol:latest

# Mit neuem Image neu starten
docker compose down && docker compose up -d
```

Deine Daten sind im Docker-Volume `gatecontrol-data` gespeichert und überstehen Updates.

---

## Konfiguration

Alle Konfiguration erfolgt über Umgebungsvariablen in der `.env`-Datei.

### Pflichteinstellungen

| Variable | Beschreibung | Beispiel |
|----------|-------------|---------|
| `GC_ADMIN_PASSWORD` | Admin-Login-Passwort | `MeinSicheresP@ss!` |
| `GC_WG_HOST` | Öffentliche IP oder Domain für WireGuard | `vpn.beispiel.de` |
| `GC_BASE_URL` | Vollständige URL der Weboberfläche | `https://gate.beispiel.de` |

### Anwendung

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `GC_APP_NAME` | `GateControl` | Anwendungsname in der UI |
| `GC_HOST` | `0.0.0.0` | Lausch-Adresse |
| `GC_PORT` | `3000` | Interner Anwendungsport |
| `GC_SECRET` | auto-generiert | Session-Secret (automatisch generiert wenn leer) |
| `GC_DB_PATH` | `/data/gatecontrol.db` | SQLite-Datenbankpfad |
| `GC_LOG_LEVEL` | `info` | Log-Level (debug, info, warn, error) |

### Authentifizierung

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `GC_ADMIN_USER` | `admin` | Admin-Benutzername |
| `GC_SESSION_MAX_AGE` | `86400000` | Session-Lebensdauer in ms (24h) |
| `GC_RATE_LIMIT_LOGIN` | `5` | Max. Login-Versuche pro 15 Min |
| `GC_RATE_LIMIT_API` | `100` | Max. API-Requests pro 15 Min |

### WireGuard

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `GC_WG_INTERFACE` | `wg0` | WireGuard-Interface-Name |
| `GC_WG_PORT` | `51820` | WireGuard-Lausch-Port |
| `GC_WG_SUBNET` | `10.8.0.0/24` | VPN-Subnetz für Peer-IP-Zuweisung |
| `GC_WG_GATEWAY_IP` | `10.8.0.1` | VPN-IP-Adresse des Servers |
| `GC_WG_DNS` | `1.1.1.1,8.8.8.8` | DNS-Server für Clients |
| `GC_WG_ALLOWED_IPS` | `0.0.0.0/0` | Erlaubte IPs für Peers (Full Tunnel) |
| `GC_WG_PERSISTENT_KEEPALIVE` | `25` | Keepalive-Intervall in Sekunden |
| `GC_WG_MTU` | (leer) | Benutzerdefinierte MTU (leer für automatisch) |

### Caddy / HTTPS

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `GC_CADDY_ADMIN_URL` | `http://127.0.0.1:2019` | Caddy Admin-API-URL |
| `GC_CADDY_DATA_DIR` | `/data/caddy` | Caddy-Datenverzeichnis (Zertifikate, Cache) |
| `GC_CADDY_EMAIL` | (leer) | E-Mail für Let's-Encrypt-Registrierung |
| `GC_CADDY_ACME_CA` | (leer) | Benutzerdefinierte ACME CA-URL (für interne PKI) |

### Lokalisierung

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `GC_DEFAULT_LANGUAGE` | `en` | Standardsprache (`en` oder `de`) |
| `GC_DEFAULT_THEME` | `default` | UI-Theme |

### Netzwerk & Verschlüsselung

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `GC_NET_INTERFACE` | `eth0` | Host-Netzwerk-Interface für NAT-Regeln |
| `GC_ENCRYPTION_KEY` | auto-generiert | AES-256-Schlüssel für Datenbankverschlüsselung |

### Layer 4 Proxy

| Variable | Standard | Beschreibung |
|----------|---------|-------------|
| `GC_L4_BLOCKED_PORTS` | `80,443,2019,3000,51820` | Für L4-Routen gesperrte Ports (System-Ports) |
| `GC_L4_MAX_PORT_RANGE` | `100` | Maximale Anzahl Ports in einem Port-Range |

---

## Nutzung

### Weboberfläche

Nach dem Start von GateControl navigiere zu deiner konfigurierten `GC_BASE_URL` und melde dich mit deinen Admin-Zugangsdaten an.

**Dashboard** — Überblick über verbundene Peers, aktive Routen, Traffic-Charts und Systemmetriken.

**Peers** — WireGuard VPN-Peers erstellen und verwalten. Jeder Peer erhält eine automatisch zugewiesene IP, generierte Schlüssel und eine herunterladbare Konfigurationsdatei mit QR-Code. Per-Peer Traffic-Verlauf mit interaktiven Charts (24h, 7d, 30d) und persistenten Upload/Download-Gesamtwerten anzeigen.

**Routen** — Reverse-Proxy-Routen (HTTP) und Layer 4 Proxy-Routen (TCP/UDP) konfigurieren. Externe Domains auf interne Dienste über deine VPN-Peers abbilden. HTTP-Routen erhalten automatisches HTTPS via Caddy. L4-Routen leiten Raw-TCP/UDP-Traffic für Dienste wie RDP, SSH oder Datenbanken weiter.

**Config** — Aktuelle WireGuard-Konfiguration anzeigen (privater Schlüssel maskiert).

**Caddy Konfiguration** — Live-Caddy-Reverse-Proxy-JSON-Konfiguration mit Syntax-Highlighting anzeigen. Als JSON-Datei exportieren.

**Zertifikate** — Von Caddy verwaltete SSL/TLS-Zertifikate anzeigen.

**Logs** — Aktivitäts- und Zugriffsprotokolle mit Filterung nach Ereignistyp und Schweregrad durchsuchen.

**Einstellungen** — Systemeinstellungen, Sicherheitskonfiguration (Account-Lockout, Passwort-Komplexität), SMTP-E-Mail-Konfiguration, Backup/Wiederherstellung und Webhook-Verwaltung.

### API

Alle 68 Verwaltungs-Endpoints sind über die REST-API unter `/api/v1/*` verfügbar (mit abwärtskompatibler `/api/*`-Weiterleitung). Authentifizierung via Session-Cookies oder **API-Tokens** (`Authorization: Bearer gc_xxx`). Alle Antworten nutzen ein standardisiertes `{ ok: true/false }`-Format.

```bash
# Session-Authentifizierung
curl -b cookies.txt https://gate.beispiel.de/api/v1/peers

# API-Token-Authentifizierung (kein CSRF nötig)
curl -H "Authorization: Bearer gc_dein_token" \
  https://gate.beispiel.de/api/v1/peers

# Neuen Peer erstellen
curl -H "Authorization: Bearer gc_dein_token" \
  -X POST https://gate.beispiel.de/api/v1/peers \
  -H "Content-Type: application/json" \
  -d '{"name": "mein-laptop", "description": "Arbeitslaptop"}'
```

Siehe **[API.md](API.md)** für die vollständige Endpoint-Referenz, **[API_GUIDE.md](API_GUIDE.md)** für praktische Integrationsbeispiele (Home Assistant, Python, Node.js, Bash, Telegram/Discord Bots, CI/CD, Prometheus) und **[FEATURES.md](FEATURES.md)** für detaillierte Feature-Dokumentation.

### Netzwerk

GateControl nutzt **Host-Networking** (`network_mode: host`), damit Layer-4-Routen dynamisch neue Ports binden können, ohne den Container neu zu starten.

| Port | Protokoll | Dienst |
|------|-----------|--------|
| 80 | TCP | HTTP (automatische Weiterleitung zu HTTPS) |
| 443 | TCP/UDP | HTTPS (Caddy Reverse Proxy) |
| 51820 | UDP | WireGuard VPN |
| *dynamisch* | TCP/UDP | Layer 4 Routen (konfigurierbar über Weboberfläche) |

---

## Ergänzende Projekte

### docker-wireguard-go

**[docker-wireguard-go](https://github.com/CallMeTechie/docker-wireguard-go)** — WireGuard-Go Docker-Client für Synology NAS (Userspace, kein Kernel-Modul erforderlich).

Wenn du ein Synology NAS ohne Kernel-Modul-Unterstützung mit deinem GateControl-VPN verbinden möchtest, nutze docker-wireguard-go als WireGuard-Client. Erstelle einen Peer in GateControl, lade die Konfiguration herunter und verwende sie mit docker-wireguard-go auf deinem NAS. In Kombination mit GateControls Reverse-Proxy-Routen kannst du Synology-Dienste (DSM, Drive, Photos) mit automatischem HTTPS im Internet verfügbar machen — ohne Ports auf deinem NAS zu öffnen.

```
Internet → GateControl (HTTPS) → WireGuard-Tunnel → docker-wireguard-go (NAS) → DSM :5001
```

Aktiviere **Backend-HTTPS** auf der Route für Dienste, die selbstsignierte Zertifikate verwenden (wie Synology DSM auf Port 5001).

---

## Tech Stack

| Komponente | Technologie |
|------------|------------|
| **Laufzeitumgebung** | Node.js 20 (Alpine Linux) |
| **Framework** | Express.js 4.21 |
| **Datenbank** | SQLite (better-sqlite3, WAL-Modus) |
| **VPN** | WireGuard (wireguard-tools) |
| **Reverse Proxy** | Caddy (automatisches HTTPS) + caddy-l4 (TCP/UDP Proxy) |
| **Template-Engine** | Nunjucks |
| **Passwort-Hashing** | Argon2 (Admin), bcrypt (Route Basic Auth) |
| **TOTP** | otpauth (RFC 6238) |
| **Verschlüsselung** | AES-256-GCM (Node.js crypto) |
| **E-Mail** | Nodemailer (SMTP) |
| **Session-Speicher** | SQLite-gestützt |
| **Sicherheit** | Helmet, csrf-sync, express-rate-limit |
| **Logging** | Pino |
| **Prozess-Manager** | Supervisord |
| **Container** | Docker (Alpine) |
| **CI/CD** | GitHub Actions |
| **Registry** | GitHub Container Registry (GHCR) |

---

## Entwicklung

```bash
# Repository klonen
git clone https://github.com/CallMeTechie/gatecontrol.git
cd gatecontrol

# Abhängigkeiten installieren
npm install

# Im Entwicklungsmodus starten (Auto-Reload bei Dateiänderungen)
npm run dev

# Tests ausführen
npm test
```

### Tests

```bash
# API-Integrationstests ausführen (30+ Tests über alle Endpoint-Gruppen)
npm test
```

Tests decken Auth, Peers, Routes, Dashboard, Settings, Webhooks, Logs, System, Health und Backup Endpoints ab. Tests sind CI-kompatibel und überspringen Tests, die WireGuard/Caddy erfordern, wenn diese nicht verfügbar sind.

### Voraussetzungen

- Node.js >= 20.0.0
- WireGuard Tools (für volle Funktionalität)
- Caddy (für Reverse-Proxy-Funktionen)

### Projektstruktur

- `src/` — Anwendungsquellcode
- `public/` — Statische Frontend-Assets (CSS, JS, Bilder)
- `templates/` — Nunjucks-Seitentemplates
- `config/` — Anwendungskonfiguration
- `tests/` — Unit-Tests
- `deploy/` — Deployment-Dateien (Setup-Skript, Compose-Datei)

---

## Lizenz

Siehe [LICENSE](LICENSE) für Details.
