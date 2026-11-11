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
`public/js/plugin-bridge.js` · example plugin `tests/fixtures/plugins/hello/` ·
edge parts on home gateways `src/services/edge/` ("Edge part").

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
link cloud ai` (`cloud` since 1.206.0, `ai` — AI requests, `permissions.ai` — since 1.214.0). Per version `notes` (its CHANGELOG section, Markdown). Without them a
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
10 s; kept in memory for 15 minutes (*Katalog neu laden* = `?refresh=1`; a
failure is remembered for a minute). A test run (`NODE_ENV=test`) never
reaches the internet.

**When github.com's download path fails** (seen on 8 Nov 2026:
`…/releases/download/…` answered 504 after 11 s while the API worked): a
release download on `github.com` — the catalogue and every package — that
answers 5xx, sends no answer within 4 s (catalogue) / 8 s (package) or drops
the connection is fetched over the API instead:
`GET https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>` (the
asset id of the file), then
`GET https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>` with
`Accept: application/octet-stream`, which redirects to the asset CDN.
`api.github.com` is allowed for this way only, the same caps and the sha256
check apply. GateControl keeps the asset id for an hour and asks the release
with `If-None-Match` (a `304` does not count against GitHub's limit of 60
API requests an hour per address); a replaced file (the rolling `catalog`
release) answers 404 and is looked up once more. After a failure of the
download path the API way comes first for 10 minutes. When GitHub refuses
for its rate limit (`403`/`429`, `x-ratelimit-remaining: 0`, `Retry-After`)
no API request goes out until the reset (`catalog_rate_limited` when nothing
else worked). A 4xx of the download path (`404`) is no reason for the other
way. `GC_PLUGIN_CATALOG_URL` on another host never takes it. Code:
`src/utils/githubRelease.js`. The log has one line per outage and way —
`plugin catalogue via api fallback: ok` (info, with the reason the download
path failed) or `… failed` (warn, with `download` and `api`: the error, the
host and the phase it hung in — `dns`, `connect`, `tls`, `first byte` — with
the address and IPv4/IPv6); the same warning again within 5 minutes is
counted (`repeated`), not written. While no fetch works, the last catalogue
that loaded (up to a day old) is shown (`stale` in the API answer,
*zuletzt geprüft* shows its age). The same way serves the update manifests of
the Windows clients (`update-manifest.json` / `.sig`, still passed on byte
for byte and checked by the client) and the installers of the home cache.

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

API (admin session + CSRF; `pluginApiLimiter`, downloads also
`pluginCatalogLimiter` — 100 per 15 minutes and account, enough for
*Alle aktualisieren* of every official plugin several times — and
`?refresh=1` `pluginCatalogRefreshLimiter` — 20 per 15 minutes; both apart
from the upload budget; a 429 carries `code: "rate_limited"`, `retryAfter`
and a translated message; an API token gets 403):

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
| `/settings/plugins` | Meine Plugins: state tiles, "Braucht deine Aufmerksamkeit" (crashed, licence, unsigned, expiring licence, open setup notices, updates — each with its action), search, filter, list or tiles grouped by area, suggestions; without plugins the first-run page |
| `/settings/plugins/catalog`, `…/catalog/<id>` | the catalogue (areas and filters in the side column); one plugin: what it adds, what it may do, how it looks, versions, the install panel |
| `/settings/plugins/manage/<id>` | one installed plugin: Übersicht, Einstellungen, Berechtigungen, Lizenz, Protokoll, Versionen, Handbuch (`handbook`, `?tab=handbook#<anchor>`); banners of open setup notices above every tab; restart, switch, update, uninstall |
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
    "homePresence": true,
    "homeInternet": true,
    "homeCache": true,
    "groups": "read",
    "ai": { "purpose": { "de": "Dokumente erkennen", "en": "Recognise documents" }, "capabilities": ["text", "vision"] },
    "cloudImport": { "purpose": { "de": "Dateien aus Google Drive und OneDrive übernehmen", "en": "Take files from Google Drive and OneDrive" } }
  },
  "media": { "maxBytes": 26214400, "types": ["image/jpeg", "image/webp", "audio/ogg", "application/pdf"], "quotaDefault": "10GB" },
  "services": { "provides": { "scene": { "label": { "de": "Szene schalten", "en": "Switch a scene" } } } },
  "ui": {
    "nav": { "label": { "de": "Smart Home", "en": "Smart Home" }, "icon": "<svg path d>", "section": "home" },
    "pages": [
      { "id": "main", "title": { "de": "Smart Home", "en": "Smart Home" } },
      { "id": "rooms", "title": { "de": "Räume", "en": "Rooms" } }
    ],
    "settingsPages": ["rooms"],
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
    { "id": "alarm", "label": { "de": "Alarm", "en": "Alarm" }, "allowCritical": true, "email": true },
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
* `edge` (optional): a part that runs on home gateways, with its capabilities —
  see "Edge part".
* `permissions.background`: `{ "intervalSeconds": n }` with an integer
  5 ≤ n ≤ 86400 (else `permissions.background.intervalSeconds: invalid`) —
  the host calls the `tick` hook every n seconds; the install dialog shows
  "läuft alle n Sekunden". Each tick has 120 s; a tick still running (or one
  the host gave up on after its timeout and that still runs in the plugin
  process) is never started twice — the next one is skipped.
* `permissions.notify`: `true` (≤ 30 pushes per hour) or `{ "perHour": n }`
  with an integer 1 ≤ n ≤ 1000 (since 1.219.0; before 1 ≤ n ≤ 120; no other
  key); anything else is
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
* `ui.settingsPages` (since 1.225.0): ids of up to **4** more of `ui.pages`
  (never the first one, never the `ui.settingsPage`, no id twice) — the
  plugin's administration that is more than settings (e.g. Mail ›
  Ressourcen, Geteilte Postfächer). Each becomes a **tab of its own** under
  Einstellungen › Plugins › the plugin, right after "Einstellungen" and in
  this order (Übersicht · Einstellungen · Ressourcen · Geteilte Postfächer ·
  Berechtigungen · Lizenz · Protokoll), labelled with the page's `title`,
  and no longer a page tab on the plugin's own page (Zuhause / Apps › the
  plugin). The tab shows the page's sandboxed frame over the whole width —
  the same frame as on the plugin's page (`/plugins/<id>/frame/<page>`,
  `render` gets `view: 'page'` and that `page`, the admin API,
  administrators only, the same sandbox and CSP) — and only while the plugin
  runs (otherwise the tab is missing and the overview explains why).
  `?tab=<page>` opens it directly (`/settings/plugins/manage/<id>?tab=resources`),
  `/plugins/<id>/<page>` leads there (302), and `window.GC.navigate('<page>')`
  from any of the plugin's admin frames switches to it (on the plugin area
  without loading the page again). Errors `ui.settingsPages: invalid`
  (not a list, more than 4, an unknown page, the first page, the settings
  page, an id twice) and `ui.settingsPages: reserved` (an id of the area's
  own tabs: `overview`, `settings`, `perms`, `license`, `log`, `versions`).
  **Older GateControl** (before 1.225.0) ignores the key — `validate` drops
  unknown keys of `ui` without an error, so the plugin installs there and
  shows these pages as page tabs on its own page (`GC.navigate` opens them
  there). A plugin that must not run without the tabs declares
  `"gatecontrol": ">=1.225.0"`. The key is read at install: a plugin
  installed before the server update gets its tabs with its next update or
  reinstall.
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
  topic cannot be critical or default`). `email` (boolean, default `false`,
  since 1.225.0): the topic's pushes also go **by e-mail** to the people they
  reach unless a person switches that off — see "Notifications by e-mail";
  never on a chat topic (`notifyTopics: chat topic cannot be mailed`). An
  older GateControl ignores the key (no e-mail channel there).
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
* `permissions.publicEndpoints` (since 1.211.0): `true` or `{ "maxBodyBytes": n }`
  — requests **without a session** under `/plugin-public/<id>/…`, each with a
  token the plugin mints (`gc.publicEndpoints.token`), answered by the hook
  `publicRequest`; with `maxBodyBytes` (≤ `media.maxBytes`, needs `media`) a
  request body up to that size is stored as an unclaimed media file. Shown at
  install as "Öffentliche Endpunkte …", marked as sensitive. Errors
  `permissions.publicEndpoints: invalid`, `permissions.publicEndpoints.maxBodyBytes:
  needs media`. See "Public endpoints".
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
* `permissions.mail` (since 1.216.0): `{ "purpose": {de, en}, "maxConnections": n }`
  — IMAP and SMTP to the mail servers people enter (`gc.mail`), encrypted
  only, public addresses only; `maxConnections` 1 … 200 (default 50) open
  IMAP sessions at a time. The install dialog shows "Mail: darf sich mit
  Mail-Servern im Internet verbinden (IMAP und SMTP, nur verschlüsselt) und in
  deinem Namen Mails senden – höchstens n Verbindungen gleichzeitig. Zweck:
  <purpose>", marked as sensitive. Errors `permissions.mail: invalid`,
  `permissions.mail: invalid (needs a purpose)`,
  `permissions.mail.maxConnections: invalid`. Since 1.219.0 the optional
  `"dav": { "purpose": {de, en} }` adds CalDAV/CardDAV to those servers
  (`gc.mail.dav`); the install dialog shows a row of its own "Kalender und
  Kontakte: darf außerdem Kalender und Adressbücher auf Servern im Internet
  lesen und ändern (CalDAV/CardDAV, nur verschlüsselt). Zweck: <purpose>",
  marked as sensitive. Error `permissions.mail.dav: invalid (needs a
  purpose)`; an older GateControl refuses the key (`"gatecontrol":
  ">=1.219.0"`). See "Mail".
* `permissions.network.images` (boolean, since 1.216.0): pictures of any
  public host loaded by GateControl on behalf of the plugin
  (`gc.http.fetchImage`, see "Network"). The install dialog shows "Bilder aus
  Mails: lädt Bilder aus Mails stellvertretend aus dem Internet (nur
  öffentliche Adressen, nur Bilder)", marked as sensitive. Error
  `permissions.network.images: invalid`; an older GateControl refuses the key
  (`permissions.network: unknown key images`).
* `permissions.ai` (since 1.214.0): `{ "purpose": {de, en}, "capabilities":
  ["text", "vision", "audio", "video"] }` — requests to the AI provider set up
  in GateControl (`gc.ai.*`). The install dialog shows "KI-Anfragen: <purpose>
  (Text, Bilder) über den in GateControl eingerichteten KI-Anbieter …",
  marked as sensitive; the administrator can block the plugin later. Errors
  `permissions.ai: invalid`, `permissions.ai.capabilities: needs "text"`. See
  "AI requests".
* `services` (optional, since 1.177.0): `{ "provides": { "<name>": { "label" } } }`
  — services other plugins may call (`<name>` `[a-z][a-z0-9_]{0,31}`, ≤ 32,
  label text ≤ 60, no other keys; errors `services: invalid`,
  `services.provides: invalid`). Since 1.216.0 also `"maxPerHour": n`
  (integer 60 … 3600) next to the label: calls of that service per calling
  plugin and hour instead of the shared 60 (error
  `services.provides.maxPerHour: invalid`; an older GateControl refuses the
  key with `services.provides: invalid` — declare `"gatecontrol": ">=1.216.0"`).
  `permissions.services`: `["<plugin>:<service>"]`
  (≤ 32) — the services of other plugins this plugin may call
  (`permissions.services: invalid`; one of its own: `permissions.services:
  own service`). See "Services".
* `handbook` (optional, since 1.241.0): `{ "de": "HANDBUCH.md", "en":
  "HANDBOOK.md" }` — the plugin's manual, shown as the tab „Handbuch“ /
  "Manual" under Einstellungen › Plugins › <plugin>. See "Handbook".
* `setupNotices` (optional, since 1.241.0): steps an administrator has to do
  by hand after an install or update (a new compose file, settings of a
  camera …), shown as a banner until done. See "Setup notices".

Older hosts ignore `handbook` and `setupNotices` (unknown top-level keys are
not refused), so a plugin can bring them without raising `gatecontrol`.

## Handbook (`handbook`, since 1.241.0)

```json
"handbook": { "de": "HANDBUCH.md", "en": "HANDBOOK.md" }
```

* Paths relative to the plugin folder, files of the package (`.md`, at most
  256 KB each — errors `handbook.de: invalid` / `missing` / `too large`). One
  language is enough; other keys (a later language) are ignored.
* The first line of each file is `<!-- version: X.Y.Z -->` with the version
  of `plugin.json`: touch the handbook with every release (the plugin repo's
  `tools/validate.js` and `tools/release-check.js` check it; the host only
  says "written for version …" under the tab when they differ).
* Shown under Einstellungen › Plugins › <plugin> › „Handbuch“ ("Manual", the
  last tab) of every plugin whose installed package has one — in the
  language of the interface, else German, else English. A plugin without
  `handbook` has no tab. Deep link: `/settings/plugins/manage/<id>?tab=handbook#<anchor>`.
* `GET /api/v1/plugins/:id/handbook?lang=de|en` (admin) →
  `{ version, handbookVersion, lang, html, toc: [{ level, text, anchor }] }`
  (404 `no_handbook` / `handbook_missing`).

Rendered on the server (`services/plugins/markdown.js`) from a subset of
Markdown; **no HTML of the file gets through** — `<b>` stays the text `<b>`,
the page rebuilds the result from a whitelist once more:

| Markdown | Result |
|---|---|
| `#`, `##`, `###` (`####` …) | headings with an anchor; levels 1–3 form the table of contents |
| paragraphs, two trailing spaces / `\` | `<p>`, `<br>` |
| `- ` `* ` `+ ` / `1. ` `1) ` | lists, nested by indentation, `start` of an ordered list |
| `**fett**` `__fett__` `*kursiv*` `_kursiv_` `` `code` `` | strong, emphasis, code |
| ```` ``` ```` / `~~~` | code blocks |
| `[Text](https://…)`, `<https://…>` | a link in a new tab (`rel="noopener noreferrer"`) — **only https://** |
| `[Text](#anker)` | a jump to a heading of this handbook |
| `\| a \| b \|` + `\|:--\|--:\|` | tables (alignment) |
| `> **Hinweis:** …` / `> **Achtung:** …` | note blocks (Hinweis/Note/Tipp: blue, Achtung/Wichtig/Warning: amber) |
| `---` | rule |
| `<!-- … -->` | dropped |
| `![alt](…)` | no images (yet): the alt text |

Any other link (`http:`, `javascript:`, `mailto:`, relative paths) stays
plain text. **Anchors**: the slug of the heading — lower case, ä/ö/ü/ß →
ae/oe/ue/ss, other accents dropped, everything but a–z/0–9 → `-`, repeated
slugs `-2`, `-3` ("Kameras einrichten" → `kameras-einrichten`). A heading may
name its anchor itself: `### Camera settings {#kamera-einstellungen}` — the
same anchor in both languages.

Recommended outline (the same for every plugin): „Was das Plugin kann“,
„Voraussetzungen“, „Einrichten“ (step by step, including steps outside
GateControl such as the compose file or camera settings), „Benutzen“
(portal/apps), „Berechtigungen“, „Häufige Fragen / Fehlersuche“, „Neu in
X.Y.Z“ (from the CHANGELOG of the current version).

## Setup notices (`setupNotices`, since 1.241.0)

```json
"setupNotices": [
  {
    "id": "cameras-compose",
    "since": "1.6.0",
    "title": { "de": "Kameras: Compose-Datei und Kamera-Einstellungen", "en": "Cameras: compose file and camera settings" },
    "text":  { "de": "Für Kameras im Heimnetz braucht das Gateway einmalig die neue Compose-Datei …", "en": "…" },
    "handbook": "kameras-einrichten",
    "check": { "type": "gatewayService", "feature": "cameras", "service": "kameras" }
  }
]
```

* `id` `[a-z0-9][a-z0-9-]{0,63}`, unique in the plugin; `since`: the plugin
  version from which the notice applies — shown after an install of, or an
  update to, a version ≥ `since`; `title` (≤ 120) and `text` (≤ 1000): a
  string or `{ de, en }`; at most 20 notices. Errors `setupNotices: invalid`,
  `setupNotices.<id>: invalid id | duplicate id | invalid since | invalid
  title | invalid text | invalid handbook | invalid check`.
