# AI-Bot-Blocker (caddy-defender) — Design Spec

**Datum:** 2026-03-28
**Status:** Freigegeben
**Feature-Key:** `bot_blocking`

## Ziel

Per-Route AI-Bot-Blocking über caddy-defender Plugin. Admins können Bot-Blocking pro Route aktivieren, den Modus wählen (Block, Tarpit, Drop, Garbage, Redirect, Custom) und sehen in der Routen-Liste einen Badge mit der Anzahl geblockter Requests.

## Nicht im Scope

- Keine benutzerdefinierten IP-Ranges (nur Standard-Ranges des Plugins)
- Keine Whitelist-Konfiguration im UI
- Kein Bot-Blocking für L4-Routen (caddy-defender ist ein HTTP-Handler)
- Keine historische Statistik (nur aktueller kumulativer Counter)

---

## 1. Caddy-Integration

### Plugin

**Repository:** `github.com/JasonLovesDoggo/caddy-defender` (508 Stars)
**Handler-Name:** `defender` (`http.handlers.defender`)
**Go-Modul:** `github.com/JasonLovesDoggo/caddy-defender`

### Dockerfile

```dockerfile
xcaddy build \
    --with github.com/JasonLovesDoggo/caddy-defender \
    --with github.com/greenpau/caddy-trace \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/ueffel/caddy-brotli \
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror
```

### Handler-Position

Der `defender`-Handler wird als **allererster Handler** in die Route-Handler-Chain eingefügt — vor `trace`, `rate_limit`, `auth`, `compress`, `proxy`. Bots sollen sofort geblockt werden bevor sie andere Handler belasten.

**Implementierungsreihenfolge:** Der `defender`-unshift muss **nach** dem `trace`-unshift erfolgen, damit defender an Index 0 landet und trace an Index 1. Für `authHandlers` gilt dasselbe — defender wird als letztes unshifted um ganz vorne zu stehen.

### Handler-Config pro Route

Basis-Config (Block-Modus):
```json
{
  "handler": "defender",
  "raw_responder": "block",
  "ranges": ["openai", "aws", "gcloud", "githubcopilot", "deepseek", "azurepubliccloud"]
}
```

Modusspezifische Zusatzfelder:
- **block:** Keine Zusatzfelder (Standard 403)
- **tarpit:** Keine Zusatzfelder (Standard-Config)
- **drop:** Keine Zusatzfelder
- **garbage:** Keine Zusatzfelder
- **redirect:** `"url": "https://example.com"`
- **custom:** `"message": "Access denied"`, `"status_code": 403`

### Verfügbare IP-Ranges (Default)

`openai`, `aws`, `azurepubliccloud`, `deepseek`, `gcloud`, `githubcopilot` — das Plugin pflegt diese Listen automatisch.

---

## 2. Datenbank

### Migration 28

```javascript
{
  version: 28,
  name: 'add_bot_blocker',
  sql: `
    ALTER TABLE routes ADD COLUMN bot_blocker_enabled INTEGER DEFAULT 0;
    ALTER TABLE routes ADD COLUMN bot_blocker_mode TEXT DEFAULT 'block';
    ALTER TABLE routes ADD COLUMN bot_blocker_count INTEGER DEFAULT 0;
    ALTER TABLE routes ADD COLUMN bot_blocker_config TEXT;
  `,
  detect: (db) => hasColumn(db, 'routes', 'bot_blocker_enabled'),
}
```

### Felder

| Spalte | Typ | Default | Beschreibung |
|--------|-----|---------|-------------|
| `bot_blocker_enabled` | INTEGER | 0 | Bot-Blocker aktiviert (0/1) |
| `bot_blocker_mode` | TEXT | 'block' | Modus: block, tarpit, drop, garbage, redirect, custom |
| `bot_blocker_count` | INTEGER | 0 | Kumulativer Counter geblockter Requests |
| `bot_blocker_config` | TEXT | null | JSON mit modusspezifischen Optionen (message, status_code, url) |

`bot_blocker_config` Beispiele:
- Block/Tarpit/Drop/Garbage: `null`
- Redirect: `{"url": "https://example.com"}`
- Custom: `{"message": "Access denied", "status_code": 403}`

