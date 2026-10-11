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
format in that repository's README, "Catalogue"). Settings → Plugins →
**Offizielle Plugins** lists it: name, description, version, licence hint,
state, *Installieren* / *Aktualisieren*, *Katalog neu laden*. Installed
plugins with a newer compatible version get **Update verfügbar** on their
card and *Auf vX aktualisieren* in their detail. When GitHub cannot be
reached the card says so ("Katalog nicht erreichbar – Plugins lassen sich
weiterhin hochladen.") — the upload is unaffected.

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
* `POST /api/v1/plugin-catalog/install` `{ id, version }` → the answer of `POST /api/v1/plugins/inspect` (`origin: "catalog"`; on an update `existing.permissions` for the diff)

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

**Unsignierte Plugins erlauben** (Settings → Plugins → Sicherheit, default
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
    "notify": true,
    "background": { "intervalSeconds": 60 }
  },
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
    }
  },
  "license": { "required": true, "server": "https://licenses.example.com/check" },
  "migrations": "migrations",
  "notifyTopics": [
    { "id": "charging", "label": { "de": "Laden abgeschlossen", "en": "Charging complete" }, "default": true }
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
* `notifyTopics` (optional, needs `permissions.notify`): up to 20 own push
  topics, `id` `[a-z][a-z0-9_-]{0,31}`, `label` text (≤ 60), `default`
  (boolean, default `true`: people get the topic until they switch it off; `false`:
  only who subscribes). Each becomes the topic `plugin:<id>:<topic>` — a rule in
  System › Benachrichtigungen, a channel in the apps and a switch in the portal.
  See "Notifications" below.

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
   (Settings → Plugins → Einstellungen → *Zugriffsziele*): a GateControl route
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
  async request(req, gc) {                  // the plugin's API (admin and portal)
    // req = { method, path, query, body, user: { id, name, role, portal?, loggedIn? }, lang }
    return { status: 200, json: { ok: true } };
  },
  async render(view, gc) {                  // pages and the portal tab
    // view = { view: 'page'|'portal', page, user, lang }
    return { html: '<h1>…</h1>' };
  },
  async tick(gc) {},                        // background run (permissions.background)
  async settingsChanged(values, gc) {},
  async portalVisible({ user, lang, section }, gc) {  // optional: false hides the portal tab/section for this viewer
    return true;                            // (no hook, an error or no answer within 1.5 s → shown)
  },
  async portalTiles({ user, lang }, gc) { return []; },     // optional: Start tiles (see "Portal")
  async portalSearch({ user, lang, q }, gc) { return []; }, // optional: portal search results
  async legacyImport(snapshot, gc) {        // optional, first-party only: built-in data handed over once
    return { ok: true };                    // (see "Built-in data import" below)
  },
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
| `gc.users.list()/get(id)` | `{ id, name, role }` of enabled users (`users`) |
| `gc.notify(message, { severity })` | activity log + webhooks, and a push on `plugin:<id>:default` (`notify`, ≤ 30/h) — see "Notifications" |
| `gc.notify({ topic, title, body, priority, users, collapseKey, ttl, data })` | push on a declared `notifyTopics` topic (+ activity row) → `{ pushed, id }` |
| `gc.license.status()` | `{ required, licensed, state, expiresAt }` |

Requests reach the plugin only after GateControl's own authentication, CSRF
check and rate limit, as plain objects; actions run with the requesting
user's rights (`req.user`) — a plugin never gets admin rights implicitly.
Admin API: `/api/v1/plugins/<id>/api/<path>` (administrators); portal:
`/api/v1/portal/plugins/<id>/api/<path>` (the identified portal viewer; changes
need a portal or web login). A portal viewer comes as `user.portal = true` with
`user.loggedIn`: `true` after a portal or web login, `false` when the viewer is
only recognised by device trust (read-only) — data as sensitive as a vehicle's
position or departure times belongs to a real login only. The portal hooks
(`portalVisible`, `portalTiles`, `portalSearch`) and `render` get the same
viewer.

## Notifications

`gc.notify` reaches the GateControl apps through the notification center
(docs/feature-notification-center.md) — pushed by GateControl itself, no
third-party service. Both forms need `permissions.notify` and share the limit
of **30 per hour and plugin**; every call also writes the `plugin_notice`
activity entry (and its webhooks) as before.

```js
// old form — unchanged; push on topic plugin:<id>:default, title = plugin name,
// priority info (severity warning/error → normal)
await gc.notify('Laden abgeschlossen', { severity: 'info' });

// new form
const { pushed, id } = await gc.notify({
  topic: 'charging',              // declared in plugin.json notifyTopics ('default' always exists)
  title: 'Laden abgeschlossen',   // ≤ 120 characters, required
  body: 'Enyaq · 80 % · ca. 390 km', // ≤ 1000
  priority: 'normal',             // info | normal | high ('critical' is capped to high)
  users: [12],                    // optional: only these people (otherwise the topic's subscribers)
  collapseKey: 'charge:VIN123',   // optional: same key replaces the shown notification
  ttl: 6 * 3600,                  // optional, seconds (60 … retention of the server)
  data: { vin: 'VIN123' }         // optional JSON ≤ 4 KB; data.route defaults to 'plg-<id>' (the plugin tab)
});
```

* Errors: `ERR_NOTIFY_DENIED` (no permission), `ERR_INVALID` (undeclared topic,
  empty title, bad priority/users/ttl/collapseKey, `data` not an object or over
  4 KB), `ERR_RATE_LIMIT`.
* Push needs the licence feature `email_alerts` ("Benachrichtigungen Pro");
  without it only the activity entry is written and `pushed` is `false`.
* Who gets it: the rule of the topic (System › Benachrichtigungen; default:
  subscribers). A person's topic switch (portal) and quiet hours apply; the
  administrator can switch a plugin topic off.
* `data.actions` may only use the fixed action types (`open_app_route`,
  `open_portal`, `mute_1h`, `ack`, `done`); control characters are removed,
  the apps show text only.
* `data.facts` (optional): up to 6 `{ label, value }` pairs the apps show
  under the text, e.g. `[{ label: 'Akku', value: '80 %' }]` — one line each,
  label ≤ 60 and value ≤ 120 characters; anything else is dropped. Schedules ("evening before 18:00") are the
  plugin's own job (`background` + `gc.storage`).

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
  link to Settings → Plugins for administrators).
