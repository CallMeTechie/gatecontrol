# Plugins

GateControl can be extended with plugins: installable packages that bring their
own pages, a portal tab, settings, a background service and their own storage.
Each plugin runs in **its own process**, isolated from the server, and can only
use what its `plugin.json` declares and the administrator grants.

Settings → **Plugins** lists the installed plugins, installs new ones (upload of
a `.gcplugin` file, four steps: *Prüfen → Berechtigungen → Lizenz → Fertig*, or
one click in **Offizielle Plugins** — see "Official plugin catalogue"),
switches them on and off, enters licences, assigns network targets and
uninstalls them (keep or delete the data). An update shows which permissions
change compared with the installed version (*neu* / *geändert* / *entfällt*).

Code: `src/services/plugins/` · admin API `src/routes/api/plugins.js` · pages
`src/routes/plugins.js` · UI `templates/aurora/partials/settings-plugins.njk`,
`public/js/settings-plugins.js`, `public/js/plugins-ui.js`,
`public/js/plugin-bridge.js` · example plugin `tests/fixtures/plugins/hello/`.

## Package format (`.gcplugin`)

```
gzip( "GCPLUGIN" 0x00 0x01 | entry* | u16 0 )
entry = u16 pathLength | path (UTF-8) | u32 size | bytes
```

An own container instead of tar/zip: an entry is a regular file by
construction — there are no symlinks, hard links, devices, permissions or
owners that could be smuggled in. The reader (`package.js`) additionally
checks every path (relative, segments `[A-Za-z0-9._-]`, no `.`/`..`/hidden
segments, no backslashes, ≤ 200 characters, ≤ 12 levels, no duplicates — also
case-only — and no file/folder clashes), caps the upload (20 MB), the size
after gunzip (50 MB, enforced by the gunzip itself — no zip bomb) and the
number of files (1000), and rejects trailing data. Extraction writes into a
fresh temporary folder with `wx` and re-checks that every target stays inside
it.

Contents:

| File | |
|---|---|
| `plugin.json` | manifest (below) |
| `signature` | publisher signature (optional) |
| `<entry>` | server code, e.g. `server/index.js` |
| `migrations/NNN_name.sql` | SQL migrations of the plugin's own database |
| `CHANGELOG.md` | optional |
| anything else | assets the plugin reads itself |

Build: `node scripts/plugin-pack.js <folder> [-o file.gcplugin]` — signs when
`GC_PLUGIN_SIGNING_KEY` is set (base64 32-byte Ed25519 seed or PEM). Dot files
are skipped, symbolic links refused. `node scripts/plugin-keygen.js` prints a
new key pair (run it on your own machine; never commit the private seed).

## Official plugin catalogue

The first-party repository
[CallMeTechie/gatecontrol-plugins](https://github.com/CallMeTechie/gatecontrol-plugins)
publishes `catalog.json` as an asset of its rolling release `catalog`
(`https://github.com/CallMeTechie/gatecontrol-plugins/releases/download/catalog/catalog.json`,
format in that repository's README, "Catalogue"). The plugin area shows it
as a page of its own (**Einstellungen › Plugins › Katalog**, see "Plugin area" below): areas,
search, highlight, cards with *Installieren* / *Aktualisieren*, one page per
plugin with its release notes. When GitHub cannot be reached the page says so
("Katalog nicht erreichbar – Plugins lassen sich weiterhin hochladen.") — the
upload is unaffected.

Store metadata (optional, from `catalog-meta.json` of the plugins repository;
an unknown or malformed value is dropped, never the catalogue): per plugin
`category` (`family` | `home` | `mobility` | `infrastructure` | `other`),
`icon` (`family` `chat` `calendar` `door` `bulb` `snowflake` `car` `server`
`nas` `puzzle`, since 1.206.0 `cloud`), `summary` `{de, en}`, `audience` (`all` | `admins`),
`keywords`, `related` (plugin ids) and `highlight` `{version, title, text,
tags}` (`tags`: up to 4 texts or `{icon, text}` for the hero); for the
plugin's catalogue page `adds` and `permissions` (up to 8 / 10
`{icon, title, text, tag?}` — "Was … hinzufügt", "Das darf das Plugin";
`tag` marks a sensitive permission), `shows` (up to 3 `{kind: tile|list|widget,
caption, value?}` — the wireframes of "So sieht es bei dir aus"), `needs`
(what it needs besides GateControl, e.g. an API token) and `languages`
(`de`, `en`); symbols: `page app portal widget tile action bell clock data
network chat key location users door calendar camera car bulb server shield
link cloud` (`cloud` since 1.206.0). Per version `notes` (its CHANGELOG section, Markdown). Without them a
plugin is listed under "Weitere" with the default icon, its page shows only
what the catalogue knows.

Code: `src/services/plugins/catalog.js` · API `src/routes/api/pluginCatalog.js`.

| Environment | |
|---|---|
| `GC_PLUGIN_CATALOG=off` | catalogue switched off completely: no card, no request to GitHub, the API answers `enabled: false` / `catalog_disabled` |
| `GC_PLUGIN_CATALOG_URL` | another catalogue (https only, no credentials); its host is allowed in addition to the GitHub hosts. Packages from it must still carry a trusted signature (`GC_PLUGIN_PUBKEYS` for an own key) |

**Fetch** (server side): https only; the catalogue URL, every package URL and
every redirect target must be on an allowed host — `github.com`,
`objects.githubusercontent.com`, `release-assets.githubusercontent.com`
(github.com answers release downloads with a 302 to one of those) plus the
host of `GC_PLUGIN_CATALOG_URL`; anything else, `http:` or a URL with
credentials ends the request (`catalog_redirect` / `catalog_bad_url`), the
foreign host is never contacted. At most 5 redirects; catalogue ≤ 2 MB within
15 s; kept in memory for an hour (*Katalog neu laden* = `?refresh=1`; a
failure is remembered for a minute). A test run (`NODE_ENV=test`) never
reaches the internet.

**Validation** (strict — one malformed entry rejects the whole catalogue,
`catalog_invalid`): `schema: 1`; every key a plugin id by the id rule (and
equal to the plugin's and each entry's `id`); `publisher`; `versions[]` with
`schema: 1`, semver `version` (no duplicates), boolean `prerelease` and
`license_required`, a valid `gatecontrol` range, `size` within the package
limit (20 MB), lowercase hex `sha256`, `url` (and `release_url`) https on an
allowed host. `latest` is checked the same way but not used: GateControl
picks per plugin the **newest non-prerelease version whose `gatecontrol`
range the running version satisfies** (a semver pre-release such as
`1.2.0-rc.1` counts as one whatever the flag says).

**State per plugin**: `not_installed`, `installed` (same or newer version
installed), `update` (installed version < the compatible newest),
`incompatible` (no version fits this GateControl); `requiresNewer` names a
newer release that needs a newer GateControl.

**Install / update** (`POST /api/v1/plugin-catalog/install { id, version }`):
the entry is looked up in the validated catalogue (listed, not a pre-release,
compatible), the package is downloaded by the server (same host/redirect
rules, ≤ `size` from the catalogue and ≤ 20 MB, 90 s), its sha256 compared
with the catalogue, and the bytes — held in memory, never written to disk —
go into the **same `inspect()`** as an upload: same checks, same staging
token, same dialog, then the normal `POST /api/v1/plugins/install` with
`accept: true`. On top of an upload, `inspect()` refuses (before any token
exists) a package whose `plugin.json` is another id or version than the one
requested (`catalog_mismatch`) and one without a **trusted** signature
(`catalog_untrusted`, also when unsigned plugins are allowed). The package
signature is verified by `signature.verify()` against the trusted keys; the
catalogue's `signature` / `public_key` fields are informational and never
used. The activity log entry of the install carries `source: "catalog"`.

What is verified where:

| Check | Where |
|---|---|
| https, allowed hosts, redirects, size cap, timeout | `catalog.fetchAllowed()` (catalogue and package) |
| catalogue structure, ids, versions, urls | `catalog.validate()` |
| version listed, stable, compatible | `catalog.installable()` |
| download = catalogue sha256 | `catalog.download()` |
| package format, manifest, migrations, compatibility, existing plugin | `inspect()` → `analyse()` (as for an upload) |
| signature against trusted keys; same id and version as requested | `inspect()` with `expect` |
| permissions accepted, package re-checked before writing | `install()` (as for an upload) |

API (admin session + CSRF; `pluginApiLimiter`, downloads and `?refresh=1`
also `uploadLimiter`; an API token gets 403):

* `GET /api/v1/plugin-catalog` → `{ enabled, available, serverVersion, fetchedAt, plugins: [{ id, name, description, publisher, state, installedVersion, latest: { version, gatecontrol, licenseRequired, size, releaseUrl, publishedAt } | null, requiresNewer }] }`
* `GET /api/v1/plugin-catalog` items also carry `category, icon, summary, audience, keywords, related, highlight, adds, permissions, shows, needs, languages` and `latest.notes`; the answer `source: { host, official }`
* `GET /api/v1/plugin-catalog/updates` → `{ updates: [{ id, name, from, to, kind: patch|minor|major, gatecontrol, size, needsApproval, notes: [{ version, publishedAt, notes }] }], autoUpdate, catalogCheck, history }`
* `GET /api/v1/plugin-catalog/:id` → one plugin with `versions` (newest first, at most 20, with `notes`)
* `POST /api/v1/plugin-catalog/install` `{ id, version }` → the answer of `POST /api/v1/plugins/inspect` (`origin: "catalog"`; on an update `existing.permissions` for the diff)

## Plugin area

The plugin area is a page of its own under **Einstellungen › Plugins**
(`/settings/plugins`; choosing "Plugins" in the settings navigation opens
it). The sidebar entry "Einstellungen" and the settings entry "Plugins" carry
a badge / dot: plugins stopped by a problem or crashed plus the updates of the
cached catalogue. One page, `templates/aurora/pages/plugins.njk`, with a side
column (back to Einstellungen; Plugins: Meine Plugins, Katalog, Updates,
Lizenzen; Verwaltung: Sicherheit & Upload, Protokoll — on a phone tabs on top);
the views are built by `public/js/plugins-page.js` (pure helpers in
`public/js/plugins-ui.js`), layout and wording follow the mockup "Plugins –
UI & UX Konzept":

| URL | View |
|---|---|
| `/settings/plugins` | Meine Plugins: state tiles, "Braucht deine Aufmerksamkeit" (crashed, licence, unsigned, expiring licence, updates — each with its action), search, filter, list or tiles grouped by area, suggestions; without plugins the first-run page |
| `/settings/plugins/catalog`, `…/catalog/<id>` | the catalogue (areas and filters in the side column); one plugin: what it adds, what it may do, how it looks, versions, the install panel |
| `/settings/plugins/manage/<id>` | one installed plugin: Übersicht, Einstellungen, Berechtigungen, Lizenz, Protokoll, Versionen; restart, switch, update, uninstall |
| `/settings/plugins/updates` | updates with release notes, *Alle aktualisieren*, automatic updates, recently updated |
| `/settings/plugins/licenses` | a first-party licence key without naming the plugin; the licences of all plugins |
| `/settings/plugins/security` | upload with preview, unsigned plugins, media in backups, update checks, catalogue source |
| `/settings/plugins/log` | installs, updates and uninstalls (who, when, automatic or not) |

The addresses of GateControl 1.182 (`/plugins`, `/plugins/catalog[/<id>]`,
`/plugins/updates`, `/plugins/licenses`, `/plugins/security`,
`/plugins/manage/<id>`) are forwarded to the same view, so these path
segments stay reserved: `plugin.json` cannot use `catalog`, `updates`,
`licenses`, `security` or `manage` as its id. Old settings links
(`/settings#plugins`, `?plugin=<id>`, `?install=<id>`) are forwarded too.
"Was … hinzufügt" of an installed plugin also counts the quick actions and
widgets it lists right now (`GET /api/v1/plugins/contributions`).

Installing or updating (catalogue or uploaded file) is one dialog: **Prüfen**
(checks, permissions — sensitive ones marked, on an update the difference —,
licence key, "gleich einrichten") → **Installieren** → done.

## Updates

`src/services/plugins/updates.js`:

* **Update check** (setting `plugins.catalog_check`, default on): every 6
  hours the catalogue is fetched; a new version is logged once as
  `plugin_update_available` (notification centre, row "Plugin-Updates").
* **Automatic updates** (setting `plugins.auto_update`: `off` (default) |
  `patch` | `all`): once a night between 03:00 and 05:00 server time the
  updates of signed first-party plugins are installed exactly like a click
  (download, sha256, `inspect()` with the trusted-signature requirement,
  `install()`), logged as `plugin_auto_updated`. An update that asks for other
  permissions is never installed automatically: `plugin_update_needs_approval`
  once per version, the Updates page marks it.
* **History** (setting `plugins.history`, the last 100): install, update and
  uninstall with versions, `by: admin|auto` and the administrator.

API (admin session + CSRF): `PUT /api/v1/plugins/policy` also takes
`{ autoUpdate }` and `{ catalogCheck }`; `GET /api/v1/plugins/history`;
`POST /api/v1/plugins/:id/restart`; `POST /api/v1/plugins/license-key`
`{ key }` (first-party: the key joins the plugin keys of the GateControl
licence, the licence is validated and the entitlement whose masked key
matches names the plugin; a key the licence server calls invalid is not kept;
no answer yet → `license_pending`). `GET /api/v1/plugins` items also carry
`errors7d`, `uses` / `usedBy` (services between plugins) and `provides`.

### Replacing a plugin (`replaces`)

Since 1.185.0 a plugin can move to a new id — a new name for the same
plugin, e.g. `gatecontrol-raumklima` for `gatecontrol-midea`:

```json
{ "id": "gatecontrol-raumklima", "version": "2.0.0", "gatecontrol": ">=1.185.0",
  "replaces": ["gatecontrol-midea"] }
```

`replaces` lists up to three other plugin ids. It only acts for a package
whose signature is trusted (first-party), whose own id is not installed yet,
while one of the listed ids is installed. Installing it then (the install
dialog says so, check `replaces`):

1. stops the old plugin and moves its folders `plugin-data/<old>` (database
   with settings and secrets, `files/`) and `plugin-media/<old>` to the new
   id. The database keeps its `_gc_migrations`: **the new plugin continues
   the old migration numbering** (`001_…`, `002_…` are not run again);
2. installs the new code and runs its migrations;
3. moves everything stored under the old id: home targets and discovery
   grant, licence key, kiosk users, the built-in import record, media rows
   and the media quota, notification rules, subscriptions and muted topics
   (`plugin:<old>:…` → `plugin:<new>:…`), and the apps' saved layouts (tiles,
   widgets, shortcuts naming the old id as a whole word);
4. removes the old code, registry row and log, and keeps the enabled state.

If anything fails before step 3 the folders move back and the old plugin is
as it was (`replace_conflict` when data already exists under the new id).
Ids stored elsewhere — quick action ids in other plugins' rules, service
calls (`plugin: '<old>'`), callback buttons of earlier pushes — resolve to the
new plugin; first-party licence entitlements of the old slug count for the
new plugin, so no new licence is needed. The apps keep their own copies of
pinned quick actions and widgets: the quick action list names the old ids
of such a plugin (`formerly: ['<old>']`, since 1.186.2), and the apps move
what they stored under an old id to the new plugin.

In the catalogue the old entry is no longer listed; with the old plugin
installed the new one appears as its update (state `update`, `replaces:
{ id, name, version }`; on the Updates page kind `replace`). Automatic updates
never install it — an administrator does, once.

## Signature

`signature` is JSON `{ "v": 1, "alg": "Ed25519", "publicKey": "<base64 raw 32>", "sig": "<base64>" }`,
signed over the canonical manifest of all other files:

```
GCPLUGIN-MANIFEST-V1\n
<sha256 hex> <path>\n   (one line per file, paths in byte order)
```

| Result | Meaning |
|---|---|
| trusted | valid, by a trusted key → **Verifiziert**, first-party (CallMeTechie) |
| untrusted | valid, but by an unknown key → treated as **unsigned** |
| none | no signature → **unsigned** |
| invalid | a signature that does not verify → the package was changed: **always rejected** |

Trusted keys: `BUILTIN_PUBLIC_KEYS` in `src/services/plugins/constants.js`
(the CallMeTechie key of the gatecontrol-plugins release CI) plus
`GC_PLUGIN_PUBKEYS` (JSON array of base64 raw keys; tests, own builds).

**Unsignierte Plugins erlauben** (Plugins › Sicherheit & Upload, default
off; switching on needs the typed word `ERLAUBEN`, checked by the server):
off → unsigned packages are rejected at upload and installed unsigned plugins
are switched off (data kept). A signed plugin can never be updated by an
unsigned build of the same id.

## plugin.json

```json
{
  "id": "gatecontrol-smarthome",
  "name": { "de": "Smart Home", "en": "Smart Home" },
  "version": "2.1.0",
  "publisher": "CallMeTechie",
  "description": { "de": "…", "en": "…" },
  "gatecontrol": ">=1.146.0",
  "entry": "server/index.js",
  "permissions": {
    "network": {
      "internet": ["identity.vwgroup.io", "*.example.com", "api.example.com:443"],
      "homeTargets": [
        { "id": "gateway", "label": { "de": "deCONZ-Gateway", "en": "deCONZ gateway" }, "protocols": ["http"] },
        { "id": "ac", "label": "Klimagerät", "protocols": ["tcp:6444", "udp:6445"], "multiple": true }
      ],
      "localDiscovery": { "udp": [6445, 20086] }
    },
    "storage": true,
    "portal": true,
    "users": true,
    "app": true,
    "kiosk": true,
    "actions": true,
    "notify": { "perHour": 60 },
    "background": { "intervalSeconds": 60 },
    "events": true,
    "services": ["gatecontrol-messenger:send_message"],
    "publicLinks": true,
    "devices": true,
    "groups": "read"
  },
  "media": { "maxBytes": 26214400, "types": ["image/jpeg", "image/webp", "audio/ogg", "application/pdf"], "quotaDefault": "10GB" },
  "services": { "provides": { "scene": { "label": { "de": "Szene schalten", "en": "Switch a scene" } } } },
  "ui": {
    "nav": { "label": { "de": "Smart Home", "en": "Smart Home" }, "icon": "<svg path d>" },
    "pages": [{ "id": "main", "title": { "de": "Smart Home", "en": "Smart Home" } }],
    "settingsGroups": [
      { "id": "account", "label": { "de": "Konto", "en": "Account" }, "help": { "de": "Zugang zum Dienst", "en": "Access to the service" } }
    ],
    "settings": [
      { "key": "interval", "type": "number", "label": "Abfrageintervall", "min": 10, "max": 3600, "default": 30 },
      { "key": "token", "type": "secret", "label": "API-Schlüssel", "group": "account" }
    ],
    "portal": {
      "label": { "de": "Klima", "en": "Climate" }, "icon": "<svg path d>",
      "sections": [{ "id": "smarthome", "tab": "home", "title": { "de": "Smart Home", "en": "Smart Home" }, "order": 20 }]
    },
    "app": { "label": { "de": "Smart Home", "en": "Smart Home" }, "icon": "<svg path d>" },
    "maps": true,
    "geolocation": true,
    "scanQr": true,
    "inbox": true
  },
  "license": { "required": true, "server": "https://licenses.example.com/check" },
  "migrations": "migrations",
  "notifyTopics": [
    { "id": "charging", "label": { "de": "Laden abgeschlossen", "en": "Charging complete" }, "default": true },
    { "id": "alarm", "label": { "de": "Alarm", "en": "Alarm" }, "allowCritical": true },
    { "id": "message", "label": { "de": "Nachrichten", "en": "Messages" }, "chat": true }
  ]
}
```

* `id`: `[a-z0-9]+(-[a-z0-9]+)*`, 2–64 characters; for first-party plugins it
  is the slug of the licence server's plugin entitlement.
* texts are a string or `{ de, en }`.
* `gatecontrol`: semver range of compatible server versions (`>=`, `<`, `^`,
  `~`, `1.x`, `||`), checked against `package.json`.
* setting types: `text`, `number` (`min`/`max`), `boolean`, `select`
  (`options: [{ value, label }]`), `secret` (stored encrypted, never sent to
  the browser).
* `permissions.network` may also be an array — short for `{ internet: [...] }`.
* `permissions.background`: `{ "intervalSeconds": n }` with an integer
  5 ≤ n ≤ 86400 (else `permissions.background.intervalSeconds: invalid`) —
  the host calls the `tick` hook every n seconds; the install dialog shows
  "läuft alle n Sekunden". Each tick has 120 s; a tick still running (or one
  the host gave up on after its timeout and that still runs in the plugin
  process) is never started twice — the next one is skipped.
* `permissions.notify`: `true` (≤ 30 pushes per hour) or `{ "perHour": n }`
  with an integer 1 ≤ n ≤ 120 (no other key); anything else is
  `permissions.notify: invalid`. See "Notifications".
* `permissions.app` (boolean): the plugin answers requests of the GateControl
  apps (device tokens). `ui.app` `{ label, icon }` (optional, needs
  `permissions.app` — else `ui.app: needs permissions.app`; label ≤ 40, icon
  an SVG path like `ui.nav.icon`, default a square; no other keys) gives the
  plugin its own tab in the apps. Without `ui.app` the plugin is API-only.
  See "App".
* `ui.maps` (boolean): OpenStreetMap tiles and the host's Leaflet in the
  plugin's frames. See "Maps".
* `ui.geolocation` (boolean, since 1.179.0): the plugin's frames may ask for
  the browser's location — the `<iframe>` gets `allow="geolocation *"` (next
  to `microphone *` of a `media` plugin), so `navigator.geolocation` works in
  the sandboxed frame; the browser still asks the person. Nothing else of the
  frame changes. The install dialog shows "Standort: darf in seinen Seiten
  nach dem Standort des Browsers fragen …". Errors `ui.geolocation: invalid`.
* `ui.scanQr` (boolean, since 1.196.0): the plugin's frames may read QR
  codes with `window.GC.scanQr()` — GateControl's own page opens its camera
  dialog and hands the frame only the text that was read (see "QR codes"
  under "User interface"). The frame gets no camera, its `<iframe>` no
  `allow`; the frame document has `GC.scanQr` and the `<iframe>`
  `data-plugin-scanqr` only for such plugins. The install dialog shows
  "QR-Codes: Kamera zum Scannen von QR-Codes (das Bild bleibt in GateControl,
  das Plugin bekommt nur den gelesenen Text)". Errors `ui.scanQr: invalid`.
  An older GateControl ignores the key (`GC.scanQr` is missing there:
  feature-detect it and offer another way, e.g. a picture upload decoded in
  the frame).
* `ui.camera` (boolean, since 1.188.0; **use `ui.scanQr`**): every `<iframe>`
  of the plugin (admin page, settings page, portal tab and sections) gets
  `allow="camera *"` (after `microphone *` / `geolocation *`). That is not
  enough in Chromium (Chrome, Edge, Android): `getUserMedia` in the sandboxed
  frame fails with "SecurityError: Invalid security origin" — the frame's
  origin is opaque — so a camera scan in the frame does not work there.
  Since 1.196.0 the key also grants `GC.scanQr`, so plugins that declared it
  keep a working scan once they call it. The install dialog shows "Kamera:
  darf in seinen Seiten die Kamera verwenden …", marked as sensitive, and the
  QR-Codes row. Errors `ui.camera: invalid`.
* `ui.settingsPage` (since 1.188.0): the id of one of `ui.pages` (never the
  first one — the navigation opens that) that is the plugin's own settings
  UI: GateControl shows it in the plugin's settings tab (Einstellungen ›
  Plugins › the plugin › Einstellungen) as its own sandboxed frame, above the
  declared `ui.settings` (or alone when there are none), and no longer as a
  page tab; `window.GC.openSettings()` leads there. The frame is the same
  admin page frame (`render` gets `view: 'page'` and that `page`, the admin
  API, administrators only). For accounts or devices a declarative form
  cannot hold — several accounts, a QR code scanned with the camera, a list
  of people to map. Errors `ui.settingsPage: invalid`. An older GateControl
  ignores the key and shows the page as a page tab.
