# GateControl Client API

API-Endpoints fuer die Kommunikation zwischen GateControl Desktop-Clients (Windows, macOS, Linux) und dem GateControl Server.

Alle Endpoints liegen unter `/api/v1/client/*` und erfordern eine Authentifizierung per API-Token mit dem Scope `peers` oder `full-access`.

---

## Inhaltsverzeichnis

- [Authentifizierung](#authentifizierung)
- [Verbindungsablauf](#verbindungsablauf)
- [Endpoints](#endpoints)
  - [Ping](#ping)
  - [Register](#register)
  - [Config abrufen](#config-abrufen)
  - [Config-Update pruefen](#config-update-pruefen)
  - [Heartbeat](#heartbeat)
  - [Status melden](#status-melden)
- [Fehlerbehandlung](#fehlerbehandlung)
- [Beispiele](#beispiele)

---

## Authentifizierung

Der Client authentifiziert sich per API-Token. Der Token wird in **Settings > API Tokens** im GateControl Web-Interface erstellt und muss mindestens den Scope `peers` haben.

Der Token kann in drei Header-Varianten gesendet werden:

```
Authorization: Bearer gc_your_token_here
X-API-Token: gc_your_token_here
X-API-Key: gc_your_token_here
```

Zusaetzlich sendet der Client Metadaten-Header:

```
X-Client-Version: 1.0.0
X-Client-Platform: windows
```

### Token erstellen (Admin)

1. GateControl Web-Interface oeffnen
2. **Settings > API Tokens > Token erstellen**
3. Name: z.B. "Windows Client"
4. Scope: `peers` (oder `full-access`)
5. Token kopieren und im Client eintragen

---

## Verbindungsablauf

```
Client                                Server
  │                                      │
  │──── GET /client/ping ───────────────>│  1. Verbindung testen
  │<──── { ok, version } ───────────────│
  │                                      │
  │──── POST /client/register ──────────>│  2. Als Peer registrieren
  │<──── { peerId, config, hash } ──────│     (Peer wird automatisch erstellt)
  │                                      │
  │     [ Client speichert peerId ]      │
  │     [ Client schreibt WG config ]    │
  │     [ Client startet WG tunnel ]     │
  │                                      │
  │──── GET /client/config/check ───────>│  3. Periodisch auf Updates pruefen
  │<──── { updated: false } ────────────│     (alle 300s, hash-basiert)
  │                                      │
  │──── POST /client/heartbeat ─────────>│  4. Heartbeat senden
  │<──── { ok } ────────────────────────│     (periodisch)
  │                                      │
  │──── POST /client/status ────────────>│  5. Status-Events melden
  │<──── { ok } ────────────────────────│     (bei Verbindungsaenderung)
  │                                      │
```

---

## Endpoints

### Ping

Prueft die Erreichbarkeit des Servers und die Gueltigkeit des API-Tokens.

```
GET /api/v1/client/ping
```

**Response:**
```json
{
  "ok": true,
  "version": "1.5.2",
  "timestamp": "2026-03-29T15:00:00.000Z"
}
```

**Fehler:**
| Status | Bedeutung |
|--------|-----------|
| `401`  | Token ungueltig oder fehlend |
| `403`  | Token hat keinen `peers`-Scope |

---

### Register

Registriert den Client als neuen WireGuard-Peer. Der Peer-Name wird automatisch aus dem Hostnamen generiert. Bei Namenskollision wird ein Suffix angefuegt (z.B. `DESKTOP-ABC`, `DESKTOP-ABC-1`).

```
POST /api/v1/client/register
```

**Request Body:**
```json
{
  "hostname": "DESKTOP-ABC123",
  "platform": "win32 10.0.22631",
  "clientVersion": "1.0.0"
}
```

| Feld | Typ | Erforderlich | Beschreibung |
|------|-----|:------------:|-------------|
| `hostname` | string | ja | Windows-Hostname (`os.hostname()`) |
| `platform` | string | nein | Betriebssystem-Info |
| `clientVersion` | string | nein | Client-Version |

**Response (201):**
```json
{
  "ok": true,
  "peerId": 5,
  "peerName": "DESKTOP-ABC123",
  "config": "[Interface]\nPrivateKey = ...\nAddress = 10.8.0.5/32\nDNS = 1.1.1.1,8.8.8.8\n\n[Peer]\nPublicKey = ...\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25\n",
  "hash": "a1b2c3d4e5f6..."
}
```

| Feld | Beschreibung |
|------|-------------|
| `peerId` | Eindeutige Peer-ID (fuer alle weiteren Requests speichern!) |
| `peerName` | Generierter Peer-Name |
| `config` | Vollstaendige WireGuard Client-Konfiguration |
| `hash` | SHA-256 Hash der Config (fuer Update-Erkennung) |

**Fehler:**
| Status | Bedeutung |
|--------|-----------|
| `400`  | Hostname fehlt oder ungueltig |
| `403`  | Peer-Limit der Lizenz erreicht |
| `409`  | Keine freien IP-Adressen im Subnetz |

**Hinweis:** Der erstellte Peer erscheint im GateControl Web-Interface mit dem Tag `desktop-client` und einer Beschreibung mit Plattform-Info.

---

### Config abrufen

Ruft die aktuelle WireGuard-Konfiguration fuer den registrierten Peer ab.

```
GET /api/v1/client/config?peerId=5
```

| Parameter | Typ | Erforderlich | Beschreibung |
|-----------|-----|:------------:|-------------|
| `peerId` | number | ja | Peer-ID (aus `/register` Response) |

Alternativ per Header: `X-Peer-Id: 5`

**Response:**
```json
{
  "ok": true,
  "config": "[Interface]\nPrivateKey = ...\n...",
  "hash": "a1b2c3d4e5f6...",
  "peerName": "DESKTOP-ABC123"
}
```

---

### Config-Update pruefen

Prueft ob sich die WireGuard-Konfiguration seit dem letzten Abruf geaendert hat (hash-basiert). Dieser Endpoint wird periodisch vom Client aufgerufen (Standard: alle 300 Sekunden).

```
GET /api/v1/client/config/check?peerId=5&hash=a1b2c3d4e5f6...
```

| Parameter | Typ | Erforderlich | Beschreibung |
|-----------|-----|:------------:|-------------|
| `peerId` | number | ja | Peer-ID |
| `hash` | string | nein | Letzter bekannter Config-Hash |

**Response (keine Aenderung):**
```json
{
  "ok": true,
  "updated": false
}
```

**Response (Config geaendert):**
```json
{
  "ok": true,
  "updated": true,
  "config": "[Interface]\nPrivateKey = ...\n...",
  "hash": "f6e5d4c3b2a1..."
}
```

**Verhalten:** Wenn kein `hash`-Parameter gesendet wird, liefert der Server immer die aktuelle Config zurueck (`updated: true`).

---

### Heartbeat

Sendet periodisch den aktuellen Verbindungsstatus des Clients an den Server. Aktualisiert den `updated_at`-Timestamp des Peers.

```
POST /api/v1/client/heartbeat
```

**Request Body:**
```json
{
  "peerId": 5,
  "connected": true,
  "rxBytes": 1048576,
  "txBytes": 524288,
  "uptime": 3600,
  "hostname": "DESKTOP-ABC123"
}
```

| Feld | Typ | Erforderlich | Beschreibung |
|------|-----|:------------:|-------------|
| `peerId` | number | ja | Peer-ID |
| `connected` | boolean | nein | VPN-Tunnel aktiv? |
| `rxBytes` | number | nein | Empfangene Bytes |
| `txBytes` | number | nein | Gesendete Bytes |
| `uptime` | number | nein | Verbindungsdauer in Sekunden |
| `hostname` | string | nein | Aktueller Hostname |

**Response:**
```json
{
  "ok": true
}
```

---

### Status melden

Meldet einmalige Status-Events (z.B. Verbindungsaufbau, Trennung, Fehler). Wird im Activity-Log des Servers protokolliert.

```
POST /api/v1/client/status
```

**Request Body:**
```json
{
  "peerId": 5,
  "status": "connected",
  "timestamp": "2026-03-29T15:30:00.000Z"
}
```

| Feld | Typ | Erforderlich | Beschreibung |
|------|-----|:------------:|-------------|
| `peerId` | number | ja | Peer-ID |
| `status` | string | ja | Status-Bezeichnung |
| `timestamp` | string | nein | ISO 8601 Zeitstempel |

**Typische Status-Werte:**

| Status | Bedeutung |
|--------|-----------|
| `connected` | Tunnel erfolgreich aufgebaut |
| `disconnected` | Tunnel getrennt |
| `reconnecting` | Reconnect-Versuch laeuft |
| `error` | Verbindungsfehler |

**Response:**
```json
{
  "ok": true
}
```

---

## Fehlerbehandlung

Alle Fehler folgen dem Standard-Format:

```json
{
  "ok": false,
  "error": "Beschreibung des Fehlers"
}
```

| Status | Bedeutung |
|--------|-----------|
| `400`  | Fehlende oder ungueltige Parameter |
| `401`  | Authentifizierung fehlgeschlagen |
| `403`  | Unzureichende Berechtigungen oder Lizenz-Limit |
| `404`  | Peer nicht gefunden |
| `409`  | Ressourcenkonflikt (z.B. keine IPs verfuegbar) |
| `429`  | Rate Limit ueberschritten (max. 100 Requests/15 Min) |
| `500`  | Server-Fehler |

### Empfohlene Client-Strategie

- **401/403**: Token pruefen, ggf. neu eingeben lassen
- **404**: Peer wurde serverseitig geloescht, erneut registrieren
- **429**: `Retry-After`-Header beachten, Requests reduzieren
- **5xx**: Exponentieller Backoff (2s, 3s, 4.5s, ... max 60s)

---

## Beispiele

### Kompletter Setup-Flow mit curl

```bash
TOKEN="gc_your_token_here"
SERVER="https://gate.example.com"

# 1. Ping
curl -s -H "X-API-Token: $TOKEN" "$SERVER/api/v1/client/ping"
# {"ok":true,"version":"1.5.2","timestamp":"..."}

# 2. Registrieren
REGISTER=$(curl -s -X POST \
  -H "X-API-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"my-pc","platform":"linux","clientVersion":"1.0.0"}' \
  "$SERVER/api/v1/client/register")

PEER_ID=$(echo "$REGISTER" | jq -r '.peerId')
echo "Peer-ID: $PEER_ID"

# 3. Config abrufen
curl -s -H "X-API-Token: $TOKEN" \
  "$SERVER/api/v1/client/config?peerId=$PEER_ID" | jq -r '.config' > wg0.conf

# 4. Config-Update pruefen
HASH=$(echo "$REGISTER" | jq -r '.hash')
curl -s -H "X-API-Token: $TOKEN" \
  "$SERVER/api/v1/client/config/check?peerId=$PEER_ID&hash=$HASH"
# {"ok":true,"updated":false}

# 5. Heartbeat senden
curl -s -X POST \
  -H "X-API-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"peerId\":$PEER_ID,\"connected\":true,\"rxBytes\":0,\"txBytes\":0}" \
  "$SERVER/api/v1/client/heartbeat"

# 6. Status melden
curl -s -X POST \
  -H "X-API-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"peerId\":$PEER_ID,\"status\":\"connected\"}" \
  "$SERVER/api/v1/client/status"
```

### Windows Client Setup

1. Im GateControl Web-Interface: **Settings > API Tokens > Neuen Token erstellen**
   - Name: "Windows Client"
   - Scope: `peers`
   - Token kopieren (wird nur einmal angezeigt!)

2. Im GateControl Windows Client:
   - **Einstellungen** oeffnen
   - Server-URL eintragen (z.B. `https://gate.example.com`)
   - API-Token eintragen (beginnt mit `gc_`)
   - **Verbinden** klicken

3. Der Client registriert sich automatisch, erstellt einen Peer und baut den VPN-Tunnel auf.
