# Release B: Sicherheit, Betrieb, Navigation

Status: in Umsetzung (Integrations-Branch `feat/release-b`). Verbindliche Schnittstelle
zwischen den Strängen. Baut auf Release A (docs/feature-aurora-only.md) auf: **neue
Oberflächen nur für Aurora** (`templates/aurora/…`, Stile in `public/css/aurora.css`,
eigener Abschnitt pro Funktion am Dateiende). Auftrag des Maintainers: Punkte 1, 2, 3,
4, 6, 7, 8, 9, 10, 11 und 13 der Vorschlagsliste vom 14.09.2026. Punkt 13b nur der
Server-Teil.

## Querschnitt

- **Lizenz: keine neuen Feature-Schlüssel.** Der Lizenzserver liefert neue Schlüssel
  nicht automatisch (Lehre aus 1.124.0). Wiederverwendet werden: `waf` (WAF-Assistent,
  eigene IPs, Scanner-Sperre), `scheduled_backups` (Backups außer Haus). Alles andere
  ist ohne Lizenz nutzbar.
- **Migrationen (nur SQL, feste Nummern):** v75 `aurora_only` (Release A),
  v76 `ops_center` (Strang B1), v77 `security_center` (Strang B2).
- **Token-Scopes** (src/services/tokens.js SCOPE_MAP): `/api/v1/security` → `routes`;
  neue Unterpfade unter bestehenden Präfixen erben deren Scope.
- **Echtzeit:** vorhandener SSE-Kanal, neue Typen `security` (Check neu berechnet),
  `waf` erweitert um `{kind:'ban'|'unban', ip}`, `backup` (`{target_id, status}`).
- **Fehlerformat** wie überall: `{ ok:false, error, code }`, HTTP 400/404/409/410/502.
- **i18n:** neue Schlüssel als eigener Block je Funktion; Tail-Block-Tests beachten
  (nicht blind ans Dateiende hängen, wenn ein bestehender Test den letzten Block pinnt).

## 1 + 10. Sicherheits-Check und „Was ist öffentlich?“ (Backend B2, UI B3)

`src/services/securityCheck.js`, Routen in `src/routes/api/security.js`:

`GET /api/v1/security/check` →
```json
{ "ok": true, "generated_at": "ISO", "summary": { "pass": 7, "fail": 3, "info": 2 },
  "checks": [ { "id": "hsts", "severity": "critical|warning|info", "status": "pass|fail|na",
    "count": 29, "items": [ { "kind": "route|zone|user|target", "id": 43, "label": "nas.domaincaster.com" } ],
    "fix": { "type": "api|link|copy", "method": "POST", "url": "/api/v1/routes/bulk",
             "body": { "ids": [43], "set": { "hsts_enabled": true, "hsts_max_age": 31536000 } },
             "href": "/profile#two-factor", "copy": "example.com. CAA 0 issue \"letsencrypt.org\"" } } ] }
```
Checks (id, Bedingung für `fail`, Schwere, Fix):
- `admin_2fa` – Admin ohne TOTP (critical; link `/profile#two-factor` für den eigenen
  Account, sonst `items` nennen).
- `require_2fa` – `security.require_2fa` aus (warning; api `PUT /api/v1/settings/security
  {require_2fa:true}` – nur anbieten, wenn alle Admins 2FA haben, sonst `na`).
- `hsts` – aktive HTTPS-HTTP-Einträge ohne HSTS (warning; api bulk, 1 Jahr, ohne preload).
- `caa` – Zonen ohne CAA-Record (warning; copy des Vorschlags aus tlsGuard.preflight
  `caa_suggestion`; DNS-Abfragen gecacht ≥ 1 h, Check darf nie > 5 s blockieren).
- `waf_coverage` – öffentliche aktive HTTP-Einträge ohne WAF (warning; api bulk
  `waf_enabled:true, waf_mode:'detect', waf_paranoia:1`; `na` ohne Lizenz `waf`).
- `waf_ready` – Einträge im Modus detect mit readiness `ready` (info; link `/waf#assistant`).
- `public_unprotected` – öffentliche Einträge ohne Auth, mTLS und IP-Filter (info).
- `backup_offsite` – kein aktives Außer-Haus-Ziel oder letzter Upload fehlgeschlagen /
  älter als 48 h (warning; link `/settings#backup`; `na` ohne Lizenz `scheduled_backups`).
