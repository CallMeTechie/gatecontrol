# Web Application Firewall (Coraza + OWASP Core Rule Set)

Status: geplant (Branch `feat/waf`, nach `feat/security-options`). Verbindliche
Schnittstelle zwischen Docker-Build, Backend und Oberfläche.

## Entscheidungen

- Engine: **Coraza** als Caddy-Modul (`github.com/corazawaf/coraza-caddy/v2`),
  Regeln: **OWASP CRS** aus dem Go-Modul `github.com/corazawaf/coraza-coreruleset`
  (im Binary eingebettet, keine Downloads zur Laufzeit). Dockerfile: `xcaddy build
  --with github.com/corazawaf/coraza-caddy/v2`; die Version wird gepinnt.
- WAF ist **pro HTTP-Route** schaltbar (Standard aus), Pro-Feature `waf`
  (Lizenzschlüssel neu; im Community-Fallback `false`). Ohne Lizenz zeigt die
  Oberfläche den Block gesperrt.
- Zwei Modi: `detect` (nur protokollieren, Standard beim Einschalten) und
  `block` (403 mit eigener Seite). Paranoia-Stufe 1–4 (Standard 1).
- Ausnahmen pro Route: Regel-IDs (`SecRuleRemoveById`) und Pfad-Ausnahmen
  (`SecRule REQUEST_URI "@beginsWith /pfad" "id:...,phase:1,pass,nolog,ctl:ruleEngine=Off"`).
- Audit-Log als JSON-Datei `/data/caddy/waf-audit.log` (Coraza `SecAuditLog`
  mit `SecAuditLogFormat JSON`, Rotation über Caddy nicht möglich → eigene
  Rotation durch GateControl: 20 MB, 3 Dateien). GateControl liest es wie das
  TLS-Log (Offset-Watcher) in die Tabelle `waf_events`.

## Datenbank: Migration v74 `waf`

```sql
ALTER TABLE routes ADD COLUMN waf_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN waf_mode TEXT NOT NULL DEFAULT 'detect';      -- detect|block
ALTER TABLE routes ADD COLUMN waf_paranoia INTEGER NOT NULL DEFAULT 1;      -- 1..4
ALTER TABLE routes ADD COLUMN waf_exclusions TEXT;                          -- JSON {rule_ids:[], paths:[]}
CREATE TABLE IF NOT EXISTS waf_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, host TEXT NOT NULL, route_id INTEGER, client_ip TEXT,
  method TEXT, uri TEXT, rule_id INTEGER, severity TEXT, message TEXT,
  action TEXT NOT NULL,                                                     -- 'blocked'|'detected'
  tx_id TEXT, raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_waf_events_ts ON waf_events(ts);
CREATE INDEX IF NOT EXISTS idx_waf_events_host ON waf_events(host, ts);
```

Aufbewahrung: `data.retention_waf_days` (Standard 14), Bereinigung mit den
bestehenden Aufräumläufen.

## Caddy (`caddyConfig.js`)

Handler `waf` (Modul `http.handlers.waf`) vor `reverse_proxy` in beiden Ketten:

```json
{ "handler": "waf",
  "directives": "Include @coraza.conf-recommended\nInclude @crs-setup.conf.example\nInclude @owasp_crs/*.conf\nSecRuleEngine DetectionOnly|On\nSecAction \"id:900000,phase:1,pass,nolog,setvar:tx.blocking_paranoia_level=<n>\"\nSecAuditEngine RelevantOnly\nSecAuditLogFormat JSON\nSecAuditLog /data/caddy/waf-audit.log\nSecAuditLogParts ABCFHZ\n<Ausnahmen>" }
```

Die Direktiven werden aus `waf_mode`, `waf_paranoia`, `waf_exclusions`
erzeugt; Regel-IDs für Pfad-Ausnahmen beginnen bei 10000 + route_id * 100.
`caddy validate` ist Teil der Tests; fehlt das Modul im Binary (alte Images),
lässt der Generator den Handler weg und `GET /api/v1/waf/status` meldet
`engine_available: false`.

## Backend `src/services/waf.js`

- `directivesFor(route)` (pure, testbar), `engineAvailable()` (prüft einmal
  `caddy list-modules` über die Admin-API `/config/` … bzw. `caddy list-modules`
  beim Start), `startWatcher()/stopWatcher()` (Audit-Log → `waf_events`,
  `eventBus.publish('waf', {host, action, rule_id})`), `stats({since})`,
  `listEvents({host, action, from, to, limit, cursor})`, `addExclusion(routeId,
  {rule_id|path})`.

## API (`/api/v1`, Scope `routes`)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/waf/status` | `{ engine_available, routes: [{route_id, host, mode, paranoia, events_24h, blocked_24h}] }` |
| GET | `/waf/events?host=&action=&limit=&cursor=` | Ereignisliste |
| POST | `/waf/routes/:id/exclusions` | `{ rule_id?, path? }` → ergänzt, Sync |
| DELETE | `/waf/routes/:id/exclusions` | `{ rule_id?, path? }` |
| PUT | `/api/v1/routes/:id` | Felder `waf_enabled, waf_mode, waf_paranoia` (Feature-Gate `waf`) |

## Oberfläche

- Eintrags-Editor, Tab Sicherheit: Block „Web Application Firewall“: Schalter,
  Modus (Nur erkennen / Blockieren), Paranoia-Stufe mit Erklärung, Liste der
  Ausnahmen. Empfehlung im Text: erst 1–2 Tage „Nur erkennen“ laufen lassen.
- Neue Seite `/waf` (Sidebar unter Routing, nur mit Lizenz): Kacheln (Ereignisse
  24 h, blockiert 24 h, Routen mit WAF), Filter (Host, Aktion, Zeitraum),
  Ereignistabelle mit Regel, Nachricht, Client-IP, URI; je Zeile „Regel für diese
  Route ausschließen“ und „Pfad ausschließen“.
- Zonen-Seite: Eintragschip-Notiz `WAF` bzw. `WAF (erkennt)`.
- Sprachschlüssel `waf.*` am Dateiende.

## Tests

Direktiven-Erzeugung; Audit-Log-Parser mit echten Coraza-JSON-Zeilen; Watcher
mit Rotation; Ereignis-API und Aufbewahrung; Caddy-Validierung einer Config mit
WAF-Handler (Image muss das Modul enthalten: Docker-Build in der CI prüfen,
Trivy-Scan beachten); Browser-Szenario mit gemocktem Status/Events.

## Risiken

- Build-Zeit und Binary-Größe des Caddy-Builds steigen; CRS-Updates kommen mit
  neuen Modulversionen (Dependabot).
- False Positives: deshalb `detect` als Standard und Ausnahmen direkt aus der
  Ereignisliste.
