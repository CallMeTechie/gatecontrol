# HTTP vs. L4 Routing

Erklärt den Unterschied zwischen HTTP-Routing (Layer 7, Domain-basiert) und L4-Routing (Layer 4, Port-basiert) — wann welcher Typ eingesetzt wird, wie TLS-Modi funktionieren und welche Features jeweils verfügbar sind.

---

## Was macht es?

GateControl unterstützt zwei grundlegend verschiedene Routing-Typen:

- **HTTP-Routing (Layer 7):** Caddy analysiert den HTTP-Request, matched nach Domain-Name und leitet an das Backend weiter. Voller Zugriff auf alle HTTP-Features.
- **L4-Routing (Layer 4):** Caddy leitet rohen TCP/UDP-Traffic weiter, ohne den Inhalt zu inspizieren. Matching nach Port, nicht nach Domain.

**HTTP-Routing:**
```
Client  →  https://app.example.com  →  Caddy (matched Domain "app.example.com")  →  Backend 10.8.0.3:8080
Client  →  https://api.example.com  →  Caddy (matched Domain "api.example.com")  →  Backend 10.8.0.4:3000
                                         ↑ Beide auf Port 443, unterschieden durch Domain
```

**L4-Routing:**
```
Client  →  server.example.com:25565  →  Caddy (matched Port 25565)  →  Backend 10.8.0.5:25565
Client  →  server.example.com:2222   →  Caddy (matched Port 2222)   →  Backend 10.8.0.6:22
                                         ↑ Verschiedene Ports, Domain ist egal
```

## HTTP-Routing (Layer 7) im Detail

HTTP-Routing ist der Standard-Modus. Caddy terminiert TLS, liest HTTP-Header und matched anhand des `Host`-Headers.

**Funktionsweise:**
1. Client verbindet sich mit Port 443 (oder 80)
2. TLS-Handshake — Caddy wählt das richtige Zertifikat per SNI
3. Caddy liest den HTTP `Host` Header
4. Match auf konfigurierte Domain → Weiterleitung an Backend
5. Volle HTTP-Verarbeitung: Header-Manipulation, Compression, Auth, etc.

**Alle Route-Features stehen zur Verfügung:**
- Force HTTPS mit Let's Encrypt
- Backend HTTPS
- Compression (Gzip/Zstd)
- Rate Limiting
- Basic Auth / Route Auth
- Peer ACL
- IP Access Control
- Request Mirroring
- Retry on Error
- Circuit Breaker
- Custom Headers
- Load Balancing (mehrere Backends)
- Uptime Monitoring (HTTP Check)
- Sticky Sessions

## L4-Routing (Layer 4) im Detail

L4-Routing leitet rohen TCP- oder UDP-Traffic weiter. Caddy öffnet einen eigenen Port und tunnelt den Traffic zum Backend.

**Drei L4-spezifische Felder:**

### Protocol: TCP oder UDP

| Protocol | Use Cases |
|---|---|
| **TCP** | SSH, Minecraft, SMTP, Datenbanken, die meisten Dienste |
| **UDP** | DNS, Game-Server (manche), VoIP, WireGuard |

### Listen Port

Der Port den Caddy auf dem GateControl-Server öffnet. **Das ist der Port zu dem sich Clients verbinden.**

- **Nicht** der Target Port (der Port auf dem Backend)
- Kann gleich oder unterschiedlich zum Target Port sein
- Muss auf dem GateControl-Server frei sein

### TLS-Modus

| Modus | Beschreibung | Caddy-Verhalten |
|---|---|---|
| **None** | Kein TLS | Caddy leitet rohen TCP/UDP Traffic weiter |
| **Passthrough** | TLS Durchleitung | Caddy matched per SNI, leitet verschlüsselten Traffic weiter ohne zu entschlüsseln |
| **Terminate** | TLS Terminierung | Caddy entschlüsselt TLS (mit LE-Zertifikat), leitet dann unverschlüsselten TCP an Backend |

## Target Port vs. Listen Port

Das ist der wichtigste Unterschied der oft Verwirrung stiftet:

| Feld | Gilt für | Beschreibung |
|---|---|---|
| **Target Port** | Alle Routen (HTTP + L4) | Der Port auf dem Backend-Peer wo der Dienst läuft |
| **Listen Port** | Nur L4-Routen | Der Port den Caddy auf dem GateControl-Server öffnet |

