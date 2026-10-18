# Anordnung der App-Tabs pro Konto

Ab 1.181.0. Die Reihenfolge und die ausgeblendeten Karten des **Start**- und
des **Familie**-Tabs der Android-App (Kacheln, Widgets, Info-Karte,
Datenverbrauch, Familie-Karten) liegen auf dem Server — mit dem Konto auf allen
Geräten gleich. Der Administrator legt fest, wo eine Anordnung gilt.

## Einstellung `client_layout_scope`

Einstellungen → **Client-Richtlinien** → Karte „Anordnung in den Apps“
(Setting `client_layout_scope`):

| Wert | Bedeutung |
|------|-----------|
| `device` | Pro Gerät: jedes Gerät merkt sich seine eigene Anordnung lokal (Verhalten vor 1.181.0); der Server speichert nichts |
| `user` | Pro Benutzer (Standard): eine Anordnung je Konto, auf allen Geräten des Kontos gleich |
| `global` | Für alle: eine gemeinsame Anordnung; nur Administratoren ändern sie (in der App mit ihrem eigenen Konto) |

Admin-API (nur Admin-Sitzung, kein API-Token):

* `GET /api/v1/settings/client-layout` → `{ ok, data: { scope, scopes } }`
* `PUT /api/v1/settings/client-layout` `{ scope }` → dasselbe; ungültig → 400.
  Eine Änderung schreibt den Aktivitätseintrag `client_layout_scope_updated`
  (`{ from, to }`) und schickt allen offenen Push-Streams das
  Steuerereignis `layout`.

Gespeicherte Anordnungen bleiben beim Wechsel erhalten: Wer von `global` zurück
auf `user` stellt, bekommt wieder die persönlichen Anordnungen.

## Client-API

Gerätetoken (Scope `client` oder `full-access`), Maschinenbindung wie bei den
anderen Client-Routen. Die Anordnung gehört dem Besitzer des Tokens; ein Token
ohne (aktiven) Besitzer bekommt `403 { error: 'no_user' }`.

### `GET /api/v1/client/layout`

```json
{ "ok": true, "scope": "user", "editable": true,
  "layout": { "start": ["tile:vpn", "widget:gatecontrol-klima/room:3"], "startHidden": ["tile:services"],
              "familie": ["card:shopping"], "familieHidden": [] },
  "updatedAt": "2026-10-18T09:12:44.120Z" }
```

| Scope | `layout` | `editable` |
|-------|----------|------------|
| `device` | immer `null` — die App speichert lokal wie bisher | `true` |
| `user` | die Anordnung der Person, `null` solange keine gespeichert ist | `true` |
| `global` | die gemeinsame Anordnung, `null` solange keine gespeichert ist | nur für Administratoren |

`layout: null` heißt: die App nimmt ihre Standard-Reihenfolge (bzw. bei
`device` ihre lokale). `updatedAt` (ISO-8601 UTC mit Millisekunden) ist `null`
ohne gespeicherte Anordnung.

### `PUT /api/v1/client/layout`

Body `{ layout }` → `{ ok: true, updatedAt }`.

* `layout`: `{ start, startHidden, familie, familieHidden }` — je eine Liste
  von Eintrags-IDs, die die App selbst festlegt (z. B. `tile:vpn`,
  `widget:<plugin>/<id>`, `card:traffic`; eine Breite kann die App z. B. als
  `@2` anhängen). Der Server kennt die IDs nicht, er prüft nur:
  * je Liste höchstens **100** Einträge;
  * jeder Eintrag 1–120 Zeichen aus `[A-Za-z0-9:_./@-]`;
  * Duplikate werden entfernt (der erste bleibt);
  * eine fehlende Liste wird `[]`, unbekannte Schlüssel werden ignoriert
    (neuere Apps).
* `layout: null` entfernt die gespeicherte Anordnung (`updatedAt: null`).
* Fehler: `400 invalid_layout` (kein Objekt, Liste kein Array oder zu lang,
  ungültiger Eintrag — es wird nichts gespeichert), `409 device_scope` (der
  Administrator hat „Pro Gerät“ gewählt), `403 forbidden` (Scope `global` und
  der Besitzer ist kein Administrator), `403 no_user`.

### Live-Aktualisierung

Nach einem Speichern bekommen die anderen Geräte das Steuerereignis `layout`
über den Push-Stream (docs/feature-notification-center.md „Steuerereignisse“):

```
event: control
data: {"type":"layout","scope":"user","updated_at":"2026-10-18T09:12:44.120Z"}
```

* Scope `user`: die anderen offenen Streams derselben Person;
* Scope `global`: alle offenen Streams;
* jeweils nicht das speichernde Gerät; eine Änderung des Geltungsbereichs
  geht an alle offenen Streams (`updated_at: null`).

Die App lädt daraufhin `GET /api/v1/client/layout`. Ohne Stream (oder nach
einem Neuaufbau) lädt sie beim Öffnen des Tabs.

## Verhalten der App

* Scope `user` / `global`: Anordnung vom Server laden und beim Anordnen per
  `PUT` speichern; lokal nur als Zwischenspeicher.
* Scope `global` und `editable: false`: Anordnen-Einstieg deaktiviert, mit
  Hinweis „Vom Administrator festgelegt“.
* Scope `device`, `404` (älterer Server) oder `no_user`: lokal wie bisher.

## Datenhaltung

Tabelle `client_layouts` (Migration 104): Schlüssel `user:<id>` bzw. `global`,
`user_id` (mit dem Konto gelöscht), `layout` (JSON), `updated_at`,
`updated_by`. Gelesene Zeilen werden erneut geprüft. Die Anordnung ist nicht
Teil der Sicherung — nach einer Wiederherstellung laden die Apps ihre lokale
bzw. Standard-Anordnung und speichern sie beim nächsten Anordnen neu.
