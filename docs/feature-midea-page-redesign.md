# Redesign der Klimaanlage-Seite (`/midea`)

Reines **Presentation-Redesign** der Admin-Seite `/midea` im Aurora-Stil,
konsistent in allen drei Themes (aurora/default/pro). Die Geräte werden als
Karten-Grid mit Temperatur-Ring, Stepper, Modus-Segment und Besitzer-Avatar-Chips
dargestellt; die Besitzer-Zuweisung läuft über einen suchbaren Dialog statt des
früheren Inline-`<details>`; „Gerät hinzufügen" ist in einem Dialog mit
Cloud/Manuell-Segment konsolidiert.

**Kein** Backend-, API- oder DB-Change. Die Seite baut auf der bestehenden
Midea-Klimasteuerung (Protokoll-Kern, Cloud-/LAN-Transport) und der
AC-Besitzer-Zuordnung (Sub-A) auf — deren Endpunkte (`GET /api/v1/midea/devices`
inkl. `owners`, `PUT …/owners`, `GET /api/v1/users`) und alle Steuer-/Add-/Discover-
Verhalten bleiben unverändert. Gating wie zuvor: admin-only + Lizenz
`midea_integration`.

## Problem

Die alte Seite rendert Geräte als flache `.device-row`-Zeilen, in die Name,
Transport, Zieltemperatur-Input, Modus-`<select>`, Aktions-Buttons **und** der
Besitzer-`<details>`-Picker in eine Zeile gequetscht sind. Das ist unübersichtlich,
auf Mobil unbrauchbar und passt nicht zum Aurora-Look der übrigen Seiten. Die
Besitzer-Zuweisung über die Inline-Checkbox-Liste ist wenig intuitiv.

## Lösung

Drei Bausteine — gemeinsame CSS, umgebautes Seiten-Skelett je Theme, umgebauter
Render-/Handler-Teil im Frontend-JS:

| Baustein | Aufgabe |
|---|---|
| `public/css/midea.css` (neu) | Bespoke Komponenten: Geräte-Karte, Temperatur-Ring, Stepper, Besitzer-Chips/Avatare, Picker-Liste, KPI-Streifen. Gescopt unter `.midea-page`/`.midea-modal`. |
| `templates/{aurora,default,pro}/pages/midea.njk` | Seiten-Skelett: Page-Header + Aktionen, statischer KPI-Container, Geräte-Grid-Container, zwei Dialog-Includes. |
| `templates/{aurora,default,pro}/partials/modals/midea-{owner,add}.njk` | Besitzer-Dialog + Hinzufügen-Dialog (bestehende Formulare hineinverschoben). |
| `public/js/midea.js` | Karten-Rendering, KPI-Befüllung, `refreshState` auf Karten-Teilelemente, Besitzer-Dialog, Hinzufügen-Dialog-Verdrahtung. |

### Token-Strategie (themt automatisch in allen 3 Themes)

`midea.css` verwendet **ausschließlich** das gemeinsame Legacy-Token-Vokabular,
das alle drei Themes definieren (`--bg-card/-hover/-input`, `--border`,
`--border-hi`, `--text-1/2/3`, `--accent`, `--accent-lt`, `--green/-lt/-bd`,
`--amber`, `--red/-lt`, `--blue`, `--purple`, `--font-display/-mono`, `--radius`)
— **keine** aurora-nativen Tokens (`--teal-soft`, `--chip`, `--line-2`). Dadurch
rendert dieselbe CSS in jedem Theme korrekt (aurora dark, default light, pro).
Aurora bekommt zusätzlich den Alias `--purple-bd: var(--purple-border);`, damit
das Vokabular vollständig ist.

Eingebunden wird `midea.css` **page-scoped** via `{% block head %}` im Template
(nicht global im Layout) — die Datei lädt nur auf `/midea`, Projekt-Konvention wie
`portal.css`/`route-auth.css`.

### Geräte-Karte

Jede `.ac-card[data-id]` zeigt: Kopf (Icon, Name, Transport-Tag, Online/Offline-
Status-Tag), Klima-Block (Temperatur-Ring mit Innentemperatur, Stepper für die
Zieltemperatur, Modus-Segment mit allen fünf Modi Auto/Cool/Heat/Dry/Fan als
Icons — der Modusname steht in `title`/`aria-label`),
Besitzer-Block (Avatar-Chips der `owners` + Button „Verwalten"/„Zuweisen") und die
Aktionszeile (Power, Refresh|Test, Entfernen). Über dem Grid liegt ein
KPI-Streifen (Geräte, Online, Mit Besitzer, Cloud-Konto).