---

## 3. Lizenz

### COMMUNITY_FALLBACK

```javascript
bot_blocking: false,
```

### API-Guard

```javascript
requireFeatureField('bot_blocker_enabled', 'bot_blocking')
```

Wird auf POST (create) und PUT (update) Route-Endpoints angewendet.

### Template-Gate

```nunjucks
{% if license.features.bot_blocking %}
  <!-- Toggle interaktiv -->
{% else %}
  <!-- Toggle mit Lock-Icon -->
{% endif %}
```

---

## 4. Backend-Service

### Route-Service (`routes.js`)

In `buildCaddyConfig`: Wenn `route.bot_blocker_enabled` ist truthy, wird der `defender`-Handler als **erstes Element** in die Handler-Chain eingefügt (vor dem trace-Handler):

```javascript
if (route.bot_blocker_enabled) {
  const defenderConfig = {
    handler: 'defender',
    raw_responder: route.bot_blocker_mode || 'block',
    ranges: ['openai', 'aws', 'gcloud', 'githubcopilot', 'deepseek', 'azurepubliccloud'],
  };
  const config = route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : {};
  if (config.message) defenderConfig.message = config.message;
  if (config.status_code) defenderConfig.status_code = config.status_code;
  if (config.url) defenderConfig.url = config.url;
  routeHandlers.unshift(defenderConfig);
}
```

Gleiche Logik für auth-geschützte Routen (`authHandlers`).

### CREATE/UPDATE

- `bot_blocker_enabled`, `bot_blocker_mode`, `bot_blocker_config` werden als Felder akzeptiert
- `bot_blocker_count` wird **nicht** über CREATE/UPDATE gesetzt — nur vom Background-Task
- Caddy-Sync nach Aktivierung/Deaktivierung

### Validierung

**Modus-Validierung:**
```javascript
const VALID_BOT_MODES = ['block', 'tarpit', 'drop', 'garbage', 'redirect', 'custom'];
if (data.bot_blocker_mode && !VALID_BOT_MODES.includes(data.bot_blocker_mode)) {
  throw new Error('Invalid bot blocker mode');
}
```

**Config-Validierung:**
- Modus `redirect`: `url` muss eine gültige `http://` oder `https://` URL sein, keine Caddy-Placeholders `{...}`
- Modus `custom`: `status_code` muss zwischen 100-599 liegen, `message` max 500 Zeichen, keine Caddy-Placeholders
- Modus `redirect` ohne URL oder `custom` ohne message/status_code: Fehler zurückgeben

### Bot-Counter Background-Task

Neuer periodischer Task (alle 60 Sekunden) in `server.js`:

1. Liest `/data/caddy/access.log` komplett (gleicher Ansatz wie bestehender `accessLog.js` Service)
2. Parst JSON-Zeilen, filtert nach `status === 403`
3. Filtert nach Timestamp > letzter bekannter Timestamp (um nur neue Einträge zu zählen)
4. Extrahiert Domain aus `request.host` (Port wird entfernt, case-insensitive)
5. Matched Domains gegen Routen mit `bot_blocker_enabled`
6. Inkrementiert `bot_blocker_count` in der DB per `UPDATE routes SET bot_blocker_count = bot_blocker_count + ? WHERE LOWER(domain) = LOWER(?) AND bot_blocker_enabled = 1`
7. Speichert den Timestamp des letzten verarbeiteten Eintrags

**Log-Rotation:** Kein Offset-basiertes Lesen — stattdessen Timestamp-basiert (wie `accessLog.js`). Wenn die Log-Datei rotiert wird, erkennt der Task dies automatisch weil alle Timestamps älter als der letzte bekannte sind.

**Bekannte Einschränkung:** Der Counter zählt alle 403er auf der Route, nicht nur die vom Defender. Routen mit gleichzeitig aktivem Bot-Blocker und ACL/IP-Filter können leicht überhöhte Werte zeigen. Eine exakte Zuordnung würde einen Custom-Response-Header oder eigenes Logging erfordern — zu komplex für den Mehrwert.