* `ui.inbox` (boolean, since 1.179.0, needs `ui.portal` — else `ui.inbox:
  needs ui.portal`): the plugin's portal frames may show the viewer's own
  notification inbox as an entry (`window.GC.inbox`, see "User interface"):
  the unread count and the newest item's title, time and priority, and a call
  that opens the portal's inbox. The install dialog shows "Postfach: sieht im
  Portal, wie viele Mitteilungen … ungelesen sind …". Errors `ui.inbox:
  invalid`.
* `permissions.kiosk` (boolean): the plugin may mark users as kiosk users
  (`gc.kiosk.allow`) — those users can get kiosk devices (wall tablets that
  stay signed in to the portal for 90 days, see "Kiosk devices" below and
  [feature-kiosk-devices.md](feature-kiosk-devices.md)). The install/consent
  dialog shows "darf Benutzer als Kiosk-Geräte freigeben (z. B. Wand-Tablet)"
  / "may mark users as kiosk devices (e.g. wall tablet)".
* `permissions.actions` (boolean): the plugin may list, read and run the quick
  actions other plugins offer to a user (`gc.actions.list` / `gc.actions.get` / `gc.actions.run`,
  e.g. a presence rule switching a smart home scene, or a chat's "open the
  front door" button that runs as the person who pressed it — see "Running
  other plugins' quick actions" below). The install/consent dialog shows "darf
  Schnellaktionen anderer Plugins auslösen (z. B. Smart-Home-Szenen)" / "may
  run other plugins' quick actions (e.g. smart home scenes)".
  `permissions.actions: { interactive: true }` (since 1.180.0) grants the
  same and additionally *interactive* runs (`gc.actions.run({ …,
  interactive: true })`: a person pressed the button for exactly this action
  in this plugin's UI just now — the target plugin treats it like that
  person's tap); the dialog then also shows "darf Aktionen auslösen, wenn
  eine Person sie in diesem Plugin antippt (z. B. Tür öffnen aus dem Chat)" /
  "may run actions when a person taps them in this plugin (e.g. open the door
  from the chat)". `{ interactive: false }` equals `true`; any other value →
  `permissions.actions: invalid` (a plugin using the object form needs
  `"gatecontrol": ">=1.180.0"`).
* `notifyTopics` (optional, needs `permissions.notify`): up to 20 own push
  topics, `id` `[a-z][a-z0-9_-]{0,31}`, `label` text (≤ 60), `default`
  (boolean, default `true`: people get the topic until they switch it off; `false`:
  only who subscribes), `allowCritical` (boolean, default `false`: see
  "Notifications"). Each becomes the topic `plugin:<id>:<topic>` — a rule in
  System › Benachrichtigungen, a channel in the apps and a switch in the portal.
  See "Notifications" below. `chat` (boolean, default `false`, since 1.177.0):
  a topic for messages between people — see "Chat notifications"; never
  together with `allowCritical`, never on `default` (else `notifyTopics: chat
  topic cannot be critical or default`).
* `media` (optional, since 1.177.0): `{ maxBytes, types, quotaDefault }` —
  files the plugin's users upload through GateControl (pictures, voice
  messages, documents). `maxBytes` an integer 1024 … 2147483648 (2 GB; 100 MB before 1.193.0) per
  file; `types` 1 … 32 MIME types (`image|audio|video|application|text/…`,
  lower-cased; never types a browser runs — HTML, XML, SVG, JavaScript, CSS —
  nor the host's own body types JSON / form data); `quotaDefault` the storage
  quota of all the plugin's files, `"10GB"`, `"500 MB"` (KB/MB/GB/TB) or bytes,
  1 MB … 1 TB and ≥ `maxBytes`, default 1 GB — the administrator changes it on
  the plugin's overview. `uploads` (boolean, since 1.190.0, default `true`):
  `false` = the plugin's users cannot upload (apps, portal, admin page,
  `GC.upload` → `403 uploads_disabled`), only `gc.media.fetch` adds files;
  the install dialog then says "speichert Dateien, die es selbst aus dem
  Internet lädt … – keine Uploads seiner Benutzer". Errors `media: invalid`,
  `media.maxBytes: invalid`, `media.types: invalid`, `media.quotaDefault:
  invalid`, `media.uploads: invalid`. See "Media".
  Since 1.193.0: `maxBytes` up to 2147483648 (2 GB; before 100 MB);
  `types` may also name a whole family — `"image/*"`, `"video/*"`,
  `"audio/*"`, `"application/*"` (never `"text/*"`) — every concrete type of
  it except the ones never stored (HTML, XML, SVG, JavaScript, CSS, JSON, form
  data); `resumable` (boolean, default `false`): uploads of the apps and
  frames may continue after an abort (see "Resumable uploads");
  `handOverMaxBytes` (1024 … 2 GB, ≤ the quota, default `maxBytes`): the
  largest file another plugin may hand over to this one (`gc.media.handOver`)
  — e.g. a messenger keeping 25 MB for its own uploads but taking 2 GB files
  from GateDrop. Errors `media.resumable: invalid`, `media.handOverMaxBytes:
  invalid`. An older GateControl refuses the new keys (`media: invalid`) —
  declare `"gatecontrol": ">=1.193.0"`.
  Since 1.208.0: `previews` (boolean, default `false`): GateControl makes
  small previews of the plugin's pictures and takes the previews the apps send
  for photos and videos it cannot read — see "Previews". Error
  `media.previews: invalid`; an older GateControl refuses the key (`media:
  invalid`) — declare `"gatecontrol": ">=1.208.0"`.
* `permissions.events` (boolean, since 1.177.0): realtime events to the
  plugin's users (`gc.events.emit`) — see "Realtime events". The install
  dialog shows "Live-Ereignisse: darf Live-Ereignisse an die Apps und
  Plugin-Seiten seiner Benutzer senden".
* `permissions.notifySink` (boolean, since 1.191.0): the plugin delivers
  notifications people route into chats (hooks `deliverNotice`,
  `mayRouteToFamily`) — see "Notifications in chats". The install dialog
  shows "Mitteilungen in Chats zustellen".
* `permissions.publicLinks` (boolean, since 1.193.0): the plugin may share
  some of its media files through download links that work **without a
  login** (`gc.publicLinks.*`) — but only after an administrator switched
  "Öffentliche Links erlauben" on for this plugin (default off). The install
  dialog shows "Öffentliche Links: Öffentliche Download-Links ohne Anmeldung
  …", marked as sensitive. Errors `permissions.publicLinks: invalid`. See
  "Public links".
* `permissions.devices` (boolean, since 1.193.0): the plugin sees the
  GateControl apps of a person (`gc.devices.list`), gets the asking device
  with every app request (`user.device`) and may send notifications to single
  devices and silent data notifications (`gc.notify` `devices` / `silent`).
  The install dialog shows "Geräte: sieht die GateControl-Apps …". Errors
  `permissions.devices: invalid`. See "Devices".
* `permissions.groups` (`"read"` or `"manage"`): the person groups of
  GateControl (`gc.groups.*`, the hooks `groupsChanged` / `groupUsage` /
  `groupDeleting`, `gc.notify({ groups })`, `GC.pickPrincipals`); `"manage"`
  also creates and maintains the plugin's own groups (`gc.groups.ensure` /
  `remove`). The install dialog shows "Gruppen: Gruppen und Mitglieder lesen"
  or "Gruppen: Gruppen und Mitglieder lesen und eigene Gruppen verwalten",
  marked as sensitive. Errors `permissions.groups: invalid`. See "Groups".
* `services` (optional, since 1.177.0): `{ "provides": { "<name>": { "label" } } }`
  — services other plugins may call (`<name>` `[a-z][a-z0-9_]{0,31}`, ≤ 32,
  label text ≤ 60, no other keys; errors `services: invalid`,
  `services.provides: invalid`). `permissions.services`: `["<plugin>:<service>"]`
  (≤ 32) — the services of other plugins this plugin may call
  (`permissions.services: invalid`; one of its own: `permissions.services:
  own service`). See "Services".

## Network

A plugin process has no network of its own; every connection is made by the
host, which checks it against three target classes:

1. **internet** — host names from `plugin.json` (exact or `*.domain` =
   sub-domains, optional ports) for `gc.http.fetch(url)`. Every resolved
   address must be **public**: private, loopback, link-local (cloud metadata),
   CGNAT, ULA, multicast, reserved ranges, the WireGuard network, Docker
   networks and the server's own addresses are refused. The connection is
   pinned to the checked address (no DNS rebinding between check and connect).
2. **homeTargets** — what the plugin needs in the home network, by id. The
   **administrator** assigns the concrete target after installation
   (Plugins › the plugin › Einstellungen → *Zugriffsziele*): a GateControl route
   (HTTP or L4, internal or external), a VPN peer, or an address (host, IP,
   also internal-only domains of the VPN DNS). The plugin only names the id
   (`gc.net.fetchTarget('gateway', '/api/…')`, `gc.net.tcpTarget('ac', { index })`)
   and cannot reach any home or VPN address nobody assigned. Transport like
   GateControl itself:
   * HTTP route via a gateway → companion proxy `http://<gateway VPN IP>:8080`
     with `X-Gateway-Target-Domain: <route domain>` (`routes.resolveCompanionUrl`,
     as Smart Home does today; the plugin cannot override that header);
   * HTTP route to a peer or a direct target → its backend;
   * L4 route → the gateway listener / peer / target as Caddy dials it;
   * peer / address → direct (names through the server's DNS).
   Protocols per target: `http`, `tcp:<ports>`, `udp:<ports>` (ports are
   enforced for peers/addresses; a route brings its own).
3. **localDiscovery** — UDP broadcast on the declared ports in the server's
   own local networks (no Docker/WireGuard interfaces), only after the
   administrator allows it per plugin. Answers come with their source address;
   a device found this way still has to be assigned as a target before TCP.

Never reachable, even when assigned: loopback, unspecified, multicast, cloud
metadata, and the GateControl admin API / Caddy admin ports on this server's
addresses.

`http.fetch` / `fetchTarget` options: `method`, `headers`, `body` (string or
JSON) / `json` / `form` / `bodyBase64`, `binary`, `timeoutMs` (≤ 60 s),
`redirect: 'manual'` (default) or `'follow'` (≤ 10 hops, every hop checked
again, stops at a non-http(s) location such as an OAuth app scheme and returns
that 3xx). The result has `status`, `headers` (lower case; `set-cookie` as a
list), `body` or `bodyBase64`, `url`, `redirects`. Response bodies are capped
at 5 MB.

`gc.net.uploadTarget(id, path, opts)` (since 1.193.0, host API
`target.upload`) sends one media file to an assigned home target as
`multipart/form-data` — e.g. GateDrop's "Ablegen" on a NAS through the
Synology plugin (File Station upload). Same target, protocol (`http`) and
address checks as `fetchTarget`, the route's headers win, no redirects; the
host streams the file from the media store (decrypted on the way, never
through the plugin process, `Content-Length` known):

```js
const r = await gc.net.uploadTarget('nas', '/webapi/entry.cgi', {
  index: 0,                       // like fetchTarget
  method: 'POST',                 // or 'PUT'
  query: { api: 'SYNO.FileStation.Upload', version: 2, method: 'upload', _sid: sid },
  headers: { 'X-Requested-With': 'GateControl' },   // Content-Type is the host's (multipart boundary)
  form: {
    fields: { path: '/home/Drop', create_parents: true, overwrite: false },  // ≤ 50, ≤ 64 KB, before the file
    file: { field: 'file', mediaId, name: 'Bericht.pdf', mime: 'application/pdf' },  // name/mime default: the media's
  },
  // instead of form.file.mediaId: a file of another plugin that could hand it over to this one
  // (it lists one of this plugin's services in permissions.services) — no copy needed
  // mediaFrom: { plugin: 'gatecontrol-gatedrop', mediaId },
  timeoutMs: 20 * 60 * 1000,      // 1 s … 30 min, default 10 min (the host call waits as long)
});
// → like fetchTarget: { status, headers, body | bodyBase64 (binary: true), url, redirects } — answer ≤ 5 MB
```

The file part is `Content-Disposition: form-data; name="<field>";
filename="<name>"` (UTF-8, `"` / CR / LF percent-encoded like browsers do) and
`Content-Type: <mime>`. Errors like `fetchTarget` (`ERR_NET_DENIED`,
`ERR_NET`, `ERR_INVALID` for a path leaving the target or bad arguments),
`ERR_TIMEOUT`, `ERR_MEDIA_DENIED` (no `media`, or `mediaFrom` of a plugin that
may not hand over to this one), `ERR_INVALID` for an unknown media id.

`http.websocket(url, opts)` (since 1.184.0) opens a WebSocket to an
**internet** host: a `ws:`/`wss:` URL checked exactly like `http.fetch` (its
host and port in the allowlist, public addresses only, pinned to the checked
address; no redirects, no compression). The host holds the connection; the
plugin gets an EventEmitter with `message` (a string for text frames, a Buffer
for binary ones), `close` (code, reason) and `error`, plus `send(string |
Buffer)` and `close(code, reason)`. Options: `headers` (the handshake headers
`sec-websocket-*` stay the host's), `protocols` (≤ 8 sub-protocols),
`timeoutMs` (handshake, ≤ 30 s). Limits: 8 open WebSockets per plugin, 256 KB
per message sent, 1 MB per message received, 200 messages per second from the
server (more closes the connection with 1008); all of them close when the
plugin process ends. A plugin that also runs on older versions checks
`typeof gc.http.websocket === 'function'` first.

The install step *Berechtigungen* shows this in plain words, e.g.
"Internet: identity.vwgroup.io …", "Heimnetz: 1 Ziel, das du nach der
Installation zuweist: deCONZ-Gateway (HTTP)", "Lokale Suche: Geräte im lokalen
Netz suchen (UDP 6445, 20086) – nur wenn du es erlaubst".

## Plugin code (host API)

```js
module.exports = {
  async start(gc) {},                       // after the process started
  async stop(gc) {},                        // before it is stopped
  async request(req, gc) {                  // the plugin's API (admin, portal and apps)
    // req = { method, path, query, body, user: { id, name, role, portal?, loggedIn?, app?, device? }, lang }
    return { status: 200, json: { ok: true } };
  },
  async render(view, gc) {                  // pages and the portal tab
    // view = { view: 'page'|'portal', page, user, lang }
    return { html: '<h1>…</h1>' };
  },
  async tick(gc) {},                        // background run (permissions.background, every 5…86400 s)
  async settingsChanged(values, gc) {},     // after an administrator saved the settings (saving waits ≤ 20 s for it)
  async settingsStatus({ lang }, gc) {      // optional (since 1.185.0): status lines of the settings form
    return [{ group: 'account', tone: 'ok', text: 'Verbunden als ada@example.com' }];
  },
  async portalVisible({ user, lang, section }, gc) {  // optional: false hides the portal tab/section for this viewer
    return true;                            // (no hook, an error or no answer within 1.5 s → shown)
  },
  async portalTiles({ user, lang }, gc) { return []; },     // optional: Start tiles (see "Portal")
  async portalSearch({ user, lang, q }, gc) { return []; }, // optional: portal search results
  async quickActions({ user, lang }, gc) {   // optional: quick actions of the apps (see "Quick actions")
    return [{ id: 'light:3', title: 'Wohnzimmer', subtitle: 'Licht', icon: '<svg path d>', kind: 'toggle', state: 'on' }];
  },
  async runQuickAction({ user, lang, id, via, automation, target }, gc) {  // optional: runs one of them for that viewer
    return { ok: true, message: 'Licht eingeschaltet', state: 'on' };
  },
  async appVisible(user, gc) {              // optional: false hides the app tab (ui.app) for this viewer
    return true;                            // (no hook → shown; an error or no answer within 3 s → hidden)
  },
  async legacyImport(snapshot, gc) {        // optional, first-party only: built-in data handed over once
    return { ok: true };                    // (see "Built-in data import" below)
  },
  async mediaAccess({ user, mediaId, owner, mime }, gc) {  // optional (`media`): may this viewer read the file?
    return false;                           // true only; no hook → the uploader only (see "Media")
  },
  async service({ name, caller, user, payload }, gc) {     // optional (`services.provides`): called by another plugin
    return { ok: true };                    // JSON ≤ 16 KB (see "Services")
  },
  async deliverNotice(notice, gc) {         // optional (`permissions.notifySink`): notifications routed into chats
    return { covered: [12, 15] };           // who got it in a chat (see "Notifications in chats")
  },
  async mayRouteToFamily({ user }, gc) {     // optional (`permissions.notifySink`): may this person send topics
    return false;                           // to the family chat? true only; no hook → no
  },
  async ensureNoticeChat({ user, source, sourceLabel, lang }, gc) { // optional (`notifySink`, since 1.192.0):
    return { conversationId: '42', created: true };  // a person chose "own chat": that source's chat now
  },
  async notifyAction({ userId, notificationId, action, data }, gc) {  // optional: a `callback` button of one of
  },                                        // this plugin's pushes was pressed — once per push and button (see "Callback buttons")
  async publicLinkEvent({ token, event, file, zip, downloads }, gc) {  // optional (`publicLinks`, since 1.193.0):
  },                                        // 'download' | 'locked' | 'expired' of one of its links (see "Public links")
  async groupsChanged({ changes }, gc) {},  // optional (`groups`): batched group changes (see "Groups")
  async groupUsage({ groupId, successorUserId }, gc) {  // optional (`groups`): what the plugin keeps for a group
    return [{ kind: 'Drive', label: 'Team-Ordner Buchhaltung', onDelete: 'wird in Meine Dateien von Thomas Berg verschoben' }];
  },
  async groupDeleting({ groupId, successorUserId }, gc) {},  // optional (`groups`): clean up before a group goes (≤ 30 s)
};
```

`gc` (every call goes over IPC to the host, which checks the permission):

| | |
|---|---|
| `gc.plugin` | `{ id, version, filesDir }` — `filesDir` is the only folder the plugin may write |
| `gc.log.debug/info/warn/error(...)` | the plugin's log (*Protokoll* tab); `console.*` goes there too |
| `gc.http.fetch(url, opts)` | internet hosts |
| `gc.http.websocket(url, opts)` | WebSocket to an internet host (events `message`, `close`, `error`; `send`, `close`; since 1.184.0) |
| `gc.net.targets()` | the assigned home targets |
| `gc.net.fetchTarget(id, path, opts)` | HTTP to an assigned target |
| `gc.net.tcpTarget(id, { index, port })` | TCP socket (events `data`, `close`, `error`, `timeout`; `write`, `end`, `destroy`, `setTimeout`) |
| `gc.net.udpTarget(id, data, opts)` / `gc.net.discover(data, { ports })` | UDP |
| `gc.storage.get/set/delete/list` | key/value (`storage`) |
| `gc.db.query/get/run/exec(sql, params)` | the plugin's own SQLite database (`storage`) |
| `gc.settings.get/all/set` | the plugin's settings (secrets decrypted); `set` also keeps undeclared keys of the plugin's own (JSON) |
| `gc.settings.setSecret(key, value)` | a secret of the plugin's own (e.g. a device API key per gateway): any key `[a-z][a-z0-9_.-]{0,63}` that is not a declared non-secret setting, stored encrypted with the server key like a `secret` setting, read back with `get`/`all`, never sent to the browser, re-keyed by backups; `null` deletes it |
| `gc.users.list()/get(id)` | `{ id, name, role, avatarUrl, color, colorHex, initials }` of enabled users (`users`) — `avatarUrl` is the profile picture's path `/avatars/<id>.<ext>` or `null`, `color` the favourite colour's palette key (never `null`), `colorHex` its `#RRGGBB`, `initials` one or two letters for the fallback (docs/feature-avatars.md; since 1.168.0) |
| `gc.kiosk.allow(userId, allowed)` | mark (`true`) or unmark (`false`) a user as a kiosk user (`kiosk`); an administrator, a disabled or an unknown account → `ERR_INVALID` (allowing only; unmarking always works) |
| `gc.kiosk.list()` | ids of the users this plugin marks (`kiosk`) |
| `gc.actions.list({ userId, lang, interactive, withWidget })` | the quick actions the *other* plugins offer to that user → `[{ actionId, plugin, pluginName, id, label, title, subtitle, icon, kind, state, needsConfirm, confirmWhen, verbs, targets, device, widget? }]` (`actions`; `actionId`, `label`, `needsConfirm`, `confirmWhen` since 1.180.0; `withWidget: true` adds `widget` — the device values — since 1.181.0) — see "Running other plugins' quick actions" |
| `gc.actions.get({ userId, actionId, lang, interactive, withWidget })` | one of them (`'<plugin>/<id>'`, or `plugin` + `id`) exactly as `list` answers it, or `null` when that plugin does not offer it to the user — asks only that plugin's hook (`actions`, since 1.181.0) — see "Device values" |
| `gc.actions.run({ userId, actionId, params, via, interactive, lang })` | run one of them as that user (`interactive: true`: a person tapped it in this plugin, needs `actions: { interactive: true }`) — `actionId` `'<plugin>/<id>'` from the list (or `plugin` + `id`), `params.state` (`'on'`/`'off'`, optional; or `state`) the state a toggle should end in → `{ ok, result, code, message, state, unchanged }` (`code` when not `ok`; `actions`, ≤ 60 runs per minute; `actionId`, `params`, `via`, `result`, `code` since 1.180.0, before ≤ 60 per hour) |
| `gc.notify(message, { severity })` | activity log + webhooks, and a push on `plugin:<id>:default` (`notify`, ≤ 30/h or `perHour`) — see "Notifications" |
| `gc.notify({ topic, title, body, priority, users, collapseKey, ttl, data, image })` | push on a declared `notifyTopics` topic (+ activity row) → `{ pushed, id }`; `image` `{ data, mime }` or `{ mediaId }` — see "Pictures" |
| `gc.notify({ topic: <chat topic>, title, body, users, conversation, sender, … })` | a chat notification (`notifyTopics[].chat`) → `{ pushed, id, skipped }` — see "Chat notifications" |
| `gc.notify.routes.get({ userId, lang })` / `gc.notify.routes.set({ userId, topic, dest })` | where a person's notifications appear, like `GET`/`PUT /api/v1/me/notify/routes` (`notifySink`, since 1.191.0) — see "Notifications in chats" |
| `gc.media.info(id)` | `{ mediaId, mime, bytes, sha256, owner, createdAt, claimed, name }` of one of the plugin's files, or `null` (`media`) — see "Media" |
| `gc.media.claim(id)` | keep a new upload (unclaimed files are removed after 24 h); idempotent → the info; unknown id → `ERR_INVALID` |
| `gc.media.delete(id)` | delete the file → `true` (`false` when unknown) |
| `gc.media.usage()` | `{ bytes, count, quota, maxBytes, types, uploads }` |
| `gc.media.url(id, { user, ttlS })` | `/plugin-media/<token>` — a signed URL a frame can show (`<img>`, `<audio>`) for `ttlS` seconds (60 … 86400, default 3600) |
| `gc.media.fetch(url, { headers, timeoutMs, mime, name, maxBytes })` | since 1.190.0: download a file from the internet straight into the plugin's media (checked like `gc.http.fetch`) → `{ mediaId, mime, bytes, name }`, unclaimed, no owner — see "Media" |
| `gc.media.handOver(id, { toPlugin, user })` | since 1.193.0: the file becomes a new, unclaimed file of another plugin → `{ mediaId, mime, bytes, name }` there (the caller lists one of that plugin's services) — see "Hand-over" |
| `gc.net.uploadTarget(id, path, { form: { fields, file }, mediaFrom, query, headers, timeoutMs })` | since 1.193.0: a media file as `multipart/form-data` to an assigned home target, streamed → like `fetchTarget` — see "Network" |
| `gc.publicLinks.create/list/get/revoke` | since 1.193.0: download links without login for some of the plugin's media (`publicLinks`, only while an administrator allows them) — see "Public links" |
| `gc.devices.list({ userId })` | since 1.193.0: the person's GateControl apps `[{ id, name, platform, clientType, appVersion, online, lastSeen, via }]` (`devices`) — see "Devices" |
| `gc.notify({ …, users, devices, silent, data })` | since 1.193.0: only to these devices of `users`; `silent: true` a data notification without display (`devices`) — see "Devices" |
| `gc.groups.list/get/members/isMember/leadersOf(…)` | the person groups of GateControl (`groups`) — see "Groups" |
| `gc.groups.ensure({ key, name, kind, parentKey, members })` / `gc.groups.remove(key)` | the plugin's own groups (`groups: "manage"`) — see "Groups" |
| `gc.notify({ …, groups: [id] })` | to the groups' enabled members, subgroups included, resolved at send time (`groups`) — see "Groups" |
| `gc.events.emit({ users, type, data })` | realtime event to the listed people's apps and frames → `{ delivered }` (`events`, ≤ 600/min) — see "Realtime events" |
| `gc.services.call({ plugin, service, userId, payload })` | another plugin's service → its answer (`permissions.services`, ≤ 60/h) — see "Services" |
| `gc.services.available(plugin, service)` | `true`/`false`: would `call()` reach that provider now (listed, installed, running, provided) — the provider is not run, not counted (since 1.178.0) |
| `gc.license.status()` | `{ required, licensed, state, expiresAt }` |
| `gc.license.info()` | `{ required, valid, state, expiresAt, source, tier, seats }` — tier and people of the licence (since 1.206.0) — see "Licences" |
| `gc.license.refresh()` | fetch the licence now, e.g. after "Personen hinzubuchen" → `{ refreshed, …info() }` (at most once a minute; since 1.206.0) — see "Licences" |

Requests reach the plugin only after GateControl's own authentication, CSRF
check and rate limit, as plain objects; actions run with the requesting
user's rights (`req.user`) — a plugin never gets admin rights implicitly.
Admin API: `/api/v1/plugins/<id>/api/<path>` (administrators); portal:
`/api/v1/portal/plugins/<id>/api/<path>` (the identified portal viewer; changes
need a portal or web login); apps: `/api/v1/client/plugins/<id>/api/<path>`
(the owner of the device token, `user.app = true`; `permissions.app`, see "App"). A portal viewer comes as `user.portal = true` with
`user.loggedIn`: `true` after a portal or web login, `false` when the viewer is
only recognised by device trust (read-only) — data as sensitive as a vehicle's
position or departure times belongs to a real login only. The portal hooks
(`portalVisible`, `portalTiles`, `portalSearch`) and `render` get the same
viewer; the quick-action hooks (`quickActions`, `runQuickAction`) get the
owner of the app's device token as that viewer, with `loggedIn: true` and
`app: true` (see "Quick actions"), or — when another plugin runs them with
`gc.actions.*` — that user with `loggedIn: true`, `automation: true` and
`via: '<calling plugin id>'`, or for an interactive run (since 1.180.0)
`automation: false`, `interactive: true` and that `via` (see "Running other
plugins' quick actions").

### Kiosk devices (`permissions.kiosk`)

A kiosk device is a browser (typically a wall tablet) paired by an
administrator on the user's profile; it stays signed in to the portal as
that user for 90 days, extended by every use. GateControl offers kiosk
devices only for users a plugin marks with `gc.kiosk.allow(userId, true)`:

* a user is *kiosk-eligible* while at least one installed, enabled, usable
  plugin with `permissions.kiosk` marks them — never an administrator, never
  a disabled account (`allow(…, true)` on such a user throws `ERR_INVALID`);
* when that ends (the plugin unmarks the user, is disabled, uninstalled or
  loses the permission in an update; the account is disabled, deleted or
  becomes an administrator) every kiosk device of the user stops working at
  its next request (checked per request; the plugin part is cached for at
  most 60 s, `gc.kiosk.allow` takes effect at once). A device of a user who
  becomes eligible again works again — revoke it to end it for good;
* the marks are per plugin and survive restarts; reconcile them in `start`
  (`gc.kiosk.list()` vs. who should be marked). "Alles löschen" on uninstall
  drops them.

A kiosk device's requests reach the plugin like those of a signed-in portal
viewer — `req.user = { id, name, role, portal: true, loggedIn: true, kiosk:
true }` (the `kiosk` key is absent for every other viewer), the same in
`render`, `portalVisible`, `portalTiles` and `portalSearch`. Writes carry the
CSRF token like any signed-in viewer. A kiosk device reaches only the portal
page, the read-only portal widgets, the plugin frames and the plugin API
(`/api/v1/portal/plugins/…`) — never "Meine Geräte", notification settings,
account pages or the admin UI.

## Notifications

`gc.notify` reaches the GateControl apps through the notification center
(docs/feature-notification-center.md) — pushed by GateControl itself, no
third-party service. Both forms need `permissions.notify` and share the limit
of **30 per hour and plugin** — or `n` with `"notify": { "perHour": n }`
(1 ≤ n ≤ 120; the install dialog shows "bis zu n Push-Mitteilungen pro
Stunde"); every call also writes the `plugin_notice` activity entry (and its
webhooks) as before. Chat topics (`notifyTopics[].chat`) have their own budget
and rules — see "Chat notifications" below.

```js
// old form — unchanged; push on topic plugin:<id>:default, title = plugin name,
// priority info (severity warning/error → normal)
await gc.notify('Laden abgeschlossen', { severity: 'info' });

// new form
const { pushed, id } = await gc.notify({
  topic: 'charging',              // declared in plugin.json notifyTopics ('default' always exists)
  title: 'Laden abgeschlossen',   // ≤ 120 characters, required
  body: 'Enyaq · 80 % · ca. 390 km', // ≤ 1000
  priority: 'normal',             // info | normal | high | critical (capped to high unless the topic allowCritical)
  users: [12],                    // optional: only these people (otherwise the topic's subscribers)
  collapseKey: 'charge:VIN123',   // optional: same key replaces the shown notification
  ttl: 6 * 3600,                  // optional, seconds (60 … retention of the server)
  data: { vin: 'VIN123' },        // optional JSON ≤ 4 KB; data.route defaults to 'plg-<id>' (the plugin tab)
  image: { data: '<base64>', mime: 'image/jpeg' }  // optional picture (see below), or { mediaId } of the plugin's media
});
```

* Errors: `ERR_NOTIFY_DENIED` (no permission), `ERR_INVALID` (undeclared topic,
  empty title, bad priority/users/ttl/collapseKey, `data` not an object or over
  4 KB, a bad `image`, a bad `quick_action` or `callback`), `ERR_RATE_LIMIT`.
* Push needs the licence feature `email_alerts` ("Benachrichtigungen Pro");
  without it only the activity entry is written and `pushed` is `false`.
* Who gets it: the rule of the topic (System › Benachrichtigungen; default:
  subscribers). A person's topic switch (portal) and quiet hours apply; the
  administrator can switch a plugin topic off.
* **Critical**: `priority: 'critical'` is capped to `high` — except on a topic
  declared with `"allowCritical": true` in `notifyTopics[]`: there it is kept
  and, like the core's critical events, rings through quiet hours (unless the
  person switched "Kritisches trotzdem melden" off) and through a person's
  topic switch and device mutes (docs/feature-notification-center.md). The
  `default` topic never allows critical. The install dialog says so
  ("Notfall: darf Notfall-Mitteilungen senden, die die Ruhezeit überspringen
  (<topics>)").
* `data.actions` may only use the fixed action types (`open_app_route`,
  `open_portal`, `mute_1h`, `ack`, `done`, `quick_action` for the
  plugin's own quick actions and `callback` for a button that reaches the
  plugin's `notifyAction` hook — see below); control characters are removed,
  the apps show text only.
  A plugin **without `ui.app`** has no screen of its own in the apps: an
  `open_app_route` action to the plugin's own route (`plg-<id>`) is sent as
  `open_portal` to `/portal#plg-<id>` — the plugin's portal tab, or the
  GateControl tab ("Zuhause", "Fahrzeug") holding its first section,
  scrolled to it. A plugin **with `ui.app`** keeps `open_app_route` →
  `plg-<id>` (its app tab); `data.route` is `plg-<id>` either way.
* Other keys in `data` are context for the plugin's own app screen and pass
  unchanged (cleaned of control characters), e.g. `data: { familie: { type:
  'locate_request', requestId: 7 } }` — all of `data` within 4 KB.
* `data.facts` (optional): up to 6 `{ label, value }` pairs the apps show
  under the text, e.g. `[{ label: 'Akku', value: '80 %' }]` — one line each,
  label ≤ 60 and value ≤ 120 characters; anything else is dropped. Schedules ("evening before 18:00") are the
  plugin's own job (`background` + `gc.storage`).
* `card` (optional, since 1.191.0): how the notification looks in a chat
  when a person routes the topic there (see "Notifications in chats") —
  `{ text, link?: { label, route }, actions? }`. `text` (required, newlines
  kept) is cut to 4000 characters, `link.label` to 40; `link.route` is an
  app route like `data.route` (`plg-<id>`, `inbox`, …); `actions` are checked
  and cleaned exactly like `data.actions` (at most 4, unknown types dropped,
  a bad `quick_action` / `callback` → `ERR_INVALID`). Not an object, an empty
  text, a link without label or with another route → `ERR_INVALID`. The card
  is kept with the notification for the sink only — the apps' push payload
  and inbox never carry it. Ignored on chat topics.

  ```js
  await gc.notify({ topic: 'messages', title: 'Elternbrief', body: 'Liebe Eltern, …', users: [12],
    card: { text: fullText, link: { label: 'Ganze Nachricht lesen', route: 'plg-gatecontrol-schule' } } });
  ```

### Pictures (`image`)

```js
await gc.notify({
  topic: 'doorbell', title: 'Es klingelt an der Haustür', priority: 'high', collapseKey: 'cam:front',
  image: { data: snapshotBase64, mime: 'image/jpeg' },   // 'image/jpeg' | 'image/png' | 'image/webp'
});
```

* `data`: the picture as base64 (a `data:<mime>;base64,` URL of the same
  type is accepted too), at most **300 KB decoded**; `mime` must match the
  picture. Only the header is read (the parsers of the profile pictures,
  `services/avatars.js`): PNG, JPEG or WebP, any aspect ratio, each side
  **32…2560 px**, no animation (APNG, animated WebP). It is stored as sent —
  no scaling, so the plugin sends a picture of a sensible size. Anything else
  → `ERR_INVALID` ("invalid image: <reason>"), nothing is pushed or stored and
  the budget is not used.
* The picture is stored only when the push goes out (licence, rule) — table
  `notify_media`, with a random id (24 url-safe characters). It lives as long
  as the push's `ttl`, **24 h** without one, **7 days** at most; the hourly
  clean-up of the notification center deletes expired pictures.
* The apps get it as **`imageUrl`** — a relative path
  `/notify-media/<id>.<ext>` on their own server — in the push payload and in
  the inbox (`GET /api/v1/client/push/inbox`, the portal's
  `GET /api/v1/me/notify/inbox`); `null` without a picture or once it
  expired. The URL is a capability URL like `/avatars/`: no login, served on
  every host GateControl answers, rate limited (300 per minute and address),
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
  'none'`, `Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control:
  private, max-age=<seconds left>, immutable`; 404 once expired or unknown.
* Bundling (same collapse key within the rule's bundle time): the picture
  follows the newest event — a newer push without a picture removes it.
* The activity log and the fallback e-mail never contain the picture (nor
  its URL). The Windows apps may ignore it.

**From the plugin's media** (since 1.178.0): a plugin declaring `media` (see
"Media") can name one of its own stored files instead of sending the bytes —
on any topic, chat topics included:

```js
await gc.notify({ topic: 'message', /* … */ image: { mediaId: thumbId } });  // 32 hex characters, nothing else in `image`
```

* The host reads the file and treats it exactly like a sent picture: same
  checks (stored type `image/png|jpeg|webp`, ≤ 300 KB, 32…2560 px a side, no
  animation, the stored type must match the bytes), copied into
  `notify_media`, the apps get the same `imageUrl` (`/notify-media/<id>.<ext>`,
  no login, lives as long as the push). Later deleting the media file does not
  remove the picture of a push already sent, nor does the push keep the media
  file alive. `mediaAccess` is not asked: the plugin chooses the recipients.
* Meant for the small preview the apps upload next to a photo ("Media": ≤ 64
  KB) — a full photo is usually over 300 KB. Check `gc.media.info(id)` (`mime`,
  `bytes`) first if unsure.
* Errors: `ERR_MEDIA_DENIED` (no `media` in plugin.json), `ERR_INVALID`
  ("invalid image: invalid media id" | "unknown media id" — another plugin's
  file is unknown too — | "mediaId cannot be combined with data or mime" |
  "mime" | "too_large" | "media file unreadable" | the reasons of a sent
  picture); nothing is pushed and no budget is used.

### Quick actions as notification buttons (`quick_action`)

A push may offer one of the plugin's **own** quick actions (see "Quick
actions") as a button — e.g. "Tür öffnen" on a doorbell push:

```js
data: { actions: [
  { type: 'quick_action', label: 'Tür öffnen', plugin: 'gatecontrol-door', id: 'front:open', confirm: true, auth: 'device' },
  { type: 'open_app_route', id: 'view', label: 'Ansehen', target: 'plg-gatecontrol-door' },
] }
```

* Fields: `label` (1…24 characters after removing control characters),
  `plugin` (must be the calling plugin's own id), `id` (a quick action id,
  `[A-Za-z0-9:._-]{1,64}` — only the format is checked here), `confirm`
  (boolean, optional: the app asks before running it), `auth` (optional,
  only `'device'`: the app requires the device unlock / biometrics before
  running it). Anything else → `ERR_INVALID` and nothing is pushed.
* The apps get `{ id, label, type: 'quick_action', plugin, confirm, auth? }`
  (`confirm` always a boolean, `auth` only when `'device'`). Like every
  action, at most 4 per push.
* The app runs it with the normal client call `POST
  /api/v1/client/actions/<plugin>/<id>` with the body `{ "source":
  "notification" }` — so the run goes through the normal quick action path
  and its checks (the plugin must currently list that id for that person,
  10 s, rate limit, activity log). The plugin's `runQuickAction` gets
  `via: 'notification'`, `automation: false` and must check everything
  again — a push is no permission.
* The core and administrator messages never carry `quick_action`; the
  portal does not show it.

### Callback buttons (`callback`)

Since 1.181.0. A push may carry buttons whose press comes back to the
plugin itself — e.g. "In 1 h erinnern" and "Erledigt" on a reminder:

```js
const { id } = await gc.notify({
  topic: 'reminder', title: 'Fenster schließen', users: [7],
  data: {
    reminder: { ruleId: 12, key: 'sched:2026-10-18' },   // the plugin's own context
    actions: [
      { type: 'callback', id: 'snooze_1h', label: 'In 1 h' },
      { type: 'callback', id: 'done', label: 'Erledigt' },
    ],
  },
});

module.exports = {
  // …
  async notifyAction({ userId, notificationId, action, data }, gc) {
    // action 'snooze_1h' | 'done', data = { reminder: { ruleId: 12, key: 'sched:2026-10-18' } }
  },
};
```

* Fields: `id` (`[a-z0-9_-]{1,32}`, unique among the push's callbacks),
  `label` (1…24 characters after removing control characters). Anything
  else → `ERR_INVALID` and nothing is pushed. Like every action, at most 4
  per push (`quick_action`, `callback` and the fixed types together). Allowed
  on chat topics too.
* The apps get `{ id, label, type: 'callback' }`. A press is answered like a
  `done` button: `POST /api/v1/client/push/ack` with `{ seqs, state: 'read',
  action: '<id>' }` (docs/feature-notification-center.md).
* The host then calls the sending plugin's **`notifyAction`** hook with
  `{ userId, notificationId, action, data }` — **once per push and button**:
  a second press, the person's other device or another recipient of the
  same push change nothing (table `notify_action_calls`). Another button of
  the same push is its own call.
  * `userId`: the person who pressed it (the acked delivery's person);
  * `notificationId`: the `id` `gc.notify` answered;
  * `action`: the callback id;
  * `data`: the push's `data` without the fields the host interprets
    (`route`, `actions`, `facts`, `conversation`, `sender`) — the plugin's
    own context, cleaned as when it was sent.
* Only an ack with `state: 'read'` of the acking device's own delivery
  counts, only for an id that is a `callback` of that very push (a fixed
  `done` button of a push without a callback `done` stays a plain ack).
  The plugin must still be allowed to run and running — otherwise nothing is
  recorded and a later press can still reach it. The hook runs in the
  background (10 s); its answer is ignored, an error or timeout is logged in
  the server log and never reaches the app. A push is no permission: check
  what the person may do in the hook again.
* The core and administrator messages never carry `callback`; the portal
  does not show it.

### Chat notifications (`notifyTopics[].chat`)

Since 1.177.0. A topic declared with `"chat": true` carries messages between
people (the messenger plugin): the apps show them as a conversation (Android
`MessagingStyle`, a Windows toast with a reply field) — the exact rendering
is part of the device contract (docs/feature-notification-center.md
"Chat-Benachrichtigungen").

```js
const { pushed, id, skipped } = await gc.notify({
  topic: 'message',                         // a notifyTopics entry with chat: true
  title: 'Anna',                            // sender (or "Neue Nachricht von Anna" without preview) ≤ 120
  body: 'Bist du schon unterwegs?',         // the message text ≤ 1000 (or '' without preview)
  users: [12, 15],                          // required: the recipients, 1 … 100 user ids
  conversation: { id: '12', title: 'Familie', isGroup: true },  // id [A-Za-z0-9_.:-]{1,64} (a number is taken as text), title ≤ 80
  sender: { id: 7, name: 'Anna', avatarUrl: '/avatars/Xk3….webp' }, // id number or [A-Za-z0-9_.:@-]{1,64}, name ≤ 80,
                                            // avatarUrl a /avatars/ or /plugin-media/ path of this server, or null
  priority: 'normal',                       // info | normal | high (critical is capped to high)
  data: { messageId: 4711, actions: [
    { type: 'reply', label: 'Antworten', path: 'conversations/12/messages' },
    { type: 'mark_read', label: 'Gelesen', path: 'conversations/12/read', body: { upTo: 4711 } },
  ] },
  // optional as usual: collapseKey (default 'chat:<conversation.id>' — one notification per chat), ttl,
  // image ({ data, mime } or { mediaId } of a picture preview, see "Pictures")
});
```

* `conversation` and `sender` become `data.conversation` / `data.sender`
  (they count towards the 4 KB of `data`); the payload of a chat notification
  carries `kind: "message"` (absent on every other notification).
* Action types of chat topics only: `reply` and `mark_read` `{ label (1 … 24),
  path, body? }` — `path` is a path of the plugin's own **client API**
  (relative, no `..`, the leading `/` is dropped; needs `permissions.app`,
  else `ERR_INVALID`), `body` an optional JSON object ≤ 1 KB. `reply`: the
  app posts `{ ...body, clientId, kind: 'text', text, source: 'notification' }`
  to `/api/v1/client/plugins/<id>/api/<path>`; `mark_read`: the app posts
  `body` (or `{}`) there and acks the notification as read. The other action
  types (`open_app_route`, `quick_action`, …) work as usual; on a normal topic
  `reply`/`mark_read` are dropped like any unknown type.
* **Budget** of its own, apart from `permissions.notify`: 1200 chat
  notifications per hour and plugin (`ERR_RATE_LIMIT` beyond), 120 per hour
  and recipient — a recipient over it is left out and listed in `skipped`
  (all of them left out → `ERR_RATE_LIMIT`).
* **Never** an activity row with title or text: GateControl writes one
  neutral `plugin_notice` line per hour and plugin ("<Plugin>: 57 chat
  notifications sent"). **Never** e-mail (the rule's e-mail switch does not
  apply), **never** bundled or held back (the rule's bundle/delay do not
  apply). A person's topic switch, device mutes and quiet hours apply as for
  every plugin topic (quiet hours: delivered silently). The administrator can
  switch the topic off (System › Benachrichtigungen).
* Private: the administrator's delivery log shows "Chat-Nachricht (Inhalt
  privat)" without text, data, sender or conversation; chat notifications
  are not part of the GateControl inbox (`/api/v1/client/push/inbox`, the
  portal's inbox, unread counts, "alle gelesen") and are purged after the
  push retention (72 h), not kept as history.
* Read on one device: the app acks it as `read` → the person's other devices
  get `event: read` and remove it (the existing read-sync). A plugin that
  learns a conversation was read elsewhere (its own API) tells the devices
  with a realtime event (see "Realtime events").
* The per-person "Inhalt in Benachrichtigung" switch (preview) is the
  plugin's own preference: without preview it sends a neutral title and an
  empty body — and no `image`.
* **Picture preview**: a message with a photo may carry `image: { mediaId:
  <the photo's preview file> }` (see "Pictures"); the apps get it as
  `imageUrl` in the payload (Android: `MessagingStyle.Message.setData`) and
  fetch it without login. Older apps ignore it.
* Push needs the licence feature `email_alerts` like every plugin push.

## Notifications in chats (`permissions.notifySink`)

Since 1.191.0. Per topic (core topics and every plugin topic) each person
chooses where a notification appears: **GateControl** (the inbox, default),
the household's **family chat** or an **own chat** of the source. Chats
belong to the **sink**: the first enabled plugin declaring
`"permissions": { "notifySink": true }` that may run (in practice the
messenger). Without an active sink nothing changes — every notification
goes to the inbox as before and the routes are dormant.

* **Stored**: per person and topic `inbox` | `own` (none = `inbox`); per
  topic a household family route (set by an administrator, or a person the
  sink's `mayRouteToFamily` allows — the family parents; it applies to
  everyone). Locked — always the inbox, cannot be changed: `security` and
  `admin_notice`. Chat topics (`notifyTopics[].chat`) are no route targets
  and are not listed.
* **Delivery**: after the recipients are resolved as before (rule,
  subscriptions, device mutes, quiet hours), a topic with a family route
  sends **all** its recipients to the sink as `family`; otherwise people who
  chose `own` go as `own`; everyone else gets the inbox delivery unchanged.
  Then the host calls the sink's hook (asynchronously, after the
  notification is stored):

  ```js
  async deliverNotice(notice, gc) {
    // notice = { id, topic, source: 'core' | 'plugin:<id>', sourceLabel: 'GateControl' | 'Schule',
    //   topicLabel: 'Nachrichten der Schule', title, body, priority, createdAt, data, imageUrl?,
    //   card?: { text, link?: { label, route }, actions? }, family: [userIds], own: [userIds], lang }
    return { covered: [12, 15] };   // who got it in a chat
  }
  ```

  Title, body and data are the sanitised values the inbox shows too;
  `imageUrl` is the push picture's path (while it lives), `card` the
  sender's card (see "Notifications"), labels and `lang` in the server
  language (the language notifications are stored in). People in `covered`
  get **no** inbox delivery and **no** push from GateControl (the chat pushes
  itself). Everyone else of `family`/`own` — the hook threw, did not answer
  within **10 s**, or did not list them — gets the normal inbox delivery
  afterwards: never lost, never twice. A bundled notification (rule
  `bundle_s`) goes to the sink again with its new title. The rule's e-mail
  and webhook channels are not affected. A sink that is not running at that
  moment → inbox right away.
* **Family permission**: `mayRouteToFamily({ user: { id, name, role } })` →
  `true` allows that person to set (or lift) family routes. Administrators
  always may; the hook is asked for everyone else (3 s; no hook, an error or
  no answer → no).
* **Own chat at once** (since 1.192.0): when a person chooses `own` for a
  topic, the host asks the sink right away for that source's chat:
  `ensureNoticeChat({ user: { id, name, role }, source, sourceLabel, lang })`
  → `{ conversationId, created }` — an existing chat of that source is used
  (`created: false`), else one is created. No hook, an error or no answer
  within 5 s → `null` (the chat then appears with the first notification).
  The PUT answer (and `gc.notify.routes.set`) carries it as
  `chat: { source, label, conversationId, created } | null`.
* **API** (same shapes): `GET/PUT /api/v1/me/notify/routes` (web and portal
  session, also `/api/v1/portal/me/notify/routes`) and
  `GET/PUT /api/v1/client/push/routes` (app token with an owner, else 403
  `no_user`).

  ```
  GET → { ok, sink: true|false, canFamily: true|false,
          groups: [ { source: 'core'|'plugin:<id>', label: 'GateControl'|'Schule', topics: [
            { id: 'plugin:gatecontrol-schule:messages', label: 'Nachrichten der Schule',
              dest: 'inbox'|'own'|'family', locked: false, familySetBy: 'Marc'|null } ] } ] }
  PUT { topic, dest: 'inbox'|'own'|'family' } → the GET answer + chat (1.192.0: the own chat, else null)
  ```

  `dest: 'family'` = the household route is set (the same for everyone);
  without a sink every `dest` reads `inbox`. PUT `family` needs `canFamily`
  (else 403 `family_not_allowed`); PUT `inbox`/`own` on a topic with a
  household route lifts it and sets the own choice — only with `canFamily`
  (else 403 `family_not_allowed`). Locked topic → 409 `locked`; no sink and
  `own`/`family` → 409 `no_sink`; a topic the person cannot get (or a chat
  topic) → 404 `unknown_topic`; bad `dest`/`topic` → 400 `invalid_dest` /
  `invalid_topic`. Topic labels follow the person's language.
* **Host API of the sink** (since 1.191.0; only with `permissions.notifySink`,
  else `ERR_NOTIFY_SINK_DENIED`) — for the page "Wo Mitteilungen erscheinen"
  in the sink's own frame:

  ```js
  const view = await gc.notify.routes.get({ userId: user.id, lang: 'de' });   // = the GET answer for that person
  const next = await gc.notify.routes.set({ userId: user.id, topic, dest });  // = the PUT (same rules) → the GET answer
  ```

  `lang` `de`/`en` (else the person's language) only changes the labels.
  `set` checks exactly like the PUT for that person (family routes only
  when that person may set them — admin or the sink's own
  `mayRouteToFamily`). Refusals are thrown with `e.message` = the API's error
  code: `ERR_INVALID` (`invalid_user` — not an enabled account —,
  `invalid_topic`, `invalid_dest`), `ERR_NOT_FOUND` (`unknown_topic`),
  `ERR_CONFLICT` (`locked`, `no_sink`), `ERR_FORBIDDEN`
  (`family_not_allowed`). The plugin must only pass the id of the person
  actually using its page.
* Rows of a removed plugin stay harmless: its topics are no longer listed or
  sent.

## Media (plugin.json `media`)

Since 1.177.0. Plugins that work with files of their users (pictures, voice
messages, documents — the messenger) let GateControl store them: the plugin
never handles the bytes, it gets a **media id** (32 hex characters) and keeps
it in its own data. Code: `src/services/plugins/media.js`.

* **Upload** (the body is the file itself — no JSON, no multipart; streamed
  to disk, never held in memory): `Content-Type` one of `media.types`,
  `Content-Length` required (no chunked upload) and ≤ `media.maxBytes`, the
  plugin's quota not exceeded:
  * apps: `PUT /api/v1/client/plugins/<id>/media` with the device token (like
    the client API, `permissions.app`; the token's owner is the uploader);
  * frames: `GC.upload(fileOrBlob, { onProgress })` → the parent page PUTs it
    to `/api/v1/portal/plugins/<id>/media` (a portal or web login, CSRF) or
    `/api/v1/plugins/<id>/media` (the admin page) with the session →
    `{ mediaId, mime, bytes }`; `onProgress({ loaded, total })` while it
    uploads; a failed upload rejects with `status` and the error code.
  * Answers: `200 { ok: true, mediaId, mime, bytes }`; `404 not_found`
    (unknown, not usable, no `media`), `403 uploads_disabled` (`media.uploads:
    false`, since 1.190.0), `411 length_required`, `413 too_large`, `415
    unsupported_type`, `507 quota_exceeded`, `400 aborted | length_mismatch`.
  * Time (since 1.193.0): an upload body may take up to 2 hours in all and
    is ended when no byte arrives for 5 minutes; every other request body
    keeps Node's 5 minutes (`src/middleware/requestDeadline.js`). The upload
    route has no body-size limit of its own besides `media.maxBytes` (it is
    never parsed). Apps upload files over 50 MB resumably.
* **Resumable uploads** (since 1.193.0, `media.resumable: true`): a large
  upload goes in parts and continues after an abort (lost connection, app
  killed). The client picks an `uploadId` (8 … 64 of `[A-Za-z0-9_-]`, e.g. a
  UUID) — it is scoped to the plugin and the uploader, nobody else sees or
  continues it:

  ```
  PUT …/plugins/<id>/media?uploadId=<id>&offset=<n>     (apps, portal, admin frames — like a plain upload)
    Content-Type: <one of media.types>  Content-Length: <end - n + 1>
    Content-Range: bytes <n>-<end>/<total>
    → 200 { ok: true, complete: false, uploadId, offset, total }      a part stored; go on at `offset`
    → 200 { ok: true, complete: true, mediaId, mime, bytes }          the last part: the file exists
    409 { ok: false, code: 'offset_mismatch' | 'upload_mismatch' | 'busy', offset }
    400 not_resumable | invalid_upload_id | range_required | invalid_range, and the plain upload's codes
  HEAD …/plugins/<id>/media/uploads/<uploadId>   → 200, headers Upload-Offset / Upload-Length
  GET  …/plugins/<id>/media/uploads/<uploadId>   → 200 { ok: true, uploadId, offset, total, mime }; 404 unknown / expired
  ```

  (`…` = `/api/v1/client` with the device token, `/api/v1/portal` with a
  portal login.) The first part (`offset=0`) opens the upload: type, `total ≤
  maxBytes` and the quota are checked for the whole file. Every further part
  must start exactly at the stored `offset` (else 409 with the right
  `offset`); `offset` grows in whole 64 KiB chunks — what an aborted part sent
  after its last whole chunk is dropped and sent again. Parts should be
  multiples of 64 KiB (e.g. 8 MiB); a part that is not simply leaves the rest
  of its last chunk for the next part (the answer's `offset` says so). One
  part at a time per upload (409 `busy`). Type and `total` must stay the same
  (409 `upload_mismatch`). Every whole chunk is encrypted on arrival like any
  file; the finished file is checked against the quota again, gets its
  SHA-256 and is **unclaimed** like every upload. An upload not finished
  within 24 h is removed. `offset` in the query is optional (it must equal the
  range start when given).
* **Fetch** (since 1.190.0): `gc.media.fetch(url, opts)` downloads one file
  from the internet straight into the plugin's media — e.g. an attachment of a
  web service the plugin is logged in to; the file never passes through the
  plugin process:

  ```js
  const f = await gc.media.fetch('https://files.example.com/a/123', {
    headers: { authorization: 'Bearer …' }, // optional, like http.fetch
    timeoutMs: 30000,  // 1000 … 60000, default 30000 (all hops together, and within the host call's 30 s)
    mime: 'application/pdf', // optional: instead of the answer's Content-Type
    name: 'Elternbrief.pdf', // optional display / download name
    maxBytes: 10485760,      // optional, never above media.maxBytes
  });
  // → { mediaId, mime, bytes, name } — unclaimed (24 h), owner null
  await gc.media.claim(f.mediaId);
  ```

  * The URL is checked exactly like `gc.http.fetch`: hosts of
    `permissions.network.internet` only, public addresses only, DNS pinned;
    `GET` only; redirects are followed and every hop is checked again
    (`Authorization` / `Cookie` dropped when the origin changes).
  * Size ≤ `min(opts.maxBytes, media.maxBytes)` — a larger answer (declared
    `Content-Length` or the bytes received) is aborted → `ERR_MEDIA_TOO_LARGE`;
    an empty answer → `ERR_MEDIA_EMPTY`; the quota like an upload →
    `ERR_MEDIA_QUOTA`.
  * Type: `opts.mime`, else the answer's `Content-Type` (without parameters,
    lower case); it must be one of `media.types` → else `ERR_MEDIA_TYPE`
    (with `opts.mime` checked before anything is downloaded).
  * A status other than 2xx → `ERR_HTTP` (the error has `status`); network
    errors like `http.fetch`: `ERR_NET_DENIED` (not allowed, not public),
    `ERR_NET`; `ERR_TIMEOUT` when the download does not finish within
    `timeoutMs`; `ERR_INVALID` for bad arguments.
  * `name`: the last path segment only, control characters removed, trimmed,
    ≤ 200 characters (a long name keeps its extension), `null` when empty.
  * The new file is **unclaimed** and has **no owner** (`owner_user_id`
    NULL): bind it with `gc.media.claim(id)`; without the hook `mediaAccess`
    nobody may read it — the hook decides who does.
  * Stored like every media file (encrypted, see "At rest"). The answer is held
    in memory while it is checked (at most `media.maxBytes`).
* **Name** (since 1.190.0): a file with a name (`gc.media.fetch` `name`;
  `gc.media.info` → `name`, `null` for uploads) is served with
  `Content-Disposition: inline|attachment; filename="<ASCII fallback>";
  filename*=UTF-8''<percent-encoded name>` — inline for pictures, audio and
  video, a download for everything else, as without a name.
* **Claim**: a new file is unclaimed; the plugin binds it with
  `gc.media.claim(id)` (e.g. when the message using it is stored). Unclaimed
  files are removed **24 h** after the upload (hourly clean-up).
* **Who may read** a file: the plugin's hook `mediaAccess({ user, mediaId,
  owner, mime })` → `true` (anything else, an error or no answer within 5 s =
  no). Without the hook only the uploader (`owner`) may. The hook gets the
  viewer like `request()` (`app: true` for the apps).
  * apps: `GET /api/v1/client/plugins/<id>/media/<mediaId>` (and `HEAD`) with
    the device token — `Range: bytes=a-b` (one range) → `206` with
    `Content-Range` (voice messages, seeking), unsatisfiable → `416`; `404`
    when the hook says no;
  * frames (no session — opaque origin): the plugin hands out
    `gc.media.url(id, { user, ttlS })` → `/plugin-media/<token>`, a signed
    capability URL like the tile relay: `<id>.<exp>.<uid>.<sig>`, sig =
    HMAC-SHA256 over the media id, the plugin id, the expiry and the user id
    with the server secret; valid for `ttlS` (60 … 86400 s, default 3600),
    the expiry rounded up to 5 minutes (the same URL for a while — browser
    cache). Range like above; 404 once expired, tampered, deleted, or when the
    plugin no longer declares `media`. The plugin decides who gets a URL
    (call it for a viewer `mediaAccess` would allow).
  * Every answer: the stored type, `X-Content-Type-Options: nosniff`,
    `Content-Security-Policy: default-src 'none'; sandbox`,
    `Cross-Origin-Resource-Policy: cross-origin`, `Accept-Ranges: bytes`, an
    `ETag`; pictures, audio and video inline, every other type as a download
    (`Content-Disposition: attachment`).
* **Frames** of a plugin with `media` get `img-src` and `media-src`
  `<origin>/plugin-media/` in their CSP, and the `<iframe>` gets
  `allow="microphone *"` — voice recording (`MediaRecorder`, Opus) works in
  the portal and on the admin page. Since 1.178.0 their sandbox (the CSP
  `sandbox` directive and the `<iframe sandbox>` of the portal tab, the
  portal sections and the admin page alike) also has `allow-downloads`: a
  link to a `/plugin-media/<token>` URL of a document (answered as
  `Content-Disposition: attachment`) downloads the file instead of being
  dropped silently. Nothing else of the sandbox changes; plugins without
  `media` keep the sandbox as it was.
* **At rest**: `<data>/plugin-media/<plugin>/<id[0..2]>/<id>`, encrypted with
  AES-256-GCM in 64 KiB chunks (each chunk authenticated with its index and a
  "last" flag), with a random key per file; that key is stored in the core
  table `plugin_media` (`id, plugin, owner_user_id, mime, bytes, sha256,
  created_at, ref_count, claimed_at, key_enc, name`) wrapped with a key derived
  (HKDF-SHA256) from the server secret (`GC_SECRET`). Honest limit: whoever
  has root on the server can decrypt them; the encryption protects against
  copies of the data folder.
* **Quota**: `media.quotaDefault`, changed by the administrator on the
  plugin's overview (Plugins › the plugin › Übersicht → Medien; API `GET/PUT
  /api/v1/plugins/<id>/media/settings` `{ quotaBytes }`, `null` = the default;
  activity `plugin_media_quota`). Unclaimed files count.
* No conversion of the files themselves: the apps scale pictures before the
  upload (long side 2048 px, WebP/JPEG) where the plugin wants that.
  GateControl only makes small **previews** for plugins that ask for them
  (`media.previews`, since 1.208.0, see "Previews"); no audio processing.
* Uninstall "Daten behalten" keeps the files, "Alles löschen" deletes them.
* **Hand-over** (since 1.193.0): `gc.media.handOver(id, { toPlugin, user })`
  → `{ mediaId, mime, bytes, name }` — the file becomes a new file of plugin
  `toPlugin`, e.g. GateDrop handing a photo to the messenger before calling
  its service `send_file`, or to the Synology plugin for `save_file`:

  ```js
  const { mediaId } = await gc.media.handOver(id, { toPlugin: 'gatecontrol-messenger', user: 12 });
  await gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_file', userId: 12, payload: { mediaIds: [mediaId], … } });
  ```

  * Allowed like a service call: the caller lists one of the target's
    services (`"<toPlugin>:<service>"` the target provides) in
    `permissions.services` (else `ERR_SERVICES_DENIED`); the target is
    installed and may run (else `ERR_SERVICE_UNAVAILABLE`) and declares
    `media` (else `ERR_MEDIA_DENIED`); not the caller itself (`ERR_INVALID`).
  * The target's declaration decides: the type (`ERR_MEDIA_TYPE`), the size
    against its `handOverMaxBytes` (default its `maxBytes`,
    `ERR_MEDIA_TOO_LARGE`), its quota — the file counts there
    (`ERR_MEDIA_QUOTA`).
  * The new file is **unclaimed** (24 h, `gc.media.claim` by the target) and
    belongs to `user` (an enabled account) or nobody. The caller's file stays
    as it is (delete it when done).
  * The encrypted file is hard-linked (copied when the link fails), never
    decrypted; a file of 2 GB is handed over at once. ≤ 600 per hour per
    calling plugin, an activity row `plugin_media_handover` (ids only).
* Errors of `gc.media.*`: `ERR_MEDIA_DENIED` (no `media` in plugin.json),
  `ERR_INVALID` (bad id, unknown id for `claim`/`url`, bad `user`/`ttlS`, bad
  `fetch` arguments); `gc.media.fetch` also `ERR_MEDIA_TOO_LARGE`,
  `ERR_MEDIA_EMPTY`, `ERR_MEDIA_QUOTA`, `ERR_MEDIA_TYPE`, `ERR_HTTP`,
  `ERR_NET_DENIED`, `ERR_NET`, `ERR_TIMEOUT`. A plugin only ever sees its own
  files.
* `gc.media.usage()` (since 1.193.0) also answers `resumable` and
  `handOverMaxBytes`; since 1.208.0 `previews`.

### Previews (`media.previews`)

Since 1.208.0. Lists of files in the apps, the portal and Windows show small
pictures instead of a generic icon — without a phone downloading the whole
photo. GateControl makes them; for what it cannot read (HEIC photos, videos)
the device that uploaded the file sends one along. Code:
`src/services/plugins/mediaPreviews.js` (sharp / libvips).

```json
"media": { "maxBytes": 107374182400, "types": ["*/*"], "quotaDefault": "100TB", "resumable": true, "areas": true, "previews": true }
```

* **Sizes**: `small` (the default; fits 320 × 320 px) and `large` (fits
  1280 × 1280 px), always `image/jpeg`, never enlarged, upright by the EXIF
  orientation, transparency on white, without any metadata (no GPS, no
  camera data).
* **Made by the server** from files stored as `image/jpeg`, `image/png`,
  `image/webp`, `image/gif` (the first frame) and `image/avif`, up to 64 MB
  and 50 megapixels. The decoder checks the bytes themselves: a file stored
  as `image/png` that is really an SVG, a TIFF or anything else gets no
  preview (marked, never tried again). One picture at a time for the whole
  server (`sharp.concurrency(1)`, no libvips cache): the previews never slow
  down uploads. A preview is made **in the background** right after the
  plugin claims a file (`gc.media.claim` — while the file is still on this
  server, before it may go to a storage target) and otherwise **on the first
  request**; requests go before background work.
* **From the device** (HEIC, videos, any other file the server does not read):
  the uploader sends a preview of the file, e.g. right after its upload (or
  after the plugin's commit — the media id stays the same):

  ```
  PUT /api/v1/client/plugins/<id>/media/<mediaId>/preview      (device token of the uploader)
    Content-Type: image/jpeg | image/webp | image/png   Content-Length: ≤ 524288 (512 KB)
    <the picture, e.g. 640 px long side>
    → 200 { ok: true, ready: true, source: 'client' }
    404 not_found          unknown file, not the token owner's upload, no media.previews
    409 preview_by_server  the server makes this file's preview itself (JPEG, PNG, WebP, GIF, AVIF it can read)
    411 length_required · 413 too_large · 415 unsupported_type
    400 invalid_image      not a JPEG / WebP / PNG, or over 4096 × 4096 px
  ```

  The picture is decoded and encoded again into both sizes (nothing of the
  upload is kept as it came); sending again replaces it. Only the uploader
  (`owner`) may — also after the plugin claimed the file.
* **Reading** — the same rules as the file itself:
  * apps: `GET /api/v1/client/plugins/<id>/media/<mediaId>/preview[?size=large]`
    (and `HEAD`) with the device token; the hook `mediaAccess` decides like
    for the file (no hook: the uploader only). Own rate budget **1200 per
    minute and token** (a folder of photos is a few hundred requests), not
    counted against the plugin API's 240.
  * frames: `/plugin-media/<token>/preview[?size=large]` — the capability
    URL of `gc.media.url` with `/preview` appended (same token, same expiry);
    `gc.media.previews` hands them out ready to use.
  * `200 image/jpeg`, `Cache-Control: private, max-age=31536000, immutable`
    (apps; a media id's preview does not change — a new version of a file is
    a new media id) or until the token expires (frames), `ETag`, `nosniff`,
    the sandboxing CSP, `Cross-Origin-Resource-Policy: cross-origin`.
    `404 not_found`: no preview and none possible (not a picture the server
    reads, no device preview, unreadable picture, no access). `400
    invalid_size`: `size` other than `small` / `large`. `503
    preview_pending` with `Retry-After: 3` while the picture waits longer
    than 20 s for its turn (it is made anyway — ask again), `503
    preview_unavailable` when the file cannot be read right now (storage
    target unreachable). Errors are `no-store`.
* **`gc.media.previews(ids, { user, ttlS })`** → `{ <mediaId>: null | {
  ready, source, url, appUrl } }` for up to 1000 of the plugin's media ids
  (unknown ids → `null`): `null` — no preview and none possible; `ready` —
  made already (`false`: the server makes it on the first request);
  `source` — `server` or `client`; `url` — `/plugin-media/<token>/preview`
  for frames (signed for `user` and `ttlS` like `gc.media.url`); `appUrl` —
  `/api/v1/client/plugins/<id>/media/<mediaId>/preview` for the apps. Both
  take `?size=large`. `ERR_MEDIA_DENIED` without `media.previews`,
  `ERR_INVALID` for bad ids, `user`, `ttlS`.
* **At rest** next to the file: `<file>.ps` (small) and `<file>.pl`
  (large), AES-256-GCM under a key derived (HKDF) from the file's own key;
  `<file>.pc` marks a device preview, `<file>.px` a file the server could not
  read. They go with the file (delete, clean-up of unclaimed files, "Alles
  löschen"); a hand-over (`gc.media.handOver`) links them to the new file.
  They do not count against the quota, stay on this server when an area's
  files go to a storage target (the area cache never drops them) and are not
  in backups — the server makes them again, a device preview is gone after a
  restore.
* The install dialog shows **Vorschaubilder**: "GateControl macht kleine
  Vorschaubilder der Bilder … und nimmt die Vorschaubilder der Apps für Fotos
  und Videos an, die der Server nicht lesen kann".

### Media areas (`media.areas`)

Since 1.204.0. For plugins that keep many or large files (GateControl
Drive): the plugin sorts its files into **areas** it names itself, the
administrator decides per area where the files live — on this server (the
plugin media folder, as always) or on a **storage target**
([storage-targets.md](storage-targets.md): a folder, a NAS over SMB or
WebDAV, an S3 bucket). Code: `src/services/plugins/mediaAreas.js`.

```json
"media": { "maxBytes": 107374182400, "types": ["*/*"], "quotaDefault": "1TB", "resumable": true, "areas": true }
```

* `areas: true` raises the limits: `maxBytes` up to 100 GB, `quotaDefault` up
  to 1 PB, and `types` may be `["*/*"]` (every type). Types a browser would run
  (HTML, SVG, JavaScript, XML, JSON …) are still stored but always served as
  `application/octet-stream` download (`Content-Disposition: attachment`).
  The install dialog shows "alle Dateitypen" and a row **Speicherorte**.
* `gc.media.areas.ensure(area, { label, quota })` creates or updates an area
  → its info. `area`: 1–64 of `a-z 0-9 _ -` (starting with a letter or
  digit), at most 1000 per plugin; `label` ≤ 80 characters (shown to the
  administrator, default the id); `quota` in bytes (1 MB … 1 PB, null = none;
  the administrator can set another one that wins).
* `gc.media.areas.info(area)` → `{ area, label, target: { id, kind, label },
  moving: { to, done, total } | null, bytes, count, quota, quotaDefault,
  pending: { count, bytes }, state, error, encrypted: true, free }` or null.
  `target.kind` is `server` for this server. `state`: `ok`, `pending` (files
  still being copied), `moving`, `unreachable` (the target fails; `error` the
  storage error code). `free`: free bytes where new files go, when known.
* `gc.media.areas.list()` → the infos; `gc.media.areas.remove(area)` → true
  (false when unknown); only an empty area (else `ERR_INVALID`).
* `gc.media.claim(id, { area, path })` puts a file into an area (the area
  must exist; `path` — the plugin's own "Fotos/Urlaub/a.jpg", normalised,
  ≤ 1024 characters, no `.`/`..` or control characters — is stored with the
  file and returned by `gc.media.info`, which since 1.204.0 also answers
  `area`, `path` and `stored`: `server`, `target` or `pending`). An area's
  quota is checked here (`ERR_MEDIA_QUOTA`); the plugin's quota covers all its
  files as before. A claimed file stays in its area.
* `gc.media.usage()` also answers `areas` (true/false).
* Errors: `ERR_MEDIA_DENIED` (no `media.areas`), `ERR_INVALID`,
  `ERR_RATE_LIMIT` (too many areas), `ERR_MEDIA_QUOTA`.

### Readable files, moves and versions (since 1.204.1)

On a folder or a NAS (SMB, WebDAV) an area has a **form**, chosen by the
administrator next to its place:

* **Lesbare Dateien** (`files`, the default there): the plain file lies under
  the plugin's path, `<plugin>/<area>/<path>` below the target's folder — people
  can open it on the NAS and back it up with the NAS. Not encrypted there
  (`info.encrypted` false). A path a NAS cannot hold (`" < > | ? * : \`, a name
  ending in `.` or a space) is kept below `<plugin>/<area>/.gcdrive/files/`;
  versions go to `<plugin>/<area>/.gcdrive/versions/<path> (<time> <id>)<.ext>`.
* **Verschlüsselte Blöcke** (`blocks`): the sealed file under an opaque key —
  the only form on S3 and on this server.

Switching the form (or the place) moves the files in the background like a
move of the area. API:

* `gc.media.move(id, { path, area })` → the file's info: a new path (unique in
  the area, `ERR_CONFLICT` when taken) and/or another area of the plugin (its
  quota). On the target the worker renames the readable file (no bytes
  travel) or copies it to the other area's place.
* `gc.media.version(id)` → the file's info: keeps the file as a version of its
  path (`versionOf`, `versionAt` in `gc.media.info`; `path` becomes null, the
  media id stays) — the path is free for the next file. Typical for an
  overwrite: `version(old)`, then `claim(new, { area, path })`. Delete a
  version with `gc.media.delete`. **Restore** (since 1.207.0):
  `gc.media.move(versionId, { path })` makes the version the current file at
  that path again (`versionOf` gone; on the NAS it moves back from
  `.gcdrive/versions`) — free the path first, e.g. `version(current)`; a
  version moves only to a path (`ERR_INVALID` without one).
* `gc.media.move(id, { path: null })` takes a file off its path (it stays in
  the area, on the NAS below `.gcdrive/files`) — e.g. a trash; `move(id, {
  path })` brings it back.
* `gc.media.claim(id, { area, path })` refuses a path another file of the area
  has (`ERR_CONFLICT`) and a file of another area (use `move`).

**Changes made on the NAS** (form `files`): every 15 minutes (and with
`gc.media.areas.scan(area)` or "Jetzt abgleichen") the server lists the area's
folder:

* a file changed there (size or time) becomes a **new media file** at its path;
  the old one becomes a version of it when its bytes are still here (a local
  copy — it then goes to `.gcdrive/versions`), else it is gone;
* a **new file** there is taken in at its path (claimed, type from the
  extension, read once for size and SHA-256 — no local copy). When the area
  still wants to put one of its files at that path, the NAS file becomes a
  conflict copy `Name (Konflikt <time>).ext` (renamed on the NAS too);
* a **missing file** is marked and removed at the next scan when it is still
  missing. More than 50 files and 20 % of the area at once are not removed:
  the area shows `scan.error` `mass_missing` until the administrator presses
  "Löschungen übernehmen";
* files changed in the last minute (still being written) wait for the next
  scan; `.gcdrive` is the server's own.

Every change goes into a journal the plugin reads:
`gc.media.areas.changes(area, { since, limit })` → `{ changes: [{ seq, type:
'added'|'changed'|'removed', mediaId, previous, path, at }], next, more }`
(≤ 1000 per page, kept 30 days). After a scan with changes the server calls the
optional hook `mediaChanged({ area, seq, count })`; a plugin that was not
running catches up from its last `seq`.

`gc.media.areas.info` also answers `form` and `scan: { at, error, stats: {
files, added, changed, removed, missing } }` (form `files`). Admin API:
`PUT /api/v1/plugins/<id>/media/areas/<area>` also takes `form`;
`POST …/media/areas/<area>/scan`, `POST …/media/areas/<area>/confirm-removals`
(activity `plugin_media_area_removals`). Migration 116 (`plugin_media_areas.form,
scanned_at, scan_error, scan_stats, confirm_removals`, the columns
`stored_form, want_key, version_of, version_at, remote_size, remote_mtime,
missing_since` of `plugin_media`, `plugin_media_changes`).

How the files travel:

* Every file arrives on this server first (upload, `gc.media.fetch`,
  hand-over) and is sealed like all plugin media. For an area on a storage
  target a background worker (every 15 s, and right after a claim) copies it
  there: in the form `blocks` the **sealed** file under an opaque key
  `<plugin>/<area>/<id[0..2]>/<id>` — the target only ever sees encrypted
  64 KiB blocks, never names or paths; in the form `files` the plain file under
  its path (above). Only after the copy is complete and
  its size checked does the file count as stored there; the local copy stays
  as **cache**.
* **Cache**: local copies of files kept on targets, at most the size set on
  the page *Plugins › Speicher* (setting `plugins.media_cache_bytes`, default
  5 GB, 256 MB … 100 TB); the least recently read go first. Files still
  waiting to be copied are never dropped and do not count.
* **Reading** a file without a local copy: a readable file is read straight
  from the target (the requested range); a sealed one from a target that reads
  ranges (folder, WebDAV, S3) by the sealed blocks of the requested range
  (video seeking works); from SMB a sealed file comes into the cache first. A target that does not answer gives `503
  storage_unavailable` before any byte is sent.
* **Moving** an area (the administrator picks another place): its files are
  copied in the background, the old copies deleted afterwards; until a file
  has moved it is read from where it was, new files go to the new place.
  Activity rows `plugin_media_area_target` (the change) and
  `plugin_media_area_moved` (done).
* **Deleting** a file (or "Alles löschen" for the plugin) deletes the copy on
  the target too; deletions a target cannot do now are retried (table
  `plugin_media_gone`, with a growing pause).
* A **failing target** is retried with a growing pause (30 s … 15 min). After
  15 minutes the administrators get `storage_target_unreachable` (activity
  log, notification "Speicherziel nicht erreichbar / wieder da"), once, and
  `storage_target_recovered` when it works again. Files keep arriving on this
  server meanwhile; when the files waiting for a failing target would exceed
  the cache, uploads answer `503 storage_unavailable`. Uploads also need free
  space on this server (`507 server_full`, 512 MB margin).
* **Upload digest**: an upload (whole or resumable) may name the SHA-256 of
  the file in `Repr-Digest`, `Content-Digest` (RFC 9530, `sha-256=:…:`) or
  `Digest` (`sha-256=…`); a file that does not match is refused (`400
  digest_mismatch`, a malformed header `400 invalid_digest`). For every
  plugin with `media`, not only with areas.
* **Admin** (plugin settings, section *Speicherorte*): per area the place
  (this server or a target), the quota, the state (copied, waiting, moving,
  unreachable); "Speicherziel hinzufügen" opens the target dialog. API:
  `GET /api/v1/plugins/<id>/media/areas` (areas, targets, cache) and
  `PUT /api/v1/plugins/<id>/media/areas/<area>` `{ targetId | null,
  quotaBytes | null }`. A target that an area uses cannot be deleted.
* **Backup**: the areas and the metadata of their files (ids, area, path,
  where they are, each file key encrypted like media keys) are always part of
  the plugin's backup entry (`media_areas`) — never the bytes: they stay on
  the storage target. A restore brings back every file whose bytes are still
  there (on its target, or the local file for an area on this server).
* Tables (migration 115): `plugin_media_areas`, the columns `area, path,
  target_id, remote_key, nonce_prefix, local, accessed_at, push_error` of
  `plugin_media`, `plugin_media_gone`.

## Public links (`permissions.publicLinks`)

Since 1.193.0. A plugin shares some of its media files with people **without
a GateControl account** — GateDrop's "Link für Externe": a link valid for a
while, optionally with a PIN, a page to download the files, all of them as one
ZIP. GateControl serves it; the plugin only creates, lists and revokes. Code:
`src/services/plugins/publicLinks.js`, `src/routes/publicLinks.js`.

* **Two locks**: `permissions.publicLinks: true` in plugin.json, and the
  administrator's switch *Öffentliche Links erlauben* on the plugin's
  *Berechtigungen* tab (Einstellungen › Plugins › the plugin) — **off** by
  default; API `GET/PUT /api/v1/plugins/<id>/public-links` `{ allowed }` →
  `{ allowed, unlimited, publicUrl, active }`, activity `plugin_public_links`. While
  either is missing, every `gc.publicLinks.*` call throws
  `ERR_PUBLIC_LINKS_DISABLED` and existing links answer 404 (they work again
  when it is switched back on).
* **URL**: built on GateControl's configured public URL (`GC_BASE_URL`) — it
  must be `https` with a public host name (not localhost, not an internal
  suffix such as `.lan` / `.local` / `.internal`, not a private address), else
  `create` throws `ERR_NO_PUBLIC_URL`. The URL is `<GC_BASE_URL origin>/s/<token>`.

```js
const { token, url, expiresAt } = await gc.publicLinks.create({
  ownerUserId: 12,                 // required: the person who shares (an enabled account; the page shows the name)
  title: 'Urlaubsfotos',           // optional, ≤ 120 characters
  note: 'Viel Spaß!',              // optional, ≤ 500 characters (newlines kept)
  files: [{ mediaId, name: 'Strand.jpg' }],   // 1 … 20 CLAIMED files of the plugin; name optional (default: the media's)
  expiresAt: Date.now() + 86400000,           // ms, 1 minute … 30 days ahead
  maxDownloads: 1,                 // optional, 1 … 1000 downloads per file (none: unlimited)
  pin: '4711',                     // optional, 4 … 8 digits as a string — stored only as an scrypt hash
});
// token: 24 characters base64url (144 bits); url: 'https://gc.example.com/s/<token>'

await gc.publicLinks.list({ ownerUserId: 12 });   // the plugin's links (of one person), newest first
await gc.publicLinks.get(token);                  // one link or null
await gc.publicLinks.revoke(token);               // → true when it was active
```

A link (`list` / `get`): `{ token, url, title, note, ownerUserId, createdAt
(ISO), expiresAt (ms), maxDownloads, pin (boolean), pinFailures, state:
'active'|'expired'|'revoked'|'locked'|'used'|'gone', active, revoked, locked,
expired, downloads (all files), files: [{ id ('1' …), mediaId, name, mime,
bytes, downloads, lastDownloadAt }] }`. `used`: every file reached
`maxDownloads`; `gone`: one of its files was deleted.

**The core's routes** (no login, before every authenticated route, nothing
but the files of that link is ever served):

```
GET  /s/<token>             the page (de/en by the browser's Accept-Language): title, "Geteilt von <name>",
                            expiry; with a PIN first only the PIN form; then the note, the files with their
                            sizes, a download button each and "Alle als ZIP herunterladen" (more than one file)
POST /s/<token>/unlock      { pin } as a form → 303 back to the page + cookie | JSON (Accept / Content-Type
                            application/json) → { ok: true }; wrong → 403 (page with the attempts left /
                            { ok: false, code: 'wrong_pin', left }); the 5th wrong PIN locks the link → 410
GET  /s/<token>/f/<n>       file n (1 …): Content-Disposition attachment with the UTF-8 name, Range (206/416)
GET  /s/<token>/zip         all files as one ZIP (stored, streamed, Content-Length known, ZIP64 beyond 4 GiB)
```

* Unknown token → 404 (the same page for every miss); ended (expired,
  revoked, locked, used up, a file deleted) → 410 with the reason; a PIN link
  without the unlock cookie → 403 for files and the ZIP.
* PIN: a right PIN sets an HttpOnly cookie for `Path=/s/<token>` only (1 h,
  HMAC with the server secret, `Secure` with an https `GC_BASE_URL`); five
  wrong PINs in a row lock the link for good. A form from another `Origin` is
  refused. The PIN never appears in a log.
* Downloads: a request from byte 0 (no `Range`, or a `Range` from 0) of a
  file counts one download of it; the ZIP counts one of each file. A file at
  `maxDownloads` is refused (410 `used`); counting is atomic (parallel
  requests for the last download: one wins). A counted download sets a resume
  cookie for that file (HttpOnly, `Path=/s/<token>/f/<n>`, 6 h, signed with
  the server secret): with it, a `Range` later in the file is a free
  continuation, even once the file is used up. A `Range` later in the file
  without that cookie (another client holding the URL) is a new download — it
  counts, and is refused once the file is used up (since 1.193.1; before, any
  client could resume within 6 h). `HEAD` never counts.
* Every answer: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow,
  noarchive`, `Referrer-Policy: no-referrer`, `nosniff`, `X-Frame-Options:
  DENY`; the page a strict CSP without any script (`default-src 'none'`,
  styles of this server, `form-action 'self'`, `frame-ancestors 'none'`);
  files `default-src 'none'; sandbox`.
* Rate limits per address: 120 requests per minute on `/s/…` (failed ones
  count), 20 PIN entries per 15 minutes.
* A link ends with its files: `gc.media.delete` (or the clean-up of a file)
  revokes every link using it; uninstalling the plugin deletes its links
  (with "Daten behalten" too). Only claimed files can be shared
  (`ERR_INVALID` otherwise). Rows of ended links are deleted 30 days after
  their end (hourly).
* **Hook** `publicLinkEvent({ token, event, … })` (optional, in the
  background, the answer is ignored): `'download'` with `file: { id, name }`
  (or `zip: true`, `file: null`) and `downloads` (all files), `'locked'` (5
  wrong PINs), `'expired'` (noticed by the hourly run) — for the plugin's own
  notifications ("Dein Link wurde geladen").
* Errors of `gc.publicLinks.*`: `ERR_PUBLIC_LINKS_DISABLED`,
  `ERR_NO_PUBLIC_URL`, `ERR_INVALID` (bad arguments, unknown / unclaimed /
  other plugin's media), `ERR_RATE_LIMIT` (5000 links per plugin). Activity
  `plugin_public_link` when a link is created (count of files, no names) and
  when one is locked.

### Folder links, upload links, view only, the log (since 1.205.0)

A link has a **kind** and a **mode**:

* `kind: 'files'` (default) — the files of the list above.
* `kind: 'folder'` — a folder of a media area (needs `media.areas`): `area`
  and `path` ('' or missing = the whole area). The page always shows the
  folder's **current** content: its sub folders (`?p=<sub folder>`, never
  above the link's folder), a gallery of pictures and videos, the other files,
  "Ordner als ZIP herunterladen" (the folder shown, with its sub folders, up to
  10 000 files). Only current files (no versions) of that area below that
  path are served; files added later appear, deleted ones go.
* `kind: 'upload'` — people **bring** files into a folder of an area (needs
  `media.areas`, not `media.uploads: false`): a name field ("Dein Name",
  optional), file choice and drop zone, a progress bar per file. The visitor
  never sees other files of the folder, only the ones they uploaded
  themselves (by their visitor cookie). Limits: `maxFiles` (1 … 10 000,
  default 500), `maxBytes` (all files together, 1 MB … 1 TB, default 5 GB),
  `types` (optional, ≤ 32: MIME types, families `"image/*"` or extensions
  `".pdf"`); the plugin's own `media.maxBytes`, `media.types`, quota and the
  room on the server apply on top. Count and bytes are reserved atomically
  before a file is stored (parallel uploads never pass a limit; a failed one
  gives its share back). The file belongs to the link's owner, lands claimed
  under `<path>/<name>` — a taken name gets " (2)", " (3)", … — and syncs to
  the area's storage target like every other file.
* `mode: 'view'` (`'download'` default; not for uploads) — pictures, videos
  and sound only shown in the page; no download button, no ZIP, the download
  routes answer 403 `view only`. (A browser can still save what it shows —
  "view only" is no copy protection.)

```js
await gc.publicLinks.create({ ownerUserId: 12, kind: 'folder', area: 'docs', path: 'Fotos/2026',
  mode: 'view', title: 'Urlaub', expiresAt: Date.now() + 7 * 86400000 });
await gc.publicLinks.create({ ownerUserId: 12, kind: 'upload', area: 'docs', path: 'Eingang',
  maxFiles: 50, maxBytes: 2 * 1024 ** 3, types: ['image/*', '.pdf'], expiresAt: Date.now() + 86400000 });

await gc.publicLinks.events(token, { limit: 100, before });   // the log, newest first (≤ 500 per call)
await gc.publicLinks.uploads(token);                          // what came in through an upload link
```

* `maxDownloads` belongs to `kind: 'files'` only (`ERR_INVALID` otherwise);
  `files` only to it, `area` / `path` only to the others (unknown area,
  a path with `..` → `ERR_INVALID`).
* A link (`list` / `get`) also has `kind`, `mode`, `opens` (page views),
  for folder and upload links `area` and `path`, for upload links `upload:
  { maxFiles, maxBytes, types, files, bytes }`; `downloads` of a folder link
  counts downloads and ZIPs of the log. State `gone` also: the link's area
  was removed.
* **Without an end** — `expiresAt: null` — only while the administrator's
  second switch *Links ohne Ablaufdatum erlauben* is on (off by default; API
  `PUT /api/v1/plugins/<id>/public-links { unlimited }`, `GET` answers
  `unlimited` too; activity `plugin_public_links`). Switching it off ends
  every such link of the plugin for good (state `revoked`; switching it on
  again brings none back). `expiresAt` of such a link is `null`, the page
  says "Ohne Ablaufdatum".
* **The log** (`events`): `{ id, at (ISO), kind, ip, visitor, name, mediaId,
  bytes, uploader }` with kind `open` (the page, once per visitor and hour;
  `opens` counts every view), `download`, `zip`, `upload`, `unlock`,
  `pin_failed`, `locked`. `ip` is shortened before it is stored — IPv4 to its
  /24 (`203.0.113.0`), IPv6 to its /48 (`2001:db8:1::`) — and `visitor` is a
  random id from a cookie of the link's path (`gc_pv`, 30 days, HttpOnly).
  Up to 5000 lines per link (the oldest go); the log goes with the link.
* `uploads(token)`: `[{ mediaId, name, path, uploader, bytes, at }]`
  (`uploader`: the name the visitor typed, ≤ 80 characters, or null).
* **Hook** `publicLinkEvent` also: `'upload'` with `{ mediaId, name, path,
  uploader, bytes }`; `'download'` of a folder link with `path` (and `file:
  { mediaId, name }`, or `zip: true`).

Routes of v2:

```
GET  /s/<token>?p=<sub>     folder link: that sub folder
GET  /s/<token>/m/<id>      a file of a folder link (below its folder, a current file): download (logged);
                            ?view=1 inline for pictures / videos / sound (not logged)
GET  /s/<token>/f/<n>?view=1  a file of a files link inline (pictures / videos / sound; not counted)
GET  /s/<token>/zip?p=<sub> folder link: that folder with its sub folders as one ZIP
PUT  /s/<token>/u?name=<file>&type=<MIME>&by=<name>
                            one file into an upload link; the body is the file (application/octet-stream,
                            Content-Length) → { ok: true, name (the one it got), bytes }; errors
                            { ok: false, code }: 400 name, 415 type, 413 limit / too_large, 507 quota_exceeded /
                            server_full, 403 another Origin, 410 the link ended
```

* Inline views are only for pictures, videos and sound, never for a type a
  browser would run (`text/html`, SVG, …): those answer 403 `no preview`.
* The upload page is the only one with a script (`/js/public-link-upload.js`
  of this server; CSP `script-src 'self'; connect-src 'self'`); the others
  stay without any. Pages may show pictures and videos of this server
  (`img-src 'self' data:; media-src 'self'`).
* Rate limits per address: the files of a folder link (`/m/…`, a gallery
  loads many) 1500 per minute; uploads 1000 per hour. An upload body has the
  long deadline of media uploads.

## Devices (`permissions.devices`)

Since 1.193.0. A plugin that works with a person's own devices — GateDrop's
"Meine Geräte" — sees the GateControl apps of that person and can reach a
single device. Code: `src/services/plugins/devices.js`.

* `gc.devices.list({ userId })` → the person's app installations: an API
  token of the person with scope `client` that an app used (push stream,
  registered peer or any request), or — since 1.194.1 — a `full-access`
  token on which an app identified itself (client type/version on the push
  stream or a registered peer). Never admin or automation tokens:

  ```js
  [{ id: '42',                 // string, stable: the device token's id
     name: 'Pixel 8',          // the token's name
     platform: 'android',      // 'android' | 'windows' | 'ios' | 'web' | null
     clientType: 'pro',        // 'pro' | 'community' | null (Windows editions)
     appVersion: '2.4.0',      // or null
     online: true,             // push stream connected now, or within the last 60 s
     lastSeen: '2026-10-21T09:12:40.000Z',
     via: 'lan' }]             // the open stream's path: 'vpn' | 'lan' | 'internet'; null while offline
  ```

  `ERR_DEVICES_DENIED` without the permission, `ERR_INVALID` for an unknown or
  disabled person.
* **The asking device**: requests of the apps (`/api/v1/client/plugins/<id>/api/…`)
  to a plugin with `permissions.devices` carry `req.user.device = { id,
  platform }` (the same `id` as in the list; `platform` from the app's
  `X-Client-Platform` header, else what it reported). Other plugins never get
  it.
* **To single devices**: `gc.notify({ topic, title, users: [12], devices:
  ['42'], … })` — only these devices (token ids as strings or numbers, ≤ 100)
  get it; each must be an app device of one of `users` (else `ERR_INVALID`,
  `devices` without `users` too). A device that is offline gets it when it
  connects again, like every delivery.
* **Silent data notifications**: `gc.notify({ topic, users, devices?, silent:
  true, data })` — the app gets only `data` and shows nothing (no banner, no
  sound, not in the inbox): `kind: "data"` and `silent: true` in the push
  payload (docs/feature-notification-center.md "Daten-Mitteilungen"). `title`
  is optional (default the plugin's name), `image` not allowed, never
  bundled, held back, mailed or routed into a chat, no activity row; own
  budget of 600 per hour and plugin (`ERR_RATE_LIMIT`). The topic is any of
  `notifyTopics` (not a chat topic); the person's topic switch and device
  mutes apply like for every plugin notification. For "device X: fetch
  transfer Y".
* `devices` and `silent` need `permissions.devices` (`ERR_DEVICES_DENIED`);
  on a chat topic they are `ERR_INVALID`.

## Groups (`permissions.groups`)

GateControl keeps the person groups centrally — teams, departments,
projects, sites and the family (docs/groups.md). Plugins use the same groups
instead of keeping member lists of their own. Code:
`src/services/plugins/groups.js` (host side), `src/services/groups.js`.

```json
"permissions": { "groups": "read" }      // or "manage": also its own groups
```

### Reading (`"read"` and `"manage"`)

```js
await gc.groups.list();                                  // every non-archived group
await gc.groups.list({ kind: 'team' });                  // all teams
await gc.groups.list({ userId: 12, includeInherited: true });
// → [{ id, name, path: 'Verwaltung › Buchhaltung', kind, role, direct, source, archived }]
await gc.groups.get(7);
// → { id, name, path, kind, parentId, childIds, depth, source, own, key, endsAt, archived,
//     memberCount, totalMemberCount } | null
await gc.groups.members(7, { nested: true, roles: ['lead', 'member'] });
// → [{ userId, name, role, direct, source, groupId, enabled }]
await gc.groups.isMember(12, 7, { nested: true });       // → true
await gc.groups.leadersOf(12, { groupId: 7 });
// → [{ userId, name, role: 'lead', groupId: 7 }, { userId, name, role: 'deputy', groupId: 7 }]
```

* `list({ userId, kind, includeInherited, includeArchived })`: without
  `userId` every group (as `get` answers it), with `userId` that person's
  groups with their role (`direct: false` = only through a subgroup, role
  `member`). `kind` one of `department`, `team`, `project`, `site`,
  `family`.
* `members(id, { nested, roles })`: direct members, with `nested: true` also
  the members of the subgroups (`direct: false`, role `member`, `groupId` =
  the subgroup). Disabled accounts are listed with `enabled: false` — they
  rest (no access, no leadership) until enabled again.
* `isMember(userId, groupId, { nested })`: archived groups and disabled
  accounts answer `false`.
* `leadersOf(userId, { groupId })`: lead (family: parent) before deputy;
  nobody is their own leader; a group without lead or deputy is led by the
  nearest group above. Without `groupId`: the leaders of all the person's
  groups.
* Answers are plain JSON: ids, names, paths, kinds, roles, sources. **Never
  e-mail addresses or user names** — `gc.users` (`permissions.users`) does not
  hand them out either; use `gc.users.get(id)` for the picture and colour.
* `source` is `local`, `directory:<id>` or `plugin:<pluginId>`; `own: true`
  and `key` mark the plugin's own groups.

### The plugin's own groups (`"manage"`)

```js
const g = await gc.groups.ensure({ key: 'family', name: 'Familie Backes', kind: 'family',
  members: [{ userId: 12, role: 'parent' }, { userId: 15, role: 'child' }] });
// → the group as get() answers it + { created, added, removed, changed }
await gc.groups.ensure({ key: 'team-a', name: 'Team A', kind: 'team', parentKey: 'org', members: [] });
await gc.groups.remove('team-a');                        // → true (false: no such group of the plugin)
```

* `ensure` creates the group with source `plugin:<pluginId>` and the key as
  its external id, or updates it (name, kind, parent) and sets its members
  **exactly** (missing ones are removed). `key` 1–100 characters `A-Z a-z
  0-9 _ . : -`, unique per plugin; `parentKey` another of its own groups
  (at most 3 levels; families stay at the top level); a member without `role`
  is `member` (family: `child`). An archived group of the plugin is restored.
  Idempotent: call it in `start` and whenever the plugin's own data changes.
* `remove(key)` deletes the group after the other plugins' `groupDeleting`
  (a group with subgroups: remove those first, `ERR_INVALID`). A group id
  instead of a key must name one of the plugin's own groups.
* Every write goes through the groups service with the plugin as owner: a
  plugin never changes a group it does not own (`ERR_READ_ONLY`), and its
  groups are read-only for administrators (only the colour) and in the portal.
  Invitation links do not exist for plugin groups.

### Hooks

```js
async groupsChanged({ changes }, gc) {
  // [{ type: 'member_added'|'member_removed'|'role_changed'|'group_created'|'group_renamed'|'group_moved'|
  //   'group_archived'|'group_unarchived'|'group_deleted', groupId, userId?, role?, reason? }]
  // batched, at most once per second; reason e.g. 'user_disabled', 'user_deleted', 'group_deleted'
}
async groupUsage({ groupId, successorUserId }, gc) {   // "Wird genutzt von" and the delete dialog
  return [{ kind: 'Drive', label: 'Team-Ordner Buchhaltung', onDelete: 'wird in Meine Dateien von Thomas Berg verschoben' }];
}
async groupDeleting({ groupId, successorUserId }, gc) { /* clean up */ }
```

* Every running plugin with `permissions.groups` that exports the hook gets
  it; best-effort like the other hooks.
* `groupsChanged`: 10 s per call, never awaited, failures land in the
  plugin's log. After a restart fetch the current state yourself (no replay).
* `groupUsage`: 4.5 s; an error, a timeout or anything but a list is
  ignored; at most 50 entries, `label` required (≤ 200), `kind` (≤ 60,
  default the plugin's name), `onDelete` (≤ 300) what happens to it when the
  group is deleted. `successorUserId`: who would take over (the person chosen
  in the delete dialog, else the group's lead or deputy, else `null`) — name
  that person in `onDelete`; the dialog asks again when the choice changes.
  A text starting in lower case continues the label as one sentence
  ("Team-Ordner Buchhaltung wird in Meine Dateien von Thomas Berg
  verschoben").
* `groupDeleting`: before the group is deleted (admin page, admin API,
  another plugin's `remove`) — all plugins in parallel, **30 s in total**;
  failures and timeouts are logged and the deletion goes on. The plugin that
  removes its own group is not asked. `successorUserId`: who takes over what
  the plugin keeps for the group (the administrator's choice
  `DELETE /api/v1/groups/:id?successor=<userId>`, else the group's lead or
  deputy, else `null`; `successor=none` = `null`). A refused deletion (wrong name, subgroups) asks
  nobody.

### Notifications to groups

```js
await gc.notify({ topic: 'news', title: 'Teamtreffen', body: 'Morgen 9 Uhr', groups: [7], users: [12] });
// → { pushed, id, recipients: 6 }
```

`groups` (1…50 group ids, each must exist — else `ERR_INVALID`; needs
`permissions.groups`, else `ERR_GROUPS_DENIED`) on any topic, chat topics too:
the enabled members of the groups and their subgroups at send time (archived
groups count as empty), merged with `users`; at most 1000 people. Groups
without anybody send nothing (`{ pushed: false, id: null, recipients: 0 }`)
— never the topic's subscribers. Budgets, topic rules, quiet hours, a
person's switches and `devices` work as for `users`. The activity row names
the groups and the count, never the people.

### Picker for groups and people (`GC.pickPrincipals`)

```js
const picked = await GC.pickPrincipals({ groups: true, users: true, multiple: true, title: 'Freigeben für' });
// → [{ type: 'group', id: 7, label: 'Verwaltung › Buchhaltung' }, { type: 'user', id: 12, label: 'Thomas Berg' }]
//   or null (cancelled)
```

Frames of plugins with `permissions.groups` (admin pages, settings page,
portal tab and sections) have `window.GC.pickPrincipals`; the parent page
opens GateControl's own dialog (search, chips; `multiple: false` → one click
picks) and answers only what was chosen. Plugins no longer build person
pickers of their own. What is offered depends on the **viewer**:

* admin pages: every non-archived group (label = path) and every enabled
  account (display name) — `GET /api/v1/principals` (admin session);
* portal: every non-archived group by name (no member lists) and the viewer
  ("ich") — portal viewers cannot list other people
  (`GET /api/v1/portal/groups/principals`, signed-in people only; device
  trust and kiosk devices get no list, the dialog says so).

`groups` defaults to `true`, `users` to `false`; `title` ≤ 120 characters.
The promise never rejects. The `<iframe>` carries `data-plugin-groups` (set
by the server, the frame cannot add it); one picker at a time; a new document
in the frame closes its picker. An older GateControl has no
`GC.pickPrincipals` — feature-detect it.

### Errors

`ERR_GROUPS_DENIED` (no permission, or `ensure`/`remove` without `"manage"`),
`ERR_NOT_FOUND` (unknown group for `members`/`isMember`/`leadersOf`, unknown
`parentKey`), `ERR_READ_ONLY` (not the plugin's group), `ERR_INVALID` (bad
arguments; the groups service's code is the message prefix, e.g.
`NAME_TAKEN: …`, `DEPTH_EXCEEDED: …`, `HAS_CHILDREN: …`).

## Realtime events (`permissions.events`)

Since 1.177.0. `gc.events.emit({ users, type, data })` sends an ephemeral
event to the listed people — a new message, "schreibt …", read marks:

* `users` 1 … 500 user ids, `type` `[a-z][a-z0-9._-]{0,63}`, `data` any JSON
  ≤ 4 KB (or nothing → `null`). → `{ delivered }`: the number of streams it
  was written to. Errors `ERR_EVENTS_DENIED`, `ERR_INVALID`,
  `ERR_RATE_LIMIT` (600 calls per minute and plugin).
* Ephemeral: not stored, not in the inbox, not in the push budget, no
  replay. A stream under backpressure drops it. After a reconnect clients
  fetch the current state from the plugin's API.
* **Apps** (Android, Windows): on their push stream (`GET
  /api/v1/client/push`) as `event: plugin` with `{ plugin, type, data }` and
  no SSE id — every open stream of a listed person (docs/feature-notification-center.md
  "Plugin-Ereignisse").
* **Frames** (portal, admin page): `GC.on('event', fn)` — `fn({ plugin, type,
  data })`; `GC.off('event', fn)`. The parent page opens one EventSource per
  plugin when a frame first subscribes (`GET /api/v1/portal/plugins/<id>/events`
  for a signed-in portal viewer or a kiosk device — device trust alone gets
  `403`; `GET /api/v1/plugins/<id>/events` on the admin page) and passes each
  event to the plugin's subscribed frames. At most 16 such streams per person.

## Services between plugins (`services`)

Since 1.177.0. A plugin offers named services in `services.provides`; another
plugin lists the ones it calls in `permissions.services` (shown in both
install dialogs: "Dienste anderer Plugins: darf nutzen: …" / "Eigene Dienste:
bietet anderen Plugins an: …"):

```js
// caller (permissions.services: ["gatecontrol-messenger:sync_group", "gatecontrol-messenger:send_message",
//   "gatecontrol-messenger:release_group"])
if (await gc.services.available('gatecontrol-messenger', 'send_message')) {
  await gc.services.call({ plugin: 'gatecontrol-messenger', service: 'sync_group',
    payload: { key: 'family', title: 'Familie', userIds: [12, 15, 17] } });
  const res = await gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message', userId: 12,
    payload: { conversation: 'family', text: 'Tim ist zu Hause' } });
  // conversation: 'family' | 'group:<id>' | 'user:<id>' (notice channel, title? names it) | 'direct:<id>' (needs userId)
  // res: { ok: true, conversationId: 12, messageId: 4711 } — or { ok: false, code: 'invalid' | 'not_found' | 'forbidden' }

  // several targets in one call (1…20; each sent on its own, one refusal does not stop the others)
  const many = await gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message',
    payload: { conversation: ['family', 'user:15'], text: 'Müll rausbringen' } });
  // many: { ok: true, sent: 2, failed: 0, results: [{ conversation: 'family', ok: true, conversationId, messageId }, …] }

  // the feature is switched off: hand the group back (a normal group again, the given members its admins)
  await gc.services.call({ plugin: 'gatecontrol-messenger', service: 'release_group',
    payload: { key: 'family', adminIds: [12] } });   // delete: true removes it for everyone instead
}