**Beispiel 1: Gleiche Ports**
```
Listen Port 25565 (GateControl)  →  Target Port 25565 (Minecraft auf Peer 10.8.0.4)
Client verbindet sich mit: server.example.com:25565
```

**Beispiel 2: Unterschiedliche Ports**
```
Listen Port 8022 (GateControl)  →  Target Port 22 (SSH auf Peer 10.8.0.2)
Client verbindet sich mit: server.example.com:8022
SSH-Befehl: ssh -p 8022 user@server.example.com
```

**Beispiel 3: Mehrere Dienste, verschiedene Ports**
```
Listen Port 25565  →  Target Port 25565 (Minecraft auf 10.8.0.4)
Listen Port 2222   →  Target Port 22 (SSH auf 10.8.0.2)
Listen Port 5433   →  Target Port 5432 (PostgreSQL auf 10.8.0.3)
```

Bei HTTP-Routen gibt es keinen Listen Port — alle HTTP-Routen teilen sich Port 80/443 und werden per Domain unterschieden.

## TLS-Modi im Detail

### None — Kein TLS

```
Client  ──TCP/UDP──→  Caddy:25565  ──TCP/UDP──→  Backend:25565
         unverschlüsselt             unverschlüsselt
```

- Kein TLS-Handshake, kein SNI
- Caddy sieht den Traffic-Inhalt nicht
- Einfachstes Setup, kein Zertifikat nötig
- **Use Cases:** Minecraft, Game-Server, DNS, plain SMTP, Datenbanken im VPN

### Passthrough — TLS Durchleitung

```
Client  ──TLS──→  Caddy:443  ──TLS──→  Backend:443
         verschlüsselt         verschlüsselt (gleiche Verbindung)
```

- Caddy liest nur den SNI (Server Name) aus dem TLS ClientHello
- Der TLS-Tunnel wird **nicht** aufgebrochen — End-to-End Verschlüsselung
- Das Backend muss ein eigenes gültiges Zertifikat haben
- Caddy kann den Inhalt nicht inspizieren oder modifizieren
- **Use Cases:** Backend mit eigenem LE-Zertifikat, strenge E2E-Verschlüsselungsanforderungen

### Terminate — TLS Terminierung

```
Client  ──TLS──→  Caddy:993  ──TCP──→  Backend:143
         verschlüsselt          unverschlüsselt
         (Let's Encrypt)
```

- Caddy terminiert TLS mit einem Let's Encrypt Zertifikat
- Der Traffic zum Backend ist unverschlüsselt (aber im VPN)
- Matched per SNI, Domain muss angegeben werden
- **Use Cases:** TLS für Dienste die es nicht nativ unterstützen, IMAPS/SMTPS vor plaintext Backend

## Blockierte Ports

Folgende Ports sind reserviert und können nicht als Listen Port verwendet werden:

| Port | Verwendung |
|---|---|
| 80 | Caddy HTTP (ACME Challenge + Redirect) |
| 443 | Caddy HTTPS (HTTP-Routen) |
| 2019 | Caddy Admin API |
| 3000 | GateControl Web UI |
| 51820 | WireGuard VPN |

## Use Cases

### Minecraft Server (TCP, Port 25565, TLS: None)

```
Spieler verbindet sich mit: mc.example.com:25565
L4-Route: Listen Port 25565 → Peer "Gaming-Server" Target Port 25565
Protocol: TCP, TLS: None
```

### SSH-Zugang (TCP, Port 2222 → 22, TLS: None)

```
ssh -p 2222 admin@server.example.com
L4-Route: Listen Port 2222 → Peer "Homeserver" Target Port 22
Protocol: TCP, TLS: None
```
Port 22 wird nicht als Listen Port verwendet um Konflikte mit dem SSH des GateControl-Servers zu vermeiden.

### Mail Server SMTP (TCP, Port 25, TLS: None)

```
Mail-Server verbindet sich mit: mail.example.com:25
L4-Route: Listen Port 25 → Peer "Mailserver" Target Port 25
Protocol: TCP, TLS: None (STARTTLS wird vom Backend gehandelt)
```

### Datenbank (TCP, Port 5433 → 5432, TLS: None)

```
psql -h server.example.com -p 5433 -U myuser mydb
L4-Route: Listen Port 5433 → Peer "DB-Server" Target Port 5432
Protocol: TCP, TLS: None
```

### Game Server (UDP)

```
Spieler verbindet sich mit: game.example.com:27015
L4-Route: Listen Port 27015 → Peer "Game-Server" Target Port 27015
Protocol: UDP, TLS: None
```

