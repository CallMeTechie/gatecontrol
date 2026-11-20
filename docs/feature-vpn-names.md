# Namen im VPN

Jedes VPN-Gerät kann einen Namen haben. Unter diesem Namen erreichen sich die
Geräte gegenseitig, statt nur unter einer Adresse wie `10.8.0.14`. Die Funktion
hieß früher „Interner DNS“ und hatte eine eigene Seite. Die Seite und ihr
Menüpunkt gibt es nicht mehr: Der Name steht beim Gerät, die Einstellung und
die Diagnose stehen unter „Einstellungen“ → „VPN & Netzwerk“. Die alte Adresse
`/dns` leitet dorthin weiter.

Alle Domains und Gerätenamen in diesem Dokument sind Beispiele.

## Zwei Zonen

| Zone | Beispiel | Woher |
|---|---|---|
| primär | `vpn.example.com` | Einstellung „Namen im VPN“: eine Domain aus „Domains / Routen“ und ein Unterbereich (Vorschlag `vpn`) |
| alt | `gc.internal` | `GC_DNS_DOMAIN` (Standard `gc.internal`) |

Ohne eigene Wahl gibt es nur die alte Zone, alles ist wie zuvor. Mit eigener
Wahl ist ein Gerät unter beiden Schreibweisen erreichbar:
`laptop-buero.vpn.example.com` und `laptop-buero.gc.internal`. Die alte Zone
bleibt dauerhaft: Das Portal (`home.gc.internal`), interne Routen und der
Gateway-Assistent hängen daran, und gespeicherte Adressen brechen nie. Wer
`GC_DNS_DOMAIN` gesetzt hat, behält diesen Wert als alte Zone und als Standard.

Warum ein Unterbereich und nicht die Domain selbst:

- Gerätenamen kommen teils von den Geräten. Ein Gerät, das sich „mail“ nennt,
  würde sonst im VPN `mail.example.com` überdecken.
- Der Server beantwortet die Zone allein. Ein Name, den es dort nicht gibt,
  bekommt sofort „gibt es nicht“; nichts wird ins Internet weitergefragt. Unter
  der Domain selbst wären damit alle Adressen unerreichbar, die GateControl
  nicht kennt.

Die Namen gelten nur im VPN. Beim Anbieter der Domain wird nichts eingetragen,
von außen sind sie nicht auflösbar, und ohne „Zertifikat für die Namen“
(unten) wird kein Zertifikat dafür angefordert. Nur A-Einträge (kein AAAA).

## Einstellung (Einstellungen → VPN & Netzwerk → „Namen im VPN“)

Gespeichert in `settings`: `dns.names.base_domain` (leer = alte Zone) und
`dns.names.sub`. Vier Zustände der Karte:

| Zustand | Was man sieht |
|---|---|
| eigene Domain | Domain, Unterbereich, Vorschau mit Kopieren-Knopf, Hinweis auf die alte Schreibweise, Marke „aktiv“ |
| Standard | „gc.internal (Standard)“, Unterbereich „nicht nötig“ |
| Kollision | Meldung am Unterbereich mit einem freien Vorschlag; Speichern erst mit einem freien Unterbereich |
| Domain entfernt | Hinweis, dass die Domain nicht mehr eingetragen ist und die Namen weiter funktionieren; „Zurück zu gc.internal“ |

Gespeichert wird über die Speicherleiste der Einstellungen. Die Umstellung wirkt
sofort und ohne Neustart des Containers: Nur der DNS-Dienst startet neu
(wie beim Ein- und Ausschalten des DNS-Schutzes).

Wird die gewählte Domain unter „Einstellungen“ → „Domains & Zertifikate“
entfernt, weist der Dialog „Domain entfernen“ darauf hin. Die Namen laufen
weiter, weil sie nur im VPN gelten.

### Prüfungen des Unterbereichs (`vpnNames.check`)

Der Unterbereich ist ein einzelnes Label (Kleinbuchstaben, Ziffern,
Bindestriche). Er wird abgelehnt, wenn unter `<sub>.<domain>` schon etwas liegt:

| Code | Was kollidiert |
|---|---|
| `collision_host` | ein Host der Zone, dessen Subdomain gleich dem Unterbereich ist oder auf `.<sub>` endet |
| `collision_route` | die Domain einer Route |
| `collision_management` | die Adresse von GateControl (`GC_BASE_URL`) |
| `collision_portal` | die Adresse des Portals |
| `collision_domain` | eine andere unter „Domains / Routen“ eingetragene Domain |

Umgekehrt lassen sich unter `<sub>.<domain>` keine Routen und Hosts anlegen
(`routeDomainPolicy`: `device_zone`; in der Host-API Code `DEVICE_ZONE`) –
außer solange das Wildcard-Zertifikat der Zone in Gebrauch ist
(`vpnCert.servedZone()`, Abschnitt „Zertifikat für die Namen“): dann ein Name
eine Ebene unter der Zone (sonst `device_zone_level` / `DEVICE_ZONE_LEVEL`),
kein reservierter Name (`home`, `server`, `gateway` … → `domain_collision`),
kein Gerätename (`device_name`). Solche Routen sind immer nur intern:
`routes.create`/`update`/Massenänderung setzen `external_enabled = 0`
(`routeDomainPolicy.internalOnlyDomain`), die API liefert `vpn_internal`, der
Eintrags-Editor sperrt den Schalter, der Dialog „Neuer Host“ zeigt statt der
Zugriffswahl den Hinweis. TLS: der Wildcard per SNI (`skip_certificates`),
ohne ihn die interne CA; der TLS-Wächter prüft sie nicht öffentlich und
zeigt den Zustand des Wildcards (`kind: 'wildcard'`). Eine Route, deren
Adresse in einer Zone dem Namen eines Geräts gleicht, wird abgelehnt
(`device_name` / `DEVICE_NAME`), und ein Gerät bekommt keinen Namen, den
schon eine Route hat (`deviceNameCollision`).