// provider (services.provides.send_message)
async service({ name, caller, user, payload }, gc) {
  // name 'send_message', caller 'gatecontrol-familie', user { id, name, role } | null
  return { ok: true, conversationId: 12, messageId: 4711 };
}
```

The payloads above are the messenger's (its README, "Services"); each
provider documents its own.

* **`gc.services.available(plugin, service)`** (since 1.178.0; also
  `available({ plugin, service })`) → `true` | `false`: would a call reach the
  provider right now — the caller lists `"<plugin>:<service>"` in
  `permissions.services`, it is not the caller itself, and the provider is
  installed, may run (enabled, compatible, signed or allowed, licensed), is
  running and declares the service in `services.provides`. It asks nobody:
  the provider's hook is not run, it does not count towards the 60 calls per
  hour, no activity row. Only a malformed plugin id or service name throws
  (`ERR_INVALID`). A `true` is a snapshot — `call()` can still fail
  (`ERR_SERVICE_UNAVAILABLE` when the provider stopped meanwhile, the
  provider's own refusal), so handle its errors anyway. Use it to hide a
  feature (a "Familie im Messenger" switch) when the messenger is not there.

* The provider must be usable (installed, may run, running) and declare the
  service; the caller must list exactly `"<plugin>:<service>"`. `userId`
  (optional) must be an existing, enabled account — the provider gets it as
  `user: { id, name, role }` (`null` without) and decides itself what the
  call may do for that person.
* `payload`: JSON ≤ 512 KB (16 KB before 1.180.0 — enough for a small
  base64 image); the answer: JSON ≤ 16 KB; 15 s; **60 calls per hour**
  and calling plugin; an activity row `plugin_service` per call (ids and ok
  only, never the payload).
* Errors of `call()`: `ERR_SERVICES_DENIED` (not listed), `ERR_SERVICE_UNAVAILABLE`
  (provider not installed / not running / no such service), `ERR_INVALID`
  (bad ids, user, payload over 512 KB, the caller's own plugin),
  `ERR_RATE_LIMIT`, `ERR_TIMEOUT`, `ERR_SERVICE_FAILED` (the hook threw — its
  message — or answered more than 16 KB; a provider without the hook:
  "this plugin offers no services").

## Storage and migrations

Each plugin gets **its own SQLite file** (`<data>/plugin-data/<id>/db/plugin.db`),
opened by the host in a worker thread — chosen over prefixed tables in the
main database: no SQL parsing is needed to keep a plugin away from
GateControl's tables (the main database is simply not open there), "Alles
löschen" is deleting one folder, the file has a size cap (256 MB, more with
`storage.maxMB`, see below) and a
runaway query blocks only that worker (terminated after 5 s). Statements with
`ATTACH`, `DETACH`, `VACUUM`, `PRAGMA`, `load_extension` or the host's `_gc_*`
tables are refused. The plugin process can write only the sibling `files/`
folder, never the database file.

**A larger database** (since 1.206.0) — for plugins that keep many records
(GateControl Drive: hundreds of thousands of files with their versions):

```json
"permissions": { "storage": true },
"storage": { "maxMB": 4096 }
```

`storage.maxMB` 256 … 4096 (default 256), only together with
`permissions.storage` (`storage: needs permissions.storage` otherwise). The
limit applies from the install or update of that version on, its migrations
included; an open connection with another limit is reopened (SQLite never
shrinks below what is used — a smaller limit only stops further growth). The
plugin's overview shows the size of its data and "Datenbank bis …"
(`GET /api/v1/plugins/<id>` → `storageBytes`, `storageDbMaxBytes`). A database
larger than the plugins' share of a GateControl backup (see "Backup") is left
out of it and logged — such a plugin keeps its own copy (Drive: its external
backup).

Migrations (`migrations/NNN_name.sql`) run on install and update in a single
transaction, in order, recorded in the plugin's database; a failing migration
leaves the installed version untouched.

Layout: code `<data>/plugins/<id>/<version>/`, data `<data>/plugin-data/<id>/`
(`db/` host-owned, `files/` plugin-writable).

## Isolation

Every running plugin is a child process (`child_process.fork` of
`src/services/plugins/child/bootstrap.js`) with Node's permission model:

* `--permission`, `--allow-fs-read` = the bootstrap file, the plugin's code
  folder and its `files/` folder; `--allow-fs-write` = `files/` only; no child
  processes, worker threads, addons, inspector or WASI;
* `--no-experimental-sqlite` (node:sqlite does not honour the permission
  model), `--max-old-space-size=128`, `--disable-sigusr1`;
* an empty environment (`NODE_ENV`, `GC_PLUGIN_ID`, `TZ` — no secrets, no
  database path).

Before the plugin's code runs the bootstrap also closes in JavaScript what the
permission model does not cover: `process.kill` to other processes and
`process._debugProcess` (SIGUSR1 would open the server's inspector — the
server additionally runs with `--disable-sigusr1`), `process.binding`,
`dlopen`, `execve`, a deny list of built-in modules (also for `import()`), and
the connecting functions of `net`, `tls`, `dgram`, `http`, `https`, `http2`,
`fetch`, `WebSocket`.

**Known limitation:** Node's permission model has no network permission (as
of Node 22/24). The JavaScript lockdown above is defence in depth, not a
boundary a determined plugin could never get around; the network allowlist is
enforced for everything that goes through the host API. Signed plugins are
reviewed code; for unsigned plugins this is part of the warning shown when
they are allowed.

A crashed process is restarted with backoff (1 s … 5 min), a process that
stops answering pings is killed and restarted, every process is stopped on
disable/uninstall and when the server shuts down.

## User interface

* **Sidebar** "Integrationen": one entry per installed plugin with `ui.nav`
  (Smart Home, Klimaanlage, Fahrzeuge … are plugins); one that
  is not running stays listed, greyed, tagged *aus*. Its page then explains why
  ("… ist derzeit deaktiviert (Grund). Deine Daten sind gespeichert." with a
  link to the plugin's page in the plugin area for administrators).
* **Pages and portal tab**: plugin HTML is untrusted, so it never becomes part
  of a GateControl page. It is served on its own URL (`/plugins/<id>/frame/<page>`,
  `/portal/plugins/<id>/frame`) with `Content-Security-Policy: sandbox
  allow-scripts allow-forms; connect-src 'none'; form-action 'none'; …` and
  shown in an `<iframe sandbox="allow-scripts allow-forms">` (no
  `allow-same-origin`): an opaque origin without cookies, storage or access to
  the page, even when the URL is opened directly (a plugin declaring `media`
  adds `allow-downloads` to both, see "Media"). The frame talks to its
  plugin's API through the parent page (`window.GC.call()` inside the frame →
  `postMessage` → `public/js/plugin-bridge.js`, which only accepts messages of
  that frame and only calls that plugin's API base with the user's session and
  CSRF token). Chosen over a declarative JSON UI because it is general enough
  for the existing Smart Home / Klimaanlage / Fahrzeuge pages.
  `window.GC.navigate(pageId)` opens another of the plugin's pages and (since
  1.185.0) `window.GC.openSettings()` its settings tab (Einstellungen ›
  Plugins › the plugin › Einstellungen) — both on admin pages only, never
  from the portal.
* **Downloads** (since 1.186.0): `await GC.saveFile(blob, 'Fahrtenbuch
  2026-10.csv')` hands a `Blob` the frame built (e.g. from an answer of
  `GC.call`) to the parent page, which offers it as a download from its own
  document — any plugin, admin page and portal alike, no `media` needed (the
  frame's sandbox stays without `allow-downloads`). The page takes only these
  types (the Blob's `type`, parameters such as `;charset=utf-8` ignored):
  `text/csv`, `application/pdf`, `text/plain`, `application/json`,
  `image/png`, `image/jpeg`, `text/calendar`; 1 byte … 20 MB; one download per
  1.5 s and frame. The name keeps letters (umlauts too), digits, space and
  `. _ ( ) -` (anything else → `_`, a path is cut off, ≤ 100 characters) and
  always ends in the type's extension (`.csv`, `.pdf`, `.txt`, `.json`,
  `.png`, `.jpg`, `.ics`). → `{ ok: true, name }`; a refusal rejects with
  `status` 400 (type, size) or 429 (too fast). A plugin answer is JSON of at
  most 1 MB — return a file as text or base64 and build the Blob in the frame
  (`new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type })`).
* **Page title**: GateControl shows a page's title once, in its header (the
  topbar: the plugin's `ui.nav.label`, else its name) — the page's only
  `<h1>`. The host adds no heading of its own above the frame; above it there
  is only a slim row with the page tabs (more than one `ui.pages` entry; a
  page's `title` is its tab label and the frame's accessible name), the
  version / signature chips and the settings link. A plugin page therefore
  **must not render its own page title, subtitle or eyebrow** (no
  "Klimaanlage — Geräte steuern" block at the top of the frame): it starts
  with its content (toolbar, tiles, lists). Headings inside the content
  (`<h2>` and below, for cards and sections) are fine, and so is a line of
  live data (counts, status) as long as it does not repeat the title.
* **Profile pictures** (since 1.168.0, docs/feature-avatars.md): every frame
  (admin page, portal tab and section, wall) may show the users' pictures —
  the frame CSP has `img-src data: <origin>/avatars/` (`<origin>` = scheme +
  Host header of the frame request; only this path of the server, a Host that
  is not a plain `host[:port]` gets no origin and no pictures). Use the
  `avatarUrl` of `gc.users` as it is (`<img src="/avatars/…">` — the frame's
  URL base is that origin); without a picture draw `initials` on `colorHex`
  (white text). The pictures need no cookie and are sent with
  `Cross-Origin-Resource-Policy: cross-origin` and
  `Cache-Control: public, max-age=31536000, immutable` (a new picture has a
  new URL). Ring colours for presence: at home = `colorHex`, away = `#E5484D`,
  unknown = a neutral border.
* **Settings**: declared `ui.settings` are rendered by GateControl
  (Einstellungen tab) — no plugin HTML in the settings page. Since 1.185.0
  `ui.settingsGroups` (≤ 10: `id` `[a-z][a-z0-9_-]{0,31}`, `label`, optional
  `help`) give the form headings, in that order; a setting joins one with
  `group` (an unknown group is an invalid manifest), settings without a group
  stand above the first heading. The optional hook `settingsStatus({ lang })`
  answers status lines `[{ group, tone, text }]` — `tone` `ok` | `info` |
  `warn` | `error`, `text` ≤ 200 characters (plain text), `group` one of the
  groups or `null` for above the form, at most 10 lines, within 3 s — shown
  when the form opens and after saving. Saving waits up to 20 s for
  `settingsChanged`, so an account the plugin signs in to there shows the
  outcome right away (e.g. "Verbunden als …" or "Anmeldung fehlgeschlagen").
  Accounts and other credentials belong here, not on the plugin's own page.
  A settings UI a form cannot express (several accounts, scanning a QR code,
  mapping people) is a plugin page named `ui.settingsPage` (since 1.188.0):
  GateControl shows its frame in this tab, above the declared settings
  (see "plugin.json").
* **Portal** (`src/services/plugins/portal.js`), for identified viewers only:
  * **own tab**: `ui.portal.label`/`icon` → a tab `plg-<id>` with the plugin's
    frame (`/portal/plugins/<id>/frame`).
  * **sections in GateControl tabs**: `ui.portal.sections: [{ id, tab, title,
    order }]` (≤ 8; `tab` = `home` ("Zuhause") or `car` ("Fahrzeug"); `order`
    0–1000, default 100) → each section is its own sandboxed frame
    (`/portal/plugins/<id>/frame?section=<id>`, `render` gets
    `view.section`) inside that tab, ordered by `order`. "Zuhause" and
    "Fahrzeug" hold plugin sections only; several plugins share one tab, and
    the tab is hidden when no section has something for the viewer.
    `ui.portal` needs a label, sections or both.
  * **profile sections** (since 1.188.0): `ui.portal.profileSections: [{ id,
    title, order }]` (≤ 4; ids like sections, unique together with
    `sections`; no `tab`) → each section is its own sandboxed frame
    (`/portal/plugins/<id>/frame?section=<id>`, `render` gets
    `view.section`) on the viewer's **own profile** in the portal ("Meine
    Geräte", below the profile picture and favourite colour), ordered by
    `order` — e.g. "link your own account of a service to your GateControl
    account". Only for a signed-in person (`user.loggedIn`), never on a kiosk
    device or for a viewer only recognised by device trust (the frame URL
    answers 403 there, `portalVisible` is not even asked). Internally (the
    install dialog, `portalVisible({ section })`, tiles naming the section)
    they are sections of the tab `profile`. A section only ever shows the
    viewer's own things: the plugin's portal API gets the same viewer — let
    it change only what belongs to that person. An older GateControl ignores
    the key (the plugin still installs; there is no profile section).
  * **visibility**: the optional hook `portalVisible({ user, lang, section })`
    (`section` = null for the own tab) hides a tab/section for viewers with
    nothing to see. Asked per viewer when the portal is opened.
  * **Start tiles**: optional hook `portalTiles({ user, lang })` →
    `[{ section?, title, value?, unit?, state?, icon?, items? }]` (≤ 8; `items`
    only for the apps, see "Start tiles in the apps"; `state` one of
    `on`, `off`, `good`, `warn`, `crit`; `icon` an SVG path like
    `ui.nav.icon`). GateControl renders them on the Start tab — in the
    "Zuhause"/"Fahrzeug" card for sections (shown once a tile arrives), in a
    card of its own for the plugin's tab — and links them to the section (`#zuhause` + scroll). Never
    plugin HTML on Start. `GET /api/v1/portal/plugins/start`.
    The same tiles are also shown in the apps' start card via
    `GET /api/v1/client/tiles` (see "Start tiles in the apps" below) — asked
    with the app's viewer (`app: true`), so answer only what that person may see.
  * **QR codes, a hidden line and an end on Start** (since 1.197.0; the
    portal's Start tab only — the apps' start card and search never get them):
    a tile may add
    * `qr` — text of 1–512 characters without control characters (e.g. a
      Wi-Fi code `WIFI:T:WPA;S:…;P:…;;`). GateControl draws it on the server
      as a QR code (PNG, dark on white in every theme) and sends the portal
      only the picture (`qrImage`, a `data:image/png` URL), never the text;
    * `secret` — `{ label, value }` (label ≤ 30, value 1–128 characters, no
      control characters): a line shown as `••••••••` until the viewer taps
      "Anzeigen" (e.g. the Wi-Fi password);
    * `until` — an ISO time: the tile shows the time left ("noch 4:59") and
      the portal drops it then; a time already past drops the tile at once,
      one more than 400 days ahead is ignored.

    Such a tile is a card across the Start card's width (title linked like
    any tile, the picture ~200 px, the line, the countdown). An unchanged
    answer leaves the cards as they are.
  * **The open Start tab stays current** (since 1.198.0): there is no live
    channel for Start, so the portal asks for every plugin's tiles again
    every minute while the page is visible and Start is the open tab, and at
    once when the page or the Start tab comes back into view (at most once
    per 15 s; never two requests at a time; a hidden page or another tab asks
    nothing). A tile a plugin starts or stops sending shows or goes within a
    minute — keep `portalTiles` cheap (it runs about once a minute per open
    Start tab, within the plugin API's rate limit). An
    invalid extra is dropped, never the tile. Everything on a tile is visible
    to whoever looks at that screen — answer it only for viewers that may see
    it (e.g. `user.loggedIn === true`, not `user.kiosk`, not `user.app`).
  * **search**: optional hook `portalSearch({ user, lang, q })` (`q` 2–100
    characters) → `[{ title, subtitle?, section? }]` (≤ 10), shown after the
    portal's own results (services, devices), linked like the tiles. `GET /api/v1/portal/plugins/search?q=`.
  * Every hook has **1.5 s** per plugin (all plugins in parallel); a slow,
    failing or garbage-answering plugin only loses its own part. Texts are
    capped and control characters removed; a tile/result naming a section
    the viewer cannot see is dropped. The hooks get the viewer and must only
    answer with what that person may see (the host passes nobody else).
* **Quick actions** (`src/services/plugins/quickActions.js`): see "Quick
  actions" below — declarative actions for the apps' home-screen shortcuts,
  Quick Settings tiles and widget.
* **App tab** (`ui.app`): the apps draw the plugin's screens themselves from
  its client API — see "App". No plugin HTML in the apps.
* **Maps** (`ui.maps`): the plugin's frames may show an OpenStreetMap map with
  the host's Leaflet and the tiles through GateControl (`window.GC.tiles`) and
  open links in a new tab — see "Maps".
* **Uploads** (`media`): `window.GC.upload(fileOrBlob, { onProgress })` →
  `{ mediaId, mime, bytes }` (the parent page uploads with the session), media
  shown through `gc.media.url` URLs, microphone allowed — see "Media".
* **Live updates** (`permissions.events`): `window.GC.on('event', fn)` /
  `GC.off` — see "Realtime events".
* **Location** (`ui.geolocation`, since 1.179.0): the frame's `<iframe>` has
  `allow="geolocation *"`, so `navigator.geolocation.getCurrentPosition()`
  works after the person agrees in the browser (asked for GateControl's
  origin; the frame needs a secure context, i.e. GateControl on HTTPS). Check
  `document.featurePolicy.allowsFeature('geolocation')` where the browser has
  it, and always handle the error callback — an older GateControl, a browser
  that refuses sandboxed frames or a "no" from the person all end there.
* **Inbox** (`ui.inbox`, portal frames only, since 1.179.0):
  `window.GC.inbox.on(fn)` calls `fn({ available, unread, latest })` with the
  viewer's own inbox — `latest` = `{ title, createdAt, priority }` of the
  newest notification or null — first when subscribing and again whenever the
  portal's bell changes (it polls every minute); `GC.inbox.off(fn)` stops,
  `GC.inbox.open()` shows the portal's inbox (`#mitteilungen`). This is the
  portal page's own state handed on by `plugin-bridge.js` (DOM events
  `gc:inbox`, `gc:inbox-request`, `gc:inbox-open` between `portal.js` and the
  bridge): never bodies, data or ids of notifications, never another person's
  inbox, nothing to change (reading happens in the portal's inbox).
  `available: false` without the flag, on the admin pages and in a portal
  without the notification center — hide the entry then. `GC.inbox` is
  missing on GateControl before 1.179.0: feature-detect it.
* **QR codes** (`ui.scanQr`, or the older `ui.camera`; since 1.196.0):
  `const { text, code } = await GC.scanQr({ hint, accept, timeout })` —
  GateControl's page (its own origin, a secure context) shows its camera
  dialog: the preview with a frame, "Kamera wechseln" when there are several
  cameras, "Abbrechen", the plugin's name and `hint`. It reads QR codes with
  the browser's `BarcodeDetector` where there is one (Android, macOS), else
  with the host's vendored jsQR 1.4.0 (`public/vendor/jsqr`, Apache-2.0,
  loaded only then), and answers only the text — the picture never leaves
  the page, and the camera stops the moment there is a result, a cancel, a
  timeout or the page is hidden. Admin pages, the settings page frame and
  portal tabs and sections alike.
  * `hint`: a line of text shown below the preview (≤ 200 characters, plain
    text).
  * `accept`: a prefix or a list of ≤ 8 prefixes (1–100 characters,
    case-insensitive), e.g. `['otpauth://', 'otpauth-migration://']` or
    `'untis://setschool?'` — other codes keep the dialog open with "Dieser
    QR-Code passt hier nicht …". Without `accept` any code is answered.
  * `timeout`: seconds, 10–600, default 120.
  * The promise never rejects. `text` is the code's content (≤ 4096
    characters) or `null`; `code` is `null` on success, else `cancelled`
    (Abbrechen, Escape), `timeout`, `hidden` (the page or the frame's portal
    tab went out of view), `denied` (the person or the browser refused the
    camera), `no_camera`, `camera_error` (e.g. in use by another app),
    `insecure` (GateControl not on HTTPS — the camera needs a secure context;
    `http://localhost` counts as one), `unsupported`, `decoder_error`,
    `busy` (another scan is open on the page), `rate_limited` (one start per
    1.5 s per frame), `no_gesture`, `invalid` (bad `accept`), `not_allowed`
    (the plugin has neither key). On the errors the dialog shows the reason
    until the person closes it; then the promise resolves.
  * Call it from a click handler: the click's user activation reaches
    GateControl's page and the camera starts at once. A call without a click
    (e.g. on load) shows the dialog with "Kamera starten" first, and a
    repeat within 10 s answers `no_gesture`.
  * One scan at a time on the page, only while the page and the frame are
    visible. Check `typeof GC.scanQr === 'function'` and keep another way for
    older hosts (a picture upload decoded in the frame, manual entry).