## Feature-Vergleich: HTTP vs. L4

| Feature | HTTP (Layer 7) | L4 (Layer 4) |
|---|---|---|
| Routing-Methode | Domain-basiert | Port-basiert |
| HTTPS / Let's Encrypt | Ja | Nur mit TLS Terminate |
| Compression (Gzip/Zstd) | Ja | Nein |
| Rate Limiting | Ja | Nein |
| Custom Headers | Ja | Nein |
| Basic Auth | Ja | Nein |
| Route Auth | Ja | Nein |
| Peer ACL | Ja | Nein |
| IP Access Control | Ja | Nein |
| Request Mirroring | Ja | Nein |
| Retry on Error | Ja | Nein |
| Circuit Breaker | Ja | Nein |
| Uptime Monitoring | HTTP Check | TCP Check |
| Mehrere Backends | Ja (Load Balancing) | Nein |
| Sticky Sessions | Ja | Nein |
| WebSocket | Ja (automatisch) | Ja (als TCP) |
| Protokoll | HTTP/HTTPS | TCP / UDP |

**WebSocket bei HTTP-Routen:** WebSocket-Verbindungen starten als normaler HTTP-Request mit einem speziellen `Connection: Upgrade` Header. Caddy erkennt diesen Header automatisch und schaltet die Verbindung auf eine persistente WebSocket-Verbindung um. Es ist keine zusätzliche Konfiguration nötig — das funktioniert out-of-the-box bei jeder HTTP-Route.

**WebSocket bei L4-Routen:** Da L4 den rohen TCP-Stream weiterleitet ohne den Inhalt zu inspizieren, funktioniert WebSocket hier ebenfalls — Caddy sieht nur TCP-Pakete und leitet sie 1:1 weiter.

## Einrichtung

### HTTP-Route erstellen (UI)

1. **Route Type:** HTTP (Standard)
2. Domain eingeben (z.B. `app.example.com`)
3. Target Peer auswählen
4. Target Port eingeben (z.B. 8080)
5. Features konfigurieren (HTTPS, Auth, etc.)
6. Speichern

### L4-Route erstellen (UI)

1. **Route Type:** L4 umschalten
2. Domain eingeben (wird für TLS Passthrough/Terminate benötigt, bei TLS None optional)
3. Target Peer auswählen
4. **Target Port** eingeben (Port auf dem Backend)
5. **Protocol:** TCP oder UDP auswählen
6. **Listen Port** eingeben (Port auf dem GateControl-Server)
7. **TLS Mode** auswählen (None, Passthrough, Terminate)
8. Speichern

### Über die API

```bash
# HTTP-Route erstellen
curl -X POST https://gatecontrol.example.com/api/v1/routes \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "route_type": "http",
    "domain": "app.example.com",
    "peer_id": 1,
    "target_port": 8080,
    "https_enabled": true
  }'

# L4-Route erstellen (Minecraft)
curl -X POST https://gatecontrol.example.com/api/v1/routes \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "route_type": "l4",
    "domain": "mc.example.com",
    "peer_id": 2,
    "target_port": 25565,
    "l4_protocol": "tcp",
    "l4_listen_port": "25565",
    "l4_tls_mode": "none"
  }'
```

## Wichtige Hinweise

- **L4-Routen belegen exklusive Ports.** Jede L4-Route (ohne TLS) braucht einen eigenen Listen Port. Zwei Routen auf demselben Port und Protokoll ohne TLS erzeugen einen Konflikt.
- Mehrere L4-Routen mit TLS (Passthrough oder Terminate) können sich **denselben Port teilen** — Caddy unterscheidet sie per SNI (Domain im TLS ClientHello).
- Port-Ranges sind möglich (z.B. `25565-25575` für mehrere Minecraft-Server).
- UDP-Routen unterstützen kein TLS (TLS läuft über TCP).
- L4-Routen haben **keine** HTTP-Features: kein Rate Limiting, kein Auth, kein Compression, kein ACL, kein Mirroring, kein Retry, kein Circuit Breaker.
- Die Caddy L4-Konfiguration wird in einem separaten Block (`layer4` App) generiert, getrennt von den HTTP-Servern.
- Wenn du unsicher bist welchen Typ du brauchst: Wenn der Dienst im Browser aufgerufen wird (HTTP/HTTPS), verwende HTTP-Routing. Wenn es ein Nicht-HTTP-Protokoll ist (SSH, Datenbank, Game Server), verwende L4.
