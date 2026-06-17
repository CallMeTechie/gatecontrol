# Route External-Block-Response

_Implementiert: 2026-06-17 · Branch `feature/route-external-block-response` · Migration 52_

## Problem

Eine interne-only Route (`external_enabled = 0`) wird in Caddy per `remote_ip`-Matcher
auf das VPN-Subnetz beschränkt. Traf bisher eine **externe IP** ein, matchte die Route
nicht, Caddy hatte für diesen Host+IP keinen Handler und fiel auf seinen Default zurück —
eine **leere 200-Antwort** („weiße Seite").

Eine leere Seite ist keine echte 404 und ließ dem Betreiber keine Wahl, wie eine
interne-only Route nach außen erscheint. Gewünscht war die **Wahl pro Route**, was ein
externer Besucher oder Bot sieht.

## Lösung

Pro interne-only Route ist konfigurierbar, was bei externem Zugriff ausgeliefert wird:

| Aktion | Verhalten |
|---|---|
| `inherit` | folgt der globalen Standardeinstellung (Default für neue/bestehende Routen) |
| `not_found` | echte HTTP **404** mit leerem Body |
| `custom` | eigenes HTML, ausgeliefert mit Status **404** |
| `redirect` | **302**-Umleitung auf eine frei konfigurierbare Ziel-URL |
| `empty` | altes Verhalten (leere Seite) — bewusst wählbar |

Dazu eine **globale Standardeinstellung** (Default `not_found`), die für alle Routen mit
`inherit` gilt.

### Mechanik (Caddy)

Für eine interne-only Route mit effektiver Aktion ≠ `empty` erzeugt
`src/services/caddyConfig.js` **zwei** äußere Server-Routen für den Host:

```
(A)  match: { host, remote_ip: <VPN-Ranges> }   handle: <echter Inhalt>      @id: gc_route_<id>
(B)  match: { host }                            handle: <static_response>    (KEINE @id)
```

Caddy wertet Routen in Reihenfolge aus: VPN-Clients matchen (A) zuerst, externe IPs fallen
auf (B). (B) liefert je nach Aktion `static_response` 404 / 404+HTML / 302+`Location`.

**Wichtig — (B) trägt keine `@id`:** (A) ist der alleinige Träger von `gc_route_<id>`. Eine
eigene `@id` an (B) würde im `caddyReconciler` als Dauer-Drift erkannt und einen
Re-Sync-Sturm auslösen. (B) ist für die Drift-Erkennung unsichtbar und wird bei jedem
Full-Sync neu gebaut.

### Forward-Auth-Routen: Gate nach außen gehoben

Bei Routen mit Route-Auth liegt der Auth-Proxy (`buildRouteAuthProxy`, matcht
`/route-auth/*` **IP-unabhängig**) als Sibling im Subroute-Block. Für interne-only
Auth-Routen wird das `remote_ip`-Gate daher auf die **äußere** Subroute-Match gehoben (und
am inneren Content-Route entfernt), sodass Auth-Proxy **und** Inhalt gemeinsam hinter dem
Gate liegen. Andernfalls sähe ein externer Scanner unter `/route-auth/*` die Auth-Seite
statt der 404 — diese Lücke wird geschlossen.

### Globale Einstellung & Rebuild

Die drei globalen Keys (`route_external_block_action` / `_body` / `_redirect_url`) liegen in
der `settings`-Tabelle. Der Schreibpfad (`PUT /api/v1/settings/route-block-default`) löst
einen Caddy-Rebuild **nur dann** aus, wenn sich tatsächlich einer dieser drei Keys ändert —
ein unbeteiligter Settings-Save (z. B. SMTP) rebuildet Caddy nicht.

## Bedienung

- **Pro Route:** Im Route-Wizard (Anlegen/Bearbeiten) erscheint bei ausgeschaltetem
  „Von extern erreichbar"-Schalter die Auswahl „Bei externem Zugriff" mit bedingten Feldern
  (Custom-HTML-Textarea, Redirect-URL).
- **Global:** Einstellungsseite → „Standard bei externem Zugriff auf interne Routen".

## Validierung

- **Redirect-URL:** muss wohlgeformte `http(s)`-URL sein; der Ziel-Host darf **nicht** dem
  Routen-Host entsprechen (Loop-Schutz, case-insensitiv).
- **Custom-HTML:** bei Aktion `custom` nicht-leer; Limit **16 KB** (16384 Bytes), da der Body
  in die Caddy-Config eingebettet und bei jedem Sync übertragen wird. Für reiche, bildlastige
  Seiten stattdessen `redirect` auf eine echte gehostete Seite nutzen.
- **Custom-HTML wird verbatim als `text/html` ausgeliefert** (admin-kontrolliert — der
  Betreiber besitzt die XSS-Fläche auf seiner eigenen Domain).
- **Keine Lizenz-Gates:** Sicherheits-Grundeinstellung, in allen Tiers verfügbar.

## Sicherheits-Erwartung: Defense-in-depth, NICHT Unsichtbarkeit

Diese Einstellung steuert **nur die HTTP-Antwort**, nicht die Auffindbarkeit der Route. Eine
interne-only Route bleibt für einen entschlossenen Scanner erkennbar:

- Sie hat einen **öffentlichen DNS-A-Record** auf die Hub-IP — zwingend, sonst käme der
  externe Request gar nicht erst an, um geblockt zu werden.
- Sie hat ein **gültiges Let's-Encrypt-Zert** für genau diesen Hostnamen; der TLS-Handshake
  gelingt vor dem ersten HTTP-Byte, und der Name steht in den **Certificate-Transparency-Logs**.

Eine echte 404 verbessert die Optik gegen naive Bots und liefert eine ehrliche, einheitliche
Antwort — macht die Route aber **nicht kryptografisch unsichtbar**. Wer echte Unsichtbarkeit
braucht, muss den DNS-Record privat halten (Split-Horizon).

## Rollout-Hinweis (vor dem Deploy lesen)

Anders als das Basis-Feature (das Bestand bewusst auf extern backfillte) **kippt dieses
Feature beim Deploy das Verhalten ALLER bestehenden interne-only Routen** von „leere 200" auf
„404" (Migration-Default `inherit` + globaler Default `not_found`). Das ist **beabsichtigt**,
aber:

- **Externe Dritt-Monitore** (UptimeRobot o. ä.) auf einer inzwischen interne-only Route sehen
  ab Deploy **404 → Fehlalarm**. (Internes `monitor.js` ist NICHT betroffen — es probt das
  Backend direkt, nicht die Caddy-Front.)
- Betroffene Routen vor dem Deploy reviewen:
  ```sql
  SELECT id, domain FROM routes
  WHERE route_type='http' AND external_enabled=0 AND external_block_action='inherit'
  ORDER BY domain;
  ```
  Wer für einzelne davon das alte Verhalten will, setzt sie pro Route auf `empty`.

## ACME-Erstausstellung (Phase-0-Gate, vor Deploy zu verifizieren)

Offene empirische Frage vor dem Produktiv-Deploy: Stellt Caddy ein **neues** Zert für eine
interne-only Route aus, deren externer Fallback (B) eine 404 liefert? Hypothese (aus
Phase 0 des Basis-Features + Renewal-Beleg über die Access-Window-403-Seite): ja,
ACME-Challenges laufen out-of-band vor den User-Server-Routen.

**Vorgehen (Staging):** Wegwerf-Route interne-only mit `not_found`-Fallback auf echter
Public-Subdomain anlegen, ACME aktiv, Zert-Ausstellung prüfen:
```bash
docker exec gatecontrol sh -c 'curl -s http://127.0.0.1:2019/config/apps/tls/certificates'
echo | openssl s_client -connect <host>:443 -servername <domain> 2>/dev/null | openssl x509 -noout -dates
```
**Falls das Zert NICHT kommt:** ACME-Challenge-Pfad (`/.well-known/acme-challenge/*`) explizit
vor (B) durchlassen oder auf DNS-01 umstellen — und vor Deploy Rücksprache halten.

_Status: noch nicht auf Staging verifiziert (Task 0, vor Deploy nachzuholen)._

## Bekannte Grenzen / Eigenschaften

- **Nur HTTP.** L4-Routen (SSH/RDP) sind TCP — eine „404-Seite"/„Umleitung" ist sinnlos;
  externe L4-Verbindungen werden weiterhin auf Verbindungsebene verworfen. Die drei Spalten
  existieren auf allen Routen, greifen aber nur im HTTP-Pfad.
- **`empty` bei Auth-Routen:** wer für eine Route mit Route-Auth bewusst `empty` wählt,
  reaktiviert das alte Verhalten — der `/route-auth/*`-Proxy ist dann extern wieder erreichbar
  (Auth-Seite sichtbar). Wer den Auth-Leak schließen will, darf für Auth-Routen NICHT `empty`
  wählen.
- **Transiente Zustände (Bestand):** während Access-Window-Sperre (403), Pool-Outage (503)
  oder Circuit-Breaker (503) liefern interne-only Routen extern die jeweilige Zustandsseite
  (host-only, ohne `remote_ip`-Gate) statt der konfigurierten 404 — die Access-Window-403
  zeigt extern sogar den Zeitplan. Das ist Bestand (nicht von diesem Feature verschlechtert).
  Mögliches Folge-Ticket: diese drei Blöcke ebenfalls hinter das Gate stellen.
- **Peer-ACL-Routen** (`external_enabled=1` + ACL auf bestimmte Peers) sind out of scope —
  unverändert.

## Dateien

| Datei | Änderung |
|---|---|
| `src/db/migrationList.js` | Migration 52: Spalten `external_block_action` / `_body` / `_redirect_url` |
| `src/services/routes.js` | Persistenz in create/update |
| `src/services/caddyConfig.js` | `buildExternalBlockHandler()`, Fallback-Route (B), Gate-Hoisting |
| `src/routes/api/routes.js` | Durchreichen + Validierung (400) |
| `src/routes/api/settings/network.js` · `settings/index.js` | globale Defaults + scoped Rebuild + TOKEN_FORBIDDEN |
| `public/js/routes.js` · `public/js/settings.js` | UI-Logik |
| `templates/{default,pro}/pages/{routes,settings}.njk` · `templates/{default,pro}/partials/modals/route-edit.njk` | Markup (beide Themes) |
| `src/i18n/{de,en}.json` | Übersetzungsschlüssel |
| `tests/route_external_block.test.js` · `tests/api_route_external_block.test.js` | Unit- + API-Tests |
