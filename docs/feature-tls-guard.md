# TLS-Guard: DNS-Vorprüfung, Zertifikatsstatus, Versuchsbegrenzung

Status: in Umsetzung (Branch `feat/tls-guard`). Verbindliche Schnittstelle zwischen
Backend (`tlsGuard`, `domains`, `caddyConfig`), Oberfläche (Zertifikatsseite,
Zonen-Seite, Domain-Dialog, Einstellungen) und der LAN-Erkennung im
Domain-Dialog. Wer abweicht, ändert zuerst dieses Dokument.

## Anlass (Diagnose vom 13.09.2026)

`jennybackes.de` wurde am 11.09. angelegt und als „verifiziert“ geführt, Let's
Encrypt lehnte aber jeden Zertifikatsantrag ab, bis das Konto für den Hostnamen
gesperrt war. Ursache: Die Domain hat neben dem A-Record (dieser Server) einen
**AAAA-Record auf einen anderen Server** (`2001:41d0:301:1::29`). Let's Encrypt
bevorzugt IPv6 für die HTTP-01-Prüfung, die Anfrage landet also auf dem
fremden Server (`curl -6 … /.well-known/acme-challenge/x` → 404 dort). Die
Prüfung in `domains.verify()` gilt als bestanden, sobald **irgendein** Record
auf diesen Server zeigt, und ignoriert die AAAA-Abweichung. Caddy wiederholt
fehlgeschlagene Anträge in kurzen Abständen; die Sperre „too many failed
authorizations“ von Let's Encrypt greift nach fünf Fehlversuchen pro Stunde.

Zweiter Befund: Auf diesem Server ist keine ACME-Kontaktadresse gesetzt
(`GC_CADDY_EMAIL` leer, `caddy.acme_email` leer). `buildTlsAutomation()` liefert
dann `null`, `apps.tls` fehlt in der Caddy-Config komplett, Caddy läuft mit
seiner eingebauten Automatik ohne E-Mail, und die Policy „interner Aussteller
für Portal-Hosts“ wird nicht angewendet.

Dritter Befund: Die Seite „Zertifikate“ zeigt „Auto-TLS“ allein aus dem
Routentyp und liest weder Caddys Ablage noch Fehler.

## Ziele

1. **Vorprüfung vor dem ersten Antrag.** Ein öffentlicher Hostname wird erst in
   die ACME-Automatik aufgenommen, wenn A, AAAA und CAA stimmen. Sonst bleibt er
   pausiert, die Seite läuft über HTTP, und die Oberfläche nennt den Grund.
2. **Sichtbarer Zertifikatsstatus** je Host: gültig bis, Aussteller, letzter
   Fehler (verständlich und im Original), Versuche, nächster Versuch.
3. **Versuchsbegrenzung.** Nach N Fehlversuchen (Einstellung, Standard 3) wird
   der Host pausiert, bevor Let's Encrypt sperrt. Erneut versuchen nur nach
   bestandener Vorprüfung.
4. **Strengere Domain-Prüfung** im Einstellungen-Dialog und beim Anlegen.
5. **LAN-Erkennung im Domain-Dialog** (Ersatz für die Wizards).

## Begriffe

- **Host(name)**: FQDN einer HTTP-Route (`routes.domain`) oder eines SNI-L4-Eintrags.
- **Server-Adressen**: `{ v4, v6 }` dieses Servers, siehe unten.
- **Vorprüfung (preflight)**: DNS- und CAA-Prüfung eines Hostnamens gegen die
  Server-Adressen, ohne ACME-Anfrage.

## Server-Adressen (`domains.getServerPublicIps()`)

```
{ v4: string|null, v6: string|null, source: { v4: 'override'|'literal'|'wg_host'|'unknown',
                                              v6: 'override'|'interface'|'wg_host'|'unknown' } }
```

- v4 wie heute (`server.public_ip`, sonst `GC_WG_HOST`/`GC_BASE_URL`).
- v6: Setting `server.public_ipv6` (leer = automatisch), sonst die erste
  globale, nicht temporäre IPv6 der Netzwerkschnittstellen
  (`os.networkInterfaces()`, Container läuft im Host-Netz), sonst AAAA von
  `GC_WG_HOST`.
- `getServerPublicIp()` bleibt für Aufrufer erhalten (liefert v4).

## Vorprüfung (`tlsGuard.preflight(host)`)

```
{
  ok: boolean,
  code: 'ok'|'no_records'|'a_mismatch'|'aaaa_mismatch'|'aaaa_without_ipv6'|'caa_blocks'
        |'resolver_unreachable'|'server_ip_unknown'|'not_public',
  detail: string|null,               // z. B. "AAAA 2001:41d0:301:1::29 ≠ 2001:4ba0:cafe:94::1"
  records: { a: string[], aaaa: string[], caa: { flags, tag, value }[] },
  server: { v4, v6 },
  checked_at: ISO-String
}
```

