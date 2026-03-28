# Request Tracing

## Übersicht

Request Tracing ermöglicht es, detaillierte Informationen über jeden HTTP-Request zu erfassen, der eine Route durchläuft. Es dient als Troubleshooting-Tool wenn eine Route nicht wie erwartet funktioniert — statt zu raten warum ein Request fehlschlägt, sieht der Admin exakt was passiert: Methode, URI, Status-Code, Remote-IP und Response-Details.

**Lizenz-Feature-Key:** `request_debugging`

## Funktionsweise

Request Tracing basiert auf dem [caddy-trace](https://github.com/greenpau/caddy-trace) Plugin für Caddy. Wenn Tracing für eine Route aktiviert ist, wird ein `trace`-Handler in die Caddy-Handler-Chain eingefügt. Dieser Handler loggt für jeden Request zwei Einträge:

1. **Incoming Request:** Methode, URI, Host, Remote-IP, User-Agent, Headers, Query-Parameter
2. **Outgoing Response:** Status-Code, Response-Größe, Response-Headers

Die Trace-Einträge werden in Echtzeit im Debug-Tab des Edit-Route-Modals angezeigt, mit automatischem Refresh alle 3 Sekunden.

### Handler-Position in der Route-Chain

```
1. defender (Bot-Blocker)
2. trace (Request-Tracing)     ← loggt den gesamten Lifecycle
3. headers (Custom Headers)
4. rate_limit
5. mirror (Request Mirroring)
6. encode (Komprimierung)
7. reverse_proxy (Backend)
```

Der trace-Handler sitzt an Position 2 (nach dem Bot-Blocker) und ist ein Wrapping-Middleware — er loggt den Request vor der Verarbeitung und die Response danach. Dadurch erfasst er den finalen Status-Code unabhängig davon welcher Handler die Response erzeugt hat.

## Konfiguration

### Tracing aktivieren

1. Route öffnen (Edit-Modal → **Debug**-Tab)
2. **Request Tracing** Toggle aktivieren
3. Route speichern

Tracing kann auch beim Erstellen einer neuen Route aktiviert werden (in der "Neue Route anlegen"-Card).

### Trace-Einträge anzeigen

1. Route öffnen (Edit-Modal → **Debug**-Tab)
2. Trace-Einträge erscheinen automatisch (Auto-Refresh alle 3 Sekunden)
3. Jeder Eintrag zeigt:

| Spalte | Beschreibung |
|--------|-------------|
| **Zeit** | Zeitstempel des Requests (HH:MM:SS) |
| **Methode** | HTTP-Methode (GET, POST, PUT, DELETE, etc.) |
| **URI** | Angefragter Pfad (z.B. `/api/data`) |
| **Status** | HTTP-Status-Code mit Farbcodierung |
| **Remote-IP** | IP-Adresse des anfragenden Clients |

### Farbcodierung der Status-Codes

| Farbe | Status-Bereich | Bedeutung |
|-------|---------------|-----------|
| Grün | 2xx | Erfolgreiche Requests |
| Gelb | 4xx | Client-Fehler (404, 403, etc.) |
| Rot | 5xx | Server-Fehler (502, 503, etc.) |

### Leeren-Button

Der "Leeren"-Button entfernt alle angezeigten Trace-Einträge aus der Ansicht. Das Polling läuft weiter — neue Requests erscheinen automatisch. Die Log-Datei wird dadurch nicht gelöscht.

## Badge in der Routen-Liste

Wenn Tracing für eine Route aktiv ist, erscheint ein **bernsteinfarbener "Debug"-Badge** in der Routen-Liste. Damit sieht der Admin auf einen Blick welche Routen Tracing aktiv haben.

Das Badge wird nur für HTTP-Routen angezeigt (nicht für L4/TCP-Routen).

## Anwendungsbeispiele

### Beispiel 1: Route gibt 502 zurück

> *"Mein Nextcloud unter cloud.example.com gibt 502 zurück"*

1. Debug-Tab öffnen, Tracing aktivieren, Route speichern
2. Request an cloud.example.com senden
3. Im Debug-Tab erscheint:
   ```
   21:45:54  GET  /  502  10.8.0.3
   ```
4. Status 502 = Backend nicht erreichbar → Peer offline oder Port falsch

### Beispiel 2: Redirect-Schleife

> *"Meine Route leitet endlos weiter"*

1. Tracing aktivieren
2. Im Debug-Tab sieht man mehrere 302-Einträge:
   ```
   21:46:01  GET  /           302  10.8.0.3
   21:46:01  GET  /login      302  10.8.0.3
   21:46:01  GET  /           302  10.8.0.3
   ```
3. Redirect-Schleife zwischen `/` und `/login` → Auth-Konfiguration prüfen

### Beispiel 3: Request kommt nicht an

> *"Meine Route antwortet nicht"*

1. Tracing aktivieren
2. Request senden — kein Eintrag im Debug-Tab
3. Der Request erreicht die Route gar nicht → DNS-Problem oder Caddy-Config prüfen

## API

### Trace-Einträge abrufen

```
GET /api/v1/routes/:id/trace?limit=50&since=1774640938.708
```

**Query-Parameter:**

| Parameter | Typ | Default | Beschreibung |
|-----------|-----|---------|-------------|
| `limit` | Integer | 50 | Max. Anzahl Einträge (max. 200) |
| `since` | String (ISO 8601) | - | Nur Einträge nach diesem Zeitpunkt |

**Response:**

```json
{
  "ok": true,
  "data": {
    "entries": [
      {
        "timestamp": "2026-03-27T21:45:54.741Z",
        "method": "GET",
        "uri": "/",
        "status": 302,
        "remote_ip": "54.36.233.20",
        "host": "nas.domaincaster.com",
        "user_agent": "Mozilla/5.0 ..."
      }
    ]
  }
}
```

### Tracing aktivieren/deaktivieren

Über die bestehende Route-API:

```bash
# Tracing aktivieren
curl -X PUT /api/v1/routes/:id \
  -H "Content-Type: application/json" \
  -d '{"debug_enabled": true}'

# Tracing deaktivieren
curl -X PUT /api/v1/routes/:id \
  -H "Content-Type: application/json" \
  -d '{"debug_enabled": false}'
```

## Einschränkungen

- **Nur HTTP-Routen**: L4/TCP-Routen unterstützen kein Tracing (caddy-trace ist ein HTTP-Handler)
- **Keine Persistenz**: Trace-Daten werden nur in der Caddy-Log-Datei gespeichert, nicht in der Datenbank
- **Kein Export**: Trace-Einträge können nicht als CSV/JSON exportiert werden
- **Kein URI-Filter**: Alle Requests an die Route werden getraced, kein selektives Tracing möglich
- **Performance**: Tracing erzeugt zusätzliche Log-Einträge — bei hochfrequentierten Routen sollte es nur temporär aktiviert werden

## Technische Details

### caddy-trace Plugin

**Repository:** [github.com/greenpau/caddy-trace](https://github.com/greenpau/caddy-trace)
**Handler-Name:** `trace` (`http.handlers.trace`)
**Go-Modul:** `github.com/greenpau/caddy-trace`

### Handler-Config

```json
{
  "handler": "trace",
  "tag": "route-{routeId}",
  "response_debug_enabled": true
}
```

- **tag:** Eindeutiger Identifier pro Route (`route-1`, `route-2`, etc.) — wird zum Filtern der Log-Einträge verwendet
- **response_debug_enabled:** Aktiviert Response-Logging (Status-Code, Response-Größe, Response-Headers)

### Log-Pipeline

1. caddy-trace schreibt Zap-JSON nach **stdout**
2. Supervisord leitet Caddy-stdout via `tee` nach `/data/caddy/caddy-stdout.log`
3. Die Trace-API (`GET /api/v1/routes/:id/trace`) liest diese Datei
4. Einträge werden nach `tag === "route-{id}"` gefiltert
5. Incoming- und Outgoing-Einträge werden per `request_id` zusammengeführt

### Log-Format (caddy-trace Output)

**Incoming Request:**
```json
{
  "level": "debug",
  "time": "2026-03-27T21:45:54.741Z",
  "msg": "debugging request",
  "request_id": "f9c59915-9071-419a-8ca2-46a035bfa356",
  "direction": "incoming",
  "tag": "route-1",
  "method": "GET",
  "host": "nas.domaincaster.com",
  "uri": "/",
  "remote_addr": "54.36.233.20",
  "user_agent": "curl/8.17.0",
  "headers": { "Accept": "*/*" }
}
```

**Outgoing Response:**
```json
{
  "level": "debug",
  "time": "2026-03-27T21:45:54.742Z",
  "msg": "debugging response",
  "request_id": "f9c59915-9071-419a-8ca2-46a035bfa356",
  "direction": "outgoing",
  "tag": "route-1",
  "status_code": 302,
  "response_size": 0,
  "response_headers": { "Location": ["/route-auth/login?..."] }
}
```

### Datenbank

| Spalte | Typ | Default | Beschreibung |
|--------|-----|---------|-------------|
| `debug_enabled` | INTEGER | 0 | Request-Tracing aktiviert (0/1) |

Migration Version 27 (`add_debug_enabled`) — erstellt am 2026-03-27.

### Backup/Restore

`debug_enabled` wird bei Backup/Restore berücksichtigt. Trace-Daten (Log-Datei) werden nicht exportiert.

### UI-Integration

- **Create-Card:** Toggle "Request Tracing" innerhalb von `http-fields` (bei L4 ausgeblendet)
- **Edit-Modal:** Eigener "Debug"-Tab mit Toggle + Trace-Log-Container
- **Debug-Tab** wird bei L4-Routen ausgeblendet
- **Polling:** Auto-Refresh alle 3 Sekunden wenn Debug-Tab aktiv
- **Polling stoppt** bei Tab-Wechsel oder Modal-Close
- **Badge:** Bernsteinfarbener "Debug"-Badge in der Routen-Liste