* `handbook` (optional): the anchor of a heading of the handbook ("Im
  Handbuch nachlesen" opens the tab there) — one for both languages, or
  `{ "de": "kameras-einrichten", "en": "setting-up-cameras" }` (or one anchor
  given with `{#…}` in both files).
* `check` (optional, default `manual`):

| `type` | Done when |
|---|---|
| `manual` | an administrator clicks „Erledigt“ |
| `gatewayService` (`feature`, `service`) | at least one gateway has the feature on and its compose service runs (telemetry). While a gateway has the feature on but the service is missing, the notice stays with the gateway's name and „docker-compose.yml herunterladen“ (not for a Raspberry Pi image). Features with a service of their own: `cameras` (service `kameras`), `ai` (`ki`), `radio` / `zigbee` (`deconz`, or `zigbee2mqtt` / `otbr` when chosen for the gateway); any other name: the gateway's switch `<feature>.enabled` and `telemetry.features.<feature>.service === "managed"` |
| `gatewayVersion` (`min`, optional `feature`) | every gateway (with that feature on) runs at least `min` |
| `hostVersion` (`min`) | this GateControl is at least `min` |

  A `type` this host does not know counts as `manual` (a newer plugin on an
  older host still installs).
* Open notices: a banner above every tab of Einstellungen › Plugins ›
  <plugin> (text, gateways, „Im Handbuch nachlesen“, „Erledigt“), the badge
  „Handeln nötig“ at the plugin in the list and under „Braucht deine
  Aufmerksamkeit“, and „Plugins brauchen deine Hilfe“ on the dashboard
  (administrators, enabled plugins).
* „Erledigt“ ends a notice whatever its check says; it is stored per plugin
  and notice id with the person, the time and the plugin version
  (`plugin_notice_acks`, removed with „Alles löschen“) and written to the
  activity log (`plugin_notice_done`). A notice that must come back later
  needs a new `id`.
* Admin API: `GET /api/v1/plugins/:id/notices` (every notice of the installed
  version with `state` `open` | `done` | `acked`), `POST
  /api/v1/plugins/:id/notices/:notice/ack`; the plugin views of
  `GET /api/v1/plugins` carry `handbook` (true/false) and `notices` (the open ones).

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

`http.fetch(url, { bodyMedia })` (since 1.217.0) sends one of the plugin's
**own media files** as the request body — the host streams it from the media
store (decrypted on the way, never through the plugin process). Made for
Microsoft Graph attachments (Mail): small files base64 in the JSON body,
large ones raw in byte ranges to an upload session. Same checks as
`http.fetch` (internet hosts of `plugin.json`, public addresses only,
pinned); `method` `POST` (default), `PUT` or `PATCH`; a streamed body never
follows a redirect (the 3xx comes back). Feature test:
`typeof gc.http.MEDIA_BASE64 === 'string'` (older hosts ignore `bodyMedia`
and would send no body).

```js
// raw: the file (or the byte range start…end, inclusive) as it is
await gc.http.fetch(session.uploadUrl, {
  method: 'PUT',
  bodyMedia: { mediaId, start: 0, end: 2949119 },  // without start/end: the whole file
  timeoutMs: 5 * 60 * 1000,                          // 1 s … 30 min, default 10 min with bodyMedia
});
// → Content-Length: 2949120, Content-Range: bytes 0-2949119/<size of the file> (only with start/end),
//   Content-Type: the plugin's header, else the media's type

// base64 into JSON: exactly one string value of `json` is gc.http.MEDIA_BASE64
await gc.http.fetch(`https://graph.microsoft.com/v1.0/me/messages/${id}/attachments`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}` },
  json: { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Rechnung.pdf', contentType: 'application/pdf',
    contentBytes: gc.http.MEDIA_BASE64 },          // '{{gc:media:base64}}' — replaced by the whole file in base64
  bodyMedia: { mediaId },
});
// base64 alone: bodyMedia: { mediaId, encoding: 'base64' } → the body is the file in base64 (Content-Type text/plain
// unless the plugin sets one), e.g. a MIME message for Graph's sendMail
```

* Raw: at most **64 MB** per request (`ERR_MEDIA_TOO_LARGE`) — larger files
  go in ranges. `Content-Length` and `Content-Range` are always the host's;
  the plugin's own are dropped. `0 ≤ start ≤ end < size`, else `ERR_INVALID`.
* Base64 (`encoding: 'base64'` or `json`): the whole file, at most **4 MB**
  of file (`ERR_MEDIA_TOO_LARGE`), no range. The placeholder must be a whole
  string value, exactly once (`ERR_INVALID` otherwise; a string that merely
  contains it stays as it is, keys never count); the rest of `json` ≤ 1 MB.
  `Content-Type: application/json` unless the plugin sets one.
* `bodyMedia` replaces `body`, `form` and `bodyBase64` (`ERR_INVALID` with
  them). Only the plugin's own files (`media` in `plugin.json`, else
  `ERR_MEDIA_DENIED`; an id of another plugin → `ERR_INVALID`), claimed or
  not. Errors otherwise like `http.fetch` (`ERR_NET_DENIED`, `ERR_NET`) and
  `ERR_TIMEOUT`; the host call waits as long as `timeoutMs`.

Why an option of `http.fetch` and not an API of its own: the request is an
ordinary request of the plugin to its own internet hosts — headers, answer
and checks stay exactly those of `http.fetch`; only where the body comes
from changes. The placeholder keeps the JSON in the plugin's hands while the
bytes stay in the host, and needs no template language: one value, replaced
once, after `JSON.stringify` (base64 needs no escaping).

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

`http.fetchImage(url, opts)` (since 1.216.0, `permissions.network.images:
true`) loads one picture from **any public host** — the pictures of a mail,
so the sender sees GateControl, never the reader. Not in the plugin process
without the permission (`typeof gc.http.fetchImage === 'function'` is the
feature test):

```js
const { status, mime, bytes } = await gc.http.fetchImage('https://news.example/logo.png', {
  maxBytes: 2 * 1024 * 1024,   // default 2 MB, at most 5 MB
  timeoutMs: 10000,            // default 10 s, at most 15 s (all hops together)
});
// bytes: a Buffer; mime: the picture format found in the bytes
```

* GET only, `http:`/`https:` on ports 80, 443, 8080 and 8443; every resolved
  address must be public — the same check as `http.fetch` (no allowlist, but
  private, loopback, link-local, CGNAT, ULA, multicast, reserved, WireGuard,
  Docker and own addresses are refused), pinned to the checked address.
* At most 5 redirects, every hop checked again (a redirect to a private
  address → `ERR_NETWORK_DENIED`).
* No cookies, no `Referer`, a neutral `User-Agent`
  (`Mozilla/5.0 (compatible; ImageProxy)`), `Accept: image/*`.
* The answer must be a picture: `Content-Type: image/*` (never
  `image/svg+xml`) **and** the bytes of a known format (JPEG, PNG, GIF, WebP,
  BMP, ICO, AVIF/HEIC, TIFF) — else `ERR_INVALID`; `mime` is the format the
  bytes have.
* 8 pictures per plugin at a time (more wait).
* Errors: `ERR_NETWORK_DENIED` (no permission, address or port refused),
  `ERR_INVALID` (arguments, not a picture), `ERR_MEDIA_TOO_LARGE` (more than
  `maxBytes`), `ERR_HTTP` (not 2xx, with `status`), `ERR_TIMEOUT`, `ERR_NET`
  (unreachable, too many redirects). Note: `gc.http.fetch` keeps its
  `ERR_NET_DENIED`.

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
  async mediaScanned({ mediaId, state, blocked, finding }, gc) {  // optional (`media`, since 1.223.0): the virus scan changed a file
  },                                        // (see "Virus scan" under "Media")
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
  async publicRequest({ method, path, query, headers, user, token, body, url, originalUrl, proofUrl }, gc) {  // optional
    return { status: 200, json: {} };       // (`publicEndpoints`, since 1.211.0) — see "Public endpoints"
  },
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
| `gc.http.fetch(url, opts)` | internet hosts; since 1.217.0 `opts.bodyMedia: { mediaId, start, end, encoding }` sends a media file of the plugin as the body, streamed by the host (`gc.http.MEDIA_BASE64` as the one `json` value → the file in base64) — see "Network" |
| `gc.http.websocket(url, opts)` | WebSocket to an internet host (events `message`, `close`, `error`; `send`, `close`; since 1.184.0) |
| `gc.http.fetchImage(url, { maxBytes, timeoutMs })` | since 1.216.0 (`network.images`): a picture of any public host → `{ status, mime, bytes }` — see "Network" |
| `gc.mail.imap.connect({ host, port, security, auth, timeoutMs })` | since 1.216.0 (`mail`): an IMAP session held by the host → session (`list`, `status`, `open`, `fetch`, `message`, `download`, `search`, `flags`, `move`, `copy`, `expunge`, `append`, `idle`, `noop`, `close`; events `exists`, `expunge`, `flags`, `close`, `error`) — see "Mail" |
| `gc.mail.smtp.send({ host, port, security, auth, message, appendCopy })` | since 1.216.0 (`mail`): send a mail → `{ messageId, accepted, rejected, raw }` — see "Mail" |
| `gc.mail.smtp.verify({ host, port, security, auth, timeoutMs })` | since 1.217.0 (`mail`): log in to an SMTP server without sending → `{ ok: true }`, errors like `smtp.send` — see "Mail" |
| `gc.mail.compose(message)` / `gc.mail.parse(mediaId, opts)` | since 1.216.0 (`mail`): RFC 822 as media ↔ the parsed message; since 1.219.0 with `message.icalEvent` and `calendar` (invitations, iMIP) — see "Mail" |
| `gc.mail.sanitize(html, { images: 'placeholder' })` | since 1.216.0 (`mail`): mail HTML made harmless → `{ html, images, trackers }` — see "Mail" |
| `gc.mail.autoconfig(email)` | since 1.216.0 (`mail`): IMAP/SMTP servers of an address → `{ imap, smtp, source }`; since 1.219.0 also `caldav`, `carddav` — see "Mail" |
| `gc.mail.dav.request({ url, method, headers, body, auth, timeoutMs, maxBytes, parse })` | since 1.219.0 (`mail.dav`): one CalDAV/CardDAV request to a server people enter → `{ status, url, headers, body, multistatus }` — see "Mail" |
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
| `gc.media.copy(id, { area, path, claim, user })` | since 1.215.0: a second, independent file of the plugin with the same bytes, copied on the server (on the storage target itself where it can) → `{ id, mediaId, size, bytes, sha256, mime, name, area, path, claimed, method }` — see "Copies" |
| `gc.net.uploadTarget(id, path, { form: { fields, file }, mediaFrom, query, headers, timeoutMs })` | since 1.193.0: a media file as `multipart/form-data` to an assigned home target, streamed → like `fetchTarget` — see "Network" |
| `gc.publicLinks.create/list/get/revoke` | since 1.193.0: download links without login for some of the plugin's media (`publicLinks`, only while an administrator allows them) — see "Public links" |
| `gc.publicEndpoints.token({ user, path, ttlS, data })` / `gc.publicEndpoints.base()` | since 1.211.0: tokens for requests without a session under `/plugin-public/<id>/…` (`publicEndpoints`) — see "Public endpoints" |
| `gc.devices.list({ userId })` | since 1.193.0: the person's GateControl apps `[{ id, name, platform, clientType, appVersion, online, lastSeen, via }]` (`devices`) — see "Devices" |
| `gc.notify({ …, users, devices, silent, data })` | since 1.193.0: only to these devices of `users`; `silent: true` a data notification without display (`devices`) — see "Devices" |
| `gc.homeNetwork.presence.list()` / `.on(handler)` / `.consent(userId)` / `.setConsent(userId, on)` / `.devices(userId)` / `.setCounts(userId, deviceId, on)` | since 1.230.0: who is at home by their phone in the home network — only people who agreed themselves, never MAC/IP addresses (`homePresence`) — see "Presence over the home network" |
| `gc.homeNetwork.internet.status(userId)` / `.pause(userId, untilISO \| minutes)` / `.resume(userId)` / `.extend(userId, minutes)` | since 1.231.0: the home DNS filter of a person — pause the internet, suspend the profile's times; changes only on behalf of a signed-in person (`homeInternet`), since 1.259.0 also for the person an automation names (`{ actor }`) — see "Internet at home" |
| `gc.homeCache.offer({ mediaId, kind, userIds, priority })` / `.withdraw(mediaId)` / `.lanHint(sha256 \| { mediaId }, req)` | since 1.231.0: keep the plugin's files on the gateways' home caches and send an app in the home network there (`homeCache`) — see "Home cache"; since 1.249.0 also GateControl's previews of them (`preview`, `.lanHints([…], req)`) |
| `gc.ai.available({ capability })` / `gc.ai.status()` | since 1.214.0: is AI usable for the plugin (asks no provider) / `{ available, mediaAllowed, capabilities, budgetLeftCents }` (`ai`) — see "AI requests" |
| `gc.ai.extract({ task, user, instructions, input, schema, maxOutputTokens, timeoutMs })` / `gc.ai.generate({ … })` | since 1.214.0: structured data checked against a schema / free text from the AI provider set up in GateControl → `{ ok, data \| text, provider, model, usage, fallback }` (`ai`) — see "AI requests" |
| `gc.groups.list/get/members/isMember/leadersOf(…)` | the person groups of GateControl (`groups`) — see "Groups" |
| `gc.groups.ensure({ key, name, kind, parentKey, members })` / `gc.groups.remove(key)` | the plugin's own groups (`groups: "manage"`) — see "Groups" |
| `gc.notify({ …, groups: [id] })` | to the groups' enabled members, subgroups included, resolved at send time (`groups`) — see "Groups" |
| `gc.cloud.available/connectUrl/connections/disconnect/list/import(…)` | Google Drive / OneDrive of a person (`cloudImport`) — see "Cloud import" |
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

A plugin needs no `permissions.kiosk` to show something on a kiosk device:
its sections in the tab "Zuhause" (`ui.portal.sections`, `tab: 'home'`) are
shown there whenever `portalVisible({ user, section })` says yes for the
kiosk viewer — and its API decides what such a viewer may call (answer
`user.kiosk` with as little as the section needs). Pictures for such a
section: `gc.media.previews(ids, { user, previewOnly: true })` (since
1.210.0, see "Previews") — the preview in display size, never the file.

## Notifications

`gc.notify` reaches the GateControl apps through the notification center
(docs/feature-notification-center.md) — pushed by GateControl itself, no
third-party service. Both forms need `permissions.notify` and share the limit
of **30 per hour and plugin** — or `n` with `"notify": { "perHour": n }`
(1 ≤ n ≤ 1000 since 1.219.0, before 120 — e.g. the event reminders of
everybody through one plugin; the install dialog shows "bis zu n
Push-Mitteilungen pro Stunde"); every call also writes the `plugin_notice` activity entry (and its
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

### Notifications by e-mail (since 1.225.0)

Plugins have no mail sender of their own and get none: there is **no API to
mail an address**. Instead a push can also reach its people by e-mail —
through GateControl's own SMTP server (Einstellungen › E-Mail) to each
person's **account address** (Benutzer › the person › E-Mail). The people
are the push's own recipients (`users`, `groups`, or the topic's rule —
default its subscribers), so a plugin can only ever reach GateControl
people, never anybody else.

* **Per person and topic** a switch "Auch per E-Mail an …" in the portal
  (Benachrichtigungen, under the topic's own switch) and in the apps
  (`GET/PUT /api/v1/client/push/prefs` `email_topics`), next to the topic
  switch, quiet hours and chat routes. Default: **on** for a topic declared
  with `"email": true` in `notifyTopics[]`, **off** for every other plugin
  topic (incl. `default`) — a person can switch it on there. Core topics and
  chat topics have no e-mail channel.
* Who gets the mail: the push's people who did not switch the topic off
  (`critical` reaches them anyway, like the push), have the e-mail switch on,
  and have a valid address. Each person gets an own mail (no shared `To:`)
  in their language: subject `[GateControl] <title>`, text = title, body and
  a footer naming the plugin, the topic and where to unsubscribe (with a link
  to the portal when `GC_BASE_URL` is set). No HTML, no pictures, no buttons.
* Never mailed: chat topics, silent data pushes (`silent: true`), pushes to
  single `devices`. Nothing goes out without SMTP, without the licence
  feature `email_alerts`, with the notification center off or the topic's
  rule off (System › Benachrichtigungen).
* At most **200 mails per plugin and hour** (every recipient counts); more
  are dropped and logged. The push budget (`permissions.notify`) applies as
  before; the e-mail does not count against it.
* `gc.notify` answers as before (`{ pushed, id }`) — the plugin learns
  nothing about addresses or who got a mail.
* The install dialog names topics mailed by default ("Meldungen per E-Mail:
  schickt Mitteilungen zu <topics> standardmäßig auch per E-Mail an die
  Empfänger …"); an update that adds one shows it as a new permission.
* Independent of the rule's own "E-Mail" channel (System ›
  Benachrichtigungen › the topic), which still sends one mail to the
  administrators' notification address.
* **Older GateControl** (before 1.225.0) ignores `email` — the push goes out
  as before, without e-mail.

```json
"notifyTopics": [
  { "id": "booking", "label": { "de": "Buchungsanfragen", "en": "Booking requests" }, "email": true }
]
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
  the portal and on the admin page. When `media.types` take videos (a
  `video/…` type, `video/*` or `*/*`) the `<iframe>` also gets
  `allow="fullscreen *"`: a `<video>` of the plugin's media URLs (or the
  frame's own element, `requestFullscreen()`) goes full screen. Older hosts
  give it only to `permissions.cameras`; check `document.fullscreenEnabled`. Since 1.178.0 their sandbox (the CSP
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
* **Copies** (since 1.215.0): `gc.media.copy(id, opts)` — see "Copies (`gc.media.copy`)"
  below the media areas.

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
    503 preview_pending    more than 32 device previews wait at once, or not done within 20 s (Retry-After)
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
    `gc.media.previews` hands them out ready to use (since 1.210.0 also as
    preview-only URLs, see below).
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
  `ERR_INVALID` for bad ids, `user`, `ttlS`, `previewOnly`.
  * **Preview-only URLs** (since 1.210.0): `{ previewOnly: true }` signs `url`
    with a token of its own that opens `/plugin-media/<token>/preview`
    (`?size=large` too) and nothing else — `/plugin-media/<token>` (the file
    itself) answers `404` with it; every state then has `previewOnly: true`.
    For a viewer who may see a picture in display size but not have the
    original (full resolution, EXIF with the place it was taken) — e.g. the
    photo frame of GateControl Drive on a kiosk device. An older GateControl
    drops the option (states without `previewOnly`, the ordinary URL): a
    plugin that relies on it checks `previewOnly === true`.
* **At rest** next to the file: `<file>.ps` (small) and `<file>.pl`
  (large), AES-256-GCM under a key derived (HKDF) from the file's own key;
  `<file>.pc` marks a device preview, `<file>.px` a file the server could not
  read. They go with the file (delete, clean-up of unclaimed files, "Alles
  löschen"); a hand-over (`gc.media.handOver`) links them to the new file.
  They do not count against the quota, stay on this server when an area's
  files go to a storage target (the area cache never drops them) and are not
  in backups — the server makes them again, a device preview is gone after a
  restore.
* **Home cache** (since 1.249.0): a plugin with `permissions.homeCache` may
  offer them to the home gateways (`gc.homeCache.offer({ mediaId, preview:
  'small' })`, see "Home cache") — the plaintext JPEG goes to the gateway,
  the apps at home load it from there.
* The install dialog shows **Vorschaubilder**: "GateControl macht kleine
  Vorschaubilder der Bilder … und nimmt die Vorschaubilder der Apps für Fotos
  und Videos an, die der Server nicht lesen kann".

### Virus scan (since 1.223.0)

Every stored file is checked right after it is stored (Einstellungen ›
Sicherheit › Virenscan): `scan: { state, blocked, finding }` in upload
answers and `gc.media.info`, `423` (`scan_pending` / `quarantined` /
`scan_blocked`) for files the scan holds back, `422 infected` / `503
scan_unavailable` on uploads, the hook `mediaScanned` and the host API codes
`ERR_MEDIA_QUARANTINED`, `ERR_MEDIA_SCAN_PENDING`, `ERR_MEDIA_BLOCKED`,
`ERR_MEDIA_INFECTED`. The full contract — states, codes, sources and what
Drive, GateDrop, Mail and Messenger show — is
[feature-malware-scan-contract.md](feature-malware-scan-contract.md).

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

### Copies (`gc.media.copy`)

Since 1.215.0. A file of the plugin becomes a **second, independent file of
the same plugin** with the same bytes — Drive's "Kopieren", done on the server
(it goes on while the app is closed; no device downloads and uploads the
bytes again). Feature check: `typeof gc.media.copy === 'function'`. Code:
`copy` in `src/services/plugins/media.js`, `copyOnTarget` in `mediaAreas.js`.

```js
const c = await gc.media.copy(mediaId, { area: 'family', path: 'Fotos/Kopie von a.jpg', claim: true, user: 12 });
// → { id, mediaId, size, bytes, sha256, mime, name, area, path, claimed, method }
```

* Only the plugin's **own** files: an id of another plugin is "unknown"
  (`ERR_INVALID`), exactly like an id that does not exist. The copy belongs
  to the same plugin; there is no way to copy into another plugin (that is
  `gc.media.handOver`, with its permission).
* `opts` (all optional, other keys → `ERR_INVALID`):
  * `area` — the destination area (`media.areas`, it must exist; without
    `media.areas` → `ERR_MEDIA_DENIED`). Default: the source's area; `null`:
    no area.
  * `path` — the path in the destination area, as for `gc.media.claim`
    (normalised, unique in the area → `ERR_CONFLICT`; without an area →
    `ERR_INVALID`). Default: none.
  * `claim` — `false` (default): the copy is **unclaimed** like every new file
    and goes after 24 h unless the plugin keeps it with `gc.media.claim(id)`
    (without options it keeps the area and the path of the copy). `true`: kept
    at once.
  * `user` — the owner (an enabled account). Default: the source's owner.
* The answer: `id` (= `mediaId`) the new media id, `size` (= `bytes`),
  `sha256` and `mime` as the source's, `name` the source's display name,
  `area`, `path`, `claimed`, and `method` — `'target'` (copied on the storage
  target itself), `'link'` (a hard link of the sealed file here) or `'copy'`.
* **Where the bytes go**:
  * the source lies on the storage target of the destination area in that
    area's form → copied **on the target**: S3 `CopyObject` (above 5 GiB a
    multipart upload of `UploadPartCopy` parts), WebDAV `COPY` with
    `Overwrite: F`, a folder of this server `copyFile` (a reflink where the
    file system can). No byte travels through GateControl. A readable file
    that changed on the NAS since it was stored, a name already taken on the
    NAS (never overwritten) or a target without a server-side copy (SMB,
    Google Drive, OneDrive) take the next way;
  * else the sealed file **here** (fetched from the target into the cache
    first when only the target has it) → a hard link, else a copy; an area on
    a storage target gets it from the background worker once the copy is
    claimed (`gc.media.info(id).stored`: `pending` → `target`).
* **Encryption at rest**: the file key of the source is wrapped again for the
  new id (its own `key_enc`, bound to the new id); previews (`media.previews`)
  are linked along. Each id has its own directory entry or its own object on
  the target — deleting one never touches the other.
* **Quotas**: the plugin's quota and the destination area's quota count the
  copy (`ERR_MEDIA_QUOTA`, checked before and again right before the file is
  added, so parallel copies cannot pass them). A copy made here also needs
  free space on this server (`ERR_MEDIA_QUOTA`, `server_full`); a source that
  must come from a failing target → `ERR_BUSY` (later again). `maxBytes` and
  `types` are not checked again — the file is in the plugin already.
* **Nothing half-done**: the file only appears once its bytes are complete
  and checked; on an error the temporary file goes at once, an object copied
  on a target is deleted by the worker (it is covered by an entry in
  `plugin_media_gone` from before the copy, due after 2 hours — so even a
  server that stops in the middle leaves nothing behind).
* At most **4 copies per plugin** run at once, further calls wait their turn;
  each ends within **30 minutes** (`ERR_TIMEOUT`, nothing left behind — a
  source still being fetched into the cache finishes there, so a new attempt
  is quick).
* Errors: `ERR_MEDIA_DENIED`, `ERR_INVALID`, `ERR_CONFLICT`,
  `ERR_MEDIA_QUOTA`, `ERR_BUSY`, `ERR_TIMEOUT`.
* Storage target drivers (docs/storage-targets.md) have an optional
  `copy(from, to)` since 1.215.0 (folder, WebDAV, S3).

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
  files: [{ mediaId, name: 'Strand.jpg' }],   // 1 … 5000 (before 1.215.0: 20) CLAIMED files of the plugin; name optional (default: the media's); path since 1.215.0
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
GET  /s/<token>/zip         all files as one ZIP (stored, streamed, Content-Length known, ZIP64 beyond 4 GiB and for files of 4 GiB or more)
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

### A free choice of files and folders (since 1.215.0)

A link of kind `files` can carry a whole selection — files and folders,
resolved by the plugin into files with their sub folder — as one link and one
ZIP:

```js
await gc.publicLinks.create({ ownerUserId: 12, title: 'Auswahl', expiresAt: Date.now() + 7 * 86400000, files: [
  { mediaId: a, name: 'Strand.jpg', path: 'Urlaub/2026' },   // Urlaub/2026/Strand.jpg in the ZIP
  { mediaId: b, name: 'Notizen.pdf' },                       // at the top
] });
```

* Up to **5000** files (before: 20), together at most **1 TB**
  (`ERR_INVALID`).
* `path` (optional): the sub folder of the file on the page and in the ZIP —
  relative and normalised like a path of an area (`a//b/` → `a/b`); a leading
  `/`, a backslash, `.` / `..` segments, control characters or more than 1024
  characters → `ERR_INVALID`. `''` / `null`: the top.
* The page shows one folder at a time (`?p=<sub folder>`, breadcrumbs, its
  folders and files, at most 2000 of each per folder — the ZIP has all of
  them). Without any `path` it looks as before. Files `/s/<token>/f/<n>` with
  n = 1 … 5000.