## Gerätenamen

Regeln: ein Label, Kleinbuchstaben, Ziffern und Bindestriche, höchstens
63 Zeichen. Reserviert sind unter anderem `gateway`, `server`, `gc-server`,
`home` (Portal), `localhost`, `admin`, `dns`, `vpn`, `mail`.

Herkunft (`peers.hostname_source`):

| Wert | Anzeige | Bedeutung |
|---|---|---|
| `admin` | „von dir festgelegt“ | bleibt, bis du ihn änderst; das Gerät überschreibt ihn nicht |
| `agent` | „vom Gerät gemeldet“ | die App oder das Gateway hat den Namen gemeldet |
| `stale` | „vom Gerät gemeldet“ + „veraltet“ | aus einer zurückgespielten Sicherung, seitdem nicht bestätigt |

Vergeben ist ein Name, wenn ein anderes Gerät ihn hat oder wenn unter
`<name>.<zone>` in einer der beiden Zonen schon eine Route oder das Portal
antwortet.

- **Vom Admin vergeben:** Ein vergebener Name wird mit einer Meldung und einem
  freien Vorschlag abgelehnt (`PATCH /api/v1/peers/:id/hostname` → 409,
  `code: taken | route`, `suggestion`). Nie mehr ein stilles `-2`.
- **Vom Gerät gemeldet:** Wie bisher hängt der Server `-2`, `-3` … an.

Wo der Name steht: auf der Gerätekarte und in der Listenzeile unter „Peers /
Clients“ (voller Name mit Kopieren-Knopf, Herkunft; ein Gerät ohne Namen
bietet „Namen vergeben“ an), in den Dialogen „Peer hinzufügen“ und
„Bearbeiten“ (Feld „Name im VPN“ mit fester Endung), bei Gateways auf der
Karte, in der Kopfzeile und unter „Mehr“ → „Name und Gruppe ändern …“.

### Namen von Gateways

Der Name eines Gateways löst wie jeder andere auf, erreichbar ist er aber nur
vom Server: Der Tunnel eines Gateways lässt mit Absicht nur den Server zu
(`services/gateways.js`, `buildEnvContent`: `WG_ADDRESS=<ip>/32`,
`WG_ALLOWED_IPS=10.8.0.1/32`). Von einem anderen VPN-Gerät aus antwortet
`nas.vpn.example.com:5000` deshalb nicht. Das bleibt so; die Oberfläche sagt
es dort, wo der Name eines Gateways steht (Karte, Kopfzeile, Feld im Dialog
„Name und Gruppe ändern …“): „Diesen Namen erreicht nur der Server. Für
Dienste im Heimnetz hinter dem Gateway eine Route anlegen: Domains / Routen“
(`vn.gw_note`, `vn.gw_note_link`; `GCVpnNames.gatewayNote()`, im Dialog
`field({ gateway: true })`). Im Dialog steht über dem Hinweis statt des
allgemeinen „Erreichbar als …“ die Zeile „Name des Gateways im VPN: …“
(`vn.hint_ok_gw`, `vn.hint_ok_gw_both`), damit beides sich nicht widerspricht.
Name und Kopieren-Knopf bleiben. Geräte unter
„Peers / Clients“ zeigen den Hinweis nicht – Gateways stehen dort nicht. Die
Karte „Zustand der Namen“ zählt Gateways nur mit und listet sie nicht einzeln.

Dienste im Heimnetz hinter dem Gateway (NAS-Oberfläche, Drucker, Kameras)
bekommen eine Route unter „Domains / Routen“ mit dem Gateway oder Pool als
Ziel und der LAN-Adresse; ihr Host darf nicht unter der Zone der Gerätenamen
liegen (`DEVICE_ZONE`).

Lizenz: Gerätenamen und die eigene Domain gehören zum Merkmal `internal_dns`.
Ohne das Merkmal ist die Karte sichtbar gesperrt; die festen Namen des Servers
und die Adressen der Routen lösen weiter auf.

## Zertifikat für die Namen (Einstellungen → VPN & Netzwerk)

Ein Wildcard-Zertifikat `*.<zone>` für die primäre Zone, von Let's Encrypt über
ACME DNS-01: Für jeden Abruf schreibt Caddy einen TXT-Eintrag
`_acme-challenge.<zone>` beim DNS-Anbieter des Admins (oder am Ziel einer
Weiterleitung per CNAME) und löscht ihn danach. Kein Name der Zone braucht
einen öffentlichen Eintrag, in den CT-Logs steht nur `*.<zone>`. Für die alte
Zone (`gc.internal`) gibt es kein Zertifikat einer Zertifizierungsstelle.
Handbuch: Kapitel 2.12. Lizenz: Merkmal `internal_dns`.