* **Groups and people** (`permissions.groups`): `const list = await
  GC.pickPrincipals({ groups: true, users: true, multiple: true, title })` —
  GateControl's own picker (search, chips) on the parent page; see "Groups".
* **Viewport** (since 1.199.0): a frame grows with its content; to fill the
  screen instead (a dashboard, the Familie wall tablet), it can take the
  height it has without the page scrolling — the window's height minus what
  stands above the frame and below it on the page. GateControl tells every
  frame on load, on a new document, when the window is resized and when the
  page around the frame changes (a banner above, the frame shown in another
  tab), only when the value changes: `window.GC.viewport` → `{ height, width }`
  (px; `null` until known — an older GateControl never sets it), the CSS
  variable `--gc-viewport-height` on the frame's root and a `gc:viewport`
  event on `window` (`detail` = the same object). Use it with a fallback,
  e.g. `height: var(--gc-viewport-height, 640px)`; at least 200 px. A kiosk
  device's portal has no footer and a short bottom margin, so a wall gets
  as much of the screen as possible.
* Sandboxed frames have no `alert`/`confirm`/`prompt` (no `allow-modals`):
  plugins draw their own dialogs. The frame grows with its content and with
  an open dialog (visible `position: fixed` elements count with their full
  height) and shrinks again. A dialog drawn as a fixed backdrop covering the
  frame (e.g. `.modal-overlay { position: fixed; inset: 0 }`) makes
  GateControl dim its own page around the frame as well, so the dialog reads
  as one of the whole page.