- `tls_min` – Zonen mit TLS-Mindestversion 1.2 (info, kein Fehler).
- `auto_update` – Modus manuell oder Status `rolled_back`/`failed` (info/warning).
„Öffentlich“ = `enabled=1 AND external_enabled=1`.

`GET /api/v1/security/exposure` →
`{ ok, entries: [ { route_id, host, zone, type: "http|l4", target: "192.168.2.151:8096",
  health: "ok|down|unknown", protections: { auth: "route_auth|basic|null", mtls: bool,
  ip_filter: bool, waf: "block|detect|null", hsts: bool, rate_limit: bool,
  tls_min: "1.2|1.3" } } ] }` – nur öffentliche Einträge, sortiert nach Host.

## 2. Sammelaktionen und WAF-Standard pro Domain (Backend B2, UI B4)

`POST /api/v1/routes/bulk { ids: [int ≤ 200], set: { enabled?, external_enabled?,
waf_enabled?, waf_mode?, waf_paranoia?, hsts_enabled?, hsts_max_age?, hsts_subdomains?,
monitoring_enabled? } }`
- Validierung pro Route mit denselben Validatoren und Lizenz-Gates wie
  `PUT /api/v1/routes/:id`. **Alles oder nichts**: ein Fehler → 400
  `{ ok:false, code:'BULK_INVALID', failed:[{id, code, error}] }`, nichts geändert.
- Eine DB-Transaktion, **ein** Caddy-Sync (`withCaddySync`, Rollback aller Zeilen).
- Antwort `{ ok:true, updated:[ids], changed: n }`; Aktivitätslog `routes_bulk_update`.
- `domains.waf_default TEXT` (JSON `{enabled, mode, paranoia}` oder NULL), analog
  `hsts_default`: `PUT /api/v1/domains/:id/defaults` akzeptiert zusätzlich
  `waf_default` und `apply_waf_to_existing` (nur HTTP-Einträge; Antwort `applied`).
  Neue HTTP-Einträge einer Zone übernehmen den Standard. `GET /api/v1/zones` liefert
  `zone.waf_default`.

## 3. WAF-Assistent, eigene IPs, Scanner-Sperre (Backend B2, UI B3; Lizenz `waf`)

Einstellungen `GET/PUT /api/v1/settings/waf`:
`{ trusted_ips: ["93.215.209.180", "10.0.0.0/8"], trusted_bypass: false,
  autoban: { enabled: false, threshold: 5, window_min: 10, duration_h: 24 } }`
(Schlüssel `waf.trusted_ips` JSON ≤ 50 Einträge IPv4/IPv6/CIDR, `waf.trusted_bypass`,
`waf.autoban.*`; Standard Scanner-Sperre **aus**).
- Eigene IPs zählen nie in Kacheln/Statistik/Assistent und werden nie gesperrt; Events
  bekommen `trusted: true` in `GET /api/v1/waf/events`; `GET /api/v1/waf/status` zählt
  `events_24h`/`blocked_24h` ohne eigene IPs und liefert zusätzlich `trusted_24h`.
- `trusted_bypass: true` → Direktive vor dem CRS-Include:
  `SecRule REMOTE_ADDR "@ipMatch <liste>" "id:9003,phase:1,pass,nolog,ctl:ruleEngine=Off"`.
- Scanner-Sperre: zählt Treffer der Regelgruppen 913 (Scanner), 930 (LFI/geschützte
  Dateien), 931 (RFI) und Regel 920440 je Client-IP im Fenster; bei `threshold`
  → Eintrag in Tabelle `waf_bans(ip TEXT PRIMARY KEY, reason TEXT, hits INTEGER,
  first_seen TEXT, banned_at TEXT, expires_at TEXT, manual INTEGER NOT NULL DEFAULT 0)`.
  Caddy: Route `@id gc_waf_bans` in srv0 direkt nach `gc_https_redirect` und den
  mTLS-Wächtern, Matcher `client_ip: { ranges: [...] }`, ausgenommen Verwaltungs-Host
  und ACME-Pfad, Antwort 403 mit der WAF-Blockseite. Sync gebündelt (höchstens einmal
  pro 60 s wegen Sperren), Ablauf-Aufräumen alle 5 min. Nur HTTP, L4 unberührt.
