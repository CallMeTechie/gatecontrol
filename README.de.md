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
- Peer-Tagging zur Organisation
- Hot-Reload von Konfigurationsänderungen über `wg syncconf` — kein VPN-Neustart erforderlich

### Reverse-Proxy-Routing
- Domain-basiertes Reverse-Proxy-Routing mit Caddy
- Automatisches HTTPS mit Let's-Encrypt-Zertifikaten — Zero-Configuration TLS
- Optionale Basic-Authentifizierung pro Route
- Backend-HTTPS-Unterstützung für Ziele mit selbstsignierten Zertifikaten (z.B. Synology DSM auf Port 5001)
- Routen direkt mit VPN-Peers verknüpfen — die Route zielt automatisch auf die WireGuard-IP des Peers
- Atomare Konfigurationssynchronisation mit Caddy mit automatischem Rollback bei Fehler

### Monitoring & Logging
- Echtzeit-Traffic-Monitoring mit Upload-/Download-Statistiken pro Peer
- Dashboard mit Systemmetriken: verbundene Peers, aktive Routen, CPU, RAM, Uptime
- Traffic-Charts mit 1-Stunden-, 24-Stunden- und 7-Tage-Ansichten
- Vollständiges Aktivitätsprotokoll mit Schweregrad-Stufen und Filterung (Peer erstellt, Route geändert, Login-Events, etc.)
- Caddy-Zugriffsprotokoll mit automatischer Rotation (10 MB, 3 Dateien behalten)

### Backup & Wiederherstellung
- Vollständiges System-Backup als portables JSON (Peers, Routen, Einstellungen, Webhooks)
- Verschlüsselte Schlüssel werden für den Export entschlüsselt — Wiederherstellung auf beliebiger Instanz
- Atomare, transaktionsbasierte Wiederherstellung mit automatischer WireGuard- und Caddy-Resynchronisation
- Backup-Versionierung für Vorwärtskompatibilität

### Webhooks
- Ereignisgesteuerte Benachrichtigungen an externe Dienste
- Abonnement für spezifische Ereignisse oder Wildcard (`*`) für alle Ereignisse
- URL-Validierung blockiert private/interne IP-Bereiche zur SSRF-Prävention
- JSON-Payloads mit Ereignistyp, Nachricht, Details und Zeitstempel

### Internationalisierung
- Vollständige englische und deutsche Sprachunterstützung (200+ Übersetzungsschlüssel)
- Umfasst alle UI-Elemente: Navigation, Formulare, Statusmeldungen, Fehlermeldungen, Dialoge

---

## So funktioniert es

GateControl läuft als einzelner Docker-Container, der drei Dienste über Supervisord orchestriert:

<p align="center">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 520" font-family="Segoe UI, system-ui, sans-serif">
  <rect x="10" y="14" width="960" height="496" rx="12" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-dasharray="8,4"/>
  <rect x="34" y="2" width="180" height="26" rx="6" fill="#2563eb"/>
  <text x="124" y="20" text-anchor="middle" fill="#fff" font-size="12" font-weight="700" letter-spacing="0.5">DOCKER CONTAINER</text>
  <rect x="30" y="44" width="280" height="210" rx="10" fill="#f0fdf4" stroke="#22c55e" stroke-width="1.5"/>
  <rect x="137" y="56" width="40" height="40" rx="9" fill="#dcfce7"/>
  <polygon points="157,63 145,70 145,84 157,91 169,84 169,70" fill="none" stroke="#16a34a" stroke-width="1.3"/>
  <line x1="157" y1="91" x2="157" y2="77" stroke="#16a34a" stroke-width="1.3"/>
  <line x1="145" y1="70" x2="157" y2="77" stroke="#16a34a" stroke-width="1.3"/>
  <line x1="169" y1="70" x2="157" y2="77" stroke="#16a34a" stroke-width="1.3"/>
  <text x="157" y="116" text-anchor="middle" fill="#16a34a" font-size="16" font-weight="700">Caddy</text>
  <text x="157" y="134" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">:80 / :443</text>
  <text x="70" y="164" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>HTTPS</text>
  <text x="70" y="186" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>Reverse Proxy</text>
  <text x="70" y="208" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>Let's Encrypt</text>
  <text x="70" y="230" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>Auto Certificates</text>
  <rect x="350" y="44" width="280" height="210" rx="10" fill="#faf5ff" stroke="#a855f7" stroke-width="1.5"/>
  <rect x="462" y="56" width="40" height="40" rx="9" fill="#f3e8ff"/>
  <circle cx="482" cy="76" r="12" fill="none" stroke="#9333ea" stroke-width="1.3"/>
  <polyline points="476,76 480,80 488,70" fill="none" stroke="#9333ea" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="482" y="116" text-anchor="middle" fill="#9333ea" font-size="16" font-weight="700">WireGuard</text>
  <text x="482" y="134" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">:51820 (UDP)</text>
  <text x="390" y="164" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>VPN Tunnel</text>
  <text x="390" y="186" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>Peer Management</text>
  <text x="390" y="208" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>Key Exchange</text>
  <text x="390" y="230" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>Hot Reload</text>
  <rect x="670" y="44" width="280" height="210" rx="10" fill="#eff6ff" stroke="#3b82f6" stroke-width="1.5"/>
  <rect x="782" y="56" width="40" height="40" rx="9" fill="#dbeafe"/>
  <rect x="790" y="64" width="24" height="24" rx="4" fill="none" stroke="#2563eb" stroke-width="1.3"/>
  <line x1="796" y1="76" x2="808" y2="76" stroke="#2563eb" stroke-width="1.3" stroke-linecap="round"/>
  <line x1="802" y1="70" x2="802" y2="82" stroke="#2563eb" stroke-width="1.3" stroke-linecap="round"/>
  <text x="802" y="116" text-anchor="middle" fill="#2563eb" font-size="16" font-weight="700">Node.js</text>
  <text x="802" y="134" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">:3000 (Express)</text>
  <text x="710" y="164" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>Web UI</text>
  <text x="710" y="186" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>REST API</text>
  <text x="710" y="208" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>Background Tasks</text>
  <text x="710" y="230" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>Auth &amp; Security</text>
  <line x1="310" y1="149" x2="345" y2="149" stroke="#9ca3af" stroke-width="2"/>
  <polygon points="315,145 307,149 315,153" fill="#9ca3af"/>
  <line x1="630" y1="149" x2="665" y2="149" stroke="#9ca3af" stroke-width="2"/>
  <polygon points="635,145 627,149 635,153" fill="#9ca3af"/>
  <line x1="802" y1="254" x2="802" y2="286" stroke="#9ca3af" stroke-width="2" stroke-dasharray="4,3"/>
  <polygon points="798,284 802,294 806,284" fill="#d97706"/>
  <rect x="690" y="296" width="240" height="68" rx="10" fill="#fffbeb" stroke="#f59e0b" stroke-width="1.5"/>
  <rect x="714" y="308" width="36" height="36" rx="8" fill="#fef3c7"/>
  <ellipse cx="732" cy="318" rx="10" ry="4" fill="none" stroke="#d97706" stroke-width="1.2"/>
  <path d="M722,318 v14 c0,2.2 4.5,4 10,4 s10,-1.8 10,-4 v-14" fill="none" stroke="#d97706" stroke-width="1.2"/>
  <path d="M722,326 c0,2.2 4.5,4 10,4 s10,-1.8 10,-4" fill="none" stroke="#d97706" stroke-width="1.2"/>
  <text x="810" y="326" text-anchor="middle" fill="#d97706" font-size="16" font-weight="700">SQLite</text>
  <text x="810" y="346" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">(WAL Mode)</text>
  <rect x="30" y="390" width="930" height="108" rx="9" fill="#f9fafb" stroke="#d1d5db" stroke-width="1" stroke-dasharray="5,3"/>
  <path d="M48,408 h8 l2,-3 h10 a2,2 0 0 1 2,2 v12 a2,2 0 0 1 -2,2 h-20 a2,2 0 0 1 -2,-2 v-9 a2,2 0 0 1 2,-2z" fill="none" stroke="#6b7280" stroke-width="1.2"/>
  <text x="76" y="419" fill="#6b7280" font-size="12" font-weight="700" letter-spacing="0.5">VOLUME: /data</text>
  <text x="50" y="448" fill="#d97706" font-size="13" font-family="monospace">gatecontrol.db</text>
  <text x="195" y="448" fill="#6b7280" font-size="12">── database</text>
  <text x="50" y="472" fill="#d97706" font-size="13" font-family="monospace">wireguard/</text>
  <text x="195" y="472" fill="#6b7280" font-size="12">── WireGuard configs &amp; keys</text>
  <text x="500" y="448" fill="#d97706" font-size="13" font-family="monospace">caddy/</text>
  <text x="645" y="448" fill="#6b7280" font-size="12">── certificates &amp; cache</text>
  <text x="500" y="472" fill="#d97706" font-size="13" font-family="monospace">.encryption_key</text>
  <text x="645" y="472" fill="#6b7280" font-size="12">── AES-256 key</text>