## Quick actions

Plugins can offer small actions to the GateControl apps — Android home-screen
shortcuts, Quick Settings tiles and the widget (light on/off, start a scene,
open the garage …). Like the Start tiles they are declarative data: the apps
render them, never plugin HTML.

```js
async quickActions({ user, lang }, gc) {
  // ≤ 16 entries
  return [
    { id: 'light:3', title: 'Wohnzimmer', subtitle: 'Licht', icon: 'M4 12h16', kind: 'toggle', state: 'on' },
    { id: 'scene:evening', title: 'Abend', kind: 'button', confirm: true },
  ];
},
async runQuickAction({ user, lang, id, via, automation, control, value, target }, gc) {
  // via: 'app' | 'notification' | '<plugin id>' (gc.actions.run); automation: true only for gc.actions.run without interactive
  // control / value: only when the app moved a control of the action's widget (see "Widgets")
  // target: 'on' | 'off' only for a toggle declaring targets: true (see "Target states")
  return { ok: true, message: 'Licht eingeschaltet', state: 'on' };   // state optional (new toggle state)
},
```

* **Who is asked**: plugins that may run (enabled, compatible, signed or
  allowed, licensed), are running and have **`permissions.portal`** — the
  actions run as the identified viewer, like the portal hooks. There is no
  permission of their own. A plugin without the hooks has no actions.