* The ZIP keeps the folders (`path/name`). Every ZIP name — of folder links
  too — is made safe for any extractor: no `..` or `.` segments, nothing
  absolute, a backslash and `:` become `_`, no control characters. Equal names
  (case-insensitive) get " (2)", " (3)", …, and so does a file named like a
  folder. A file of 4 GiB or more carries ZIP64 sizes (before, folder ZIPs
  refused it with 413).
* `list` / `get`: every file also has `path` (or `null`). Downloads,
  `maxDownloads`, the ZIP counting each file once, and "the link ends when one
  of its files is deleted" are as before. Links created before keep working
  unchanged. Migration 120 (`plugin_public_link_files.path`).

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

## Public endpoints (`permissions.publicEndpoints`)

Since 1.211.0. Some services must call a plugin **without** a GateControl
session — an office server (Collabora Online, OnlyOffice) calling the WOPI
host of GateControl Drive to read and save a document a person edits in the
browser. No cookies, no CSRF, no login: each request carries a token the plugin
minted for **one person** and **one path prefix**, valid for a short time.
Code: `src/services/plugins/publicEndpoints.js`, `src/routes/pluginPublic.js`.

```js
const { token, url, expiresAt } = await gc.publicEndpoints.token({
  user: 12,                 // required: an enabled account — the hook gets it as `user`
  path: 'wopi/files/42',    // required: the prefix the token opens (segments of [A-Za-z0-9._~-], ≤ 200)
  ttlS: 4 * 3600,           // optional: 60 … 86400 s, default 3600
  data: 'write',            // optional: a string ≤ 256 the hook gets back (`token.data`), e.g. the rights
});
// url: '<GC_BASE_URL origin>/plugin-public/<id>/wopi/files/42' (null without GC_BASE_URL)
await gc.publicEndpoints.base();   // → { url: '<origin>/plugin-public/<id>/' } | { url: null }
```

The token is an HMAC-SHA256 (server secret) over the plugin id, the person,
the path, the expiry and `data`; the server keeps no list of them, so a token
cannot be revoked — keep `ttlS` short and check the person's rights in the hook
on every request. It travels as `?access_token=<token>` (WOPI) or
`Authorization: Bearer <token>`.

```
GET | HEAD | POST | PUT  /plugin-public/<id>/<path>?access_token=<token>
```

