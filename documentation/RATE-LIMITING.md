# Rate Limiting

Begrenzt die Anzahl der Anfragen pro IP-Adresse innerhalb eines Zeitfensters — schützt Backends vor Überlastung, Brute-Force und Scraping.

---

## Was macht es?

Rate Limiting zählt die Anfragen jeder Client-IP und blockiert weitere Anfragen, sobald das Limit erreicht ist. Der Client erhält dann HTTP 429 (Too Many Requests) statt einer normalen Antwort.

**Ohne Rate Limiting:**
```
Bot sendet 10.000 Anfragen/Minute  →  Backend bearbeitet alle  →  Server überlastet
```

**Mit Rate Limiting (100 Anfragen/Minute):**
```
Bot sendet 100 Anfragen    →  Backend bearbeitet alle  ✓
Bot sendet Anfrage #101    →  Caddy: 429 Too Many Requests  ✕
Bot sendet Anfrage #102    →  Caddy: 429 Too Many Requests  ✕
... nach 1 Minute ...
Bot sendet Anfrage #1      →  Backend bearbeitet  ✓  (neues Zeitfenster)
```

## Wie funktioniert es technisch?

GateControl nutzt das `caddy-ratelimit` Plugin. Der Rate-Limit-Handler wird **vor** dem Reverse Proxy in die Caddy Handler-Kette eingefügt.

**Caddy JSON-Konfiguration:**
```json
{
  "handler": "rate_limit",
  "rate_limits": {
    "static": {
      "key": "{http.request.remote.host}",
      "window": "1m",
      "max_events": 100
    }
  }
}
```

**Schlüssel:** `{http.request.remote.host}` — jede Client-IP bekommt ein eigenes Kontingent.

**Konfigurierbare Werte:**
| Parameter | Bereich | Standard | Beschreibung |
|---|---|---|---|
| Requests | 1 – 100.000 | 100 | Maximale Anfragen pro Zeitfenster |
| Window | 1s, 1m, 5m, 1h | 1m | Dauer des Zeitfensters |

**Handler-Reihenfolge in Caddy:**
1. ACL / Forward Auth (falls aktiv)
2. Custom Request Headers (falls vorhanden)
3. **Rate Limit** ← hier
4. Request Mirroring (falls aktiv)
5. Compression (falls aktiv)
6. Reverse Proxy

## Use Cases

### Login-Seite gegen Brute-Force schützen

Route `app.example.com` → Web-App mit Login. Rate Limit: **10 Requests / 1 Minute**. Ein Angreifer kann maximal 10 Passwort-Versuche pro Minute machen — das verlangsamt Brute-Force-Angriffe erheblich.

### API vor Missbrauch schützen

Route `api.example.com` → REST API. Rate Limit: **1000 Requests / 5 Minuten**. Normale Nutzung bleibt unbeeinträchtigt, aber ein einzelner Client kann die API nicht überlasten.

### Scraping verhindern

Route `shop.example.com` → Webshop. Rate Limit: **60 Requests / 1 Minute**. Bots die Preise scrapen werden nach 60 Seitenaufrufen pro Minute gebremst.

**Empfohlene Werte:**

| Use Case | Requests | Window |
|---|---|---|
| Login-Seite | 10–20 | 1m |
| REST API | 500–1000 | 5m |
| Webshop / Website | 60–120 | 1m |
| Statische Assets | 1000–5000 | 1m |
| Webhook-Endpoint | 50–100 | 1m |

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Rate Limit + Route Auth** | Rate Limit nach Auth-Check — schützt Backend, nicht die Login-Seite |
| **Rate Limit + Basic Auth** | Rate Limit vor Auth — schützt auch gegen Brute-Force auf Basic Auth |
| **Rate Limit + ACL** | Nur VPN-Peers kommen durch, diese werden dann rate-limited |
| **Rate Limit + IP-Filter** | IP-Filter blockiert bekannte IPs, Rate Limit bremst den Rest |
| **Rate Limit + Compression** | Kein Konflikt — Rate Limit zählt Anfragen, Compression komprimiert Antworten |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Rate Limiting** Toggle aktivieren
3. **Requests** eingeben (z.B. 100)
4. **Window** auswählen (1s, 1m, 5m, 1h)
5. Speichern

### Über die API

```bash
# Rate Limiting aktivieren: 100 Anfragen pro Minute
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "rate_limit_enabled": true,
    "rate_limit_requests": 100,
    "rate_limit_window": "1m"
  }'
```

## Wichtige Hinweise

- Rate Limiting ist **pro IP-Adresse**, nicht global. 100 Requests/Minute bedeutet: jede einzelne IP darf 100 Anfragen stellen.
- Hinter einem NAT-Router teilen sich alle Clients dieselbe IP — das Limit gilt dann für alle zusammen.
- Erlaubte Window-Werte: `1s`, `1m`, `5m`, `1h`. Andere Werte werden auf `1m` normalisiert.
- HTTP 429 enthält keinen `Retry-After` Header — der Client muss selbst warten bis das Fenster abläuft.
- Rate Limiting ist nur für HTTP-Routen verfügbar, nicht für L4 (TCP/UDP).
- Bei Routen mit Forward Auth (Route Auth oder IP-Filter) wird Rate Limiting **nach** dem Auth-Check angewendet.
- WebSocket-Verbindungen zählen nur den initialen HTTP Upgrade als eine Anfrage.