- `GET /api/v1/waf/bans` → `{ ok, bans:[{ip, reason, hits, banned_at, expires_at, manual}] }`;
  `POST /api/v1/waf/bans {ip, duration_h}` (manuell); `DELETE /api/v1/waf/bans/:ip`.
- `routes.waf_mode_changed_at TEXT` (gesetzt bei jeder Änderung von waf_enabled/waf_mode).
- `GET /api/v1/waf/assistant` →
  `{ ok, routes: [ { route_id, host, mode, paranoia, detect_since, observed_hours,
  events_total, events_external, top_rules: [ { rule_id, message, hits, ips, paths:
  ["/…"], verdict: "attack|false_positive|unclear", reason } ], readiness:
  "ready|review|too_early|no_traffic", suggestion: { exclude_rules: [], exclude_paths: [] } } ] }`.
  Heuristik (dokumentiert im Code): Scanner-Regeln auf typische Geheimnis-Pfade oder
  Einzel-IP-Serien → `attack`; dieselbe Regel auf demselben Pfad von ≥ 3 verschiedenen,
  nicht gesperrten IPs über ≥ 2 Tage → `false_positive`; sonst `unclear`.
  `too_early` < 24 h beobachtet; `review` bei mindestens einem `false_positive`;
  `ready` sonst (auch bei null externen Treffern mit Traffic → `ready`;
  ohne jede Anfrage seit detect_since → `no_traffic`, Traffic aus dem Access-Log zählen
  oder – falls zu teuer – `unknown` weglassen und nur Treffer werten).

## 4. Automatische Datenbanksicherung vor Migrationen (B1)

- Im Migrations-Runner: stehen Migrationen an und ist die DB eine Datei, vorher
  `VACUUM INTO '<dataDir>/backups/pre-migration/gatecontrol-v<von>-v<bis>-<ts>.db'`
  (synchron), Datei 0600, Ordner 0700, die letzten 3 behalten.
- Schlägt die Sicherung fehl → Start abbrechen mit klarer Meldung (der Health-Check
  scheitert, update.sh rollt zurück). Notausgang `GC_SKIP_PRE_MIGRATION_BACKUP=1`.
- Überall dort, wo Migrationen zuerst laufen (auch entrypoint → export-caddy-config).
- `GET /api/v1/settings/backup/pre-migration` → `{ ok, files:[{name, size, created_at,
  from_version, to_version}] }`; Download `GET …/pre-migration/:name` (Admin, Name
  streng validiert).

## 6. Wartungsfenster, „Was ist neu“, Benachrichtigung (B1; UI B5)

- `GET/PUT /api/v1/system/auto-update` zusätzlich `window: { enabled, start: "03:00",
  end: "05:00", tz: "Europe/Berlin" }`; `.auto-update-config.json` bekommt
  `"window": {...}` (nur wenn aktiviert). update.sh (Wurzel + Template byte-identisch,
  tests/update_sh.test.sh erweitern): im Modus auto außerhalb des Fensters → Log
  „outside maintenance window“, Status `waiting_window`, Exit 0; ein manuell
  angefordertes Update (Flag) ignoriert das Fenster. Fenster über Mitternacht erlaubt.
  Der Host muss update.sh danach neu installieren (Hinweis im Changelog).
- CHANGELOG ins Image: `.dockerignore` Ausnahme `!CHANGELOG.md`.
  `GET /api/v1/system/whats-new` → `{ ok, current: "1.126.0", unseen: bool,
  sections: [ { version, date, groups: [ { title: "Features", items: [ [ {t:"text",v:"…"},
  {t:"code",v:"…"}, {t:"strong",v:"…"} ] ] } ] } ] }` – alle Abschnitte neuer als die vom
  Benutzer zuletzt gesehene Version (höchstens 5); `POST /api/v1/system/whats-new/seen`
  speichert `users.last_seen_version` (Spalte in v76). Kein HTML vom Server.
- E-Mail (vorhandener SMTP-Versand, Empfänger `monitoring.alert_email`, Schalter
  `notify.update_email` Standard `true`): beim Start mit neuer Version
  („GateControl auf vX aktualisiert“ + Stichpunkte aus dem Changelog) und wenn
  `.auto-update-state.json` einen neuen `rolled_back`/`failed`-Eintrag zeigt (Prüfung
  beim Start und alle 5 min, pro checked_at nur einmal).