* **404** — unknown plugin, or one without `permissions.publicEndpoints`;
  **401** — no token, a forged or expired one, one of another plugin, another
  path (the path must be the token's or below it: `wopi/files/42/contents`),
  or the person is disabled now; **405** — another method.
* **Body** (POST / PUT with `Content-Length` > 0): only with `maxBodyBytes`,
  `Content-Length` required (411), larger → 413, a JSON or form body (parsed by
  the server) → 415. It is streamed into the media store like an upload link's
  file (`application/octet-stream`, the plugin's quota, the room on the server)
  as an **unclaimed** file of the token's person; the hook gets `body: {
  mediaId, bytes, sha256, mime }`. When the hook fails or answers ≥ 400 and has
  not claimed it (`gc.media.claim`), the file is deleted at once.
* **Hook** `publicRequest({ method, path ('/wopi/files/42'), query (without
  access_token), headers, user: { id, name, role }, token: { scope, data,
  expiresAt }, body, url, originalUrl, proofUrl, lang })`, within the request
  timeout (30 s). `headers`: `x-…` (not `x-forwarded-*`, `x-real-ip`,
  `x-api-token`, `x-csrf-token`), `content-type`, `content-length` — never
  cookies or `authorization`. `originalUrl` (path and query) and `url`
  (`<GC_BASE_URL origin><originalUrl>`) come **without** `access_token`.
  `proofUrl` — the URL exactly as called, the token included — only for a
  request that carries `X-WOPI-Proof` / `X-WOPI-ProofOld` (WOPI proof keys sign
  token and URL), else `null`; use it for that check only, never log it.
* **Logs:** GateControl logs no URL of these routes (the error handler only
  the path). A reverse proxy in front of it may log query strings — the reason
  to keep `ttlS` short.
* **Answer** — `{ status, headers, … }`, status 200–299 or 400–599 (no
  redirects), `headers` only `x-…` names (never `x-frame-options`,
  `x-content-type-options` and the like), single-line values ≤ 1024 characters:
  * `json: <value>` — JSON (≤ the plugin answer limit);
  * `text: '…'` — `text/plain`, ≤ 64 KB;
  * `media: '<media id>'` — one of the plugin's files as a download
    (`Range` works, `Content-Disposition: attachment`);
  * `form: { action, fields }` — a small page of **this server** that posts
    `fields` (≤ 10, names `[A-Za-z0-9_.-]`, values ≤ 8 KB) to `action` (an
    absolute http(s) URL — never GateControl's own host: neither the host of
    `GC_BASE_URL` nor the one the request came to, whatever scheme or port;
    such a page could post to GateControl's routes with the person's cookies →
    502) at once — e.g. an office editor's URL with the WOPI
    `access_token`; CSP `form-action <that origin>`, a nonce script, no
    framing. A plugin's own HTML never reaches GateControl's origin;
  * none of these: an empty body.
  Anything else → 502; the hook failing → 502, not running → 503, timeout → 504.
* Every answer: `Cache-Control: no-store`, `nosniff`, `Referrer-Policy:
  no-referrer`, `X-Robots-Tag: noindex`, `Content-Security-Policy: default-src
  'none'; sandbox` (the form page: its own); no cookie is ever set or read.
* **Rate limits** per address: 1200 requests per minute (an office server calls
  from one address for everyone editing); requests answered 401 or 404 also
  count in a bucket of 60 per 10 minutes — after that the address gets 429.
* Errors of `gc.publicEndpoints.*`: `ERR_PUBLIC_ENDPOINTS_DENIED` (no
  permission), `ERR_INVALID` (person, path, `ttlS`, `data`).

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

## Presence over the home network (`permissions.homePresence`)

Since 1.230.0 (gateways phase 3a). A home gateway with the **network watch**
(Gateways › Netzwerk) sees the devices in the home network. An administrator
assigns a device to a person and marks it "zählt für Anwesenheit"; once that
**person themselves** agrees, the gateway watches the device and reports
"in the Wi-Fi" / "gone" (gone only after 10 minutes without a sign — the
gateway's hysteresis). A plugin with the permission — the family plugin's
"Wer ist zu Hause?" — gets **only** "at home" / "away" per person. It never
gets MAC or IP addresses, never which device, never anything about people who
did not agree. Code: `src/services/homePresence.js`, host API in
`src/services/plugins/hostApi.js` (`presenceCall`), the person check in
`src/services/plugins/personContext.js`.

```json
"permissions": { "homePresence": true }
```

The install dialog shows it as "Anwesenheit im Heimnetz". Without it,
`gc.homeNetwork` does not exist in the plugin process and the host answers
`ERR_HOME_PRESENCE_DENIED`.

| Call | Answer / rule |
|---|---|
| `gc.homeNetwork.presence.list()` | `[{ userId, home: true \| false, since: ISO, source: 'wifi' }]` — every enabled person who agreed and has a known state (at least one counting device reported) |
| `gc.homeNetwork.presence.on(handler)` → `off()` | `handler({ userId, home, since, source: 'wifi' })` on every change of a person's state; `home: null` = no longer known (consent withdrawn, last counting device removed). Delivered to every running plugin with the permission (hook `homePresence`, best-effort, not repeated) |
| `gc.homeNetwork.presence.consent(userId)` | `{ consent: boolean, since: ISO \| null }` — whether the person agreed (not which devices) |
| `gc.homeNetwork.presence.setConsent(userId, enabled)` | `{ consent }` — **only inside a changing request (POST/PUT/PATCH/DELETE) of that very person** to this plugin (portal signed in, the app, or the plugin's admin page of that person); never in `tick`, a hook, a GET, for somebody else or on a kiosk device → `ERR_NOT_PERSON`. Call it only from the person's own explicit switch ("Über mein Handy im WLAN") |
| `gc.homeNetwork.presence.devices(userId)` | the person's own devices `[{ id, name, lastSeen: ISO \| null, counts: boolean, gateway: '<gateway name>' }]` — only inside a request of that person (`ERR_NOT_PERSON` otherwise). No address, no vendor. A device that several gateways of one home network see (failover pool, or the same LAN behind the same router) is listed once; `gateway` then names them all (`'Pi Keller / Pi Garage'`), and `setCounts` with its `id` changes it on all of them |
| `gc.homeNetwork.presence.setCounts(userId, deviceId, counts)` | `{ counts }` — the person decides which of their devices count (an iPad that stays at home: no); only a device of that person (`ERR_NOT_FOUND`), only in their changing request (`ERR_NOT_PERSON`) |

Errors: `ERR_INVALID` (unknown or disabled person, wrong types),
`ERR_NOT_PERSON`, `ERR_NOT_FOUND`, `ERR_HOME_PRESENCE_DENIED`.

What the gateway gets: `features.presence.macs` in its config pull holds only
the MACs of devices that count, belong to an enabled person who agreed, and
only while the network watch and "Anwesenheit" are switched on for that
gateway. Withdrawing the consent removes them at once (the gateway is told to
pull its config) and the plugins hear `home: null`.

Combining with the app as a second source (family plugin): "at home" as soon
as one switched-on source says so, "away" when all say so; `since` is the time
of the change the gateway saw.

Example (server part of a plugin with a portal tab):

```js
module.exports = {
  async start(gc) {
    gc.homeNetwork.presence.on(({ userId, home, since }) => { /* update the family's view */ });
  },
  async request(req, gc) {
    const me = req.user;              // the person in this request
    if (req.method === 'PUT' && req.path === '/presence/wifi') {
      return { json: await gc.homeNetwork.presence.setConsent(me.id, req.body.enabled === true) };
    }
    if (req.path === '/presence/devices') return { json: await gc.homeNetwork.presence.devices(me.id) };
    if (req.path === '/presence') return { json: await gc.homeNetwork.presence.list() };
    return { status: 404, json: {} };
  },
};
```

## Internet at home (`permissions.homeInternet`)

Since 1.231.0 (gateways phase 3b). A home gateway with the **DNS filter**
(Gateways › DNS-Filter) answers the name lookups of the home network and
filters per profile — the devices of a person (network watch: owner = the
person) follow the person's profile, with times ("Mo–Fr 21:00 – 07:00:
social networks, games and videos blocked"). A plugin with the permission —
the family plugin's screen time — pauses the internet of a person's devices
or suspends the times for a while. The gateway gets the person's MAC
addresses (`features.dns.pauses` / `extensions` of every gateway with the
filter on where the person has devices) and is told to pull its config at
once; the plugin **never** gets a MAC or IP address. Code:
`src/services/homeInternet.js`, host API `internetCall` in
`src/services/plugins/hostApi.js`.

```json
"permissions": { "homeInternet": true }
```

The install dialog shows it as "Internet zu Hause". Without it,
`gc.homeNetwork.internet` does not exist and the host answers
`ERR_HOME_INTERNET_DENIED`.

| Call | Answer / rule |
|---|---|
| `gc.homeNetwork.internet.status(userId)` | `{ userId, profile: { id, name, gateway } \| null, paused: ISO \| null, extended: ISO \| null, nextSchedule: { from, to (ISO), block: 'all' \| 'categories', categories: ['social' \| 'games' \| 'video'], active } \| null, devices: n, filtered: boolean }` — `filtered` = a gateway with the DNS filter on knows devices of the person (otherwise a pause changes nothing yet); `profile` / `nextSchedule` from the first such gateway. Any time (also in `tick`) |
| `gc.homeNetwork.internet.pause(userId, until)` | `until` = ISO time or minutes (whole number); at most 7 days ahead. Internet off for the person's devices except the always-allowed domains (GateControl itself) and the profile's own "Immer erlaubt" → `status` |
| `gc.homeNetwork.internet.resume(userId)` | ends a pause (an extension stays) → `status` |
| `gc.homeNetwork.internet.extend(userId, minutes)` | suspends the times of the person's profile: until the end of a running extension (else now) + `minutes`, at most 24 hours ahead; `0` ends it → `status`. The lists ("Immer sperren") keep filtering |

`pause`, `resume` and `extend` only work **inside a changing request
(POST/PUT/PATCH/DELETE) of a signed-in person** to this plugin (portal
signed in, the app, or the plugin's admin page) — never in `tick`, a hook,
a GET, on a kiosk device or a moment after the answer (`ERR_NOT_PERSON`;
since 1.259.0 an automation names its person instead, see below).
That person is the **actor**: the activity log says "Internet paused for
"Tim" until 18:30 (by Marc, plugin familie)". GateControl does not check
who may decide for whom — **the plugin checks that the person in the
request may** (the family plugin: a parent of that child). Errors:
`ERR_INVALID` (unknown or disabled person, wrong times), `ERR_NOT_PERSON`,
`ERR_HOME_INTERNET_DENIED`.

**Automations (since 1.259.0).** A rule a person set up runs in the
background (`tick`, a hook) or inside the request of somebody else — a
child's phone reports "at home" and the rule "Hausaufgaben" pauses the
internet. For that, `pause`, `resume` and `extend` take the person the
plugin acts for as a last argument:

```js
await gc.homeNetwork.internet.pause(childId, 30, { actor: rule.ownerId });
await gc.homeNetwork.internet.resume(childId, { actor: rule.ownerId });
await gc.homeNetwork.internet.extend(childId, 30, { actor: rule.ownerId });
```

`actor` is an enabled GateControl account (else `ERR_INVALID`) and wins
over the people in a request that happens to be in flight. The activity log
says "Internet paused for "Tim" until 18:30 (automatically for Marc, plugin
familie)", its details carry `automated: true`. As before GateControl does
not check who may decide for whom: **the plugin checks, when the automation
runs, that the named person may still decide** (the family plugin: still a
parent, the child still a minor of the family) and skips the step otherwise.
`gc.homeNetwork.internet.actors === true` tells a plugin that the host knows
`{ actor }`; an older host ignores the argument and answers
`ERR_NOT_PERSON` outside a request.

Example (family plugin, a parent's button "30 Minuten mehr"):

```js
async request(req, gc) {
  if (req.method === 'POST' && req.path === '/screen/extend') {
    if (!isParentOf(req.user.id, req.body.childId)) return { status: 403, json: { ok: false } };
    return { json: await gc.homeNetwork.internet.extend(req.body.childId, 30) };
  }
  if (req.path === '/screen/status') return { json: await gc.homeNetwork.internet.status(Number(req.query.childId)) };
  return { status: 404, json: {} };
}
```

## Home cache (`permissions.homeCache`)

Since 1.231.0 (gateways phase 3b). A home gateway with the **home cache**
(Gateways › Zwischenspeicher) keeps files in the home network; apps that are
at home load them from the gateway at LAN speed. The server still decides:
the gateway hands out a file only against a signature the server gave that
client for ten minutes. GateControl itself puts the app updates there (the
update check answers with a `lan` hint, see below); a plugin with the
permission offers **its own media** (plugin.json `media`, "Media") — the
Drive plugin its recently used and pinned files, photos — and, since 1.249.0,
**GateControl's previews** of it (`media.previews`, "Previews"), so the photo
and file grids of the apps load at home from the gateway as well. Code:
`src/services/homeCache.js`, host API `homeCacheCall` in
`src/services/plugins/hostApi.js`, the request reference in
`src/services/plugins/requestRefs.js`.

```json
"permissions": { "homeCache": true }
```

The install dialog shows it as "Zwischenspeicher im Heimnetz". Without it,
`gc.homeCache` does not exist and the host answers `ERR_HOME_CACHE_DENIED`.

| Call | Answer / rule |
|---|---|
| `gc.homeCache.offer({ mediaId, kind, userIds, priority, sha256 })` | `{ sha256, size, offered }` — `mediaId` a media id of this plugin; `kind` `'drive'` \| `'photos'` \| `'vault'` (an administrator switches each kind per gateway; vault — only encrypted files — is off by default); `userIds` (optional, ≤ 256) the people who use the file: only gateways where one of them has devices keep it (none = every gateway with the cache on); `priority` 0…100 (default 50; the stock is filled by priority up to the gateway's limit); `sha256` / `size` optional, checked against the stored file. Offering the same content again updates it; `offered: false` when the same content is in the stock already (an app update, another plugin) |
| `gc.homeCache.withdraw(mediaId)` | `{ removed }` — the gateways drop it at their next sync. A deleted media file leaves the stock by itself (hourly) |
| `gc.homeCache.lanHint(sha256 \| { mediaId }, req)` | `{ url, sha256, tlsSha256, exp } \| null` — `req` is the request the plugin is answering right now (its `req.homeRef`, only plugins with the permission get one). `null` unless the client is at the site of a gateway (same public address and one of its LAN addresses — the app sends them as `?local=` or header `X-GC-Local`, see the home-network check), the file is one this plugin offered, that gateway holds it (last report) and, with `userIds`, the person in the request is one of them. Outside such a request: `ERR_NOT_IN_REQUEST` |
| `gc.homeCache.offer({ mediaId, preview, kind, userIds, priority })` | since 1.249.0 — `preview` `'small'` \| `'large'`: GateControl's preview of the file in that size ("Previews", plugin.json `media.previews`, else `ERR_MEDIA_DENIED`) instead of the file → `{ sha256, size, offered, preview }` (the preview's own SHA-256 and bytes — the plaintext JPEG, never the sealed file). `kind` `'drive'` \| `'photos'` (a vault's file has no preview: `ERR_INVALID`); `sha256` / `size` are not taken. `ERR_NOT_FOUND`: no preview and none possible (a document, a HEIC without the device's preview); `ERR_PREVIEW_PENDING`: not made yet — GateControl makes it now in the background, offer it again at the next run. A preview counts against the gateway's limit like a file; it is a separate offer with its own priority and people: offering the file does not offer its previews and the other way round |
| `gc.homeCache.withdraw(mediaId, { preview })` | since 1.249.0: only that preview (`withdraw(mediaId)` alone: only the file, its previews stay) |
| `gc.homeCache.lanHint({ mediaId, preview }, req)` | since 1.249.0: the hint for that preview as it is stored now — the same rules as for a file (offered by this plugin, held, the person one of `userIds`) |
| `gc.homeCache.lanHints([sha256 \| { mediaId, preview? }, …], req)` | since 1.249.0: up to 500 hints in one call (one home-network check) → `[hint \| null, …]` in the same order; an entry that is wrong or not offered is `null`, more than 500 `ERR_INVALID`. For lists: a page of photos with the hint of each small preview |
| `gc.homeCache.previews` | since 1.249.0 `true`: this GateControl takes the `preview` key and has `lanHints`. An older one has neither — and its `offer` would ignore `preview` and offer the **file**: check `gc.homeCache.previews === true` first |

The app loads `url` (HTTPS on the gateway's LAN address, self-signed
certificate) **pinning** `tlsSha256` (SHA-256 of the certificate, hex),
checks the SHA-256 of the bytes against `sha256` and falls back to the
normal download on any error. `exp` = Unix seconds, ≤ 10 minutes; the
signature in the URL is `HMAC-SHA256(secret of the gateway, sha256 + "\n" + exp)`.

The same hint comes with the update check of the apps
(`GET /api/v1/client/update/check`): `lan: { url, sha256, tlsSha256, exp }`
next to `downloadUrl`, when the installer is in the home cache of the
gateway the device is at. Since 1.253.0 the check also names `sha256`, the
installer's SHA-256 as GitHub publishes it (`asset.digest`; absent for old
releases), so a client that downloads the installer itself checks the normal
download too. The Android app (APK from GitHub, not the Play build) loads
the update this way: from the gateway at home, else from `downloadUrl`, hash
and APK signature (the installed app's certificate) checked before Android's
installer opens.

**Previews in the cache** (since 1.249.0): a small preview is some 10–40 KB
(320 px), a large one 100–300 KB (1280 px) — thousands of them fit where a few
videos would. Offer the small ones with a **high priority** (the grids of the
apps need them first; Drive: 95) and the large ones only for what is likely
looked at (Drive: photos of the last 30 days, 45). They count against the
gateway's limit like any file and go first when the limit is reached only if
their priority is lower. A gateway lists at most 20 000 entries (files and
previews together). The gateway fetches the preview's plaintext JPEG from the
server (checked against its SHA-256 there); a device preview sent again is
other content — the hourly clean-up puts it in the stock under its new SHA-256
with the same people and priority, a preview that is gone leaves the stock.
In its answers the plugin adds the hint of each preview it lists, e.g. Drive's
`preview: { url, largeUrl, lan, largeLan }`; the app loads `lan` like a
file's hint (pinned, SHA-256 checked, any error → the normal preview URL) and
keeps the picture as before (a media id's preview never changes).

Example (Drive plugin):

```js
// a file got pinned "offline verfügbar" by Anna
await gc.homeCache.offer({ mediaId: file.mediaId, kind: 'drive', userIds: [anna.id], priority: 80 });
// GateControl ≥ 1.249.0: its small preview as well
if (gc.homeCache.previews === true) {
  await gc.homeCache.offer({ mediaId: file.mediaId, preview: 'small', kind: 'drive', userIds: [anna.id], priority: 95 });
}

// the app asks for a download link
async request(req, gc) {
  if (req.path === '/files/link') {
    const f = findFile(req.query.id, req.user);
    return { json: { url: gc.media.url(f.mediaId, { user: req.user.id }), lan: await gc.homeCache.lanHint({ mediaId: f.mediaId }, req) } };
  }
  if (req.path === '/photos') {
    const page = listPhotos(req.user);
    const lan = gc.homeCache.previews === true ? await gc.homeCache.lanHints(page.map((p) => ({ mediaId: p.mediaId, preview: 'small' })), req) : [];
    return { json: { items: page.map((p, i) => ({ ...p, previewLan: lan[i] || null })) } };
  }
}
```

## Print & scan (`permissions.print`)

Since gateways phase 3c (gateway 1.24.0+ with the capability `print`). A home
gateway with **Drucken & Scannen** switched on (Gateways › Funktionen ›
„Geräte im Heimnetz“) finds the printers and scanners of its home network
itself — mDNS `_ipp`/`_ipps`/`_uscan`/`_uscans`, IPP for printing, eSCL for
scanning — and reports them with their state and ink levels. A plugin with the
permission prints the files of its people there and scans into its own media.
The plugin "Drucken & Scannen" (`gatecontrol-print`) is built on it. Code:
`src/services/homePrint.js` (queue, scans, the gateway routes
`/api/v1/gateway/print/*`), `src/services/printPdf.js`, host API `printCall`
in `src/services/plugins/hostApi.js`; gateway side: `docs/print.md` of the
gateway.

```json
"permissions": { "print": true },
"media": { "types": ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"], "maxBytes": 52428800 }
```

To print plain text and office files (since 1.247.0) the plugin also lists
`text/plain` and the office types among `media.types`
(`application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
`…spreadsheetml.sheet`, `…presentationml.presentation`,
`application/vnd.oasis.opendocument.text`, `…spreadsheet`, `…presentation`,
`application/rtf`).

The install dialog shows it as "Drucken & Scannen". Without it, `gc.print`
does not exist and the host answers `ERR_PRINT_DENIED`. Printing reads the
plugin's **own media** (`media` in plugin.json), scanned pages and PDFs become
its media — `application/pdf` and `image/jpeg` must be among `media.types`.

| Call | Answer / rule |
|---|---|
| `gc.print.devices()` | `[{ id, name, model, location, ip, online, gatewayId, gateway, gatewayOnline, problem, printer, scanner, seenAt, reportedAt }]` — each device once (two gateways of one home network see the same printer: the online one wins). `printer: { state: idle\|processing\|stopped\|offline, reasons, color, duplex, formats, copiesMax, convert, markers: [{ name, color: '#RRGGBB', type, level: 0…100\|null, low }] }` (`convert`: for a printer without `application/pdf` the format its gateway turns PDF into — `image/pwg-raster`, `image/urf`, `application/pclm` (since 1.247.0), `image/jpeg` — or `null`; since 1.247.0 `office`: its gateway turns office files into PDF — „Office-Dateien drucken“ on, the service office running, gateway 1.33.0+ — and `media: { sizes, default, sources, sourceDefault, ready: [{ size, source }] }`: the paper sizes it names (PWG names of A4, A5, A6, Letter, Legal, photo 10×15 `na_index-4x6_4x6in`, 13×18 `na_5x7_5x7in`, 9×13 `oe_photo-l_3.5x5in`) and its trays (`main`, `photo`, `manual`, `tray-1` …; empty for an older gateway)), `scanner: { state, platen, feeder, duplex, color: ['bw','gray','color'], resolutions, formats, adf: loaded\|empty\|null }`. `problem: 'cert_changed'`: the device answers with another TLS certificate than at the first contact — nothing goes there until it is confirmed (`discover({ retrust })`) |
| `gc.print.discover({ retrust? })` | `{ asked }` — every online gateway with the function on searches again; `retrust: <device id>` drops that device's stored certificate fingerprint (an administrator confirmed the new one) |
| `gc.print.submit({ deviceId, mediaId, user, copies?, color?, duplex?, name?, media?, source? })` | the job (below). `mediaId` a file of this plugin (≤ 50 MB); its type counts by the **content** (`%PDF-`, JPEG, PNG … magic bytes — a PDF stored as `application/octet-stream` or named without `.pdf` is a PDF), the stored type only when the content says nothing. PDF as it is — to a printer that takes `application/pdf`, or whose gateway converts PDF (`printer.convert`, gateway 1.30.0+ with the capability `print-convert`: PWG raster, URF or JPEG at the printer's resolution, colour mode and paper); pictures (JPEG, PNG, WebP, HEIC, GIF, TIFF) as JPEG — or as a PDF page for a printer without JPEG. Since 1.247.0 also **plain text** (`text/plain` or a `.txt` name, no NUL bytes; UTF-8, UTF-16 with BOM or Latin-1) — made into a PDF on the server (Courier, A4), queued as PDF — and **office files** by their content (Word `docx`, Excel `xlsx`, PowerPoint `pptx`, OpenDocument `odt`/`ods`/`odp`, RTF): queued as they are (`format` the office type) for a printer with `printer.office`, the gateway makes the PDF; `pages` is what the file names (Word, PowerPoint, OpenDocument text) or 1, and the gateway reports the real count after converting. `media`/`source`: one of `printer.media.sizes` / `.sources` (else `ERR_INVALID`), null = the printer's default. Otherwise `ERR_PRINT_FORMAT` with `e.reason` (since 1.243.0): `file_type` (not a PDF, picture, text or office file), `damaged` (a PDF or picture that cannot be read), `printer` (the printer takes no PDF and names no format the gateway can make), `gateway_update` (the printer takes no PDF and its gateway is too old to convert), `convert_off` (converting is switched off on that gateway: Gateways › Funktionen › „Drucken & Scannen“ › „PDF für Drucker ohne PDF umwandeln“); since 1.247.0 for office files `office_off` („Office-Dateien drucken“ is off on the printer's gateway), `office_missing` (on, but its service office does not run yet — being set up, or the compose file lacks it), `gateway_update` (the gateway is older than 1.33.0) or `printer` (the printer takes no PDF and the gateway cannot convert for it). `copies` 1 … `copiesMax` (≤ 99), `color`/`duplex` only where the printer can. At most 20 open jobs per plugin and person (`ERR_PRINT_BUSY`) |
| `gc.print.testPage({ deviceId, user })` | a job with a test page (name of the printer, time, colour bars — grey for a black-and-white printer) |
| `gc.print.job(id)` / `gc.print.jobs({ since?, limit?, user? })` | `{ id, deviceId, gatewayId, user, name, format, bytes, pages, copies, color, duplex, media, source, state, error, message, createdAt, updatedAt, expiresAt, doneAt }` — only this plugin's jobs, newest change first (`limit` ≤ 500) |
| `gc.print.cancel(id)` | `{ canceled, state }` — only `queued` / `waiting` |
| `gc.print.pages({ mediaId })` | `{ pages, format, estimated? }` — before printing, for a page limit (PDF: its pages, a picture: 1, text: the pages of its PDF, an office file: what it names, else 1 with `estimated: true`) |
| `gc.print.scan({ deviceId, user, source?, mode?, resolution?, duplex? })` | `{ scanId }` — `source` `platen` \| `feeder` (default: the feeder when paper is in it), `mode` `document` (grey, 300 dpi) \| `photo` (colour) \| `bw`, `resolution` 150 \| 200 \| 300 \| 600. One scan per person at a time (`ERR_PRINT_BUSY`, also when the scanner is busy) |
| `gc.print.scanStatus(id)` | `{ id, state: scanning\|done\|failed\|canceled, error, pages: [{ n, mediaId, mime, bytes, thumb }], source, mode, resolution }` — pages are JPEG media of this plugin, owned by the person, **unclaimed** (claim or hand them over within 24 h); `thumb` a small JPEG preview as base64 (≤ 48 KB) |
| `gc.print.cancelScan(id)` | `{ canceled, state }` |
| `gc.print.pdf({ pages: [mediaId…], user, name, dpi? })` | `{ mediaId, pages, bytes, name }` — JPEG pages (others are converted) into one PDF, page size from `dpi` (default 300, the scan's resolution); unclaimed media of the person, ready for `gc.media.handOver` to Drive (`save_file`) |
| `gc.print.ocrAvailable()` | since 1.247.0: `{ available, gateways }` — a gateway with „Texterkennung“ on (Gateways › Funktionen › „Drucken & Scannen“, gateway 1.33.0+ with tesseract) is online |
| `gc.print.ocr({ pages: [mediaId…], user, name, dpi?, deviceId? })` | since 1.247.0: `{ ocrId }` — a **searchable PDF** of JPEG/PNG pages (≤ 100, ≤ 50 MB each), made by a gateway with „Texterkennung“ (German + English; the gateway of `deviceId` — the scanner — first, else any). `ERR_PRINT_OCR_UNAVAILABLE` (none online or none took it), `ERR_PRINT_BUSY` (≤ 3 per person; the gateway does one at a time, three waiting), `ERR_PRINT_FORMAT` (a page not JPEG/PNG) |
| `gc.print.ocrStatus(id)` | `{ id, state: queued\|running\|done\|failed\|canceled, page, pages, error, mediaId, bytes, text, name }` — `page`: pages done; on `done` `mediaId` is the PDF (unclaimed media of the person, named `name`) and `text` the recognised text (≤ 1 MB, for a search index — e.g. Drive's `save_file { text }`); `failed` with `error` `ocr_timeout` (4 min a page, 30 min in all), `ocr_failed`, `ocr_unavailable`, `download_failed`, `upload_failed`, `timeout` (no word from the gateway for 3 minutes) — then file the plain PDF (`gc.print.pdf`) |
| `gc.print.cancelOcr(id)` | `{ canceled, state }` |

Job states: `queued` → `sending` → `printing` → `done`; `waiting` while the
printer is off or busy (the gateway tries again every 2 minutes), `failed`
(`error`: `format_unsupported`, `convert_failed` — a PDF the gateway could
not convert, e.g. damaged or password-protected —, `convert_too_large`,
`printer_rejected`, `canceled_at_printer`, `aborted_at_printer`, …),
`canceled`, `expired` (not printed within **24 h**). `message: 'converting'`
on `sending`: the gateway is converting the PDF for the printer;
`'converting_office'`: it is making a PDF of an office file (since 1.247.0;
`office_starting` on `waiting`: its service office is not running yet,
`office_failed` / `office_timeout` on `failed`). On `printing` since 1.247.0:
`message` names why the printer stopped — `media-empty`, `media-needed`,
`media-jam`, `door-open`, `cover-open`, `toner-empty`, `marker-supply-empty`,
`input-tray-missing`, `output-area-full`, `paused`, `stopped`, `held` (no
message: it prints).
`message: 'unconfirmed'` on `done`: the printer took the file but did not say
it finished. Scan errors: `scanner_busy`, `feeder_empty`, `no_pages`,
`timeout` (no word from the gateway for 3 minutes), `cert_changed`,
`scan_failed`.

Rights are the plugin's: who may print, scan, how many pages a day, only black
and white — the plugin checks them before each call. The host only checks
that `user` is an enabled person and that the media belong to the plugin.
Other host API codes: `ERR_INVALID`, `ERR_NOT_FOUND` (device, job, scan,
media), `ERR_PRINT_OFFLINE` (the device's gateway is offline),
`ERR_PRINT_TOO_LARGE`, `ERR_PRINT_CERT_CHANGED`, `ERR_MEDIA_QUOTA`.

```js
// a person prints a PDF they uploaded in the portal (GC.upload → mediaId)
const { pages } = await gc.print.pages({ mediaId });
if (await pagesToday(user.id) + pages > limit) throw tooMany();
const job = await gc.print.submit({ deviceId, mediaId, user: user.id, copies: 1, color: false });

// scan two pages from the feeder, make a PDF and file it in Drive
const { scanId } = await gc.print.scan({ deviceId, user: user.id, source: 'feeder', mode: 'document' });
// … gc.print.scanStatus(scanId) until state 'done' …
const doc = await gc.print.pdf({ pages: s.pages.map((p) => p.mediaId), user: user.id, name: '2026-11-06 Scan.pdf' });
const h = await gc.media.handOver(doc.mediaId, { toPlugin: 'gatecontrol-drive', user: user.id });
await gc.services.call('gatecontrol-drive', 'save_file', { mediaId: h.mediaId, area: 'mine', path: 'Scans/' + doc.name }, { userId: user.id });
```

## Radio sensors (`permissions.radio`)

Since GateControl with phase 3c, step 2 ("Funk"). The gateways listen
passively to Bluetooth sensors (BTHome v2, Xiaomi with ATC/pvvx firmware);
the administrator takes the ones that belong to the house over in Gateway ›
Funk › "Übernehmen" and may name them. A plugin with `"permissions": {
"radio": true }` reads those — never the others, never anything that is not a
sensor:

```js
const list = await gc.radio.sensors();
// [{ id: 'ble:a4c138112233', gatewayId: 7, gateway: 'Pi Keller', mac: 'A4:C1:38:11:22:33',
//    name: 'Gartenhaus', model: 'Xiaomi LYWSD03MMC', format: 'pvvx',
//    values: { temperature: 8.9, humidity: 64, battery: 82 }, battery: 82, online: true, seenAt: '…' }]
```

`values` holds only what the sensor sends (numbers: `temperature` °C,
`humidity` %, `battery` %, `pressure` hPa, `illuminance` lx, `voltage` V,
`co2` ppm, …; flags: `window`, `door`, `opening`, `motion`, `occupancy`,
`moisture_wet`, `smoke`, …). `online` is false after 30 minutes without a
packet. Encrypted sensors (BTHome v2 with a key, Xiaomi MiBeacon v4/v5 with a
bindkey) deliver values once the administrator entered their key in Gateway ›
Funk; the key itself never reaches a plugin. Only gateways with Bluetooth switched on count. Without the permission
`gc.radio` does not exist and the host answers `ERR_RADIO_DENIED`; on an older
GateControl the permission is ignored and `gc.radio` is missing — check for it.

**Zigbee devices of zigbee2mqtt** (GateControl with the radio follow-ups, a gateway
newer than 1.31.0 with “zigbee2mqtt” chosen in Gateway › Funk). The same
permission reads and switches the devices paired there — every device the
gateway's zigbee2mqtt knows, set up completely and supported (no
administrator step like "Übernehmen": pairing is that step):

```js
const { gateways, devices } = await gc.radio.zigbee();
// gateways: [{ id: 7, name: 'Pi Keller', reportedAt: '…' }]  — these report their complete list:
//           a device of such a gateway that is missing in `devices` is gone (removed from the network)
// devices:  [{ id: 'z2m:001788010b2c3d4e', gatewayId: 7, gateway: 'Pi Keller', ieee: '00:17:88:01:0b:2c:3d:4e',
//              name: 'Wohnzimmer/Decke', model: '9290012573A', vendor: 'Philips',
//              kind: 'light', caps: { bri: true, ct: true, color: 'xy' },
//              values: { on: true, bri: 50, ct: 370, linkquality: 120 }, battery: null, online: true, seenAt: '…' }]
await gc.radio.command('z2m:001788010b2c3d4e', { on: true, bri: 40 });   // → { accepted: true }
```

`kind` is `light`, `plug` (also switches/relays), `cover`, `sensor` or `remote`;
`caps` names what can be set (`bri`, `ct`, `color: 'xy' | 'hs'`, `position`) and
what is measured (`power`, `battery`). `values` use the names of the Bluetooth
sensors plus `on`, `bri` (0–100), `ct` (mired), `pos` (0–100), `linkquality`,
`action` (last button press). `command(id, set)` takes `on`, `bri` 0–100, `ct`
mired, `xy` `[x, y]`, `hue` 0–65535 / `sat` 0–254 (converted for zigbee2mqtt),
`cover` `open|close|stop`, `pos` 0–100; anything else is `ERR_INVALID`, an
unknown id `ERR_NOT_FOUND`, a gateway whose zigbee2mqtt does not run
`ERR_RADIO_NOT_RUNNING`, one that does not answer `ERR_GATEWAY_UNREACHABLE`. The
command goes to the gateway, which publishes `zigbee2mqtt/<name>/set`; the new
state comes with the next report (at most 5 s later). Only gateways with
“zigbee2mqtt” chosen count; switched back to deCONZ, their devices are gone
from the list. On an older GateControl `gc.radio.zigbee` is missing — check for it.

A plugin page can be opened at one thing: `/plugins/<id>[/<page>]?focus=<kind>:<value>`
hands `focus` (`^[a-z]{2,12}:[A-Za-z0-9:._-]{1,64}$`) on to the page's frame as
the query `?focus=…` (read it from `location.search` in the frame). GateControl
uses it for "In Smart Home benennen" (`zigbee:<device MAC>`, `ble:<sensor MAC>`).

## Cameras (`permissions.cameras`)

Since GateControl with phase 3c, step 4 ("Kameras", gateway 1.28.0+ with the
capability `cameras`). A home gateway with **Kameras** switched on (Gateways ›
Funktionen › „Geräte im Heimnetz“) finds ONVIF/RTSP cameras in its home network,
takes snapshots, follows the cameras' own motion events (person, vehicle,
animal, motion — no image analysis on the gateway), records clips (stream copy,
5 s before to 10 s after, ≤ 2 min) onto a storage at the gateway host and hands
live video out over the tunnel. The plugin "Tür & Kamera" (`gatecontrol-door`)
is built on it. Code: `src/services/homeCameras.js`, host API `camerasCall` in
`src/services/plugins/hostApi.js`; gateway side: `docs/cameras.md` of the gateway
(the contract, also for the apps).

```json
"permissions": { "cameras": true }
```

The install dialog shows it as "Kameras im Heimnetz". Without it `gc.cameras`
does not exist and the host answers `ERR_CAMERAS_DENIED`; an older GateControl
ignores the permission and `gc.cameras` is missing — check for it.

| Call | Answer / rule |
|---|---|
| `gc.cameras.available()` | `{ available, gateways: [{ id, name, online, supported, enabled, service: managed\|absent\|missing, storage: { free, total, used, clips, problem }, hint }] }` — `hint` e.g. `{ key: 'one_motion', max: 1, motion, over }` on a Raspberry Pi 3 B+ (a hint, never a ban) |
| `gc.cameras.list()` | `[{ id, gatewayId, gateway, name, host, source: onvif\|rtsp, https, tlsInsecure, manufacturer, model, state, problem, online, codec, width, height, hasAudio, stream, events: { supported, state, kinds }, settings, snapshotAt, lastEventAt }]` — 1.242.0: `https` (ONVIF over HTTPS), `tlsInsecure` ("Zertifikat nicht prüfen"), `hasAudio` (the stream has a sound track, `null` unknown; gateway ≥ 1.29.0), `state` also `tls_untrusted` |
| `gc.cameras.discover({ gatewayId? })` | `{ found: [{ gatewayId, gateway, host, port, path, manufacturer, model, name, cameraId }] }` — WS-Discovery on the gateway(s); `cameraId` when already added |
| `gc.cameras.test({ gatewayId, host, onvifPort?, onvifPath?, onvifTls?, tlsInsecure?, rtspUrl?, user, password })` | `{ ok, source, onvif: { port, path, tls }, tlsInsecure, info, profile, profiles, rtsp, events, codec, width, height, audio, snapshot: { data, mime } \| null }` — nothing stored. 1.242.0: `onvifTls` (ONVIF over HTTPS; without a port the gateway tries 443 last anyway), `tlsInsecure` (accept a self-signed certificate — only on the administrator's explicit choice; default: checked, `ERR_CAMERA_TLS`) |
| `gc.cameras.add({ gatewayId, name, host \| rtspUrl, user, password, profile?, onvifTls?, tlsInsecure?, settings? })` | `{ camera, snapshot }` — tests first, stores only when the gateway reached the camera; the password is encrypted with the server key and only ever goes to that gateway (never back to a plugin, never in the config pull). At most 16 per gateway (`ERR_CAMERA_LIMIT`) |
| `gc.cameras.update(id, { name?, user?, password?, profile?, tlsInsecure?, settings? })` / `remove(id, { deleteClips? })` | the camera / `{ removed }` |
| `gc.cameras.snapshot(id, { maxBytes? })` | `{ data (base64 JPEG), mime, at }` — default ≤ 300 KB, fits `gc.notify({ image })` |
| `gc.cameras.snapshotUrl(id)` | `{ url: '/camera-media/<token>/snapshot.jpg', expiresAt, every: 10 }` (token 10 min; add `?t=<n>` to refresh) |
| `gc.cameras.live(id, req)` | in the VPN or the server's LAN: `{ mode: 'live', hls, mp4, snapshot, codec, audio, expiresAt }` (`audio`: sound switched on and the stream not known to have none) (HLS with fMP4 for Safari/iOS/Android, `mp4` = a continuous fragmented MP4 for other browsers; token 10 min); from the internet `{ mode: 'snapshot', snapshot, every: 10, reason: 'vpn_required' }`. `req` is the request the plugin answers (its `req.homeRef`) |
| `gc.cameras.events({ cameraId?, since?, until?, kinds?, limit? })` | `[{ id, cameraId, camera, kind, kinds, startedAt, endedAt, nobodyHome, clip: { ms, bytes } \| null, thumbUrl, clipUrl }]` newest first (≤ 200; URLs valid 1 h; clips with Range) |
| `gc.cameras.deleteEvent(id)` | `{ deleted }` — also the clip on the gateway |
| `gc.cameras.on(handler)` | hook `cameraEvent`: `{ id, cameraId, camera, gatewayId, kind, kinds, phase: start\|update\|end, at, nobodyHome, clip }` |

`settings`: `{ record: motion | away (only when nobody is at home — from the presence of
people who agreed; unknown = no) | never, events: [person, vehicle, animal, motion],
retentionDays 1…90, stream: main | sub, audio }`. Frames of a plugin with the
permission may load `/camera-media/` (`img-src`/`media-src`), and its iframe gets
`allow="fullscreen"` (as does a plugin whose `media.types` take videos, see "Media"). Since 1.242.0 they may also `fetch` it (`connect-src <origin>/camera-media/`;
the media answer `Access-Control-Allow-Origin: *` — the token is the permission, no cookie), play
`blob:` media and load the shared live player:

```html
<script src="/plugins/_shared/camera-player/camera-player.js"></script>
<script>
  // live = the answer of gc.cameras.live (mode 'live')
  const p = GCCameraPlayer.play(video, live, { onError: () => showStills(), onPlaying: () => {}, onEnded: () => renew() });
  // p.mode: 'hls' (Safari, iOS, Android) | 'mse' (Firefox, Chrome/Edge on the PC: live.mp4 through
  // Media Source Extensions, buffer ≤ 60 s, stays at the live edge) | 'mp4' (plain <video src>); p.stop()
</script>
```

No library, no CDN (`public/js/plugin-camera-player.js`). Without the script (an older GateControl)
`window.GCCameraPlayer` is missing — fall back to `video.src = canPlayType(HLS) ? hls : mp4`. Errors: `ERR_INVALID`, `ERR_NOT_FOUND`, `ERR_CAMERA_OFFLINE`,
`ERR_CAMERA_UNSUPPORTED`, `ERR_CAMERA_AUTH`, `ERR_CAMERA_UNREACHABLE`,
`ERR_CAMERA_NOT_ALLOWED` (not a private address of the gateway's home network),
`ERR_CAMERA_NOT_READY`, `ERR_CAMERA_SERVICE_MISSING`, `ERR_CAMERA_LIMIT`, `ERR_CAMERA_TLS` (1.242.0:
the camera's HTTPS certificate is not trusted — offer "Zertifikat nicht prüfen"). Who may
see which camera is the plugin's to decide.

## AI requests (`permissions.ai`)

Since 1.214.0. GateControl has one AI service for every plugin: the
administrator sets up the providers once (**Einstellungen › KI-Anbieter**),
plugins ask GateControl through `gc.ai` — never the provider. No key reaches
a plugin process, an app or a browser; a plugin names pictures by media id and
never has their bytes in hand. Without a provider set up the service is simply
off: `gc.ai.available()` is `false` and the plugin hides its AI features.
Code: `src/services/ai/` (service, `schema.js`, `providers/*.js`), admin API
`src/routes/api/ai.js`, page `templates/aurora/partials/settings-ai.njk` +
`public/js/settings-ai.js`.

### Permission

```json
"permissions": {
  "ai": {
    "purpose": { "de": "Dokumente erkennen und einordnen", "en": "Recognise and file documents" },
    "capabilities": ["text", "vision"]
  }
}
```

* `purpose` (text or `{de, en}`, ≤ 200 characters) — shown in the install
  dialog: "KI-Anfragen: Dokumente erkennen und einordnen (Text, Bilder) über
  den in GateControl eingerichteten KI-Anbieter – die Inhalte gehen an diesen
  Anbieter, dessen Bedingungen gelten", marked as sensitive.
* `capabilities`: `text` (required), `vision` (pictures), `audio`, `video`
  — what the plugin may ask for. `audio` and `video` may be declared already;
  this version answers neither (`gc.ai.available({ capability: 'audio' })` is
  `false`, a sound or video file as input is `ERR_AI_CAPABILITY`).
* Errors: `permissions.ai: invalid`, `permissions.ai.capabilities: needs "text"`.
* With the consent of the install dialog the plugin is allowed
  (`ai_plugin_policy.allowed = 1`). An update that adds `permissions.ai` (or
  changes purpose or capabilities) asks for other permissions: it is never
  installed automatically and needs the administrator's consent like every
  new permission. An update with the same permission keeps what the
  administrator set; uninstalling forgets the consent.
* The administrator can block a plugin or fix it to one provider on the
  settings page ("Welche Plugins dürfen KI nutzen?").

Catalogue metadata (`catalog-meta.json` of the plugins repository) names it
in "Das darf das Plugin" with the symbol `ai` and the sensitive tag, e.g.
`{ "icon": "ai", "title": { "de": "KI-Anfragen", "en": "AI requests" }, "text":
{ "de": "Erkennt … über den in GateControl eingerichteten KI-Anbieter (eigener
API-Schlüssel)", "en": "…" }, "tag": { "de": "sensibel", "en": "sensitive" } }`.

### Host API `gc.ai`

A plugin that also runs on older versions checks `typeof gc.ai?.extract === 'function'` first.

```js
// Is AI usable for this plugin? Asks no provider, costs nothing.
await gc.ai.available();                          // → true | false (capability 'text')
await gc.ai.available({ capability: 'vision' });  // a provider with pictures, and "Bilder an KI senden" on

await gc.ai.status();
// → { available: true, mediaAllowed: false, capabilities: ['text'], budgetLeftCents: 812.5 }
//   (not available: { available: false, mediaAllowed, capabilities: [], budgetLeftCents: null })

// Structured extraction: the answer is checked against the schema
const r = await gc.ai.extract({
  task: 'doc_insight',                 // [A-Za-z][A-Za-z0-9_.-]{0,39}, in the log
  user: req.user.id,                   // optional, for the log (an enabled person)
  instructions: PROMPT,                // system instruction (≤ the text limit below)
  input: [
    { type: 'text', label: 'Dateiname', text: name },
    { type: 'text', label: 'Text', text: ocrText },
    { type: 'media', mediaId },        // a picture of the plugin's own media (only while pictures are allowed)
  ],
  schema: SCHEMA,                      // JSON Schema subset, below
  maxOutputTokens: 2000,               // 1 … 32000, default 4000
  timeoutMs: 60000,                    // 1000 … 180000, default 60000
});
// → { ok: true, data: { … }, provider: 'anthropic', model: '…',
//     usage: { inputTokens, outputTokens, costCents }, fallback: false }

// Free text (summaries, translations): the same, without schema
const g = await gc.ai.generate({ task, user, instructions, input, maxOutputTokens, timeoutMs });
// → { ok: true, text: '…', provider, model, usage, fallback }
```

* `provider` is `openai` | `anthropic` | `gemini` | `openrouter` | `local`, `model` the
  model the administrator chose there; `fallback: true` when the answer came
  from the fallback provider. `costCents` (euro cents, 4 decimals at most)
  includes a correction round and a failed first try.
* Limits: instructions and every text together ≤ 200,000 characters, ≤ 64
  inputs, labels ≤ 100 characters, ≤ 8 pictures (JPEG, PNG, WebP, GIF, each
  ≤ 10 MB; the host turns them upright, scales them to at most 2048 px a side
  and sends JPEG), answer ≤ 64 KB (`data` as JSON / `text`). The plugin
  must declare `media`; the files may still be unclaimed.
* Time: `timeoutMs` per provider call; the whole request (with a correction
  round or the fallback) takes at most twice that — with the local AI at least
  5 minutes (a model on a CPU is slow; the host waits as long).

**The local AI** (since phase 3c, step 3 — `src/services/ai/local.js`, the
gateway's `docs/local-ai.md`): provider `local`, a model in the home network on a
gateway (Ollama) or an existing AI server there, reached through a gateway (an
`https://` server with a self-signed certificate: the administrator confirms its
fingerprint in "Verbindung testen", it is stored as `settings.ai.lanPin` and the
gateway connects only with exactly that certificate — the check is never off). Text
only (`capabilities: ['text']`; a request with pictures goes to a cloud provider),
0 € (no reservation, nothing counts against the budget; still a row in the log
with `route`). Nothing changes for a plugin — the administrator decides what it is
used for: **Für alles** (local first, a cloud provider only when it does not answer
or a picture must be understood), **Nur für private Inhalte** (text requests of
`gatecontrol-drive` and `gatecontrol-mail` local and never to the cloud — also not
as a fallback; everything else as before), **Nur als Ausweich** (local once the
monthly budget is used up, instead of `ERR_AI_BUDGET`). A plugin may also be fixed
to `local` (KI-Anbieter › plugin row). Answers of a smaller local model are
checked against the schema like every other (one correction round).
* 120 requests per hour and plugin (setting "Anfragen pro Stunde und
  Plugin"), against a faulty plugin; no limit per person.

**Errors** are thrown like those of the other host APIs (`e.code`):

| Code | Meaning | The plugin should |
|---|---|---|
| `ERR_INVALID` | invalid arguments, unknown `mediaId`, a schema outside the subset | fix the call |
| `ERR_AI_DENIED` | no `permissions.ai`, blocked by the administrator, capability not declared | hide the function |
| `ERR_AI_NOT_CONFIGURED` | no provider set up (or the plugin's fixed one is not), or `GC_AI=off` | fall back to manual entry |
| `ERR_AI_MEDIA_DISABLED` | pictures sent while "Bilder & Videos an KI senden" is off — before any provider sees anything | ask again with the text alone |
| `ERR_AI_CAPABILITY` | no allowed provider can do it (or the plugin's fixed one cannot); sound or video input | tell the person |
| `ERR_AI_BUDGET` | the monthly budget of the server is used up | show "limit reached" |
| `ERR_RATE_LIMIT` | requests per hour exceeded | try later |
| `ERR_AI_PROVIDER` | the provider (and the fallback) answered with an error — the message never carries a key | show "failed", retry |
| `ERR_AI_INVALID_OUTPUT` | the answer did not match the schema even after one correction round, or was larger than 64 KB | as above |
| `ERR_TIMEOUT` | the provider did not answer in time (and the fallback neither) | as above |

**Schema subset** (`src/services/ai/schema.js`): `type` (`object`, `array`,
`string`, `number`, `integer`, `boolean`), `properties`, `required`, `items`,
`enum` (strings, on a string), `minimum` / `maximum`, `maxLength`,
`maxItems`, `nullable`, `description`. The root is an object; at most 8
levels, 100 properties per object, 32 KB. Any other keyword is `ERR_INVALID`,
so a schema works with all four providers. The answer is checked by
GateControl, not by the provider: unknown properties are dropped, an optional
property sent as `null` is dropped; a mismatch gets one correction round with
the list of errors, then `ERR_AI_INVALID_OUTPUT`.

### A request

permission + consent + capability → `GC_AI` → picture switch → rate limit →
provider → budget (reserved) → pictures read by the host → call → schema
check → cost booked, log row.

* **Provider**: the plugin's fixed provider (no routing, no fallback;
  `ERR_AI_CAPABILITY` when it cannot do it), else the default provider when
  it can do it, else the next one set up that can (for pictures: one with
  `vision`). "Set up" = switched on, key readable, model chosen.
* **Fallback**: on a timeout, 429, 5xx or no connection exactly one try at the
  fallback provider (set up, able, not the plugin's fixed one). 400/401/403
  never fall back — that is a problem of the content or the key.
* **Budget**: the estimate (characters ÷ 4 + ~1600 tokens per picture as
  input, plus `maxOutputTokens`, at the dearer of the two providers) is
  reserved against what is left of the server's monthly budget; not enough is
  `ERR_AI_BUDGET`. After the answer the real cost is booked. At 80 % and at
  100 % the administrators get `ai_budget_warning` / `ai_budget_reached`
  (activity log, notification center row "KI-Budget"), each once a month.
  The month starts on the 1st at 00:00 in the server's time zone.
* **Prices**: OpenRouter sends the cost of each request (and its model list
  the prices). For OpenAI, Anthropic and Gemini the administrator enters the
  prices of the chosen models (US dollars per million tokens, "Preise je
  Modell"); without one a deliberately high default price of the provider is
  used and the row is marked "geschätzt" (`estimated`). Shown in euros, the
  rate is a setting (default 0.92 €/$), no rate service is asked.

### Administration

**Einstellungen › KI-Anbieter**: one card per provider (key — shown only as
its last four characters, *Testen*, model choice from the provider's list,
switch, status), "Welche Plugins dürfen KI nutzen?" (switch and provider per
plugin), "Verbrauch diesen Monat" against the limit (by plugin and provider),
"Standard & Ausweich" (default and fallback provider, "Bilder & Videos an KI
senden" — default **off** —, monthly limit — default 10 € —, requests per
hour, exchange rate, prices) and the request log.

* *Testen* fetches the provider's model list: it checks the key at no cost
  and fills the model choice (kept an hour). Model names are never built in.
* Keys are stored encrypted with the server key (`utils/crypto`), never read
  back; a new key replaces the old one, `key: ''` deletes it. They go into the
  backup encrypted; after a restore on a server with another key the provider
  reads "Schlüssel neu eingeben".
* Never in a log: the logger redacts `authorization`, `x-api-key`,
  `x-goog-api-key` (and cookies) wherever headers are logged; provider error
  messages are cleaned of the key before they are stored or passed on.
* Activity log: `ai_provider_key_set` / `ai_provider_key_removed`,
  `ai_plugin_allowed` / `ai_plugin_blocked`, `ai_settings_changed`,
  `ai_budget_warning` / `ai_budget_reached`.
* Log `ai_requests`: metadata only (time, plugin, person, task, provider,
  model, kind, tokens, pictures, cost, duration, outcome — `ok` or the error
  code —, fallback, estimated), kept 90 days. No input, no answer.

API (admin session + CSRF; an API token gets 403):

* `GET /api/v1/ai` → `{ enabled, providers: [{ id, name, enabled, configured, keySet, keyState: none|ok|invalid, keyHint, modelText, modelAudio, capabilities, checkedAt, checkError, models }], defaults: { provider, fallback }, mediaAllowed, perHour, eurPerUsd, priceOverrides, budget: { cents, usedCents, month } }`
* `PUT /api/v1/ai/providers/:id` `{ key?, enabled?, modelText?, modelAudio? }` (`key: ''` deletes it; a new key switches the provider on)
* `POST /api/v1/ai/providers/:id/test` → `{ ok, models: [{ id, name, capabilities }] }` or `{ ok: false, code: auth|provider|no_key|key_unreadable|test_mode|ai_disabled, message }`
* `PUT /api/v1/ai/settings` `{ defaultProvider, fallbackProvider, mediaAllowed, budgetCents, eurPerUsd, perHour, priceOverrides }` (`priceOverrides`: `{ <provider>: { <model>: { input, output } } }`)
* `GET /api/v1/ai/plugins` → `{ plugins: [{ id, name, purpose, capabilities, allowed, provider, enabled }] }`; `PUT /api/v1/ai/plugins/:id` `{ allowed, provider }` (`provider: null` = the default one)
* `GET /api/v1/ai/usage?month=2026-10` → `{ usage: { month, requests, costCents, estimated, budgetCents, byPlugin, byProvider, byDay } }`
* `GET /api/v1/ai/requests?plugin=&limit=` → `{ requests: [{ id, at, plugin, userId, task, provider, model, kind, inputTokens, outputTokens, mediaCount, costCents, durationMs, outcome, fallback, estimated }] }`

| Environment | |
|---|---|
| `GC_AI=off` | the AI service is switched off completely: `available()` false, every request `ERR_AI_NOT_CONFIGURED`, no provider is contacted, the page says so |

A test run (`NODE_ENV=test`) never reaches a provider: the adapters only call
a local stub a test set (`services/ai/providers/http.js` `testBase`), any other
call ends as `ERR_AI_PROVIDER` before a connection is made.

**Providers** (`src/services/ai/providers/`, no npm dependency — the HTTP APIs
directly, over GateControl's own outgoing way to these fixed hosts, never the
plugin network permission):

| Provider | Host | Structured answer | Pictures |
|---|---|---|---|
| OpenAI | api.openai.com | JSON schema response format (strict) | yes |
| Anthropic | api.anthropic.com | a forced tool whose input schema is the schema | yes |
| Google Gemini | generativelanguage.googleapis.com | response schema with JSON output | yes |
| OpenRouter | openrouter.ai | OpenAI-compatible strict JSON schema for models that support it, otherwise the schema in the instructions | per model (from its model list) |

Not yet (later, with the recipes plugin): `gc.ai.transcribe`, video input,
`gc.web.readPage`, storing contents 24 hours for debugging.

## Mail (`permissions.mail`)

Since 1.216.0. A plugin reads mailboxes over IMAP and sends over SMTP — the
servers people enter themselves (GMX, Web.de, T-Online, Gmail with an app
password, Microsoft with a token, any provider). The **host** holds every
connection; the plugin process gets a proxy of the session and plain
objects, never a socket. Code: `src/services/plugins/mail/` (`index.js`
sessions and API, `net.js` checks and errors, `mime.js` reading and writing,
`sanitize.js`, `autoconfig.js`, since 1.219.0 `dav.js` CalDAV/CardDAV),
libraries `imapflow` (IMAP), `nodemailer` (SMTP, MIME writing), `mailparser`
(MIME reading), `sanitize-html` and `postcss` (HTML / CSS), `saxes` (XML of
CalDAV/CardDAV).

```json
"permissions": {
  "mail": { "purpose": { "de": "Deine Postfächer lesen und Mails senden", "en": "Read your mailboxes and send mails" }, "maxConnections": 100,
    "dav": { "purpose": { "de": "Deine Kalender und Adressbücher bei GMX, Web.de oder deinem eigenen Server abgleichen", "en": "Sync your calendars and address books at GMX, Web.de or your own server" } } },
  "network": { "internet": ["graph.microsoft.com:443"], "images": true }
},
"media": { "maxBytes": 26214400, "types": ["application/*", "image/*"], "quotaDefault": "10GB" }
```

* `purpose` (text or `{de, en}`, ≤ 200, required) and `maxConnections`
  (1 … 200, default 50: open IMAP sessions of the plugin at the same time;
  SMTP does not count) — see "plugin.json". The install dialog and the plugin
  card show "Mail: darf sich mit Mail-Servern im Internet verbinden (IMAP und
  SMTP, nur verschlüsselt) und in deinem Namen Mails senden – höchstens n
  Verbindungen gleichzeitig. Zweck: …" / "may connect to mail servers on the
  internet (IMAP and SMTP, encrypted only) and send mails on your behalf …",
  marked as sensitive. Catalogue metadata may use the symbol `mail`.
* Without the permission `gc.mail` is `undefined` in the plugin process (the
  host refuses the calls with `ERR_MAIL_DENIED`). Feature test:
  `typeof gc.mail === 'object' && typeof gc.mail.imap?.connect === 'function'`.
* `dav` (optional, since 1.219.0; `purpose` ≤ 200, required): CalDAV/CardDAV
  through `gc.mail.dav.request` (see "CalDAV/CardDAV"). Without it
  `gc.mail.dav` is `undefined` and the host refuses with `ERR_MAIL_DENIED`.
  Feature test: `typeof gc.mail?.dav?.request === 'function'`.
* Attachments, raw mails and composed messages land in the plugin's media
  (plugin.json `media` needed for those calls, else `ERR_MEDIA_DENIED`) as
  **unclaimed** files without owner — removed after 24 h unless the plugin
  claims them (`gc.media.claim`). They keep the mail's own type, also one
  `media.types` does not list (`message/rfc822`, `text/calendar` …); types a
  browser would run are only ever served as downloads. `media.maxBytes` and
  the quota apply.

### Network

* Any host name, but every resolved address must be **public** — exactly the
  check of `gc.http.fetch` (private, loopback, link-local, CGNAT, ULA,
  multicast, reserved ranges, the WireGuard network, Docker networks and the
  server's own addresses → `ERR_NETWORK_DENIED`). The connection goes to the
  checked address (no DNS rebinding); TLS names the host (SNI) and checks the
  certificate against it.
* Ports: IMAP **993** (`security: 'tls'`) and **143** (`'starttls'`), SMTP
  **465** (`'tls'`) and **587** (`'starttls'`). Any other port →
  `ERR_NETWORK_DENIED`; a security that does not fit the port →
  `ERR_INVALID` (without `security` the port decides).
* Never in plain text: with `starttls` the host stops (`ERR_MAIL_NET`) when
  the server cannot do STARTTLS — the login never leaves unencrypted.
* TLS: the certificate is always verified, at least TLS 1.2. There is no
  switch to turn that off.

### IMAP sessions (`gc.mail.imap.connect`)

```js
const s = await gc.mail.imap.connect({
  host: 'imap.gmx.net', port: 993, security: 'tls',
  auth: { user: 'ada@gmx.de', pass: '…' },        // or { user, accessToken } (XOAUTH2)
  timeoutMs: 30000,                                // ≤ 60000
});
s.id; s.capabilities; s.serverInfo;                 // string[], { name, vendor } | null
s.on('exists', ({ path, count, prevCount }) => {}); // new mail (IDLE)
s.on('expunge', ({ path, seq, uid, vanished }) => {});
s.on('flags', ({ path, seq, uid, modseq, flags }) => {});
s.on('close', () => {});                            // the server, the host or the network ended it
s.on('error', (e) => {});                           // e.code like the commands' errors

await s.list();        // [{ path, name, delimiter, parent, specialUse, flags, subscribed }]
await s.status('INBOX', { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: true });
await s.open('INBOX', { readOnly: false });          // { path, uidValidity, uidNext, exists, highestModseq | null }
await s.fetch('1:*', { envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true,
  headers: ['list-id', 'precedence'] /* or true */, changedSince: 12345 });