Regeln, in dieser Reihenfolge:
- Nicht-öffentliche TLD (`isPublicDomain` false) → `not_public`, `ok: true`
  (interner Aussteller, keine Prüfung).
- Kein Server-v4 bekannt → `server_ip_unknown`.
- Resolver-Fehler ohne jeden Record → `resolver_unreachable`.
- Keine A/AAAA → `no_records`.
- Jeder A-Record muss dem Server-v4 entsprechen, sonst `a_mismatch` (Detail
  nennt den ersten fremden Wert).
- AAAA vorhanden und Server hat kein v6 → `aaaa_without_ipv6`.
- AAAA vorhanden und einer weicht vom Server-v6 ab → `aaaa_mismatch`.
- CAA: `dns.resolveCaa` auf dem Host, dann auf jeder Elterndomain bis zur
  Basisdomain, erste vorhandene Menge zählt (RFC 8659). Enthält sie `issue`-
  oder `issuewild`-Einträge und keiner davon ist `letsencrypt.org` (bzw. der
  Host der konfigurierten ACME-CA), → `caa_blocks`. Kein CAA → ok.
- IP-Vergleich kanonisch (`canonIp`).

`domains.verify(domain)` nutzt dieselben Regeln (ohne `not_public`) und
speichert zusätzlich `check_json` (das Preflight-Objekt). `status` bleibt
`verified|pending|failed`; `last_error` enthält den `code`. Die Oberfläche
übersetzt Codes (`dns_check.<code>`), zeigt `detail` und die Records.

## Datenbank

### v70 `tls_guard`

