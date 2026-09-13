# HSTS pro Host mit Domain-Standard

Status: in Umsetzung (Branch `feat/hsts`). Verbindliche Schnittstelle zwischen
Backend und Oberfläche. Wer abweicht, ändert zuerst dieses Dokument.

## Ausgangslage

GateControl setzt für Routen keinen `Strict-Transport-Security`-Header. Möglich
ist er heute nur über „Custom Headers“ (Pro). Die Management-Oberfläche sendet
ihn selbst (helmet). Manche Backends (z. B. Stirling-PDF) schicken einen eigenen.

## Entscheidungen

- HSTS ist eine Einstellung des **HTTP-Eintrags** (`routes`), sichtbar als
  Schalter pro Host im Domain-Dialog und im Eintrags-Editor (Tab Sicherheit).
- Pro Domain gibt es einen **Standard** für neue HTTP-Einträge, optional auf
  bestehende Hosts anwendbar.
- `preload` ist standardmäßig **aus** und verlangt `includeSubDomains` und
  `max-age ≥ 31536000` (Anforderung der Preload-Liste). Die Oberfläche warnt,
  dass Preload praktisch unumkehrbar ist, und fragt vor dem Aktivieren nach.
- HSTS setzt `https_enabled = 1` voraus. Der Header wird über den
  `reverse_proxy`-Antwortheader gesetzt (`headers.response.set`), ersetzt also
  einen vom Backend gesendeten Wert. Auf Port 80 kommt er nie an, weil Caddy
  bei `https_enabled` auf HTTPS umleitet. Für die Wartungsseite bei Gateway
  offline (`static_response`) wird kein HSTS gesetzt.
- Keine Lizenzschranke (Basis-Härtung, anders als Custom Headers).
- Ein `Strict-Transport-Security` in den Custom Headers wird ignoriert, sobald
  der HSTS-Schalter aktiv ist; die Oberfläche weist darauf hin.

## Datenbank: Migration v71 `hsts`

```sql
ALTER TABLE routes ADD COLUMN hsts_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN hsts_max_age INTEGER NOT NULL DEFAULT 31536000;
ALTER TABLE routes ADD COLUMN hsts_subdomains INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN hsts_preload INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN hsts_default TEXT;   -- JSON oder NULL (= aus)
```

`hsts_default`: `{ "enabled": bool, "max_age": int, "include_subdomains": bool, "preload": bool }`.

## Validierung (`routesValidation.js`, genutzt von API und Services)

- `hsts_max_age`: ganze Zahl 300 … 63072000.
- `hsts_preload = 1` nur mit `hsts_subdomains = 1` und `hsts_max_age ≥ 31536000`, sonst 400 `HSTS_PRELOAD_REQUIREMENTS`.
- `hsts_enabled = 1` nur bei `route_type = 'http'` und `https_enabled = 1`, sonst 400 `HSTS_REQUIRES_HTTPS`.
- Beim Ausschalten von `https_enabled` wird `hsts_enabled` mit auf 0 gesetzt.

Header-Wert: `max-age=<n>` + `; includeSubDomains` (wenn gesetzt) + `; preload` (wenn gesetzt).

## Caddy (`caddyConfig.js`)

Für jede HTTP-Route mit `https_enabled = 1` und `hsts_enabled = 1`, deren Handler
ein `reverse_proxy` ist: `applyResponseHeaders(reverseProxy, [{ name:
'Strict-Transport-Security', value }])` **nach** den Custom Headers, damit der
Schalter gewinnt. Bestehende Custom Headers gleichen Namens werden vorher aus
der Liste entfernt.

## Services

- `routes.create/update`: neue Felder durchreichen; beim Anlegen eines HTTP-
  Eintrags mit `https_enabled` ohne explizite `hsts_*`-Felder den
  Domain-Standard der Zone (`resolveZone(domain)` → `domains.hsts_default`)
  übernehmen.
- `hosts.create` / `hosts.addEntry`: dasselbe über `routes.create`.
- `domainZones.updateDefaults(domainId, { default_external_enabled?, hsts_default?, apply_hsts_to_existing? })`:
  speichert `hsts_default` (validiert wie oben; `null` = aus). Mit
  `apply_hsts_to_existing: true` werden alle HTTP-Einträge der Zone mit
  `https_enabled = 1` und ohne `gateway_override`-Einschränkung (Override ist
  hier egal) in einer Transaktion umgestellt (Snapshot via `routesRollback`,
  genau ein `withCaddySync`, Rollback bei Sync-Fehler).