await s.message(4711, { maxBytes: 25 * 1024 * 1024, attachments: 'meta' /* | 'media' */ });
await s.download(4711, '2', { name: 'Rechnung.pdf', maxBytes: 25 * 1024 * 1024 }); // { mediaId, bytes, mime, name }
await s.search({ seen: false, since: Date.now() - 86400000, or: [{ from: 'a@b.c' }, { subject: 'Rechnung' }] }); // uid[]
await s.flags([4711], { add: ['\\Seen'], remove: ['\\Flagged'] });
await s.move('4711,4712', 'Archiv');                 // { uidMap: { '4711': 31, … } | null }
await s.copy([4711], 'Archiv');                      // { uidMap }
await s.expunge([4711]);                             // marks \Deleted and expunges exactly these
await s.append('Sent', mediaId, { flags: ['\\Seen'], date: Date.now() }); // { uid | null }
await s.idle();                                      // IDLE on the open mailbox
await s.noop();
await s.close();
```

* Every method answers a Promise; errors carry `code` (below). Ranges are
  always **UIDs**: `'1:*'`, `'5,7,9'`, `'3:9'` or an array of numbers.
* One open mailbox per session (`open` replaces it); one command at a time
  per session (the next waits).
* `fetch` answers at most **500** messages per call — a range with more →
  `ERR_INVALID` before anything is fetched. Entry: `{ uid, flags[], size,
  internalDate (ms), envelope: { date (ms), subject, from[], sender[],
  replyTo[], to[], cc[], bcc[], inReplyTo, messageId }, headers: { name: value
  } (lower-case names, the first of each, unfolded and decoded),
  bodyStructure, modseq? }` — addresses `{ name, address }`. Only the asked
  fields are there. `changedSince` needs CONDSTORE on the server.
* `message` reads the whole message (≤ `maxBytes`, default 25 MB, at most
  50 MB; larger → `ERR_MAIL_LIMIT`) with mailparser: `{ messageId, inReplyTo,
  references[], date, subject, from, to[], cc[], bcc[], replyTo[], html | null,
  text | null, listUnsubscribe: { url?, mail? } | null, autoSubmitted,
  precedence, listId, attachments: [{ partId, filename, contentType, size,
  contentId, inline, checksum (sha256 hex), mediaId | null }], calendar:
  [{ partId, method, text }] }` (`calendar` since 1.219.0, see "Invitations
  (iMIP)"). `html` is the mail's own HTML — show it only after
  `gc.mail.sanitize`.
  `attachments: 'media'` streams every attachment into the plugin's media
  (unclaimed, 24 h); one that does not fit (quota, size) keeps `mediaId: null`
  and names `mediaError`. An unknown UID → `ERR_INVALID`.
* `download` streams one body part (`partId` as in `attachments` /
  `bodyStructure`) into the media, decoded.
* `search` takes imapflow's query object (`seen`, `unseen`, `flagged`,
  `answered`, `deleted`, `draft`, `from`, `to`, `cc`, `bcc`, `subject`,
  `body`, `text`, `since`, `before`, `on`, `sentSince`, `sentBefore`,
  `sentOn` (ms or ISO), `larger`, `smaller`, `header: { name: value }`,
  `or: [ … ]`, `not: { … }`, `uid`, `keyword`, `unKeyword`, `modseq`,
  `emailId`, `threadId`, `gmraw`); other keys → `ERR_INVALID`, ≤ 16 KB.
* `idle()` starts IDLE on the open mailbox. Every other command breaks it;
  the host starts it again after the command for as long as the plugin
  wants it (until `close`), renews it every 10 minutes and tries again 30 s
  after a failure. New mail arrives as `exists`.
* The host holds the session for the plugin **process**: all of them end
  when the process ends (restart, crash, disable, update, uninstall), and the
  host closes a session that had neither IDLE nor a command for 30 minutes
  (`close` event). After a restart the plugin connects again.

### SMTP and MIME

```js
const sent = await gc.mail.smtp.send({
  host: 'mail.gmx.net', port: 587, security: 'starttls', auth: { user: 'ada@gmx.de', pass: '…' },
  appendCopy: true,                                  // the sent mail as media, to append it to "Gesendet"
  message: {
    from: { name: 'Ada', address: 'ada@gmx.de' }, to: [{ name: 'Bo', address: 'bo@web.de' }], cc: [], bcc: ['me@gmx.de'],
    replyTo: 'ada@gmx.de', subject: 'Termin', html: '<p>Hallo</p>', text: 'Hallo',
    inReplyTo: '<m1@web.de>', references: ['<m0@web.de>', '<m1@web.de>'],
    headers: { 'X-GC-Mail': '1', 'List-Unsubscribe': '<mailto:u@example.com>' },
    attachments: [{ mediaId, filename: 'Rechnung.pdf', contentType: 'application/pdf' }, { mediaId: logoId, filename: 'logo.png', cid: 'logo@ada' }],
    date: Date.now(),
  },
});
// { messageId: '<…@gmx.de>', accepted: ['bo@web.de', 'me@gmx.de'], rejected: [], raw: { mediaId, bytes } | null }

