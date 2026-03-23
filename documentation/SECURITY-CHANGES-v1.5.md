# Security Changes v1.5 — Funktionsbeeinträchtigungen

Dieses Dokument beschreibt alle Security-Fixes in v1.5.0 die bestehende Funktionen verändern. Für jeden Fix wird erklärt was sich geändert hat, warum, und was ggf. angepasst werden muss.

---

## Inhaltsverzeichnis

- [#13 — Route-Targets: Private IPs blockiert](#13--route-targets-private-ips-blockiert)
- [#14 — Prometheus: Query-Parameter-Auth entfernt](#14--prometheus-query-parameter-auth-entfernt)
- [Prometheus Konfiguration (ausführlich)](#prometheus-konfiguration)
- [API Token Header-Auth (ausführlich)](#api-token-header-auth)
- [Weitere Änderungen (geringfügig)](#weitere-änderungen)

---

## #13 — Route-Targets: Private IPs blockiert

### Was hat sich geändert?

Direkte Eingabe von privaten oder Loopback-IP-Adressen als Route-Target ist jetzt blockiert. Betroffen sind:

| IP-Bereich | Beschreibung |
|---|---|
| `127.x.x.x` | Loopback |
| `10.x.x.x` | RFC 1918 Private |
| `172.16.x.x` – `172.31.x.x` | RFC 1918 Private |
| `192.168.x.x` | RFC 1918 Private |
| `169.254.x.x` | Link-Local / Cloud Metadata |
| `0.x.x.x` | "This" Network |

### Warum?

Ein Angreifer mit Admin-Zugang konnte eine Route erstellen die auf interne Dienste zeigt (z.B. `127.0.0.1:2019` = Caddy Admin API, `169.254.169.254` = Cloud Metadata). Caddy hätte dann als SSRF-Proxy fungiert und alle eingehenden Requests an diese internen Dienste weitergeleitet — inklusive aller Headers (Authorization, Cookies).

### Wer ist betroffen?

Nur wer Routes mit **manuell eingegebener privater IP** (ohne Peer-Verlinkung) erstellt hat. Zum Beispiel:

```
Domain: app.example.com → Target: 192.168.1.100:8080  ← BLOCKIERT
```

### Was ist NICHT betroffen?

Routes die über **Peer-Verlinkung** erstellt wurden funktionieren weiterhin normal:

```
Domain: app.example.com → Peer: "nas" (10.8.0.2) → Port: 8080  ← FUNKTIONIERT
```

Bei Peer-Verlinkung wird die Target-IP automatisch aus der WireGuard-Konfiguration des Peers übernommen (`10.8.0.x`). Diese Peer-IPs sind zwar privat, aber das ist by-design — sie kommen nicht aus User-Input sondern aus dem kontrollierten WireGuard-Subnetz.

### Was muss angepasst werden?

Falls du Routes mit direkt eingegebener privater IP hast:

1. **Erstelle einen WireGuard-Peer** für das Zielgerät (falls noch nicht vorhanden)
2. **Bearbeite die Route** und wähle den Peer aus dem Dropdown statt die IP manuell einzugeben
3. Die Route funktioniert dann über die Peer-Verlinkung

**Beispiel-Migration:**

| Vorher | Nachher |
|---|---|
| Route → Target IP: `192.168.1.100`, Port: `8080` | Route → Peer: "homeserver", Port: `8080` |

---

## #14 — Prometheus: Query-Parameter-Auth entfernt

### Was hat sich geändert?

Der `/metrics` Endpoint akzeptiert keine `?token=gc_xxx` Query-Parameter mehr zur Authentifizierung. Nur noch Header-basierte Authentifizierung wird akzeptiert.

### Warum?

Query-Parameter erscheinen in:
- **Caddy Access Logs** — Jeder Request wird mit voller URL geloggt
- **Browser-History** — Falls der Endpoint jemals im Browser aufgerufen wird
- **Reverse-Proxy Logs** — Upstream-Proxies loggen oft die volle URL
- **Referrer-Header** — Wenn von der Metrics-Seite zu einer anderen Seite navigiert wird

Ein API-Token im Query-Parameter ist damit effektiv im Klartext in multiplen Log-Dateien gespeichert.

### Was muss angepasst werden?

Prometheus-Scraper die bisher `?token=` verwenden müssen auf Header-Auth umgestellt werden. Siehe den Abschnitt [Prometheus Konfiguration](#prometheus-konfiguration) weiter unten.

---

## Prometheus Konfiguration

### Schritt 1: API Token in GateControl erstellen

1. Öffne **Settings → API** in der GateControl-Oberfläche
2. Erstelle einen neuen Token:
   - **Name**: z.B. `prometheus`
   - **Scopes**: Wähle `system` (Mindestberechtigung für `/metrics`)
   - Optional auch: `read-only` oder `full-access`
3. Klicke **Create Token**
4. **Kopiere den Token** (`gc_...`) — er wird nur einmal angezeigt!

### Schritt 2: Prometheus konfigurieren

#### Vorher (Query-Parameter — funktioniert NICHT mehr):

```yaml
scrape_configs:
  - job_name: 'gatecontrol'
    metrics_path: '/metrics'
    params:
      token: ['gc_abc123...']
    static_configs:
      - targets: ['gatecontrol.example.com:443']
    scheme: https
```

#### Nachher (Header-Auth — korrekte Konfiguration):

**Option A: Authorization Header (empfohlen)**

```yaml
scrape_configs:
  - job_name: 'gatecontrol'
    metrics_path: '/metrics'
    authorization:
      type: 'Bearer'
      credentials: 'gc_abc123...'
    static_configs:
      - targets: ['gatecontrol.example.com:443']
    scheme: https
```

**Option B: Authorization Header mit Credentials-File (sicherste Variante)**

Token in eine Datei schreiben:
```bash
echo -n 'gc_abc123...' > /etc/prometheus/gatecontrol-token.txt
chmod 600 /etc/prometheus/gatecontrol-token.txt
```

```yaml
scrape_configs:
  - job_name: 'gatecontrol'
    metrics_path: '/metrics'
    authorization:
      type: 'Bearer'
      credentials_file: '/etc/prometheus/gatecontrol-token.txt'
    static_configs:
      - targets: ['gatecontrol.example.com:443']
    scheme: https
```

#### Grafana Agent / Alloy

```yaml
prometheus.scrape "gatecontrol" {
  targets    = [{"__address__" = "gatecontrol.example.com:443"}]
  forward_to = [prometheus.remote_write.default.receiver]
  scheme     = "https"
  metrics_path = "/metrics"

  authorization {
    type        = "Bearer"
    credentials = "gc_abc123..."
  }
}
```

#### Victoria Metrics Agent

```yaml
scrape_configs:
  - job_name: 'gatecontrol'
    metrics_path: '/metrics'
    bearer_token: 'gc_abc123...'
    static_configs:
      - targets: ['gatecontrol.example.com:443']
    scheme: https
```

### Schritt 3: Testen

```bash
# Test mit curl — so sieht Prometheus den Endpoint:
curl -s -H "Authorization: Bearer gc_abc123..." https://gatecontrol.example.com/metrics

# Erwartete Antwort: Prometheus Text Format
# gc_peers_total 5
# gc_peers_online 3
# gc_routes_total 4
# ...

# Fehlermeldung bei falschem Token:
# {"ok":false,"error":"Unauthorized"}
```

### Verfügbare Metriken

| Metrik | Typ | Beschreibung |
|---|---|---|
| `gc_peers_total` | Gauge | Gesamtzahl der Peers |
| `gc_peers_online` | Gauge | Anzahl Online-Peers |
| `gc_routes_total` | Gauge | Gesamtzahl der Routes |
| `gc_routes_enabled` | Gauge | Anzahl aktivierter Routes |
| `gc_cpu_usage_percent` | Gauge | CPU-Auslastung in % |
| `gc_memory_usage_percent` | Gauge | RAM-Auslastung in % |
| `gc_uptime_seconds` | Gauge | Server-Uptime in Sekunden |
| `gc_peer_rx_bytes` | Gauge | Empfangene Bytes pro Peer (Label: `peer`) |
| `gc_peer_tx_bytes` | Gauge | Gesendete Bytes pro Peer (Label: `peer`) |
| `gc_route_monitor_up` | Gauge | Monitoring-Status pro Route (Label: `domain`) |

---

## API Token Header-Auth

### Übersicht

GateControl unterstützt zwei Header-Formate für API-Token-Authentifizierung:

| Header | Format | Beispiel |
|---|---|---|
| `Authorization` | `Bearer gc_...` | `Authorization: Bearer gc_abc123def456...` |
| `X-API-Token` | `gc_...` | `X-API-Token: gc_abc123def456...` |

Beide Header sind gleichwertig. `Authorization: Bearer` ist der Standard für OAuth2-kompatible Tools (Prometheus, Grafana, curl). `X-API-Token` ist eine Alternative für Systeme die den `Authorization` Header nicht setzen können.

### Token erstellen (UI)

1. Navigiere zu **Settings → API**
2. Vergib einen **Namen** (z.B. `prometheus`, `home-assistant`, `ci-cd`)
3. Wähle **Scopes** (Berechtigungen):

| Scope | Berechtigung |
|---|---|
| `full-access` | Alles lesen und schreiben |
| `read-only` | Nur lesen (GET) auf allen Endpoints |
| `system` | System-Info, WireGuard-Status, Caddy-Config, Prometheus Metrics |
| `peers` | Peer CRUD |
| `routes` | Route CRUD |
| `settings` | Settings lesen/schreiben |
| `webhooks` | Webhook CRUD |
| `logs` | Activity Logs lesen |
| `backup` | Backup erstellen/wiederherstellen |

4. Optional: **Ablaufdatum** setzen
5. Klicke **Create Token**
6. **Den angezeigten Token kopieren** — er wird nur einmal angezeigt und kann nicht wiederhergestellt werden

### Token erstellen (API)

```bash
curl -X POST https://gatecontrol.example.com/api/v1/tokens \
  -H "Cookie: gc.sid=..." \
  -H "X-CSRF-Token: ..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prometheus",
    "scopes": ["system"]
  }'

# Response:
# {
#   "ok": true,
#   "token": "gc_a1b2c3d4e5f6...",   ← NUR JETZT SICHTBAR
#   "record": { "id": 1, "name": "prometheus", "scopes": ["system"], ... }
# }
```

### Token verwenden

**curl:**
```bash
curl -H "Authorization: Bearer gc_abc123..." https://gatecontrol.example.com/api/v1/peers
curl -H "X-API-Token: gc_abc123..." https://gatecontrol.example.com/api/v1/routes
```

**JavaScript (fetch):**
```javascript
const res = await fetch('https://gatecontrol.example.com/api/v1/peers', {
  headers: { 'Authorization': 'Bearer gc_abc123...' }
});
```

**Python (requests):**
```python
import requests
r = requests.get('https://gatecontrol.example.com/api/v1/peers',
                  headers={'Authorization': 'Bearer gc_abc123...'})
```

**Home Assistant (REST sensor):**
```yaml
sensor:
  - platform: rest
    resource: https://gatecontrol.example.com/api/v1/dashboard
    headers:
      Authorization: "Bearer gc_abc123..."
    value_template: "{{ value_json.peers_online }}"
```

### Sicherheitshinweise

- Tokens werden als **SHA-256 Hash** in der Datenbank gespeichert — der Klartext-Token ist nur bei der Erstellung sichtbar
- Token-Prefix `gc_` ermöglicht einfache Erkennung in Log-Dateien und Secret-Scannern
- Tokens können nicht andere Tokens erstellen oder löschen (Escalation Prevention)
- Abgelaufene Tokens werden automatisch abgelehnt
- Token-Nutzung wird mit Zeitstempel (`last_used_at`) protokolliert

---

## Weitere Änderungen

### #7 — Route-Auth Lockout per Email statt IP

**Vorher:** Lockout nach 5 fehlgeschlagenen Login-Versuchen pro IP-Adresse + Route.
**Nachher:** Lockout nach 5 fehlgeschlagenen Login-Versuchen pro Email-Adresse + Route.

**Auswirkung:** Ein Angreifer der seine IP wechselt (VPN, Cloud-VMs) wird trotzdem gesperrt wenn er dieselbe Email-Adresse angreift. Für normale Benutzer ändert sich nichts — nach 5 falschen Passwörtern wird das Konto temporär gesperrt, unabhängig von der IP.

### #10 — Route-Auth CSRF-Tokens ungültig

**Vorher:** Route-Auth CSRF-Tokens wurden mit dem App-Session-Secret signiert.
**Nachher:** Route-Auth CSRF-Tokens werden mit einem eigenen, abgeleiteten Secret signiert.

**Auswirkung:** Einmalig nach dem Update sind bestehende CSRF-Tokens ungültig. Betroffene Benutzer sehen eine CSRF-Fehlermeldung auf der Route-Auth Login-Seite. **Lösung:** Seite einmal neu laden (F5 / Ctrl+R). Danach funktioniert alles normal.

### #16 — Trust Proxy auf Loopback eingeschränkt

**Vorher:** Express vertraute dem ersten Proxy in der `X-Forwarded-For` Kette (`trust proxy: 1`).
**Nachher:** Express vertraut nur Requests von `127.0.0.1` und `::1` (`trust proxy: loopback`).

**Auswirkung:** Keine bei Standard-Deployment (Caddy + Node im selben Container mit Docker host networking). Falls GateControl hinter einem externen Reverse Proxy (nicht Caddy im Container) betrieben wird, muss `GC_HOST` auf `127.0.0.1` gesetzt und der externe Proxy als trusted konfiguriert werden.
