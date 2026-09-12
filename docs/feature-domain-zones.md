# Domain-Zonen: Schnittstellenvertrag

Status: in Umsetzung (Branch `feat/domain-zones`). Dieses Dokument ist die
verbindliche Schnittstelle zwischen Backend (`hosts`/`domainZones`), der neuen
Seite (`zones.njk`, `zones-page.js`, `domain-modal.js`) und dem herausgelösten
Eintrags-Editor (`entry-editor.js`). Wer davon abweicht, ändert zuerst dieses
Dokument.

Hintergrund und Entscheidungen: Umsetzungsplan „Domains & Routen“, Fassung 2.

## Begriffe

| Begriff | Speicherort | Bedeutung |
|---|---|---|
| Zone / Domain | `domains` | Basisdomain (z. B. `marcbackes.net`) mit Gateway und Standard-Zugriff |
| Host | `service_bundles` | Subdomain einer Zone (`@` = Basisdomain selbst). Alle Einträge eines Hosts gehen an **dieselbe LAN-Adresse** |
| Eintrag | `routes` | eine HTTP-Route oder L4-Weiterleitung (TCP/UDP) eines Hosts |

Invarianten nach der Umstellung:

- Jede Route (außer RDP-eigene L4-Routen, `rdp_routes.gateway_l4_route_id`) hat
  eine `bundle_id`. Ein Host mit einem einzigen Eintrag ist normal.
- Ein Host gehört zu höchstens einer Zone (`domain_id`, `NULL` = „Ohne Domain“).
- (`domain_id`, `subdomain`) ist eindeutig. Durchgesetzt in `hosts.js`, **nicht**
  per Index (ein Index würde bei Altlasten den Start blockieren).
- Das Gateway wird pro Zone gewählt. Alle Einträge aller Hosts der Zone tragen
  dieselben Ziel-Spalten, außer bei Hosts mit `gateway_override = 1`
  (Altbestand, nur über „Auf Domain-Gateway umstellen“ auflösbar, nie neu
  anlegbar).
- `routes` und die Caddy-Erzeugung bleiben unverändert.

## Datenbank (Migrationen, nur SQL)

Migrationen sind reines SQL (`src/db/migrations.js` führt nur `migration.sql`
aus). Keine Inline-`REFERENCES` (Konvention `migrationList.js:1052`).

### v68 `zones_hosts`

```sql
ALTER TABLE service_bundles ADD COLUMN domain_id INTEGER;
ALTER TABLE service_bundles ADD COLUMN subdomain TEXT;          -- '@' für die Basisdomain
ALTER TABLE service_bundles ADD COLUMN template TEXT;           -- 'printer'|'nas'|'proxmox'|'ssh'|NULL
ALTER TABLE service_bundles ADD COLUMN gateway_override INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_bundles_domain ON service_bundles(domain_id, subdomain);
```

Backfill im selben SQL:
1. Für jede Route ohne `bundle_id`, die nicht RDP-eigen ist, einen Host anlegen
   (Name = Beschreibung, sonst Domain, sonst `Port <listen_port>`; `domain` =
   Routen-Domain) und die Route verknüpfen.
2. `domain_id` per längster Suffix-Übereinstimmung: `bundle.domain = d.domain OR
   bundle.domain LIKE '%.' || d.domain`, `ORDER BY length(d.domain) DESC LIMIT 1`.
3. `subdomain = '@'` bei Gleichheit, sonst der Präfix vor `'.' || d.domain`.

### v69 `zones_gateway`

```sql
ALTER TABLE domains ADD COLUMN gateway_kind TEXT;               -- 'gateway'|'pool'|'peer'|NULL
ALTER TABLE domains ADD COLUMN gateway_peer_id INTEGER;         -- kind gateway: Gateway-Peer; kind peer: Ziel-Peer
ALTER TABLE domains ADD COLUMN gateway_pool_id INTEGER;         -- kind pool
ALTER TABLE domains ADD COLUMN default_external_enabled INTEGER NOT NULL DEFAULT 0;
```

Backfill: pro Zone das häufigste Ziel aller Einträge ihrer Hosts.
Abbildung `routes` → Zone:
- `target_kind='gateway'` und `target_pool_id` gesetzt → `pool`, `gateway_pool_id`
- `target_kind='gateway'` sonst → `gateway`, `gateway_peer_id = target_peer_id`
- `target_kind='peer'` (oder NULL) → `peer`, `gateway_peer_id = peer_id`

`default_external_enabled` = Mehrheit von `routes.external_enabled` der Zone.
Danach `gateway_override = 1` für jeden Host, dessen Einträge ein anderes Ziel
haben als seine Zone.

### Start-Abgleich (`domainZones.reconcile()`, aufgerufen aus `domainBoot.js`)