const draft = await gc.mail.compose(message);       // { mediaId, bytes, messageId } — RFC 822 (drafts, Graph MIME)
const parsed = await gc.mail.parse(mediaId, { attachments: 'meta' });   // like s.message (e.g. Graph $value)
```

* Addresses: `{ name, address }` or a plain address; ≤ 500 recipients.
  `headers` only `X-…` and `List-Unsubscribe` (≤ 20), anything else →
  `ERR_INVALID`; no line breaks anywhere. Attachments are the plugin's own
  media files (≤ 100), read by the host (never a path or a URL); `cid` makes
  an inline part. The written mail is at most **50 MB** (`ERR_MAIL_LIMIT`).
  `Bcc` never appears in the mail, only in the envelope.
* `accepted` / `rejected`: per recipient; when the server refuses every
  recipient or the mail → `ERR_MAIL_REJECTED` with `serverText`.
* 4 SMTP operations (sends and `verify`) per plugin at a time (more wait).
* `icalEvent` (since 1.219.0): an invitation or answer — see "Invitations
  (iMIP)".

```js
await gc.mail.smtp.verify({ host: 'mail.gmx.net', port: 587, security: 'starttls', auth: { user: 'ada@gmx.de', pass: '…' }, timeoutMs: 30000 });
// { ok: true } — connected, STARTTLS, logged in, QUIT; nothing sent
```

`gc.mail.smtp.verify` (since 1.217.0) checks an SMTP server and its login
before an account is saved: the same network and TLS rules as `smtp.send`
(public addresses, ports 465/587, certificate always verified, STARTTLS
required), the same errors (`ERR_MAIL_AUTH` with `serverText`,
`ERR_MAIL_NET`, `ERR_MAIL_PROTOCOL`, `ERR_NETWORK_DENIED`, `ERR_INVALID`),
`auth` with `pass` or `accessToken` (XOAUTH2), `timeoutMs` ≤ 60000 for the
connection. It counts towards the 4 SMTP operations at a time. Feature
test: `typeof gc.mail.smtp?.verify === 'function'`.

### HTML (`gc.mail.sanitize`)

```js
const { html, images, trackers } = await gc.mail.sanitize(parsed.html, { images: 'placeholder' });
// html: '<p>Hallo<img src="gc-img:0" /></p>', images: ['https://news.example/logo.png'], trackers: 2
```

* Strict allowlist (sanitize-html): text formatting, lists, tables,
  pictures, links. Gone: `script`, `iframe`, `object`, `embed`, `form`/inputs, `svg`, `math`, `meta`, `base`,
  `link`, every event attribute (`on…`), `javascript:`/`vbscript:`/`data:`
  links, `srcset`.
* Links keep `http(s)`, `mailto`, `tel` and `#anchor`; others lose their
  address. External links get `target="_blank" rel="noopener noreferrer"`.
* CSS: `style` attributes and `<style>` blocks keep an allowlist of
  properties (colours, fonts, spacing, borders, sizes, alignment, display …)
  without `url()`, `expression`, escapes or `@import`; `<style>` keeps
  `@media` rules only (no `@font-face`, `@import`, `@keyframes`).
  `position`, `z-index` and the like never pass (no overlays).
* External pictures become `src="gc-img:<n>"` — `n` is the index in
  `images` (the same address once). The plugin shows them only when the
  person wants (e.g. through `gc.http.fetchImage`). `cid:` pictures stay
  `cid:`, small `data:image/(png|jpeg|gif|webp)` pictures stay. A mail's own
  `gc-img:` is dropped.
* Known tracking pixels are removed and counted in `trackers`: pictures of
  1×1 pixels or less, hidden ones, known tracker hosts (Mailchimp, SendGrid,
  HubSpot, Mailtrack, …) and paths (`/track/open`, `/wf/open`, `open.gif` …).
* Input ≤ 10 MB (`ERR_INVALID`), at most 500 pictures.

### Autoconfig (`gc.mail.autoconfig`)

```js
await gc.mail.autoconfig('ada@gmx.de');
// { imap: { host: 'imap.gmx.net', port: 993, security: 'tls' }, smtp: { host: 'mail.gmx.net', port: 587, security: 'starttls' }, source: 'ispdb',
//   caldav: { url: 'https://caldav.gmx.net/' } | null, carddav: { url: 'https://carddav.gmx.net/' } | null }   // since 1.219.0
```

In this order: Mozilla's ISPDB (`https://autoconfig.thunderbird.net/v1.1/<domain>`,
`source: 'ispdb'`), the provider's own file
(`https://autoconfig.<domain>/mail/config-v1.1.xml`,
`https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`, `'autoconfig'`),
DNS SRV (`_imaps._tcp` / `_imap._tcp`, `_submissions._tcp` /
`_submission._tcp`, `'srv'`) and the ISPDB entry of the MX host's domain
(`'mx'`). Only servers `gc.mail` may use count (the four ports, never plain
text; TLS before STARTTLS). Every HTTP request is https on 443 and checked
like `gc.http.fetch` (public addresses only, each redirect again); within
25 s. Nothing found → `{ imap: null, smtp: null, source: null }`. A malformed
address → `ERR_INVALID`; 120 lookups per plugin and hour (`ERR_RATE_LIMIT`).

Since 1.219.0 also the calendar and address book server: `caldav` / `carddav`
from `<calendar type="caldav">` / `<addressBook type="carddav">`
(`serverURL`, placeholders like the mail servers; only plain logins, no
OAuth) of the same files (ISPDB first), else DNS SRV `_caldavs._tcp.<domain>`
/ `_carddavs._tcp.<domain>` with TXT `path=` (without one
`/.well-known/caldav` / `carddav`), else `null`. Only `https` on 443 or 8443
counts. The older fields are unchanged.

### CalDAV/CardDAV (`gc.mail.dav`)

Since 1.219.0, with `permissions.mail.dav`. One request function for the
calendar and address book servers people enter themselves (GMX, Web.de, their
own domain, Nextcloud) — with the network rules of `gc.mail` and a
Multi-Status parser in the host. The protocol (discovery, sync, conflicts)
stays in the plugin. Code: `src/services/plugins/mail/dav.js`, XML with
`saxes`.

```js
const r = await gc.mail.dav.request({
  url: 'https://caldav.gmx.net/begenda/dav/users/a@gmx.de/calendar/',
  method: 'REPORT',               // GET HEAD OPTIONS PROPFIND REPORT PUT DELETE
  headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
  body: '<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:">…</d:sync-collection>',   // string ≤ 2 MB
  auth: { user: 'a@gmx.de', pass: '…' },   // or { bearer: '…' }; without: anonymous
  timeoutMs: 30000,               // 1000 … 60000
  maxBytes: 5 * 1024 * 1024,      // the answer, at most 20 MB
  parse: 'auto',                  // 'auto' (207 + XML → multistatus) | 'none'
});
// { status, url (the last address), headers: { etag?, 'content-type'?, location?, dav?, allow?, 'retry-after'?, 'last-modified'?, 'content-length'? },
//   body: string | null (UTF-8; null when parsed), multistatus: { responses: [Response], syncToken: string | null } | null }
// Response = { href (absolute), status: 200 | 404 | … | null, propstat: [{ status, props: { '{ns}name': Node } }], error: Node | null }
// Node     = { text: string | null, attrs?: { name: value }, children?: [{ name: '{ns}local', text, attrs?, children? }] }
r.multistatus.responses[0].propstat[0].props['{DAV:}getetag'].text;                               // '"a1b2"'
r.multistatus.responses[0].propstat[0].props['{urn:ietf:params:xml:ns:caldav}calendar-data'].text; // the iCalendar file
```

* **Network:** `https` only, ports **443** and **8443** (else
  `ERR_NETWORK_DENIED`). Every resolved address must be public — exactly
  the check of `gc.mail`; the connection goes to the checked address (DNS
  pinned), SNI = host, the certificate is always verified, at least TLS 1.2.
  No switch.
* **Redirects:** within the same origin (scheme, host, port) the host follows
  them itself — at most 5, each checked again, with `auth` (303 turns into
  GET without a body, the others keep method and body). A redirect to
  **another** origin is never followed: the 3xx comes back with
  `headers.location` (absolute) and the plugin decides whether that host
  gets its credentials. Never to `http:`.
* **Headers:** only `depth`, `content-type`, `if-match`, `if-none-match`,
  `prefer`, `brief`, `accept`, `if-modified-since` (printable ASCII);
  `authorization` and anything else → `ERR_INVALID`. The host sets
  `User-Agent: GateControl-Mail` and `Accept-Encoding: identity`; no cookies
  (none sent, `Set-Cookie` dropped), no Referer.
* **Credentials:** only as `auth` — Basic from `user`/`pass` (no `:` in the
  user) or `Bearer`; never in the URL (`ERR_INVALID`), never in logs or error
  texts. No Digest.
* **XML:** namespace-exact, the prefixes do not matter; names
  `{namespace}local`. A DTD — and with it any entity of its own — is an
  error (`ERR_DAV_XML`), nothing is ever expanded or loaded. Depth ≤ 64,
  ≤ 10 000 `response` elements (else `ERR_DAV_XML`). Text is kept as it is
  (not trimmed; XML turns CR LF into LF). `parse: 'auto'` parses a 207 with
  an XML type (or none); the root must be `DAV:multistatus`. A `response`
  with several `href`s comes once per `href`.
* **Limits:** 8 requests per plugin at a time (more wait — at most 100, at
  most 2 minutes, else `ERR_MAIL_LIMIT`); request body ≤ 2 MB and the answer
  ≤ `maxBytes`, counted after unpacking should a server compress anyway
  (`ERR_MAIL_LIMIT`); the whole request with its redirects within
  `timeoutMs` (`ERR_MAIL_NET`). The requests end with the plugin process.
* **HTTP status codes are no errors:** 401, 403, 404, 409, 412, 5xx … come
  back as `status`.

### Invitations (iMIP)

Since 1.219.0. `s.message(uid, …)` and `gc.mail.parse(mediaId, …)` also
answer `calendar: [{ partId, method, text }]` — every `text/calendar` part of
the mail (also an `.ics` attachment, `application/ics`) that is an iCalendar
file, decoded to text (its charset, else UTF-8), at most 512 KB each (larger
ones are missing), the first 3. `method`: `'REQUEST'`, `'REPLY'`,
`'CANCEL'`, `'COUNTER'`, `'DECLINECOUNTER'`, `'PUBLISH'` from the file's
`METHOD` (else the `method=` of its Content-Type) or `null`. Without such
parts `[]`. The parts stay in `attachments` as before.

```js
await gc.mail.smtp.send({ host, port, security, auth, message: {
  from: 'bob@example.com', to: ['anna@firma.example'], subject: 'Zugesagt: Planung', text: 'Bis dann',
  icalEvent: { method: 'REPLY', content: 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\n…END:VCALENDAR\r\n', filename: 'invite.ics' },
} });
```

`message.icalEvent` (`gc.mail.smtp.send`, `gc.mail.compose`): `method`
`'REQUEST'` | `'REPLY'` | `'CANCEL'` | `'COUNTER'` | `'DECLINECOUNTER'`,
`content` ≤ 512 KB beginning with `BEGIN:VCALENDAR` and with exactly one
`METHOD:` equal to `method`, `filename` optional (`*.ics`, default
`invite.ics`); anything else → `ERR_INVALID`. The host writes a
`multipart/alternative` with `text/calendar; charset=utf-8; method=…` plus the
same file as `.ics` attachment (nodemailer `icalEvent`) — only from
`content`, never a path or a URL.

### Errors

| code | when |
|---|---|
| `ERR_MAIL_AUTH` | the server refused the login; `serverText` (≤ 200 characters, user, password and token removed) |
| `ERR_MAIL_NET` | not reachable, not found, timeout, TLS (certificate, no STARTTLS), the session is closed; `dav.request`: more than 5 redirects |
| `ERR_MAIL_PROTOCOL` | anything else the server answered (`serverText` where there is one) |
| `ERR_MAIL_REJECTED` | SMTP refused the mail or every recipient; `serverText` |
| `ERR_MAIL_LIMIT` | `maxConnections` reached, a message over `maxBytes` / 50 MB; `dav.request`: an answer over `maxBytes`, a body over 2 MB, too many requests waiting |
| `ERR_NETWORK_DENIED` | a port other than the four (`dav.request`: not `https` on 443 / 8443), an address that is not public |
| `ERR_DAV_XML` | `dav.request`: broken XML, a DTD or entity, too deep, too many responses, not `DAV:multistatus` (since 1.219.0) |
| `ERR_INVALID` | arguments, unknown session / UID / media id, more than 500 messages in a fetch |
| `ERR_MAIL_DENIED` | no `permissions.mail` (`dav.request`: no `permissions.mail.dav`) |
| `ERR_MEDIA_DENIED` / `ERR_MEDIA_QUOTA` / `ERR_MEDIA_TOO_LARGE` | media needed but not declared / quota full / file too large |

`serverText` comes as a property of the error (`e.serverText`).

## Cloud import (`permissions.cloudImport`)

A person connects their own Google Drive or OneDrive in the plugin, browses it
and takes files into the plugin's media (GateControl Drive: portal page
"Importieren"). The administrator enters the OAuth apps under *Einstellungen ›
Plugins › Cloud-Konten* (docs/cloud-accounts.md); without them `available()`
says `false`. Code: `src/services/plugins/cloud.js`, `src/services/cloudAccounts/`.
Check for it with `typeof gc.cloud?.list === 'function'`.

```json
"permissions": { "cloudImport": { "purpose": { "de": "Dateien aus Google Drive und OneDrive übernehmen", "en": "…" } } },
"media": { "maxBytes": 2147483648, "types": ["*/*"] }
```

`purpose` (≤ 200 characters) is shown in the install dialog and the catalogue
next to "Import aus Google Drive und OneDrive"; the permission is marked
sensitive. `import` also needs `media`.

```js
await gc.cloud.available();          // → { google: true, microsoft: false } — an OAuth app is entered
const { url } = await gc.cloud.connectUrl({ user: req.user.id, provider: 'google', returnTo: '/portal?view=import#plg-gatecontrol-drive' });
// the frame hands `url` to the page: await GC.openUrl(url) (below) — a page on GC_BASE_URL names the
// person and the plugin, then Google / Microsoft, then back to returnTo with ?cloud=connected
// (or ?cloud=error&cloudError=<code>)
await gc.cloud.connections({ user });   // → [{ id, provider: 'google'|'microsoft', account, connectedAt, error? }]
await gc.cloud.disconnect({ user, connection });   // → true | false
await gc.cloud.list({ user, connection, folderId, cursor });
// → { items: [{ id, name, isDir, size, mime, modifiedAt }], next }   (folderId omitted: the root; next: cursor | null)
await gc.cloud.import({ user, connection, fileId });
// → { mediaId, name, size, mime, modifiedAt } — unclaimed (gc.media.claim within 24 h), owner = the person
```

* **One person, one plugin**: every call names the person (`user`, an enabled
  account — `ERR_INVALID` otherwise); a connection belongs to that person and
  this plugin only — another person's or plugin's id is `ERR_CLOUD_NOT_FOUND`.
  At most 10 connections per person; the same account again keeps its id.
* **`returnTo`**: a portal path (`/portal…`, the portal host is put in front)
  or an app address (`gatecontrol://…`), nothing else (`ERR_INVALID`). The
  link is single use, valid for 10 minutes and bound to the browser that
  opens it. Give it only to that person: the start page warns with their
  name, and a browser signed in as another GateControl account is refused
  (docs/cloud-accounts.md "The limit of this check").