```sql
ALTER TABLE domains ADD COLUMN check_json TEXT;
CREATE TABLE IF NOT EXISTS tls_status (
  host             TEXT PRIMARY KEY,               -- FQDN, klein geschrieben
  state            TEXT NOT NULL DEFAULT 'pending',-- pending|issued|failed|paused|internal
  attempts         INTEGER NOT NULL DEFAULT 0,     -- Fehlversuche seit letztem Erfolg/Reset
  last_error       TEXT,                           -- Caddy-Originaltext (gekürzt auf 2000)
  last_error_code  TEXT,                           -- siehe Fehlercodes
  last_attempt_at  TEXT,
  next_retry_at    TEXT,
  paused_at        TEXT,
  paused_reason    TEXT,                           -- 'attempts'|'preflight'
  preflight_json   TEXT,
  not_after        TEXT,                           -- aus dem Zertifikat
  issuer           TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Nur SQL, keine Inline-REFERENCES. Zeilen entstehen beim ersten Ereignis
(Vorprüfung, Caddy-Log, Inventur); fehlt eine Zeile, gilt `pending`.

Fehlercodes (`last_error_code`): `dns` (Prüfung/Verbindung zum Host
fehlgeschlagen: `no valid A records`, `connection refused`, `timeout`), `caa`,
`rate_limited` (`too many`, `rateLimited`), `account` (E-Mail/Konto), `preflight:<code>`
(aus der Vorprüfung), `other`.

## Caddy

### Logging

`caddyConfig.js` ergänzt in `logging.logs`:

```json
"tls": {
  "writer": { "output": "file", "filename": "/data/caddy/tls.log", "roll_size_mb": 5, "roll_keep": 2 },
  "encoder": { "format": "json" },
  "include": ["tls.obtain", "tls.renew", "tls.issuance.acme", "tls.issuance.acme.acme_client", "tls.issuance.zerossl"]
}
```

Der Pfad kommt aus `config.caddy.dataDir` (`/data/caddy`).

### Automatik

- `buildTlsAutomation()` liefert **immer** Policies; `email` wird nur gesetzt,
  wenn vorhanden. Pausierte Hosts fehlen in den ACME-`subjects`.
- Jeder HTTP-Server bekommt `automatic_https.skip` = vorhandene Einträge
  (`gc-owner.invalid`) plus alle Hosts mit `tls_status.state = 'paused'`. Damit
  beantragt Caddy für sie kein Zertifikat und leitet nicht auf HTTPS um; die
  Route bleibt über Port 80 erreichbar.
- Quelle der pausierten Hosts: `tlsGuard.pausedHosts()` (eine Abfrage).

## Backend-Service `src/services/tlsGuard.js`

- `preflight(host)` – siehe oben, ohne Nebenwirkung.
- `recordPreflight(host, result)` – schreibt `preflight_json`; bei `ok: false`
  und öffentlichem Host: `state = 'paused'`, `paused_reason = 'preflight'`,
  `last_error_code = 'preflight:<code>'`.
- `guardHost(host)` – Vorprüfung + `recordPreflight`; Rückgabe des Ergebnisses.
  Wird aufgerufen, bevor ein öffentlicher Hostname erstmals HTTPS bekommt:
  `hosts.create`, `hosts.addEntry`, `hosts.update` (Umbenennen),
  `routes.create` und `routes.update`, wenn dadurch eine HTTP-Route mit
  `https_enabled = 1` oder ein SNI-L4-Eintrag entsteht. Der Aufruf ist Teil
  des Schreibpfads vor dem Caddy-Sync, damit ein pausierter Host schon im
  ersten Sync in `skip` steht. Ein Fehlschlag der Vorprüfung **verhindert das
  Anlegen nicht**; die API-Antwort enthält `tls: { state, code, detail }`.
- `startWatcher()` / `stopWatcher()` – liest `/data/caddy/tls.log` alle 5 s ab
  dem letzten Offset (Rotation: Inode- oder Größenwechsel → von vorn), parst
  JSON-Zeilen:
  - `msg` enthält `could not get certificate` oder `will retry` (Felder
    `identifier`, `error`, `attempt`, `retrying_in`, `max_duration`) → Fehler:
    `attempts` = Caddys `attempt`, sonst +1; `last_error`, `last_error_code`,
    `last_attempt_at`, `next_retry_at` (= jetzt + `retrying_in` Sekunden).
  - `certificate obtained successfully` / `certificate renewed` → `issued`,
    `attempts = 0`, Fehlerfelder leer, danach Inventur des Hosts.
  - Nach jedem Fehler: `attempts >= tls.max_attempts` (und `max_attempts > 0`)
    → `pauseHost(host, 'attempts')`.
- `pauseHost(host, reason)` – Zustand setzen, `activity.log('tls_paused', …,
  severity 'warn')`, `eventBus.publish('tls', { host, state: 'paused' })`,
  Caddy-Sync über `withCaddySync` (Rollback: Zustand zurück).
- `retryHost(host)` – Vorprüfung; bei `ok: false` → Fehler `PREFLIGHT_FAILED`
  mit Ergebnis, Zustand bleibt `paused`; bei `ok` → `state = 'pending'`,
  `attempts = 0`, Fehlerfelder leer, Sync (Host verlässt `skip`).
- `inventory()` – liest `<dataDir>/caddy/certificates/*/<host>/<host>.crt`
  (und zur Sicherheit `<dataDir>/certificates/*`), `crypto.X509Certificate`:
  `not_after`, `issuer` (CN/O), Zustand `issued`, wenn kein Fehler jünger als
  das Zertifikat vorliegt. Läuft beim Start (nach dem Domain-Abgleich) und
  alle 6 h; Ergebnisse in `tls_status`.
- `statusFor(hosts[])` und `listStatus()` – liefert je Host das API-Objekt.
- Einstellung `tls.max_attempts` (String, Standard `'3'`, erlaubt 0–10; 0 =
  nie pausieren), in `PUBLIC_KEYS`.
- Beim Start prüft `tlsGuard` außerdem, ob eine ACME-E-Mail gesetzt ist;
  `listStatus().summary.acme_email_missing` meldet das.

Alle Zustandsänderungen veröffentlichen `eventBus.publish('tls', { host, state })`;
`public/js/events.js` leitet `tls` als `gc:tls` weiter.

## API (`src/routes/api/tls.js`, unter `/api/v1`, Scope `routes`)

| Methode | Pfad | Body | Antwort |
|---|---|---|---|
| GET | `/tls/status` | – | `{ ok, hosts: TlsHost[], summary, settings: { max_attempts } }` |
| GET | `/tls/preflight/:host` | – | `{ ok, result: Preflight }` (nur Prüfung) |
| POST | `/tls/:host/retry` | – | `{ ok, status: TlsHost }` oder 409 `{ ok:false, code:'PREFLIGHT_FAILED', result }` |
| PUT | `/settings/tls` | `{ max_attempts }` | `{ ok, max_attempts }` (Scope `settings`, in `settings/security.js`) |

```ts
type TlsHost = {
  host: string; route_id: number|null; host_id: number|null; domain_id: number|null;
  kind: 'acme'|'internal'|'none';            // none = HTTP-Route ohne HTTPS / L4 ohne TLS
  state: 'pending'|'issued'|'failed'|'paused'|'internal'|'none';
  attempts: number; max_attempts: number;
  last_error: string|null; last_error_code: string|null; last_attempt_at: string|null;
  next_retry_at: string|null; paused_at: string|null; paused_reason: 'attempts'|'preflight'|null;
  preflight: Preflight|null;
  not_after: string|null; days_left: number|null; issuer: string|null;
};
type Summary = { total: number; issued: number; expiring: number /* < 14 Tage */;
                 failed: number; paused: number; pending: number; acme_email_missing: boolean };