* **Viewer**: the owner of the app's API token as
  `user = { id, name, role, portal: true, loggedIn: true, app: true }` — the
  shape the portal hooks get. `loggedIn` is `true` because a (machine-bound)
  device token of that person is a real credential, unlike device trust in
  the portal; `app: true` tells the plugin the call comes from an app. A
  token without an owner gets no actions (and 403 for a run). The hooks must
  only list and run what that person may see and do.
* **`quickActions`** — 1.5 s per plugin, all plugins in parallel; a slow,
  failing or garbage-answering plugin only loses its own actions. At most 16
  per plugin; each entry is validated and an invalid one dropped:
  * `id` `[A-Za-z0-9:._-]{1,64}`, unique per plugin (later duplicates dropped);
  * `title` (required, ≤ 40 characters), `subtitle` (≤ 60) — control
    characters removed;
  * `icon`: an SVG path like `ui.nav.icon` (path characters only, ≤ 2000),
    otherwise `null`;
  * `kind`: `button` (default) or `toggle`; any other value drops the entry;
  * `state`: `on`/`off`, toggles only (otherwise `null`);
  * `confirm`: `true` → the app asks before running it (default `false`);
  * `confirmWhen`: toggles only, `'on'` or `'off'` — the app asks only before
    switching *into* that state (e.g. a lock: only before unlocking);
    otherwise `null`, buttons always `null`. Independent of `confirm` — set
    `confirm: true` as well for older apps, which only know `confirm`;
  * `look`: toggles only, how each state looks — see "Devices and looks"
    below (`null` without one, buttons always `null`);
  * `verbs` / `targets`: toggles only, what setting each state is called and
    whether the plugin honours an explicit `target` — see "Target states"
    below (`null` / `false` without them, buttons always `null` / `false`);
  * `device`: optional, the device the action belongs to — see "Devices and
    looks" below (`null` without one or with an invalid one, the action stays);
  * `widget`: optional, see "Widgets" below — anything invalid in it makes the
    whole `widget` `null`, the action stays;
  * `opens` (1.189.0): optional `{ screen, ref? }` — a page of the apps the
    action stands for. An app that has that native screen for the plugin
    opens it with `ref` when the action is tapped (button, widget, home-screen
    widget, shortcut) instead of running it; an app without it runs the action
    as before, so `runQuickAction` should still answer something sensible
    (e.g. a message where to find the page). `screen`: a lowercase word
    (`[a-z][a-z0-9_-]`, ≤ 40), `ref`: ≤ 80 characters (e.g. a vehicle id);
    invalid → `null`. Screens the Android app knows: `gatecontrol-skoda` +
    `logbook` (ref: the vehicle id) — the logbook with its maps (app 1.56).