* **`list`**: 100 items per page, folders first. `size` and `mime` are `null`
  for folders. Google Docs, Sheets and Slides appear as `.docx` / `.xlsx` /
  `.pptx` with that type and `size: null`, Drawings as `.pdf`; Forms, Sites,
  maps and shortcuts are left out, so are OneNote notebooks and items of other
  people's drives (OneDrive "Shared").
* **`import`**: streams the file into the media store under the plugin's
  `media.types` (`ERR_MEDIA_TYPE`), `maxBytes` (`ERR_CLOUD_TOO_LARGE`) and
  quota (`ERR_MEDIA_QUOTA`) — checked before a byte is fetched where the
  provider names the size. A missing or generic type
  (`application/octet-stream`) is taken from the file name. Google documents
  are exported (Google: at most 10 MB). A folder is `ERR_INVALID` — list it
  and import its files (the plugin keeps the structure). `modifiedAt` is the
  original change time (e.g. for `mtime`).
* **Limits**: `list` 120 per minute, `import` 3000 per hour (per person and
  plugin), 4 imports at a time per plugin, 8 on the server, 30 minutes per
  file; `connectUrl` 30 per hour — then `ERR_RATE_LIMIT`.
* **Errors**: `ERR_CLOUD_DENIED` (no permission), `ERR_CLOUD_NOT_CONFIGURED`
  (no or a refused OAuth app), `ERR_CLOUD_AUTH` (connect again — the
  connection then carries `error: 'auth'`), `ERR_CLOUD_NOT_FOUND`,
  `ERR_CLOUD_TOO_LARGE`, `ERR_CLOUD_PROVIDER`, `ERR_RATE_LIMIT` (ours or the
  provider's), `ERR_TIMEOUT`, `ERR_INVALID`, the media codes above,
  `ERR_MEDIA_DENIED` (no `media`).
* Tokens never reach the plugin. Uninstalling the plugin removes its
  connections; deleting a person removes theirs.
* **`GC.openUrl(url)`** in the plugin's frames (only with
  `permissions.cloudImport`; check `typeof GC.openUrl === 'function'`): the
  sandboxed frame may neither open a popup nor navigate the page, so it hands
  the address of `connectUrl` to the page (admin page or portal,
  `public/js/plugin-bridge.js`), which opens it **in the same tab** — the
  provider sends the browser back to `returnTo`. Only
  `<GC_BASE_URL>/oauth/cloud/start?flow=<id>` is taken (absolute, or
  relative to GC_BASE_URL); anything else, and more than one call per 1.5 s,
  rejects with `not allowed`. → `Promise<{ ok: true }>`.

  ```js
  const { url } = await GC.post('import/connect', { provider: 'google' });   // the plugin calls gc.cloud.connectUrl
  await GC.openUrl(url);
  ```

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
* `maxPerHour` (since 1.216.0): a provider may give one of its services its
  own budget — `"services": { "provides": { "suggest_folder": { "label": …,
  "maxPerHour": 600 } } }` (60 … 3600). Calls of that service then count per
  calling plugin against that number and no longer against the shared 60;
  calls of the provider's other services keep the shared budget.
  `ERR_RATE_LIMIT` names the limit. Older GateControls refuse the key
  (`services.provides: invalid`), so a provider declaring it needs
  `"gatecontrol": ">=1.216.0"`.
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
runaway query blocks only that worker (terminated when one statement runs
longer than 15 s in it — measured in the worker, so a busy host does not
count; opening the file has 30 s). Statements with
`ATTACH`, `DETACH`, `VACUUM`, `PRAGMA`, `load_extension` or the host's `_gc_*`
tables are refused. The plugin process can write only the sibling `files/`
folder, never the database file.

**Answers and slow statements** (since 1.253.5): `gc.db.query` returns at
most 5000 rows and about 16 MB — past either limit the answer has
`truncated: true` (the host's main thread copies the answer out of the worker
and serialises it for the plugin in one go, so its size is bounded). A
statement that runs 200 ms or longer in the worker is counted per plugin;
one line per plugin and 5 minutes (since 1.255.0; before: one line per
statement and minute) "slow plugin database statements" says how many there
were (`slow`), how many of them were writes (`writes`: INSERT, UPDATE,
DELETE, COMMIT, `kv.set`, `settings.set` …), the longest time in the worker
(`maxMs`), the longest wait besides (`waitMs`: behind the plugin's other
statements, and for the host), `windowS` and the five most frequent
statements (`statements`: `op`, `sql` without its values — literals as `?`,
`IN (?,…)`, ≤ 160 characters —, `n`, `maxMs`, `rows`), with `diskSyncMs`, the
latest write probe of the data disk (see below). The host's
stall log (`event loop was blocked`) names a plugin's `db.query` / `db.exec`
with that statement too, and says whether the main thread computed in the
blocked time or waited (`mainCpuMs`, `blockedBy: cpu | waiting`,
`processCpuMs`, `majorFaults`, `diskReads`, `diskSyncMs`). A statement that reads the whole
database (a `SUM` over rows with large text, a `LIKE '%…%'` on bodies) slows
the disk for the whole server: give it an index that holds the columns it
needs (a covering index; `INDEXED BY` when SQLite should not pick the row).

**Journal mode** (since 1.255.0): a plugin's database runs in WAL with
`synchronous = NORMAL`, like the host database. A write — one `UPDATE`, a
`COMMIT`, a `kv.set` — appends to `plugin.db-wal` and does not wait for the
disk; the disk is synced at a checkpoint only: when the log holds 1000 pages,
after 30 s without a call of the plugin, and when the worker closes (idle
after 5 minutes, at shutdown — `plugin.db` alone is complete then, the
`-wal` file is gone). Before, the rollback journal (`journal_mode = DELETE`,
`synchronous = FULL`) synced the disk four times per write transaction: on a
disk that needs 75 ms per sync, every single-row write took ~300 ms
(measured with a simulated slow disk, `tests/plugins_db_wal.test.js`: 204 ms
per write at 50 ms per sync before, under 1 ms now; the number of syncs no
longer grows with the writes). The trade-off: a crash of GateControl loses
nothing; a power cut can lose the plugin's last transactions since its last
checkpoint (seconds to a few minutes), never corrupt the file. An existing
file switches on its next open. A plugin backup snapshot is written with the
header of a rollback-journal file (it holds every page), a restored file
switches to WAL again. Fewer writes still help most: write a row only when
its values changed, put related writes into one transaction (`BEGIN` …
`COMMIT`), and throttle "last seen" timestamps.

**The host database** runs in WAL with `synchronous = NORMAL` and
`busy_timeout = 5000`; its checkpoints run in a worker thread
(`db/checkpointWorker.js`, PASSIVE: never waiting for or blocking a writer).
Since 1.255.0 the worker checkpoints a commit once it is 30 s old (or at once
when the log grew by 8 MB), instead of every 2 s — two syncs every 2 s
competed with every other write on a slow disk. A power cut can lose up to
the last 30 s of host changes.