## 7. Backups außer Haus (B1; UI B5; Lizenz `scheduled_backups`)

- Tabelle (v76) `backup_targets(id INTEGER PK, name TEXT NOT NULL, type TEXT NOT NULL
  CHECK(type IN ('sftp','smb','s3','webdav')), config_enc TEXT NOT NULL, enabled INTEGER
  NOT NULL DEFAULT 1, keep INTEGER NOT NULL DEFAULT 14, last_run_at TEXT, last_status TEXT,
  last_error TEXT, created_at TEXT NOT NULL)`; Geheimnisse verschlüsselt wie andere
  (GC_ENCRYPTION_KEY).
- Verschlüsselung der hochgeladenen Datei: Passphrase (Einstellung
  `backup.offsite.passphrase_enc`, ≥ 12 Zeichen, write-only), scrypt + AES-256-GCM,
  Dateiformat mit Magic `GCBK1`. Option `include_key` (Standard **an**): der
  GC_ENCRYPTION_KEY liegt verschlüsselt im Archiv, damit Passphrase + Archiv für eine
  Wiederherstellung auf neuer Hardware reichen. Entschlüsseln: `node src/bin/offsite-decrypt.js`
  + Restore-Upload akzeptiert `.gcbk`.
- Transporte **ohne neue npm-Abhängigkeiten** (npm install ist wegen des privaten Pakets
  lokal nicht möglich): S3 (SigV4 mit node:crypto + fetch, path-style und
  virtual-host), WebDAV (fetch: MKCOL/PUT/PROPFIND/DELETE), SFTP (`sftp`/`ssh` aus
  Alpine `openssh-client-default`, nur Schlüssel-Auth mit einem von GateControl erzeugten
  ed25519-Schlüssel), SMB (`smbclient` aus `samba-client`, Zugangsdaten über temporäre
  Auth-Datei 0600). Paketnamen im Build prüfen; Trivy muss sauber bleiben.
- LAN-Ziele (NAS hinter dem Gateway): Hinweis in der Oberfläche, eine interne L4-Route
  auf SSH/SMB anzulegen und `127.0.0.1:<Port>` einzutragen; die UI bietet interne
  L4-Routen als Auswahl an (`GET /api/v1/settings/backup/targets/l4-candidates`).
- API unter `/api/v1/settings/backup`: `GET/PUT /offsite {passphrase?, include_key}`
  (liefert `passphrase_set: bool`); `GET/POST /targets`, `PUT/DELETE /targets/:id`,
  `POST /targets/:id/test` → `{ok, detail}`, `POST /targets/:id/run` (letztes Backup jetzt
  hochladen), `GET /targets/:id/files` → Liste; `GET /ssh-key` → `{public_key}`,
  `POST /ssh-key/rotate`. Konfiguration je Typ: sftp `{host, port, username, path}`;
  smb `{host, port?, share, path, username, password, domain?}`; s3 `{endpoint, region,
  bucket, prefix, access_key_id, secret_access_key, path_style}`; webdav `{url, username,
  password}`. Antworten enthalten nie Geheimnisse (`has_password: true`).
- Upload nach jedem geplanten Backup an alle aktiven Ziele, Aufbewahrung `keep`
  (nur eigene Dateien `gatecontrol-*.gcbk` löschen), Ergebnis in `last_*`, SSE `backup`.

## 8. Navigation und Schnellsuche (UI B4)

- Sidebar (Aurora `sidebar.njk`, mobil `bottomnav.njk`) in Gruppen: Übersicht
  (Dashboard) · Netzwerk (Peers/Clients, Domains/Routen, Gateways, Gateway-Pools,
  Remote Desktops, Interner DNS, Pi-hole) · Sicherheit (Sicherheits-Check `/security`
  [neu], SSL/Zertifikate, Web Application Firewall, Benutzer) · Integrationen
  (Klimaanlage, Fahrzeuge, Smart Home – wie bisher nur mit Lizenz/Konfiguration) ·
  System (Logs & Monitoring, Einstellungen). URLs bleiben.