* **`runQuickAction`** — 10 s, only for an id the plugin currently lists for
  that viewer: the host asks that plugin's `quickActions` first (1.5 s) and
  answers 404 for anything else. The answer is sanitised to
  `{ ok, message, state, widget, unchanged }`: `ok` is `false` only when the
  plugin says `ok: false`, `message` ≤ 120 characters (or `null`), `state`
  `on`/`off` (or `null`), `widget` like a listed one (or `null`),
  `unchanged` `false` (`true` only when the host skipped a run with `state`,
  see "Target states"). Every run is an activity log entry
  `plugin_quick_action` (info, details
  `{ plugin, action, userId, ok, via, control?, state?, unchanged? }` — no
  text of the plugin, no value).
* **Who started it** — `runQuickAction` also gets:
  * `via`: `'app'` (shortcut, tile, widget or an app screen — the default),
    `'notification'` (the `quick_action` button of a push, see
    "Notifications") or the id of the plugin that ran it with
    `gc.actions.run` (see below);
  * `automation`: `true` only for `gc.actions.run` without `interactive`
    (another plugin ran it for the user, nobody tapped anything), `false`
    for every run a person started — in the apps, or (since 1.180.0) in
    another plugin's UI with `gc.actions.run({ …, interactive: true })`;
    then `user.interactive` is `true` and `via` the id of that plugin. A plugin tells a person's run from an automation by
    `automation` (not by `via` alone — a plugin id could look like anything).
* **Language** `lang` (`de`/`en`): `?lang=` of the request, else the owner's
  language setting, else `Accept-Language`, else `de`.

Client API (`src/routes/api/client/actions.js`): API token with scope
`client` or `full-access`, machine binding like the other `/api/v1/client/*`
routes (a browser session gets 403 `token_required`), `Cache-Control: no-store`.

```
GET  /api/v1/client/actions
  200 { ok: true, actions: [{ plugin: '<plugin id>', pluginName: '<localised name>',
                              id, title, subtitle, icon, kind, state, confirm,
                              confirmWhen, look, verbs, targets, device, widget, opens }] }

POST /api/v1/client/actions/:plugin/:id        (≤ 30 runs per minute and token)
  body { source?: 'app' | 'notification',      (default 'app'; → via of runQuickAction)
         control?: string, value?: number | string,   (a control of the widget, see "Widgets")
         state?: 'on' | 'off' }                (the state a toggle should end in, see "Target states")
  200 { ok, message, state, widget, unchanged }
  400 { ok: false, error: 'invalid_source' }   source not 'app' / 'notification'
  400 { ok: false, error: 'invalid_state' }    state not 'on' / 'off', on a button, or with control
  400 { ok: false, error: 'invalid_control' }  control is not a control of the action's widget
  400 { ok: false, error: 'invalid_value' }    value not acceptable for that control
  403 { ok: false, error: 'no_user' }          token without an owner
  404 { ok: false, error: 'not_found' }        unknown plugin / action
  409 { ok: false, error: 'state_unknown' }    state for a toggle without targets that lists no state
  502 { ok: false, error: 'plugin_error' }     the plugin failed or answered garbage
  504 { ok: false, error: 'timeout' }          no answer in time
  429 { ok: false, error: 'rate_limited' }
```

A toggle's new `state` comes with the run's answer; the apps reload the list
when they show their shortcuts, tiles or widget.

Every key is always present in the listed actions — `null` (or `false` for
`confirm` and `targets`) when the plugin did not send it or sent something
invalid.

### Devices and looks

The apps list quick actions per **device** — one row per car, air
conditioner, lamp or lock, with that device's actions and its widget. An
action names its device with `device`; actions of a plugin with the same
`device.id` belong together, an action without `device` is a device of its
own. Repeat the same `device` object in every action of the device.

```js
// a car: one lock toggle (locked = on) and the climate action carrying the widget
const car = { id: 'v:42', title: 'Familienauto', subtitle: 'Enyaq', icon: CAR_ICON };
[
  { id: 'lock:42', title: 'Verriegelt', kind: 'toggle', state: 'on', device: car,
    confirm: true, confirmWhen: 'off',                     // ask before unlocking only
    look: { on: { icon: LOCK_CLOSED, tone: 'good' }, off: { icon: LOCK_OPEN, tone: 'crit' } } },
  { id: 'climate:42', title: 'Klimatisierung', kind: 'toggle', state: 'off', device: car,
    widget: { label: 'Ladestand', value: 81, unit: '%', power: false,
              readings: [{ id: 'range', label: 'Reichweite', value: 312, unit: 'km', icon: ROUTE_ICON }] } },
]
```

* `device`: `{ id, title, subtitle?, icon? }` — `id` `[A-Za-z0-9:._-]{1,64}`,
  `title` required (≤ 40), `subtitle` ≤ 60, `icon` an SVG path like the
  action's `icon` (otherwise `null`). Anything invalid (no or a bad `id`, no
  `title`) → `device: null`, the action stays. The answer always has all four
  keys: `{ id, title, subtitle, icon }`.
* `look` (toggles only): `{ on?: { icon?, tone? }, off?: { icon?, tone? } }`
  — the icon and colour the app shows for each state instead of the action's
  `icon` (e.g. a lock: on = locked, a green closed padlock; off = unlocked, a
  red open padlock). `tone` is `good`, `warn`, `crit` or `neutral`; `icon` an
  SVG path like the action's `icon`. The answer is
  `{ on: { icon, tone } | null, off: { icon, tone } | null }` (a missing key
  `null`); a part with neither a valid icon nor a valid tone is `null`, and
  `look` is `null` when both parts are (and always for buttons).
* `confirmWhen` (toggles only): see above.

Older hosts drop the three fields; older apps ignore them.

### Target states

Running a toggle flips it. A rule ("everyone away → lock the car") or an app
screen with two buttons needs a fixed state instead — running "lock" must
never unlock an already locked car. A run can therefore say which state it
wants: `state: 'on' | 'off'` (client API body, `gc.actions.run`; since
1.173.0). Two optional fields of a toggle (buttons always get `null` /
`false`) tell the apps and other plugins how to offer that:

```js
{ id: 'lock:42', title: 'Schloss', kind: 'toggle', state: 'on',
  verbs: { on: 'Verriegeln', off: 'Entriegeln' },   // the command that sets each state
  targets: true }                                    // runQuickAction honours `target`

async runQuickAction({ user, lang, id, target }, gc) {
  const car = await this.car(id);
  const lock = target ? target === 'on' : !car.locked;   // a target is set, never flipped
  await (lock ? car.lock() : car.unlock());              // idempotent: locked + 'on' → lock again
  return { ok: true, state: lock ? 'on' : 'off' };
},
```

* `verbs`: `{ on, off }` — what setting each state is called as a command
  ("Verriegeln" / "Entriegeln", "Einschalten" / "Ausschalten"), shown by the
  apps on the two target buttons and by rules ("Elroq – Schloss:
  Verriegeln"). Each a string, trimmed, 1–20 characters, no control
  characters; both are required — anything else makes `verbs` `null`. Answer
  in the viewer's `lang`.
* `targets`: `true` → the plugin honours an explicit `target` in
  `runQuickAction`: it sets exactly that state (also when the device is
  already in it — e.g. send the lock command again) and never flips.
  Anything but `true` is `false`.
* **A run with `state`** (only for a toggle — on a button, with `control` or
  with any other value: 400 `invalid_state`, nothing runs):
  * the action has `targets: true` → `runQuickAction` gets
    `target: 'on' | 'off'` next to `id`, `via`, `automation` … and answers as
    usual (`unchanged: false`);
  * the action has no `targets` — the host's fallback for plugins that do
    not know targets, by the state the plugin lists at that moment:
    * listed `state` is the requested one → the plugin is **not** asked; 200
      `{ ok: true, message: null, state, widget, unchanged: true }` (`widget`
      the listed one);
    * listed `state` is the other one → the plain run (a flip reaches the
      target), no `target` in the payload, `unchanged: false`;
    * listed `state` `null` (unknown) → 409 `{ ok: false, error:
      'state_unknown' }`, nothing runs.
* A run without `state` (or `state: null`) is the plain run — a toggle flips,
  no `target` key in the payload. `unchanged` is `false` in every answer the
  plugin gave.
* Rate limit, activity log (`state` and `unchanged: true` in the details)
  and `via` / `automation` as for any run; a refused run (400) is not logged,
  a 409 is (`ok: false`).

Older hosts drop `verbs` / `targets` and ignore `state` (a plain flip) —
plugins and apps that rely on target states require 1.173.0.

### Widgets

A widget is a quick action with extra information and controls — there is no
second concept. Any `quickActions` entry may carry a `widget` object; the
apps then let the person pin that action to their Start tab as a card with a
large value, a status line and controls instead of a small button. Older
hosts drop the field, older apps ignore it.

```js
// an air conditioner: temperature, status, a target stepper and a mode choice
{ id: 'ac:7', title: 'Wohnzimmer', subtitle: 'Klima', kind: 'toggle', state: 'on',
  widget: {
    label: 'Innentemperatur',                    // ≤ 24, the name of the large value
    value: '21,5', unit: '°C',                  // large display: a string ≤ 24 or a finite number
    status: 'Kühlen · Ziel 22 °C',               // ≤ 60, small line under the value
    state: 'on',                                 // 'on' | 'off' | 'good' | 'warn' | 'crit' (colour of the card)
    readings: [                                  // ≤ 4 extra values, ids unique per widget
      { id: 'outdoor', label: 'Außen', value: 12.5, unit: '°C', icon: THERMOMETER_ICON },
    ],
    controls: [                                  // ≤ 4, ids unique per widget
      { id: 'target', kind: 'stepper', label: 'Ziel', value: 22, min: 16, max: 30, step: 0.5, unit: '°C' },
      { id: 'mode', kind: 'choice', label: 'Modus', value: 'cool',
        options: [{ id: 'auto', label: 'Auto', icon: AUTO_ICON },   // icon optional, an SVG path
                  { id: 'cool', label: 'Kühlen', icon: SNOWFLAKE_ICON },
                  { id: 'heat', label: 'Heizen', icon: FLAME_ICON }] },
    ],
    power: true,                                 // the toggle is the device's on/off switch (default)
    badge: { icon: FILTER_ICON, value: 92, unit: '%', state: 'good', label: 'Filter 92 %' },
  } }
```

* `value`: a string (≤ 24 characters, control characters removed — format
  numbers yourself, e.g. with `toLocaleString`) or a finite number; anything
  else → `null`. `unit` ≤ 8, `status` ≤ 60, `state` one of the five values
  (otherwise `null`). All optional.
* `label` (≤ 24, optional, otherwise `null`): the name of the large value —
  the apps show it when the person picks what the card shows ("Ladestand",
  "Innentemperatur").
* `icon` (optional, GateControl ≥ 1.187): an SVG path like the action's `icon`,
  shown small beside the large value instead of a text — e.g. a calendar for
  "this month". An invalid one becomes `null`; the widget stays. Apps that do
  not know it show `label` as before.
* `readings` (≤ 4, optional): smaller values beside the large one, each
  `{ id, label, value?, unit?, icon?, state? }` — `id` like a control id and
  unique among the readings, `label` required (≤ 20), `value` a string
  (≤ 16) or a finite number (otherwise `null`), `unit` ≤ 8, `icon` an SVG
  path like the action's `icon`, `state` one of the five widget states (or
  `null`). A reading needs a `value` or an `icon` (e.g. a padlock without a
  value). Unlike everything else in a widget, an invalid reading is only
  dropped — the widget stays; a later reading with an id already seen is
  dropped as well, and only the first 4 valid ones are kept. The answer is
  always a list (`[]` without readings), each reading with all six keys.
* `power` (boolean, default `true`): the action's toggle is the device's
  on/off switch, shown in the card's header. `false`: the action is shown
  like the device's other actions, as a button (e.g. a car's climate action
  carrying the car's widget). Anything but `false` is `true`.
* A widget with only `readings` (no value, status or controls) is valid.
* A widget without a `value` (missing or invalid → `value: null`) is valid
  as well; the apps then show **no** main value (not a dash) — e.g. a card
  that only carries a status, readings, controls or a badge.
* `badge` (optional): one small value the apps show in the card's **head,
  right of the device name** — e.g. a car's battery as a battery icon and
  "24 %". `{ icon, value?, unit?, state?, label? }`:
  * `icon` (required): an SVG path like the action's `icon`; a missing or
    invalid icon makes the whole badge `null`.
  * `value`: a string (trimmed, 1–8 characters, no control characters) or
    a finite number (format it yourself for a decimal comma); anything
    else → `null` — a string that is too long or contains a control
    character becomes `null`, it is **not** cut. An icon without a value is
    a valid badge.
  * `unit`: a string (trimmed, 1–4 characters, no control characters), only
    with a value (without a value → `null`).
  * `state`: `'good'` | `'warn'` | `'crit'` (the colour), otherwise `null`.
  * `label`: a string (trimmed, 1–20 characters, no control characters),
    the accessible name for screen readers ("Akku 24 %"), otherwise `null`.

  An invalid field becomes `null`; an invalid badge becomes `badge: null` —
  it never makes the widget `null`. A sanitised badge always has all five
  keys: `{ icon, value, unit, state, label }`.
* `controls` (≤ 4, optional): `id` `[A-Za-z0-9_-]{1,24}` and unique per
  widget, `kind` `stepper`, `slider` or `choice`, `label` ≤ 20 (optional).
  * `stepper` / `slider`: `value`, `min`, `max`, `step` finite numbers with
    `min < max` and `step > 0`; `value` is clamped into `[min, max]`;
    `unit` ≤ 8 (optional).
  * `choice`: `options: [{ id, label, icon? }]`, 2–8 of them (ids like a
    control id, unique; `label` required, ≤ 20; `icon` optional, SVG path
    data `d` for a 24×24 viewBox like the action's `icon` — an invalid icon
    becomes `null`, the option stays; a sanitised option always has all
    three keys); `value` is an option id — any other value becomes the first
    option. The apps draw the options as icon buttons (the label as the
    accessible name) and fall back to the label for an option without an
    icon.
* Anything invalid (a bad control, too many of them, duplicate ids …) makes
  the whole `widget` `null` in the host's answer; the action itself stays.
  An entry without a `widget` lists `widget: null` as well.
* A sanitised widget always has every key:
  `{ label, value, unit, status, state, readings, controls, power, badge }`
  (`badge` is `null` without a valid one).
