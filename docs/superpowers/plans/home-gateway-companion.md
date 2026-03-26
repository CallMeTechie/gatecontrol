# Home Gateway Companion — docker-wireguard-go Erweiterung

> **WICHTIG: Beim ersten Aufrufen dieses Plans MUSS ein Brainstorming durchgeführt werden (superpowers:brainstorming).** Dieses Dokument ist ein Projektplan, keine fertige Spec. Folgende Themen müssen im Brainstorming geklärt werden:
>
> - Verbindung mit GateControl (API-Design, Gateway-Peer-Konzept, Route-Config-Erweiterung)
> - Lizenzkontrolle (welche Features sind Community/Pro/Lifetime, neue Feature-Keys)
> - Sicherheitskonzept (Auth zwischen GateControl und Gateway, LAN-Isolation)
> - Weitere mögliche Features (Device Discovery, Health Checks, Bandwidth Monitoring, Port Scanning)
> - UI/UX für Gateway-Management in GateControl
> - Deployment-Strategie (Docker Compose, Dokumentation, Setup-Wizard)
> - Kompatibilität mit bestehendem docker-wireguard-go (Breaking Changes?)

---

## Überblick

**Ziel:** docker-wireguard-go (https://github.com/CallMeTechie/docker-wireguard-go) zu einem "Home Gateway" erweitern, das als Companion-Produkt zu GateControl fungiert. Ein einziger WireGuard-Tunnel erschließt ein komplettes Heimnetzwerk — ohne WireGuard auf den Endgeräten.

**Problem heute:**
- Jedes Gerät im Heimnetz braucht einen eigenen WireGuard-Peer
- Viele Geräte können kein WireGuard (Drucker, IoT, Smart TVs, NAS-Systeme)
- Geräte die schlafen (NAS, Desktop) sind nicht erreichbar
- Pro Gerät eine separate Konfiguration in GateControl

**Lösung:**
- docker-wireguard-go läuft auf einem always-on Gerät im Heimnetz (Raspberry Pi, Mini-PC)
- Stellt einen WireGuard-Tunnel zu GateControl her
- Fungiert als LAN-Proxy: leitet Traffic vom Tunnel an lokale Geräte weiter
- Kann schlafende Geräte per Wake-on-LAN aufwecken
- GateControl routet beliebig viele Subdomains über diesen einen Tunnel

---

## Architektur

```
                    Internet
                       │
                ┌──────┴──────┐
                │  GateControl │  (VPS / Cloud)
                │   + Caddy    │
                └──────┬──────┘
                       │ WireGuard-Tunnel (10.8.0.x)
                       │
                ┌──────┴──────┐
                │  docker-     │  (Raspberry Pi / Mini-PC im Heimnetz)
                │  wireguard-  │
                │  go + Proxy  │
                └──────┬──────┘
                       │ LAN (192.168.1.x)
          ┌────────────┼────────────┐────────────┐
          │            │            │            │
     ┌────┴───┐  ┌────┴───┐  ┌────┴───┐  ┌────┴───┐
     │  NAS   │  │ Plex   │  │Desktop │  │Drucker │
     │ .1.10  │  │ .1.20  │  │ .1.30  │  │ .1.40  │
     └────────┘  └────────┘  └────────┘  └────────┘
```

### Routing-Flow (HTTP)

```
User → nas.example.com
  → GateControl Caddy
    → Route: Target 10.8.0.2:8080 (Gateway-Proxy)
      → docker-wireguard-go empfängt Request
        → Liest Routing-Config: nas.example.com → 192.168.1.10:5001
          → Forwarded an NAS im LAN
            → Response zurück durch den Tunnel
```

### Routing-Flow (L4/TCP)

```
User → RDP auf port 13389
  → GateControl Caddy L4
    → Route: Target 10.8.0.2:13389 (Gateway-Proxy)
      → docker-wireguard-go TCP-Forward
        → 192.168.1.30:3389 (Desktop RDP)
```

### Wake-on-LAN Flow

```
User → nas.example.com
  → GateControl: Backend-Check → offline!
    → POST http://10.8.0.2:9876/api/wol
      → { "mac": "AA:BB:CC:DD:EE:FF" }
        → docker-wireguard-go sendet Magic Packet (UDP Broadcast Port 9)
          → NAS wacht auf
            → GateControl Retry → online → Request durch
```

---

## Komponenten

### 1. docker-wireguard-go Erweiterungen

#### 1.1 LAN-Proxy (HTTP)
- Lightweight HTTP Reverse Proxy (Go `net/http/httputil.ReverseProxy`)
- Routing-Tabelle: Domain/Path → LAN-IP:Port
- Routing-Config wird von GateControl via API gepusht
- Health Checks für LAN-Targets

#### 1.2 LAN-Proxy (TCP/UDP)
- TCP Port-Forwarding für L4-Routen
- Port-Mapping: Eingehender Port → LAN-IP:Port
- Konfigurierbar via API

#### 1.3 WoL-Proxy
- HTTP-Endpoint: `POST /api/wol` → `{ "mac": "AA:BB:CC:DD:EE:FF", "interface": "eth0" }`
- Sendet Magic Packet auf lokalem Netzwerk-Interface
- Authentifizierung via Shared Secret oder Token

#### 1.4 Management-API
- `GET /api/status` — Gateway-Status, verbundene LAN-Geräte
- `GET /api/devices` — Erkannte Geräte im LAN (ARP-Tabelle)
- `POST /api/routes` — Routing-Config empfangen von GateControl
- `POST /api/wol` — Wake-on-LAN auslösen
- `GET /api/health` — Health Check für GateControl-Monitoring
- Auth: Shared Secret in Header (`X-Gateway-Token`)

#### 1.5 Device Discovery (optional)
- ARP-Scan des lokalen Netzwerks
- Meldet gefundene Geräte (IP, MAC, Hostname falls verfügbar) an GateControl
- Periodisch oder on-demand

### 2. GateControl Erweiterungen

#### 2.1 Gateway-Peer Konzept
- Neuer Peer-Typ: "Gateway" (zusätzlich zu normalem Peer)
- Gateway-Peer hat eine Proxy-URL und einen Auth-Token
- Ein Gateway-Peer repräsentiert ein ganzes Heimnetzwerk

#### 2.2 Route-Config Erweiterung
- Routen können auf LAN-IPs hinter einem Gateway zeigen
- UI: `Ziel-Peer: [homelab-gw (Gateway)] → LAN-Adresse: [192.168.1.10] → LAN-Port: [5001]`
- GateControl pusht Routing-Config an den Gateway

#### 2.3 WoL-Integration
- Pro Route: WoL-Toggle + MAC-Adresse des Zielgeräts
- Wenn Monitoring "down" meldet → WoL über Gateway auslösen
- Konfigurierbarer Timeout (wie lange warten bis Server hochgefahren)
- Retry nach WoL mit exponential backoff

#### 2.4 LAN-Geräte-Verwaltung (optional)
- Neue Seite oder Settings-Bereich: "LAN Devices"
- Zeigt erkannte Geräte hinter jedem Gateway
- Schnellzuweisung: Gerät auswählen → Route erstellen

---

## Kommunikation GateControl ↔ Gateway

### Push-basiert (GateControl → Gateway)
```
GateControl ändert Route → POST http://10.8.0.2:9876/api/routes
Body: {
  "routes": [
    { "domain": "nas.example.com", "target": "192.168.1.10:5001", "protocol": "http" },
    { "domain": "plex.example.com", "target": "192.168.1.20:32400", "protocol": "http" },
    { "port": 13389, "target": "192.168.1.30:3389", "protocol": "tcp" }
  ],
  "wol": [
    { "domain": "nas.example.com", "mac": "AA:BB:CC:DD:EE:FF" }
  ]
}
```

### Pull-basiert (Gateway → GateControl)
```
Gateway pollt periodisch: GET https://gatecontrol.example.com/api/v1/gateway/config
Header: Authorization: Bearer gc_gateway_token
Response: aktuelle Routing-Config für diesen Gateway
```

### Zu klären im Brainstorming:
- Push vs. Pull vs. Hybrid?
- WebSocket für Echtzeit-Updates?
- Wie wird der Gateway initial mit GateControl verbunden (Pairing)?

---

## Sicherheit

- Gateway-API nur über WireGuard-Tunnel erreichbar (bindet auf 10.8.0.x, nicht auf 0.0.0.0)
- Auth via Shared Secret oder API-Token
- LAN-Targets: nur RFC1918 Adressen erlaubt (kein SSRF ins Internet)
- WoL: nur konfigurierte MAC-Adressen, keine Wildcard
- Rate Limiting auf Gateway-API

---

## Lizenzierung

Zu klären im Brainstorming — Vorschlag:

| Feature | Community | Pro | Lifetime |
|---|---|---|---|
| Gateway-Peer (1 Gateway) | Ja | Ja | Ja |
| Mehrere Gateways | Nein | Ja | Ja |
| LAN HTTP-Routing | 3 Targets | Unbegrenzt | Unbegrenzt |
| LAN TCP-Routing | Nein | Ja | Ja |
| Wake-on-LAN | Nein | Ja | Ja |
| Device Discovery | Nein | Ja | Ja |

Neue Feature-Keys für `COMMUNITY_FALLBACK`:
```javascript
gateway_peers: 1,
gateway_lan_targets: 3,
gateway_tcp_routing: false,
gateway_wol: false,
gateway_discovery: false,
```

---

## Technologie-Stack

### docker-wireguard-go Erweiterungen
- **Sprache:** Go (bestehendes Projekt ist Go)
- **HTTP Proxy:** `net/http/httputil.ReverseProxy`
- **TCP Proxy:** `io.Copy` mit `net.Dial`
- **WoL:** `net.UDPConn` Broadcast auf Port 9
- **ARP Scan:** `github.com/mdlayher/arp` oder Shell-Command `arp -a`
- **Config:** JSON-Datei oder In-Memory (von GateControl gepusht)

### GateControl Erweiterungen
- **DB Migration:** Neue Spalten für Gateway-Peer-Typ, LAN-Target-IP
- **Route-Service:** `routes.js` erweitern für Gateway-Routing
- **API:** Neue Gateway-Endpoints
- **UI:** Gateway-Badge auf Peers, LAN-Target-Felder im Route-Formular

---

## Deployment

### Typisches Setup

**VPS (GateControl):**
```yaml
# docker-compose.yml
services:
  gatecontrol:
    image: ghcr.io/callmetechie/gatecontrol:latest
    network_mode: host
    # ... bestehende Config
```

**Heimnetz (Raspberry Pi):**
```yaml
# docker-compose.yml
services:
  gateway:
    image: ghcr.io/callmetechie/wireguard-go-gateway:latest
    network_mode: host
    cap_add:
      - NET_ADMIN
    environment:
      - GC_GATEWAY_TOKEN=xxx
      - GC_SERVER_URL=https://gatecontrol.example.com
    volumes:
      - ./config:/config
```

---

## Meilensteine

### Phase 1: Grundfunktion
- [ ] Fork von docker-wireguard-go
- [ ] HTTP LAN-Proxy mit statischer Config
- [ ] TCP LAN-Proxy mit Port-Mapping
- [ ] Management-API (Status, Routes, Health)
- [ ] GateControl: Gateway-Peer-Typ + LAN-Target-Felder
- [ ] GateControl: Route-Config Push an Gateway
- [ ] Dokumentation + Docker Image

### Phase 2: Wake-on-LAN
- [ ] WoL-Proxy Endpoint im Gateway
- [ ] GateControl: WoL-Toggle pro Route + MAC-Adresse
- [ ] GateControl: Automatischer WoL bei Backend-Down + Retry
- [ ] Konfigurierbarer WoL-Timeout

### Phase 3: Device Discovery + Polish
- [ ] ARP-Scan im Gateway
- [ ] GateControl: LAN-Geräte-Ansicht
- [ ] GateControl: Schnellzuweisung Gerät → Route
- [ ] Gateway Health Monitoring in GateControl Dashboard
- [ ] Setup-Wizard für Gateway-Pairing

### Phase 4: Erweiterte Features (nach Brainstorming)
- [ ] Bandwidth Monitoring pro LAN-Target
- [ ] Mehrere Gateways (Multi-Site)
- [ ] Gateway-zu-Gateway Routing
- [ ] Automatische Port-Erkennung (welche Ports sind auf einem LAN-Gerät offen)

---

## Offene Fragen für Brainstorming

1. **Naming:** "Gateway", "Home Gateway", "LAN Bridge", "Network Proxy"?
2. **Repo-Strategie:** Fork von docker-wireguard-go oder neues Repo?
3. **Config-Sync:** Push (GC → Gateway) vs. Pull (Gateway → GC) vs. WebSocket?
4. **Pairing:** Wie verbindet sich ein neuer Gateway mit GateControl? QR-Code? Token?
5. **Fallback:** Was passiert wenn der Gateway offline geht? Alle LAN-Routen down?
6. **Multi-Gateway:** Ein GateControl mit Gateways an verschiedenen Standorten?
7. **Bestehendes docker-wireguard-go:** Breaking Changes vermeiden oder neues Image?
8. **Performance:** Wie viel Overhead hat der Proxy? Benchmarks nötig?
9. **IPv6:** Support für IPv6 LAN-Adressen?
10. **mDNS/Bonjour:** Können wir lokale Service-Discovery (Avahi) nutzen?
