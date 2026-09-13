# Sicherheitsoptionen: Aliase, Backend-TLS, Header, Body-Limit, TLS-Profil, mTLS, CAA

Status: umgesetzt (Branch `feat/security`, Release 1.123.0).
Verbindliche Schnittstelle zwischen Backend und Oberfläche. Wer abweicht,
ändert zuerst dieses Dokument. Admin-2FA hat einen eigenen Vertrag
(`feature-admin-2fa.md`), die WAF ebenfalls (`feature-waf.md`).

## 0. HTTP→HTTPS-Umleitung bei „HTTPS erzwingen“ (Fehlerbehebung, zuerst)

Befund (13.09.): Der HTTP-Server `srv0` lauscht auf `:443` und `:80`, die Routen
matchen nur den Hostnamen. Caddy bedient damit jede Route auch unverschlüsselt
über Port 80 und legt **keine** automatische Umleitung an (`http://jennybackes.de`,
`http://pdf.marcbackes.net`, `http://nexterm.collabtive.cloud` liefern 200).
Das per-Route-`listen` in `caddyRoutes` (`route.https_enabled ? [':443'] : [':80']`)
landet nicht in der Server-Konfiguration.

Lösung im Generator (`caddyConfig.js`): eine Umleitungsroute **vor** allen
Host-Routen in `srv0`:

```json
{ "@id": "gc_https_redirect",
  "match": [{ "protocol": "http", "host": [<alle FQDNs mit https_enabled=1, inkl. Aliase>],
              "not": [{ "path": ["/.well-known/acme-challenge/*"] }] }],
  "handle": [{ "handler": "static_response", "status_code": 308,
               "headers": { "Location": ["https://{http.request.host}{http.request.uri}"] } }],
  "terminal": true }
```

Ausgenommen: Hosts mit `tls_status.state = 'paused'` (sie müssen über HTTP
erreichbar bleiben), Routen mit `https_enabled = 0`, der Portal-Host (eigene
Regeln), Management-Host nur, wenn `GC_BASE_URL` https ist. Der Vertragstest
prüft: Umleitung vorhanden und zuerst, pausierte Hosts fehlen, ACME-Pfad
ausgenommen, Antwort 308 mit korrekter `Location`.

## A. Host-Aliase (www)

Anlass: `www.jennybackes.de` sollte dasselbe wie `jennybackes.de` liefern. Ein
zweiter Host mit gleichem Ziel geht zwar, ist aber umständlich und dupliziert
alle Einstellungen. Ein Host bekommt deshalb **Alias-Namen**.

- `service_bundles.aliases TEXT` (JSON-Array von Labels relativ zur Zone, z. B.
  `["www"]`; für Host `app` bedeutet `www` → `www.app.<zone>`; Groß-/Klein-
  schreibung normalisiert, gleiche Regeln wie `subdomain`).
- `service_bundles.alias_mode TEXT NOT NULL DEFAULT 'redirect'`:
  `redirect` = 308 auf den Hauptnamen (`https://<fqdn><uri>`), `serve` = Alias
  liefert denselben Inhalt (Alias-Hosts kommen in den Host-Matcher der
  HTTP-Route; Route-Auth, ACL, Header usw. gelten identisch).
- Eindeutigkeit in der Zone: Alias darf weder Host noch Alias eines anderen
  Hosts sein (`ALIAS_CONFLICT`, 409). Nur Hosts mit HTTP-Eintrag.
- Zertifikate: Alias-FQDNs sind eigene Hostnamen für Caddy (ACME-Subjects) und
  für den TLS-Guard (Vorprüfung je Alias, eigene `tls_status`-Zeile). Ein
  Alias mit fehlgeschlagener Vorprüfung wird wie ein Host pausiert; der Hauptname
  bleibt unberührt.
- Caddy, Modus `redirect`: eigene Route vor der Hauptroute, Matcher
  `host: [alias-fqdns]`, Handler `static_response` mit Status 308 und
  `Location: https://<fqdn>{http.request.uri}`; Listener wie die Hauptroute.
- Caddy, Modus `serve`: Alias-FQDNs zusätzlich im `host`-Matcher der Hauptroute.
- Neuer Host `@` (Basisdomain) bekommt im Dialog standardmäßig den Alias `www`
  (Kästchen „www-Alias anlegen (Weiterleitung auf Hauptname)“, vorausgewählt).
- API: `PUT /api/v1/hosts/:id` akzeptiert `aliases: string[]`, `alias_mode`.
  `GET /zones`: `host.aliases`, `host.alias_mode`, `host.alias_fqdns`.
  `GET /tls/status` führt Alias-FQDNs mit `host_id` und `route_id` des Hosts,
  Feld `alias_of: '<fqdn>'`.
