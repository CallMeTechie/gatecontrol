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
as a page of its own (**Plugins › Katalog**, see "Plugin area" below): areas,
search, highlight, cards with *Installieren* / *Aktualisieren*, one page per
plugin with its release notes. When GitHub cannot be reached the page says so
("Katalog nicht erreichbar – Plugins lassen sich weiterhin hochladen.") — the
upload is unaffected.

Store metadata (optional, from `catalog-meta.json` of the plugins repository;
an unknown or malformed value is dropped, never the catalogue): per plugin
`category` (`family` | `home` | `mobility` | `infrastructure` | `other`),
`icon` (`family` `chat` `calendar` `door` `bulb` `snowflake` `car` `server`
`nas` `puzzle`), `summary` `{de, en}`, `audience` (`all` | `admins`),
`keywords`, `related` (plugin ids) and `highlight` `{version, title, text}`;
per version `notes` (its CHANGELOG section, Markdown). Without them a plugin
is listed under "Weitere" with the default icon.

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
* `GET /api/v1/plugin-catalog` items also carry `category, icon, summary, audience, keywords, related, highlight` and `latest.notes`; the answer `source: { host, official }`
* `GET /api/v1/plugin-catalog/updates` → `{ updates: [{ id, name, from, to, kind: patch|minor|major, gatecontrol, size, needsApproval, notes: [{ version, publishedAt, notes }] }], autoUpdate, catalogCheck, history }`
* `GET /api/v1/plugin-catalog/:id` → one plugin with `versions` (newest first, at most 20, with `notes`)
* `POST /api/v1/plugin-catalog/install` `{ id, version }` → the answer of `POST /api/v1/plugins/inspect` (`origin: "catalog"`; on an update `existing.permissions` for the diff)

## Plugin area

Plugins have an area of their own in the sidebar group "Integrationen"
(**Plugins**, badge: plugins stopped by a problem or crashed plus the updates
of the cached catalogue). One page, `templates/aurora/pages/plugins.njk`, the
views are built by `public/js/plugins-page.js` (pure helpers in
`public/js/plugins-ui.js`):

| URL | View |
|---|---|
| `/plugins` | Meine Plugins: state tiles, "Braucht deine Aufmerksamkeit" (crashed, licence, unsigned, expiring licence, updates — each with its action), search, filter, list or tiles grouped by area, suggestions; without plugins the first-run page |
| `/plugins/catalog`, `/plugins/catalog/<id>` | the catalogue; one plugin with description, versions and the install panel |
| `/plugins/manage/<id>` | one installed plugin: Übersicht, Einstellungen, Berechtigungen, Lizenz, Protokoll, Versionen; restart, switch, update, uninstall |
| `/plugins/updates` | updates with release notes, *Alle aktualisieren*, automatic updates, history |
| `/plugins/licenses` | a first-party licence key without naming the plugin; the licences of all plugins |
| `/plugins/security` | upload with preview, unsigned plugins, media in backups, update checks, catalogue source |

