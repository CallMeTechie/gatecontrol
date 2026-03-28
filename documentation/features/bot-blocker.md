# AI-Bot-Blocker

## Übersicht

Der AI-Bot-Blocker schützt über GateControl exponierte Services vor unerwünschten AI-Crawlern. Er erkennt und blockiert Zugriffe von bekannten AI-Firmen (OpenAI, Google, AWS, DeepSeek, GitHub Copilot, Microsoft Azure) anhand ihrer IP-Adressbereiche — direkt auf Reverse-Proxy-Ebene, bevor der Request das Backend erreicht.

**Lizenz-Feature-Key:** `bot_blocking`

## Funktionsweise

Der Bot-Blocker basiert auf dem [caddy-defender](https://github.com/JasonLovesDoggo/caddy-defender) Plugin für Caddy. Er wird als **erster Handler** in die Caddy-Route-Chain eingefügt — noch vor Request-Tracing, Rate-Limiting, Authentifizierung und Compression. Dadurch werden Bots sofort abgewiesen, ohne andere Handler zu belasten.

### Erkannte IP-Bereiche

Das Plugin pflegt automatisch aktuelle IP-Listen der folgenden Anbieter:

| Anbieter | Beschreibung |
|----------|-------------|
| **OpenAI** | GPTBot, ChatGPT-User und andere OpenAI-Dienste |
| **AWS** | Amazon Web Services (häufig von AI-Crawlern genutzt) |
| **Google Cloud** | Google-Extended, Gemini und andere Google-AI-Dienste |
| **GitHub Copilot** | GitHub Copilot Anfragen |
| **DeepSeek** | DeepSeek AI-Crawler |
| **Azure** | Microsoft Azure Public Cloud |

Die IP-Listen werden vom Plugin-Maintainer regelmäßig aktualisiert.

## Konfiguration

### Bot-Blocker aktivieren

1. Route öffnen (Edit-Modal → **Security**-Tab)
2. **AI Bot Blocker** Toggle aktivieren
3. **Modus** wählen (siehe unten)
4. Route speichern

Der Bot-Blocker kann auch beim Erstellen einer neuen Route aktiviert werden (in der "Neue Route anlegen"-Card).

### Verfügbare Modi

| Modus | Verhalten | Anwendungsfall |
|-------|-----------|---------------|
| **Block (403)** | Gibt HTTP 403 Forbidden zurück | Standard — klar und eindeutig |
| **Tarpit** | Antwortet extrem langsam (tröpfchenweise) | Verschwendet Crawler-Ressourcen, bindet deren Verbindungen |
| **Drop** | Trennt die TCP-Verbindung sofort | Aggressivste Option, kein Response |
| **Garbage** | Sendet zufällige Daten als Response | Vergiftet Training-Daten des Crawlers |
| **Redirect (308)** | Leitet zu einer anderen URL weiter | Z.B. auf eine "Zugang verweigert"-Seite |
| **Custom** | Eigene Nachricht mit wählbarem Status-Code | Flexibel — z.B. 451 "Unavailable For Legal Reasons" |

### Modusspezifische Einstellungen

#### Redirect-Modus
- **Redirect URL** (Pflichtfeld): Die Ziel-URL für die Weiterleitung (muss mit `http://` oder `https://` beginnen)

#### Custom-Modus
- **Antwortnachricht**: Der Text der an den Bot gesendet wird (max. 500 Zeichen)
- **Statuscode**: HTTP-Statuscode der Antwort (100-599, Standard: 403)

## Bot-Counter

### Funktionsweise

Ein Hintergrund-Task zählt alle 60 Sekunden die geblockten Requests pro Route. Der Counter basiert auf HTTP 403-Responses im Caddy Access-Log, gefiltert nach der Domain der Route.

### Anzeige

In der Routen-Liste wird ein **oranges Badge** angezeigt:

- **Bot-Icon + Zahl** (z.B. `🤖 42`): Anzahl der bisher geblockten Requests
- **Nur Bot-Icon** (ohne Zahl): Bot-Blocker ist aktiv, aber noch keine Bots geblockt

Das Badge wird nur für HTTP-Routen angezeigt (nicht für L4/TCP-Routen).

### Bekannte Einschränkung

Der Counter zählt **alle** HTTP 403-Responses auf der Route, nicht nur die vom Bot-Blocker. Wenn auf derselben Route auch IP-Zugriffskontrolle oder ACL aktiv ist, können diese ebenfalls 403-Responses erzeugen, die mitgezählt werden. Für die meisten Anwendungsfälle ist die Genauigkeit ausreichend.

## API

### Route erstellen/bearbeiten

Die Bot-Blocker-Einstellungen werden über die bestehende Route-API gesteuert:

```bash
# Bot-Blocker aktivieren (Block-Modus)
curl -X PUT /api/v1/routes/:id \
  -H "Content-Type: application/json" \
  -d '{
    "bot_blocker_enabled": true,
    "bot_blocker_mode": "block"
  }'

# Redirect-Modus
curl -X PUT /api/v1/routes/:id \
  -H "Content-Type: application/json" \
  -d '{
    "bot_blocker_enabled": true,
    "bot_blocker_mode": "redirect",
    "bot_blocker_config": "{\"url\": \"https://example.com/blocked\"}"
  }'

# Custom-Modus
curl -X PUT /api/v1/routes/:id \
  -H "Content-Type: application/json" \
  -d '{
    "bot_blocker_enabled": true,
    "bot_blocker_mode": "custom",
    "bot_blocker_config": "{\"message\": \"AI crawlers are not welcome\", \"status_code\": 451}"
  }'
```

### API-Felder

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `bot_blocker_enabled` | Boolean | Bot-Blocker aktiviert/deaktiviert |
| `bot_blocker_mode` | String | Modus: `block`, `tarpit`, `drop`, `garbage`, `redirect`, `custom` |
| `bot_blocker_config` | String (JSON) | Modusspezifische Konfiguration |
| `bot_blocker_count` | Integer (read-only) | Anzahl geblockter Requests (nur in GET-Response) |

## Testen

### Bot-Blocking verifizieren

```bash
# Normaler Request — sollte durchkommen
curl -s -o /dev/null -w "%{http_code}" https://deine-route.com/
# Erwartetes Ergebnis: 200 (oder 302 bei Auth)

# Request von einer OpenAI-IP simulieren (nur im lokalen Netzwerk möglich)
# Stattdessen: Im GateControl-Log nach "defender" Einträgen suchen
docker logs gatecontrol 2>&1 | grep "defender"
```

### Counter prüfen

```bash
# Route-Daten abrufen — bot_blocker_count enthält den aktuellen Zähler
curl -s /api/v1/routes/:id | jq '.route.bot_blocker_count'
```

## Einschränkungen

- **Nur HTTP-Routen**: L4/TCP-Routen unterstützen kein Bot-Blocking (caddy-defender ist ein HTTP-Handler)
- **IP-basiert**: Blockierung basiert auf IP-Adressen, nicht auf User-Agent-Strings. Bots die über nicht-gelistete IP-Bereiche kommen, werden nicht erkannt.
- **Keine benutzerdefinierten IP-Ranges**: Es werden die vom Plugin gepflegten Standard-Ranges verwendet
- **Keine Whitelist**: Einzelne IPs können nicht vom Blocking ausgenommen werden
- **Counter-Genauigkeit**: Zählt alle 403er, nicht nur Bot-Blocks (siehe oben)

## Datenbank

### Felder in der `routes`-Tabelle

| Spalte | Typ | Default | Beschreibung |
|--------|-----|---------|-------------|
| `bot_blocker_enabled` | INTEGER | 0 | Feature aktiviert (0/1) |
| `bot_blocker_mode` | TEXT | 'block' | Aktiver Modus |
| `bot_blocker_count` | INTEGER | 0 | Kumulativer Block-Counter |
| `bot_blocker_config` | TEXT | null | JSON mit modusspezifischen Optionen |

### Migration

Version 28 (`add_bot_blocker`) — erstellt am 2026-03-28.

## Backup/Restore

Die Bot-Blocker-Konfiguration (`bot_blocker_enabled`, `bot_blocker_mode`, `bot_blocker_config`) wird bei Backup/Restore berücksichtigt. Der `bot_blocker_count` wird **nicht** exportiert — der Counter startet nach einem Restore bei 0.

## Technische Details

### Caddy-Handler-Config

```json
{
  "handler": "defender",
  "raw_responder": "block",
  "ranges": ["openai", "aws", "gcloud", "githubcopilot", "deepseek", "azurepubliccloud"]
}
```

### Handler-Position in der Route-Chain

```
1. defender (Bot-Blocker)     ← blockiert Bots sofort
2. trace (Request-Tracing)
3. headers (Custom Headers)
4. rate_limit
5. mirror (Request Mirroring)
6. encode (Komprimierung)
7. reverse_proxy (Backend)
```

### Go-Modul

`pkg.jsn.cam/caddy-defender` (ursprünglich `github.com/JasonLovesDoggo/caddy-defender`)

### Background-Task

- **Intervall:** 60 Sekunden
- **Quelle:** `/data/caddy/access.log`
- **Logik:** Parst JSON-Zeilen, filtert nach `status === 403`, matched `request.host` gegen Routen mit `bot_blocker_enabled`, inkrementiert `bot_blocker_count`
- **Log-Rotation:** Timestamp-basiertes Tracking (kein Offset), kompatibel mit Caddy's Log-Rotation (10 MB, 3 Dateien)
