# Uptime Monitoring

Periodische Erreichbarkeitsprüfung aller Routen per HTTP GET oder TCP Connect — mit Statusanzeige, Response-Time-Tracking und Alarmierung bei Ausfällen.

---

## Was macht es?

Uptime Monitoring prüft in regelmäßigen Abständen, ob die Backends deiner Routen erreichbar sind. Ohne Monitoring siehst du erst einen Fehler, wenn ein Benutzer ihn meldet.

**Ohne Monitoring:**
```
Client  →  Caddy  →  Backend (abgestürzt)  →  502 Bad Gateway
                                               ↑ niemand weiß es
```

**Mit Monitoring:**
```
Monitor prüft alle 60s  →  Backend antwortet nicht  →  Status: DOWN (rot)
                                                       → Email-Alert
                                                       → Webhook: route_monitor_down
                                                       → Circuit Breaker reagiert
```

## Wie funktioniert es technisch?

GateControl startet einen Poller, der im konfigurierten Intervall (Standard: 60 Sekunden) alle Routen mit `monitoring_enabled = 1` prüft.

**HTTP-Routen (Layer 7):**
- HTTP GET auf `http(s)://<Peer-IP>:<Target-Port>/`
- User-Agent: `GateControl-Monitor/1.0`
- Erwartung: Statuscode 200-399 = UP, alles andere = DOWN
- Bei `backend_https`: HTTPS mit `rejectUnauthorized: false` (akzeptiert Self-Signed)
- Timeout: konfiguriert in `config.timeouts.monitorHttp`

**L4-Routen (TCP/UDP):**
- TCP Connect zum Backend-Port
- Verbindungsaufbau erfolgreich = UP, Timeout/Fehler = DOWN
- Timeout: konfiguriert in `config.timeouts.monitorTcp`

**Parallelisierung:** Maximal 10 gleichzeitige Checks pro Zyklus.

**Gespeicherte Felder pro Route:**
| Feld | Beschreibung |
|---|---|
| `monitoring_status` | `up`, `down` oder `unknown` |
| `monitoring_last_check` | Zeitpunkt der letzten Prüfung (ISO 8601) |
| `monitoring_response_time` | Antwortzeit in Millisekunden |
| `monitoring_last_change` | Zeitpunkt des letzten Statuswechsels |

## Use Cases

### Synology NAS überwachen

Route `nas.example.com` → Port 5001 (DSM). Monitoring erkennt, wenn das NAS nach einem Update neu startet. Du bekommst eine E-Mail, wenn es down geht, und eine zweite, wenn es wieder erreichbar ist.

### Mehrere Dienste auf einem Server

Drei Routen zeigen auf denselben Peer, aber verschiedene Ports (3000, 8080, 5432). Ein Dienst stürzt ab — Monitoring zeigt genau welcher. Die anderen bleiben grün.

### Circuit Breaker aktivieren

Monitoring ist **Voraussetzung** für den Circuit Breaker. Erst wenn Monitoring einen Ausfall erkennt, kann der Circuit Breaker die Route sperren und 503 zurückgeben, statt Anfragen ins Leere zu schicken.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Monitoring + Circuit Breaker** | Monitoring-Checks treiben die State Machine des Circuit Breakers |
| **Monitoring + Webhooks** | Events `route_down` / `route_up` an externe Systeme (Slack, Discord, etc.) |
| **Monitoring + Email-Alerts** | Sofortige Benachrichtigung bei Statuswechsel |
| **Monitoring + L4-Routen** | TCP-Check statt HTTP-Check, erkennt Port-Erreichbarkeit |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Uptime Monitoring** Toggle aktivieren
3. Intervall konfigurieren unter **Settings → Monitoring** (Standard: 60 Sekunden)
4. Optional: **Email-Alerts** aktivieren und Alert-Email-Adresse eintragen (SMTP muss konfiguriert sein)
5. Speichern

Die Route-Karte zeigt ein Badge: **UP** (grün) oder **DOWN** (rot) mit Antwortzeit.

### Über die API

```bash
# Monitoring für eine Route aktivieren
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "monitoring_enabled": true
  }'

# Manuellen Check auslösen
curl -X POST https://gatecontrol.example.com/api/v1/routes/1/check \
  -H "Authorization: Bearer gc_..."

# Monitoring-Summary abrufen
curl https://gatecontrol.example.com/api/v1/monitoring/summary \
  -H "Authorization: Bearer gc_..."
```

## Wichtige Hinweise

- Der erste Check läuft 10 Sekunden nach dem Start von GateControl — damit alle Dienste Zeit haben hochzufahren.
- Monitoring prüft die **direkte Verbindung zum Backend** (Peer-IP + Port), nicht den öffentlichen Domain-Zugang über Caddy.
- Bei `backend_https`-Routen wird HTTPS verwendet, aber das Zertifikat **nicht validiert** — Self-Signed funktioniert.
- Email-Alerts erfordern eine funktionierende SMTP-Konfiguration unter Settings → Email.
- Webhook-Events heißen `route_down` und `route_up` (nicht `route_monitor_down`/`route_monitor_up`).
- Das Monitoring-Intervall gilt global für alle Routen — individuelle Intervalle pro Route sind nicht möglich.
- Wenn Monitoring deaktiviert wird, bleibt der letzte Status stehen (wird nicht auf `unknown` zurückgesetzt).