**Write speed of the data disk** (since 1.255.0, `services/diskHealth.js`): a
worker thread writes 4 KB into `<data>/.disk-probe` and syncs it every
2 minutes. When the average of the last 15 probes (without the highest and
lowest fifth, at least 8 probes) is 50 ms or more, Logs & Monitoring shows
one hint at the top ("Der Datenträger von GateControl ist beim Schreiben
langsam …": SSD, not a network share, an SD card or a busy NAS volume), and
"data disk is slow to write" is logged once; below 30 ms it ends ("data disk
writes fast again"). An SSD takes 1–5 ms, a hard disk 10–30 ms. Off with
`GC_DISK_PROBE=off`.

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
disable/uninstall and when the server shuts down. What the host holds for a
process — TCP sockets, WebSockets and, since 1.216.0, IMAP sessions
(`gc.mail`) — ends with that process; a new process connects again.

## User interface

* **Sidebar**: one entry per installed plugin with `ui.nav`
  (Smart Home, Klimaanlage, Fahrzeuge … are plugins), in the group named by
  `ui.nav.section` (optional, since the regrouped navigation,
  docs/feature-peers-page.md): `"home"` → "Zuhause" (house, climate, door,
  vehicle …), `"apps"` → "Apps" (mail, files, chat …), `"devices"` → the group
  "Geräte" below Peers / Clients and Gateways (NAS, hypervisor …). Without the
  key a plugin goes to "Apps"; an unknown value is ignored (no manifest
  error), so a plugin written for a newer server still loads. The official
  plugins are placed by the server as long as their manifests do not say it
  (services/plugins `NAV_SECTION_BUILTIN`). "Zuhause" and "Apps" fold, the
  browser remembers it; the page that is open stays visible. One that
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
  from the portal. Since 1.225.0 a page of `ui.settingsPages` is a tab of
  its own there: `GC.navigate('<page>')` opens that tab (see "plugin.json").
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
* **Keys** (since 1.211.0): `GC.keys.put(name, key)`, `GC.keys.get(name)`,
  `GC.keys.remove(name)` — the frame's opaque origin has no storage, so the
  parent page keeps **WebCrypto keys** for it in its own IndexedDB
  (`gc-plugin-keys`, per plugin and name `[A-Za-z0-9._-]{1,64}`, ≤ 32 per
  plugin), e.g. the device key of an end-to-end encryption. Only `CryptoKey`
  objects travel (or `{ publicKey, privateKey }` of a pair); a secret or private
  key only when it was made **not extractable** — neither the page nor the frame
  can ever read its bytes, the key can only be used. `get` → the key, the pair
  or `null`; `put` → `true` (400 for anything else, 429 over the limit);
  `remove` → whether there was one. They live in this browser profile for the
  GateControl origin, not per person: a plugin that keeps one per person puts
  the person into the name (`device-<userId>`).
* **Media bytes** (since 1.211.0): `await GC.mediaBytes(url, { start, end })`
  → `{ data: ArrayBuffer, start, end, total }` — the parent page fetches one of
  the plugin's media URLs (`/plugin-media/<token>` of `gc.media.url`, this
  origin, nothing else) without cookies and hands the bytes over (the frame's
  `connect-src 'none'` keeps it from fetching itself), e.g. to decrypt a file
  in the frame. The page sends `X-GC-Plugin: <the frame's plugin id>`;
  `/plugin-media/<token>` (and `…/preview`) answers 404 when that header names
  another plugin than the file's — a frame never reads another plugin's bytes,
  even with a valid URL of it. A range (`end` inclusive) of at most 16 MiB a call, a whole file
  only up to that size; four at a time per frame (429 busy); 400 for any other
  URL.
* **Tabs** (since 1.211.0): `await GC.openTab(url)` → `{ ok: true }` | `{ ok:
  false, code: 'invalid' | 'no_gesture' }` — the sandbox allows no popups, so
  the parent page opens one of the plugin's **public endpoints**
  (`/plugin-public/<plugin id>/…` of this origin, see "Public endpoints") in a
  new tab (`noopener`), and only during a click in the frame (the click's
  activation reaches the page).
* **Portal tabs** (since 1.254.0, portal frames only): `await GC.openPortal({
  plugin, query })` → `{ ok: true }` | `{ ok: false, code: 'invalid' |
  'not_found' | 'no_gesture' | 'rate_limited' | 'not_allowed' }` — the parent
  page opens **another plugin's portal tab** with the address of a direct link
  (`/portal?<key>=<value>#plg-<plugin>`, see "Portal" below; the tab's frame
  reads the query from its own `location.search`), e.g. a to-do of Mail in the
  Notizen hub opening its mail (`{ plugin: 'gatecontrol-mail', query: { open:
  'message/42' } }`). `query` follows the direct-link rules (keys
  `[a-z][A-Za-z0-9_]{0,31}` except `section`, string or number values ≤ 200
  characters, ≤ 8 of them; anything else → `invalid`); `not_found` when the
  viewer has no tab `plg-<plugin>` (plugin off, not for this person, no own
  tab); only during a click in the frame and at most once every 1.5 s. The
  portal page reloads with that address. Frames of the admin pages get
  `not_allowed`; feature-detect it (`typeof GC.openPortal === 'function'`) on
  older GateControl.
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
    frame (`/portal/plugins/<id>/frame`). A direct link
    `/portal?<key>=<value>#plg-<id>` hands its query on to that frame
    (`/portal/plugins/<id>/frame?<key>=<value>`, read from the frame's own
    `location.search`): keys `[a-z][A-Za-z0-9_]{0,31}` (e.g. `cloudError`) except `section`, values
    ≤ 200 characters, ≤ 8 of them; the portal's address bar keeps just the
    hash.
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
  The entitlements are those of the last validation, which runs once a day; a
  validation that failed because the licence server could not be reached
  (network error, timeout, 5xx, 429) is retried after 5 min, 15 min, 1 h, then
  hourly until it succeeds (a 4xx waits for the next day, `Retry-After` of a
  429 is honoured). In state `unreachable` the status carries `lastCheck
  { at, ok, reason }` (reason short: `HTTP 500`, `timeout`, `ENOTFOUND`) and
  `nextCheckAt`, as `GET /api/v1/license` does. A
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
  14 days. A check that failed for a network error, timeout, 5xx or 429 is
  retried like the GateControl licence (5 min, 15 min, 1 h, then hourly;
  `Retry-After` honoured); a 4xx without a licence answer waits for the daily
  check. `lastCheck` / `nextCheckAt` as above.

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
snapshot of its database (SQLite backup API on a read-only connection, never a
copy of the live file), its `files/` folder, whether it was switched on, the
third-party licence entry and the access targets (routes by domain, peers by
name — ids change on restore). `secret` settings are additionally stored as
plain encrypted backup fields, so restoring an off-site archive with its key
re-encrypts them like every other secret.

All plugins together are capped at **512 MB of raw data per backup**
(`MAX_PLUGIN_BYTES`, `src/services/plugins/backup.js`; the backup file holds
it as base64, a third more). The large parts are never held in memory: the
database snapshot (SQLite backup API in steps) and hard links of the
`files/` are kept in a private snapshot folder (`<data>/plugin-data/.backup-tmp/`,
removed when the backup is written, a left-over one after 12 hours) and read
in pieces while the file is written (`FileBase64Value`, `utils/jsonStream.js`).
A part that does not fit — or cannot be read — is left out; the plugin entry
says which (`skipped: ['database']`) and why (`skip_reasons: { database:
'too_large' | 'read_error' }`), and the backup file starts with
`plugins_incomplete: [{ id, name, parts: [{ part, reason }] }]` (before
`data`, so the backup list reads it from the first 64 KB). Such a backup is
**visible**, never silent:

* Einstellungen › Backup: the local file and the off-site target that got it
  show „⚠ Nicht vollständig: Mail (Datenbank zu groß für das Backup)“ with a
  short explanation and what to do; „Backup jetzt erstellen“ and the download
  say so too (`incomplete` of `POST /autobackup/run`, `GET /autobackup/list`,
  `last_incomplete` of `GET /backup/targets`, header `X-GC-Backup-Incomplete`
  of the download); the restore preview lists the missing parts
  (`summary.plugins_incomplete`), the restore test warns
  (`plugins_incomplete`).
* Dashboard › Probleme: `backup_incomplete` while the newest local backup is
  incomplete.
* Log line `Backup incomplete — not everything of these plugins is in it: …`
  with the plugin names, activity `autobackup_incomplete` (warning) — mails,
  push and webhooks of the notification row „Backup-Probleme“ like a failed
  backup.

Before a backup file is written, the free space of the backup disk is
checked (expected size + 64 MB); not enough → the backup is not made
(`NO_SPACE`, „Nicht genug freier Speicherplatz …“; scheduled: activity
`autobackup_failed`). Retention deletes the oldest files only after the new
one is complete — the disk needs room for `retention + 1` backups.

Plugin **media** (see "Media") are not part of that and not in a backup by
default: Plugins › Sicherheit & Upload → "Plugin-Medien im Backup" (off by
default; API `PUT /api/v1/plugins/policy { backupMedia }`, activity
`plugin_media_backup`) adds each plugin's claimed files — as stored
(encrypted), each with its file key as a regular backup secret (encrypted
with `GC_ENCRYPTION_KEY`, re-keyed with off-site archives) — up to 128 MB for
all plugins together; a plugin whose media do not fit is backed up without
them (`skipped: ['media']`). A restore writes them back and keeps media of
the plugin that are not in the backup.

The restore upload accepts up to **1 GB** (a JSON backup or an off-site
`.gcbk`). It is stored in a private folder on the backup disk
(`<backups>/.incoming/`, removed after the request) instead of in memory; an
archive is decrypted there as a stream (`gcbk.decryptBackupFileTo`, the GCM
tag checked at the end, nothing left on failure), and the JSON is read in
pieces (`utils/jsonSpool.js`): strings longer than 16 KB stay in the file
until the restore writes them (a plugin database is decoded into a temp file
and checked there, data files one at a time). The off-site restore test and
`src/bin/offsite-decrypt.js` use the same path. Memory measured with 400 MB of
plugin data (200 MB database + 200 MB files, a 536 MB backup file): backup
+32 MB, restore +63 MB, restore preview of the `.gcbk` without extra memory.
What stays in memory is the encrypted off-site archive while it is uploaded
(the transports take one buffer): about its size — 336 MB for that backup
(half of the data incompressible); the user's 67 MB backup gives 25 MB.

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

## Edge part (`edge`, Edge-Teil)

A plugin can bring a second part that runs **on a home gateway**, next to the
devices: UDP and multicast discovery, mDNS, TCP/HTTP to devices in the home
network, a local MQTT broker, a Zigbee stick. It runs in the gateway's own
container `gatecontrol-edge` (no privileges, its own user, a firewall that
lets it reach only the gateway's LAN subnets, the local broker and this
server) and talks to the plugin's server part over one WebSocket per gateway.
Nothing runs on a gateway until an administrator switches the plugin on **for
that gateway** and confirms the list of capabilities.

Code: `src/services/edge/` (manifest, state, channel `hub.js`, MQTT accounts,
packages) · admin API `src/routes/api/edge.js` · gateway endpoints
`src/routes/api/gateway.js` · test edge host `scripts/plugin-edge-host.js` ·
example `tests/fixtures/plugins/edge-demo/`.

### plugin.json

```json
"edge": {
  "entry": "edge/index.js",
  "minGateway": "1.20.0",
  "memoryMb": 48,
  "capabilities": {
    "udp":    { "ports": [5683], "multicast": ["224.0.1.187"] },
    "mdns":   { "services": ["_shelly._tcp"] },
    "tcp":    { "lan": true },
    "http":   { "lan": true },
    "mqtt":   { "topics": ["shellies/#"] },
    "serial": ["zigbee"]
  }
}
```

* `entry` — a `.js` file **inside a folder** of the package (the gateway
  unpacks only that folder and `plugin.json`).
* `minGateway` (optional) — older gateways keep the edge part off (`gateway_too_old`).
* `memoryMb` 16 … 256 (default 48) — the heap of the edge process
  (`--max-old-space-size`).
* `capabilities` — each optional; unknown keys refuse the package:
  * `udp.ports` 1024 … 65535, never 5353 (mDNS only through `mdns`), ≤ 16;
    `udp.multicast` IPv4 groups in 224.0.0.0/4 without 224.0.0.0/24 (except
    the mDNS group 224.0.0.251), ≤ 16;
  * `mdns.services` like `_shelly._tcp` (≤ 16);
  * `tcp.lan` / `http.lan` — connections to addresses in the gateway's LAN
    subnets (never the tunnel, never this server); HTTPS is always checked —
    fully, or against a pinned certificate for self-signed devices (see
    [Self-signed devices](#self-signed-devices-certificate-pinning)). `http`
    has only the key `lan`; the former `http.selfSigned` (HTTPS without
    certificate checks) is gone: a manifest with it is refused at install
    (`edge.capabilities.http.selfSigned: no longer supported — …`), and an
    older install or approval never passes it to a gateway;
  * `mqtt.topics` — topic filters on the gateway's broker: no leading `#`/`+`,
    nothing starting with `$` (`$SYS`), `#` only as the last level, ≤ 16;
  * `serial` — named devices (`zigbee`); the gateway maps the name to the
    device its hardware detection found.

A broken `edge` section refuses the install like any other manifest error
(check *manifest*, e.g. `edge.memoryMb: invalid (16…256)`). The install dialog
shows the section as `permissions.edge` `{ memoryMb, minGateway, capabilities:
[{ key, text }] }`. Plugins without `edge` are unchanged.

### Capabilities and approval

Capabilities become flat keys — `udp.port:5683`, `udp.multicast:224.0.1.187`,
`mdns:_shelly._tcp`, `tcp.lan`, `http.lan`, `mqtt.topic:shellies/#`,
`serial:zigbee` — and switching a plugin on for a gateway stores the confirmed
list (snapshot with the plugin version). An **update** that needs a key not
in that snapshot leaves the plugin off on that gateway (state
`update_pending`, activity `gateway_edge_update_pending`) until an
administrator confirms the new list; fewer capabilities need no
confirmation. **Unsigned** (or untrusted) plugins run on a gateway only while
*Unsignierte Edge-Teile erlauben* is on for it (`allowUnsignedEdge`, confirmed
with `ERLAUBEN`/`ALLOW`) — independent of the server-wide policy, which only
lets them be installed. A plugin that does not run on the server (disabled,
licence, …) is off on every gateway too (`plugin_off`).

### Server part: `gc.edge`

Only in plugins with an `edge` section:

* `gc.edge.gateways()` → `[{ id, name, state, online, version, reason }]` — the
  gateways the plugin is set up for. `state`: `running`, `starting`,
  `crashed`, `stopped`, `denied` (what the gateway reports), `pending` (no
  report yet), `offline`, `disabled`, `update_pending`, `unsigned`,
  `plugin_off`, `gateway_too_old`, `edge_off`.
  `offline` means: the gateway's **edge channel** is down — the WebSocket
  the gateway's edge container opens, not the gateway's heartbeat. `reason`
  says why (only with `offline`, else `null`; `null` also when the server
  cannot tell — older gateways, no edge telemetry yet). The server derives it
  from the gateway's last heartbeat (`telemetry.edge`,
  `src/services/edge/reason.js`), first match wins:
  * `gateway_offline` — no heartbeat within the down threshold (*Einstellungen
    › Gateways*): the gateway itself is away;
  * `edge_missing` — `telemetry.edge` is `null`: the gateway's compose file
    has no `edge` service (or the `gateway` service lacks the `edge-run`
    volume; Raspberry-Pi image: `EDGE=off`);
  * `edge_not_running` — no fresh summary of the edge host: the `edge`
    container is stopped or restarting (or the `gateway` service lacks the
    `edge-status` volume);
  * `compose_outdated` — gateway ≥ 1.23.0 whose edge container still runs in
    the host network (a compose file from before 1.23.0, `telemetry.edge.mode:
    'fence'`) and the gateway could not set the network fence (Synology: no
    `xt_owner`), so edge parts stay off (fail closed). The way out is the
    current compose file (*Nur docker-compose.yml herunterladen*), in which the
    edge container has no network at all (`network_mode: none`, everything
    through the gateway socket) — no kernel module;
  * `edge_fence` — the same on a gateway older than 1.23.0 (no `mode`):
    update the gateway, then the compose file. With `mode: 'isolated'` the
    fence never counts;
  * `edge_not_connected` — the edge host runs but has no channel to this
    server (address/DNS, firewall, a reverse proxy that does not pass
    WebSocket upgrades to `/api/v1/gateway/edge/ws`).

  `state` stays `offline` for all of them, so plugins written against older
  servers keep working; show `reason` when it is set and fall back to a
  generic "not connected" otherwise.
* `gc.edge.call(gatewayId, method, params, { timeoutMs })` → what the edge
  part's `gc.handle(method)` returned. `timeoutMs` ≤ 30000 (default 30000),
  `method` `[A-Za-z0-9_.:-]{1,64}`, the whole call ≤ 64 KB, ≤ 32 open calls per
  plugin.
* `gc.edge.on(name, handler)` → `off()`. `handler({ gatewayId, name, data, at,
  seq })` for the edge part's `gc.emit(name, data)`; `'*'` gets every event.
  The gateway gets its `ack` only **after the handlers ran** (a handler that
  throws counts as delivered — the error goes to the plugin's log), events of
  one gateway arrive one after another. If the plugin process cannot take an
  event (not running, its handlers time out after 15 s), the server tries
  again after 1 s, 2 s, 4 s … 30 s and acknowledges nothing after it first.
  Delivery is at least once: a `seq` seen before is not delivered again
  within one connection, but after a reconnect an event whose ack was lost
  can come twice. `seq` ascends per plugin but has gaps (the gateway starts
  from the time in ms). Built-in names (no
  `seq`, no ack): `$online` / `$offline` (the gateway's channel), `$started`
  (the edge part is running there — hand it its configuration again).
* `gc.edge.configure(gatewayId, data)` → `{ sent: true }` — JSON ≤ 48 KB, held
  **only in the edge part's memory**; never stored by the server or the
  gateway. Send it again on `$started` / `$online`.

Errors (`e.code`): `gateway_offline` (no channel, or it closed during the
call), `not_enabled` (not switched on / not allowed on that gateway now),
`timeout`, `edge_error` (the edge part failed: `e.message` is
`"<the gateway's or edge part's code>: <message>"`, e.g. `unknown_method: …`,
`not_running: …`, `EHOSTUNREACH: …`), `denied` (no `edge` section, or the
gateway refused a capability), `busy` (32 open calls), `too_large` (call or
result over 64 KB), `ERR_INVALID` (arguments).

`gc.mqtt.accounts` (plugins whose `edge.capabilities.mqtt` lists topics):
`create(gatewayId, { name?, label?, topics })` → `{ username, password, acl,
label }` — an account for one of its devices, user name `<plugin id>-<name or
random>`, every topic below one of the plugin's `mqtt.topics` (else `denied`),
the password **only in this answer**; `list(gatewayId)`, `remove(gatewayId,
username)` — its own accounts only. At most 200 per plugin and gateway.

### Edge part: the process on the gateway

`module.exports = (gc) => { … }` (or an object with `start(gc)`) in
`edge.entry`. The gateway side documents the API in detail; in short:
`gc.handle(method, fn)`, `gc.emit(name, data)`, `gc.config()`,
`gc.onConfig(fn)`, `gc.store.get/set/delete` (≤ 1 MB, a file in its own
folder), `gc.log.info/warn/error`, `gc.lan.udp.bind(port, opts, onMessage)` /
`.send(host, port, buf)`, `gc.lan.mdns.browse(service, onFound)`,
`gc.lan.tcp.connect(host, port)`, `gc.lan.http.request({ method, url,
headers, body, timeoutMs, pinSha256 })`, `gc.lan.tlsFingerprint({ host, port,
timeoutMs })`, `gc.mqtt.subscribe(topic, fn)` /
`.publish(topic, payload, { retain, qos })`, `gc.serial.open(name, {
baudRate })`. Each checks the approved capabilities; addresses only in the
gateway's LAN subnets.

#### Self-signed devices: certificate pinning

HTTPS from an edge part is **always** verified — there is no option to switch
the check off. Without anything extra the gateway checks the chain and the
name/IP like a browser, so a device with a self-signed certificate (NAS,
router, camera, hub) fails with `tls_error`. Such devices are reached only
with a **pinned certificate**: `pinSha256` is the SHA-256 of the device's leaf
certificate (64 hex characters; colons, upper case or a `sha256:` prefix are
accepted). The pin replaces the chain check, and the request gets its
connection only once the certificate matches — on a mismatch not a byte of it
(no header, no password) leaves the gateway.

* **First contact (trust on first use):** `gc.lan.tlsFingerprint({ host,
  port = 443, timeoutMs = 10000 })` → `{ sha256, subject, issuer, validTo,
  selfSigned }` of the device's leaf certificate. It does the TLS handshake
  only (no request, no data) and needs `http.lan` or `tcp.lan`; same targets
  as `gc.lan.*` (IPv4 in the gateway's private LAN subnets), timeout 1–30 s.
  `sha256` is 64 lower-case hex characters — use it as `pinSha256` as it is;
  `subject`/`issuer` are one line (`CN=…, O=…`), `validTo` ISO 8601.
* **Ask the administrator** before trusting it: hand the values to the server
  part (a call's result or an event), show them on the plugin's own settings
  page ("Device 192.168.1.20 presents certificate CN=…, SHA-256 …, valid
  until … — trust it?") and store the confirmed `sha256` (the edge part keeps
  it in `gc.store`, or the server part sends it with `gc.edge.configure`).
  Never trust a fingerprint automatically.
* **Certificate changed (`tls_pin_mismatch`):** a pinned request to a device
  whose certificate no longer matches fails with `e.code ===
  'tls_pin_mismatch'`; the error carries `e.sha256` (what the device presents
  now), `e.expectedSha256` (the pin) and `e.certificate` (`{ sha256, subject,
  issuer, validTo, selfSigned }` or `null`). The device may have renewed its
  certificate — or something else answers on its address. Ask the
  administrator again the same way; keep the old pin until they confirm.
  Through `gc.edge.call` only `e.code`/`e.message` reach the server part
  (`edge_error`, `"tls_pin_mismatch: …"`), so return the new values from the
  handler instead of throwing.

```js
// edge/index.js
module.exports = (gc) => {
  const DEVICE = { host: '192.168.1.20', port: 8443 };

  gc.handle('certificate', () => gc.lan.tlsFingerprint(DEVICE));          // first contact
  gc.handle('trust', async ({ sha256 }) => { await gc.store.set('pin', sha256); return {}; });

  gc.handle('status', async () => {
    const pin = await gc.store.get('pin');
    if (!pin) return { trust: 'needed', certificate: await gc.lan.tlsFingerprint(DEVICE) };
    try {
      const r = await gc.lan.http.request({ url: `https://${DEVICE.host}:${DEVICE.port}/api/status`, pinSha256: pin });
      return { trust: 'ok', status: r.json() };
    } catch (e) {
      if (e.code !== 'tls_pin_mismatch') throw e;
      return { trust: 'changed', pinned: e.expectedSha256, certificate: e.certificate || { sha256: e.sha256 } };
    }
  });
};

// server part: the settings page asks the administrator
const s = await gc.edge.call(gatewayId, 'status');
if (s.trust !== 'ok') { /* show s.certificate (and s.pinned) and a "Trust" button */ }
// on "Trust": await gc.edge.call(gatewayId, 'trust', { sha256: s.certificate.sha256 });
```

Needs a gateway with `gc.lan.tlsFingerprint` (set `edge.minGateway`
accordingly). A call with the removed option `insecure: true` is refused with
`denied`.

### Protocol (gc-edge.v1)

The gateway's edge container opens `GET /api/v1/gateway/edge/ws` with
`Authorization: Bearer <apiToken of the gateway>` and subprotocol
`gc-edge.v1` (anything else: `401`/`403`/`400` before the upgrade; 30 failed
attempts per IP in 5 minutes → `429`). JSON text frames ≤ 64 KB (larger:
close 1009, binary 1003, invalid JSON 1007); the server pings every 20 s and
drops a channel silent for 60 s; a newer channel of the same gateway replaces
the older one (4000); a disabled gateway or a rotated token ends it (4001).
The first frame must be `hello` within 10 s (else 1008).

Gateway → server: `hello { v: 1, gw: { version, edgeHost, mqtt: { available },
fence: { active, backend }, isolation: { mode: 'isolated'|'fence', active }, hardware } }`
(`isolation` from gateway 1.23.0; isolated gateways report `fence.backend: 'isolated'`) · `status { plugins: [{ id, version, state, rssMb, restarts,
lastError, throttled (dropped events since the last status), buffered }], mqtt: { running, clients, accounts: [{ user,
connected, lastSeen }] } }` (on change and every 30 s) · `result { id, ok,
result | error: { code, message } }` · `event { plugin, name, data, at, seq }`
(`seq` ascending per plugin, with gaps; after the first `state` of a channel
the gateway sends every unacknowledged event again) · `log { plugin, level, line }`.

Server → gateway: `state` after `hello` and on every change — the complete
target state: `{ edgeEnabled, allowUnsigned, plugins: [{ id, version, sha256,
caps, memoryMb, enabled, reason? }], mqtt: { enabled, tls, accounts: [{ user,
hash, acl: [{ access, topic }] }], pluginTopics: { <id>: [topics] } } }`
(`reason` for `enabled: false`: `disabled`, `update_pending`, `unsigned`,
`plugin_off`, `gateway_too_old`; `caps` of a switched-off entry is the
approved snapshot) · `ack { plugin, seq }` · `call { id, plugin, method,
params, timeoutMs }` · `configure { plugin, data }`.

Limits on the server: up to 1000 events waiting per gateway × plugin (more
are dropped unacknowledged — the gateway keeps them and sends them again —
and noted as throttled; the gateway itself sends at most 50/s), 20 log
lines/s (more are dropped), log lines ≤ 2 KB, 3000 frames/s per channel
(more: close 1008).

Gateways run edge parts from **gatecontrol-gateway 1.19.0** on
(`EDGE_MIN_GATEWAY`; the admin API reports `support: { gatewayVersion,
edgeSupported, edgeMinGateway }` from the hello or the last heartbeat).
Compose (the gateway's set-up in GateControl: Synology package, Linux
compose, token dialog — host network only) carries the services of the
gateway's `docker-compose.example.yml`: `edge` — the gateway image with
`node src/edge/main.js`, user 61001, `cap_drop: ALL`, `no-new-privileges`,
read-only, `mem_limit 512m`, `pids_limit 256` — and `mqtt` — mosquitto
(`eclipse-mosquitto:2.1.2-alpine`, pinned by digest) behind a small watcher
that starts it once the edge host has written its configuration, user 61001,
no privileges, read-only, `mem_limit 128m`, `pids_limit 32` — with the
volumes `edge-run` / `edge-status` (tmpfs shared with the gateway),
`edge-state` and `edge-mqtt`. Both stay idle until the server switches edge
parts (and MQTT) on for the gateway. `update.sh` (vendored from the gateway
release) also recreates `edge` with the new gateway image.

Packages: `GET /api/v1/gateway/edge/packages/<id>/<version>` (Bearer apiToken)
returns the signed `.gcplugin` byte for byte as installed (`X-Content-SHA256`
= `sha256` of the state) — only to a gateway the plugin is switched on for
(`403 { error: 'not_enabled', reason }`), only the installed version (`404`).
The gateway verifies the signature itself (format "Signature") with the
trusted publisher keys in its image.

### MQTT broker

Per gateway *MQTT-Broker* (`mqttEnabled`, optional `mqttTls`; effective only
while the gateway's edge switch is on too — the edge host manages the broker): mosquitto on
the gateway on its LAN addresses, no anonymous access. **TLS** (`mqttTls`, off by
default): port 8883 in addition to 1883, with a certificate the gateway creates
itself and keeps across restarts. The gateway says in its hello whether it can do
that (`gw.mqtt.tlsCert` → `gateway.mqttTlsSupported`; older gateways: the switch
is locked, "Gateway-Update nötig") and reports the certificate in its status:
`mqtt.status.tls` (`off` | `on` | `missing_cert`), with `on` also `tlsSha256`
(fingerprint, 64 hex characters), `tlsValidTo` and `tlsCert` (PEM — the server
keeps it only when its SHA-256 is the reported fingerprint). The page shows the
fingerprint to enter into devices. Device accounts are made in the admin API or by plugins
(`gc.mqtt.accounts`). The password is generated by the server and shown
**once**; stored and sent to the gateway is only the mosquitto hash
`$7$101$<base64 salt, 12 bytes>$<base64 PBKDF2-HMAC-SHA512, 64 bytes>` (the
format of `mosquitto_passwd`), never in the admin API, the activity log or
the ring buffer. ACL: the topics given (`readwrite`, `read` or `write`; same
rules as plugin topics, ≤ 16), by default `devices/<user>/#`; at most 256
accounts per gateway (the broker's limit); a
`vendorPrefix` adds `<prefix>/<user>/#`. Locked accounts are left out of the
state. The edge host's own account (access to the `pluginTopics` only) is the
gateway's business; the user names `gc-edge`, `gatecontrol`, `edge`, `admin`
and `root` are reserved.

### Administration

Admin API (session, CSRF, admin role — API tokens are refused), under `/api/v1/edge`:

| Endpoint | Purpose |
| --- | --- |
| `GET /gateways` | every gateway: switches, channel, gateway version and edge support (`support`), counts (assigned, on, needing attention), MQTT |
| `GET /gateways/:id` | one gateway: switches, channel, hello (versions, hardware), every plugin with an edge part (capabilities, assignment, state and `reason`, new capabilities, last status), MQTT status and accounts |
| `PUT /gateways/:id/settings` | `{ edgeEnabled, mqttEnabled, mqttTls, allowUnsignedEdge, confirm }` |
| `POST /gateways/:id/plugins/:pluginId/enable` | `{ capabilities: [keys] }` — exactly the current list, else `409 caps_mismatch` with it; unsigned without `allowUnsignedEdge` → `409 unsigned_blocked` |
| `POST /gateways/:id/plugins/:pluginId/disable` | switch off |
| `GET /gateways/:id/logs?plugin=&kind=&limit=&before=` | ring buffer, newest first (`kind` `log`, `event`, `system`; `plugin=` empty: the gateway's own notes); 500 entries per gateway × plugin |
| `GET /gateways/:id/mqtt/accounts` | accounts (no password, no hash) |
| `POST /gateways/:id/mqtt/accounts` | `{ username, label, topics, vendorPrefix }` → `201 { account, password }` |
| `PUT /gateways/:id/mqtt/accounts/:accountId` | `{ locked }` |
| `POST /gateways/:id/mqtt/accounts/:accountId/password` | a new password, once |
| `DELETE /gateways/:id/mqtt/accounts/:accountId` | delete |
| `GET /plugins/:pluginId` | a plugin's edge part on every gateway |

The channel (`connection`) is `{ online, connectedAt, lastSeen, reason,
detail }`: while it is down, `reason` as for `gc.edge.gateways()` and `detail`
the gateway's own error text for `compose_outdated`/`edge_fence` (the fence error) and
`edge_not_connected` (e.g. `resolve: ENOTFOUND`), else `null`. An assignment
with state `offline` carries the same `reason`. The tabs *Edge-Plugins* and
*MQTT* show the reason with a next step and a link to the gateway's guide
(Synology: its own section) instead of a bare "not connected".

Activity log (category *Peers & Gateways*): `gateway_edge_enabled` /
`gateway_edge_disabled`, `gateway_edge_unsigned_allowed` /
`gateway_edge_unsigned_blocked`, `gateway_edge_plugin_enabled` /
`gateway_edge_plugin_disabled`, `gateway_edge_caps_approved` (the newly
approved keys), `gateway_edge_update_pending`, `gateway_edge_plugin_crashed`
and `gateway_edge_plugin_throttled` (at most once per 10 minutes per gateway ×
plugin), `gateway_mqtt_enabled` / `gateway_mqtt_disabled`,
`gateway_mqtt_account_created` / `_locked` / `_unlocked` / `_password` /
`_deleted`.

Uninstall *Alles löschen* forgets the plugin's approvals, its ring buffer and
the MQTT accounts it created; *Daten behalten* keeps them for a reinstall.

### Testing

`scripts/plugin-edge-host.js` is a fake gateway edge container that speaks
gc-edge.v1 — for the server's tests and for plugin authors trying their
server part without a gateway:

```js
const { createEdgeHost } = require('<gatecontrol>/scripts/plugin-edge-host');
const host = await createEdgeHost({ serverUrl: 'http://127.0.0.1:3000', apiToken: 'gc_gw_…' });
host.handle('my-plugin', 'devices.list', async (params, ctx) => [{ id: 'lamp' }]);
await host.waitForState((s) => s.plugins.some((p) => p.id === 'my-plugin' && p.enabled));
const seq = host.emit('my-plugin', 'device.found', { id: 'lamp' });
await host.waitForAck('my-plugin', seq);      // after the plugin's gc.edge.on handlers ran
host.configOf('my-plugin');                    // the last gc.edge.configure data
host.reportStatus({ plugins: [{ id: 'my-plugin', version: '1.0.0', state: 'crashed', restarts: 1 }] });
await host.close();
```

It answers calls with the registered handlers (`ctx.emit`, `ctx.config`),
refuses calls for plugins the state does not switch on (`not_enabled`),
reports switched-on plugins as `running` after each state (`autoStatus`),
keeps unacknowledged events (`resend(pluginId)`), and records every frame
(`frames`, `state`, `acks`, `configs`). From the command line, against a
development server and the gateway's apiToken (from its `gateway.env`):

```
node scripts/plugin-edge-host.js --server http://localhost:3000 --token gc_gw_… [--handlers ./edge-fake.js]
```

`--handlers` exports `{ '<plugin id>': { '<method>': async (params, ctx) => result } }`;
without it every call answers `{ echo: params }`. The frames are printed
(MQTT hashes left out). The server's own tests: `tests/edge_*.test.js`.

## Lifecycle and activity log

install (`plugin_installed`) · update (`plugin_updated`) · enable/disable
(`plugin_enabled`/`plugin_disabled`) · built-in data imported (`plugin_legacy_imported`) · stopped by licence/signature/version
(`plugin_suspended`) · uninstall (`plugin_uninstalled`, mode keep/wipe) ·
"Unsignierte Plugins erlauben" (`plugin_unsigned_allowed`/`plugin_unsigned_blocked`)
· access targets (`plugin_target_changed`) · a setup notice marked as done
(`plugin_notice_done`) · plugin notifications
(`plugin_notice`) · quick actions run from an app (`plugin_quick_action`) ·
quick actions run by another plugin (`plugin_automation`) ·
kiosk users marked/unmarked (`kiosk_user_allowed`/`kiosk_user_disallowed`,
only when something changed) · services called by another plugin
(`plugin_service`) · media quota changed (`plugin_media_quota`) · "Plugin-Medien
im Backup" switched (`plugin_media_backup`) · chat notifications: one neutral
`plugin_notice` line per hour with the count. Edge parts on gateways: see
"Edge part" › "Administration".

Uninstall *Daten behalten* removes code and registry entry and keeps data,
licence and access targets for a reinstall; *Alles löschen* (typed plugin name)
removes everything.

## Not yet (later stages)

* automatic updates (the catalogue says "Update verfügbar"; the
  administrator starts each update and confirms its permissions);
* dropping the built-in tables once every installation has imported them;
* releasing a licence ("Lizenz freigeben") from the plugin card.