These path segments are reserved: `plugin.json` cannot use `catalog`,
`updates`, `licenses`, `security` or `manage` as its id. Settings → Plugins
only points here; old links (`/settings#plugins`, `?plugin=<id>`,
`?install=<id>`) are forwarded.

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
    "services": ["gatecontrol-messenger:send_message"]
  },
  "media": { "maxBytes": 26214400, "types": ["image/jpeg", "image/webp", "audio/ogg", "application/pdf"], "quotaDefault": "10GB" },
  "services": { "provides": { "scene": { "label": { "de": "Szene schalten", "en": "Switch a scene" } } } },
  "ui": {
    "nav": { "label": { "de": "Smart Home", "en": "Smart Home" }, "icon": "<svg path d>" },
    "pages": [{ "id": "main", "title": { "de": "Smart Home", "en": "Smart Home" } }],
    "settings": [
      { "key": "interval", "type": "number", "label": "Abfrageintervall", "min": 10, "max": 3600, "default": 30 },
      { "key": "token", "type": "secret", "label": "API-Schlüssel" }
    ],
    "portal": {
      "label": { "de": "Klima", "en": "Climate" }, "icon": "<svg path d>",
      "sections": [{ "id": "smarthome", "tab": "home", "title": { "de": "Smart Home", "en": "Smart Home" }, "order": 20 }]
    },
    "app": { "label": { "de": "Smart Home", "en": "Smart Home" }, "icon": "<svg path d>" },
    "maps": true,
    "geolocation": true,
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
  messages, documents). `maxBytes` an integer 1024 … 104857600 (100 MB) per
  file; `types` 1 … 32 MIME types (`image|audio|video|application|text/…`,
  lower-cased; never types a browser runs — HTML, XML, SVG, JavaScript, CSS —
  nor the host's own body types JSON / form data); `quotaDefault` the storage
  quota of all the plugin's files, `"10GB"`, `"500 MB"` (KB/MB/GB/TB) or bytes,
  1 MB … 1 TB and ≥ `maxBytes`, default 1 GB — the administrator changes it on
  the plugin's overview. Errors `media: invalid`, `media.maxBytes: invalid`,
  `media.types: invalid`, `media.quotaDefault: invalid`. See "Media".
* `permissions.events` (boolean, since 1.177.0): realtime events to the
  plugin's users (`gc.events.emit`) — see "Realtime events". The install
  dialog shows "Live-Ereignisse: darf Live-Ereignisse an die Apps und
  Plugin-Seiten seiner Benutzer senden".
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
    // req = { method, path, query, body, user: { id, name, role, portal?, loggedIn?, app? }, lang }
    return { status: 200, json: { ok: true } };
  },
  async render(view, gc) {                  // pages and the portal tab
    // view = { view: 'page'|'portal', page, user, lang }
    return { html: '<h1>…</h1>' };
  },
  async tick(gc) {},                        // background run (permissions.background, every 5…86400 s)
  async settingsChanged(values, gc) {},
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
  async notifyAction({ userId, notificationId, action, data }, gc) {  // optional: a `callback` button of one of
  },                                        // this plugin's pushes was pressed — once per push and button (see "Callback buttons")
};
```

`gc` (every call goes over IPC to the host, which checks the permission):

| | |
|---|---|
| `gc.plugin` | `{ id, version, filesDir }` — `filesDir` is the only folder the plugin may write |
| `gc.log.debug/info/warn/error(...)` | the plugin's log (*Protokoll* tab); `console.*` goes there too |
| `gc.http.fetch(url, opts)` | internet hosts |
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
| `gc.media.info(id)` | `{ mediaId, mime, bytes, sha256, owner, createdAt, claimed }` of one of the plugin's files, or `null` (`media`) — see "Media" |
| `gc.media.claim(id)` | keep a new upload (unclaimed files are removed after 24 h); idempotent → the info; unknown id → `ERR_INVALID` |
| `gc.media.delete(id)` | delete the file → `true` (`false` when unknown) |
| `gc.media.usage()` | `{ bytes, count, quota, maxBytes, types }` |
| `gc.media.url(id, { user, ttlS })` | `/plugin-media/<token>` — a signed URL a frame can show (`<img>`, `<audio>`) for `ttlS` seconds (60 … 86400, default 3600) |
| `gc.events.emit({ users, type, data })` | realtime event to the listed people's apps and frames → `{ delivered }` (`events`, ≤ 600/min) — see "Realtime events" |
| `gc.services.call({ plugin, service, userId, payload })` | another plugin's service → its answer (`permissions.services`, ≤ 60/h) — see "Services" |
| `gc.services.available(plugin, service)` | `true`/`false`: would `call()` reach that provider now (listed, installed, running, provided) — the provider is not run, not counted (since 1.178.0) |
| `gc.license.status()` | `{ required, licensed, state, expiresAt }` |

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
    (unknown, not usable, no `media`), `411 length_required`, `413 too_large`,
    `415 unsupported_type`, `507 quota_exceeded`, `400 aborted |
    length_mismatch`.
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
  created_at, ref_count, claimed_at, key_enc`) wrapped with a key derived
  (HKDF-SHA256) from the server secret (`GC_SECRET`). Honest limit: whoever
  has root on the server can decrypt them; the encryption protects against
  copies of the data folder.
* **Quota**: `media.quotaDefault`, changed by the administrator on the
  plugin's overview (Plugins › the plugin › Übersicht → Medien; API `GET/PUT
  /api/v1/plugins/<id>/media/settings` `{ quotaBytes }`, `null` = the default;
  activity `plugin_media_quota`). Unclaimed files count.
* No conversion: the apps scale pictures before the upload (long side 2048
  px, WebP/JPEG) and may upload a small preview (≤ 64 KB) as a file of its
  own. GateControl has no image or audio processing.
* Uninstall "Daten behalten" keeps the files, "Alles löschen" deletes them.
* Errors of `gc.media.*`: `ERR_MEDIA_DENIED` (no `media` in plugin.json),
  `ERR_INVALID` (bad id, unknown id for `claim`/`url`, bad `user`/`ttlS`). A
  plugin only ever sees its own files.

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
// caller (permissions.services: ["gatecontrol-messenger:sync_group", "gatecontrol-messenger:send_message"])
if (await gc.services.available('gatecontrol-messenger', 'send_message')) {
  await gc.services.call({ plugin: 'gatecontrol-messenger', service: 'sync_group',
    payload: { key: 'family', title: 'Familie', userIds: [12, 15, 17] } });
  const res = await gc.services.call({ plugin: 'gatecontrol-messenger', service: 'send_message', userId: 12,
    payload: { conversation: 'family', text: 'Tim ist zu Hause' } });   // or 'user:<id>', 'group:<id>'; title? for a notice channel
  // res: { ok: true, conversationId: 12, messageId: 4711 } — or { ok: false, code: 'invalid' | 'not_found' | 'forbidden' }
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
löschen" is deleting one folder, the file has a size cap (256 MB) and a
runaway query blocks only that worker (terminated after 5 s). Statements with
`ATTACH`, `DETACH`, `VACUUM`, `PRAGMA`, `load_extension` or the host's `_gc_*`
tables are refused. The plugin process can write only the sibling `files/`
folder, never the database file.

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
  (Einstellungen tab) — no plugin HTML in the settings page.
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
    whole `widget` `null`, the action stays.
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
                              confirmWhen, look, verbs, targets, device, widget }] }

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
  true, loggedIn: true, app: true }` (the quick actions' viewer). `app: true`
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
`{ ok: false, code: 'rate_limited' }`.

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