* **One widget per device**: when a device has several actions, give the
  `widget` to one of them (the device's "carrier"); control runs go to that
  action. The apps build the card from the carrier's widget and the
  device's other actions.

**Control runs.** When the person moves a control, the app runs the action
with `control` (the control's id) and `value` in the body. The host looks
the control up in the widget the plugin lists for that action at that
moment and validates the value — a finite number within `[min, max]` for a
stepper / slider, one of the option ids for a choice — and answers 400
`invalid_control` / `invalid_value` otherwise; nothing reaches the plugin
then. A valid run reaches `runQuickAction` with `control` and `value` (the
validated number or option id); a plain run (tap, tile, shortcut,
notification, `gc.actions.run`) has neither — `control` is `undefined`,
so a plugin can tell the two apart. `gc.actions.run` never sends a control:
other plugins only trigger actions, they do not move controls.

```js
async runQuickAction({ user, lang, id, control, value }, gc) {
  const d = await this.device(id);
  if (control === 'target') await d.set({ targetTemp: value });       // value: a number in 16..30
  else if (control === 'mode') await d.set({ mode: value });           // value: 'auto' | 'cool' | 'heat'
  else await d.set({ power: !d.power });                               // the plain run: toggle
  return { ok: true, state: d.power ? 'on' : 'off', widget: this.widgetOf(d, lang) };
},
```

The answer's `widget` (same format as in the list, sanitised the same way,
`null` when missing or invalid) lets the app show the new state at once
without reloading the list. The activity log entry of a control run carries
the control's id in `details.control`, never the value.

### Start tiles in the apps

The start card of the Android app slides through the plugins' Start tiles
(hook `portalTiles`, see "Portal" above) — e.g. a vehicle's charge level, the
next waste collection, a smart home sensor. The person picks which tiles the
card shows and in which order; the app remembers that by each tile's `key`.

* **Which tiles**: exactly what the portal's Start tab would show the token's
  owner — the same plugins (may run, running, `permissions.portal` and
  `ui.portal`), `portalVisible` per tab/section, a tile naming a section the
  viewer cannot see dropped, 1.5 s per plugin (a slow, failing or
  garbage-answering plugin only loses its own tiles), at most 8 per plugin,
  `title` ≤ 60, `value` ≤ 40, `unit` ≤ 12 characters (control characters
  removed; a number becomes text), `state` one of `on`, `off`, `good`,
  `warn`, `crit` or `null`, `icon` an SVG path (path characters only, ≤ 2000)
  or `null`. No portal link targets (`goto`/`anchor`) — the app opens the
  plugin itself.
* **Viewer**: the token's owner like for the quick actions,
  `user = { id, name, role, portal: true, loggedIn: true, app: true }`;
  `lang` like there (`?lang=`, the owner's setting, `Accept-Language`, `de`).
  A token without an owner gets no tiles.
* **`items`** (optional, apps only): up to 4 small values the card shows as a
  row of icons and values, e.g. charge level, range and lock state of a car
  — `[{ label, icon?, value?, unit?, state? }]` with the rules of a widget's
  `readings` (see "Widgets") without the `id`: `label` required (≤ 20),
  `value` a string (≤ 16) or a finite number, `unit` ≤ 8, `icon` an SVG path,
  `state` one of the five states; a `value` or an `icon` is required. An
  invalid item is dropped (the tile stays), only the first 4 valid ones are
  kept, and the answer always has `items` (`[]` without). The portal's Start
  tab ignores `items` and keeps showing `value` — send both.
* **`key`**: `"<plugin id>/<section or ''>/<title>"`, deterministic and in
  URL-safe characters only (`[A-Za-z0-9._~-]` plus the two `/`, ≤ 184
  characters). A section or title that is already short (≤ 48) and URL-safe
  is taken as it is; anything else becomes its URL-safe form (accents
  dropped, other characters → `-`, ≤ 48) followed by `~` and the first 10 hex
  digits of the SHA-256 of the original text (`Restmüll` →
  `Restmull~1a2b3c4d5e`), so two different titles never share a key. A
  second tile of the same plugin with the same section and title is dropped.
  The title is the one in the requested language — the apps ask with a
  fixed `lang`; a plugin keeps its titles stable so a person's selection
  survives (a title that changes, e.g. with the value, makes a new tile).

```
GET /api/v1/client/tiles?lang=de|en
  200 { ok: true, tiles: [{ key: 'gatecontrol-fahrzeuge/vehicle/Ladestand',
                            plugin: '<plugin id>', pluginName: '<localised name>',
                            section: '<section id>' | null, title, value, unit, state, icon,
                            items: [{ label, value, unit, icon, state }] }] }
```

Same auth as `GET /api/v1/client/actions` (API token with scope `client` or
`full-access`, machine binding, a browser session gets 403
`token_required`), `Cache-Control: no-store`, the general API rate limit
like the actions listing.

### Running other plugins' quick actions (`permissions.actions`)

A plugin with `permissions.actions` can use the quick actions of the other
plugins for one user — for example a family plugin whose presence rule
switches on a smart home scene when the first person comes home, or a
messenger that offers "Haustür öffnen" as a button in a chat and runs it as
the person who pressed it.

```js
const actions = await gc.actions.list({ userId: 7, lang: 'de' });
// [{ actionId: 'gatecontrol-smarthome/scene:evening', plugin: 'gatecontrol-smarthome',
//    pluginName: 'Smart Home', id: 'scene:evening', label: 'Abend', title: 'Abend',
//    subtitle: null, icon: null, kind: 'button', state: null, needsConfirm: false,
//    confirmWhen: null, verbs: null, targets: false, device: null }, …]
const r = await gc.actions.run({ userId: 7, actionId: 'gatecontrol-smarthome/scene:evening', via: gc.plugin.id });
// a person pressed "Haustür öffnen" in this plugin's chat just now (needs actions: { interactive: true }):
await gc.actions.run({ userId: 7, actionId: 'gatecontrol-door/front:open', interactive: true });
// { ok: true, result: { message: 'Szene gestartet', state: null, unchanged: false },
//   message: 'Szene gestartet', state: null, unchanged: false }
await gc.actions.run({ userId: 7, actionId: 'gatecontrol-fahrzeuge/lock:42', params: { state: 'on' } });
// a toggle into a fixed state (see "Target states"):
// { ok: true, result: { message: null, state: 'on', unchanged: true }, message: null, state: 'on', unchanged: true }
await gc.actions.run({ userId: 7, actionId: 'gatecontrol-door/front:open' });
// not (or no longer) offered to that user:
// { ok: false, code: 'ERR_NOT_FOUND', error: 'not_found', message: null, state: null, unchanged: false }
```

The older form `run({ userId, plugin, id, state })` (before 1.180.0) works
unchanged — `actionId` is `plugin + '/' + id` (neither may contain `/`).

**Device values** (since 1.181.0) — e.g. a reminder "only when the car's
battery is below 30 %" or "when it is warmer than 26 °C inside":

```js
const all = await gc.actions.list({ userId: 7, withWidget: true });
// [{ actionId: 'gatecontrol-klima/room:3', …, widget: { value: 21.5, unit: '°C', label: 'Innen',
//    badge: null, readings: [{ id: 'outdoor', label: 'Außen', value: 12, unit: '°C' }],
//    state: 'good', status: 'Heizt' } }, …]
const car = await gc.actions.get({ userId: 7, actionId: 'gatecontrol-fahrzeuge/lock:42', withWidget: true });
// → the same entry as in list (badge: { value: '32', unit: '%', label: 'Akku', state: 'warn' }), or null
```

* `withWidget: true` (list and get; a boolean, absent / `null` / `false` =
  without): every entry gets `widget` — the values of the action's widget
  (see "Widgets") after the same sanitising as for the apps: `{ value, unit,
  label, badge: { value, unit, label, state } | null, readings: [{ id,
  label, value, unit }], state, status }`, or `null` when the action has no
  (valid) widget. Not passed on: controls, icons, `power` — values to compare,
  not a card to draw. `value` / reading values are what the plugin lists
  (a number, or a text like `'32 %'` — parse it yourself).
* `get({ userId, actionId, lang, interactive, withWidget })`: one action,
  exactly as `list` would answer it for that user (same viewer, `interactive`
  rules and checks; `actionId` `'<plugin>/<id>'` or `plugin` + `id`, never the
  caller's own), or `null` when that plugin does not offer it to the user
  right now (unknown, disabled, unlicensed, not running, without
  `permissions.portal`, not listed, its hook failed or timed out). Only the
  named plugin's `quickActions` hook is asked (1.5 s) — cheaper than `list`
  for a rule that watches one device. Neither `list` nor `get` runs anything,
  counts against the run limit or writes an activity entry.

* **Which actions**: exactly what the apps get for that user (the same
  plugins, hooks, timeouts and sanitising as "Quick actions" above): only
  plugins that may run (enabled, licensed, compatible, signed as required),
  are running and have `permissions.portal` — a disabled or unlicensed
  plugin's actions are neither listed nor run — and never the calling
  plugin's own actions (a plugin runs its own actions with its own code).
  Each entry:
  * `actionId`: `'<plugin>/<id>'`, what `run` takes (since 1.180.0);
  * `plugin`, `pluginName` (localised), `id` (the plugin's own action id);
  * `label` (since 1.180.0) = `title`: the action's name (≤ 40 characters,
    no control characters); `subtitle` or `null`;
  * `icon`: an SVG path (path data like `ui.nav.icon`, e.g.
    `'M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8 …'`, ≤ 2000 characters) or
    `null` — draw it in a 24×24 `viewBox`;
  * `kind`: `'button'` (one run) or `'toggle'` (switches between `'on'` and
    `'off'`; `state` the current state or `null` when the plugin lists none;
    buttons always `null`); `verbs` / `targets`: see "Target states";
    `device`: see "Devices and looks" (`{ id, title, subtitle, icon }` or
    `null`);
  * `needsConfirm` (boolean, since 1.180.0): ask the person before a plain
    run (a press of the button) — `true` when the plugin set `confirm: true`,
    or for a toggle whose run switches *into* its `confirmWhen` state (a
    plain run flips, so it ends in the state other than the listed one; a
    toggle that lists no state but has a `confirmWhen` counts as `true`);
  * `confirmWhen` (since 1.180.0): toggles only, `'on'` / `'off'` or `null`
    — for a run with `params.state`, ask when that state equals
    `confirmWhen` (or `needsConfirm` came from `confirm: true`).

  Not passed on: `confirm` (folded into `needsConfirm`), `look`, `widget`
  (its values only with `withWidget: true`, see "Device values").
* **As whom**: the target plugin's `quickActions` / `runQuickAction` get the
  viewer `{ id, name, role, portal: true, loggedIn: true, automation: true,
  via: '<calling plugin id>' }` (no `app` key) — `runQuickAction` also with
  `via: '<calling plugin id>'` and `automation: true` next to `user` — and
  decide themselves what that user may see and do — like for the apps,
  `runQuickAction` only reaches an id the plugin currently lists for that
  user (listing and run go through the same `quickActions.run` as the
  client API). Any enabled account works (an administrator too); the target
  plugin may refuse automation runs by checking `user.automation`.
* **Interactive runs** (since 1.180.0, `permissions.actions: { interactive:
  true }`): `interactive: true` on `run` says "a person pressed a button for
  exactly this action in the calling plugin's UI just now" — use it only
  then, never for rules, schedules or retries. The target plugin's hooks
  get the viewer `{ id, name, role, portal: true, loggedIn: true,
  automation: false, interactive: true, via: '<calling plugin id>' }` and
  `runQuickAction` `automation: false`, `via: '<calling plugin id>'` — like
  that person's tap in the apps (`via` the caller instead of `'app'`), so a
  plugin that refuses automation runs (e.g. a door plugin's `open`) runs
  it. `list({ userId, interactive: true })` asks the targets with the same
  viewer (what that person would get offered). Without the object form →
  `ERR_ACTIONS_DENIED`; a non-boolean `interactive` → `ERR_INVALID`;
  `false` / `null` / absent = the automation run as above. Same limit and
  log (marked "(interactive)").
* **Input** (checked strictly, else `ERR_INVALID` and nothing is asked or
  run): `interactive` (optional) a boolean, see above; `userId` a positive integer of an existing, **enabled** user (checked
  at every call — a disabled, deleted or unknown account → `ERR_INVALID`
  "unknown or disabled user"); `lang` `de`/`en` or absent (then the user's
  language setting, else `de`); either `actionId` `'<plugin>/<id>'` or
  `plugin` + `id` (not both) — the plugin id one other than the caller's
  own, `id` `[A-Za-z0-9:._-]{1,64}`; `params` (optional) an object whose
  only key is `state`; `params.state` or `state` (not both, optional):
  `'on'` / `'off'`, the state a toggle should end in — handled exactly like
  the client API's `state` (see "Target states"); `null` / absent = the
  plain run; `via` (optional) the calling plugin's own id (`gc.plugin.id`) —
  anything else is refused: the host always names the calling plugin
  itself.
* **Result** of `run`: when the target plugin answered (or the host skipped
  an unchanged toggle) `{ ok, result: { message, state, unchanged },
  message, state, unchanged }` — the sanitised answer (`ok` `false` only
  when the plugin says so, then also `code: 'ERR_ACTION_FAILED'`;
  `unchanged` `true` only when the host skipped a run with `state` because
  the toggle already was in that state). When the action did not run the
  call still resolves, with `{ ok: false, code, error, message: null,
  state: null, unchanged: false }` (no `result`): `ERR_NOT_FOUND` /
  `not_found` (unknown, disabled, unlicensed or not running plugin, a plugin
  without `permissions.portal`, an id it does not list for that user — the
  user may not run it), `ERR_INVALID_STATE` / `invalid_state` (`state` not
  `'on'` / `'off'`, or on a button), `ERR_STATE_UNKNOWN` / `state_unknown`
  (`state` for a toggle without `targets` that lists no state),
  `ERR_PLUGIN_FAILED` / `plugin_error` (it failed or answered garbage) or
  `ERR_TIMEOUT` / `timeout` (no answer within 10 s).
* **Limits**: 60 runs per minute per calling plugin (`ERR_RATE_LIMIT`
  beyond; before 1.180.0: 60 per hour; calls refused with `ERR_*` are not
  counted, every other run is — also one that ends in `ERR_NOT_FOUND`).
  Listing is not counted.
* **Activity log**: every run is an entry `plugin_automation` (info; warning
  when not `ok`) "Quick action "<id>" of plugin "<target>" run for user
  "<name>" via plugin "<caller>" [(interactive)] (ok|failed)" with details
  `{ plugin: '<caller>', via: '<caller>', interactive?, target, action,
  userId, ok, state?, unchanged?, error? }` (`interactive: true` only for
  interactive runs) — ids, the account's name and codes only, no text of
  either plugin (`state` only when it is `'on'` / `'off'`).
* **Errors** (thrown): `ERR_ACTIONS_DENIED` (no `permissions.actions`, or
  `interactive: true` without `{ interactive: true }`),
  `ERR_INVALID` (also a non-boolean `withWidget`), `ERR_RATE_LIMIT` (runs only).

## App (permissions.app, ui.app, client API)

Plugins can serve the GateControl apps: `permissions.app: true` lets the apps
call the plugin's `request()` with their device token; `ui.app` `{ label,
icon }` additionally asks for a tab of its own in the apps (the app draws it
natively from the plugin's API — no plugin HTML). Code:
`src/services/plugins/app.js`, `src/routes/api/client/plugins.js`.

* **Who**: plugins that may run (enabled, compatible, signed or allowed,
  licensed), are running and declare `permissions.app` — the same "usable"
  test as the portal and the quick actions.
* **Viewer**: the owner of the token as `req.user = { id, name, role, portal:
  true, loggedIn: true, app: true }` (the quick actions' viewer; since
  1.193.0 plus `device: { id, platform }` for plugins with
  `permissions.devices` — see "Devices"). `app: true`
  tells the plugin the call comes from an app; the plugin decides itself what
  an app user may do. A token without an owner gets no plugins (and 403 for
  the API).
* **`appVisible(user)`** (optional hook): called with that viewer (the
  object itself, then `gc`), 3 s; `false` → the plugin is listed with
  `tab: null` for that person (its API stays usable). No hook → the tab is
  shown; an error or no answer in time → hidden.
* **Language** `lang`: `?lang=de|en`, else the owner's language setting, else
  `Accept-Language`, else `de` (as for the quick actions).

Client API: API token with scope `client` or `full-access` and machine binding
like every `/api/v1/client/*` route (a browser session gets 403
`token_required`, another scope 403 `scope_required`), `Cache-Control:
no-store`. Mounted before the general API limiter; own limit **240 requests
per minute and token** for both routes (failed requests count) → 429
`{ ok: false, code: 'rate_limited' }`. Media previews (`GET …/media/<mediaId>/preview`,
since 1.208.0, see "Previews") have a budget of their own: 1200 per minute
and token.

```
GET /api/v1/client/plugins
  200 { ok: true, plugins: [
        { id: 'gatecontrol-familie', name: 'Familie', version: '1.0.0',
          tab: { label: 'Familie', icon: '<svg path d>' } },      // ui.app, visible
        { id: 'gatecontrol-alltag', name: 'Alltag', version: '1.2.0', tab: null }  // API only (or hidden)
      ] }
  token without an owner → { ok: true, plugins: [] }

ALL /api/v1/client/plugins/:id/api/<path>     GET POST PUT PATCH DELETE
  → the plugin's request({ method, path, query, body, user, lang }) answer
  404 { ok: false, code: 'not_found' }     unknown plugin, not usable, no permissions.app
  403 { ok: false, code: 'no_user' }       token without an owner
  413 { ok: false, code: 'too_large' }     JSON body over 64 KB
  502 / 503 / 504                          plugin_error / not_running / timeout (like the portal)
```

The install dialog shows "App: Daten für die GateControl-App bereitstellen"
and, with `ui.app`, "App-Tab „<label>“" under *Oberfläche*; the plugin's
overview lists the app tab.

## Maps

`ui.maps: true` lets the plugin show an OpenStreetMap map in its frames (admin
pages, portal tab and sections). Only for those plugins' frames
(`src/services/plugins/frame.js`):

* **CSP**: `img-src data: https://tile.openstreetmap.org <origin>/plugins/_shared/leaflet/images/ <origin>/plugins/_shared/tiles/ <origin>/avatars/`,
  `script-src 'unsafe-inline' <origin>/plugins/_shared/leaflet/leaflet.js`,
  `style-src 'unsafe-inline' <origin>/plugins/_shared/leaflet/leaflet.css` —
  `<origin>` is the origin the frame was loaded from (scheme + Host header;
  a Host that is not a plain `host[:port]` gets the direct tiles but no
  shared Leaflet and no tile relay). Exactly these files, not `'self'`;
  `connect-src` stays `'none'`.
* **Tiles** (`src/services/plugins/tiles.js`): the frame loads the
  OpenStreetMap tiles from GateControl, `window.GC.tiles` is the URL template
  for Leaflet — `/plugins/_shared/tiles/<token>/{z}/{x}/{y}.png`, `null` in
  frames of other plugins (and without a known origin). Loaded directly from
  `https://tile.openstreetmap.org`, every tile is a 403 "Access blocked":
  the frame is sandboxed without `allow-same-origin`, so its document has an
  opaque origin, and Chromium sends **no Referer at all** from such a
  document, whatever the Referrer-Policy says; OpenStreetMap blocks
  referrer-less tile requests (tile usage policy). `allow-same-origin` is no
  way out — the frame would share GateControl's origin. The relay:
  * no session (the frame sends no cookies); the token is the permission:
    `<exp>.<sig>`, `exp` = the next full hour + 24 h in unix seconds (the
    template stays the same for an hour, so the browser cache works), `sig`
    = HMAC-SHA256 over `plugin-tiles:<exp>` with the server secret
    (`GC_SECRET`), base64url, 22 characters. Valid while
    `now < exp ≤ now + 26 h`; a frame open for more than a day gets new
    tiles after a reload. Invalid or expired token, `z` outside 0–19, `x` /
    `y` outside 0 … 2^z − 1 → 404;
  * upstream `https://tile.openstreetmap.org/<z>/<x>/<y>.png` from the
    server with `User-Agent: GateControl/<version> (+https://github.com/CallMeTechie/gatecontrol)`,
    10 s timeout, at most 2 requests at a time (the rest waits), one request
    per tile however many frames ask for it at once;
  * cached in memory (LRU, 64 MB) for the upstream `max-age`, clamped to
    1–7 days; when the upstream fails, a stale copy is served if there is
    one. Upstream 404 → 404, other failures without a copy → 502;
  * answers `Content-Type: image/png`, `Cache-Control: public, max-age=86400`,
    `Cross-Origin-Resource-Policy: cross-origin`; 600 tiles per minute and
    address (own rate limit).

  Use `GC.tiles` when it is set, the direct URL otherwise (an older
  GateControl): `L.tileLayer(GC.tiles || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', …)`.
  `img-src https://tile.openstreetmap.org` stays for plugins that load the
  tiles directly.
* **Leaflet**: GateControl's vendored Leaflet 1.9.4 (`public/vendor/leaflet`,
  the one of the device page), served without a session and with
  `Cross-Origin-Resource-Policy: cross-origin` (the sandboxed frame has an
  opaque origin):
  * `/plugins/_shared/leaflet/leaflet.js`
  * `/plugins/_shared/leaflet/leaflet.css` (the Leaflet section of
    `public/css/app.css`, image URLs relative)
  * `/plugins/_shared/leaflet/images/{marker-icon,marker-icon-2x,marker-shadow,layers,layers-2x}.png`
    (the default marker works without setting `L.Icon.Default.imagePath`).
* **Referrer**: `Referrer-Policy: strict-origin-when-cross-origin` (header and
  meta) instead of `no-referrer` — never the frame's URL. From the frame's
  opaque origin Chromium sends no referrer at all anyway (see **Tiles**).
* **Links**: the frame's sandbox (CSP and the `<iframe>` attribute) gets
  `allow-popups allow-popups-to-escape-sandbox`, so a plain
  `<a href="https://www.openstreetmap.org/?mlat=…&mlon=…" target="_blank" rel="noopener">`
  opens in a new tab as a normal page. Frames of other plugins cannot open
  popups.
* The install dialog shows "Karten: zeigt Karten von OpenStreetMap …".

```html
<link rel="stylesheet" href="/plugins/_shared/leaflet/leaflet.css">
<script src="/plugins/_shared/leaflet/leaflet.js"></script>
<div id="map" style="height:320px"></div>
<script>
  const map = L.map('map').setView([52.52, 13.405], 15);
  // GC.tiles: the tiles through GateControl (see "Tiles"); the direct URL only on an older GateControl
  L.tileLayer(GC.tiles || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  L.marker([52.52, 13.405]).addTo(map);
</script>
```

## Licences

* **first-party** (signed by a trusted key): the entitlement of the GateControl
  licence server (`license.getPluginEntitlements()`, slug = plugin id, valid
  and not expired). Its `source` says where it comes from: `license` (a key
  of its own), `lifetime`, or `plan` — the plugin is included because the
  customer's GateControl plan contains the former built-in feature (e.g.
  `smarthome` → `gatecontrol-smarthome`, `midea_integration` →
  `gatecontrol-midea`; token `sub` = `plan:<id>`); the UI
  shows "Im Plan enthalten". A key entered although the plugin is already
  covered comes back with the error `covered_by_plan` / `covered_by_lifetime`:
  it never decides the state (the covering entitlement does) and the UI says
  that the key is not needed. A key entered for the plugin is added to the plugin keys
  of the GateControl licence (`setPluginKeys`) and a licence refresh runs. The
  14-day offline grace of the GateControl licence applies.
  The entitlements are those of the last validation, which runs once a day. A
  plugin released after it (a lifetime licence covers every new plugin, a plan
  its included ones) would be "fehlt" until the next day, so **installing or
  updating** a first-party plugin that needs a licence and has no entitlement
  revalidates the GateControl licence once in the background
  (`licensing.revalidateIfMissing`: only with a GateControl licence key, never
  for third-party plugins or when an entitlement exists, at most once per 10
  minutes per process — independent of the cooldown of
  `POST /api/v1/license/refresh`). Afterwards the plugins are reconciled, so a
  plugin that is licensed now starts without a restart; the install answer
  waits for this at most 15 s. In state "fehlt" the licence tab of a
  first-party plugin also offers **"Lizenz aktualisieren"**
  (`POST /api/v1/license/refresh`, 60 s cooldown → 429), which reconciles the
  plugins right after the refresh as well; entering a key of its own stays
  possible.
* **third-party**: the plugin's own licence server (`license.server`, HTTPS
  only, public address), contract of callmetechie.de
  `docs/api/plugin-license-protocol.md`:
  `POST { license_key, plugin_id, server_id }` → `200 { valid, expires_at }`.
  `server_id` is an anonymous, stable id of this install for that licence
  server (HMAC of a random install secret and the server origin — not the
  hardware fingerprint, and different per licence server). Checked on entry
  and daily; when the server cannot be reached the last good answer counts for
  14 days.

### Tier and people (`gc.license.info`, since 1.206.0)

A licence may be for a number of people — GateControl Drive: Familie,
Business or both ("Kombi"), 5 people included, more bookable per kind. The
signed plugin token of the GateControl licence server then carries

```json
{ "tier": "family" | "business" | "combo", "seats": { "included": 5, "family": 2, "business": 0 } }
```

(`seats.family` / `seats.business`: the people booked on top of the included
ones). Only the **signed** token counts — `tier` / `seats` next to it in the
answer are ignored; an unknown tier is none, a missing or invalid count is 0.
`license.getPluginEntitlements()` hands them on, the licence tab shows "Stufe"
and "Personen" (e.g. "7 Personen (5 inklusive, 2 hinzugebucht)").

```js
await gc.license.info();
// → { required: true, valid: true, state: 'valid', expiresAt: null, source: 'license', tier: 'family',
//     seats: { total: 7, family: 7, business: 0, included: 5, extra: { family: 2, business: 0 } } }
```

`seats` are the most people the plugin may switch on:

| tier | `family` | `business` | `total` |
|---|---|---|---|
| `family` | included + extra family | 0 | = family |
| `business` | 0 | included + extra business | = business |
| `combo` | included + extra family | included + extra business | included + both extras (the included people are shared) |

The plugin counts its people itself (who it switched on — wall tablets and
accounts without access do not count) and refuses a further one at the
limit; people already switched on keep working when the licence gets smaller
(the plugin shows a note). `tier` and `seats` are `null` when the licence
names none: a third-party licence, a lifetime or plan entitlement, an older
licence server, an invalid licence or a plugin that needs none — the plugin
decides what that means for it.

`gc.license.refresh()` — after the customer booked more people
("Personen hinzubuchen" opens their account on callmetechie.de) the plugin
fetches the licence at once instead of at the next daily validation:
first-party → the GateControl licence is revalidated (only with a licence key)
and the plugins reconciled; third-party → its licence server is asked. At most
once a minute for all plugins together (else `refreshed: false` with the
current state, nothing is fetched). → `{ refreshed, …info() }`.

States: gültig · läuft bald ab (≤ 14 days) · Lizenzserver nicht erreichbar
(still running) · fehlt · abgelaufen · ungültig · auf einem anderen Server
aktiv · nicht für dieses Plugin · 14 Tage nicht geprüft. A plugin that needs a
licence only runs while it is licensed; without one it is installed but stays
off, its data is kept.

## Backup

GateControl backups (format 5; manual, scheduled and off-site) contain every
installed plugin: the package files including `signature` (a restore on a
fresh server brings the plugin back without a new upload), a consistent
snapshot of its database (SQLite serialize on a read-only connection, never a
copy of the live file), its `files/` folder, whether it was switched on, the
third-party licence entry and the access targets (routes by domain, peers by
name — ids change on restore). `secret` settings are additionally stored as
plain encrypted backup fields, so restoring an off-site archive with its key
re-encrypts them like every other secret. All plugins together are capped at
48 MB per backup; data that does not fit is left out and logged.

Plugin **media** (see "Media") are not part of that and not in a backup by
default: Plugins › Sicherheit & Upload → "Plugin-Medien im Backup" (off by
default; API `PUT /api/v1/plugins/policy { backupMedia }`, activity
`plugin_media_backup`) adds each plugin's claimed files — as stored
(encrypted), each with its file key as a regular backup secret (encrypted
with `GC_ENCRYPTION_KEY`, re-keyed with off-site archives) — up to 128 MB for
all plugins together; a plugin whose media do not fit is backed up without
them (`skipped: ['media']`). A restore writes them back and keeps media of
the plugin that are not in the backup. The restore upload accepts up to
288 MB.

The tables of the former built-in integrations (see "Built-in data import")
travel in `data.builtin_integrations` (`src/services/builtinBackup.js`) until
their data is imported: rows as stored (ids kept, secrets still encrypted, the
Škoda render image as base64), user references by user name and a Smart Home
gateway's route by domain. A restore replaces exactly the tables the backup
carries; a backup without this part leaves them untouched.

Restore: plugin processes are stopped, every package's signature is verified
again — a changed package is not restored, an unsigned one is restored but
stays off while "Unsignierte Plugins erlauben" is off (that switch itself is
never taken from a backup) — code and data are replaced, then plugins start
as usual. A format-5 backup is the complete plugin state: plugins installed
here but not in it are removed like "Alles löschen" (process, code, data,
licence, targets; each removal in the activity log) — the restore dialog says
so. Older backups (format 2–4) contain no plugins and leave the installed ones
untouched.

## Built-in data import (built-in → plugin)

Smart Home (deCONZ/Phoscon), Klimaanlage (Midea) and Fahrzeuge (Škoda) used
to be built into GateControl. Since 1.152 their code is gone — the features
are the first-party plugins `gatecontrol-smarthome`, `gatecontrol-midea` and
`gatecontrol-skoda` and nothing of them remains without the plugin (no
sidebar entry, page, API, portal part, background job or setting). Their
data is kept: the tables and settings are never dropped (migrations stay),
are in backups (see "Backup") and are brought into the plugin once. Code:
`src/services/plugins/legacy.js`.

* **Fixed mapping** (`DATASETS`): plugin id → built-in dataset and the home
  target that the dataset's GateControl routes / LAN addresses become
  (`source.targetRefs`; none for a cloud integration). Each source reads its
  tables directly (`counts()`, `export()`, secrets decrypted with
  `utils/crypto`):

  | Plugin | Dataset (built-in data) | Home target |
  |---|---|---|
  | `gatecontrol-smarthome` | `smarthome`: `smarthome_gateways`, `_resources`, `_resource_owners`, `_rules` | `gateway` ← each gateway's route |
  | `gatecontrol-midea` | `midea`: the Midea cloud account (setting `midea_config`), `midea_devices`, `midea_device_owners` | `ac` ← each LAN device's address (`{ kind: 'host' }`; cloud devices need none) |
  | `gatecontrol-skoda` | `skoda`: `skoda_accounts`, `skoda_vehicles`, `skoda_vehicle_owners` | — (Škoda cloud only) |
* **Upgrade notice** (`pendingMoves()`): while a dataset has data
  (`counts()` > 0), its plugin is not installed and the data was **never
  imported**, the dashboard and the plugin area say that the feature is a
  plugin now ("Smart Home ist jetzt ein Plugin. Installiere „Smart Home“ …",
  i18n `plugins.moved.*`) and offer it: with the catalogue on, *Jetzt
  installieren* (the plugin's catalogue page; the
  dashboard links `/settings?install=<id>#plugins`, which focuses that
  button), and always the plugin's releases
  (`https://github.com/CallMeTechie/gatecontrol-plugins/releases?q=<id>`).
  Installing the plugin (on or off) hides the notice. A successful import
  sets the marker `plugins.legacy_imported.<dataset>` (settings, an ISO
  date) that no uninstall removes — the built-in tables are never dropped,
  so without it the notice would come back for good after an uninstall. An
  import record of the plugin (kept by *Daten behalten*) counts as well
  (imports made before the marker existed).
* **Former pages and API**: `/smarthome`, `/smarthome/rules`, `/midea`,
  `/skoda` redirect to `/plugins/<id>` (`…/rules`) when the plugin is
  installed, else to `/settings#plugins` (`movedPage()`, fixed paths only).
  `/api/v1/smarthome`, `/api/v1/midea`, `/api/v1/skoda` answer
  `410 { code: 'moved_to_plugin', plugin }`; the built-in portal endpoints
  are gone (404).
* **Who**: only the mapped id with a **trusted signature** (CallMeTechie key
  or a key in `GC_PLUGIN_PUBKEYS`). For trying an unsigned development build
  the operator can set `GC_PLUGIN_LEGACY_UNSIGNED=1` (the plugin still only
  runs with *Unsignierte Plugins erlauben*).
* **When**: offered on the plugin's page in the plugin area as soon
  as the plugin runs and built-in data exists — right after the install,
  too; the administrator confirms; it can be run again while the built-in
  data exists ("Erneut übernehmen" replaces the plugin's data).
* **How**: the host reads exactly the mapped tables into a JSON snapshot
  `{ schema: 1, dataset, exportedAt, …lists }` — `smarthome`: `gateways,
  resources, owners, rules`; `midea`: `cloud` (0–1 `{ app, email, password,
  session }`), `devices` (with the LAN `token`/`key` of protocol V3),
  `owners` (`{ device_id, user_id }`); `skoda`: `accounts` (with `password`,
  `spin`, `session: { accessToken, refreshToken }`), `vehicles` (with
  `state`, the render `image` as base64 and `image_url`), `owners`
  (`{ vehicle_id, user_id }`) — (secrets such as the deCONZ API key, the
  Midea password/session and LAN keys, the MySkoda password, S-PIN and
  tokens are decrypted for this hand-over only and never logged), turns
  every referenced GateControl route / LAN address into an assignment of the
  plugin's home target (existing assignments are kept, one already pointing
  there is reused; an address plugins may never reach is left out;
  `gateways[].target` / `devices[].target = { id, index, label }` or null,
  route ids and addresses stay in the host), and calls the plugin's
  `legacyImport(snapshot, gc)` hook, which writes the data into its own
  storage (ids kept, so owners and rule references stay valid) and answers
  `{ ok: true }`. User ids are the same on this server, so owners keep their
  mappings. The built-in data itself is never changed by the import.
* **Record**: `plugin_legacy_imports` (when, row counts, number of runs),
  plugin log and activity log (`plugin_legacy_imported`). "Alles löschen"
  removes the record, so a fresh install is offered the import again (as
  not done yet); the marker of the dataset stays, so the upgrade notice does
  not return.
* **API**: `GET /api/v1/plugins/<id>/legacy` (status: eligible, available,
  counts, imported, running; `null` for plugins without a dataset),
  `POST /api/v1/plugins/<id>/legacy/import` `{ confirm: true }`.
* **Users**: deleting a user still removes that user's rows in the built-in
  owner tables. "Was sieht dieser Nutzer?" has no built-in portal part any
  more (plugins decide what a viewer sees).
* **Licence**: the feature keys `smarthome`, `midea_integration`,
  `skoda_integration` stay — they are how a plan includes the plugins
  (entitlement source `plan`, see "Licences"); they show no UI themselves.

## Lifecycle and activity log

install (`plugin_installed`) · update (`plugin_updated`) · enable/disable
(`plugin_enabled`/`plugin_disabled`) · built-in data imported (`plugin_legacy_imported`) · stopped by licence/signature/version
(`plugin_suspended`) · uninstall (`plugin_uninstalled`, mode keep/wipe) ·
"Unsignierte Plugins erlauben" (`plugin_unsigned_allowed`/`plugin_unsigned_blocked`)
· access targets (`plugin_target_changed`) · plugin notifications
(`plugin_notice`) · quick actions run from an app (`plugin_quick_action`) ·
quick actions run by another plugin (`plugin_automation`) ·
kiosk users marked/unmarked (`kiosk_user_allowed`/`kiosk_user_disallowed`,
only when something changed) · services called by another plugin
(`plugin_service`) · media quota changed (`plugin_media_quota`) · "Plugin-Medien
im Backup" switched (`plugin_media_backup`) · chat notifications: one neutral
`plugin_notice` line per hour with the count.

Uninstall *Daten behalten* removes code and registry entry and keeps data,
licence and access targets for a reinstall; *Alles löschen* (typed plugin name)
removes everything.

## Not yet (later stages)

* automatic updates (the catalogue says "Update verfügbar"; the
  administrator starts each update and confirms its permissions);
* dropping the built-in tables once every installation has imported them;
* releasing a licence ("Lizenz freigeben") from the plugin card.