Idempotent, darf nie den Start abbrechen (Fehler nur loggen):
- Routen ohne Host (neu entstanden, RDP-Ausschluss beachten) → Host anlegen.
- Hosts mit `domain_id IS NULL` und Domain mit öffentlicher TLD → Zone per
  `resolveZone()`; fehlt sie, `domains.seedPending(base)` und verknüpfen.
- Duplikate (`domain_id`, `subdomain`) → `logger.warn` mit Host-IDs.

## Backend-Services

### `src/services/domainZones.js`

- `resolveZone(fqdn) → { domain_id, domain, subdomain } | null` – längster
  Suffix gegen `domains` (alle Stati).
- `listZones() → { zones: Zone[], unassigned: Host[] }` – ein Query-Satz ohne N+1.
- `applyGateway(domainId, { kind, peer_id, pool_id })` – schreibt Zone +
  Ziel-Spalten aller Einträge aller Hosts ohne Override in einer Transaktion;
  Snapshot mit `routesRollback`; genau **ein** `withCaddySync`.
- `updateDefaults(domainId, { default_external_enabled })` – betrifft nur neue
  Einträge.
- `reconcile()` – siehe oben.

### `src/services/hosts.js`

- `create(domainId, input)`, `update(hostId, patch)`, `remove(hostId)`,
  `toggle(hostId, enabled)`, `addEntry(hostId, entry)`, `clearOverride(hostId)`,
  `setupScanToFolder(hostId, input)`.
- Intern über `serviceBundle.createBundle` bzw. `routes.create(..., {skipSync})`
  mit eigenem Snapshot/`withCaddySync`-Paar je Schreibpfad.
- **Prüft keine Lizenz** – das tun ausschließlich die API-Endpunkte.

### `src/services/hostTemplates.js`

`list() → Template[]`, `expand(templateId, params) → EntryInput[]`.
Vorlagen: `printer` (http 443 backend_https + tcp 631 + tcp 9100, Listen-Port-
Vorschlag wie `printerPreset.allocatePrintListenPort`), `nas` (http 5001
backend_https + tcp 22 mit freiem Listen-Port), `proxmox` (http 8006
backend_https), `ssh` (tcp 22 mit freiem Listen-Port).

### Echtzeit

Nach jeder Mutation in `routes`-Service, `hosts`, `domainZones`:
`eventBus.publish('routes', { domain_id, host_id })`. Client
`public/js/events.js` leitet `routes` als DOM-Event `gc:routes` weiter.

## API (`src/routes/api/domainZones.js`, unter `/api/v1`)

Alle Antworten `{ ok: true, ... }` bzw. Fehler `{ ok: false, error, code?, conflict? }`
im Stil der bestehenden Endpunkte. Portkonflikte: HTTP 409 mit
`code: 'BUNDLE_PORT_CONFLICT'` und `conflict: { port, conflictRouteId, suggestedPort }`.

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| GET | `/zones` | – | `{ zones, unassigned, gateways, pools }` |
| PUT | `/zones/ui-mode` | `{ mode: 'zones'\|'legacy' }` | `{ mode }` (Setting `ui_zones_page`) |
| PUT | `/domains/:id/gateway` | `{ kind, peer_id?, pool_id? }` | `{ zone }` |
| PUT | `/domains/:id/defaults` | `{ default_external_enabled }` | `{ zone }` |
| POST | `/domains/:id/hosts` | `HostInput` | `{ host }` (201) |
| PUT | `/hosts/:id` | `{ description?, subdomain?, lan_host? }` | `{ host }` |
| DELETE | `/hosts/:id` | – | `{}` (löscht alle Einträge) |
| PUT | `/hosts/:id/toggle` | `{ enabled }` | `{ host }` |
| PUT | `/hosts/:id/gateway-override` | `{ override: false }` | `{ host }` |
| POST | `/hosts/:id/entries` | `EntryInput` | `{ entry }` (201) |
| POST | `/hosts/:id/scan-to-folder` | `ScanInput` | `{ egress_id, nas_route_id? }` |
| GET | `/host-templates` | – | `{ templates }` |

Einträge bearbeiten, schalten, löschen: weiter über `PUT/DELETE
/api/routes/:id`, `PUT /api/routes/:id/toggle`. Der letzte gelöschte Eintrag
löscht den Host (`cleanupEmptyBundles`).

Lizenz: `POST /domains/:id/hosts` → `checkCreateLicense` mit allen Einträgen
(wie `serviceBundles.js`); `POST /hosts/:id/entries` → `requireLimit` nach
Typ plus `gateway_tcp_routing`-Prüfung wie `routes.js`.

### Typen