| Teil | Wo |
|---|---|
| Anbieter-Katalog, Zustände, Test, Speichern, Erneuern | `src/services/vpnCert.js` |
| API `GET/PUT/DELETE /api/v1/settings/vpn-cert`, `POST …/test`, `GET …/test`, `POST …/renew` (nur Admin-Sitzung) | `src/routes/api/settings/vpnCert.js` |
| Policy im Caddy-Abgleich | `applyVpnCertTls` in `src/services/caddyConfig.js` |
| Status, Sperre nach Fehlversuchen, Zertifikatsliste | `src/services/tlsGuard.js` (Zeile `*.<zone>` in `tls_status`) |
| DNS-Module, Test-Unterbefehl `caddy gc-dnstest` | `Dockerfile`, `caddy-plugins/mirror/dnstest.go` |
| Karte | `templates/aurora/pages/settings.njk` (`#card-vpn-cert`), `public/js/settings.js` |

**Anbieter** (erste Fassung): Weiterleitung über deSEC (empfohlen, oben in der
Liste), Hetzner (Cloud-DNS-API), IONOS, netcup, INWX, All-Inkl, OVHcloud,
deSEC, Cloudflare, RFC 2136, acme-dns. Bei IONOS, netcup, INWX und All-Inkl
darf der Zugang mehr als die Zone ändern: Die Karte rät dort zur
Weiterleitung. Vorschlag des Anbieters über die Nameserver der Basis-Domain.

**Zugangsdaten:** `vpn_cert.credentials_encrypted` (AES-256-GCM mit
`GC_ENCRYPTION_KEY`, in `ENCRYPTED_SETTINGS_KEYS` der Sicherung). Für Caddy je
Feld eine Datei unter `<caddy-daten>/secrets/dns/` (Ordner 0700, Datei 0600);
die Caddy-Konfiguration nennt nur `{file.…}`. Die API gibt nie Werte zurück,
nur `fields_set` und `saved_at`; ein leeres Feld behält beim „Ändern“ den
gespeicherten Wert. Fehlertexte (Test, `tls.log`, Caddy) werden gegen die
Werte geschwärzt.

**Caddy:** eine eigene Policy `*.<zone>` an erster Stelle mit DNS-Challenge
(öffentliche Resolver `GC_VPN_CERT_RESOLVERS`, Standard `9.9.9.9`/`1.1.1.1`;
`propagation_delay` aus der Karte, `propagation_timeout` 15 Minuten;
`override_domain` bei Weiterleitung), `tls.certificates.automate`. Namen der
Zone, die Caddy bedient, verlassen die übrigen Policies und stehen in
`automatic_https.skip_certificates` – sie bekommen per SNI das Wildcard-
Zertifikat. Lehnt Caddy die Anbieter-Konfiguration beim Laden ab, lädt der
Server ohne sie und hält das Zertifikat an (`suspended`).

