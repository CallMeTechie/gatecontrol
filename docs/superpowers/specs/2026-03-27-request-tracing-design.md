# Request Tracing (caddy-trace) — Design Spec

**Datum:** 2026-03-27
**Status:** Freigegeben
**Feature-Key:** `request_debugging`

## Ziel

Per-Route Request-Tracing über einen Debug-Tab im Edit-Route-Modal. Admins können Tracing pro Route aktivieren und sehen in Echtzeit detaillierte Request/Response-Informationen — ohne Container-Logs durchsuchen zu müssen.

## Nicht im Scope

- Kein Tracing für L4-Routen (caddy-trace ist ein HTTP-Handler)
- Keine DB-Persistenz der Trace-Daten (nur Caddy-Log-Datei)
- Kein Export der Trace-Daten
- Kein URI-Filter (alle Requests werden getraced wenn aktiv)

---

## 1. Caddy-Integration

### Plugin

**Repository:** `github.com/greenpau/caddy-trace` (66 Stars, Apache-2.0)
**Handler-Name:** `trace` (`http.handlers.trace`)
**Go-Modul:** `github.com/greenpau/caddy-trace`

### Dockerfile

```dockerfile
xcaddy build \
    --with github.com/greenpau/caddy-trace \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/ueffel/caddy-brotli \
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror
```

### Handler-Config

```json
{
  "handler": "trace",
  "tag": "route-{routeId}",
  "response_debug": true
}
```

- **Tag:** `route-{routeId}` — ermöglicht Filterung nach Route
- **response_debug:** `true` — loggt auch Status-Code und Response-Infos

### Handler-Reihenfolge (wenn debug aktiv)

caddy-trace ist ein Middleware-Handler der den Request durchreicht und vor/nach der restlichen Chain loggt. Er wird als **erster Handler** eingefügt:

1. `trace` (neu)
2. `headers` (custom request headers)
3. `rate_limit`
4. `mirror`
5. `encode` (compress)
6. `reverse_proxy`

Bei auth-geschützten Routen:

1. `trace` (neu)
2. `forward_auth`
3. `headers`
4. `rate_limit`
5. `mirror`
6. `encode`
7. `reverse_proxy`

**Hinweis:** Da caddy-trace ein wrapping Middleware ist (nutzt `caddyhttp.NewResponseRecorder` wenn `response_debug`), erfasst der Handler an Position 0 den finalen Response-Status korrekt — unabhängig davon was forward_auth oder andere Handler entscheiden.

---

## 2. Log-Datei & Rotation

### Problem

Caddy-stdout wird via Supervisord nach `/dev/stdout` geleitet (nicht in eine Datei). caddy-trace schreibt Zap-JSON nach stdout. Ohne Änderung gehen die Trace-Daten nur in die Container-Logs.

### Lösung

Dedizierter Caddy-Log-Sink für Trace-Output in `buildCaddyConfig`. Caddy's eingebautes Logging-System wird um einen zweiten Logger erweitert, der nur caddy-trace Output nach `/data/caddy/trace.log` schreibt:

```javascript
// In buildCaddyConfig — neben dem bestehenden 'access' Logger
logging: {
  logs: {
    access: {
      // ... bestehender access.log Config
    },
    trace: {
      writer: {
        output: 'file',
        filename: '/data/caddy/trace.log',
        roll_size_mb: 5,
        roll_keep: 2,
      },
      encoder: { format: 'json' },
      level: 'DEBUG',
      include: ['http.handlers.trace'],
    },
  },
},
```

- **Datei:** `/data/caddy/trace.log`
- **Rotation:** 5 MB, 2 Dateien behalten (max ~10 MB Disk-Verbrauch)
- **Level:** DEBUG (caddy-trace loggt auf Debug-Level)
- **Filter:** `include: ['http.handlers.trace']` — nur Trace-Output, kein Access-Log-Mix. **Implementierungshinweis:** Der tatsächliche Logger-Namespace muss beim ersten Build verifiziert werden. Falls caddy-trace einen anderen Namespace nutzt, muss der `include`-Filter angepasst werden.
- **Nur aktiv wenn mindestens eine Route `debug_enabled` hat** — sonst wird der trace-Logger nicht in die Caddy-Config eingefügt

### Trace-Log wird nur bei Bedarf konfiguriert