- `GET /zones`: `entry.hsts = { enabled, max_age, include_subdomains, preload }`
  für HTTP-Einträge; `zone.hsts_default` (Objekt oder `null`).
- Ereignis `routes` wie bisher nach jeder Änderung.

## API

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| PUT | `/api/v1/routes/:id` | `hsts_enabled, hsts_max_age, hsts_subdomains, hsts_preload` (optional, wie die übrigen Felder) | wie bisher |
| PUT | `/api/v1/domains/:id/defaults` | `{ default_external_enabled?, hsts_default?: object\|null, apply_hsts_to_existing?: bool }` | `{ ok, zone, applied?: number }` |

Fehlercodes: `HSTS_PRELOAD_REQUIREMENTS`, `HSTS_REQUIRES_HTTPS`, `HSTS_MAX_AGE_INVALID` (alle 400).

## Oberfläche

### Domain-Dialog

- Kopfbereich neben „Standard-Zugriff“: **HSTS-Standard** als Select
  `Aus · 6 Monate · 1 Jahr · 2 Jahre` plus Kästchen `includeSubDomains` und
  `preload` (preload deaktiviert, solange die Voraussetzungen fehlen). Beim
  Ändern fragt ein Dialog: „Nur für neue Hosts“ oder „Auch auf n bestehende
  Hosts anwenden“ (n = HTTP-Einträge mit HTTPS). Bei aktiviertem preload
  erscheint im selben Dialog der Warntext und eine zusätzliche Bestätigung.
- Eintragszeile (HTTP mit HTTPS): Options-Tag **HSTS** (grün) wenn aktiv, sonst
  ein dezenter Tag `HSTS aus`. Klick öffnet den HSTS-Dialog des Eintrags:
  Schalter, max-age-Select, includeSubDomains, preload (mit Warnung und
  Bestätigung), Hinweis „wirkt erst, wenn ein gültiges Zertifikat vorliegt“,
  wenn `entry.tls.state !== 'issued'`, und Hinweis, wenn Custom Headers einen
  eigenen HSTS-Wert enthalten. Speichern → `PUT /api/v1/routes/:id` nur mit den
  `hsts_*`-Feldern.
- Einträge ohne HTTPS: kein Tag; im Dialog des Eintrags erklärt ein Hinweis,
  dass HSTS HTTPS voraussetzt.

### Eintrags-Editor (`entry-editor.js`, Tab Sicherheit)

Block „HSTS“ mit denselben Feldern; wird mit dem Formular gespeichert. Der
Block ist ausgegraut, solange „HTTPS erzwingen“ aus ist. Die Vorlage
„Sicherheits-Header“ bleibt, bekommt aber den Hinweis, dass HSTS über den
Schalter läuft.

### Zonen-Seite

Der HTTPS-Chip eines Hosts bekommt die Notiz `HSTS`, wenn der Eintrag es aktiv hat.

## Sprachschlüssel

`hsts.*` als ein zusammenhängender Block am Ende von `de.json`/`en.json`.

## Tests

- Migration v71 (Spalten, Defaults).
- `routesValidation`: Wertebereiche, Preload-Regeln, HTTPS-Pflicht.
- `caddyConfig`-Vertragstest: Header-Wert in `reverse_proxy.headers.response.set`, alle drei Varianten; kein Header bei `https_enabled = 0`, bei L4 und auf der Wartungsseite; Custom-Header gleichen Namens wird ersetzt.
- API: `PUT /routes/:id` mit gültigen/ungültigen Kombinationen; `PUT /domains/:id/defaults` mit `apply_hsts_to_existing` → alle betroffenen Einträge geändert, genau ein Sync, Rollback bei Sync-Fehler; neue Einträge erben den Standard.
- UI: statische Prüfung (Ids/Klassen/Keys), Template-Render, Browser-Szenario (Standard setzen und anwenden, Eintrags-Dialog, Preload-Bestätigung, Editor-Block).