- Oberfläche: Host-Kartenkopf zeigt Aliase als muted Tags (`www ↗` bei redirect,
  `www` bei serve); Host-Menü „Alias-Namen…“ öffnet einen Dialog (Liste, Modus,
  Hinzufügen/Entfernen). Zonen-Seite: Host-Zeile ergänzt `+ www`.

## B. Backend-Zertifikat prüfen

Heute: `backend_https` → `insecure_skip_verify: true`. Neu, nur für Routen, die
Caddy selbst zum Ziel verbindet (`target_kind = 'peer'` oder Routen ohne
Gateway). Bei Gateway-Routen verbindet der Gateway-Companion; dort bleibt es
wie bisher, die Oberfläche sagt das („Verbindung baut das Gateway auf“).

- `routes.backend_tls_verify INTEGER NOT NULL DEFAULT 0`
- `routes.backend_tls_server_name TEXT` (optional; Name, gegen den geprüft wird
  und der als SNI gesendet wird; leer = Ziel-Host)
- `routes.backend_tls_ca_pem TEXT` (optional, eigene CA in PEM; mehrere
  Zertifikate erlaubt; Validierung: parst mit `crypto.X509Certificate`)
- Caddy-Transport: bei `backend_tls_verify = 1` kein `insecure_skip_verify`;
  `server_name` wenn gesetzt; `root_ca_pem_files: ['/data/caddy/backend-ca/<route_id>.pem']`
  wenn CA vorhanden (Datei wird bei jedem Sync aus der DB geschrieben,
  verwaiste Dateien entfernt).
- API: die drei Felder über `PUT /api/v1/routes/:id`; Fehler `BACKEND_CA_INVALID` (400).
- Oberfläche: Eintrags-Editor, Tab Allgemein, unter „Backend HTTPS“: Kästchen
  „Backend-Zertifikat prüfen“, Feld „Servername (optional)“, Textfeld „Eigene
  CA (PEM, optional)“. Bei Gateway-Routen ausgegraut mit Hinweis.

## C. Header-Vorlagen (Oberfläche, Custom Headers)

Vorlage „Sicherheits-Header“ wird zu **„Sicherheits-Header (modern)“**:
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
`Cross-Origin-Opener-Policy: same-origin`. `X-XSS-Protection` entfällt.
Neue Vorlage **„CSP (nur eigene Quellen)“**: `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`
mit Warnhinweis, dass sie Web-Apps mit externen Quellen bricht. HSTS bleibt beim
Schalter (Hinweis im Preset-Bereich).

## D. Request-Größenlimit

- `routes.max_body_mb INTEGER NOT NULL DEFAULT 0` (0 = unbegrenzt, sonst 1…4096).
- Caddy: Handler `{ handler: 'request_body', max_size: mb * 1048576 }` vor dem
  `reverse_proxy` (in der normalen Kette und in der Route-Auth-Kette). Nur HTTP-Routen.
- API: Feld über `PUT /api/v1/routes/:id` (`MAX_BODY_INVALID` 400).
- Oberfläche: Eintrags-Editor, Tab Sicherheit, „Maximale Anfragegröße (MB)“;
  Eintragszeile im Domain-Dialog zeigt Tag `≤ 50 MB`.

## E. TLS-Profil pro Domain

- `domains.tls_min_version TEXT NOT NULL DEFAULT '1.2'` (`'1.2'` | `'1.3'`).
- Caddy: `tls_connection_policies` auf jedem HTTP-Server: pro Zone mit `'1.3'`
  eine Policy `{ match: { sni: [alle FQDNs der Zone inkl. Aliase] }, protocol_min: 'tls1.3' }`,
  danach **immer** eine Catch-all-Policy `{}` als letzte. mTLS-Policies (F)
  stehen vor den Zonen-Policies (spezifischer zuerst).
- API: `PUT /api/v1/domains/:id/defaults` akzeptiert `tls_min_version`.
- Oberfläche: Domain-Dialog, Kopfbereich: Select „TLS mindestens: 1.2 (Standard) · 1.3“ mit Hinweis, dass alte Clients ausgeschlossen werden.

## F. Client-Zertifikate (mTLS) pro Route

Lizenz: Teil von `route_auth` (Pro), wie die anderen Auth-Methoden.

- `routes.mtls_enabled INTEGER NOT NULL DEFAULT 0`, `routes.mtls_ca_pem TEXT`
  (Pflicht bei aktiv; PEM, mehrere Zertifikate erlaubt), `routes.mtls_mode TEXT
  NOT NULL DEFAULT 'require'` (`require` = require_and_verify).
