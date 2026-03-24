# Retry on Error

Wiederholt fehlgeschlagene Anfragen automatisch an das Backend — ideal bei kurzzeitigen Ausfällen, Backend-Neustarts oder Load Balancing mit mehreren Backends.

---

## Was macht es?

Wenn das Backend einen Fehler zurückgibt oder nicht erreichbar ist, wiederholt Caddy die Anfrage automatisch, anstatt sofort einen Fehler an den Client zu senden.

**Ohne Retry:**
```
Client  →  Caddy  →  Backend (gerade neugestartet)  →  502 Bad Gateway  →  Client sieht Fehler
```

**Mit Retry (3 Versuche):**
```
Client  →  Caddy  →  Backend (Versuch 1: 502)
                  →  Backend (Versuch 2: 502)
                  →  Backend (Versuch 3: 200 OK)  →  Client sieht normale Antwort
```

**Mit Retry + mehrere Backends:**
```
Client  →  Caddy  →  Backend A (502)
                  →  Backend B (200 OK)  →  Client sieht normale Antwort
```

## Wie funktioniert es technisch?

GateControl konfiguriert Caddys `load_balancing.retries` Mechanismus im Reverse-Proxy-Handler.

**Caddy JSON-Konfiguration:**
```json
{
  "handler": "reverse_proxy",
  "upstreams": [
    { "dial": "10.8.0.3:8080" }
  ],
  "load_balancing": {
    "retries": 3
  }
}
```

**Verhalten:**
- Caddy wiederholt die Anfrage bis zu `retries`-mal bei Verbindungsfehlern
- Mit **einem Backend**: alle Retries gehen an dasselbe Backend
- Mit **mehreren Backends**: Retries rotieren zum nächsten Backend (Round Robin oder gewichtet)
- Die Retry-Logik ist Teil von Caddys Load Balancer — kein separater Handler

**Konfigurierbare Werte:**
| Parameter | Bereich | Standard | Beschreibung |
|---|---|---|---|
| Retry Count | 1 – 10 | 3 | Anzahl der Wiederholungsversuche |

## Use Cases

### Backend-Neustart abfangen

Route `app.example.com` → Node.js App auf Port 3000. Beim Deployment wird die App kurz neu gestartet (2-3 Sekunden Downtime). Mit 3 Retries und einem Backend überbrückt Caddy diese Lücke — der Client bemerkt bestenfalls eine leicht längere Ladezeit.

### Load Balancing mit Failover

Route `api.example.com` → 3 API-Server (Backend A, B, C). Server B fällt aus. Caddy versucht B, bekommt einen Fehler, und leitet die Anfrage automatisch an C weiter. Der Client merkt nichts.

### Temporäre 503-Fehler bei hoher Last

Route `service.example.com` → Microservice der bei Überlastung 503 zurückgibt. Mit Retries hat der Service einen Moment Zeit sich zu erholen, und die nächste Anfrage geht durch.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Retry + Load Balancing** | Retries rotieren zwischen Backends — effektiver als bei einem Backend |
| **Retry + Circuit Breaker** | Circuit Breaker verhindert Retries wenn das Backend dauerhaft down ist |
| **Retry + Monitoring** | Monitoring erkennt ob das Backend dauerhaft down ist; Retry hilft bei kurzen Aussetzern |
| **Retry + Rate Limiting** | Jeder Retry-Versuch zählt als eine Anfrage für das Backend, nicht für das Rate Limit des Clients |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Retry on Error** Toggle aktivieren
3. **Retry Count** einstellen (1-10, Standard: 3)
4. Speichern

### Über die API

```bash
# Retry aktivieren mit 5 Versuchen
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "retry_enabled": true,
    "retry_count": 5
  }'
```

## Wichtige Hinweise

- **POST/PUT/DELETE werden ebenfalls wiederholt.** Das ist problematisch bei nicht-idempotenten Operationen. Beispiel: Ein Retry auf `POST /api/orders` könnte eine doppelte Bestellung auslösen. Retry nur aktivieren wenn das Backend idempotente Operationen unterstützt oder nur GET-Anfragen verarbeitet.
- Retry ist nur für **HTTP-Routen** verfügbar, nicht für L4 (TCP/UDP).
- Die Retries erfolgen sofort hintereinander — es gibt kein exponentielles Backoff.
- Bei einem einzelnen Backend können Retries den Server zusätzlich belasten, wenn er bereits überlastet ist.
- Retry Count von 1 bedeutet: 1 initialer Versuch + 1 Retry = maximal 2 Anfragen ans Backend.
- Retries sind für den Client unsichtbar — er bekommt entweder die erfolgreiche Antwort oder den letzten Fehler.
- In Kombination mit Circuit Breaker: Wenn der Circuit Breaker offen ist, werden keine Retries versucht (Caddy liefert sofort 503).
