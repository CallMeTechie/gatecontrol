# Request Mirroring

Dupliziert eingehende Anfragen asynchron an sekundäre Backends — für Shadow Deployments, Debugging und Lasttests, ohne die primäre Antwort zu beeinflussen.

---

## Was macht es?

Request Mirroring kopiert jede Anfrage die an das primäre Backend geht und sendet sie zusätzlich an ein oder mehrere Mirror-Targets. Der Client bekommt immer die Antwort des primären Backends — die Mirror-Antworten werden verworfen.

**Ohne Mirroring:**
```
Client  →  Caddy  →  Backend (v1)  →  Antwort an Client
```

**Mit Mirroring:**
```
Client  →  Caddy  →  Backend (v1)  →  Antwort an Client  ✓
                  →  Backend (v2)  →  Antwort verworfen    (Mirror)
                  →  Log-Service   →  Antwort verworfen    (Mirror)
```

Der Client merkt nichts vom Mirroring. Die Antwortzeit wird nicht beeinflusst, da die Mirror-Requests asynchron laufen.

## Wie funktioniert es technisch?

GateControl verwendet ein Custom Caddy Go Module (`http.handlers.mirror`), das in die Handler-Kette eingefügt wird — **vor** Compression und Reverse Proxy.

**Caddy JSON-Konfiguration:**
```json
{
  "handler": "mirror",
  "targets": [
    { "dial": "10.8.0.5:8080" },
    { "dial": "10.8.0.6:9090" }
  ]
}
```

**Technische Details:**
| Parameter | Wert |
|---|---|
| Max Mirror-Targets pro Route | 5 |
| Body-Buffer | Bis zu 10 MB |
| Timeout pro Mirror-Target | 10 Sekunden |
| Max gleichzeitige Goroutines | 100 |
| WebSocket-Upgrades | Werden übersprungen |
| Anfragen > 10 MB Body | Werden ohne Body gespiegelt |

**Handler-Reihenfolge in Caddy:**
1. ACL / Forward Auth (falls aktiv)
2. Custom Request Headers
3. Rate Limiting
4. **Request Mirroring** ← hier (vor Compression, damit Targets unkomprimierte Daten bekommen)
5. Compression
6. Reverse Proxy (primäres Backend)

**Target-Auswahl:** Mirror-Targets werden über die Peer-Dropdown-Liste ausgewählt. Jedes Target besteht aus einem Peer und einem Port. GateControl löst die Peer-ID zur WireGuard-IP auf.

## Use Cases

### Shadow Deployment testen

Du entwickelst Version 2 deiner API. Statt sofort umzuschalten, spiegelst du den Produktions-Traffic an die v2-Instanz. Du kannst Logs und Metriken vergleichen ohne Risiko für die Produktion.

### Debugging mit Logging-Backend

Route `app.example.com` → Produktions-Backend. Mirror-Target: ein Logging-Service der alle eingehenden Anfragen aufzeichnet. So kannst du den tatsächlichen Produktions-Traffic analysieren, ohne die App zu instrumentieren.

### Lasttest mit echtem Traffic

Neuer Server soll den aktuellen ersetzen. Mirror den Traffic an den neuen Server und beobachte CPU, RAM und Antwortzeiten unter realer Last — bevor du umschaltest.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Mirroring + Rate Limiting** | Rate Limit zählt nur die primäre Anfrage, nicht die Mirrors |
| **Mirroring + Compression** | Mirror-Targets bekommen unkomprimierte Anfragen (Mirror kommt vor Encode) |
| **Mirroring + ACL** | ACL filtert zuerst, nur erlaubte Anfragen werden gespiegelt |
| **Mirroring + Route Auth** | Nur authentifizierte Anfragen werden gespiegelt |
| **Mirroring + Load Balancing** | Primäre Anfrage geht an Load-Balanced Backends, Mirrors an separate Targets |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Request Mirroring** Toggle aktivieren
3. Mirror-Targets hinzufügen:
   - Peer aus Dropdown auswählen
   - Port des Mirror-Services eingeben
4. Bis zu 5 Targets hinzufügen
5. Speichern

### Über die API

```bash
# Mirroring aktivieren mit 2 Targets
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "mirror_enabled": true,
    "mirror_targets": [
      { "peer_id": 2, "port": 8080 },
      { "peer_id": 3, "port": 9090 }
    ]
  }'
```

## Wichtige Hinweise

- **Schreiboperationen werden gespiegelt.** POST, PUT, DELETE — alles wird an die Mirror-Targets geschickt. Wenn das Mirror-Target eine Datenbank hat, werden dort echte Schreibvorgänge ausgeführt. Stelle sicher, dass Mirror-Targets für diesen Traffic ausgelegt sind.
- Mirror-Targets müssen aktive, aktivierte Peers sein. Deaktivierte oder gelöschte Peers werden beim Config-Build ignoriert.
- Die Antwort des Mirror-Targets wird komplett verworfen — es gibt kein Logging oder Vergleich der Mirror-Antworten in GateControl.
- Anfragen mit einem Body größer als 10 MB werden ohne Body gespiegelt (nur Header).
- WebSocket-Upgrade-Anfragen werden nicht gespiegelt.
- Mirroring ist nur für HTTP-Routen verfügbar, nicht für L4 (TCP/UDP).
- Bei sehr hohem Traffic kann das Mirror-Target überlastet werden. Die 100-Goroutine-Grenze schützt GateControl/Caddy, aber nicht das Target.