### Besitzer-Dialog

Klick auf „Verwalten"/„Zuweisen" öffnet `#midea-owner-modal`: suchbare Nutzerliste
mit Avatar, Name/Rolle und Häkchen (vorbelegt aus `device.owners`), Auswahlzähler,
Speichern/Abbrechen. Speichern ruft `PUT /devices/:id/owners {user_ids}`, schließt
den Dialog und lädt die Karten neu. Der clientseitige Suchfilter ist ein einfacher
`O(n)`-Filter (ausreichend bis ~50 Nutzer).

### Hinzufügen-Dialog

„Gerät hinzufügen" öffnet `#midea-add-modal` mit Segment-Umschalter
(Cloud-Konto / Manuell per IP). Die bestehenden Submit-Handler
(`#midea-cloud-form`, `#midea-ip-form`) und `loadCloudDevices()` bleiben
unverändert — nur in den Dialog verschoben. Nach erfolgreicher Geräte-Aufnahme
schließt der Dialog automatisch; die Cloud-Connect-Form bleibt offen (zeigt danach
die Cloud-Geräteliste zum Hinzufügen).

## JS↔CSS-Kontrakte (verbindlich)

Diese Kontrakte halten CSS und JS synchron:

- **Ring:** JS setzt `card.querySelector('.ac-ring').style.setProperty('--ring-val', pct + '%')`;
  CSS liest den Prozentwert direkt als conic-Stop:
  `conic-gradient(var(--accent) var(--ring-val,0%), var(--bg-hover) 0)`
  (Vollkreis-Gauge — **kein** `calc(% * deg)`, das wäre ungültiges CSS). `pct` ist
  die Innentemperatur auf 16–30 °C normiert.
- **Stepper:** Ein **separater** Click-Listener setzt den versteckten
  `<input data-act="target">` (geklemmt 16–30) und dispatcht
  `new Event('change', { bubbles:true })` → der bestehende Change-Handler greift
  unverändert. Bei noch nicht geladenem State (`!input.value`) wird **kein**
  API-Call abgesetzt.
- **Modus:** früher `<select data-act="mode">` (change), jetzt
  `.toggle-btn[data-act="mode"]` (click). Der Click-Handler bekam den Modus-Zweig,
  der Change-Handler verlor ihn (kein Doppel-Fire).
- **Avatar-Farbe:** stabil per User-ID,
  `['av-accent','av-blue','av-purple','av-green','av-amber'][userId % 5]`.
- **Modale:** Sichtbarkeit/Schließen über die Projekt-Primitive
  `window.openModal(id)` / `window.closeModal(id)` aus `app.js`;
  Schließen-Buttons tragen `data-close-modal`, Escape/Backdrop kommen ebenfalls
  von `app.js` — **keine** eigene `.open`-Klasse, kein eigener Listener.
- **`#midea-kpis`** ist ein **statisches** Skelett-Element direkt vor
  `#midea-devices` (nur sein `innerHTML` wird gefüllt). Das ist nötig, damit die
  Re-Auth-Banner-Anker-Logik (`el.previousElementSibling`) intakt bleibt — ein
  dynamisch eingefügtes KPI-Element würde sie beim zweiten `loadDevices()`-Aufruf
  brechen.
- **`_devicesCache`** (Modul-Scope, in `loadDevices()` gesetzt) liefert dem
  Besitzer-Dialog das Gerät zum geklickten `card.dataset.id` (kein `window`-Global).
- **Initialer State-Load:** direkt nach dem Karten-Render ruft `loadDevices()` für
  **jedes** Gerät `refreshState` auf (fire-and-forget, parallel) — der Live-Status
  erscheint also automatisch beim Laden, ohne dass „Aktualisieren"/„Test" geklickt
  werden muss. Fehler/Offline/Rate-Limit behandelt `refreshState` pro Karte.

## Bedienung