- Caddy: `tls_connection_policies`-Eintrag `{ match: { sni: [fqdn + alias-fqdns] },
  client_authentication: { mode: 'require_and_verify', trusted_ca_certs_pem_files:
  ['/data/caddy/mtls/<route_id>.pem'] } }`; Datei wird beim Sync aus der DB geschrieben.
  Nur HTTP-Routen mit `https_enabled`.
- SNI-Schutz pro Host statt server-weit (seit 1.124.1): Caddy würde bei jeder
  Policy mit `client_authentication` `strict_sni_host` für den ganzen srv0
  einschalten (Host-Wechsel zwischen normalen Hosts auf einer Verbindung → 421).
  Stattdessen `strict_sni_host: false` und direkt nach `gc_https_redirect` je
  mTLS-Host eine Route ohne `@id`, die mit 421 antwortet: über HTTPS, wenn die
  SNI keiner der Namen des Hosts ist (`not vars {http.request.tls.server_name}`),
  über HTTP für alles außer dem ACME-Pfad (ein pausierter Host wird nicht
  umgeleitet und wäre sonst ohne Client-Zertifikat erreichbar).
- API: Felder über `PUT /api/v1/routes/:id`; `MTLS_CA_INVALID`, `MTLS_REQUIRES_HTTPS` (400); Feature-Gate `requireFeatureField('mtls_enabled', 'route_auth')`.
- `GET /zones`: `entry.mtls_enabled`.
- Oberfläche: Eintrags-Editor, Tab Auth, Block „Client-Zertifikat (mTLS)“: Schalter,
  PEM-Textfeld, Hinweis „Zusätzlich zu den anderen Methoden; Browser ohne
  passendes Zertifikat sehen einen TLS-Fehler, keine Login-Seite“. Eintragszeile: Tag `mTLS`.

## G. CAA-Empfehlung

- `tlsGuard.preflight()` liefert zusätzlich `caa_status: 'none' | 'allows' | 'blocks'`
  und `caa_suggestion: '<basisdomain>. CAA 0 issue "letsencrypt.org"'` bei `none`.
- Oberfläche: Vorprüfungs-Dialog und Domains-Abschnitt der Einstellungen zeigen
  bei `none` einen Hinweis mit dem Record zum Kopieren, bei `allows` „CAA schützt
  die Domain“, bei `blocks` den bestehenden Fehler.

## Datenbank: Migration v72 `security_options`

Alle `ALTER TABLE … ADD COLUMN` wie oben (Aliase, Backend-TLS, Body-Limit,
TLS-Profil, mTLS). Nur SQL, keine Inline-REFERENCES.

## Sprachschlüssel

`alias.*`, `backend_tls.*`, `headers.preset_*` (bestehender Namensraum),
`body_limit.*`, `tls_profile.*`, `mtls.*`, `caa.*` als ein zusammenhängender Block
am Ende von `de.json`/`en.json`.

## Tests

Migration; Alias-Validierung und Caddy-Routen für beide Modi (Vertragstest);
Backend-TLS-Transport in allen Kombinationen; `request_body`-Handler in beiden
Ketten; `tls_connection_policies` mit Catch-all zuletzt und Reihenfolge
mTLS → Zone → Catch-all; PEM-Dateien werden geschrieben und verwaist entfernt;
API-Validierung; `caddy validate` einer Beispielkonfiguration mit allen Optionen;
UI statisch, Template-Render, Browser-Szenario.

## Stand der Oberfläche (Umsetzung)

- UI-Baustein `public/js/secopt-ui.js` (`GCSecOptUI`, nur Zonen-Seite, nach
  `hsts-ui.js`): Alias-Tags, Dialog „Alias-Namen…“, www-Kästchen, TLS-Profil,
  Eintrags-Tags `≤ N MB` / `mTLS`, Header-Vorlagen. CAA-Hinweis und
  Kopieren-Knopf liegen in `tls-ui.js` (Vorprüfungs-Dialog, Einstellungen).
- Aliase: Menüpunkt ohne HTTP-Eintrag deaktiviert (Hinweis statt
  `ALIAS_REQUIRES_HTTP`). Das www-Kästchen erscheint nur bei `@` mit
  HTTP-Eintrag und ist gesperrt, wenn `www` in der Zone schon Host oder Alias
  ist. Ein pausierter neuer Alias zeigt eine Toast-Warnung und den Hinweis im
  Domain-Dialog.
- Backend-TLS-Felder werden bei Gateway-/Pool-Zielen nicht gesendet (gespeicherte
  Werte bleiben unverändert); ohne `route_auth` werden die mTLS-Felder nie
  gesendet. Fehlercodes erscheinen deutsch am Formularende und im Block.
- Header-Vorlagen ersetzen gleichnamige Header statt sie zu verdoppeln.
- `headers.preset_security` steht mit neuem Text im Sprachblock am Dateiende.