</svg>
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

**Externer Request → Interner Dienst (über Reverse Proxy):**
```
Browser → Caddy (HTTPS/Let's Encrypt) → WireGuard Peer-IP:Port → Interner Dienst
```

Das bedeutet, dass interne Dienste (hinter deinem VPN) mit automatischem HTTPS im Internet erreichbar gemacht werden können — ohne Ports im internen Netzwerk zu öffnen. Caddy leitet den Traffic durch den WireGuard-Tunnel zu Diensten auf Peer-Geräten weiter.

---

## Architektur

```
src/
├── server.js              # Anwendungs-Einstiegspunkt, Hintergrundaufgaben, Graceful Shutdown
├── app.js                 # Express-Setup, Sicherheits-Middleware, Template-Engine
├── db/
│   ├── connection.js      # SQLite mit WAL-Modus und Performance-Pragmas
│   ├── migrations.js      # Schema-Definition (8 Tabellen)
│   └── seed.js            # Admin-Benutzer-Initialisierung beim ersten Start
├── services/              # Geschäftslogik-Schicht
│   ├── peers.js           # Peer CRUD, Schlüsselgenerierung, IP-Zuweisung, WG-Sync
│   ├── wireguard.js       # WireGuard CLI-Wrapper (wg, wg-quick, wg syncconf)
│   ├── routes.js          # Route CRUD, Caddy JSON-Config-Builder, Admin-API-Sync
│   ├── traffic.js         # Periodische Traffic-Snapshots, Chart-Daten-Aggregation
│   ├── peerStatus.js      # Hintergrund-Peer-Online/Offline-Abfrage
│   ├── activity.js        # Aktivitäts-Event-Logging mit Schweregrad-Stufen
│   ├── accessLog.js       # HTTP-Zugriffsprotokoll-Verarbeitung
│   ├── settings.js        # Key-Value Einstellungs-Persistenz
│   ├── backup.js          # Vollständiges Backup/Restore mit atomaren Transaktionen
│   ├── webhook.js         # Ereignisgesteuerte Webhook-Zustellung
│   ├── qrcode.js          # QR-Code-Generierung für Peer-Konfigurationen
│   └── system.js          # Systeminfo (CPU, RAM, Uptime, Festplatte)
├── routes/
│   ├── index.js           # Seitenrouten (Dashboard, Peers, Routen, Logs, Einstellungen)
│   ├── auth.js            # Login/Logout-Handler
│   └── api/               # RESTful API-Endpunkte
│       ├── peers.js       # /api/peers — CRUD, Toggle, Sync, Config-Export
│       ├── routes.js      # /api/routes — CRUD, Toggle
│       ├── dashboard.js   # /api/dashboard — Statistiken, Traffic, Charts
│       ├── settings.js    # /api/settings — Abrufen/Setzen
│       ├── logs.js        # /api/logs — Aktivitäts- + Zugriffslogs mit Filterung
│       ├── wireguard.js   # /api/wg — Status, Neustart
│       ├── caddy.js       # /api/caddy — Status, Neuladen
│       ├── webhooks.js    # /api/webhooks — CRUD
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
| **CSRF-Schutz** | Synchronizer-Token-Pattern via csrf-sync bei allen zustandsändernden Requests |
| **Rate Limiting** | 5 Login-Versuche / 15 Min, 100 API-Requests / 15 Min pro IP (konfigurierbar) |
| **Sicherheits-Header** | Helmet.js mit strikter Content Security Policy, HSTS, X-Frame-Options |
| **CSP-Nonces** | Pro Request `crypto.randomBytes(16)` Nonce für Inline-Scripts |
| **Session-Cookies** | `HttpOnly`, `Secure`, `SameSite=Strict`, konfigurierbares Max-Age |
| **Eingabevalidierung** | Serverseitige Validierung für Domains, IPs, Namen, Beschreibungen |
| **Webhook-SSRF-Schutz** | Blockiert Requests an localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x) |
| **Fehler-Bereinigung** | Detaillierte Fehler nur in der Entwicklung; generische Meldungen in Produktion |

### Container-Sicherheit

- Läuft auf Alpine Linux (minimale Angriffsfläche)
- WireGuard-Konfigurationsdateien mit `chmod 600` gesichert
- Verschlüsselungsschlüssel-Datei mit `chmod 600` gesichert
- Nur benötigte Capabilities: `NET_ADMIN` (Netzwerk-Interface-Verwaltung) und `SYS_MODULE` (Kernel-Modul-Laden)
- Health-Check-Endpoint nur auf internem Port (`127.0.0.1:3000`)

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

---

## Nutzung

### Weboberfläche

Nach dem Start von GateControl navigiere zu deiner konfigurierten `GC_BASE_URL` und melde dich mit deinen Admin-Zugangsdaten an.

**Dashboard** — Überblick über verbundene Peers, aktive Routen, Traffic-Charts und Systemmetriken.

**Peers** — WireGuard VPN-Peers erstellen und verwalten. Jeder Peer erhält eine automatisch zugewiesene IP, generierte Schlüssel und eine herunterladbare Konfigurationsdatei mit QR-Code.

**Routen** — Reverse-Proxy-Routen konfigurieren. Externe Domains auf interne Dienste über deine VPN-Peers abbilden. Caddy verwaltet HTTPS-Zertifikate automatisch.

**Config** — Aktuelle WireGuard-Konfiguration anzeigen (privater Schlüssel maskiert).

**Zertifikate** — Von Caddy verwaltete SSL/TLS-Zertifikate anzeigen.

**Logs** — Aktivitäts- und Zugriffsprotokolle mit Filterung nach Ereignistyp und Schweregrad durchsuchen.

**Einstellungen** — Systemeinstellungen, Backup/Wiederherstellung und Webhook-Konfiguration.

### API

Alle Verwaltungsfunktionen sind über die REST-API unter `/api/*` verfügbar. Requests erfordern eine authentifizierte Session.

```bash
# Beispiel: Alle Peers auflisten
curl -b cookies.txt https://gate.beispiel.de/api/peers

# Beispiel: Neuen Peer erstellen
curl -b cookies.txt -X POST https://gate.beispiel.de/api/peers \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token>" \
  -d '{"name": "mein-laptop", "description": "Arbeitslaptop"}'
```

### Ports

| Port | Protokoll | Dienst |
|------|-----------|--------|
| 80 | TCP | HTTP (automatische Weiterleitung zu HTTPS) |
| 443 | TCP/UDP | HTTPS (Caddy Reverse Proxy) |
| 51820 | UDP | WireGuard VPN |

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
| **Reverse Proxy** | Caddy (automatisches HTTPS) |
| **Template-Engine** | Nunjucks |
| **Passwort-Hashing** | Argon2 (Admin), bcrypt (Route Basic Auth) |
| **Verschlüsselung** | AES-256-GCM (Node.js crypto) |
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