- `/midea` zeigt das Karten-Grid mit KPI-Streifen.
- Temperatur per Stepper (±0,5 °C), Modus per Segment, Ein/Aus per Power.
- „Verwalten"/„Zuweisen" → Besitzer-Dialog (suchen, an-/abwählen, speichern).
- „Gerät hinzufügen" → Dialog mit Cloud-/Manuell-Segment.
- „Geräte suchen" (Discover) und alle übrigen Aktionen unverändert.

## Validierung

Da `jsdom` im Projekt nicht verfügbar ist, sind die deterministischen Gates:

- **i18n-Determinismus** (`tests/midea_redesign_i18n.test.js`): alle neuen Keys
  existieren en+de und sind in allen drei `layout.njk`-`window.GC.t`-Whitelists.
- **CSS-Smoke** (`tests/midea_css_smoke.test.js`): `midea.css` definiert die
  Komponenten-/Modal-Klassen, der aurora-Alias existiert, und `midea.css` ist in
  allen drei `pages/midea.njk` page-scoped verlinkt.
- **Render-Guard** (`tests/midea_api.test.js`): `GET /midea` liefert 200.

Die JS-Interaktion und das visuelle Erscheinungsbild werden über eine
Playwright-Scratch-Harness verifiziert (nicht committet, analog
`.superpowers/sdd/aurora-shots.js`): Screenshots der Seite + beider Dialoge in
allen drei Themes plus Interaktions-Asserts (Dialog öffnen/suchen/Zähler-Toggle/
Speichern→PUT/schließen, Segment-Umschalter). Die Harness setzt das Theme über
`user.theme` in der DB und seedet Geräte+Besitzer via
`mideaDevices.createDevice` + `mideaOwners.setOwners`.

## Internationalisierung

Sechzehn neue client-seitige Keys (Dialog, KPI, Hinzufügen-Tabs, Status) in en+de,
in allen drei `window.GC.t`-Whitelists. **Keine** neuen Server-Keys. Alle
Nutzer-/Gerätenamen werden im Frontend über `esc()` ausgegeben (XSS).

## Bekannte Grenzen / Eigenschaften

- **Modus-Segment:** Es werden bewusst alle fünf Modi (Auto/Cool/Heat/Dry/Fan)
  angeboten — das entspricht dem bisherigen `<select>`. Das abgenommene Mockup
  zeigte nur drei Modi; eine Reduktion wäre eine Funktionsregression gewesen.
  Damit fünf Buttons in die Karte passen (und die Beschriftung nicht überläuft),
  sind sie als **Icons** dargestellt (`.midea-page .mode-group .mode-btn`, je
  `flex:1`); der Modusname steht in `title`/`aria-label`.
- **Besitzer-Anzahl:** Zielfall Haushalt = ≤5 Besitzer/Gerät → die 5er-Avatar-
  Palette ist eindeutig. Bei 6–10 wiederholen sich Farben (per Name-Initial
  unterscheidbar). >10 ist kein erwarteter Fall.
- **Template-Triplikation:** drei nahezu identische `pages/midea.njk` (+ je zwei
  Dialog-Partials) sind die bewusste Projekt-Konvention (ein `.njk` je Theme); das
  gemeinsame Aussehen liegt in `midea.css`.
- **Partieller State:** wird ein Gerät online gemeldet, ohne dass Innen-/
  Zieltemperatur vorliegen, zeigt die Karte „—" statt `NaN`/`undefined` (Guard in
  `setCardState`).

## Dateien

- `public/css/midea.css` — neu, gemeinsame Komponenten (nur Legacy-Tokens).
- `public/css/aurora.css` — `--purple-bd`-Alias.
- `templates/{aurora,default,pro}/pages/midea.njk` — Seiten-Skelett.
- `templates/{aurora,default,pro}/partials/modals/midea-owner.njk` — Besitzer-Dialog.
- `templates/{aurora,default,pro}/partials/modals/midea-add.njk` — Hinzufügen-Dialog.
- `templates/{aurora,default,pro}/layout.njk` — `window.GC.t`-Whitelist (16 Keys).
- `public/js/midea.js` — Karten-Render, KPIs, `refreshState`, Besitzer-/Add-Dialog.
- `src/i18n/{en,de}.json` — 16 neue client-seitige Keys.
- `tests/midea_redesign_i18n.test.js`, `tests/midea_css_smoke.test.js` — neu.