- Schnellsuche: Strg+K / ⌘K (und „/“ außerhalb von Eingabefeldern) öffnet eine Palette;
  durchsucht Seiten, Einstellungsabschnitte, Hosts/Einträge (`/api/v1/zones`), Peers,
  Gateways; Pfeiltasten + Enter, Esc; zuletzt benutzt in localStorage (try/catch).
  Rein clientseitig, lädt Daten beim ersten Öffnen.

## 9. Ruhigere Eintragszeilen und Filter (UI B4)

- Domain-Dialog und Zonen-Seite: nur **aktive** Schutzfunktionen als Chips
  (EXTERN/INTERN bleibt als Zugriffsanzeige); keine Negativ-Chips wie „HSTS aus“.
  Neu: kompaktes Schild `.sh-shield` mit Zahl aktiver Schutzfunktionen, Tooltip listet
  aktive und fehlende (für öffentliche HTTPS-Einträge: Auth, mTLS, IP-Filter, WAF,
  HSTS, Rate-Limit).
- Filter in der Toolbar der Zonen-Seite: „Öffentlich ohne WAF“, „Öffentlich ohne
  Schutz“, „HTTPS ohne HSTS“, „Backend gestört“, „Deaktiviert“; kombinierbar mit der
  Suche, Zustand im URL-Hash.
- Sammelauswahl: Checkbox je Eintrag, Leiste „N ausgewählt“ mit Aktionen (WAF an
  [Modus/Stufe], HSTS an, Monitoring an, aktivieren/deaktivieren) → `POST /api/v1/routes/bulk`.
- Domain-Dialog: WAF-Standard (wie HSTS-Standard) mit „auf bestehende anwenden“.

## 11. Lizenz-Rückmeldung (Backend B2, UI B3)

- `GET /api/v1/license` liefert zusätzlich `locked: { <feature>: "plan|not_in_token|unlicensed" }`
  für alle gesperrten Boolean-Features: `not_in_token` = Schlüssel fehlt im Token (neues
  Feature, Lizenzserver liefert es noch nicht), `plan` = im Token false, `unlicensed` =
  Community ohne Lizenz.
- UI-Baustein `GCLicenseHint.render(featureKey)` (public/js/license-hint.js): Text je
  Grund + Knopf „Lizenz aktualisieren“ (`POST /api/v1/license/refresh`, danach Seite neu
  laden). Eingesetzt überall, wo heute ein Block wegen Lizenz ausgegraut ist (WAF-Block
  im Editor, /waf, mTLS, Backups, …).

## 13. Betrieb (B1) und Gateway-TLS, Server-Teil (B2, UI B5)

- 13a: `docker-compose.yml`, `deploy/docker-compose.yml` und installer-Vorlagen:
  `logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }` für
  gatecontrol (und guacd). Hinweis im Changelog für bestehende Hosts.
- 13b: `routes.backend_tls_fingerprint TEXT` (v77; SHA-256, gespeichert als 64 Hex
  klein, Eingabe mit/ohne Doppelpunkte), nur für Gateway-Einträge mit `backend_https`;
  Fehler `BACKEND_TLS_FINGERPRINT_INVALID`. Im Gateway-Config-Payload als
  `backend_tls_fingerprint` **nur wenn gesetzt** (Config-Hash bleibt für alle anderen
  Routen byte-gleich; vorher prüfen, dass das Schema aus `@callmetechie/gatecontrol-config-hash`
  unbekannte Felder nicht verwirft oder ablehnt – sonst Schema-Version/Strategie im
  Bericht vorschlagen, nicht raten). UI: Feld im Backend-TLS-Block des Editors mit
  Hinweis „Das Gateway prüft den Fingerabdruck ab einem kommenden Gateway-Update“.

## Tests

Pro Punkt Unit-/API-Tests; Caddy-Validierung für `gc_waf_bans` und die
Trusted-Bypass-Direktive mit dem Caddy aus dem Image; update.sh-Tests für das Fenster;
Transport-Tests gegen lokale Fakes (S3/WebDAV per node-HTTP-Server, SFTP gegen einen
openssh-Server-Container, SMB gegen einen Samba-Container – nur wenn schnell und ohne
große Images, sonst mit Shims); Browser-Szenarien in Aurora für jede neue Oberfläche.