In `buildCaddyConfig`: Prüfe ob *irgendeine* Route `debug_enabled` hat. Nur dann wird der `trace`-Logger in die Logging-Config aufgenommen. Wenn keine Route Tracing aktiv hat, entsteht kein Log-Overhead.

---

## 3. Datenbank

### Migration

```javascript
{
  version: 27,  // nächste freie Version (letzte ist 26)
  name: 'add-debug-enabled',
  sql: 'ALTER TABLE routes ADD COLUMN debug_enabled INTEGER DEFAULT 0;',
  detect: (db) => hasColumn(db, 'routes', 'debug_enabled'),
}
```

Folgt dem bestehenden Pattern (vgl. Migration 18 `compress_enabled`, Migration 24 `circuit_breaker_enabled`). Die `detect`-Funktion stellt Kompatibilität mit Legacy-Datenbanken sicher.

### Felder

| Spalte | Typ | Default | Beschreibung |
|--------|-----|---------|-------------|
| `debug_enabled` | INTEGER | 0 | Request-Tracing aktiviert (0/1) |

Keine zusätzlichen Konfigurationsfelder nötig — caddy-trace wird mit festen Defaults konfiguriert (tag + response_debug).

---

## 4. Lizenz

### COMMUNITY_FALLBACK

```javascript
request_debugging: false
```

### API-Guard

```javascript
requireFeatureField('debug_enabled', 'request_debugging')
```

Wird in **beide** Middleware-Chains eingefügt:
- POST `/api/v1/routes` (nach den bestehenden `requireFeatureField`-Guards, ca. Zeile 221)
- PUT `/api/v1/routes/:id` (nach den bestehenden Guards, ca. Zeile 331)

### Template-Gate

```nunjucks
{% if license.features.request_debugging %}
  <!-- Toggle interaktiv -->
{% else %}
  <!-- Toggle mit Lock-Icon -->
{% endif %}
```

---

## 5. Backend-Service

### Route-Service (`routes.js`)

In `buildCaddyConfig`: Wenn `route.debug_enabled` ist truthy, wird der `trace`-Handler als erstes Element in die Handler-Chain eingefügt:

```javascript
if (route.debug_enabled) {
  routeHandlers.unshift({
    handler: 'trace',
    tag: `route-${route.id}`,
    response_debug: true,
  });
}
```

Gleiche Logik für auth-geschützte Routen (`authHandlers`).

### CREATE

`debug_enabled` wird als optionales Boolean-Feld akzeptiert:
- Destructuring in API-Route POST-Handler (neben den bestehenden Toggle-Feldern)
- Durchreichung an `routes.create()` als Parameter
- INSERT-Statement um `debug_enabled` erweitert

### UPDATE

- `COALESCE(?, debug_enabled)` Pattern wie alle anderen Toggle-Felder
- Destructuring in API-Route PUT-Handler
- Durchreichung an `routes.update()`
- Caddy-Sync nach Aktivierung/Deaktivierung

### Trace-API-Endpoint

```
GET /api/v1/routes/:id/trace?limit=50&since=1774640938.708
```

- Liest `/data/caddy/trace.log` (dedizierter Trace-Log, siehe Abschnitt 2)
- Filtert Zeilen nach JSON-Feld `tag === "route-{id}"`
- Parst relevante Felder: timestamp, method, uri, status, latency, remote_ip, user_agent
- Query-Parameter:
  - `limit` (Default 50, Max 200) — Anzahl der Einträge
  - `since` (Unix-Timestamp in Sekunden, float) — nur Einträge nach diesem Zeitpunkt (für Polling). Verwendet den gleichen Timestamp-Typ wie caddy-trace Output (Unix-Sekunden mit Dezimalstellen).
- Response:

```json
{
  "ok": true,
  "data": {
    "entries": [
      {
        "timestamp": "2026-03-27T20:15:30.123Z",
        "method": "GET",
        "uri": "/api/data",
        "status": 502,
        "latency_ms": 120,
        "remote_ip": "10.8.0.3",
        "host": "cloud.example.com",
        "user_agent": "Mozilla/5.0 ..."
      }
    ]
  }
}
```

- Timestamps im Response werden zu ISO 8601 konvertiert (unabhängig vom internen Format)
- Wenn die Log-Datei nicht existiert (kein Tracing aktiv), wird ein leeres Array zurückgegeben

---

## 6. UI

### Edit-Route-Modal — neuer "Debug"-Tab