```

`GET /api/v1/zones` ergänzt je HTTP-Eintrag `entry.tls: { state, last_error_code,
not_after, days_left }` und je Host `host.tls_problem: boolean` (ein Eintrag
`failed`/`paused`). Host-Health: `tls_problem` → mindestens `degraded`.

## Oberfläche

### Zertifikate (`/certificates`, alle drei Themes)

- Kacheln: gültig, laufen ab (< 14 Tage), fehlgeschlagen, pausiert.
- Warnleiste, wenn `acme_email_missing` (Link zu Einstellungen → ACME-E-Mail).
- Tabelle je Host: Host (Link zur Zone), Status-Tag (`Gültig bis …`,
  `Wird beantragt`, `Fehlgeschlagen (n/N)`, `Pausiert`, `Intern`, `Kein TLS`),
  Aussteller, letzter Fehler (Kurzform aus `tls.err.<code>` plus Original in
  einer aufklappbaren Zeile), nächster Versuch, Aktionen „Prüfen“ (Vorprüfung
  im Dialog mit A/AAAA/CAA/Server) und „Erneut versuchen“ (nur `failed`/`paused`).
- Live: `gc:tls` → Neuladen (entprellt).

### Zonen-Seite und Domain-Dialog

- Host-Zeile: bei `tls_problem` Statuspunkt amber, Text `Zertifikat fehlgeschlagen`
  bzw. `Zertifikat pausiert`; HTTPS-Chip bekommt ein Warnzeichen.
- Domain-Dialog, Eintragszeile: amber Tag `Zertifikat: <Kurzgrund>`; Klick öffnet
  den Detail-Dialog (Records, Fehler, Versuche, „Erneut versuchen“).
- Domain-Dialog, Kopf: DNS-Tag zeigt bei `failed` den Grund (`dns_check.<code>`),
  Klick → Details (`check_json`) und „Erneut prüfen“.
- Beim Anlegen eines Hosts/Eintrags: enthält die Antwort `tls.state = 'paused'`,
  zeigt der Dialog sofort eine Warnung mit Grund; der Host wird trotzdem angelegt.

### Einstellungen

- Neben der ACME-E-Mail: Feld „Zertifikatsversuche, bevor ein Host pausiert
  wird“ (0–10, Standard 3) mit Hinweis auf die Let's-Encrypt-Grenze (5
  fehlgeschlagene Prüfungen pro Stunde). Autosave wie die E-Mail.
- Domains-Abschnitt: Fehlertexte aus `dns_check.<code>` und `detail`; die
  Records A/AAAA/CAA und die Server-Adressen sind einsehbar. Server-IPv6 als
  optionale Überschreibung neben der IPv4.

### LAN-Erkennung im Domain-Dialog

- Karte „Neuer Host“: Knopf „Aus LAN-Erkennung übernehmen“, sichtbar wenn das
  Zonen-Ziel ein Gateway ist (bei Pool: Auswahl des Mitglieds), das Gateway laut
  `GET /api/v1/gateways` `health.telemetry.lan_discovery === true` meldet und
  `discovery.enabled` ist; sonst Hinweis mit Link zu den Gateway-Einstellungen.
- Dialog: Liste aus `GET /api/v1/gateways/:id/discovered` (Hostname, IP, Ports,
  Alter), „Scan starten“ → `POST /api/v1/gateways/:id/discover` (`active_scan`
  laut Gateway-Einstellung), Live-Aktualisierung über `gc:gateway_discovery`,
  Hinweis bei `timed_out`.
- Übernehmen: `lan_host` = IP, Subdomain-Vorschlag aus dem Hostnamen (ohne
  `.local`, nur `[a-z0-9-]`), erster Eintrag aus dem ersten Port: HTTP-Ports
  (80, 443, 8080, 8443, 8000, 8081, 3000, 5000, 8096, 32400, 9000, 8123, 631)
  → HTTPS-Eintrag mit Ziel-Port, `backend_https` bei 443/8443; andere → TCP mit
  Ziel-Port und vorgeschlagenem Listen-Port; weitere Ports als Auswahl.

## Sprachschlüssel

`tls.*` (Zertifikatsseite, Tags, Fehlerkurztexte `tls.err.<code>`),
`dns_check.<code>` und `dns_check.*`, `settings.tls.*`, `zones.discovery.*`.
Blöcke: `tls.`/`dns_check.`/`settings.tls.` am Dateiende; `zones.discovery.`
direkt nach der Zeile mit `"host.create"`.