* **Pages and portal tab**: plugin HTML is untrusted, so it never becomes part
  of a GateControl page. It is served on its own URL (`/plugins/<id>/frame/<page>`,
  `/portal/plugins/<id>/frame`) with `Content-Security-Policy: sandbox
  allow-scripts allow-forms; connect-src 'none'; form-action 'none'; …` and
  shown in an `<iframe sandbox="allow-scripts allow-forms">` (no
  `allow-same-origin`): an opaque origin without cookies, storage or access to
  the page, even when the URL is opened directly. The frame talks to its
  plugin's API through the parent page (`window.GC.call()` inside the frame →
  `postMessage` → `public/js/plugin-bridge.js`, which only accepts messages of
  that frame and only calls that plugin's API base with the user's session and
  CSRF token). Chosen over a declarative JSON UI because it is general enough
  for the existing Smart Home / Klimaanlage / Fahrzeuge pages.
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
    `[{ section?, title, value?, unit?, state?, icon? }]` (≤ 8; `state` one of
    `on`, `off`, `good`, `warn`, `crit`; `icon` an SVG path like
    `ui.nav.icon`). GateControl renders them on the Start tab — in the
    "Zuhause"/"Fahrzeug" card for sections (shown once a tile arrives), in a
    card of its own for the plugin's tab — and links them to the section (`#zuhause` + scroll). Never
    plugin HTML on Start. `GET /api/v1/portal/plugins/start`.
  * **search**: optional hook `portalSearch({ user, lang, q })` (`q` 2–100
    characters) → `[{ title, subtitle?, section? }]` (≤ 10), shown after the
    portal's own results (services, devices), linked like the tiles. `GET /api/v1/portal/plugins/search?q=`.
  * Every hook has **1.5 s** per plugin (all plugins in parallel); a slow,
    failing or garbage-answering plugin only loses its own part. Texts are
    capped and control characters removed; a tile/result naming a section
    the viewer cannot see is dropped. The hooks get the viewer and must only
    answer with what that person may see (the host passes nobody else).
* Sandboxed frames have no `alert`/`confirm`/`prompt` (no `allow-modals`):
  plugins draw their own dialogs.

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
48 MB per backup; data that does not fit is left out and logged (the restore
upload accepts up to 96 MB).

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
  imported**, the dashboard and Settings → Plugins say that the feature is a
  plugin now ("Smart Home ist jetzt ein Plugin. Installiere „Smart Home“ …",
  i18n `plugins.moved.*`) and offer it: with the catalogue on, *Jetzt
  installieren* (Settings → Plugins: starts the catalogue install; the
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
* **When**: offered on the plugin's detail page (Settings → Plugins) as soon
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
(`plugin_notice`).

Uninstall *Daten behalten* removes code and registry entry and keeps data,
licence and access targets for a reinstall; *Alles löschen* (typed plugin name)
removes everything.

## Not yet (later stages)

* automatic updates (the catalogue says "Update verfügbar"; the
  administrator starts each update and confirms its permissions);
* dropping the built-in tables once every installation has imported them;
* releasing a licence ("Lizenz freigeben") from the plugin card.
