# Gateway-Standorte

Wo die Gateways stehen — „Zuhause“, „Büro“, „Eltern“ — mit optionaler Adresse. Ersetzt das
frühere Feld „Standort (optional)“ des Assistenten, das in Wahrheit die **Peer-Gruppe** des
Gateway-Peers setzte. Die Peer-Gruppe bleibt am Peer, wie sie ist (Seite „Peers“), der
Assistent setzt sie nicht mehr. Nur für Admins, keine Lizenzfunktion (auch Community).

## Daten (Migration 141)

| Tabelle / Spalte | Inhalt |
|---|---|
| `gateway_locations.name` | Pflicht, 1–80 Zeichen, eindeutig ohne Groß/Klein (auch Umlaute, geprüft im Dienst; Index `lower(name)` als Rückhalt) |
| `street`, `postal_code`, `city` | optional, Freitext (120 / 16 / 80 Zeichen; PLZ nur Buchstaben, Ziffern, Leerzeichen, Bindestrich) |
| `country` | optional, ISO 3166-1 alpha-2 (`DE`); die Namen zeigt der Browser (`Intl.DisplayNames`) |
| `created_at`, `updated_at` | epoch ms |
| `gateway_meta.location_id` | Standort des Gateways; `ON DELETE SET NULL` |

Bestehende Gateways starten ohne Standort. Eine Übernahme aus den Peer-Gruppen gibt es bewusst
nicht (Peer-Gruppen sind meist keine Orte, z. B. „RDP“).

Sicherung (`services/backup.js`): `data.gateway_locations` (ohne ids) und in `gateway_meta` der
Name statt der id (`location_name`); die Wiederherstellung legt die Standorte neu an und verknüpft
über den Namen.

## API (`src/routes/api/gatewayLocations.js`, Dienst `src/services/gatewayLocations.js`)

| Aufruf | Antwort |
|---|---|
| `GET /api/v1/gateway-locations` | `{ ok, locations: [{ id, name, street, postal_code, city, country, gateway_count, gateways: [{ peer_id, name }] }] }`, nach Name |
| `POST /api/v1/gateway-locations` `{ name, street?, postal_code?, city?, country? }` | `201 { ok, location }` |
| `PUT /api/v1/gateway-locations/:id` (alle Felder, fehlende werden geleert) | `{ ok, location }` |
| `DELETE /api/v1/gateway-locations/:id` | `{ ok, released: [{ peer_id, name }] }` — die Gateways bleiben, ohne Standort |
| `PUT /api/v1/gateways/:id/location` `{ location_id \| null, also?: [peer ids] }` | `{ ok, changed: [{ peer_id, name, from, to }] }` — `also`: der Pool-Partner; alles oder nichts |
| `GET /api/v1/gateways` | je Gateway `location: { id, name, city, country } \| null` |
| `POST /api/v1/peers` `{ is_gateway, …, location_id? }` | unbekannter Standort → 400 |
| `GET /api/v1/gateways/:id/setup-status` | zusätzlich `location_id` (Assistent, „Einrichtung fortsetzen“) |

Fehler: `400 invalid` (mit `fields`, übersetzt), `409 name_taken`, `404 not_found` /
`gateway_not_found`. Rechte: der `/api/v1`-Router (Admin-Sitzung + CSRF); API-Tokens brauchen
`gateway` oder `full-access` (Präfix `/api/v1/gateway` in `services/tokens.js`, wie bei den Pools).

Aktivitätsprotokoll (Kategorie „Peers & Gateways“): `gateway_location_created`,
`gateway_location_updated` (auch umbenannt), `gateway_location_deleted` (mit der Zahl der
freigegebenen Gateways), `gateway_location_changed` (je Gateway, nur bei echter Änderung).

## Oberfläche (`public/js/gateway-locations.js`, Regeln in `gateway-location-kit.js`)

- **Kopf der Seite:** „Standorte“ öffnet den Dialog: Liste (Name, Adresse · Land, Anzahl
  Gateways, Bearbeiten, Löschen), Formular an Ort und Stelle (Name, Straße und Hausnummer, PLZ,
  Ort, Land), leerer Zustand, Rückfrage beim Löschen mit den Gateway-Namen.
- **Flotte:** sobald es einen Standort gibt, „Gruppieren nach: Standorte | Pools“ (Wahl pro
  Browser in `localStorage` `gc.gw.fleetGroup`, Vorgabe „Standorte“). Standorte: je Standort ein
  Abschnitt (Adresse, „x von y online“, „Bearbeiten“), „Ohne Standort“ gestrichelt zuletzt;
  Standorte ohne Gateway nur im Dialog. Pool-Mitglieder tragen „Pool „…“ · Rolle“. Pools: die
  Ansicht wie bisher, jede Karte mit Standort-Marke.
- **Gateway:** Chip unter dem Namen (wenn gesetzt), Zeile „Standort“ in „Gerät & Software“
  („Ändern“ / „Festlegen“), „Mehr“ → „Standort ändern …“. Der Dialog: Auswahl, „Ohne Standort“,
  „Neuer Standort …“, bei Pool-Partnern „Auch für … übernehmen“ (vorausgewählt, wenn sie heute
  am selben Standort stehen).
- **Assistent, Schritt 1:** „Kein Standort“, die Standorte („Name – Ort“), „Neuer Standort …“
  mit Name und Ort, aufklappbar Straße, PLZ und Land. Der neue Standort wird direkt vor dem
  Gateway angelegt; scheitert das Gateway (z. B. Lizenz), nimmt ein zweiter Versuch denselben.

## Tests

`tests/gateway_locations_api.test.js` (Migration, API, Aktivität, Rechte, Sicherung),
`tests/gateway_location_kit.test.js` (Regeln, Seite, Texte), Browser:
`tests/e2e/scenarios/28-gateway-locations.js` (`gatewaylocations`).

## Später denkbar

Pool-Vorschläge aus Gateways am selben Standort, Anwesenheit „zu Hause“ je Standort, Wetter
über den Ort, eigene Zeitzone je Standort, WLAN-Land und Zeitzone des Pi-Images aus dem Standort.