**Zustände** (`state`): `locked`, `no_zone`, `off`, `zone_changed` (die Zone
unter „Namen im VPN“ wurde gewechselt – die Policy fällt weg, die Karte fragt
nach einer neuen Einrichtung), `unreadable`, `suspended`, `paused` (TLS-Wächter:
Fehlversuche oder CAA ohne `issuewild` für Let's Encrypt), `failed`,
`pending`, `active`. „Jetzt erneuern“ nur bei Fehler, Anhalten oder weniger als
30 Tagen Restlaufzeit.

**Testen** (`caddy gc-dnstest` mit demselben Modul): schreibt unter
`_acme-challenge.<zone>` (bei Weiterleitung am CNAME-Ziel, bei acme-dns an
dessen `fulldomain`) einen TXT-Eintrag mit eindeutigem Wert `gc-test-…`, prüft
bei Weiterleitung den CNAME, wartet, bis alle autoritativen Nameserver ihn
ausliefern, und löscht ihn. Schritte `login`, `zone`, `write`, `visible`,
`delete`; Vorschlag der Wartezeit aus der gemessenen Verbreitung. Let's Encrypt
wird nicht gefragt; gespeichert wird nur das Ergebnis ohne Werte.

**Portal und Verwaltung unter der Zone** (`vpnCert.servedZone()`: Policy im
Caddy-Abgleich und ein gültiges Zertifikat im Speicher): Das Portal antwortet
unter `home.<zone>` und weiter unter `home.<alte Zone>`
(`portalConfig.effectivePortalHost()`: `host`, `hosts`, `compatHost`). Ist
eine öffentliche Portal-Domain gesetzt, gilt nur sie. `home.<zone>` bekommen
nur Apps, die die Zone auflösen (`portalConfig.resolvesZone`: Kopfzeilen
`X-Client-Platform: android`, `X-Client-Type` `pro` ab 1.85.0 / `community`
ab 1.49.0 mit `X-Client-Version`) — in `GET /api/v1/client/permissions`
(`portalUrl`) und `POST /api/v1/client/portal-link`; Einladungs-, Kiosk- und
Menü-Links und die Rücksprung-Adresse der Cloud-Konten nutzen `linkHost`:
`compatHost`, oder `home.<zone>`, solange der Schalter „Links auf die neue
Adresse“ an ist (`vpn_cert.links_new`, `PUT /api/v1/settings/vpn-cert/links
{ enabled }`, nur Admin, Standard aus; Protokoll `tls_vpn_cert_links_on|off`;
„Zertifikat ausschalten“ setzt ihn zurück) und das Wildcard in Gebrauch ist.
Die bei Google/Microsoft hinterlegte `redirect_uri`
(`<GC_BASE_URL>/oauth/cloud/callback`) bleibt; nur die Weiterleitung danach
folgt `linkHost`.
Die Verwaltung antwortet zusätzlich unter `server.<zone>` und
`gc-server.<zone>` (`vpnCert.managementHosts()`), nur aus dem VPN
(`remote_ip`, sonst 404), nur über HTTPS; `GC_BASE_URL` bleibt die
Hauptadresse. Das Sitzungs-Cookie hat kein `Domain`-Attribut: eine Anmeldung
gilt je Adresse, das CSRF-Token liegt in der Sitzung; Passkeys (RP-ID aus
`GC_BASE_URL`) und OIDC nur unter der Hauptadresse. Die Namen stehen in
`automatic_https.skip_certificates` und bekommen das Wildcard-Zertifikat;
`home.<zone>` steht in der Hosts-Datei (dnsmasq beantwortet die Zone allein).
`vpnCert.refreshServed()` stellt nach Ausstellung, Erneuerung, Ablauf,
Anhalten, Einrichten, Ausschalten, Zonenwechsel und Restore um (Hosts-Datei,
Caddy-Abgleich, `config_changed` an die Apps).

Die Karte hat die Ansichten `locked`, `nozone`, `off`, `setup`, `pending`,
`active`, `error`; die Felder der Einrichtung gehen über die Speicherleiste,
„Testen“ wirkt sofort.

### Weitergabe an Geräte und Gateways

Zertifikat und privater Schlüssel für ausgewählte Peers, für Dienste, die
direkt auf einem Gerät oder Gateway laufen. Standard aus, nur Admin-Sitzung;
Handbuch 2.12 „Zertifikat an Geräte weitergeben“.

**Nie das Haupt-Wildcard.** `*.<zone>` (Portal, Verwaltung, Routen) verlässt
den Server nicht. Für die Weitergabe holt er ein zweites Wildcard für den
**Geräte-Bereich** `*.<label>.<zone>` – `label` Standard `geraete`
(`vpnCert.DEFAULT_DEVICE_LABEL`), einstellbar in der Karte. Beispiel: Zone
`vpn.example.com` → Geräte-Bereich `geraete.vpn.example.com` → weitergegeben
wird `*.geraete.vpn.example.com`.

| Teil | Wo |
|---|---|
| Geräte-Bereich (Name, Prüfung, Wildcard) | `vpnCert.deviceLabel`, `deviceZone`, `deviceWildcard`, `deviceLabelProblem`, `inDeviceArea` |
| Schalter, Liste, Abruf, neuer Schlüssel | `vpnCert.setShare`, `fetchFor`, `shareSummary`, `rotateKey`, `renewDevice`, `shareRefresh` |
| Einmalige Erneuerung des Haupt-Schlüssels | `vpnCert.migrateSharedMainKey` (aus `tlsGuard.start`) |
| Admin-API `PUT /api/v1/settings/vpn-cert/share` `{ enabled, peers: [peerId…], accept_risk, device_label }`, `POST …/rotate-key` | `src/routes/api/settings/vpnCert.js` |
| Gateway `GET /api/v1/gateway/vpn-cert` (Gateway-Token) | `src/routes/api/gateway.js` |
| App `GET /api/v1/client/vpn-cert` (Token mit Scope `client`, an das Gerät gebunden, Maschinenbindung) | `src/routes/api/client/vpnCert.js` |

**Geräte-Bereich:**
- `label`: ein DNS-Label (`[a-z0-9-]`, höchstens 63 Zeichen; sonst
  `device_label_invalid`), kein fester Name des Servers (`home`, `server`,
  `gc-server`, `gateway` …, `device_label_reserved`), kein Gerätename und kein
  Ort einer Route (`<label>.<zone>` oder darunter, `device_label_taken`).
  Umbenennen nur bei ausgeschalteter Weitergabe (oder im Aufruf, der sie aus-
  oder einschaltet; sonst `409 share_on`). Einstellung `vpn_cert.device_label`
  (leer = Standard).
- **Caddy** fordert `*.<label>.<zone>` nur bei eingeschalteter Weitergabe an:
  gleiche Policy wie das Haupt-Wildcard (`subjects: [*.<zone>, *.<label>.<zone>]`,
  derselbe Anbieter, dieselbe Weiterleitung `override_domain`),
  `certificates.automate` mit beiden. Caddy liefert unter dem Geräte-Bereich
  **keine** Seite aus; Routen dort lehnt `routeDomainPolicy` ab
  (`domain_collision`), ein Gerät kann `label` nicht als Namen bekommen
  (`vpnNames.deviceNameCollision`). TLS-Wächter: eigene Zeile
  `*.<label>.<zone>` in `tls_status` (Liste „Domains & Zertifikate“,
  Fehlversuche, Anhalten – angehalten fordert Caddy es nicht mehr an,
  „Erneut versuchen“ → `renewDevice`).
- **Weiterleitung (CNAME):** Die Challenge des Geräte-Bereichs heißt
  `_acme-challenge.<label>.<zone>` und braucht beim Domain-Anbieter einen
  eigenen CNAME **auf dasselbe Ziel** wie `_acme-challenge.<zone>` (bei
  acme-dns auf dieselbe `fulldomain`). Die Karte zeigt den Eintrag
  (`share.cname { name, target }`).
- **Testen:** Bei eingeschalteter Weitergabe (oder `devices: true` im
  Testaufruf) läuft `caddy gc-dnstest` nach dem ersten Durchlauf ein zweites
  Mal mit `record`/`lookup` des Geräte-Bereichs; Schritt `devices` (`ok`,
  `fail` mit `code`, sonst `skip`), Testergebnis `devices: { zone, record,
  lookup }`. Schlägt nur der zweite fehl, ist `result.code` `devices_<code>`.
- **DNS:** dnsmasq beantwortet zusätzlich `<gerät>.<label>.<zone>` mit der
  Tunnel-Adresse des Geräts (eigene Zeile in der Hosts-Datei, solange die
  Zone eine eigene Domain ist). Frei bleiben im Bereich
  `vpnCert.DEVICE_AREA_RESERVED` (`mqtt`, `www`, `ca`) – kein Gerät bekommt
  diese Namen dort.

**Einstellungen:** `vpn_cert.share_enabled`, `vpn_cert.share_peers` (JSON-Liste
der Peer-IDs), `vpn_cert.share_used` (ein Schlüssel des Geräte-Bereichs wurde
abgeholt), `vpn_cert.share_fingerprint`, `vpn_cert.share_fingerprint_at` (seit
wann der aktuelle Fingerabdruck zum Abholen bereitsteht), `vpn_cert.device_label`,
`vpn_cert.main_key_migrated`, `vpn_cert.main_key_renewed_at`. Einschalten nur
mit `accept_risk: true` (sonst `risk_not_accepted`) und bekannten Peers (sonst
`peers_invalid`); „Zertifikat ausschalten“ beendet die Weitergabe.

**Abruf** (Gateway und App gleich):

```
200 { ok, wildcard, zone, device_zone, server_host, host, cert_pem, key_pem, not_after, fingerprint }
403 { ok: false, error: 'not_allowed' | 'not_from_vpn' }   (App zusätzlich token_required, scope_required, not_registered)
404 { ok: false, error: 'not_shared' | 'no_certificate' }
```

| Feld | Inhalt | Beispiel |
|---|---|---|
| `wildcard` | das weitergegebene Wildcard – **immer das des Geräte-Bereichs** | `*.geraete.vpn.example.com` |
| `zone` | die Zone der VPN-Namen (Haupt-Wildcard, nie weitergegeben) | `vpn.example.com` |
| `device_zone` | der Geräte-Bereich = `wildcard` ohne `*.` | `geraete.vpn.example.com` |
| `server_host` | Name, unter dem der Server den Abruf beantwortet (SNI/`Host`, Haupt-Wildcard) | `server.vpn.example.com` |
| `host` | der eigene Name dieses Peers im Geräte-Bereich (`<hostname>.<device_zone>`), `null` ohne Gerätenamen oder bei einem freigehaltenen Namen | `gw-home.geraete.vpn.example.com` |
| `fingerprint` | SHA-256 des Zertifikats (DER, hex, klein) | |
| `not_after` | Ablauf (ISO 8601) | |

Ein Dienst auf dem Gerät (z. B. die HTTPS-Statusseite eines Gateways) nutzt
`host` als Namen; er liegt unter `wildcard` und löst im VPN auf die
Tunnel-Adresse des Peers auf. Der Abruf geht an die VPN-Adresse des Servers
mit SNI/`Host` = `server_host` – **nicht** `server.` + Bereich aus `wildcard`
(das deckt das Zertifikat des Servers nicht ab).

`Cache-Control: no-store`. Die Quelladresse muss die VPN-Adresse des Peers sein
(`allowed_ips`), sonst `not_from_vpn`. Jeder erfolgreiche Abruf schreibt
`tls_vpn_cert_key_fetched` ins Protokoll (Peer, Weg, Wildcard, Fingerabdruck –
nie den Schlüssel); Schalter und Liste schreiben `tls_vpn_cert_share_on|off|peers`,
ein neuer Name des Bereichs `tls_vpn_cert_device_area`.

**Bekanntgabe:** Erlaubte Gateways bekommen in der Konfiguration
(`GET /api/v1/gateway/config`) `vpn_cert: { wildcard, zone, device_zone,
server_host, host, fingerprint, not_after }` (die Felder wie oben, ohne Schlüssel);
andere nicht. Apps lesen in `GET /api/v1/client/permissions` das Feld
`vpnCert` (dasselbe Objekt oder `null`). Ändert sich der Fingerabdruck
(Erneuerung, neuer Schlüssel), meldet der Server die Änderung an die Gateways
und `config_changed` an die Apps; sie holen dann neu.

**Vorausgesetztes Gateway:** gatecontrol-gateway **1.43.0** (Capability
`vpn-cert-devices`): holt bei `server_host` (ohne das Feld, bei älteren
Servern, wie bisher `server.<zone aus wildcard>`) und prüft, dass `wildcard`
im Zertifikat steht. Gateways 1.41/1.42 (nur `vpn-cert`) würden
`server.<device_zone>` fragen und scheitern – sie gelten als `too_old`.

**Abgeholt je Gateway** (`vpnCert.gatewayCertStates`, `gatewayCertStatus`,
`staleGateways`): Ein Gateway nennt im Heartbeat die Capabilities `vpn-cert`
und (ab 1.43.0) `vpn-cert-devices` und meldet `telemetry.vpn_cert:
{ fingerprint, not_after }` (`null` = nichts gespeichert, gatecontrol-gateway
`docs/vpn-cert.md`); der Server liest es aus `gateway_meta.last_health`. Nur bei
eingeschalteter Weitergabe und nur für Gateways in „Darf abholen“:

| `state` | Bedingung |
|---|---|
| `fetched` | gemeldeter Fingerabdruck = aktueller (oder kein aktuelles Zertifikat zum Vergleich) |
| `stale` | gemeldeter Fingerabdruck ≠ aktueller; `stale_since` = später von `notBefore` des aktuellen Zertifikats und `vpn_cert.share_fingerprint_at` |
| `pending` | Capabilities da, aber nichts (Gültiges) gemeldet – oder noch nie ein Heartbeat |
| `too_old` | Heartbeat mit `gateway_version`, aber ohne `vpn-cert` und `vpn-cert-devices` (`min_version` 1.43.0) |

`vpn_cert.share_fingerprint_at` setzen das Einschalten der Weitergabe und
`shareRefresh` bei neuem Fingerabdruck; „Zertifikat ausschalten“ leert es.
Ausgabe: `GET /api/v1/gateways` je Gateway `vpn_cert: { state, fingerprint,
not_after, current_fingerprint, stale_since, min_version } | null`;
`GET /api/v1/settings/vpn-cert` in `share.peers[].cert` (dasselbe oder `null`).
Anzeige: Gateway-Detail (Karte „Gerät & Software“, `public/js/gateways.js`) und
Kürzel in „Darf abholen“ (`public/js/settings.js`). Dashboard-Problem
`gateway_vpn_cert_stale` (Warnung, Link `/gateways#gw/<id>`) erst nach
`STALE_PROBLEM_MS` = 24 h ab `stale_since` (`services/dashboardProblems.js`).

**Neuer Schlüssel** (`POST …/rotate-key`): nur, wenn ein Schlüssel abgeholt
wurde (`rotate_not_needed`). Löscht das Zertifikat des **Geräte-Bereichs** im
Caddy-Speicher; bei eingeschalteter Weitergabe geht seine Zeile auf `pending`
und Caddy stellt sofort neu aus (die erlaubten Geräte holen den neuen
Schlüssel), sonst beim nächsten Einschalten. Das Haupt-Wildcard bleibt.

**Umstieg (einmalig):** War vor dem Update mit dem Geräte-Bereich der
Haupt-Schlüssel abgeholt worden (`vpn_cert.share_used`), erneuert der Server
beim ersten Start einmal das Haupt-Wildcard wie „Neuen Schlüssel holen“
(`migrateSharedMainKey`): Zertifikat im Speicher weg, Zeile `pending`,
Protokoll `tls_vpn_cert_main_key_renewed`, Hinweis in der Karte 30 Tage
(`share.main_key_renewed_at`). Bis das neue da ist (meist 1–3 Minuten), gehen
Portal und Verwaltung auf ihre bisherigen Adressen.

### Statusseite eines Gateways im VPN (HTTPS)

Ein Gateway ab **gatecontrol-gateway 1.42.0** (Capability `setup-page-vpn`)
kann seine Statusseite zusätzlich aus dem VPN zeigen, nur lesbar, per HTTPS mit
dem weitergegebenen Geräte-Wildcard. Standardmäßig ist das aus. Eingeschaltet
wird es je Gateway: Reiter „Funktionen“ › „System“ › „Statusseite im VPN
(HTTPS)“. Gespeichert ist das in `gateway_features.settings.setupPageVpn.enabled`,
geändert mit `PUT /api/v1/gateways/:id/features { setupPageVpn: { enabled } }`.

**Name:** `vpn_cert.host` (oben) = `<hostname>.<device_zone>`. Er löst im VPN
auf die Tunnel-Adresse des Gateways auf; der Port ist 8643. Ohne weitergegebenes
Zertifikat oder ohne Namen im Bereich (kein Gerätename, freigehaltener Name)
gibt es keine Seite.

**Konfiguration:** eingeschaltet `features.setup_page: { status, vpn_https:
true, vpn_name }`. `vpn_name` ist das erste Label von `vpn_cert.host` und fehlt,
wenn es keinen Namen gibt. Ausgeschaltet fehlen beide Felder, der Hash der
anderen Gateways ändert sich nicht. Das Gateway bildet den Namen selbst aus
`vpn_name` und dem Bereich von `vpn_cert.wildcard` und lauscht nur damit.

**Öffnen** (`POST /api/v1/gateways/:id/setup-page/vpn-open`, nur Admin-Sitzung,
kein API-Token; `services/gatewayStatusVpn.js`):

1. Prüfung: eingeschaltet, Capability da, Zertifikat an dieses Gateway
   weitergegeben, `vpn_cert.host` vorhanden – sonst `409 unavailable`.
2. Zufälliges Einmal-Ticket (32 Byte, base64url); nur sein SHA-256 geht über
   die Management-API ans Gateway: `POST /api/status-page/ticket
   { ticket_sha256, ttl_s: 60 }` (Tunnel, Gateway-Token).
3. Antwort des Gateways `{ ok, host, port, expires_in_s }`. `host` muss
   `vpn_cert.host` sein, sonst `502 gateway_error`. `409`/`404` des Gateways
   ergeben `409 gateway_refused` mit `reason` (`not_enabled`, `no_name`,
   `no_cert`, `port_in_use`, `not_available`). Ohne Antwort kommt
   `502 gateway_unreachable`.
4. Antwort `{ ok, url, host, port, expiresInS }` mit
   `url = https://<host>:<port>/login?t=<ticket>` und `Cache-Control: no-store`.
   Die Oberfläche öffnet die URL in einem neuen Tab. Das Gateway löst das Ticket
   einmal ein und setzt ein eigenes Sitzungs-Cookie (Leerlauf 30 min, höchstens
   8 h).

Das Ticket steht nie im Log. Das Protokoll nennt
`gateway_status_page_vpn_opened` (Gateway, Name, Admin).

`GET /api/v1/gateways/:id/features` liefert dafür `setupPageVpn: { enabled,
supported, shared, host, port, state, canOpen, minGateway }`. `state` kommt
aus dem Heartbeat (`telemetry.setup_page.vpn_https.state`: `off`, `no_name`,
`no_cert`, `port_in_use`, `listening`, `error`) oder ist `null`. Den Knopf „Im
VPN öffnen“ gibt es nur mit `canOpen`. Bei einem älteren Gateway ist der
Schalter ausgegraut, mit dem Hinweis „ab Gateway 1.42.0“.

## Diagnose (Einstellungen → VPN & Netzwerk → „Zustand der Namen“)

`GET /api/v1/settings/vpn-names/status`:

- **Dienst:** Der Server fragt den DNS-Dienst nach `gateway.<primäre Zone>`.
  „läuft“ = die Antwort ist die Gateway-Adresse; „läuft mit altem Stand“ = der
  Dienst antwortet, kennt die Zone aber nicht (er läuft noch mit einer älteren
  Konfiguration); „antwortet nicht“; „ausgeschaltet“ (`GC_DNS_ENABLED=false`).
- **Zuletzt neu geschrieben:** Änderungszeit der Hosts-Datei.
- **Einträge:** Geräte mit Namen, Routen, Portal.
- **Veraltet:** Namen aus einer Sicherung; „Ansehen“ öffnet
  `/peers#hints=oldname`.
- **Feste Namen des Servers:** `gateway`, `server`, `gc-server` in jeder Zone.

## Technik

- `src/services/vpnNames.js` – Zonen, Prüfungen, Speichern, Block in
  `dnsmasq.conf`.
- `src/services/dns.js` – Hosts-Datei. Eine Zeile je Gerät:
  `<ip> <name>.<primär> <name>.<alt> <name>`; Routen und Portal wie zuvor.
- `entrypoint.sh` schreibt `dnsmasq.conf` bei jedem Start des Containers mit
  der alten Zone. Danach ergänzt der Server-Prozess die gewählte Zone in einem
  eigenen Block (`local=/<zone>/` und `host-record=` für die festen Namen) und
  startet dnsmasq neu – nur, wenn die Datei das nicht schon enthält. Ein
  `SIGHUP` reicht dafür nicht: dnsmasq liest `local=` und `host-record=` nur
  beim Start. Neue Gerätenamen brauchen keinen Neustart (Hosts-Datei + `SIGHUP`).
- Der Block trägt eine eigene Markierung
  (`# --- gatecontrol vpn names: begin ---`). Die DNS-Kette
  (`dnsChainConf.js`) verwaltet weiter allein die `server=`-Zeilen und lässt
  den Block stehen; beide schreiben im selben Prozess.
- Nach dem Zurückspielen einer Sicherung wird die Zone der Sicherung angewendet.

## Apps und Gateway

`GET /api/v1/client/config` und `/config/check`:

```json
"internalDns": { "domain": "gc.internal", "server": "10.8.0.1", "domains": ["vpn.example.com", "gc.internal"], "primary": "vpn.example.com" }
```

`domain` bleibt die alte Zone: Windows-Apps, die nur dieses Feld kennen, legen
daraus genau eine Namensregel an. `domains` (alle Zonen, primäre zuerst) und
`primary` sind neu. `config/check` nennt `internalDns` jetzt auch, wenn sich
die Konfiguration nicht geändert hat. Remote Desktop: `peer_fqdn` bleibt in der
alten Zone, `peer_fqdn_primary` nennt denselben Rechner in der primären Zone.
Die Antwort auf `POST /api/v1/client/peer/hostname` nennt zusätzlich `fqdn` und
`fqdns`.

Noch offen (spätere Stufen): Die Windows-Apps brauchen ein Update, das je Zone
eine Regel anlegt; bis dahin lösen sie die neue Schreibweise nicht verlässlich
auf, die alte funktioniert unverändert.

### Gateways: VPN-Namen im Heimnetz auflösen

Ein Gateway mit DNS-Filter beantwortet die DNS-Fragen der Geräte im Heimnetz.
Der Server nennt ihm die Zonen im Config-Pull (`GET /api/v1/gateway/config`):

```json
"features": { "internal_dns": { "server": "10.8.0.1", "domains": ["vpn.example.com", "gc.internal"], "primary": "vpn.example.com", "resolve": false } }
```

| Feld | Inhalt |
|---|---|
| `server`, `domains`, `primary` | wie `internalDns` der Apps |
| `resolve` | Schalter „VPN-Namen im Heimnetz auflösen“ des Heimnetzes, zu dem das Gateway gehört (Standard `false`) |

`internal_dns` ist `null`, wenn der Namensdienst aus ist (`GC_DNS_ENABLED=false`).

**Übertragungsweg:** `features` wird vom Server und vom Gateway außerhalb des
Pakets `@callmetechie/gatecontrol-config-hash` in den Config-Hash eingerechnet
(`sha256(libHash + "\n" + stableJson(features))`, `gateways.computeConfigHash`).
Ein neues Feld dort braucht deshalb keine neue Fassung des Pakets, und ein
älteres Gateway rechnet den Hash über das ganze `features`-Objekt richtig mit,
ohne das Feld zu kennen. Ändert sich die Zone oder der Schalter, ändert sich der
Hash; `vpnNames.save` (allen Gateways) und der Schalter (jedem Gateway des
Heimnetzes) sagen Bescheid (`notifyConfigChanged`), sonst kommt es mit der
nächsten Abfrage an.

**Was das Gateway damit tut** (ab der Fassung mit der Capability `dns-vpn-names`,
Gateway-Doku `docs/dns-cache.md`): Fragen nach einer der Zonen gehen bei
`resolve: true` durch den Tunnel an `server`, bei `false` antwortet das Gateway
selbst mit NXDOMAIN. In keinem Fall gehen sie an den Router oder einen
öffentlichen Resolver. Fällt der Tunnel aus, kommt sofort SERVFAIL.

| Server | Gateway | Verhalten im Heimnetz |
|---|---|---|
| alt | alt | wie bisher: `*.gc.internal` an den Router, `*.vpn.example.com` an den öffentlichen Resolver |
| neu | alt | wie bisher; das Gateway übergeht `internal_dns`. In der Verwaltung steht am Schalter der Hinweis, dass er nach einem Update des Gateways wirkt |
| alt | neu | wie bisher; ohne `internal_dns` kennt das Gateway keine Zonen |
| neu | neu | Zonen bleiben im Haus; Schalter an: Namen lösen im Heimnetz auf |

**Verwaltung:** Gateway → „Funktionen“ → „Für das ganze Heimnetz“ → „VPN-Namen
im Heimnetz auflösen“. Der Schalter gilt für das ganze Heimnetz (Pool oder
gleiches LAN mit gleichem Router, `homeNetwork.gatewayHomes()`); ein Gateway
ohne Pool ist ein Heimnetz mit einem Gateway. Er liegt deshalb bei den
Einstellungen des DNS-Filters, die auf dieselbe Weise geteilt sind
(`gateway_dns.settings.vpnNames`, `services/homeDns.js`): geändert über
`PUT /api/v1/gateways/:id/dns { "vpnNames": true }`, auf jedes Gateway des
Heimnetzes geschrieben, jedes bekommt `config-changed`; `reconcileHomes()`
gleicht Gateways an, die später dazukommen. So antwortet das Reserve-Gateway
nach einer Übernahme wie das aktive. Hinweise statt Verbote: Der Schalter
bleibt bedienbar, wenn der DNS-Filter aus ist, ein Gateway die Funktion noch
nicht kennt oder der Namensdienst aus ist; die Zeile nennt dann den Grund – was
ein einzelnes Gateway betrifft, bei mehreren im Heimnetz mit dessen Namen.
Handbuch: Kapitel 5, „VPN-Namen im Heimnetz“.

**Fehlerhinweis:** Das Gateway meldet im Heartbeat unter
`telemetry.dns.vpnNames` (`zones`, `forward`, `routed`, `lastOkAt`,
`lastError { at, code }`, `failures`, `down`), ob es den DNS des Servers fragen
kann. `gatewayFeatures.vpnNamesProblem` wertet das aus – nur bei
eingeschaltetem Schalter, einem erreichbaren Gateway und `forward: true`:

| Meldung des Gateways | Hinweis |
|---|---|
| `routed: false` | Die Adresse des Servers ist im Tunnel dieses Gateways nicht erlaubt |
| `down: true`, oder die letzten mindestens zwei Fragen scheiterten ohne Antwort seither | Der Namensdienst des Servers antwortet nicht – mit Grund: `timeout` (keine Antwort), `udp`/`tcp`/`closed` (Frage kam nicht durch), sonst der Code des Gateways |

Der Code ist Eingabe des Gateways: nur Text, ohne Steuerzeichen, höchstens
60 Zeichen, in der Oberfläche als Text gesetzt.