```ts
type Zone = {
  domain_id: number; domain: string; verification: 'verified'|'pending'|'failed'|string;
  gateway: { kind: 'gateway'|'pool'|'peer'|null; peer_id: number|null; pool_id: number|null;
             name: string|null; ip: string|null; online: boolean|null };
  default_external_enabled: boolean;
  counts: { hosts: number; entries: number; http: number; l4: number; disabled: number };
  health: 'ok'|'degraded'|'down'|'disabled';   // schlechtester Host
  hosts: Host[];                               // '@' zuerst, dann alphabetisch
};
type Host = {
  id: number; domain_id: number|null; subdomain: string|null; fqdn: string|null;
  name: string; description: string|null; template: string|null;
  lan_host: string|null;                       // gemeinsame LAN-Adresse (null bei kind peer)
  gateway_override: boolean;
  entry_count: number; enabled_count: number;
  health: 'ok'|'degraded'|'down'|'disabled';
  entries: Entry[];                            // http zuerst, dann nach listen_port
};
// Entry = exakt eine Zeile wie aus GET /api/routes (stripRoute + baseUnverified),
// zusätzlich: rdp_owned: boolean, rdp_route_id: number|null
type HostInput = {
  subdomain: string;                           // '@' oder DNS-Label(s), ohne Basisdomain
  description?: string;
  lan_host?: string;                           // Pflicht bei kind gateway/pool
  template?: 'printer'|'nas'|'proxmox'|'ssh';
  entries?: EntryInput[];                      // Pflicht, wenn kein template
};
type EntryInput = {
  type: 'http'|'tcp'|'udp';
  target_port: number;
  listen_port?: number|string;                 // tcp/udp: Pflicht; Bereich '5000-5010' erlaubt
  backend_https?: boolean;                     // http
  tls_mode?: 'none'|'passthrough'|'terminate'; // tcp, Standard 'none'
  description?: string;
};
type ScanInput = { vip_ip: string; target: { mode: 'existing'; route_id: number }
                                        | { mode: 'new'; nas_ip: string; nas_gateway_peer_id: number } };
```

Neue Einträge erben `external_enabled` von `zone.default_external_enabled`
und das Ziel von der Zone; `https_enabled` = 1 bei `type: 'http'`.

## Seite und Umschaltung

- Setting `ui_zones_page` (String `'true'`/`'false'`, Standard `'true'`).
- `/routes` rendert `zones.njk`, wenn aktiv, sonst `routes.njk` (alt).
  `/routes/legacy` rendert immer `routes.njk`. Beide mit `activeNav: 'routes'`
  und denselben Zusatz-Locals (`gatewayPools`, `l4BlockedPorts`).
- Beide Seiten zeigen einen Link zur jeweils anderen Ansicht, der
  `PUT /api/v1/zones/ui-mode` aufruft.

## Frontend-Schnittstellen

### `window.GCZonesView` (`public/js/zones-view.js`)

Reine Funktionen, UMD wie `routes-view.js` (in Node testbar):
- `sortHosts(hosts)` – `@` zuerst, dann alphabetisch nach `subdomain`.
- `filterZones(zones, { q, type: 'http'|'l4'|null, access: 'external'|'internal'|null,
  state: 'disabled'|'problem'|null, gatewayKey: string|null }) → Zone[]`
  (Zonen ohne Treffer fallen weg; Suche über fqdn, description, lan_host, Ports).
- `entryChip(entry) → { proto: 'HTTPS'|'HTTP'|'TCP'|'UDP', out: string, in: string, note?: string }`.
- `summarize(zones) → { domains, hosts, l4, disabled }`.

### `window.GCEntryEditor` (`public/js/entry-editor.js`)

- `open(routeOrId, { lockTarget?: boolean, onSaved?: (route) => void, onDeleted?: (id) => void })`
  – lädt `GET /api/routes/:id`, wenn eine ID übergeben wird.
  `lockTarget: true` blendet Domain, Ziel-Art, Gateway, Zielhost und Routentyp
  aus und zeigt stattdessen eine schreibgeschützte Zeile `fqdn → lan_host:port`.
  Beim Speichern werden die gesperrten Felder unverändert mitgeschickt.
- `close()`.
- Voraussetzungen auf der Seite: Partials `modals/route-edit.njk` und
  `modals/confirm.njk`, Skripte in dieser Reihenfolge:
  `vendor/qrcode.min.js`, `routes-view.js`, `routeDomain.js`, `entry-editor.js`.
- Die alte Seite (`routes.js`) nutzt denselben Editor; ihr eigener
  `showEditModal` entfällt.

### Neue Seite

`templates/{default,pro,aurora}/pages/zones.njk`, Skripte:
`zones-view.js`, `domain-modal.js`, `zones-page.js` (nach denen des Editors).
DOM wird mit dem `el()`-Builder-Muster aufgebaut (innerHTML ist per Hook
gesperrt). Globale Helfer aus `app.js`: `api.*`, `openModal`, `closeModal`,
`showToast`, `btnLoading`, `btnReset`, `escapeHtml`.

Sprachschlüssel: `zones.*`, `host.*`, `entry.*`, `template.*` in
`src/i18n/de.json` und `en.json`.