### Route-API

`bot_blocker_count` wird im bestehenden `GET /api/v1/routes` mit ausgeliefert — kein separater Endpoint nötig. Der Count ist bereits Teil des Route-Objekts aus der DB.

---

## 5. UI

### Create-Route-Card

Im `http-fields`-Bereich (nicht sichtbar bei L4-Routen), nach dem Debug-Toggle und vor dem Speichern-Button:

- Toggle "AI-Bot-Blocker" mit Lizenz-Gate
- Bei aktiviertem Toggle: Modus-Select (6 Optionen)
- Bei Modus `custom`: Message-Input + Status-Code-Input
- Bei Modus `redirect`: URL-Input

### Edit-Route-Modal — Security-Tab

Im bestehenden "Security"-Tab (passt thematisch):

- Toggle + Modus-Select + modusspezifische Felder
- Gleiche Struktur wie Create-Card

### Routen-Liste — Badge

Wenn `bot_blocker_enabled` und `route_type !== 'l4'`:

- `bot_blocker_count > 0`: Bot-SVG-Icon + Zähler, Farbe `tag-orange`
- `bot_blocker_count === 0`: Nur Bot-SVG-Icon (zeigt dass Blocker aktiv, aber noch nichts geblockt)

Badge wird nur für HTTP-Routen angezeigt.

---

## 6. i18n

### Neue Keys (13 pro Sprache)

| Key | EN | DE |
|-----|----|----|
| `bot_blocker.title` | AI Bot Blocker | AI-Bot-Blocker |
| `bot_blocker.toggle_desc` | Block AI crawlers from known IP ranges | AI-Crawler von bekannten IP-Bereichen blockieren |
| `bot_blocker.mode` | Mode | Modus |
| `bot_blocker.mode_block` | Block (403) | Blockieren (403) |
| `bot_blocker.mode_tarpit` | Tarpit (slow response) | Tarpit (langsame Antwort) |
| `bot_blocker.mode_drop` | Drop (close connection) | Drop (Verbindung trennen) |
| `bot_blocker.mode_garbage` | Garbage (random data) | Garbage (Zufallsdaten) |
| `bot_blocker.mode_redirect` | Redirect (308) | Weiterleitung (308) |
| `bot_blocker.mode_custom` | Custom response | Eigene Antwort |
| `bot_blocker.message` | Response message | Antwortnachricht |
| `bot_blocker.status_code` | Status code | Statuscode |
| `bot_blocker.url` | Redirect URL | Weiterleitungs-URL |
| `bot_blocker.badge` | bots blocked | Bots geblockt |

---

## 7. Backup/Restore

`bot_blocker_enabled`, `bot_blocker_mode`, `bot_blocker_config` werden in Backup/Restore aufgenommen.

`bot_blocker_count` wird **nicht** exportiert/importiert — der Counter startet nach Restore bei 0.

---

## 8. Dateien die geändert werden

| Datei | Änderung |
|-------|----------|
| `Dockerfile` | `--with github.com/JasonLovesDoggo/caddy-defender` |
| `src/db/migrations.js` | Migration 28: 4 neue Spalten mit `detect`-Funktion |
| `src/services/license.js` | `bot_blocking: false` in COMMUNITY_FALLBACK |
| `src/services/routes.js` | defender-Handler in buildCaddyConfig, Felder in CREATE/UPDATE |
| `src/routes/api/routes.js` | requireFeatureField-Guard (POST + PUT), Destructuring |
| `src/server.js` | Bot-Counter Background-Task (60s Intervall) |
| `templates/default/pages/routes.njk` | Bot-Blocker Toggle + Modus im http-fields-Bereich |
| `templates/default/partials/modals/route-edit.njk` | Bot-Blocker im Security-Tab |
| `public/js/routes.js` | Toggle-Logik, Modus-Select mit bedingten Feldern (custom→message+status, redirect→url), Badge-Rendering (Bot-SVG + Counter) |
| `src/i18n/en.json` | 13 neue Keys |
| `src/i18n/de.json` | 13 neue Keys |
| `src/services/backup.js` | bot_blocker_* Felder in Export/Restore |