Neuer Tab als letzter Tab im Modal (nach "Headers"):

```html
<button class="tab" data-edit-tab="debug">Debug</button>
```

**Tab-Inhalt:**

1. **Toggle "Request Tracing"** — lizenzgated, gleiche Struktur wie alle anderen Feature-Toggles
2. **Trace-Log-Container** (sichtbar wenn Toggle aktiv und Route gespeichert):
   - Scrollbarer Container mit `max-height: 400px`
   - Neueste Einträge oben
   - Auto-Refresh alle 3 Sekunden via Polling (`since`-Parameter)
   - Jeder Eintrag zeigt: Timestamp, Methode, URI, Status-Code, Latenz, Remote-IP
   - Farbcodierung: 2xx grün, 4xx gelb, 5xx rot
   - "Leeren"-Button (leert die Ansicht, Polling läuft weiter)
   - Hinweistext wenn keine Einträge vorhanden

**Tab wird nicht angezeigt bei L4-Routen** (caddy-trace ist HTTP-only).

**Hinweis:** Der "Leeren"-Button leert nur die UI-Ansicht, nicht die Log-Datei. Die Log-Datei wird durch Rotation automatisch bereinigt.

### Create-Route-Card

Toggle "Request Tracing" mit Lizenz-Gate — gleiche Position wie die anderen Feature-Toggles (nach Request Mirroring, vor dem Speichern-Button). Keine Trace-Anzeige im Create-Flow (Route existiert noch nicht).

### Routen-Liste — Badge

Wenn `debug_enabled` aktiv, wird ein orangefarbener Badge angezeigt:

```html
<span class="tag tag-orange">Debug</span>
```

Damit sieht der Admin auf einen Blick welche Routen Tracing aktiv haben.

---

## 7. i18n

### Neue Keys (11 pro Sprache)

| Key | EN | DE |
|-----|----|----|
| `debug.title` | Request Tracing | Request-Tracing |
| `debug.toggle_desc` | Log detailed request/response information for debugging | Detaillierte Request/Response-Informationen für Debugging loggen |
| `debug.tab` | Debug | Debug |
| `debug.no_entries` | No trace entries yet. Send a request to this route to see results. | Noch keine Trace-Einträge. Sende einen Request an diese Route. |
| `debug.auto_refresh` | Auto-refresh | Auto-Aktualisierung |
| `debug.clear` | Clear | Leeren |
| `debug.badge` | Debug | Debug |
| `debug.method` | Method | Methode |
| `debug.status` | Status | Status |
| `debug.latency` | Latency | Latenz |
| `debug.remote_ip` | Remote IP | Remote-IP |

---

## 8. Backup/Restore

`debug_enabled` wird in `backup.js` aufgenommen:
- **Export:** `debug_enabled` Feld im Route-Objekt
- **Import:** `debug_enabled` beim Restore setzen (Default 0 wenn nicht vorhanden)

**Voraussetzung:** Die bestehende Backup-Implementierung fehlt bereits `mirror_enabled` und `mirror_targets` (Migration 26). Diese Lücke **muss** im gleichen Zug behoben werden — `mirror_enabled`, `mirror_targets` und `debug_enabled` werden zusammen in Backup/Restore aufgenommen.

---

## 9. Dateien die geändert werden

| Datei | Änderung |
|-------|----------|
| `Dockerfile` | `--with github.com/greenpau/caddy-trace` |
| `src/db/migrations.js` | Neue Migration 28: `debug_enabled` Spalte mit `detect`-Funktion |
| `src/services/license.js` | `request_debugging: false` in COMMUNITY_FALLBACK |
| `src/services/routes.js` | trace-Handler + trace-Logger in buildCaddyConfig, debug_enabled in CREATE/UPDATE |
| `src/routes/api/routes.js` | requireFeatureField-Guard (POST + PUT), debug_enabled destructuring, neuer GET /:id/trace Endpoint |
| `templates/default/partials/modals/route-edit.njk` | Debug-Tab mit Toggle + Trace-Container |
| `templates/default/pages/routes.njk` | Debug-Toggle in Create-Card |
| `public/js/routes.js` | Toggle-Logik, Polling, Trace-Rendering, Badge |
| `src/i18n/en.json` | 11 neue Keys |
| `src/i18n/de.json` | 11 neue Keys |
| `src/services/backup.js` | debug_enabled + mirror_enabled/mirror_targets in Backup/Restore |
