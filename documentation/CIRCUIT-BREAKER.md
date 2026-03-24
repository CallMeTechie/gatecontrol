# Circuit Breaker

Blockiert Anfragen an ausgefallene Backends und gibt sofort HTTP 503 zurück — verhindert Request-Staus und schützt Backends vor Überlastung bei der Wiederherstellung.

---

## Was macht es?

Der Circuit Breaker erkennt, wenn ein Backend wiederholt nicht erreichbar ist, und schaltet die Route in einen Sperrmodus. Statt Anfragen ins Leere zu schicken (und Clients warten zu lassen), antwortet Caddy sofort mit 503.

**Ohne Circuit Breaker:**
```
Client 1  →  Caddy  →  Backend (tot)  →  30s Timeout  →  502
Client 2  →  Caddy  →  Backend (tot)  →  30s Timeout  →  502
Client 3  →  Caddy  →  Backend (tot)  →  30s Timeout  →  502
... 100 Clients warten gleichzeitig 30 Sekunden ...
```

**Mit Circuit Breaker:**
```
Monitoring: Backend tot (5x hintereinander)  →  Circuit Breaker: OPEN
Client 1  →  Caddy  →  503 "Service temporarily unavailable" (sofort, <1ms)
Client 2  →  Caddy  →  503 (sofort)
... nach 30s Timeout ...
Monitoring: Backend wieder da  →  Circuit Breaker: CLOSED
Client 3  →  Caddy  →  Backend  →  200 OK  ✓
```

## Wie funktioniert es technisch?

Der Circuit Breaker implementiert eine State Machine mit drei Zuständen:

```
         Threshold Failures erreicht
 CLOSED ──────────────────────────────→ OPEN
   ↑                                      │
   │  Check erfolgreich                   │ Timeout abgelaufen
   │                                      ↓
   └──────────────────────────────── HALF-OPEN
           Check fehlgeschlagen ──→ OPEN
```

**Zustände:**

| Status | Caddy-Verhalten | Badge-Farbe |
|---|---|---|
| **Closed** | Normaler Betrieb, Anfragen werden weitergeleitet | Grün |
| **Open** | Caddy gibt sofort `503` mit `Retry-After` Header zurück | Rot |
| **Half-Open** | Monitoring-Check wird durchgelassen; bei Erfolg → Closed, bei Fehler → Open | Amber |

**Konfigurierbare Werte:**
| Parameter | Standard | Beschreibung |
|---|---|---|
| Threshold | 5 | Aufeinanderfolgende Fehler bevor der Circuit öffnet |
| Timeout | 30s | Sekunden im Open-Status bevor ein Half-Open-Test stattfindet |

**Ablauf im Detail:**
1. Monitoring prüft das Backend periodisch
2. Bei Fehler: In-Memory Failure-Counter wird inkrementiert
3. Bei Erfolg: Counter wird auf 0 zurückgesetzt
4. Counter erreicht Threshold → Status wechselt zu `open`
5. Caddy-Config wird neu gebaut: Route liefert statische 503-Antwort
6. Nach Timeout-Sekunden → Status wechselt zu `half-open`
7. Nächster Monitoring-Check entscheidet:
   - Erfolg → `closed`, Caddy-Config wird wiederhergestellt
   - Fehler → `open`, Timer startet neu

**Caddy-Konfiguration im Open-Status:**
```json
{
  "handle": [{
    "handler": "static_response",
    "status_code": "503",
    "body": "Service temporarily unavailable",
    "headers": { "Retry-After": ["30"] }
  }]
}
```

## Use Cases

### Request-Stau bei totem Backend verhindern

Ohne Circuit Breaker warten alle eingehenden Anfragen auf den Caddy-Timeout (30s). Bei 100 gleichzeitigen Clients sind das 100 blockierte Verbindungen. Mit Circuit Breaker werden alle sofort mit 503 beantwortet.

### Thundering Herd bei Recovery verhindern

Backend war 5 Minuten down, 1000 Clients haben gecacht und warten auf Retry. Ohne Circuit Breaker treffen alle 1000 Anfragen gleichzeitig auf das gerade gestartete Backend. Mit Half-Open lässt der Circuit Breaker nur einen Monitoring-Check durch — erst wenn der erfolgreich ist, wird die Route wieder geöffnet.

### Schnelles Feedback für bessere UX

Statt 30 Sekunden auf einen Timeout zu warten, sieht der Benutzer sofort eine "Service vorübergehend nicht verfügbar" Seite. Die Seite kann einen `Retry-After` Header enthalten, den moderne Browser respektieren.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Circuit Breaker + Monitoring** | **Pflicht:** Monitoring-Checks treiben die State Machine |
| **Circuit Breaker + Retry** | Retry versucht es bei geschlossenem Circuit; bei offenem Circuit sofort 503 |
| **Circuit Breaker + Load Balancing** | Circuit Breaker greift wenn alle Backends down sind |
| **Circuit Breaker + Webhooks** | Events `circuit_breaker_open` / `circuit_breaker_closed` |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Uptime Monitoring** aktivieren (Voraussetzung!)
3. **Circuit Breaker** Toggle aktivieren
4. **Threshold** einstellen (z.B. 5 aufeinanderfolgende Fehler)
5. **Timeout** einstellen (z.B. 30 Sekunden)
6. Speichern

Die Route-Karte zeigt ein Badge: **CB: Closed** (grün), **CB: Open** (rot), **CB: Half-Open** (amber).

### Über die API

```bash
# Circuit Breaker aktivieren
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "monitoring_enabled": true,
    "circuit_breaker_enabled": true,
    "circuit_breaker_threshold": 5,
    "circuit_breaker_timeout": 30
  }'

# Circuit Breaker manuell zurücksetzen
curl -X PATCH https://gatecontrol.example.com/api/v1/routes/1/circuit-breaker \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "closed" }'
```

## Wichtige Hinweise

- **Monitoring ist Pflicht.** Ohne aktiviertes Uptime Monitoring hat der Circuit Breaker keine Datenquelle und bleibt immer im Closed-Status.
- Die Failure-Counter werden **im Arbeitsspeicher** gehalten. Bei einem Neustart von GateControl starten alle Counter bei 0. Offene Circuits (in der DB) ohne gespeicherten `circuitOpenedAt`-Timestamp werden neu getimt.
- Der Circuit Breaker arbeitet pro Route, nicht pro Backend. Bei Load Balancing mit mehreren Backends öffnet der Circuit wenn das Monitoring-Ziel nicht erreichbar ist.
- Im Open-Status werden **keine** Anfragen ans Backend weitergeleitet — auch nicht manuell oder per API.
- Der manuelle Reset (`PATCH /circuit-breaker`) setzt den Status auf `closed` und löscht den Failure-Counter.
- Circuit Breaker ist nur für HTTP-Routen verfügbar, nicht für L4 (TCP/UDP).
